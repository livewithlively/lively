// delivery ▸ ingest-distillers — 인입 허용선 정책(#638/#783) + 자료 증류기(#1289).
import type { Capability } from "../types.js";
import { canManageWorkspace } from "../principal.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import {
  listIngestPolicies, upsertIngestPolicy, removeIngestPolicy, ingestObservability, upsertDistiller, removeDistiller,
  type DistillerUpsertInput
} from "../../org/store.js"; // #1289 자료 증류기 CRUD
// #1289 자료 증류기 — 스코프(배타 배정)·커버리지·프롬프트 조립. CRUD 는 store, 이건 읽기·판정 계층.
import {
  listDistillers, getDistiller, listDistillerInbox, countDistillerBacklog, distillerCoverage, listSourceChannels, buildDistillerPrompt,
  distillerSectionViews, measureFilterImpact, mergeDraftDistiller,
  describeScope, clearDistillerSeen, countDistillerSeen, prefilterCurve, prefilterThresholds, DEFAULT_DECISIVE_KEYWORDS, tuneDistiller
} from "../../org/distill/distiller.js";
import { actorOf, restRead, restWork } from "./shared.js";
import { ensureLocalFilesDistiller, LOCAL_DISTILLER_KEY } from "../../org/distill/local-preset.js";
// #4194 — 증류기의 두 번째 레인(카테고리 붙이기). 목록만 여기서 함께 준다 — 쓰기는 org_distiller_category_*(delivery/classifiers.ts).
import { assertLaneFields } from "../../org/distill/lanes.js";
import { listClassifiers, getClassifier, classifierCoverage } from "../../org/store/classifiers.js";
import { ensureFigmaCommentsDistiller, FIGMA_DISTILLER_KEY } from "../../org/distill/figma-preset.js";   // #1881 L3

/**
 * 자료 레인 op 에 **카테고리 붙이기 레인을 가리키는** id·key 가 왔나(#4194 적대검증) — 왔으면 이유와 맞는 도구를 대며 막는다.
 *  두 레인은 저장소가 따로라 id·key 공간이 겹친다. knowledge_lanes[] 에서 복사한 id·key 로 이 op 를 부르면
 *   · 그 id 의 자료 레인이 없으면 404 가 맞고(«없음» 만 말하면 에이전트가 이유를 모른다),
 *   · key 가 카테고리 붙이기 레인에만 있으면 upsert 는 **스코프가 빈 새 자료 레인(= catch-all)** 을 만들어 버린다.
 *  그래서 자료 레인에 없는데 카테고리 붙이기 레인에 있으면 그 사실을 말한다. 둘 다에 있으면 자료 레인이 맞다(이 op 는 자료 레인 전용).
 */
async function refuseCategoryLaneRef(input: Record<string, unknown>, sourceExists: boolean, op: string): Promise<void> {
  if (sourceExists) return;
  const ref = input.id !== undefined && input.id !== null && input.id !== "" ? Number(input.id) : String(input.key ?? "").trim();
  if (!ref) return;
  const lane = await getClassifier(ref).catch(() => null);
  if (!lane) return;
  throw new HttpError(op === "upsert" ? 400 : 404,
    `'${String(ref)}' 는 자료 레인이 아니라 카테고리 붙이기 레인입니다 — org_distiller_category_${op} 를 쓰세요(두 레인은 id·key 공간이 따로입니다).`);
}
/** 자료 레인 op 에 카테고리 붙이기 전용 필드가 **REST 본문으로** 왔으면 400(MCP 는 스키마에 없는 키를 이미 떨궜다). */
function refuseForeignFields(input: Record<string, unknown>): void {
  try { assertLaneFields(input, "source"); }
  catch (e) { throw new HttpError(400, (e as Error).message + " — 카테고리 붙이기 레인은 org_distiller_category_upsert 로 다룹니다."); }
}

export const ingestDistillersCapabilities: Capability[] = [
  // ── 인입 허용선 정책 (#638, #783) — 지식이 라이브에 박히기 전 게이트. 오너가 관리탭에서 조절(디폴트 auto=현행 무변). ──
  //  #783: 축에 작성자(ai/human)·하네스·page-type 이 추가되고, 액션이 [신규(action)]·[수정(action_update)] 2축이 됐다.
  // 목록은 **인증만**, 편집은 admin(#1419). 이 화면이 [맥락 관리 ▸ 증류]로 오면서 전 구성원에게 보이는
  //  자리가 됐다 — 조회까지 admin 이면 비-admin 은 403 카드만 보고 "왜 내 지식이 검토 대기에 걸렸나"를
  //  화면에서 알 수 없다(대기열 자체는 이미 WIKI 탭에서 memory 권한으로 본다).
  //  ⚠ 편집은 풀지 않는다: 누구나 '전역 auto 통과' 규칙을 넣을 수 있으면 검토 게이트(#638·#783)가
  //   무력화되고, 파괴 반경이 조직 단위다(팀 단위인 증류기·분류기와 다른 점). canEdit 을 함께 준다.
  restRead("org_ingest_policy_list", "인입 허용선 정책 목록",
    "인입 허용선 정책 규칙 목록 — priority 내림차순. 규칙 0개면 디폴트 auto(현행 무변). " +
    "조회·저장·삭제 모두 구성원(응답의 canEdit 이 그 판정).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-policy"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => ({
      policies: await listIngestPolicies(),
      canEdit: canManageWorkspace(user),
    }), true),
  restWork("org_ingest_policy_upsert", "인입 허용선 정책 저장",
    "인입 정책 규칙 저장(id 있으면 수정 · preset 키가 있으면 그 프리셋 행을 갱신 · 둘 다 없으면 신규). " +
    "match_*(카테고리·시스템·채널·provenance·민감라벨·작성자(ai|human)·하네스·page-type)는 빈값=any. " +
    "action=auto|confirm|drop(신규 저장) · action_update=auto|review|stage|drop(기존 지식 수정). " +
    "여러 규칙 매치 시 축별 가장 보수적(신규 drop>confirm>auto · 수정 drop>stage>review>auto). is_exception=true 면 그 규칙이 확정(carve-out).",
    [{ method: "POST", paths: ["/api/ui/org/ingest-policy"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const nStr = (v: unknown): string | null | undefined => v === undefined ? undefined : (v === null || v === "" ? null : String(v));
      const policy = await upsertIngestPolicy({
        id: input.id === undefined ? undefined : Number(input.id),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        match_category: nStr(input.match_category),
        match_system: nStr(input.match_system),
        match_channel: nStr(input.match_channel),
        match_provenance: nStr(input.match_provenance),
        match_sensitive: nStr(input.match_sensitive),
        match_actor_kind: nStr(input.match_actor_kind),
        match_agent: nStr(input.match_agent),
        match_type: nStr(input.match_type),
        action: input.action === undefined ? undefined : String(input.action),
        action_update: input.action_update === undefined ? undefined : String(input.action_update),
        is_exception: input.is_exception === undefined ? undefined : Boolean(input.is_exception),
        preset: nStr(input.preset),
        priority: input.priority === undefined ? undefined : Number(input.priority),
        note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : String(input.note)),
      }, actorOf(user), "web");
      return { policy };
    }, {
      id: z.number().optional(),
      enabled: z.boolean().optional(),
      match_category: z.string().nullable().optional(),
      match_system: z.string().nullable().optional(),
      match_channel: z.string().nullable().optional(),
      match_provenance: z.string().nullable().optional(),
      match_sensitive: z.string().nullable().optional(),
      match_actor_kind: z.enum(["ai", "human"]).nullable().optional(),
      match_agent: z.string().nullable().optional(),
      match_type: z.string().nullable().optional(),
      action: z.enum(["auto", "confirm", "drop"]).optional(),
      action_update: z.enum(["auto", "review", "stage", "drop"]).optional(),
      is_exception: z.boolean().optional(),
      preset: z.string().nullable().optional(),
      priority: z.number().optional(),
      note: z.string().nullable().optional(),
    }),
  restWork("org_ingest_policy_remove", "인입 허용선 정책 삭제",
    "인입 정책 규칙 1개 삭제(id).",
    [{ method: "POST", paths: ["/api/ui/org/ingest-policy/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = Number(input.id);
      if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "id 필요");
      await removeIngestPolicy(id, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().describe("삭제할 인입 정책 규칙 id(org_ingest_policy_list 로 조회)"),
    }),
  restWork("org_ingest_observability", "인입 게이트 관측",
    "자동 인입 게이트 집계(기간 일수) — mirror auto·pending 생성·승인·반려·현재 대기. 검토 대시(파일럿 1순위 지표: 오너가 어디까지 자동 허용하나).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-observability"], parse: (req) => ({ days: req.query?.days ? Number(req.query.days) : 30 }) }],
    async (input: Record<string, unknown>) => await ingestObservability(Number(input.days) || 30), {
      days: z.number().int().positive().optional().describe("집계 기간(일, 기본 30)"),
    }),

  // ── 자료 증류기(#1289) — "어떤 자료를 · 무슨 기준으로 · 어떤 형식의 지식으로" 를 n개 정의. ──
  //  계기: 고객사 A 실측에서 슬랙 10,900건 중 증류 13건(0.12%). 전역 인박스 하나로는 팀별 채널·기준·형식을 못 가른다.
  //  ⚠ 인입 허용선 정책(org_ingest_policy)과 직교 — 저건 만들어진 지식을 auto/confirm/drop 로 보내는 밸브,
  //   이건 무엇을 집어 어떻게 만드느냐는 생산 라인. 증류기 산출도 그 밸브를 그대로 탄다.
  //  #4194 — 증류기 = «지식을 완성시킨다». 레인 두 종류를 한 입구로 준다. distillers[] 는 **자료 레인만** 그대로 두고
  //   (기존 소비자 — 화면·컨트롤플레인·스킬 — 가 그 배열을 자료 레인으로 읽는다) 카테고리 붙이기 레인은 knowledge_lanes[] 로
  //   따로 싣는다. 한 배열에 섞으면 자료 필드(match_kinds·target_category…)를 가정하는 소비자가 조용히 틀린다.
  restWork("org_distiller_list", "증류기 목록(자료 레인 · 카테고리 붙이기 레인)",
    "증류기는 지식을 완성시킨다(완성 = 본문·유형·카테고리가 다 있는 상태). 레인이 두 종류다 — " +
    "① 자료 레인 distillers[]: 수집된 자료를 읽어 남길 것만 지식으로 쓴다. " +
    "② 카테고리 붙이기 레인 knowledge_lanes[]: 카테고리가 없는 지식(미분류 지식 — 노션 같은 지식 직행 수집·카테고리 삭제·휴지통 복원·제안 반려로 생긴다)을 읽고 카테고리를 제안한다 — 본문은 안 바꾼다. knowledge_lanes 가 null 이면 그 쪽을 못 읽은 것이다(0개와 다르다). " +
    "각 항목의 input 이 종류(source|knowledge). 두 종류는 저장소가 따로라 id·key 공간이 겹친다(예: 둘 다 default) — 자료 레인은 org_distiller_upsert·remove·preview 로, 카테고리 붙이기 레인은 org_distiller_category_upsert·remove·preview 로 다룬다(섞어 부르면 400·404). " +
    "coverage = 자료 레인 커버리지(레인별 잔량 · 어느 레인에도 안 걸리는 자료와 그 채널) + coverage.knowledge(미분류 지식 수 · 켜진 레인 어디에도 안 걸리는 수 · 레인별 잔량). " +
    "배정은 종류마다 priority 내림차순 — 한 자료·지식은 가장 앞선 레인 하나에만 간다. 켜진 자료 레인이 없으면 전 자료 공통 기본 증류, 켜진 카테고리 붙이기 레인이 없으면 미분류 지식 전부를 기본 기준 하나로 본다. " +
    "이미 붙은 카테고리가 틀린 것(재분류)은 증류기가 아니라 점검(관리기 «분류 어긋남 보정»)이 한다.",
    [{ method: "GET", paths: ["/api/ui/org/distillers"], parse: () => ({}) }],
    async () => {
      const [distillers, cov] = await Promise.all([listDistillers(), distillerCoverage()]);
      //  ⚠ 카테고리 붙이기 쪽 실패가 자료 레인 목록까지 500 으로 만들지 않게 가둔다(#4194 적대검증) — 이 GET 은
      //   컨트롤플레인의 memory 스코프 프로브이기도 해서(provisioner), 500 이면 멀쩡한 테넌트에 bootstrap 을 다시 돌린다.
      //   못 읽었으면 null — 빈 배열([])과 구분해야 화면이 «레인 없음» 이라고 거짓말하지 않는다.
      let knowledge_lanes: unknown[] | null = null;
      let knowledge: Record<string, unknown> | null = null;
      try {
        const [lanes, kcov] = await Promise.all([listClassifiers(), classifierCoverage()]);
        knowledge_lanes = lanes.map((c) => ({ ...c, input: "knowledge" }));
        knowledge = { total_unclassified: kcov.total_unclassified, uncovered: kcov.uncovered, lanes: kcov.classifiers };
      } catch { /* null 로 둔다 — 자료 레인 목록은 그대로 준다 */ }
      return {
        distillers: distillers.map((d) => ({ ...d, input: "source", scope_text: describeScope(d) })),
        knowledge_lanes,
        coverage: { ...cov, knowledge },
      };
    }),
  restWork("org_distiller_upsert", "증류기 저장(자료 레인)",
    "증류기의 **자료 레인** 저장 — 수집된 자료를 읽어 지식을 쓰는 레인(id 또는 key 로 멱등 upsert). 카테고리가 없는 지식에 카테고리를 붙이는 레인은 org_distiller_category_upsert 다" +
    "(그 레인의 id·key 를 여기 주면 400 — 두 레인은 id·key 공간이 따로다). " +
    "스코프: match_kinds(slack·email…)·match_system·include/exclude_channels·include/exclude_authors·exclude_bots·min_chars·lookback_days. " +
    "기준: criteria_md(무엇을 지식화하나 — 팀마다 다른 자유서술). " +
    "형식: format_md(결과 문서 모양)·target_category(분류 고정)·default_type(page-type)·name_prefix·thread_aware(스레드를 한 지식으로). " +
    "실행: batch_size·mode(headless|session)·session_ref·harness(AI 제공자)·model·effort·requester. priority 높을수록 자료를 먼저 가져간다.",
    [{ method: "POST", paths: ["/api/ui/org/distillers"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      refuseForeignFields(input);
      const existing = input.id !== undefined && input.id !== null && input.id !== ""
        ? await getDistiller(Number(input.id)) : (input.key ? await getDistiller(String(input.key).trim()) : undefined);
      await refuseCategoryLaneRef(input, !!existing, "upsert");
      const distiller = await upsertDistiller(input as DistillerUpsertInput, actorOf(user), "web");
      // 기준을 바꿔 **이미 보고 버린 자료를 다시 보고 싶을 때** — 판정 이력을 비운다.
      //  증류된 자료는 knowledge_source 가 계속 거르므로 중복 증류는 안 난다(되돌아오는 건 '버린 것'뿐).
      let reset = 0;
      if (input.reset_seen === true) reset = await clearDistillerSeen(Number((distiller as Record<string, unknown>).id));
      return { distiller, ...(input.reset_seen === true ? { reset_seen: reset } : {}) };
    }, {
      id: z.number().optional(),
      key: z.string().optional().describe("증류기 식별자(소문자 슬러그). 같은 key 로 다시 저장하면 갱신."),
      label: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      priority: z.number().optional().describe("높을수록 자료를 먼저 가져간다. 낮은 값 + 넓은 스코프 = catch-all 레인."),
      match_kinds: z.union([z.array(z.string()), z.string()]).nullable().optional().describe("자료 종류(slack·email·drive_file…). 비우면 전체."),
      match_system: z.string().nullable().optional().describe("커넥터 system(slack·gmail·notion…). 비우면 전체."),
      include_channels: z.union([z.array(z.string()), z.string()]).nullable().optional().describe("대상 채널명(줄바꿈/쉼표 구분도 허용). 비우면 채널 무관."),
      exclude_channels: z.union([z.array(z.string()), z.string()]).nullable().optional(),
      include_authors: z.union([z.array(z.string()), z.string()]).nullable().optional(),
      exclude_authors: z.union([z.array(z.string()), z.string()]).nullable().optional(),
      exclude_bots: z.boolean().optional().describe("봇 메시지 제외(기본 true)."),
      min_chars: z.number().optional().describe("본문 최소 길이 — 한 줄 잡담 컷."),
      lookback_days: z.number().nullable().optional().describe("최근 N일만. 비우면 전체(백필)."),
      criteria_md: z.string().nullable().optional(),
      format_md: z.string().nullable().optional(),
      target_category: z.string().nullable().optional(),
      default_type: z.string().nullable().optional(),
      name_prefix: z.string().nullable().optional(),
      thread_aware: z.boolean().optional().describe("스레드(부모·답글)를 묶어 하나의 지식으로(기본 true)."),
      prefilter_level: z.number().optional().describe("사전 필터 레버(0~100). LLM 에 먹이기 전 서버가 스레드를 거른다 — 올릴수록 빡빡. 0=끔(전부 통과) · 50=기본(결정성1·참여자2·메시지3|400자) · 100=매우 엄격. 토큰이 자료수에 O(n²) 이라 여기서 거르면 비용이 급감한다."),
      prefilter_rules: z.record(z.any()).nullable().optional().describe("레버가 정한 임계값의 축별 덮어쓰기(부분 지정 가능): {min_decisive,min_authors,min_msgs,min_chars,keywords[],match:'all'|'any'}. 지정 안 한 축은 레버 파생값 유지."),

      prompt_sections: z.record(z.string()).nullable().optional().describe("프롬프트 조각 덮어쓰기 — {intro,criteria,format,thread,procedure} 중 지정한 것만 대체한다. 미지정=코드 기본값(제품 개선이 계속 흘러든다) · 빈 문자열=그 조각을 뺀다. 대상 지정·안전 문구는 불변이라 여기로 덮을 수 없다."),
      batch_size: z.number().optional().describe("한 배치 **스레드 수**(1~200, 기본 3). 자료 건수가 아니다 — 배치는 스레드 단위로 자른다(스레드를 쪼개면 대화가 끊겨 증류가 안 된다)."),
      batch_max_msgs: z.number().optional().describe("한 배치 메시지 상한(1~2000, 기본 20). 스레드를 최근순으로 누적하다 이 값을 넘으면 멈춘다. ⚠ 첫 스레드는 예외 — 상한을 넘어도 통째로 담는다(171메시지 스레드는 그것 하나만 처리)."),
      mode: z.enum(["headless", "session"]).optional(),
      session_ref: z.string().nullable().optional(),
      harness: z.string().nullable().optional().describe("실행할 AI CLI(claude·codex·antigravity·grok). 비우면 자동 — 의뢰자가 로그인한 하네스 중에서 고른다(claude 우선). model 은 **이 하네스의 모델 이름**이어야 한다(다르면 그 하네스의 자동화 기본값으로 대체)."),
      model: z.string().nullable().optional().describe("모델. 비우면 그 하네스의 자동화 기본값(claude=opus · codex=gpt-5.6-sol · antigravity=gemini-3.8-flash-high · grok=grok-4.6). ⚠ 비움이 «CLI 계정 기본» 을 뜻하지 않는다 — 무인 배치가 가장 비싼 모델로 도는 것을 막기 위해 라이블리가 기본을 정한다(#4008)."),
      effort: z.string().nullable().optional().describe("추론강도. 비우면 그 하네스의 자동화 기본값(claude=low · codex=medium · antigravity=high · grok=medium)."),
      requester: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      reset_seen: z.boolean().optional().describe("판정 이력 초기화 — 이 증류기가 '보고 버린' 자료를 다시 인박스에 올린다(기준을 바꿔 재검토할 때). 이미 증류된 자료는 그대로 제외되므로 중복 증류는 없다."),
    }),
  restWork("org_distiller_remove", "증류기 삭제(자료 레인)",
    "자료 레인 1개 삭제(id 또는 key). 이미 증류된 지식은 그대로 남는다(증류기는 생산 설비지 지식의 소유자가 아니다). " +
    "카테고리 붙이기 레인은 org_distiller_category_remove 로 지운다 — 그 id·key 를 여기 주면 404(두 레인은 id·key 공간이 따로다).",
    [{ method: "POST", paths: ["/api/ui/org/distillers/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      {
        const exists = input.id !== undefined && input.id !== null && input.id !== ""
          ? await getDistiller(Number(input.id)) : (input.key ? await getDistiller(String(input.key).trim()) : undefined);
        await refuseCategoryLaneRef(input, !!exists, "remove");
      }
      const ref = input.id !== undefined && input.id !== null ? Number(input.id) : String(input.key ?? "").trim();
      if (!ref) throw new HttpError(400, "id 또는 key 필요");
      await removeDistiller(ref, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().optional(),
      key: z.string().optional(),
    }),
  restWork("org_distiller_preview", "증류기 미리보기(자료 레인)",
    "(자료 레인 전용 — 카테고리 붙이기 레인은 org_distiller_category_preview.) " +
    "이 증류기가 **지금 무엇을 집는지**를 저장·실행 전에 확인한다 — 배타 배정된 인박스 표본 + 남은 잔량 + 실제로 나갈 프롬프트 " +
    "+ 사전필터 효과(통과율과 **유실률**). 스코프 오타(채널명 하나 틀림)로 0건을 집는 사고를 켜기 전에 잡는 자리.\n" +
    "⚠ draft 를 주면 **저장하지 않고** 그 값으로 미리 본다 — 화면이 입력을 바꾸는 즉시 결과를 보여주기 위한 경로다. " +
    "key 없이 draft 만 주면 아직 저장 안 한 새 증류기도 미리 볼 수 있다(배타 배정은 저장된 증류기들 기준).",
    [{ method: "GET", paths: ["/api/ui/org/distillers/preview"], parse: (req) => ({ key: req.query?.key, limit: req.query?.limit ? Number(req.query.limit) : 10 }) },
     // ⚠ POST 지만 **읽기 전용**이다(draft 본문이 커서 GET 쿼리로는 못 보낸다 — criteria_md 가 수천 자다).
     //  capMutates 는 POST 를 쓰기로 파생하므로 여기서 mutates:false 를 명시한다. 안 그러면 읽기전용 세션이
     //  미리보기를 못 해, 설정을 못 바꾸는 사람이 확인조차 못 하게 된다.
     { method: "POST", paths: ["/api/ui/org/distillers/preview"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const ref = String(input.key ?? "").trim();
      const draft = (input.draft && typeof input.draft === "object" ? input.draft : null) as Record<string, unknown> | null;
      if (!ref && !draft) throw new HttpError(400, "key 또는 draft 필요");
      const saved = ref ? await getDistiller(ref) : undefined;
      if (ref && !saved) { await refuseCategoryLaneRef({ key: ref }, false, "preview"); throw new HttpError(404, `증류기 '${ref}' 없음`); }
      const d = mergeDraftDistiller(saved, draft);
      const all = await listDistillers();

      const limit = Math.min(Math.max(1, Number(input.limit) || 10), 50);
      const sample = await listDistillerInbox(d, all, limit);
      return {
        distiller: { ...d, scope_text: describeScope(d) },
        backlog: await countDistillerBacklog(d, all),
        // 사전필터 효과 — 통과율(비용)과 **유실률**(놓칠 지식). 유실률을 안 보여주면 아무도 모른 채 버린다.
        filter_impact: await measureFilterImpact(d).catch(() => null),
        reviewed: await countDistillerSeen(d.id),   // 이미 보고 버린 자료 수(재검토하려면 reset_seen)
        // 레버 튜닝 재료 — 지금 임계값 + 레버를 옮겼을 때의 통과 건수 곡선(감으로 찍지 않게).
        prefilter: {
          level: d.prefilter_level ?? 0,
          thresholds: prefilterThresholds(d.prefilter_level ?? 0, d.prefilter_rules as Record<string, unknown> | null),
          default_keywords: DEFAULT_DECISIVE_KEYWORDS,
          curve: await prefilterCurve(d, all),
        },
        sample: sample.map((s) => ({
          id: s.id, kind: s.kind, title: s.title, occurred_at: s.occurred_at,
          channel: (s.fields as Record<string, unknown> | null)?.container_name ?? null,
          author: (s.fields as Record<string, unknown> | null)?.author_name ?? null,
        })),
        // 실제로 나갈 프롬프트(허용선 문구는 실행 시점 정책으로 다시 조립되니 여기선 자리표시).
        prompt: buildDistillerPrompt({ distiller: d, rows: sample, policySummary: "(실행 시점의 인입 허용선 정책이 여기 들어갑니다)" }),
        // 조각별 기본값·현재 덮어쓴 값(#1419-B) — 관리탭이 "무엇을 덮어쓰는지"를 보여줄 재료.
        //  조립은 buildDistillerPrompt 한 곳에서만 한다(B7: 미리보기와 실제 배치가 갈리면 미리보기가 거짓이 된다).
        sections: distillerSectionViews(d, { count: sample.length, policySummary: "(실행 시점의 인입 허용선 정책이 여기 들어갑니다)" }),
      };
    }, {
      key: z.string().optional().describe("증류기 key. draft 만 줄 땐 생략 가능(새 증류기 미리보기)"),
      draft: z.record(z.any()).optional().describe("저장 전 값 — 저장된 행 위에 얹어 미리 본다(DB 미변경). 입력 변경 즉시 결과를 보여주는 경로."),
      limit: z.number().int().positive().optional().describe("표본 개수(기본 10, 최대 50)"),
    }, /* mutates */ false),
  restWork("org_distiller_tune", "자료 증류기 튜닝 재료",
    "사전 필터의 최적값을 **감이 아니라 실측으로** 정하기 위한 재료를 준다. AI 가 이걸 읽고 rules 를 정해 " +
    "org_distiller_upsert 로 설정하는 게 표준 플로우다(사람이 임계값을 감으로 찍지 않는다).\n" +
    "① baseline — 이 증류기 채널의 스레드·자료·'지식이 된 스레드' 수.\n" +
    "② keyword_candidates — 지식이 된 스레드에 많고 나머지엔 드문 단어를 lift 순으로(최대 60). " +
    "⚠ 실측상 판별력은 일반어('결정·장애')가 아니라 **도메인 용어**('할인일시납·플랫폼이용료·가상계좌')에 있다. " +
    "사람 이름·영어 조각 같은 노이즈가 섞이니 **네가 골라서** rules.keywords 에 넣어라(많이 넣을수록 좋다).\n" +
    "③ grid — 후보 조합별 (통과 자료 = 토큰 비용) vs (지식 보존 = 유실률). candidates 로 직접 후보를 넣어 좁혀갈 수 있다.\n" +
    "판정 기준: **유실률(loss_pct)이 곧 놓치는 지식의 비율**이다. 절감만 보고 고르지 마라 — 4축 AND 는 78% 절감이지만 " +
    "지식의 21%를 버렸다(실측). 허용 유실선(예: 5%)을 먼저 정하고 그 안에서 pass_pct 가 가장 낮은 조합을 골라라.",
    [{ method: "POST", paths: ["/api/ui/org/distillers/tune"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>) => {
      const ref = String(input.key ?? "").trim();
      if (!ref) throw new HttpError(400, "key 필요");
      const d = await getDistiller(ref);
      if (!d) { await refuseCategoryLaneRef({ key: ref }, false, "preview"); throw new HttpError(404, `증류기 '${ref}' 없음`); }
      const cands = Array.isArray(input.candidates)
        ? (input.candidates as Array<{ label?: string; rules?: Record<string, unknown> }>)
            .filter((c) => c && typeof c === "object" && c.rules)
            .map((c, i) => ({ label: String(c.label ?? `후보${i + 1}`), rules: c.rules as Record<string, unknown> }))
        : undefined;
      return await tuneDistiller(d, cands);
    }, {
      key: z.string().describe("증류기 key"),
      candidates: z.array(z.object({
        label: z.string().optional(),
        rules: z.record(z.any()).describe("{min_msgs,min_authors,min_chars,min_decisive,keywords[],match:'all'|'any'}"),
      })).optional().describe("직접 시뮬레이션할 후보 조합들(생략하면 대표 조합). 키워드를 바꿔가며 좁힐 때 쓴다."),
    }),
  // #1881 L3 — 내 컴퓨터(로컬 업로드) 자료 증류기. 첫 업로드가 꺼진 채로 만들어 두고, 온보딩 W6 "이렇게 나눴는데 맞나요?"
  //  승인이 enable=true 로 켠다(+ 전용 헤드리스 크론 잡). 셀프서브 사용자에게 '증류기'라는 단어가 화면에 나오지 않게 하는 자리.
  restWork("org_distiller_local_ensure", "내 컴퓨터 자료 증류기 준비",
    "내 컴퓨터에서 올린 파일(자료 kind=local_file)을 지식으로 만드는 catch-all 증류기 'local-files' 를 준비한다 — 없으면 프리셋으로 만든다(기본은 **꺼진 채**). " +
    "enable=true 면 켜고(의뢰자=requester, 없으면 호출자) 전용 헤드리스 잡(distill-local-files, 10분)까지 등록한다 — 온보딩의 표본 승인 단계가 이걸 부른다. " +
    "이미 켜져 있으면 no-op. 기준·형식은 org_distiller_upsert 로 언제든 손볼 수 있다(여긴 건드리지 않는다).",
    [{ method: "POST", paths: ["/api/ui/org/distillers/local"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const r = await ensureLocalFilesDistiller({
        actor: actorOf(user), enable: !!input.enable,
        requester: typeof input.requester === "string" && input.requester.trim() ? input.requester.trim() : null, source: "web",
      });
      return { key: LOCAL_DISTILLER_KEY, created: r.created, enabled: r.enabled, job: r.job, distiller: { ...r.distiller, scope_text: describeScope(r.distiller as unknown as Parameters<typeof describeScope>[0]) } };
    }, {
      enable: z.boolean().optional().describe("true=켜고 잡 등록(승인). 미지정=없을 때만 꺼진 채로 만든다."),
      requester: z.string().optional().describe("헤드리스 실행 신원(멤버 id/이메일) — 켤 때만. 없으면 호출자."),
    }),
  // #1881 F8 — 피그마 코멘트 증류기. 로컬(L3)과 같은 규약: 첫 수집기를 만들 때 꺼진 채로 준비하고, 사람이 표본을 보고 켠다.
  //  왜 별도 증류기인가: 디자인 코멘트는 **맥락이 본문에 없고**(캔버스의 한 점에 붙어 "여기·이거"로 말한다),
  //  **짧고**, **결정 단어를 거의 안 쓴다**. 대신 슬랙엔 없는 `resolved` 신호가 있다 — 기준이 다를 수밖에 없다.
  restWork("org_distiller_figma_ensure", "피그마 코멘트 증류기 준비",
    "피그마 디자인 파일의 코멘트(자료 kind=figma_comment)를 지식으로 만드는 증류기 'figma-comments' 를 준비한다 — 없으면 프리셋으로 만든다(기본은 **꺼진 채**). " +
    "enable=true 면 켜고(의뢰자=requester, 없으면 호출자) 전용 헤드리스 잡(distill-figma-comments, 15분)까지 등록한다. " +
    "이미 켜져 있으면 no-op. 기준·형식은 org_distiller_upsert 로 언제든 손볼 수 있다(여긴 건드리지 않는다). " +
    "⚠ 사전필터는 꺼진 채로 출하한다 — 디자인 코멘트는 짧고 둘이서 오가며 결정 단어를 안 써서 길이·참여자·키워드 축이 전부 불리하다. 자료가 쌓인 뒤 org_distiller_tune 의 유실률로 정하라.",
    [{ method: "POST", paths: ["/api/ui/org/distillers/figma"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const r = await ensureFigmaCommentsDistiller({
        actor: actorOf(user), enable: !!input.enable,
        requester: typeof input.requester === "string" && input.requester.trim() ? input.requester.trim() : null, source: "web",
      });
      return { key: FIGMA_DISTILLER_KEY, created: r.created, enabled: r.enabled, job: r.job, distiller: { ...r.distiller, scope_text: describeScope(r.distiller as unknown as Parameters<typeof describeScope>[0]) } };
    }, {
      enable: z.boolean().optional().describe("true=켜고 잡 등록(승인). 미지정=없을 때만 꺼진 채로 만든다."),
      requester: z.string().optional().describe("헤드리스 실행 신원(멤버 id/이메일) — 켤 때만. 없으면 호출자."),
    }),
  restWork("org_source_channels", "자료 채널 목록",
    "수집된 자료에 실제로 존재하는 채널(fields.container_name)별 총건수·미증류 건수 — 증류기 스코프를 실재하는 채널로만 짜게 하는 재료. " +
    "'어느 채널이 얼마나 밀렸나'를 보고 증류기를 어디에 세울지 정하는 자리이기도 하다.",
    [{ method: "GET", paths: ["/api/ui/org/source-channels"], parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : 200 }) }],
    async (input: Record<string, unknown>) => ({ channels: await listSourceChannels(Number(input.limit) || 200) }), {
      limit: z.number().int().positive().optional().describe("최대 채널 수(기본 200)"),
    }),
];

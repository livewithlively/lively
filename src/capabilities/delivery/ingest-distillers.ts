// delivery ▸ ingest-distillers — 인입 허용선 정책(#638/#783) + 자료 증류기(#1289).
import type { Capability } from "../types.js";
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
  describeScope, clearDistillerSeen, countDistillerSeen, prefilterCurve, prefilterThresholds, DEFAULT_DECISIVE_KEYWORDS, tuneDistiller
} from "../../org/distill/distiller.js";
import { actorOf, restOnly, restRead, restWork } from "./shared.js";

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
    "조회는 전 구성원, 저장·삭제는 admin(응답의 canEdit 이 그 판정).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-policy"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => ({
      policies: await listIngestPolicies(),
      canEdit: !!(user?.scopes && user.scopes.includes("admin")),
    }), true),
  restOnly("org_ingest_policy_upsert", "인입 허용선 정책 저장",
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
  restOnly("org_ingest_policy_remove", "인입 허용선 정책 삭제",
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
  restOnly("org_ingest_observability", "인입 게이트 관측",
    "자동 인입 게이트 집계(기간 일수) — mirror auto·pending 생성·승인·반려·현재 대기. 검토 대시(파일럿 1순위 지표: 오너가 어디까지 자동 허용하나).",
    [{ method: "GET", paths: ["/api/ui/org/ingest-observability"], parse: (req) => ({ days: req.query?.days ? Number(req.query.days) : 30 }) }],
    async (input: Record<string, unknown>) => await ingestObservability(Number(input.days) || 30), {
      days: z.number().int().positive().optional().describe("집계 기간(일, 기본 30)"),
    }),

  // ── 자료 증류기(#1289) — "어떤 자료를 · 무슨 기준으로 · 어떤 형식의 지식으로" 를 n개 정의. ──
  //  계기: 고객사 A 실측에서 슬랙 10,900건 중 증류 13건(0.12%). 전역 인박스 하나로는 팀별 채널·기준·형식을 못 가른다.
  //  ⚠ 인입 허용선 정책(org_ingest_policy)과 직교 — 저건 만들어진 지식을 auto/confirm/drop 로 보내는 밸브,
  //   이건 무엇을 집어 어떻게 만드느냐는 생산 라인. 증류기 산출도 그 밸브를 그대로 탄다.
  restWork("org_distiller_list", "자료 증류기 목록",
    "등록된 자료 증류기 목록 + 커버리지(증류기별 잔량 · 어느 증류기에도 안 걸리는 사각지대 자료와 그 채널). " +
    "배정 순서는 priority 내림차순 — 한 자료는 가장 앞선 증류기 하나에만 배정된다(중복 증류 방지). 증류기 0개면 구 전역 동작.",
    [{ method: "GET", paths: ["/api/ui/org/distillers"], parse: () => ({}) }],
    async () => {
      const distillers = await listDistillers();
      return {
        distillers: distillers.map((d) => ({ ...d, scope_text: describeScope(d) })),
        coverage: await distillerCoverage(),
      };
    }),
  restWork("org_distiller_upsert", "자료 증류기 저장",
    "자료 증류기 저장(id 또는 key 로 멱등 upsert). " +
    "스코프: match_kinds(slack·email…)·match_system·include/exclude_channels·include/exclude_authors·exclude_bots·min_chars·lookback_days. " +
    "기준: criteria_md(무엇을 지식화하나 — 팀마다 다른 자유서술). " +
    "형식: format_md(결과 문서 모양)·target_category(분류 고정)·default_type(page-type)·name_prefix·thread_aware(스레드를 한 지식으로). " +
    "실행: batch_size·mode(headless|session)·session_ref·model·effort·requester. priority 높을수록 자료를 먼저 가져간다.",
    [{ method: "POST", paths: ["/api/ui/org/distillers"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
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
      batch_size: z.number().optional().describe("한 배치 **스레드 수**(1~200, 기본 3). 자료 건수가 아니다 — 배치는 스레드 단위로 자른다(스레드를 쪼개면 대화가 끊겨 증류가 안 된다)."),
      batch_max_msgs: z.number().optional().describe("한 배치 메시지 상한(1~2000, 기본 20). 스레드를 최근순으로 누적하다 이 값을 넘으면 멈춘다. ⚠ 첫 스레드는 예외 — 상한을 넘어도 통째로 담는다(171메시지 스레드는 그것 하나만 처리)."),
      mode: z.enum(["headless", "session"]).optional(),
      session_ref: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      effort: z.string().nullable().optional(),
      requester: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
      reset_seen: z.boolean().optional().describe("판정 이력 초기화 — 이 증류기가 '보고 버린' 자료를 다시 인박스에 올린다(기준을 바꿔 재검토할 때). 이미 증류된 자료는 그대로 제외되므로 중복 증류는 없다."),
    }),
  restWork("org_distiller_remove", "자료 증류기 삭제",
    "자료 증류기 1개 삭제(id 또는 key). 이미 증류된 지식은 그대로 남는다(증류기는 생산 설비지 지식의 소유자가 아니다).",
    [{ method: "POST", paths: ["/api/ui/org/distillers/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const ref = input.id !== undefined && input.id !== null ? Number(input.id) : String(input.key ?? "").trim();
      if (!ref) throw new HttpError(400, "id 또는 key 필요");
      await removeDistiller(ref, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().optional(),
      key: z.string().optional(),
    }),
  restWork("org_distiller_preview", "자료 증류기 미리보기",
    "이 증류기가 **지금 무엇을 집는지**를 저장·실행 전에 확인한다 — 배타 배정된 인박스 표본 + 남은 잔량 + 실제로 나갈 프롬프트. " +
    "스코프 오타(채널명 하나 틀림)로 0건을 집는 사고를 켜기 전에 잡는 자리.",
    [{ method: "GET", paths: ["/api/ui/org/distillers/preview"], parse: (req) => ({ key: req.query?.key, limit: req.query?.limit ? Number(req.query.limit) : 10 }) }],
    async (input: Record<string, unknown>) => {
      const ref = String(input.key ?? "").trim();
      if (!ref) throw new HttpError(400, "key 필요");
      const d = await getDistiller(ref);
      if (!d) throw new HttpError(404, `증류기 '${ref}' 없음`);
      const all = await listDistillers();
      const limit = Math.min(Math.max(1, Number(input.limit) || 10), 50);
      const sample = await listDistillerInbox(d, all, limit);
      return {
        distiller: { ...d, scope_text: describeScope(d) },
        backlog: await countDistillerBacklog(d, all),
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
      };
    }, {
      key: z.string().describe("증류기 key"),
      limit: z.number().int().positive().optional().describe("표본 개수(기본 10, 최대 50)"),
    }),
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
      if (!d) throw new HttpError(404, `증류기 '${ref}' 없음`);
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
  restWork("org_source_channels", "자료 채널 목록",
    "수집된 자료에 실제로 존재하는 채널(fields.container_name)별 총건수·미증류 건수 — 증류기 스코프를 실재하는 채널로만 짜게 하는 재료. " +
    "'어느 채널이 얼마나 밀렸나'를 보고 증류기를 어디에 세울지 정하는 자리이기도 하다.",
    [{ method: "GET", paths: ["/api/ui/org/source-channels"], parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : 200 }) }],
    async (input: Record<string, unknown>) => ({ channels: await listSourceChannels(Number(input.limit) || 200) }), {
      limit: z.number().int().positive().optional().describe("최대 채널 수(기본 200)"),
    }),
];

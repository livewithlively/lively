// delivery ▸ classifiers — 분류기 CRUD·커버리지·미리보기(#1419 T4). 증류기(delivery/ingest-distillers)의 분류판.
//
//  ⚠ #4194 — 사람·에이전트에겐 «분류기» 가 없다. 이 레인은 증류기의 **«카테고리 붙이기» 레인**이다(증류 = 지식을 완성시킨다).
//   그래서 op 이름을 org_distiller_category_* 로 바꿨다. **REST 경로(/api/ui/org/classifiers*)는 그대로 둔다**:
//    · 컨트롤플레인(lvly-cloud control/src/provisioner.ts)이 새 테넌트마다 POST /api/ui/org/classifiers 로 "default" 를 심는다.
//      코어·컨트롤플레인 배포는 독립이라 이 경로가 사라지면 그 사이 새 워크스페이스 프로비저닝이 깨진다.
//    · 배포 중엔 새 화면이 옛 게이트웨이 프로세스와, 롤백 뒤엔 옛 화면이 새 코어와 잠시 공존한다. 같은 경로·같은 의미라야
//      어느 쪽 조합에서도 옳게 돈다.
//   ⚠ 자료 레인 op(org_distiller_upsert·remove)에 `input:'knowledge'` 같은 갈래 파라미터를 얹지 **않은** 이유(#4194 적대검증):
//    옛 코어는 모르는 필드를 무시하고(MCP SDK 는 선언 안 된 키를 떨군다) 그 요청을 **자료 레인에** 적용한다 — 같은 id·key 의
//    자료 증류기를 끄거나 지우거나, 스코프가 빈(=catch-all) 자료 레인을 새로 만든다. 이름이 다르면 옛 코어는 «없는 도구·404» 로
//    멈춘다. 다른 동작은 다른 이름으로.
//   정규화(knowledgeLaneInput)·입력 스키마(knowledgeLaneShape)는 한 벌이다.
//
//  scope: restWork(memory) — 증류기와 같은 판단이다. 조직 '정책'이 아니라 팀이 일상적으로 굴리는 설정이라
//   admin 을 요구하면 실무자가 자기 도메인 분류 기준 하나 못 고치고 관리자를 기다린다. 파괴 반경도 좁다 —
//   분류기가 만드는 건 **제안**이고 사람 확정([분류 검토 대기])을 거친다.
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import {
  listClassifiers, getClassifier, classifierInbox, classifierCoverage,
  upsertClassifier, removeClassifier, type ClassifierUpsertInput,
} from "../../org/store/classifiers.js";
import { actorOf, restWork, str } from "./shared.js";
import { assertLaneFields } from "../../org/distill/lanes.js";

/**
 * 카테고리 붙이기 레인(=옛 분류기) 저장 입력 정규화(#4194) — org_distiller_category_upsert 가 쓴다.
 */
export function knowledgeLaneInput(input: Record<string, unknown>): ClassifierUpsertInput {
  return {
    id: input.id === undefined || input.id === null ? undefined : Number(input.id),
    key: input.key === undefined ? undefined : str(input.key, "key", 64),
    label: input.label === undefined ? undefined : (input.label === null || input.label === "" ? null : str(input.label, "label", 200)),
    enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
    priority: input.priority === undefined ? undefined : Number(input.priority),
    target: input.target === undefined ? undefined : str(input.target, "target", 20),
    confidence_below: input.confidence_below === undefined ? undefined : (input.confidence_below === null ? null : Number(input.confidence_below)),
    match_types: input.match_types as never,
    match_provenance: input.match_provenance === undefined ? undefined : (input.match_provenance === null || input.match_provenance === "" ? null : str(input.match_provenance, "match_provenance", 20)),
    match_systems: input.match_systems as never, exclude_names: input.exclude_names as never,
    min_chars: input.min_chars === undefined ? undefined : Number(input.min_chars),
    lookback_days: input.lookback_days === undefined ? undefined : (input.lookback_days === null || input.lookback_days === "" ? null : Number(input.lookback_days)),
    criteria_md: input.criteria_md === undefined ? undefined : (input.criteria_md === null || input.criteria_md === "" ? null : String(input.criteria_md).slice(0, 20_000)),
    candidate_categories: input.candidate_categories as never,
    confirm_threshold: input.confirm_threshold === undefined ? undefined : Number(input.confirm_threshold),
    batch_size: input.batch_size === undefined ? undefined : Number(input.batch_size),
    mode: input.mode === undefined ? undefined : str(input.mode, "mode", 20),
    session_ref: input.session_ref === undefined ? undefined : (input.session_ref === null || input.session_ref === "" ? null : str(input.session_ref, "session_ref", 200)),
    harness: input.harness === undefined ? undefined : (input.harness === null || input.harness === "" ? null : str(input.harness, "harness", 40)),
    model: input.model === undefined ? undefined : (input.model === null || input.model === "" ? null : str(input.model, "model", 40)),
    effort: input.effort === undefined ? undefined : (input.effort === null || input.effort === "" ? null : str(input.effort, "effort", 20)),
    requester: input.requester === undefined ? undefined : (input.requester === null || input.requester === "" ? null : str(input.requester, "requester", 200)),
    note: input.note === undefined ? undefined : (input.note === null || input.note === "" ? null : str(input.note, "note", 2000)),
    reset_seen: input.reset_seen === true,
  };
}

/** 카테고리 붙이기 레인 저장의 입력 스키마 — MCP 는 여기 없는 필드를 조용히 떨군다(zod strip). 거부하려면 선언해야 한다. */
export const knowledgeLaneShape = {
  id: z.number().int().positive().optional(),
  key: z.string().optional().describe("식별 슬러그(a-z0-9._-)"),
  label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional().describe("높을수록 먼저 가져간다. 낮은 값 + 넓은 스코프 = 나머지를 받는 기본 라인"),
  target: z.enum(["unmapped", "low_confidence", "both"]).optional().describe("unmapped(미분류 지식)만 쓴다 — low_confidence·both 는 폐지된 재분류 모드라 400"),
  confidence_below: z.number().min(0).max(1).nullable().optional().describe("폐지된 재분류 문턱 — 값을 주면 400, null 로 비우기만 된다"),
  match_types: z.array(z.string()).or(z.string()).nullable().optional().describe("page-type 으로 좁힘(decision·how-to 등)"),
  match_provenance: z.string().nullable().optional().describe("authored(저작) | observed(미러)"),
  match_systems: z.array(z.string()).or(z.string()).nullable().optional().describe("출처 시스템(notion·slack 등)"),
  exclude_names: z.array(z.string()).or(z.string()).nullable().optional(),
  min_chars: z.number().int().min(0).optional(),
  lookback_days: z.number().int().positive().nullable().optional(),
  criteria_md: z.string().nullable().optional().describe("분류 판단 기준(자유서술) — 프롬프트에 그대로 삽입된다"),
  candidate_categories: z.array(z.string()).or(z.string()).nullable().optional().describe("후보 카테고리 key 제한 — 비우면 전체"),
  confirm_threshold: z.number().min(0).max(1).optional().describe("이 확신도 이상이면 confirmed, 미만이면 proposed(사람 검토). 기본 0.8"),
  batch_size: z.number().int().min(1).max(500).optional(),
  mode: z.enum(["headless", "session"]).optional(),
  session_ref: z.string().nullable().optional(),
  harness: z.string().nullable().optional().describe("실행할 AI CLI(claude·codex·antigravity·grok). 비우면 자동 — 의뢰자가 로그인한 하네스 중에서 고른다(claude 우선). model 은 **이 하네스의 모델 이름**이어야 한다(다르면 그 하네스의 자동화 기본값으로 대체)."),
  model: z.string().nullable().optional().describe("모델. 비우면 그 하네스의 자동화 기본값(claude=opus · codex=gpt-5.6-sol · antigravity=gemini-3.8-flash-high · grok=grok-4.6). ⚠ 비움이 «CLI 계정 기본» 을 뜻하지 않는다 — 무인 배치가 가장 비싼 모델로 도는 것을 막기 위해 라이블리가 기본을 정한다(#4008)."),
  effort: z.string().nullable().optional().describe("추론강도. 비우면 그 하네스의 자동화 기본값(claude=low · codex=medium · antigravity=high · grok=medium)."),
  requester: z.string().nullable().optional().describe("이 사람의 AI 계정으로 실행·과금"),
  note: z.string().nullable().optional(),
  reset_seen: z.boolean().optional().describe("'이미 판정함' 기록을 비운다 — 기준을 바꿔 다시 보고 싶을 때"),
};

/** 레인을 id 또는 key 로 — 없으면 404. 이 레인의 key 는 자료 레인과 겹칠 수 있어(둘 다 "default") 늘 이 도구 안에서만 찾는다. */
async function laneOf(input: Record<string, unknown>) {
  const ref = input.id !== undefined && input.id !== null && input.id !== "" ? Number(input.id) : String(input.key ?? "").trim();
  if (!ref) throw new HttpError(400, "카테고리 붙이기 레인의 id 또는 key 가 필요합니다");
  const lane = await getClassifier(ref);
  if (!lane) throw new HttpError(404, `카테고리 붙이기 레인 '${String(ref)}' 없음`);
  return lane;
}

/** 목록 응답 — REST 호환 경로와 옛 이름 별칭이 같은 모양을 준다(옛 화면·스킬이 classifiers·coverage 를 읽는다). */
async function laneList() {
  return { classifiers: await listClassifiers(), coverage: await classifierCoverage() };
}

const categoryLaneOps: Capability[] = [
  //  목록은 MCP 에 따로 두지 않는다 — org_distiller_list 가 knowledge_lanes·coverage.knowledge 로 함께 준다.
  //   이 REST 경로는 옛 화면(배포 중·롤백 뒤 열린 탭)과 새 화면의 옛 코어 대비 폴백이 읽는다.
  (() => {
    const cap = restWork("org_distiller_category_list", "증류기 — 카테고리 붙이기 레인 목록(REST 호환)",
      "카테고리 붙이기 레인 + 커버리지. MCP 에선 org_distiller_list 의 knowledge_lanes 를 쓴다.",
      [{ method: "GET", paths: ["/api/ui/org/classifiers"], parse: () => ({}) }],
      async () => laneList());
    return { ...cap, expose: { ...cap.expose, mcp: false } };
  })(),

  restWork("org_distiller_category_upsert", "증류기 — 카테고리 붙이기 레인 저장",
    "증류기의 **카테고리 붙이기 레인**을 만들거나 고친다 — 카테고리가 없는 지식(미분류 지식: 노션 같은 지식 직행 수집·카테고리 삭제·" +
    "휴지통 복원·제안 반려로 생긴다)을 읽고 카테고리를 제안하는 레인이다. 본문은 안 바꾼다. 자료를 읽어 지식을 쓰는 레인은 org_distiller_upsert(자료 레인)다. " +
    "스코프: match_types(page-type)·match_provenance(authored|observed)·match_systems(출처 system — notion 등)·exclude_names·min_chars·lookback_days. " +
    "기준: criteria_md · candidate_categories(후보 카테고리 key 제한) · confirm_threshold(이 확신도 이상이면 확정, 미만이면 사람 확인 — 기본 0.8). " +
    "실행: batch_size(지식 수)·mode·harness·model·effort·requester. id 나 key 로 기존 것을 지정하면 수정, 없으면 생성(key 는 자료 레인과 별개 공간). " +
    "기준을 바꿔 이미 본 지식을 다시 보려면 reset_seen=true. 자료 레인 전용 필드(include_channels·target_category 등)를 주면 400. " +
    "target 은 unmapped 만 — 이미 붙은 카테고리를 고치는 재분류 모드(low_confidence·both)와 confidence_below 는 폐지(400).",
    [{ method: "POST", paths: ["/api/ui/org/classifiers"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      try { assertLaneFields(input, "knowledge"); }
      catch (e) { throw new HttpError(400, (e as Error).message); }
      const lane = await upsertClassifier(knowledgeLaneInput(input), actorOf(user), "web");
      return { lane: { ...lane, input: "knowledge" }, classifier: lane };   // classifier — 옛 호출자(컨트롤플레인·옛 화면) 호환
    }, knowledgeLaneShape),

  restWork("org_distiller_category_preview", "증류기 — 카테고리 붙이기 레인 미리보기",
    "이 레인이 **지금 맡은 지식**(아직 안 본 미분류 지식) 표본과 잔량을 보여준다(실행하지 않는다). " +
    "0건이면 스코프가 좁거나, 우선순위 높은 레인이 먼저 가져갔거나, 이미 본 것들이다(reset_seen 으로 되돌릴 수 있다).",
    [{ method: "GET", paths: ["/api/ui/org/classifiers/preview"], parse: (req) => ({
      key: req.query?.key ? String(req.query.key) : undefined,
      id: req.query?.id ? Number(req.query.id) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const c = await laneOf(input);
      const limit = Math.min(Math.max(1, Number(input.limit ?? 12)), 100);
      const sample = await classifierInbox(c, limit);
      const cov = (await classifierCoverage()).classifiers.find((x) => x.id === c.id);
      return { lane: { ...c, input: "knowledge" }, classifier: c, sample, backlog: cov?.backlog ?? sample.length, reviewed: cov?.reviewed ?? 0 };
    }, {
      key: z.string().optional().describe("레인 key"), id: z.number().int().positive().optional().describe("레인 id(key 대신)"),
      limit: z.number().int().min(1).max(100).optional(),
    }),

  restWork("org_distiller_category_remove", "증류기 — 카테고리 붙이기 레인 삭제",
    "카테고리 붙이기 레인을 지운다(id 또는 key). 이미 만들어진 카테고리 제안은 그대로 남는다(지식의 자산이지 레인의 것이 아니다). " +
    "이 레인이 맡던 지식은 다른 레인으로 넘어가고, 켜진 레인이 하나도 안 남으면 미분류 지식 전부를 기본 기준 하나로 본다.",
    [{ method: "POST", paths: ["/api/ui/org/classifiers/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const c = await laneOf(input);
      await removeClassifier(c.id, actorOf(user), "web");
      return { ok: true };
    }, {
      id: z.number().int().positive().optional().describe("삭제할 레인 id"),
      key: z.string().optional().describe("삭제할 레인 key(id 대신)"),
    }),
];

//  옛 이름 별칭(읽기 전용 · MCP 만) — **다음 릴리스에서 뺀다**. 스킬은 조직이 한 번 고치면 시드 갱신(updated_by='system'
//   만 덮는다)을 안 받으므로, 옛 스킬 문장(«org_classifier_list 로 본다»)을 가진 워크스페이스가 이번 릴리스 동안 헛돌지 않게 한다.
//   쓰기 별칭은 두지 않는다 — 옛 이름으로 쓰는 에이전트는 «없는 도구» 로 멈추는 편이 안전하다.
const deprecatedListAlias: Capability = {
  ...restWork("org_classifier_list", "(옛 이름) 분류기 목록 — org_distiller_list 를 쓰라",
    "⚠ 옛 이름(분류기) — 다음 릴리스에서 사라진다. 분류기는 이제 증류기의 **카테고리 붙이기 레인**이다. " +
    "새 호출은 org_distiller_list(knowledge_lanes · coverage.knowledge)로 보고 org_distiller_category_upsert/preview/remove 로 다룬다. " +
    "응답 모양은 옛것 그대로({classifiers, coverage}).",
    false, async () => laneList()),
  expose: { mcp: true, rest: false },
  mutates: false,
};

export const classifiersCapabilities: Capability[] = [...categoryLaneOps, deprecatedListAlias];

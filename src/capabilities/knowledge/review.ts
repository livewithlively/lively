// 지식 검토·변화 파악 표면(#1313 R57) — 수정 검토 큐(#783)·검토 대기 카운트(#802).
//  전부 REST 전용(mcp:false): 검토는 사람이 웹에서 하는 일이라 에이전트 툴 표면을 늘리지 않는다
//  (에이전트는 knowledge_save 응답의 gate 로 자기 저장의 상태를 안다).
//  REST 경로가 /knowledge-revisions* · /review-queue/* 라 /knowledge/:name 과 겹치지 않는다.
//  ⚠ mcp:false 여도 input 은 parse 산출과 같은 필드를 선언한다(#1403 — types.ts 의 input 규약). 지금은 zod 를
//   태우는 경로가 없어(isToolExposed 가 mcp:false 를 fail-closed 로 차단) 무해하지만, 비워 두면 나중에 mcp:true 로
//   여는 순간 전 필드가 strip 된다. 선언을 사실과 맞춰 두면 핸들러 타입도 z.infer 로 파생된다.
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import {
  listRevisions, getRevision, approveRevision, rejectRevision, reviewQueueCounts, reviewQueueCountsByCategory,
} from "../../v6/knowledge-revision-store.js";
// #802 검토 대기 개인화 — '내 도메인' = 내 팀이 오너인 카테고리(me 의 team_owner_category_ids 와 같은 소스).
import { memberCategories } from "../../v6/team-store.js";
import { canSeeKnowledge } from "../../v6/visibility.js";
import { assertKnowledgeWritable, filterVisibleByName } from "./shared.js";

// ════════ #783 수정 검토 큐 — 기존 active 지식을 에이전트가 고친 건을 사람이 diff 로 검토. ════════
//  신규 지식은 lifecycle='pending' 으로 격리되므로 knowledge_list(lifecycle=pending)가 그 큐다.
//  수정은 본문과 분리해 knowledge_revision 에 쌓인다(staged=미반영·applied=반영후검토) → 여기 3종이 그 표면.
//  scope='memory' — #638 결정("승인 자격제한 없음, 카테고리 전문성 있는 워킹레벨이 더 잘 검토"). 승인자는 감사(actor)에 남는다.
//  REST 전용: 검토는 사람이 웹에서 하는 일이라 MCP 툴 표면을 늘리지 않는다(에이전트는 knowledge_save 응답의 gate 로 상태를 안다).

const knowledgeRevisionsInput = {
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.number().int().positive().optional(),
};
type KnowledgeRevisionsInput = z.infer<z.ZodObject<typeof knowledgeRevisionsInput>>;
export const knowledgeRevisions: Capability = {
  name: "knowledge_revisions",
  title: "지식 수정 검토 큐",
  description: "검토 대기(또는 처리된) 지식 수정 목록 — 대상 지식·제안자(에이전트/사람)·모드(staged|applied)·증감 줄수·충돌 여부.",
  scope: "memory",
  input: knowledgeRevisionsInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-revisions"],
      parse: (req) => ({
        status: req.query?.status ? String(req.query.status) : "pending",
        limit: req.query?.limit ? Number(req.query.limit) : 200,
      }) }],
  },
  handler: async (input: KnowledgeRevisionsInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const status = ["pending", "approved", "rejected"].includes(String(input.status)) ? String(input.status) : "pending";
    const entries = await listRevisions(status, Number(input.limit) || 200);
    return { entries: await filterVisibleByName(entries, ctx?.viewer ?? null) };
  },
};

const knowledgeRevisionGetInput = { id: z.number().int().positive() };
type KnowledgeRevisionGetInput = z.infer<z.ZodObject<typeof knowledgeRevisionGetInput>>;
export const knowledgeRevisionGet: Capability = {
  name: "knowledge_revision_get",
  title: "지식 수정 제안 상세",
  description: "수정 제안 1건 + 라이브 현재본 — diff 렌더용 전문 3종(수정 전 base / 라이브 현재 / 제안 new).",
  scope: "memory",
  input: knowledgeRevisionGetInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-revisions/:id"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: KnowledgeRevisionGetInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const got = await getRevision(Number(input.id));
    if (!got) throw new HttpError(404, "수정 제안 없음");
    // 리비전에는 **라이브 본문 스냅샷**(base_body_md)이 들어 있다(#1291) — 원본이 안 보이는 사람에게 열어주면
    //  "수정 제안을 하나 만들고 그 diff 를 열어 전문을 읽는" 우회로가 된다. 없는 것과 같은 문구로 답한다.
    if (!(await canSeeKnowledge(String(got.revision.name), ctx?.viewer ?? null))) {
      throw new HttpError(404, "수정 제안 없음");
    }
    return got;
  },
};

const knowledgeRevisionReviewInput = { id: z.number().int().positive(), decision: z.enum(["approve", "reject"]) };
type KnowledgeRevisionReviewInput = z.infer<z.ZodObject<typeof knowledgeRevisionReviewInput>>;
export const knowledgeRevisionReview: Capability = {
  name: "knowledge_revision_review",
  title: "지식 수정 승인/반려",
  description: "승인 — staged: 제안 본문을 라이브에 적용 · applied: 확인(이미 반영됨). 반려 — staged: 제안 폐기(라이브 무변) · applied: 라이브를 수정 전으로 되돌림.",
  scope: "memory",
  input: knowledgeRevisionReviewInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge-revisions/:id/review"],
      parse: (req) => {
        const decision = String(((req.body ?? {}) as Record<string, unknown>).decision ?? "");
        if (!["approve", "reject"].includes(decision)) throw new HttpError(400, "decision 은 approve|reject");
        return { id: Number(req.params?.id), decision };
      } }],
  },
  handler: async (input: KnowledgeRevisionReviewInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 공개범위(#1291) — 승인/반려는 **라이브 본문을 갈아끼우는 쓰기**다(reject+applied 는 되돌리기까지 한다).
    //  목록·상세는 이미 걸러지지만 id 를 직접 때리는 경로가 남아 있으면 안 보이는 문서를 그 자리에서 덮을 수 있다.
    const got = await getRevision(Number(input.id));
    if (!got) throw new HttpError(404, "수정 제안 없음");
    await assertKnowledgeWritable(got.revision.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return input.decision === "approve"
      ? await approveRevision(Number(input.id), writeCtx)
      : await rejectRevision(Number(input.id), writeCtx);
  },
};

// ════════ #802 검토 큐 요약(카운트) — 검토 큐를 관리탭 밖으로 꺼내는 표면들의 공용 데이터원. ════════
//  문제: 검토 큐가 관리탭 안에만 있어, 아무도 안 들어가면 에이전트가 쓴 지식이 승인 대기로 묻힌다
//   (pending 은 검색·세션주입에서 빠져 있으므로 "기록했는데 아무도 못 쓰는" 상태).
//  → 대시보드 '최신 알림'의 검토 대기 리마인더 + 관리탭 nav 배지 + 큐의 '내 도메인' 필터가 이걸 함께 먹는다.
//  scope='memory' — 검토 큐(knowledge_revisions)와 동일. 검토할 수 없는 사람에겐 애초에 알리지 않는다(403 → 표면 생략).

export const reviewQueueSummary: Capability = {
  name: "review_queue_summary",
  title: "검토 큐 요약",
  description: "검토 대기 건수 — 신규(pending 지식) + 수정(리비전). 전체와 '내 도메인'(내 팀이 오너인 카테고리)을 분리해 준다.",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,   // 검토는 사람이 웹에서 하는 일 — 에이전트 툴 표면을 늘리지 않는다(knowledge_revisions 와 동일 판단).
    rest: [{ method: "GET", paths: ["/api/ui/review-queue/summary"], parse: () => ({}) }],
  },
  handler: async (_input: unknown, user: LivelyUser, ctx?: CapabilityCtx) => {
    const memberId = String(user?.userId ?? "");
    // 팀 미설정·스키마 초기 등으로 실패해도 카운트 자체는 살린다(개인화만 빠짐 — 전체 건수는 여전히 유효).
    const cats = memberId ? await memberCategories(memberId).catch(() => []) : [];
    const owner = cats.filter((c) => c.owner);
    const counts = await reviewQueueCounts(owner.map((c) => c.category_id), ctx?.viewer ?? null);
    // #968 by_category — 검토 큐 사이드바(카테고리 트리) 배지용. 실패해도 총계는 살린다(추가 표면일 뿐).
    const by_category = await reviewQueueCountsByCategory().catch(() => [] as { key: string | null; n: number }[]);
    return { ...counts, mine_category_keys: owner.map((c) => c.key), by_category };
  },
};

export const reviewCapabilities: Capability[] = [
  knowledgeRevisions, knowledgeRevisionGet, knowledgeRevisionReview,   // #783 수정 검토 큐
  reviewQueueSummary,   // #802 검토 대기 카운트(/review-queue/summary — 대시보드·nav 배지)
];

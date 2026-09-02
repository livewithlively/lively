// 지식 분류·링크 표면(#1313 R57) — 카테고리 연결(사람)·LLM 분류 제안(분류기)·미분류/proposed 인박스·
//  지식↔지식 링크(#290). '이 지식이 어디에 속하고 무엇과 이어지나'를 다루는 축(본문은 authoring.ts).
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import {
  linkKnowledgeCategory, unlinkKnowledgeCategory, listUnmappedKnowledge, listProposedClassifications,
  proposeKnowledgeCategory, linkKnowledge, unlinkKnowledge,
} from "../../v6/knowledge-store.js";
import { assertKnowledgeWritable, classificationInfo } from "./shared.js";

// ── 미분류 지식 인박스(#982) — 카테고리 0건 active 지식. list_unmapped(코드유닛)의 지식판. 분류기(classify_knowledge 크론)·사람이 드레인. ──
const knowledgeUnmappedInput = { limit: z.number().int().positive().max(200).optional() };
type KnowledgeUnmappedInput = z.infer<z.ZodObject<typeof knowledgeUnmappedInput>>;
export const knowledgeUnmapped: Capability = {
  name: "knowledge_unmapped",
  title: "미분류 지식 인박스",
  description: "카테고리가 하나도 없는 active 지식 목록(최근순). 커넥터 미러(노션 등)는 카테고리를 안 써서 여기 쌓인다 — 미분류 지식은 recall 라우터의 INNER JOIN 에서 소환 불가라 편입 대상. 분류기가 여기서 드레인해 knowledge_propose_category 로 카테고리를 제안한다(map_unmapped→map_code_unit 의 지식판). 본문 미포함(포인터).",
  scope: "memory",
  input: knowledgeUnmappedInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/unmapped"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: KnowledgeUnmappedInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ entries: await listUnmappedKnowledge(input.limit ?? 50, ctx?.viewer ?? null) }),
};

// ── proposed 분류 검토 인박스(#1102) — 분류기가 건 mapped_by='llm'·state='proposed' 제안 목록(confidence 낮은 순). ──
//  미분류 인박스(knowledge_unmapped)의 다음 단계: 검토 UI(#/knowledge/classifications)가 읽어 확정/재분류/반려. 각 항목에 제안 카테고리·confidence·evidence(본문 미포함).
const knowledgeClassificationsInput = { limit: z.number().int().positive().max(500).optional() };
type KnowledgeClassificationsInput = z.infer<z.ZodObject<typeof knowledgeClassificationsInput>>;
export const knowledgeClassifications: Capability = {
  name: "knowledge_classifications",
  title: "proposed 분류 검토 인박스",
  description: "분류기(knowledge_propose_category)가 제안한 mapped_by='llm'·state='proposed' 카테고리 분류 목록(confidence 낮은 순 — 가장 검토 필요한 것 먼저, NULL 최우선). 각 항목에 제안 카테고리(key·이름)·confidence·evidence 포함(본문 미포함, 포인터). 사람이 한 화면에서 확정(knowledge_link_category state=confirmed)·재분류(다른 카테고리)·반려(unlink→미분류 복귀)하는 검토 큐. 미분류 인박스(knowledge_unmapped)의 다음 단계.",
  scope: "memory",
  input: knowledgeClassificationsInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/classifications"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: KnowledgeClassificationsInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ entries: await listProposedClassifications(input.limit ?? 200, ctx?.viewer ?? null) }),
};

// 핸들러가 읽는 이름(REST 는 :name 경로 + body 'category_id'→categoryId 매핑). state 기본=confirmed(REST 와 동일).
const knowledgeLinkCategoryInput = {
  name: z.string().min(1).max(64),
  categoryId: z.number().int().positive(),
  unlink: z.boolean().optional(),
  state: z.string().max(32).default("confirmed"),
};
type KnowledgeLinkCategoryInput = z.infer<z.ZodObject<typeof knowledgeLinkCategoryInput>>;
export const knowledgeLinkCategory: Capability = {
  name: "knowledge_link_category",
  title: "지식↔카테고리",
  description: "지식을 카테고리에 연결(또는 unlink=true 로 해제).",
  scope: "memory",
  input: knowledgeLinkCategoryInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/category"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryId = Number(b.category_id);
        if (!Number.isInteger(categoryId)) throw new HttpError(400, "category_id 가 필요합니다");
        return {
          name: String(req.params?.name ?? ""), categoryId,
          unlink: b.unlink === true, state: b.state ? String(b.state) : "confirmed",
        };
      } }],
  },
  handler: async (input: KnowledgeLinkCategoryInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledgeCategory(input.name, input.categoryId, writeCtx); return { unlinked: true }; }
    await linkKnowledgeCategory(input.name, input.categoryId, input.state, writeCtx);
    return { linked: true };
  },
};

// ── LLM 분류 제안(#982, map_code_unit 의 지식판) — 미분류 지식에 카테고리를 mapped_by='llm'+evidence 로 제안. ──
//  linkKnowledgeCategory(사람용, replace+manual)와 별개: DELETE 안 함·mapped_by='llm'·이미 카테고리 있으면 no-op(빈 자리만 채움).
const knowledgeProposeCategoryInput = {
  name: z.string().min(1).max(64),
  categoryId: z.number().int().positive(),
  evidence: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1).optional(),
  state: z.enum(["proposed", "confirmed", "rejected"]).optional(),
};
type KnowledgeProposeCategoryInput = z.infer<z.ZodObject<typeof knowledgeProposeCategoryInput>>;
export const knowledgeProposeCategory: Capability = {
  name: "knowledge_propose_category",
  title: "지식 카테고리 제안(LLM)",
  description: "미분류 지식에 카테고리를 제안한다(mapped_by='llm', evidence 필수). 이미 카테고리가 있으면 건너뛴다(사람/기존 분류 불가침 — 덮지 않는다). state 미지정 시 confidence≥0.8 면 confirmed, 아니면 proposed. proposed 도 소비쿼리(state<>'rejected')에 즉시 잡혀 발견·소환된다. 분류기(classify_knowledge)가 도메인 should 를 읽고 판단해 호출하는 툴 — 사람이 쓰는 knowledge_link_category(교체 시맨틱)와 다르다.",
  scope: "memory",
  input: knowledgeProposeCategoryInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/propose-category"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryId = Number(b.category_id ?? b.categoryId);
        if (!Number.isInteger(categoryId)) throw new HttpError(400, "category_id 가 필요합니다");
        const evidence = String(b.evidence ?? "").trim();
        if (!evidence) throw new HttpError(400, "evidence(분류 근거)가 필요합니다");
        return {
          name: String(req.params?.name ?? ""), categoryId, evidence,
          confidence: b.confidence != null ? Number(b.confidence) : undefined,
          state: b.state ? String(b.state) : undefined,
        };
      } }],
  },
  handler: async (input: KnowledgeProposeCategoryInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const r = await proposeKnowledgeCategory(input.name, input.categoryId,
      { evidence: input.evidence, confidence: input.confidence, state: input.state }, writeCtx);
    // #1153 — 분류기가 방금 내린 판단을 그 자리에서 되비춘다. 정의(should)를 실어 주면 분류기가 자기 판단을
    //  근거와 대조할 수 있고, 정의가 없는 분류였다면 그 사실(=판단 근거가 조직에 없음)이 드러난다.
    return { ...r, ...(await classificationInfo(input.name)) };
  },
};

// #290 지식↔지식 링크 — 빠진 1급 프리미티브. create 또는 unlink=true. 교차주제는 카테고리 복수태깅 대신 이 링크로.
const knowledgeLinkInput = {
  name: z.string().min(1).max(64).describe("출발 지식(from)"),
  to: z.string().min(1).max(64).describe("도착 지식(to)"),
  relation: z.enum(["related", "refines", "contradicts", "depends_on"]).default("related"),
  unlink: z.boolean().optional(),
};
type KnowledgeLinkInput = z.infer<z.ZodObject<typeof knowledgeLinkInput>>;
export const knowledgeLink: Capability = {
  name: "knowledge_link",
  title: "지식↔지식 링크",
  description:
    "지식을 다른 지식과 연결한다(또는 unlink=true 로 해제). relation=related(대칭 관련)|refines(이 지식이 to 를 구체화)|contradicts(모순)|depends_on(의존). " +
    "단일 카테고리(#290)라 **교차주제는 카테고리 복수태깅이 아니라 이 링크로** 표현한다 — 백링크·그래프뷰·검색 그래프의 SoT(MediaWiki/Obsidian 모델). 양쪽 지식이 존재해야 한다.",
  scope: "memory",
  input: knowledgeLinkInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/link"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const to = String(b.to ?? "").trim();
        if (!to) throw new HttpError(400, "to(도착 지식 이름)가 필요합니다");
        return {
          name: String(req.params?.name ?? ""), to,
          relation: b.relation ? String(b.relation) : "related",
          unlink: b.unlink === true,
        };
      } }],
  },
  handler: async (input: KnowledgeLinkInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertKnowledgeWritable(input.name, ctx?.viewer ?? null);
    // 링크는 **양쪽 끝**을 본다 — 한쪽만 보면 안 보이는 문서로 엣지를 걸어 놓고, 내 문서의 백링크 목록에서
    //  그 제목을 읽는 우회로가 열린다(그리고 남의 문서에 내 엣지를 꽂는 오염이기도 하다).
    await assertKnowledgeWritable(input.to, ctx?.viewer ?? null);
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledge(input.name, input.to, input.relation, writeCtx); return { unlinked: true }; }
    await linkKnowledge(input.name, input.to, input.relation, writeCtx);
    return { linked: true };
  },
};

// 정적 REST 경로(/knowledge/unmapped · /knowledge/classifications) — /knowledge/:name 계열보다 먼저.
export const classificationInboxCapabilities: Capability[] = [knowledgeUnmapped, knowledgeClassifications];
// /knowledge/:name 하위(category · propose-category · link).
export const classificationCapabilities: Capability[] = [
  knowledgeLinkCategory, knowledgeProposeCategory, knowledgeLink,
];

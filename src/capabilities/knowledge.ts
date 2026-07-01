// v6 knowledge capability — 지식 CRUD + lifecycle + 카테고리 연결.
//  레거시 ctx_*/memory_* 와 병행(REST-only 로 시작 — 웹 지식 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 지식 — ctx_* 와 동일). injection/provenance 는 v6 직교축.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listKnowledge, getKnowledge, upsertKnowledge, setKnowledgeLifecycle, setKnowledgeWiki, deleteKnowledge,
  linkKnowledgeCategory, unlinkKnowledgeCategory, searchKnowledge, countKnowledgeGrep, hybridSearchKnowledge,
  findSimilarKnowledge, linkKnowledge, unlinkKnowledge, knowledgeGraphData,
} from "../v6/knowledge-store.js";

// 저장-시 중복감지(#172) — 신규 지식이 이 코사인 유사도 이상의 기존 지식과 겹치면 응답에 경고(비차단).
//  bge-m3 코사인 기준 보수적 임계(오탐 억제). 프로젝트 규칙 "새로 만들기 전 비슷한 거 찾기" 의 자동화.
const DEDUP_WARN_SIMILARITY = 0.6;

const knowledgeList: Capability = {
  name: "knowledge_list",
  title: "지식 목록",
  description: "지식을 space/카테고리/injection/provenance/q(grep 패턴 — knowledge_grep 과 동일 매칭)로 조회(맥락의 기록). is_wiki=true 면 WIKI 인덱스 핀(매 대화 첫머리에 깔리는 인덱스)만.",
  scope: "memory",
  // MCP 필드명 = 핸들러가 읽는 이름(REST 는 query 'category'→categoryId 로 매핑). injection/provenance/lifecycle/orderBy/is_wiki 도 선택.
  input: {
    space: z.string().optional(),
    categoryId: z.number().int().positive().optional(),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional(),
    lifecycle: z.enum(["active", "superseded"]).optional(),
    q: z.string().optional(),
    orderBy: z.enum(["name", "updated_at"]).optional(),
    is_wiki: z.boolean().optional().describe("true 면 WIKI 인덱스 핀(is_wiki) 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 인덱스(#336)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          space: query.space ? String(query.space) : undefined,
          categoryId: query.category ? Number(query.category) : undefined,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          type: query.type ? String(query.type) : undefined,
          lifecycle: query.lifecycle ? String(query.lifecycle) : undefined,
          q: query.q ? String(query.q) : undefined,
          orderBy: query.orderBy ? String(query.orderBy) : undefined,
          is_wiki: query.is_wiki != null ? (String(query.is_wiki) === "true" || String(query.is_wiki) === "1") : undefined,
        };
      } }],
  },
  handler: async (input: any) => ({ entries: await listKnowledge(input) }),
};

const knowledgeGet: Capability = {
  name: "knowledge_get",
  title: "지식 상세",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — deferred 금지, 상시 로드(grep→get 루프 왕복 0)
  description: "지식 1건 + 매핑된 카테고리. **부분읽기**: offset(시작 줄,1-based)·limit(줄 수)로 본문을 줄 범위만 받는다(로컬 Read 패리티 — grep 스니펫의 L<n>: 를 그대로 조회). 둘 다 생략 시 전문. 응답 body_range 로 총줄수·다음 범위 파악.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    offset: z.number().int().min(1).optional().describe("부분읽기 시작 줄(1-based). offset/limit 둘 다 생략 시 전문"),
    limit: z.number().int().min(1).max(2000).optional().describe("부분읽기 줄 수(기본 200)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name"],
      parse: (req) => ({
        name: String(req.params?.name ?? ""),
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      }) }],
  },
  handler: async (input: any) => {
    const knowledge = await getKnowledge(input.name);
    if (!knowledge) throw new Error(`지식 '${input.name}' 없음`);
    if (input.offset == null && input.limit == null) return { knowledge };
    // 부분읽기 — 본문을 줄 범위로 잘라 반환(전문 대신). body_range 로 위치·총량 표기.
    const lines = (knowledge.body_md ?? "").split("\n");
    const from = Math.max(1, input.offset ?? 1);
    const count = Math.min(input.limit ?? 200, 2000);
    const slice = lines.slice(from - 1, from - 1 + count);
    const to = from - 1 + slice.length;
    return {
      knowledge: { ...knowledge, body_md: slice.join("\n") },
      body_range: { from, to, returned: slice.length, total_lines: lines.length, has_more: to < lines.length },
    };
  },
};

const knowledgeSave: Capability = {
  name: "knowledge_save",
  title: "지식 저장",
  description:
    "지식 전문 저장. **신규는 category(분류 key 1개 문자열) + type(page-type) 둘 다 필수(#290)** — type=decision|concept|how-to|reference|research|entity. 교차주제는 카테고리 복수태깅이 아니라 knowledge_link 로. provenance 포함(지식은 항상 recalled — '항상 주입'은 관리탭 '세션 주입' 섹션 문서로만, knowledge_set_wiki 로 인덱스 핀). name 없으면 자동 슬러그. " +
    "**중복 방지(중요): 신규로 만들기 전에 knowledge_similar(또는 knowledge_search)로 같은 내용이 이미 있는지 먼저 확인하라.** 있으면 새로 만들지 말고 그 지식을 **같은 name 으로 갱신**하라(에이전트는 자기 글을 삭제할 수 없으니 사후 정리보다 사전 확인이 맞다). " +
    "신규 저장 응답에 similar 가 오면(유사도 높음) 중복일 수 있으니 — 별개 주제가 아니라면 supersedes 로 기존을 대체하거나 한쪽으로 병합을 검토하라.",
  scope: "memory",
  input: {
    name: z.string().max(64).optional(),
    title: z.string().max(200).optional(),
    body_md: z.string().min(1).max(40000),
    provenance: z.enum(["authored", "observed"]).optional(),
    supersedes: z.string().max(64).optional(),
    type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional()
      .describe("page-type(#290, 신규 필수): decision(결정·ADR)|concept(개념·배경·도메인설명)|how-to(런북·절차)|reference(사양·참조)|research(조사·분석)|entity(사람·조직·제품)"),
    category: z.string().optional().describe("분류 key 1개(단일 — category_list). 신규 필수."),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const body_md = String(b.body_md ?? b.note ?? "").trim();
        if (!body_md) throw new HttpError(400, "body_md(또는 note)가 필요합니다");
        // (#335) injection 사용자 입력 폐기 — 지식은 recalled 고정. 항상-주입은 섹션 문서(org_update_section) 경로로만.
        const provenance = b.provenance ? String(b.provenance) : undefined;
        if (provenance && !["authored", "observed"].includes(provenance)) throw new HttpError(400, "provenance 는 authored|observed");
        const category = b.category != null
          ? String(Array.isArray(b.category) ? (b.category[0] ?? "") : b.category) : undefined;  // 단일(#290), 배열 오면 첫 1개
        return {
          name: b.name ? String(b.name) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md, provenance,
          supersedes: b.supersedes ? String(b.supersedes) : undefined,
          type: b.type ? String(b.type) : undefined,
          category,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const knowledge = await upsertKnowledge(input, writeCtx);
    // 저장-시 중복감지(#172) — 신규(version=1)일 때만, 방금 저장된 임베딩으로 최근접 검색(재임베딩 X).
    //  임베딩 off / 유사 없음이면 그냥 { knowledge }. 비차단 경고 — 중복이면 supersedes/병합을 사람·에이전트가 판단.
    if ((knowledge as any)?.version === 1) {
      const similar = await findSimilarKnowledge({ name: knowledge.name, limit: 3, minScore: DEDUP_WARN_SIMILARITY });
      if (similar.length) {
        return { knowledge, similar, similar_note: "⚠ 비슷한 기존 지식이 있습니다(유사도순). 별개 주제가 아니라면 새로 만들지 말고 기존을 갱신하거나 supersedes 로 대체하세요 — 다음부터는 저장 전 knowledge_similar 로 먼저 확인하세요." };
      }
    }
    return { knowledge };
  },
};

const knowledgeSetLifecycle: Capability = {
  name: "knowledge_set_lifecycle",
  title: "지식 lifecycle",
  description: "active/superseded 전환(대체 표시 등). 제거(반려)는 폐기 — 대신 knowledge_delete(휴지통, 복원가능).",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    lifecycle: z.enum(["active", "superseded"]),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/lifecycle"],
      parse: (req) => {
        const lifecycle = String(((req.body ?? {}) as Record<string, unknown>).lifecycle ?? "");
        if (!["active", "superseded"].includes(lifecycle)) throw new HttpError(400, "lifecycle 은 active|superseded");
        return { name: String(req.params?.name ?? ""), lifecycle };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeLifecycle(input.name, input.lifecycle, writeCtx) };
  },
};

// WIKI 핀 토글 — is_wiki 만 갱신. 핀된 지식의 제목+메타가 가이드 ${wiki} 로 매 세션 항상-주입(본문 제외).
const knowledgeSetWiki: Capability = {
  name: "knowledge_set_wiki",
  title: "WIKI 핀 토글",
  description: "지식을 WIKI 인덱스에 핀(고정)하거나 해제한다. 핀된 지식의 제목+메타가 컨텍스트 온톨로지 가이드의 ${wiki} 위치에 매 세션 항상-주입된다(본문 제외 — 인덱스).",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64),
    is_wiki: z.boolean(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/wiki"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { name: String(req.params?.name ?? ""), is_wiki: b.is_wiki === true };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await setKnowledgeWiki(input.name, input.is_wiki, writeCtx) };
  },
};

// 삭제(휴지통) — 활성 목록에서 제거하되 감사 스냅샷으로 보존(content_restore 로 복원). 제거의 유일 경로
//  (가역 숨김 '반려' 는 폐기 — 삭제가 복원가능이라 흡수). ⚠ 사람(웹)만 — 에이전트(MCP)는 403. deny pattern 은 domain_delete 동형.
const knowledgeDelete: Capability = {
  name: "knowledge_delete",
  title: "지식 삭제(휴지통)",
  description:
    "지식을 삭제한다 — 활성 목록·검색·주입에서 사라지되 감사 스냅샷(before)으로 보존되어 content_restore(휴지통)로 복원 가능. " +
    "연결(카테고리·프로젝트 필요/산출·활동)은 FK CASCADE 로 정리된다(복원 시 링크는 돌아오지 않음). " +
    "지식 제거의 유일 경로(가역 숨김 '반려' 는 폐기). ⚠ 사람(웹)만 — 에이전트(MCP)는 403(비가역).",
  scope: "memory",
  input: { name: z.string().min(1).max(64) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge/:name/delete"],
      parse: (req) => ({ name: String(req.params?.name ?? "") }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "지식 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 정정은 같은 이름으로 덮어쓰기(저장)하세요");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const before = await deleteKnowledge(input.name, writeCtx);
    return { deleted: true, name: input.name, title: (before as any)?.title ?? null };
  },
};

const knowledgeLinkCategory: Capability = {
  name: "knowledge_link_category",
  title: "지식↔카테고리",
  description: "지식을 카테고리에 연결(또는 unlink=true 로 해제).",
  scope: "memory",
  // 핸들러가 읽는 이름(REST 는 :name 경로 + body 'category_id'→categoryId 매핑). state 기본=confirmed(REST 와 동일).
  input: {
    name: z.string().min(1).max(64),
    categoryId: z.number().int().positive(),
    unlink: z.boolean().optional(),
    state: z.string().max(32).default("confirmed"),
  },
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
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledgeCategory(input.name, input.categoryId, writeCtx); return { unlinked: true }; }
    await linkKnowledgeCategory(input.name, input.categoryId, input.state, writeCtx);
    return { linked: true };
  },
};

// grep — title/body_md 를 grep(정규식|토큰 AND) + 스니펫. injection/provenance 로 좁힐 수 있음. ⚠ 의미검색 아님(벡터는 추후 knowledge_search 로).
const knowledgeGrep: Capability = {
  name: "knowledge_grep",
  title: "지식 grep",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — deferred 금지, 상시 로드(세션 첫 동작)
  description:
    "지식 제목/본문을 **grep**(텍스트 패턴 매칭)한다 — 의미검색 아님. 단어가 본문에 그대로 등장해야 잡힌다(대소문자 무시). " +
    "ripgrep 처럼 써라: 좁히려면 **한 토큰**(예: `도메인맵`), 다중 키워드는 공백으로 — **모든 토큰이** 들어간 지식이 잡힌다(AND, 순서무관). " +
    "OR·부분일치 등은 **POSIX 정규식**으로(예: `벡터|vector`, `task_\\w+`). " +
    "자연어 질문 문장은 넣지 마라(그 문장이 통째로 본문에 없으면 0건). 결과는 **매치 줄 스니펫**(`L<n>: …`, 본문 전문 아님) — 전문은 결과의 name 으로 knowledge_get(부분읽기 offset/limit). " +
    "mode=names(이름·제목만 싸게 넓게)·count(총건수만)·snippets(기본). context=±N 줄(스니펫에 주변 줄 포함, ripgrep -C).",
  scope: "memory",
  input: {
    q: z.string().min(1).describe("grep 패턴 — 한 토큰, 공백구분 다중토큰(AND), 또는 POSIX 정규식. 자연어 문장 금지."),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(["snippets", "names", "count"]).optional().describe("snippets(기본)=매치 줄 스니펫 / names=name·title만 / count=총건수만"),
    context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄 포함(기본 0, ripgrep -C)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/search"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const q = String(query.q ?? "").trim();
        if (!q) throw new HttpError(400, "q(검색어)가 필요합니다");
        return {
          q,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          mode: query.mode ? String(query.mode) : undefined,
          context: query.context ? Number(query.context) : undefined,
        };
      } }],
  },
  handler: async (input: any) => {
    if (input.mode === "count") {
      return { mode: "count", total: await countKnowledgeGrep(input.q, { injection: input.injection, provenance: input.provenance }) };
    }
    return {
      mode: input.mode ?? "snippets",
      entries: await searchKnowledge(input.q, {
        injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
      }),
    };
  },
};

// 하이브리드 검색(벡터검색 #172) — 벡터 임베딩 + 렉시컬 grep RRF 융합. grep(정확 매칭)과 직교: 의미·자연어 회수용.
//  org/schema.ts 가 'knowledge_search' 이름을 이 벡터검색 도구로 예약해 둠(구 knowledge_search→grep 개명 후). MCP 전용.
//  임베딩 off(기본)면 자동으로 렉시컬(grep)로 폴백 → 켜기 전에도 안전하게 동작(동작 == grep).
const knowledgeSearch: Capability = {
  name: "knowledge_search",
  title: "지식 검색(하이브리드)",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — grep 과 함께 상시(의미검색이 #172 의 헤드라인 능력)
  description:
    "지식을 **의미 기반 하이브리드 검색**한다 — 벡터 임베딩(의미 유사) + 렉시컬 grep 을 RRF 로 융합. " +
    "grep 과 달리 **자연어 질문**이나 다른 표현을 써도 관련 지식을 회수한다(단어가 본문에 그대로 없어도 잡힘). " +
    "임베딩 미설정 환경에선 자동으로 grep(렉시컬)으로 폴백한다(안전). " +
    "결과는 **스니펫**(본문 전문 아님) + RRF score — 전문은 결과의 name 으로 knowledge_get(부분읽기 offset/limit). " +
    "**정확한 토큰/정규식 매칭**이 필요하면 knowledge_grep 을, **의미/유사/자연어**면 이 도구를 써라. mode=names(이름·제목만)·snippets(기본).",
  scope: "memory",
  input: {
    q: z.string().min(1).describe("자연어 질문 또는 키워드 — 의미 유사도로 회수(grep 과 달리 문장 가능)"),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(["snippets", "names"]).optional().describe("snippets(기본)=스니펫 / names=name·title만"),
    context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄(grep 채널 매치 시, ripgrep -C)"),
  },
  // MCP + REST(/api/ui/knowledge/semantic) — 웹 지식탭의 '의미검색' 토글이 소비. grep 은 /knowledge/search(불변).
  //  ⚠ restMounts 순서: knowledgeGet(/knowledge/:name) **앞**에 둬야 'semantic'이 :name 으로 안 잡힌다(배열 순서 보장).
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/semantic"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const q = String(query.q ?? "").trim();
        if (!q) throw new HttpError(400, "q(검색어)가 필요합니다");
        return {
          q,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          mode: query.mode ? String(query.mode) : undefined,
          context: query.context ? Number(query.context) : undefined,
        };
      } }],
  },
  handler: async (input: any) => ({
    entries: await hybridSearchKnowledge(input.q, {
      injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
    }),
  }),
};

// 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. dedup(저장 전 확인)·관련패널의 프리미티브.
//  search/grep 과 직교: 이건 "이 지식/텍스트와 가까운 것" 자체를 절대 유사도로 돌려준다(랭크 아님 → 임계 비교 가능).
//  임베딩 off / 대상 임베딩 없음이면 빈 결과(검색은 knowledge_search). MCP + REST(/api/ui/knowledge/similar).
const knowledgeSimilar: Capability = {
  name: "knowledge_similar",
  title: "유사 지식",
  description:
    "주어진 지식(name) 또는 텍스트(text)와 **의미적으로 가장 가까운** 지식을 코사인 유사도(0~1)로 찾는다. " +
    "신규 저장 전 **중복 확인**이나 관련 지식 탐색용. name 을 주면 그 지식의 저장된 임베딩을 재사용(자기 자신 제외), text 를 주면 즉시 임베딩한다(택일). " +
    "min_score(0~1) 이상만, 유사도 내림차순. **임베딩이 꺼져 있거나 대상에 임베딩이 없으면 빈 결과**(자연어/키워드 검색은 knowledge_search, 정확매칭은 knowledge_grep). " +
    "knowledge_save 는 신규 저장 시 비슷한 지식이 있으면 응답 similar 로 자동 경고한다 — 이 도구는 저장 전에 미리 확인할 때.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64).optional().describe("기준 지식 이름(저장된 임베딩 재사용, 자기 제외) — text 와 택일"),
    text: z.string().min(1).max(8000).optional().describe("기준 텍스트(즉시 임베딩) — name 과 택일"),
    limit: z.number().int().min(1).max(50).optional(),
    min_score: z.number().min(0).max(1).optional().describe("이 코사인 유사도(0~1) 이상만(기본 0)"),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
  },
  // REST 마운트는 knowledgeGet(/knowledge/:name) **앞**에 둬야 'similar'가 :name 으로 안 잡힌다(배열 순서 — semantic 과 동형).
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/similar"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const name = query.name ? String(query.name) : undefined;
        const text = query.text ? String(query.text) : undefined;
        if (!name && !text) throw new HttpError(400, "name 또는 text 가 필요합니다");
        return {
          name, text,
          limit: query.limit ? Number(query.limit) : undefined,
          min_score: query.min_score != null && query.min_score !== "" ? Number(query.min_score) : undefined,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
        };
      } }],
  },
  handler: async (input: any) => {
    if (!input.name && !input.text) throw new Error("name 또는 text 중 하나가 필요합니다");
    return {
      entries: await findSimilarKnowledge({
        name: input.name, text: input.text, limit: input.limit, minScore: input.min_score,
        injection: input.injection, provenance: input.provenance,
      }),
    };
  },
};

// #290 지식↔지식 링크 — 빠진 1급 프리미티브. create 또는 unlink=true. 교차주제는 카테고리 복수태깅 대신 이 링크로.
const knowledgeLink: Capability = {
  name: "knowledge_link",
  title: "지식↔지식 링크",
  description:
    "지식을 다른 지식과 연결한다(또는 unlink=true 로 해제). relation=related(대칭 관련)|refines(이 지식이 to 를 구체화)|contradicts(모순)|depends_on(의존). " +
    "단일 카테고리(#290)라 **교차주제는 카테고리 복수태깅이 아니라 이 링크로** 표현한다 — 백링크·그래프뷰·회수 그래프의 SoT(MediaWiki/Obsidian 모델). 양쪽 지식이 존재해야 한다.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64).describe("출발 지식(from)"),
    to: z.string().min(1).max(64).describe("도착 지식(to)"),
    relation: z.enum(["related", "refines", "contradicts", "depends_on"]).default("related"),
    unlink: z.boolean().optional(),
  },
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
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledge(input.name, input.to, input.relation, writeCtx); return { unlinked: true }; }
    await linkKnowledge(input.name, input.to, input.relation, writeCtx);
    return { linked: true };
  },
};

// #290 그래프뷰 데이터(UI 전용, REST) — 활성 지식 노드(+단일 카테고리) + 지식↔지식 엣지. 전역/로컬 그래프를 클라가 그린다.
const knowledgeGraph: Capability = {
  name: "knowledge_graph",
  title: "지식 그래프",
  description: "활성 지식 노드(+단일 카테고리·type)와 지식↔지식 링크 엣지를 반환한다(그래프뷰 전용).",
  scope: "memory",
  input: { limit: z.number().int().min(1).max(2000).optional() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-graph"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: any) => await knowledgeGraphData(input.limit),
};

// ⚠ REST 마운트 순서 주의 — knowledgeGrep(REST 경로는 그대로 /knowledge/search — 웹 지식탭 소비)는
//  반드시 knowledgeGet(/knowledge/:name) **앞**에 둔다(web.ts 가 배열순 app.get 마운트 → Express 선매치;
//  뒤에 두면 'search'/'overview'가 :name 으로 잡혀 404). MCP 등록은 이름목록 기반이라 순서 무관.
//  knowledge_graph(/knowledge-graph)·knowledge_link(/knowledge/:name/link)는 :name 단일세그먼트와 안 겹친다(경로 깊이 상이).
export const knowledgeCapabilities: Capability[] = [
  knowledgeList, knowledgeGrep, knowledgeSearch, knowledgeSimilar, knowledgeGraph, knowledgeGet,
  knowledgeSave, knowledgeSetLifecycle, knowledgeSetWiki, knowledgeDelete, knowledgeLinkCategory, knowledgeLink,
];

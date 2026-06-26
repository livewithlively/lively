// v6 knowledge capability — 지식 CRUD + lifecycle + 카테고리 연결.
//  레거시 ctx_*/memory_* 와 병행(REST-only 로 시작 — 웹 지식 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 지식 — ctx_* 와 동일). injection/provenance 는 v6 직교축.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listKnowledge, getKnowledge, upsertKnowledge, setKnowledgeLifecycle, setKnowledgeWiki, deleteKnowledge,
  linkKnowledgeCategory, unlinkKnowledgeCategory, searchKnowledge, countKnowledgeGrep, hybridSearchKnowledge,
} from "../v6/knowledge-store.js";

const knowledgeList: Capability = {
  name: "knowledge_list",
  title: "지식 목록",
  description: "지식을 space/카테고리/injection/provenance/q(grep 패턴 — knowledge_grep 과 동일 매칭)로 조회(맥락의 기록).",
  scope: "memory",
  // MCP 필드명 = 핸들러가 읽는 이름(REST 는 query 'category'→categoryId 로 매핑). injection/provenance/lifecycle/orderBy 도 선택.
  input: {
    space: z.string().optional(),
    categoryId: z.number().int().positive().optional(),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    lifecycle: z.enum(["active", "superseded"]).optional(),
    q: z.string().optional(),
    orderBy: z.enum(["name", "updated_at"]).optional(),
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
          lifecycle: query.lifecycle ? String(query.lifecycle) : undefined,
          q: query.q ? String(query.q) : undefined,
          orderBy: query.orderBy ? String(query.orderBy) : undefined,
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
  description: "지식 전문 저장. **신규는 category(분류) 1개 이상 필수**(category_list 의 key 배열 — 미분류 저장 금지). injection/provenance 포함. name 없으면 자동 슬러그.",
  scope: "memory",
  input: {
    name: z.string().max(64).optional(),
    title: z.string().max(200).optional(),
    body_md: z.string().min(1).max(40000),
    injection: z.enum(["always", "recalled"]).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    supersedes: z.string().max(64).optional(),
    category: z.array(z.string()).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const body_md = String(b.body_md ?? b.note ?? "").trim();
        if (!body_md) throw new HttpError(400, "body_md(또는 note)가 필요합니다");
        const injection = b.injection ? String(b.injection) : undefined;
        if (injection && !["always", "recalled"].includes(injection)) throw new HttpError(400, "injection 은 always|recalled");
        const provenance = b.provenance ? String(b.provenance) : undefined;
        if (provenance && !["authored", "observed"].includes(provenance)) throw new HttpError(400, "provenance 는 authored|observed");
        const category = Array.isArray(b.category) ? b.category.map(String)
          : (b.category ? [String(b.category)] : undefined);
        return {
          name: b.name ? String(b.name) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md, injection, provenance,
          supersedes: b.supersedes ? String(b.supersedes) : undefined,
          category,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { knowledge: await upsertKnowledge(input, writeCtx) };
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

// ⚠ REST 마운트 순서 주의 — knowledgeGrep(REST 경로는 그대로 /knowledge/search — 웹 지식탭 소비)는
//  반드시 knowledgeGet(/knowledge/:name) **앞**에 둔다(web.ts 가 배열순 app.get 마운트 → Express 선매치;
//  뒤에 두면 'search'/'overview'가 :name 으로 잡혀 404). MCP 등록은 이름목록 기반이라 순서 무관.
export const knowledgeCapabilities: Capability[] = [
  knowledgeList, knowledgeGrep, knowledgeSearch, knowledgeGet,
  knowledgeSave, knowledgeSetLifecycle, knowledgeSetWiki, knowledgeDelete, knowledgeLinkCategory,
];

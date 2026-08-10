// 지식 조회 표면(#1313 R57) — 목록·상세(부분읽기)·grep·하이브리드 검색·유사도·그래프/트리 데이터.
//  전부 읽기 전용이다(쓰기는 authoring.ts, 분류·링크는 classification.ts).
//  ⚠ REST 마운트 순서 계약 — 정적 경로(/knowledge/search·semantic·similar)는 /knowledge/:name **앞**에
//   등록돼야 'search'가 :name 으로 안 잡힌다. 그래서 배열을 static/named 두 벌로 내보내고, 조립(순서)은
//   ../knowledge.ts 가 한다.
import { z } from "zod";
import { HttpError, clampPage } from "../rest-util.js";
import type { Capability, CapabilityCtx } from "../types.js";
import type { LivelyUser } from "../../context.js";
import {
  listKnowledge, countKnowledge, getKnowledge, searchKnowledge, countKnowledgeGrep, hybridSearchKnowledge,
  findSimilarKnowledge, knowledgeGraphData, knowledgeTreeData,
} from "../../v6/knowledge-store.js";
// #783 인입 허용선 게이트 — 상세 조회는 '검토 대기 중인 수정이 있나'를 함께 알린다(덧쓰기 사고 방지).
import { pendingRevisionFor } from "../../v6/knowledge-revision-store.js";
import { canSeeKnowledge } from "../../v6/visibility.js";
import { assertKnowledgeVisible, stripLedeForAgent } from "./shared.js";

// MCP 필드명 = 핸들러가 읽는 이름(REST 는 query 'category'→categoryId, 'category=none'→uncategorized 로 매핑).
//  injection/provenance/lifecycle/orderBy/is_wiki 도 선택.
const knowledgeListInput = {
  space: z.string().optional(),
  categoryId: z.number().int().positive().optional(),
  uncategorized: z.boolean().optional().describe("true 면 미분류(rejected 아닌 카테고리 매핑이 0건)인 지식만 — space/categoryId 와 배타(#1091). 본문 포함 목록이라 인박스 포인터만 필요하면 knowledge_unmapped."),
  light: z.boolean().optional().describe("true 면 본문(body_md)을 뺀 경량 행 — 제목·메타만 필요한 목록/트리용(#1091). 본문이 필요하면 knowledge_get."),
  injection: z.enum(["always", "recalled"]).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
  type: z.enum(["decision", "concept", "how-to", "reference", "research", "entity"]).optional(),
  lifecycle: z.enum(["active", "pending", "superseded", "archived"]).optional(),   // archived(#551): 외부 미러 원본 삭제/아카이브 전파 · pending(#638): 자동 인입 검토 큐
  q: z.string().optional(),
  orderBy: z.enum(["name", "updated_at"]).optional(),
  is_wiki: z.boolean().optional().describe("true 면 WIKI 인덱스 핀(is_wiki) 지식만 — 전체 카테고리에서 매 대화 첫머리에 깔리는 인덱스(#336)"),
  limit: z.number().int().min(1).max(500).optional().describe("페이지 크기(1~500, 기본 200) — 구 200 하드캡 해제(#709)"),
  offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — limit 과 함께 상한 너머 전량 순회(#709)"),
};
type KnowledgeListInput = z.infer<z.ZodObject<typeof knowledgeListInput>>;
export const knowledgeList: Capability = {
  name: "knowledge_list",
  title: "지식 목록",
  description: "지식을 space/카테고리/injection/provenance/q(grep 패턴 — knowledge_grep 과 동일 매칭)로 조회(맥락의 기록). is_wiki=true 면 WIKI 인덱스 핀(매 대화 첫머리에 깔리는 인덱스)만. uncategorized=true 면 미분류(어느 카테고리에도 안 뜨는 지식)만. limit(≤500, 기본 200)·offset 으로 페이지네이션 — 응답에 total·has_more 포함(#709).",
  scope: "memory",
  input: knowledgeListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        // category=none → 미분류(#1091). WIKI 사이드바의 '미분류' 노드가 카테고리 노드와 같은 경로를 타도록
        //  카테고리 축의 센티널 값으로 받는다(catVal·URL ?category=none·이 쿼리가 전부 같은 문자열).
        const cat = query.category != null ? String(query.category) : "";
        return {
          space: query.space ? String(query.space) : undefined,
          categoryId: cat && cat !== "none" ? Number(cat) : undefined,
          uncategorized: cat === "none" ? true : undefined,
          injection: query.injection ? String(query.injection) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          type: query.type ? String(query.type) : undefined,
          lifecycle: query.lifecycle ? String(query.lifecycle) : undefined,
          q: query.q ? String(query.q) : undefined,
          orderBy: query.orderBy ? String(query.orderBy) : undefined,
          is_wiki: query.is_wiki != null ? (String(query.is_wiki) === "true" || String(query.is_wiki) === "1") : undefined,
          light: query.light != null ? (String(query.light) === "true" || String(query.light) === "1") : undefined,
          limit: query.limit ? Number(query.limit) : undefined,
          offset: query.offset ? Number(query.offset) : undefined,
        };
      } }],
  },
  // #709 limit/offset 페이지네이션 + total/has_more. 구 200 하드캡(구 parse 가 limit/offset 미배선)을 해제.
  handler: async (input: KnowledgeListInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const { limit, offset } = clampPage(input, 200, 500);
    // 공개범위(#1291) — 목록과 총계에 **같은 뷰어**를 준다(다르면 has_more 가 영원히 true 인 페이지가 나온다).
    const viewer = ctx?.viewer ?? null;
    const [entries, total] = await Promise.all([
      listKnowledge({ ...input, limit, offset }, viewer),
      countKnowledge(input, viewer),
    ]);
    return { entries: stripLedeForAgent(entries, ctx), total, limit, offset, has_more: offset + entries.length < total };
  },
};

// grep — title/body_md 를 grep(정규식|토큰 AND) + 스니펫. injection/provenance 로 좁힐 수 있음. ⚠ 의미검색 아님(벡터는 추후 knowledge_search 로).
const knowledgeGrepInput = {
  q: z.string().min(1).describe("grep 패턴 — 한 토큰, 공백구분 다중토큰(AND), 또는 POSIX 정규식. 자연어 문장 금지."),
  injection: z.enum(["always", "recalled"]).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  mode: z.enum(["snippets", "names", "count"]).optional().describe("snippets(기본)=매치 줄 스니펫 / names=name·title만 / count=총건수만"),
  context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄 포함(기본 0, ripgrep -C)"),
};
type KnowledgeGrepInput = z.infer<z.ZodObject<typeof knowledgeGrepInput>>;
export const knowledgeGrep: Capability = {
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
  input: knowledgeGrepInput,
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
  handler: async (input: KnowledgeGrepInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const viewer = ctx?.viewer ?? null;   // 공개범위(#1291) — 스니펫도 본문 조각이라 목록보다 더 셀 수 없다
    if (input.mode === "count") {
      return { mode: "count", total: await countKnowledgeGrep(input.q, { injection: input.injection, provenance: input.provenance }, viewer) };
    }
    return {
      mode: input.mode ?? "snippets",
      entries: stripLedeForAgent(await searchKnowledge(input.q, {
        injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
      }, viewer), ctx),
    };
  },
};

// 하이브리드 검색(벡터검색 #172) — 벡터 임베딩 + 렉시컬 grep RRF 융합. grep(정확 매칭)과 직교: 의미·자연어 회수용.
//  org/schema.ts 가 'knowledge_search' 이름을 이 벡터검색 도구로 예약해 둠(구 knowledge_search→grep 개명 후). MCP 전용.
//  임베딩 off(기본)면 자동으로 렉시컬(grep)로 폴백 → 켜기 전에도 안전하게 동작(동작 == grep).
const knowledgeSearchInput = {
  q: z.string().min(1).describe("자연어 질문 또는 키워드 — 의미 유사도로 검색(grep 과 달리 문장 가능)"),
  injection: z.enum(["always", "recalled"]).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  mode: z.enum(["snippets", "names"]).optional().describe("snippets(기본)=스니펫 / names=name·title만"),
  context: z.number().int().min(0).max(3).optional().describe("스니펫에 매치 줄 ±N 컨텍스트 줄(grep 채널 매치 시, ripgrep -C)"),
};
type KnowledgeSearchInput = z.infer<z.ZodObject<typeof knowledgeSearchInput>>;
export const knowledgeSearch: Capability = {
  name: "knowledge_search",
  title: "지식 검색(하이브리드)",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — grep 과 함께 상시(의미검색이 #172 의 헤드라인 능력)
  description:
    "지식을 **의미 기반 하이브리드 검색**한다 — 벡터 임베딩(의미 유사) + 렉시컬 grep 을 RRF 로 융합. " +
    "grep 과 달리 **자연어 질문**이나 다른 표현을 써도 관련 지식을 찾아낸다(단어가 본문에 그대로 없어도 잡힘). " +
    "임베딩 미설정 환경에선 자동으로 grep(렉시컬)으로 폴백한다(안전). " +
    "결과는 **스니펫**(본문 전문 아님) + RRF score — 전문은 결과의 name 으로 knowledge_get(부분읽기 offset/limit). " +
    "**정확한 토큰/정규식 매칭**이 필요하면 knowledge_grep 을, **의미/유사/자연어**면 이 도구를 써라. mode=names(이름·제목만)·snippets(기본).",
  scope: "memory",
  input: knowledgeSearchInput,
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
  handler: async (input: KnowledgeSearchInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({
    entries: stripLedeForAgent(await hybridSearchKnowledge(input.q, {
      injection: input.injection, provenance: input.provenance, limit: input.limit, mode: input.mode, context: input.context,
    }, ctx?.viewer ?? null), ctx),
  }),
};

// 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. dedup(저장 전 확인)·관련패널의 프리미티브.
//  search/grep 과 직교: 이건 "이 지식/텍스트와 가까운 것" 자체를 절대 유사도로 돌려준다(랭크 아님 → 임계 비교 가능).
//  임베딩 off / 대상 임베딩 없음이면 빈 결과(검색은 knowledge_search). MCP + REST(/api/ui/knowledge/similar).
const knowledgeSimilarInput = {
  name: z.string().min(1).max(64).optional().describe("기준 지식 이름(저장된 임베딩 재사용, 자기 제외) — text 와 택일"),
  text: z.string().min(1).max(8000).optional().describe("기준 텍스트(즉시 임베딩) — name 과 택일"),
  limit: z.number().int().min(1).max(50).optional(),
  min_score: z.number().min(0).max(1).optional().describe("이 코사인 유사도(0~1) 이상만(기본 0)"),
  injection: z.enum(["always", "recalled"]).optional(),
  provenance: z.enum(["authored", "observed"]).optional(),
};
type KnowledgeSimilarInput = z.infer<z.ZodObject<typeof knowledgeSimilarInput>>;
export const knowledgeSimilar: Capability = {
  name: "knowledge_similar",
  title: "유사 지식",
  description:
    "주어진 지식(name) 또는 텍스트(text)와 **의미적으로 가장 가까운** 지식을 코사인 유사도(0~1)로 찾는다. " +
    "신규 저장 전 **중복 확인**이나 관련 지식 탐색용. name 을 주면 그 지식의 저장된 임베딩을 재사용(자기 자신 제외), text 를 주면 즉시 임베딩한다(택일). " +
    "min_score(0~1) 이상만, 유사도 내림차순. **임베딩이 꺼져 있거나 대상에 임베딩이 없으면 빈 결과**(자연어/키워드 검색은 knowledge_search, 정확매칭은 knowledge_grep). " +
    "knowledge_save 는 신규 저장 시 비슷한 지식이 있으면 응답 similar 로 자동 경고한다 — 이 도구는 저장 전에 미리 확인할 때.",
  scope: "memory",
  input: knowledgeSimilarInput,
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
  handler: async (input: KnowledgeSimilarInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!input.name && !input.text) throw new Error("name 또는 text 중 하나가 필요합니다");
    const viewer = ctx?.viewer ?? null;
    // 기준 문서(name)도 볼 수 있어야 한다 — 안 보이는 문서의 임베딩으로 이웃을 훑는 건 그 문서를 지렛대 삼아
    //  "무엇에 대한 문서인가"를 역추적하는 우회로다(recall 훅이 매 세션 때리는 경로라 특히).
    await assertKnowledgeVisible(input.name, viewer);
    return {
      entries: stripLedeForAgent(await findSimilarKnowledge({
        name: input.name, text: input.text, limit: input.limit, minScore: input.min_score,
        injection: input.injection, provenance: input.provenance,
      }, viewer), ctx),
    };
  },
};

// #290 그래프뷰 데이터(UI 전용, REST) — 활성 지식 노드(+단일 카테고리) + 지식↔지식 엣지. 전역/로컬 그래프를 클라가 그린다.
const knowledgeGraphInput = { limit: z.number().int().min(1).max(2000).optional() };
type KnowledgeGraphInput = z.infer<z.ZodObject<typeof knowledgeGraphInput>>;
export const knowledgeGraph: Capability = {
  name: "knowledge_graph",
  title: "지식 그래프",
  description: "활성 지식 노드(+단일 카테고리·type)와 지식↔지식 링크 엣지를 반환한다(그래프뷰 전용).",
  scope: "memory",
  input: knowledgeGraphInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-graph"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  handler: async (input: KnowledgeGraphInput, _user: LivelyUser, ctx?: CapabilityCtx) => await knowledgeGraphData(input.limit, ctx?.viewer ?? null),
};

// #551 페이지 트리(외부 미러) — 얕은 스켈레톤(name/title/parent/sort/lifecycle/kind) 전량. UI 전용(REST).
//  목록 cap(500) 우회: 본문 미포함이라 수천 행도 가볍다. 클라이언트(WIKI 탭 트리)가 조립.
const knowledgeTreeInput = {
  system: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(50000).optional(),
};
type KnowledgeTreeInput = z.infer<z.ZodObject<typeof knowledgeTreeInput>>;
export const knowledgeTree: Capability = {
  name: "knowledge_tree",
  title: "지식 페이지 트리",
  description: "외부 미러(system)의 페이지 트리 스켈레톤(parent_name/sort 기반)을 반환한다(트리 뷰 전용).",
  scope: "memory",
  input: knowledgeTreeInput,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge-tree"],
      parse: (req) => {
        const n = req.query?.limit ? Number(req.query.limit) : NaN;
        return {
          system: req.query?.system ? String(req.query.system) : undefined,
          limit: Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined, // NaN/음수 → 기본값(SQL LIMIT 오류 방지)
        };
      } }],
  },
  handler: async (input: KnowledgeTreeInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ entries: await knowledgeTreeData(input.system ?? "notion", input.limit, ctx?.viewer ?? null) }),
};

const knowledgeGetInput = {
  name: z.string().min(1).max(64),
  offset: z.number().int().min(1).optional().describe("부분읽기 시작 줄(1-based). offset/limit 둘 다 생략 시 전문"),
  limit: z.number().int().min(1).max(2000).optional().describe("부분읽기 줄 수(기본 200)"),
};
type KnowledgeGetInput = z.infer<z.ZodObject<typeof knowledgeGetInput>>;
export const knowledgeGet: Capability = {
  name: "knowledge_get",
  title: "지식 상세",
  meta: { "anthropic/alwaysLoad": true },   // 회수 진입점 — deferred 금지, 상시 로드(grep→get 루프 왕복 0)
  description: "지식 1건 + 매핑된 카테고리. **부분읽기**: offset(시작 줄,1-based)·limit(줄 수)로 본문을 줄 범위만 받는다(로컬 Read 패리티 — grep 스니펫의 L<n>: 를 그대로 조회). 둘 다 생략 시 전문. 응답 body_range 로 총줄수·다음 범위 파악.",
  scope: "memory",
  input: knowledgeGetInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name"],
      parse: (req) => ({
        name: String(req.params?.name ?? ""),
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      }) }],
  },
  handler: async (input: KnowledgeGetInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    // 공개범위(#1291) — 전문을 돌려주는 자리라 **본문을 읽기 전에** 막는다(없는 문서와 같은 문구 = 존재 은닉).
    if (!(await canSeeKnowledge(String(input.name), ctx?.viewer ?? null))) throw new Error(`지식 '${input.name}' 없음`);
    const knowledge0 = await getKnowledge(input.name, ctx?.viewer ?? null);
    if (!knowledge0) throw new Error(`지식 '${input.name}' 없음`);
    const knowledge = stripLedeForAgent(knowledge0, ctx);   // 요지는 사람 화면 전용(#1600)
    // #783 이 지식에 검토 대기 중인 수정이 있으면 함께 알린다 — staged 면 "지금 보는 본문은 옛 승인본"이라는 뜻이라
    //  사람·에이전트가 그 사실을 모르고 덧쓰면 안 된다(웹 문서화면은 이 값으로 배너를 띄운다).
    const pendingRev = await pendingRevisionFor(input.name);
    const revInfo = pendingRev
      ? {
        pending_revision: {
          id: pendingRev.id, mode: pendingRev.mode, proposed_by: pendingRev.proposed_by,
          actor_kind: pendingRev.actor_kind, agent: pendingRev.agent, edits: pendingRev.edits,
          updated_at: pendingRev.updated_at,
          note: pendingRev.mode === "staged"
            ? "이 지식에는 검토 대기 중인 수정 제안이 있습니다 — 아래 본문은 아직 옛 승인본입니다(승인 시 교체)."
            : "이 지식의 최근 수정이 사람 검토 대기 중입니다 — 본문은 반영돼 있으나 되돌려질 수 있습니다.",
        },
      }
      : {};
    if (input.offset == null && input.limit == null) return { knowledge, ...revInfo };
    // 부분읽기 — 본문을 줄 범위로 잘라 반환(전문 대신). body_range 로 위치·총량 표기.
    const lines = (knowledge.body_md ?? "").split("\n");
    const from = Math.max(1, input.offset ?? 1);
    const count = Math.min(input.limit ?? 200, 2000);
    const slice = lines.slice(from - 1, from - 1 + count);
    const to = from - 1 + slice.length;
    return {
      knowledge: { ...knowledge, body_md: slice.join("\n") },
      body_range: { from, to, returned: slice.length, total_lines: lines.length, has_more: to < lines.length },
      ...revInfo,
    };
  },
};

// 정적 REST 경로(/knowledge/search·/knowledge/semantic·/knowledge/similar·/knowledge-graph·/knowledge-tree)
//  — /knowledge/:name 계열보다 **먼저** 마운트돼야 한다.
export const readStaticCapabilities: Capability[] = [
  knowledgeList, knowledgeGrep, knowledgeSearch, knowledgeSimilar, knowledgeGraph, knowledgeTree,
];
// /knowledge/:name — 위 정적 경로가 전부 등록된 뒤에 온다.
export const readNamedCapabilities: Capability[] = [knowledgeGet];

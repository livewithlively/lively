// items 그룹 capability — 크로스소스 Item 검색/상세. canonical = store 의 UI fn
// (searchItemsUi/getItemUi/getItemThread) — 웹 REST 와 MCP 가 같은 페이로드를 본다.
import { z } from "zod";
import { searchItemsUi, getItemUi, getItemThread } from "../items/store.js";
import type { Capability } from "./types.js";
import { HttpError, qstr, qint, qiso, qtype } from "./rest-util.js";

// canonical row = {rows:[ id,type,system,container_ref,title,snippet,body_length,external_url,
// occurred_at,parent_id,actor,domains[],projects[] ]} — 구 MCP 의 bare 배열 + 'body'(400자 절단
// 모호) shape 는 폐기. 배지/EXISTS 절은 rejected 기본 제외(includeRejected 옵션).
const searchItems: Capability = {
  name: "search_items",
  title: "크로스소스 아이템 검색",
  description:
    "Slack·Discord·Notion 등에서 정규화된 활동(message/task/change/doc/note)을 검색. type·system·domainKey·projectKey·기간(since)·텍스트(query)로 필터. " +
    "응답은 {rows:[…]} — 행에 snippet(400자)+body_length+매핑 배지(domains/projects)+parent_id 포함. " +
    "domainKey/projectKey 필터는 repo 를 함께 주면 그 repo 의 매핑만 본다(동명 key 의 repo 간 혼입 방지). " +
    "repo 단독 지정 시 '그 repo 에 매핑이 있는 아이템'으로 필터(구 버전의 silent no-op 와 다름 — 실필터). " +
    "기각(rejected)된 매핑은 배지/필터에서 기본 제외 — includeRejected:true 로만 노출. 최신순.",
  scope: "items",
  input: {
    // 문자열은 qstr(REST) 거동 미러링: trim + 길이 상한 — ' 피벗 ' 같은 입력이 표면별로 갈리지 않게.
    query: z.string().trim().max(200).optional().describe("제목/본문 텍스트 부분일치"),
    type: z.enum(["message", "task", "change", "doc", "note"]).optional(),
    system: z.string().trim().max(100).optional().describe("slack | discord | notion …"),
    repo: z.string().trim().max(200).optional().describe("매핑 필터를 이 repo 로 한정(예: main). 단독 지정 시 그 repo 에 매핑된 아이템만"),
    domainKey: z.string().trim().max(200).optional(),
    projectKey: z.string().trim().max(200).optional(),
    since: z.string().optional().describe("ISO8601 — 이 시각 이후만"),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(5000).default(0),
    includeRejected: z.boolean().optional().describe("기각된 매핑도 배지/필터에 포함(기본 false)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/items"],
      parse: (req) => ({
        query: qstr(req.query.q, "q", 200),
        system: qstr(req.query.system, "system", 100),
        type: qtype(req.query.type),
        repo: qstr(req.query.repo, "repo", 200),
        domainKey: qstr(req.query.domainKey, "domainKey", 200),
        projectKey: qstr(req.query.projectKey, "projectKey", 200),
        since: qiso(req.query.since),
        limit: qint(req.query.limit, "limit", 30, 1, 100),
        offset: qint(req.query.offset, "offset", 0, 0, 5000),
        includeRejected: req.query.includeRejected === "1",
      }),
    }],
  },
  handler: async (input: {
    query?: string; type?: string; system?: string; repo?: string;
    domainKey?: string; projectKey?: string; since?: string;
    limit?: number; offset?: number; includeRejected?: boolean;
  }) => ({ rows: await searchItemsUi(input) }),
};

// canonical = {item(중첩, body SQL 클램프, raw 영구 제외), domains, projects(rejected 기본 제외),
// thread:{ancestors,children}}. not-found 는 'item N 없음' throw → REST 404 / MCP isError
// (구 success-content {error:'not found'} 패턴 폐기).
const getItem: Capability = {
  name: "get_item",
  title: "아이템 상세",
  description:
    "아이템 1건의 상세 — {item, domains, projects, thread}. item.body 는 20k 클램프(full:true 면 600k), raw JSONB 는 미노출. " +
    "domains/projects 는 state/mapped_by/evidence 포함(기각된 행은 기본 제외 — includeRejected:true 로만 노출). " +
    "thread 는 부모 체인(ancestors)+직계 답글(children) — thread:false 로 생략 가능(토큰 절약). " +
    "없는 id 는 에러('item N 없음').",
  scope: "items",
  input: {
    id: z.number().int(),
    thread: z.boolean().default(true).describe("부모 체인/답글 포함 여부(기본 true)"),
    full: z.boolean().optional().describe("본문 클램프 해제(600k) — 대형 notion 문서 주의"),
    includeRejected: z.boolean().optional().describe("기각된 매핑도 포함(기본 false)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/items/:id"],
      parse: (req) => {
        if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, "id 는 숫자여야 합니다");
        return {
          id: Number(req.params.id),
          thread: true, // REST 는 항상 thread 포함(기존 shape byte-compat)
          full: req.query.full === "1",
          includeRejected: req.query.includeRejected === "1",
        };
      },
    }],
  },
  handler: async (input: { id: number; thread?: boolean; full?: boolean; includeRejected?: boolean }) => {
    const bodyLimit = input.full ? 600000 : 20000;
    const detail = await getItemUi(input.id, bodyLimit, { includeRejected: input.includeRejected });
    if (!detail) throw new Error(`item ${input.id} 없음`); // '없음' 토큰 → REST 404 / MCP isError
    if (input.thread === false) return detail; // 하네스 토큰 다이어트 — thread 생략
    const thread = await getItemThread(input.id);
    return { ...detail, thread };
  },
};

export const itemCapabilities: Capability[] = [searchItems, getItem];

// context 그룹 capability — domainmap(canonical 맵) 읽기 + repo/통계 통합 op.
// Stage⑥: 엔진 흡수 — 구 HTTP 프록시(dmGet) 대신 src/domainmap/core/queries 직결.
// 응답 shape 는 byte-compat(직렬화 표면 동일 — pg Date 는 res.json/MCP JSON.stringify 에서 동일 ISO).
// 에러 표면도 dmRead 가 구 dmGet 엔벨로프('domainmap <status> <path>: …')를 재현 — 미검증 repo 등
// 기존 502 표면화 거동 불변. 큐레이션(제안→확정, 부채 상태변경 등)은 domainmap-curation 그룹.
import { z } from "zod";
import { dmRead } from "./domainmap-compat.js";
import { resolveRepo } from "../domainmap/core/types.js";
import { listRepos, overview, listDomainsApi, domainDetail, listProjectsApi, listDebts, listEntitiesApi } from "../domainmap/core/queries.js";
import { listMappingRepos, uiStats } from "../items/store.js";
import type { Capability } from "./types.js";
import { DM_KINDS, HttpError } from "./rest-util.js";

const enc = encodeURIComponent;

// repo 목록 — 모든 repo 셀렉터의 단일 소스(domainmap ∪ 매핑테이블, 하드코딩 금지).
// domainmap DB 가 죽어도 매핑테이블 쪽 repo 로 동작하도록 부분 성공을 허용(에러는 필드로 노출).
// canonical = 기존 REST union shape — MCP 도 raw 배열이 아니라 이 객체를 반환한다(THE source).
const repoList: Capability = {
  name: "repo_list",
  title: "매핑된 레포 목록",
  description:
    "레포 목록의 union — domainmap 에 매핑된 레포(domainmapRepos) ∪ item 매핑테이블에 등장하는 레포(mappingRepos), " +
    "합집합은 repos. domainmap 다운 시에도 부분 성공(domainmapError 필드). 다른 도메인/프로젝트 툴의 repo 이름을 찾을 때 먼저 호출. " +
    "각 domainmapRepos 항목은 clone_url(자격증명 제거된 git clone 주소, 미설정 시 null) 을 포함 — 소스가 로컬에 없으면 이 주소로 클론한다(접근 인증은 멤버 본인의 GitHub 자격증명).",
  scope: "context",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/repos"], parse: () => ({}) }] },
  handler: async () => {
    let domainmapRepos: unknown[] = [];
    let domainmapError: string | null = null;
    try {
      // pg status 에러는 dmRead 가 구 dmGet 엔벨로프로 감싼다 — domainmapError 필드 거동 보존.
      const raw = await dmRead("/api/repos", () => listRepos());
      domainmapRepos = Array.isArray(raw) ? raw : [];
    } catch (err) {
      domainmapError = `domainmap 에 연결하지 못했습니다 — ${(err as Error).message}`;
    }
    const mappingRepos = await listMappingRepos(); // rejected-only repo 제외 버전
    const names = new Set<string>(mappingRepos);
    for (const r of domainmapRepos) {
      if (typeof r === "string") names.add(r);
      else if (r && typeof (r as { name?: unknown }).name === "string") names.add((r as { name: string }).name);
    }
    return { domainmapRepos, mappingRepos, repos: [...names].sort(), domainmapError };
  },
};

// 레포 개요 — domainmap overview 에 items-store 통계를 'items' 필드로 흡수(MCP 단일 진입).
// REST 는 byte-compat 제약(/api/ui/stats 의 top-level UiStats shape) 때문에 subset 필드 items 를
// items_stats op 로 따로 서빙 — 파리티는 context_overview.items ≡ GET /api/ui/stats 로 검증.
// 주의: domainmap overview 가 미래에 'items' 필드를 추가하면 충돌(낮은 확률 — 그때 필드명 협상).
const contextOverview: Capability = {
  name: "context_overview",
  title: "레포 도메인 개요 + 아이템 통계",
  description:
    "레포의 도메인·프로젝트·부채 요약(domainmap overview) + items 필드로 아이템 스토어 통계" +
    "(소스/타입별 카운트, repo 별 매핑 커버리지, 최근 14일 KST 일별, 마지막 싱크). 코드베이스 맥락을 처음 잡을 때 먼저 호출하라.",
  scope: "context",
  input: { repo: z.string().optional() },
  expose: { mcp: true, rest: false },
  handler: async (input: { repo?: string }, user) => {
    const r = resolveRepo(input.repo);
    // items 통계는 'items' 스코프 보유자에게만(없으면 items:null) — 같은 데이터가 REST
    // /api/ui/stats 에선 items 스코프를 요구하므로 표면 간 인가 비대칭 제거(co-exposed 일관성).
    const wantItems = (user.scopes ?? []).includes("items");
    // domainmap 다운 시 throw 유지(코어 데이터) — repo_list 와 달리 부분 성공 없음.
    const [ov, items] = await Promise.all([
      dmRead(`/api/repo/${enc(r)}/overview`, () => overview(r)),
      wantItems ? uiStats() : Promise.resolve(null),
    ]);
    return { ...(ov as Record<string, unknown>), items };
  },
};

// 아이템 스토어 통계 — REST 전용(/api/ui/stats byte-compat). context_overview 가 items 필드로
// embed 하는 것과 동일한 단일 uiStats() 를 공유한다(파리티의 근거).
const itemsStats: Capability = {
  name: "items_stats",
  title: "아이템 스토어 통계",
  description: "아이템 스토어 개요 통계(uiStats) — REST /api/ui/stats 전용. MCP 는 context_overview.items 로 동일 객체를 본다.",
  scope: "items",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/stats"], parse: () => ({}) }] },
  handler: async () => uiStats(),
};

const domainList: Capability = {
  name: "domain_list",
  title: "도메인 목록",
  description: "비즈니스 도메인 분류 목록. query 를 주면 key/name 소문자 부분일치로 필터.",
  scope: "context",
  input: { repo: z.string().optional(), query: z.string().optional() },
  expose: { mcp: true, rest: false },
  handler: async (input: { repo?: string; query?: string }) => {
    // query 필터는 핸들러 소속(툴 계층 아님) — REST 노출해도 동일 결과 보장.
    const r = resolveRepo(input.repo);
    const rows = await dmRead(`/api/repo/${enc(r)}/domains`, () => listDomainsApi(r));
    if (input.query && Array.isArray(rows)) {
      const ql = input.query.toLowerCase();
      return rows.filter((d) => `${d.key ?? ""} ${d.name ?? ""}`.toLowerCase().includes(ql));
    }
    return rows;
  },
};

const domainGet: Capability = {
  name: "domain_get",
  title: "도메인 상세",
  description: "한 도메인의 상세 — 매핑된 코드/데이터 엔티티 포함. 도메인↔코드↔DB테이블 추적에 사용(이후 db_query 와 연계).",
  scope: "context",
  input: { id: z.number().int(), repo: z.string().optional() },
  expose: { mcp: true, rest: false },
  handler: async (input: { id: number; repo?: string }) => {
    const r = resolveRepo(input.repo);
    return dmRead(`/api/repo/${enc(r)}/domain/${input.id}`, () => domainDetail(r, input.id));
  },
};

const projectList: Capability = {
  name: "project_list",
  title: "프로젝트 목록",
  description: "프로젝트(이니셔티브)와 상태.",
  scope: "context",
  input: { repo: z.string().optional() },
  expose: { mcp: true, rest: false },
  handler: async (input: { repo?: string }) => {
    const r = resolveRepo(input.repo);
    return dmRead(`/api/repo/${enc(r)}/projects`, () => listProjectsApi(r));
  },
};

const debtList: Capability = {
  name: "debt_list",
  title: "도메인 부채 목록",
  description: "도메인 부채(debt) 항목과 상태.",
  scope: "context",
  input: { repo: z.string().optional() },
  expose: { mcp: true, rest: false },
  handler: async (input: { repo?: string }) => {
    const r = resolveRepo(input.repo);
    return dmRead(`/api/repo/${enc(r)}/debts`, () => listDebts(r));
  },
};

// domainmap 읽기 — kind 화이트리스트(구 프록시 시절 오픈 프록시 차단 규약 유지). UI 전용(REST only).
// 화이트리스트에 debts 없음(기존 그대로 — 표면 동결, 추가 금지).
const DM_KIND_FN: Record<string, (repo: string) => Promise<unknown>> = {
  domains: listDomainsApi,
  projects: listProjectsApi,
  entities: listEntitiesApi,
  overview,
};
// code 는 DM_KINDS 밖(표면 동결) — queue/code 읽기는 코어(core/queries.ts)에만 존재한다(그쪽 주석 참조).

const domainmapProxy: Capability = {
  name: "domainmap_proxy",
  title: "domainmap 읽기 프록시",
  description: "domainmap repo/:kind 읽기 (kind ∈ domains|projects|entities|overview) — 웹 UI 전용.",
  scope: "context",
  input: { repo: z.string(), kind: z.string() },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/:repo/:kind"],
      parse: (req) => {
        const { repo, kind } = req.params;
        if (!DM_KINDS.has(kind)) throw new HttpError(400, `kind 는 ${[...DM_KINDS].join("|")} 만 허용됩니다`);
        // repo 는 기존대로 raw passthrough — 미검증 repo 는 dmRead 엔벨로프('domainmap 404 …')로
        // 기존과 동일하게 502 표면화. TODO(표면 동결 해제 시): parseRepo(REPO_RE)로 잠가 신구 검증 일치.
        return { repo, kind };
      },
    }],
  },
  handler: async (input: { repo: string; kind: string }) => {
    const fn = DM_KIND_FN[input.kind];
    if (!fn) throw new HttpError(400, `kind 는 ${[...DM_KINDS].join("|")} 만 허용됩니다`);
    return dmRead(`/api/repo/${enc(input.repo)}/${input.kind}`, () => fn(input.repo));
  },
};

export const contextCapabilities: Capability[] = [
  repoList, contextOverview, itemsStats, domainList, domainGet, projectList, debtList, domainmapProxy,
];

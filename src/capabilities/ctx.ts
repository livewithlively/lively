// FS형 컨텍스트 capability (ctx_*) — P1b. 하네스가 통합 지식스토어(knowledge_unit)를 파일시스템
// 메타포(ls/grep/cat/save)로 다룬다. 전부 scope='memory' + co-exposed(mcp:true & REST) —
// MCP 와 REST 가 같은 handler 를 공유해 **구조화 JSON** 을 동일 페이로드로 반환한다(parity deep-equal 가능).
//  ↔ 구 memory_*(tools/memory.ts)는 한국어 텍스트 반환이라 deep-equal 불가했음 — ctx_* 는 JSON 반환으로 정합.
// 데이터층은 P1a(org/knowledge.ts) 위임: confidence·lifecycle 은 서버강제(입력 금지), 쓰기는
//  assertNoHardSecrets + audit + version+1. 입력 검증은 어댑터 경계(MCP=zod input / REST=mount.parse).
import { z } from "zod";
import { getKnowledge, knowledgeThread, listKnowledge, overviewKnowledge, searchKnowledge, setLifecycle, upsertKnowledge } from "../org/knowledge.js";
import { listAllDomains } from "../domainmap/core/queries.js";
import { assertNoHardSecrets } from "../org/redact.js";
import type { Capability, CapabilityCtx, RestMount } from "./types.js";
import { HttpError, qstr, qint, qiso, qtype } from "./rest-util.js";
import type { LivelyUser } from "../context.js";

// co-exposed 헬퍼 — mcp:true + REST 마운트를 한 번에 선언(delivery 의 restOnly 류는 mcp:false 전용이라 별도).
//  scope 는 전부 'memory'. handler 본문은 도메인 로직만(스코프 게이트는 어댑터가 처리).
function coExposed(
  name: string, title: string, description: string,
  input: Capability["input"], rest: RestMount[], handler: Capability["handler"],
): Capability {
  return { name, title, description, scope: "memory", input, expose: { mcp: true, rest }, handler };
}

// lifecycle enum — 입력 검증 1곳(zod) + REST parse 재사용.
const LIFECYCLES = new Set(["active", "rejected", "superseded"]);
type Lifecycle = "active" | "rejected" | "superseded";

// REST lifecycle 파싱 — qstr 후 화이트리스트(byte-compat 한국어 메시지, wrap 이 400 매핑).
function qlifecycle(v: unknown): Lifecycle | undefined {
  const s = qstr(v, "lifecycle", 16);
  if (s === undefined) return undefined;
  if (!LIFECYCLES.has(s)) throw new HttpError(400, `lifecycle 은 ${[...LIFECYCLES].join("|")} 만 허용됩니다`);
  return s as Lifecycle;
}

// REST source 파싱 — observed|authored 화이트리스트(item 흡수 필터). 위반은 400.
const SOURCES = new Set(["observed", "authored"]);
function qsource(v: unknown): string | undefined {
  const s = qstr(v, "source", 16);
  if (s === undefined) return undefined;
  if (!SOURCES.has(s)) throw new HttpError(400, `source 는 ${[...SOURCES].join("|")} 만 허용됩니다`);
  return s;
}

// path 접두 파생(단순 파싱) — 'K/' → {kind:'K'}, 'D/billing/' → {kind:'D', domain:'billing'}.
//  명시 kind/domain 인자가 우선(path 는 보조). 슬래시 분해 후 첫 토큰=kind, 둘째=domain.
function parsePath(path: string | undefined): { kind?: string; domain?: string } {
  if (!path) return {};
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  const out: { kind?: string; domain?: string } = {};
  if (parts[0]) out.kind = parts[0].slice(0, 2);
  if (parts[1]) out.domain = parts[1].slice(0, 100);
  return out;
}

// 슬러그 생성 — memory_save(toSlug)와 동일 규약. title/note ASCII kebab, 한글/특수문자뿐이면 hash 폴백.
function toSlug(seed: string): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (base && /^[a-z0-9]/.test(base)) return base;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return "mem-" + h.toString(36);
}

// ── ctx_ls — listKnowledge 위임(kind/domain/lifecycle 필터 + path 접두 파생). limit 은 핸들러에서 slice. ──
const ctxLs = coExposed(
  "ctx_ls",
  "컨텍스트 목록(ls)",
  "통합 지식스토어를 파일시스템처럼 나열한다. path 접두('K/' 'D/billing/')로 kind/domain 을 파생하거나 인자로 직접 필터. " +
    "본문 없이 메타(name/kind/title/domain/lifecycle/updated_at)만 — 본문은 ctx_cat 으로. " +
    "활동(외부 미러)도 흡수: system(slack/clickup/notion)·since(occurred_at 이후)·source(observed=미러만/authored=저작만)·type(message/task/change/doc/note) 필터(구 search_items 대체).",
  {
    path: z.string().max(256).optional(),
    kind: z.string().max(2).optional(),
    domain: z.string().max(100).optional(),
    lifecycle: z.enum(["active", "rejected", "superseded"]).optional(),
    confidence: z.string().max(16).optional(),
    system: z.string().max(100).optional().describe("external_system 필터(slack | clickup | notion …)"),
    since: z.string().max(64).optional().describe("ISO8601 — occurred_at 이 시각 이후만"),
    source: z.enum(["observed", "authored"]).optional().describe("observed=커넥터 미러만 / authored=저작물만"),
    type: z.enum(["message", "task", "change", "doc", "note"]).optional().describe("원 활동 type(fields._item_type)"),
    limit: z.number().int().min(1).max(200).default(100),
  },
  [{
    method: "GET",
    paths: ["/api/ui/ctx/ls"],
    parse: (req) => ({
      path: qstr(req.query.path, "path", 256),
      kind: qstr(req.query.kind, "kind", 2),
      domain: qstr(req.query.domain, "domain", 100),
      lifecycle: qlifecycle(req.query.lifecycle),
      confidence: qstr(req.query.confidence, "confidence", 16),
      system: qstr(req.query.system, "system", 100),
      since: qiso(req.query.since),
      source: qsource(req.query.source),
      type: qtype(req.query.type),
      limit: qint(req.query.limit, "limit", 100, 1, 200),
    }),
  }],
  async (input: { path?: string; kind?: string; domain?: string; lifecycle?: Lifecycle; confidence?: string; system?: string; since?: string; source?: string; type?: string; limit?: number }) => {
    const fromPath = parsePath(input.path);
    const kind = input.kind ?? fromPath.kind ?? null;     // 명시 인자 우선, path 는 보조
    const domainKey = input.domain ?? fromPath.domain ?? null;
    const limit = input.limit ?? 100;
    const rows = await listKnowledge({
      kind, domainKey, lifecycle: input.lifecycle ?? null, confidence: input.confidence ?? null,
      system: input.system ?? null, since: input.since ?? null, source: input.source ?? null, itemType: input.type ?? null,
    });
    const entries = rows.slice(0, limit).map((u) => ({
      name: u.name, kind: u.kind, title: u.title, domain_key: u.domain_key,
      lifecycle: u.lifecycle, confidence: u.confidence, updated_at: u.updated_at,
    }));
    return { entries, count: entries.length };
  },
);

// ── ctx_grep — searchKnowledge 위임(ILIKE title/body + kind/domain 필터, 스니펫 240자). ──
const ctxGrep = coExposed(
  "ctx_grep",
  "컨텍스트 검색(grep)",
  "통합 지식스토어를 제목/본문 텍스트로 검색한다(부분일치). 결과는 **스니펫(잘림)** — 전문은 결과 name 으로 ctx_cat. " +
    "활동(외부 미러)도 흡수: system·since·source(observed/authored)·type 필터(구 search_items 대체).",
  {
    query: z.string().min(1),
    kind: z.string().max(2).optional(),
    domain: z.string().max(100).optional(),
    system: z.string().max(100).optional().describe("external_system 필터(slack | clickup | notion …)"),
    since: z.string().max(64).optional().describe("ISO8601 — occurred_at 이 시각 이후만"),
    source: z.enum(["observed", "authored"]).optional().describe("observed=커넥터 미러만 / authored=저작물만"),
    type: z.enum(["message", "task", "change", "doc", "note"]).optional().describe("원 활동 type(fields._item_type)"),
    limit: z.number().int().min(1).max(50).default(10),
  },
  [{
    method: "GET",
    paths: ["/api/ui/ctx/grep"],
    parse: (req) => {
      const query = qstr(req.query.query, "query", 1000);
      if (!query) throw new HttpError(400, "query 필수");
      return {
        query,
        kind: qstr(req.query.kind, "kind", 2),
        domain: qstr(req.query.domain, "domain", 100),
        system: qstr(req.query.system, "system", 100),
        since: qiso(req.query.since),
        source: qsource(req.query.source),
        type: qtype(req.query.type),
        limit: qint(req.query.limit, "limit", 10, 1, 50),
      };
    },
  }],
  async (input: { query: string; kind?: string; domain?: string; system?: string; since?: string; source?: string; type?: string; limit?: number }) => {
    // 통합 FS 뷰라 모든 kind(R 규칙/페르소나 포함) 검색 — 구 memory_search 는 R 제외(레거시 호환). 의도적 차이.
    const matches = await searchKnowledge({
      query: input.query, kind: input.kind ?? null, domainKey: input.domain ?? null,
      system: input.system ?? null, since: input.since ?? null, source: input.source ?? null, itemType: input.type ?? null,
      limit: input.limit ?? 10,
    });
    return { matches };
  },
);

// ── ctx_cat — getKnowledge 단건 라이브 하이드레이션(전체 필드). 없으면 {error}. ──
const ctxCat = coExposed(
  "ctx_cat",
  "컨텍스트 전문(cat)",
  "한 지식단위의 **전문(full body)** + 메타 전체를 name 으로 가져온다(ctx_grep 스니펫 잘림 없이). 없으면 error 필드. " +
    "thread:true 면 외부 미러 활동의 스레드(ancestors 부모체인 + children 직계답글, parent_name 재귀)도 포함(구 get_item.thread 대체).",
  { name: z.string().min(1).max(64), thread: z.boolean().optional().describe("스레드(부모체인/답글) 포함 — 기본 false") },
  [{
    method: "GET",
    paths: ["/api/ui/ctx/cat"],
    parse: (req) => {
      const name = qstr(req.query.name, "name", 64);
      if (!name) throw new HttpError(400, "name 필수");
      return { name, thread: req.query.thread === "1" };
    },
  }],
  async (input: { name: string; thread?: boolean }) => {
    const unit = await getKnowledge(input.name);
    // 부재는 get_item 과 동일 계약으로 404(throw) — REST=404 / MCP=isError, 양 어댑터 일관.
    if (!unit) throw new HttpError(404, `없음: '${input.name}' (name 확인 — ctx_ls/ctx_grep 결과의 name)`);
    if (!input.thread) return unit; // 기본: 스레드 생략(토큰 절약)
    const thread = await knowledgeThread(input.name);
    return { ...unit, thread };
  },
);

// ── ctx_save — 신규 쓰기경로. memory_save 가드 정합: slug 자동생성/검증 · assertNoHardSecrets ·
//    domain 존재검증(fail-open) · confidence='ai' 서버강제(upsertKnowledge source='mcp'). ──
const ctxSave = coExposed(
  "ctx_save",
  "컨텍스트 저장(save)",
  "통합 지식스토어(ku)에 한 콜로 전문 저장한다(조직 지식의 유일한 집 — 레포 .md 새로 만들지 말 것). 지속될 지식이 " +
    "생기면 그 자리에서(in-flow) 요약이 아닌 **전문**을 담는다. name 생략 시 제목/본문에서 자동 생성, 같은 name 재지정 시 갱신. " +
    "분류(판단): kind = R(강제규칙·페르소나)·K(지식·산출물, 기본)·H(절차·런북)·W(작업). area = domain 인자로 지정(통제어휘 — " +
    "주입된 area 지도의 key). 외부(클릭업·노션·코드)는 복제 금지 — 미러(observed)로 두고 파생 인사이트만 K 로 저작. " +
    "출처(provenance, 컬럼 confidence)·lifecycle 은 서버가 채널로 강제하므로 입력하지 않는다(MCP→ai / 웹→human).",
  {
    note: z.string().min(1).max(40000),
    title: z.string().max(200).optional(),
    kind: z.string().max(2).optional(),
    kinds: z.array(z.string().max(2)).max(8).optional(),
    domain: z.string().max(100).optional(),
    name: z.string().max(64).optional(),
    supersedes: z.string().max(64).optional(),
  },
  [{
    method: "POST",
    paths: ["/api/ui/ctx/save"],
    parse: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const note = qstr(body.note, "note", 40000);
      if (!note) throw new HttpError(400, "note 필수");
      let kinds: string[] | undefined;
      if (body.kinds !== undefined && body.kinds !== null) {
        if (!Array.isArray(body.kinds)) throw new HttpError(400, "kinds 는 배열이어야 합니다");
        if (body.kinds.length > 8) throw new HttpError(400, "kinds 는 8개 이하여야 합니다");
        kinds = body.kinds.map((k) => qstr(k, "kinds[]", 2)).filter((k): k is string => !!k);
      }
      return {
        note,
        title: qstr(body.title, "title", 200),
        kind: qstr(body.kind, "kind", 2),
        kinds,
        domain: qstr(body.domain, "domain", 100),
        name: qstr(body.name, "name", 64),
        supersedes: qstr(body.supersedes, "supersedes", 64),
      };
    },
  }],
  async (
    input: { note: string; title?: string; kind?: string; kinds?: string[]; domain?: string; name?: string; supersedes?: string },
    user: LivelyUser,
    ctx?: CapabilityCtx,
  ) => {
    // 신규 쓰기경로 — 평문 시크릿은 저장 자체를 거부(hard-block).
    assertNoHardSecrets(input.note, "note");

    // 도메인: 지정되면 통제어휘 엄격 검증(V5 탈-repo) — 전 repo·전 space 통합 domain_list(listAllDomains)에
    //  없는 key 는 거부. domain 귀속은 repo-비의존(business 는 repo 없는 조직평면, product 도 key 만으로 귀속).
    //  graceful: domainmap 다운/빈 목록이면 약결합 슬러그라 저장은 진행(가용성 우선).
    //  space 모호: 같은 key 가 product·business 양쪽에 있으면(현 라이브 0건) 비결정 — 거부하고 명시 요구.
    let domainKey: string | null = null;
    if (input.domain) {
      let domains: Awaited<ReturnType<typeof listAllDomains>> | null = null;
      try { domains = await listAllDomains(); } catch { domains = null; }
      if (domains && domains.length) {
        const matches = domains.filter((d) => d.key === input.domain);
        if (!matches.length) throw new Error(`도메인 '${input.domain}' 없음. domain_list 로 확인하세요.`);
        if (matches.length > 1) {
          throw new Error(`도메인 '${input.domain}' 가 여러 space(${matches.map((m) => m.space).join("/")})에 있어 모호합니다 — 고유 key 로 지정하세요.`);
        }
      }
      domainKey = input.domain;
    }

    // 이름: 주어지면 검증, 아니면 title|note 슬러그(자동생성끼리 충돌 시 -2.. 증가).
    let name: string;
    if (input.name) {
      name = input.name.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
        throw new Error("name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
      }
    } else {
      const baseSlug = toSlug(input.title || input.note);
      name = baseSlug;
      for (let i = 2; await getKnowledge(name); i++) {
        if (i >= 1000) throw new Error("이름 자동생성 실패(동일 슬러그 과다) — name 인자로 직접 지정하세요");
        name = `${baseSlug}-${i}`;
      }
    }

    // confidence 는 어댑터 source 로 서버강제(mcp→ai / web→human, knowledge.confidenceFor). lifecycle 은 upsert 기본 'active'.
    const saved = await upsertKnowledge({
      name,
      kind: input.kind ?? "K",
      kinds: input.kinds,
      title: input.title ?? null,
      body_md: input.note,
      domain_key: domainKey,
      domain_repo: null, // V5 탈-repo: 도메인 귀속은 key 만(repo-비의존). domain_repo 컬럼은 더 안 채운다.
      supersedes: input.supersedes ?? null,
    }, user.userId, ctx?.source ?? "mcp");

    return { saved: { name: saved.name, kind: saved.kind, domain_key: saved.domain_key, lifecycle: saved.lifecycle, version: saved.version } };
  },
);

// ── ctx_overview — kind_registry × active knowledge_unit 집계(웹 UI 대시보드용). overviewKnowledge 위임. ──
const ctxOverview = coExposed(
  "ctx_overview",
  "컨텍스트 개요(overview)",
  "통합 지식스토어를 종류(kind)별로 집계한다 — 각 종류의 active 단위 수(저작물, 출처=observed 제외)·최신 갱신시각, " +
    "전체 active 합, Review 대기 수(AI 생성 active = 출처 'ai'), 외부 미러 수(observed_count = 커넥터 미러). " +
    "검토 큐는 출처(provenance)='ai' 라 observed(외부 미러)는 자연 제외된다. 대시보드/리뷰 진입점.",
  {},
  [{
    method: "GET",
    paths: ["/api/ui/ctx/overview"],
    parse: () => ({}),
  }],
  async () => overviewKnowledge(),
);

// ── ctx_set_lifecycle — lifecycle 만 전환(사람의 사후 반려/복원 — 신뢰우선 모델). setLifecycle 위임. ──
//  없는 name → setLifecycle 이 '없음' throw(REST=404 / MCP isError), 잘못된 lifecycle 은 zod/parse 단계에서 거부(400).
const ctxSetLifecycle = coExposed(
  "ctx_set_lifecycle",
  "컨텍스트 상태전환(set-lifecycle)",
  "한 지식단위의 lifecycle 만 전환한다(active=유효·rejected=반려·superseded=대체). 본문/메타는 불변 — " +
    "사람이 에이전트 생산물을 사후 반려하거나 복원하는 경로(신뢰우선: 저장은 무게이트, 반려는 사후).",
  {
    name: z.string().min(1).max(64),
    lifecycle: z.enum(["active", "rejected", "superseded"]),
  },
  [{
    method: "POST",
    paths: ["/api/ui/ctx/set-lifecycle"],
    parse: (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = qstr(body.name, "name", 64);
      if (!name) throw new HttpError(400, "name 필수");
      const lifecycle = qlifecycle(body.lifecycle); // 화이트리스트 위반 시 '허용' 400
      if (!lifecycle) throw new HttpError(400, "lifecycle 필수");
      return { name, lifecycle };
    },
  }],
  async (input: { name: string; lifecycle: Lifecycle }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const saved = await setLifecycle(input.name, input.lifecycle, user.userId, ctx?.source ?? "web");
    return { name: saved.name, lifecycle: saved.lifecycle, version: saved.version };
  },
);

export const ctxCapabilities: Capability[] = [ctxLs, ctxGrep, ctxCat, ctxSave, ctxOverview, ctxSetLifecycle];

// 컨텍스트 라우팅(recall) — #637. 작업맥락(프롬프트 텍스트 + 최근 Read 파일경로)으로
//  (a) 프롬프트 도메인 키워드 → 그 도메인 HUB 지식 포인터, (b) 열린 코드파일 → 그 파일이 속한
//  도메인 leaf 지식 포인터 를 라우팅한다. 주입은 훅이 포맷(여기선 포인터 목록만 결정론적으로 반환).
//
// 설계 근거: recall-637-최종설계-확정-실측기반 (실박스 실측).
//  - (a) = 명시/리터럴 매칭(시맨틱 아님) — 도메인별 term-index를 category.key/name + 매핑된
//    code_unit 모듈 basename 에서 자동 유도(수동 큐레이션 없음). 12도메인 중 대출·투자군이 의미상
//    인접해 시맨틱 질량게이팅은 bleed 위험 → 리터럴 1차(고정밀·결정론·무latency). (담당자 wiki-router 등가.)
//  - (b) = 라이블리 code_unit↔category 매핑 위 MODULE 최장-조상-prefix 매칭. 고객사 A code_unit 이
//    모듈단위(repo-relative path)로 매핑돼 리프 Read 는 항상 exact-miss → prefix 매칭이 주경로.
//  - 페이로드 = 본문 아니라 포인터(name+title). 세션 dedup(exclude). 캡(HUB≤2·leaf≤3).
//  - 불변식: 인덱스 쿼리(UNIQUE(repo_id,path)·category 필터)·스캔 금지·레포/도메인 무하드코딩·
//    graceful(매핑0=(b) no-op, 지식0=should만, 임베딩off=(a) 리터럴만).
import { q, itemsPool } from "../db/client.js";
import { findRecommendedKnowledge, knowledgeVisWhere } from "./knowledge-store.js";
import type { Viewer } from "./visibility.js";

// ─────────────────────────── 순수 헬퍼 (DB 불요 — recall-router.test.ts 가 잠금) ───────────────────────────

// term-index·경로세그먼트에서 버리는 제네릭 토큰. 모듈 스캐폴딩/언어/빌드 단어는 도메인 변별력이 없다.
//  (고객사 A 실측: aml-app·credit-facade·bond-domain 처럼 basename 앞토큰이 변별자, 뒤는 대개 제네릭.)
export const RECALL_STOPWORDS: ReadonlySet<string> = new Set<string>([
  "domain", "application", "app", "api", "lib", "library", "facade", "core", "server", "client",
  "common", "infra", "util", "utils", "service", "services", "consumer", "sender", "producer",
  "module", "main", "test", "tests", "src", "kotlin", "java", "async", "proxy", "socket", "web",
  "integration", "management", "platform", "system", "manager", "handler", "helper", "config",
  "the", "and", "for", "with", "code", "data", "model", "store", "repo", "backend", "frontend",
]);

// 식별자/이름을 토큰으로 — 영문·숫자·한글 청크만 남긴다(경계문자 -_/.·공백 등에서 분할).
export function tokenizeTerm(s: string): string[] {
  return (s || "").split(/[^A-Za-z0-9가-힣]+/).map((t) => t.trim()).filter(Boolean);
}

// 유용한 term 인가 — 2자 이상, 제네릭/순수숫자 제외.
function isUsefulTerm(t: string): boolean {
  return t.length >= 2 && !/^[0-9]+$/.test(t) && !RECALL_STOPWORDS.has(t);
}

// 도메인 1개의 term-index 유도 — category.key(토큰) + name(한글 통째 + 토큰) + 매핑 모듈 basename(토큰).
//  전부 소문자. 수동 키워드 큐레이션 없이 도메인맵에서 파생(담당자 kw/ac 의 라이블리판).
export function deriveDomainTerms(d: { key: string; name?: string | null; unitPaths?: string[] }): string[] {
  const out = new Set<string>();
  for (const t of tokenizeTerm(d.key)) { const x = t.toLowerCase(); if (isUsefulTerm(x)) out.add(x); }
  if (d.name) {
    for (const t of tokenizeTerm(d.name)) { const x = t.toLowerCase(); if (isUsefulTerm(x)) out.add(x); }
    // 한글 도메인명 통째(공백없는 복합어) — 프롬프트가 정확히 그 이름을 포함하면 매칭. 과매칭 방지로 20자 이하.
    const nm = d.name.trim().toLowerCase();
    if (/[가-힣]/.test(nm) && nm.length >= 2 && nm.length <= 20) out.add(nm);
  }
  for (const p of d.unitPaths ?? []) {
    const base = (p.split("/").pop() || p).replace(/\.[A-Za-z0-9]{1,8}$/, ""); // 확장자 제거(파일단위 매핑 box 대비)
    for (const t of tokenizeTerm(base)) { const x = t.toLowerCase(); if (isUsefulTerm(x)) out.add(x); }
  }
  return [...out];
}

// 순수 ascii 식별자(길이≥3)면 단어경계 매칭(aml 이 small 에 안 걸리게), 그 외(한글 등)는 부분문자열.
//  담당자: kw=부분문자열 includes, ac=단어경계 정규식 — 그 구분의 자동판정판.
function termHits(text: string, term: string): boolean {
  if (/^[a-z][a-z0-9]{2,}$/.test(term)) {
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  }
  return text.includes(term);
}

// (a) 프롬프트 → 히트 도메인. score = 매칭된 distinct term 수(다중토큰 매칭일수록 상위). 결정론·리터럴.
export function matchDomainsByText(
  text: string,
  domains: { id: number; terms: string[] }[],
): { id: number; matched: string[] }[] {
  const lc = (text || "").toLowerCase();
  if (!lc.trim()) return [];
  const hits: { id: number; matched: string[] }[] = [];
  for (const d of domains) {
    const matched = d.terms.filter((t) => termHits(lc, t));
    if (matched.length) hits.push({ id: d.id, matched });
  }
  hits.sort((a, b) => b.matched.length - a.matched.length || a.id - b.id);
  return hits;
}

// 절대경로에서 (repo, repo상대경로) 추출 — 알려진 repo 이름이 경로 세그먼트로 처음 등장하는 지점 기준.
//  member 머신마다 체크아웃 위치가 달라 repo.root_path 는 못 믿는다 → 세그먼트 매칭(경로-무관, 담당자식).
export function pickRepoRelpath(
  absPath: string,
  repoNames: readonly string[],
): { repo: string; relpath: string } | null {
  if (!absPath) return null;
  const segs = absPath.split("/").filter(Boolean);
  const set = new Set(repoNames);
  for (let i = 0; i < segs.length - 1; i++) {
    if (set.has(segs[i])) {
      const relpath = segs.slice(i + 1).join("/");
      if (relpath) return { repo: segs[i], relpath };
    }
  }
  return null;
}

// repo상대경로의 조상 prefix 집합(자기 자신 포함, 세그먼트 단위로 뒤에서 하나씩 제거).
//  code_unit 매핑이 모듈단위라 리프파일은 exact-miss → 이 prefix 들 중 최장 매칭이 모듈 code_unit.
//  경로길이(≤~20 세그먼트)로 바운드 — 별도 캡 불요.
export function ancestorPrefixes(relpath: string): string[] {
  const segs = (relpath || "").split("/").filter(Boolean);
  const out: string[] = [];
  for (let n = segs.length; n >= 1; n--) out.push(segs.slice(0, n).join("/"));
  return out;
}

// 매칭 후보 경로 — box 마다 code_unit.path 컨벤션이 다르다(고객사 A=repo-relative `domain/bond-domain`,
//  라이블리=repo-prefixed `context-ontology/src/..`). 둘 다 커버하도록 relpath 와 `<repo>/<relpath>` 양쪽의
//  조상 prefix 를 후보로 낸다(한 box 엔 한 컨벤션만 저장돼 교차오염 없음). repo 필터가 오탐을 막는다.
export function unitMatchCandidates(repo: string, relpath: string): string[] {
  return [...new Set<string>([...ancestorPrefixes(relpath), ...ancestorPrefixes(`${repo}/${relpath}`)])];
}

// 후보 code_unit 경로들 중 relpath 의 최장 조상 prefix 를 고른다(가장 구체적인 모듈).
export function longestPrefixPath(relpath: string, unitPaths: readonly string[]): string | null {
  const prefixes = new Set(ancestorPrefixes(relpath));
  let best: string | null = null;
  for (const p of unitPaths) {
    if (prefixes.has(p) && (best === null || p.length > best.length)) best = p;
  }
  return best;
}

// should 요지 한 줄 — 본문 아님(포인터 원칙). 첫 문단/문장을 max 자로.
export function gistLine(should: string | null | undefined, max = 140): string {
  if (!should) return "";
  const one = should.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max).replace(/\S*$/, "").trim() + "…";
}

// ─────────────────────────── DB 라우팅 ───────────────────────────

export interface RecallHub {
  category_id: number;
  category_key: string;
  category_name: string | null;
  should_gist: string;
  matched: string[];                                        // 어떤 term 이 걸려 라우팅됐나(디버그·설명용)
  index: { name: string; title: string | null; is_wiki: boolean }[];
}
export interface RecallLeaf {
  path: string;
  category_id: number;
  category_key: string;
  category_name: string | null;
  knowledge: { name: string; title: string | null; snippet?: string }[];
}
export interface RecallResult {
  hubs: RecallHub[];
  leaves: RecallLeaf[];
  semantic?: { name: string; title: string | null; similarity: number }[];
}
export interface RecallInput {
  text?: string;
  paths?: string[];
  exclude?: string[];
  budget?: { hubs?: number; leaves?: number };
  semantic?: boolean;
}

interface DomainRow { id: number; key: string; name: string | null; should: string | null; unit_paths: string[] }

// product 도메인 + 매핑된 code_unit 경로 — 2쿼리(카테고리 / 매핑유닛) 후 JS 그룹.
//  (json_agg FILTER 회피: 단순 SELECT 2개가 검증·이식 쉽고 도메인 수십개까지 상수 비용.)
async function loadDomains(): Promise<DomainRow[]> {
  const cats = await q(itemsPool,
    `SELECT id, key, name, should FROM category WHERE space='product' AND state<>'merged'`);
  if (!cats.length) return [];
  const units = await q(itemsPool, `
    SELECT m.category_id, cu.path
    FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
    WHERE m.target_kind='code_unit' AND m.status<>'rejected'
      AND COALESCE(cu.state,'active')='active' AND cu.path IS NOT NULL`);
  const byCat = new Map<number, string[]>();
  for (const u of units) {
    const arr = byCat.get(u.category_id) ?? [];
    arr.push(u.path as string); byCat.set(u.category_id, arr);
  }
  return cats.map((c) => ({ id: c.id, key: c.key, name: c.name, should: c.should, unit_paths: byCat.get(c.id) ?? [] }));
}

// 도메인 HUB 대표지식 인덱스 — wiki핀 우선 → 최신. 본문 아님(포인터). exclude(세션 dedup) 제외.
//  viewer(#1291): 포인터라도 **소환키와 제목**이라 그대로 새면 안 된다 — 이 결과는 훅이 세션 첫머리에 그대로 깐다.
async function hubIndex(categoryId: number, exclude: string[], limit: number, viewer?: Viewer) {
  const params: unknown[] = [categoryId, exclude, limit];
  const vis = await knowledgeVisWhere(viewer, params);
  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.is_wiki
    FROM knowledge k
    JOIN knowledge_category kc ON kc.name=k.name AND kc.state<>'rejected'
    WHERE kc.category_id=$1 AND k.lifecycle='active' AND NOT (k.name = ANY($2::text[])) AND ${vis}
    ORDER BY k.is_wiki DESC, k.updated_at DESC
    LIMIT $3`, params);
  return rows.map((r) => ({ name: r.name, title: r.title, is_wiki: !!r.is_wiki }));
}

// viewer(#1291) — 훅이 매 프롬프트마다 때리는 경로다. 여기가 안 막히면 잠긴 지식의 소환키가 남의 세션에 뿌려지고,
//  그 세션의 AI 가 그 이름으로 knowledge_get 을 부른다(거긴 막혀도, '그런 문서가 있다'는 이미 새어나간 뒤다).
export async function routeRecall(input: RecallInput, viewer?: Viewer): Promise<RecallResult> {
  const hubCap = Math.max(0, Math.min(input.budget?.hubs ?? 2, 5));
  const leafCap = Math.max(0, Math.min(input.budget?.leaves ?? 3, 10));
  const exclude = Array.isArray(input.exclude) ? input.exclude.slice(0, 500) : [];
  const seen = new Set<string>(exclude);                    // 이 응답 안에서도 도메인 간 중복 포인터 억제
  const result: RecallResult = { hubs: [], leaves: [] };

  let domains: DomainRow[] = [];
  try { domains = await loadDomains(); } catch { return result; } // 스키마/DB 이상 → fail-open(빈 결과)
  if (!domains.length) return result;

  // ── (a) 프롬프트 → HUB (리터럴) ──
  const text = (input.text ?? "").slice(0, 8000);
  if (text.trim() && hubCap > 0) {
    const termIndex = domains.map((d) => ({ id: d.id, terms: deriveDomainTerms(d) }));
    const hits = matchDomainsByText(text, termIndex);
    for (const h of hits.slice(0, hubCap)) {
      const d = domains.find((x) => x.id === h.id)!;
      const index = await hubIndex(d.id, [...seen], 5, viewer).catch(() => []);
      for (const it of index) seen.add(it.name);
      result.hubs.push({
        category_id: d.id, category_key: d.key, category_name: d.name,
        should_gist: gistLine(d.should), matched: h.matched, index,
      });
    }
  }

  // ── (b) 경로 → leaf (MODULE 최장-조상-prefix 매칭) ──
  const paths = Array.isArray(input.paths) ? input.paths.filter((p) => typeof p === "string").slice(0, 50) : [];
  if (paths.length && leafCap > 0) {
    let repoNames: string[] = [];
    try {
      repoNames = (await q(itemsPool, `SELECT name FROM repo WHERE name IS NOT NULL AND COALESCE(state,'active')='active'`))
        .map((r) => r.name as string);
    } catch { repoNames = []; }
    const catByUnitPath = new Map<string, number>();        // Read 한 파일의 절대경로 → category_id
    const domainByCat = new Map<number, DomainRow>(domains.map((d) => [d.id, d]));
    const orderedCats: number[] = [];                       // Read 순서 보존(최근이 앞) — dedup 하며 캡

    for (const abs of paths) {
      const rr = pickRepoRelpath(abs, repoNames);
      if (!rr) continue;
      const prefixes = unitMatchCandidates(rr.repo, rr.relpath); // repo-relative·repo-prefixed 양 컨벤션 커버
      if (!prefixes.length) continue;
      // repo명 + 조상 prefix 집합으로 매핑된 code_unit 을 인덱스 조회(스캔 아님) → 최장·매핑보유 선택.
      let rows: any[] = [];
      try {
        rows = await q(itemsPool, `
          SELECT cu.path, m.category_id
          FROM code_unit cu
          JOIN repo r ON r.id=cu.repo_id
          JOIN mapping m ON m.target_id=cu.id AND m.target_kind='code_unit' AND m.status<>'rejected'
          WHERE r.name=$1 AND cu.path = ANY($2::text[]) AND COALESCE(cu.state,'active')='active'
            AND m.category_id IS NOT NULL`, [rr.repo, prefixes]);
      } catch { rows = []; }
      if (!rows.length) continue;
      rows.sort((a, b) => String(b.path).length - String(a.path).length); // 최장 prefix = 가장 구체적 모듈
      const catId = rows[0].category_id as number;
      if (!domainByCat.has(catId)) continue;
      if (!orderedCats.includes(catId)) orderedCats.push(catId);
      catByUnitPath.set(abs, catId);
    }

    for (const catId of orderedCats.slice(0, leafCap)) {
      const d = domainByCat.get(catId)!;
      let recs: any[] = [];
      try {
        recs = await findRecommendedKnowledge({ text: text || undefined, categoryIds: [catId], exclude: [...seen], limit: 3 }, viewer);
      } catch { recs = []; }
      const knowledge = recs.map((r) => ({ name: r.name, title: r.title, snippet: r.snippet }));
      for (const k of knowledge) seen.add(k.name);
      const path = [...catByUnitPath.entries()].find(([, c]) => c === catId)?.[0] ?? "";
      result.leaves.push({
        path, category_id: catId, category_key: d.key, category_name: d.name, knowledge,
      });
    }
  }

  // ── (옵션) 시맨틱 지식 회수 — 구 prompt-similar 의 병존(요청 시). 카테고리 부스트로 랭킹. ──
  if (input.semantic && text.trim()) {
    try {
      const recs = await findRecommendedKnowledge({ text, exclude: [...seen], limit: 4, minScore: 0.6 }, viewer);
      result.semantic = recs.map((r) => ({ name: r.name, title: r.title, similarity: r.similarity }));
    } catch { /* fail-open */ }
  }

  return result;
}

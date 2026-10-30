// v6 knowledge 검색(#1313 R21 — knowledge-store 에서 분리) — grep(렉시컬)·하이브리드(RRF). 유사·추천은 knowledge-similar.ts.
//  분리 이유: CRUD 와 완전히 다른 관심사(질의 계획·벡터·랭킹)인데 한 파일에 있어 검색 튜닝 diff 가 저장 경로와
//  충돌했다. 공개 표면은 그대로 — knowledge-store.ts 가 이 모듈을 재수출하므로 기존 호출부는 무수정.
//  공용 조각(가시성 술어·아이콘 표현식)은 knowledge-common.ts, grep 매처·RRF 상수는 search-util.ts.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { toVectorLiteral } from "./embedding-provider.js";
import {
  type GrepPlan, parseGrep, parsePlainGrep, grepWhere, grepExec, grepSnippet, exactFirst, titleFirst,
  RRF_K, HYBRID_CANDIDATES, embedQuery, withHnswScan,
} from "./search-util.js";
import { type Viewer } from "./visibility.js";
import { parseQueryTerms, requiredTerms } from "./query-terms.js";   // #4744 검색 실패 보조 안내의 낱말 판정(군말 빼기)
import { knowledgeVisWhere, K_ICON_EXPR } from "./knowledge-common.js";
import { knowledgeCategoryRestriction, knowledgeInCategoriesSql } from "./read-scope.js";   // #5100 category 인자 · 앱 맥락 범위
import { bm25Sql, hasIdentifier, lexQueryTerms } from "./knowledge-lex.js";   // #5201 낱말 채널
import { lexReady } from "./knowledge-lex-store.js";

// grep 결과 SELECT — 전문(body_md)은 스니펫 계산용으로만 가져오고 응답에선 뺀다. 무관 메타(external_* 등)는 아예 미조회.
//  grep 매처(parseGrep/grepWhere)·스니펫 빌더(grepSnippet)는 search-util.ts 로 분리(#631, project 검색과 공유).
const K_GREP_SEL = ["name", "title", "body_md", "injection", "provenance", "is_wiki", "summary", "updated_at", "searchable"]
  .map((c) => "k." + c).join(", ") + `, ${K_ICON_EXPR}`;
// names 모드 — body_md 도 미조회(스니펫 불필요). 발견용 메타만(가장 얕게).
const K_GREP_NAMES_SEL = ["name", "title", "injection", "provenance", "is_wiki", "summary", "updated_at", "searchable"]
  .map((c) => "k." + c).join(", ") + `, ${K_ICON_EXPR}`;

// grep — title/body_md 매칭(정규식 또는 토큰 AND) → 매치 줄 스니펫(전문 X, body_md 미포함). 전문은 getKnowledge.
//  의미검색 아님(벡터는 추후 별도 도구). Postgres 가 정규식을 거부하면(JS 유효·POSIX 무효 드묾) 토큰 모드로 1회 폴백 — 에이전트에 에러 누출 안 함.
//  결과 행 = grep 발견에 필요한 얕은 필드만 + snippet(전문 누출·토큰폭주 방지).
export interface KnowledgeSearchRow {
  name: string; title: string | null;
  injection: string; provenance: string; is_wiki: boolean;
  summary: string | null; updated_at: string; snippet?: string;  // names 모드는 snippet 생략
  score?: number;  // 하이브리드 검색(knowledge_search)의 RRF 점수 — grep(searchKnowledge)은 미설정
  icon?: string | null;  // 페이지 아이콘(#657, props_ui->>'icon') — 검색 결과 행 표시용
  searchable?: boolean;  // #5169 사람 화면 호출(includeUnsearchable)에만 싣는다 — 화면이 «검색 제외» 표시를 그린다(에이전트 응답 모양은 그대로)
}
export type KnowledgeGrepMode = "snippets" | "names" | "count";
// 공통 WHERE(grep 매처 + lifecycle='active' + injection/provenance). params 에 push 하고 절 문자열 반환.
function grepWhereSql(plan: GrepPlan, opts: { injection?: string; provenance?: string; categories?: readonly number[] | null; includeUnsearchable?: boolean }, params: unknown[]): string {
  //  ⚠ **name(=key)도 본다** — grepWhereSql 은 grep·count·하이브리드의 렉시컬 채널이 **전부** 지나는 한 자리다.
  //   (2026-08-25: 같은 취지로 knowledge-store 의 *목록* 필터도 고쳤는데, 검색은 그 자리가 아니라 여기다 —
  //    고치고도 dev 에서 안 나아져서 잡았다. 지식 검색의 WHERE 는 이 함수 하나뿐이니 여기가 정본이다.)
  //   key 는 사람이 실제로 옮겨 적는 이름이다(위키링크 `[[key]]` · 주소 `#/k/<key>` · knowledge_get 인자).
  //   종전엔 key 로 찾으면 **그 key 를 본문에 인용한 다른 문서**만 나오고 정작 그 문서는 안 나왔다.
  //  #5169 검색 제외(searchable=false)는 여기서 뺀다 — grep·count·하이브리드 렉시컬이 모두 이 자리를 지난다(벡터 쪽은 rrfSearch).
  //   사람 화면(⌘K · 링크 고르기)만 includeUnsearchable 로 남긴다(KnowledgeSearchFilter 주석).
  return [grepWhere(["k.name", "k.title", "k.body_md"], plan, params), ...searchFilterSql(opts, params)].join(" AND ");
}

/** 낱말이 아닌 거르기(수명 · 검색 제외 · 주입 · 출처 · 카테고리) — grep 과 BM25 낱말 채널이 같은 조건으로 후보를 고른다. */
function searchFilterSql(opts: { injection?: string; provenance?: string; categories?: readonly number[] | null; includeUnsearchable?: boolean }, params: unknown[]): string[] {
  const wh: string[] = [`k.lifecycle='active'`];
  if (!opts.includeUnsearchable) wh.push(`k.searchable`);
  if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
  //  #5100 카테고리 제한(category 인자 ∩ 앱 맥락 범위 — knowledgeCategoryRestriction). 후보를 고르는 이 자리에서 건다 —
  //   하이브리드의 렉시컬 후보(상위 N)가 제한 밖 문서로 채워지면 최종 술어만으로는 결과가 빈다.
  if (opts.categories) wh.push(knowledgeInCategoriesSql(opts.categories, params, "k"));
  return wh;
}

/** 어떤 길로 찾았나(#5201) — 기록(knowledge_search_log)이 호출마다 남긴다. */
export type KnowledgeSearchRoute = "hybrid" | "hybrid-grep" | "lexical" | "grep" | "bm25-order";
export interface SearchRouteDiag { route?: KnowledgeSearchRoute }

/**
 * 이 찾기가 쓸 BM25 낱말(#5201) — 쓸 수 없으면 null.
 *  사람 화면(plain · includeUnsearchable)은 글자 그대로 찾는 약속이고 색인에 없는 검색 제외 문서도 찾으므로 종전 길이다.
 *  색인이 덜 찼으면(lexReady) 종전 grep 채널로 간다 — 찾을 수 있던 문서가 잠깐 안 나오면 안 된다.
 */
async function bm25Terms(qstr: string, opts: { plain?: boolean; includeUnsearchable?: boolean }): Promise<string[] | null> {
  if (opts.plain || opts.includeUnsearchable) return null;
  const terms = lexQueryTerms(qstr);
  return terms.length && await lexReady() ? terms : null;
}

/** 지식 검색이 받는 공통 거르기 — categories(#5100)는 카테고리 id 목록(category 인자를 풀어 넣는다 · 앱 맥락 범위는 여기서 교집합으로 더해진다). */
export interface KnowledgeSearchFilter {
  injection?: string; provenance?: string; categories?: readonly number[] | null;
  /** #5169 사람이 화면에서 글로 찾을 때(⌘K · 링크 고르기)만 true — 검색 제외 지식도 글자로 찾고 행에 searchable 을 싣는다.
   *  벡터 채널은 그대로 뺀다(벡터가 없다). 에이전트 길에는 이 값이 없다 — 화면 전용 op knowledge_screen_search(expose.mcp:false)만 켠다. */
  includeUnsearchable?: boolean;
}

/** 사람 화면의 글자 순위 — 같은 급(이름·제목 일치 다음)이면 검색 대상을 먼저 둔다. 재집계 문서는 길고 자주 다시 올라와 «최신 순»
 *  만으로는 받아 오는 창(LIMIT)을 먼저 채운다. 화면이 최신 순으로 다시 늘어놓아도 창 안에 드는 것을 지킨다. 에이전트 길에는 조각이 없다. */
const keptFirst = (opts: { includeUnsearchable?: boolean }): string => (opts.includeUnsearchable ? "k.searchable DESC, " : "");
/** 사람 화면 호출에만 행에 표시를 싣는다(에이전트 응답 모양은 그대로). */
const flagOf = (opts: { includeUnsearchable?: boolean }, r: { searchable?: boolean }): { searchable?: boolean } =>
  (opts.includeUnsearchable ? { searchable: r.searchable } : {});

// mode='count' — 본문/스니펫 없이 매치 총건수만(페이징·존재확인용).
export async function countKnowledgeGrep(
  qstr: string, opts: KnowledgeSearchFilter & { plain?: boolean } = {}, viewer?: Viewer,
): Promise<number> {
  const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
  const { result } = await grepExec(qstr, async (plan) => {
    const params: unknown[] = [];
    const where = grepWhereSql(plan, { ...opts, categories }, params);
    // 건수도 뷰어 기준이어야 한다 — 본문을 안 줘도 "그 단어가 들어간 문서가 3건 있다"는 그 자체로 새는 정보다.
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM knowledge k WHERE ${where} AND ${vis}`, params);
    return Number(rows[0]?.n ?? 0);
  }, { plain: opts.plain });
  return result;
}

export async function searchKnowledge(
  qstr: string,
  opts: KnowledgeSearchFilter & { limit?: number; mode?: KnowledgeGrepMode; context?: number; plain?: boolean } = {},
  viewer?: Viewer,
  diag?: SearchRouteDiag,
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";   // names 모드는 body_md/스니펫 불필요 — 더 얕게 조회
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
  //  #5201 무엇이 맞나는 grep 규칙 그대로 두고, 같은 급 안의 **순서만** BM25 로 — 종전 최신순은 본문에 낱말이 스친 최근 문서가 위에 섰다
  //   (grep 으로 친 검색어 75개 판정 nDCG@5 0.535 → 0.602). 정규식으로 친 검색어(grep 호출의 65%)도 낱말로 나눠 같은 순서를 쓴다.
  const terms = await bm25Terms(qstr, opts);
  if (diag) diag.route = terms ? "bm25-order" : "grep";
  const find = (bmTerms: readonly string[] | null) => grepExec(qstr, async (p) => {
    const params: unknown[] = [];
    const where = grepWhereSql(p, { ...opts, categories }, params);
    // 렉시컬 채널은 정확 스캔이라 술어를 WHERE 에 그대로 건다(벡터 채널과 달리 리콜 붕괴가 없다 — rrfSearch 주석 참조).
    const vis = await knowledgeVisWhere(viewer, params);
    const first = exactFirst("k.name", qstr, "name", params);   // key 의 주인이 LIMIT 에 잘리지 않게(exactFirst 주석)
    const tf = titleFirst("k.title", p, params);                // 제목에 모든 낱말이 든 것이 본문만 스친 최근 문서에 잘리지 않게(#4530)
    const bm = bmTerms ? bm25Sql(bmTerms, params, vis) : null;
    params.push(Math.min(opts.limit ?? 20, 100));
    return q(itemsPool,
      `${bm ? `WITH ${bm} ` : ""}SELECT ${sel} FROM knowledge k ${bm ? "LEFT JOIN bm ON bm.name = k.name " : ""}WHERE ${where} AND ${vis}
       ORDER BY ${first}${tf}${keptFirst(opts)}${bm ? "bm.score DESC NULLS LAST, " : ""}k.updated_at DESC LIMIT $${params.length}`, params);
  }, { plain: opts.plain });
  const { result: rows, plan } = await find(terms).catch((e) => {
    if (!terms) throw e;
    console.warn(`[knowledge-lex] BM25 순서 실패 — 최신순으로: ${(e as Error)?.message}`);   // 순서 때문에 grep 이 죽으면 안 된다
    if (diag) diag.route = "grep";
    return find(null);
  });
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, icon: r.icon ?? null, ...flagOf(opts, r) };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 하이브리드 검색(knowledge_search, 벡터검색 #172) — 벡터(cosine) ∪ 렉시컬(grep) RRF 융합. ──
//  · 임베딩 off / 쿼리 임베딩 실패 / SQL 실패 → 전부 searchKnowledge(렉시컬)로 폴백(하위호환·safe-by-construction).
//  · grep 과 다른 점: 단어가 본문에 그대로 없어도 의미 유사로 회수(벡터 채널). 정확 토큰/정규식은 knowledge_grep.
//  · 결과는 grep 과 동일 표면(스니펫·전문 미포함). 벡터-only 매치는 grepSnippet 이 본문 앞부분 미리보기로 폴백.
//  RRF_K/HYBRID_CANDIDATES 는 search-util.ts 에서 import(project 검색과 공유).

export async function hybridSearchKnowledge(
  qstr: string,
  opts: KnowledgeSearchFilter & { limit?: number; mode?: KnowledgeGrepMode; context?: number; plain?: boolean } = {},
  viewer?: Viewer,
  diag?: SearchRouteDiag,
): Promise<KnowledgeSearchRow[]> {
  const terms = await bm25Terms(qstr, opts);
  //  #5201 식별자가 든 질의는 낱말 채널만 쓴다(근거는 hasIdentifier 주석). 임베딩도 부르지 않는다. 식별자 조각까지 하나도 안 맞을 때만 아래로 내려간다.
  const idOnly = !!terms && hasIdentifier(qstr);
  if (idOnly) {
    try {
      const rows = await rrfSearch(qstr, null, terms, opts, viewer);
      if (rows.length) { if (diag) diag.route = "lexical"; return rows; }
    } catch (e) {
      console.warn(`[knowledge-lex] 낱말 검색 실패 — 하이브리드로: ${(e as Error)?.message}`);
    }
  }
  //  질의 임베딩은 한 자리(embedQuery — 기억·동시 요청 공유·짧은 상한, #4530). off·실패면 낱말 채널만, 그것도 없으면 grep 그대로(하위호환).
  const qe = await embedQuery(qstr);
  const qvec = qe.vec;
  if (!qvec && !terms) return searchKnowledge(qstr, opts, viewer, diag);   // off · 쿼리 임베딩 실패 + 색인 없음 → 폴백
  if (!qvec && idOnly) { if (diag) diag.route = "lexical"; return []; }    // 낱말 채널은 방금 돌았다
  try {
    const rows = await rrfSearch(qstr, qvec, terms, opts, viewer);
    if (diag) diag.route = qvec ? (terms ? "hybrid" : "hybrid-grep") : "lexical";
    return rows;
  } catch (e) {
    console.warn(`[embeddings] 하이브리드 검색 실패 — 렉시컬 폴백: ${(e as Error)?.message}`);
    return searchKnowledge(qstr, opts, viewer, diag);                  // pgvector 컬럼 부재 등 → 폴백
  }
}

/**
 * (#4213 T12 #4744 검색 실패 보조 안내) 하이브리드 검색이 돌려준 지식이 질의와 얼마나 맞나 — RRF 점수는 순위라 «약하다» 를 말하지 못해서
 *  절대값 둘을 따로 잰다: topSim = 그 지식들과 질의 벡터의 코사인 유사도 최고값(임베딩이 꺼졌거나 못 물었거나 벡터가 아직 없으면 null) ·
 *  lexical = 그 가운데 질의 낱말이 (부르는 쪽이 정한 수만큼 — termsNeeded · 큰따옴표 구절은 늘) 이름·제목·본문에 든 지식이 있나(knowledge_grep
 *  plain 규칙 — 조사를 뗀 꼴 · 군말은 없어도 됨). 낱말이 맞으면 topSim 은 재지 않는다(null). 돌려준 지식(이름)만 보므로 공개범위는 이미 걸러진
 *  것이다. 질의 임베딩은 검색과 같은 원문(qstr)으로 묻어 방금 검색이 기억해 둔 것을 다시 쓴다(embedQuery 기억) — 낱말은 termsQuery 에서 뽑는다.
 *  **던지지 않는다**(검색 응답을 막지 않는다) — 못 재면 {topSim:null, lexical:false}(약한 쪽 — 보조 안내가 붙는 쪽)로 답한다.
 */
export async function knowledgeSearchStrength(qstr: string, names: readonly string[],
  opts: { termsQuery?: string; termsNeeded?: (n: number) => number } = {}): Promise<{ topSim: number | null; lexical: boolean }> {
  const list = [...new Set(names)].slice(0, 100);
  if (!list.length) return { topSim: null, lexical: false };
  //  낱말 먼저 — 맞은 지식이 있으면 «강함» 이라 의미 거리는 재지 않는다(임베딩을 부르지 않는다 · 3차 리뷰).
  //   낱말은 plain 규칙(조사를 뗀 꼴 · 같은 뜻 표기)으로 · **군말은 빼고**(«어떻게» · 한 글자) — 자연어 질의의 «공개범위를» 이 «공개범위» 로 맞고
  //   «어떻게 돼» 가 지식에 없다고 약해지지 않게(리뷰 2026-10-17). 낱말이 전부 군말이면 그대로 다 쓴다. 낱말은 termsQuery(문장부호를 뗀 글)에서
  //   뽑는다. 몇 개가 맞아야 하나는 부르는 쪽이 정한다(termsNeeded) — 큰따옴표 구절은 늘 맞아야 한다.
  let lexical = false;
  try {
    const all = parseQueryTerms(opts.termsQuery ?? qstr);
    const must = requiredTerms(all);
    const terms = must.length ? must : all;
    if (terms.length) {
      const params: unknown[] = [];
      const termSql = (t: (typeof terms)[number]) => grepWhereSql({ mode: "plain", terms: [t] } as GrepPlan, {}, params);
      const quoted = terms.filter((t) => t.quoted), loose = terms.filter((t) => !t.quoted);
      const need = Math.min(Math.max((opts.termsNeeded ?? ((n: number) => n))(terms.length), 1), terms.length);
      const needLoose = Math.max(0, need - quoted.length);
      const conds = quoted.map((t) => `(${termSql(t)})`);
      if (loose.length && needLoose > 0) {
        const hits = loose.map((t) => `(CASE WHEN (${termSql(t)}) THEN 1 ELSE 0 END)`);
        params.push(needLoose);
        conds.push(`(${hits.join(" + ")}) >= $${params.length}`);
      }
      params.push(list);
      const rows = await q(itemsPool,
        `SELECT count(*)::int AS n FROM knowledge k WHERE ${conds.join(" AND ")} AND k.name = ANY($${params.length}::text[])`, params);
      lexical = Number(rows[0]?.n ?? 0) > 0;
    }
  } catch { lexical = false; }
  if (lexical) return { topSim: null, lexical };
  //  의미 거리 — 질의 벡터는 **검색과 같은 원문(qstr)** 으로 묻는다(검색이 방금 계산한 것을 기억에서 다시 쓴다).
  let topSim: number | null = null;
  try {
    const qe = await embedQuery(qstr);
    if (qe.vec) {
      const r = await one(itemsPool,
        `SELECT max(1 - (embedding_vector <=> $1::vector))::float8 AS s FROM knowledge WHERE name = ANY($2::text[]) AND embedding_vector IS NOT NULL`,
        [toVectorLiteral(qe.vec), list]) as { s?: number | null } | undefined;
      topSim = r?.s == null ? null : Number(r.s);
    }
  } catch { topSim = null; }
  return { topSim, lexical };
}

/**
 * 벡터 채널 후보 CTE(이름 vec) — 카테고리 제한(#5100)이 있으면 **제한 안 행만 먼저 떠서(MATERIALIZED) 정확히 잰다**.
 *  HNSW 근사탐색(ORDER BY <=> … LIMIT)에 조건을 얹으면 탐색 목록(ef_search) 안에서만 사후로 걸러져, 제한 밖 이웃이 그 목록을 채울 때
 *  결과가 통째로 빈다(#1291 R2-#6 — 공개범위 술어를 후보에 안 넣는 까닭과 같은 현상). 범위를 선언한 앱은 바로 그 모양이다 — 범위 밖
 *  설계 문서가 질문과 가장 가깝다. 떠 둔 행에는 인덱스가 없어 순서가 정확하다(제한 안 행 수만큼 거리를 잰다).
 *  제한이 없으면 종전 그대로(HNSW).
 */
function vecChannel(vecWhere: string, qp: string, candP: string, restricted: boolean): string {
  if (!restricted) return `vec AS (
      SELECT k.name, row_number() OVER (ORDER BY k.embedding_vector <=> ${qp}) AS rank
      FROM knowledge k WHERE ${vecWhere} ORDER BY k.embedding_vector <=> ${qp} LIMIT ${candP}
    )`;
  return `vpool AS MATERIALIZED (
      SELECT k.name, k.embedding_vector FROM knowledge k WHERE ${vecWhere}
    ),
    vec AS (
      SELECT p.name, row_number() OVER (ORDER BY p.embedding_vector <=> ${qp}) AS rank
      FROM vpool p ORDER BY p.embedding_vector <=> ${qp} LIMIT ${candP}
    )`;
}

// RRF 융합 = SQL 한 방(쿼리 임베딩은 JS 에서 계산해 $n::vector 로 주입). lex/vec CTE 각 후보 → row_number rank → RRF 점수.
//  terms 가 있으면 낱말 채널이 BM25(#5201), 없으면 종전 grep 이다. qvec 이 없으면 낱말 채널 하나로 순위만 낸다.
async function rrfSearch(
  qstr: string, qvec: number[] | null, terms: readonly string[] | null,
  opts: KnowledgeSearchFilter & { limit?: number; mode?: KnowledgeGrepMode; context?: number; plain?: boolean },
  viewer?: Viewer,
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const limit = Math.min(opts.limit ?? 20, 100);
  const parsed = opts.plain ? parsePlainGrep(qstr) : parseGrep(qstr);
  //  BM25 는 조사를 뗀 꼴로 맞으니 스니펫도 그 꼴로 줄을 찾는다(«임베딩을» → «임베딩» 만 든 줄). 정규식으로 친 글은 그 정규식 그대로.
  const plan = terms && parsed.mode === "tokens" ? parsePlainGrep(qstr) : parsed;
  //  #5100 카테고리 제한(category 인자 ∩ 앱 맥락 범위) — 두 후보 CTE 에 건다(아래 «⚠ 공개범위 술어» 와 반대인 까닭은 vecChannel 주석).
  const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
  const params: unknown[] = [];
  // 렉시컬 채널 WHERE — grep 매처 + lifecycle='active' + injection/provenance(searchKnowledge 와 동일 의미).
  //  ⚠ 공개범위 술어는 두 후보 CTE 어디에도 넣지 않는다 — **최종 SELECT 한 곳**에서만 건다(아래).
  //   벡터 채널이 HNSW 근사탐색이라 후보 단계에서 걸러내면, 이웃 상위 N 개가 비가시 문서로 채워졌을 때
  //   결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6). 최종 필터로도 이름·본문은 DB 밖으로 안 나가므로 누출은 없다.
  //   (렉시컬 채널만 미리 걸러도 되지만, 술어를 두 군데 쓰면 한쪽만 고치는 사본 결함이 생긴다 — 한 곳으로 모은다.)
  const lexWhere = terms ? "" : grepWhereSql(parsed, { ...opts, categories }, params);
  const bmFilters = terms ? searchFilterSql({ ...opts, categories }, params).join(" AND ") : "";
  params.push(HYBRID_CANDIDATES); const candP = `$${params.length}`;
  // 벡터 채널 WHERE — 같은 필터(+ 임베딩 보유 행만). params 공유.
  //  ⚠ 질의 벡터가 없으면 이 자리를 통째로 건너뛴다 — SQL 에 안 쓰는 매개변수를 넘기면 Postgres 가 타입을 못 정해 거부한다.
  let vecCte = "";
  if (qvec) {
    //  #5169 검색 제외는 벡터가 없지만 술어로도 뺀다 — 비우기 전의 벡터가 남아 있어도 결과에 안 나오게(렉시컬 grepWhereSql 과 같은 규칙).
    const vecWh: string[] = [`k.lifecycle='active'`, `k.searchable`, `k.embedding_vector IS NOT NULL`];
    if (opts.injection) { params.push(opts.injection); vecWh.push(`k.injection=$${params.length}`); }
    if (opts.provenance) { params.push(opts.provenance); vecWh.push(`k.provenance=$${params.length}`); }
    if (categories) vecWh.push(knowledgeInCategoriesSql(categories, params, "k"));
    params.push(toVectorLiteral(qvec));   // 쿼리 벡터
    vecCte = `${vecChannel(vecWh.join(" AND "), `$${params.length}::vector`, candP, categories !== null)},`;
  }
  params.push(RRF_K); const kP = `$${params.length}`;
  const vis = await knowledgeVisWhere(viewer, params);   // 최종 SELECT 전용(위 후보 CTE 주석 참조)
  params.push(limit); const limP = `$${params.length}`;
  const first = exactFirst("k.name", qstr, "name", params);
  //  렉시컬 순위도 «제목에 모든 낱말이 든 것 먼저» (#4530) — 종전엔 최신순뿐이라 RRF 에 «제목이 맞았다» 는 신호가 하나도 없었다.
  const tf = terms ? "" : titleFirst("k.title", parsed, params);
  const lexChannel = terms ? `${bm25Sql(terms, params, vis)},
    lex AS (
      SELECT k.name, row_number() OVER (ORDER BY ${first}b.score DESC, k.updated_at DESC) AS rank
      FROM bm b JOIN knowledge k ON k.name = b.name WHERE ${bmFilters} ORDER BY ${first}b.score DESC, k.updated_at DESC LIMIT ${candP}
    )` : `lex AS (
      SELECT k.name, row_number() OVER (ORDER BY ${first}${tf}${keptFirst(opts)}k.updated_at DESC) AS rank
      FROM knowledge k WHERE ${lexWhere} ORDER BY ${first}${tf}${keptFirst(opts)}k.updated_at DESC LIMIT ${candP}
    )`;
  const sql = `
    WITH ${lexChannel},
    ${vecCte}
    fused AS (
      SELECT name, SUM(1.0/(${kP} + rank)) AS score
      FROM (SELECT name, rank FROM lex${qvec ? " UNION ALL SELECT name, rank FROM vec" : ""}) u
      GROUP BY name
    )
    SELECT ${sel}, f.score::float8 AS score
    FROM fused f JOIN knowledge k ON k.name=f.name
    WHERE ${vis}
    ORDER BY ${first}f.score DESC LIMIT ${limP}`;
  const rows = qvec ? await withHnswScan((db) => q(db, sql, params)) : await q(itemsPool, sql, params);
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, score: Number(r.score), icon: r.icon ?? null, ...flagOf(opts, r) };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

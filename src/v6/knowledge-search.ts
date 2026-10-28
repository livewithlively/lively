// v6 knowledge 검색(#1313 R21 — knowledge-store 에서 분리) — grep(렉시컬)·하이브리드(RRF)·유사·추천.
//  분리 이유: CRUD 와 완전히 다른 관심사(질의 계획·벡터·랭킹)인데 한 파일에 있어 검색 튜닝 diff 가 저장 경로와
//  충돌했다. 공개 표면은 그대로 — knowledge-store.ts 가 이 모듈을 재수출하므로 기존 호출부는 무수정.
//  공용 조각(가시성 술어·아이콘 표현식)은 knowledge-common.ts, grep 매처·RRF 상수는 search-util.ts.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { toVectorLiteral } from "./embedding-provider.js";
import {
  type GrepPlan, parseGrep, parsePlainGrep, grepWhere, grepExec, grepSnippet, previewBody, exactFirst, titleFirst,
  RRF_K, HYBRID_CANDIDATES, activeEmbeddingProvider, embedQuery,
} from "./search-util.js";
import { type Viewer } from "./visibility.js";
import { parseQueryTerms, requiredTerms } from "./query-terms.js";   // #4744 검색 실패 보조 안내의 낱말 판정(군말 빼기)
import { knowledgeVisWhere, K_ICON_EXPR } from "./knowledge-common.js";
import { knowledgeCategoryRestriction, knowledgeInCategoriesSql } from "./read-scope.js";   // #5100 category 인자 · 앱 맥락 범위

// grep 결과 SELECT — 전문(body_md)은 스니펫 계산용으로만 가져오고 응답에선 뺀다. 무관 메타(external_* 등)는 아예 미조회.
//  grep 매처(parseGrep/grepWhere)·스니펫 빌더(grepSnippet)는 search-util.ts 로 분리(#631, project 검색과 공유).
const K_GREP_SEL = ["name", "title", "body_md", "injection", "provenance", "is_wiki", "summary", "updated_at"]
  .map((c) => "k." + c).join(", ") + `, ${K_ICON_EXPR}`;
// names 모드 — body_md 도 미조회(스니펫 불필요). 발견용 메타만(가장 얕게).
const K_GREP_NAMES_SEL = ["name", "title", "injection", "provenance", "is_wiki", "summary", "updated_at"]
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
}
export type KnowledgeGrepMode = "snippets" | "names" | "count";
// 공통 WHERE(grep 매처 + lifecycle='active' + injection/provenance). params 에 push 하고 절 문자열 반환.
function grepWhereSql(plan: GrepPlan, opts: { injection?: string; provenance?: string; categories?: readonly number[] | null }, params: unknown[]): string {
  //  ⚠ **name(=key)도 본다** — grepWhereSql 은 grep·count·하이브리드의 렉시컬 채널이 **전부** 지나는 한 자리다.
  //   (2026-08-25: 같은 취지로 knowledge-store 의 *목록* 필터도 고쳤는데, 검색은 그 자리가 아니라 여기다 —
  //    고치고도 dev 에서 안 나아져서 잡았다. 지식 검색의 WHERE 는 이 함수 하나뿐이니 여기가 정본이다.)
  //   key 는 사람이 실제로 옮겨 적는 이름이다(위키링크 `[[key]]` · 주소 `#/k/<key>` · knowledge_get 인자).
  //   종전엔 key 로 찾으면 **그 key 를 본문에 인용한 다른 문서**만 나오고 정작 그 문서는 안 나왔다.
  const wh: string[] = [grepWhere(["k.name", "k.title", "k.body_md"], plan, params), `k.lifecycle='active'`];
  if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
  //  #5100 카테고리 제한(category 인자 ∩ 앱 맥락 범위 — knowledgeCategoryRestriction). 후보를 고르는 이 자리에서 건다 —
  //   하이브리드의 렉시컬 후보(상위 N)가 제한 밖 문서로 채워지면 최종 술어만으로는 결과가 빈다.
  if (opts.categories) wh.push(knowledgeInCategoriesSql(opts.categories, params, "k"));
  return wh.join(" AND ");
}

/** 지식 검색이 받는 공통 거르기 — categories(#5100)는 카테고리 id 목록(category 인자를 풀어 넣는다 · 앱 맥락 범위는 여기서 교집합으로 더해진다). */
export interface KnowledgeSearchFilter { injection?: string; provenance?: string; categories?: readonly number[] | null }

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
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";   // names 모드는 body_md/스니펫 불필요 — 더 얕게 조회
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
  const { result: rows, plan } = await grepExec(qstr, async (p) => {
    const params: unknown[] = [];
    const where = grepWhereSql(p, { ...opts, categories }, params);
    // 렉시컬 채널은 정확 스캔이라 술어를 WHERE 에 그대로 건다(벡터 채널과 달리 리콜 붕괴가 없다 — rrfSearch 주석 참조).
    const vis = await knowledgeVisWhere(viewer, params);
    const first = exactFirst("k.name", qstr, "name", params);   // key 의 주인이 LIMIT 에 잘리지 않게(exactFirst 주석)
    const tf = titleFirst("k.title", p, params);                // 제목에 모든 낱말이 든 것이 본문만 스친 최근 문서에 잘리지 않게(#4530)
    params.push(Math.min(opts.limit ?? 20, 100));
    return q(itemsPool,
      `SELECT ${sel} FROM knowledge k WHERE ${where} AND ${vis} ORDER BY ${first}${tf}k.updated_at DESC LIMIT $${params.length}`, params);
  }, { plain: opts.plain });
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, icon: r.icon ?? null };
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
): Promise<KnowledgeSearchRow[]> {
  //  질의 임베딩은 한 자리(embedQuery — 기억·동시 요청 공유·짧은 상한, #4530). off·실패 → grep 그대로(하위호환).
  const qe = await embedQuery(qstr);
  const qvec = qe.vec;
  if (!qvec) return searchKnowledge(qstr, opts, viewer);               // off · 쿼리 임베딩 실패 → 폴백
  try {
    return await rrfSearch(qstr, qvec, opts, viewer);
  } catch (e) {
    console.warn(`[embeddings] 하이브리드 검색 실패 — 렉시컬 폴백: ${(e as Error)?.message}`);
    return searchKnowledge(qstr, opts, viewer);                        // pgvector 컬럼 부재 등 → 폴백
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
async function rrfSearch(
  qstr: string, qvec: number[],
  opts: KnowledgeSearchFilter & { limit?: number; mode?: KnowledgeGrepMode; context?: number; plain?: boolean },
  viewer?: Viewer,
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const limit = Math.min(opts.limit ?? 20, 100);
  const plan = opts.plain ? parsePlainGrep(qstr) : parseGrep(qstr);
  //  #5100 카테고리 제한(category 인자 ∩ 앱 맥락 범위) — 두 후보 CTE 에 건다(아래 «⚠ 공개범위 술어» 와 반대인 까닭은 vecChannel 주석).
  const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
  const params: unknown[] = [];
  // 렉시컬 채널 WHERE — grep 매처 + lifecycle='active' + injection/provenance(searchKnowledge 와 동일 의미).
  //  ⚠ 공개범위 술어는 두 후보 CTE 어디에도 넣지 않는다 — **최종 SELECT 한 곳**에서만 건다(아래).
  //   벡터 채널이 HNSW 근사탐색이라 후보 단계에서 걸러내면, 이웃 상위 N 개가 비가시 문서로 채워졌을 때
  //   결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6). 최종 필터로도 이름·본문은 DB 밖으로 안 나가므로 누출은 없다.
  //   (렉시컬 채널만 미리 걸러도 되지만, 술어를 두 군데 쓰면 한쪽만 고치는 사본 결함이 생긴다 — 한 곳으로 모은다.)
  const lexWhere = grepWhereSql(plan, { ...opts, categories }, params);
  // 벡터 채널 WHERE — 같은 필터(+ 임베딩 보유 행만). params 공유.
  const vecWh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
  if (opts.injection) { params.push(opts.injection); vecWh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); vecWh.push(`k.provenance=$${params.length}`); }
  if (categories) vecWh.push(knowledgeInCategoriesSql(categories, params, "k"));
  const vecWhere = vecWh.join(" AND ");
  params.push(toVectorLiteral(qvec)); const qp = `$${params.length}::vector`;   // 쿼리 벡터(lex/vec 양쪽 참조 가능)
  params.push(HYBRID_CANDIDATES); const candP = `$${params.length}`;
  params.push(RRF_K); const kP = `$${params.length}`;
  const vis = await knowledgeVisWhere(viewer, params);   // 최종 SELECT 전용(위 후보 CTE 주석 참조)
  params.push(limit); const limP = `$${params.length}`;
  const first = exactFirst("k.name", qstr, "name", params);
  //  렉시컬 순위도 «제목에 모든 낱말이 든 것 먼저» (#4530) — 종전엔 최신순뿐이라 RRF 에 «제목이 맞았다» 는 신호가 하나도 없었다.
  const tf = titleFirst("k.title", plan, params);
  const sql = `
    WITH lex AS (
      SELECT k.name, row_number() OVER (ORDER BY ${first}${tf}k.updated_at DESC) AS rank
      FROM knowledge k WHERE ${lexWhere} ORDER BY ${first}${tf}k.updated_at DESC LIMIT ${candP}
    ),
    ${vecChannel(vecWhere, qp, candP, categories !== null)},
    fused AS (
      SELECT name, SUM(1.0/(${kP} + rank)) AS score
      FROM (SELECT name, rank FROM lex UNION ALL SELECT name, rank FROM vec) u
      GROUP BY name
    )
    SELECT ${sel}, f.score::float8 AS score
    FROM fused f JOIN knowledge k ON k.name=f.name
    WHERE ${vis}
    ORDER BY ${first}f.score DESC LIMIT ${limP}`;
  const rows = await q(itemsPool, sql, params);
  return rows.map((r) => {
    const base: KnowledgeSearchRow = { name: r.name, title: r.title, injection: r.injection,
      provenance: r.provenance, is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at, score: Number(r.score), icon: r.icon ?? null };
    if (withBody) base.snippet = grepSnippet(r.body_md ?? "", plan, opts.context);
    return base;
  });
}

// ── 유사 지식(벡터검색 #172) — 코사인 유사도(0~1) 기반 최근접. 저장-시 중복감지·관련패널의 프리미티브. ──
//  · raw 유사도 = 1 - (embedding_vector <=> qvec) (pgvector <=> 는 코사인 거리 → 1-거리 = 코사인 유사도).
//    RRF score(랭크 기반, hybridSearch)와 달리 **절대 임계 비교 가능**(중복 판정 등) — 이게 proactive·dedup 의 열쇠.
//  · 입력: name(기존 지식 → 저장된 임베딩 재사용, 재임베딩 불요) 또는 text(임시 텍스트 → 즉시 임베딩). name 우선.
//  · 임베딩 off / 대상 임베딩 없음 / 쿼리 임베딩 실패 / SQL 실패 → 빈 배열(graceful — 호출부는 "유사 없음"으로 처리).
//  previewBody(식별용 미리보기)는 search-util.ts 에서 import.

export interface KnowledgeSimilarRow {
  name: string; title: string | null;
  injection: string; provenance: string; is_wiki: boolean;
  summary: string | null; updated_at: string;
  similarity: number;   // 0~1 코사인 유사도(높을수록 유사)
  snippet?: string;     // 본문 앞부분 미리보기(식별용)
}
/** 유사 검색이 «없음» 을 답한 까닭(#4530) — 화면이 «관련 없음» 과 «못 물어봄» 을 다르게 말하게. 호출부가 넘긴 객체에 채운다. */
export interface SimilarDiag { embeddings?: "off"; degraded?: boolean }
export async function findSimilarKnowledge(
  opts: { name?: string; text?: string; limit?: number; minScore?: number; injection?: string; provenance?: string; categories?: readonly number[] | null } = {},
  viewer?: Viewer,
  diag?: SimilarDiag,
): Promise<KnowledgeSimilarRow[]> {
  // 1) 쿼리 벡터 리터럴 확보 — name(저장된 벡터 재사용, 재임베딩 불요) 또는 text(즉시 임베딩).
  let vecLiteral: string | null = null;
  let selfName: string | null = null;
  if (opts.name) {
    selfName = opts.name;
    const r = await one(itemsPool, `SELECT embedding_vector::text AS v FROM knowledge WHERE name=$1`, [opts.name]);
    vecLiteral = (r as { v?: string | null } | undefined)?.v ?? null;   // 대상에 임베딩 없으면 null → []
  } else if (opts.text && opts.text.trim()) {
    const qe = await embedQuery(opts.text);
    if (qe.status === "off") { if (diag) diag.embeddings = "off"; return []; }   // off → 유사 없음(꺼졌다고 말한다)
    if (!qe.vec) { if (diag) diag.degraded = true; return []; }                   // 쿼리 임베딩 실패·시간 초과 → 빈 결과 + «못 물어봄»
    vecLiteral = toVectorLiteral(qe.vec);
  }
  if (!vecLiteral) return [];
  // 2) 최근접 — 코사인 거리 오름차순. 자기 자신·미임베딩·비활성 제외. minScore(코사인 유사도) 이상만.
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0;
  try {
    //  #5100 카테고리 제한(category 인자 ∩ 앱 맥락 범위) — 후보 단계에서 건다(아래 MATERIALIZED 갈래 · vecChannel 주석과 같은 까닭).
    const categories = await knowledgeCategoryRestriction(viewer, opts.categories);
    const params: unknown[] = [vecLiteral]; const qp = `$1::vector`;     // $1 = 쿼리 벡터(거리·유사도·정렬에 공유)
    const wh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
    if (selfName) { params.push(selfName); wh.push(`k.name <> $${params.length}`); }
    if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
    if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
    if (categories) wh.push(knowledgeInCategoriesSql(categories, params, "k"));
    params.push(minScore); const minP = `$${params.length}`;
    // 후보는 요청 건수보다 넓게 뽑는다(공개범위 필터 여유분) — 상한은 실용 캡.
    params.push(Math.min(limit * 10, 500)); const candP = `$${params.length}`;
    params.push(limit); const limP = `$${params.length}`;
    const vis = await knowledgeVisWhere(viewer, params);
    // ⚠ 공개범위 술어를 **후보 스캔(cand)에 넣지 않는다** — 이 스캔이 곧 HNSW 근사탐색(ORDER BY <=> … LIMIT)이라,
    //  거기에 술어를 얹으면 탐색목록(ef_search) 안에서만 사후 필터돼 결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6).
    //  대신 후보를 넓게 뜬 뒤 바깥에서 거른다. minScore 는 거리와 단조라 후보 안에 남겨도 같은 문제가 없다(순서상 뒤).
    //  cand 가 k.visibility 를 실어야 바깥 술어(knowledgeVisSql, 별칭 k)가 그대로 붙는다.
    //  #5100 카테고리 제한이 있으면 제한 안 행의 이름 · 벡터만 먼저 떠서(MATERIALIZED) 정확히 재고, 가까운 후보에만 본문을 붙인다 —
    //   근사탐색 사후 필터로 결과가 비는 일을 막는다(vecChannel 주석). 본문까지 떠 두면 범위가 클 때 그만큼 메모리를 쓴다(격리 리뷰 N7).
    //   제한이 없으면 종전 그대로(cand 가 곧 HNSW 근사탐색).
    const cand = categories ? `kpool AS MATERIALIZED (
        SELECT k.name, k.embedding_vector FROM knowledge k WHERE ${wh.join(" AND ")}
      ),
      near AS (
        SELECT p.name, (1 - (p.embedding_vector <=> ${qp}))::float8 AS similarity
        FROM kpool p
        WHERE (1 - (p.embedding_vector <=> ${qp})) >= ${minP}
        ORDER BY p.embedding_vector <=> ${qp}
        LIMIT ${candP}
      ),
      cand AS (
        SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
               k.visibility, n.similarity
        FROM near n JOIN knowledge k ON k.name = n.name
      )` : `cand AS (
        SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
               k.visibility,
               (1 - (k.embedding_vector <=> ${qp}))::float8 AS similarity
        FROM knowledge k
        WHERE ${wh.join(" AND ")} AND (1 - (k.embedding_vector <=> ${qp})) >= ${minP}
        ORDER BY k.embedding_vector <=> ${qp}
        LIMIT ${candP}
      )`;
    const sql = `
      WITH ${cand}
      SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md, k.similarity
      FROM cand k
      WHERE ${vis}
      ORDER BY k.similarity DESC
      LIMIT ${limP}`;
    const rows = await q(itemsPool, sql, params);
    return rows.map((r) => ({
      name: r.name, title: r.title, injection: r.injection, provenance: r.provenance,
      is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at,
      similarity: Number(r.similarity), snippet: previewBody(r.body_md ?? ""),
    }));
  } catch (e) {
    console.warn(`[embeddings] 유사 지식 조회 실패: ${(e as Error)?.message}`);
    if (diag) diag.degraded = true;
    return [];                                                          // pgvector 부재 등 → 빈 결과(저장·검색 무손상)
  }
}

// ── 추천(카테고리 인지, 벡터검색 #172) — 의미 유사도 + 카테고리 공유 가산점·구제. 프로젝트 필요지식 추천의 코어. ──
//  순수 벡터보다 나은 점: 사람이 큐레이션한 카테고리는 강한 관련 신호 → ① 같은 카테고리면 가산점(boost)으로 상위로,
//  ② 임계(minScore) 미달이어도 같은 카테고리면 구제(rescue)해 포함, ③ 임베딩 off 여도 카테고리만으로 추천 가능(graceful).
//  score = 코사인유사도 + (카테고리 공유 ? boost : 0). 단일 랭킹 리스트 + shares_category 태그(왜 추천인지).
export interface KnowledgeRecommendRow extends KnowledgeSimilarRow {
  shares_category: boolean;  // 주어진 카테고리와 공유(가산점·구제 대상)
  score: number;             // 정렬 기준 = similarity + 카테고리 가산점
}
const CATEGORY_BOOST = 0.15; // 같은 카테고리 공유 시 코사인유사도에 더하는 가산점(bge-m3 스케일 기준 보수적)
export async function findRecommendedKnowledge(
  opts: { text?: string; categoryIds?: number[]; exclude?: string[]; limit?: number; minScore?: number; categoryBoost?: number } = {},
  viewer?: Viewer,
): Promise<KnowledgeRecommendRow[]> {
  const cats = (opts.categoryIds ?? []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  // 쿼리 임베딩(텍스트 있고 provider on 일 때만). 실패/off → null → 카테고리만으로 추천(graceful).
  let qvec: number[] | null = null;
  if (opts.text && opts.text.trim()) {
    const provider = await activeEmbeddingProvider();
    if (provider) {
      try { const [v] = await provider.embed([opts.text.slice(0, 8000)]); qvec = v && v.length ? v : null; } catch { qvec = null; }
    }
  }
  if (!qvec && !cats.length) return [];   // 의미·카테고리 둘 다 신호 없음 → 추천 불가
  const exclude = opts.exclude ?? [];
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.4;
  const boost = typeof opts.categoryBoost === "number" ? opts.categoryBoost : CATEGORY_BOOST;
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  try {
    const params: unknown[] = [];
    // similarity 식 — qvec 있을 때만 벡터 참조(off 면 NULL → 카테고리 경로만).
    let simExpr = "NULL";
    if (qvec) { params.push(toVectorLiteral(qvec)); simExpr = `(1 - (k.embedding_vector <=> $${params.length}::vector))`; }
    // 카테고리 공유 식 — cats 있을 때만(rejected 매핑 제외). 없으면 false → 순수 벡터(가산점·구제 없음).
    let sharesExpr = "false";
    if (cats.length) {
      params.push(cats);
      sharesExpr = `EXISTS(SELECT 1 FROM knowledge_category kc WHERE kc.name=k.name AND kc.state<>'rejected' AND kc.category_id = ANY($${params.length}::int[]))`;
    }
    params.push(exclude); const exclP = `$${params.length}::text[]`;
    params.push(minScore); const minP = `$${params.length}`;
    params.push(boost); const boostP = `$${params.length}`;
    params.push(limit); const limP = `$${params.length}`;
    // 공개범위(#1291) — 여기는 WHERE 에 직접 걸어도 안전하다: 정렬키가 순수 거리(<=>)가 아니라 가산점을 얹은 score 라
    //  벡터 인덱스의 ORDER BY … LIMIT 경로를 애초에 안 탄다(=근사탐색 사후필터가 아니라 정확 스캔) → 리콜 붕괴 없음.
    const vis = await knowledgeVisWhere(viewer, params);
    // 포함 조건 = (벡터 임계 통과) OR (같은 카테고리) — 카테고리는 임계 미달도 구제. score 로 정렬(가산점 반영), 동점은 최신순.
    const sql = `
      SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
             ${simExpr}::float8 AS similarity,
             ${sharesExpr} AS shares_category,
             (COALESCE(${simExpr}, 0) + CASE WHEN ${sharesExpr} THEN ${boostP}::float8 ELSE 0 END)::float8 AS score
      FROM knowledge k
      WHERE k.lifecycle='active' AND NOT (k.name = ANY(${exclP}))
        AND ( ${simExpr} >= ${minP} OR ${sharesExpr} )
        AND ${vis}
      ORDER BY score DESC, k.updated_at DESC
      LIMIT ${limP}`;
    const rows = await q(itemsPool, sql, params);
    return rows.map((r) => ({
      name: r.name, title: r.title, injection: r.injection, provenance: r.provenance,
      is_wiki: r.is_wiki, summary: r.summary, updated_at: r.updated_at,
      similarity: r.similarity == null ? 0 : Number(r.similarity),
      shares_category: !!r.shares_category, score: Number(r.score),
      snippet: previewBody(r.body_md ?? ""),
    }));
  } catch (e) {
    console.warn(`[embeddings] 추천 지식 조회 실패: ${(e as Error)?.message}`);
    return [];
  }
}

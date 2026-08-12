// v6 knowledge 검색(#1313 R21 — knowledge-store 에서 분리) — grep(렉시컬)·하이브리드(RRF)·유사·추천.
//  분리 이유: CRUD 와 완전히 다른 관심사(질의 계획·벡터·랭킹)인데 한 파일에 있어 검색 튜닝 diff 가 저장 경로와
//  충돌했다. 공개 표면은 그대로 — knowledge-store.ts 가 이 모듈을 재수출하므로 기존 호출부는 무수정.
//  공용 조각(가시성 술어·아이콘 표현식)은 knowledge-common.ts, grep 매처·RRF 상수는 search-util.ts.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { toVectorLiteral } from "./embedding-provider.js";
import {
  type GrepPlan, parseGrep, grepWhere, grepExec, grepSnippet, previewBody,
  RRF_K, HYBRID_CANDIDATES, activeEmbeddingProvider, embedSearchQuery, type SearchDegradeReason,
} from "./search-util.js";
import { type Viewer } from "./visibility.js";
import { knowledgeVisWhere, K_ICON_EXPR } from "./knowledge-common.js";

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
function grepWhereSql(plan: GrepPlan, opts: { injection?: string; provenance?: string }, params: unknown[]): string {
  const wh: string[] = [grepWhere(["k.title", "k.body_md"], plan, params), `k.lifecycle='active'`];
  if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
  return wh.join(" AND ");
}

// mode='count' — 본문/스니펫 없이 매치 총건수만(페이징·존재확인용).
export async function countKnowledgeGrep(
  qstr: string, opts: { injection?: string; provenance?: string } = {}, viewer?: Viewer,
): Promise<number> {
  const { result } = await grepExec(qstr, async (plan) => {
    const params: unknown[] = [];
    const where = grepWhereSql(plan, opts, params);
    // 건수도 뷰어 기준이어야 한다 — 본문을 안 줘도 "그 단어가 들어간 문서가 3건 있다"는 그 자체로 새는 정보다.
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM knowledge k WHERE ${where} AND ${vis}`, params);
    return Number(rows[0]?.n ?? 0);
  });
  return result;
}

export async function searchKnowledge(
  qstr: string,
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number } = {},
  viewer?: Viewer,
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";   // names 모드는 body_md/스니펫 불필요 — 더 얕게 조회
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const { result: rows, plan } = await grepExec(qstr, async (p) => {
    const params: unknown[] = [];
    const where = grepWhereSql(p, opts, params);
    // 렉시컬 채널은 정확 스캔이라 술어를 WHERE 에 그대로 건다(벡터 채널과 달리 리콜 붕괴가 없다 — rrfSearch 주석 참조).
    const vis = await knowledgeVisWhere(viewer, params);
    params.push(Math.min(opts.limit ?? 20, 100));
    return q(itemsPool,
      `SELECT ${sel} FROM knowledge k WHERE ${where} AND ${vis} ORDER BY k.updated_at DESC LIMIT $${params.length}`, params);
  });
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

// 결과 + **어느 채널로 답했는지**(#1644). 폴백을 조용히 하지 않는다 — 부르는 쪽(에이전트·웹)이 알아야
//  "의미검색인데 왜 이것밖에 안 나오지"를 오해하지 않고, 정확 매칭이면 grep 으로 갈아탈 수 있다.
export type KnowledgeSearchChannel = "hybrid" | "lexical";
export interface KnowledgeSearchResult {
  entries: KnowledgeSearchRow[];
  channel: KnowledgeSearchChannel;
  degraded?: SearchDegradeReason | "vector_error";   // lexical 로 떨어진 이유(hybrid 면 없음)
}
export async function hybridSearchKnowledge(
  qstr: string,
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number } = {},
  viewer?: Viewer,
): Promise<KnowledgeSearchResult> {
  const lexical = async (degraded: KnowledgeSearchResult["degraded"]): Promise<KnowledgeSearchResult> =>
    ({ entries: await searchKnowledge(qstr, opts, viewer), channel: "lexical", degraded });
  // 질의 데드라인(query_timeout_ms) 안에 벡터를 못 받으면 기다리지 않고 렉시컬로 간다(#1644 — 큐 대기가 p90 을 9초로 만들었다).
  const { qvec, degraded } = await embedSearchQuery(await activeEmbeddingProvider(), qstr);
  if (!qvec) return lexical(degraded);
  try {
    return { entries: await rrfSearch(qstr, qvec, opts, viewer), channel: "hybrid" };
  } catch (e) {
    console.warn(`[embeddings] 하이브리드 검색 실패 — 렉시컬 폴백: ${(e as Error)?.message}`);
    return lexical("vector_error");                                    // pgvector 컬럼 부재 등 → 폴백
  }
}

// RRF 융합 = SQL 한 방(쿼리 임베딩은 JS 에서 계산해 $n::vector 로 주입). lex/vec CTE 각 후보 → row_number rank → RRF 점수.
async function rrfSearch(
  qstr: string, qvec: number[],
  opts: { injection?: string; provenance?: string; limit?: number; mode?: KnowledgeGrepMode; context?: number },
  viewer?: Viewer,
): Promise<KnowledgeSearchRow[]> {
  const withBody = opts.mode !== "names";
  const sel = withBody ? K_GREP_SEL : K_GREP_NAMES_SEL;
  const limit = Math.min(opts.limit ?? 20, 100);
  const plan = parseGrep(qstr);
  const params: unknown[] = [];
  // 렉시컬 채널 WHERE — grep 매처 + lifecycle='active' + injection/provenance(searchKnowledge 와 동일 의미).
  //  ⚠ 공개범위 술어는 두 후보 CTE 어디에도 넣지 않는다 — **최종 SELECT 한 곳**에서만 건다(아래).
  //   벡터 채널이 HNSW 근사탐색이라 후보 단계에서 걸러내면, 이웃 상위 N 개가 비가시 문서로 채워졌을 때
  //   결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6). 최종 필터로도 이름·본문은 DB 밖으로 안 나가므로 누출은 없다.
  //   (렉시컬 채널만 미리 걸러도 되지만, 술어를 두 군데 쓰면 한쪽만 고치는 사본 결함이 생긴다 — 한 곳으로 모은다.)
  const lexWhere = grepWhereSql(plan, opts, params);
  // 벡터 채널 WHERE — 같은 필터(+ 임베딩 보유 행만). params 공유.
  const vecWh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
  if (opts.injection) { params.push(opts.injection); vecWh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); vecWh.push(`k.provenance=$${params.length}`); }
  const vecWhere = vecWh.join(" AND ");
  params.push(toVectorLiteral(qvec)); const qp = `$${params.length}::vector`;   // 쿼리 벡터(lex/vec 양쪽 참조 가능)
  params.push(HYBRID_CANDIDATES); const candP = `$${params.length}`;
  params.push(RRF_K); const kP = `$${params.length}`;
  const vis = await knowledgeVisWhere(viewer, params);   // 최종 SELECT 전용(위 후보 CTE 주석 참조)
  params.push(limit); const limP = `$${params.length}`;
  const sql = `
    WITH lex AS (
      SELECT k.name, row_number() OVER (ORDER BY k.updated_at DESC) AS rank
      FROM knowledge k WHERE ${lexWhere} ORDER BY k.updated_at DESC LIMIT ${candP}
    ),
    vec AS (
      SELECT k.name, row_number() OVER (ORDER BY k.embedding_vector <=> ${qp}) AS rank
      FROM knowledge k WHERE ${vecWhere} ORDER BY k.embedding_vector <=> ${qp} LIMIT ${candP}
    ),
    fused AS (
      SELECT name, SUM(1.0/(${kP} + rank)) AS score
      FROM (SELECT name, rank FROM lex UNION ALL SELECT name, rank FROM vec) u
      GROUP BY name
    )
    SELECT ${sel}, f.score::float8 AS score
    FROM fused f JOIN knowledge k ON k.name=f.name
    WHERE ${vis}
    ORDER BY f.score DESC LIMIT ${limP}`;
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
export async function findSimilarKnowledge(
  opts: { name?: string; text?: string; limit?: number; minScore?: number; injection?: string; provenance?: string } = {},
  viewer?: Viewer,
): Promise<KnowledgeSimilarRow[]> {
  // 1) 쿼리 벡터 리터럴 확보 — name(저장된 벡터 재사용, 재임베딩 불요) 또는 text(즉시 임베딩).
  let vecLiteral: string | null = null;
  let selfName: string | null = null;
  if (opts.name) {
    selfName = opts.name;
    const r = await one(itemsPool, `SELECT embedding_vector::text AS v FROM knowledge WHERE name=$1`, [opts.name]);
    vecLiteral = (r as { v?: string | null } | undefined)?.v ?? null;   // 대상에 임베딩 없으면 null → []
  } else if (opts.text && opts.text.trim()) {
    const provider = await activeEmbeddingProvider();
    if (!provider) return [];                                            // off → 유사 없음
    // 질의 데드라인 적용(#1644) — 사람이 저장 직전 중복확인을 기다리는 경로다. 늦으면 "유사 없음"으로 끝내는 게 낫다.
    const { qvec } = await embedSearchQuery(provider, opts.text.slice(0, 8000));
    vecLiteral = qvec ? toVectorLiteral(qvec) : null;
  }
  if (!vecLiteral) return [];
  // 2) 최근접 — 코사인 거리 오름차순. 자기 자신·미임베딩·비활성 제외. minScore(코사인 유사도) 이상만.
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const minScore = typeof opts.minScore === "number" ? opts.minScore : 0;
  try {
    const params: unknown[] = [vecLiteral]; const qp = `$1::vector`;     // $1 = 쿼리 벡터(거리·유사도·정렬에 공유)
    const wh: string[] = [`k.lifecycle='active'`, `k.embedding_vector IS NOT NULL`];
    if (selfName) { params.push(selfName); wh.push(`k.name <> $${params.length}`); }
    if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
    if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
    params.push(minScore); const minP = `$${params.length}`;
    // 후보는 요청 건수보다 넓게 뽑는다(공개범위 필터 여유분) — 상한은 실용 캡.
    params.push(Math.min(limit * 10, 500)); const candP = `$${params.length}`;
    params.push(limit); const limP = `$${params.length}`;
    const vis = await knowledgeVisWhere(viewer, params);
    // ⚠ 공개범위 술어를 **후보 스캔(cand)에 넣지 않는다** — 이 스캔이 곧 HNSW 근사탐색(ORDER BY <=> … LIMIT)이라,
    //  거기에 술어를 얹으면 탐색목록(ef_search) 안에서만 사후 필터돼 결과가 통째로 비는 리콜 붕괴가 난다(#1291 R2-#6).
    //  대신 후보를 넓게 뜬 뒤 바깥에서 거른다. minScore 는 거리와 단조라 후보 안에 남겨도 같은 문제가 없다(순서상 뒤).
    //  cand 가 k.visibility 를 실어야 바깥 술어(knowledgeVisSql, 별칭 k)가 그대로 붙는다.
    const sql = `
      WITH cand AS (
        SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
               k.visibility,
               (1 - (k.embedding_vector <=> ${qp}))::float8 AS similarity
        FROM knowledge k
        WHERE ${wh.join(" AND ")} AND (1 - (k.embedding_vector <=> ${qp})) >= ${minP}
        ORDER BY k.embedding_vector <=> ${qp}
        LIMIT ${candP}
      )
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
      qvec = (await embedSearchQuery(provider, opts.text.slice(0, 8000))).qvec;   // 질의 데드라인(#1644) — 늦으면 카테고리만으로 추천(graceful)
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

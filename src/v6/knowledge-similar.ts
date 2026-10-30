// v6 knowledge 유사·추천(knowledge-search.ts 에서 분리) — 코사인 유사도로 가까운 지식을 찾는다. 찾기(grep · 하이브리드)와 달리 점수가 절대값이라 기준선을 걸 수 있다.
//  공개 표면은 그대로 — knowledge-store.ts 가 이 모듈을 재수출한다.
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { toVectorLiteral } from "./embedding-provider.js";
import { previewBody, activeEmbeddingProvider, embedQuery, withHnswScan } from "./search-util.js";
import { type Viewer } from "./visibility.js";
import { knowledgeVisWhere } from "./knowledge-common.js";
import { knowledgeCategoryRestriction, knowledgeInCategoriesSql } from "./read-scope.js";

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
    //  #5169 검색 제외 문서는 기준이 되지 않는다 — 벡터가 없어야 하지만(끌 때 비운다) 비우기가 best-effort 라 표시로도 막는다.
    const r = await one(itemsPool, `SELECT embedding_vector::text AS v FROM knowledge WHERE name=$1 AND searchable`, [opts.name]);
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
    //  #5169 검색 제외는 이웃 후보에서 뺀다 — 자동 소환 훅(knowledge-recall)·⌘K «뜻 비슷»·문서의 관련 지식이 모두 이 길이다.
    const wh: string[] = [`k.lifecycle='active'`, `k.searchable`, `k.embedding_vector IS NOT NULL`];
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
    const rows = await withHnswScan((db) => q(db, sql, params));
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
    //  #5169 검색 제외는 뺀다 — 카테고리 구제는 벡터가 없어도 고르므로 술어가 없으면 그대로 섞인다(도메인 소환 훅 leaf 가 이 길).
    const sql = `
      SELECT k.name, k.title, k.injection, k.provenance, k.is_wiki, k.summary, k.updated_at, k.body_md,
             ${simExpr}::float8 AS similarity,
             ${sharesExpr} AS shares_category,
             (COALESCE(${simExpr}, 0) + CASE WHEN ${sharesExpr} THEN ${boostP}::float8 ELSE 0 END)::float8 AS score
      FROM knowledge k
      WHERE k.lifecycle='active' AND k.searchable AND NOT (k.name = ANY(${exclP}))
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

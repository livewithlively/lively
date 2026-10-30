// v6/knowledge-chunk-search.ts — 조각으로 찾기(#5204 · 프로젝트 #5198). 찾기의 벡터 채널과 자동 소환이 문서 벡터 대신 조각 벡터(knowledge_chunk)를 본다.
//
//  왜 — 문서 벡터는 앞 2,048토큰만 보고 끝에 덧붙인 글을 못 본다. 판정 200+200 질의의 nDCG@5 가 사람 프롬프트 0.468 → 0.525, 에이전트 검색어 0.650 → 0.705 로 올랐고,
//   자동 소환은 프롬프트 400개 환산 주입 수가 비슷한 채 유의미 주입 144 → 260, 무관 주입 359 → 252 였다. 이 파일의 SQL 을 실제 지식에 돌려 잰 값이다(지식 research-1617-chunk-search-combination-2026-10-31).
//
//  ── 언제 조각을 쓰나(chunkIndex) ──
//   스위치가 켜져 있고(org_runtime_config.knowledge_chunk_search — 되돌리기) 조각의 98% 에 지금 모델의 벡터가 있을 때다. 첫 색인은 하루 상한 때문에 며칠 걸리고 모델을 바꾸면
//   다시 채운다. 그동안은 문서 벡터로 찾는다 — 찾을 수 있던 문서가 잠깐 안 나오면 안 된다. 찾기와 소환의 바깥 모양은 같다.
//
//  ── 공용 인덱스 ──
//   공용 DB 는 한 HNSW 에 모든 워크스페이스의 조각이 있고 행 보안은 인덱스 탐색 뒤에 걸린다. 실제 조각 벡터를 다섯 워크스페이스로 나눠 FORCE RLS 로 재면(비중 0.3~53%) 작은 쪽은
//   플래너가 워크스페이스 행만 정확히 재고 큰 쪽만 HNSW 를 탔다 — ef 400 에서 문서 상위 10 재현율 0.98 이상 · 빈 결과 0건이었다. iterative_scan 은 이 구간에서 차이가 없었고,
//   표가 커져 플래너가 작은 워크스페이스에도 HNSW 를 고를 때의 안전망으로 켠다(pgvector 0.8 부터 · 40만 조각 표의 2% 워크스페이스에서 후보 5~8개 → 200개).
//
//  ── 왜 문서 벡터를 섞지 않나 ──
//   문서 벡터(제목 · 요약 포함)를 RRF 세 번째 채널로 더하면 판정 200+200 에서 오히려 낮았다(사람 −0.055~−0.002 · 에이전트 −0.062~−0.025). 조각 점수에 큰 값으로 섞어도 구간 안이었다.
import type { PoolClient } from "pg";
import { boundTenantId, itemsPool, one, q, withTx } from "../db/client.js";
import { toVectorLiteral } from "./embedding-provider.js";
import { activeEmbedding, embedQuery } from "./search-util.js";
import { type Viewer } from "./visibility.js";
import { knowledgeVisWhere } from "./knowledge-common.js";
import { knowledgeCategoryRestriction, knowledgeInCategoriesSql } from "./read-scope.js";
import { type KnowledgeSimilarRow, type SimilarDiag, findSimilarKnowledge } from "./knowledge-similar.js";

/** 벡터 채널이 보는 조각 수 — 문서로 접으면 질의당 80~180건이라 채널 후보 50건을 채운다. */
const CHUNK_CANDIDATES = 200;
const CHUNK_EF_SEARCH = 400;
const CHUNK_READY_RATIO = 0.98;
const CHUNK_READY_TTL_MS = 30_000;

//  자동 소환 — 측정해 정한 값 그대로다(바꾸면 다시 잰다). 조각 최고값은 문서 벡터보다 높게 나와 기준선도 다르다.
//  기준선은 그 모델의 코사인 분포에서 잰 값이라 다른 모델에는 쓰지 않는다 — 다른 모델은 찾기만 조각으로 하고(순위만 쓴다) 소환은 문서 벡터 그대로다.
const RECALL_CHUNK_MIN = 0.66;
const RECALL_CHUNK_MODELS = /bge-m3/i;
const RECALL_DOC_MIN = 0.6;
const RECALL_LIMIT = 4;
const RECALL_QUERY_CHARS = 1000;
const RECALL_DOC_QUERY_CHARS = 2000;
const RECALL_SHORT_CHARS = 100;
const RECALL_PREV_CHARS = 300;

const SNIPPET_CHARS = 160;
const RECALL_SNIPPET_CHARS = 100;
const SECTION_CHARS = 60;

export interface ChunkIndex { cast: "halfvec" | "vector"; iterative: boolean; model: string }
const ready = new Map<string, { value: ChunkIndex | null; at: number }>();

/** pgvector 가 반복 탐색(hnsw.iterative_scan)을 아나 — 0.8 부터다. 옛 판에 그 값을 설정하면 오류다. */
export function iterativeScanSupported(version: string | null | undefined): boolean {
  const [major, minor] = String(version ?? "").split(".").map(Number);
  return major > 0 || minor >= 8;
}

/** 자동 소환이 조각을 쓰나 — 기준선을 잰 모델일 때만이다. */
export const recallUsesChunks = (ix: ChunkIndex | null): boolean => !!ix && RECALL_CHUNK_MODELS.test(ix.model);

/** 조각으로 찾아도 되나 — 안 되면 null(문서 벡터로 찾는다). 워크스페이스마다 30초 기억한다. 표나 칸이 없어도 던지지 않는다. */
export async function chunkIndex(now: () => number = Date.now): Promise<ChunkIndex | null> {
  const key = boundTenantId() ?? "";
  const hit = ready.get(key);
  if (hit && now() - hit.at < CHUNK_READY_TTL_MS) return hit.value;
  let value: ChunkIndex | null = null;
  try {
    const model = (await activeEmbedding())?.provider.model;
    if (model) {
      const r = await one(itemsPool,
        `SELECT (SELECT knowledge_chunk_search FROM org_runtime_config WHERE id=1) AS enabled,
                (SELECT format_type(atttypid, NULL) FROM pg_attribute WHERE attrelid = to_regclass('knowledge_chunk') AND attname='embedding_vector' AND NOT attisdropped) AS vtype,
                (SELECT extversion FROM pg_extension WHERE extname='vector') AS ver,
                count(*)::int AS total,
                count(*) FILTER (WHERE embedding_vector IS NOT NULL AND embedding_model = $1)::int AS have
           FROM knowledge_chunk`, [model]) as { enabled: boolean | null; vtype: string | null; ver: string | null; total: number; have: number };
      if (r.enabled !== false && r.vtype && r.total > 0 && r.have >= r.total * CHUNK_READY_RATIO) {
        value = { cast: r.vtype === "halfvec" ? "halfvec" : "vector", iterative: iterativeScanSupported(r.ver), model };
      }
    }
  } catch { value = null; }
  ready.set(key, { value, at: now() });
  return value;
}
/** 기억을 비운다 — 스위치를 바꾼 프로세스는 곧바로 따른다(다른 프로세스는 30초 안에). */
export function resetChunkIndex(): void { ready.clear(); }

/** 조각 근사탐색을 넓혀 돌린다. 값은 트랜잭션 안에서만 산다. */
export async function withChunkScan<T>(ix: ChunkIndex, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return withTx(async (c) => {
    await c.query(`SET LOCAL hnsw.ef_search = ${CHUNK_EF_SEARCH}`);
    if (ix.iterative) await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return fn(c);
  });
}

/**
 * 가까운 조각을 문서마다 하나로 접는 CTE(chits → cbest) — cbest 는 (id, name, dist)다.
 *  poolWhere 가 있으면(카테고리 · 주입 · 출처 제한) 제한 안 행을 먼저 떠서 정확히 잰다. 근사탐색 뒤에 걸면 제한 밖 이웃이 후보를 채워 결과가 빈다(knowledge-search vecChannel 과 같은 까닭).
 *  수명 · 검색 제외는 접은 뒤 호출부가 건다 — 지운 문서의 조각은 스윕이 곧 걷으므로 탐색에 얹을 만큼 흔하지 않다.
 */
function chunkHitsSql(ix: ChunkIndex, qp: string, poolWhere: string | null): string {
  const qv = `${qp}::${ix.cast}`;
  const chits = poolWhere === null
    ? `chits AS (
      SELECT c.id, c.name, c.embedding_vector <=> ${qv} AS dist FROM knowledge_chunk c
       WHERE c.embedding_vector IS NOT NULL ORDER BY c.embedding_vector <=> ${qv} LIMIT ${CHUNK_CANDIDATES}
    )`
    : `vpool AS MATERIALIZED (
      SELECT c.id, c.name, c.embedding_vector FROM knowledge_chunk c JOIN knowledge k ON k.name = c.name
       WHERE c.embedding_vector IS NOT NULL AND ${poolWhere}
    ),
    chits AS (
      SELECT p.id, p.name, p.embedding_vector <=> ${qv} AS dist FROM vpool p ORDER BY p.embedding_vector <=> ${qv} LIMIT ${CHUNK_CANDIDATES}
    )`;
  return `${chits},
    cbest AS (SELECT DISTINCT ON (name) id, name, dist FROM chits ORDER BY name, dist)`;
}

/** 찾기의 벡터 채널(vec) — (name, chunk_id, rank). 문서 벡터 채널(vecChannel)과 같은 자리에 들어간다. */
export function chunkVecChannel(ix: ChunkIndex, docWhere: string, qp: string, candP: string, restricted: boolean): string {
  return `${chunkHitsSql(ix, qp, restricted ? docWhere : null)},
    vec AS (
      SELECT b.name, b.id AS chunk_id, row_number() OVER (ORDER BY b.dist) AS rank
        FROM cbest b JOIN knowledge k ON k.name = b.name WHERE ${docWhere} ORDER BY b.dist LIMIT ${candP}
    )`;
}

const flat = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);
/** 앞 n 자 — 서로게이트 쌍을 가르지 않는다. 짝 잃은 글자는 엄격한 임베딩 서버가 거절해 그 프롬프트의 소환만 조용히 사라진다. */
const headChars = (s: string, n: number): string => {
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
};

/** 찾기 결과의 스니펫 — 맞은 절의 시작 줄 · 경로 · 글 앞부분. grep 스니펫과 같은 `L<n>:` 꼴이라 knowledge_get offset 으로 그대로 읽고, 화면도 같은 규칙으로 줄 표시를 뗀다. */
export function chunkSnippet(c: { start_line: number; path: string; body: string }): string {
  return `L${c.start_line}: ${c.path ? `«${c.path.slice(0, SECTION_CHARS)}» ` : ""}${flat(c.body, SNIPPET_CHARS)}`;
}

/** 소환 질의 — 프롬프트 앞 1,000자. 짧은 프롬프트(«응 그걸로 해»)는 그것만으로 찾을 수 없어 앞 턴 사람 말을 앞에 붙인다. */
export function recallQueryText(text: string, prev?: string | null): string {
  const t = String(text ?? "").trim();
  const p = headChars(String(prev ?? "").trim(), RECALL_PREV_CHARS);
  return headChars(t.length < RECALL_SHORT_CHARS && p ? `${p}\n${t}` : t, RECALL_QUERY_CHARS);
}

export interface KnowledgeRecallRow extends Pick<KnowledgeSimilarRow, "name" | "title" | "similarity" | "snippet"> {
  line?: number;       // 맞은 절의 시작 줄(1부터) — 문서 벡터로 찾았으면 없다
  section?: string;    // 맞은 절의 경로
}
export type RecallDiag = SimilarDiag & { route?: "chunk" | "vector" };

/**
 * 자동 소환 — 사람 프롬프트에 넣을 지식 고르기. 기준선 · 건수 · 질의를 여기서 정한다(훅은 프롬프트만 넘긴다 — 되돌릴 때 훅을 안 바꿔도 된다).
 *  순서는 코사인이다(측정한 정책 그대로). 훅 시간 상한(4초) 안의 길이라 낱말 조회는 더하지 않는다.
 */
export async function recallKnowledge(input: { text: string; prev?: string | null }, viewer?: Viewer, diag: RecallDiag = {}): Promise<KnowledgeRecallRow[]> {
  const byDoc = async (): Promise<KnowledgeRecallRow[]> => {
    diag.route = "vector";
    return findSimilarKnowledge({ text: headChars(input.text, RECALL_DOC_QUERY_CHARS), limit: RECALL_LIMIT, minScore: RECALL_DOC_MIN }, viewer, diag);
  };
  const ix = await chunkIndex();
  if (!ix || !recallUsesChunks(ix)) return byDoc();
  const qe = await embedQuery(recallQueryText(input.text, input.prev));
  if (qe.status === "off") { diag.embeddings = "off"; return []; }
  if (!qe.vec) { diag.degraded = true; return []; }
  diag.route = "chunk";
  try {
    const categories = await knowledgeCategoryRestriction(viewer);
    const params: unknown[] = [toVectorLiteral(qe.vec)];
    const wh = [`k.lifecycle='active'`, `k.searchable`];
    if (categories) wh.push(knowledgeInCategoriesSql(categories, params, "k"));
    const docWhere = wh.join(" AND ");
    params.push(RECALL_CHUNK_MIN); const minP = `$${params.length}`;
    params.push(RECALL_LIMIT); const limP = `$${params.length}`;
    const vis = await knowledgeVisWhere(viewer, params);   // 맨 끝에서만 건다(후보에 걸면 근사탐색 결과가 빈다 — knowledge-search rrfSearch 주석)
    const sql = `
      WITH ${chunkHitsSql(ix, "$1", categories ? docWhere : null)}
      SELECT k.name, k.title, (1 - b.dist)::float8 AS similarity, c.start_line, c.path, c.body
        FROM cbest b JOIN knowledge k ON k.name = b.name JOIN knowledge_chunk c ON c.id = b.id
       WHERE ${docWhere} AND (1 - b.dist) >= ${minP} AND ${vis}
       ORDER BY b.dist LIMIT ${limP}`;
    const rows = await withChunkScan(ix, (db) => q(db, sql, params));
    return rows.map((r) => ({
      name: r.name, title: r.title, similarity: Number(r.similarity), line: Number(r.start_line),
      section: String(r.path ?? "").slice(0, SECTION_CHARS), snippet: flat(String(r.body ?? ""), RECALL_SNIPPET_CHARS),
    }));
  } catch (e) {
    console.warn(`[embeddings] 조각 소환 실패 — 문서 벡터로: ${(e as Error)?.message}`);
    return byDoc();
  }
}

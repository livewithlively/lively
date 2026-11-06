// v6/knowledge-lex-store.ts — 지식 낱말 색인(BM25)을 knowledge 에 맞춰 둔다(#5201 · 프로젝트 #5198). 규칙은 knowledge-lex.ts.
//
//  ── 쓰는 길을 하나로 — 스윕 ──
//   knowledge 에 쓰는 길은 저장 · 커넥터 미러 · 수정 승인 · 세션 기록 · 시드로 여럿이고 run-sync 자식 프로세스도 있다. 길마다 색인을 고치면 빠지는 자리가
//   생긴다. 그래서 **knowledge.updated_at 과 색인의 source_updated_at 을 견주는 스윕 하나**가 맞춘다. 저장 길만 그 문서를 곧바로 맞춘다(저장 → 곧 이름으로 찾기).
//   낱말을 만들고 표에 넣는 일은 HTTP 가 없어 빠르지만 저장 트랜잭션에 얹지 않는다 — 실패가 저장을 막으면 안 된다.
//
//  조각(#5203 — knowledge_chunk)도 같은 스윕이 맞춘다. 글이 같은 조각은 벡터를 그대로 두고 자리만 고친다 — 끝 덧붙임이 끝의 조각만 다시 임베딩하게. 벡터는 임베딩 백필이 채운다.
//
//  ── 문서 하나의 맞춤 ──
//   같은 문서를 두 프로세스(청/녹 교대)가 동시에 맞춰도 되도록 문서별 자문 잠금 안에서 **최신 행을 읽어** 맞춘다. 글이 안 바뀌었으면(hash) 시각만 올린다.
//   낱말은 바뀐 것만 고친다 — 지식 수정의 88.8% 가 끝 덧붙이기라(세션 기록 10-14~27 측정) 통째로 지우고 넣으면 죽은 행만 쌓여 인덱스 전용 조회가 무뎌진다.
//
//  색인이 덜 찼을 때(배포 직후 · 새 워크스페이스) 검색은 lexReady 로 종전 grep 채널을 쓴다.
//  다시 만들기 — 낱말 · 조각 규칙을 바꾸면 LEX_RULES_VERSION · CHUNK_RULES_VERSION 을 올린다(스윕이 다시 만든다). 표를 비울 때는 knowledge_lex_doc · knowledge_lex_posting ·
//   knowledge_chunk 를 같이 비운다 — knowledge_lex_doc 만 남으면 글이 그대로라고 보고 다시 안 넣는다.
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { boundTenantId, itemsPool, one, q, withTx } from "../db/client.js";
import { LEX_RULES_VERSION, lexDocText, lexTermFreq, lexTokens } from "./knowledge-lex.js";
import { CHUNK_RULES_VERSION, type KnowledgeChunk, chunkKnowledge } from "./knowledge-chunk.js";
import { embedChunksSoon } from "./embedding-backfill.js";

/** 한 판의 시간 상한 — 공용 DB 를 오래 붙들지 않게. 밀린 것은 다음 판(1분 뒤)이 잇는다(문서 2,760개는 서너 판이면 끝난다). */
export const LEX_SWEEP_BUDGET_MS = 20_000;
const LEX_SWEEP_BATCH = 100;
/** 프로세스 전체에서 동시에 도는 스윕 수 — 롤 직후 모든 워크스페이스가 한꺼번에 첫 색인을 시작해도 풀(20개)을 먹지 않게. 못 든 쪽은 다음 판(1분 뒤)에 돈다. */
const LEX_SWEEP_CONCURRENCY = 2;
/** 색인이 이만큼 찼으면 쓴다 — 방금 저장한 몇 건이 비었다고 grep 으로 돌아가지 않게. */
const LEX_READY_RATIO = 0.98;
const LEX_READY_TTL_MS = 30_000;

export type LexSyncResult = "indexed" | "partial" | "unchanged" | "removed" | "absent";

const tenantKey = (): string => boundTenantId() ?? "";

/** 지식 한 건을 색인(낱말 · 조각)에 맞춘다(없거나 검색 대상이 아니면 색인에서 뺀다). 트랜잭션 하나다. */
export async function syncKnowledgeLex(name: string): Promise<LexSyncResult> {
  return withTx(async (c) => {
    //  열쇠에 워크스페이스를 넣는다 — 공용 DB 에서는 시드 지식처럼 이름이 같은 문서가 워크스페이스마다 있다.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`knowledge_lex:${tenantKey()}:${name}`]);
    const k = await one(c, `SELECT name, title, body_md, lifecycle, searchable, updated_at::text AS at FROM knowledge WHERE name=$1`, [name]) as
      { name: string; title: string | null; body_md: string | null; lifecycle: string; searchable: boolean; at: string } | undefined;
    const prev = await one(c, `SELECT id, content_hash, rules_version, chunk_key FROM knowledge_lex_doc WHERE name=$1`, [name]) as
      { id: string; content_hash: string; rules_version: number; chunk_key: string | null } | undefined;
    if (!k || k.lifecycle !== "active" || !k.searchable) {
      //  조각 표가 없어도 낱말 색인은 걷는다(아래 맞춤과 같은 까닭).
      await c.query(`SAVEPOINT chunks`);
      const chunks = await c.query(`DELETE FROM knowledge_chunk WHERE name=$1`, [name]).catch(async () => { await c.query(`ROLLBACK TO SAVEPOINT chunks`); return null; });
      if (!prev && !chunks?.rowCount) return "absent";
      if (prev) {
        await c.query(`DELETE FROM knowledge_lex_posting WHERE doc_id=$1`, [prev.id]);
        await c.query(`DELETE FROM knowledge_lex_doc WHERE id=$1`, [prev.id]);
      }
      return "removed";
    }
    const text = lexDocText(k);
    const hash = crypto.createHash("md5").update(text).digest("hex");
    const lexFresh = prev?.content_hash === hash && prev.rules_version === LEX_RULES_VERSION;
    const key = chunkKey(hash);
    const chunksFresh = prev?.chunk_key === key;
    //  조각이 실패해도 낱말 색인은 맞춘다 — 조각은 아직 검색이 안 읽어도 낱말은 읽는다. 표식(chunk_key)을 안 올려 스윕이 다시 집는다.
    let chunked = chunksFresh;
    if (!chunksFresh) {
      await c.query(`SAVEPOINT chunks`);
      try { await syncChunks(c, k); chunked = true; }
      catch (e) {
        await c.query(`ROLLBACK TO SAVEPOINT chunks`);
        console.warn(`[knowledge-lex] 조각 맞춤 실패(다음 판에 다시) ${name}: ${(e as Error)?.message}`);
      }
    }
    const nextKey = chunked ? key : (prev?.chunk_key ?? null);
    if (lexFresh) {
      await c.query(`UPDATE knowledge_lex_doc SET source_updated_at=$2::timestamptz, chunk_key=$3 WHERE id=$1`, [prev.id, k.at, nextKey]);
      return chunksFresh ? "unchanged" : chunked ? "indexed" : "partial";
    }
    const tokens = lexTokens(text);
    const doc = await one(c,
      `INSERT INTO knowledge_lex_doc(name, doc_len, content_hash, rules_version, chunk_key, source_updated_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz)
       ON CONFLICT (tenant_id, name) DO UPDATE SET doc_len=EXCLUDED.doc_len, content_hash=EXCLUDED.content_hash, rules_version=EXCLUDED.rules_version,
         chunk_key=EXCLUDED.chunk_key, source_updated_at=EXCLUDED.source_updated_at
       RETURNING id`, [name, tokens.length, hash, LEX_RULES_VERSION, nextKey, k.at]) as { id: string };
    const next = lexTermFreq(tokens);
    const cur = new Map<string, number>();
    if (prev) for (const r of await q(c, `SELECT term, tf FROM knowledge_lex_posting WHERE doc_id=$1`, [doc.id])) cur.set(String(r.term), Number(r.tf));
    const gone = [...cur.keys()].filter((t) => !next.has(t));
    const put = [...next].filter(([t, f]) => cur.get(t) !== f);
    if (gone.length) await c.query(`DELETE FROM knowledge_lex_posting WHERE doc_id=$1 AND term = ANY($2::text[])`, [doc.id, gone]);
    if (put.length) {
      await c.query(
        `INSERT INTO knowledge_lex_posting(term, doc_id, tf) SELECT t, $1::bigint, f FROM unnest($2::text[], $3::int[]) AS u(t, f)
         ON CONFLICT (tenant_id, term, doc_id) DO UPDATE SET tf=EXCLUDED.tf`,
        [doc.id, put.map(([t]) => t), put.map(([, f]) => f)]);
    }
    return chunked ? "indexed" : "partial";
  });
}

/** 조각을 맞춘 글 · 규칙의 표식 — 옛 이미지가 글만 고친 문서(롤 중)도 어긋남으로 잡힌다. */
const chunkKey = (contentHash: string): string => `${contentHash}:${CHUNK_RULES_VERSION}`;

/** 조각 표를 문서에 맞춘다. 글이 같은 조각은 행을 그대로 둬 벡터를 살리고 자리만 고친다 — 새 글만 벡터 없이 들어가 임베딩 백필을 기다린다. */
async function syncChunks(c: PoolClient, d: { name: string; title: string | null; body_md: string | null }): Promise<void> {
  const next = chunkKnowledge(d);
  const rows = await q(c, `SELECT id, seq, start_line, path, text_hash FROM knowledge_chunk WHERE name=$1`, [d.name]) as
    Array<{ id: string; seq: number; start_line: number; path: string; text_hash: string }>;
  const left = new Map<string, typeof rows>();
  for (const r of rows) left.set(r.text_hash, [...(left.get(r.text_hash) ?? []), r]);
  const add: KnowledgeChunk[] = [];
  const moved: Array<{ id: string; ch: KnowledgeChunk }> = [];
  for (const ch of next) {
    const r = left.get(ch.hash)?.shift();
    if (!r) add.push(ch);
    else if (r.seq !== ch.seq || r.start_line !== ch.startLine || r.path !== ch.path) moved.push({ id: r.id, ch });
  }
  const gone = [...left.values()].flat().map((r) => r.id);
  if (gone.length) await c.query(`DELETE FROM knowledge_chunk WHERE id = ANY($1::bigint[])`, [gone]);
  if (moved.length) {
    await c.query(
      `UPDATE knowledge_chunk k SET seq=u.seq, start_line=u.line, path=u.path, updated_at=now()
         FROM unnest($1::bigint[], $2::int[], $3::int[], $4::text[]) AS u(id, seq, line, path) WHERE k.id = u.id`,
      [moved.map((m) => m.id), moved.map((m) => m.ch.seq), moved.map((m) => m.ch.startLine), moved.map((m) => m.ch.path)]);
  }
  if (add.length) {
    await c.query(
      `INSERT INTO knowledge_chunk(name, seq, start_line, path, prefix, body, text_hash)
       SELECT $1, s, l, p, x, b, h FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[]) AS u(s, l, p, x, b, h)`,
      [d.name, add.map((a) => a.seq), add.map((a) => a.startLine), add.map((a) => a.path), add.map((a) => a.prefix), add.map((a) => a.body), add.map((a) => a.hash)]);
  }
}

/** 저장 뒤 그 문서를 곧바로 맞춘다 — 기다리지 않고 던지지 않는다. 실패하면 스윕이 줍는다. */
export function syncKnowledgeLexSoon(name: string): void {
  void syncKnowledgeLex(name)
    .then((r) => { if (r === "indexed") embedChunksSoon(name); })
    .catch((e) => console.warn(`[knowledge-lex] 색인 실패(스윕이 다시) ${name}: ${(e as Error)?.message}`));
}

const sweeping = new Set<string>();

/** 밀린 문서를 맞추고 빠진 문서를 걷는다. 워크스페이스마다 하나만 돈다. 부르는 쪽은 테넌트 컨텍스트 안이다(정비표 · perTenant). */
export async function sweepKnowledgeLex(budgetMs: number = LEX_SWEEP_BUDGET_MS): Promise<{ indexed: number; removed: number; failed: number }> {
  const out = { indexed: 0, removed: 0, failed: 0 };
  const key = tenantKey();
  if (sweeping.has(key) || sweeping.size >= LEX_SWEEP_CONCURRENCY) return out;
  sweeping.add(key);
  const deadline = Date.now() + budgetMs;
  //  한 번 실패한 문서는 이번 판에서 다시 집지 않는다 — 시간 상한까지 같은 문서만 붙들지 않게.
  const failed = new Set<string>();
  const sync = async (name: string): Promise<void> => {
    try {
      const r = await syncKnowledgeLex(name);
      if (r === "indexed") out.indexed++;
      else if (r === "removed") out.removed++;
      else if (r === "partial") { failed.add(name); out.failed++; }   // 다음 판에 다시 — 이번 판에서 같은 문서를 다시 집지 않는다
    } catch (e) {
      failed.add(name); out.failed++;
      console.warn(`[knowledge-lex] 색인 실패(다음 판에 다시) ${name}: ${(e as Error)?.message}`);
    }
  };
  try {
    const stale = await q(itemsPool,
      `SELECT d.name FROM knowledge_lex_doc d LEFT JOIN knowledge k ON k.name = d.name AND k.lifecycle='active' AND k.searchable
        WHERE k.name IS NULL LIMIT ${LEX_SWEEP_BATCH * 5}`);
    //  낱말 색인 행 없이 조각만 남은 이름 — 롤 중 옛 이미지가 지운 문서다. 조각 표가 없는 창에서도 낱말 쪽 정비는 돌아야 해서 따로 묻는다.
    const orphans = await q(itemsPool,
      `SELECT DISTINCT c.name FROM knowledge_chunk c LEFT JOIN knowledge k ON k.name = c.name AND k.lifecycle='active' AND k.searchable
        WHERE k.name IS NULL LIMIT ${LEX_SWEEP_BATCH * 5}`).catch(() => []);
    for (const r of [...stale, ...orphans]) { await sync(String(r.name)); if (Date.now() > deadline) return out; }
    for (;;) {
      const rows = await q(itemsPool,
        `SELECT k.name FROM knowledge k LEFT JOIN knowledge_lex_doc d ON d.name = k.name
          WHERE k.lifecycle='active' AND k.searchable AND NOT (k.name = ANY($1::text[]))
            AND (d.id IS NULL OR d.source_updated_at <> k.updated_at OR d.rules_version <> $2 OR d.chunk_key IS DISTINCT FROM d.content_hash || ':' || $3::text)
          ORDER BY k.updated_at DESC LIMIT ${LEX_SWEEP_BATCH}`, [[...failed], LEX_RULES_VERSION, String(CHUNK_RULES_VERSION)]);
      if (!rows.length) return out;
      for (const r of rows) { await sync(String(r.name)); if (Date.now() > deadline) return out; }
    }
  } finally {
    sweeping.delete(key);
    readyCache.delete(key);
  }
}

const readyCache = new Map<string, { ready: boolean; at: number }>();
/**
 * 낱말 색인을 검색에 써도 되나 — 검색 대상 지식의 98% 이상이 색인에 있을 때. 30초 기억한다. 못 재면(표가 없는 구 DB 등) false 라 종전 grep 채널로 간다.
 *  던지지 않는다.
 */
export async function lexReady(now: () => number = Date.now): Promise<boolean> {
  const key = tenantKey();
  const hit = readyCache.get(key);
  if (hit && now() - hit.at < LEX_READY_TTL_MS) return hit.ready;
  let ready = false;
  try {
    const r = await one(itemsPool,
      `SELECT count(*)::int AS total, count(d.id)::int AS have FROM knowledge k LEFT JOIN knowledge_lex_doc d ON d.name = k.name
        WHERE k.lifecycle='active' AND k.searchable`) as { total: number; have: number };
    ready = r.total > 0 && r.have >= r.total * LEX_READY_RATIO;
  } catch { ready = false; }
  readyCache.set(key, { ready, at: now() });
  return ready;
}
/** 시험 전용 — 기억을 비운다. */
export function __resetLexReady(): void { readyCache.clear(); }

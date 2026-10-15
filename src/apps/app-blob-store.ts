// 앱 판 묶음의 파일 내용 저장소(#4481 앱 v2-2) — 파일 하나 = 내용 지문(sha256) 이름의 객체 하나. 판이 달라도 같은 파일은 한 벌.
//
//  어디에: 매니지드 = S3(LIVELY_APP_BUNDLE_BUCKET, 키 `<prefix>t/<워크스페이스 id>/b/<sha256>`) · 그 밖(자가호스팅) = DB 표 org_app_blob 의 bytes 칸.
//   판 목록·파일 목록은 org_app_version(bundle 칸)이 정본이고 여기는 내용만 둔다(설계 §3-F). 워크스페이스마다 키 앞자리를 갈라
//   지문이 같아도 남의 워크스페이스 객체를 가리키지 않는다(지문으로 «있나» 를 묻는 길이 다른 워크스페이스로 새지 않게).
//
//  ★ 장부 = org_app_blob 한 줄(지문 · 저장소 · 크기 · stored · last_used_at). 모든 판 쓰기는 **파일을 가리키기 전에** storeBlobs 로
//   장부를 먼저 «방금 씀» 으로 찍는다. 정리(gcBlobs)는 장부 줄을 FOR UPDATE 로 잠근 채 «24시간 안 쓰였고 · 어떤 판도 안 가리킴» 을
//   다시 본 뒤에만 객체를 지운다 — 그래서 «지금 막 같은 파일을 다시 쓰려는 저장» 과 엇갈려도 살아 있는 파일을 지우지 않는다:
//   저장이 먼저 찍으면 정리가 «방금 쓰임» 을 보고 건너뛰고, 정리가 먼저 잠그면 저장의 찍기가 기다렸다가 새 줄(stored=false)로 들어가
//   다시 올린다. stored 는 객체를 실제로 올린 뒤에만 true — 올리다 실패한 줄을 «있음» 으로 믿고 건너뛰지 않는다.
//  읽기 캐시: 지문 이름이라 바뀌지 않는다(무효화가 없다) — 작은 파일만 메모리에 둔다(앱 주소가 같은 파일을 거듭 낸다).
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type pg from "pg";
import { itemsPool, boundTenantId } from "../db/client.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import { S3Error, s3Delete, s3Get, s3GetStream, s3Put, type S3Config, type S3Deps } from "../net/aws/s3-lite.js";

export type BlobStoreKind = "s3" | "db";
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const sha256Hex = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

/** S3 설정 — 버킷이 없으면 null(= DB 저장소). 지역은 LIVELY_APP_BUNDLE_REGION > AWS_REGION > 서울. */
export function appBundleS3Config(env: NodeJS.ProcessEnv = process.env): (S3Config & { prefix: string }) | null {
  const bucket = String(env.LIVELY_APP_BUNDLE_BUCKET ?? "").trim();
  if (!bucket) return null;
  const region = String(env.LIVELY_APP_BUNDLE_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "").trim() || "ap-northeast-2";
  const endpoint = String(env.LIVELY_APP_BUNDLE_ENDPOINT ?? "").trim() || undefined;
  //  앞자리(prefix)는 한 버킷을 여러 배포가 나눠 쓸 때(시험·스테이지) — 끝에 / 를 하나만.
  const p = String(env.LIVELY_APP_BUNDLE_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "");
  return { bucket, region, endpoint, prefix: p ? p + "/" : "" };
}

/** 새로 쓰는 판이 갈 저장소. 판 행은 제 저장소를 적어 두므로(bundle_store) 나중에 설정이 바뀌어도 옛 판은 제자리에서 읽힌다. */
export const defaultBlobStoreKind = (env: NodeJS.ProcessEnv = process.env): BlobStoreKind => (appBundleS3Config(env) ? "s3" : "db");

/** 지금 워크스페이스 — DB 바인딩과 같은 값(행의 tenant_id 와 S3 키 앞자리가 늘 같은 워크스페이스를 가리킨다). */
export const blobTenant = (): string => boundTenantId() ?? SINGLE_TENANT_ID;
export const s3BlobKey = (prefix: string, tenant: string, h: string): string => `${prefix}t/${tenant}/b/${h}`;

let s3DepsForTest: S3Deps | undefined;
/** 시험용 — S3 호출을 가짜 fetch 로. */
export function setBlobS3DepsForTest(d: S3Deps | undefined): void { s3DepsForTest = d; }
/** S3 실패 → 사람이 읽을 503(자격 없음 · 권한 · 일시 오류). 그 밖의 오류는 그대로. */
async function viaS3<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof S3Error) {
      logger.error({ code: e.code, status: e.status, what }, "앱 판 파일 저장소(S3) 실패(#4481)");
      throw new HttpError(503, `앱 파일 저장소(S3)에 닿지 못했습니다(${what} · ${e.code}) — 잠시 뒤 다시 하세요. 계속되면 운영자에게 알려 주세요`);
    }
    throw e;
  }
}

function s3OrThrow(): S3Config & { prefix: string } {
  const c = appBundleS3Config();
  if (!c) throw new HttpError(503, "이 판의 파일은 S3 에 있는데 게이트웨이에 S3 설정(LIVELY_APP_BUNDLE_BUCKET)이 없습니다");
  return c;
}

// ── 읽기 캐시 — 작은 파일만(앱 주소가 같은 화면 파일을 거듭 낸다). 키에 저장소·워크스페이스를 넣어 섞이지 않게. ──
export const BLOB_CACHE_ENTRY_MAX = 1024 * 1024;
export const BLOB_CACHE_TOTAL_MAX = 32 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cacheBytes = 0;
function cacheGet(k: string): Buffer | undefined {
  const v = cache.get(k);
  if (v) { cache.delete(k); cache.set(k, v); }   // 최근 쓴 것을 뒤로(LRU)
  return v;
}
function cachePut(k: string, v: Buffer): void {
  if (v.length > BLOB_CACHE_ENTRY_MAX || cache.has(k)) return;
  cache.set(k, v); cacheBytes += v.length;
  while (cacheBytes > BLOB_CACHE_TOTAL_MAX) {
    const first = cache.keys().next();
    if (first.done) break;
    cacheBytes -= cache.get(first.value)?.length ?? 0;
    cache.delete(first.value);
  }
}
const cacheKey = (kind: BlobStoreKind, tenant: string, h: string): string => `${kind}:${tenant}:${h}`;
export function clearBlobCacheForTest(): void { cache.clear(); cacheBytes = 0; }

// ── 쓰기 ─────────────────────────────────────────────────────────────────────

export interface BlobToStore { h: string; size: number; read: () => Promise<Buffer> }
export interface StoreBlobsResult { uploaded: number; uploadedBytes: number; reused: number }

/**
 * 판이 가리킬 파일들을 저장소에 둔다 — 장부를 먼저 «방금 씀» 으로 찍고(정리와 엇갈리지 않게 · 머리말), 아직 안 올라간 것만 올린다.
 *  읽은 내용의 지문이 이름과 다르면 400(올리는 쪽이 지문을 잘못 셌다 — 다른 파일이 그 이름에 앉으면 안 된다).
 *  beforeUpload — 새로 올릴 바이트 합을 받아 상한을 판정한다(넘으면 던진다 · 장부 찍기는 이미 끝났지만 stored=false 라 해가 없다).
 */
export async function storeBlobs(kind: BlobStoreKind, items: ReadonlyArray<BlobToStore>,
  opts: { beforeUpload?: (newBytes: number) => Promise<void> | void; concurrency?: number } = {}): Promise<StoreBlobsResult> {
  const uniq = new Map<string, BlobToStore>();
  for (const it of items) {
    if (!SHA256_RE.test(it.h)) throw new HttpError(400, `파일 지문 형식이 틀렸습니다: ${String(it.h).slice(0, 80)}`);
    if (!uniq.has(it.h)) uniq.set(it.h, it);
  }
  if (!uniq.size) return { uploaded: 0, uploadedBytes: 0, reused: 0 };
  const list = [...uniq.values()];
  //  한 문장으로 찍는다 — 있던 줄은 last_used_at 만 새로, 없던 줄은 stored=false 로. stored 를 돌려받아 올릴 것을 가린다.
  const r = await itemsPool.query(
    `INSERT INTO org_app_blob(sha256, store, size, stored, created_at, last_used_at)
       SELECT x.h, $1, x.s, FALSE, now(), now() FROM unnest($2::text[], $3::bigint[]) AS x(h, s)
     ON CONFLICT (tenant_id, sha256, store) DO UPDATE SET last_used_at = now()
     RETURNING sha256, stored`,
    [kind, list.map((x) => x.h), list.map((x) => x.size)]);
  const stored = new Map<string, boolean>(r.rows.map((x) => [String(x.sha256), x.stored === true]));
  const todo = list.filter((x) => stored.get(x.h) !== true);
  const newBytes = todo.reduce((n, x) => n + Math.max(0, x.size), 0);
  if (opts.beforeUpload) await opts.beforeUpload(newBytes);
  const tenant = blobTenant();
  let i = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const it = todo[i++];
      if (!it) return;
      const bytes = await it.read();
      if (bytes.length !== it.size || sha256Hex(bytes) !== it.h) throw new HttpError(400, `파일 내용이 지문과 다릅니다(${it.h.slice(0, 12)}…) — 묶음을 다시 만들어 저장하세요`);
      if (kind === "s3") {
        const c = s3OrThrow();
        await viaS3("올리기", () => s3Put(c, s3BlobKey(c.prefix, tenant, it.h), bytes, {}, s3DepsForTest));
        await itemsPool.query(`UPDATE org_app_blob SET stored = TRUE WHERE sha256 = $1 AND store = 's3'`, [it.h]);
      } else {
        await itemsPool.query(`UPDATE org_app_blob SET bytes = $2, stored = TRUE WHERE sha256 = $1 AND store = 'db'`, [it.h, bytes]);
      }
      cachePut(cacheKey(kind, tenant, it.h), bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, todo.length) }, worker));
  return { uploaded: todo.length, uploadedBytes: newBytes, reused: list.length - todo.length };
}

// ── 읽기 ─────────────────────────────────────────────────────────────────────

/** 내용 전체. 없으면 null(장부엔 있는데 객체가 없으면 그것도 null — 호출부가 «판 파일 없음» 으로 답한다). */
export async function getBlob(kind: BlobStoreKind, h: string): Promise<Buffer | null> {
  if (!SHA256_RE.test(h)) return null;
  const tenant = blobTenant();
  const k = cacheKey(kind, tenant, h);
  const hit = cacheGet(k);
  if (hit) return hit;
  let bytes: Buffer | null;
  if (kind === "s3") {
    const c = s3OrThrow();
    bytes = await viaS3("읽기", () => s3Get(c, s3BlobKey(c.prefix, tenant, h), s3DepsForTest));
  } else {
    const r = await itemsPool.query(`SELECT bytes FROM org_app_blob WHERE sha256 = $1 AND store = 'db' AND stored`, [h]);
    const b = r.rows[0]?.bytes;
    bytes = b == null ? null : Buffer.isBuffer(b) ? b : Buffer.from(b as Uint8Array);
  }
  if (bytes && sha256Hex(bytes) !== h) {
    logger.error({ h, kind }, "앱 판 파일 내용이 지문과 다르다 — 저장소가 상했다(#4481)");
    return null;
  }
  if (bytes) cachePut(k, bytes);
  return bytes;
}

/** 큰 파일을 흘려 받기(앱 주소가 그대로 흘려 보낸다). 작은 파일·DB 저장소는 한 번에 읽어 흘린다. 없으면 null. */
export async function streamBlob(kind: BlobStoreKind, h: string, size: number): Promise<Readable | null> {
  if (kind === "s3" && size > BLOB_CACHE_ENTRY_MAX) {
    const c = s3OrThrow();
    const s = await viaS3("읽기", () => s3GetStream(c, s3BlobKey(c.prefix, blobTenant(), h), s3DepsForTest));
    return s ? s.stream : null;
  }
  const b = await getBlob(kind, h);
  return b ? Readable.from([b]) : null;
}

// ── 쓰는 양 ───────────────────────────────────────────────────────────────────

/** 이 워크스페이스가 저장소에 둔 파일(지문마다 한 벌)의 합. 정리를 기다리는 것(24시간 안)도 센다. */
export async function blobBytesUsed(): Promise<number> {
  const r = await itemsPool.query(`SELECT COALESCE(SUM(size), 0)::bigint AS n FROM org_app_blob WHERE stored`);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * 판들이 가리키는 파일(지문마다 한 벌)의 합 — 워크스페이스 상한 판정(app-bundle-policy workspaceLimitDenial)의 «쓰는 양».
 *  장부 합(blobBytesUsed)이 아니라 이걸 쓰는 까닭: 판·앱을 지워 자리를 만들면 바로 줄어야 한다(장부는 정리가 하루 뒤에 걷는다).
 */
export async function referencedBytes(): Promise<number> {
  const r = await itemsPool.query(
    `SELECT COALESCE(SUM(s), 0)::bigint AS n FROM (
       SELECT DISTINCT ON (e->>'h') (e->>'s')::bigint AS s
         FROM org_app_version v CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.bundle->'files', '[]'::jsonb)) e
        WHERE v.bundle IS NOT NULL) x`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── 정리 — 어떤 판도 안 가리키고 24시간 안 쓰인 파일 ───────────────────────────────

export const BLOB_GC_GRACE_HOURS = 24;

/** 판 행들이 가리키는 지문 전부(이 워크스페이스). */
async function referencedHashes(): Promise<Set<string>> {
  const r = await itemsPool.query(
    `SELECT DISTINCT e->>'h' AS h FROM org_app_version v CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.bundle->'files', '[]'::jsonb)) e
      WHERE v.bundle IS NOT NULL`);
  return new Set(r.rows.map((x) => String(x.h)));
}

export interface BlobGcResult { checked: number; removed: number; removedBytes: number; failed: number }

/**
 * 정리 한 바퀴(하우스키핑 틱이 워크스페이스마다 부른다). 후보를 한 번 고른 뒤 줄마다 잠그고 조건을 다시 본다(머리말).
 *  limit — 한 바퀴에 볼 후보 수(틱을 오래 붙잡지 않게). 실패한 지우기는 그 줄을 남긴다(다음 바퀴가 다시 본다).
 */
export async function gcBlobs(opts: { limit?: number; graceHours?: number } = {}): Promise<BlobGcResult> {
  const grace = Math.max(1, opts.graceHours ?? BLOB_GC_GRACE_HOURS);
  const refs = await referencedHashes();
  const cand = await itemsPool.query(
    `SELECT sha256, store FROM org_app_blob WHERE last_used_at < now() - make_interval(hours => $1) ORDER BY last_used_at ASC LIMIT $2`,
    [grace, Math.max(1, opts.limit ?? 200)]);
  const out: BlobGcResult = { checked: 0, removed: 0, removedBytes: 0, failed: 0 };
  const tenant = blobTenant();
  for (const row of cand.rows) {
    const h = String(row.sha256); const kind = row.store === "db" ? "db" as const : "s3" as const;
    if (refs.has(h)) continue;
    out.checked++;
    const client = await itemsPool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query(
        `SELECT size, stored FROM org_app_blob WHERE sha256 = $1 AND store = $2 AND last_used_at < now() - make_interval(hours => $3) FOR UPDATE SKIP LOCKED`,
        [h, kind, grace]);
      const still = lock.rows[0];
      //  잠근 뒤 한 번 더 — 후보를 고른 뒤 들어온 판이 이 파일을 가리키면 건너뛴다(그 저장은 장부를 먼저 찍으므로 위 조건에서 이미 빠지지만 한 겹 더).
      const ref = still ? await client.query(
        `SELECT 1 FROM org_app_version v CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.bundle->'files', '[]'::jsonb)) e WHERE v.bundle IS NOT NULL AND e->>'h' = $1 LIMIT 1`, [h]) : null;
      if (!still || (ref && ref.rows.length)) { await client.query("ROLLBACK"); continue; }
      if (kind === "s3" && still.stored === true) {
        const c = s3OrThrow();
        await s3Delete(c, s3BlobKey(c.prefix, tenant, h), s3DepsForTest);
      }
      await client.query(`DELETE FROM org_app_blob WHERE sha256 = $1 AND store = $2`, [h, kind]);
      await client.query("COMMIT");
      cache.delete(cacheKey(kind, tenant, h));
      out.removed++; out.removedBytes += Number(still.size ?? 0);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* noop */ });
      out.failed++;
      logger.warn({ err: e instanceof Error ? e.message : String(e), h }, "앱 판 파일 정리 실패(비치명 — 다음 바퀴가 다시 본다)");
    } finally {
      client.release();
    }
  }
  return out;
}

/** 시험·관리용 — 장부 한 줄. */
export async function blobRow(h: string, kind: BlobStoreKind, client?: pg.PoolClient): Promise<{ size: number; stored: boolean; last_used_at: string } | null> {
  const r = await (client ?? itemsPool).query(`SELECT size, stored, last_used_at FROM org_app_blob WHERE sha256 = $1 AND store = $2`, [h, kind]);
  const x = r.rows[0];
  return x ? { size: Number(x.size), stored: x.stored === true, last_used_at: x.last_used_at instanceof Date ? x.last_used_at.toISOString() : String(x.last_used_at) } : null;
}

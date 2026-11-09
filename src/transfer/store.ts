// 워크스페이스 간 옮기기(#5458) — 저장 구조: 워크스페이스 고유 id · 가져오기 묶음(배치) · 가져온 기록(출처 ↔ 여기).
//
// 표 셋(전부 테넌트 축은 db/tenant-column.ts 가 introspection 으로 붙인다 — 여기서 손으로 쓰지 않는다):
//  · org_transfer_identity — 워크스페이스마다 한 번 만드는 고유 id. 묶음의 «만든 곳» 이 된다.
//      왜 테넌트 id 를 안 쓰나: 셀프호스팅 기본 워크스페이스의 id 는 모든 박스에서 같은 값(0 으로 채운 uuid,
//      SINGLE_TENANT_ID)이라 서로 다른 박스의 지식이 같은 출처로 잡힌다(설계 보완 1, 2026-11-09 확정).
//      싱글턴(id=1)이고 PK(id) 는 자연키로 판정돼 (tenant_id, id) 로 다시 만들어진다 → ON CONFLICT (tenant_id, id).
//  · org_transfer_batch — 올린 파일 하나 = 한 행. 미리보기(plan)·결정·결과를 담고, 적용 전까지만 파일 바이트(payload)를 든다.
//      BIGSERIAL 대리키라 재작성 없음 → ON CONFLICT 를 쓰지 않는다.
//  · org_transfer_origin — 가져온 항목마다 (만든 곳 id, 종류, 원래 이름) → 여기 이름 + 지문 둘.
//      origin_hash = 가져올 때 묶음 쪽 내용 지문, local_hash = 가져온 직후 여기 행의 내용 지문.
//      다시 가져올 때 «원본만 바뀜 / 여기만 바뀜 / 둘 다» 를 이 둘로 가른다. 자연키 PK → (tenant_id, …) 재작성.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { itemsPool, q, one } from "../db/client.js";
import { ensureCheck } from "../org/schema/ddl-util.js";

export async function initTransfer(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_transfer_identity(
      id INT PRIMARY KEY DEFAULT 1,
      workspace_uid TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ${ensureCheck("org_transfer_identity", { org_transfer_identity_single_chk: "id = 1" })}

    CREATE TABLE IF NOT EXISTS org_transfer_batch(
      id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'planned',
      file_name TEXT,
      file_sha256 TEXT,
      file_bytes BIGINT,
      sealed BOOLEAN NOT NULL DEFAULT false,
      origin_uid TEXT,
      origin_name TEXT,
      format_version INT,
      manifest JSONB,
      plan JSONB,
      decisions JSONB,
      result JSONB,
      payload BYTEA,
      error TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT,
      applied_at TIMESTAMPTZ,
      undone_by TEXT,
      undone_at TIMESTAMPTZ);
    ${ensureCheck("org_transfer_batch", {
      org_transfer_batch_state_chk: "state IN ('planned','applying','applied','partial','failed','undoing','undone','expired')",
    })}
    CREATE INDEX IF NOT EXISTS org_transfer_batch_created_idx ON org_transfer_batch(created_at DESC);

    CREATE TABLE IF NOT EXISTS org_transfer_origin(
      origin_uid TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin_ref TEXT NOT NULL,
      local_ref TEXT NOT NULL,
      origin_hash TEXT,
      local_hash TEXT,
      batch_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (origin_uid, kind, origin_ref));
    ${ensureCheck("org_transfer_origin", { org_transfer_origin_kind_chk: "kind IN ('knowledge','source','category')" })}
    CREATE INDEX IF NOT EXISTS org_transfer_origin_local_idx ON org_transfer_origin(kind, local_ref);
  `);
}

// ── 워크스페이스 고유 id ──────────────────────────────────────────────────────────────

/** 이 워크스페이스의 고유 id — 처음 부르면 만든다(동시에 두 번 불려도 하나만 남는다). */
export async function getWorkspaceUid(): Promise<string> {
  const row = await one(itemsPool, `SELECT workspace_uid FROM org_transfer_identity WHERE id=1`, []) as { workspace_uid: string } | undefined;
  if (row?.workspace_uid) return row.workspace_uid;
  await itemsPool.query(
    `INSERT INTO org_transfer_identity(id, workspace_uid) VALUES(1, $1) ON CONFLICT (tenant_id, id) DO NOTHING`,
    [randomUUID()]);
  const again = await one(itemsPool, `SELECT workspace_uid FROM org_transfer_identity WHERE id=1`, []) as { workspace_uid: string } | undefined;
  if (!again?.workspace_uid) throw new Error("워크스페이스 고유 id 를 만들지 못했습니다");
  return again.workspace_uid;
}

// ── 가져오기 묶음(배치) ───────────────────────────────────────────────────────────────

export type BatchState = "planned" | "applying" | "applied" | "partial" | "failed" | "undoing" | "undone" | "expired";

export interface BatchRow {
  id: number;
  state: BatchState;
  file_name: string | null;
  file_sha256: string | null;
  file_bytes: number | null;
  sealed: boolean;
  origin_uid: string | null;
  origin_name: string | null;
  format_version: number | null;
  manifest: unknown;
  plan: unknown;
  decisions: unknown;
  result: unknown;
  error: string | null;
  created_by: string | null;
  created_at: string;
  applied_by: string | null;
  applied_at: string | null;
  undone_by: string | null;
  undone_at: string | null;
}

const BATCH_COLS = `id, state, file_name, file_sha256, file_bytes, sealed, origin_uid, origin_name, format_version,
  manifest, plan, decisions, result, error, created_by, created_at, applied_by, applied_at, undone_by, undone_at`;

const normBatch = (r: Record<string, unknown> | undefined): BatchRow | undefined =>
  r ? ({ ...r, id: Number(r.id), file_bytes: r.file_bytes == null ? null : Number(r.file_bytes) } as BatchRow) : undefined;

export async function createBatch(input: {
  file_name: string | null; file_sha256: string; file_bytes: number; sealed: boolean;
  origin_uid: string; origin_name: string | null; format_version: number;
  manifest: unknown; plan: unknown; payload: Buffer; created_by: string | null;
}): Promise<BatchRow> {
  const row = await one(itemsPool,
    `INSERT INTO org_transfer_batch(state, file_name, file_sha256, file_bytes, sealed, origin_uid, origin_name, format_version, manifest, plan, payload, created_by)
     VALUES('planned',$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11) RETURNING ${BATCH_COLS}`,
    [input.file_name, input.file_sha256, input.file_bytes, input.sealed, input.origin_uid, input.origin_name, input.format_version,
      JSON.stringify(input.manifest), JSON.stringify(input.plan), input.payload, input.created_by]);
  return normBatch(row as Record<string, unknown>)!;
}

export async function getBatch(id: number): Promise<BatchRow | undefined> {
  return normBatch(await one(itemsPool, `SELECT ${BATCH_COLS} FROM org_transfer_batch WHERE id=$1`, [id]) as Record<string, unknown> | undefined);
}

export async function getBatchPayload(id: number): Promise<Buffer | null> {
  const row = await one(itemsPool, `SELECT payload FROM org_transfer_batch WHERE id=$1`, [id]) as { payload: Buffer | null } | undefined;
  return row?.payload ?? null;
}

export async function listBatches(limit = 50): Promise<BatchRow[]> {
  const rows = await q(itemsPool,
    `SELECT id, state, file_name, file_sha256, file_bytes, sealed, origin_uid, origin_name, format_version,
            manifest, jsonb_build_object('summary', plan->'summary') AS plan, decisions, result, error, created_by, created_at, applied_by, applied_at, undone_by, undone_at
       FROM org_transfer_batch ORDER BY created_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]);
  return rows.map((r) => normBatch(r as Record<string, unknown>)!);
}

/** 상태 전이 — expect 에 있는 상태일 때만 바꾼다(두 사람이 동시에 «적용» 을 눌러도 한 번만 돈다). 바뀌었으면 행, 아니면 undefined. */
export async function transitionBatch(id: number, expect: BatchState[], next: BatchState, patch: {
  plan?: unknown; decisions?: unknown; result?: unknown; error?: string | null;
  applied_by?: string | null; undone_by?: string | null; clearPayload?: boolean;
} = {}): Promise<BatchRow | undefined> {
  const sets: string[] = ["state=$3"];
  const params: unknown[] = [id, expect, next];
  const add = (sql: string, v: unknown): void => { params.push(v); sets.push(sql.replace("?", `$${params.length}`)); };
  if (patch.plan !== undefined) add("plan=?::jsonb", JSON.stringify(patch.plan));
  if (patch.decisions !== undefined) add("decisions=?::jsonb", JSON.stringify(patch.decisions));
  if (patch.result !== undefined) add("result=?::jsonb", JSON.stringify(patch.result));
  if (patch.error !== undefined) add("error=?", patch.error);
  if (patch.applied_by !== undefined) { add("applied_by=?", patch.applied_by); sets.push("applied_at=now()"); }
  if (patch.undone_by !== undefined) { add("undone_by=?", patch.undone_by); sets.push("undone_at=now()"); }
  if (patch.clearPayload) sets.push("payload=NULL");
  const row = await one(itemsPool,
    `UPDATE org_transfer_batch SET ${sets.join(", ")} WHERE id=$1 AND state = ANY($2::text[]) RETURNING ${BATCH_COLS}`, params);
  return normBatch(row as Record<string, unknown> | undefined);
}

/** 적용하지 않고 둔 미리보기는 하루 뒤 파일 바이트를 비운다(올린 파일이 DB 에 쌓이지 않게). */
export async function expireStalePlans(hours = 24): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_transfer_batch SET state='expired', payload=NULL
      WHERE state='planned' AND created_at < now() - ($1::int * interval '1 hour')`, [hours]);
  return r.rowCount ?? 0;
}

// ── 가져온 기록 ──────────────────────────────────────────────────────────────────────

export type OriginKind = "knowledge" | "source" | "category";

export interface OriginRow {
  origin_uid: string;
  kind: OriginKind;
  origin_ref: string;
  local_ref: string;
  origin_hash: string | null;
  local_hash: string | null;
  batch_id: number | null;
}

export async function listOrigins(originUid: string, kind: OriginKind): Promise<Map<string, OriginRow>> {
  const rows = await q(itemsPool,
    `SELECT origin_uid, kind, origin_ref, local_ref, origin_hash, local_hash, batch_id
       FROM org_transfer_origin WHERE origin_uid=$1 AND kind=$2`, [originUid, kind]) as OriginRow[];
  return new Map(rows.map((r) => [r.origin_ref, { ...r, batch_id: r.batch_id == null ? null : Number(r.batch_id) }]));
}

export async function upsertOrigin(r: OriginRow): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_transfer_origin(origin_uid, kind, origin_ref, local_ref, origin_hash, local_hash, batch_id, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (tenant_id, origin_uid, kind, origin_ref) DO UPDATE SET
       local_ref=EXCLUDED.local_ref, origin_hash=EXCLUDED.origin_hash, local_hash=EXCLUDED.local_hash,
       batch_id=EXCLUDED.batch_id, updated_at=now()`,
    [r.origin_uid, r.kind, r.origin_ref, r.local_ref, r.origin_hash, r.local_hash, r.batch_id]);
}

export async function deleteOrigin(originUid: string, kind: OriginKind, originRef: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_transfer_origin WHERE origin_uid=$1 AND kind=$2 AND origin_ref=$3`, [originUid, kind, originRef]);
}

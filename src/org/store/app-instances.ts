// 앱 실행 인스턴스 스토어(#1780 v2.1) — package(org_app)와 실제 실행/창/프로젝트 맥락을 분리한다.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../../db/client.js";

type Q = pg.Pool | pg.PoolClient;

export type AppInstanceStatus = "active" | "closed";
export interface AppInstanceRow {
  id: string;
  app_id: string;
  owner_member: string;
  project_id: number | null;
  subject_kind: string | null;
  subject_ref: string | null;
  page_key: string | null;
  title: string | null;
  state: Record<string, unknown>;
  execution_host_kind: "central" | "remote" | null;
  execution_host_id: string | null;
  status: AppInstanceStatus;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function row(r: Record<string, unknown>): AppInstanceRow {
  return {
    id: String(r.id), app_id: String(r.app_id), owner_member: String(r.owner_member),
    project_id: r.project_id == null ? null : Number(r.project_id),
    subject_kind: r.subject_kind == null ? null : String(r.subject_kind),
    subject_ref: r.subject_ref == null ? null : String(r.subject_ref),
    page_key: r.page_key == null ? null : String(r.page_key),
    title: r.title == null ? null : String(r.title),
    state: r.state && typeof r.state === "object" && !Array.isArray(r.state) ? r.state as Record<string, unknown> : {},
    execution_host_kind: r.execution_host_kind == null ? null : r.execution_host_kind as "central" | "remote",
    execution_host_id: r.execution_host_id == null ? null : String(r.execution_host_id),
    status: r.status as AppInstanceStatus,
    created_at: new Date(String(r.created_at)).toISOString(), updated_at: new Date(String(r.updated_at)).toISOString(),
    closed_at: r.closed_at == null ? null : new Date(String(r.closed_at)).toISOString(),
  };
}

export async function getAppInstance(id: string, owner?: string): Promise<AppInstanceRow | null> {
  const args: unknown[] = [id];
  const own = owner ? " AND owner_member=$2" : "";
  if (owner) args.push(owner);
  const r = await itemsPool.query(`SELECT * FROM org_app_instance WHERE id=$1${own}`, args);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function listAppInstances(owner: string, opts: { appId?: string; projectId?: number | null; includeClosed?: boolean } = {}): Promise<AppInstanceRow[]> {
  const args: unknown[] = [owner];
  const where = ["owner_member=$1"];
  if (opts.appId) { args.push(opts.appId); where.push(`app_id=$${args.length}`); }
  if (opts.projectId !== undefined) {
    if (opts.projectId === null) where.push("project_id IS NULL");
    else { args.push(opts.projectId); where.push(`project_id=$${args.length}`); }
  }
  if (!opts.includeClosed) where.push("status='active'");
  const r = await itemsPool.query(`SELECT * FROM org_app_instance WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`, args);
  return r.rows.map(row);
}

/** worker 복구·패키지 갱신용 내부 목록. 사용자 조회 API가 아니므로 owner 필터 대신 실행 host/app을 권위로 쓴다. */
export async function listActiveRuntimeInstances(opts: {
  appId?: string;
  hostKind?: "central" | "remote";
  hostId?: string | null;
} = {}): Promise<AppInstanceRow[]> {
  const args: unknown[] = [];
  const where = ["status='active'", "execution_host_kind IS NOT NULL"];
  if (opts.appId) { args.push(opts.appId); where.push(`app_id=$${args.length}`); }
  if (opts.hostKind) { args.push(opts.hostKind); where.push(`execution_host_kind=$${args.length}`); }
  if (opts.hostId !== undefined) {
    if (opts.hostId === null) where.push("execution_host_id IS NULL");
    else { args.push(opts.hostId); where.push(`execution_host_id=$${args.length}`); }
  }
  const r = await itemsPool.query(`SELECT * FROM org_app_instance WHERE ${where.join(" AND ")} ORDER BY created_at`, args);
  return r.rows.map(row);
}

export interface CreateAppInstanceInput {
  appId: string; owner: string; projectId: number | null;
  subjectKind?: string | null; subjectRef?: string | null;
  pageKey?: string | null; title?: string | null; state?: Record<string, unknown>;
  executionHostKind?: "central" | "remote" | null; executionHostId?: string | null;
  preserveExecutionOnConflict?: boolean;
}

/** subject가 있으면 멱등 확보, 없으면 매번 새 인스턴스. */
export async function createAppInstance(input: CreateAppInstanceInput): Promise<{ instance: AppInstanceRow; created: boolean }> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const result = await createAppInstanceTx(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* connection may already be unusable */ });
    throw error;
  } finally {
    client.release();
  }
}

async function createAppInstanceTx(client: pg.PoolClient, input: CreateAppInstanceInput): Promise<{ instance: AppInstanceRow; created: boolean }> {
  const subject = !!input.subjectKind && !!input.subjectRef;
  const id = crypto.randomUUID();
  const inserted = await client.query(
    `INSERT INTO org_app_instance(id,app_id,owner_member,project_id,subject_kind,subject_ref,page_key,title,state,execution_host_kind,execution_host_id,status,closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'active',NULL)
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, input.appId, input.owner, input.projectId, input.subjectKind ?? null, input.subjectRef ?? null,
     input.pageKey ?? null, input.title ?? null, JSON.stringify(input.state ?? {}), input.executionHostKind ?? null, input.executionHostId ?? null],
  );
  if (inserted.rows[0]) {
    const instance = row(inserted.rows[0]);
    await recordAppInstanceProject(instance.id, input.projectId, client);
    return { instance, created: true };
  }
  if (!subject) throw new Error("앱 인스턴스를 만들지 못했습니다");
  const found = await client.query(
    `UPDATE org_app_instance SET status='active', closed_at=NULL, updated_at=now(),
        project_id=$5, page_key=COALESCE($6,page_key), title=COALESCE($7,title), state=$8::jsonb,
        execution_host_kind=CASE WHEN $11 THEN execution_host_kind ELSE $9 END,
        execution_host_id=CASE WHEN $11 THEN execution_host_id ELSE $10 END
      WHERE app_id=$1 AND owner_member=$2 AND subject_kind=$3 AND subject_ref=$4 RETURNING *`,
    [input.appId, input.owner, input.subjectKind, input.subjectRef, input.projectId, input.pageKey ?? null,
     input.title ?? null, JSON.stringify(input.state ?? {}), input.executionHostKind ?? null, input.executionHostId ?? null,
     input.preserveExecutionOnConflict === true],
  );
  if (!found.rows[0]) throw new Error("앱 인스턴스를 찾지 못했습니다");
  const instance = row(found.rows[0]);
  await recordAppInstanceProject(instance.id, input.projectId, client);
  return { instance, created: false };
}

export async function patchAppInstance(id: string, owner: string, patch: { title?: string | null; pageKey?: string | null; state?: Record<string, unknown> }): Promise<AppInstanceRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_instance SET title=CASE WHEN $3 THEN $4 ELSE title END,
       page_key=CASE WHEN $5 THEN $6 ELSE page_key END, state=state||$7::jsonb, updated_at=now()
     WHERE id=$1 AND owner_member=$2
       AND octet_length((state||$7::jsonb)::text) <= 131072
     RETURNING *`,
    [id, owner, patch.title !== undefined, patch.title ?? null, patch.pageKey !== undefined, patch.pageKey ?? null, JSON.stringify(patch.state ?? {})],
  );
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function setAppInstanceProject(id: string, owner: string, projectId: number | null): Promise<AppInstanceRow | null> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE org_app_instance SET project_id=$3, updated_at=now() WHERE id=$1 AND owner_member=$2 RETURNING *`,
      [id, owner, projectId],
    );
    if (!r.rows[0]) { await client.query("ROLLBACK"); return null; }
    await recordAppInstanceProject(id, projectId, client);
    await client.query("COMMIT");
    return row(r.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* connection may already be unusable */ });
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAppInstanceProject(id: string, projectId: number | null, db: Q = itemsPool): Promise<void> {
  await db.query(
    `INSERT INTO org_app_instance_project(instance_id,project_id)
     SELECT $1::text,$2::int
      WHERE NOT EXISTS(SELECT 1 FROM org_app_instance_project WHERE instance_id=$1)
         OR (SELECT project_id FROM org_app_instance_project WHERE instance_id=$1 ORDER BY valid_from DESC,id DESC LIMIT 1)
            IS DISTINCT FROM $2::int`, [id, projectId],
  );
}

export async function syncSessionAppInstanceProject(sessionId: string, projectId: number | null): Promise<void> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query(
      `UPDATE org_app_instance SET project_id=$2, updated_at=now()
        WHERE subject_kind='session' AND subject_ref=$1 AND status='active' RETURNING id`, [sessionId, projectId]);
    for (const r of rows.rows) await recordAppInstanceProject(String(r.id), projectId, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* connection may already be unusable */ });
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAppInstance(id: string, owner: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_instance SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1 AND owner_member=$2 AND status<>'closed'`, [id, owner]);
  return (r.rowCount ?? 0) > 0;
}

export async function pruneAppInstances(appId: string): Promise<number> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const ids = (await client.query(`SELECT id FROM org_app_instance WHERE app_id=$1 FOR UPDATE`, [appId])).rows.map((r) => String(r.id));
    if (!ids.length) { await client.query("COMMIT"); return 0; }
    await client.query(`DELETE FROM org_app_instance_project WHERE instance_id=ANY($1::text[])`, [ids]);
    const r = await client.query(`DELETE FROM org_app_instance WHERE app_id=$1`, [appId]);
    await client.query("COMMIT");
    return r.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* connection may already be unusable */ });
    throw error;
  } finally {
    client.release();
  }
}

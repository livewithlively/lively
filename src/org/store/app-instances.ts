// 앱 실행 인스턴스 스토어(#1780 v2.1) — package(org_app)와 실제 실행/창/프로젝트 맥락을 분리한다.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../../db/client.js";

type Q = pg.Pool | pg.PoolClient;

export type AppInstanceStatus = "active" | "closed";
/**
 * 닫힘 사유(#3855·#3857) — 사이드바 «보임 축» 은 **사람이 치운 것(user)** 만 본다.
 *  나머지는 전부 시스템 뒷정리라 «치운 세션» 에 뜨면 안 된다(되살리기가 옛 id 를 닫은 것이 거기 뜨면
 *  사람은 자기가 치운 적 없는 세션을 «치웠다» 고 보게 된다). NULL = 이 칸 이전에 닫힌 행(사유 미상).
 *  ⚠ 기본값을 두지 않는다 — 닫는 자리마다 사유를 **고르게** 한다(빠뜨린 자리를 타입이 잡는다).
 */
export const CLOSE_REASONS = ["user", "restore", "kill", "purge", "janitor", "system"] as const;
export type AppInstanceCloseReason = typeof CLOSE_REASONS[number];
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
  closed_reason: AppInstanceCloseReason | null;
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
    closed_reason: r.closed_reason == null ? null : String(r.closed_reason) as AppInstanceCloseReason,
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
    `UPDATE org_app_instance SET status='active', closed_at=NULL, closed_reason=NULL, updated_at=now(),
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

export async function closeAppInstance(id: string, owner: string, reason: AppInstanceCloseReason): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_instance SET status='closed',closed_at=now(),updated_at=now(),closed_reason=$3 WHERE id=$1 AND owner_member=$2 AND status<>'closed'`, [id, owner, reason]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 세션이 끝났다 — 그 세션을 subject 로 쥔 인스턴스를 닫는다(#1954 후속).
 *  세션은 죽었는데 인스턴스가 active 로 남으면 좌측 목록·인스턴스 조회에 유령이 쌓인다(실측 30건 중 대다수가
 *  이미 끝난 세션이었다). 소유자를 묻지 않는다 — 세션의 죽음은 소유자와 무관한 사실이다.
 *  이미 닫힌 것은 건너뛴다(멱등). 닫은 개수를 돌려준다.
 */
export async function closeSessionAppInstances(sessionId: string, reason: Exclude<AppInstanceCloseReason, "user">): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_app_instance SET status='closed',closed_at=now(),updated_at=now(),closed_reason=$2
      WHERE subject_kind='session' AND subject_ref=$1 AND status<>'closed'`, [sessionId, reason]);
  return r.rowCount ?? 0;
}

// ── 세션의 «보임 축»(#3855·#3857) — 사람이 목록에서 치우고 되돌리는 자리 ─────────────────────
//  정본은 이 표다: 내 세션 인스턴스가 active = «목록에 둠», closed·사유 user = «치움».
//  ⚠ 세션·박스는 여기서 절대 안 건드린다 — 보임 축은 실행 축(회수·종료)과 독립이다(상민님 결정 2026-09-10).

const uniqRefs = (ids: string[]): string[] => [...new Set((ids || []).map((x) => String(x ?? "").trim()).filter(Boolean))];

/**
 * 이 세션들을 **내 목록에서 치운다**. 행이 있으면(active·시스템이 닫은 것 모두) 사유 user 로 닫고,
 *  한 번도 연 적 없어 행이 없으면 closed·user 행을 새로 만든다 — 그래야 «CLI 로 떠서 도는 세션» 도 치운 채로 남는다.
 *  멱등: 이미 user 로 닫힌 행은 건드리지 않는다(closed_at 이 치운 순간 그대로 남는다). 바꾸거나 만든 행 수를 돌려준다.
 */
export async function dismissSessionInstances(owner: string, sessionIds: string[], appId = "ai-session"): Promise<number> {
  const refs = uniqRefs(sessionIds);
  if (!owner || !refs.length) return 0;
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      `UPDATE org_app_instance SET status='closed', closed_reason='user', closed_at=now(), updated_at=now()
        WHERE owner_member=$1 AND subject_kind='session' AND subject_ref=ANY($2::text[])
          AND (status<>'closed' OR closed_reason IS DISTINCT FROM 'user')`, [owner, refs]);
    const ins = await client.query(
      `INSERT INTO org_app_instance(id,app_id,owner_member,project_id,subject_kind,subject_ref,state,status,closed_at,closed_reason)
       SELECT t.id, $3, $1, NULL, 'session', t.ref, '{}'::jsonb, 'closed', now(), 'user'
         FROM unnest($2::text[], $4::text[]) AS t(ref, id)
        WHERE NOT EXISTS (SELECT 1 FROM org_app_instance x
                           WHERE x.owner_member=$1 AND x.subject_kind='session' AND x.subject_ref=t.ref)
       ON CONFLICT DO NOTHING`, [owner, refs, appId, refs.map(() => crypto.randomUUID())]);
    await client.query("COMMIT");
    return (upd.rowCount ?? 0) + (ins.rowCount ?? 0);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { /* connection may already be unusable */ });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 되살리기(restore)가 **치움을 풀지 않게** 승계한다(#3857 — 보임 축은 사람만 바꾼다).
 *  되살리기는 새 박스 id 로 인스턴스를 active 로 세우고(registerSessionInstance) 옛 id 를 닫는다. 옛 id 를 누군가
 *  «치움(user)» 으로 닫아 뒀다면 그 사람에게 새 id 도 치운 채여야 한다 — 아니면 대시보드·클래식의 **일괄 복원**이
 *  치운 세션을 목록에 되올린다. 사람이 그 세션을 **직접 열면** 화면의 멱등 생성 경로가 active 로 되살리므로 따로 풀 필요가 없다.
 *  옛 id 의 user 행은 사유를 restore 로 바꾼다 — 치운 사실은 새 id 로 옮겨 갔고, 두 줄로 남으면 「치운 세션」에 같은 세션이 겹친다.
 *  승계한 사람 수를 돌려준다.
 */
export async function carrySessionDismissals(oldSessionId: string, newSessionId: string): Promise<number> {
  const from = String(oldSessionId || "").trim(), to = String(newSessionId || "").trim();
  if (!from || !to || from === to) return 0;
  const owners = (await itemsPool.query(
    `SELECT DISTINCT owner_member FROM org_app_instance
      WHERE subject_kind='session' AND subject_ref=$1 AND status='closed' AND closed_reason='user'`, [from])).rows.map((r) => String(r.owner_member));
  for (const owner of owners) await dismissSessionInstances(owner, [to]);
  if (owners.length) {
    await itemsPool.query(
      `UPDATE org_app_instance SET closed_reason='restore', updated_at=now()
        WHERE subject_kind='session' AND subject_ref=$1 AND status='closed' AND closed_reason='user'`, [from]);
  }
  return owners.length;
}

/** 치운 세션을 **목록으로 되돌린다** — 사람이 치운 것(user)만. 시스템이 닫은 행(restore·purge…)은 되살리지 않는다. */
export async function reopenSessionInstances(owner: string, sessionIds: string[]): Promise<number> {
  const refs = uniqRefs(sessionIds);
  if (!owner || !refs.length) return 0;
  const r = await itemsPool.query(
    `UPDATE org_app_instance SET status='active', closed_at=NULL, closed_reason=NULL, updated_at=now()
      WHERE owner_member=$1 AND subject_kind='session' AND subject_ref=ANY($2::text[])
        AND status='closed' AND closed_reason='user'`, [owner, refs]);
  return r.rowCount ?? 0;
}

/**
 * 내가 치운 세션 id 만 — 좌측 목록이 폴링마다 쓰는 가벼운 판(장식·조인 없음).
 *  ⚠ 같은 세션을 **다른 app_id 로 연 active 행**이 있으면 뺀다(코디네이터 검토 보강 ①). 치움 행은 app_id 가
 *   'ai-session' 으로 만들어지므로(dismissSessionInstances) 그 세션을 뒤에 앱 세션으로 열면 active·closed(user)가
 *   공존한다 — 그대로 두면 목록엔 서는데(목록에 둠이 이긴다) 「치운 세션」에도 떠 같은 사실을 반대로 말한다.
 */
export async function listDismissedSessionRefs(owner: string): Promise<string[]> {
  if (!owner) return [];
  const r = await itemsPool.query(
    `SELECT DISTINCT d.subject_ref FROM org_app_instance d
      WHERE d.owner_member=$1 AND d.subject_kind='session' AND d.status='closed' AND d.closed_reason='user'
        AND NOT EXISTS (SELECT 1 FROM org_app_instance a
                         WHERE a.owner_member=d.owner_member AND a.subject_kind='session'
                           AND a.subject_ref=d.subject_ref AND a.status='active')`, [owner]);
  return r.rows.map((x) => String(x.subject_ref));
}

/** 「치운 세션」 화면용 전체 행 — 치운 순서(최근 먼저). 다른 app_id 로 active 가 공존하는 세션은 뺀다(위와 같은 자). */
export async function listDismissedSessionInstances(owner: string, limit = 2000): Promise<AppInstanceRow[]> {
  if (!owner) return [];
  const r = await itemsPool.query(
    `SELECT d.* FROM org_app_instance d
      WHERE d.owner_member=$1 AND d.subject_kind='session' AND d.status='closed' AND d.closed_reason='user'
        AND NOT EXISTS (SELECT 1 FROM org_app_instance a
                         WHERE a.owner_member=d.owner_member AND a.subject_kind='session'
                           AND a.subject_ref=d.subject_ref AND a.status='active')
      ORDER BY d.closed_at DESC NULLS LAST LIMIT $2`, [owner, limit]);
  return r.rows.map(row);
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

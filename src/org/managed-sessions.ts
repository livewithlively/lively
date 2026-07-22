// 상시 에이전트 세션 — org_managed_session(desired state) + keep-alive(ensure). 프로젝트 터미널 생성(createSession)
//  과 격리 워크스페이스(공유폴더 managed/<id>)를 그대로 재사용한다. 크론 'map_unmapped' 등이 이 세션을 타깃 삼아 주입.
//  account = 라이블리 계정/프로필(=클로드 로그인). 지금 맥미니 단일 프로필, 멀티프로필 대비 필드.
import { itemsPool } from "../items/store.js";
import { createSession, listSessions } from "../terminal-sessions.js";
import type { LivelyUser } from "../context.js";

export interface ManagedSession {
  id: string; label: string | null; account: string | null; workspace_subpath: string | null;
  harness: string; flags: Record<string, unknown>; auto_approve: boolean; enabled: boolean;
  session_id: string | null; note: string | null; sort: number;
}

// account → provision 주체 합성 LivelyUser. 단일프로필이면 account 가 곧 시드 계정(세션 id = box-<account>-…).
function asUser(account: string): LivelyUser {
  return { userId: account, email: "", scopes: ["items", "context", "memory", "admin", "runtime"] } as unknown as LivelyUser;
}

export async function listManagedSessions(): Promise<ManagedSession[]> {
  return (await itemsPool.query("SELECT * FROM org_managed_session ORDER BY sort, id")).rows;
}

export async function getManagedSession(id: string): Promise<ManagedSession | undefined> {
  return (await itemsPool.query("SELECT * FROM org_managed_session WHERE id=$1", [id])).rows[0];
}

export async function upsertManagedSession(m: Partial<ManagedSession> & { id: string }, actor?: string): Promise<ManagedSession> {
  const ex = await getManagedSession(m.id);
  const flagsJson = m.flags ? JSON.stringify(m.flags) : null;
  if (!ex) {
    const r = await itemsPool.query(
      `INSERT INTO org_managed_session(id,label,account,workspace_subpath,harness,flags,auto_approve,enabled,note,created_by,updated_by)
       VALUES($1,$2,$3,$4,COALESCE($5,'claude'),COALESCE($6,'{}')::jsonb,COALESCE($7,true),COALESCE($8,true),$9,$10,$10) RETURNING *`,
      [m.id, m.label ?? null, m.account ?? null, m.workspace_subpath ?? null, m.harness ?? null,
       flagsJson, typeof m.auto_approve === "boolean" ? m.auto_approve : null,
       typeof m.enabled === "boolean" ? m.enabled : null, m.note ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_managed_session SET
       label=COALESCE($2,label), account=COALESCE($3,account), workspace_subpath=COALESCE($4,workspace_subpath),
       harness=COALESCE($5,harness), flags=COALESCE($6,flags), auto_approve=COALESCE($7,auto_approve),
       enabled=COALESCE($8,enabled), note=COALESCE($9,note), version=version+1, updated_at=now(), updated_by=$10
     WHERE id=$1 RETURNING *`,
    [m.id, m.label ?? null, m.account ?? null, m.workspace_subpath ?? null, m.harness ?? null,
     flagsJson, typeof m.auto_approve === "boolean" ? m.auto_approve : null,
     typeof m.enabled === "boolean" ? m.enabled : null, m.note ?? null, actor ?? null]);
  return r.rows[0];
}

export async function deleteManagedSession(id: string): Promise<{ deleted: boolean; id: string }> {
  const r = await itemsPool.query("DELETE FROM org_managed_session WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

// 한 상시 세션의 tmux 세션 보장 — 살아있으면 no-op, 없으면 격리 워크스페이스에 createSession 으로 재생성 + session_id 기록.
export async function ensureManagedSession(m: ManagedSession): Promise<{ id: string; session_id?: string; action: string }> {
  if (!m.enabled) return { id: m.id, action: "disabled" };
  const user = asUser(m.account || "daon");
  const live = await listSessions(user).catch(() => [] as Array<{ id: string }>);
  if (m.session_id && live.some((s) => s.id === m.session_id)) return { id: m.id, session_id: m.session_id, action: "alive" };
  const created = await createSession(user, {
    label: m.label || m.id, rootKey: "shared", subpath: m.workspace_subpath || ("managed/" + m.id),
    harness: m.harness || "claude", flags: (m.flags || {}) as Record<string, unknown>, autoApprove: !!m.auto_approve,
    // #1059 E — 상시 세션은 desired-state DB 미러 skip: keep-alive(ensureAllManagedSessions)가 영속을 소유하므로
    //  restorable 로 이중화하면 재부팅 후 keep-alive 재생성과 사용자 수동복원이 충돌한다.
    managed: true,
  });
  await itemsPool.query("UPDATE org_managed_session SET session_id=$1, updated_at=now() WHERE id=$2", [created.id, m.id]);
  return { id: m.id, session_id: created.id, action: "created" };
}

// keep-alive — enabled 상시 세션 전부 ensure(크론 ensure_managed_sessions 가 주기 호출). 등록 0이면 no-op.
export async function ensureAllManagedSessions(): Promise<Array<{ id: string; session_id?: string; action?: string; error?: string }>> {
  const rows = await listManagedSessions();
  const out: Array<{ id: string; session_id?: string; action?: string; error?: string }> = [];
  for (const m of rows) {
    if (!m.enabled) continue;
    try { out.push(await ensureManagedSession(m)); }
    catch (e) { out.push({ id: m.id, error: (e as Error)?.message ?? String(e) }); }
  }
  return out;
}

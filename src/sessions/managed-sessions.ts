// 상시 에이전트 세션 — org_managed_session(desired state) + keep-alive(ensure). 프로젝트 터미널 생성(createSession)
//  과 격리 워크스페이스(공유폴더 managed/<id>)를 그대로 재사용한다. 크론 'map_unmapped' 등이 이 세션을 타깃 삼아 주입.
//  account = 라이블리 계정/프로필(=클로드 로그인). 지금 맥미니 단일 프로필, 멀티프로필 대비 필드.
import { itemsPool } from "../db/client.js";
import { createSession, listSessions, reapCentralSession } from "../terminal/terminal-sessions.js";
import { logger } from "../log.js";
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

/** 상시세션의 워크스페이스 하위경로 — 등록값이 없으면 관례상 `managed/<id>`. 고아 판정의 식별자다. */
export function managedSubpath(m: Pick<ManagedSession, "id" | "workspace_subpath">): string {
  return m.workspace_subpath || ("managed/" + m.id);
}

/**
 * 그 상시세션의 워크스페이스에 붙어 있는 살아있는 세션들을 **유지 1개 + 고아 N개**로 가른다(순수, #1675 ⑥).
 *
 * 왜 필요(어니스트 2026-08-12 실측): 레지스트리에 `knowledge-classify` 가 **1건** 등록돼 있는데 실제 tmux 에는
 *  같은 라벨 세션이 **30개** 떠 있었다. 29개가 고아였고, claude 프로세스 29개 = 5.7GB 를 붙들고 있었다.
 *  `ensureAllManagedSessions` 가 2분마다 도는데 **옛 세션을 정리하지 않고 새로 만들기만 했기** 때문이다.
 *
 * 판정 기준은 **워크스페이스 경로**다 — 라벨은 사람이 바꿀 수 있지만 경로는 그 상시세션의 신원이다.
 *  `endsWith('/'+sub)` 로 비교해 `managed/foo` 가 `managed/foo-2` 를 삼키지 않게 한다.
 *
 * 유지 대상 선택: 등록된 session_id 가 살아 있으면 **그것**(레지스트리가 권위). 없으면 **가장 오래된 것**을
 *  승격한다 — 오래 산 세션이 실제로 일해 온 쪽일 가능성이 높고, 갓 만들어진 중복을 남기면 그 세션의 맥락을 버린다.
 */
export function classifyManagedLive(o: {
  live: Array<{ id: string; dir?: string; created?: number }>;
  subpath: string;
  registered: string | null;
}): { keep: string | null; orphans: string[] } {
  const suffix = "/" + o.subpath.replace(/^\/+/, "").replace(/\/+$/, "");
  const mine = o.live.filter((s) => typeof s.dir === "string" && s.dir.replace(/\/+$/, "").endsWith(suffix));
  if (!mine.length) return { keep: null, orphans: [] };
  const registered = o.registered && mine.some((s) => s.id === o.registered) ? o.registered : null;
  const keep = registered ?? [...mine].sort((a, b) => (a.created ?? 0) - (b.created ?? 0))[0].id;
  return { keep, orphans: mine.filter((s) => s.id !== keep).map((s) => s.id) };
}

// 한 상시 세션의 tmux 세션 보장 — 살아있으면 재사용(+ 중복 정리), 없으면 격리 워크스페이스에 createSession 으로 재생성.
export async function ensureManagedSession(m: ManagedSession): Promise<{ id: string; session_id?: string; action: string; reaped?: number }> {
  if (!m.enabled) return { id: m.id, action: "disabled" };
  const user = asUser(m.account || "daon");
  // ⚠ **조회 실패를 빈 목록으로 삼키면 안 된다**(#1675 ⑥ 근본원인). 종전엔 `.catch(() => [])` 라
  //  tmux 가 잠깐 안 잡히는 것만으로 "살아있는 세션이 없다" → **새로 만든다** 가 됐다. 이 함수는 2분마다
  //  돌므로 그 오판 하나가 곧 세션 하나이고, 그렇게 30개까지 늘었다. 모르면 **아무것도 하지 않는다.**
  let live: Array<{ id: string; dir?: string; created?: number }>;
  try {
    // strict — tmux 를 **못 본 것**은 예외로 받는다. 기본 모드는 그걸 빈 목록으로 돌려주는데,
    //  이 호출부는 "없으면 만든다"라서 그 오해가 곧 세션 하나다(2분마다 반복 → 30개).
    live = await listSessions(user, { strict: true });
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, managed: m.id }, "상시세션 목록 조회 실패 — 이번 tick 은 생성하지 않는다");
    return { id: m.id, session_id: m.session_id ?? undefined, action: "unknown", reaped: 0 };
  }

  // 이 상시세션의 워크스페이스에 붙은 세션 전수 — 하나만 남기고 나머지는 걷는다.
  const { keep, orphans } = classifyManagedLive({ live, subpath: managedSubpath(m), registered: m.session_id });
  let reaped = 0;
  for (const id of orphans) {
    try { await reapCentralSession(id); reaped++; }
    catch (e) { logger.warn({ err: (e as Error)?.message, managed: m.id, session: id }, "상시세션 중복 정리 실패"); }
  }
  if (reaped) logger.warn({ managed: m.id, reaped, kept: keep }, "상시세션 고아 정리(#1675 ⑥)");

  if (keep) {
    // 레지스트리가 다른 id 를 가리키고 있었으면(또는 비어 있었으면) 지금 살아있는 것으로 맞춘다 —
    //  이 동기화가 없으면 다음 tick 이 같은 판단을 반복하며 계속 새로 만든다.
    if (m.session_id !== keep) {
      await itemsPool.query("UPDATE org_managed_session SET session_id=$1, updated_at=now() WHERE id=$2", [keep, m.id])
        .catch((e) => logger.warn({ err: (e as Error)?.message, managed: m.id }, "상시세션 session_id 동기화 실패"));
    }
    return { id: m.id, session_id: keep, action: m.session_id === keep ? "alive" : "adopted", reaped };
  }
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

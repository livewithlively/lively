// 웹터미널 세션 desired-state DB 미러(#1059 E) — org_session_state CRUD + touch.
//
// 왜(#1059): 세션 메타 SoT 는 tmux @box_* user-option 이라 **재부팅(tmux 서버 사망)에 통째로 증발**한다.
//  이 스토어가 그 desired-state 를 DB 에 미러해, 재부팅 후에도 세션이 '복원 가능(restorable)' 목록으로 남고
//  '열 때' lazy 하게 createSession(resume=<id>)로 재생성된다(terminal-sessions.listRestorableSessions / restore 엔드포인트).
//
// ⚠ **미러지 SoT 아님**: tmux 가 살아있으면 tmux 가 진실. 이 테이블은 재부팅 백업 + F(reaper) desired-state 보존처다.
//  그래서 upsert 는 세션 생성/수정 때 얇게 따라 붙고(best-effort — 실패해도 세션 생성은 안 막는다), 실제 가시성·상태는
//  listSessions(tmux) 가 판정한다. managed 세션은 여기 넣지 않는다(keep-alive 가 영속 소유 — createSession 이 skip).
//
// 관련: src/org/managed-sessions.ts(동형 desired-state 스토어) · src/terminal-sessions.ts(쓰기 배선·복원 병합) ·
//  src/session-reaper.ts(#1059 F — idle 회수 시 이 레코드를 보존해 restorable 로 남긴다).
import { itemsPool } from "../items/store.js";

export interface SessionState {
  id: string;                 // 세션 id(box-<slug>-<hex>) = tmux 세션명 = claude --resume 인자(#905 C1)
  owner: string;              // @box_owner
  label: string | null;
  harness: string;            // claude·codex·shell
  dir: string | null;         // @box_dir(작업 절대경로)
  root_key: string | null;    // 재생성 좌표 — createSession(input.rootKey)
  subpath: string | null;     // 재생성 좌표 — createSession(input.subpath)
  flags: Record<string, string>; // @box_flags(적용된 하네스 플래그)
  auto_approve: boolean;
  invites: string[];          // @box_invites
  project_id: number | null;  // @box_project
  project_src: string | null; // @box_project_src(v6|org)
  read_only: boolean;         // 실행 모드(#1007+)
  incognito: boolean;
  created: number | null;     // session_created(epoch초)
  last_busy: number | null;   // @box_last_busy(마지막 작업 epoch초) — restorable 카드 시간표시용
  last_seen: string | null;   // 마지막 라이브(tmux) 관측 시각(진단용)
  claude_session_id: string | null; // #1059 정밀복원 — 이 box 가 현재 도는 claude 세션 UUID(work-flag 훅 보고, last-write-wins). null=미상→picker.
}

// createSession 이 넘기는 desired-state(생성/재생성 시 upsert). last_seen 은 서버가 now(), claude_session_id 는
//  생성 시점엔 미상(work-flag 훅이 세션 활동 때 사후 setClaudeSessionId 로 채움) — 둘 다 입력에서 제외.
export type SessionStateInput = Omit<SessionState, "last_seen" | "claude_session_id">;

function rowToState(r: Record<string, any>): SessionState {
  return {
    id: r.id, owner: r.owner, label: r.label ?? null, harness: r.harness || "claude",
    dir: r.dir ?? null, root_key: r.root_key ?? null, subpath: r.subpath ?? null,
    flags: (r.flags && typeof r.flags === "object" && !Array.isArray(r.flags)) ? r.flags : {},
    auto_approve: !!r.auto_approve,
    invites: Array.isArray(r.invites) ? r.invites.filter((x: unknown): x is string => typeof x === "string") : [],
    project_id: r.project_id != null ? Number(r.project_id) : null,
    project_src: r.project_src ?? null,
    read_only: !!r.read_only, incognito: !!r.incognito,
    created: r.created != null ? Number(r.created) : null,
    last_busy: r.last_busy != null ? Number(r.last_busy) : null,
    last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    claude_session_id: r.claude_session_id ?? null,
  };
}

// #1059 정밀복원 — work-flag 훅이 (box-id, claude session UUID)를 보고. **owner-gated**(호출자가 그 box 소유자일 때만) +
//  레코드 존재 시에만 갱신(UPDATE, INSERT 안 함 — 미러 없는 세션엔 안 만든다). last-write-wins(UUID 변경 시 최신으로).
//  반환 rowCount>0 = 갱신됨(권한·존재 확인 결과). best-effort 호출(실패 무해).
export async function setClaudeSessionId(id: string, claudeUuid: string, owner: string): Promise<boolean> {
  const r = await itemsPool.query(
    "UPDATE org_session_state SET claude_session_id=$2, updated_at=now() WHERE id=$1 AND owner=$3",
    [id, claudeUuid, owner],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getSessionState(id: string): Promise<SessionState | undefined> {
  const r = await itemsPool.query("SELECT * FROM org_session_state WHERE id=$1", [id]);
  return r.rows[0] ? rowToState(r.rows[0]) : undefined;
}

// 한 소유자의 desired-state 전부(복원 목록의 원천 — 호출자가 tmux 라이브와 병합해 offline 만 남긴다).
export async function listSessionStatesForOwner(owner: string): Promise<SessionState[]> {
  const r = await itemsPool.query("SELECT * FROM org_session_state WHERE owner=$1 ORDER BY COALESCE(last_busy, created, 0) DESC", [owner]);
  return r.rows.map(rowToState);
}

export async function listAllSessionStates(): Promise<SessionState[]> {
  const r = await itemsPool.query("SELECT * FROM org_session_state ORDER BY COALESCE(last_busy, created, 0) DESC");
  return r.rows.map(rowToState);
}

// 세션 생성/재생성 시 desired-state 미러 upsert(#1059 E). id 충돌 시 전량 갱신 + last_seen=now.
//  ⚠ best-effort 로 호출된다(createSession 이 실패를 삼킴) — DB 가 죽어도 세션 생성 자체는 진행돼야 한다.
export async function upsertSessionState(s: SessionStateInput): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_session_state(id, owner, label, harness, dir, root_key, subpath, flags, auto_approve, invites, project_id, project_src, read_only, incognito, created, last_busy, last_seen, updated_at)
     VALUES($1,$2,$3,COALESCE($4,'claude'),$5,$6,$7,COALESCE($8,'{}')::jsonb,COALESCE($9,false),COALESCE($10,'[]')::jsonb,$11,$12,COALESCE($13,false),COALESCE($14,false),$15,$16,now(),now())
     ON CONFLICT (id) DO UPDATE SET
       owner=EXCLUDED.owner, label=EXCLUDED.label, harness=EXCLUDED.harness, dir=EXCLUDED.dir,
       root_key=EXCLUDED.root_key, subpath=EXCLUDED.subpath, flags=EXCLUDED.flags, auto_approve=EXCLUDED.auto_approve,
       invites=EXCLUDED.invites, project_id=EXCLUDED.project_id, project_src=EXCLUDED.project_src,
       read_only=EXCLUDED.read_only, incognito=EXCLUDED.incognito, created=EXCLUDED.created,
       last_busy=EXCLUDED.last_busy, last_seen=now(), updated_at=now()`,
    [s.id, s.owner, s.label, s.harness, s.dir, s.root_key, s.subpath, JSON.stringify(s.flags || {}),
     s.auto_approve, JSON.stringify(s.invites || []), s.project_id, s.project_src, s.read_only, s.incognito,
     s.created, s.last_busy],
  );
}

// 라벨/초대 변경(editSession) 미러. 레코드 없으면 no-op(구 세션은 다음 upsert 계기에 편입).
export async function updateSessionStateMeta(id: string, patch: { label?: string; invites?: string[] }): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (patch.label !== undefined) { vals.push(patch.label); sets.push(`label=$${vals.length}`); }
  if (patch.invites !== undefined) { vals.push(JSON.stringify(patch.invites)); sets.push(`invites=$${vals.length}::jsonb`); }
  if (!sets.length) return;
  sets.push("updated_at=now()");
  await itemsPool.query(`UPDATE org_session_state SET ${sets.join(", ")} WHERE id=$1`, vals);
}

// 마지막 작업 시각 갱신(#1059 E) — collectSessions 의 @box_last_busy 30초 스로틀 쓰기부에 편승(같은 주기).
//  restorable 카드의 '마지막 작업' 표시가 정확하도록. 레코드 없으면 no-op(비치명). last_seen 도 함께(라이브 관측).
export async function touchSessionBusy(id: string, lastBusy: number): Promise<void> {
  await itemsPool.query("UPDATE org_session_state SET last_busy=$2, last_seen=now(), updated_at=now() WHERE id=$1", [id, lastBusy]);
}

// desired-state 삭제 — 사용자가 **명시적으로 kill** 한 세션만(복원 안 함). reaper 회수는 보존(restorable) 하므로 호출 안 함.
export async function deleteSessionState(id: string): Promise<void> {
  await itemsPool.query("DELETE FROM org_session_state WHERE id=$1", [id]);
}

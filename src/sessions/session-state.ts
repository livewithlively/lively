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
// 관련: src/sessions/managed-sessions.ts(동형 desired-state 스토어) · src/terminal/terminal-sessions.ts(쓰기 배선·복원 병합) ·
//  src/sessions/session-reaper.ts(#1059 F — idle 회수 시 이 레코드를 보존해 restorable 로 남긴다).
import { itemsPool } from "../db/client.js";

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
  // #1291 v2 — 기록 범위(write cap)·read 축소. tmux 가 권위, 여기는 미러(재부팅 후 복원이 캡을 잃지 않게).
  //  입력에선 선택(안 실어 보내면 이전 값 보존 — 위 upsert 의 COALESCE 참고), 조회 결과에선 항상 채워진다.
  write_vis?: string | null;   // 'open'|'audience'|'private' / null=미설정(실행 폴더에서 재파생)
  restrict_read?: boolean;
  created: number | null;     // session_created(epoch초)
  last_busy: number | null;   // @box_last_busy(마지막 작업 epoch초) — restorable 카드 시간표시용
  last_seen: string | null;   // 마지막 라이브(tmux) 관측 시각(진단용)
  claude_session_id: string | null; // #1059 정밀복원 — 이 box 가 현재 도는 claude 세션 UUID(work-flag 훅 보고, last-write-wins). null=미상→picker.
  exited_at: string | null;   // #1059 — 사용자 정상 종료(/exit·logout) 표시. null=재부팅·회수(중단됨). 복원목록 라벨 구분용.
  exit_reason: string | null; // #1059 — 종료 사유(prompt_input_exit·logout, 진단용).
}

// createSession 이 넘기는 desired-state(생성/재생성 시 upsert). last_seen 은 서버가 now(), claude_session_id·exited_at·
//  exit_reason 은 생성 시점엔 미상(훅이 세션 시작/종료 때 사후 채움) — 전부 입력에서 제외(생성 시 NULL).
export type SessionStateInput = Omit<SessionState, "last_seen" | "claude_session_id" | "exited_at" | "exit_reason">;

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
    write_vis: (r.write_vis as string | null) ?? null, restrict_read: !!r.restrict_read,
    created: r.created != null ? Number(r.created) : null,
    last_busy: r.last_busy != null ? Number(r.last_busy) : null,
    last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    claude_session_id: r.claude_session_id ?? null,
    exited_at: r.exited_at ? new Date(r.exited_at).toISOString() : null,
    exit_reason: r.exit_reason ?? null,
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

// #1059 — 사용자 **정상 종료** 표시(claude SessionEnd 훅 보고). setClaudeSessionId 와 **동형**: owner-gated(호출자가 그
//  box 소유자일 때만) + 레코드 존재 시에만 UPDATE(INSERT 안 함). 재부팅·강제kill·reaper 는 훅이 못 떠서 안 찍히고(중단됨),
//  이건 사용자가 명시적으로 나간 것만 찍힌다(→ 복원목록에서 '종료됨'으로 구분). 반환 rowCount>0 = 찍힘. best-effort(실패 무해).
export async function markSessionExited(id: string, owner: string, reason: string): Promise<boolean> {
  const r = await itemsPool.query(
    "UPDATE org_session_state SET exited_at=now(), exit_reason=$3, updated_at=now() WHERE id=$1 AND owner=$2",
    [id, owner, reason || null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * #1251 — **earlyoom(OS 보호장치)이 이 세션을 죽였다**고 기록한다. 사유만 남기고 `exited_at` 은 건드리지 않는다.
 *
 * ⚠ `exited_at` 을 세우면 안 된다 — 그건 **사용자 정상 종료** 전용 표시라, 세우는 순간 화면이 '종료됨(내가 끝냄)'이
 *  된다. OOM 은 사용자가 끝낸 게 아니라 **당한** 것이고, 사용자가 알아야 할 사실도 정반대다.
 * ⚠ `exited_at IS NULL` 조건으로 **사용자 종료 표시를 절대 덮지 않는다** — 사용자가 /exit 한 뒤 그 pid 가
 *  재사용됐을 수 있고, 그때는 사용자 종료가 더 확실한 사실이다(관측 추정이 확정 사실을 이기면 안 된다).
 * owner 게이트가 없는 이유: 사용자 요청이 아니라 **게이트웨이 자신의 관측**이다(box-watch 가 저널에서 읽는다).
 * 반환 false = 레코드 없음 또는 이미 사용자 종료로 찍힘(둘 다 정상 — 라벨을 안 붙일 뿐).
 */
export async function markSessionOomKilled(id: string): Promise<boolean> {
  const r = await itemsPool.query(
    "UPDATE org_session_state SET exit_reason='oom', updated_at=now() WHERE id=$1 AND exited_at IS NULL",
    [id],
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
    `INSERT INTO org_session_state(id, owner, label, harness, dir, root_key, subpath, flags, auto_approve, invites, project_id, project_src, read_only, incognito, write_vis, restrict_read, created, last_busy, last_seen, updated_at)
     VALUES($1,$2,$3,COALESCE($4,'claude'),$5,$6,$7,COALESCE($8,'{}')::jsonb,COALESCE($9,false),COALESCE($10,'[]')::jsonb,$11,$12,COALESCE($13,false),COALESCE($14,false),$15,COALESCE($16,false),$17,$18,now(),now())
     ON CONFLICT (id) DO UPDATE SET
       owner=EXCLUDED.owner, label=EXCLUDED.label, harness=EXCLUDED.harness, dir=EXCLUDED.dir,
       root_key=EXCLUDED.root_key, subpath=EXCLUDED.subpath, flags=EXCLUDED.flags, auto_approve=EXCLUDED.auto_approve,
       invites=EXCLUDED.invites, project_id=EXCLUDED.project_id, project_src=EXCLUDED.project_src,
       read_only=EXCLUDED.read_only, incognito=EXCLUDED.incognito,
       -- write_vis 는 **덮어쓰지 않는다**(COALESCE): 재생성 때 캡을 안 실어 보내도 이전에 좁혀둔 값이 살아남아야 한다.
       --  넓히는 방향으로 조용히 풀리면 그게 곧 사고다. 명시적으로 넓히려면 세션 편집 경로를 쓴다.
       write_vis=COALESCE(EXCLUDED.write_vis, org_session_state.write_vis),
       restrict_read=EXCLUDED.restrict_read,
       created=EXCLUDED.created,
       last_busy=EXCLUDED.last_busy, last_seen=now(), updated_at=now()`,
    [s.id, s.owner, s.label, s.harness, s.dir, s.root_key, s.subpath, JSON.stringify(s.flags || {}),
     s.auto_approve, JSON.stringify(s.invites || []), s.project_id, s.project_src, s.read_only, s.incognito,
     s.write_vis ?? null, s.restrict_read ?? false,
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

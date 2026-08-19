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
//
// #1791 — **노드 세션(node_id 있음)도 여기 산다. 쓰는 쪽은 게이트웨이뿐이다.** 노드 에이전트 프로세스(멤버 PC·워커)에는
//  DB 가 없다 — 그래서 이 모듈의 쓰기·읽기는 노드에서 **조용히 no-op** 이다(아래 ON_NODE). 종전엔 노드의 createSession 이
//  같은 upsert 를 시도해 세션마다 "desired-state 미러 실패" 를 찍고, collectSessions 의 desired 조회가 3초마다 실패 로그를
//  남겼다(하루 9천 줄 — 실 오류를 가렸다). 노드 세션의 정본 행은 게이트웨이가 create 릴레이 직후 쓴다
//  (terminal/node-session-state.ts). 노드가 이 표를 읽지 않아도 되는 이유: 노드는 자기 tmux(@box_*)로 충분하고,
//  가시성·복원 판정은 전부 게이트웨이 몫이다(F7 정책/실행 분리).
import { itemsPool } from "../db/client.js";

// 노드 에이전트 프로세스 판별자 — sessions.ts 의 첫 지시 주입 분기와 같은 값(게이트웨이엔 없다).
const ON_NODE = !!process.env.LIVELY_NODE_TOKEN;

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
  app_id?: string | null;     // #1780 D4 — 이 세션이 어느 앱으로 떴나(@box_app 미러). null=일반 세션. 입력에선 선택(미전송=null).
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
                                    //  ⚠ 이름만 claude 다 — 값은 **그 하네스의 대화 id**(codex·opencode·agy·grok 어댑터가 자기 id 를 같은 통로로 보고, #1711).
  transcript_path: string | null;   // #1746 — 그 대화 파일의 절대경로(훅 페이로드 transcript_path, 세션 안에서 보고 → 어느 홈인지 서버가 짐작 안 함).
                                    //  대화창이 이걸로 읽는다(harness-io/locate.ts 가 소유자 뿌리 안인지 검증). null=미보고 → 규약 폴백.
  exited_at: string | null;   // #1059 — 사용자 정상 종료(/exit·logout) 표시. null=재부팅·회수(중단됨). 복원목록 라벨 구분용.
  exit_reason: string | null; // #1059 — 종료 사유(prompt_input_exit·logout, 진단용).
  // #1791 — 이 세션이 도는 노드 id(org_node.id). null = 게이트웨이 박스(중앙 tmux). 복원은 이 노드에 create 를 릴레이하고,
  //  목록은 이 값으로 '그 노드의 세션'임을 표시한다. 조회 결과엔 항상 있고, 입력에선 선택(없으면 박스).
  node_id?: string | null;
}

// createSession 이 넘기는 desired-state(생성/재생성 시 upsert). last_seen 은 서버가 now(), claude_session_id·exited_at·
//  exit_reason 은 생성 시점엔 미상(훅이 세션 시작/종료 때 사후 채움) — 전부 입력에서 제외(생성 시 NULL).
export type SessionStateInput = Omit<SessionState, "last_seen" | "claude_session_id" | "transcript_path" | "exited_at" | "exit_reason">;

// export: session-desired.ts 가 자기 쿼리 결과를 같은 규칙으로 해석해야 한다(파싱이 두 벌이 되면 갈린다).
export function rowToState(r: Record<string, any>): SessionState {
  return {
    id: r.id, owner: r.owner, label: r.label ?? null, harness: r.harness || "claude",
    dir: r.dir ?? null, root_key: r.root_key ?? null, subpath: r.subpath ?? null,
    flags: (r.flags && typeof r.flags === "object" && !Array.isArray(r.flags)) ? r.flags : {},
    auto_approve: !!r.auto_approve,
    invites: Array.isArray(r.invites) ? r.invites.filter((x: unknown): x is string => typeof x === "string") : [],
    project_id: r.project_id != null ? Number(r.project_id) : null,
    project_src: r.project_src ?? null,
    app_id: r.app_id ?? null,   // #1780 D4

    read_only: !!r.read_only, incognito: !!r.incognito,
    write_vis: (r.write_vis as string | null) ?? null, restrict_read: !!r.restrict_read,
    created: r.created != null ? Number(r.created) : null,
    last_busy: r.last_busy != null ? Number(r.last_busy) : null,
    last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    claude_session_id: r.claude_session_id ?? null,
    transcript_path: r.transcript_path ?? null,
    exited_at: r.exited_at ? new Date(r.exited_at).toISOString() : null,
    exit_reason: r.exit_reason ?? null,
    node_id: (r.node_id as string | null) ?? null,
  };
}

// #1059 정밀복원 — work-flag 훅이 (box-id, claude session UUID)를 보고. **owner-gated**(호출자가 그 box 소유자일 때만) +
//  레코드 존재 시에만 갱신(UPDATE, INSERT 안 함 — 미러 없는 세션엔 안 만든다). last-write-wins(UUID 변경 시 최신으로).
//  반환 rowCount>0 = 갱신됨(권한·존재 확인 결과). best-effort 호출(실패 무해).
//  #1746 — transcript_path(그 대화 파일의 절대경로)를 함께 받는다. 안 주면(구 훅) 기존 값을 보존하고, 주면 덮는다(같은 대화 id 라도
//  파일 위치가 바뀔 수 있다 — /clear·resume 은 uuid 자체가 바뀌므로 어차피 새 보고). 검증(뿌리 안인지)은 읽는 쪽(locate.ts)이 한다 —
//  저장은 문자열일 뿐이고, 읽을 때 소유자·하네스 기준으로 걸러야 뜻이 있다.
export async function setClaudeSessionId(id: string, claudeUuid: string, owner: string, transcriptPath?: string | null): Promise<boolean> {
  const r = await itemsPool.query(
    "UPDATE org_session_state SET claude_session_id=$2, transcript_path=COALESCE($4, transcript_path), updated_at=now() WHERE id=$1 AND owner=$3",
    [id, claudeUuid, owner, transcriptPath ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── #1752 갭2 — **노드 세션**의 box-id ↔ 대화 uuid 매핑(org_node_session_map). ──
//  노드 세션은 org_session_state 행이 없어(노드가 DB 없이 생성) 위 setClaudeSessionId 가 0행 UPDATE 로 끝났다 —
//  그 순간 훅이 보고한 대화 uuid 가 증발해, 채팅창이 그 세션의 중앙 기록(session_log — 키가 곧 이 uuid)에 못 닿았다.
//  이 매핑이 있으면: 라이브 노드 세션 = 목록 행에 claudeSessionId 가 실려 채팅창이 중앙 기록으로 폴백하고,
//  노드가 꺼진 뒤 = 기록 행(session_log)으로 계속 읽힌다. 스키마 근거: org/schema/node-session-map.ts.
//  owner 가드: 첫 보고자가 owner 로 고정되고, 이후 갱신은 같은 owner 일 때만(남의 box_id 를 가로채 남의 채팅창을
//  엉뚱한 대화로 보내는 오염 차단 — setClaudeSessionId 의 owner-gate 와 같은 이유). last-write-wins(uuid 변경 시 최신).
export async function setNodeSessionMap(
  boxId: string, nodeId: string, convUuid: string, owner: string, transcriptPath?: string | null,
): Promise<boolean> {
  const r = await itemsPool.query(
    `INSERT INTO org_node_session_map(box_id, node_id, conv_uuid, transcript_path, owner, updated_at)
     VALUES($1,$2,$3,$4,$5,now())
     ON CONFLICT (tenant_id, box_id) DO UPDATE SET
       node_id=EXCLUDED.node_id, conv_uuid=EXCLUDED.conv_uuid,
       transcript_path=COALESCE(EXCLUDED.transcript_path, org_node_session_map.transcript_path), updated_at=now()
     WHERE org_node_session_map.owner = EXCLUDED.owner`,
    [boxId, nodeId, convUuid, transcriptPath ?? null, owner],
  );
  return (r.rowCount ?? 0) > 0;
}

// 목록 보강용 일괄 조회 — box_id → {node_id, conv_uuid}. claudeSessionIdsFor(박스 세션)와 짝(노드 세션판).
export async function nodeSessionMapFor(ids: string[]): Promise<Map<string, { node_id: string; conv_uuid: string }>> {
  const out = new Map<string, { node_id: string; conv_uuid: string }>();
  if (!ids.length) return out;
  const r = await itemsPool.query(
    "SELECT box_id, node_id, conv_uuid FROM org_node_session_map WHERE box_id = ANY($1::text[])",
    [ids],
  );
  for (const row of r.rows) out.set(String(row.box_id), { node_id: String(row.node_id), conv_uuid: String(row.conv_uuid) });
  return out;
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

// #1719 세션 대화창 — 라이브 세션 행에 '이 박스가 도는 대화 UUID' 를 실어 주기 위한 일괄 조회.
//  목록 라우트가 세션마다 getSessionState 를 부르면 세션 수만큼 왕복이라(실측 dev 200+행), 한 번에 가져온다.
//  없는 id·미보고(NULL)는 결과에 없다 — 호출자가 '모름'으로 다룬다(추측하지 않는다, 위 claude_session_id 주석).
export async function claudeSessionIdsFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const r = await itemsPool.query(
    "SELECT id, claude_session_id FROM org_session_state WHERE id = ANY($1::text[]) AND claude_session_id IS NOT NULL",
    [ids],
  );
  for (const row of r.rows) out.set(String(row.id), String(row.claude_session_id));
  return out;
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
  if (ON_NODE) return;   // #1791 — 노드엔 DB 가 없다. 노드 세션의 행은 게이트웨이가 릴레이 직후 쓴다(헤더).
  await itemsPool.query(
    `INSERT INTO org_session_state(id, owner, label, harness, dir, root_key, subpath, flags, auto_approve, invites, project_id, project_src, read_only, incognito, write_vis, restrict_read, created, last_busy, node_id, app_id, last_seen, updated_at)
     VALUES($1,$2,$3,COALESCE($4,'claude'),$5,$6,$7,COALESCE($8,'{}')::jsonb,COALESCE($9,false),COALESCE($10,'[]')::jsonb,$11,$12,COALESCE($13,false),COALESCE($14,false),$15,COALESCE($16,false),$17,$18,$19,$20,now(),now())
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       owner=EXCLUDED.owner, label=EXCLUDED.label, harness=EXCLUDED.harness, dir=EXCLUDED.dir,
       root_key=EXCLUDED.root_key, subpath=EXCLUDED.subpath, flags=EXCLUDED.flags, auto_approve=EXCLUDED.auto_approve,
       invites=EXCLUDED.invites, project_id=EXCLUDED.project_id, project_src=EXCLUDED.project_src,
       read_only=EXCLUDED.read_only, incognito=EXCLUDED.incognito,
       -- write_vis 는 **덮어쓰지 않는다**(COALESCE): 재생성 때 캡을 안 실어 보내도 이전에 좁혀둔 값이 살아남아야 한다.
       --  넓히는 방향으로 조용히 풀리면 그게 곧 사고다. 명시적으로 넓히려면 세션 편집 경로를 쓴다.
       write_vis=COALESCE(EXCLUDED.write_vis, org_session_state.write_vis),
       restrict_read=EXCLUDED.restrict_read,
       created=EXCLUDED.created,
       -- node_id 는 세션 정체성의 일부다(같은 id 가 다른 노드로 옮겨 가는 일은 없다) — 그래도 EXCLUDED 로 그대로 쓴다:
       --  백필(중앙 tmux 만 훑는다)이 박스 세션에 NULL 을 넣고, 노드 릴레이가 노드 세션에 그 노드를 넣는다. 둘이 한 id 를 두고
       --  다투는 경우는 id 가 무작위라 없다.
       node_id=EXCLUDED.node_id,
       last_busy=EXCLUDED.last_busy, app_id=EXCLUDED.app_id, last_seen=now(), updated_at=now()`,
    [s.id, s.owner, s.label, s.harness, s.dir, s.root_key, s.subpath, JSON.stringify(s.flags || {}),
     s.auto_approve, JSON.stringify(s.invites || []), s.project_id, s.project_src, s.read_only, s.incognito,
     s.write_vis ?? null, s.restrict_read ?? false,
     s.created, s.last_busy, s.node_id ?? null, s.app_id ?? null],
  );
}

// 라벨/초대 변경(editSession) 미러. 레코드 없으면 no-op(구 세션은 다음 upsert 계기에 편입).
export async function updateSessionStateMeta(id: string, patch: { label?: string; invites?: string[]; project_id?: number | null; project_src?: "v6" | "org" | null }): Promise<void> {
  if (ON_NODE) return;   // #1791 — 노드엔 DB 가 없다(게이트웨이가 릴레이 뒤 자기 행을 고친다)
  const sets: string[] = [];
  const vals: unknown[] = [id];
  if (patch.label !== undefined) { vals.push(patch.label); sets.push(`label=$${vals.length}`); }
  if (patch.invites !== undefined) { vals.push(JSON.stringify(patch.invites)); sets.push(`invites=$${vals.length}::jsonb`); }
  // #1719 — 프로젝트 소속 변경(session-project). 복원(restore)이 이 값으로 @box_project 를 되살린다. null = 뗌.
  if (patch.project_id !== undefined) { vals.push(patch.project_id); sets.push(`project_id=$${vals.length}`); vals.push(patch.project_id ? (patch.project_src ?? "v6") : null); sets.push(`project_src=$${vals.length}`); }
  if (!sets.length) return;
  sets.push("updated_at=now()");
  await itemsPool.query(`UPDATE org_session_state SET ${sets.join(", ")} WHERE id=$1`, vals);
}

// 마지막 작업 시각 갱신(#1059 E) — collectSessions 의 @box_last_busy 30초 스로틀 쓰기부에 편승(같은 주기).
//  restorable 카드의 '마지막 작업' 표시가 정확하도록. 레코드 없으면 no-op(비치명). last_seen 도 함께(라이브 관측).
export async function touchSessionBusy(id: string, lastBusy: number): Promise<void> {
  if (ON_NODE) return;   // #1791 — 노드엔 DB 가 없다(노드 세션의 last_busy 는 상태 push 로 게이트웨이가 알고 있다)
  await itemsPool.query("UPDATE org_session_state SET last_busy=$2, last_seen=now(), updated_at=now() WHERE id=$1", [id, lastBusy]);
}

// desired-state 삭제 — 사용자가 **명시적으로 kill** 한 세션만(복원 안 함). reaper 회수는 보존(restorable) 하므로 호출 안 함.
export async function deleteSessionState(id: string): Promise<void> {
  if (ON_NODE) return;   // #1791 — 노드엔 DB 가 없다(노드 세션 kill 은 게이트웨이 DELETE 라우트가 행을 지운다)
  await itemsPool.query("DELETE FROM org_session_state WHERE id=$1", [id]);
}

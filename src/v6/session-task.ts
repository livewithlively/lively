// 세션 = 태스크 (#4084 · 요청 장원준 2026-09-19).
//
//  ── 무엇을 하나 ───────────────────────────────────────────────────────────
//  프로젝트 안에서 도는 세션은 **각자 태스크 하나를 맡는다**. 세션 1 : 태스크 1, 태스크 1 : 세션 N(어제 하던 태스크를
//   오늘 새 세션에서 이어 하는 경우). 정본은 `execution_session.task_id` 한 칸이다(세션↔프로젝트 소속과 같은 행).
//  태스크가 생기는 길은 둘뿐이다:
//   ① 세션이 **프로젝트에 붙을 때** 서버가 만든다(launchSession → ensureSessionTask). 이름은 그 순간 세션이 이미
//      가지고 있는 것 — 사람이 컴포저에 친 첫 지시를 서버가 자른 규칙 이름(sessions.ts `sessionNameFromPrompt`)이다.
//      ⚠ 2026-09-20 정정: 처음엔 이 자리를 **이름짓기 툴(session_rename)** 에 걸었는데, 그건 «AI 가 그 툴을 불러
//       주면» 이라는 조건이 붙은 것이라 하드가 아니었다 — 배포 당일 실측에서 프로젝트 세션 6개 중 3개만 태스크가
//       생겼다(나머지는 규칙 이름만 있고 AI 가 아직/영영 session_rename 을 안 부른 세션). 세션 생성은 서버가 반드시
//       지나는 자리이므로 여기로 옮기면 모델 재량이 사라진다(원준님: "그 제목으로 하드하게 태스크를 만들도록").
//      그 뒤 AI 가 더 나은 이름을 등록하면(relabelSession) **태스크 이름도 한 번 따라간다**(renameSessionTaskForLabel
//       — 사람이 손대지 않은 태스크만). 프로젝트 이름 승계(renameShellProjectForSession)와 같은 문법이다.
//      첫 지시가 없어 이름이 세션 id 그대로인 세션은 태스크도 안 생긴다 — 빈 태스크가 쌓이지 않는 이유다.
//   ② 사람이 **태스크에서 세션을 연다**(프로젝트 세션 생성 요청의 taskId → bindSessionTask). 미리 적어 둔 태스크를
//      그 세션이 처음부터 맡는다 — 새 태스크를 만들지 않는다. 원준님 결정(2026-09-19): 그냥 연 세션에서 AI 가 기존 태스크를
//      알아보고 이어받는 판단은 **넣지 않는다**(버튼으로만 잇는다). 그래서 ①은 판단 없이 늘 새로 만든다.
//
//  ── 상태 ─────────────────────────────────────────────────────────────────
//  잇는 순간 «진행 중»(in_progress), 세션이 요청받은 일을 끝내면 «완료»(done) — 후자는 세션 자신이 `session_task` 로
//   바꾼다(capabilities/session-task.ts). 같은 세션에서 후속 작업을 시작하면 다시 «진행 중». 세션이 죽거나 지워져도
//   태스크 상태는 건드리지 않는다 — 일이 끝났는지는 세션의 생사가 아니라 일의 상태다(사람이 보드에서 정한다).
//
//  ⚠ 실패를 만들지 않는다 — ①은 사용자 턴 **안에서** 불리는 이름짓기의 뒤편이다. 여기서 던지면 모델이 다시 부르느라
//   턴만 길어진다(#1979 의 전제). 소속 없음·DB 오류는 전부 null 로 돌려주고 로그만 남긴다.
import { itemsPool, one, q } from "../db/client.js";
import { onNode } from "../exec-topology.js";
import { createTask, updateTask, deleteTaskNode, getProjectRow, rootProjectIdOfTaskNode } from "./project-store.js";
import { ensureAgentsMd } from "./agents-md.js";
import { executionSessionProject } from "./execution-session-store.js";

/** 세션이 맡은 태스크 — 모델·화면에 돌려주는 모양(태스크 행의 일부 + 루트 프로젝트). */
export interface SessionTask {
  id: number;
  name: string;
  status: string;
  level: string;
  project_id: number;
}

/** 세션에서 바꿀 수 있는 상태 — 할 일(todo)로 되돌리는 건 사람의 일이다(세션이 맡은 순간 이미 진행 중이다). */
export type SessionTaskStatus = "in_progress" | "done";

const TASK_NAME_MAX = 200;   // task_create_v6 와 같은 상한

/** 순수 — 세션 이름으로 만드는 태스크의 이름·본문. 이름이 비면 null(만들지 않는다). */
export function sessionTaskSpec(labelRaw: string, sessionId: string): { name: string; description: string } | null {
  const name = String(labelRaw ?? "").trim().slice(0, TASK_NAME_MAX);
  if (!name) return null;
  return {
    name,
    description: [
      `> ⚙ 세션 «${name}»(\`${sessionId}\`)이 이름을 지으면서 **자동으로 만든** 태스크입니다 — 이 세션이 맡은 일입니다.`,
      "> 세션이 요청받은 일을 끝내면 «완료»로 바뀝니다. 같은 일을 다른 세션에서 이어 하려면 이 태스크에서 세션을 여세요.",
    ].join("\n"),
  };
}

/** 순수 — 이 태스크를 세션에 이을 때 상태를 어떻게 바꾸나. 이미 «진행 중»이면 null(쓰기 없음). */
export function statusOnBind(status: string | null | undefined): SessionTaskStatus | null {
  return String(status ?? "") === "in_progress" ? null : "in_progress";
}

/** 태스크 노드(task·subtask)를 SessionTask 로 — 루트 프로젝트를 못 찾으면 null. */
async function toSessionTask(row: { id: number; name: string; status: string; level: string; parent_id: number | null }): Promise<SessionTask | null> {
  const pid = await rootProjectIdOfTaskNode(row);
  if (!pid) return null;
  return { id: Number(row.id), name: String(row.name), status: String(row.status), level: String(row.level), project_id: pid };
}

/** 이 세션이 맡은 태스크. 없거나(연결 없음·태스크 삭제) 남의 세션이면 null. */
export async function sessionTaskOf(sessionId: string, owner: string): Promise<SessionTask | null> {
  if (onNode() || !sessionId || !owner) return null;
  const row = await one(itemsPool,
    `SELECT t.id, t.name, t.status, t.level, t.parent_id
       FROM execution_session es JOIN project t ON t.id = es.task_id
      WHERE es.id=$1 AND es.owner=$2 AND t.level IN ('task','subtask') AND t.trashed_at IS NULL`, [sessionId, owner]);
  return row ? await toSessionTask(row) : null;
}

/** 태스크 상태를 바꾸고 AGENTS.md 태스크 인덱스를 갱신한다. 커스텀 상태 키(status_raw)가 남아 있으면 비운다 — 안 비우면 보드가 옛 상태로 그린다. */
async function writeStatus(taskId: number, status: SessionTaskStatus, actor: string, hadRaw: boolean, projectId: number): Promise<void> {
  await updateTask(taskId, { status, ...(hadRaw ? { status_raw: null } : {}) }, { actor, source: "web" });
  await ensureAgentsMd(projectId).catch(() => { /* 인덱스의 상태 표시일 뿐 — 다음 갱신이 채운다 */ });
}

/**
 * 복원으로 **id 가 바뀐 세션**이 이어받을 태스크(#2231 이정표). 같은 주인·같은 프로젝트의 것만.
 *
 *  왜: 세션을 복원하면 박스 id 가 새로 발급되고(옛 행에 `superseded_by` 가 박힌다), 실행 세션도 새 행이다.
 *   그 사실을 모르면 «대화는 이어졌는데 태스크가 하나 더» 가 된다 — 2026-09-20 이 기능 자신이 그렇게 #4087/#4095
 *   두 개를 만들었다(실측). 이정표는 이미 있으니 따라가기만 하면 된다.
 *  상태는 **건드리지 않는다** — 복원은 사람이 «다시 하겠다» 고 누른 것이 아니다(그건 bindSessionTask 의 몫).
 */
async function inheritedTaskId(sessionId: string, owner: string, projectId: number): Promise<number | null> {
  const row = await one(itemsPool,
    `SELECT es.task_id
       FROM org_session_state s
       JOIN execution_session es ON es.id = s.id AND es.owner = $2
       JOIN project t ON t.id = es.task_id AND t.level IN ('task','subtask') AND t.trashed_at IS NULL
      WHERE s.superseded_by = $1 AND s.owner = $2
      ORDER BY s.updated_at DESC LIMIT 1`, [sessionId, owner]);
  const tid = Number(row?.task_id ?? 0);
  if (!(tid > 0)) return null;
  const t = await one(itemsPool, `SELECT id, name, status, level, parent_id FROM project WHERE id=$1`, [tid]);
  const st = t ? await toSessionTask(t) : null;
  return st && st.project_id === projectId ? st.id : null;   // 다른 프로젝트의 태스크는 안 물려받는다
}

/** 순수 — 자동으로 만든 태스크의 이름을 세션의 새 이름으로 바꿀 자리인가. 사람이 손댔으면(이름이 다르면) 물러난다. */
export function shouldRenameSessionTask(current: string | null | undefined, expectName: string | null | undefined, next: string): boolean {
  const cur = String(current ?? "").trim(), exp = String(expectName ?? "").trim(), nx = String(next ?? "").trim();
  return !!cur && !!exp && !!nx && cur === exp && cur !== nx;
}

/**
 * 세션이 **이름을 새로 등록했다** — 그 세션이 맡은 태스크의 이름도 따라간다(한 번, 사람이 안 건드린 것만).
 *  expectName(직전 세션 이름)과 태스크 이름이 같을 때만 바꾼다 — 누가 태스크 이름을 손봤으면 그게 이긴다.
 *  프로젝트 이름 승계(shouldRenameShellProject 의 expectName)와 **같은 판정 문법**이다.
 */
export async function renameSessionTaskForLabel(args: {
  sessionId: string; owner: string; name: string; expectName?: string | null;
}): Promise<SessionTask | null> {
  if (onNode() || !args.sessionId || !args.owner) return null;
  try {
    const task = await sessionTaskOf(args.sessionId, args.owner);
    if (!task || !shouldRenameSessionTask(task.name, args.expectName, args.name)) return null;
    const name = String(args.name).trim().slice(0, TASK_NAME_MAX);
    const after = await updateTask(task.id, { name }, { actor: args.owner, source: "web" });
    await ensureAgentsMd(task.project_id).catch(() => { /* 인덱스는 다음 갱신이 채운다 */ });
    return { ...task, name: after.name };
  } catch (e) {
    console.warn("[session-task] 태스크 이름 승계 실패(비치명):", (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * 이 세션의 태스크를 **보장**한다 — 있으면 그대로, 없으면 이 세션 이름으로 만들어 잇는다(①).
 *  세션이 프로젝트에 붙어 있지 않으면 null(태스크는 프로젝트 안에서만 산다).
 *  이미 맡은 태스크가 **다른 프로젝트**의 것이면(세션이 옮겨졌다) 새 프로젝트에 새로 만든다.
 *  반환의 created 는 이번에 만들었는지 — 모델에게 "태스크가 생겼다"를 한 번만 알리는 근거다.
 */
export async function ensureSessionTask(args: {
  sessionId: string; owner: string; name: string;
}): Promise<(SessionTask & { created: boolean }) | null> {
  if (onNode() || !args.sessionId || !args.owner) return null;
  try {
    const cur = await executionSessionProject(args.sessionId, args.owner);
    const pid = Number(cur?.project_id ?? 0);
    if (!(pid > 0)) return null;
    const existing = await sessionTaskOf(args.sessionId, args.owner);
    if (existing && existing.project_id === pid) return { ...existing, created: false };
    const project = await getProjectRow(pid);
    if (!project || project.level !== "project") return null;
    const spec = sessionTaskSpec(args.name, args.sessionId);
    if (!spec) return null;

    // 복원으로 id 가 바뀐 세션이면 **옛 세션의 태스크를 이어받는다** — 새로 만들지 않는다.
    const inherited = await inheritedTaskId(args.sessionId, args.owner, pid);
    if (inherited) {
      const took = await itemsPool.query(
        `UPDATE execution_session SET task_id=$3, updated_at=now() WHERE id=$1 AND owner=$2 AND task_id IS NULL RETURNING id`,
        [args.sessionId, args.owner, inherited]);
      if (took.rowCount) {
        const now = await sessionTaskOf(args.sessionId, args.owner);
        if (now) return { ...now, created: false };
      }
    }

    const task = await createTask({ projectId: pid, name: spec.name, description: spec.description }, { actor: args.owner, source: "web" });
    // 잇기 — **비어 있을 때만**(또는 옛 프로젝트의 태스크일 때만) 이긴다. 같은 순간 두 길(이름짓기·태스크에서 열기)이
    //  겹치면 진 쪽이 방금 만든 태스크를 치운다 — 세션 하나에 태스크 둘이 매달린 채 하나가 고아로 남지 않게.
    const won = await itemsPool.query(
      `UPDATE execution_session SET task_id=$3, updated_at=now()
        WHERE id=$1 AND owner=$2 AND (task_id IS NULL OR task_id IS NOT DISTINCT FROM $4::int)
        RETURNING id`, [args.sessionId, args.owner, task.id, existing?.id ?? null]);
    if (!(won.rowCount ?? 0)) {
      await deleteTaskNode(task.id, { actor: args.owner, source: "web" }).catch(() => { /* 고아 1건 — 보드에서 보인다 */ });
      const now = await sessionTaskOf(args.sessionId, args.owner);
      return now ? { ...now, created: false } : null;
    }
    // 담당자 = 세션을 연 사람, 상태 = 진행 중. 한 번의 패치로(감사 기록도 한 줄).
    const after = await updateTask(task.id, { status: "in_progress", assignee: args.owner }, { actor: args.owner, source: "web" });
    await ensureAgentsMd(pid).catch(() => { /* 태스크 인덱스는 다음 갱신이 채운다 */ });
    return { id: after.id, name: after.name, status: after.status, level: after.level, project_id: pid, created: true };
  } catch (e) {
    console.warn("[session-task] 세션 태스크 보장 실패(비치명):", (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * 사람이 태스크에서 연 세션에 그 태스크를 잇는다(②). 태스크는 **이 세션의 프로젝트** 안의 것이어야 한다.
 *  잇는 순간 «진행 중» — 완료된 태스크에서 세션을 열었다면 다시 하겠다는 뜻이므로 되연다. 담당자가 비었으면 연 사람.
 */
export async function bindSessionTask(args: {
  sessionId: string; owner: string; taskId: number;
}): Promise<SessionTask | null> {
  if (onNode() || !args.sessionId || !args.owner || !(args.taskId > 0)) return null;
  const row = await one(itemsPool,
    `SELECT id, name, status, status_raw, level, parent_id, assignee FROM project WHERE id=$1 AND level IN ('task','subtask')`, [args.taskId]);
  if (!row) return null;
  const task = await toSessionTask(row);
  if (!task) return null;
  const cur = await executionSessionProject(args.sessionId, args.owner);
  if (Number(cur?.project_id ?? 0) !== task.project_id) return null;
  const r = await itemsPool.query(
    `UPDATE execution_session SET task_id=$3, updated_at=now() WHERE id=$1 AND owner=$2 RETURNING id`,
    [args.sessionId, args.owner, task.id]);
  if (!(r.rowCount ?? 0)) return null;
  const next = statusOnBind(row.status);
  const patch: { status?: string; status_raw?: null; assignee?: string } = {};
  if (next) { patch.status = next; if (row.status_raw != null) patch.status_raw = null; }
  if (!row.assignee) patch.assignee = args.owner;
  if (Object.keys(patch).length) {
    const after = await updateTask(task.id, patch, { actor: args.owner, source: "web" });
    await ensureAgentsMd(task.project_id).catch(() => { /* */ });
    return { ...task, status: after.status };
  }
  return task;
}

/** 세션이 자기 태스크의 상태를 바꾼다(`session_task {status}`). 맡은 태스크가 없으면 null. */
export async function setSessionTaskStatus(args: {
  sessionId: string; owner: string; status: SessionTaskStatus;
}): Promise<SessionTask | null> {
  const task = await sessionTaskOf(args.sessionId, args.owner);
  if (!task) return null;
  if (task.status === args.status) return task;
  const raw = await one(itemsPool, `SELECT status_raw FROM project WHERE id=$1`, [task.id]);
  await writeStatus(task.id, args.status, args.owner, raw?.status_raw != null, task.project_id);
  return { ...task, status: args.status };
}

/** 태스크들에 붙은 세션(화면의 태스크 줄 → 세션 칩). 세션 이름은 세션 미러(org_session_state)에서. */
export async function sessionsOfTasks(taskIds: number[]): Promise<Map<number, Array<{ id: string; label: string | null; owner: string }>>> {
  const out = new Map<number, Array<{ id: string; label: string | null; owner: string }>>();
  const ids = [...new Set((taskIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (onNode() || !ids.length) return out;
  const rows = await q(itemsPool,
    `SELECT es.task_id, es.id, es.owner, s.label
       FROM execution_session es LEFT JOIN org_session_state s ON s.id = es.id
      WHERE es.task_id = ANY($1::int[])
        AND NOT EXISTS (SELECT 1 FROM org_session_trash tr WHERE tr.session_id = es.id)
      ORDER BY es.created_at DESC`, [ids]);
  for (const r of rows as Array<{ task_id: number; id: string; owner: string; label: string | null }>) {
    let a = out.get(Number(r.task_id));
    if (!a) { a = []; out.set(Number(r.task_id), a); }
    a.push({ id: String(r.id), label: r.label ?? null, owner: String(r.owner) });
  }
  return out;
}

/** 프로젝트 문맥(AGENTS.md 주입)에 덧붙이는 «이 세션의 태스크» 절. 태스크가 없으면 빈 문자열. */
export function sessionTaskSection(task: SessionTask | null): string {
  if (!task) return "";
  return [
    "## 이 세션의 태스크",
    `- [#${task.id}] ${task.name} (${task.status})`,
    "- 요청받은 일을 끝내면(검증까지 마치고) `session_task {status:\"done\"}` 로 완료 처리하세요. " +
      "같은 세션에서 후속 작업을 시작하면 `session_task {status:\"in_progress\"}` 로 되돌립니다.",
  ].join("\n");
}

/** 태스크에서 세션을 열 때의 재료 — 이 프로젝트 안의 태스크(task·subtask)만. 아니면 null(라우트가 400). */
export async function taskForProjectSession(projectId: number, taskId: number): Promise<{ id: number; name: string; description: string | null } | null> {
  if (!(projectId > 0) || !(taskId > 0)) return null;
  const row = await one(itemsPool,
    `SELECT id, name, description, level, parent_id FROM project WHERE id=$1 AND level IN ('task','subtask')`, [taskId]);
  if (!row) return null;
  const root = await rootProjectIdOfTaskNode(row);
  if (root !== projectId) return null;
  return { id: Number(row.id), name: String(row.name), description: row.description ?? null };
}

const KICKOFF_BODY_MAX = 3000;

/**
 * 순수 — 태스크에서 연 세션의 첫 지시(사람이 따로 적지 않았을 때). 핸드오버 규약(«#<id> 진행해»)과 같은 모양에
 *  태스크 본문을 싣는다 — 다음 세션이 프로젝트·태스크 명세만으로 첫 행동을 알 수 있게 쓰는 것이 이 조직의 관례다.
 */
export function taskKickoffPrompt(task: { id: number; name: string; description?: string | null }): string {
  const body = String(task.description ?? "").trim();
  return [
    `태스크 #${task.id} «${task.name}» 을(를) 진행해 주세요.`,
    ...(body ? ["", "## 태스크 본문", "", body.length > KICKOFF_BODY_MAX ? body.slice(0, KICKOFF_BODY_MAX) + "\n\n…(이하 생략 — task_detail_v6 로 전문 조회)" : body] : []),
  ].join("\n");
}

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
import { itemsPool, one, q, withTx } from "../db/client.js";
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

/**
 * 순수 — 세션 이름을 **태스크 이름으로** 다듬는다.
 *
 *  세션 이름은 첫 지시를 자른 것이라(sessionNameFromPrompt) 두 가지를 달고 온다: 앞의 목록기호(`- 사이드바 …`)와
 *  뒤의 말줄임(`… 되게 많이 얘…`). 세션 목록에선 원문의 흔적이라 자연스럽지만, **보드에 서는 할 일 이름**으로는
 *  군더더기다(실측 2026-09-20: 백필한 3778 태스크 셋 중 둘이 그 모양이었다). 숫자 목록(`2. 구현`)은 건드리지
 *  않는다 — 사람이 그렇게 이름 붙인 태스크가 실제로 있고(핸드오버 관례), 지우면 뜻이 바뀐다.
 */
export function tidyTaskName(raw: string): string {
  return String(raw ?? "").trim()
    .replace(/^[-*·•]+\s+/, "")        // 앞 목록기호(숫자 목록은 제외)
    .replace(/\s*(…|\.{3})$/, "")      // 뒤 말줄임(자름 표시)
    .trim()
    .slice(0, TASK_NAME_MAX);
}

/** 순수 — 세션 이름으로 만드는 태스크의 이름·본문. 이름이 비면 null(만들지 않는다). */
export function sessionTaskSpec(labelRaw: string, sessionId: string): { name: string; description: string } | null {
  const name = tidyTaskName(labelRaw);
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
async function writeStatus(taskId: number, status: SessionTaskStatus, actor: string, hadRaw: boolean, projectId: number, reason?: string | null): Promise<void> {
  await updateTask(taskId, { status, ...(hadRaw ? { status_raw: null } : {}) }, { actor, source: "web", reason: reason ?? null });
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
    const name = tidyTaskName(args.name);
    if (!name) return null;
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
  /** 순서 목록을 건드리지 않는다 — 목록 규칙이 이미 이 태스크를 골랐다(setSessionTaskOrder · 다음 것으로 넘기기). */
  keepOrder?: boolean;
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
  // 순서 목록(#4135)이 있는 세션이면 이 태스크를 **맨 앞**으로 — «지금 하는 것 = 목록 맨 앞의 안 끝난 것» 이 어긋나지 않게.
  //  목록이 없는 세션(행 0)은 건드리지 않는다 — task_id 하나가 곧 목록이다.
  if (!args.keepOrder) await withTx(async (db) => {
    const lo = await one(db, `SELECT MIN(pos) AS p, COUNT(*)::int AS n FROM execution_session_task WHERE session_id=$1`, [args.sessionId]);
    if (!(Number(lo?.n) > 0)) return;
    await db.query(`DELETE FROM execution_session_task WHERE session_id=$1 AND task_id=$2`, [args.sessionId, task.id]);
    await db.query(`INSERT INTO execution_session_task(session_id, task_id, pos) VALUES($1,$2,$3)`, [args.sessionId, task.id, Number(lo.p) - 1]);
  });
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

/** 순수 — 세션이 닫을 때의 근거. 세션이 적어 준 게 있으면 그것, 없으면 «어느 세션이 끝냈다고 보고했는지»라도 남긴다. */
export function sessionCloseReason(reason: string | null | undefined, sessionId: string): string {
  return (reason ?? "").trim() || `AI 세션(${sessionId})이 맡은 작업을 끝냈다고 보고했습니다`;
}

/** 세션이 자기 태스크의 상태를 바꾼다(`session_task {status}`). 맡은 태스크가 없으면 null.
 *  끝냈고(done) 이 세션의 순서 목록에 **아직 안 끝난 다음 태스크**가 있으면 그리로 넘어간다(#4135) — `next` 로 돌려준다. */
export async function setSessionTaskStatus(args: {
  sessionId: string; owner: string; status: SessionTaskStatus; reason?: string | null;
}): Promise<(SessionTask & { next?: SessionTask | null }) | null> {
  const task = await sessionTaskOf(args.sessionId, args.owner);
  if (!task) return null;
  if (task.status !== args.status) {
    const raw = await one(itemsPool, `SELECT status_raw FROM project WHERE id=$1`, [task.id]);
    await writeStatus(task.id, args.status, args.owner, raw?.status_raw != null, task.project_id, sessionCloseReason(args.reason, args.sessionId));
  }
  if (args.status !== "done") return { ...task, status: args.status };
  const list = await sessionTaskList(args.sessionId, args.owner);
  const nextId = nextTaskInOrder(list.map((t) => ({ id: t.id, done: t.id === task.id || t.status === "done" })));
  if (!nextId) return { ...task, status: args.status, next: null };
  const next = await bindSessionTask({ sessionId: args.sessionId, owner: args.owner, taskId: nextId, keepOrder: true });
  return { ...task, status: args.status, next };
}

// ── 한 세션 · 여러 태스크(#4135) ─────────────────────────────────────────────────
//  곁칸 «프로젝트» 앱의 «이 세션의 태스크» 1. 2. 3. 이다. 정본은 execution_session_task(세션의 순서 목록)이고, task_id 는
//   그 목록에서 **지금 하는 것** 한 칸이다. 규칙은 하나 — **지금 하는 것 = 목록 맨 앞의 안 끝난 것.** 사람이 순서를 바꾸면
//   그 규칙대로 task_id 가 따라가고, 세션이 하나를 끝내면(session_task done) 다음 것으로 넘어간다.
//  행이 없는 세션은 task_id 하나가 곧 목록이다 — 이 기능 전의 세션은 이관 없이 같은 뜻으로 읽힌다.

const ORDER_MAX = 30;   // 한 세션이 줄 세울 태스크 상한 — 곁칸 목록이 읽히는 길이

/** 순수 — 표의 순서 목록과 task_id 를 합친다. task_id 가 목록에 없으면(다른 길로 이어졌다) 맨 앞에 둔다. */
export function mergeTaskOrder(current: number | null | undefined, ids: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const x of ids || []) { const n = Number(x); if (n > 0 && !out.includes(n)) out.push(n); }
  const c = Number(current ?? 0);
  if (c > 0 && !out.includes(c)) out.unshift(c);
  return out;
}

/** 순수 — 순서 목록에서 지금 할 것(맨 앞의 안 끝난 것). 다 끝났으면 null. */
export function nextTaskInOrder(list: Array<{ id: number; done: boolean }>): number | null {
  const hit = (list || []).find((t) => !t.done);
  return hit ? hit.id : null;
}

/** 이 세션의 태스크 **순서 목록**(주인만 · 휴지통 태스크 제외). 세션이 없거나 남의 것이면 빈 배열. */
export async function sessionTaskList(sessionId: string, owner: string): Promise<Array<{ id: number; name: string; status: string; current: boolean }>> {
  if (onNode() || !sessionId || !owner) return [];
  const es = await one(itemsPool,
    `SELECT es.task_id,
            COALESCE((SELECT array_agg(x.task_id ORDER BY x.pos) FROM execution_session_task x WHERE x.session_id = es.id), '{}') AS ids
       FROM execution_session es WHERE es.id=$1 AND es.owner=$2`, [sessionId, owner]);
  if (!es) return [];
  const order = mergeTaskOrder(es.task_id, es.ids || []);
  if (!order.length) return [];
  const rows = await q(itemsPool,
    `SELECT id, name, status FROM project WHERE id = ANY($1::int[]) AND level IN ('task','subtask') AND trashed_at IS NULL`, [order]);
  const by = new Map(rows.map((r: any) => [Number(r.id), r]));
  return order.filter((id) => by.has(id)).map((id) => {
    const r: any = by.get(id);
    return { id, name: String(r.name), status: String(r.status), current: id === Number(es.task_id) };
  });
}

/**
 * 사람이 이 세션의 태스크 순서를 정한다(곁칸의 담기·끌기·빼기가 모두 이 한 길 — 목록을 통째로 보낸다).
 *  태스크는 **이 세션의 프로젝트** 안의 것만 받는다(다른 것이 섞이면 아무것도 안 쓰고 null). 빈 목록 = 이 세션에서 다 뺀다.
 *  쓰고 나서 «지금 하는 것»을 규칙대로 다시 세운다 — 바뀌었으면 새로 맡은 태스크는 bindSessionTask 와 같이 «진행 중»이 된다.
 */
export async function setSessionTaskOrder(args: {
  sessionId: string; owner: string; taskIds: number[];
}): Promise<Array<{ id: number; name: string; status: string; current: boolean }> | null> {
  if (onNode() || !args.sessionId || !args.owner) return null;
  const ids = mergeTaskOrder(null, (args.taskIds || []).map(Number).filter((n) => Number.isInteger(n))).slice(0, ORDER_MAX);
  const cur = await executionSessionProject(args.sessionId, args.owner);
  const pid = Number(cur?.project_id ?? 0);
  if (!(pid > 0)) return null;
  const rows = ids.length ? await q(itemsPool,
    `SELECT id, name, status, level, parent_id FROM project WHERE id = ANY($1::int[]) AND level IN ('task','subtask') AND trashed_at IS NULL`, [ids]) : [];
  if (rows.length !== ids.length) return null;
  for (const r of rows) if ((await rootProjectIdOfTaskNode(r)) !== pid) return null;
  const doneOf = new Map(rows.map((r: any) => [Number(r.id), String(r.status) === "done"]));
  const prev = await one(itemsPool, `SELECT task_id FROM execution_session WHERE id=$1 AND owner=$2`, [args.sessionId, args.owner]);
  const prevId = Number(prev?.task_id ?? 0);
  // 지금 하는 것 — 맨 앞의 안 끝난 것. 다 끝났으면 하던 것을 그대로(목록에 있으면), 아니면 맨 앞.
  const want = nextTaskInOrder(ids.map((id) => ({ id, done: !!doneOf.get(id) })))
    ?? (ids.includes(prevId) ? prevId : (ids[0] ?? null));
  await withTx(async (db) => {
    await db.query(`DELETE FROM execution_session_task WHERE session_id=$1`, [args.sessionId]);
    for (let i = 0; i < ids.length; i++) {
      await db.query(`INSERT INTO execution_session_task(session_id, task_id, pos) VALUES($1,$2,$3)`, [args.sessionId, ids[i], i + 1]);
    }
    if (want !== prevId) {
      await db.query(`UPDATE execution_session SET task_id=$3, updated_at=now() WHERE id=$1 AND owner=$2`, [args.sessionId, args.owner, want]);
    }
  });
  if (want && want !== prevId) await bindSessionTask({ sessionId: args.sessionId, owner: args.owner, taskId: want, keepOrder: true });
  return sessionTaskList(args.sessionId, args.owner);
}

/** 태스크 줄의 세션 한 장 — 그 세션의 목록에서 몇 번째인가(order/count)와 지금 하는 것인가(current)까지. */
export interface TaskSessionRef { id: string; label: string | null; owner: string; order: number; count: number; current: boolean }

/** 태스크들에 붙은 세션(화면의 태스크 줄 → 세션 칩). 세션 이름은 세션 미러(org_session_state)에서.
 *  #4135 — 지금 하는 것(task_id)만이 아니라 **순서 목록에 올라 있는 것**도 그 세션의 태스크다(곁칸의 «세션 2 · 2번째»). */
export async function sessionsOfTasks(taskIds: number[]): Promise<Map<number, TaskSessionRef[]>> {
  const out = new Map<number, TaskSessionRef[]>();
  const ids = [...new Set((taskIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (onNode() || !ids.length) return out;
  const rows = await q(itemsPool,
    `WITH hit AS (
       SELECT id AS sid FROM execution_session WHERE task_id = ANY($1::int[])
       UNION SELECT session_id FROM execution_session_task WHERE task_id = ANY($1::int[]))
     SELECT es.task_id, es.id, es.owner, s.label,
            COALESCE((SELECT array_agg(x.task_id ORDER BY x.pos) FROM execution_session_task x
                        JOIN project t ON t.id = x.task_id AND t.trashed_at IS NULL
                       WHERE x.session_id = es.id), '{}') AS ids
       FROM execution_session es JOIN hit ON hit.sid = es.id
       LEFT JOIN org_session_state s ON s.id = es.id
      WHERE NOT EXISTS (SELECT 1 FROM org_session_trash tr WHERE tr.session_id = es.id)
      ORDER BY es.created_at DESC`, [ids]);
  const want = new Set(ids);
  for (const r of rows as Array<{ task_id: number | null; id: string; owner: string; label: string | null; ids: number[] }>) {
    const order = mergeTaskOrder(r.task_id, r.ids || []);
    order.forEach((tid, i) => {
      if (!want.has(tid)) return;
      let a = out.get(tid);
      if (!a) { a = []; out.set(tid, a); }
      a.push({ id: String(r.id), label: r.label ?? null, owner: String(r.owner), order: i + 1, count: order.length, current: tid === Number(r.task_id) });
    });
  }
  return out;
}

/** 프로젝트 문맥(AGENTS.md 주입)에 덧붙이는 «이 세션의 태스크» 절. 태스크가 없으면 빈 문자열.
 *  순서 목록(#4135)이 둘 이상이면 차례를 적는다 — 하나를 끝내면 `session_task done` 이 다음 것으로 넘긴다. */
export function sessionTaskSection(task: SessionTask | null, list?: Array<{ id: number; name: string; status: string; current?: boolean }>): string {
  if (!task) return "";
  const many = Array.isArray(list) && list.length > 1;
  return [
    "## 이 세션의 태스크",
    ...(many
      ? list!.map((t, i) => `${i + 1}. [#${t.id}] ${t.name} (${t.status})${t.id === task.id ? " ← 지금 하는 것" : ""}`)
      : [`- [#${task.id}] ${task.name} (${task.status})`]),
    "- 요청받은 일을 끝내면(검증까지 마치고) `session_task {status:\"done\"}` 로 완료 처리하세요 — `reason` 에 무엇을 끝냈는지 한 줄 적으면 ClickUp 미러 태스크에 코멘트로 남습니다. " +
      "같은 세션에서 후속 작업을 시작하면 `session_task {status:\"in_progress\"}` 로 되돌립니다.",
    ...(many ? ["- 이 세션은 위 태스크들을 **순서대로** 맡습니다. 하나를 완료 처리하면 다음 태스크가 «지금 하는 것»이 됩니다 — 그 본문은 `task_detail_v6` 로 읽고 이어서 진행하세요."] : []),
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

/**
 * 순수 — 태스크 **여러 개**를 순서대로 맡겨 연 세션의 첫 지시(#4135 새 세션 자리의 [담기]). 한 개면 taskKickoffPrompt 와 같다.
 *  1번 본문만 싣는다 — 나머지는 차례가 오면 session_task done 이 넘겨 주고 세션이 task_detail_v6 로 읽는다(첫 지시가 태스크
 *  수만큼 길어지지 않게). 사람이 덧붙인 말(extra)은 맨 뒤에 그대로.
 */
export function tasksKickoffPrompt(tasks: Array<{ id: number; name: string; description?: string | null }>, extra?: string | null): string {
  const add = String(extra ?? "").trim();
  const list = (tasks || []).filter((t) => t && t.id > 0);
  if (!list.length) return add;
  const head = list.length === 1 ? taskKickoffPrompt(list[0]) : [
    `이 세션은 태스크 ${list.length}개를 **순서대로** 맡습니다.`,
    ...list.map((t, i) => `${i + 1}. #${t.id} «${t.name}»`),
    "",
    `1번(#${list[0].id})부터 진행하고, 끝내면(검증까지) \`session_task {status:"done"}\` 로 완료 처리하세요 — 다음 태스크가 이어집니다(본문은 task_detail_v6).`,
    ...(String(list[0].description ?? "").trim() ? ["", `## 1번 태스크 본문 (#${list[0].id})`, "",
      (() => { const b = String(list[0].description).trim(); return b.length > KICKOFF_BODY_MAX ? b.slice(0, KICKOFF_BODY_MAX) + "\n\n…(이하 생략 — task_detail_v6 로 전문 조회)" : b; })()] : []),
  ].join("\n");
  return add ? `${head}\n\n## 덧붙인 말\n\n${add}` : head;
}

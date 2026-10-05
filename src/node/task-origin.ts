// 위탁 태스크를 **누가 시켰나** — 세션 목록이 위탁 워커를 시킨 세션의 프로젝트 아래에 세우는 데 쓴다 (#4551, 원준 2026-10-05).
//
//  신고: 사이드바 「프로젝트 없음」 묶음이 무엇인지 모르겠다. 실측(원준 계정) — 그 묶음 76개 중 54개가 위탁 워커였다.
//   위탁 워커는 사람이 연 세션이 아니라서 일부러 프로젝트를 만들지 않는데(#1979 — 서버가 조립한 첫 지시로 쓰레기
//   프로젝트가 하루 100건씩 쌓였다), 그 결과 «내가 안 만든 세션이 프로젝트 없이» 섰다.
//  ⇒ 프로젝트를 만들지 않는다는 결정은 그대로 두고, **시킨 세션을 적어 둔다.** 목록은 그 세션의 프로젝트를 빌려 쓴다.
//
//  ★ 새 칸을 만들지 않는다 — `org_task.requester_session` 이 원래 그 뜻의 칸이다. 사람 위탁은 여태 null 을 적었고
//   크론만 `cron:<잡>[#<레인>]` 표식으로 썼다. 그 칸을 읽는 자리는 전부 `cron:` 접두만 본다(cronJobIdOf · 중첩 가드 ·
//   자동 실행 기록), 그래서 세션 id 가 들어가도 그쪽은 종전과 같다.
import { itemsPool } from "../db/client.js";
import { cronJobIdOf } from "../scheduler/cron-task-feedback.js";
import { EXECUTION_SESSION_ID_RE } from "../org/auth/agent-identity.js";

/** 위탁 한 건의 출처. */
export interface TaskOrigin {
  taskId: number;
  /** 시킨 세션 id — 크론이 띄웠거나, 기록이 없던 때의 위탁이면 null. */
  originSession: string | null;
  /** 크론이 띄운 위탁이면 그 잡 id. */
  cronJobId: string | null;
}

/** 순수 — `requester_session` 값이 «시킨 세션 id» 인가. 크론 표식 · 빈 값 · 세션 id 꼴이 아닌 것은 null. */
export function originSessionOf(requesterSession: string | null | undefined): string | null {
  if (typeof requesterSession !== "string") return null;
  const v = requesterSession.trim();
  //  크론 표식(`cron:…`)은 세션 id 꼴이 아니라 여기서 함께 걸러진다 — 꼴 검사 하나가 두 일을 한다.
  return EXECUTION_SESSION_ID_RE.test(v) ? v : null;
}

/** 순수 — 위탁 행 → 출처. */
export function taskOriginOf(row: { id: number | string; requester_session?: string | null }): TaskOrigin {
  return { taskId: Number(row.id), originSession: originSessionOf(row.requester_session), cronJobId: cronJobIdOf(row.requester_session) };
}

/**
 * 순수 — 위탁을 만들 때 `requester_session` 에 적을 값. 요청이 실어 온 세션 id(x-lively-session)를 그대로 쓴다.
 *  ⚠ `cron:` 으로 시작하는 값은 적지 않는다 — 그 접두는 크론 표식의 것이라, 밖에서 온 값이 그 자리를 흉내 내면
 *   크론 중첩 가드(같은 표식의 대기 · 실행 중 위탁이 있으면 건너뜀)를 건드린다.
 */
export function requesterSessionFrom(ctxSession: string | null | undefined): string | null {
  return originSessionOf(ctxSession);
}

/** 이 세션들이 위탁 워커이면 그 출처 — 워커 세션 id → 출처. 같은 세션에 위탁이 여럿이면 가장 나중 것. */
export async function taskOriginsBySession(sessionIds: readonly string[]): Promise<Map<string, TaskOrigin>> {
  const out = new Map<string, TaskOrigin>();
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return out;
  const r = await itemsPool.query(
    `SELECT id, session_id, requester_session FROM org_task WHERE session_id = ANY($1::text[]) ORDER BY id`, [ids]);
  for (const row of r.rows as Array<{ id: number; session_id: string; requester_session: string | null }>) out.set(String(row.session_id), taskOriginOf(row));
  return out;
}

/** 목록의 한 행이 이 붙이기에 내놓는 것. */
export interface OriginRowLike { id: string; projectId?: number | null; label?: string | null; kind?: string; task?: TaskMark }

/** 목록 행에 얹는 위탁 표식 — 화면이 이것으로 워커를 시킨 프로젝트 아래에 세우고 리브가 한 일로 그린다. */
export interface TaskMark {
  id: number;
  /** 시킨 세션 id · 그 세션의 이름 · 그 세션의 프로젝트(없으면 null). */
  originSession: string | null;
  originLabel: string | null;
  originProject: number | null;
  /** 크론이 띄웠으면 그 잡 id. */
  cron: string | null;
}

/**
 * 순수 — 목록 행에 위탁 표식을 얹는다(그 자리에서 고친다). 워커가 아닌 행은 안 건드린다.
 *  · 시킨 세션의 프로젝트 · 이름은 **같은 목록의 그 행**에서 먼저 찾고, 목록에 없으면(끝나서 빠졌거나 남의 것) `fallback` 에서 찾는다.
 *  ⚠ 워커 자신의 `projectId` 는 안 고친다 — 소속을 지어내지 않는다. 화면이 표식(originProject)을 보고 자리를 정한다.
 */
export function applyTaskMarks<T extends OriginRowLike>(
  rows: T[], origins: ReadonlyMap<string, TaskOrigin>,
  fallback: ReadonlyMap<string, { projectId?: number | null; label?: string | null }> = new Map(),
): T[] {
  if (!origins.size) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    const o = origins.get(r.id);
    if (!o) continue;
    const src = o.originSession ? (byId.get(o.originSession) ?? fallback.get(o.originSession)) : undefined;
    r.kind = "task";
    r.task = {
      id: o.taskId, originSession: o.originSession, cron: o.cronJobId,
      originLabel: src && src.label ? String(src.label) : null,
      originProject: src && Number(src.projectId) > 0 ? Number(src.projectId) : null,
    };
  }
  return rows;
}

/** 시킨 세션 중 목록에 없는 것의 id — 호출자가 이것만 따로 조회해 `fallback` 으로 넘긴다. */
export function missingOrigins(rows: readonly OriginRowLike[], origins: ReadonlyMap<string, TaskOrigin>): string[] {
  const have = new Set(rows.map((r) => r.id));
  const out = new Set<string>();
  for (const r of rows) { const o = origins.get(r.id); if (o && o.originSession && !have.has(o.originSession)) out.add(o.originSession); }
  return [...out];
}

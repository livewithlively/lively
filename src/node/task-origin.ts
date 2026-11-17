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
  /** #5579 — 무엇을 맡겼나(지시의 첫 줄 · 짧게). 지시를 못 읽었으면 없다. ⚠ 목록에 실을 땐 세션 주인에게만(applyTaskMarks). */
  ask?: string | null;
  /** #5579 — 크론이 띄웠으면 그 잡의 이름(org_cron.label). */
  cronLabel?: string | null;
}

/** #5579 — 이 길이를 넘는 지시 첫 줄은 «…» 로 자른다. 목록 한 줄 · 설정 창 한 줄에 들어가는 길이다. */
export const ASK_HEAD_MAX = 80;

/**
 * 순수 — 지시 원문 → «무엇을 맡겼나» 한 줄(#5579). 첫 번째 빈 줄 아닌 줄을 쓰고, 마크다운 머리 기호(# > - * 숫자.)를 떼고,
 *  공백을 하나로 접고, ASK_HEAD_MAX 를 넘으면 자른다. 쓸 글이 없으면 null.
 *  ⚠ 요약하지 않는다(모델 호출 없음) — 목록을 그릴 때마다 도는 자리다. 위탁 지시는 AI 가 쓴 문장이라 첫 줄이 곧 할 일이다.
 */
export function askHeadOf(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*•]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    return line.length > ASK_HEAD_MAX ? line.slice(0, ASK_HEAD_MAX - 1).trimEnd() + "…" : line;
  }
  return null;
}

/** 순수 — `requester_session` 값이 «시킨 세션 id» 인가. 크론 표식 · 빈 값 · 세션 id 꼴이 아닌 것은 null. */
export function originSessionOf(requesterSession: string | null | undefined): string | null {
  if (typeof requesterSession !== "string") return null;
  const v = requesterSession.trim();
  //  크론 표식(`cron:…`)은 세션 id 꼴이 아니라 여기서 함께 걸러진다 — 꼴 검사 하나가 두 일을 한다.
  return EXECUTION_SESSION_ID_RE.test(v) ? v : null;
}

/** 순수 — 위탁 행 → 출처. 지시 머리(`prompt_head`)가 실려 오면 «무엇을 맡겼나» 도 함께 든다(#5579). */
export function taskOriginOf(row: { id: number | string; requester_session?: string | null; prompt_head?: string | null }): TaskOrigin {
  const o: TaskOrigin = { taskId: Number(row.id), originSession: originSessionOf(row.requester_session), cronJobId: cronJobIdOf(row.requester_session) };
  const ask = askHeadOf(row.prompt_head);
  if (ask) o.ask = ask;
  return o;
}

//  위탁 워커의 작업 폴더 — 스케줄러가 `…/delegated/task-<번호>[/<레포>]` 로 잡는다(src/node/tasks.ts). 사람이 고를 수 없는 자리다.
const TASK_DIR_RE = /(?:^|[\\/])delegated[\\/]task-(\d+)(?:[\\/]|$)/;

/** 순수 — 작업 폴더가 위탁 워커의 것이면 그 위탁 번호. 아니면 null. */
export function taskIdFromDir(dir: string | null | undefined): number | null {
  const m = TASK_DIR_RE.exec(String(dir || ""));
  const n = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 이 조회가 목록 행에게 묻는 것. */
export interface WorkerRowLike { id: string; dir?: string | null; owner?: string | null }

/**
 * 순수 — 위탁 행들에서 «워커 세션 id → 출처» 를 짠다.
 *  ① `session_id` 가 그 행이면 그 위탁이다(가장 나중 것).
 *  ② 못 찾은 행은 **작업 폴더의 위탁 번호**로 찾는다 — 단 그 위탁을 낸 사람이 그 세션의 주인일 때만.
 *  ★ ②가 왜 필요한가(매니지드 실측 2026-10-05, 원준 계정): 워커 53개 중 32개가 ①로 안 잡혔다.
 *   실패 · 노드 유실로 되돌린 위탁은 `session_id` 가 비고(#4868 · #4767), 재시도한 위탁은 마지막 시도의 세션만 남는다
 *   (#4411 은 세션이 넷). 그 워커들은 표식 없이 「기타 (미분류)」에 그대로 섰다.
 *  ⚠ 주인을 맞춰 보는 이유 — 폴더 이름은 번호뿐이라, 다른 사람의 위탁 번호와 같은 폴더가 있어도 그 출처를 빌려 쓰지 않는다.
 */
export function originsForRows(
  rows: readonly WorkerRowLike[],
  tasks: ReadonlyArray<{ id: number | string; session_id?: string | null; requester?: string | null; requester_session?: string | null; prompt_head?: string | null }>,
): Map<string, TaskOrigin> {
  const out = new Map<string, TaskOrigin>();
  const bySession = new Map<string, (typeof tasks)[number]>();
  const byId = new Map<number, (typeof tasks)[number]>();
  for (const t of [...tasks].sort((a, b) => Number(a.id) - Number(b.id))) {
    byId.set(Number(t.id), t);
    if (t.session_id) bySession.set(String(t.session_id), t);
  }
  for (const r of rows) {
    const direct = bySession.get(r.id);
    if (direct) { out.set(r.id, taskOriginOf(direct)); continue; }
    const tid = taskIdFromDir(r.dir);
    const t = tid ? byId.get(tid) : undefined;
    const owner = String(r.owner || "");
    if (t && owner && String(t.requester || "") === owner) out.set(r.id, taskOriginOf(t));
  }
  return out;
}

/** 이 목록 행들 중 위탁 워커의 출처 — 워커 세션 id → 출처. 조회는 한 번이다(session_id 또는 폴더의 위탁 번호). */
export async function taskOriginsForRows(rows: readonly WorkerRowLike[]): Promise<Map<string, TaskOrigin>> {
  const ids = [...new Set(rows.map((r) => r.id).filter(Boolean))];
  if (!ids.length) return new Map();
  const taskIds = [...new Set(rows.map((r) => taskIdFromDir(r.dir)).filter((n): n is number => n != null))];
  //  #5579 — 지시는 첫 몇백 자만 읽는다(위탁 지시는 2만 자까지 간다 — 목록마다 통째로 끌어오지 않는다).
  const r = await itemsPool.query(
    `SELECT id, session_id, requester, requester_session, left(prompt, 400) AS prompt_head FROM org_task WHERE session_id = ANY($1::text[]) OR id = ANY($2::bigint[])`, [ids, taskIds]);
  const out = originsForRows(rows, r.rows as Array<{ id: number; session_id: string | null; requester: string | null; requester_session: string | null; prompt_head: string | null }>);
  //  #5579 — 크론이 띄운 워커는 «왜 열렸나» 를 잡 이름으로 말한다(잡 id 는 사람이 읽는 이름이 아니다). 조회 실패는 이름 없이 간다.
  const jobs = [...new Set([...out.values()].map((o) => o.cronJobId).filter((x): x is string => !!x))];
  if (jobs.length) {
    try {
      const c = await itemsPool.query(`SELECT id, label FROM org_cron WHERE id = ANY($1::text[])`, [jobs]);
      const label = new Map((c.rows as Array<{ id: string; label: string | null }>).map((x) => [x.id, String(x.label || "").trim()]));
      for (const o of out.values()) { const l = o.cronJobId ? label.get(o.cronJobId) : ""; if (l) o.cronLabel = l; }
    } catch { /* 이름 없이 — 잡 id 로 말한다 */ }
  }
  return out;
}

/** 목록의 한 행이 이 붙이기에 내놓는 것. */
export interface OriginRowLike { id: string; projectId?: number | null; label?: string | null; owner?: string | null; kind?: string; task?: TaskMark }

/** 목록 행에 얹는 위탁 표식 — 화면이 이것으로 워커를 시킨 프로젝트 아래에 세우고 리브가 한 일로 그린다. */
export interface TaskMark {
  id: number;
  /** 시킨 세션 id · 그 세션의 이름 · 그 세션의 프로젝트(없으면 null). */
  originSession: string | null;
  originLabel: string | null;
  originProject: number | null;
  /** 크론이 띄웠으면 그 잡 id. */
  cron: string | null;
  /** #5579 — 무엇을 맡겼나(지시 첫 줄). **그 워커 세션의 주인이 볼 때만** 싣는다 — 위탁이 프로젝트 폴더에서 돌면 그 프로젝트 사람들도
   *  워커 줄을 보는데, 지시 글은 시킨 사람의 것이다. 없으면 칸이 없다(옛 화면 · 남의 워커). */
  ask?: string;
  /** #5579 — 크론이 띄웠으면 그 잡의 이름(org_cron.label). 없으면 칸이 없다. */
  cronLabel?: string;
}

/**
 * 순수 — 목록 행에 위탁 표식을 얹는다(그 자리에서 고친다). 워커가 아닌 행은 안 건드린다.
 *  · 시킨 세션의 프로젝트 · 이름은 **같은 목록의 그 행**에서 먼저 찾고, 목록에 없으면(끝나서 빠진 것) `fallback` 에서 찾는다.
 *  ⚠ `fallback` 은 **보는 사람의 세션만** 담아야 한다(아래 visibleOriginStates) — 헤더(x-lively-session)는 꼴만 검사된 값이라
 *   남의 세션 id 를 실어 보낼 수 있고, 그대로 풀면 그 세션의 이름 · 프로젝트가 내 목록으로 샌다.
 *  ⚠ 워커 자신의 `projectId` 는 안 고친다 — 소속을 지어내지 않는다. 화면이 표식(originProject)을 보고 자리를 정한다.
 */
export function applyTaskMarks<T extends OriginRowLike>(
  rows: T[], origins: ReadonlyMap<string, TaskOrigin>,
  fallback: ReadonlyMap<string, { projectId?: number | null; label?: string | null }> = new Map(),
  /** #5579 — 보는 사람. 워커 주인과 같을 때만 지시 첫 줄(ask)을 싣는다. 모르면 싣지 않는다. */
  viewer = "",
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
    const me = String(viewer || "").trim();
    if (o.ask && me && String(r.owner || "") === me) r.task.ask = o.ask;
    if (o.cronLabel) r.task.cronLabel = o.cronLabel;
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

/** 시킨 세션의 기억(org_session_state)이 이 판정에 내놓는 것. */
export interface OriginStateLike { owner?: string | null; invites?: readonly string[] | null; project_id?: number | null; label?: string | null }

/**
 * 순수 — 목록에 없는 시킨 세션 중 **보는 사람이 볼 수 있는 것만** fallback 으로 추린다(주인이거나 초대받았다).
 *  ⚠ 왜 여기서 거르나: 위탁을 만들 때 실어 오는 세션 id 는 꼴만 검사된다(delegate 는 세션 주인 검사를 안 지난다).
 *   남의 세션 id 를 적어 둔 위탁이 있어도, 그 세션의 이름과 프로젝트 번호는 그 세션을 볼 수 있는 사람에게만 풀린다.
 *   못 푼 워커는 「리브가 한 일」 묶음에 선다 — 사실(누가 시켰는지 모른다)과 같다.
 */
export function visibleOriginStates(
  states: ReadonlyMap<string, OriginStateLike>, viewer: string,
): Map<string, { projectId: number | null; label: string | null }> {
  const out = new Map<string, { projectId: number | null; label: string | null }>();
  const me = String(viewer || "").trim();
  if (!me) return out;
  for (const [id, st] of states) {
    const mine = String(st.owner || "") === me || (Array.isArray(st.invites) && st.invites.includes(me));
    if (mine) out.set(id, { projectId: st.project_id ?? null, label: st.label ?? null });
  }
  return out;
}

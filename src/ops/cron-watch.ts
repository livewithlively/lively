// 크론 잡 감시 + 경보 — 잡이 **실패로 넘어갈 때**와 **다시 정상이 될 때만** 사람에게 알린다.
//
// 왜 이게 필요한가: 크론이 죽어도 아무도 모른다. 창구는 관리탭 ▸ 스케줄(가서 봐야 보인다)과 로그(아무도
//  안 본다)뿐이고, 자동 정지(scheduler/cron-breaker.ts)는 **연속 실패 상한에 닿아야** 비로소 말한다 —
//  그 전까지의 실패는 침묵이고, 상한이 0(끔)이면 영원히 침묵이다. 게다가 그 카운터는 «접수 결과»만 세므로
//  헤드리스 잡은 아예 상한에 닿지 않는다(scheduler/cron-task-feedback.ts 머리말) — 그 잡들에는 이 알림이
//  유일한 창구다. 박스 감시(ops/box-watch.ts)가 디스크·DB에 해 준 일을 크론 축에 그대로 하는 모듈이다.
//
// 이 감시가 성립하는 전제: `org_cron.last_status` 가 **실제 결과**여야 한다. 헤드리스 잡은 접수 시점에
//  ok 를 반환하므로 그 되먹임이 없으면 여기서 아무리 봐도 전부 정상으로 보인다 —
//  그 구멍은 scheduler/cron-task-feedback.ts 가 막는다(이 모듈의 짝).
//
// 규약은 box-watch 를 그대로 따른다(새 규약을 만들지 않는다):
//  · 판정은 순수 함수 — 전이 규칙을 테스트가 직접 못 박는다.
//  · `prev===cur` 침묵(늑대소년 방지) · 첫 관측이 정상이면 침묵(기동할 때마다 알림이 오면 안 된다).
//  · 복구는 **알린 적 있는 문제**에만 — 규칙 본체는 box-watch.emitAlert 한 자리에 있다.
//
// ⚠ 감시가 게이트웨이를 죽이면 안 된다 — 전부 best-effort(throw 금지, 로그만).
import { itemsPool, q } from "../db/client.js";
import { emitAlert, type AlertSender, type BoxAlert } from "./box-watch.js";
import { forEachTenant } from "../scheduler/tenant-fanout.js";
import { currentTenant } from "../org/tenant-context.js";
import { logger } from "../log.js";

/** 감시에 필요한 만큼의 org_cron 한 행. */
export interface CronJobHealth {
  id: string;
  label?: string | null;
  action: string;
  last_status: string | null;
  last_summary?: unknown;
}

/** 잡의 건강 상태. `null` = **관측 없음**(판정 근거가 없는 회차 — 무엇이 그런지는 cronPhaseOf) — 전이를 만들지 않는다. */
export type CronPhase = "ok" | "failing";

/** 배치형 잡이 한 회차에 낸 위탁 하나의 실제 상태(org_task). */
export interface BatchTaskState { status: string; error?: string | null }

export interface CronWatchDeps {
  /** 감시 대상 조회(주입 seam). 생략하면 그 워크스페이스의 **켜져 있는** 잡을 읽는다. */
  listJobs?: () => Promise<CronJobHealth[]>;
  /** 배치형 잡의 위탁 상태 조회(주입 seam). 생략하면 org_task 를 읽는다. 못 읽으면 null(= 관측 없음). */
  taskStates?: (ids: string[]) => Promise<ReadonlyMap<string, BatchTaskState> | null>;
  /** 알림 전송(채널 미설정이면 no-op). 실패해도 throw 하지 않아야 한다. */
  send: AlertSender;
}

//  하한 60초 — 빈 값(`CRON_WATCH_INTERVAL_MS=`)은 Number("")=0 이 되어 setInterval 이 1ms 로 돈다. 이 tick 은 워크스페이스마다
//   DB 를 읽으므로 그건 곧 DB 폭주다. 숫자가 아니면 기본값으로 간다.
const CHECK_MS = Math.max(60_000, Number(process.env.CRON_WATCH_INTERVAL_MS) || 5 * 60_000);

// 마지막으로 관측한 상태 + **실제로 보낸 문제 경보가 있었나**. 키는 워크스페이스 ⊕ 잡 id —
//  워크스페이스마다 같은 id 의 잡이 따로 산다(스케줄러가 순회하는 것과 같은 이유).
const seen = new Map<string, { phase: CronPhase; problemSent: boolean }>();
const KEY_SEP = "\u0000";
let timer: NodeJS.Timeout | null = null;
//  tick 중첩 방지 — 워크스페이스가 많고 웹훅이 느리면 한 tick 이 주기를 넘길 수 있다. 두 tick 이 같은 `seen` 을
//   동시에 읽고 쓰면 같은 전이를 두 번 알린다.
let ticking = false;

/**
 * `last_status`(+ `last_summary`) → 건강 상태(순수). `null` = 관측 없음.
 *
 * `ok` 만 정상이고 나머지 낱말은 전부 실패로 본다: 액션이 새 낱말을 반환하더라도 «정상이라고 말하지
 *  않은 것»을 정상으로 넘기면 감시가 무의미해진다. (자동 정지 판정과 방향이 반대인 것은 의도다 —
 *  저쪽은 잡을 끄므로 보수적이어야 하고, 이쪽은 알릴 뿐이다.)
 *
 * ⚠ **«접수됐지만 아직 안 끝난» ok 는 정상이 아니라 관측 없음이다.** 헤드리스 잡의 ok 는 태스크를 배치한
 *  시점에 찍히고, 실제 결과는 종결 시점에 scheduler/cron-task-feedback 이 덮어쓴다. 그 중간 창을 정상으로
 *  읽으면 **계속 실패하는 잡이 주기마다 ok→error 를 오가며 복구·실패 알림을 한 쌍씩 뿜는다**(늑대소년).
 *  요약이 그 창을 스스로 구분해 준다 — 접수 요약엔 `task_id` 만 있고, 되먹임이 `task_status`(done/failed)를
 *  덧댄다. 중첩 skip 요약은 `task_status` 가 queued/running 이라 같은 규칙으로 걸린다.
 *
 * ⚠ **배치형 잡(증류의 `batches` · 관리의 `managers`)은 `last_status` 로 판정하지 않는다** — `batchStates` 로 본다.
 *  되먹임은 배치가 하나 끝날 때마다 잡 상태를 그 배치의 결과로 덮는다. 그래서 레인 하나만 계속 실패하는 잡은
 *  한 회차 안에서 error↔ok 를 오가고, 그걸 그대로 읽으면 **회차마다 실패·복구 알림이 한 쌍씩** 나간다
 *  (배치 id 순서 가드가 있어도 회차 중간 관측은 흔들린다). 그래서 그 회차에 낸 위탁 **전부**의 실제 상태를
 *  읽어 판정한다(`batchPhaseOf`) — 다 끝나기 전엔 관측 없음, 하나라도 실패면 실패. 같은 레인이 계속 실패하면
 *  회차가 바뀌어도 실패로 머물러 알림은 한 번이다. `batchStates` 를 못 받았으면(조회 실패) 관측 없음이다.
 *
 * `warn` 은 정상으로 본다 — «잡은 돌았고 산출물(관측)에 경고가 있다» 는 뜻이다. 지금 이 낱말을 쓰는 잡은
 *  카나리(scheduler/actions/canary.ts)뿐이고, 그 경고는 카나리가 연속 실패 임계를 두고 **스스로** 알린다
 *  (org/canary/run.ts). 여기서 실패로 읽으면 그 임계를 건너뛰어, 상류가 한 번 흔들릴 때마다 실패·복구 알림이
 *  한 쌍씩 나가고 카나리 경보와도 겹친다.
 *
 * `skipped` 도 관측 없음이다(그 회차는 실행되지 않았다). 실제로 이 값이 저장되는 곳은
 *  scheduler/actions/canary.ts 의 '잡 생성자 없음' 분기뿐이다 — 엔진의 중첩 락 skip 은 기록 자체를 하지
 *  않는다(engine.executeAndRecord 가 UPDATE 전에 반환한다). 검증: `grep -rn '"skipped"' src/scheduler`.
 */
export function cronPhaseOf(
  lastStatus: string | null | undefined, summary?: unknown,
  batchStates?: ReadonlyMap<string, BatchTaskState> | null,
): CronPhase | null {
  if (!lastStatus || lastStatus === "skipped") return null;
  const ids = batchTaskIds(summary);
  if (ids) return batchStates ? batchPhaseOf(ids, batchStates) : null;
  if (taskPending(summary)) return null;
  return lastStatus === "ok" || lastStatus === "warn" ? "ok" : "failing";
}

/**
 * 배치형 요약이면 그 회차에 낸 위탁 id 들(순수) — 배치형이 아니거나 id 가 하나도 없으면 null.
 *  중첩 skip 으로 이전 회차의 위탁을 가리키는 배치도 그 id 가 실린다(그 위탁이 끝나야 이 회차도 끝난다).
 */
export function batchTaskIds(summary: unknown): string[] | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  const batches = [s.batches, s.managers].find(Array.isArray) as unknown[] | undefined;
  if (!batches) return null;
  const ids = batches
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>).task_id : null))
    .filter((v): v is number | string => (typeof v === "number" || typeof v === "string") && /^\d+$/.test(String(v)))
    .map(String);
  return ids.length ? [...new Set(ids)] : null;
}

/**
 * 배치형 잡 한 회차의 건강 상태(순수).
 *  · 하나라도 대기·실행 중이면 관측 없음 — 회차가 아직 안 끝났다.
 *  · 다 끝났고 하나라도 failed 면 실패. canceled 는 실패로 세지 않는다(사람의 취소이거나, 자격 실패 경로가
 *    크론을 이미 멈추고 따로 알렸다 — node/auth-failure-response.ts).
 *  · 조회에 없는 id 는 판정에서 뺀다. 다 빠지면 관측 없음.
 */
export function batchPhaseOf(ids: readonly string[], states: ReadonlyMap<string, BatchTaskState>): CronPhase | null {
  const known = ids.map((id) => states.get(id)?.status).filter((st): st is string => typeof st === "string");
  if (!known.length) return null;
  if (known.some((st) => st === "queued" || st === "running")) return null;
  return known.includes("failed") ? "failing" : "ok";
}

/** 위탁이 종결로 기록됐나(순수 보조). */
const terminal = (taskStatus: unknown): boolean => taskStatus === "done" || taskStatus === "failed";

/**
 * 이 잡이 **위탁을 내는** 잡인가(순수 보조) — 요약에 위탁 id 가 실려 있나로 본다.
 *
 *  배치형 요약(증류의 `batches` · 관리의 `managers`)은 id 가 배치 안에 있다. 이 잡들이 요동의 본선이라
 *  (주기는 짧고 한 배치의 LLM 실행은 길다) 형태를 못 알아보면 감시기가 매 주기 복구·실패 쌍을 낸다.
 */
function delegatesWork(summary: unknown): boolean {
  if (!summary || typeof summary !== "object") return false;
  const s = summary as Record<string, unknown>;
  if (s.task_id !== undefined && s.task_id !== null) return true;
  const batches = [s.batches, s.managers].find(Array.isArray) as unknown[] | undefined;
  return !!batches?.some((b) => b && typeof b === "object" && (b as Record<string, unknown>).task_id != null);
}

/** 요약이 «위탁을 냈고 아직 종결 안 됨» 을 말하나(순수 보조). */
function taskPending(summary: unknown): boolean {
  if (!summary || typeof summary !== "object") return false;
  if (terminal((summary as Record<string, unknown>).task_status)) return false;
  return delegatesWork(summary);
}

/** `last_summary` 에서 사람이 읽을 실패 사유 한 줄(순수). 못 찾으면 null. */
export function cronFailureReason(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  //  우선순위 = 구체적인 것부터. task_error 는 크론이 낸 위탁의 실패(cron-task-feedback 이 적는다),
  //  error/reason 은 액션 자체의 실패, assign_code 는 배치 실패의 기계 코드다.
  for (const k of ["task_error", "error", "reason", "assign_code"]) {
    const v = s[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}

/**
 * 크론 전이 → 알릴 내용(없으면 null). 순수 함수(box-watch 의 `diskAlertFor` 와 동형).
 *
 * severity 가 `warn` 인 이유: 잡 하나가 죽은 것은 **곧 문제가 되는 상태**이지 지금 전 기능이 멈춘 상태가
 *  아니다(그 등급 구분은 box-watch.BoxAlert 주석). 그래서 min_severity=critical 로 좁혀 둔 채널은
 *  크론 소음 없이 장애만 받는다.
 */
export function cronAlertFor(prev: CronPhase | null, cur: CronPhase, job: CronJobHealth): BoxAlert | null {
  if (prev === cur) return null;                    // 상태 그대로 → 침묵(스팸 금지)
  if (prev === null && cur === "ok") return null;   // 부팅 시 정상 → 침묵
  const name = job.label ? `${job.label}(${job.id})` : job.id;
  const reason = cronFailureReason(job.last_summary);
  const detail = { job: job.id, action: job.action, last_status: job.last_status, from: prev, to: cur, ...(reason ? { reason } : {}) };
  if (cur === "failing") {
    return {
      severity: "warn",
      title: `크론 실패 — ${name}`,
      text: `스케줄 잡 '${name}'(${job.action}) 의 마지막 실행이 실패했습니다.\n`
        + (reason ? `사유: ${reason}\n` : `사유가 기록되지 않았습니다.\n`)
        //  자동 정지가 닿는지가 잡 유형으로 갈린다 — 위탁형(헤드리스)은 카운터가 «접수 결과»만 세어
        //  상한에 도달하지 못한다(근거: scheduler/cron-task-feedback.ts 머리말). 아닌 잡에 같은 문장을
        //  쓰면 거짓이 되고, 거짓 안내는 알림 전체의 신뢰를 깎는다.
        + (delegatesWork(job.last_summary)
          ? `이 잡은 스스로 멈추지 않습니다 — 조치하지 않으면 같은 실패가 주기마다 반복됩니다.\n`
          : `연속 실패 상한에 닿으면 자동 정지됩니다(상한이 0 이면 계속 반복됩니다).\n`)
        + `→ 관리 ▸ 스케줄 에서 마지막 실행 요약(last_summary)으로 원인을 확인하세요.`,
      detail,
    };
  }
  return {
    severity: "ok",
    title: `크론 정상 복귀 — ${name}`,
    text: `스케줄 잡 '${name}'(${job.action}) 가 다시 정상 실행됐습니다.`,
    detail,
  };
}

/** 배치형 잡의 위탁 상태. 표 부재·DB 미연결은 null(관측 없음 — 못 재면 알리지 않는다). */
async function loadTaskStates(ids: string[]): Promise<ReadonlyMap<string, BatchTaskState> | null> {
  try {
    const rows = (await q(itemsPool, `SELECT id::text AS id, status, error FROM org_task WHERE id = ANY($1::bigint[])`, [ids])) as
      Array<{ id: string; status: string; error: string | null }>;
    return new Map(rows.map((r) => [r.id, { status: r.status, error: r.error }]));
  } catch { return null; }
}

/** 그 워크스페이스의 켜져 있는 잡. 표 부재·DB 미연결은 빈 목록(경보 대신 침묵 — 못 재면 알리지 않는다). */
async function loadJobs(): Promise<CronJobHealth[]> {
  try {
    return (await q(itemsPool, `SELECT id, label, action, last_status, last_summary FROM org_cron WHERE enabled=true`)) as CronJobHealth[];
  } catch { return []; }
}

// 한 워크스페이스 1회 스캔. 호출자가 테넌트 컨텍스트를 세워 준다(forEachTenant).
async function scanOne(deps: CronWatchDeps): Promise<void> {
  const jobs = await (deps.listJobs ?? loadJobs)();
  const scope = (currentTenant()?.id ?? "") + KEY_SEP;
  const alive = new Set<string>();
  for (const job of jobs) {
    const key = scope + job.id;
    alive.add(key);
    const ids = batchTaskIds(job.last_summary);
    const states = ids ? await (deps.taskStates ?? loadTaskStates)(ids) : null;
    const cur = cronPhaseOf(job.last_status, job.last_summary, states);
    if (cur === null) continue;   // 관측 없음 — 이전 상태를 그대로 둔다(중립)
    const prev = seen.get(key);
    const a = cronAlertFor(prev?.phase ?? null, cur, withBatchReason(job, ids, states));
    const next = { phase: cur, problemSent: prev?.problemSent ?? false };
    if (a) {
      const sent = await emitAlert(a, next.problemSent, deps.send);
      next.problemSent = a.severity === "ok" ? false : (sent || next.problemSent);
    }
    seen.set(key, next);
  }
  // 목록에서 사라진 잡(삭제·수동 비활성·자동 정지)의 상태는 버린다. 남겨 두면 몇 달 뒤 다시 켠 잡의
  //  첫 관측이 «옛 실패에서 복구» 로 읽혀 엉뚱한 복구 알림이 나간다 — 다시 켜진 잡은 새로 관측하는 게 맞다.
  //  (자동 정지로 빠진 잡이라면 그 정지 자체를 브레이커가 이미 알렸다 — scheduler/engine.tripBreaker.)
  for (const k of [...seen.keys()]) if (k.startsWith(scope) && !alive.has(k)) seen.delete(k);
}

/**
 * 배치형 잡의 실패 사유는 **실패한 배치**의 것으로 싣는다(순수). 최상위 `task_error` 는 마지막으로 되먹여진
 *  배치의 것이라 성공한 배치일 수 있다. org_task.error 는 저장 직전에 가려진 문장이다(task-store.markFinished, #4422).
 */
function withBatchReason(job: CronJobHealth, ids: string[] | null, states: ReadonlyMap<string, BatchTaskState> | null): CronJobHealth {
  if (!ids || !states) return job;
  const failed = ids.find((id) => states.get(id)?.status === "failed");
  if (!failed) return job;
  const base = job.last_summary && typeof job.last_summary === "object" ? job.last_summary as Record<string, unknown> : {};
  return { ...job, last_summary: { ...base, task_error: states.get(failed)?.error ?? null } };
}

async function tick(deps: CronWatchDeps): Promise<void> {
  if (ticking) return;
  ticking = true;
  // 워크스페이스 순회는 스케줄러와 **같은 판정**을 쓴다 — 크론이 도는 곳에서만 감시가 돈다.
  //  (순회를 직접 구현하면 스케줄러가 도는 범위와 어긋나, 감시가 안 도는 워크스페이스가 조용히 생긴다.)
  try {
    await forEachTenant("cron-watch", () => scanOne(deps))
      .catch((err) => logger.warn({ err }, "크론 감시 tick 실패(비치명 — 다음 tick 재시도)"));
  } finally { ticking = false; }
}

export function startCronWatch(deps: CronWatchDeps): void {
  if (timer) return;
  timer = setInterval(() => { void tick(deps); }, CHECK_MS);
  timer.unref?.();
  void tick(deps); // 부팅 직후 1회 — 이미 실패해 있는 잡을 다음 주기까지 방치하지 않는다
}

export function stopCronWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  seen.clear();
}

/** 테스트 전용 — 한 tick 을 즉시 돌린다(주기를 기다리지 않고 전이 규칙을 검증). */
export async function tickOnce(deps: CronWatchDeps): Promise<void> {
  await tick(deps);
}

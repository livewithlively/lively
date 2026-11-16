// 크론 잡 감시 + 경보 — 잡이 **실패로 넘어갈 때**와 **다시 정상이 될 때만** 사람에게 알린다.
//
// 왜 이게 필요한가: 크론이 죽어도 아무도 모른다. 창구는 관리탭 ▸ 스케줄(가서 봐야 보인다)과 로그(아무도
//  안 본다)뿐이고, 자동 정지(scheduler/cron-breaker.ts)는 **연속 실패 상한에 닿아야** 비로소 말한다 —
//  그 전까지의 실패는 침묵이고, 상한이 0(끔)이면 영원히 침묵이다. 게다가 그 카운터는 «접수 결과»만 세므로
//  헤드리스 잡은 아예 상한에 닿지 않는다(scheduler/cron-task-feedback.ts 머리말) — 그 잡들에는 이 알림이
//  유일한 창구다. 박스 감시(ops/box-watch.ts)가 디스크·DB에 해 준 일을 크론 축에 그대로 하는 모듈이다.
//
// 위탁을 내는 잡(헤드리스·증류·분류·관리)은 `org_cron.last_status` 를 믿지 않는다 — 접수 시점에 ok 가 찍히고,
//  되먹임(scheduler/cron-task-feedback.ts)은 레인마다 덮어쓰거나 엔진 기록에 덮여 사라질 수 있다. 그래서 요약에 실린
//  위탁 id 로 org_task 의 실제 상태를 읽어 회차 단위로 판정한다(cronPhaseOf 머리말). 되먹임은 화면(관리 ▸ 스케줄)용이다.
//
// 도는 곳: 부팅 하우스키핑(DB_BOOT_STEPS, scheduler 게이트)이라 **요청별 테넌시(매니지드 중앙 게이트웨이)에서는 뜨지 않는다**
//  (그 체인이 통째로 건너뛰어진다 — boot/housekeeping.ts requestScopedTenancy). 단일·고정·registry(셀프호스트 다중
//  워크스페이스)가 대상이다. 관측 상태(seen)는 메모리라 재시작하면 비워진다. 그래도 직전 프로세스가 이미 봤을 만큼 오래된
//  실패는 다시 알리지 않는다(inheritsAlertedFailure — 전제와 범위는 그 머리말) — 격주 잡의 실패 하나가 다음 회차까지
//  재시작마다 같은 경보로 되살아났다.
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
import { redactTaskText } from "../node/task-secrets.js";

/** 감시에 필요한 만큼의 org_cron 한 행. */
export interface CronJobHealth {
  id: string;
  label?: string | null;
  action: string;
  last_status: string | null;
  last_summary?: unknown;
  /** 행이 마지막으로 바뀐 때 — 실패를 적은 때와 같거나 늦다(failureRecordedAt). */
  updated_at?: string | Date | null;
}

/** 잡의 건강 상태. `null` = **관측 없음**(판정 근거가 없는 회차 — 무엇이 그런지는 cronPhaseOf) — 전이를 만들지 않는다. */
export type CronPhase = "ok" | "failing";

/** 크론이 낸 위탁 하나의 실제 상태(org_task). */
export interface BatchTaskState { status: string; error?: string | null; finished_at?: string | Date | null }

export interface CronWatchDeps {
  /** 감시 대상 조회(주입 seam). 생략하면 그 워크스페이스의 **켜져 있는** 잡을 읽는다. 못 읽으면 null(빈 목록과 다르다). */
  listJobs?: () => Promise<CronJobHealth[] | null>;
  /** 위탁 상태 조회(주입 seam). 생략하면 org_task 를 읽는다. 못 읽으면 null(= 관측 없음). */
  taskStates?: (ids: string[]) => Promise<ReadonlyMap<string, BatchTaskState> | null>;
  /** 알림 전송(채널 미설정이면 no-op). 실패해도 throw 하지 않아야 한다. */
  send: AlertSender;
  /** 이 프로세스가 뜬 시각(ms, 주입 seam). 생략하면 process.uptime 으로 잰다. */
  bootedAt?: number;
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
 * ★ **위탁을 내는 잡은 `last_status` 로 판정하지 않는다** — 그 회차에 낸 위탁의 실제 상태(org_task, 호출부가
 *  `taskStates` 로 넘긴다)로 본다(`delegatedPhaseOf`). last_status 로 보면 세 갈래로 틀린다:
 *   ① 헤드리스 액션은 **접수 시점에** ok 를 적는다. 계속 실패하는 잡도 회차마다 ok 창이 생겨, 그걸 읽으면
 *      실패·복구 알림이 회차마다 한 쌍씩 나간다(늑대소년). 관리 잡의 요약처럼 되먹임 표식이 없는 모양이면 더 그렇다.
 *   ② 되먹임(scheduler/cron-task-feedback)은 레인(배치)이 하나 끝날 때마다 잡 상태를 그 결과로 덮는다 —
 *      레인 하나만 계속 실패하는 잡은 한 회차 안에서 error↔ok 를 오간다.
 *   ③ 위탁이 엔진의 기록보다 **먼저** 끝나면(자격 없음 — task-scheduler 가 배정 중에 곧바로 markFinished 한다)
 *      되먹임이 엔진의 UPDATE 에 덮여 사라진다. 그 잡은 영영 «접수됨» 으로 보인다.
 *  위탁 상태는 이 셋에 흔들리지 않는다. 같은 레인이 계속 실패하면 회차가 바뀌어도 실패에 머물러 알림은 한 번이다.
 *  `taskStates` 를 못 받았으면(조회 실패) 관측 없음이다 — 단 접수 전에 실패한 레인은 요약만으로 실패다.
 *
 * 그 밖의 잡은 `ok` 만 정상이고 나머지 낱말은 전부 실패로 본다: 액션이 새 낱말을 반환하더라도 «정상이라고
 *  말하지 않은 것»을 정상으로 넘기면 감시가 무의미해진다. (자동 정지 판정과 방향이 반대인 것은 의도다 —
 *  저쪽은 잡을 끄므로 보수적이어야 하고, 이쪽은 알릴 뿐이다.)
 *
 * `warn` 은 정상으로 본다 — «잡은 돌았고 산출물(관측)에 경고가 있다» 는 뜻이다. 이 낱말을 쓰는 액션은
 *  `grep -rn '"warn"' src/scheduler/actions src/org/manage` 로 찾는다. 카나리의 경고는 카나리가 연속 실패 임계를 두고
 *  **스스로** 알리고(org/canary/run.ts), 관리기 일부 실패는 아래 delegatedWork 가 항목 error 로 따로 잡는다. 여기서 실패로 읽으면 그 임계를 건너뛰어, 상류가 한 번 흔들릴 때마다 실패·복구 알림이
 *  한 쌍씩 나가고 카나리 경보와도 겹친다.
 *
 * `skipped` 도 관측 없음이다(그 회차는 실행되지 않았다). 실제로 이 값이 저장되는 곳은
 *  scheduler/actions/canary.ts 의 '잡 생성자 없음' 분기뿐이다 — 엔진의 중첩 락 skip 은 기록 자체를 하지
 *  않는다(engine.executeAndRecord 가 UPDATE 전에 반환한다). 검증: `grep -rn '"skipped"' src/scheduler`.
 */
export function cronPhaseOf(
  lastStatus: string | null | undefined, summary?: unknown,
  taskStates?: ReadonlyMap<string, BatchTaskState> | null,
): CronPhase | null {
  if (!lastStatus || lastStatus === "skipped") return null;
  const d = delegatedWork(summary);
  if (d) return taskStates ? delegatedPhaseOf(d, taskStates) : (d.entryErrors.length ? "failing" : null);
  return lastStatus === "ok" || lastStatus === "warn" ? "ok" : "failing";
}

/**
 * 레인을 나눠 위탁하는 잡의 요약 목록 키 — 증류(scheduler/actions/distill.ts) · 분류(classify.ts) · 관리(manage.ts).
 *  ⚠ 액션이 요약 모양을 바꾸면 여기가 조용히 못 알아본다 — cron-watch.test 가 세 액션의 소스로 이 키를 못박는다.
 */
export const DELEGATION_LISTS = ["batches", "classifiers", "managers"] as const;

/** 한 회차에 낸 위탁(순수 판정 재료). */
export interface DelegatedWork {
  /** 그 회차의 위탁 id — 중첩 skip 으로 이전 회차의 위탁을 가리키는 레인도 그 id 가 실린다(그게 끝나야 회차가 끝난다). */
  ids: string[];
  /** 레인 항목에 실린 실패 사유 — 위탁을 만들기도 전에 실패했거나(실행 멤버 없음·하네스 해소 실패·태스크 생성 실패 등)
   *   일부만 접수했다(레포별 위탁 중 일부 실패). */
  entryErrors: string[];
}

const isTaskId = (v: unknown): v is number | string =>
  (typeof v === "number" || typeof v === "string") && /^[1-9]\d*$/.test(String(v));

/**
 * 요약에서 이 회차의 위탁을 뽑는다(순수). 위탁을 내지 않는 잡이면 null.
 *  · 레인 목록(`DELEGATION_LISTS`)의 각 항목 — `task_id`, 여러 레포로 갈라 낸 관리기는 `task_ids`.
 *  · 목록에서 id 를 못 찾으면 최상위 `task_id`(단일 위탁 잡의 접수·skip 요약, 또는 되먹임이 덧댄 것).
 *  · 확정된 실패로 따로 세는 것: id 없이 `error` 만 있는 항목(접수 전 실패), 그리고 `partial_error`
 *    (코드 비교 관리기의 레포 몇 개가 태스크조차 못 만들었다 — 남은 위탁이 done 이어도 그 레포는 빠졌다. org/manage/run-manager.ts repoEnqueueFailure).
 *    id 와 `error` 가 같이 있는 항목은 접수 후 배정 오류(scheduler/actions/_headless.ts 의 배치 오류)라 태스크가 큐에
 *    남아 나중에 돌 수 있다 — 실패로 확정하지 않고 그 id 의 결과로 판정한다.
 */
export function delegatedWork(summary: unknown): DelegatedWork | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  const list = DELEGATION_LISTS.map((k) => s[k]).find(Array.isArray) as unknown[] | undefined;
  const ids: string[] = [];
  const entryErrors: string[] = [];
  for (const e of list ?? []) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const own = [o.task_id, ...(Array.isArray(o.task_ids) ? o.task_ids : [])].filter(isTaskId).map(String);
    ids.push(...own);
    if (!own.length && typeof o.error === "string" && o.error.trim()) entryErrors.push(o.error);
    if (typeof o.partial_error === "string" && o.partial_error.trim()) entryErrors.push(o.partial_error);
  }
  if (!ids.length && isTaskId(s.task_id)) ids.push(String(s.task_id));
  if (!ids.length && !entryErrors.length) return null;
  return { ids: [...new Set(ids)], entryErrors };
}

/**
 * 위탁을 내는 잡 한 회차의 건강 상태(순수).
 *  · 접수 전에 실패한 레인이 있으면 실패 — 확정된 실패라 나머지 레인을 기다리지 않는다.
 *  · 하나라도 대기·실행 중이면 관측 없음 — 회차가 아직 안 끝났다.
 *  · 하나라도 failed 면 실패(끝난 순서와 무관), done 이 있으면 정상.
 *  · canceled·조회에 없는 id 는 세지 않는다 — 그것만 남으면 관측 없음. 사람이 취소한 회차를 «복구» 로 읽지 않고,
 *    자격 실패 취소는 그 경로가 크론을 이미 멈추고 따로 알렸다(node/auth-failure-response.ts).
 */
export function delegatedPhaseOf(d: DelegatedWork, states: ReadonlyMap<string, BatchTaskState>): CronPhase | null {
  if (d.entryErrors.length) return "failing";
  const known = d.ids.map((id) => states.get(id)?.status).filter((st): st is string => typeof st === "string");
  if (known.some((st) => st === "queued" || st === "running")) return null;
  if (known.includes("failed")) return "failing";
  return known.includes("done") ? "ok" : null;
}

/** `last_summary` 에서 사람이 읽을 실패 사유 한 줄(순수). 못 찾으면 null. */
export function cronFailureReason(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  //  우선순위 = 구체적인 것부터. task_error 는 크론이 낸 위탁의 실패(cron-task-feedback 이 적는다),
  //  error/reason 은 액션 자체의 실패, assign_code 는 배치 실패의 기계 코드다.
  //  ⚠ 이 문장은 조직 밖 웹훅으로 나간다 — 출구에서 한 번 더 가린다(#4422 규칙 한 곳). 되먹임이 넘기는 위탁 실패는 저장 때
  //   이미 가려졌지만, 일반 액션의 error(자식 프로세스 오류 원문 등)와 가림 도입 전에 쌓인 옛 org_task.error 는 아니다.
  for (const k of ["task_error", "error", "reason", "assign_code"]) {
    const v = s[k];
    if (typeof v === "string" && v.trim()) return redactTaskText(v.trim().replace(/\s+/g, " ")).slice(0, 300);
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
        + (delegatedWork(job.last_summary)
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

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v == null) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

//  모듈 로드 때 한 번 고정한다 — process.uptime 은 단조 시계라 호스트가 잠들었다 깨면 매번 다시 잰 기동 시각이 늦어진다.
const BOOTED_AT = Date.now() - process.uptime() * 1000;

/**
 * 지금 보이는 실패를 감시가 처음 «실패» 로 판정할 수 있게 된 시각(ms, 순수). 모르면 null — 모르면 이어받지 않고 알린다.
 *  · 잡 행의 updated_at 은 실패를 적은 때와 같거나 늦다. 사람의 편집·재활성화는 이 값을 늦추기만 하므로
 *    이어받기가 덜 걸리는 쪽(= 한 번 더 알리는 쪽)으로만 틀린다.
 *  · 위탁형은 회차의 위탁이 **전부** 끝나야 판정된다(delegatedPhaseOf — 하나라도 도는 중이면 관측 없음). 그래서 실패한
 *    위탁이 아니라 끝난 위탁 전부의 finished_at 중 가장 늦은 것을 본다. 레인 하나가 일찍 실패해도 다른 레인이 재시작 뒤에
 *    끝났다면 직전 프로세스는 그 실패를 본 적이 없다. 되먹임이 덮이거나(cronPhaseOf ③) 취소·id 가드로 행이 안 바뀌어도
 *    이 시각은 정확하다. 끝난 위탁 하나라도 finished_at 을 모르면 null 이다.
 */
export function failureRecordedAt(
  job: CronJobHealth, work: DelegatedWork | null, states: ReadonlyMap<string, BatchTaskState> | null,
): number | null {
  const row = toMs(job.updated_at);
  if (row === null) return null;
  let at = row;
  for (const id of work?.ids ?? []) {
    const t = states?.get(id);
    if (!t || t.status === "queued" || t.status === "running") continue;   // 조회에 없는 id 는 판정에도 안 쓰인다
    const fin = toMs(t.finished_at);
    if (fin === null) return null;
    at = Math.max(at, fin);
  }
  return at;
}

/**
 * 재시작 뒤 처음 본 실패를 직전 프로세스가 이미 알렸다고 볼 수 있나(순수).
 *  직전 프로세스는 CHECK_MS 마다 돌았으므로 실패가 판정 가능해지고 한 주기 안에 그것을 봤다. tick 이 주기를 넘길 수 있어
 *  한 주기를 더 둔다. 그보다 최근의 실패와 시각을 모르는 실패는 알린다.
 *  이 추론은 직전 프로세스가 그 두 주기 동안 살아서 감시를 돌렸고 전송에 성공했다는 전제를 깐다. 실패 직후 게이트웨이가
 *  내려가 두 주기 넘게 비었거나, 직전 프로세스의 전송이 실패·미설정이었으면 그 경보는 잃는다(이어받은 상태에서 나으면
 *  알린 적 없는 문제의 복구가 나간다). 재시작마다 같은 경보가 되살아나는 쪽보다 작은 손실로 본다 — 없애려면 «알렸음» 을
 *  DB 에 남겨야 한다.
 *  행이 주기마다 다시 쓰이는 잡(엔진이 회차마다 updated_at 을 올린다 — 주기가 두 감시 주기 이하인 비위탁 잡)은 이 판정에
 *  안 걸려 재시작마다 종전처럼 다시 알린다. 알리는 쪽 오차다.
 */
export function inheritsAlertedFailure(recordedAt: number | null, bootedAt: number, checkMs: number = CHECK_MS): boolean {
  return recordedAt !== null && recordedAt < bootedAt - 2 * checkMs;
}

/** 위탁 상태. 표 부재·DB 미연결은 null(관측 없음 — 못 재면 알리지 않는다). */
async function loadTaskStates(ids: string[]): Promise<ReadonlyMap<string, BatchTaskState> | null> {
  try {
    const rows = (await q(itemsPool, `SELECT id::text AS id, status, error, finished_at FROM org_task WHERE id = ANY($1::bigint[])`, [ids])) as
      Array<{ id: string; status: string; error: string | null; finished_at: string | Date | null }>;
    return new Map(rows.map((r) => [r.id, { status: r.status, error: r.error, finished_at: r.finished_at }]));
  } catch { return null; }
}

/**
 * 그 워크스페이스의 켜져 있는 잡. 표 부재·DB 미연결은 **null** — 빈 목록(`[]`)과 구분한다.
 *  빈 목록은 «잡이 다 사라졌다» 로 읽혀 관측 상태가 통째로 폐기된다. DB 가 잠깐 끊긴 뒤 돌아오면 아직 실패 중인 잡은
 *  같은 실패를 **또** 알리고, 그 사이 나은 잡은 첫 관측 침묵 규칙에 걸려 복구 알림이 **영영** 안 나간다.
 */
async function loadJobs(): Promise<CronJobHealth[] | null> {
  try {
    return (await q(itemsPool, `SELECT id, label, action, last_status, last_summary, updated_at FROM org_cron WHERE enabled=true`)) as CronJobHealth[];
  } catch { return null; }
}

// 한 워크스페이스 1회 스캔. 호출자가 테넌트 컨텍스트를 세워 준다(forEachTenant).
async function scanOne(deps: CronWatchDeps): Promise<void> {
  const jobs = await (deps.listJobs ?? loadJobs)();
  if (!jobs) return;   // 못 읽었다 — 관측 없음. 상태도 그대로 둔다(아래 폐기 단계를 건너뛴다).
  const scope = (currentTenant()?.id ?? "") + KEY_SEP;
  const alive = new Set<string>();
  for (const job of jobs) {
    const key = scope + job.id;
    alive.add(key);
    const work = delegatedWork(job.last_summary);
    const states = work?.ids.length ? await (deps.taskStates ?? loadTaskStates)(work.ids) : null;
    const cur = cronPhaseOf(job.last_status, job.last_summary, states);
    if (cur === null) continue;   // 관측 없음 — 이전 상태를 그대로 둔다(중립)
    const prev = seen.get(key);
    if (!prev && cur === "failing"
      && inheritsAlertedFailure(failureRecordedAt(job, work, states), deps.bootedAt ?? BOOTED_AT)) {
      seen.set(key, { phase: "failing", problemSent: true });   // 복구 알림은 그대로 나가게 «보냈음» 으로 잇는다
      continue;
    }
    const a = cronAlertFor(prev?.phase ?? null, cur, withTaskReason(job, work, states));
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
 * 위탁형 잡의 실패 사유는 **실패한 레인**의 것으로 싣는다(순수) — 접수 전 실패면 그 사유, 아니면 실패한 위탁의
 *  org_task.error. 요약 최상위의 `task_error`·`error` 는 마지막으로 되먹여진 레인의 것이라 성공한 레인일 수 있다.
 *  (가림은 출구 cronFailureReason 이 한다.)
 */
function withTaskReason(job: CronJobHealth, work: DelegatedWork | null, states: ReadonlyMap<string, BatchTaskState> | null): CronJobHealth {
  if (!work) return job;
  const failed = work.ids.find((id) => states?.get(id)?.status === "failed");
  const why = work.entryErrors[0] ?? (failed ? states?.get(failed)?.error ?? null : null);
  if (!why) return job;
  const base = job.last_summary && typeof job.last_summary === "object" ? job.last_summary as Record<string, unknown> : {};
  return { ...job, last_summary: { ...base, task_error: why } };
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
  void tick(deps); // 부팅 직후 1회 — 직전 프로세스가 못 본 실패를 다음 주기까지 방치하지 않는다
}

export function stopCronWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  seen.clear();
}

/** 테스트 전용 — 한 tick 을 즉시 돌린다(주기를 기다리지 않고 전이 규칙을 검증). */
export async function tickOnce(deps: CronWatchDeps): Promise<void> {
  await tick(deps);
}

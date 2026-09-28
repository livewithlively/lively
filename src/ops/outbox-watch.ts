// 아웃박스 정체 감시 + 경보 — 「예산을 다 쓰고도 큐가 줄지 않는」 상태로 넘어갈 때와 풀릴 때만 알린다.
//
// 왜 이게 필요한가: 드레인에 시간예산이 생기면서(connectors/push-budget.ts) 한 배치를 다 못 비운 실행이
//  **정상 종료(exit 0)** 가 됐다. 그게 그 fix 의 목적이다 — 종전엔 kill 당해 exit!=0 이 되고 연속실패
//  서킷브레이커가 파이프라인 자체를 멈췄다. 대신 사각지대가 하나 생겼다: 매 틱 예산을 다 쓰는데 큐는
//  그대로인 상태에서 잡은 계속 ok 를 찍으므로 **크론 실패 감시(ops/cron-watch.ts)가 구조적으로 못 본다.**
//  그 한 칸을 메우는 모듈이다.
//
// 🔴 판정 축이 「pending 이 줄었나」가 아니라 「**예산을 다 쓰고도** 줄지 않았나」인 것이 이 파일의 핵심이다.
//  예산을 안 쓰고 끝난 실행은 큐를 끝까지 훑은 것이고, 그때 남은 행은 이번 틱에 처리할 수 없는 것이다
//  (부모가 아직 안 올라간 자식 등 — clickup-push 의 defer 경로). 그건 설계된 잔여지 정체가 아니다.
//  축을 「안 줄었다」로 넓히면 그 상시 잔여가 **영구 오탐**이 되어 이 감시 전체의 신뢰가 깎인다.
//
// 규약은 cron-watch 와 같이 box-watch 를 따른다(새 규약을 만들지 않는다):
//  · 판정은 순수 함수 — 전이 규칙을 테스트가 직접 못 박는다.
//  · `prev===cur` 침묵(늑대소년 방지) · 복구는 **알린 적 있는 문제**에만(box-watch.emitAlert 한 자리).
//  · 한계: 카운터는 프로세스 메모리라 **재기동하면 0 부터 다시 센다** — 배포 직후 이미 막혀 있던 큐는
//    STALL_TICKS 만큼 지나야 알린다. 영속화하면 없앨 수 있으나 그건 별도 설계다.
//  · 이탈: cron-watch 는 목록에서 사라진 잡의 상태를 지우지만 여기선 안 지운다 — 관측 없음(undefined)에
//    일시 DB 오류가 섞여 있어, 지우면 problemSent 가 사라져 **진짜 복구 알림이 억제**된다. 잡을 껐다
//    다시 켜면 옛 카운터가 남아 상한보다 일찍 알릴 수 있다(참인 알림이라 방치). 정확히 풀려면
//    observeFromCron 이 «켜진 잡 없음» 과 «조회 실패» 를 갈라야 한다.
//  · 한계: 이 축은 **배치(LIMIT)가 통째로 defer 인 큐 머리 점거**를 못 본다 — 그때는 예산을 안 쓰고
//    끝나므로 budgetStopped=false 다. 검증: `grep -n "LIMIT \$1" src/connectors/clickup-push.ts`
//
// ⚠ 감시가 게이트웨이를 죽이면 안 된다 — 전부 best-effort(throw 금지, 로그만).
import { itemsPool, q } from "../db/client.js";
import { emitAlert, type AlertSender, type BoxAlert } from "./box-watch.js";
import { forEachTenant } from "../scheduler/tenant-fanout.js";
import { currentTenant } from "../org/tenant-context.js";
import { type DrainSummary } from "../connectors/sync-outcome.js";
import { logger } from "../log.js";

// 몇 틱 연속이면 정체로 볼 것인가. 1 이면 한 번의 예산 소진이 곧 알림이라, 큰 백로그를 정상적으로
//  소화하는 중에도 알림이 나간다(그 상황은 오히려 드레인이 제 일을 하고 있는 것이다).
//  감시 주기(아래 CHECK_MS)와 곱한 값이 «이만큼 막혀 있으면 사람을 부른다» 는 뜻이 된다.
export const STALL_TICKS = 3;

const CHECK_MS = Number(process.env.OUTBOX_WATCH_INTERVAL_MS ?? 5 * 60_000);

export type OutboxPhase = "ok" | "stalled";

/** 한 번의 관측 — 드레인 수치 + 그 실행의 시각. 같은 시각이면 **같은 실행을 다시 본 것**이다(scanOne). */
export type Observation = DrainSummary & { lastRunAt: string | null };

/** 틱 사이에 이월되는 상태. `remaining` 은 다음 전진 판정의 baseline 이다. */
export interface StallState { streak: number; remaining: number; lastRunAt: string | null }

/** 알림 본문이 쓰는 관측 + 그 시점 카운터. */
export type DrainObservation = DrainSummary & { streak: number };

export interface OutboxWatchDeps {
  /** 관측 조회(주입 seam). 생략하면 그 워크스페이스의 push 잡 요약에서 읽는다. */
  observe?: () => Promise<Observation | undefined>;
  send: AlertSender;
}

const seen = new Map<string, { phase: OutboxPhase; problemSent: boolean; state: StallState }>();
const KEY_SEP = "\u0000";
const WATCH_KEY = "outbox";
let timer: NodeJS.Timeout | null = null;

/**
 * 틱 간 상태 전이(순수) — streak 과 전진 baseline 을 같은 규칙으로 옮긴다.
 * 전진했거나 예산을 안 썼으면 streak 은 0.
 *
 *  `budgetStopped=false` 를 0 으로 두는 것이 이 감시가 상시 잔여를 오탐하지 않는 근거다(머리말).
 *  `remaining===0` 도 0 이다 — 마지막 행을 처리한 직후 다음 반복에서 예산에 걸리면 «다 비웠는데
 *  예산 소진» 이라는 모양이 나올 수 있는데, 그건 정체가 아니다.
 */
export function nextStallState(prev: StallState | null, cur: Observation): StallState {
  //  🔴 못 센 값(-1)은 **중립이지 해소가 아니다.** 두 가지를 같이 지켜야 한다:
  //   ① streak 을 0 으로 되돌리면 phase 가 ok 로 승격돼 「정체 해소 … 남은 항목 -1건」이 실제로 발송되고,
  //     다음 틱부터 다시 세어 경보가 쌍으로 난다 — 이 모듈이 막으려는 늑대소년 그 자체다.
  //   ② **baseline(remaining)도 유지해야 한다.** -1 을 저장하면 다음 전진 판정이 `400 < -1` 이 되어
  //     영영 거짓이다 — 큐가 실제로 줄고 있는데도 제자리로 세어 같은 거짓 경보 쌍이 순서만 바꿔 되살아난다.
  //   전이를 이 한 함수에 모아 둔 이유가 그것이다: 둘을 떼어 놓으면 표 테스트가 ②를 못 잠근다.
  if (cur.remaining < 0) {
    return { streak: prev?.streak ?? 0, remaining: prev?.remaining ?? -1, lastRunAt: cur.lastRunAt };
  }
  const streak = !cur.budgetStopped || cur.remaining === 0 ? 0
    : prev && cur.remaining < prev.remaining ? 0          // 전진했다 — 백로그 소화 중
    : (prev?.streak ?? 0) + 1;
  return { streak, remaining: cur.remaining, lastRunAt: cur.lastRunAt };
}

export function outboxPhaseOf(streak: number): OutboxPhase {
  return streak >= STALL_TICKS ? "stalled" : "ok";
}

/**
 * 전이 → 알림(순수). 같은 상태 반복은 `null`(침묵).
 *
 *  `prev === null && cur === "stalled"` 분기는 **scanOne 에서 도달하지 않는다** — 카운터가 0 부터라
 *   첫 관측의 phase 는 항상 ok 다(머리말의 재기동 한계). 순수 함수의 방어로만 둔다.
 */
export function outboxAlertFor(prev: OutboxPhase | null, cur: OutboxPhase, obs: DrainObservation): BoxAlert | null {
  if (prev === cur) return null;
  if (prev === null && cur === "ok") return null;   // 첫 관측이 정상 — 기동할 때마다 «해소» 를 알리면 안 된다
  const detail = { remaining: obs.remaining, budgetStopped: obs.budgetStopped, streak: obs.streak };
  if (cur === "stalled") {
    return {
      severity: "warn",
      title: "아웃박스 정체 — 외부 반출이 안 빠집니다",
      text: `아웃바운드 드레인이 ${obs.streak}회 연속으로 시간예산을 다 쓰고도 큐를 줄이지 못했습니다.`
        + ` 남은 항목 ${obs.remaining}건.\n`
        //  예산 소진 자체는 실패가 아니라서 크론은 계속 ok 를 찍는다 — 받는 사람이 «잡은 정상인데 왜?» 로
        //   헤매지 않게 그 사실을 먼저 말한다.
        + `잡은 정상(ok)으로 보입니다 — 예산 소진은 실패가 아니라 정상 종료이기 때문입니다.\n`
        + `→ 관리 ▸ 스케줄 의 마지막 실행 요약에서 pushed·visited 를 보세요.`
        + ` 매 틱 pushed 가 0 이면 큐 머리가 막힌 것이고, pushed 는 있는데 remaining 이 안 줄면 유입이 처리보다 빠릅니다.\n`
        + `(남은 항목 수에는 반출 대상이 아닌 행 — 컨테이너 미설정 네이티브·고아 — 도 함께 잡힙니다.)`,
      detail,
    };
  }
  return {
    severity: "ok",
    title: "아웃박스 정체 해소",
    text: `아웃바운드 드레인이 다시 큐를 줄이고 있습니다. 남은 항목 ${obs.remaining}건.`,
    detail,
  };
}

/**
 * 그 워크스페이스의 push 잡 마지막 실행에서 드레인 수치를 읽는다.
 *
 *  표 부재·DB 미연결·요약 모양 불일치는 전부 `undefined`(관측 없음 → 침묵). **0 으로 뭉개지 않는다** —
 *  모르는 것을 «큐가 비었다» 로 읽으면 이 감시가 정체를 못 본다.
 */
async function observeFromCron(): Promise<Observation | undefined> {
  try {
    //  **가장 최근 실행 1건**만 본다. 행을 여러 개 훑어 «처음 찾은 drain» 을 쓰면 push 잡이 둘 이상일 때
    //   틱마다 다른 잡을 비교해 카운터가 요동한다(행 순서는 미정의다).
    const rows = await q(itemsPool,
      `SELECT last_run_at, last_summary FROM org_cron
        WHERE enabled=true AND action='connector_push'
        ORDER BY last_run_at DESC NULLS LAST LIMIT 1`);
    const row = (rows as Array<{ last_run_at?: unknown; last_summary?: unknown }>)[0];
    if (!row) return undefined;
    const systems = (row.last_summary as { systems?: unknown[] } | null)?.systems;
    if (!Array.isArray(systems)) return undefined;
    for (const s of systems) {
      const drain = (s as { drain?: unknown } | null)?.drain;
      if (isDrainSummary(drain)) return { ...drain, lastRunAt: stampOf(row.last_run_at) };
    }
  } catch { /* 못 재면 알리지 않는다 */ }
  return undefined;
}

/** 실행 시각을 비교 가능한 문자열로(Date·string 둘 다 온다). 모르면 null — 그땐 중복 판정을 포기한다. */
function stampOf(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
}

function isDrainSummary(v: unknown): v is DrainSummary {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return typeof d.remaining === "number" && typeof d.budgetStopped === "boolean";
}

async function scanOne(deps: OutboxWatchDeps): Promise<void> {
  const obs = await (deps.observe ?? observeFromCron)();
  if (!obs) return;   // 관측 없음 — 이전 상태를 그대로 둔다(중립)
  const key = (currentTenant()?.id ?? "") + KEY_SEP + WATCH_KEY;
  const prev = seen.get(key);
  //  🔴 카운터가 세는 것은 **드레인 실행 횟수**여야 한다. 감시 주기와 잡 주기는 서로 모르므로(잡 주기는
  //   운영자가 바꾼다 — org_cron.interval_sec), 같은 요약을 여러 틱 재관측하면 실행 **한 번**의 예산 소진이
  //   「3회 연속」으로 둔갑한다. 잡이 멈춰 요약이 얼어붙은 경우도 같다(그건 크론 감시가 알릴 일이다).
  if (obs.lastRunAt && obs.lastRunAt === prev?.state.lastRunAt) return;
  const state = nextStallState(prev?.state ?? null, obs);
  const cur = outboxPhaseOf(state.streak);
  const a = outboxAlertFor(prev?.phase ?? null, cur, { ...obs, streak: state.streak });
  const next = { phase: cur, problemSent: prev?.problemSent ?? false, state };
  if (a) {
    const sent = await emitAlert(a, next.problemSent, deps.send);
    next.problemSent = a.severity === "ok" ? false : (sent || next.problemSent);
  }
  seen.set(key, next);
}

async function tick(deps: OutboxWatchDeps): Promise<void> {
  await forEachTenant("outbox-watch", () => scanOne(deps))
    .catch((err) => logger.warn({ err }, "아웃박스 감시 tick 실패(비치명 — 다음 tick 재시도)"));
}

export function startOutboxWatch(deps: OutboxWatchDeps): void {
  if (timer) return;
  timer = setInterval(() => { void tick(deps); }, CHECK_MS);
  timer.unref?.();
  void tick(deps);
}

export function stopOutboxWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  seen.clear();
}

/** 테스트 전용 — 한 tick 을 즉시 돌린다(주기를 기다리지 않고 전이 규칙을 검증). */
export async function tickOnce(deps: OutboxWatchDeps): Promise<void> {
  await tick(deps);
}

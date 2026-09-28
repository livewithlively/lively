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
//  · 단 «첫 관측이 정상이면 침묵» 중 정상 쪽만 따른다 — 기동 시점에 **이미 막혀 있으면 알린다**(아래).
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

/** 한 번의 관측 — 드레인이 마지막 실행에서 남긴 수치. */
export interface DrainObservation extends DrainSummary {
  streak: number;
}

interface StallState { streak: number; remaining: number }

export interface OutboxWatchDeps {
  /** 관측 조회(주입 seam). 생략하면 그 워크스페이스의 push 잡 요약에서 읽는다. */
  observe?: () => Promise<DrainSummary | undefined>;
  send: AlertSender;
}

const seen = new Map<string, { phase: OutboxPhase; problemSent: boolean; state: StallState }>();
const KEY_SEP = "\u0000";
const WATCH_KEY = "outbox";
let timer: NodeJS.Timeout | null = null;

/**
 * 연속 정체 횟수(순수). 전진했거나 예산을 안 썼으면 0 으로 되돌린다.
 *
 *  `budgetStopped=false` 를 0 으로 두는 것이 이 감시가 상시 잔여를 오탐하지 않는 근거다(머리말).
 *  `remaining===0` 도 0 이다 — 마지막 행을 처리한 직후 다음 반복에서 예산에 걸리면 «다 비웠는데
 *  예산 소진» 이라는 모양이 나올 수 있는데, 그건 정체가 아니다.
 */
export function nextStallStreak(prev: StallState | null, cur: DrainSummary): number {
  if (!cur.budgetStopped) return 0;
  if (cur.remaining <= 0) return 0;                        // 비었거나(0) 못 셌다(-1) — 둘 다 정체로 세지 않는다
  if (prev && cur.remaining < prev.remaining) return 0;   // 전진했다 — 백로그 소화 중
  return (prev?.streak ?? 0) + 1;
}

export function outboxPhaseOf(streak: number): OutboxPhase {
  return streak >= STALL_TICKS ? "stalled" : "ok";
}

/**
 * 전이 → 알림(순수). 같은 상태 반복은 `null`(침묵).
 *
 *  ⚠ cron-watch 와 달리 **첫 관측이 정체면 알린다**(`prev === null` 이어도). 재기동이 상태를 지우므로,
 *   정상 쪽 규칙을 그대로 가져오면 배포 때마다 이미 막혀 있던 큐가 조용해진다 — 그건 이 감시가
 *   메우려는 바로 그 구멍이다. 첫 관측이 «정상» 일 때만 침묵한다.
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
        + ` 매 틱 pushed 가 0 이면 큐 머리가 막힌 것이고, pushed 는 있는데 remaining 이 안 줄면 유입이 처리보다 빠릅니다.`,
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
async function observeFromCron(): Promise<DrainSummary | undefined> {
  try {
    const rows = await q(itemsPool,
      `SELECT last_summary FROM org_cron WHERE enabled=true AND action='connector_push'`);
    for (const row of rows as Array<{ last_summary?: unknown }>) {
      const systems = (row.last_summary as { systems?: unknown[] } | null)?.systems;
      if (!Array.isArray(systems)) continue;
      for (const s of systems) {
        const drain = (s as { drain?: unknown } | null)?.drain;
        if (isDrainSummary(drain)) return drain;
      }
    }
  } catch { /* 못 재면 알리지 않는다 */ }
  return undefined;
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
  const streak = nextStallStreak(prev?.state ?? null, obs);
  const cur = outboxPhaseOf(streak);
  const a = outboxAlertFor(prev?.phase ?? null, cur, { ...obs, streak });
  const next = { phase: cur, problemSent: prev?.problemSent ?? false, state: { streak, remaining: obs.remaining } };
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

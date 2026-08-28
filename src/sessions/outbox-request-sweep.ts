// 매니지드에서 아웃박스 정비를 **요청에 얹어** 돌린다 (#2246) — 하우스키핑이 안 도는 자리의 대체 경로.
import type { RequestHandler } from "express";
import { requestScopedTenancy } from "../boot/housekeeping.js";
import { currentTenant } from "../org/tenant-context.js";
import { logger } from "../log.js";

/** 테넌트 하나를 다시 쓸기까지의 최소 간격. 종전 하우스키핑 스윕과 **같은 주기**(5분)를 쓴다 —
 *  이건 그 스윕의 대체지 새 정책이 아니다. 더 자주 돌 이유도 없다(회수 판정 자체가 2분 창이다). */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

//  ⚠ 인메모리다. 게이트웨이가 재기동하면 비는데, **그게 맞다**: 재기동이야말로 배달 루프를 죽여
//   좀비를 만드는 사건이므로, 재기동 직후 첫 요청이 곧바로 쓸어야 한다.
const lastSweep = new Map<string, number>();

/** 테스트용 — 디바운스 상태를 비운다. */
export function resetSweepDebounce(): void { lastSweep.clear(); }

/** 관측용(읽기 전용) — 지금까지 정비 슬롯을 가져간 테넌트들. "아무도 안 쓸렸다"를 볼 수 있어야
 *  '컨텍스트 없으면 무동작'을 실제로 검증할 수 있다(그 테넌트 하나만 보면 늘 참이라 아무것도 못 잡는다). */
export function sweptTenantIds(): string[] { return [...lastSweep.keys()]; }

/** 이 테넌트를 지금 쓸어야 하나(그렇다면 시각을 찍는다). 순수하지 않지만 판정과 기록이 원자적이어야
 *  동시 요청 둘이 같은 스윕을 두 번 돌리지 않는다(node 는 단일 스레드라 이 검사-후-기록이 쪼개지지 않는다). */
export function shouldSweep(tenantId: string, now: number, minIntervalMs = SWEEP_MIN_INTERVAL_MS): boolean {
  const prev = lastSweep.get(tenantId);
  if (prev !== undefined && now - prev < minIntervalMs) return false;
  lastSweep.set(tenantId, now);
  return true;
}

/**
 * 요청에 얹은 테넌트 스윕 (#2246).
 *
 *  ── 왜 필요한가 ──
 *  요청별 테넌시(매니지드)에서는 `boot/housekeeping` 이 `gate:"scheduler"` 스텝을 **아예 안 돌린다**.
 *  그 판단은 옳다(요청 밖엔 테넌트 컨텍스트가 없어 `42704` 로 매 tick 실패한다). 그런데 그 안에
 *  `resumeOutbox` 가 있어서, 매니지드에는 **아웃박스 회수·청소·재-kick 이 통째로 없었다**(#2244 실측:
 *  첫 지시 한 건이 `sending` 인 채 63분, 하루 넘은 끝난 행 30건 잔존).
 *
 *  #2244 가 그중 회수를 `listOutbox` 에 붙여 우회했지만 **사람이 그 대화창을 볼 때만** 돌았다.
 *  여기서 그 조건을 "그 테넌트로 요청이 하나라도 왔을 때"로 넓힌다.
 *
 *  ── 왜 이게 "누구의 것인지 모르는 정리"가 아닌가 ──
 *  housekeeping 머리말이 거부한 것은 *요청 서버가 **임의로 한 테넌트를 골라** 돌리는 것*이다.
 *  여기서는 고르지 않는다 — **요청이 어느 테넌트인지 말해준다.** 그리고 이 DB 는 테넌트 RLS 라
 *  컨텍스트 안에서 `resumeOutbox()` 를 부르면 쿼리가 **그 테넌트로 자동 스코프**된다. 그래서 새 함수를
 *  만들지 않고 있던 것을 그대로 부른다 — 회수·청소·재-kick 셋이 한 벌로 따라온다.
 *
 *  ── 남는 구멍(고치지 않았다) ──
 *  **그 테넌트로 요청이 아예 안 오는 동안**은 여전히 안 돈다. 사람도 하네스도 아무도 안 건드리는
 *  워크스페이스가 그렇다. 그건 머리말이 말한 '별도 러너'의 몫으로 남는다 — 다만 "아무도 안 쓰는 동안"
 *  으로 좁혀졌다.
 */
export function outboxRequestSweepMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (_req, _res, next) => {
    //  ⚠ 요청을 늦추지 않는 방법은 "next() 를 먼저 부르기"가 **아니다** — 그러면 하류가 동기 예외를
    //   던졌을 때 이 아래가 아예 안 돈다(express 함정). 여기 동기 코드는 Map 조회 하나뿐이고 실제
    //   DB 작업은 `void import(...)` 뒤라 어차피 블로킹하지 않는다. 그러니 **판정→발사→next()** 로 둔다.
    try { maybeSweep(env); } catch (err) { logger.warn({ err }, "outbox: 테넌트 스윕 판정 실패(비치명)"); }
    next();
  };
}

/** 판정하고, 돌 차례면 **기다리지 않고** 던진다. */
function maybeSweep(env: NodeJS.ProcessEnv): void {
  // ⚠ 이 판정이 거짓이면 하우스키핑이 스스로 돈다 — 여기서 또 돌면 **이중**이다.
  if (!requestScopedTenancy()) return;
  const t = currentTenant();
  if (!t) return; // 컨텍스트 없음(테넌트 무관 경로) — 쓸 대상이 특정되지 않는다.
  if (!shouldSweep(String(t.id), Date.now(), sweepIntervalMs(env))) return;
  //  컨텍스트 **안**에서 부른다 — RLS 가 이 테넌트로 스코프한다. 여기서 등록한 then 체인은
  //  AsyncLocalStorage 저장소를 그대로 물려받는다(enqueue→deliverLoop 가 이미 같은 원리로 돈다).
  void import("./session-outbox.js")
    .then(({ resumeOutbox }) => resumeOutbox())
    .then(() => logger.info({ tenant: t.slug }, "outbox: 요청에 얹은 테넌트 스윕"))
    .catch((err) => logger.warn({ err, tenant: t.slug }, "outbox: 테넌트 스윕 실패(비치명 — 다음 요청이 다시 시도)"));
}

/** 주기 오버라이드(운영 중 조정용). 잘못된 값은 조용히 기본값으로 — 정비가 설정 오타로 멈추면 안 된다.
 *  ⚠ `Number("")` 는 **0** 이다(NaN 이 아니다) — 그래서 유한성만 보면 빈 문자열이 "주기 0" 으로 통과한다.
 *   양수 검사가 그 구멍을 막는다. 내보내는 이유는 이 정책을 그 자리에서 검증하기 위해서다. */
export function sweepIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number((env.LIVELY_OUTBOX_SWEEP_MS || "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : SWEEP_MIN_INTERVAL_MS;
}

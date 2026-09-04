// 하우스키핑 **리더 선출** — 게이트웨이가 둘 떠 있어도 주기 잡은 한 프로세스만 돈다. (#2664 3단계)
//
// ── 왜 지금 필요한가 ────────────────────────────────────────────────────────
// 매니지드 이미지 롤은 게이트웨이를 **내렸다 올린다**. 그 사이 전 테넌트가 502 라서, 롤을
//  무중단으로 바꾸는 과제(#2664)가 «새 게이트웨이를 먼저 띄우고 → 확인하고 → 옛 것을 내린다»
//  로 간다. 그러면 **옛·새 프로세스가 수십 초 겹친다.**
//
// 지금 코드는 그 겹침을 견디지 못한다. `engine.ts` 머리말이 그렇게 적어 뒀다:
//
//     단일 프로세스(launchd 상시구동) 전제 → 리더선출 불요(HA 면 advisory lock 추가).
//     잡당 **인메모리** 락으로 중첩 방지.
//
// 인메모리 락은 **자기 프로세스 안에서만** 듣는다. 그래서 겹치는 동안 같은 크론이 두 번 발화한다.
//
// ── ★ 왜 «틱마다 잠그고 푸는» 것으로는 안 되나 (설계의 핵심) ────────────────
// 처음엔 `tickAllTenants()` 를 `pg_try_advisory_lock` 으로 감싸려 했다. **그건 안 된다.**
//  `tick()` 은 잡을 `void executeAndRecord(job)` 로 **fire-and-forget** 으로 던지고 곧바로
//  돌아온다(그게 HTTP 틱 엔드포인트가 요청을 안 붙잡는 이유다). 그리고 `last_run_at` 은
//  잡이 **끝난 뒤에야** 쓰인다(executeAndRecord — `await runJob()` 다음 UPDATE).
//  즉 락을 틱 동안만 쥐면:
//    A 가 락 → 잡 J 를 던짐(배경) → 락 해제 → B 가 락 → **J 는 아직 due 로 보인다** → 또 던짐.
//  잡이 길수록(커넥터 싱크·증류는 분 단위) 이 창이 넓다. 그래서 지켜야 할 것은 «틱» 이 아니라
//  **«이 프로세스가 스케줄러를 돌릴 자격이 있나»** 다 → 락을 **계속 쥔다.**
//
// ── 대가와 그 값 ───────────────────────────────────────────────────────────
// 리더는 커넥션 하나를 상시 점유한다(풀 max=20 중 1). 그 값으로 얻는 것이 «겹쳐도 한 번» 이다.
// ⚠ 락은 **세션 스코프**라 그 커넥션이 죽으면 Postgres 가 알아서 푼다 — 옛 게이트웨이가
//  어떻게 죽든(정상 종료·SIGKILL·박스 정전) 후임이 다음 시도에서 이어받는다. 우리가 «풀어야만»
//  넘어가는 구조로 만들지 않는다. 그게 리더선출을 손수 짤 때 제일 흔히 나는 사고다.
import type pg from "pg";
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";

/**
 * 락 식별자 — 두 정수 형태(`pg_try_advisory_lock(classid, objid)`)를 쓴다.
 *
 * ⚠ `hashtext('...')` 로 만들지 않는다. 문서화되지 않은 내부 함수라 판이 바뀌면 값이 갈릴 수
 *  있고, 그때 **두 프로세스가 서로 다른 락을 잡고 둘 다 리더가 된다** — 조용한 실패다.
 *  상수는 눈으로 확인할 수 있다.
 *  CLASS 는 `0x6C766C79` = ASCII "lvly". OBJ 는 이 조직 안의 락 번호(다음 락은 2, 3 …).
 */
export const LEADER_LOCK_CLASS = 0x6c766c79; // 1819173241
export const LEADER_LOCK_OBJ = 1; // 1 = 하우스키핑 스케줄러

/** 재시도 주기 — 옛 리더가 사라진 뒤 후임이 이어받기까지의 상한이다. */
const RETRY_MS = 10_000;

let holder: pg.PoolClient | null = null;
let timer: NodeJS.Timeout | null = null;
let acquiring = false;
let warnedOnce = false;

/**
 * 이 프로세스가 주기 잡을 돌릴 자격이 있나. **동기 · 값싸다**(메모리 플래그) — 매 틱에서 불러도 된다.
 *
 * ⚠ 선출을 시작하지 않았으면 늘 `false` 다. 부르는 쪽이 `startSchedulerLeadership()` 을 먼저 부른다.
 */
export function isSchedulerLeader(): boolean {
  return holder !== null;
}

/** 리더 자격을 잃는다(커넥션 이상 등). 커넥션은 **폐기**한다 — 락이 붙은 채로 풀에 돌려주지 않는다. */
function dropLeadership(why: string): void {
  const c = holder;
  holder = null;
  if (!c) return;
  logger.warn({ why }, "scheduler leadership lost — 다음 시도에서 다시 잡는다");
  //  `release(true)` = 폐기. 백엔드 커넥션이 닫히면 세션 락도 함께 풀려 후임이 즉시 잡을 수 있다.
  try { c.release(true); } catch { /* 이미 죽은 커넥션 */ }
}

async function tryAcquire(): Promise<void> {
  if (holder || acquiring) return;
  acquiring = true;
  let c: pg.PoolClient | null = null;
  try {
    c = await itemsPool.connect();
    const r = await c.query(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS got",
      [LEADER_LOCK_CLASS, LEADER_LOCK_OBJ],
    );
    if (r.rows?.[0]?.got === true) {
      holder = c;
      warnedOnce = false;
      //  커넥션이 죽으면 우리는 더 이상 리더가 아니다. 이 리스너가 없으면 **락은 이미 풀렸는데
      //   이 프로세스만 자기가 리더라고 믿는** 상태가 된다 — 그때 두 프로세스가 함께 돈다.
      c.on("error", (err: Error) => dropLeadership(err?.message ?? "connection error"));
      logger.info({ class: LEADER_LOCK_CLASS, obj: LEADER_LOCK_OBJ }, "scheduler leadership acquired — 이 프로세스가 주기 잡을 돈다");
      return;
    }
    //  못 잡았다 = 다른 프로세스가 리더다. **정상**이고 조용히 지나간다(30초마다 로그를 남기지 않는다).
    //  락을 안 쥐었으므로 그냥 반납해도 안전하다.
    c.release();
  } catch (e) {
    //  ⚠ 여기서 던지지 않는다. 선출 실패가 게이트웨이 기동을 막으면 안 된다 — 최악이
    //   «주기 잡이 안 돈다» 인데, 그 자리에서 «게이트웨이가 안 뜬다» 로 키우지 않는다.
    //  상태를 모르는 커넥션은 폐기한다(락이 잡힌 채 반납되는 경우를 배제).
    if (c) { try { c.release(true); } catch { /* noop */ } }
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn({ err: (e as Error)?.message }, "scheduler leadership 획득 실패 — 재시도한다(이 로그는 한 번만)");
    }
  } finally {
    acquiring = false;
  }
}

/**
 * 선출을 시작한다. **멱등**(중복 호출 무시) — 스케줄러·위탁 큐가 각자 불러도 한 번만 선다.
 *
 * ⚠ 즉시 한 번 시도하고, 그 뒤 주기로 재시도한다. 재시도가 있어야 **후임이 이어받는다** —
 *  부팅 때 한 번만 물으면, 새 게이트웨이가 뜬 순간 옛 것이 아직 살아 있었다는 이유로
 *  그 프로세스는 **영영 리더가 못 된다.**
 */
export function startSchedulerLeadership(): void {
  if (timer) return;
  void tryAcquire();
  timer = setInterval(() => { void tryAcquire(); }, RETRY_MS);
  timer.unref?.(); // 선출이 프로세스 정상 종료를 붙잡지 않게
}

/**
 * 자리를 **비워 준다**(정상 종료 경로). 안 불러도 커넥션이 닫히며 락이 풀리지만, 명시적으로
 *  풀면 후임이 최대 RETRY_MS 를 기다리지 않고 다음 시도에서 바로 잡는다 — 청/녹 교대가 그만큼 빠르다.
 */
export async function releaseSchedulerLeadership(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  const c = holder;
  holder = null;
  if (!c) return;
  try {
    await c.query("SELECT pg_advisory_unlock($1::int, $2::int)", [LEADER_LOCK_CLASS, LEADER_LOCK_OBJ]);
  } catch { /* 못 풀어도 커넥션이 닫히면 풀린다 */ }
  //  ⚠ 항상 폐기한다. unlock 이 실패했을 수 있고, 그때 **락이 붙은 커넥션을 풀에 돌려주면**
  //   그 조직의 리더 자리가 아무도 모르게 영구 점유된다.
  try { c.release(true); } catch { /* noop */ }
  logger.info("scheduler leadership released — 후임이 이어받는다");
}

/**
 * 시험 전용 — 획득을 **1회** 시도하고 그 완료를 기다린다(운영 호출 금지).
 *  `startSchedulerLeadership()` 은 fire-and-forget 이라 시험에서 결과를 기다릴 수 없다.
 */
export function __test_acquireOnce(): Promise<void> { return tryAcquire(); }

/** 시험 전용 — 모듈 상태를 초기화한다(운영 호출 금지). */
export function __test_reset(): void {
  if (timer) { clearInterval(timer); timer = null; }
  holder = null;
  acquiring = false;
  warnedOnce = false;
}

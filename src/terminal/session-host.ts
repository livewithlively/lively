// 세션 호스트 — **세션을 소유하는 프로세스의 한 벌** (#2600 T1).
//
// ── 무엇이 두 벌이었나 ───────────────────────────────────────────────────────
// 세션의 «의미»(생성·삭제·attach 본체)는 진작 한 벌이었다 — `attachSession` 하나를 셋이 부른다
//  (게이트웨이 인프로세스 · attach 워커 · 노드 에이전트). 갈라져 있던 것은 그 위의 얇은 층,
//  **«이 프로세스가 attach 를 소유한다»는 살림**이다:
//
//   | 관심사                    | attach-worker-entry | node/agent          |
//   |---------------------------|---------------------|---------------------|
//   | 세션별 살아있는 소켓 수    | `sessionCount` Map  | (없음 — 채널만 셌다) |
//   | 마지막 소켓 통지          | `session-empty` IPC | (없음)               |
//   | 유휴 자진 종료            | `armIdleExit`       | (없음 — 상주 데몬)   |
//   | 종료 시 PTY 일괄 회수      | `shutdown()`        | teardown + SIGTERM   |
//   | 살아있는 attach 수 보고    | `stat` IPC          | (없음)               |
//
//  같은 살림을 두 파일이 각자 적었고, 그래서 한쪽에만 있는 것(유휴 종료·누수 보고)이 생겼다.
//
//  ⚠ **여기로 모았다고 다섯이 다 «한 값» 이 되는 것은 아니다** — 정확히 하나만 그렇다:
//   · **유휴 자진 종료** → 토폴로지가 정한다(`lifetimeFor`). 이게 이 통합이 실제로 없앤 비대칭이다.
//   · 장부·마지막 소켓 통지·PTY 회수 → **구현이 한 벌**이 됐다(값은 같고 코드가 하나다).
//   · **누수 지표 보고(`onStat`)는 여전히 어댑터가 걸지 말지 정한다** — 워커는 걸고 노드는 안 건다.
//     그 비대칭은 의도다(게이트웨이가 자기 **워커**를 합산하는 통로다 — #687). 그리고 그 결과
//     **노드가 띄운 attach PTY 는 오늘 아무 데서도 집계되지 않는다.** 이건 이 변경이 만든 것이 아니라
//     종전부터 그랬고(노드는 `stat` 을 보낸 적이 없다) 여기서 고치지도 않았다 — 고치려면 노드→게이트웨이
//     프로토콜에 축이 하나 필요하다(범위 밖). **비어 있다는 사실을 적어 두는 것**이 여기서 할 일이다.
//
// ── 전송은 여기 없다 ─────────────────────────────────────────────────────────
//  이 모듈은 **소켓을 어디서 받았는지 모른다.** 받는 방법이 곧 전송이고 그건 어댑터의 몫이다:
//   · 같은 호스트 = **fd 이관**(`attach-worker-host.handoff` → `attach-worker-entry`)
//   · 다른 호스트 = **WS 중계**(`node/registry.nodeRelayAttach` → `node/agent` 의 `ChanSocket`)
//  둘 다 `AttachSocket` 하나로 좁혀져 들어오므로 이 파일은 그 인터페이스만 안다.
//
//  ⚠ **«내가 어느 전송으로 먹고 있나» 를 토폴로지에 묻지 마라.** #2599 T2 가 그 뜻으로 `attachTransport`
//   필드를 뒀다가 T3 이 **필드째 지웠다** — 전송이 갈리는 실제 자리는 `terminal-pty-upgrade` 의 요청별
//   판정(`?node=`)이라 **프로세스 축으로 얼린 값이 대표할 수 없다**(같은 게이트웨이가 요청마다 갈린다).
//   이 파일이 토폴로지에서 받는 것은 «내가 어디서 도나»(`sessionHost`) 하나이고, 그것으로 파생하는 것도
//   «얼마나 사나» 하나다. 전송은 어댑터가 **자기가 누구인지 알고** 부르는 것이지 물어볼 값이 아니다.
//
// ⚠ **import 최소 규율**(attach-worker-entry.ts 머리말에서 이어받는다) — 앱·DB·스케줄러·테넌시를
//  끌어오면 워커의 격리 취지가 무너지고 노드 번들이 다시 무거워진다(#2165 의 «간선 하나가 11개를 끌었다»).
//  그래서 **테넌트 컨텍스트조차 여기서 import 하지 않는다** — 어댑터가 `run` 으로 실어 준다.
//  세션 **op**(생성·삭제·수정…)는 DB 표면을 끌어오므로 이 파일이 아니라 `session-ops.ts` 에 있다.
//  그 둘을 한 파일에 두면 attach 워커가 op 층의 무게를 통째로 상속한다 — 층을 가른 이유가 그것이다.
import { attachSession, killAttachedPtys, liveAttachCount } from "./terminal-pty.js";
import type { AttachSocket } from "./terminal-pty.js";
import { execTopology } from "../exec-topology.js";

/**
 * 이 호스트 프로세스가 얼마나 사나 — **토폴로지가 정한다**(어댑터가 고르지 않는다).
 *  · `ephemeral` — 세션이 0이 되면 스스로 나간다. attach 워커(게이트웨이가 필요할 때 포크한다)가 이것이다.
 *  · `resident`  — 붙은 세션이 없어도 남는다. 노드 데몬(그 PC 에 상주하며 게이트웨이 지시를 기다린다)이 이것이다.
 */
export type HostLifetime = "ephemeral" | "resident";

/**
 * «내가 어디서 도나»에서 «얼마나 사나»를 파생한다 (#2599 T2 토폴로지 모듈이 답의 출처다).
 *
 *  종전엔 이 값이 **파일마다 하드코딩**이었다 — 워커 엔트리에만 `IDLE_EXIT_MS` 가 있고 노드엔 없었다.
 *  그게 «노드는 상주해야 한다»는 판단이었는지 그냥 안 적은 것인지 코드로는 구별할 수 없었다.
 *  이제는 토폴로지가 답한다: 노드 에이전트면 상주, 그 밖이면 일시.
 */
export function lifetimeFor(sessionHost = execTopology().sessionHost): HostLifetime {
  return sessionHost === "node" ? "resident" : "ephemeral";
}

export interface SessionHostOptions {
  /**
   * 세션의 마지막 소켓이 닫혔다. fd 어댑터는 이걸로 sticky 매핑을 푼다(`attach-router.releaseSession`).
   *
   * ⚠ `shutdown()` 은 이걸 **쏘지 않는다**(장부만 비운다). 프로세스가 끝나는 자리라 통지가 부모에게
   *  닿을 보장이 없기 때문이고, 그래도 새지 않는 이유는 부모가 **자식 exit 로** 정리하기 때문이다 —
   *  `attach-worker-host` 의 `child.on("exit") → reap() → router.dropWorker()` 가 그 워커의 세션
   *  매핑을 한꺼번에 떨군다. 즉 «마지막 소켓» 은 이 콜백이, «워커가 통째로 사라짐» 은 exit 이 담당한다.
   */
  onSessionEmpty?: (id: string) => void;
  /**
   * 붙은 세션이 0인 채 `idleExitMs` 가 지났다. `ephemeral` 에서만 불린다.
   *
   * ⚠ **안 주면 유휴 종료를 아예 안 건다** — 즉 `ephemeral` 인데도 영원히 안 나간다. 그게 기본값인
   *  이유는 이 콜백이 «프로세스를 끝낸다» 를 뜻해서다: 호스트가 제멋대로 나가면 안 되고, **나가도
   *  되는지 아는 것은 어댑터**다(워커는 게이트웨이가 다시 포크해 준다 — 노드 데몬은 그런 부모가 없다).
   *  그래서 «수명은 토폴로지가, 나가는 행동은 어댑터가» 로 갈라 뒀다. 새 ephemeral 호스트를 만들면서
   *  이걸 빠뜨리면 **조용히 안 죽는 워커**가 된다(12행 시험이 그 동작을 고정한다).
   */
  onIdle?: () => void;
  /** 주기 보고 — 살아있는 attach 수(#687 누수 지표). 안 주면 타이머를 안 건다. */
  onStat?: (live: number) => void;
  idleExitMs?: number;
  statMs?: number;
  /** 시험 전용 — 토폴로지 대신 수명을 직접 준다. */
  lifetime?: HostLifetime;
  /**
   * 시험 전용 seam — attach 본체를 갈아끼운다. 기본은 제품 `attachSession`.
   *  살림(장부·마지막 소켓·유휴·회수)이 이 파일의 내용이고 attach 본체는 `terminal-pty` 의 내용이라,
   *  살림을 시험하려면 PTY 를 실제로 띄우지 않아야 한다. 코드베이스의 기존 규약과 같은 모양이다
   *  (`installAttachOwnedPids`·`installTenantSlugResolver` 도 같은 이유의 주입점이다).
   */
  attachImpl?: (sock: AttachSocket, id: string) => void;
}

const IDLE_EXIT_MS = 60_000; // 세션이 0이 된 뒤 이만큼 조용하면 나간다(워커 누적 방지). 새 attach 오면 취소.
const STAT_MS = 3_000;

/**
 * 이 프로세스가 소유한 attach 들의 살림.
 *
 * 한 인스턴스가 **여러 테넌트의 세션**을 동시에 볼 수 있다(오늘의 attach 워커가 이미 그렇다 —
 *  sticky 배치는 세션 id 기준이라 테넌트로 묶이지 않는다). 그래도 서로 안 섞이는 근거는 셋이고,
 *  `session-host-tenant-isolation.test.ts` 가 그 셋을 각각 못박는다:
 *   ① 세션 id 가 `box-<slug>-<8hex>` 로 **32비트 난수**를 달고 있어 테넌트 간에 같은 칸을 쓸 수 없다
 *      (`terminal-pty` 의 장부 `attachRefs`·`spawnFailStreak` 이 세션 id 키다).
 *   ② tmux argv 는 attach 시점에 **렉시컬로 붙잡혀** 유령 정리(`detach-client -s`)까지 그대로 간다 —
 *      나중에 다른 테넌트 컨텍스트에서 닫혀도 argv 가 바뀌지 않는다.
 *   ③ 테넌트 고정은 `AsyncLocalStorage`(`withTenant`)라 attach 의 비동기 체인 끝까지 따라간다.
 *  ⚠ 그래서 «테넌트당 프로세스 하나»가 격리를 위해 필요하지는 **않다**. 필요해지는 것은 이 셋 중
 *   하나라도 깨질 때다 — 그 셋이 시험으로 서 있는 이유가 그것이다.
 */
export class SessionHost {
  private readonly sessions = new Map<string, number>(); // 세션 id → 살아있는 소켓 수
  private readonly opts: SessionHostOptions;
  readonly lifetime: HostLifetime;
  private idleTimer: NodeJS.Timeout | null = null;
  private statTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(opts: SessionHostOptions = {}) {
    this.opts = opts;
    this.lifetime = opts.lifetime ?? lifetimeFor();
    if (opts.onStat) {
      this.statTimer = setInterval(() => opts.onStat?.(liveAttachCount()), opts.statMs ?? STAT_MS);
      this.statTimer.unref?.();
    }
  }

  /**
   * 소켓 하나를 이 프로세스가 소유한다 — 장부에 올리고 attach 본체를 돌린다.
   *
   * @param run 어댑터가 주는 컨텍스트 래퍼. fd 어댑터는 `withTenant(t, fn)`, WS 중계 어댑터는 그대로 실행.
   *            (이 모듈이 테넌시를 import 하지 않으려고 뒤집은 방향이다 — 머리말의 import 최소 규율.)
   *
   * @returns **false = 이 호스트가 거절했다**(종료 중 — 소켓은 이미 닫았다). 어댑터는 그때 «열렸다» 가
   *          아니라 실패를 알려야 한다. 안 그러면 종료 창(SIGTERM~exit 사이 수백 ms)에 들어온 채널이
   *          `opened` 를 받은 직후 `close` 를 받는다 — 게이트웨이가 «열렸다 끊겼다» 로 읽는다.
   *
   * ⚠ 장부 등록을 `attachSession` **보다 먼저** 한다. attach 가 서킷브레이커에 걸리면 그 안에서
   *  `ws.close()` 를 **동기로** 부르는데(스폰 반복 실패 쿨다운), 나중에 등록하면 그 close 를 놓쳐
   *  세션이 장부에 영원히 남는다(= 유휴 종료가 영영 안 걸린다).
   */
  attach(sock: AttachSocket, id: string, run: (fn: () => void) => void = (fn) => fn()): boolean {
    if (this.stopped) { try { sock.close(); } catch { /* noop */ } return false; }
    this.cancelIdleExit();
    this.sessions.set(id, (this.sessions.get(id) ?? 0) + 1);
    let closed = false;
    sock.on("close", () => {
      if (closed) return;   // 'close' 는 두 번 올 수 있다(어댑터에 따라) — 장부를 두 번 빼면 음수가 된다.
      closed = true;
      const n = (this.sessions.get(id) ?? 1) - 1;
      if (n > 0) { this.sessions.set(id, n); return; }
      this.sessions.delete(id);
      this.opts.onSessionEmpty?.(id);
      this.armIdleExit();
    });
    const impl = this.opts.attachImpl ?? attachSession;
    run(() => impl(sock, id));
    return true;
  }

  /**
   * 소켓이 **오는 중**이다 — 유휴 종료 타이머를 먼저 끈다.
   *
   * ⚠ `attach()` 안에도 같은 취소가 있는데 왜 따로 두나: 전송에 따라 «도착»과 «attach» 사이에 핸드셰이크가
   *  낀다(fd 이관은 `wss.handleUpgrade` 가 비동기다). 그 틈에 유휴 타이머가 만료하면 **막 도착한 소켓을
   *  손에 쥔 채 프로세스가 나간다.** 어댑터가 도착 시점에 이걸 불러 그 창을 닫는다(종전 워커 동작 그대로).
   */
  arriving(): void { this.cancelIdleExit(); }

  /**
   * 온다던 소켓이 **결국 안 왔다**(핸드셰이크 실패 등) — 껐던 유휴 대기를 되건다.
   *
   * ⚠ 이게 없으면 `arriving()` 과 `attach()` 사이에서 실패한 경우 **유휴 종료가 영영 안 걸린다**:
   *  타이머를 켜는 자리가 소켓의 close 핸들러뿐인데, attach 까지 못 갔으면 그 핸들러가 아예 없다.
   *  소켓 0 인 워커가 «안 죽는 워커» 로 남아 누적된다(종전 워커도 같은 구멍이 있었다 — 살림을 여기로
   *  모으면서 닫는다).
   */
  arrivalAborted(): void { this.armIdleExit(); }

  /** 이 호스트가 붙들고 있는 소켓 총수. */
  socketCount(): number { let n = 0; for (const v of this.sessions.values()) n += v; return n; }
  /** 지금 attach 가 하나라도 붙어 있는 세션 수. */
  sessionCount(): number { return this.sessions.size; }
  /** 이 세션에 붙어 있는 소켓 수(0 = 없음). */
  socketsFor(id: string): number { return this.sessions.get(id) ?? 0; }
  private armIdleExit(): void {
    if (this.lifetime === "resident" || !this.opts.onIdle) return; // 상주 호스트는 비어도 남는다
    if (this.idleTimer || this.socketCount() > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.socketCount() > 0) return; // 그새 붙었다
      this.opts.onIdle?.();
    }, this.opts.idleExitMs ?? IDLE_EXIT_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdleExit(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * 프로세스가 끝난다 — attach PTY 를 **전부** 회수한다(#687).
   *
   * ⚠ **회수 대상은 «이 인스턴스» 가 아니라 «이 프로세스» 다.** `killAttachedPtys()` 가 보는 장부
   *  (`terminal-pty` 의 `liveTerms`)는 모듈 전역이라, 한 프로세스에 `SessionHost` 가 둘 있으면 한쪽의
   *  shutdown 이 **다른 쪽 PTY 까지 죽인다**. 그래서 불변식은 «프로세스 하나에 세션 호스트 하나» 다 —
   *  두 어댑터 모두 모듈 최상위에 인스턴스 하나만 둔다. (시험은 여러 개를 만들지만 `attachImpl` 로
   *  본체를 갈아끼워 실제 PTY 를 안 띄우므로 이 장부를 건드리지 않는다.)
   *  #2600 T2 가 이 호스트를 테넌트마다 띄우려 한다면 **프로세스를 갈라야 한다**(같은 프로세스 안에
   *  인스턴스를 여럿 두면 안 된다) — 그 판단의 근거가 이 문단이다.
   *  안 죽이면 자식이 init(PPID 1)로 재부모화돼 PTY 를 영구 점유한다(관측된 고아 3천 개의 원인).
   *  멱등 — 시그널이 겹쳐 두 번 불려도 안전하다.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelIdleExit();
    if (this.statTimer) { clearInterval(this.statTimer); this.statTimer = null; }
    this.sessions.clear();
    try { killAttachedPtys(); } catch { /* noop */ }
  }
}

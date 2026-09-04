// 웹터미널 attach 워커 host — 게이트웨이 안에서 attach 워커 풀을 관리하고, 브라우저 소켓 fd 를 워커로
//  넘긴다. (#2228 1단계 · C안 + K 노브)
//
// ── 무엇을 하나 ───────────────────────────────────────────────────────────────
//  게이트웨이 upgrade 핸들러가 인증·테넌시·canAttach 를 **다 끝낸 뒤** 이 host 의 handoff() 를 부른다.
//  host 는 sticky 라우터(attach-router)로 세션→워커를 정하고 `child.send(msg, socket)` 로 **소켓 fd 자체를**
//  워커에 넘긴다. 그 순간부터 그 세션의 바이트는 워커 이벤트루프만 지나고 게이트웨이를 아예 안 건드린다.
//
// ── 안전(매니지드 blast radius 대응) ──────────────────────────────────────────
//  매니지드 게이트웨이(lvly-gw-central)는 컨테이너 하나를 전 테넌트가 공유한다. 그래서 이 경로는
//  **fail-open** 이다 — 워커가 없거나·포크 실패·핸드오프 실패면 handoff() 가 false 를 돌려주고, 호출부는
//  **지금까지의 게이트웨이 내부 attach 로 그대로 폴백**한다(소켓은 아직 게이트웨이 것이다). 즉 최악의
//  경우라도 «오늘 동작»으로 떨어질 뿐, attach 가 깨지지 않는다. 플래그(K)가 0/미설정이면 host 는 통째로
//  비활성이라 코드가 있기 전과 100% 동일하다.
//
//  실행 스위치 겸 노브: env `LIVELY_ATTACH_WORKER_K`
//    미설정/0/off = 비활성(오늘 동작) · 1 = 세션마다 워커(sshd 모델, 격리 최대) · N = 워커당 N세션 · inf = 워커 1개(B).
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TenantContext } from "../org/tenant-context.js";
import { installAttachOwnedPids, installAttachWorkerTally, detachGhostClientsForSession } from "./terminal-pty.js";
import { AttachRouter } from "./attach-router.js";
import { execTopology } from "../exec-topology.js";   // #2599 T2 — K 는 토폴로지가 이미 해석해 든다
import { logger } from "../log.js";

const ENTRY = fileURLToPath(new URL("./attach-worker-entry.js", import.meta.url));
const MAX_WORKERS = 64;      // 폭주 방지 상한 — 초과하면 fail-open(게이트웨이 내부 attach). 정상 운영에선 안 닿는다.
const STOP_GRACE_MS = 2_000; // shutdown 시 SIGTERM 뒤 SIGKILL 까지 유예.

interface HandoffInput {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  id: string;
  tenant: TenantContext | null;
}

interface Worker {
  pid: number;
  child: ChildProcess;
  live: number;       // 이 워커가 보고한 liveAttachCount(누수 지표 합산용)
  reaped: boolean;
}

/**
 * 시험 seam — 실제 워커를 포크하지 않고 **배선**을 검증하기 위한 주입점.
 *  코드베이스의 기존 규약과 같은 모양이다(`SessionHost.attachImpl`·`installAttachOwnedPids`).
 *  제품 경로는 기본값을 쓰므로 주입이 없으면 종전과 100% 동일하다.
 */
export interface AttachWorkerDeps {
  fork?: typeof fork;
  /** 유령 attach 정리(#3545) — 기본은 코어의 `detachGhostClientsForSession`. */
  detachGhosts?: (id: string, slug: string | null) => void;
}

export class AttachWorkerHost {
  private readonly k: number;
  private readonly router: AttachRouter;
  private readonly workers = new Map<number, Worker>();
  /**
   * 세션 id → 그 세션을 넘겨 준 테넌트 슬러그 (#3545).
   *  워커가 죽은 뒤 유령을 끊으려면 tmux argv 를 다시 지어야 하고, 그 유일한 입력이 슬러그다.
   *  ⚠ 이건 **정책이 아니라 기억**이다 — 판정(누구에게 보내나)은 여전히 라우터 하나가 소유한다.
   */
  private readonly sessionSlug = new Map<string, string | null>();
  /** 아직 안 내보낸 유령 정리 대상(#3545) — 한 틱 미뤘다가 «그새 다시 붙었나» 를 보고 내보낸다. */
  private readonly pendingDetach = new Set<string>();
  private detachTimer: NodeJS.Timeout | null = null;
  private readonly fork: typeof fork;
  private readonly detachGhosts: (id: string, slug: string | null) => void;

  constructor(k: number = execTopology().attachWorkerK, deps: AttachWorkerDeps = {}) {
    this.k = k;
    this.router = new AttachRouter(k);
    this.fork = deps.fork ?? fork;
    this.detachGhosts = deps.detachGhosts ?? detachGhostClientsForSession;
    // #687 누수 지표 무회귀 — 게이트웨이의 liveAttachCount()/scanAttachProcs() 가 워커로 옮겨간 attach 도
    //  «우리 것»으로 세도록 provider 를 꽂는다. 비활성(워커 0)일 땐 []·0 이라 오늘과 동일.
    installAttachOwnedPids(() => this.workerPids());
    installAttachWorkerTally(() => this.tally());
  }

  enabled(): boolean { return this.k > 0; }
  private workerPids(): number[] { return [...this.workers.keys()]; }
  private tally(): number { let n = 0; for (const w of this.workers.values()) n += w.live; return n; }
  private alivePids(): number[] { return [...this.workers.values()].filter((w) => !w.reaped).map((w) => w.pid); }

  /**
   * 소켓을 워커로 넘긴다. **true = 워커가 소유(호출부는 소켓을 더 만지면 안 된다)**, false = fail-open
   *  (호출부가 게이트웨이 내부 attach 로 폴백 — 소켓은 아직 게이트웨이 것이다).
   */
  async handoff(input: HandoffInput): Promise<boolean> {
    if (!this.enabled()) return false;
    //  ★ 불변식 3ᵍ — 이 세션이 이미 게이트웨이 소유면 **워커로 보내지 않는다.** 보내면 같은 세션의
    //   attach 가 두 프로세스로 갈리고, `attachRefs` 는 프로세스마다 따로라 양쪽이 «내가 마지막» 으로
    //   오판해 먼저 닫힌 쪽이 `detach-client -s` 로 **살아 있는 다른 화면을 끊는다**(#2148 실측 재현).
    if (this.router.isGatewayOwned(input.id)) return false;
    //  ★ #3545 — 넘기기 **전에** 기억한다. 핸드오프가 실패해 그 워커를 회수하는 갈래에서도 그 워커가
    //   이미 들고 있던 다른 세션들을 끊어야 하고, 그때 이 표가 유일한 슬러그 출처다.
    this.sessionSlug.set(input.id, input.tenant?.slug ?? null);
    const msg = {
      t: "attach" as const, id: input.id, tenant: input.tenant,
      method: input.req.method, url: input.req.url, headers: input.req.headers,
      head: input.head.length ? input.head.toString("base64") : "",
    };
    // 최대 2회: 골랐던 워커가 죽어 있으면(send 에러) 한 번 더 다른 워커로. 그래도 안 되면 fail-open.
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = this.acquire(input.id);
      if (!w) break; // 새 워커 필요한데 상한/포크실패 → fail-open
      const ok = await this.sendSocket(w, msg, input.socket);
      if (ok) return true;
      // send 실패 = 채널이 끊겼다 → 핸들이 전달되지 않았다(소켓은 아직 우리 것). 워커를 버리고 재시도.
      this.reap(w.pid, "send-failed");
    }
    //  폴백이 확정됐다 — 이 세션은 이제 **게이트웨이가 소유**한다(불변식 3ᵍ). 그 세션이 빌 때
    //   `releaseSession` 이 풀어 준다(게이트웨이 세션 호스트의 onSessionEmpty → 아래 releaseSession).
    this.router.claimForGateway(input.id);
    return false;
  }

  /**
   * 게이트웨이 인프로세스 attach 가 끝나 그 세션이 비었다 — 소유를 푼다.
   *  `terminal-pty-upgrade` 의 세션 호스트가 `onSessionEmpty` 로 부른다. 워커의 'session-empty' 와
   *  **같은 자리**로 들어온다(장부가 하나라 소유자가 누구든 푸는 문이 하나다).
   */
  releaseSession(id: string): void { this.router.releaseSession(id); this.sessionSlug.delete(id); }

  /** 이 세션을 받을 워커를 확보한다(sticky 재사용 또는 신규 포크). null = 상한/포크 실패 → fail-open. */
  private acquire(id: string): Worker | null {
    const place = this.router.pick(id, this.alivePids());
    if (place.worker !== null) {
      const w = this.workers.get(place.worker);
      if (w && !w.reaped) { this.router.assign(id, w.pid); return w; }
      // 라우터엔 있는데 실제로 없다(경합) — 매핑 떨구고 신규로.
      this.router.dropWorker(place.worker);
    }
    if (this.workers.size >= MAX_WORKERS) {
      logger.warn({ workers: this.workers.size }, "attach 워커 상한 도달 — fail-open(게이트웨이 내부 attach)");
      return null;
    }
    const w = this.spawn();
    if (!w) return null;
    this.router.assign(id, w.pid);
    return w;
  }

  private spawn(): Worker | null {
    try {
      // env 전부 상속 — 매니지드 relay(tmux-relay.cjs)가 LIVELY_TMUX_EXEC·LVLY_HUB_URL/SECRET·LANG 등을 읽는다.
      //  stdio: ipc 채널로 소켓 핸들을 넘긴다(fork 기본 IPC). stdout/stderr 는 게이트웨이 로그로 합류(inherit).
      const child = this.fork(ENTRY, [], { env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      if (!child.pid) { try { child.kill("SIGKILL"); } catch { /* noop */ } return null; }
      const w: Worker = { pid: child.pid, child, live: 0, reaped: false };
      this.workers.set(child.pid, w);
      child.on("message", (m: { t?: string; id?: string; live?: number }) => {
        if (!m) return;
        if (m.t === "stat") w.live = Number(m.live) || 0;
        //  ★ #3545 — **`this.router` 가 아니라 `this.releaseSession`** 이다. 라우터만 풀면 슬러그 기억
        //   (`sessionSlug`)이 영영 안 지워져 게이트웨이 수명 내내 쌓인다. 바로 위 주석이 말하는
        //   «푸는 문이 하나» 를 코드로도 하나로 둔다(변이 시험 M3 이 이 우회를 잡았다).
        else if (m.t === "session-empty" && m.id) this.releaseSession(m.id);
        // ready / idle-exit 는 별도 처리 불요(idle-exit 하면 곧 'exit' 이벤트가 정리한다).
      });
      child.on("exit", (code, sig) => { logger.info({ pid: w.pid, code, sig }, "attach 워커 종료"); this.reap(w.pid, "exit"); });
      child.on("error", (err) => { logger.warn({ pid: w.pid, err: err?.message }, "attach 워커 오류"); this.reap(w.pid, "error"); });
      logger.info({ pid: child.pid, k: this.k }, "attach 워커 포크");
      return w;
    } catch (e) {
      logger.warn({ err: (e as Error)?.message }, "attach 워커 포크 실패 — fail-open");
      return null;
    }
  }

  private sendSocket(w: Worker, msg: unknown, socket: Duplex): Promise<boolean> {
    return new Promise((resolve) => {
      try { w.child.send(msg as object, socket as unknown as import("node:net").Socket, (err) => resolve(!err)); }
      catch { resolve(false); }
    });
  }

  /** 워커를 장부에서 떼고(멱등) 그 세션 매핑을 전부 떨군다. 죽지 않았으면 kill. */
  private reap(pid: number, reason: string): void {
    const w = this.workers.get(pid);
    if (!w || w.reaped) return;
    w.reaped = true;
    const orphaned = this.router.dropWorker(pid);
    this.workers.delete(pid);
    try { w.child.kill("SIGKILL"); } catch { /* already gone */ }
    logger.info({ pid, reason, sessions: orphaned.length }, "attach 워커 회수");
    this.detachOrphanedSessions(orphaned);
  }

  /**
   * 워커가 통째로 사라졌다 — 그 워커가 쥐고 있던 세션들의 **남은 attach 클라이언트**를 끊는다 (#3545).
   *
   * ★ 왜 이 자리인가: 그 일을 하던 코드(`terminal-pty` 의 `cleanup` → `detachGhostClients`)는 **워커 안**
   *  이다. 워커가 SIGKILL·크래시로 죽으면 그 자리가 아예 안 돈다. 그리고 원격 tmux(매니지드 중계)에서는
   *  attach 클라이언트가 워커의 자식이 아니라 **샌드박스 안 프로세스**라 부모가 죽어도 같이 안 죽는다
   *  (#2625 실측 — gVisor 는 호스트 fd 닫힘을 안 전파한다). 그래서 «아무도 안 보는데 붙어 있는»
   *  클라이언트가 영구히 남고, 그 세션은 `session_attached>0` 이라 유휴 회수에서도 영영 빠진다(#2148).
   *  워커가 죽은 뒤 남아 있는 것은 게이트웨이뿐이므로, 끊는 손도 여기여야 한다.
   *
   *  ⓘ 로컬 tmux 배포(셀프호스트)에서는 attach 클라이언트가 워커의 **pty 자식**이라 워커와 함께 죽는다
   *   — 실측(2026-09-04, macOS): 워커 SIGKILL 뒤 `list-clients` 가 1초 안에 0 으로 수렴했다.
   *   그 배포에서 이 호출은 **끊을 대상이 없는 no-op** 이다(비치명·경고 없음).
   *
   * ⚠ `detach-client -s` 는 그 세션의 **모든** 클라이언트를 끊는다. 안전한 근거는 sticky 불변식이다 —
   *  한 세션의 attach 는 전부 한 소유자에게 모이므로(attach-router 불변식 1·3ᵍ), 그 소유자가 죽었으면
   *  살아 있는 화면이 없다. 다만 **죽자마자 같은 세션이 다시 붙는 창**은 실재한다 — `handoff` 의 재시도가
   *  바로 그 경로다(첫 워커 send 실패 → 회수 → 다음 워커로 재배정). 그래서 한 틱 미루고, 그 사이 누가
   *  그 세션을 다시 가져갔으면 건너뛴다. 재배정은 `acquire` 안에서 **동기로** 끝나므로 이 한 틱이면 족하다.
   */
  private detachOrphanedSessions(ids: readonly string[]): void {
    if (!ids.length) return;
    for (const id of ids) this.pendingDetach.add(id);
    if (this.detachTimer) return;
    //  unref — 이 타이머 하나 때문에 게이트웨이가 안 죽으면 안 된다. 대신 **종료 경로가 직접 흘린다**
    //   (`shutdown()` 끝). `index.ts` 는 `shutdownAttachWorkers()` 가 끝나자마자 `process.exit` 을 부르므로
    //   타이머에 맡기면 **재배포·롤에서 한 건도 안 나간다** — #2625 §4 가 지목한 바로 그 누수 창이다.
    this.detachTimer = setTimeout(() => { this.detachTimer = null; this.flushGhostDetach(); }, 0);
    this.detachTimer.unref?.();
  }

  /** 미뤄 둔 유령 정리를 **지금** 내보낸다(멱등). 타이머와 종료 경로가 같은 자리로 들어온다. */
  private flushGhostDetach(): void {
    if (this.detachTimer) { clearTimeout(this.detachTimer); this.detachTimer = null; }
    if (!this.pendingDetach.size) return;
    const ids = [...this.pendingDetach];
    this.pendingDetach.clear();
    for (const id of ids) {
      // 그새 다른 워커·게이트웨이가 이 세션을 다시 가져갔다 → 살아 있는 화면이다. 유령이 아니다.
      //  (그 세션의 옛 유령은 새 attach 가 닫힐 때 평소 경로 `cleanup → detachGhostClients` 가 걷는다.)
      if (this.router.workerForSession(id) !== undefined || this.router.isGatewayOwned(id)) continue;
      const slug = this.sessionSlug.get(id) ?? null;
      this.sessionSlug.delete(id);
      logger.info({ id, tenant: slug ?? "" }, "워커가 먼저 죽었다 — 남은 attach 클라이언트 정리");
      try { this.detachGhosts(id, slug); } catch (e) {
        logger.warn({ id, err: (e as Error)?.message }, "유령 attach 정리 호출 실패");
      }
    }
  }

  /** 게이트웨이 종료 시(재배포 SIGTERM·크래시) — 모든 워커를 회수한다. 워커는 SIGTERM 에 killAttachedPtys 후 나간다. */
  async shutdown(): Promise<void> {
    const workers = [...this.workers.values()];
    if (!workers.length) return;
    for (const w of workers) { try { w.child.kill("SIGTERM"); } catch { /* noop */ } }
    await new Promise<void>((resolve) => {
      let left = workers.length;
      const done = () => { if (--left <= 0) resolve(); };
      const t = setTimeout(() => { for (const w of workers) { try { w.child.kill("SIGKILL"); } catch { /* noop */ } } resolve(); }, STOP_GRACE_MS);
      if (t.unref) t.unref();
      for (const w of workers) w.child.once("exit", done);
    });
    for (const w of workers) this.reap(w.pid, "shutdown");
    //  ★ 여기서 **직접** 흘린다 — 곧 `process.exit` 이라 타이머는 못 돈다(위 detachOrphanedSessions 주석).
    //   `detach-client` 자식은 execFile 이 동기로 스폰하므로 게이트웨이가 나간 뒤에도 명령은 나간다.
    this.flushGhostDetach();
  }

  /** 진단용. */
  stats(): { enabled: boolean; k: number; workers: number; sessions: number; tally: number; slugs: number } {
    //  `slugs` 는 «세션 → 테넌트» 기억(#3545)의 크기다. 정상이면 `sessions` 와 같이 움직인다 —
    //   이 값만 단조증가하면 어딘가 «푸는 문» 을 우회하는 경로가 생긴 것이다.
    return { enabled: this.enabled(), k: this.k, workers: this.workers.size, sessions: this.router.totalSessions(), tally: this.tally(), slugs: this.sessionSlug.size };
  }
}

/** 게이트웨이 싱글턴. 모듈 로드 시 env 로 K 를 굳히고 누수-지표 provider 를 꽂는다(비활성이면 무해). */
export const attachWorkerHost = new AttachWorkerHost();

/** 시그널 핸들러(index.ts)가 부른다 — attach 워커 일괄 회수. */
export async function shutdownAttachWorkers(): Promise<void> { await attachWorkerHost.shutdown(); }

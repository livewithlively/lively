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
import { installAttachOwnedPids, installAttachWorkerTally } from "./terminal-pty.js";
import { AttachRouter, parseWorkerK } from "./attach-router.js";
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

export class AttachWorkerHost {
  private readonly k: number;
  private readonly router: AttachRouter;
  private readonly workers = new Map<number, Worker>();

  constructor(k: number = parseWorkerK(process.env.LIVELY_ATTACH_WORKER_K)) {
    this.k = k;
    this.router = new AttachRouter(k);
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
    return false;
  }

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
      const child = fork(ENTRY, [], { env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      if (!child.pid) { try { child.kill("SIGKILL"); } catch { /* noop */ } return null; }
      const w: Worker = { pid: child.pid, child, live: 0, reaped: false };
      this.workers.set(child.pid, w);
      child.on("message", (m: { t?: string; id?: string; live?: number }) => {
        if (!m) return;
        if (m.t === "stat") w.live = Number(m.live) || 0;
        else if (m.t === "session-empty" && m.id) this.router.releaseSession(m.id);
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
    this.router.dropWorker(pid);
    this.workers.delete(pid);
    try { w.child.kill("SIGKILL"); } catch { /* already gone */ }
    logger.info({ pid, reason }, "attach 워커 회수");
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
  }

  /** 진단용. */
  stats(): { enabled: boolean; k: number; workers: number; sessions: number; tally: number } {
    return { enabled: this.enabled(), k: this.k, workers: this.workers.size, sessions: this.router.totalSessions(), tally: this.tally() };
  }
}

/** 게이트웨이 싱글턴. 모듈 로드 시 env 로 K 를 굳히고 누수-지표 provider 를 꽂는다(비활성이면 무해). */
export const attachWorkerHost = new AttachWorkerHost();

/** 시그널 핸들러(index.ts)가 부른다 — attach 워커 일괄 회수. */
export async function shutdownAttachWorkers(): Promise<void> { await attachWorkerHost.shutdown(); }

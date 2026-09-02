// 웹터미널 attach 워커 — 게이트웨이가 넘긴 소켓 fd 위에서 WS 핸드셰이크를 마치고 **제품 attachSession 을
//  그대로** 돈다. (#2228 1단계 · C안) 이 프로세스의 존재 이유는 단 하나: **이벤트루프에 attach 말고
//  아무 일도 없게** 하는 것이다(게이트웨이의 스케줄러·HTTP·동기 파일 I/O 와 격리 — 0단계에서 그게
//  꼬리 지연의 진짜 원인으로 실측됐다. knowledge: webterm-fd-handoff-phase0-effect-2554).
//
// ⚠ **여기서 import 하는 것을 최소로 유지하라.** 앱(index)·DB·스케줄러를 끌어오면 격리 취지가 무너진다.
//  정책 판정(canAttach·테넌시·티켓)은 전부 게이트웨이가 이미 끝냈다 — 워커는 소켓을 받아 attach 만 한다.
//
// 배선: 게이트웨이(attach-worker-host)가 `child.send({t:"attach",...}, socket)` 로 fd 를 넘긴다.
//  워커는 그 소켓으로 handleUpgrade → (테넌트 컨텍스트 고정) → attachSession. 바이트는 이 프로세스만
//  지나고 게이트웨이 이벤트루프를 아예 건드리지 않는다(C안의 핵심).
import { WebSocketServer } from "ws";
import type { AttachSocket } from "./terminal-pty.js";
import { attachSession, killAttachedPtys, liveAttachCount } from "./terminal-pty.js";
import { withTenant, type TenantContext } from "../org/tenant-context.js";
import { currentTenant } from "../org/tenant-context.js";
import { installTenantSlugResolver } from "./catalog.js";
import { logger } from "../log.js";

// ★ tmuxExecArgv()(attachSession 안)는 tenantSlug()=currentTenant()?.slug 를 읽어 실행 대상을 고른다
//   (셀프호스트 primary=로컬 tmux · registry secondary=`-L lvly-<slug>` · 매니지드=중계 relay).
//   게이트웨이는 부팅 배선(tenant-binding-boot)에서 이 resolver 를 꽂지만, 워커는 별 프로세스라 안 꽂혀
//   있다 → **여기서 직접 꽂는다.** 그러면 아래 withTenant 로 고정한 컨텍스트를 tmuxExecArgv 가 본다.
installTenantSlugResolver(() => currentTenant()?.slug ?? null);

process.title = "lively-attach-worker";

interface AttachMsg {
  t: "attach";
  id: string;
  tenant: TenantContext | null; // 게이트웨이가 판정한 테넌트({id,slug}) 또는 null(단일 테넌트)
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  head?: string; // base64
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 }); // 게이트웨이 wss 와 같은 설정
const HEARTBEAT_MS = 30_000;
const IDLE_EXIT_MS = 60_000; // 세션이 0이 된 뒤 이만큼 조용하면 스스로 나간다(워커 누적 방지). 새 attach 오면 취소.

const sessionCount = new Map<string, number>(); // 세션별 살아있는 WS 수(host 슬롯 해제 통지용 — attachRefs 와 별개)
let idleTimer: NodeJS.Timeout | null = null;

function totalSockets(): number { let n = 0; for (const v of sessionCount.values()) n += v; return n; }

function armIdleExit(): void {
  if (idleTimer) return;
  if (totalSockets() > 0) return;
  idleTimer = setTimeout(() => {
    if (totalSockets() > 0) { idleTimer = null; return; } // 그새 붙었다
    try { process.send?.({ t: "idle-exit" }); } catch { /* noop */ }
    shutdown(0);
  }, IDLE_EXIT_MS);
  if (idleTimer.unref) idleTimer.unref();
}
function cancelIdleExit(): void { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

// WS liveness heartbeat(#687 과 같은 규약) — 반쯤 끊긴 소켓을 주기적으로 terminate 해 PTY 를 회수한다.
type LiveWS = { isAlive?: boolean; terminate: () => void; ping: () => void };
const heartbeat = setInterval(() => {
  for (const ws of wss.clients as Set<unknown> as Set<LiveWS>) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* noop */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

// 상태 보고(#687 누수 지표 무회귀) — 게이트웨이가 워커별 liveAttachCount 를 합산해 PTY 경보 장부를 유지한다.
const stat = setInterval(() => { try { process.send?.({ t: "stat", live: liveAttachCount() }); } catch { /* noop */ } }, 3_000);
if (stat.unref) stat.unref();

process.on("message", (m: AttachMsg, handle) => {
  if (!m || m.t !== "attach") return;
  const socket = handle as import("node:net").Socket | undefined;
  if (!socket) { logger.warn({ id: m?.id }, "attach 워커: 소켓 핸들 없이 도착 — 무시"); return; }
  cancelIdleExit();
  const req = { method: m.method, url: m.url, headers: m.headers } as import("node:http").IncomingMessage;
  const head = m.head ? Buffer.from(m.head, "base64") : Buffer.alloc(0);
  const run = () => wss.handleUpgrade(req, socket, head, (ws) => {
    // 세션별 카운트 — 마지막 WS 가 닫히면 host 에 슬롯 해제를 알린다(sticky 매핑 해제 근거).
    sessionCount.set(m.id, (sessionCount.get(m.id) ?? 0) + 1);
    ws.once("close", () => {
      const n = (sessionCount.get(m.id) ?? 1) - 1;
      if (n > 0) { sessionCount.set(m.id, n); return; }
      sessionCount.delete(m.id);
      try { process.send?.({ t: "session-empty", id: m.id }); } catch { /* noop */ }
      armIdleExit();
    });
    // ★ 테넌트 컨텍스트 고정 후 제품 attachSession — 안에서 tmuxExecArgv 가 이 컨텍스트로 실행 대상을 고른다.
    if (m.tenant) withTenant(m.tenant, () => attachSession(ws as unknown as AttachSocket, m.id));
    else attachSession(ws as unknown as AttachSocket, m.id);
  });
  try { run(); }
  catch (e) { logger.warn({ err: (e as Error)?.message, id: m.id }, "attach 워커: handleUpgrade 실패"); try { socket.destroy(); } catch { /* noop */ } }
});

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat); clearInterval(stat); cancelIdleExit();
  try { killAttachedPtys(); } catch { /* noop */ } // 이 워커가 띄운 attach PTY 를 전부 kill(#687 — 고아 방지)
  setTimeout(() => process.exit(code), 200).unref();
}

// 게이트웨이가 SIGTERM/채널 종료로 회수 → PTY 정리 후 나간다. 안 하면 attach 자식이 init 로 재부모화돼 PTY 를 흘린다.
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("disconnect", () => shutdown(0)); // 부모(게이트웨이) IPC 채널이 끊기면 곧 고아다 — 스스로 정리.

try { process.send?.({ t: "ready", pid: process.pid }); } catch { /* noop */ }
logger.info({ pid: process.pid }, "attach 워커 기동");

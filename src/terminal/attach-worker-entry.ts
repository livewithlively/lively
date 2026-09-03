// 웹터미널 attach 워커 — **fd 이관 전송 어댑터** (#2228 1단계 · C안 / #2600 T1 에서 전송만 남겼다).
//
// 이 프로세스의 존재 이유는 단 하나: **이벤트루프에 attach 말고 아무 일도 없게** 하는 것이다
//  (게이트웨이의 스케줄러·HTTP·동기 파일 I/O 와 격리 — 0단계에서 그게 꼬리 지연의 진짜 원인으로
//  실측됐다. knowledge: webterm-fd-handoff-phase0-effect-2554).
//
// ── 이 파일이 하는 일은 전송뿐이다 (#2600 T1) ────────────────────────────────
//  받는 방법(게이트웨이가 `child.send(msg, socket)` 로 넘긴 **소켓 fd** 위에서 WS 핸드셰이크를 마치는 것)
//  까지가 여기고, 그 뒤 «이 프로세스가 attach 를 소유한다»는 살림 — 세션별 소켓 장부·마지막 소켓 통지·
//  유휴 자진 종료·종료 시 PTY 회수 — 은 전부 `session-host.ts` 에 있다. 노드 에이전트(WS 중계 어댑터)가
//  **같은 모듈**을 쓴다. 종전엔 그 살림이 두 파일에 각각 적혀 있었다.
//
// ⚠ **여기서 import 하는 것을 최소로 유지하라.** 앱(index)·DB·스케줄러를 끌어오면 격리 취지가 무너진다.
//  정책 판정(canAttach·테넌시·티켓)은 전부 게이트웨이가 이미 끝냈다 — 워커는 소켓을 받아 attach 만 한다.
//  같은 이유로 세션 **op** 층(`session-ops.ts`)도 여기선 안 쓴다: fd 이관은 소켓을 나르지 명령을 나르지 않는다.
import { WebSocketServer } from "ws";
import type { AttachSocket } from "./terminal-pty.js";
import { SessionHost } from "./session-host.js";
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

// 세션 호스트 — 수명(유휴 종료 여부)은 **토폴로지가 정한다**(#2599 T2). 이 프로세스는 게이트웨이 박스에서
//  도는 일시 호스트라 `ephemeral` 로 파생돼 유휴 자진 종료가 걸린다. 노드 데몬은 같은 모듈이 `resident` 로
//  파생돼 안 걸린다 — 종전엔 그 차이가 «워커에만 IDLE_EXIT_MS 가 있다»는 형태로만 존재했다.
const host = new SessionHost({
  onSessionEmpty: (id) => { try { process.send?.({ t: "session-empty", id }); } catch { /* noop */ } },
  onIdle: () => { try { process.send?.({ t: "idle-exit" }); } catch { /* noop */ } shutdown(0); },
  onStat: (live) => { try { process.send?.({ t: "stat", live }); } catch { /* noop */ } },
});

// WS liveness heartbeat(#687 과 같은 규약) — 반쯤 끊긴 소켓을 주기적으로 terminate 해 PTY 를 회수한다.
//  ⚠ 전송 계층이라 여기 남는다: `wss.clients` 는 이 어댑터가 쓰는 ws 라이브러리의 것이고, WS 중계
//   어댑터(노드)는 자기 링크 생존 감시(link-liveness)를 따로 갖는다.
type LiveWS = { isAlive?: boolean; terminate: () => void; ping: () => void };
const heartbeat = setInterval(() => {
  for (const ws of wss.clients as Set<unknown> as Set<LiveWS>) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* noop */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, HEARTBEAT_MS);
if (heartbeat.unref) heartbeat.unref();

// ⚠ **남아 있는 좁은 구멍 하나 — 알고 남긴다.** `wss.handleUpgrade` 는 어떤 잘못된 업그레이드에 대해
//  **던지지도 않고 콜백도 안 부른 채** 내부에서 소켓을 정리할 수 있다(ws 의 문서화된 동작). 그러면
//  아래 `arriving()` 으로 끈 유휴 대기가 `attach()` 로도 `arrivalAborted()` 로도 되걸리지 않는다.
//  ① 게이트웨이가 이미 같은 요청으로 핸드셰이크 판정을 끝내고 fd 를 넘긴 것이라 실질적으로 닿기 어렵고
//  ② 닿아도 결과는 «워커 하나가 스스로 안 물러난다» 뿐이다(상한 MAX_WORKERS=64 로 막혀 있고, 그 워커는
//     정상 동작하며 다음 attach→close 한 번이면 다시 걸린다).
//  그래서 감시 타이머를 새로 두지 않았다 — 그 타이머 자체가 또 하나의 «아무도 안 읽는 판정» 이 된다.
//  이 문단은 «못 봤다» 가 아니라 «보고 안 막았다» 는 기록이다(리뷰 지적, 2026-09-03).
process.on("message", (m: AttachMsg, handle) => {
  if (!m || m.t !== "attach") return;
  const socket = handle as import("node:net").Socket | undefined;
  if (!socket) { logger.warn({ id: m?.id }, "attach 워커: 소켓 핸들 없이 도착 — 무시"); return; }
  host.arriving();   // 핸드셰이크 전에 유휴 종료를 끈다(종전 cancelIdleExit 자리 그대로 — session-host 머리말)
  const req = { method: m.method, url: m.url, headers: m.headers } as import("node:http").IncomingMessage;
  const head = m.head ? Buffer.from(m.head, "base64") : Buffer.alloc(0);
  // ★ 테넌트 컨텍스트 고정은 **세션 호스트에 실어 준다**(호스트는 테넌시를 import 하지 않는다 —
  //   그 규율이 노드 번들과 워커의 무게를 동시에 지킨다). 안에서 tmuxExecArgv 가 이 컨텍스트로 실행 대상을 고른다.
  //   ⚠ `as TenantContext` 는 클로저 안에서 `m.tenant` 의 null 좁히기가 유지되지 않아 붙인 것이다
  //    (바로 위 삼항이 이미 non-null 을 보장한다) — 값을 바꾸는 캐스트가 아니다.
  const run = m.tenant
    ? (fn: () => void) => { withTenant(m.tenant as TenantContext, fn); }
    : (fn: () => void) => { fn(); };
  const go = () => wss.handleUpgrade(req, socket, head, (ws) => {
    host.attach(ws as unknown as AttachSocket, m.id, run);
  });
  try { go(); }
  catch (e) {
    logger.warn({ err: (e as Error)?.message, id: m.id }, "attach 워커: handleUpgrade 실패");
    try { socket.destroy(); } catch { /* noop */ }
    // 온다던 소켓이 결국 안 왔다 → 위에서 껐던 유휴 대기를 되건다. 안 그러면 이 워커는 소켓 0 인 채
    //  «안 죽는 워커» 로 남는다(세션 호스트의 arrivalAborted 머리말).
    host.arrivalAborted();
  }
});

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  host.shutdown();   // 이 워커가 띄운 attach PTY 를 전부 kill(#687 — 고아 방지)
  setTimeout(() => process.exit(code), 200).unref();
}

// 게이트웨이가 SIGTERM/채널 종료로 회수 → PTY 정리 후 나간다. 안 하면 attach 자식이 init 로 재부모화돼 PTY 를 흘린다.
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("disconnect", () => shutdown(0)); // 부모(게이트웨이) IPC 채널이 끊기면 곧 고아다 — 스스로 정리.

try { process.send?.({ t: "ready", pid: process.pid }); } catch { /* noop */ }
logger.info({ pid: process.pid, lifetime: host.lifetime }, "attach 워커 기동");

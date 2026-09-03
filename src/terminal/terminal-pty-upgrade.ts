// 웹터미널 WS **업그레이드 핸들러** — 게이트웨이 전용 (#2165 에서 terminal-pty.ts 에서 분리).
//
// 왜 갈랐나: 이 핸들러만 테넌시를 안다(`resolveTenantFromHeaders`·`withTenant`·`workspaceForSession`).
//  그런데 노드 에이전트는 같은 파일의 `attachSession`·`killAttachedPtys` 를 쓴다 — 한 모듈에 있는 동안엔
//  노드가 attach 를 쓰는 것만으로 `org/tenant-context`·`org/tenancy/registry`·`db/{client,tenant-column}` 이
//  노드 번들에 실렸다. **노드엔 DB 도, 테넌트 개념도 없다**(노드는 자기 tmux 하나만 본다).
//
// ⚠ 여기 있는 코드는 브라우저 ↔ 게이트웨이 업그레이드 경로다. 노드 세션의 attach 는 이 핸들러가 정책을 판정한 뒤
//  `nodeRelayAttach` 로 릴레이하고, **노드 쪽에서 실제 pty 를 여는 것은 `attachSession`**(terminal-pty.ts)이다.
//  즉 이 파일은 게이트웨이에만, 그 파일은 양쪽에 필요하다 — 그게 이 분리의 근거다.
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { logger } from "../log.js";
import { resolveTenantFromHeaders, withTenant, type TenantContext } from "../org/tenant-context.js";
import { attachWorkerHost } from "./attach-worker-host.js";
import { canAttach, sessionGone, ensureSessionOpts } from "./terminal-sessions.js";
import { nodeCanAttach, nodeRelayAttach, isSelfNode } from "../node/registry.js";
import { relayNodeId } from "../node/self-node.js";   // #2592 — 셀프 노드 좌표는 릴레이 지시가 아니다
import { attachSession, reapOrphanAttachClients, attachClose,
  type AttachSocket, type TicketLookup } from "./terminal-pty.js";

const HEARTBEAT_MS = 30_000;              // 이 주기로 ping — 직전 주기에 pong 이 없던 소켓은 죽은 것으로 보고 terminate.
type LiveWS = WebSocket & { isAlive?: boolean };
let heartbeat: NodeJS.Timeout | null = null;

// WS liveness heartbeat(#687) — 반쯤 끊긴 attach 소켓을 주기적으로 걸러 terminate 한다. terminate 는 'close' 를
//  발생시켜 기존 cleanup(term.kill)이 돌게 하므로 PTY 가 정상 회수된다(=탭 정상 종료와 동일 경로). 게이트웨이가
//  프로세스 정상 종료하는 걸 막지 않도록 unref. 멱등(중복 호출 무시).
export function startHeartbeat(): void {   // #2165 — 업그레이드 핸들러(terminal-pty-upgrade.ts)가 쓴다
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<LiveWS>) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* noop */ } continue; } // 직전 주기에 pong 없음 = 죽음
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
}

//  이 서버는 업그레이드 핸들러만 쓴다(noServer — 소켓을 직접 넘겨받는다).
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

//  브라우저 WebSocket 을 attach 본체(양쪽 공용)에 넘기는 얇은 어댑터.
function attach(ws: WebSocket, id: string): void {
  attachSession(ws as unknown as AttachSocket, id);
}

export function setupPtyUpgrade(server: Server, lookupTicket: TicketLookup): void {
  startHeartbeat();                     // 죽은 attach 소켓 주기 회수(#687)
  void reapOrphanAttachClients();       // 이전 인스턴스가 남긴 고아 attach 회수(#687) — best-effort·비동기
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
    if (url.pathname !== "/terminal/ws") return; // 다른 업그레이드(있다면)는 미관여
    // ★★ 업그레이드는 Express 미들웨어를 **안 탄다** — 테넌트 컨텍스트(tenant-middleware)가 여기엔 없다.
    //  요청별 테넌시 배포에서 컨텍스트 없이 canAttach 를 부르면 tmux 중계·DB 조회가 "컨텍스트 밖"으로
    //  죽고, 그 실패가 4403 으로 접혀 **소유자 본인이 무한 '연결 확인중'** 이 된다(실측 2026-08-18).
    //  같은 헤더·같은 비밀로 여기서 직접 연다. 거절 사유면 소켓을 닫는다(비밀 불일치 = 배선 문제).
    const tr = resolveTenantFromHeaders(req.headers as Record<string, string | string[] | undefined>, process.env);
    if (!tr.ok && tr.reason !== "disabled") { socket.destroy(); return; }
    // registry(#1750 후속) — 셀프호스트 다중 워크스페이스. 브라우저 WS URL 은 커스텀 헤더를 못 실으므로
    //  **세션 정본(gw_session_map)** 으로 소속을 되찾는다: 맵에 있으면 그 워크스페이스, 없으면 primary(종전).
    //  이게 없으면 secondary 세션 attach 가 primary 컨텍스트로 돌아 기본 tmux 소켓을 뒤지고 4410(가짜
    //  '세션 없음')이 된다 — 세션은 lvly-<slug> 소켓에 살아 있는데.
    const registrySessionCtx = async (): Promise<{ id: string; slug: string } | null> => {
      if (tr.ok || (process.env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() !== "registry") return null;
      const sid = url.searchParams.get("session") || "";
      if (!sid) return null;
      const { workspaceForSession } = await import("../org/tenancy/registry.js");
      const w = await workspaceForSession(sid).catch(() => null);
      return w ? { id: w.id, slug: w.slug } : null;
    };
    void (async () => {
      const regCtx = await registrySessionCtx();
      const inTenant = <T>(fn: () => T): T => (tr.ok ? withTenant(tr.tenant, fn) : regCtx ? withTenant(regCtx, fn) : fn());
      return inTenant(() => (async () => {
      const tk = lookupTicket(req.headers.cookie);
      if (!tk) { socket.destroy(); return; }
      const id = url.searchParams.get("session") || "";
      // 노드 세션(#869) — ?node=<id> 면 그 노드의 아웃바운드 채널로 릴레이한다. 정책(가시성)은 여기(게이트웨이)서
      //  판정하고 노드는 기계적으로 attach 만 실행(F7). 거부 사유는 로컬과 같은 코드 체계(4410/4403)+4462(노드 오프라인).
      //  ⚠ #2592 — 셀프 노드 좌표(`?node=<게이트웨이 자신>`)는 여기서 **버린다**. 남겨 두면 같은 tmux 를 노드 WS 로
      //   한 바퀴 돌아 attach 하게 되는데(노드 데몬이 `tmux -CC attach` 로 서빙), 그 한 바퀴가 부팅 직후 4462 거부와
      //   3초 스냅샷 지연을 만든다. 좌표를 접으면 아래 중앙 경로로 그대로 흘러 같은 세션에 즉답으로 붙는다.
      //   (구 화면·열려 있던 탭이 옛 좌표를 들고 다시 붙어도 이 자리에서 정정된다.)
      const nodeId = relayNodeId(url.searchParams.get("node"), isSelfNode);
      if (nodeId) {
        const verdict = await nodeCanAttach(nodeId, id, tk.userId);
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!verdict.ok) {
            logger.info({ nodeId, id, userId: tk.userId, code: verdict.code }, "ws 노드 attach 거부");
            try { ws.close(verdict.code, verdict.reason); } catch { /* noop */ }
            return;
          }
          nodeRelayAttach(nodeId, id, ws);
        });
        return;
      }
      const ok = await canAttach(id, tk.userId).catch(() => false);
      // ⚠ 권한이 있어도 **세션이 살아 있는지 따로 봐야 한다**(2026-08-26 실측 신고).
      //  canAttach → ownerMeta 는 **DB desired-state 우선**이라(sessions.ts) tmux 에서 이미 죽은 세션도
      //  권한을 통과시킨다. 그래서 종전엔 `!ok` 일 때만 생사를 확인했고, 죽은 세션에 붙으러 온 클라는
      //  **종료 확답을 못 받았다** — attach 를 시도하다 tmux 의 "can't find session" 한 줄이 화면에
      //  찍히고, 클라는 이유를 모른 채 **영원히 재연결**했다(새로고침해야 '열기=복원' 경로 #1820 으로 살아났다).
      //  4410 을 주면 클라가 그 자리에서 복원으로 넘어간다(onSessionGone) — 그게 의도한 경험이다.
      //  비용은 attach 당 has-session 1회다. 살아 있는 세션엔 즉답이고, 죽은 세션엔 재연결 폭풍을 멈추므로
      //  오히려 왕복이 준다. 판정 불가(#835)는 여전히 false — 모르면 살아있다고 보고 종전 경로로 간다.
      const gone = await sessionGone(id).catch(() => false);
      const close = attachClose(ok, gone);
      if (close) {
        // 거부를 조용히 끊으면(socket.destroy) 클라가 영원히 재연결한다 → WS 핸드셰이크만 완료한 뒤 '이유가 담긴 코드'로
        //  닫아 terminal.js 가 사용자에게 정확한 문구를 띄우게 한다. 이유는 둘이고 클라 동작이 갈린다(#835):
        //   4410 session-gone — tmux 가 '그런 세션 없다'고 확답 → 세션이 진짜 끝남 → 클라는 재연결을 멈추고 '종료됨'을 명시.
        //   4403 no-access    — 권한 없음, 또는 판정 불가(tmux 과부하·타임아웃 = #687 의 '가짜 4403') → 클라는 몇 번 더 재시도.
        //  판정 불가를 gone 으로 넘기지 않는 게 핵심 — 살아있는 세션을 '종료됨'으로 오인하는 건 재연결 반복보다 나쁘다.
        logger.info({ id, userId: tk.userId, ok, gone }, gone ? "ws attach 거부(세션이 종료됨)" : "ws attach 거부(접근권 없음 또는 세션-프로젝트 불일치)");
        wss.handleUpgrade(req, socket, head, (ws) => {
          try { ws.close(close.code, close.reason); } catch { /* noop */ }
        });
        return;
      }
      await ensureSessionOpts(id).catch(() => { /* 비치명 */ });
      // ── C안(#2228): 인증·canAttach 가 끝난 여기서 소켓 fd 를 attach 워커로 넘긴다. 넘어가면 바이트가
      //  게이트웨이 이벤트루프를 아예 안 지난다. 워커가 판정(테넌시)을 다시 하지 않도록 여기서 정한 테넌트
      //  컨텍스트를 실어 보낸다(워커의 tmuxExecArgv 가 그 컨텍스트로 로컬 tmux/registry/-L/매니지드 중계를 고른다).
      //  ★ fail-open: handoff 가 false(비활성·상한·포크/핸드오프 실패)면 아래 게이트웨이 내부 attach 로 폴백 —
      //   최악의 경우라도 «오늘 동작»이지 attach 가 깨지지 않는다(매니지드 공유 게이트웨이 blast radius 대응).
      const tenantForWorker: TenantContext | null = tr.ok ? tr.tenant : (regCtx ?? null);
      if (attachWorkerHost.enabled()) {
        const handed = await attachWorkerHost.handoff({ req, socket, head, id, tenant: tenantForWorker });
        if (handed) return; // 워커가 소켓을 소유 — 게이트웨이는 이 연결에서 손을 뗀다
      }
      wss.handleUpgrade(req, socket, head, (ws) => inTenant(() => attach(ws, id)));
      })());
    })();
  });
}
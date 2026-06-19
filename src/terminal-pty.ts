// 중앙 박스 — WebSocket ↔ node-pty 브리지. /terminal/ws?session=<id> 업그레이드를 받아
// ticket 쿠키(userId 보유)로 인증 + 세션 소유권 확인 후, node-pty 로 `tmux attach -t <id>` 를 스폰해
// 브라우저 xterm.js 와 양방향 연결. ws 종료 = attach 클라만 종료(tmux 세션은 영속). 셸 미경유(argv).
import { WebSocketServer, type WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "./log.js";
import { TMUX_BIN, sessionOwner, sessionDir } from "./terminal-sessions.js";

export type TicketLookup = (cookieHeader?: string) => { userId: string } | null;

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

export function setupPtyUpgrade(server: Server, lookupTicket: TicketLookup): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
    if (url.pathname !== "/terminal/ws") return; // 다른 업그레이드(있다면)는 미관여
    void (async () => {
      const tk = lookupTicket(req.headers.cookie);
      if (!tk) { socket.destroy(); return; }
      const id = url.searchParams.get("session") || "";
      const owner = await sessionOwner(id).catch(() => null);
      if (!owner || owner !== tk.userId) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, id));
    })();
  });
}

function attach(ws: WebSocket, id: string): void {
  let term: IPty | undefined;
  sessionDir(id)
    .then((cwd) => {
      term = ptySpawn(TMUX_BIN, ["attach", "-t", id], {
        name: "xterm-256color", cols: 80, rows: 24, cwd,
        env: process.env as Record<string, string>,
      });
      term.onData((d) => { try { ws.send(d); } catch { /* socket closed */ } });
      term.onExit(() => { try { ws.close(); } catch { /* already closed */ } });
      ws.on("message", (raw) => {
        let msg: { t?: string; d?: unknown; c?: unknown; r?: unknown };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === "i" && typeof msg.d === "string") term?.write(msg.d);
        else if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
          try { term?.resize(Math.max(1, msg.c as number), Math.max(1, msg.r as number)); } catch { /* race on close */ }
        }
      });
      const cleanup = () => { try { term?.kill(); } catch { /* already gone */ } };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    })
    .catch((err) => { logger.warn({ err, id }, "pty attach 실패"); try { ws.close(); } catch { /* noop */ } });
}

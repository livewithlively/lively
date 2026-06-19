// 중앙 박스 도그푸드 — ttyd 터미널을 정문(:8080) 뒤로 forward-proxy.
// DESIGN(central-box-design) §2-2: 엔진(ttyd)은 독립 포트로 노출하지 않고 localhost 에 두며,
//  '단일 정문'(이 게이트웨이)이 인증한 신원만 통과시킨다. 도그푸드라 forward-auth 헤더 주입 대신
//  /api/ui 와 동일한 BearerVerifier 로 '티켓 쿠키'를 발급해 /terminal HTTP·WS 프록시를 게이트한다.
//
// 전제: ttyd 가 다음으로 떠 있어야 한다(외부 비노출 — 127.0.0.1 only, reverse-proxy base-path):
//   ttyd -i 127.0.0.1 -p 7681 -b /terminal -W tmux new -A -s dogfood
import type express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import httpProxy from "http-proxy";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import { logger } from "./log.js";

const TTYD_TARGET = process.env.TTYD_TARGET ?? "http://127.0.0.1:7681";
const PREFIX = "/terminal";
const COOKIE = "lively_term";
const TICKET_TTL_MS = 12 * 60 * 60 * 1000; // 12h — 도그푸드용

// 인메모리 티켓 스토어 — 게이트웨이 재시작 시 비워짐(도그푸드 OK). ticket -> 만료(epoch ms).
const tickets = new Map<string, number>();

function issueTicket(): string {
  const t = crypto.randomBytes(18).toString("hex");
  tickets.set(t, Date.now() + TICKET_TTL_MS);
  return t;
}

// 쿠키 헤더에서 유효한(미만료) 터미널 티켓이 있는지. 만료분은 그 자리에서 청소.
function hasValidTicket(cookieHeader?: string): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    const tok = part.slice(eq + 1).trim();
    const exp = tickets.get(tok);
    if (exp && exp > Date.now()) return true;
    if (exp) tickets.delete(tok);
  }
  return false;
}

export function registerTerminal(app: express.Express, server: Server, verifier: BearerVerifier): void {
  const proxy = httpProxy.createProxyServer({ target: TTYD_TARGET, ws: true, changeOrigin: true });

  // ttyd 미기동 등 프록시 에러 — HTTP 면 502, WS(소켓) 면 소켓 종료.
  proxy.on("error", (err, _req, res) => {
    logger.warn({ err }, "ttyd proxy error (ttyd 미기동?)");
    const r = res as unknown as { writeHead?: (...a: unknown[]) => void; end?: (b?: string) => void; headersSent?: boolean; destroy?: () => void };
    if (typeof r?.writeHead === "function" && !r.headersSent) {
      r.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      r.end?.("terminal backend unavailable — ttyd not running");
    } else {
      r?.destroy?.();
    }
  });

  // 1) 티켓 발급 — 정문 인증(Bearer) 통과한 멤버에게만 HttpOnly 쿠키 발급. UI 가 토큰으로 호출.
  app.post("/api/ui/terminal/ticket", requireBearerAuth({ verifier }), (_req, res) => {
    const t = issueTicket();
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${t}; HttpOnly; Path=${PREFIX}; SameSite=Lax; Max-Age=${Math.floor(TICKET_TTL_MS / 1000)}`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  // 2) HTTP 프록시 — /terminal/* → ttyd. 경로 mount(app.use(PREFIX,..)) 는 req.url 의 prefix 를 떼므로
  //    ttyd base-path(/terminal)와 어긋난다 → prefix 를 보존하려고 전역 미들웨어에서 직접 분기한다.
  app.use((req, res, next) => {
    if (!req.url.startsWith(PREFIX)) return next();
    if (!hasValidTicket(req.headers.cookie)) {
      res.status(401).type("text/plain").send("unauthorized — Lively UI 에서 터미널을 여세요");
      return;
    }
    proxy.web(req, res);
  });

  // 3) WS 업그레이드 — /terminal* 만 처리(그 외 업그레이드는 미관여). 티켓 검증 후 ttyd 로 프록시.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith(PREFIX)) return;
    if (!hasValidTicket(req.headers.cookie)) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head);
  });

  logger.info(`terminal mounted at ${PREFIX} → ${TTYD_TARGET}`);
}

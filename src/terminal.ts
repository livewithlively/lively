// 중앙 박스 — 터미널 세션 매니저 정문. ([[central-box-design]] 경로 D: ttyd 대신 xterm.js+node-pty 깊은 통합)
// REST(/api/ui/terminal/*, Bearer) = 세션 목록·생성·이름변경·삭제 + 설정(루트·하네스 카탈로그).
// WS(/terminal/ws, ticket 쿠키) = PTY 스트림(terminal-pty.ts). 브라우저는 Authorization 헤더를 WS/네비에
// 못 실으므로, Bearer 로 인증된 멤버에게 HttpOnly 티켓 쿠키(userId 보유)를 발급해 WS 소유권 판정에 쓴다.
import type express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { logger } from "./log.js";
import { ROOTS, HARNESSES, listSessions, createSession, killSession, editSession } from "./terminal-sessions.js";
import { setupPtyUpgrade, type TicketLookup } from "./terminal-pty.js";
import { registerTerminalFiles } from "./terminal-files.js";

const COOKIE = "lively_term";
const PREFIX = "/terminal";
const TICKET_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// 인메모리 티켓 — 재기동 시 비워짐(도그푸드 OK). ticket -> { userId, exp(epoch ms) }.
const tickets = new Map<string, { userId: string; exp: number }>();
function issueTicket(userId: string): string {
  const t = crypto.randomBytes(18).toString("hex");
  tickets.set(t, { userId, exp: Date.now() + TICKET_TTL_MS });
  return t;
}
const lookupTicket: TicketLookup = (cookieHeader) => {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    const key = part.slice(eq + 1).trim();
    const rec = tickets.get(key);
    if (rec && rec.exp > Date.now()) return { userId: rec.userId };
    if (rec) tickets.delete(key);
  }
  return null;
};

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

export function registerTerminal(app: express.Express, server: Server, verifier: BearerVerifier): void {
  // 도그푸드: 인증만(authOnly) — 모든 멤버가 터미널 사용 가능. 정식화 시 'code'/'terminal' scope 게이트로 좁힌다.
  const auth = requireBearerAuth({ verifier });

  // 티켓 발급 — WS 가 쓸 HttpOnly 쿠키(userId 바인딩).
  app.post("/api/ui/terminal/ticket", auth, (req, res) => {
    const uid = idOf(userOf(req));
    if (!uid) { res.status(403).json({ error: "no user identity" }); return; }
    const t = issueTicket(uid);
    res.setHeader("Set-Cookie", `${COOKIE}=${t}; HttpOnly; Path=${PREFIX}; SameSite=Lax; Max-Age=${Math.floor(TICKET_TTL_MS / 1000)}`);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  // 생성폼 설정 — 허용 루트 + 하네스/플래그 카탈로그.
  app.get("/api/ui/terminal/config", auth, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      roots: ROOTS.map((r) => ({ key: r.key, label: r.label })),
      harnesses: HARNESSES.map((h) => ({ key: h.key, label: h.label, hasAutoApprove: !!h.autoApproveFlag, flags: h.flags })),
    });
  });

  app.get("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions: await listSessions(userOf(req)) });
  }));
  app.post("/api/ui/terminal/sessions", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const session = await createSession(userOf(req), {
      label: String(b.label ?? ""), rootKey: String(b.rootKey ?? ""), subpath: String(b.subpath ?? ""),
      harness: String(b.harness ?? ""), flags: (b.flags && typeof b.flags === "object") ? b.flags as Record<string, unknown> : {},
      autoApprove: !!b.autoApprove, visibility: String(b.visibility ?? "public"),
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ session });
  }));
  // 세션 수정 — 이름·공개범위(visibility) 변경. 소유자만.
  app.post("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    await editSession(userOf(req), req.params.id, {
      label: b.label !== undefined ? String(b.label) : undefined,
      visibility: b.visibility !== undefined ? String(b.visibility) : undefined,
    });
    res.json({ ok: true });
  }));
  app.delete("/api/ui/terminal/sessions/:id", auth, wrap(async (req, res) => {
    await killSession(userOf(req), req.params.id);
    res.json({ ok: true });
  }));

  registerTerminalFiles(app, verifier);
  setupPtyUpgrade(server, lookupTicket);
  logger.info("terminal session manager mounted (/api/ui/terminal/*, ws /terminal/ws, files)");
}

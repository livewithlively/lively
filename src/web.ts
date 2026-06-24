// Lively Context 웹 UI — 얇은 REST 어댑터(/api/ui/*) + 정적 프론트(/ui). DESIGN §10.1, Stage①.
// 라우트별 도메인 로직은 전부 src/capabilities/* 로 이동 — 여기는 restMounts() 를 순회해
// 기존 경로(+alias)에 그대로 마운트만 한다(경로·검증 메시지·응답 shape byte-compat).
// 인증(P4): 사람=웹 로그인 세션 쿠키(scope=멤버 LIVE) · 에이전트=bearer 토큰. 한 미들웨어가 둘 다 수용해
//  LivelyUser 로 정규화한다(세션 우선, 없으면 bearer). scope 게이트는 정규화된 user.scopes 로 공통 적용.
// 정적 자산은 비인증(사내망 전제) — 데이터는 전부 /api/ui 토큰/세션 뒤. domainmap 은 무인증 서비스라
// 이 프록시의 인증이 신뢰 경계(절대 비인증 프록시 금지).
import express from "express";
import { fileURLToPath } from "node:url";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./auth/bearer.js";
import type { LivelyUser } from "./context.js";
import { restMounts } from "./capabilities/index.js";
import { wrap, HttpError } from "./capabilities/rest-util.js";
import { DANGEROUS_SCOPES, type Scope } from "./capabilities/scopes.js";
import {
  userFromSession, parseSessionCookie, createSession, revokeSession, sessionCookie, clearSessionCookie,
} from "./auth/sessions.js";
import { verifyLogin, verifyOwnPassword, setMemberPassword } from "./auth/local-accounts.js";

// req.auth.extra 에 심긴 LivelyUser 를 꺼낸다(세션·bearer 공통 — 둘 다 이 형태로 채운다).
const userOf = (req: express.Request): LivelyUser =>
  ((req as unknown as { auth?: { extra?: unknown } }).auth?.extra ?? {}) as unknown as LivelyUser;

export function registerWebUi(app: express.Express, verifier: BearerVerifier): void {
  const authOnly = requireBearerAuth({ verifier });

  // 세션 쿠키 우선 → 유효하면 req.auth 채우고 통과, 없으면 bearer 로 위임(미인증이면 SDK 가 401+WWW-Authenticate).
  //  세션 user.scopes 는 멤버 LIVE(sessions.ts) → 박제 desync 없음. (.then 형: express RequestHandler 는 void 반환.)
  const authResolve: express.RequestHandler = (req, res, next) => {
    const sid = parseSessionCookie(req.headers.cookie);
    if (!sid) { authOnly(req, res, next); return; }
    userFromSession(sid).then((user) => {
      if (user) {
        (req as unknown as { auth: unknown }).auth = { token: "", clientId: user.userId, scopes: user.scopes, extra: user };
        next();
      } else {
        authOnly(req, res, next);
      }
    }).catch(() => authOnly(req, res, next));
  };

  // scope 게이트(세션·bearer 공통). null=인증만. fail-closed(미인증 401 / 권한부족 403).
  const requireScope = (scope: Scope | null): express.RequestHandler => (req, res, next) => {
    const user = userOf(req);
    if (!user || !user.userId) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (scope && !(Array.isArray(user.scopes) && user.scopes.includes(scope))) {
      res.status(403).json({ error: `forbidden: '${scope}' 권한이 필요합니다` }); return;
    }
    next();
  };

  const mw = (scope: Scope | null): express.RequestHandler[] => [authResolve, requireScope(scope)];

  // ── 로컬 로그인/로그아웃/비번변경(P4). 로그인은 미인증 접근(cap 마운트보다 먼저). ──
  app.post("/api/ui/login", wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await verifyLogin(String(body.email ?? ""), String(body.password ?? ""));
    if (!result.ok) {
      const msg = result.reason === "locked"
        ? "로그인 시도가 많아 잠시 잠겼습니다(15분 후 재시도)"
        : "이메일 또는 비밀번호가 올바르지 않습니다";
      res.status(401).json({ error: msg }); return;
    }
    const { sessionId, expiresAt } = await createSession(result.memberId,
      { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
    res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, memberId: result.memberId, mustChange: result.mustChange });
  }));

  app.post("/api/ui/logout", wrap(async (req, res) => {
    const sid = parseSessionCookie(req.headers.cookie);
    if (sid) await revokeSession(sid);
    res.setHeader("Set-Cookie", clearSessionCookie());
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  }));

  // 본인 비번 변경 — 세션/토큰 인증 필요. 현재 비번 확인 후 교체(8자+).
  app.post("/api/ui/password", ...mw(null), wrap(async (req, res) => {
    const user = userOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nextPw = String(body.next ?? "");
    if (nextPw.length < 8) { res.status(400).json({ error: "새 비밀번호는 8자 이상이어야 합니다" }); return; }
    const ok = await verifyOwnPassword(user.userId, String(body.current ?? ""));
    if (!ok) { res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다" }); return; }
    await setMemberPassword(user.userId, nextPw, { mustChange: false, actor: user.userId });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  }));

  for (const { cap, mount } of restMounts()) {
    const handler = wrap(async (req, res) => {
      const input = mount.parse(req); // 기존 qstr/qint/parseMappingBody 검증 그대로(HttpError → wrap)
      const user = userOf(req);
      // B3 defense-in-depth: 미들웨어(mw)에 더해 핸들러 경계에서도 scope 재확인(단일층 의존 제거).
      if (cap.scope && !(Array.isArray(user.scopes) && user.scopes.includes(cap.scope))) {
        throw new HttpError(403, `forbidden: '${cap.scope}' 권한이 필요합니다`);
      }
      // B5: 회수 불가한 정적 토큰(AUTH_TOKENS_JSON)으로는 fleet 제어·정책 변경(admin/runtime) 금지(세션·DB 토큰은 허용).
      if (cap.scope && DANGEROUS_SCOPES.has(cap.scope) && user.tokenSource === "static") {
        throw new HttpError(403, "정적 토큰으로는 관리/런타임 변경이 불가합니다 — 회수 가능한 발급 토큰(lvk_)을 사용하세요");
      }
      // /api/ui 응답은 전부 비공개(토큰 발급 평문 포함) — 프록시/브라우저 캐시 금지.
      res.setHeader("Cache-Control", "no-store");
      res.json(await cap.handler(input, user, {
        source: "web",
        actor: user.userId || user.email,
        tokenHashPrefix: user.tokenHashPrefix,
        ip: req.ip,
      }));
    });
    for (const path of mount.paths) {
      if (mount.method === "GET") app.get(path, ...mw(cap.scope), handler);
      else app.post(path, ...mw(cap.scope), handler);
    }
  }

  // ── 정적 프론트 — dist/web.js 기준 레포루트/public. 해시 라우팅이라 서버 폴백 불필요. ──
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  app.use("/ui", express.static(publicDir));
  app.get("/", (_req, res) => res.redirect("/ui/"));
}

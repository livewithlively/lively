// 세션 쿠키 OR bearer 토큰을 모두 수용하는 HTTP 인증 미들웨어 — 사람(웹 로그인 세션)·에이전트(토큰) 공통.
//  세션 우선, 없거나 무효면 bearer 로 위임(SDK 가 401+WWW-Authenticate). 성공 시 req.auth.extra = LivelyUser.
//  ⚠ /api/ui/* 전 표면(web 캡 + 터미널 + 터미널파일 + 프로젝트)이 **이걸 써야** — 한 군데라도 bearer 전용이면
//   세션 로그인 사용자가 그 탭에서만 401 → "세션 만료" 로그아웃되는 버그가 난다(2026-06-24 회귀 수정).
//   /mcp·/install 은 에이전트 전용이라 bearer 유지(여기 비대상).
import type express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./bearer.js";
import { parseSessionCookie, userFromSession } from "./sessions.js";

export function sessionOrBearer(verifier: BearerVerifier): express.RequestHandler {
  const bearer = requireBearerAuth({ verifier });
  return (req, res, next) => {
    const sid = parseSessionCookie(req.headers.cookie);
    if (!sid) { bearer(req, res, next); return; }
    userFromSession(sid).then((user) => {
      if (user) {
        (req as unknown as { auth: unknown }).auth = { token: "", clientId: user.userId, scopes: user.scopes, extra: user };
        next();
      } else {
        bearer(req, res, next);
      }
    }).catch(() => bearer(req, res, next));
  };
}

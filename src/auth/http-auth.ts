// 세션 쿠키 OR bearer 토큰을 모두 수용하는 HTTP 인증 미들웨어 — 사람(웹 로그인 세션)·에이전트(토큰) 공통.
//  세션 우선, 없거나 무효면 bearer 로 위임(SDK 가 401+WWW-Authenticate). 성공 시 req.auth.extra = LivelyUser.
//  ⚠ /api/ui/* 전 표면(web 캡 + 터미널 + 터미널파일 + 프로젝트)이 **이걸 써야** — 한 군데라도 bearer 전용이면
//   세션 로그인 사용자가 그 탭에서만 401 → "세션 만료" 로그아웃되는 버그가 난다(2026-06-24 회귀 수정).
//   /mcp·/install 은 에이전트 전용이라 bearer 유지(여기 비대상).
import type express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./bearer.js";
import { parseSessionCookie, userFromSession } from "./sessions.js";
import { resourceIds } from "./resource-id.js";

/**
 * /mcp 전용 bearer — 401 에 **RFC 9728 resource_metadata 를 실어** 클라이언트가 인가서버를 발견하게 한다(#1473 T2).
 *
 * 이게 없으면 챗 클라이언트(ChatGPT·claude.ai)는 401 을 받고도 "어디서 로그인해야 하는지"를 모른 채 멈춘다 —
 *  2026-08-04 실측에서 dev.lvly.io 가 정확히 그 상태였다(WWW-Authenticate 에 resource_metadata 없음).
 *
 * SDK 의 requireBearerAuth 는 그 URL 을 **생성 시점 상수**로 받는데 우리 공개 주소는 DB(org 프로필)에서 오므로,
 *  해소된 주소별로 미들웨어를 만들어 캐시한다(주소는 사실상 1개 — 캐시가 무한히 자라지 않는다).
 */
export function bearerWithResourceMetadata(verifier: BearerVerifier): express.RequestHandler {
  const cache = new Map<string, express.RequestHandler>();
  const plain = requireBearerAuth({ verifier }); // 공개 주소 미설정 시(= OAuth 비활성) 종전 동작 그대로
  return (req, res, next) => {
    resourceIds().then((ids) => {
      if (!ids) { plain(req, res, next); return; }
      const url = `${ids.base}/.well-known/oauth-protected-resource/mcp`;
      let handler = cache.get(url);
      if (!handler) { handler = requireBearerAuth({ verifier, resourceMetadataUrl: url }); cache.set(url, handler); }
      handler(req, res, next);
    }).catch(() => plain(req, res, next));
  };
}

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

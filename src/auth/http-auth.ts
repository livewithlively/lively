// 세션 쿠키 OR bearer 토큰을 모두 수용하는 HTTP 인증 미들웨어 — 사람(웹 로그인 세션)·에이전트(토큰) 공통.
//  세션 우선, 없거나 무효면 bearer 로 위임(SDK 가 401+WWW-Authenticate). 성공 시 req.auth.extra = LivelyUser.
//  ⚠ /api/ui/* 전 표면(web 캡 + 터미널 + 터미널파일 + 프로젝트)이 **이걸 써야** — 한 군데라도 bearer 전용이면
//   세션 로그인 사용자가 그 탭에서만 401 → "세션 만료" 로그아웃되는 버그가 난다(2026-06-24 회귀 수정).
//   /mcp·/install 은 에이전트 전용이라 bearer 유지(여기 비대상).
import type express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./bearer.js";
import type { LivelyUser } from "../context.js";
import { parseSessionCookie, userFromSession } from "./sessions.js";
import { resourceIds } from "./resource-id.js";
import { isAppServerToken, resolveAppServerPrincipal } from "../apps/app-server-auth.js";
import { APP_IDENTITY_HEADER } from "../apps/app-identity.js";

// ── 앱 서버 토큰(#4483) ─────────────────────────────────────────────────────────────────
//  멤버 없는 앱 토큰은 **능력 REST(web.ts)에서만** 받는다 — 거기서 사람 신원(X-Lively-Identity)을 검증해 «그 구성원 ∩ 앱 동의»
//  주체로 바꾸고, 그 뒤는 앱 도구 게이트(requireAppTool)가 지킨다. 터미널·파일·프로젝트·프리뷰·노드 경로와 /mcp·/install 은
//  앱 도구 게이트를 안 타므로 이 토큰을 거부한다(fail-closed — 앱 코드가 쥔 토큰으로 사람 터미널을 열 수 없게).
type AuthedReq = express.Request & { auth?: unknown };
function appServerGate(allow: boolean): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    const r = req as AuthedReq;
    const user = (r.auth as { extra?: unknown } | undefined)?.extra as LivelyUser | undefined;
    if (!isAppServerToken(user)) { next(); return; }
    if (!allow) { res.status(403).json({ error: "앱 서버 토큰은 앱 데이터·도구 API(/api/ui/…)에서 사람 신원과 함께만 씁니다" }); return; }
    resolveAppServerPrincipal(user!, req.headers[APP_IDENTITY_HEADER]).then((p) => {
      (r.auth as { extra?: unknown }).extra = p;          // bearer 가 막 채운 자리 — 주체만 사람으로 바꾼다
      next();
    }, (e: { status?: number; message?: string }) => {
      res.status(e?.status === 403 ? 403 : 401).json({ error: String(e?.message ?? "앱 서버 인증 실패") });
    });
  };
}

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
  const gate = appServerGate(false);
  return (req, res, next) => {
    const then = (): void => gate(req, res, next);
    resourceIds().then((ids) => {
      if (!ids) { plain(req, res, then); return; }
      const url = `${ids.base}/.well-known/oauth-protected-resource/mcp`;
      let handler = cache.get(url);
      if (!handler) { handler = requireBearerAuth({ verifier, resourceMetadataUrl: url }); cache.set(url, handler); }
      handler(req, res, then);
    }).catch(() => plain(req, res, then));
  };
}

/** opts.appServer — 앱 서버 토큰을 사람 신원으로 바꿔 받는가(능력 REST 만 true, 머리말 «앱 서버 토큰»). */
export function sessionOrBearer(verifier: BearerVerifier, opts: { appServer?: boolean } = {}): express.RequestHandler {
  const plainBearer = requireBearerAuth({ verifier });
  const gate = appServerGate(opts.appServer === true);
  const bearer: express.RequestHandler = (req, res, next) => plainBearer(req, res, () => gate(req, res, next));
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

// 세션 쿠키 OR bearer 토큰을 모두 수용하는 HTTP 인증 미들웨어 — 사람(웹 로그인 세션)·에이전트(토큰) 공통.
//  세션 우선, 없거나 무효면 bearer 로 위임(SDK 가 401+WWW-Authenticate). 성공 시 req.auth.extra = LivelyUser.
//  ⚠ /api/ui/* 전 표면(web 캡 + 터미널 + 터미널파일 + 프로젝트)이 **이걸 써야** — 한 군데라도 bearer 전용이면
//   세션 로그인 사용자가 그 탭에서만 401 → "세션 만료" 로그아웃되는 버그가 난다(2026-06-24 회귀 수정).
//   /mcp·/install 은 에이전트 전용이라 bearer 유지(여기 비대상).
import type express from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { BearerVerifier } from "./bearer.js";
import { confinedToAppTools, type LivelyUser } from "../context.js";
import { parseSessionCookie, userFromSession } from "./sessions.js";
import { resourceIds } from "./resource-id.js";
import { isAppServerToken, resolveAppServerPrincipal } from "../apps/app-server-auth.js";
import { APP_IDENTITY_HEADER } from "../apps/app-identity.js";
import { runWithAppReadScope } from "../apps/app-context.js";   // #5100 앱 맥락 범위 — 문을 지난 앱 토큰 요청은 그 앱의 읽기 범위를 물려받는다

// ── 앱 서버 토큰(#4483) ─────────────────────────────────────────────────────────────────
//  멤버 없는 앱 토큰은 **능력 REST 마운트(web.ts mwCap)에서만** 받는다 — 거기서 사람 신원(X-Lively-Identity)을 검증해 «그 구성원 ∩
//  앱 동의» 주체로 바꾸고, 그 뒤는 앱 도구 게이트(requireAppTool)가 지킨다. 그 밖(web.ts 의 mw 라우트 · 터미널·파일·프로젝트·프리뷰·
//  노드 경로 · /mcp·/install)은 앱 도구 게이트를 안 타므로 이 토큰을 거부한다(기본값 appServer:false — fail-closed).
//  #4891 — 앱 서버 급 토큰(auth_token.app_server_principal — 사람 홈 없는 작업 AI 의 토큰)은 검증부터 «그 구성원 ∩ 앱 동의 · appServer»
//   주체다. 능력 REST 와 /mcp(앱 도구 게이트를 탄다)에서만 받고 그 밖은 거부한다 — 그 AI 를 부린 것은 앱 서버 코드라, 사람 이름으로 세션을
//   열거나(홈이 붙는다) 파일 · 계정 길을 쓰지 못하게.
type AuthedReq = express.Request & { auth?: unknown };
/** 앱 주체 문을 어디에 다나 — 능력 REST(앱 서버 토큰을 사람 신원으로 바꾼다) · /mcp · 그 밖(둘 다 거부). */
export type AppPrincipalGateMode = "cap" | "mcp" | "deny";
/**
 * (순수) 이 주체를 이 문에서 어떻게 하나(#4483 · #4891) — next(그대로) · resolve(사람 신원으로 바꾼다) · deny(403).
 *  · 앱 서버 토큰(멤버 없는 날 토큰): 능력 REST 에서만 resolve, 그 밖은 deny.
 *  · 앱 서버 급 주체(검증이 appServer 를 켠 토큰): 능력 REST · /mcp 는 next(앱 도구 게이트가 지킨다), 그 밖은 deny.
 *  · 도구 상한이 실린 토큰(앱 AI 작업 — 매니페스트 ai.tools): 같다. 상한은 앱 도구 게이트(principal.appToolAllowed)에서만 지켜지므로
 *    그 게이트를 안 타는 문(세션 · 파일 · 프로젝트 · 노드 길)에서 받으면 상한 밖의 일을 하게 된다.
 *  · 그 밖(사람 · 일반 앱 토큰 · 세션 쿠키): next.
 */
export function appPrincipalGate(user: LivelyUser | undefined, mode: AppPrincipalGateMode): "next" | "resolve" | "deny" {
  if (isAppServerToken(user)) return mode === "cap" ? "resolve" : "deny";
  if (confinedToAppTools(user)) return mode === "deny" ? "deny" : "next";
  return "next";
}
//  #5100 — 앱 토큰 요청은 여기서 그 앱의 읽기 범위 안으로 들어간다(v6/read-scope.ts). 능력 어댑터 밖의 맨 라우트(터미널 파일 · 프로젝트 ·
//   자료 원본 /sources/:id/original 등)도 공개범위 술어를 지나면 범위가 걸린다 — 어댑터 셋만 감싸던 1차 판에선 새 길이 기본으로 열렸다(격리 리뷰 N1).
//   next() 는 그 자리에서 다음 미들웨어 · 핸들러를 부르므로 그 뒤의 비동기 이어짐이 이 범위를 물려받는다. 앱 토큰이 아니면 그대로 부른다.
const nextInAppScope = (user: LivelyUser | undefined, next: express.NextFunction): void => {
  void runWithAppReadScope(user, () => { next(); return Promise.resolve(); });
};
function appServerGate(mode: AppPrincipalGateMode): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    const r = req as AuthedReq;
    const user = (r.auth as { extra?: unknown } | undefined)?.extra as LivelyUser | undefined;
    const verdict = appPrincipalGate(user, mode);
    if (verdict === "next") { nextInAppScope(user, next); return; }
    if (verdict === "deny") {
      res.status(403).json({ error: confinedToAppTools(user)
        ? "앱 작업 토큰은 앱 도구(능력 API · MCP)에서만 씁니다"
        : "앱 서버 토큰은 앱 데이터·도구 API(/api/ui/…)에서 사람 신원과 함께만 씁니다" });
      return;
    }
    resolveAppServerPrincipal(user!, req.headers[APP_IDENTITY_HEADER]).then((p) => {
      (r.auth as { extra?: unknown }).extra = p;          // bearer 가 막 채운 자리 — 주체만 사람으로 바꾼다
      nextInAppScope(p, next);
    }, (e: { status?: number; message?: string }) => {
      //  401·403 은 판정 그대로, 그 밖(DB 오류 등)은 503 — 401 로 뭉개면 클라이언트가 토큰을 버리고 다시 받으려 한다.
      const st = e?.status === 403 ? 403 : e?.status === 401 ? 401 : 503;
      res.status(st).json({ error: st === 503 ? "앱 서버 인증을 지금 확인하지 못했습니다 — 잠시 뒤 다시 하세요" : String(e?.message ?? "앱 서버 인증 실패") });
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
export function bearerWithResourceMetadata(verifier: BearerVerifier, mode: AppPrincipalGateMode = "mcp"): express.RequestHandler {
  const cache = new Map<string, express.RequestHandler>();
  const plain = requireBearerAuth({ verifier }); // 공개 주소 미설정 시(= OAuth 비활성) 종전 동작 그대로
  //  /mcp — 앱 서버 토큰은 거부, 앱 서버 급 주체(#4891 작업 AI)는 받는다(도구는 앱 도구 게이트가 그 앱 동의로 좁힌다).
  //   /install 은 "deny" 로 단다(앱 도구 게이트 밖 · 요청마다 묶음을 만든다 — 격리 리뷰).
  const gate = appServerGate(mode);
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
  const gate = appServerGate(opts.appServer === true ? "cap" : "deny");
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

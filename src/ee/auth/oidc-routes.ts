// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 외부 IdP 로그인(OIDC, #1520)의 HTTP 배선 — 종전 web.ts 에 인라인으로 있던 것을 EE 로 옮겼다(#1601).
//  전부 **무인증** 표면이다: 세션을 얻기 전에 타는 문이니까. 그래서 코어의 scope 미들웨어를 쓰지 않고,
//  이 파일이 직접 app 에 붙는다(registerSsoRoutes 훅 → enterprise/registry.ts).
//  ⚠ 우리가 인가서버인 /authorize(#1473 T2, org/auth/oauth-*.ts)와 방향이 반대다 — 여기선 우리가 클라이언트다.
//
//  ★ 경계(#1601): '내 로그인 수단' 화면(/api/ui/me/logins)과 연결 해제(/api/ui/me/oidc/unlink)는 **코어**에 남았다.
//   그건 인증된 사람이 자기 계정을 관리하는 표면이고, EE 부재 시에도 '비밀번호는 있고 SSO 는 안 붙었다'를
//   답해야 하기 때문이다(코어가 ee().sso 훅을 경유한다). 여기 있는 건 SSO 고유의 무인증 로그인 흐름뿐이다.
import type express from "express";
import { wrap } from "../../http/rest-util.js";
import { gatewayUrlForRequest } from "../../gateway-url.js";
import { parseSessionCookie, userFromSession, createSession, sessionCookie } from "../../auth/sessions.js";
import { logger } from "../../log.js";
import { oidcConfig, discover, buildAuthorizeUrl, exchangeCode, emailFromClaims } from "./oidc.js";
import { resolveOidcMember, linkOidcToMember } from "./oidc-login.js";
import { createOidcAuthRequest, consumeOidcAuthRequest, createOidcLink } from "./oidc-auth-store.js";
import { OIDC_LINK_PATH, registerOidcLinkPage } from "./oidc-link-page.js";

export function registerOidcRoutes(app: express.Express): void {
  // redirect_uri 는 개시와 콜백에서 **글자 그대로 같아야** IdP 검증을 통과한다 → 한 함수에서만 만든다.
  //  base 는 gateway-url 단일소스(#1438) — org 프로필 > PUBLIC_URL > 요청 헤더.
  const oidcRedirectUri = async (req: express.Request): Promise<string | null> => {
    const base = await gatewayUrlForRequest(req);
    return base ? `${base}/api/ui/auth/oidc/callback` : null;
  };

  // 인가 개시 — state/nonce/PKCE 를 만들어 저장하고 IdP 로 302. return_to 는 same-origin 경로만 통과한다.
  //  link=1 이면 '로그인'이 아니라 **이미 로그인한 사람의 계정에 IdP 를 붙이는** 요청이다(#1520 A) →
  //  그때만 세션을 요구하고, 대상 구성원을 state 행에 못박는다(콜백이 쿼리스트링에 속지 않게).
  app.get("/api/ui/auth/oidc/start", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const cfg = await oidcConfig();
    if (!cfg) { res.status(404).json({ error: "OIDC 로그인이 이 배포에 설정되어 있지 않습니다" }); return; }
    const redirectUri = await oidcRedirectUri(req);
    if (!redirectUri) { res.status(500).json({ error: "게이트웨이 공개 주소를 확정할 수 없습니다" }); return; }
    let linkMember: string | null = null;
    if (String(req.query?.link ?? "") === "1") {
      const sid = parseSessionCookie(req.headers.cookie);
      const user = sid ? await userFromSession(sid) : null;
      if (!user) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
      linkMember = user.userId;
    }
    try {
      const disc = await discover(cfg);
      const { state, nonce, codeVerifier } = await createOidcAuthRequest({
        returnTo: String(req.query?.to ?? ""), linkMember,
      });
      res.redirect(302, buildAuthorizeUrl(cfg, disc, { redirectUri, state, nonce, codeVerifier }));
    } catch (err) {
      // discovery 실패(IdP 다운·설정 오타)는 사람에게 '지금은 로컬 로그인을 쓰라'고 보이는 게 최선이다.
      logger.error({ err }, "[oidc] 인가 개시 실패");
      res.redirect(302, "/ui/#/login?error=oidc_start");
    }
  }));

  // 콜백 — 인가코드를 세션 쿠키로. 실패는 전부 로그인 화면으로 되돌린다(사유는 error 파라미터로만).
  app.get("/api/ui/auth/oidc/callback", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const fail = (reason: string): void => { res.redirect(302, `/ui/#/login?error=${encodeURIComponent(reason)}`); };
    const cfg = await oidcConfig();
    if (!cfg) { fail("oidc_off"); return; }
    // 사용자가 IdP 화면에서 취소했거나 IdP 가 오류를 돌려준 경우 — code 없이 error 만 온다.
    if (req.query?.error) { fail("oidc_denied"); return; }
    const code = String(req.query?.code ?? "");
    const state = String(req.query?.state ?? "");
    if (!code || !state) { fail("oidc_bad_request"); return; }
    // state 소비가 곧 CSRF 검증이다 — 우리가 발급하지 않았거나 이미 쓴 state 면 여기서 끝난다.
    const pending = await consumeOidcAuthRequest(state);
    if (!pending) { fail("oidc_state"); return; }
    const redirectUri = await oidcRedirectUri(req);
    if (!redirectUri) { fail("oidc_config"); return; }
    try {
      const disc = await discover(cfg);
      const claims = await exchangeCode(cfg, disc, {
        code, redirectUri, codeVerifier: pending.codeVerifier, nonceHash: pending.nonceHash,
      });

      // (A) 연결 모드 — 설정 화면에서 시작한 요청. 새 세션을 만들지 않고 지금 세션의 구성원에 신원을 붙인다.
      //  ⚠ 개시 때 인증했더라도 **콜백 시점에 다시 확인**한다: 그 사이 로그아웃했거나 다른 사람이 이 브라우저를
      //   쓰고 있을 수 있고, 그때 붙이면 엉뚱한 계정에 IdP 가 달린다.
      if (pending.linkMember) {
        const sid = parseSessionCookie(req.headers.cookie);
        const user = sid ? await userFromSession(sid) : null;
        if (!user || user.userId !== pending.linkMember) { fail("oidc_link_session"); return; }
        const email = emailFromClaims(claims, cfg);
        if (!email) { fail("oidc_no_email"); return; }
        const linked = await linkOidcToMember(pending.linkMember, {
          sub: String(claims.sub), email, displayName: claims.name ? String(claims.name) : null,
        });
        if (!linked.ok) { fail(`oidc_link_${linked.reason}`); return; }
        res.redirect(302, pending.returnTo ?? "/ui/#/me");
        return;
      }

      const resolved = await resolveOidcMember(claims, cfg);

      // (B) 갈림길 — 신원은 검증됐는데 구성원을 못 정했다. 여기서 새 계정을 만들지 않고 사람에게 묻는다
      //  (이메일 표기만 다른 사람에게 빈 계정을 하나 더 만들어 주는 게 이 흐름의 가장 흔한 사고였다).
      if (!resolved.ok && resolved.reason === "no_match") {
        const linkCode = await createOidcLink({
          sub: resolved.identity.sub, email: resolved.identity.email,
          displayName: resolved.identity.displayName, canProvision: resolved.canProvision,
        });
        res.redirect(302, `${OIDC_LINK_PATH}?code=${encodeURIComponent(linkCode)}`);
        return;
      }
      if (!resolved.ok) { fail(`oidc_${resolved.reason}`); return; }

      const { sessionId, expiresAt } = await createSession(resolved.memberId,
        { ip: req.ip, userAgent: (req.headers["user-agent"] as string) ?? null });
      res.setHeader("Set-Cookie", sessionCookie(sessionId, expiresAt));
      res.redirect(302, pending.returnTo ?? "/ui/");
    } catch (err) {
      // 토큰 교환·id_token 검증 실패. 원인은 로그에만 남긴다 — 무인증 표면에 검증 실패 사유를 흘리면
      //  공격자에게 어디까지 통과했는지 알려주는 셈이다.
      logger.warn({ err }, "[oidc] 콜백 처리 실패");
      fail("oidc_verify");
    }
  }));

  // 계정 갈림길 화면(#1520 B) — 콜백이 302 로 보내는 목적지. 종전엔 index.ts 가 직접 등록했다.
  registerOidcLinkPage(app);
}

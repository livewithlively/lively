// 로그아웃이 IdP(SSO) 세션까지 끝내게 하는 코어 쪽 판단 — 로그아웃 응답의 redirect 를 정한다.
//
// 웹 세션만 끊으면 IdP 세션이 살아 있어, 다음 «SSO 로 로그인» 이 묻지도 않고 같은 계정으로 다시 들어온다.
//  그래서 IdP 로 로그인한 세션이면 IdP 의 로그아웃 문(end_session_endpoint) 주소를 돌려주고 브라우저가 그리로 간다.
//  주소를 만드는 건 EE(ee().sso.ssoLogoutUrl)다 — discovery·client_id·id_token 복호화가 전부 거기 있다.
//
// IdP 를 거치지 않은 로그인(비밀번호·매니지드 CP 교환)·EE 미탑재·공개 주소 미확정·EE 실패는 전부 null 이다.
//  null 이면 응답은 종전 그대로 {ok:true} 이고, 로그아웃 자체(세션 회수·쿠키 삭제)는 이미 끝나 있다.
import type { RevokedSession } from "./sessions.js";
import type { SsoHooks } from "../enterprise/registry.js";
import { logger } from "../log.js";

export async function ssoLogoutRedirect(
  ended: RevokedSession | null,
  publicBase: () => Promise<string | null>,
  sso: Pick<SsoHooks, "ssoLogoutUrl"> | undefined,
): Promise<string | null> {
  if (!ended || ended.authMethod !== "oidc" || !sso) return null;
  try {
    const base = await publicBase();
    if (!base) return null;
    return await sso.ssoLogoutUrl(ended, `${base.replace(/\/+$/, "")}/ui/`);
  } catch (err) {
    logger.warn({ err }, "[logout] IdP 로그아웃 주소를 만들지 못해 웹 세션만 끝낸다");
    return null;
  }
}

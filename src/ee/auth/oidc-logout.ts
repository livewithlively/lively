// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// IdP 로그인 세션의 로그아웃 — OIDC RP-Initiated Logout 1.0. 웹 세션만 끊으면 IdP 세션이 살아 있어
//  «SSO 로 로그인» 한 번에 묻지도 않고 같은 계정으로 돌아온다(공용 PC 에서 로그아웃한 사람의 계정에 다음 사람이 들어간다).
//  그래서 IdP 의 로그아웃 문(end_session_endpoint)으로 브라우저를 보내 IdP 세션까지 끝낸다.
//  ★ 운영자가 켜는 기능이다(OIDC 설정 idp_logout · OIDC_IDP_LOGOUT=1, 기본 꺼짐) — 켜면 같은 IdP 세션을 쓰는 다른 회사 앱
//   (메일·메신저 등)에서도 나가게 되고, IdP 허용 목록에 post_logout_redirect_uri 를 등록해야 한다. 둘 다 조직이 정할 일이다.
//
//  주소는 discovery 가 알려준 것만 쓴다 — IdP 마다 경로가 다르고(Keycloak 은 /protocol/openid-connect/logout),
//   구글처럼 아예 안 주는 IdP 도 있다. 안 주면 null 이고 로그아웃은 웹 세션만 끝낸다(종전 동작).
//  파라미터: client_id + post_logout_redirect_uri 는 늘, id_token_hint 는 세션에 보관된 토큰이 있을 때만.
//   Keycloak 은 id_token_hint 가 없으면 «로그아웃할까요» 확인 화면을 한 번 보여 준다 — 로그아웃은 그래도 성립한다.
//   post_logout_redirect_uri 는 IdP 클라이언트 설정의 허용 목록에 있어야 한다(없으면 IdP 가 오류 화면을 낸다).
import { logger } from "../../log.js";
import { encryptSecret, secretsEnabled, tryDecryptSecret } from "../../org/credentials/secret-box.js";
import { OIDC_AUTH_METHOD } from "../../enterprise/registry.js";
import { oidcConfig, discover, type OidcConfig, type OidcDiscovery } from "./oidc.js";

// id_token 보관용 봉인. 마스터키(CONNECTOR_SECRET_KEY)가 없으면 보관하지 않는다 — DB 에 평문 토큰을 두지 않는다.
//  보관 못 하면 로그아웃이 id_token_hint 없이 IdP 로 갈 뿐이라 로그인을 막을 이유가 없다.
export function sealIdToken(idToken: string): string | null {
  if (!secretsEnabled()) return null;
  try {
    return encryptSecret(idToken);
  } catch (err) {
    logger.warn({ err }, "[oidc] id_token 을 봉인하지 못해 보관하지 않는다");
    return null;
  }
}

export function buildEndSessionUrl(
  endSessionEndpoint: string,
  args: { clientId: string; postLogoutRedirectUri: string; idToken: string | null },
): string {
  const p = new URLSearchParams({ client_id: args.clientId, post_logout_redirect_uri: args.postLogoutRedirectUri });
  if (args.idToken) p.set("id_token_hint", args.idToken);
  const sep = endSessionEndpoint.includes("?") ? "&" : "?";
  return `${endSessionEndpoint}${sep}${p}`;
}

export interface OidcLogoutDeps {
  config: () => Promise<OidcConfig | null>;
  discover: (cfg: OidcConfig) => Promise<OidcDiscovery>;
}

export async function oidcLogoutUrl(
  session: { authMethod: string | null; ssoIdTokenEnc: string | null },
  postLogoutRedirectUri: string,
  deps: OidcLogoutDeps = { config: oidcConfig, discover },
): Promise<string | null> {
  if (session.authMethod !== OIDC_AUTH_METHOD) return null;
  const cfg = await deps.config();
  if (!cfg || !cfg.idpLogout) return null;   // 꺼져 있으면 종전처럼 웹 세션만 끝낸다
  let disc: OidcDiscovery;
  try {
    disc = await deps.discover(cfg);
  } catch (err) {
    logger.warn({ err }, "[oidc] 로그아웃용 discovery 실패 — 웹 세션만 끝낸다");
    return null;
  }
  if (!disc.end_session_endpoint) return null;
  // 복호화 실패(마스터키 교체 등)는 토큰 없는 것과 같게 다룬다 — 로그아웃 문은 그래도 간다.
  const idToken = session.ssoIdTokenEnc ? tryDecryptSecret(session.ssoIdTokenEnc) : null;
  return buildEndSessionUrl(disc.end_session_endpoint, { clientId: cfg.clientId, postLogoutRedirectUri, idToken });
}

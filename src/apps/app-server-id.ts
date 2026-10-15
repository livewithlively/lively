// 앱 서버 토큰의 user_id 모양(#4483) — 무의존 leaf(인증 계층 bearer 가 가져다 쓴다). 판정·발급은 app-server-auth.
//  `app-server:<테넌트 UUID>:<앱 id>` — (테넌트, 앱)을 굽는다. 자가호스팅 다중 워크스페이스에선 auth_token 이 박스 전역이라
//  굽지 않으면 W1 에서 받은 토큰이 같은 앱 id 를 깐 W2 에서도 통한다.
export const APP_SERVER_USER_PREFIX = "app-server:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function appServerUserId(tenantId: string, appId: string): string {
  return `${APP_SERVER_USER_PREFIX}${tenantId.toLowerCase()}:${appId}`;
}

/** user_id → (테넌트, 앱). 앱 서버 토큰이 아니면 null. */
export function parseAppServerUserId(userId: string | null | undefined): { tenantId: string; appId: string } | null {
  const s = String(userId ?? "");
  if (!s.startsWith(APP_SERVER_USER_PREFIX)) return null;
  const rest = s.slice(APP_SERVER_USER_PREFIX.length);
  const i = rest.indexOf(":");
  if (i < 0) return null;
  const tenantId = rest.slice(0, i), appId = rest.slice(i + 1);
  if (!UUID_RE.test(tenantId) || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(appId)) return null;
  return { tenantId, appId };
}

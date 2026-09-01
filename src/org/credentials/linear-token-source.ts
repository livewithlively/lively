// Linear 수집기 토큰 출처 해소(#2247) — token_source="member:<id>" | "org" → 금고 linear_app 슬롯(라이블리 앱 토큰 묶음).
//  묶음/만료 판별은 http_proxy 와 같은 부품(resolveOAuthMemberSecret → resolveProxyBearer)으로 — 손파싱 0.
import { GATEWAY_OWNER, resolveMemberSecret, type MemberSecretResolved } from "./member-secret-store.js";
import { LINEAR_APP_KIND } from "./linear-oauth.js";
//  ⚠ oauth-proxy-auth 는 동적 import — github-token-source 와 같은 이유(connectors/config 순환).

export interface LinearTokenResolution { token?: string; warning?: string }
export interface LinearVaultDeps {
  resolve: (memberId: string | null, allowFallback: boolean) => Promise<MemberSecretResolved | null>;
  bearer: (resolved: MemberSecretResolved) => Promise<string>;
}
const CONNECT = "— [외부 앱 연결 ▸ Linear ▸ 자료 가져오기]를 켜면 Linear 화면에서 [허용] 한 번으로 연결됩니다";

export async function resolveLinearTokenSource(source: string | undefined, deps: LinearVaultDeps): Promise<LinearTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null;
  const isOrg = s === "org";
  const isMember = s.startsWith("member:") && s.slice(7).trim().length > 0;
  if (!isOrg && !isMember) return { warning: `알 수 없는 token_source '${s}' — org 또는 member:<구성원 id> 여야 합니다` };
  const memberId = isMember ? s.slice(7).trim() : null;
  const owner = isOrg ? GATEWAY_OWNER : `member:${memberId}`;
  const resolved = await deps.resolve(memberId, isOrg).catch(() => null);
  if (!resolved?.secret) return { warning: `${owner} 의 Linear 연결이 없습니다 ${CONNECT}` };
  try {
    const token = await deps.bearer(resolved);
    return token ? { token } : { warning: `Linear 토큰이 비어 있습니다(${owner}) ${CONNECT}` };
  } catch (e) {
    return { warning: `Linear 토큰이 만료됐거나 갱신에 실패했습니다(${owner}): ${(e as Error).message} ${CONNECT}` };
  }
}

export const linearVaultDeps: LinearVaultDeps = {
  resolve: async (memberId, allowFallback) => { const { resolveOAuthMemberSecret } = await import("./oauth-proxy-auth.js"); return resolveOAuthMemberSecret(memberId, LINEAR_APP_KIND, { scopeKey: "", allowFallback }, resolveMemberSecret); },
  bearer: async (resolved) => { const { resolveProxyBearer } = await import("./oauth-proxy-auth.js"); return resolveProxyBearer(resolved, LINEAR_APP_KIND); },
};

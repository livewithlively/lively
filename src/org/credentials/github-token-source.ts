// GitHub 수집기 토큰 출처 해소(#2247) — token_source="org" | "member:<id>" 를 금고의 github_pat 슬롯으로 푼다.
//
//  ⚠ 같은 슬롯에 두 형태가 산다(#1881 G5): 사람이 붙여넣은 **정적 PAT**(ghp_…, scope_key=호스트)과 [GitHub 연결]이
//  저장한 **토큰 묶음**(JSON + meta.expires_at, scope_key=""). 묶음을 그대로 헤더에 실으면 상류가 전부 401 을 주고,
//  손으로 JSON 을 까면 8시간 뒤 만료 때 죽는다. 그래서 여기서는 **직접 파싱하지 않고** http_proxy 가 쓰는 부품
//  (resolveOAuthMemberSecret → resolveProxyBearer: 묶음/정적 판별·만료 갱신·금고 재기록)을 그대로 쓴다.
//  분업은 슬랙·피그마와 같다: 순수 슬롯 선택(주입 가능한 표) + 실제 금고 리더.
import { GATEWAY_OWNER, listMemberSecretsPublic, resolveMemberSecret, type MemberSecretPublic, type MemberSecretResolved } from "./member-secret-store.js";
//  ⚠ oauth-proxy-auth 는 **동적 import** — 정적으로 물면 connectors/config → 여기 → oauth-proxy-auth → oauth-broker → org/store →
//   org/store/collectors → connectors/config 순환이 생긴다(check-imports 게이트). 해소 시점에만 필요한 부품이라 그때 든다.

export const GITHUB_TOKEN_KIND = "github_pat";
export interface GithubTokenResolution { token?: string; warning?: string }

/**
 * 그 사람의 github_pat 슬롯 중 **어느 것을 쓸지** — 순수. 호스트 일치(정적 PAT) > 빈 scope_key(OAuth 묶음) > 첫 것.
 *  대소문자만 다른 호스트도 같은 것으로 본다(DNS 는 대소문자 무시 — repo-discover 와 같은 규칙).
 */
export function pickGithubSlot(rows: MemberSecretPublic[], host: string): MemberSecretPublic | null {
  const h = String(host ?? "github.com").trim().toLowerCase();
  const mine = rows.filter((r) => r.kind === GITHUB_TOKEN_KIND && r.has_secret);
  return mine.find((r) => r.scope_key.toLowerCase() === h)
    ?? mine.find((r) => r.scope_key === "")
    ?? mine[0] ?? null;
}

export interface GithubVaultDeps {
  list: (owner: string) => Promise<MemberSecretPublic[]>;
  resolve: (memberId: string | null, scopeKey: string, allowFallback: boolean) => Promise<MemberSecretResolved | null>;
  bearer: (resolved: MemberSecretResolved) => Promise<string>;
}

const CONNECT = "— [외부 앱 연결 ▸ GitHub]에서 계정을 연결하거나 토큰을 저장하세요";

export async function resolveGithubTokenSource(
  source: string | undefined, host: string, deps: GithubVaultDeps,
): Promise<GithubTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null; // 미지정 = 종전 경로(수집기 폼에 붙여넣은 토큰)
  const isOrg = s === "org";
  const isMember = s.startsWith("member:") && s.slice(7).trim().length > 0;
  if (!isOrg && !isMember) return { warning: `알 수 없는 token_source '${s}' — org 또는 member:<구성원 id> 여야 합니다` };
  const memberId = isMember ? s.slice(7).trim() : null;
  const owner = isOrg ? GATEWAY_OWNER : `member:${memberId}`;
  const rows = await deps.list(owner).catch(() => []);
  const slot = pickGithubSlot(rows, host);
  if (!slot) {
    return { warning: isOrg
      ? `조직 공용 GitHub 토큰이 없습니다 — 관리탭 ▸ 자격 금고에 github_pat 을 등록하거나 token_source 를 member:<구성원 id> 로 바꾸세요`
      : `${owner} 의 GitHub 연결이 없습니다 ${CONNECT}` };
  }
  const resolved = await deps.resolve(memberId, slot.scope_key, isOrg).catch(() => null);
  if (!resolved?.secret) return { warning: `GitHub 토큰을 읽지 못했습니다(${owner}) ${CONNECT}` };
  try {
    const token = await deps.bearer(resolved);
    return token ? { token } : { warning: `GitHub 토큰이 비어 있습니다(${owner}) ${CONNECT}` };
  } catch (e) {
    // 만료 갱신 실패(refresh token 소진·앱 자격 소실) — 옛 토큰으로 계속 긁지 않는다.
    return { warning: `GitHub 토큰 갱신에 실패했습니다(${owner}): ${(e as Error).message} ${CONNECT}` };
  }
}

/** 실제 금고 리더 — 커넥터 설정 해소(connectors/config.ts)가 쓴다. */
export const githubVaultDeps: GithubVaultDeps = {
  list: (owner) => listMemberSecretsPublic(owner),
  resolve: async (memberId, scopeKey, allowFallback) => {
    const { resolveOAuthMemberSecret } = await import("./oauth-proxy-auth.js");
    return resolveOAuthMemberSecret(memberId, GITHUB_TOKEN_KIND, { scopeKey, allowFallback }, resolveMemberSecret);
  },
  bearer: async (resolved) => { const { resolveProxyBearer } = await import("./oauth-proxy-auth.js"); return resolveProxyBearer(resolved, GITHUB_TOKEN_KIND); },
};

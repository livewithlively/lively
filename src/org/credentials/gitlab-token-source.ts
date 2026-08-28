// GitLab 수집기 토큰 출처 해소(#2247) — token_source="org" | "member:<id>" 를 금고의 gitlab_pat 슬롯으로 푼다.
//
//  ⚠ GitLab 은 [계정 로그인](MCP, DCR)으로 받은 토큰으로는 REST 를 못 부른다(scope 가 mcp 로 묶인다 —
//  mcp-server-presets.ts 참조). 그래서 수집은 **개인 액세스 토큰(gitlab_pat, read_api)** 만 쓴다.
//  gitlab_pat 의 scope_key 는 **호스트**다(회사 GitLab 이 여럿일 수 있다) — 수집기 host 와 맞는 슬롯을 고르고,
//  host 가 비어 있으면 슬롯의 호스트를 수집기 host 로 쓴다.
import { GATEWAY_OWNER, listMemberSecretsPublic, resolveMemberSecret, type MemberSecretPublic } from "./member-secret-store.js";
import { bearerOf } from "../repo-discover.js";

export const GITLAB_TOKEN_KIND = "gitlab_pat";
export interface GitlabTokenResolution { token?: string; host?: string; warning?: string }

/** 슬롯 선택 — 호스트 일치(대소문자 무시) > 빈 scope_key > 첫 것. 순수. */
export function pickGitlabSlot(rows: MemberSecretPublic[], host: string | undefined): MemberSecretPublic | null {
  const h = String(host ?? "").trim().toLowerCase();
  const mine = rows.filter((r) => r.kind === GITLAB_TOKEN_KIND && r.has_secret);
  if (h) { const hit = mine.find((r) => r.scope_key.toLowerCase() === h); if (hit) return hit; }
  return mine.find((r) => r.scope_key === "") ?? mine[0] ?? null;
}

export interface GitlabVaultDeps {
  list: (owner: string) => Promise<MemberSecretPublic[]>;
  secret: (memberId: string | null, scopeKey: string, allowFallback: boolean) => Promise<string | null>;
}

const CONNECT = "— [외부 앱 연결 ▸ GitLab]에서 개인 액세스 토큰(read_api)을 저장하세요";

export async function resolveGitlabTokenSource(
  source: string | undefined, host: string | undefined, deps: GitlabVaultDeps,
): Promise<GitlabTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null;
  const isOrg = s === "org";
  const isMember = s.startsWith("member:") && s.slice(7).trim().length > 0;
  if (!isOrg && !isMember) return { warning: `알 수 없는 token_source '${s}' — org 또는 member:<구성원 id> 여야 합니다` };
  const memberId = isMember ? s.slice(7).trim() : null;
  const owner = isOrg ? GATEWAY_OWNER : `member:${memberId}`;
  const rows = await deps.list(owner).catch(() => []);
  const slot = pickGitlabSlot(rows, host);
  if (!slot) {
    return { warning: isOrg
      ? `조직 공용 GitLab 토큰이 없습니다 — 관리탭 ▸ 자격 금고에 gitlab_pat 을 등록하거나 token_source 를 member:<구성원 id> 로 바꾸세요`
      : `${owner} 의 GitLab 토큰이 없습니다 ${CONNECT}` };
  }
  const secret = await deps.secret(memberId, slot.scope_key, isOrg).catch(() => null);
  if (!secret) return { warning: `GitLab 토큰을 읽지 못했습니다(${owner}) ${CONNECT}` };
  const resolvedHost = String(host ?? "").trim().toLowerCase() || slot.scope_key.toLowerCase() || "gitlab.com";
  return { token: bearerOf(secret), host: resolvedHost };
}

export const gitlabVaultDeps: GitlabVaultDeps = {
  list: (owner) => listMemberSecretsPublic(owner),
  secret: async (memberId, scopeKey, allowFallback) => (await resolveMemberSecret(memberId, GITLAB_TOKEN_KIND, { scopeKey, allowFallback }))?.secret ?? null,
};

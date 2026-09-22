// Outlook 수집기 토큰 출처(#4211) — token_source="member:<id>" → 그 사람 금고의 microsoft_oauth 슬롯(연결 묶음).
//  묶음·만료 판별·갱신(새 refresh_token 덮어쓰기 포함)은 http_proxy 와 **같은 부품**(resolveOAuthMemberSecret → resolveProxyBearer)이다 —
//  수집기가 따로 갱신 규칙을 들고 있으면 도구와 수집이 서로 다른 토큰을 쓰다 한쪽이 상대의 refresh_token 을 죽인다
//  (Microsoft 는 갱신 때 새 refresh_token 을 줄 수 있고 옛 것을 회수할 수 있다 — 저장 자리가 하나여야 한다).
//
//  ⚠ 구글과 다른 점 — 액세스 토큰을 **매 쪽마다 새로 해소한다**(커넥터 config 캐시에 싣지 않는다). Microsoft 액세스 토큰은
//   60~90분이라 첫 수집(메일함 전체)이 그보다 길면 캐시한 토큰이 도중에 죽는다. 해소는 금고 한 번 읽기 + 만료 60초 전이면 갱신.
//  출처를 명시했으면 **그 출처만** 쓴다(붙여넣기 폴백 없음 — Outlook 은 붙여넣기 칸 자체가 없다).
import { resolveMemberSecret, type MemberSecretResolved } from "./member-secret-store.js";
import { MICROSOFT_KIND } from "./microsoft-oauth.js";
//  ⚠ oauth-proxy-auth 는 동적 import — linear-token-source 와 같은 이유(connectors/config 쪽 import 순환).

export interface MicrosoftTokenResolution { token?: string; warning?: string }
export interface MicrosoftVaultDeps {
  resolve: (memberId: string) => Promise<MemberSecretResolved | null>;
  bearer: (resolved: MemberSecretResolved) => Promise<string>;
}
const CONNECT = "— [외부 앱 연결 ▸ Outlook]에서 [Outlook 연결]을 다시 하거나, 다른 사람의 연결로 [자료 가져오기]를 켜세요";

/** 순수에 가까운 해소(금고는 주입) — 테스트가 표의 행을 DB 없이 돈다. null = 출처 미지정. */
export async function resolveMicrosoftTokenSource(source: string | undefined, deps: MicrosoftVaultDeps): Promise<MicrosoftTokenResolution | null> {
  const s = String(source ?? "").trim();
  if (!s) return null;
  const id = s.startsWith("member:") ? s.slice(7).trim() : "";
  if (!id) return { warning: `알 수 없는 token_source '${s}' — member:<구성원 id> 여야 합니다(Outlook 은 사람의 연결로만 돈다)` };
  const resolved = await deps.resolve(id).catch(() => null);
  if (!resolved?.secret) return { warning: `구성원 '${id}' 의 Outlook 연결이 없습니다 ${CONNECT}` };
  try {
    const token = await deps.bearer(resolved);
    return token ? { token } : { warning: `Outlook 토큰이 비어 있습니다(${id}) ${CONNECT}` };
  } catch (e) {
    return { warning: `Outlook 연결이 만료됐거나 갱신에 실패했습니다(${id}): ${(e as Error).message} ${CONNECT}` };
  }
}

/** 실제 금고 — 개인 슬롯만(allowFallback:false). 조직 슬롯으로 떨어지면 «누구 메일인지» 가 바뀐다. */
export const microsoftVaultDeps: MicrosoftVaultDeps = {
  resolve: async (memberId) => {
    const { resolveOAuthMemberSecret } = await import("./oauth-proxy-auth.js");
    return resolveOAuthMemberSecret(memberId, MICROSOFT_KIND, { scopeKey: "", allowFallback: false }, resolveMemberSecret);
  },
  bearer: async (resolved) => {
    const { resolveProxyBearer } = await import("./oauth-proxy-auth.js");
    return resolveProxyBearer(resolved, MICROSOFT_KIND);
  },
};

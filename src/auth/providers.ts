// 인증 제공자(authn) seam — 사람 웹 로그인의 '누구인가' 입증 레이어를 갈아끼우는 자리(P4: local + OIDC).
//  핵심 설계: authz(scope)·세션·멤버매핑은 제공자와 무관하게 공통(sessions.ts) — 제공자는 '이메일 신원'만 입증한다.
//  → 그 설계대로 OIDC(#1520)는 이 파일의 등록 한 줄 + auth/oidc*.ts 로 들어왔고, 세션·권한·UI 매핑은
//    재작성하지 않았다. 세 번째 제공자(SAML 등)가 와도 같은 자리다.
//
//  local(이메일+비번, local-accounts.ts)은 항상 켜져 있다. OIDC 는 배포별 설정(OIDC_ISSUER/CLIENT_ID/SECRET)이
//  다 있을 때만 켜진다 — ee/auth/oidc.ts 의 oidcConfig() 가 그 판정의 단일 출처다.
//  멀티 IdP 고객/에어갭(IdP 없음)을 위해 local 은 영구 폴백 tier 로 남는다: IdP 가 죽어도 관리자는 들어올 수
//  있어야 하고(락아웃 방지), 사내망 온프렘엔 IdP 자체가 없는 배포도 있다.
//
//  ★ #1601 — SSO 구현은 Enterprise(src/ee)로 갔고, 이 파일은 코어에 남는 seam 이다. EE 미탑재면 훅이 없어
//   목록에 local 하나만 남는다 — **그게 정상 동작이다**(거부하지 않는다). 위 '영구 폴백 tier' 설계가 곧
//   무료판의 온전함을 보장한다: SSO 가 없어도 로그인은 된다.
import { ee } from "../enterprise/registry.js";

export type ProviderKind = "local" | "oidc";

export interface AuthProviderInfo {
  kind: ProviderKind;
  label: string;        // 로그인 화면 표기
  enabled: boolean;
}

// 활성 제공자 목록(로그인 UI 가 무엇을 띄울지) — 로그인 화면·OAuth 동의 화면이 이 목록으로 버튼을 그린다.
//  무인증 표면에 노출되는 값이라 라벨 말고는 아무것도 담지 않는다(issuer·client_id 도 내보내지 않는다).
//  async 인 이유: 설정이 관리탭(DB)에도 있을 수 있다 — 재기동 없이 켜고 끄려면 매번 확인해야 한다.
export async function activeProviders(): Promise<AuthProviderInfo[]> {
  const providers: AuthProviderInfo[] = [
    { kind: "local", label: "이메일 + 비밀번호", enabled: true },
  ];
  const sso = await ee().sso?.ssoProvider();
  if (sso) providers.push({ kind: "oidc", label: sso.label, enabled: true });
  return providers;
}

// OIDC 가 켜져 있나 — 버튼을 그릴지 판단하는 자리들이 쓰는 짧은 질의.
export const oidcEnabled = async (): Promise<boolean> =>
  (await activeProviders()).some((p) => p.kind === "oidc" && p.enabled);

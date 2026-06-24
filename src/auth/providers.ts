// 인증 제공자(authn) seam — 사람 웹 로그인의 '누구인가' 입증 레이어를 갈아끼우는 자리(P4: local now / OIDC later).
//  핵심 설계: authz(scope)·세션·멤버매핑은 제공자와 무관하게 공통(sessions.ts) — 제공자는 '이메일 신원'만 입증한다.
//  → OIDC 추가 = 이 파일에 'oidc' 구현을 더하고 activeProviders() 에 등록하는 것뿐(세션·권한·UI 매핑 재작성 없음).
//
//  현재는 local(이메일+비번, local-accounts.ts) 고정. OIDC 는 배포별 설정(issuer/client/secret)으로 켠다.
//  멀티 IdP 고객/에어갭(IdP 없음)을 위해 local 은 영구 폴백 tier 로 남는다.
export type ProviderKind = "local" | "oidc";

export interface AuthProviderInfo {
  kind: ProviderKind;
  label: string;        // 로그인 화면 표기
  enabled: boolean;
}

// 활성 제공자 목록(로그인 UI 가 무엇을 띄울지) — 배포별 설정 자리. 현재 local 고정.
export function activeProviders(): AuthProviderInfo[] {
  return [
    { kind: "local", label: "이메일 + 비밀번호", enabled: true },
    // { kind: "oidc", label: "회사 SSO", enabled: !!process.env.OIDC_ISSUER }, // ← 추후 배포별 opt-in
  ];
}

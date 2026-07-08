// #699 per-member 유효 가시성 규칙 — 단일 진실원천(SoT).
//  하네스 자산(org_harness_asset)·커스텀 훅(org_hook)이 특정 멤버에게 배포되는지 결정하는 규칙.
//  ⚠ 이 규칙은 세 곳이 **똑같이** 구현한다 — 드리프트 금지:
//   1) store.listEnabledAssets / listEnabledHooks 의 SQL CASE (런너/materializer 실제 게이팅)
//   2) delivery.me_assets_get 의 JS (멤버 셀프 화면 표시)
//   3) 이 함수 (위 둘의 spec, asset-visibility.test.ts 로 진리표 고정)
//
//  2층 모델: 관리자 정책(enabled + target_members) 위에 멤버 개인 오버라이드(org_asset_pref.state).
//   - enabled=false  → 무조건 미배포(마스터킬, 오버라이드도 못 켬)
//   - override 존재   → 그 값이 우선(true=강제 on/opt-in, false=강제 off/opt-out)
//   - override 없음   → 정책 기본값: target_members NULL/빈=전원, 배열=그 멤버 포함 시만(익명/미지=제외)

// 관리자 정책 기본값만으로 이 멤버가 대상인가 (오버라이드 무시).
export function targetsMember(targetMembers: string[] | null | undefined, memberId: string | null): boolean {
  if (!targetMembers || targetMembers.length === 0) return true; // NULL/빈 = 전원
  return memberId !== null && targetMembers.includes(memberId);  // 지정 = 포함 시만(익명 제외)
}

// 최종 유효 가시성 — 마스터킬 → 오버라이드 → 정책 기본값 순.
export function effectiveVisible(opts: {
  enabled: boolean;
  targetMembers: string[] | null | undefined;
  memberId: string | null;
  override: boolean | null; // org_asset_pref.state, 없으면 null
}): boolean {
  if (!opts.enabled) return false;                 // 마스터킬
  if (opts.override !== null) return opts.override; // 개인 오버라이드 우선
  return targetsMember(opts.targetMembers, opts.memberId); // 정책 기본값
}

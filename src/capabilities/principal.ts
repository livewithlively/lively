// 요청 신원(principal) 판정 — 이 요청이 **누구로** 보이는가(viewerOf) · **조직 운영 권한인가**(isAdmin).
//  #1313 R25: 원래 조립자(capabilities/index.ts)에 있었다. 그 결과 이 3줄 판정만 필요한 소비자(lists-v6·trash·
//  tools/db·project-routes·terminal-files)가 registry 전체(delivery 포함 수백 op)를 끌어 오고, capability 파일이
//  조립자를 역-import 하는 순환(index ↔ lists-v6 / trash)까지 생겼다. 그래서 **import 0 의 leaf** 로 분리한다 —
//  새 소비자는 여기를 직결 import 할 것(index.js 재수출은 기존 스펙 호환 shim 일 뿐이다).
//
// 맥락 가시성(#1291) — 이 요청의 열람 신원. **어댑터 두 곳에서만** 판정한다(MCP·REST 가 같은 규칙을 타는 지점).
//  ⚠ v2 에서 뒤집었다: **admin 도 우회하지 않는다.**
//   admin 신원은 그 사람의 AI 세션이 그대로 물려받는다 — 우회를 허용하면 admin 이 돌리는 자동화(분류기·증류기·
//   상시 세션·크론)가 잠긴 내용을 읽어 **공개 지식으로 되뱉는다**. 사람 한 명의 열람보다 이 재방출이 위험하다.
//   운영이 멈추지 않도록 두 가지를 함께 둔다: ①거버넌스 메타데이터(존재·이름·대상·개수·감사 이벤트)는 계속 보이고
//   ②사유를 적고 여는 **긴급 열람**(v6/visibility.ts)이 감사·통지와 함께 한시적으로 우회한다.
//   신원이 없는 호출(내부 시스템 경로)만 null(특권)이다.
export function viewerOf(u: { userId?: string; scopes?: string[] } | undefined): string | null {
  return u?.userId || null;
}

/**
 * 이 요청이 **워크스페이스 관리**를 할 수 있나(2026-09-12 대표 결정).
 *  «워크스페이스를 어떻게 굴릴까»(외부 앱 연결·수집·증류·분류·도구·경보·예약·아웃바운드)는 관리자 전용이 아니다 —
 *  일상적으로 굴리는 사람이 곧 고치는 사람이다(#1289 «누구나 관리» 의 연장). 그래서 워킹레벨 scope(memory)로 잰다.
 *  ⚠ **인원 관리는 여기 해당하지 않는다** — 구성원 추가·제거·권한 변경·비밀번호 초기화·토큰 발급은 admin,
 *   워크스페이스 초대·내보내기는 owner 판정(delivery/workspace-registry.ts)이다. 그 둘은 이 술어로 열지 마라.
 */
export function canManageWorkspace(u: { scopes?: string[] } | undefined): boolean {
  return !!u?.scopes?.includes("memory") || !!u?.scopes?.includes("admin");
}

/** 이 요청이 조직 운영 권한(admin)인가 — 가시성 우회가 아니라 **메타데이터 노출·관리 표면** 판정에 쓴다. */
export function isAdmin(u: { scopes?: string[] } | undefined): boolean {
  return !!u?.scopes?.includes("admin");
}

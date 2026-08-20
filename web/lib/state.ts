// lib/state.ts — 앱 전역 상태 싱글턴(#1313 R29b). core.ts 에서 **verbatim 이동**(로직 변경 0).
//  ⚠ state 는 **모듈 전역 mutable 싱글턴**이다 — 모든 화면이 같은 바인딩을 봐야 하므로 소유 모듈은 하나뿐이고
//   여기서만 산다(ESM import 바인딩은 소비 측에서 재할당 불가 — 값 변경은 state 의 속성으로만).
//  의존 0(leaf) — state 를 읽는 판정 헬퍼(hasScope·visAxisOn)도 여기 동거시켜 표면마다 사본이 생기는 걸 막는다.
//  소비 파일은 종전대로 './core.js' 에서 받는다(core 의 배럴 재수출).

interface AppState {
  me: any;
  knowledge: any;
  reviewOrderBy: string;
  admin: any;
  start: any;
  domains: any;
  allDomains: any;
  [k: string]: any;
}
const state: AppState = {
  me: null,
  knowledge: { space: 'business', category: '', injection: '', provenance: '', q: '' }, // 지식 탭(#/knowledge) 필터 상태(2분할 뷰)
  reviewOrderBy: 'updated_at', // 검토 피드 정렬(기본 최신순)
  admin: { data: null, sel: null, tab: {}, memberSel: null, memberEditing: false, memberSearch: '', memorySel: null, repoSel: null, navCollapsed: false }, // 관리 페이지 상태 (tab = 섹션별 서브탭 선택, #837)
  start: { mode: 'web', os: 'mac', token: null }, // '시작하기 > 설치' 온보딩 상태(쓰는곳 web|local + 선택 OS + 자가발급 토큰 1회 캐시)
  domains: {},           // P-V3-4a: repo별 도메인 통제어휘 캐시 { [repo]: {list, repos, loaded, error} }
  allDomains: null,      // V5 탈-repo: 전 repo + business 통합 통제어휘 캐시(저장/필터 드롭다운) {list, loaded, error}
};

// 현재 토큰이 가진 scope 보유 여부(/api/ui/me 의 scopes). 어휘 CRUD 권한(context) 판정에 쓴다.
//  state 소유자인 여기에 둔다(#1313 R27 — 구 admin.ts 홈스테드. admin.ts 가 재수출하므로 호출부 무변경).
export function hasScope(s) {
  return !!(state.me && Array.isArray(state.me.scopes) && state.me.scopes.includes(s));
}

// 맥락 공개범위 축(#1291) — 이 축이 켜져 있나. **화면이 설정 UI·자물쇠를 그릴지 판단하는 단일 규칙**이다.
//  축이 꺼졌는데 폼을 계속 그리면 "설정했는데 안 걸린다", 자물쇠를 계속 그리면 "잠긴 줄 알았는데 전원이 본다" —
//  둘 다 화면이 거짓말하는 것이라 강제를 끄는 것만으론 부족하다.
//  ⚠ 표면마다 state.me.vis_axes 를 직접 뒤지지 마라. 그 순간 사본이 생기고 한쪽만 고쳐진다.
//  값을 못 받았으면(구 서버·조회 실패) **켜짐으로 본다** — 종전 화면 그대로가 안전한 쪽이다.
function visAxisOn(axis: string): boolean {
  const ax = state.me && (state.me as any).vis_axes;
  if (!ax) return true;
  return ax[axis] !== false;
}

// UI 내비 게이팅(#1454 S2) — 이 상단 탭이 켜져 있나. **탭 숨김·라우트 가드·가이드 필터가 공유하는 단일 규칙**이다
//  (main.ts 탭 hidden/딥링크 가드 · learn.ts 메뉴 가이드 · guide-tour.ts 둘러보기 — 표면마다 me.ui_nav 를 직접
//  뒤지면 visAxisOn 의 경고 그대로 사본이 생기고 한쪽만 고쳐진다). 값을 못 받았거나 ui_nav 가 빈 객체면
//  **전부 켜짐**(구 서버·셀프호스트 = 종전 화면 그대로) — {tabs:{context:false}} 처럼 명시적 false 인 탭만 숨긴다.
function navOn(tab: string): boolean {
  const nav = state.me && (state.me as any).ui_nav;
  const tabs = nav && nav.tabs;
  if (!tabs) return true;
  return tabs[tab] !== false;
}

// 화면 셸 판정(#1719) — 새 1탭 셸('v2') vs 종전 탭 셸('classic'). **셸을 고르는 단일 규칙**이다(main.ts boot 만 부른다).
//  우선순위: ① URL ?ui=classic|v2 (이번 로드에만 — 링크로 상대 화면을 보여줄 때)
//           ② 브라우저 로컬 오버라이드 localStorage[lively_ui_mode] (관리탭 [화면] 의 '이 브라우저에서만' 버튼)
//           ③ 조직 기본 me.ui_mode (org_runtime_config.ui_mode — 관리자가 정함, 매니지드는 컨트롤플레인이 push)
//           ④ 'classic' (제품 기본 — 대표 결정 2026-08-20: v2 는 베타라 완성 전까지 opt-in. 서버가 값을 못 줘도 종전 화면)
//  새 화면(베타)을 쓰려면 ③ 을 v2 로 올리거나(조직), 관리탭 [화면] 의 '이 브라우저에서만'으로 개인만 켠다.
const UI_MODE_KEY = 'lively_ui_mode';
type UiMode = 'v2' | 'classic';
function uiMode(): UiMode {
  try {
    const q = new URLSearchParams(location.search).get('ui');
    if (q === 'classic' || q === 'v2') return q;
    const o = localStorage.getItem(UI_MODE_KEY);
    if (o === 'classic' || o === 'v2') return o;
  } catch (_) { /* localStorage 접근 불가(프라이버시 모드 등) → 조직 기본으로 */ }
  const m = state.me && (state.me as any).ui_mode;
  return m === 'v2' ? 'v2' : 'classic';
}
// 로컬 오버라이드 쓰기 — null 이면 해제(조직 기본으로 복귀). 관리탭 [화면] 과 새 셸의 '클래식으로' 링크가 쓴다.
function setUiModeOverride(m: UiMode | null): void {
  try { if (m) localStorage.setItem(UI_MODE_KEY, m); else localStorage.removeItem(UI_MODE_KEY); } catch (_) { /* noop */ }
}
function uiModeOverride(): UiMode | null {
  try { const o = localStorage.getItem(UI_MODE_KEY); return o === 'classic' || o === 'v2' ? o : null; } catch (_) { return null; }
}

export type { AppState, UiMode };
export {
  state,
  visAxisOn,
  navOn,
  uiMode,
  setUiModeOverride,
  uiModeOverride,
};

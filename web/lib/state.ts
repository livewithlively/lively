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
  knowledge: { category: '', injection: '', provenance: '', q: '' }, // 지식 탭(#/knowledge) 필터 상태
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
//           ④ 'v2' (제품 기본 — 대표 결정 2026-08-27: **클래식이 기본이 되는 상황을 하나도 두지 않는다.**
//              서버가 값을 못 줘도 새 화면이다. 클래식은 ①~③ 에서 누군가 **고른** 값일 때만 나온다.)
//  클래식으로 보려면 ③ 을 classic 으로 내리거나(조직), 관리탭 [화면]·내 정보의 '클래식 화면으로 바꾸기'로 이 브라우저만 바꾼다.
const UI_MODE_KEY = 'lively_ui_mode';
//  클래식 시대 닫기(#2208) — 이 브라우저에서 옛 classic 을 **딱 한 번** 걷었다는 도장.
//   #2200 이 서버 행에 한 것(컬럼 기본값이 아직 classic 인 부팅을 걸쇠로 1회 UPDATE)의 브라우저 판이다.
//   그때 브라우저는 일부러 안 건드렸는데, 2026-08-20~27 '클래식이 조직 기본'이던 시대를 지나온 브라우저에는
//   아무도 고르지 않은 classic 이 그대로 굳어 있었다 — 서버가 v2 를 줘도 ②에서 걸려 ③·④ 까지 못 간다
//   (실측 2026-08-27, 상민님: dev 서버는 v2 인데 화면은 레일도 사이드바도 없는 완전한 클래식).
const SWEPT_KEY = 'lively_ui_mode_swept';
type UiMode = 'v2' | 'classic';
/**
 * 옛 classic 오버라이드 1회 정리(#2208). **도장이 없을 때만** 돈다.
 *  ⚠ 도장은 지우기보다 **먼저** 찍는다 — 아래가 실패해도 두 번 돌지 않게. 그리고 setUiModeOverride 도 같은 도장을
 *   찍으므로, 사람이 **고른** 클래식은 이 정리를 타지 않는다. 그 순서가 없으면 [클래식 화면으로 바꾸기] 가
 *   눌러도 reload 때 곧바로 되돌려져 **버튼이 아예 작동하지 않는다**.
 */
function sweepLegacyClassic(): void {
  try {
    if (localStorage.getItem(SWEPT_KEY)) return;
    localStorage.setItem(SWEPT_KEY, '1');
    if (localStorage.getItem(UI_MODE_KEY) === 'classic') localStorage.removeItem(UI_MODE_KEY);
  } catch (_) { /* localStorage 접근 불가(프라이버시 모드 등) → 어차피 ②를 못 읽으니 조직 기본으로 간다 */ }
}
function uiMode(): UiMode {
  sweepLegacyClassic();   // ★ ② 를 읽기 전에 — 옛 시대의 잔재는 '고른 값'이 아니다(#2208)
  try {
    const q = new URLSearchParams(location.search).get('ui');
    if (q === 'classic' || q === 'v2') return q;
    const o = localStorage.getItem(UI_MODE_KEY);
    if (o === 'classic' || o === 'v2') return o;
  } catch (_) { /* localStorage 접근 불가(프라이버시 모드 등) → 조직 기본으로 */ }
  const m = state.me && (state.me as any).ui_mode;
  return m === 'classic' ? 'classic' : 'v2';   // 값 부재·구 서버·잡값 → 새 화면(클래식은 고른 값일 때만)
}
// 로컬 오버라이드 쓰기 — null 이면 해제(조직 기본으로 복귀). 관리탭 [화면] 과 새 셸의 '클래식으로' 링크가 쓴다.
//  ⚠ 함께 도장을 찍는다 — 이 순간부터 그 값은 **사람이 고른 것**이라 #2208 정리의 대상이 아니다.
function setUiModeOverride(m: UiMode | null): void {
  try {
    localStorage.setItem(SWEPT_KEY, '1');
    if (m) localStorage.setItem(UI_MODE_KEY, m); else localStorage.removeItem(UI_MODE_KEY);
  } catch (_) { /* noop */ }
}
function uiModeOverride(): UiMode | null {
  try { const o = localStorage.getItem(UI_MODE_KEY); return o === 'classic' || o === 'v2' ? o : null; } catch (_) { return null; }
}

// ── 셸을 바꾼 직후 그 자리를 되짚어 준다(#1898) ────────────────────────────────
//  셸 전환은 페이지를 통째로 다시 띄운다(reload) — 사람이 방금 누른 자리(내 프로필·환경설정 창)가 통째로
//  사라지고, 화면 골격까지 바뀐 채로 남겨진다. 그래서 **새 셸이 뜨면 그 창을 다시 연다**: 되돌리는 버튼이
//  다시 눈앞에 있어야 한다. 안 그러면 클래식으로 내려간 사람은 되돌아올 길을 설정에서 찾아 들어가야 하고,
//  그 길(관리탭 [화면])은 매니지드에서 감춰져 있다(admin-shell PERSONAL_HIDDEN).
//  sessionStorage = **그 탭 한정 · 1회용**(읽는 즉시 지운다) — 다른 탭·다음 방문까지 따라가면 안 된다.
const SWITCH_KEY = 'lively_ui_mode_switched';
/** 셸을 바꾸기 직전에 찍는다 — 다음 부팅이 이걸 보고 창을 되연다. */
function markShellSwitch(): void {
  try { sessionStorage.setItem(SWITCH_KEY, '1'); } catch (_) { /* 저장 불가 → 되열기만 없다(전환 자체는 정상) */ }
}
/** 부팅이 한 번만 읽는다(읽으면 지운다). 두 셸의 boot 가 각자 자기 창을 연다. */
function takeShellSwitch(): boolean {
  try {
    if (sessionStorage.getItem(SWITCH_KEY) !== '1') return false;
    sessionStorage.removeItem(SWITCH_KEY);
    return true;
  } catch (_) { return false; }
}

export type { AppState, UiMode };
export {
  state,
  visAxisOn,
  navOn,
  uiMode,
  setUiModeOverride,
  uiModeOverride,
  markShellSwitch,
  takeShellSwitch,
};

// 테마(#1683) — 시스템/라이트/다크 3단.
//  저장: localStorage 'lv:theme' 에 'light'|'dark' 만 쓴다(시스템 따름 = 키 없음 — 기본값이 저장을 남기지 않게).
//  적용: <html data-theme="dark|light"> 명시 시 그 테마, 속성 없음 = 시스템(@media prefers-color-scheme).
//  첫 페인트: index.html <head> 의 pre-paint 인라인 스크립트가 같은 키를 읽어 CSS 로드 전에 속성을 찍는다(FOUC 0).
//  여기는 그 뒤의 런타임 전환·다른 탭 동기화·시스템 설정 변경 추적만 담당한다.
//  터미널(항상 다크)·graph(다크 특례)는 이 축 밖 — 그 문서들은 pre-paint 를 싣지 않는다.

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'lv:theme';

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch { /* 스토리지 막힌 브라우저 — 이 탭에서만이라도 적용한다 */ }
  applyTheme();
}

/** 현재 렌더가 다크인가 — 차트·인라인 색을 고르는 코드용(설정값이 아니라 '실제 화면'). */
export function isDark(): boolean {
  const p = themePref();
  if (p !== 'system') return p === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 저장된 선호를 <html data-theme> 에 반영하고 lv:theme-change 를 쏜다(차트 등 재렌더 훅). */
export function applyTheme(): void {
  const de = document.documentElement;
  const p = themePref();
  if (p === 'system') de.removeAttribute('data-theme');
  else de.setAttribute('data-theme', p);
  document.dispatchEvent(new CustomEvent('lv:theme-change'));
}

let watching = false;
/** 다른 탭·임베드 iframe 에서의 변경(storage)과 OS 설정 변경(matchMedia)을 따라간다. 한 번만 배선. */
export function watchTheme(): void {
  if (watching) return;
  watching = true;
  window.addEventListener('storage', (e) => { if (e.key === KEY) applyTheme(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref() === 'system') applyTheme();
  });
}

// ── 토글 UI 공용 조각 ──
export const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];
export const THEME_LABEL: Record<ThemePref, string> = { system: '시스템 설정을 따릅니다', light: '라이트', dark: '다크' };

/** 클래식 상단바용 순환 버튼 다음 값 */
export function nextTheme(p: ThemePref): ThemePref {
  return THEME_ORDER[(THEME_ORDER.indexOf(p) + 1) % THEME_ORDER.length];
}

/** 상태별 아이콘(stroke 1.7 라인 문법 — 이모지 금지). system=자동(반달), light=해, dark=달. */
export function themeIconSvg(p: ThemePref): string {
  if (p === 'light') return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></svg>';
  if (p === 'dark') return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/></svg>';
  // system — 해/달 반반(원 왼쪽 절반 채움)
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4A8.2 8.2 0 0 1 12 3.8Z" fill="currentColor" stroke="none"/></svg>';
}

export function themeTitle(p: ThemePref): string {
  const now = p === 'system' ? '시스템 설정을 따르는 중' : p === 'light' ? '라이트 테마' : '다크 테마';
  const nx = nextTheme(p);
  const nxLab = nx === 'system' ? '시스템' : nx === 'light' ? '라이트' : '다크';
  return `테마: ${now} — 누르면 ${nxLab}로 바뀝니다.`;
}

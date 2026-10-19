// v2/glass-icon.ts: 앱 아이콘(앱 화면 · 홈의 최근 연 앱 · 「맥락 관리」 표지의 문패)의 집.
//  #4233(원준 2026-09-27 「아이콘 · 이름 고르기」): 앱마다 따로 그리던 유리 겹침 그림(#1841)을 걷었다.
//   이제 **타일 하나 + 선 아이콘 하나**다. 고른 것: 반투명 흰 타일과 색 선 · 앱마다 다른 색 · 둥근 사각.
//   선 아이콘은 레일 · 사이드바와 같은 그림(lib/icon-paths.ts)이라, 그 표를 고치면 앱 아이콘도 함께 바뀐다.
//  이름(appGlassIcon)과 부르는 법은 그대로 둔다. 부르는 곳 셋(v2/apps.ts · v2/views.ts · context-map.ts)을 고치지 않는다.
//  ⚠ 셸 레지스트리(apps.ts · shell-prefs · app-session)를 물지 않는다(#3830). 표지는 클래식 번들이고,
//   여기가 그쪽을 물면 그 전부가 따라온다. 무는 것은 그림 표(잎 모듈) 하나뿐이다.
//  ⚠ 색은 CSS 토큰이다(--gi-c-<이름>, 01-base.css · 90-dark.css). 타일 위에서 3:1 이상이 되게 맞춘 값이고
//   테마마다 다르다. 타일 색 · 테두리도 토큰(--gi-tile · --gi-tile-line)이다.
import { appGlyphName, iconPath, registerIconPath } from '../lib/icon-paths.js';

// ── #4769 구성원 앱의 아이콘 선언 ──
//  매니페스트 `icon: { path, color, color_dark? }` — 24 격자 선 그림 하나와 색. 서버(src/apps/manifest.ts appIconSpecOf)와 같은 규칙으로
//   화면에서 한 번 더 거른다(SVG · CSS 에 그대로 들어가는 글자라 서버를 못 믿는 자리). 등록하면 이름 `app-<id>` 가 생기고, 그 이름은
//   표의 이름과 똑같이 iconPath(그림) · `--gi-c-<이름>`(색 토큰) 으로 그려진다 — 앱 찾기 · 사이드바 줄 · 앱 탭 · 독이 코드를 안 바꾸고 따라온다.
//   색 토큰은 문서에 <style> 한 장으로 심는다(라이트 · 명시 다크 · 시스템 다크 — 90-dark.css 의 두 블록과 같은 선택자).
export interface AppIconSpec { path: string; color: string; color_dark?: string }
const ICON_PATH_RE = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\-\s]{1,2000}$/;
const ICON_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** 매니페스트(또는 서버가 실어 준 icon 칸)에서 아이콘 선언을 읽는다 — 모양이 틀리면 null. 던지지 않는다. */
export function appIconSpecOf(raw: unknown): AppIconSpec | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const src = o && o.icon && typeof o.icon === 'object' ? (o.icon as Record<string, unknown>) : o;
  if (!src) return null;
  const path = typeof src.path === 'string' ? src.path.trim() : '';
  const color = typeof src.color === 'string' ? src.color.trim() : '';
  const dark = typeof src.color_dark === 'string' ? src.color_dark.trim() : '';
  if (!ICON_PATH_RE.test(path) || !ICON_COLOR_RE.test(color)) return null;
  return dark && ICON_COLOR_RE.test(dark) ? { path, color, color_dark: dark } : { path, color };
}
const registered = new Map<string, string>();   // 이름 → 등록한 선언의 지문(같은 선언이면 다시 심지 않는다)
/** 앱 아이콘 이름(`app-<id>`) — 앱 id 의 글자 가운데 CSS 변수 이름에 안전한 것만 남긴다. */
export function appIconName(appId: string): string { return 'app-' + String(appId).replace(/[^a-z0-9-]/gi, '-').toLowerCase(); }
/** 선언을 등록하고 그 이름을 돌려준다. 선언이 틀리면 null(부르는 쪽이 기본 그림으로). */
export function registerAppIcon(appId: string, spec: AppIconSpec | null | undefined): string | null {
  const s = appIconSpecOf(spec); if (!s || !String(appId || '').trim()) return null;
  const name = appIconName(appId), key = s.path + '|' + s.color + '|' + (s.color_dark || '');
  if (registered.get(name) === key) return name;
  registered.set(name, key);
  registerIconPath(name, s.path);
  if (typeof document !== 'undefined' && document.head) {
    const id = 'v2-app-icon-' + name;
    let st = document.getElementById(id) as HTMLStyleElement | null;
    if (!st) { st = document.createElement('style'); st.id = id; document.head.append(st); }
    const dark = s.color_dark || s.color;
    st.textContent = `:root{--gi-c-${name}:${s.color}}:root[data-theme="dark"]{--gi-c-${name}:${dark}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--gi-c-${name}:${dark}}}`;
  }
  return name;
}
/** 등록한 앱 아이콘 이름인가(`app-…` 이고 그림이 등록돼 있다). */
export function isRegisteredAppIcon(name: string): boolean { return registered.has(name); }
/** 설치한 앱 한 줄의 그림 이름 — 선언한 그림이 있으면 그것, 없으면 기본 그림(builtinAppIcon). 앱 찾기 · 독 · 앱 탭 · 사이드바가 같은 자로 고른다. */
export function installedAppFace(a: { id: string; hasUi: boolean; icon?: AppIconSpec | null }): string {
  return registerAppIcon(a.id, a.icon) || builtinAppIcon(a.id, a.hasUi);
}

/** 색 토큰이 있는 이름. 모르는 이름은 apps 로 그린다. */
export const APP_ICON_NAMES = ['home', 'term', 'chat', 'proj', 'wiki', 'src', 'tags', 'ctx', 'sess', 'sys', 'web', 'learn', 'liv', 'apps', 'bell', 'deck', 'builder'] as const;

/** 앱 아이콘의 선 그림(path d). 시험과 그리는 쪽이 함께 쓴다. */
export function appGlyphPath(icon: string): string {
  const name = (APP_ICON_NAMES as readonly string[]).includes(icon) || isRegisteredAppIcon(icon) ? icon : 'apps';
  return iconPath(appGlyphName(name));
}

/** 설치한 앱(org_app) 가운데 **우리가 만든 것**의 그림. 남이 만든 앱과 그림을 정하지 않은 빌트인은 여기 없다.
 *  확인할 것 = 종(홈 머리의 알림과 같은 그림) · 웹 브라우저 = 지구본. 자료 · 분류체계는 앱 표(APPS)의 앱이라 이 길로 오지 않는다. */
const BUILTIN_APP_ICON: Record<string, string> = { browser: 'web', inbox: 'bell', 'deck-edit': 'deck' };   // 장표 수정(#4596) = 장표에 연필
/** 설치한 앱 하나의 앱 아이콘 이름. 정한 그림이 없으면 기본 그림: 화면이 있는 앱은 liv, 세션 앱은 term. */
export function builtinAppIcon(id: string, hasUi: boolean): string {
  return Object.prototype.hasOwnProperty.call(BUILTIN_APP_ICON, id) ? BUILTIN_APP_ICON[id] : (hasUi ? 'liv' : 'term');
}
/** 사이드바의 설치한 앱 줄(#/i/<id>)에 그릴 그림 이름. 런치패드와 같은 그림이고, 종(bell)만 사이드바 이름 inbox 로 바꾼다. */
export function instanceSideIcon(id: string, hasUi: boolean): string {
  const g = builtinAppIcon(id, hasUi);
  return g === 'bell' ? 'inbox' : g;
}

/** 앱 아이콘 SVG 의 속(문자열). 64 뷰박스: 타일(모서리 반지름 = 한 변의 26%) + 가운데 선 아이콘(24 격자를 1.44배). */
export function appGlassMarkup(icon: string): string {
  const name = (APP_ICON_NAMES as readonly string[]).includes(icon) || isRegisteredAppIcon(icon) ? icon : 'apps';
  return `<rect class="v2-gi-tile" x="1.5" y="1.5" width="61" height="61" rx="16"/>`
    + `<path class="v2-gi-glyph" stroke="var(--gi-c-${name})" transform="translate(14.72 14.72) scale(1.44)" d="${appGlyphPath(name)}"/>`;
}

/** 앱 아이콘(64×64). 글자 옆 16px 자리에는 이걸 쓰지 말고 appIcon() · icon() 을 쓴다. */
export function appGlassIcon(icon: string, cls?: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'v2-gi ' + (cls || ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = appGlassMarkup(icon);
  return svg;
}

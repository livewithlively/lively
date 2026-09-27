// v2/glass-icon.ts: 앱 아이콘(앱 화면 · 홈의 최근 연 앱 · 「맥락 관리」 표지의 문패)의 집.
//  #4233(원준 2026-09-27 「아이콘 · 이름 고르기」): 앱마다 따로 그리던 유리 겹침 그림(#1841)을 걷었다.
//   이제 **타일 하나 + 선 아이콘 하나**다. 고른 것: 반투명 흰 타일과 색 선 · 앱마다 다른 색 · 둥근 사각.
//   선 아이콘은 레일 · 사이드바와 같은 그림(lib/icon-paths.ts)이라, 그 표를 고치면 앱 아이콘도 함께 바뀐다.
//  이름(appGlassIcon)과 부르는 법은 그대로 둔다. 부르는 곳 셋(v2/apps.ts · v2/views.ts · context-map.ts)을 고치지 않는다.
//  ⚠ 셸 레지스트리(apps.ts · shell-prefs · app-session)를 물지 않는다(#3830). 표지는 클래식 번들이고,
//   여기가 그쪽을 물면 그 전부가 따라온다. 무는 것은 그림 표(잎 모듈) 하나뿐이다.
//  ⚠ 색은 CSS 토큰이다(--gi-c-<이름>, 01-base.css · 90-dark.css). 타일 위에서 3:1 이상이 되게 맞춘 값이고
//   테마마다 다르다. 타일 색 · 테두리도 토큰(--gi-tile · --gi-tile-line)이다.
import { ICONS, appGlyphName } from '../lib/icon-paths.js';

/** 색 토큰이 있는 이름. 모르는 이름은 apps 로 그린다. */
export const APP_ICON_NAMES = ['home', 'term', 'chat', 'proj', 'wiki', 'src', 'tags', 'ctx', 'sess', 'sys', 'web', 'learn', 'liv', 'apps'] as const;

/** 앱 아이콘의 선 그림(path d). 시험과 그리는 쪽이 함께 쓴다. */
export function appGlyphPath(icon: string): string {
  const name = (APP_ICON_NAMES as readonly string[]).includes(icon) ? icon : 'apps';
  return ICONS[appGlyphName(name)] || ICONS.apps;
}

/** 앱 아이콘 SVG 의 속(문자열). 64 뷰박스: 타일(모서리 반지름 = 한 변의 26%) + 가운데 선 아이콘(24 격자를 1.44배). */
export function appGlassMarkup(icon: string): string {
  const name = (APP_ICON_NAMES as readonly string[]).includes(icon) ? icon : 'apps';
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

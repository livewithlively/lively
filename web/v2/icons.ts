// v2/icons.ts: 새 셸 선 아이콘(#2016 · #4233). 그림은 lib/icon-paths.ts 한 벌에 있고, 여기는 그것을 SVG 로 그린다.
//  24 뷰박스 · 획 --ic-stroke(1.7) · 둥근 끝 · 채움 없음. 크기 · 색 · 획은 클래스(CSS)가 정한다.
import { sv } from '../core.js';
import { ICONS, iconPath } from '../lib/icon-paths.js';
export { ICONS };
/** 선 아이콘 하나. 크기·색은 클래스가 정한다(기본 `v2-ic` = 16px, currentColor). */
export function icon(name: string, cls = 'v2-ic'): SVGElement {
  return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, sv('path', { d: iconPath(name) }));
}

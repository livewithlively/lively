// guide/icon.ts. 가이드가 그리는 선 아이콘(잎 모듈). 그림은 lib/icon-paths.ts 한 벌을 읽는다. 가이드는 제 그림 표를 갖지 않는다.
import { sv } from '../core.js';
import { iconPath } from '../lib/icon-paths.js';

/** 선 아이콘 하나(그림 표의 이름). 크기와 색은 클래스가 정한다. */
export function guideIcon(name: string, cls: string): SVGElement {
  return sv('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: iconPath(name) }));
}

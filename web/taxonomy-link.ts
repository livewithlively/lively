// taxonomy-link.ts. 클래식 화면에서 「분류체계」 앱(#4233)으로 가는 문 한 자리.
//  분류체계는 맥락 관리의 카테고리 탭이었다가 새 셸의 앱이 됐다(원준 2026-09-26). 클래식 화면(위키 · 맥락 관리)은 새 셸 안에서
//   액자(iframe, ?embed=1)로 실리므로, 프레임 안 주소만 바꾸면 그 액자 안에 빈 화면이 선다. 그래서 **셸 창(window.top)** 을 옮긴다
//   (#1841 미리보기 앱 · me-logins 가 쓰는 규칙과 같다). 클래식 단독 화면(?ui=classic)에는 새 셸이 없으므로 종전 전체 페이지
//   `#/categories`(web/categories.ts renderCategories)로 간다.
import { uiMode } from './lib/state.js';

export function openTaxonomyApp(id?: number | string | null): void {
  const to = '#/taxonomy' + (id != null && String(id) !== '' ? '/' + encodeURIComponent(String(id)) : '');
  if (uiMode() === 'v2') {
    try { (window.top || window).location.hash = to; return; } catch (_) { /* 다른 오리진이면 아래로 */ }
  }
  location.hash = '#/categories';
}

// dashboard-home.ts — '대시보드' 상위 탭(#/dashboard). 옛 '시작하기' 탭 자리를 개편한 나만의 대시보드(#617).
//  1단계(현재): 자리표시(placeholder) — 위젯을 직접 골라 배치하는 '나만의 대시보드'는 다음 단계에서 구현.
//  임시 홈으로서 주요 화면 바로가기를 제공해 빈 화면이 되지 않게 한다. 기존 카드·버튼 스타일만 재사용(새 CSS 0).
import { el, pageHead } from './core.js';
async function renderMyDashboard(view) {
    const head = pageHead('대시보드', '내가 하는 일·회사의 지식·진행 상황을 한 화면에 모아 보는 나만의 공간이에요. 곧 위젯을 직접 골라 배치할 수 있게 됩니다.', [], '보드');
    // 준비 중 안내 + 임시 바로가기 — '시작하기(설치)'는 [사용 가이드]로 옮겨졌음을 함께 알린다.
    const soon = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: '나만의 대시보드가 곧 여기에' })), el('p', { class: 'guide-lead', text: '내가 맡은 프로젝트·최근 작업·자주 보는 지식처럼 필요한 것만 위젯으로 골라, 나에게 맞게 배치하는 화면을 준비하고 있어요. 지금은 아래에서 주요 화면으로 바로 갈 수 있습니다.' }), el('div', { class: 'step-cta' }, el('a', { class: 'btn btn-primary', href: '#/terminal', text: '터미널 열기 →' }), el('a', { class: 'btn btn-ghost', href: '#/projects2', text: '프로젝트' }), el('a', { class: 'btn btn-ghost', href: '#/knowledge', text: 'WIKI' })), el('p', { class: 'admin-hint', style: 'margin-top:14px' }, '처음이라면 ', el('a', { href: '#/learn', text: '[사용 가이드]' }), ' 를 먼저 보세요. 내 컴퓨터에 설치하는 ', el('b', { text: '시작하기' }), ' 도 이제 ', el('a', { href: '#/learn/install', text: '[사용 가이드 › 시작하기]' }), ' 안에 있어요.'));
    view.replaceChildren(head, soon);
    document.getElementById('view').focus?.();
}
export { renderMyDashboard, };

// dlv.ts — [수집·증류 ▸ AI 주입기 설정] 세부 페이지의 공용 조각(#5159).
//  한 화면에 한 갈래만 그리고(세션 시작·작업 중·…), 그 갈래의 머리·상자 모양을 여기 한 곳에서 정한다.
//  주입 패널(admin-injection) · 의미 검색(admin-embeddings) · 공개범위(visibility-axes · source-vis-policy)가
//  같은 머리·상자를 쓰게 하려고 화면 파일이 아니라 lib 에 둔다(서로를 import 하면 순환이 생긴다).
import { el } from './dom.js';
import { uiText } from './uitext.js';

/** 세부 페이지 머리 — 제목 + (훅 이벤트 이름) + 한 줄 설명 · 오른쪽에 켜고 끄는 스위치. */
export function dlvHead(title: string, hint: string, opts: { event?: string; right?: any } = {}): HTMLElement {
  return el('div', { class: 'dlv-ph' },
    el('div', { class: 'dlv-ph-main' },
      el('h3', { class: 'dlv-ph-t' }, el('span', { text: title }), opts.event ? el('code', { class: 'dlv-ev', text: opts.event }) : null),
      hint ? el('p', { class: 'dlv-ph-hint' }, ...uiText(hint)) : null),
    opts.right ? el('div', { class: 'dlv-ph-right' }, opts.right) : null);
}

/** 상자 — 헤어라인 + radius 12. title 은 글이거나 노드(제목 + 개수처럼). */
export function dlvBox(title: any, hint: string | null, ...children: any[]): HTMLElement {
  return el('section', { class: 'dlv-box' },
    title ? el('h4', { class: 'dlv-box-h' }, title) : null,
    hint ? el('p', { class: 'dlv-box-hint' }, ...uiText(hint)) : null,
    ...children);
}

/** 상자 제목 + 개수 — 「커스텀 훅 4」. */
export function dlvTitleN(title: string, n: number): any[] {
  return [el('span', { text: title }), el('span', { class: 'dlv-n', text: String(n) })];
}

/** 켜짐/꺼짐 스위치 — 맥락 앱의 스위치(.cxc-sw) + 상태 낱말. set 은 저장 실패 때 되돌리는 데 쓴다(change 를 다시 쏘지 않는다). */
export function dlvSwitch(checked: boolean, ariaLabel: string, disabled = false): { wrap: HTMLElement; input: HTMLInputElement; set: (v: boolean) => void } {
  const input = el('input', { type: 'checkbox', class: 'cxc-sw', role: 'switch', 'aria-label': ariaLabel }) as HTMLInputElement;
  input.checked = checked; input.disabled = disabled;
  const word = el('span', { class: 'dlv-sw-w', text: checked ? '켜짐' : '꺼짐' });
  const set = (v: boolean) => { input.checked = v; word.textContent = v ? '켜짐' : '꺼짐'; };
  input.addEventListener('change', () => { word.textContent = input.checked ? '켜짐' : '꺼짐'; });
  return { wrap: el('label', { class: 'dlv-sw' }, input, word), input, set };
}

// lib/qmark.ts — (?) 표시. 마우스를 올리거나 초점을 주면 설명이 뜬다(원준 2026-09-28: 긴 설명은 궁금한 사람만 보게).
//  ⚠ 한 화면에 여러 개 달지 않는다 — 열 머리나 개발자용 이름처럼 설명이 꼭 필요한 한두 자리에만.
import { el } from './dom.js';

export function qmark(tip: string): HTMLElement {
  return el('span', { class: 'v2me-qm', tabindex: '0', role: 'note', 'aria-label': tip }, '?', el('span', { class: 'v2me-qm-tip', text: tip }));
}

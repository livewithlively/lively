// v2/grow-text.ts — 글이 늘면 세로로 늘어나는 글 칸 한 벌(#4632, 원준 2026-10-28 «코멘트 남기는 텍스트박스가 완전 한 줄로 고정되어서
//  글을 많이 치면 너무 불편 · 자동으로 세로줄 늘어나게»). 앱빌더의 코멘트 칸(실제 화면 막대 · 그 자리 칸 · 코멘트 목록 · 허브)이 같이 쓴다.
//
//  · 한 줄에서 시작해 max 줄까지 늘고, 넘으면 칸 안에서 스크롤한다.
//  · Enter = 끝냄(onEnter) · Shift+Enter = 줄바꿈 · Esc = onEscape. 한글 조합 중의 Enter · Esc 는 건드리지 않는다(조합을 끝내는 키다).
//  · 값을 코드로 바꿨으면 fitGrow 를 부른다(입력 사건이 없다). 아직 문서에 안 붙은 칸은 붙은 다음 틀에서 맞춘다.
import { el } from '../core.js';

export interface GrowOpts {
  class: string;
  placeholder?: string;
  label?: string;
  title?: string;
  value?: string;
  /** 늘어나는 최대 줄 수(기본 6) */
  max?: number;
  onInput?: (v: string) => void;
  onEnter?: () => void;
  onEscape?: () => void;
}

const MAX_OF = new WeakMap<HTMLTextAreaElement, number>();

/** 글 줄 수에 맞춰 높이를 다시 잰다(최대 줄 수까지 · 넘으면 칸 안 스크롤). */
export function fitGrow(ta: HTMLTextAreaElement): void {
  if (!ta.isConnected) return;
  const cs = getComputedStyle(ta);
  const fs = parseFloat(cs.fontSize) || 13;
  const line = parseFloat(cs.lineHeight) || fs * 1.45;   // 'normal' 이면 글자 크기에서
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const bordY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const border = cs.boxSizing === 'border-box';
  ta.style.height = 'auto';
  const content = ta.scrollHeight - padY;   // scrollHeight 는 안쪽 여백을 담고 테두리는 안 담는다
  const cap = line * (MAX_OF.get(ta) || 6);
  const h = Math.min(Math.max(content, line), cap);
  ta.style.height = (border ? h + padY + bordY : h) + 'px';
  ta.style.overflowY = content > cap + 1 ? 'auto' : 'hidden';
}

export function growText(o: GrowOpts): HTMLTextAreaElement {
  const ta = el('textarea', { class: o.class + ' v2-grow', rows: '1',
    ...(o.placeholder ? { placeholder: o.placeholder } : {}), ...(o.label ? { 'aria-label': o.label } : {}), ...(o.title ? { title: o.title } : {}) }) as HTMLTextAreaElement;
  ta.value = o.value || '';
  MAX_OF.set(ta, o.max || 6);
  ta.addEventListener('input', () => { fitGrow(ta); if (o.onInput) o.onInput(ta.value); });
  ta.addEventListener('focus', () => fitGrow(ta));
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && o.onEnter) { e.preventDefault(); o.onEnter(); return; }
    if (e.key === 'Escape' && o.onEscape) { e.preventDefault(); o.onEscape(); }
  });
  requestAnimationFrame(() => fitGrow(ta));   // 붙은 다음 틀에서 — 처음부터 긴 글이 든 칸
  return ta;
}

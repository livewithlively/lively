// v2/compose-mention.ts — 새 세션 컴포저의 **@이름 초대**(#3778, 원준 2026-09-09) 화면 부품. 글자 규칙은 mention-text.ts.
//
//  홈(v2/views.ts)과 프로젝트 칸(v2/panes-parts.ts)이 첨부(compose-attach.ts)와 똑같이 **한 모듈**을 나눠 쓴다.
//  · 입력칸에 `@` 를 치면 구성원 목록이 **그 @ 글자 바로 아래**에 작게 뜬다(슬랙과 같은 감) — ↑↓ 로 고르고 Enter/Tab 으로 정한다.
//    2판(원준 2026-09-09 «드롭다운이 너무 크고 위치가 어색»): 카드 폭을 다 먹던 상자 → 폭 280 의 작은 목록, 머리글 없음,
//    자리는 입력칸 아래가 아니라 치고 있는 @ 의 좌표(숨은 거울 div 로 잰다 — textarea 는 글자 좌표를 안 준다).
//  · 고르면 치던 `@윤` 은 글에서 사라지고, 그 사람은 **아래 칩 줄에만** 선다(원준: 본문에 @이름 을 남기지 마라).
//  · 보낼 때 invites() 를 생성 바디에, tail() 을 지시 꼬리에 싣는다. clear() 는 보낸 뒤.
//  구성원 목록은 /terminal/config 의 members(run-picker.ts 가 이미 받아 둔 응답)라 요청이 늘지 않는다.
import { el, personFace, state } from '../core.js';
import { runMembers } from './run-picker.js';
import { mentionMatches, mentionQuery, mentionTail, removeMentionQuery, type MentionMember } from './mention-text.js';

export interface ComposerMention {
  /** 사람 칩 줄 — 첨부 칩 줄 옆(아래)에 둔다. 비면 숨김. */
  chips: HTMLElement;
  /** 후보 목록 — 카드(.v2-launch, position:relative) 안에 붙인다. 치고 있는 @ 글자 바로 아래에 작게 뜬다. */
  menu: HTMLElement;
  /** 입력칸에 건다 — **입력칸당 한 번만**. */
  wire(ta: HTMLTextAreaElement): void;
  /** 고른 사람(구성원 id). */
  invites(): string[];
  /** «함께 보는 사람» 꼬리('' 가능). */
  tail(): string;
  /** 보낸 뒤 비운다. */
  clear(): void;
}

/**
 * 입력칸 안 어느 글자 위치(index)의 좌표 — 카드(offsetParent) 기준 px. textarea 는 글자 좌표를 안 주므로 같은 글꼴·폭의
 * 숨은 거울 div 에 그 앞 글을 넣고 표식 span 의 자리를 읽는다. 줄바꿈·자동 줄바꿈이 같아야 하므로 폭·패딩·글꼴을 그대로 베낀다.
 */
function charPos(ta: HTMLTextAreaElement, index: number): { left: number; top: number; line: number } {
  const cs = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'tabSize'] as const) {
    (m.style as any)[k] = (cs as any)[k];
  }
  m.style.position = 'absolute'; m.style.visibility = 'hidden'; m.style.pointerEvents = 'none';
  m.style.left = ta.offsetLeft + 'px'; m.style.top = ta.offsetTop + 'px';
  m.style.width = ta.clientWidth + 'px'; m.style.whiteSpace = 'pre-wrap'; m.style.overflowWrap = 'break-word'; m.style.wordBreak = cs.wordBreak;
  m.textContent = ta.value.slice(0, index);
  const mark = document.createElement('span'); mark.textContent = '\u200b';
  m.append(mark);
  (ta.offsetParent || ta.parentElement || document.body).append(m);
  const line = mark.offsetHeight || parseFloat(cs.lineHeight) || 20;
  const out = { left: ta.offsetLeft + mark.offsetLeft - ta.scrollLeft, top: ta.offsetTop + mark.offsetTop - ta.scrollTop, line };
  m.remove();
  return out;
}

export function composerMention(): ComposerMention {
  const chips = el('div', { class: 'pn-att v2-ppl', hidden: true });
  const menu = el('div', { class: 'v2-mention', hidden: true, role: 'listbox' });
  let members: MentionMember[] = [];
  const chosen: MentionMember[] = [];
  let ta: HTMLTextAreaElement | null = null;
  let picks: MentionMember[] = [];
  let sel = 0;
  const meId = (): string => String((state.me && state.me.userId) || '');

  function paintChips(): void {
    chips.hidden = !chosen.length;
    chips.replaceChildren(...chosen.map((m) => el('span', { class: 'pn-att-c ppl', title: `${m.name} 을(를) 이 세션에 초대해요 — 열리면 함께 봅니다` },
      personFace(m.id, 'v2-ppl-ava', m.name),
      el('span', { class: 'n', text: m.name + (m.kind === 'agent' ? ' (AI)' : '') }),
      el('button', { class: 'pn-att-x', type: 'button', title: '초대 빼기', 'aria-label': '초대 빼기', text: '✕',
        onclick: () => { const i = chosen.indexOf(m); if (i >= 0) chosen.splice(i, 1); paintChips(); ta?.focus(); } }))));
  }

  function closeMenu(): void { menu.hidden = true; picks = []; sel = 0; }
  function paintMenu(): void {
    if (!ta) return;
    const q = mentionQuery(ta.value, ta.selectionStart ?? ta.value.length);
    if (q === null || !members.length) { closeMenu(); return; }
    picks = mentionMatches(members, q, { meId: meId(), exclude: new Set(chosen.map((m) => m.id)), limit: 6 });
    if (!picks.length) { closeMenu(); return; }
    sel = Math.min(sel, picks.length - 1);
    // 치고 있는 @ 글자 바로 아래, 왼쪽을 그 글자에 맞춘다(카드가 offsetParent). 오른쪽으로 넘치면 카드 안으로 당긴다.
    const caret = ta.selectionStart ?? ta.value.length;
    const at = ta.value.lastIndexOf('@', caret - 1);
    const pos = charPos(ta, Math.max(0, at));
    const host = (ta.offsetParent as HTMLElement | null);
    const room = host ? host.clientWidth : ta.clientWidth;
    menu.style.top = (pos.top + pos.line + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(pos.left, room - 288)) + 'px';
    menu.hidden = false;
    menu.replaceChildren(
      ...picks.map((m, i) => el('div', {
        class: 'v2-mention-row' + (i === sel ? ' is-sel' : ''), role: 'option',
        //  ⚠ mousedown 으로 받는다 — click 은 blur 뒤에 와서 입력칸이 이미 포커스를 잃는다.
        onmousedown: (ev: Event) => { ev.preventDefault(); choose(i); },
      },
        personFace(m.id, 'v2-ppl-ava', m.name),
        el('span', { class: 'n', text: m.name }),
        m.kind === 'agent' ? el('span', { class: 'k', text: 'AI' }) : null,
        el('span', { class: 'id mono', text: m.id }))));
  }
  function choose(i: number): void {
    const m = picks[i];
    if (!ta || !m) return;
    // 치던 @글자를 글에서 걷고 사람은 칩으로 — 글엔 흔적이 남지 않는다.
    const next = removeMentionQuery(ta.value, ta.selectionStart ?? ta.value.length);
    ta.value = next.text;
    ta.setSelectionRange(next.caret, next.caret);
    if (!chosen.some((c) => c.id === m.id)) chosen.push(m);
    closeMenu();
    paintChips();
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // 초안 저장·높이가 따라온다
    ta.focus();
  }

  return {
    chips, menu,
    wire(input) {
      ta = input;
      void runMembers().then((ms) => { members = ms; });
      ta.addEventListener('input', paintMenu);
      //  ⚠ capture — 입력칸의 Enter(보내기)보다 **먼저** 봐야 가로챌 수 있다. 목록이 열려 있을 때만 가로챈다.
      ta.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (menu.hidden || !picks.length || ev.isComposing) return;
        if (ev.key === 'ArrowDown') { sel = (sel + 1) % picks.length; paintMenu(); ev.preventDefault(); return; }
        if (ev.key === 'ArrowUp') { sel = (sel - 1 + picks.length) % picks.length; paintMenu(); ev.preventDefault(); return; }
        if (ev.key === 'Enter' || ev.key === 'Tab') { choose(sel); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
        if (ev.key === 'Escape') { closeMenu(); ev.preventDefault(); ev.stopImmediatePropagation(); }
      }, true);
      ta.addEventListener('click', paintMenu);           // 커서를 옮겨 @ 토큰 안에 두면 다시 뜬다
      ta.addEventListener('blur', () => window.setTimeout(closeMenu, 120));
    },
    invites: () => chosen.map((m) => m.id),
    tail: () => mentionTail(chosen.map((m) => m.name)),
    clear() { chosen.length = 0; paintChips(); closeMenu(); },
  };
}

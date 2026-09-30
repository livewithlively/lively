// v2/proj-pick.ts — 세션의 프로젝트 소속을 고르는 목록(#1749) **한 벌**과, 그 목록을 담는 그릇 둘.
//
//  ① 드롭다운(anchoredPopover) — [⋯ ▸ 이 세션 ▸ 프로젝트]·사이드바 우클릭이 연다. 누른 자리가 기준점이다.
//  ② 모달 — 문패(#3625 · 진행 중 이 적힌 줄)의 [세션 옮기기](#3778, 원준 2026-09-19: «[⋯] 안에만 있지 말고
//     밖에도 빼놓은 버튼이 있고 싶다»). 문패는 화면 폭 전체에 걸친 줄이라 기준점 드롭다운보다 가운데 창이 맞다.
//
//  찾기 칸·떼기 행·목록 행은 **여기 한 곳**에서 만든다 — 입구마다 따로 두면 한쪽만 고쳐져 두 모양으로 갈린다.
//  찾기 규칙은 홈 컴포저와 같은 lib/proj-match.ts. 실행(서버 요청·화면 갱신)은 부르는 쪽(main.ts)이 onPick 으로 쥔다.
import { anchoredPopover, el } from '../core.js';
import { projMatches, type ProjLike } from '../lib/proj-match.js';

export interface ProjPickRow { proj: ProjLike & { name: string }; done: boolean }

export interface ProjPickOpts {
  /** 후보 — 사이드바와 같은 순서(side.ts projectOrder). 빈 찾기 칸은 이 순서 그대로다. */
  rows: readonly ProjPickRow[];
  /** 지금 붙어 있는 프로젝트. 없으면 null — 그때는 [떼기] 행이 없다. */
  currentId: number | null;
  /** 골랐다(null = 떼기). 성공하면 true — 그릇이 닫힌다. 실패는 부르는 쪽이 토스트로 말하고 false 를 준다. */
  onPick: (pid: number | null) => Promise<boolean>;
}

const LIMIT = 50;

/** 찾기 칸 + 목록 + 진행 한 줄. 그릇(드롭다운·모달)은 이걸 제 몸에 들이기만 한다. */
function pickBody(o: ProjPickOpts, done: () => void): { input: HTMLInputElement; parts: HTMLElement[] } {
  const input = el('input', { class: 'v2-pjpick-in', type: 'search', placeholder: '프로젝트 검색', 'aria-label': '프로젝트 검색' }) as HTMLInputElement;
  const listEl = el('div', { class: 'v2-pjpick-list', role: 'listbox' });
  const note = el('p', { class: 'v2-fine v2-pjpick-note' });
  let busy = false;

  async function pick(pid: number | null): Promise<void> {
    if (busy) return;
    busy = true;
    note.textContent = pid ? '붙이는 중…' : '떼는 중…';
    const ok = await o.onPick(pid).catch(() => false);
    if (ok) { done(); return; }
    busy = false;
    note.textContent = '';
  }

  const render = (): void => {
    const hits = projMatches(o.rows, input.value.trim());
    const kids: HTMLElement[] = [];
    if (o.currentId) kids.push(el('button', { class: 'v2-pjpick-row v2-pjpick-none', type: 'button', role: 'option', onclick: () => void pick(null) },
      el('span', { class: 'n', text: '프로젝트에서 떼기' }), el('span', { class: 'm', text: '프로젝트 없음으로' })));
    for (const r of hits.slice(0, LIMIT)) {
      const cur = Number(o.currentId) === Number(r.proj.id);
      kids.push(el('button', { class: 'v2-pjpick-row' + (cur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(cur), onclick: () => { if (!cur) void pick(r.proj.id); },
        title: r.proj.name + ' · #' + r.proj.id },
        el('span', { class: 'n', text: r.proj.name }),
        el('span', { class: 'm' }, el('span', { class: 'mono', text: '#' + r.proj.id }), r.done ? el('span', { class: 'v2-pjpick-done', text: '완료' }) : null, cur ? el('span', { class: 'v2-pjpick-cur', text: '✓ 지금' }) : null)));
    }
    if (hits.length > LIMIT) kids.push(el('p', { class: 'v2-fine', text: `외 ${hits.length - LIMIT}개 — 더 좁혀 검색하세요.` }));
    if (!kids.length) kids.push(el('p', { class: 'v2-fine', text: '조건에 맞는 프로젝트가 없어요.' }));
    listEl.replaceChildren(...kids);
  };
  input.oninput = render;
  input.onkeydown = (e: KeyboardEvent) => {
    // 엔터 = 맨 위 후보로 옮기기. 떼기 행과 «지금» 행은 건너뛴다 — 찾으려고 친 엔터가 떼기가 되면 안 된다.
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const first = listEl.querySelector('.v2-pjpick-row:not(.v2-pjpick-none):not(.cur)') as HTMLButtonElement | null;
      if (first) first.click();
    }
  };
  render();
  return { input, parts: [input, listEl, note] };
}

/** ① 드롭다운 — 누른 자리에 붙는다. */
export function openProjPickPopover(anchor: HTMLElement, o: ProjPickOpts): void {
  let closePop: (() => void) | null = null;
  const b = pickBody(o, () => { if (closePop) closePop(); });
  closePop = anchoredPopover(anchor, el('div', { class: 'dash-pop-panel v2-pjpick' }, ...b.parts));
  window.setTimeout(() => b.input.focus(), 0);
}

/**
 * ② 모달 — 가운데 창. 무엇을 옮기는지(세션 이름)와 지금 어디 있는지를 **먼저** 말한다:
 *  이 창은 프로젝트 문패에서 열리므로, 말하지 않으면 «프로젝트를 바꾼다(다른 프로젝트로 간다)» 로 읽힌다 —
 *  옮겨지는 것은 프로젝트가 아니라 **지금 보는 세션**이다(문패 [공유] 가 프로젝트 공유로 읽혔던 것과 같은 함정, 원준 2026-09-09).
 */
export function openProjPickModal(o: ProjPickOpts & { sessionName: string; currentName: string | null }): void {
  let closed = false;
  const opener = document.activeElement as HTMLElement | null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
  };
  const b = pickBody(o, close);
  const fact = (k: string, v: HTMLElement | string): HTMLElement =>
    el('div', { class: 'v2-pjmove-fact' }, el('span', { class: 'k', text: k }), typeof v === 'string' ? el('span', { class: 'v', text: v }) : v);
  const where = o.currentId
    ? el('span', { class: 'v' }, el('span', { text: o.currentName || '이름 없는 프로젝트' }), el('span', { class: 'mono', text: ' #' + o.currentId }))
    : '어느 프로젝트에도 붙어 있지 않아요';
  const box = el('div', { class: 'ov-box v2-pjmove', role: 'dialog', 'aria-modal': 'true', 'aria-label': '세션 옮기기' },
    el('div', { class: 'ov-head' }, el('h3', { text: '세션 옮기기' }),
      el('button', { class: 'v2-def-x', type: 'button', 'aria-label': '닫기', text: '✕', onclick: () => close() })),
    el('div', { class: 'v2-pjmove-facts' }, fact('옮길 세션', o.sessionName), fact('지금 있는 곳', where)),
    ...b.parts);
  const back = el('div', { class: 'ov-back ov-confirm-back' }, box);
  back.addEventListener('mousedown', (e: MouseEvent) => { if (e.target === back) close(); });
  //  capture 로 먼저 받는다 — 찾기 칸(type=search)의 Esc 는 기본이 «글 지우기»라, 버블에서 받으면 창이 한 번에 안 닫힌다.
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  window.setTimeout(() => b.input.focus(), 0);
}

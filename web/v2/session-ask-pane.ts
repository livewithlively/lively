// v2/session-ask-pane.ts — 세션 화면 곁칸의 **«요청» 칸**(#5713): 이 세션의 AI 가 나에게 걸어 둔 요청(값 입력 · 고르기 · 파일 올리기 …).
//
//  ── 왜 여기인가 ──
//  종전엔 이 카드들이 리브 전용이었다 — 리브 세션 대화창의 입력칸 위(web/liv-ask-dock.ts)와 리브 화면(#/liv)에서만 그렸다.
//   리브가 아닌 세션(연결 스킬 · 보통 세션)의 AI 가 걸면 사람이 볼 자리가 없어 대화가 섰다(#4970 조사 · 상민님 2026-11-23).
//   요청은 «어느 세션이 걸었나» 가 분명하므로 **그 세션 화면의 곁칸**에 둔다 — 세션을 열면 그 세션이 기다리는 것이 옆에 선다.
//  ── 파생 탭이다 ──
//  배치에 저장하지 않는다(panes.ts DERIVED_TABS). 지금 보는 세션에 열린 요청이 있으면 셸이 세우고(새로 걸리면 켜고) 없으면 걷는다
//   — 붙은 앱 탭(session-app-pane.ts)과 같은 결. 목록은 셸과 이 칸이 한 벌을 나눠 받는다(asks/api.ts watchAsks).
//  ── 주소에서 왔을 때 ──
//  로컬 터미널의 AI 가 준 링크(#/ask/<id>)는 그 요청의 세션 화면으로 와서 이 칸의 그 카드를 짚는다(focusAsk — v2/ask-page.ts 가 부른다).
import { el } from '../core.js';
import { refreshAsks, watchAsks, type Ask } from '../asks/api.js';
import { syncAskCards, type AskHooks } from '../asks/registry.js';
import '../asks/kinds.js';   // 카드 종류 등록
import type { Part, PartCtx } from './panes-parts.js';

/** 곁칸 탭의 열쇠(= 부품 종류). 배치에 저장하지 않는 파생 탭이다. */
export const SESSASK_TAB = 'sessask';

/** 탭 이름 — 하나면 «요청», 여럿이면 몇 개인지. */
export const sessAskTabTitle = (n: number): string => (n > 1 ? `요청 ${n}` : '요청');

// ── 짚을 카드(주소에서 왔다) — 칸이 아직 안 섰어도 잃지 않게 여기 들고 있다가, 그 카드가 그려지는 순간 짚는다 ──
let focusId: string | null = null;
let focusAt = 0;
const FOCUS_TTL_MS = 60_000;   // 그 사이 요청이 끝났거나 세션을 못 찾았으면 버린다(다음에 연 다른 화면을 짚지 않게)
//  ⚠ 곁칸 부품끼리의 신호는 문서 전체로 뿌리지 않는 것이 규칙이다(#1819 — 열려 있는 세션 탭마다 곁칸이 한 벌씩 살아 있어 다 같이 받는다).
//   이 신호는 예외로 window 에 쏜다: 어느 세션 탭의 칸이 받을지 쏘는 쪽(주소 라우트)이 모르고, 받은 칸은 **그 id 의 카드가 제 목록에
//   있을 때만** 움직인다(요청 id 는 한 세션의 것이라 한 칸만 걸린다). 값을 바꾸는 신호가 아니라 «여기 보라» 뿐이다.
export const ASK_FOCUS_EVT = 'lively:ask-focus';
const FOCUS_EVT = ASK_FOCUS_EVT;

/** 이 요청의 카드를 짚어 달라 — 그 세션의 «요청» 칸이 그려지면(이미 떠 있으면 곧바로) 그 카드로 스크롤하고 잠깐 밝힌다. */
export function focusAsk(id: string): void {
  focusId = id; focusAt = Date.now();
  //  detail.id — 셸(panes.ts)이 «그 요청이 내 세션 것이면 요청 탭을 켠다» 를 정할 때 본다(칸이 먼저 받아 짚을 것을 비워도 셸이 알게).
  window.dispatchEvent(new CustomEvent(FOCUS_EVT, { detail: { id } }));
}
/** 짚어 달라는 요청이 지금 걸려 있나(그 id) — 셸이 «이 세션을 열자마자 요청 탭을 켤까» 를 정할 때 본다. */
export function pendingAskFocus(): string | null {
  if (focusId && Date.now() - focusAt > FOCUS_TTL_MS) focusId = null;
  return focusId;
}

export function sessAskPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessask' });
  const list = el('div', { class: 'pn-sessask-list liv-askdock' });
  const empty = el('p', { class: 'pn-fine pn-sessask-empty', text: '지금 이 세션이 기다리는 요청이 없어요.' });
  root.append(
    el('header', { class: 'pn-sessask-head' },
      el('b', { text: 'AI 가 기다리는 것' }),
      el('p', { class: 'pn-fine', text: '이 세션의 AI 가 진행하려면 받아야 하는 것들이에요. 입력한 값은 대화에 남지 않습니다.' })),
    list, empty);

  let sid: string | null = null;
  let off: (() => void) | null = null;
  const hooks: AskHooks = { refresh: () => { if (sid) refreshAsks(sid); } };

  function tryFocus(): void {
    const want = pendingAskFocus();
    if (!want) return;
    const card = [...list.children].find((c) => (c as HTMLElement).dataset.askId === want) as HTMLElement | undefined;
    if (!card) return;
    focusId = null;
    card.scrollIntoView({ block: 'nearest' });
    card.classList.add('ask-flash');
    window.setTimeout(() => card.classList.remove('ask-flash'), 2400);
    //  첫 입력칸에 커서를 둔다 — 링크를 누르고 왔으면 바로 붙여 넣을 수 있게. 사람이 다른 칸에 치는 중이면 뺏지 않는다.
    const a = document.activeElement as HTMLElement | null;
    const busy = !!a && a !== document.body && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    if (!busy) (card.querySelector('input:not([type=file]), textarea') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function paint(asks: Ask[]): void {
    if (ctx.dead()) return;
    syncAskCards(list, asks, hooks);
    empty.hidden = asks.length > 0;
    tryFocus();
  }

  function bind(next: string | null): void {
    if (next === sid && off) return;
    off?.(); off = null; sid = next;
    list.replaceChildren(); empty.hidden = false;
    if (!sid) return;
    const mine = sid;
    off = watchAsks(mine, (asks) => { if (sid === mine) paint(asks); });
  }

  const offSession = ctx.onSession((s) => bind(s));
  const onFocus = (): void => tryFocus();
  window.addEventListener(FOCUS_EVT, onFocus);
  bind(ctx.curSession());

  return {
    root,
    tick: () => { /* 목록은 서버 사건 + 느린 되묻기가 민다(asks/api.ts) — 셸 틱마다 다시 읽지 않는다 */ },
    destroy: () => { off?.(); off = null; offSession(); window.removeEventListener(FOCUS_EVT, onFocus); },
  };
}

/**
 * 곁칸이 없는 창(팝아웃 세션 창 `?solo=1`)의 요청 자리 — 창 오른쪽 위에 뜬 카드 묶음. 요청이 없으면 아무것도 안 보인다.
 *  팝아웃 창은 세션 하나만 담은 창이라(그게 그 창의 정의) 문서에 바로 붙여도 다른 세션과 섞이지 않는다.
 *  종전엔 팝아웃 창의 리브 세션이 대화창 입력칸 위에 물음 카드를 그렸다 — 그 자리를 걷으면서 이 창에서 요청이 안 보이게 되는 것을 막는다.
 */
export function mountFloatingAsks(sid: string): { destroy(): void } {
  const list = el('div', { class: 'ask-float-list liv-askdock' });
  const box = el('aside', { class: 'ask-float', hidden: true, 'aria-label': 'AI 가 기다리는 것' },
    el('div', { class: 'ask-float-head' }, el('b', { text: 'AI 가 기다리는 것' })), list);
  document.body.append(box);
  const hooks: AskHooks = { refresh: () => refreshAsks(sid) };
  const off = watchAsks(sid, (asks) => { syncAskCards(list, asks, hooks); box.hidden = asks.length === 0; });
  return { destroy: () => { off(); box.remove(); } };
}

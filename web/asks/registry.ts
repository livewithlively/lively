// asks/registry.ts — 세션 요청(#5713) 카드의 **종류 등록부**(화면 쪽). 서버 쪽 짝은 src/asks/kinds.ts.
//
//  세션 요청 = 세션의 AI 가 사람에게 화면으로 받는 것. 종류마다 그리는 법이 다르고(입력칸 · 고르는 카드 · 올리는 자리),
//   답을 보내고 → 세션에 한 마디를 넣고 → 자리를 다시 그리는 일은 종류와 무관하게 같다. 그래서 종류는 **그리기만** 등록하고
//   나머지는 여기가 한다.
//
//  ── 종류 하나를 더하려면 ──
//   web/asks/kind-<종류>.ts 에 `registerAskKind('<종류>', { render })` 를 쓰고 web/asks/kinds.ts 에 import 한 줄을 더한다.
//   render(ask, ctx) 는 카드 요소를 돌려준다 — 답은 ctx.submit(몸통)으로 보내고, «나중에» 단추는 ctx.later() 를 꽂는다.
//   서버가 그 종류를 모르면 요청이 생기지 않고, 화면이 모르면(서버만 새 판) 아래 폴백 카드가 «새로고침» 을 안내한다.
//
//  ── 카드는 어디에 사는지 모른다 ──
//   세션 화면 곁칸의 «요청» 칸(v2/session-ask-pane.ts)과 요청 주소 화면(v2/ask-page.ts)이 같은 카드를 쓴다. 자리마다 다른 것
//   (다시 그리기 · 한 마디를 못 넣었을 때 어떻게 알리나)은 AskHooks 로 받는다.
import { el } from '../core.js';
import { sendIntoSession } from '../v2/sess-input.js';
import { askSignature, dismissAsk, submitAsk, tellAsk, type Ask } from './api.js';

/** 종류의 그리기 함수가 받는 문. */
export interface AskCtx {
  /**
   * 답을 보낸다 — 서버가 받아 처리하고(시크릿은 금고로), 요청을 건 세션에 한 마디가 들어가고, 자리가 다시 그려진다.
   *  실패하면 던진다 — 카드가 제자리에서 오류를 보이고 사람이 다시 보낼 수 있게(요청은 열린 채 남는다).
   */
  submit(body: Record<string, unknown>): Promise<void>;
  /** «나중에» 단추 — 지금은 안 하겠다고 접는다. 접은 것은 AI 가 안다(곧바로 다시 묻지 않는다). */
  later(): HTMLElement;
}

export interface AskKindView {
  render(ask: Ask, ctx: AskCtx): HTMLElement;
}

/** 카드가 놓인 자리가 주는 문. */
export interface AskHooks {
  /** 답했거나 접었다 — 자리를 다시 그린다(목록을 다시 읽는다). */
  refresh(): void;
  /**
   * 한 마디를 세션에 못 넣었다(로컬 터미널의 AI · 멈춘 세션 · 세션을 모르는 요청) — 사람이 AI 에게 직접 말해야 한다.
   *  기본은 토스트. 요청 주소 화면은 이걸 화면에 남긴다(토스트는 4초 뒤 사라진다).
   */
  manual?(say: string, ask: Ask): void;
  /** 답이 처리됐다(한 마디를 넣었든 못 넣었든). */
  done?(ask: Ask): void;
}

const kinds = new Map<string, AskKindView>();

export function registerAskKind(kind: string, view: AskKindView): void {
  if (kinds.has(kind)) throw new Error('세션 요청 종류가 이미 등록돼 있습니다: ' + kind);
  kinds.set(kind, view);
}
export const knownAskKind = (kind: string): boolean => kinds.has(kind);

export function askToast(msg: string, ms = 4000): void {
  const t = el('div', { class: 'liv-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** AI 에게 직접 전할 말 안내 — 한 마디를 세션에 못 넣었을 때. */
export const manualSay = (say: string): string => `받았어요. AI 에게 «${say}» 라고 전해 주세요.`;

function laterBtn(ask: Ask, hooks: AskHooks): HTMLElement {
  return el('button', {
    class: 'btn btn-sm btn-ghost liv-ask-later', type: 'button', text: '나중에',
    title: '지금은 넘어갑니다. AI 가 이걸 곧바로 다시 묻지 않습니다.',
    onclick: async (ev: Event) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      await dismissAsk(ask.id).catch(() => { /* 비치명 — 다시 그리면 남아 있다 */ });
      hooks.refresh();
    },
  });
}

/**
 * 답을 보내고 뒷일을 한다. 한 마디(say)는 **그 세션 대화창이 이 화면에 떠 있으면 거기로**(사람이 보낸 말과 같은 길 — 대화에 바로 보인다),
 *  아니면 서버가 넣는다. 둘 다 못 하면 사람에게 «AI 에게 전해 달라» 고 안내한다 — 값은 이미 받았다(요청은 끝났다).
 */
async function submitAndTell(ask: Ask, body: Record<string, unknown>, hooks: AskHooks): Promise<void> {
  const r = await submitAsk(ask.id, body);      // 실패는 던진다 — 카드가 받는다
  const say = String(r.say ?? '').trim();
  if (say) {
    if (ask.session_id && sendIntoSession([ask.session_id], say)) {
      void tellAsk(ask.id, true);                // 서버에 «이미 전했다» 만 적는다(다른 탭이 한 번 더 넣지 않게)
      askToast('받았어요. AI 가 이어서 진행합니다.');
    } else {
      const t = await tellAsk(ask.id);
      if (t.delivered) askToast('받았어요. AI 가 이어서 진행합니다.');
      else if (hooks.manual) hooks.manual(say, ask);
      //  사람이 읽고 옮겨 말해야 하는 글이다 — 보통 토스트(4초)보다 오래 둔다. 카드는 곧 사라지므로 이 글이 유일한 안내다.
      else askToast(manualSay(say), 15000);
    }
  } else askToast('받았어요.');
  hooks.done?.(ask);
  setTimeout(() => hooks.refresh(), 400);
}

/** 화면이 모르는 종류 — 서버가 새 종류를 얻었는데 이 화면은 옛 판이다. 되는 척하지 않고 새로고침을 안내한다. */
function unknownCard(ask: Ask, ctx: AskCtx): HTMLElement {
  return el('div', { class: 'liv-ask ask-unknown' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.title || ask.kind_label || '요청' })),
    el('div', { class: 'liv-ask-why', text: `이 화면은 «${ask.kind_label || ask.kind}» 요청을 아직 그릴 줄 모릅니다. 새로고침하면 보입니다.` }),
    el('div', { class: 'liv-ask-row liv-ask-acts' }, ctx.later(),
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '새로고침', onclick: () => location.reload() })));
}

/** 요청 카드 하나. 끝난 요청(open 이 아님)은 그리지 않는다 — 부르는 쪽이 따로 «끝났다» 를 그린다. */
export function askCard(ask: Ask, hooks: AskHooks): HTMLElement {
  const ctx: AskCtx = {
    submit: (body) => submitAndTell(ask, body, hooks),
    later: () => laterBtn(ask, hooks),
  };
  const view = kinds.get(ask.kind);
  let card: HTMLElement;
  try { card = view ? view.render(ask, ctx) : unknownCard(ask, ctx); }
  catch (e) { console.warn('[asks] 카드 그리기 실패', ask.kind, e); card = unknownCard(ask, ctx); }
  card.classList.add('ask-card');
  card.dataset.askId = ask.id;
  card.dataset.askKind = ask.kind;
  card.dataset.askSig = askSignature(ask);
  return card;
}

/**
 * 자리(host)의 카드들을 목록에 맞춘다 — **그대로인 카드는 건드리지 않는다.**
 *  ⚠ 같은 요청을 다시 그리면 사람이 눌러 둔 선택 · 치던 값 · 올리던 파일 칸이 지워진다(실측 2026-10-26: 노션·슬랙을 고르고 몇 초 뒤 다 풀렸다).
 *   그래서 없어진 요청의 카드만 빼고, 새 요청의 카드만 끼운다. 붙어 있는 카드는 떼었다 다시 붙이지도 않는다(포커스 · 한글 조합이 끊긴다).
 */
export function syncAskCards(host: HTMLElement, asks: readonly Ask[], hooks: AskHooks): void {
  const want = new Map(asks.map((a) => [a.id, askSignature(a)]));
  const have = new Map<string, HTMLElement>();
  for (const c of [...host.children] as HTMLElement[]) {
    const id = c.dataset.askId || '';
    if (!id || want.get(id) !== c.dataset.askSig) c.remove(); else have.set(id, c);
  }
  let prev: HTMLElement | null = null;
  for (const a of asks) {
    let node = have.get(a.id);
    if (!node) {
      node = askCard(a, hooks);
      if (prev) prev.after(node); else host.prepend(node);
    }
    prev = node;
  }
}

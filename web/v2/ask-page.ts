// v2/ask-page.ts — 요청 화면(#/ask · #/ask/<id>) (#5713): AI 가 나에게 걸어 둔 요청을 **주소로** 여는 자리.
//
//  ── 누가 오나 ──
//  로컬 터미널에서 AI 를 쓰는 사람. 그 AI 가 자격 입력칸 · 객관식 · 파일 올리기를 걸면 도구 응답에 이 주소
//   (`<게이트웨이>/ui/#/ask/<id>`)가 실리고, AI 가 «이 링크에서 넣어 주세요» 로 준다. 종전엔 그 링크가 리브 화면(#/liv?board=1)이었고
//   «사람당 한 칸» 이라 어느 요청인지 가리지 못했다.
//  ── 어디로 가나(v2/main.ts 'ask' 라우트가 정한다) ──
//   · 그 요청의 세션이 이 화면의 세션 목록에 있으면 → **그 세션 화면**으로 가고, 곁칸 «요청» 칸이 그 카드를 짚는다(session-ask-pane focusAsk).
//   · 세션을 못 찾으면(세션 없이 건 요청 · 목록에 없는 세션 · 이미 끝난 요청) → 이 화면. 그 요청 카드와, 열려 있는 내 다른 요청들을 보인다.
//  카드는 곁칸과 같은 한 벌이다(asks/registry.ts). 이 화면만의 일은 하나 — 한 마디를 세션에 못 넣었을 때(로컬 터미널의 AI 는 서버가
//   말을 넣을 길이 없다) «AI 에게 이렇게 전해 주세요» 를 **화면에 남긴다**(토스트는 4초 뒤 사라진다).
import { el } from '../core.js';
import { ALL_ASKS, getAsk, refreshAsks, watchAsks, type Ask } from '../asks/api.js';
import { syncAskCards, type AskHooks } from '../asks/registry.js';
import '../asks/kinds.js';   // 카드 종류 등록

/** 요청 주소의 해시 — 서버(capabilities/session-ask.ts askHash)와 한 벌. */
export const askHash = (id?: string | null): string => (id ? '#/ask/' + encodeURIComponent(id) : '#/ask');

const STATUS_NOTE: Record<string, string> = {
  done: '이 요청은 이미 끝났어요.',
  dismissed: '이 요청은 «나중에» 로 접어 두었어요. 필요하면 AI 에게 다시 요청해 달라고 말해 주세요.',
  canceled: '이 요청은 AI 가 내렸어요(더는 필요 없거나 새 요청으로 바뀌었습니다).',
};

export interface AskPageHandle { destroy(): void }

/**
 * 요청 화면을 그린다. askId = 주소가 짚은 요청(없으면 내 열린 요청 전부).
 *  sessionHref — 그 세션 화면의 주소(셸이 그 세션을 알 때만). 카드 옆에 «세션에서 보기» 를 건다.
 */
export function renderAskPage(host: HTMLElement, askId: string | null, o: { sessionHref?: (sid: string) => string | null } = {}): AskPageHandle {
  const note = el('div', { class: 'ask-page-note', hidden: true });        // 주소가 짚은 요청의 상태(끝남 · 못 찾음)
  const told = el('div', { class: 'ask-page-told', hidden: true });        // «AI 에게 이렇게 전해 주세요»
  const list = el('div', { class: 'ask-page-list liv-askdock' });
  const empty = el('p', { class: 'ask-page-empty pn-fine', hidden: true });
  const wrap = el('div', { class: 'ask-page' },
    el('header', { class: 'ask-page-head' },
      el('h1', { text: 'AI 가 기다리는 것' }),
      el('p', { class: 'ask-page-sub', text: 'AI 가 진행하려면 받아야 하는 것들이에요. 입력한 값은 잠긴 보관함으로 바로 들어가고, 대화에는 남지 않습니다.' })),
    note, told, list, empty);
  host.replaceChildren(wrap);

  let dead = false;
  let flashed = false;
  let answered = 0;

  const hooks: AskHooks = {
    refresh: () => refreshAsks(ALL_ASKS),
    manual: (say) => {
      told.replaceChildren(
        el('b', { text: '받았어요.' }),
        el('span', { text: ' AI 가 있는 터미널(대화)에 이렇게 전해 주세요:' }),
        el('code', { class: 'ask-page-say', text: say }));
      told.hidden = false;
    },
    done: () => { answered++; },
  };

  function paint(asks: Ask[]): void {
    if (dead) return;
    //  주소가 짚은 요청을 맨 위로 — 나머지는 건 순서.
    const ordered = askId ? [...asks.filter((a) => a.id === askId), ...asks.filter((a) => a.id !== askId)] : [...asks];
    syncAskCards(list, ordered, hooks);
    for (const c of [...list.children] as HTMLElement[]) {
      const a = ordered.find((x) => x.id === c.dataset.askId);
      const href = a?.session_id && o.sessionHref ? o.sessionHref(a.session_id) : null;
      let link = c.querySelector(':scope > .ask-page-sess') as HTMLAnchorElement | null;
      if (href && !link) { link = el('a', { class: 'ask-page-sess', text: '이 요청을 건 세션 보기 →' }) as HTMLAnchorElement; c.append(link); }
      if (link) { if (href) link.href = href; else link.remove(); }
    }
    if (askId && !flashed) {
      const card = [...list.children].find((c) => (c as HTMLElement).dataset.askId === askId) as HTMLElement | undefined;
      if (card) {
        flashed = true;
        card.classList.add('ask-flash');
        window.setTimeout(() => card.classList.remove('ask-flash'), 2400);
        (card.querySelector('input:not([type=file]), textarea') as HTMLElement | null)?.focus({ preventScroll: true });
      }
    }
    empty.textContent = answered ? '모두 끝났어요. 이 창은 닫으셔도 됩니다.' : '지금 기다리는 요청이 없어요.';
    empty.hidden = ordered.length > 0;
    if (askId) void paintNote(asks);
  }

  /** 주소가 짚은 요청이 열린 목록에 없으면 왜 없는지 말한다(끝났다 · 접었다 · 내렸다 · 못 찾았다). */
  async function paintNote(asks: Ask[]): Promise<void> {
    if (!askId) return;
    if (asks.some((a) => a.id === askId)) { note.hidden = true; return; }
    const a = await getAsk(askId);
    if (dead) return;
    note.textContent = a
      ? (STATUS_NOTE[a.status] ?? '')
      : '이 요청을 찾을 수 없어요 — 이미 정리됐거나, 요청을 받은 계정과 다른 계정으로 로그인한 것일 수 있어요.';
    note.hidden = !note.textContent;
  }

  const off = watchAsks(ALL_ASKS, (asks) => paint(asks));
  return { destroy: () => { dead = true; off(); } };
}

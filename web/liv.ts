// liv.ts — 리브 화면(#/liv, 단독) — #1631 → #4970 «리브 = 세션 하나»(상민님 결정 2026-10-22·23 — 주소는 남기고 내용만 바꾼다).
//
//  ── 이 화면이 무엇인가 ──
//  리브는 그 사람의 리브 세션 하나다(src/org/liv/session.ts). 리브 세션이 있는 사람은 이 화면이 아니라 **그 세션 화면**으로 간다
//   (보통 세션 화면 + 오른쪽 «리브» 칸 — v2/main.ts 'liv' 라우트 · lib/liv-desk livRoute). 이 화면에 남는 사람은 둘이다:
//   · 리브 세션이 아직 없는 사람 — [리브와 대화 시작](로그인한 AI 가 있으면 그 AI 로 연다 · 없으면 «쓰는 AI 에서 하기» 세 걸음)
//   · 커서 같은 로컬 AI 를 쓰는 사람 — 그 AI 가 «이 링크에서 넣어 주세요» 로 준 `#/liv?board=1` (물음 카드를 여기서 받는다)
//  종전(#4032)엔 이 화면이 리브 세션 대화창을 통째로 붙였다(liv-chat.ts). 대화는 이제 세션 화면이 하므로 이 화면엔 대화 칸이 없다.
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇이 덜 됐는지(카드)는 서버가 이미 정해서 준다(GET /api/ui/me/liv). 화면이 자기 판정을 가지면 리브와 다른 답을 하고,
//  그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다(카드는 web/liv-cards.ts 한 벌).
import { api, el, toast } from './core.js';
import { bindCtxSurface } from './v2/ctx-registry.js';   // #3784 리브 화면 우클릭
import { fillConnectApps, livAskCard, livAskTyping, livLetterBox, livToast, pokeLivStatus, watchLivStatus, type LivHooks } from './liv-cards.js';
import { openLiv } from './v2/liv-open.js';
import { rememberUnsentDraft } from './v2/quick-session.js';
import { ownAiStepsHtml, wireOwnAiSteps } from './v2/connect-own-ai.js';

export type { LivFinding, LivMode, LivSecretAsk, LivStatus } from './liv-cards.js';

/** 쓰는 AI(로그인된 서버 AI 가 없을 때)에 붙여 넣을 말 — 리브 점검. */
export const SAY_LIV_IN_AI = '라이블리 liv 스킬로 이 워크스페이스 점검해 줘';

export interface RenderLivOpts {
  /** 나가는 길([← 라이블리])을 그리지 않는다(셸의 사이드바가 이미 있다). */
  embedded?: boolean;
  /** 리브 세션 id(셸이 이미 물었으면 준다). undefined 면 이 화면이 묻는다 · null 이면 없다. */
  sessionId?: string | null;
}

export async function renderLiv(view: HTMLElement | null, opts: RenderLivOpts = {}): Promise<void> {
  if (!view) return; // 라우터가 넘기는 $view() 는 셸이 아직 없으면 null 이다(대시보드와 같은 계약)
  view.replaceChildren();
  document.body.dataset.route = 'liv';

  let sessionId: string | null = opts.sessionId === undefined
    ? await api('/api/ui/me/liv/session').then((r: any) => (r && r.session_id ? String(r.session_id) : null), () => null)
    : opts.sessionId;

  // ── 머리 = 이 화면이 무엇인지 3초 안에 ──────────────────────────────────────────────
  //  처음 온 사람은 '리브'라는 이름만 보고는 여기가 무엇을 하는 곳인지 모른다(실측 지적 2026-08-19).
  //  그래서 이름 아래에 **무엇을 해 주는 곳인가**를 두 줄로 적는다. 기능 목록이 아니라 약속 한 문장이다.
  const head = el('header', { class: 'liv-top' },
    el('div', { class: 'liv-top-row' },
      el('span', { class: 'liv-face', 'aria-hidden': 'true', text: 'L' }),
      el('div', { class: 'liv-top-name' },
        el('b', { text: '리브' }),
        el('span', { class: 'liv-top-role', text: '워크스페이스 담당자' })),
      opts.embedded ? null : el('a', {
        class: 'btn btn-sm btn-ghost liv-top-out', href: '#/dashboard', text: '← 라이블리',
        title: '라이블리 홈으로 돌아갑니다.',
      })),
    el('p', { class: 'liv-top-say' },
      el('b', { text: '이 워크스페이스를 대신 손보는 담당자예요.' }),
      document.createTextNode(' 설명서를 드리지 않습니다 — 말씀하시면 제가 직접 합니다.')));

  // ── 리브에게 가는 문 — 세션이 있으면 그 대화로, 없으면 시작(로그인한 AI 가 없으면 «쓰는 AI 에서 하기») ──
  const door = el('div', { class: 'liv-door' });
  const ownAi = el('div', { class: 'liv-ownai', hidden: true });
  const paintDoor = (): void => {
    if (sessionId) {
      door.replaceChildren(el('a', { class: 'btn btn-primary', href: '#/s/' + encodeURIComponent(sessionId), text: '리브와 대화 이어 가기' }),
        el('span', { class: 'liv-door-note', text: '대화 화면 오른쪽 «리브» 칸에 이 내용이 함께 보입니다.' }));
      return;
    }
    const start = el('button', { class: 'btn btn-primary', type: 'button', text: '리브와 대화 시작' }) as HTMLButtonElement;
    start.onclick = async () => {
      start.disabled = true; const was = start.textContent; start.textContent = '여는 중…';
      try {
        const r = await openLiv({ job: 'liv' });
        if (r.ai) { location.hash = r.href; return; }
        ownAi.innerHTML = ownAiStepsHtml(SAY_LIV_IN_AI);
        wireOwnAiSteps(ownAi);
        ownAi.hidden = false;
      } catch (e) { toast('리브를 열지 못했어요 — ' + ((e as Error)?.message ?? e), true); }
      start.disabled = false; start.textContent = was;
    };
    door.replaceChildren(start, el('span', { class: 'liv-door-note', text: '로그인된 AI 로 리브 세션을 엽니다. 첫 말은 «워크스페이스를 점검해 줘» 입니다.' }));
  };
  paintDoor();

  // 편지 = 지금 손볼 것. 물음 = 리브가 사람에게 받아야 하는 것(자격·객관식·올리기) — 이 화면에선 머리 바로 아래(대화 칸이 없다).
  const askHost = el('div', { class: 'liv-askdock liv-board-ask' });
  const letter = el('section', { class: 'liv-letter' }, el('div', { class: 'liv-letter-skel' }));
  const apps = el('div', { class: 'liv-apps' }, el('p', { class: 'pn-fine', text: '불러오는 중…' }));
  const wrapEl = el('div', { class: 'liv-wrap liv-board' }, head,
    el('div', { class: 'liv-body liv-body-solo' },
      door, ownAi, askHost, letter,
      el('section', { class: 'liv-apps-sec' },
        el('div', { class: 'liv-apps-h' }, el('b', { text: '외부 앱 연결' }), el('a', { class: 'liv-apps-more', href: '#/connect', text: '현황판 →' })),
        apps)));
  view.append(wrapEl);
  // #3784 빈 자리 우클릭 — 다시 확인
  bindCtxSurface(wrapEl, () => [{ label: '다시 확인하기', icon: 'refresh', run: () => pokeLivStatus() }]);

  /**
   * 카드가 리브에게 건네는 한 마디 — 리브 세션이 있으면 그 세션에 넣는다. 없으면(로컬 AI 를 쓰는 사람) 그 AI 에 전할 말을 알려 준다.
   *  ⚠ 세션이 없을 때 이 말로 리브 세션을 **새로 열지 않는다** — «자격 저장했어요» 같은 맞장구가 첫 지시가 되면 리브가 엉뚱한 일을 시작한다.
   *  못 넣었으면(멈춘 세션 — delivered:false) 그 세션 화면으로 간다 — 입력칸에 그 말이 돌아와 있고, 보내면 되살리며 넣는다.
   */
  const say = async (text: string): Promise<void> => {
    if (!sessionId) { livToast(`쓰시는 AI 에 «${text}» 라고 전해 주세요.`); return; }
    try {
      const r = await openLiv({ text });
      if (!r.ai) return;
      sessionId = r.sessionId;
      if (r.delivered) { livToast('리브 대화에 전했어요.'); return; }
      livToast('리브 세션이 멈춰 있어요 — 대화 입력칸에 담아 뒀으니 보내 주세요.');
      location.hash = r.href;
    } catch (e) { toast('리브에게 전하지 못했어요 — ' + ((e as Error)?.message ?? e), true); }
  };
  /** 담기만(보내지 않는다) — 리브 세션 입력칸에 돌려 두고 그 대화로 간다. 세션이 없으면 쓰는 AI 에 전할 말로 알려 준다. */
  const fill = (text: string): void => {
    if (!sessionId) { livToast(`쓰시는 AI 에 «${text}» 라고 말해 보세요.`); return; }
    rememberUnsentDraft(sessionId, text);
    location.hash = '#/s/' + encodeURIComponent(sessionId);
  };
  const hooks: LivHooks = { say: (t) => { void say(t); }, fill, refresh: () => pokeLivStatus(), workingSub: '끝나면 리브 대화에서 이어서 말씀드릴게요.' };

  watchLivStatus((st) => {
    if (!wrapEl.isConnected || !st) return;
    if (!livAskTyping(askHost)) {
      const card = livAskCard(st.secretAsk, hooks);
      askHost.replaceChildren(...(card ? [card] : []));
    }
    letter.replaceChildren(livLetterBox(st, hooks, letter));
  }, () => wrapEl.isConnected && document.body.dataset.route === 'liv', () => wrapEl.isConnected);
  void fillConnectApps(apps);
}

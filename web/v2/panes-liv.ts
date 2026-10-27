// web/v2/panes-liv.ts — 리브 세션의 오른쪽 «리브» 칸(#4970 «리브 = 세션 하나», 상민님 결정 2026-10-22·23).
//
//  리브는 그 사람의 리브 세션 하나다. 대화는 가운데 세션 대화창이 하고, 이 칸은 **워크스페이스 담당자로서 지금 볼 것**을 둔다:
//   · 리브가 대화 입력칸 위에서 답을 기다리는지 한 줄(물음 카드 자체는 입력칸 바로 위 — web/liv-ask-dock.ts 머리말)
//   · 지금 손볼 것(편지 — 서버 판정 GET /api/ui/me/liv 그대로, 화면이 판정하지 않는다)
//   · 외부 앱 연결 상태 한 줄씩(서버 org_connect_status 그대로) — 상세는 [외부 앱 연결] 현황판
//  셸에 내장한 칸이다(조직 앱이 아니다) — 사용 동의 없이 리브 세션에 늘 붙고, 금고에 쓰는 물음 카드도 셸의 화면 전용 문을 그대로 쓴다.
//  이름: «리브» 는 워크스페이스 담당자만 가리킨다. 프로젝트 곁칸의 옛 «리브»(프로젝트 대화)는 «프로젝트 대화» 다(panes-parts.ts PART_DEFS).
//  ⚠ 부품은 «지금 보는 세션의 것»(#1819) — document 이벤트를 걸지 않는다. 리브에게 건네는 말은 리브 세션으로만 간다(세션 id 로 찾는다).
import { el, toast } from '../core.js';
import { fillConnectApps, livLetterBox, pokeLivStatus, watchLivStatus, type LivHooks } from '../liv-cards.js';
import { putIntoSession, sendIntoSession } from './sess-input.js';
import { knownLivSessionId, openLiv } from './liv-open.js';
import { rememberUnsentDraft } from './quick-session.js';
import type { Part, PartCtx } from './panes-parts.js';

const CONNECT_EVERY_MS = 30_000;   // 연결 상태는 천천히 바뀐다 — 셸 틱(8초)마다 묻지 않는다

export function livDeskPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-livdesk' });
  const askLine = el('p', { class: 'pn-livdesk-ask', hidden: true },
    el('span', { class: 'pn-livdesk-dot', 'aria-hidden': 'true' }),
    el('span', { text: '리브가 세션 화면에서 답을 기다리고 있어요 — 대화로 보면 입력칸 바로 위, 터미널로 보면 맨 위에 있어요.' }));
  const letter = el('section', { class: 'liv-letter pn-livdesk-letter' }, el('div', { class: 'liv-letter-skel' }));
  const appsList = el('div', { class: 'liv-apps pn-livdesk-apps' }, el('p', { class: 'pn-fine', text: '불러오는 중…' }));
  root.append(
    el('header', { class: 'pn-livdesk-head' },
      el('span', { class: 'liv-face', 'aria-hidden': 'true', text: 'L' }),
      el('div', { class: 'pn-livdesk-name' },
        el('b', { text: '리브' }),
        el('span', { class: 'pn-livdesk-role', text: '워크스페이스 담당자' }))),
    el('p', { class: 'pn-livdesk-say', text: '이 워크스페이스를 대신 손보는 담당자예요. 대화에서 말씀하시면 제가 직접 합니다.' }),
    askLine,
    letter,
    el('section', { class: 'pn-livdesk-sec' },
      el('div', { class: 'pn-livdesk-h' },
        el('b', { text: '외부 앱 연결' }),
        el('a', { class: 'pn-livdesk-more', href: '#/connect', text: '현황판 →' })),
      appsList));

  /** 지금의 리브 세션 — 셸이 아는 좌표가 먼저, 모르면 지금 보는 세션(이 칸은 리브 세션에만 선다). */
  const livId = (): string | null => knownLivSessionId() || ctx.curSession();

  /**
   * 리브에게 한 마디 — 리브 세션 대화창이 떠 있고 입력칸이 비어 있으면 거기로 보낸다(사람이 보낸 말과 같은 길). 아니면 서버가 그 세션에 넣는다.
   *  서버가 못 넣었으면(멈춘 세션 — delivered:false) 그 말을 **지금 보이는** 입력칸에 담아 두고 알린다 — 보내면 대화창이 세션을 되살리며 넣는다.
   */
  /** 넣었으면 true — 실패는 이 안에서 사람에게 말한다(부른 쪽이 «전했어요» 를 겹쳐 말하지 않게). */
  async function say(text: string): Promise<boolean> {
    const id = livId();
    if (id && sendIntoSession([id], text)) return true;
    try {
      //  있는 리브 세션에만 — 세션이 사라진 사이 이 말이 새 리브 세션의 첫 지시가 되지 않게(격리 리뷰).
      const r = await openLiv({ text, onlyExisting: true });
      if (!r.ai) {
        toast(r.reason === 'no-session' ? '리브 세션이 없어요 — 레일의 [리브]를 눌러 다시 시작해 주세요.' : '로그인된 AI 가 없어 리브에게 전하지 못했어요 — [AI 계정 연결]에서 로그인해 주세요.', true);
        return false;
      }
      //  못 넣었으면 openLiv 가 그 세션 입력칸에 담아 두었다(떠 있으면 지금 · 아니면 다음에 열 때).
      if (!r.delivered) toast('리브 세션이 멈춰 있어 입력칸에 담아 뒀어요 — 보내면 이어집니다.');
      if (location.hash !== r.href) location.hash = r.href;
      return !!r.delivered;
    } catch (e) { toast('리브에게 전하지 못했어요 — ' + ((e as Error)?.message ?? e), true); return false; }
  }
  const hooks: LivHooks = {
    say: (t) => { void say(t); },
    //  **담기만** — 리브 세션 입력칸에 넣는다(보내지 않는다 — 사람이 고쳐서 보낸다). 그 화면이 안 떠 있으면 그 세션을 열어 입력칸에 돌려 둔다.
    fill: (t) => {
      const id = livId();
      if (!id) return;
      if (putIntoSession([id], t)) return;
      rememberUnsentDraft(id, t);
      location.hash = '#/s/' + encodeURIComponent(id);
    },
    refresh: () => pokeLivStatus(),
    working: () => {
      const id = livId();
      const s = id ? ctx.data().sessions.find((x) => x.id === id) : null;
      return !!s && (s.stateKey === 'busy');
    },
    workingSub: '끝나면 대화에서 이어서 말씀드릴게요.',
  };

  const off = watchLivStatus((st) => {
    if (ctx.dead() || !root.isConnected || !st) return;
    askLine.hidden = !st.secretAsk;
    letter.replaceChildren(livLetterBox(st, hooks, letter));
  }, () => !ctx.dead() && root.isConnected && root.getClientRects().length > 0);

  let lastApps = 0;
  async function loadApps(force = false): Promise<void> {
    if (ctx.dead()) return;
    if (!force && Date.now() - lastApps < CONNECT_EVERY_MS) return;
    lastApps = Date.now();
    //  #5058 — 앱 한 줄을 누르면 연결 화면으로 **보내지 않고** 그 일을 이 리브 대화에 넣는다(원준님 2026-10-27 «외부앱 연결 페이지로
    //   보낼게 아니고, 필요한 내용을 그 온보딩 세션에 넣는 방식»). 종전엔 #/connect/<앱> 로 떠나 대화로 돌아올 길을 잃었다.
    //   상세 화면이 필요하면 머리의 [현황판 →] 이 그 문이다.
    await fillConnectApps(appsList, (p) => {
      const text = p.bucket === 'on' ? `${p.label} 연결 상태를 보고, 손볼 게 있으면 알려 주세요.` : `${p.label} 연결 도와주세요.`;
      void say(text).then((ok) => { if (ok) toast(`리브에게 «${text}» 를 전했어요.`); });
    });
  }
  void loadApps(true);

  return {
    root,
    tick: () => { void loadApps(); },
    destroy: () => off(),
  };
}

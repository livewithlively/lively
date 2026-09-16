// 리브 탭의 대화 칸 — 리브는 **진짜 세션**이다(#4032, 상민님 결정 2026-09-16).
//
//  ── 무엇이 바뀌었나 ──
//  종전엔 한 마디마다 서버가 헤드리스 한 턴을 띄우고(POST me/liv/turn) 이 파일이 그 진행 파일을 당겨 읽어 그렸다.
//  그 턴은 게이트웨이가 도는 기계의 tmux 에 떠서, 세션을 노드의 세션 컨테이너에 띄우는 매니지드에서는 한 번도 안 떴다(500).
//  이제 리브 탭은 그 사람의 리브 세션 하나(GET me/liv/session)를 찾아 **그 세션 대화창**(web/session-chat.ts)을 붙인다.
//  보내기·멈춤·되살리기·되그리기는 전부 세션 대화창의 것이다 — 여기 남는 건 «어느 세션인가» 와 «없으면 첫 말로 연다» 뿐이다.
//
//  ── 이 칸이 지키는 것 ──
//  · 리브 세션은 **대화 보기가 본자리**다(chatHome) — 리브의 대상은 터미널을 모르는 사람이다.
//  · 세션이 되살아나면(복원) 새 id 다 — 전역 주소를 바꾸지 않고 **이 칸만** 새 세션으로 갈아 붙인다(onResumed).
//  · 리브가 던진 물음(자격·객관식·올리기)은 **입력칸 바로 위**에 앉는다(askHost) — 대화와 같은 칸이다.
//  · 카드가 리브에게 말을 거는 문(livChatAsk)·입력칸에 담기만 하는 문(livChatFill)은 **리브 칸 안의 입력칸**만 만진다 —
//    셸은 탭 DOM 을 살려 두므로 문서 전체에서 입력칸을 찾으면 다른 탭의 세션에 말이 간다.
import { api } from './core.js';
import { createChatView, type ChatView } from './chat-view.js';
import type { SessionChatHandle } from './session-chat.js';
import { mergeSessions, renderSession } from './v2/views.js';
import { rememberCreated, takeCreated } from './v2/created-cache.js';
import { rememberFirstPrompt } from './v2/quick-session.js';

/** 셸이 리브 세션 대화창을 붙이는 문 — v2 셸은 자기 세션 목록·20초 갱신·탭 수명으로 붙인다. 없으면 이 파일이 스스로 목록을 읽는다(클래식 셸). */
export type LivSessionMounter = (
  host: HTMLElement,
  id: string,
  o: { onResumed: (newId: string) => void; isVisible: () => boolean },
) => Promise<SessionChatHandle | null>;

export interface LivChatOpts {
  mountSession?: LivSessionMounter | null;
  /** 첫 말로 리브 세션을 새로 열었다 — 셸이 사이드바에 곧바로 싣는다(생성 응답 한 장). */
  onSessionCreated?: ((row: unknown) => void) | null;
}

interface LivSessionRef { session_id: string | null }
interface LivOpened { session_id: string; created: boolean; session?: { id?: string } | null }

// ── 리브가 지금 일하는 중인가 — 편지 칸(web/liv.ts)이 «드릴 말씀이 없습니다» 대신 «일하는 중» 을 쓰는 재료 ──
let livBusy = false;
export function livChatBusy(): boolean { return livBusy; }
function setBusy(on: boolean): void {
  if (livBusy === on) return;
  livBusy = on;
  document.dispatchEvent(new CustomEvent('liv:busy', { detail: { busy: on } }));
}

/** 지금 리브 칸 — 카드의 문(livChatAsk·livChatFill)이 **이 칸 안에서만** 입력칸을 찾는다. */
let livHost: HTMLElement | null = null;

/** 셸 없이(클래식) 리브 세션 대화창을 붙인다 — 목록을 한 번 읽어 그 세션 한 장으로 그린다. */
const mountFromLists: LivSessionMounter = async (host, id, o) => {
  const [live, logs] = await Promise.all([
    api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
    api('/api/ui/v6/sessions?limit=40').then((d: any) => (d && d.sessions) || []).catch(() => [] as any[]),
  ]);
  //  방금 연 세션은 목록에 한 박자 늦게 오른다 — 생성 응답 한 장을 먼저 깐다(목록 행이 있으면 그게 이긴다).
  const made = takeCreated(id);
  const rows = made ? [made, ...(live as any[])] : (live as any[]);
  return renderSession(host, { projects: [], sessions: mergeSessions(rows, logs as any[]), loadedAt: Date.now() }, id, {
    chatHome: true, isVisible: o.isVisible, onResumed: o.onResumed,
  });
};

/** askHost = 리브가 던진 물음이 앉는 자리. **대화와 같은 칸, 입력 바로 위**에 끼운다. */
export function mountLivChat(host: HTMLElement, askHost: HTMLElement, opts: LivChatOpts = {}): void {
  livHost = host;
  setBusy(false);
  const mount = opts.mountSession ?? mountFromLists;
  const ownsHandle = !opts.mountSession;   // 셸이 붙였으면 수명(파괴)도 셸이 쥔다 — 두 번 부수지 않는다
  let handle: SessionChatHandle | null = null;
  let emptyView: ChatView | null = null;     // 세션이 없을 때의 빈 대화(첫 말을 받는 자리)
  let gen = 0;                               // 늦게 끝난 붙이기가 새 화면을 덮지 않게
  const isVisible = (): boolean => host.isConnected && document.body.dataset.route === 'liv';

  /** 세션 대화창의 대화 칸(.livc-wrap)에 물음 자리를 끼운다 — 입력칸(.livc-note·.livc-foot) 바로 위. */
  function dockAsk(): void {
    const wrap = host.querySelector('.sc-chat .livc-wrap');
    if (!wrap) return;
    const note = wrap.querySelector(':scope > .livc-note');
    if (note) note.before(askHost); else wrap.append(askHost);
  }

  /** 일하는 중 — 대화창의 입력 상자가 도는 동안 dt-busy 를 단다(chat-view busy). 그 표식을 그대로 읽는다. */
  function watchBusy(): void {
    const form = host.querySelector('.sc-chat .livc-compose');
    if (!form) { setBusy(false); return; }
    const read = (): void => { if (livHost === host) setBusy(form.classList.contains('dt-busy')); };
    read();
    new MutationObserver(read).observe(form, { attributes: true, attributeFilter: ['class'] });
  }

  async function show(id: string): Promise<void> {
    const my = ++gen;
    if (ownsHandle) handle?.destroy();
    handle = null;
    emptyView?.destroy();                      // 빈 대화의 Esc·시계 리스너를 걷는다(화면은 곧 대화창이 덮는다)
    emptyView = null;
    setBusy(false);
    let h: SessionChatHandle | null = null;
    try { h = await mount(host, id, { onResumed: (nid) => { void show(nid); }, isVisible }); }
    catch (e) { console.warn('[liv] 리브 세션 대화창을 붙이지 못했다', e); }
    if (my !== gen || !host.isConnected) { if (ownsHandle) h?.destroy(); return; }
    if (!h) {
      //  목록에서 못 찾았다(지워졌거나 목록이 아직 안 왔다) — 막다른 화면 대신 말할 자리를 준다. 첫 말이 새로 열거나 그 세션을 되찾는다.
      paintEmpty('지난 대화를 불러오지 못했습니다. 말씀하시면 이어서 하겠습니다.');
      return;
    }
    handle = h;
    dockAsk();
    watchBusy();
  }

  /** 말 보내기 — 붙은 대화창의 입력칸으로 넣고 보낸다(멈춘 세션이면 대화창이 되살리면서 보낸다). */
  function sendIntoSession(text: string): void {
    const input = host.querySelector('.sc-chat .livc-input') as HTMLTextAreaElement | null;
    const form = host.querySelector('.sc-chat .livc-compose') as HTMLFormElement | null;
    if (!input || !form) return;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    if (!input.disabled) form.requestSubmit();
  }

  /** 리브 세션이 아직 없다 — 입력칸만 있는 빈 대화. 첫 말이 세션을 연다. */
  function paintEmpty(note?: string): void {
    ++gen;
    if (ownsHandle) handle?.destroy();
    handle = null;
    emptyView?.destroy();
    setBusy(false);
    let view: ChatView | null = null;
    view = createChatView(host, {
      who: { me: '나', ai: '리브' },
      placeholder: '리브에게 말하기',
      busyPlaceholder: '리브를 부르는 중…',
      toolLabel: (name: string) => ({ label: name }),
      thinking: 'hide',
      sendWhileBusy: false,
      style: 'desktop',
      onSend: (text) => (view ? startWith(view, text) : undefined),
      escActive: () => false,
      opening: null,   // 첫 화면의 초대는 편지가 한다(#1719 재구성) — 같은 초대를 두 곳에 두지 않는다
      askHost,
    });
    if (note) view.setNote(note);
    emptyView = view;
  }

  async function startWith(view: ChatView, text: string): Promise<void> {
    const my = gen;
    const t = view.turn(text);
    view.running(t); view.busy(true); view.scroll();
    let r: LivOpened;
    try {
      r = await api('/api/ui/me/liv/session', { method: 'POST', body: JSON.stringify({ text }) }) as LivOpened;
    } catch (e) {
      view.settle(t); view.busy(false);
      view.error(t, `보내지 못했습니다. ${(e as Error).message}`);
      return;
    }
    if (my !== gen || !host.isConnected) return;
    if (r.created) {
      //  세션 대화창이 붙자마자 이 말을 «보낸 모양» 으로 먼저 그린다(서버가 입력창이 뜬 뒤 실제로 넣는다).
      rememberFirstPrompt(r.session_id, text);
      if (r.session) { rememberCreated(r.session); opts.onSessionCreated?.(r.session); }
      await show(r.session_id);
      return;
    }
    //  이미 리브 세션이 있었다(다른 탭·처음 설정이 방금 열었다) — 그 대화창을 붙이고 거기서 보낸다.
    await show(r.session_id);
    if (handle) sendIntoSession(text);
  }

  async function boot(): Promise<void> {
    const my = gen;
    let ref: LivSessionRef | null = null;
    try { ref = await api('/api/ui/me/liv/session') as LivSessionRef; }
    catch { ref = null; }
    if (my !== gen || !host.isConnected) return;
    if (ref && ref.session_id) await show(ref.session_id);
    else paintEmpty(ref ? undefined : '리브 대화를 확인하지 못했습니다. 말씀하시면 이어서 하겠습니다.');
  }

  void boot();
}

/** 이 리브 칸의 입력칸 — 세션 대화창이 붙었으면 그 입력칸, 아니면 빈 대화의 입력칸. */
function livInput(): { input: HTMLTextAreaElement; form: HTMLFormElement } | null {
  const h = livHost;
  if (!h || !h.isConnected) return null;
  const input = h.querySelector('.livc-input') as HTMLTextAreaElement | null;
  const form = h.querySelector('.livc-compose') as HTMLFormElement | null;
  return input && form ? { input, form } : null;
}

/**
 * 입력칸에 **담기만** 한다(보내지 않는다). 침묵 화면의 '이런 것도 부탁하실 수 있어요' 가 쓰는 문.
 * 보내기까지 하면 사람이 문장을 고칠 기회를 뺏는다 — 예시는 출발점이지 완성된 지시가 아니다.
 */
export function livChatFill(text: string): void {
  const c = livInput();
  if (!c) return;
  c.input.value = text;
  c.input.dispatchEvent(new Event('input'));
  c.input.focus();
}

/**
 * 카드(맡기기·객관식 답·업로드·자격 저장)가 리브에게 말을 거는 **유일한 문**.
 * 리브 칸이 아직 준비 중이면(세션 대화창을 붙이는 중) 기다린다 — 끝내 못 보내면 친 글은 입력칸에 남겨 사람이 직접 보낼 수 있게 한다.
 */
export function livChatAsk(text: string): void {
  const t0 = Date.now();
  const tryOnce = (): void => {
    const c = livInput();
    if (!c || c.input.disabled) {
      if (Date.now() - t0 > 120_000) { if (c) c.input.value = text; return; }
      setTimeout(tryOnce, 500);
      return;
    }
    c.input.value = text;
    c.input.dispatchEvent(new Event('input'));
    c.form.requestSubmit();
  };
  tryOnce();
}

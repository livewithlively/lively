// v2/remote-web.ts — 웹 판(브라우저에서 연 라이블리)의 세션 [웹] 칸: 그 사람 데스크톱 앱 탭의 **원격 화면** (#4993 (A)).
//
//  브라우저는 남의 사이트를 칸 안에 못 띄운다(X-Frame-Options · frame-ancestors — browser-surface 머리말). 그래서 그 사람의
//  데스크톱 앱이 연결돼 있으면, 앱 안 **같은 세션 · 같은 칸**의 탭을 원격으로 쓴다: 화면은 그 탭의 스크린샷을 받아 그리고,
//  클릭 · 휠 · 글 · 키는 그 탭으로 보낸다. 길은 AI 가 쓰는 브라우저 툴 그대로(/api/ui/browser/* + x-lively-session) —
//  서버에 새 길이 없다. 데스크톱이 없으면 종전 iframe 칸을 그대로 쓰고, 데스크톱이 켜지면 원격 화면으로 바꾼다.
//  판정(키 · 좌표 · 휠 · 입력 모으기 · 받기 간격)은 remote-web-kit.ts(시험 표), 여기는 그 배선이다.
//  ★ 원격 화면 하나는 **만들 때의 (세션, 탭) 하나에 묶인다.** 세션이 바뀌면 새로 만든다 — 묶지 않으면 세션을 바꾸는 순간
//   아직 안 보낸 글 · 클릭이 새 세션의 탭으로 가고(로그인된 다른 사이트에 비밀번호가 들어간다), 날아가던 옛 화면이 새 칸에
//   그려진다(격리 리뷰 blocking — 실측 재현). 옛 것은 닫을 때 남은 입력을 **옛 세션으로** 마저 보낸다(거기서 친 글이다).
//  ⚠ 글은 숨긴 입력칸(sink)으로 받는다 — 칸(div)은 편집할 수 없어 한글 조합(IME)이 아예 안 일어난다. 조합이 끝난 글 ·
//   붙여넣기 · 보통 글자는 그 입력칸의 input/composition/paste 사건으로 모아 보내고, 특수 키만 keydown 에서 보낸다.
import { api, el, toast } from '../core.js';
import { WEB_OPEN_EVT, pnIcon } from './panes-kit.js';
import { sessionOfKey, tabNoOfKey } from './browser-tabs.js';
import { normWebUrl } from './web-url.js';
import { hostErrorKind } from './browser-host-kit.js';
import { type InputItem, nextDelay, pushInput, remoteKeyAction, toShotPoint, wheelToScroll } from './remote-web-kit.js';
import type { Part, PartCtx } from './panes-parts.js';

const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
/** 데스크톱이 없을 때 다시 물어보는 간격 — 사람이 앱을 켜면 이만큼 안에 원격 화면으로 바뀐다(칸이 보일 때만 묻는다). */
const REPROBE_MS = 30_000;
/** 두 번 누름을 가르는 시간 — OS 더블클릭 간격(맥 기본 약 0.5초)에 맞춘다. 220ms 는 짧아 느린 두 번 누름이
 *  «한 번 + 두 번»(원격에서 세 번)이 됐다(격리 리뷰 실측: 250 · 400ms 간격). 그 사이 글 · 키가 오면 기다리지 않고 먼저 보낸다. */
const DBL_MS = 400;
/** 원격 요청 하나의 상한 — 답 없는 요청 하나가 줄 전체를 막지 않게(게이트웨이는 40초 안에 답한다 — 망이 멈출 때를 위한 것). */
const CALL_MS = 60_000;
/** (세션, 탭)마다 원격 일의 줄 하나 — 화면마다 따로 두면, 세션을 A→B→A 로 오갈 때 닫히며 남은 입력을 보내는 옛 A 화면과
 *  새 A 화면이 같은 탭에 따로 보내 순서가 뒤집혔다(격리 리뷰 실측: click · world · hello). 줄의 꼬리를 탭 하나에 하나로 둔다. */
const QUEUES = new Map<string, Promise<void>>();
function chain(qKey: string, job: () => Promise<void>): void {
  const run = (): Promise<void> => job().catch(() => { /* 일 안에서 이미 다룬다 — 줄은 끊기지 않는다 */ });
  const next = (QUEUES.get(qKey) || Promise.resolve()).then(run);
  QUEUES.set(qKey, next);
  void next.then(() => { if (QUEUES.get(qKey) === next) QUEUES.delete(qKey); });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => { window.setTimeout(r, ms); });

type State = 'connecting' | 'live' | 'empty' | 'paused' | 'stuck' | 'error';

async function desktopConnected(sessId: string): Promise<boolean> {
  try {
    const r: any = await api('/api/ui/browser/status', { method: 'POST', headers: { 'x-lively-session': sessId }, body: '{}' });
    return !!(r && r.connected);
  } catch { return false; }
}

/**
 * 웹 칸 — 데스크톱이 연결돼 있으면 원격 화면, 아니면 frame()(종전 iframe 칸). 세션이 없는 자리(새 세션 자리)는 늘 frame().
 */
export function remoteWebPart(ctx: PartCtx, frame: () => Part): Part {
  const root = el('div', { class: 'pn-part pn-web pn-web-remote-host' });
  let inner: Part | null = null;          // frame 모드의 iframe 칸
  let remote: Remote | null = null;       // 원격 모드
  let dead = false;
  let probeTimer = 0;
  const visible = (): boolean => !dead && root.isConnected && root.getClientRects().length > 0 && document.visibilityState === 'visible';
  const sess = (): string | null => (ctx.curSession() ? sessionOfKey(ctx.slotKey()) : null);
  const placeholder = (): HTMLElement => el('p', { class: 'pn-web-note pn-fine', text: '데스크톱 앱 연결을 확인하는 중…' });

  const scheduleProbe = (): void => {
    clearTimeout(probeTimer);
    //  안 보이는 칸은 묻지 않는다(숨긴 탭 · 백그라운드에서 30초마다 묻던 것 — 격리 리뷰) — 보일 때까지 미룬다.
    probeTimer = window.setTimeout(() => { if (visible()) void probe(); else scheduleProbe(); }, REPROBE_MS);
  };
  const useFrame = (): void => {
    if (dead) return;
    if (remote) { remote.destroy(); remote = null; }
    if (!inner) {
      inner = frame();
      const hint = el('p', { class: 'pn-web-note pn-fine pn-remote-hint', text: '데스크톱 앱이 켜져 있으면 이 칸이 그 앱 브라우저의 원격 화면으로 바뀝니다 — 사이트가 막지 않고, 로그인도 그 앱 것을 씁니다.' });
      root.replaceChildren(inner.root, hint);
    }
    scheduleProbe();
  };
  const useRemote = (): void => {
    if (dead || remote) return;
    if (!sess()) { useFrame(); return; }   // 세션 없는 자리(새 세션 자리)엔 묶을 세션이 없다 — 늦게 온 «연결됨» 이 여기 닿아도
    clearTimeout(probeTimer);
    inner?.destroy?.(); inner = null;
    //  lost 는 **자기 자신일 때만** — 세션을 바꿔 이미 갈아 끼운 옛 원격 화면의 늦은 409 가 새 화면을 iframe 칸으로 돌리지 않게.
    const me: Remote = makeRemote(ctx, () => { if (remote !== me) return; me.destroy(); remote = null; useFrame(); });
    remote = me;
    root.replaceChildren(me.root);
    me.start();
  };
  let probeSeq = 0;
  async function probe(): Promise<void> {
    if (dead) return;
    const my = ++probeSeq;
    const s = sess();
    const ok = !!s && (await desktopConnected(s));
    //  묻는 사이 더 새로 물었으면 이 답은 버린다(늦게 온 «없음» 이 방금 선 원격 화면을 iframe 칸으로 돌리지 않게),
    //   세션이 바뀌었으면 그 답은 옛 자리의 것이다 — 다시 묻는다(격리 리뷰: 세션 없는 자리에 원격 화면이 묶였다).
    if (dead || my !== probeSeq) return;
    if (sess() !== s) { void probe(); return; }
    if (ok) useRemote(); else useFrame();
  }
  root.append(placeholder());
  void probe();
  const offSess = ctx.onSession(() => {
    const wasRemote = !!remote;
    if (remote) {
      //  원격 화면은 한 (세션, 탭)에 묶여 있다 — 닫고(남은 입력은 옛 세션으로 마저 간다) 칸에서 곧바로 떼어
      //   늦게 오는 옛 화면이 새 칸에 그려지지 않게 한다.
      remote.destroy(); remote = null;
      root.replaceChildren(placeholder());
    }
    if (!sess()) { useFrame(); return; }
    //  원격 화면이었으면 데스크톱이 연결돼 있는 걸 이미 안다 — 다시 묻지 않고 새 세션의 원격 화면을 곧바로 세운다
    //   (상태 묻기는 데스크톱 탭 목록 왕복이라 바쁘면 몇 초 걸린다 — 끊겼으면 첫 요청의 409 가 iframe 칸으로 돌린다).
    //   iframe 칸이었으면 곧바로 묻는다(30초 다시 묻기를 기다리면 새 세션을 열고도 30초 동안 iframe 칸이었다 — 격리 리뷰).
    if (wasRemote) useRemote(); else void probe();
  });
  return {
    root,
    tick: () => { if (remote) remote.tick(); else inner?.tick?.(); },
    destroy: () => {
      dead = true;
      clearTimeout(probeTimer);
      offSess();
      remote?.destroy();
      inner?.destroy?.();
    },
  };
}

interface Remote { root: HTMLElement; start(): void; tick(): void; destroy(): void }

function makeRemote(ctx: PartCtx, lost: () => void): Remote {
  //  ★ 만들 때의 (세션, 탭)에 묶는다 — 머리말. 이 화면이 보내는 모든 요청은 이 둘로 간다.
  const key0 = ctx.slotKey();
  const sessId = sessionOfKey(key0);
  const tabNo = tabNoOfKey(key0);

  const root = el('div', { class: 'pn-part pn-web pn-web-remote' });
  const input = el('input', { class: 'pn-web-in', type: 'text', placeholder: '주소 또는 검색어 — 데스크톱 앱의 탭에서 열립니다', 'aria-label': '주소' }) as HTMLInputElement;
  input.onfocus = () => input.select();
  const openTab = el('a', { class: 'pn-web-btn ic', target: '_blank', rel: 'noopener', title: '지금 주소를 이 브라우저의 새 탭에서 엽니다.', 'aria-label': '새 탭에서 열기', href: '#' }, pnIcon('ext', 'pn-i sm')) as HTMLAnchorElement;
  const btn = (label: string, title: string, icon: string, fn: () => void): HTMLButtonElement =>
    el('button', { class: 'pn-web-btn ic', type: 'button', 'aria-label': label, title, onclick: fn }, pnIcon(icon, 'pn-i sm')) as HTMLButtonElement;
  const backBtn = btn('뒤로', '데스크톱 앱 탭에서 앞 화면으로 돌아갑니다.', 'chev', () => nav({ action: 'back' }));
  backBtn.classList.add('back');
  const fwdBtn = btn('앞으로', '데스크톱 앱 탭에서 뒤로 오기 전 화면으로 갑니다.', 'chev', () => nav({ action: 'forward' }));
  const reloadBtn = btn('다시 불러오기', '데스크톱 앱 탭을 다시 불러옵니다 — ⌘R(윈도는 Ctrl+R)도 같습니다.', 'undo', () => nav({ action: 'reload' }));
  const img = el('img', { class: 'pn-remote-img', alt: '데스크톱 앱 브라우저 화면', draggable: 'false' }) as HTMLImageElement;
  //  글을 받는 숨긴 입력칸 — 화면을 누르면 여기로 초점이 온다(머리말 ⚠).
  const sink = el('textarea', { class: 'pn-remote-sink', 'aria-label': '원격 화면 입력', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  const msg = el('div', { class: 'pn-remote-msg' });
  const stage = el('div', { class: 'pn-webstage pn-remote-stage' }, img, sink, msg);
  const NOTE = '데스크톱 앱 브라우저의 원격 화면입니다 — 누르고 쓰는 것이 그 앱의 같은 탭으로 갑니다.';
  const note = el('p', { class: 'pn-web-note pn-fine pn-remote-note', text: NOTE });
  root.append(el('div', { class: 'pn-web-bar' }, el('span', { class: 'pn-web-navs' }, backBtn, fwdBtn, reloadBtn), input, openTab), stage, note);

  let dead = false;
  let timer = 0;
  let inflight = false;
  let lastInput = 0;
  let errors = 0;
  let lastData = '';
  let shotW = 0, shotH = 0, shotScale = 1;
  let curUrl = '';
  const qKey = sessId + '#' + tabNo;               // 원격 일의 줄 — 이 탭의 것(QUEUES)
  let queued = 0;                                  // 이 화면이 줄에 세운 원격 동작 수 — 스크린샷은 줄의 마지막 것만 받는다
  let lastShotAt = 0;                              // 마지막으로 그림을 받은 때 — 줄이 길어도 1초마다는 받는다
  let wx = 0, wy = 0, wTimer = 0;                  // 모아 둔 휠(보이는 px)
  let wPoint: { x: number; y: number } | null = null;

  const call = async (op: string, body: Record<string, unknown>): Promise<any> => {
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), CALL_MS);
    try { return await api('/api/ui/browser/' + op, { method: 'POST', headers: { 'x-lively-session': sessId }, body: JSON.stringify({ ...body, tab: tabNo }), signal: ac.signal }); }
    finally { clearTimeout(t); }
  };
  const visible = (): boolean => !dead && root.isConnected && root.getClientRects().length > 0 && document.visibilityState === 'visible';

  function setState(s: State, text = ''): void {
    root.dataset.state = s;
    const say: Record<State, string> = {
      connecting: '데스크톱 앱의 화면을 불러오는 중…',
      live: '',
      empty: '데스크톱 앱에 이 칸의 탭이 아직 없습니다 — 위 주소칸에 주소를 넣으면 데스크톱 앱 이 세션의 [웹]에 열리고 여기에 보입니다.',
      paused: '데스크톱 앱에서 이 탭에 [AI 멈춤]이 켜져 있어 원격 화면도 멈췄습니다 — 데스크톱 앱 그 칸에서 풀어 주세요.',
      stuck: text,
      error: text || '데스크톱 앱 화면을 받지 못했습니다 — 잠시 뒤 다시 시도합니다.',
    };
    msg.textContent = say[s];
    //  빈 탭 · 멈춤은 그림 위에 덮어 알린다. 불러오는 중 · 오류는 받아 둔 그림이 없을 때만 덮는다(있으면 그림을 두고 아래 줄에 적는다).
    msg.hidden = !(s === 'empty' || s === 'paused' || ((s === 'connecting' || s === 'stuck' || s === 'error') && !lastData));
    note.textContent = s === 'stuck' || s === 'error' ? say[s] : NOTE;
  }
  function syncAddr(r: any): void {
    if (dead) return;                              // 닫힌 뒤 늦게 온 응답 — 칸 탭 이름은 이제 다른 화면(세션)의 것이다
    const u = String(r?.url || '');
    if (!u) return;
    curUrl = u;
    if (document.activeElement !== input) input.value = u;
    try { ctx.setTabTitle?.(new URL(u).host.replace(/^www\./, '')); } catch { /* noop */ }
  }
  /** 받은 결과에 그림이 있으면 화면을 갈아 끼운다 — 그대로면 다시 그리지 않는다. 바뀌었는지를 돌려준다. */
  function paint(r: any): boolean {
    if (dead) return false;                        // 닫힌 뒤 늦게 온 응답 — 이 화면은 이미 칸에서 떨어졌다
    syncAddr(r);
    const d = r?.image?.data;
    if (!d) return false;
    lastShotAt = Date.now();
    shotW = Number(r.width) || shotW;
    shotH = Number(r.height) || shotH;
    shotScale = Number(r.scale) || 1;
    const changed = d !== lastData;
    if (changed) { lastData = d; img.src = `data:${r.image.mime || 'image/jpeg'};base64,${d}`; }
    return changed;
  }
  async function onError(e: any): Promise<void> {
    if (dead) return;
    errors++;
    //  409 는 «데스크톱 없음» 만이 아니다 — 세션 주인 불일치도 409(쓰기 도구에만 걸린다), 데스크톱이 몇 초 끊겼다 붙는 것도 있다(격리 리뷰).
    //   그래서 물어 보아 연결돼 있으면 그 문구를 보이고, «없음» 이면 2.5초 뒤 한 번 더 물어 그때도 없을 때만 iframe 칸으로.
    if (e?.status === 409 && !(await desktopConnected(sessId))) {
      await sleep(2_500);
      if (dead) return;
      if (!(await desktopConnected(sessId))) { if (!dead) lost(); return; }
    }
    if (dead) return;
    const m = e?.name === 'AbortError' ? `데스크톱 앱이 ${CALL_MS / 1000}초 동안 답하지 않았습니다 — 잠시 뒤 다시 시도합니다.` : String(e?.message || e || '');
    const kind = hostErrorKind(m);
    if (kind === 'empty') setState('empty');
    else if (kind === 'paused') setState('paused');
    else if (kind === 'stuck') setState('stuck', m);
    else setState('error', m.length > 160 ? m.slice(0, 160) + '…' : m);
  }
  function schedule(ms?: number | null): void {
    clearTimeout(timer);
    const d = ms === undefined ? nextDelay({ visible: visible(), sinceInputMs: Date.now() - lastInput, changed: false, errors, focused: document.hasFocus() }) : ms;
    if (d === null || dead) return;
    timer = window.setTimeout(() => void frameOnce(), d);
  }
  async function frameOnce(): Promise<void> {
    if (inflight || dead) return;
    if (!visible()) return;                        // 다시 보이면 visibilitychange · IntersectionObserver · tick() 이 깨운다
    //  원격 동작이 줄에 있으면 그 결과 그림을 기다린다 — 다만 1초 넘게 그림이 안 왔으면 받는다(줄이 길 때 화면이 멈춘 채
    //   사람이 묵은 그림을 누르지 않게 — 격리 리뷰). 중계는 열쇠마다 24건까지 받는다(동작 하나 + 화면 하나는 넉넉하다).
    if (queued > 0 && Date.now() - lastShotAt < 1_000) { schedule(300); return; }
    inflight = true;
    let changed = false;
    try {
      const r = await call('screenshot', {});
      changed = paint(r);
      errors = 0;
      if (!dead) setState('live');
    } catch (e) { await onError(e); }
    finally { inflight = false; }
    schedule(nextDelay({ visible: visible(), sinceInputMs: Date.now() - lastInput, changed, errors, focused: document.hasFocus() }));
  }
  /** 원격 일 하나를 줄에 세운다 — 차례대로(글 다음 Enter 가 뒤바뀌지 않게). 줄이 비는 순간 그동안 모인 입력을 한 번에 보낸다.
   *  last = 이 일 뒤로 줄도 모인 입력도 없다 — 그 일만 결과 그림을 같이 받고, after ms 뒤 다음 화면을 받는다. */
  function enqueue(run: (last: boolean) => Promise<void>, after: number): void {
    lastInput = Date.now();
    queued++;
    chain(qKey, async () => {
      const last = queued === 1 && !pending.length && !wx && !wy;
      try { await run(last); errors = 0; }
      catch (e) { await onError(e); }
      finally { queued--; }
      if (dead) return;
      if (queued === 0 && (wx || wy)) { flushWheel(); return; }
      if (queued === 0 && pending.length) { pumpInput(); return; }
      schedule(last ? after : undefined);
    });
  }
  function act(body: Record<string, unknown>): void {
    //  닫힌 화면이 남은 입력을 마저 보낼 땐 그림을 안 받는다 — 그릴 칸이 없다.
    enqueue(async (last) => { paint(await call('act', last && !dead ? { ...body, screenshot: true } : body)); if (!dead) setState('live'); }, 150);
  }
  function nav(body: Record<string, unknown>): void {
    flushPending();
    enqueue(async () => { syncAddr(await call('navigate', body)); }, 0);
  }
  /** 아직 안 보낸 휠 · 누르기 · 글을 지금 줄에 세운다 — 그 뒤에 와야 하는 일(이동 · 복사 · 닫기)이 있을 때.
   *  셋 중 하나만 모여 있을 수 있다(휠은 누르기 · 글을, 누르기와 글은 휠 · 서로를 먼저 내보내고 모인다). */
  function flushPending(): void { flushWheel(); flushClick(); flushInput(); }

  // ── 누르기(두 번 누름 가르기) ────────────────────────────────────────────
  let clickTimer = 0;
  let pendingClick: { x: number; y: number } | null = null;
  function flushClick(): void {
    clearTimeout(clickTimer);
    if (!pendingClick) return;
    const p = pendingClick;
    pendingClick = null;
    act({ action: 'click', x: p.x, y: p.y });
  }

  // ── 글 · 키 — 모아서 차례대로(같은 종류는 합친다: remote-web-kit pushInput) ──────────
  //  원격 동작 한 번이 0.5~1초라 칠 때마다 줄에 세우면 다 친 뒤에도 몇십 초 더 쳐졌다(격리 리뷰 실측). 그래서 줄에 일이 있는
  //  동안은 모아 두기만 하고(같은 종류는 하나로 합쳐진다), 줄이 비는 순간 모인 것을 한 번에 보낸다(enqueue → pumpInput).
  let pending: InputItem[] = [];
  let inputTimer = 0;
  /** 모인 입력을 지금 줄에 세운다 — 누르기 · 이동 · 복사 · 닫기처럼 그 뒤에 와야 하는 일이 있을 때. */
  function flushInput(): void {
    clearTimeout(inputTimer); inputTimer = 0;
    const items = pending;
    pending = [];
    for (const it of items) act(it.kind === 'text' ? { action: 'type', text: it.text } : { action: 'key', keys: it.keys.join(' ') });
  }
  /** 줄이 비어 있을 때만 보낸다 — 아니면 줄의 마지막 일이 끝날 때 enqueue 가 다시 부른다. */
  function pumpInput(): void { if (queued === 0) flushInput(); }
  function queueInput(it: InputItem): void {
    if (it.kind === 'text' && !it.text) return;
    flushWheel();                                   // 굴린 다음 친 글이 굴리기보다 먼저 가지 않게
    flushClick();                                   // 누른 다음 친 글이 누르기보다 먼저 가지 않게
    pending = pushInput(pending, it);
    if (!inputTimer) inputTimer = window.setTimeout(() => { inputTimer = 0; pumpInput(); }, 60);
  }
  /** 아직 안 보낸 키 수 — 꾹 누른 반복을 어디서 끊을지. */
  const pendingKeys = (): number => pending.reduce((n, it) => n + (it.kind === 'key' ? it.keys.length : 0), 0);
  sink.addEventListener('keydown', (e: KeyboardEvent) => {
    const a = remoteKeyAction({ key: e.key, keyCode: e.keyCode, isComposing: e.isComposing, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: e.getModifierState?.('AltGraph') }, MAC);
    if (!a || a.kind === 'text' || a.kind === 'skip') return;     // 글은 input/composition 사건이 보낸다
    e.preventDefault();
    if (a.kind === 'key') {
      //  꾹 누른 반복은 밀린 키가 30개면 버린다 — 화면이 늦게 따라오는 만큼, 놓은 뒤에도 한참 더 지워지지 않게.
      if (e.repeat && pendingKeys() >= 30) return;
      queueInput({ kind: 'key', keys: [a.keys] });
      return;
    }
    if (a.kind === 'reload') { nav({ action: 'reload' }); return; }
    copySelection();
  });
  sink.addEventListener('input', (e: Event) => {
    if ((e as InputEvent).isComposing) return;
    const v = sink.value;
    sink.value = '';
    queueInput({ kind: 'text', text: v });
  });
  //  조합 끝 — 사건이 실어 온 글(e.data)이 아니라 **입력칸에 남은 글**을 보낸다. 사파리는 조합이 끝날 때 «조합 아님» 으로 표시된
  //   input 을 compositionend 보다 먼저 내기도 한다 — 그 input 이 이미 보내고 비웠으면 여기서 또 보내지 않는다(같은 글 두 번 방지).
  sink.addEventListener('compositionend', () => {
    const v = sink.value;
    sink.value = '';
    queueInput({ kind: 'text', text: v });
  });
  sink.addEventListener('paste', (e: ClipboardEvent) => {
    e.preventDefault();
    const t = e.clipboardData?.getData('text/plain') || '';
    if (t) { queueInput({ kind: 'text', text: t }); flushInput(); }
  });
  /** 원격에서 고른 글을 이 브라우저 클립보드로. 사파리는 왕복 뒤의 writeText 를 제스처 밖이라 거절한다 — ClipboardItem 에
   *  «곧 올 글»(Promise)을 넘겨 키 사건 안에서 시작한다. 고른 글이 없으면 조용히, 막히면 알린다. */
  function copySelection(): void {
    //  https 가 아닌 주소(셀프호스트 http)엔 클립보드 API 자체가 없다 — 원격 글을 읽으러 가지도 않고 알린다(격리 리뷰: 예전엔 조용히 던졌다).
    if (!navigator.clipboard) { toast('복사하지 못했습니다 — 이 주소(https 아님)에선 브라우저가 클립보드를 열어 주지 않아요.', true); return; }
    flushPending();                                 // 고르는 두 번 누름 · 친 글이 먼저 가야 그 고른 글을 읽는다
    let got: (t: string) => void = () => { /* 아래 Promise 가 채운다 */ };
    const text = new Promise<string>((res) => { got = res; });
    //  줄에 세우되 enqueue 는 안 쓴다 — 이 읽기는 화면을 바꾸지 않아 결과 그림 · 다음 받기 간격을 건드릴 일이 없다.
    chain(qKey, async () => {
      try { const r: any = await call('eval', { code: 'String(getSelection ? getSelection() : "")' }); got(String(r?.value ?? '')); }
      catch { got(''); }
    });
    const ok = (): void => { toast('원격 화면에서 고른 글을 복사했어요'); };
    const blocked = (): void => { toast('복사하지 못했습니다 — 브라우저가 클립보드 쓰기를 막았어요.', true); };
    const viaWriteText = (): void => { void text.then((t) => (t ? navigator.clipboard.writeText(t).then(ok) : undefined)).catch(blocked); };
    const CI = (window as any).ClipboardItem;
    if (!CI || !navigator.clipboard?.write) { viaWriteText(); return; }
    let empty = false;                              // 고른 글이 없었다 — 막힌 게 아니니 알리지 않는다
    const blob = text.then((t) => { if (!t) { empty = true; throw new Error('empty'); } return new Blob([t], { type: 'text/plain' }); });
    blob.catch(() => { /* 위 empty 가 말한다 */ });
    try { navigator.clipboard.write([new CI({ 'text/plain': blob })]).then(ok, () => { if (!empty) blocked(); }); }
    catch { viaWriteText(); }                       // Promise 를 담는 ClipboardItem 을 못 만드는 브라우저
  }

  // ── 누르기 · 휠 ──────────────────────────────────────────────────────────
  const pointOf = (e: MouseEvent): { x: number; y: number } | null => {
    const r = img.getBoundingClientRect();
    return toShotPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height, shotW, shotH);
  };
  img.addEventListener('click', (e: MouseEvent) => {
    const p = pointOf(e);
    sink.focus({ preventScroll: true });
    if (!p || e.detail >= 3) return;               // 세 번째 누름 — 두 번 누름을 이미 보냈다
    flushWheel(); flushInput();                     // 굴리고 · 친 다음 누른 것이 앞지르지 않게
    if (e.detail === 2) { clearTimeout(clickTimer); pendingClick = null; act({ action: 'double_click', x: p.x, y: p.y }); return; }
    flushClick();
    pendingClick = p;
    clickTimer = window.setTimeout(flushClick, DBL_MS);
  });
  img.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const p = pointOf(e);
    if (!p) return;
    flushPending();
    act({ action: 'right_click', x: p.x, y: p.y });
  });
  //  휠 — 그림이 무대에 통째로 맞춰 들어가 무대 자체는 구르지 않는다(CSS) → 휠은 전부 원격으로. 모아 두었다가 줄이 비었을 때
  //   한 번에 보낸다(입력과 같은 규칙). 120ms 마다 흘려 보내면 줄에 스크롤이 쌓여 다 굴린 뒤에도 몇 초 더 굴러갔고(격리 리뷰 실측:
  //   트랙패드 2초 → act 16개 · 7.7초 더), 그동안 보이는 그림을 누르면 이미 굴러간 페이지의 다른 곳이 눌렸다.
  /** 모아 둔 휠을 지금 줄에 세운다(합계는 wheelToScroll 이 상한 20,000 으로 자른다). */
  function flushWheel(): void {
    clearTimeout(wTimer); wTimer = 0;
    if (!wx && !wy) return;
    const s = wheelToScroll(wx, wy, img.getBoundingClientRect().width, shotW, shotScale);
    wx = 0; wy = 0;
    if (s) act({ action: 'scroll', direction: s.direction, amount: s.amount, ...(wPoint ? { x: wPoint.x, y: wPoint.y } : {}) });
  }
  /** 줄이 비어 있을 때만 보낸다 — 아니면 줄의 마지막 일이 끝날 때 enqueue 가 다시 부른다. */
  function pumpWheel(): void { wTimer = 0; if (queued === 0) flushWheel(); }
  stage.addEventListener('wheel', (e: WheelEvent) => {
    if (!shotW) return;
    e.preventDefault();
    flushClick(); flushInput();                     // 누르고 · 친 다음 굴린 것 — 그것들이 먼저
    const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (img.clientHeight || 600) : 1;
    wx += e.deltaX * f; wy += e.deltaY * f;
    wPoint = pointOf(e);
    if (!wTimer) wTimer = window.setTimeout(pumpWheel, 120);
  }, { passive: false });

  // ── 주소줄 · 밖에서 여는 주소(미리보기 행 · 터미널 링크) ─────────────────────
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
    e.preventDefault();
    const u = normWebUrl(input.value);
    if (!u) return;
    input.blur();
    nav({ url: u });
  });
  openTab.onclick = (e: Event) => {
    const u = curUrl || normWebUrl(input.value);
    if (!u || !/^https?:\/\//i.test(u)) { e.preventDefault(); return; }   // 원격 페이지가 정하는 주소 — http(s) 만 내보낸다
    openTab.href = u;
  };
  const evtHost = ctx.paneRoot();
  const onOpen = (e: Event): void => { const u = normWebUrl(String((e as CustomEvent).detail?.url || '')); if (u) nav({ url: u }); };
  evtHost.addEventListener(WEB_OPEN_EVT, onOpen);

  // ── ⌘R 은 이 칸만 — iframe 칸 · 데스크톱 칸과 같은 «마지막으로 만진 칸» 규칙(panes-parts) ──────────────
  //  입력칸(sink)에 초점이 있으면 그쪽 keydown 이 이미 처리한다. 칸 탭을 눌러 고른 뒤의 ⌘R 도 원격 새로고침이어야
  //  라이블리 전체가 다시 실리지 않는다. ⇧⌘R 은 전체를 다시 싣는 탈출구로 남긴다.
  let mine = false;
  const paneOf = (): HTMLElement => (root.closest('.pn-pane') as HTMLElement | null) || root;
  const mark = (e: Event): void => { const t = e.target; mine = t instanceof Node && paneOf().contains(t); };
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (String(e.key).toLowerCase() !== 'r' && e.code !== 'KeyR') return;
    if (e.target === sink || !mine || !visible()) return;
    e.preventDefault();
    nav({ action: 'reload' });
  };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('focusin', mark, true);
  window.addEventListener('keydown', onKey, true);

  //  다시 보이면 곧바로 — 셸의 tick 은 8초 간격이라 그동안 묵은 그림 위에서 누르게 된다(격리 리뷰 실측).
  const onVis = (): void => { if (visible() && !inflight) schedule(0); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', onVis);          // 창에 초점이 없을 땐 5초 간격 — 돌아오면 기다리지 않는다
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(onVis) : null;
  io?.observe(root);

  return {
    root,
    start: () => { setState('connecting'); schedule(0); },
    tick: () => { if (visible() && !inflight) schedule(0); },
    destroy: () => {
      //  남은 입력은 이 화면의 (세션, 탭)으로 마저 보낸다 — 사람이 거기서 친 · 누른 것이다(머리말 ★).
      flushPending();
      dead = true;
      //  닫힌 화면엔 타이머가 남지 않는다 — 남은 입력은 위에서 이미 줄에 세웠다(타이머에 기대면 정리 한 줄에 입력이 사라진다).
      clearTimeout(timer); clearTimeout(clickTimer); clearTimeout(inputTimer);
      evtHost.removeEventListener(WEB_OPEN_EVT, onOpen);
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('focusin', mark, true);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
      io?.disconnect();
    },
  };
}

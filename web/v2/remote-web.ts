// v2/remote-web.ts — 웹 판(브라우저에서 연 라이블리)의 세션 [웹] 칸: 그 사람 데스크톱 앱 탭의 **원격 화면** (#4993 (A)).
//
//  브라우저는 남의 사이트를 칸 안에 못 띄운다(X-Frame-Options · frame-ancestors — browser-surface 머리말). 그래서 그 사람의
//  데스크톱 앱이 연결돼 있으면, 앱 안 **같은 세션 · 같은 칸**의 탭을 원격으로 쓴다: 화면은 그 탭의 스크린샷을 받아 그리고,
//  클릭 · 휠 · 글 · 키는 그 탭으로 보낸다. 길은 AI 가 쓰는 브라우저 툴 그대로(/api/ui/browser/* + x-lively-session) —
//  서버에 새 길이 없다. 데스크톱이 없으면 종전 iframe 칸을 그대로 쓰고, 데스크톱이 켜지면 원격 화면으로 바꾼다.
//  판정(키 · 좌표 · 휠 · 받기 간격)은 remote-web-kit.ts(시험 표), 여기는 그 배선이다.
//  ⚠ 글은 숨긴 입력칸(sink)으로 받는다 — 칸(div)은 편집할 수 없어 한글 조합(IME)이 아예 안 일어난다. 조합이 끝난 글 ·
//   붙여넣기 · 보통 글자는 그 입력칸의 input/composition/paste 사건으로 모아 보내고, 특수 키만 keydown 에서 보낸다.
import { api, el, toast } from '../core.js';
import { pnIcon } from './panes-kit.js';
import { sessionOfKey, tabNoOfKey } from './browser-tabs.js';
import { normWebUrl } from './web-url.js';
import { nextDelay, remoteKeyAction, toShotPoint, wheelToScroll } from './remote-web-kit.js';
import type { Part, PartCtx } from './panes-parts.js';

const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
/** 데스크톱이 없을 때 다시 물어보는 간격 — 사람이 앱을 켜면 이만큼 안에 원격 화면으로 바뀐다. */
const REPROBE_MS = 30_000;

type State = 'connecting' | 'live' | 'empty' | 'paused' | 'stuck' | 'error';

/**
 * 웹 칸 — 데스크톱이 연결돼 있으면 원격 화면, 아니면 frame()(종전 iframe 칸). 세션이 없는 자리(새 세션 자리)는 늘 frame().
 */
export function remoteWebPart(ctx: PartCtx, frame: () => Part): Part {
  const root = el('div', { class: 'pn-part pn-web pn-web-remote-host' });
  let inner: Part | null = null;          // frame 모드의 iframe 칸
  let remote: Remote | null = null;       // 원격 모드
  let dead = false;
  let probeTimer = 0;

  const sess = (): string | null => {
    const s = ctx.curSession();
    return s ? sessionOfKey(ctx.slotKey()) : null;
  };
  const status = async (): Promise<boolean> => {
    const s = sess();
    if (!s) return false;
    try {
      const r: any = await api('/api/ui/browser/status', { method: 'POST', headers: { 'x-lively-session': s }, body: '{}' });
      return !!(r && r.connected);
    } catch { return false; }
  };
  const useFrame = (): void => {
    if (dead) return;
    remote?.destroy(); remote = null;
    if (!inner) {
      inner = frame();
      const hint = el('p', { class: 'pn-web-note pn-fine pn-remote-hint', text: '데스크톱 앱이 켜져 있으면 이 칸이 그 앱 브라우저의 원격 화면으로 바뀝니다 — 사이트가 막지 않고, 로그인도 그 앱 것을 씁니다.' });
      root.replaceChildren(inner.root, hint);
    }
    clearTimeout(probeTimer);
    probeTimer = window.setTimeout(() => void probe(), REPROBE_MS);
  };
  const useRemote = (): void => {
    if (dead || remote) return;
    clearTimeout(probeTimer);
    inner?.destroy?.(); inner = null;
    remote = makeRemote(ctx, () => { remote?.destroy(); remote = null; useFrame(); });
    root.replaceChildren(remote.root);
    remote.start();
  };
  async function probe(): Promise<void> {
    if (dead) return;
    if (await status()) useRemote(); else useFrame();
  }
  //  처음 그릴 때 빈 자리 대신 «확인 중» — 곧 원격 화면이나 iframe 칸으로 바뀐다.
  root.append(el('p', { class: 'pn-web-note pn-fine', text: '데스크톱 앱 연결을 확인하는 중…' }));
  void probe();
  const offSess = ctx.onSession(() => {
    if (!sess()) { useFrame(); return; }
    if (remote) remote.reset(); else void probe();
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

interface Remote { root: HTMLElement; start(): void; tick(): void; reset(): void; destroy(): void }

function makeRemote(ctx: PartCtx, lost: () => void): Remote {
  const root = el('div', { class: 'pn-part pn-web pn-web-remote' });
  const input = el('input', { class: 'pn-web-in', type: 'text', placeholder: '주소 또는 검색어 — 데스크톱 앱의 탭에서 열립니다', 'aria-label': '주소' }) as HTMLInputElement;
  input.onfocus = () => input.select();
  const openTab = el('a', { class: 'pn-web-btn ic', target: '_blank', rel: 'noopener', title: '지금 주소를 이 브라우저의 새 탭에서 엽니다.', 'aria-label': '새 탭에서 열기', href: '#' }, pnIcon('ext', 'pn-i sm')) as HTMLAnchorElement;
  const btn = (label: string, title: string, icon: string, fn: () => void): HTMLButtonElement =>
    el('button', { class: 'pn-web-btn ic', type: 'button', 'aria-label': label, title, onclick: fn }, pnIcon(icon, 'pn-i sm')) as HTMLButtonElement;
  const backBtn = btn('뒤로', '데스크톱 앱 탭에서 앞 화면으로 돌아갑니다.', 'chev', () => nav({ action: 'back' }));
  backBtn.classList.add('back');
  const fwdBtn = btn('앞으로', '데스크톱 앱 탭에서 뒤로 오기 전 화면으로 갑니다.', 'chev', () => nav({ action: 'forward' }));
  const reloadBtn = btn('다시 불러오기', '데스크톱 앱 탭을 다시 불러옵니다.', 'undo', () => nav({ action: 'reload' }));
  const img = el('img', { class: 'pn-remote-img', alt: '데스크톱 앱 브라우저 화면', draggable: 'false' }) as HTMLImageElement;
  //  글을 받는 숨긴 입력칸 — 화면을 누르면 여기로 초점이 온다(머리말 ⚠).
  const sink = el('textarea', { class: 'pn-remote-sink', 'aria-label': '원격 화면 입력', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  const msg = el('div', { class: 'pn-remote-msg' });
  const stage = el('div', { class: 'pn-webstage pn-remote-stage' }, img, sink, msg);
  const note = el('p', { class: 'pn-web-note pn-fine pn-remote-note', text: '데스크톱 앱 브라우저의 원격 화면입니다 — 누르고 쓰는 것이 그 앱의 같은 탭으로 갑니다.' });
  root.append(el('div', { class: 'pn-web-bar' }, el('span', { class: 'pn-web-navs' }, backBtn, fwdBtn, reloadBtn), input, openTab), stage, note);

  let dead = false;
  let timer = 0;
  let inflight = false;
  let lastInput = 0;
  let errors = 0;
  let lastData = '';
  let shotW = 0, shotH = 0, shotScale = 1;
  let curUrl = '';
  let queue: Promise<void> = Promise.resolve();

  const key = (): string => ctx.slotKey();
  const call = (op: string, body: Record<string, unknown>): Promise<any> =>
    api('/api/ui/browser/' + op, {
      method: 'POST',
      headers: { 'x-lively-session': sessionOfKey(key()) },
      body: JSON.stringify(op === 'status' ? body : { ...body, tab: tabNoOfKey(key()) }),
    });
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
    if (s === 'stuck' || s === 'error') note.textContent = say[s];
    else note.textContent = '데스크톱 앱 브라우저의 원격 화면입니다 — 누르고 쓰는 것이 그 앱의 같은 탭으로 갑니다.';
  }
  function syncAddr(r: any): void {
    const u = String(r?.url || '');
    if (u) {
      curUrl = u;
      if (document.activeElement !== input) input.value = u;
      try { ctx.setTabTitle?.(new URL(u).host.replace(/^www\./, '')); } catch { /* noop */ }
    }
  }
  /** 받은 결과에 그림이 있으면 화면을 갈아 끼운다 — 그대로면 다시 그리지 않는다. 바뀌었는지를 돌려준다. */
  function paint(r: any): boolean {
    syncAddr(r);
    const d = r?.image?.data;
    if (!d) return false;
    shotW = Number(r.width) || shotW;
    shotH = Number(r.height) || shotH;
    shotScale = Number(r.scale) || 1;
    const changed = d !== lastData;
    if (changed) { lastData = d; img.src = `data:${r.image.mime || 'image/jpeg'};base64,${d}`; }
    return changed;
  }
  function onError(e: any): void {
    errors++;
    const m = String(e?.message || e || '');
    if (e?.status === 409) { lost(); return; }                                       // 데스크톱이 끊겼다 → iframe 칸으로
    if (/열린 브라우저 탭이 없습니다|이 없습니다 — browser_tabs/.test(m)) { setState('empty'); return; }
    if (/AI 조작을 멈춰/.test(m)) { setState('paused'); return; }
    if (/화면을 찍지 못했습니다/.test(m)) { setState('stuck', m); return; }
    setState('error', m.length > 160 ? m.slice(0, 160) + '…' : m);
  }
  function schedule(ms?: number | null): void {
    clearTimeout(timer);
    const d = ms === undefined ? nextDelay({ visible: visible(), sinceInputMs: Date.now() - lastInput, changed: false, errors }) : ms;
    if (d === null || dead) return;
    timer = window.setTimeout(() => void frameOnce(), d);
  }
  async function frameOnce(): Promise<void> {
    if (inflight || dead) return;
    if (!visible()) return;                                       // 다시 보이면 tick() 이 깨운다
    inflight = true;
    let changed = false;
    try {
      const r = await call('screenshot', {});
      changed = paint(r);
      errors = 0;
      setState('live');
    } catch (e) { onError(e); }
    finally { inflight = false; }
    schedule(nextDelay({ visible: visible(), sinceInputMs: Date.now() - lastInput, changed, errors }));
  }
  /** 원격 동작 하나 — 차례대로(글 다음 Enter 가 뒤바뀌지 않게). 결과에 그림을 같이 받아 바로 그린다. */
  function act(body: Record<string, unknown>): void {
    lastInput = Date.now();
    queue = queue.then(async () => {
      try { paint(await call('act', { ...body, screenshot: true })); errors = 0; setState('live'); }
      catch (e) { onError(e); }
      schedule(150);
    });
  }
  function nav(body: Record<string, unknown>): void {
    flushText();
    lastInput = Date.now();
    queue = queue.then(async () => {
      try { syncAddr(await call('navigate', body)); errors = 0; } catch (e) { onError(e); }
      schedule(0);
    });
  }

  // ── 글 · 키 ──────────────────────────────────────────────────────────────
  let pending = '';
  let textTimer = 0;
  function flushText(): void {
    clearTimeout(textTimer);
    if (!pending) return;
    const text = pending;
    pending = '';
    act({ action: 'type', text });
  }
  const queueText = (s: string): void => {
    if (!s) return;
    pending += s;
    clearTimeout(textTimer);
    textTimer = window.setTimeout(flushText, 60);
  };
  sink.addEventListener('keydown', (e: KeyboardEvent) => {
    const a = remoteKeyAction(e, MAC);
    if (!a || a.kind === 'text' || a.kind === 'skip') return;     // 글은 input/composition 사건이 보낸다
    e.preventDefault();
    if (a.kind === 'key') { flushText(); act({ action: 'key', keys: a.keys }); return; }
    if (a.kind === 'reload') { nav({ action: 'reload' }); return; }
    if (a.kind === 'copy') {
      void call('eval', { code: 'String(getSelection ? getSelection() : "")' }).then((r: any) => {
        const t = String(r?.value ?? '');
        if (!t) return;
        return navigator.clipboard?.writeText(t).then(() => toast('원격 화면에서 고른 글을 복사했어요'));
      }).catch(() => { /* 고른 글 없음 · 권한 없음 — 조용히 */ });
    }
  });
  sink.addEventListener('input', (e: Event) => {
    if ((e as InputEvent).isComposing) return;
    const v = sink.value;
    sink.value = '';
    queueText(v);
  });
  //  조합 끝 — 사건이 실어 온 글(e.data)이 아니라 **입력칸에 남은 글**을 보낸다. 사파리는 조합이 끝날 때 «조합 아님» 으로 표시된
  //   input 을 compositionend 보다 먼저 내기도 한다 — 그 input 이 이미 보내고 비웠으면 여기서 또 보내지 않는다(같은 글 두 번 방지).
  sink.addEventListener('compositionend', () => {
    const v = sink.value;
    sink.value = '';
    queueText(v);
  });
  sink.addEventListener('paste', (e: ClipboardEvent) => {
    e.preventDefault();
    flushText();
    const t = e.clipboardData?.getData('text/plain') || '';
    if (t) { pending = t; flushText(); }
  });

  // ── 누르기 · 휠 ──────────────────────────────────────────────────────────
  const pointOf = (e: MouseEvent): { x: number; y: number } | null => {
    const r = img.getBoundingClientRect();
    return toShotPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height, shotW, shotH);
  };
  let clickTimer = 0;
  img.addEventListener('click', (e: MouseEvent) => {
    const p = pointOf(e);
    sink.focus({ preventScroll: true });
    if (!p) return;
    flushText();
    //  두 번 누름은 click 두 번 뒤에 온다 — 첫 click 을 잠깐 미뤄 두 번이면 double_click 하나만 보낸다.
    clearTimeout(clickTimer);
    if (e.detail >= 2) { clickTimer = 0; act({ action: 'double_click', x: p.x, y: p.y }); return; }
    clickTimer = window.setTimeout(() => { clickTimer = 0; act({ action: 'click', x: p.x, y: p.y }); }, 220);
  });
  img.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    const p = pointOf(e);
    if (p) act({ action: 'right_click', x: p.x, y: p.y });
  });
  let wx = 0, wy = 0, wTimer = 0;
  let wPoint: { x: number; y: number } | null = null;
  stage.addEventListener('wheel', (e: WheelEvent) => {
    if (!shotW) return;
    e.preventDefault();
    const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (img.clientHeight || 600) : 1;
    wx += e.deltaX * f; wy += e.deltaY * f;
    wPoint = pointOf(e);
    clearTimeout(wTimer);
    wTimer = window.setTimeout(() => {
      const s = wheelToScroll(wx, wy, img.getBoundingClientRect().width, shotW, shotScale);
      wx = 0; wy = 0;
      if (s) act({ action: 'scroll', direction: s.direction, amount: s.amount, ...(wPoint ? { x: wPoint.x, y: wPoint.y } : {}) });
    }, 120);
  }, { passive: false });

  // ── 주소줄 ───────────────────────────────────────────────────────────────
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    const u = normWebUrl(input.value);
    if (!u) return;
    input.blur();
    nav({ url: u });
  });
  openTab.onclick = (e: Event) => { const u = curUrl || normWebUrl(input.value); if (!u) { e.preventDefault(); return; } openTab.href = u; };

  return {
    root,
    start: () => { setState('connecting'); schedule(0); },
    tick: () => { if (visible() && !inflight) schedule(0); },
    reset: () => { lastData = ''; shotW = 0; shotH = 0; curUrl = ''; input.value = ''; img.removeAttribute('src'); setState('connecting'); schedule(0); },
    destroy: () => {
      dead = true;
      clearTimeout(timer); clearTimeout(textTimer); clearTimeout(clickTimer); clearTimeout(wTimer);
    },
  };
}

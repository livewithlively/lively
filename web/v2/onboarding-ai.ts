// v2/onboarding-ai.ts — 처음 설정 «AI 연결» 장면의 목록 (#4970 PR4 · 상민님 2026-10-23 «AI 연결 유도를 앱 연결 전에»).
//
//  화면 틀(머리말·[다음]·«PC에서 쓰는 AI로»)은 onboarding.ts 가 그리고, 여기는 **줄과 로그인 칸**만 다룬다.
//  · 목록은 서버가 정한다(/api/ui/me/ai-accounts: 로그인 여부 + 이 서버에서 띄울 수 있나 installed). installed 가 false 인 AI 는 안 보인다.
//  · 줄은 한 번 만들고 **그 자리에서** 고친다 — 다시 읽을 때마다 줄을 갈아 끼우면 로그인 칸이 옮겨지면서 터미널 액자(제미나이)가 새로 뜨고,
//    읽기가 한 번 실패하면 받은 주소·치던 코드까지 지워진다(격리 리뷰 2026-10-23 실측). 칸은 처음 붙인 줄에 그대로 둔다.
//  · 제미나이(프로브 하네스)는 목록이 «모름» 으로 준다 — 확인은 4초쯤 걸리고 매니지드에선 자리를 띄우므로, **사람이 그 줄의 로그인을 연
//    뒤에만** 묻고, 묻는 동안에도 나머지 줄은 먼저 그린다. 마지막으로 잰 답은 기억해 목록의 «모름» 으로 되돌리지 않는다.
import { api } from '../core.js';
import { aiLoginPanel, confirmSharedLogin, type AiLoginAccount, type AiLoginPanel } from '../ai-login-panel.js';
import { AI_BRAND, AI_LOGO, AI_ORDER } from '../lib/ai-logos.js';
import { HEADLESS_INLINE } from '../lib/ai-login-inline.js';
import { headlessParts } from '../me-ai.js';

/** /api/ui/me/ai-accounts 의 한 줄 — 이 장면이 읽는 칸만. */
export interface AiAccountRow extends AiLoginAccount {
  loggedIn: boolean | null;
  /** 무엇으로 쟀나 — probe 면 목록이 로그인을 재지 않았다(모름으로 온다). */
  how?: string;
  /** 이 서버에서 띄울 수 있나. 없으면(옛 서버) 모름 — 보인다. */
  installed?: boolean | null;
  /** (#5031) 이 사람의 서버 개인 계정이 아직 없다 — [연결]이 계정부터 만든다. 없으면(옛 서버 · 계정 있음) 곧바로 로그인 칸. */
  pending?: boolean;
}

export interface AiListHooks {
  /** 목록을 (다시) 그렸다 — 다 된 AI 가 하나라도 있나(로그인 + 필요하면 자동 정리 승인까지, #5167 aiStepReady). */
  onRows(ready: boolean): void;
  /** 이 서버에서 띄울 AI 가 하나도 없다. */
  onEmpty(): void;
  /** 화면이 아직 살아 있나(떠난 뒤의 늦은 답은 칠하지 않는다). */
  alive(): boolean;
  esc(s: unknown): string;
  noneText: string;
}

interface Item {
  a: AiAccountRow; wrap: HTMLElement; card: HTMLElement; act: HTMLElement; panel: AiLoginPanel | null;
  /** (#5167) 자동 정리 승인 칸 — 로그인을 마친 줄 아래. 승인을 시작했으면(hlBusy) 다시 그리지 않는다(주소·코드를 지우지 않게). */
  hl: HTMLElement | null; hlBusy: boolean;
}

/** /api/ui/me/headless 의 한 줄 — 이 장면이 읽는 칸만(나머지는 headlessParts 가 읽는다). */
export interface HeadlessRow { key: string; label: string; connected: boolean; failure?: unknown; [k: string]: unknown }
/** (#5167) 자동 정리 자격 현황 — needed 는 이 서버의 정리가 따로 받은 자격으로만 도는가(매니지드), ok 는 지금 쓸 수 있는 자격이 있는 AI. */
export interface HeadlessState { needed: boolean; rows: Map<string, HeadlessRow>; ok: Set<string> }

/**
 * (순수, #5167) [다음]을 켤 수 있나 — 로그인을 마친 AI 가 하나라도 «다 된» 것.
 *  · 화면에서 자동 정리 자격을 받을 수 있는 AI(클로드·코덱스)는, 이 서버가 그 자격을 따로 요구하면(needed) 그것까지 받아야 «다 됐다».
 *    로그인만 하고 넘어가면 리브는 규칙을 세우는데 정리 잡이 자격 없음으로 멈춰, 올린 파일이 지식이 되지 않는다(2026-10-30 실측 두 계정).
 *  · 그 밖의 AI(제미나이 등)는 여기서 받을 길이 없다 — 막지 않는다(막아도 해 줄 수 있는 게 없다).
 *  · 현황을 아직 모르면(hl null) 클로드·코덱스 줄은 «아직» 이다 — 묻기가 실패하면 부르는 쪽이 needed:false 로 채워 막지 않는다.
 */
export function aiStepReady(rows: ReadonlyArray<{ key: string; loggedIn: boolean | null }>, hl: HeadlessState | null): boolean {
  return rows.some((a) => a.loggedIn === true
    && (HEADLESS_INLINE[a.key] !== true || (!!hl && (!hl.needed || hl.ok.has(a.key)))));
}

/** (순수) 목록 응답 → 보일 줄. 순서는 [AI 계정 연결] 표와 같고, 설치가 확인된 «없음» 만 뺀다. */
export function visibleAiRows(accounts: readonly AiAccountRow[]): AiAccountRow[] {
  const byKey = new Map(accounts.map((a) => [a.key, a]));
  return AI_ORDER.map((k) => byKey.get(k)).filter((a): a is AiAccountRow => !!a && a.installed !== false);
}

export function mountAiList(list: HTMLElement, hooks: AiListHooks): { reload(): Promise<void> } {
  const { esc } = hooks;
  const items = new Map<string, Item>();
  /** 사람이 로그인 칸을 연 프로브 하네스 — 이것만 그 자리에서 묻는다. */
  const asked = new Set<string>();
  /** 프로브로 마지막에 잰 답 — 목록은 늘 «모름» 으로 주므로 이걸로 덮는다. */
  const probed = new Map<string, boolean>();
  const note = document.createElement('p');
  note.className = 'ob-q-help ob-ai-note';
  //  계정 만들기 안내·실패가 여기 뜬다 — 누른 [연결]이 막히면서 포커스가 사라지니 화면낭독기가 읽게 한다(#5031 격리 리뷰).
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.hidden = true;

  const actHtml = (a: AiAccountRow): string => a.loggedIn === true
    ? '<span class="ob-ai-ok">✓ 연결됨</span>'
    : '<button type="button" class="ob-btn ob-btn-pri ob-btn-inline ob-ai-go">연결</button>';

  const wireGo = (it: Item): void => {
    const go = it.act.querySelector<HTMLButtonElement>('.ob-ai-go');
    if (!go) return;
    if (it.panel) { go.hidden = true; return; }   // 로그인 중 — 다시 시도는 칸 안의 [다시 시도]가 한다
    go.disabled = !!seating;
    go.onclick = () => { if (it.a.pending) seatThenOpen(it.a.key); else openLogin(it); };
  };
  /** 그 줄의 로그인 칸을 연다. */
  const openLogin = (it: Item): void => {
    const go = it.act.querySelector<HTMLButtonElement>('.ob-ai-go');
    if (it.panel || !go) return;
    if (!confirmSharedLogin(it.a)) return;
    asked.add(it.a.key);
    it.panel = aiLoginPanel(it.a, () => { asked.add(it.a.key); return reload(); });
    it.wrap.append(it.panel.panel);   // 칸은 이 줄에 한 번 붙이고 다시 옮기지 않는다(액자가 새로 뜨지 않게)
    go.hidden = true;
    it.panel.run(true);   // 사람이 눌렀다 = 지금 새로(지난 시도의 코드는 이미 죽었다 — #2232)
  };

  //  (#5031) 계정이 없는 줄의 [연결] — 서버 개인 계정을 만들고(그동안 안내 · 다른 [연결]은 막는다) 다 되면 목록을 다시 읽어 **누른 그 AI** 의
  //   로그인을 이어서 연다. 계정은 여기서만 만든다(사람이 서버 AI 를 고른 순간) — «PC에서 쓰는 AI로» 를 고를 사람은 아무것도 치르지 않는다.
  //   만들기는 20초 남짓이라 로그인 시작 요청 하나에 기다리게 두면 서버 상한(25초)에 걸려 «다시 눌러 주세요» 가 되기 쉽다 — 그래서 여기서 묻고 기다린다.
  const PREP_POLL_MS = 4000;
  let seating: Promise<void> | null = null;
  const setGoDisabled = (off: boolean): void => {
    for (const it of items.values()) { const go = it.act.querySelector<HTMLButtonElement>('.ob-ai-go'); if (go) go.disabled = off; }
  };
  //  못 시작한 채 기다리지 않는다(격리 리뷰 — 첫 요청이 502 한 번이면 묻기만 되풀이하며 «만들고 있어요» 에 갇혔다): 서버가 «만드는 중» 이라고
  //   답할 때까지는 시작 요청을 다시 보내고, 그래도 연속 SEAT_MISS_MAX 번 못 시작하면(끊김 · absent) 실패처럼 «다시 해 보기» 를 보인다.
  //   첫 요청은 retry — 사람이 직접 누른 것이라 방금 실패 뒤의 5분 막음도 푼다(로그인 시작 awaitMemberSeat 와 같은 정책).
  const SEAT_MISS_MAX = 5;
  const seatFail = (key: string, msg: string): void => {
    note.innerHTML = `${msg} 관리자에게 알려 주세요 — 그동안은 아래 «PC에서 쓰는 AI로» 를 쓰실 수 있어요. <button type="button" class="ob-linkbtn ob-ai-seat-retry">다시 해 보기</button>`;
    const again = note.querySelector<HTMLButtonElement>('.ob-ai-seat-retry')!;
    again.onclick = () => { seatThenOpen(key); };
    again.focus();
  };
  const seatThenOpen = (key: string): void => {
    if (seating) return;
    note.innerHTML = '이 서버에서 쓰실 개인 계정을 만들고 있어요 — 처음 한 번만, 보통 20초쯤(느리면 1~2분) 걸려요. 다 되면 바로 이어서 로그인을 열어 드릴게요.';
    note.hidden = false;
    seating = (async () => {
      let ask: { start?: boolean; retry?: boolean } = { start: true, retry: true };
      let misses = 0;
      for (;;) {
        if (!hooks.alive()) return;
        const st = await askSeat(ask);
        if (!hooks.alive()) return;
        if (st === 'ready' || st === 'none') break;
        if (st === 'failed') { seatFail(key, '이 서버에서 쓰실 개인 계정을 만들지 못했어요.'); return; }
        if (st === 'preparing') { ask = {}; misses = 0; }          // 서버가 만들고 있다 — 이제 묻기만
        else {                                                      // 못 물었거나(끊김) · 아직 시작이 안 됐다(absent) — 다시 시작을 부탁한다
          ask = { start: true };
          if (++misses >= SEAT_MISS_MAX) { seatFail(key, '이 서버에서 쓰실 개인 계정 만들기를 시작하지 못했어요.'); return; }
        }
        await new Promise((z) => setTimeout(z, PREP_POLL_MS));
      }
      await reload();
      const it = items.get(key);
      if (it && hooks.alive() && it.a.loggedIn !== true) openLogin(it);
    })().finally(() => { seating = null; if (hooks.alive()) setGoDisabled(false); });
    setGoDisabled(true);
  };

  const make = (a: AiAccountRow): Item => {
    const wrap = document.createElement('div');
    wrap.className = 'ob-ai-item';
    wrap.innerHTML = `<div class="ob-opt-card ob-ai-card">
        <span class="ob-oc-ic">${AI_LOGO[a.key] || ''}</span>
        <span class="ob-ai-txt"><span class="ob-oc-t">${esc(AI_BRAND[a.key] || a.label)}</span><span class="ob-oc-d">${esc(a.label)}${a.scope === 'shared' ? ' · 이 서버 공용 계정' : ''}</span></span>
        <span class="ob-ai-act"></span>
      </div>`;
    const card = wrap.querySelector<HTMLElement>('.ob-ai-card')!;
    const act = wrap.querySelector<HTMLElement>('.ob-ai-act')!;
    return { a, wrap, card, act, panel: null, hl: null, hlBusy: false };
  };

  /** 그 줄을 제자리에서 고친다 — 연결됐으면 칸을 걷는다(떨어진 칸은 폴링이 스스로 멈춘다). */
  const update = (it: Item, a: AiAccountRow): void => {
    const was = it.a.loggedIn === true;
    it.a = a;
    const on = a.loggedIn === true;
    it.card.classList.toggle('ob-on', on);
    if (on && it.panel) { it.panel.panel.remove(); it.panel = null; }
    if (on !== was || !it.act.firstElementChild) { it.act.innerHTML = actHtml(a); wireGo(it); }
  };

  //  (#5167) 자동 정리 자격 — 로그인을 마친 클로드·코덱스 줄이 생기면 묻는다. 묻기가 실패하면 막지 않는다(needed:false).
  let hl: HeadlessState | null = null;
  const ready = (): boolean => aiStepReady([...items.values()].map((it) => it.a), hl);
  const loadHeadless = async (): Promise<void> => {
    try {
      const r = (await api('/api/ui/me/headless')) as { needed?: unknown; harnesses?: HeadlessRow[] } | null;
      const rows = new Map((r?.harnesses || []).map((h) => [h.key, h] as const));
      hl = { needed: r?.needed === true, rows, ok: new Set([...rows.values()].filter((h) => h.connected && !h.failure).map((h) => h.key)) };
    } catch (_) {
      if (!hl) hl = { needed: false, rows: new Map(), ok: new Set() };   // 처음부터 못 물었다 — 처음 설정을 막지 않는다
    }
  };
  /** 그 줄 아래 자동 정리 승인 칸을 고친다 — 로그인을 마친 클로드·코덱스 줄이고 이 서버가 그 자격을 요구할 때만. */
  const paintHl = (it: Item): void => {
    const row = hl && hl.needed && it.a.loggedIn === true && HEADLESS_INLINE[it.a.key] === true ? hl.rows.get(it.a.key) : undefined;
    if (!row) { if (it.hl && !it.hlBusy) { it.hl.remove(); it.hl = null; } return; }
    if (!it.hl) { it.hl = document.createElement('div'); it.hl.className = 'ob-ai-hl'; it.wrap.append(it.hl); }
    if (hl!.ok.has(it.a.key)) {
      it.hlBusy = false;
      it.hl.innerHTML = '<p class="ob-q-help ob-ai-hl-ok">✓ 자리에 없을 때 파일 정리도 이 계정으로 해요</p>';
      return;
    }
    if (it.hlBusy) return;   // 승인 칸이 열려 있다 — 받은 주소·코드를 지우지 않는다
    const p = headlessParts(row, () => { void reload(); });
    p.act.textContent = '승인하기';
    p.act.className = 'ob-btn ob-btn-pri ob-btn-inline';
    p.act.addEventListener('click', () => { it.hlBusy = true; });
    const say = document.createElement('p');
    say.className = 'ob-q-help';
    say.textContent = `자리에 없을 때도 올린 파일을 지식으로 정리하려면 ${AI_BRAND[it.a.key] || row.label} 승인을 한 번 더 해 주세요 — 주소를 열어 승인하면 30초쯤이면 끝나요.`;
    it.hl.replaceChildren(say, p.act, p.panel);
  };
  const paintAllHl = (): void => { for (const it of items.values()) paintHl(it); };
  const refreshHeadless = async (): Promise<void> => {
    if (![...items.values()].some((it) => it.a.loggedIn === true && HEADLESS_INLINE[it.a.key] === true)) return;
    await loadHeadless();
    if (!hooks.alive()) return;
    paintAllHl();
    hooks.onRows(ready());
  };

  const paint = (rows: AiAccountRow[]): void => {
    if (!rows.length) {
      items.clear();
      list.innerHTML = `<p class="ob-q-help">${esc(hooks.noneText)}</p>`;
      hooks.onEmpty();
      return;
    }
    const same = rows.length === items.size && rows.every((a) => items.has(a.key));
    if (!same) {
      //  줄의 모음이 바뀌었다(첫 그림 · 설치가 달라짐) — 그때만 새로 짠다. 로그인 중인 칸은 같은 열쇠의 새 줄로 옮긴다.
      const old = new Map(items); items.clear();
      for (const a of rows) {
        const prev = old.get(a.key);
        const it = make(a);
        if (prev?.panel) { it.panel = prev.panel; it.wrap.append(prev.panel.panel); }
        //  (#5167) 자동 정리 승인 칸도 같이 옮긴다 — 받던 주소·코드가 지워지지 않게.
        if (prev?.hl) { it.hl = prev.hl; it.hlBusy = prev.hlBusy; it.wrap.append(prev.hl); }
        items.set(a.key, it);
        update(it, a);
      }
      list.replaceChildren(...[...items.values()].map((it) => it.wrap), note);
    } else {
      for (const a of rows) update(items.get(a.key)!, a);
    }
    paintAllHl();
    hooks.onRows(ready());
  };

  /** 다시 읽기는 한 번에 하나 — 도중에 또 부르면 끝난 뒤 한 번 더 읽는다(낡은 답을 돌려주지 않는다). */
  let running: Promise<void> | null = null;
  let again = false;
  const once = async (): Promise<void> => {
    let acc: AiAccountRow[];
    try { acc = (((await api('/api/ui/me/ai-accounts')) as { accounts?: AiAccountRow[] } | null)?.accounts) || []; }
    catch (e) {
      if (!hooks.alive()) return;
      const why = esc((e as Error)?.message || '');
      if (!items.size) {
        //  처음부터 못 읽었다 — 다시 읽을 길을 준다(«PC에서 쓰는 AI로» 만 남기지 않는다).
        list.innerHTML = `<p class="ob-q-help">AI 목록을 불러오지 못했어요. ${why}</p>
          <button type="button" class="ob-linkbtn ob-ai-retry">다시 불러오기</button>`;
        list.querySelector<HTMLButtonElement>('.ob-ai-retry')!.onclick = () => { void reload(); };
      } else {
        //  이미 그린 줄은 그대로 둔다 — 로그인 중인 칸(주소·코드)을 지우지 않는다.
        note.innerHTML = `상태를 새로 읽지 못했어요. ${why} <button type="button" class="ob-linkbtn ob-ai-retry">다시 불러오기</button>`;
        note.querySelector<HTMLButtonElement>('.ob-ai-retry')!.onclick = () => { void reload(); };
        note.hidden = false;
      }
      return;
    }
    if (!hooks.alive()) return;
    note.hidden = true;
    const rows = visibleAiRows(acc).map((a) => (a.loggedIn === null && probed.has(a.key) ? { ...a, loggedIn: probed.get(a.key)! } : a));
    paint(rows);   // 먼저 그린다 — 프로브(수 초)를 기다리느라 다른 줄의 «연결됨» 이 늦지 않게
    for (const a of rows) {
      if (a.how !== 'probe' || !asked.has(a.key) || a.loggedIn === true) continue;
      try {
        const r = await api('/api/ui/me/ai-accounts/check', { method: 'POST', body: JSON.stringify({ harness: a.key }) }) as { loggedIn?: unknown } | null;
        if (r && typeof r.loggedIn === 'boolean') probed.set(a.key, r.loggedIn);
      } catch (_) { /* 모름 그대로 — 칸의 [상태 새로고침]이 다시 묻는다 */ }
      if (!hooks.alive()) return;
      const it = items.get(a.key);
      if (it && probed.has(a.key)) update(it, { ...it.a, loggedIn: probed.get(a.key)! });
      hooks.onRows(ready());
    }
    await refreshHeadless();
  };
  const reload = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await once(); } while (again && hooks.alive());
    })().finally(() => { running = null; });
    return running;
  };
  //  격리 박스(셀프호스트)에서 그 사람의 서버 계정을 **만드는 중**이면 몇 초마다 다시 묻고, 다 되면 그린다(서버 login-seat-prep 머리말).
  //   ⚠ 만드는 중엔 그리지 않는다 — 계정(useradd)은 만들기 초반에 생기고 구성원 몫 claude·codex 는 그 뒤에 깔려, 그 사이 목록·로그인이
  //    반쯤 된 홈을 본다(격리 리뷰). 격리 박스가 아니면 서버가 곧바로 none.
  //   처음에 못 물었으면(옛 서버 404 · 끊김) 그냥 그린다 — 처음 설정이 막히면 안 된다. 단 «준비하는 중» 을 본 뒤에 한 번 못 물은
  //   것(배포 중 5xx 한 번)은 그리지 않고 다시 묻는다 — 그리면 아직 준비 중인 목록이 «이 서버 공용 계정» 으로 되살아난다(격리 리뷰).
  //  (#5031) 장면을 열 때는 **묻기만** 한다(start:false) — 계정은 사람이 서버 AI 의 [연결]을 누를 때 만든다(seatThenOpen). 계정이 없으면(absent)
  //   목록을 곧바로 그린다 — 서버가 그 줄들을 «연결 전»(pending)으로 준다(공용 자격을 그 사람 것처럼 보이지 않는다). 누가 이미 만드는 중이면
  //   (웹 세션을 먼저 열었다 등) 종전처럼 다 될 때까지 기다린다. «다시 해 보기»(retry)는 사람이 누른 것이라 만든다.
  const askSeat = async (o: { start?: boolean; retry?: boolean } = {}): Promise<string> => {
    try { return String(((await api('/api/ui/me/ai-login/prepare', { method: 'POST', body: JSON.stringify({ retry: !!o.retry, start: !!o.start }) })) as { state?: unknown } | null)?.state ?? ''); }
    catch (_) { return ''; }
  };
  let sawPreparing = false;
  const prepare = async (retry = false): Promise<void> => {
    //  묻기 **전에도** 본다 — 장면을 떠난 뒤 이미 걸어 둔 다음 묻기(4초)가 한 번 더 나가지 않게(화면 시험 Q7).
    if (!hooks.alive()) return;
    const state = await askSeat({ retry, start: retry });
    if (!hooks.alive()) return;
    if (state === 'preparing' || (!state && sawPreparing)) {
      sawPreparing = true;
      list.innerHTML = `<p class="ob-q-help">이 서버에서 쓰실 개인 계정을 준비하고 있어요. 처음 한 번만 하면 되고, 다 되면 바로 이어져요.</p>`;
      setTimeout(() => { void prepare(); }, PREP_POLL_MS);
      return;
    }
    if (state === 'failed') {
      list.innerHTML = `<p class="ob-q-help">이 서버에서 쓰실 개인 계정을 만들지 못했어요. 관리자에게 알려 주세요 — 그동안은 아래 «PC에서 쓰는 AI로» 를 쓰실 수 있어요.</p>
        <button type="button" class="ob-linkbtn ob-ai-retry">다시 해 보기</button>`;
      list.querySelector<HTMLButtonElement>('.ob-ai-retry')!.onclick = () => { list.innerHTML = ''; void prepare(true); };
      return;
    }
    void reload();
  };
  void prepare();
  return { reload };
}

// v2/session-app-dock.ts — **세션 오른쪽에 붙는 앱 칸** (#4225, 9/21 상민·원준 회의).
//
//  «앱을 실행하면 세션 오른쪽에 붙고, X 로 떼면 다시 세션만 남는다.» 세션이 먼저 있고, AI(같이 일하는 사람)가
//  필요할 때 앱을 띄워 쓰고 다 쓰면 뗀다 — 기능에 맥락이 속하는 게 아니라 맥락에 기능이 속한다.
//
//  ── 왜 곁칸 탭이 아니라 세션 화면 옆인가 ──
//  곁칸 배치는 **프로젝트마다 한 벌**이고 그 프로젝트의 세션들이 나눠 쓴다(panes.ts LAYOUT_KEY 주석). 그런데 앱은
//   **세션에** 붙는다(서버 org_session_app — 붙어 있는 동안만 그 세션의 AI 가 그 앱 테이블을 쓴다). 곁칸 탭으로 두면
//   세션을 갈아 끼울 때 남의 세션에 붙은 앱이 그대로 떠 있게 된다. 그래서 세션 부품 안, 세션 화면 바로 옆에 둔다 —
//   세션을 바꾸면 그 세션에 붙은 앱으로 바뀌고, 붙은 게 없으면 칸 자체가 없다(세션만 남는다).
//
//  ── 같은 화면 (AI 가 한 것이 사람 화면에) ──
//  서버가 쓰기마다 «이 앱의 이 테이블이 바뀌었다»를 스트림으로 민다(live-sync onAppEvent). 앱이 SDK 의
//   lively.store.onChange 로 구독했으면 알림만 넘기고(앱이 스스로 다시 읽는다 — 입력 중인 글이 안 날아간다),
//   구독하지 않은 앱이면 **바깥(세션·스크립트)에서 쓴 것일 때만** 화면을 다시 불러온다. 앱 화면 제 손으로 쓴 것에
//   스스로 다시 불러오면 사람이 쓰던 화면이 매번 처음으로 돌아간다.
//  스트림이 없는 게이트웨이(구버전·끊김)를 위해 붙은 목록은 15초마다 한 번 다시 읽는다.
import { api, el, toast } from '../core.js';
import { mountAppUiFrame, type AppUiFrame } from './app-ui.js';
import { ensureAppGrant } from './app-session.js';
import { onAppEvent, type LiveAppEvent } from './live-sync.js';
import { makeSplitter } from './split.js';
import { pnIcon } from './panes-kit.js';

export interface AttachedApp {
  app_id: string;
  title: string;
  attached_at: string;
  attached_by: string;
  usable: boolean;
  has_ui: boolean;
  pages: Array<{ key: string; title: string }>;
  tables: Array<{ name: string; columns: unknown[] }>;
}

/** 칸 셸의 신호 — 곁칸 [앱] 에서 붙였다(이 곁칸 한 벌 안에서만 오간다, PartCtx.paneRoot 주석). */
export const SESSION_APPS_EVT = 'pn:session-apps';

const sessPath = (sid: string, tail = ''): string => '/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/apps' + tail;

export async function listAttached(sid: string): Promise<AttachedApp[]> {
  const out: any = await api(sessPath(sid));
  return Array.isArray(out?.apps) ? out.apps : [];
}

/**
 * 이 세션에 앱을 붙인다 — 동의가 없으면 **그 자리에서** 동의 창을 띄우고 한 번 다시 붙인다(앱 화면의 첫 도구 호출과 같은 문법).
 *  돌려주는 값 = 붙었나(취소·실패는 false, 실패 이유는 toast).
 */
export async function attachAppToSession(sid: string, appId: string, title?: string): Promise<boolean> {
  const send = (): Promise<any> => api(sessPath(sid, '/attach'), { method: 'POST', body: JSON.stringify({ app_id: appId }) });
  try {
    try { await send(); }
    catch (e: any) {
      if (e?.status !== 403 || !/동의|grant/i.test(String(e?.message || ''))) throw e;
      if (!(await ensureAppGrant(appId, title))) return false;
      await send();
    }
    return true;
  } catch (e: any) {
    toast('앱을 붙이지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

export async function detachAppFromSession(sid: string, appId: string): Promise<boolean> {
  try { await api(sessPath(sid, '/detach'), { method: 'POST', body: JSON.stringify({ app_id: appId }) }); return true; }
  catch (e: any) { toast('앱을 떼지 못했어요 — ' + (e && e.message ? e.message : e), true); return false; }
}

export interface SessionAppDock {
  /** 세션 화면 자리 + 손잡이 + 앱 칸을 담은 줄 — 세션 부품이 stage 대신 이걸 붙인다. */
  row: HTMLElement;
  setSession(sid: string | null): void;
  refresh(): void;
  destroy(): void;
}

const POLL_MS = 15_000;
const RELOAD_DEBOUNCE_MS = 600;

/**
 * @param stage 세션 화면이 들어가는 자리(세션 부품이 쥔다) — 이 줄의 왼쪽이 된다.
 * @param o.paneRoot 곁칸 한 벌의 뿌리 — [앱] 에서 붙였다는 신호를 여기서 받는다.
 * @param o.canManage 그 세션의 주인인가 — 아니면 × 를 안 단다(떼기는 주인만, 서버도 막는다).
 */
export function createSessionAppDock(stage: HTMLElement, o: { paneRoot: () => HTMLElement; canManage: (sid: string) => boolean }): SessionAppDock {
  const tabs = el('div', { class: 'pn-appdock-tabs', role: 'tablist' });
  const acts = el('div', { class: 'pn-appdock-acts' });
  const body = el('div', { class: 'pn-appdock-body' });
  const dock = el('section', { class: 'pn-appdock', hidden: true, 'aria-label': '세션에 붙은 앱' },
    el('div', { class: 'pn-appdock-h' }, tabs, acts), body);
  const row = el('div', { class: 'pn-stagerow' }, stage) as HTMLElement;
  const handle = makeSplitter({
    axis: 'x', key: 'pn_appdock', cssVar: '--pn-appdock-w', target: row, def: 460, min: 300,
    max: () => Math.max(300, row.clientWidth - 360), grow: -1, label: '앱 칸 너비',
  });
  handle.classList.add('pn-appdock-split');
  handle.hidden = true;
  row.append(handle, dock);

  let sid: string | null = null;
  let apps: AttachedApp[] = [];
  const pick = new Map<string, string>();       // 세션 → 고른 앱(여럿 붙었을 때). 새로고침하면 가장 최근 것으로.
  let mounted: { sid: string; appId: string; frame: AppUiFrame | null } | null = null;
  let mountSeq = 0;                             // 늦게 도착한 앱 화면이 지금 것을 덮지 않게
  let listSeq = 0;                              // 늦게 도착한 목록이 지금 것을 덮지 않게
  let dead = false;
  let reloadTimer = 0;

  const unmount = (): void => {
    mountSeq++;                                  // 여는 중이던 화면은 도착해도 버린다(세션을 바꿨다·뗐다)
    if (reloadTimer) { window.clearTimeout(reloadTimer); reloadTimer = 0; }
    mounted?.frame?.destroy();
    mounted = null;
    body.replaceChildren();
  };
  const show = (on: boolean): void => { dock.hidden = !on; handle.hidden = !on; row.classList.toggle('with-app', on); };
  const current = (): AttachedApp | null => {
    if (!apps.length) return null;
    const want = sid ? pick.get(sid) : undefined;
    return apps.find((a) => a.app_id === want) || apps[apps.length - 1];
  };

  function paintHead(cur: AttachedApp): void {
    tabs.replaceChildren(...apps.map((a) => el('button', {
      class: 'pn-appdock-tab' + (a.app_id === cur.app_id ? ' on' : ''), type: 'button', role: 'tab',
      'aria-selected': a.app_id === cur.app_id ? 'true' : 'false', title: a.title,
      onclick: () => { if (sid) { pick.set(sid, a.app_id); paint(); } },
    }, pnIcon('grid', 'pn-i'), el('span', { text: a.title }))));
    const s = sid;
    acts.replaceChildren(...(s && o.canManage(s) ? [el('button', {
      class: 'pn-appdock-x', type: 'button', 'aria-label': cur.title + ' 떼기',
      title: '이 세션에서 떼기 — 앱의 데이터는 그대로 남아요',
      onclick: () => void (async () => { if (await detachAppFromSession(s, cur.app_id)) refresh(); })(),
    }, '×')] : []));
  }

  async function mountApp(cur: AttachedApp): Promise<void> {
    const s = sid;
    if (!s) return;
    if (mounted && mounted.sid === s && mounted.appId === cur.app_id) return;
    unmount();
    mounted = { sid: s, appId: cur.app_id, frame: null };
    const mine = ++mountSeq;
    if (!cur.usable) {
      body.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '이 앱은 지금 쓸 수 없어요.' }),
        el('p', { class: 'pn-fine', text: '관리자가 앱을 껐거나 설치 중이에요. × 로 떼어 둘 수 있어요.' })));
      return;
    }
    if (!cur.has_ui) {
      // 화면이 없는 앱 — AI 가 데이터만 쓴다. 무엇을 쓰는지만 보여 준다.
      body.replaceChildren(el('div', { class: 'pn-appdock-info' },
        el('b', { text: '화면이 없는 앱이에요.' }),
        el('p', { class: 'pn-fine', text: '이 세션의 AI 가 아래 테이블을 읽고 쓸 수 있어요.' }),
        ...(cur.tables.length ? cur.tables.map((t) => el('div', { class: 'pn-appdock-tbl' }, el('code', { text: t.name }),
          el('span', { class: 'pn-fine', text: (t.columns as any[]).map((c) => String((c && c.name) || c)).join(' · ') }))) : [el('p', { class: 'pn-fine', text: '선언된 테이블이 없어요.' })])));
      return;
    }
    body.replaceChildren(el('p', { class: 'pn-fine pn-appdock-wait', text: '앱을 여는 중…' }));
    try {
      const frame = await mountAppUiFrame(cur.app_id, { title: cur.title, sessionId: s, page: cur.pages[0]?.key });
      if (dead || mine !== mountSeq) { frame.destroy(); return; }
      mounted = { sid: s, appId: cur.app_id, frame };
      body.replaceChildren(frame.root);
    } catch (e: any) {
      if (mine !== mountSeq) return;
      mounted = null;                           // 다음 목록 갱신이 다시 열어 보게
      body.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '앱 화면을 열지 못했어요.' }),
        el('p', { class: 'pn-fine', text: String(e && e.message ? e.message : e) })));
    }
  }

  function paint(): void {
    const cur = current();
    if (!sid || !cur) { unmount(); show(false); return; }
    show(true);
    paintHead(cur);
    void mountApp(cur);
  }

  function refresh(): void {
    const s = sid;
    if (!s) { apps = []; paint(); return; }
    const mine = ++listSeq;
    void listAttached(s).then((rows) => {
      if (dead || s !== sid || mine !== listSeq) return;
      const before = new Set(apps.map((a) => a.app_id));
      // 새로 붙은 앱이 있으면 그것을 앞에 세운다 — 방금 붙인 사람은 그 앱을 보려고 붙였다.
      const fresh = before.size ? rows.find((a) => !before.has(a.app_id)) : undefined;
      if (fresh) pick.set(s, fresh.app_id);
      apps = rows;
      paint();
    }).catch(() => { if (!dead && s === sid && mine === listSeq) { apps = []; paint(); } });
  }

  // 데이터 변경 — 붙은 앱 화면을 최신으로(머리말 «같은 화면»).
  const onData = (ev: LiveAppEvent): void => {
    const m = mounted;
    if (!m || !m.frame || ev.app_id !== m.appId) return;
    if (m.frame.subscribed('data')) {
      m.frame.notify('ui/notifications/data-changed', { table: ev.table ?? null, op: ev.op ?? null, source: ev.source ?? null, session: ev.session ?? null });
      return;
    }
    if (ev.source === 'app-ui') return;          // 앱 화면이 제 손으로 쓴 것 — 다시 불러오면 쓰던 화면이 처음으로 돌아간다
    if (reloadTimer) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => { reloadTimer = 0; mounted?.frame?.reload(); }, RELOAD_DEBOUNCE_MS);   // AI 가 여러 행을 연달아 쓰면 한 번만
  };
  const offLive = onAppEvent((ev) => {
    if (ev.kind === 'data') { onData(ev); return; }
    if (sid && ev.session === sid) refresh();     // 붙이기·떼기 — 다른 탭·AI 가 한 것도 여기 따라온다
  });
  const onLocal = (e: Event): void => {
    const d = (e as CustomEvent<{ sid?: string; app_id?: string }>).detail || {};
    if (!sid || (d.sid && d.sid !== sid)) return;
    if (d.app_id) pick.set(sid, d.app_id);
    refresh();
  };
  o.paneRoot().addEventListener(SESSION_APPS_EVT, onLocal);
  const poll = window.setInterval(() => { if (!document.hidden && sid) refresh(); }, POLL_MS);

  return {
    row,
    setSession(next) {
      if (next === sid) return;
      sid = next;
      apps = [];
      unmount();
      show(false);
      refresh();
    },
    refresh,
    destroy() {
      dead = true;
      offLive();
      o.paneRoot().removeEventListener(SESSION_APPS_EVT, onLocal);
      window.clearInterval(poll);
      unmount();
    },
  };
}

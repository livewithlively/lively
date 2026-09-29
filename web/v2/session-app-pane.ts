// v2/session-app-pane.ts — **세션에 붙은 앱 = 곁칸의 탭** (#4225, 9/21 상민·원준 회의 · 상민 2026-09-30 «곁칸으로»).
//
//  «앱을 실행하면 세션 오른쪽에 붙고, X 로 떼면 다시 세션만 남는다.» 곁칸이 곧 세션 오른쪽이다. 그래서 앱은 따로 칸을 만들지
//   않고 곁칸에 **앱 이름의 탭**으로 선다:
//   · 붙이면 그 탭이 생겨 켜진다(곁칸이 접혀 있으면 펴고, 폰이면 서랍을 연다) · 탭의 × = 이 세션에서 떼기
//   · 세션을 바꾸면 그 세션에 붙은 앱으로 바뀐다 — 붙은 게 없으면 탭이 없다.
//  ⚠ 이 탭은 **배치에 저장하지 않는다**(panes.ts DERIVED_TABS). 곁칸 배치는 프로젝트 한 벌을 그 프로젝트의 세션들이 같이
//   쓰는데, 붙은 앱은 세션 것이다 — 저장하면 앱이 안 붙은 세션을 열 때 빈 탭이 한 번 떴다 사라진다.
//   탭 **안의 내용**이 지금 보는 세션을 따르는 것은 다른 곁칸 부품(웹 칸 주소·뷰어 파일·타임라인)과 같은 규칙이다(PartCtx 머리말).
//
//  ── 같은 화면 (AI 가 한 것이 사람 화면에) ──
//  서버가 쓰기마다 «이 앱의 이 테이블이 바뀌었다»를 스트림으로 민다(live-sync onAppEvent). 앱이 SDK 의 lively.store.onChange 로
//   구독했으면 알림만 넘기고(앱이 스스로 다시 읽는다 — 입력 중인 글이 안 날아간다), 구독하지 않은 앱이면 **바깥(세션·스크립트)에서
//   쓴 것일 때만** 화면을 다시 불러온다. 스트림이 없는 게이트웨이를 위해 붙은 목록은 15초마다 한 번 다시 읽는다.
import { api, el, toast } from '../core.js';
import { mountAppUiFrame, type AppUiFrame } from './app-ui.js';
import { ensureAppGrant } from './app-session.js';
import { onAppEvent, type LiveAppEvent } from './live-sync.js';
import { pnIcon } from './panes-kit.js';
import type { Part, PartCtx } from './panes-parts.js';

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

/** 곁칸의 붙은 앱 탭 — 부품 종류 이름이자 탭 열쇠. 배치에 저장하지 않는다(머리말). */
export const SESSAPP_TAB = 'sessapp';

const sessPath = (sid: string, tail = ''): string => '/api/ui/terminal/sessions/' + encodeURIComponent(sid) + '/apps' + tail;

export async function listAttached(sid: string): Promise<AttachedApp[]> {
  const out: any = await api(sessPath(sid));
  return Array.isArray(out?.apps) ? out.apps : [];
}

// ── 세션별 붙은 목록 — 셸(탭을 세울지)과 부품(무엇을 그릴지)이 **같은 한 벌**을 본다 ─────────────────
//  둘이 따로 읽으면 한쪽만 새 목록을 받은 틱에 «탭은 있는데 내용은 빈» 화면이 선다. 요청도 세션당 하나로 합친다.
type Listener = (apps: AttachedApp[], added: string[]) => void;
interface Entry { apps: AttachedApp[] | null; subs: Set<Listener>; seq: number; poll: number }
const entries = new Map<string, Entry>();
const POLL_MS = 15_000;

/** 목록이 바뀐 만큼만 알린다 — 새로 붙은 앱 id(첫 판은 비교할 게 없어 빈 목록: 화면을 열자마자 탭을 뺏지 않게). 순수. */
export function attachedDiff(prev: readonly string[] | null, next: readonly string[]): { added: string[]; changed: boolean } {
  if (prev === null) return { added: [], changed: true };
  const was = new Set(prev);
  const added = next.filter((id) => !was.has(id));
  const changed = added.length > 0 || prev.length !== next.length || prev.some((id, i) => id !== next[i]);
  return { added, changed };
}

export function refreshSessionApps(sid: string): void {
  const e = entries.get(sid);
  if (!e) return;
  const mine = ++e.seq;
  void listAttached(sid).then((rows) => {
    if (mine !== e.seq || entries.get(sid) !== e) return;          // 늦게 온 판 · 구독이 다 끊긴 뒤의 판
    const d = attachedDiff(e.apps ? e.apps.map((a) => a.app_id) : null, rows.map((a) => a.app_id));
    e.apps = rows;
    if (!d.changed) return;
    for (const fn of [...e.subs]) { try { fn(rows, d.added); } catch { /* 한 구독이 다른 구독을 막지 않는다 */ } }
  }).catch(() => { /* 판정 불가 — 받던 대로 둔다(빈 목록으로 덮으면 탭이 사라졌다 돌아온다) */ });
}

/** 그 세션의 붙은 목록을 받는다. 이미 받은 판이 있으면 곧바로 한 번 부른다. 돌려주는 함수를 부르면 끊는다. */
export function watchSessionApps(sid: string, fn: Listener): () => void {
  let e = entries.get(sid);
  if (!e) {
    e = { apps: null, subs: new Set(), seq: 0, poll: 0 };
    entries.set(sid, e);
    const ent = e;
    ent.poll = window.setInterval(() => { if (!document.hidden) refreshSessionApps(sid); }, POLL_MS);
  }
  e.subs.add(fn);
  if (e.apps) { try { fn(e.apps, []); } catch { /* */ } }
  if (e.subs.size === 1) refreshSessionApps(sid);
  const ent = e;
  return () => {
    ent.subs.delete(fn);
    if (!ent.subs.size) { window.clearInterval(ent.poll); if (entries.get(sid) === ent) entries.delete(sid); }
  };
}

//  붙이기·떼기 사건(다른 탭·AI 가 한 것)은 그 세션의 목록을 다시 읽게 한다. 데이터 사건은 부품이 따로 받는다.
onAppEvent((ev) => { if (ev.kind !== 'data' && ev.session && entries.has(ev.session)) refreshSessionApps(ev.session); });

/**
 * 이 세션에 앱을 붙인다 — 동의가 없으면 **그 자리에서** 동의 창을 띄우고 한 번 다시 붙인다(앱 화면의 첫 도구 호출과 같은 문법).
 *  붙으면 목록을 다시 읽는다 → 셸이 «새로 붙음»을 보고 그 탭을 켠다. 돌려주는 값 = 붙었나(취소·실패는 false, 이유는 toast).
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
    refreshSessionApps(sid);
    return true;
  } catch (e: any) {
    toast('앱을 붙이지 못했어요 — ' + (e && e.message ? e.message : e), true);
    return false;
  }
}

export async function detachAppFromSession(sid: string, appId: string): Promise<boolean> {
  try {
    await api(sessPath(sid, '/detach'), { method: 'POST', body: JSON.stringify({ app_id: appId }) });
    refreshSessionApps(sid);
    return true;
  } catch (e: any) { toast('앱을 떼지 못했어요 — ' + (e && e.message ? e.message : e), true); return false; }
}

const RELOAD_DEBOUNCE_MS = 600;

/**
 * 곁칸의 붙은 앱 탭 — 지금 보는 세션에 붙은 앱 화면. 여럿 붙었으면 안에 작은 탭 줄이 선다.
 *  탭 이름은 보이는 앱의 이름(setTabTitle), 탭의 × 는 그 앱을 떼는 것(onTabClose — 셸이 탭을 빼는 대신 이걸 부른다).
 */
export function sessAppPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessapp' });
  const tabs = el('div', { class: 'pn-sessapp-tabs', role: 'tablist', hidden: true });
  const body = el('div', { class: 'pn-sessapp-body' });
  root.append(tabs, body);

  let sid: string | null = null;
  let apps: AttachedApp[] = [];
  const pick = new Map<string, string>();       // 세션 → 고른 앱(여럿 붙었을 때)
  let mounted: { sid: string; appId: string; frame: AppUiFrame | null } | null = null;
  let mountSeq = 0;
  let reloadTimer = 0;
  let off: (() => void) | null = null;

  const unmount = (): void => {
    mountSeq++;
    if (reloadTimer) { window.clearTimeout(reloadTimer); reloadTimer = 0; }
    mounted?.frame?.destroy();
    mounted = null;
    body.replaceChildren();
  };
  const current = (): AttachedApp | null => {
    if (!apps.length) return null;
    const want = sid ? pick.get(sid) : undefined;
    return apps.find((a) => a.app_id === want) || apps[apps.length - 1];
  };

  async function mountApp(cur: AttachedApp): Promise<void> {
    const s = sid;
    if (!s) return;
    if (mounted && mounted.sid === s && mounted.appId === cur.app_id) return;
    unmount();
    mounted = { sid: s, appId: cur.app_id, frame: null };
    const mine = ++mountSeq;
    if (!cur.usable) {
      body.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '이 앱은 지금 쓸 수 없어요.' }),
        el('p', { class: 'pn-fine', text: '관리자가 앱을 껐거나 설치 중이에요. 탭의 × 로 떼어 둘 수 있어요.' })));
      return;
    }
    if (!cur.has_ui) {
      body.replaceChildren(el('div', { class: 'pn-sessapp-info' },
        el('b', { text: '화면이 없는 앱이에요.' }),
        el('p', { class: 'pn-fine', text: '이 세션의 AI 가 아래 테이블을 읽고 쓸 수 있어요.' }),
        ...(cur.tables.length ? cur.tables.map((t) => el('div', { class: 'pn-sessapp-tbl' }, el('code', { text: t.name }),
          el('span', { class: 'pn-fine', text: (t.columns as any[]).map((c) => String((c && c.name) || c)).join(' · ') }))) : [el('p', { class: 'pn-fine', text: '선언된 테이블이 없어요.' })])));
      return;
    }
    body.replaceChildren(el('p', { class: 'pn-fine pn-sessapp-wait', text: '앱을 여는 중…' }));
    try {
      const frame = await mountAppUiFrame(cur.app_id, { title: cur.title, sessionId: s, page: cur.pages[0]?.key });
      if (ctx.dead() || mine !== mountSeq) { frame.destroy(); return; }
      mounted = { sid: s, appId: cur.app_id, frame };
      body.replaceChildren(frame.root);
    } catch (e: any) {
      if (mine !== mountSeq) return;
      mounted = null;
      body.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '앱 화면을 열지 못했어요.' }),
        el('p', { class: 'pn-fine', text: String(e && e.message ? e.message : e) })));
    }
  }

  function paint(): void {
    const cur = current();
    ctx.setTabTitle?.(cur ? cur.title : null);
    tabs.hidden = apps.length < 2;
    tabs.replaceChildren(...(apps.length < 2 ? [] : apps.map((a) => el('button', {
      class: 'pn-sessapp-tab' + (cur && a.app_id === cur.app_id ? ' on' : ''), type: 'button', role: 'tab',
      'aria-selected': cur && a.app_id === cur.app_id ? 'true' : 'false', title: a.title,
      onclick: () => { if (sid) { pick.set(sid, a.app_id); paint(); } },
    }, pnIcon('apps', 'pn-i sm'), el('span', { text: a.title })))));
    if (!cur) {
      unmount();
      body.replaceChildren(el('div', { class: 'pn-empty' }, pnIcon('apps', 'pn-i big'),
        el('b', { text: '이 세션에 붙은 앱이 없어요.' }),
        el('p', { class: 'pn-fine', text: '사이드바 [앱]에서 앱을 누르면 이 세션에 붙어요 — AI 도 그 앱을 같이 씁니다.' })));
      return;
    }
    void mountApp(cur);
  }

  function follow(next: string | null): void {
    if (next === sid && off) return;
    off?.(); off = null;
    sid = next; apps = [];
    unmount();
    if (!sid) { paint(); return; }
    const s = sid;
    off = watchSessionApps(s, (rows, added) => {
      if (s !== sid) return;
      if (added.length) pick.set(s, added[added.length - 1]);   // 방금 붙인 앱을 앞에 — 붙인 사람은 그걸 보려고 붙였다
      apps = rows;
      paint();
    });
    paint();
  }

  // 데이터 변경 — 붙은 앱 화면을 최신으로(머리말 «같은 화면»).
  const offLive = onAppEvent((ev: LiveAppEvent) => {
    if (ev.kind !== 'data') return;
    const m = mounted;
    if (!m || !m.frame || ev.app_id !== m.appId) return;
    if (m.frame.subscribed('data')) {
      m.frame.notify('ui/notifications/data-changed', { table: ev.table ?? null, op: ev.op ?? null, source: ev.source ?? null, session: ev.session ?? null });
      return;
    }
    if (ev.source === 'app-ui') return;          // 앱 화면이 제 손으로 쓴 것 — 다시 불러오면 쓰던 화면이 처음으로 돌아간다
    if (reloadTimer) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => { reloadTimer = 0; mounted?.frame?.reload(); }, RELOAD_DEBOUNCE_MS);
  });
  const offSess = ctx.onSession((s) => follow(s));
  follow(ctx.curSession());

  return {
    root,
    destroy: () => { off?.(); off = null; offLive(); offSess(); unmount(); },
    onTabClose: () => {
      const s = sid, cur = current();
      if (!s || !cur) return;
      void detachAppFromSession(s, cur.app_id).then((ok) => { if (ok) toast(`「${cur.title}」을(를) 이 세션에서 뗐어요 — 앱의 데이터는 그대로 남아요.`); });
    },
  };
}

// ── 누가 이 앱을 고칠 수 있나(관리자) — #4225 ─────────────────────────────────────
//  기본은 구성원 전원. 앱마다 «지정한 사람만»으로 좁힌다(관리자는 늘 된다). 서버 app_edit_policy_set 이 정본.
export async function openEditPolicyDialog(app: { id: string; title: string; editMode: 'all' | 'members'; editMembers: string[] }, onSaved?: () => void): Promise<void> {
  const back = el('div', { class: 'pn-modal-back' });
  const close = (): void => { back.remove(); box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  let mode: 'all' | 'members' = app.editMode;
  const chosen = new Set(app.editMembers);
  const list = el('div', { class: 'pn-editpol-list' }, el('p', { class: 'pn-fine', text: '구성원을 불러오는 중…' }));
  const radio = (v: 'all' | 'members', label: string, sub: string): HTMLElement => {
    const input = el('input', { type: 'radio', name: 'pn-editpol', value: v }) as HTMLInputElement;
    input.checked = mode === v;
    input.onchange = () => { mode = v; list.hidden = mode !== 'members'; };
    return el('label', { class: 'pn-editpol-opt' }, input, el('span', {}, el('b', { text: label }), el('span', { class: 'pn-fine', text: sub })));
  };
  list.hidden = mode !== 'members';
  const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => void (async () => {
    if (mode === 'members' && !chosen.size && !(await confirmEmpty())) return;
    try {
      await api('/api/ui/apps/' + encodeURIComponent(app.id) + '/edit-policy', { method: 'POST', body: JSON.stringify({ mode, members: [...chosen] }) });
      toast(mode === 'all' ? `「${app.title}」은(는) 이제 구성원 누구나 고칠 수 있어요.` : `「${app.title}」은(는) 이제 지정한 ${chosen.size}명(과 관리자)만 고칠 수 있어요.`);
      close(); onSaved?.();
    } catch (e: any) { toast('저장하지 못했어요 — ' + (e && e.message ? e.message : e), true); }
  })() }, el('span', { text: '저장' }));
  const confirmEmpty = async (): Promise<boolean> => { toast('한 명 이상 고르거나 «구성원 전원»을 고르세요 — 비워 두면 관리자만 고칠 수 있어요.', true); return false; };
  const box = el('div', { class: 'pn-modal pn-editpol', role: 'dialog', 'aria-label': app.title + ' 고칠 수 있는 사람' },
    el('div', { class: 'pn-modal-h' },
      el('h2', { text: `「${app.title}」 고칠 수 있는 사람` }),
      el('button', { class: 'pn-modal-x', type: 'button', 'aria-label': '닫기', onclick: () => close() }, pnIcon('x', 'pn-i sm'))),
    el('div', { class: 'pn-modal-b' },
      el('p', { class: 'pn-fine', text: '앱은 이 워크스페이스가 마음에 안 드는 곳을 바로 고쳐 쓰는 것이에요. 고친다 = 세션에서 앱을 다시 저장(app_save)하는 것. 쓰는 것(열기·붙이기)은 이 설정과 상관없이 누구나 할 수 있어요.' }),
      radio('all', '구성원 전원', '기본값 — 누구나 이 앱을 고칠 수 있어요.'),
      radio('members', '지정한 사람만', '아래에서 고른 사람과 관리자만 고칠 수 있어요.'),
      list),
    el('div', { class: 'pn-modal-f' }, el('span', { class: 'pn-fine ell', text: app.id }), save));
  back.onclick = () => close();
  document.addEventListener('keydown', onKey);
  document.body.append(back, box);

  const d: any = await api('/api/ui/org/members').catch(() => null);
  if (!box.isConnected) return;
  const people: Array<{ id: string; name: string }> = (Array.isArray(d?.members) ? d.members : Array.isArray(d) ? d : [])
    .filter((m: any) => m && m.kind === 'human' && m.state !== 'inactive')
    .map((m: any) => ({ id: String(m.id), name: String(m.display_name || m.id) }))
    .filter((m: { id: string }) => m.id);
  if (!people.length) { list.replaceChildren(el('p', { class: 'pn-fine', text: '구성원 목록을 불러오지 못했어요.' })); return; }
  list.replaceChildren(...people.map((p) => {
    const cb = el('input', { type: 'checkbox', value: p.id }) as HTMLInputElement;
    cb.checked = chosen.has(p.id);
    cb.onchange = () => { if (cb.checked) chosen.add(p.id); else chosen.delete(p.id); };
    return el('label', { class: 'pn-editpol-person' }, cb, el('span', { text: p.name }), el('span', { class: 'pn-fine', text: p.id }));
  }));
}

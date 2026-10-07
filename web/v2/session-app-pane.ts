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
import { mountAppUiFrame, openAppUi, type AppUiFrame } from './app-ui.js';
import { ensureAppGrant } from './app-session.js';
import { onAppEvent, type LiveAppEvent } from './live-sync.js';
import { ctxMenu, pnIcon } from './panes-kit.js';
import type { Part, PartCtx } from './panes-parts.js';
import { openVersionsMenu, revertToOrigin, revertToPrevious } from './app-versions.js';
import { bandText, draftTextFor, sessAppMenuRows } from '../lib/app-menu.js';
import { builtinAppIcon } from './glass-icon.js';
import { appGlyphName } from '../lib/icon-paths.js';

export interface AttachedApp {
  app_id: string;
  title: string;
  attached_at: string;
  attached_by: string;
  usable: boolean;
  has_ui: boolean;
  pages: Array<{ key: string; title: string }>;
  tables: Array<{ name: string; columns: unknown[] }>;
  /** #4600 — 지금 판 번호(app_versions 의 version_no · 옛 게이트웨이는 안 준다) · 워크스페이스 판이 원본을 덮고 있나. */
  version_no?: number | null;
  overrides_builtin?: boolean;
}

/** 「AI에게 고치기」 — 세션 대화 화면의 입력칸을 **채우기만** 한다(보내지 않는다 · 사람이 뒤를 잇는다). 받는 쪽은 web/session-chat.ts(fork A, SPEC §1-4). */
export const COMPOSE_DRAFT_EVT = 'lively:compose-draft';
export function composeDraft(session: string, text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSE_DRAFT_EVT, { detail: { session, text } }));
}

/** 곁칸의 붙은 앱 탭 — 부품 종류 이름이자 탭 열쇠. 배치에 저장하지 않는다(머리말). */
export const SESSAPP_TAB = 'sessapp';
/** «그 앱 탭을 보여 달라» — 곁칸 [앱]에서 **이미 붙은** 앱을 다시 눌렀을 때(새로 붙은 게 아니라 셸이 스스로는 안 켠다).
 *  이 곁칸 한 벌의 뿌리(paneRoot)에서만 오간다. detail.app_id = 앞에 세울 앱. */
export const SHOW_SESSAPP_EVT = 'pn:show-sessapp';
/** 탭에 걸 이름 — 하나면 그 앱 이름, 여럿이면 «앱 n개». 부품이 서기 전(탭을 한 번도 안 켰을 때)에도 이름이 맞게 셸이 건다. */
export function sessAppTabTitle(apps: ReadonlyArray<{ title: string }>): string {
  return apps.length === 1 ? apps[0].title : `앱 ${apps.length}개`;
}
/** 붙은 앱 하나의 앱 아이콘 이름 — 앱 찾기 · [이 세션에 붙이기] 목록과 **같은 그림 · 같은 색**(glass-icon builtinAppIcon). */
export const sessAppFace = (a: { app_id: string; has_ui: boolean }): string => builtinAppIcon(a.app_id, a.has_ui);
/** 탭에 걸 얼굴 — 하나면 그 앱의 아이콘, 여럿이면 null(«앱 n개» 는 어느 한 앱이 아니다 → 종류의 기본 그림). 이름과 같은 때에 셸이 건다. */
export function sessAppTabFace(apps: ReadonlyArray<{ app_id: string; has_ui: boolean }>): string | null {
  return apps.length === 1 ? sessAppFace(apps[0]) : null;
}
/** 앱 아이콘의 선 그림을 그 앱 색으로(머리줄 · 앱이 둘 이상일 때의 안쪽 탭). */
function faceIcon(a: { app_id: string; has_ui: boolean }, cls: string): SVGElement {
  const face = sessAppFace(a);
  const svg = pnIcon(appGlyphName(face), cls);
  svg.setAttribute('style', `color: var(--gi-c-${face})`);
  return svg;
}

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

/** 같은 앱이라도 **보이는 재료**가 바뀌었나 — 판 번호 · 원본 덮어씀 · 쓸 수 있음 · 이름(#4600). id 만 비교하면 앱을 고쳐 판이 올라도 머리줄이 옛 판을 보인다. 순수. */
export function attachedSignature(rows: ReadonlyArray<AttachedApp>): string {
  return rows.map((a) => `${a.app_id}@${a.version_no ?? ''}:${a.overrides_builtin ? 1 : 0}:${a.usable ? 1 : 0}:${a.title}`).join('|');
}

export function refreshSessionApps(sid: string): void {
  const e = entries.get(sid);
  if (!e) return;
  const mine = ++e.seq;
  void listAttached(sid).then((rows) => {
    if (mine !== e.seq || entries.get(sid) !== e) return;          // 늦게 온 판 · 구독이 다 끊긴 뒤의 판
    const d = attachedDiff(e.apps ? e.apps.map((a) => a.app_id) : null, rows.map((a) => a.app_id));
    //  #4600 — id 는 그대로인데 판·이름이 바뀐 경우(app_save · app_revert 뒤)도 다시 그린다. «새로 붙음»(added)은 아니라 탭을 켜지 않는다.
    const redrawn = !!e.apps && attachedSignature(e.apps) !== attachedSignature(rows);
    e.apps = rows;
    if (!d.changed && !redrawn) return;
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
  //  #4600 머리줄 — 앱 이름 · 판 · ⋯ 메뉴(AI에게 고치기 · 표시 설정 · 판 이력 · 원본으로 · 크게 보기 · 떼기). 앱이 하나여도 선다 —
  //   «이 앱은 고칠 수 있다» 를 알려 주는 자리가 이것뿐이다(기획안 2판 05절 F).
  const head = el('div', { class: 'pn-sessapp-head', hidden: true });
  //  방금 고침 띠 — 'updated' 사건 뒤 60초. 「되돌리기」 = 바로 앞 판으로.
  const band = el('div', { class: 'pn-sessapp-band', hidden: true });
  const body = el('div', { class: 'pn-sessapp-body' });
  root.append(tabs, head, band, body);
  let bandTimer = 0;
  //  되돌리기(메뉴·띠)로 **이 화면이 이미 다시 띄운** 판 번호 — 뒤따라 오는 'updated' 사건이 같은 번호면 다시 띄우지 않는다(두 번 깜빡이지 않게).
  let reloadedFor: number | null = null;

  let sid: string | null = null;
  let apps: AttachedApp[] = [];
  const pick = new Map<string, string>();       // 세션 → 고른 앱(여럿 붙었을 때)
  let mounted: { sid: string; appId: string; frame: AppUiFrame | null } | null = null;
  let mountSeq = 0;
  let reloadTimer = 0;
  let off: (() => void) | null = null;

  //  #4592 곁칸 아래 독이 이 칸의 바닥을 가리는 폭 — 독이 곁칸(section.pn-pane)에 --pn-dock-* 로 적는다(pane-dock applyInset).
  //   다른 부품은 CSS 가 스크롤 끝에 빈 자리를 두어 비키지만(42-v2-panes), 앱은 샌드박스 프레임이라 그 변수가 안 넘어간다 → 프레임에 알린다.
  //   앱은 바닥 막대와 스크롤 끝을 그만큼 올린다(화면은 독 유리 밑까지 흐른다 — 10-02 «액자는 독이 그 위에 뜬다» 를 지키면서 단추만 안 가린다).
  const paneEl = (): HTMLElement | null => root.closest('.pn-pane') as HTMLElement | null;
  const readInsets = (): { top: number; right: number; bottom: number; left: number } => {
    const p = paneEl(); const z = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!p) return z;
    const cs = getComputedStyle(p); const px = (k: string): number => parseFloat(cs.getPropertyValue(k)) || 0;
    return { top: px('--pn-dock-t'), right: px('--pn-dock-r'), bottom: px('--pn-dock-b'), left: px('--pn-dock-l') };
  };
  const pushInsets = (): void => { mounted?.frame?.setInsets(readInsets()); };
  let insetObs: MutationObserver | null = null;
  let insetOn: HTMLElement | null = null;
  const watchInsets = (): void => {
    const p = paneEl();
    if (p === insetOn) return;                      // 같은 칸이면 그대로(탭을 다른 칸으로 옮기면 다시 건다)
    insetObs?.disconnect(); insetObs = null; insetOn = p;
    if (!p || typeof MutationObserver === 'undefined') return;
    insetObs = new MutationObserver(pushInsets);
    insetObs.observe(p, { attributes: true, attributeFilter: ['style'] });
  };
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
      watchInsets(); pushInsets();
    } catch (e: any) {
      if (mine !== mountSeq) return;
      mounted = null;
      body.replaceChildren(el('div', { class: 'pn-empty' }, el('b', { text: '앱 화면을 열지 못했어요.' }),
        el('p', { class: 'pn-fine', text: String(e && e.message ? e.message : e) })));
    }
  }

  //  되돌린 직후 — 서버 사건을 기다리지 않고 그 자리에서 다시 띄운다(스트림이 없는 게이트웨이도 있다). 번호를 적어 두어 사건이 겹쳐 와도 한 번만.
  const afterRevert = (versionNo: number): void => {
    reloadedFor = versionNo;
    mounted?.frame?.reload();
  };

  function openMenu(cur: AttachedApp, x: number, y: number): void {
    const s = sid;
    if (!s) return;
    const frame = mounted && mounted.appId === cur.app_id ? mounted.frame : null;
    //  표시 설정은 앱이 **받겠다고 구독**했을 때만(SDK lively.ui.onPrefsOpen → ui/subscribe {topic:'prefs-open'}). 안 했으면 보내 봐야 받을 곳이 없다.
    const hasPrefs = !!frame && frame.subscribed('prefs-open');
    const rows = sessAppMenuRows({ title: cur.title, hasPrefs, overridesBuiltin: !!cur.overrides_builtin, versionNo: cur.version_no ?? null }, {
      edit: () => { composeDraft(s, draftTextFor(cur.title)); toast('세션 입력칸에 채워 두었어요 — 어떻게 고칠지 이어서 적고 보내세요.'); },
      prefs: () => { frame?.notify('ui/notifications/prefs-open', {}); },
      versions: () => { void openVersionsMenu(x, y, { id: cur.app_id, title: cur.title }, afterRevert); },
      original: () => { void revertToOrigin(cur.app_id, cur.title).then((v) => { if (v != null) afterRevert(v); }); },
      big: () => { void openAppUi(cur.app_id, { title: cur.title, sessionId: s, page: cur.pages[0]?.key }); },
      detach: () => { void detachAppFromSession(s, cur.app_id).then((ok) => { if (ok) toast(`「${cur.title}」을(를) 이 세션에서 뗐어요 — 앱의 데이터는 그대로 남아요.`); }); },
    });
    ctxMenu(x, y, rows, { title: cur.title, sub: cur.version_no ? `${cur.version_no}판 · 이 세션에 붙음` : '이 세션에 붙음', minWidth: 220 });
  }

  function paintHead(cur: AttachedApp | null): void {
    head.hidden = !cur;
    if (!cur) { head.replaceChildren(); return; }
    const more = el('button', { class: 'pn-sessapp-more', type: 'button', title: '이 앱 — 고치기 · 판 이력 · 크게 보기', 'aria-label': `「${cur.title}」 메뉴`,
      onclick: (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(cur, r.right, r.bottom + 4); } }, pnIcon('more', 'pn-i sm'));
    head.replaceChildren(
      faceIcon(cur, 'pn-i sm'),
      el('b', { class: 'pn-sessapp-title ell', text: cur.title }),
      ...(cur.version_no ? [el('span', { class: 'pn-sessapp-ver', text: `${cur.version_no}판` })] : []),
      el('span', { class: 'pn-sp' }),
      more);
    //  우클릭도 같은 메뉴 — 머리줄 어디서든.
    head.oncontextmenu = (e: MouseEvent) => { e.preventDefault(); openMenu(cur, e.clientX, e.clientY); };
  }

  function showBand(cur: AttachedApp, ev: { version_no?: number; note?: string }): void {
    if (bandTimer) { window.clearTimeout(bandTimer); bandTimer = 0; }
    band.hidden = false;
    band.replaceChildren(
      el('span', { class: 'pn-sessapp-band-t ell', text: bandText(ev) }),
      el('button', { class: 'pn-sessapp-band-b', type: 'button', text: '되돌리기', onclick: () => { void revertToPrevious(cur.app_id, cur.title).then((v) => { if (v != null) afterRevert(v); }); } }),
      el('button', { class: 'pn-sessapp-band-x', type: 'button', 'aria-label': '닫기', onclick: () => { band.hidden = true; } }, pnIcon('x', 'pn-i sm')));
    bandTimer = window.setTimeout(() => { bandTimer = 0; band.hidden = true; }, 60_000);
  }

  function paint(): void {
    const cur = current();
    ctx.setTabTitle?.(cur ? cur.title : null);
    ctx.setTabFace?.(cur ? sessAppFace(cur) : null);
    paintHead(cur);
    tabs.hidden = apps.length < 2;
    tabs.replaceChildren(...(apps.length < 2 ? [] : apps.map((a) => el('button', {
      class: 'pn-sessapp-tab' + (cur && a.app_id === cur.app_id ? ' on' : ''), type: 'button', role: 'tab',
      'aria-selected': cur && a.app_id === cur.app_id ? 'true' : 'false', title: a.title,
      onclick: () => { if (sid) { pick.set(sid, a.app_id); paint(); } },
    }, faceIcon(a, 'pn-i sm'), el('span', { text: a.title })))));
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
    //  #4600 앱 자체가 새 판으로 바뀌었다(app_save · app_revert) — 그 화면을 다시 띄우고 띠를 세운다. 데이터가 아니라 **코드**가 바뀐 것이라
    //   앱의 onChange 구독과 무관하게 늘 다시 띄운다(옛 코드가 새 표를 모를 수 있다). 쓰던 문서·판·고치던 줄은 데이터라 그대로다.
    if (ev.kind === 'updated') {
      const m = mounted;
      if (!m || !m.frame || ev.app_id !== m.appId) return;
      //  내가 방금 되돌려 이미 다시 띄운 판이면(afterRevert) 건너뛴다 — 같은 화면을 두 번 띄워 깜빡이지 않게. 번호를 모르는 사건은 늘 다시 띄운다.
      if (ev.version_no == null || ev.version_no !== reloadedFor) m.frame.reload();
      reloadedFor = null;
      const cur = current();
      if (cur && cur.app_id === ev.app_id) showBand(cur, ev);
      return;
    }
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
  //  곁칸 [앱]에서 이미 붙은 앱을 다시 눌렀다 — 그 앱을 앞에 세운다(탭을 켜는 것은 셸이 같은 신호로 한다).
  const onShow = (e: Event): void => {
    const id = String((e as CustomEvent<{ app_id?: string }>).detail?.app_id || '');
    if (!id || !sid) return;
    pick.set(sid, id);
    paint();
  };
  ctx.paneRoot().addEventListener(SHOW_SESSAPP_EVT, onShow);
  follow(ctx.curSession());

  return {
    root,
    destroy: () => { off?.(); off = null; offLive(); offSess(); ctx.paneRoot().removeEventListener(SHOW_SESSAPP_EVT, onShow); if (bandTimer) window.clearTimeout(bandTimer); insetObs?.disconnect(); insetObs = null; unmount(); },
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

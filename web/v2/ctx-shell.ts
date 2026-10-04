// v2/ctx-shell.ts — 셸이 아는 것들의 우클릭 메뉴(#3784): 세션 · 프로젝트 · 열린 앱 행 · 앱 · 알림 · 위키 분류 ·
//  프로젝트 리스트/폴더 · 홈/확인할 것/셸 표면 · 어디서나 붙는 공통 행(선택한 글·링크·그림·이 화면 주소).
//  화면(views·side·panes)은 표(data-ctx)만 달고, 여기가 그 표를 읽어 행을 만든다. 조작의 실체는 각자 사는 곳에 둔다 —
//  세션·프로젝트 조작은 side.ts(sessionCtxRows·projectCtxRows), 항해는 main.ts 가 hooks 로 준다.
import { state, toast } from '../core.js';
import { copyText, type CtxRow } from './ctx-menu.js';
import { registerCtx, registerCtxCommon, registerCtxSurface, type CtxEvent, type CtxHit } from './ctx-registry.js';
import { isInstancePinned, listFavCtxRow, projectCtxRows, sessText, sessionCtxRows, sideInstanceById, toggleInstancePin } from './side.js';
import { canMoveSess, findSessIn, isInvitedSess, isLiveSess, isMineSess, projName, type Proj, type Sess, type V2Data } from './views.js';
import { forkableHarness } from './session-fork.js';
import { SESS_STATES } from '../session-status.js';
import { omniAvailable, omniOpen } from './omni.js';
import { forwardOmniToShell } from './omni-frame.js';   // #4530 액자(클래식 iframe) 안이면 셸에 부탁한다
import { isMacPlatform } from '../lib/finder-keys.js';
import { omniKeyHint } from '../lib/omni-chord.js';
import { appByKey, appHref, openLaunchpad, soloSessionUrl } from './apps.js';
import { openSharePopover, shareSessOf } from './share-session.js';
import { markNotificationsRead } from './notifications.js';

// ── 통합검색 열기 (#4530) ──
//  셸 문서면 바로 연다. 액자(클래식 ?embed=1) 문서는 같은 메뉴를 쓰지만 통합검색 훅이 없다 — 종전엔 «「…」 검색» 을 눌러도
//  아무 일이 없었다(점검 5번). 그때는 바깥 셸에 부탁한다(OMNI_MSG + seed).
function openSearch(seed?: string): void {
  if (omniAvailable()) omniOpen(seed);
  else forwardOmniToShell(seed);
}
/** 메뉴에 적는 단축키 이름 — 사이드바 검색 단추와 같은 이름(맥 ⌘K · 그 밖 Alt K). 종전엔 윈도우에서도 «⌘K» 였다. */
const omniHint = (): string => omniKeyHint(isMacPlatform());

export interface CtxShellHooks {
  data(): V2Data;
  /** 해시 주소로 간다. newTab 이면 새 셸 탭(⌥클릭과 같다). */
  openRoute(href: string, newTab?: boolean): void;
  /** [새 작업] — 늘 새 탭에 홈. seed 가 있으면 그 글을 입력칸에 담아 둔다(보내지는 않는다). */
  newTask(seed?: string): void;
  refresh(): void;
  pickProject(anchor: HTMLElement, sessionId: string): void;
  /** 세션 복제(#4135) — 그 세션의 대화를 아는 새 세션을 하나 더. 확인 창은 anchor 옆에 선다. */
  forkSession(anchor: HTMLElement, sessionId: string): void;
  closeInstance(id: string): void;
  activateInstance(id: string, route?: string): void;
  /** 지금 활성 탭의 주소(같은 화면이면 「열기」를 안 띄운다). */
  currentRoute(): string;
}

let hooks: CtxShellHooks | null = null;
const absUrl = (href: string): string => { try { return new URL(href, location.href).toString(); } catch (_) { return href; } };
const copyRow = (label: string, text: string, done = '복사했어요'): CtxRow => ({ label, icon: 'copy', run: () => { void copyText(text).then((ok) => { if (ok) toast(done); }); } });
const sameRoute = (href: string): boolean => { const cur = hooks?.currentRoute() || ''; return cur === href || cur.split('?')[0] === href.split('?')[0]; };

/** 「열기 / 새 탭에서 열기」 한 쌍 — 어느 항목이든 앞머리에 서는 항해 행. 지금 보고 있는 화면이면 「열기」는 뺀다. */
function openRows(href: string, o: { label?: string } = {}): CtxRow[] {
  const rows: CtxRow[] = [];
  if (!sameRoute(href)) rows.push({ label: o.label || '열기', icon: 'open', run: () => hooks?.openRoute(href) });
  rows.push({ label: '새 탭에서 열기', icon: 'columns', hint: '⌥클릭', run: () => hooks?.openRoute(href, true) });
  return rows;
}

/**
 * 이 세션을 복제할 수 있나(#4135) — 문패 단추와 우클릭 메뉴가 **같은 이 판정**을 쓴다.
 *  내 세션(대화 기록이 만든 사람 자리에 있다) · 살아 있음(지난 세션은 「이어서 열기」 가 먼저다) · 복제 수단이 있는 AI.
 *  ⚠ 화면의 판정은 단추를 달지 말지일 뿐이다 — 최종 판정은 서버가 한다(session-fork.forkRefusal).
 */
export function canForkSess(s: Sess): boolean {
  //  ⚠ «내 세션» 을 [세션 옮기기] 보다 **좁게** 본다: 만든 사람이 적혀 있으면 그 값이 나와 같을 때만.
  //   `owned` 는 관리 권한이 있는 사람에게도 참이라(스테이지 실측 — 다른 사람 세션에도 단추가 섰다), 그대로 쓰면
  //   누르면 반드시 거절되는 단추가 선다. 복제는 대화 기록을 읽어야 해서 만든 사람 본인만 된다.
  const me = String((state.me && (state.me as { userId?: string }).userId) || '');
  const owner = String((s.raw && s.raw.owner) || '');
  const mine = owner && me ? owner === me : isMineSess(s);
  //  #3870 — 초대받은 사람도 복제한다(원준 2026-09-30 «둘 다 되게»). 복제본은 **주인 이름으로** 뜨고 초대 명단을 물려받는다
  //   (서버 session-fork ForkFacts.invited 머리말). 관리자라도 초대받지 않았으면 여전히 안 선다(owned 를 안 쓰는 이유 그대로).
  const invited = !mine && isInvitedSess(s);
  //  앱으로 연 세션은 서버가 거절한다 — 누르면 반드시 실패하는 단추를 세우지 않는다.
  const app = !!(s.raw && (s.raw.appId || s.raw.app_id));
  return (mine || invited) && !app && isLiveSess(s) && forkableHarness(s.raw && s.raw.harness);
}

// ── 세션 ───────────────────────────────────────────────────────────────────
function sessionMenu(s: Sess | undefined, sid: string, hit: CtxHit): { rows: CtxRow[]; title?: string; sub?: string } {
  const href = '#/s/' + encodeURIComponent(sid);
  if (!s) return { rows: [...openRows(href), { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: '세션', sub: sid };
  const data = hooks?.data();
  const pn = data ? projName(data, s.projectId) : '';
  const text = sessText(s, pn);
  const st = SESS_STATES[s.stateKey];
  const rows: CtxRow[] = [
    ...openRows(href),
    { label: '새 창으로 열기', icon: 'window', hint: '이 세션만', run: () => { window.open(soloSessionUrl(s.id), '_blank', 'noopener'); } },
    { sep: true, label: '' },
    ...sessionCtxRows(s, { nameEl: hit.el.classList.contains('v2-ss-row') ? hit.el.querySelector<HTMLElement>('.t') : null, projectName: pn }),
  ];
  if (canForkSess(s)) rows.push({ label: '세션 복제', icon: 'copy', hint: '대화를 아는 새 세션', run: () => hooks?.forkSession(hit.el, s.id) });
  if (canMoveSess(s)) rows.push({ label: s.projectId ? '프로젝트 바꾸기·떼기' : '프로젝트 연결', icon: 'sessMove', hint: s.projectId ? pn : undefined, run: () => hooks?.pickProject(hit.el, s.id) });
  const share = shareSessOf(s);
  if (share) rows.push({ label: '공유…', icon: 'share', run: () => openSharePopover(hit.el, share) });
  rows.push({ sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요'));
  return { rows, title: text.main || s.label || s.id, sub: [st ? st.label : s.stateLabel, s.projectId ? pn : '프로젝트 없음', isLiveSess(s) ? '' : '지난 세션'].filter(Boolean).join(' · ') };
}

// ── 프로젝트 ────────────────────────────────────────────────────────────────
function projectMenu(p: Proj | undefined, pid: number): { rows: CtxRow[]; title?: string; sub?: string } {
  const href = '#/p/' + pid;
  const board = '#/projects2/p/' + pid;
  const rows: CtxRow[] = [...openRows(href), { label: '보드로 열기', icon: 'board', hint: '할 일·상세', run: () => hooks?.openRoute(board) }];
  if (p) rows.push({ sep: true, label: '' }, ...projectCtxRows(p));
  rows.push({ sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요'));
  return { rows, title: p ? p.name : '프로젝트 #' + pid, sub: p ? (p.status_category === 'done' ? '끝남' : p.status_category === 'unstarted' ? '시작 전' : '진행 중') : undefined };
}

export function mountCtxShell(h: CtxShellHooks): void {
  hooks = h;
  const data = (): V2Data => h.data();
  const findSess = (id: string): Sess | undefined => findSessIn(data().sessions, id);
  const findProj = (id: number): Proj | undefined => data().projects.find((x) => Number(x.id) === id);

  registerCtx('session', (hit) => { const sid = String(hit.data.sid || ''); if (!sid) return null; return sessionMenu(findSess(sid), sid, hit); });
  registerCtx('project', (hit) => { const pid = Number(hit.data.pid || 0); if (!(pid > 0)) return null; return projectMenu(findProj(pid), pid); });

  // 열린 앱 행(사이드바 홈·AI 세션·확인할 것 세 구역이 한 붓) — 세션 행이면 세션 메뉴 + 이 행의 뜻(고정·닫기).
  registerCtx('inst', (hit) => {
    const id = String(hit.data.instance || '');
    const inst = sideInstanceById(id);
    if (!inst) return null;
    const route = inst.route || '';
    //  세션 행의 id 는 'sess:<박스 id>' (main.ts sideRowKey) — route 는 홈 목록만 채우므로(#2033) id 로 먼저 판정한다.
    //  프리뷰 실측(2026-09-09): route 만 보면 [AI 세션] 구역 행이 세션 메뉴 없이 「열기·고정·닫기」만 떴다.
    const m = /^#\/s\/([^?]+)/.exec(route);
    const sidFromId = id.startsWith('sess:') ? id.slice(5) : '';
    if (m || sidFromId) {
      const sid = m ? decodeURIComponent(m[1]) : sidFromId;
      const sm = sessionMenu(findSess(sid), sid, hit);
      return { ...sm, rows: [...sm.rows, { sep: true, label: '' }, instRows(inst.id, inst)] .flat() };
    }
    const rows: CtxRow[] = [];
    if (route) rows.push(...openRows(route));
    else rows.push({ label: '열기', icon: 'open', run: () => h.activateInstance(inst.id, inst.route) });
    rows.push(...instRows(inst.id, inst));
    if (route) rows.push({ sep: true, label: '' }, copyRow('링크 복사', absUrl(route), '링크를 복사했어요'));
    return { rows, title: inst.title, sub: inst.meta || undefined };
  });
  const instRows = (id: string, inst: { pinned?: boolean; close?: { kind: string; label: string; run: () => void } | null }): CtxRow[] => {
    const rows: CtxRow[] = [];
    const on = isInstancePinned(id) || !!inst.pinned;
    rows.push({ label: on ? '맨 위 고정 해제' : '맨 위에 고정', icon: 'pin', checked: on || undefined, run: () => toggleInstancePin(id) });
    if (inst.close) rows.push({ label: inst.close.label, icon: inst.close.kind === 'trash' ? 'trash' : 'x', danger: inst.close.kind === 'trash', run: () => inst.close!.run() });
    else rows.push({ label: '목록에서 닫기', icon: 'x', run: () => h.closeInstance(id) });
    return rows;
  };

  // 앱(홈 「최근에 연 앱」 · 런치패드 타일)
  registerCtx('app', (hit) => {
    const a = appByKey(String(hit.data.app || ''));
    if (!a) return null;
    const href = appHref(a);
    return { rows: [...openRows(href), { sep: true, label: '' }, { label: '모든 앱', icon: 'apps', run: () => openLaunchpad() }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: a.title, sub: a.desc };
  });

  // 알림 행(확인할 것)
  registerCtx('noti', (hit) => {
    const id = String(hit.data.nid || '');
    const href = (hit.el as HTMLAnchorElement).getAttribute?.('href') || '';
    const unread = hit.el.classList.contains('unread');
    const rows: CtxRow[] = [];
    if (href) rows.push(...openRows(href));
    if (id) rows.push({ label: '읽음으로 표시', icon: 'mailopen', off: !unread, hint: unread ? undefined : '이미 읽음', run: () => {
      void markNotificationsRead([id]).then(() => { hit.el.classList.remove('unread'); hit.el.querySelector('.v2-noti-dot')?.classList.remove('on'); h.refresh(); });
    } });
    rows.push({ label: '모두 읽음으로', icon: 'check', run: () => { void markNotificationsRead().then(() => h.refresh()); } });
    return { rows, title: hit.el.querySelector('.t')?.textContent || '알림' };
  });

  // 위키 분류(사이드바) · 프로젝트 리스트/폴더(사이드바 트리)
  registerCtx('wikicat', (hit) => {
    const id = String(hit.data.cat || '');
    const href = '#/knowledge?category=' + encodeURIComponent(id);
    return { rows: [...openRows(href), { label: '이 분류에 새 문서', icon: 'plus', run: () => h.openRoute('#/knowledge/new?category=' + encodeURIComponent(id)) },
      { label: '분류체계에서 열기', icon: 'tags', run: () => h.openRoute('#/taxonomy/' + encodeURIComponent(id)) }, { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '분류') };
  });
  registerCtx('plist', (hit) => {
    const href = '#/projects2/l/' + String(hit.data.lid || '');
    const fav = listFavCtxRow(Number(hit.data.lid));   // #3870 — 그 줄에서 바로 즐겨찾기에 넣고 뺀다(모르면 행 없음)
    return { rows: [...openRows(href), ...(fav ? [fav] : []), { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '리스트'), sub: '리스트' };
  });
  registerCtx('pfolder', (hit) => {
    const href = '#/projects2/f/' + String(hit.data.fid || '');
    return { rows: [...openRows(href), { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '폴더'), sub: '폴더' };
  });

  // ── 표면 — 빈 자리 ─────────────────────────────────────────────────────
  registerCtxSurface('home', () => [
    { label: '새 작업', icon: 'plus', hint: '새 탭', run: () => h.newTask() },
    { label: '모든 앱', icon: 'apps', run: () => openLaunchpad() },
    { label: '통합검색', icon: 'search', hint: omniHint(), run: () => openSearch() },
  ]);
  registerCtxSurface('inbox', () => [
    { label: '모두 읽음으로', icon: 'check', run: () => { void markNotificationsRead().then(() => h.refresh()); } },
    { label: '새로고침', icon: 'refresh', run: () => h.refresh() },
  ]);
  registerCtxSurface('shell', () => [
    { label: '새 작업', icon: 'plus', hint: '새 탭', run: () => h.newTask() },
    { label: '통합검색', icon: 'search', hint: omniHint(), run: () => openSearch() },
    { label: '새로고침', icon: 'refresh', run: () => h.refresh() },
  ]);

  // ── 공통 — 어디서나 맨 아래 ────────────────────────────────────────────
  registerCtxCommon((ev: CtxEvent) => commonRows(ev, h));
}

/** 선택한 글 · 링크 · 그림 · 이 화면 주소. 클래식 판(iframe 안)도 같은 함수를 쓴다(open 만 다르게). */
export function commonRows(ev: CtxEvent, o: { openRoute(href: string, newTab?: boolean): void; newTask?(seed?: string): void }): CtxRow[] {
  const rows: CtxRow[] = [];
  const sel = ev.selection;
  if (sel) {
    const short = sel.length > 24 ? sel.slice(0, 24) + '…' : sel;
    rows.push(copyRow('복사', sel, '복사했어요'));
    rows.push({ label: `「${short}」 검색`, icon: 'search', run: () => openSearch(sel) });
    if (o.newTask) rows.push({ label: '이 글로 새 작업', icon: 'bolt', hint: '홈 입력칸에', run: () => o.newTask!(sel) });
  }
  const a = ev.link;
  if (a) {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#/')) rows.push({ label: '새 탭에서 열기', icon: 'columns', hint: '⌥클릭', run: () => o.openRoute(href, true) });
    else if (/^https?:/i.test(href) || href.startsWith('/')) rows.push({ label: '새 창에서 열기', icon: 'open', run: () => window.open(href, '_blank', 'noopener') });
    if (href && !href.startsWith('javascript:')) rows.push(copyRow('링크 주소 복사', absUrl(href), '링크를 복사했어요'));
  }
  const img = ev.img;
  if (img && img.currentSrc && !img.currentSrc.startsWith('data:')) {
    rows.push({ label: '그림 새 창에서 열기', icon: 'open', run: () => window.open(img.currentSrc, '_blank', 'noopener') });
    rows.push(copyRow('그림 주소 복사', img.currentSrc, '주소를 복사했어요'));
  }
  if (rows.length) rows.push({ sep: true, label: '' });
  rows.push(copyRow('이 화면 주소 복사', location.href, '주소를 복사했어요'));
  return rows;
}

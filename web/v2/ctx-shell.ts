// v2/ctx-shell.ts — 셸이 아는 것들의 우클릭 메뉴(#3784): 세션 · 프로젝트 · 열린 앱 행 · 앱 · 알림 · 위키 분류 ·
//  프로젝트 리스트/폴더 · 홈/확인할 것/셸 표면 · 어디서나 붙는 공통 행(선택한 글·링크·그림·이 화면 주소).
//  화면(views·side·panes)은 표(data-ctx)만 달고, 여기가 그 표를 읽어 행을 만든다. 조작의 실체는 각자 사는 곳에 둔다 —
//  세션·프로젝트 조작은 side.ts(sessionCtxRows·projectCtxRows), 항해는 main.ts 가 hooks 로 준다.
import { toast } from '../core.js';
import { copyText, type CtxRow } from './ctx-menu.js';
import { registerCtx, registerCtxCommon, registerCtxSurface, type CtxEvent, type CtxHit } from './ctx-registry.js';
import { isInstancePinned, projectCtxRows, sessText, sessionCtxRows, sideInstanceById, toggleInstancePin } from './side.js';
import { findSessIn, isLiveSess, isMineSess, projName, type Proj, type Sess, type V2Data } from './views.js';
import { SESS_STATES } from '../session-status.js';
import { omniOpen } from './omni.js';
import { appByKey, appHref, openLaunchpad, soloSessionUrl } from './apps.js';
import { openSharePopover, shareSessOf } from './share-session.js';
import { markNotificationsRead } from './notifications.js';

export interface CtxShellHooks {
  data(): V2Data;
  /** 해시 주소로 간다. newTab 이면 새 셸 탭(⌥클릭과 같다). */
  openRoute(href: string, newTab?: boolean): void;
  /** [새 작업] — 늘 새 탭에 홈. seed 가 있으면 그 글을 입력칸에 담아 둔다(보내지는 않는다). */
  newTask(seed?: string): void;
  refresh(): void;
  pickProject(anchor: HTMLElement, sessionId: string): void;
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
  if (isMineSess(s)) rows.push({ label: s.projectId ? '프로젝트 바꾸기·떼기' : '프로젝트 연결', icon: 'moveto', hint: s.projectId ? pn : undefined, run: () => hooks?.pickProject(hit.el, s.id) });
  const share = shareSessOf(s);
  if (share) rows.push({ label: '공유…', icon: 'share', run: () => openSharePopover(hit.el, share) });
  rows.push({ sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요'));
  return { rows, title: text.main || s.label || s.id, sub: [st ? st.label : s.stateLabel, s.projectId ? pn : '프로젝트 없음', isLiveSess(s) ? '' : '지난 세션'].filter(Boolean).join(' · ') };
}

// ── 프로젝트 ────────────────────────────────────────────────────────────────
function projectMenu(p: Proj | undefined, pid: number): { rows: CtxRow[]; title?: string; sub?: string } {
  const href = '#/p/' + pid;
  const board = '#/projects2/p/' + pid;
  const rows: CtxRow[] = [...openRows(href), { label: '보드로 열기', icon: 'proj', hint: '할 일·상세', run: () => hooks?.openRoute(board) }];
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
    return { rows: [...openRows(href), { label: '이 분류에 새 문서', icon: 'plus', run: () => h.openRoute('#/knowledge/new?category=' + encodeURIComponent(id)) }, { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '분류') };
  });
  registerCtx('plist', (hit) => {
    const href = '#/projects2/l/' + String(hit.data.lid || '');
    return { rows: [...openRows(href), { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '리스트'), sub: '리스트' };
  });
  registerCtx('pfolder', (hit) => {
    const href = '#/projects2/f/' + String(hit.data.fid || '');
    return { rows: [...openRows(href), { sep: true, label: '' }, copyRow('링크 복사', absUrl(href), '링크를 복사했어요')], title: String(hit.data.name || '폴더'), sub: '폴더' };
  });

  // ── 표면 — 빈 자리 ─────────────────────────────────────────────────────
  registerCtxSurface('home', () => [
    { label: '새 작업', icon: 'plus', hint: '새 탭', run: () => h.newTask() },
    { label: '모든 앱', icon: 'apps', run: () => openLaunchpad() },
    { label: '통합검색', icon: 'search', hint: '⌘K', run: () => omniOpen() },
  ]);
  registerCtxSurface('inbox', () => [
    { label: '모두 읽음으로', icon: 'check', run: () => { void markNotificationsRead().then(() => h.refresh()); } },
    { label: '새로고침', icon: 'refresh', run: () => h.refresh() },
  ]);
  registerCtxSurface('shell', () => [
    { label: '새 작업', icon: 'plus', hint: '새 탭', run: () => h.newTask() },
    { label: '통합검색', icon: 'search', hint: '⌘K', run: () => omniOpen() },
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
    rows.push({ label: `「${short}」 검색`, icon: 'search', hint: '⌘K', run: () => omniOpen(sel) });
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

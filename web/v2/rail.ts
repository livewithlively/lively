// v2/rail.ts — 좌측 끝 **레일**(#2016, 원준 2026-08-26 "안 1 · 슬랙 그대로" → 2차 "슬랙 다시 보고" → 3차 "숨김 = B안").
//
//  슬랙 데스크톱 좌측 탭 레일을 그대로 옮긴다(헬프센터 스크린샷 2장 + 원준님 스크린샷으로 대조):
//   ⓪ 워크스페이스 — **타일 한 장 + 뒤에 겹친 타일**(스택). 누르면 슬랙과 같은 흰 팝오버:
//      [아이콘 · 이름 · 부제] 목록(지금 것은 고리) · ＋ 워크스페이스 추가 · 「레일 숨기기/펼치기」(패널 아이콘).
//   ① 구역 — 홈 · 확인할 것(배지) · AI 세션 · 프로젝트 · 위키 · 리브. 슬랙의 홈·DM·내 활동·나중에 자리.
//      고른 구역이 곧 **사이드바의 내용**이다(side.ts). 리브만 구역이 아니라 '갈 곳'이다 — 리브 화면은
//      대화 한 장이라 사이드바가 바뀔 이유가 없다(활성 표시는 주소로 판정).
//   ② 최근 연 앱 — 헤어라인 아래. 맥 독의 '최근 사용' 구간. 5차: 꾹 눌러 위로 끌어 올리면 ①에 고정되고, ①은 끌어서 순서를 바꾼다.
//   ③ 발치 — 앱(런치패드) · 나(내 프로필·환경설정 #1843). 슬랙의 ＋ · 아바타 자리.
//
//  ⚠ 레일 폭은 **68px 고정**이다(원준 3차: "가로 늘리면 UI 바뀌는 거 없이 폭 고정"). 종전의 232px 펼침 모드는
//   걷었다 — 상태는 **보임 / 숨김** 둘뿐. 숨기면 레일이 들고 있던 워크스페이스·구역·앱·나가 사이드바 머리와
//   발치로 들어간다(side.ts wsHead·secFoot — 안 B '머리글 드롭다운'). 되살리는 길은 셋: 사이드바 맨 윗줄
//   왼쪽 패널 단추 · 워크스페이스 팝오버 마지막 행 · ⌘⇧S.
//
//  ⚠ 구역은 **사람이 고를 때만** 바뀐다. 주소를 따라 저절로 바꾸면, 홈 목록에서 세션 하나를 여는 순간
//   사이드바가 통째로 [AI 세션]으로 갈아엎여 방금 보던 목록이 사라진다. 슬랙도 DM 탭에서 대화를 열어도
//   탭은 DM 에 머문다. 그래서 구역은 이 모듈의 상태이고 브라우저에 기억한다.
import { el, navOn, profileAvatar, state, toast } from '../core.js';
import { APPS, openLaunchpad, type AppDef } from './apps.js';
import { icon } from './icons.js';
import { openMeModal } from './me-modal.js';
import { ctxMenu } from './panes-kit.js';   // 우클릭 메뉴 — 곁칸·프로젝트 행과 같은 부품
import { activeWorkspaceSlug, listWorkspaces, openWorkspaceMenu, switchWorkspace, workspaceInfo } from './switcher.js';

export type RailSection = 'home' | 'inbox' | 'sess' | 'proj' | 'wiki';

export interface RailHooks {
  /** 배지·개수 — 확인할 것 · 작업 중 세션 · 진행 중 프로젝트. */
  counts?: () => { inbox: number; busy: number; projects: number };
  /** 지금 열려 있는 앱 키 — 최근 앱 아이콘 아래 '실행 중' 점(맥 독). */
  openApps?: () => Set<string>;
  /** 지금 화면의 활성 키(main.ts activeKey) — 구역이 아닌 '갈 곳'(리브)의 활성 표시에 쓴다. */
  activeKey?: () => string;
  /** 구역이 바뀌었다 — 사이드바를 다시 그리고 그 구역의 첫 화면으로 간다. */
  onSection?: (sec: RailSection, opts: { navigate: boolean }) => void;
  /** 레일을 숨기거나 되살렸다 — 사이드바도 같이 다시 그린다(숨김에만 머리·발치에 워크스페이스·구역·앱·나가 선다). */
  onLayout?: () => void;
}

// ── 구역 표 ──────────────────────────────────────────────────────────────────
//  ⚠ 구역의 **착지 주소는 여기 없다** — 셸(main.ts sectionRoute)이 정한다. [프로젝트]처럼 착지가 그때그때
//   달라지는 구역이 있어서다(#2061 즐겨찾기 맨 위 리스트). 여기 표에 route 를 되살리면 규칙이 둘이 된다.
export interface SecDef { key: RailSection; label: string; tab: string | null; icon: string }
const SECTIONS: SecDef[] = [
  { key: 'home', label: '홈', tab: null, icon: 'home' },
  { key: 'inbox', label: '확인할 것', tab: null, icon: 'inbox' },
  { key: 'sess', label: 'AI 세션', tab: 'terminal', icon: 'term' },
  { key: 'proj', label: '프로젝트', tab: 'projects2', icon: 'proj' },
  { key: 'wiki', label: '위키', tab: 'knowledge', icon: 'wiki' },
];
//  구역이 아닌 '갈 곳' — 누르면 그 화면으로 가지만 사이드바는 바뀌지 않는다. 활성은 주소(activeKey)로 판정.
interface LinkDef { key: string; label: string; route: string; tab: string | null; icon: string }
const LINKS: LinkDef[] = [
  { key: 'liv', label: '리브', route: '#/liv', tab: 'liv', icon: 'liv' },
];
export function railSections(): SecDef[] { return SECTIONS.filter((s) => !s.tab || navOn(s.tab)); }
export function sectionDef(sec: RailSection): SecDef { return SECTIONS.find((s) => s.key === sec) || SECTIONS[0]; }

// ── 상태 ─────────────────────────────────────────────────────────────────────
const SEC_STORE = 'lively_v2_rail_sec';
const HIDE_STORE = 'lively_v2_rail_hidden';   // ⚠ 이름에 `_KEY` 를 쓰지 않는다 — gitleaks 가 시크릿으로 오인한다(#1954)
const MAIN_STORE = 'lively_v2_rail_main';     // 메인 그룹 순서 — 구역 · 리브 · 독에 고정한 앱을 **한 줄**로(사람이 정한 순서, 5차). 이 기기에 둔다.
const PIN_STORE = 'lively_v2_rail_pins';      // 4차의 기억(고정 앱만 따로) — 5차 첫 로드에 MAIN_STORE 로 옮기고 지운다.
const RECENT_N = 4;
const NARROW_MQ = '(max-width: 900px)';   // mobile.ts MOBILE_MQ 와 같은 값 — 좁은 폭에선 레일이 늘 아이콘으로 선다(47-v2-rail.css)

let section: RailSection = 'home';
let hidden = false;
let host: HTMLElement | null = null;
let hooks: RailHooks = {};
let inited = false;
let spaces: Array<{ slug: string; name: string; kind: string; is_primary?: boolean }> = [];
let order: string[] = [];   // 메인 그룹 — 구역·리브 키와 고정한 앱 키가 섞여 선다(표시 순서 그대로)

function init(): void {
  if (inited) return;
  inited = true;
  order = defaultOrder();
  try {
    const s = localStorage.getItem(SEC_STORE) as RailSection | null;
    if (s && SECTIONS.some((x) => x.key === s)) section = s;
    hidden = localStorage.getItem(HIDE_STORE) === '1';
    const raw = localStorage.getItem(MAIN_STORE);
    if (raw) order = normalizeOrder(JSON.parse(raw));
    else {   // 4차(고정 앱만 따로) → 5차(메인 한 줄): 기본 순서 뒤에 고정했던 앱을 잇는다
      const p = JSON.parse(localStorage.getItem(PIN_STORE) || '[]');
      order = normalizeOrder([...defaultOrder(), ...(Array.isArray(p) ? p : [])]);
      localStorage.removeItem(PIN_STORE);
      if (Array.isArray(p) && p.length) localStorage.setItem(MAIN_STORE, JSON.stringify(order));   // 옮긴 것을 바로 적는다 — 안 적으면 다음 로드에 사라진다
    }
    localStorage.removeItem('lively_v2_rail_open');   // 232px 펼침 모드(2차)의 기억 — 이제 뜻이 없다
  } catch (_) { /* 못 읽어도 홈·보임으로 선다 */ }
  void listWorkspaces().then((rows) => { if (rows.length) { spaces = rows; drawRail(); } });
}

//  ⚠ init() 을 먼저 부른다 — 이 게터는 레일이 그려지기 **전에도** 불린다(부팅 때 탭이 되살아나는 순간 등).
//   그때 기본값 'home' 을 돌려주면 부른 쪽은 '사람이 홈을 골랐다'로 읽는다. 실측(#2061): 위키에서 새로고침했는데
//   되살아난 탭이 홈 자리로 기록돼 [홈] 이 기억하던 세션을 잃었다.
export function railSection(): RailSection { init(); return section; }
/** 레일이 숨겨져 있는가 — 좁은 폭에선 늘 '아니오'(거기선 CSS 가 레일을 아이콘으로 세운다). */
export function railIsHidden(): boolean { return hidden && !window.matchMedia(NARROW_MQ).matches; }

export function setRailSection(sec: RailSection, opts?: { navigate?: boolean }): void {
  if (!SECTIONS.some((s) => s.key === sec)) return;
  const changed = section !== sec;
  section = sec;
  try { localStorage.setItem(SEC_STORE, sec); } catch (_) { /* 이번 화면은 된다 */ }
  drawRail();
  hooks.onSection?.(sec, { navigate: changed || !!(opts && opts.navigate) });
}

export function toggleRail(): void {
  hidden = !hidden;
  try { localStorage.setItem(HIDE_STORE, hidden ? '1' : '0'); } catch (_) { /* 이번 화면은 된다 */ }
  closePopover();
  drawRail();
  hooks.onLayout?.();
}

// ── 최근 앱 — 구역과 겹치는 것은 뺀다(같은 문이 레일에 둘이면 문이 아니라 헷갈림이다). ──
const SEC_APP_KEYS = new Set(['terminal', 'projects2', 'knowledge']);
function recentForRail(n: number): AppDef[] {
  let keys: string[] = [];
  try { const v = JSON.parse(localStorage.getItem('lively_v2_recent_apps') || '[]'); if (Array.isArray(v)) keys = v.filter((x) => typeof x === 'string'); }
  catch (_) { /* 기록이 없으면 표 순서로 채운다 */ }
  const pick: AppDef[] = [];
  const take = (a: AppDef | undefined): void => {
    if (!a || SEC_APP_KEYS.has(a.key) || order.includes(a.key) || pick.some((p) => p.key === a.key)) return;
    if (a.tab && !navOn(a.tab)) return;
    pick.push(a);
  };
  for (const k of keys) { if (pick.length >= n) break; take(APPS.find((a) => a.key === k)); }
  for (const a of APPS) { if (pick.length >= n) break; take(a); }
  return pick.slice(0, n);
}

// ── 워크스페이스 — 스택 타일 + 슬랙식 팝오버 ─────────────────────────────────
function wsTile(w: { name: string; kind: string }, cls: string): HTMLElement {
  const me: any = state.me || {};
  const cur = workspaceInfo();
  //  개인 워크스페이스의 얼굴은 내 아바타(원형) — 지금 것일 때만 계정 아바타를 안다.
  if (w.kind === 'personal' && w.name === cur.name) return profileAvatar(me.avatar, w.name, me.userId, cls + ' round', { char: me.avatar_char, color: me.avatar_color });
  return el('span', { class: cls + (w.kind === 'personal' ? ' round' : ''), text: String(w.name || '?').trim().slice(0, 1) });
}

/** 문패 = 타일 한 장 + 뒤에 겹친 타일(슬랙의 그 스택). 레일 맨 위에도, 레일을 숨겼을 땐 사이드바 머리에도 선다. */
export function stackTile(opts?: { small?: boolean; label?: boolean }): HTMLElement {
  const w = workspaceInfo();
  const kindText = w.kind === 'personal' ? '개인' : '팀';
  return el('button', {
    class: 'v2-rail-stack' + (opts && opts.small ? ' sm' : '') + (opts && opts.label ? ' v2-side-wsbtn' : ''), type: 'button', 'aria-haspopup': 'menu',
    title: `${w.name} · ${kindText} 워크스페이스 — 누르면 전환`,
    onclick: (e: Event) => { e.preventDefault(); if (popEl) closePopover(); else openPopover(e.currentTarget as HTMLElement); },
  },
    el('span', { class: 'v2-rail-stack-t' }, wsTile(w, 'v2-wscard-big')),
    opts && opts.label ? el('span', { class: 'v2-side-wsbtn-n', text: w.name }) : null,
    opts && opts.label ? el('span', { class: 'v2-ws-car', 'aria-hidden': 'true', text: '▾' }) : null);
}

let popEl: HTMLElement | null = null;
function closePopover(): void {
  if (!popEl) return;
  popEl.remove(); popEl = null;
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onDocKey, true);
}
function onDocDown(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  if (popEl && !popEl.contains(t) && !t.closest('.v2-rail-stack') && !t.closest('.v2-secdd')) closePopover();
}
function onDocKey(e: KeyboardEvent): void { if (e.key === 'Escape') closePopover(); }
function place(pop: HTMLElement, anchor: HTMLElement, below: boolean): void {
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.round(below ? Math.max(8, r.left) : r.right + 8) + 'px';
  pop.style.top = Math.round(below ? r.bottom + 6 : Math.max(8, r.top)) + 'px';
  document.body.append(pop);
  popEl = pop;
  window.setTimeout(() => { document.addEventListener('mousedown', onDocDown, true); document.addEventListener('keydown', onDocKey, true); }, 0);
}

/** 슬랙의 워크스페이스 팝오버 — 목록(지금 것은 고리) · ＋ 추가 · 레일 숨기기/펼치기. */
function openPopover(anchor: HTMLElement): void {
  closePopover();
  const cur = workspaceInfo();
  const curSlug = activeWorkspaceSlug();
  const rows: Array<{ slug: string; name: string; kind: string; active: boolean }> = spaces.length
    ? spaces.map((w) => ({ slug: String(w.slug), name: String(w.name || w.slug), kind: String(w.kind || 'team'), active: w.slug === curSlug || (!!w.is_primary && curSlug === 'primary') }))
    : [{ slug: 'primary', name: cur.name, kind: cur.kind, active: true }];
  const pop = el('div', { class: 'v2-wspop', role: 'menu', 'aria-label': '워크스페이스' },
    ...rows.map((w) => el('button', {
      class: 'v2-wspop-row' + (w.active ? ' cur' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(w.active),
      title: w.active ? '지금 이 워크스페이스예요' : `${w.name} 워크스페이스로 전환`,
      onclick: () => { closePopover(); if (!w.active) switchWorkspace(w.slug); },
    },
      wsTile(w, 'v2-wscard-big'),
      el('span', { class: 'v2-wspop-tt' }, el('b', { text: w.name }), el('span', { text: w.kind === 'personal' ? '개인 워크스페이스' : '팀 워크스페이스' })))),
    el('div', { class: 'v2-wspop-hr', role: 'separator' }),
    //  ＋ — 만들기·연결 폼은 종전 메뉴(switcher.ts)가 이미 갖고 있다. 여기서 두 벌 만들지 않고 그 메뉴를 연다.
    el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); openWorkspaceMenu(anchor); } },
      el('span', { class: 'v2-wspop-ic' }, icon('plus')),
      el('span', { class: 'v2-wspop-tt' }, el('b', { text: '워크스페이스 추가' }), el('span', { text: '새로 만들거나 팀에 연결' }))),
    el('div', { class: 'v2-wspop-hr', role: 'separator' }),
    el('button', { class: 'v2-wspop-row', type: 'button', role: 'menuitem', onclick: () => { closePopover(); toggleRail(); } },
      el('span', { class: 'v2-wspop-ic' }, icon('panel')),
      el('span', { class: 'v2-wspop-tt' }, el('b', { text: hidden ? '레일 펼치기' : '레일 숨기기' }), el('span', { text: hidden ? '워크스페이스 · 구역 · 앱 · 나를 왼쪽 끝으로' : '워크스페이스 · 구역 · 앱 · 나를 사이드바로' })),
      el('kbd', { class: 'v2-wspop-k', text: '⌘⇧S' }))) as HTMLElement;
  //  레일에서 열면 오른쪽 옆, 사이드바 머리에서 열면 그 아래(슬랙의 「HonestAI ▾」 메뉴 자리).
  place(pop, anchor, !!anchor.closest('.v2-side'));
}

/** 레일을 숨겼을 때 사이드바 머리의 **구역 드롭다운**(안 B) — 메인 그룹 순서 그대로(구역 · 리브 · 고정한 앱) + 「레일 펼치기」. */
export function openSectionMenu(anchor: HTMLElement): void {
  if (popEl) { closePopover(); return; }
  const c = hooks.counts?.() || { inbox: 0, busy: 0, projects: 0 };
  const ak = hooks.activeKey?.() || '';
  const linkOn = LINKS.find((l) => l.key === ak) || null;
  const row = (key: string, label: string, ic: string, on: boolean, extra: HTMLElement | null, run: () => void): HTMLElement =>
    el('button', { class: 'v2-secdd-row' + (on ? ' on' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(on),
      onclick: () => { closePopover(); run(); } },
      icon(ic, 'v2-ic'), el('span', { class: 'v2-secdd-t', text: label }), extra);
  const pop = el('div', { class: 'v2-secdd-menu', role: 'menu', 'aria-label': '구역' },
    ...mainEntries().map((m) => {
      if (m.kind === 'sec') {
        const s = m.sec;
        const extra = s.key === 'inbox' && c.inbox ? el('span', { class: 'v2-rail-bd', text: String(c.inbox) })
          : s.key === 'sess' && c.busy ? el('span', { class: 'v2-secdd-m', text: `${c.busy} 작업 중` })
          : s.key === 'proj' && c.projects ? el('span', { class: 'v2-secdd-m', text: String(c.projects) }) : null;
        return row(s.key, s.label, s.icon, !linkOn && section === s.key, extra, () => setRailSection(s.key, { navigate: true }));
      }
      if (m.kind === 'link') { const l = m.link; return row(l.key, l.label, l.icon, !!linkOn && linkOn.key === l.key, null, () => { location.hash = l.route; }); }
      const a = m.app;   // 독에 고정한 앱 — 레일이 숨어도 여기서 간다
      return row(a.key, a.title, a.icon, false, null, () => { location.hash = '#/app/' + a.key; });
    }),
    el('div', { class: 'v2-wspop-hr', role: 'separator' }),
    row('rail', '레일 펼치기', 'panel', false, el('kbd', { class: 'v2-wspop-k', text: '⌘⇧S' }), () => toggleRail())) as HTMLElement;
  place(pop, anchor, true);
}

// ── 메인 그룹 순서 · 독 손질(#2016 4차 → 5차, 원준: "꾹 눌러서 끌어당기는 애니메이션 · 위 메인으로 옮기는 느낌 · 메인 순서도") ──
//  맥 독 · iOS 홈 화면의 문법 그대로: **꾹 누르면 들린다**(눌린 채 살짝 작아졌다가 튀어오른다), 끌면 이웃이 비켜서고(FLIP),
//  놓으면 자리로 내려앉는다. 최근 앱을 헤어라인 **위 메인 그룹**으로 끌어 올리면 거기 고정되고, 고정한 앱을 레일 밖
//  (또는 헤어라인 아래)으로 끌어내 놓으면 '퍽' 하고 빠진다. 구역·리브는 순서만 바꿀 수 있다(뺄 수 없다).
//  마우스는 맥 독처럼 끌자마자 들리고, 손가락은 스크롤과 갈라야 하니 꾹 누른 뒤에만 들린다.
//  네이티브 HTML 드래그는 쓰지 않는다 — 그림자를 브라우저가 그려서 들리는 동작·비켜서기·착지를 만들 수 없다.
const HOLD_MS = { mouse: 380, touch: 340 };
const motion = (): boolean => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function defaultOrder(): string[] { return [...SECTIONS.map((s) => s.key), ...LINKS.map((l) => l.key)]; }
function isSecKey(k: string): boolean { return SECTIONS.some((s) => s.key === k) || LINKS.some((l) => l.key === k); }
function canPin(k: string): boolean { return !isSecKey(k) && !SEC_APP_KEYS.has(k) && APPS.some((a) => a.key === k); }
/** 저장된 순서에서 믿을 수 있는 것만 남기고, 표에 새로 생긴 구역은 뒤에 잇는다. */
function normalizeOrder(list: unknown): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  if (Array.isArray(list)) for (const k of list) { if (typeof k === 'string' && !seen.has(k) && (isSecKey(k) || canPin(k))) { seen.add(k); out.push(k); } }
  for (const k of defaultOrder()) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}
function saveOrder(next: string[]): void {
  order = normalizeOrder(next);
  try { localStorage.setItem(MAIN_STORE, JSON.stringify(order)); } catch (_) { /* 이번 화면은 된다 */ }
}
type MainEntry = { key: string } & ({ kind: 'sec'; sec: SecDef } | { kind: 'link'; link: LinkDef } | { kind: 'app'; app: AppDef });
/** 메인 그룹 — 저장된 순서대로, 지금 켜진 것만. */
function mainEntries(): MainEntry[] {
  const out: MainEntry[] = [];
  for (const key of order) {
    const s = SECTIONS.find((x) => x.key === key);
    if (s) { if (!s.tab || navOn(s.tab)) out.push({ key, kind: 'sec', sec: s }); continue; }
    const l = LINKS.find((x) => x.key === key);
    if (l) { if (!l.tab || navOn(l.tab) !== false) out.push({ key, kind: 'link', link: l }); continue; }
    const a = APPS.find((x) => x.key === key);
    if (a && (!a.tab || navOn(a.tab))) out.push({ key, kind: 'app', app: a });
  }
  return out;
}
function pinApp(key: string, idx = order.length): void {
  if (!canPin(key)) return;
  const next = order.filter((k) => k !== key);
  next.splice(Math.max(0, Math.min(idx, next.length)), 0, key);
  saveOrder(next); drawRail();
}
function unpinApp(key: string): void { saveOrder(order.filter((k) => k !== key)); drawRail(); }
function dockMenu(x: number, y: number, a: AppDef, pinned: boolean): void {
  ctxMenu(x, y, [
    { label: '열기', run: () => { location.hash = '#/app/' + a.key; } },
    { sep: true, label: '' },
    pinned ? { label: '독에서 빼기', run: () => unpinApp(a.key) } : { label: '독에 고정', run: () => pinApp(a.key) },
  ]);
}

// ── 끌기 엔진 — 포인터 이벤트로 직접 ──────────────────────────────────────────
//  누름(.press, 살짝 작아짐) → 들림(그림자 .v2-rail-ghost 가 손을 따라가고 원래 자리는 구멍 .hole) → 이웃 비켜서기(flip)
//  → 놓음(그림자가 구멍으로 내려앉음 .land / 밖이면 .puff) → 다시 그리기. 끌던 중엔 drawRail 이 DOM 을 갈아엎지 않는다.
type DragKind = 'sec' | 'pin' | 'recent';
interface Drag {
  key: string; kind: DragKind; it: HTMLElement; ghost: HTMLElement | null; ptr: number; type: string;
  x0: number; y0: number; lifted: boolean; moved: boolean; out: boolean; inMain: boolean;
  home: { parent: HTMLElement; next: Element | null }; hold: number | null;
}
let drag: Drag | null = null;

function wireDrag(it: HTMLElement, key: string, kind: DragKind): void {
  it.setAttribute('draggable', 'false');   // <a> 는 기본이 끌리는 요소 — 네이티브 드래그가 포인터 이벤트를 끊는다
  it.addEventListener('dragstart', (e) => e.preventDefault());
  it.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || !host || !it.parentElement) return;
    const d: Drag = {
      key, kind, it, ghost: null, ptr: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY,
      lifted: false, moved: false, out: false, inMain: kind !== 'recent',
      home: { parent: it.parentElement, next: it.nextElementSibling }, hold: null,
    };
    drag = d;
    it.classList.add('press');
    d.hold = window.setTimeout(() => { d.hold = null; lift(d); }, e.pointerType === 'mouse' ? HOLD_MS.mouse : HOLD_MS.touch);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  });
}
function unlisten(): void {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
}
/** 들리기 전에 손을 뗐거나 움직였다 — 보통의 클릭·스크롤로 흘려보낸다. */
function dropPress(d: Drag): void {
  if (d.hold) { window.clearTimeout(d.hold); d.hold = null; }
  d.it.classList.remove('press');
  drag = null; unlisten();
}
function lift(d: Drag): void {
  if (d.hold) { window.clearTimeout(d.hold); d.hold = null; }
  if (!host) { dropPress(d); return; }
  d.lifted = true;
  try { d.it.setPointerCapture(d.ptr); } catch (_) { /* 못 잡아도 window 에서 듣는다 */ }
  const r = d.it.getBoundingClientRect();
  const inner = d.it.cloneNode(true) as HTMLElement;
  inner.classList.remove('press'); inner.removeAttribute('title');
  const g = el('div', { class: 'v2-rail-ghost', 'aria-hidden': 'true' }, inner) as HTMLElement;
  g.style.left = `${r.left}px`; g.style.top = `${r.top}px`; g.style.width = `${r.width}px`; g.style.height = `${r.height}px`;
  host.appendChild(g);
  d.ghost = g;
  d.it.classList.remove('press'); d.it.classList.add('hole');
  host.classList.add('drag');
  requestAnimationFrame(() => g.classList.add('up'));   // 눌린 크기(.94)에서 튀어오른다(1.1) — '들리는' 동작
  if (d.type !== 'mouse') { try { navigator.vibrate?.(8); } catch (_) { /* 없으면 없는 대로 */ } }
}
function onMove(e: PointerEvent): void {
  const d = drag; if (!d || e.pointerId !== d.ptr) return;
  const dx = e.clientX - d.x0; const dy = e.clientY - d.y0;
  if (!d.lifted) {
    if (Math.hypot(dx, dy) <= 8) return;
    if (d.type === 'mouse') lift(d); else { dropPress(d); return; }   // 마우스는 끌자마자 들린다(맥 독) · 손가락은 스크롤이다
    if (!d.lifted) return;
  }
  e.preventDefault();
  if (Math.hypot(dx, dy) > 4) d.moved = true;
  if (d.ghost) d.ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  track(d, e.clientX, e.clientY);
}
function onUp(e: PointerEvent): void {
  const d = drag; if (!d || e.pointerId !== d.ptr) return;
  if (!d.lifted) { dropPress(d); return; }   // 짧게 눌렀다 뗐다 = 클릭 — 그대로 흐른다
  e.preventDefault();
  finish(d, e.clientX, e.clientY);
}
function onCancel(e: PointerEvent): void {
  const d = drag; if (!d || e.pointerId !== d.ptr) return;
  if (!d.lifted) { dropPress(d); return; }
  abort(d);
}
function onKey(e: KeyboardEvent): void {
  const d = drag; if (!d || e.key !== 'Escape') return;
  e.preventDefault();
  if (!d.lifted) { dropPress(d); return; }
  abort(d);
}
/** 손 자리에 맞춰 구멍(자리표)을 옮긴다 — 이웃은 FLIP 으로 비켜선다. */
function track(d: Drag, x: number, y: number): void {
  if (!host) return;
  const main = host.querySelector('.v2-rail-main') as HTMLElement | null;
  const mid = host.querySelector('.v2-rail-mid') as HTMLElement | null;
  const hr = host.querySelector('.v2-rail-hr') as HTMLElement | null;
  if (!main || !mid || !hr) return;
  const rr = host.getBoundingClientRect(); const mr = mid.getBoundingClientRect();
  const inRail = x >= rr.left - 24 && x <= rr.right + 24 && y >= mr.top - 12 && y <= mr.bottom + 12;
  const inMain = inRail && y < hr.getBoundingClientRect().top + 6;
  if (inMain) {
    moveHole(d, main, slotAt(main, y, d.it));
    d.inMain = true; d.out = false; d.ghost?.classList.remove('out');
    return;
  }
  d.inMain = false;
  if (d.kind === 'pin') {   // 메인 밖 = 뺀다(맥 독) — 구멍이 닫히고 그림자가 옅어진다
    if (!d.out) { d.out = true; d.ghost?.classList.add('out'); flip(() => d.it.classList.add('gone')); }
  } else if (d.kind === 'recent') {   // 원래 자리로 돌아간다
    moveHole(d, d.home.parent, null, d.home.next);
  }
  //  구역·리브는 마지막 자리표를 지킨다(뺄 수 없다) — 놓으면 거기로 돌아간다
}
/** 세로 위치로 몇 번째 칸인가 — 끌고 있는 것과 닫힌 구멍은 세지 않는다. */
function slotAt(zone: HTMLElement, y: number, self: HTMLElement): number {
  let idx = 0;
  for (const c of Array.from(zone.children) as HTMLElement[]) {
    if (c === self || c.classList.contains('gone')) continue;
    const r = c.getBoundingClientRect();
    if (y > r.top + r.height / 2) idx += 1;
  }
  return idx;
}
/** 구멍을 zone 의 idx 번째(끌고 있는 것 제외)로 — 이미 거기면 아무것도 하지 않는다. */
function moveHole(d: Drag, zone: HTMLElement, idx: number | null, before?: Element | null): void {
  const kids = (Array.from(zone.children) as HTMLElement[]).filter((c) => c !== d.it);
  const ref: Element | null = before !== undefined ? before : (idx === null ? null : (kids[idx] || null));
  if (d.it.parentElement === zone && d.it.nextElementSibling === ref && !d.it.classList.contains('gone')) return;
  flip(() => { d.it.classList.remove('gone'); zone.insertBefore(d.it, ref); });
}
/** FLIP — 바꾸기 전 자리를 재고(First), 바꾸고(Last), 차이만큼 되돌려 놓은 뒤(Invert) 제자리로 흘려보낸다(Play). */
function flip(change: () => void): void {
  if (!host) { change(); return; }
  const els = Array.from(host.querySelectorAll('.v2-rail-mid .v2-rail-it, .v2-rail-mid .v2-rail-hr')) as HTMLElement[];
  const first = new Map<HTMLElement, number>();
  for (const x of els) { first.set(x, x.getBoundingClientRect().top); x.style.transition = 'none'; x.style.transform = ''; }
  change();
  if (!motion()) return;
  for (const x of els) {
    if (!x.isConnected || x.classList.contains('hole')) continue;   // 구멍은 튀지 않고 바로 새 칸에 선다
    const dy = (first.get(x) as number) - x.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    x.style.transform = `translateY(${dy}px)`;
    void x.offsetHeight;   // 되돌린 자리를 먼저 그리게 한다
    x.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
    x.style.transform = '';
  }
}
function finish(d: Drag, x: number, y: number): void {
  if (!d.moved) {
    //  들었다가 그 자리에서 놓았다 — 손가락이면 메뉴(우클릭이 없는 자리), 마우스면 보통의 클릭이 이어진다
    if (d.type !== 'mouse') {
      swallowClick();
      const a = APPS.find((q) => q.key === d.key);
      if (a && d.kind !== 'sec') dockMenu(x, y, a, d.kind === 'pin');
    }
    land(d, () => endDrag(d));
    return;
  }
  swallowClick();
  if (d.kind === 'pin' && d.out) {
    puff(d, () => endDrag(d, () => { saveOrder(order.filter((k) => k !== d.key)); toast('독에서 뺐어요 — 최근에 열면 다시 아래에 떠요'); }));
    return;
  }
  if (d.kind === 'recent' && !d.inMain) { land(d, () => endDrag(d)); return; }   // 제자리로 — 최근 칸의 순서는 자동이다
  //  메인 그룹의 지금 DOM 순서가 곧 새 순서 — 최근 앱이 올라와 있으면 거기서 고정된다
  const main = host?.querySelector('.v2-rail-main');
  const keys = main ? (Array.from(main.children) as HTMLElement[]).map((c) => c.dataset.key || '').filter(Boolean) : order;
  land(d, () => endDrag(d, () => saveOrder(keys)));
}
function abort(d: Drag): void {
  d.out = false; d.ghost?.classList.remove('out');
  moveHole(d, d.home.parent, null, d.home.next);
  land(d, () => endDrag(d));
}
/** 그림자가 구멍으로 내려앉는다. */
function land(d: Drag, done: () => void): void {
  const g = d.ghost;
  if (!g || !motion()) { done(); return; }
  g.classList.add('settle', 'land');
  if (!d.it.classList.contains('gone')) {
    const r = d.it.getBoundingClientRect();
    g.style.transform = `translate3d(${r.left - (parseFloat(g.style.left) || 0)}px, ${r.top - (parseFloat(g.style.top) || 0)}px, 0)`;
  }
  window.setTimeout(done, 230);
}
/** 밖에 놓았다 — 커지며 사라진다(맥 독의 '퍽'). */
function puff(d: Drag, done: () => void): void {
  const g = d.ghost;
  if (!g || !motion()) { done(); return; }
  g.classList.add('puff');
  window.setTimeout(done, 210);
}
function endDrag(d: Drag, then?: () => void): void {
  drag = null; unlisten();
  d.ghost?.remove(); d.ghost = null;
  d.it.classList.remove('hole', 'gone', 'press');
  host?.classList.remove('drag');
  if (then) then();
  drawRail();   // 순서가 바뀌었든 아니든 한 번 다시 그린다 — 끌던 동안 미뤄 둔 그림도 여기서 따라온다
}
/** 끌고 난 뒤 따라오는 click 하나를 삼킨다 — 링크(<a>)가 열리거나 구역이 바뀌면 안 된다. */
function swallowClick(): void {
  const off = (): void => window.removeEventListener('click', eat, true);
  const eat = (e: Event): void => { e.preventDefault(); e.stopImmediatePropagation(); off(); };
  window.addEventListener('click', eat, true);
  window.setTimeout(off, 400);
}

// ── 그리기 ───────────────────────────────────────────────────────────────────
export function mountRail(el0: HTMLElement, h?: RailHooks): void {
  init();
  host = el0;
  hooks = h || hooks;
  drawRail();
}

export function drawRail(): void {
  if (!host) return;
  init();
  if (drag && drag.lifted) return;   // 끌던 중엔 다시 그리지 않는다 — DOM 을 갈아엎으면 손에 든 것이 사라진다(endDrag 가 그린다)
  const c = hooks.counts?.() || { inbox: 0, busy: 0, projects: 0 };
  const running = hooks.openApps?.() || new Set<string>();
  const ak = hooks.activeKey?.() || '';
  const linkOn = LINKS.find((l) => l.key === ak) || null;
  host.classList.add('closed');   // 격자는 늘 '아이콘 위 · 이름 아래' 하나다(232px 펼침 모드 폐기)
  document.getElementById('v2-root')?.classList.toggle('rail-hidden', hidden);

  // ⓪ 워크스페이스
  const top = el('div', { class: 'v2-rail-top' }, el('div', { class: 'v2-rail-ws' }, stackTile()));

  // 항목 한 붓 — 아이콘 위, 이름 아래.
  const item = (key: string, label: string, ic: string, on: boolean, extra: HTMLElement | null, onclick: () => void, href?: string): HTMLElement =>
    el(href ? 'a' : 'button', {
      class: 'v2-rail-it' + (on ? ' on' : ''), ...(href ? { href } : { type: 'button' }), 'data-key': key,
      'aria-current': on ? 'page' : null, title: label,
      onclick: (e: Event) => { if (!href) e.preventDefault(); onclick(); },
    }, icon(ic, 'v2-rail-ic'), el('span', { class: 'v2-rail-t', text: label }), extra);
  const appItem = (a: AppDef, kind: 'pin' | 'recent'): HTMLElement => {
    const it = item(a.key, a.title, a.icon, false,
      running.has(a.key) ? el('span', { class: 'v2-rail-run', role: 'img', 'aria-label': '실행 중' }) : null,
      () => { /* href 가 간다 */ }, '#/app/' + a.key);
    it.classList.add(kind === 'pin' ? 'pinned' : 'recent');
    it.dataset.app = a.key; it.dataset.kind = kind;
    it.title = a.title + (kind === 'pin' ? ' — 독에 고정됨 · 꾹 눌러 끌면 순서, 레일 밖으로 끌어내면 빼기' : ' — 최근에 연 앱 · 꾹 눌러 위로 끌어 올리면 고정');
    it.addEventListener('contextmenu', (e) => { e.preventDefault(); if (drag?.lifted) return; dockMenu(e.clientX, e.clientY, a, kind === 'pin'); });
    wireDrag(it, a.key, kind);
    return it;
  };

  // ① 메인 그룹 — 구역 · 리브 · 독에 고정한 앱, 사람이 정한 한 줄 순서(꾹 눌러 끌면 바뀐다).
  const mainEls = mainEntries().map((m) => {
    if (m.kind === 'app') return appItem(m.app, 'pin');
    let it: HTMLElement;
    if (m.kind === 'sec') {
      const s = m.sec; const on = !linkOn && section === s.key;
      //  확인할 것 — 슬랙 '내 활동'의 그 배지. 아이콘 귀퉁이에 숫자.
      const extra = s.key === 'inbox' && c.inbox
        ? el('span', { class: 'v2-rail-bd', text: String(c.inbox), role: 'img', 'aria-label': `확인할 것 ${c.inbox}건` })
        : null;
      it = item(s.key, s.label, s.icon, on, extra, () => setRailSection(s.key, { navigate: true }));
    } else {
      const l = m.link;
      it = item(l.key, l.label, l.icon, !!linkOn && linkOn.key === l.key, null, () => { location.hash = l.route; }, l.route);
    }
    it.dataset.kind = 'sec';
    wireDrag(it, m.key, 'sec');
    return it;
  });
  const mainZone = el('div', { class: 'v2-rail-main', 'aria-label': '메인 — 꾹 눌러 끌면 순서를 바꿀 수 있어요' }, ...mainEls);

  // ② 최근 연 앱 — 헤어라인 아래, 자동(맥 독의 최근 구간). 위로 끌어 올리면 메인에 고정된다.
  const recentZone = el('div', { class: 'v2-rail-recent', 'aria-label': '최근 연 앱' }, ...recentForRail(RECENT_N).map((a) => appItem(a, 'recent')));

  const mid = el('div', { class: 'v2-rail-mid' }, mainZone, el('div', { class: 'v2-rail-hr', role: 'presentation' }), recentZone);

  // ③ 발치 — 앱 · 나 (슬랙의 ＋ · 아바타). 여닫는 단추는 여기 없다(머리말).
  const me: any = state.me || {};
  const myName = String(me.display_name || me.email || me.userId || '');
  const foot = el('footer', { class: 'v2-rail-foot' },
    item('apps', '앱', 'apps', false, null, () => openLaunchpad()),
    el('button', {
      class: 'v2-rail-it v2-rail-me', type: 'button', 'aria-haspopup': 'dialog', title: '내 프로필 · 환경설정',
      onclick: () => openMeModal({ onSaved: () => drawRail() }),
    },
      profileAvatar(me.avatar, myName, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }),
      el('span', { class: 'v2-rail-t', text: myName })));

  host.replaceChildren(top, mid, foot);
}

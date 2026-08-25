// v2/rail.ts — 좌측 끝 **레일**(#2016, 원준 2026-08-26 "안 1 · 슬랙 그대로").
//
//  사이드바보다 한 층 위다: **어느 워크스페이스의 · 어느 구역에 있는가**를 말한다.
//   ⓪ 워크스페이스 — 접히면 타일(여럿이면 세로로 쌓임), 펼치면 문패 카드(switcher.ts 것 그대로)
//   ① 구역 넷 — 홈 · AI 세션 · 프로젝트 · 위키. 고른 구역이 곧 **사이드바의 내용**이다(side.ts).
//   ② 최근 연 앱 — 헤어라인 아래. 맥 독의 '최근 사용' 구간.
//   ③ 발치 — 접기/펼치기 · 앱(런치패드) · 나(내 프로필·환경설정 #1843)
//
//  ⚠ 구역은 **사람이 고를 때만** 바뀐다. 주소를 따라 저절로 바뀌게 하면, 홈 목록에서 세션 하나를 여는
//   순간 사이드바가 통째로 [AI 세션]으로 갈아엎여 방금 보던 목록이 사라진다. 슬랙도 그렇게 하지 않는다 —
//   DM 탭에서 대화를 열어도 탭은 DM 에 머문다. 그래서 구역은 이 모듈의 상태이고 브라우저에 기억한다.
//
//  ⚠ 레일은 접을 수 있어도 **사이드바는 접을 수 없다**(원준 2026-08-25) — ☰ 는 이제 레일을 여닫는다.
import { el, navOn, profileAvatar, state, sv } from '../core.js';
import { APPS, appIcon, openLaunchpad, type AppDef } from './apps.js';
import { openMeModal } from './me-modal.js';
import { activeWorkspaceSlug, listWorkspaces, switcherTile, switcherTop, switchWorkspace } from './switcher.js';

export type RailSection = 'home' | 'sess' | 'proj' | 'wiki';

export interface RailHooks {
  /** 배지·개수 — 확인할 것(홈) · 작업 중 세션(AI 세션) · 진행 중 프로젝트(프로젝트). */
  counts?: () => { inbox: number; busy: number; projects: number };
  /** 지금 열려 있는 앱 키 — 최근 앱 아이콘 아래 '실행 중' 점(맥 독). */
  openApps?: () => Set<string>;
  /** 구역이 바뀌었다 — 사이드바를 다시 그리고 그 구역의 첫 화면으로 간다. */
  onSection?: (sec: RailSection, opts: { navigate: boolean }) => void;
  /** 얼굴 스택에 쓸 사람들(문패 카드). side.ts 가 이미 들고 있는 것을 넘겨받는다. */
  people?: () => Record<string, any>;
  faces?: () => string[];
  /** 레일을 여닫았다 — **사이드바도 같이 다시 그려야 한다**: 접힘/펼침에 따라 워크스페이스 이름이
   *  사이드바 머리에 섰다 사라진다(레일이 펼쳐지면 문패 카드가 그 역할을 한다). 안 부르면 두 자리에 같이 남는다. */
  onLayout?: () => void;
}

// ── 구역 표 ──────────────────────────────────────────────────────────────────
//  route = 그 구역을 눌렀을 때 가는 첫 화면. 홈만 셸의 제 화면이고 나머지 셋은 앱이다.
//  tab   = navOn 게이팅(관리자가 끈 탭은 레일에서도 안 보인다 — 클래식과 같은 규칙).
interface SecDef { key: RailSection; label: string; route: string; tab: string | null; icon: AppDef['icon'] | 'home'; }
const SECTIONS: SecDef[] = [
  { key: 'home', label: '홈', route: '#/', tab: null, icon: 'home' },
  { key: 'sess', label: 'AI 세션', route: '#/app/terminal', tab: 'terminal', icon: 'term' },
  { key: 'proj', label: '프로젝트', route: '#/app/projects2', tab: 'projects2', icon: 'proj' },
  { key: 'wiki', label: '위키', route: '#/app/knowledge', tab: 'knowledge', icon: 'wiki' },
];
export function railSections(): SecDef[] { return SECTIONS.filter((s) => !s.tab || navOn(s.tab)); }

// ── 상태 ─────────────────────────────────────────────────────────────────────
const SEC_STORE = 'lively_v2_rail_sec';
const OPEN_STORE = 'lively_v2_rail_open';   // ⚠ 이름에 `_KEY` 를 쓰지 않는다 — gitleaks 가 시크릿으로 오인한다(#1954)
const RECENT_N = 4;

let section: RailSection = 'home';
let open = false;
let host: HTMLElement | null = null;
let hooks: RailHooks = {};
let inited = false;
let spaces: Array<{ slug: string; name: string; kind: string; is_primary?: boolean }> = [];

function init(): void {
  if (inited) return;
  inited = true;
  try {
    const s = localStorage.getItem(SEC_STORE) as RailSection | null;
    if (s && SECTIONS.some((x) => x.key === s)) section = s;
    open = localStorage.getItem(OPEN_STORE) === '1';
  } catch (_) { /* 못 읽어도 홈·접힘으로 선다 */ }
  // 워크스페이스가 여럿이면 접힌 레일에 타일이 쌓인다. registry 가 꺼져 있으면 빈 배열이라 한 장만 선다.
  void listWorkspaces().then((rows) => { if (rows.length > 1) { spaces = rows; drawRail(); } });
}

export function railSection(): RailSection { return section; }
export function railIsOpen(): boolean { return open; }

export function setRailSection(sec: RailSection, opts?: { navigate?: boolean }): void {
  if (!SECTIONS.some((s) => s.key === sec)) return;
  const changed = section !== sec;
  section = sec;
  try { localStorage.setItem(SEC_STORE, sec); } catch (_) { /* 이번 화면은 된다 */ }
  drawRail();
  hooks.onSection?.(sec, { navigate: changed || !!(opts && opts.navigate) });
}

export function toggleRail(): void {
  open = !open;
  try { localStorage.setItem(OPEN_STORE, open ? '1' : '0'); } catch (_) { /* 이번 화면은 된다 */ }
  drawRail();
  hooks.onLayout?.();
}

// ── 아이콘(선 글리프) — 유리 아이콘은 런치패드 64px 전용이라 여기 쓰지 않는다(#1841). ──
const D = {
  home: ['M3.5 11.2 12 4.5l8.5 6.7', 'M6 10v9h12v-9'],
  chevL: ['M15 6l-6 6 6 6'],
  chevR: ['M9 6l6 6-6 6'],
  grid: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  gear: ['M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z',
    'M19.4 13.6a7.6 7.6 0 0 0 0-3.2l1.9-1.4-1.9-3.3-2.2.9a7.7 7.7 0 0 0-2.8-1.6L14 2.5h-4l-.4 2.5a7.7 7.7 0 0 0-2.8 1.6l-2.2-.9L2.7 9l1.9 1.4a7.6 7.6 0 0 0 0 3.2L2.7 15l1.9 3.3 2.2-.9a7.7 7.7 0 0 0 2.8 1.6l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.8-1.6l2.2.9 1.9-3.3z'],
};
const ln = (k: keyof typeof D, cls = 'v2-rail-ic'): SVGElement =>
  sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...D[k].map((d) => sv('path', { d })));
const secIcon = (s: SecDef): SVGElement => (s.icon === 'home' ? ln('home') : appIcon(s.icon as AppDef['icon'], 'v2-rail-ic'));

// ── 최근 앱 — 구역 넷과 겹치는 것은 뺀다(같은 문이 레일에 둘이면 문이 아니라 헷갈림이다). ──
const SEC_APP_KEYS = new Set(['terminal', 'projects2', 'knowledge']);
function recentForRail(n: number): AppDef[] {
  let keys: string[] = [];
  try { const v = JSON.parse(localStorage.getItem('lively_v2_recent_apps') || '[]'); if (Array.isArray(v)) keys = v.filter((x) => typeof x === 'string'); }
  catch (_) { /* 기록이 없으면 표 순서로 채운다 */ }
  const pick: AppDef[] = [];
  const take = (a: AppDef | undefined): void => {
    if (!a || SEC_APP_KEYS.has(a.key) || pick.some((p) => p.key === a.key)) return;
    if (a.tab && !navOn(a.tab)) return;
    pick.push(a);
  };
  for (const k of keys) { if (pick.length >= n) break; take(APPS.find((a) => a.key === k)); }
  for (const a of APPS) { if (pick.length >= n) break; take(a); }
  return pick.slice(0, n);
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
  const c = hooks.counts?.() || { inbox: 0, busy: 0, projects: 0 };
  const running = hooks.openApps?.() || new Set<string>();
  host.classList.toggle('open', open);
  host.classList.toggle('closed', !open);
  document.getElementById('v2-root')?.classList.toggle('rail-open', open);

  // ⓪ 워크스페이스
  const top = el('div', { class: 'v2-rail-top' },
    open
      ? switcherTop({ people: hooks.people?.() || {}, faces: hooks.faces?.() || [] })
      : el('div', { class: 'v2-rail-ws' }, ...wsTiles()),
    //  펼쳤을 때 워크스페이스가 여럿이면 **팝오버를 그 자리에 편다** — 전환이 한 번의 클릭이 된다.
    //  하나뿐이면 그리지 않는다(고를 것이 없는데 목록을 두면 없는 선택지를 묻는 꼴이다).
    open && spaces.length > 1 ? wsListOpen() : null);

  // ① 구역 넷 — 아이콘 위, 이름 아래(접힘) / 가로 행(펼침).
  const secEls = railSections().map((s) => {
    const on = section === s.key;
    const meta = s.key === 'sess' && c.busy ? `${c.busy} 작업 중`
      : s.key === 'proj' && c.projects ? String(c.projects) : '';
    return el('button', {
      class: 'v2-rail-it' + (on ? ' on' : ''), type: 'button', 'data-tip': s.label,
      'aria-current': on ? 'page' : null,
      title: s.key === 'home' && c.inbox ? `${s.label} — 확인할 것 ${c.inbox}건` : s.label,
      onclick: () => setRailSection(s.key, { navigate: true }),
    },
      secIcon(s),
      el('span', { class: 'v2-rail-t', text: s.label }),
      //  확인할 것 — 펼치면 숫자, 접히면 점. 앰버는 사이드바 통틀어 이 하나뿐이다(#1719 규칙).
      s.key === 'home' && c.inbox
        ? (open ? el('span', { class: 'v2-rail-bd', text: String(c.inbox) })
          : el('span', { class: 'v2-rail-pip', role: 'img', 'aria-label': `확인할 것 ${c.inbox}건` }))
        : meta ? el('span', { class: 'v2-rail-m', text: meta }) : null);
  });

  // ② 최근 연 앱
  const recents = recentForRail(RECENT_N);
  const recentEls = recents.map((a) => el('a', {
    class: 'v2-rail-it', href: '#/app/' + a.key, 'data-tip': a.title + (running.has(a.key) ? ' · 실행 중' : ''), title: a.title,
  },
    appIcon(a.icon, 'v2-rail-ic'),
    el('span', { class: 'v2-rail-t', text: a.title }),
    running.has(a.key) ? el('span', { class: 'v2-rail-run', role: 'img', 'aria-label': '실행 중' }) : null));

  const mid = el('div', { class: 'v2-rail-mid' },
    ...secEls,
    recentEls.length ? el('div', { class: 'v2-rail-hr', role: 'presentation' }) : null,
    recentEls.length && open ? el('div', { class: 'v2-rail-k', text: '최근 앱' }) : null,
    ...recentEls);

  // ③ 발치 — 접기/펼치기 · 앱 · 나
  const me: any = state.me || {};
  const myName = String(me.display_name || me.email || me.userId || '');
  const foot = el('footer', { class: 'v2-rail-foot' },
    el('button', {
      class: 'v2-rail-tg', type: 'button', 'aria-expanded': String(open),
      'data-tip': open ? '레일 접기' : '레일 펼치기',
      title: (open ? '레일 접기' : '레일 펼치기') + ' — ⌘⇧S',
      onclick: () => toggleRail(),
    }, ln(open ? 'chevL' : 'chevR'), el('span', { class: 'v2-rail-t', text: open ? '레일 접기' : '레일 펼치기' })),
    el('button', {
      class: 'v2-rail-it', type: 'button', 'data-tip': '앱 — 모든 앱', title: '모든 앱',
      onclick: () => openLaunchpad(),
    }, ln('grid'), el('span', { class: 'v2-rail-t', text: '앱' })),
    el('button', {
      class: 'v2-rail-it v2-rail-me', type: 'button', 'aria-haspopup': 'dialog',
      'data-tip': myName + ' · 내 프로필 · 환경설정', title: '내 프로필 · 환경설정',
      onclick: () => openMeModal({ onSaved: () => drawRail() }),
    },
      profileAvatar(me.avatar, myName, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color }),
      el('span', { class: 'v2-rail-t', text: myName }),
      ln('gear', 'v2-rail-gear')));

  host.replaceChildren(top, mid, foot);
}

/** 펼친 레일의 「다른 워크스페이스」 — 지금 있는 곳은 빼고, 누르면 그리로 간다. */
function wsListOpen(): HTMLElement {
  const cur = activeWorkspaceSlug();
  const others = spaces.filter((w) => !(w.slug === cur || (w.is_primary && cur === 'primary')));
  return el('div', { class: 'v2-rail-wsl' },
    el('div', { class: 'v2-rail-k', text: '다른 워크스페이스' }),
    ...others.map((w) => el('button', {
      class: 'v2-rail-wsr', type: 'button', title: `${w.name} 워크스페이스로 전환`,
      onclick: () => switchWorkspace(String(w.slug)),
    },
      el('span', { class: 'v2-wscard-big' + (w.kind === 'personal' ? ' round' : ''), text: String(w.name || w.slug).trim().slice(0, 1) }),
      el('span', { class: 'v2-rail-t', text: String(w.name || w.slug) }),
      el('span', { class: 'v2-rail-kd', text: w.kind === 'personal' ? '개인' : '팀' }))));
}

/** 접힌 레일의 문패 — 하나면 타일 한 장, 여럿이면 세로로 쌓이고 활성은 파란 고리(슬랙 스위처). */
function wsTiles(): HTMLElement[] {
  if (spaces.length < 2) return [switcherTile()];
  const cur = activeWorkspaceSlug();
  return spaces.map((w) => {
    const active = w.slug === cur || (w.is_primary && cur === 'primary');
    const kind = w.kind === 'personal' ? '개인' : '팀';
    return el('button', {
      class: 'v2-rail-tile' + (active ? ' on' : ''), type: 'button',
      'aria-current': active ? 'true' : null,
      title: active ? `${w.name} · ${kind} 워크스페이스 — 지금 여기예요` : `${w.name} · ${kind} 워크스페이스로 전환`,
      onclick: () => { if (!active) switchWorkspace(String(w.slug)); },
    }, el('span', {
      class: 'v2-wscard-big' + (w.kind === 'personal' ? ' round' : ''),
      text: String(w.name || w.slug).trim().slice(0, 1),
    })) as HTMLElement;
  });
}

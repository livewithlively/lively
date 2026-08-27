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
//  ⚠ 레일 폭은 **76px 고정**이다(원준 3차: "가로 늘리면 UI 바뀌는 거 없이 폭 고정" · #2061 "폭 넓혀줘"로 68→76). 종전의 232px 펼침 모드는
//   걷었다 — 상태는 **보임 / 숨김** 둘뿐. 숨기면 레일이 들고 있던 워크스페이스·구역·앱·나가 사이드바 머리와
//   발치로 들어간다(side.ts wsHead·secFoot — 안 B '머리글 드롭다운'). 되살리는 길은 셋: 사이드바 맨 윗줄
//   왼쪽 패널 단추 · 워크스페이스 팝오버 마지막 행 · ⌘⇧S.
//
//  ⚠ 구역은 **사람이 고를 때만** 바뀐다. 주소를 따라 저절로 바꾸면, 홈 목록에서 세션 하나를 여는 순간
//   사이드바가 통째로 [AI 세션]으로 갈아엎여 방금 보던 목록이 사라진다. 슬랙도 DM 탭에서 대화를 열어도
//   탭은 DM 에 머문다. 그래서 구역은 이 모듈의 상태이고 브라우저에 기억한다.
import { el, navOn, personName, profileAvatar, state, toast, wsKey } from '../core.js';
import { APPS, openLaunchpad, RECENT_STORE_KEY, type AppDef } from './apps.js';
import { icon } from './icons.js';
import { openMeModal } from './me-modal.js';
import { ctxMenu } from './panes-kit.js';   // 우클릭 메뉴 — 곁칸·프로젝트 행과 같은 부품
import {
  activeWorkspaceSlug, listWorkspaces, myInvites, registerWorkspaceMenu, registryActive, switchWorkspace, workspaceFace, workspaceInfo,
  archiveWorkspace, createWorkspace, linkTeam, linkedTeams, pendingPromotions, renameWorkspace, resolvePromotion, setAutoPromote, unlinkTeam,
} from './switcher.js';
import { inboxSection, openMemberModal } from './ws-people.js';   // #1875 — 구성원 모달·나에게 온 초대

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
  { key: 'sess', label: 'AI 세션', tab: 'terminal', icon: 'chat' },   // 말풍선 — 사이드바 세션 행과 같은 붓(원준 2026-08-26)
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
const HIDE_STORE = wsKey('lively_v2_rail_hidden');   // ⚠ 이름에 `_KEY` 를 쓰지 않는다 — gitleaks 가 시크릿으로 오인한다(#1954)
const MAIN_STORE = wsKey('lively_v2_rail_main');     // 메인 그룹 순서 — 구역 · 리브 · 독에 고정한 앱을 **한 줄**로(사람이 정한 순서, 5차). 이 기기에 둔다.
const PIN_STORE = wsKey('lively_v2_rail_pins');      // 4차의 기억(고정 앱만 따로) — 5차 첫 로드에 MAIN_STORE 로 옮기고 지운다.
const RECENT_N = 4;
const NARROW_MQ = '(max-width: 900px)';   // mobile.ts MOBILE_MQ 와 같은 값 — 좁은 폭에선 레일이 늘 아이콘으로 선다(47-v2-rail.css)

let section: RailSection = 'home';
let hidden = false;
let host: HTMLElement | null = null;
let hooks: RailHooks = {};
let inited = false;
let spaces: Array<{ slug: string; name: string; kind: string; is_primary?: boolean; role?: string | null; member_count?: number | null; kind_effective?: string; pending_invites?: number }> = [];
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
  //  ⚠ 키를 여기서 다시 적지 않는다 — apps.ts 가 내보내는 RECENT_STORE_KEY 와 **같은 자리**를
  //   읽어야 한다. 사본을 두면 워크스페이스 접미사가 한쪽에만 붙어 레일만 남의 워크스페이스 기록을 본다(#1875).
  try { const v = JSON.parse(localStorage.getItem(RECENT_STORE_KEY) || '[]'); if (Array.isArray(v)) keys = v.filter((x) => typeof x === 'string'); }
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
  //  얼굴의 출처는 switcher.workspaceFace 하나다(#1875) — 여기서 따로 그리면 같은 워크스페이스가 자리마다 다른 색이 된다.
  return workspaceFace(w, cls);
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
  if (popEl && !popEl.contains(t) && !t.closest('.v2-rail-stack') && !t.closest('.v2-secdd') && !t.closest('.v2-ws')) closePopover();
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

/**
 * 워크스페이스 메뉴 — 슬랙의 워크스페이스 팝오버. **이것 하나가 유일한 메뉴다**(#1875, 원준 2026-08-26).
 *  종전엔 이 팝오버와 옛 스위처 메뉴(switcher.ts openMenu)가 같이 살았다 — 「워크스페이스 추가」를 누르면
 *  옛 메뉴가 떴고, 사이드바 머리의 이름을 눌러도 옛 메뉴가 떴다. 같은 목록이 두 벌, 생김새는 두 시대.
 *  옛 메뉴가 갖고 있던 기능(만들기 · 이름 바꾸기 · 보관 · 팀 연결 · 승격 승인)을 **이 문법의 하위 판**으로
 *  옮기고, 문패·이름·타일이 무엇을 눌러도 여기로 오게 했다(switcher.registerWorkspaceMenu).
 *
 *  행 순서 — 나에게 온 초대(있을 때) · 워크스페이스 목록 · 구성원 · 설정 · 추가.
 */
export function openWorkspacePopover(anchor: HTMLElement): void {
  if (popEl) { closePopover(); return; }
  openPopover(anchor);
}

function openPopover(anchor: HTMLElement): void {
  closePopover();
  const cur = workspaceInfo();
  const curSlug = activeWorkspaceSlug();
  const rows: Array<{ slug: string; name: string; kind: string; active: boolean }> = spaces.length
    //  ★ 종류는 저장된 kind 가 아니라 **지금 명부에 몇 명인가**에서 나온다(#1875 kind_effective).
    ? spaces.map((w) => ({ slug: String(w.slug), name: String(w.name || w.slug), kind: String(w.kind_effective || w.kind || 'team'), active: w.slug === curSlug || (!!w.is_primary && curSlug === 'primary') }))
    : [{ slug: 'primary', name: cur.name, kind: cur.kind, active: true }];
  const me = spaces.find((w) => w.slug === curSlug || (!!w.is_primary && curSlug === 'primary'));
  const isOwner = !!me && me.role === 'owner' && curSlug !== 'primary';

  //  #1875 — 나에게 온 초대는 **맨 위**. 내가 결정해 줘야 저쪽이 기다림을 멈추고, '내가 갈 수 있는 곳'이라
  //   워크스페이스 목록과 같은 질문에 답한다.
  const inbox = inboxSection(myInvites(), (accepted) => {
    closePopover();
    if (accepted) switchWorkspace(accepted.slug);
    else void refreshSpaces();
  });

  const pop = el('div', { class: 'v2-wspop', role: 'menu', 'aria-label': '워크스페이스' },
    ...(inbox ? [inbox, hr()] : []),
    //  #1875 — 각 워크스페이스 행 오른쪽에 「사람 추가」 아이콘. 초대는 목록의 형제 항목이 아니라 **그 워크스페이스에
    //   딸린 행동**이라, 어느 워크스페이스에 넣는지가 그 자리에서 보인다(원준 2026-08-26 "어디서 추가하는지 느낌이 안 온다").
    //   행 전체는 전환, 아이콘만 모달 — 버튼 안 버튼을 피하려 div 로 감싼다.
    ...rows.map((w) => el('div', { class: 'v2-wspop-row' + (w.active ? ' cur' : '') },
      el('button', { class: 'v2-wspop-switch', type: 'button', role: 'menuitemradio', 'aria-checked': String(w.active),
        title: w.active ? '지금 이 워크스페이스예요' : `${w.name} 워크스페이스로 전환`,
        onclick: () => { closePopover(); if (!w.active) switchWorkspace(w.slug); } },
        wsTile(w, 'v2-wscard-big'),
        tt(w.name, w.kind === 'personal' ? '개인 워크스페이스' : '팀 워크스페이스')),
      addPeopleBtn(w))),
    hr(),
    //  설정 — 이름 · 연결한 팀 · 보관. 만든 사람(owner)만. 종전엔 목록 행 옆 ✎ ✕ 였다(무엇인지 읽히지 않았다).
    isOwner ? row('gear', '워크스페이스 설정', settingsSub(), () => openSettingsPanel(anchor, curSlug)) : null,
    isOwner ? hr() : null,
    //  추가 — 누르면 **바로 만드는 판**이 뜬다(종전엔 옛 메뉴 전체가 떴다 — "저 드롭다운으로 보내는 이유를 모르겠음").
    row('plus', '워크스페이스 추가', registryActive() ? '혼자 시작합니다 — 사람을 부르면 팀이 됩니다' : '지금은 만들 수 없어요', () => openCreatePanel(anchor)),
    //  「레일 숨기기」 행은 뺐다(원준 2026-08-26 "여기 있어야 할 이유가 없음") — 레일 여닫기는 창 맨 윗줄
    //   패널 단추와 ⌘⇧S 의 일이지 워크스페이스 메뉴의 일이 아니다.
    ) as HTMLElement;
  place(pop, anchor, !!anchor.closest('.v2-side'));
}

// ── 팝오버 부품 — 행·제목·구분선. 하위 판(구성원·설정·추가)도 같은 부품으로 그린다(문법이 하나여야 한 메뉴로 읽힌다). ──
const hr = (): HTMLElement => el('div', { class: 'v2-wspop-hr', role: 'separator' });
const tt = (b: string, sub: string): HTMLElement => el('span', { class: 'v2-wspop-tt' }, el('b', { text: b }), el('span', { text: sub }));
function row(ic: string, label: string, sub: string, run: () => void, extra?: { cls?: string; tail?: HTMLElement | null }): HTMLElement {
  return el('button', { class: 'v2-wspop-row' + (extra?.cls ? ' ' + extra.cls : ''), type: 'button', role: 'menuitem', onclick: () => { closePopover(); run(); } },
    el('span', { class: 'v2-wspop-ic' }, icon(ic)), tt(label, sub), extra?.tail || null);
}
/** 하위 판 머리 — ‹ 로 메뉴로 돌아간다. 판이 바뀌어도 '같은 메뉴 안'이라는 감각이 남게. */
function panelHead(title: string, anchor: HTMLElement): HTMLElement {
  return el('div', { class: 'v2-wspop-head' },
    el('button', { class: 'v2-wspop-back', type: 'button', title: '워크스페이스 메뉴로', 'aria-label': '뒤로', text: '‹', onclick: () => { closePopover(); openPopover(anchor); } }),
    el('b', { text: title }));
}
function field(ph: string, opts?: { type?: string; value?: string; autocomplete?: string }): HTMLInputElement {
  return el('input', { class: 'v2-wspop-in', type: opts?.type || 'text', placeholder: ph, 'aria-label': ph, value: opts?.value || '', autocomplete: opts?.autocomplete || 'off' }) as HTMLInputElement;
}
const hint = (t: string): HTMLElement => el('p', { class: 'v2-wspop-hint', text: t });
const sub = (t: string): HTMLElement => el('div', { class: 'v2-wspop-sub', text: t });

/** 초대 축(#1875 서버)이 이 게이트웨이에 있는가 — 목록 응답에 member_count 가 실리면 있다(같은 커밋에서 생겼다).
 *  없는 게이트웨이(서버 반영 전 dev)에서 구성원 행을 그리면 눌렀을 때 404 만 난다 — 그리지 않는다. */
function inviteAxisOn(): boolean { return spaces.some((w) => typeof w.member_count === 'number' || w.member_count === null); }

/** 워크스페이스 행 오른쪽 「사람 추가」 아이콘 — 그 워크스페이스의 구성원 모달을 연다(#1875, ws-people.ts).
 *  primary(박스의 팀)도 **같은 창**이다 — 거긴 명부 대신 박스 계정이라 초대 = 계정 생성이고, 그 임시 비밀번호가
 *  창 안에 바로 나온다(설정으로 보내지 않는다 — 원준 2026-08-26). 초대 축이 아직 없는 게이트웨이(서버 반영 전)의
 *  일반 워크스페이스에서는 안 그린다. */
function addPeopleBtn(w: { slug: string; name: string; kind: string; is_primary?: boolean }): HTMLElement | null {
  const isPrimary = !!w.is_primary || w.slug === 'primary';
  if (!isPrimary && !inviteAxisOn()) return null;
  return el('button', { class: 'v2-wspop-add', type: 'button', title: `${w.name} 에 사람 초대`, 'aria-label': `${w.name} 에 사람 초대`,
    onclick: (e: Event) => { e.stopPropagation(); closePopover(); openMemberModal(w.slug, w.name, { primary: isPrimary, face: workspaceFace(w, 'v2-wscard-big') }); } },
    icon('adduser')) as HTMLElement;
}

function settingsSub(): string { return promoN ? `이름 · 연결한 팀 · 보관 · 승인 대기 ${promoN}` : '이름 · 연결한 팀 · 보관'; }
let promoN = 0;   // 승인 대기 승격 수 — 설정 행 부제에 싣는다(판 안에 숨기면 아무도 못 본다)

/** primary(박스의 팀) 구성원 모달 — 박스 계정 전원이다(명부가 따로 없다). 관리자면 「사람 추가」가 설정 ▸ 구성원으로
 *  간다(계정 만들기 = 여기 들어오기). 다른 워크스페이스의 이메일 초대와 같은 자리(문패 오른쪽 아이콘)에서 열린다. */
/** 워크스페이스 추가 — 이름 하나면 된다. 개인/팀은 **고르는 것이 아니라 인원에서 나온다**(#1875 D1):
 *  혼자면 개인, 사람을 부르면 그 순간 팀. 그래서 종류 선택 칸을 두지 않는다 — 있으면 '지금 정해야 하는 것'으로 읽힌다. */
function openCreatePanel(anchor: HTMLElement): void {
  closePopover();
  const info = workspaceInfo();
  const pop = el('div', { class: 'v2-wspop v2-wspop--panel', role: 'dialog', 'aria-label': '새 워크스페이스' }, panelHead('새 워크스페이스', anchor)) as HTMLElement;
  if (!registryActive()) {
    //  만들 수 없는 상태를 **조용히 숨기지 않는다** — 매니지드면 허브가 답이고, 셀프호스트면 자동 활성화 대기다.
    pop.append(hint(info.hub ? '이 워크스페이스는 app.lvly.io 가 관리해요. 새 워크스페이스도 거기서 만듭니다.' : '다중 워크스페이스 준비 중이에요(부팅 자동 활성화). 계속 안 되면 관리자 로그를 확인하세요.'));
    if (info.hub) pop.append(el('a', { class: 'v2-wspop-row', href: info.hub, target: '_blank', rel: 'noopener' }, el('span', { class: 'v2-wspop-ic' }, icon('web')), tt('app.lvly.io 에서 만들기', '새 탭으로 열립니다')));
    place(pop, anchor, !!anchor.closest('.v2-side')); return;
  }
  const name = field('워크스페이스 이름');
  const note = el('span', { class: 'v2-wspop-note' });
  const go = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기' }) as HTMLButtonElement;
  const submit = async (): Promise<void> => {
    const v = name.value.trim();
    if (!v) { note.textContent = '이름을 입력하세요.'; name.focus(); return; }
    go.disabled = true; note.textContent = '만드는 중…';
    try {
      const w = await createWorkspace(v, 'personal');
      toast(`'${w.name}' 워크스페이스를 만들었어요.`);
      closePopover(); switchWorkspace(w.slug);   // 만들자마자 그리로 — 빈 목록 앞에서 헤매지 않게
    } catch (e: any) { note.textContent = e?.message || String(e); go.disabled = false; }
  };
  go.onclick = () => void submit();
  name.onkeydown = (e) => { if (e.key === 'Enter' && !(e as any).isComposing) { e.preventDefault(); void submit(); } };
  pop.append(el('div', { class: 'v2-wspop-form' }, name, el('div', { class: 'v2-wspop-actions' }, go, note),
    hint('혼자 시작합니다. 관리자를 포함해 다른 사람에게 보이지 않고, 사람을 부르면 그때 팀이 됩니다.')));
  place(pop, anchor, !!anchor.closest('.v2-side'));
  window.setTimeout(() => name.focus(), 0);
}

/** 워크스페이스 설정(만든 사람만) — 이름 · 연결한 팀(승격 경로, #1750) · 보관. 종전 옛 메뉴의 ✎ ✕ 와 '개인의 것을 올릴 팀'이 여기로 왔다. */
function openSettingsPanel(anchor: HTMLElement, slug: string): void {
  closePopover();
  const w = spaces.find((x) => x.slug === slug);
  const wsName = String(w?.name || slug);
  const pop = el('div', { class: 'v2-wspop v2-wspop--panel', role: 'dialog', 'aria-label': '워크스페이스 설정' }, panelHead('워크스페이스 설정', anchor)) as HTMLElement;

  // 이름
  const name = field('워크스페이스 이름', { value: wsName });
  const nNote = el('span', { class: 'v2-wspop-note' });
  const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '이름 바꾸기', onclick: async () => {
    const v = name.value.trim();
    if (!v || v === wsName) { nNote.textContent = v ? '지금 이름과 같아요.' : '이름을 입력하세요.'; return; }
    try { await renameWorkspace(slug, v); toast(`'${v}' 로 바꿨어요.`); await refreshSpaces(); closePopover(); location.reload(); }
    catch (e: any) { nNote.textContent = e?.message || String(e); }
  } });
  pop.append(sub('이름'), el('div', { class: 'v2-wspop-form' }, name, el('div', { class: 'v2-wspop-actions' }, save, nNote)));

  // 연결한 팀(다른 게이트웨이) — 개인 워크스페이스의 축이다. 팀에서는 이미 연결한 것이 있을 때만 관리용으로 보인다.
  const teamWrap = el('div', { class: 'v2-wspop-teams' });
  const linkForm = el('div', { class: 'v2-wspop-form', hidden: true }) as HTMLElement;
  const url = field('팀 워크스페이스 주소 (https://…)', { type: 'url' });
  const tok = field('그 워크스페이스에서 발급한 내 토큰 (lvk_…)');
  const lNote = el('span', { class: 'v2-wspop-note' });
  const link = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '연결', onclick: async () => {
    if (!url.value.trim() || !tok.value.trim()) { lNote.textContent = '주소와 토큰을 모두 입력하세요.'; return; }
    link.setAttribute('disabled', ''); lNote.textContent = '연결 확인 중…';
    try { const r = await linkTeam(url.value.trim(), tok.value.trim()); toast(`'${r.name}' 에 연결했어요.`); url.value = ''; tok.value = ''; linkForm.hidden = true; await paintTeams(); }
    catch (e: any) { lNote.textContent = e?.message || String(e); }
    finally { link.removeAttribute('disabled'); }
  } }) as HTMLButtonElement;
  linkForm.append(url, tok, el('div', { class: 'v2-wspop-actions' }, link, lNote),
    hint('팀 워크스페이스에서 [내 토큰 발급](memory·context)으로 만든 토큰을 붙여넣으세요. 여기서 만든 지식·프로젝트를 그 팀에 올릴 때 그 토큰으로만 올립니다.'));
  const teamSec = el('div', { hidden: true }, sub('연결한 팀'), teamWrap,
    el('button', { class: 'v2-wspop-row', type: 'button', onclick: () => { linkForm.hidden = !linkForm.hidden; if (!linkForm.hidden) url.focus(); } },
      el('span', { class: 'v2-wspop-ic' }, icon('plus')), tt('팀 워크스페이스 연결', '주소와 토큰으로 — 여기 것을 그 팀에 올립니다')),
    linkForm) as HTMLElement;
  const promoWrap = el('div', { class: 'v2-wspop-teams' });
  pop.append(teamSec, promoWrap);

  const paintTeams = async (): Promise<void> => {
    const links = await linkedTeams();
    const isPersonal = (w?.kind_effective || w?.kind) === 'personal';
    teamSec.hidden = !(isPersonal || links.length > 0);
    teamWrap.replaceChildren(...(links.length ? links.map((l) => el('div', { class: 'v2-wspop-team' },
      el('a', { class: 'v2-wspop-team-open', href: l.base_url, target: '_blank', rel: 'noopener', title: '새 탭으로 엽니다' },
        el('b', { text: String(l.name || l.scope_key) }),
        l.state === 'error' ? el('span', { class: 'v2-wspop-err', title: l.last_error || '연결 오류', text: '연결 오류' }) : null),
      el('button', { class: 'v2-wspop-act' + (l.auto_promote ? ' on' : ''), type: 'button',
        title: l.auto_promote ? '자동 올리기 켜짐 — AI 승격을 바로 반영합니다(눌러서 끔)' : '자동 올리기 꺼짐 — AI 승격은 승인 대기(눌러서 켬)',
        text: l.auto_promote ? '자동 ✓' : '자동',
        onclick: async () => { try { await setAutoPromote(l.base_url, !l.auto_promote); await paintTeams(); } catch (e: any) { toast('바꾸지 못했어요 — ' + (e?.message || e), true); } } }),
      el('button', { class: 'v2-wspop-act', type: 'button', title: '연결 해제', text: '해제',
        onclick: async () => { try { await unlinkTeam(String(l.scope_key)); await paintTeams(); } catch (e: any) { toast('해제하지 못했어요 — ' + (e?.message || e), true); } } })))
      : [hint('아직 연결한 팀이 없어요.')]));
    // 승인 대기 승격 — 사람이 결정할 것이라 여기 보인다.
    const ps = await pendingPromotions();
    promoN = ps.length;
    promoWrap.replaceChildren(...(ps.length ? [sub(`팀으로 올릴 것 · 승인 대기 ${ps.length}`), ...ps.map((p) => {
      const go = async (decision: 'approve' | 'reject'): Promise<void> => {
        try { const r = await resolvePromotion(p.id, decision);
          toast(decision === 'reject' ? '올리기를 취소했어요.' : r.state === 'done' ? '팀 워크스페이스에 올렸어요.' : r.state === 'failed' ? ('올리지 못했어요 — ' + (r.error || '')) : '처리했어요.', r.state === 'failed');
          await paintTeams(); }
        catch (e: any) { toast('처리하지 못했어요 — ' + (e?.message || e), true); }
      };
      return el('div', { class: 'v2-wspop-team' },
        el('span', { class: 'v2-wspop-team-open' }, el('b', { text: String(p.title || p.target_ref) }), el('span', { class: 'v2-wspop-kind', text: p.kind === 'knowledge' ? '지식' : '프로젝트' })),
        el('button', { class: 'btn btn-primary btn-xs', type: 'button', text: '올리기', onclick: () => void go('approve') }),
        el('button', { class: 'btn btn-ghost btn-xs', type: 'button', text: '취소', onclick: () => void go('reject') }));
    })] : []));
  };
  void paintTeams();

  // 보관 — 되돌릴 수 있는 치우기(데이터는 남는다). 위험 톤은 이 한 줄에만.
  pop.append(hr(), el('button', { class: 'v2-wspop-row danger', type: 'button', onclick: async () => {
    if (!confirm(`'${wsName}' 워크스페이스를 보관할까요?\n목록에서 사라지지만 데이터는 지워지지 않아요.`)) return;
    try { await archiveWorkspace(slug); closePopover(); toast(`'${wsName}' 을 보관했어요.`); switchWorkspace('primary'); }
    catch (e: any) { toast('보관하지 못했어요 — ' + (e?.message || e), true); }
  } }, el('span', { class: 'v2-wspop-ic' }, icon('archive')), tt('보관하기', '목록에서 숨깁니다 · 데이터는 남습니다')));
  place(pop, anchor, !!anchor.closest('.v2-side'));
}

/** 목록·인원을 다시 받아 레일을 고쳐 그린다 — 구성원이 바뀌면 문패 부제(팀 · N명)가 따라와야 한다. */
async function refreshSpaces(): Promise<void> {
  const rows = await listWorkspaces();
  if (rows.length) { spaces = rows as any; drawRail(); }
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
  registerWorkspaceMenu(openWorkspacePopover);   // #1875 — 메뉴는 하나: 옛 스위처 메뉴는 레일이 있으면 닿지 않는다
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
  const myName = personName(me);   // 닉네임을 쓰기로 켠 사람은 닉네임으로 불린다(#1813)
  const foot = el('footer', { class: 'v2-rail-foot' },
    item('apps', '앱', 'apps', false, null, () => openLaunchpad()),
    el('button', {
      class: 'v2-rail-it v2-rail-me', type: 'button', 'aria-haspopup': 'dialog', title: '내 프로필 · 환경설정',
      onclick: () => openMeModal({ onSaved: () => drawRail() }),
    },
      //  접속 점은 얼굴 **바깥 껍질**에 단다(#2061) — 얼굴(.v2-ava)은 사진을 원형으로 자르려고 overflow:hidden 이라,
      //   그 안에 ::after 로 달면 원 밖으로 나간 반쪽이 잘린다(실측: 오른쪽 아래가 초승달처럼 깎여 보였다).
      el('span', { class: 'v2-rail-avaw' },
        profileAvatar(me.avatar, myName, me.userId, 'v2-ava', { char: me.avatar_char, color: me.avatar_color })),
      el('span', { class: 'v2-rail-t', text: myName })));

  host.replaceChildren(top, mid, foot);
}

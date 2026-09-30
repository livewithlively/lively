// v2/pane-dock.ts — 곁칸 **독**(#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30).
//
//  원준: "3안으로 갈건데 독 드래그하면 2안 위치에 위치시킬 수도 있게끔. 테두리쪽 원하는 곳 어디든 … 충분히 맥의 독 참고해서
//   모션이나 애니메이션이나 우클릭 기능이나 더보기 눌렀을 때의 화면까지 제대로 한 번에."
//
//  ── 무엇을 하나 ──
//   · 곁칸에 띄울 앱의 문. 고정한 앱(사람이 정한 순서) · 떠 있지만 고정 안 한 앱 · [더보기] — macOS 독의 세 구획.
//   · 누르면 연다. 이미 켜져 있고 여럿 떠 있으면 다음 것으로 돈다(⌘`). ⌥-클릭은 여럿 띄울 수 있는 앱을 하나 더.
//   · 떠 있는 탭 수만큼 아이콘 밑에 점(최대 셋). 켜진 앱의 점은 민트.
//   · 확대(마우스 밑 아이콘과 이웃이 커진다) · 새로 열면 튀어 오른다 · 이름표.
//   · 우클릭: 그 앱의 열린 창 목록 · 새로 열기 · 닫기 · 독에 고정/빼기 · 독 설정(위치 · 모양 · 자동으로 가리기 · 확대).
//   · 아이콘을 끌어 순서를 바꾸고, 독 밖으로 끌어내면 고정이 풀린다(연기처럼 사라진다).
//   · 독 자체는 손잡이(또는 빈 자리)를 끌어 곁칸 네 테두리 어디로든 — 테두리에 바짝 대면 막대(2안), 안쪽이면 떠 있는 알약(3안).
//   · [더보기] = 모든 앱: 곁칸 앱 · 이 세션에 붙일 앱 · 새 탭으로 여는 앱(런치패드의 축소판, 독 아이콘에서 부풀어 나온다).
//
//  ── 규칙은 lib/pane-dock.ts 에 ──
//   누르면 무엇을 할지(dockClick) · 끌어 놓은 자리(placeFromPoint) · 부품이 비키는 폭(dockInset) · 확대 곡선(magnify) · 크기(fitIconSize).
//   이 파일은 그 값을 DOM 에 옮길 뿐이다. 탭 목록·여닫기는 셸(panes.ts)이 host 로 넘긴다 — 이 파일은 배치(lay)를 모른다.
//
//  ── 격리 ──
//   탭마다 곁칸이 한 벌씩 산다(#1819) — 독도 곁칸 하나에 한 벌이고, 신호는 document 가 아니라 제 곁칸에만 건다.
//   설정·고정 목록은 사람의 결정이라 계정에 둔다(shellPrefStore) — 한 곁칸에서 바꾸면 열려 있는 다른 곁칸의 독도 따라온다(live).
import { el } from '../core.js';
import { shellPrefStore, shellPrefsPush } from './shell-prefs.js';
import { ctxMenu, pnIcon, pnIconName } from './panes-kit.js';
import { ctxIsOpen, type CtxRow } from './ctx-menu.js';
import { bindCtx, type CtxResult } from './ctx-registry.js';
import { iconPath } from '../lib/icon-paths.js';
import { appMatches, appRank } from '../lib/app-match.js';
import { appHref, openLaunchpad, visibleApps, type AppDef } from './apps.js';
import { appGlassIcon, builtinAppIcon } from './glass-icon.js';
import { listSessionApps, type SessionApp } from './app-session.js';
import {
  DOCK_DEFAULTS, DOCK_METRICS, appColor, dockClick, dockInset, dockItems, dockPins, dockThickness, fitIconSize, isVertical,
  magnify, movePinBefore, pinSlot, placeFromPoint, readDockPrefs, togglePin, writeDockPins, writeDockPrefs,
  type DockEdge, type DockItem, type DockPlace, type DockPrefs, type DockTab,
} from '../lib/pane-dock.js';

/** 독이 아는 앱 한 가지(곁칸 부품 종류). 셸이 PART_DEFS 에서 만들어 준다. */
export interface DockApp { type: string; name: string; glyph: string; hint: string; multi: boolean; pickable: boolean }
export interface DockHost {
  /** 곁칸 칸(section.pn-pane) — 독은 이 안에 선다. */
  pane: HTMLElement;
  apps(): DockApp[];
  /** 곁칸(과 아래 칸)에 떠 있는 탭 — 탭 줄 순서. */
  tabs(): DockTab[];
  act(): string | null;
  recent(): readonly string[];
  /** 탭 이름(뷰어 = 파일명 · 웹 = 사이트 · 붙은 앱 = 앱 이름). */
  title(key: string): string;
  show(key: string): void;
  open(type: string): void;
  close(key: string): void;
  closeAll(type: string): void;
  curSession(): string | null;
  /** 설치 앱을 지금 세션에 붙인다(#4225). 없으면 [더보기]의 «이 세션에 붙이기» 구획을 안 세운다 — 세션에 앱을 붙이는 수단이 없는 게이트웨이(옛 판)도 독은 쓴다. */
  attach?(app: { id: string; title: string }): Promise<void>;
  /** 좁은 폭(서랍) — 끌기·확대·가리기를 끄고 바닥 가운데에 둔다. */
  narrow(): boolean;
}
export interface DockHandle { sync(): void; destroy(): void }

// ── 계정에 두는 두 저장소 ──────────────────────────────────────────────────────
const PREF_STORE = shellPrefStore('lively_v2_dock', 'map');
const PIN_STORE = shellPrefStore('lively_v2_dock_apps', 'list');
/** 열려 있는 독들 — 한 곁칸에서 설정·고정을 바꾸면 다른 곁칸의 독도 곧바로 따라온다. force = 모양이 같아도 다시 세운다(내가 바꾼 직후). */
const live = new Set<(force: boolean) => void>();
function readJson(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } }
function loadPrefs(): DockPrefs { return readDockPrefs(readJson(PREF_STORE)); }
function savePrefs(p: DockPrefs): void {
  try { localStorage.setItem(PREF_STORE, JSON.stringify(writeDockPrefs(p))); } catch (_) { /* 이번 화면은 된다 */ }
  shellPrefsPush();
  for (const fn of [...live]) fn(true);
}
function savePins(pins: readonly string[]): void {
  const next = JSON.stringify(writeDockPins(pins));
  let prev: string | null = null;
  try { prev = localStorage.getItem(PIN_STORE); } catch (_) { /* 못 읽으면 적는다 */ }
  if (prev === next) { for (const fn of [...live]) fn(true); return; }   // 제자리에 놓았다 — 서버엔 안 보낸다(다시 세우기만)
  try { localStorage.setItem(PIN_STORE, next); } catch (_) { /* 이번 화면은 된다 */ }
  shellPrefsPush();
  for (const fn of [...live]) fn(true);
}
/** 고정 목록을 «적은 적 없음» 으로 — 기본값을 따른다(나중에 기본값이 바뀌면 그것도 따라간다). 서버엔 지움으로 간다(shell-prefs patch null). */
function resetPins(): void {
  try { localStorage.removeItem(PIN_STORE); } catch (_) { /* 이번 화면은 된다 */ }
  shellPrefsPush();
  for (const fn of [...live]) fn(true);
}
/**
 * 설정·고정을 다시 읽어 그린다 — 캐시가 **이 창 안에서** 서버 값으로 바뀌었을 때 셸이 부른다(부팅 동기 · 저장 응답 채택,
 *  main.ts reloadShellPrefs). 같은 창의 localStorage 쓰기는 storage 사건을 안 내므로 독이 스스로는 모른다(#4443 리뷰:
 *  새 기기·캐시를 지운 브라우저에서 독이 다음 다시 그리기까지 기본 자리에 서 있었다).
 */
export function refreshDocks(): void { for (const fn of [...live]) fn(false); }

const M = DOCK_METRICS;
const GAP = 4;
/** 아이콘 한 변 — 떠 있는 알약은 32 까지, 막대는 이름 줄이 있어 26 까지. 모자라면 줄인다(fitIconSize). */
const SIZE = { float: { max: 32, min: 22 }, bar: { max: 26, min: 20 } } as const;
const MAG = 1.6;        // 확대 최대 배율(macOS 기본 확대와 비슷한 정도)
const SEP = 9;          // 구분선이 먹는 자리
const GRIP = 14;        // 손잡이가 먹는 자리
const EDGE_NAME: Record<DockEdge, string> = { bottom: '아래', top: '위', left: '왼쪽', right: '오른쪽' };
const reduced = (): boolean => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
//  any-pointer — 터치 화면 + 트랙패드 노트북처럼 가는 포인터가 **하나라도** 있으면 확대를 켠다(손가락 입력은 pointerType 으로 따로 거른다).
const finePointer = (): boolean => { try { return matchMedia('(any-pointer: fine)').matches; } catch (_) { return true; } };
const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

/** 독 아이콘 — 앱 아이콘과 같은 문법(타일 + 앱 색 선 그림, glass-icon.ts). 그림은 곁칸 부품의 선 아이콘 그대로. */
function tile(glyph: string, color: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'v2-gi pn-dock-gi');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect class="v2-gi-tile" x="1.5" y="1.5" width="61" height="61" rx="16"/>'
    + `<path class="v2-gi-glyph" stroke="var(--gi-c-${color})" transform="translate(14.72 14.72) scale(1.44)" d="${iconPath(pnIconName(glyph), 'apps')}"/>`;
  return svg;
}
const fallbackApp = (type: string): DockApp => ({ type, name: type, glyph: 'apps', hint: '', multi: false, pickable: false });

export function mountDock(host: DockHost): DockHandle {
  let dead = false;
  const pane = host.pane;
  const shelf = el('div', { class: 'pn-dock-shelf' }) as HTMLElement;
  const root = el('div', { class: 'pn-dock', role: 'toolbar', 'aria-label': '사이드바 앱 독' }, shelf) as HTMLElement;
  //  자동 가리기의 손잡이 띠 — 테두리에 손을 대면 독이 나온다. 부품이 액자(웹·앱 화면)면 칸이 포인터를 못 받으므로
  //  칸 위에 얇은 띠를 따로 세운다(칸의 pointermove 로는 액자 위의 손을 못 본다).
  const reveal = el('div', { class: 'pn-dock-reveal', 'aria-hidden': 'true' }) as HTMLElement;
  const tip = el('div', { class: 'pn-dock-tip', role: 'tooltip' }) as HTMLElement;
  tip.hidden = true;
  reveal.hidden = true;
  pane.append(reveal, root, tip);

  let prefs = loadPrefs();
  let size: number = SIZE.float.max;
  let items: DockItem[] = [];
  let sig = '';
  let btns: HTMLElement[] = [];
  let centers: number[] = [];
  let shown = true;
  let hideTimer = 0;
  let dragging = false;
  /** 누르고 있는 끌기(움직이기 전 포함)를 없던 일로 — 끌기는 한 번에 하나(다른 손가락·두 번째 누름은 받지 않는다). */
  let dragOff: (() => void) | null = null;
  let suppressClick = false;
  let pendingBounce: string | null = null;
  let tipFor: HTMLElement | null = null;
  let more: { el: HTMLElement; close(): void; reanchor(b: HTMLElement): void } | null = null;

  const catalog = (): Map<string, DockApp> => new Map(host.apps().map((a) => [a.type, a]));
  //  고정할 수 있는 것 = 이 화면에서 사람이 고를 수 있는 곁칸 앱. [앱] 부품(설치 앱 목록)은 [더보기]가 대신한다 — 두 문을 세우지 않는다.
  const pickIn = (cat: Map<string, DockApp>) => (t: string): boolean => { const a = cat.get(t); return !!a && a.pickable && t !== 'apps'; };
  //  이 판에 있는 종류 — 이 화면에서 못 고르는 것(프로젝트 없는 세션의 태스크·자료…)도 고정 목록에선 제자리를 지킨다(lib dockPins).
  const existsIn = (cat: Map<string, DockApp>) => (t: string): boolean => cat.has(t) && t !== 'apps';
  const pinSet = (cat: Map<string, DockApp> = catalog()): { base: string[]; shown: string[] } => dockPins(readJson(PIN_STORE), existsIn(cat), pickIn(cat));
  /** 지금 쓰는 설정 — 좁은 폭(서랍)은 바닥 가운데에 떠 있게 고정한다(끌 자리도 가릴 자리도 없다). */
  const eff = (): DockPrefs => (host.narrow() ? { ...prefs, edge: 'bottom', at: 0.5, mode: 'float', hide: false } : prefs);
  const barH = (): number => { const b = pane.querySelector(':scope > .pn-tabbar') as HTMLElement | null; return b && !b.hidden ? b.offsetHeight : 0; };
  //  우클릭 메뉴는 셸의 메뉴 엔진이 띄운다(bindCtx) — 떠 있는지는 엔진에게 묻는다.
  const busy = (): boolean => ctxIsOpen() || !!more || dragging;
  const magOn = (p: DockPrefs): boolean => p.mag && p.mode === 'float' && finePointer() && !reduced() && !host.narrow();

  // ── 그리기 ──────────────────────────────────────────────────────────────────
  function render(force = false): void {
    if (dead) return;
    prefs = loadPrefs();
    const p = eff();
    const cat = catalog();
    const pins = pinSet(cat).shown;
    const act = host.act();
    items = dockItems(pins, host.tabs(), act);
    const W = pane.clientWidth, H = pane.clientHeight;
    if (!W || !H) { root.hidden = true; reveal.hidden = true; applyInset(null); sig = ''; return; }   // 접힌 칸 · 숨은 탭
    root.hidden = false;
    const vertical = isVertical(p.edge);
    const nPinned = items.filter((i) => i.pinned).length;
    const seps = (nPinned && items.length > nPinned ? 1 : 0) + (items.length ? 1 : 0);
    const lim = SIZE[p.mode];
    const avail = (vertical ? H - barH() : W) - 2 * M.margin;
    size = fitIconSize(items.length + 1, avail, {
      max: lim.max, min: lim.min, gap: GAP, pad: M.pad,
      grow: magOn(p) ? Math.round(lim.max * (MAG - 1) * 1.7) : 0,
      extra: seps * SEP + (p.mode === 'float' && !host.narrow() ? GRIP : 0),
    });
    const s = [p.edge, p.mode, p.hide, p.mag, p.at, size, W, H, act, host.narrow(), barH(),
      ...items.map((i) => `${i.type}:${i.keys.join(',')}:${i.pinned ? 1 : 0}:${i.active ? 1 : 0}:${i.type === 'sessapp' ? host.title('sessapp') : ''}`)].join('|');
    if (force || s !== sig) {
      sig = s;
      build(p, cat);
      place(p);
      //  [더보기]가 떠 있는 채로 다시 세웠다(다른 창에서 자리를 바꿨거나 창 안의 «독 설정»으로 옮겼다) — 새 단추에서 다시 부풀린다.
      if (more) more.reanchor(btns[btns.length - 1]);
    }
    applyInset(p);
    if (!p.hide) setShown(true); else if (!busy() && !root.matches(':hover, :focus-within')) setShown(false);
    reveal.dataset.edge = p.edge;
    if (pendingBounce) {
      const b = btns.find((x) => x.dataset.type === pendingBounce);
      pendingBounce = null;
      if (b && !reduced()) { b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce'); window.setTimeout(() => b.classList.remove('bounce'), 900); }
    }
  }

  function build(p: DockPrefs, cat: Map<string, DockApp>): void {
    //  키보드 초점이 독 안에 있었다 — 다시 세운 뒤 같은 앱의 새 단추로 돌려준다. 안 돌려주면 초점이 body 로 떨어져
    //   Enter 로 앱을 연 사람이 탭 순서의 맨 앞으로 쫓겨난다(#4443 리뷰 실측: activeElement = BODY). 탭 줄도 같은 일을 한다(panes.ts).
    const ae = document.activeElement as HTMLElement | null;
    const refocus = ae && ae !== document.body && shelf.contains(ae) ? ae.dataset.type ?? null : null;
    hideTip();
    root.dataset.edge = p.edge;
    root.dataset.mode = p.mode;
    root.classList.toggle('mag', magOn(p));
    root.classList.toggle('narrow', host.narrow());
    root.setAttribute('aria-orientation', isVertical(p.edge) ? 'vertical' : 'horizontal');
    root.style.setProperty('--dk-s', size + 'px');
    const kids: HTMLElement[] = [];
    btns = [];
    if (p.mode === 'float' && !host.narrow()) {
      kids.push(el('span', { class: 'pn-dock-grip', title: '끌어서 독을 사이드바 테두리 어디로든 옮겨요 — 테두리에 바짝 대면 막대로 붙어요' }, pnIcon('grip', 'pn-i sm')) as HTMLElement);
    }
    let prevPinned: boolean | null = null;
    for (const it of items) {
      if (prevPinned === true && !it.pinned) kids.push(sepEl());
      prevPinned = it.pinned;
      const b = itemBtn(it, cat.get(it.type) ?? fallbackApp(it.type), p);
      kids.push(b); btns.push(b);
    }
    if (items.length) kids.push(sepEl());
    const mb = moreBtn(p);
    kids.push(mb); btns.push(mb);
    shelf.replaceChildren(...kids);
    //  키보드 — 독은 탭 순서에 한 칸(roving tabindex). 켜진 앱이 그 칸이다(초점을 돌려받는 단추가 있으면 그 단추).
    const back = refocus ? btns.findIndex((b) => b.dataset.type === refocus) : -1;
    const onI = back >= 0 ? back : Math.max(0, btns.findIndex((b) => b.classList.contains('on')));
    btns.forEach((b, i) => { b.tabIndex = i === onI ? 0 : -1; });
    if (back >= 0) btns[back].focus({ preventScroll: true });
  }
  const sepEl = (): HTMLElement => el('span', { class: 'pn-dock-sep', 'aria-hidden': 'true' }) as HTMLElement;

  function itemBtn(it: DockItem, app: DockApp, p: DockPrefs): HTMLElement {
    const name = it.type === 'sessapp' ? host.title('sessapp') : app.name;
    const n = it.keys.length;
    const label = p.mode === 'bar' && !isVertical(p.edge) ? el('span', { class: 'pn-dock-lbl', text: name }) : null;
    const b = el('button', {
      class: 'pn-dock-it' + (it.active ? ' on' : '') + (n ? ' run' : '') + (it.pinned ? ' pin' : ''),
      type: 'button', 'data-type': it.type, style: `--ac: var(--gi-c-${appColor(it.type)})`,
      'aria-label': name + (n > 1 ? ` — 열린 창 ${n}개` : n ? ' — 열려 있음' : ''),
      'aria-pressed': String(it.active),
    },
    el('span', { class: 'pn-dock-ic' }, tile(app.glyph, appColor(it.type))),
    label,
    el('span', { class: 'pn-dock-dots', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(3, n) }, () => el('i')))) as HTMLElement;
    b.dataset.name = name;
    b.addEventListener('click', (e) => onItemClick(e as MouseEvent, it, app));
    //  우클릭 · 메뉴 키(≣ · ⇧F10) · 손가락 길게 누르기 — 셋 다 셸의 메뉴 엔진(ctx-registry)이 받아 이 단추의 행을 띄운다.
    //   #4443 리뷰: 종전엔 독이 제 contextmenu 를 따로 들어서, 메뉴 키로 연 메뉴를 엔진이 곧바로 닫았고(열려 있으면 닫는 토글)
    //   길게 누르면 곁칸 빈 자리 메뉴(«칸에 넣기…»)가 떴다 — 키보드·손가락으로는 고정·빼기·닫기에 닿을 길이 없었다.
    bindCtx(b, () => itemMenu(it, app, name));
    b.addEventListener('pointerdown', (e) => beginItemDrag(e as PointerEvent, b, it));
    b.addEventListener('pointerenter', () => showTip(b));
    b.addEventListener('pointerleave', () => { if (tipFor === b) hideTip(); });
    b.addEventListener('focus', () => showTip(b));
    b.addEventListener('blur', () => { if (tipFor === b) hideTip(); });
    return b;
  }

  function moreBtn(p: DockPrefs): HTMLElement {
    const label = p.mode === 'bar' && !isVertical(p.edge) ? el('span', { class: 'pn-dock-lbl', text: '더보기' }) : null;
    const b = el('button', { class: 'pn-dock-it pn-dock-more-btn', type: 'button', 'data-type': '·more', 'aria-label': '모든 앱', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      el('span', { class: 'pn-dock-ic' }, tile('grid', 'apps')), label, el('span', { class: 'pn-dock-dots', 'aria-hidden': 'true' })) as HTMLElement;
    b.dataset.name = '모든 앱';
    b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } toggleMore(b); });
    bindCtx(b, () => settingsResult());
    b.addEventListener('pointerenter', () => showTip(b));
    b.addEventListener('pointerleave', () => { if (tipFor === b) hideTip(); });
    b.addEventListener('focus', () => showTip(b));
    b.addEventListener('blur', () => { if (tipFor === b) hideTip(); });
    return b;
  }

  /** 자리 — 떠 있는 알약은 테두리를 따라 at 자리(가운데 기준, 테두리 여백 안으로 자른다), 막대는 테두리 전체. */
  function place(p: DockPrefs): void {
    const W = pane.clientWidth, H = pane.clientHeight, top0 = barH();
    const st = root.style;
    st.left = st.top = st.right = st.bottom = st.width = st.height = '';
    if (p.mode === 'bar') {
      const t = dockThickness(p, size) + 'px';
      if (p.edge === 'bottom') { st.left = '0px'; st.right = '0px'; st.bottom = '0px'; st.height = t; }
      else if (p.edge === 'top') { st.left = '0px'; st.right = '0px'; st.top = top0 + 'px'; st.height = t; }
      else { st.top = top0 + 'px'; st.bottom = '0px'; st.width = t; st[p.edge] = '0px'; }
    } else {
      const sw = shelf.offsetWidth, sh = shelf.offsetHeight;
      if (!isVertical(p.edge)) {
        st.left = clamp(p.at * W, M.margin + sw / 2, W - M.margin - sw / 2) + 'px';
        if (p.edge === 'bottom') st.bottom = M.margin + 'px'; else st.top = top0 + M.margin + 'px';
      } else {
        const avail = H - top0;
        st.top = top0 + clamp(p.at * avail, M.margin + sh / 2, avail - M.margin - sh / 2) + 'px';
        st[p.edge] = M.margin + 'px';
      }
    }
    //  확대 전 중심 — 확대는 이 값에서 잰다(아이콘이 커지며 자리가 밀려도 기준이 흔들리지 않게). 독 가운데 기준.
    const r = root.getBoundingClientRect();
    const mid = isVertical(p.edge) ? r.top + r.height / 2 : r.left + r.width / 2;
    centers = btns.map((b) => { const q = b.getBoundingClientRect(); return (isVertical(p.edge) ? q.top + q.height / 2 : q.left + q.width / 2) - mid; });
  }

  /** 부품이 독만큼 물러선다 — 곁칸 본문의 네 여백(CSS 가 읽는다: --pn-dock-b|t|l|r). 가려 두면 0. */
  function applyInset(p: DockPrefs | null): void {
    const z = p ? dockInset(p, size) : { bottom: 0, top: 0, left: 0, right: 0 };
    pane.style.setProperty('--pn-dock-b', z.bottom + 'px');
    pane.style.setProperty('--pn-dock-t', z.top + 'px');
    pane.style.setProperty('--pn-dock-l', z.left + 'px');
    pane.style.setProperty('--pn-dock-r', z.right + 'px');
  }

  // ── 누르기 ──────────────────────────────────────────────────────────────────
  function onItemClick(e: MouseEvent, it: DockItem, app: DockApp): void {
    if (suppressClick) { suppressClick = false; return; }
    const a = dockClick(it, host.act(), host.recent(), { fresh: e.altKey, multi: app.multi });
    if (a.kind === 'open') { pendingBounce = it.type; host.open(it.type); }
    else host.show(a.key);
  }

  // ── 이름표 ──────────────────────────────────────────────────────────────────
  //  막대(가로)는 이름이 이미 보여 안 띄운다. 끌거나 메뉴가 떠 있는 동안에도 안 띄운다.
  function showTip(b: HTMLElement): void {
    const p = eff();
    if ((p.mode === 'bar' && !isVertical(p.edge)) || dragging || ctxIsOpen()) return;
    tipFor = b;
    tip.textContent = b.dataset.name || '';
    tip.dataset.edge = p.edge;
    tip.hidden = false;
    positionTip(b);
  }
  function hideTip(): void { tipFor = null; tip.hidden = true; }
  function positionTip(b: HTMLElement): void {
    const pr = pane.getBoundingClientRect();
    const ic = (b.querySelector('.pn-dock-ic') as HTMLElement | null) ?? b;
    const r = ic.getBoundingClientRect();
    const e = eff().edge;
    //  이름표는 곁칸 안에 선다 — 곁칸이 넘친 것을 자르므로(42-v2-panes.css overflow: clip) 테두리 가까운 아이콘의 긴 이름이
    //   잘리지 않게 가운데를 안쪽으로 당긴다.
    const tw = tip.offsetWidth, th = tip.offsetHeight, W = pr.width, H = pr.height, top0 = barH();
    const cx = clamp(r.left + r.width / 2 - pr.left, tw / 2 + 4, W - tw / 2 - 4);
    const cy = clamp(r.top + r.height / 2 - pr.top, top0 + th / 2 + 4, H - th / 2 - 4);
    tip.style.left = (e === 'left' ? r.right - pr.left + 10 : e === 'right' ? r.left - pr.left - 10 : cx) + 'px';
    tip.style.top = (e === 'bottom' ? r.top - pr.top - 10 : e === 'top' ? r.bottom - pr.top + 10 : cy) + 'px';
  }

  // ── 확대 ────────────────────────────────────────────────────────────────────
  let magRaf = 0;
  let magPos: number | null = null;
  shelf.addEventListener('pointermove', (e: PointerEvent) => {
    if (!root.classList.contains('mag') || dragging || e.pointerType === 'touch') return;
    const r = root.getBoundingClientRect();
    magPos = isVertical(eff().edge) ? e.clientY - (r.top + r.height / 2) : e.clientX - (r.left + r.width / 2);
    if (!magRaf) magRaf = requestAnimationFrame(applyMag);
  });
  shelf.addEventListener('pointerleave', () => { magPos = null; if (!magRaf) magRaf = requestAnimationFrame(applyMag); });
  function applyMag(): void {
    magRaf = 0;
    const range = size * 3.2;
    btns.forEach((b, i) => {
      const sc = magPos == null ? 1 : magnify(magPos - (centers[i] ?? 0), { max: MAG, range });
      b.style.setProperty('--m', sc.toFixed(3));
    });
    root.classList.toggle('magging', magPos != null);
    if (tipFor) positionTip(tipFor);
  }

  // ── 자동으로 가리기 ──────────────────────────────────────────────────────────
  function setShown(v: boolean): void {
    shown = v;
    root.classList.toggle('out', !v);
    reveal.hidden = v || !eff().hide;
  }
  function scheduleHide(): void {
    if (!eff().hide) return;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      //  메뉴·[더보기]·끌기가 떠 있는 동안은 기다렸다가 다시 본다 — 메뉴가 닫힌 뒤 손이 독 밖이면 그때 물러난다(macOS).
      if (busy()) { scheduleHide(); return; }
      if (!root.matches(':hover, :focus-within')) setShown(false);
    }, 650);
  }
  reveal.addEventListener('pointerenter', () => { window.clearTimeout(hideTimer); setShown(true); });
  root.addEventListener('pointerenter', () => window.clearTimeout(hideTimer));
  root.addEventListener('pointerleave', () => scheduleHide());
  root.addEventListener('focusin', () => { window.clearTimeout(hideTimer); if (!shown) setShown(true); });
  root.addEventListener('focusout', (e: FocusEvent) => { if (!root.contains(e.relatedTarget as Node | null)) scheduleHide(); });

  // ── 키보드 — 독 축을 따라 ←→(↑↓) · Home · End. 메뉴 키 · ⇧F10 은 셸의 메뉴 엔진이 받는다(bindCtx) ──────
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const v = isVertical(eff().edge);
    const next = (e.key === (v ? 'ArrowDown' : 'ArrowRight')) ? i + 1 : (e.key === (v ? 'ArrowUp' : 'ArrowLeft')) ? i - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null;
    if (next !== null) {
      e.preventDefault();
      const j = (next + btns.length) % btns.length;
      btns.forEach((b, k) => { b.tabIndex = k === j ? 0 : -1; });
      btns[j].focus();
    }
  });

  // ── 우클릭 ──────────────────────────────────────────────────────────────────
  //  우클릭 · 메뉴 키 · 길게 누르기로 여는 메뉴는 엔진이 띄운다 — 여기서는 행을 만들어 돌려줄 뿐이다(only: 곁칸 빈 자리 메뉴·공통
  //   행을 잇지 않는다 — macOS 독 메뉴처럼 그 앱의 것만). 단추를 눌러 여는 메뉴([더보기]의 «독 설정»)만 여기서 직접 띄운다.
  const menu = (rows: CtxRow[], title: string, sub?: string): CtxResult => { hideTip(); return { rows, title, sub, only: true }; };
  function openMenu(e: MouseEvent, anchor: HTMLElement, rows: CtxRow[], title: string, sub?: string): void {
    const r = anchor.getBoundingClientRect();
    const x = e.clientX || e.clientY ? e.clientX : r.left + r.width / 2;     // 키보드로 누른 단추 — 좌표가 0 이다
    const y = e.clientX || e.clientY ? e.clientY : r.top + r.height / 2;
    hideTip();
    ctxMenu(x, y, rows, { title, sub, onClose: () => scheduleHide() });
  }
  function settingsRows(): CtxRow[] {
    const p = prefs;
    const set = (patch: Partial<DockPrefs>): void => savePrefs({ ...p, ...patch });
    return [
      { label: '위치', icon: 'moveto', sub: (['bottom', 'top', 'left', 'right'] as DockEdge[]).map((e) => ({ label: EDGE_NAME[e], checked: p.edge === e, run: () => set({ edge: e, at: p.edge === e ? p.at : 0.5 }) })) },
      { label: '모양', icon: 'columns', sub: [
        { label: '띄워 두기', hint: '사이드바 위에 떠 있는 알약', checked: p.mode === 'float', run: () => set({ mode: 'float' }) },
        { label: '막대로 붙이기', hint: '테두리에 붙은 막대 · 이름까지', checked: p.mode === 'bar', run: () => set({ mode: 'bar' }) },
      ] },
      { sep: true, label: '' },
      { label: '자동으로 가리기', checked: p.hide, hint: p.hide ? '' : '사이드바 세로를 다 써요', run: () => set({ hide: !p.hide }) },
      { label: '확대', checked: p.mag, run: () => set({ mag: !p.mag }) },
      { sep: true, label: '' },
      //  고정 목록은 «적은 적 없음» 으로 되돌린다 — 오늘의 기본 다섯을 목록으로 박아 두면 나중에 기본값이 바뀌어도 이 사람에겐 안 간다.
      { label: '독 되돌리기', icon: 'undo', hint: '자리 · 고정한 앱', run: () => { resetPins(); savePrefs({ ...DOCK_DEFAULTS }); } },
    ];
  }
  const SETTINGS_SUB = '끌어서 사이드바 테두리 어디로든 옮길 수 있어요';
  /** 독의 빈 자리 · [더보기] 단추의 메뉴 = 독 설정. 좁은 폭(서랍)엔 설정이 없다 — 빈 메뉴로 «여기엔 메뉴가 없다»(곁칸 빈 자리 메뉴도 안 뜬다). */
  const settingsResult = (): CtxResult => (host.narrow() ? { rows: [], title: '독', only: true } : menu(settingsRows(), '독', SETTINGS_SUB));
  function settingsMenu(e: MouseEvent, anchor: HTMLElement): void {
    if (host.narrow()) return;
    openMenu(e, anchor, settingsRows(), '독', SETTINGS_SUB);
  }
  function itemMenu(it: DockItem, app: DockApp, name: string): CtxResult {
    const keys = it.keys;
    const act = host.act();
    const known = pickIn(catalog());
    const rows: CtxRow[] = [];
    //  열린 창 목록 — 누르면 그 창으로(macOS 독 메뉴의 창 목록). 하나뿐이고 여럿 띄울 수 없는 앱이면 목록이 군더더기다.
    if (keys.length > 1 || (keys.length === 1 && app.multi)) {
      rows.push({ head: true, label: '열린 창' });
      for (const k of keys) rows.push({ label: host.title(k), checked: k === act, run: () => host.show(k) });
      rows.push({ sep: true, label: '' });
    }
    if (!keys.length) rows.push({ label: '열기', icon: 'open', run: () => { pendingBounce = it.type; host.open(it.type); } });
    else if (app.multi) rows.push({ label: '새로 열기', icon: 'plus', hint: '⌥ 클릭', run: () => { pendingBounce = it.type; host.open(it.type); } });
    if (keys.length) {
      rows.push(it.type === 'sessapp'
        ? { label: '이 세션에서 떼기', icon: 'x', hint: '앱의 데이터는 그대로', run: () => host.close('sessapp') }
        : { label: keys.length > 1 ? `모두 닫기 · ${keys.length}개` : '닫기', icon: 'x', run: () => host.closeAll(it.type) });
    }
    if (known(it.type)) {
      rows.push({ sep: true, label: '' });
      rows.push({ label: it.pinned ? '독에서 빼기' : '독에 고정', icon: 'pin', hint: it.pinned ? '끌어내도 빠져요' : '', run: () => savePins(togglePin(pinSet().base, it.type)) });
    }
    if (!host.narrow()) rows.push({ sep: true, label: '' }, { label: '독', icon: 'sliders', sub: settingsRows() });
    return menu(rows, name, keys.length > 1 ? `열린 창 ${keys.length}개` : keys.length ? '열려 있어요' : app.hint);
  }
  //  독의 빈 자리(손잡이 · 구분선 · 여백) 우클릭 = 독 설정. 아이콘 위는 아이콘 단추가 먼저 받는다(엔진은 가까운 것부터 찾는다).
  bindCtx(shelf, () => settingsResult());

  // ── 아이콘 끌기 — 순서 바꾸기 · 끌어내 고정 풀기 ──────────────────────────────
  function beginItemDrag(e: PointerEvent, b: HTMLElement, it: DockItem): void {
    if (dragOff || e.button !== 0 || e.pointerType === 'touch' || host.narrow()) return;
    const known = pickIn(catalog());
    if (!known(it.type)) return;                                // 고정할 수 없는 것(뷰어 · 붙은 앱)은 끌 것도 없다
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    const v = isVertical(eff().edge);
    let started = false;
    let ghost: HTMLElement | null = null;
    let caret: HTMLElement | null = null;
    /** 놓으면 이 고정 앱 앞에 선다(null = 고정 줄 맨 뒤) — 번호가 아니라 이웃으로 말한다(lib movePinBefore). undefined = 끼울 자리 없음. */
    let before: string | null | undefined;
    let out = false;
    const pinned = (): HTMLElement[] => btns.filter((x) => x.classList.contains('pin') && x !== b);
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      //  버튼이 떼어진 채 움직인다 — 놓은 곳이 이 문서 밖(액자 · 창 밖)이라 pointerup 을 못 받았다. 없던 일로(탭 끌기와 같은 방어).
      if ((ev.buttons & 1) === 0) { end(false); return; }
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        started = true; dragging = true;
        hideTip(); magPos = null; applyMag();
        document.documentElement.classList.add('pn-dock-dragging');
        const r = (b.querySelector('.pn-dock-ic') as HTMLElement).getBoundingClientRect();
        ghost = el('div', { class: 'pn-dock-ghost' }, (b.querySelector('.pn-dock-gi') as SVGElement).cloneNode(true)) as HTMLElement;
        ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
        document.body.append(ghost);
        caret = el('span', { class: 'pn-dock-caret', 'aria-hidden': 'true' }) as HTMLElement;
        root.append(caret);
        b.classList.add('lifted');
      }
      if (!ghost || !caret) return;
      ghost.style.transform = `translate(${ev.clientX - ghost.offsetWidth / 2}px, ${ev.clientY - ghost.offsetHeight / 2}px)`;
      const sr = shelf.getBoundingClientRect();
      const perp = v ? Math.max(sr.left - ev.clientX, ev.clientX - sr.right, 0) : Math.max(sr.top - ev.clientY, ev.clientY - sr.bottom, 0);
      //  독 밖(44px 너머) — 고정한 앱이면 «빼기»(놓으면 연기처럼), 고정 안 한 앱이면 아무 일도 없다(macOS: 독 안에 놓아야 고정).
      out = perp > 44;
      ghost.classList.toggle('out', out && it.pinned);
      ghost.classList.toggle('away', out && !it.pinned);
      caret.hidden = out;
      before = undefined;
      if (out) return;
      const pos = v ? ev.clientY : ev.clientX;
      const list = pinned();
      const lo = (q: DOMRect): number => (v ? q.top : q.left), hi = (q: DOMRect): number => (v ? q.bottom : q.right);
      //  고정 안 한 앱은 **고정 줄 안으로 들어와야** 고정된다 — 제자리에서 조금 흔든 것은 아무 일도 아니다(lib pinSlot).
      const to = pinSlot(pos, list.map((x) => { const q = x.getBoundingClientRect(); return [lo(q), hi(q)] as const; }), it.pinned, GAP);
      if (to < 0) { caret.hidden = true; return; }
      before = list[to]?.dataset.type ?? null;
      //  끼울 자리 선 — 고정 줄의 to 번째 앞(없으면 마지막 뒤).
      const rr = root.getBoundingClientRect();
      const ref = list[to] ?? list[list.length - 1] ?? b;
      const q = ref.getBoundingClientRect();
      const at = list[to] ? lo(q) - GAP / 2 : hi(q) + GAP / 2;
      caret.dataset.v = v ? '1' : '0';
      if (v) { caret.style.top = at - rr.top + 'px'; caret.style.left = ''; } else { caret.style.left = at - rr.left + 'px'; caret.style.top = ''; }
    };
    const end = (commit: boolean): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      dragOff = null;
      if (!started) return;
      dragging = false;
      document.documentElement.classList.remove('pn-dock-dragging');
      b.classList.remove('lifted');
      caret?.remove();
      const g = ghost;
      if (dead) { g?.remove(); return; }                        // 독이 걷혔다(탭을 닫았다) — 치우기만 하고 아무것도 적지 않는다
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);   // 끌기로 끝난 누름의 click 은 켜기가 아니다
      if (commit && out && it.pinned) {
        //  연기처럼 사라진다(macOS 의 퐁) — 고정이 풀려도 떠 있는 앱이면 뒤 구획에 남는다.
        if (g && !reduced()) { g.classList.add('poof'); window.setTimeout(() => g.remove(), 380); } else g?.remove();
        savePins(togglePin(pinSet().base, it.type));
        return;
      }
      g?.remove();
      if (commit && !out && before !== undefined) savePins(movePinBefore(pinSet().base, it.type, before));
      else render(true);
    };
    const up = (ev: PointerEvent): void => { if (ev.pointerId === pid) end(true); };
    const cancel = (ev: PointerEvent): void => { if (ev.pointerId === pid) end(false); };
    const blur = (): void => end(false);                        // 창을 떠났다(⌘-Tab) — 떼는 순간을 못 본다
    const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    dragOff = () => end(false);
  }

  // ── 독 끌기 — 곁칸 테두리 어디로든 ────────────────────────────────────────────
  //  손잡이나 빈 자리를 잡고 끈다. 끄는 동안 놓일 자리가 윤곽으로 보인다: 테두리에 바짝이면 테두리 전체(막대), 안쪽이면 알약.
  //  놓으면 새 자리로 미끄러져 간다(놓은 자리에서 새 자리까지 — FLIP).
  shelf.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.pn-dock-it')) return;
    beginDockDrag(e);
  });
  function beginDockDrag(e: PointerEvent): void {
    if (dragOff || e.button !== 0 || e.pointerType === 'touch' || host.narrow()) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let started = false;
    let target: DockPlace | null = null;
    const preview = el('div', { class: 'pn-dock-preview' }, el('span', { class: 'pn-dock-preview-t' })) as HTMLElement;
    const drop = el('div', { class: 'pn-dock-drop', 'aria-hidden': 'true' }, preview) as HTMLElement;
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      //  떼는 순간을 못 봤다(액자 · 창 밖에서 놓았다) — 없던 일로. 그대로 두면 끌기 상태(액자 포인터 막기 포함)가 남고
      //   다음의 아무 누름이 이 끌기를 «놓기» 로 끝냈다(#4443 리뷰 실측: edge=left 로 저장됐다).
      if ((ev.buttons & 1) === 0) { end(false); return; }
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        started = true; dragging = true;
        hideTip(); magPos = null; applyMag();
        more?.close();
        root.classList.add('moving');
        document.documentElement.classList.add('pn-dock-dragging');
        pane.append(drop);
      }
      root.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
      const pr = pane.getBoundingClientRect();
      const top0 = barH();
      target = placeFromPoint(ev.clientX, ev.clientY, { left: pr.left, top: pr.top + top0, width: pr.width, height: pr.height - top0 });
      drawPreview(preview, target);
    };
    const end = (commit: boolean): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      dragOff = null;
      if (!started) return;
      dragging = false;
      document.documentElement.classList.remove('pn-dock-dragging');
      drop.remove();
      const from = root.getBoundingClientRect();
      root.classList.remove('moving');
      root.style.transform = '';
      if (dead) return;                                         // 독이 걷혔다 — 치우기만 하고 자리를 적지 않는다
      if (commit && target) {
        savePrefs({ ...prefs, ...target });                     // → live → render(true) 가 새 자리에 세운다
        glideFrom(from);
      } else {
        glideFrom(from);                                        // 없던 일 — 제자리로 미끄러져 돌아간다
      }
    };
    const up = (ev: PointerEvent): void => { if (ev.pointerId === pid) end(true); };
    const cancel = (ev: PointerEvent): void => { if (ev.pointerId === pid) end(false); };
    const blur = (): void => end(false);
    const key = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    dragOff = () => end(false);
  }
  /** 놓일 자리의 윤곽 — 곁칸 좌표. 막대는 테두리 전체, 알약은 지금 독 길이로 그 자리에. */
  function drawPreview(pv: HTMLElement, t: DockPlace): void {
    const W = pane.clientWidth, H = pane.clientHeight, top0 = barH();
    const vNow = isVertical(eff().edge);
    const len = vNow ? shelf.offsetHeight : shelf.offsetWidth;
    const lim = SIZE[t.mode];
    const s = Math.min(lim.max, Math.max(lim.min, size));
    const thick = t.mode === 'bar' ? dockThickness(t, s) : s + 2 * M.pad + M.dot;
    let x = 0, y = 0, w = 0, h = 0;
    if (t.mode === 'bar') {
      if (t.edge === 'bottom') { x = 0; y = H - thick; w = W; h = thick; }
      else if (t.edge === 'top') { x = 0; y = top0; w = W; h = thick; }
      else { y = top0; h = H - top0; w = thick; x = t.edge === 'left' ? 0 : W - thick; }
    } else if (!isVertical(t.edge)) {
      w = Math.min(len, W - 2 * M.margin); h = thick;
      x = clamp(t.at * W - w / 2, M.margin, W - M.margin - w);
      y = t.edge === 'bottom' ? H - M.margin - h : top0 + M.margin;
    } else {
      h = Math.min(len, H - top0 - 2 * M.margin); w = thick;
      y = top0 + clamp(t.at * (H - top0) - h / 2, M.margin, H - top0 - M.margin - h);
      x = t.edge === 'left' ? M.margin : W - M.margin - w;
    }
    Object.assign(pv.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    pv.dataset.mode = t.mode;
    pv.dataset.edge = t.edge;
    (pv.firstElementChild as HTMLElement).textContent = t.mode === 'bar' ? `${EDGE_NAME[t.edge]} 막대로 붙이기` : `${EDGE_NAME[t.edge]}에 띄우기`;
  }
  /** from(화면 좌표의 옛 자리)에서 지금 자리로 미끄러진다 — 가운데끼리 잇는다(방향이 바뀌어도 어색하지 않게). */
  function glideFrom(from: DOMRect): void {
    render(true);
    if (reduced()) return;
    const to = root.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    root.classList.remove('glide');
    root.style.transform = `translate(${dx}px, ${dy}px)`;
    void root.offsetWidth;
    root.classList.add('glide');
    root.style.transform = '';
    window.setTimeout(() => root.classList.remove('glide'), 420);
  }

  // ── 더보기 — 모든 앱 ────────────────────────────────────────────────────────
  function toggleMore(anchor: HTMLElement): void {
    if (more) { more.close(); return; }
    more = openMore(anchor);
  }
  function openMore(first: HTMLElement): { el: HTMLElement; close(): void; reanchor(b: HTMLElement): void } {
    hideTip();
    window.clearTimeout(hideTimer);
    //  부풀어 나온 단추 — 독을 다시 세우면(자리를 옮겼다) 새 단추로 갈아 끼운다(reanchor).
    let anchor = first;
    const cat = catalog();
    const known = pickIn(cat);
    const input = el('input', { class: 'pn-dock-more-q', type: 'search', placeholder: '앱 찾기', 'aria-label': '앱 찾기', spellcheck: 'false' }) as HTMLInputElement;
    const body = el('div', { class: 'pn-dock-more-b' }) as HTMLElement;
    const setBtn = el('button', { class: 'btn-text', type: 'button', text: '독 설정' }) as HTMLElement;
    const padBtn = el('button', { class: 'btn-text', type: 'button', text: '전체 앱 화면' }) as HTMLElement;
    const panel = el('div', { class: 'pn-dock-more', role: 'dialog', 'aria-label': '모든 앱' },
      el('div', { class: 'pn-dock-more-h' }, pnIcon('search', 'pn-i sm'), input),
      body,
      el('div', { class: 'pn-dock-more-f' }, setBtn, padBtn)) as HTMLElement;
    let sApps: SessionApp[] | null = null;
    let closed = false;

    const section = (title: string, note: string, tiles: HTMLElement[]): HTMLElement =>
      el('section', { class: 'pn-dock-more-sec' },
        el('div', { class: 'pn-dock-more-sh' }, el('b', { text: title }), el('span', { class: 'pn-fine', text: note })),
        tiles.length ? el('div', { class: 'pn-dock-more-grid' }, ...tiles) : null) as HTMLElement;
    const tileBtn = (o: { ic: SVGElement; name: string; hint?: string; pin?: boolean; run?: number; off?: boolean; onClick: () => void; menu?: () => CtxResult }): HTMLElement => {
      const b = el('button', { class: 'pn-dock-tile' + (o.pin ? ' pin' : '') + (o.run ? ' run' : ''), type: 'button', disabled: !!o.off, title: o.hint || o.name },
        el('span', { class: 'pn-dock-tile-ic' }, o.ic),
        el('span', { class: 'pn-dock-tile-n', text: o.name }),
        el('span', { class: 'pn-dock-tile-dot', 'aria-hidden': 'true' })) as HTMLElement;
      b.addEventListener('click', o.onClick);
      if (o.menu) bindCtx(b, o.menu);                               // 우클릭 · 메뉴 키 · 길게 누르기(독 아이콘과 같은 길)
      return b;
    };
    const openSide = (type: string): void => {
      close();
      const it = items.find((i) => i.type === type) ?? { type, pinned: false, keys: [], active: false };
      const a = dockClick(it, host.act(), host.recent());
      if (a.kind === 'open') { pendingBounce = type; host.open(type); } else host.show(a.key);
    };
    const draw = (): void => {
      const q = input.value.trim();
      const run = new Map(items.map((i) => [i.type, i.keys.length]));
      const pins = pinSet(cat).shown;
      const byQ = <T extends { title: string; desc: string }>(xs: T[]): T[] => (q ? xs.filter((x) => appMatches(x, q)).sort((a, b) => appRank(a, q) - appRank(b, q)) : xs);
      //  ① 곁칸 앱 — 누르면 곁칸에 열린다. 우클릭: 독에 고정/빼기 · 새로 열기.
      const side = byQ([...cat.values()].filter((a) => known(a.type)).map((a) => ({ ...a, title: a.name, desc: a.hint })));
      const secSide = side.length ? section('사이드바 앱', '누르면 사이드바에 열려요 · 우클릭으로 독에 고정', side.map((a) => tileBtn({
        ic: tile(a.glyph, appColor(a.type)), name: a.name, hint: a.hint, pin: pins.includes(a.type), run: run.get(a.type) || 0,
        onClick: () => openSide(a.type),
        menu: () => menu([
          { label: '열기', icon: 'open', run: () => openSide(a.type) },
          ...(a.multi && (run.get(a.type) || 0) ? [{ label: '새로 열기', icon: 'plus', run: () => { close(); pendingBounce = a.type; host.open(a.type); } }] : []),
          { sep: true, label: '' },
          { label: pins.includes(a.type) ? '독에서 빼기' : '독에 고정', icon: 'pin', run: () => { savePins(togglePin(pinSet().base, a.type)); draw(); } },
        ], a.name, a.hint),
      }))) : null;
      //  ② 이 세션에 붙일 앱 — 화면이 있거나 AI 가 쓸 데이터가 있는 설치 앱(시스템 앱 제외). 붙으면 곁칸에 그 앱 탭이 선다.
      const sid = host.curSession();
      const att = (sApps ?? []).filter((a) => a.id !== 'ai-session' && !a.system && (a.pages.length > 0 || a.tables.length > 0));
      const attQ = byQ(att.map((a) => ({ ...a, desc: a.id })));
      const secAtt = !host.attach ? null : sApps === null ? section('이 세션에 붙이기', '불러오는 중…', [])
        : attQ.length ? section('이 세션에 붙이기', sid ? 'AI 도 같이 써요 · 누르면 사이드바에 붙어요' : '세션을 열면 붙일 수 있어요', attQ.map((a) => tileBtn({
          ic: appGlassIcon(builtinAppIcon(a.id, a.pages.length > 0)), name: a.title, off: !sid,
          hint: sid ? `「${a.title}」을(를) 이 세션에 붙여요` : '세션을 열면 붙일 수 있어요',
          onClick: () => { close(); void host.attach?.({ id: a.id, title: a.title }); },
        }))) : null;
      //  ③ 새 탭으로 여는 앱 — 런치패드와 같은 표(visibleApps). 곁칸이 아니라 위쪽 탭에 열린다.
      const full = byQ(visibleApps());
      const secFull = full.length ? section('새 탭으로 여는 앱', '사이드바가 아니라 위쪽 탭에 열려요', full.map((a) => fullTile(a))) : null;
      body.replaceChildren(...[secSide, secAtt, secFull].filter(Boolean) as HTMLElement[]);
      if (!body.querySelector('.pn-dock-tile')) body.append(el('p', { class: 'pn-fine pn-dock-more-none', text: q ? `「${q}」에 맞는 앱이 없어요.` : '열 수 있는 앱이 없어요.' }));
    };
    const fullTile = (a: AppDef): HTMLElement => el('a', { class: 'pn-dock-tile', href: appHref(a), title: a.desc, onclick: () => close() },
      el('span', { class: 'pn-dock-tile-ic' }, appGlassIcon(a.icon)),
      el('span', { class: 'pn-dock-tile-n', text: a.title }),
      el('span', { class: 'pn-dock-tile-dot', 'aria-hidden': 'true' })) as HTMLElement;

    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.isComposing) return;                                  // 한글 조합 중의 Enter 는 확정이다
      if (e.key === 'Enter') { e.preventDefault(); (body.querySelector('.pn-dock-tile:not([disabled])') as HTMLElement | null)?.click(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (body.querySelector('.pn-dock-tile:not([disabled])') as HTMLElement | null)?.focus(); }
    });
    //  격자 안에서 화살표로 옮겨 다닌다(한 줄 = 격자 열 수).
    body.addEventListener('keydown', (e: KeyboardEvent) => {
      const tiles = [...body.querySelectorAll('.pn-dock-tile:not([disabled])')] as HTMLElement[];
      const i = tiles.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const grid = (document.activeElement as HTMLElement).parentElement as HTMLElement;
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
      if (!d) return;
      e.preventDefault();
      if (i + d < 0) { input.focus(); return; }
      tiles[Math.min(tiles.length - 1, i + d)]?.focus();
    });
    setBtn.addEventListener('click', (e) => settingsMenu(e as MouseEvent, setBtn));
    padBtn.addEventListener('click', () => { close(); openLaunchpad(); });

    positionMore(panel, anchor);
    pane.append(panel);
    anchor.setAttribute('aria-expanded', 'true');
    root.classList.add('more-open');
    draw();
    requestAnimationFrame(() => { if (!closed) panel.classList.add('open'); });
    input.focus({ preventScroll: true });
    if (host.attach) void listSessionApps().then((a) => { sApps = a; if (!closed) draw(); }).catch(() => { sApps = []; if (!closed) draw(); });

    const onDown = (ev: PointerEvent): void => {
      const t = ev.target as Element | null;
      if (!t || panel.contains(t) || anchor.contains(t) || t.closest?.('.pn-ctx')) return;
      close();
    };
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); close(); anchor.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', onDown, true);
    panel.addEventListener('keydown', onKey);
    function close(): void {
      if (closed) return;
      closed = true;
      document.removeEventListener('pointerdown', onDown, true);
      panel.classList.remove('open');
      panel.classList.add('closing');
      window.setTimeout(() => panel.remove(), reduced() ? 0 : 170);
      anchor.setAttribute('aria-expanded', 'false');
      root.classList.remove('more-open');
      if (more && more.el === panel) more = null;
      scheduleHide();
    }
    function reanchor(b: HTMLElement): void {
      if (closed || !b) return;
      anchor = b;
      b.setAttribute('aria-expanded', 'true');
      positionMore(panel, b);
    }
    return { el: panel, close, reanchor };
  }
  /** [더보기] 창의 자리 — 독 아이콘에서 곁칸 안쪽으로 부풀어 나온다(아래 독이면 위로, 오른쪽 독이면 왼쪽으로). */
  function positionMore(panel: HTMLElement, anchor: HTMLElement): void {
    const e = eff().edge;
    const pr = pane.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const W = pr.width, H = pr.height, top0 = barH();
    const gap = 10;
    const w = Math.max(200, Math.min(W - 16, 344));
    const st = panel.style;
    st.left = st.right = st.top = st.bottom = '';                  // 다시 부풀릴 때(reanchor) 옛 테두리의 자리가 남지 않게
    st.width = w + 'px';
    const ax = ar.left - pr.left + ar.width / 2, ay = ar.top - pr.top + ar.height / 2;
    if (e === 'bottom' || e === 'top') {
      const left = clamp(ax - w / 2, 8, W - 8 - w);
      st.left = left + 'px';
      if (e === 'bottom') { st.bottom = H - (ar.top - pr.top) + gap + 'px'; st.maxHeight = Math.max(160, ar.top - pr.top - top0 - gap - 8) + 'px'; }
      else { st.top = ar.bottom - pr.top + gap + 'px'; st.maxHeight = Math.max(160, H - (ar.bottom - pr.top) - gap - 8) + 'px'; }
      st.setProperty('--ox', ax - left + 'px');
      st.setProperty('--oy', e === 'bottom' ? '100%' : '0%');
    } else {
      if (e === 'left') st.left = ar.right - pr.left + gap + 'px'; else st.right = W - (ar.left - pr.left) + gap + 'px';
      const avail = H - top0 - 16;
      const top = clamp(ay - avail / 2, top0 + 8, H - 8 - avail);
      st.top = top + 'px';
      st.maxHeight = avail + 'px';
      st.setProperty('--ox', e === 'left' ? '0%' : '100%');
      st.setProperty('--oy', ay - top + 'px');
    }
    panel.dataset.edge = e;
  }

  // ── 살아 있는 동안 ──────────────────────────────────────────────────────────
  const onLive = (force: boolean): void => { if (!dead && !dragging) render(force); };
  live.add(onLive);
  const onStorage = (e: StorageEvent): void => { if (e.key === PREF_STORE || e.key === PIN_STORE) onLive(false); };
  window.addEventListener('storage', onStorage);
  let roRaf = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (roRaf) return;
    roRaf = requestAnimationFrame(() => { roRaf = 0; if (!dragging) render(); });
  }) : null;
  ro?.observe(pane);

  render(true);
  return {
    sync(): void { if (!dragging) render(); },
    destroy(): void {
      dead = true;
      dragOff?.();                                              // 끄는 중에 걷혔다 — 치우기만 한다(dead 라 놓아도 아무것도 적지 않는다)
      live.delete(onLive);
      window.removeEventListener('storage', onStorage);
      ro?.disconnect();
      if (roRaf) cancelAnimationFrame(roRaf);
      if (magRaf) cancelAnimationFrame(magRaf);
      window.clearTimeout(hideTimer);
      more?.close();
      root.remove(); reveal.remove(); tip.remove();
      applyInset(null);
      document.documentElement.classList.remove('pn-dock-dragging');
    },
  };
}

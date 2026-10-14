// v2/pane-dock.ts — 곁칸 **독**(#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30 → 10-01).
//
//  원준(10-01, 바로잡음): "디폴트로 4안(이음매 독)이고 끌어당겨서 3안에 둘 수 있는 걸로 하고 싶은거야. 그리고 아래에 뒀을 때는
//   곁칸 사이즈 변하는거에 따라서 독 사이즈도 바꾸고 싶음. 너가 바닥 왼쪽 탭 만든건 없애줘 일단은. 그리고 좀 더 이쁘게 … 맥 os 참고해서."
//
//  ── 무엇을 하나 ──
//   · 곁칸에 띄울 앱의 문. 고정한 앱(사람이 정한 순서) · 떠 있지만 고정 안 한 앱 · [더보기] — macOS 독의 세 구획.
//   · 서는 곳은 둘(lib/pane-dock DockHome):
//       ④ 이음매(기본) — 세션과 곁칸 사이 경계선 위에 걸친 짧은 세로 유리 알약. 경계선을 따라 위아래 자리를 고른다.
//       ③ 곁칸 아래   — 곁칸 바닥에 떠 있는 유리 알약. 곁칸 폭을 따라 아이콘이 커지고 작아진다.
//     알약의 끝 여백 · 구분선 · 빈 자리를 잡고 끌면 옮긴다(곁칸 안쪽으로 깊이 들이면 곁칸 아래, 경계선 가까이면 이음매).
//     손잡이(⋮⋮)는 두지 않는다(원준 10-01 «없애줘») — macOS 독처럼 알약 자체가 손잡이고, 우클릭 › 독 › 위치로도 옮긴다.
//   · 누르면 연다. 이미 켜져 있고 여럿 떠 있으면 다음 것으로 돈다(⌘`). ⌥-클릭은 여럿 띄울 수 있는 앱을 하나 더.
//   · 떠 있는 탭 수만큼 아이콘 밑에 점(최대 셋). 켜진 앱의 점은 민트.
//   · 확대(마우스 밑 아이콘과 이웃이 커진다) · 새로 열면 튀어 오른다 · 꼬리 달린 이름표(macOS).
//   · 우클릭 · 메뉴 키 · 길게 누르기: 그 앱의 열린 창 목록 · 새로 열기 · 닫기 · 독에 고정/빼기 · 독 설정(위치 · 확대 · 되돌리기).
//   · 아이콘을 끌어 순서를 바꾸고, 독 밖으로 끌어내면 고정이 풀린다(연기처럼 사라진다).
//   · [더보기] = 모든 앱: 곁칸 앱 · 이 세션에 붙일 앱 · 새 탭으로 여는 앱(런치패드의 축소판, 독 아이콘에서 부풀어 나온다).
//
//  ── 어디에 붙나 ──
//   이음매 독은 경계선 위에 걸쳐 세션 쪽으로도 반쯤 나온다 — 곁칸은 넘친 것을 자르므로(42-v2-panes.css overflow: clip)
//   곁칸 밖, 곁칸의 부모(.pn-body: 세션 열 · 분할선 · 곁칸의 격자)에 붙는다. 곁칸 아래 독 · 좁은 폭(서랍)은 곁칸 안에 붙는다.
//   자리가 바뀌면 붙는 곳도 옮겨 간다(ensureLayer). 이름표 · [더보기]도 독과 같은 곳에 붙는다.
//
//  ── 규칙은 lib/pane-dock.ts 에 ──
//   누르면 무엇을 할지(dockClick) · 끌어 놓은 곳(placeDock) · 부품이 비키는 폭(dockInset) · 확대 곡선(magnify) · 크기(fitIconSize · floatIconSize).
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
import { appGlyphName, iconPath } from '../lib/icon-paths.js';
import { appMatches, appRank } from '../lib/app-match.js';
import { openLaunchpad } from './apps.js';
import { appGlassIcon, builtinAppIcon } from './glass-icon.js';
import { listSessionApps, type SessionApp } from './app-session.js';
import {
  DOCK_DEFAULTS, DOCK_METRICS, MAG_GROW, appColor, dockClick, dockInset, dockItems, dockPins, dockThickness, effectiveHome, fitIconSize, floatAt, floatCenter, floatIconSize,
  magnify, movePinBefore, pinSlot, placeDock, readDockPrefs, togglePin, writeDockPins, writeDockPrefs,
  type DockGeom, type DockHome, type DockItem, type DockPrefs, type DockTab,
} from '../lib/pane-dock.js';

/** 독이 아는 앱 한 가지(곁칸 부품 종류). 셸이 PART_DEFS 에서 만들어 준다. */
export interface DockApp { type: string; name: string; glyph: string; hint: string; multi: boolean; pickable: boolean }
export interface DockHost {
  /** 곁칸 칸(section.pn-pane). 곁칸 아래 독은 이 안에, 이음매 독은 이 칸의 부모(.pn-body)에 선다. */
  pane: HTMLElement;
  apps(): DockApp[];
  /** 곁칸(과 아래 칸)에 떠 있는 탭 — 탭 줄 순서. */
  tabs(): DockTab[];
  act(): string | null;
  recent(): readonly string[];
  /** 탭 이름(뷰어 = 파일명 · 웹 = 사이트 · 붙은 앱 = 앱 이름). */
  title(key: string): string;
  /** 그 탭이 단 얼굴(앱 아이콘 이름 — 그림과 색이 한 이름) 또는 null. 붙은 앱이 쓴다(#4592): 독의 그 칸이 «앱» 의 네모 넷이 아니라 그 앱의 아이콘으로 선다. */
  face?(key: string): string | null;
  show(key: string): void;
  open(type: string): void;
  close(key: string): void;
  closeAll(type: string): void;
  curSession(): string | null;
  /** 설치 앱을 지금 세션에 붙인다(#4225). 없으면 [더보기]의 «이 세션에 붙이기» 구획을 안 세운다 — 세션에 앱을 붙이는 수단이 없는 게이트웨이(옛 판)도 독은 쓴다. */
  attach?(app: { id: string; title: string }): Promise<void>;
  /** 세션과 곁칸 사이 경계선(분할선) — 이음매 독이 여기에 걸친다. 없으면(좁은 폭의 서랍 · 카드 모드 · 접힘) null → 곁칸 아래. */
  seam?(): HTMLElement | null;
  /** 좁은 폭(서랍) — 끌기·확대를 끄고 곁칸 아래 가운데에 둔다. */
  narrow(): boolean;
  /** 독을 세우지 않는다(#4443 폰 · 눕힌 폰의 서랍). 서랍 위 탭 줄과 그 [＋] 가 같은 일을 하고, 독이 가리는 80px 은
   *  폰(보이는 높이 672)에서 화면의 12% 다. 없으면 늘 세운다(옛 배선). */
  off?(): boolean;
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
/** 아이콘 한 변 — 이음매는 22~32(짧은 알약), 곁칸 아래는 곁칸 폭을 따라 26~48(floatIconSize). */
const SIZE = { seam: { min: 22, max: 32 }, float: { min: 26, max: 48 } } as const;
const DOT_ROW = M.dot;  // 아이콘 밑 점 줄(점 4 + 사이 2) — 이음매 독에선 아이콘마다 알약 길이에 든다
const MAG = 1.6;        // 확대 최대 배율(macOS 기본 확대와 비슷한 정도)
const SEP = 9;          // 구분선이 먹는 자리
const NEAR = 40;        // 곁칸 안쪽으로 이만큼 넘게 들여 놓아야 곁칸 아래(그보다 가까우면 이음매)
//  이음매 독 맨 위의 손잡이(원준 10-01: «위쪽에 핸들같은거 만들어서 그거 잡고 끌어당길 수 있는») — 알약 길이에 더하는 몫
//   = 손잡이 14 + 아이콘과의 사이 4 − 줄인 위 안 여백 7(10 → 3). 42-v2-dock.css .pn-dock-handle 과 짝.
const HANDLE = 11;
//  곁칸 아래 독의 손잡이(원준 10-02: «아래에 가있을 때에는 … 핸들이 없는거야? 이음새 있을 때랑 똑같이») — 알약 왼쪽 끝, 같은 막대를 세운 것.
//   알약 폭에 더하는 몫 = 손잡이 14 + 아이콘과의 사이 4 − 줄인 왼쪽 안 여백 5(8 → 3). 42-v2-dock.css 와 짝.
const HANDLE_FLOAT = 13;
const HOME_NAME: Record<DockHome, string> = { seam: '이음매', float: '사이드바 아래' };
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
/** 앱 타일 그림 — 독 · ⊞ · 곁칸 탭 줄 [＋] 의 앱 서랍(v2/pane-drawer)이 같은 그림을 쓴다(#4443). glyph = 부품의 아이콘 이름. */
export function dockTile(glyph: string, type: string): SVGElement { return tile(glyph, appColor(type)); }

export function mountDock(host: DockHost): DockHandle {
  let dead = false;
  const pane = host.pane;
  const shelf = el('div', { class: 'pn-dock-shelf' }) as HTMLElement;
  //  뿌리 = 크기 없는 «자리 점». 선반(알약)이 그 점에 매달린다 — 이음매면 점이 알약 한가운데, 곁칸 아래면 알약 바닥 가운데.
  //   그래서 확대로 불어나도 양쪽으로 똑같이 번지고 가운데가 안 흔들린다(42-v2-dock.css).
  const root = el('div', { class: 'pn-dock', role: 'toolbar', 'aria-label': '사이드바 앱 독' }, shelf) as HTMLElement;
  const tip = el('div', { class: 'pn-dock-tip', role: 'tooltip' }) as HTMLElement;
  tip.hidden = true;
  pane.append(root, tip);

  let prefs = loadPrefs();
  let home: DockHome = 'float';
  let size: number = SIZE.float.max;
  /** 곁칸 아래 알약의 폭(확대 전) — 좌우 자리를 이 폭으로 잰다(확대 중의 실제 폭으로 재면 자리가 흔들린다). */
  let floatW = 0;
  let items: DockItem[] = [];
  let sig = '';
  let btns: HTMLElement[] = [];
  let centers: number[] = [];
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
  const barH = (): number => { const b = pane.querySelector(':scope > .pn-tabbar') as HTMLElement | null; return b && !b.hidden ? b.offsetHeight : 0; };
  const magOn = (): boolean => prefs.mag && finePointer() && !reduced() && !host.narrow();
  const vertical = (): boolean => home === 'seam';
  /** 곁칸 아래 알약의 폭 — 아이콘 n 개 + 간격 + 안 여백 + 구분선 · 손잡이 몫(extra). 42-v2-dock.css 의 선반과 짝. */
  const floatWidth = (n: number, s: number, extra: number): number => n * s + GAP * (n - 1) + 2 * (M.pad + 2) + extra;

  // ── 이음매 — 세션과 곁칸 사이 경계선 ─────────────────────────────────────────
  /** 이음매 독이 붙는 곳 = 곁칸의 부모(.pn-body). 경계선이 없거나 좁은 폭이면 없다. */
  function seamEl(): HTMLElement | null {
    if (host.narrow() || !pane.parentElement) return null;
    const s = host.seam ? host.seam() : null;
    if (!s || s.hidden) return null;
    const r = s.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? s : null;                // 카드 모드는 분할선이 display:none(크기 0)
  }
  /** 이음매의 화면 좌표 — 경계선 x · 곁칸이 어느 쪽인가 · 독이 설 세로 구간(곁칸 머리 줄 아래 ~ 바닥). */
  function seamGeom(): DockGeom | null {
    const s = seamEl();
    if (!s) return null;
    const sr = s.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    const x = sr.left + sr.width / 2;
    return { seam: x, side: pr.left + pr.width / 2 >= x ? 'right' : 'left', top: pr.top + barH(), bottom: pr.bottom };
  }
  /** 독(과 이름표 · [더보기])이 붙는 곳 — 이음매면 곁칸의 부모, 곁칸 아래면 곁칸. */
  const layerOf = (h: DockHome): HTMLElement => (h === 'seam' && pane.parentElement ? pane.parentElement : pane);
  function ensureLayer(h: DockHome): void {
    const layer = layerOf(h);
    if (root.parentElement === layer) return;
    more?.close();                                                  // 붙는 곳이 바뀌었다 — 옛 자리의 창은 닫는다
    hideTip();
    layer.append(root, tip);
  }

  // ── 그리기 ──────────────────────────────────────────────────────────────────
  function render(force = false): void {
    if (dead) return;
    prefs = loadPrefs();
    const cat = catalog();
    const pins = pinSet(cat).shown;
    const act = host.act();
    items = dockItems(pins, host.tabs(), act);
    const W = pane.clientWidth, H = pane.clientHeight;
    const off = !!host.off?.();
    if (off) more?.close();                                         // 폰으로 좁혔거나 눕혔다. 떠 있던 [더보기] 도 걷는다
    if (!W || !H || off) { root.hidden = true; tip.hidden = true; applyInset(null); sig = ''; return; }   // 접힌 칸 · 숨은 탭 · 독을 안 세우는 화면
    root.hidden = false;
    const geom = seamGeom();
    home = effectiveHome(prefs, !!geom);
    ensureLayer(home);
    const n = items.length + 1;
    const nPinned = items.filter((i) => i.pinned).length;
    const extra = ((nPinned && items.length > nPinned ? 1 : 0) + (items.length ? 1 : 0)) * SEP;
    //  확대로 불어날 몫을 미리 남긴다 — 곁칸 아래는 곁칸 폭 안에(넘치면 곁칸 테두리에서 잘린다), 이음매는 세로 구간 안에.
    const grow = magOn() ? MAG_GROW : 0;
    size = home === 'float'
      ? floatIconSize(W, n, { min: SIZE.float.min, max: SIZE.float.max, gap: GAP, pad: M.pad + 2, margin: M.margin, extra: extra + (host.narrow() ? 0 : HANDLE_FLOAT), grow })
      : fitIconSize(n, Math.max(0, (geom!.bottom - geom!.top) * 0.8), { min: SIZE.seam.min, max: SIZE.seam.max, gap: GAP + DOT_ROW, pad: M.pad + 4, grow: Math.round(SIZE.seam.max * grow), extra: extra + (host.narrow() ? 0 : HANDLE) });
    floatW = floatWidth(n, size, extra + (host.narrow() ? 0 : HANDLE_FLOAT));
    const side = geom?.side ?? 'right';
    const s = [home, side, prefs.mag, size, act, host.narrow(),
      ...items.map((i) => `${i.type}:${i.keys.join(',')}:${i.pinned ? 1 : 0}:${i.active ? 1 : 0}:${i.type === 'sessapp' ? host.title('sessapp') + '/' + (host.face?.('sessapp') || '') : ''}`)].join('|');
    if (force || s !== sig) {
      sig = s;
      build(cat, side);
    }
    place();
    //  [더보기]가 떠 있는 채로 다시 세웠거나 자리가 옮겨졌다 — 새 단추에서 다시 부풀린다.
    if (more) more.reanchor(btns[btns.length - 1]);
    applyInset(home);
    if (pendingBounce) {
      const b = btns.find((x) => x.dataset.type === pendingBounce);
      pendingBounce = null;
      if (b && !reduced()) { b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce'); window.setTimeout(() => b.classList.remove('bounce'), 900); }
    }
  }

  function build(cat: Map<string, DockApp>, side: 'right' | 'left'): void {
    //  키보드 초점이 독 안에 있었다 — 다시 세운 뒤 같은 앱의 새 단추로 돌려준다. 안 돌려주면 초점이 body 로 떨어져
    //   Enter 로 앱을 연 사람이 탭 순서의 맨 앞으로 쫓겨난다(#4443 리뷰 실측: activeElement = BODY). 탭 줄도 같은 일을 한다(panes.ts).
    const ae = document.activeElement as HTMLElement | null;
    const refocus = ae && ae !== document.body && shelf.contains(ae) ? ae.dataset.type ?? null : null;
    const refocusAt = refocus ? btns.indexOf(ae as HTMLElement) : -1;   // 그 앱이 사라졌으면(빼기·닫기) 같은 자리의 이웃으로
    hideTip();
    root.dataset.home = home;
    root.dataset.side = side;                                       // 곁칸이 이음매의 어느 쪽인가 — 이름표 · [더보기] · 튀어 오르기 방향
    root.classList.toggle('mag', magOn());
    root.classList.toggle('narrow', host.narrow());
    root.setAttribute('aria-orientation', vertical() ? 'vertical' : 'horizontal');
    root.style.setProperty('--dk-s', size + 'px');
    const kids: HTMLElement[] = [];
    btns = [];
    //  손잡이 — 이음매 독은 맨 위, 곁칸 아래 독은 왼쪽 끝(알약이 시작하는 자리 · 같은 막대). 잡고 끌면 독이 옮겨 간다
    //   (이음매: 곁칸 안쪽 깊이 = 곁칸 아래, 경계선 따라 = 위아래 자리 · 곁칸 아래: 경계선 가까이 = 이음매). 원준 10-01 · 10-02.
    //   서랍(좁은 폭)엔 안 단다 — 서랍 안의 독은 옮길 데가 없다. 알약 끝 여백 · 구분선 · 빈 자리를 잡아도 끌린다.
    if (!host.narrow()) kids.push(handleEl(home));
    let prevPinned: boolean | null = null;
    for (const it of items) {
      if (prevPinned === true && !it.pinned) kids.push(sepEl());
      prevPinned = it.pinned;
      const b = itemBtn(it, cat.get(it.type) ?? fallbackApp(it.type));
      kids.push(b); btns.push(b);
    }
    if (items.length) kids.push(sepEl());
    const mb = moreBtn();
    kids.push(mb); btns.push(mb);
    shelf.replaceChildren(...kids);
    //  키보드 — 독은 탭 순서에 한 칸(roving tabindex). 켜진 앱이 그 칸이다(초점을 돌려받는 단추가 있으면 그 단추).
    const same = refocus ? btns.findIndex((b) => b.dataset.type === refocus) : -1;
    //  #4443 재검증: 메뉴 키로 «독에서 빼기» 를 고르면 그 단추가 사라져 초점이 body 로 떨어졌다 — 이웃(같은 자리, 없으면 마지막)으로.
    const back = same >= 0 ? same : refocusAt >= 0 && btns.length ? Math.min(refocusAt, btns.length - 1) : -1;
    const onI = back >= 0 ? back : Math.max(0, btns.findIndex((b) => b.classList.contains('on')));
    btns.forEach((b, i) => { b.tabIndex = i === onI ? 0 : -1; });
    if (back >= 0) btns[back].focus({ preventScroll: true });
  }
  //  구분선도 손잡이다 — 잡고 끌면 독이 옮겨 간다(macOS 독의 구분선처럼 잡는 자리). 끝 여백 · 빈 자리도 같다.
  const sepEl = (): HTMLElement => el('span', { class: 'pn-dock-sep', 'aria-hidden': 'true' }) as HTMLElement;
  //  손잡이 — 짧은 막대(macOS · iOS 시트의 손잡이). 이음매 독은 가로, 곁칸 아래 독은 세로로 선다(알약 길이 방향에 가로지른다).
  //   마우스를 올리면 진해지고 길어지며, 끄는 동안 민트. 누르면 독 끌기(선반이 받는다).
  //   앱 단추가 아니라 탭 순서엔 안 낀다 — 키보드는 우클릭(메뉴 키) › 독 › 위치로 옮긴다.
  const handleEl = (h: DockHome): HTMLElement => el('span', { class: 'pn-dock-handle', 'aria-hidden': 'true',
    title: h === 'seam' ? '끌어서 옮겨요 — 경계선을 따라 위아래로, 사이드바 안쪽으로 깊이 끌면 사이드바 아래로' : '끌어서 옮겨요 — 사이드바 아래를 따라 좌우로, 세션과 사이드바 사이 경계선 가까이 놓으면 경계선 위로' },
    el('i')) as HTMLElement;

  function itemBtn(it: DockItem, app: DockApp): HTMLElement {
    const name = it.type === 'sessapp' ? host.title('sessapp') : app.name;
    //  붙은 앱은 제 얼굴로 선다 — 그림 · 색 둘 다 그 앱의 것(앱 찾기 · 탭과 같아야 한 앱으로 읽힌다).
    const face = it.type === 'sessapp' ? host.face?.('sessapp') || null : null;
    const color = face || appColor(it.type);
    const n = it.keys.length;
    const b = el('button', {
      class: 'pn-dock-it' + (it.active ? ' on' : '') + (n ? ' run' : '') + (it.pinned ? ' pin' : ''),
      type: 'button', 'data-type': it.type, style: `--ac: var(--gi-c-${color})`,
      'aria-label': name + (n > 1 ? ` — 열린 창 ${n}개` : n ? ' — 열려 있음' : ''),
      'aria-pressed': String(it.active),
    },
    el('span', { class: 'pn-dock-ic' }, tile(face ? appGlyphName(face) : app.glyph, color)),
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

  function moreBtn(): HTMLElement {
    const b = el('button', { class: 'pn-dock-it pn-dock-more-btn', type: 'button', 'data-type': '·more', 'aria-label': '모든 앱', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      el('span', { class: 'pn-dock-ic' }, tile('apps', 'apps')), el('span', { class: 'pn-dock-dots', 'aria-hidden': 'true' })) as HTMLElement;   // #4233 앱 = 각진 사각 넷
    b.dataset.name = '모든 앱';
    b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } toggleMore(b); });
    bindCtx(b, () => settingsResult());
    b.addEventListener('pointerenter', () => showTip(b));
    b.addEventListener('pointerleave', () => { if (tipFor === b) hideTip(); });
    b.addEventListener('focus', () => showTip(b));
    b.addEventListener('blur', () => { if (tipFor === b) hideTip(); });
    return b;
  }

  /** 이음매 독의 가운데 y(.pn-body 좌표) — 세로 구간을 따라 at 자리, 알약이 구간 밖으로 안 나가게 자른다. */
  function seamCenterY(g: DockGeom, layerTop: number, len: number, at: number): number {
    const span = g.bottom - g.top;
    return g.top - layerTop + clamp(at * span, M.margin + len / 2, span - M.margin - len / 2);
  }
  /** 곁칸 아래 독의 가운데가 설 수 있는 좌우 구간(곁칸 좌표) — 폭 w 의 알약이 바깥 여백 안에, 확대로 불어날 몫(양쪽 반씩)까지 곁칸 안에.
   *  곁칸이 좁아 알약이 폭을 채우면 lo ≥ hi(구간 없음 → 가운데, lib floatCenter). */
  function floatSpan(W: number, w: number, s: number): [number, number] {
    const half = w / 2 + (magOn() ? (MAG_GROW * s) / 2 : 0) + M.margin;
    return [half, W - half];
  }
  /** 자리 — 이음매면 경계선 위 at 자리(가운데 기준), 곁칸 아래면 곁칸 바닥의 fx 자리(기본 가운데). 자리 점 하나만 박는다(선반은 CSS 가 매단다). */
  function place(): void {
    const st = root.style;
    st.left = st.top = st.bottom = '';
    if (home === 'seam') {
      const g = seamGeom();
      const layer = root.parentElement as HTMLElement;
      if (g && layer) {
        const lr = layer.getBoundingClientRect();
        st.left = g.seam! - lr.left + 'px';
        st.top = seamCenterY(g, lr.top, shelf.offsetHeight, prefs.at) + 'px';
      }
    } else {
      const [lo, hi] = floatSpan(pane.clientWidth, floatW, size);
      //  서랍(좁은 폭)은 늘 가운데 — 거기선 끌 수도 메뉴로 되돌릴 수도 없다(넓은 화면에서 고른 자리가 계정을 타고 폰까지 따라오면 안 된다).
      st.left = floatCenter(host.narrow() ? DOCK_DEFAULTS.fx : prefs.fx, lo, hi) + 'px';
      st.bottom = M.margin + 'px';
    }
    //  확대 전 중심 — 확대는 이 값에서 잰다(아이콘이 커지며 자리가 밀려도 기준이 흔들리지 않게). 알약 가운데 기준.
    const r = shelf.getBoundingClientRect();
    const v = vertical();
    const mid = v ? r.top + r.height / 2 : r.left + r.width / 2;
    centers = btns.map((b) => { const q = b.getBoundingClientRect(); return (v ? q.top + q.height / 2 : q.left + q.width / 2) - mid; });
  }

  /** 부품이 독만큼 물러선다 — 곁칸 본문의 네 여백(CSS 가 읽는다: --pn-dock-b|t|l|r). 이음매 독은 0(경계선 위에 떠 있다). */
  function applyInset(h: DockHome | null): void {
    const z = h ? dockInset(h, size) : { bottom: 0, top: 0, left: 0, right: 0 };
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

  // ── 이름표 — 꼬리 달린 말풍선(macOS 독) ─────────────────────────────────────
  //  곁칸 아래 독은 아이콘 위에, 이음매 독은 **세션 쪽**으로(곁칸은 앱이 열리는 자리라 비워 둔다). 끌거나 메뉴가 떠 있는 동안엔 안 띄운다.
  function showTip(b: HTMLElement): void {
    if (dragging || ctxIsOpen()) return;
    tipFor = b;
    tip.textContent = b.dataset.name || '';
    tip.dataset.side = home === 'float' ? 'top' : (root.dataset.side === 'left' ? 'right' : 'left');
    tip.hidden = false;
    positionTip(b);
  }
  function hideTip(): void { tipFor = null; tip.hidden = true; }
  function positionTip(b: HTMLElement): void {
    const layer = tip.parentElement as HTMLElement | null;
    if (!layer) return;
    const lr = layer.getBoundingClientRect();
    const ic = (b.querySelector('.pn-dock-ic') as HTMLElement | null) ?? b;
    const r = ic.getBoundingClientRect();
    const side = tip.dataset.side;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const icx = r.left + r.width / 2 - lr.left, icy = r.top + r.height / 2 - lr.top;
    if (side === 'top') {
      //  이름표는 붙은 곳 안에 선다 — 곁칸이 넘친 것을 자르므로 테두리 가까운 아이콘의 긴 이름이 잘리지 않게 가운데를 당기고,
      //   꼬리는 아이콘을 계속 가리킨다(--ax).
      const cx = clamp(icx, tw / 2 + 4, lr.width - tw / 2 - 4);
      tip.style.left = cx + 'px';
      tip.style.top = r.top - lr.top - 12 + 'px';
      tip.style.setProperty('--ax', clamp(icx - cx, -tw / 2 + 10, tw / 2 - 10) + 'px');
    } else {
      const cy = clamp(icy, th / 2 + 4, lr.height - th / 2 - 4);
      tip.style.top = cy + 'px';
      tip.style.left = (side === 'left' ? r.left - lr.left - 12 : r.right - lr.left + 12) + 'px';
      tip.style.setProperty('--ax', clamp(icy - cy, -th / 2 + 6, th / 2 - 6) + 'px');
    }
  }

  // ── 확대 ────────────────────────────────────────────────────────────────────
  let magRaf = 0;
  let magPos: number | null = null;
  shelf.addEventListener('pointermove', (e: PointerEvent) => {
    if (!root.classList.contains('mag') || dragging || e.pointerType === 'touch') return;
    //  손잡이 위에선 확대하지 않는다 — 잡으려는 것은 독이지 앱이 아니다(첫 아이콘이 불어나 손잡이를 덮었다, 촬영 실측).
    if ((e.target as Element | null)?.closest?.('.pn-dock-handle')) {
      if (magPos !== null) { magPos = null; if (!magRaf) magRaf = requestAnimationFrame(applyMag); }
      return;
    }
    const r = shelf.getBoundingClientRect();
    magPos = vertical() ? e.clientY - (r.top + r.height / 2) : e.clientX - (r.left + r.width / 2);
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

  // ── 키보드 — 독 축을 따라 ←→(↑↓) · Home · End. 메뉴 키 · ⇧F10 은 셸의 메뉴 엔진이 받는다(bindCtx) ──────
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const v = vertical();
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
    ctxMenu(x, y, rows, { title, sub });
  }
  function settingsRows(): CtxRow[] {
    const p = prefs;
    const set = (patch: Partial<DockPrefs>): void => savePrefs({ ...p, ...patch });
    const seamOk = !!seamEl();
    return [
      { label: '위치', icon: 'moveto', sub: [
        { label: '이음매', hint: seamOk ? '세션과 사이드바 사이 — 세로를 안 써요' : '지금 화면엔 이음매가 없어요', checked: p.home === 'seam', off: !seamOk, run: () => set({ home: 'seam' }) },
        { label: '사이드바 아래', hint: '사이드바 폭을 따라 커져요', checked: p.home === 'float', run: () => set({ home: 'float' }) },
      ] },
      { label: '확대', checked: p.mag, run: () => set({ mag: !p.mag }) },
      { sep: true, label: '' },
      //  고정 목록은 «적은 적 없음» 으로 되돌린다 — 오늘의 기본 다섯을 목록으로 박아 두면 나중에 기본값이 바뀌어도 이 사람에겐 안 간다.
      //  곁칸 아래에서 좌우로 옮겨 둔 독 — 가운데로 되돌리는 길(키보드로도 닿는다). 가운데에 있거나 이음매에 서 있으면 줄이 없다.
      ...(home === 'float' && p.fx !== DOCK_DEFAULTS.fx ? [{ label: '사이드바 아래 가운데로', icon: 'moveto', run: () => set({ fx: DOCK_DEFAULTS.fx }) }] : []),
      { label: '독 되돌리기', icon: 'undo', hint: '자리 · 고정한 앱', run: () => { resetPins(); savePrefs({ ...DOCK_DEFAULTS }); } },
    ];
  }
  const SETTINGS_SUB = '알약의 끝이나 빈 자리를 잡고 끌어 옮길 수 있어요';
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
  //  독의 빈 자리(끝 여백 · 구분선) 우클릭 = 독 설정. 아이콘 위는 아이콘 단추가 먼저 받는다(엔진은 가까운 것부터 찾는다).
  bindCtx(shelf, () => settingsResult());

  // ── 아이콘 끌기 — 순서 바꾸기 · 끌어내 고정 풀기 ──────────────────────────────
  function beginItemDrag(e: PointerEvent, b: HTMLElement, it: DockItem): void {
    if (dragOff || e.button !== 0 || e.pointerType === 'touch' || host.narrow()) return;
    const known = pickIn(catalog());
    if (!known(it.type)) return;                                // 고정할 수 없는 것(뷰어 · 붙은 앱)은 끌 것도 없다
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    const v = vertical();
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
        shelf.append(caret);
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
      const ref = list[to] ?? list[list.length - 1] ?? b;
      const q = ref.getBoundingClientRect();
      const at = list[to] ? lo(q) - GAP / 2 : hi(q) + GAP / 2;
      caret.dataset.v = v ? '1' : '0';
      if (v) { caret.style.top = at - sr.top + 'px'; caret.style.left = ''; } else { caret.style.left = at - sr.left + 'px'; caret.style.top = ''; }
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

  // ── 독 끌기 — 이음매 ↔ 곁칸 아래 ─────────────────────────────────────────────
  //  알약의 끝 여백 · 구분선 · 빈 자리를 잡고 끈다(아이콘은 순서 바꾸기). 끄는 동안 놓일 자리가 윤곽으로 보인다:
  //   경계선 가까이 · 세션 쪽이면 이음매(그 높이), 곁칸 안쪽으로 깊이면 곁칸 아래. 놓으면 새 자리로 미끄러져 간다(FLIP).
  //   끄는 동안 독은 곁칸의 부모(.pn-body)에 옮겨 붙는다 — 곁칸 안에 붙은 채면 곁칸 테두리에서 잘린다(overflow: clip).
  shelf.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.pn-dock-it')) return;
    beginDockDrag(e);
  });
  function beginDockDrag(e: PointerEvent): void {
    if (dragOff || e.button !== 0 || e.pointerType === 'touch' || host.narrow()) return;
    const lift = pane.parentElement;
    if (!lift) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let started = false;
    let target: { home: DockHome; at?: number; fx?: number } | null = null;
    //  곁칸 아래에서 잡았으면 알약 가운데가 손을 따라간다(잡은 자리와의 어긋남을 지킨다) — 이음매에서 잡았으면 손이 곧 가운데.
    const sr0 = shelf.getBoundingClientRect();
    const grabDx = home === 'float' ? sr0.left + sr0.width / 2 - sx : 0;
    /** 이음매가 없는 화면(곁칸 전체보기 · 접힘)에서 놓았다 — 서는 곳(home)은 고른 것이 아니라 그 화면의 사정이라 적지 않는다(좌우 자리만). */
    let noSeam = false;
    const preview = el('div', { class: 'pn-dock-preview' }, el('span', { class: 'pn-dock-preview-t' })) as HTMLElement;
    const drop = el('div', { class: 'pn-dock-drop', 'aria-hidden': 'true' }, preview) as HTMLElement;
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      //  떼는 순간을 못 봤다(액자 · 창 밖에서 놓았다) — 없던 일로. 그대로 두면 끌기 상태(액자 포인터 막기 포함)가 남고
      //   다음의 아무 누름이 이 끌기를 «놓기» 로 끝냈다(#4443 리뷰 실측).
      if ((ev.buttons & 1) === 0) { end(false); return; }
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        started = true; dragging = true;
        hideTip(); magPos = null; applyMag();
        more?.close();
        //  곁칸 안에 붙어 있었으면 부모로 옮겨 붙인다 — 자리 점의 화면 위치는 그대로(left/top 으로 다시 적는다).
        if (root.parentElement !== lift) {
          const ar = root.getBoundingClientRect(), lr = lift.getBoundingClientRect();
          lift.append(root, tip);
          root.style.bottom = '';
          root.style.left = ar.left - lr.left + 'px';
          root.style.top = ar.top - lr.top + 'px';
        }
        root.classList.add('moving');
        document.documentElement.classList.add('pn-dock-dragging');
        lift.append(drop);
      }
      root.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
      const g = seamGeom();
      target = g ? placeDock(ev.clientX, ev.clientY, g, { near: NEAR }) : { home: 'float' };
      noSeam = !g;
      if (target.home === 'float') {
        //  바닥을 따라 좌우 자리 — 움직일 구간이 없으면(좁은 곁칸) 적지 않는다(열쇠째 뺀다: undefined 를 적으면 옛 자리가 지워진다).
        //  place() 와 같은 좌표(곁칸 안쪽 상자 — 테두리를 뺀다).
        const f = floatGeom(pane.clientWidth);
        const fx = floatAt(ev.clientX + grabDx - (pane.getBoundingClientRect().left + pane.clientLeft), f.lo, f.hi);
        if (fx !== undefined) target.fx = fx;
      }
      drawPreview(preview, target, lift);
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
      const from = shelf.getBoundingClientRect();
      root.classList.remove('moving');
      root.style.transform = '';
      if (dead) return;                                         // 독이 걷혔다 — 치우기만 하고 자리를 적지 않는다
      //  → live → render(true) 가 새 자리에 세운다. 이음매 없는 화면에선 이음매로 돌아갈 자리(home)를 그대로 둔다.
      if (commit && target) savePrefs({ ...prefs, ...target, ...(noSeam ? { home: prefs.home } : {}) });
      glideFrom(from);                                          // (없던 일이면 제자리로 미끄러져 돌아간다)
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
  /** 곁칸 폭 W 에 놓일 곁칸 아래 독 — 아이콘 크기 · 알약 폭 · 가운데가 설 수 있는 구간. 이음매에서 끌어올 때도 쓴다(그땐 아직 그 크기가 아니다). */
  function floatGeom(W: number): { s: number; w: number; lo: number; hi: number } {
    const n = items.length + 1;
    const extra = ((items.some((i) => i.pinned) && items.some((i) => !i.pinned) ? 1 : 0) + (items.length ? 1 : 0)) * SEP + HANDLE_FLOAT;
    const s = floatIconSize(W, n, { min: SIZE.float.min, max: SIZE.float.max, gap: GAP, pad: M.pad + 2, margin: M.margin, extra, grow: magOn() ? MAG_GROW : 0 });
    const w = Math.min(W - 2 * M.margin, floatWidth(n, s, extra));
    const [lo, hi] = floatSpan(W, w, s);
    return { s, w, lo, hi };
  }
  /** 놓일 자리의 윤곽(.pn-body 좌표) — 이음매면 경계선 위 그 높이의 세로 알약, 곁칸 아래면 곁칸 바닥의 그 좌우 자리에 가로 알약. */
  function drawPreview(pv: HTMLElement, t: { home: DockHome; at?: number; fx?: number }, layer: HTMLElement): void {
    const lr = layer.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    const n = items.length + 1;
    const seps = ((items.some((i) => i.pinned) && items.some((i) => !i.pinned) ? 1 : 0) + (items.length ? 1 : 0)) * SEP;
    let x = 0, y = 0, w = 0, h = 0;
    const g = seamGeom();
    if (t.home === 'seam' && g) {
      const s = home === 'seam' ? size : SIZE.seam.max;
      w = dockThickness('seam', s);
      h = n * (s + DOT_ROW) + GAP * (n - 1) + 2 * (M.pad + 4) + seps + HANDLE;
      x = g.seam! - lr.left - w / 2;
      y = seamCenterY(g, lr.top, h, t.at ?? prefs.at) - h / 2;
    } else {
      const f = floatGeom(pane.clientWidth);
      w = f.w;
      h = dockThickness('float', f.s);
      x = pr.left + pane.clientLeft - lr.left + floatCenter(t.fx ?? prefs.fx, f.lo, f.hi) - w / 2;
      y = pr.bottom - lr.top - M.margin - h;
    }
    Object.assign(pv.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    pv.dataset.home = t.home;
    (pv.firstElementChild as HTMLElement).textContent = `${HOME_NAME[t.home]}에 두기`;
  }
  /** from(화면 좌표의 옛 알약)에서 지금 자리로 미끄러진다 — 가운데끼리 잇는다(세로 ↔ 가로로 바뀌어도 어색하지 않게). */
  function glideFrom(from: DOMRect): void {
    render(true);
    if (reduced()) return;
    const to = shelf.getBoundingClientRect();
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
    //  부풀어 나온 단추 — 독을 다시 세우면 새 단추로 갈아 끼운다(reanchor).
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
      //  «새 탭으로 여는 앱»(런치패드 표)은 걷었다 — 여기서 여는 것은 모두 사이드바에 선다(원준 10-05 «그게 왜 필요하겠어»).
      //   위쪽 탭 앱은 발치의 [전체 앱 화면](런치패드)이 맡는다.
      body.replaceChildren(...[secSide, secAtt].filter(Boolean) as HTMLElement[]);
      if (!body.querySelector('.pn-dock-tile')) body.append(el('p', { class: 'pn-fine pn-dock-more-none', text: q ? `「${q}」에 맞는 앱이 없어요.` : '열 수 있는 앱이 없어요.' }));
    };

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

    (root.parentElement ?? pane).append(panel);                    // 독과 같은 곳에(이음매면 곁칸의 부모)
    positionMore(panel, anchor);
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
    }
    function reanchor(b: HTMLElement): void {
      if (closed || !b) return;
      if (panel.parentElement !== root.parentElement) { close(); return; }   // 붙는 곳이 바뀌었다(이음매 ↔ 곁칸 아래)
      anchor = b;
      b.setAttribute('aria-expanded', 'true');
      positionMore(panel, b);
    }
    return { el: panel, close, reanchor };
  }
  /** [더보기] 창의 자리(붙은 곳 좌표) — 독 아이콘에서 부풀어 나온다.
   *  · 곁칸 아래 독: 위로, 곁칸 안에(곁칸이 넘친 것을 자른다).
   *  · 이음매 독: **곁칸 쪽**으로(앱이 열리는 자리) — 곁칸이 좁아 240 도 안 남으면 세션 쪽으로. 세로는 곁칸 구간 안에. */
  function positionMore(panel: HTMLElement, anchor: HTMLElement): void {
    const layer = panel.parentElement as HTMLElement | null;
    if (!layer) return;
    const lr = layer.getBoundingClientRect(), pr = pane.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    const gap = 10;
    const st = panel.style;
    st.left = st.right = st.top = st.bottom = '';                  // 다시 부풀릴 때(reanchor) 옛 자리가 남지 않게
    const ax = ar.left - lr.left + ar.width / 2, ay = ar.top - lr.top + ar.height / 2;
    if (home === 'float') {
      const W = lr.width, H = lr.height, top0 = barH();
      const w = Math.max(200, Math.min(W - 16, 344));
      st.width = w + 'px';
      const left = clamp(ax - w / 2, 8, W - 8 - w);
      st.left = left + 'px';
      st.bottom = H - (ar.top - lr.top) + gap + 'px';
      st.maxHeight = Math.max(160, ar.top - lr.top - top0 - gap - 8) + 'px';
      st.setProperty('--ox', ax - left + 'px');
      st.setProperty('--oy', '100%');
    } else {
      const sideRight = root.dataset.side !== 'left';
      //  곁칸 쪽 자리 = 독 바깥 끝에서 곁칸 반대 끝까지.
      const intoPane = sideRight ? pr.right - ar.right - gap - 8 : ar.left - pr.left - gap - 8;
      const toPane = intoPane >= 240;
      const w = Math.min(344, toPane ? intoPane : Math.max(200, (sideRight ? ar.left - lr.left : lr.right - ar.right) - gap - 8));
      st.width = w + 'px';
      const goRight = toPane ? sideRight : !sideRight;
      const left = clamp(goRight ? ar.right - lr.left + gap : ar.left - lr.left - gap - w, 8, lr.width - 8 - w);
      st.left = left + 'px';
      const top0 = pr.top - lr.top + barH() + 8, bot = pr.bottom - lr.top - 8;
      const avail = Math.max(160, bot - top0);
      const top = clamp(ay - avail / 2, top0, bot - avail);
      st.top = top + 'px';
      st.maxHeight = avail + 'px';
      st.setProperty('--ox', clamp(ax - left, 0, w) + 'px');       // 독 아이콘 쪽에서 부풀어 나온다
      st.setProperty('--oy', ay - top + 'px');
    }
    panel.dataset.home = home;
  }

  // ── 살아 있는 동안 ──────────────────────────────────────────────────────────
  const onLive = (force: boolean): void => { if (!dead && !dragging) render(force); };
  live.add(onLive);
  const onStorage = (e: StorageEvent): void => { if (e.key === PREF_STORE || e.key === PIN_STORE) onLive(false); };
  window.addEventListener('storage', onStorage);
  let roRaf = 0;
  const later = (): void => {
    if (roRaf) return;
    roRaf = requestAnimationFrame(() => { roRaf = 0; if (!dragging) render(); });
  };
  //  곁칸 크기(폭 → 곁칸 아래 독의 크기) · 곁칸의 부모(분할선을 끌어 이음매가 옮겨 간다) · 자리바꿈(sw-left) · 카드 모드(cm)를 따라간다.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
  ro?.observe(pane);
  if (pane.parentElement) ro?.observe(pane.parentElement);
  const mo = typeof MutationObserver === 'function' && pane.parentElement ? new MutationObserver(later) : null;
  if (mo && pane.parentElement) mo.observe(pane.parentElement, { attributes: true, attributeFilter: ['class', 'style'] });

  render(true);
  return {
    sync(): void { if (!dragging) render(); },
    destroy(): void {
      dead = true;
      dragOff?.();                                              // 끄는 중에 걷혔다 — 치우기만 한다(dead 라 놓아도 아무것도 적지 않는다)
      live.delete(onLive);
      window.removeEventListener('storage', onStorage);
      ro?.disconnect();
      mo?.disconnect();
      if (roRaf) cancelAnimationFrame(roRaf);
      if (magRaf) cancelAnimationFrame(magRaf);
      more?.close();
      root.remove(); tip.remove();
      applyInset(null);
      document.documentElement.classList.remove('pn-dock-dragging');
    },
  };
}

// lib/pane-dock.ts — 곁칸 **독**의 규칙(#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30).
//
//  원준: "3안으로 갈건데 독 드래그하면 2안 위치에 위치시킬 수도 있게끔. 테두리쪽 원하는 곳 어디든 위치시킬 수 있게끔 …
//   충분히 맥의 독 참고해서 모션이나 애니메이션이나 우클릭 기능이나 더보기 눌렀을 때의 화면까지."
//   · 3안 = 곁칸 위에 **떠 있는** 독(macOS Dock 을 곁칸 안으로) · 2안 = 곁칸 바닥에 **붙은 막대**(iOS 탭 바).
//   · 독은 곁칸의 네 테두리 어디든 선다 — 테두리 가운데뿐 아니라 그 테두리를 따라 원하는 자리(at, 0~1)에.
//
//  이 파일은 DOM 을 모른다(값 → 값). 그리는 쪽은 v2/pane-dock.ts, 셸 배선은 v2/panes.ts.
//
//  ── 왜 독이 자리를 비키게 하나(안전 영역) ──
//  macOS 도 독이 보이는 동안엔 창을 최대로 키워도 **독 위까지만** 커진다. 곁칸도 같다: 독이 보이면 부품이 독만큼 물러선다
//   (프로젝트 칸 맨 아래의 «태스크 추가» 입력칸이 독 뒤에 깔리지 않는다 — 원준 2026-09-30 걱정의 답).
//   세로가 아까우면 ① [자동으로 가리기](macOS 와 같은 이름) — 독이 숨고 부품이 자리를 다 쓴다, 테두리에 손을 대면 나온다
//   ② 독을 옆 테두리로 옮긴다 — 세로를 하나도 안 쓴다. 두 길 모두 우클릭 메뉴와 끌기에 있다.

export type DockEdge = 'bottom' | 'top' | 'left' | 'right';
/** float = 떠 있는 알약(3안) · bar = 테두리에 붙은 막대(2안, 가로면 이름까지). */
export type DockMode = 'float' | 'bar';
export interface DockPlace { edge: DockEdge; at: number; mode: DockMode }
export interface DockPrefs extends DockPlace {
  /** 자동으로 가리기 — 테두리에 손을 대야 나온다. 가려진 동안 부품은 자리를 다 쓴다. */
  hide: boolean;
  /** 확대 — 마우스 밑 아이콘과 이웃이 커진다(macOS 의 «확대»). */
  mag: boolean;
}
export const DOCK_EDGES: readonly DockEdge[] = ['bottom', 'top', 'left', 'right'];
export const DOCK_DEFAULTS: Readonly<DockPrefs> = { edge: 'bottom', at: 0.5, mode: 'float', hide: false, mag: true };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v: number): number => Math.round(v * 100) / 100;
export const isVertical = (e: DockEdge): boolean => e === 'left' || e === 'right';

/** 계정에 적어 둔 독 설정(문자열 맵) → 설정. 모르는 값·깨진 값은 칸마다 기본값으로 떨어진다(한 칸이 깨져도 나머지는 산다). */
export function readDockPrefs(raw: unknown): DockPrefs {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const edge = (DOCK_EDGES as readonly string[]).includes(String(m.edge)) ? m.edge as DockEdge : DOCK_DEFAULTS.edge;
  const mode: DockMode = m.mode === 'bar' ? 'bar' : m.mode === 'float' ? 'float' : DOCK_DEFAULTS.mode;
  const n = Number(m.at);
  const at = m.at === undefined || m.at === '' || !Number.isFinite(n) ? DOCK_DEFAULTS.at : round2(clamp01(n));
  const flag = (v: unknown, dflt: boolean): boolean => (v === '1' ? true : v === '0' ? false : dflt);
  return { edge, at, mode, hide: flag(m.hide, DOCK_DEFAULTS.hide), mag: flag(m.mag, DOCK_DEFAULTS.mag) };
}
/** 설정 → 계정에 적을 문자열 맵(서버 map 저장소는 문자열→문자열, 값 64자 상한). */
export function writeDockPrefs(p: DockPrefs): Record<string, string> {
  return { edge: p.edge, at: round2(clamp01(p.at)).toFixed(2), mode: p.mode, hide: p.hide ? '1' : '0', mag: p.mag ? '1' : '0' };
}

// ── 독에 고정한 앱 ───────────────────────────────────────────────────────────
//  한 번도 정한 적이 없으면 기본 다섯(프로젝트 · 자료 · 지식 · 웹 · 타임라인). 곁칸 기본 폭 340px 에 떠 있는 독이 확대까지 품고 들어가는 수다.
export const DOCK_PINS_DEFAULT: readonly string[] = ['tasks', 'files', 'knowledge', 'web', 'timeline'];
/** «다 뺐다»의 표식 — 저장소는 빈 목록을 «적은 적 없음»으로 지운다(shell-prefs writeStore). 그대로 두면 다 뺀 독이 다음에 기본 다섯으로 돌아온다. */
export const DOCK_EMPTY = '~';

/** 적어 둔 고정 목록 → 쓸 목록. 없으면 기본값, 모르는 종류(없어진 부품)는 걷는다, 순서는 사람이 끌어 정한 자리라 지킨다. */
export function readDockPins(stored: unknown, known: (type: string) => boolean): string[] {
  const dflt = DOCK_PINS_DEFAULT.filter(known);
  if (!Array.isArray(stored)) return dflt;
  if (stored.length === 1 && stored[0] === DOCK_EMPTY) return [];
  const out: string[] = [];
  for (const x of stored) if (typeof x === 'string' && x !== DOCK_EMPTY && known(x) && !out.includes(x)) out.push(x);
  //  적힌 것이 전부 모르는 종류였다(부품이 사라진 뒤) — 빈 독보다 기본값이 낫다. «다 뺐다»는 표식으로만 말한다.
  return out.length ? out : dflt;
}
export function writeDockPins(pins: readonly string[]): string[] { return pins.length ? [...pins] : [DOCK_EMPTY]; }
/** 고정/해제. 고정은 at 자리에(없으면 맨 뒤). */
export function togglePin(pins: readonly string[], type: string, at?: number): string[] {
  if (pins.includes(type)) return pins.filter((t) => t !== type);
  const out = [...pins];
  const i = at === undefined ? out.length : Math.max(0, Math.min(out.length, Math.round(at)));
  out.splice(i, 0, type);
  return out;
}
/** 고정한 앱을 끌어 놓았다 — to 는 놓은 뒤 설 자리(0..n-1). 고정 안 된 것을 고정 줄로 끌어오면 그 자리에 고정한다. */
export function movePin(pins: readonly string[], type: string, to: number): string[] {
  const rest = pins.filter((t) => t !== type);
  const i = Math.max(0, Math.min(rest.length, Math.round(to)));
  rest.splice(i, 0, type);
  return rest;
}

// ── 독에 서는 것 ──────────────────────────────────────────────────────────────
export interface DockTab { key: string; type: string }
export interface DockItem {
  type: string;
  pinned: boolean;
  /** 떠 있는 탭(인스턴스) — 탭 줄 순서. 비면 안 떠 있다. */
  keys: string[];
  /** 지금 곁칸에 켜진 탭이 이 앱의 것인가. */
  active: boolean;
}
/** 고정한 앱(사람이 정한 순서) 다음에 **떠 있지만 고정 안 한 앱**(처음 뜬 순서) — macOS 독의 두 구획. */
export function dockItems(pins: readonly string[], tabs: readonly DockTab[], act: string | null): DockItem[] {
  const byType = new Map<string, string[]>();
  for (const t of tabs) { const l = byType.get(t.type); if (l) { if (!l.includes(t.key)) l.push(t.key); } else byType.set(t.type, [t.key]); }
  const actType = act ? tabs.find((t) => t.key === act)?.type ?? null : null;
  const out: DockItem[] = pins.map((type) => ({ type, pinned: true, keys: byType.get(type) ?? [], active: type === actType }));
  for (const [type, keys] of byType) if (!pins.includes(type)) out.push({ type, pinned: false, keys, active: type === actType });
  return out;
}

/** 독 아이콘을 눌렀을 때 — 새로 열기(open) 또는 그 탭 보이기(show).
 *  · 안 떠 있으면 연다.
 *  · 이 앱이 이미 켜져 있고 여럿 떠 있으면 **다음 것**으로(macOS ⌘` — 같은 앱의 창을 돌아가며). 하나면 그대로.
 *  · 켜져 있지 않으면 **가장 최근에 본** 것(없으면 처음 것).
 *  · fresh(⌥ 누르고 클릭 · 메뉴 «새로 열기»)면 여럿 띄울 수 있는 앱은 새로 연다. */
export type DockAction = { kind: 'open' } | { kind: 'show'; key: string };
export function dockClick(item: DockItem, act: string | null, recent: readonly string[], o: { fresh?: boolean; multi?: boolean } = {}): DockAction {
  if (!item.keys.length || (o.fresh && o.multi)) return { kind: 'open' };
  if (act && item.keys.includes(act)) {
    if (item.keys.length < 2) return { kind: 'show', key: act };
    return { kind: 'show', key: item.keys[(item.keys.indexOf(act) + 1) % item.keys.length] };
  }
  const seen = recent.find((k) => item.keys.includes(k));
  return { kind: 'show', key: seen ?? item.keys[0] };
}

// ── 자리 — 끌어 놓은 곳에서 테두리·자리·모양을 읽는다 ────────────────────────
export interface Box { left: number; top: number; width: number; height: number }
/** 끌던 독을 (x, y) 에 놓았다 → 가장 가까운 테두리 · 그 테두리를 따른 자리 · 모양.
 *  · 테두리에 **바짝**(bar 이내 — 기본 22px) 대면 막대(2안), 그 안쪽이면 떠 있는 알약(3안).
 *  · 자리는 테두리를 따라 0~1. 가운데 근처(snap 이내)는 정확히 가운데로 붙인다(맥 창 끌기의 가운데 자석).
 *  · 거리가 같으면 bottom › top › left › right(기본 자리가 이긴다). 곁칸 밖에 놓아도 가장 가까운 테두리다(바깥은 막대). */
export function placeFromPoint(x: number, y: number, box: Box, o: { bar?: number; snap?: number } = {}): DockPlace {
  const bar = o.bar ?? 22;
  const snap = o.snap ?? 0.06;
  const dist: Record<DockEdge, number> = {
    bottom: box.top + box.height - y, top: y - box.top, left: x - box.left, right: box.left + box.width - x,
  };
  let edge: DockEdge = 'bottom';
  for (const e of DOCK_EDGES) if (dist[e] < dist[edge]) edge = e;
  const along = isVertical(edge) ? (y - box.top) / (box.height || 1) : (x - box.left) / (box.width || 1);
  let at = round2(clamp01(along));
  //  +1e-9: 0.56 − 0.5 는 부동소수점으로 0.0600…05 라 «±0.06 은 가운데»의 경계가 빠진다(시험 L6 이 잡았다).
  if (Math.abs(at - 0.5) <= snap + 1e-9) at = 0.5;
  return { edge, at, mode: dist[edge] <= bar ? 'bar' : 'float' };
}

// ── 확대 ─────────────────────────────────────────────────────────────────────
/** 마우스에서 아이콘 중심까지의 거리(px) → 배율. range 안에서 코사인 종 모양(가운데 max, 끝 1) — macOS 확대의 모양. */
export function magnify(dist: number, o: { max: number; range: number }): number {
  const d = Math.abs(dist);
  if (!(o.range > 0) || !(d < o.range) || !(o.max > 1)) return 1;
  return 1 + (o.max - 1) * (Math.cos(Math.PI * d / o.range) + 1) / 2;
}

// ── 크기 ─────────────────────────────────────────────────────────────────────
/** 아이콘 한 변(px) — 독 축의 길이(avail)에 n 개가 들어가게. 확대로 불어날 몫(grow)을 미리 남긴다(불어난 독이 곁칸 밖으로 안 나가게). */
export function fitIconSize(n: number, avail: number, o: { max: number; min: number; gap: number; pad: number; grow: number; extra?: number }): number {
  if (!(n > 0)) return o.max;
  const s = Math.floor((avail - o.grow - (o.extra ?? 0) - 2 * o.pad - o.gap * (n - 1)) / n);
  return Math.max(o.min, Math.min(o.max, s));
}

// ── 안전 영역 ────────────────────────────────────────────────────────────────
export interface Inset { bottom: number; top: number; left: number; right: number }
//  세로가 귀하다(원준 2026-09-30) — 떠 있는 독(아이콘 32)이 바닥에서 먹는 높이는 32 + 5×2 + 4 + 6×2 = 58px 이다.
export const DOCK_METRICS = { pad: 5, margin: 6, label: 14, dot: 4 } as const;
/** 독이 차지하는 두께 — 부품이 이만큼 물러선다. 가려 두면(hide) 0. 막대(가로)는 이름 줄까지, 떠 있는 알약은 바깥 여백까지. */
export function dockThickness(p: Pick<DockPrefs, 'edge' | 'mode'>, size: number, m: { pad: number; margin: number; label: number; dot: number } = DOCK_METRICS): number {
  const core = size + 2 * m.pad + m.dot;
  if (p.mode === 'bar') return core + (isVertical(p.edge) ? 0 : m.label);
  return core + 2 * m.margin;
}
export function dockInset(p: DockPrefs, size: number, m: { pad: number; margin: number; label: number; dot: number } = DOCK_METRICS): Inset {
  const z: Inset = { bottom: 0, top: 0, left: 0, right: 0 };
  if (p.hide) return z;
  z[p.edge] = dockThickness(p, size, m);
  return z;
}

// ── 색 ───────────────────────────────────────────────────────────────────────
//  앱마다 한 색(1안 «곁칸 머리 독»의 언어) — 타일의 선 · 켜진 탭의 옅은 물 · 독 아이콘. 값은 앱 아이콘 색 토큰(--gi-c-*, 01-base · 90-dark)을
//   빌린다(새 색을 만들지 않는다 — 레일·런치패드의 같은 앱과 같은 색이어야 한 앱으로 읽힌다).
const APP_COLOR: Readonly<Record<string, string>> = {
  tasks: 'proj', files: 'src', sessfiles: 'term', knowledge: 'wiki', web: 'web', timeline: 'ctx',
  liv: 'liv', archive: 'sess', preview: 'learn', editor: 'bell', apps: 'apps', sessapp: 'liv', sessions: 'chat',
};
/** 그 종류의 색 토큰 이름(--gi-c-<이름>). 모르는 종류는 apps(회색). */
export function appColor(type: string): string { return Object.prototype.hasOwnProperty.call(APP_COLOR, type) ? APP_COLOR[type] : 'apps'; }

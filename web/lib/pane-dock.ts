// lib/pane-dock.ts — 곁칸 **독**의 규칙(#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30 → 10-01).
//
//  원준(10-01, 바로잡음): "디폴트로 4안(이음매 독)이고 끌어당겨서 3안에 둘 수 있는 걸로 하고 싶은거야. 그리고 아래에 뒀을 때는
//   곁칸 사이즈 변하는거에 따라서 독 사이즈도 바꾸고 싶음. 너가 바닥 왼쪽 탭 만든건 없애줘 일단은. 그리고 좀 더 이쁘게 … 맥 os 참고해서."
//   · 독이 서는 곳은 둘이다(home):
//     ④ seam  — **이음매**: 세션과 곁칸 사이 경계선 위에 걸친 짧은 세로 알약(기본). 세션·곁칸 어느 쪽에서도 손이 닿는 경첩.
//               경계선을 따라 위아래 자리(at, 0~1)를 고른다. 세로를 하나도 안 쓴다.
//     ③ float — **곁칸 아래**에 떠 있는 알약(macOS Dock 을 곁칸 안으로). 곁칸 폭을 따라 커지고 작아진다.
//   · 종전(09-30)의 «테두리에 붙는 막대(2안)» · «네 테두리 어디든» · «자동으로 가리기» · 손잡이(⋮⋮)는 걷었다.
//
//  이 파일은 DOM 을 모른다(값 → 값). 그리는 쪽은 v2/pane-dock.ts, 셸 배선은 v2/panes.ts.
//
//  ── 왜 곁칸 아래 독은 자리를 비키게 하나(안전 영역) ──
//  macOS 도 독이 보이는 동안엔 창을 최대로 키워도 **독 위까지만** 커진다. 곁칸 아래 독도 같다: 부품이 독만큼 물러선다
//   (프로젝트 칸 맨 아래의 «태스크 추가» 입력칸이 독 뒤에 깔리지 않는다). 이음매 독은 경계선 위에 떠 있어 아무도 비키지 않는다.

export type DockHome = 'seam' | 'float';
export interface DockPrefs {
  home: DockHome;
  /** 이음매를 따라 선 자리(0 = 위 · 1 = 아래, 독 가운데 기준). 곁칸 아래로 옮겨도 남겨 둔다 — 이음매로 돌아오면 그 자리로. */
  at: number;
  /** 곁칸 아래에서 좌우로 선 자리(0 = 왼쪽 끝 · 0.5 = 가운데 · 1 = 오른쪽 끝, 독이 움직일 수 있는 구간의 비율). 이음매로 옮겨도 남겨 둔다. */
  fx: number;
  /** 확대 — 마우스 밑 아이콘과 이웃이 커진다(macOS 의 «확대»). */
  mag: boolean;
}
export const DOCK_DEFAULTS: Readonly<DockPrefs> = { home: 'seam', at: 0.5, fx: 0.5, mag: true };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 계정에 적어 둔 독 설정(문자열 맵) → 설정. 모르는 값·깨진 값은 칸마다 기본값으로(한 칸이 깨져도 나머지는 산다).
 *  ⚠ 종전 판의 칸(edge · mode · hide)은 읽지 않는다 — 그 판에서 무엇을 골랐든 이 판의 기본(이음매)에서 다시 시작한다
 *   (원준 10-01: 기본은 4안). */
export function readDockPrefs(raw: unknown): DockPrefs {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const home: DockHome = m.home === 'float' ? 'float' : m.home === 'seam' ? 'seam' : DOCK_DEFAULTS.home;
  const n = Number(m.at);
  const at = m.at === undefined || m.at === '' || !Number.isFinite(n) ? DOCK_DEFAULTS.at : round2(clamp01(n));
  const f = Number(m.fx);
  const fx = m.fx === undefined || m.fx === '' || !Number.isFinite(f) ? DOCK_DEFAULTS.fx : round2(clamp01(f));
  const mag = m.mag === '1' ? true : m.mag === '0' ? false : DOCK_DEFAULTS.mag;
  return { home, at, fx, mag };
}
/** 설정 → 계정에 적을 문자열 맵(서버 map 저장소는 문자열→문자열, 값 64자 상한). */
export function writeDockPrefs(p: DockPrefs): Record<string, string> {
  return { home: p.home, at: round2(clamp01(p.at)).toFixed(2), fx: round2(clamp01(p.fx)).toFixed(2), mag: p.mag ? '1' : '0' };
}
/** 지금 실제로 서는 곳 — 이음매가 없으면(좁은 폭의 서랍 · 곁칸이 화면 전체인 카드 모드 · 접힘) 곁칸 아래. */
export function effectiveHome(p: Pick<DockPrefs, 'home'>, hasSeam: boolean): DockHome { return hasSeam ? p.home : 'float'; }

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
/** 끌어 놓은 자리 = **바로 뒤에 선 고정 앱**(없으면 맨 뒤). 자리를 번호가 아니라 이웃으로 말하는 까닭: 화면엔 고를 수 없는 고정이
 *  빠져 있어 화면의 번호와 목록의 번호가 다르다 — 이웃 앞에 끼우면 안 보이는 고정은 제자리에 남는다. 고정 안 된 것이면 그 자리에 고정한다. */
export function movePinBefore(pins: readonly string[], type: string, before: string | null): string[] {
  const rest = pins.filter((t) => t !== type);
  const i = before ? rest.indexOf(before) : -1;
  rest.splice(i >= 0 ? i : rest.length, 0, type);
  return rest;
}
/**
 * 끌고 있는 아이콘을 놓으면 고정 줄의 몇 번째 앞에 서나 — spans = 고정 줄(끄는 것 빼고)의 축 방향 [시작, 끝], pos = 포인터.
 *  돌려주는 값: 0..spans.length(= 맨 뒤) · -1(끼울 자리 없음). 가운데를 넘었으면 그 뒤로 간다.
 *  ★ 고정 안 한 앱은 **고정 줄 끝 + gap 까지** 들어와야 자리가 난다(macOS: 구분선 너머로 끌어와야 고정). 고정 줄이 비었으면 끼울 곳이
 *   없다(메뉴 «독에 고정» 으로). #4443 리뷰 실측: 떠 있기만 하던 앱을 8px 흔들었더니 고정 줄 맨 뒤에 박혔다.
 */
export function pinSlot(pos: number, spans: readonly (readonly [number, number])[], pinned: boolean, gap: number): number {
  if (!pinned && (!spans.length || pos > spans[spans.length - 1][1] + gap)) return -1;
  return spans.filter(([a, b]) => pos > (a + b) / 2).length;
}
/**
 * 고정 목록 한 벌 — base(이 판에 있는 종류 전부 · **고치기는 늘 여기에**) · shown(이 화면에서 고를 수 있는 것만 · 그리기용).
 *
 *  #4443 리뷰(2026-10-01): 프로젝트 없는 세션 화면은 태스크·자료·지식·리브를 고를 수 없다. 종전엔 그 화면에서 **거른 목록**에
 *   고치고 그대로 저장해서, 웹 하나를 빼면 계정의 고정이 [타임라인] 하나만 남았다(서버·다른 기기까지). 걸러진 것은 «이 화면에서
 *   안 보이는 것» 이지 «사람이 뺀 것» 이 아니다. 없어진 종류(부품이 사라진 판)만 base 에서 걷는다(readDockPins).
 */
export function dockPins(stored: unknown, exists: (type: string) => boolean, pickable: (type: string) => boolean): { base: string[]; shown: string[] } {
  const base = readDockPins(stored, exists);
  return { base, shown: base.filter(pickable) };
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

// ── 자리 — 끌어 놓은 곳에서 «이음매냐 곁칸 아래냐» 와 이음매를 따른 자리를 읽는다 ────────────────
export interface Box { left: number; top: number; width: number; height: number }
export interface DockGeom {
  /** 이음매(세션과 곁칸 사이 경계선)의 x — 없으면 null(곁칸이 서랍 · 카드 · 접힘). */
  seam: number | null;
  /** 곁칸이 이음매의 어느 쪽에 있나 — 오른쪽(기본) · 왼쪽(자리바꿈 sw-left). */
  side: 'right' | 'left';
  /** 이음매를 따라 독이 설 수 있는 세로 구간(머리 줄 아래 ~ 바닥). */
  top: number; bottom: number;
}
/** 끌던 독을 (x, y) 에 놓았다 → 어디에 서나.
 *  · 곁칸 안쪽으로 near(기본 40px) 넘게 들어와 놓으면 곁칸 아래(③). 그보다 이음매 가까이 · 세션 쪽에 놓으면 이음매(④).
 *  · 이음매 자리(at)는 세로 구간을 따라 0~1. 가운데 근처(snap 이내)는 정확히 가운데로 붙인다(맥 창 끌기의 가운데 자석).
 *  · 이음매가 없으면 늘 곁칸 아래. 곁칸 아래로 갈 때 at 은 돌려주지 않는다(이음매에서 고른 자리를 지우지 않게 — 부르는 쪽이 옛 값을 둔다). */
export function placeDock(x: number, y: number, g: DockGeom, o: { near?: number; snap?: number } = {}): { home: DockHome; at?: number } {
  const near = o.near ?? 40;
  const snap = o.snap ?? 0.06;
  if (g.seam === null) return { home: 'float' };
  const inward = g.side === 'right' ? x - g.seam : g.seam - x;
  if (inward > near) return { home: 'float' };
  let at = round2(clamp01((y - g.top) / ((g.bottom - g.top) || 1)));
  //  +1e-9: 0.56 − 0.5 는 부동소수점으로 0.0600…05 라 «±0.06 은 가운데»의 경계가 빠진다.
  if (Math.abs(at - 0.5) <= snap + 1e-9) at = 0.5;
  return { home: 'seam', at };
}

// ── 곁칸 아래에서 좌우 자리 ───────────────────────────────────────────────────
//  원준(10-07): «곁칸 전체보기로 보고있을 때 아래 Dock 끌어당겨서 밑에 위치 옮기거나 수정할 수 있도록». 곁칸이 화면 전체(카드 모드)면
//   이음매가 없어 독은 곁칸 아래뿐인데, 종전엔 늘 바닥 한가운데였다 — 끌어도 제자리로 돌아왔다. 이제 바닥을 따라 좌우 자리(fx)를 고른다.
//   lo ~ hi = 알약 가운데가 설 수 있는 구간(곁칸 폭에서 바깥 여백 · 알약 반 폭 · 확대로 불어날 몫을 뺀 것 — 그리는 쪽이 잰다).
//   곁칸이 좁아 알약이 폭을 거의 채우면 구간이 없다(hi − lo < room) — 그땐 가운데에 서고, 끌어도 자리를 적지 않는다(넓을 때 고른 자리를 지킨다).
/** 곁칸 아래 독의 가운데 x — 구간이 없으면 구간(곁칸)의 가운데. */
export function floatCenter(fx: number, lo: number, hi: number): number {
  return hi > lo ? lo + clamp01(fx) * (hi - lo) : (lo + hi) / 2;
}
/** 끌던 독의 가운데가 x 에 놓였다 → 좌우 자리(fx). 가운데 근처(snap px 이내)는 정확히 가운데로 붙인다(이음매의 가운데 자석과 같다).
 *  움직일 구간이 room(기본 24px)도 안 되면 undefined — 적지 않는다. */
export function floatAt(x: number, lo: number, hi: number, o: { snap?: number; room?: number } = {}): number | undefined {
  if (!(hi - lo >= (o.room ?? 24))) return undefined;
  if (Math.abs(x - (lo + hi) / 2) <= (o.snap ?? 14)) return 0.5;
  return round2(clamp01((x - lo) / (hi - lo)));
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

/** 곁칸 아래 독(③)의 아이콘 한 변 — **곁칸 폭을 따라** 커지고 작아진다(원준 10-01: «곁칸 사이즈 변하는거에 따라서 독 사이즈도»).
 *  곁칸 폭(바깥 여백 뺀 것)에 아이콘 n 개 + 확대로 불어날 몫(grow — 아이콘 몇 개분)이 들어가게 고르고, min~max 로 자른다.
 *  ⚠ grow 를 빼먹으면 확대한 독이 곁칸 폭을 넘어 양 끝이 곁칸 테두리에서 잘린다(곁칸은 넘친 것을 자른다 — 첫 촬영 실측).
 *  확대 1.6 · 범위 3.2 아이콘이면 불어나는 몫 ≈ 1.75 아이콘(코사인 종: 0.6 + 2×0.44 + 2×0.13).
 *  아이콘 여섯(앱 다섯 + [더보기]) · 구분선 하나 · 확대 켬: 곁칸 280 → 28 · 340 → 36 · 420 → 46 · 440 이상 → 48(최대). */
export function floatIconSize(width: number, n: number, o: { min: number; max: number; gap: number; pad: number; margin: number; extra?: number; grow?: number }): number {
  if (!(n > 0)) return o.max;
  const s = Math.floor((width - 2 * o.margin - (o.extra ?? 0) - 2 * o.pad - o.gap * (n - 1)) / (n + (o.grow ?? 0)));
  return Math.max(o.min, Math.min(o.max, s));
}
/** 확대가 독 축으로 불어나는 몫(아이콘 몇 개분) — 확대 max · 범위(아이콘 range 개)의 코사인 종을 이웃 간격(1 + gap/size ≈ 1.1)으로 더한 값. */
export const MAG_GROW = 1.75;

// ── 안전 영역 ────────────────────────────────────────────────────────────────
export interface Inset { bottom: number; top: number; left: number; right: number }
//  세로가 귀하다(원준 09-30) — 곁칸 아래 독이 바닥에서 먹는 높이 = 아이콘 + 안 여백×2 + 점 줄 + 바깥 여백×2
//   (곁칸 기본 폭의 아이콘 36 이면 36 + 12 + 6 + 16 = 70px). 그래서 기본은 세로를 하나도 안 쓰는 이음매다.
//   dot = 점 줄(점 4 + 아이콘과의 사이 2) — 42-v2-dock.css 의 알약 높이(아이콘 + 18)와 짝이다.
export const DOCK_METRICS = { pad: 6, margin: 8, dot: 6 } as const;
/** 독 알약의 두께(축에 수직) — 아이콘 + 안 여백×2 + 점 줄. 이음매 독은 점 줄이 아이콘 밑(알약 길이 쪽)에 서므로 두께에 안 든다. */
export function dockThickness(home: DockHome, size: number, m: { pad: number; margin: number; dot: number } = DOCK_METRICS): number {
  return size + 2 * m.pad + (home === 'float' ? m.dot : 0);
}
/** 부품이 비키는 폭 — 곁칸 아래 독만 바닥을 비킨다(두께 + 바깥 여백×2). 이음매 독은 0(경계선 위에 떠 있다). */
export function dockInset(home: DockHome, size: number, m: { pad: number; margin: number; dot: number } = DOCK_METRICS): Inset {
  const z: Inset = { bottom: 0, top: 0, left: 0, right: 0 };
  if (home === 'float') z.bottom = dockThickness(home, size, m) + 2 * m.margin;
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

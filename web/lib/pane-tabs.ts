// lib/pane-tabs.ts — 곁칸·아래 칸 **탭 줄의 규칙**(#3870 «곁칸 탭 관리», 원준 2026-09-30) — 순수 함수(DOM 없음).
//
//  원준: "곁칸에 여러 탭이 떠 있을 때 닫는 방식이 너무 불편함. 하나 닫고 하나씩 다 찾으러 다녀야 함. UI 도 별로이고
//        아이콘이 중앙이 맞는지도 헷갈림. 사파리나 크롬 탭들 닫거나 열거나 끌거나 드래그하는 거 최대한 참고해서."
//
// ── 무엇이 불편했나(매니지드 실측, 2026-09-30) ─────────────────────────────────
//  · 켜지지 않은 탭엔 × 가 없었다(접힌 줄은 아이콘만). 닫으려면 그 탭을 켜고 → × 를 눌러야 했다. 파일 여섯 개면 열두 번.
//  · 켜진 탭을 닫으면 **왼쪽 이웃**이 켜졌다 — 커서 밑엔 다른 탭이 와 있어 다음 × 를 다시 찾아야 했다.
//  · 넘친 탭 목록(⌄)의 × 는 누를 때마다 목록을 닫았다.
//  · 한꺼번에 닫는 길(다른 탭 닫기 · 오른쪽 탭 닫기)도, 닫은 탭을 되살리는 길도 없었다.
//  · 같은 칸 안에서 끌어 순서를 바꿀 수 없었다(끌기는 다른 칸으로 보내기만 했다).
//  · 폭은 «전부 펴거나 전부 접거나» 둘 중 하나라, 곁칸을 넓혀도 켜진 탭 하나 빼고 전부 아이콘이었다.
//
// ── 이 파일이 정하는 것 — 브라우저 탭 문법 ─────────────────────────────────────
//  ① landingAfterClose — 켜진 탭을 닫으면 **가장 최근에 보던 탭**으로(VS Code·크롬의 opener 규칙과 같은 효과: 자료에서 파일을
//     열어 보고 닫으면 자료로 돌아간다). 본 기록이 없으면 오른쪽 이웃(크롬), 그것도 없으면 왼쪽.
//  ② bulkTargets — 다른 탭 닫기 · 오른쪽 탭 닫기 · 파일 탭 모두 닫기(크롬·사파리 우클릭 메뉴). 고정 탭과
//     «닫으면 다른 일이 생기는 탭»(붙은 앱 = 떼기)은 한꺼번에 닫기에서 빠진다.
//  ③ placeKey · dragSlot · dropSlot — 끌어 옮기기. 고정 탭은 고정 탭끼리, 나머지는 고정 탭 뒤에서만(크롬).
//  ④ planTabs — 폭. 들어가면 이름을 다 편다 → 모자라면 **긴 이름부터** 줄인다 → 그래도 모자라면 켜진 탭만 이름을 남기고
//     아이콘으로 접는다 → 그래도 넘치면 가로로 미끄러진다(⌄ 목록이 나머지를 말한다).
//  ⑤ pushClosed · popClosed — 닫은 탭 다시 열기. 한꺼번에 닫은 것은 한꺼번에 되살린다(크롬).
//  ⑥ touchRecent — 최근에 본 순서.

export type Key = string;

// ── ⑥ 최근에 본 순서 ─────────────────────────────────────────────────────────
/** 그 탭을 맨 앞(가장 최근)으로. 같은 열쇠는 하나만 남기고, 길이는 cap 으로 자른다. */
export function touchRecent(recent: readonly Key[], key: Key, cap = 40): Key[] {
  const out = [key, ...recent.filter((k) => k !== key)];
  return out.length > cap ? out.slice(0, cap) : out;
}

// ── ① 닫은 뒤 켤 탭 ──────────────────────────────────────────────────────────
/**
 * 켜진 탭 `closed` 를 닫은 뒤 켤 탭.
 * @param list  닫기 **전**의 그 칸 탭 순서(closed 를 포함한다).
 * @param recent 최근에 본 순서(앞이 가장 최근). closed 가 들어 있어도 된다.
 * @returns 켤 탭. 칸이 비면 null.
 */
export function landingAfterClose(list: readonly Key[], closed: Key, recent: readonly Key[]): Key | null {
  const rest = list.filter((k) => k !== closed);
  if (!rest.length) return null;
  for (const k of recent) if (k !== closed && rest.includes(k)) return k;
  const i = list.indexOf(closed);
  if (i < 0) return rest[0];
  //  오른쪽 이웃 — 닫힌 자리로 미끄러져 들어오는 탭(크롬). 맨 끝이었으면 왼쪽.
  return i < rest.length ? rest[i] : rest[rest.length - 1];
}

// ── ② 여러 개 닫기 ───────────────────────────────────────────────────────────
export type BulkKind = 'others' | 'right' | 'files' | 'all';
export interface BulkOpts {
  /** 한꺼번에 닫기에서 빼는 탭 — 고정 탭 · 붙은 앱(닫기 = 떼기). */
  keep: (k: Key) => boolean;
  /** 파일 탭(뷰어)인가 — «파일 탭 모두 닫기» 의 대상. */
  isFile: (k: Key) => boolean;
}
/** 닫을 탭들 — 칸의 순서 그대로. anchor 는 우클릭한 탭('files'·'all' 에선 안 쓴다). */
export function bulkTargets(list: readonly Key[], anchor: Key | null, kind: BulkKind, o: BulkOpts): Key[] {
  const i = anchor == null ? -1 : list.indexOf(anchor);
  return list.filter((k, j) => {
    if (o.keep(k)) return false;
    if (kind === 'others') return k !== anchor;
    if (kind === 'right') return i >= 0 && j > i;
    if (kind === 'files') return o.isFile(k);
    return true;   // all
  });
}

// ── ③ 끌어 옮기기 ────────────────────────────────────────────────────────────
/** 고정 탭이 몇 개 앞에 서 있나(고정 탭은 늘 맨 앞에 모여 있다 — normalizePins). */
const pinCount = (list: readonly Key[], pinned: ReadonlySet<Key>): number => list.filter((k) => pinned.has(k)).length;

/** 고정 탭을 맨 앞으로 모은다(서로의 순서는 지킨다). 저장된 배치를 읽을 때와 고정을 바꿀 때 부른다. */
export function normalizePins(list: readonly Key[], pinned: ReadonlySet<Key>): Key[] {
  return [...list.filter((k) => pinned.has(k)), ...list.filter((k) => !pinned.has(k))];
}

/**
 * key 를 그 칸의 at 번째 자리에 둔다(이미 있으면 옮기고, 없으면 끼운다).
 * at 은 **key 를 뺀 목록** 기준의 자리다. 고정 탭은 [0, 고정 수] 안에서만, 나머지는 [고정 수, 끝] 안에서만 선다.
 */
export function placeKey(list: readonly Key[], key: Key, at: number, pinned: ReadonlySet<Key>): Key[] {
  const rest = list.filter((k) => k !== key);
  const pc = pinCount(rest, pinned);
  const lo = pinned.has(key) ? 0 : pc;
  const hi = pinned.has(key) ? pc : rest.length;
  const i = Math.max(lo, Math.min(hi, Math.round(Number.isFinite(at) ? at : hi)));
  return [...rest.slice(0, i), key, ...rest.slice(i)];
}

export interface Span { left: number; width: number }
/**
 * 같은 줄 안에서 끄는 중 — 잡은 탭의 **움직이는 쪽 끝**이 어느 이웃의 가운데를 넘었나로 새 자리(이웃이 비켜 준다).
 *  ⚠ 가운데끼리 비교하면 폭이 다른 탭에서 끝자리에 못 간다: 잡은 탭은 줄 끝(고정 경계)에서 멈추는데, 넓은 탭의 가운데는 그 자리의
 *   좁은 탭 가운데를 끝내 못 넘는다(런타임 시험 D2 가 잡았다 — «붙여넣은 그림.png» 를 맨 앞으로 끌어도 둘째 자리에 섰다).
 * @param rects 끌기를 시작할 때 잰 탭들의 가로 자리(순서 = 줄의 순서).
 * @param dx    누른 뒤 움직인 가로 거리.
 * @returns 놓으면 설 자리(from 을 뺀 목록 기준이 아니라 **줄의 자리** — 0..n-1).
 */
export function dragSlot(rects: readonly Span[], from: number, dx: number, lo = 0, hi = rects.length - 1): number {
  const left = rects[from].left + dx;
  const right = left + rects[from].width;
  let to = from;
  for (let i = 0; i < rects.length; i++) {
    if (i === from) continue;
    const mid = rects[i].left + rects[i].width / 2;
    if (i > from && dx > 0 && right > mid) to = Math.max(to, i);
    if (i < from && dx < 0 && left < mid) to = Math.min(to, i);
  }
  return Math.max(lo, Math.min(hi, to));
}

/** 다른 칸의 줄에 떨굴 때 — 커서가 어느 탭의 가운데보다 왼쪽인가로 끼울 자리(0..n). */
export function dropSlot(rects: readonly Span[], x: number): number {
  for (let i = 0; i < rects.length; i++) if (x < rects[i].left + rects[i].width / 2) return i;
  return rects.length;
}

// ── ④ 폭 ─────────────────────────────────────────────────────────────────────
export interface TabIn {
  /** 이름을 다 편 폭(px). */
  natural: number;
  active: boolean;
  pinned: boolean;
}
export interface Metrics {
  /** 아이콘만 남은 탭의 폭. 고정 탭은 늘 이 폭이다. */
  icon: number;
  /** 이름을 남긴 채 줄일 수 있는 가장 좁은 폭 — 아이콘 + 한글 두 글자. 이보다 좁아야 하면 아이콘으로 접는다. */
  minLabel: number;
  /** 켜지지 않은 탭의 가장 넓은 폭(긴 파일 이름이 줄을 다 먹지 않게). */
  max: number;
  /** 켜진 탭의 가장 넓은 폭. */
  activeMax: number;
  /** 줄이 넘쳐도 켜진 탭은 이 폭까지는 지킨다(이름이 읽혀야 한다) — 모자라면 줄이 미끄러진다. */
  activeMin: number;
}
export const TAB_METRICS: Metrics = { icon: 34, minLabel: 64, max: 184, activeMax: 220, activeMin: 120 };
/**
 * 탭을 «보이게» 할 때 어느 칸에서 켜나 — **닫힌 아래 칸(터미널 밑)은 펼치지 않는다**, 곁칸으로 옮겨 켠다.
 *  원준(2026-10-01): «타임라인 쟨 왜 터미널 밑에서 갑자기 앱이 튀어나와. 밑에서 나오는거 없게해줘» — 옛 기본 배치가 타임라인을
 *   닫힌 아래 칸에 두었는데(10-01 이후 기본은 비어 있다 — unparkBottom), 독 · 머리줄 단추가 그 탭을 보이려고 아래 칸을 펼쳤다.
 *  · 아래 칸이 열려 있으면(사람이 펴 두고 쓰는 중) 거기서 켠다 — 이미 보이는 자리라 튀어나오는 게 아니다.
 *  · 좁은 폭은 서랍이 곁칸 · 아래 칸 탭을 한 줄로 보여 주므로 그대로(배치를 안 건드린다).
 *  ※ 탭 수는 안 본다 — zone === 'bottom' 이면 그 탭이 아래 칸에 있으니 탭 수 ≥ 1 이고, 그래서 bottomShown 과 같은 답이다.
 */
export function showZone(zone: 'main' | 'side' | 'bottom', o: { bottomOn: boolean; narrow: boolean }): 'main' | 'side' | 'bottom' {
  return zone === 'bottom' && !o.bottomOn && !o.narrow ? 'side' : zone;
}
/**
 * 아래 칸이 보이나 — **열려 있고 탭이 하나 이상 있을 때만**(좁은 폭은 서랍이 아래 칸 탭을 들어 늘 안 보인다).
 *  원준(2026-10-01) 후속: 아래 칸은 사람이 거기 넣은 것이 있을 때만 있다. 열림은 세션마다 기억하는데(pn_view_by_sess)
 *   칸의 내용은 프로젝트마다 한 벌이라, 어떤 세션이 «열림»을 기억한 채 내용이 비면 빈 칸이 터미널 밑에서 올라왔다.
 */
export function bottomShown(o: { bottomOn: boolean; count: number; narrow: boolean }): boolean {
  return !o.narrow && o.bottomOn && o.count > 0;
}
/**
 * 저장된 배치 묶음({last, p})에서 **옛 기본값** — 닫힌 아래 칸에 타임라인 하나만 — 을 **한 번만** 걷는다(표식 seeded.bottom).
 *  옛 기본 배치가 타임라인을 닫힌 아래 칸에 넣어 두어, [＋] › «아래 칸 열기» 를 누르면 넣은 적 없는 타임라인이 거기 있었다.
 *  · 열려 있거나 다른 탭이 함께 있으면 사람이 고른 배치다 — 손대지 않는다. 걷은 타임라인은 독에서 누르면 곁칸에 열린다.
 *    «열려 있다» 는 **프로젝트 배치에 저장된 bottomOn**(마지막으로 배치를 저장한 세션의 값)이다 — 세션마다의 기억(pn_view_by_sess)은
 *    보지 않는다. «열림» 을 기억한 세션이라도 걷은 뒤엔 내용이 비어 bottomShown 이 빈 칸을 세우지 않는다.
 *  · 표식을 찍은 뒤로는 손대지 않는다 — 그 뒤 사람이 아래 칸에 둔 타임라인은 사람이 고른 것이다(task-pane seedTasksTab 과 같은 틀).
 *  돌려주는 changed 는 «저장소를 다시 써야 하나»다 — 표식만 새로 찍혀도 true. 받은 객체를 그 자리에서 고친다.
 *  store · lay 가 any 인 것은 localStorage 에서 읽은 믿을 수 없는 JSON 이라서다 — 모양을 하나씩 확인한다(seedTasksTab 과 같다).
 */
export function unparkBottom(store: any): { store: any; changed: boolean; cleared: number } {
  const st = store && typeof store === 'object' ? store : {};
  if (st.seeded && st.seeded.bottom) return { store: st, changed: false, cleared: 0 };
  const parked = (lay: any): boolean => !!lay && typeof lay === 'object' && !lay.bottomOn
    && Array.isArray(lay.bottom) && lay.bottom.length === 1 && lay.bottom[0] === 'timeline';
  let cleared = 0;
  const unpark = (lay: any): void => {
    if (!parked(lay)) return;
    lay.bottom = [];
    if (lay.act && typeof lay.act === 'object') lay.act.bottom = null;
    cleared++;
  };
  unpark(st.last);
  if (st.p && typeof st.p === 'object') for (const k of Object.keys(st.p)) unpark(st.p[k]);
  st.seeded = { ...(st.seeded || {}), bottom: 1 };
  return { store: st, changed: true, cleared };
}
/**
 * 탭 띠 안에서 탭들이 실제로 나눠 쓸 폭 — 띠의 좌우 안 여백과 탭 사이 간격(n-1 개)을 뺀다.
 *  #4443(2026-10-01 리뷰): 탭 새 옷에서 띠에 안 여백(2+2)과 간격(2)이 생겼는데 clientWidth(안 여백 포함 · 간격 모름)를 그대로
 *   planTabs 에 넘겨, 탭 여섯 개면 «들어간다» 고 셈한 줄이 실제로는 넘쳐 마지막 탭이 삐져나왔다.
 */
export function stripRoom(clientWidth: number, padLeft: number, padRight: number, gap: number, n: number): number {
  return Math.max(0, clientWidth - padLeft - padRight - gap * Math.max(0, n - 1));
}
export interface Plan {
  /** full = 이름을 다 폈다 · shrink = 긴 이름부터 줄였다 · icons = 켜진 탭만 이름, 나머지는 아이콘. */
  mode: 'full' | 'shrink' | 'icons';
  widths: number[];
  /** 그래도 줄보다 길다 — 가로로 미끄러지고 ⌄ 목록이 나머지를 말한다. */
  overflow: boolean;
}
const sum = (a: readonly number[]): number => a.reduce((s, x) => s + x, 0);

/**
 * 줄 폭 avail 안에 탭들을 앉힌다.
 *  · 켜진 탭은 이름을 끝까지 지킨다(지금 보는 것이 무엇인지는 접혀도 남아야 한다 — 종전 규칙 그대로).
 *  · 줄일 때는 **물높이** 방식: 가장 긴 이름부터 같은 폭으로 깎는다. 짧은 이름(앱·지식)은 긴 파일 이름 때문에 잘리지 않는다.
 */
export function planTabs(tabs: readonly TabIn[], avail: number, m: Metrics = TAB_METRICS): Plan {
  const cap = (t: TabIn): number => (t.pinned ? m.icon : Math.max(m.icon, Math.min(Math.ceil(t.natural), t.active ? m.activeMax : m.max)));
  const w = tabs.map(cap);
  if (sum(w) <= avail) return { mode: 'full', widths: w, overflow: false };

  //  줄일 수 있는 탭 — 고정 탭도, 켜진 탭도 아닌 것.
  const idx = tabs.map((t, i) => (!t.pinned && !t.active ? i : -1)).filter((i) => i >= 0);
  const fixed = sum(tabs.map((t, i) => (idx.includes(i) ? 0 : w[i])));
  const room = avail - fixed;
  //  물높이 L — Σ min(w_i, L) = room 이 되는 L. 가장 낮아도 minLabel.
  const floorOf = (i: number): number => Math.min(w[i], m.minLabel);
  if (idx.length && sum(idx.map(floorOf)) <= room) {
    const ws = idx.map((i) => w[i]).sort((a, b) => a - b);
    let L = m.minLabel;
    let used = 0;             // L 아래에 이미 다 들어간 탭들의 폭 합
    for (let j = 0; j < ws.length; j++) {
      const left = ws.length - j;              // 아직 L 로 깎일 탭 수
      const level = (room - used) / left;
      if (level <= ws[j]) { L = Math.max(m.minLabel, Math.floor(level)); break; }
      used += ws[j];
      L = ws[j];
    }
    const out = w.slice();
    for (const i of idx) out[i] = Math.min(w[i], L);
    return { mode: 'shrink', widths: out, overflow: sum(out) > avail + 0.5 };
  }

  //  접는다 — 켜진 탭만 이름을 남긴다. 그래도 넘치면 켜진 탭도 activeMin 까지는 양보하고(이름이 읽히는 폭), 그 너머는
  //   줄이 미끄러진다(켜진 탭은 늘 보이는 자리로 끌려온다 — paintPane). «한…» 처럼 이름을 잃는 것보다 줄이 미는 편이 낫다(실측).
  const out = tabs.map((t, i) => (t.active && !t.pinned ? w[i] : m.icon));
  const ai = tabs.findIndex((t) => t.active && !t.pinned);
  if (ai >= 0 && sum(out) > avail) out[ai] = Math.max(Math.min(w[ai], m.activeMin), Math.floor(avail - (sum(out) - out[ai])));
  return { mode: 'icons', widths: out, overflow: sum(out) > avail + 0.5 };
}

// ── ⑤ 닫은 탭 다시 열기 ──────────────────────────────────────────────────────
export interface ClosedTab {
  key: Key;
  zone: string;
  /** 닫기 직전 그 칸에서의 자리 — 되살릴 때 그 자리에 끼운다. */
  at: number;
  /** 뷰어면 펴 두었던 파일(열쇠 번호는 그 사이 다른 파일이 가져갔을 수 있다). */
  path?: string;
  /** 고정했던 탭 — 되살릴 때 고정한 채로. */
  pinned?: boolean;
}
/** 한 번에 닫은 묶음(탭 하나 닫기도 묶음 하나다). 가장 최근 것이 끝. */
export function pushClosed(stack: readonly ClosedTab[][], batch: readonly ClosedTab[], cap = 20): ClosedTab[][] {
  if (!batch.length) return stack.slice();
  const out = [...stack, batch.slice()];
  return out.length > cap ? out.slice(out.length - cap) : out;
}
/** 가장 최근에 닫은 묶음을 꺼낸다. 되살릴 때는 **닫기 전 자리의 오름차순**으로 끼운다 — 앞자리부터 끼워야 뒤의 자리가 맞는다. */
export function popClosed(stack: readonly ClosedTab[][]): { batch: ClosedTab[]; rest: ClosedTab[][] } | null {
  if (!stack.length) return null;
  const batch = stack[stack.length - 1].slice().sort((a, b) => a.at - b.at);
  return { batch, rest: stack.slice(0, -1) };
}

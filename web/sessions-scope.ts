// sessions-scope.ts — 세션 이력 앱(액자 안)이 셸의 사이드바와 맞물리는 자리(#4553 안 A, 원준 2026-10-05 «A안으로 고고»).
//
//  사이드바는 셸 문서에, 앱은 액자 문서에 있다. 줄은 **앱이 쥔다** — 「세션 목록」 탭이 보이는 그 줄(도는 세션 + 중앙 기록을 한 줄로 접은 것)
//  가운데 **읽을 기록이 있는 줄**을 셸에 보내고(HIST_ROWS_MSG), 셸은 그것으로 카드를 그린다. 사람이 사이드바에서 고르면 셸이 그 범위를
//  돌려보낸다(HIST_SCOPE_MSG). 둘이 따로 조회하면 사이드바의 수와 본문의 수가 갈린다 — 조회도, 접는 규칙도 여기 한 벌이다.
//  ⚠ 사이드바가 세는 것은 «기록» 이다. 박스만 있고 중앙 기록이 없는 세션(방금 만든 것 · 올라오지 않은 것)은 세지 않는다 — 대화 찾기에도
//   작업 일지에도 없는 줄이라, 세면 «어제 56» 을 눌렀는데 대화는 40개뿐인 화면이 된다(실측 2026-10-05: 줄 451 가운데 기록 있는 줄 323).
//   그런 세션은 범위를 고르지 않았을 때의 「세션 목록」 탭에만 선다(종전 그대로).
//  «무엇이 어느 묶음인가 · 범위 안인가» 는 lib/hist-scope.ts(순수) — 셸과 같은 파일을 읽는다.
//
//  셸 밖(단독 탭 `/ui/#/sessions`)에는 사이드바가 없다 — 다리를 놓지 않고 범위는 늘 «전체» 다(종전 화면 그대로).
import { api } from './core.js';
import { loadMySessions } from './sessions-kit.js';
import { hasRecord, mergeHistoryRows, rowProject, type HistRow } from './session-history.js';
import {
  HIST_FIND_MSG, HIST_ROWS_MSG, HIST_SCOPE0, HIST_SCOPE_MSG, histScopeOn, inHistScope, parseHistScope, sameHistScope,
  type HistKind, type HistScope, type HistSideRow, type HistState,
} from './lib/hist-scope.js';
import { EMBEDDED } from './v2/embed.js';

/** 셸이 앱으로 실은 액자인가 — 셸이 붙인 표(embed=1 · shell=classic, v2/apps.ts embedUrl)로 정한다. 부모 창이 있나로 추측하지 않는다(embed.ts 머리말). */
const IN_SHELL: boolean = ((): boolean => {
  try { return EMBEDDED && new URLSearchParams(location.search).get('shell') === 'classic'; } catch { return false; }
})();
export function histBridgeOn(): boolean { return IN_SHELL; }

// ── 줄 — 도는 세션 + 중앙 기록 ────────────────────────────────────────────────────────────────
export interface HistLoad {
  rows: HistRow[];
  /** 도는 세션 축을 받았나 · 중앙 기록 축을 받았나 — 한쪽이 실패해도 다른 쪽은 보여 준다. 둘 다 실패면 rows 가 비고 둘 다 false. */
  live: boolean; logs: boolean;
  /** 중앙 기록이 상한(2,000개)에서 잘렸다. */
  truncated: boolean;
}
const ROWS_TTL_MS = 20_000;
let rowsCache: { at: number; p: Promise<HistLoad> } | null = null;
let lastRows: HistRow[] | null = null;
const rowSubs = new Set<() => void>();

/** 줄을 받는다 — 20초 안의 것은 다시 쓴다(탭 셋과 사이드바가 같은 줄을 읽는다). 받을 때마다 셸에 보낸다. */
export function loadHistRows(force = false): Promise<HistLoad> {
  if (!force && rowsCache && Date.now() - rowsCache.at < ROWS_TTL_MS) return rowsCache.p;
  const p = Promise.all([
    api('/api/ui/terminal/sessions?includeProjects=1').then((d: any) => (Array.isArray(d?.sessions) ? d.sessions : [])).catch(() => null),
    loadMySessions(force).then((d) => d).catch(() => null),
  ]).then(([live, logs]): HistLoad => {
    const out: HistLoad = { rows: !live && !logs ? [] : mergeHistoryRows(live || [], logs ? logs.sessions : [], Date.now()), live: !!live, logs: !!logs, truncated: !!(logs && logs.truncated) };
    //  둘 다 실패한 판은 기억하지 않는다 — 다음에 부르면 다시 받는다.
    if (!out.live && !out.logs) { if (rowsCache && rowsCache.p === p) rowsCache = null; return out; }
    lastRows = out.rows;
    publish();
    for (const fn of [...rowSubs]) fn();
    return out;
  });
  rowsCache = { at: Date.now(), p };
  return p;
}
export function dropHistRows(): void { rowsCache = null; }
/** 줄이 새로 왔다(수가 바뀌었을 수 있다) — 머리의 빵부스러기가 듣는다. */
export function onHistRows(fn: () => void): () => void { rowSubs.add(fn); return () => { rowSubs.delete(fn); }; }
/** 마지막으로 받은 줄(아직 없으면 null). */
export function histRowsNow(): HistRow[] | null { return lastRows; }

// ── 남긴 것 — 지식을 남겼나 · 작업 기록만 남겼나 · 아무것도 안 남겼나 ─────────────────────────────
//  일지 한 번(전 기간)으로 안다. 묶는 기준이 «남긴 것별» 일 때만 받는다(다른 기준에서는 안 쓴다).
const KINDS_TTL_MS = 60_000;
const KIND_PAGE = 500, KIND_PAGES_MAX = 8;
let kinds: Map<string, HistKind> | null = null;
let kindsAt = 0;
let kindsP: Promise<void> | null = null;
/** 마지막으로 일지를 받으려다 실패했다 — 셸에 그렇게 알린다(사이드바가 «세는 중» 으로 영영 서 있지 않게). */
let kindsFailed = false;

async function fetchKinds(): Promise<Map<string, HistKind>> {
  const out = new Map<string, HistKind>();
  let until: number | null = null;
  for (let page = 0; page < KIND_PAGES_MAX; page++) {
    const qs = new URLSearchParams({ limit: String(KIND_PAGE) });
    if (until != null) qs.set('until', new Date(until).toISOString());
    const d: any = await api('/api/ui/v6/session-journal?' + qs.toString());
    const got: any[] = Array.isArray(d?.rows) ? d.rows : [];
    let fresh = 0, oldest = Number.POSITIVE_INFINITY;
    for (const r of got) {
      const sid = String(r?.session_id || '');
      if (!sid) continue;
      const t = Date.parse(String(r.last_seen || ''));
      if (Number.isFinite(t) && t < oldest) oldest = t;
      if (out.has(sid)) continue;
      fresh++;
      out.set(sid, Array.isArray(r.knowledge) && r.knowledge.length ? 'k' : Array.isArray(r.activities) && r.activities.length ? 'a' : 'n');
    }
    //  다 받았거나, 더 넘겨도 새 줄이 없으면(같은 시각의 줄만 되돌아온다) 그만둔다. 다음 쪽은 가장 오래된 줄의 시각까지(그 줄 포함 — 같은 시각의 줄을 놓치지 않게).
    if (!d?.truncated || !fresh || !Number.isFinite(oldest)) break;
    until = oldest + 1;
  }
  return out;
}
/**
 * 남긴 것을 받아 둔다. 받으면 셸에 줄을 다시 보내고(이제 kind 가 찼다), 지금 범위가 «남긴 것» 묶음을 고른 것이면 화면도 깨운다
 *  (그 범위의 줄이 이제야 정해진다 — 다른 범위는 남긴 것과 무관하니 다시 그리지 않는다). 실패하면 그렇다고 알리고, 다음 부름이 다시 받는다.
 */
export function ensureHistKinds(force = false): Promise<void> {
  if (!force && kinds && Date.now() - kindsAt < KINDS_TTL_MS) return Promise.resolve();
  if (kindsP) return kindsP;
  kindsFailed = false;
  const p = fetchKinds().then((m) => { kinds = m; kindsAt = Date.now(); publish(); if (scope.by === 'kind' && scope.group !== null) notify(); })
    .catch(() => { kindsFailed = true; publish(); })
    .finally(() => { if (kindsP === p) kindsP = null; });
  kindsP = p;
  return p;
}

const stateOf = (r: HistRow): HistState => (r.live ? 'live' : r.alive ? 'off' : hasRecord(r) ? 'rec' : 'none');
/** 화면의 줄(HistRow)을 사이드바가 읽는 줄로. 기록이 없는 줄은 남긴 것도 없다. */
export function sideRowOf(r: HistRow): HistSideRow {
  const proj = rowProject(r);
  return {
    //  시각은 **기록의** 마지막 시각이다 — 대화 찾기 · 작업 일지가 그 시각으로 날짜를 가른다. 박스의 활동까지 본 lastMs 로 가르면 열어 보기만 한
    //   옛 대화가 «오늘» 에 서서, 사이드바의 «어제 53» 과 일지의 «어제 51» 이 갈린다(실측 2026-10-05: 323개 가운데 7개가 다른 묶음).
    key: r.key, conv: r.convId, last: r.recMs || r.lastMs, pid: proj.id ?? 0, pname: proj.name, state: stateOf(r),
    kind: !r.convId ? 'n' : kinds ? (kinds.get(r.convId) || 'n') : null,
  };
}

// ── 범위 — 사이드바에서 고른 것 ────────────────────────────────────────────────────────────────
let scope: HistScope = { ...HIST_SCOPE0 };
const scopeSubs = new Set<() => void>();
export function histScope(): HistScope { return scope; }
/** 범위(또는 범위 판정에 쓰는 «남긴 것»)가 바뀌었다. */
export function onHistScope(fn: () => void): () => void { scopeSubs.add(fn); return () => { scopeSubs.delete(fn); }; }
function notify(): void { for (const fn of [...scopeSubs]) fn(); }

/** 범위 안의 줄만(기록이 있는 줄 가운데). 고른 것이 없으면 그대로 돌려준다 — 기록 없는 줄까지. */
export function scopedRows(rows: HistRow[], now: number = Date.now()): HistRow[] {
  return histScopeOn(scope) ? rows.filter((r) => hasRecord(r) && inHistScope(sideRowOf(r), scope, now)) : rows;
}
/** 사이드바가 세는 수 — 범위 안의, 기록이 있는 줄. 고른 것이 없으면 기록이 있는 줄 전부(사이드바 「전체」의 수). */
export function scopedCount(rows: HistRow[], now: number = Date.now()): number {
  return rows.filter((r) => hasRecord(r) && inHistScope(sideRowOf(r), scope, now)).length;
}
/** 범위 안 대화(uuid)의 집합 — 기록·일지·맞은 말을 이것으로 거른다. 고른 것이 없으면 null(거르지 않는다). */
export function scopedConvs(rows: HistRow[], now: number = Date.now()): Set<string> | null {
  if (!histScopeOn(scope)) return null;
  const out = new Set<string>();
  for (const r of scopedRows(rows, now)) if (r.convId) out.add(r.convId);
  return out;
}

function publish(): void {
  if (!IN_SHELL || !lastRows) return;
  try { window.parent.postMessage({ type: HIST_ROWS_MSG, rows: lastRows.filter(hasRecord).map(sideRowOf), kinds: !!kinds, ...(kindsFailed && !kinds ? { kindsFailed: true } : {}) }, location.origin); } catch { /* 셸이 없다 */ }
}

let bridged = false;
let findHook: (() => void) | null = null;
let pickHook: (() => void) | null = null;
/**
 * 셸과의 다리를 놓는다(한 번). 셸 액자 안이 아니면 아무것도 안 한다.
 *  onFind = 사이드바의 찾기 단추를 눌렀다 · onPick = 사람이 사이드바에서 방금 골랐다(화면이 대화록 단독 화면이면 앱으로 돌아오게 할 자리 —
 *   셸이 맞춰 주는 신호에는 부르지 않는다: 막 연 대화록이 그 신호에 앱으로 튕기면 안 된다).
 *  훅은 부를 때마다 바꿔 낀다 — 화면이 다시 설 때마다 새 화면의 것을 듣는다.
 */
export function installHistBridge(hooks: { onFind?: () => void; onPick?: () => void } = {}): void {
  findHook = hooks.onFind || null;
  pickHook = hooks.onPick || null;
  if (!IN_SHELL || bridged) return;
  bridged = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    const m: any = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === HIST_FIND_MSG) { if (findHook) findHook(); return; }
    if (m.type !== HIST_SCOPE_MSG) return;
    const next = parseHistScope(m.scope);
    if (!next) return;
    const picked = m.pick === true;
    //  «남긴 것별» 로 묶으려면 일지가 있어야 한다 — 없으면 지금 받는다(받으면 줄을 다시 보낸다).
    //  ⚠ 받다가 실패한 뒤에는 사람이 다시 고를 때만 다시 청한다 — 실패를 알리는 줄에 셸이 답하고(맞춰 주는 신호), 그 답에 또 청하면 끝없이 돈다.
    if (next.by === 'kind' && (picked || !kindsFailed)) void ensureHistKinds();
    if (sameHistScope(next, scope)) { if (picked && pickHook) pickHook(); return; }
    scope = next;
    if (picked && pickHook) pickHook();
    notify();
  });
  //  인사 — 줄을 받기 전에 셸이 지금 고른 것을 먼저 알려 준다(첫 화면이 «전체» 로 섰다가 바뀌지 않게).
  try { window.parent.postMessage({ type: HIST_ROWS_MSG }, location.origin); } catch { /* 셸이 없다 */ }
}

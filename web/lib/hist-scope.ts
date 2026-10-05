// lib/hist-scope.ts — 「세션 이력」 앱 사이드바의 순수 규칙(#4553, 원준 2026-10-05 «A안으로 고고»). **DOM 을 쓰지 않는다.**
//
//  세션 이력 앱은 셸 액자 안의 클래식 화면이라 제 사이드바가 없었다(직전 구역의 목록이 남았다). 사이드바는 「세션 목록」과
//  한 틀이다 — 머리의 묶기 고르개 하나 · 고정 줄 「전체」 · 묶음마다 카드(카드 안 줄 = 프로젝트). 한 번에 하나만 고르고,
//  고른 범위는 본문의 세 탭(대화 찾기 · 작업 일지 · 세션 목록)에 함께 걸린다.
//  줄은 액자 안 앱이 쥐고(session-history.ts mergeHistoryRows — 「세션 목록」 탭이 보이는 그 줄), 셸은 받아서 그린다.
//  그래서 «무엇이 어느 묶음인가 · 무엇이 범위 안인가» 는 양쪽이 이 파일 하나로 판정한다(따로 세면 사이드바의 수와 본문의 수가 갈린다).
//
//  세션 목록(lib/sess-all.ts)과 다른 점 둘:
//   · 시간별은 오늘 · 어제 · 이번 주 다음을 **달마다** 가른다. 지난 기록은 쌓이기만 해서, «이전» 하나로 두면 거의 전부가 한 카드에 몰린다
//     (실측 2026-10-05: 기록 323개 가운데 227개).
//   · 카드 안 줄은 **많은 순**이다(세션 목록은 최근 순). 지난 기록에서 묻는 것은 «어디에 많이 썼나» 다.
//  묶기 기준에 «사람별» 은 없다(이 앱은 내 기록만 본다). «리스트별» 도 없다 — 리스트에 든 프로젝트의 기록이 드물다(실측 27/323).
import { NO_PROJECT_NAME } from './proj-none.js';   // #4551 — 프로젝트에 안 붙은 세션 묶음의 이름 한 자리(「기타 (미분류)」)

/** 묶기 기준. 'none' = 묶지 않음(카드 없이 프로젝트 줄만). */
export type HistGroupBy = 'day' | 'kind' | 'state' | 'none';
/** 머리 드롭다운의 칸 — 순서 그대로 그린다. 'none' 은 구분선 아래. */
export const HIST_GROUP_BYS: ReadonlyArray<{ key: HistGroupBy; label: string }> = [
  { key: 'day', label: '시간별' }, { key: 'kind', label: '남긴 것별' }, { key: 'state', label: '상태별' },
  { key: 'none', label: '묶지 않음' },
];
export const histByLabel = (by: HistGroupBy): string => (HIST_GROUP_BYS.find((b) => b.key === by) || HIST_GROUP_BYS[0]!).label;

/** 남긴 것 — k = 지식을 남겼다 · a = 작업 기록만 남겼다 · n = 남긴 기록이 없다. */
export type HistKind = 'k' | 'a' | 'n';
/** 상태 — 「세션 목록」 탭의 칩과 같은 갈래(live 실행 중 · off 오프라인 · rec 기록만) + 박스도 기록도 없는 줄(none). */
export type HistState = 'live' | 'off' | 'rec' | 'none';

/** 사이드바와 본문이 함께 읽는 한 줄 — 액자가 셸에 보내는 모양이라 작게 둔다. */
export interface HistSideRow {
  key: string;
  /** 중앙 기록의 대화 uuid. 없으면 대화록도 일지도 없다. */
  conv: string | null;
  /** 마지막 활동(ms). 모르면 0. */
  last: number;
  /** 프로젝트 id. 0 = 프로젝트에 안 붙었다(「기타 (미분류)」). */
  pid: number;
  pname: string;
  state: HistState;
  /** null = 아직 모른다(일지를 받는 중). */
  kind: HistKind | null;
}

/** 사이드바에서 고른 것. group = 고른 카드(그 기준의 묶음 key, null = 전체) · proj = 고른 줄(프로젝트 id, 0 = 「기타 (미분류)」, null = 카드 전체). */
export interface HistScope { by: HistGroupBy; group: string | null; proj: number | null }
export const HIST_SCOPE0: HistScope = { by: 'day', group: null, proj: null };
/** 무엇인가 골랐나(전체가 아니다). */
export const histScopeOn = (sc: HistScope): boolean => sc.group !== null || sc.proj !== null;
export const sameHistScope = (a: HistScope, b: HistScope): boolean => a.by === b.by && a.group === b.group && a.proj === b.proj;

// ── 셸 ↔ 액자 신호 이름(같은 오리진 postMessage) ──
/** 액자 → 셸: 줄을 보낸다({ rows, kinds }). rows 가 없으면 «지금 고른 것을 알려 달라» 는 인사다. */
export const HIST_ROWS_MSG = 'lively:hist-rows';
/** 셸 → 액자: 사이드바에서 고른 것({ scope, pick? }). pick = 사람이 방금 눌렀다(액자가 줄을 보냈을 때 맞춰 주는 답에는 없다). */
export const HIST_SCOPE_MSG = 'lively:hist-scope';
/** 셸 → 액자: 사이드바의 찾기 단추 — 「대화 찾기」 탭의 찾기 칸으로. */
export const HIST_FIND_MSG = 'lively:hist-find';

const DAY = 86_400_000;
const dayStart = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const daysBefore = (t: number, n: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime(); };
const p2 = (n: number): string => (n < 10 ? '0' : '') + n;

/** 시간 묶음의 key — d0 오늘 · d1 어제 · d7 이번 주(2~6일 전) · m:YYYY-MM 그 달 · old 시각 모름. 경계는 이 기기의 자정(세션 목록 dayBucket 과 같은 자). */
export function histDayKey(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'old';
  const diff = Math.round((dayStart(now) - dayStart(ms)) / DAY);
  if (diff <= 0) return 'd0';
  if (diff === 1) return 'd1';
  if (diff < 7) return 'd7';
  const d = new Date(ms);
  return `m:${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

const KIND_LABEL: Record<string, string> = { k: '지식을 남긴 세션', a: '작업 기록만 남긴 세션', n: '남긴 기록이 없는 세션' };
const STATE_LABEL: Record<string, string> = { live: '실행 중', off: '오프라인', rec: '기록만', none: '기록 없음' };
const DAY_LABEL: Record<string, string> = { d0: '오늘', d1: '어제', d7: '이번 주', old: '이전' };

/** 묶음 key 를 사람이 읽는 이름으로 — 카드 머리와 본문 빵부스러기가 같은 말을 쓴다. 달은 올해면 «9월», 다른 해면 «2025년 12월». */
export function histGroupLabel(by: HistGroupBy, key: string, now: number): string {
  if (by === 'day') {
    if (DAY_LABEL[key]) return DAY_LABEL[key]!;
    const m = /^m:(\d{4})-(\d{2})$/.exec(key);
    if (!m) return key;
    return Number(m[1]) === new Date(now).getFullYear() ? `${Number(m[2])}월` : `${Number(m[1])}년 ${Number(m[2])}월`;
  }
  if (by === 'kind') return KIND_LABEL[key] || '확인 중';
  if (by === 'state') return STATE_LABEL[key] || key;
  return '전체';
}

/** 이 줄이 그 기준에서 드는 묶음 key — 카드(histCards)와 범위 판정(inHistScope)이 같은 값을 쓴다. */
export function histGroupKey(r: HistSideRow, by: HistGroupBy, now: number): string {
  if (by === 'day') return histDayKey(r.last, now);
  if (by === 'kind') return r.kind || '?';
  if (by === 'state') return r.state;
  return '';
}

const KIND_ORDER = ['k', 'a', 'n', '?'];
const STATE_ORDER = ['live', 'off', 'rec', 'none'];
/** 묶음의 순서 — 시간별은 최근부터(오늘 → 어제 → 이번 주 → 최근 달 → … → 이전), 나머지는 정해진 순서. */
function groupRank(by: HistGroupBy, key: string): number {
  if (by === 'day') {
    if (key === 'd0') return 0; if (key === 'd1') return 1; if (key === 'd7') return 2; if (key === 'old') return Number.MAX_SAFE_INTEGER;
    const m = /^m:(\d{4})-(\d{2})$/.exec(key);
    return m ? 1_000_000 - (Number(m[1]) * 12 + Number(m[2])) : Number.MAX_SAFE_INTEGER - 1;   // 늦은 달이 먼저
  }
  const at = (by === 'kind' ? KIND_ORDER : STATE_ORDER).indexOf(key);
  return at < 0 ? 99 : at;
}

/** 카드 안 줄 한 개 — 그 묶음 × 그 프로젝트. */
export interface HistLine { pid: number; name: string; n: number; top: number }
export interface HistCard { key: string; n: number; top: number; lines: HistLine[] }

/** 줄들을 프로젝트별로 센다 — 많은 순, 같으면 최근 활동 순, 그다음 id 순. 프로젝트에 안 붙은 것(0, 「기타 (미분류)」)도 제 수대로 선다. */
export function histLines(rows: readonly HistSideRow[] | null | undefined): HistLine[] {
  const m = new Map<number, HistLine>();
  for (const r of rows || []) {
    const pid = Number(r.pid) || 0;
    const e = m.get(pid) || { pid, name: '', n: 0, top: 0 };
    e.n++;
    if (!e.name && r.pname) e.name = r.pname;
    e.top = Math.max(e.top, Number(r.last) || 0);
    m.set(pid, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.top - a.top || a.pid - b.pid);
}

/** 사이드바 카드 — 기준의 묶음마다 한 장, 카드 안 줄은 histLines. 묶지 않음이면 카드가 없다(줄만 — histLines). 빈 묶음은 만들지 않는다. */
export function histCards(rows: readonly HistSideRow[] | null | undefined, by: HistGroupBy, now: number): HistCard[] {
  if (by === 'none') return [];
  const m = new Map<string, HistSideRow[]>();
  for (const r of rows || []) { const k = histGroupKey(r, by, now); const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); }
  return [...m.entries()]
    .map(([key, rs]) => ({ key, n: rs.length, top: Math.max(0, ...rs.map((r) => Number(r.last) || 0)), lines: histLines(rs) }))
    .sort((a, b) => groupRank(by, a.key) - groupRank(by, b.key) || b.top - a.top);
}

/** 이 줄이 고른 범위 안인가 — 사이드바의 수와 본문의 줄이 이 한 판정을 쓴다. */
export function inHistScope(r: HistSideRow, sc: HistScope, now: number): boolean {
  if (sc.by !== 'none' && sc.group !== null && histGroupKey(r, sc.by, now) !== sc.group) return false;
  if (sc.proj !== null && (Number(r.pid) || 0) !== sc.proj) return false;
  return true;
}

/** 기준을 바꾼다 — 다른 기준이면 고른 카드 · 줄을 푼다(다른 기준의 key 라 뜻이 없다). 같은 기준이면 그대로. */
export function withHistGroupBy(sc: HistScope, by: HistGroupBy): HistScope {
  return by === sc.by ? sc : { by, group: null, proj: null };
}

/** 카드 머리 · 줄을 눌렀다 — 이미 고른 그것이면 푼다(전체로), 아니면 그것을 고른다. */
export function pickHistScope(sc: HistScope, group: string | null, proj: number | null): HistScope {
  const next: HistScope = { by: sc.by, group, proj };
  return sameHistScope(sc, next) ? { by: sc.by, group: null, proj: null } : next;
}

/** 고른 것이 아직 있나 — 고른 카드가 사라지면 전체로, 고른 줄이 그 카드에 없으면 줄만 푼다. 묶지 않음이면 줄(proj)을 lines 에서 찾는다. */
export function settleHistScope(sc: HistScope, cards: readonly HistCard[], lines: readonly HistLine[] = []): HistScope {
  if (sc.by === 'none') {
    if (sc.group !== null) return { by: 'none', group: null, proj: sc.proj !== null && lines.some((l) => l.pid === sc.proj) ? sc.proj : null };
    return sc.proj !== null && !lines.some((l) => l.pid === sc.proj) ? { ...sc, proj: null } : sc;
  }
  if (sc.group === null) return sc.proj === null ? sc : { ...sc, proj: null };
  const card = cards.find((c) => c.key === sc.group);
  if (!card) return { ...sc, group: null, proj: null };
  if (sc.proj !== null && !card.lines.some((l) => l.pid === sc.proj)) return { ...sc, proj: null };
  return sc;
}

/**
 * 시간 묶음의 구간 [since, until) — 본문이 «이 묶음은 언제부터 언제까지인가» 를 말할 때 쓴다. 시간 묶음을 고르지 않았으면 null.
 *  이번 주 = 6일 전 0시 ~ 어제 0시. 달 = 그 달 1일 ~ 다음 달 1일, 단 «이번 주» 가 시작하는 날을 넘지 않는다(그 뒤는 앞 묶음의 것이다).
 */
export function histScopeSpan(sc: HistScope, now: number): { since: number; until: number } | null {
  if (sc.by !== 'day' || sc.group === null) return null;
  const k = sc.group;
  if (k === 'd0') return { since: dayStart(now), until: daysBefore(now, -1) };
  if (k === 'd1') return { since: daysBefore(now, 1), until: dayStart(now) };
  if (k === 'd7') return { since: daysBefore(now, 6), until: daysBefore(now, 1) };
  const m = /^m:(\d{4})-(\d{2})$/.exec(k);
  if (!m) return null;
  const since = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
  const until = Math.min(new Date(Number(m[1]), Number(m[2]), 1).getTime(), daysBefore(now, 6));
  return until > since ? { since, until } : null;
}

/** 본문 빵부스러기의 조각 — trail = 앞의 흐린 조각들, now = 지금 자리(굵게). 고른 것이 없으면 trail 이 비고 now 는 앱 이름이다. */
export function histCrumb(sc: HistScope, now: number, projName: (pid: number) => string, app = '세션 이력'): { trail: string[]; now: string } {
  const pn = (pid: number): string => (pid ? projName(pid) || `#${pid}` : NO_PROJECT_NAME);
  const grouped = sc.by !== 'none' && sc.group !== null;
  if (!grouped && sc.proj === null) return { trail: [], now: app };
  if (!grouped) return { trail: [app, '프로젝트'], now: pn(sc.proj as number) };
  const g = histGroupLabel(sc.by, sc.group as string, now);
  if (sc.proj === null) return { trail: [app, histByLabel(sc.by)], now: g };
  return { trail: [app, histByLabel(sc.by), g], now: pn(sc.proj) };
}

// ── 신호로 온 값 읽기 — 같은 오리진이어도 모양을 믿지 않는다(틀리면 null) ──
const BYS = new Set<string>(HIST_GROUP_BYS.map((b) => b.key));
export function parseHistScope(v: unknown): HistScope | null {
  const o = v as { by?: unknown; group?: unknown; proj?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.by !== 'string' || !BYS.has(o.by)) return null;
  const group = o.group == null ? null : typeof o.group === 'string' && o.group.length <= 64 ? o.group : undefined;
  const proj = o.proj == null ? null : Number.isInteger(o.proj) && (o.proj as number) >= 0 ? (o.proj as number) : undefined;
  if (group === undefined || proj === undefined) return null;
  return { by: o.by as HistGroupBy, group: o.by === 'none' ? null : group, proj };
}

const STATES = new Set<string>(STATE_ORDER);
/** 줄 목록 — 모양이 틀린 줄은 버린다. 배열이 아니면 null. 한 번에 max 줄까지. */
export function parseHistRows(v: unknown, max = 5000): HistSideRow[] | null {
  if (!Array.isArray(v)) return null;
  const out: HistSideRow[] = [];
  for (const x of v.slice(0, max)) {
    if (!x || typeof x !== 'object' || typeof x.key !== 'string' || !x.key) continue;
    const state = STATES.has(String(x.state)) ? (String(x.state) as HistState) : 'none';
    const kind = x.kind === 'k' || x.kind === 'a' || x.kind === 'n' ? (x.kind as HistKind) : null;
    const last = Number(x.last);
    const pid = Number(x.pid);
    out.push({
      key: x.key.slice(0, 200), conv: typeof x.conv === 'string' && x.conv ? x.conv.slice(0, 200) : null,
      last: Number.isFinite(last) && last > 0 ? last : 0, pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      pname: typeof x.pname === 'string' ? x.pname.slice(0, 300) : '', state, kind,
    });
  }
  return out;
}

/** 접힌 카드 줄의 글 — 「세션 목록」 사이드바의 «리스트 N개 더» 자리. */
export function hiddenHistCardsLabel(by: HistGroupBy, n: number): string {
  return `${by === 'day' ? '기간' : '묶음'} ${n}개 더`;
}

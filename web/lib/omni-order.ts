// lib/omni-order.ts — 통합검색(⌘K)의 **정렬·기간** 규칙(#4517, 원준 2026-09-30). DOM 무접촉이라 단위검증한다.
//  원준: «지금 완전 관련도 순으로만 나오는데 이러니까 최신순이 아예 안 되더라. 슬랙 참고해서 고쳐 줘. 필터가 필요한 건지 뭔지.»
//
//  ── 슬랙에서 가져온 것 ──
//   · 정렬 둘 — 관련도순(score) · 최신순(timestamp). 슬랙 API 의 기본값도 score 다(docs.slack.dev search.messages «sort»).
//   · 최신순 = 모든 낱말이 맞은 것을 **시각 역순**으로(slack.engineering «Search at Slack» 의 Recent search).
//   · 최신순 맨 위 «가장 맞는 결과» 3개 — 슬랙 Top Results 가 Recent 결과 위에 Relevant 상위 3개를 얹는 것과 같다.
//     이름·번호로 부르는 사람(호명)은 최신순에서도 첫 줄에서 그것을 찾는다.
//   · 기간 거르기 — 슬랙의 날짜 필터(오늘 · 최근 7일 …)와 같은 자리.
//  ⚠ 정렬은 **저장한다**(취향 — 다음 검색도 같은 순서로 보고 싶다), 기간은 **저장하지 않는다**(좁히기 — 저장하면 다음 검색이
//   말없이 좁아진다. 종류 칩과 같은 규칙, #4156).

export type OmniSort = 'rel' | 'recent';
//  #4530(원준 2026-10-01 «관련도가 적당히 있는 걸 시간순으로 보여 줘야지») — 기본을 **최신순(맨 위 가장 맞는 셋 + 최근 것부터)** 으로
//   바꿨다. 종전 키(lively.omni.sort)에는 옛 기본에서 «관련도순» 이 저장돼 있을 수 있어 키를 바꿨다 — 새 기본이 한 번은 모두에게 선다.
export const SORT_STORE = 'lively.omni.sort.v2';   // 이름이 *_KEY 면 시크릿 스캔(generic-api-key)이 오인한다 — *_STORE(#1954 관례)
export const SORT_LABEL: Record<OmniSort, string> = { rel: '관련도순', recent: '최신순' };
/** 저장값 → 정렬. 모르는 값·빈 값은 최신순(기본, #4530). */
export function readSort(raw: unknown): OmniSort {
  return raw === 'rel' ? 'rel' : 'recent';
}

export type OmniPeriod = 'all' | 'd1' | 'd7' | 'd30' | 'd90';
export const PERIODS: ReadonlyArray<{ key: OmniPeriod; label: string }> = [
  { key: 'all', label: '전체 기간' },
  { key: 'd1', label: '오늘' },
  { key: 'd7', label: '최근 7일' },
  { key: 'd30', label: '최근 30일' },
  { key: 'd90', label: '최근 90일' },
];
export const periodLabel = (p: OmniPeriod): string => PERIODS.find((x) => x.key === p)?.label || '전체 기간';

const DAY = 86_400_000;
/** 그날 0시(현지 시각). */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** n 일 전 0시(현지 시각) — **달력으로** 센다. `오늘 0시 - n×24시간` 으로 빼면 서머타임이 바뀐 날을 건너갈 때 한 시간 어긋난다. */
export function daysAgoStart(nowMs: number, n: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}
/** 기간의 시작 시각(ms). 전체 기간이면 0(거르지 않는다). 「오늘」은 오늘 0시부터, 「최근 N일」은 오늘을 포함한 N일(N-1일 전 0시부터). */
export function periodSince(p: OmniPeriod, nowMs: number): number {
  switch (p) {
    case 'd1': return daysAgoStart(nowMs, 0);
    case 'd7': return daysAgoStart(nowMs, 6);
    case 'd30': return daysAgoStart(nowMs, 29);
    case 'd90': return daysAgoStart(nowMs, 89);
    default: return 0;
  }
}
/** 이 시각이 기간 안인가. 시각을 모르는 항목은 기간을 고르면 뺀다(«그 기간에 있었다» 고 말할 근거가 없다). */
export function inPeriod(atMs: number | undefined, sinceMs: number): boolean {
  if (!sinceMs) return true;
  return typeof atMs === 'number' && Number.isFinite(atMs) && atMs >= sinceMs;
}

/** 최신순의 날짜 묶음 머리글 — 슬랙처럼 줄마다 시각을 달고, 훑기 좋게 묶음으로 끊는다. */
export function dayBucket(atMs: number | undefined, nowMs: number): string {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return '시각 모름';
  if (atMs >= daysAgoStart(nowMs, 0)) return '오늘';
  if (atMs >= daysAgoStart(nowMs, 1)) return '어제';
  if (atMs >= daysAgoStart(nowMs, 6)) return '최근 7일';
  if (atMs >= daysAgoStart(nowMs, 29)) return '최근 30일';
  return '그 이전';
}

/** 줄 오른쪽의 짧은 시각 — 방금 · n분 전 · n시간 전 · 어제 · n일 전 · 9월 28일 · 2025. 9. 28. (미래 시각은 «방금»). */
export function whenLabel(atMs: number | undefined, nowMs: number): string {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return '';
  const diff = nowMs - atMs;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + '분 전';
  const today = dayStart(nowMs);
  if (atMs >= today) return Math.floor(diff / 3_600_000) + '시간 전';
  if (atMs >= daysAgoStart(nowMs, 1)) return '어제';
  if (atMs >= daysAgoStart(nowMs, 6)) return Math.round((today - dayStart(atMs)) / DAY) + '일 전';   // 서머타임 날의 23·25시간은 반올림이 흡수한다
  const d = new Date(atMs), n = new Date(nowMs);
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

/** 최신순 비교 — 늦은 것이 앞. 시각을 모르는 것은 맨 뒤(그 안에서는 들어온 순서). */
export function byRecent<T extends { at?: number }>(a: T, b: T): number {
  const x = typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : -Infinity;
  const y = typeof b.at === 'number' && Number.isFinite(b.at) ? b.at : -Infinity;
  if (x === y) return 0;
  return y > x ? 1 : -1;
}

/** ISO·epoch(초·밀리초) → ms. 못 읽으면 undefined. 서버 행마다 시각 이름이 달라(updated_at · occurred_at · at …) 여기서 한 번에 읽는다. */
export function atOf(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string' && v.trim()) { const n = Date.parse(v); if (Number.isFinite(n)) return n; }
  }
  return undefined;
}

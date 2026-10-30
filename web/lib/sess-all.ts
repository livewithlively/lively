// lib/sess-all.ts — [AI 세션] 전체 목록(#4158)이 **무엇을 싣고 어떻게 거르는지**의 잣대 한 자리 — 순수 함수.
//
//  회의 #3977(2026-09-14) 결정 원문: «AI 세션 탭 = 전체 세션 풀스크린 조회. 중복 세션 사이드바 제거, 사이드바엔
//   프로젝트 리스트(클릭 → 그 안 세션 필터)» · 액션 아이템 P1-4 «풀스크린 목록, 세션 클릭 시 홈으로 이동, 날짜/사람 필터».
//  거르는 축은 셋이다 — **프로젝트**(사이드바가 고른다, side.ts renderSessions) · **기간** · **사람**(가운데 목록이 고른다, bins.ts renderSessAll).
//
//  ⚠ 기간의 자는 「지난 세션」 화면과 **같은 것**(past-sess.ts PAST_PERIODS · inPastPeriod)을 쓴다 — 두 목록이 «7일 이내» 를
//   다르게 세면 같은 세션이 한쪽 화면에만 선다.
//  ⚠ 휴지통 것은 싣지 않는다 — 홈·「지난 세션」과 같은 규칙(제 화면이 있다, #1851).
//  ⚠ 홈 목록에서의 자리(목록에 둠·치움 — sess-visibility.ts)는 여기서 재지 않는다. 그 재료(내 인스턴스·치운 기록)는 셸만 들고 있어서,
//   셸이 홈 사이드바와 **같은 함수**로 재어 행마다 넘긴다(main.ts homeRowVerdict). 여기서 따로 재면 판정이 두 벌이 된다.
//  잎 모듈인 이유는 past-sess·sess-fold 와 같다 — 이 잣대가 화면 코드 안에 있으면 시험할 데가 없다(scripts/sess-all.test.mjs).
//  ★ #4233 안 A(원준 2026-09-25 «안 A 좋아 · 매니지드까지»): 거르기에 상태 축을 더하고, **묶기**(날짜 · 프로젝트 · 사람 · 상태)와
//   「지금 볼 것」 카드 고르기를 여기 둔다. 묶기는 보이는 세션을 바꾸지 않는다(거르기와 묶기는 다른 일이다).
import { inPastPeriod, type PastPeriod } from './past-sess.js';

/** 사이드바가 고른 프로젝트 — null = 전체 · 0 = 프로젝트 없음 · 그 밖 = 그 프로젝트 id. */
export type SessProjPick = number | null;

/** 이 판정이 세션에게 묻는 것 전부. */
export interface AllSessLike {
  projectId?: number | null;
  /** 휴지통 표식(views.ts `isTrashedSess = !!s.trashedAt`). */
  trashedAt?: string | null;
  lastSeen?: number;
  /** 주인 — 내 세션이면 'me', 남의 세션이면 그 사람 id(모르면 ''). 부르는 쪽이 views.ts isMineSess 로 정한다. */
  owner: string;
  /** 상태 key(web/session-status.ts SESS_STATES) — 상태 거르개·상태 묶기·카드가 읽는다. */
  stateKey?: string;
  /** #4233 2안 — 이 세션 프로젝트의 리스트 id(프로젝트 탭 트리). 없으면(리스트 없는 프로젝트 · 프로젝트 없는 세션) «리스트 없음». */
  listId?: number | null;
}

export interface AllSessQuery {
  proj: SessProjPick;
  period: PastPeriod;
  /** '' = 모든 사람 · 'me' = 나 · 그 밖 = 그 사람 id. */
  owner: string;
  now: number;
  /** #4233 — '' 또는 없음 = 모든 상태 · 그 밖 = 그 상태 key 만(도구줄의 「확인 필요」·「작업 중」 칩). */
  state?: string;
  /** #4233 2안 — 사이드바에서 고른 카드(그 기준의 묶음 key). null · 없음 = 거르지 않음. */
  group?: { by: SessGroupBy; key: string } | null;
}

/** 이 세션이 고른 프로젝트에 드는가. ★ 0 은 «프로젝트 없음» 묶음이지 빈 값이 아니다(null 만 «전체»). */
export function inProjPick(projectId: number | null | undefined, pick: SessProjPick): boolean {
  if (pick === null) return true;
  return (Number(projectId) || 0) === pick;
}

/** 다섯 축(프로젝트 · 기간 · 사람 · 상태 · 사이드바 카드)으로 거르고 **최근 순**으로 — 목록은 원장이라 순서의 정본은 마지막 활동 시각이다. */
export function selectAllSess<T extends AllSessLike>(rows: readonly T[] | null | undefined, q: AllSessQuery): T[] {
  return (rows || [])
    .filter((s) => !s.trashedAt
      && inProjPick(s.projectId, q.proj)
      && inPastPeriod(Number(s.lastSeen) || 0, q.now, q.period)
      && (!q.owner || s.owner === q.owner)
      && (!q.state || s.stateKey === q.state)
      && (!q.group || sessGroupKey(s, q.group.by, q.now) === q.group.key))
    .sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
}

/**
 * 사람 고르개의 칸 — 지금 걸린 프로젝트·기간 **안에서** 주인별 개수(사람 축 자신은 빼고 센다 — 칸 숫자와 고른 뒤 보이는 줄 수가 같다).
 *  나('me')가 맨 앞, 나머지는 많은 순. ★ 지금 고른 사람은 0 이어도 남긴다 — 사라지면 걸린 거르개를 끌 길이 없다.
 */
export function ownerCounts(rows: readonly AllSessLike[] | null | undefined, q: AllSessQuery): Array<{ key: string; n: number }> {
  const m = new Map<string, number>();
  for (const s of selectAllSess(rows, { ...q, owner: '' })) m.set(s.owner, (m.get(s.owner) || 0) + 1);
  if (q.owner && !m.has(q.owner)) m.set(q.owner, 0);
  return [...m.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => Number(b.key === 'me') - Number(a.key === 'me') || b.n - a.n || a.key.localeCompare(b.key));
}

// ── #4233 안 A — 묶기 · 「지금 볼 것」 카드 ─────────────────────────────────────────────

/** 묶기 기준. #4233 2안(원준 2026-09-25 «2안이 좋아»): **사이드바 머리의 [시간별 ⌄] 드롭다운 하나**가 고른다. 본문 도구줄에는 없다.
 *  'none' = 묶지 않음: 묶음 머리 없이 전부 최근 순 한 목록(원준 «안묶은 완전 raw 한 전체보기도»).
 *  'project' 는 드롭다운에 없다 — 사이드바에서 카드를 고르면 본문이 그 아래 단계(프로젝트)로 묶을 때 쓴다(mainGroupBy). */
export type SessGroupBy = 'day' | 'list' | 'owner' | 'state' | 'project' | 'none';
/** 사이드바 드롭다운의 칸 — 순서 그대로 그린다. 'none' 은 구분선 아래. */
export const SESS_GROUP_BYS: ReadonlyArray<{ key: SessGroupBy; label: string }> = [
  { key: 'day', label: '시간별' }, { key: 'list', label: '리스트별' }, { key: 'owner', label: '사람별' }, { key: 'state', label: '상태별' },
  { key: 'none', label: '묶지 않음' },
];

/** 날짜 묶음 — 오늘 · 어제 · 이번 주(7일 안) · 이전. 경계는 이 기기의 자정이다(종전 bins.ts bucketOf 와 같은 자). */
export const DAY_BUCKETS = ['오늘', '어제', '이번 주', '이전'] as const;
export function dayBucket(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '이전';
  const day = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(ms)) / 86_400_000);
  return diff <= 0 ? '오늘' : diff === 1 ? '어제' : diff < 7 ? '이번 주' : '이전';
}

export interface SessGroup<T> { key: string; rows: T[] }

/** 이 세션이 그 기준에서 드는 묶음 key — 묶기(groupAllSess) · 사이드바 카드(sideCards) · 카드 거르기(selectAllSess group)가 같은 값을 쓴다. */
export function sessGroupKey(s: AllSessLike, by: SessGroupBy, now: number): string {
  if (by === 'day') return dayBucket(Number(s.lastSeen) || 0, now);
  if (by === 'list') return String(Number(s.listId) || 0);
  if (by === 'project') return String(Number(s.projectId) || 0);
  if (by === 'owner') return String(s.owner || '');
  if (by === 'state') return String(s.stateKey || '');
  return '';
}

/**
 * 거른 목록을 묶는다. 묶음 안 순서는 들어온 순서(최근 순) 그대로다.
 *  · 날짜: 오늘 → 어제 → 이번 주 → 이전.
 *  · 프로젝트 · 리스트: 가장 최근 활동 순. «프로젝트 없음» · «리스트 없음»(null · 0 은 한 묶음, key '0')은 늘 맨 끝.
 *  · 사람: 나('me') 맨 앞, 나머지는 많은 순, 같으면 id 순(사람 고르개 ownerCounts 와 같은 순서).
 *  · 상태: stateRank 순(확인 필요 → 작업 완료 → 작업 중 → …). 순위를 모르는 상태는 맨 끝.
 *  · 묶지 않음: 묶음 하나(key '')에 전부, 들어온 순서 그대로. 행이 없으면 묶음도 없다.
 */
export function groupAllSess<T extends AllSessLike>(rows: readonly T[] | null | undefined, by: SessGroupBy, now: number,
  stateRank: (key: string) => number = () => 99): Array<SessGroup<T>> {
  if (by === 'none') { const all = [...(rows || [])]; return all.length ? [{ key: '', rows: all }] : []; }
  const keyOf = (s: T): string => sessGroupKey(s, by, now);
  const m = new Map<string, T[]>();
  for (const s of rows || []) { const k = keyOf(s); const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); }
  const top = (g: SessGroup<T>): number => Math.max(...g.rows.map((s) => Number(s.lastSeen) || 0));
  const rank = (k: string): number => { const r = Number(stateRank(k)); return Number.isFinite(r) ? r : 99; };
  const groups = [...m.entries()].map(([key, rs]) => ({ key, rows: rs }));
  const cmp: (a: SessGroup<T>, b: SessGroup<T>) => number = by === 'day'
    ? (a, b) => DAY_BUCKETS.indexOf(a.key as (typeof DAY_BUCKETS)[number]) - DAY_BUCKETS.indexOf(b.key as (typeof DAY_BUCKETS)[number])
    : by === 'project' || by === 'list' ? (a, b) => Number(a.key === '0') - Number(b.key === '0') || top(b) - top(a)
    : by === 'owner' ? (a, b) => Number(b.key === 'me') - Number(a.key === 'me') || b.rows.length - a.rows.length || a.key.localeCompare(b.key)
    : (a, b) => rank(a.key) - rank(b.key) || top(b) - top(a);
  return groups.sort(cmp);
}

// ── #4233 3판 — 열 머리로 고르는 정렬(원준 2026-09-27 «클릭업 참고해서 구현») ───────────────
//  ★ 규칙: **묶는 기준은 건드리지 않는다.** 클릭업 리스트 뷰와 같게 묶음의 순서·구성은 그대로 두고
//   **묶음 안에서만** 줄을 다시 세운다. 그래서 «시간별로 묶은 채 이름순으로 보기» 가 된다.
//  고른 것이 없으면(null) 종전 그대로 최근 활동 순이다.

/** 정렬할 수 있는 열 — 표의 열과 1:1(마지막 ⋯ 열은 없다). */
export type SessSortKey = 'name' | 'proj' | 'state' | 'owner' | 'made' | 'seen';
export interface SessSort { key: SessSortKey; dir: 'asc' | 'desc' }

/** 열 머리를 누를 때마다 오름차순 → 내림차순 → 기본(해제). 다른 열을 누르면 그 열의 오름차순부터. */
export function nextSessSort(cur: SessSort | null, key: SessSortKey): SessSort | null {
  if (!cur || cur.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** 한 줄에서 정렬이 읽는 값. 화면 쪽이 채운다(이름·프로젝트명·사람 이름은 표에 그려진 그 글자여야 한다). */
export interface SessSortFields { name: string; proj: string; owner: string; rank: number; made: number; seen: number }

/**
 * 묶음 안 줄 정렬. 값이 같으면 **최근 활동 순**으로 되돌아간다(기본 순서가 tie-break).
 * ⚠ 모르는 시각(0)은 오름·내림 어느 쪽이든 **맨 뒤**로 보낸다 — 「생성 시각」을 모르는 옛 기록이
 *  오름차순 맨 앞을 차지하면 표가 빈 칸으로 시작한다.
 */
export function sortAllSess<T>(rows: readonly T[] | null | undefined, sort: SessSort | null, fields: (r: T) => SessSortFields): T[] {
  const all = [...(rows || [])];
  if (!sort) return all;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const ko = (a: string, b: string): number => String(a || '').localeCompare(String(b || ''), 'ko');
  const time = (v: number): number => (Number(v) > 0 ? Number(v) : (sort.dir === 'asc' ? Number.MAX_SAFE_INTEGER : -1));
  //  ⚠ `Number(v) || 99` 로 쓰면 **0 등(확인 필요)이 99 로 떨어진다** — 0 은 없는 값이 아니라 맨 앞 순위다.
  const num = (v: number): number => (Number.isFinite(Number(v)) ? Number(v) : 99);
  return all.sort((a, b) => {
    const x = fields(a); const y = fields(b);
    const tie = (Number(y.seen) || 0) - (Number(x.seen) || 0);
    switch (sort.key) {
      case 'name': return dir * ko(x.name, y.name) || tie;
      case 'proj': return dir * ko(x.proj, y.proj) || tie;
      case 'owner': return dir * ko(x.owner, y.owner) || tie;
      case 'state': return dir * (num(x.rank) - num(y.rank)) || tie;
      case 'made': return dir * (time(x.made) - time(y.made)) || tie;
      default: return dir * (time(x.seen) - time(y.seen)) || tie;
    }
  });
}

// ── #4233 2안 — 사이드바가 묶기 기준과 거르기를 쥔다 ─────────────────────────────────────

/** 사이드바에서 고른 것. by = 묶기 기준 · group = 고른 카드(그 기준의 묶음 key, null = 전체) · proj = 고른 줄(프로젝트 id, 0 = 프로젝트 없음, null = 카드 전체). */
export interface SessScope { by: SessGroupBy; group: string | null; proj: SessProjPick }
export const SESS_SCOPE0: SessScope = { by: 'day', group: null, proj: null };

/** 기준을 바꾼다 — 다른 기준이면 고른 카드 · 줄을 푼다(다른 기준의 key 라 뜻이 없다). 같은 기준이면 그대로. */
export function withGroupBy(sc: SessScope, by: SessGroupBy): SessScope {
  return by === sc.by ? sc : { by, group: null, proj: null };
}

/** 본문이 묶는 기준 — 카드를 안 골랐으면 사이드바 기준, 카드를 골랐으면 그 아래 단계(프로젝트), 줄까지 골랐으면 시간. 묶지 않음은 늘 묶지 않음. */
export function mainGroupBy(sc: SessScope): SessGroupBy {
  if (sc.by === 'none') return 'none';
  if (sc.group === null) return sc.by;
  return sc.proj === null ? 'project' : 'day';
}

/** 카드 안 줄 한 개 — 그 묶음 × 그 프로젝트. */
export interface SideCardProj { pid: number; n: number; top: number; wait: boolean }
export interface SideCard { key: string; n: number; top: number; projects: SideCardProj[] }

/** 세션들을 프로젝트 줄로 센다 — «프로젝트 없음»(0) 맨 앞, 나머지는 최근 활동 순, 같으면 id 순. 확인 필요 세션이 있으면 표식. 휴지통 것은 세지 않는다. */
export function projectLines(rows: readonly AllSessLike[] | null | undefined): SideCardProj[] {
  const m = new Map<number, SideCardProj>();
  for (const s of rows || []) {
    if (s.trashedAt) continue;
    const pid = Number(s.projectId) || 0;
    const e = m.get(pid) || { pid, n: 0, top: 0, wait: false };
    e.n++;
    e.top = Math.max(e.top, Number(s.lastSeen) || 0);
    if (s.stateKey === 'waiting') e.wait = true;
    m.set(pid, e);
  }
  return [...m.values()].sort((a, b) => Number(b.pid === 0) - Number(a.pid === 0) || b.top - a.top || a.pid - b.pid);
}

/** 사이드바 카드 — 기준의 묶음마다 한 장, 카드 안 줄은 projectLines. 묶지 않음이면 카드가 없다. 휴지통 것은 세지 않는다.
 *  ★ 카드 순서는 본문 묶음과 **같은 groupAllSess 순서** 그대로다(원준 2026-09-25 — 두 화면이 같은 순서를 말한다). 정렬을 따로 하지 않는다:
 *   시간별 오늘 → 이전 · 리스트별 최근 순(리스트 없음 맨 끝) · 사람별 나 먼저, 나머지는 세션 많은 순 · 상태별 확인 필요 → 작업 완료 → 작업 중 → 대기 중 → … */
export function sideCards(rows: readonly AllSessLike[] | null | undefined, by: SessGroupBy, now: number,
  stateRank: (key: string) => number = () => 99): SideCard[] {
  if (by === 'none') return [];
  const live = (rows || []).filter((s) => !s.trashedAt);
  return groupAllSess(live, by, now, stateRank)
    .map((g) => ({ key: g.key, n: g.rows.length, top: Math.max(0, ...g.rows.map((s) => Number(s.lastSeen) || 0)), projects: projectLines(g.rows) }));
}

/** 사이드바에 세울 카드 — 들어가는 만큼(fit 장)만 세우고 나머지는 한 줄(«리스트 N개 더»)로 접는다(원준 2026-09-25 «첫 화면은 스크롤 없이»).
 *  · 펼쳤으면(expanded) 전부.  · fit 이 0 이하여도 한 장은 세운다(카드가 하나도 없는 사이드바는 없다).
 *  · 고른 카드(selected)는 늘 보인다 — 접힐 자리였으면 마지막 자리를 그 카드에 내준다(순서는 원래 순서 그대로).
 *  · hidden 은 접힌 장수. 0 이면 접는 줄을 세우지 않는다. */
export function planSideCards(keys: readonly string[] | null | undefined, fit: number, selected: string | null, expanded: boolean): { shown: string[]; hidden: number } {
  const all = [...(keys || [])];
  if (!all.length) return { shown: [], hidden: 0 };
  if (expanded) return { shown: all, hidden: 0 };
  const k = Math.max(1, Math.min(all.length, Math.floor(Number(fit) || 0)));
  let pick = all.slice(0, k);
  if (selected !== null && all.includes(selected) && !pick.includes(selected)) {
    pick = [...pick.slice(0, k - 1), selected];   // 고른 카드는 보이는 카드들보다 늘 뒤라 끝에 붙여도 순서 그대로
  }
  return { shown: pick, hidden: all.length - pick.length };
}

/** 접는 줄의 글 — 사람은 «명», 그 밖은 «개». */
export function hiddenCardsLabel(by: SessGroupBy, n: number): string {
  const noun = by === 'list' ? '리스트' : by === 'owner' ? '사람' : by === 'state' ? '상태' : by === 'day' ? '날짜' : '묶음';
  return `${noun} ${n}${by === 'owner' ? '명' : '개'} 더`;
}

/** 고른 것이 아직 있나 — 고른 카드가 사라지면 전체로, 고른 줄이 그 카드에 없으면 줄만 푼다. 묶지 않음이면 줄(proj)을 lines 에서 찾는다. */
export function settleScope(sc: SessScope, cards: readonly SideCard[], lines: readonly SideCardProj[] = []): SessScope {
  if (sc.by === 'none') return sc.proj !== null && !lines.some((l) => l.pid === sc.proj) ? { ...sc, group: null, proj: null } : sc;
  if (sc.group === null) return sc.proj === null ? sc : { ...sc, proj: null };
  const card = cards.find((c) => c.key === sc.group);
  if (!card) return { ...sc, group: null, proj: null };
  if (sc.proj !== null && !card.projects.some((l) => l.pid === sc.proj)) return { ...sc, proj: null };
  return sc;
}

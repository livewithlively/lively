// lib/past-sess.ts — 「지난 세션」 화면이 **무엇을 싣고 어떻게 거르는지**의 잣대 한 자리 (#3778, 원준 2026-09-19).
//
//  원준 지시: "x 를 누르면 아카이브로 보내지 말고 지난 세션으로 보내. 아카이브라는 곳을 없애고 그냥 지난 세션을
//   볼 수 있는 창으로. 그 안에서 프로젝트 단위로 묶어서 보거나 각종 필터 걸려서 쉽게 볼 수 있게."
//
//  ★ 그 전까지 한 단어가 두 축을 가리켰다(실측 2026-09-19, 원준 계정 247건):
//   · 흐린 줄 = **박스가 없다**(실행 축) — 136건이 홈에 그대로 서 있었다.
//   · 카드 안 「지난 세션 n」 접힘 = **목록에 안 선다**(보임 축) — 77건.
//   같은 «지난 세션» 이라는 말인데 한쪽엔 136, 한쪽엔 77 이 들어가 있었고, 화면은 그중 접힘 쪽 숫자만 말했다.
//  ⇒ 이 화면은 **두 축을 다 받는다**: 박스가 없는 세션(멈춤·종료·메모리 부족·기록만) + 내가 × 로 치운 세션.
//   사람이 «다시 열 수 있는 것» 을 찾는 자리라 그 둘을 가르는 것이 뜻이 없다 — 가름은 칩(치운 것)이 맡는다.
//
//  잎 모듈인 이유는 sess-fold·row-stands 와 같다 — 이 잣대가 화면 코드 안에 있으면 시험할 데가 없고, 그래서
//   조용히 깨진다(#830·#3855 가 그 부류였다). 여기 있는 것은 전부 DOM 을 모르는 순수 함수다.

/** 이 판정이 세션에게 묻는 것 전부. 한 세션이 여러 이름으로 불린다(박스 id · 대화 uuid · 되살리기 전 옛 박스 id). */
export interface PastSessLike {
  id: string;
  logId?: string | null;
  altIds?: string[];
  projectId?: number | null;
  /** views.ts 의 두 칸 — 도는 세션은 둘 다 참이다. */
  live?: boolean;
  alive?: boolean;
  /** 휴지통 표식(views.ts `isTrashedSess = !!s.trashedAt`) — 칸 이름이 이것인 게 핵심이다(#3778 4판이 밟은 함정). */
  trashedAt?: string | null;
  lastSeen?: number;
}

/** 한 세션의 모든 이름 — 어느 이름으로 치웠든 같은 세션이다. */
export function pastNames(s: PastSessLike): string[] {
  return [s.id, s.logId || '', ...(s.altIds || [])].filter(Boolean).map(String);
}

/** 내가 목록에서 치운 세션인가(보임 축). */
export function isDismissedSess(s: PastSessLike, dismissed: ReadonlySet<string>): boolean {
  return pastNames(s).some((n) => dismissed.has(n));
}

/** 박스가 없는가(실행 축) — 멈춤·종료·메모리 부족·기록만. 홈의 흐린 톤과 **같은 술어**(views.ts isPastSess). */
export const isStoppedSess = (s: PastSessLike): boolean => !(s.live && s.alive);

/**
 * 「지난 세션」 화면에 설 세션인가.
 *  ⚠ 휴지통 것은 뺀다 — 휴지통은 «지울 후보» 를 담는 다음 칸이고 제 화면이 있다(#1851).
 *  ★ 치운 세션은 **도는 중이어도** 선다 — × 의 뜻은 «목록에서 치운다» 이지 «멈춘다» 가 아니라(세션은 그대로 돈다),
 *   치운 뒤 다시 찾을 자리가 여기 말고는 없다. 그 줄은 화면에서 «도는 중» 표식을 달고 선다.
 */
export function standsInPast(s: PastSessLike, dismissed: ReadonlySet<string>): boolean {
  if (s.trashedAt) return false;
  return isDismissedSess(s, dismissed) || isStoppedSess(s);
}

// ── 기간 거르개 ───────────────────────────────────────────────────────────────
//  누적이다(오늘 ⊂ 7일 ⊂ 30일). «30일 이전» 만 배타 — 오래된 것을 찾으려고 고르는 칸이라 최근 것이 섞이면 뜻이 없다.
export type PastPeriod = 'all' | 'today' | 'week' | 'month' | 'older';
export const PAST_PERIODS: Array<{ key: PastPeriod; label: string }> = [
  { key: 'all', label: '기간 전체' },
  { key: 'today', label: '오늘' },
  { key: 'week', label: '7일 이내' },
  { key: 'month', label: '30일 이내' },
  { key: 'older', label: '30일 이전' },
];

/** 그 지역 시간의 자정 — 「오늘」의 시작. */
export function dayStartOf(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 이 시각이 고른 기간에 드는가. 시각을 모르는 줄(0)은 «30일 이전» 으로 친다 — 숨기지 않는다. */
export function inPastPeriod(lastSeen: number, now: number, p: PastPeriod): boolean {
  if (p === 'all') return true;
  const t = Number(lastSeen) || 0;
  if (p === 'today') return t >= dayStartOf(now);
  if (p === 'week') return t >= now - 7 * 86_400_000;
  if (p === 'month') return t >= now - 30 * 86_400_000;
  return t < now - 30 * 86_400_000;   // older — 모르는 줄(0)도 여기 든다
}

// ── 고르기 ────────────────────────────────────────────────────────────────────
/** 칩 — 전체 / 치운 것. 「보관한 프로젝트」는 세션이 아니라 프로젝트를 세는 딴 모드라 여기 없다. */
export type PastScope = 'all' | 'dismissed';

export interface PastPick<T extends PastSessLike> {
  dismissed: ReadonlySet<string>;
  scope: PastScope;
  period: PastPeriod;
  now: number;
  /** 검색 — 이름·프로젝트명을 아는 것은 화면이라 술어를 받는다. 안 주면 안 거른다. */
  match?: (s: T) => boolean;
  /** 프로젝트로 좁히기 — null 이면 전부, 0 은 「프로젝트 없음」. */
  projectId?: number | null;
  newestFirst: boolean;
}

/**
 * 화면에 그릴 줄 — 거르고 정렬까지. 입력 배열은 건드리지 않는다.
 *  ⚠ «설 자격» 은 standsInPast 하나로 묻는다. 여기에 «도는 세션은 뺀다» 같은 예외를 더하지 않는다 —
 *   예외를 열거하면 빠뜨린 종류가 조용히 샌다(#3778 이 세 번 밟은 그 모양, home-sidebar-project-axis 참조).
 */
export function selectPast<T extends PastSessLike>(all: readonly T[] | null | undefined, o: PastPick<T>): T[] {
  const out: T[] = [];
  for (const s of all || []) {
    if (!s || !standsInPast(s, o.dismissed)) continue;
    if (o.scope === 'dismissed' && !isDismissedSess(s, o.dismissed)) continue;
    if (o.projectId != null && Number(s.projectId || 0) !== o.projectId) continue;
    if (!inPastPeriod(Number(s.lastSeen) || 0, o.now, o.period)) continue;
    if (o.match && !o.match(s)) continue;
    out.push(s);
  }
  out.sort((a, b) => (o.newestFirst ? 1 : -1) * ((Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0)));
  return out;
}

/**
 * 프로젝트로 묶기 — 묶음 안 순서는 들어온 그대로(이미 정렬돼 온다), 묶음끼리는 **가장 최근 줄** 순.
 *  ★ 「프로젝트 없음」(id 0)도 한 묶음이다 — 빈 값이 아니라 묶음 하나다(#3778 5판이 여기서 한 번 틀렸다).
 */
export function groupPastByProject<T extends PastSessLike>(rows: readonly T[]): Array<{ id: number; rows: T[]; last: number }> {
  const by = new Map<number, { id: number; rows: T[]; last: number }>();
  for (const s of rows) {
    const id = Number(s.projectId || 0);
    const g = by.get(id) || { id, rows: [], last: 0 };
    g.rows.push(s);
    g.last = Math.max(g.last, Number(s.lastSeen) || 0);
    by.set(id, g);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

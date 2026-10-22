// 수집 주기(#4213 T12 #4744)의 **판정만** 모은 순수 모듈 — DB·시계·네트워크가 없다. 저장은 collect-schedule.ts · 저장 단계는 run-ingest.ts.
//
//  ── 확정(상민님 2026-10-15 «트리거 최종 확정») ──
//   별도 트리거는 기본 주기 하나다. 주기는 그 단위(외부 앱 채널·메일함·페이지)에 **글이 올라오는 빈도로만** 정한다 — 워크스페이스
//   활동은 보지 않는다(새 정보는 그 단위에 새 글이 올라와야 생긴다). 매번 «새 글 있나?» 를 먼저 가볍게 확인하고 없으면 끝낸다 —
//   수집 실행은 읽은 위치 **뒤만** 읽으므로 그 첫 호출이 곧 확인이다(새 글이 없으면 단위마다 호출 한 번으로 끝난다).
//
//  ── 여기서 정하는 것 ──
//   ① 글 빈도 — 다 읽은 판마다 «그 구간에 올라온 글 수 · 구간 길이» 를 표본으로 남기고, 최근 14일 표본으로 하루 평균을 낸다.
//      처음 수집(최근 14일)이 곧 첫 표본이라 첫 판 뒤부터 빈도가 선다.
//   ② 주기 — 하루 평균 → 주기 표(INTERVAL_TIERS). 리브·사람이 주기를 정하면(collect_unit_update interval_sec) 그 값이 고정이고,
//      null 로 되돌리면 다시 빈도를 따른다(interval_auto).
//   ③ 다음 확인 시각 — 다 읽었고 «지금» 까지 따라잡았으면 주기 뒤 · 밀렸으면 곧바로(다음 틱) · 못 읽었으면 물러서며
//      (10분 → 두 배씩, 최대 6시간). 못 다 읽어 구간을 반으로 줄이는 판은 곧바로 다시 — 줄일 수 없게 되면(stuck) 물러선다.
//   ④ 지금 때가 된 단위 · 이번 틱에 띄울 구성원(가장 오래 기다린 사람 먼저 · 도는 사람·물러선 사람 빼고 · 동시 실행 상한 안에서).
//   ⑤ 구성원 물러서기 — 그 사람의 최근 수집 실행이 연달아 실패했으면(결과 또는 저장 단계) 띄우지 않고 기다린다. 실패한 판은 단위의
//      다음 확인 시각을 못 옮기므로, 이게 없으면 같은 실패를 틱마다 다시 띄운다.
//
//  설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §6 · 태스크 #4744.

/** 글 빈도를 재는 창 — 최근 14일(처음 수집 기간과 같다 — collect-plan FIRST_READ_DAYS). */
export const ACTIVITY_WINDOW_SEC = 14 * 86400;
/**
 * 표본을 이만큼만 낱개로 둔다 — 최근 하루 안의 판은 낱개, 그보다 오래된 판은 **날마다 하나로 합친다**(글 수·구간 길이를 더해도
 *  비율 추정은 그대로다). 그래서 14일 창이 판 수와 무관하게 유지된다 — 판 수로 자르면 30분 주기 단위는 창이 하루 남짓으로 줄어
 *  평일만 바쁜 채널이 주말을 지나며 24시간 주기로 떨어졌다(리뷰 2026-10-17). 하루 안의 낱개가 이보다 많으면 오래된 것부터 시간마다 합친다.
 */
export const ACTIVITY_RAW_MAX = 120;
/** 이만큼도 못 봤으면 빈도를 모른다고 본다 — 한 시간 구간 하나로 «하루 24개» 를 단정하지 않게. */
export const ACTIVITY_MIN_OBSERVED_SEC = 6 * 3600;

/**
 * 주기 표 — 최근 14일 하루 평균 새 글 수 → 다음 확인까지의 간격. 위에서부터 처음 맞는 줄.
 *  가장 짧은 주기를 30분으로 둔 까닭: 판마다 세션 컨테이너가 하나 뜨고(약 15초 · 작은 모델 몇 센트 미만) 그 토큰은 담당자의 구독에서 나간다.
 *  그 사이의 새 글은 검색 실패 보조 안내(«N분 전 수집 — 그 뒤 새 글이 필요하면 찾아보세요»)가 메운다.
 */
export const INTERVAL_TIERS: ReadonlyArray<{ minPerDay: number; sec: number }> = [
  { minPerDay: 20, sec: 30 * 60 },     // 하루 20개 이상 — 바쁜 대화
  { minPerDay: 5, sec: 3600 },         // 하루 5~20개
  { minPerDay: 1, sec: 3 * 3600 },     // 하루 1~5개
  { minPerDay: 0.2, sec: 12 * 3600 },  // 닷새에 하나 이상
];
/** 그보다 조용하면 하루에 한 번. */
export const QUIET_INTERVAL_SEC = 86400;
/** 빈도를 아직 모를 때(표본 부족) — unit-store DEFAULT_UNIT_INTERVAL_SEC 와 같은 값. */
export const UNKNOWN_INTERVAL_SEC = 3600;
/** 밀린 단위의 다음 판 — 곧바로(다음 틱). 매니지드 틱은 5분 격자라 실제로는 그만큼 뒤다. */
export const CATCHUP_DELAY_SEC = 60;
/** 못 읽은 판의 물러서기 — 첫 번 10분, 연달아 실패할수록 두 배, 최대 6시간. */
export const RETRY_BASE_SEC = 600;
export const RETRY_MAX_SEC = 6 * 3600;
/** 실행 기록에서 «아직 도는 중» 으로 보는 시간 — 수집 실행의 가장 긴 상한(1시간) + 러너가 스스로 끊는 몫(3분) + 여유 2분. */
export const RUN_ALIVE_SEC = 3600 + 300;

// ── ① 글 빈도 ────────────────────────────────────────────────────────────────

/** 다 읽은 판 하나의 표본 — e: 구간 끝(epoch 초) · s: 구간 길이(초) · n: 그 구간에 올라온 글 수. 단위 행 sched.hist 에 남는다(짧은 키 = 행 크기). */
export interface ActivitySample { e: number; s: number; n: number }

const isSample = (v: unknown): v is ActivitySample => {
  const x = v as Record<string, unknown> | null;
  return !!x && typeof x === "object" && Number.isFinite(x.e) && Number.isFinite(x.s) && Number.isFinite(x.n)
    && (x.s as number) > 0 && (x.n as number) >= 0;
};

/** 저장된 표본 목록(모양이 틀린 것은 버린다) — sched 칸은 같은 표 안의 서버 값이지만 손으로 고쳐졌을 수 있다. */
export function samplesOf(raw: unknown): ActivitySample[] {
  return Array.isArray(raw) ? raw.filter(isSample).map((x) => ({ e: Math.floor(x.e), s: Math.floor(x.s), n: Math.floor(x.n) })) : [];
}

/** 끝 시각이 같은 칸(날·시간)의 표본을 하나로 — 끝은 가장 늦은 끝, 길이·글 수는 더한다. */
function mergeBy(samples: readonly ActivitySample[], slotSec: number): ActivitySample[] {
  const m = new Map<number, ActivitySample>();
  for (const x of samples) {
    const k = Math.floor(x.e / slotSec);
    const p = m.get(k);
    m.set(k, p ? { e: Math.max(p.e, x.e), s: p.s + x.s, n: p.n + x.n } : { ...x });
  }
  return [...m.values()];
}

/**
 * 표본 하나를 더한다 — 창(14일) 밖은 버리고, 하루보다 오래된 표본은 날마다 합친다(ACTIVITY_RAW_MAX 머리말). 같은 끝 시각의 낱개
 *  표본이 이미 있으면 바꿔 넣는다(같은 판을 두 번 적지 않게). sample 이 null 이면 오래된 것만 걷고 합친다(다 못 읽은 판 — 표본은 없지만 창은 흐른다).
 */
export function addSample(hist: unknown, sample: ActivitySample | null, nowSec: number): ActivitySample[] {
  const base = sample ? samplesOf(hist).filter((x) => x.e !== Math.floor(sample.e)) : samplesOf(hist);
  if (sample && isSample(sample)) base.push({ e: Math.floor(sample.e), s: Math.floor(sample.s), n: Math.floor(sample.n) });
  const live = base.filter((x) => x.e > nowSec - ACTIVITY_WINDOW_SEC);
  const dayAgo = nowSec - 86400;
  const old = mergeBy(live.filter((x) => x.e <= dayAgo), 86400);
  let raw = live.filter((x) => x.e > dayAgo).sort((a, b) => a.e - b.e);
  if (raw.length > ACTIVITY_RAW_MAX) {
    const cut = raw.length - Math.floor(ACTIVITY_RAW_MAX / 2);
    raw = [...mergeBy(raw.slice(0, cut), 3600), ...raw.slice(cut)];
  }
  return [...old, ...raw].sort((a, b) => a.e - b.e);
}

export interface Activity {
  /** 하루 평균 새 글 수 — 본 시간이 ACTIVITY_MIN_OBSERVED_SEC 보다 짧으면 null(모름). */
  perDay: number | null;
  /** 최근 14일 안에서 실제로 다 읽은 시간(초) · 그 안의 글 수 · 표본 수. */
  observedSec: number; items: number; samples: number;
}

/** 최근 14일 표본 → 하루 평균. 구간 일부가 창 밖이면 창 안 몫만 센다(글 수는 구간 안에서 고르게 올라왔다고 본다). */
export function activityOf(hist: unknown, nowSec: number): Activity {
  const from = nowSec - ACTIVITY_WINDOW_SEC;
  let observed = 0, items = 0, samples = 0;
  for (const x of samplesOf(hist)) {
    if (x.e <= from) continue;
    const start = x.e - x.s;
    const inside = start >= from ? x.s : x.e - from;
    observed += inside;
    items += x.n * (inside / x.s);
    samples++;
  }
  return {
    perDay: observed >= ACTIVITY_MIN_OBSERVED_SEC ? (items / observed) * 86400 : null,
    observedSec: Math.round(observed), items: Math.round(items * 100) / 100, samples,
  };
}

// ── ② 주기 ───────────────────────────────────────────────────────────────────

/** 하루 평균 → 주기(초). 모르면 UNKNOWN_INTERVAL_SEC. */
export function recommendIntervalSec(perDay: number | null): number {
  if (perDay == null || !Number.isFinite(perDay)) return UNKNOWN_INTERVAL_SEC;
  for (const t of INTERVAL_TIERS) if (perDay >= t.minPerDay) return t.sec;
  return QUIET_INTERVAL_SEC;
}

/** 이 단위의 주기 — 자동이면 빈도에서, 고정이면 정해 둔 값(없으면 모를 때의 값). */
export function effectiveIntervalSec(u: { interval_sec: number | null; interval_auto: boolean }, hist: unknown, nowSec: number): number {
  if (!u.interval_auto) return u.interval_sec != null && u.interval_sec >= 60 ? u.interval_sec : UNKNOWN_INTERVAL_SEC;
  return recommendIntervalSec(activityOf(hist, nowSec).perDay);
}

// ── ③ 다음 확인 시각 ──────────────────────────────────────────────────────────

/** 그 단위를 이번 판이 어떻게 읽었나 — 다 읽음 · 못 다 읽음(구간을 줄였다) · 안 읽음(맡겼는데 호출이 없다) · 막힘(원문 잘림·저장 실패). */
export type ReadOutcome = "complete" | "incomplete" | "unread" | "blocked";

export interface NextCheckInput {
  nowSec: number;
  intervalSec: number;
  outcome: ReadOutcome;
  /** 다 읽었지만 아직 «지금» 까지 못 왔다 — 다음 구간의 끝도 지금보다 앞(처음 수집 14일을 7일·1일 구간으로 따라잡는 중). */
  behind?: boolean;
  /** 못 다 읽어서 다음 판의 구간을 줄였다(슬랙·지메일). 노션처럼 줄일 구간이 없는 단위는 false — 곧바로 다시 읽어도 같은 결과다. */
  shrunk?: boolean;
  /** 못 다 읽었는데 구간을 더 줄일 수 없다(이미 1시간) — 같은 자리에 머문다. */
  stuck?: boolean;
  /** 이번 판 전까지 연달아 진척이 없던 판 수. */
  fails?: number;
}

export type NextWhy = "interval" | "catchup" | "retry";

/** 저장 단계가 단위 하나에 대해 넘기는 «이번 판에 어떻게 읽었나» — collect-plan.readNoteOf 가 만든다. */
export interface ReadNote {
  outcome: ReadOutcome;
  behind?: boolean;
  shrunk?: boolean;
  stuck?: boolean;
  /** 다 읽은 판의 글 빈도 표본. */
  sample?: ActivitySample | null;
}

/** 물러서기 간격 — k 번째 연속 실패(1부터). */
export function retryDelaySec(k: number): number {
  const n = Math.max(1, Math.floor(k));
  return Math.min(RETRY_BASE_SEC * 2 ** Math.min(n - 1, 20), RETRY_MAX_SEC);
}

/**
 * 다음 확인 시각(epoch 초)과 연속 실패 수. 사양:
 *  · 다 읽음 + 따라잡음 → 주기 뒤 · 실패 수 0
 *  · 다 읽음 + 밀림 → 곧바로 · 실패 수 0
 *  · 못 다 읽음 + 구간을 줄였다 → 곧바로 · 실패 수 그대로(줄이며 따라잡는 중이다 — 바닥에 닿으면 아래 갈래로 간다)
 *  · 못 다 읽음 + 줄일 구간이 없다(노션 — 리뷰 2026-10-17: 곧바로 다시 읽으면 같은 실패가 틱마다 되풀이된다) · 더 못 줄임(stuck) ·
 *    안 읽음 · 막힘 → 물러서기(실패 수 + 1)
 */
export function nextCheck(i: NextCheckInput): { nextSec: number; fails: number; why: NextWhy } {
  const now = Math.floor(i.nowSec);
  const fails = Math.max(0, Math.floor(i.fails ?? 0));
  const interval = Math.max(60, Math.floor(i.intervalSec));
  if (i.outcome === "complete") {
    if (i.behind) return { nextSec: now + CATCHUP_DELAY_SEC, fails: 0, why: "catchup" };
    return { nextSec: now + interval, fails: 0, why: "interval" };
  }
  if (i.outcome === "incomplete" && i.shrunk && !i.stuck) return { nextSec: now + CATCHUP_DELAY_SEC, fails, why: "catchup" };
  return { nextSec: now + retryDelaySec(fails + 1), fails: fails + 1, why: "retry" };
}

// ── ④ 때가 된 단위 · 띄울 구성원 ───────────────────────────────────────────────

/**
 * 이 단위를 지금 읽을 때가 됐나 — 다음 확인 시각이 있으면 그것, 없으면(한 번도 주기 판정을 안 받은 단위 · T12 전 단위) 읽은 시각 + 주기.
 *  처음 읽는 단위(읽은 시각 없음)는 늘 때가 됐다 — 모으기로 켜는 순간 다음 틱에 처음 수집이 돈다.
 */
export function isUnitDue(u: { next_at: string | null; read_at: string | null; interval_sec: number | null }, nowMs: number): boolean {
  if (u.next_at) {
    const t = Date.parse(u.next_at);
    return !Number.isFinite(t) || t <= nowMs;
  }
  if (!u.read_at) return true;
  const r = Date.parse(u.read_at);
  return !Number.isFinite(r) || nowMs - r >= Math.max(60, u.interval_sec ?? UNKNOWN_INTERVAL_SEC) * 1000;
}

/** 곧 때가 될 단위를 주기 판에 함께 싣는 문턱 — 남은 시간이 주기의 이만큼 이하. */
export const SOON_RATIO = 0.5;

/**
 * 곧 때가 될 단위인가 — 주기대로 기다리는 중(마지막 판정이 interval)이고 남은 시간이 주기의 절반 이하. 이미 때가 된 단위는 아니다(isUnitDue 몫).
 *  주기 판에 함께 실어 한 사람의 판 수를 줄인다(판마다 세션 컨테이너가 하나 뜬다). 물러서는 단위(retry)는 싣지 않는다 — 실패한 단위를
 *  남의 주기에 얹어 물러서기를 무르지 않게.
 */
export function isUnitSoon(u: { next_at: string | null; interval_sec: number | null; sched?: Record<string, unknown> | null }, nowMs: number): boolean {
  if (!u.next_at || u.sched?.why !== "interval") return false;
  const t = Date.parse(u.next_at);
  if (!Number.isFinite(t) || t <= nowMs) return false;
  return t - nowMs <= SOON_RATIO * Math.max(60, u.interval_sec ?? UNKNOWN_INTERVAL_SEC) * 1000;
}

/** 때가 된 시각(ms) — 오래 기다린 순서를 매기는 값. 처음 읽는 단위는 0(맨 앞). */
export function dueSinceMs(u: { next_at: string | null; read_at: string | null; interval_sec: number | null }): number {
  if (u.next_at) { const t = Date.parse(u.next_at); return Number.isFinite(t) ? t : 0; }
  if (!u.read_at) return 0;
  const r = Date.parse(u.read_at);
  return Number.isFinite(r) ? r + Math.max(60, u.interval_sec ?? UNKNOWN_INTERVAL_SEC) * 1000 : 0;
}

export interface DueGroup {
  member: string;
  /** 그 사람이 지금 담당이고 때가 된 단위 수. */
  units: number;
  /** 그중 가장 오래 기다린 단위가 때가 된 시각(ms). */
  oldestDueMs: number;
}

/**
 * 이번 틱에 수집 실행을 띄울 구성원 — 가장 오래 기다린 사람부터, 이미 도는 사람·물러선 사람(실패가 이어진 사람)은 빼고, 빈 자리만큼.
 *  같은 입력이면 늘 같은 답이다(같으면 구성원 id 순).
 */
export function pickMembers(groups: readonly DueGroup[], opts: {
  running: ReadonlySet<string>; backoffUntilMs: ReadonlyMap<string, number>; nowMs: number; slots: number;
}): DueGroup[] {
  const slots = Math.max(0, Math.floor(opts.slots));
  if (!slots) return [];
  return groups
    .filter((g) => g.units > 0 && !opts.running.has(g.member) && !((opts.backoffUntilMs.get(g.member) ?? 0) > opts.nowMs))
    .slice()
    .sort((a, b) => a.oldestDueMs - b.oldestDueMs || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
    .slice(0, slots);
}

// ── ⑤ 구성원 물러서기 ─────────────────────────────────────────────────────────

/** 실행 기록 한 줄(그 사람의 수집 실행 — 최근 것부터). ingest_state 는 저장 단계 결과(done · failed · running). */
export interface MemberRunRow { started_ms: number; ended_ms: number | null; outcome: string | null; ingest_state: string | null }

/**
 * 실패로 셀 판인가 — 결과가 성공(ok)·턴 상한(max_turns — 읽은 만큼은 저장된다)이 아니거나, 결과는 됐는데 저장 단계가 실패했다.
 *  아직 끝을 모르는 판(결과 없음)은 세지 않는다(도는 중이거나, 훑기가 곧 끝을 적는다).
 */
export function runFailed(r: MemberRunRow): boolean | null {
  if (!r.outcome) return null;
  if (r.outcome !== "ok" && r.outcome !== "max_turns") return true;
  return r.ingest_state === "failed";
}

/**
 * 그 사람의 수집 실행을 언제까지 띄우지 않나(ms) — 최근 것부터 연달아 실패한 수 k 만큼 마지막 실패 뒤 retryDelaySec(k).
 *  성공한 판을 만나면 거기서 센다. 물러설 일이 없으면 null.
 */
export function memberBackoffUntil(rowsNewestFirst: readonly MemberRunRow[]): number | null {
  let k = 0;
  let lastFailMs: number | null = null;
  for (const r of rowsNewestFirst) {
    const f = runFailed(r);
    if (f == null) continue;
    if (!f) break;
    k++;
    if (lastFailMs == null) lastFailMs = r.ended_ms ?? r.started_ms;
  }
  return k && lastFailMs != null ? lastFailMs + retryDelaySec(k) * 1000 : null;
}

// 자동 생성 프로젝트 정리(project_gc)의 판정 — 순수 함수. DB·쓰기는 project-gc.ts 가 한다.
//
//  ── 왜 서버가 치우나 ──
//  세션 첫 지시마다 프로젝트가 자동으로 생기고(project/first-prompt-project.ts), 그 세션이 끝나면 다시 열리지 않는 것이
//   진행 중 목록에 남는다. 사람은 그것을 하나씩 닫지 않으므로 정리는 서버 몫이다.
//
//  ── 두 단계 ──
//   empty — 기록이 없고 손길이 empty_days 넘게 없다 → 기계가 지은 이름(rule·NULL)이면 «닫고 휴지통», 세션·에이전트가
//           이름을 다듬은 것이면 «닫기» 만. 이름을 다듬었다는 건 그 세션이 무언가 했다는 약한 신호라 버리지는 않는다.
//   idle  — 기록이 있고 손길이 idle_days 넘게 없다 → «닫기». 기록이 있는 프로젝트는 버리지 않는다.
//  휴지통은 되돌릴 수 있는 쪽이고, 영구 삭제는 하지 않는다.
//  기한이 남았거나 사람이 담당자를 지정한 열린 하위가 있는 프로젝트(protected)는 손길과 무관하게 건드리지 않는다 — 누군가 맡은 일이다.
//
//  ── 상한 ──
//  단계별 후보가 cap 을 넘으면 그 단계는 아무것도 하지 않는다(halted). 기준값을 잘못 넣었거나 손길 계산이 깨져
//   «전부가 후보» 가 된 상황을 한 번의 회차로 퍼뜨리지 않기 위해서다. 회차당 쓰기는 batch_* 로 묶는다.

export type GcMode = "report" | "on";

export interface GcOptions {
  mode: GcMode;
  emptyDays: number;
  idleDays: number;
  batchTrash: number;
  batchClose: number;
  batchChildren: number;
  cap: number;
}

export const GC_DEFAULTS: GcOptions = {
  mode: "report", emptyDays: 14, idleDays: 30, batchTrash: 150, batchClose: 50, batchChildren: 200, cap: 1000,
};

/** 후보 SQL 이 돌려주는 한 줄(project-gc.ts candidateRows). */
export interface GcRow {
  id: number;
  nameSource: string | null;
  hasRecord: boolean;
  lastTouch: Date;
  /** 기한이 남았거나 사람이 담당자를 지정한 열린 하위가 있다. */
  protected: boolean;
  /** 함께 닫을 열린 하위(태스크·서브태스크, 커넥터가 만든 것 제외) 수. */
  openChildren: number;
}

export interface GcPick { id: number; idleDays: number; openChildren: number }

export interface GcStageSummary {
  candidates: number;
  halted: boolean;
  /** 이번 회차에 고른 것 — report 모드에선 «했을 일» 이다. */
  trash: number;
  close: number;
  /** 하위 상한·회차 상한에 걸려 다음 회차로 넘긴 수. */
  deferred: number;
  sampleIds: number[];
}

export interface GcPlan {
  mode: GcMode;
  protectedExcluded: number;
  empty: GcStageSummary;
  idle: GcStageSummary;
  /** 실제로 쓸 것 — report 면 비어 있다. */
  writes: { trash: GcPick[]; close: GcPick[] };
}

const SAMPLE = 10;
const DAY_MS = 86_400_000;

function intParam(raw: unknown, def: number, min: number, max: number): number {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 크론 params → 옵션. on 이 아닌 값은 전부 report(쓰기 0)다 — 오타가 쓰기를 켜지 않게. */
export function parseGcOptions(params: Record<string, unknown>): GcOptions {
  const d = GC_DEFAULTS;
  return {
    mode: String(params.mode ?? "").trim() === "on" ? "on" : "report",
    emptyDays: intParam(params.empty_days, d.emptyDays, 1, 3650),
    idleDays: intParam(params.idle_days, d.idleDays, 1, 3650),
    batchTrash: intParam(params.batch_trash, d.batchTrash, 0, 10_000),
    batchClose: intParam(params.batch_close, d.batchClose, 0, 10_000),
    batchChildren: intParam(params.batch_children, d.batchChildren, 0, 100_000),
    cap: intParam(params.cap, d.cap, 1, 1_000_000),
  };
}

/** rule 또는 NULL — 기계가 지은 이름. NULL 은 name_source 컬럼 이전 행이라 rule 로 본다. */
export function isMachineNamed(nameSource: string | null): boolean {
  return nameSource == null || nameSource === "rule";
}

/**
 * 하위 n 개를 더 닫아도 되나. 회차의 하위 예산을 아직 하나도 안 썼으면 상한보다 많아도 그 프로젝트 하나는 받는다 —
 *  안 그러면 하위가 상한보다 많은 프로젝트는 매 회차 미뤄져 영영 정리되지 않는다. 실행 시 다시 읽은 하위 수에도 같은 규칙을 쓴다.
 */
export function childBudgetAllows(used: number, n: number, cap: number): boolean {
  return n === 0 || used === 0 || used + n <= cap;
}

/** 그 시간대의 날짜(YYYY-MM-DD) — 기한(due_date)은 날짜 문자열이라 서버 시간대가 아니라 조직 시간대의 오늘과 견준다. 모르는 시간대는 UTC. */
export function localDateOf(now: Date, tz: string): string {
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }); }
  return fmt.format(now);
}

function idleDaysOf(row: GcRow, now: Date): number {
  return (now.getTime() - row.lastTouch.getTime()) / DAY_MS;
}

export function planProjectGc(rows: ReadonlyArray<GcRow>, opts: GcOptions, now: Date): GcPlan {
  const eligible = rows.filter((r) => !r.protected && r.nameSource !== "human");
  const protectedExcluded = rows.filter((r) => r.protected).length;
  const oldestFirst = (a: GcRow, b: GcRow) => a.lastTouch.getTime() - b.lastTouch.getTime() || a.id - b.id;
  const emptyRows = eligible.filter((r) => !r.hasRecord && idleDaysOf(r, now) > opts.emptyDays).sort(oldestFirst);
  const idleRows = eligible.filter((r) => r.hasRecord && idleDaysOf(r, now) > opts.idleDays).sort(oldestFirst);

  const trash: GcPick[] = [];
  const close: GcPick[] = [];
  let childrenUsed = 0;
  const pick = (r: GcRow): GcPick => ({ id: r.id, idleDays: Math.floor(idleDaysOf(r, now)), openChildren: r.openChildren });

  // 닫을 때 하위도 함께 닫으므로, 하위 예산이 모자라면 그 프로젝트는 이번 회차에 건드리지 않는다(프로젝트만 닫히고 하위가 열린 채 남지 않게).
  const take = (r: GcRow, bucket: GcPick[], limit: number): boolean => {
    if (bucket.length >= limit || !childBudgetAllows(childrenUsed, r.openChildren, opts.batchChildren)) return false;
    childrenUsed += r.openChildren;
    bucket.push(pick(r));
    return true;
  };

  const stage = (list: GcRow[], route: (r: GcRow) => "trash" | "close"): GcStageSummary => {
    const s: GcStageSummary = {
      candidates: list.length, halted: list.length > opts.cap, trash: 0, close: 0, deferred: 0,
      sampleIds: list.slice(0, SAMPLE).map((r) => r.id),
    };
    if (s.halted) return s;
    for (const r of list) {
      const to = route(r);
      const ok = to === "trash" ? take(r, trash, opts.batchTrash) : take(r, close, opts.batchClose);
      if (!ok) s.deferred++;
      else if (to === "trash") s.trash++;
      else s.close++;
    }
    return s;
  };

  const empty = stage(emptyRows, (r) => (isMachineNamed(r.nameSource) ? "trash" : "close"));
  const idle = stage(idleRows, () => "close");
  const writes = opts.mode === "on" ? { trash, close } : { trash: [], close: [] };
  return { mode: opts.mode, protectedExcluded, empty, idle, writes };
}

/** 닫는 사유 — 완료 경로가 외부 미러(ClickUp 등)에 코멘트로 남기는 그 필드로 간다. */
export function gcCloseReason(idleDays: number): string {
  return `${idleDays}일 동안 손길이 없는 자동 생성 프로젝트라 자동으로 닫았습니다. 이어서 할 일이면 다시 열어 주세요.`;
}

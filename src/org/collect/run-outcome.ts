// 수집 실행(#4213 T11) 한 판의 **결과 분류 · 지표 · 묶음 통계** — 순수(DB·시계 없음). 기록·조회는 run-log.ts 가 한다.
//
//  왜 따로 있나: [수집 · 증류 ▸ 수집기 설정 ▸ Claude 커넥터 수집] 화면은 «크기를 얼마로 둘까» 를 정하는 자리다(상민님 2026-10-16
//   «크기는 추천안으로 가고 대시보드에서 바꿀 수 있게 · 실패율 같은 지표로 의사결정 돕게»). 그 판단은 숫자 몇 개에 걸린다 —
//   실패율 · 메모리 탓일 수 있는 실패 · 최고 메모리가 상한에 얼마나 붙었나. 그 셈을 한 곳에 두고 표로 시험한다.
//
//  입력 모양은 collect-run-script.ts 의 exit.json · summary.json 그대로다. 그 파일은 **그 사람 홈**에서 오므로 칸마다 모양을 확인한다
//   (모르는 모양은 null — 지표가 비는 것이 틀린 숫자보다 낫다).
//  로그인 끊김 · 한도 초과 · 커넥터 없음은 수집 단위 표(T10)의 판정(classifyCollectRun)을 그대로 쓴다 — 같은 실행을 두 곳이 다르게
//   부르면 «담당에서 빠졌는데 지표는 성공» 같은 어긋남이 생긴다.
import { classifyCollectRun } from "./unit-plan.js";

export type RunOutcome =
  | "ok" | "login" | "quota" | "no_connector" | "oom" | "gone" | "timeout" | "lost" | "max_turns" | "canceled" | "error";

export const RUN_OUTCOME_LABEL: Readonly<Record<RunOutcome, string>> = {
  ok: "성공",
  login: "Claude 로그인 끊김",
  quota: "사용 한도 초과",
  no_connector: "연결된 커넥터 없음",
  oom: "강제 종료(메모리 초과 추정)",
  gone: "끝 신호 없이 세션이 사라짐",
  timeout: "시간 상한 초과",
  lost: "끝 신호를 못 받음",
  max_turns: "턴 상한 도달",
  canceled: "취소됨",
  error: "실행 오류",
};

/**
 * 메모리 탓일 수 있는 실패 — 크기를 정할 때 보는 묶음. oom 은 claude 가 SIGKILL(137)로 끝났다(우리 시간 상한이 아닌데) ·
 *  gone 은 러너까지 끝 신호 없이 사라졌다(컨테이너가 통째로 OOM 이면 이렇게 된다 — 노드 재시작도 같은 모양이라 «추정» 이다).
 */
export const MEMORY_SUSPECT: ReadonlySet<RunOutcome> = new Set<RunOutcome>(["oom", "gone"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
/** collect_run 의 INT 칸 상한 — 넘는 값(위조·cgroup v1 의 «무제한» 같은 거대한 수)은 모르는 값(null)으로. 넣다 실패하면 끝 기록이 통째로 빠진다. */
const INT_MAX = 2_147_483_647;
const nonNegInt = (v: unknown): number | null => { const n = int(v); return n != null && n >= 0 && n <= INT_MAX ? n : null; };
const cap = (s: string | null, n = 300): string | null => (s == null ? null : s.slice(0, n));
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 끝난 실행 한 판 → 결과. exit 가 없으면(아직 도는 중) null.
 *  순서가 뜻이다: 게이트웨이가 적은 끝(lost · runner-gone) → 우리 시간 상한 → 취소 → 강제 종료 → 로그인·한도·커넥터(T10) → 턴 상한 → 성공 → 그 밖.
 *  시간 상한은 강제 종료보다 먼저다 — 러너가 상한에서 SIGTERM 뒤 5초 만에 SIGKILL 을 보내므로 신호만 보면 메모리로 오인한다.
 */
export function classifyRunOutcome(
  exit: Record<string, unknown> | null, summary: Record<string, unknown> | null,
): { outcome: RunOutcome; error: string | null } | null {
  if (!exit) return null;
  const rawErr = exit.error;
  const err = rawErr == null ? null : str(rawErr);
  const errOut = err == null ? null : err.slice(0, 300);
  if (rawErr != null && err == null) return { outcome: "error", error: "알 수 없는 끝 사유" };
  if (err === "lost") return { outcome: "lost", error: errOut };
  if (err === "runner-gone") return { outcome: "gone", error: errOut };
  if (err === "timeout" || exit.timedOut === true) return { outcome: "timeout", error: errOut ?? "timeout" };
  if (err === "canceled") return { outcome: "canceled", error: errOut };
  if (exit.signal === "SIGKILL" || exit.code === 137 || err === "claude exit 137") return { outcome: "oom", error: errOut ?? "SIGKILL" };
  const sum = rec(summary);
  const res = rec(sum?.result);
  const verdict = classifyCollectRun({
    exit: { error: err, code: int(exit.code) },
    summary: sum ? {
      stderrTail: str(sum.stderrTail), allowed: strList(sum.allowed), missing: strList(sum.missing),
      result: res ? { subtype: str(res.subtype), error: res.error, text: str(res.text) } : null,
    } : null,
    requested: strList(sum?.apps),
  });
  const states = new Set(verdict.changes.map((c) => c.state));
  if (states.has("login_broken")) return { outcome: "login", error: errOut ?? verdict.changes[0]?.reason ?? null };
  if (states.has("quota")) return { outcome: "quota", error: errOut ?? "한도 초과" };
  if (err === "no-connector") return { outcome: "no_connector", error: errOut };
  if (str(res?.subtype) === "error_max_turns") return { outcome: "max_turns", error: errOut ?? "error_max_turns" };
  if (err == null && exit.code === 0 && res && res.error !== true) return { outcome: "ok", error: null };
  return { outcome: "error", error: errOut ?? (res ? (cap(str(res.subtype)) ?? "결과 오류") : "결과 없음") };
}

/** 게이트웨이가 적는 끝(끝 신호 없음 · 판이 사라짐) — by: "gateway" 가 러너가 쓴 끝과 가르는 표식이다(러너의 exit.json 에는 이 칸이 없다). */
export function gatewayExit(why: "lost" | "runner-gone", at: Date = new Date()): Record<string, unknown> {
  return { code: null, error: why, endedAt: at.toISOString(), by: "gateway" };
}

/** 그 끝을 누가 적었나 — 실행 기록은 게이트웨이 추정만 늦게 온 러너 끝이 덮게 한다(run-log recordRunEnd). */
export function endedByOf(exit: Record<string, unknown> | null): "runner" | "gateway" {
  return exit?.by === "gateway" ? "gateway" : "runner";
}

export interface RunMetrics {
  /** 이 실행이 본 메모리 한도(MB) — cgroup 상한, 없으면 컨테이너 전체(gVisor 는 MemTotal 이 곧 상한). */
  mem_limit_mb: number | null;
  mem_start_mb: number | null;
  /** 한도와 견줄 최고 사용(MB) — 한도와 같은 출처의 값. */
  mem_peak_mb: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  turns: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  captures: number | null;
}

/** "1073741824" 같은 cgroup 바이트 문자열 → MB. "max"·잡값 → null. */
function bytesMb(v: unknown): number | null {
  const s = str(v)?.trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  //  1TB 넘는 «상한» 은 상한이 아니다 — cgroup v1 은 무제한을 9223372036854771712 같은 수로 적는다(그 값을 넣으면 INT 칸이 터진다).
  return Number.isFinite(n) && n > 0 && n <= 1024 * 1024 * 1048576 ? Math.round(n / 1048576) : null;
}

/**
 * 실행 한 판의 숫자. **한도와 최고 사용은 같은 출처**에서 짝으로 고른다 —
 *  cgroup 상한이 숫자로 보이면(셀프호스트 scope 격리) cgroup 짝, 아니면 컨테이너 짝(매니지드 gVisor: cgroup 파일이 안 보이고
 *  MemTotal 이 그 컨테이너 상한이다). 셀프호스트의 /proc/meminfo 는 호스트 전체라 cgroup 이 있을 때 쓰면 틀린다.
 */
export function runMetricsOf(exit: Record<string, unknown> | null, summary: Record<string, unknown> | null): RunMetrics {
  const sum = rec(summary);
  const mem = rec(sum?.mem);
  const res = rec(sum?.result);
  const cgLimit = bytesMb(mem?.cgroupMax);
  const container = rec(mem?.container);
  let limit: number | null = null, start: number | null = null, peak: number | null = null;
  if (cgLimit != null) {
    limit = cgLimit;
    const a = nonNegInt(mem?.cgroupPeakMb), b = nonNegInt(mem?.cgroupPeakFileMb);
    peak = a == null && b == null ? null : Math.max(a ?? 0, b ?? 0);
  } else if (container) {
    limit = nonNegInt(container.totalMb);
    start = nonNegInt(container.startMb);
    peak = nonNegInt(container.peakMb);
  }
  const calls = Array.isArray(sum?.calls) ? (sum!.calls as unknown[]) : null;
  const cost = res?.costUsd;
  return {
    mem_limit_mb: limit, mem_start_mb: start, mem_peak_mb: peak,
    duration_ms: nonNegInt(exit?.durationMs) ?? nonNegInt(res?.durationMs),
    cost_usd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    turns: nonNegInt(res?.turns),
    tool_calls: calls ? calls.length : null,
    tool_errors: calls ? calls.filter((c) => rec(c)?.error === true).length : null,
    captures: nonNegInt(sum?.captures),
  };
}

// ── 묶음 통계 ────────────────────────────────────────────────────────────────

/** 통계에 넣는 한 줄 — collect_run 행에서 필요한 칸만. */
export interface RunStatRow {
  started_at: string;
  outcome: RunOutcome | null;
  cap_mb: number | null;
  mem_limit_mb: number | null;
  mem_peak_mb: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
}

export interface RunStats {
  runs: number;
  running: number;
  finished: number;
  ok: number;
  failed: number;
  /** 끝난 것 중 실패 비율(0~1). 끝난 실행이 없으면 null(0% 가 아니다). */
  failure_rate: number | null;
  outcomes: Array<{ outcome: RunOutcome; label: string; count: number; memory_suspect: boolean }>;
  memory: {
    samples: number;
    p50_mb: number | null; p75_mb: number | null; p95_mb: number | null; max_mb: number | null;
    /** 최고 사용이 그 실행이 잰 한도의 90% 이상이었던 실행 수. */
    near_cap: number;
    /** 표본 중 한도 대비 가장 높았던 비율(0~1). */
    max_ratio: number | null;
    /** 메모리 탓일 수 있는 실패(oom + gone). */
    suspect_failures: number;
    /** 잰 값이 그 실행의 상한과 견줄 수 없어(호스트 전체 메모리 등) 표본에서 뺀 실행 수. */
    excluded: number;
  };
  duration: { p50_sec: number | null; p95_sec: number | null };
  cost: { total_usd: number; avg_usd: number | null };
  tools: { calls: number; errors: number };
  daily: Array<{ day: string; runs: number; failed: number; peak_max_mb: number | null }>;
  /** 크기 추천 — 표본이 적으면 null. 규칙은 rule 에 그대로 적는다(화면이 그 문장을 보여 준다). */
  suggestion: { max_mb: number; request_mb: number; samples: number; rule: string } | null;
}

/** 최근접 순위 백분위(오름차순 배열). 비면 null. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const roundUp = (n: number, step: number): number => Math.ceil(n / step) * step;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** 추천에 필요한 최소 표본 — 몇 판으로 크기를 정하면 운에 기댄다. */
export const SUGGEST_MIN_SAMPLES = 10;

/**
 * 크기 추천 — 상한 = 최고 사용 × 1.25 를 128MB 단위로 올림(가장 무거웠던 판에도 1/4 여유) ·
 *  예약 = 상위 25%(p75) 를 64MB 단위로 올림(보통 판이 차지하는 자리). 범위 안으로 접고 예약 ≤ 상한.
 *  메모리 탓일 수 있는 실패가 있으면 상한은 **그 실패들이 돈 상한 × 1.25 아래로 내려가지 않는다** — 그 판들은 최고 사용을 남기지
 *  못하고 죽어(gone 은 요약이 없다) 표본에 없다. 살아남은 판만 보고 줄이면 이미 모자란 크기보다 작게 권한다.
 */
export function suggestSize(
  peaksSorted: readonly number[],
  opts: { suspectCapMb?: number | null; suspects?: number; bounds?: { maxMin: number; reqMin: number; max: number } } = {},
): RunStats["suggestion"] {
  const bounds = opts.bounds ?? { maxMin: 256, reqMin: 128, max: 8192 };
  if (peaksSorted.length < SUGGEST_MIN_SAMPLES) return null;
  const top = peaksSorted[peaksSorted.length - 1];
  const p75 = percentile(peaksSorted, 75)!;
  let maxMb = clamp(roundUp(top * 1.25, 128), bounds.maxMin, bounds.max);
  let rule = `상한 = 최고 ${top}MB × 1.25 → 128MB 단위 올림 · 예약 = 상위 25% ${p75}MB → 64MB 단위 올림`;
  const sc = opts.suspectCapMb ?? null;
  if (sc && sc > 0) {
    const floor = clamp(roundUp(sc * 1.25, 128), bounds.maxMin, bounds.max);
    if (floor > maxMb) maxMb = floor;
    rule += ` · 메모리 의심 실패 ${opts.suspects ?? 0}회가 돈 상한 ${sc}MB × 1.25 아래로는 권하지 않음`;
  }
  const reqMb = Math.min(maxMb, clamp(roundUp(p75, 64), bounds.reqMin, bounds.max));
  return { max_mb: maxMb, request_mb: reqMb, samples: peaksSorted.length, rule };
}

const dayFmt = new Map<string, Intl.DateTimeFormat | null>();
/** 날짜 키(YYYY-MM-DD) — 보는 사람의 시간대로. 시간대 이름이 틀리면 UTC. 시간대마다 포맷터 하나(줄마다 만들지 않는다). */
export function dayKey(iso: string, tz: string): string {
  const d = new Date(iso);
  let f = dayFmt.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { f = null; }
    if (dayFmt.size > 64) dayFmt.clear();
    dayFmt.set(tz, f);
  }
  return f ? f.format(d) : d.toISOString().slice(0, 10);
}

/** 도는 중으로 남은 행을 «끝 신호를 못 받음» 으로 셀 나이 — 가장 긴 상한(1시간) + 러너가 스스로 끊고 정리하는 몫(3분). */
export const STALE_RUN_MS = 3600_000 + 180_000;

/**
 * 잰 메모리가 그 판의 상한과 견줄 값인가 — 매니지드(gVisor)는 컨테이너 MemTotal 이 곧 상한이라 둘이 같다. 셀프호스트에서 cgroup 을 못 보면
 *  /proc/meminfo 가 호스트 전체라 한도가 상한과 동떨어진다 — 그런 판은 백분위·추천에 넣지 않는다(틀린 숫자로 크기를 정하지 않게).
 */
export function comparableMemory(r: Pick<RunStatRow, "cap_mb" | "mem_limit_mb" | "mem_peak_mb">): boolean {
  if (r.mem_peak_mb == null || r.mem_limit_mb == null) return false;
  if (r.cap_mb == null) return r.mem_limit_mb <= 16384;
  return Math.abs(r.mem_limit_mb - r.cap_mb) <= Math.max(64, r.cap_mb * 0.1);
}

export function summarizeRuns(rows: readonly RunStatRow[], opts: { tz?: string; now?: number } = {}): RunStats {
  const tz = opts.tz || "UTC";
  const now = opts.now ?? Date.now();
  const counts = new Map<RunOutcome, number>();
  const peaks: number[] = [];
  const durs: number[] = [];
  let running = 0, nearCap = 0, maxRatio: number | null = null, costTotal = 0, costN = 0, calls = 0, toolErr = 0, excluded = 0;
  let suspectCap: number | null = null;
  const days = new Map<string, { runs: number; failed: number; peak: number | null }>();
  for (const r of rows) {
    const day = dayKey(r.started_at, tz);
    const d = days.get(day) ?? { runs: 0, failed: 0, peak: null };
    d.runs++;
    days.set(day, d);
    //  끝 기록이 없는 채 상한을 넘긴 판 = 끝 신호를 못 받은 것(게이트웨이 재기동 · 기록 실패). 도는 중으로 두면 실패율에서 빠진다.
    let outcome = r.outcome;
    if (!outcome) {
      const t = new Date(r.started_at).getTime();
      if (Number.isFinite(t) && now - t > STALE_RUN_MS) outcome = "lost";
      else { running++; continue; }
    }
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (outcome !== "ok") d.failed++;
    if (MEMORY_SUSPECT.has(outcome) && r.cap_mb != null) suspectCap = Math.max(suspectCap ?? 0, r.cap_mb);
    if (r.mem_peak_mb != null) {
      if (comparableMemory(r)) {
        peaks.push(r.mem_peak_mb);
        d.peak = Math.max(d.peak ?? 0, r.mem_peak_mb);
        const lim = r.mem_limit_mb;   // comparableMemory 를 지났으면 있다
        if (lim && lim > 0) {
          const ratio = r.mem_peak_mb / lim;
          if (ratio >= 0.9) nearCap++;
          if (maxRatio == null || ratio > maxRatio) maxRatio = ratio;
        }
      } else excluded++;
    }
    if (r.duration_ms != null) durs.push(r.duration_ms);
    if (r.cost_usd != null) { costTotal += r.cost_usd; costN++; }
    calls += r.tool_calls ?? 0;
    toolErr += r.tool_errors ?? 0;
  }
  peaks.sort((a, b) => a - b);
  durs.sort((a, b) => a - b);
  const finished = rows.length - running;
  const ok = counts.get("ok") ?? 0;
  const failed = finished - ok;
  const suspects = [...MEMORY_SUSPECT].reduce((n, o) => n + (counts.get(o) ?? 0), 0);
  const outcomes = [...counts.entries()]
    .filter(([o]) => o !== "ok")
    .map(([outcome, count]) => ({ outcome, label: RUN_OUTCOME_LABEL[outcome], count, memory_suspect: MEMORY_SUSPECT.has(outcome) }))
    .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome));
  const sec = (ms: number | null): number | null => (ms == null ? null : Math.round(ms / 1000));
  return {
    runs: rows.length, running, finished, ok, failed,
    failure_rate: finished ? failed / finished : null,
    outcomes,
    memory: {
      samples: peaks.length,
      p50_mb: percentile(peaks, 50), p75_mb: percentile(peaks, 75), p95_mb: percentile(peaks, 95),
      max_mb: peaks.length ? peaks[peaks.length - 1] : null,
      near_cap: nearCap, max_ratio: maxRatio, suspect_failures: suspects, excluded,
    },
    duration: { p50_sec: sec(percentile(durs, 50)), p95_sec: sec(percentile(durs, 95)) },
    cost: { total_usd: costTotal, avg_usd: costN ? costTotal / costN : null },
    tools: { calls, errors: toolErr },
    daily: [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, runs: v.runs, failed: v.failed, peak_max_mb: v.peak })),
    suggestion: suggestSize(peaks, { suspectCapMb: suspects ? suspectCap : null, suspects }),
  };
}

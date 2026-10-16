// 수집 실행 결과 분류 · 지표 · 묶음 통계(#4213 T11) — 사양 S2(O)·S3(M)·S4(A) 행(스크래치 사양 spec-t11-metrics.md).
//  입력 모양은 러너(collect-run-script.ts)가 쓰는 exit.json · summary.json 그대로다 — 그 모양을 여기 손으로 만든다.
import assert from "node:assert/strict";
import {
  classifyRunOutcome, runMetricsOf, summarizeRuns, suggestSize, percentile, dayKey, RUN_OUTCOME_LABEL, MEMORY_SUSPECT,
  type RunStatRow,
} from "./run-outcome.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const exitOf = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  startedAt: "2026-10-16T05:09:14.000Z", endedAt: "2026-10-16T05:09:31.000Z", durationMs: 17000, timedOut: false,
  code: 0, signal: null, error: null, ...o,
});
const sumOf = (o: Record<string, unknown> = {}, result: Record<string, unknown> | null = {}): Record<string, unknown> => ({
  runId: "cr-20261016050914-1v1umo", apps: ["Slack"], allowed: ["Slack"], missing: [], denied: 0, captures: 2, stderrTail: "",
  mem: { cgroupPeakMb: null, cgroupPeakFileMb: null, cgroupMax: null, treePeakMb: 700, treePeakProcs: 9, samples: 30,
    container: { totalMb: 768, startMb: 120, peakMb: 657 } },
  calls: [{ tool: "mcp__claude_ai_Slack__slack_read_channel", error: false, chars: 3400 }],
  result: result === null ? null : { subtype: "success", error: false, turns: 3, durationMs: 15000, costUsd: 0.0041, text: "ok", ...result },
  ...o,
});
const outcome = (e: Record<string, unknown> | null, s: Record<string, unknown> | null): string | null => classifyRunOutcome(e, s)?.outcome ?? null;

// ── S2 분류 ──
t("O1 끝 신호가 없으면 분류하지 않는다", () => {
  assert.equal(classifyRunOutcome(null, sumOf()), null);
});
t("O2 정상 끝 → ok", () => {
  assert.deepEqual(classifyRunOutcome(exitOf(), sumOf()), { outcome: "ok", error: null });
});
t("O3 게이트웨이가 적은 lost → lost", () => {
  assert.equal(outcome({ code: null, error: "lost", by: "gateway" }, null), "lost");
});
t("O4 끝 신호 없이 판이 사라짐(runner-gone) → gone", () => {
  assert.equal(outcome({ code: null, error: "runner-gone", by: "gateway" }, null), "gone");
});
t("O5 우리 시간 상한이 아닌데 SIGKILL → oom", () => {
  assert.equal(outcome(exitOf({ code: null, signal: "SIGKILL", error: "claude exit null" }), sumOf({}, null)), "oom");
});
t("O6 시간 상한에서 보낸 SIGKILL 은 timeout(oom 아님)", () => {
  assert.equal(outcome(exitOf({ code: null, signal: "SIGKILL", timedOut: true, error: "timeout" }), sumOf({}, null)), "timeout");
  assert.equal(outcome(exitOf({ code: null, signal: "SIGKILL", timedOut: true, error: "claude exit null" }), sumOf({}, null)), "timeout");
});
t("O7 취소 → canceled", () => {
  assert.equal(outcome(exitOf({ code: null, error: "canceled" }), sumOf({}, null)), "canceled");
});
t("O8 stderr 에 로그인 요구 → login (T10 판정과 같다)", () => {
  assert.equal(outcome(exitOf({ code: 1, error: "claude exit 1" }), sumOf({ stderrTail: "Invalid API key · Please run /login" }, null)), "login");
});
t("O9 stderr 에 한도 → quota", () => {
  assert.equal(outcome(exitOf({ code: 1, error: "claude exit 1" }), sumOf({ stderrTail: "Claude AI usage limit reached|1760000000" }, null)), "quota");
});
t("O10 허락할 커넥터 없음 → no_connector", () => {
  assert.equal(outcome(exitOf({ code: null, error: "no-connector" }), sumOf({ allowed: [], missing: ["Slack"] }, null)), "no_connector");
});
t("O11 턴 상한 → max_turns", () => {
  assert.equal(outcome(exitOf({ code: 1, error: "claude exit 1" }), sumOf({}, { subtype: "error_max_turns", error: true })), "max_turns");
});
t("O12 실행 자체 오류 → error(사유 남김)", () => {
  assert.deepEqual(classifyRunOutcome(exitOf({ code: null, error: "spawn: ENOENT" }), null), { outcome: "error", error: "spawn: ENOENT" });
});
t("O13 0 으로 끝났는데 결과 줄이 없다 → error", () => {
  assert.equal(outcome(exitOf(), sumOf({}, null)), "error");
  assert.equal(outcome(exitOf(), null), "error");
});
t("O14 exit 137 → oom", () => {
  assert.equal(outcome(exitOf({ code: 137, error: "claude exit 137" }), sumOf({}, null)), "oom");
});
t("O15 0 으로 끝났지만 결과가 오류 → error", () => {
  assert.equal(outcome(exitOf(), sumOf({}, { subtype: "error_during_execution", error: true })), "error");
});
t("O16 끝 사유가 문자열이 아니면(그 사람 홈의 잡값) → error", () => {
  assert.equal(outcome(exitOf({ error: 42 }), sumOf()), "error");
  assert.equal(outcome(exitOf({ error: { x: 1 } }), sumOf()), "error");
});
t("O18 사유는 없는데 0 이 아닌 코드(모순 — 손댄 exit) → error", () => {
  assert.equal(outcome(exitOf({ code: 1, error: null }), sumOf()), "error");
});
t("O17 라벨 · 메모리 의심 묶음", () => {
  for (const o of ["ok", "login", "quota", "no_connector", "oom", "gone", "timeout", "lost", "max_turns", "canceled", "error"] as const) assert.ok(RUN_OUTCOME_LABEL[o]);
  assert.deepEqual([...MEMORY_SUSPECT].sort(), ["gone", "oom"]);
});

// ── S3 지표 ──
t("M1 컨테이너 짝(gVisor — cgroup 파일 없음)", () => {
  const m = runMetricsOf(exitOf(), sumOf());
  assert.equal(m.mem_limit_mb, 768); assert.equal(m.mem_start_mb, 120); assert.equal(m.mem_peak_mb, 657);
});
t("M2 cgroup 상한이 보이면 cgroup 짝 — 호스트 meminfo 를 쓰지 않는다", () => {
  const m = runMetricsOf(exitOf(), sumOf({ mem: { cgroupMax: "1073741824", cgroupPeakMb: 500, cgroupPeakFileMb: 520, container: { totalMb: 16000, startMb: 9000, peakMb: 9800 } } }));
  assert.equal(m.mem_limit_mb, 1024); assert.equal(m.mem_peak_mb, 520); assert.equal(m.mem_start_mb, null);
});
t("M3 cgroup 상한이 max 면 컨테이너 짝", () => {
  const m = runMetricsOf(exitOf(), sumOf({ mem: { cgroupMax: "max", cgroupPeakMb: 300, container: { totalMb: 1024, startMb: 110, peakMb: 600 } } }));
  assert.equal(m.mem_limit_mb, 1024); assert.equal(m.mem_peak_mb, 600);
});
t("M4 요약이 없으면(러너가 죽었다) 숫자는 비고 시간만 exit 에서", () => {
  const m = runMetricsOf({ code: null, error: "runner-gone" }, null);
  assert.deepEqual(m, { mem_limit_mb: null, mem_start_mb: null, mem_peak_mb: null, duration_ms: null, cost_usd: null, turns: null, tool_calls: null, tool_errors: null, captures: null });
  assert.equal(runMetricsOf(exitOf({ durationMs: 4200 }), null).duration_ms, 4200);
});
t("M5 시간은 러너 벽시계(exit) 가 먼저", () => {
  assert.equal(runMetricsOf(exitOf({ durationMs: 9000 }), sumOf({}, { durationMs: 7000 })).duration_ms, 9000);
  assert.equal(runMetricsOf({ code: 0 }, sumOf({}, { durationMs: 7000 })).duration_ms, 7000);
});
t("M6 비용이 숫자가 아니면 null", () => {
  assert.equal(runMetricsOf(exitOf(), sumOf({}, { costUsd: "0.5" })).cost_usd, null);
  assert.equal(runMetricsOf(exitOf(), sumOf({}, { costUsd: 0.0123 })).cost_usd, 0.0123);
});
t("M7 도구 호출 · 오류 수", () => {
  const m = runMetricsOf(exitOf(), sumOf({ calls: [{ error: true }, {}, { error: false }] }));
  assert.equal(m.tool_calls, 3); assert.equal(m.tool_errors, 1);
});
t("M8 원문 수 — 음수·실수는 null", () => {
  assert.equal(runMetricsOf(exitOf(), sumOf({ captures: 11 })).captures, 11);
  assert.equal(runMetricsOf(exitOf(), sumOf({ captures: -1 })).captures, null);
  assert.equal(runMetricsOf(exitOf(), sumOf({ captures: 1.5 })).captures, null);
  assert.equal(runMetricsOf(exitOf(), sumOf({}, { turns: 12 })).turns, 12);
});

// ── S4 묶음 통계 ──
const row = (o: Partial<RunStatRow> = {}): RunStatRow => ({
  started_at: "2026-10-16T03:00:00.000Z", outcome: "ok", cap_mb: 1024, mem_limit_mb: 1024, mem_peak_mb: 500,
  duration_ms: 10_000, cost_usd: 0.01, tool_calls: 2, tool_errors: 0, ...o,
});
t("A1 실행 0 — 실패율은 0% 가 아니라 모름(null)", () => {
  const s = summarizeRuns([]);
  assert.equal(s.runs, 0); assert.equal(s.failure_rate, null); assert.equal(s.memory.samples, 0);
  assert.equal(s.memory.max_mb, null); assert.equal(s.suggestion, null); assert.deepEqual(s.daily, []);
});
t("A2 실패율은 끝난 것만 센다 — 도는 중은 빼고", () => {
  const s = summarizeRuns([row(), row(), row(), row({ outcome: "oom", mem_peak_mb: null }), row({ outcome: null, mem_peak_mb: null })]);
  assert.equal(s.runs, 5); assert.equal(s.running, 1); assert.equal(s.finished, 4);
  assert.equal(s.ok, 3); assert.equal(s.failed, 1); assert.equal(s.failure_rate, 0.25);
});
t("A3 메모리 백분위(최근접 순위) · 최고값 없는 실행은 표본에서 뺀다", () => {
  const rows = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((p) => row({ mem_peak_mb: p, mem_limit_mb: 2048 }));
  rows.push(row({ mem_peak_mb: null }));
  const s = summarizeRuns(rows);
  assert.equal(s.memory.samples, 10);
  assert.equal(s.memory.p50_mb, 500); assert.equal(s.memory.p75_mb, 800); assert.equal(s.memory.p95_mb, 1000); assert.equal(s.memory.max_mb, 1000);
  assert.equal(percentile([], 50), null); assert.equal(percentile([7], 95), 7);
});
t("A4 상한 90% 이상 — 한도를 모르면 시작 때 상한으로", () => {
  const s = summarizeRuns([
    row({ mem_peak_mb: 921, mem_limit_mb: 1024 }),          // 0.899… → 아님
    row({ mem_peak_mb: 922, mem_limit_mb: 1024 }),          // 0.9004 → 맞음
    row({ mem_peak_mb: 900, mem_limit_mb: 1000 }),          // 정확히 0.9 → 맞음(경계 — 이상)
    row({ mem_peak_mb: 700, mem_limit_mb: null, cap_mb: 768 }),   // 0.911 → 맞음(상한으로)
    row({ mem_peak_mb: 700, mem_limit_mb: null, cap_mb: null }),  // 기준 없음 → 안 셈
  ]);
  assert.equal(s.memory.near_cap, 3);
  assert.ok(Math.abs((s.memory.max_ratio ?? 0) - 700 / 768) < 1e-9);
});
t("A5 사유별 — 많은 순 · 같으면 이름순 · 성공은 빼고 · 라벨", () => {
  const s = summarizeRuns([row({ outcome: "timeout" }), row({ outcome: "login" }), row({ outcome: "login" }), row({ outcome: "gone" }), row()]);
  assert.deepEqual(s.outcomes.map((o) => [o.outcome, o.count]), [["login", 2], ["gone", 1], ["timeout", 1]]);
  assert.equal(s.outcomes[0].label, RUN_OUTCOME_LABEL.login);
  assert.equal(s.outcomes.find((o) => o.outcome === "gone")!.memory_suspect, true);
});
t("A6 날짜는 보는 사람 시간대 — 서울 자정을 넘긴 두 실행은 다른 날", () => {
  const s = summarizeRuns([row({ started_at: "2026-10-15T14:59:00.000Z" }), row({ started_at: "2026-10-15T15:01:00.000Z", outcome: "oom" })], { tz: "Asia/Seoul" });
  assert.deepEqual(s.daily.map((d) => [d.day, d.runs, d.failed]), [["2026-10-15", 1, 0], ["2026-10-16", 1, 1]]);
  const u = summarizeRuns([row({ started_at: "2026-10-15T14:59:00.000Z" }), row({ started_at: "2026-10-15T15:01:00.000Z" })], { tz: "UTC" });
  assert.equal(u.daily.length, 1);
  assert.equal(dayKey("2026-10-15T15:01:00.000Z", "No/Such_Zone"), "2026-10-15");
});
t("A7 비용 — 합과 평균(비용 있는 실행만) · 도구 오류 합", () => {
  const s = summarizeRuns([row({ cost_usd: 0.01, tool_errors: 1 }), row({ cost_usd: 0.03, tool_calls: 3 }), row({ cost_usd: null })]);
  assert.ok(Math.abs(s.cost.total_usd - 0.04) < 1e-12);
  assert.ok(Math.abs((s.cost.avg_usd ?? 0) - 0.02) < 1e-12);
  assert.deepEqual(s.tools, { calls: 7, errors: 1 });
  assert.equal(summarizeRuns([row({ cost_usd: null })]).cost.avg_usd, null);
});
t("A8 추천 — 표본 10 미만 null · 상한 최고×1.25(128 올림) · 예약 p75(64 올림) · 예약 ≤ 상한 · 범위", () => {
  const peaks = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(suggestSize(peaks.slice(0, 9)), null);
  const g = suggestSize(peaks)!;
  assert.equal(g.max_mb, 1280); assert.equal(g.request_mb, 832); assert.equal(g.samples, 10);
  assert.match(g.rule, /1000MB × 1\.25/);
  //  배수가 1.25 인지 — 830 × 1.25 = 1037.5 → 1152 (× 1.2 = 996 → 1024 와 갈린다)
  assert.equal(suggestSize([500, 510, 520, 530, 540, 550, 560, 570, 580, 830])!.max_mb, 1152);
  //  작은 판만 있으면 하한으로
  const small = suggestSize(Array(10).fill(50))!;
  assert.equal(small.max_mb, 256); assert.equal(small.request_mb, 128);
  //  너무 크면 상한 8192 · 예약도 상한을 못 넘는다
  const big = suggestSize(Array(10).fill(9000))!;
  assert.equal(big.max_mb, 8192); assert.equal(big.request_mb, 8192);
  //  지금 매니지드 실측(530·657) 근처 — 상한 896(657×1.25=821.25 → 896), 통계에도 실린다
  const s = summarizeRuns([530, 657, 540, 560, 580, 600, 610, 620, 630, 640].map((p) => row({ mem_peak_mb: p })));
  assert.deepEqual([s.suggestion?.max_mb, s.suggestion?.request_mb], [896, 640]);
});
t("A9 메모리 의심 실패 = oom + gone", () => {
  const s = summarizeRuns([row({ outcome: "oom" }), row({ outcome: "gone" }), row({ outcome: "gone" }), row({ outcome: "timeout" })]);
  assert.equal(s.memory.suspect_failures, 3);
});

console.log(`run-outcome: ${pass} passed`);

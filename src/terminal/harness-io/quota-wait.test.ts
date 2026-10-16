// #4810 — 대화 기록에서 «한도 자동 이어감 대기» 를 읽는 계약(quotaScan · quotaBound · quotaWaitOf). 줄 모양은 Claude Code 2.1.301 실측
//  (2026-10-16 상민님 세션 5개 · 시험 세션 2개의 대화 기록)을 그대로 따른다 — 문구·칸 이름은 본체 문자열과 같다. 사양·엣지 표: 작업 스크래치 spec-4810.md.
//  틀리면 티가 크다:
//   🔴 걸린 대기를 못 읽으면 — 종료 규칙이 3분 뒤 하네스를 꺼 «4:10pm 에 이어감» 이 사라진다(이번 신고 그대로).
//   🔴 풀린 대기(이어 간 턴이 끝남·접힘·늦게 깸)를 대기로 읽으면 — 끝난 세션이 최대 하루 동안 예약 1GB 를 잡는다.
//   🔴 대기 중 백그라운드 작업 알림 한 턴을 «사람이 끼어듦» 으로 읽으면 — 실측 세션(작업 알림이 와서 한 턴 돈 뒤에도 대기 중)이 다시 꺼진다.
//   🔴 «이어 감» 직후를 대기 끝으로 읽으면 — 한도가 풀린 바로 그 순간 이어 가기 시작한 하네스를 끈다(격리 리뷰).
import { strict as assert } from "node:assert";
import test from "node:test";
import { quotaWaitOf, quotaScan, QUOTA_WAIT_MAX_MS, QUOTA_RESUME_GRACE_MS, QUOTA_CLOCK_SKEW_MS } from "./quota-wait.js";

const T0 = Date.parse("2026-10-16T06:59:09.533Z");   // 걸림 줄 시각(실측 d9e9c882)
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (o: Partial<{ launchedAtMs: number; nowMs: number }> = {}) => ({ launchedAtMs: T0 - 3_600_000, nowMs: T0 + 180_000, ...o });

/** 시스템 informational 줄 — Claude Code 가 대기를 걸고 풀 때 남기는 모양 그대로. */
const info = (content: string, ms: number, o: Record<string, unknown> = {}) =>
  ({ isSidechain: false, type: "system", subtype: "informational", content, isMeta: false, timestamp: iso(ms), level: "notice", ...o });
const ARMED = (ms = T0) => info("Usage limit reached · continuing automatically at 4:10pm · esc to cancel", ms);
const AGAIN = (ms: number) => info("Usage limit reached again · continuing automatically at 5:10pm · esc to cancel", ms);
const FIRED = (ms: number) => info("Usage limit reset · continuing automatically", ms);
/** 사람이 친 말 — origin.kind human · promptSource typed · turnOrigin human. */
const human = (ms: number, text = "한도 풀린 거 아냐?") =>
  ({ type: "user", message: { role: "user", content: text }, timestamp: iso(ms), origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human" });
/** 백그라운드 작업 알림 — 대기를 접지 않는다. */
const taskNote = (ms: number) => ({
  type: "user", message: { role: "user", content: "<task-notification>\n<task-id>a0fe51958cfe1b08c</task-id>\n</task-notification>" }, timestamp: iso(ms),
  origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification",
});
/** 자동 이어감 메시지 — 이어 감 줄 바로 뒤에 온다(isMeta · origin auto-continuation). */
const continuation = (ms: number) => ({ type: "user", isMeta: true, timestamp: iso(ms), origin: { kind: "auto-continuation" }, promptSource: "system", turnOrigin: "auto_continuation",
  message: { role: "user", content: "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete." } });
/** 한도에 막힌 요청의 오류 줄(실측 a7fd46ae · 5c30e17b). */
const limitError = (ms: number) => ({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", apiError: "usage_limit_reached", timestamp: iso(ms),
  message: { role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 4:10pm (Asia/Seoul)" }] } });
const assistant = (ms: number, text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: iso(ms) });
const turnEnd = (ms: number) => [
  { type: "system", subtype: "stop_hook_summary", hookCount: 3, timestamp: iso(ms), level: "suggestion" },
  { type: "system", subtype: "turn_duration", durationMs: 10770, timestamp: iso(ms + 7) },
  { type: "last-prompt", lastPrompt: "…" },
];

test("Q1 걸림 줄 하나 → 대기(종류·시각·문구 그대로)", () => {
  const w = quotaWaitOf([...turnEnd(T0 - 10), ARMED()], at());
  assert.deepEqual(w, { kind: "armed", atMs: T0, text: "Usage limit reached · continuing automatically at 4:10pm · esc to cancel" });
});
test("Q2r 걸린 뒤 «Usage limit reset · continuing automatically»(이어 감) → 5분 동안은 «막 이어 가는 중»", () => {
  const f = T0 + 600_000;
  assert.deepEqual(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200)], at({ nowMs: f + 3_000 })),
    { kind: "resuming", atMs: f, text: "Usage limit reset · continuing automatically", untilMs: f + QUOTA_RESUME_GRACE_MS });
});
test("Q2t 이어 간 턴이 끝났으면(turn_duration) → 대기 아님(이제 평범한 완료)", () => {
  const f = T0 + 600_000;
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), assistant(f + 9_000, "OK"), ...turnEnd(f + 10_000)], at({ nowMs: f + 60_000 })), null);
});
test("Q2g «막 이어 가는 중» 유예 — 이어 감에서 정확히 5분은 지킨다 · 1ms 넘으면 아님", () => {
  const f = T0 + 600_000;
  assert.equal(QUOTA_RESUME_GRACE_MS, 5 * 60_000);
  assert.equal(quotaWaitOf([ARMED(), FIRED(f)], at({ nowMs: f + QUOTA_RESUME_GRACE_MS }))?.kind, "resuming");
  assert.equal(quotaWaitOf([ARMED(), FIRED(f)], at({ nowMs: f + QUOTA_RESUME_GRACE_MS + 1 })), null);
});
test("Q3 «Usage limit available again · continuing now»(일찍 풀려 이어 감)도 이어 감이다", () => {
  assert.equal(quotaWaitOf([ARMED(), info("Usage limit available again · continuing now", T0 + 60_000)], at())?.kind, "resuming");
});
test("Q4 걸린 뒤 «Usage limit has reset · press enter to continue»(늦게 깸 — 사람이 Enter 를 쳐야 이어진다) → 대기 아님", () => {
  assert.equal(quotaWaitOf([ARMED(), info("Usage limit has reset · press enter to continue", T0 + 60_000)], at()), null);
});
test("Q5 걸린 뒤 «Automatic continue …»(접힘 · 꺼짐 · 포기 · 못 돎) → 대기 아님", () => {
  for (const c of [
    "Automatic continue cancelled · /rate-limit-options to re-arm",
    "Automatic continue was turned off · this task will not resume on its own",
    "Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own (/rate-limit-options to wait anyway)",
    "Automatic continue did not run · the continuation was blocked before it reached the model, so this task did not resume on its own · send a prompt to continue",
  ]) assert.equal(quotaWaitOf([ARMED(), info(c, T0 + 60_000, { level: "warning" })], at()), null, c);
});
test("Q6 걸린 뒤 사람이 말을 보냄(Claude Code 가 대기를 조용히 접는다) → 대기 아님", () => {
  assert.equal(quotaWaitOf([ARMED(), human(T0 + 60_000)], at()), null);
});
test("Q6b 사람의 말 표식이 turnOrigin 에만 있어도 사람의 말이다", () => {
  const h = human(T0 + 60_000) as Record<string, unknown>;
  delete h.origin;
  assert.equal(quotaWaitOf([ARMED(), h], at()), null);
});
test("Q7 걸린 뒤 백그라운드 작업 알림이 와서 한 턴 돌고 끝나도 대기는 그대로(실측 ca4a92f9)", () => {
  const w = quotaWaitOf([ARMED(), taskNote(T0 + 29_000), assistant(T0 + 35_000, "기록 작업은 문제없이 끝났습니다."), ...turnEnd(T0 + 37_000)], at());
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, T0);
});
test("Q7b 한도 정리 안내(wrap_up)는 사람의 말이 아니다 — 대기를 접지 않는다", () => {
  const wrapUp = { type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "wrap_up", timestamp: iso(T0 + 1_000),
    message: { role: "user", content: "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. …]" } };
  assert.equal(quotaWaitOf([ARMED(), wrapUp], at())?.atMs, T0);
});
test("Q8 사람이 끼어든 말이 다시 막혀 «again» 줄이 붙으면 → 대기(새 줄 시각)", () => {
  const w = quotaWaitOf([ARMED(), human(T0 + 60_000), AGAIN(T0 + 65_000)], at());
  assert.equal(w?.atMs, T0 + 65_000);
  assert.match(w?.text ?? "", /again/);
});
test("Q9 한도 안내 무효 쪽지(usageLimitNote release) → 대기 아님", () => {
  const release = { type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "release", timestamp: iso(T0 + 900_000),
    message: { role: "user", content: "[Earlier usage-limit notes no longer apply. Continue working normally. Don't mention this to the user.]" } };
  assert.equal(quotaWaitOf([ARMED(), release], at({ nowMs: T0 + 950_000 })), null);
});
test("Q10 하네스를 띄운 시각보다 앞선 사건은 그 전 프로세스의 것 — 1ms 앞이면 아님 · 같은 시각이면 대기", () => {
  assert.equal(quotaWaitOf([ARMED()], at({ launchedAtMs: T0 + 1 })), null);
  assert.equal(quotaWaitOf([ARMED()], at({ launchedAtMs: T0 }))?.atMs, T0);
  const f = T0 + 60_000;
  assert.equal(quotaWaitOf([ARMED(), FIRED(f)], at({ launchedAtMs: f + 1, nowMs: f + 2_000 })), null, "이어 감 줄도 같다");
});
test("Q11 띄운 시각을 모르면(0) 그 조건은 안 본다 — 상한 안의 옛 걸림 줄도 대기", () => {
  assert.equal(quotaWaitOf([ARMED()], { launchedAtMs: 0, nowMs: T0 + 20 * 3_600_000 })?.atMs, T0);
});
test("Q12 상한 — 걸림에서 정확히 24시간 30분은 대기 · 1ms 넘으면 아님", () => {
  assert.equal(QUOTA_WAIT_MAX_MS, (24 * 60 + 30) * 60_000);
  assert.equal(quotaWaitOf([ARMED()], at({ nowMs: T0 + QUOTA_WAIT_MAX_MS }))?.atMs, T0);
  assert.equal(quotaWaitOf([ARMED()], at({ nowMs: T0 + QUOTA_WAIT_MAX_MS + 1 })), null);
});
test("Q13 사건 줄에 시각이 없거나 깨졌으면 대기로 보지 않는다(상한을 잴 수 없다)", () => {
  const noTs = ARMED() as Record<string, unknown>;
  delete noTs.timestamp;
  assert.equal(quotaWaitOf([noTs], at()), null);
  assert.equal(quotaWaitOf([{ ...ARMED(), timestamp: "어제쯤" }], at()), null);
  assert.equal(quotaWaitOf([ARMED(), { ...FIRED(T0 + 60_000), timestamp: "" }], at()), null, "이어 감 줄도 같다");
});
test("Q14 사건 줄이 없는 평범한 대화 · 빈 입력 · 섞인 잡값 → 대기 아님", () => {
  assert.equal(quotaWaitOf([human(T0 - 9_000), assistant(T0 - 5_000, "OK"), ...turnEnd(T0)], at()), null);
  assert.equal(quotaWaitOf([], at()), null);
  assert.equal(quotaWaitOf([null, "문자열", 3, undefined, { type: "system" }], at()), null);
});
test("Q15 접힌 뒤 다시 걸리면 → 대기(나중 줄이 이긴다)", () => {
  const w = quotaWaitOf([info("Automatic continue cancelled · /rate-limit-options to re-arm", T0 - 600_000), ARMED()], at());
  assert.equal(w?.atMs, T0);
});
test("Q17 «continuing automatically» 만 있고 «esc to cancel» 이 없는 줄은 걸림이 아니다", () => {
  assert.equal(quotaWaitOf([info("Usage limit reached · continuing automatically at 4:10pm", T0)], at()), null);
});
test("Q18 같은 문구가 모델 답·사람 말 본문에 있으면 걸림이 아니다(시스템 informational 줄만 본다)", () => {
  const quoted = "Usage limit reached · continuing automatically at 4:10pm · esc to cancel";
  assert.equal(quotaWaitOf([assistant(T0, `화면에 «${quoted}» 가 떴습니다.`)], at()), null);
  assert.equal(quotaWaitOf([ARMED(T0 - 60_000), human(T0, quoted)], at()), null, "사람의 말은 내용과 무관하게 앞선 대기를 접는다");
});
test("Q20 이어 간 턴이 또 한도에 막히면(오류 줄) — 줄 없이 다시 걸린 것으로 본다(오류 줄 시각)", () => {
  const f = T0 + 600_000;
  const w = quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), limitError(f + 4_000), ...turnEnd(f + 4_100)], at({ nowMs: f + 600_000 }));
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, f + 4_000);
});
test("Q21 다시 막힌 것이 연달아 넘쳐 Claude Code 가 «Automatic continue stopped …» 를 남기면 → 대기 아님", () => {
  const f = T0 + 600_000;
  const stopped = info("Automatic continue stopped after repeated usage-limit hits · this task will not resume on its own (/rate-limit-options to try again)", f + 4_050, { level: "warning" });
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), limitError(f + 4_000), stopped], at({ nowMs: f + 600_000 })), null);
});
test("Q22 이어 감 없이 한도 오류 줄만 있으면 걸림이 아니다(자동 걸림이 안 된 경우 — 걸리면 Claude Code 가 걸림 줄을 따로 남긴다)", () => {
  assert.equal(quotaWaitOf([human(T0 - 2_000), limitError(T0)], at()), null);
  assert.equal(quotaWaitOf([ARMED(T0 - 60_000), limitError(T0)], at())?.atMs, T0 - 60_000, "이미 걸린 대기는 오류 줄로 바뀌지 않는다");
});
test("Q23 사이드체인(서브에이전트) 줄의 사람 말은 본 대화의 대기를 접지 않는다", () => {
  assert.equal(quotaWaitOf([ARMED(), { ...human(T0 + 60_000), isSidechain: true }], at())?.atMs, T0);
});
test("Q24 메타 줄은 사람의 말 표식이 있어도 사람의 말이 아니다", () => {
  assert.equal(quotaWaitOf([ARMED(), { ...human(T0 + 60_000), isMeta: true }], at())?.atMs, T0);
});
test("Q25 사건 줄 시각이 지금보다 5분 넘게 앞서면(깨진 시계) 대기가 아니다 — 정확히 5분은 대기", () => {
  assert.equal(QUOTA_CLOCK_SKEW_MS, 5 * 60_000);
  assert.equal(quotaWaitOf([ARMED(T0 + QUOTA_CLOCK_SKEW_MS)], at({ nowMs: T0 }))?.kind, "armed");
  assert.equal(quotaWaitOf([ARMED(T0 + QUOTA_CLOCK_SKEW_MS + 1)], at({ nowMs: T0 })), null);
});
test("Q26 시각과 무관한 판독(quotaScan)은 시각 조건 없이 마지막 사건을 그대로 준다 — 같은 파일을 다시 안 읽고 다시 잴 수 있게", () => {
  assert.deepEqual(quotaScan([ARMED()]), { kind: "armed", atMs: T0, text: "Usage limit reached · continuing automatically at 4:10pm · esc to cancel" });
  assert.deepEqual(quotaScan([ARMED(), FIRED(T0 + 1)]), { kind: "fired", atMs: T0 + 1, text: "Usage limit reset · continuing automatically" });
});

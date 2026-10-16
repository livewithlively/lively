// #4810 — 대화 기록에서 «한도 자동 이어감 대기» 를 읽는 계약(quotaWaitOf). 줄 모양은 Claude Code 2.1.301 실측(2026-10-16 상민님 세션 5개 ·
//  시험 세션 2개의 대화 기록)을 그대로 따른다 — 문구·칸 이름은 본체 문자열과 같다. 사양·엣지 표 Q1~Q18: 작업 스크래치 spec-4810.md.
//  틀리면 티가 크다:
//   🔴 걸린 대기를 못 읽으면 — 종료 규칙이 3분 뒤 하네스를 꺼 «4:10pm 에 이어감» 이 사라진다(이번 신고 그대로).
//   🔴 풀린 대기(이어 감·접힘·늦게 깸)를 대기로 읽으면 — 끝난 세션이 최대 하루 동안 예약 1GB 를 잡는다.
//   🔴 대기 중 백그라운드 작업 알림 한 턴을 «사람이 끼어듦» 으로 읽으면 — 실측 세션(작업 알림이 와서 한 턴 돈 뒤에도 대기 중)이 다시 꺼진다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { quotaWaitOf, QUOTA_WAIT_MAX_MS } from "./quota-wait.js";

const T0 = Date.parse("2026-10-16T06:59:09.533Z");   // 걸림 줄 시각(실측 d9e9c882)
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (o: Partial<{ sinceMs: number; nowMs: number }> = {}) => ({ sinceMs: T0 - 3_600_000, nowMs: T0 + 180_000, ...o });

/** 시스템 informational 줄 — Claude Code 가 대기를 걸고 풀 때 남기는 모양 그대로. */
const info = (content: string, ms: number, o: Record<string, unknown> = {}) =>
  ({ isSidechain: false, type: "system", subtype: "informational", content, isMeta: false, timestamp: iso(ms), level: "notice", ...o });
const ARMED = (ms = T0) => info("Usage limit reached · continuing automatically at 4:10pm · esc to cancel", ms);
const AGAIN = (ms: number) => info("Usage limit reached again · continuing automatically at 5:10pm · esc to cancel", ms);
/** 사람이 친 말 — origin.kind human · promptSource typed · turnOrigin human. */
const human = (ms: number, text = "한도 풀린 거 아냐?") =>
  ({ type: "user", message: { role: "user", content: text }, timestamp: iso(ms), origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human" });
/** 백그라운드 작업 알림 — 대기를 접지 않는다. */
const taskNote = (ms: number) => ({
  type: "user", message: { role: "user", content: "<task-notification>\n<task-id>a0fe51958cfe1b08c</task-id>\n</task-notification>" }, timestamp: iso(ms),
  origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification",
});
const assistant = (ms: number, text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: iso(ms) });
const turnEnd = (ms: number) => [
  { type: "system", subtype: "stop_hook_summary", hookCount: 3, timestamp: iso(ms), level: "suggestion" },
  { type: "system", subtype: "turn_duration", durationMs: 10770, timestamp: iso(ms + 7) },
  { type: "last-prompt", lastPrompt: "…" },
];

test("Q1 걸림 줄 하나 → 대기(시각·문구 그대로)", () => {
  const w = quotaWaitOf([...turnEnd(T0 - 10), ARMED()], at());
  assert.deepEqual(w, { armedAtMs: T0, text: "Usage limit reached · continuing automatically at 4:10pm · esc to cancel" });
});
test("Q2 걸린 뒤 «Usage limit reset · continuing automatically»(이어 감) → 대기 아님", () => {
  assert.equal(quotaWaitOf([ARMED(), info("Usage limit reset · continuing automatically", T0 + 600_000)], at({ nowMs: T0 + 700_000 })), null);
});
test("Q3 걸린 뒤 «Usage limit available again · continuing now»(일찍 풀려 이어 감) → 대기 아님", () => {
  assert.equal(quotaWaitOf([ARMED(), info("Usage limit available again · continuing now", T0 + 60_000)], at()), null);
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
  assert.equal(w?.armedAtMs, T0);
});
test("Q7b 한도 정리 안내(wrap_up)·자동 이어감 메시지는 사람의 말이 아니다 — 대기를 접지 않는다", () => {
  const wrapUp = { type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "wrap_up", timestamp: iso(T0 + 1_000),
    message: { role: "user", content: "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. …]" } };
  const cont = { type: "user", isMeta: true, timestamp: iso(T0 + 2_000), origin: { kind: "auto-continuation" }, promptSource: "system", turnOrigin: "auto_continuation",
    message: { role: "user", content: "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete." } };
  assert.equal(quotaWaitOf([ARMED(), wrapUp, cont], at())?.armedAtMs, T0);
});
test("Q8 사람이 끼어든 말이 다시 막혀 «again» 줄이 붙으면 → 대기(새 줄 시각)", () => {
  const w = quotaWaitOf([ARMED(), human(T0 + 60_000), AGAIN(T0 + 65_000)], at());
  assert.equal(w?.armedAtMs, T0 + 65_000);
  assert.match(w?.text ?? "", /again/);
});
test("Q9 한도 안내 무효 쪽지(usageLimitNote release) → 대기 아님", () => {
  const release = { type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "release", timestamp: iso(T0 + 900_000),
    message: { role: "user", content: "[Earlier usage-limit notes no longer apply. Continue working normally. Don't mention this to the user.]" } };
  assert.equal(quotaWaitOf([ARMED(), release], at({ nowMs: T0 + 950_000 })), null);
});
test("Q10 하네스를 띄운 시각보다 앞선 걸림 줄은 그 전 프로세스의 것 — 1ms 앞이면 아님 · 같은 시각이면 대기", () => {
  assert.equal(quotaWaitOf([ARMED()], at({ sinceMs: T0 + 1 })), null);
  assert.equal(quotaWaitOf([ARMED()], at({ sinceMs: T0 }))?.armedAtMs, T0);
});
test("Q11 띄운 시각을 모르면(0) 그 조건은 안 본다 — 상한 안의 옛 걸림 줄도 대기", () => {
  assert.equal(quotaWaitOf([ARMED()], { sinceMs: 0, nowMs: T0 + 20 * 3_600_000 })?.armedAtMs, T0);
});
test("Q12 상한 — 걸림에서 정확히 24시간 30분은 대기 · 1ms 넘으면 아님", () => {
  assert.equal(QUOTA_WAIT_MAX_MS, (24 * 60 + 30) * 60_000);
  assert.equal(quotaWaitOf([ARMED()], at({ nowMs: T0 + QUOTA_WAIT_MAX_MS }))?.armedAtMs, T0);
  assert.equal(quotaWaitOf([ARMED()], at({ nowMs: T0 + QUOTA_WAIT_MAX_MS + 1 })), null);
});
test("Q13 걸림 줄에 시각이 없거나 깨졌으면 대기로 보지 않는다(상한을 잴 수 없다)", () => {
  const noTs = ARMED() as Record<string, unknown>;
  delete noTs.timestamp;
  assert.equal(quotaWaitOf([noTs], at()), null);
  assert.equal(quotaWaitOf([{ ...ARMED(), timestamp: "어제쯤" }], at()), null);
});
test("Q14 걸림 줄이 없는 평범한 대화 · 빈 입력 · 섞인 잡값 → 대기 아님", () => {
  assert.equal(quotaWaitOf([human(T0 - 9_000), assistant(T0 - 5_000, "OK"), ...turnEnd(T0)], at()), null);
  assert.equal(quotaWaitOf([], at()), null);
  assert.equal(quotaWaitOf([null, "문자열", 3, undefined, { type: "system" }], at()), null);
});
test("Q15 풀린 뒤 다시 걸리면 → 대기(나중 줄이 이긴다)", () => {
  const w = quotaWaitOf([info("Usage limit reset · continuing automatically", T0 - 600_000), ARMED()], at());
  assert.equal(w?.armedAtMs, T0);
});
test("Q17 «continuing automatically» 만 있고 «esc to cancel» 이 없는 줄은 걸림이 아니다", () => {
  assert.equal(quotaWaitOf([info("Usage limit reached · continuing automatically at 4:10pm", T0)], at()), null);
});
test("Q18 같은 문구가 모델 답·사람 말 본문에 있으면 걸림이 아니다(시스템 informational 줄만 본다)", () => {
  const quoted = "Usage limit reached · continuing automatically at 4:10pm · esc to cancel";
  assert.equal(quotaWaitOf([assistant(T0, `화면에 «${quoted}» 가 떴습니다.`)], at()), null);
  assert.equal(quotaWaitOf([ARMED(T0 - 60_000), human(T0, quoted)], at()), null, "사람의 말은 내용과 무관하게 앞선 대기를 접는다");
});

// #4810 — 대화 기록에서 «한도 자동 이어감 대기» 를 읽는 계약(quotaScan · quotaBound · quotaWaitOf). 줄 모양은 Claude Code 2.1.301 실측
//  (2026-10-16 상민님 세션 5개 · 시험 세션 2개의 대화 기록)을 그대로 따른다 — 문구·칸 이름은 본체 문자열과 같다. 사양·엣지 표: 작업 스크래치 spec-4810.md.
//  틀리면 티가 크다:
//   🔴 걸린 대기를 못 읽으면 — 종료 규칙이 3분 뒤 하네스를 꺼 «4:10pm 에 이어감» 이 사라진다(이번 신고 그대로).
//   🔴 풀린 대기(이어 간 턴이 끝남·접힘·늦게 깸)를 대기로 읽으면 — 끝난 세션이 최대 하루 동안 예약 1GB 를 잡는다.
//   🔴 대기 중 백그라운드 작업 알림 한 턴을 «사람이 끼어듦» 으로 읽으면 — 실측 세션(작업 알림이 와서 한 턴 돈 뒤에도 대기 중)이 다시 꺼진다.
//   🔴 «이어 감» 직후를 대기 끝으로 읽으면 — 한도가 풀린 바로 그 순간 이어 가기 시작한 하네스를 끈다(격리 리뷰).
import { strict as assert } from "node:assert";
import test from "node:test";
import { quotaWaitOf, quotaScan, quotaBound, quotaScanWithOpenTurn, openTurnOf, QUOTA_WAIT_MAX_MS, QUOTA_RESUME_GRACE_MS, QUOTA_CLOCK_SKEW_MS } from "./quota-wait.js";

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
/** 한도 안내 무효 쪽지 — 정리 안내 뒤 한도가 풀린 다음 턴의 첫 요청에 붙는다(자동 이어 간 턴 포함 · 실측 395485ac). */
const release = (ms: number) => ({ type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "release", timestamp: iso(ms),
  message: { role: "user", content: "[Earlier usage-limit notes no longer apply. Continue working normally. Don't mention this to the user.]" } });
/** 한도 정리 안내 — 턴 도중 한도에 닿으면 모델에게 넣는다(실측 ca4a92f9 · d9e9c882). */
const wrapUp = (ms: number) => ({ type: "user", isMeta: true, turnCompanion: true, usageLimitNote: "wrap_up", timestamp: iso(ms),
  message: { role: "user", content: "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. …]" } });
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
test("Q2r 걸린 뒤 «Usage limit reset · continuing automatically»(이어 감) → 5분 동안은 «막 이어 가는 중» — 이어 간 턴 첫 요청의 무효 쪽지로 풀리지 않는다", () => {
  const f = T0 + 600_000;
  assert.deepEqual(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), release(f + 3_000)], at({ nowMs: f + 3_100 })),
    { kind: "resuming", atMs: f, text: "Usage limit reset · continuing automatically", untilMs: f + QUOTA_RESUME_GRACE_MS });
});
test("Q2t 이어 간 턴이 끝났으면(turn_duration) → 대기 아님(이제 평범한 완료)", () => {
  const f = T0 + 600_000;
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), release(f + 3_000), assistant(f + 9_000, "OK"), ...turnEnd(f + 10_000)], at({ nowMs: f + 60_000 })), null);
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
test("Q7b 한도 정리 안내(wrap_up)는 사람의 말이 아니다 — 걸린 대기를 접지 않는다", () => {
  assert.equal(quotaWaitOf([ARMED(), wrapUp(T0 + 1_000)], at())?.atMs, T0);
});
test("Q8 사람이 끼어든 말이 다시 막혀 «again» 줄이 붙으면 → 대기(새 줄 시각)", () => {
  const w = quotaWaitOf([ARMED(), human(T0 + 60_000), AGAIN(T0 + 65_000)], at());
  assert.equal(w?.atMs, T0 + 65_000);
  assert.match(w?.text ?? "", /again/);
});
test("Q9 한도 안내 무효 쪽지(release)는 대기를 바꾸지 않는다 — 걸림·이어 감 어느 쪽이든(다시 띄운 하네스는 띄운 시각 조건이 맡는다)", () => {
  assert.equal(quotaWaitOf([ARMED(), release(T0 + 900_000)], at({ nowMs: T0 + 950_000 }))?.kind, "armed");
  const f = T0 + 600_000;
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 100), release(f + 3_000)], at({ nowMs: f + 4_000 }))?.kind, "resuming");
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
  assert.match(w?.text ?? "", /한도 오류/, "어느 길로 다시 걸렸는지 로그로 가른다");
});
test("Q21 다시 막힌 것이 연달아 넘쳐 Claude Code 가 «Automatic continue stopped …» 를 남기면 → 대기 아님", () => {
  const f = T0 + 600_000;
  const stopped = info("Automatic continue stopped after repeated usage-limit hits · this task will not resume on its own (/rate-limit-options to try again)", f + 4_050, { level: "warning" });
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), limitError(f + 4_000), stopped], at({ nowMs: f + 600_000 })), null);
});
test("Q22 이어 감 없이 한도 오류 줄만 있으면 걸림이 아니다(자동으로 걸리면 Claude Code 가 걸림 줄을 따로 남긴다 · 대화상자로 건 대기는 명령 결과 줄로 읽는다 — D 행)", () => {
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
  assert.deepEqual(quotaScan([ARMED(), FIRED(T0 + 1)]), { kind: "fired", atMs: T0 + 1, text: "Usage limit reset · continuing automatically", continued: false });
  assert.equal(quotaScan([ARMED(), FIRED(T0 + 1), continuation(T0 + 2)])?.continued, true, "자동 이어감 메시지가 오면 그 뒤의 턴 끝을 센다");
});
test("Q20b 이어 간 턴이 정리 안내(wrap_up)로 끝나면 — 줄 없이 다시 걸린 것으로 본다(안내 줄 시각 · 본체 턴 끝 처리)", () => {
  const f = T0 + 600_000;
  const lines = [ARMED(), FIRED(f), continuation(f + 200), release(f + 3_000), assistant(f + 60_000, "작업 계속"),
    wrapUp(f + 3_600_000), assistant(f + 3_610_000, "사용 한도에 닿아 여기서 멈춥니다."), ...turnEnd(f + 3_612_000)];
  const w = quotaWaitOf(lines, at({ nowMs: f + 3_800_000 }));
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, f + 3_600_000);
  assert.match(w?.text ?? "", /정리 안내/, "어느 길로 다시 걸렸는지 로그로 가른다");
});
test("Q20c 이어 간 턴의 첫 요청에 무효 쪽지가 붙은 직후(3초)는 «막 이어 가는 중» 이다", () => {
  const f = T0 + 600_000;
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), release(f + 3_000)], at({ nowMs: f + 3_000 }))?.kind, "resuming");
});
test("Q21b 정리 안내로 다시 걸린 뒤 «Automatic continue stopped after repeated usage-limit hits» 가 오면 → 대기 아님", () => {
  const f = T0 + 600_000;
  const stopped = info("Automatic continue stopped after repeated usage-limit hits · this task will not resume on its own (/rate-limit-options to try again)", f + 3_612_100, { level: "warning" });
  assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), wrapUp(f + 3_600_000), ...turnEnd(f + 3_612_000), stopped], at({ nowMs: f + 3_700_000 })), null);
});
test("Q22b 이어 간 턴의 오류 줄이라도 계정 한도(apiError usage_limit_reached)가 아니면 다시 걸림이 아니다(서버 스로틀 등)", () => {
  const f = T0 + 600_000;
  const throttle = { ...limitError(f + 4_000), apiError: undefined };
  const overloaded = { ...limitError(f + 4_000), error: "overloaded_error", apiError: "server_overloaded" };
  for (const e of [throttle, overloaded]) {
    assert.equal(quotaWaitOf([ARMED(), FIRED(f), continuation(f + 200), e, ...turnEnd(f + 4_100)], at({ nowMs: f + 60_000 })), null, JSON.stringify(e.apiError));
  }
});
test("Q27 이어 감 메시지가 오기 전에 끝난 다른 턴(작업 알림)의 끝은 이어 간 턴의 끝이 아니다 — 계속 «막 이어 가는 중»", () => {
  const f = T0 + 600_000;
  const w = quotaWaitOf([ARMED(), taskNote(f - 2_000), FIRED(f), assistant(f + 1_000, "알림 처리"), ...turnEnd(f + 1_500)], at({ nowMs: f + 2_000 }));
  assert.equal(w?.kind, "resuming");
});
test("Q28 이어 감 없이 온 정리 안내는 걸림이 아니다 — 첫 걸림은 턴이 끝난 뒤 남는 걸림 줄로 읽는다", () => {
  assert.equal(quotaWaitOf([human(T0 - 9_000), wrapUp(T0 - 5_000), assistant(T0 - 1_000, "멈춥니다"), ...turnEnd(T0 - 500)], at()), null);
  assert.equal(quotaWaitOf([human(T0 - 9_000), wrapUp(T0 - 5_000), ...turnEnd(T0 - 500), ARMED()], at())?.atMs, T0, "그 뒤 걸림 줄이 오면 그때 걸림");
});
test("Q27b 이어 감 뒤 · 이어감 메시지 전에 작업 알림 턴이 돌고 끝나도 그 턴의 끝은 이어 간 턴의 끝이 아니다 — 계속 «막 이어 가는 중»", () => {
  const f = T0 + 600_000;
  const w = quotaWaitOf([ARMED(), FIRED(f), taskNote(f + 500), assistant(f + 1_000, "알림 처리"), ...turnEnd(f + 1_500)], at({ nowMs: f + 2_000 }));
  assert.equal(w?.kind, "resuming");
});
test("Q29 이어감 메시지 전에 끼어든 작업 알림 턴의 정리 안내는 다시 걸림이 아니다(그 턴은 이어 간 턴이 아니다)", () => {
  const f = T0 + 600_000;
  const w = quotaWaitOf([ARMED(), FIRED(f), taskNote(f + 500), wrapUp(f + 1_000), ...turnEnd(f + 1_500)], at({ nowMs: f + 2_000 }));
  assert.notEqual(w?.kind, "armed");
});
test("Q30 이어 간 턴이 끊겨(Esc — 턴 끝 줄 없음) 다른 턴이 시작되면 이어 간 턴은 끝난 것이다 — 그 뒤 정리 안내는 다시 걸림이 아니다", () => {
  const f = T0 + 600_000;
  const interrupted = [ARMED(), FIRED(f), continuation(f + 200), assistant(f + 5_000, "작업 중…")];
  assert.equal(quotaWaitOf([...interrupted, taskNote(f + 20_000), wrapUp(f + 25_000), ...turnEnd(f + 26_000)], at({ nowMs: f + 30_000 })), null);
});
test("Q31 이어감 메시지 전에 끼어든 작업 알림 턴이 한도 오류로 막혀도 다시 걸림이 아니다(그 턴은 이어 간 턴이 아니다)", () => {
  const f = T0 + 600_000;
  const w = quotaWaitOf([ARMED(), FIRED(f), taskNote(f + 500), limitError(f + 1_000), ...turnEnd(f + 1_100)], at({ nowMs: f + 2_000 }));
  assert.notEqual(w?.kind, "armed");
});

// ── #4821 ③ — 사람이 한도 대화상자(/rate-limit-options)에서 «기다리기» 를 고른 대기. 본체는 걸림 줄을 안 쓰고 명령 결과만 남긴다
//  (2.1.301 local-jsx onDone 기본 표시 = 사용자 줄 `<local-command-stdout>…</local-command-stdout>` · origin 없음 — /model 실측과 같은 모양).
//  사양·엣지 표 D1~D10 · O1~O8 · T1~T4: 작업 스크래치 spec-4821.md.
//   🔴 이 줄을 못 읽으면 — 사람이 «기다리기» 를 고르고 떠난 세션을 3분 뒤 꺼 그 대기를 없앤다.
//   🔴 다른 명령 결과·사람 말 본문의 같은 문구를 걸림으로 읽으면 — 끝난 세션을 하루 동안 붙잡는다.
const DIALOG_TEXT = "Claude Code will continue automatically at 4:10pm. Keep this session open; it may still pause for permission prompts. Press esc to cancel the wait.";
const dialogOut = (ms: number, o: Record<string, unknown> = {}) => ({ type: "user", isSidechain: false, promptId: "6b0e1c2a-0d4e-4f55-9a1b-2c3d4e5f6a7b", timestamp: iso(ms),
  message: { role: "user", content: `<local-command-stdout>${DIALOG_TEXT}</local-command-stdout>` }, ...o });
const stdout = (ms: number, text: string) => ({ ...dialogOut(ms), message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } });

test("D1 대화상자 «기다리기» 의 명령 결과 줄 → 대기(시각 = 그 줄 · 문구는 태그를 뗀 결과)", () => {
  const w = quotaWaitOf([...turnEnd(T0 - 10), dialogOut(T0)], at());
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, T0);
  assert.equal(w?.text, DIALOG_TEXT);
});
test("D2 본문이 text 블록 배열이어도 같다", () => {
  const arr = { ...dialogOut(T0), message: { role: "user", content: [{ type: "text", text: `<local-command-stdout>${DIALOG_TEXT}</local-command-stdout>` }] } };
  assert.equal(quotaWaitOf([arr], at())?.atMs, T0);
});
test("D3 대화상자 대기도 이어 감 → 이어감 메시지 → 그 턴이 끝나면 대기 아님", () => {
  const f = T0 + 600_000;
  assert.equal(quotaWaitOf([dialogOut(T0), FIRED(f), continuation(f + 200), assistant(f + 5_000, "계속합니다"), ...turnEnd(f + 6_000)], at({ nowMs: f + 60_000 })), null);
});
test("D4 대화상자 대기 뒤 사람이 말을 보내면 대기 아님", () => {
  assert.equal(quotaWaitOf([dialogOut(T0), human(T0 + 60_000)], at()), null);
});
test("D5 대화상자 대기를 Esc 로 거두면(«Automatic continue cancelled …») 대기 아님", () => {
  assert.equal(quotaWaitOf([dialogOut(T0), info("Automatic continue cancelled · /rate-limit-options to re-arm", T0 + 60_000)], at()), null);
});
test("D6 다른 명령 결과는 걸림이 아니다 — «esc to cancel» 이 없으면 «continue automatically» 가 있어도", () => {
  assert.equal(quotaWaitOf([stdout(T0, "Set model to `Sonnet 5.5` and saved as your default for new sessions")], at()), null);
  assert.equal(quotaWaitOf([stdout(T0, "Claude Code will continue automatically at 4:10pm.")], at()), null);
  assert.equal(quotaWaitOf([stdout(T0, "Press esc to cancel the wait.")], at()), null, "«esc to cancel» 만 있어도 걸림이 아니다(격리 리뷰)");
});
test("D7 같은 문구라도 명령 결과 줄이 아니면 걸림이 아니다 — 사람 말 본문(그건 앞선 대기를 접는다) · 모델 답 · 다른 사용자 줄", () => {
  assert.equal(quotaWaitOf([human(T0, DIALOG_TEXT)], at()), null);
  assert.equal(quotaWaitOf([assistant(T0, `<local-command-stdout>${DIALOG_TEXT}</local-command-stdout>`)], at()), null);
  assert.equal(quotaWaitOf([{ ...dialogOut(T0), message: { role: "user", content: `안내: ${DIALOG_TEXT}` } }], at()), null);
});
test("D8 사이드체인 줄의 명령 결과는 본 대화의 대기가 아니다", () => {
  assert.equal(quotaWaitOf([dialogOut(T0, { isSidechain: true })], at()), null);
});
test("D9 시각이 없는 명령 결과 줄은 대기가 아니다(상한을 잴 수 없다)", () => {
  assert.equal(quotaWaitOf([dialogOut(T0, { timestamp: undefined })], at()), null);
});
test("D10 자동 걸림 → 사람이 접음 → 대화상자로 다시 걸면 대기(새 줄 시각)", () => {
  assert.equal(quotaWaitOf([ARMED(T0 - 120_000), human(T0 - 60_000), dialogOut(T0)], at())?.atMs, T0);
});

// ── #4821 ① — 끝 창보다 긴 «이어 간 턴». 창이 그 턴 중간에서 열리면 이어 감 줄·이어감 메시지가 창 앞이라 정리 안내만 보인다.
//  정리 안내 줄엔 promptId 만 있다(실측 4건: isMeta · usageLimitNote · promptId · isSidechain — origin·turnOrigin 없음). 읽는 쪽이 그 턴의 첫 줄을
//  거슬러 찾아 «이어 간 턴» 인지 확인한다(quotaScanWithOpenTurn — Z 행). O 행은 «이어 간 턴이다» 를 받았을 때의 판정(quotaScan 의 둘째 인자).
//   🔴 출처를 받고도 못 읽으면 — 긴 이어 간 턴이 다시 걸린 대기(연달아 두 번까지)를 끈다.
//   🔴 출처 없이 정리 안내만으로 읽으면 — 사람 턴의 첫 걸림(걸림 줄이 따로 온다)·자동 이어감이 꺼진 세션까지 대기로 붙잡는다.
const P = "f7c15b7e-9fd9-41a7-9e0b-c85f433e9ca9";   // 실측 5c30e17b 의 이어 간 턴 promptId
const toolResult = (ms: number, pid = P) => ({ type: "user", promptId: pid, timestamp: iso(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }] } });
const wrapUpP = (ms: number, pid = P) => ({ ...wrapUp(ms), promptId: pid, isSidechain: false });
const openTail = (f: number) => [toolResult(f), assistant(f + 1_000, "작업 계속"), toolResult(f + 2_000)];
/** 창 앞에서 시작한 턴을 «이어 간 턴» 으로 받았을 때의 지금 대기(시각 조건까지). */
const continuedWait = (lines: unknown[], a = at()) => quotaBound(quotaScan(lines, true), a);

test("O1 창 앞에서 시작한 이어 간 턴이 정리 안내로 끝나면 → 다시 걸림(정리 안내 시각)", () => {
  const f = T0 - 60_000;
  const w = continuedWait([...openTail(f), wrapUpP(f + 50_000), assistant(f + 55_000, "여기서 멈춥니다"), ...turnEnd(f + 56_000)]);
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, f + 50_000);
  assert.match(w?.text ?? "", /정리 안내/);
});
test("O2 «이어 간 턴» 을 모르면(안 넘김) 종전처럼 대기 아님", () => {
  const f = T0 - 60_000;
  assert.equal(quotaWaitOf([...openTail(f), wrapUpP(f + 50_000), ...turnEnd(f + 56_000)], at()), null);
});
test("O3 «이어 간 턴» 을 받아도 그 턴이 다시 걸리지 않았으면(정리 안내·한도 오류 없음) quotaScan 은 fired 에 머문다 — 대기 아님", () => {
  const f = T0 - 60_000;
  assert.equal(continuedWait([...openTail(f), human(f + 50_000)]), null, "사람 말이 오면 접힌다");
});
test("O4 창 앞에서 시작한 이어 간 턴이 한도 오류로 끝나면 → 다시 걸림(오류 줄 시각)", () => {
  const f = T0 - 60_000;
  const w = continuedWait([...openTail(f), limitError(f + 50_000), ...turnEnd(f + 50_100)]);
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, f + 50_000);
  assert.match(w?.text ?? "", /한도 오류/);
});
test("O5 이어 간 턴이 다시 걸리지 않고 끝났으면 대기 아님(평범한 완료)", () => {
  const f = T0 - 60_000;
  assert.equal(continuedWait([...openTail(f), assistant(f + 50_000, "끝났습니다"), ...turnEnd(f + 51_000)]), null);
});
test("O6 다시 걸린 뒤 사람이 말을 보내면 대기 아님", () => {
  const f = T0 - 60_000;
  assert.equal(continuedWait([...openTail(f), wrapUpP(f + 50_000), ...turnEnd(f + 56_000), human(f + 58_000)]), null);
});
test("O7 다시 걸린 뒤 작업 알림 한 턴이 돌고 끝나도 대기", () => {
  const f = T0 - 60_000;
  const w = continuedWait([...openTail(f), wrapUpP(f + 50_000), ...turnEnd(f + 56_000), taskNote(f + 57_000), assistant(f + 58_000, "알림 처리"), ...turnEnd(f + 59_000)]);
  assert.equal(w?.atMs, f + 50_000);
});
test("O8 창 앞에서 시작한 이어 간 턴이 아직 도는 중이면 대기 아님 — 이어 감 시각을 몰라 «막 이어 가는 중» 유예를 주지 않는다", () => {
  const f = T0 - 60_000;
  assert.deepEqual(quotaScan(openTail(f), true), { kind: "fired", atMs: 0, text: "창 앞에서 시작한 이어 간 턴", continued: true });
  assert.equal(continuedWait(openTail(f)), null);
  assert.equal(continuedWait(openTail(f), { launchedAtMs: 0, nowMs: T0 }), null, "띄운 시각을 몰라도");
});

test("T1 창 맨 앞 턴 = promptId 가 있는 첫 줄의 것(도구 결과 · 정리 안내)", () => {
  assert.equal(openTurnOf([assistant(T0, "…"), toolResult(T0 + 1), toolResult(T0 + 2, "other-prompt-id-0001")]), P);
  assert.equal(openTurnOf([...turnEnd(T0).slice(0, 2), wrapUpP(T0 + 5)]), P);
});
test("T2 promptId 가 있는 첫 줄이 턴의 첫 줄(출처 있음)이면 창 앞에서 열린 턴은 없다", () => {
  assert.equal(openTurnOf([assistant(T0, "…"), { ...human(T0 + 1), promptId: P }, toolResult(T0 + 2)]), null);
  assert.equal(openTurnOf([{ ...continuation(T0), promptId: P }, toolResult(T0 + 2)]), null);
});
test("T3 promptId 줄이 없으면 · 빈 입력 · 사이드체인뿐이면 없다", () => {
  assert.equal(openTurnOf([assistant(T0, "…"), ...turnEnd(T0 + 1)]), null);
  assert.equal(openTurnOf([]), null);
  assert.equal(openTurnOf([{ ...toolResult(T0), isSidechain: true }]), null);
  assert.equal(openTurnOf([null, "문자열", 3, { ...toolResult(T0), promptId: "" }]), null);
});
test("T4 사이드체인 줄의 promptId 는 건너뛴다", () => {
  assert.equal(openTurnOf([{ ...toolResult(T0, "sidechain-prompt-0001"), isSidechain: true }, toolResult(T0 + 1)]), P);
});
test("T5 압축 요약 줄(promptId·turnOrigin 만 — 턴 중간 줄)은 턴의 첫 줄이 아니다 — 거기서 열린 창도 그 턴을 연 턴으로 본다(격리 리뷰)", () => {
  const summary = { type: "user", isCompactSummary: true, isMeta: false, promptId: P, turnOrigin: "auto_continuation", timestamp: iso(T0), message: { role: "user", content: "요약…" } };
  assert.equal(openTurnOf([summary, toolResult(T0 + 1)]), P);
});

// ── #4821 ① 판정 규칙 한 곳(quotaScanWithOpenTurn) — «언제 묻나 · 무엇을 채택하나». 첫 줄을 어디서 어떻게 찾는지는 묻는 쪽이 준다.
//   🔴 늘 묻으면 — 판마다 수십 MB 를 거슬러 읽는다 · 🔴 출처를 안 보고 채택하면 — 사람 턴의 정리 안내까지 대기로 붙잡는다.
const asking = (answer: string | null | Error) => {
  const calls: string[] = [];
  return { calls, originOf: async (pid: string) => { calls.push(pid); if (answer instanceof Error) throw answer; return answer; } };
};
const longTail = (f: number) => [...openTail(f), wrapUpP(f + 50_000), ...turnEnd(f + 56_000)];

test("Z1 창 판정이 이미 대기면 그대로 — 묻지 않는다", async () => {
  const a = asking("auto-continuation");
  assert.equal((await quotaScanWithOpenTurn([...longTail(T0 - 60_000), ARMED()], a.originOf))?.atMs, T0);
  assert.deepEqual(a.calls, []);
});
test("Z2 창 맨 앞 턴을 모르면(첫 promptId 줄이 턴의 첫 줄 · promptId 줄 없음) 묻지 않는다 — 대기 아님", async () => {
  const a = asking("auto-continuation");
  assert.equal(await quotaScanWithOpenTurn([{ ...human(T0 - 60_000), promptId: P }, wrapUpP(T0 - 10_000), ...turnEnd(T0 - 5_000)], a.originOf), null);
  assert.equal(await quotaScanWithOpenTurn([assistant(T0, "…"), ...turnEnd(T0 + 1)], a.originOf), null);
  //  promptId 가 없는 옛 형식 — 가정하면 다시 걸림이지만 물을 promptId 가 없다(묻지 않고 대기 아님)
  const noPid = (l: Record<string, unknown>) => { const { promptId: _drop, ...rest } = l; return rest; };
  assert.equal(await quotaScanWithOpenTurn([noPid(toolResult(T0 - 60_000)), wrapUp(T0 - 10_000), ...turnEnd(T0 - 5_000)], a.originOf), null, "옛 형식");
  assert.deepEqual(a.calls, []);
});
test("Z3 «이어 간 턴» 으로 가정해도 다시 걸림이 아니면 묻지 않는다", async () => {
  const a = asking("auto-continuation");
  assert.equal(await quotaScanWithOpenTurn([...openTail(T0 - 60_000), ...turnEnd(T0 - 5_000)], a.originOf), null, "그 턴이 다시 걸리지 않고 끝났다");
  assert.equal(await quotaScanWithOpenTurn(openTail(T0 - 60_000), a.originOf), null, "그 턴이 아직 도는 중(가정 판정 fired)");
  assert.deepEqual(a.calls, []);
});
test("Z4 가정하면 다시 걸림이고 그 턴의 첫 줄이 자동 이어감이면 — 다시 걸림(그 턴의 promptId 로 한 번 묻는다)", async () => {
  const a = asking("auto-continuation");
  const w = await quotaScanWithOpenTurn(longTail(T0 - 60_000), a.originOf);
  assert.equal(w?.kind, "armed");
  assert.equal(w?.atMs, T0 - 60_000 + 50_000);
  assert.deepEqual(a.calls, [P]);
});
test("Z5 그 턴의 첫 줄이 사람·작업 알림이거나 못 찾으면 — 대기 아님", async () => {
  for (const ans of ["human", "task-notification", null]) {
    assert.equal(await quotaScanWithOpenTurn(longTail(T0 - 60_000), asking(ans).originOf), null, String(ans));
  }
});
test("Z6 묻다 실패하면 던진다(«대기 없음» 으로 뭉개지 않는다)", async () => {
  await assert.rejects(quotaScanWithOpenTurn(longTail(T0 - 60_000), asking(new Error("relay: 503")).originOf), /relay/);
});

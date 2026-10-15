#!/usr/bin/env node
// 예약 깨움·반복 예약 셈(#4695 T5, bg-jobs.mjs openWork) — 오프라인·fs-only(샌드박스 TMPDIR).
//  실행: node kit/hooks/bg-jobs-sched.test.mjs  (npm test 가 자동 발견)
//  줄 모양은 실측 원문(Claude Code 2.1.300 대화 기록 — ScheduleWakeup 결과의 toolUseResult.scheduledFor · 발화 줄 scheduled_task_fire)에서
//  옮겼다. CronCreate 결과의 모양은 실측이 없어(로컬 기록에 사용례 0) 구조화 결과 id · 글 속 id · 호출 id 세 갈래를 다 본다.
//  틀리면 티가 크다:
//   🔴 예약을 못 세고 «없음» 으로 보고하면 — 하네스 종료 규칙이 /loop 세션을 «완료» 로 읽어 3분 뒤 끈다(깨움이 영영 안 온다).
//   🔴 결과를 못 알아본 예약 호출을 «없음» 으로 접으면 — Claude Code 가 결과 모양을 바꾼 날 같은 일이 조용히 난다.
//   🔴 옛 캐시(예약 셈 전)를 이어 읽으면 — 롤 직후 앞쪽의 깨움을 영영 못 본다.
//  행 이름 R1~R15 = 사양 표 C(S1~S15) 순서 그대로.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWork, countOpenJobs, CRON_MAX_AGE_MS } from "./bg-jobs.mjs";

const T0 = Date.parse("2026-10-15T07:25:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const L = (o) => JSON.stringify(o) + "\n";
const call = (id, name, input, extra = {}) => L({ type: "assistant", timestamp: iso(T0), message: { content: [{ type: "tool_use", id, name, input }] }, ...extra });
const res = (id, text, { tur, at = T0, isError = false, extra = {} } = {}) => L({
  type: "user", timestamp: iso(at), message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }] },
  ...(tur ? { toolUseResult: tur } : {}), ...extra,
});
const wake = (id, delay, sf, o = {}) => call(id, "ScheduleWakeup", { delaySeconds: delay, reason: "다음 확인", prompt: "/loop 확인" , ...(o.stop ? { stop: true } : {}) })
  + res(id, `Next wakeup scheduled for 07:45:00 (in ${delay}s). The prompt will be delivered when the session is idle.`, { tur: sf ? { scheduledFor: sf, clampedDelaySeconds: delay } : undefined, at: o.at ?? T0 });
const fire = (taskId) => L({ type: "system", subtype: "scheduled_task_fire", taskId, taskKind: "loop", cronKind: "loop", timestamp: iso(T0 + 60_000) });
const BASH = "Command running in background with ID: bdkb93vju. Output is being written to: /private/tmp/x/tasks/bdkb93vju.output. You will be notified when it completes.";

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), "bg-sched-")); });
test.after(() => rmSync(dir, { recursive: true, force: true }));
let k = 0;
/** 대화 기록을 쓰고 새 캐시로 한 번 읽는다. */
const work = (text, deps = {}) => {
  const f = join(dir, `c${++k}.jsonl`);
  writeFileSync(f, text);
  return openWork(f, join(dir, `c${k}.cache.json`), { now: () => T0 + 120_000, ...deps });
};

test("R1 예약이 없으면 wake 없음 · cron 0 · 셈을 믿는다", () => {
  const w = work(call("tu0", "Read", { file_path: "/x" }) + res("tu0", "내용"));
  assert.deepEqual(w, { bg: 0, wakeMs: null, cron: 0, sched: true });
});
test("R2 깨움 하나 — 결과의 scheduledFor 가 다음 깨움", () => {
  assert.equal(work(wake("tw1", 1200, T0 + 1_200_000)).wakeMs, T0 + 1_200_000);
});
test("R3 깨움 둘 — 가장 나중 **결과**가 정본(더 이른 시각으로 다시 걸어도 그 값)", () => {
  assert.equal(work(wake("tw1", 1800, T0 + 1_800_000) + wake("tw2", 600, T0 + 600_000)).wakeMs, T0 + 600_000);
});
test("R4 깨움 뒤 stop:true 깨움(루프 끝)은 깨움을 지운다", () => {
  const w = work(wake("tw1", 1200, T0 + 1_200_000) + wake("tw2", 60, T0 + 60_000, { stop: true }));
  assert.equal(w.wakeMs, null);
  assert.equal(w.sched, true);
});
test("R5 결과에 scheduledFor 가 없으면 결과 줄 시각 + delaySeconds", () => {
  assert.equal(work(wake("tw1", 900, 0, { at: T0 + 5000 })).wakeMs, T0 + 5000 + 900_000);
});
test("R6 깨움 호출만 있고 결과가 없으면 «모른다»(sched false) — 다음 증분에 결과가 오면 이어 센다", () => {
  const f = join(dir, "r6.jsonl"), c = join(dir, "r6.cache.json");
  writeFileSync(f, call("tw1", "ScheduleWakeup", { delaySeconds: 1200, prompt: "x" }));
  assert.equal(openWork(f, c, { now: () => T0 }).sched, false);
  appendFileSync(f, res("tw1", "Next wakeup scheduled for 07:45:00 (in 1200s).", { tur: { scheduledFor: T0 + 1_200_000 } }));
  const w = openWork(f, c, { now: () => T0 });
  assert.equal(w.sched, true, "🔴 앞 증분의 호출을 캐시에 안 들고 가면 결과를 짝짓지 못한다");
  assert.equal(w.wakeMs, T0 + 1_200_000);
});
test("R7 깨움 결과가 오류면 아무것도 안 바꾼다(앞 깨움 그대로) · 답은 났으니 «모른다» 도 아니다", () => {
  const w = work(wake("tw1", 1200, T0 + 1_200_000) + call("tw2", "ScheduleWakeup", { delaySeconds: 30 }) + res("tw2", "delaySeconds must be ≥ 60", { isError: true }));
  assert.equal(w.wakeMs, T0 + 1_200_000);
  assert.equal(w.sched, true);
});
test("R8 CronCreate 성공은 열린 예약 하나 — 결과 줄에 예약 낱말이 없어도(결과를 기다리는 호출이 있으면) 읽는다", () => {
  const w = work(call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "확인" }) + res("tc1", "Created.", { tur: { id: "job-7f3a9c" } }));
  assert.equal(w.cron, 1);
  assert.equal(w.sched, true);
});
test("R9 CronCreate 뒤 같은 id 의 CronDelete 는 닫는다 — 구조화 id · 글에서 주운 id 모두", () => {
  assert.equal(work(call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "x" }) + res("tc1", "Created.", { tur: { id: "job-7f3a9c" } })
    + call("td1", "CronDelete", { id: "job-7f3a9c" }) + res("td1", "Deleted.")).cron, 0);
  assert.equal(work(call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "x" }) + res("tc1", "Scheduled job abc123def (every 5 minutes).")
    + call("td1", "CronDelete", { id: "abc123def" }) + res("td1", "Deleted.")).cron, 0);
  assert.equal(work(call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "x" }) + res("tc1", "Created.", { tur: { id: "job-7f3a9c" } })
    + call("td1", "CronDelete", { id: "job-other1" }) + res("td1", "Not found.")).cron, 1, "다른 id 의 삭제는 이 예약을 닫지 않는다");
});
test("R10 한 번짜리 예약(recurring:false)은 그 taskId 가 울리면 닫힌다", () => {
  assert.equal(work(call("tc1", "CronCreate", { cron: "30 8 * * *", prompt: "x", recurring: false }) + res("tc1", "Created.", { tur: { id: "job-once01" } }) + fire("job-once01")).cron, 0);
});
test("R11 반복 예약은 울려도 열린 채다", () => {
  assert.equal(work(call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "x" }) + res("tc1", "Created.", { tur: { id: "job-rep001" } }) + fire("job-rep001")).cron, 1);
});
test("R12 만든 지 7일이 넘은 예약은 세지 않는다(Claude Code 가 스스로 지운다) — 정확히 7일은 아직 센다", () => {
  const text = call("tc1", "CronCreate", { cron: "*/5 * * * *", prompt: "x" }) + res("tc1", "Created.", { tur: { id: "job-old001" } });
  assert.equal(work(text, { now: () => T0 + CRON_MAX_AGE_MS }).cron, 1);
  assert.equal(work(text, { now: () => T0 + CRON_MAX_AGE_MS + 1 }).cron, 0);
});
test("R13 서브에이전트 줄(isSidechain)의 예약은 세지 않는다 — 결과 없는 호출도 «모른다» 로 만들지 않는다", () => {
  const side = { isSidechain: true };
  const w = work(call("ts1", "ScheduleWakeup", { delaySeconds: 600 }, side)
    + res("ts1", "Next wakeup …", { tur: { scheduledFor: T0 + 600_000 }, extra: side }) + call("ts2", "ScheduleWakeup", { delaySeconds: 600 }, side));
  assert.deepEqual([w.wakeMs, w.sched], [null, true]);
});
test("R14 옛 캐시(판 없음 — 예약 셈 전)는 버리고 처음부터 다시 읽는다 — 앞쪽 깨움도 센다", () => {
  const f = join(dir, "r14.jsonl"), c = join(dir, "r14.cache.json");
  writeFileSync(f, wake("tw1", 1200, T0 + 1_200_000));
  //  예약 셈이 붙기 전의 훅이 남긴 캐시 — 이 파일을 끝까지 읽었다고 적혀 있다.
  writeFileSync(c, JSON.stringify({ file: f, size: statSync(f).size, open: [], closed: [], pending: [], shells: {} }));
  assert.equal(openWork(f, c, { now: () => T0 }).wakeMs, T0 + 1_200_000);
});
test("R15 countOpenJobs 는 종전 값 그대로 — 예약과 무관하게 bg 만(예약 셈을 못 믿어도 bg 는 센다)", () => {
  const f = join(dir, "r15.jsonl"), c = join(dir, "r15.cache.json");
  writeFileSync(f, res("tb1", BASH) + wake("tw1", 1200, T0 + 1_200_000) + call("tw2", "ScheduleWakeup", { delaySeconds: 60 }));
  assert.equal(countOpenJobs(f, c, { held: () => null }), 1);
  const w = openWork(f, join(dir, "r15b.cache.json"), { held: () => null, now: () => T0 });
  assert.deepEqual([w.bg, w.sched, w.wakeMs], [1, false, T0 + 1_200_000]);
});

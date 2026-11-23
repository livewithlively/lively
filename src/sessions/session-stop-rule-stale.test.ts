// #5623 — 원격 PC 에서 오래 남은 세션(StopMinutes.staleMin): 마지막 보고가 «백그라운드 작업 있음» 에서 굳은 세션 · 대화 id 없는 세션.
//  종전엔 둘 다 시간 제한 없이 남았다(2026-11-19 맥미니: 23일 · 14일째, 세션당 400~600MB 가 스왑에 남았다).
//  사양(윤상민 2026-11-23 «3 ㄱㄱ»): 아무도 안 본 지 staleMin 이 지나면 — 실제로 도는 작업이 없으면 끄고, 있으면 그 세션에 확인 글을 보낸다.
//   대화 id 없는 세션은 끄지 않고 확인 글만 보낸다.
//  틀리면 티가 크다:
//   🔴 도는 작업이 있는 세션을 끄면 — 일이 죽는다(이 규칙이 백그라운드를 남기던 이유).
//   🔴 대화 id 없는 세션을 끄면 — 그 대화로 다시 열 수 없다.
//   🔴 staleMin 이 매니지드에 새면 — 백그라운드를 띄운 세션이 꺼지거나 사람이 안 보낸 글이 들어간다.
//   🔴 확인 글을 매 판(1분) 다시 보내면 — 세션마다 모델 턴이 끝없이 돈다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  stopVerdict, sweepSessionStopRule, resetStopRule, MAX_REMINDS_PER_SWEEP, REMIND_RETRY_MIN_MS, STALE_REMINDER_TEXT,
  type StopFacts, type StopRuleDeps,
} from "./session-stop-rule.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { SessionState } from "./session-state.js";

const NOW = 1_800_000_000;
const DAY = 1440;
const NOT_VIEWING = { viewing: false, unknown: false, endedAtMs: 0 };
const NODE = { doneMin: 30, askingMin: 180, unknownMin: DAY, staleMin: DAY };
const MANAGED = { doneMin: 3, askingMin: 60 };
const START = NOW - 600;
const DUE = START + DAY * 60;

/** 마지막 보고가 «쉼 · 백그라운드 1» 에서 굳은 claude 세션. */
const bg = (o: Partial<StopFacts> = {}): StopFacts => ({
  harness: "claude", observed: true, managed: false, hasState: true, kind: "human", convMapped: true, runtime: "tui",
  agentState: "offline", working: false, harnessWorking: false, awaiting: false, background: false,
  lastReport: { phase: "idle", at: START, bg: 1, wake: 0, cron: 0 },
  lastActive: START, lastViewed: 0, created: NOW - 3600,
  ...o,
});
const noConv = (o: Partial<StopFacts> = {}): StopFacts => bg({ convMapped: false, lastReport: null, ...o });
const verdict = (f: StopFacts, p: typeof NODE | typeof MANAGED, now = NOW, v = NOT_VIEWING) => stopVerdict(f, v, p, now);

// ── S. 판정 ──────────────────────────────────────────────────────────────────────────────────────
test("S1 staleMin 이 없으면(매니지드) 백그라운드 · 대화 id 없음은 시간이 아무리 지나도 종전대로 남는다", () => {
  assert.deepEqual(verdict(bg(), MANAGED, NOW + 60 * 86_400), { act: "keep", why: "background" });
  assert.deepEqual(verdict(bg({ background: true, lastReport: null }), MANAGED, NOW + 60 * 86_400), { act: "keep", why: "background" });
  assert.deepEqual(verdict(noConv(), MANAGED, NOW + 60 * 86_400), { act: "keep", why: "no-conv" });
});
test("S2 staleMin 0 은 끔 — 종전과 같다", () => {
  assert.deepEqual(verdict(bg(), { ...NODE, staleMin: 0 }, NOW + 60 * 86_400), { act: "keep", why: "background" });
  assert.deepEqual(verdict(noConv(), { ...NODE, staleMin: 0 }, NOW + 60 * 86_400), { act: "keep", why: "no-conv" });
});
test("S3 아직이면 남기고 마감(시작 + staleMin)을 알려 준다", () => {
  assert.deepEqual(verdict(bg(), NODE, DUE - 1), { act: "keep", why: "stale-clock", state: "done", dueAt: DUE });
  assert.deepEqual(verdict(noConv(), NODE, DUE - 1), { act: "keep", why: "stale-clock", state: "done", dueAt: DUE });
});
test("S4 경계 — 정확히 마감이면 «오래 남음» 으로 넘긴다(갈래 표시) · 완료 분(30)으로는 넘기지 않는다", () => {
  assert.deepEqual(verdict(bg(), NODE, DUE), { act: "stop", state: "done", since: START, dueAt: DUE, stale: "background" });
  assert.deepEqual(verdict(noConv(), NODE, DUE), { act: "stop", state: "done", since: START, dueAt: DUE, stale: "no-conv" });
  assert.equal(verdict(bg(), NODE, START + 30 * 60).act, "keep", "완료 분이 지나도 백그라운드 세션은 staleMin 까지 남는다");
});
test("S5 살아 있는 백그라운드 신호(background)도 같은 갈래다 — 끌지 물을지는 집행이 그 컴퓨터의 작업을 보고 정한다", () => {
  const r = verdict(bg({ background: true }), NODE, DUE);
  assert.equal(r.act === "stop" && r.stale, "background");
});
test("S6 보는 중 · 모름 · 작업 중이면 staleMin 이 지나도 건드리지 않는다", () => {
  for (const f of [bg(), noConv()]) {
    assert.deepEqual(verdict(f, NODE, NOW + 60 * 86_400, { viewing: true, unknown: false, endedAtMs: 0 }), { act: "keep", why: "viewing" });
    assert.deepEqual(verdict(f, NODE, NOW + 60 * 86_400, { viewing: false, unknown: true, endedAtMs: 0 }), { act: "keep", why: "view-unknown" });
  }
  for (const o of [{ working: true }, { harnessWorking: true }, { agentState: "busy" }] as Array<Partial<StopFacts>>) {
    assert.deepEqual(verdict(bg(o), NODE, NOW + 60 * 86_400), { act: "keep", why: "working" }, JSON.stringify(o));
    assert.deepEqual(verdict(noConv(o), NODE, NOW + 60 * 86_400), { act: "keep", why: "working" }, JSON.stringify(o));
  }
});
test("S7 대화 id 없는 세션이 질문을 띄웠거나 하네스가 꺼졌으면 건드리지 않는다(글이 질문의 답으로 들어간다 · 받을 것이 없다)", () => {
  assert.deepEqual(verdict(noConv({ awaiting: true }), NODE, NOW + 60 * 86_400), { act: "keep", why: "no-conv" });
  assert.deepEqual(verdict(noConv({ agentState: "waiting" }), NODE, NOW + 60 * 86_400), { act: "keep", why: "no-conv" });
  assert.deepEqual(verdict(noConv({ agentState: "exited" }), NODE, NOW + 60 * 86_400), { act: "keep", why: "no-conv" });
});
test("S8 시계는 «안 보기 시작» 에서 잰다 — 활동이 오래됐어도 방금 본 세션은 staleMin 을 다시 센다", () => {
  const viewed = NOW + 7200;
  const r = verdict(bg({ lastViewed: viewed }), NODE, viewed + 3600);
  assert.equal(r.act, "keep");
  assert.equal(r.act === "keep" && r.why, "stale-clock");
});
test("S9 범위 밖은 그대로 — 상시 · 위탁 · grok · 대화 런타임 · 예약 깨움", () => {
  assert.equal((verdict(bg({ managed: true }), NODE, DUE) as { why: string }).why, "managed");
  assert.equal((verdict(bg({ kind: "task" }), NODE, DUE) as { why: string }).why, "kind");
  assert.equal((verdict(noConv({ harness: "grok" }), NODE, DUE) as { why: string }).why, "harness");
  assert.equal((verdict(noConv({ runtime: "chat" }), NODE, DUE) as { why: string }).why, "runtime");
  const sched = bg({ lastReport: { phase: "idle", at: START, bg: 0, wake: NOW + 90 * 86_400, cron: 0 } });
  assert.deepEqual(verdict(sched, NODE, DUE), { act: "keep", why: "scheduled" });
});

// ── T. 집행 ──────────────────────────────────────────────────────────────────────────────────────
const OLD = NOW - 2 * 86_400;
const row = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: id, harness: "claude", dir: "/w", autoApprove: false, owner: "a", owned: true, created: OLD - 3600,
  attached: false, invites: [], flags: {}, projectId: 0, agentState: "offline", lastActive: OLD,
  lastReport: { phase: "idle", at: OLD, bg: 1, wake: 0, cron: 0 }, ...o,
} as SessionInfo);
const SCREEN = ["────────────────", "❯ ", "────────────────", "  ? for shortcuts"].join("\n");
interface Spy { reaped: string[]; reminded: Array<{ id: string; text: string; why: string }> }
function deps(rows: SessionInfo[], o: Partial<StopRuleDeps> & { noConv?: string[]; jobs?: string[]; unknown?: string[]; now?: () => number } = {}): { d: Partial<StopRuleDeps>; spy: Spy } {
  const spy: Spy = { reaped: [], reminded: [] };
  const noConvIds = new Set(o.noConv ?? []);
  const d: Partial<StopRuleDeps> = {
    enabled: () => true,
    loadPolicy: async () => ({}),
    minutesOf: () => NODE,
    scopeKey: () => "t\u0000node:A",
    listLive: async () => rows,
    listStates: async () => rows.map((r) => ({ id: r.id, owner: "a", kind: "human", claude_session_id: noConvIds.has(r.id) ? null : `c-${r.id}` } as unknown as SessionState)),
    listManaged: async () => [],
    view: () => NOT_VIEWING,
    jobVerdicts: async () => ({ jobs: new Set(o.jobs ?? []), unknown: new Set(o.unknown ?? []) }),
    capture: async () => SCREEN,
    quotaWait: async () => null,
    keys: async () => {},
    saveNote: async () => {},
    markLastRun: async () => {},
    reap: async (id) => { spy.reaped.push(id); },
    remind: async (id, text, why) => { spy.reminded.push({ id, text, why }); },
    sleep: async () => {},
    now: () => NOW * 1000,
    arm: () => {},
    ...o,
  };
  return { d, spy };
}
test.beforeEach(() => resetStopRule());

test("T1 백그라운드로 굳은 세션 — 그 컴퓨터에 도는 작업이 없으면 끈다(글은 안 보낸다)", async () => {
  const { d, spy } = deps([row("box-a-1")]);
  const r = await sweepSessionStopRule(d);
  assert.deepEqual(spy.reaped, ["box-a-1"]);
  assert.deepEqual(spy.reminded, []);
  assert.equal(r.stopped.length, 1);
});
test("T2 백그라운드로 굳은 세션 — 도는 작업이 있으면 끄지 않고 확인 글을 보낸다", async () => {
  const { d, spy } = deps([row("box-a-1")], { jobs: ["box-a-1"] });
  const r = await sweepSessionStopRule(d);
  assert.deepEqual(spy.reaped, []);
  assert.deepEqual(spy.reminded, [{ id: "box-a-1", text: STALE_REMINDER_TEXT, why: "background" }]);
  assert.deepEqual(r.reminded?.map((x) => [x.id, x.why]), [["box-a-1", "background"]]);
  assert.equal(r.kept.reminded, 1);
});
test("T3 작업 판정을 못 했으면 끄지도 묻지도 않는다(모르면 안 건드린다)", async () => {
  const { d, spy } = deps([row("box-a-1")], { unknown: ["box-a-1"] });
  const r = await sweepSessionStopRule(d);
  assert.deepEqual([spy.reaped, spy.reminded], [[], []]);
  assert.equal(r.kept["jobs-unknown"], 1);
});
test("T4 대화 id 없는 세션은 도는 작업이 없어도 끄지 않는다 — 확인 글만", async () => {
  const { d, spy } = deps([row("box-a-1", { lastReport: undefined })], { noConv: ["box-a-1"] });
  await sweepSessionStopRule(d);
  assert.deepEqual(spy.reaped, []);
  assert.deepEqual(spy.reminded.map((x) => [x.id, x.why]), [["box-a-1", "no-conv"]]);
});
test("T5 한 번 보낸 세션은 다음 판에 다시 보내지 않는다 — 대기(max(staleMin, 바닥))가 지나야 다시 본다", async () => {
  let nowMs = NOW * 1000;
  const { d, spy } = deps([row("box-a-1")], { jobs: ["box-a-1"], now: () => nowMs });
  await sweepSessionStopRule(d);
  nowMs += 60_000;
  const r2 = await sweepSessionStopRule(d);
  assert.equal(spy.reminded.length, 1, "1분 뒤 판은 다시 보내지 않는다");
  assert.equal(r2.kept["remind-wait"], 1);
  nowMs = NOW * 1000 + Math.max(REMIND_RETRY_MIN_MS, DAY * 60_000) + 1000;
  await sweepSessionStopRule(d);
  assert.equal(spy.reminded.length, 2, "대기가 지나면(그동안 세션이 답하지 않았으면) 다시 묻는다");
});
test("T6 보내기에 실패해도 매 판 다시 시도하지 않는다 — 실패로 세고 대기한다", async () => {
  let nowMs = NOW * 1000;
  let calls = 0;
  const { d } = deps([row("box-a-1")], { jobs: ["box-a-1"], now: () => nowMs, remind: async () => { calls++; throw new Error("그 컴퓨터가 응답하지 않는다"); } });
  const r = await sweepSessionStopRule(d);
  assert.equal(r.kept["remind-failed"], 1);
  nowMs += 60_000;
  await sweepSessionStopRule(d);
  assert.equal(calls, 1);
});
test("T7 한 판에 보내는 확인 글은 상한까지 — 나머지는 다음 판으로", async () => {
  const ids = Array.from({ length: MAX_REMINDS_PER_SWEEP + 2 }, (_, i) => `box-a-${i}`);
  const { d, spy } = deps(ids.map((id) => row(id)), { jobs: ids });
  const r = await sweepSessionStopRule(d);
  assert.equal(spy.reminded.length, MAX_REMINDS_PER_SWEEP);
  assert.equal(r.kept.capped, 2);
});
test("T8 보내기 직전에 사람이 돌아왔으면 보내지 않는다", async () => {
  let n = 0;
  //  판정 때는 안 보는 중 · 보내기 직전 확인 때는 보는 중.
  const { d, spy } = deps([row("box-a-1")], { jobs: ["box-a-1"], view: () => (n++ === 0 ? NOT_VIEWING : { viewing: true, unknown: false, endedAtMs: 0 }) });
  const r = await sweepSessionStopRule(d);
  assert.deepEqual(spy.reminded, []);
  assert.equal(r.kept["viewing-now"], 1);
});
test("T9 확인 글을 보내는 수단이 없으면(remind 미배선) 그 세션은 종전대로 남는다 — 끄지 않는다", async () => {
  const { d, spy } = deps([row("box-a-1"), row("box-a-2", { lastReport: undefined })], { jobs: ["box-a-1"], noConv: ["box-a-2"], remind: undefined });
  const r = await sweepSessionStopRule(d);
  assert.deepEqual(spy.reaped, []);
  assert.equal(r.kept["remind-off"], 2);
});
test("T10 매니지드 판(staleMin 없음)은 백그라운드 세션을 끄지도 묻지도 않는다", async () => {
  const { d, spy } = deps([row("box-a-1")], { minutesOf: () => MANAGED });
  const r = await sweepSessionStopRule(d);
  assert.deepEqual([spy.reaped, spy.reminded], [[], []]);
  assert.equal(r.kept.background, 1);
});
test("T11 확인 글은 새 일을 시키지 않는다 — 확인 · 끄기 · 한 줄 답만 요청한다", () => {
  assert.match(STALE_REMINDER_TEXT, /새 작업을 시작하지 말고/);
  assert.match(STALE_REMINDER_TEXT, /한 줄로 답/);
});

// #5043 — 하네스 종료 규칙에 원격 PC 판이 기대는 세 가지: 상태 모름 안전망(StopMinutes.unknownMin) · 판의 자리 이름(scopeKey) · 분 읽는 법(minutesOf).
//  사양: 스크래치 spec.md 표 A·B. 틀리면 티가 크다:
//   🔴 안전망이 매니지드에 새면 — 예약을 못 센 claude 세션(롤 직후 옛 훅)이 일제히 꺼진다(#4695 V17 이 막던 사고).
//   🔴 안전망이 «작업 중» 을 이기면 — 도는 일이 24시간 뒤 죽는다.
//   🔴 자리 이름이 테넌트로 묶이면 — 같은 워크스페이스의 매니지드 판과 원격 PC 판이 서로를 «도는 중» 으로 막아 한쪽이 영영 안 돈다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { stopVerdict, sweepSessionStopRule, resetStopRule, type StopFacts, type StopRuleDeps } from "./session-stop-rule.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { SessionState } from "./session-state.js";

const NOW = 1_800_000_000;
const DAY_MIN = 1440;
const NOT_VIEWING = { viewing: false, unknown: false, endedAtMs: 0 };
const NET = { doneMin: 30, askingMin: 180, unknownMin: DAY_MIN };

/** 예약 칸이 없는 claude 턴 끝 보고(옛 훅) — 종전엔 «예약 모름» 으로 영원히 남던 세션. */
const unknownSched = (o: Partial<StopFacts> = {}): StopFacts => ({
  harness: "claude", observed: true, managed: false, hasState: true, kind: "human", convMapped: true, runtime: "tui",
  agentState: "offline", working: false, harnessWorking: false, awaiting: false, background: false,
  lastReport: { phase: "idle", at: NOW - 600 },
  lastActive: NOW - 600, lastViewed: 0, created: NOW - 3600,
  ...o,
});
const verdict = (f: StopFacts, p: { doneMin: number; askingMin: number; unknownMin?: number }, now = NOW, v = NOT_VIEWING) => stopVerdict(f, v, p, now);

// ── A. 상태 모름 안전망 ───────────────────────────────────────────────────────────────────────────
test("A1 안전망이 없으면(매니지드) 예약 칸 없는 claude 는 시간이 아무리 지나도 «예약 모름» 으로 남는다", () => {
  assert.deepEqual(verdict(unknownSched(), { doneMin: 3, askingMin: 60 }, NOW + 30 * 86_400), { act: "keep", why: "sched-unknown" });
});
test("A2 안전망 0 은 끔 — 종전과 같다", () => {
  assert.deepEqual(verdict(unknownSched(), { ...NET, unknownMin: 0 }, NOW + 30 * 86_400), { act: "keep", why: "sched-unknown" });
});
test("A3 안전망 1440 — 아직이면 남기고 마감(시작+24시간)을 알려 준다", () => {
  const start = NOW - 600;
  assert.deepEqual(verdict(unknownSched(), NET, start + DAY_MIN * 60 - 1), { act: "keep", why: "net-clock", state: "done", dueAt: start + DAY_MIN * 60 });
});
test("A4 경계 — 정확히 마감이면 끈다(안전망 표시) · 1초 전은 남긴다", () => {
  const start = NOW - 600;
  const due = start + DAY_MIN * 60;
  assert.equal(verdict(unknownSched(), NET, due - 1).act, "keep");
  assert.deepEqual(verdict(unknownSched(), NET, due), { act: "stop", state: "done", since: start, dueAt: due, net: true });
});
test("A5 마지막 보고가 «작업 중» 에서 멈췄고 지금 작업 신호가 없으면 안전망으로 끈다", () => {
  const f = unknownSched({ lastReport: { phase: "busy", at: NOW - 600 } });
  const r = verdict(f, NET, NOW - 600 + DAY_MIN * 60);
  assert.equal(r.act, "stop");
  assert.equal(r.act === "stop" && r.net, true);
});
test("A6 작업 중 신호(스피너·훅·화면)가 있으면 안전망이 지나도 안 끈다 — 살아 있는 증거가 이긴다", () => {
  for (const o of [{ working: true }, { harnessWorking: true }, { agentState: "busy" }] as Array<Partial<StopFacts>>) {
    assert.deepEqual(verdict(unknownSched(o), NET, NOW + 30 * 86_400), { act: "keep", why: "working" }, JSON.stringify(o));
  }
});
test("A7 보는 중이면 안전망이 지나도 안 끈다", () => {
  assert.deepEqual(verdict(unknownSched(), NET, NOW + 30 * 86_400, { viewing: true, unknown: false, endedAtMs: 0 }), { act: "keep", why: "viewing" });
});
test("A8 예약을 센 정상 완료는 완료 분(30)으로 끄고 안전망 표시가 없다", () => {
  const f = unknownSched({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: 0, cron: 0 } });
  const due = NOW - 600 + 30 * 60;
  assert.deepEqual(verdict(f, NET, due), { act: "stop", state: "done", since: NOW - 600, dueAt: due });
});
test("A9 대화 id 를 모르면 안전망이 지나도 안 끈다(다시 열 수 없다)", () => {
  assert.deepEqual(verdict(unknownSched({ convMapped: false }), NET, NOW + 30 * 86_400), { act: "keep", why: "no-conv" });
});
test("A10 백그라운드 작업·예약 깨움은 안전망과 무관하게 남긴다", () => {
  assert.equal(verdict(unknownSched({ background: true }), NET, NOW + 30 * 86_400).act, "keep");
  const sched = unknownSched({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: NOW + 30 * 86_400, cron: 0 } });
  assert.deepEqual(verdict(sched, NET, NOW + 86_400), { act: "keep", why: "scheduled" });
});
test("A11 안전망 시계도 «안 보기 시작»(마지막 열람 + 45초)에서 잰다 — 활동이 오래됐어도 방금 본 세션은 24시간 남긴다", () => {
  const viewed = NOW + 7200;
  const f = unknownSched({ lastActive: NOW - 86_400 * 3, lastViewed: viewed });
  const r = verdict(f, NET, viewed + 3600);
  assert.equal(r.act, "keep");
  assert.equal(r.act === "keep" && r.why, "net-clock");
  assert.equal(r.act === "keep" && r.dueAt, viewed + 45 + DAY_MIN * 60);
});

// ── B. 판·집행 선택지 ─────────────────────────────────────────────────────────────────────────────
const row = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: id, harness: "claude", dir: "/w", autoApprove: false, owner: "a", owned: true, created: NOW - 3600,
  attached: false, invites: [], flags: {}, projectId: 0, agentState: "offline", lastActive: NOW - 600,
  lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: 0, cron: 0 }, ...o,
} as SessionInfo);
const stOf = (id: string): SessionState => ({ id, owner: "a", kind: "human", claude_session_id: `c-${id}` } as SessionState);
const SCREEN = ["────────────────", "❯ ", "────────────────", "  ? for shortcuts"].join("\n");

test.beforeEach(() => resetStopRule());

function deps(rows: SessionInfo[], o: Partial<StopRuleDeps> & { reaped?: string[]; armed?: number[] } = {}): Partial<StopRuleDeps> {
  const reaped = o.reaped ?? [];
  const armed = o.armed ?? [];
  return {
    enabled: () => true,
    loadPolicy: async () => ({}),
    listLive: async () => rows,
    listStates: async () => rows.map((r) => stOf(r.id)),
    listManaged: async () => [],
    view: () => NOT_VIEWING,
    jobVerdicts: async () => ({ jobs: new Set(), unknown: new Set() }),
    capture: async () => SCREEN,
    quotaWait: async () => null,
    keys: async () => {},
    saveNote: async () => {},
    markLastRun: async () => {},
    reap: async (id) => { reaped.push(id); },
    sleep: async () => {},
    now: () => NOW * 1000,
    arm: (at) => { armed.push(at); },
    ...o,
  };
}

test("B1 자리 이름이 다른 두 판은 동시에 돈다 — 매니지드 판과 원격 PC 판이 서로를 막지 않는다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowRows = async () => { await gate; return [row("box-x-1")]; };
  const a = sweepSessionStopRule({ ...deps([]), scopeKey: () => "t\u0000node:A", listLive: slowRows });
  const b = await sweepSessionStopRule({ ...deps([row("box-y-1")]), scopeKey: () => "t\u0000node:B" });
  release();
  const ra = await a;
  assert.notEqual(b.why, "in-flight");
  assert.notEqual(ra.why, "in-flight");
  assert.equal(b.scanned, 1);
});
test("B2 같은 자리 이름의 판은 겹치면 뒤 판이 건너뛴다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = sweepSessionStopRule({ ...deps([]), scopeKey: () => "t\u0000node:A", listLive: async () => { await gate; return []; } });
  const b = await sweepSessionStopRule({ ...deps([row("box-y-1")]), scopeKey: () => "t\u0000node:A" });
  release();
  await a;
  assert.equal(b.why, "in-flight");
  assert.equal(b.kept["busy-sweep"], 1);
});
test("B3 분 읽는 법을 주면 정책의 매니지드 값(3분) 대신 그 값으로 판정한다 — 10분 논 완료 세션은 30분 규칙에선 남는다", async () => {
  const reaped: string[] = [];
  const r = await sweepSessionStopRule({ ...deps([row("box-a-1")], { reaped }), minutesOf: () => NET });
  assert.deepEqual(reaped, []);
  assert.equal(r.doneMin, 30);
  assert.equal(r.unknownMin, DAY_MIN);
  assert.equal(r.kept.clock, 1);
  const reaped2: string[] = [];
  await sweepSessionStopRule({ ...deps([row("box-a-1")], { reaped: reaped2 }) });   // 같은 세션 · 기본(매니지드 3분)
  assert.deepEqual(reaped2, ["box-a-1"]);
});
test("B4 세 분이 모두 0 이면 꺼짐 · 안전망만 켜져 있어도 돈다", async () => {
  const off = await sweepSessionStopRule({ ...deps([row("box-a-1")]), minutesOf: () => ({ doneMin: 0, askingMin: 0, unknownMin: 0 }) });
  assert.equal(off.enabled, false);
  assert.equal(off.why, "policy-off");
  const reaped: string[] = [];
  const old = row("box-a-1", { lastActive: NOW - 3 * 86_400, lastReport: { phase: "idle", at: NOW - 3 * 86_400 } });
  const on = await sweepSessionStopRule({ ...deps([old], { reaped }), minutesOf: () => ({ doneMin: 0, askingMin: 0, unknownMin: DAY_MIN }) });
  assert.equal(on.enabled, true);
  assert.deepEqual(reaped, ["box-a-1"]);
});
test("B5 안전망으로 끈 세션은 결과에 net 표시 — 보통 끄기엔 그 칸이 아예 없다(결과 모양 무회귀)", async () => {
  const old = row("box-old", { lastActive: NOW - 3 * 86_400, lastReport: { phase: "idle", at: NOW - 3 * 86_400 } });
  const fresh = row("box-done", { lastActive: NOW - 3600 });
  const r = await sweepSessionStopRule({ ...deps([old, fresh]), minutesOf: () => NET });
  const byId = Object.fromEntries(r.stopped.map((s) => [s.id, s]));
  assert.equal(byId["box-old"]?.net, true);
  assert.ok(byId["box-done"], "정상 완료도 껐다");
  assert.equal("net" in byId["box-done"]!, false);
});
test("B6 안전망 시계의 마감도 다음 깨움에 들어간다", async () => {
  const armed: number[] = [];
  const s = row("box-a-1", { lastActive: NOW - 600, lastReport: { phase: "idle", at: NOW - 600 } });
  const r = await sweepSessionStopRule({ ...deps([s], { armed }), minutesOf: () => NET });
  assert.equal(r.kept["net-clock"], 1);
  assert.deepEqual(armed, [NOW - 600 + DAY_MIN * 60]);
});

// #4695 T5 — 하네스 종료 규칙(«완료+안 봄 N분 · 질의+안 봄 M분 · 작업 중은 상한 없음 · 모르면 안 끈다»)의 계약.
//  사양: 지식 session-harness-lifecycle-rules-4690 · 태스크 #4695 · 엣지 표 V1~V27(작업 스크래치 spec.md E).
//  틀리면 티가 크다:
//   🔴 보는 중인 세션을 끄면 — 사람이 보고 있는 화면이 «중단됨» 으로 바뀐다(규칙의 첫째 금지).
//   🔴 작업 중·백그라운드·예약 깨움을 «완료» 로 읽으면 — 도는 일이 죽는다(T2: 상민님 실행 시간의 42% 가 그 공백).
//   🔴 예약을 못 센 claude 보고(옛 훅·옛 세션 호스트)를 «완료» 로 읽으면 — 롤 직후 루프가 일제히 꺼진다.
//   🔴 시계를 «안 보기 시작» 이 아니라 «마지막 활동» 으로만 재면 — 막 보고 떠난 세션이 곧바로 꺼진다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stopVerdict, stopFactsOf, stopMinutesOf, sweepSessionStopRule, resetStopRule, stopRuleDecides, sessionsUnderStopRule, logStopRuleTick, WAKE_GRACE_SEC, MAX_STOPS_PER_SWEEP, JOB_HOLD_MS, type StopFacts } from "./session-stop-rule.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { SessionState } from "./session-state.js";

const NOW = 1_800_000_000;                 // 지금(epoch초)
const MIN = { doneMin: 3, askingMin: 60 };
const NOT_VIEWING = { viewing: false, unknown: false, endedAtMs: 0 };

/** 완료(claude · 예약을 셌고 기다리는 일 없음 · 대화 id 있음 · 사람 세션)가 기본인 재료. 행마다 한 가지만 바꾼다. */
const done = (o: Partial<StopFacts> = {}): StopFacts => ({
  harness: "claude", observed: true, managed: false, hasState: true, kind: "human", convMapped: true, runtime: "tui",
  agentState: "idle", working: false, harnessWorking: false, awaiting: false, background: false,
  lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: 0, cron: 0 },
  lastActive: NOW - 600, lastViewed: 0, created: NOW - 3600,
  ...o,
});
const keepWhy = (f: StopFacts, v = NOT_VIEWING, p = MIN, now = NOW): string => {
  const r = stopVerdict(f, v, p, now);
  return r.act === "keep" ? r.why : `stop:${r.state}`;
};

// ── ① 범위 ──────────────────────────────────────────────────────────────────────────────────────
test("V1 관측 못 한 행은 끄지 않는다", () => assert.equal(keepWhy(done({ observed: false })), "unobserved"));
test("V2 상시 세션은 끄지 않는다", () => assert.equal(keepWhy(done({ managed: true })), "managed"));
test("V3 장부 행이 없으면(다시 열 좌표 없음) 끄지 않는다", () => assert.equal(keepWhy(done({ hasState: false })), "no-state"));
test("V4 사람 세션이 아니면(위탁·앱·로그인·상시) 끄지 않는다", () => {
  for (const kind of ["task", "app", "login", "managed"]) assert.equal(keepWhy(done({ kind })), "kind", kind);
  assert.equal(keepWhy(done({ kind: "" })), "stop:done", "종류가 비었으면(옛 행) 사람 세션이다");
});
test("V5 grok·opencode·셸은 이 규칙 밖(옛 회수 방식)", () => {
  for (const harness of ["grok", "opencode", "shell", ""]) assert.equal(keepWhy(done({ harness })), "harness", harness);
});
test("V6 codex app-server · 대화 런타임(chat) 세션은 이 규칙 밖", () => {
  assert.equal(keepWhy(done({ harness: "codex", runtime: "app-server", lastReport: null })), "runtime");
  assert.equal(keepWhy(done({ runtime: "chat" })), "runtime");
});
test("V7 대화 id 를 모르면 끄지 않는다(다시 열 때 옆 세션 대화·빈 피커) — claude·codex·agy 모두", () => {
  for (const harness of ["claude", "codex", "antigravity"]) assert.equal(keepWhy(done({ harness, convMapped: false })), "no-conv", harness);
});

// ── ② 보는 중 ────────────────────────────────────────────────────────────────────────────────────
test("V8 보는 중이면 어느 상태든 끄지 않는다(완료·질의·셸만 남음)", () => {
  const v = { viewing: true, unknown: false, endedAtMs: 0 };
  assert.equal(keepWhy(done(), v), "viewing");
  assert.equal(keepWhy(done({ awaiting: true, agentState: "waiting" }), v), "viewing");
  assert.equal(keepWhy(done({ agentState: "exited" }), v), "viewing");
});
test("V9 보는지 모르면(게이트웨이가 막 떴다) 끄지 않는다", () => {
  assert.equal(keepWhy(done(), { viewing: false, unknown: true, endedAtMs: 0 }), "view-unknown");
});

// ── ③ 상태 ──────────────────────────────────────────────────────────────────────────────────────
test("V10 작업 중은 시간과 무관하게 끄지 않는다(상한 없음 — 10시간 뒤에도)", () => {
  assert.equal(keepWhy(done({ working: true }), NOT_VIEWING, MIN, NOW + 36_000), "working");
  assert.equal(keepWhy(done({ harnessWorking: true })), "working");
  assert.equal(keepWhy(done({ agentState: "busy" })), "working");
});
test("V11 턴 끝 보고의 열린 백그라운드 작업(bg≥1)이 있으면 끄지 않는다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 1, wake: 0, cron: 0 } })), "background");
});
test("V12 화면의 백그라운드 표식만 있어도 끄지 않는다", () => assert.equal(keepWhy(done({ background: true })), "background"));
test("V13 예약 깨움이 미래면 끄지 않는다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: NOW + 1800, cron: 0 } })), "scheduled");
});
test("V14 예약 깨움이 막 지났어도 유예(5분) 안이면 끄지 않는다 — 깨움은 하네스가 쉴 때 울려 곧 새 턴을 연다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: NOW - WAKE_GRACE_SEC + 1, cron: 0 } })), "scheduled");
});
test("V15 예약 깨움이 유예를 정확히 넘기면(새 턴이 안 열렸다) 완료로 친다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: NOW - WAKE_GRACE_SEC, cron: 0 } })), "stop:done");
});
test("V16 열린 반복 예약(cron≥1)이 있으면 끄지 않는다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: 0, cron: 1 } })), "scheduled");
});
test("V17 claude 의 턴 끝 보고에 예약 칸이 없으면(옛 훅·옛 세션 호스트) «모른다» — 끄지 않는다", () => {
  assert.equal(keepWhy(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0 } })), "sched-unknown");
});
test("V18 claude 의 마지막 보고가 없거나 idle 이 아니면 끄지 않는다(끊긴 턴의 낡은 busy 포함)", () => {
  assert.equal(keepWhy(done({ lastReport: null })), "sched-unknown");
  assert.equal(keepWhy(done({ lastReport: { phase: "busy", at: NOW - 3600 } })), "sched-unknown");
});
test("V27 질의이면서 작업 중으로도 보이면 작업이 이긴다(끄지 않는 쪽)", () => {
  assert.equal(keepWhy(done({ awaiting: true, agentState: "waiting", working: true })), "working");
});

// ── ④ 시계 ──────────────────────────────────────────────────────────────────────────────────────
test("V19 완료 · N=3 — 2분 59초는 아직(마감을 알려 준다)", () => {
  const r = stopVerdict(done({ lastActive: NOW - 179 }), NOT_VIEWING, MIN, NOW);
  assert.deepEqual(r, { act: "keep", why: "clock", state: "done", dueAt: NOW + 1 });
});
test("V20 완료 · N=3 — 정확히 3분이면 끈다", () => {
  const r = stopVerdict(done({ lastActive: NOW - 180 }), NOT_VIEWING, MIN, NOW);
  assert.equal(r.act, "stop");
  if (r.act === "stop") { assert.equal(r.state, "done"); assert.equal(r.since, NOW - 180); assert.equal(r.dueAt, NOW); }
});
test("V21 시계는 «안 보기 시작» 부터 — 마지막 활동보다 늦게 떠났으면 떠난 때부터 잰다", () => {
  //  1시간 전에 일이 끝났지만 2분 전까지 보고 있었다 → 아직 1분 남았다.
  const r = stopVerdict(done({ lastActive: NOW - 3600 }), { viewing: false, unknown: false, endedAtMs: (NOW - 120) * 1000 }, MIN, NOW);
  assert.deepEqual(r, { act: "keep", why: "clock", state: "done", dueAt: NOW + 60 });
});
test("V21b tmux 의 마지막 열람(+45초)도 «안 보기 시작» 이다 — 게이트웨이를 다시 띄워도 끝난 시각을 안다", () => {
  const r = stopVerdict(done({ lastActive: NOW - 3600, lastViewed: NOW - 120 }), NOT_VIEWING, MIN, NOW);
  assert.deepEqual(r, { act: "keep", why: "clock", state: "done", dueAt: NOW - 120 + 45 + 180 });
});
test("V22 질의 · M=60 — 59분 59초는 아직 · 60분이면 끈다", () => {
  const asking = done({ awaiting: true, agentState: "waiting", lastReport: { phase: "waiting", at: NOW - 3600 } });
  assert.equal(keepWhy({ ...asking, lastActive: NOW - 3599 }), "clock");
  assert.equal(keepWhy({ ...asking, lastActive: NOW - 3600 }), "stop:asking");
});
test("V22b 질의는 예약 칸과 무관하다 — claude 보고가 waiting 이어도 질의로 잰다", () => {
  assert.equal(keepWhy(done({ awaiting: true, lastReport: { phase: "waiting", at: NOW - 4000 }, lastActive: NOW - 4000 })), "stop:asking");
});
test("V23 하네스가 끝나 셸만 남음(exited) — 완료와 같이 N분 뒤", () => {
  assert.equal(keepWhy(done({ agentState: "exited", lastReport: null, lastActive: NOW - 179 })), "clock");
  assert.equal(keepWhy(done({ agentState: "exited", lastReport: null, lastActive: NOW - 180 })), "stop:exited");
});
test("V24 N=0 이면 완료를 안 끄고 · M=0 이면 질의를 안 끈다", () => {
  assert.equal(keepWhy(done(), NOT_VIEWING, { doneMin: 0, askingMin: 60 }), "off");
  assert.equal(keepWhy(done({ awaiting: true, lastActive: NOW - 99_999 }), NOT_VIEWING, { doneMin: 3, askingMin: 0 }), "off");
  assert.equal(keepWhy(done({ awaiting: true, lastActive: NOW - 99_999 }), NOT_VIEWING, { doneMin: 0, askingMin: 60 }), "stop:asking", "N=0 이어도 질의는 M 으로");
});
test("V25 codex·agy 는 보고가 없어도 화면이 대기면 완료다(예약 도구가 없다)", () => {
  assert.equal(keepWhy(done({ harness: "codex", lastReport: null })), "stop:done");
  assert.equal(keepWhy(done({ harness: "antigravity", lastReport: { phase: "idle", at: NOW - 600 } })), "stop:done");
});
test("V26 마지막 활동이 없으면 마지막 보고 시각 → 만든 시각 순으로 시계를 잡는다 · 셋 다 없으면 끄지 않는다", () => {
  assert.equal(stopVerdict(done({ lastActive: 0, lastReport: { phase: "idle", at: NOW - 100, bg: 0, wake: 0, cron: 0 } }), NOT_VIEWING, MIN, NOW).act, "keep");
  assert.equal(stopVerdict(done({ lastActive: 0, lastReport: { phase: "idle", at: NOW - 200, bg: 0, wake: 0, cron: 0 } }), NOT_VIEWING, MIN, NOW).act, "stop");
  assert.equal(keepWhy(done({ harness: "codex", lastActive: 0, lastReport: null, created: NOW - 200 })), "stop:done");
  assert.equal(keepWhy(done({ harness: "codex", lastActive: 0, lastReport: null, created: 0 })), "no-clock");
});

// ── 재료 뽑기 · 정책 ─────────────────────────────────────────────────────────────────────────────
const row = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "box-a-1", label: "x", harness: "claude", dir: "/w", autoApprove: false, owner: "a", owned: true, created: NOW - 3600,
  attached: false, invites: [], flags: {}, projectId: 0, agentState: "offline", ...o,
} as SessionInfo);
const st = (o: Partial<SessionState> = {}): SessionState => ({ id: "box-a-1", owner: "a", kind: "human", claude_session_id: "c-1", ...o } as SessionState);

test("F1 재료 — codex 표식이 app-server 면 runtime app-server · chat 런타임은 chat · 그 밖 tui", () => {
  assert.equal(stopFactsOf(row({ harness: "codex", runtimeRaw: "app-server" }), st(), new Set()).runtime, "app-server");
  assert.equal(stopFactsOf(row({ harness: "codex", runtimeRaw: "terminal" }), st(), new Set()).runtime, "tui");
  assert.equal(stopFactsOf(row({ runtimeChoice: "chat" }), st(), new Set()).runtime, "chat");
  assert.equal(stopFactsOf(row(), st(), new Set()).runtime, "tui");
});
test("F2 재료 — 상시 세션은 행 표식이나 상시 세션 목록 어느 쪽으로든 · 장부 행이 없으면 hasState 거짓 · 대화 id 는 장부 행의 것", () => {
  assert.equal(stopFactsOf(row({ managed: "m1" }), st(), new Set()).managed, true);
  assert.equal(stopFactsOf(row(), st(), new Set(["box-a-1"])).managed, true);
  const f = stopFactsOf(row(), undefined, new Set());
  assert.equal(f.hasState, false); assert.equal(f.convMapped, false); assert.equal(f.kind, "human");
  assert.equal(stopFactsOf(row({ observed: false } as Partial<SessionInfo>), st(), new Set()).observed, false);
});
test("P1 정책 — 칸이 없으면 기본(3·60) · 0 은 끔으로 남는다", () => {
  assert.deepEqual(stopMinutesOf({}), { doneMin: 3, askingMin: 60 });
  assert.deepEqual(stopMinutesOf({ stop_done_minutes: 0, stop_asking_minutes: 0 }), { doneMin: 0, askingMin: 0 });
  assert.deepEqual(stopMinutesOf({ stop_done_minutes: 10, stop_asking_minutes: 30 }), { doneMin: 10, askingMin: 30 });
});

// ── 집행(스윕) — 부작용으로 단언한다: 무엇을 끄고(reap 호출) 무엇을 남겼나(쪽지 저장) ───────────────────────────
const CLAUDE_DRAFT_SCREEN = [
  "────────────────────────────────────────",
  "❯ 다음엔 이걸 해 줘",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");
const CLAUDE_ASK_SCREEN = [
  "────────────────────────────────────────",
  " ☐ 색상",
  "가장 좋아하는 색은?",
  "❯ 1. 빨강",
  "  2. 파랑",
  "  3. Type something.",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const CLAUDE_TURN_SCREEN = [
  "✽ Architecting… (6m 28s · ↓ 17.8k tokens)",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on · esc to interrupt",
].join("\n");

test.beforeEach(() => resetStopRule());
const verdictsOf = (jobs: string[] = [], unknown: string[] = []) => async (ids: ReadonlySet<string>) => ({
  jobs: new Set([...ids].filter((id) => jobs.includes(id))), unknown: new Set([...ids].filter((id) => unknown.includes(id))),
});
function sweepWith(rows: SessionInfo[], states: SessionState[], o: { screen?: Record<string, string>; jobs?: string[]; unknown?: string[]; view?: (id: string) => { viewing: boolean; unknown: boolean; endedAtMs: number }; enabled?: boolean; policy?: Record<string, number>; nowMs?: number } = {}) {
  const reaped: string[] = [];
  const notes: Array<[string, unknown]> = [];
  const keys: Array<[string, string]> = [];
  const armed: number[] = [];
  const run = sweepSessionStopRule({
    enabled: () => o.enabled ?? true,
    loadPolicy: async () => (o.policy ?? {}) as never,
    listLive: async () => rows,
    listStates: async () => states,
    listManaged: async () => [],
    view: o.view ?? (() => NOT_VIEWING),
    jobVerdicts: verdictsOf(o.jobs, o.unknown),
    capture: async (id) => o.screen?.[id] ?? CLAUDE_DRAFT_SCREEN,
    keys: async (id, k) => { keys.push([id, k]); },
    saveNote: async (id, n) => { notes.push([id, n]); },
    reap: async (id) => { reaped.push(id); },
    sleep: async () => {},
    now: () => o.nowMs ?? NOW * 1000,
    arm: (at) => { armed.push(at); },
  });
  return run.then((r) => ({ r, reaped, notes, keys, armed }));
}
const liveDone = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => row({
  id, agentState: "idle", lastActive: NOW - 600, lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: 0, cron: 0 }, ...o,
});
const stOf = (id: string): SessionState => ({ id, owner: "a", kind: "human", claude_session_id: `c-${id}` } as SessionState);

test("S1 셀프호스트(세션 컨테이너 없음)에선 아무것도 안 끈다 — 목록조차 안 본다", async () => {
  const { r, reaped } = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { enabled: false });
  assert.equal(r.enabled, false);
  assert.deepEqual(reaped, []);
});
test("S2 완료+안 봄 3분 → 쓰다 만 글을 쪽지로 남기고 끈다(저장이 끄기보다 먼저)", async () => {
  const order: string[] = [];
  const reaped: string[] = [];
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-1")], listStates: async () => [stOf("box-a-1")],
    listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(), capture: async () => CLAUDE_DRAFT_SCREEN,
    keys: async () => {}, saveNote: async (id, n) => { order.push(`save:${id}:${(n as { draft?: string }).draft}`); },
    reap: async (id) => { order.push(`reap:${id}`); reaped.push(id); }, sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(order, ["save:box-a-1:다음엔 이걸 해 줘", "reap:box-a-1"]);
  assert.equal(r.stopped.length, 1);
  assert.equal(r.stopped[0].draft, true);
});
test("S3 질의+안 봄 60분 → 질문·선택지를 쪽지로 남기고 끈다", async () => {
  const asking = liveDone("box-a-2", { awaiting: true, agentState: "waiting", lastActive: NOW - 3700, lastReport: { phase: "waiting", at: NOW - 3700 } });
  const { reaped, notes } = await sweepWith([asking], [stOf("box-a-2")], { screen: { "box-a-2": CLAUDE_ASK_SCREEN } });
  assert.deepEqual(reaped, ["box-a-2"]);
  const note = notes[0][1] as { why: string; question: { kind: string; items: Array<{ text: string; options: Array<{ label: string }> }> } };
  assert.equal(note.why, "asking");
  assert.equal(note.question.kind, "ask");
  assert.equal(note.question.items[0].text, "가장 좋아하는 색은?");
  assert.deepEqual(note.question.items[0].options.map((x) => x.label), ["빨강", "파랑"]);
});
test("S4 하네스가 띄운 작업이 살아 있으면(⑥) 끄지 않는다 — 판정이 실패하면 그 판은 아무것도 안 끈다", async () => {
  const a = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { jobs: ["box-a-1"] });
  assert.deepEqual(a.reaped, []);
  assert.equal(a.r.kept.jobs, 1);
  resetStopRule();   // 위 판이 건 작업 보호(3분)를 걷는다 — 아래는 «판정 자체의 실패» 를 본다
  const reaped: string[] = [];
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-1")], listStates: async () => [stOf("box-a-1")],
    listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: async () => { throw new Error("ps 실패"); }, capture: async () => CLAUDE_DRAFT_SCREEN,
    keys: async () => {}, saveNote: async () => {}, reap: async (id) => { reaped.push(id); }, sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(reaped, []);
  assert.equal(r.kept["jobs-unknown"], 1);
});
test("S5 끄기 직전 화면이 «턴이 도는 중» 으로 바뀌었으면 끄지 않는다(목록→끄기 사이의 경합)", async () => {
  const { reaped, r } = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { screen: { "box-a-1": CLAUDE_TURN_SCREEN } });
  assert.deepEqual(reaped, []);
  assert.equal(r.kept["turn-now"], 1);
});
test("S6 질의로 판정했는데 끄기 직전 화면에 질문이 없으면(그새 답이 났다) 끄지 않는다 · 완료로 판정했는데 질문이 떴으면 끄지 않는다", async () => {
  const asking = liveDone("box-a-2", { awaiting: true, agentState: "waiting", lastActive: NOW - 3700 });
  const a = await sweepWith([asking], [stOf("box-a-2")], { screen: { "box-a-2": CLAUDE_DRAFT_SCREEN } });
  assert.deepEqual(a.reaped, []); assert.equal(a.r.kept.answered, 1);
  const b = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { screen: { "box-a-1": CLAUDE_ASK_SCREEN } });
  assert.deepEqual(b.reaped, []); assert.equal(b.r.kept["asking-now"], 1);
});
test("S7 보는 중·시계 남음은 안 끄고, 남은 시계 중 가장 이른 마감에 깨움을 건다", async () => {
  const soon = liveDone("box-a-3", { lastActive: NOW - 100 });       // 80초 남음
  const later = liveDone("box-a-4", { lastActive: NOW - 10 });       // 170초 남음
  const watched = liveDone("box-a-5");
  const { reaped, armed, r } = await sweepWith([soon, later, watched], [stOf("box-a-3"), stOf("box-a-4"), stOf("box-a-5")],
    { view: (id) => (id === "box-a-5" ? { viewing: true, unknown: false, endedAtMs: 0 } : NOT_VIEWING) });
  assert.deepEqual(reaped, []);
  assert.deepEqual(armed, [NOW - 100 + 180]);
  assert.equal(r.kept.viewing, 1);
  assert.equal(r.kept.clock, 2);
});
test("S8 claude 여러 질문(탭) — → 키로 넘기며 각 질문을 읽는다(Enter 는 안 누른다)", async () => {
  const tabs0 = [
    "────────────────────────────────────────",
    "←  ☐ 색  ☐ 과일  ✔ Submit  →",
    "가장 좋아하는 색은?",
    "❯ 1. 빨강",
    "  2. 파랑",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  const tabs1 = [
    "────────────────────────────────────────",
    "←  ☐ 색  ☐ 과일  ✔ Submit  →",
    "좋아하는 과일을 모두 고르세요",
    "❯ 1. [ ] 사과",
    "  2. [ ] 배",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  let shown = tabs0;
  const asking = liveDone("box-a-6", { awaiting: true, agentState: "waiting", lastActive: NOW - 4000 });
  const keys: string[] = [];
  const notes: unknown[] = [];
  await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [asking], listStates: async () => [stOf("box-a-6")],
    listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(), capture: async () => shown,
    keys: async (_id, k) => { keys.push(k); shown = tabs1; }, saveNote: async (_id, n) => { notes.push(n); },
    reap: async () => {}, sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(keys, ["Right"], "탭 둘이면 한 번만 넘긴다 · Enter 는 없다");
  const q = (notes[0] as { question: { items: Array<{ header?: string; text: string; multi?: boolean }> } }).question;
  assert.deepEqual(q.items.map((it) => [it.header, it.text, !!it.multi]), [["색", "가장 좋아하는 색은?", false], ["과일", "좋아하는 과일을 모두 고르세요", true]]);
});
test("S9 쪽지 저장이 실패해도 끈다(글이 있다고 끄기를 미루지 않는다)", async () => {
  const reaped: string[] = [];
  await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-1")], listStates: async () => [stOf("box-a-1")],
    listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(), capture: async () => CLAUDE_DRAFT_SCREEN,
    keys: async () => {}, saveNote: async () => { throw new Error("DB 다운"); }, reap: async (id) => { reaped.push(id); },
    sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(reaped, ["box-a-1"]);
});
test("S10 정책이 둘 다 0 이면 아무것도 안 끈다", async () => {
  const { reaped, r } = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { policy: { stop_done_minutes: 0, stop_asking_minutes: 0 } });
  assert.deepEqual(reaped, []);
  assert.equal(r.why, "policy-off");
});
test("S11 세션 하나를 판정하지 못했으면(프로브 실패·빈 표) 그 세션만 안 끈다 — 회수기처럼 «작업 없음» 으로 접지 않는다", async () => {
  const { reaped, r } = await sweepWith([liveDone("box-a-1"), liveDone("box-a-2")], [stOf("box-a-1"), stOf("box-a-2")], { unknown: ["box-a-1"] });
  assert.deepEqual(reaped, ["box-a-2"]);
  assert.equal(r.kept["jobs-unknown"], 1);
});
test("S12 작업이 살아 있던 세션은 3분 동안 다시 재지 않고(프로브 0) 끄지도 않는다 — 3분이 지나면 다시 잰다", async () => {
  const asked: string[][] = [];
  const reaped: string[] = [];
  const run = (nowMs: number, jobs: string[]) => sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-1")], listStates: async () => [stOf("box-a-1")],
    listManaged: async () => [], view: () => NOT_VIEWING,
    jobVerdicts: async (ids) => { asked.push([...ids]); return verdictsOf(jobs)(ids); },
    capture: async () => CLAUDE_DRAFT_SCREEN, keys: async () => {}, saveNote: async () => {}, reap: async (id) => { reaped.push(id); },
    sleep: async () => {}, now: () => nowMs, arm: () => {},
  });
  await run(NOW * 1000, ["box-a-1"]);
  const r2 = await run(NOW * 1000 + JOB_HOLD_MS - 1, []);
  assert.deepEqual(asked, [["box-a-1"]], "보호 중엔 다시 재지 않는다");
  assert.equal(r2.kept.jobs, 1);
  assert.deepEqual(reaped, []);
  await run(NOW * 1000 + JOB_HOLD_MS, []);
  assert.deepEqual(asked, [["box-a-1"], ["box-a-1"]], "3분이 지나면 다시 잰다");
  assert.deepEqual(reaped, ["box-a-1"]);
});
test("S13 한 판에 끄는 수는 상한(10)까지 — 넘친 것은 남겨 두고 곧바로 다음 판을 건다", async () => {
  const ids = Array.from({ length: MAX_STOPS_PER_SWEEP + 2 }, (_, i) => `box-a-${100 + i}`);
  const { reaped, r, armed } = await sweepWith(ids.map((id) => liveDone(id)), ids.map(stOf));
  assert.equal(reaped.length, MAX_STOPS_PER_SWEEP);
  assert.equal(r.kept.capped, 2);
  assert.ok(armed.length === 1 && armed[0] <= NOW, `곧바로 다음 판 — ${armed}`);
});
test("S14 판정 뒤 끄기 직전에 사람이 돌아왔으면(보는 중 · 모름) 끄지 않는다", async () => {
  for (const back of [{ viewing: true, unknown: false, endedAtMs: 0 }, { viewing: false, unknown: true, endedAtMs: 0 }]) {
    resetStopRule();
    let calls = 0;
    const { reaped, notes, r } = await sweepWith([liveDone("box-a-1")], [stOf("box-a-1")], { view: () => (calls++ === 0 ? NOT_VIEWING : back) });
    assert.deepEqual(reaped, [], JSON.stringify(back));
    assert.deepEqual(notes, [], "쪽지도 남기지 않는다(그 사람이 지금 보고 있다)");
    assert.equal(r.kept["viewing-now"], 1);
  }
});
test("S15 질문 탭을 못 넘겼으면(같은 질문이 다시 보인다) 같은 질문을 두 번 남기지 않는다", async () => {
  const tabs0 = [
    "────────────────────────────────────────",
    "←  ☐ 색  ☐ 과일  ✔ Submit  →",
    "가장 좋아하는 색은?",
    "❯ 1. 빨강",
    "  2. 파랑",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  const notes: unknown[] = [];
  await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-7", { awaiting: true, agentState: "waiting", lastActive: NOW - 4000 })],
    listStates: async () => [stOf("box-a-7")], listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(), capture: async () => tabs0,
    keys: async () => { /* 키가 안 먹었다 — 화면이 그대로다 */ }, saveNote: async (_id, n) => { notes.push(n); },
    reap: async () => {}, sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  const q = (notes[0] as { question: { items: unknown[] } }).question;
  assert.equal(q.items.length, 1);
});
test("S13b 후보가 많으면 프로브 앞에서 자른다(상한의 두 배까지만 프로브) — 오래 논 것부터", async () => {
  const ids = Array.from({ length: MAX_STOPS_PER_SWEEP * 2 + 5 }, (_, i) => `box-b-${100 + i}`);
  const rows = ids.map((id, i) => liveDone(id, { lastActive: NOW - 600 - i }));   // 뒤로 갈수록 더 오래 놀았다
  const asked: string[][] = [];
  const reaped: string[] = [];
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => rows, listStates: async () => ids.map(stOf),
    listManaged: async () => [], view: () => NOT_VIEWING,
    jobVerdicts: async (s) => { asked.push([...s]); return verdictsOf()(s); },
    capture: async () => CLAUDE_DRAFT_SCREEN, keys: async () => {}, saveNote: async () => {}, reap: async (id) => { reaped.push(id); },
    sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].length, MAX_STOPS_PER_SWEEP * 2, "프로브는 상한의 두 배까지만");
  assert.ok(asked[0].includes(ids[ids.length - 1]) && !asked[0].includes(ids[0]), "가장 오래 논 것부터 본다");
  assert.equal(reaped.length, MAX_STOPS_PER_SWEEP);
  assert.equal(r.kept.capped, ids.length - MAX_STOPS_PER_SWEEP);
});
test("S16 질문 탭을 넘기기 전에 사람이 돌아왔으면 → 키를 보내지 않고 끄지도 않는다", async () => {
  const tabs0 = [
    "────────────────────────────────────────",
    "←  ☐ 색  ☐ 과일  ✔ Submit  →",
    "가장 좋아하는 색은?",
    "❯ 1. 빨강",
    "  2. 파랑",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  let calls = 0;
  const keys: string[] = [];
  const reaped: string[] = [];
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => [liveDone("box-a-8", { awaiting: true, agentState: "waiting", lastActive: NOW - 4000 })],
    listStates: async () => [stOf("box-a-8")], listManaged: async () => [],
    view: () => (calls++ === 0 ? NOT_VIEWING : { viewing: true, unknown: false, endedAtMs: 0 }),
    jobVerdicts: verdictsOf(), capture: async () => tabs0, keys: async (_id, k) => { keys.push(k); }, saveNote: async () => {},
    reap: async (id) => { reaped.push(id); }, sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(keys, [], "돌아온 사람의 대화상자 탭을 움직이지 않는다");
  assert.deepEqual(reaped, []);
  assert.equal(r.kept["viewing-now"], 1);
});

// ── #4697 T7 — 옛 회수 시계와의 경계: 이 규칙이 «맡는» 세션만 옛 시계가 손을 뗀다 ───────────────────────────────────────
//  틀리면 티가 크다:
//   🔴 맡지 않는 세션(grok·opencode·셸 · 대화 id 없음 · 옛 훅)까지 «맡는다» 고 하면 — 그 세션은 아무도 안 끈다(옛 훅 세션 39시간 실측).
//   🔴 맡는 세션(보는 중 · 예약 깨움 대기)을 «안 맡는다» 고 하면 — 옛 시계가 그 세션을 240·120분에 죽인다(규칙이 상한 없이 지키는 것).
//   🔴 셀프호스트·규칙 끔(N=M=0)에서 무엇이든 «맡는다» 고 하면 — 옛 회수기가 아무것도 안 걷는다.
const decided = (f: StopFacts, v = NOT_VIEWING, p = MIN): boolean => stopRuleDecides(stopVerdict(f, v, p, NOW));
test("B1 규칙이 판정하는 상태(끈다 · 보는 중 · 모름 · 작업 · 백그라운드 · 예약 · 시계) = 맡는다", () => {
  assert.equal(decided(done()), true, "끄는 판정");
  assert.equal(decided(done(), { viewing: true, unknown: false, endedAtMs: 0 }), true, "보는 중");
  assert.equal(decided(done(), { viewing: false, unknown: true, endedAtMs: 0 }), true, "게이트웨이가 막 떴다");
  assert.equal(decided(done({ working: true })), true, "작업 중");
  assert.equal(decided(done({ background: true })), true, "백그라운드");
  assert.equal(decided(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0, wake: NOW + 600, cron: 0 } })), true, "예약 깨움");
  assert.equal(decided(done({ lastActive: NOW - 10 })), true, "시계가 가는 중");
  assert.equal(decided(done({ awaiting: true, agentState: "waiting", lastActive: NOW - 10 })), true, "질의 시계");
});
test("B2 규칙이 판정하지 않는 세션 = 옛 시계가 맡는다", () => {
  assert.equal(decided(done({ harness: "grok" })), false, "grok");
  assert.equal(decided(done({ harness: "opencode" })), false, "opencode");
  assert.equal(decided(done({ harness: "shell" })), false, "셸");
  assert.equal(decided(done({ convMapped: false })), false, "대화 id 없음");
  assert.equal(decided(done({ kind: "task" })), false, "위탁");
  assert.equal(decided(done({ runtime: "chat" })), false, "대화창 런타임");
  assert.equal(decided(done({ harness: "codex", runtime: "app-server", lastReport: null })), false, "codex app-server");
  assert.equal(decided(done({ lastReport: { phase: "idle", at: NOW - 600, bg: 0 } })), false, "옛 훅 — 예약을 모른다");
  assert.equal(decided(done({ lastReport: null })), false, "보고 없음 — 예약을 모른다");
  assert.equal(decided(done(), NOT_VIEWING, { doneMin: 0, askingMin: 60 }), false, "그 상태의 시계를 꺼 둠");
  assert.equal(decided(done({ harness: "codex", lastActive: 0, lastReport: null, created: 0 })), false, "시계 재료 없음");
  assert.equal(decided(done({ observed: false })), false, "관측 못 함(옛 회수기도 안 본다)");
  assert.equal(decided(done({ managed: true })), false, "상시 세션(옛 회수기도 안 본다)");
});

const info = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => liveDone(id, o);
const TABLE: Array<[SessionInfo, { id: string; kind?: string | null; claude_session_id?: string | null }, boolean, string]> = [
  [info("box-c-done"), stOf("box-c-done"), true, "claude 완료(대화 id·새 훅)"],
  [info("box-c-old", { lastReport: { phase: "idle", at: NOW - 600, bg: 0 } }), stOf("box-c-old"), false, "claude 옛 훅(예약 칸 없음)"],
  [info("box-c-old-view", { lastReport: { phase: "idle", at: NOW - 600, bg: 0 } }), stOf("box-c-old-view"), true, "옛 훅이어도 보는 중이면 규칙이 지킨다"],
  [info("box-c-old-busy", { lastReport: { phase: "busy", at: NOW - 60 }, harnessWorking: true }), stOf("box-c-old-busy"), true, "옛 훅이어도 작업 중이면 규칙이 지킨다"],
  [info("box-g", { harness: "grok" }), stOf("box-g"), false, "grok"],
  [info("box-o", { harness: "opencode" }), stOf("box-o"), false, "opencode"],
  [info("box-s", { harness: "shell", lastReport: undefined }), stOf("box-s"), false, "셸"],
  [info("box-nc"), { id: "box-nc", kind: "human", claude_session_id: null }, false, "대화 id 없음"],
  [info("box-t"), { id: "box-t", kind: "task", claude_session_id: "c-t" }, false, "위탁"],
  [info("box-x", { harness: "codex", runtimeRaw: "terminal", lastReport: undefined }), stOf("box-x"), true, "codex(터미널) 대화 id 있음"],
  [info("box-x-app", { harness: "codex", lastReport: undefined }), stOf("box-x-app"), false, "codex 표식 없음 = app-server(대화창 런타임)"],
  [info("box-y", { harness: "antigravity", lastReport: undefined }), stOf("box-y"), true, "agy 대화 id 있음"],
  [info("box-id-only"), { id: "box-id-only" }, false, "장부 행에 id 만 있으면(옛 회수기 시험 seam) 대화 id 없음"],
];
const VIEW_OF = (id: string) => ({ viewing: id === "box-c-old-view", unknown: false, endedAtMs: 0 });
test("B3 sessionsUnderStopRule — 표의 행마다 맡는지(매니지드 · 기본 정책)", () => {
  const got = sessionsUnderStopRule(TABLE.map((r) => r[0]), TABLE.map((r) => r[1]), new Set(), {},
    { enabled: () => true, view: VIEW_OF, now: () => NOW * 1000 });
  for (const [s, , want, why] of TABLE) assert.equal(got.has(s.id), want, why);
});
test("B4 셀프호스트(규칙이 안 돈다)면 아무것도 맡지 않는다 — 옛 회수기는 종전 그대로", () => {
  const got = sessionsUnderStopRule(TABLE.map((r) => r[0]), TABLE.map((r) => r[1]), new Set(), {},
    { enabled: () => false, view: VIEW_OF, now: () => NOW * 1000 });
  assert.equal(got.size, 0);
});
test("B5 두 분을 모두 0 으로 두면 아무것도 맡지 않는다 — 옛 시계가 모든 세션을 다시 맡는 되돌리기 손잡이", () => {
  const got = sessionsUnderStopRule(TABLE.map((r) => r[0]), TABLE.map((r) => r[1]), new Set(), { stop_done_minutes: 0, stop_asking_minutes: 0 },
    { enabled: () => true, view: VIEW_OF, now: () => NOW * 1000 });
  assert.equal(got.size, 0);
});
test("B6 한쪽만 0 이면 그 상태의 세션만 옛 시계로 — 완료(N=0)는 옛 시계, 질의(M)는 규칙", () => {
  const rows = [info("box-d"), info("box-q", { awaiting: true, agentState: "waiting", lastActive: NOW - 60 })];
  const got = sessionsUnderStopRule(rows, [stOf("box-d"), stOf("box-q")], new Set(), { stop_done_minutes: 0, stop_asking_minutes: 60 },
    { enabled: () => true, view: () => NOT_VIEWING, now: () => NOW * 1000 });
  assert.deepEqual([...got], ["box-q"]);
});

// ── #4697 T7 — 5분 틱 요약 한 줄(7일 측정의 «왜 안 껐나» 분포) ─────────────────────────────────────────────────────────
test("L1 켜진 판은 한 줄 — 스캔 수·끈 수·남긴 이유별 수·다음 마감", () => {
  const logs: Array<Record<string, unknown>> = [];
  logStopRuleTick({ enabled: true, doneMin: 3, askingMin: 60, scanned: 7, stopped: [{ id: "box-a", state: "done", idleSec: 182, draft: false, question: null }],
    kept: { "sched-unknown": 2, viewing: 1, working: 3 }, keptOldest: { viewing: { id: "box-v", idleSec: 86_400 } }, nextDueInSec: 40 }, (o) => logs.push(o));
  assert.equal(logs.length, 1);
  assert.deepEqual({ ...logs[0], tenant: undefined }, { tenant: undefined, scanned: 7, stopped: 1, kept: { "sched-unknown": 2, viewing: 1, working: 3 },
    keptOldest: { viewing: { id: "box-v", idleSec: 86_400 } }, nextDueInSec: 40 });
});
test("L2 꺼진 판(셀프호스트·정책 끔)과 다른 판이 돌던 중이라 건너뛴 판은 안 찍는다", () => {
  const logs: unknown[] = [];
  logStopRuleTick({ enabled: false, why: "self-hosted", scanned: 0, stopped: [], kept: {} }, (o) => logs.push(o));
  logStopRuleTick({ enabled: false, why: "policy-off", scanned: 0, stopped: [], kept: {} }, (o) => logs.push(o));
  logStopRuleTick({ enabled: true, why: "in-flight", scanned: 0, stopped: [], kept: { "busy-sweep": 1 } }, (o) => logs.push(o));
  assert.equal(logs.length, 0);
});
test("L3 (배선) 하우스키핑 틱의 종료 규칙 스텝이 그 판을 요약 한 줄로 남긴다", () => {
  const web = readFileSync(new URL("../../src/web.ts", import.meta.url), "utf8");
  const at = web.indexOf('step("session-stop-rule"');
  assert.ok(at >= 0, "web.ts 에 session-stop-rule 스텝이 없다 — 이름이 바뀌었나");
  const body = web.slice(at, web.indexOf("});", at)).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(body, /sweepSessionStopRule\(\)/);
  assert.match(body, /logStopRuleTick\(r\)/, "스텝이 판 결과를 요약 한 줄로 남기지 않는다");
});
test("L4 이유별로 가장 오래 논 세션을 남긴다 — 보는 중으로 하루째 · 판정 불가 · 작업 있음(마지막 활동 → 지금)", async () => {
  const rows = [
    liveDone("box-v1", { lastActive: NOW - 600 }), liveDone("box-v2", { lastActive: NOW - 86_400 }),   // 둘 다 보는 중 — 하루 논 쪽이 남는다
    liveDone("box-u", { lastActive: NOW - 7200 }), liveDone("box-j", { lastActive: NOW - 900 }),
  ];
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => rows, listStates: async () => rows.map((x) => stOf(x.id)),
    listManaged: async () => [],
    view: (id) => ({ viewing: id.startsWith("box-v"), unknown: false, endedAtMs: 0 }),
    jobVerdicts: verdictsOf(["box-j"], ["box-u"]),
    capture: async () => CLAUDE_DRAFT_SCREEN, keys: async () => {}, saveNote: async () => {}, reap: async () => {},
    sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.deepEqual(r.keptOldest?.viewing, { id: "box-v2", idleSec: 86_400 });
  assert.deepEqual(r.keptOldest?.["jobs-unknown"], { id: "box-u", idleSec: 7200 });
  assert.deepEqual(r.keptOldest?.jobs, { id: "box-j", idleSec: 900 });
});
test("L5 끄기 직전 확인에 걸려 남긴 세션(답이 남 · 상한)도 이유별로 가장 오래 논 것을 남긴다", async () => {
  //  질의로 판정했는데 화면엔 질문이 없다(낡은 질의 표식 — «answered» 로 영영 걸릴 수 있는 모양).
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}),
    listLive: async () => [liveDone("box-q", { awaiting: true, agentState: "waiting", lastActive: NOW - 9000 })],
    listStates: async () => [stOf("box-q")], listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(),
    capture: async () => CLAUDE_DRAFT_SCREEN, keys: async () => {}, saveNote: async () => {}, reap: async () => {},
    sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.equal(r.kept.answered, 1);
  assert.deepEqual(r.keptOldest?.answered, { id: "box-q", idleSec: 9000 });
});
test("L6 상한에 걸려 남긴 세션도 가장 오래 논 것을 남긴다(capped — 프로브 앞 자르기·끄기 상한 둘 다)", async () => {
  const ids = Array.from({ length: MAX_STOPS_PER_SWEEP * 2 + 2 }, (_, i) => `box-k-${100 + i}`);
  const rows = ids.map((id, i) => liveDone(id, { lastActive: NOW - 600 - i }));   // 뒤로 갈수록 더 오래 놀았다
  const r = await sweepSessionStopRule({
    enabled: () => true, loadPolicy: async () => ({}), listLive: async () => rows, listStates: async () => ids.map(stOf),
    listManaged: async () => [], view: () => NOT_VIEWING, jobVerdicts: verdictsOf(),
    capture: async () => CLAUDE_DRAFT_SCREEN, keys: async () => {}, saveNote: async () => {}, reap: async () => {},
    sleep: async () => {}, now: () => NOW * 1000, arm: () => {},
  });
  assert.equal(r.kept.capped, ids.length - MAX_STOPS_PER_SWEEP);
  //  프로브 앞 자르기는 오래 논 것부터 남기므로, 잘린(capped) 것 중 가장 오래 논 것은 «가장 덜 논 쪽» 묶음의 맨 끝이다 — 끄기 상한에 걸린 것과 견준다.
  const capIds = new Set(ids.slice(0, 2).concat(ids.slice(2, ids.length - MAX_STOPS_PER_SWEEP)));
  assert.ok(r.keptOldest?.capped && capIds.has(r.keptOldest.capped.id), JSON.stringify(r.keptOldest?.capped));
  assert.ok((r.keptOldest?.capped?.idleSec ?? 0) >= 600);
});

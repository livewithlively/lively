// #5043 — 원격 PC(멤버 노드) 하네스 종료 규칙의 판·집행 · 보관 끄기. 사양: 스크래치 spec.md 표 D·E.
//  부작용으로 단언한다: 어느 컴퓨터에 어떤 걸음을 물었나(step 로그) · 무엇을 껐나(reap 로그) · 끌 때 누구의 이름으로 보냈나.
//  틀리면 티가 크다:
//   🔴 그 PC 터미널에서 사람이 보고 있는 세션을 끄면 — 화면이 눈앞에서 «끝남» 으로 바뀐다.
//   🔴 다시 열 수 없는 세션(그 PC 에서 직접 띄워 발견된 행)을 끄면 — 대화가 라이블리에서 사라진다.
//   🔴 건너뛸 컴퓨터(오프라인·옛 번들·윈도우)에 걸음을 보내면 — 정체불명의 RPC 오류가 쌓인다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  sweepNodeStopRule, resetNodeStopRule, reapNodeSession, nodeStopEligibility, localViewersOf, jobVerdictsOf, quotaWaitOf,
  type NodeStopDeps, type NodeReapDeps,
} from "./node-stop-rule.js";
import { sweepSessionStopRule, resetStopRule, type StopRuleDeps } from "./session-stop-rule.js";
import { DEFAULT_SESSION_RECLAIM_POLICY, type SessionReclaimPolicy } from "./session-reclaim-policy.js";
import type { NodeSnapshotFacts } from "../node/registry.js";
import type { SessionInfo } from "../terminal/terminal-sessions.js";
import type { SessionState } from "./session-state.js";

const NOW = 1_800_000_000;
const STALE = 12_000;
const NOT_VIEWING = { viewing: false, unknown: false, endedAtMs: 0 };
const SCREEN = ["────────────────", "❯ ", "────────────────", "  ? for shortcuts"].join("\n");
const POLICY: SessionReclaimPolicy = { ...DEFAULT_SESSION_RECLAIM_POLICY, node_stop_enabled: true };

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: id, harness: "claude", dir: "/w", autoApprove: false, owner: "kim", owned: true, created: NOW - 7200,
  attached: false, invites: [], flags: {}, projectId: 0, agentState: "offline",
  lastActive: NOW - 3600, lastReport: { phase: "idle", at: NOW - 3600, bg: 0, wake: 0, cron: 0 }, ...o,
} as SessionInfo);
const snap = (nodeId: string, sessions: SessionInfo[], o: Partial<NodeSnapshotFacts> = {}): NodeSnapshotFacts => ({
  nodeId, online: true, stateAgeMs: 1000, declared: false, self: false, sessions, ...o,
});
const stOf = (id: string, nodeId: string, o: Partial<SessionState> = {}): SessionState =>
  ({ id, owner: "kim", kind: "human", claude_session_id: `conv-${id}`, node_id: nodeId, discovered: false, ...o } as SessionState);

interface Rig {
  steps: Array<[string, string, Record<string, unknown>]>;
  reaped: Array<[string, string, string]>;
  armed: number[];
  deps: Partial<NodeStopDeps>;
}
/** 원격 PC 판의 리그 — 판정·집행은 **진짜** sweepSessionStopRule 이 한다(쪽지·실행 상태 기록만 메모리로). */
function rig(snaps: NodeSnapshotFacts[], o: {
  rows?: Array<{ id: string; enabled: boolean; platform: string | null; stop_rule?: unknown }>;
  states?: SessionState[];
  supports?: (nodeId: string) => boolean;
  local?: Record<string, number>;
  answer?: (nodeId: string, args: Record<string, unknown>) => unknown;
  policy?: SessionReclaimPolicy;
  view?: (id: string) => { viewing: boolean; unknown: boolean; endedAtMs: number };
} = {}): Rig {
  const steps: Rig["steps"] = [];
  const reaped: Rig["reaped"] = [];
  const armed: number[] = [];
  const rows = o.rows ?? snaps.map((s) => ({ id: s.nodeId, enabled: true, platform: "darwin" }));
  const states = o.states ?? snaps.flatMap((s) => s.sessions.map((x) => stOf(x.id, s.nodeId)));
  const deps: Partial<NodeStopDeps> = {
    loadPolicy: async () => o.policy ?? POLICY,
    listNodeRows: async () => rows,
    snapshots: () => snaps,
    supports: o.supports ?? (() => true),
    step: async (nodeId, args) => {
      steps.push([nodeId, String(args.step), args]);
      if (o.answer) { const v = o.answer(nodeId, args); if (v !== undefined) return v; }
      switch (args.step) {
        case "viewers": return { local: o.local ?? {} };
        case "jobs": return { jobs: [], unknown: [] };
        case "capture": return SCREEN;
        case "quota": return null;
        default: return { ok: true };
      }
    },
    listStates: async () => states,
    listManaged: async () => [],
    view: o.view ?? (() => NOT_VIEWING),
    reap: async (nodeId, id, owner) => { reaped.push([nodeId, id, owner]); },
    sweep: (over: Partial<StopRuleDeps>) => sweepSessionStopRule({ ...over, saveNote: async () => {}, markLastRun: async () => {}, sleep: async () => {}, now: () => NOW * 1000 }),
    now: () => NOW * 1000,
    arm: (at) => { armed.push(at); },
    staleMs: STALE,
  };
  return { steps, reaped, armed, deps };
}
const stepsTo = (r: Rig, nodeId: string): string[] => r.steps.filter(([n]) => n === nodeId).map(([, s]) => s);

test.beforeEach(() => { resetNodeStopRule(); resetStopRule(); });

// ── D. 판 ───────────────────────────────────────────────────────────────────────────────────────
test("D1 노드 스냅샷이 없으면 아무것도 안 읽는다(DB·RPC 0)", async () => {
  let dbReads = 0;
  const r = rig([]);
  const out = await sweepNodeStopRule({ ...r.deps, loadPolicy: async () => { dbReads++; return POLICY; }, listNodeRows: async () => { dbReads++; return []; } });
  assert.equal(out.why, "no-nodes");
  assert.equal(dbReads, 0);
  assert.deepEqual(r.steps, []);
});
test("D2 건너뛰기 순서 — 미등록 → 꺼진 등록 → 규칙 꺼짐 → 셀프 → 세션 호스트 → 오프라인 → 낡음 → 윈도우 → 걸음 미선언 · 건너뛴 컴퓨터엔 걸음을 하나도 안 보낸다", async () => {
  const s = [sess("box-x-1")];
  const snaps = [
    snap("n-unreg", s), snap("n-disabled", s), snap("n-off", s), snap("n-self", s, { self: true }), snap("n-host", s, { declared: true }),
    snap("n-offline", s, { online: false }), snap("n-stale", s, { stateAgeMs: STALE + 1 }), snap("n-win", s), snap("n-old", s),
  ];
  const rows = [
    { id: "n-disabled", enabled: false, platform: "darwin" }, { id: "n-off", enabled: true, platform: "darwin", stop_rule: { enabled: false } },
    { id: "n-self", enabled: true, platform: "darwin" }, { id: "n-host", enabled: true, platform: "linux" }, { id: "n-offline", enabled: true, platform: "darwin" },
    { id: "n-stale", enabled: true, platform: "darwin" }, { id: "n-win", enabled: true, platform: "win32" }, { id: "n-old", enabled: true, platform: "darwin" },
  ];
  const r = rig(snaps, { rows, supports: (id) => id !== "n-old" });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(out.nodes.map((n) => [n.id, n.skip]), [
    ["n-unreg", "unregistered"], ["n-disabled", "disabled"], ["n-off", "off"], ["n-self", "self"], ["n-host", "session-host"],
    ["n-offline", "offline"], ["n-stale", "stale"], ["n-win", "platform"], ["n-old", "no-cap"],
  ]);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.reaped, []);
  //  순서 그 자체 — 앞의 이유가 뒤의 이유를 가린다(꺼진 등록이 오프라인이어도 «disabled»).
  assert.equal(nodeStopEligibility({ snap: { online: false, stateAgeMs: 0, declared: false, self: false }, row: { enabled: false, platform: null }, rule: { enabled: true }, supports: true, staleMs: STALE }), "disabled");
});
test("D3 경계 — 스냅샷 나이가 정확히 상한이면 판정한다(상한+1 은 낡음)", async () => {
  const r = rig([snap("n-a", [sess("box-a-1")], { stateAgeMs: STALE })]);
  const out = await sweepNodeStopRule(r.deps);
  assert.equal(out.nodes[0]?.skip, undefined);
  assert.deepEqual(r.reaped, [["n-a", "box-a-1", "kim"]]);
});
test("D4 직접 붙은 클라이언트를 못 가르면(걸음 실패) 그 컴퓨터는 이번 판에 통째로 건너뛴다 — 다른 컴퓨터는 그대로", async () => {
  const r = rig([snap("n-bad", [sess("box-b-1")]), snap("n-ok", [sess("box-o-1")])], {
    answer: (nodeId, a) => { if (nodeId === "n-bad" && a.step === "viewers") throw new Error("ps 실패"); return undefined; },
  });
  const out = await sweepNodeStopRule(r.deps);
  assert.equal(out.nodes.find((n) => n.id === "n-bad")?.skip, "viewers-unknown");
  assert.deepEqual(stepsTo(r, "n-bad"), ["viewers"]);
  assert.deepEqual(r.reaped, [["n-ok", "box-o-1", "kim"]]);
});
test("D5 그 PC 터미널에서 직접 붙은 세션은 보는 중 — 안 끈다 · 같은 컴퓨터의 다른 세션은 끈다", async () => {
  const r = rig([snap("n-a", [sess("box-seen"), sess("box-idle")])], { local: { "box-seen": 1 } });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, [["n-a", "box-idle", "kim"]]);
  assert.equal(out.nodes[0]?.result?.kept.viewing, 1);
});
test("D6 다시 열 수 없는 행은 끄지 않는다 — 그 PC 에서 띄워 발견된 행 · 다른 컴퓨터의 행 · 행 없음", async () => {
  const ss = [sess("box-disc"), sess("box-other"), sess("box-none"), sess("box-ok")];
  const states = [stOf("box-disc", "n-a", { discovered: true }), stOf("box-other", "n-b"), stOf("box-ok", "n-a")];
  const r = rig([snap("n-a", ss)], { states });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, [["n-a", "box-ok", "kim"]]);
  assert.equal(out.nodes[0]?.result?.kept["no-state"], 3);
});
test("D7 끌 때는 그 컴퓨터 · 그 세션 · 세션 주인 이름으로 보낸다 — 주인을 모르면 보내지 않는다(실패로 센다)", async () => {
  const r = rig([snap("n-a", [sess("box-lee", { owner: "lee" }), sess("box-anon", { owner: "" })])], {
    states: [stOf("box-lee", "n-a", { owner: "lee" }), stOf("box-anon", "n-a", { owner: "" })],
  });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, [["n-a", "box-lee", "lee"]]);
  assert.equal(out.nodes[0]?.result?.kept.failed, 1);
});
test("D8 한도 대기 걸음에는 장부 행의 대화 id 와 띄운 시각(created×1000)을 싣는다", async () => {
  const r = rig([snap("n-a", [sess("box-q", { created: NOW - 5000 })])]);
  await sweepNodeStopRule(r.deps);
  const q = r.steps.find(([, s]) => s === "quota")?.[2];
  assert.ok(q, "한도 대기를 물었다");
  assert.equal(q.id, "box-q");
  assert.equal(q.threadId, "conv-box-q");
  assert.equal(q.launchedAtMs, (NOW - 5000) * 1000);
  assert.equal(q.nowMs, NOW * 1000);
});
test("D8b 한도 대기 중이라고 답하면 끄지 않는다", async () => {
  const r = rig([snap("n-a", [sess("box-q")])], {
    answer: (_n, a) => (a.step === "quota" ? { kind: "armed", atMs: NOW * 1000 - 60_000, text: "Usage limit reached" } : undefined),
  });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, []);
  assert.equal(out.nodes[0]?.result?.kept["limit-wait"], 1);
});
test("D9 작업 판정 답의 모양이 틀리면 그 판의 후보 전부 판정 불가 — 안 끈다 · 작업이 있다고 답한 세션은 안 끈다", async () => {
  const bad = rig([snap("n-a", [sess("box-1"), sess("box-2")])], { answer: (_n, a) => (a.step === "jobs" ? { jobs: "x" } : undefined) });
  const o1 = await sweepNodeStopRule(bad.deps);
  assert.deepEqual(bad.reaped, []);
  assert.equal(o1.nodes[0]?.result?.kept["jobs-unknown"], 2);
  resetStopRule(); resetNodeStopRule();
  const busy = rig([snap("n-a", [sess("box-1"), sess("box-2")])], { answer: (_n, a) => (a.step === "jobs" ? { jobs: ["box-1", "box-zzz"], unknown: [] } : undefined) });
  await sweepNodeStopRule(busy.deps);
  assert.deepEqual(busy.reaped, [["n-a", "box-2", "kim"]]);
});
test("D10 화면 답이 글이 아니면 끄지 않는다(끄기 실패로 센다)", async () => {
  const r = rig([snap("n-a", [sess("box-1")])], { answer: (_n, a) => (a.step === "capture" ? { not: "text" } : undefined) });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, []);
  assert.equal(out.nodes[0]?.result?.kept.failed, 1);
});
test("D11 컴퓨터마다 그 컴퓨터의 값으로 판정한다 — 40분 논 세션: 완료 60분 컴퓨터는 남기고 · 기본 30분 컴퓨터는 끈다", async () => {
  const forty = (id: string) => sess(id, { lastActive: NOW - 2400, lastReport: { phase: "idle", at: NOW - 2400, bg: 0, wake: 0, cron: 0 } });
  const r = rig([snap("n-slow", [forty("box-s")]), snap("n-def", [forty("box-d")])], {
    rows: [{ id: "n-slow", enabled: true, platform: "darwin", stop_rule: { done_minutes: 60 } }, { id: "n-def", enabled: true, platform: "darwin" }],
  });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, [["n-def", "box-d", "kim"]]);
  assert.equal(out.nodes.find((n) => n.id === "n-slow")?.rule?.doneMin, 60);
});
test("D11b 워크스페이스가 꺼져 있어도 그 컴퓨터만 켜면 그 컴퓨터만 돈다(맥미니 먼저 켜고 실측)", async () => {
  const r = rig([snap("n-mini", [sess("box-m")]), snap("n-book", [sess("box-b")])], {
    policy: DEFAULT_SESSION_RECLAIM_POLICY,
    rows: [{ id: "n-mini", enabled: true, platform: "darwin", stop_rule: { enabled: true } }, { id: "n-book", enabled: true, platform: "darwin" }],
  });
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped, [["n-mini", "box-m", "kim"]]);
  assert.equal(out.nodes.find((n) => n.id === "n-book")?.skip, "off");
  assert.deepEqual(stepsTo(r, "n-book"), []);
});
test("D12 같은 판에 컴퓨터 둘 — 둘 다 판정한다(자리 이름이 컴퓨터마다 다르다)", async () => {
  const r = rig([snap("n-a", [sess("box-a")]), snap("n-b", [sess("box-b")])]);
  await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.reaped.map(([n, id]) => `${n}/${id}`).sort(), ["n-a/box-a", "n-b/box-b"]);
});
test("D13 같은 테넌트의 판이 겹치면 뒤 판은 건너뛴다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const r = rig([snap("n-a", [sess("box-a")])]);
  const first = sweepNodeStopRule({ ...r.deps, listNodeRows: async () => { await gate; return [{ id: "n-a", enabled: true, platform: "darwin" }]; } });
  const second = await sweepNodeStopRule(r.deps);
  release();
  await first;
  assert.equal(second.why, "in-flight");
});
test("D14 컴퓨터들의 다음 마감 중 가장 이른 것으로 깨움을 하나 건다", async () => {
  const at = (id: string, ago: number) => sess(id, { lastActive: NOW - ago, lastReport: { phase: "idle", at: NOW - ago, bg: 0, wake: 0, cron: 0 } });
  const r = rig([snap("n-a", [at("box-a", 600)]), snap("n-b", [at("box-b", 1200)])]);
  const out = await sweepNodeStopRule(r.deps);
  assert.deepEqual(r.armed, [NOW - 1200 + 30 * 60]);
  assert.equal(out.nextDueInSec, 30 * 60 - 1200);
});
test("D15 세션이 없는 컴퓨터엔 걸음을 안 보낸다", async () => {
  const r = rig([snap("n-a", [])]);
  const out = await sweepNodeStopRule(r.deps);
  assert.equal(out.nodes[0]?.skip, "no-sessions");
  assert.deepEqual(r.steps, []);
});

// ── D 의 답 해석(순수) ───────────────────────────────────────────────────────────────────────────
test("D16 답 해석 — 물은 세션만 받고 · 모양이 틀리면 던진다", () => {
  const asked = new Set(["box-a", "box-b"]);
  assert.deepEqual([...localViewersOf({ local: { "box-a": 2, "box-b": 0, "box-z": 1 } }, asked)], ["box-a"]);
  assert.throws(() => localViewersOf({}, asked));
  assert.throws(() => localViewersOf(null, asked));
  const j = jobVerdictsOf({ jobs: ["box-a", "box-z", 3], unknown: ["box-b"] }, asked);
  assert.deepEqual([[...j.jobs], [...j.unknown]], [["box-a"], ["box-b"]]);
  assert.throws(() => jobVerdictsOf({ jobs: [] }, asked));
  assert.equal(quotaWaitOf(null), null);
  assert.deepEqual(quotaWaitOf({ kind: "resuming", atMs: 5, text: "t", untilMs: 9 }), { kind: "resuming", atMs: 5, text: "t", untilMs: 9 });
  assert.throws(() => quotaWaitOf({ kind: "maybe", atMs: 5, text: "t" }));
  assert.throws(() => quotaWaitOf({ kind: "armed", atMs: "5", text: "t" }));
});

// ── E. 보관(끄기) ─────────────────────────────────────────────────────────────────────────────────
function reapRig(o: { gone?: Array<boolean | null>; killThrows?: boolean; seen?: boolean | undefined; wrote?: boolean } = {}) {
  const calls: string[] = [];
  const goneAnswers = [...(o.gone ?? [false])];
  const deps: Partial<NodeReapDeps> = {
    seen: async () => o.seen,
    gone: async () => { calls.push("gone"); return goneAnswers.length ? goneAnswers.shift()! : null; },
    kill: async (nodeId, id, owner) => { calls.push(`kill:${nodeId}/${id}/${owner}`); if (o.killThrows) throw new Error("kill 실패"); },
    markEnded: async (id, e) => { calls.push(`ended:${id}:${e.why}:${"seen" in e ? e.seen : "-"}`); return o.wrote ?? true; },
    revertEnded: async (id, why) => { calls.push(`revert:${id}:${why}`); return true; },
    revokeTokens: async (id) => { calls.push(`revoke:${id}`); },
    now: () => NOW * 1000,
  };
  return { calls, deps };
}
test("E1 살아 있으면 — 사유(reclaim + 봤나)를 먼저 적고 → 주인 이름으로 kill → 자격 회수", async () => {
  const r = reapRig({ gone: [false], seen: false });
  await reapNodeSession("n-a", "box-1", "kim", r.deps);
  assert.deepEqual(r.calls, ["ended:box-1:reclaim:false", "gone", "kill:n-a/box-1/kim", "revoke:box-1"]);
});
test("E2 이미 없으면 kill 은 안 보내고 사유·자격 회수는 한다", async () => {
  const r = reapRig({ gone: [true], seen: true });
  await reapNodeSession("n-a", "box-1", "kim", r.deps);
  assert.deepEqual(r.calls, ["ended:box-1:reclaim:true", "gone", "revoke:box-1"]);
});
test("E3 kill 이 실패해도 다시 물어 «없다» 면 성공이다", async () => {
  const r = reapRig({ gone: [false, true], killThrows: true });
  await reapNodeSession("n-a", "box-1", "kim", r.deps);
  assert.ok(r.calls.includes("revoke:box-1"));
  assert.ok(!r.calls.some((c) => c.startsWith("revert:")));
});
test("E4 kill 이 실패하고 여전히 있거나 모르면 던지고 적은 사유를 되돌린다(자격은 안 거둔다)", async () => {
  for (const after of [false, null]) {
    const r = reapRig({ gone: [false, after], killThrows: true });
    await assert.rejects(reapNodeSession("n-a", "box-1", "kim", r.deps));
    assert.ok(r.calls.includes("revert:box-1:reclaim"), String(after));
    assert.ok(!r.calls.includes("revoke:box-1"));
  }
  const notWritten = reapRig({ gone: [false, false], killThrows: true, wrote: false });
  await assert.rejects(reapNodeSession("n-a", "box-1", "kim", notWritten.deps));
  assert.ok(!notWritten.calls.some((c) => c.startsWith("revert:")), "적지 못했으면 되돌릴 것도 없다");
});
test("E5 봤나를 못 물으면 사유에 seen 칸이 없다", async () => {
  const r = reapRig({ gone: [true], seen: undefined });
  await reapNodeSession("n-a", "box-1", "kim", r.deps);
  assert.equal(r.calls[0], "ended:box-1:reclaim:-");
});

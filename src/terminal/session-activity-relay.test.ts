// 하네스 활동 보고를 그 세션의 호스트에 맡기기 — `reportSessionActivity` (#2600 T2 d6 3판).
//
//  ── 무엇을 지키나 ──
//  옮기면서 틀리기 쉬운 곳은 셋이다. ① 맡겼는데 실패한 보고를 **잃는 것**(폴백이 없으면 그 세션의 활동 시각이 안 올라
//   유휴 회수기가 일하는 세션을 걷는다) ② DB 미러(`last_busy`)를 **호스트에 맡긴 채 잊는 것**(호스트엔 DB 가 없다)
//   ③ 하트비트마다 활동 시각을 올리는 것(방치된 세션이 영원히 «방금 작업함» — `isActivityProgress` 머리말).
//  값만 재면 우연히 통과하므로 «누구를 몇 번 불렀나» 를 호출 기록으로 잰다.
//  엣지 표는 스크래치패드 `d6/spec-active-relay.md` 의 B1~B8.
import assert from "node:assert/strict";
import test from "node:test";
import { relayedChange, reportSessionActivity, type ActivityReportDeps } from "./session-activity-relay.js";

const HOST = "sesshost-acme-i-0abc";
const NOW = 1_789_000_000;

function harness(o: {
  host?: string | null;
  rpc?: (host: string, args: { id: string; state: unknown }) => Promise<unknown>;
  localChange?: { prev: string | null; phase: string; at: number } | null;
  touchThrows?: boolean;
} = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: ActivityReportDeps = {
    hostFor: (id) => { calls.push(["hostFor", id]); return o.host === undefined ? HOST : o.host; },
    rpc: async (host, args) => { calls.push(["rpc", host, args]); return o.rpc ? o.rpc(host, args) : { ok: true, change: null }; },
    local: async (id, phase, bg) => { calls.push(bg === undefined || bg === null ? ["local", id, phase] : ["local", id, phase, bg]); return (o.localChange ?? null) as never; },
    touch: async (id, sec) => { calls.push(["touch", id, sec]); if (o.touchThrows) throw new Error("db down"); },
    nowSec: () => NOW,
    warn: (_o, msg) => { calls.push(["warn", msg]); },
  };
  const count = (k: string) => calls.filter((c) => c[0] === k).length;
  return { deps, calls, count };
}

test("B1 맡길 호스트가 없으면 게이트웨이가 직접 새기고, 호스트는 부르지 않는다", async () => {
  const h = harness({ host: null, localChange: { prev: "idle", phase: "busy", at: NOW } });
  const r = await reportSessionActivity("box-a", "busy", h.deps);
  assert.deepEqual(r, { prev: "idle", phase: "busy", at: NOW });
  assert.equal(h.count("local"), 1);
  assert.equal(h.count("rpc"), 0, "호스트가 없는데 호스트에 보냈다");
  assert.equal(h.count("touch"), 0, "종전 경로의 DB 미러는 markSessionActive 가 한다 — 여기서 두 번 쓰지 않는다");
});

test("B2 ★ 호스트가 있으면 호스트에 맡기고 게이트웨이 tmux 는 안 친다 — 전이·DB 미러는 게이트웨이가", async () => {
  const change = { prev: "busy", phase: "idle", at: NOW - 1 };
  const h = harness({ rpc: async () => ({ ok: true, change }) });
  const r = await reportSessionActivity("box-a", "idle", h.deps);
  assert.deepEqual(r, change);
  assert.deepEqual(h.calls.filter((c) => c[0] === "rpc"), [["rpc", HOST, { id: "box-a", state: "idle" }]]);
  assert.equal(h.count("local"), 0, "호스트에 맡겼는데 게이트웨이도 tmux 를 쳤다");
  assert.deepEqual(h.calls.filter((c) => c[0] === "touch"), [["touch", "box-a", NOW]], "busy→idle 은 진행이다 — DB 미러가 빠졌다");
});

test("B3 ★ 같은 단계 하트비트(idle→idle)는 활동 시각을 올리지 않는다", async () => {
  const h = harness({ rpc: async () => ({ ok: true, change: null }) });
  assert.equal(await reportSessionActivity("box-a", "idle", h.deps), null);
  assert.equal(h.count("touch"), 0, "하트비트가 last_busy 를 올렸다 — 방치된 세션이 영원히 «방금 작업함» 이 된다");
});

test("B4 busy 재보고는 전이가 없어도 진행이다", async () => {
  const h = harness({ rpc: async () => ({ ok: true, change: null }) });
  assert.equal(await reportSessionActivity("box-a", "busy", h.deps), null);
  assert.equal(h.count("touch"), 1);
});

test("B5 단계 없는 구 훅 보고도 맡기고, 활동 시각은 올린다(종전 동작)", async () => {
  const h = harness();
  assert.equal(await reportSessionActivity("box-a", undefined, h.deps), null);
  assert.deepEqual(h.calls.filter((c) => c[0] === "rpc"), [["rpc", HOST, { id: "box-a", state: undefined }]]);
  assert.equal(h.count("touch"), 1);
});

test("B6 ★★ 맡기기가 실패하면 보고를 잃지 않고 게이트웨이가 직접 새긴다", async () => {
  const h = harness({ rpc: async () => { throw new Error("node-rpc-timeout"); }, localChange: { prev: null, phase: "busy", at: NOW } });
  const r = await reportSessionActivity("box-a", "busy", h.deps);
  assert.deepEqual(r, { prev: null, phase: "busy", at: NOW });
  assert.equal(h.count("local"), 1, "실패한 보고가 사라졌다 — 유휴 회수기가 일하는 세션을 걷을 수 있다");
  assert.equal(h.count("warn"), 1, "폴백이 조용하면 호스트가 계속 실패해도 아무도 모른다");
  assert.equal(h.count("touch"), 0, "폴백의 DB 미러는 markSessionActive 가 한다 — 두 번 쓰지 않는다");
});

test("B7 호스트 응답 모양이 틀리면 전이가 없는 것으로 본다", async () => {
  const noChange = harness({ rpc: async () => ({ ok: true }) });
  assert.equal(await reportSessionActivity("box-a", "idle", noChange.deps), null);
  assert.equal(noChange.count("touch"), 0);
  for (const bad of ["busy", { change: "busy" }, { change: { phase: "busy" } }, { change: { prev: 3, phase: "busy", at: NOW } }, null]) {
    assert.equal(relayedChange(bad), null, `모양이 틀린 응답을 전이로 읽었다: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(relayedChange({ change: { prev: null, phase: "waiting", at: NOW } }), { prev: null, phase: "waiting", at: NOW });
});

test("B8 DB 미러가 실패해도 보고는 성공이고 전이는 그대로다(비치명)", async () => {
  const change = { prev: "idle", phase: "busy", at: NOW };
  const h = harness({ rpc: async () => ({ ok: true, change }), touchThrows: true });
  assert.deepEqual(await reportSessionActivity("box-a", "busy", h.deps), change);
  assert.equal(h.count("touch"), 1);
});

//  #4588 — 턴 끝(idle)의 «열린 백그라운드 작업 수» 가 어느 길로 가든 tmux(@box_state)까지 닿는다. 빠지면 그 세션의 점이 화면의
//   «still running» 만 믿고 몇 시간씩 «작업 중» 으로 깜빡인다(phase.backgroundHolds). 없을 땐 키를 안 싣는다(구 노드 무회귀).
test("B9 ★ bg 는 호스트에도 · 폴백 직접 새기기에도 · 호스트 없는 경로에도 실린다 — 없으면 키가 없다", async () => {
  const h1 = harness({ rpc: async () => ({ ok: true, change: null }) });
  await reportSessionActivity("box-a", "idle", h1.deps, 0);
  assert.deepEqual(h1.calls.filter((c) => c[0] === "rpc"), [["rpc", HOST, { id: "box-a", state: "idle", bg: 0 }]], "호스트에 bg=0 이 안 갔다");
  const h2 = harness({ rpc: async () => { throw new Error("host down"); } });
  await reportSessionActivity("box-a", "idle", h2.deps, 2);
  assert.deepEqual(h2.calls.filter((c) => c[0] === "local"), [["local", "box-a", "idle", 2]], "폴백이 bg 를 잃었다");
  const h3 = harness({ host: null });
  await reportSessionActivity("box-a", "idle", h3.deps, 0);
  assert.deepEqual(h3.calls.filter((c) => c[0] === "local"), [["local", "box-a", "idle", 0]], "호스트 없는 경로가 bg 를 잃었다");
  const h4 = harness({ rpc: async () => ({ ok: true, change: null }) });
  await reportSessionActivity("box-a", "idle", h4.deps);
  assert.deepEqual(h4.calls.filter((c) => c[0] === "rpc"), [["rpc", HOST, { id: "box-a", state: "idle" }]], "모르는 bg 를 실었다");
});

//  배선 — 라우트·호스트 op 는 tmux·DB 를 직접 부르는 자리라 소스 자리를 못박는다(screen-run.test W1 과 같은 방식).
test("B10 /active 는 idle 의 bg 만 받아 넘기고, 호스트 op 는 그걸 @box_state 에 새긴다", async () => {
  const { readFileSync } = await import("node:fs");
  const here = new URL(".", import.meta.url).pathname.replace(/\/dist\//, "/src/");
  const routes = readFileSync(`${here}routes.ts`, "utf8");
  assert.match(routes, /const bg = phase === "idle" && isBgCount\(rawBg\) \? rawBg : null;/);
  assert.match(routes, /reportSessionActivity\(id, phase, \{\}, bg\)/, "박스 세션 경로");
  assert.match(routes, /nodeRpc\(ns\.node\.id, "markActive", bg === null \? \{ id, state: phase \} : \{ id, state: phase, bg \}\)/, "노드 세션 경로");
  const ops = readFileSync(`${here}session-ops.ts`, "utf8");
  assert.match(ops, /markSessionActive\(String\(args\.id\), isReportedPhase\(st\) \? st : undefined, undefined, isBgCount\(args\.bg\) \? args\.bg : null\)/);
  const phase = readFileSync(`${here}phase.ts`, "utf8");
  assert.match(phase, /"@box_state", formatReportedPhase\(phase, nowSec, bg\)\]/, "bg 없는 idle 은 bg 없이 새긴다(직전 값을 잇지 않는다)");
});

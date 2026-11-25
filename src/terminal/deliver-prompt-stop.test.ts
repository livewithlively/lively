// #5620 — 멈춘 세션에 보낸 말을 큐에 묻지 않는다(deliver-prompt.ts promptStop 머리말).
//  신고(2026-11-19): «재시동 걸 때 치는 말을 무시해서 두 번 쳐야 해». 종전엔 멈춘 세션에 온 말을 조용히 큐에 넣었고(queued:true),
//  아무도 그 세션을 되살리지 않아 말이 묻혔다. 행 이름의 번호는 사양 엣지 표(P·F·E)다.
import assert from "node:assert/strict";
import test from "node:test";
import { promptStop, promptStopError, stoppedAfterNodeFailure, type PromptStopDeps } from "./deliver-prompt.js";

type Row = Awaited<ReturnType<PromptStopDeps["state"]>>;

function deps(o: {
  row?: Row | Error;
  pc?: string;
  nodeGone?: boolean | null | Error;
  centralGone?: boolean | null | Error;
}): { d: PromptStopDeps; asked: string[] } {
  const asked: string[] = [];
  const val = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    asked,
    d: {
      state: async (id) => { asked.push(`state:${id}`); return val(o.row as Row | Error); },
      memberPcNode: (raw) => { asked.push(`pc:${raw ?? ""}`); return o.pc ?? ""; },
      nodeGone: async (n, id) => { asked.push(`node:${n}:${id}`); return val(o.nodeGone ?? null); },
      centralGone: async (id) => { asked.push(`central:${id}`); return val(o.centralGone ?? null); },
    },
  };
}
const ME = "wonjoon";
//  기본 행은 «끝난 사유가 적힌 판»(끄는 자리가 끄기 전에 적는다) — 중앙 판정은 이 판만 tmux 에 묻는다(P12).
const mine = (x: Partial<NonNullable<Row>> = {}): Row => ({ owner: ME, node_id: null, superseded_by: null, discovered: false, root_key: "shared", end_note: { why: "stop" }, ...x });
const STOPPED = (canRevive: boolean, moved = false) => ({ verdict: "stopped", canRevive, moved });

test("배선 — 시험 재료가 실제로 불린다(관측 장치가 살아 있다)", async () => {
  const h = deps({ row: mine(), centralGone: true });
  await promptStop("s1", ME, "", h.d);
  assert.deepEqual(h.asked, ["state:s1", "pc:", "central:s1"]);
});

test("P1 desired 행이 없으면 종전대로 넣는다 — 아무에게도 묻지 않는다", async () => {
  const h = deps({ row: undefined });
  assert.deepEqual(await promptStop("s1", ME, "", h.d), { verdict: "deliver" });
  assert.deepEqual(h.asked, ["state:s1"]);
});

test("P2 이미 다른 세션으로 이어진 세션 — 주인이면 되살리기(이어진 곳으로 옮겨 간다), 남이면 못 한다", async () => {
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine({ superseded_by: "s2" }) }).d), STOPPED(true, true));
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine({ superseded_by: "s2", owner: "other" }) }).d), STOPPED(false, true));
});

test("P3 스냅샷 좌표가 있으면 그대로 넣는다 — 평소 길에 그 컴퓨터 왕복을 더하지 않는다", async () => {
  const h = deps({ row: mine({ node_id: "pc-1" }), pc: "pc-1", nodeGone: true });
  assert.deepEqual(await promptStop("s1", ME, "pc-1", h.d), { verdict: "deliver" });
  assert.ok(!h.asked.some((a) => a.startsWith("node:") || a.startsWith("central:")), h.asked.join(","));
});

test("★ P4 멤버 PC 세션이 스냅샷에서 빠졌고 그 컴퓨터가 «끝났다» 고 답하면 stopped(되살리기)", async () => {
  const h = deps({ row: mine({ node_id: "pc-1" }), pc: "pc-1", nodeGone: true });
  assert.deepEqual(await promptStop("s1", ME, "", h.d), STOPPED(true));
  assert.ok(h.asked.includes("node:pc-1:s1"), "그 컴퓨터에 직접 물었다");
  assert.ok(!h.asked.some((a) => a.startsWith("central:")), "게이트웨이 tmux 에 묻지 않았다(그 세션은 거기 없다)");
});

test("P5·P6 멤버 PC 세션인데 «끝남» 확답이 없으면 unreachable — 게이트웨이 큐는 그 컴퓨터에 닿지 않는다", async () => {
  for (const g of [false, null, new Error("node-offline")]) {
    assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine({ node_id: "pc-1" }), pc: "pc-1", nodeGone: g }).d), { verdict: "unreachable" }, String(g));
  }
});

test("★ P7 중앙 세션의 tmux 가 «없다» 고 확답하면 stopped — 주인만 되살린다", async () => {
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine(), centralGone: true }).d), STOPPED(true));
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine({ owner: "other" }), centralGone: true }).d), STOPPED(false));
});

test("P8 중앙 세션이 살아 있거나 모르면 종전대로 넣는다(모르면 죽음으로 접지 않는다 #835)", async () => {
  for (const g of [false, null, new Error("relay timeout")]) {
    assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine(), centralGone: g }).d), { verdict: "deliver" }, String(g));
  }
});

test("P9 그 컴퓨터에서 직접 만든 세션(좌표 미상)은 멈췄어도 되살리라고 하지 않는다(#2022)", async () => {
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: mine({ node_id: "pc-1", discovered: true, root_key: null }), pc: "pc-1", nodeGone: true }).d), STOPPED(false));
});

test("P10 desired 행을 못 읽으면 종전대로 넣는다", async () => {
  assert.deepEqual(await promptStop("s1", ME, "", deps({ row: new Error("db down"), centralGone: true }).d), { verdict: "deliver" });
});

test("★ P12 끝난 사유가 없는 중앙 판(살아 있는 세션의 평소 말)은 tmux 에 묻지 않고 넣는다 — 매니지드 중계 왕복을 더하지 않는다", async () => {
  for (const end_note of [null, { v: 1 } as { why?: string }]) {
    const h = deps({ row: mine({ end_note }), centralGone: true });
    assert.deepEqual(await promptStop("s1", ME, "", h.d), { verdict: "deliver" }, JSON.stringify(end_note));
    assert.ok(!h.asked.some((a) => a.startsWith("central:")), h.asked.join(","));
  }
});

test("P11 행의 좌표가 셀프 노드·세션 호스트(멤버 PC 아님 → 빈 값)면 중앙 길로 판정한다", async () => {
  const h = deps({ row: mine({ node_id: "sesshost-1" }), pc: "", centralGone: true, nodeGone: false });
  assert.deepEqual(await promptStop("s1", ME, "", h.d), STOPPED(true));
  assert.ok(!h.asked.some((a) => a.startsWith("node:")), h.asked.join(","));
});

test("F1·F2 스냅샷 좌표로 넣다 실패 — 그 컴퓨터가 «끝났다» 고 할 때만 stopped, 아니면 원래 오류 그대로(null)", async () => {
  assert.deepEqual(await stoppedAfterNodeFailure("s1", ME, "pc-1", deps({ row: mine({ node_id: "pc-1" }), nodeGone: true }).d), STOPPED(true));
  for (const g of [false, null, new Error("x")]) {
    assert.equal(await stoppedAfterNodeFailure("s1", ME, "pc-1", deps({ row: mine({ node_id: "pc-1" }), nodeGone: g }).d), null, String(g));
  }
});

test("E1 409 본문에 화면이 갈라 읽을 값을 싣는다(문구를 파싱하지 않게)", () => {
  const a = promptStopError({ verdict: "stopped", canRevive: true, moved: false });
  assert.equal(a.status, 409);
  assert.deepEqual(a.body, { stopped: true, canRevive: true, moved: false });
  assert.deepEqual(promptStopError({ verdict: "stopped", canRevive: false, moved: false }).body, { stopped: true, canRevive: false, moved: false });
  const u = promptStopError({ verdict: "unreachable" });
  assert.equal(u.status, 409);
  assert.deepEqual(u.body, { stopped: false });
});

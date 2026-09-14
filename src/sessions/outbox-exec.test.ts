// 아웃박스 실행 자리 — 한 걸음(보기·누르기·치기)을 세션 호스트에 맡길까 게이트웨이가 할까 (#2600 T2 d6 · #3773 PR2).
//
//  ── 무엇을 지키나 ──
//  옮기면서 틀리기 쉬운 곳은 셋이다. ① «쳤을 수 있다» 를 «안 쳤다» 로 읽고 다시 치는 것(같은 지시가 두 번 간다)
//   ② 자가호스팅(좌표 없음·소유 안 넘어감)에서 기다리거나 호스트를 찾는 것(모든 첫 지시가 늦어진다)
//   ③ 신뢰 대화상자의 내리기와 Enter 를 따로 보내 내리기 실패 뒤에도 Enter 가 가는 것(«No, exit» 가 눌린다).
//  값만 재면 우연히 통과하므로 «누구를 몇 번 불렀나» 를 호출 기록으로 잰다. 배달자 쪽(`session-outbox` 의 waitReady·sendReadyRow)은
//   가짜 실행 자리를 끼워 **그 함수 그대로** 부른다 — 배선이 옛 모양(게이트웨이 tmux 직행)이면 여기서 빨간불이 난다.
//  엣지 표는 스크래치패드 `d6/pr2/spec.md` 의 E1~E15 · F · K · N · D · H.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { acceptTrustDialog, trustAcceptDowns, tailOf } from "../terminal/session-first-prompt.js";
import { OUTBOX_KEYS_MAX_DOWN } from "../terminal/outbox-host-step.js";
import type { SessionHostTargetWhy } from "../node/self-node.js";
import * as registry from "../node/registry.js";
import {
  decodeStep, typeNext, hostWait, outboxExecFor, LOCAL_STEPS, HOST_WAIT_CAP_MS, HOST_WAIT_POLL_MS,
  type OutboxExecDeps, type PaneSeen, type TypeResult,
} from "./outbox-exec.js";
import * as outbox from "./session-outbox.js";

//  배달자·registry 는 **네임스페이스로** 받는다 — 이름을 정적으로 묶으면 배선이 옛 모양(내보내기 없음)일 때 파일 전체가 링크 오류로 죽어
//   어느 행이 배선에 걸렸는지 안 보인다. 이렇게 두면 옛 배선에서는 그 배선을 쓰는 행만 빨간불이다(fail-first).
const { waitReady, sendReadyRow, READY_WINDOW_MS, READY_POLL_MS, ECHO_WINDOW_MS, STALE_SENDING } = outbox;
const { NODE_RPC_TIMEOUT_MS, sessionHostFor, sessionHostTargetFor } = registry;

const ID = "box-a";
const HOST = "sesshost-acme-i-0abc";

// Claude Code 입력창 — 판정이 «떴다» 로 읽는 표식(`? for shortcuts`)이 있다.
const INPUT = ["╭────────────────╮", "│ >              │", "╰────────────────╯", "  ? for shortcuts"].join("\n");
// 현행(2.1.263) 신뢰 대화상자 — 커서가 «No, exit».
const TRUST = [
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "Enter to confirm · Esc to cancel",
].join("\n");
// 선택지를 색으로만 그린 판 — 커서·Yes 를 못 읽는다.
const UNREADABLE = "Quick safety check: Is this a project you created or one you trust?\n(options rendered with colour only)";
/** Yes 가 커서에서 n 칸 아래인 대화상자. */
const trustDowns = (n: number): string => [
  "Quick safety check: Is this a project you created or one you trust?",
  "❯ No, exit",
  ...Array.from({ length: n - 1 }, (_, i) => `  No, option ${i + 2}`),
  "  Yes, I trust this folder",
].join("\n");

type HostPick = { host: string | null; why: SessionHostTargetWhy } | null;
type Call = [string, ...unknown[]];

/** 가짜 재료 — 고르기·호스트 RPC·소유 판정·게이트웨이 칸·대기를 한 줄 기록으로 남긴다. 시계는 sleep 이 민다. */
function rig(o: {
  picks?: HostPick[];                                            // 차례로 돌려준다(끝나면 마지막 값을 반복)
  defers?: boolean;
  host?: (args: Record<string, unknown>, n: number) => unknown;   // 호스트 답 — 던지면 RPC 오류 · n = 그 걸음의 몇 번째 호출
  localPane?: PaneSeen;
  localType?: TypeResult;
} = {}) {
  const calls: Call[] = [];
  const clock = { t: 0 };
  const nth = new Map<string, number>();
  let picked = 0;
  const deps: OutboxExecDeps = {
    hostPick: (id, op) => {
      calls.push(["pick", id, op]);
      const list = o.picks ?? [{ host: HOST, why: "ok" }];
      return list[Math.min(picked++, list.length - 1)] ?? null;
    },
    rpc: async (host, op, args) => {
      calls.push(["rpc", host, op, args]);
      const step = String(args.step);
      const n = (nth.get(step) ?? 0) + 1;
      nth.set(step, n);
      if (o.host) return o.host(args, n);
      return step === "peek" ? { ok: true, pane: INPUT, paneCmd: "claude" } : step === "keys" ? { ok: true } : { ok: true, typed: "full" };
    },
    defersHere: () => { calls.push(["defers"]); return o.defers ?? false; },
    local: {
      peek: async (id) => { calls.push(["local.peek", id]); return o.localPane ?? { ok: true, pane: INPUT, paneCmd: "claude" }; },
      keys: {
        down: async (id, times) => { calls.push(["local.down", id, times]); },
        enter: async (id) => { calls.push(["local.enter", id]); },
      },
      type: async (id, text) => { calls.push(["local.type", id, text]); return o.localType ?? { next: "echo" }; },
    },
    warn: (_o, msg) => { calls.push(["warn", msg]); },
    sleep: async (ms) => { calls.push(["sleep", ms]); clock.t += ms; },
    now: () => clock.t,
  };
  const count = (kind: string): number => calls.filter((c) => c[0] === kind).length;
  /** 호스트에 보낸 그 걸음의 인자들 */
  const sentTo = (step: string): unknown[] => calls.filter((c) => c[0] === "rpc" && (c[3] as { step?: unknown }).step === step).map((c) => c[3]);
  /** 게이트웨이 칸(= 게이트웨이 tmux)에서 일어난 일 */
  const onGateway = (): Call[] => calls.filter((c) => c[0].startsWith("local."));
  return { deps, calls, clock, count, sentTo, onGateway, waitClock: { now: deps.now, sleep: deps.sleep } };
}
const rpcErr = (sent?: boolean): Error =>
  sent === undefined ? new Error("표식 없는 오류") : Object.assign(new Error(sent ? "node-rpc-timeout" : "node-offline"), { sent });
/** 에코 확인 가짜 — 차례로 답하고(끝나면 마지막 답) 무엇을 찾았는지 남긴다. */
const echoes = (answers: Array<"confirmed" | "timeout" | "unreadable">) => {
  const seen: string[] = [];
  return { seen, echo: async (line: string) => { seen.push(line); return answers[Math.min(seen.length - 1, answers.length - 1)]!; } };
};

// ── 순수 판정 ────────────────────────────────────────────────────────────────────

test("E3·F1 hostWait — ok 는 맡긴다 · 좌표 없음∧소유 넘어감은 cap 전까지만 기다린다(경계: cap 과 같으면 게이트웨이) · 나머지 사유는 기다리지 않는다", () => {
  const at = (why: SessionHostTargetWhy, defers: boolean, waitedMs: number) => hostWait({ why, defers, waitedMs, capMs: HOST_WAIT_CAP_MS });
  assert.equal(at("ok", false, 0), "go");
  assert.equal(at("no-coordinate", true, 0), "wait");
  assert.equal(at("no-coordinate", true, HOST_WAIT_CAP_MS - 1), "wait");
  assert.equal(at("no-coordinate", true, HOST_WAIT_CAP_MS), "local", "cap 에 닿았는데 더 기다린다");
  assert.equal(at("no-coordinate", false, 0), "local", "자가호스팅(소유 안 넘어감)에서 기다리면 모든 첫 지시가 늦어진다");
  for (const why of ["not-host", "unqualified", "absent", "unsupported"] as const) assert.equal(at(why, true, 0), "local", `${why} 에서 기다린다`);
});

test("N2·N3·N4 decodeStep — 모양이 맞는 답만 읽는다 · 거절은 unsupported · 틀리거나 {ok:true} 뿐이면(누르기 빼고) malformed", () => {
  const decode = decodeStep as (step: "peek" | "keys" | "type", r: unknown) => unknown;
  assert.deepEqual(decode("peek", { ok: true, pane: "", paneCmd: "" }), { ok: true, pane: "", paneCmd: "" });
  assert.deepEqual(decode("peek", { ok: false, reach: "gone" }), { ok: false, reach: "gone" });
  assert.deepEqual(decode("keys", { ok: true }), { ok: true });
  assert.deepEqual(decode("keys", { ok: false, at: "check", reach: "unknown" }), { ok: false, at: "check", reach: "unknown" });
  assert.deepEqual(decode("keys", { ok: false, at: "down" }), { ok: false, at: "down" });
  assert.deepEqual(decode("type", { ok: true, typed: "full" }), { ok: true, typed: "full" });
  assert.deepEqual(decode("type", { ok: false, typed: "none", reach: "gone" }), { ok: false, typed: "none", reach: "gone" });
  assert.deepEqual(decode("type", { ok: false, typed: "partial", at: "enter" }), { ok: false, typed: "partial", at: "enter" });
  for (const step of ["peek", "keys", "type"] as const) {
    assert.deepEqual(decode(step, { ok: false, unsupported: true, reason: "모르는 걸음" }), { fault: "unsupported" }, step);
    for (const bad of [null, undefined, "ok", 1, [], {}, { ok: "true" }]) {
      assert.deepEqual(decode(step, bad), { fault: "malformed" }, `${step} ${JSON.stringify(bad)}`);
    }
  }
  assert.deepEqual(decode("peek", { ok: true }), { fault: "malformed" }, "화면 없는 성공을 읽었다 — 빈 화면으로 읽으면 claude 는 창이 끝날 때까지 기다린다");
  assert.deepEqual(decode("peek", { ok: true, pane: "x" }), { fault: "malformed" });
  assert.deepEqual(decode("type", { ok: true }), { fault: "malformed" }, "얼마나 쳤는지 없는 성공을 full 로 읽었다");
  assert.deepEqual(decode("type", { ok: false, typed: "none" }), { fault: "malformed" }, "닿았나 없는 none 을 읽었다");
  assert.deepEqual(decode("keys", { ok: false, at: "check" }), { fault: "malformed" });
});

test("F4c·F4d·F6·F7 typeNext — 다시 칠 수 있는 것은 «안 갔다» 가 확실할 때뿐이다(RPC sent=false · 호스트 거절)", () => {
  assert.equal(typeNext({ ok: true, typed: "full" }), "echo");
  assert.equal(typeNext({ ok: false, typed: "none", reach: "gone" }), "stall:gone");
  assert.equal(typeNext({ ok: false, typed: "none", reach: "unknown" }), "stall:unknown");
  assert.equal(typeNext({ ok: false, typed: "partial", at: "text" }), "fail:text");
  assert.equal(typeNext({ ok: false, typed: "partial", at: "enter" }), "fail:enter");
  assert.equal(typeNext({ fault: "unsupported" }), "local");
  assert.equal(typeNext({ fault: "malformed" }), "echo-only", "모양 틀린 답은 무엇을 했는지 모른다 — 다시 치면 두 번 갈 수 있다");
  assert.equal(typeNext({ rpcError: rpcErr(false) }), "local");
  for (const e of [rpcErr(true), rpcErr(), "node-offline", null]) {
    assert.equal(typeNext({ rpcError: e }), "echo-only", `«쳤을 수 있는» 오류를 다시 쳐도 된다고 읽었다: ${String(e)}`);
  }
});

// ── 호스트 고르기 ────────────────────────────────────────────────────────────────

test("★ E1 좌표 없음 ∧ 소유 안 넘어감(자가호스팅) — 기다리지 않고 게이트웨이 · 소유 판정 1회 · 준비 판정이 게이트웨이 화면으로 본다", async () => {
  const r = rig({ picks: [{ host: null, why: "no-coordinate" }], defers: false });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(exec.host, null);
  assert.equal(r.count("sleep"), 0, "자가호스팅에서 좌표를 기다렸다 — 모든 첫 지시가 늦어진다");
  assert.equal(r.count("defers"), 1);
  assert.deepEqual(r.calls.filter((c) => c[0] === "pick"), [["pick", ID, "outboxStep"]], "호스트를 outboxStep 으로 한 번 고르지 않았다");
  assert.equal(await waitReady(ID, "claude", false, exec, r.waitClock), "ready");
  assert.deepEqual(r.onGateway(), [["local.peek", ID]], "준비 판정이 실행 자리의 보기를 안 썼다");
  assert.equal(r.count("rpc"), 0);
});

test("E2 좌표 없음 ∧ 소유 넘어감 — 3초 뒤 좌표가 생기면 그동안 tmux 0(게이트웨이 칸·RPC 0) · 소유 판정 1회 · 그 뒤 호스트가 본다", async () => {
  const waits = 3_000 / HOST_WAIT_POLL_MS;
  const blank = Array.from({ length: waits }, (): HostPick => ({ host: null, why: "no-coordinate" }));
  const r = rig({ picks: [...blank, { host: HOST, why: "ok" }], defers: true });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(exec.host, HOST);
  assert.equal(exec.waitedMs, 3_000);
  assert.equal(r.count("sleep"), waits);
  assert.equal(r.count("defers"), 1, "소유 판정을 폴마다 물었다 — 판정 계수 창이 아웃박스 기록으로 찬다");
  assert.deepEqual(r.onGateway(), [], "좌표를 기다리는 동안 게이트웨이 tmux 를 쳤다");
  assert.equal(r.count("rpc"), 0);
  assert.equal(await waitReady(ID, "claude", false, exec, r.waitClock), "ready");
  assert.deepEqual(r.sentTo("peek"), [{ step: "peek", id: ID }]);
  assert.deepEqual(r.onGateway(), []);
});

test("E3 경계 — 좌표를 cap 만큼 기다려도 안 생기면 게이트웨이(cap 과 같은 순간에 멈춘다)", async () => {
  const r = rig({ picks: [{ host: null, why: "no-coordinate" }], defers: true });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(exec.host, null);
  assert.equal(exec.waitedMs, HOST_WAIT_CAP_MS);
  assert.equal(r.count("sleep"), HOST_WAIT_CAP_MS / HOST_WAIT_POLL_MS, "cap 에 닿고도 더 기다렸거나 덜 기다렸다");
  assert.equal(r.count("defers"), 1);
});

test("E4·F1 unsupported(롤 중 구 호스트)·not-host(멤버 PC 좌표)·unqualified·absent — 기다리지 않고 게이트웨이 · 소유 판정 0 · RPC 0", async () => {
  for (const why of ["unsupported", "not-host", "unqualified", "absent"] as const) {
    const r = rig({ picks: [{ host: null, why }], defers: true });
    const exec = await outboxExecFor(ID, r.deps);
    assert.equal(exec.host, null, why);
    assert.equal(exec.why, why);
    assert.equal(r.count("sleep"), 0, `${why} 에서 기다렸다`);
    assert.equal(r.count("defers"), 0, `${why} 인데 소유 판정을 물었다`);
    await exec.peek();
    await exec.type("안녕");
    assert.equal(r.count("rpc"), 0, `${why} 인데 호스트에 보냈다`);
    assert.deepEqual(r.onGateway(), [["local.peek", ID], ["local.type", ID, "안녕"]]);
  }
});

test("E5 호스트 id 가 빈 문자열이면 게이트웨이(!host)", async () => {
  const r = rig({ picks: [{ host: "", why: "ok" }] });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(exec.host, null);
  await exec.peek();
  await exec.enter();
  assert.equal(r.count("rpc"), 0);
  assert.deepEqual(r.onGateway(), [["local.peek", ID], ["local.enter", ID]]);
});

test("N1 게이트웨이 능력(outboxHost)이 안 꽂혔으면 호스트를 못 고른다 — 게이트웨이(종전 경로) · RPC 0 · 소유 판정 0", async () => {
  const r = rig();
  //  고르기·RPC 는 기본값(게이트웨이 능력 조회)을 쓴다 — 이 시험 프로세스는 능력을 등록하지 않는다.
  const exec = await outboxExecFor(ID, { defersHere: r.deps.defersHere, local: r.deps.local, warn: r.deps.warn, sleep: r.deps.sleep, now: r.deps.now });
  assert.equal(exec.host, null);
  assert.equal(exec.why, "no-port");
  assert.equal(r.count("defers"), 0);
  assert.equal(r.count("sleep"), 0);
  await exec.peek();
  assert.deepEqual(r.onGateway(), [["local.peek", ID]]);
});

test("D1 강등은 그 행까지 — 다음 행은 호스트를 다시 고르고 호스트에 보낸다", async () => {
  let hostDown = true;
  const r = rig({ host: (a) => { if (a.step === "peek" && hostDown) throw rpcErr(false); return { ok: true, pane: INPUT, paneCmd: "claude" }; } });
  const first = await outboxExecFor(ID, r.deps);
  await first.peek();
  assert.deepEqual(r.onGateway(), [["local.peek", ID]]);
  hostDown = false;
  const second = await outboxExecFor(ID, r.deps);
  assert.equal(second.host, HOST);
  await second.peek();
  assert.equal(r.count("pick"), 2, "행마다 고르지 않았다");
  assert.equal(r.sentTo("peek").length, 2, "앞 행의 강등이 다음 행으로 샜다");
  assert.deepEqual(r.onGateway(), [["local.peek", ID]]);
});

// ── 보기(준비 판정) ──────────────────────────────────────────────────────────────

test("E6 호스트 화면이 빈 문자열 — claude 는 기다리고, 게이트웨이가 다시 보지 않는다", async () => {
  const r = rig({ host: (a, n) => (a.step === "peek" ? { ok: true, pane: n === 1 ? "" : INPUT, paneCmd: "claude" } : { ok: true }) });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(await waitReady(ID, "claude", false, exec, r.waitClock), "ready");
  assert.equal(r.sentTo("peek").length, 2, "빈 화면에서 기다리지 않았다");
  assert.deepEqual(r.onGateway(), [], "빈 화면을 실패로 읽고 게이트웨이가 다시 봤다");
  assert.equal(r.count("warn"), 0);
});

test("N5 호스트 포그라운드가 빈 문자열 — 받는다(입력창 문구를 모르는 하네스는 기다리다 창이 끝나면 not-ready)", async () => {
  const r = rig({ host: (a) => (a.step === "peek" ? { ok: true, pane: "booting", paneCmd: "" } : { ok: true }) });
  const exec = await outboxExecFor(ID, r.deps);
  assert.deepEqual(await exec.peek(), { ok: true, pane: "booting", paneCmd: "" });
  assert.equal(await waitReady(ID, "other-harness", false, exec, r.waitClock), "not-ready");
  assert.deepEqual(r.onGateway(), []);
});

test("E7 호스트가 «세션 없음» 확답(또는 못 닿음) — 준비 판정 결말을 그대로 넘긴다 · 게이트웨이가 다시 보지 않는다 · 강등 없음", async () => {
  for (const reach of ["gone", "unknown"] as const) {
    const r = rig({ host: () => ({ ok: false, reach }) });
    const exec = await outboxExecFor(ID, r.deps);
    assert.equal(await waitReady(ID, "claude", false, exec, r.waitClock), reach);
    assert.deepEqual(r.onGateway(), [], `${reach}: 세션 상태를 호스트 고장으로 읽고 게이트웨이가 다시 봤다`);
    assert.equal(r.count("warn"), 0);
  }
});

test("F3 보기 RPC 오류는 종류와 무관하게 게이트웨이가 본다(+warn) · 그 행의 나머지 걸음도 게이트웨이 — RPC 추가 0 · warn 행당 1", async () => {
  for (const err of [rpcErr(false), rpcErr(true), rpcErr()]) {
    const r = rig({ host: (a) => { if (a.step === "peek") throw err; return { ok: true, typed: "full" }; } });
    const exec = await outboxExecFor(ID, r.deps);
    assert.deepEqual(await exec.peek(), { ok: true, pane: INPUT, paneCmd: "claude" }, err.message);
    assert.equal(r.count("warn"), 1, "폴백이 조용하면 호스트가 계속 실패해도 아무도 모른다");
    await exec.peek();
    assert.deepEqual(await exec.type("안녕"), { next: "echo" });
    assert.equal(r.sentTo("peek").length, 1, "강등한 뒤에도 호스트에 보기를 보냈다 — 폴마다 RPC 시간 초과를 다시 치른다");
    assert.equal(r.sentTo("type").length, 0, "강등한 행의 치기를 호스트에 보냈다");
    assert.deepEqual(r.onGateway(), [["local.peek", ID], ["local.peek", ID], ["local.type", ID, "안녕"]]);
    assert.equal(r.count("warn"), 1, "강등 경고가 폴마다 쌓인다");
  }
});

test("N2 보기 답이 거절·모양 틀림({ok:true} 뿐·null·문자열) — 게이트웨이가 본다", async () => {
  for (const bad of [{ ok: false, unsupported: true, reason: "모르는 걸음" }, { ok: true }, null, "peek"]) {
    const r = rig({ host: () => bad });
    const exec = await outboxExecFor(ID, r.deps);
    assert.deepEqual(await exec.peek(), { ok: true, pane: INPUT, paneCmd: "claude" }, JSON.stringify(bad));
    assert.deepEqual(r.onGateway(), [["local.peek", ID]]);
  }
});

test("E12 경계 — 경과가 정확히 READY_WINDOW_MS 인 폴(호스트 화면)은 포기가 아니고, 1ms 넘은 폴에서 not-ready", async () => {
  const at: number[] = [];
  const r = rig({
    host: (a, n) => {
      if (a.step !== "peek") return { ok: true };
      r.clock.t = n === 1 ? READY_WINDOW_MS : READY_WINDOW_MS + 1;   // 이 폴을 본 순간의 경과(시작 0)
      at.push(r.clock.t);
      return { ok: true, pane: "booting", paneCmd: "claude" };
    },
  });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(await waitReady(ID, "claude", false, exec, r.waitClock), "not-ready");
  assert.deepEqual(at, [READY_WINDOW_MS, READY_WINDOW_MS + 1], "경과가 창과 같은 폴에서 포기했다(`>` 가 `>=` 로 바뀌었나)");
});

// ── 누르기(신뢰 대화상자·미제출 방어) ─────────────────────────────────────────────

test("★ E10 호스트 화면이 «❯ No, exit / Yes» — 호스트에 {down:1, enter:true} 한 걸음 · 게이트웨이 키 0", async () => {
  const r = rig({ host: (a, n) => (a.step === "peek" ? { ok: true, pane: n === 1 ? TRUST : INPUT, paneCmd: "claude" } : { ok: true }) });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(await waitReady(ID, "claude", true, exec, r.waitClock), "ready");
  assert.deepEqual(r.sentTo("keys"), [{ step: "keys", id: ID, down: 1, enter: true }],
    "내리기와 Enter 를 따로 보내면 내리기가 실패해도 Enter 가 가서 «No, exit» 가 눌린다");
  assert.deepEqual(r.onGateway(), [], "호스트가 있는데 게이트웨이 tmux 로 보거나 눌렀다");
});

test("E11 선택지를 못 읽으면 아무 키도 보내지 않는다(호스트·게이트웨이 둘 다) — 창이 끝나면 not-ready", async () => {
  const r = rig({ host: (a) => (a.step === "peek" ? { ok: true, pane: UNREADABLE, paneCmd: "claude" } : { ok: true }) });
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(await waitReady(ID, "claude", true, exec, r.waitClock), "not-ready");
  assert.equal(r.sentTo("keys").length, 0);
  assert.deepEqual(r.onGateway(), []);
});

test("K3 누르기 상한 — Yes 가 정확히 상한 칸 아래면 호스트에 한 걸음으로 싣는다", async () => {
  const pane = trustDowns(OUTBOX_KEYS_MAX_DOWN);
  assert.equal(trustAcceptDowns(tailOf(pane)), OUTBOX_KEYS_MAX_DOWN, "시험 화면이 상한 칸을 안 만든다 — 아래 단언이 아무것도 안 잰다");
  const r = rig();
  const exec = await outboxExecFor(ID, r.deps);
  assert.equal(await acceptTrustDialog(ID, pane, exec.trustKeys()), "accepted");
  assert.deepEqual(r.sentTo("keys"), [{ step: "keys", id: ID, down: OUTBOX_KEYS_MAX_DOWN, enter: true }]);
  assert.deepEqual(r.onGateway(), []);
});

test("★ K4 누르기 상한+1 — 호스트에 보내지 않고 게이트웨이로도 넘기지 않는다(아무것도 안 누른다 · warn)", async () => {
  const pane = trustDowns(OUTBOX_KEYS_MAX_DOWN + 1);
  assert.equal(trustAcceptDowns(tailOf(pane)), OUTBOX_KEYS_MAX_DOWN + 1, "시험 화면이 상한+1 칸을 안 만든다");
  const r = rig();
  const exec = await outboxExecFor(ID, r.deps);
  await acceptTrustDialog(ID, pane, exec.trustKeys());
  assert.equal(r.sentTo("keys").length, 0, "상한을 넘는 칸을 호스트에 보냈다 — 호스트는 거절하고 게이트웨이가 대신 누르게 된다");
  assert.deepEqual(r.onGateway(), [], "상한을 넘는 칸을 게이트웨이 tmux 로 눌렀다");
  assert.equal(r.count("warn"), 1);
});

test("F4a·F4b 누르기가 안 보냈다(sent=false)·거절(unsupported) — 같은 시도를 게이트웨이가(내리기 n → Enter)", async () => {
  const answers: Array<[string, () => unknown]> = [
    ["sent=false", () => { throw rpcErr(false); }],
    ["거절", () => ({ ok: false, unsupported: true, reason: "keys 의 down 은 8 이하여야 한다" })],
  ];
  for (const [what, answer] of answers) {
    const r = rig({ host: (a) => (a.step === "keys" ? answer() : { ok: true, pane: INPUT, paneCmd: "claude" }) });
    const exec = await outboxExecFor(ID, r.deps);
    assert.equal(await acceptTrustDialog(ID, TRUST, exec.trustKeys()), "accepted");
    assert.equal(r.sentTo("keys").length, 1, what);
    assert.deepEqual(r.onGateway(), [["local.down", ID, 1], ["local.enter", ID]], `${what}: 안 간 누르기를 게이트웨이가 다시 하지 않았다`);
  }
});

test("F5 누르기가 «눌렀을 수 있다»(시간 초과·표식 없음) — 삼킨다: 게이트웨이 키 0 · 그 행의 다음 보기는 게이트웨이", async () => {
  for (const err of [rpcErr(true), rpcErr()]) {
    const r = rig({ host: (a) => { if (a.step === "keys") throw err; return { ok: true, pane: INPUT, paneCmd: "claude" }; } });
    const exec = await outboxExecFor(ID, r.deps);
    assert.equal(await acceptTrustDialog(ID, TRUST, exec.trustKeys()), "accepted");
    assert.deepEqual(r.onGateway(), [], `${err.message}: 눌렀을 수 있는데 게이트웨이가 또 눌렀다 — 다음 화면에 엉뚱한 답이 된다`);
    await exec.peek();
    assert.deepEqual(r.onGateway(), [["local.peek", ID]]);
    assert.equal(r.sentTo("peek").length, 0);
  }
});

test("K5·N4 누르기 값 실패(at=check·down·enter)는 삼키고 강등하지 않는다 · 모양 틀린 답도 삼킨다(눌렀을 수 있다)", async () => {
  for (const answer of [{ ok: false, at: "check", reach: "gone" }, { ok: false, at: "down" }, { ok: false, at: "enter" }]) {
    const r = rig({ host: (a) => (a.step === "keys" ? answer : { ok: true, pane: INPUT, paneCmd: "claude" }) });
    const exec = await outboxExecFor(ID, r.deps);
    await exec.enter();
    await exec.peek();
    assert.deepEqual(r.onGateway(), [], `${JSON.stringify(answer)}: 게이트웨이가 눌렀거나 봤다`);
    assert.equal(r.sentTo("peek").length, 1, "세션 상태를 호스트 고장으로 읽고 강등했다");
    assert.equal(r.count("warn"), 0);
  }
  for (const answer of [undefined, { ok: "yes" }]) {
    const r = rig({ host: (a) => (a.step === "keys" ? answer : { ok: true, pane: INPUT, paneCmd: "claude" }) });
    const exec = await outboxExecFor(ID, r.deps);
    await exec.enter();
    assert.deepEqual(r.onGateway(), [], `${JSON.stringify(answer)}: 눌렀을 수 있는데 게이트웨이가 또 눌렀다`);
  }
});

// ── 치기(배달자 sendReadyRow 그대로) ──────────────────────────────────────────────

test("★ E8 치기 시간 초과(sent=true) — 게이트웨이 치기 0 · Enter 재시도 0 · 에코만: 미확인이면 failed send: host-unknown, 확인되면 delivered", async () => {
  const cases: Array<["confirmed" | "timeout" | "unreadable", unknown]> = [
    ["timeout", { kind: "mark", status: "failed", error: "send: host-unknown" }],
    ["unreadable", { kind: "mark", status: "failed", error: "send: host-unknown" }],
    ["confirmed", { kind: "mark", status: "delivered" }],
  ];
  for (const [echoed, want] of cases) {
    const r = rig({ host: (a) => { if (a.step === "type") throw rpcErr(true); return { ok: true }; } });
    const exec = await outboxExecFor(ID, r.deps);
    const e = echoes([echoed]);
    assert.deepEqual(await sendReadyRow({ text: "첫 줄\n둘째 줄", kind: "prompt" }, "claude", exec, e.echo), want, echoed);
    assert.deepEqual(r.onGateway(), [], "쳤을 수 있는데 게이트웨이가 다시 쳤다 — 같은 지시가 두 번 간다");
    assert.deepEqual(e.seen, ["첫 줄 둘째 줄"], "에코를 안 봤거나 두 번 봤다");
    assert.equal(r.sentTo("type").length, 1);
    assert.equal(r.sentTo("keys").length, 0, "쳤는지 모르는 입력칸에 Enter 를 눌렀다");
  }
});

test("F6·N3 치기 표식 없는 오류·모양 틀린 답({ok:true} 뿐) — 쳤을 수 있다: 다시 치지 않고 에코만", async () => {
  const answers: Array<() => unknown> = [() => { throw rpcErr(); }, () => ({ ok: true })];
  for (const answer of answers) {
    const r = rig({ host: (a) => (a.step === "type" ? answer() : { ok: true }) });
    const exec = await outboxExecFor(ID, r.deps);
    const e = echoes(["timeout"]);
    assert.deepEqual(await sendReadyRow({ text: "안녕", kind: "prompt" }, "claude", exec, e.echo), { kind: "mark", status: "failed", error: "send: host-unknown" });
    assert.deepEqual(r.onGateway(), []);
    assert.equal(e.seen.length, 1);
    assert.equal(r.sentTo("keys").length, 0);
  }
});

test("E9·F4c 치기 연결 없음(sent=false) — 게이트웨이가 한 번 친다 → 오늘 경로", async () => {
  const r = rig({ host: (a) => { if (a.step === "type") throw rpcErr(false); return { ok: true }; } });
  const exec = await outboxExecFor(ID, r.deps);
  assert.deepEqual(await sendReadyRow({ text: "안녕", kind: "prompt" }, "claude", exec, echoes(["confirmed"]).echo), { kind: "mark", status: "delivered" });
  assert.deepEqual(r.onGateway(), [["local.type", ID, "안녕"]], "안 간 치기를 게이트웨이가 다시 치지 않았다 — 순간 끊김 하나로 지시를 잃는다");
  assert.equal(r.sentTo("type").length, 1);
});

test("F4d 치기 거절(unsupported) — 게이트웨이가 친다 · 빈 글이면 진짜 게이트웨이 칸이 오늘처럼 failed", async () => {
  const refuse = (a: Record<string, unknown>) => (a.step === "type" ? { ok: false, unsupported: true, reason: "칠 글이 비었다" } : { ok: true });
  const r = rig({ host: refuse });
  const exec = await outboxExecFor(ID, r.deps);
  assert.deepEqual(await exec.type("안녕"), { next: "echo" });
  assert.deepEqual(r.onGateway(), [["local.type", ID, "안녕"]]);
  //  진짜 게이트웨이 칸 — 빈 글은 tmux 를 부르기 전에 던진다(send-keys 규약). 결말 문자열은 종전 배달 루프의 것 그대로다.
  const e = rig({ host: refuse });
  const real = await outboxExecFor(ID, { ...e.deps, local: { ...e.deps.local, type: LOCAL_STEPS.type } });
  assert.deepEqual(await sendReadyRow({ text: "  \n ", kind: "prompt" }, "claude", real, echoes(["confirmed"]).echo),
    { kind: "mark", status: "failed", error: "send: 주입할 텍스트가 비어 있습니다" });
});

test("F7a·F7b 치기 none → settleStall 로(닿았나 그대로) · partial → failed send: <멈춘 자리> · 둘 다 에코 0·다시 치지 않음", async () => {
  const cases: Array<[unknown, unknown]> = [
    [{ ok: false, typed: "none", reach: "gone" }, { kind: "stall", verdict: "gone" }],
    [{ ok: false, typed: "none", reach: "unknown" }, { kind: "stall", verdict: "unknown" }],
    [{ ok: false, typed: "partial", at: "text" }, { kind: "mark", status: "failed", error: "send: text" }],
    [{ ok: false, typed: "partial", at: "enter" }, { kind: "mark", status: "failed", error: "send: enter" }],
  ];
  for (const [answer, want] of cases) {
    const r = rig({ host: (a) => (a.step === "type" ? answer : { ok: true }) });
    const exec = await outboxExecFor(ID, r.deps);
    const e = echoes(["confirmed"]);
    assert.deepEqual(await sendReadyRow({ text: "안녕", kind: "prompt" }, "claude", exec, e.echo), want, JSON.stringify(answer));
    assert.deepEqual(r.onGateway(), [], "호스트가 멈춘 자리를 알려 줬는데 게이트웨이가 다시 쳤다");
    assert.equal(e.seen.length, 0);
    assert.equal(r.count("warn"), 0);
  }
});

test("F7c 치기 full — 오늘 경로: 에코 미확인(claude)이면 호스트에 Enter 한 걸음({down:0, enter:true}) 뒤 다시 에코", async () => {
  const r = rig();
  const exec = await outboxExecFor(ID, r.deps);
  const e = echoes(["timeout", "confirmed"]);
  assert.deepEqual(await sendReadyRow({ text: "안녕", kind: "prompt" }, "claude", exec, e.echo), { kind: "mark", status: "delivered" });
  assert.deepEqual(r.sentTo("type"), [{ step: "type", id: ID, text: "안녕" }]);
  assert.deepEqual(r.sentTo("keys"), [{ step: "keys", id: ID, down: 0, enter: true }]);
  assert.equal(e.seen.length, 2);
  assert.deepEqual(r.onGateway(), []);
  //  claude 외 하네스는 입력칸 문법을 모르므로 Enter 를 더 누르지 않는다(종전과 같다).
  const other = rig();
  const oexec = await outboxExecFor(ID, other.deps);
  assert.deepEqual(await sendReadyRow({ text: "안녕", kind: "prompt" }, "codex", oexec, echoes(["timeout"]).echo),
    { kind: "mark", status: "sent", error: "echo-unconfirmed" });
  assert.equal(other.sentTo("keys").length, 0);
});

test("E13 control 행(설정 명령) + full — sent/control-no-echo · 에코를 기다리지 않는다", async () => {
  const r = rig();
  const exec = await outboxExecFor(ID, r.deps);
  const e = echoes(["confirmed"]);
  assert.deepEqual(await sendReadyRow({ text: "/model opus", kind: "control" }, "claude", exec, e.echo),
    { kind: "mark", status: "sent", error: "control-no-echo" });
  assert.equal(e.seen.length, 0);
  assert.equal(r.sentTo("keys").length, 0);
});

// ── 시간·registry ─────────────────────────────────────────────────────────────────

test("E15 시간 불변식 — 한 행이 sending 에 머무는 상한의 합이 잔재 판정(STALE_SENDING)보다 짧고, 좌표 대기는 상태 push 한 주기보다 길다", () => {
  const m = /^(\d+) minutes?$/.exec(STALE_SENDING);
  assert.ok(m, `STALE_SENDING 을 못 읽었다: ${STALE_SENDING}`);
  const staleMs = Number(m[1]) * 60_000;
  const agent = readFileSync(new URL("../../src/node/agent.ts", import.meta.url), "utf8");
  const push = /const STATE_PUSH_MS = ([\d_]+);/.exec(agent);
  assert.ok(push, "agent.ts 의 STATE_PUSH_MS 를 못 찾았다 — 이름이 바뀌었나");
  assert.ok(HOST_WAIT_CAP_MS > Number(push[1]!.replace(/_/g, "")),
    "좌표를 상태 push 한 주기보다 짧게 기다리면 새 세션의 첫 지시가 늘 게이트웨이로 간다");
  //  좌표 대기 + 준비 창 + 마지막 폴 간격 + RPC 넷(창 끝에 걸린 보기·신뢰 키 · 치기 · Enter) + 에코 창 둘.
  //   게이트웨이 칸의 tmux 지연(중계 22초/호출)은 종전과 같은 성질이라, 에코 파일 읽기 지연은 계획 E15 와 같이 넣지 않는다.
  const worst = HOST_WAIT_CAP_MS + READY_WINDOW_MS + READY_POLL_MS + 4 * NODE_RPC_TIMEOUT_MS + 2 * ECHO_WINDOW_MS;
  assert.ok(worst < staleMs, `한 행 상한 ${worst}ms 가 잔재 판정 ${staleMs}ms 이상이다 — 살아 있는 배달이 «죽은 잔재» 로 회수돼 다시 보내진다`);
});

test("H1 registry 형제 함수 — 사유를 함께 준다 · sessionHostFor 는 그 호스트만 · 스냅샷에 없는 새 세션은 no-coordinate(absent 아님) · 사유 계수는 한 곳", () => {
  assert.deepEqual(sessionHostTargetFor("box-new-3773", "outboxStep"), { host: null, why: "no-coordinate" });
  assert.equal(sessionHostFor("box-new-3773", "outboxStep"), null);
  const lines = readFileSync(new URL("../../src/node/registry.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.equal(lines.filter((l) => /recordDefers\(`session:\$\{r\.why\}`\)/.test(l)).length, 1, "사유 계수를 두 곳에서 센다");
  assert.ok(lines.some((l) => /return sessionHostTargetFor\(sessionId, op, now\)\.host;/.test(l)), "sessionHostFor 가 형제 함수를 안 지난다 — 판정이 두 벌이 된다");
});

// #4939 재설계 v2 — 도달 불가 세션 판정. 사양: 지식 session-reclaim-gaps-design-4939 «재설계 v2» 의 게이트웨이 표(G1~G12) ·
//  상민님 확정값 H1(15분 연속 · last_busy 1시간 · 다시 보이면 지움 · 호스트 끊김·낡음은 모름) · H5(기본 shadow) · H6(상시 세션 포함).
//  명제: ① 신선한 호스트의 연속 확답 + 오래된 마지막 작업일 때만 «끝남» 으로 적는다 ② 모르면 안 적는다 ③ 다시 보이면 이 규칙이 적은 것만 지운다
//   ④ shadow 는 판정을 로그로만 남긴다.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  exitedByUserOf, judgeUnreachable, lostRuleModeOf, runUnreachableSweep, UNREACHABLE_AFTER_MS, UNREACHABLE_BUSY_MS, UNREACHABLE_REASON,
  type HostView, type UnreachableInput, type UnreachableRow,
} from "./session-unreachable-rule.js";

const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const MIN = 60_000, HOUR = 60 * MIN;
const sec = (ms: number): number => Math.floor(ms / 1000);
const host = (o: Partial<HostView> = {}): HostView => ({ nodeId: "i-node-a", fresh: true, known: true, listed: new Set(), missing: new Map(), ...o });
const missing = (sid: string, ageMs: number, container = `lvly-s-acme-${sid}`) =>
  new Map([[sid, { sinceMs: NOW - ageMs, container }]]);
const rowOf = (id: string, o: Partial<UnreachableRow> = {}): UnreachableRow =>
  ({ id, superseded_by: null, exited_at: null, exit_reason: null, last_busy: sec(NOW - 2 * HOUR), ...o });
const input = (o: Partial<UnreachableInput> = {}): UnreachableInput =>
  ({ nowMs: NOW, hosts: [host()], rows: [], managed: [], lastBusyMem: () => 0, upMs: 2 * HOUR, markedManaged: new Map(), ...o });

test("[G1] ★★ 신선한 호스트가 «컨테이너는 있는데 세션 없음» 을 16분 연속 · 마지막 작업 2시간 전 → 끝남으로 적는다(지금 코드: 아무도 안 끈다)", () => {
  const d = judgeUnreachable(input({ hosts: [host({ missing: missing("box-a", 16 * MIN) })], rows: [rowOf("box-a")] }));
  assert.equal(d.blind, null);
  assert.deepEqual(d.mark.map((m) => [m.id, m.node, m.container, m.managed]), [["box-a", "i-node-a", "lvly-s-acme-box-a", false]]);
});

test("[G1] 경계 — 연속 14분은 아직 · 정확히 15분이면 적는다", () => {
  assert.equal(UNREACHABLE_AFTER_MS, 15 * MIN);
  const at = (age: number) => judgeUnreachable(input({ hosts: [host({ missing: missing("box-a", age) })], rows: [rowOf("box-a")] })).mark.length;
  assert.equal(at(14 * MIN), 0);
  assert.equal(at(15 * MIN), 1);
});

test("[G2] ★ 모르면 안 적는다 — 호스트 하나라도 낡았거나(끊김) 컨테이너 관측을 안 보내면(옛 판) 그 판은 아무것도 안 적는다", () => {
  const rows = [rowOf("box-a")];
  const stale = judgeUnreachable(input({ hosts: [host({ missing: missing("box-a", 30 * MIN) }), host({ nodeId: "i-node-b", fresh: false })], rows }));
  assert.equal(stale.mark.length, 0);
  assert.match(stale.blind ?? "", /i-node-b/);
  const old = judgeUnreachable(input({ hosts: [host({ missing: missing("box-a", 30 * MIN), known: false })], rows }));
  assert.equal(old.mark.length, 0);
  assert.ok(old.blind);
});

test("[G3] 다른 신선한 호스트 목록에 보이면 산 세션이다(옛 자리가 남은 노드의 관측으로 끝내지 않는다)", () => {
  const d = judgeUnreachable(input({
    hosts: [host({ missing: missing("box-a", 30 * MIN) }), host({ nodeId: "i-node-b", listed: new Set(["box-a"]) })],
    rows: [rowOf("box-a")],
  }));
  assert.equal(d.mark.length, 0);
});

test("[G4] ★ 일하는 세션을 안 죽인다 — 마지막 작업이 1시간 안이면 보류(DB last_busy · 이 프로세스가 훅으로 본 시각 둘 다)", () => {
  assert.equal(UNREACHABLE_BUSY_MS, HOUR);
  const h = [host({ missing: missing("box-a", 30 * MIN) })];
  const db = judgeUnreachable(input({ hosts: h, rows: [rowOf("box-a", { last_busy: sec(NOW - 10 * MIN) })] }));
  assert.equal(db.mark.length, 0);
  assert.match(db.hold[0]?.why ?? "", /작업/);
  const mem = judgeUnreachable(input({ hosts: h, rows: [rowOf("box-a")], lastBusyMem: () => sec(NOW - 5 * MIN) }));
  assert.equal(mem.mark.length, 0);
  //  경계 — 정확히 1시간 전이면 적는다. 작업 기록이 아예 없는 DB 행(한 번도 안 바빴다)도 적는다.
  assert.equal(judgeUnreachable(input({ hosts: h, rows: [rowOf("box-a", { last_busy: sec(NOW - HOUR) })] })).mark.length, 1);
  assert.equal(judgeUnreachable(input({ hosts: h, rows: [rowOf("box-a", { last_busy: null })] })).mark.length, 1);
});

test("[G5] 관측 재료가 없는 세션(missing 에 없음 — 안쪽 표식 없는 컨테이너 등)은 판정하지 않는다", () => {
  const d = judgeUnreachable(input({ hosts: [host()], rows: [rowOf("box-a", { last_busy: null })] }));
  assert.deepEqual([d.mark.length, d.hold.length], [0, 0]);
});

test("[G6] 이어진 행·이미 끝난 행(사용자 종료·OOM·이미 적힘)은 손대지 않는다", () => {
  const h = [host({ missing: new Map([
    ["box-r", { sinceMs: NOW - HOUR, container: "c-r" }], ["box-x", { sinceMs: NOW - HOUR, container: "c-x" }],
    ["box-u", { sinceMs: NOW - HOUR, container: "c-u" }],
  ]) })];
  const d = judgeUnreachable(input({ hosts: h, rows: [
    rowOf("box-r", { superseded_by: "box-r2" }),
    rowOf("box-x", { exited_at: new Date(NOW - HOUR).toISOString(), exit_reason: "prompt_input_exit" }),
    rowOf("box-u", { exited_at: new Date(NOW - HOUR).toISOString(), exit_reason: UNREACHABLE_REASON }),
  ] }));
  assert.deepEqual([d.mark.length, d.revive.length], [0, 0]);
});

test("[G7] ★ 다시 보이면 이 규칙이 적은 것만 지운다(되살아남) — 사용자 종료 표식은 안 건드린다 · 호스트가 낡은 판에도 되살림은 한다", () => {
  const ended = new Date(NOW - HOUR).toISOString();
  const d = judgeUnreachable(input({
    hosts: [host({ listed: new Set(["box-u", "box-x"]) }), host({ nodeId: "i-node-b", fresh: false })],
    rows: [rowOf("box-u", { exited_at: ended, exit_reason: UNREACHABLE_REASON }), rowOf("box-x", { exited_at: ended, exit_reason: "logout" })],
  }));
  assert.deepEqual(d.revive, [{ id: "box-u", managed: false }]);
  assert.ok(d.blind, "그 판은 적기는 보류다");
});

test("[G10] 세션 호스트가 없는 배포(셀프호스트 · 호스트가 목록을 안 쥔 테넌트)는 판단하지 않는다", () => {
  const d = judgeUnreachable(input({ hosts: [], rows: [rowOf("box-a")] }));
  assert.match(d.blind ?? "", /세션 호스트/);
  assert.equal(d.mark.length, 0);
});

test("[G12] ★ H6 — 상시 세션도 적는다(DB 행 없음 → 메모리 표식) · 작업 근거가 없고 게이트웨이가 뜬 지 1시간 미만이면 보류", () => {
  const h = [host({ missing: missing("box-m", 30 * MIN) })];
  const ok = judgeUnreachable(input({ hosts: h, managed: ["box-m"], upMs: 2 * HOUR }));
  assert.deepEqual(ok.mark.map((m) => [m.id, m.managed]), [["box-m", true]]);
  const young = judgeUnreachable(input({ hosts: h, managed: ["box-m"], upMs: 30 * MIN }));
  assert.equal(young.mark.length, 0);
  assert.match(young.hold[0]?.why ?? "", /모른다|모름/);
  const busy = judgeUnreachable(input({ hosts: h, managed: ["box-m"], lastBusyMem: () => sec(NOW - 5 * MIN) }));
  assert.equal(busy.mark.length, 0);
  //  이미 적은 상시 세션은 다시 안 적고, 다시 보이면 지운다.
  const marked = new Map([["box-m", NOW - 5 * MIN]]);
  assert.equal(judgeUnreachable(input({ hosts: h, managed: ["box-m"], markedManaged: marked })).mark.length, 0);
  const back = judgeUnreachable(input({ hosts: [host({ listed: new Set(["box-m"]) })], managed: ["box-m"], markedManaged: marked }));
  assert.deepEqual(back.revive, [{ id: "box-m", managed: true }]);
});

test("[G11] ★ shadow 는 판정을 로그로만 남긴다(DB·메모리 표식 무변경) · on 은 적는다 · off 는 읽지도 않는다", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const base = {
    nowMs: NOW, upMs: 2 * HOUR, lastBusyMem: () => 0, said: new Map<string, string>(),
    hosts: () => [host({ missing: new Map([["box-a", { sinceMs: NOW - HOUR, container: "c-a" }], ["box-m", { sinceMs: NOW - HOUR, container: "c-m" }]]) })],
    rows: async () => { calls.push("rows"); return [rowOf("box-a")]; },
    managed: async () => ["box-m"],
    markRow: async (id: string) => { calls.push(`mark:${id}`); return true; },
    reviveRow: async (id: string) => { calls.push(`revive:${id}`); return true; },
    log: (_l: "info" | "warn", _o: Record<string, unknown>, msg: string) => { logs.push(msg); },
  };
  const marks = new Map<string, number>();
  const sh = await runUnreachableSweep({ ...base, mode: "shadow", marks });
  assert.equal(sh?.mark.length, 2);
  assert.deepEqual(calls, ["rows"], "shadow 가 DB 에 적었다");
  assert.equal(marks.size, 0, "shadow 가 상시 세션 표식을 남겼다");
  assert.ok(logs.some((m) => /그림자/.test(m)), "그림자 판정이 로그에 안 남는다");
  calls.length = 0;
  await runUnreachableSweep({ ...base, mode: "on", marks, said: new Map() });
  assert.deepEqual(calls, ["rows", "mark:box-a"]);
  assert.deepEqual([...marks.keys()], ["box-m"]);
  calls.length = 0;
  assert.equal(await runUnreachableSweep({ ...base, mode: "off", marks }), null);
  assert.deepEqual(calls, [], "off 가 DB 를 읽었다");
});

test("lostRuleModeOf — 기본 shadow · off·on 낱말 · 모르는 낱말은 shadow", () => {
  assert.equal(lostRuleModeOf(undefined), "shadow");
  assert.equal(lostRuleModeOf("OFF"), "off");
  assert.equal(lostRuleModeOf("0"), "off");
  assert.equal(lostRuleModeOf("on"), "on");
  assert.equal(lostRuleModeOf("true"), "on");
  assert.equal(lostRuleModeOf("enable"), "shadow");
});

test("exitedByUserOf — 끝남 표식이 있고 사유가 도달 불가가 아닐 때만 «사람이 끝냄»(목록 행·단건 메타가 같은 자)", () => {
  const at = "2026-10-22T00:00:00.000Z";
  assert.equal(exitedByUserOf({ exited_at: at, exit_reason: "prompt_input_exit" }), true);
  assert.equal(exitedByUserOf({ exited_at: at, exit_reason: null }), true);
  assert.equal(exitedByUserOf({ exited_at: at, exit_reason: UNREACHABLE_REASON }), false);
  assert.equal(exitedByUserOf({ exited_at: null, exit_reason: "oom" }), false);
});

test("[G11b] 말은 바뀔 때만 — 같은 판정을 판마다 되풀이하지 않고(분 단위 숫자가 바뀌어도) · 판정에서 빠진 세션은 잊는다 · 적기 실패는 경고로 남긴다", async () => {
  const logs: string[] = [];
  const said = new Map<string, string>();
  let busyAgo = 10 * MIN;
  const deps = (o: Partial<Parameters<typeof runUnreachableSweep>[0]> = {}) => ({
    mode: "on" as const, nowMs: NOW, upMs: 2 * HOUR, lastBusyMem: () => 0, said, marks: new Map<string, number>(),
    hosts: () => [host({ missing: new Map([["box-a", { sinceMs: NOW - HOUR, container: "c-a" }]]) })],
    rows: async () => [rowOf("box-a", { last_busy: sec(NOW - busyAgo) })],
    managed: async () => [],
    markRow: async () => { throw new Error("db down"); },
    reviveRow: async () => true,
    log: (_l: "info" | "warn", _o: Record<string, unknown>, msg: string) => { logs.push(msg); },
    ...o,
  });
  await runUnreachableSweep(deps());
  busyAgo = 11 * MIN;
  await runUnreachableSweep(deps());
  assert.equal(logs.filter((m) => /보류/.test(m)).length, 1, `보류를 판마다 되풀이했다: ${logs.join(" | ")}`);
  busyAgo = 2 * HOUR;
  await runUnreachableSweep(deps());
  assert.ok(logs.some((m) => /끝남 기록 실패/.test(m)), "적기 실패를 삼켰다");
  assert.ok(!logs.some((m) => /끝남으로 적었다/.test(m)), "실패했는데 적었다고 말했다");
  await runUnreachableSweep(deps({ hosts: () => [host()] }));
  assert.deepEqual([...said.keys()], ["*blind"], "판정에서 빠진 세션을 계속 기억한다");
});

test("[G7b] on — 되살림은 이 규칙이 적은 DB 행만 지우고(reviveRow) · 상시 목록에서 빠진 세션의 메모리 표식은 버린다", async () => {
  const calls: string[] = [];
  const marks = new Map([["box-gone", NOW - HOUR]]);
  await runUnreachableSweep({
    mode: "on", nowMs: NOW, upMs: 2 * HOUR, lastBusyMem: () => 0, said: new Map(), marks,
    hosts: () => [host({ listed: new Set(["box-u"]) })],
    rows: async () => [rowOf("box-u", { exited_at: new Date(NOW - HOUR).toISOString(), exit_reason: UNREACHABLE_REASON })],
    managed: async () => [],
    markRow: async (id) => { calls.push(`mark:${id}`); return true; },
    reviveRow: async (id) => { calls.push(`revive:${id}`); return true; },
    log: () => {},
  });
  assert.deepEqual(calls, ["revive:box-u"]);
  assert.equal(marks.size, 0, "상시 목록에 없는 세션의 표식이 남았다(장부가 계속 끝남으로 싣는다)");
});

test("[G13] on — DB 행에 적을 때 «안 보이기 시작한 시각» 을 넘긴다(그 뒤 살아 있다는 기록을 받은 행은 DB 가 거른다 — 복원 경합)", async () => {
  const got: Array<[string, number]> = [];
  await runUnreachableSweep({
    mode: "on", nowMs: NOW, upMs: 2 * HOUR, lastBusyMem: () => 0, said: new Map(), marks: new Map(),
    hosts: () => [host({ missing: missing("box-a", 20 * MIN) })],
    rows: async () => [rowOf("box-a")],
    managed: async () => [],
    markRow: async (id, sinceMs) => { got.push([id, sinceMs]); return true; },
    reviveRow: async () => true,
    log: () => {},
  });
  assert.deepEqual(got, [["box-a", NOW - 20 * MIN]]);
});

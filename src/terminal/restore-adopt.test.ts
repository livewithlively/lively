// 복원을 다시 불러도 같은 대화를 둘로 만들지 않는다 — 이어 붙이기 판정표(#3891).
//
// 실측(2026-09-11 08:45:00Z, 매니지드): 롤이 게이트웨이를 SIGTERM 한 15ms 뒤 복원 중이던 새 세션(d78e541c)의 메타 relay 가
//  죽어 요청이 실패했다. 새 세션(Claude Code)은 떠 있었고 옛 행(26ddebe8)은 이정표 없이 «되살릴 수 있음» 으로 남았다 —
//  사이드바에 같은 세션이 두 줄 섰고, 화면은 제자리에 남아 보낸 말도 안 갔다. 그 상태에서 복원을 다시 부르면(화면의
//  재시도·사람의 재전송) 같은 대화로 세션이 하나 더 뜬다. 판정: 산 것이 있으면 잇고, 모르면 만들지 않는다(force 제외).
//
// 사양·엣지 표: 스크래치패드 spec-3891.md 의 A 행 — 아래 이름의 번호가 그 행이다.
import test from "node:test";
import assert from "node:assert/strict";
import { adoptVerdict, createKeyedSerializer } from "./restore-adopt.js";

const OLD = "box-u-old";

test("A1 후보가 없으면 새로 만든다(none)", () => {
  assert.deepEqual(adoptVerdict(OLD, [], false), { kind: "none" });
});

test("A2 같은 대화를 도는 산 세션이 있으면 그리로 잇는다", () => {
  assert.deepEqual(adoptVerdict(OLD, [{ id: "box-u-new", alive: true }], false), { kind: "adopt", id: "box-u-new" });
});

test("A3 후보가 전부 죽었으면 새로 만든다", () => {
  assert.deepEqual(adoptVerdict(OLD, [{ id: "box-u-a", alive: false }, { id: "box-u-b", alive: false }], false), { kind: "none" });
});

test("A4 최신 후보가 죽은 껍데기여도 그 뒤의 산 세션으로 잇는다(최신이 아니라 산 것)", () => {
  const v = adoptVerdict(OLD, [{ id: "box-u-ghost", alive: false }, { id: "box-u-live", alive: true }], false);
  assert.deepEqual(v, { kind: "adopt", id: "box-u-live" });
});

test("A5 생사를 모르는 후보만 있으면 만들지 않는다(unknown — 같은 대화를 둘로 만들 수 있다)", () => {
  assert.deepEqual(adoptVerdict(OLD, [{ id: "box-u-q", alive: null }], false), { kind: "unknown", id: "box-u-q" });
});

test("A6 모르는 후보만 있어도 사람이 force 를 골랐으면 만든다", () => {
  assert.deepEqual(adoptVerdict(OLD, [{ id: "box-u-q", alive: null }], true), { kind: "none" });
});

test("A7 확답(산 것)이 모름을 이긴다 — 최신이 모름이어도 산 세션으로 잇는다", () => {
  const v = adoptVerdict(OLD, [{ id: "box-u-q", alive: null }, { id: "box-u-live", alive: true }], false);
  assert.deepEqual(v, { kind: "adopt", id: "box-u-live" });
});

test("A8 산 세션이 둘이면 최근 것(앞)으로 잇는다", () => {
  const v = adoptVerdict(OLD, [{ id: "box-u-recent", alive: true }, { id: "box-u-older", alive: true }], false);
  assert.deepEqual(v, { kind: "adopt", id: "box-u-recent" });
});

test("A9 옛 id 자신은 후보가 아니다 — 섞여 들어와도 무시한다(자기에게 이으면 이정표가 고리가 된다)", () => {
  assert.deepEqual(adoptVerdict(OLD, [{ id: OLD, alive: true }], false), { kind: "none" });
  assert.deepEqual(adoptVerdict(OLD, [{ id: OLD, alive: true }, { id: "box-u-live", alive: true }], false), { kind: "adopt", id: "box-u-live" });
  assert.deepEqual(adoptVerdict(OLD, [{ id: "", alive: true }], false), { kind: "none" }, "빈 id 도 후보가 아니다");
});

test("A10 죽은 것과 모르는 것뿐이면 만들지 않는다(unknown)", () => {
  const v = adoptVerdict(OLD, [{ id: "box-u-dead", alive: false }, { id: "box-u-q", alive: null }], false);
  assert.deepEqual(v, { kind: "unknown", id: "box-u-q" });
});

// ── L — 같은 세션의 복원을 한 줄로(createKeyedSerializer) ─────────────────────────────
//  동시에 온 같은 세션 복원 둘이 판이 뜨기 전 창에서 각자 «아무도 안 만들었다» 를 보고 둘 다 만들던 구멍(리뷰 지적).
//  재는 것은 **순서(부작용 기록)** 다 — 걸리는 시간이 아니라 «앞 일이 끝나기 전에 뒤 일이 시작했나».
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("L1 같은 열쇠의 두 일은 겹치지 않는다 — 뒤 일은 앞 일이 끝난 뒤에 시작한다", async () => {
  const s = createKeyedSerializer();
  const ev: string[] = [];
  const a = s.run("t|box-1", async () => { ev.push("a:start"); await tick(20); ev.push("a:end"); return "A"; });
  const b = s.run("t|box-1", async () => { ev.push("b:start"); await tick(1); ev.push("b:end"); return "B"; });
  assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
  assert.deepEqual(ev, ["a:start", "a:end", "b:start", "b:end"]);
});

test("L2 다른 열쇠는 기다리지 않는다(다른 세션의 복원은 나란히 돈다)", async () => {
  const s = createKeyedSerializer();
  const ev: string[] = [];
  const a = s.run("t|box-1", async () => { ev.push("a:start"); await tick(20); ev.push("a:end"); });
  const b = s.run("t|box-2", async () => { ev.push("b:start"); await tick(1); ev.push("b:end"); });
  await Promise.all([a, b]);
  assert.ok(ev.indexOf("b:end") < ev.indexOf("a:end"), `다른 열쇠가 앞 일을 기다렸다: ${ev.join(",")}`);
});

test("L3 앞 일이 던져도 자물쇠는 풀린다 — 뒤 일은 돌고, 앞 일의 오류는 앞 호출자에게만 간다", async () => {
  const s = createKeyedSerializer();
  const a = s.run("t|box-1", async () => { await tick(5); throw new Error("boom"); });
  const b = s.run("t|box-1", async () => "B");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "B");
});

test("L4 다 끝나면 열쇠를 지운다(요청마다 쌓이지 않는다)", async () => {
  const s = createKeyedSerializer();
  const p1 = s.run("t|box-1", async () => { await tick(5); });
  const p2 = s.run("t|box-1", async () => { await tick(1); });
  assert.equal(s.size(), 1, "도는 동안은 열쇠 하나");
  await Promise.all([p1, p2]);
  assert.equal(s.size(), 0);
  await assert.rejects(s.run("t|box-2", async () => { throw new Error("x"); }));
  assert.equal(s.size(), 0, "던진 일 뒤에도 남지 않는다");
});

test("L5 셋이 줄 서면 온 순서대로 돈다 · wrap 은 인자에서 열쇠를 뽑아 같은 줄에 선다", async () => {
  const s = createKeyedSerializer();
  const ev: string[] = [];
  const handler = s.wrap((id: string) => `t|${id}`, async (id: string, tag: string) => { ev.push(`${tag}:start`); await tick(3); ev.push(`${tag}:end`); return tag; });
  const r = await Promise.all([handler("box-1", "x"), handler("box-1", "y"), handler("box-1", "z")]);
  assert.deepEqual(r, ["x", "y", "z"]);
  assert.deepEqual(ev, ["x:start", "x:end", "y:start", "y:end", "z:start", "z:end"]);
});

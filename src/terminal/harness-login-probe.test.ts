// 자격 파일 없는 하네스 구제 (#1631) — 엣지 표 행마다 한 검사.
//  사양: 파일 표가 비었을 때만 프로브 · true 만 합류 · 순서 보존 · 중복 없음.
import test from "node:test";
import assert from "node:assert/strict";
import { planLoginProbe, mergeProbeResults } from "./harness-login-probe.js";

const PROBE = ["antigravity"];

test("① 파일 표에 하나라도 있으면 프로브를 돌리지 않는다(비용 0 · 무회귀)", () => {
  assert.deepEqual(planLoginProbe(["claude"], PROBE), []);
  assert.deepEqual(planLoginProbe(["claude", "codex"], PROBE), []);
});

test("② 파일 표가 비면 프로브 후보를 전부 돌린다 — 그때가 «AI 안 이었음» 이라 말하려는 순간이다", () => {
  assert.deepEqual(planLoginProbe([], PROBE), ["antigravity"]);
});

test("③ 프로브 후보가 없으면 빈 배열", () => {
  assert.deepEqual(planLoginProbe([], []), []);
});

test("④ 빈 키는 후보에서 뺀다", () => {
  assert.deepEqual(planLoginProbe([], ["", "antigravity"]), ["antigravity"]);
});

test("⑤ 프로브가 true 면 합류한다 — 이게 제미나이만 이은 사람을 구하는 자리다", () => {
  assert.deepEqual(mergeProbeResults([], [{ key: "antigravity", loggedIn: true }]), ["antigravity"]);
});

test("⑥ false 는 합류하지 않는다", () => {
  assert.deepEqual(mergeProbeResults([], [{ key: "antigravity", loggedIn: false }]), []);
});

test("⑦ null(모름)은 지어내지 않는다 — 모름을 로그인으로 읽으면 죽은 세션이 열린다", () => {
  assert.deepEqual(mergeProbeResults([], [{ key: "antigravity", loggedIn: null }]), []);
});

test("⑧ 파일 표의 순서를 보존하고 뒤에 붙인다 — 순서가 헤드리스 선택의 동률 판정 근거다", () => {
  assert.deepEqual(
    mergeProbeResults(["claude", "codex"], [{ key: "antigravity", loggedIn: true }]),
    ["claude", "codex", "antigravity"],
  );
});

test("⑨ 이미 있는 키는 두 번 넣지 않는다", () => {
  assert.deepEqual(mergeProbeResults(["antigravity"], [{ key: "antigravity", loggedIn: true }]), ["antigravity"]);
});

test("⑩ 여럿 중 true 인 것만 합류한다", () => {
  assert.deepEqual(
    mergeProbeResults([], [{ key: "a", loggedIn: true }, { key: "b", loggedIn: false }, { key: "c", loggedIn: true }]),
    ["a", "c"],
  );
});

// ── 배선 단언 — 두 함수가 이어졌을 때 실제로 사람을 구하는지 ──
test("⑪ 이어 보면: 파일 표 0 + 제미나이 로그인 → 목록이 비지 않는다(리브가 열린다)", () => {
  const fileList: string[] = [];
  const todo = planLoginProbe(fileList, PROBE);
  assert.deepEqual(todo, ["antigravity"]);
  const merged = mergeProbeResults(fileList, todo.map((k) => ({ key: k, loggedIn: true })));
  assert.equal(merged.length > 0, true, "여기서 비면 planLivKickoff 가 skip 한다");
  assert.deepEqual(merged, ["antigravity"]);
});

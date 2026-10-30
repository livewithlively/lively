// #4783 — 이 판이 왜 끝났나(session-end.ts)의 판정 표를 고정한다. 사양: 엣지 표 A·C·E(스크래치패드 spec.md).
//  틀리면 티가 크다:
//   🔴 런처 보고를 잘못 읽으면 — tmux 를 닫을 때 생기는 129 를 «고장» 으로 적거나, 정상 /exit 를 «고장» 으로 적어 사이드바에 거짓 오류가 선다.
//   🔴 후보를 넓게 잡으면 — 멤버 PC 가 잠든 세션·옛 판·사람이 /exit 한 세션이 «고장(lost)» 확인 대상이 된다(확답이 막아 주지만 헛확인이 는다).
//   🔴 «봤나» 를 칸 하나 어긋나게 읽으면 — 안 본 결과가 있는데 «봤다» 로 적혀 꺼진 세션의 작업 완료 점이 사라진다(이번 신고의 바로 그 증상).
import { strict as assert } from "node:assert";
import test from "node:test";
import { endNoteOf, buildEndNote, harnessEndVerdict, isLostCandidate, endNoteForRow, lastResultSeenFrom, LAST_RESULT_SEEN_FMT, type LostCandidateFacts } from "./session-end.js";

test("E1 endNoteOf — 모양이 틀리면 null(지어내지 않는다) · 판 표식만 있는 값도 읽는다", () => {
  for (const v of [null, undefined, 3, "x", [], {}, { v: 2 }, { v: "1" }, { v: 1, why: "reclaim" }, { v: 1, why: "nope", at: 1 }, { v: 1, why: "stop", at: "1" }]) {
    assert.equal(endNoteOf(v), null, JSON.stringify(v));
  }
  assert.deepEqual(endNoteOf({ v: 1 }), { v: 1 });
  assert.deepEqual(endNoteOf({ v: 1, at: 10, why: "reclaim", seen: false, junk: "x" }), { v: 1, at: 10, why: "reclaim", seen: false });
  assert.deepEqual(endNoteOf({ v: 1, at: 10, why: "harness_crash", code: 137, by: "" }), { v: 1, at: 10, why: "harness_crash", code: 137 });
  assert.deepEqual(endNoteOf({ v: 1, at: 10, why: "stop", by: "me", code: 1.5 }), { v: 1, at: 10, why: "stop", by: "me" });
  assert.deepEqual(endNoteOf({ v: 1, at: 10, why: "launch_fail", code: 1, prov: true }), { v: 1, at: 10, why: "launch_fail", code: 1, prov: true });
  assert.deepEqual(endNoteOf({ v: 1, at: 10, why: "launch_fail", prov: "true" }), { v: 1, at: 10, why: "launch_fail" }, "참값 흉내는 임시로 안 읽는다");
});

test("E2 buildEndNote — 시각은 초 정수 · 준 칸만 싣는다", () => {
  assert.deepEqual(buildEndNote({ why: "reclaim" }, 100.9), { v: 1, at: 100, why: "reclaim" });
  assert.deepEqual(buildEndNote({ why: "stop", by: "u1" }, 5), { v: 1, at: 5, why: "stop", by: "u1" });
  assert.deepEqual(buildEndNote({ why: "reclaim", seen: false }, 5), { v: 1, at: 5, why: "reclaim", seen: false });
  assert.deepEqual(buildEndNote({ why: "harness_crash", code: 2 }, 5), { v: 1, at: 5, why: "harness_crash", code: 2 });
  assert.deepEqual(buildEndNote({ why: "launch_fail", code: 1, prov: true }, 5), { v: 1, at: 5, why: "launch_fail", code: 1, prov: true });
});

test("E3 harnessEndVerdict(표 A) — 종료코드 0 = 사람이 끝냄 · 0 아님 = 고장(기동 직후면 기동 실패) · 129 는 사유로 안 읽는다", () => {
  const T0 = 1_790_000_000;
  const cases: Array<[unknown, ReturnType<typeof harnessEndVerdict>]> = [
    [{ code: 0, quick: 0, t0: T0 }, { why: "harness_exit", code: 0, t0: T0, prov: false }],
    [{ code: 0, quick: 1, t0: T0 }, { why: "harness_exit", code: 0, t0: T0, prov: false }],        // 뜨자마자 /exit 해도 사람이 끝낸 것이다
    [{ code: 130, quick: 0, t0: T0 }, { why: "harness_exit", code: 130, t0: T0, prov: false }],    // Ctrl-C 로 끝냄 — 사람의 손짓
    [{ code: 1, quick: 1, t0: T0 }, { why: "launch_fail", code: 1, t0: T0, prov: true }],         // 기동 실패는 임시 — 셸이 남아 판이 이어질 수 있다
    [{ code: 1, quick: true, t0: T0 }, { why: "launch_fail", code: 1, t0: T0, prov: true }],
    [{ code: 1, quick: 0, t0: T0 }, { why: "harness_crash", code: 1, t0: T0, prov: false }],
    [{ code: 137, quick: 0, t0: T0 }, { why: "harness_crash", code: 137, t0: T0, prov: false }],  // 메모리 상한 초과(SIGKILL)
    [{ code: "3", quick: "1", t0: String(T0) }, { why: "launch_fail", code: 3, t0: T0, prov: true }],
    [{ code: 255, quick: 0, t0: T0 }, { why: "harness_crash", code: 255, t0: T0, prov: false }],  // 경계 — 가장 큰 코드
    [{ code: 129, quick: 0, t0: T0 }, null],                                           // tmux 가 판을 닫았다 — 닫은 자리가 적었다
    [{ code: 256, quick: 0, t0: T0 }, null],
    [{ code: -1, quick: 0, t0: T0 }, null],
    [{ code: 0.5, quick: 0, t0: T0 }, null],
    [{ code: 0, quick: 0 }, null],                                                     // 판을 가를 t0 가 없다
    [{ code: 0, quick: 0, t0: 0 }, null],
    [{ code: 0, quick: 0, t0: "abc" }, null],
    [[0, 0, T0], null],
    [null, null],
  ];
  for (const [body, want] of cases) assert.deepEqual(harnessEndVerdict(body), want, JSON.stringify(body));
});

const BASE: LostCandidateFacts = { id: "box-a", kind: "human", created: 1000, exited_at: null, superseded_by: null, discovered: false, node_id: null, end_note: { v: 1 } };
const CTX = { liveIds: new Set<string>(), managedIds: new Set<string>(), nowSec: 1000 + 600, graceSec: 180 };

test("E4 isLostCandidate(표 C) — v1 판 · 사유 없음 · 사람 세션 · 목록에 없음 · 판이 선 지 오래됨만 후보", () => {
  assert.equal(isLostCandidate(BASE, CTX), true, "기본 후보");
  assert.equal(isLostCandidate({ ...BASE, kind: null }, CTX), true, "kind 없음 = human(옛 행)");
  const no: Array<[string, Partial<LostCandidateFacts> | null, Partial<typeof CTX> | null]> = [
    ["옛 판(표식 없음)", { end_note: null }, null],
    ["이미 사유가 있다", { end_note: { v: 1, at: 5, why: "reclaim" } }, null],
    ["사람이 /exit 했다", { exited_at: "2026-10-16T00:00:00Z" }, null],
    ["이어진 옛 id", { superseded_by: "box-b" }, null],
    ["노드에서 발견한 행", { discovered: true }, null],
    ["멤버 PC 세션", { node_id: "laibeulliui-macmini" }, null],
    ["기계 세션", { kind: "task" }, null],
    ["만든 시각 모름", { created: null }, null],
    ["목록에 있다", null, { liveIds: new Set(["box-a"]) }],
    ["상시 세션", null, { managedIds: new Set(["box-a"]) }],
    ["갓 만든 판(유예 안 — 179초)", null, { nowSec: 1000 + 179 }],
  ];
  for (const [n, sp, cp] of no) assert.equal(isLostCandidate({ ...BASE, ...(sp || {}) }, { ...CTX, ...(cp || {}) }), false, n);
  assert.equal(isLostCandidate(BASE, { ...CTX, nowSec: 1000 + 180 }), true, "유예 경계(정확히 180초)는 후보");
});

test("E5 endNoteForRow — 사유가 있을 때만 · 판 표식·멈춘 사람은 화면에 안 싣는다", () => {
  assert.equal(endNoteForRow(null), undefined);
  assert.equal(endNoteForRow({ v: 1 }), undefined);
  assert.deepEqual(endNoteForRow({ v: 1, at: 9, why: "stop", by: "secret-id" }), { why: "stop", at: 9 });
  assert.deepEqual(endNoteForRow({ v: 1, at: 9, why: "reclaim", seen: false }), { why: "reclaim", at: 9, seen: false });
  assert.deepEqual(endNoteForRow({ v: 1, at: 9, why: "harness_crash", code: 1 }), { why: "harness_crash", at: 9, code: 1 });
});

test("E6 lastResultSeenFrom(표 E) — 마지막 작업이 마지막 붙음·열람보다 뒤면 안 본 결과 · 빈 칸은 0 · 모양이 틀리면 모름", () => {
  assert.equal(LAST_RESULT_SEEN_FMT.split("|").length, 3, "형식은 «|» 로 가른 세 칸");
  assert.equal(lastResultSeenFrom("100|200|150"), true, "열람(200)이 작업(150)보다 뒤 — 봤다");
  assert.equal(lastResultSeenFrom("300|0|250"), true, "붙음(300)이 작업보다 뒤 — 봤다");
  assert.equal(lastResultSeenFrom("100|120|150"), false, "작업이 둘보다 뒤 — 안 봤다");
  assert.equal(lastResultSeenFrom("|  |150"), false, "안 찍힌 옵션은 빈 칸 — 칸이 당겨지면 안 된다");
  assert.equal(lastResultSeenFrom("|150|"), true, "작업 칸이 비면(한 번도 작업 안 함) 볼 결과가 없다 — 열람 칸을 작업으로 읽으면 안 된다");
  assert.equal(lastResultSeenFrom("150|150|150"), true, "같은 시각(경계)은 본 것");
  assert.equal(lastResultSeenFrom("100|100|"), true, "한 번도 작업 안 함 — 볼 결과가 없다");
  assert.equal(lastResultSeenFrom("100 200 150"), undefined, "공백 구분(옛 형식)은 모름");
  assert.equal(lastResultSeenFrom(""), undefined);
  assert.equal(lastResultSeenFrom("1|2|3|4"), undefined);
});

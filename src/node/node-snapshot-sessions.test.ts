// 노드 스냅샷에서 세션을 모은다 — 「답 기다림」 알림 스윕의 새 입력 (#2600 T2 d4).
//
//  ── 왜 이 시험이 있나 ──
//  계수 실측(2026-09-08)에서 이 스윕이 게이트웨이 tmux 호출의 **64%** 였다 — 세션이 0개인 빈 시험
//   테넌트까지 테넌트당 정확히 16/창(사용량과 무관한 고정 주기). 그 자리를 노드 스냅샷으로 옮기는데,
//   **낡은 스냅샷을 그대로 쓰면 아무도 없는 세션에 「답을 기다려요」가 간다.** 그 실수를 막는 것이
//   이 시험이 지키는 것이고, 그래서 행이 전부 «넣지 않는다» 쪽에 몰려 있다.
//
//  엣지 표는 스크래치패드 `spec-snap.md` 의 10행 — 행마다 시나리오 하나.
import assert from "node:assert/strict";
import test from "node:test";
import { nodeSnapshotSessions } from "./self-node.js";

/** registry 의 `STATE_STALE_MS` 와 같은 값 — 목록 소유 판정과 **같은 자**를 쓴다는 것이 사양이다. */
const STALE = 12_000;

type Node = { online: boolean; stateAgeMs: number | null; sessions: readonly string[] };
/** 기본은 «자격 있는 노드» — 각 행은 **한 칸만** 뒤집어 그 칸이 무는지 본다. */
const node = (o: Partial<Node> = {}): Node => ({ online: true, stateAgeMs: 1_000, sessions: ["a"], ...o });

test("N1 온라인 + 신선하면 그 세션들을 모은다", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ sessions: ["a", "b"] })], STALE), ["a", "b"]);
});

test("N2 ★ 오프라인 노드의 세션은 넣지 않는다", () => {
  //  노드가 끊긴 뒤 마지막 스냅샷이 남아 있다. 그걸로 알림을 울리면 이미 없는 상태를 알린다.
  assert.deepEqual(nodeSnapshotSessions([node({ online: false })], STALE), []);
});

test("N3 ★ 상태를 아직 못 받은 노드(null)는 넣지 않는다", () => {
  //  ⚠ JS 에서 `null <= 12000` 은 **참**이다 — 이 행이 없으면 «스냅샷 없음» 이 «가장 신선함» 이 된다.
  assert.deepEqual(nodeSnapshotSessions([node({ stateAgeMs: null })], STALE), []);
});

test("N4 ★ 낡은 스냅샷은 넣지 않는다", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ stateAgeMs: STALE + 1 })], STALE), []);
});

test("N5 ★ 신선도 경계는 포함이다 — 목록 소유 판정과 같은 자", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ stateAgeMs: STALE })], STALE), ["a"]);
});

test("N10 방금 받은 스냅샷(나이 0)도 신선하다", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ stateAgeMs: 0 })], STALE), ["a"]);
});

test("N6 노드가 없으면 빈 배열", () => {
  assert.deepEqual(nodeSnapshotSessions([], STALE), []);
});

test("N7 자격 노드가 여럿이면 순서대로 이어붙인다", () => {
  //  한 테넌트에 세션 호스트와 멤버 PC 노드가 함께 있을 수 있다 — 둘 다 봐야 한다.
  assert.deepEqual(nodeSnapshotSessions(
    [node({ sessions: ["a"] }), node({ sessions: ["b", "c"] })], STALE), ["a", "b", "c"]);
});

test("N8 자격은 있지만 세션이 0개면 아무것도 안 보탠다", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ sessions: [] }), node({ sessions: ["z"] })], STALE), ["z"]);
});

test("N9 ★ 자격/무자격이 섞이면 무자격 노드의 세션이 새지 않는다", () => {
  const nodes = [
    node({ online: false, sessions: ["off"] }),
    node({ stateAgeMs: null, sessions: ["none"] }),
    node({ stateAgeMs: STALE + 1, sessions: ["old"] }),
    node({ sessions: ["ok"] }),
  ];
  assert.deepEqual(nodeSnapshotSessions(nodes, STALE), ["ok"]);
});

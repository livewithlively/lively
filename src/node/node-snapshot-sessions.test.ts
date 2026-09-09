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

type Node = { declared: boolean; online: boolean; stateAgeMs: number | null; sessions: readonly string[] };
/** 기본은 «자격 있는 노드» — 각 행은 **한 칸만** 뒤집어 그 칸이 무는지 본다. */
const node = (o: Partial<Node> = {}): Node =>
  ({ declared: true, online: true, stateAgeMs: 1_000, sessions: ["a"], ...o });

test("N1 온라인 + 신선하면 그 세션들을 모은다", () => {
  assert.deepEqual(nodeSnapshotSessions([node({ sessions: ["a", "b"] })], STALE), ["a", "b"]);
});

test("N11 ★★ 기본은 선언 없는 노드(멤버 PC)의 세션도 **넣는다** (#3741)", () => {
  //  ── 이 행은 2026-09-09 에 뜻이 뒤집혔다. 그 사연이 이 프로젝트의 핵심이라 남긴다. ──
  //  처음(#2600 T2 d4)엔 «넣지 않는다» 였다. 이유는 알림 폭풍이었다 — 이 스윕은 원래
  //   `listSessionsRaw`(게이트웨이 자기 tmux)만 봤고 멤버 PC 노드 세션은 **여기 없던 것**이라,
  //   넣으면 여태 못 보던 세션 수백 개가 한꺼번에 들어오는데 `pickAwaitingTransitions` 가
  //   처음 보는 세션이 awaiting 이면 곧바로 알림을 냈다(`previous.get(id) ?? false`).
  //  #3741 이 그 폭풍을 **원인 쪽에서** 막았다(첫 관측 유예 — notify-policy 의 P3·P-mass 행).
  //   그래서 이제 넣는 것이 맞다: 그 442개 세션이 이 알림을 한 번도 받은 적이 없었다.
  assert.deepEqual(nodeSnapshotSessions([node({ declared: false, sessions: ["member-pc"] })], STALE), ["member-pc"]);
});

test("N11b ★ declaredOnly=true 면 여전히 선언된 노드만 — 목록 소유 판정과 같은 뜻으로 쓰는 자리용", () => {
  const nodes = [node({ declared: false, sessions: ["member-pc"] }), node({ declared: true, sessions: ["host"] })];
  assert.deepEqual(nodeSnapshotSessions(nodes, STALE, true), ["host"]);
});

test("N11c ★ 선언 여부는 온라인·신선도를 **면제하지 않는다** — declaredOnly 든 아니든", () => {
  //  손잡이가 생기면서 «선언되면 통과» 로 읽힐 여지가 생겼다. 그 오독을 막는 행이다.
  const dead = [node({ declared: true, online: false, sessions: ["x"] })];
  assert.deepEqual(nodeSnapshotSessions(dead, STALE), []);
  assert.deepEqual(nodeSnapshotSessions(dead, STALE, true), []);
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

test("N9 ★ 자격/무자격이 섞이면 무자격 노드의 세션이 새지 않는다 (선언은 이제 자격 축이 아니다 — N11)", () => {
  const nodes = [
    node({ online: false, sessions: ["off"] }),
    node({ stateAgeMs: null, sessions: ["none"] }),
    node({ stateAgeMs: STALE + 1, sessions: ["old"] }),
    node({ sessions: ["ok"] }),
  ];
  assert.deepEqual(nodeSnapshotSessions(nodes, STALE), ["ok"]);
});

// ── 채택 사유 (#3741 후속) — 엣지 표 `spec-3741b.md` W1~W12 ──
//
//  왜 이 시험들이 있나: 배포 뒤 «노드 스냅샷 29개인데 스윕은 12개만 본다» 는 격차가 남았는데,
//   불리언으로 거르는 함수는 **왜 빠졌는지를 말하지 않는다.** 사유를 답하게 만든 것이 이 판정이고,
//   그 사유가 «좁혀 가는 순서» 로 하나만 나오는 것이 사양이다(둘을 동시에 답하면 계수가 못 읽는다).
import { nodeSnapshotVerdict } from "./self-node.js";

type Cand = { declared: boolean; online: boolean; stateAgeMs: number | null };
const cand = (o: Partial<Cand> = {}): Cand => ({ declared: true, online: true, stateAgeMs: 1_000, ...o });
const V = (o: Partial<Cand>, declaredOnly = false) => nodeSnapshotVerdict(cand(o), STALE, declaredOnly);

test("W1 정상이면 ok · 채택", () => {
  assert.deepEqual(V({}), { take: true, why: "ok" });
});

test("W2 ★ 선언 없는 노드도 기본은 채택된다 — #3741 이 연 문", () => {
  assert.deepEqual(V({ declared: false }), { take: true, why: "ok" });
});

test("W3 declaredOnly 를 켜면 선언 없는 노드는 undeclared 로 빠진다", () => {
  assert.deepEqual(V({ declared: false }, true), { take: false, why: "undeclared" });
});

test("W4 오프라인은 offline", () => {
  assert.deepEqual(V({ online: false }), { take: false, why: "offline" });
});

test("W5 ★ 스냅샷을 못 받았으면 no-state — stale 보다 **앞**이어야 한다", () => {
  //  JS 에서 `null <= staleMs` 는 참이다. 순서가 뒤집히면 «없음» 이 «가장 신선함» 으로 통과한다.
  assert.deepEqual(V({ stateAgeMs: null }), { take: false, why: "no-state" });
});

test("W6 낡은 스냅샷은 stale", () => {
  assert.deepEqual(V({ stateAgeMs: STALE + 1 }), { take: false, why: "stale" });
});

test("W7 ★ 신선도 경계는 포함이다", () => {
  assert.deepEqual(V({ stateAgeMs: STALE }), { take: true, why: "ok" });
  assert.deepEqual(V({ stateAgeMs: STALE + 1 }), { take: false, why: "stale" }, "경계 밖");
});

test("W8 방금 받은 스냅샷(0)도 신선하다", () => {
  assert.deepEqual(V({ stateAgeMs: 0 }), { take: true, why: "ok" });
});

test("W9 ★ 사유는 하나다 — 오프라인이면서 낡았으면 offline 이 먼저", () => {
  //  둘을 동시에 답하면 계수가 «어느 축이 문제인가» 를 못 읽는다. 좁혀 가는 순서가 그걸 정한다.
  assert.deepEqual(V({ online: false, stateAgeMs: STALE + 1 }), { take: false, why: "offline" });
});

test("W10 ★ 선언은 면제가 아니다 — 선언된 호스트라도 오프라인이면 빠진다", () => {
  assert.deepEqual(V({ declared: true, online: false }, true), { take: false, why: "offline" });
});

test("W11 ★ declaredOnly 가 켜지면 선언이 첫 관문이다", () => {
  assert.deepEqual(V({ declared: false, online: false, stateAgeMs: null }, true), { take: false, why: "undeclared" });
});

test("W12 ★★ 리팩터가 답을 바꾸지 않았다 — 섞인 판에서 종전과 같은 세션만 나온다", () => {
  //  판정을 밖으로 뺐으니 «답은 글자 그대로 같다» 를 못박는다(d6 의 V10 과 같은 자리).
  const nodes = [
    node({ declared: false, sessions: ["member-pc"] }),
    node({ online: false, sessions: ["off"] }),
    node({ stateAgeMs: null, sessions: ["none"] }),
    node({ stateAgeMs: STALE + 1, sessions: ["old"] }),
    node({ stateAgeMs: STALE, sessions: ["edge"] }),
    node({ sessions: ["ok"] }),
  ];
  assert.deepEqual(nodeSnapshotSessions(nodes, STALE), ["member-pc", "edge", "ok"]);
  assert.deepEqual(nodeSnapshotSessions(nodes, STALE, true), ["edge", "ok"], "손잡이도 그대로");
});

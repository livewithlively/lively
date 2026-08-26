// 세션 목록 병합 dedupe 테스트 (#1716) — 엣지 표의 각 행 = 시나리오 1개.
//  실측 재현(2026-08-15 dev): 게이트웨이와 노드 에이전트가 같은 머신·같은 tmux 서버를 공유하자
//  같은 세션 id 가 local(중앙 tmux) 과 remote(노드 스냅샷) 양쪽에 잡혀 AI 세션 탭에 카드가 2장씩 떴다.
import assert from "node:assert/strict";
import { mergeSessionViews } from "./session-merge.js";

interface Row { id: string; node?: { id: string; name: string; online: boolean } | null; restorable?: boolean }
const s = (id: string): Row => ({ id });
const n = (id: string, nodeId = "mac"): Row => ({ id, node: { id: nodeId, name: nodeId, online: false } });
const r = (id: string): Row => ({ id, restorable: true });
const ids = (rows: Row[]): string[] => rows.map((x) => x.id);

// ① 단독 — 병합해도 그대로.
assert.deepEqual(ids(mergeSessionViews([s("A")], [], [])), ["A"]);

// ② 버그 재현 — 중앙 tmux 와 노드 스냅샷에 같은 세션. 카드는 1장, 남는 쪽은 로컬(직접 관측).
//  ⚠ 다만 **실행 위치(node)는 물려받는다**(2026-08-26 상민님 신고). 위치는 배지가 아니라 좌표다: 빠지면 화면이
//   위치 없이 메타를 물어보고, 그 조회가 살아 있는 세션을 '복원 가능'(=죽음)이라 답한다(session-merge.ts 머리말).
{
  const out = mergeSessionViews([s("A")], [n("A")], []);
  assert.equal(out.length, 1, "같은 세션 id 는 한 번만 나열돼야 한다");
  assert.equal(out[0].node?.id, "mac", "이긴 로컬 행이 진 노드 행의 좌표를 물려받아야 한다");
}

// ②-b 진 행도 위치를 모르면 **위치 키를 만들지 않는다** — 승계 규칙이 새로 만든 엣지. 빈 값을 심으면
//  화면이 '노드 세션'으로 오독해 있지도 않은 노드로 입장을 릴레이한다.
{
  const out = mergeSessionViews([s("A")], [s("A")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].node, undefined, "물려받을 좌표가 없으면 그대로 없어야 한다");
  assert.equal("node" in out[0], false, "빈 값이라도 키를 만들지 않는다");
}

// ②-c 이긴 행의 위치가 **빈 값(null)** 이어도 '모른다'로 본다 — 경계값(undefined 만이 아니다).
{
  const out = mergeSessionViews([{ id: "A", node: null }], [n("A")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].node?.id, "mac", "null 은 '모른다' — 물려받아야 한다");
}

// ②-d 이긴 행이 이미 위치를 알면 **덮어쓰지 않는다**(라이브 관측이 자기 좌표의 정본).
{
  const out = mergeSessionViews([n("A", "node1")], [n("A", "node2")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].node?.id, "node1", "이긴 쪽의 좌표가 유지돼야 한다");
}

// ③ 노드 전용 세션은 그대로 — dedupe 가 원격 세션을 통째로 지워버리면 안 된다(회귀 금지).
{
  const out = mergeSessionViews([], [n("A")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].node?.id, "mac", "노드에서만 도는 세션은 node 정보를 달고 남아야 한다");
}

// ④ 라이브 관측 > 복원목록 기억 — 노드에 있는 세션이 중앙 desired-state 에도 남아 있으면 노드 쪽을 남긴다.
{
  const out = mergeSessionViews([], [n("A")], [r("A")]);
  assert.equal(out.length, 1);
  assert.ok(out[0].node, "복원목록이 아니라 노드 스냅샷이 남아야 한다");
  assert.equal(out[0].restorable, undefined);
}

// ⑤ 로컬 라이브 > 복원목록(종전 liveIds 규칙과 같은 결과 — 헬퍼로도 보장).
{
  const out = mergeSessionViews([s("A")], [], [r("A")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].restorable, undefined);
}

// ⑤-b 좌표는 물려받되 **상태는 안 물려받는다** — 생사 판정은 이긴(라이브) 출처가 정본이다.
//  물려받으면 지금 돌고 있는 세션이 화면에서 '중단됨'으로 뜨고, 열면 되살리기가 돈다.
{
  const out = mergeSessionViews([s("A")], [], [{ ...r("A"), node: { id: "mac", name: "mac", online: false } }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].restorable, undefined, "상태(restorable)는 물려받지 않는다");
  assert.equal(out[0].node?.id, "mac", "좌표(node)는 물려받는다");
}

// ⑥ id 가 다르면 전부 유지 — dedupe 가 서로 다른 세션을 삼키지 않는다.
assert.deepEqual(ids(mergeSessionViews([s("A")], [n("B")], [r("C")])), ["A", "B", "C"]);

// ⑦ 두 노드가 같은 tmux 를 공유(같은 id 를 각자 보고)해도 1장 — 먼저 온 노드가 남는다.
{
  const out = mergeSessionViews([], [n("A", "node1"), n("A", "node2")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].node?.id, "node1");
}

// ⑧ 출력 순서 = 그룹 순서(local → remote → restorable), 그룹 안에서는 입력 순서.
assert.deepEqual(ids(mergeSessionViews([s("A"), s("B")], [n("C")], [r("D")])), ["A", "B", "C", "D"]);

// ⑨ 빈 입력 — 세 출처가 모두 비어도 안전(노드 미연결·세션 0개인 새 조직).
assert.deepEqual(mergeSessionViews([], [], []), []);
assert.deepEqual(mergeSessionViews(), []);

// ⑩ 같은 그룹 안 중복도 접는다(방어 — 한 출처가 같은 세션을 두 번 실어 보내도 카드는 1장).
assert.deepEqual(ids(mergeSessionViews([s("A"), s("A")], [], [])), ["A"]);

console.log("session-merge tests passed");

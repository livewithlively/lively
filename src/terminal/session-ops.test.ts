// 세션 op 표 (#2600 T1) — 사양 `spec.md` B절, 엣지 표 15~17행.
//
// 이 표가 지키는 것: «세션 호스트가 실행하는 op» 의 경계가 **목록으로 말해진다**. 종전엔 그 경계가
//  `node/agent.ts` 의 switch 문 안에 노드 전용 op 와 섞여 있어서, 어디까지가 세션 몫인지 코드로
//  물을 수가 없었다(#2600 T2 의 매니지드 세션 호스트가 같은 표를 써야 한다 — 그때 필요한 게 이 경계다).
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_OPS, isSessionOp } from "./session-ops.js";
import { NODE_OPS } from "../node/protocol.js";

test("15행 · 목록 안의 op 는 전부 세션 op 다", () => {
  for (const op of SESSION_OPS) {
    assert.equal(isSessionOp(op), true, `${op} 가 세션 op 로 안 잡힌다`);
  }
  assert.equal(SESSION_OPS.length, 12, "표를 바꿨으면 이 수도 함께 바꿔라(무심코 늘어나는 걸 막는다)");
});

// 노드 전용 op 는 그 PC 의 것(파일·위탁 태스크·앱 워커·provision·대화 런타임)이라 세션 호스트의 몫이
//  아니다. 이게 참이 되면 매니지드 세션 호스트가 노드 전용 짐까지 들게 된다.
test("16행 · 노드 전용·미지의 op 는 세션 op 가 아니다", () => {
  const notSession = [
    "fsLs", "fsRead", "fsWrite", "fsMkdir", "prompts",
    "runTask", "watchTask", "tailTask",
    "startWorker", "stopWorker", "workerStatus", "stageWorkerChunk",
    "provision", "provisionStatus",
    "chatSend", "chatAnswer",
    "", "LIST", "kill ", "세션",
  ];
  for (const op of notSession) {
    assert.equal(isSessionOp(op), false, `${JSON.stringify(op)} 가 세션 op 로 잘못 잡힌다`);
  }
});

// 게이트웨이는 노드가 `hello.caps` 로 광고한 op 만 부른다. 세션 op 가 그 집합 밖에 있으면
//  구현은 있는데 아무도 못 부르는 코드가 된다(그 반대 — 광고만 하고 구현이 없는 것 — 은 500 이 된다).
test("17행 · 세션 op ⊆ 노드 프로토콜이 광고하는 op", () => {
  const advertised = new Set<string>(NODE_OPS as readonly string[]);
  const missing = SESSION_OPS.filter((op) => !advertised.has(op));
  assert.deepEqual(missing, [], `광고되지 않는 세션 op: ${missing.join(", ")}`);
});

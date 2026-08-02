// translateNodeRpcError 회귀(#1313 R46) — 세 호출부의 **서로 다른** 시맨틱을 공용화가 뭉개지 않았는지 못 박는다.
//  각 케이스의 기대값은 R46 이전 원문(terminal/routes.ts relayNodeOp · node/provision-remote.ts 2곳)의
//  상태코드·문구 리터럴을 그대로 옮긴 것이다 — 여기가 빨개지면 그건 '사용자에게 나가는 응답이 바뀌었다'는 뜻이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateNodeRpcError, type NodeRpcErrorMap } from "./rpc-error.js";

const NODE = "haru-mbp";

// ── 사이트 ① terminal/routes.ts relayNodeOp — offline 은 msg 동등성만(추가조건 없음). ──
const relayMap: NodeRpcErrorMap = {
  offline: "노드가 오프라인입니다 — 그 PC 의 lively 노드 연결을 확인하세요.",
  timeout: "노드 응답 시간 초과",
  unsupported: (op) => `이 노드의 에이전트가 낡아 '${op}' 를 지원하지 않습니다 — 그 PC 에서 노드를 다시 설치·업데이트하세요.`,
  failed: (m) => `노드에서 실행 실패: ${m}`,
};

// ── 사이트 ② provision-remote.ts dispatch — offline 추가조건 O, timeout/unsupported 분기 **없음**. ──
const dispatchMap = (online: boolean): NodeRpcErrorMap => ({
  offline: `노드 '${NODE}' 연결이 끊겨 provision 을 시작하지 못했습니다.`,
  offlineWhen: () => !online,
  failed: (m) => `노드 '${NODE}' provision 시작 실패: ${m}`,
});

// ── 사이트 ③ provision-remote.ts createProjectSessionOnNode — 추가조건 O + timeout + unsupported(고정 문구). ──
const createMap = (online: boolean): NodeRpcErrorMap => ({
  offline: `노드 '${NODE}' 연결이 끊겨 세션을 열지 못했습니다.`,
  offlineWhen: () => !online,
  timeout: `노드 '${NODE}' 응답 시간 초과 — 세션 생성을 확인하지 못했습니다.`,
  unsupported: () => `노드 '${NODE}' 의 에이전트가 낡아 세션 생성을 지원하지 않습니다 — 그 PC/서버에서 노드를 다시 설치·업데이트하세요.`,
  failed: (m) => `노드 '${NODE}' 세션 생성 실패: ${m}`,
});

const hit = (msg: string, map: NodeRpcErrorMap) => {
  const e = translateNodeRpcError(msg, map);
  return { status: e.status, message: e.message };
};

test("relayNodeOp 매핑 — 4분기 상태코드·문구", () => {
  assert.deepEqual(hit("node-offline", relayMap),
    { status: 409, message: "노드가 오프라인입니다 — 그 PC 의 lively 노드 연결을 확인하세요." });
  assert.deepEqual(hit("node-rpc-timeout", relayMap),
    { status: 504, message: "노드 응답 시간 초과" });
  assert.deepEqual(hit("node-unsupported-op:provision", relayMap),
    { status: 409, message: "이 노드의 에이전트가 낡아 'provision' 를 지원하지 않습니다 — 그 PC 에서 노드를 다시 설치·업데이트하세요." });
  assert.deepEqual(hit("spawn tmux ENOENT", relayMap),
    { status: 502, message: "노드에서 실행 실패: spawn tmux ENOENT" });
});

test("relayNodeOp 는 offline 추가조건이 없다 — 노드가 죽어도 msg 로만 판정", () => {
  // relayMap 에는 offlineWhen 이 없다. 다른 사이트처럼 '노드가 오프라인이면 무조건 409' 로 만들면 회귀다.
  assert.equal(hit("boom", relayMap).status, 502);
});

test("provision dispatch 매핑 — timeout 분기가 **없어** 504 가 아니라 502 로 나간다(현행 동작 고정)", () => {
  assert.deepEqual(hit("node-offline", dispatchMap(true)),
    { status: 409, message: `노드 '${NODE}' 연결이 끊겨 provision 을 시작하지 못했습니다.` });
  // ⚠ 여기가 이 항목의 핵심 — 공용화하면서 timeout 케이스를 '보태면' 502 → 504 로 동작이 바뀐다.
  assert.deepEqual(hit("node-rpc-timeout", dispatchMap(true)),
    { status: 502, message: `노드 '${NODE}' provision 시작 실패: node-rpc-timeout` });
  assert.deepEqual(hit("node-unsupported-op:provision", dispatchMap(true)),
    { status: 502, message: `노드 '${NODE}' provision 시작 실패: node-unsupported-op:provision` });
  assert.deepEqual(hit("boom", dispatchMap(true)),
    { status: 502, message: `노드 '${NODE}' provision 시작 실패: boom` });
});

test("provision dispatch — 노드가 오프라인이면 msg 와 무관하게 409(원문의 `|| !nodeOnline(nodeId)`)", () => {
  for (const msg of ["node-rpc-timeout", "node-unsupported-op:provision", "boom"]) {
    assert.deepEqual(hit(msg, dispatchMap(false)),
      { status: 409, message: `노드 '${NODE}' 연결이 끊겨 provision 을 시작하지 못했습니다.` });
  }
});

test("createProjectSessionOnNode 매핑 — 4분기 + 고정 unsupported 문구(op 미삽입)", () => {
  assert.deepEqual(hit("node-offline", createMap(true)),
    { status: 409, message: `노드 '${NODE}' 연결이 끊겨 세션을 열지 못했습니다.` });
  assert.deepEqual(hit("node-rpc-timeout", createMap(true)),
    { status: 504, message: `노드 '${NODE}' 응답 시간 초과 — 세션 생성을 확인하지 못했습니다.` });
  assert.deepEqual(hit("node-unsupported-op:create", createMap(true)),
    { status: 409, message: `노드 '${NODE}' 의 에이전트가 낡아 세션 생성을 지원하지 않습니다 — 그 PC/서버에서 노드를 다시 설치·업데이트하세요.` });
  assert.deepEqual(hit("boom", createMap(true)),
    { status: 502, message: `노드 '${NODE}' 세션 생성 실패: boom` });
  // 오프라인 추가조건이 timeout 보다 **먼저** 걸린다(원문 분기 순서).
  assert.deepEqual(hit("node-rpc-timeout", createMap(false)),
    { status: 409, message: `노드 '${NODE}' 연결이 끊겨 세션을 열지 못했습니다.` });
});

test("offlineWhen 은 msg==='node-offline' 이면 호출되지 않는다(원문 `||` 단축평가)", () => {
  let calls = 0;
  translateNodeRpcError("node-offline", { offline: "off", offlineWhen: () => { calls++; return false; }, failed: (m) => m });
  assert.equal(calls, 0);
  translateNodeRpcError("boom", { offline: "off", offlineWhen: () => { calls++; return false; }, failed: (m) => m });
  assert.equal(calls, 1);
});

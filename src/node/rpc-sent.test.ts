// nodeRpc 실패의 «보냈나»(`sent`)와 그걸 읽는 술어 (#2600 T2 d6 · #3773 PR1) — 엣지 표 P11·P12.
//
//  왜 따로 재나: 같은 `node-offline` 이 «안 보냈다»(연결 없음)와 «보낸 뒤 끊겼다»(응답 대기 중 연결 해제)를 둘 다 뜻했다.
//   치기(아웃박스)는 다시 보내면 같은 지시가 두 번 가므로, 받는 쪽은 «안 갔다» 가 확실할 때만 제 경로로 다시 해야 한다 —
//   그 근거가 이 표식이다. 그리고 메시지는 **그대로**여야 한다(deliver-prompt·routes·rpc-error 가 문자열로 가른다).
//  ⚠ 단위시험에서는 노드 연결을 만들 수 없다(`authNodeTokenDetailed` 가 DB 주소가 없으면 no-db 로 거절한다). 그래서 연결 없음은
//   **실제 호출**로, 연결이 있어야 나는 여섯 자리는 **자리별 배선**(메시지 리터럴이 있는 줄에 붙은 sent 값)으로 잰다.
//  엣지 표는 스크래치패드 `d6/pr1/spec.md`.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { nodeRpc } from "./registry.js";
import { rpcMaybeSent } from "./rpc-error.js";

test("★ P11 연결 없는 노드 — 보내지 않았다(sent=false) · 메시지는 그대로 node-offline · 읽는 쪽도 «안 갔다»", async () => {
  const err = await nodeRpc("node-not-connected-3773", "outboxStep", { step: "peek", id: "box-a" }).then(
    () => assert.fail("연결 없는 노드에 RPC 가 성공했다"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, "nodeRpc 가 Error 가 아닌 것을 던졌다");
  assert.equal(err.message, "node-offline", "메시지가 바뀌면 deliver-prompt·routes 의 문자열 분기가 조용히 빗나간다");
  assert.equal((err as Error & { sent?: unknown }).sent, false, "연결이 없어 안 보냈는데 «보냈나» 표식이 false 가 아니다");
  assert.equal(rpcMaybeSent(err), false, "새기는 쪽(registry)과 읽는 쪽(rpc-error)이 어긋났다");
});

test("★ P11 연결이 있어야 나는 자리 — 미지원·ws.send 예외는 false, 시간 초과·응답 전 끊김·원격 오류는 true, 메시지는 그대로", () => {
  const lines = readFileSync(new URL("../../src/node/registry.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const sentOf = (l: string): boolean | null => {
    const m = /\{\s*sent:\s*(true|false)\s*\}/.exec(l);
    return m ? m[1] === "true" : null;
  };
  //  메시지 리터럴로 자리를 찾는다 — 메시지가 한 글자라도 바뀌면 자리를 못 찾아 여기서 빨간불이 난다(= 메시지 불변 단언).
  const expectSent = (what: string, re: RegExp, sent: boolean, count = 1): void => {
    const hit = lines.filter((l) => re.test(l));
    assert.equal(hit.length, count, `${what} 자리를 ${hit.length}곳 찾았다(기대 ${count}) — 메시지가 바뀌었거나 자리가 옮겨졌다`);
    for (const l of hit) assert.equal(sentOf(l), sent, `${what}: sent 가 ${sent} 여야 한다 — ${l.trim()}`);
  };
  expectSent("연결 없음", /throw\b.*new Error\("node-offline"\)/, false);
  expectSent("미지원 op", /new Error\(`node-unsupported-op:\$\{op\}`\)/, false);
  expectSent("ws.send 예외", /c\.ws\.send\(JSON\.stringify\(msg\)\)/, false);
  expectSent("시간 초과", /new Error\("node-rpc-timeout"\)/, true);
  expectSent("원격 오류", /new Error\(m\.error \|\| "node-op-failed"\)/, true);
  expectSent("응답 전 끊김(연결 해제·노드 삭제)", /p\.reject\(.*new Error\("node-offline"\)/, true, 2);
  //  표식 없이 reject 하는 자리가 남으면 그 실패는 «갔을 수 있다» 로만 읽힌다 — 안 보낸 실패를 못 가른다.
  assert.deepEqual(lines.filter((l) => /\breject\(\s*(new Error\(|e as Error\))/.test(l)), [], "«보냈나» 표식 없이 reject 하는 자리가 남아 있다");
});

test("★ P12 rpcMaybeSent — 엄격히 sent === false 일 때만 «안 갔다», 표식이 없거나 모르는 값이면 «갔을 수 있다»(안전 쪽)", () => {
  assert.equal(rpcMaybeSent(Object.assign(new Error("node-offline"), { sent: false })), false);
  assert.equal(rpcMaybeSent({ sent: false }), false, "Error 가 아니어도 표식이 false 면 안 갔다");
  assert.equal(rpcMaybeSent(Object.assign(new Error("node-offline"), { sent: true })), true);
  for (const unknown of [new Error("node-rpc-timeout"), "node-offline", null, undefined, 0, { sent: 0 }, { sent: "false" }, { sent: null }]) {
    assert.equal(rpcMaybeSent(unknown), true,
      `표식이 없거나 엄격한 false 가 아닌데 «안 갔다» 로 읽었다: ${unknown instanceof Error ? unknown.message : JSON.stringify(unknown)} — 다시 보내 두 번 갈 수 있다`);
  }
});

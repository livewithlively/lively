// 이 세션의 일을 어느 세션 호스트에 맡길까 — 순수 판정 `sessionHostTarget` (#2600 T2 d6 3판).
//
//  ── 무엇을 지키나 ──
//  맡길 곳을 틀리면 두 방향으로 조용히 틀린다. ① 자격 없는(끊긴·낡은) 호스트나 그 세션을 모르는 호스트에 맡기면
//   호스트가 «그런 세션 없다» 로 실패한다. ② 멤버 PC 좌표를 세션 호스트로 읽으면 d6 이 두 번 고친 «좌표 = 저쪽 기계»
//   실수의 반대편(저쪽 기계를 같은 tmux 로)이 된다. 그래서 표의 대부분이 «null(종전 경로)» 쪽이고, 각 행은 한 칸만 뒤집는다.
//  엣지 표는 스크래치패드 `d6/spec-active-relay.md` 의 A1~A9.
import assert from "node:assert/strict";
import test from "node:test";
import { sessionHostTarget } from "./self-node.js";

const HOST = "sesshost-acme-i-0abc";

/** 기본은 «자격 있는 호스트가 그 세션을 보고 있고 op 를 안다» — 각 행은 한 칸만 바꾼다. */
function base(o: Partial<Parameters<typeof sessionHostTarget>[0]> = {}): Parameters<typeof sessionHostTarget>[0] {
  return {
    sessionId: "box-a",
    nodeId: HOST,
    isSessionHost: (id) => id === HOST,
    liveIds: (id) => (id === HOST ? ["box-a", "box-b"] : null),
    supports: (id) => id === HOST,
    ...o,
  };
}

test("A1 스냅샷 좌표가 없으면 맡기지 않는다", () => {
  assert.deepEqual(sessionHostTarget(base({ nodeId: null })), { host: null, why: "no-coordinate" });
});

test("A2 좌표가 공백뿐이면 좌표가 없는 것이다(빈 문자열을 호스트 id 로 쓰지 않는다)", () => {
  assert.deepEqual(sessionHostTarget(base({ nodeId: "   " })), { host: null, why: "no-coordinate" });
});

test("A3 ★ 멤버 PC 좌표는 세션 호스트가 아니다 — 저쪽 기계를 같은 tmux 로 읽지 않는다", () => {
  const r = sessionHostTarget(base({ nodeId: "haruui-macbookair" }));
  assert.deepEqual(r, { host: null, why: "not-host" });
});

test("A4 ★ 선언 호스트라도 지금 자격이 없으면(끊김·낡음) 맡기지 않는다", () => {
  const r = sessionHostTarget(base({ liveIds: () => null }));
  assert.deepEqual(r, { host: null, why: "unqualified" });
});

test("A5 ★ 자격 호스트의 관측에 그 세션이 없으면 맡기지 않는다 — 방금 만든 3초 창·이사 중", () => {
  const r = sessionHostTarget(base({ sessionId: "box-new" }));
  assert.deepEqual(r, { host: null, why: "absent" });
});

test("A6 경계: 자격 호스트가 본 세션이 0개면 그 세션도 없는 것이다", () => {
  const r = sessionHostTarget(base({ liveIds: () => [] }));
  assert.deepEqual(r, { host: null, why: "absent" });
});

test("A7 그 op 를 모르는 호스트(구 번들)에는 보내지 않는다 — unknown op 문자열이 돌아온다", () => {
  const r = sessionHostTarget(base({ supports: () => false }));
  assert.deepEqual(r, { host: null, why: "unsupported" });
});

test("A8 전부 성립하면 그 호스트 id", () => {
  assert.deepEqual(sessionHostTarget(base()), { host: HOST, why: "ok" });
});

test("A9 [배선] 판정 재료를 정리된 id 로 묻고, 답도 정리된 id 다", () => {
  const asked: string[] = [];
  const r = sessionHostTarget(base({
    nodeId: `  ${HOST}  `,
    isSessionHost: (id) => { asked.push(`host:${id}`); return id === HOST; },
    liveIds: (id) => { asked.push(`live:${id}`); return id === HOST ? ["box-a"] : null; },
    supports: (id) => { asked.push(`op:${id}`); return id === HOST; },
  }));
  assert.deepEqual(r, { host: HOST, why: "ok" });
  assert.deepEqual(asked, [`host:${HOST}`, `live:${HOST}`, `op:${HOST}`], "재료를 공백 섞인 id 로 물었거나 순서를 건너뛰었다");
});

// #3870 — 세션 옮기기를 누가 할 수 있나 · 누구 이름으로 실행하나 (원준 2026-09-30 «초대받은 사람도 되게»).
//   🔴 초대를 안 보면 — 초대받은 사람이 눌러도 403(종전 동작 — 신고 그 자체).
//   🔴 요청자 이름으로 실행하면 — 실행 세션 행이 주인 것이라 claim 이 실패해 403(«다른 사용자의 실행 세션 id»), 노드는 «본인 세션이 아닙니다».
//   🔴 초대 없이 통과시키면 — 아무나 남의 세션 소속을 바꾼다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { sessionMoveAuth, MOVE_FORBIDDEN } from "./session-move-auth.js";

test("M1 노드 세션 — 주인은 주인 이름으로", () => {
  assert.deepEqual(sessionMoveAuth({ me: "jang", node: true, st: { owner: "jang", invites: [] } }), { ok: true, owner: "jang" });
});

test("M2 ★노드 세션 — 초대받은 사람도 되고, 실행은 **주인 이름**으로", () => {
  assert.deepEqual(sessionMoveAuth({ me: "yoon", node: true, st: { owner: "jang", invites: ["yoon"] }, invited: true }), { ok: true, owner: "jang" },
    "🔴 초대받은 사람이 거절됐거나 요청자 이름으로 실행된다");
  assert.equal((sessionMoveAuth({ me: "yoon", node: true, st: { owner: "jang", invites: ["yoon"] }, invited: false }) as { status: number }).status, 403,
    "🔴 명단엔 있어도 입장 판정(canAttach — 그 프로젝트 공개범위)이 막으면 못 옮긴다");
});

test("M3 노드 세션 — 초대받지 않은 사람은 403 · 행이 없으면 404(쓰기 전에 막는다)", () => {
  assert.deepEqual(sessionMoveAuth({ me: "kim", node: true, st: { owner: "jang", invites: ["yoon"] } }), { ok: false, status: 403, message: MOVE_FORBIDDEN });
  assert.equal((sessionMoveAuth({ me: "kim", node: true, st: { owner: "jang", invites: null } }) as { status: number }).status, 403, "초대 명단 없음 = 아무도 아니다");
  assert.equal((sessionMoveAuth({ me: "jang", node: true, st: null }) as { status: number }).status, 404);
});

test("M4 ★박스 세션 — 초대받은 사람(canAttach)도 되고, 실행은 주인 이름으로 · 아니면 403", () => {
  assert.deepEqual(sessionMoveAuth({ me: "jang", node: false, localOwner: "jang" }), { ok: true, owner: "jang" });
  assert.deepEqual(sessionMoveAuth({ me: "yoon", node: false, localOwner: "jang", invited: true }), { ok: true, owner: "jang" });
  assert.equal((sessionMoveAuth({ me: "kim", node: false, localOwner: "jang", invited: false }) as { status: number }).status, 403);
  assert.equal((sessionMoveAuth({ me: "kim", node: false, localOwner: "jang" }) as { status: number }).status, 403, "초대 판정 생략 = 아니다(fail-closed)");
});

test("M5 박스에 없는 세션 — 외부 실행의 제 문맥만 자기 이름으로, 나머지는 404", () => {
  assert.deepEqual(sessionMoveAuth({ me: "codex-abc", node: false, localOwner: "", externalSelf: true }), { ok: true, owner: "codex-abc" });
  assert.equal((sessionMoveAuth({ me: "jang", node: false, localOwner: "" }) as { status: number }).status, 404);
});

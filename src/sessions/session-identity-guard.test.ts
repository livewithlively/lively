// 세션 신원 어긋남 막기(#4135, 2026-09-28) — 판정 표와 거절 동작.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mismatchMessage, requireSessionWriter, resetSessionIdentityGuardCache, sessionOwnerMismatch, type GuardRow } from "./session-identity-guard.js";

const row = (over: Partial<GuardRow> = {}): GuardRow => ({ owner: "wonjoon-jang", invites: [], discovered: false, kind: "human", ...over });
const SID = "box-wonjoon-jang-b921bf9e";

test("G1 판정 표 — 세션을 연 사람과 토큰의 사람이 다를 때만 어긋남이다", () => {
  assert.equal(sessionOwnerMismatch("sangmin-yoon", row()), "wonjoon-jang", "공용 컴퓨터의 로그인으로 온 요청");
  assert.equal(sessionOwnerMismatch("wonjoon-jang", row()), null, "세션을 연 사람 본인");
  assert.equal(sessionOwnerMismatch("sangmin-yoon", row({ invites: ["sangmin-yoon"] })), null, "초대받아 들어온 사람은 자기 이름으로 쓴다");
  assert.equal(sessionOwnerMismatch("sangmin-yoon", row({ discovered: true })), null, "게이트웨이가 주인을 확인한 적 없는 세션");
  assert.equal(sessionOwnerMismatch("sangmin-yoon", null), null, "기록에 없는 세션");
  assert.equal(sessionOwnerMismatch("sangmin-yoon", row({ owner: "" })), null, "주인 미상");
  assert.equal(sessionOwnerMismatch("", row()), null, "토큰의 사람 미상");
  for (const kind of ["task", "managed", "app", "login"]) {
    assert.equal(sessionOwnerMismatch("sangmin-yoon", row({ kind })), null, `${kind} 세션은 보지 않는다`);
  }
  assert.equal(sessionOwnerMismatch("sangmin-yoon", row({ kind: null })), "wonjoon-jang", "종류 미상(옛 행)은 사람 세션으로 읽는다");
});

test("G2 거절 — 어긋나면 409 · 문장에 두 사람과 세션, 다시 시도하라는 말이 있다", async () => {
  resetSessionIdentityGuardCache();
  const deps = { load: async () => row(), now: () => 1_000 };
  await assert.rejects(() => requireSessionWriter("sangmin-yoon", SID, deps), (e: any) => {
    assert.equal(e.status ?? e.statusCode, 409);
    assert.match(e.message, /wonjoon-jang/);
    assert.match(e.message, /sangmin-yoon/);
    assert.match(e.message, new RegExp(SID));
    assert.match(e.message, /다시 보내세요/);
    assert.match(e.message, /다른 사람 이름으로는 기록하지 마세요/);
    return true;
  });
  assert.equal(mismatchMessage(SID, "a", "b").includes("읽기는 됩니다"), true);
});

test("G3 통과 — 본인·세션 없음·토큰 미상은 세션 기록을 읽지도 않거나 그대로 지나간다", async () => {
  resetSessionIdentityGuardCache();
  let loads = 0;
  const deps = { load: async () => { loads++; return row(); }, now: () => 1_000 };
  await requireSessionWriter("wonjoon-jang", SID, deps);
  await requireSessionWriter("sangmin-yoon", "", deps);
  await requireSessionWriter("", SID, deps);
  await requireSessionWriter("sangmin-yoon", undefined, deps);
  assert.equal(loads, 1, "세션도 토큰도 있는 요청에만 기록을 읽는다");
});

test("G4 세션 기록을 못 읽으면 막지 않는다 — 근거 없이 쓰기를 멈추지 않는다", async () => {
  resetSessionIdentityGuardCache();
  const deps = { load: async () => { throw new Error("db down"); }, now: () => 1_000 };
  await assert.doesNotReject(() => requireSessionWriter("sangmin-yoon", SID, deps));
});

test("G5 기억 — 몇 초 안의 같은 세션은 다시 읽지 않고, 지나면 다시 읽는다(신원이 도착한 뒤엔 토큰의 사람이 바뀌어 통과한다)", async () => {
  resetSessionIdentityGuardCache();
  let loads = 0; let t = 1_000;
  const deps = { load: async () => { loads++; return row(); }, now: () => t };
  await assert.rejects(() => requireSessionWriter("sangmin-yoon", SID, deps));
  await assert.rejects(() => requireSessionWriter("sangmin-yoon", SID, deps));
  assert.equal(loads, 1);
  await requireSessionWriter("wonjoon-jang", SID, deps);   // 세션 신원이 도착했다 — 같은 기억으로도 통과
  assert.equal(loads, 1);
  t += 6_000;
  await assert.rejects(() => requireSessionWriter("sangmin-yoon", SID, deps));
  assert.equal(loads, 2);
});

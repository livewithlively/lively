// 세션 초대의 두 끝(#3870) — 초대 알림의 받는 사람 · 문구 · 나가기 판정의 엣지 표, 그리고 라우트 배선.
//
//  N1 새로 들어온 사람만 — 이전 명단에 있던 사람 · 주인 · 저장한 사람은 빠진다
//  N2 이전 명단을 모르면(null) 다음 명단 전부가 새로 — 모른다고 알림을 삼키지 않는다(되풀이는 dedupe 가 막는다)
//  N3 빼기만 했으면 아무도 없다 · 중복 · 빈 값은 걸러진다
//  T1 문구 — «누가(조사) «세션 이름» 세션에 나를 초대했어요» · 이름이 없으면 이름 없이 · 링크는 세션 화면
//  L1 만든 사람 — 403 (나가는 길이 없다) · L2 명단에 없는 사람 — 409 · L3 행 없음 — 404 · L4 초대받은 사람 — 통과
//  W1 나 하나만 뺀다 — 다른 사람의 자리 · 순서는 그대로
//  K1 알림 종류 invite 가 있고 「확인할 것」 에 선다
//  R1 수정 라우트 — 이전 명단을 저장 **전에** 읽고, 저장(노드 릴레이 · editSession) **뒤에** 알린다 · 보낸 수를 답에 싣는다
//  R2 나가기 라우트 — 거절 판정이 어떤 쓰기보다 먼저 · 실행은 주인 이름으로 · DB 행은 늘 고친다
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inInbox, NOTIFY_KINDS } from "../apps/notify-policy.js";
import { inviteNotifyText, invitesWithout, leaveRefusal, newInvitees, sessionHref } from "./session-invite.js";

test("N1 새로 들어온 사람만", () => {
  assert.deepEqual(newInvitees(["kim"], ["kim", "lee", "park"], "jang", "jang"), ["lee", "park"]);
  assert.deepEqual(newInvitees([], ["jang", "lee"], "jang", "jang"), ["lee"], "주인은 받지 않는다");
  assert.deepEqual(newInvitees([], ["lee", "yoon"], "jang", "yoon"), ["lee"], "저장한 사람은 받지 않는다");
});

test("N2 이전 명단을 모르면 다음 명단 전부", () => {
  assert.deepEqual(newInvitees(null, ["lee", "park"], "jang", "jang"), ["lee", "park"]);
  assert.deepEqual(newInvitees(undefined, ["lee"], "jang", "jang"), ["lee"]);
});

test("N3 빼기만 · 중복 · 빈 값", () => {
  assert.deepEqual(newInvitees(["lee", "park"], ["lee"], "jang", "jang"), []);
  assert.deepEqual(newInvitees([], ["lee", "lee", "", "  "], "jang", "jang"), ["lee"]);
  assert.deepEqual(newInvitees([], null, "jang", "jang"), []);
});

test("T1 문구 · 링크", () => {
  const a = inviteNotifyText("장원준", "온보딩 설계");
  assert.equal(a.title, "장원준이 «온보딩 설계» 세션에 나를 초대했어요");
  assert.ok(a.body.length > 0);
  assert.equal(inviteNotifyText("윤상민", "  ").title, "윤상민이 세션에 나를 초대했어요");
  assert.equal(inviteNotifyText("Charles", "x").title, "Charles가 «x» 세션에 나를 초대했어요");
  assert.equal(sessionHref("box-jang-1"), "#/s/box-jang-1");
});

test("L1~L4 나가기 판정", () => {
  assert.equal(leaveRefusal({ owner: "jang", invites: ["lee"] }, "jang")?.status, 403, "만든 사람은 못 나간다");
  assert.equal(leaveRefusal({ owner: "jang", invites: ["jang", "lee"] }, "jang")?.status, 403, "명단에 자기가 끼어 있어도 만든 사람은 못 나간다");
  assert.equal(leaveRefusal({ owner: "jang", invites: ["lee"] }, "park")?.status, 409, "명단에 없으면 나갈 자리가 없다");
  assert.equal(leaveRefusal({ owner: "jang", invites: null }, "park")?.status, 409);
  assert.equal(leaveRefusal(null, "lee")?.status, 404);
  assert.equal(leaveRefusal({ owner: "jang", invites: ["lee", "park"] }, "lee"), null);
});

test("W1 나 하나만 뺀다", () => {
  assert.deepEqual(invitesWithout(["park", "lee", "kim"], "lee"), ["park", "kim"]);
  assert.deepEqual(invitesWithout(null, "lee"), []);
});

test("K1 알림 종류 invite", () => {
  assert.ok((NOTIFY_KINDS as readonly string[]).includes("invite"));
  assert.equal(inInbox("invite"), true);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
//  주석을 걷고 본다 — 주석 속 낱말이 배선 단언을 속이지 않게.
const ROUTES = fs.readFileSync(path.resolve(ROOT, process.env.ROUTES_SRC || "src/terminal/routes.ts"), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
const routeBody = (head: string): string => {
  const at = ROUTES.indexOf(head);
  assert.ok(at > 0, `라우트가 없다: ${head}`);
  return ROUTES.slice(at, ROUTES.indexOf("\n  app.", at + head.length));
};

test("R1 수정 라우트 — 저장 전에 읽고 저장 뒤에 알린다", () => {
  const b = routeBody('app.post("/api/ui/terminal/sessions/:id", auth');
  const readAt = b.indexOf("getSessionState(req.params.id)");
  const relayAt = b.indexOf('relayNodeOp(nodeId, "edit"');
  const editAt = b.indexOf("await editSession(");
  const nodeAnnounce = b.indexOf("await announce(invites, me)");
  const localAnnounce = b.indexOf("await announce(edited.invites");
  assert.ok(readAt > 0 && readAt < relayAt && readAt < editAt, "이전 명단을 저장 전에 읽어야 한다");
  assert.ok(relayAt > 0 && nodeAnnounce > relayAt, "노드 세션 — 릴레이(주인 판정) 뒤에 알린다");
  assert.ok(editAt > 0 && localAnnounce > editAt, "중앙 세션 — editSession(주인 판정) 뒤에 알린다");
  assert.match(b, /notifySessionInvitees\(/);
  assert.match(b, /res\.json\(\{ ok: true, notified \}\)/);
});

test("R2 나가기 라우트 — 거절이 먼저 · 주인 이름 · DB 행", () => {
  const b = routeBody('app.post("/api/ui/terminal/sessions/:id/leave"');
  const refuseAt = b.indexOf("leaveRefusal(");
  const firstWrite = Math.min(...["relayNodeOp(", "editSession(", "updateSessionStateMeta("].map((k) => b.indexOf(k)).filter((i) => i > 0));
  assert.ok(refuseAt > 0 && refuseAt < firstWrite, "거절 판정이 쓰기보다 먼저여야 한다");
  assert.match(b, /user: \{ userId: owner \}/, "노드 릴레이는 주인 이름으로");
  assert.match(b, /editSession\(\{ userId: owner/, "중앙 세션도 주인 이름으로");
  assert.match(b, /await updateSessionStateMeta\(id, \{ invites: next \}\)/, "DB 행은 늘 고친다(입장 판정 · 복원의 정본)");
});

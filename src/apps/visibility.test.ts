// 앱 공개 범위(#4632) — 순수 판정표. 이게 틀리면: 「나만」 앱이 남에게 보이거나(V2), 만든 사람이 제 앱을 못 보거나(V3·V4),
//  칸이 깨진 앱이 통째로 잠긴다(V6).
import { strict as assert } from "node:assert";
import test from "node:test";
import { appOwnerIds, appVisibilityDenial, appVisibilityOf, appVisibleTo, canSetAppVisibility, isAppOwner } from "./visibility.js";

const app = (over: Record<string, unknown> = {}) => ({ id: "memo", title: "메모", installed_by: "alice", manifest: {}, visibility: "me", ...over });
const alice = { userId: "alice", scopes: ["items"] };
const bob = { userId: "bob", scopes: ["items"] };
const admin = { userId: "carol", scopes: ["items", "admin"] };

test("V1 'all' 은 누구에게나 보인다(모르는 사람 · 빈 사람도)", () => {
  assert.equal(appVisibleTo(app({ visibility: "all" }), bob), true);
  assert.equal(appVisibleTo(app({ visibility: "all" }), { userId: "" }), true);
  assert.equal(appVisibilityDenial(app({ visibility: "all" }), bob), null);
});
test("V2 'me' 는 다른 구성원에게 안 보인다 — 까닭에 앱 이름과 「나만」", () => {
  assert.equal(appVisibleTo(app(), bob), false);
  const why = appVisibilityDenial(app(), bob);
  assert.ok(why && why.includes("「메모」") && why.includes("나만"), why ?? "");
});
test("V3 'me' 는 installed_by 에게 보인다", () => {
  assert.equal(appVisibleTo(app(), alice), true);
  assert.equal(appVisibilityDenial(app(), alice), null);
});
test("V4 'me' 는 매니페스트 studio.made_by 에게도 보인다(세션의 AI 가 대신 저장한 앱)", () => {
  const a = app({ installed_by: "agent-token", manifest: { studio: { made_by: "alice" } } });
  assert.equal(appVisibleTo(a, alice), true);
  assert.equal(appVisibleTo(a, bob), false);
  assert.deepEqual(appOwnerIds(a), ["agent-token", "alice"]);
});
test("V5 'me' 는 관리자에게 보인다", () => {
  assert.equal(appVisibleTo(app(), admin), true);
});
test("V6 모르는 값 · 빈 칸은 'all' 로 읽는다(잠그는 쪽으로 틀리지 않는다)", () => {
  assert.equal(appVisibilityOf({ visibility: "private" }), "all");
  assert.equal(appVisibilityOf({}), "all");
  assert.equal(appVisibilityOf({ visibility: "me" }), "me");
  assert.equal(appVisibleTo(app({ visibility: "zzz" }), bob), true);
});
test("V7 빈 사람 · 빈 주인은 주인이 아니다", () => {
  assert.equal(isAppOwner(app({ installed_by: "" }), { userId: "" }), false);
  assert.equal(appVisibleTo(app({ installed_by: null }), { userId: "" }), false);
  assert.deepEqual(appOwnerIds(app({ installed_by: " ", manifest: { studio: { made_by: "" } } })), []);
});
test("V8 공개 범위 바꾸기 — 만든 사람 · 관리자만", () => {
  assert.equal(canSetAppVisibility(app(), alice), true);
  assert.equal(canSetAppVisibility(app(), admin), true);
  assert.equal(canSetAppVisibility(app(), bob), false);
  assert.equal(canSetAppVisibility(app({ installed_by: "x", manifest: { studio: { made_by: "bob" } } }), bob), true);
});
test("V9 까닭 글은 이름이 없으면 「이 앱」", () => {
  const why = appVisibilityDenial(app({ title: "", id: "" }), bob);
  assert.ok(why && why.includes("「이 앱」"), why ?? "");
});

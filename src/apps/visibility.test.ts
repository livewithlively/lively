import { strict as assert } from "node:assert";
import test from "node:test";
import {
  appViewFor, appVisibilityOf, canSeeApp, declaredTableNames, draftAppIdFrom, draftByAfterInstall, isAppOwner, isEmptyDraftApp, listsAppFor,
  publishDenial, tablesGoneAtPublish, tablesUsableNow, unpublishDenial, type AppVisState,
} from "./visibility.js";
import { APP_ID_RE } from "./manifest.js";

// ── 앱 공개 범위 · 만든 사람 · 책임자 (#4632 「나만」 · #4667 앱 v2-15) — 사양 엣지 표 E1~E14 · E18~E21 · E28~E31 ──────────
//  이게 틀리면: 남이 만들고 있는 앱이 앱 찾기·세션에 뜨거나(나만 보는 앱이 샌다) · 공개 앱을 고치는 순간 모두의 앱이 바뀌거나(초안이 샌다) ·
//   반대로 초안을 만든 사람이 제 초안을 못 보거나 · 떠난 사람의 앱을 아무도 책임지지 않거나 · 칸이 깨진 앱이 통째로 잠긴다(#4632 V6).

const app = (o: Partial<AppVisState> & { title?: string } = {}): AppVisState & { title?: string } =>
  ({ visibility: "all", owner_member: "maker", draft_by: null, published_version_no: null, content_hash: "h1", ...o });
const maker = { userId: "maker", scopes: ["memory"] };
const other = { userId: "other", scopes: ["memory"] };
const admin = { userId: "boss", scopes: ["memory", "admin"] };

test("E1 책임자가 있으면 그 사람만 책임자 — 관리자도 책임자는 아니다", () => {
  assert.equal(isAppOwner(app(), maker), true);
  assert.equal(isAppOwner(app(), other), false);
  assert.equal(isAppOwner(app(), admin), false);
});

test("E2 책임자 칸이 비면(떠난 사람의 앱 · 빌트인) 관리자가 책임자", () => {
  assert.equal(isAppOwner(app({ owner_member: null }), admin), true);
  assert.equal(isAppOwner(app({ owner_member: null }), other), false);
});

test("E3 신원 없는 요청은 누구의 책임자도 아니다", () => {
  assert.equal(isAppOwner(app({ owner_member: "" }), { userId: "" }), false);
  assert.equal(isAppOwner(app({ owner_member: null }), { userId: "", scopes: ["admin"] }), false);
});

test("E4 나만 보는 앱 열람 — 책임자 · 관리자만", () => {
  const p = app({ visibility: "me" });
  assert.equal(canSeeApp(p, maker), true);
  assert.equal(canSeeApp(p, other), false);
  assert.equal(canSeeApp(p, admin), true);
  assert.equal(appViewFor(p, other), "none");
  assert.equal(appViewFor(p, maker), "installed");
  assert.equal(canSeeApp(app(), other), true, "공개 앱은 누구나");
  assert.equal(canSeeApp(app(), { userId: "" }), true, "공개 앱은 신원 없는 요청에도(#4632 V1)");
});

test("E5 나만 보는 앱 목록 — 책임자에게만(관리자 목록에도 남이 만들고 있는 앱은 안 선다)", () => {
  const p = app({ visibility: "me" });
  assert.equal(listsAppFor(p, maker), true);
  assert.equal(listsAppFor(p, other), false);
  assert.equal(listsAppFor(p, admin), false);
  assert.equal(listsAppFor(app(), other), true);
});

test("E6 공개 앱에 초안이 없으면 모두 설치된 상태", () => {
  assert.equal(appViewFor(app(), other), "installed");
  assert.equal(appViewFor(app({ published_version_no: 4 }), other), "installed");
});

test("E7 공개 앱의 초안(책임자가 만듦) — 책임자만 초안, 남과 관리자는 공개 판", () => {
  const d = app({ draft_by: "maker", published_version_no: 3 });
  assert.equal(appViewFor(d, maker), "installed");
  assert.equal(appViewFor(d, other), "published");
  assert.equal(appViewFor(d, admin), "published");
});

test("E8 공개 앱의 초안(남이 만듦) — 그 사람만 초안, 책임자는 공개 판", () => {
  const x = app({ draft_by: "other", published_version_no: 3 });
  assert.equal(appViewFor(x, other), "installed");
  assert.equal(appViewFor(x, maker), "published");
});

test("E9 초안 표식은 있는데 공개 판 번호가 없으면(불변식 위반) 설치된 상태", () => {
  assert.equal(appViewFor(app({ draft_by: "maker", published_version_no: null }), other), "installed");
});

test("E10 저장 뒤 초안 표식 — 공개 판과 같으면 없음 · 다르면 저장한 사람 · 공개 해시를 모르면 초안 · 나만 보는 앱은 없음", () => {
  assert.equal(draftByAfterInstall("all", "h2", "h1", "maker"), "maker");
  assert.equal(draftByAfterInstall("all", "h1", "h1", "maker"), null);
  assert.equal(draftByAfterInstall("all", "h2", null, "maker"), "maker");
  assert.equal(draftByAfterInstall("me", "h2", "h1", "maker"), null);
});

test("E11 공개하기 — 나만 보는 앱은 책임자 · 관리자", () => {
  const p = app({ visibility: "me", title: "메모" });
  assert.equal(publishDenial(p, maker, null), null);
  assert.equal(publishDenial(p, admin, null), null);
  assert.notEqual(publishDenial(p, other, null), null);
});

test("E12 공개하기 — 공개 앱의 초안은 그 초안을 만든 사람 · 책임자 · 관리자, 고치기 막힌 사람은 못 한다(관리자 제외)", () => {
  const d = app({ draft_by: "maker", published_version_no: 2 });
  assert.equal(publishDenial(d, maker, null), null);
  assert.notEqual(publishDenial(d, other, null), null);
  const x = app({ draft_by: "other", published_version_no: 2 });
  assert.equal(publishDenial(x, other, null), null);
  assert.equal(publishDenial(x, maker, null), null);
  assert.notEqual(publishDenial(x, other, "지정한 사람만 고칠 수 있습니다"), null);
  assert.equal(publishDenial(x, admin, "지정한 사람만 고칠 수 있습니다"), null);
});

test("E13 공개하기 — 이미 공개 판 그대로면 막지 않는다", () => {
  assert.equal(publishDenial(app(), other, null), null);
});

test("E14 공개 거두기 — 책임자 · 관리자만", () => {
  assert.equal(unpublishDenial(app(), maker), null);
  assert.equal(unpublishDenial(app(), admin), null);
  assert.notEqual(unpublishDenial(app(), other), null);
  assert.equal(unpublishDenial(app({ owner_member: null }), admin), null);
});

const m = (...names: string[]) => ({ data: { tables: names.map((name) => ({ name, columns: [] })) } });

test("E18 공개할 때 정리할 표 — 옛 공개 판에만 있던 것", () => {
  assert.deepEqual(tablesGoneAtPublish(m("a", "b"), m("a", "c")), ["b"]);
});

test("E19 정리할 표 경계 — 옛 공개 판이 새 판에 다 있으면 없음", () => {
  assert.deepEqual(tablesGoneAtPublish(m("a"), m("a", "c")), []);
  assert.deepEqual(tablesGoneAtPublish(m("a", "c"), m("a", "c")), []);
});

test("E20 매니페스트가 비었거나 모양이 어긋나도 던지지 않는다", () => {
  assert.deepEqual(declaredTableNames(null), []);
  assert.deepEqual(declaredTableNames({ data: { tables: "x" } }), []);
  assert.deepEqual(tablesGoneAtPublish(null, m("a")), []);
  assert.deepEqual(tablesGoneAtPublish(m("a"), null), ["a"]);
});

test("E21 초안이 있는 동안 쓸 수 있는 표 — 두 판의 합", () => {
  assert.deepEqual(tablesUsableNow(m("a", "c"), m("a", "b")), ["a", "c", "b"]);
  assert.deepEqual(tablesUsableNow(m("a"), null), ["a"]);
});

test("E28 예약 앱 id — 어떤 이름 · 어떤 랜덤 글자여도 매니페스트 id 규칙을 지킨다", () => {
  const cases: Array<[string, string]> = [["회의 안건", "k3x9qa"], ["CRM 메모", "abcdef"], ["", "000000"], ["a", "zzzzzz"],
    ["Weekly Agenda Board For The Whole Team", "q1w2e3"], ["--x--", "!!!!!!"], ["Z", ""]];
  for (const [title, rand] of cases) {
    const id = draftAppIdFrom(title, rand);
    assert.match(id, APP_ID_RE, `${JSON.stringify(title)} + ${JSON.stringify(rand)} → ${id}`);
  }
  assert.equal(draftAppIdFrom("회의 안건", "k3x9qa"), "app-k3x9qa");
  assert.equal(draftAppIdFrom("CRM 메모", "abcdef"), "crm-abcdef");
});

test("E29 빈 예약 앱 — 내용 해시가 없으면 첫 판 전", () => {
  assert.equal(isEmptyDraftApp({ content_hash: null }), true);
  assert.equal(isEmptyDraftApp({}), true);
  assert.equal(isEmptyDraftApp({ content_hash: "h" }), false);
});

test("E30 매니페스트 studio.made_by 는 판정에 쓰지 않는다 — 그 칸을 제 이름으로 바꿔 저장해도 남의 나만 보는 앱을 못 본다", () => {
  const p = { ...app({ visibility: "me" }), manifest: { studio: { made_by: "other" } }, installed_by: "other" } as AppVisState;
  assert.equal(canSeeApp(p, other), false);
  assert.equal(listsAppFor(p, other), false);
  assert.equal(isAppOwner(p, other), false);
  assert.notEqual(publishDenial(p, other, null), null);
});

test("E31 저장된 값 → 공개 범위 — 'me' 만 나만 보는 앱, 빈 칸 · 모르는 값은 'all'(잠그는 쪽으로 틀리지 않는다 · #4632 V6)", () => {
  assert.equal(appVisibilityOf({ visibility: "me" }), "me");
  assert.equal(appVisibilityOf({ visibility: "all" }), "all");
  assert.equal(appVisibilityOf({}), "all");
  assert.equal(appVisibilityOf({ visibility: "private" }), "all");
  assert.equal(canSeeApp(app({ visibility: "zzz" as never }), other), true);
  assert.equal(listsAppFor(app({ visibility: "zzz" as never }), other), true);
});

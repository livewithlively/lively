import { strict as assert } from "node:assert";
import test from "node:test";
import {
  addressVariantFor, addressViewFor, appViewFor, appVisibilityOf, canSeeApp, declaredTableNames, draftAppIdFrom, draftByAfterInstall, isAppOwner, isEmptyDraftApp, isOthersPendingVersion, listsAppFor,
  publishDenial, tablesGoneAtPublish, tablesUsableNow, unpublishDenial, type AppVisState,
} from "./visibility.js";
import { APP_ID_RE } from "./manifest.js";

// ── 앱 공개 범위 · 만든 사람 · 책임자 (#4632 「나만」 · #4667 앱 v2-15) — 사양 엣지 표 E1~E14 · E18~E21 · E28~E33 ──────────
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

test("E29 빈 예약 앱 — 내용 해시와 판 번호가 둘 다 없으면 첫 판 전(예약 행 정리와 같은 자)", () => {
  assert.equal(isEmptyDraftApp({ content_hash: null }), true);
  assert.equal(isEmptyDraftApp({}), true);
  assert.equal(isEmptyDraftApp({ content_hash: null, current_version_no: null }), true);
  assert.equal(isEmptyDraftApp({ content_hash: "h" }), false);
  assert.equal(isEmptyDraftApp({ content_hash: null, current_version_no: 2 }), false, "해시 없는 옛 행이라도 판이 있으면 빈 예약이 아니다");
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

test("E32 남의 공개 전 판 — 공개 판 뒤에 다른 사람이 저장한 판만 가린다(그 사람 · 책임자 · 관리자에겐 보임) · 경계는 공개 판 번호 · 공개 시각", () => {
  const pub = app({ published_version_no: 3 });
  const v4 = { version_no: 4, saved_by: "other", saved_at: "2026-10-14T08:00:01.000Z" };
  const third = { userId: "third", scopes: ["memory"] };
  assert.equal(isOthersPendingVersion(pub, v4, third, null), true, "남 — 공개 판(3) 뒤 판, 공개한 적 없음(번호만)");
  assert.equal(isOthersPendingVersion(pub, v4, maker, null), false, "책임자");
  assert.equal(isOthersPendingVersion(pub, v4, admin, null), false, "관리자");
  assert.equal(isOthersPendingVersion(pub, v4, other, null), false, "그 판을 저장한 사람");
  assert.equal(isOthersPendingVersion(pub, { ...v4, version_no: 3 }, third, null), false, "경계 — 공개 판 그 자체");
  assert.equal(isOthersPendingVersion(pub, { ...v4, version_no: 2 }, third, null), false, "공개 판 앞의 이력");
  assert.equal(isOthersPendingVersion(app({ published_version_no: null }), v4, third, null), false, "공개 판 포인터가 없으면 가리지 않는다");
  assert.equal(isOthersPendingVersion(app({ visibility: "me", published_version_no: 3 }), v4, third, null), false, "나만 보는 앱엔 초안 개념이 없다");
  assert.equal(isOthersPendingVersion(pub, { ...v4, origin: "builtin" }, third, null), false, "릴리스 원본 판은 가리지 않는다");
  //  옛 판으로 되돌려 공개(공개 판 번호 2) — 그 뒤 번호의 옛 이력은 공개 시각 앞이라 가리지 않고, 공개 뒤 저장한 판만 가린다
  const back = app({ published_version_no: 2 });
  const at = Date.parse("2026-10-14T08:00:00.000Z");
  assert.equal(isOthersPendingVersion(back, { version_no: 5, saved_by: "other", saved_at: "2026-10-14T07:00:00.000Z" }, third, at), false, "공개 전에 저장한 옛 이력");
  assert.equal(isOthersPendingVersion(back, { version_no: 6, saved_by: "other", saved_at: "2026-10-14T08:00:00.000Z" }, third, at), false, "경계 — 공개 시각과 같으면 가리지 않는다");
  assert.equal(isOthersPendingVersion(back, { version_no: 7, saved_by: "other", saved_at: "2026-10-14T08:00:00.001Z" }, third, at), true, "공개 뒤 1ms 에 저장한 남의 판");
  assert.equal(isOthersPendingVersion(back, { version_no: 7, saved_by: null, saved_at: "2026-10-14T09:00:00.000Z" }, third, at), true, "저장한 사람 기록이 없는 공개 뒤 판도 남의 것");
  assert.equal(isOthersPendingVersion(back, { version_no: 7, saved_by: "other", saved_at: "날짜 아님" }, third, at), false, "시각을 못 읽으면 가리지 않는다");
});

test("E33 앱 주소의 두 판(#4480 · 설계 §13-5) — 공개 주소는 모두에게 공개 판(초안 주인도) · 초안 주소는 초안 주인만 · 주소를 안 정하면 보는 판의 주소", () => {
  const d = app({ draft_by: "other", published_version_no: 3 });   // 공개 앱에 other 의 초안
  const third = { userId: "third", scopes: ["memory"] };
  assert.equal(addressViewFor(d, other, "pub"), "published", "초안 주인도 공개 주소에선 공개 판");
  assert.equal(addressViewFor(d, third, "pub"), "published");
  assert.equal(addressViewFor(d, other, "draft"), "installed", "초안 주인은 초안 주소에서 자기 초안");
  assert.equal(addressViewFor(d, third, "draft"), "none", "남의 초안 주소는 없는 판");
  assert.equal(addressViewFor(d, maker, "draft"), "none", "책임자에게도 남의 초안은 없는 판");
  assert.equal(addressViewFor(d, admin, "draft"), "none", "관리자에게도");
  assert.equal(addressViewFor(app(), third, "draft"), "installed", "초안이 없으면 초안 주소도 설치된 상태(= 공개 판)");
  assert.equal(addressViewFor(app(), third, "pub"), "installed");
  assert.equal(addressViewFor(app({ draft_by: "other", published_version_no: null }), third, "pub"), "installed", "포인터 없는 초안 표식(불변식 위반)은 설치된 상태");
  const p = app({ visibility: "me" });
  assert.equal(addressViewFor(p, maker, "pub"), "installed", "나만 보는 앱 — 판이 하나");
  assert.equal(addressViewFor(p, maker, "draft"), "installed");
  assert.equal(addressViewFor(p, third, "pub"), "none", "남의 나만 보는 앱은 어느 주소로도 없다");
  assert.equal(addressViewFor(p, third, "draft"), "none");
  assert.equal(addressVariantFor(d, other), "draft", "초안 주인 — 라이블리 화면이 보이는 판(초안)의 주소");
  assert.equal(addressVariantFor(d, third), "pub");
  assert.equal(addressVariantFor(d, maker), "pub", "책임자는 공개 판");
  assert.equal(addressVariantFor(app(), maker), "pub", "초안 없음");
  assert.equal(addressVariantFor(p, maker), "pub", "나만 보는 앱은 공개 주소(판이 하나)");
  assert.equal(addressVariantFor(app({ draft_by: "other", published_version_no: null }), other), "pub", "포인터 없는 초안 표식");
  for (const who of [other, third, maker, admin]) assert.equal(addressViewFor(d, who, addressVariantFor(d, who)), appViewFor(d, who), `주소를 안 정하고 열면 라이블리 화면과 같은 판 — ${who.userId}`);
});

// ── #4482 앱 v2-3 — 앱 주소(/_lively/*)로 들어온 호출은 **주소의 판**(Viewer.address) — 사양 표 B(V1~V5) ──────────
//  이게 틀리면: 초안을 고친 사람이 공개 주소(새 탭)를 열었을 때 공개 판의 화면이 초안의 도구 · 표 선언으로 돌아(초안이 뺀 표 · 도구는 404)
//   그 사람에게만 공개 판이 깨지거나, 반대로 남의 초안 주소의 선언이 새거나, 주소가 없는 종전 호출의 판정이 바뀐다.
test("V1~V5 Viewer.address — 주소의 판이 사람의 판을 대신한다(addressViewFor 그대로) · 없으면 종전", () => {
  const d = app({ draft_by: "other", published_version_no: 3 });
  assert.equal(appViewFor(d, other), "installed", "V4 주소 없음 — 초안 주인은 설치된 판(종전)");
  assert.equal(appViewFor(d, { ...other, address: "pub" }), "published", "V1 초안 주인도 공개 주소면 공개 판");
  assert.equal(appViewFor(d, { ...other, address: "draft" }), "installed", "V2 초안 주인 · 초안 주소면 설치된 판");
  assert.equal(appViewFor(d, { ...maker, address: "draft" }), "none", "V3 남의 초안 주소는 없는 판");
  assert.equal(appViewFor(d, { ...maker, address: "pub" }), "published");
  const p = app({ visibility: "me" });
  assert.equal(appViewFor(p, { userId: "third", scopes: [], address: "pub" }), "none", "V5 못 보는 앱은 주소가 있어도 none");
  assert.equal(appViewFor(p, { ...maker, address: "draft" }), "installed", "나만 보는 앱 — 판이 하나");
});

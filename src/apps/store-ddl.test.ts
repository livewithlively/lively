import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveColumnType, assertIdent, physicalTableName, physicalAppPrefix, columnDefs, appSchemaName, qualifiedAppTable, isBuiltinSource, archiveSchemaName, archivedTableName, PG_IDENT_MAX } from "./store-ddl.js";

// 「입력 × 기대」 엣지 표 — 선언형 DDL 의 방어(임의 타입·식별자·예약컬럼·앱 네임스페이스).

test("resolveColumnType — 화이트리스트 매핑 + 대소문자 무시", () => {
  assert.equal(resolveColumnType("text"), "text");
  assert.equal(resolveColumnType("int"), "bigint");
  assert.equal(resolveColumnType("TIMESTAMP"), "timestamptz");
  assert.equal(resolveColumnType(" json "), "jsonb");
});

test("resolveColumnType — 화이트리스트 밖 거부(임의 SQL 타입 주입 차단)", () => {
  for (const bad of ["serial", "text; drop table x", "varchar(9999)", "", "money"]) {
    assert.throws(() => resolveColumnType(bad), /허용되지 않은 컬럼 타입/);
  }
});

test("assertIdent — 정상 슬러그 통과", () => {
  assert.equal(assertIdent("table", "orders"), "orders");
  assert.equal(assertIdent("column", "line_total"), "line_total");
});

test("assertIdent — 규칙 위반 거부(대문자·선행숫자·특수문자·과길이)", () => {
  for (const bad of ["Orders", "1col", "a-b", "a b", "drop;", "x".repeat(64)]) {
    assert.throws(() => assertIdent("table", bad), /규칙에 맞지 않/);
  }
});

test("assertIdent — 예약 컬럼명 거부(시스템 컬럼 충돌)", () => {
  for (const r of ["tenant_id", "id", "app_id", "created_at", "updated_at"]) {
    assert.throws(() => assertIdent("column", r), /예약된 컬럼명/);
  }
  // 테이블명으로는 예약어 검사 안 함(테이블은 app 네임스페이스라 충돌 없음).
  assert.equal(assertIdent("table", "id"), "id");
});

test("physicalTableName — 앱별 네임스페이스(appId__table), 앱 격리", () => {
  assert.equal(physicalTableName("wiki", "pages"), "wiki__pages");
  // 앱 X 는 'app.pages' 같은 공용 이름을 못 만든다 — 항상 자기 접두.
  assert.notEqual(physicalTableName("a", "t"), physicalTableName("b", "t"));
});

test("physicalTableName — 불량 appId 거부", () => {
  assert.throws(() => physicalTableName("Bad-App", "t"), /식별자 규칙/);
  assert.throws(() => physicalTableName("-crm", "t"), /식별자 규칙/);
  assert.throws(() => physicalTableName('crm"; drop', "t"), /식별자 규칙/);
});

// #4224 — 하이픈 id. 매니페스트(APP_ID_RE)는 `-` 를 허용하는데 종전엔 테이블 생성이 늘 실패했다.
test("physicalTableName — 하이픈 id 는 밑줄로 바꿔 테이블을 가진다", () => {
  assert.equal(physicalTableName("crm-dashboard", "contacts"), "crm_dashboard__contacts");
  assert.equal(physicalAppPrefix("my-crm-app"), "my_crm_app");
  // 숫자로 시작하는 id 도 매니페스트가 허용한다 — 인용 식별자라 쓸 수 있다.
  assert.equal(physicalTableName("3d-view", "shots"), "3d_view__shots");
});

test("physicalTableName — (앱, 테이블) 이 물리 이름 하나로만 읽히게: 연속·끝 하이픈 id 는 테이블을 못 가진다", () => {
  // 허용하면 `a--b`+`x` 와 `a`+`b__x` 가 둘 다 a__b__x, `a-`+`x` 와 `a`+`_x` 가 둘 다 a___x 가 된다.
  assert.equal(physicalTableName("a", "b__x"), "a__b__x");
  assert.throws(() => physicalTableName("a--b", "x"), /데이터 테이블을 가질 수 없습니다/);
  assert.equal(physicalTableName("a", "_x"), "a___x");
  assert.throws(() => physicalTableName("a-", "x"), /데이터 테이블을 가질 수 없습니다/);
});

test("physicalTableName — 하이픈 id 와 같은 글자의 다른 앱이 겹치지 않는다(앱 id 엔 밑줄이 없다)", () => {
  const seen = new Map<string, string>();
  for (const [app, t] of [["crm-app", "x"], ["crm", "app__x"], ["crmapp", "x"], ["crm-ap", "p__x"]] as const) {
    let name: string;
    try { name = physicalTableName(app, t); } catch { continue; }
    assert.ok(!seen.has(name), `${app}+${t} 가 ${seen.get(name)} 와 같은 물리 이름 ${name}`);
    seen.set(name, `${app}+${t}`);
  }
});

test("physicalTableName — 63자를 넘으면 400(Postgres 가 잘라 다른 테이블과 한 몸이 되지 않게)", () => {
  const app = "a".repeat(32);                       // 매니페스트 상한 32자
  const ok = "t".repeat(PG_IDENT_MAX - 34);         // 32 + 2(__) + 29 = 63
  assert.equal(physicalTableName(app, ok).length, PG_IDENT_MAX);
  assert.throws(() => physicalTableName(app, ok + "t"), /너무 깁니다/);
});

test("archiveSchemaName · archivedTableName — 보관 자리와 이름(#4224)", () => {
  assert.equal(archiveSchemaName("app_4d2553647dbb4c53b2101588ebde1820"), "app_4d2553647dbb4c53b2101588ebde1820_archive");
  assert.equal(archiveSchemaName("app"), "app_archive");
  assert.throws(() => archiveSchemaName('app"; x'), /스키마 이름/);
  const at = new Date("2026-09-28T01:02:03.456Z");
  assert.equal(archivedTableName("crm__logs", at), "crm__logs__20260928010203");
  assert.equal(archivedTableName("crm__logs", at, "_pkey"), "crm__logs__20260928010203_pkey");
  // 긴 이름: 앞을 자르고 시각·꼬리는 남긴다 — 63자 안.
  const long = "a".repeat(32) + "__" + "t".repeat(29);
  const cut = archivedTableName(long, at, "_seq1");
  assert.ok(cut.length <= PG_IDENT_MAX, cut);
  assert.ok(cut.endsWith("__20260928010203_seq1"), cut);
  // 같은 테이블을 다른 시각에 보관하면 이름이 다르다.
  assert.notEqual(archivedTableName(long, at), archivedTableName(long, new Date("2026-09-28T01:02:04Z")));
});

test("columnDefs — 조합 + 중복/빈/예약/불량타입 거부", () => {
  assert.deepEqual(columnDefs([{ name: "title", type: "text" }, { name: "qty", type: "int" }]),
    ['"title" text', '"qty" bigint']);
  assert.throws(() => columnDefs([]), /최소 1개/);
  assert.throws(() => columnDefs([{ name: "a", type: "text" }, { name: "a", type: "int" }]), /중복 컬럼/);
  assert.throws(() => columnDefs([{ name: "tenant_id", type: "text" }]), /예약된 컬럼명/);
  assert.throws(() => columnDefs([{ name: "a", type: "nope" }]), /허용되지 않은 컬럼 타입/);
});

// #4223 — 테이블 자리: 구조의 주인이 누구냐로 가른다.
test("appSchemaName — 기본 앱은 늘 공유 app(행 격리)", () => {
  assert.equal(appSchemaName({ builtin: true, tenantId: "4d255364-7dbb-4c53-b210-1588ebde1820" }), "app");
  assert.equal(appSchemaName({ builtin: true, tenantId: null }), "app");
});

test("appSchemaName — 워크스페이스가 설치한 앱은 멀티테넌트에서 워크스페이스별 스키마", () => {
  assert.equal(appSchemaName({ builtin: false, tenantId: "4D255364-7DBB-4C53-B210-1588EBDE1820" }), "app_4d2553647dbb4c53b2101588ebde1820");
  // 다른 워크스페이스는 다른 스키마 — 같은 앱 id 여도 물리 테이블이 섞이지 않는다.
  assert.notEqual(
    appSchemaName({ builtin: false, tenantId: "4d255364-7dbb-4c53-b210-1588ebde1820" }),
    appSchemaName({ builtin: false, tenantId: "5d255364-7dbb-4c53-b210-1588ebde1820" }));
});

test("appSchemaName — 단일 테넌트·컨텍스트 없음은 종전 그대로 app(기존 박스 이행 불요)", () => {
  assert.equal(appSchemaName({ builtin: false, tenantId: null }), "app");
  assert.equal(appSchemaName({ builtin: false, tenantId: "" }), "app");
  assert.equal(appSchemaName({ builtin: false, tenantId: "00000000-0000-0000-0000-000000000000" }), "app");
});

test("appSchemaName — uuid 가 아닌 테넌트 id 는 거부(식별자 주입 차단)", () => {
  for (const bad of ["x; drop schema app", "4d255364", "zzzz5364-7dbb-4c53-b210-1588ebde1820"]) {
    assert.throws(() => appSchemaName({ builtin: false, tenantId: bad }), /테넌트 id 형식/);
  }
});

test("qualifiedAppTable — 스키마까지 인용, 불량 스키마 거부", () => {
  assert.equal(qualifiedAppTable("app", "crm", "contacts"), '"app"."crm__contacts"');
  assert.equal(qualifiedAppTable("app_4d2553647dbb4c53b2101588ebde1820", "crm", "contacts"),
    '"app_4d2553647dbb4c53b2101588ebde1820"."crm__contacts"');
  assert.throws(() => qualifiedAppTable('app"; drop', "crm", "contacts"), /스키마 이름/);
});

test("isBuiltinSource — {kind:'builtin'} 만 참", () => {
  assert.equal(isBuiltinSource({ kind: "builtin" }), true);
  for (const s of [{ kind: "git", url: "https://x" }, { kind: "path", path: "/x" }, null, undefined, "builtin", {}]) {
    assert.equal(isBuiltinSource(s), false);
  }
});

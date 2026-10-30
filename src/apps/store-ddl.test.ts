import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolveColumnType, assertIdent, assertMatchIdent, assertMatchId, physicalTableName, physicalAppPrefix, columnDefs, appSchemaName, qualifiedAppTable, isBuiltinSource, archiveSchemaName, archivedTableName, PG_IDENT_MAX, appIndexName } from "./store-ddl.js";

// 「입력 × 기대」 엣지 표 — 선언형 DDL 의 방어(임의 타입·식별자·예약컬럼·앱 네임스페이스).

test("resolveColumnType — 화이트리스트 매핑 + 대소문자 무시", () => {
  assert.equal(resolveColumnType("text"), "text");
  assert.equal(resolveColumnType("int"), "bigint");
  assert.equal(resolveColumnType("TIMESTAMP"), "timestamptz");
  assert.equal(resolveColumnType(" json "), "jsonb");
});

test("resolveColumnType — 화이트리스트 밖 거부(임의 SQL 타입 주입 차단)", () => {
  //  #4483 부터 varchar(n)·numeric(p,s) 는 받는다 — 범위 밖 길이·모르는 형만 거부한다.
  for (const bad of ["serial", "text; drop table x", "varchar(0)", "char(10)", "", "money"]) {
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

// ── match(행 고르기)의 칸 — #4592 ────────────────────────────────────────────────
//  이 규칙이 틀렸을 때 나는 일: ① id 를 못 받으면 앱이 방금 넣은 한 행을 다시 집을 길이 없다(«내용이 같은 행 전부» 로만 고치고 지운다).
//  ② tenant_id·app_id 를 받으면 격리 경계를 화면이 조건으로 건드린다. ③ id 에 숫자 아닌 값이 가면 DB 가 22P02 로 던져 500 이 된다.
test("assertMatchIdent — 시스템 칸 id·created_at 은 match 에 쓸 수 있다", () => {
  assert.equal(assertMatchIdent("id"), "id");
  assert.equal(assertMatchIdent("created_at"), "created_at");
  assert.equal(assertMatchIdent(" id "), "id");
});

test("assertMatchIdent — 격리 칸(tenant_id·app_id)과 잡아만 둔 updated_at 은 match 에서도 거부", () => {
  for (const r of ["tenant_id", "app_id", "updated_at"]) assert.throws(() => assertMatchIdent(r), /예약된 컬럼명/);
});

test("assertMatchIdent — 선언 칸은 종전 규칙 그대로(글자 모양 위반 거부)", () => {
  assert.equal(assertMatchIdent("status"), "status");
  for (const bad of ["Id", "1x", "a-b", "a b", "a\"; drop table x; --", ""]) assert.throws(() => assertMatchIdent(bad), /규칙에 맞지 않/);
});

test("assertIdent — 쓰는 쪽(row·set)은 여전히 id·created_at 을 거부한다(match 완화가 번지지 않았다)", () => {
  for (const r of ["id", "created_at"]) assert.throws(() => assertIdent("column", r), /예약된 컬럼명/);
});

test("assertMatchId — bigint 범위의 정수(숫자·숫자 문자열)만 · 그 밖은 400 (#5172 원래 id 의 0·음수·19자리도 집는다)", () => {
  assert.equal(assertMatchId(12), "12");
  assert.equal(assertMatchId("12"), "12");
  assert.equal(assertMatchId(" 7 "), "7");
  assert.equal(assertMatchId(0), "0");
  assert.equal(assertMatchId(-5), "-5");
  assert.equal(assertMatchId("-5"), "-5");
  assert.equal(assertMatchId("1234567890123456789"), "1234567890123456789");
  assert.equal(assertMatchId("9223372036854775807"), "9223372036854775807");      // bigint 최댓값 — 경계
  assert.equal(assertMatchId("-9223372036854775808"), "-9223372036854775808");    // bigint 최솟값 — 경계
  for (const bad of [1.5, "1 or 1=1", "abc", "", null, undefined, {}, [1], "tmp1712345", Number.MAX_SAFE_INTEGER + 2,
    "9223372036854775808", "-9223372036854775809", "12345678901234567890", "--1", "+1", "1e3", "-"]) {
    assert.throws(() => assertMatchId(bad), (e: unknown) => (e as { status?: number }).status === 400, `받으면 안 되는 값: ${String(bad)}`);
  }
});

// ── #4483 칸 타입 v2 · 기본값 리터럴 ───────────────────────────────────────────────────────
import { parseColumnType, defaultLiteralText, appConstraintName, APP_CHECK_PREFIX } from "./store-ddl.js";

test("parseColumnType — 종전 이름은 그대로(int→bigint · timestamp→timestamptz), 새 타입 · canonical(format_type 이름)", () => {
  const p = (t: string) => { const r = parseColumnType(t); return [r.sql, r.canonical, r.array, r.enum, r.integer]; };
  assert.deepEqual(p("int"), ["bigint", "bigint", false, false, true]);
  assert.deepEqual(p("timestamp"), ["timestamptz", "timestamp with time zone", false, false, false]);
  assert.deepEqual(p("Numeric( 12 , 2 )"), ["numeric(12,2)", "numeric(12,2)", false, false, false]);
  assert.deepEqual(p("decimal(5)"), ["numeric(5,0)", "numeric(5,0)", false, false, false]);
  assert.deepEqual(p("numeric"), ["numeric", "numeric", false, false, false]);
  assert.deepEqual(p("varchar(80)"), ["varchar(80)", "character varying(80)", false, false, false]);
  assert.deepEqual(p("time"), ["time", "time without time zone", false, false, false]);
  assert.deepEqual(p("timetz"), ["time with time zone", "time with time zone", false, false, false]);
  assert.deepEqual(p("int4"), ["integer", "integer", false, false, true]);
  assert.deepEqual(p("smallint"), ["smallint", "smallint", false, false, true]);
  assert.deepEqual(p("numeric(10,2)[]"), ["numeric(10,2)[]", "numeric(10,2)[]", true, false, false]);
  assert.deepEqual(p("timestamp[]"), ["timestamptz[]", "timestamp with time zone[]", true, false, false]);
  assert.deepEqual(p("enum"), ["text", "text", false, true, false]);
  assert.deepEqual(p("bigint[]").slice(2), [true, false, false], "배열은 정수형이 아니다(외래키 불가)");
});

test("parseColumnType — 경계 · 거부(numeric 1~1000 · 소수 0~자릿수 · varchar 1~10485760 · 배열 한 겹 · enum 배열 · 모르는 타입)", () => {
  assert.equal(parseColumnType("numeric(1000,0)").sql, "numeric(1000,0)");
  assert.equal(parseColumnType("numeric(5,5)").sql, "numeric(5,5)");
  assert.equal(parseColumnType("varchar(10485760)").sql, "varchar(10485760)");
  for (const bad of ["numeric(0)", "numeric(1001)", "numeric(5,6)", "varchar(0)", "varchar(10485761)", "text[][]", "enum[]", "money", "serial", "int; drop table x", ""]) {
    assert.throws(() => parseColumnType(bad), /허용되지 않은 컬럼 타입/, bad);
  }
});

test("defaultLiteralText — 배열 리터럴(따옴표·백슬래시 이스케이프 · NULL) · jsonb · 수 · 참거짓 · null=기본값 없음 · 형 어긋남 400", () => {
  assert.equal(defaultLiteralText(["a", 'b"c', "d\\e", null], parseColumnType("text[]")), '{"a","b\\"c","d\\\\e",NULL}');
  assert.equal(defaultLiteralText({ a: [1] }, parseColumnType("jsonb")), '{"a":[1]}');
  assert.equal(defaultLiteralText(1.5, parseColumnType("numeric(5,2)")), "1.5");
  assert.equal(defaultLiteralText(false, parseColumnType("bool")), "false");
  assert.equal(defaultLiteralText(null, parseColumnType("text")), null);
  assert.throws(() => defaultLiteralText("x", parseColumnType("text[]")), /배열이어야/);
  assert.throws(() => defaultLiteralText({ a: 1 }, parseColumnType("text")), /글자·수·참거짓/);
  assert.throws(() => defaultLiteralText(Number.POSITIVE_INFINITY, parseColumnType("double")), /유한/);
  assert.throws(() => defaultLiteralText([{}], parseColumnType("text[]")), /원소/);
  assert.throws(() => defaultLiteralText("a\u0000b", parseColumnType("text")), /NUL/);
});

test("appConstraintName — 결정적 · 부분마다 다르다 · lvck_ 16hex", () => {
  const a = appConstraintName(APP_CHECK_PREFIX, "s", "crm__orders", "c", "amount", "amount >= 0");
  assert.equal(a, appConstraintName(APP_CHECK_PREFIX, "s", "crm__orders", "c", "amount", "amount >= 0"));
  assert.notEqual(a, appConstraintName(APP_CHECK_PREFIX, "s", "crm__orders", "c", "amount", "amount > 0"));
  assert.match(a, /^lvck_[0-9a-f]{16}$/);
});

test("appIndexName — 조건(where)이 없으면 종전 이름 그대로(깔린 앱의 인덱스를 다시 만들지 않는다) · 조건이 다르면 다른 이름", () => {
  const old = "lvix_" + createHash("sha256").update("s\0p\0u\0\0a,b").digest("hex").slice(0, 16);
  assert.equal(appIndexName("s", "p", { columns: ["a", "b"], unique: true }, false), old);
  assert.equal(appIndexName("s", "p", { columns: ["a", "b"], unique: true, where: undefined }, false), old);
  const w1 = appIndexName("s", "p", { columns: ["a", "b"], unique: true, where: "c IS NULL" }, false);
  const w2 = appIndexName("s", "p", { columns: ["a", "b"], unique: true, where: "c IS NOT NULL" }, false);
  assert.notEqual(w1, old);
  assert.notEqual(w1, w2);
  assert.match(w1, /^lvix_[0-9a-f]{16}$/);
});

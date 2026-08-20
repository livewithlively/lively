import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveColumnType, assertIdent, physicalTableName, columnDefs } from "./store-ddl.js";

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
});

test("columnDefs — 조합 + 중복/빈/예약/불량타입 거부", () => {
  assert.deepEqual(columnDefs([{ name: "title", type: "text" }, { name: "qty", type: "int" }]),
    ['"title" text', '"qty" bigint']);
  assert.throws(() => columnDefs([]), /최소 1개/);
  assert.throws(() => columnDefs([{ name: "a", type: "text" }, { name: "a", type: "int" }]), /중복 컬럼/);
  assert.throws(() => columnDefs([{ name: "tenant_id", type: "text" }]), /예약된 컬럼명/);
  assert.throws(() => columnDefs([{ name: "a", type: "nope" }]), /허용되지 않은 컬럼 타입/);
});

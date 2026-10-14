import { strict as assert } from "node:assert";
import test from "node:test";
import { publishedBreakingChanges, publishedBreakingMessage } from "./table-compat.js";

// 공개 판을 깨는 표 변경(#4483 × #4667) — 엣지 표 B1~B13. 행마다 «깨짐(목록에 그 말)» / «아님(빈 목록)».
const M = (tables: unknown[]) => ({ id: "crm", data: { tables } });
const T = (columns: unknown[], extra: Record<string, unknown> = {}) => ({ name: "contacts", columns, ...extra });
const base = [{ name: "name", type: "text" }, { name: "email", type: "text", unique: true }, { name: "stage", type: "enum", values: ["lead", "won"], default: "lead" }];
const pub = M([T(base)]);
const diff = (next: unknown) => publishedBreakingChanges(pub, next);
const breaks = (next: unknown, re: RegExp) => { const d = diff(next); assert.ok(d.some((x) => re.test(x)), `${re} 가 없다: ${JSON.stringify(d)}`); };
const fine = (next: unknown) => assert.deepEqual(diff(next), []);

test("B1·B2 칸 지우기 · 이름 바꾸기는 깨짐", () => {
  breaks(M([T(base.slice(1), { drop_columns: ["name"] })]), /칸 지우기 contacts\.name/);
  breaks(M([T([{ name: "full_name", type: "text", renamed_from: "name" }, ...base.slice(1)])]), /이름 바꾸기 contacts\.name → full_name/);
});

test("B3 형 바꾸기 — canonical 이 다르면 깨짐, 같은 형의 다른 이름(int ↔ bigint)은 아님", () => {
  breaks(M([T([{ name: "name", type: "bigint" }, ...base.slice(1)])]), /형 바꾸기 contacts\.name \(text → bigint\)/);
  const p2 = M([T([{ name: "n", type: "int" }])]);
  assert.deepEqual(publishedBreakingChanges(p2, M([T([{ name: "n", type: "bigint" }])])), []);
});

test("B4~B6 not_null·unique·check — 더하면 깨짐 · unique 빼기도 깨짐 · not_null·check 빼기는 아님", () => {
  breaks(M([T([{ ...base[0], not_null: true }, ...base.slice(1)])]), /not_null 더하기 contacts\.name/);
  breaks(M([T([{ ...base[0], unique: true }, ...base.slice(1)])]), /unique 더하기 contacts\.name/);
  breaks(M([T([base[0], { name: "email", type: "text" }, base[2]])]), /unique 빼기 contacts\.email/);
  breaks(M([T([{ ...base[0], check: "length(name) > 0" }, ...base.slice(1)])]), /검사 더하기 contacts\.name/);
  const p3 = M([T([{ name: "n", type: "int", not_null: true, check: "n > 0" }])]);
  assert.deepEqual(publishedBreakingChanges(p3, M([T([{ name: "n", type: "int" }])])), []);
  assert.ok(publishedBreakingChanges(p3, M([T([{ name: "n", type: "int", not_null: true, check: "n > 1" }])])).some((x) => /검사 바꾸기/.test(x)));
});

test("B7 enum 값 빼기는 깨짐 · 더하기는 아님", () => {
  breaks(M([T([base[0], base[1], { ...base[2], values: ["lead"] }])]), /enum 값 빼기 contacts\.stage/);
  fine(M([T([base[0], base[1], { ...base[2], values: ["lead", "won", "lost"] }])]));
});

test("B8 외래키 더하기·바꾸기는 깨짐 · 빼기는 아님", () => {
  const p4 = M([{ name: "orders", columns: [{ name: "contact_id", type: "bigint" }] }]);
  assert.ok(publishedBreakingChanges(p4, M([{ name: "orders", columns: [{ name: "contact_id", type: "bigint", references: { table: "contacts" } }] }])).some((x) => /외래키 더하기 orders\.contact_id/.test(x)));
  const p5 = M([{ name: "orders", columns: [{ name: "contact_id", type: "bigint", references: { table: "contacts" } }] }]);
  assert.ok(publishedBreakingChanges(p5, M([{ name: "orders", columns: [{ name: "contact_id", type: "bigint", references: { table: "contacts", on_delete: "cascade" } }] }])).some((x) => /외래키 바꾸기/.test(x)));
  assert.deepEqual(publishedBreakingChanges(p5, M([{ name: "orders", columns: [{ name: "contact_id", type: "bigint" }] }])), []);
});

test("B9 기본값 바꾸기·빼기는 깨짐 · 새로 더하기는 아님", () => {
  breaks(M([T([base[0], base[1], { ...base[2], default: "won" }])]), /기본값 바꾸기 contacts\.stage/);
  breaks(M([T([base[0], base[1], { name: "stage", type: "enum", values: ["lead", "won"] }])]), /기본값 바꾸기 contacts\.stage/);
  fine(M([T([{ ...base[0], default: "무명" }, ...base.slice(1)])]));
});

test("B10·B11 표 검사 더하기 · unique 인덱스 더하기·빼기는 깨짐 · 표 검사 빼기 · 일반 인덱스는 아님", () => {
  breaks(M([T(base, { checks: ["name <> email"] })]), /표 검사 더하기 contacts: name <> email/);
  breaks(M([T(base, { indexes: [{ columns: ["name", "stage"], unique: true }] })]), /unique 인덱스 더하기 contacts\(name,stage\)/);
  const p6 = M([T(base, { checks: ["name <> email"], indexes: [{ columns: ["name"], unique: true }, { columns: ["stage"] }] })]);
  assert.ok(publishedBreakingChanges(p6, M([T(base, { checks: ["name <> email"], indexes: [{ columns: ["stage"] }] })])).some((x) => /unique 인덱스 빼기 contacts\(name\)/.test(x)));
  assert.deepEqual(publishedBreakingChanges(p6, M([T(base, { indexes: [{ columns: ["name"], unique: true }, { columns: ["email"] }] })])), []);
});

test("B12 새 칸 · 새 표 · 표를 선언에서 빼기 · 같은 매니페스트는 아님", () => {
  fine(M([T([...base, { name: "phone", type: "varchar(20)", not_null: true, default: "", unique: true }]), { name: "orders", columns: [{ name: "n", type: "int", not_null: true }] }]));
  fine(M([]));
  fine(pub);
});

test("B13 새 헬퍼가 빈·어긋난 입력에도 던지지 않는다 — 공개 판에 data 없음 · 칸이 배열이 아님 · 모르는 형", () => {
  assert.deepEqual(publishedBreakingChanges({ id: "x" }, pub), []);
  assert.deepEqual(publishedBreakingChanges(null, undefined), []);
  assert.deepEqual(publishedBreakingChanges(M([{ name: "contacts", columns: "x" }]), pub), []);
  assert.deepEqual(publishedBreakingChanges(M([T([{ name: "a", type: "money" }])]), M([T([{ name: "a", type: "text" }])])), []);
  assert.match(publishedBreakingMessage(["칸 지우기 contacts.name"]), /publish:true/);
});

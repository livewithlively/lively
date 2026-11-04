// 무변경 재싱크 판정 — 사양 기반·구현 블라인드 시험 (사양 §6, src/v6/mirror/resync-noop.ts). DB 불요(순수 함수).
// 실행: npm run build && node dist/v6/mirror/resync-noop.test.js
//
// 의미: 미러 행(now)에 이번 싱크 값(next)을 써도 바뀌는 칸이 하나도 없으면 true(판 번호를 올리지 않는다).
// 잠그는 행위(§6):
//  1. 제목(null=null)·본문·source·external_url·occurred_at·parent_external_id·parent_name·fields·raw 중 하나라도 다르면 false.
//  2. occurred_at 은 같은 순간이면 같다(Date 와 ISO 문자열, 다른 시간대 표기). 한쪽만 null 이면 다르고, 둘 다 null 이면 같다.
//  3. fields·raw 는 깊은 값 비교 — 객체 키 순서 무시, 배열 순서는 따짐, undefined 값 키는 없는 것. raw 둘 다 null/undefined 면 같다.
//  4. sort: next.sort 가 null 이면 비교 안 함. 숫자면 now.sort(숫자 또는 숫자 문자열)와 같아야 한다.
//  5. now 가 보관(lifecycle archived)이거나 next.archived 면 false.
//  6. now 의 injection≠recalled · provenance≠observed · confidence≠observed 면 false.
//  7. canonicalJson — 키 순서가 다른 같은 객체(중첩 포함)는 같은 문자열, 배열 순서가 다르면 다른 문자열.
import assert from "node:assert/strict";
import test from "node:test";
import { isNoopResync, canonicalJson } from "./resync-noop.js";

type Now = Parameters<typeof isNoopResync>[0];
type Next = Parameters<typeof isNoopResync>[1];

const URL_A = "https://git.example.com/pm/wiki/-/blob/main/Card/a.md";
const FIELDS = { domain_wiki: { relpath: "Card/a.md", id_mode: "path", masked: { phone: 1 } }, tags: ["a", "b"] };

const now = (o: Partial<Now> = {}): Now => ({
  title: "카드 정책",
  body_md: "본문",
  injection: "recalled",
  provenance: "observed",
  confidence: "observed",
  source: "domain-wiki",
  lifecycle: "active",
  external_url: URL_A,
  occurred_at: new Date("2026-11-04T00:00:00Z"),
  parent_external_id: null,
  parent_name: null,
  fields: structuredClone(FIELDS),
  raw: null,
  sort: null,
  ...o,
});

const next = (o: Partial<Next> = {}): Next => ({
  title: "카드 정책",
  body_md: "본문",
  source: "domain-wiki",
  archived: false,
  external_url: URL_A,
  occurred_at: "2026-11-04T00:00:00Z",
  parent_external_id: null,
  parent_name: null,
  fields: structuredClone(FIELDS),
  raw: null,
  sort: null,
  ...o,
});

test("§6 기준: 바뀌는 칸이 하나도 없으면 true", () => {
  assert.equal(isNoopResync(now(), next()), true, "§6 모든 칸이 같으면 무변경");
});

test("§6.1 칸 하나라도 다르면 false", () => {
  const cases: Array<[string, Partial<Now>, Partial<Next>]> = [
    ["title 값 다름", {}, { title: "다른 제목" }],
    ["title null → 값", { title: null }, { title: "카드 정책" }],
    ["title 값 → null", {}, { title: null }],
    ["body_md", {}, { body_md: "본문 2" }],
    ["source", {}, { source: "notion" }],
    ["external_url 값 다름", {}, { external_url: "https://git.example.com/other.md" }],
    ["external_url 값 → null", {}, { external_url: null }],
    ["external_url null → 값", { external_url: null }, {}],
    ["occurred_at 다른 순간", {}, { occurred_at: "2026-11-05T00:00:00Z" }],
    ["parent_external_id null → 값", {}, { parent_external_id: "p1" }],
    ["parent_external_id 값 다름", { parent_external_id: "p1" }, { parent_external_id: "p2" }],
    ["parent_name null → 값", {}, { parent_name: "부모" }],
    ["parent_name 값 다름", { parent_name: "부모" }, { parent_name: "다른 부모" }],
    ["fields 값 다름", {}, { fields: { domain_wiki: { relpath: "Card/b.md", id_mode: "path", masked: { phone: 1 } }, tags: ["a", "b"] } }],
    ["raw 값 다름", { raw: { x: 1 } }, { raw: { x: 2 } }],
    ["raw null → 값", {}, { raw: { x: 1 } }],
  ];
  for (const [label, a, b] of cases) {
    assert.equal(isNoopResync(now(a), next(b)), false, `§6.1 ${label} → false`);
  }
});

test("§6.1 같은 값이면 무변경 — 제목 null 과 null, external_url null 과 null, 같은 부모", () => {
  assert.equal(isNoopResync(now({ title: null }), next({ title: null })), true, "§6.1 제목 null 과 null 은 같다");
  assert.equal(isNoopResync(now({ external_url: null }), next({ external_url: null })), true, "§6.1 external_url null 과 null");
  assert.equal(isNoopResync(now({ parent_external_id: "p1", parent_name: "부모" }), next({ parent_external_id: "p1", parent_name: "부모" })),
    true, "§6.1 같은 부모");
});

test("§6.2 occurred_at 은 같은 순간이면 같다", () => {
  assert.equal(isNoopResync(now({ occurred_at: new Date("2026-11-04T00:00:00Z") }), next({ occurred_at: "2026-11-04T09:00:00+09:00" })),
    true, "§6.2 Date × +09:00 문자열(같은 순간)");
  assert.equal(isNoopResync(now({ occurred_at: "2026-11-04T00:00:00Z" }), next({ occurred_at: "2026-11-04T09:00:00+09:00" })),
    true, "§6.2 Z 문자열 × +09:00 문자열(같은 순간)");
  assert.equal(isNoopResync(now({ occurred_at: "2026-11-04T09:00:00+09:00" }), next({ occurred_at: "2026-11-04T00:00:00.000Z" })),
    true, "§6.2 +09:00 × .000Z(같은 순간)");
  assert.equal(isNoopResync(now({ occurred_at: new Date("2026-11-04T00:00:00Z") }), next({ occurred_at: "2026-11-04T00:00:01Z" })),
    false, "§6.2 1초라도 다르면 다르다");
  assert.equal(isNoopResync(now({ occurred_at: "2026-11-04T00:00:00Z" }), next({ occurred_at: "2026-11-04T00:00:00+09:00" })),
    false, "§6.2 시각 글자는 같아도 시간대가 다르면 다른 순간");
});

test("§6.2 occurred_at — 한쪽만 null 이면 다르고, 둘 다 null 이면 같다", () => {
  assert.equal(isNoopResync(now({ occurred_at: null }), next({ occurred_at: null })), true, "§6.2 둘 다 null");
  assert.equal(isNoopResync(now({ occurred_at: null }), next({ occurred_at: "2026-11-04T00:00:00Z" })), false, "§6.2 now 만 null");
  assert.equal(isNoopResync(now(), next({ occurred_at: null })), false, "§6.2 next 만 null");
});

test("§6.3 fields·raw 는 깊은 값 비교 — 객체 키 순서는 무시", () => {
  const f1 = { a: 1, b: { c: 2, d: [1, 2, { x: 1, y: 2 }] } };
  const f2 = { b: { d: [1, 2, { y: 2, x: 1 }], c: 2 }, a: 1 };
  assert.equal(isNoopResync(now({ fields: f1 }), next({ fields: f2 })), true, "§6.3 fields 키 순서(중첩 포함) 무시");
  assert.equal(isNoopResync(now({ raw: f1 }), next({ raw: f2 })), true, "§6.3 raw 키 순서(중첩 포함) 무시");
});

test("§6.3 fields·raw 의 배열 순서는 따진다", () => {
  assert.equal(isNoopResync(now({ fields: { a: [1, 2] } }), next({ fields: { a: [2, 1] } })), false, "§6.3 fields 배열 순서");
  assert.equal(isNoopResync(now({ raw: [1, 2] }), next({ raw: [2, 1] })), false, "§6.3 raw 배열 순서");
  assert.equal(isNoopResync(now({ fields: { tags: ["a", "b"] } }), next({ fields: { tags: ["a", "b"] } })), true, "§6.3 같은 순서는 같다");
});

test("§6.3 값이 undefined 인 키는 없는 것과 같다", () => {
  assert.equal(isNoopResync(now({ fields: { a: 1 } }), next({ fields: { a: 1, b: undefined } })), true, "§6.3 next 쪽 undefined 키");
  assert.equal(isNoopResync(now({ fields: { a: 1, b: undefined } }), next({ fields: { a: 1 } })), true, "§6.3 now 쪽 undefined 키");
  assert.equal(isNoopResync(now({ fields: { x: { a: 1 } } }), next({ fields: { x: { a: 1, z: undefined } } })), true, "§6.3 중첩 undefined 키");
  assert.equal(isNoopResync(now({ raw: { a: 1 } }), next({ raw: { a: 1, b: undefined } })), true, "§6.3 raw 의 undefined 키");
});

test("§6.3 깊은 값이 다르면 다르다 — 값의 종류·null 값 키", () => {
  assert.equal(isNoopResync(now({ fields: { a: 1 } }), next({ fields: { a: "1" } })), false, "§6.3 1 과 \"1\" 은 다르다");
  assert.equal(isNoopResync(now({ fields: { a: 1 } }), next({ fields: { a: 1, b: null } })), false, "§6.3 null 값 키는 있는 키");
  assert.equal(isNoopResync(now({ fields: { a: { b: 1 } } }), next({ fields: { a: { b: 2 } } })), false, "§6.3 중첩 값 다름");
});

test("§6.3 raw 가 둘 다 null 또는 undefined 면 같다", () => {
  assert.equal(isNoopResync(now({ raw: null }), next({ raw: null })), true, "§6.3 null × null");
  assert.equal(isNoopResync(now({ raw: undefined }), next({ raw: null })), true, "§6.3 undefined × null");
  assert.equal(isNoopResync(now({ raw: null }), next({ raw: undefined })), true, "§6.3 null × undefined");
  assert.equal(isNoopResync(now({ raw: undefined }), next({ raw: undefined })), true, "§6.3 undefined × undefined");
});

test("§6.4 sort — next.sort 가 null 이면 비교하지 않는다", () => {
  assert.equal(isNoopResync(now({ sort: 5 }), next({ sort: null })), true, "§6.4 now 5 × next null");
  assert.equal(isNoopResync(now({ sort: "7" }), next({ sort: null })), true, "§6.4 now \"7\" × next null");
  assert.equal(isNoopResync(now({ sort: null }), next({ sort: null })), true, "§6.4 null × null");
});

test("§6.4 sort — next.sort 가 숫자면 now.sort(숫자·숫자 문자열)와 같아야 한다", () => {
  assert.equal(isNoopResync(now({ sort: 3 }), next({ sort: 3 })), true, "§6.4 3 × 3");
  assert.equal(isNoopResync(now({ sort: "3" }), next({ sort: 3 })), true, "§6.4 \"3\" × 3");
  assert.equal(isNoopResync(now({ sort: "2.5" }), next({ sort: 2.5 })), true, "§6.4 \"2.5\" × 2.5");
  assert.equal(isNoopResync(now({ sort: 3 }), next({ sort: 4 })), false, "§6.4 3 × 4");
  assert.equal(isNoopResync(now({ sort: "3" }), next({ sort: 4 })), false, "§6.4 \"3\" × 4");
  assert.equal(isNoopResync(now({ sort: null }), next({ sort: 3 })), false, "§6.4 now null × next 3 — 바뀐다");
});

test("§6.5 보관·보관 해제는 무변경이 아니다", () => {
  assert.equal(isNoopResync(now({ lifecycle: "archived" }), next()), false, "§6.5 now 가 archived");
  assert.equal(isNoopResync(now(), next({ archived: true })), false, "§6.5 next.archived=true");
  assert.equal(isNoopResync(now({ lifecycle: "archived" }), next({ archived: true })), false, "§6.5 둘 다");
});

test("§6.6 now 의 injection·provenance·confidence 가 싱크 값이 아니면 false", () => {
  assert.equal(isNoopResync(now({ injection: "always" }), next()), false, "§6.6 injection≠recalled");
  assert.equal(isNoopResync(now({ provenance: "authored" }), next()), false, "§6.6 provenance≠observed");
  assert.equal(isNoopResync(now({ confidence: "high" }), next()), false, "§6.6 confidence≠observed");
  assert.equal(isNoopResync(now({ confidence: "authored" }), next()), false, "§6.6 confidence≠observed (authored)");
});

test("§6.7 canonicalJson — 키 순서가 다른 같은 객체는 같은 문자열(중첩 포함)", () => {
  assert.equal(typeof canonicalJson({ a: 1 }), "string", "§6.7 문자열을 돌려준다");
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }), "§6.7 최상위 키 순서");
  assert.equal(
    canonicalJson({ x: { a: 1, b: [1, { c: 1, d: 2 }] }, y: "z" }),
    canonicalJson({ y: "z", x: { b: [1, { d: 2, c: 1 }], a: 1 } }),
    "§6.7 중첩 객체·배열 속 객체의 키 순서");
});

test("§6.7 canonicalJson — 배열 순서·값이 다르면 다른 문자열", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), "§6.7 배열 순서");
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }), "§6.7 중첩 배열 순서");
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }), "§6.7 값 다름");
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ b: 1 }), "§6.7 키 다름");
});

// connector-mirror 순수부 사양 테스트(#1313 R7) — 분해 선행 안전망(DB 불요, export 표면·행위만).
//  사양 출처: 각 함수 헤더 주석 — merge3(base=마지막 합의값 3-way: theirs 불변→ours 유지 / ours 불변→theirs
//  채택 / 충돌→ours=master), mergeSet(result=(ours−(base−theirs))∪(theirs−base)), nativeStatusOf(카테고리→
//  CHECK 유효 네이티브 status, canceled 는 done 투영), msToKstDate(ms→KST 'YYYY-MM-DD'), ClickUp 필드
//  타입/설정/값 매핑(미지 타입=text, 실패=원본 보존 — 손실 0).
//  실행: npm run build && node dist/v6/connector-mirror.test.js
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// [nativeStatusOf]
// C1  | done→done · canceled→done(투영) · started→in_progress · backlog/unstarted/미지→todo
// [merge3]
// C2  | o===t (둘이 같음)                        | o
// C3  | t===b (theirs 불변)                      | o (우리 편집 보존)
// C4  | o===b (ours 불변)                        | t (외부 편집 채택)
// C5  | 세 값 전부 다름(충돌)                    | o (우리 DB 타이브레이크)
// C6  | base=null(미상): o=null                  | t (레거시 백필) / o 有 → o
// C7  | undefined 입력(부재 행)                  | null 정규화 동치
// [mergeSet]
// C8  | 외부 추가(theirs−base)                   | 유입
// C9  | 외부 삭제(base−theirs), 우리 미재추가    | 빠짐
// C10 | 우리 로컬 추가                           | 보존
// C11 | 우리 로컬 삭제(theirs 불변)              | 보존(재유입 안 됨)
// C12 | 전부 빈 배열 / base=null(부재 행)        | [] / theirs 전량 유입
// [msToKstDate]
// C13 | KST 자정 경계: 14:59:59Z vs 15:00:00Z    | 날짜 하루 차이
// C14 | 0 / 음수 / NaN / 'abc'(부재·경계 행)     | null · 문자열 숫자는 정상
// [mapClickUpFieldType]
// C15 | 각 알려진 타입 매핑 + 미지/null/undefined | 표대로 / 'text' 폴백
// [mapClickUpFieldConfig]
// C16 | drop_down/labels options(id·label 폴백)  | [{id,label,color}] · color 기본 null
// C17 | money currency 기본 USD · rating max 기본 5(count 0 포함) · clickup 원본 백스톱 항상
// [mapClickUpFieldValue]
// C18 | null/undefined 값(부재 행)               | null
// C19 | drop_down: id 매치·orderindex 매치·미매치 | 옵션 id / 옵션 id / 원값
// C20 | labels: 배열 매핑 · 비배열               | id 배열 / 원값
// C21 | checkbox: true·'true'·false·'false'      | true/true/false/false
// C22 | number/money: 숫자화 · 비숫자            | number / 원값
// C23 | date: ms→KST 날짜 · 무효 ms              | 'YYYY-MM-DD' / 원값
// C24 | users: 배열(username→email→id 폴백) · 비배열 | 'a, b' 조인 / 원값
// C25 | progress: percent_complete·current·원시  | 반올림 정수
// C26 | 미지 타입                                | 원값 투과(손실 0)
import assert from "node:assert/strict";
import {
  nativeStatusOf, merge3, mergeSet, msToKstDate,
  mapClickUpFieldType, mapClickUpFieldConfig, mapClickUpFieldValue,
} from "./connector-mirror.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// ── nativeStatusOf ──
t("C1 카테고리→네이티브 status 투영(canceled 는 done — CHECK 에 canceled 없음)", () => {
  assert.equal(nativeStatusOf("done"), "done");
  assert.equal(nativeStatusOf("canceled"), "done");
  assert.equal(nativeStatusOf("started"), "in_progress");
  assert.equal(nativeStatusOf("backlog"), "todo");
  assert.equal(nativeStatusOf("unstarted"), "todo");
  assert.equal(nativeStatusOf("whatever"), "todo");
  assert.equal(nativeStatusOf(""), "todo");
});

// ── merge3 ──
t("C2 o===t → o", () => {
  assert.equal(merge3("b", "x", "x"), "x");
});
t("C3 theirs 불변(t===b) → ours 유지(우리 편집 보존)", () => {
  assert.equal(merge3("orig", "mine", "orig"), "mine");
});
t("C4 ours 불변(o===b) → theirs 채택(외부 편집 유입)", () => {
  assert.equal(merge3("orig", "orig", "theirs"), "theirs");
});
t("C5 양쪽 변경(충돌) → ours(우리 DB=master 타이브레이크)", () => {
  assert.equal(merge3("orig", "mine", "theirs"), "mine");
});
t("C6 base 미상(null): ours 도 null 이면 theirs 백필 · ours 있으면 ours", () => {
  assert.equal(merge3(null, null, "ext"), "ext");   // 미설정 필드 백필
  assert.equal(merge3(null, "mine", "ext"), "mine"); // 우리 값 있으면 보존
});
t("C7 undefined 는 null 로 정규화(부재 행)", () => {
  assert.equal(merge3(undefined, undefined, "ext"), "ext");
  assert.equal(merge3(undefined, undefined, undefined), null);
});

// ── mergeSet ──
t("C8 외부 추가 유입: base=[a] ours=[a] theirs=[a,b] → [a,b]", () => {
  assert.deepEqual(mergeSet(["a"], ["a"], ["a", "b"]).sort(), ["a", "b"]);
});
t("C9 외부 삭제 반영(우리 미재추가): base=[a,b] ours=[a,b] theirs=[a] → [a]", () => {
  assert.deepEqual(mergeSet(["a", "b"], ["a", "b"], ["a"]), ["a"]);
});
t("C10 우리 로컬 추가 보존: base=[a] ours=[a,c] theirs=[a] → [a,c]", () => {
  assert.deepEqual(mergeSet(["a"], ["a", "c"], ["a"]).sort(), ["a", "c"]);
});
t("C11 우리 로컬 삭제 보존(theirs 불변): base=[a,b] ours=[a] theirs=[a,b] → [a]", () => {
  assert.deepEqual(mergeSet(["a", "b"], ["a"], ["a", "b"]), ["a"]);
});
t("C12 빈/부재 base: 전부 [] → [] · base=null 이면 theirs 전량 유입", () => {
  assert.deepEqual(mergeSet([], [], []), []);
  assert.deepEqual(mergeSet(null, [], ["x", "y"]).sort(), ["x", "y"]);
});

// ── msToKstDate ──
t("C13 KST 자정 경계: 14:59:59Z=당일 · 15:00:00Z=익일", () => {
  assert.equal(msToKstDate(Date.UTC(2024, 0, 1, 14, 59, 59)), "2024-01-01");
  assert.equal(msToKstDate(Date.UTC(2024, 0, 1, 15, 0, 0)), "2024-01-02");
});
t("C14 무효 입력(0/음수/NaN/'abc'/undefined) → null · 문자열 숫자 정상", () => {
  for (const bad of [0, -1, NaN, "abc", undefined, null]) assert.equal(msToKstDate(bad), null);
  assert.equal(msToKstDate(String(Date.UTC(2024, 0, 1))), "2024-01-01");
});

// ── mapClickUpFieldType ──
t("C15 알려진 타입 전수 매핑 + 미지/부재 → 'text' 폴백", () => {
  const table: Array<[string, string]> = [
    ["text", "text"], ["short_text", "text"], ["textarea", "textarea"], ["number", "number"],
    ["money", "money"], ["currency", "money"], ["date", "date"], ["drop_down", "dropdown"],
    ["labels", "labels"], ["checkbox", "checkbox"], ["url", "website"], ["email", "email"],
    ["phone", "phone"], ["emoji", "rating"], ["rating", "rating"], ["manual_progress", "progress"],
    ["automatic_progress", "progress_auto"], ["tasks", "relationship"], ["list_relationship", "relationship"],
    ["location", "location"],
  ];
  for (const [cu, ours] of table) assert.equal(mapClickUpFieldType(cu), ours, cu);
  assert.equal(mapClickUpFieldType("mystery"), "text");
  assert.equal(mapClickUpFieldType(null), "text");
  assert.equal(mapClickUpFieldType(undefined), "text");
});

// ── mapClickUpFieldConfig ──
t("C16 drop_down options: id(id→orderindex→name 폴백)·label(name→label)·color 기본 null", () => {
  const cfg = mapClickUpFieldConfig("drop_down", {
    options: [
      { id: "o1", name: "High", color: "#f00" },
      { orderindex: 2, name: "Low" },          // id 부재 → orderindex
      { name: "OnlyName" },                     // id·orderindex 부재 → name
    ],
  });
  assert.deepEqual(cfg.options, [
    { id: "o1", label: "High", color: "#f00" },
    { id: "2", label: "Low", color: null },
    { id: "OnlyName", label: "OnlyName", color: null },
  ]);
});
t("C17 money 기본 USD · rating max(count) 기본/무효 5 · clickup 원본 백스톱 항상", () => {
  assert.equal(mapClickUpFieldConfig("money", {}).currency, "USD");
  assert.equal(mapClickUpFieldConfig("money", { currency_type: "KRW" }).currency, "KRW");
  assert.equal(mapClickUpFieldConfig("rating", { count: 10 }).max, 10);
  assert.equal(mapClickUpFieldConfig("rating", {}).max, 5);
  assert.equal(mapClickUpFieldConfig("rating", { count: 0 }).max, 5); // 0 은 무효 → 5
  const cfg = mapClickUpFieldConfig("text", null);
  assert.deepEqual(cfg.clickup, { type: "text", type_config: null }); // 원본 백스톱
  assert.equal(mapClickUpFieldConfig("text", null).options, undefined); // 비옵션 타입엔 options 없음
});

// ── mapClickUpFieldValue ──
const opts = { options: [{ id: "o1", name: "High", orderindex: 0 }, { id: "o2", name: "Low", orderindex: 1 }] };
t("C18 값 null/undefined → null", () => {
  assert.equal(mapClickUpFieldValue("drop_down", null, opts), null);
  assert.equal(mapClickUpFieldValue("number", undefined, null), null);
});
t("C19 drop_down: id 매치·orderindex 매치 → 옵션 id · 미매치 → 원값", () => {
  assert.equal(mapClickUpFieldValue("drop_down", "o2", opts), "o2");
  assert.equal(mapClickUpFieldValue("drop_down", 1, opts), "o2"); // orderindex 매치
  assert.equal(mapClickUpFieldValue("drop_down", "ghost", opts), "ghost");
});
t("C20 labels: 배열 → 옵션 id 배열 · 비배열 → 원값", () => {
  assert.deepEqual(mapClickUpFieldValue("labels", ["o1", "ghost"], opts), ["o1", "ghost"]);
  assert.equal(mapClickUpFieldValue("labels", "not-array", opts), "not-array");
});
t("C21 checkbox: true/'true' → true · false/'false' → false", () => {
  assert.equal(mapClickUpFieldValue("checkbox", true, null), true);
  assert.equal(mapClickUpFieldValue("checkbox", "true", null), true);
  assert.equal(mapClickUpFieldValue("checkbox", false, null), false);
  assert.equal(mapClickUpFieldValue("checkbox", "false", null), false);
});
t("C22 number/money: 숫자화 · 비숫자 원값 보존", () => {
  assert.equal(mapClickUpFieldValue("number", "42.5", null), 42.5);
  assert.equal(mapClickUpFieldValue("money", 100, null), 100);
  assert.equal(mapClickUpFieldValue("number", "not-num", null), "not-num");
});
t("C23 date: ms → KST 'YYYY-MM-DD' · 무효 ms → 원값", () => {
  assert.equal(mapClickUpFieldValue("date", Date.UTC(2024, 0, 1, 15), null), "2024-01-02");
  assert.equal(mapClickUpFieldValue("date", "garbage", null), "garbage");
});
t("C24 users: username→email→id 폴백 조인 · 빈 항목 필터 · 비배열 원값", () => {
  const users = [{ username: "kim" }, { email: "lee@x.com" }, { id: 7 }, {}];
  assert.equal(mapClickUpFieldValue("users", users, null), "kim, lee@x.com, 7");
  assert.equal(mapClickUpFieldValue("users", "solo", null), "solo");
});
t("C25 progress: percent_complete·current·원시 숫자 → 반올림 정수", () => {
  assert.equal(mapClickUpFieldValue("manual_progress", { percent_complete: 55.4 }, null), 55);
  assert.equal(mapClickUpFieldValue("automatic_progress", { current: 29.6 }, null), 30);
  assert.equal(mapClickUpFieldValue("manual_progress", 80.2, null), 80);
});
t("C26 미지 타입 → 원값 투과(손실 0)", () => {
  assert.equal(mapClickUpFieldValue("mystery", "as-is", null), "as-is");
  const obj = { nested: true };
  assert.equal(mapClickUpFieldValue("mystery", obj, null), obj);
});

console.log(`\n${pass} passed`);

// V4-P4 (P4-dedup) — external-identity.ts byte-identical 회귀 골든 테스트. DB 불요(순수 함수).
//   실행: npm run build && node dist/org/ingest/external-identity.test.js
//
//   목적: dedup 정체성 키 도출이 knowledge-mirror.ts + migrate-items-to-ku.mjs 에 복붙(2벌)돼 있던 것을
//         external-identity.ts(1벌)로 중앙화하며 **동작이 byte-identical** 함을 회귀로 잠근다.
//   방법:
//     (A) 골든 기대값 — 리팩터 이전 인라인 로직의 출력을 하드코딩 상수로 단언(미래 변경 차단).
//     (B) 오라클 동치 — 리팩터 이전 인라인 구현을 이 파일에 그대로 복제(REF_*)해 두고, 중앙 모듈 출력이
//         그 레퍼런스와 글자 단위로 동일함을 단언(복붙 원본 == 중앙화 산출 증명).
import assert from "node:assert/strict";
import {
  KIND_MAP,
  kindForSource,
  unitName,
  normalizeExternalInstance,
  conflictKey,
} from "./external-identity.js";

// ── (B) 리팩터 이전 인라인 로직 레퍼런스(복붙 원본 byte-for-byte 복제 — 오라클). ──
const REF_KIND_MAP: Record<string, string> = {
  "task:clickup": "W",
  "doc:notion": "K",
};
function refUnitName(system: string, externalId: string): string {
  let s = `${system}-${externalId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  if (!s || !/^[a-z0-9]/.test(s)) s = "ku-" + s; // 선두 비영숫자 방어
  return s.slice(0, 64);
}
function refInstance(instance: unknown): string {
  return instance == null ? "" : String(instance);
}

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 1) 여러 source → kind (정의 2종 + 미정의 skip). 골든 + 오라클 동치.
t("kindForSource/KIND_MAP: clickup task→W, notion doc→K, 미정의→undefined", () => {
  // 골든(A)
  assert.equal(kindForSource("task", "clickup"), "W");
  assert.equal(kindForSource("doc", "notion"), "K");
  assert.equal(kindForSource("message", "slack"), undefined);
  assert.equal(kindForSource("task", "notion"), undefined); // 교차 미정의 조합
  // KIND_MAP 상수 자체 골든(키·값 동일)
  assert.deepEqual(KIND_MAP, { "task:clickup": "W", "doc:notion": "K" });
  // 오라클(B): 중앙 == 인라인 레퍼런스. (raw 룩업 undefined 까지 동일)
  for (const [type, sys] of [["task", "clickup"], ["doc", "notion"], ["message", "slack"], ["task", "notion"]] as const) {
    assert.equal(kindForSource(type, sys), REF_KIND_MAP[`${type}:${sys}`]);
  }
});

// 2) slug 정규화 경계 — 대문자/공백/특수문자/선두비영숫자/64자 절단. 골든 + 오라클 동치.
t("unitName: 슬러그 정규화 경계(대문자·특수문자·선두방어·64자 절단)", () => {
  // 골든(A) — 리팩터 이전과 동일 산출.
  assert.equal(unitName("clickup", "ABC 123"), "clickup-abc-123");
  assert.equal(unitName("notion", "Page#42!"), "notion-page-42-");
  assert.equal(unitName("clickup", "task1"), "clickup-task1");
  // 선두 비영숫자(전체가 치환되어 '-' 로 시작 → 'ku-' 방어 후 절단).
  assert.equal(unitName("", "###"), "ku-");
  // 64자 상한 — 긴 external_id 절단.
  const long = unitName("clickup", "x".repeat(200));
  assert.equal(long.length, 64);
  assert.equal(long, ("clickup-" + "x".repeat(200)).slice(0, 64));
  // 오라클(B): 중앙 == 인라인 레퍼런스(대표 + 경계 입력 전수).
  for (const [sys, ext] of [
    ["clickup", "ABC 123"], ["notion", "Page#42!"], ["clickup", "task1"],
    ["", "###"], ["clickup", "x".repeat(200)], ["slack", "U_07-aZ"], ["notion", "한글제목"],
  ] as const) {
    assert.equal(unitName(sys, ext), refUnitName(sys, ext));
  }
});

// 3) instance 정규화 — NULL/undefined→'' , 그 외 String(). 골든 + 오라클 동치.
t("normalizeExternalInstance: null/undefined→'' , 값→String()", () => {
  assert.equal(normalizeExternalInstance(null), "");
  assert.equal(normalizeExternalInstance(undefined), "");
  assert.equal(normalizeExternalInstance("ws1"), "ws1");
  assert.equal(normalizeExternalInstance(42), "42");
  // 오라클(B)
  for (const v of [null, undefined, "ws1", 42, 0, ""]) {
    assert.equal(normalizeExternalInstance(v), refInstance(v));
  }
});

// 4) conflictKey 3필드 — (external_system, external_instance, external_id), instance 정규화 포함.
t("conflictKey: 3필드 도출 + instance NULL→'' 정규화", () => {
  // instance 명시.
  assert.deepEqual(
    conflictKey({ externalSystem: "clickup", externalInstance: "ws1", externalId: "task1" }),
    { externalSystem: "clickup", externalInstance: "ws1", externalId: "task1" },
  );
  // instance 누락(undefined) → '' 정규화(부분 UNIQUE 갭 메움).
  assert.deepEqual(
    conflictKey({ externalSystem: "notion", externalId: "doc1" }),
    { externalSystem: "notion", externalInstance: "", externalId: "doc1" },
  );
  // instance null → '' .
  assert.deepEqual(
    conflictKey({ externalSystem: "slack", externalInstance: null, externalId: "msg1" }),
    { externalSystem: "slack", externalInstance: "", externalId: "msg1" },
  );
  // 오라클(B): 정규화 컴포넌트가 인라인 레퍼런스와 동일.
  assert.equal(
    conflictKey({ externalSystem: "x", externalId: "y" }).externalInstance,
    refInstance(undefined),
  );
});

console.log(`\n${pass} passed (external-identity byte-identical 회귀)`);

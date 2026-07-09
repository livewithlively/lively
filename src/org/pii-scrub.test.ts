// 비정형 PII 탐지·마스킹(P3, #746) 단위 체크 — 체크섬 강 탐지 + 오탐 억제(무효 체크섬은 안 가림) + 구조화 순회.
// 실행: npm run build && node dist/org/pii-scrub.test.js
//  픽스처는 실제 체크섬 통과값(별도 계산): RRN 900101-1234568 · 사업자 1234567891 · 카드 4532123456789014.
import assert from "node:assert/strict";
import { scrubPii, detectPii, scrubPiiDeep } from "./pii-scrub.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 주민등록번호 ──
t("RRN 유효(체크섬 통과) → 가림 + hit", () => {
  const r = scrubPii("주민번호 900101-1234568 입니다");
  assert.ok(!r.text.includes("1234568"), r.text);
  assert.ok(r.text.includes("900101-1"), r.text); // 앞 6+성별 1자리 남김
  assert.deepEqual(r.hits.find((h) => h.type === "rrn"), { type: "rrn", count: 1 });
});
t("RRN 하이픈 없이 13자리도 탐지", () => {
  const r = scrubPii("9001011234568");
  assert.equal(r.hits.find((h) => h.type === "rrn")?.count, 1);
});
t("오탐 억제: 체크섬 실패 13자리는 안 가림(RRN 아님)", () => {
  const r = scrubPii("9001011234560"); // 마지막 자리 틀림
  assert.equal(r.total, 0, r.text);
  assert.equal(r.text, "9001011234560");
});
t("오탐 억제: 월/일 범위 밖(991301-...)은 RRN 아님", () => {
  const r = scrubPii("991301-1234567");
  assert.equal(r.hits.find((h) => h.type === "rrn"), undefined);
});

// ── 사업자등록번호 ──
t("사업자번호 유효(하이픈 표기) → 가림", () => {
  const r = scrubPii("사업자 123-45-67891 확인"); // 1234567891 체크섬 통과, 3-2-5 표기
  assert.ok(!r.text.includes("67891"), r.text);
  assert.equal(r.hits.find((h) => h.type === "biznum")?.count, 1);
});
t("오탐 억제: 체크섬 실패 사업자번호는 안 가림", () => {
  const r = scrubPii("123-45-67890");
  assert.equal(r.hits.find((h) => h.type === "biznum"), undefined);
});

// ── 카드(Luhn) ──
t("카드번호 Luhn 통과 → 뒤4자리만 남기고 가림", () => {
  const r = scrubPii("카드 4532-1234-5678-9014 결제");
  assert.ok(r.text.includes("9014") && !r.text.includes("4532-1234"), r.text);
  assert.equal(r.hits.find((h) => h.type === "card")?.count, 1);
});
t("오탐 억제: Luhn 실패 16자리는 안 가림", () => {
  const r = scrubPii("4532123456789010");
  assert.equal(r.hits.find((h) => h.type === "card"), undefined);
});

// ── 휴대전화 ──
t("휴대전화 010-XXXX-XXXX → 가운데 가림", () => {
  const r = scrubPii("연락처 010-1234-5678");
  assert.ok(r.text.includes("010-****-5678"), r.text);
  assert.equal(r.hits.find((h) => h.type === "phone")?.count, 1);
});
t("오탐 억제: 일반 숫자열(주문번호 등)은 전화로 안 봄", () => {
  const r = scrubPii("주문 20260709 수량 12345");
  assert.equal(r.total, 0, JSON.stringify(r.hits));
});

// ── 이메일 ──
t("이메일 → 로컬부 가림·도메인 유지", () => {
  const r = scrubPii("문의 hong@example.com 로");
  assert.ok(r.text.includes("h***@example.com"), r.text);
  assert.equal(r.hits.find((h) => h.type === "email")?.count, 1);
});

// ── 복합/구조화 ──
t("한 문장에 여러 PII → 각각 집계", () => {
  const r = scrubPii("홍길동 900101-1234568, 010-1234-5678, hong@x.com");
  assert.equal(r.total, 3);
  assert.ok(!r.text.includes("1234568") && r.text.includes("010-****-5678") && r.text.includes("h***@x.com"));
});
t("detectPii: 탐지만(원문 불변) — 게이팅용", () => {
  const hits = detectPii("주민 900101-1234568");
  assert.equal(hits.find((h) => h.type === "rrn")?.count, 1);
});
t("scrubPiiDeep: 중첩 객체/배열 값만 스크럽 + 누적 hits, 키 불변", () => {
  const { value, total, hits } = scrubPiiDeep({ user: { rrn: "900101-1234568", note: "010-1234-5678" }, tags: ["hong@x.com"] });
  assert.equal(total, 3);
  assert.ok(!JSON.stringify(value).includes("1234568"));
  assert.ok(JSON.stringify(value).includes("h***@x.com"));
  assert.ok((value as { user: { rrn: string } }).user.rrn.startsWith("900101-1")); // 키 'rrn' 보존, 값만 마스킹
  assert.equal(hits.find((h) => h.type === "phone")?.count, 1);
});
t("빈/비문자 입력 안전", () => {
  assert.equal(scrubPii("").total, 0);
  assert.equal(scrubPii(null).total, 0);
  assert.equal(scrubPiiDeep({ n: 5, b: true, z: null }).total, 0);
});

console.log(`\npii-scrub tests: ${pass} passed`);

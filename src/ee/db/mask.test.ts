// 컬럼 마스킹 단위 체크(#186) — 스타일 변환 + 출처기반 대상선정 + 행 적용(순수).
// 실행: npm run build && node dist/db/mask.test.js
import assert from "node:assert/strict";
import { maskValue, planMaskTargets, applyRowMasking } from "./mask.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── maskValue 스타일 ──
t("full → ***", () => assert.equal(maskValue("123-45-6789", "full"), "***"));
t("null → null", () => assert.equal(maskValue("x", "null"), null));
t("null/undefined 입력은 그대로", () => { assert.equal(maskValue(null, "full"), null); assert.equal(maskValue(undefined, "hash"), undefined); });
t("partial → 앞1·뒤1", () => assert.equal(maskValue("123456789", "partial"), "1***9"));
t("partial 짧은값(<=2) → ***", () => { assert.equal(maskValue("ab", "partial"), "***"); assert.equal(maskValue("a", "partial"), "***"); });
t("email → 로컬부 가림·도메인 유지", () => assert.equal(maskValue("alice@example.com", "email"), "a***@example.com"));
t("email @없음 → partial 폴백", () => assert.equal(maskValue("noatsign", "email"), "n***n"));
t("hash → sha256: 접두 + 64hex, 결정론적", () => {
  const h1 = maskValue("secret", "hash") as string;
  const h2 = maskValue("secret", "hash") as string;
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(maskValue("other", "hash"), h1);
});
t("숫자 입력 full → ***", () => assert.equal(maskValue(12345, "full"), "***"));

// ── planMaskTargets — 출처(srcKey) 매칭만 대상, 무출처(null)·미매칭 제외 ──
//  srcKey: pg `${tableID}:${columnID}` / mysql `${orgTable}.${orgName}`(lower) — 엔진 중립(#715).
const attr = new Map<string, "full" | "partial" | "email" | "hash" | "null">([["21400:2", "full"], ["21400:5", "email"]]);
t("pg 출처(oid:attnum) 매칭 컬럼만 대상(스타일 동반)", () => {
  const fields = [
    { name: "id", srcKey: "21400:1" }, // 미매칭
    { name: "ssn", srcKey: "21400:2" }, // 매칭 full
    { name: "renamed_email", srcKey: "21400:5" }, // 매칭 email(이름 달라도 출처로 잡힘)
    { name: "expr", srcKey: null }, // 표현식 — 제외
  ];
  const targets = planMaskTargets(fields, attr);
  assert.deepEqual(targets, [{ index: 1, style: "full" }, { index: 2, style: "email" }]);
});
t("매칭 없으면 빈 대상", () => assert.deepEqual(planMaskTargets([{ name: "x", srcKey: "999:1" }], attr), []));
t("mysql 출처(table.col) 키도 동일 동작(#715)", () => {
  const attrMy = new Map<string, "full" | "partial" | "email" | "hash" | "null">([["tb_cr_error.ssn", "full"]]);
  const targets = planMaskTargets(
    [{ name: "x", srcKey: "tb_cr_error.ssn" }, { name: "grade", srcKey: "tb_cr_error.grade" }, { name: "expr", srcKey: null }],
    attrMy,
  );
  assert.deepEqual(targets, [{ index: 0, style: "full" }]);
});

// ── applyRowMasking — 대상 인덱스만 마스킹, 나머지 보존, 원본 불변 ──
t("행 마스킹 적용 + 원본 불변", () => {
  const rows = [[1, "123-45-6789", "alice@example.com", "keep"]];
  const out = applyRowMasking(rows, [{ index: 1, style: "full" }, { index: 2, style: "email" }]);
  assert.deepEqual(out, [[1, "***", "a***@example.com", "keep"]]);
  assert.deepEqual(rows, [[1, "123-45-6789", "alice@example.com", "keep"]]); // 원본 불변
});
t("대상 없으면 원본 반환", () => { const rows = [[1, 2]]; assert.equal(applyRowMasking(rows, []), rows); });

console.log(`\n${pass} checks passed`);

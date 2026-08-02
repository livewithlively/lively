import assert from "node:assert";
import { scrubSqlLiterals } from "./sql-scrub.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("리터럴 없으면 그대로", () =>
  assert.equal(scrubSqlLiterals("SELECT id, nice_cb_grade FROM b_credit_report"),
    "SELECT id, nice_cb_grade FROM b_credit_report"));
t("문자열 리터럴 마스킹", () =>
  assert.equal(scrubSqlLiterals("SELECT * FROM t WHERE name = '홍길동'"),
    "SELECT * FROM t WHERE name = '?'"));
t("이스케이프 따옴표도 내용 은닉", () =>
  assert.ok(!scrubSqlLiterals("WHERE x = 'O''Brien'").includes("Brien")));
t("숫자 접미 테이블명 보존", () =>
  assert.ok(scrubSqlLiterals("SELECT * FROM tb_cr_nice_0210005_13").includes("tb_cr_nice_0210005_13")));
t("10자리+ 연속숫자 마스킹(bare 주민)", () =>
  assert.equal(scrubSqlLiterals("WHERE jumin = 9001011234567"), "WHERE jumin = ?"));
t("소규모 숫자 보존(LIMIT)", () =>
  assert.equal(scrubSqlLiterals("SELECT * FROM t LIMIT 100"), "SELECT * FROM t LIMIT 100"));
t("달러-인용 마스킹", () =>
  assert.ok(!scrubSqlLiterals("SELECT $t$secret 홍길동$t$ AS x").includes("홍길동")));
t("mysql 백슬래시 이스케이프도 내용 은닉(#715)", () => {
  const out = scrubSqlLiterals("SELECT * FROM t WHERE name = 'O\\'Brien' AND a=1");
  assert.ok(!out.includes("Brien"), out);
});
t("빈 문자열 no-op", () => assert.equal(scrubSqlLiterals(""), ""));

console.log(`\n${pass} checks passed`);

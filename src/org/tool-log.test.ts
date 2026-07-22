// 호출 감사로그 인자 정책 테스트 (#1082). 사양·엣지 표 = spec 표 A/B/C.
//
//  회귀 대상 ①: **외부로 나간 통신 내용이 감사로그에 평문으로 남던 것.** 슬랙 DM 본문·메일 내용이 무기한 저장되고
//   관리자면 관리탭에서 전부 읽혔다. "값이 한 글자도 안 남는다"를 최종 저장 형태(argsForLog)에서 못 박는다.
//  회귀 대상 ②: **판정이 상류가 정하는 값에 의존하면 안 된다** — 필드 이름을 해석해 가리는 방식은 상류가 스키마를
//   바꾸면 조용히 무효화된다. 그래서 이 테스트도 필드 이름을 전제하지 않는다(어떤 키든 값이 안 남는지만 본다).
//  회귀 대상 ③: **판정 불명이면 안 남긴다**(A4). 등록 순서·경로가 바뀌어 신고가 빠져도 새면 안 된다.
//  회귀 대상 ④: 빌트인·db_query 경로 **무회귀**(C2·C3) — 이 변경이 기존 기록을 망가뜨리지 않았는지.
import assert from "node:assert/strict";
import {
  argsForLog, omitArgValues, externalArgsPolicy, markExternalTool, resetExternalTools, EXT_PREFIX,
} from "./tool-log.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
// 저장될 형태에 이 문자열이 남았는가 — 필드 이름이 아니라 '값'을 기준으로 본다.
const stored = (tool: string, args: unknown): string => JSON.stringify(argsForLog(tool, args));

// ── A. 어떤 툴의 인자를 남기나 ──
t("A1 빌트인은 대상이 아니다 — 현행대로 값이 남는다", () => {
  resetExternalTools();
  assert.equal(externalArgsPolicy("knowledge_save"), null);
  assert.ok(stored("knowledge_save", { body_md: "조직 지식 본문" }).includes("조직 지식 본문"));
});

t("A2 프록시 툴(예외 꺼짐) — 값 미기록", () => {
  resetExternalTools();
  markExternalTool("ext__slack__slack_send_message", false);
  assert.equal(externalArgsPolicy("ext__slack__slack_send_message"), "omit");
  assert.ok(!stored("ext__slack__slack_send_message", { message: "안녕" }).includes("안녕"));
});

t("A3 프록시 툴(예외 켜짐) — 값 기록", () => {
  resetExternalTools();
  markExternalTool("ext__internal__ping", true);
  assert.equal(externalArgsPolicy("ext__internal__ping"), "log");
  assert.ok(stored("ext__internal__ping", { note: "내부전용" }).includes("내부전용"));
});

t("A4 신고 누락된 프록시 툴도 값 미기록(fail-closed)", () => {
  resetExternalTools(); // 신고가 하나도 없는 상태
  assert.equal(externalArgsPolicy(`${EXT_PREFIX}unknown__whatever`), "omit");
  assert.ok(!stored(`${EXT_PREFIX}unknown__whatever`, { text: "새는지본다" }).includes("새는지본다"));
});

t("A5 HTTP 프록시는 이름이 임의라 접두 백스톱이 안 걸린다 — 신고가 유일 경로", () => {
  resetExternalTools();
  // 관리자가 'crm_lookup' 처럼 임의 이름을 붙인다 → 신고 없이는 빌트인과 구분할 방법이 없다.
  //  이 행은 '이렇게 되는 게 옳다'가 아니라 **신고를 빼먹으면 새는 지점이 여기**임을 고정하는 것이다.
  assert.equal(externalArgsPolicy("crm_lookup"), null);
});

t("A6 신고된 HTTP 프록시 툴 — 값 미기록", () => {
  resetExternalTools();
  markExternalTool("crm_lookup", false);
  assert.equal(externalArgsPolicy("crm_lookup"), "omit");
  assert.ok(!stored("crm_lookup", { q: "고객이름" }).includes("고객이름"));
});

t("A7 db_query 는 대상이 아니다", () => {
  resetExternalTools();
  assert.equal(externalArgsPolicy("db_query"), null);
});

// ── B. 값을 어떻게 지우나 ──
t("B1 값이 하나도 안 남는다 — 키 이름과 크기만", () => {
  const out = omitArgValues({ message: "연봉 협상 얘기 좀 하자", channel_id: "U0BDW2YCCAK" });
  const json = JSON.stringify(out);
  assert.ok(!json.includes("연봉"), "본문이 남았다");
  assert.ok(!json.includes("U0BDW2YCCAK"), "대상 식별자가 남았다");
  assert.deepEqual(out.keys, ["message", "channel_id"]);
  assert.ok(typeof out.bytes === "number" && out.bytes > 0);
});

t("B2 중첩 객체 안쪽 값도 안 남는다", () => {
  const out = omitArgValues({ payload: { text: "비밀", nested: { deep: "더비밀" } }, blocks: ["a"] });
  const json = JSON.stringify(out);
  assert.ok(!json.includes("비밀"));
  assert.ok(!json.includes("더비밀"));
  assert.deepEqual(out.keys, ["payload", "blocks"]);
});

t("B3 최상위가 배열이면 개수만", () => {
  const out = omitArgValues(["비밀1", "비밀2"]);
  assert.ok(!JSON.stringify(out).includes("비밀"));
  assert.equal(out.items, 2);
});

t("B4 없음/null 이어도 던지지 않는다", () => {
  assert.doesNotThrow(() => omitArgValues(null));
  assert.doesNotThrow(() => omitArgValues(undefined));
});

t("B5 빈 객체는 키 0개", () => {
  assert.deepEqual(omitArgValues({}).keys, []);
});

t("B6 키는 50개까지만(경계값)", () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) many[`k${i}`] = i;
  assert.equal((omitArgValues(many).keys as string[]).length, 50);
});

t("B7 키 이름은 64자까지만(경계값)", () => {
  const out = omitArgValues({ ["x".repeat(200)]: 1 });
  assert.equal((out.keys as string[])[0].length, 64);
});

t("B8 순환참조여도 던지지 않는다 — 크기는 포기, 키는 남음", () => {
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  const out = omitArgValues(cyc);
  assert.deepEqual(out.keys, ["a", "self"]);
  assert.equal(out.bytes, undefined);
});

// ── C. 실제 저장되는 값(무회귀) ──
t("C1 외부 툴은 어떤 필드 이름을 쓰든 값이 안 남는다", () => {
  resetExternalTools();
  markExternalTool("ext__x__y", false);
  // 상류가 message→text→payload 로 이름을 바꿔도 결과가 같아야 한다(필드명 비의존).
  for (const key of ["message", "text", "payload", "완전히새로운필드"]) {
    assert.ok(!stored("ext__x__y", { [key]: "새면안되는값" }).includes("새면안되는값"), `${key} 에서 샜다`);
  }
});

t("C2 db_query 는 SQL 리터럴이 스크럽된 채 기록(무회귀)", () => {
  resetExternalTools();
  const out = stored("db_query", { sql: "SELECT * FROM member WHERE name='홍길동'" });
  assert.ok(out.includes("SELECT"), "SQL 구조는 남아야 한다");
  assert.ok(!out.includes("홍길동"), "리터럴이 스크럽되지 않았다");
});

t("C3 빌트인은 시크릿 마스킹 + 절단 유지(무회귀)", () => {
  resetExternalTools();
  const out = argsForLog("knowledge_save", { token: "ghp_" + "a".repeat(25), body_md: "x".repeat(600) }) as Record<string, string>;
  assert.equal(out.token, "[REDACTED]");
  assert.ok(out.body_md.startsWith("x".repeat(500)));
  assert.ok(out.body_md.includes("+100자"));
});

console.log(`\n${pass} passed`);

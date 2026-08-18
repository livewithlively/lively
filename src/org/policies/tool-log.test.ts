// 호출 감사로그 인자 정책 테스트 (#1082). 사양·엣지 표 = spec 표 A/B/C.
//
//  회귀 대상 ①: **외부로 나간 통신 내용이 감사로그에 평문으로 남던 것.** 슬랙 DM 본문·메일 내용이 무기한 저장되고
//   관리자면 관리탭에서 전부 읽혔다. "값이 한 글자도 안 남는다"를 최종 저장 형태(argsForLog)에서 못 박는다.
//  회귀 대상 ②: **판정이 상류가 정하는 값에 의존하면 안 된다** — 필드 이름을 해석해 가리는 방식은 상류가 스키마를
//   바꾸면 조용히 무효화된다. 그래서 이 테스트도 필드 이름을 전제하지 않는다(어떤 키든 값이 안 남는지만 본다).
//  회귀 대상 ③: **판정 불명이면 안 남긴다**(A4). 등록 순서·경로가 바뀌어 신고가 빠져도 새면 안 된다.
//  회귀 대상 ④: 빌트인·db_query 경로 **무회귀**(C2·C3) — 이 변경이 기존 기록을 망가뜨리지 않았는지.
//
// ── 성공/실패 판정 (#1653). 사양·엣지 표 = spec 표 F/G. ──────────────────────────────────────
//  회귀 대상 ⑤: **툴 에러가 성공으로 적재되던 것.** 프록시는 실패를 예외가 아니라 `isError:true` **정상 반환**
//   으로 돌려주는데 계측이 throw 여부만 봤다 → 구글 3종이 전부 403 인데 관리탭 오류 수는 0 이었다(2026-08-12 실측).
//   이 판정 위에 상류 회귀 탐지(#1657)를 얹으므로 여기가 틀리면 탐지도 같이 눈이 먼다.
//  회귀 대상 ⑥: **error 저장 경로에 EE 전용 기능을 태우면 안 된다**(G5) — 태우면 EE 미탑재 코어 박스에서
//   외부 툴 에러가 통째로 삼켜진다(scrubPii 는 미탑재 시 throw). 프록시가 이미 스크럽해 넘기므로 여기선 시크릿만.
import assert from "node:assert/strict";
import {
  argsForLog, omitArgValues, externalArgsPolicy, markExternalTool, resetExternalTools, EXT_PREFIX,
  toolResultFailure, errorForLog,
} from "./tool-log.js";
import { scrubPii } from "../ingest/pii-scrub.js";

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

// ── F. 무엇을 실패로 세나 (표 F) ──
//  단언은 '문구'가 아니라 **판정 결과**로 한다 — 상세없음 문구를 한 글자 다듬었다고 거짓 실패하면 안 된다.
const failed = (out: unknown): boolean => toolResultFailure(out) !== null;

t("F1 실패 표시가 없으면 성공", () => {
  assert.equal(toolResultFailure({ content: [{ type: "text", text: "정상 결과" }] }), null);
});

t("F2 실패 표시가 명시적으로 false 면 성공", () => {
  assert.equal(toolResultFailure({ content: [{ type: "text", text: "ok" }], isError: false }), null);
});

t("F3 실패 표시 + 에러 텍스트 → 실패로 세고 그 텍스트가 사유로 남는다", () => {
  const r = toolResultFailure({ content: [{ type: "text", text: "PERMISSION_DENIED" }], isError: true });
  assert.equal(r, "PERMISSION_DENIED");
});

t("F4 텍스트 블록이 여럿이면 전부 남는다(첫 블록만 남기지 않는다)", () => {
  const r = toolResultFailure({
    content: [{ type: "text", text: "앞부분" }, { type: "text", text: "뒷부분" }], isError: true,
  });
  assert.ok(r !== null && r.includes("앞부분") && r.includes("뒷부분"), `한쪽이 사라졌다: ${r}`);
});

t("F5 실패 표시만 있고 내용이 아예 없어도 — 실패 사실이 소실되지 않는다", () => {
  const r = toolResultFailure({ isError: true });
  assert.notEqual(r, null, "실패인데 성공으로 셌다");
  assert.ok((r as string).length > 0, "사유가 빈 문자열이면 로그에서 성공과 구분이 안 된다");
});

t("F6 텍스트 아닌 내용만 있어도(이미지 등) 실패로 센다", () => {
  const r = toolResultFailure({ content: [{ type: "image", data: "iVBORw0K", mimeType: "image/png" }], isError: true });
  assert.notEqual(r, null);
  assert.ok((r as string).length > 0);
});

t("F7 결과가 객체가 아니면 성공(판정 불가 → 보수적)", () => {
  for (const v of [undefined, null, "문자열", 42, true, [{ type: "text", text: "x" }]]) {
    assert.equal(toolResultFailure(v), null, `${JSON.stringify(v)} 를 실패로 셌다`);
  }
});

t("F8 실패 표시가 boolean 이 아닌 참같은 값이면 성공(엄격 판정)", () => {
  // 상류가 무엇을 넣든 우리 판정은 흔들리지 않는다 — SDK·mcp-proxy 와 같은 엄격 비교.
  assert.equal(toolResultFailure({ isError: "true", content: [] }), null);
  assert.equal(toolResultFailure({ isError: 1, content: [] }), null);
});

t("F9 회귀 재현 — 구글 403 이 http_proxy 로 돌아온 그 형태를 실패로 잡는다", () => {
  // dynamic-tools.ts 가 실제로 만드는 모양 그대로: HTTP 는 200 이 아니고, 실패는 isError 로만 온다.
  const upstream403 = {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: 403, ok: false, truncated: false,
        body: '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}',
      }, null, 2),
    }],
    isError: true,
  };
  assert.ok(failed(upstream403), "이 형태를 성공으로 세면 커넥터가 다 죽어도 오류 수가 0 이 된다");
  assert.ok((toolResultFailure(upstream403) as string).includes("PERMISSION_DENIED"), "사유를 알 수 없으면 탐지가 불가능하다");
});

t("F10 빌트인·DB 툴의 통상 결과는 성공(무회귀)", () => {
  // capability 는 json(d) = {content:[text]} 로만 반환한다 — 실패 표시 축이 아예 없다.
  assert.equal(toolResultFailure({ content: [{ type: "text", text: JSON.stringify({ rows: [] }) }] }), null);
});

// ── G. 사유를 어떻게 남기나 (표 G) ──
t("G1 평범한 예외 메시지는 그대로 남는다", () => {
  assert.equal(errorForLog("knowledge_save", "제목은 필수입니다"), "제목은 필수입니다");
});

t("G2 시크릿은 가리고 진단 정보는 남긴다", () => {
  resetExternalTools();
  markExternalTool("ext__x__y", false);
  const out = errorForLog("ext__x__y", "프록시 호출 실패: [HTTP 401] Authorization: Bearer " + "a".repeat(40)) as string;
  assert.ok(!out.includes("a".repeat(40)), "토큰이 그대로 남았다");
  assert.ok(out.includes("401"), "시크릿을 가린다고 진단 정보까지 지우면 탐지가 불가능하다");
});

t("G3 상한 경계 — 정확히 2000자까지만(오프바이원)", () => {
  // 상한을 **관측**해서 얻으면(긴 입력을 넣고 길이를 읽는 식) 상한이 2001 로 어긋나도 통과한다 — 실제로 그 방식은
  //  오프바이원 mutation 을 놓쳤다. 그래서 정책값을 여기 못 박는다(바꾸려면 사양과 함께 바꾼다).
  const CAP = 2000;
  assert.equal((errorForLog("t", "x".repeat(100_000)) as string).length, CAP, "상한이 안 걸렸거나 값이 달라졌다");
  assert.equal((errorForLog("t", "y".repeat(CAP)) as string).length, CAP, "상한 정확히는 잘리면 안 된다");
  assert.equal((errorForLog("t", "y".repeat(CAP + 1)) as string).length, CAP, "상한+1 이 안 잘렸다");
});

t("G4 없음·빈 문자열은 안 남긴다", () => {
  assert.equal(errorForLog("t", null), null);
  assert.equal(errorForLog("t", undefined), null);
  assert.equal(errorForLog("t", ""), null);
});

t("G5 EE 미탑재 판본에서도 외부 툴 에러가 삼켜지지 않는다", () => {
  resetExternalTools();
  markExternalTool("ext__google-drive__search_files", false);
  // 배선 단언 — 이 환경이 정말 'EE 미탑재'인가. 아니면 이 행은 아무것도 검증하지 못한다(vacuous).
  assert.throws(() => scrubPii("x"), "EE 가 탑재된 환경이라 G5 가 무의미해졌다 — 테스트를 다시 설계할 것");
  const out = errorForLog("ext__google-drive__search_files", "PERMISSION_DENIED: 상류가 거부했습니다");
  assert.ok(out !== null && out.includes("PERMISSION_DENIED"), "무료판에서 에러 사유가 사라졌다");
});

t("G6 아주 큰 본문이 와도 던지지 않는다", () => {
  assert.doesNotThrow(() => errorForLog("ext__x__y", "본문".repeat(200_000)));
});

console.log(`\n${pass} passed`);

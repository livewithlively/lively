// 순수 단위 체크(node:assert) — tmux user option 에 구조값(JSON)을 싣는 통로(#1541).
// 실행: npm run build && node dist/terminal/opt-json.test.js
//
// **이 파일이 지키는 계약**: 인코딩 산출물이 `psmux`(Windows 네이티브 멀티플렉서)가 값을 그대로 돌려주는
//  문자셋 안에 있어야 한다. psmux 3.3.7 실측(Windows Server 2022 · Node execFile 경로)에서 옵션 값의
//  `"` · `'` · 탭은 **소실**됐고 base64 알파벳·백슬래시·한글·`$`·`#{}`·`;`·`=` 는 보존됐다.
//  ⚠ 이 계약은 mac/linux CI 에선 절대 재현되지 않는다(tmux 는 아무것도 안 벗긴다) — 그래서 "그 문자를
//   내보내지 않는다"를 정적으로 못박는다. #1510 이 세운 규율(윈도우 전용 분기는 순수함수로 직접 검증)과 같다.
//  사양·엣지 표: 프로젝트 #1541.
import assert from "node:assert/strict";
import { encodeOptJson, decodeOptJson } from "./tmux-exec.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// psmux 가 삼키는 문자들 — 산출물에 하나라도 있으면 Windows 노드에서 값이 깨진다.
const PSMUX_LOSSY = /["'\t]/;
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

// E1 — 객체(플래그) 왕복
t("E1 객체(플래그) 왕복", () => {
  const v = { "--model": "opus", readonly: "1" };
  assert.deepEqual(decodeOptJson(encodeOptJson(v), {}), v);
});

// E2 — 배열(초대) 왕복
t("E2 배열(초대 목록) 왕복", () => {
  const v = ["yoon", "jang"];
  assert.deepEqual(decodeOptJson(encodeOptJson(v), []), v);
});

// E3 — 소실 후보 문자가 값 자체에 들어 있어도 왕복 무손실
t("E3 따옴표·탭·한글·백슬래시·포맷문자 왕복", () => {
  const v = {
    label: "검증 세션 라벨",
    path: "C:\\work\\dir",
    fmt: "#{session_name}",
    quoted: 'he said "hi"',
    single: "a'b",
    tabbed: "a\tb",
    dollar: "$HOME",
  };
  assert.deepEqual(decodeOptJson(encodeOptJson(v), {}), v);
});

// E4 ★ — 산출물 문자셋 계약(이 파일의 존재 이유)
t("E4 ★ 산출물에 psmux 소실문자(\" ' 탭)가 없고 base64 알파벳만", () => {
  for (const v of [
    { a: 'he said "hi"' },
    ["a'b", "c\td"],
    { nested: { deep: ['"', "'", "\t"] } },
    { 한글키: "값" },
    {},
    [],
  ]) {
    const enc = encodeOptJson(v);
    assert.ok(!PSMUX_LOSSY.test(enc), `소실문자가 산출물에 있음: ${enc}`);
    assert.ok(BASE64_ONLY.test(enc), `base64 알파벳 밖 문자: ${enc}`);
    assert.deepEqual(decodeOptJson(enc, null), v);
  }
});

// E5 — 레거시 평문 JSON 객체(이미 떠 있는 세션)
t("E5 레거시 평문 JSON 객체를 그대로 읽는다", () => {
  assert.deepEqual(decodeOptJson('{"--model":"opus"}', {}), { "--model": "opus" });
});

// E6 — 레거시 평문 JSON 배열
t("E6 레거시 평문 JSON 배열을 그대로 읽는다", () => {
  assert.deepEqual(decodeOptJson('["yoon","jang"]', []), ["yoon", "jang"]);
});

// E7 — 위탁 세션이 실제로 쓰는 빈 배열 리터럴
t("E7 빈 배열 리터럴 []", () => {
  assert.deepEqual(decodeOptJson("[]", null), []);
});

// E8 — 따옴표가 벗겨진 훼손값은 조용히 오독되지 않는다
t("E8 따옴표 벗겨진 값 → fallback (조용한 오독 금지)", () => {
  assert.deepEqual(decodeOptJson("{readonly:true,mode:normal}", { safe: "1" }), { safe: "1" });
  assert.deepEqual(decodeOptJson("[yoon,jang]", []), []);
});

// E9 — 빈 값·공백
t("E9 빈 문자열·공백만 → fallback", () => {
  assert.deepEqual(decodeOptJson("", []), []);
  assert.deepEqual(decodeOptJson("   ", []), []);
});

// E10 — base64 로는 풀리나 JSON 이 아님
t("E10 base64 로 풀리지만 JSON 이 아님 → fallback", () => {
  assert.deepEqual(decodeOptJson("bm90IGpzb24=", []), []);
});

// E11 — base64 도 JSON 도 아닌 쓰레기
t("E11 쓰레기 값 → fallback", () => {
  assert.deepEqual(decodeOptJson("not-base64-!!!", []), []);
  assert.deepEqual(decodeOptJson("깨진값", []), []);
});

// E12 — 새로 도입한 값의 부재: LIST_FMT 필드가 모자라면 undefined 가 들어온다
t("E12 raw 가 undefined·null 이어도 throw 하지 않고 fallback", () => {
  assert.deepEqual(decodeOptJson(undefined as unknown as string, []), []);
  assert.deepEqual(decodeOptJson(null as unknown as string, { d: "1" }), { d: "1" });
});

// E13 — 경계값: 빈 객체/빈 배열도 base64 로 왕복
t("E13 경계값 — 빈 객체·빈 배열 왕복", () => {
  assert.deepEqual(decodeOptJson(encodeOptJson({}), null), {});
  assert.deepEqual(decodeOptJson(encodeOptJson([]), null), []);
});

// E14 — 실패 방향: 초대는 넓어지지 않는다
t("E14 초대 판정 실패는 '비공개'로 떨어진다(넓어지지 않음)", () => {
  for (const bad of ["", "   ", "깨진값", "[yoon,jang]", "bm90IGpzb24="]) {
    assert.deepEqual(decodeOptJson<string[]>(bad, []), [], `넓어짐: ${bad}`);
  }
});

console.log(`\n${pass} passed`);

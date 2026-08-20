// AI 세션 이름 (#1719) — CLI 출력 정제의 엣지 표. 각 블록 = 시나리오 1개.
//  🔴 여기가 무르면 **탭·사이드바에 문장 한 덩어리가 이름으로 박힌다**(짧은 이름을 얻으려고 부른 것인데 도로아미타불).
//  ⚠ CLI 호출(aiSessionName) 자체는 여기서 안 부른다 — 외부 프로세스·모델 응답이라 결정적이지 않다.
//   그 실패 경로(CLI 없음·타임아웃)는 "빈 문자열 → 규칙 이름 유지"로 설계돼 있어 호출자 쪽에서 안전하다.
import assert from "node:assert/strict";
import { cleanAiName, aiNamingEnabled } from "./session-name-ai.js";

// ① 그냥 이름 — 그대로.
assert.equal(cleanAiName("채팅박스 디자인 수정"), "채팅박스 디자인 수정");
// ② 따옴표·마침표를 두른 이름 — 벗긴다(모델이 흔히 두른다).
assert.equal(cleanAiName('"결제 백오프".'), "결제 백오프");
assert.equal(cleanAiName("「팀 로그 요약」"), "팀 로그 요약");
// ③ 군말이 뒤에 붙으면 **첫 줄만** 쓴다.
assert.equal(cleanAiName("세션 열기 화면\n\n이 이름을 제안합니다."), "세션 열기 화면");
// ④ 앞 빈 줄이 있어도 첫 '내용' 줄을 집는다.
assert.equal(cleanAiName("\n\n  탭 이름 고치기  "), "탭 이름 고치기");
// ⑤ 길면 자른다 — 12자 상한(…은 안 붙인다: 짧은 게 목적이다).
assert.equal(cleanAiName("새 세션 컴포저 홈처럼 고치기"), "새 세션 컴포저 홈처럼");
// ⑥ 이름이 아니라 **문장**을 뱉었으면 안 쓴다(빈 문자열 → 호출자가 규칙 이름을 그대로 둔다).
assert.equal(cleanAiName("이 세션은 사용자가 프로젝트 안에서 새 세션을 여는 화면을 고치려는 것으로 보입니다."), "");
// ⑦ 빈 출력·공백 출력도 빈 문자열.
assert.equal(cleanAiName(""), "");
assert.equal(cleanAiName("   \n  \n"), "");
// ⑧ 끄기 스위치 — LIVELY_AI_SESSION_NAME=0 인 박스는 규칙 이름만 쓴다.
{
  const before = process.env.LIVELY_AI_SESSION_NAME;
  process.env.LIVELY_AI_SESSION_NAME = "0";
  assert.equal(aiNamingEnabled(), false);
  delete process.env.LIVELY_AI_SESSION_NAME;
  assert.equal(aiNamingEnabled(), true);
  if (before !== undefined) process.env.LIVELY_AI_SESSION_NAME = before;
}
console.log("ok  AI 세션 이름 정제 8갈래");

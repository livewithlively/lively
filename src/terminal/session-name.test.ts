// 세션 이름 규칙 (#1808) — 이 표가 틀렸을 때 실제로 났던 일:
//  🔴 한 프로젝트 아래 세션 일곱 개가 **전부 같은 이름**('APP. lvly. io 셀프서브 방식 와이어프레임')이라
//     사이드바에서 어느 게 무엇인지 구분할 방법이 없었다(dev 실측 2026-08-20: 프로젝트 세션 147건 중 104건).
import assert from "node:assert/strict";
import { sessionNameFromPrompt, isUnnamedSession } from "./session-name.js";

// ① 첫 지시가 곧 이름 — 한 줄로 접고 끝의 문장부호를 뗀다.
assert.equal(sessionNameFromPrompt("  랜딩 카피를\n  고쳐 줘.  "), "랜딩 카피를 고쳐 줘");
assert.equal(sessionNameFromPrompt("이거 왜 안 되지???"), "이거 왜 안 되지");

// ② 28자에서 자른다(사이드바·탭·카드 어디서도 그 이상은 안 보인다). 자른 표시는 남긴다.
{
  const long = "가".repeat(80);
  const out = sessionNameFromPrompt(long);
  assert.equal(out.length, 28, `28자여야 하는데 ${out.length}`);
  assert.ok(out.endsWith("…"), "자른 표시(…)가 남아야 한다");
}
// ③ 경계 — 딱 28자는 안 자른다.
assert.equal(sessionNameFromPrompt("나".repeat(28)), "나".repeat(28));

// ④ 이름으로 쓸 게 없으면 빈 문자열 — 호출자가 폴백(id)을 정한다. 여기서 지어내지 않는다.
assert.equal(sessionNameFromPrompt("   \n  "), "");
assert.equal(sessionNameFromPrompt(""), "");

// ⑤ '아직 이름 없음' 판정 — label 이 box id 그대로일 때만. 사람이 지은 이름은 자동 이름이 절대 덮지 않는다.
assert.equal(isUnnamedSession("box-yoon-1a2b3c4d", "box-yoon-1a2b3c4d"), true);
assert.equal(isUnnamedSession("", "box-yoon-1a2b3c4d"), true);
assert.equal(isUnnamedSession("  ", "box-yoon-1a2b3c4d"), true);
assert.equal(isUnnamedSession("랜딩 카피 수정", "box-yoon-1a2b3c4d"), false);
// ⑥ ★회귀 방어 — 프로젝트명이 이름이어도 그건 '사람이 지은 이름'으로 본다(뒤늦게 덮어쓰지 않는다).
//   고치는 자리는 생성 시점이지 사후 개명이 아니다(session-form.ts 프리필 폐지).
assert.equal(isUnnamedSession("APP. lvly. io 셀프서브 방식 와이어프레임", "box-yoon-1a2b3c4d"), false);

console.log("ok  세션 이름 규칙 6갈래");

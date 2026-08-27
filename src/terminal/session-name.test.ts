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

// ── 에이전트가 지은 이름 (#1979) — 이 규칙이 틀렸을 때 나는 일: ───────────────
//  🔴 구 cleanAiName 은 40자 넘는 입력을 **빈 문자열로 거절**했다("문장을 통째로 뱉었다"). 이제 이름은 세션이
//     사용자 턴 **안에서** 툴로 등록한다 — 거기서 거절하면 모델이 형식을 맞추려 다시 부르느라 사람이
//     기다리는 시간만 늘어난다(윤상민 2026-08-25: "실패응답 되도록 발생시키지말고. 글자수 초과 이런건 걍 trim").
//     그래서 **거절하지 않고 자른다**.
import { sessionNameFromAgent } from "./session-name.js";

// ⓐ 통상 — 그대로 남는다.
assert.equal(sessionNameFromAgent("결제 백오프"), "결제 백오프");

// ⓑ 따옴표와 마침표가 **섞여** 있어도 한 번에 벗긴다(순서대로 지우면 하나가 남는다).
assert.equal(sessionNameFromAgent('"결제 백오프".'), "결제 백오프");
assert.equal(sessionNameFromAgent("「한글 자모분리」"), "한글 자모분리");

// ⓒ ★12자에서 자른다 — 거절하지 않는다.
assert.equal(sessionNameFromAgent("가".repeat(13)), "가".repeat(12));

// ⓓ ★경계 — 정확히 12자는 안 자른다.
assert.equal(sessionNameFromAgent("나".repeat(12)), "나".repeat(12));

// ⓔ ★정책 변경 회귀 — 문장을 통째로 뱉어도 **빈 문자열이 아니다**(구 동작은 "" 거절이었다).
{
  const sentence = "이 세션은 결제 백오프 로직을 고치는 자리입니다 그러니까 그렇게 이름을 붙이면 되겠습니다";
  const out = sessionNameFromAgent(sentence);
  assert.notEqual(out, "", "긴 문장을 거절하면 안 된다 — 잘라서라도 이름을 준다");
  assert.equal(out.length, 12, `12자로 잘려야 하는데 ${out.length}자`);
}

// ⓕ 여러 줄이면 첫 줄만(모델이 뒤에 설명을 붙여도 이름만 남는다).
assert.equal(sessionNameFromAgent("결제 백오프\n이유는 …"), "결제 백오프");

// ⓖ 이름으로 쓸 게 없으면 빈 문자열 — 호출자가 지금 이름을 그대로 둔다(여기서 지어내지 않는다).
assert.equal(sessionNameFromAgent(""), "");
assert.equal(sessionNameFromAgent("   \n  "), "");
assert.equal(sessionNameFromAgent('"".'), "");

// ── #2116 첫 문장 경계 — 사양 엣지 표 E1~E13 ────────────────────────────────
//  🔴 URL 한복판에서 끊기면 — 이름이 `…열려니까 안열려. https:/…` 가 되어 무슨 세션인지 안 읽힌다(dev 실측).
//  🔴 마침표가 이어진 글자 사이에서 끊기면 — `v1.2 를 올리자` 가 `v1` 이 된다.
//  🔴 줄을 다 걸러 빈 이름이 나오면 — 세션 이름이 통째로 box id 로 떨어진다.
{
  const P = sessionNameFromPrompt;

  // E1 빈 입력
  assert.equal(P(""), "");
  assert.equal(P("   \n\t "), "");

  // E2·E3 짧은 한 줄
  assert.equal(P("세션 목록 고치자"), "세션 목록 고치자");
  assert.equal(P("세션 목록 고치자."), "세션 목록 고치자");

  // E4 ★ 문장 + 다음 줄에 URL·스택트레이스 → 첫 문장만
  assert.equal(
    P("내가 원준이 세션 열려니까 안열려.\nhttps://dev.lvly.io/ui/#/s/box-jang-05ab7578\nmain.js?v=aaf959b6:587 noteTruncated\n    at api (net.js:129:19)"),
    "내가 원준이 세션 열려니까 안열려",
    "🔴 붙여넣은 URL·스택이 이름을 먹었다");

  // E5 ★ 같은 줄에 문장 + URL
  assert.equal(P("이거 고쳐줘. https://dev.lvly.io/ui/#/s/box-a"), "이거 고쳐줘");

  // E6 ★ 첫 줄이 URL 뿐 → 다음 쓸 줄
  assert.equal(P("https://dev.lvly.io/ui/#/s/box-a\n세션 이름이 잘려"), "세션 이름이 잘려");

  // E7 ★ 첫 문장이 MAX 초과 → 잘린다
  const long1 = P("아주 길고 긴 첫 문장인데 스물여덟자를 확실히 넘기도록 늘려 쓴다. 두 번째 문장.");
  assert.equal(long1.length, 28);
  assert.ok(long1.endsWith("…"), "🔴 초과분이 … 로 안 잘렸다");

  // E8 문장부호 없이 MAX 초과 (종전 동작)
  const long2 = P("현재 열려있는 pr중 모든 커밋이 이미 dev게이트웨이에 반영되었는지 확인해줘");
  assert.equal(long2.length, 28);
  assert.ok(long2.endsWith("…"));

  // E9 ★ 첫 문장이 너무 짧으면 경계로 안 친다
  assert.equal(P("ㅇㅇ. 세션 목록을 고치자"), "ㅇㅇ. 세션 목록을 고치자",
    "🔴 두 글자짜리 첫 문장으로 이름을 만들었다");

  // E10 ★ 마침표가 글자 사이면 문장 끝이 아니다
  assert.equal(P("v1.2 를 올리자"), "v1.2 를 올리자", "🔴 버전 표기의 점에서 끊었다");
  assert.equal(P("main.js 를 고쳐줘"), "main.js 를 고쳐줘");

  // E11 ★ 코드펜스 안은 건너뛴다
  assert.equal(P("```\nsome code here\n```\n이 코드 고쳐줘"), "이 코드 고쳐줘");

  // E12b 부호만 친 입력은 **종전대로** 빈 이름이다 — 개선을 슬쩍 끼우지 않는다는 계약
  assert.equal(P("???"), "");
  assert.equal(P("..."), "");

  // E12 ★ 건질 문장이 0 이어도 빈 이름을 만들지 않는다(폴백이 실제로 돈다)
  const only = P("    at api (net.js:129:19)\n    at async createAppInstance (app-instance.js:26:17)");
  assert.notEqual(only, "", "🔴 폴백이 안 돌아 이름이 비었다");
  assert.ok(only.length <= 28, "🔴 폴백이 MAX 를 안 지켰다");

  // E13 여러 공백·탭·줄바꿈은 한 칸으로
  assert.equal(P("세션   목록\t고치자"), "세션 목록 고치자");
}

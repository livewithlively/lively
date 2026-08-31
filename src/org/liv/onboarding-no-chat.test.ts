// 처음 설정에서 리브와의 챗봇 문답을 걷어냈다 (#1631, 원준님 2026-08-31)
//
//  지시: *"쓸데없이 중간에 연결 끝나고 앱 나온 다음에 리브랑 챗봇처럼 대화하는 부분 …
//   리브가 막 자료 분류해놓고, 매주 하는거 있냐고 물어보고 그러는 부분. 거기 없애버려줘."*
//
//  걷어낸 것: 'read' 진입 + b1(서랍 승인)·b2(주기 문서)·b3(팀 공유)·nowline·can(예시),
//   그리고 그 문답만 소비하던 analyzeUploads(그 사람 AI 구독으로 도는 헤드리스 분류).
//  [앱] 다음은 finishOnboarding() 으로 곧장 간다.
//
//  ⚠ 이 검사는 «지웠나» 만이 아니라 «끝까지 갈 수 있나» 를 함께 지킨다 —
//   문답을 지우면서 마무리로 가는 길까지 끊으면 사람이 온보딩을 **끝낼 수 없게** 된다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("① 챗 문답 단계가 사라졌다", () => {
  assert.doesNotMatch(code, /const CHAT_STEPS\b/, "CHAT_STEPS 가 남아 있다");
  assert.doesNotMatch(code, /function chatStep\(/, "chatStep 이 남아 있다");
  assert.doesNotMatch(code, /function enterChat\(/, "enterChat 이 남아 있다");
  assert.doesNotMatch(code, /function replayChatTo\(/, "replayChatTo 가 남아 있다");
  //  차례표에도 없어야 한다 — 남으면 ?scene= 으로 되살아난다.
  const order = code.match(/const ORDER = \[([^\]]*)\]/);
  assert.ok(order, "ORDER 를 못 찾았다 — 검사가 헛돈다");
  for (const k of ["'read'", "'b1'", "'b2'", "'b3'", "'nowline'", "'can'"]) {
    assert.ok(!order[1].includes(k), `ORDER 에 ${k} 가 남아 있다`);
  }
});

test("② 그런데 끝까지 갈 수 있다 — [앱]이 마무리로 잇는다", () => {
  assert.match(code, /async function finishOnboarding\(\)/, "마무리 함수가 없다");
  const calls = (code.match(/void finishOnboarding\(\)/g) || []).length;
  assert.equal(calls, 3, `[앱] 장면의 출구 3개가 마무리로 안 간다(${calls}개)`);
  assert.doesNotMatch(code, /goScene\('read'\)/, "아직 없어진 장면으로 보낸다");
  //  마무리가 실제로 워크스페이스를 바꾸는 그 호출을 유지한다(무회귀).
  assert.match(code, /api\('\/api\/ui\/me\/welcome', \{ method: 'POST'/, "반영 호출이 사라졌다");
  assert.match(code, /localStorage\.setItem\(DONE_KEY, '1'\)/, "끝냄 표식을 안 남긴다 — 다음 로그인이 또 온보딩으로 간다");
});

test("③ 승인받은 적 없는 분류를 조용히 만들지 않는다", () => {
  //  문답을 없앤 이유가 «묻지도 않고 나눠 놓는 것» 인데, 서랍만 남기면 정확히 그게 된다.
  assert.match(code, /drawers: \[\],/, "서랍을 여전히 보낸다 — 물어본 적 없는 분류를 만들게 된다");
  for (const k of ["cadence", "share", "nowline", "first_order"]) {
    assert.match(code, new RegExp(`${k}: null,`), `${k} 를 지어내 보낸다 — 물어본 적이 없다`);
  }
});

test("④ 아무도 안 보는 AI 분류를 돌리지 않는다", () => {
  //  analyzeUploads 는 b1 하나만 소비했다. 남겨 두면 그 사람 AI 구독으로 헤드리스 세션이 매번 돌아 비용만 난다.
  assert.doesNotMatch(code, /function analyzeUploads\(/, "쓰지도 않는 AI 분류가 남아 있다");
  assert.doesNotMatch(code, /ANALYZE_TIMEOUT_MS/, "그 상한 상수가 남아 있다");
});

test("⑤ 이어서 열기가 없어진 장면을 가리키지 않는다(무회귀)", () => {
  //  중간에 나갔다 돌아온 사람이 'can' 으로 보내지면 그 장면이 없어 화면이 안 뜬다.
  const rs = code.slice(code.indexOf("function resumeScene("));
  assert.doesNotMatch(rs.slice(0, 600), /return 'can'/, "없어진 챗 장면으로 되돌린다");
  assert.match(rs.slice(0, 600), /if \(p\.scene === 'done'\) return 'app'/, "마무리 직전으로 되돌리지 않는다");
});

// 순수 단위 체크(node:assert) — 아웃박스(#1753)의 정책·에코 바늘. 배달자(파일·tmux·DB)는 여기서 안 띄운다.
import assert from "node:assert/strict";
import { echoNeedle, flatOneLine, retryDelayMs, READY_WINDOW_MS, NOT_READY_TTL_MS } from "./session-outbox.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] flatOneLine — 개행은 공백 하나로(send-keys 규약 ①과 같은 변환이어야 에코가 맞는다)", () => {
  assert.equal(flatOneLine("a\nb"), "a b");
  assert.equal(flatOneLine("  a \n  b \n\n c  "), "a b c");
  assert.equal(flatOneLine(""), "");
});
t("[2] echoNeedle — JSON 이스케이프 형태(따옴표·역슬래시·한글 원문 유지)", () => {
  assert.equal(echoNeedle('say "hi"'), 'say \\"hi\\"');
  assert.equal(echoNeedle("경로는 C:\\tmp"), "경로는 C:\\\\tmp");
  assert.equal(echoNeedle("안녕하세요"), "안녕하세요");
  // 트랜스크립트 한 줄에 실제로 들어가는 형태 — JSON.stringify 로 감싼 문서에서 부분일치해야 한다.
  const line = JSON.stringify({ type: "user", message: { role: "user", content: 'say "hi"' } });
  assert.ok(line.includes(echoNeedle('say "hi"')));
});
t("[2b] echoNeedle — 접두 160자만(긴 텍스트 꼬리 뒤섞임 내성): 꼬리가 달라져도 매치된다", () => {
  const long = "가".repeat(200) + " 꼬리";
  const mangled = "가".repeat(200) + " 리꼬";           // 꼬리가 뒤섞인 주입 결과
  const doc = JSON.stringify({ content: mangled });
  assert.ok(doc.includes(echoNeedle(long)));
});
t("[3] retryDelayMs — 완만히 늘고 30초에 멈춘다(로그인 화면을 계속 두드리지 않는다)", () => {
  assert.equal(retryDelayMs(1), 15_000);
  assert.equal(retryDelayMs(4), 30_000);
  assert.equal(retryDelayMs(100), 30_000);
});
t("[4] 창 상수 — 한 번의 준비 대기(20s)와 TTL(30분)의 관계가 뒤집히지 않는다", () => {
  assert.ok(READY_WINDOW_MS < NOT_READY_TTL_MS);
});

console.log(`session-outbox: ${pass} passed`);

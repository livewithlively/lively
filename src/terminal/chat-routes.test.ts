// 순수 단위 체크(node:assert) — 세션 대화창(#1719)의 두 순수 규칙: 트랜스크립트 읽기 구간 · 단일 키 argv.
//  라우트 자체(파일·tmux·인가)는 여기서 안 띄운다 — 구간 계산과 키 표면 규칙만 표로 못박는다.
import assert from "node:assert/strict";
import { transcriptRange, TRANSCRIPT_MAX_CHUNK } from "../sessions/transcript-range.js";
import { sendKeyPlan, isChatKey } from "./send-keys.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] 인자 없음 → 처음부터 끝까지(상한 내)", () => {
  assert.deepEqual(transcriptRange(1000, {}), { start: 0, end: 1000 });
});
t("[2] tail=N → 끝에서 N 바이트(첫 로드) · 파일이 더 작으면 0부터", () => {
  assert.deepEqual(transcriptRange(1000, { tail: "300" }), { start: 700, end: 1000 });
  assert.deepEqual(transcriptRange(100, { tail: "300" }), { start: 0, end: 100 });
});
t("[3] from 이 크기와 같거나 크면 빈 구간(새 내용 없음) — 화면의 증분 폴링이 이 경우를 매번 친다", () => {
  assert.deepEqual(transcriptRange(1000, { from: "1000" }), { start: 1000, end: 1000 });
  assert.deepEqual(transcriptRange(1000, { from: "5000" }), { start: 1000, end: 1000 });
});
t("[4] from+to → 그 구간, to 는 크기로 잘림, to<from 은 빈 구간", () => {
  assert.deepEqual(transcriptRange(1000, { from: "100", to: "400" }), { start: 100, end: 400 });
  assert.deepEqual(transcriptRange(1000, { from: "900", to: "4000" }), { start: 900, end: 1000 });
  assert.deepEqual(transcriptRange(1000, { from: "500", to: "100" }), { start: 500, end: 500 });
});
t("[5] from 이 있으면 tail 은 무시(증분 폴링이 tail 을 실어 보내도 되감기지 않는다)", () => {
  assert.deepEqual(transcriptRange(1000, { from: "800", tail: "900" }), { start: 800, end: 1000 });
});
t("[6] 상한 — 한 번에 TRANSCRIPT_MAX_CHUNK 를 넘기지 않는다(30MB 세션 실측)", () => {
  const big = TRANSCRIPT_MAX_CHUNK * 3;
  assert.deepEqual(transcriptRange(big, {}), { start: 0, end: TRANSCRIPT_MAX_CHUNK });
});
t("[7] 잡값(음수·소수·문자)은 없는 것으로", () => {
  assert.deepEqual(transcriptRange(1000, { from: "-1", to: "abc", tail: "1.5" }), { start: 0, end: 1000 });
});
t("[8] 키 — tmux 는 키 이름, psmux 는 코드포인트 · 허용 키는 Enter/Escape 뿐", () => {
  assert.deepEqual(sendKeyPlan("box-a", "Enter", "/opt/homebrew/bin/tmux"), ["send-keys", "-t", "box-a", "Enter"]);
  assert.deepEqual(sendKeyPlan("box-a", "Escape", "/opt/homebrew/bin/tmux"), ["send-keys", "-t", "box-a", "Escape"]);
  assert.deepEqual(sendKeyPlan("box-a", "Enter", "C:\\x\\psmux.exe"), ["send-keys", "-t", "box-a", "0x0d"]);
  assert.deepEqual(sendKeyPlan("box-a", "Escape", "C:\\x\\psmux.exe"), ["send-keys", "-t", "box-a", "0x1b"]);
  assert.equal(isChatKey("Enter"), true); assert.equal(isChatKey("Escape"), true);
  assert.equal(isChatKey("y"), false); assert.equal(isChatKey(""), false); assert.equal(isChatKey(undefined), false);
});

console.log(`chat-routes: ${pass} passed`);

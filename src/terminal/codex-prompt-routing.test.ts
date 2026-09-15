import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name: string): string => readFileSync(new URL(`../../src/terminal/${name}`, import.meta.url), "utf8");
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `검사할 코드 구간을 못 찾았습니다: ${from}`);
  return text.slice(start, end);
};

test("Codex App Server 후속 입력 실패는 셸 아웃박스로 폴백하지 않는다", () => {
  const block = between(source("deliver-prompt.ts"), "// ── codex app-server 모드", "  if (!nodeId) {");
  assert.doesNotMatch(block, /enqueuePrompt|injectPrompt/, "pane 이 셸인 모드에서 PTY 전달기를 부르면 안 된다");
  assert.match(block, /throw new HttpError/, "프로토콜 실패를 화면에 드러내야 한다");
});

test("Codex App Server 첫 입력 실패도 셸 아웃박스로 폴백하지 않는다", () => {
  const block = between(source("sessions.ts"), "    if (chatMode === \"app-server\") {", "    } else if (isNode) {");
  assert.doesNotMatch(block, /enqueuePrompt|injectFirstPrompt/, "첫 입력도 프로토콜 밖으로 새면 안 된다");
});

test("프로젝트 노드의 지연 첫 입력은 후속 입력과 같은 단일 전달기를 쓴다", () => {
  const block = between(source("session-launch.ts"), "    if (plan.deferredPrompt) {", "    //  ★ 이 갈래는");
  assert.match(block, /deliverPrompt\(/, "지연 첫 입력도 공통 전달 판정을 거쳐야 한다");
  assert.doesNotMatch(block, /await injectDeferredFirstPrompt\(/, "Codex 여부를 보지 않고 PTY에 직접 넣으면 안 된다");
});

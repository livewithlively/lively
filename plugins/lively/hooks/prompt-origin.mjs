// UserPromptSubmit 의 prompt 가 사람이 친 말인지, 하네스가 밀어 넣은 메시지인지 가른다.
//  하네스는 작업 끝 알림·하위 에이전트 보고·슬래시 명령 래퍼도 같은 이벤트로 보낸다(#1631 이 last_prompt 에서 같은 원인을 고쳤다).
//  러너(run-custom.mjs)가 이 판정을 훅 입력의 `lively_prompt_injected` 로 실어 보내고, 사람의 의도에 반응하는 훅(라우터·지식 회수)이
//  그 값을 보고 빠진다. 훅마다 제 판별을 두면 갈라진다(project-auto-bind 의 `startsWith("<")` 가 그 흔적이다).
//
//  접두 목록은 서버의 사람 말 판별식(src/terminal/terminal-transcript.ts INJECTED_RE)을 그대로 덮고 `<agent-message` 를 더한다.
//  서버 쪽 기록 경로는 하위 에이전트 보고를 기록 줄의 메타 표시로 거르지만, 훅이 받는 것은 글자뿐이라 글자로 가려야 한다.
//  prompt-origin.test.mjs 가 서버 판별식의 모든 접두를 여기서 덮는지 검사한다 — 서버 쪽에 접두를 더하면 여기도 더해야 테스트가 통과한다.
export const INJECTED_PROMPT_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|<agent-message|\[Request interrupted|Caveat:|This session is being continued)/;

export function isInjectedPrompt(prompt) {
  return INJECTED_PROMPT_RE.test(String(prompt ?? ""));
}

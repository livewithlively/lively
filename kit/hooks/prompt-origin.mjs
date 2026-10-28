// UserPromptSubmit 의 prompt 가 사람이 친 말인지, 하네스가 밀어 넣은 메시지인지 가른다.
//  하네스는 작업 끝 알림·하위 에이전트 보고·슬래시 명령 래퍼도 같은 이벤트로 보낸다(#1631 이 last_prompt 에서 같은 원인을 고쳤다).
//  러너(run-custom.mjs)가 이 판정을 훅 입력의 `lively_prompt_injected` 로 실어 보내고, 사람의 의도에 반응하는 훅(라우터·지식 회수)이
//  그 값을 보고 빠진다. 훅마다 제 판별을 두면 갈라진다(project-auto-bind 의 `startsWith("<")` 가 그 흔적이다).
//
//  접두 목록은 web/lib/ask-text.ts 의 INJECTED_RE 와 같다 — 그쪽이 훅이 보고한 lastPrompt 에서 실제로 관측된 봉투를 모은
//  정본이다(#4233: 다른 세션이 보낸 메시지·작업 알림·권한 허가 알림). 키트는 그 TS 를 import 할 수 없어 사본을 두고,
//  prompt-origin.test.mjs 가 그 판별식과 src/terminal/terminal-transcript.ts 의 판별식이 가진 접두를 여기서 모두 덮는지 검사한다.
export const INJECTED_PROMPT_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|<agent-message|<teammate-message|<channel-message|<user-prompt-submit-hook|\[Request interrupted|Caveat:|This session is being continued|Another Claude session sent a message|Permission granted for:|Your claude\.ai usage limit)/;

export function isInjectedPrompt(prompt) {
  return INJECTED_PROMPT_RE.test(String(prompt ?? ""));
}

// lib/ask-text.ts — 세션 줄 둘째 줄(«내가 마지막으로 한 말»)에 **사람이 친 말만** 싣는 잣대 한 자리 — 순수 함수.
//  #4233(원준 2026-09-25, 홈 사이드바 진단): 세션별 축의 둘째 줄에 `<agent-message from="…">` 원문이 그대로 떴다.
//   서버 칸(lastPrompt, #2197)은 훅이 UserPromptSubmit 순간 보고한 값이라, 하네스가 사람 대신 끼워 넣은 메시지
//   (다른 세션이 보낸 메시지 · 작업 알림 · 권한 허가 알림)도 사람 말처럼 들어온다. 꼬리 조회(sess-tail)에는
//   거르는 식이 있었지만 이 봉투들이 빠져 있었고, 서버 칸 쪽에는 거르는 식이 아예 없었다.
//  두 길(서버 칸 · 꼬리 조회)이 **같은 식**을 쓰게 여기 한 벌만 둔다. 잎 모듈인 이유는 past-sess 와 같다(시험할 데).

/** 사람이 친 말이 아니라 하네스가 끼워 넣은 글인가 — 앞머리로 가른다. */
export const INJECTED_RE = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|<agent-message|<teammate-message|<channel-message|<user-prompt-submit-hook|\[Request interrupted|Caveat:|This session is being continued|Another Claude session sent a message|Permission granted for:|Your claude\.ai usage limit)/;

export function isInjectedPrompt(t: string | null | undefined): boolean {
  return INJECTED_RE.test(String(t || ''));
}

/**
 * 줄에 올릴 글로 다듬는다. 끼워 넣은 글이면 null(부르는 쪽은 다른 말을 찾는다).
 *  · 사람이 붙여 넣은 긴 글(`<pasted_content …>…</pasted_content>`)은 태그째 보이면 안 되므로 «(붙여 넣은 글)» 로 줄인다.
 *    닫는 태그가 꼬리에서 잘렸으면 끝까지를 줄인다.
 */
export function cleanAskText(t: string | null | undefined): string | null {
  const s = String(t || '');
  if (!s.trim() || isInjectedPrompt(s)) return null;
  const x = s.replace(/<pasted_content\b[^>]*>[\s\S]*?(<\/pasted_content[^>]*>|$)/g, ' (붙여 넣은 글) ').replace(/\s+/g, ' ').trim();
  return x || null;
}

// 대화창 큐 행 ↔ 이미 그린 기록 (#4819) — 서버가 «미확인» 이라고 준 말이 기록에 이미 있으면 다시 그리지 않는다.
//
//  무엇이 문제였나(상민님 신고 2026-10-16): 대화창에서 보낸 말이 답까지 끝나고 세션이 회수된 뒤 다시 열면, 대화엔 그 말과 답이
//   다 있는데 맨 아래에 같은 말이 «보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요 [다시 보내기][지우기]» 로
//   또 그려졌다. 서버 큐의 «미확인»(sent·echo-unconfirmed)은 친 뒤 15초 창의 판정인데, Claude Code 는 사람 말을 UserPromptSubmit
//   훅이 끝난 뒤에야 기록에 적는다(그날 22.5초 — 창이 28ms 먼저 닫혔다). 서버는 이제 목록을 줄 때 기록과 다시 대조해 바로잡는다
//   (src/sessions/outbox-late-echo.ts). 그 대조는 못 읽으면(중계 실패·아직 배포 전) «미확인» 을 그대로 두는데, 화면은 이미 그
//   기록을 읽어 그렸다 — 눈앞에 있는 말을 «안 들어갔을 수 있어요» 로 또 그리지 않는다.
//  판정 규칙은 서버(outbox-late-echo.ts)와 **같다** — 같은 말(samePrompt)도, 증거 창(행이 생긴 때 − 5초 ~ 마감한 때 + 5초)도.
//   화면이 더 느슨하면 서버가 «미확인» 이라 한 말을 화면만 «들어갔다» 로 지우게 된다(거짓 «전달됨» — 격리 리뷰 재현: 앞 64자만 같은
//   다른 말에 가려졌다). 계약 시험(scripts/outbox-echo.test.mjs E3)이 두 판을 같은 표로 맞춘다.

/** 서버가 «못 봤다» 고만 한 상태 — 기록이 사실을 말해 줄 수 있는 두 경우(서버 outbox-late-echo.lateEchoCandidate 와 같다). */
export function unconfirmedRow(row: { status?: unknown; last_error?: unknown }): boolean {
  return (row.status === 'sent' && row.last_error === 'echo-unconfirmed')
    || (row.status === 'failed' && row.last_error === 'send: host-unknown');
}

/** 행 시각(서버 DB)과 기록 시각(하네스가 도는 기계)의 차이 허용 — 서버 LATE_ECHO_SKEW_MS 와 같다. */
export const ECHO_SKEW_MS = 5_000;
/** 같은 말 판정의 머리 길이 — 서버 session-outbox ECHO_HEAD_CHARS 와 같다. */
export const PROMPT_HEAD = 160;

const norm = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/** (순수) 같은 말인가 — 공백을 하나로 접은 뒤, 160자 이하면 전체가, 그보다 길면 머리 160자가 같아야 한다(서버 samePrompt 와 같다). */
export function samePrompt(said: string, line: string): boolean {
  const a = norm(said), b = norm(line);
  if (!a || !b) return false;
  if (a.length <= PROMPT_HEAD) return a === b;
  return a.slice(0, PROMPT_HEAD) === b.slice(0, PROMPT_HEAD);
}

/** (순수) #4794 «다 쳤다» 알림(outbox.typed)의 머리 — 서버 session-outbox typedHead 와 **같은 글자**를 만든다(공백을 하나로 접고 다듬은 뒤
 *  앞 PROMPT_HEAD 자). 화면은 기다리던 말의 머리를 이것으로 만들어 알림의 head 와 그대로 견준다. 같은 말 판정(samePrompt)과 같은 접기·길이다 —
 *  잘린 머리를 samePrompt 에 넣지 않는 이유: 160번째 글자가 공백이면 다듬기에 잘려 긴 말이 안 맞는다. 계약: scripts/outbox-typed-contract.test.mjs. */
export function promptHead(text: string): string {
  return norm(text).slice(0, PROMPT_HEAD);
}

/**
 * (순수) 이 행의 말이 이미 그린 기록의 사람 말 턴에 있나.
 *  증거 창 = [행이 생긴 때 − 5초, «미확인» 으로 마감한 때 + 5초] — 사람 말 줄의 시각은 **제출한 때**이고, 아웃박스는 치고 Enter 를 누른
 *  뒤에 마감한다. 행보다 먼저 적힌 같은 말(같은 지시를 두 번 보낸 앞 것)도, 마감 뒤에 사람이 다시 친 같은 말도 이 행의 증거가 아니다.
 *  turns 는 기록에서 온 사람 말 턴만 넘긴다(아직 기록에 안 이어진 낙관 말풍선은 증거가 아니다).
 */
export function echoedInTurns(
  row: { text?: unknown; created_at?: unknown; updated_at?: unknown },
  turns: ReadonlyArray<{ text?: string | null; ts?: string }>,
  skewMs: number = ECHO_SKEW_MS,
): boolean {
  const created = Date.parse(String(row.created_at ?? '')), marked = Date.parse(String(row.updated_at ?? ''));
  if (!Number.isFinite(created) || !Number.isFinite(marked)) return false;
  const said = String(row.text ?? '');   // 빈 글은 samePrompt 가 거른다
  const lo = created - skewMs, hi = marked + skewMs;
  return turns.some((t) => {
    if (!t.text || !samePrompt(said, t.text)) return false;
    const at = Date.parse(String(t.ts ?? ''));
    return at >= lo && at <= hi;
  });
}

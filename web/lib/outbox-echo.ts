// 대화창 큐 행 ↔ 이미 그린 기록 (#4819) — 서버가 «미확인» 이라고 준 말이 기록에 이미 있으면 다시 그리지 않는다.
//
//  무엇이 문제였나(상민님 신고 2026-10-16): 대화창에서 보낸 말이 답까지 끝나고 세션이 회수된 뒤 다시 열면, 대화엔 그 말과 답이
//   다 있는데 맨 아래에 같은 말이 «보냈지만 세션 기록에서 확인되지 않았어요 — 안 들어갔을 수 있어요 [다시 보내기][지우기]» 로
//   또 그려졌다. 서버 큐의 «미확인»(sent·echo-unconfirmed)은 친 뒤 15초 창의 판정인데, Claude Code 는 사람 말을 UserPromptSubmit
//   훅이 끝난 뒤에야 기록에 적는다(그날 22.5초 — 창이 28ms 먼저 닫혔다). 서버는 이제 목록을 줄 때 기록과 다시 대조해 바로잡는다
//   (src/sessions/outbox-late-echo.ts). 그 대조는 못 읽으면(중계 실패·아직 배포 전) «미확인» 을 그대로 두는데, 화면은 이미 그
//   기록을 읽어 그렸다 — 눈앞에 있는 말을 «안 들어갔을 수 있어요» 로 또 그리지 않는다.

/** 서버가 «못 봤다» 고만 한 상태 — 기록이 사실을 말해 줄 수 있는 두 경우(서버 outbox-late-echo.lateEchoCandidate 와 같다). */
export function unconfirmedRow(row: { status?: unknown; last_error?: unknown }): boolean {
  return (row.status === 'sent' && row.last_error === 'echo-unconfirmed')
    || (row.status === 'failed' && row.last_error === 'send: host-unknown');
}

/** 행 시각(서버 DB)과 기록 시각(하네스가 도는 기계)의 차이 허용 — 서버 LATE_ECHO_SKEW_MS 와 같다. 말은 큐에 들어간 뒤에 쳐진다. */
export const ECHO_SKEW_MS = 5_000;

/**
 * (순수) 이 행의 말이 이미 그린 기록의 사람 말 턴에 있나 — 행이 생긴 뒤(시계 차 허용)에 적힌, 같은 말인 턴.
 *  행보다 먼저 적힌 같은 말(같은 지시를 두 번 보낸 경우)은 세지 않는다 — 두 번째가 정말 안 들어갔을 수 있다.
 *  same = 화면이 낙관 말풍선과 기록을 잇는 규칙(session-chat.ts sameSaid)을 그대로 받는다 — 두 규칙이 갈리면 같은 말이 두 번 보인다.
 */
export function echoedInTurns(
  row: { text?: unknown; created_at?: unknown },
  turns: ReadonlyArray<{ text?: string | null; ts?: string }>,
  same: (a: string, b: string) => boolean,
  skewMs: number = ECHO_SKEW_MS,
): boolean {
  const since = Date.parse(String(row.created_at ?? '')) - skewMs;
  if (!Number.isFinite(since)) return false;
  const said = String(row.text ?? '');
  if (!said.trim()) return false;
  return turns.some((t) => !!t.text && same(t.text, said) && Date.parse(String(t.ts ?? '')) >= since);
}

// 트랜스크립트 읽기 구간(#1719 세션 대화창) — 순수. 로컬 대화 파일(terminal/chat-routes)과 중앙 세션 기록
//  (sessions/session-log-routes)이 **같은 규칙**으로 창(window)을 자른다. 긴 세션은 30MB 를 넘으므로(실측)
//  화면은 꼬리부터 창으로 읽고, 위로 더 필요하면 [from,to) 로 다시 청한다.
//  두 라우트가 헤더도 같이 쓴다: X-Log-Bytes(전체 워터마크) · X-Log-From · X-Log-To.

/** 한 번에 내주는 상한. */
export const TRANSCRIPT_MAX_CHUNK = 4 * 1024 * 1024;

/**
 * 요청 → 실제 읽을 [start, end).
 *  · from 이 크기를 넘으면 빈 구간(=새 내용 없음 — 증분 폴링의 평상시 답)
 *  · to 없으면 끝까지(상한 내) · tail 은 from 이 없을 때만 '끝에서 tail 바이트'(첫 로드용)
 *  · 잡값(음수·소수·문자)은 없는 것으로.
 */
export function transcriptRange(size: number, q: { from?: unknown; to?: unknown; tail?: unknown }): { start: number; end: number } {
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
  };
  const from = num(q.from), to = num(q.to), tail = num(q.tail);
  let start = from !== null ? from : tail !== null ? Math.max(0, size - tail) : 0;
  start = Math.min(start, size);
  let end = to !== null ? Math.min(to, size) : size;
  if (end < start) end = start;
  if (end - start > TRANSCRIPT_MAX_CHUNK) end = start + TRANSCRIPT_MAX_CHUNK;
  return { start, end };
}

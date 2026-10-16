// 아웃박스 배달 결말의 측정 한 줄 (#4697 T7) — 하네스 종료 규칙(#4695) 뒤 7일 측정의 재료(순수 — 시험이 표로 못박는다).
//
//  새 규칙에선 끝난 세션의 하네스가 꺼져 있다. 사람이 대화창에서 말을 걸면 화면이 먼저 복원(POST …/restore — 같은 id 로 하네스를 다시
//   띄운다)하고 그 뒤에 말을 아웃박스에 넣는다(web/session-chat.ts reviveWithPrompt). 아웃박스는 입력창이 뜰 때까지 기다렸다 친다.
//   그래서 «프롬프트 → 하네스가 받기까지» = 복원 측정 줄(restore-measure.ts — 시작 시각·걸린 시간)과 이 줄(그 세션의 첫 결말)을 이은 것이다.
//   종전엔 이 시간이 행(created_at·delivered_at)에만 있고 행은 하루 뒤 지워져 7일을 잴 수 없었다 — 결말마다 한 줄을 남긴다.
//  ⓘ 대화창 밖(API·다른 화면)에서 꺼진 세션에 보낸 말은 «세션 없음 · 복원 가능» 으로 묶여 있다가 복원이 깨운다 — 그 행은 heldMs 가 실린다.
//  ⚠ 사람이 쓴 글은 싣지 않는다. 답 문장인지(질의 중 끈 세션에 대화창이 보내는 «앞서 물은 ‹…›에 대한 답») 여부만 센다.
//   사유(error)도 **알려진 사유 코드로만** 싣는다 — 치다가 실패한 send-keys 의 오류 문장은 argv 를 통째로 품어(`Command failed: tmux send-keys
//   -t <id> -l -- <본문>`) 사람의 글이 섞여 나온다(격리 리뷰 재현). codex 경로의 오류 문장도 같은 이유로 접는다.
//  ⚠ 이 모듈은 노드 에이전트 번들에도 실린다(session-outbox.ts 가 부른다) — 아무것도 import 하지 않는다.

/**
 * 대화창이 질의 중 꺼진 세션에 보내는 답 문장의 머리(web/lib/stop-note.ts stopAnswerPrompt·stopFreeAnswerPrompt 가 만든다).
 *  두 판이 갈리면 측정이 조용히 0 이 된다 — scripts/stop-answer-measure.test.mjs 가 화면이 만든 문장을 이 판정에 넣어 못박는다.
 */
export const STOP_ANSWER_PREFIXES: readonly string[] = ["앞서 물은 ", "앞서 실행 허락을 물은 "];

/** 답 문장 판정에 받는 글 머리 길이 — DB 에서 이만큼만 꺼낸다(session-outbox.ts mark 의 left(text, N)). 가장 긴 머리(13자)를 넉넉히 덮는다. */
export const ANSWER_HEAD_CHARS = 24;

/** (순수) 이 글이 «질의 중 꺼진 세션에 보내는 답» 인가 — 머리만 본다. */
export function isStopAnswerText(head: string | null | undefined): boolean {
  const h = typeof head === "string" ? head : "";
  return STOP_ANSWER_PREFIXES.some((p) => h.startsWith(p));
}

/** 결말을 새긴 UPDATE 가 돌려준 값(session-outbox.ts mark). 시각은 DB 의 now() 로 잰다(게이트웨이와 DB 시계가 달라도 맞게). */
export interface OutboxSettledRow {
  session_id: string;
  seq: number;
  kind: string;
  attempts: number;
  /** 큐에 들어온 뒤 결말까지(ms) */
  wait_ms: number | string | null;
  /** 못 닿기 시작한 뒤 결말까지(ms) — 세션이 없거나(복원 가능) 못 닿아 들고 있던 행만. 한 번도 안 막혔으면 null.
   *  ⓘ 막힌 사유(last_error)는 실을 수 없다 — 배달을 시작할 때(sending) 지워진다. 그 두 사유가 «처음 막힌 시각» 을 남기는 유일한 둘이다(stalledSinceNext). */
  held_ms: number | string | null;
  /** 글 머리 — 답 문장 판정에만 쓰고 싣지 않는다 */
  head: string | null;
}

/** 측정 줄에 그대로 싣는 사유 코드 — 배달 루프가 스스로 짓는 고정 문자열뿐이다(stallAction · sendReadyRow · outbox-exec 의 fail:text/enter). */
export const OUTBOX_ERROR_CODES: ReadonlySet<string> = new Set([
  "not-ready", "session-gone", "session-gone-restorable", "unreachable",
  "echo-unconfirmed", "echo-unreadable", "control-no-echo",
  "send: host-unknown", "send: text", "send: enter",
]);

/** (순수) 사유 → 측정에 실을 코드. 알려진 코드는 그대로, `send:`·`codex:` 로 시작하는 그 밖의 문장은 «… other», 나머지는 «other». */
export function outboxErrorCode(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const s = String(error);
  if (OUTBOX_ERROR_CODES.has(s)) return s;
  const m = /^(send|codex):/.exec(s);
  return m ? `${m[1]}: other` : "other";
}

export interface OutboxSettledMeasure {
  tenant?: string | null;
  sessionId: string;
  seq: number;
  kind: string;
  status: string;
  error?: string;
  attempts: number;
  waitMs: number | null;
  /** 세션이 없거나 못 닿아 들고 있던 행이면, 처음 막힌 뒤 결말까지(ms) */
  heldMs?: number;
  /** 질의 중 꺼진 세션에 보낸 답 문장 */
  answer?: true;
}

const num = (v: number | string | null | undefined): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};

/** (순수) 결말 한 행 → 측정 한 줄. tenant 는 부르는 쪽이 요청 컨텍스트에서 잡아 넘긴다(이 모듈은 아무것도 import 하지 않는다). */
export function outboxSettledMeasure(row: OutboxSettledRow, status: string, error?: string | null, tenant?: string | null): OutboxSettledMeasure {
  const m: OutboxSettledMeasure = {
    ...(tenant !== undefined ? { tenant } : {}),
    sessionId: row.session_id, seq: Number(row.seq), kind: row.kind, status, attempts: Number(row.attempts) || 0, waitMs: num(row.wait_ms),
  };
  const code = outboxErrorCode(error);
  if (code) m.error = code;
  const heldMs = num(row.held_ms);
  if (heldMs !== null) m.heldMs = heldMs;
  if (isStopAnswerText(row.head)) m.answer = true;
  return m;
}

// #4697 T7 — 아웃박스 배달 결말 측정 한 줄(outbox-measure.ts)의 계약(순수). 사양·엣지 표: 작업 스크래치 spec.md E1~E8.
//  E9(화면이 만든 답 문장 ↔ 이 판정)는 scripts/stop-answer-measure.test.mjs, E10(실 Postgres 결말 SQL)은 session-outbox-mark.pg-test.mjs.
//  틀리면 티가 크다:
//   🔴 답 문장을 못 알아보면 — «질의 중 끈 세션에 보낸 답의 전달 성공률» 이 조용히 0 건이 된다.
//   🔴 사람이 쓴 글을 실으면 — 측정 로그에 사람의 말이 남는다.
//   🔴 DB 가 bigint 를 문자열로 주는 것(pg 기본)을 숫자로 못 바꾸면 — 기다린 시간이 전부 null 이 된다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { isStopAnswerText, outboxSettledMeasure, outboxErrorCode, OUTBOX_ERROR_CODES, STOP_ANSWER_PREFIXES, ANSWER_HEAD_CHARS, type OutboxSettledRow } from "./outbox-measure.js";

const row = (o: Partial<OutboxSettledRow> = {}): OutboxSettledRow => ({
  session_id: "box-a-1", seq: 3, kind: "prompt", attempts: 1, wait_ms: "5321", held_ms: null, head: "다음 일을 해 줘", ...o,
});
const head = (t: string): string => t.slice(0, ANSWER_HEAD_CHARS);

test("E1 답 문장 — 대화창의 세 꼴(선택 질문 · 실행 허락 · 여러 질문에 직접 쓴 답)", () => {
  assert.equal(isStopAnswerText(head("앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹파랑›")), true);
  assert.equal(isStopAnswerText(head("앞서 실행 허락을 물은 ‹rm -rf build›에 대한 답: ‹Yes›")), true);
  assert.equal(isStopAnswerText(head("앞서 물은 질문(‹색› · ‹과일›)에 대한 답: ‹둘 다›")), true);
});
test("E2 비슷한 글은 답 문장이 아니다", () => {
  for (const t of ["앞서 말한 것처럼 해 줘", "앞서물은 ‹x›에 대한 답", " 앞서 물은 ‹x›에 대한 답", "앞서 실행 허락을 ‹x›", "", null, undefined]) {
    assert.equal(isStopAnswerText(t), false, String(t));
  }
});
test("E3 받는 머리 길이는 가장 긴 머리보다 길다", () => {
  for (const p of STOP_ANSWER_PREFIXES) assert.ok(p.length < ANSWER_HEAD_CHARS, p);
});
test("E4 기다린 시간 — pg 가 bigint 를 문자열로 줘도 수로", () => {
  assert.equal(outboxSettledMeasure(row({ wait_ms: "5321" }), "delivered").waitMs, 5321);
  assert.equal(outboxSettledMeasure(row({ wait_ms: 77 }), "delivered").waitMs, 77);
});
test("E5 들고 있던 시간 — 없으면 칸이 없고 있으면 싣는다", () => {
  assert.equal("heldMs" in outboxSettledMeasure(row({ held_ms: null }), "delivered"), false);
  assert.equal(outboxSettledMeasure(row({ held_ms: "4100" }), "delivered").heldMs, 4100);
});
test("E6 사유는 알려진 코드만 그대로 — 배달 루프가 짓는 고정 문자열", () => {
  for (const c of OUTBOX_ERROR_CODES) assert.equal(outboxSettledMeasure(row(), "failed", c).error, c, c);
  assert.equal(outboxSettledMeasure(row(), "delivered").error, undefined);
  assert.equal(outboxErrorCode(""), undefined);
});
test("E6b ★치다가 실패한 send-keys 의 오류 문장(argv 에 본문이 든다)은 «send: other» 로 접는다 — 사람의 글이 측정 줄에 안 남는다", () => {
  const leak = "send: Command failed: /opt/homebrew/bin/tmux send-keys -t box-x-1234 -l -- 내 비밀 프롬프트 글";
  const m = outboxSettledMeasure(row(), "failed", leak);
  assert.equal(m.error, "send: other");
  assert.ok(!JSON.stringify(m).includes("비밀"), "본문 조각이 남았다");
  assert.equal(outboxSettledMeasure(row(), "failed", "codex: turn/start 실패 — 사람의 글 조각").error, "codex: other");
  assert.equal(outboxSettledMeasure(row(), "failed", "x".repeat(400)).error, "other");
});
test("E11 워크스페이스 — 부르는 쪽이 넘기면 싣고, 안 넘기면 칸이 없다", () => {
  assert.equal(outboxSettledMeasure(row(), "delivered", null, "lively-46e3").tenant, "lively-46e3");
  assert.equal(outboxSettledMeasure(row(), "delivered", null, null).tenant, null);
  assert.equal("tenant" in outboxSettledMeasure(row(), "delivered"), false);
});
test("E7 음수는 0 · 숫자가 아니면 null", () => {
  assert.equal(outboxSettledMeasure(row({ wait_ms: -5 }), "delivered").waitMs, 0);
  assert.equal(outboxSettledMeasure(row({ wait_ms: "abc" }), "delivered").waitMs, null);
  assert.equal(outboxSettledMeasure(row({ wait_ms: null }), "delivered").waitMs, null);
});
test("E8 한 줄 전체 — 답 문장이면 answer · 글(머리)은 싣지 않는다", () => {
  const m = outboxSettledMeasure(row({ held_ms: "4100", head: "앞서 물은 ‹색›에 대한 답: ‹파랑›" }), "delivered");
  assert.deepEqual(m, { sessionId: "box-a-1", seq: 3, kind: "prompt", status: "delivered", attempts: 1, waitMs: 5321, heldMs: 4100, answer: true });
  const plain = outboxSettledMeasure(row(), "sent", "echo-unreadable");
  assert.deepEqual(plain, { sessionId: "box-a-1", seq: 3, kind: "prompt", status: "sent", error: "echo-unreadable", attempts: 1, waitMs: 5321 });
  assert.ok(!JSON.stringify(plain).includes("다음 일을") && !JSON.stringify(m).includes("파랑"), "글 머리는 싣지 않는다");
});

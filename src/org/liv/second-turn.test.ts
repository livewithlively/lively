// 리브 2턴 — 판정·프롬프트 엣지 표(scratchpad/spec-second-turn.md) 행마다 한 검사.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideSecondTurn, buildSecondTurnPrompt, SECOND_TURN_MAX_WAIT_MS, TURN1_DELIVERY_TTL_MS,
  type SecondTurnState, type SecondTurnInput,
} from "./second-turn.js";

const DONE = Date.parse("2026-08-29T05:00:00Z");
const st = (over: Partial<SecondTurnState> = {}): SecondTurnState => ({
  welcome: { done_at: new Date(DONE).toISOString(), session_id: "box-a-1" },
  session: { working: false, agentState: "idle" },
  outboxPending: 0,
  collectors: [],
  now: DONE + 60_000,
  ...over,
});

test("① 킥오프 없음 — welcome null · session_id 없음 · done_at 없음 전부 skip", () => {
  assert.deepEqual(decideSecondTurn(st({ welcome: null })), { action: "skip", reason: "no-kickoff" });
  assert.deepEqual(decideSecondTurn(st({ welcome: { done_at: "2026-08-29T05:00:00Z" } })), { action: "skip", reason: "no-kickoff" });
  assert.deepEqual(decideSecondTurn(st({ welcome: { session_id: "x" } })), { action: "skip", reason: "no-kickoff" });
});
test("② 이미 쐈으면 skip", () => {
  assert.deepEqual(decideSecondTurn(st({ welcome: { ...st().welcome!, distill_at: "2026-08-29T05:10:00Z" } })), { action: "skip", reason: "already-fired" });
});
test("③ 포기했으면 skip", () => {
  assert.deepEqual(decideSecondTurn(st({ welcome: { ...st().welcome!, distill_gave_up_at: "2026-08-29T07:00:00Z" } })), { action: "skip", reason: "gave-up" });
});
test("④ 세션이 박스에 없으면 giveup", () => {
  assert.deepEqual(decideSecondTurn(st({ session: null })), { action: "giveup", reason: "session-gone" });
});
test("⑤ 1턴 미배달(아웃박스 대기) — 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ outboxPending: 1 })), { action: "wait", reason: "turn1-undelivered" });
});
test("⑥ 1턴 미배달이 2시간을 넘기면 giveup", () => {
  assert.deepEqual(decideSecondTurn(st({ outboxPending: 1, now: DONE + TURN1_DELIVERY_TTL_MS + 1 })), { action: "giveup", reason: "turn1-never-delivered" });
});
test("⑥′ 경계 — 정확히 2시간은 아직 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ outboxPending: 1, now: DONE + TURN1_DELIVERY_TTL_MS })), { action: "wait", reason: "turn1-undelivered" });
});
test("⑦ working 이면 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ session: { working: true, agentState: "idle" } })), { action: "wait", reason: "turn1-running" });
});
test("⑧ agentState busy 면 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ session: { working: false, agentState: "busy" } })), { action: "wait", reason: "turn1-running" });
});
test("⑨ 켜진 수집기가 아직 한 번도 안 돌았으면 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ collectors: [{ enabled: true, lastRunAt: null }], now: DONE + 5 * 60_000 })), { action: "wait", reason: "collecting" });
});
test("⑩ 켜진 수집기의 마지막 실행이 온보딩 전이면(옛 실행) 기다린다", () => {
  assert.deepEqual(decideSecondTurn(st({ collectors: [{ enabled: true, lastRunAt: new Date(DONE - 1).toISOString() }], now: DONE + 5 * 60_000 })), { action: "wait", reason: "collecting" });
});
test("⑪ 경계 — 정확히 상한(20분)이면 partial 로 쏜다", () => {
  assert.deepEqual(decideSecondTurn(st({ collectors: [{ enabled: true, lastRunAt: null }], now: DONE + SECOND_TURN_MAX_WAIT_MS })), { action: "fire", partial: true, waitedMin: 20 });
});
test("⑫ 수집기가 없으면 바로 쏜다", () => {
  assert.deepEqual(decideSecondTurn(st()), { action: "fire", partial: false, waitedMin: 1 });
});
test("⑬ 경계 — 마지막 실행이 done_at 과 같으면 돈 것으로 친다", () => {
  assert.deepEqual(decideSecondTurn(st({ collectors: [{ enabled: true, lastRunAt: new Date(DONE).toISOString() }] })), { action: "fire", partial: false, waitedMin: 1 });
});
test("⑭ 꺼진 수집기는 판정에서 뺀다", () => {
  assert.deepEqual(decideSecondTurn(st({ collectors: [{ enabled: false, lastRunAt: null }] })), { action: "fire", partial: false, waitedMin: 1 });
});

const pin = (over: Partial<SecondTurnInput> = {}): SecondTurnInput => ({
  displayName: "수아", drawers: ["산출물", "기록"], firstOrder: "지난 시안 리뷰 피드백만 모아 줘",
  collectors: [{ label: "슬랙 #design", preset_key: "slack", enabled: true, ran: true }, { label: "노션", preset_key: "notion", enabled: true, ran: false }],
  partial: true, waitedMin: 20, ...over,
});
test("⑮ 프롬프트 — partial 이면 '최대 1분' 문구, 아니면 없음 · 항상 다시 읽어라·멱등·물음 도구·턴 종료", () => {
  const p = buildSecondTurnPrompt(pin());
  assert.match(p, /\*\*최대 1분\*\* 기다렸다가/);
  assert.match(p, /지금 상태를 다시 읽어라/);
  assert.match(p, /\*\*멱등\*\*/);
  assert.match(p, /me_liv_ask_choice/);
  assert.match(p, /그리고 턴을 끝낸다/);
  assert.match(p, /처음 설정이 끝난 지 20분 지났다/);
  const q = buildSecondTurnPrompt(pin({ partial: false, collectors: [] }));
  assert.doesNotMatch(q, /최대 1분/);
});
test("⑯ 프롬프트 — 이름 없으면 '이 사람', 수집기 없음 문구, 마친 것/안 끝난 것 분리", () => {
  const p = buildSecondTurnPrompt(pin({ displayName: null, collectors: [] }));
  assert.match(p, /이 사람의 일하는 방식/);
  assert.match(p, /- 수집기: 없음\(올린 자료만 있다\)/);
  const q = buildSecondTurnPrompt(pin());
  assert.match(q, /첫 수집을 마친 것 슬랙 #design \/ 아직 안 끝난 것 노션/);
});

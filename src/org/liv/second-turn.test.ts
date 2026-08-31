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
//  ★ 정책이 바뀌었다(#1631, 2026-08-31): 세션이 박스에 없으면 종전엔 그 자리에서 **영구 포기**였다.
//   그런데 실측에서 1턴을 성공으로 끝낸 리브 세션이 수집 대기 20분 사이에 사라졌고(게이트웨이에 종료 사유 기록 없음),
//   그 포기 때문에 그 사람의 증류기 15개가 영원히 꺼진 채 남았다 — 온보딩을 완주하고 지식을 하나도 못 얻었다.
//   사슬의 목적은 **일**이지 그 세션이 아니므로 이제 한 번은 다시 연다. «없으면 포기» 는 그 뒤에도 없을 때만 참이다.
test("④ 세션이 박스에 없으면 — 한 번은 다시 열고, 그 뒤에도 없으면 그때 포기한다", () => {
  assert.deepEqual(decideSecondTurn(st({ session: null })), { action: "reopen", reason: "session-gone" });
  assert.deepEqual(
    decideSecondTurn(st({
      session: null,
      welcome: { done_at: new Date(DONE).toISOString(), session_id: "box-a-1", distill_reopened_at: new Date(DONE).toISOString() },
    })),
    { action: "giveup", reason: "session-gone-again" },
  );
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
  assert.match(p, /`liv-distill` 스킬을 열어/);   // 두뇌는 스킬에 있다 — 지시문이 먼저 열게 한다(1라운드 채점 뒤 도입)
  const q = buildSecondTurnPrompt(pin({ partial: false, collectors: [] }));
  assert.doesNotMatch(q, /최대 1분/);
});
test("⑯ 프롬프트 — 이름 없으면 '이 사람', 수집기 없음 문구, 마친 것/안 끝난 것 분리", () => {
  const p = buildSecondTurnPrompt(pin({ displayName: null, collectors: [] }));
  assert.match(p, /이 사람의 일하는 방식/);
  assert.match(p, /- 수집기: 없음\(외부 앱을 잇지 않음\)/);
  assert.doesNotMatch(p, /올린 자료만 있다/);   // 자료 0건일 때 전제가 틀리는 단정(태오 채점 실측)을 다시 넣지 않는다
  const q = buildSecondTurnPrompt(pin());
  assert.match(q, /첫 수집을 마친 것 슬랙 #design \/ 아직 안 끝난 것 노션/);
});

// ── 세션이 안 떠 있으면 1턴은 안 끝난 것이다(#1631, 2026-08-30 실측) ──
//  실측: 세션 미기동 상태에서 온보딩 31초 만에 fire → distill_at 소진 → 영영 증류 지시 없음(자료 8건·레인 0).
test("세션이 offline 이면 fire 하지 않고 기다린다 — 1턴이 안 끝났다", () => {
  const d = decideSecondTurn(st({ session: { working: false, agentState: "offline" }, collectors: [] }));
  assert.equal(d.action, "wait");
  assert.equal(d.reason, "session-offline");
});

test("offline 이 TTL(2시간)을 넘기면 포기하고 사유를 남긴다", () => {
  const d = decideSecondTurn(st({
    session: { working: false, agentState: "offline" }, collectors: [],
    now: DONE + TURN1_DELIVERY_TTL_MS + 1_000,
  }));
  assert.equal(d.action, "giveup");
  assert.equal(d.reason, "turn1-session-offline");
});

test("세션이 살아 있으면(offline 아님) 종전대로 fire 한다 — 무회귀", () => {
  assert.equal(decideSecondTurn(st({ session: { working: false, agentState: "idle" }, collectors: [] })).action, "fire");
});

// ── 세션이 사라졌으면 **다시 연다**(#1631, 2026-08-31 실측) ─────────────────────────────
//  실측: 1턴을 성공으로 끝낸 리브 세션이 수집 대기 20분 사이에 사라졌고(게이트웨이 기록에 종료 사유 없음),
//   종전 코드는 그 자리에서 영구 포기해 그 사람의 증류기 15개가 영원히 꺼진 채 남았다 — 온보딩 완주, 지식 0건.
const GONE = { session: null } as Partial<SecondTurnState>;

test("⑮ 세션이 사라졌고 아직 다시 연 적 없으면 — 포기가 아니라 **reopen**", () => {
  const d = decideSecondTurn(st({ ...GONE, now: DONE + 20 * 60_000 }));
  assert.deepEqual(d, { action: "reopen", reason: "session-gone" });
});

test("⑯ 이미 한 번 다시 열었는데 또 사라졌으면 그때는 포기한다 — 무한 재생성 금지", () => {
  const d = decideSecondTurn(st({
    ...GONE,
    welcome: { done_at: new Date(DONE).toISOString(), session_id: "box-a-2", distill_reopened_at: new Date(DONE + 60_000).toISOString() },
  }));
  assert.deepEqual(d, { action: "giveup", reason: "session-gone-again" });
});

test("⑰ 1턴 배달 상한(2시간)을 넘겼으면 다시 열지 않는다 — 한참 뒤에 창이 불쑥 뜨는 게 더 나쁘다", () => {
  const d = decideSecondTurn(st({ ...GONE, now: DONE + TURN1_DELIVERY_TTL_MS + 1_000 }));
  assert.deepEqual(d, { action: "giveup", reason: "session-gone" });
});

test("⑱ 세션이 살아 있으면 다시연 표식이 있어도 종전 경로 그대로 — 무회귀", () => {
  const d = decideSecondTurn(st({
    welcome: { done_at: new Date(DONE).toISOString(), session_id: "box-a-1", distill_reopened_at: new Date(DONE).toISOString() },
    session: { working: false, agentState: "idle" }, collectors: [],
  }));
  assert.equal(d.action, "fire");
});

test("⑲ 이미 쐈다·이미 포기했다·킥오프 없음이 reopen 보다 앞선다", () => {
  const base = { done_at: new Date(DONE).toISOString(), session_id: "box-a-1" };
  assert.deepEqual(decideSecondTurn(st({ ...GONE, welcome: { ...base, distill_at: "2026-08-30T00:00:00Z" } })),
    { action: "skip", reason: "already-fired" });
  assert.deepEqual(decideSecondTurn(st({ ...GONE, welcome: { ...base, distill_gave_up_at: "2026-08-30T00:00:00Z" } })),
    { action: "skip", reason: "gave-up" });
  assert.deepEqual(decideSecondTurn(st({ ...GONE, welcome: null })), { action: "skip", reason: "no-kickoff" });
});

test("⑳ 세션이 없으면 경과 0분이어도 reopen — 기다린다고 없던 세션이 생기지 않는다", () => {
  assert.deepEqual(decideSecondTurn(st({ ...GONE, now: DONE })), { action: "reopen", reason: "session-gone" });
});

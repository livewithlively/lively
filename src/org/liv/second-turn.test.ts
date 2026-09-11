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
  displayName: "수아", work: "회사·조직에서 팀과 함께 일한다 · 디자인", drawers: ["산출물", "기록"], firstOrder: "지난 시안 리뷰 피드백만 모아 줘",
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

// ── 카테고리 단계(#1631, 2026-09-11) — 처음 설정 뒤 카테고리는 **반드시** 만든다 ─────────────────────
//  결정(원준): «어쨌든 우리는 반드시 분류 생성해야하는게 맞으므로 해결해야할 부분인것임.»
//  실측: 처음 설정은 서랍 없이(drawers:[]) 끝나고, 서버 뼈대도 서랍이 0개면 레인을 안 만든다. 레인의 목적지는
//   이미 있는 카테고리만 저장된다(#1631 PR 5a309198) — 카테고리가 없으면 레인도 지식의 자리도 없다.
//   2026-08-31 실측에서 리브가 카테고리 3개를 만든 것은 지시가 아니었다(«켜는 레인은 목적지가 있어야 한다» 를
//   지키려던 부산물로 보이고 관찰 1회) → 매번 그런다는 보장이 없어 지시문에 단계를 직접 둔다.
test("㉑ 카테고리 단계가 증류기 단계보다 앞에 있고, 건너뛰지 않는다고 못박는다", () => {
  const p = buildSecondTurnPrompt(pin({ drawers: [] }));
  const make = p.indexOf("category_create");
  assert.ok(make >= 0, "지시문에 category_create 가 없다");
  assert.ok(make < p.indexOf("org_distiller_upsert"), "카테고리 단계가 증류기 단계보다 뒤에 있다");
  assert.match(p, /이 단계는 건너뛰지 않는다/);
});
test("㉒ 스킬이 이 단계가 생기기 전 판이어도 카테고리는 만든다", () => {
  assert.match(buildSecondTurnPrompt(pin()), /스킬에 이 단계가 없어도 반드시 한다/);
});
test("㉓ 묻지 않고 만든다 — 물음 도구보다 먼저 나오고, 자료 0건이어도 0개로 끝내지 않는다", () => {
  const p = buildSecondTurnPrompt(pin({ drawers: [], collectors: [], partial: false }));
  assert.match(p, /묻지 않고 만든다/);
  assert.ok(p.indexOf("묻지 않고 만든다") < p.indexOf("me_liv_ask_choice"), "묻는 규율이 카테고리 단계보다 앞에 있다");
  assert.match(p, /0개로 끝내지 않는다/);
});
test("㉔ 멱등 — 이미 있는 카테고리가 받을 수 있으면 새로 만들지 않는다", () => {
  assert.match(buildSecondTurnPrompt(pin()), /이미 있는 카테고리가 받을 수 있으면 그것을 쓴다/);
});
test("㉕ key 규약 — 증류기 key 는 liv-<카테고리 key>", () => {
  assert.match(buildSecondTurnPrompt(pin()), /`liv-<카테고리 key>`/);
});
test("㉖ 일하는 형태·직무가 실린다 — 자료가 0건일 때 카테고리를 만들 재료는 이것뿐이다", () => {
  assert.match(buildSecondTurnPrompt(pin()), /일하는 형태·직무 "회사·조직에서 팀과 함께 일한다 · 디자인"/);
  assert.match(buildSecondTurnPrompt(pin({ work: null })), /일하는 형태·직무 없음/);
});
test("㉖′ 경계 — 빈 문자열도 «없음» 이다(빈 따옴표를 싣지 않는다)", () => {
  const p = buildSecondTurnPrompt(pin({ work: "" }));
  assert.match(p, /일하는 형태·직무 없음/);
  assert.doesNotMatch(p, /일하는 형태·직무 ""/);
});
test("㉙ 서랍이 이미 있는 사람에게도 카테고리 단계는 똑같이 나온다 — 조건부 단계가 아니다", () => {
  const p = buildSecondTurnPrompt(pin({ drawers: ["산출물", "기록"] }));
  assert.match(p, /서랍 산출물 · 기록/);
  assert.match(p, /카테고리를 만든다 — 이 단계는 건너뛰지 않는다/);
});
test("㉚ 시드 liv-distill 의 절차 번호가 1~12 로 이어지고, «N단계» 참조가 실제 단계를 가리킨다", async () => {
  const { DEFAULT_SKILLS } = await import("../delivery/default-content.js");
  const b = DEFAULT_SKILLS.find((s) => s.id === "liv-distill")!.body;
  const heads = [...b.matchAll(/^### (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), title: m[2] }));
  assert.deepEqual(heads.map((h) => h.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const ask = heads.find((h) => h.title.startsWith("물어도 되는 것"));
  assert.ok(ask, "물어도 되는 것 단계가 없다");
  const refs = [...b.matchAll(/(\d+)단계/g)].map((m) => Number(m[1]));
  assert.ok(refs.length > 0, "«N단계» 참조를 하나도 못 찾았다 — 검사가 아무것도 안 본다");
  for (const n of refs) assert.ok(n >= 1 && n <= 12, `없는 단계를 가리킨다: ${n}단계`);
  const zeroLine = b.split("\n").find((l) => l.includes("자료 0건이면 표본 읽기는 여기서 끝낸다"));
  assert.ok(zeroLine, "자료 0건 줄이 없다");
  assert.match(zeroLine!, new RegExp(`${ask!.n}단계\\(물음\\)`));
  const gapLine = b.split("\n").find((l) => l.includes("범위 빈틈"));
  assert.ok(gapLine, "범위 빈틈 줄이 없다");
  assert.match(gapLine!, new RegExp(`${ask!.n}단계 물음`));
});
test("㉗ 요약에 카테고리를 적고, 못 만들었으면 숨기지 않는다", () => {
  const p = buildSecondTurnPrompt(pin());
  assert.match(p, /만든 것\(카테고리·수집기·증류기·지식/);
  assert.match(p, /카테고리를 만들지 못했다/);
});
test("㉘ 시드 liv-distill 도 같은 단계를 갖는다 — 지시문과 스킬이 서로 다른 말을 하지 않는다", async () => {
  const { DEFAULT_SKILLS } = await import("../delivery/default-content.js");
  const skill = DEFAULT_SKILLS.find((s) => s.id === "liv-distill");
  assert.ok(skill, "DEFAULT_SKILLS 에 liv-distill 이 없다");
  const b = skill.body;
  const step = b.indexOf("### 2. 카테고리를 만든다");
  assert.ok(step >= 0, "liv-distill 에 카테고리 단계가 없다");
  assert.ok(b.indexOf("category_create") > step, "카테고리 단계에 category_create 가 없다");
  assert.ok(step < b.indexOf("### 3. 판정 단위로 가른다"), "카테고리 단계가 레인 단계보다 뒤에 있다");
  assert.match(b, /0개로 끝내지 않는다/);
  assert.doesNotMatch(b, /자료 0건이면 여기서 멈춘다/);   // 자료 0건이어도 카테고리는 만든다 — 옛 문장이 되살아나면 안 된다
});

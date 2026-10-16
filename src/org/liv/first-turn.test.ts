// 리브 1턴 프롬프트 — «처음 연결» 대화(#4213 T13, 상민님 2026-10-15 To-Be §7). 엣지 표 행마다 한 검사 — 각 검사는 서로 다른 관측을 잡는다(변이 적발).
//
//  표(입력 → 기대):
//   T1 설치자 · 정책 허용 · 커넥터 확인됨      → 설치자 절차(liv-connect) · 커넥터 이름과 상태 · 다시 재라는 말 · 처음 수집 끝 표식
//   T2 합류자                                 → 합류자 절차 · 팀이 쓰는 앱 · 범위·서랍·초대를 건드리지 말라
//   T3 정책 막힘 / 모름                         → Claude 커넥터 길이 없다고 · 커넥터 목록을 싣지 않는다
//   T4 커넥터를 잰 적 없음 / 확인 실패 / 빈 목록  → 맨 먼저 다시 재라(사유 코드 그대로)
//   T5 꺼진 수집기 빈 칸                        → 연결이 아니다(세지 않는다)
//   T6 이름 건너뜀                              → 이름을 지어 부르지 말라 · 이름이 안 실린다
//   T7 단위                                    → 앱별 개수만(0건 앱은 빼고, 없으면 «아직 없음»)
//   T8 하지 말 것                               → 커넥터 도구로 직접 읽지 말라 · confirm 은 사람 답 뒤 · 서랍은 만들지 말라(설치자)
//   T9 올린 자료 제목 상한                       → 있을 때만 · 상한까지 + «외 n건»
import test from "node:test";
import assert from "node:assert/strict";
import { buildFirstTurnPrompt, FIRST_TURN_DEFAULT_DAYS, FIRST_TURN_NAME_CAP, type FirstTurnInput } from "./first-turn.js";
import { FIRST_READ_DAYS } from "../collect/collect-plan.js";

const base = (over: Partial<FirstTurnInput> = {}): FirstTurnInput => ({
  flow: "owner",
  displayName: "수아",
  othersCount: 0,
  isAdmin: true,
  policy: "allowed",
  connectors: { scan: { ok: true, error: null }, apps: [{ app: "Slack", status: "connected" }, { app: "Gmail", status: "needs-auth" }] },
  collectApps: ["Slack", "Gmail", "Notion"],
  units: [],
  collectors: [],
  teamApps: [],
  uploads: { total: 0, kinds: [], names: [] },
  aiHarnesses: ["claude"],
  harness: "claude",
  surface: "chat",
  ...over,
});

test("T1 설치자 — liv-connect «설치자» 절차 · 커넥터 이름과 상태 · 다시 재기 · 처음 수집 끝 표식", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /`liv-connect` 스킬의 «설치자» 절차/);
  assert.match(p, /Slack\(연결됨\) · Gmail\(다시 로그인 필요\)/);
  assert.match(p, /다시 잰다/);
  assert.match(p, /mode:"listing"/);
  assert.match(p, /mode:"collect"/);
  assert.match(p, /collect_done:true/);
  assert.match(p, /지금 수집 실행으로 모을 수 있는 앱: Slack · Gmail · Notion/);
  assert.match(p, /아직 혼자다\. 관리자다\./);
  assert.doesNotMatch(p, /«합류자» 절차/);
});

test("T1′ 처음 기간의 기본값은 수집 실행의 기본값과 같다(어긋나면 리브가 틀린 기간을 말한다)", () => {
  assert.equal(FIRST_TURN_DEFAULT_DAYS, FIRST_READ_DAYS);
  assert.match(buildFirstTurnPrompt(base()), new RegExp(`기본 최근 ${FIRST_READ_DAYS}일`));
});

test("T1″ 관리자가 아니면 초대·라이블리 수집기를 꺼내지 말라고 실린다", () => {
  const p = buildFirstTurnPrompt(base({ isAdmin: false, othersCount: 2 }));
  assert.match(p, /먼저 있는 다른 구성원 2명\. 관리자가 아니다 — 초대·라이블리 수집기는 꺼내지 마라\./);
});

test("T2 합류자 — 합류자 절차 · 팀이 쓰는 앱(앱 이름·수만) · 팀 범위·서랍·초대를 건드리지 말라 · 처음 수집·표식 없음", () => {
  const p = buildFirstTurnPrompt(base({ flow: "join", othersCount: 3, isAdmin: false,
    teamApps: [{ app: "Slack", members: 2, units: 4 }, { app: "Notion", members: 1, units: 0 }] }));
  assert.match(p, /`liv-connect` 스킬의 «합류자» 절차/);
  assert.match(p, /초대로 들어온 사람\*\*이다\. 먼저 있는 구성원 3명/);
  assert.match(p, /팀이 쓰는 앱: Slack\(Claude 로 연결한 구성원 2명 · 모으는 중 4곳\) · Notion\(Claude 로 연결한 구성원 1명\)/);
  assert.match(p, /팀의 수집 범위·공개범위·서랍·정리 규칙을 바꾸지 마라/);
  assert.match(p, /초대도 권하지 마라/);
  assert.match(p, /\*\*없는 것만\*\*/);
  assert.doesNotMatch(p, /mode:"collect"/);
  assert.doesNotMatch(p, /collect_done/);
  assert.doesNotMatch(p, /«설치자» 절차/);
});

test("T2′ 합류자 — 팀이 쓰는 앱이 없으면 그대로 말하고 끝낸다고 못박는다", () => {
  const p = buildFirstTurnPrompt(base({ flow: "join", teamApps: [] }));
  assert.match(p, /팀이 쓰는 앱: 아직 없음 .*연결할 것이 없다고 그대로 말하고 끝낸다/);
});

test("T3 정책 막힘 — Claude 커넥터 길이 없다 · 커넥터 이름을 싣지 않는다 · 정책 모름도 따로 말한다", () => {
  const p = buildFirstTurnPrompt(base({ policy: "blocked" }));
  assert.match(p, /구성원 Claude 커넥터: \*\*이 워크스페이스는 쓰지 않는다\*\*/);
  assert.match(p, /«Claude 로 안 되는 앱» 길/);
  assert.doesNotMatch(p, /Slack\(연결됨\)/);
  const q = buildFirstTurnPrompt(base({ policy: "unknown" }));
  assert.match(q, /정책을 읽지 못했다 — 수집 실행이 거절되면\(403·503\)/);
  assert.doesNotMatch(q, /Slack\(연결됨\)/);
});

test("T4 잰 적 없음 · 확인 실패 · 빈 목록 — 각각 사실대로, 그리고 맨 먼저 다시 잰다", () => {
  const never = buildFirstTurnPrompt(base({ connectors: { scan: null, apps: [] } }));
  assert.match(never, /아직 확인한 적 없다 — 맨 먼저 `member_ai_connectors_refresh` 로 잰다/);
  const failed = buildFirstTurnPrompt(base({ connectors: { scan: { ok: false, error: "not-logged-in" }, apps: [] } }));
  assert.match(failed, /마지막 확인이 실패했다\(not-logged-in\)/);
  const empty = buildFirstTurnPrompt(base({ connectors: { scan: { ok: true, error: null }, apps: [{ app: "Slack", status: "removed" }] } }));
  assert.match(empty, /이 사람 Claude 에 연결된 앱: 없음\(마지막 확인 기준\)/);
  assert.doesNotMatch(empty, /Slack\(/);
});

test("T5 꺼진 수집기 빈 칸은 연결이 아니다 — 켜진 것만 센다", () => {
  const p = buildFirstTurnPrompt(base({ collectors: [
    { label: "Notion — 팀 문서", preset_key: "notion", enabled: false },
    { label: "깃허브", preset_key: "github", enabled: true },
  ] }));
  assert.match(p, /라이블리 수집기\(켜진 것\) 1개: 깃허브\(github\)/);
  assert.doesNotMatch(p, /Notion — 팀 문서/);
  const none = buildFirstTurnPrompt(base({ collectors: [{ label: "Slack", preset_key: "slack", enabled: false }] }));
  assert.match(none, /라이블리 수집기: 켜진 것 없음\(꺼진 빈 칸이 보여도 그건 연결이 아니다\)/);
});

test("T6 이름을 건너뛴 사람 — 이름을 지어 부르지 말라고 못박고 이름을 내지 않는다", () => {
  const p = buildFirstTurnPrompt(base({ displayName: null }));
  assert.match(p, /- 이름: \(답하지 않음 — 이름을 지어 부르지 마라\)/);
  assert.doesNotMatch(p, /수아/);
});

test("T7 단위는 앱별 개수만 싣는다 — 0건 앱은 빼고, 없으면 «아직 없음»", () => {
  const p = buildFirstTurnPrompt(base({ units: [{ app: "slack", candidate: 5, active: 2, excluded: 1 }, { app: "gmail", candidate: 0, active: 0, excluded: 0 }] }));
  assert.match(p, /수집 단위\(이 사람에게 보이는 것\): slack 후보 5 · 모으는 중 2 · 뺀 것 1/);
  assert.doesNotMatch(p, /gmail 후보/);
  const none = buildFirstTurnPrompt(base({ units: [] }));
  assert.match(none, /수집 단위: 아직 없음 — 목록 실행이 처음으로 채운다/);
  //  합류자에게는 이 사람 단위 줄 대신 팀 앱 줄이 선다
  assert.doesNotMatch(buildFirstTurnPrompt(base({ flow: "join", units: [{ app: "slack", candidate: 1, active: 0, excluded: 0 }] })), /수집 단위\(이 사람에게/);
});

test("T8 하지 말 것 — 입력과 무관하게 항상 들어간다(설치자·합류자 공통 + 갈래별)", () => {
  for (const flow of ["owner", "join"] as const) {
    const p = buildFirstTurnPrompt(base({ flow }));
    assert.match(p, /커넥터 도구\(`mcp__claude_ai_\*`\)로 직접 읽어 옮겨 적지 마라/);
    assert.match(p, /외부 앱에 쓰거나 보내지 마라/);
    assert.match(p, /`confirm:true` 는 .*사람이 답한 뒤에만/);
    assert.match(p, /질문은 한 번에 하나, `me_liv_ask_choice` 객관식으로/);
  }
  assert.match(buildFirstTurnPrompt(base()), /서랍\(카테고리\)·정리 규칙\(증류기\)은 이 대화에서 만들지 마라/);
});

test("T8′ 대화 표면 — 지시문이 사람 말이 아니라고 못박는다 · 세션 표면은 다른 첫 문장", () => {
  assert.match(buildFirstTurnPrompt(base()), /이 지시문은 사람이 쓴 것이 아니니/);
  const s = buildFirstTurnPrompt(base({ surface: "session" }));
  assert.match(s, /이 세션은 그 직후에 열렸다/);
  assert.doesNotMatch(s, /이 지시문은 사람이 쓴 것이 아니니/);
});

test("T9 올린 자료 — 있을 때만 싣고, 제목은 상한까지 + «외 n건»", () => {
  assert.doesNotMatch(buildFirstTurnPrompt(base()), /올려 둔 자료/);
  const names = Array.from({ length: 200 }, (_, k) => `문서${k}`);
  const p = buildFirstTurnPrompt(base({ uploads: { total: 200, kinds: [{ name: "문서", n: 200 }], names } }));
  assert.match(p, /올려 둔 자료 200건 — 문서 200/);
  assert.match(p, new RegExp(`문서${FIRST_TURN_NAME_CAP - 1} … 외 ${200 - FIRST_TURN_NAME_CAP}건`));
  assert.doesNotMatch(p, new RegExp(`문서${FIRST_TURN_NAME_CAP}\\b`));
});

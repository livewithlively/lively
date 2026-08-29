// 리브 1턴 프롬프트 — 사양 엣지 표(scratchpad/spec.md) 행마다 한 검사. 각 검사는 서로 다른 관측을 잡는다(변이 적발).
import test from "node:test";
import assert from "node:assert/strict";
import { buildFirstTurnPrompt, FIRST_TURN_NAME_CAP, type FirstTurnInput } from "./first-turn.js";

const base = (over: Partial<FirstTurnInput> = {}): FirstTurnInput => ({
  displayName: "수아",
  work: { asis: "회사·조직에서 팀과 함께 일한다 · 디자인", tobe: "시간을 가장 많이 쓰는 일: 사람들과 맞추고 공유하는 일" },
  drawers: ["산출물", "기록"],
  firstOrder: "지난 시안 리뷰에서 나온 피드백만 모아 정리해 줘",
  decisions: [{ what: "매주 반복하는 문서가 있다" }, { what: "자료를 보는 범위: 우리 팀이 같이 본다" }],
  uploads: { total: 3, kinds: [{ name: "슬랙", n: 2 }, { name: "회의록", n: 1 }], names: ["a", "b", "c"], forms: [] },
  categories: [{ name: "산출물", space: "business" }, { name: "기록", space: "business" }, { name: "운영", space: "business" }],
  collectors: [{ label: "슬랙 #design", preset_key: "slack", enabled: true, sync_interval_sec: 900 }],
  aiHarnesses: ["claude"],
  harness: "claude",
  ...over,
});
const empty = { total: 0, kinds: [], names: [], forms: [] };

test("① 전부 있음 — 이름·일·서랍·자료·수집기·AI 가 실측 구획에 실린다", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /- 이름: 수아/);
  assert.match(p, /- 하는 일: 회사·조직에서 팀과 함께 일한다 · 디자인/);
  assert.match(p, /처음 설정이 만든 서랍 2개: 산출물 · 기록/);
  assert.match(p, /올린 자료 3건 — 슬랙 2, 회의록 1/);
  assert.match(p, /연결한 수집기 1개\(켜짐 1\): 슬랙 #design\(slack, 15분 주기\)/);
  assert.match(p, /이 세션은 claude 로 돈다 \(로그인 확인: claude\)/);
  assert.match(p, /- 매주 반복하는 문서가 있다/);
});

test("② 빈 상태 — 서랍·자료·수집기 0, 첫 지시 없음 → 사실대로 + 다음 트리거 '자료가 들어오면'", () => {
  const p = buildFirstTurnPrompt(base({ drawers: [], categories: [], uploads: empty, collectors: [], firstOrder: null }));
  assert.match(p, /서랍: 아직 없음/);
  assert.match(p, /올린 자료: 없음/);
  assert.match(p, /연결한 수집기: 없음/);
  assert.match(p, /첫 지시: \(고르지 않음\)/);
  assert.match(p, /\*\*자료가 들어오면 증류 작업/);
});

test("③ 이름을 건너뛴 사람 — 이름을 지어 부르지 말라고 못박고 이름을 내지 않는다", () => {
  const p = buildFirstTurnPrompt(base({ displayName: null }));
  assert.match(p, /- 이름: \(답하지 않음 — 이름을 지어 부르지 마라\)/);
  assert.doesNotMatch(p, /수아/);
});

test("④ 수집기 없이 자료만 → '올린 자료를 읽은 뒤 곧', 수집 상태 안내 없음", () => {
  const p = buildFirstTurnPrompt(base({ collectors: [] }));
  assert.match(p, /\*\*올린 자료를 읽은 뒤 곧 증류 작업/);
  assert.doesNotMatch(p, /지금 돌고 있거나 곧 돈다/);
});

test("⑤ 수집기 있음 → '첫 수집이 한 바퀴 돈 뒤' + 수집 상태 안내", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /\*\*첫 수집이 한 바퀴 돈 뒤 증류 작업/);
  assert.match(p, /지금 돌고 있거나 곧 돈다/);
});

test("⑥ 자료 제목 상한 초과 — 상한까지만 싣고 '외 n건', 그 다음 제목은 없다", () => {
  const names = Array.from({ length: 200 }, (_, k) => `문서${k}`);
  const p = buildFirstTurnPrompt(base({ uploads: { total: 200, kinds: [], names, forms: [] } }));
  assert.match(p, new RegExp(`문서${FIRST_TURN_NAME_CAP - 1} … 외 ${200 - FIRST_TURN_NAME_CAP}건`));
  assert.doesNotMatch(p, new RegExp(`문서${FIRST_TURN_NAME_CAP}\\b`));
});

test("⑥′ 경계 — 제목이 정확히 상한이면 '외' 가 없다", () => {
  const names = Array.from({ length: FIRST_TURN_NAME_CAP }, (_, k) => `문서${k}`);
  const p = buildFirstTurnPrompt(base({ uploads: { total: FIRST_TURN_NAME_CAP, kinds: [], names, forms: [] } }));
  assert.match(p, new RegExp(`문서${FIRST_TURN_NAME_CAP - 1}\\n`));
  assert.doesNotMatch(p, /외 \d+건/);
});

test("⑦ 서랍 밖에 원래 있던 갈래는 따로 센다", () => {
  const p = buildFirstTurnPrompt(base());
  assert.match(p, /그 밖에 이미 있는 갈래 1개: 운영/);
  assert.doesNotMatch(p, /서랍 3개/);
});

test("⑧ 꺼진 수집기 — '꺼짐' 표시, 켜짐 수에서 제외", () => {
  const p = buildFirstTurnPrompt(base({ collectors: [
    { label: "노션", preset_key: "notion", enabled: true, sync_interval_sec: 3600 },
    { label: "깃허브", preset_key: "github", enabled: false, sync_interval_sec: 1800 },
  ] }));
  assert.match(p, /연결한 수집기 2개\(켜짐 1\)/);
  assert.match(p, /깃허브\(github, 30분 주기, 꺼짐\)/);
});

test("⑨ 금지 구획은 입력과 무관하게 항상 들어간다", () => {
  const p = buildFirstTurnPrompt(base({ collectors: [], uploads: empty, drawers: [], displayName: null, work: null }));
  assert.match(p, /수집기·증류기·지식을 \*\*만들지 마라\.\*\*/);
  assert.match(p, /질문하지 마라/);
  assert.match(p, /\*\*턴을 끝내라\.\*\*/);
  assert.match(p, /다시 조회하지 마라/);
});

test("⑩ work 가 없으면 '하는 일: (답하지 않음)', tobe 줄은 없다", () => {
  const p = buildFirstTurnPrompt(base({ work: null }));
  assert.match(p, /- 하는 일: \(답하지 않음\)/);
  assert.doesNotMatch(p, /시간을 가장 많이 쓰는 일/);
});

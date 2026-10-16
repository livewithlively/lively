// 검색 실패 보조 안내 · 단위 찾기(#4213 T12 #4744) — 사양 엣지 표 W·T·M·A·N·E 행(순수). 조회·공개범위는 unit-find.pg-test.mjs.
//
//  엣지 표
//   W1 결과 0개 → 약함(empty)   W2 낱말이 다 든 지식이 있음 → 강함(의미가 멀어도)   W3 의미 최고값 ≥ 0.65 → 강함 · 0.649 → 약함
//   W4 의미를 못 잼(null) · 낱말 없음 → 약함
//   T1 낱말 맞춤 — 조사를 뗀 꼴(«결제를» ↔ «결제») · 군말(«어떻게»)은 빼고 셈 · 낱말이 다 군말이면 군말도 셈 · 같은 뜻 표기(배포 ↔ deploy) · 비율
//   T1b 문턱 — 이름에 든 낱말이 있으면 맞음 · 아니면 맞은 낱말이 둘 이하 질의면 전부 · 그보다 많으면 절반 이상(셋 중 하나 · 둘 중 하나 → 0 · 넷 중 둘 → 0.5)
//   T2 단위 글 — 이름 · 설명 · 연결된 맥락(글 · 글 목록 · 객체의 글 값) · 소문자
//   M1 맞음 점수 — 의미는 0.5 이상일 때만 · 낱말은 0.5 + 0.4 × 비율 · 큰 값 · 맞은 까닭(vector · text · both) · 둘 다 아니면 0
//   A1 몇 전 — 59초 «방금» · 60초 «1분 전» · 59분 · 1시간 · 23시간 · 1일 · 읽을 수 없는 시각 null
//   N1 안내 문구 — 수집 시각이 있으면 «N 전 수집했습니다 …» · 켠 단위인데 아직이면 «첫 수집 전» · 후보면 «모으지 않는 곳»
//   S1 원문 자료에 맞아야 하는 낱말 수 — 0·1·2 는 전부 · 3→2 · 4→2 · 5→3
//   E1 설명 벡터의 글 — «앱 종류 이름» + 설명 + 연결된 맥락 · 모르는 앱·종류는 그대로/빈칸 · 8,000자
import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIT_MIN_SIM, WEAK_TOP_SIM, agoText, knowledgeWeak, termsNeeded, textMatchScore, unitEmbeddingText, unitHaystack, unitHintText, unitMatch,
} from "./unit-find-plan.js";

test("W 지식이 약한가 — 결과 없음 · 낱말 · 의미 문턱(0.65) · 못 잼", () => {
  assert.deepEqual(knowledgeWeak({ count: 0, topSim: 0.99, lexical: true }), { weak: true, reason: "empty" }, "W1 결과가 없으면 늘 약함");
  assert.deepEqual(knowledgeWeak({ count: 3, topSim: 0.1, lexical: true }), { weak: false, reason: null }, "W2 낱말이 다 든 지식이 있으면 강함");
  assert.deepEqual(knowledgeWeak({ count: 3, topSim: WEAK_TOP_SIM, lexical: false }), { weak: false, reason: null }, "W3 문턱 그대로면 강함");
  assert.deepEqual(knowledgeWeak({ count: 3, topSim: WEAK_TOP_SIM - 0.001, lexical: false }), { weak: true, reason: "weak" }, "W3 문턱 아래면 약함");
  assert.deepEqual(knowledgeWeak({ count: 3, topSim: null, lexical: false }), { weak: true, reason: "weak" }, "W4 못 쟀으면 약한 쪽");
});

test("T1 낱말 맞춤 — 조사 · 군말 · 같은 뜻 표기 · 비율", () => {
  const hay = "결제 기능 출시 논의. 일정·버그 결정이 주로 오감 · deploy 기록";
  assert.equal(textMatchScore("결제를 출시하는 일정", hay), 2 / 3, "«결제를»→결제 ✓ · «출시하는» ✗(조사 아님) · «일정» ✓");
  assert.equal(textMatchScore("결제 일정 어떻게", hay), 1, "군말(«어떻게»)은 빼고 센다");
  assert.equal(textMatchScore("배포 기록", hay), 1, "배포 ↔ deploy(같은 뜻 표기)");
  assert.equal(textMatchScore("채용 공고", hay), 0);
  assert.equal(textMatchScore("   ", hay), 0, "낱말이 없으면 0");
});

test("T1b 문턱 — 흔한 낱말 하나만 스친 단위는 안 맞는다(원문 자료와 같은 문턱)", () => {
  const hay = "채용 공고와 면접 일정";
  assert.equal(textMatchScore("결제 출시 일정", hay), 0, "셋 중 하나(«일정») — 문턱 둘에 못 미침");
  assert.equal(textMatchScore("결제 일정", hay), 0, "둘 중 하나 — 둘 이하 질의는 전부 맞아야");
  assert.equal(textMatchScore("면접 일정", hay), 1, "둘 다");
  assert.equal(textMatchScore("면접 일정 결제 출시", hay), 0.5, "넷 중 둘 — 절반이면 맞음");
  assert.equal(textMatchScore("면접 결제 출시 환불 정산", hay), 0, "다섯 중 하나 — 문턱 셋");
  assert.equal(textMatchScore("채용", hay), 1, "낱말 하나 질의는 그 하나");
  //  이름에 든 낱말 — 채널 이름 «#결제-출시» 에 «결제» 가 들면 낱말 넷 중 하나여도 맞는다(비율 그대로 0.25 → 점수는 낮다).
  const pay = "#결제-출시\n결제 기능 출시 일정과 버그를 정한다";
  assert.equal(textMatchScore("결제 롤아웃 날짜 확정", pay, "#결제-출시"), 0.25, "이름에 든 낱말");
  assert.equal(textMatchScore("결제 롤아웃 날짜 확정", pay, null), 0, "이름을 모르면 문턱대로");
  assert.equal(textMatchScore("면접 날짜 확정 결제", hay, "#채용"), 0, "설명에만 하나 스치고 이름엔 없음 → 0");
  assert.equal(textMatchScore("롤아웃 날짜", pay, "#결제-출시"), 0, "이름에도 설명에도 없으면 0");
});

test("T2 단위 글 — 이름 · 설명 · 연결된 맥락(글·목록·객체) · 소문자", () => {
  assert.equal(unitHaystack({ name: "#Pay", description: "결제", meta: { context: "PRJ-1 결제 출시" } }), "#pay\n결제\nprj-1 결제 출시");
  assert.equal(unitHaystack({ name: null, description: null, meta: { context: ["고객사 A", 3, "결제"] } }), "고객사 a 결제");
  assert.equal(unitHaystack({ name: "x", description: null, meta: { context: { projects: ["결제 출시"], people: "김" , n: 2 } } }), "x\n결제 출시 김");
  assert.equal(unitHaystack({ name: "x", description: null, meta: null }), "x");
});

test("M1 맞음 점수 — 의미 문턱(0.5) · 낱말 0.5+0.4×비율 · 큰 값 · 까닭", () => {
  assert.deepEqual(unitMatch(0.7, 0), { score: 0.7, by: "vector" });
  assert.deepEqual(unitMatch(UNIT_MIN_SIM, 0), { score: UNIT_MIN_SIM, by: "vector" }, "문턱 그대로는 맞음");
  assert.deepEqual(unitMatch(UNIT_MIN_SIM - 0.01, 0), { score: 0, by: null }, "문턱 아래 의미만으로는 안 맞음");
  assert.deepEqual(unitMatch(null, 1), { score: 0.9, by: "text" });
  assert.deepEqual(unitMatch(null, 0.5), { score: 0.7, by: "text" });
  assert.deepEqual(unitMatch(0.95, 0.5), { score: 0.95, by: "both" }, "의미가 더 크면 의미 값 · 까닭은 둘 다");
  assert.deepEqual(unitMatch(0.4, 0.5), { score: 0.7, by: "text" }, "문턱 아래 의미는 까닭에 안 든다");
  assert.deepEqual(unitMatch(null, 0), { score: 0, by: null });
});

test("A1 몇 전 — 경계", () => {
  const now = Date.parse("2026-10-17T00:00:00.000Z");
  const ago = (s: number) => agoText(new Date(now - s * 1000).toISOString(), now);
  assert.equal(ago(59), "방금");
  assert.equal(ago(60), "1분 전");
  assert.equal(ago(3599), "59분 전");
  assert.equal(ago(3600), "1시간 전");
  assert.equal(ago(86399), "23시간 전");
  assert.equal(ago(86400), "1일 전");
  assert.equal(ago(-30), "방금", "시계가 앞선 시각도 «방금»");
  assert.equal(agoText(null, now), null);
  assert.equal(agoText("깨진 시각", now), null);
});

test("N1 안내 문구 — 수집 시각 · 첫 수집 전 · 모으지 않는 곳(끝맺은 문장)", () => {
  const now = Date.parse("2026-10-17T00:00:00.000Z");
  assert.equal(unitHintText({ read_at: new Date(now - 2 * 3600_000).toISOString(), state: "active" }, now),
    "2시간 전 수집했습니다 — 그 뒤 새 글이 필요하면 이 커넥터로 직접 찾아보세요.");
  assert.match(unitHintText({ read_at: null, state: "active" }, now), /^아직 첫 수집 전입니다/);
  assert.match(unitHintText({ read_at: null, state: "candidate" }, now), /^아직 모으지 않는 곳입니다/);
  for (const s of [unitHintText({ read_at: null, state: "active" }, now), unitHintText({ read_at: null, state: "candidate" }, now)]) assert.ok(s.endsWith("."), s);
});

test("S1 원문 자료에 맞아야 하는 낱말 수 — 둘 이하 전부 · 그 위 절반 올림", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8].map(termsNeeded), [0, 1, 2, 2, 2, 3, 4]);
});

test("E1 설명 벡터의 글 — 앱·종류 이름표 + 이름 · 설명 · 맥락 · 8,000자", () => {
  assert.equal(unitEmbeddingText({ app: "slack", kind: "private_channel", name: "#결제-출시", description: "결제 기능 출시 논의", meta: { context: ["PRJ-1"] } }),
    "슬랙 비공개 채널 #결제-출시\n\n결제 기능 출시 논의\n\nprj-1");
  assert.equal(unitEmbeddingText({ app: "jira", kind: "weird", name: null, description: null }), "jira", "모르는 앱은 키 그대로 · 모르는 종류는 빈칸");
  assert.equal(unitEmbeddingText({ app: "notion", kind: "page", name: "x", description: "가".repeat(9000) }).length, 8000);
});

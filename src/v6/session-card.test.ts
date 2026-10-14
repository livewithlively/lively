import { strict as assert } from "node:assert";
import test from "node:test";
import { buildSessionCard, CARD_MAX } from "./session-card.js";

// #4530 검색 품질 «뜻으로 찾기» — 세션 요약 카드의 순수 규칙. 원준 2026-10-05: «결국 세션을 해야함 … 다를 전부 하도록».
//  엣지 표(행마다 시험 하나):
//   | C1 | 이름 · 프로젝트 · 사람 말 · 고친 파일 · AI 말 | 그 순서의 줄 — AI 말은 마지막 것 하나만            |
//   | C2 | 사람이 한 말이 없다                          | 빈 글(카드를 만들지 않는다)                         |
//   | C3 | 짧은 맞장구 · 같은 말의 되풀이               | 뺀다(처음 시킨 말은 짧아도 싣는다)                  |
//   | C4 | 말이 많아 상한을 넘는다                      | 앞쪽 절반과 뒤쪽 절반을 남긴다 · 전체는 상한 안     |
//   | C5 | 고친 파일                                    | 경로 끝 두 마디 · 같은 파일 한 번 · 40개까지        |
//   | C6 | 줄바꿈·여백이 많은 말 · 아주 긴 말           | 한 줄로 펴고 자른다(줄임표)                         |
//   | C7 | lastAnswer 를 따로 넘김                      | msgs 의 AI 말 대신 그것을 쓴다                      |
const U = (text: string) => ({ role: "user" as const, text });
const A = (text: string) => ({ role: "assistant" as const, text });
const E = (text: string) => ({ role: "edit" as const, text });

test("[C1] 이름 · 프로젝트 · 처음 시킨 말 · 이어서 한 말 · 고친 파일 · 마지막 답 순서 — AI 말은 마지막 것 하나만", () => {
  const card = buildSessionCard({ name: "검색 결함 점검", project: "통합검색(⌘K) 결함 점검", msgs: [
    U("지금 우리 검색에 불편한 게 너무 많아"), A("살펴보겠습니다"), E("web/v2/omni.ts"), U("세션을 대화 내용으로 찾고 싶어"), A("세션 단위로 바꿨습니다") ] });
  assert.equal(card, [
    "세션 이름: 검색 결함 점검", "프로젝트: 통합검색(⌘K) 결함 점검", "처음 시킨 말: 지금 우리 검색에 불편한 게 너무 많아",
    "이어서 한 말: 세션을 대화 내용으로 찾고 싶어", "고친 파일: v2/omni.ts", "마지막 답: 세션 단위로 바꿨습니다"].join("\n"));
});
test("[C2] 사람이 한 말이 없으면 빈 글", () => {
  assert.equal(buildSessionCard({ name: "이름만", msgs: [A("혼잣말"), E("a/b.ts")] }), "");
  assert.equal(buildSessionCard({ msgs: [] }), "");
});
test("[C3] 짧은 맞장구 · 같은 말의 되풀이는 뺀다 — 처음 시킨 말은 짧아도 싣는다", () => {
  const card = buildSessionCard({ msgs: [U("고쳐"), U("응"), U("ㅇㅋ"), U("배포까지 해 줘"), U("배포까지 해 줘"), U("확인했어 고마워")] });
  assert.equal(card, "처음 시킨 말: 고쳐\n이어서 한 말: 배포까지 해 줘 / 확인했어 고마워");
});
test("[C4] 말이 많아 상한을 넘으면 앞쪽 절반과 뒤쪽 절반 — 전체는 상한 안", () => {
  const msgs = [U("처음 말"), ...Array.from({ length: 200 }, (_, i) => U(`말 ${String(i).padStart(3, "0")} ` + "가".repeat(100)))];
  const card = buildSessionCard({ msgs });
  assert.ok(card.length <= CARD_MAX, `길이 ${card.length}`);
  assert.ok(card.includes("말 000 ") && card.includes("말 199 "), "맨 앞과 맨 뒤의 말이 남는다");
  assert.ok(!card.includes("말 100 "), "가운데 말은 빠진다");
  const kept = [...card.matchAll(/말 (\d{3}) /g)].map((m) => Number(m[1]));
  assert.deepEqual(kept, [...kept].sort((a, b) => a - b), "남은 말은 대화 순서 그대로");
});
test("[C5] 고친 파일 — 경로 끝 두 마디 · 같은 파일 한 번 · 40개까지", () => {
  const card = buildSessionCard({ msgs: [U("고쳐 줘"), E("web/v2/omni.ts"), E("lively/web/v2/omni.ts"), E("src/v6/conv-search.ts"), ...Array.from({ length: 60 }, (_, i) => E(`a/b/f${i}.ts`))] });
  const line = card.split("\n").find((l) => l.startsWith("고친 파일: "))!;
  const files = line.slice("고친 파일: ".length).split(", ");
  assert.deepEqual(files.slice(0, 2), ["v2/omni.ts", "v6/conv-search.ts"]);
  assert.equal(files.length, 40);
});
test("[C6] 줄바꿈·여백은 한 칸으로 펴고, 긴 말은 자른다", () => {
  const card = buildSessionCard({ msgs: [U("첫 줄\n\n  둘째   줄"), U("나".repeat(1000)), A("다".repeat(2000))] });
  assert.ok(card.startsWith("처음 시킨 말: 첫 줄 둘째 줄\n"));
  assert.ok(/이어서 한 말: 나{260}…/.test(card));
  assert.ok(/마지막 답: 다{500}…$/.test(card));
});
test("[C7] lastAnswer 를 따로 넘기면 msgs 의 AI 말 대신 그것을 쓴다", () => {
  assert.equal(buildSessionCard({ msgs: [U("물어본 것"), A("대화 속 답")], lastAnswer: "따로 읽은 마지막 답" }), "처음 시킨 말: 물어본 것\n마지막 답: 따로 읽은 마지막 답");
});

test("[C8] 카드 글의 토큰·키 모양은 가린다 — 임베딩 서버로 나가는 글이다(산문은 그대로)", () => {
  const card = buildSessionCard({ name: "키 넣기", msgs: [
    { role: "user", text: "이 키로 깃허브에 올려 줘 ghp_abcdefghijklmnopqrstuvwxyz0123456789 부탁해" },
    { role: "user", text: "Bearer authentication middleware 를 붙여 줘" },
  ] });
  assert.doesNotMatch(card, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.match(card, /이 키로 깃허브에 올려 줘/);
  assert.match(card, /Bearer authentication middleware/, "산문은 가리지 않는다");
});

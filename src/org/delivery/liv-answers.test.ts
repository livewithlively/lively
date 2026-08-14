// 순수 단위 체크(node:assert) — 사람들이 고른 답을 통계로 접는 규칙(#1631).
//
// 이 파일이 지키는 것 둘:
//  ① **`others` 를 버리지 않는다** — 목록에 없어 직접 적어낸 이름이 곧 다음에 만들 커넥터 후보다.
//     실측에서 가장 값진 정보가 거기 있었다(카카오톡·네이버밴드·에어테이블·인스타DM).
//  ② **누가 답했는지를 섞지 않는다** — 사람이 버튼을 누른 것(self)과 리브가 채팅을 옮겨 적은 것(liv)을
//     합쳐 버리면, 리브가 잘못 옮긴 것과 사람이 직접 고른 것을 구분할 수 없어 통계를 못 믿는다.
//
// 사양 엣지표(행마다 시나리오 1개 이상):
//  | #  | 상태                                          | 기대                                      |
//  |----|-----------------------------------------------|-------------------------------------------|
//  | 1  | 아무도 안 답함                                 | 빈 배열                                    |
//  | 2  | 한 사람이 둘 고름                              | 선택지별 1, responders 1                   |
//  | 3  | 두 사람이 같은 것 고름                          | 그 선택지 2                                |
//  | 4  | `other` 만 적음(고른 것 없음)                   | others 에 잡히고 responders 는 센다         |
//  | 5  | 같은 `other` 를 두 사람이 적음                  | others n=2                                 |
//  | 6  | `by` 미표기(옛 레코드)                          | **사람 답으로 센다**(리브로 오분류 금지)     |
//  | 7  | self 와 liv 가 섞임                            | by_self·by_liv 로 갈라 센다                 |
//  | 8  | 서로 다른 key 두 개                            | key 별로 나뉜다                             |
//  | 9  | question 이 한쪽에만 있음                       | 있는 쪽을 쓴다                              |
//  | 10 | 정렬                                          | 많이 고른 것이 앞                            |
//  | 11 | key 없는 쓰레기 레코드                          | 무시(터지지 않는다)                          |
//  | 12 | 같은 key 재답변(merge)                          | 최신 하나만 남는다 — **집계가 사람 수를 넘지 않는다** |
//  | 13 | 다른 key 재답변(merge)                          | 둘 다 남는다                                |
//  | 14 | merge 상한                                     | 오래된 것부터 버린다                         |
import assert from "node:assert/strict";
import { foldAnswerStats, mergeAnswer, type AnswerRow } from "./liv-secret.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const one = (key: string, choices: string[], over: Partial<AnswerRow> = {}): AnswerRow => ({ key, choices, ...over });
const stat = (rows: AnswerRow[][], key = "context_sources") => foldAnswerStats(rows).find((s) => s.key === key)!;

t("[1] 아무도 안 답하면 빈 배열", () => {
  assert.deepEqual(foldAnswerStats([]), []);
  assert.deepEqual(foldAnswerStats([[], []]), []);
});

t("[2] 한 사람이 둘 고르면 각각 1", () => {
  const s = stat([[one("context_sources", ["notion", "files"])]]);
  assert.equal(s.responders, 1);
  assert.deepEqual(s.choices.map((c) => [c.id, c.n]).sort(), [["files", 1], ["notion", 1]]);
});

t("[3] 두 사람이 같은 것을 고르면 2", () => {
  const s = stat([[one("context_sources", ["slack"])], [one("context_sources", ["slack"])]]);
  assert.equal(s.responders, 2);
  assert.deepEqual(s.choices, [{ id: "slack", n: 2 }]);
});

t("[4] 고른 것 없이 '그 외'만 적어도 센다 — 그게 제일 알고 싶은 정보다", () => {
  const s = stat([[one("context_sources", [], { other: "카카오톡" })]]);
  assert.equal(s.responders, 1);
  assert.deepEqual(s.choices, []);
  assert.deepEqual(s.others, [{ text: "카카오톡", n: 1 }]);
});

t("[5] 같은 '그 외'를 둘이 적으면 n=2 — 커넥터 우선순위가 여기서 나온다", () => {
  const s = stat([[one("context_sources", [], { other: "에어테이블" })], [one("context_sources", ["slack"], { other: "에어테이블" })]]);
  assert.deepEqual(s.others, [{ text: "에어테이블", n: 2 }]);
});

t("[6] by 미표기(옛 레코드)는 **사람 답**으로 센다 — 리브가 적은 것으로 오분류하면 안 된다", () => {
  const s = stat([[one("context_sources", ["notion"])]]);
  assert.equal(s.by_self, 1);
  assert.equal(s.by_liv, 0);
});

t("[7] self 와 liv 를 갈라 센다", () => {
  const s = stat([
    [one("context_sources", ["notion"], { by: "self" })],
    [one("context_sources", ["kakao"], { by: "liv" })],
    [one("context_sources", ["slack"], { by: "liv" })],
  ]);
  assert.equal(s.responders, 3);
  assert.equal(s.by_self, 1);
  assert.equal(s.by_liv, 2);
});

t("[8] key 가 다르면 따로 집계한다", () => {
  const all = foldAnswerStats([[one("context_sources", ["notion"]), one("ai_usage", ["writing"])]]);
  assert.deepEqual(all.map((s) => s.key).sort(), ["ai_usage", "context_sources"]);
});

t("[9] question 은 있는 쪽을 쓴다", () => {
  const s = stat([[one("context_sources", ["notion"])], [one("context_sources", ["slack"], { question: "어디에 쌓아 두셨어요?" })]]);
  assert.equal(s.question, "어디에 쌓아 두셨어요?");
});

t("[10] 많이 고른 것이 앞에 온다", () => {
  const s = stat([
    [one("context_sources", ["notion", "slack"])],
    [one("context_sources", ["slack"])],
    [one("context_sources", ["slack"])],
  ]);
  assert.equal(s.choices[0].id, "slack");
  assert.equal(s.choices[0].n, 3);
});

t("[11] key 없는 쓰레기 레코드는 무시한다(터지지 않는다)", () => {
  const rows = [[{ choices: ["x"] } as AnswerRow, one("context_sources", ["notion"])]];
  const all = foldAnswerStats(rows);
  assert.deepEqual(all.map((s) => s.key), ["context_sources"]);
});

t("[12] 같은 key 재답변은 갈아끼운다 — 두 줄이 남으면 집계가 사람 수를 넘는다", () => {
  const first = mergeAnswer([], one("context_sources", ["notion"]));
  const second = mergeAnswer(first, one("context_sources", ["slack"]));
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].choices, ["slack"]);
  assert.equal(stat([second]).responders, 1, "한 사람인데 2 로 세면 통계가 틀어진다");
});

t("[13] 다른 key 재답변은 둘 다 남는다", () => {
  const merged = mergeAnswer(mergeAnswer([], one("context_sources", ["notion"])), one("ai_usage", ["writing"]));
  assert.deepEqual(merged.map((a) => a.key), ["context_sources", "ai_usage"]);
});

t("[14] 상한을 넘으면 오래된 것부터 버린다", () => {
  let cur: AnswerRow[] = [];
  for (let i = 0; i < 5; i++) cur = mergeAnswer(cur, one(`k${i}`, ["x"]), 3);
  assert.deepEqual(cur.map((a) => a.key), ["k2", "k3", "k4"]);
});

console.log(`\n${pass} passed`);

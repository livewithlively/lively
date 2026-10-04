import { strict as assert } from "node:assert";
import test from "node:test";
import { assignActivities, parseJournalRange, clampJournalLimit, inJournalRange, JOURNAL_MAX, type JournalBoxLink, type JournalActRef } from "./session-journal.js";

// #4553 — 세션 이력 앱 «작업 일지» 의 순수 규칙. 원준 2026-10-04: «그 A,B,C안을 … 상위 가로탭으로 만들어가지고 셋 다 구현해».
//  작업 기록(activity)은 박스에 붙고 일지의 한 줄은 대화다 — 한 박스가 대화를 갈아타면(/clear · resume) 기록이 어느 대화의
//  것인지 정해야 한다. 엣지 표(행마다 테스트 하나):
//   A1 기록의 세션 id 가 대화 uuid 그 자체 · A2 대화가 하나뿐인 박스 · A3 두 대화 사이를 시각으로 가른다 · A4 경계 시각은 뒤 대화 ·
//   A5 첫 대화보다 이른 기록 · A6 시각 없는 기록 · A7 모르는 박스 · A8 시각 모르는 대화는 가장 이른 것 · A9 같은 쌍이 두 번(시각 아는 쪽) ·
//   A10 목록 밖 형제 대화의 기록을 끌어오지 않는다 · A11 순서 없이 온 사슬 · A12 박스끼리 섞이지 않는다
//   R1~R2 기간 · L1 상한
//   I1 기록이 기간 앞·안·뒤 · I2 경계(since 는 들고 until 은 빠진다) · I3 끝이 없는 쪽은 열려 있다 · I4 시각 모르는 기록은 기간 안

const T = (min: number): string => new Date(Date.parse("2026-10-04T00:00:00Z") + min * 60_000).toISOString();
const link = (box: string, conv: string, min: number | null): JournalBoxLink => ({ box_id: box, conv_uuid: conv, first_seen: min == null ? null : T(min) });
const act = (id: number, box: string, min: number | null): JournalActRef => ({ id, box, at: min == null ? null : T(min) });
const run = (links: JournalBoxLink[], acts: JournalActRef[], convs: string[] = []): Record<number, string> =>
  Object.fromEntries(assignActivities(links, acts, new Set(convs)));

test("[A1] 기록의 세션 id 가 대화 uuid 그 자체면 그 대화다 — 박스 사슬을 보지 않는다", () => {
  assert.deepEqual(run([link("box-a", "c9", 0)], [act(1, "c1", 5)], ["c1"]), { 1: "c1" });
});
test("[A2] 대화가 하나뿐인 박스의 기록은 시각과 무관하게 그 대화다", () => {
  assert.deepEqual(run([link("box-a", "c1", 10)], [act(1, "box-a", 500), act(2, "box-a", 11)]), { 1: "c1", 2: "c1" });
});
test("[A3] 박스가 대화를 갈아탔으면 기록 시각 이전에 시작한 것 중 가장 늦은 대화에 붙는다", () => {
  const links = [link("box-a", "c1", 0), link("box-a", "c2", 10), link("box-a", "c3", 20)];
  assert.deepEqual(run(links, [act(1, "box-a", 5), act(2, "box-a", 12), act(3, "box-a", 99)]), { 1: "c1", 2: "c2", 3: "c3" });
});
test("[A4] 기록 시각이 다음 대화의 시작과 같으면 다음 대화다(경계값)", () => {
  assert.deepEqual(run([link("box-a", "c1", 0), link("box-a", "c2", 10)], [act(1, "box-a", 10)]), { 1: "c2" });
});
test("[A5] 첫 대화보다 이른 기록은 첫 대화에 붙는다", () => {
  assert.deepEqual(run([link("box-a", "c1", 10), link("box-a", "c2", 20)], [act(1, "box-a", 3)]), { 1: "c1" });
});
test("[A6] 시각 없는 기록은 그 박스의 마지막 대화에 붙는다", () => {
  assert.deepEqual(run([link("box-a", "c1", 0), link("box-a", "c2", 10)], [act(1, "box-a", null)]), { 1: "c2" });
});
test("[A7] 박스가 돌린 대화를 하나도 모르면 붙이지 않는다", () => {
  assert.deepEqual(run([link("box-a", "c1", 0)], [act(1, "box-zzz", 5)]), {});
});
test("[A8] 처음 본 때를 모르는 대화는 가장 이른 것으로 본다 — 시각 아는 뒤 대화가 제 몫을 가져간다", () => {
  const links = [link("box-a", "c2", 10), link("box-a", "c1", null)];
  assert.deepEqual(run(links, [act(1, "box-a", 5), act(2, "box-a", 15)]), { 1: "c1", 2: "c2" });
});
test("[A9] 같은 (박스, 대화) 쌍이 두 번 오면 한 대화로 접고 시각 아는 쪽을 쓴다", () => {
  const links = [link("box-a", "c1", 0), link("box-a", "c2", null), link("box-a", "c2", 10)];
  assert.deepEqual(run(links, [act(1, "box-a", 5), act(2, "box-a", 12)]), { 1: "c1", 2: "c2" });
});
test("[A10] 목록 밖 형제 대화의 기록은 그 형제의 것으로 남는다 — 목록에 있는 대화로 끌어오지 않는다", () => {
  //  화면 목록에 c2 만 있어도(convIds 는 규칙 ①의 재료일 뿐이다) c1 구간의 기록은 c1 로 판정된다 — 호출부가 버린다.
  assert.deepEqual(run([link("box-a", "c1", 0), link("box-a", "c2", 10)], [act(1, "box-a", 5)], ["c2"]), { 1: "c1" });
});
test("[A11] 사슬이 순서 없이 와도 처음 본 때 순으로 세워 판정한다", () => {
  const links = [link("box-a", "c3", 20), link("box-a", "c1", 0), link("box-a", "c2", 10)];
  assert.deepEqual(run(links, [act(1, "box-a", 12)]), { 1: "c2" });
});
test("[A12] 박스끼리 섞이지 않는다 — 다른 박스의 대화가 더 늦게 시작했어도 제 박스 안에서만 고른다", () => {
  const links = [link("box-a", "c1", 0), link("box-b", "c2", 3)];
  assert.deepEqual(run(links, [act(1, "box-a", 50), act(2, "box-b", 50)]), { 1: "c1", 2: "c2" });
});

test("[R1] 기간 — ISO 로 읽히는 값은 UTC ISO 로 고르게 돌려준다", () => {
  assert.deepEqual(parseJournalRange("2026-10-01T00:00:00+09:00", "2026-10-08T00:00:00Z"), { since: "2026-09-30T15:00:00.000Z", until: "2026-10-08T00:00:00.000Z" });
});
test("[R2] 기간 — 비었거나 못 읽는 값은 그쪽 끝 없음(null)", () => {
  assert.deepEqual(parseJournalRange("", undefined), { since: null, until: null });
  assert.deepEqual(parseJournalRange("어제", null), { since: null, until: null });
});
test("[L1] 상한 — 기본 200 · 1 이상 · JOURNAL_MAX 이하", () => {
  assert.equal(clampJournalLimit(undefined), 200);
  assert.equal(clampJournalLimit(0), 200);
  assert.equal(clampJournalLimit(-5), 1);
  assert.equal(clampJournalLimit(3.9), 3);
  assert.equal(clampJournalLimit(99999), JOURNAL_MAX);
});

test("[I1] 작업 기록이 일지 기간의 앞 · 안 · 뒤 어디인가", () => {
  assert.equal(inJournalRange(T(5), T(10), T(20)), "before");
  assert.equal(inJournalRange(T(15), T(10), T(20)), "in");
  assert.equal(inJournalRange(T(25), T(10), T(20)), "after");
});
test("[I2] 경계값 — 시작 시각은 기간 안, 끝 시각은 기간 뒤(since ≤ 시각 < until)", () => {
  assert.equal(inJournalRange(T(10), T(10), T(20)), "in");
  assert.equal(inJournalRange(T(20), T(10), T(20)), "after");
});
test("[I3] 끝이 없는 쪽(null)은 열려 있다", () => {
  assert.equal(inJournalRange(T(5), null, T(20)), "in");
  assert.equal(inJournalRange(T(99), T(10), null), "in");
  assert.equal(inJournalRange(T(99), null, null), "in");
});
test("[I4] 시각을 모르는 기록은 기간 안으로 본다(버리면 영영 안 보인다)", () => {
  assert.equal(inJournalRange(null, T(10), T(20)), "in");
  assert.equal(inJournalRange("언젠가", T(10), T(20)), "in");
});

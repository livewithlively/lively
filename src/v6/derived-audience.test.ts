// #4824 증류 지식의 볼 수 있는 사람(순수) — 사양 엣지 표 A·X·M 행. DB 쪽(잠금·저장·거절)은 derived-visibility.pg-test.mjs.
//
//  사양 요지: 증류 지식을 볼 수 있는 사람 ⊆ 그 지식이 나온 잠긴 자료 각각을 볼 수 있는 사람. 좁히기만 한다.
//   교집합은 열쇠(member:x · team:y)가 똑같은 것만 남긴다. 리스트 grant 는 잠긴 자료와 만나면 걷는다(OR 로만 적히므로).
//   «좁아지나» 는 지금 보는 사람 기준(팀은 지금 팀원으로 풀어 비교) — 열린 지식을 잠그는 것·리스트를 걷는 것은 늘 좁아짐.
import test from "node:test";
import assert from "node:assert/strict";
import { expandMembers, planDerivedAudience, type KnowledgeAudience, type LockedSourceAudience } from "./derived-audience.js";

const OPEN: KnowledgeAudience = { open: true, subjects: [], lists: [] };
const locked = (subjects: string[], lists: number[] = []): KnowledgeAudience => ({ open: false, subjects, lists });
const src = (id: number, ...subjects: string[]): LockedSourceAudience => ({ id, subjects });
const TEAMS = new Map<string, Set<string>>([["T", new Set(["a", "b"])]]);

// ── A 기본 표 ──
test("A1 잠긴 자료가 없으면 아무것도 안 바꾼다(열린 지식은 열린 채)", () => {
  const p = planDerivedAudience(OPEN, []);
  assert.deepEqual(p.next, { open: true, subjects: [], lists: [] });
  assert.equal(p.changed, false); assert.equal(p.narrows, false); assert.equal(p.empty, false);
});

test("A2 열린 지식 + 잠긴 자료 하나 → 그 자료의 대상으로 잠긴다(좁아짐)", () => {
  const p = planDerivedAudience(OPEN, [src(1, "member:a", "member:b")]);
  assert.deepEqual(p.next, { open: false, subjects: ["member:a", "member:b"], lists: [] });
  assert.equal(p.changed, true); assert.equal(p.narrows, true); assert.equal(p.empty, false);
});

test("A3 잠긴 자료 둘 → 둘 다 보는 사람만", () => {
  const p = planDerivedAudience(OPEN, [src(1, "member:a", "member:b"), src(2, "member:b", "member:c")]);
  assert.deepEqual(p.next.subjects, ["member:b"]);
});

test("A4 겹치는 사람이 없으면 비고(empty) 잠긴다 — 열지 않는다", () => {
  const p = planDerivedAudience(OPEN, [src(1, "member:a"), src(2, "member:b")]);
  assert.equal(p.next.open, false); assert.deepEqual(p.next.subjects, []); assert.equal(p.empty, true);
});

test("A5 이미 자료보다 좁은 지식은 그대로(바뀜 없음 · 좁아짐 없음)", () => {
  const p = planDerivedAudience(locked(["member:a", "member:b"]), [src(1, "member:a", "member:b", "member:c")]);
  assert.deepEqual(p.next.subjects, ["member:a", "member:b"]);
  assert.equal(p.changed, false); assert.equal(p.narrows, false);
});

test("A6 자료보다 넓은 잠긴 지식은 자료 대상으로 좁아진다", () => {
  const p = planDerivedAudience(locked(["member:a", "member:b", "member:c"]), [src(1, "member:a", "member:b")]);
  assert.deepEqual(p.next.subjects, ["member:a", "member:b"]);
  assert.equal(p.changed, true); assert.equal(p.narrows, true);
});

test("A7 팀은 팀 그대로 남는다(같은 열쇠)", () => {
  const p = planDerivedAudience(locked(["team:T"]), [src(1, "team:T")], TEAMS);
  assert.deepEqual(p.next.subjects, ["team:T"]);
  assert.equal(p.changed, false); assert.equal(p.narrows, false);
});

test("A8 팀 ∩ 사람은 남기지 않는다(사람으로 풀어 적으면 팀을 나가도 계속 본다) — 비고 좁아짐", () => {
  const p = planDerivedAudience(locked(["team:T"]), [src(1, "member:a")], TEAMS);
  assert.deepEqual(p.next.subjects, []);
  assert.equal(p.empty, true); assert.equal(p.narrows, true);
});

test("A9 적는 꼴만 바뀌고 보는 사람은 같으면 좁아짐이 아니다(사람 a 가 팀 T 안)", () => {
  const p = planDerivedAudience(locked(["member:a", "team:T"]), [src(1, "team:T")], TEAMS);
  assert.deepEqual(p.next.subjects, ["team:T"]);
  assert.equal(p.changed, true, "member:a 행을 걷어야 한다");
  assert.equal(p.narrows, false, "a 는 팀 T 로 계속 본다");
});

test("A10 리스트 grant 가 있는 지식 + 잠긴 자료 → 리스트를 걷는다(좁아짐으로 친다)", () => {
  const p = planDerivedAudience(locked(["member:a"], [7]), [src(1, "member:a")]);
  assert.deepEqual(p.next, { open: false, subjects: ["member:a"], lists: [] });
  assert.equal(p.dropsLists, true); assert.equal(p.changed, true); assert.equal(p.narrows, true);
});

test("A11 리스트 grant 만 있는 지식이라도 잠긴 자료가 없으면 그대로", () => {
  const p = planDerivedAudience(locked([], [7]), []);
  assert.deepEqual(p.next, { open: false, subjects: [], lists: [7] });
  assert.equal(p.changed, false); assert.equal(p.dropsLists, false); assert.equal(p.empty, false);
});

test("A12 이미 아무도 못 보는 지식은 그대로(바뀜 없음)", () => {
  const p = planDerivedAudience(locked([]), [src(1, "member:a")]);
  assert.equal(p.changed, false); assert.equal(p.narrows, false); assert.equal(p.empty, true);
});

test("A13 대상이 0인 잠긴 자료(정책을 못 읽어 닫힌 자료)도 그대로 따른다 — 열린 지식이 닫힌다", () => {
  const p = planDerivedAudience(OPEN, [src(1)]);
  assert.equal(p.next.open, false); assert.equal(p.empty, true); assert.equal(p.narrows, true);
});

test("A14 같은 열쇠가 겹쳐 와도 한 번만", () => {
  const p = planDerivedAudience(locked(["member:a", "member:a"]), [src(1, "member:a", "member:a")]);
  assert.deepEqual(p.next.subjects, ["member:a"]);
  assert.equal(p.changed, false);
});

// ── X 넓히지 않는다(단조) — 무작위 표본 ──
test("X1 맞춘 결과는 언제나 지식의 지금 대상과 각 자료 대상의 부분집합이다", () => {
  const pool = ["member:a", "member:b", "member:c", "team:T", "team:U"];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = () => pool.filter(() => rnd() < 0.5);
  for (let i = 0; i < 400; i++) {
    const k: KnowledgeAudience = rnd() < 0.3 ? OPEN : locked(pick());
    const ss = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, j) => src(j + 1, ...pick()));
    const p = planDerivedAudience(k, ss, TEAMS);
    assert.equal(p.next.open, false);
    if (!k.open) for (const x of p.next.subjects) assert.ok(k.subjects.includes(x), `넓어졌다: ${x}`);
    for (const s of ss) for (const x of p.next.subjects) assert.ok(s.subjects.includes(x), `자료 #${s.id} 밖: ${x}`);
  }
});

// ── M 사람으로 풀기 ──
test("M1 사람은 그대로, 팀은 팀원으로, 모르는 팀은 아무도 아니다", () => {
  assert.deepEqual([...expandMembers(["member:z", "team:T", "team:nope"], TEAMS)].sort(), ["a", "b", "z"]);
});

// scripts/keyed-cards.test.mjs — 자료 칸 «제자리 되그리기» 의 순수 핵심(web/v2/keyed-cards.ts · reuseKeyed) 사양 테스트 (#4135).
//  컴파일 산출물 public/app/v2/keyed-cards.js 를 그대로 import 한다(DOM 무의존 — hub-layout.test.mjs 동형).
//  왜: 자료 칸은 8초마다 목록을 다시 읽는데, 서명이 바뀌면 격자를 통째로 새로 만들어 카드가 전부 새 노드였다 →
//   미리보기가 전부 다시 받아져(아이콘 → 그림) 깜빡였다. 바뀐 카드만 바뀌어야 한다:
//   같은 id 의 열쇠가 같으면 이전 노드를 **그 객체 그대로**(make 없이), 다르면 새로 make, 사라진 id 는 map 에서 지운다.
//  노드는 DOM 이 아니어도 된다 — 평범한 객체 `{ id }` 로 신원(===)을 잰다. 사양 B 만 보고 쓴 블라인드 시험.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(join(root, "public/app/v2/keyed-cards.js"));

const item = (id, key = "k0") => ({ id, key });
const ids = (nodes) => nodes.map((n) => n.id);

/** 한 자료 칸 — 같은 cards 맵을 그리기마다 넘겨 제자리 갱신을 보고, make 호출은 id 순서로 기록한다. */
function pane() {
  const cards = new Map();
  const made = [];
  const draw = (ordered) => M.reuseKeyed(
    cards, ordered,
    (t) => t.id,
    (t) => t.key,
    (t) => { made.push(t.id); return { id: t.id, key: t.key }; },
  );
  return { cards, made, draw };
}

test("#1 처음(빈 map) — 항목마다 make 한 번, 반환은 ordered 순서, map 에 전부 들어간다", () => {
  const p = pane();
  const r = p.draw([item("a"), item("b", "kb"), item("c")]);
  assert.deepEqual(p.made, ["a", "b", "c"], "make 가 항목마다 정확히 한 번");
  assert.equal(r.length, 3);
  assert.deepEqual(ids(r), ["a", "b", "c"]);
  assert.deepEqual([...p.cards.keys()].sort(), ["a", "b", "c"], "map 에 전부");
  for (let i = 0; i < r.length; i++) {
    const card = p.cards.get(r[i].id);
    assert.equal(card.node, r[i], `map 의 노드가 반환 노드와 같은 객체: ${r[i].id}`);
  }
  assert.equal(p.cards.get("b").key, "kb", "map 에 열쇠가 남는다");
  assert.equal(p.cards.get("a").key, "k0");
});

test("#2 같은 id 의 열쇠가 같으면 — 이전 노드를 그 객체 그대로, make 를 부르지 않는다(항목 객체가 새것이어도)", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b", "kb"), item("c")]);
  assert.equal(p.made.length, 3);
  // 다음 틱 — 목록을 다시 읽어 항목 객체는 전부 새것이지만 id·열쇠는 같다
  const second = p.draw([item("a"), item("b", "kb"), item("c")]);
  assert.equal(second.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(second[i], first[i], `같은 객체: ${first[i].id}`);
  assert.equal(p.made.length, 3, "make 가 또 불렸다 — 미리보기가 다시 받아진다");
  assert.equal(p.cards.size, 3);
  for (let i = 0; i < 3; i++) assert.equal(p.cards.get(first[i].id).node, first[i]);
  // 몇 번을 더 그려도 마찬가지
  for (let n = 0; n < 5; n++) p.draw([item("a"), item("b", "kb"), item("c")]);
  assert.equal(p.made.length, 3);
});

test("#3 같은 id 의 열쇠가 다르면 — 그 항목만 make 로 새 노드, map 을 갈아 끼운다(나머지는 그대로)", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b", "kb"), item("c")]);
  const second = p.draw([item("a"), item("b", "kb2"), item("c")]);
  assert.deepEqual(p.made, ["a", "b", "c", "b"], "바뀐 b 만 다시 make");
  assert.deepEqual(ids(second), ["a", "b", "c"]);
  assert.equal(second[0], first[0], "a 는 같은 객체");
  assert.equal(second[2], first[2], "c 는 같은 객체");
  assert.notEqual(second[1], first[1], "b 는 새 객체");
  assert.equal(second[1].key, "kb2");
  assert.equal(p.cards.size, 3);
  assert.equal(p.cards.get("b").node, second[1], "map 이 새 노드로 갈아 끼워졌다");
  assert.equal(p.cards.get("b").key, "kb2", "map 의 열쇠도 새 값");
  // 열쇠가 다시 원래대로 돌아와도 «이전 그리기» 와 다르므로 또 make (이전 그리기의 카드만 기억한다)
  const third = p.draw([item("a"), item("b", "kb"), item("c")]);
  assert.deepEqual(p.made, ["a", "b", "c", "b", "b"]);
  assert.notEqual(third[1], second[1]);
  assert.equal(p.cards.get("b").node, third[1]);
});

test("#4 이번 ordered 에 없는 id 는 map 에서 지운다 — 남은 노드는 그대로", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b"), item("c"), item("d")]);
  const second = p.draw([item("a"), item("c")]);
  assert.deepEqual(ids(second), ["a", "c"]);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[2]);
  assert.equal(p.cards.size, 2);
  assert.ok(!p.cards.has("b"), "b 가 map 에 남았다");
  assert.ok(!p.cards.has("d"), "d 가 map 에 남았다");
  assert.equal(p.made.length, 4, "지우기만 했는데 make 가 불렸다");
  // 지워진 id 가 돌아오면 새로 make 된다(이전 노드는 이미 버려졌다)
  const third = p.draw([item("a"), item("b"), item("c")]);
  assert.deepEqual(p.made, ["a", "b", "c", "d", "b"]);
  assert.notEqual(third[1], first[1]);
  assert.equal(p.cards.get("b").node, third[1]);
});

test("#5 순서만 바뀐 경우 — 노드는 전부 재사용, 반환 순서만 바뀐다", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b"), item("c")]);
  const [A, B, C] = first;
  const second = p.draw([item("c"), item("a"), item("b")]);
  assert.deepEqual(ids(second), ["c", "a", "b"], "반환 순서 = ordered 순서");
  assert.equal(second[0], C);
  assert.equal(second[1], A);
  assert.equal(second[2], B);
  assert.equal(p.made.length, 3, "순서만 바뀌었는데 make 가 불렸다");
  assert.equal(p.cards.size, 3);
  const third = p.draw([item("b"), item("c"), item("a")]);
  assert.deepEqual([third[0], third[1], third[2]].map((n) => [A, B, C].indexOf(n)), [1, 2, 0]);
  assert.equal(p.made.length, 3);
});

test("#6 새 항목이 끼어들면 — 그 항목만 make, 나머지는 같은 객체, map 에 더해진다", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b"), item("c")]);
  const second = p.draw([item("a"), item("x"), item("b"), item("c")]);
  assert.deepEqual(p.made, ["a", "b", "c", "x"], "x 만 make");
  assert.deepEqual(ids(second), ["a", "x", "b", "c"]);
  assert.equal(second[0], first[0]);
  assert.equal(second[2], first[1]);
  assert.equal(second[3], first[2]);
  assert.equal(p.cards.size, 4);
  assert.equal(p.cards.get("x").node, second[1]);
  // 맨 앞·맨 뒤에 끼어들어도 같다
  const third = p.draw([item("front"), item("a"), item("x"), item("b"), item("c"), item("back")]);
  assert.deepEqual(p.made, ["a", "b", "c", "x", "front", "back"]);
  assert.deepEqual(ids(third), ["front", "a", "x", "b", "c", "back"]);
  assert.equal(third[1], first[0]);
  assert.equal(third[2], second[1]);
  assert.equal(p.cards.size, 6);
});

test("#7 ordered 가 비면 — 빈 배열, map 도 빈다", () => {
  const p = pane();
  p.draw([item("a"), item("b")]);
  assert.equal(p.cards.size, 2);
  const r = p.draw([]);
  assert.deepEqual(r, []);
  assert.equal(p.cards.size, 0, "map 이 비지 않았다");
  assert.equal(p.made.length, 2);
  // 처음부터 비어 있어도 던지지 않고 빈 배열
  const q = pane();
  assert.deepEqual(q.draw([]), []);
  assert.equal(q.cards.size, 0);
  assert.equal(q.made.length, 0);
  // 빈 뒤에 다시 채우면 전부 새로 make
  const again = p.draw([item("a"), item("b")]);
  assert.deepEqual(ids(again), ["a", "b"]);
  assert.deepEqual(p.made, ["a", "b", "a", "b"]);
  assert.equal(p.cards.size, 2);
});

test("#8 한 틱에 겹쳐 일어나도 — 재배열·열쇠 변경·삭제·끼어들기가 각각 제 규칙대로", () => {
  const p = pane();
  const first = p.draw([item("a"), item("b"), item("c"), item("d")]);
  const [A, , C, D] = first;
  // c 뒤로 밀리고(순서만) · d 열쇠 바뀜 · b 사라짐 · e 새로
  const second = p.draw([item("e"), item("d", "new"), item("a"), item("c")]);
  assert.deepEqual(ids(second), ["e", "d", "a", "c"]);
  assert.deepEqual(p.made, ["a", "b", "c", "d", "e", "d"], "e 와 열쇠 바뀐 d 만 make");
  assert.equal(second[2], A, "a 재사용");
  assert.equal(second[3], C, "c 재사용");
  assert.notEqual(second[1], D, "d 는 새 객체");
  assert.deepEqual([...p.cards.keys()].sort(), ["a", "c", "d", "e"]);
  assert.equal(p.cards.get("d").node, second[1]);
  assert.equal(p.cards.get("d").key, "new");
  assert.equal(p.cards.get("e").node, second[0]);
  assert.equal(p.cards.get("a").node, A);
  assert.equal(p.cards.get("c").node, C);
});

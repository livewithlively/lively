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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// placeChildren — 카드 목록을 «이번 순서(nodes)» 로 맞추되 **제자리인 노드는 건드리지 않는다** (#4135 · 사양 B).
//  왜: 떼었다 붙이면 그 안의 iframe 이 다시 실린다. 종전 구현은 «이번에 없는 옛 노드» 를 남겨 둔 채 앞에서부터 insertBefore 를
//   해서, 맨 앞 카드 하나만 바뀌어도 그 뒤 카드가 전부 한 칸씩 밀려 떼었다 붙여졌다.
//  가짜 host 는 배열을 감싸고 insertBefore/removeChild 호출을 **기록**한다. DOM 과 같은 뜻으로 —
//   insertBefore(node, before): node 가 이미 자식이면 먼저 빼고 before 앞에 넣는다(before 가 null 이면 끝에). before 가 자식이 아니면 던진다.
//   removeChild(node): 자식이 아니면 던진다.
//   childNodes: DOM NodeList 처럼 **살아 있는** ArrayLike(length + 숫자 인덱스 + iterator) — 배열 메서드는 없다.
//  사양 B 만 보고 쓴 블라인드 시험.

/** 가짜 host — `start` 를 자식으로 품고 시작한다. 노드는 아무 값이나(===로 신원). */
function host(start) {
  const kids = [...start];
  const calls = [];
  const childNodes = new Proxy({}, {
    get(_, p) {
      if (p === "length") return kids.length;
      if (p === Symbol.iterator) return () => kids[Symbol.iterator]();
      if (typeof p === "string" && /^\d+$/.test(p)) return kids[Number(p)];
      return undefined;
    },
    has(_, p) { return p === "length" || (typeof p === "string" && /^\d+$/.test(p) && Number(p) < kids.length); },
    ownKeys() { return [...kids.keys()].map(String).concat("length"); },
    getOwnPropertyDescriptor(_, p) {
      if (p === "length") return { value: kids.length, writable: true, enumerable: false, configurable: true };
      if (typeof p === "string" && /^\d+$/.test(p) && Number(p) < kids.length) return { value: kids[Number(p)], writable: true, enumerable: true, configurable: true };
      return undefined;
    },
  });
  return {
    childNodes,
    calls,
    insertBefore(node, before) {
      calls.push(["insertBefore", node, before]);
      if (before === node) before = kids[kids.indexOf(node) + 1] ?? null;   // DOM: child 가 node 자신이면 다음 형제 앞
      const i = kids.indexOf(node);
      if (i >= 0) kids.splice(i, 1);
      if (before === null || before === undefined) { kids.push(node); return node; }
      const j = kids.indexOf(before);
      if (j < 0) throw new Error(`insertBefore: before 가 자식이 아니다: ${String(before)}`);
      kids.splice(j, 0, node);
      return node;
    },
    removeChild(node) {
      calls.push(["removeChild", node]);
      const i = kids.indexOf(node);
      if (i < 0) throw new Error(`removeChild: 자식이 아니다: ${String(node)}`);
      kids.splice(i, 1);
      return node;
    },
    /** 지금 자식 순서(스냅샷). */
    order() { return [...kids]; },
    inserts() { return calls.filter((c) => c[0] === "insertBefore"); },
    removes() { return calls.filter((c) => c[0] === "removeChild"); },
    /** insertBefore 의 «옮겨진 노드» 목록. */
    moved() { return this.inserts().map((c) => c[1]); },
    removed() { return this.removes().map((c) => c[1]); },
  };
}

/** 사양 1 의 불변식 — 끝난 뒤 childNodes 가 nodes 와 같고, 중복·누락이 없다. */
function assertPlaced(h, nodes, label) {
  assert.deepEqual(h.order(), [...nodes], `${label}: 끝난 뒤 순서가 nodes 와 다르다 (calls=${JSON.stringify(h.calls)})`);
  assert.equal(h.childNodes.length, nodes.length, `${label}: length`);
  for (let i = 0; i < nodes.length; i++) assert.equal(h.childNodes[i], nodes[i], `${label}: childNodes[${i}]`);
}

// 작은 풀에서 «부분 순열» 전부 — 시작 상태·목표 상태 조합을 남김없이 돈다.
function partialPermutations(pool) {
  const out = [[]];
  const rec = (prefix, rest) => {
    for (let i = 0; i < rest.length; i++) {
      const next = [...prefix, rest[i]];
      out.push(next);
      rec(next, rest.filter((_, j) => j !== i));
    }
  };
  rec([], pool);
  return out;
}

test("★B1 끝난 뒤 childNodes 순서는 nodes 와 같다 — 4개 풀의 모든 시작 상태 × 모든 목표 상태(65×65)", () => {
  const pool = ["A", "B", "C", "D"];
  const states = partialPermutations(pool);
  assert.equal(states.length, 65, "재료 오류: 4개 풀의 부분 순열은 65개");
  let n = 0;
  for (const start of states) for (const nodes of states) {
    const h = host(start);
    assert.doesNotThrow(() => M.placeChildren(h, nodes), `던졌다: ${start.join("")} → ${nodes.join("")}`);
    assertPlaced(h, nodes, `${start.join("") || "∅"} → ${nodes.join("") || "∅"}`);
    n++;
  }
  assert.equal(n, 65 * 65);
});

test("★B1 객체 노드·큰 풀에서도 — 결정론적 의사난수 500쌍 전부 nodes 순서, 호출은 전부 DOM 규칙 안(던지지 않는다)", () => {
  const pool = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}` }));
  let seed = 4135;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = () => {
    const shuffled = [...pool].sort(() => rnd() - 0.5);
    return shuffled.slice(0, Math.floor(rnd() * (pool.length + 1)));
  };
  for (let k = 0; k < 500; k++) {
    const start = pick();
    const nodes = pick();
    const h = host(start);
    M.placeChildren(h, nodes);
    assertPlaced(h, nodes, `#${k} ${start.map((x) => x.id).join(",")} → ${nodes.map((x) => x.id).join(",")}`);
    // 이번에 없는 노드는 남아 있지 않다 · nodes 의 노드는 전부 있다
    for (const s of start) if (!nodes.includes(s)) assert.ok(!h.order().includes(s), `#${k} 이번에 없는 ${s.id} 가 남았다`);
  }
});

test("★B2 시작 상태가 이미 nodes 와 같으면 insertBefore 도 removeChild 도 한 번도 불리지 않는다", () => {
  const cases = [[], ["A"], ["A", "B"], ["A", "B", "C"], ["A", "B", "C", "D", "E"]];
  for (const same of cases) {
    const h = host(same);
    M.placeChildren(h, [...same]);                    // 다른 배열 객체지만 같은 노드·같은 순서
    assert.deepEqual(h.calls, [], `${same.join("") || "∅"}: 제자리인데 호출이 있었다: ${JSON.stringify(h.calls)}`);
    assertPlaced(h, same, same.join("") || "∅");
  }
  // 객체 노드도 마찬가지
  const objs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const h = host(objs);
  M.placeChildren(h, objs);
  assert.deepEqual(h.calls, []);
  // 같은 host 에 같은 목록을 여러 번 — 매번 0회
  for (let i = 0; i < 3; i++) M.placeChildren(h, [...objs]);
  assert.deepEqual(h.calls, [], "반복해도 호출이 없어야 한다");
});

test("★B3 [stale, A, B, C] → [fresh, A, B, C] — removeChild(stale) 한 번 · insertBefore(fresh, A) 한 번뿐, A·B·C 는 옮겨지지 않는다(핵심)", () => {
  const h = host(["stale", "A", "B", "C"]);
  M.placeChildren(h, ["fresh", "A", "B", "C"]);
  assertPlaced(h, ["fresh", "A", "B", "C"], "B3");
  assert.deepEqual(h.removed(), ["stale"], `removeChild 는 stale 한 번뿐이어야 한다: ${JSON.stringify(h.removes())}`);
  assert.deepEqual(h.inserts(), [["insertBefore", "fresh", "A"]], `insertBefore 는 (fresh, A) 한 번뿐이어야 한다: ${JSON.stringify(h.inserts())}`);
  assert.equal(h.calls.length, 2, `호출이 두 번뿐이어야 한다: ${JSON.stringify(h.calls)}`);
  for (const kept of ["A", "B", "C"]) assert.ok(!h.moved().includes(kept), `${kept} 가 insertBefore 로 옮겨졌다 — 그 안의 iframe 이 다시 실린다`);
});

test("★B3 (변형) 옛 노드가 가운데·끝에 있어도 — 남는 노드는 옮겨지지 않고, 새 노드 하나만 insertBefore 된다", () => {
  // 가운데: [A, stale, B, C] → [A, fresh, B, C]
  {
    const h = host(["A", "stale", "B", "C"]);
    M.placeChildren(h, ["A", "fresh", "B", "C"]);
    assertPlaced(h, ["A", "fresh", "B", "C"], "가운데");
    assert.deepEqual(h.removed(), ["stale"]);
    assert.deepEqual(h.moved(), ["fresh"], `fresh 만 옮겨져야 한다: ${JSON.stringify(h.inserts())}`);
    assert.deepEqual(h.inserts()[0], ["insertBefore", "fresh", "B"]);
  }
  // 끝: [A, B, C, stale] → [A, B, C, fresh]
  {
    const h = host(["A", "B", "C", "stale"]);
    M.placeChildren(h, ["A", "B", "C", "fresh"]);
    assertPlaced(h, ["A", "B", "C", "fresh"], "끝");
    assert.deepEqual(h.removed(), ["stale"]);
    assert.deepEqual(h.moved(), ["fresh"]);
    assert.equal(h.inserts()[0][2], null, "끝에 붙으니 before 는 null");
  }
  // 앞에 옛 노드 둘: [s1, s2, A, B] → [fresh, A, B]
  {
    const h = host(["s1", "s2", "A", "B"]);
    M.placeChildren(h, ["fresh", "A", "B"]);
    assertPlaced(h, ["fresh", "A", "B"], "앞 둘");
    assert.deepEqual([...h.removed()].sort(), ["s1", "s2"]);
    assert.deepEqual(h.inserts(), [["insertBefore", "fresh", "A"]]);
  }
});

test("★B4 이번에 없는 노드는 전부 제거된다 — [A, X, B, Y] → [A, B]: X·Y 가 removeChild, A·B 는 안 움직인다", () => {
  const h = host(["A", "X", "B", "Y"]);
  M.placeChildren(h, ["A", "B"]);
  assertPlaced(h, ["A", "B"], "B4");
  assert.deepEqual([...h.removed()].sort(), ["X", "Y"], `X·Y 가 각각 한 번 removeChild 되어야 한다: ${JSON.stringify(h.removes())}`);
  assert.equal(h.removes().length, 2);
  assert.deepEqual(h.inserts(), [], `A·B 가 움직였다: ${JSON.stringify(h.inserts())}`);
  assert.equal(h.calls.length, 2);
});

test("★B5 새 노드가 끝에 붙는 경우 — [A, B] → [A, B, C]: insertBefore(C, null) 한 번", () => {
  const h = host(["A", "B"]);
  M.placeChildren(h, ["A", "B", "C"]);
  assertPlaced(h, ["A", "B", "C"], "B5");
  assert.deepEqual(h.calls, [["insertBefore", "C", null]], `호출은 insertBefore(C, null) 하나뿐이어야 한다: ${JSON.stringify(h.calls)}`);
  // 빈 host 에 처음 채울 때도 — 전부 끝에 붙는다(제거 없음), 순서대로
  const e = host([]);
  M.placeChildren(e, ["A", "B", "C"]);
  assertPlaced(e, ["A", "B", "C"], "빈 host");
  assert.deepEqual(e.removes(), []);
  assert.deepEqual(e.moved(), ["A", "B", "C"]);
});

test("★B6 순서만 바뀐 경우 — [A, B, C] → [C, A, B] 결과 순서가 맞다(옮기는 횟수는 묻지 않는다)", () => {
  const h = host(["A", "B", "C"]);
  M.placeChildren(h, ["C", "A", "B"]);
  assertPlaced(h, ["C", "A", "B"], "B6");
  // 뒤집기·자리 바꾸기도
  const r = host(["A", "B", "C", "D"]);
  M.placeChildren(r, ["D", "C", "B", "A"]);
  assertPlaced(r, ["D", "C", "B", "A"], "뒤집기");
  const s = host(["A", "B", "C", "D"]);
  M.placeChildren(s, ["B", "A", "D", "C"]);
  assertPlaced(s, ["B", "A", "D", "C"], "짝 바꾸기");
  // 재배열 + 제거 + 추가가 겹쳐도 순서가 맞다
  const m = host(["A", "B", "C", "D"]);
  M.placeChildren(m, ["E", "D", "A", "C"]);
  assertPlaced(m, ["E", "D", "A", "C"], "겹침");
  assert.deepEqual(m.removed(), ["B"]);
});

test("★B7 nodes 가 비면 자식이 전부 제거된다 — 각각 한 번 removeChild, insertBefore 없음 · 이미 비어 있으면 호출 없음", () => {
  const h = host(["A", "B", "C"]);
  M.placeChildren(h, []);
  assertPlaced(h, [], "B7");
  assert.deepEqual([...h.removed()].sort(), ["A", "B", "C"], `각각 한 번씩 removeChild: ${JSON.stringify(h.removes())}`);
  assert.equal(h.removes().length, 3);
  assert.deepEqual(h.inserts(), []);
  // 처음부터 비어 있으면
  const e = host([]);
  assert.doesNotThrow(() => M.placeChildren(e, []));
  assert.deepEqual(e.calls, []);
  assertPlaced(e, [], "빈 → 빈");
  // 비운 뒤 다시 채우면 전부 끝에 붙는다
  M.placeChildren(h, ["A", "B"]);
  assertPlaced(h, ["A", "B"], "다시 채움");
});

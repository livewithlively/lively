// 옛 경로 → 새 경로(#4688)의 순수 규칙 — 사양 표 F1~F12. DB·FS 불요.
//  사양(태스크 #4688): 폴더는 접두로 기록 · 옛 링크는 새 자리 기준으로 권한을 다시 판정해 연다 · 여러 번 옮긴 연쇄는 상한 ·
//  옛 경로(따라가다 닿은 자리 포함)에 실제 파일이 있으면 그 파일이 이긴다. 가장 긴 접두 고르기는 SQL(file-move.pg-test)이 잰다.
//   실행: npm run build && node --test dist/files/file-move-core.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { normalizeMovePath, movePrefixes, applyMovePrefix, followMoves, MOVE_FOLLOW_MAX, type MoveRecord } from "./file-move-core.js";

/** 기록 표(옛 → 새)를 가장 긴 접두로 고르는 가짜 조회 — 실제 저장소(findFileMove)와 같은 규칙. */
function lookupOf(records: Array<[string, string]>) {
  return async (p: string): Promise<MoveRecord | null> => {
    for (const cand of movePrefixes(p)) {
      const hit = records.find(([from]) => from === cand);
      if (hit) return { from: hit[0], to: hit[1] };
    }
    return null;
  };
}
const setOf = (xs: string[]) => async (p: string): Promise<boolean> => xs.includes(p);

test("F1 경로 다듬기 — 구분자 '/' · 앞뒤·겹친 '/' 와 '.' 조각을 걷는다 · '..' 이나 빈 값은 null", () => {
  assert.equal(normalizeMovePath("project\\12\\a.md"), "project/12/a.md");
  assert.equal(normalizeMovePath("/a//b/"), "a/b");
  assert.equal(normalizeMovePath("./a/./b"), "a/b");
  assert.equal(normalizeMovePath("a/../b"), null);
  assert.equal(normalizeMovePath(".."), null);
  assert.equal(normalizeMovePath(""), null);
  assert.equal(normalizeMovePath("/"), null);
  assert.equal(normalizeMovePath(undefined), null);
  //  글자 꼴은 건드리지 않는다 — 링크의 경로와 기록의 옛 경로가 둘 다 디스크 이름 그대로라 그대로 맞춘다.
  const nfd = "회의록".normalize("NFD");
  assert.equal(normalizeMovePath(`a/${nfd}`), `a/${nfd}`);
});

test("F2 접두 후보 — 자기 + 조상, 긴 것부터(자리 맨 위 \"\" 는 없다)", () => {
  assert.deepEqual(movePrefixes("a/b/c.md"), ["a/b/c.md", "a/b", "a"]);
  assert.deepEqual(movePrefixes("a"), ["a"]);
});

test("F3 접두 옮기기 — 자기 · 하위만, 경계는 '/' (a/b 기록이 a/bc 를 잡지 않는다)", () => {
  assert.equal(applyMovePrefix("x/a.md", "x", "y"), "y/a.md");
  assert.equal(applyMovePrefix("x", "x", "y"), "y");
  assert.equal(applyMovePrefix("x/d/a.md", "x/d", "z"), "z/a.md");
  assert.equal(applyMovePrefix("xa", "x", "y"), null);
  assert.equal(applyMovePrefix("a/bc", "a/b", "c"), null);
  assert.equal(applyMovePrefix("w/x", "x", "y"), null);
});

test("F4 기록 없음 → null", async () => {
  assert.equal(await followMoves("a.md", { lookup: lookupOf([]), exists: setOf(["a.md"]), visible: () => true }), null);
});

test("F5 파일 한 번 — 새 자리에 있고 보이면 그 자리(한 단계)", async () => {
  const r = await followMoves("docs/a.md", { lookup: lookupOf([["docs/a.md", "docs/b.md"]]), exists: setOf(["docs/b.md"]), visible: () => true });
  assert.deepEqual(r, { path: "docs/b.md", hops: 1 });
});

test("F6 폴더 한 줄이 하위를 덮는다 — x→y 면 x/sub/a.md 는 y/sub/a.md", async () => {
  const r = await followMoves("x/sub/a.md", { lookup: lookupOf([["x", "y"]]), exists: setOf(["y/sub/a.md"]), visible: () => true });
  assert.deepEqual(r, { path: "y/sub/a.md", hops: 1 });
});

test("F7 폴더 줄 + 그 안 파일 줄 — 폴더를 옮긴 뒤 그 안 파일 이름을 바꿨으면 두 단계로 닿는다", async () => {
  const deps = { lookup: lookupOf([["x", "y"], ["y/a.md", "y/b.md"]]), exists: setOf(["y/b.md"]), visible: () => true };
  assert.deepEqual(await followMoves("x/a.md", deps), { path: "y/b.md", hops: 2 });
});

test("F8 닿은 자리에 무엇이 있는데 이 사람이 못 보면 null — 그 너머로 가지 않는다", async () => {
  const seenAt: string[] = [];
  const r = await followMoves("a.md", {
    lookup: lookupOf([["a.md", "locked/a.md"], ["locked/a.md", "open/a.md"]]),
    exists: setOf(["locked/a.md", "open/a.md"]),
    visible: (p) => { seenAt.push(p); return !p.startsWith("locked/"); },
  });
  assert.equal(r, null);
  assert.deepEqual(seenAt, ["locked/a.md"], "닿은 첫 자리에서 판정하고 멈춰야 한다");
});

test("F9 지나가는 자리(지금은 없는 곳)는 판정 없이 지나간다 — 마지막에 닿은 자리만 판정한다", async () => {
  const seenAt: string[] = [];
  const r = await followMoves("a.md", {
    lookup: lookupOf([["a.md", "locked/a.md"], ["locked/a.md", "open/a.md"]]),
    exists: setOf(["open/a.md"]),
    visible: (p) => { seenAt.push(p); return !p.startsWith("locked/"); },
  });
  assert.deepEqual(r, { path: "open/a.md", hops: 2 });
  assert.deepEqual(seenAt, ["open/a.md"]);
});

test("F10 닿은 자리도 안 보이면 null(새 자리 기준으로 다시 판정)", async () => {
  const r = await followMoves("a.md", { lookup: lookupOf([["a.md", "b.md"]]), exists: setOf(["b.md"]), visible: async () => false });
  assert.equal(r, null);
});

test("F11 고리 — 지난 자리로 돌아오면 멈춘다(기록이 꼬여도 끝난다)", async () => {
  let calls = 0;
  const lookup = lookupOf([["a.md", "b.md"], ["b.md", "a.md"]]);
  const r = await followMoves("a.md", { lookup: (p) => { calls++; return lookup(p); }, exists: setOf([]), visible: () => true });
  assert.equal(r, null);
  assert.ok(calls <= 2, `고리를 돌며 조회를 계속했다(${calls}번)`);
});

test("F12 단계 상한 — 정확히 상한이면 닿고, 하나 넘으면 null", async () => {
  const chain = (n: number): Array<[string, string]> => Array.from({ length: n }, (_, i) => [`p${i}`, `p${i + 1}`] as [string, string]);
  const at = (n: number) => ({ lookup: lookupOf(chain(n)), exists: setOf([`p${n}`]), visible: () => true });
  assert.deepEqual(await followMoves("p0", at(MOVE_FOLLOW_MAX)), { path: `p${MOVE_FOLLOW_MAX}`, hops: MOVE_FOLLOW_MAX });
  assert.equal(await followMoves("p0", at(MOVE_FOLLOW_MAX + 1)), null);
  assert.ok(MOVE_FOLLOW_MAX >= 3 && MOVE_FOLLOW_MAX <= 16, "상한은 접두가 겹친 몇 단계는 닿고 꼬인 기록에 오래 매달리지 않는 값이어야 한다");
});

test("F13 다음 걸음은 앞 기록의 도착 시각 이후 기록만 — 첫 걸음은 시각을 가리지 않는다", async () => {
  //  t1: x→y(도착 t1) · 그보다 앞서(t0) y 를 쓰던 다른 것의 기록 y/a.md→old/a.md · 그 뒤(t2) y/a.md→y/b.md.
  const recs: Array<MoveRecord & { at: string }> = [
    { from: "x", to: "y", at: "t1" }, { from: "y/a.md", to: "old/a.md", at: "t0" }, { from: "y/a.md", to: "y/b.md", at: "t2" },
  ];
  const asked: Array<[string, string | null]> = [];
  const lookup = async (p: string, since: string | null): Promise<MoveRecord | null> => {
    asked.push([p, since]);
    for (const cand of movePrefixes(p)) {
      const hit = recs.filter((r) => r.from === cand && (since === null || r.at >= since)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      if (hit) return hit;
    }
    return null;
  };
  const r = await followMoves("x/a.md", { lookup, exists: setOf(["y/b.md", "old/a.md"]), visible: () => true });
  assert.deepEqual(r, { path: "y/b.md", hops: 2 });
  assert.deepEqual(asked, [["x/a.md", null], ["y/a.md", "t1"]], "첫 걸음은 시각 없이 · 다음 걸음은 앞 기록의 도착 시각으로 물어야 한다");
});

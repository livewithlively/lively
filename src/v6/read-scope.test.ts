// 앱 맥락 범위(#5100) — 요청 단위 읽기 범위의 규칙(DB 없음). SQL 이 실제 행을 어떻게 고르는지는 apps/app-context.pg-test.mjs.
//  엣지 표(행마다 시험 하나 — 사양 A):
//   R1 앱 요청 밖 = 범위 없음 · R2 안 = 그 범위, 푸는 일은 요청마다 한 번 · R3 안 물으면 풀지 않는다
//   R4 동시에 도는 두 요청은 각자 제 범위만 · R5 «범위 밖» 구역 안에서는 범위 없음 · 나오면 다시 범위
//   R6 뷰어 — null(특권) · undefined(미배선)는 범위 없음, 문자열(빈 것 포함)은 범위 · R7 푸는 일이 실패하면 읽기도 실패
//   R8 카테고리 조건 — 빈 · 틀린 id = 아무것도 안 맞음(파라미터 안 늘림) · 중복 한 번 · 자리번호 · 거절된 연결 안 셈 · R8b 자료 종류 조건
//   R9 검색 후보 제한 — 범위 없음은 인자 그대로 · R9b 범위만 = 범위 · R9c 교집합 / 안 겹치면 빈 목록(제한 없음이 아니다) · R9d 특권 뷰어는 인자 그대로
//   R10 범위를 선언했지만 카테고리 0개 = 빈 제한 → 아무것도 안 맞음
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  withReadScope, outsideReadScope, currentReadScope, readScopeFor, knowledgeInCategoriesSql, sourceKindsSql,
  knowledgeCategoryRestriction, type ReadScope,
} from "./read-scope.js";

const S = (ids: number[], kinds: string[] = []): ReadScope => ({ appId: "a", knowledgeCategoryIds: ids, sourceKinds: kinds });

test("R1 앱 요청 밖 = 범위 없음", async () => {
  assert.equal(await currentReadScope(), null);
  assert.equal(await readScopeFor("m"), null);
});

test("R2 앱 요청 안 = 그 범위 · 푸는 일은 요청마다 한 번", async () => {
  let calls = 0;
  await withReadScope(async () => { calls++; return S([3]); }, async () => {
    assert.deepEqual((await currentReadScope())?.knowledgeCategoryIds, [3]);
    await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual((await readScopeFor("m"))?.knowledgeCategoryIds, [3]);
    assert.deepEqual((await currentReadScope())?.knowledgeCategoryIds, [3]);
  });
  assert.equal(calls, 1);
});

test("R3 한 번도 안 물으면 풀지 않는다", async () => {
  let calls = 0;
  const out = await withReadScope(async () => { calls++; return S([1]); }, async () => "done");
  assert.equal(out, "done");
  assert.equal(calls, 0);
});

test("R4 동시에 도는 두 요청은 각자 제 범위만", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const [a, b] = await Promise.all([
    withReadScope(async () => S([1]), async () => { await tick(); return (await currentReadScope())?.knowledgeCategoryIds; }),
    withReadScope(async () => S([2]), async () => { await tick(); return (await currentReadScope())?.knowledgeCategoryIds; }),
  ]);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [2]);
});

test("R5 «범위 밖» 구역 안에서는 범위 없음 · 나오면 다시 범위", async () => {
  await withReadScope(async () => S([1]), async () => {
    assert.equal(await outsideReadScope(() => currentReadScope()), null);
    assert.equal(await outsideReadScope(() => readScopeFor("m")), null);
    assert.deepEqual((await currentReadScope())?.knowledgeCategoryIds, [1]);
  });
});

test("R6 뷰어 — null · undefined 는 범위 없음, 문자열(빈 것 포함)은 범위", async () => {
  await withReadScope(async () => S([1]), async () => {
    assert.equal(await readScopeFor(null), null);
    assert.equal(await readScopeFor(undefined), null);
    assert.deepEqual((await readScopeFor(""))?.knowledgeCategoryIds, [1]);
    assert.deepEqual((await readScopeFor("m"))?.knowledgeCategoryIds, [1]);
  });
});

test("R7 푸는 일이 실패하면 읽기도 실패(넓게 열지 않는다)", async () => {
  await withReadScope(async () => { throw new Error("db down"); }, async () => {
    await assert.rejects(() => currentReadScope(), /db down/);
    await assert.rejects(() => readScopeFor("m"), /db down/);
  });
});

test("R8 카테고리 조건 — 빈 · 틀린 id = 아무것도 안 맞음(파라미터 안 늘림) · 중복 한 번 · 자리번호 · 거절된 연결 안 셈", () => {
  const p1: unknown[] = ["x"];
  assert.equal(knowledgeInCategoriesSql([], p1), "FALSE");
  assert.equal(knowledgeInCategoriesSql([0, -1, Number.NaN, 1.5], p1), "FALSE");
  assert.equal(p1.length, 1);
  const p2: unknown[] = ["x", "y"];
  const sql = knowledgeInCategoriesSql([5, 5, 7], p2, "kk");
  assert.equal(p2.length, 3);
  assert.deepEqual(p2[2], [5, 7]);
  assert.match(sql, /\bkk\.name\b/);
  assert.match(sql, /\$3::int\[\]/);
  assert.match(sql, /<>\s*'rejected'/);
});

test("R8b 자료 종류 조건 — 빈 것 = 아무것도 안 맞음 · 중복 · 빈 글은 버린다", () => {
  const p: unknown[] = [];
  assert.equal(sourceKindsSql([], p), "FALSE");
  assert.equal(sourceKindsSql([""], p), "FALSE");
  assert.equal(p.length, 0);
  const sql = sourceKindsSql(["slack", "slack", "", "email"], p);
  assert.deepEqual(p[0], ["slack", "email"]);
  assert.match(sql, /\$1::text\[\]/);
});

test("R9 범위 없음 — 인자 그대로(없으면 제한 없음)", async () => {
  assert.equal(await knowledgeCategoryRestriction("m", null), null);
  assert.equal(await knowledgeCategoryRestriction("m", undefined), null);
  assert.deepEqual(await knowledgeCategoryRestriction("m", [4]), [4]);
});

test("R9b 범위만 = 범위의 카테고리", async () => {
  await withReadScope(async () => S([1, 2]), async () => {
    assert.deepEqual(await knowledgeCategoryRestriction("m", null), [1, 2]);
  });
});

test("R9c 범위 × 인자 — 교집합 · 안 겹치면 빈 목록(제한 없음이 아니다)", async () => {
  await withReadScope(async () => S([1, 2]), async () => {
    assert.deepEqual(await knowledgeCategoryRestriction("m", [2, 9]), [2]);
    const none = await knowledgeCategoryRestriction("m", [9]);
    assert.ok(Array.isArray(none), "null(제한 없음)로 바뀌면 안 된다");
    assert.equal(none?.length, 0);
  });
});

test("R9d 특권 뷰어(null)는 범위를 걸지 않는다 — 인자 그대로", async () => {
  await withReadScope(async () => S([1, 2]), async () => {
    assert.deepEqual(await knowledgeCategoryRestriction(null, [9]), [9]);
    assert.equal(await knowledgeCategoryRestriction(null, null), null);
  });
});

test("R10 범위를 선언했지만 카테고리 0개 — 빈 제한 → 아무것도 안 맞음", async () => {
  await withReadScope(async () => S([]), async () => {
    const r = await knowledgeCategoryRestriction("m", null);
    assert.deepEqual(r, []);
    assert.equal(knowledgeInCategoriesSql(r ?? [], []), "FALSE");
  });
});

// #1419 T4 — 분류기 스코프 SQL 조립 회귀 잠금. 순수 함수(DB 무의존 — 조립된 문자열·파라미터 배열만 본다).
//  실행: npm run build && node dist/org/store/classifier-scope.test.js
//
//  왜 여기인가: `scopeWhere` 는 **공유 params 배열**을 이어 받아 여러 번 불린다(나 + 앞선 분류기마다 한 번).
//  배타 배정("한 지식은 우선순위가 가장 높은 분류기 하나에만")이 그 조각들을 한 쿼리로 합치기 때문이다.
//  여기서 자리표시자 번호가 어긋나면 **쿼리는 성공하면서 엉뚱한 값으로 필터링된다** — 에러가 안 나므로
//  "왜 저 분류기가 남의 지식을 가져갔지?"로만 드러나고, 그때는 이미 제안이 덮인 뒤다.
import assert from "node:assert/strict";
import { scopeWhere, type ClassifierRow } from "./classifiers.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 최소 필드만 채운 분류기 — 테스트마다 필요한 축만 덮어쓴다. */
const mk = (over: Partial<ClassifierRow> = {}): ClassifierRow => ({
  id: 1, key: "c1", label: null, enabled: true, priority: 0,
  target: "unmapped", confidence_below: null,
  match_spaces: null, match_types: null, match_provenance: null,
  match_systems: null, exclude_names: null,
  min_chars: 0, lookback_days: null,
  criteria_md: null, candidate_categories: null, confirm_threshold: 0.8,
  batch_size: 50, mode: "headless", session_ref: null,
  model: null, effort: null, requester: null,
  last_run_at: null, last_status: null, last_summary: null, note: null,
  ...over,
});

/** WHERE 절에 등장하는 $n 번호들. */
const placeholders = (sql: string): number[] =>
  [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

// ══ 자리표시자 번호 = params 배열 위치 ══
t("조건이 없으면 파라미터도 없다", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk(), p);
  assert.equal(p.length, 0);
  assert.deepEqual(placeholders(sql), []);
  assert.ok(sql.includes("lifecycle='active'"));
});

t("조건 하나 = $1", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ match_types: ["decision"] }), p);
  assert.deepEqual(p, [["decision"]]);
  assert.deepEqual(placeholders(sql), [1]);
});

t("여러 축이 순서대로 번호를 받는다 — 값과 위치가 1:1", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({
    match_types: ["decision"], match_provenance: "authored",
    match_systems: ["notion"], min_chars: 100, lookback_days: 30,
  }), p);
  const nums = placeholders(sql);
  // 번호는 1..n 이 빠짐없이·중복 없이 나와야 한다.
  assert.deepEqual([...new Set(nums)].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(p.length, 5);
  // 각 자리표시자가 **그 값**을 가리키는지 — 번호가 밀리면 여기서 깨진다.
  assert.deepEqual(p[0], ["decision"]);
  assert.equal(p[1], "authored");
  assert.deepEqual(p[2], ["notion"]);
  assert.equal(p[3], 100);
  assert.equal(p[4], 30);
});

// ══ 배타 배정 — 공유 배열을 이어 받는 것이 이 파일의 핵심 ══
t("두 번 호출하면 번호가 이어진다(겹치지 않는다) [배타 배정]", () => {
  const p: unknown[] = [];
  const mine = scopeWhere(mk({ id: 2, match_types: ["decision"] }), p);
  const ahead = scopeWhere(mk({ id: 1, match_systems: ["slack"] }), p);
  assert.deepEqual(placeholders(mine), [1]);
  assert.deepEqual(placeholders(ahead), [2]);   // ← 1 이 아니라 2. 여기가 어긋나면 조용히 남의 값을 쓴다.
  assert.deepEqual(p, [["decision"], ["slack"]]);
});

t("세 번 이어 붙여도 번호가 안 겹친다", () => {
  const p: unknown[] = [];
  const a = scopeWhere(mk({ match_types: ["a"] }), p);
  const b = scopeWhere(mk({ match_types: ["b"], match_systems: ["s"] }), p);
  const c = scopeWhere(mk({ min_chars: 50 }), p);
  const all = [...placeholders(a), ...placeholders(b), ...placeholders(c)];
  assert.deepEqual(all, [1, 2, 3, 4]);          // 중복 0
  assert.deepEqual(p, [["a"], ["b"], ["s"], 50]);
});

// ══ target 별 조건 ══
t("unmapped — 카테고리 0건만, 파라미터 없음", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ target: "unmapped" }), p);
  assert.ok(sql.includes("NOT EXISTS"));
  assert.ok(!sql.includes("state='proposed'"));
  assert.equal(p.length, 0);
});

t("low_confidence — 확신도 문턱이 파라미터로 들어간다", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ target: "low_confidence", confidence_below: 0.5 }), p);
  assert.ok(sql.includes("state='proposed'"));
  assert.equal(p[0], 0.5);
});

t("low_confidence 문턱 미지정이면 기본 0.8", () => {
  const p: unknown[] = [];
  scopeWhere(mk({ target: "low_confidence", confidence_below: null }), p);
  assert.equal(p[0], 0.8);
});

t("both — 두 조건이 OR 로 묶인다(AND 면 사실상 0건)", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ target: "both", confidence_below: 0.6 }), p);
  assert.ok(sql.includes("NOT EXISTS"), "미분류 조건이 빠졌다");
  assert.ok(sql.includes("state='proposed'"), "낮은확신도 조건이 빠졌다");
  // ⚠ `sql.includes(" OR ")` 로는 못 잡는다 — 낮은확신도 절 **안에** 이미 OR 이 있다
  //  (`confidence IS NULL OR confidence < $n`). 그래서 **두 절을 잇는 연산자**를 정확히 본다.
  //  AND 면 '카테고리가 없으면서 동시에 proposed 제안이 있는' 지식이라 논리적으로 0건이다 —
  //  분류기는 멀쩡히 켜져 있는데 아무것도 안 집는 상태가 되고, 그건 화면에 '잔량 0'으로만 보인다.
  const joiner = /\)\s*(OR|AND)\s*EXISTS \(SELECT 1 FROM knowledge_category kc WHERE kc\.name=k\.name\s*\n?\s*AND kc\.state='proposed'/.exec(sql);
  assert.ok(joiner, "미분류 절과 낮은확신도 절의 결합 지점을 찾지 못했다(구조가 바뀌었으면 이 테스트를 고쳐라)");
  assert.equal(joiner[1], "OR", "두 절이 AND 로 묶였다 — 그러면 매치가 0건이 된다");
  assert.equal(p[0], 0.6);
});

// ══ 항상 걸리는 기본 조건 ══
t("lifecycle='active' 는 어떤 설정에서도 빠지지 않는다", () => {
  // 빠지면 보관·삭제된 지식까지 분류 대상이 된다(이미 정리한 것을 다시 끌어올림).
  for (const target of ["unmapped", "low_confidence", "both"]) {
    const sql = scopeWhere(mk({ target }), []);
    assert.ok(sql.includes("k.lifecycle='active'"), `${target} 에서 빠졌다`);
  }
});

t("exclude_names 는 부정 조건으로 들어간다", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ exclude_names: ["skip-me"] }), p);
  assert.ok(/NOT \(k\.name = ANY/.test(sql));
  assert.deepEqual(p[0], ["skip-me"]);
});

t("빈 배열 축은 조건을 만들지 않는다(전체와 같다)", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ match_types: [], match_systems: [], exclude_names: [] }), p);
  assert.equal(p.length, 0);
  assert.deepEqual(placeholders(sql), []);
});

console.log(`\n${pass} passed`);

// #1419 T4 — 분류기 스코프 SQL 조립 회귀 잠금. 순수 함수(DB 무의존 — 조립된 문자열·파라미터 배열만 본다).
//  실행: npm run build && node dist/org/store/classifier-scope.test.js
//
//  왜 여기인가: `scopeWhere` 는 **공유 params 배열**을 이어 받아 여러 번 불린다(나 + 앞선 분류기마다 한 번).
//  배타 배정("한 지식은 우선순위가 가장 높은 분류기 하나에만")이 그 조각들을 한 쿼리로 합치기 때문이다.
//  여기서 자리표시자 번호가 어긋나면 **쿼리는 성공하면서 엉뚱한 값으로 필터링된다** — 에러가 안 나므로
//  "왜 저 분류기가 남의 지식을 가져갔지?"로만 드러나고, 그때는 이미 제안이 덮인 뒤다.
import assert from "node:assert/strict";
import { scopeWhere, uncoveredQuery, type ClassifierRow } from "./classifiers.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 최소 필드만 채운 분류기 — 테스트마다 필요한 축만 덮어쓴다. */
const mk = (over: Partial<ClassifierRow> = {}): ClassifierRow => ({
  id: 1, key: "c1", label: null, enabled: true, priority: 0,
  target: "unmapped", confidence_below: null,
  match_types: null, match_provenance: null,
  match_systems: null, exclude_names: null,
  min_chars: 0, lookback_days: null,
  criteria_md: null, candidate_categories: null, confirm_threshold: 0.8,
  batch_size: 50, mode: "headless", session_ref: null,
  harness: null, model: null, effort: null, requester: null,
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

// ══ #4194 — 재분류 모드는 폐지됐다 ══
//  분류기(지금은 증류기의 «카테고리 붙이기» 레인)가 쓰는 쓰기 도구 knowledge_propose_category 는 카테고리 행이
//  **하나라도 있으면 no-op** 이다(knowledge-store proposeKnowledgeCategory). 그런데 low_confidence 인박스는 정의상
//  이미 proposed 행이 있는 지식만 집는다 — 그래서 이 모드는 LLM 을 부르고 '봤다' 만 찍을 뿐 아무것도 못 바꿨다.
//  이미 붙은 카테고리를 고치는 일은 점검(관리기 «분류 어긋남 보정» move_category)이 한다.
t("low_confidence — 인박스가 빈다(FALSE) · 파라미터를 받지 않는다", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ target: "low_confidence", confidence_below: 0.5 }), p);
  assert.ok(/\bFALSE\b/.test(sql), "low_confidence 레인이 여전히 무언가를 집는다");
  assert.ok(!sql.includes("state='proposed'"), "폐지된 재분류 조건이 남아 있다");
  assert.equal(p.length, 0, "쓰지 않는 확신도 문턱이 파라미터로 들어갔다");
});

t("both — 미분류만 본다(재분류 절 없음)", () => {
  const p: unknown[] = [];
  const sql = scopeWhere(mk({ target: "both", confidence_below: 0.6 }), p);
  assert.ok(sql.includes("NOT EXISTS"), "미분류 조건이 빠졌다");
  assert.ok(!sql.includes("state='proposed'"), "폐지된 재분류 조건이 남아 있다");
  assert.equal(p.length, 0);
});

t("앞선 low_confidence 레인은 뒤 레인을 가리지 않는다 [배타 배정]", () => {
  //  배타 배정은 앞선 레인마다 NOT(그 스코프) 를 붙인다. 빈 인박스 레인의 스코프가 FALSE 를 AND 로 품으면
  //  NOT(... AND FALSE) = TRUE 라 뒤 레인의 몫을 하나도 빼앗지 않는다. OR 로 묶이면 뒤 레인이 굶는다.
  const sql = scopeWhere(mk({ target: "low_confidence" }), []);
  const parts = sql.split(" AND ").map((s) => s.trim());
  assert.ok(parts.includes("FALSE"), "FALSE 가 AND 로 묶인 독립 조건이 아니다 — 앞선 레인일 때 뒤 레인 몫을 건드릴 수 있다");
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

// ══ 사각지대(uncoveredQuery) — 레인 여럿의 스코프를 **한 params 배열**로 부정한다(#4194) ══
//  사각지대 = 어느 일하는 레인의 스코프에도 안 드는 미분류 지식. 자리표시자가 어긋나면 에러 없이 엉뚱한 레인 값으로
//  세어 «영영 못 받는다» 경보가 틀린다 — scopeWhere 와 같은 위험이라 같은 자리에서 잠근다.
/** 레인 스코프를 부정한 조각 수 — 스코프 자체의 미분류 조건은 «NOT EXISTS (» 라 여기 안 잡힌다. */
const negations = (sql: string): number => (sql.match(/NOT \(/g) ?? []).length;

t("[U1] 일하는 레인이 없으면 쿼리가 없다 — 기본 기준 하나가 전부 받으므로 사각지대 0", () => {
  assert.equal(uncoveredQuery([]), null);
});

t("[U2] 조건 없는 레인 하나 — 파라미터 0 · 그 스코프를 한 번 부정", () => {
  const u = uncoveredQuery([mk()]);
  assert.ok(u, "레인이 있는데 쿼리가 없다");
  assert.equal(u.params.length, 0);
  assert.deepEqual(placeholders(u.sql), []);
  assert.equal(negations(u.sql), 1);
});

t("[U3] 같은 축을 쓰는 레인 둘 — $1·$2 가 각자 자기 레인 값을 가리킨다", () => {
  const a = mk({ id: 1, key: "a", match_types: ["decision"] });
  const b = mk({ id: 2, key: "b", match_types: ["how-to"] });
  const u = uncoveredQuery([a, b]);
  assert.ok(u, "레인이 있는데 쿼리가 없다");
  assert.deepEqual(placeholders(u.sql), [1, 2], "레인마다 자리표시자를 새로 셌다 — 두 레인이 같은 값을 본다");
  assert.deepEqual(u.params, [["decision"], ["how-to"]]);
  assert.equal(negations(u.sql), 2, "레인마다 한 번씩 부정하지 않았다");
});

console.log(`\n${pass} passed`);

// 순수 단위 체크(테스트 러너 없이 node:assert) — computeFsDiff(path-diff 분류)와 computeFreshness.
// 실행: npm run build && node dist/domainmap/core/refresh-fs.test.js
// DB·git·파일시스템 무접촉(exists 프로브 주입) — 결정론적·재현 가능.
import assert from "node:assert/strict";
import { computeFsDiff, _deepEqualUnordered, type RenamePrefix } from "./refresh-fs.js";
import { computeFreshness } from "./queries.js";
import { classifyDomainDebt } from "./domain-debt.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// exists 프로브: 주어진 집합에 있으면 실재.
const existsIn = (set: string[]) => (p: string) => set.includes(p);

const PREFIXES: RenamePrefix[] = [{ from: "lively-mcp-store/", to: "context-ontology/" }];

t("실재하는 path 는 unchanged(no-op) — change 0", () => {
  const d = computeFsDiff({ storedPaths: ["AGENTS.md", "src/a.ts"], exists: existsIn(["AGENTS.md", "src/a.ts"]), renamePrefixes: PREFIXES });
  assert.deepEqual(d.unchanged.sort(), ["AGENTS.md", "src/a.ts"]);
  assert.equal(d.changes.length, 0);
  assert.equal(d.renamed.length, 0);
  assert.equal(d.removed.length, 0);
});

t("prefix 규칙으로 신규 위치가 실재 → rename R(score=100, 매핑 보존)", () => {
  const d = computeFsDiff({
    storedPaths: ["lively-mcp-store/src/index.ts"],
    exists: existsIn(["context-ontology/src/index.ts"]),
    renamePrefixes: PREFIXES,
  });
  assert.equal(d.renamed.length, 1);
  assert.deepEqual(d.renamed[0], { from: "lively-mcp-store/src/index.ts", to: "context-ontology/src/index.ts" });
  assert.equal(d.changes.length, 1);
  assert.equal(d.changes[0].status, "R");
  assert.equal(d.changes[0].score, 100); // 결정론적 이전 — 저신뢰 flag(<60) 회피
  assert.equal(d.removed.length, 0);
});

t("실재 없음 + 정직한 1:1 rename 없음 → removed D(soft + orphan flag 는 refresh()가)", () => {
  const d = computeFsDiff({
    storedPaths: ["domain-map/store-core.mjs"], // 신규 위치 없음(restructure)
    exists: existsIn([]),
    renamePrefixes: PREFIXES,
  });
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0], "domain-map/store-core.mjs");
  assert.equal(d.renamed.length, 0);
  assert.equal(d.changes[0].status, "D");
});

t("신규 위치를 다른 저장 path 가 이미 점유 → rename 안 함(removed 로 강등)", () => {
  // from 의 신규 위치가 storedSet 에 이미 있으면(다른 unit) rename 금지 — 행 충돌 방지.
  const d = computeFsDiff({
    storedPaths: ["lively-mcp-store/src/index.ts", "context-ontology/src/index.ts"],
    exists: existsIn(["context-ontology/src/index.ts"]),
    renamePrefixes: PREFIXES,
  });
  // context-ontology/src/index.ts 는 실재 → unchanged. lively-mcp-store/... 의 to 는 이미 stored → removed.
  assert.ok(d.unchanged.includes("context-ontology/src/index.ts"));
  assert.ok(d.removed.includes("lively-mcp-store/src/index.ts"));
  assert.equal(d.renamed.length, 0);
});

t("두 from 이 같은 to 로 갈리면 ambiguous → 둘 다 removed 로 강등(침묵 금지)", () => {
  const d = computeFsDiff({
    storedPaths: ["lively-mcp-store/x", "lively-mcp-store/x"], // 같은 to 로 충돌(인위적)
    exists: existsIn(["context-ontology/x"]),
    renamePrefixes: PREFIXES,
  });
  assert.equal(d.ambiguous.length, 2);
  assert.equal(d.renamed.length, 0);
  assert.equal(d.removed.length, 2);
});

t("longest-prefix 적용(겹치는 규칙 중 가장 긴 from 승)", () => {
  const d = computeFsDiff({
    storedPaths: ["a/b/c.ts"],
    exists: existsIn(["NEW-B/c.ts"]),
    renamePrefixes: [{ from: "a/", to: "X/" }, { from: "a/b/", to: "NEW-B/" }],
  });
  assert.equal(d.renamed.length, 1);
  assert.deepEqual(d.renamed[0], { from: "a/b/c.ts", to: "NEW-B/c.ts" });
});

t("prefix 규칙 없으면 실재 없는 path 는 전부 removed(rename 시도 안 함)", () => {
  const d = computeFsDiff({ storedPaths: ["gone/x.ts"], exists: existsIn([]) });
  assert.equal(d.removed.length, 1);
  assert.equal(d.renamed.length, 0);
});

// ── computeFreshness ──
t("never_refreshed: code_unit 있고 last_refreshed_sha=null → stale", () => {
  const f = computeFreshness({ last_refreshed_sha: null, last_scan_at: "2026-06-10" }, 59);
  assert.equal(f.stale, true);
  assert.equal(f.reason, "never_refreshed");
  assert.equal(f.last_refreshed_sha, null);
});

t("empty: code_unit 0 → stale 아님(미초기화로 구분)", () => {
  const f = computeFreshness({ last_refreshed_sha: null, last_scan_at: null }, 0);
  assert.equal(f.stale, false);
  assert.equal(f.reason, "empty");
});

t("checkpoint: last_refreshed_sha 있으면 stale 아님", () => {
  const f = computeFreshness({ last_refreshed_sha: "abc123", last_scan_at: "2026-06-10" }, 59);
  assert.equal(f.stale, false);
  assert.equal(f.reason, "checkpoint");
  assert.equal(f.last_refreshed_sha, "abc123");
});

// ── deepEqualUnordered(멱등 비교 — JSONB 키 재정렬 내성) ──
t("deepEqualUnordered: 키 순서만 다르면 같다(멱등)", () => {
  assert.equal(_deepEqualUnordered({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(_deepEqualUnordered({ x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } }), true);
});
t("deepEqualUnordered: 배열 순서는 의미 있음(다르면 다름)", () => {
  assert.equal(_deepEqualUnordered({ s: ["a", "b"] }, { s: ["b", "a"] }), false);
  assert.equal(_deepEqualUnordered({ s: ["a", "b"] }, { s: ["a", "b"] }), true);
});
t("deepEqualUnordered: 값/키 집합 다르면 다름", () => {
  assert.equal(_deepEqualUnordered({ a: 1 }, { a: 2 }), false);
  assert.equal(_deepEqualUnordered({ a: 1 }, { a: 1, b: 2 }), false);
});

// ── classifyDomainDebt(G-diff 슬라이스 — 결정론적 구조→의도 발산) ──
t("classifyDomainDebt: active=0 removed>0 should없음 → vanished", () => {
  const f = classifyDomainDebt([{ category_id: 1, key: "d1", name: "도메인1", should: null, active_units: 0, removed_units: 3, active_commits: 0 }]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "vanished");
  assert.match(f[0].title, /구조 증발/);
});
t("classifyDomainDebt: active>0 removed>0 → eroded", () => {
  const f = classifyDomainDebt([{ category_id: 2, key: "d2", name: "도메인2", should: null, active_units: 4, removed_units: 1, active_commits: 0 }]);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "eroded");
  assert.match(f[0].title, /구조 침식/);
});
t("classifyDomainDebt: removed=0 should없음 → 부채 아님(빈 배열)", () => {
  const f = classifyDomainDebt([
    { category_id: 3, key: "d3", name: "도메인3", should: null, active_units: 6, removed_units: 0, active_commits: 0 },
    { category_id: 4, key: "d4", name: "도메인4", should: null, active_units: 0, removed_units: 0, active_commits: 0 },
  ]);
  assert.equal(f.length, 0);
});
// P5: should 선언 + active=0 → should_no_is(의도-구조 괴리). removed 유무 무관(should-only 도 잡음).
t("classifyDomainDebt: should선언 active=0 → should_no_is(removed 0/>0 모두)", () => {
  const f = classifyDomainDebt([
    { category_id: 5, key: "d5", name: "도메인5", should: "이 도메인은 X를 해야 한다", active_units: 0, removed_units: 0, active_commits: 0 },
    { category_id: 6, key: "d6", name: "도메인6", should: "Y 의도", active_units: 0, removed_units: 2, active_commits: 1 },
  ]);
  assert.equal(f.length, 2);
  assert.equal(f[0].severity, "should_no_is");
  assert.match(f[0].title, /의도-구조 괴리/);
  assert.equal(f[1].severity, "should_no_is");
});
t("classifyDomainDebt: should선언이어도 active>0·removed=0 이면 부채 아님", () => {
  const f = classifyDomainDebt([{ category_id: 7, key: "d7", name: "도메인7", should: "의도", active_units: 3, removed_units: 0, active_commits: 0 }]);
  assert.equal(f.length, 0);
});

console.log(`\n${pass} checks passed`);

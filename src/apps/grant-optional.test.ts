// 앱 선택 권한(permissions.optional_scopes) — 사양(A~F) 기반 시험.
//  사양 문장만 보고 썼다(구현을 보지 않음). 항목 번호(A1 · B3 …)는 사양의 번호다.
//  쓰는 예: 필수 db · 선택 code · 도구 store_query(→ db) · repo_refs(→ code) · my_tool(요구 scope 모름).
import { strict as assert } from "node:assert";
import test from "node:test";
import { SCOPES } from "../auth/scopes.js";
import {
  resolveGrant,
  grantableOf,
  grantGap,
  intersectGrantable,
  setToolScopeResolver,
  optionalScopeMissing,
  optionalScopeMessage,
  OPTIONAL_SCOPE_REQUIRED,
} from "./grant.js";
import { parseAppManifest } from "./manifest.js";

type Manifest = ReturnType<typeof parseAppManifest>;
type Grant = ReturnType<typeof resolveGrant>;

function rawManifest(perms: Record<string, unknown>): Record<string, unknown> {
  return { id: "app1", title: "T", version: "1.0.0", permissions: perms };
}
function mani(perms: Record<string, unknown>): Manifest {
  return parseAppManifest(rawManifest(perms));
}
/** 선언 도구 전부(사양 B1 의 permissions.tools + permissions.ext_tools) — 파싱된 매니페스트에서 읽는다. */
function declaredTools(m: Manifest): string[] {
  return [...m.permissions.tools, ...m.permissions.ext_tools];
}
function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}
/** 같은 원소 · 같은 개수(중복이 있으면 길이가 달라 걸린다). 순서는 사양에 없어 보지 않는다. */
function assertSameSet(actual: readonly string[] | undefined, expected: readonly string[], msg?: string): void {
  assert.ok(Array.isArray(actual), `${msg ?? ""} — 배열이 아니다: ${JSON.stringify(actual)}`);
  assert.deepEqual(sorted(actual!), sorted(expected), msg);
}
function assertNoDup(xs: readonly string[], msg: string): void {
  assert.equal(new Set(xs).size, xs.length, `${msg} — 중복이 있다: ${JSON.stringify(xs)}`);
}
function statusOf(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
}
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** fn 이 status 400 오류를 던지는지(그리고 주면 오류 글에 그 글자가 있는지). */
function assert400(fn: () => unknown, msg: string, messageIncludes?: string): void {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  assert.ok(threw, `${msg} — 400 이어야 하는데 던지지 않았다`);
  assert.equal(statusOf(caught), 400, `${msg} — status ${String(statusOf(caught))}: ${messageOf(caught)}`);
  if (messageIncludes !== undefined) {
    assert.ok(messageOf(caught).includes(messageIncludes), `${msg} — 오류 글에 '${messageIncludes}' 가 없다: ${messageOf(caught)}`);
  }
}
/** 판정 결과를 «ok» 또는 «status N» 으로 — 두 입력이 같은 규칙으로 판정되는지 견줄 때. */
function outcome(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return `status ${String(statusOf(e))}`;
  }
}

/** 도구 → 요구 scope: repo_refs → code · store_query → db · 그 밖은 모름(null). */
const RESOLVER = (name: string): string | null => (name === "repo_refs" ? "code" : name === "store_query" ? "db" : null);
function withResolver(fn: () => void): void {
  setToolScopeResolver(RESOLVER);
  try {
    fn();
  } finally {
    setToolScopeResolver(() => null);
  }
}
function withNoResolver(fn: () => void): void {
  setToolScopeResolver(() => null);
  try {
    fn();
  } finally {
    setToolScopeResolver(() => null);
  }
}

// 필수 db · 선택 code · 도구 store_query(db) · repo_refs(code)
const BASE = { scopes: ["db"], optional_scopes: ["code"], tools: ["store_query", "repo_refs"] };
// 선택 scope 둘
const TWO_OPT = { scopes: ["db"], optional_scopes: ["code", "memory"], tools: ["store_query", "repo_refs"] };
/** grantGap · optionalScopeMissing 에 줄 «앱 선언» (grantableOf 모양). */
function declared(): { scopes: string[]; tools: string[]; optional_scopes?: string[] } {
  return { scopes: ["db"], tools: ["store_query", "repo_refs", "my_tool"], optional_scopes: ["code"] };
}

// ── A. 매니페스트 ─────────────────────────────────────────────────────────────
test("A1 optional_scopes 생략 → parseAppManifest 결과에 빈 배열 · 주면 그 배열", () => {
  const omitted = mani({ scopes: ["db"], tools: ["store_query"] });
  assert.ok(Array.isArray(omitted.permissions.optional_scopes), "생략해도 배열");
  assert.deepEqual(omitted.permissions.optional_scopes, []);
  assert.deepEqual(mani({}).permissions.optional_scopes, [], "permissions 가 빈 객체");
  const noPerms = parseAppManifest({ id: "app1", title: "T", version: "1.0.0" });
  assert.deepEqual(noPerms.permissions.optional_scopes, [], "permissions 자체를 생략해도 늘 배열");
  assert.deepEqual(mani({ scopes: ["db"], optional_scopes: [] }).permissions.optional_scopes, []);
  assert.deepEqual(mani(BASE).permissions.optional_scopes, ["code"]);
  assertSameSet(mani(TWO_OPT).permissions.optional_scopes, ["code", "memory"]);
});

test("A2 optional_scopes — 알 수 없는 scope · admin · runtime 은 400 · 앱이 쓸 수 있는 scope 는 된다", () => {
  assert400(() => mani({ optional_scopes: ["bogus"] }), "알 수 없는 scope");
  assert400(() => mani({ optional_scopes: ["admin"] }), "admin");
  assert400(() => mani({ optional_scopes: ["runtime"] }), "runtime");
  assert400(() => mani({ scopes: ["db"], optional_scopes: ["code", "admin"] }), "섞여 있어도 admin 이 있으면");
  assert400(() => mani({ scopes: ["db"], optional_scopes: ["code", "bogus"] }), "섞여 있어도 알 수 없는 scope 가 있으면");
  for (const s of ["items", "context", "db", "memory", "code"]) {
    assert.doesNotThrow(() => mani({ optional_scopes: [s] }), `선택 scope '${s}'`);
  }
});

test("A2 같은 규칙 — permissions.scopes 가 받는 값 · 막는 값과 optional_scopes 가 받는 값 · 막는 값이 같다", () => {
  const candidates: string[] = [...SCOPES, "bogus", "", "CODE"];
  for (const v of candidates) {
    const viaScopes = outcome(() => mani({ scopes: [v] }));
    const viaOptional = outcome(() => mani({ optional_scopes: [v] }));
    assert.equal(viaOptional, viaScopes, `값 ${JSON.stringify(v)}: scopes → ${viaScopes} · optional_scopes → ${viaOptional}`);
  }
});

test("A3 같은 scope 를 scopes 와 optional_scopes 에 함께 두면 400", () => {
  assert400(() => mani({ scopes: ["db"], optional_scopes: ["db"] }), "db 가 양쪽에");
  assert400(() => mani({ scopes: ["db", "memory"], optional_scopes: ["code", "memory"] }), "memory 하나만 겹쳐도");
  assert.doesNotThrow(() => mani({ scopes: ["db", "memory"], optional_scopes: ["code"] }), "겹치지 않으면 된다");
});

test("A4 optional_scopes 의 중복은 한 번으로 줄인다", () => {
  assert.deepEqual(mani({ scopes: ["db"], optional_scopes: ["code", "code"] }).permissions.optional_scopes, ["code"]);
  assertSameSet(mani({ optional_scopes: ["code", "memory", "code", "memory"] }).permissions.optional_scopes, ["code", "memory"]);
});

// ── B. 동의 해소 resolveGrant ──────────────────────────────────────────────────
test("B1 범위를 주지 않으면 — 필수 scope 전부 · 도구 전부 · 선택 scope 는 넣지 않는다", () => {
  const m = mani(BASE);
  const tools = declaredTools(m);
  assert.ok(tools.includes("store_query") && tools.includes("repo_refs"), `시험 전제: 선언 도구 ${JSON.stringify(tools)}`);
  const cases: Array<[string, () => Grant]> = [
    ["requested 생략", () => resolveGrant(m)],
    ["requested {}", () => resolveGrant(m, {})],
    ["requested 의 세 칸이 모두 undefined", () => resolveGrant(m, { scopes: undefined, tools: undefined, optional_scopes: undefined })],
    ["prior null", () => resolveGrant(m, undefined, null)],
    ["prior 빈 동의", () => resolveGrant(m, {}, { scopes: [] })],
    ["prior 에 필수 scope 만", () => resolveGrant(m, undefined, { scopes: ["db"] })],
  ];
  for (const [label, run] of cases) {
    const g = run();
    assertSameSet(g.scopes, ["db"], `${label}: scopes`);
    assertSameSet(g.tools, tools, `${label}: tools`);
  }
});

test("B1 범위를 주지 않으면 — prior 의 scope 가운데 이 판의 선택 scope 는 그대로 넣는다", () => {
  const m = mani(BASE);
  const g = resolveGrant(m, undefined, { scopes: ["db", "code"] });
  assertSameSet(g.scopes, ["db", "code"], "prior 의 code(선택) 를 옮겨 온다");
  assertSameSet(g.tools, declaredTools(m), "도구는 여전히 전부");
  assertSameSet(resolveGrant(m, {}, { scopes: ["db", "code"] }).scopes, ["db", "code"], "requested {} 도 같다");
  assertSameSet(resolveGrant(m, undefined, { scopes: ["code"] }).scopes, ["db", "code"], "prior 에 필수가 없어도 필수 전부 + 옮겨 온 선택");
  const m2 = mani(TWO_OPT);
  assertSameSet(resolveGrant(m2, undefined, { scopes: ["db", "memory"] }).scopes, ["db", "memory"], "prior 에 있던 선택만 — prior 에 없는 선택(code)은 넣지 않는다");
  assertSameSet(resolveGrant(m2, undefined, { scopes: ["db", "code", "memory"] }).scopes, ["db", "code", "memory"]);
});

test("B1 · C1 도구 전부 — 선택 scope 를 요구하는 도구(repo_refs → code)도 든다(도구 → scope 해석이 있어도)", () => {
  withResolver(() => {
    const m = mani(BASE);
    const g = resolveGrant(m);
    assertSameSet(g.scopes, ["db"]);
    assertSameSet(g.tools, declaredTools(m));
    assert.ok(g.tools.includes("repo_refs"), "resolveGrant 결과에 repo_refs");
    const d = grantableOf(rawManifest(BASE));
    assert.ok(d, "읽힌다");
    assertSameSet(d!.tools, declaredTools(m), "grantableOf 도 도구 전부");
  });
});

test("B2 prior 의 scope 가 이 판에서 선택 scope 가 아니면(선언에서 빠졌으면) 옮겨 오지 않는다", () => {
  const prior = { scopes: ["db", "code"] };
  const dropped = mani({ scopes: ["db"], optional_scopes: ["memory"], tools: ["store_query"] });
  assertSameSet(resolveGrant(dropped, undefined, prior).scopes, ["db"], "다음 판에서 code 를 선택에서 뺐다");
  const none = mani({ scopes: ["db"], tools: ["store_query"] });
  assertSameSet(resolveGrant(none, undefined, prior).scopes, ["db"], "선택 권한을 아예 선언하지 않은 판");
  assertSameSet(resolveGrant(mani(BASE), undefined, { scopes: ["db", "items"] }).scopes, ["db"], "선언된 적 없는 scope(items)");
});

test("B3 requested.optional_scopes 를 주면 prior 와 무관하게 정확히 그것을 더한다 · [] 면 하나도 넣지 않는다", () => {
  const m = mani(BASE);
  assertSameSet(resolveGrant(m, { optional_scopes: ["code"] }).scopes, ["db", "code"], "prior 없음");
  assertSameSet(resolveGrant(m, { optional_scopes: ["code"] }, { scopes: ["db"] }).scopes, ["db", "code"], "prior 에 없어도 준 대로");
  assertSameSet(resolveGrant(m, { optional_scopes: [] }, { scopes: ["db", "code"] }).scopes, ["db"], "[] 면 prior 의 code 도 넣지 않는다");
  assertSameSet(resolveGrant(m, { optional_scopes: [] }).scopes, ["db"], "[] · prior 없음");
  assertSameSet(resolveGrant(m, { optional_scopes: ["code", "code"] }).scopes, ["db", "code"], "중복 없이");
  const m2 = mani(TWO_OPT);
  assertSameSet(resolveGrant(m2, { optional_scopes: ["memory"] }, { scopes: ["db", "code"] }).scopes, ["db", "memory"], "prior 의 code 는 옮기지 않고 준 memory 만");
  assertSameSet(resolveGrant(m2, { optional_scopes: ["code", "memory"] }, null).scopes, ["db", "code", "memory"]);
});

test("B4 requested.optional_scopes 에 선택으로 선언되지 않은 scope(필수 scope 포함)가 있으면 400", () => {
  const m = mani(BASE);
  assert400(() => resolveGrant(m, { optional_scopes: ["db"] }), "필수 scope db 를 선택으로");
  assert400(() => resolveGrant(m, { optional_scopes: ["memory"] }), "선언에 없는 memory");
  assert400(() => resolveGrant(m, { optional_scopes: ["code", "memory"] }), "하나라도 선언 밖이면");
  assert400(() => resolveGrant(m, { optional_scopes: ["bogus"] }), "알 수 없는 scope");
  assert400(() => resolveGrant(m, { optional_scopes: ["admin"] }), "admin");
  assert400(() => resolveGrant(m, { optional_scopes: ["memory"] }, { scopes: ["db", "memory"] }), "prior 에 있어도 선언 밖이면");
  assert400(() => resolveGrant(m, { scopes: ["db"], optional_scopes: ["db"] }), "scopes 와 함께 줘도 필수 scope 를 선택으로");
  assert400(() => resolveGrant(mani({ scopes: ["db"], tools: ["store_query"] }), { optional_scopes: ["code"] }), "선택 권한을 선언하지 않은 앱");
});

test("B5 optional_scopes 만 주면(scopes · tools 없음) 기본(필수 전부 · 도구 전부)에 그 선택 scope 를 더한다", () => {
  const m = mani(BASE);
  const g = resolveGrant(m, { optional_scopes: ["code"] });
  assertSameSet(g.scopes, ["db", "code"]);
  assertSameSet(g.tools, declaredTools(m));
  const g2 = resolveGrant(m, { scopes: undefined, tools: undefined, optional_scopes: ["code"] }, { scopes: [] });
  assertSameSet(g2.scopes, ["db", "code"], "scopes · tools 가 undefined");
  assertSameSet(g2.tools, declaredTools(m));
  const m3 = mani({ scopes: ["db", "memory"], optional_scopes: ["code"], tools: ["store_query", "repo_refs"], ext_tools: ["ext__slack__*"] });
  const g3 = resolveGrant(m3, { optional_scopes: ["code"] });
  assertSameSet(g3.scopes, ["db", "memory", "code"], "필수 둘 + 선택");
  assertSameSet(g3.tools, declaredTools(m3), "ext_tools 까지 도구 전부");
});

test("B6 requested.scopes 는 필수 scope 의 부분집합 — 밖이면 400 · 선택 scope 를 scopes 에 넣으면 400 이고 글에 optional_scopes", () => {
  const m = mani({ scopes: ["db", "memory"], optional_scopes: ["code"], tools: ["store_query", "repo_refs"] });
  assertSameSet(resolveGrant(m, { scopes: ["db"] }).scopes, ["db"], "필수의 부분집합 · prior · 선택 요청 없음");
  assertSameSet(resolveGrant(m, { scopes: ["memory"], tools: ["store_query"] }).scopes, ["memory"]);
  assert400(() => resolveGrant(m, { scopes: ["items"] }), "선언 밖 scope");
  assert400(() => resolveGrant(m, { scopes: ["code"] }), "선택 scope 를 scopes 에", "optional_scopes");
  assert400(() => resolveGrant(m, { scopes: ["db", "code"] }), "필수와 함께 넣어도", "optional_scopes");
  assert400(() => resolveGrant(m, { scopes: ["code"] }, { scopes: ["db", "code"] }), "prior 에 있어도", "optional_scopes");
  assert400(() => resolveGrant(m, { scopes: ["code"], optional_scopes: ["code"] }), "optional_scopes 에도 넣었어도 scopes 에 넣으면", "optional_scopes");
  assertSameSet(resolveGrant(m, { scopes: ["db"], optional_scopes: ["code"] }).scopes, ["db", "code"], "scopes 로 좁히고 선택은 optional_scopes 로 더한다");
});

test("B7 requested.tools 규칙은 종전 그대로 — 선언 밖 도구면 400 · 선언 안이면 그대로", () => {
  const m = mani(BASE);
  assert400(() => resolveGrant(m, { tools: ["db_query"] }), "선언 밖 도구");
  assert400(() => resolveGrant(m, { tools: ["db_query"], optional_scopes: ["code"] }), "optional_scopes 와 함께여도 선언 밖 도구면");
  assert.deepEqual(resolveGrant(m, { tools: ["repo_refs"] }).tools, ["repo_refs"]);
  const g = resolveGrant(m, { tools: ["store_query"], optional_scopes: ["code"] });
  assert.deepEqual(g.tools, ["store_query"]);
  assert.ok(g.scopes.includes("code"), `준 선택 scope 는 들어간다: ${JSON.stringify(g.scopes)}`);
  assert.ok(g.scopes.every((s) => s === "db" || s === "code"), `선언 밖 scope 가 없다: ${JSON.stringify(g.scopes)}`);
});

test("B7 도구 규칙은 선언만 본다 — 선택 scope 를 요구하는 도구도 그 선택 scope 없이 요청할 수 있다", () => {
  withResolver(() => {
    const m = mani(BASE);
    assert.deepEqual(resolveGrant(m, { tools: ["repo_refs"], optional_scopes: [] }).tools, ["repo_refs"]);
    assertSameSet(resolveGrant(m, { tools: ["store_query", "repo_refs"] }).tools, ["store_query", "repo_refs"]);
  });
});

test("B8 결과 scopes 에 같은 scope 가 두 번 들지 않는다", () => {
  const m = mani(BASE);
  const cases: Array<[string, () => Grant]> = [
    ["prior 에 필수 · 선택이 겹쳐", () => resolveGrant(m, undefined, { scopes: ["db", "code", "code", "db"] })],
    ["prior 에 필수만", () => resolveGrant(m, undefined, { scopes: ["db"] })],
    ["requested 선택 중복", () => resolveGrant(m, { optional_scopes: ["code", "code"] })],
    ["requested 선택 + prior 선택", () => resolveGrant(m, { optional_scopes: ["code"] }, { scopes: ["db", "code"] })],
    ["requested scopes + 선택 + prior", () => resolveGrant(m, { scopes: ["db"], optional_scopes: ["code"] }, { scopes: ["db", "code"] })],
    ["requested scopes 중복 + 선택", () => resolveGrant(m, { scopes: ["db", "db"], optional_scopes: ["code"] })],
  ];
  for (const [label, run] of cases) assertNoDup(run().scopes, label);
});

test("B9 선택 권한을 선언하지 않은 앱 — 종전과 같은 결과(prior · optional_scopes: [] 를 줘도)", () => {
  const m = mani({ scopes: ["context"], tools: ["knowledge_search"], ext_tools: ["ext__slack__*"] });
  const base = { scopes: ["context"], tools: ["knowledge_search", "ext__slack__*"] };
  assert.deepEqual(resolveGrant(m), base, "요청 미지정 — 종전 시험(grant.test.ts)과 같은 값 · 같은 모양");
  assert.deepEqual(resolveGrant(m, {}), base);
  assert.deepEqual(resolveGrant(m, undefined, null), base);
  assert.deepEqual(resolveGrant(m, undefined, { scopes: ["context", "code", "memory"] }), base, "prior 의 다른 scope 는 옮겨 오지 않는다");
  assert.deepEqual(resolveGrant(m, { optional_scopes: [] }), base, "optional_scopes: [] 만 줘도 기본");
  const m2 = mani({ scopes: ["context", "memory"], tools: ["knowledge_search", "knowledge_get"] });
  const narrow = { scopes: ["context"], tools: ["knowledge_get"] };
  assert.deepEqual(resolveGrant(m2, { scopes: ["context"], tools: ["knowledge_get"] }), narrow);
  assert.deepEqual(resolveGrant(m2, { scopes: ["context"], tools: ["knowledge_get"] }, { scopes: ["context", "memory", "code"] }), narrow, "prior 를 줘도");
  assert.throws(() => resolveGrant(mani({ scopes: ["context"] }), { scopes: ["memory"] }), /scope 'memory' 는 앱 선언/);
  assert.throws(() => resolveGrant(mani({ tools: ["knowledge_get"] }), { tools: ["project_create_v6"] }), /tool 'project_create_v6' 는 앱 선언 밖/);
});

test("B10 범위를 정해 준 동의(scopes 나 tools)에 optional_scopes 가 없으면 선택 scope 를 넣지 않는다 — prior 에 있어도", () => {
  withResolver(() => {
    const m = mani(BASE);
    const prior = { scopes: ["db", "code"] };
    assert.deepEqual(resolveGrant(m, { scopes: ["db"] }, prior).scopes, ["db"], "scopes 로 정한 동의");
    const byTools = resolveGrant(m, { tools: ["store_query"] }, prior);
    assert.ok(!byTools.scopes.includes("code"), `tools 로 정한 동의에 code 가 들었다: ${JSON.stringify(byTools.scopes)}`);
    assert.deepEqual(byTools.tools, ["store_query"]);
    assert.deepEqual(resolveGrant(m, { scopes: ["db"], tools: ["store_query"] }, prior), { scopes: ["db"], tools: ["store_query"] }, "scopes · tools 둘 다");
    const byRepoTool = resolveGrant(m, { tools: ["repo_refs"] }, prior);
    assert.ok(!byRepoTool.scopes.includes("code"), `선택 scope 를 요구하는 도구(repo_refs)를 골라도 code 는 붙지 않는다: ${JSON.stringify(byRepoTool.scopes)}`);
    const m2 = mani(TWO_OPT);
    const two = resolveGrant(m2, { scopes: ["db"] }, { scopes: ["db", "code", "memory"] });
    assert.deepEqual(two.scopes, ["db"], "선택이 둘이어도 하나도 넣지 않는다");
  });
});

test("B10 범위를 정해 준 동의에 optional_scopes 를 함께 주면 B3 대로 정확히 그것을 더한다", () => {
  const m = mani(BASE);
  assertSameSet(resolveGrant(m, { scopes: ["db"], optional_scopes: ["code"] }, { scopes: ["db"] }).scopes, ["db", "code"], "prior 에 없어도");
  assertSameSet(resolveGrant(m, { scopes: ["db"], optional_scopes: ["code"] }, null).scopes, ["db", "code"], "prior 없음");
  assertSameSet(resolveGrant(m, { scopes: ["db"], optional_scopes: [] }, { scopes: ["db", "code"] }).scopes, ["db"], "[] 면 prior 에 있어도 넣지 않는다");
  const t = resolveGrant(m, { tools: ["store_query"], optional_scopes: ["code"] }, { scopes: ["db"] });
  assert.ok(t.scopes.includes("code"), `tools 로 정한 동의 + 선택: ${JSON.stringify(t.scopes)}`);
  assert.deepEqual(t.tools, ["store_query"]);
  const m2 = mani(TWO_OPT);
  assertSameSet(resolveGrant(m2, { scopes: ["db"], optional_scopes: ["memory"] }, { scopes: ["db", "code"] }).scopes, ["db", "memory"], "prior 의 code 는 빼고 준 memory 만");
  assertSameSet(resolveGrant(m2, { scopes: ["db"], tools: ["repo_refs"], optional_scopes: ["code", "memory"] }, null).scopes, ["db", "code", "memory"]);
});

// ── C. 앱 선언 grantableOf ─────────────────────────────────────────────────────
test("C1 grantableOf — scopes · tools 는 prior 없는 B1(필수 전부 · 도구 전부) · 선택 scope 는 scopes 에 없다", () => {
  const g = grantableOf(rawManifest(BASE));
  assert.ok(g, "읽힌다");
  const m = mani(BASE);
  const r = resolveGrant(m);
  assert.deepEqual(g!.scopes, r.scopes, "prior 없는 resolveGrant 와 같은 scopes");
  assert.deepEqual(g!.tools, r.tools, "prior 없는 resolveGrant 와 같은 tools");
  assert.deepEqual(g!.scopes, ["db"]);
  assertSameSet(g!.tools, declaredTools(m));
  const g2 = grantableOf(rawManifest(TWO_OPT));
  assert.deepEqual(g2!.scopes, ["db"], "선택이 둘이어도 scopes 엔 필수만");
});

test("C2 grantableOf — 선택 권한을 선언한 앱은 optional_scopes 칸에 그 목록", () => {
  assert.deepEqual(grantableOf(rawManifest(BASE))!.optional_scopes, ["code"]);
  assertSameSet(grantableOf(rawManifest(TWO_OPT))!.optional_scopes, ["code", "memory"]);
});

test("C2 grantableOf — 선언하지 않은 앱은 optional_scopes 칸이 없다(종전 모양 {scopes, tools} 두 칸)", () => {
  const g = grantableOf(rawManifest({ scopes: ["db"], tools: ["store_query"] }));
  assert.ok(g, "읽힌다");
  assert.deepEqual(Object.keys(g!).sort(), ["scopes", "tools"]);
  assert.ok(!("optional_scopes" in g!));
  assert.deepEqual(g, { scopes: ["db"], tools: ["store_query"] });
});

test("C2 grantableOf — optional_scopes: [] 로 적은 앱도 선택 권한이 없으니 칸이 없다", () => {
  const g = grantableOf(rawManifest({ scopes: ["db"], optional_scopes: [], tools: ["store_query"] }));
  assert.ok(g, "읽힌다");
  assert.deepEqual(Object.keys(g!).sort(), ["scopes", "tools"]);
});

test("C3 grantableOf — 매니페스트를 못 읽으면 null(선택 권한 규칙 위반 포함)", () => {
  assert.equal(grantableOf(null), null);
  assert.equal(grantableOf(undefined), null);
  assert.equal(grantableOf("not-a-manifest"), null);
  assert.equal(grantableOf(rawManifest({ scopes: ["db"], optional_scopes: ["admin"] })), null, "A2 admin");
  assert.equal(grantableOf(rawManifest({ scopes: ["db"], optional_scopes: ["bogus"] })), null, "A2 알 수 없는 scope");
  assert.equal(grantableOf(rawManifest({ scopes: ["db"], optional_scopes: ["db"] })), null, "A3 양쪽에 같은 scope");
});

// ── D. 덮지 못한 것 grantGap ───────────────────────────────────────────────────
test("D1 선택 scope 는 동의에 없어도 gap.scopes 에 들지 않는다", () => {
  const grant = { scopes: ["db"], tools: ["store_query", "repo_refs", "my_tool"] };
  withNoResolver(() => {
    assert.deepEqual(grantGap(grant, declared()), { scopes: [], tools: [] }, "도구 해석 없음 · memberScopes 생략");
    assert.deepEqual(grantGap(grant, declared(), ["db", "code"]), { scopes: [], tools: [] }, "도구 해석 없음 · 그 사람이 code 를 가짐");
  });
  withResolver(() => {
    assert.deepEqual(grantGap(grant, declared(), ["db", "code"]), { scopes: [], tools: [] }, "그 사람이 code 를 가짐");
    assert.deepEqual(grantGap(grant, declared()), { scopes: [], tools: [] }, "memberScopes 생략");
    assert.deepEqual(grantGap({ scopes: [], tools: grant.tools }, declared(), ["db", "code"]).scopes, ["db"], "필수(db)만 gap · 선택(code)은 아니다");
    assert.deepEqual(grantGap({ scopes: [], tools: grant.tools }, declared()).scopes, ["db"], "memberScopes 생략이어도 선택(code)은 아니다");
  });
});

test("D2 선택 scope 를 요구하는 도구 — 동의 scopes 에 그 선택 scope 가 없으면 동의 tools 에 없어도 gap.tools 에 들지 않는다", () => {
  withResolver(() => {
    const grant = { scopes: ["db"], tools: ["store_query", "my_tool"] }; // repo_refs(→ code) 없음 · code 없음
    assert.deepEqual(grantGap(grant, declared(), ["db", "code"]), { scopes: [], tools: [] }, "그 사람이 code 를 가져도");
    assert.deepEqual(grantGap(grant, declared(), ["db"]), { scopes: [], tools: [] }, "그 사람이 code 가 없어도");
    assert.deepEqual(grantGap(grant, declared()), { scopes: [], tools: [] }, "memberScopes 를 주지 않아도");
    assert.deepEqual(grantGap(grant, declared(), []), { scopes: [], tools: [] }, "memberScopes 가 비어도");
  });
});

test("D3 동의 scopes 에 그 선택 scope 가 있으면 — 그 도구가 동의 tools 에 없을 때 gap.tools 에 든다", () => {
  withResolver(() => {
    const grant = { scopes: ["db", "code"], tools: ["store_query", "my_tool"] };
    assert.deepEqual(grantGap(grant, declared(), ["db", "code"]), { scopes: [], tools: ["repo_refs"] }, "그 사람이 code 를 가짐");
    assert.deepEqual(grantGap(grant, declared()), { scopes: [], tools: ["repo_refs"] }, "memberScopes 를 주지 않음");
    assert.deepEqual(
      grantGap({ scopes: ["db", "code"], tools: ["store_query", "repo_refs", "my_tool"] }, declared(), ["db", "code"]),
      { scopes: [], tools: [] },
      "그 도구도 동의에 있으면 빔",
    );
  });
});

test("D3 · 배경 — 동의에 선택 scope 가 있어도 그 사람이 그 scope 를 갖지 않으면 그 도구는 gap.tools 에 세지 않는다", () => {
  withResolver(() => {
    const grant = { scopes: ["db", "code"], tools: ["store_query", "my_tool"] };
    assert.deepEqual(grantGap(grant, declared(), ["db"]), { scopes: [], tools: [] });
  });
});

test("D4 필수 scope · 그 밖의 도구는 종전 규칙 — memberScopes 를 주면 그 사람에게 없는 scope · 그 scope 를 요구하는 도구를 뺀다", () => {
  withResolver(() => {
    const empty = { scopes: [], tools: [] };
    let g = grantGap(empty, declared());
    assert.deepEqual(g.scopes, ["db"], "memberScopes 생략 — 동의에 없는 필수 db 는 gap");
    assertSameSet(g.tools, ["store_query", "my_tool"], "memberScopes 생략 — 그 밖의 도구는 gap(repo_refs 는 D2 로 빠짐)");
    g = grantGap(empty, declared(), ["db", "code"]);
    assert.deepEqual(g.scopes, ["db"], "그 사람이 db 를 가짐");
    assertSameSet(g.tools, ["store_query", "my_tool"]);
    g = grantGap(empty, declared(), ["code"]);
    assert.deepEqual(g.scopes, [], "그 사람에게 없는 db 는 뺀다");
    assert.deepEqual(g.tools, ["my_tool"], "db 를 요구하는 store_query 는 빼고 · 요구 scope 모르는 my_tool 은 남는다");
    assert.deepEqual(grantGap(empty, declared(), []), { scopes: [], tools: ["my_tool"] }, "memberScopes 가 비면 요구 scope 모르는 도구만");
  });
});

test("D4 요구 scope 를 모르는 도구(resolver null)는 «그 밖의 도구» — 동의에 없으면 gap.tools 에 든다", () => {
  withNoResolver(() => {
    const g = grantGap({ scopes: [], tools: [] }, declared(), ["code"]);
    assert.deepEqual(g.scopes, [], "그 사람에게 없는 db 는 뺀다");
    assertSameSet(g.tools, ["store_query", "repo_refs", "my_tool"], "요구 scope 를 모르면 걸러 낼 근거가 없다");
  });
});

// ── E. 두 판 견주기 intersectGrantable ─────────────────────────────────────────
test("E1 intersectGrantable — scopes · tools 는 둘 다에 있는 것(a 의 순서)", () => {
  const a = { scopes: ["memory", "db", "items"], tools: ["store_query", "repo_refs", "db_query"], optional_scopes: ["code"] };
  const b = { scopes: ["db", "memory"], tools: ["repo_refs", "store_query"], optional_scopes: ["context"] };
  const r = intersectGrantable(a, b);
  assert.deepEqual(r.scopes, ["memory", "db"]);
  assert.deepEqual(r.tools, ["store_query", "repo_refs"]);
});

test("E1 · E2 — 한 판에선 필수 · 다른 판에선 선택인 scope 는 scopes 에서 빠지고 optional_scopes 에 든다", () => {
  const a = { scopes: ["db", "code"], tools: ["store_query"] };
  const b = { scopes: ["db"], tools: ["store_query"], optional_scopes: ["code"] };
  const r = intersectGrantable(a, b);
  assert.deepEqual(r.scopes, ["db"]);
  assert.deepEqual(r.optional_scopes, ["code"]);
  const r2 = intersectGrantable(b, a);
  assert.deepEqual(r2.scopes, ["db"]);
  assert.deepEqual(r2.optional_scopes, ["code"]);
});

test("E2 optional_scopes 는 어느 한쪽에서라도 선택인 것(합 · 중복 없이)", () => {
  const base = { scopes: ["db"], tools: ["store_query"] };
  assertSameSet(intersectGrantable({ ...base, optional_scopes: ["code"] }, { ...base, optional_scopes: ["memory"] }).optional_scopes, ["code", "memory"]);
  assert.deepEqual(intersectGrantable({ ...base, optional_scopes: ["code"] }, { ...base }).optional_scopes, ["code"], "b 에 칸 없음");
  assert.deepEqual(intersectGrantable({ ...base }, { ...base, optional_scopes: ["code"] }).optional_scopes, ["code"], "a 에 칸 없음");
  assert.deepEqual(intersectGrantable({ ...base, optional_scopes: ["code"] }, { ...base, optional_scopes: [] }).optional_scopes, ["code"], "b 는 빈 목록");
  assert.deepEqual(intersectGrantable({ ...base, optional_scopes: ["code"] }, { ...base, optional_scopes: ["code"] }).optional_scopes, ["code"], "양쪽 같은 것은 한 번");
  assertSameSet(
    intersectGrantable({ ...base, optional_scopes: ["code", "memory"] }, { ...base, optional_scopes: ["memory", "items"] }).optional_scopes,
    ["code", "memory", "items"],
  );
});

test("E2 양쪽 다 선택 scope 가 없으면 optional_scopes 칸이 없다", () => {
  const a = { scopes: ["memory", "db"], tools: ["store_query", "db_query", "ext__slack__send"] };
  const b = { scopes: ["memory"], tools: ["store_*", "ext__slack__*"] };
  const r = intersectGrantable(a, b);
  assert.deepEqual(r, { scopes: ["memory"], tools: ["store_query", "ext__slack__send"] }, "종전(grant.test.ts P14)과 같은 값 · 칸 없음");
  assert.ok(!("optional_scopes" in r));
  assert.ok(!("optional_scopes" in intersectGrantable({ ...a, optional_scopes: [] }, { ...b, optional_scopes: [] })), "양쪽 다 빈 목록");
  assert.ok(!("optional_scopes" in intersectGrantable({ ...a, optional_scopes: [] }, b)), "한쪽 빈 목록 · 한쪽 칸 없음");
});

// ── F. 선택 권한 거절 ──────────────────────────────────────────────────────────
test("F1 need {scope} — 선택 scope · 동의에 없음 · 그 사람이 가짐이면 그 scope 이름 · 하나라도 아니면 null", () => {
  const d = declared();
  assert.equal(optionalScopeMissing(["db"], d, ["db", "code"], { scope: "code" }), "code");
  assert.equal(optionalScopeMissing([], d, ["code"], { scope: "code" }), "code", "동의가 비어도");
  assert.equal(optionalScopeMissing(["db", "code"], d, ["db", "code"], { scope: "code" }), null, "동의에 있음");
  assert.equal(optionalScopeMissing(["db"], d, ["db"], { scope: "code" }), null, "그 사람에게 없음");
  assert.equal(optionalScopeMissing(["db"], d, [], { scope: "code" }), null, "그 사람에게 아무 scope 도 없음");
  assert.equal(optionalScopeMissing([], d, ["db"], { scope: "db" }), null, "필수 scope 는 선택이 아니다");
  assert.equal(optionalScopeMissing(["db"], d, ["db", "memory"], { scope: "memory" }), null, "선언 밖 scope");
  assert.equal(optionalScopeMissing([], { scopes: ["db"], tools: ["store_query"] }, ["db", "code"], { scope: "code" }), null, "선택 권한을 선언하지 않은 앱");
});

test("F1 need {tool} — 그 도구의 요구 scope(resolver)로 같은 판정", () => {
  withResolver(() => {
    const d = declared();
    assert.equal(optionalScopeMissing(["db"], d, ["db", "code"], { tool: "repo_refs" }), "code");
    assert.equal(optionalScopeMissing(["db", "code"], d, ["db", "code"], { tool: "repo_refs" }), null, "동의에 있음");
    assert.equal(optionalScopeMissing(["db"], d, ["db"], { tool: "repo_refs" }), null, "그 사람에게 없음");
    assert.equal(optionalScopeMissing([], d, ["db", "code"], { tool: "store_query" }), null, "요구 scope 가 필수(db)");
  });
});

test("F1 need {tool} — 셋 조건만 본다(그 도구가 declared.tools 에 없어도 요구 scope 가 조건을 채우면 그 이름)", () => {
  setToolScopeResolver((name) => (name === "repo_file" ? "code" : null));
  try {
    assert.equal(optionalScopeMissing(["db"], declared(), ["db", "code"], { tool: "repo_file" }), "code");
  } finally {
    setToolScopeResolver(() => null);
  }
});

test("F2 도구의 요구 scope 를 모르면(resolver 가 null) null", () => {
  withNoResolver(() => {
    assert.equal(optionalScopeMissing([], declared(), ["db", "code"], { tool: "repo_refs" }), null, "resolver 가 아무것도 모름");
  });
  withResolver(() => {
    assert.equal(optionalScopeMissing([], declared(), ["db", "code"], { tool: "my_tool" }), null, "resolver 가 그 도구만 모름");
  });
});

test("F3 optionalScopeMessage — 앱 id · scope · (주면) 도구 · optional_scopes 가 글자 그대로 · «동의» · grant 는 없다", () => {
  const cases: Array<[string, string[]]> = [
    [optionalScopeMessage("crm-app", "code", "repo_refs"), ["crm-app", "code", "repo_refs", "optional_scopes"]],
    [optionalScopeMessage("crm-app", "code"), ["crm-app", "code", "optional_scopes"]],
    [optionalScopeMessage("policy", "memory", "store_query"), ["policy", "memory", "store_query", "optional_scopes"]],
    [optionalScopeMessage("policy", "memory"), ["policy", "memory", "optional_scopes"]],
  ];
  for (const [msg, needles] of cases) {
    assert.equal(typeof msg, "string");
    for (const s of needles) assert.ok(msg.includes(s), `'${s}' 가 없다: ${msg}`);
    assert.ok(!msg.includes("동의"), `«동의» 가 있다: ${msg}`);
    assert.ok(!/grant/i.test(msg), `grant 가 있다: ${msg}`);
  }
});

test("F3b 앱 id 나 도구 이름에 «동의» · grant(대소문자 무시)가 들어 있어도 — scope · optional_scopes 는 있고 «동의» · grant 는 없다", () => {
  // [설명, 앱 id, scope, 도구]
  const cases: Array<[string, string, string, string | undefined]> = [
    ["앱 id 에 grant", "grants-tracker", "code", "repo_refs"],
    ["앱 id 에 grant · 도구 없음", "grants-tracker", "code", undefined],
    ["도구 이름에 grant", "crm-app", "code", "me_app_grant"],
    ["둘 다 grant", "grants-tracker", "memory", "me_app_grant"],
    ["대소문자 무시 — 앱 id 에 Grant", "Grant-Board", "code", "store_query"],
    ["대소문자 무시 — 도구 이름에 GrAnT", "crm-app", "memory", "list_GrAnTs"],
    ["대소문자 무시 — 앱 id 에 GRANT · 도구 없음", "MY-GRANT-APP", "memory", undefined],
    ["도구 이름에 «동의»", "crm-app", "code", "동의_확인"],
    ["앱 id 에 «동의» · 도구 없음", "동의-관리", "code", undefined],
    ["앱 id 에 «동의» · 도구 이름에 grant", "동의-관리", "memory", "me_app_grant"],
  ];
  for (const [label, appId, scope, tool] of cases) {
    const msg = tool === undefined ? optionalScopeMessage(appId, scope) : optionalScopeMessage(appId, scope, tool);
    assert.equal(typeof msg, "string", label);
    assert.ok(msg.includes(scope), `${label}: scope '${scope}' 가 없다: ${msg}`);
    assert.ok(msg.includes("optional_scopes"), `${label}: optional_scopes 가 없다: ${msg}`);
    assert.ok(!msg.includes("동의"), `${label}: «동의» 가 있다: ${msg}`);
    assert.ok(!/grant/i.test(msg), `${label}: grant 가 있다: ${msg}`);
  }
});

test("F3b (해석: «그 이름들» = 걸리는 이름만) 다른 쪽 이름이 깨끗하면 그 이름은 F3 대로 글자 그대로 남는다", () => {
  const appTainted = optionalScopeMessage("grants-tracker", "code", "repo_refs");
  assert.ok(appTainted.includes("repo_refs"), `앱 id 만 걸림 — 도구 이름은 남아야: ${appTainted}`);
  const toolTainted = optionalScopeMessage("crm-app", "code", "me_app_grant");
  assert.ok(toolTainted.includes("crm-app"), `도구 이름만 걸림 — 앱 id 는 남아야: ${toolTainted}`);
});

test("F4 OPTIONAL_SCOPE_REQUIRED === 'optional_scope_required'", () => {
  assert.equal(OPTIONAL_SCOPE_REQUIRED, "optional_scope_required");
});

// ── 배경의 시나리오: 앱이 선택 권한만 더하면 다른 사람은 다시 동의하지 않는다 ───────────
test("시나리오 — 앱이 선택 scope(code)와 그 도구만 더한 새 판: 옛 동의는 그대로 덮고, 필요한 사람만 선택을 받는다", () => {
  withResolver(() => {
    const v1 = { scopes: ["db"], tools: ["store_query"] };
    const v2 = { scopes: ["db"], optional_scopes: ["code"], tools: ["store_query", "repo_refs"] };
    const oldGrant = resolveGrant(mani(v1)); // 동의 창으로 v1 에 동의
    const d2 = grantableOf(rawManifest(v2));
    assert.ok(d2, "v2 읽힌다");
    // code 를 가진 구성원도 다시 동의할 필요가 없다(D1 · D2)
    assert.deepEqual(grantGap(oldGrant, d2!, ["db", "code"]), { scopes: [], tools: [] }, "code 가진 구성원");
    assert.deepEqual(grantGap(oldGrant, d2!, ["db"]), { scopes: [], tools: [] }, "code 없는 구성원");
    // 정기 작업을 도는 관리자가 repo_refs 를 부르면 선택 권한 거절(F1)
    assert.equal(optionalScopeMissing(oldGrant.scopes, d2!, ["db", "code"], { tool: "repo_refs" }), "code");
    // 관리자만 선택을 받는다(B3 · B5)
    const adminGrant = resolveGrant(mani(v2), { optional_scopes: ["code"] }, oldGrant);
    assertSameSet(adminGrant.scopes, ["db", "code"]);
    assert.deepEqual(grantGap(adminGrant, d2!, ["db", "code"]), { scopes: [], tools: [] }, "받은 뒤 빈칸 없음");
    assert.equal(optionalScopeMissing(adminGrant.scopes, d2!, ["db", "code"], { tool: "repo_refs" }), null, "받은 뒤 거절 없음");
    // 그 뒤 범위 없이 다시 동의해도(동의 창) 선택은 남는다(B1)
    assertSameSet(resolveGrant(mani(v2), undefined, adminGrant).scopes, ["db", "code"]);
  });
});

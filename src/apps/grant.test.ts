import { strict as assert } from "node:assert";
import test from "node:test";
import { toolMatchesGlob, toolAllowed, resolveGrant } from "./grant.js";
import { parseAppManifest } from "./manifest.js";

function mani(perms: Record<string, unknown>): ReturnType<typeof parseAppManifest> {
  return parseAppManifest({ id: "app1", title: "T", version: "1.0.0", permissions: perms });
}

// ── 글롭 매칭 ─────────────────────────────────────────────────────────────────
test("리터럴 매치", () => {
  assert.ok(toolMatchesGlob("knowledge_search", "knowledge_search"));
  assert.ok(!toolMatchesGlob("knowledge_search", "knowledge_get"));
});

test("접미 글롭 ext__slack__*", () => {
  assert.ok(toolMatchesGlob("ext__slack__*", "ext__slack__send"));
  assert.ok(toolMatchesGlob("ext__slack__*", "ext__slack__")); // * 는 빈 문자열도 매치
  assert.ok(!toolMatchesGlob("ext__slack__*", "ext__notion__read"));
});

test("중간 글롭 + 대소문자 무시", () => {
  assert.ok(toolMatchesGlob("ext__*__send", "ext__slack__send"));
  assert.ok(toolMatchesGlob("KNOWLEDGE_*", "knowledge_search"));
});

test("글롭 특수문자 이스케이프(정규식 인젝션 방지) — * 포함 글롭에서 '.' 는 리터럴", () => {
  // escapeRe 가 없으면 '.' 가 정규식 임의문자가 돼 'a.*' 가 'axb' 에 잘못 매치된다.
  //  escapeRe 가 있으면 'a\..*' 라 '.' 로 시작하는 것만 매치.
  assert.ok(!toolMatchesGlob("a.*", "axb"), "'.' 가 리터럴이면 'axb' 는 'a.*' 에 매치 안 됨");
  assert.ok(toolMatchesGlob("a.*", "a.xyz"));
  // 리터럴(무 글롭) 경로도 확인.
  assert.ok(!toolMatchesGlob("a.b", "axb"));
  assert.ok(toolMatchesGlob("a.b", "a.b"));
});

test("toolAllowed: 여러 글롭 중 하나라도 매치", () => {
  assert.ok(toolAllowed(["knowledge_get", "ext__slack__*"], "ext__slack__send"));
  assert.ok(!toolAllowed(["knowledge_get", "ext__slack__*"], "project_create_v6"));
});

// ── resolveGrant ──────────────────────────────────────────────────────────────
test("요청 미지정 → 매니페스트 전체(상한) 부여", () => {
  const m = mani({ scopes: ["context"], tools: ["knowledge_search"], ext_tools: ["ext__slack__*"] });
  const g = resolveGrant(m);
  assert.deepEqual(g.scopes, ["context"]);
  assert.deepEqual(g.tools, ["knowledge_search", "ext__slack__*"]);
});

test("요청 부분집합 → 좁혀서 부여", () => {
  const m = mani({ scopes: ["context", "memory"], tools: ["knowledge_search", "knowledge_get"] });
  const g = resolveGrant(m, { scopes: ["context"], tools: ["knowledge_get"] });
  assert.deepEqual(g.scopes, ["context"]);
  assert.deepEqual(g.tools, ["knowledge_get"]);
});

test("요청 scope 가 선언 밖 → 거부(넓힘 방지)", () => {
  const m = mani({ scopes: ["context"] });
  assert.throws(() => resolveGrant(m, { scopes: ["memory"] }), /scope 'memory' 는 앱 선언/);
});

test("요청 tool 이 선언 밖 → 거부", () => {
  const m = mani({ tools: ["knowledge_get"] });
  assert.throws(() => resolveGrant(m, { tools: ["project_create_v6"] }), /tool 'project_create_v6' 는 앱 선언 밖/);
});

test("요청 리터럴 tool 이 선언 글롭에 매치 → 허용", () => {
  const m = mani({ ext_tools: ["ext__slack__*"] });
  const g = resolveGrant(m, { tools: ["ext__slack__send"] });
  assert.deepEqual(g.tools, ["ext__slack__send"]);
});

test("요청 글롭 tool 은 선언에 정확히 그 글롭이 있어야(넓힘 보수)", () => {
  const m = mani({ ext_tools: ["ext__slack__*"] });
  assert.doesNotThrow(() => resolveGrant(m, { tools: ["ext__slack__*"] }));
  // 더 넓은 글롭 요청은 거부
  assert.throws(() => resolveGrant(m, { tools: ["ext__*"] }), /글롭 tool 'ext__\*' 는 앱 선언에 없/);
});

test("선언 빈 앱에 tool 요청 → 거부", () => {
  const m = mani({});
  assert.throws(() => resolveGrant(m, { tools: ["knowledge_get"] }), /앱 선언/);
});

// #4225 — 옛 동의(앱이 갱신돼 새 도구를 얻었다)면 «다시 동의» 로 풀리고, 선언 밖이면 다시 동의해도 안 풀린다.
test("needsRegrant — 선언엔 있고 동의엔 없음 → 참 · 동의에 있음 → 거짓 · 선언 밖 → 거짓 · 글롭 선언도 본다", async () => {
  const { needsRegrant } = await import("./grant.js");
  assert.equal(needsRegrant(["knowledge_get"], ["knowledge_get", "store_query"], "store_query"), true);
  assert.equal(needsRegrant(["knowledge_get", "store_query"], ["knowledge_get", "store_query"], "store_query"), false);
  assert.equal(needsRegrant(["knowledge_get"], ["knowledge_get"], "store_query"), false);
  assert.equal(needsRegrant([], ["store_*"], "store_delete"), true);
  assert.equal(needsRegrant(["store_*"], ["store_*"], "store_delete"), false);
});

// ── #1644 동의가 앱의 지금 선언을 덮나(사양 표 P1~P14) ─────────────────────────────────
//  이게 틀리면: 앱이 동의 뒤에 얻은 권한을 «다시 동의» 로 알리지 못하거나(앱 서버 «권한 밖» · 작업 AI 에서 조용히 빠짐),
//  다시 동의해도 못 얻는 scope 를 계속 묻거나(구성원에게 없는 scope), 이미 덮은 글롭을 못 덮었다고 막는다.
test("P1~P4 grantGap — 같음 → 빔 · 도구만 새로 → 도구 · scope 만 새로(구성원 가짐) → scope · 구성원에게 없는 scope → 묻지 않음", async () => {
  const { grantGap, grantGapEmpty } = await import("./grant.js");
  const declared = { scopes: ["memory", "db"], tools: ["store_query", "db_query"] };
  const full = grantGap({ scopes: ["memory", "db"], tools: ["store_query", "db_query"] }, declared, ["memory", "db"]);
  assert.deepEqual(full, { scopes: [], tools: [] }); assert.equal(grantGapEmpty(full), true);
  assert.deepEqual(grantGap({ scopes: ["memory", "db"], tools: ["store_query"] }, declared, ["memory", "db"]), { scopes: [], tools: ["db_query"] });
  const scopeOnly = grantGap({ scopes: ["memory"], tools: ["store_query", "db_query"] }, declared, ["memory", "db"]);
  assert.deepEqual(scopeOnly, { scopes: ["db"], tools: [] }); assert.equal(grantGapEmpty(scopeOnly), false);
  const noDb = grantGap({ scopes: ["memory"], tools: ["store_query", "db_query"] }, declared, ["memory"]);
  assert.deepEqual(noDb, { scopes: [], tools: [] }, "구성원에게 없는 scope 는 다시 동의해도 못 얻는다");
});

test("P5~P7 글롭 — 같은 글롭 · 더 넓은 글롭은 덮고, 그 글롭에 맞는 리터럴만으로는 글롭을 못 덮는다", async () => {
  const { grantGap } = await import("./grant.js");
  const declared = { scopes: [], tools: ["ext__slack__*"] };
  assert.deepEqual(grantGap({ scopes: [], tools: ["ext__slack__*"] }, declared).tools, []);
  assert.deepEqual(grantGap({ scopes: [], tools: ["ext__slack__send"] }, declared).tools, ["ext__slack__*"]);
  assert.deepEqual(grantGap({ scopes: [], tools: ["ext__*"] }, declared).tools, []);
});

test("P8 · P9 grantableOf — 함의 도구까지 동의 창이 주는 것과 같다 · 못 읽는 매니페스트는 null", async () => {
  const { grantableOf } = await import("./grant.js");
  const g = grantableOf({ id: "app1", title: "T", version: "1.0.0", permissions: { scopes: ["memory"], tools: ["store_query"], ai_runs: true } });
  assert.ok(g, "읽힌다");
  assert.deepEqual(g!.scopes, ["memory"]);
  for (const t of ["store_query", "app_ai_run", "app_ai_run_get", "app_ai_runs", "app_ai_run_cancel", "app_ai_targets"]) assert.ok(g!.tools.includes(t), t);
  assert.deepEqual(g, resolveGrant(mani({ scopes: ["memory"], tools: ["store_query"], ai_runs: true })), "동의 창(요청 없는 resolveGrant)과 같은 것");
  assert.equal(grantableOf({ id: "app1", title: "T", version: "1.0.0", permissions: { scopes: ["admin"] } }), null, "앱이 요청할 수 없는 scope — 파서가 막는다");
  assert.equal(grantableOf(null), null);
  assert.equal(grantableOf("not-a-manifest"), null);
});

test("P10 · P11 새로 도입한 값이 빈 경우 — memberScopes 생략이면 scope 를 거르지 않는다 · 빈 선언 · 빈 동의는 빔", async () => {
  const { grantGap, grantGapEmpty } = await import("./grant.js");
  assert.deepEqual(grantGap({ scopes: [], tools: [] }, { scopes: ["db"], tools: [] }).scopes, ["db"]);
  assert.deepEqual(grantGap({ scopes: [], tools: [] }, { scopes: ["db"], tools: [] }, []).scopes, [], "구성원이 아무 scope 도 없으면 묻지 않는다");
  assert.equal(grantGapEmpty(grantGap({ scopes: [], tools: [] }, { scopes: [], tools: [] }, [])), true);
});

test("P12 describeGrantGap 경계 — 정확히 max 개면 «외» 없음 · max+1 개면 «외 1개» · scope 와 도구는 따로 · 빔은 빈 글", async () => {
  const { describeGrantGap } = await import("./grant.js");
  const five = ["a1", "a2", "a3", "a4", "a5"];
  assert.equal(describeGrantGap({ scopes: [], tools: five }), "도구 a1, a2, a3, a4, a5");
  assert.equal(describeGrantGap({ scopes: [], tools: [...five, "a6"] }), "도구 a1, a2, a3, a4, a5 외 1개");
  assert.equal(describeGrantGap({ scopes: ["db"], tools: ["db_query"] }), "scope db · 도구 db_query");
  assert.equal(describeGrantGap({ scopes: ["db"], tools: [] }), "scope db");
  assert.equal(describeGrantGap({ scopes: [], tools: [] }), "");
});

test("P13 scopeNeedsRegrant — 동의에 있음 · 선언 밖 · 구성원에게 없음은 거짓 · 셋 다 아니면 참", async () => {
  const { scopeNeedsRegrant } = await import("./grant.js");
  assert.equal(scopeNeedsRegrant(["db"], ["db"], "db", ["db"]), false, "이미 동의함 — 다른 까닭으로 막혔다");
  assert.equal(scopeNeedsRegrant([], ["memory"], "db", ["db"]), false, "선언 밖 — 다시 동의해도 못 얻는다(종전 «권한 밖»)");
  assert.equal(scopeNeedsRegrant([], ["db"], "db", ["memory"]), false, "구성원에게 없다 — 다시 동의해도 못 얻는다");
  assert.equal(scopeNeedsRegrant(["memory"], ["memory", "db"], "db", ["memory", "db"]), true);
});

test("P14 intersectGrantable — 다시 동의로 못 얻는 것(한쪽 판에만 있는 것)은 빠진다 · 도구는 글롭 덮음으로 본다", async () => {
  const { intersectGrantable } = await import("./grant.js");
  assert.deepEqual(
    intersectGrantable({ scopes: ["memory", "db"], tools: ["store_query", "db_query", "ext__slack__send"] }, { scopes: ["memory"], tools: ["store_*", "ext__slack__*"] }),
    { scopes: ["memory"], tools: ["store_query", "ext__slack__send"] });
});

test("regrantMessage — 앱 화면 다리(#4225)의 글과 같은 꼴 · 웹 호스트가 동의 창을 띄우는 낱말(«동의»)을 품는다", async () => {
  const { regrantMessage, regrantToolPhrase, regrantScopePhrase } = await import("./grant.js");
  assert.equal(regrantMessage("crm", regrantToolPhrase("store_query")), "앱 'crm' 의 사용 동의가 예전 범위라 'store_query' 을 쓸 수 없습니다 — 다시 동의(grant)하면 됩니다");
  assert.match(regrantMessage("crm", regrantScopePhrase("db")), /'db' 권한을 쓸 수 없습니다 — 다시 동의\(grant\)/);
});

//  앱 v2 #124 — 도구도 scope 와 같은 까닭으로: 그 도구가 요구하는 scope 를 그 사람이 갖지 않았으면 다시 동의해도 못 쓰니 빈칸으로 세지 않는다.
//   T1 code 없는 사람 → code 도구는 빈칸 아님 · T2 code 있는 사람 → 빈칸 · T3 등록부에 없는 도구(요구 scope 모름)는 종전대로 빈칸
//   T4 memberScopes 를 주지 않은 판정(설명용)은 종전대로 전부 · T5 도구를 알려 주기 전(기본)은 종전과 같다
test("T1~T5 grantGap — 그 사람이 쓸 수 없는 도구(요구 scope 없음)는 다시 동의 빈칸으로 세지 않는다", async () => {
  const { grantGap, setToolScopeResolver } = await import("./grant.js");
  const declared = { scopes: ["memory", "code"], tools: ["store_query", "repo_file", "my_app_tool"] };
  const grant = { scopes: ["memory"], tools: ["store_query"] };
  try {
    assert.deepEqual(grantGap(grant, declared, ["memory"]), { scopes: [], tools: ["repo_file", "my_app_tool"] }, "T5 알려 주기 전은 종전과 같다");
    setToolScopeResolver((name) => (name === "repo_file" ? "code" : name === "store_query" ? "memory" : null));
    assert.deepEqual(grantGap(grant, declared, ["memory"]), { scopes: [], tools: ["my_app_tool"] }, "T1 · T3");
    assert.deepEqual(grantGap(grant, declared, ["memory", "code"]), { scopes: ["code"], tools: ["repo_file", "my_app_tool"] }, "T2");
    assert.deepEqual(grantGap(grant, declared), { scopes: ["code"], tools: ["repo_file", "my_app_tool"] }, "T4");
  } finally {
    setToolScopeResolver(() => null);
  }
});

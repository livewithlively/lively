// 읽기전용 세션 모드(#1007) 순수 로직 검증 — DB 없이, 사양(spec.md) 기준.
// 프레임워크 없음: 컴파일된 스크립트로 실행, assert throw = 실패.
import assert from "node:assert/strict";
import { registry, capMutates, isReadOnlyBlocked, READONLY_KEEP, registerMcpCapabilities } from "./index.js";
import { readOnlyFromHeaders } from "../org/agent-identity.js";
import type { Capability } from "./types.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 합성(synthetic) capability/마운트 빌더 ────────────────────────────────
const POST_MOUNT = { method: "POST" as const, paths: ["/x"], parse: () => ({}) };
const GET_MOUNT = { method: "GET" as const, paths: ["/y"], parse: () => ({}) };
const synCap = (over: Partial<Capability>): Capability => ({
  name: "syn", title: "t", description: "d", scope: null, input: {},
  expose: { mcp: true, rest: false }, handler: async () => ({}),
  ...over,
} as Capability);

const need = (name: string): Capability => {
  const cap = registry.get(name);
  if (!cap) throw new Error(`registry missing capability: ${name}`);
  return cap;
};

// 사양 §도메인 분류 사실
const WRITES = [
  "knowledge_save", "knowledge_delete", "knowledge_link_category", "knowledge_set_wiki",
  "activity_log", "project_create_v6", "task_create_v6", "task_set_status_v6",
  "category_update", "source_save",
];
const READS = ["knowledge_get", "knowledge_list", "knowledge_grep"];
const POST_BUT_READ = ["recall_route", "project_find_by_origin_v6", "repo_discover", "repo_check", "org_guide_preview"];
const MCP_ONLY_READ = ["context_overview", "debt_list", "source_artifact"];
const KEEP = ["broker_run", "delegate_run", "delegate_cancel"];

// ── §신호: readOnlyFromHeaders — opt-in fail-safe ───────────────────────────
t("readOnlyFromHeaders: 명시 참값(1/true/on/yes)만 읽기전용을 켠다", () => {
  for (const v of ["1", "true", "on", "yes"]) {
    assert.equal(readOnlyFromHeaders({ "x-lively-readonly": v }), true, `expected truthy: ${v}`);
  }
});

t("readOnlyFromHeaders: 대소문자 무관 + 앞뒤 공백 허용", () => {
  for (const v of ["TRUE", "True", "ON", "Yes", "  true  ", "\tyes\n", " 1 ", "YES"]) {
    assert.equal(readOnlyFromHeaders({ "x-lively-readonly": v }), true, `expected truthy: ${JSON.stringify(v)}`);
  }
});

t("readOnlyFromHeaders: 거짓 값들은 정상(쓰기 허용)", () => {
  for (const v of ["", "0", "false", "off", "no", "   ", "\t", "maybe", "readonly", "readOnly", "2"]) {
    assert.equal(readOnlyFromHeaders({ "x-lively-readonly": v }), false, `expected falsy: ${JSON.stringify(v)}`);
  }
});

t("readOnlyFromHeaders: 헤더 미존재/undefined/다른 헤더 → false", () => {
  assert.equal(readOnlyFromHeaders({}), false);
  assert.equal(readOnlyFromHeaders(undefined), false);
  assert.equal(readOnlyFromHeaders({ "content-type": "true" }), false);
});

t("readOnlyFromHeaders: 미확장 셸 리터럴 ${LIVELY_READONLY:-} 은 정상(fail-safe)", () => {
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": "${LIVELY_READONLY:-}" }), false);
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": "${LIVELY_READONLY}" }), false);
});

t("readOnlyFromHeaders: 배열(중복 헤더)이면 첫 번째 값으로 판정", () => {
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": ["true", "false"] }), true);
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": ["false", "true"] }), false);
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": ["1"] }), true);
  assert.equal(readOnlyFromHeaders({ "x-lively-readonly": ["", "true"] }), false);
});

// ── §분류: capMutates — 명시 > POST/GET 파생 > fail-closed ────────────────
t("capMutates: 명시 mutates=true 는 GET-only 마운트를 덮어써 쓰기", () => {
  assert.equal(capMutates(synCap({ mutates: true, expose: { mcp: true, rest: [GET_MOUNT] } })), true);
});

t("capMutates: 명시 mutates=false 는 POST 마운트를 덮어써 읽기", () => {
  assert.equal(capMutates(synCap({ mutates: false, expose: { mcp: true, rest: [POST_MOUNT] } })), false);
});

t("capMutates: 명시 없으면 POST 마운트 하나라도 있으면 쓰기(파생)", () => {
  assert.equal(capMutates(synCap({ expose: { mcp: true, rest: [POST_MOUNT] } })), true);
  assert.equal(capMutates(synCap({ expose: { mcp: true, rest: [GET_MOUNT, POST_MOUNT] } })), true);
});

t("capMutates: 명시 없고 전부 GET 이면 읽기(파생)", () => {
  assert.equal(capMutates(synCap({ expose: { mcp: true, rest: [GET_MOUNT] } })), false);
  assert.equal(capMutates(synCap({ expose: { mcp: false, rest: [GET_MOUNT, GET_MOUNT] } })), false);
});

t("capMutates: REST 마운트 없고 명시도 없으면 fail-closed=쓰기", () => {
  assert.equal(capMutates(synCap({ expose: { mcp: true, rest: false } })), true);
});

t("capMutates: MCP전용 읽기는 mutates:false 를 명시해야 읽기로 판정", () => {
  assert.equal(capMutates(synCap({ mutates: false, expose: { mcp: true, rest: false } })), false);
});

// ── §레지스트리 도메인 사실 (스팟 체크) ─────────────────────────────────────
t("registry: 대표 쓰기 툴들이 존재하고 capMutates=true", () => {
  for (const name of WRITES) assert.equal(capMutates(need(name)), true, `${name} should mutate`);
});

t("registry: 대표 읽기 툴들이 존재하고 capMutates=false", () => {
  for (const name of READS) assert.equal(capMutates(need(name)), false, `${name} should be read`);
});

t("registry: POST 마운트지만 읽기(mutates:false)인 툴들 capMutates=false", () => {
  for (const name of POST_BUT_READ) assert.equal(capMutates(need(name)), false, `${name} should be read despite POST`);
});

t("registry: MCP전용 읽기는 REST 마운트 없고 capMutates=false, 안 막힘", () => {
  for (const name of MCP_ONLY_READ) {
    const cap = need(name);
    assert.equal(cap.expose.rest, false, `${name} should be MCP-only (no REST mount)`);
    assert.equal(capMutates(cap), false, `${name} should be read`);
    assert.equal(isReadOnlyBlocked(cap), false, `${name} must not be blocked`);
  }
});

// ── §차단 예외 정책: isReadOnlyBlocked ────────────────────────────────────
t("isReadOnlyBlocked: 대표 쓰기들은 읽기전용에서 차단", () => {
  for (const name of WRITES) assert.equal(isReadOnlyBlocked(need(name)), true, `${name} should be blocked`);
});

t("isReadOnlyBlocked: 읽기(대표/POST-읽기/MCP전용읽기)는 절대 안 막힘", () => {
  for (const name of [...READS, ...POST_BUT_READ, ...MCP_ONLY_READ]) {
    assert.equal(isReadOnlyBlocked(need(name)), false, `${name} should not be blocked`);
  }
});

t("READONLY_KEEP: 코드실행/오프로드 예외는 (파생)쓰기지만 유지(안 막힘)", () => {
  for (const name of KEEP) {
    const cap = need(name);
    assert.equal(capMutates(cap), true, `${name} is a POST-derived write`);
    assert.equal(isReadOnlyBlocked(cap), false, `${name} should be kept`);
    assert.ok(READONLY_KEEP.has(name), `${name} in READONLY_KEEP`);
  }
});

t("READONLY_KEEP: 집합은 정확히 세 예외뿐", () => {
  assert.deepEqual([...READONLY_KEEP].sort(), ["broker_run", "delegate_cancel", "delegate_run"]);
});

t("isReadOnlyBlocked 로직: write→차단, read→통과, fail-closed→차단, mcp읽기→통과 (합성)", () => {
  assert.equal(isReadOnlyBlocked(synCap({ name: "syn_write", expose: { mcp: true, rest: [POST_MOUNT] } })), true);
  assert.equal(isReadOnlyBlocked(synCap({ name: "syn_read", expose: { mcp: true, rest: [GET_MOUNT] } })), false);
  assert.equal(isReadOnlyBlocked(synCap({ name: "syn_failclosed", expose: { mcp: true, rest: false } })), true);
  assert.equal(isReadOnlyBlocked(synCap({ name: "syn_mcp_read", mutates: false, expose: { mcp: true, rest: false } })), false);
});

t("isReadOnlyBlocked: KEEP 예외는 이름 기반 — KEEP 이름의 합성 쓰기도 면제", () => {
  const cap = synCap({ name: "broker_run", expose: { mcp: true, rest: [POST_MOUNT] } });
  assert.equal(capMutates(cap), true);
  assert.equal(isReadOnlyBlocked(cap), false);
});

// ── §핵심 불변식(회귀 가드) ────────────────────────────────────────────────
const hasPostMount = (cap: Capability): boolean =>
  Array.isArray(cap.expose.rest) && cap.expose.rest.some((m) => m.method === "POST");

t("불변식: POST 마운트인데 읽기전용에서 안 막히는 집합 == 정확히 8개", () => {
  const notBlockedPost = [...registry.values()]
    .filter((cap) => hasPostMount(cap) && !isReadOnlyBlocked(cap))
    .map((cap) => cap.name)
    .sort();
  assert.deepEqual(notBlockedPost, [
    "broker_run", "delegate_cancel", "delegate_run", "org_guide_preview",
    "project_find_by_origin_v6", "recall_route", "repo_check", "repo_discover",
  ]);
});

t("불변식: REST 마운트 없는 MCP전용 capability 는 전부 읽기(안 막힘)", () => {
  const mcpOnly = [...registry.values()].filter((cap) => cap.expose.rest === false);
  assert.ok(mcpOnly.length > 0, "there should be some MCP-only capabilities");
  for (const cap of mcpOnly) {
    assert.equal(isReadOnlyBlocked(cap), false, `MCP-only ${cap.name} must not be fail-closed/blocked`);
  }
});

// ── §MCP 표면 강제: registerMcpCapabilities ───────────────────────────────
const registeredNames = (readOnly: boolean): string[] => {
  const names: string[] = [];
  registerMcpCapabilities({ registerTool: (n: string) => names.push(n) } as never, undefined, undefined, null, readOnly);
  return names;
};

t("registerMcpCapabilities: readOnly=false 는 대표 쓰기 툴들을 등록", () => {
  const names = registeredNames(false);
  for (const w of WRITES) assert.ok(names.includes(w), `readOnly=false should register ${w}`);
});

t("registerMcpCapabilities: readOnly=true 는 차단 대상(쓰기) 툴들을 소거", () => {
  const names = registeredNames(true);
  for (const w of WRITES) assert.ok(!names.includes(w), `readOnly=true should erase ${w}`);
});

t("registerMcpCapabilities: readOnly=true 는 읽기 + 코드실행 툴을 유지", () => {
  const names = registeredNames(true);
  for (const keep of ["knowledge_get", "knowledge_grep", "context_overview", "debt_list", "source_artifact", "broker_run", "delegate_run"]) {
    assert.ok(names.includes(keep), `readOnly=true should keep ${keep}`);
  }
});

t("registerMcpCapabilities: readOnly=true 등록 수 < readOnly=false (실제로 소거됨)", () => {
  assert.ok(registeredNames(true).length < registeredNames(false).length, "read-only must erase something");
});

console.log(`\nreadonly tests: ${pass} passed`);

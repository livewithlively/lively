import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIVELY_LOCAL_TOOL_NAMES, LIVELY_LOCAL_CONFIRM_TOOL_NAMES, CONFIRM_BY_DEFAULT_BUILTINS, resolveAutoApproveToolIds } from "./auto-approve.js";
import { nasFileCapabilities } from "../../capabilities/nas-files.js";

test("Lively 제공 도구는 기본 승인하고 명시 override·외부 정책은 보존한다", () => {
  const candidates = [
    { name: "new_builtin", defaultExposed: true },
    { name: "explicit_on", defaultExposed: true },
    { name: "explicit_off", defaultExposed: true },
    { name: "disabled", defaultExposed: true },
    { name: "hidden", defaultExposed: false },
  ];
  const rows = [
    { name: "explicit_on", kind: "builtin" as const, enabled: true, auto_approve: true, level: null },
    { name: "explicit_off", kind: "builtin" as const, enabled: true, auto_approve: false, level: null },
    { name: "disabled", kind: "builtin" as const, enabled: false, auto_approve: true, level: null },
    { name: "proxy_on", kind: "http_proxy" as const, enabled: true, auto_approve: true, level: "L1" as const },
    { name: "proxy_off", kind: "http_proxy" as const, enabled: true, auto_approve: false, level: "L1" as const },
    { name: "proxy_l2", kind: "http_proxy" as const, enabled: true, auto_approve: true, level: "L2" as const },
  ];

  const got = resolveAutoApproveToolIds(candidates, rows);
  assert.ok(got.includes("mcp__lively__new_builtin"), "행 없는 새 builtin은 즉시 기본 승인");
  assert.ok(got.includes("mcp__lively__explicit_on"));
  assert.ok(!got.includes("mcp__lively__explicit_off"), "운영자의 명시적 해제 보존");
  assert.ok(!got.includes("mcp__lively__disabled"), "비활성 도구는 전달하지 않음");
  assert.ok(!got.includes("mcp__lively__hidden"), "기본 미노출 도구는 전달하지 않음");
  assert.ok(got.includes("mcp__lively__proxy_on"), "기존 조직 프록시 승인 정책 보존");
  assert.ok(!got.includes("mcp__lively__proxy_off"));
  assert.ok(!got.includes("mcp__lively__proxy_l2"), "L2 강제 확인 정책 보존");
  for (const name of LIVELY_LOCAL_TOOL_NAMES) {
    if (!LIVELY_LOCAL_CONFIRM_TOOL_NAMES.has(name)) assert.ok(got.includes(`mcp__lively-local__${name}`), name);
  }
  assert.equal(got.length, new Set(got).size, "중복 없음");
  assert.deepEqual(got, [...got].sort(), "결정적 정렬");
});

test("lively-local 기본 승인 목록은 실제 TOOLS 배열과 일치한다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../kit/cli/lively-mcp-local.mjs", import.meta.url)), "utf8");
  const actual = [...src.matchAll(/^\s*name: "(lively_local_[^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(actual, [...LIVELY_LOCAL_TOOL_NAMES].sort());
});

// NAS 에 쓰는 도구는 사람 확인을 받는다 — NAS 문서에 심은 지시가 승인 없이 로컬 파일을 올리거나 NAS 파일을 지우지 못하게.
test("NAS 올리기·조작 도구는 기본 자동승인에서 빠지고, 운영자가 명시로 켤 때만 builtin 이 승인된다", () => {
  const candidates = [{ name: "nas_manage", defaultExposed: true }, { name: "nas_list", defaultExposed: true }];
  const got = resolveAutoApproveToolIds(candidates, []);
  assert.ok(!got.includes("mcp__lively-local__lively_local_nas_push"), "로컬 올리기는 자동승인 아님");
  assert.ok(!got.includes("mcp__lively__nas_manage"), "지우기·옮기기는 기본 자동승인 아님");
  assert.ok(got.includes("mcp__lively__nas_list"), "읽기 도구는 그대로");
  assert.ok(got.includes("mcp__lively-local__lively_local_nas_pull"), "받기는 그대로");
  const optIn = resolveAutoApproveToolIds(candidates, [{ name: "nas_manage", kind: "builtin", enabled: true, auto_approve: true, level: null }]);
  assert.ok(optIn.includes("mcp__lively__nas_manage"), "운영자의 명시 행은 존중");
});

test("사람 확인 목록의 이름은 실제 도구다(오타로 조용히 자동승인되지 않게)", () => {
  for (const name of LIVELY_LOCAL_CONFIRM_TOOL_NAMES) assert.ok((LIVELY_LOCAL_TOOL_NAMES as readonly string[]).includes(name), name);
  const builtins = new Set(nasFileCapabilities.map((c) => c.name));
  for (const name of CONFIRM_BY_DEFAULT_BUILTINS) assert.ok(builtins.has(name), name);
});

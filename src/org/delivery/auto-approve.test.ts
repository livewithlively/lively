import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIVELY_LOCAL_TOOL_NAMES, resolveAutoApproveToolIds } from "./auto-approve.js";

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
  for (const name of LIVELY_LOCAL_TOOL_NAMES) assert.ok(got.includes(`mcp__lively-local__${name}`));
  assert.equal(got.length, new Set(got).size, "중복 없음");
  assert.deepEqual(got, [...got].sort(), "결정적 정렬");
});

test("lively-local 기본 승인 목록은 실제 TOOLS 배열과 일치한다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../kit/cli/lively-mcp-local.mjs", import.meta.url)), "utf8");
  const actual = [...src.matchAll(/^\s*name: "(lively_local_[^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(actual, [...LIVELY_LOCAL_TOOL_NAMES].sort());
});

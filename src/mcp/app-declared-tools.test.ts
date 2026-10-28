// 앱이 선언한 MCP 도구(#5050 앱 v2-40) — 누구의 목록에 어느 판의 도구가 서나(listedAppsFor · 순수 판정). DB 를 지나는 끝단은 app-declared-tools.pg-test.mjs.
//  L1 공개 앱 · L2 초안 걸린 공개 앱(만든 사람 = 초안 · 남 = 공개 판) · L2b 공개 판 행 없음 · L3 나만 보는 앱(책임자만 — 관리자에게도 안 선다) ·
//  L4 기본 앱 · 빈 예약 · L5 읽기 전용(L0 만) · L6 실행기 없는 kind · L7 선언 0개
import assert from "node:assert/strict";
import { listedAppsFor } from "./app-declared-tools.js";
import { registerAppMcpExecutor } from "../apps/app-mcp-executors.js";
import type { McpToolAppRow } from "../apps/app-mcp-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
registerAppMcpExecutor({ kind: "echo", call: async () => ({ data: null }) });

const decl = (name: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ name, description: `${name} 설명`, run: { kind: "echo" }, ...o });
const row = (o: Partial<McpToolAppRow> & { id: string }): McpToolAppRow => ({
  title: o.id, source: { kind: "inline" }, visibility: "all", owner_member: "owner", draft_by: null, published_version_no: 1,
  content_hash: "h1", current_version_no: 1, mcp_tools: [decl(`${o.id}_tool`)], ...o,
});
const who = (userId: string, admin = false) => ({ userId, scopes: admin ? ["admin", "memory"] : ["memory"] });
const names = (rows: McpToolAppRow[], u: ReturnType<typeof who>, heads = new Map<string, { title: string; mcp_tools: unknown }>(), readOnly = false): string[] =>
  listedAppsFor(rows, heads, u, readOnly).flatMap((a) => a.decls.map((d) => `${a.row.id}:${d.name}`));

t("L1 초안 없는 공개 앱 — 누구에게나 설치된 판의 도구", () => {
  const rows = [row({ id: "crm" })];
  for (const u of [who("alice"), who("owner"), who("boss", true)]) assert.deepEqual(names(rows, u), ["crm:crm_tool"]);
});

t("L2 초안 걸린 공개 앱 — 초안 만든 사람은 초안의 도구, 남은 공개 판의 도구(이름표도 그 판)", () => {
  const rows = [row({ id: "wiki", draft_by: "drafter", published_version_no: 3, mcp_tools: [decl("draft_only"), decl("shared", { description: "초안 설명" })] })];
  const heads = new Map([["wiki", { title: "공개 판 이름", mcp_tools: [decl("shared", { description: "공개 설명" })] }]]);
  assert.deepEqual(names(rows, who("drafter"), heads), ["wiki:draft_only", "wiki:shared"]);
  const other = listedAppsFor(rows, heads, who("alice"), false);
  assert.deepEqual(other.flatMap((a) => a.decls.map((d) => [d.name, d.description])), [["shared", "공개 설명"]]);
  assert.equal(other[0].title, "공개 판 이름");
  assert.deepEqual(names(rows, who("owner"), heads), ["wiki:shared"], "책임자라도 남이 만든 초안은 공개 판으로 본다");
});

t("L2b 공개 판 행이 없으면(불변식 위반) 설치된 상태의 도구로 — 앱이 사라지는 쪽으로 틀리지 않는다", () => {
  const rows = [row({ id: "wiki", draft_by: "drafter", published_version_no: 3, mcp_tools: [decl("installed_tool")] })];
  assert.deepEqual(names(rows, who("alice"), new Map()), ["wiki:installed_tool"]);
});

t("L3 나만 보는 앱 — 책임자에게만 선다(다른 구성원 · 관리자에게도 안 선다)", () => {
  const rows = [row({ id: "mine", visibility: "me", owner_member: "owner", draft_by: null })];
  assert.deepEqual(names(rows, who("owner")), ["mine:mine_tool"]);
  assert.deepEqual(names(rows, who("alice")), []);
  assert.deepEqual(names(rows, who("boss", true)), []);
});

t("L4 기본 앱(덮어쓴 것 포함) · 빈 예약은 서지 않는다", () => {
  const rows = [
    row({ id: "builtin", source: { kind: "builtin" } }),
    row({ id: "override", source: { kind: "builtin", overrides_builtin: true } }),
    row({ id: "empty", content_hash: null, current_version_no: null }),
    row({ id: "ok" }),
  ];
  assert.deepEqual(names(rows, who("alice")), ["ok:ok_tool"]);
});

t("L5 읽기 전용 연결 — L0 만(level 없으면 L1 로 본다)", () => {
  const rows = [row({ id: "crm", mcp_tools: [decl("read", { level: "L0" }), decl("write", { level: "L1" }), decl("unset")] })];
  assert.deepEqual(names(rows, who("alice"), new Map(), true), ["crm:read"]);
  assert.deepEqual(names(rows, who("alice"), new Map(), false), ["crm:read", "crm:write", "crm:unset"]);
});

t("L6 이 코어에 실행기가 없는 kind 의 도구는 서지 않는다(새 코어에서 깔고 되돌린 앱)", () => {
  const rows = [row({ id: "crm", mcp_tools: [decl("srv", { run: { kind: "server", route: "/x" } }), decl("ok")] })];
  assert.deepEqual(names(rows, who("alice")), ["crm:ok"]);
});

t("L7 선언이 0개(또는 전부 틀림)인 앱은 목록에서 빠진다", () => {
  const rows = [row({ id: "a", mcp_tools: [] }), row({ id: "b", mcp_tools: null }), row({ id: "c", mcp_tools: [{ name: "Bad" }] })];
  assert.deepEqual(listedAppsFor(rows, new Map(), who("alice"), false), []);
});

console.log(`\napp-declared-tools tests: ${pass} passed`);

// 앱이 선언한 MCP 도구(#5050 앱 v2-40) — 누구의 목록에 어느 판의 도구가 서나(listedAppsFor · 판정) · DB 앞에서 끝나는 길. DB 를 지나는 끝단은 app-declared-tools.pg-test.mjs.
//  L1 공개 앱 · L2 초안 걸린 공개 앱(만든 사람 = 초안 · 남 = 공개 판) · L2b 공개 판 행 없음 · L2c 그 경고는 한 번만 · L3 나만 보는 앱(책임자만 — 관리자에게도 안 선다) ·
//  L4 기본 앱 · 빈 예약 · L5 읽기 전용(L0 만) · L6 실행기 없는 kind · L7 선언 0개 ·
//  N1 앱 토큰 · 앱 서버 주체 · scope 없는 토큰은 등록 0(DB 안 봄) · N2 실행기가 하나도 없으면 등록 0(DB 안 봄) · N3 부르기 — 앱 토큰 · 앱 서버 주체 · scope 없음은 DB 앞에서 거절
//  (유닛 러너엔 DB 주소가 없다 — db/client 는 주소가 없으면 곧바로 던지므로, DB 에 닿으면 N1 · N2 · N3 가 빨개진다)
import assert from "node:assert/strict";
import { listedAppsFor, registerAppDeclaredTools, callAppDeclaredTool } from "./app-declared-tools.js";
import { registerAppMcpExecutor } from "../apps/app-mcp-executors.js";
import type { McpToolAppRow } from "../apps/app-mcp-store.js";
import type { LivelyUser } from "../context.js";
import { logger } from "../log.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
let off = registerAppMcpExecutor({ kind: "echo", call: async () => ({ data: null }) });

const decl = (name: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ name, description: `${name} 설명`, run: { kind: "echo" }, ...o });
const row = (o: Partial<McpToolAppRow> & { id: string }): McpToolAppRow => ({
  title: o.id, source: { kind: "inline" }, visibility: "all", owner_member: "owner", draft_by: null, published_version_no: 1,
  content_hash: "h1", current_version_no: 1, mcp_tools: [decl(`${o.id}_tool`)], published: null, ...o,
});
const who = (userId: string, admin = false) => ({ userId, scopes: admin ? ["admin", "memory"] : ["memory"] });
const names = (rows: McpToolAppRow[], u: ReturnType<typeof who>, readOnly = false): string[] =>
  listedAppsFor(rows, u, readOnly).flatMap((a) => a.decls.map((d) => `${a.row.id}:${d.name}`));
const user = (o: Partial<LivelyUser> = {}): LivelyUser => ({ userId: "alice", email: "", scopes: ["memory"], projects: ["*"], ...o });
const fakeServer = () => { const got: string[] = []; return { got, registerTool: (n: string) => { got.push(n); } }; };
const ref = { appId: "crm", name: "crm_tool", contract: "x", readOnly: false };
const extraOf = (u: LivelyUser) => ({ authInfo: { extra: u } });

await t("L1 초안 없는 공개 앱 — 누구에게나 설치된 판의 도구", () => {
  const rows = [row({ id: "crm" })];
  for (const u of [who("alice"), who("owner"), who("boss", true)]) assert.deepEqual(names(rows, u), ["crm:crm_tool"]);
});

await t("L2 초안 걸린 공개 앱 — 초안 만든 사람은 초안의 도구, 남은 공개 판의 도구(이름표도 그 판)", () => {
  const rows = [row({
    id: "wiki", draft_by: "drafter", published_version_no: 3, mcp_tools: [decl("draft_only"), decl("shared", { description: "초안 설명" })],
    published: { title: "공개 판 이름", mcp_tools: [decl("shared", { description: "공개 설명" })] },
  })];
  assert.deepEqual(names(rows, who("drafter")), ["wiki:draft_only", "wiki:shared"]);
  const other = listedAppsFor(rows, who("alice"), false);
  assert.deepEqual(other.flatMap((a) => a.decls.map((d) => [d.name, d.description])), [["shared", "공개 설명"]]);
  assert.equal(other[0].title, "공개 판 이름");
  assert.deepEqual(names(rows, who("owner")), ["wiki:shared"], "책임자라도 남이 만든 초안은 공개 판으로 본다");
});

await t("L2b 공개 판 행이 없으면(불변식 위반) 설치된 상태의 도구로 — 앱이 사라지는 쪽으로 틀리지 않는다", () => {
  const rows = [row({ id: "wiki", draft_by: "drafter", published_version_no: 3, mcp_tools: [decl("installed_tool")], published: null })];
  assert.deepEqual(names(rows, who("alice")), ["wiki:installed_tool"]);
});

await t("L2c 공개 판 행이 없다는 경고는 (앱, 판)마다 한 번만 — 목록 짜기는 MCP 요청마다 돈다", () => {
  const rows = [row({ id: "lost", draft_by: "drafter", published_version_no: 7, published: null })];
  const orig = logger.warn;
  let n = 0;
  logger.warn = ((..._a: unknown[]) => { n++; }) as typeof logger.warn;
  try {
    for (let i = 0; i < 3; i++) listedAppsFor(rows, who("alice"), false);
    listedAppsFor([row({ id: "lost", draft_by: "drafter", published_version_no: 8, published: null })], who("alice"), false);
  } finally { logger.warn = orig; }
  assert.equal(n, 2, "판 7 에 한 번 · 판 8 에 한 번");
});

await t("L3 나만 보는 앱 — 책임자에게만 선다(다른 구성원 · 관리자에게도 안 선다)", () => {
  const rows = [row({ id: "mine", visibility: "me", owner_member: "owner", draft_by: null })];
  assert.deepEqual(names(rows, who("owner")), ["mine:mine_tool"]);
  assert.deepEqual(names(rows, who("alice")), []);
  assert.deepEqual(names(rows, who("boss", true)), []);
});

await t("L4 기본 앱(덮어쓴 것 포함) · 빈 예약은 서지 않는다", () => {
  const rows = [
    row({ id: "builtin", source: { kind: "builtin" } }),
    row({ id: "override", source: { kind: "builtin", overrides_builtin: true } }),
    row({ id: "empty", content_hash: null, current_version_no: null }),
    row({ id: "ok" }),
  ];
  assert.deepEqual(names(rows, who("alice")), ["ok:ok_tool"]);
});

await t("L5 읽기 전용 연결 — L0 만(level 없으면 L1 로 본다)", () => {
  const rows = [row({ id: "crm", mcp_tools: [decl("read", { level: "L0" }), decl("write", { level: "L1" }), decl("unset")] })];
  assert.deepEqual(names(rows, who("alice"), true), ["crm:read"]);
  assert.deepEqual(names(rows, who("alice"), false), ["crm:read", "crm:write", "crm:unset"]);
});

await t("L6 이 코어에 실행기가 없는 kind 의 도구는 서지 않는다(새 코어에서 깔고 되돌린 앱)", () => {
  const rows = [row({ id: "crm", mcp_tools: [decl("srv", { run: { kind: "server", route: "/x" } }), decl("ok")] })];
  assert.deepEqual(names(rows, who("alice")), ["crm:ok"]);
});

await t("L7 선언이 0개(또는 전부 틀림)인 앱은 목록에서 빠진다", () => {
  const rows = [row({ id: "a", mcp_tools: [] }), row({ id: "b", mcp_tools: null }), row({ id: "c", mcp_tools: [{ name: "Bad" }] })];
  assert.deepEqual(listedAppsFor(rows, who("alice"), false), []);
});

await t("N1 앱 토큰 · 앱 서버 주체 · scope memory 없는 토큰 · 사람 없음은 등록 0 — DB 를 보기 전에 끝난다(★5)", async () => {
  for (const u of [user({ appId: "crm" }), user({ appServer: true }), user({ scopes: ["items"] }), undefined]) {
    const s = fakeServer();
    assert.equal(await registerAppDeclaredTools(s as never, u, { readOnly: false }), 0);
    assert.deepEqual(s.got, []);
  }
});

await t("N2 실행기가 하나도 없는 코어 — DB 를 보기 전에 등록 0(지금 운영 코어의 모양 · 비용 0)", async () => {
  off();
  try {
    const s = fakeServer();
    assert.equal(await registerAppDeclaredTools(s as never, user(), { readOnly: false }), 0);
    assert.deepEqual(s.got, []);
  } finally { off = registerAppMcpExecutor({ kind: "echo", call: async () => ({ data: null }) }); }
});

await t("N3 부르기 — 앱 토큰 · 앱 서버 주체는 app_token, scope memory 없는 토큰은 scope(DB 앞에서)", async () => {
  for (const u of [user({ appId: "crm" }), user({ appServer: true })]) {
    const r = await callAppDeclaredTool(ref, {}, extraOf(u));
    assert.equal(r.isError, true);
    assert.equal(r._meta?.["lively/code"], "app_token");
  }
  const r = await callAppDeclaredTool(ref, {}, extraOf(user({ scopes: ["items"] })));
  assert.equal(r._meta?.["lively/code"], "scope");
});

console.log(`\napp-declared-tools tests: ${pass} passed`);

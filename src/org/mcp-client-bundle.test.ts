// toClientBundleServers 단위 체크 — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/mcp-client-bundle.test.js
// #894 불변식: mode='proxy' 서버(게이트웨이가 대리·통제하는 상류 MCP)는 클라 직접등록 번들(mcp-servers.json)에
//  절대 들어가면 안 된다 — 들어가면 게이트웨이 우회·이중등록·재설치 재인증(레인 C 잔재)을 유발한다.
import assert from "node:assert/strict";
import { toClientBundleServers } from "./mcp-client-bundle.js";
import type { McpServer } from "./store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 최소 McpServer 팩토리 — 기본은 유효한 client/http 서버, over 로 필드 덮어씀.
const srv = (over: Partial<McpServer>): McpServer => ({
  name: "x",
  transport: "http",
  url: "https://example.com/mcp",
  command: null,
  auth_env: null,
  note: null,
  enabled: true,
  sort: 0,
  version: 1,
  updated_at: null,
  updated_by: null,
  mode: "client",
  tools_snapshot: null,
  snapshot_at: null,
  scope: null,
  level: null,
  pii_scrub: false,
  auth_kind: null,
  auth_scope_key: null,
  auth_mode: null,
  ...over,
});

t("proxy 서버는 제외 — 게이트웨이가 대리(ext__*), 클라 직결 금지", () => {
  const out = toClientBundleServers([srv({ name: "notion", mode: "proxy", auth_mode: "oauth" })]);
  assert.equal(out.length, 0);
});

t("client 서버는 포함 + 5개 필드만 투영(mode/auth 등 미포함)", () => {
  const out = toClientBundleServers([srv({ name: "tab-shot", mode: "client" })]);
  assert.deepEqual(out, [
    { name: "tab-shot", transport: "http", url: "https://example.com/mcp", command: null, auth_env: null },
  ]);
});

t("mode 혼재 — proxy(notion·linear) 걸러지고 client 만 남는다", () => {
  const out = toClientBundleServers([
    srv({ name: "notion", mode: "proxy", auth_mode: "oauth" }),
    srv({ name: "linear", mode: "proxy", auth_mode: "oauth" }),
    srv({ name: "mermaid", mode: "client" }),
  ]);
  assert.deepEqual(out.map((s) => s.name), ["mermaid"]);
});

t("disabled·불완전 transport 제외, 완전한 stdio 는 포함", () => {
  assert.equal(toClientBundleServers([srv({ mode: "client", enabled: false })]).length, 0);
  assert.equal(toClientBundleServers([srv({ mode: "client", transport: "http", url: null })]).length, 0);
  assert.equal(
    toClientBundleServers([srv({ mode: "client", transport: "stdio", command: null, url: null })]).length,
    0,
  );
  assert.equal(
    toClientBundleServers([srv({ mode: "client", transport: "stdio", command: "npx foo", url: null })]).length,
    1,
  );
});

console.log(`\n${pass} passed`);

// MCP 프록시 상류 오류 스크럽 — PG 통합 시험. **실제 Postgres 필요**(서버 행·자격 금고·런타임 설정을 실제로 읽는다).
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/mcp/mcp-proxy-upstream-error.pg-test.mjs
//  (금고 암호화 키가 없으면 시험용 키를 쓴다.)
//
//  사양 행:
//   R1 상류가 initialize(연결) 단계에서 주입 자격을 응답 본문에 에코하며 실패하면, callProxyTool 이 던지는 오류에
//      그 자격이 남지 않고 [REDACTED] 와 상류 status([HTTP n])가 남는다.
//   R2 tools/call 단계에서 같은 에코로 실패해도 마찬가지다.
//   R3 관리자 새로고침(refreshProxySnapshot)이 initialize 단계에서 같은 에코로 실패해도 조직 자격이 남지 않는다.
if (!process.env.CONNECTOR_SECRET_KEY?.trim()) process.env.CONNECTOR_SECRET_KEY = "proxy-scrub-pg-test-key".padEnd(64, "0");

import http from "node:http";

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${DIST}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/store.js`);
const vault = await import(`${DIST}/org/credentials/member-secret-store.js`);
const proxy = await import(`${DIST}/mcp/mcp-proxy.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

const SERVER = "pg-proxy-scrub";
const KIND = "pgproxyscrub";
//  가짜 값은 조각을 이어 만든다(따옴표 안에 비밀 같은 글이 그대로 있으면 비밀 검사기가 진짜로 잡는다).
const SECRET = ["pgscrub", "token", "do-not-leak", "0123456789"].join("-");

//  상류: failPhase 가 initialize 면 첫 요청부터, tools/call 이면 그 요청에서 Authorization 헤더를 본문에 그대로 실어 500 으로 실패한다.
let failPhase = "initialize";
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let msg = {};
    try { msg = JSON.parse(body || "{}"); } catch { /* 본문 없음 */ }
    const echo = () => { res.writeHead(500, { "content-type": "text/plain" }); res.end(`upstream rejected credential: ${req.headers.authorization ?? ""}`); };
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (msg.method === failPhase) { echo(); return; }
    if (msg.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } }));
      return;
    }
    res.writeHead(202); res.end(); // notifications/initialized 등
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${upstream.address().port}/mcp`;

const prevHosts = (await store.getRuntimeConfig()).allowed_internal_hosts ?? [];
try {
  await store.updateRuntimeConfig({ allowed_internal_hosts: [...new Set([...prevHosts, "127.0.0.1"])] }, "admin", "web");
  await vault.setMemberSecret(vault.GATEWAY_OWNER, KIND, "", { secret: SECRET }, "admin");
  await store.upsertMcpServer({
    name: SERVER, transport: "http", url: URL_, mode: "proxy",
    scope: "items", level: "L0", auth_kind: KIND, pii_scrub: false, enabled: true,
  }, "admin", "web");

  const callTool = () => proxy.callProxyTool(SERVER, "anything", {}, "pg-proxy-scrub-user");
  const refresh = () => proxy.refreshProxySnapshot(SERVER, "admin");
  for (const [row, phase, run] of [["R1", "initialize", callTool], ["R2", "tools/call", callTool], ["R3", "initialize", refresh]]) {
    failPhase = phase;
    const name = `${row} ${run === refresh ? "새로고침" : "툴 호출"} ${phase} 단계 상류 오류 — 주입 자격이 스크럽되고 [HTTP 500] 이 남는다`;
    try {
      await run();
      bad(name, "오류 없이 끝났다");
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes(SECRET)) bad(name, `자격이 오류에 남았다: ${msg}`);
      else if (!msg.includes("[REDACTED]") || !msg.includes("[HTTP 500]")) bad(name, `스크럽·status 표시가 없다: ${msg}`);
      else ok(name);
    }
  }
} finally {
  await store.removeMcpServer(SERVER, "admin", "web").catch(() => {});
  await vault.deleteMemberSecret(vault.GATEWAY_OWNER, KIND, "").catch(() => {});
  await store.updateRuntimeConfig({ allowed_internal_hosts: prevHosts }, "admin", "web").catch(() => {});
  upstream.close();
  await itemsPool.end();
}

console.log(`\nMCP-PROXY UPSTREAM-ERROR PG: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

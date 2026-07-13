// in-session push(#746 T5) 전구간 E2E — 게이트웨이/DB/auth 불요. SDK 양단으로 sessioned transport 위
//  server.sendToolListChanged() 가 연결된 클라이언트에 notifications/tools/list_changed 로 '라이브' 전달됨을 증명.
//  (게이트웨이 broadcastToolListChanged 는 등록 세션들에 이 sendToolListChanged 를 호출할 뿐 → 이 전달이 핵심.)
// 실행: node scripts/integration/mcp-sessions-e2e.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ok = (m) => console.log("ok  " + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessions = new Map();               // sessionId → { transport, server }  (게이트웨이 레지스트리 미러)
function broadcastToolListChanged() { let n = 0; for (const s of sessions.values()) { try { s.server.sendToolListChanged(); n++; } catch {} } return n; }

function readBody(req) {
  return new Promise((resolve) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8") || "{}")); } catch { resolve(undefined); } }); });
}

let step = "";
const httpServer = http.createServer(async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  const entry = sid ? sessions.get(sid) : undefined;
  if (req.method === "POST") {
    const body = await readBody(req);
    if (entry) return void entry.transport.handleRequest(req, res, body);
    // 새 세션(initialize) — sessioned transport + 툴 1개 등록
    const server = new McpServer({ name: "t5-e2e", version: "0.0.0" });
    server.registerTool("ping", { title: "ping", description: "ping", inputSchema: { x: z.string().optional() } }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    let transport;
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, { transport, server }) });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    return void transport.handleRequest(req, res, body);
  }
  if (entry) return void entry.transport.handleRequest(req, res); // GET(SSE)·DELETE
  res.writeHead(400).end();
});

try {
  step = "① sessioned 서버 기동";
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  ok(step + ` (:${port})`);

  step = "② 클라이언트 sessioned 연결 + tools/list_changed 핸들러 등록";
  const client = new Client({ name: "t5-client", version: "0.0.0" }, { capabilities: {} });
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified++; });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  ok(step);

  step = "③ 초기 tools/list — 세션 확립 확인";
  const before = await client.listTools();
  if (!before.tools.find((t) => t.name === "ping")) throw new Error("초기 툴 목록에 ping 없음");
  if (sessions.size !== 1) throw new Error("서버 세션 미등록: " + sessions.size);
  ok(step + ` (툴 ${before.tools.length}, 세션 ${sessions.size})`);

  step = "④ 서버 broadcastToolListChanged() → 클라가 notifications/tools/list_changed 수신(라이브 push)";
  const pushed = broadcastToolListChanged();
  if (pushed !== 1) throw new Error("브로드캐스트 대상 세션 수 이상: " + pushed);
  for (let i = 0; i < 40 && notified === 0; i++) await sleep(50); // SSE 전달 대기
  if (notified < 1) throw new Error("클라가 tools/list_changed 를 못 받음(라이브 push 실패)");
  ok(step + ` (수신 ${notified}회)`);

  step = "⑤ 알림 후 재조회 — 클라가 mid-session 으로 최신 목록 재취득";
  const after = await client.listTools();
  if (!after.tools.find((t) => t.name === "ping")) throw new Error("재조회 실패");
  ok(step);

  await client.close();
  console.log("\nMCP-SESSIONS(T5) SSE E2E ALL GREEN — sessioned 라이브 tools/list_changed 전달 검증");
} catch (e) {
  console.error("FAIL @ " + step + " — " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  await new Promise((r) => httpServer.close(r));
}

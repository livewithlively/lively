// MCP 전송 계층(#1313 R17) — 요청별 서버 조립(buildRegisteredServer) + /mcp POST/GET/DELETE 핸들러.
//  index.ts 의 express 조립에서 registerMcpTransport(app, auth) 로 배선된다(핸들러 본문·주석은 index.ts 원문 이사).
import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../server.js";
import { listBuiltinOverrides, listBuiltinAlwaysLoad } from "../org/store.js";
import { agentFromHeaders, readOnlyFromHeaders, incognitoFromHeaders } from "../org/auth/agent-identity.js";
import { registerDynamicTools } from "../mcp/dynamic-tools.js";
import { registerProxiedMcpTools } from "../mcp/mcp-proxy.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessionedEnabled, newSessionId, getSession, putSession, dropSession } from "../mcp-sessions.js";
import { logger } from "../log.js";

// 모든 MCP 요청은 bearer 인증 필수 → req.auth 가 핸들러의 extra.authInfo 로 전달됨.
// Stateless: 요청마다 새 서버+트랜스포트 (수평 확장 단순).
// 서버 1개 빌드 + 동적/프록시 툴 등록(무상태·sessioned 공용). fail-open(등록 실패해도 기본 표면 유지).
async function buildRegisteredServer(req: express.Request): Promise<McpServer> {
  let overrides: Map<string, boolean> | undefined;
  try { overrides = await listBuiltinOverrides(); } catch { overrides = undefined; }
  let alwaysLoad: Map<string, boolean> | undefined;
  try { alwaysLoad = await listBuiltinAlwaysLoad(); } catch { alwaysLoad = undefined; }
  const harness = agentFromHeaders(req.headers); // 하네스 신원(x-lively-harness>UA) — _meta 하네스별(#187)
  // 읽기전용 세션(#1007+) — 접속 헤더(x-lively-mode=readonly)에서 파생. 무상태 /mcp 라 요청마다 재계산 = per-session(동시 세션 중 이 헤더가 실린 세션만 읽기전용).
  //  ⚠ 향후 하드닝: 읽기전용 토큰 scope 를 열려면 여기 `|| tokenReadOnly(req.auth?.extra)` 를 OR 로 더하면 된다(어느 전송으로도 못 씀).
  const readOnly = readOnlyFromHeaders(req.headers);
  // 인코그니토(#1007+) — lively 전체 차단(툴 0개). readonly 보다 우선(둘 다면 incognito 가 이긴다 = 더 강한 격리).
  const incognito = incognitoFromHeaders(req.headers);
  if (incognito) logger.info({ harness }, "인코그니토 세션 — lively 툴 전부 소거(빈 표면, 읽기·쓰기 차단)(#1007+)");
  else if (readOnly) logger.info({ harness }, "읽기전용 세션 — 컨텍스트 스토어 쓰기 툴 소거(#1007)");
  // #1643 이 요청 주체의 scope — 권한 없는 도구를 tools/list 에서 뺀다(보이는데 못 쓰는 도구가 마찰이었다).
  //  출처는 resolveUser 와 같다(bearer 미들웨어가 실은 req.auth.extra = LivelyUser). 못 읽으면 undefined 로
  //  두어 종전처럼 전부 노출한다 — 인증 파싱이 어긋났을 때 admin 이 도구를 통째로 잃지 않게 하는 fail-safe.
  const principal = (req as unknown as { auth?: { extra?: { scopes?: unknown } } }).auth?.extra;
  const scopes = Array.isArray(principal?.scopes) ? (principal.scopes as string[]) : undefined;
  const server = buildServer(overrides, alwaysLoad, harness, readOnly, incognito, scopes);
  // 인코그니토면 외부 프록시·동적 툴도 노출하지 않는다(ext__*·http_proxy 도 lively 게이트웨이 표면 — 클린룸이면 전부 차단).
  if (!incognito) {
    try { await registerDynamicTools(server); } catch (err) { logger.warn({ err }, "동적 툴 등록 실패(무시)"); }
    try { await registerProxiedMcpTools(server); } catch (err) { logger.warn({ err }, "프록시 MCP 등록 실패(무시)"); }
  }
  return server;
}

export function registerMcpTransport(app: express.Express, auth: express.RequestHandler): void {
  app.post("/mcp", auth, async (req, res) => {
    // sessioned(#746 T5, 플래그 on) — 세션 유지 + tools/list_changed 라이브 push. 기본 off 면 아래 무상태 경로(무회귀).
    if (sessionedEnabled()) {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      try {
        if (sid) {
          const e = getSession(sid);
          if (!e) { res.status(404).json({ error: "unknown_session" }); return; }
          await e.transport.handleRequest(req, res, req.body); // 기존 세션 라우팅
          return;
        }
        // 새 세션(initialize) — sessionId 생성·레지스트리 등록, onclose 로 정리.
        const server = await buildRegisteredServer(req);
        let transport: StreamableHTTPServerTransport; // 콜백이 참조하므로 let+타입(순환 초기화 회피)
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: newSessionId,
          onsessioninitialized: (id: string) => putSession(id, { transport, server }),
        });
        transport.onclose = () => { if (transport.sessionId) { dropSession(transport.sessionId); server.close(); } };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error({ err }, "mcp(session) 요청 실패");
        if (!res.headersSent) res.status(500).json({ error: "internal_error" });
      }
      return;
    }
    // ── 무상태(기본) — 요청마다 새 서버+트랜스포트(수평 확장 단순). 툴 변경은 '다음 세션'부터. ──
    const server = await buildRegisteredServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "mcp request failed");
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  // sessioned 전용 — 서버→클라 SSE 스트림(GET) + 세션 종료(DELETE). 무상태 모드에선 405(미사용).
  app.get("/mcp", auth, async (req, res) => {
    if (!sessionedEnabled()) { res.status(405).end(); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const e = sid ? getSession(sid) : undefined;
    if (!e) { res.status(404).end(); return; }
    try { await e.transport.handleRequest(req, res); } catch (err) { logger.error({ err }, "mcp GET(SSE) 실패"); if (!res.headersSent) res.status(500).end(); }
  });
  app.delete("/mcp", auth, async (req, res) => {
    if (!sessionedEnabled()) { res.status(405).end(); return; }
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const e = sid ? getSession(sid) : undefined;
    if (!e) { res.status(404).end(); return; }
    try { await e.transport.handleRequest(req, res); } catch (err) { logger.error({ err }, "mcp DELETE 실패"); if (!res.headersSent) res.status(500).end(); }
  });
}

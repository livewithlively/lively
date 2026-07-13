// A-어댑터(#746 T1) — 게이트웨이가 상류 remote MCP 의 '클라이언트'가 되어, 그 tools 를 자기 /mcp 에 재노출하고
//  tools/call 을 통제(scope·level·per-member 자격·PII 스크럽·감사) 하에 대신 쏴준다(프록시). 기존 3방식 중 ③(클라 직접등록)을
//  게이트웨이 프록시로 흡수해 통제·즉시전파를 얻는다. dynamic-tools(②)의 통제 primitives 를 재사용.
//
//  등록: buildServer 후 index.ts 가 registerProxiedMcpTools 호출(registerDynamicTools 와 나란히). 툴 목록은 DB 의 pinned
//  스냅샷(org_mcp_server.tools_snapshot)에서 — 요청마다 상류 접속 안 함(발행/새로고침 때만 fetchUpstreamTools 로 캡처).
//  호출 시에만 상류 접속(per-call, MVP — 커넥션 풀은 후속). 인증은 per-member vault(정적토큰 MVP; OAuth 는 T2).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listProxyServers, getMcpServer, setMcpToolsSnapshot, type McpServer as McpServerRow } from "../org/store.js";
import { resolveMemberSecret, GATEWAY_OWNER, getMemberSecret } from "../org/member-secret-store.js";
import { scrubPii } from "../org/pii-scrub.js";
import { resolveUser, requireScope } from "../context.js";
import { isScope } from "./scopes.js";
import { jsonSchemaToZodShape, buildProxyAuthHeaders, proxyAuthFallback } from "./dynamic-tools.js";
import { logger } from "../log.js";

const NS = "ext__"; // 프록시 툴 네임스페이스 접두 — ext__<server>__<tool>. 빌트인·http_proxy 이름과 충돌 방지.
const CALL_TIMEOUT_MS = 15000;

export interface ProxyTool { name: string; description?: string; inputSchema?: unknown }

// 상류 접속 — StreamableHTTP + (선택) 인증 헤더. 호출자가 close 책임.
async function connectUpstream(url: string, headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: "lively-gateway-proxy", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// 발행/새로고침 — 상류 tools/list 를 캡처해 스냅샷으로 저장(핀). 인증은 조직(gateway) 자격으로(목록은 계약이라 신원 무관, 있으면 사용).
export async function refreshProxySnapshot(name: string, actor?: string): Promise<{ count: number }> {
  const server = await getMcpServer(name);
  if (!server) throw new Error(`MCP 서버 없음: ${name}`);
  if (server.mode !== "proxy") throw new Error(`'${name}' 은 proxy 모드가 아닙니다`);
  if (server.transport !== "http" || !server.url) throw new Error("proxy 는 http(원격) + url 이 필요합니다");
  const headers: Record<string, string> = {};
  if (server.auth_kind) {
    const gw = await getMemberSecret(GATEWAY_OWNER, server.auth_kind, server.auth_scope_key ?? "");
    if (gw?.secret) Object.assign(headers, buildProxyAuthHeaders(gw.meta, gw.secret).headers);
  }
  const client = await connectUpstream(server.url, headers);
  try {
    const { tools } = await client.listTools();
    const snap: ProxyTool[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    await setMcpToolsSnapshot(name, snap, actor);
    return { count: snap.length };
  } finally {
    await client.close().catch(() => { /* */ });
  }
}

// tools/call 프록시 — per-member 자격 해소·주입 → 상류 호출 → (옵션) 응답 PII 스크럽. 통제는 등록 핸들러(scope)가 선행.
async function callUpstream(server: McpServerRow, toolName: string, args: Record<string, unknown>, callerId: string | null): Promise<{ content: unknown[]; isError: boolean }> {
  if (!server.url) throw new Error("proxy url 미설정");
  const headers: Record<string, string> = {};
  if (server.auth_kind) {
    // 등급이 폴백 정책을 정한다: L2(집행)=per-user 필수(통합 폴백 금지) / 그 외=통합 폴백 허용(비-PII read).
    const resolved = await resolveMemberSecret(callerId, server.auth_kind, { scopeKey: server.auth_scope_key ?? "", allowFallback: proxyAuthFallback(server.level) });
    if (!resolved || !resolved.secret) {
      throw new Error(`자격 없음 — 이 커넥터는 '${server.auth_kind}' 자격이 필요합니다('내 자격'에 등록${proxyAuthFallback(server.level) ? " 또는 관리자 통합 자격" : "(L2: 개인 자격 필수)"}).`);
    }
    Object.assign(headers, buildProxyAuthHeaders(resolved.meta, resolved.secret).headers);
  }
  const client = await connectUpstream(server.url, headers);
  try {
    const res = await client.callTool({ name: toolName, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    let content = (res.content as unknown[]) ?? [];
    if (server.pii_scrub) {
      // 비정형 PII 마스킹 — text 블록만(#746 P3). 구조는 보존.
      content = content.map((b) => {
        const blk = b as { type?: string; text?: string };
        return blk && blk.type === "text" && typeof blk.text === "string" ? { ...blk, text: scrubPii(blk.text).text } : b;
      });
    }
    return { content, isError: res.isError === true };
  } finally {
    await client.close().catch(() => { /* */ });
  }
}

// 이름으로 프록시 호출(등록 핸들러·테스트 공용) — getMcpServer + callUpstream. scope 게이트는 등록 핸들러가 담당.
export async function callProxyTool(serverName: string, toolName: string, args: Record<string, unknown>, callerId: string | null): Promise<{ content: unknown[]; isError: boolean }> {
  const server = await getMcpServer(serverName);
  if (!server || server.mode !== "proxy") throw new Error(`proxy MCP 서버 없음: ${serverName}`);
  return callUpstream(server, toolName, args, callerId);
}

// buildServer 후 호출 — pinned 스냅샷의 툴을 네임스페이스 붙여 /mcp 에 등록. fail-open(실패해도 게이트웨이 동작).
export async function registerProxiedMcpTools(server: McpServer): Promise<void> {
  let servers: McpServerRow[];
  try { servers = await listProxyServers(); }
  catch (err) { logger.warn({ err }, "프록시 MCP 로드 실패 — 프록시 없이 진행"); return; }
  for (const srv of servers) {
    const callScope = srv.scope && isScope(srv.scope) ? srv.scope : "items";
    for (const tool of (srv.tools_snapshot ?? [])) {
      if (!tool || typeof tool.name !== "string") continue;
      const toolName = `${NS}${srv.name}__${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
      const shape = jsonSchemaToZodShape(tool.inputSchema);
      server.registerTool(
        toolName,
        { title: `${srv.name}: ${tool.name}`, description: tool.description || `${srv.name} 프록시 툴`, inputSchema: shape },
        async (args: Record<string, unknown>, extra: unknown) => {
          const u = resolveUser(extra);
          requireScope(u, callScope);          // scope 게이트(멤버 권한)
          try {
            const r = await callUpstream(srv, tool.name, args ?? {}, u.userId);
            return { content: r.content as never, isError: r.isError };
          } catch (err) {
            const msg = (err as Error).message;
            logger.warn({ tool: toolName, err: msg }, "프록시 MCP 호출 실패");
            return { content: [{ type: "text" as const, text: `프록시 호출 실패: ${msg}` }], isError: true };
          }
        },
      );
    }
  }
}

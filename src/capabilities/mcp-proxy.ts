// A-어댑터(#746 T1) — 게이트웨이가 상류 remote MCP 의 '클라이언트'가 되어, 그 tools 를 자기 /mcp 에 재노출하고
//  tools/call 을 통제(scope·level·per-member 자격·PII 스크럽·감사) 하에 대신 쏴준다(프록시). 기존 3방식 중 ③(클라 직접등록)을
//  게이트웨이 프록시로 흡수해 통제·즉시전파를 얻는다. dynamic-tools(②)의 통제 primitives 를 재사용.
//
//  등록: buildServer 후 index.ts 가 registerProxiedMcpTools 호출(registerDynamicTools 와 나란히). 툴 목록은 DB 의 pinned
//  스냅샷(org_mcp_server.tools_snapshot)에서 — 요청마다 상류 접속 안 함(발행/새로고침 때만 fetchUpstreamTools 로 캡처).
//  호출 시에만 상류 접속(per-call, MVP — 커넥션 풀은 후속). 인증은 per-member vault(정적토큰 MVP; OAuth 는 T2).
//
//  보안(리뷰 반영): 상류 접속은 SSRF-안전 fetch(makeSsrfFetch)로만 — 사설/메타데이터/자기자신 IP 차단·IP-pin(safeFetch 동급).
//   주입 자격은 응답/에러 어디로도 에코되지 않게 리터럴 스크럽. scope 미지정/무효는 fail-closed(등록 제외).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { listProxyServers, getMcpServer, setMcpToolsSnapshot, getRuntimeConfig, getOrgProfile, type McpServer as McpServerRow } from "../org/store.js";
import { resolveMemberSecret, GATEWAY_OWNER, getMemberSecret } from "../org/member-secret-store.js";
import { makeSsrfFetch } from "../org/mcp-ssrf-fetch.js";
import { providerForServer } from "../org/oauth-broker.js";
import { scrubPii } from "../org/pii-scrub.js";
import { resolveUser, requireScope } from "../context.js";
import { isScope } from "./scopes.js";
import { jsonSchemaToZodShape, buildProxyAuthHeaders, proxyAuthFallback, CALLABLE_SCOPES } from "./dynamic-tools.js";
import { logger } from "../log.js";

const NS = "ext__"; // 프록시 툴 네임스페이스 접두 — ext__<server>__<tool>. 빌트인·http_proxy 이름과 충돌 방지.
const CALL_TIMEOUT_MS = 15000;

export interface ProxyTool { name: string; description?: string; inputSchema?: unknown }

// 주입 자격이 상류 응답/에러에 그대로 에코돼 로그·호출자에게 새는 것 방지(#746 리뷰) — 리터럴 스크럽. dynamic-tools 와 동일 패턴.
export function redactSecret(text: string, secret: string | null | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join("[REDACTED]") : text;
}

// scope fail-closed 판정(#746 P2, B19 동형) — 미지정/무효/admin·runtime scope 는 프록시 등록 제외(기본 노출 금지). 순수, 테스트용 export.
export function proxyScopeAllowed(scope: string | null | undefined): boolean {
  return !!scope && isScope(scope) && CALLABLE_SCOPES.has(scope);
}

// 프록시 툴 이름 — ext__<server>__<tool>, MCP 허용 문자만·128자 상한. 순수, 테스트용 export.
export function proxyToolName(serverName: string, toolName: string): string {
  return `${NS}${serverName}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

// 상류 접속 — SSRF-안전 fetch + StreamableHTTP + (택1) 정적 인증 헤더(bearer) 또는 OAuthClientProvider(oauth). 호출자가 close 책임.
//  운영자 명시 내부 host(allowed_internal_hosts) 외의 사설/메타데이터/게이트웨이 자기자신은 makeSsrfFetch 가 차단.
async function connectUpstream(url: string, opts: { headers?: Record<string, string>; authProvider?: OAuthClientProvider }): Promise<Client> {
  const cfg = await getRuntimeConfig().catch(() => null);
  const selfHosts: string[] = [];
  try { const p = await getOrgProfile(); if (p.gateway_url) selfHosts.push(new URL(p.gateway_url).hostname.toLowerCase()); }
  catch { /* 프로필 없음 — selfHosts 비움 */ }
  const ssrfFetch = makeSsrfFetch({ allowedInternalHosts: cfg?.allowed_internal_hosts ?? [], selfHosts, timeoutMs: CALL_TIMEOUT_MS });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: opts.headers ?? {} },
    fetch: ssrfFetch,
    ...(opts.authProvider ? { authProvider: opts.authProvider } : {}), // oauth: SDK 가 tokens()/refresh 를 provider 로 관리
  });
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
  let gwSecret: string | null = null;
  let authProvider: OAuthClientProvider | undefined;
  if (server.auth_mode === "oauth" && server.auth_kind) {
    // oauth: 목록 캡처에도 유효 토큰 필요 — 새로고침 주체(actor)의 개인 OAuth 로. 미연결이면 SDK 401→헤드리스 실패 전에 친절히 차단.
    if (!actor) throw new Error("OAuth 프록시 새로고침은 연결된 멤버 신원이 필요합니다(먼저 커넥트).");
    const provider = await providerForServer(actor, server, actor);
    const tk = await provider.tokens();
    if (!tk) throw new Error(`'${name}' OAuth 미연결(${actor}) — me_oauth_connect 로 먼저 인증 후 새로고침하세요.`);
    authProvider = provider; gwSecret = tk.access_token ?? null;
  } else if (server.auth_kind) {
    const gw = await getMemberSecret(GATEWAY_OWNER, server.auth_kind, server.auth_scope_key ?? "");
    if (gw?.secret) { gwSecret = gw.secret; Object.assign(headers, buildProxyAuthHeaders(gw.meta, gw.secret).headers); }
  }
  const client = await connectUpstream(server.url, { headers, authProvider });
  try {
    const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const snap: ProxyTool[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    await setMcpToolsSnapshot(name, snap, actor);
    return { count: snap.length };
  } catch (err) {
    throw new Error(redactSecret((err as Error).message, gwSecret)); // 상류 에러 본문에 gateway 자격 에코 방지
  } finally {
    await client.close().catch(() => { /* */ });
  }
}

// tools/call 프록시 — per-member 자격 해소·주입 → 상류 호출 → (옵션) 응답 PII 스크럽 + 주입자격 리터럴 스크럽. 통제는 등록 핸들러(scope)가 선행.
async function callUpstream(server: McpServerRow, toolName: string, args: Record<string, unknown>, callerId: string | null): Promise<{ content: unknown[]; isError: boolean }> {
  if (!server.url) throw new Error("proxy url 미설정");
  const headers: Record<string, string> = {};
  let authProvider: OAuthClientProvider | undefined;
  let injectedSecret: string | null = null; // 응답/에러 에코 스크럽용(정적토큰 또는 현재 access_token)
  if (server.auth_mode === "oauth" && server.auth_kind) {
    // oauth: 항상 per-user(통합 폴백 없음 — 토큰은 개인 소유). 미연결이면 커넥트 안내. 자동 refresh 는 SDK 가 provider 로 수행.
    if (!callerId) throw new Error("OAuth 커넥터는 개인 연결이 필요합니다('내 자격'에서 커넥트).");
    const provider = await providerForServer(callerId, server);
    const tk = await provider.tokens();
    if (!tk) throw new Error(`'${server.auth_kind}' OAuth 미연결 — me_oauth_connect 로 먼저 인증하세요.`);
    authProvider = provider; injectedSecret = tk.access_token ?? null;
  } else if (server.auth_kind) {
    // 등급이 폴백 정책을 정한다: L2(집행)=per-user 필수(통합 폴백 금지) / 그 외=통합 폴백 허용(비-PII read).
    const resolved = await resolveMemberSecret(callerId, server.auth_kind, { scopeKey: server.auth_scope_key ?? "", allowFallback: proxyAuthFallback(server.level) });
    if (!resolved || !resolved.secret) {
      throw new Error(`자격 없음 — 이 커넥터는 '${server.auth_kind}' 자격이 필요합니다('내 자격'에 등록${proxyAuthFallback(server.level) ? " 또는 관리자 통합 자격" : "(L2: 개인 자격 필수)"}).`);
    }
    injectedSecret = resolved.secret;
    Object.assign(headers, buildProxyAuthHeaders(resolved.meta, resolved.secret).headers);
  }
  const client = await connectUpstream(server.url, { headers, authProvider });
  try {
    const res = await client.callTool({ name: toolName, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    let content = (res.content as unknown[]) ?? [];
    // 응답 text 블록: 주입 자격 리터럴 스크럽(항상) + (옵션) 비정형 PII 마스킹(#746 P3). 구조는 보존.
    content = content.map((b) => {
      const blk = b as { type?: string; text?: string };
      if (!blk || blk.type !== "text" || typeof blk.text !== "string") return b;
      let text = redactSecret(blk.text, injectedSecret);
      if (server.pii_scrub) text = scrubPii(text).text;
      return { ...blk, text };
    });
    return { content, isError: res.isError === true };
  } catch (err) {
    throw new Error(redactSecret((err as Error).message, injectedSecret)); // 상류 에러 본문에 주입 자격 에코 방지(SDK 는 응답 body 를 에러메시지에 그대로 실음)
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
    // scope fail-closed(#746 P2, B19 동형) — 미지정/무효/admin·runtime scope 는 등록 제외(기본 'items' 로 전체 표면 노출 금지).
    if (!proxyScopeAllowed(srv.scope)) {
      logger.warn({ server: srv.name, scope: srv.scope }, "허용되지 않은 호출 scope 의 프록시 MCP — 등록 제외(scope 미지정/무효)");
      continue;
    }
    const callScope = srv.scope as string;
    for (const tool of (srv.tools_snapshot ?? [])) {
      if (!tool || typeof tool.name !== "string") continue;
      const toolName = proxyToolName(srv.name, tool.name);
      const shape = jsonSchemaToZodShape(tool.inputSchema);
      try {
        server.registerTool(
          toolName,
          { title: `${srv.name}: ${tool.name}`, description: tool.description || `${srv.name} 프록시 툴`, inputSchema: shape },
          async (args: Record<string, unknown>, extra: unknown) => {
            const u = resolveUser(extra);
            requireScope(u, callScope);          // scope 게이트(멤버 권한)
            try {
              const r = await callUpstream(srv, tool.name, args ?? {}, u.userId);
              return { content: r.content as never, isError: r.isError }; // 상류 content 는 임의 구조 — SDK 블록 유니온으로 정적 검증 불가
            } catch (err) {
              const msg = (err as Error).message; // callUpstream 에서 주입 자격은 이미 스크럽됨
              logger.warn({ tool: toolName, err: msg }, "프록시 MCP 호출 실패");
              return { content: [{ type: "text" as const, text: `프록시 호출 실패: ${msg}` }], isError: true };
            }
          },
        );
      } catch (err) {
        // 이름 충돌 등 한 툴 등록 실패가 나머지 등록을 막지 않게(리뷰) — 이 툴만 건너뛴다.
        logger.warn({ tool: toolName, err: (err as Error).message }, "프록시 툴 등록 실패 — 이 툴만 건너뜀");
      }
    }
  }
}

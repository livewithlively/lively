// 브로커 mcp-forward op(#746 T4, ③) — stateful 상류 MCP 프록시. T1(게이트웨이 무상태 per-call)과의 차별점:
//  브로커 프로세스가 상류 연결을 '수명 동안 캐시'(stateful 세션 유지) → 세션형/상태형 상류(로컬 state·긴 핸드셰이크) 대응.
//  상류 접속도 SSRF-안전 fetch(T1 재사용). url·헤더는 게이트웨이(신뢰)가 구성해 넘긴다(멤버 직접 아님).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeSsrfFetch } from "../net/mcp-ssrf-fetch.js";

export interface McpRequest { op: "mcp"; url: string; tool: string; args?: Record<string, unknown>; headers?: Record<string, string> }
export interface McpResult { ok: boolean; content?: unknown[]; isError?: boolean; error?: string }

const clients = new Map<string, Client>(); // url → 캐시된 상류 클라이언트(stateful)
const CALL_TIMEOUT_MS = 30000;

function ssrfFetch(): ReturnType<typeof makeSsrfFetch> {
  const internal = (process.env.LIVELY_BROKER_INTERNAL_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return makeSsrfFetch({ allowedInternalHosts: internal, selfHosts: [], timeoutMs: CALL_TIMEOUT_MS });
}

async function getClient(url: string, headers?: Record<string, string>): Promise<Client> {
  const cached = clients.get(url);
  if (cached) return cached;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: headers ?? {} }, fetch: ssrfFetch() });
  const client = new Client({ name: "lively-broker", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  clients.set(url, client);
  return client;
}

export async function mcpForward(req: McpRequest): Promise<McpResult> {
  if (!req.url || !req.tool) return { ok: false, error: "url·tool 필요" };
  try {
    const client = await getClient(req.url, req.headers);
    const r = await client.callTool({ name: req.tool, arguments: req.args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
    return { ok: r.isError !== true, content: (r.content as unknown[]) ?? [], isError: r.isError === true };
  } catch (e) {
    const dead = clients.get(req.url); // delete 前에 잡아서 close(리뷰: delete 후 get 은 항상 undefined 였음)
    clients.delete(req.url);           // 연결이 죽었을 수 있음 → 캐시 무효화(다음 호출에 재연결)
    try { await dead?.close(); } catch { /* */ }
    return { ok: false, error: (e as Error).message };
  }
}

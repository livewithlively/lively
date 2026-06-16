// 동적 MCP 툴 — org_tool(kind='http_proxy') 을 게이트웨이 /mcp 에 런타임 등록(재설치 불요, 즉시).
//  보안 불변식(저장 시 delivery 가 강제 + 등록 시 2차 재확인):
//   - scope 는 items|context|db|memory|code 만(admin·NULL 거부, B19) — 에이전트가 admin 표면 자가호출 차단.
//   - 빌트인 이름 섀도잉 거부(identity.ts). url 은 절대 URL, args 로 scheme/host/path 변경 불가(B17).
//   - 호출은 SSRF-안전 safeFetch(allowlist·IP-pin·redirect·타임아웃·크기). 응답은 redact 후 반환(B20).
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listEnabledProxyTools, getRuntimeConfig, getOrgProfile, type OrgTool } from "../org/store.js";
import { safeFetch, SsrfError } from "../org/ssrf.js";
import { redactDeep } from "../org/redact.js";
import { resolveUser, requireScope } from "../context.js";
import { HttpError } from "./rest-util.js";
import { isScope } from "./scopes.js";
import { logger } from "../log.js";

// http_proxy 호출 scope 로 허용되는 집합(B19) — fleet 제어(admin/runtime)·무권한(null) 불가.
const CALLABLE_SCOPES = new Set(["items", "context", "db", "memory", "code"]);

// 저장 시 input_schema 위생 검사(B21 경량판 — ajv 무의존): $ref 금지·크기/깊이 상한·최상위 object.
export function assertSafeJsonSchema(schema: unknown): void {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== "object" || Array.isArray(schema)) throw new HttpError(400, "input_schema 는 객체여야 합니다");
  const json = JSON.stringify(schema);
  if (json.length > 32 * 1024) throw new HttpError(400, "input_schema 가 너무 큽니다(32KiB 초과)");
  if (/"\$ref"|"\$dynamicRef"|"\$recursiveRef"/.test(json)) throw new HttpError(400, "input_schema 에 $ref 는 허용되지 않습니다");
  if (/"(__proto__|constructor|prototype)"\s*:/.test(json)) throw new HttpError(400, "input_schema 에 예약 키(__proto__/constructor/prototype)는 허용되지 않습니다");
  const walk = (v: unknown, d: number): void => {
    if (d > 6) throw new HttpError(400, "input_schema 중첩이 너무 깊습니다(6단 초과)");
    if (v && typeof v === "object") for (const val of Object.values(v as Record<string, unknown>)) walk(val, d + 1);
  };
  walk(schema, 0);
  const s = schema as { type?: unknown };
  if (s.type !== undefined && s.type !== "object") throw new HttpError(400, "input_schema 의 최상위 type 은 object 여야 합니다");
}

// JSON Schema(object) → MCP inputSchema(zod raw shape). 단순 평면 스키마만 정밀 변환, 그 외는 unknown.
//  (정밀 깊은 검증보다 SSRF/scope/allowlist 가 1차 방어선이라 인자 검증은 타입 수준으로 충분 — v1.)
export function jsonSchemaToZodShape(schema: unknown): ZodRawShape {
  const shape: ZodRawShape = {};
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  if (!s.properties || typeof s.properties !== "object") return shape;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  for (const [key, propRaw] of Object.entries(s.properties)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue; // 프로토타입 오염 차단
    const p = (propRaw ?? {}) as { type?: string; description?: string };
    let zt: ZodTypeAny;
    switch (p.type) {
      case "string": zt = z.string(); break;
      case "number": case "integer": zt = z.number(); break;
      case "boolean": zt = z.boolean(); break;
      case "array": zt = z.array(z.unknown()); break;
      case "object": zt = z.object({}).passthrough(); break;
      default: zt = z.unknown();
    }
    if (p.description) zt = zt.describe(p.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

export interface ProxyResult { status: number; body: string; truncated: boolean; ok: boolean }

// http_proxy 툴 1회 호출 — auth_env 화이트리스트 확인 + url 고정 + args 는 query/body 로만.
export async function runHttpProxyTool(tool: OrgTool, args: Record<string, unknown>): Promise<ProxyResult> {
  if (!tool.url) throw new Error("툴 url 미설정");
  const cfg = await getRuntimeConfig();
  const selfHosts: string[] = [];
  try {
    const profile = await getOrgProfile();
    if (profile.gateway_url) selfHosts.push(new URL(profile.gateway_url).hostname.toLowerCase());
  } catch { /* 프로필 없음 — selfHosts 비움 */ }

  const headers: Record<string, string> = { "User-Agent": "lively-context-tool" };
  if (tool.auth_env) {
    // auth_env 는 운영자 화이트리스트(allowed_auth_envs)에 등록된 이름만 — 인프라 시크릿명(DATABASE_URL 등) 차단.
    if (!cfg.allowed_auth_envs.includes(tool.auth_env)) {
      throw new Error(`auth_env '${tool.auth_env}' 는 허용 목록(allowed_auth_envs)에 없습니다`);
    }
    const val = process.env[tool.auth_env];
    if (val) headers.Authorization = `Bearer ${val}`;
  }

  const method = (tool.method || "GET").toUpperCase();
  const base = new URL(tool.url); // scheme/host/path 는 저장값 고정 — args 로 변경 불가(B17)
  let body: string | undefined;
  if (method === "GET" || method === "DELETE" || method === "HEAD") {
    for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined && v !== null) base.searchParams.set(k, String(v));
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(args ?? {});
  }

  const res = await safeFetch(base.toString(), {
    method, headers, body,
    allowlist: cfg.url_allowlist,
    selfHosts,
    maxBytes: 256 * 1024,
    timeoutMs: 8000,
    allowHttp: false,
    maxRedirects: 2,
  });
  const cleanBody = redactDeep(res.body).slice(0, 256 * 1024); // 응답 본문도 redact(에코된 토큰 등 차단)
  return { status: res.status, body: cleanBody, truncated: res.truncated, ok: res.status >= 200 && res.status < 300 };
}

// 요청별 buildServer 후 호출 — enabled http_proxy 툴을 server 에 등록. fail-open: 실패해도 게이트웨이는 동작.
export async function registerDynamicTools(server: McpServer): Promise<void> {
  let tools: OrgTool[];
  try { tools = await listEnabledProxyTools(); }
  catch (err) { logger.warn({ err }, "동적 툴 로드 실패 — 동적 툴 없이 진행"); return; }
  for (const tool of tools) {
    if (!tool.url) continue;
    const sc = tool.scope;
    // B19 2차 게이트: callable scope 만 등록(admin/runtime/null/미허용 거부).
    if (!sc || !isScope(sc) || !CALLABLE_SCOPES.has(sc)) {
      logger.warn({ tool: tool.name, scope: sc }, "허용되지 않은 호출 scope 의 http_proxy 툴 — 등록 제외(B19)");
      continue;
    }
    const callScope = sc;
    const shape = jsonSchemaToZodShape(tool.input_schema);
    server.registerTool(
      tool.name,
      { title: tool.title || tool.name, description: tool.description || "", inputSchema: shape },
      async (args: Record<string, unknown>, extra: unknown) => {
        const u = resolveUser(extra);
        requireScope(u, callScope);
        try {
          const r = await runHttpProxyTool(tool, args ?? {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: r.status, ok: r.ok, truncated: r.truncated, body: r.body }, null, 2) }],
            isError: !r.ok,
          };
        } catch (err) {
          const msg = err instanceof SsrfError ? `차단됨: ${err.message}` : (err as Error).message;
          logger.warn({ tool: tool.name, err: msg }, "http_proxy 툴 호출 실패");
          return { content: [{ type: "text" as const, text: `툴 호출 실패: ${msg}` }], isError: true };
        }
      },
    );
  }
}

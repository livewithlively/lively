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
import { scrubPii } from "../org/pii-scrub.js";
import { resolveMemberSecret } from "../org/member-secret-store.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
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

// P1·P2(#746) — 커넥터 툴의 vault 자격 해소 폴백 정책은 등급이 정한다(순수, 테스트용 export):
//  L0/L1/미지정(비-PII read)=true(통합 폴백 허용) / L2 및 그 외 모든 값=false(per-user 필수 — 사칭 방지).
//  allow-list 로 판정(deny-list 아님) — 예상 밖 등급값이 들어와도 fail-closed(폴백 금지) 쪽으로.
export function proxyAuthFallback(level: string | null | undefined): boolean {
  return level === "L0" || level === "L1" || level == null;
}

// P1(#746) — vault 해소 결과로 인증 헤더를 만든다(순수, 테스트용 export). meta.auth_header/token_prefix 로 형식 지정.
//  반환: headers(주입할 헤더) + headerName(리다이렉트 시 벗겨야 할 자격 헤더명 — safeFetch.sensitiveHeaders 로 전달).
export function buildProxyAuthHeaders(meta: Record<string, unknown> | undefined, secret: string): { headers: Record<string, string>; headerName: string } {
  const m = meta ?? {};
  const headerName = typeof m.auth_header === "string" && m.auth_header.trim() ? m.auth_header.trim() : "Authorization";
  const prefix = typeof m.token_prefix === "string" ? m.token_prefix : "Bearer ";
  return { headers: { [headerName]: `${prefix}${secret}` }, headerName };
}

// http_proxy 툴 1회 호출 — 인증(env 또는 per-user vault) + url 고정 + args 는 query/body 로만 + 응답 redact(+옵션 PII 스크럽).
//  callerId(P1 #746): tool.auth_kind 설정 시 이 멤버의 vault 자격으로 인증(요청자 귀속). 미설정이면 종전 auth_env(조직 공용).
export async function runHttpProxyTool(tool: OrgTool, args: Record<string, unknown>, callerId?: string | null): Promise<ProxyResult> {
  if (!tool.url) throw new Error("툴 url 미설정");
  const cfg = await getRuntimeConfig();
  const selfHosts: string[] = [];
  try {
    const profile = await getOrgProfile();
    if (profile.gateway_url) selfHosts.push(new URL(profile.gateway_url).hostname.toLowerCase());
  } catch { /* 프로필 없음 — selfHosts 비움 */ }

  const headers: Record<string, string> = { "User-Agent": "lively-context-tool" };
  let injectedSecret: string | null = null; // 응답 리터럴 스크럽용(에코된 자격 차단)
  const sensitiveHeaders: string[] = [];    // 크로스-오리진 리다이렉트 시 벗길 자격 헤더명(safeFetch 로 전달)
  if (tool.auth_kind) {
    // P1(#746) per-user vault 인증 — 요청자 개인 자격 우선. 폴백 정책은 등급이 정한다:
    //  L2(집행/외부발신)=per-user 필수(통합 폴백 금지 — 사칭 방지) / 그 외=통합(gateway) 폴백 허용(비-PII read, 온보딩 0).
    const allowFallback = proxyAuthFallback(tool.level);
    const resolved = await resolveMemberSecret(callerId, tool.auth_kind, { scopeKey: tool.auth_scope_key ?? "", allowFallback });
    if (!resolved || !resolved.secret) {
      throw new Error(
        `자격 없음 — 이 툴은 '${tool.auth_kind}' 자격이 필요합니다. ` +
        (allowFallback ? "개인 자격을 '내 자격'(me_credential_set)에 등록하거나 관리자에게 통합 자격 설정을 요청하세요."
                       : "이 등급(L2/집행)은 개인 자격이 필수입니다 — '내 자격'(me_credential_set)에 등록하세요."),
      );
    }
    const built = buildProxyAuthHeaders(resolved.meta, resolved.secret);
    Object.assign(headers, built.headers);
    injectedSecret = resolved.secret;
    sensitiveHeaders.push(built.headerName); // 커스텀 헤더명(PRIVATE-TOKEN 등)도 리다이렉트에서 벗기게(#746)
  } else if (tool.auth_env) {
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
    sensitiveHeaders, // 커스텀 자격 헤더명도 크로스-오리진 리다이렉트에서 벗긴다(#746)
  });
  let cleanBody = redactDeep(res.body).slice(0, 256 * 1024); // 응답 본문 redact(에코된 토큰 등 차단)
  // 주입한 자격이 응답에 그대로 에코될 경우 대비 — redactDeep 의 정적 패턴이 못 잡는 임의 벤더 토큰을 리터럴로 스크럽(#746 리뷰).
  if (injectedSecret && injectedSecret.length >= 8) cleanBody = cleanBody.split(injectedSecret).join("[REDACTED]");
  if (tool.pii_scrub) cleanBody = scrubPii(cleanBody).text; // P3(#746) 비정형 PII 마스킹(응답에 섞인 개인정보, 평문 문자열)
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
        const u: LivelyUser = resolveUser(extra);
        requireScope(u, callScope);
        try {
          const r = await runHttpProxyTool(tool, args ?? {}, u.userId); // P1: 요청자 신원으로 vault 자격 해소
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

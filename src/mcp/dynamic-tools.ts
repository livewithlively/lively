// 동적 MCP 툴 — org_tool(kind='http_proxy') 을 게이트웨이 /mcp 에 런타임 등록(재설치 불요, 즉시).
//  보안 불변식(저장 시 delivery 가 강제 + 등록 시 2차 재확인):
//   - scope 는 items|context|db|memory|code 만(admin·NULL 거부, B19) — 에이전트가 admin 표면 자가호출 차단.
//   - 빌트인 이름 섀도잉 거부(asset-id.ts). url 은 절대 URL, args 로 scheme/host/path 변경 불가(B17).
//   - 호출은 SSRF-안전 safeFetch(allowlist·IP-pin·redirect·타임아웃·크기). 응답은 redact 후 반환(B20).
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listEnabledProxyTools, getRuntimeConfig, getOrgProfile, type OrgTool } from "../org/store.js";
import { safeFetch, SsrfError } from "../net/ssrf.js";
import { redactDeep } from "../org/ingest/redact.js";
import { scrubPii } from "../org/ingest/pii-scrub.js";
import { markExternalTool } from "../org/policies/tool-log.js";
import { googleToolAuthHint } from "../org/credentials/google-oauth.js";
import { resolveProxyBearer, resolveOAuthMemberSecret } from "../org/credentials/oauth-proxy-auth.js";
import { channelSystemOf, channelPreCheck, channelPostFilter } from "../org/channels/channel-enforce.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
import { requireAppTool } from "../apps/principal.js";
import { HttpError } from "../http/rest-util.js";
import { isScope } from "../auth/scopes.js";
import { logger } from "../log.js";

// http_proxy·MCP 프록시 호출 scope 로 허용되는 집합(B19) — fleet 제어(admin/runtime)·무권한(null) 불가.
//  프록시 툴이 admin 표면을 자가호출하지 못하게 하는 2차 게이트(#746 T1 도 재사용).
export const CALLABLE_SCOPES = new Set(["items", "context", "db", "memory", "code"]);

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

// ── 경로 템플릿(#1655) ──────────────────────────────────────────────────────────────────────
//  B17 은 "인자로 scheme/host/path 를 **바꾸지 못한다**" 였고 그건 그대로다. 다만 구글 클래식 API 는 리소스 id 가
//  경로에 있어(`/drive/v3/files/{fileId}`, `/gmail/v1/users/me/messages/{id}`) 고정 URL 만으로는 **검색은 되는데
//  읽기가 안 된다.** 그래서 '관리자가 URL 에 명시적으로 뚫어 둔 자리'에 한해, 인자가 **경로 한 칸**을 채우게 한다.
//
//  안전 규칙 — 자리표시가 경로 조작 통로가 되지 않게 세 겹으로 막는다:
//   ① 값은 encodeURIComponent — 슬래시·물음표·샵이 전부 인코딩돼 한 칸을 못 넘는다.
//   ② `.`·`..` 는 인코딩돼도 그대로라 URL 정규화가 상위로 올려버린다 → 값 단계에서 거부.
//   ③ 치환 후 최종 URL 의 origin + 고정 prefix 를 템플릿과 대조 — ①② 를 빠져나간 무엇이 있어도 여기서 걸린다.
const URL_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 이 URL 이 경로 자리표시를 쓰는가(저장 검증·등록 경로가 묻는다). */
export function urlTemplateKeys(rawUrl: string): string[] {
  return [...String(rawUrl ?? "").matchAll(URL_PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * 템플릿 URL + 인자 → 최종 URL. 자리표시가 없으면 종전과 완전히 동일하게 동작한다(무회귀).
 *  consumed = 경로로 소비된 키 — 호출자는 이 키를 query/body 에 **다시 싣지 않는다**(중복 방지).
 */
export function applyUrlTemplate(rawUrl: string, args: Record<string, unknown>): { url: URL; consumed: Set<string> } {
  const consumed = new Set<string>();
  const keys = urlTemplateKeys(rawUrl);
  if (keys.length === 0) return { url: new URL(rawUrl), consumed }; // 자리표시 없음 — 종전 경로

  const fixedPrefix = rawUrl.slice(0, rawUrl.indexOf("{")); // 첫 자리표시 앞까지는 어떤 인자로도 바뀌지 않아야 한다
  const filled = rawUrl.replace(URL_PLACEHOLDER_RE, (_m, key: string) => {
    const raw = args?.[key];
    if (raw === undefined || raw === null || (typeof raw !== "string" && typeof raw !== "number")) {
      throw new Error(`경로 인자 '${key}' 가 필요합니다`);
    }
    const v = String(raw);
    if (!v) throw new Error(`경로 인자 '${key}' 가 비어 있습니다`);
    if (v === "." || v === "..") throw new Error(`경로 인자 '${key}' 값이 허용되지 않습니다`);
    consumed.add(key);
    return encodeURIComponent(v);
  });

  const url = new URL(filled);
  const base = new URL(rawUrl.replace(URL_PLACEHOLDER_RE, "x")); // 템플릿의 origin(자리표시를 무해한 값으로 채워 파싱)
  // ③ 최종 대조 — origin 이 그대로이고 고정 prefix 가 살아 있어야 한다(정규화로 경로가 깎이면 여기서 걸린다).
  if (url.origin !== base.origin) throw new Error("경로 인자가 대상 호스트를 바꾸려 했습니다");
  if (!`${url.origin}${url.pathname}`.startsWith(fixedPrefix)) throw new Error("경로 인자가 고정 경로를 벗어나려 했습니다");
  return { url, consumed };
}

/**
 * 실제로 나가는 요청(URL·본문) 조립 — runHttpProxyTool 이 그대로 쓴다.
 *  분리한 이유는 테스트다: 이걸 호출부 안에 두면 테스트가 조립 규칙을 **재구현**하게 되고, 그 순간 관측 장치가
 *  실물이 아니라 사본을 보게 된다(실제로 그렇게 썼다가 '경로 키를 query 에 중복 적재' mutation 을 놓쳤다).
 */
export function buildProxyRequest(rawUrl: string, method: string, args: Record<string, unknown>): { url: URL; body?: string } {
  const { url, consumed } = applyUrlTemplate(rawUrl, args ?? {});
  const m = (method || "GET").toUpperCase();
  if (m === "GET" || m === "DELETE" || m === "HEAD") {
    for (const [k, v] of Object.entries(args ?? {})) {
      if (consumed.has(k)) continue; // 경로로 이미 쓴 키 — query 에 중복해 싣지 않는다
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return { url };
  }
  const rest = Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => !consumed.has(k)));
  return { url, body: JSON.stringify(rest) };
}

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

// 상류가 HTTP 2xx 로 실패를 돌려주는가 — 봉투(envelope) 판정(#1881).
//  슬랙 Web API 는 **모든 실패가 HTTP 200 + `{"ok":false,"error":"…"}`** 다(not_in_channel·missing_scope·invalid_auth 전부).
//  HTTP 상태만 보면 실패가 성공으로 보이고, 그 뒤의 계측(mcp_call_log.ok)·isError 가 전부 거짓이 된다 — #1652 에서 구글
//  403 이 `ok=true` 로 찍혀 관리탭 오류 수가 0 이던 것과 같은 함정. 최상위 `ok === false` 는 어느 상류든 실패라는 뜻이
//  분명하므로(성공 응답에 ok:false 를 싣는 API 는 없다) 벤더 분기 없이 일반 규칙으로 둔다. JSON 이 아니거나 ok 필드가
//  없으면 판정하지 않는다(모르는 걸 실패로 단정하면 멀쩡한 응답을 에러로 만든다).
export function envelopeFailed(body: string): boolean {
  const s = body.trimStart();
  if (!s.startsWith("{")) return false;
  try {
    const j = JSON.parse(s) as { ok?: unknown };
    return j !== null && typeof j === "object" && j.ok === false;
  } catch { return false; }
}

// http_proxy 툴 1회 호출 — 인증(env 또는 per-user vault) + url 고정 + args 는 query/body 로만 + 응답 redact(+옵션 PII 스크럽).
//  callerId(P1 #746): tool.auth_kind 설정 시 이 멤버의 vault 자격으로 인증(요청자 귀속). 미설정이면 종전 auth_env(조직 공용).
//  #1881: 대화 시스템(슬랙) 도구면 채널별 개인 정책(#1226)을 A 어댑터와 **같은 함수**로 집행한다 — 사전 게이트·사후 필터.
export async function runHttpProxyTool(tool: OrgTool, args: Record<string, unknown>, callerId?: string | null): Promise<ProxyResult> {
  if (!tool.url) throw new Error("툴 url 미설정");
  const cfg = await getRuntimeConfig();

  // ── 채널별 개인 열람/발송 정책 ① 인자 게이트 — 설정 조회 실패도, 정책 거부도 호출을 내보내지 않는다(fail-closed).
  const pre = await channelPreCheck({ callerId, system: channelSystemOf(tool), toolName: tool.name, level: tool.level, args });
  if (!pre.ok) throw new Error(pre.reason);
  const enforcement = pre.enf;
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
    // #1881 G2: 구글 구 kind 3종은 통합 슬롯(google_oauth)으로 폴백한다 — 구 슬롯이 있으면 그게 먼저다(무회귀).
    const resolved = await resolveOAuthMemberSecret(callerId, tool.auth_kind, { scopeKey: tool.auth_scope_key ?? "", allowFallback });
    if (!resolved || !resolved.secret) {
      // 구글은 붙여넣기 경로를 없앴으므로(#1881) 그쪽으로 안내하면 사람이 갈 곳이 없다 — 눌러야 할 버튼을 말해 준다.
      throw new Error(
        googleToolAuthHint(tool.auth_kind, null) ??
        `자격 없음 — 이 툴은 '${tool.auth_kind}' 자격이 필요합니다. ` +
        (allowFallback ? "개인 자격을 '내 자격'(me_credential_set)에 등록하거나 관리자에게 통합 자격 설정을 요청하세요."
                       : "이 등급(L2/집행)은 개인 자격이 필수입니다 — '내 자격'(me_credential_set)에 등록하세요."),
      );
    }
    // ⚠ 슬롯은 잡혔는데 그 동의에 이 서비스 범위가 없으면 호출해 봐야 상류 403 이다. 그 403 은 화면에
    //  "권한 없음"으로만 보여서 **무엇을 눌러야 하는지**가 안 나온다 — 여기서 미리 끊고 다음 행동을 말한다.
    //  범위를 모르면(meta.scope 없음) 막지 않는다: 모르는 것으로 사람을 막는 쪽이 더 비싸다.
    const scopeHint = googleToolAuthHint(tool.auth_kind, String(resolved.meta?.scope ?? ""));
    if (scopeHint) throw new Error(scopeHint);
    // OAuth 자격이면 묶음에서 access token 을 뽑고(만료면 갱신) 그것만 싣는다(#1654). 정적 토큰은 그대로 통과.
    // ⚠ tool.auth_kind 가 아니라 **실제로 잡힌 슬롯의 kind** 를 넘긴다 — 별칭으로 통합 슬롯이 잡혔는데
    //  구 kind 를 넘기면 갱신이 구 OAuth 클라이언트를 찾아 실패한다(토큰은 새 클라이언트가 발급한 것).
    const bearer = await resolveProxyBearer(resolved, resolved.kind);
    const built = buildProxyAuthHeaders(resolved.meta, bearer);
    Object.assign(headers, built.headers);
    injectedSecret = bearer; // 응답 스크럽 대상은 **실제로 실린 값** — 묶음 전체가 아니라 access token(갱신됐으면 새 것)
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
  // scheme/host 는 저장값 고정(B17). path 는 관리자가 URL 에 뚫어 둔 자리표시에 한해 인자가 **한 칸**을 채운다(#1655).
  const { url: base, body } = buildProxyRequest(tool.url, method, args ?? {});
  if (body !== undefined) headers["Content-Type"] = "application/json";

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
  // 봉투 판정은 **원문**으로 — 스크럽이 `"ok":false` 를 건드리진 않지만, 판정 근거는 상류가 준 그대로가 맞다.
  const httpOk = res.status >= 200 && res.status < 300;
  const ok = httpOk && !envelopeFailed(res.body);
  // 채널 정책 ② 응답 필터 — ⚠ redact·PII 스크럽보다 **먼저**(저들이 텍스트를 고치면 JSON 이 깨져 항목 단위로 못 도려낸다).
  //  http_proxy 응답은 본문 문자열 하나라 text 블록 하나로 감싸 같은 필터를 태우고 다시 꺼낸다.
  let rawBody = res.body;
  if (enforcement.gate) {
    const filtered = await channelPostFilter(enforcement, tool.name, [{ type: "text", text: rawBody }]);
    const blk = filtered[0] as { type?: string; text?: string } | undefined;
    rawBody = typeof blk?.text === "string" ? blk.text : "";
  }
  let cleanBody = redactDeep(rawBody).slice(0, 256 * 1024); // 응답 본문 redact(에코된 토큰 등 차단)
  // 주입한 자격이 응답에 그대로 에코될 경우 대비 — redactDeep 의 정적 패턴이 못 잡는 임의 벤더 토큰을 리터럴로 스크럽(#746 리뷰).
  if (injectedSecret && injectedSecret.length >= 8) cleanBody = cleanBody.split(injectedSecret).join("[REDACTED]");
  if (tool.pii_scrub) cleanBody = scrubPii(cleanBody).text; // P3(#746) 비정형 PII 마스킹(응답에 섞인 개인정보, 평문 문자열)
  return { status: res.status, body: cleanBody, truncated: res.truncated, ok };
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
    // 감사로그 인자 정책 신고(#1082) — http_proxy 도 조직 밖으로 나가는 통신이다. 프록시 MCP 와 달리 툴 이름이 관리자
    //  지정(임의)이라 ext__ 접두 백스톱이 안 걸린다 → **이 신고가 유일한 경로**다. 등록 경로를 바꿀 때 같이 옮겨야 한다.
    markExternalTool(tool.name, tool.log_args);
    server.registerTool(
      tool.name,
      {
        title: tool.title || tool.name, description: tool.description || "", inputSchema: shape,
        //  #2243 3차 — A 레인(mcp-proxy)은 이미 내보내던 힌트를 B 레인도 내보낸다. 이게 없으면 GitHub 이슈 만들기·
        //   Slack 메시지 보내기가 «파괴적»이라는 표식 없이 하네스에 나가, 컨펌 UX 가 그 줄을 조용히 지나친다.
        annotations: { readOnlyHint: tool.level === "L0", destructiveHint: tool.level === "L2" },
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const u: LivelyUser = resolveUser(extra);
        requireScope(u, callScope);
        await requireAppTool(u, tool.name); // #1780: 앱 세션이면 ext_tools allowlist 로 축소(일반 세션 통과)
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

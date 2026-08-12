// delivery ▸ tools — AI 도구(툴) CRUD(runtime 권한).
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import { assertSafeJsonSchema } from "../../mcp/dynamic-tools.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { isBuiltinToolName, toolCandidates } from "../../mcp/mcp-surface.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import { getRuntimeConfig, updateRuntimeConfig, listTools, upsertTool, removeTool, type ToolKind, type OrgToolInput } from "../../org/store.js";
import { HTTP_TOOL_PRESETS, httpToolPresetToInput } from "../../org/delivery/http-tool-presets.js";
import { actorOf, restRuntime, str, wctx } from "./shared.js";

const TOOL_SCOPES = new Set(["items", "context", "db", "memory", "code"]); // http_proxy 호출 권한(admin·null 불가)
const TOOL_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const toolsCapabilities: Capability[] = [
  // ════════ MCP 툴 CRUD (runtime 권한) ════════
  restRuntime("org_tools", "AI 도구(툴) 목록",
    "조직 정의 MCP 툴(http_proxy) + 빌트인 토글 상태 + 툴 정책(allowlist) — runtime 권한 전용.",
    [{ method: "GET", paths: ["/api/ui/org/tools"], parse: () => ({}) }],
    async () => {
      const cfg = await getRuntimeConfig();
      return {
        tools: await listTools(), builtins: toolCandidates(),
        toolPolicy: { allowed_auth_envs: cfg.allowed_auth_envs, url_allowlist: cfg.url_allowlist },
        meaning: MEANING["tool"],
      };
    }),
  restRuntime("org_tool_upsert", "AI 도구 추가·수정",
    "조직 MCP 툴을 저장한다(runtime). http_proxy=사내 API 래핑(게이트웨이가 즉시 노출), builtin=빌트인 on/off·auto_approve.",
    [{ method: "POST", paths: ["/api/ui/org/tool"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const kind = input.kind === undefined ? "http_proxy" : str(input.kind, "kind", 12);
      if (kind !== "http_proxy" && kind !== "builtin") throw new HttpError(400, "kind 는 http_proxy|builtin 만 허용됩니다(prompt 미지원)");
      const rawName = str(input.name, "name", 64).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawName)) throw new HttpError(400, "name 은 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작)여야 합니다");
      if (kind === "http_proxy" && isBuiltinToolName(rawName)) throw new HttpError(400, `name '${rawName}' 는 빌트인 도구와 충돌합니다`);
      if (kind === "builtin" && !isBuiltinToolName(rawName)) throw new HttpError(400, `'${rawName}' 는 빌트인 도구가 아닙니다(kind=builtin 은 빌트인 토글 전용)`);
      const base: OrgToolInput = {
        name: rawName, kind: kind as ToolKind,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        auto_approve: input.auto_approve === undefined ? undefined : Boolean(input.auto_approve),
        // 주입모드(#187): undefined=유지, null=코드기본 복귀, true=항상 주입, false=deferred. 빌트인 토글 전용(Claude Code _meta).
        always_load: input.always_load === undefined ? undefined : (input.always_load === null ? null : Boolean(input.always_load)),
        title: input.title == null ? undefined : str(input.title, "title", 200).trim(),
        description: input.description == null ? undefined : str(input.description, "description", 2000),
        note: input.note == null ? undefined : str(input.note, "note", 500),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      };
      if (kind === "http_proxy") {
        const scope = str(input.scope ?? "items", "scope", 12);
        if (!TOOL_SCOPES.has(scope)) throw new HttpError(400, `scope 는 ${[...TOOL_SCOPES].join("|")} 만 허용됩니다(admin·null 불가)`);
        const method = (input.method === undefined ? "GET" : str(input.method, "method", 8)).toUpperCase();
        if (!TOOL_METHODS.has(method)) throw new HttpError(400, "method 는 GET|POST|PUT|PATCH|DELETE");
        const url = str(input.url, "url", 1000).trim();
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new HttpError(400, "url 은 절대 URL 이어야 합니다"); }
        if (parsed.protocol !== "https:") throw new HttpError(400, "url 은 https 여야 합니다");
        assertNoHardSecrets(url, "url");
        if (input.input_schema !== undefined && input.input_schema !== null) assertSafeJsonSchema(input.input_schema);
        let authEnv: string | null = null;
        if (input.auth_env !== undefined && input.auth_env !== null && input.auth_env !== "") {
          authEnv = str(input.auth_env, "auth_env", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) throw new HttpError(400, "auth_env 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
          const cfg = await getRuntimeConfig();
          if (!cfg.allowed_auth_envs.includes(authEnv)) {
            throw new HttpError(400, `auth_env '${authEnv}' 는 허용 목록(allowed_auth_envs)에 없습니다 — 런타임 설정에 먼저 추가하세요`);
          }
        }
        base.scope = scope;
        base.method = method;
        base.url = url;
        base.auth_env = authEnv;
        base.input_schema = input.input_schema ?? undefined;
        // P2(#746) 등급 — L0/L1/L2. L2 는 auto_approve 강제 제외(집행은 하네스 컨펌).
        if (input.level !== undefined) {
          const lvl = input.level === null ? null : str(input.level, "level", 2).toUpperCase();
          if (lvl !== null && lvl !== "L0" && lvl !== "L1" && lvl !== "L2") throw new HttpError(400, "level 은 L0|L1|L2");
          base.level = lvl as "L0" | "L1" | "L2" | null;
        }
        // P1(#746) per-user vault 인증 — auth_kind 설정 시 auth_env 대신 member_secret 로 해소(요청자 개인 자격 우선).
        //  auth_env 와 동시 지정 금지(인증 출처 하나만). auth_kind 형식은 member_secret_store 와 동일 정규식.
        if (input.auth_kind !== undefined && input.auth_kind !== null && input.auth_kind !== "") {
          const ak = str(input.auth_kind, "auth_kind", 40).trim().toLowerCase();
          if (!/^[a-z0-9_]{1,40}$/.test(ak)) throw new HttpError(400, "auth_kind 는 소문자·숫자·_ 1~40자여야 합니다");
          if (authEnv) throw new HttpError(400, "auth_env 와 auth_kind 는 동시에 쓸 수 없습니다(인증 출처 하나만)");
          base.auth_kind = ak;
          if (input.auth_scope_key !== undefined && input.auth_scope_key !== null && input.auth_scope_key !== "") {
            const sk = str(input.auth_scope_key, "auth_scope_key", 120).trim();
            if (!/^[A-Za-z0-9._:-]{0,120}$/.test(sk)) throw new HttpError(400, "auth_scope_key 형식 오류");
            base.auth_scope_key = sk;
          } else base.auth_scope_key = null;
        } else if (input.auth_kind === null || input.auth_kind === "") {
          base.auth_kind = null; base.auth_scope_key = null;
        }
        if (input.pii_scrub !== undefined) base.pii_scrub = Boolean(input.pii_scrub);
        if (input.log_args !== undefined) base.log_args = Boolean(input.log_args); // #1082
      }
      return { tool: await upsertTool(base, wctx(user, ctx)) };
    }, {
      name: z.string().describe("툴 이름 — 소문자 영숫자/_/- 1~64자(소문자·숫자로 시작). kind=builtin 이면 빌트인 도구 이름이어야 한다"),
      kind: z.enum(["http_proxy", "builtin"]).optional().describe("http_proxy=사내 API 래핑(기본) · builtin=빌트인 토글(prompt 미지원)"),
      enabled: z.boolean().optional().describe("노출 여부"),
      auto_approve: z.boolean().optional().describe("하네스 컨펌 없이 자동 승인(level=L2 는 강제 제외)"),
      always_load: z.boolean().nullable().optional().describe("상시주입(#187). undefined=유지, null=코드기본 복귀, true=항상 주입, false=deferred. 빌트인 토글 전용(Claude Code _meta)"),
      title: z.string().optional().describe("표시명"),
      description: z.string().optional().describe("툴 설명(에이전트가 읽는다)"),
      note: z.string().optional().describe("메모"),
      sort: z.number().optional().describe("정렬 순서"),
      // ↓ kind=http_proxy 전용
      scope: z.enum(["items", "context", "db", "memory", "code"]).optional().describe("http_proxy 호출 권한(기본 items — admin·null 불가)"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("http_proxy HTTP 메서드(기본 GET)"),
      url: z.string().optional().describe("http_proxy 대상 절대 URL(https 필수). 평문 시크릿 hard-block"),
      input_schema: z.record(z.unknown()).optional().describe("http_proxy 툴의 JSON Schema 입력 정의(단순 평면 스키마)"),
      auth_env: z.string().optional().describe("인증에 쓸 환경변수 **이름**(값 금지). allowed_auth_envs 허용목록에 있어야 하며 auth_kind 와 동시 사용 불가"),
      level: z.enum(["L0", "L1", "L2"]).nullable().optional().describe("P2 등급(#746) — L2 는 auto_approve 강제 제외(집행은 하네스 컨펌)"),
      auth_kind: z.string().nullable().optional().describe("P1 per-user vault 인증 종류(소문자·숫자·_ 1~40자) — 지정 시 auth_env 대신 요청자 개인 자격으로 해소"),
      auth_scope_key: z.string().nullable().optional().describe("auth_kind 의 스코프 키(선택)"),
      pii_scrub: z.boolean().optional().describe("응답 PII 스크럽 여부"),
      log_args: z.boolean().optional().describe("#1082 — 호출 인자 '값'을 감사로그에 저장할지. 기본 false(값 미저장). 끈 상태에서도 호출 사실은 남는다"),
    }),
  // ════════ http_proxy 도구 프리셋 (#1655·#1656) ════════
  //  프리셋은 코드에 SoT 가 있고(http-tool-presets.ts) 실제 노출은 org_tool 행이다. 그 사이를 잇는 창구.
  restRuntime("org_http_tool_presets", "http_proxy 도구 프리셋 목록",
    "코드에 정의된 http_proxy 도구 프리셋(구글 3종 등)과 이 조직의 적용 상태. applied=이미 org_tool 로 심어진 도구, " +
    "hosts_missing=url_allowlist 에 없어서 지금 적용해도 전부 차단될 호스트. 적용은 org_http_tool_preset_apply.",
    [{ method: "GET", paths: ["/api/ui/org/http-tool-presets"], parse: () => ({}) }],
    async () => {
      const [cfg, existing] = await Promise.all([getRuntimeConfig(), listTools()]);
      const have = new Set(existing.map((t) => t.name));
      const allow = new Set(cfg.url_allowlist);
      return {
        groups: HTTP_TOOL_PRESETS.map((g) => ({
          key: g.key, label: g.label, auth_kind: g.auth_kind, hosts: g.hosts, scope: g.scope, level: g.level,
          hosts_missing: g.hosts.filter((h) => !allow.has(h.toLowerCase())),
          tools: g.tools.map((t) => ({ name: t.name, title: t.title, applied: have.has(t.name), pii_scrub: t.pii_scrub })),
        })),
      };
    }),
  restRuntime("org_http_tool_preset_apply", "http_proxy 도구 프리셋 적용",
    "프리셋 묶음을 org_tool 로 심는다(즉시 노출). 필요한 상류 호스트를 url_allowlist 에 함께 추가한다 — allowlist 는 " +
    "deny-all 기본이라 이걸 빠뜨리면 심어도 전부 차단된다. 같은 이름의 도구가 있으면 덮어쓴다(멱등). " +
    "⚠ 이 도구들은 per-member OAuth 자격을 쓴다 — 구성원이 '내 자격'에서 연결해 두지 않으면 호출 시 '자격 없음'이 된다.",
    [{ method: "POST", paths: ["/api/ui/org/http-tool-presets/apply"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const key = str(input.key, "key", 64).trim();
      const group = HTTP_TOOL_PRESETS.find((g) => g.key === key);
      if (!group) throw new HttpError(400, `그런 프리셋 묶음이 없습니다: ${key} (가능: ${HTTP_TOOL_PRESETS.map((g) => g.key).join(", ")})`);
      const applied: string[] = [];
      for (const t of group.tools) {
        await upsertTool(httpToolPresetToInput(group, t), wctx(user, ctx)); // 프리셋 자기검증이 여기서 먼저 돈다
        applied.push(t.name);
      }
      // allowlist 병합 — 기존 항목은 건드리지 않는다(다른 커넥터가 쓰고 있을 수 있다).
      const cfg = await getRuntimeConfig();
      const want = group.hosts.map((h) => h.toLowerCase());
      const addedHosts = want.filter((h) => !cfg.url_allowlist.includes(h));
      if (addedHosts.length) {
        await updateRuntimeConfig({ url_allowlist: [...cfg.url_allowlist, ...addedHosts] }, actorOf(user), ctx?.source ?? "web");
      }
      return { ok: true, key, applied, added_hosts: addedHosts };
    }, {
      key: z.string().describe("적용할 프리셋 묶음 key(google-drive · google-gmail · google-calendar)"),
    }),
  restRuntime("org_tool_remove", "AI 도구 제거",
    "조직 MCP 툴을 제거한다(http_proxy=즉시 노출 중단, builtin 게이팅 행 제거=기본값 복귀).",
    [{ method: "POST", paths: ["/api/ui/org/tool/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const name = str(input.name, "name", 64).trim().toLowerCase();
      await removeTool(name, wctx(user, ctx));
      return { ok: true };
    }, {
      name: z.string().describe("제거할 툴 이름 — http_proxy=즉시 노출 중단, builtin 게이팅 행 제거=기본값 복귀"),
    }),
];

// delivery ▸ mcp-servers — MCP 서버 레지스트리(프리셋·추가/수정·제거·프록시 스냅샷 발행).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import { refreshProxySnapshot } from "../../mcp/mcp-proxy.js";
import { broadcastToolListChanged } from "../../mcp-sessions.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { listMcpServers, upsertMcpServer, removeMcpServer } from "../../org/store.js";
import { MCP_SERVER_PRESETS } from "../../org/delivery/mcp-server-presets.js";
import { actorOf, restOnly, restRead, slug, str } from "./shared.js";

export const mcpServersCapabilities: Capability[] = [
  // ── MCP 서버 레지스트리 ──
  restRead("org_mcp_servers", "MCP 서버 목록 조회",
    "활성 MCP 서버 목록(client+proxy 전체) — 관리탭 자격화면 상태칩(catalogStatusCard)이 프리셋 대비 '등록됨' 표시에 쓴다. ⚠ 클라 직접등록(레인 C) 소스가 아니다 — 그건 발행 번들 .lively/mcp-servers.json(publish.ts→toClientBundleServers, mode='client'만)이다. 여기에 클라 등록 consumer 를 붙이려면 반드시 mode='client' 로 필터(proxy=게이트웨이 대리, 직결 금지 — #894). 시크릿 없음(auth_env=변수명).",
    [{ method: "GET", paths: ["/api/ui/org/mcp-servers"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const all = await listMcpServers();
      // servers_all(#1169) — org_overview 가 admin 에게 주던 **전량**(모든 필드 · disabled 포함)을 같은 모양으로.
      //  위 servers 는 상태칩 전용 축약(활성 + 접속정보 있는 것만, 6개 필드)이라 관리 목록으로는 쓸 수 없다.
      //  시크릿은 어느 쪽에도 없다(auth_env 는 환경변수 '이름').
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      return {
        servers: all.filter((s) => s.enabled && (s.transport === "stdio" ? !!s.command : !!s.url)).map((s) => ({
          name: s.name, transport: s.transport, url: s.url, command: s.command, auth_env: s.auth_env, enabled: s.enabled,
        })),
        servers_all: isAdmin ? all : null, meaning: { "mcp-server": MEANING["mcp-server"], mcp: MEANING["mcp"] },
      };
    }, true),
  // 외부 도구 서버(MCP) 기본 프리셋. 구 이름 org_connector_catalog / /org/connector-catalog 는 **오해를 부르는
  //  이름이었다**(#837) — 담긴 건 org_connector(패시브 미러)가 아니라 org_mcp_server 다. 개명하되 **구 REST 경로는
  //  별칭으로 남긴다**(이미 배포된 클라이언트 보호). MCP 툴 이름은 세션마다 tools/list 로 새로 발견되므로 개명해도 안전.
  restOnly("org_mcp_server_presets", "외부 도구 서버(MCP) 기본 프리셋",
    "관리탭 [AI 도구 ▸ 외부 도구 서버] 추가 시 프리셋으로 채우는 기본 MCP 서버 정본(호스팅 OAuth). 코드 SoT(mcp-server-presets.ts). 시크릿 없음. ※ 외부 자료 수집(org_connector 미러)과는 무관하다 — 구 이름 org_connector_catalog.",
    [{ method: "GET", paths: ["/api/ui/org/mcp-server-presets", "/api/ui/org/connector-catalog"], parse: () => ({}) }],
    async () => ({ catalog: MCP_SERVER_PRESETS })),
  restOnly("org_mcp_upsert", "MCP 서버 추가·수정",
    "조직 MCP 서버를 저장한다. transport http(url)|stdio(command). 인증은 auth_env(환경변수 이름만 — 시크릿 금지).",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const name = slug(input.name, "name");
      let transport: "http" | "stdio" | undefined;
      if (input.transport !== undefined) {
        const t = str(input.transport, "transport", 10);
        if (t !== "http" && t !== "stdio") throw new HttpError(400, "transport 는 http|stdio 만 허용됩니다");
        transport = t;
      }
      let authEnv: string | null | undefined;
      if (input.auth_env !== undefined) {
        if (input.auth_env === null || input.auth_env === "") authEnv = null;
        else {
          authEnv = str(input.auth_env, "auth_env", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv)) throw new HttpError(400, "auth_env 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
        }
      }
      // A-어댑터(#746 T1) proxy 필드 — mode=proxy 면 게이트웨이가 상류 MCP 를 프록시(통제·재노출). auth_kind=per-member vault 인증.
      let level: "L0" | "L1" | "L2" | null | undefined;
      if (input.level !== undefined) {
        const lv = input.level === null ? null : str(input.level, "level", 2).toUpperCase();
        if (lv !== null && lv !== "L0" && lv !== "L1" && lv !== "L2") throw new HttpError(400, "level 은 L0|L1|L2");
        level = lv as "L0" | "L1" | "L2" | null;
      }
      let authKind: string | null | undefined;
      if (input.auth_kind !== undefined) {
        if (input.auth_kind === null || input.auth_kind === "") authKind = null;
        else {
          authKind = str(input.auth_kind, "auth_kind", 40).trim().toLowerCase();
          if (!/^[a-z0-9_]{1,40}$/.test(authKind)) throw new HttpError(400, "auth_kind 는 소문자·숫자·_ 1~40자");
        }
      }
      const server = await upsertMcpServer({
        name, transport,
        url: input.url === undefined ? undefined : (input.url === null || input.url === "" ? null : str(input.url, "url", 1000).trim()),
        command: input.command === undefined ? undefined : (input.command === null || input.command === "" ? null : str(input.command, "command", 2000).trim()),
        auth_env: authEnv,
        note: input.note == null ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
        mode: input.mode === undefined ? undefined : (str(input.mode, "mode", 10) === "proxy" ? "proxy" : "client"),
        scope: input.scope === undefined ? undefined : (input.scope === null || input.scope === "" ? null : str(input.scope, "scope", 20)),
        level,
        pii_scrub: input.pii_scrub === undefined ? undefined : Boolean(input.pii_scrub),
        log_args: input.log_args === undefined ? undefined : Boolean(input.log_args),
        auth_kind: authKind,
        auth_scope_key: input.auth_scope_key === undefined ? undefined : (input.auth_scope_key === null || input.auth_scope_key === "" ? null : str(input.auth_scope_key, "auth_scope_key", 120).trim()),
        auth_mode: input.auth_mode === undefined ? undefined : ((): "bearer" | "oauth" | "sigv4" | null => {
          if (input.auth_mode === null || input.auth_mode === "") return null;
          const v = str(input.auth_mode, "auth_mode", 10);
          if (v !== "bearer" && v !== "oauth" && v !== "sigv4") throw new HttpError(400, "auth_mode 는 bearer|oauth|sigv4 만 허용됩니다");
          return v;
        })(),
      }, actorOf(user), "web");
      return { server };
    }, {
      name: z.string().describe("MCP 서버 이름(slug)"),
      transport: z.enum(["http", "stdio"]).optional(),
      url: z.string().nullable().optional().describe("http transport URL"),
      command: z.string().nullable().optional().describe("stdio transport 실행 커맨드"),
      auth_env: z.string().nullable().optional().describe("인증 env 변수 이름(시크릿 값 금지)"),
      note: z.string().optional(),
      enabled: z.boolean().optional(),
      sort: z.number().optional(),
      mode: z.enum(["client", "proxy"]).optional().describe("client=멤버 클라 직접등록(기존) / proxy=게이트웨이 프록시(통제·재노출, #746)"),
      scope: z.string().nullable().optional().describe("proxy 툴 접근 scope(items|context|db|memory|code)"),
      level: z.enum(["L0", "L1", "L2"]).nullable().optional(),
      pii_scrub: z.boolean().optional(),
      log_args: z.boolean().optional().describe("#1082 — 이 서버 프록시 툴의 호출 인자 '값'을 감사로그에 저장할지. 기본 false(값 미저장: 슬랙 DM·메일 본문 등이 남지 않게). 끈 상태에서도 호출 사실은 남는다"),
      auth_kind: z.string().nullable().optional().describe("proxy per-member vault 인증 kind"),
      auth_scope_key: z.string().nullable().optional(),
      auth_mode: z.enum(["bearer", "oauth", "sigv4"]).nullable().optional().describe("bearer=정적토큰(기본) / oauth=per-member OAuth(T2) / sigv4=AWS 요청서명(#746)"),
    }),
  restOnly("org_mcp_refresh", "MCP 프록시 스냅샷 새로고침(발행)",
    "proxy 모드 MCP 서버의 상류 tools/list 를 다시 캡처해 스냅샷(핀)으로 저장한다 — 버전업/새 툴 반영. 다음 세션부터 구성원에 전파(재설치 0).",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server/refresh"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      let r: { count: number; gmailWriteProbe?: string };
      try {
        r = await refreshProxySnapshot(slug(input.name, "name"), actorOf(user));
      } catch (e) {
        // 상류 연결/tools 캡처 실패를 실제 메시지로 노출한다(구: generic 500 "internal_error" 로 뭉개져 원인 불명이었음).
        //  자격 리터럴은 refreshProxySnapshot 내부에서 이미 redact 됨.
        throw new HttpError(502, `발행 실패(상류 tools/list): ${(e as Error)?.message ?? String(e)}`);
      }
      // in-session push(#746 T5) — sessioned 클라들에 tools/list_changed 즉시 전파(무상태면 no-op). 발행=라이브 반영.
      const pushed = broadcastToolListChanged();
      return { ok: true, tool_count: r.count, live_pushed_sessions: pushed, ...(r.gmailWriteProbe ? { gmail_write_probe: r.gmailWriteProbe } : {}) };
    }, {
      name: z.string().describe("스냅샷을 다시 뜰 proxy 모드 MCP 서버 이름"),
    }),
  restOnly("org_mcp_remove", "MCP 서버 제거",
    "조직 MCP 서버를 제거한다.",
    [{ method: "POST", paths: ["/api/ui/org/mcp-server/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      await removeMcpServer(slug(input.name, "name"), actorOf(user), "web");
      return { ok: true };
    }, {
      name: z.string().describe("제거할 MCP 서버 이름"),
    }),
];

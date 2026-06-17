// capability 레지스트리 조립 + 어댑터 2개(Stage①).
// - registerMcpCapabilities(server, names): tools/*.ts 가 호출하는 MCP 자동 등록
//   (resolveUser→requireScope→handler→json, throw 는 SDK 가 isError:true 로 변환).
// - restMounts(): web.ts 가 순회 마운트하는 [capability, mount] 목록.
// - registry: 파리티 스크립트의 직접 핸들러 호출 fallback 용 export.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveUser, requireScope, type LivelyUser } from "../context.js";
import { contextCapabilities } from "./context.js";
import { ctxCapabilities } from "./ctx.js";
import { deliveryCapabilities } from "./delivery.js";
import { domainmapCurationCapabilities } from "./domainmap-curation.js";
import { itemCapabilities } from "./items.js";
import { mappingCapabilities } from "./mapping.js";
import { pmCapabilities } from "./pm.js";
import type { Capability, RestMount } from "./types.js";

// ── me — 토큰 게이트 확인(스코프 불요, REST 전용). 핸들러가 partial user 에서 null-default 구성. ──
const me: Capability = {
  name: "me",
  title: "인증 확인",
  description: "bearer 토큰의 principal 확인 — {userId, email, scopes}. 웹 토큰 게이트 전용.",
  scope: null,
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/me"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    const u = (user ?? {}) as Partial<LivelyUser>;
    return { userId: u.userId ?? null, email: u.email ?? null, scopes: u.scopes ?? [] };
  },
};

const all: Capability[] = [
  me, ...contextCapabilities, ...itemCapabilities, ...mappingCapabilities,
  ...domainmapCurationCapabilities, // propose_domain·domain_deprecate 만 expose.mcp=true(도메인 authoring), 나머지 REST 전용
  ...pmCapabilities, // MCP 31툴(기존 13 + pm 6 + domainmap authoring 2 + db_sources 1 + memory 3 + ctx 6 — db_*·memory_* 는 src/tools/{db,memory}.ts 직접 등록)
  ...ctxCapabilities, // ctx_*(P1b/P4a) — FS형 컨텍스트 6종(ls/grep/cat/save/overview/set_lifecycle, memory scope, co-exposed mcp+rest) — MCP 등록은 src/tools/memory.ts
  ...deliveryCapabilities, // 전달/관리(admin scope, REST 전용) — workflow-std 흡수: org-content 편집·발행·구성원·토큰
];

export const registry: Map<string, Capability> = new Map(all.map((c) => [c.name, c]));

const json = (d: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(d, null, 2) }] });

// MCP 어댑터 — 이름 목록을 받아 레지스트리에서 찾아 자동 등록. 미등록/비노출 이름은 부팅 시 즉시 throw
// (오타가 런타임까지 살아남지 않게).
export function registerMcpCapabilities(server: McpServer, names: string[]): void {
  for (const name of names) {
    const cap = registry.get(name);
    if (!cap) throw new Error(`capability '${name}' 레지스트리에 없음`);
    if (!cap.expose.mcp) throw new Error(`capability '${name}' 은 MCP 노출 대상이 아님`);
    server.registerTool(
      cap.name,
      { title: cap.title, description: cap.description, inputSchema: cap.input },
      async (args: Record<string, unknown>, extra: unknown) => {
        const u = resolveUser(extra);
        if (cap.scope) requireScope(u, cap.scope);
        return json(await cap.handler(args, u, { source: "mcp", actor: u.userId }));
      },
    );
  }
}

// REST 어댑터 입력 — web.ts 가 순회하며 동일 경로(+alias)에 마운트한다.
export function restMounts(): { cap: Capability; mount: RestMount }[] {
  const out: { cap: Capability; mount: RestMount }[] = [];
  for (const cap of registry.values()) {
    if (!cap.expose.rest) continue;
    for (const mount of cap.expose.rest) out.push({ cap, mount });
  }
  return out;
}

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
import { domainmapCrudCapabilities } from "./domainmap-crud.js";
import { mappingCapabilities } from "./mapping.js";
import { pmCapabilities } from "./pm.js";
import { activityCapabilities } from "./activity.js";
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
  me, ...contextCapabilities, ...mappingCapabilities,
  ...domainmapCurationCapabilities, // propose_domain·domain_deprecate 만 expose.mcp=true(도메인 authoring), 나머지 REST 전용
  ...domainmapCrudCapabilities, // P-V3-4a: repo/domain 통제어휘 CRUD 5종 + hard-delete 2종(domain_delete·repo_delete) — 전부 expose.mcp=true(MCP+REST)
  ...pmCapabilities, // MCP 36툴(hard-delete 2종 추가. item 폐기로 search_items/get_item 2종 제거: 기존 11 + pm 6 + domainmap authoring 2 + db_sources 1 + memory 3 + ctx 6 + crud 7 — db_*·memory_* 는 src/tools/{db,memory}.ts 직접 등록)
  ...ctxCapabilities, // ctx_*(P1b/P4a) — FS형 컨텍스트 6종(ls/grep/cat/save/overview/set_lifecycle, memory scope, co-exposed mcp+rest) — MCP 등록은 src/tools/memory.ts. item 흡수: ctx_ls/ctx_grep 에 system/since/source/type 필터 + ctx_cat thread.
  ...deliveryCapabilities, // 전달/관리(admin/runtime/read scope, REST 전용) — workflow-std 흡수: org-content 편집·발행·구성원·토큰 + learn(지식유형 ground-truth, P-V3-2)
  ...activityCapabilities, // P3: activity_log/activity_list — 작업(activity) 기록·조회(scope=memory, co-exposed). MCP 등록은 src/tools/activity.ts. 36→38.
];
// MCP 표면 = 39툴(P4 domain_set_should 추가 38→39. P3 activity_log·activity_list 36→38. hard-delete 2종 domain_delete·repo_delete. item 폐기 2026-06: search_items·get_item
//  제거로 36→34, hard-delete 로 34→36. ku 가 단일 캐노니컬 표면 —
//  활동검색은 ctx_ls/ctx_grep(system/since/source/type), 단건상세/스레드는 ctx_cat(thread:true) 가 흡수).
//  REST 전용 신엔드포인트(MCP 표면 불포함): GET /api/ui/learn(kind_registry+data_source ground-truth).
//  search_items/get_item 의 REST(/api/ui/items, /api/ui/items/:id)도 동반 제거 — 웹 app.js 미사용(영향 없음).

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

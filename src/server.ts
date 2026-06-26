import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDbTools } from "./tools/db.js";
import { registerMcpCapabilities } from "./capabilities/index.js";

// memory_* 폐기(2026-06-24) — knowledge_*(v6)로 통일(ctx_* 가 간 길). org_memory 웹 표면('WIKI 인덱스')은 delivery REST(/api/ui/org/memory) 유지.
// code_*: 보류 (개발자는 레포 내 네이티브 툴; 필요시 공식 GitHub MCP 래핑) — tools/code.ts 보존만
//
// overrides: 빌트인 노출 재정의 — org_tool(kind='builtin') 의 name→enabled. expose.mcp(코드 기본값)를 양방향으로 덮어쓴다.
//  · false 인 이름은 server.registerTool 래핑이 등록을 건너뛴다(db 직접등록 끄기 + 방어).
//  · capability 끄기/켜기 판정은 registerMcpCapabilities 가 일원화(expose.mcp:false 여도 override true 면 등록 → 래핑 통과).
//  alwaysLoadOverrides: 빌트인 주입모드 재정의 — org_tool(kind='builtin') 의 name→always_load(true/false). 코드기본(cap.meta)을 덮어쓴다.
//  harness: 이 요청의 하네스 신원(agentFromHeaders). _meta(anthropic/alwaysLoad)를 하네스별로 emit/생략하는 데 쓴다(#187).
export function buildServer(
  overrides?: ReadonlyMap<string, boolean>,
  alwaysLoadOverrides?: ReadonlyMap<string, boolean>,
  harness?: string | null,
): McpServer {
  const server = new McpServer({ name: "context-ontology", version: "0.1.0" });
  if (overrides && overrides.size) {
    const orig = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) =>
      overrides.get(name) === false ? undefined : (orig as (...a: unknown[]) => unknown)(name, ...rest)
    ) as typeof server.registerTool;
  }
  registerDbTools(server);                    // 제품 DB (읽기전용) — capability 밖, 직접 등록(override false 면 래핑이 스킵)
  registerMcpCapabilities(server, overrides, alwaysLoadOverrides, harness); // capability: expose.mcp 기본값 + org_tool override(양방향) + 주입모드 _meta
  return server;
}

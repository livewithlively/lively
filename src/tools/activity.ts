// 작업(activity) MCP 툴 등록 — capability 레지스트리의 thin 재등록(tools/memory.ts 의 ctx_* 패턴 동형).
//  activity_log/activity_list 는 capabilities/activity.ts 에 정의(scope='memory', co-exposed). 구조화 JSON 반환(parity 대상).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerActivityTools(server: McpServer): void {
  registerMcpCapabilities(server, ["activity_log", "activity_list"]);
}

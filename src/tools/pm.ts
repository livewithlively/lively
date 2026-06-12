// pm MCP 툴 — capability 레지스트리(src/capabilities/pm.ts)의 thin 재등록(tools/mapping.ts idiom).
// 이 이름 배열이 곧 MCP 노출 목록 — 오타는 registerMcpCapabilities 가 부팅 시 throw.
// 쓰기(write-through)이므로 per-user bearer 가 audit(pm_write, by=userId)에 실제 지시자를 기록한다.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerPmTools(server: McpServer): void {
  registerMcpCapabilities(server, [
    "pm_task_create",
    "pm_task_update_status",
    "pm_task_assign",
    "pm_task_comment",
    "pm_task_link",
    "pm_task_archive",
  ]);
}

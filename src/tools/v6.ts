// v6 MCP 툴 등록 — capability 레지스트리의 thin 재등록(tools/activity.ts·memory.ts 패턴 동형).
//  카테고리(8)·지식(8)·프로젝트/태스크(9)·휴지통(2) = 27툴. 입력검증=각 capability 의 zod input(REST 는 mount.parse).
//  레거시 등록(tools/context.ts·memory.ts·pm.ts)과 병행 — 컷오버까지 둘 다 노출.
//  삭제/복원은 expose.mcp=true 지만 핸들러가 source==='mcp'→403 으로 막는다(사람전용 — 비가역 큐레이션).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerV6Tools(server: McpServer): void {
  registerMcpCapabilities(server, [
    "category_list", "category_get", "category_create", "category_update", "category_delete",
    "category_edge_list", "category_edge_set", "category_edge_remove",
    "knowledge_list", "knowledge_get", "knowledge_save", "knowledge_set_lifecycle", "knowledge_delete", "knowledge_link_category",
    "knowledge_search", "knowledge_overview",
    "project_list_v6", "project_get_v6", "project_create_v6", "project_set_status_v6", "project_set_members_v6",
    "project_link_category_v6", "project_link_knowledge_v6", "task_create_v6", "task_set_status_v6",
    "deleted_list", "content_restore",
  ]);
}

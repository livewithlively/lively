import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "./tools/context.js";
import { registerDbTools } from "./tools/db.js";
import { registerItemTools } from "./tools/items.js";
import { registerMappingTools } from "./tools/mapping.js";
import { registerPmTools } from "./tools/pm.js";

// memory_*: 컷 (canonical 메모리는 git 컨텍스트 레포; 라이브는 향후 memory-타입 Item)
// code_*: 보류 (개발자는 레포 내 네이티브 툴; 필요시 공식 GitHub MCP 래핑) — tools/code.ts 보존만
export function buildServer(): McpServer {
  const server = new McpServer({ name: "context-ontology", version: "0.1.0" });
  registerContextTools(server); // 도메인/프로젝트/부채 (domainmap)
  registerDbTools(server);      // 제품 DB (읽기전용)
  registerItemTools(server);    // 크로스소스 Item (Slack/Jira/GitHub …)
  registerMappingTools(server); // item→domain/project 매핑 (inbox/후보/propose) — LLM seam
  registerPmTools(server);      // PM 쓰기(write-through ClickUp 미러) — phase B
  return server;
}

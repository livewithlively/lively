import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "./tools/context.js";
import { registerDbTools } from "./tools/db.js";
import { registerMappingTools } from "./tools/mapping.js";
import { registerPmTools } from "./tools/pm.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerV6Tools } from "./tools/v6.js";

// memory_*: 팀 공유 메모리(org_memory) 저장/검색 — memory scope. member 배포는 추가로 admin 필요(tools/memory.ts).
// code_*: 보류 (개발자는 레포 내 네이티브 툴; 필요시 공식 GitHub MCP 래핑) — tools/code.ts 보존만
//
// disabledBuiltins: (A) 빌트인 게이팅 — org_tool(kind='builtin', enabled=false) 로 끈 빌트인 툴 이름 집합.
//  register* 호출 전에 server.registerTool 을 감싸서 해당 이름의 등록을 건너뛴다(분산 register*.ts 무수정).
export function buildServer(disabledBuiltins?: ReadonlySet<string>): McpServer {
  const server = new McpServer({ name: "context-ontology", version: "0.1.0" });
  if (disabledBuiltins && disabledBuiltins.size) {
    const orig = server.registerTool.bind(server);
    server.registerTool = ((name: string, ...rest: unknown[]) =>
      disabledBuiltins.has(name) ? undefined : (orig as (...a: unknown[]) => unknown)(name, ...rest)
    ) as typeof server.registerTool;
  }
  registerContextTools(server); // 도메인/프로젝트/부채 (domainmap)
  registerDbTools(server);      // 제품 DB (읽기전용)
  // (search_items/get_item 폐기 — ku 단일표면. 활동검색=ctx_ls/ctx_grep, 단건상세/스레드=ctx_cat 이 흡수.)
  registerMappingTools(server); // item→domain/project 매핑 (inbox/후보/propose) — LLM seam
  registerPmTools(server);      // PM 쓰기(write-through ClickUp 미러) — phase B
  registerMemoryTools(server);  // 팀 공유 메모리 저장/검색 (memory scope) — org_memory
  registerActivityTools(server); // P3: 작업(activity) 기록/조회 (memory scope) — activity_log/activity_list
  registerV6Tools(server);      // v6: 카테고리(8)·지식(5)·프로젝트/태스크(9)=22툴 — 레거시(context/memory/pm)와 병행
  return server;
}

// 크로스소스 Item 검색 툴 — Stage① 부터 capability 레지스트리(src/capabilities/items.ts)의
// thin 재등록. canonical 페이로드(searchItemsUi/getItemUi)를 웹 REST 와 공유.
// 구 shape 폐기: search_items bare 배열→{rows}, get_item flat+raw 풀바디→중첩+클램프+thread,
// not-found 의 success-content {error:'not found'}→isError.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerItemTools(server: McpServer): void {
  registerMcpCapabilities(server, ["search_items", "get_item"]);
}

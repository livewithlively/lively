// 매핑 MCP 툴 — Stage① 부터 capability 레지스트리(src/capabilities/mapping.ts)의 thin 재등록.
// 다이어트: propose_item_domain/propose_item_project 툴 삭제 → 단일 쓰기 op curate_item_mapping
// (action: propose|confirm|reject). LLM 판단(D6/P5)은 인터랙티브 세션 전용 — programmatic 모델 클라이언트 없음.
// confirm/reject 는 세션 내 사람의 명시 지시가 있을 때만(툴 설명에 명문화, per-user bearer 가 audit 기록).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerMappingTools(server: McpServer): void {
  registerMcpCapabilities(server, ["list_unmapped", "mapping_candidates", "curate_item_mapping"]);
}

// 도메인/프로젝트 맥락 툴 — Stage① 부터 capability 레지스트리(src/capabilities/context.ts)의
// thin 재등록. 도메인 로직(domain_list 의 query 필터 포함)은 핸들러로 이동 — 웹 REST 와 동일 페이로드.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

export function registerContextTools(server: McpServer): void {
  registerMcpCapabilities(server, [
    "repo_list",         // domainmap ∪ 매핑테이블 union 객체(부분성공 내성)
    "context_overview",  // domainmap overview + items 통계 흡수
    "domain_list",
    "domain_get",
    "project_list",
    "debt_list",
    // 도메인 authoring 쓰기 2종(⑤) — capability 는 domainmap-curation 그룹 소속이지만
    // MCP 표면 등록은 도메인 패밀리인 여기서 한다(expose.mcp:true 플립과 원자 커밋).
    "propose_domain",
    "domain_deprecate",
  ]);
}

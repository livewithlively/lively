// 도메인 맥락 툴 — Stage① 부터 capability 레지스트리(src/capabilities/context.ts)의
// thin 재등록. 도메인 로직(domain_list 의 query 필터 포함)은 핸들러로 이동 — 웹 REST 와 동일 페이로드.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpCapabilities } from "../capabilities/index.js";

// v6 컷오버(2026-06): 레거시 domain_* / propose_domain 의 MCP 등록 제거 — v6 category_*(tools/v6.ts)가 대체.
//  capability 객체·REST 마운트는 보존(구 웹 탭 + domainmap 이 REST 로 계속 사용) — 여기 이름목록에서만 뺐다.
//  repo_*(통제어휘 CRUD·하드딜리트)·context_overview·debt_list 는 v6 미대체라 MCP 유지.
export function registerContextTools(server: McpServer): void {
  registerMcpCapabilities(server, [
    "repo_list",         // domainmap ∪ 매핑테이블 union 객체(부분성공 내성)
    "context_overview",  // domainmap overview + items 통계 흡수
    "debt_list",
    // P-V3-4a: repo 통제어휘 CRUD(domainmap-crud 그룹) — domain_* 는 v6 category_* 로 이관, repo_* 만 유지.
    "repo_create",
    "repo_rename",
    "repo_deprecate",
    // hard-delete(영구삭제) — deprecate(숨김)와 별개의 비가역 삭제. 핸들러가 agent(MCP) 금지 가드.
    "repo_delete",
  ]);
}

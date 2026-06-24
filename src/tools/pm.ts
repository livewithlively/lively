// pm MCP 툴 — capability 레지스트리(src/capabilities/pm.ts)의 thin 재등록(tools/mapping.ts idiom).
// 쓰기(write-through)이므로 per-user bearer 가 audit(pm_write, by=userId)에 실제 지시자를 기록한다.
//
// v6 컷오버(2026-06): 레거시 pm_task_*(create/update_status/assign/comment/link/archive) MCP 등록 제거 —
//  v6 project_*/task_*(tools/v6.ts)가 대체. pm capability 객체·REST 마운트는 보존(구 웹 탭이 REST 로 계속 사용).
//  MCP 노출 이름이 0개가 돼 이 함수는 no-op(server.ts 호출·import 는 유지 — 추후 pm 재노출 시 복원 지점).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPmTools(_server: McpServer): void {
  // (현재 pm 표면은 REST 전용 — MCP 등록 없음)
}

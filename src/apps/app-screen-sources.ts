// 앱 화면에서 온 도구 호출의 출처(ctx.source) — 라이블리 화면의 다리(`app-ui`, capabilities/app-tool-call) · 앱 주소의 `/_lively/*`
//  (`app-front`, apps/app-front-routes · #4482). 두 길은 같은 판정(runAppTool)을 탄다. 서버가 붙이는 값이라 부르는 쪽이 사칭하지 못한다
//  (REST 는 늘 `web`, MCP 는 `mcp`). 새 출처를 더하면 이 목록 하나만 고친다 — 작업 컨테이너(agent-jobs/service)가 이 목록으로
//  «사람이 앱 화면에서 보낸 것» 을 가른다(#4490).
export const APP_SCREEN_SOURCES = ["app-ui", "app-front"] as const;
export type AppScreenSource = (typeof APP_SCREEN_SOURCES)[number];
export function isAppScreenSource(s: unknown): s is AppScreenSource {
  return (APP_SCREEN_SOURCES as readonly string[]).includes(String(s ?? ""));
}

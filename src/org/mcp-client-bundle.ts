// 클라 직접등록(레인 C) 번들 셀렉터 — 발행 시 .lively/mcp-servers.json 에 굳힐 서버를 고른다.
//  이 결과물이 멤버 키트의 ~/.lively/mcp-servers.json 이고, registerClaudeMcp(kit) 가 순회하며 `claude mcp add` 한다.
//  ⚠ 불변식(#894): mode='proxy' 는 게이트웨이가 상류 MCP 를 대리(ext__*)·통제(P1~P5: 마스킹·감사·등급)하므로
//   클라에 **직접 등록하면 안 된다** — 직결은 게이트웨이 우회(통제 무력화)·프록시와의 이중등록(같은 이름 두 auth surface)·
//   재설치마다 per-machine OAuth 재인증을 유발한다. 그러므로 클라 번들엔 mode='client' 만 담는다.
//  (레인 C 는 설계상 저민감·게이트웨이 불요[browser·mermaid·figma] 전용 — mcp-proxy-convergence-design-746.)
//  순수 함수(DB 불요) — mcp-client-bundle.test.ts 가 프록시 유입을 가드한다.
import type { McpServer } from "./store.js";

export interface ClientBundleServer {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  auth_env: string | null;
}

export function toClientBundleServers(servers: McpServer[]): ClientBundleServer[] {
  return servers
    // mode==='client' 만(프록시 제외) · enabled · transport 완전(http면 url, stdio면 command)
    .filter((s) => s.enabled && s.mode === "client" && (s.transport === "stdio" ? !!s.command : !!s.url))
    .map((s) => ({ name: s.name, transport: s.transport, url: s.url, command: s.command, auth_env: s.auth_env }));
}

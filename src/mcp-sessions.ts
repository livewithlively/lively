// in-session 라이브 push(#746 T5) — sessioned /mcp 세션 레지스트리 + tools/list_changed 브로드캐스트.
//  무상태(/mcp 기본)에선 툴 변경이 '다음 세션'부터 반영. sessioned(플래그 on)면 연결된 세션의 SSE 로 tools/list_changed 를
//  즉시 push → 클라가 mid-session 재조회(재설치·재접속 0). 단일 게이트웨이/조직(AGENTS.md) 전제라 세션 인메모리 유지 OK.
//  ⚠ 기본 off(LIVELY_MCP_SESSIONED≠on) — 켜기 전엔 현행 무상태 경로 무변화(무회귀).
import { randomUUID } from "node:crypto";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./log.js";

export interface McpSession { transport: StreamableHTTPServerTransport; server: McpServer }

const sessions = new Map<string, McpSession>();

export function sessionedEnabled(): boolean {
  const v = process.env.LIVELY_MCP_SESSIONED;
  return v === "on" || v === "1" || v === "true";
}
export function newSessionId(): string { return randomUUID(); }
export function getSession(id: string): McpSession | undefined { return sessions.get(id); }
export function putSession(id: string, s: McpSession): void { sessions.set(id, s); }
export function dropSession(id: string): void { sessions.delete(id); }
export function sessionCount(): number { return sessions.size; }

// 툴 변경(프록시 발행/새로고침·동적툴 변경) 시 연결된 모든 세션에 tools/list_changed push. 반환=푸시된 세션 수.
//  개별 세션 전송 실패는 무시(끊긴 세션 등) — 브로드캐스트 자체는 항상 성공.
export function broadcastToolListChanged(): number {
  let n = 0;
  for (const s of sessions.values()) {
    try { s.server.sendToolListChanged(); n++; }
    catch { /* 끊긴/미준비 세션 — 무시 */ }
  }
  if (n) logger.info({ sessions: n }, "tools/list_changed 브로드캐스트(in-session push)");
  return n;
}

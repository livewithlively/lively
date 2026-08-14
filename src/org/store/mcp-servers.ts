// org_mcp_server — MCP 서버 레지스트리(클라 직접등록 + A-어댑터 프록시 #746 T1).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit } from "./audit.js";

// ════════ MCP 서버 레지스트리 — org_mcp_server ════════
export interface McpServer {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  auth_env: string | null;
  note: string | null;
  enabled: boolean;
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  // A-어댑터 프록시(#746 T1)
  mode: "client" | "proxy";
  tools_snapshot: Array<{ name: string; description?: string; inputSchema?: unknown }> | null;
  snapshot_at: string | null;
  scope: string | null;
  level: "L0" | "L1" | "L2" | null;
  pii_scrub: boolean;
  // log_args(#1082): 이 서버 프록시 툴의 호출 '인자 값'을 감사로그에 남길지. 기본 false — 프록시 인자에는 조직 밖으로
  //  나가는 본문(슬랙 DM·메일)이 실리므로 값은 안 남기고 호출 사실(누가·언제·어떤 툴)만 남긴다.
  log_args: boolean;
  auth_kind: string | null;
  auth_scope_key: string | null;
  auth_mode: "bearer" | "oauth" | "sigv4" | null; // null/bearer=정적토큰, oauth=per-member OAuth(T2), sigv4=AWS 요청서명(#746)
}

function mapMcp(row: Record<string, unknown>): McpServer {
  return {
    name: row.name as string,
    transport: row.transport as McpServer["transport"],
    url: (row.url as string) ?? null,
    command: (row.command as string) ?? null,
    auth_env: (row.auth_env as string) ?? null,
    note: (row.note as string) ?? null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
    mode: (row.mode as McpServer["mode"]) ?? "client",
    tools_snapshot: Array.isArray(row.tools_snapshot) ? (row.tools_snapshot as McpServer["tools_snapshot"]) : null,
    snapshot_at: (row.snapshot_at as string) ?? null,
    scope: (row.scope as string) ?? null,
    level: (row.level as McpServer["level"]) ?? null,
    pii_scrub: row.pii_scrub === true,
    log_args: row.log_args === true, // #1082 — 컬럼 부재(구 DB)면 undefined → false(안전측: 값 미저장)
    auth_kind: (row.auth_kind as string) ?? null,
    auth_scope_key: (row.auth_scope_key as string) ?? null,
    auth_mode: (row.auth_mode as McpServer["auth_mode"]) ?? null,
  };
}

const MCP_COLS = "name, transport, url, command, auth_env, note, enabled, sort, version, updated_at, updated_by, mode, tools_snapshot, snapshot_at, scope, level, pii_scrub, log_args, auth_kind, auth_scope_key, auth_mode";

export async function listMcpServers(): Promise<McpServer[]> {
  const r = await itemsPool.query(`SELECT ${MCP_COLS} FROM org_mcp_server ORDER BY sort, name`);
  return r.rows.map(mapMcp);
}

export async function getMcpServer(name: string): Promise<McpServer | null> {
  const r = await itemsPool.query(`SELECT ${MCP_COLS} FROM org_mcp_server WHERE name=$1`, [name]);
  return r.rows[0] ? mapMcp(r.rows[0]) : null;
}

export interface McpServerInput {
  name: string;
  transport?: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  auth_env?: string | null;
  note?: string | null;
  enabled?: boolean;
  sort?: number;
  mode?: "client" | "proxy";
  scope?: string | null;
  level?: "L0" | "L1" | "L2" | null;
  pii_scrub?: boolean;
  log_args?: boolean; // #1082 인자 값 저장 허용(기본 false)
  auth_kind?: string | null;
  auth_scope_key?: string | null;
  auth_mode?: "bearer" | "oauth" | "sigv4" | null;
}

export async function upsertMcpServer(m: McpServerInput, actor?: string, source?: string): Promise<McpServer> {
  const before = await getMcpServer(m.name);
  const transport = m.transport ?? before?.transport ?? "http";
  // transport 와 맞지 않는 필드는 비운다(http↔stdio 전환 시 옛 url/command 잔류로 인한 잘못된 상태 방지).
  const url = transport === "http" ? (m.url ?? before?.url ?? null) : null;
  const command = transport === "stdio" ? (m.command ?? before?.command ?? null) : null;
  const mode = m.mode ?? before?.mode ?? "client";
  // proxy 는 http 전송 전제(상류 remote MCP). auth_kind 지정 시 auth_env 는 비운다(인증 출처 하나 — org_tool 배타와 동일).
  const authKind = m.auth_kind !== undefined ? (m.auth_kind || null) : (before?.auth_kind ?? null);
  const authEnv = authKind ? null : (m.auth_env ?? before?.auth_env ?? null);
  const authMode = m.auth_mode !== undefined ? (m.auth_mode || null) : (before?.auth_mode ?? null);
  // auth_mode=oauth 는 auth_kind(vault 토큰 슬롯 kind) 필수(#746 리뷰 #3) — 없으면 연결/호출 시점까지 오류가 늦어진다.
  if (authMode === "oauth" && !authKind) throw new Error("auth_mode=oauth 는 auth_kind(자격 종류)가 필요합니다");
  await itemsPool.query(
    `INSERT INTO org_mcp_server(name, transport, url, command, auth_env, note, enabled, sort, mode, scope, level, pii_scrub, log_args, auth_kind, auth_scope_key, auth_mode, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,now(),$17)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       transport=EXCLUDED.transport, url=EXCLUDED.url, command=EXCLUDED.command, auth_env=EXCLUDED.auth_env,
       note=EXCLUDED.note, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       mode=EXCLUDED.mode, scope=EXCLUDED.scope, level=EXCLUDED.level, pii_scrub=EXCLUDED.pii_scrub,
       log_args=EXCLUDED.log_args,
       auth_kind=EXCLUDED.auth_kind, auth_scope_key=EXCLUDED.auth_scope_key, auth_mode=EXCLUDED.auth_mode,
       version=org_mcp_server.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.name, transport, url, command,
     authEnv, m.note ?? before?.note ?? null,
     m.enabled ?? before?.enabled ?? true, m.sort ?? before?.sort ?? 0,
     mode, m.scope !== undefined ? m.scope : (before?.scope ?? null),
     m.level !== undefined ? m.level : (before?.level ?? null),
     m.pii_scrub !== undefined ? !!m.pii_scrub : (before?.pii_scrub ?? false),
     m.log_args !== undefined ? !!m.log_args : (before?.log_args ?? false), // #1082 — 미지정이면 기존값, 신규는 false(안전측)
     authKind, m.auth_scope_key !== undefined ? (m.auth_scope_key || null) : (before?.auth_scope_key ?? null),
     authMode,
     actor ?? null],
  );
  // url/mode 변경 시 pinned tools_snapshot 무효화(#746 리뷰) — 옛 상류 기준 툴 정체성/목적지 불일치 방지.
  //  listProxyServers 는 snapshot NOT NULL 만 노출하므로, 재발행(refresh)까지 이 서버는 프록시 등록에서 빠진다(fail-safe).
  if (before && (before.url !== url || before.mode !== mode)) {
    await itemsPool.query(`UPDATE org_mcp_server SET tools_snapshot=NULL, snapshot_at=NULL WHERE name=$1`, [m.name]);
  }
  const after = await getMcpServer(m.name);
  await audit("org_mcp_server", m.name, before ? "update" : "insert", before, after, actor, source);
  return after as McpServer;
}

export async function removeMcpServer(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getMcpServer(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_mcp_server WHERE name=$1`, [name]);
  await audit("org_mcp_server", name, "delete", before, null, actor, source);
}

// A-어댑터(#746 T1) — 발행 시 상류 tools/list 스냅샷(핀) 저장. 관리자 '새로고침/버전업' 액션이 호출.
export async function setMcpToolsSnapshot(name: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>, actor?: string): Promise<void> {
  const before = await getMcpServer(name);
  if (!before) throw new Error(`MCP 서버 없음: ${name}`);
  await itemsPool.query(
    `UPDATE org_mcp_server SET tools_snapshot=$2::jsonb, snapshot_at=now(), version=version+1, updated_at=now(), updated_by=$3 WHERE name=$1`,
    [name, JSON.stringify(tools), actor ?? null],
  );
  await audit("org_mcp_server", name, "update", { tool_count: before.tools_snapshot?.length ?? 0 }, { tool_count: tools.length, action: "snapshot" }, actor, "web");
}

// /mcp 프록시 등록용 — enabled + mode='proxy' + 스냅샷 보유(발행됨) 서버만. buildServer 가 이 스냅샷으로 툴을 재노출한다.
export async function listProxyServers(): Promise<McpServer[]> {
  const r = await itemsPool.query(
    `SELECT ${MCP_COLS} FROM org_mcp_server WHERE enabled=true AND mode='proxy' AND tools_snapshot IS NOT NULL ORDER BY sort, name`);
  return r.rows.map(mapMcp);
}

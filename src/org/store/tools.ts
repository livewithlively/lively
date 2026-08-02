// org_tool — 조직 정의 MCP 툴(http_proxy·빌트인 게이팅·auto-approve·주입모드 #187·권한등급 P2 #746).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit, type WriteCtx } from "./audit.js";

// ════════ 조직 정의 MCP 툴 — org_tool ════════
export type ToolKind = "http_proxy" | "builtin" | "prompt";
export interface OrgTool {
  name: string;
  kind: ToolKind;
  enabled: boolean;
  title: string | null;
  description: string;
  scope: string | null;
  input_schema: unknown;
  method: string | null;
  url: string | null;
  auth_env: string | null;
  auto_approve: boolean;
  always_load: boolean | null; // 주입모드 override(#187): null=코드기본, true=항상 주입, false=deferred. Claude Code _meta(anthropic/alwaysLoad)로 변환.
  level: "L0" | "L1" | "L2" | null; // 권한 등급(P2 #746): L0 조회 / L1 제안 / L2 집행. L2 는 auto-approve 강제 제외. null=코드기본(L0).
  auth_kind: string | null; // P1(#746): 설정 시 http_proxy 가 member_secret(호출자 개인 자격 우선)로 인증. null=auth_env(조직 공용) 사용.
  auth_scope_key: string | null; // vault 조회 scope_key(예 host)
  pii_scrub: boolean; // P3(#746): true 면 응답 본문(문자열)에 scrubPii(비정형 PII 마스킹)
  log_args: boolean; // #1082: 호출 '인자 값'을 감사로그에 남길지. 기본 false — http_proxy 도 조직 밖으로 나가는 통신이다.
  note: string | null;
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const DEFAULT_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

function mapTool(row: Record<string, unknown>): OrgTool {
  return {
    name: row.name as string,
    kind: row.kind as ToolKind,
    enabled: row.enabled !== false,
    title: (row.title as string) ?? null,
    description: (row.description as string) ?? "",
    scope: (row.scope as string) ?? null,
    input_schema: row.input_schema ?? DEFAULT_INPUT_SCHEMA,
    method: (row.method as string) ?? null,
    url: (row.url as string) ?? null,
    auth_env: (row.auth_env as string) ?? null,
    auto_approve: row.auto_approve === true,
    always_load: row.always_load == null ? null : row.always_load === true,
    level: (row.level as "L0" | "L1" | "L2" | null) ?? null,
    auth_kind: (row.auth_kind as string) ?? null,
    auth_scope_key: (row.auth_scope_key as string) ?? null,
    pii_scrub: row.pii_scrub === true,
    log_args: row.log_args === true, // #1082 — 컬럼 부재(구 DB)면 undefined → false(안전측: 값 미저장)
    note: (row.note as string) ?? null,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const TOOL_COLS = "name, kind, enabled, title, description, scope, input_schema, method, url, auth_env, auto_approve, always_load, level, auth_kind, auth_scope_key, pii_scrub, log_args, note, sort, version, updated_at, updated_by";

export async function listTools(): Promise<OrgTool[]> {
  const r = await itemsPool.query(`SELECT ${TOOL_COLS} FROM org_tool ORDER BY sort, name`);
  return r.rows.map(mapTool);
}

// /mcp 동적 등록용 — enabled 인 http_proxy 툴만.
export async function listEnabledProxyTools(): Promise<OrgTool[]> {
  const r = await itemsPool.query(
    `SELECT ${TOOL_COLS} FROM org_tool WHERE enabled=true AND kind='http_proxy' ORDER BY sort, name`);
  return r.rows.map(mapTool);
}

// (A) 빌트인 게이팅 — 비활성화된 빌트인 툴 이름 집합(buildServer 가 등록 제외).
export async function listDisabledBuiltins(): Promise<Set<string>> {
  const r = await itemsPool.query(`SELECT name FROM org_tool WHERE kind='builtin' AND enabled=false`);
  return new Set(r.rows.map((row) => (row as { name: string }).name));
}

// (A') 빌트인 노출 override — kind='builtin' 행 전체(name→enabled). 운영자가 웹에서 설정한 양방향 재정의.
//  행이 있으면 그 enabled 가 코드 기본값(expose.mcp)을 덮어쓴다(미노출→켜기, 노출→끄기 둘 다). 행 없으면 기본값 유지.
export async function listBuiltinOverrides(): Promise<Map<string, boolean>> {
  const r = await itemsPool.query(`SELECT name, enabled FROM org_tool WHERE kind='builtin'`);
  return new Map(r.rows.map((row) => {
    const rr = row as { name: string; enabled: boolean };
    return [rr.name, rr.enabled !== false] as [string, boolean];
  }));
}

// (A'') 빌트인 주입모드 override — kind='builtin' 행 중 always_load 가 명시(NOT NULL)된 것만(name→bool). #187.
//  null(미설정)은 코드 기본값(cap.meta 의 anthropic/alwaysLoad)을 그대로 두므로 여기 담지 않는다(map.has 로 override 유무 판정).
//  resolveToolMeta 가 이 map 으로 Claude Code _meta(anthropic/alwaysLoad)를 하네스별 emit/생략한다.
export async function listBuiltinAlwaysLoad(): Promise<Map<string, boolean>> {
  const r = await itemsPool.query(`SELECT name, always_load FROM org_tool WHERE kind='builtin' AND always_load IS NOT NULL`);
  return new Map(r.rows.map((row) => {
    const rr = row as { name: string; always_load: boolean };
    return [rr.name, rr.always_load === true] as [string, boolean];
  }));
}

// 설치 번들용 — auto_approve 가 켜진(그리고 enabled) 툴 이름. 멤버 settings 의 무확인 실행 허용목록에 들어간다.
export async function listAutoApproveTools(): Promise<{ name: string; kind: ToolKind }[]> {
  const r = await itemsPool.query(
    // P2(#746): L2(집행) 툴은 auto_approve 가 켜져 있어도 무확인 실행 목록에서 강제 제외 — 하네스 인터랙티브 컨펌 강제.
    `SELECT name, kind FROM org_tool WHERE auto_approve=true AND enabled=true AND (level IS NULL OR level <> 'L2') ORDER BY name`);
  return r.rows.map((row) => ({ name: (row as { name: string }).name, kind: (row as { kind: ToolKind }).kind }));
}

export async function getTool(name: string): Promise<OrgTool | null> {
  const r = await itemsPool.query(`SELECT ${TOOL_COLS} FROM org_tool WHERE name=$1`, [name]);
  return r.rows[0] ? mapTool(r.rows[0]) : null;
}

export interface OrgToolInput {
  name: string;
  kind?: ToolKind;
  enabled?: boolean;
  title?: string | null;
  description?: string;
  scope?: string | null;
  input_schema?: unknown;
  method?: string | null;
  url?: string | null;
  auth_env?: string | null;
  auto_approve?: boolean;
  always_load?: boolean | null; // #187 주입모드: undefined=유지, null=코드기본 복귀, true=항상, false=deferred.
  level?: "L0" | "L1" | "L2" | null; // P2(#746) 등급: undefined=유지, null=코드기본, L0/L1/L2 명시.
  auth_kind?: string | null; // P1(#746) vault 인증 kind: undefined=유지, null/""=env 사용, 값=member_secret 해소.
  auth_scope_key?: string | null;
  pii_scrub?: boolean; // P3(#746) 응답 PII 마스킹
  log_args?: boolean; // #1082 인자 값 저장 허용(기본 false)
  note?: string | null;
  sort?: number;
}

export async function upsertTool(t: OrgToolInput, ctx: WriteCtx = {}): Promise<OrgTool> {
  const before = await getTool(t.name);
  const kind = t.kind ?? before?.kind ?? "http_proxy";
  const isProxy = kind === "http_proxy";
  // http_proxy 가 아닌 행(빌트인 게이팅)은 url/method/auth_env/scope/input_schema 를 비운다(잔류 방지).
  const url = isProxy ? (t.url ?? before?.url ?? null) : null;
  const method = isProxy ? (t.method ?? before?.method ?? null) : null;
  const scope = isProxy ? (t.scope ?? before?.scope ?? null) : null;
  const inputSchema = isProxy ? (t.input_schema ?? before?.input_schema ?? DEFAULT_INPUT_SCHEMA) : DEFAULT_INPUT_SCHEMA;
  // 주입모드(#187): undefined=기존 유지, null=코드기본 복귀, true/false=명시. ??-병합은 null 을 흘려보내므로 직접 분기.
  const alwaysLoad = t.always_load !== undefined ? t.always_load : (before?.always_load ?? null);
  const level = t.level !== undefined ? t.level : (before?.level ?? null);
  // 커넥터 자격/마스킹(P1·P3 #746) — http_proxy 에만 유효(빌트인 게이팅 행은 비움). null/"" 이면 env 인증(기존).
  const authKind = isProxy ? (t.auth_kind !== undefined ? (t.auth_kind || null) : (before?.auth_kind ?? null)) : null;
  // 배타(리뷰 blocking①): authKind 가 있으면 authEnv 는 강제 null — 저장된 stale auth_env 잔류/이중 인증출처 방지(?? 병합의 함정).
  const authEnv = isProxy ? (authKind ? null : (t.auth_env ?? before?.auth_env ?? null)) : null;
  const authScopeKey = isProxy ? (t.auth_scope_key !== undefined ? (t.auth_scope_key || null) : (before?.auth_scope_key ?? null)) : null;
  const piiScrub = isProxy ? (t.pii_scrub !== undefined ? !!t.pii_scrub : (before?.pii_scrub ?? false)) : false;
  // #1082 — 인자 값 저장 허용. 프록시(외부 통신) 툴에만 의미가 있고, 빌트인은 애초에 이 정책의 대상이 아니라 false.
  const logArgs = isProxy ? (t.log_args !== undefined ? !!t.log_args : (before?.log_args ?? false)) : false;
  await itemsPool.query(
    `INSERT INTO org_tool(name,kind,enabled,title,description,scope,input_schema,method,url,auth_env,auto_approve,always_load,level,auth_kind,auth_scope_key,pii_scrub,log_args,note,sort,version,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,now(),$20)
     ON CONFLICT (name) DO UPDATE SET
       kind=EXCLUDED.kind, enabled=EXCLUDED.enabled, title=EXCLUDED.title, description=EXCLUDED.description,
       scope=EXCLUDED.scope, input_schema=EXCLUDED.input_schema, method=EXCLUDED.method, url=EXCLUDED.url,
       auth_env=EXCLUDED.auth_env, auto_approve=EXCLUDED.auto_approve, always_load=EXCLUDED.always_load, level=EXCLUDED.level,
       auth_kind=EXCLUDED.auth_kind, auth_scope_key=EXCLUDED.auth_scope_key, pii_scrub=EXCLUDED.pii_scrub,
       log_args=EXCLUDED.log_args, note=EXCLUDED.note, sort=EXCLUDED.sort,
       version=org_tool.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [t.name, kind, t.enabled ?? before?.enabled ?? true, t.title ?? before?.title ?? null,
     t.description ?? before?.description ?? "", scope, JSON.stringify(inputSchema), method, url, authEnv,
     t.auto_approve ?? before?.auto_approve ?? false, alwaysLoad, level, authKind, authScopeKey, piiScrub, logArgs,
     t.note ?? before?.note ?? null, t.sort ?? before?.sort ?? 0, ctx.actor ?? null],
  );
  const after = await getTool(t.name);
  await audit("org_tool", t.name, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgTool;
}

export async function removeTool(name: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getTool(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_tool WHERE name=$1`, [name]);
  await audit("org_tool", name, "delete", before, null, ctx.actor, ctx.source, ctx);
}

// 앱 레지스트리 스토어 — org_app·org_app_component·org_app_grant CRUD (#1780, design D1/D2).
//  ⚠ 저널드 2-phase(design R2-1): 이 세 테이블의 쓰기는 **client(withTx) 를 받아** 한 트랜잭션에 묶을 수 있다
//   (org_app 저널 + component 조인은 원자적이어야 한다 — 반쯤 기록된 조인을 스폰이 읽으면 안 된다). 반면
//   실제 전개 대상(org_harness_asset·org_tool 등)은 autocommit 스토어라 같은 tx 에 못 들어간다 → 그래서
//   저널이 원자성을 대체한다(component 선기록 → 전개 → 실패 시 보상). mintToken 과 같은 client-옵션 패턴.
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { audit, type WriteCtx } from "./audit.js";

type Q = pg.Pool | pg.PoolClient;

export type AppStatus = "installing" | "active" | "failed" | "disabled";

export interface OrgApp {
  id: string;
  title: string;
  version: string;
  manifest: unknown;
  source: unknown;
  content_hash: string | null;
  status: AppStatus;
  enabled: boolean;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface AppComponentRow { app_id: string; kind: string; ref: string; orig_name: string | null }
export interface AppGrantRow {
  app_id: string; member_id: string; scopes: string[]; tools: string[];
  granted_at: string; granted_by: string | null; revoked_at: string | null;
}

function rowToApp(r: Record<string, unknown>): OrgApp {
  return {
    id: String(r.id), title: String(r.title ?? ""), version: String(r.version ?? "0.0.0"),
    manifest: r.manifest ?? {}, source: r.source ?? {},
    content_hash: r.content_hash == null ? null : String(r.content_hash),
    status: r.status as AppStatus, enabled: !!r.enabled,
    installed_by: r.installed_by == null ? null : String(r.installed_by),
    installed_at: String(r.installed_at), updated_at: String(r.updated_at),
    updated_by: r.updated_by == null ? null : String(r.updated_by),
  };
}

// ── 설치 직렬화(advisory lock, design R2-5) ────────────────────────────────────
//  같은 앱의 동시 설치/제거를 직렬화한다(반쯤 전개된 조인을 다른 설치가 덮어쓰지 않게). DB-전역 advisory lock 이라
//  blue/green 다중 프로세스 사이도 막는다. 락은 **연결 단위**라 전용 client 를 잡아 그 위에서만 lock/unlock 하고,
//  본 작업(fn)은 풀의 다른 커넥션을 자유로이 쓴다. tenant 는 키에 넣지 않는다(앱 id 만으로 상위집합 직렬화 — 안전).
export async function withAppInstallLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const client = await itemsPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["app-install:" + appId]);
    return await fn();
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["app-install:" + appId]); } catch { /* 세션 종료 시 자동 해제 */ }
    client.release();
  }
}

// ── org_app ──────────────────────────────────────────────────────────────────

/** 앱 행 upsert(설치/업데이트). status 미지정이면 'installing'(설치 시작). client 주면 그 tx 에서. */
export async function upsertApp(
  a: { id: string; title: string; version: string; manifest: unknown; source: unknown; content_hash: string | null; status?: AppStatus; enabled?: boolean },
  ctx: WriteCtx = {}, client?: pg.PoolClient,
): Promise<OrgApp> {
  const exec: Q = client ?? itemsPool;
  const before = await getApp(a.id, client);
  const r = await exec.query(
    `INSERT INTO org_app(id,title,version,manifest,source,content_hash,status,enabled,installed_by,installed_at,updated_at,updated_by)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,COALESCE($7,'installing'),COALESCE($8,true),$9,now(),now(),$9)
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       title=EXCLUDED.title, version=EXCLUDED.version, manifest=EXCLUDED.manifest, source=EXCLUDED.source,
       content_hash=EXCLUDED.content_hash,
       status=COALESCE($7, org_app.status), enabled=COALESCE($8, org_app.enabled),
       updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING *`,
    [a.id, a.title, a.version, JSON.stringify(a.manifest ?? {}), JSON.stringify(a.source ?? {}),
     a.content_hash, a.status ?? null, a.enabled ?? null, ctx.actor ?? null],
  );
  const app = rowToApp(r.rows[0]);
  await audit("org_app", a.id, before ? "update" : "insert", before, app, ctx.actor, ctx.source, client);
  return app;
}

export async function getApp(id: string, client?: pg.PoolClient): Promise<OrgApp | null> {
  const exec: Q = client ?? itemsPool;
  const r = await exec.query(`SELECT * FROM org_app WHERE id=$1`, [id]);
  return r.rows[0] ? rowToApp(r.rows[0]) : null;
}

export async function listApps(): Promise<OrgApp[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app ORDER BY installed_at DESC`);
  return r.rows.map(rowToApp);
}

export async function setAppStatus(id: string, status: AppStatus, ctx: WriteCtx = {}, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(`UPDATE org_app SET status=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [id, status, ctx.actor ?? null]);
}

export async function setAppEnabled(id: string, enabled: boolean, ctx: WriteCtx = {}): Promise<void> {
  const before = await getApp(id);
  await itemsPool.query(`UPDATE org_app SET enabled=$2, updated_at=now(), updated_by=$3 WHERE id=$1`, [id, enabled, ctx.actor ?? null]);
  await audit("org_app", id, "update", before, { ...before, enabled }, ctx.actor, ctx.source);
}

/** 앱 행 + 조인(component·grant)을 CASCADE 로 제거. 대상 행(harness_asset 등) 회수는 호출부가 component 를 읽어 먼저 수행. */
export async function deleteApp(id: string, ctx: WriteCtx = {}, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  const before = await getApp(id, client);
  await exec.query(`DELETE FROM org_app WHERE id=$1`, [id]);
  await audit("org_app", id, "delete", before, null, ctx.actor, ctx.source, client);
}

// ── org_app_component ──────────────────────────────────────────────────────────

export async function addComponent(appId: string, kind: string, ref: string, origName: string | null, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(
    // ON CONFLICT 타깃은 tenant_id 를 포함한다 — ensureTenantColumn 이 PK 를 (tenant_id, app_id, kind, ref)로
    //  재작성하므로(tenant-column.ts), (app_id,kind,ref)만으로는 매칭되는 제약이 없어 42P10 이 난다(org_app 의
    //  ON CONFLICT (tenant_id,id) 와 동일 규약). tenant_id 는 컬럼 DEFAULT 로 채워지므로 VALUES 엔 안 싣는다.
    `INSERT INTO org_app_component(app_id,kind,ref,orig_name) VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id,app_id,kind,ref) DO UPDATE SET orig_name=EXCLUDED.orig_name`,
    [appId, kind, ref, origName],
  );
}

export async function removeComponent(appId: string, kind: string, ref: string, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(`DELETE FROM org_app_component WHERE app_id=$1 AND kind=$2 AND ref=$3`, [appId, kind, ref]);
}

export async function listComponents(appId: string, client?: pg.PoolClient): Promise<AppComponentRow[]> {
  const exec: Q = client ?? itemsPool;
  const r = await exec.query(`SELECT app_id,kind,ref,orig_name FROM org_app_component WHERE app_id=$1 ORDER BY kind,ref`, [appId]);
  return r.rows.map((x) => ({ app_id: String(x.app_id), kind: String(x.kind), ref: String(x.ref), orig_name: x.orig_name == null ? null : String(x.orig_name) }));
}

/** 이 호스트를 component(kind='host')로 참조하는 **다른** 앱이 있는지(회수 안전성, design R1-F5). */
export async function hostReferenceCount(host: string, exceptAppId: string): Promise<number> {
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n FROM org_app_component WHERE kind='host' AND ref=$1 AND app_id<>$2`,
    [host.toLowerCase(), exceptAppId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

// ── org_app_ui_asset — UI 페이지/위젯 entry HTML(#1780 PR5) ────────────────────
export interface AppUiAssetRow { app_id: string; page_key: string; kind: "page" | "widget"; title: string | null; html: string; content_hash: string | null; updated_at: string }
export interface AppUiAssetMeta { page_key: string; kind: "page" | "widget"; title: string | null }

/** entry HTML 을 보존(설치/업데이트 시). client 주면 그 tx 에서. */
export async function upsertUiAsset(
  appId: string, a: { page_key: string; kind: "page" | "widget"; title: string; html: string }, contentHash: string | null, client?: pg.PoolClient,
): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(
    // ON CONFLICT 타깃에 tenant_id 포함(ensureTenantColumn 이 PK 를 (tenant_id,app_id,page_key)로 재작성 — org_app_component 규약과 동일).
    `INSERT INTO org_app_ui_asset(app_id,page_key,kind,title,html,content_hash,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (tenant_id,app_id,page_key) DO UPDATE SET
       kind=EXCLUDED.kind, title=EXCLUDED.title, html=EXCLUDED.html, content_hash=EXCLUDED.content_hash, updated_at=now()`,
    [appId, a.page_key, a.kind, a.title, a.html, contentHash],
  );
}

/** 이 앱의 UI 자산 메타(html 제외 — 목록·존재확인용). */
export async function listUiAssets(appId: string): Promise<AppUiAssetMeta[]> {
  const r = await itemsPool.query(`SELECT page_key, kind, title FROM org_app_ui_asset WHERE app_id=$1 ORDER BY kind, page_key`, [appId]);
  return r.rows.map((x) => ({ page_key: String(x.page_key), kind: x.kind as "page" | "widget", title: x.title == null ? null : String(x.title) }));
}

/** 페이지 1건(html 포함) — 서빙용. 없으면 null. */
export async function getUiAsset(appId: string, pageKey: string): Promise<AppUiAssetRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_ui_asset WHERE app_id=$1 AND page_key=$2`, [appId, pageKey]);
  const x = r.rows[0];
  if (!x) return null;
  return { app_id: String(x.app_id), page_key: String(x.page_key), kind: x.kind as "page" | "widget",
    title: x.title == null ? null : String(x.title), html: String(x.html),
    content_hash: x.content_hash == null ? null : String(x.content_hash), updated_at: String(x.updated_at) };
}

/** keep 에 없는 UI 자산을 제거(업데이트 diff — 더 이상 선언 안 하는 페이지). client 주면 그 tx 에서. */
export async function pruneUiAssets(appId: string, keep: string[], client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  if (keep.length === 0) { await exec.query(`DELETE FROM org_app_ui_asset WHERE app_id=$1`, [appId]); return; }
  await exec.query(`DELETE FROM org_app_ui_asset WHERE app_id=$1 AND page_key <> ALL($2::text[])`, [appId, keep]);
}

// ── org_app_runtime_asset — 실행할 worker 번들(Stage B) ──────────────────────
export interface AppRuntimeAssetRow {
  app_id: string; package_hash: string; entry: string; code: Buffer; code_hash: string; size_bytes: number; created_at: string;
}

export async function upsertRuntimeAsset(appId: string, asset: {
  package_hash: string; entry: string; code: Buffer; code_hash: string;
}, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(
    `INSERT INTO org_app_runtime_asset(app_id,package_hash,entry,code,code_hash,size_bytes,created_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (tenant_id,app_id,package_hash) DO UPDATE SET
       entry=EXCLUDED.entry, code=EXCLUDED.code, code_hash=EXCLUDED.code_hash, size_bytes=EXCLUDED.size_bytes, created_at=now()`,
    [appId, asset.package_hash, asset.entry, asset.code, asset.code_hash, asset.code.length],
  );
}

export async function getRuntimeAsset(appId: string, packageHash: string): Promise<AppRuntimeAssetRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_runtime_asset WHERE app_id=$1 AND package_hash=$2`, [appId, packageHash]);
  const x = r.rows[0];
  if (!x) return null;
  return { app_id: String(x.app_id), package_hash: String(x.package_hash), entry: String(x.entry), code: Buffer.from(x.code),
    code_hash: String(x.code_hash), size_bytes: Number(x.size_bytes), created_at: String(x.created_at) };
}

export async function pruneRuntimeAssets(appId: string, keepPackageHash: string | null, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  if (!keepPackageHash) { await exec.query(`DELETE FROM org_app_runtime_asset WHERE app_id=$1`, [appId]); return; }
  await exec.query(`DELETE FROM org_app_runtime_asset WHERE app_id=$1 AND package_hash<>$2`, [appId, keepPackageHash]);
}

// ── org_app_grant ──────────────────────────────────────────────────────────────

export async function upsertGrant(
  appId: string, memberId: string, scopes: string[], tools: string[], ctx: WriteCtx = {},
): Promise<AppGrantRow> {
  const r = await itemsPool.query(
    // ON CONFLICT 타깃에 tenant_id 포함 — ensureTenantColumn 이 PK 를 (tenant_id, app_id, member_id)로 재작성한다
    //  (org_app_component 와 동일 규약, addComponent 참조). tenant_id 는 컬럼 DEFAULT 로 채워지므로 VALUES 엔 안 싣는다.
    `INSERT INTO org_app_grant(app_id,member_id,scopes,tools,granted_at,granted_by,revoked_at)
       VALUES($1,$2,$3::jsonb,$4::jsonb,now(),$5,NULL)
     ON CONFLICT (tenant_id,app_id,member_id) DO UPDATE SET
       scopes=EXCLUDED.scopes, tools=EXCLUDED.tools, granted_at=now(), granted_by=EXCLUDED.granted_by, revoked_at=NULL
     RETURNING *`,
    [appId, memberId, JSON.stringify(scopes), JSON.stringify(tools), ctx.actor ?? null],
  );
  return rowToGrant(r.rows[0]);
}

/**
 * 한 멤버의 그 앱 동의 회수. 돌려주는 값 = **실제로 회수한 행이 있었나**(#2646).
 *  종전엔 `void` 라 호출부가 「살아 있던 동의를 이번에 껐다」와 「애초에 없었다」를 구분할 수 없었고,
 *  앱 id 를 잘못 넣어도 성공이 나갔다 — 동의 철회는 사람이 «껐다»고 믿고 자리를 뜨는 동작이라 그게 위험하다.
 */
export async function revokeGrant(appId: string, memberId: string): Promise<boolean> {
  const r = await itemsPool.query(`UPDATE org_app_grant SET revoked_at=now() WHERE app_id=$1 AND member_id=$2 AND revoked_at IS NULL`, [appId, memberId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 한 멤버의 **모든** 활성 grant 회수(#1780 v2 §7-1, 설계 R2-O8) — 멤버 비활성/삭제 전이가 부른다.
 *  grant 는 org_member 에 FK 가 없어 멤버가 사라져도 남고, 재활성화하면 옛 동의가 그대로 부활한다 — 그래서 명시 회수.
 *  돌려주는 값 = 회수한 행 수(로그·테스트 관측용). 부분 인덱스 org_app_grant_member_idx 가 이 술어를 받친다.
 */
export async function revokeAllGrantsForMember(memberId: string): Promise<number> {
  const r = await itemsPool.query(`UPDATE org_app_grant SET revoked_at=now() WHERE member_id=$1 AND revoked_at IS NULL`, [memberId]);
  return r.rowCount ?? 0;
}

/** 활성(미회수) grant. 앱 세션 스폰·appToolAllowed 가 소비. */
export async function getActiveGrant(appId: string, memberId: string): Promise<AppGrantRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_grant WHERE app_id=$1 AND member_id=$2 AND revoked_at IS NULL`, [appId, memberId]);
  return r.rows[0] ? rowToGrant(r.rows[0]) : null;
}

// ── 앱 활동(mcp_call_log.app 집계, design D3-5 관측 전용) ──────────────────────
export interface AppActivityRow { app: string; tool: string; calls: number; ok: number; errors: number; last_called_at: string }

/** 앱별·도구별 호출 집계(최근 days 일). appId 를 주면 그 앱만. 관측 전용 — 권한 판정에 쓰지 않는다. */
export async function appActivity(appId: string | null, days: number): Promise<AppActivityRow[]> {
  const win = Math.max(1, Math.min(365, Math.round(days)));
  const params: unknown[] = [win];
  const clauses = ["app IS NOT NULL", "called_at >= now() - make_interval(days => $1)"];
  if (appId) { params.push(appId); clauses.push(`app = $${params.length}`); }
  const r = await itemsPool.query(
    `SELECT app, tool, count(*)::int AS calls,
            count(*) FILTER (WHERE ok)::int AS ok,
            count(*) FILTER (WHERE NOT ok)::int AS errors,
            max(called_at) AS last_called_at
       FROM mcp_call_log WHERE ${clauses.join(" AND ")}
      GROUP BY app, tool ORDER BY app, calls DESC`,
    params,
  );
  return r.rows.map((x) => ({
    app: String(x.app), tool: String(x.tool),
    calls: Number(x.calls), ok: Number(x.ok), errors: Number(x.errors),
    last_called_at: String(x.last_called_at),
  }));
}

function rowToGrant(r: Record<string, unknown>): AppGrantRow {
  return {
    app_id: String(r.app_id), member_id: String(r.member_id),
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    tools: Array.isArray(r.tools) ? (r.tools as string[]) : [],
    granted_at: String(r.granted_at), granted_by: r.granted_by == null ? null : String(r.granted_by),
    revoked_at: r.revoked_at == null ? null : String(r.revoked_at),
  };
}

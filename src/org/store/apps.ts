// 앱 레지스트리 스토어 — org_app·org_app_component·org_app_grant CRUD (#1780, design D1/D2).
//  ⚠ 저널드 2-phase(design R2-1): 이 세 테이블의 쓰기는 **client(withTx) 를 받아** 한 트랜잭션에 묶을 수 있다
//   (org_app 저널 + component 조인은 원자적이어야 한다 — 반쯤 기록된 조인을 스폰이 읽으면 안 된다). 반면
//   실제 전개 대상(org_harness_asset·org_tool 등)은 autocommit 스토어라 같은 tx 에 못 들어간다 → 그래서
//   저널이 원자성을 대체한다(component 선기록 → 전개 → 실패 시 보상). mintToken 과 같은 client-옵션 패턴.
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { currentTenant } from "../tenant-context.js";
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
  /** #4225 누가 이 앱을 고칠 수 있나 — 'all'(구성원 전원, 기본) · 'members'(edit_members 에 든 사람 + 관리자). */
  edit_mode: AppEditMode;
  edit_members: string[];
  /** #4600 패키지 폴더에 실린 릴리스 판 번호(시더가 적음). 빌트인 아닌 앱은 null. */
  builtin_version: string | null;
  /** #4600 지금 서빙 중인 상태 = org_app_version 의 이 판. 판 이력 도입 전 설치는 null. */
  current_version_no: number | null;
  /** #4632 공개 범위 — 'all'(구성원 모두, 기본) · 'me'(나만 보는 앱 — app_save 로 새로 생긴 앱 · 앱 만들기가 예약한 앱의 시작). 판정은 apps/visibility.ts. */
  visibility: AppVisibility;
  /** #4667 공개 판 · 초안 · 만든 사람 · 책임자 · 만들기 세션 · 사본의 원본 — 판정은 apps/visibility.ts. */
  published_version_no: number | null;
  published_at: string | null;
  published_by: string | null;
  draft_by: string | null;
  made_by: string | null;
  owner_member: string | null;
  build_session: string | null;
  origin_app_id: string | null;
}
export type AppEditMode = "all" | "members";
export type AppVisibility = "all" | "me";

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
    edit_mode: r.edit_mode === "members" ? "members" : "all",
    edit_members: Array.isArray(r.edit_members) ? (r.edit_members as unknown[]).map(String) : [],
    builtin_version: r.builtin_version == null ? null : String(r.builtin_version),
    current_version_no: r.current_version_no == null ? null : Number(r.current_version_no),
    visibility: r.visibility === "me" ? "me" : "all",
    published_version_no: r.published_version_no == null ? null : Number(r.published_version_no),
    published_at: r.published_at == null ? null : (r.published_at instanceof Date ? r.published_at.toISOString() : String(r.published_at)),
    published_by: r.published_by == null ? null : String(r.published_by),
    draft_by: r.draft_by == null ? null : String(r.draft_by),
    made_by: r.made_by == null ? null : String(r.made_by),
    owner_member: r.owner_member == null ? null : String(r.owner_member),
    build_session: r.build_session == null ? null : String(r.build_session),
    origin_app_id: r.origin_app_id == null ? null : String(r.origin_app_id),
  };
}

// ── 설치 직렬화(advisory lock, design R2-5) ────────────────────────────────────
//  같은 앱의 동시 설치/제거를 직렬화한다(반쯤 전개된 조인을 다른 설치가 덮어쓰지 않게). DB-전역 advisory lock 이라
//  blue/green 다중 프로세스 사이도 막는다. 락은 **연결 단위**라 전용 client 를 잡아 그 위에서만 lock/unlock 하고,
//  본 작업(fn)은 풀의 다른 커넥션을 자유로이 쓴다.
//  ★ #4638(2026-10-11 매니지드 전면 정지) — 종전 키는 앱 id 뿐이었고 `pg_advisory_lock` 은 무기한 기다렸다. 공용 DB 에선
//   모든 테넌트(+롤 마이그레이터)가 같은 키를 다퉈, 유령 세션 하나가 락을 쥔 6분 동안 테넌트별 시딩이 **풀 클라이언트를
//   쥔 채** 줄을 서 풀 20개를 다 잡았고, 락을 얻은 쪽은 fn 안에서 두 번째 클라이언트를 못 얻어 영구 교착이 됐다.
//   그래서 ① 키에 테넌트를 넣고(남의 워크스페이스 설치를 기다릴 이유가 없다) ② 기다리는 동안엔 클라이언트를 반납하며
//   (try-lock 재시도) ③ 상한을 넘기면 던진다(호출부는 이미 비치명 — 다음 시딩·사람의 재시도가 받는다).
export const APP_INSTALL_LOCK_WAIT_MS = 60_000;
/** 설치 락을 기다리다 못 얻은 오류의 code — 기다림을 짧게 준 호출부(공개 미리 보기 #4732)가 «다른 저장 중» 으로 접는다. */
export const APP_INSTALL_LOCK_TIMEOUT = "APP_INSTALL_LOCK_TIMEOUT";
const APP_INSTALL_LOCK_POLL_MS = 250;

/** 락 키 — 테넌트 컨텍스트가 있으면 그 테넌트로 좁힌다. 컨텍스트 밖(단일 테넌트·부팅)은 종전처럼 앱 id 만. */
export function appInstallLockKey(appId: string, tenantId: string | null | undefined = currentTenant()?.id): string {
  return tenantId ? `app-install:${tenantId}:${appId}` : `app-install:${appId}`;
}

export async function withAppInstallLock<T>(appId: string, fn: () => Promise<T>,
  opts: { waitMs?: number; pollMs?: number } = {}): Promise<T> {
  const key = appInstallLockKey(appId);
  const deadline = Date.now() + (opts.waitMs ?? APP_INSTALL_LOCK_WAIT_MS);
  let client: pg.PoolClient;
  for (;;) {
    const c = await itemsPool.connect();
    let got = false;
    try {
      const r = await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [key]);
      got = r.rows[0]?.ok === true;
    } catch (err) { c.release(); throw err; }
    if (got) { client = c; break; }
    c.release();   // 기다리는 동안 풀 슬롯을 쥐지 않는다 — 락 보유자가 fn 안에서 쓸 자리를 남긴다
    if (Date.now() >= deadline) throw Object.assign(new Error(`앱 설치 락 대기 시간 초과(${appId}) — 다른 설치가 아직 진행 중입니다`), { code: APP_INSTALL_LOCK_TIMEOUT });
    await new Promise((res) => setTimeout(res, opts.pollMs ?? APP_INSTALL_LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    //  풀기에 실패한 연결은 풀에 돌려주지 않고 버린다 — 락을 쥔 채 풀에 남으면 그 세션이 살아 있는 한 락이 안 풀린다.
    let unlocked = false;
    try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]); unlocked = true; } catch { /* 아래에서 연결째 버린다 */ }
    client.release(!unlocked);
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

/** 이 id 들의 앱(없는 id 는 빠진다) — 한 번에 읽는다(#4673 홈 탐색기 root=apps 목록은 동의한 앱만 본다). */
export async function getAppsByIds(ids: readonly string[]): Promise<OrgApp[]> {
  if (!ids.length) return [];
  const r = await itemsPool.query(`SELECT * FROM org_app WHERE id = ANY($1::text[])`, [[...ids]]);
  return r.rows.map(rowToApp);
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

/** #4225 누가 이 앱을 고칠 수 있나를 정한다(관리자). members 는 mode='members' 일 때만 의미가 있다(all 이면 비운다). */
export async function setAppEditPolicy(id: string, mode: AppEditMode, members: string[], ctx: WriteCtx = {}): Promise<OrgApp | null> {
  const before = await getApp(id);
  if (!before) return null;
  const list = mode === "members" ? [...new Set(members.map((m) => String(m).trim()).filter(Boolean))] : [];
  await itemsPool.query(`UPDATE org_app SET edit_mode=$2, edit_members=$3::jsonb, updated_at=now(), updated_by=$4 WHERE id=$1`,
    [id, mode, JSON.stringify(list), ctx.actor ?? null]);
  const after = await getApp(id);
  await audit("org_app", id, "update", before, after, ctx.actor, ctx.source);
  return after;
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

/** 이 앱의 UI 자산 전부(html 포함) — 판으로 떠 두거나 패키지 파일을 재구성할 때(#4600). */
export async function listUiAssetsFull(appId: string): Promise<AppUiAssetRow[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app_ui_asset WHERE app_id=$1 ORDER BY kind, page_key`, [appId]);
  return r.rows.map((x) => ({ app_id: String(x.app_id), page_key: String(x.page_key), kind: x.kind as "page" | "widget",
    title: x.title == null ? null : String(x.title), html: String(x.html),
    content_hash: x.content_hash == null ? null : String(x.content_hash), updated_at: String(x.updated_at) }));
}

// ── org_app_version — 앱 코드의 판 이력(#4600) ──────────────────────────────────
//  판 하나 = 파일 묶음 전체(files) + 그때의 매니페스트. 설치가 보존하는 것은 매니페스트·화면뿐이라 되돌리기는 이 묶음으로 한다.
export type AppVersionOrigin = "builtin" | "member";
export interface AppVersionMeta {
  app_id: string; version_no: number; origin: AppVersionOrigin; version: string; content_hash: string | null;
  note: string | null; saved_by: string | null; saved_at: string;
}
export interface AppVersionRow extends AppVersionMeta {
  manifest: unknown;
  /** 옛 판(#4600)의 파일 내용 — #4481 뒤로는 옛 코어 호환 사본(상한 안의 판만 · 30일 뒤 비운다). 판의 정본은 bundle 이 있으면 bundle. */
  files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  /** #4481 파일 목록 {v:1, files:[{p,h,s}]} — NULL 이면 아직 안 옮긴 옛 판(files 가 정본). 읽기는 apps/app-version-files.ts 를 지난다. */
  bundle: unknown | null;
  bundle_store: string | null;
}
/** #4481 판 쓰기에 실을 묶음 — 파일 목록 + 그 파일들이 있는 저장소 + 합(바이트). */
export interface AppVersionBundleWrite { bundle: unknown; bundle_store: string; bundle_bytes: number }

function rowToVersionMeta(x: Record<string, unknown>): AppVersionMeta {
  return {
    app_id: String(x.app_id), version_no: Number(x.version_no), origin: x.origin === "builtin" ? "builtin" : "member",
    version: String(x.version ?? "0.0.0"), content_hash: x.content_hash == null ? null : String(x.content_hash),
    note: x.note == null ? null : String(x.note), saved_by: x.saved_by == null ? null : String(x.saved_by),
    saved_at: x.saved_at instanceof Date ? x.saved_at.toISOString() : String(x.saved_at),   // ms 까지(공개 시각과 견준다 · #4667)
  };
}

/**
 * 판을 하나 더 적는다 — 번호는 그 앱의 다음 번호(앱당 1부터). 호출부가 withAppInstallLock 안에서 부른다(번호 경쟁 없음).
 *  반환 = 새 판 번호.
 */
export async function insertAppVersion(
  appId: string,
  v: { origin: AppVersionOrigin; version: string; manifest: unknown; files: unknown[]; content_hash: string | null; note: string | null; saved_by: string | null } & Partial<AppVersionBundleWrite>,
): Promise<number> {
  //  #4481 — bundle 을 주면 파일 목록이 정본이고 files 는 옛 코어 호환 사본이다(apps/app-version-files.ts recordVersion 만 이 길로 쓴다).
  const r = await itemsPool.query(
    `INSERT INTO org_app_version(app_id, version_no, origin, version, manifest, files, content_hash, note, saved_by, saved_at, bundle, bundle_store, bundle_bytes, bundle_at)
       SELECT $1, COALESCE(MAX(version_no), 0) + 1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, now(), $9::jsonb, $10, $11, CASE WHEN $9::jsonb IS NULL THEN NULL ELSE now() END
         FROM org_app_version WHERE app_id = $1
     RETURNING version_no`,
    [appId, v.origin, v.version, JSON.stringify(v.manifest ?? {}), JSON.stringify(v.files ?? []), v.content_hash, v.note, v.saved_by,
     v.bundle == null ? null : JSON.stringify(v.bundle), v.bundle == null ? null : (v.bundle_store ?? null), v.bundle == null ? null : (v.bundle_bytes ?? null)],
  );
  return Number(r.rows[0].version_no);
}

/**
 * 「원본 · 릴리스」 판을 **지금 실린 릴리스**로 갱신한다(번호는 그대로) — «원본으로» 되돌릴 때 부른다.
 *  떠 둔 원본은 처음 고친 날의 릴리스인데, 되돌리기는 폴더의 **지금** 릴리스를 깐다. 둘이 다르면(그 사이 릴리스가 올랐다)
 *  서빙 중인 내용이 어느 판과도 맞지 않아 판 이력에 «지금» 이 사라지고, 다음 되돌리기가 원본을 한 벌 더 떠 둔다.
 *  원본 판(origin='builtin')만 고친다 — 구성원 판은 사람이 저장한 그대로여야 한다.
 */
export async function refreshOriginVersion(
  appId: string, versionNo: number,
  v: { version: string; manifest: unknown; files: unknown[]; content_hash: string | null; note: string | null } & Partial<AppVersionBundleWrite>,
): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_version SET version=$3, manifest=$4::jsonb, files=$5::jsonb, content_hash=$6, note=$7, saved_at=now(),
            bundle=$8::jsonb, bundle_store=$9, bundle_bytes=$10, bundle_at=CASE WHEN $8::jsonb IS NULL THEN NULL ELSE now() END
      WHERE app_id=$1 AND version_no=$2 AND origin='builtin'`,
    [appId, versionNo, v.version, JSON.stringify(v.manifest ?? {}), JSON.stringify(v.files ?? []), v.content_hash, v.note,
     v.bundle == null ? null : JSON.stringify(v.bundle), v.bundle == null ? null : (v.bundle_store ?? null), v.bundle == null ? null : (v.bundle_bytes ?? null)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 판 목록(파일 제외) — 최신 먼저. */
export async function listAppVersions(appId: string): Promise<AppVersionMeta[]> {
  const r = await itemsPool.query(
    `SELECT app_id, version_no, origin, version, content_hash, note, saved_by, saved_at FROM org_app_version WHERE app_id=$1 ORDER BY version_no DESC`, [appId]);
  return r.rows.map(rowToVersionMeta);
}

/** 판 1건(파일 포함) — 되돌리기용. 없으면 null. */
export async function getAppVersion(appId: string, versionNo: number): Promise<AppVersionRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_version WHERE app_id=$1 AND version_no=$2`, [appId, versionNo]);
  const x = r.rows[0];
  if (!x) return null;
  return {
    ...rowToVersionMeta(x), manifest: x.manifest ?? {}, files: Array.isArray(x.files) ? (x.files as AppVersionRow["files"]) : [],
    bundle: x.bundle ?? null, bundle_store: x.bundle_store == null ? null : String(x.bundle_store),
  };
}

/** #4481 판 1건의 머리 + 파일 목록(옛 files 내용은 읽지 않는다 — 앱 주소 서빙 · 내려받기 목록용). 옛 판이면 bundle null. */
export interface AppVersionBundleHead extends AppVersionHead { bundle: unknown | null; bundle_store: string | null; bundle_bytes: number | null }
export async function getAppVersionBundle(appId: string, versionNo: number): Promise<AppVersionBundleHead | null> {
  const r = await itemsPool.query(
    `SELECT app_id, version_no, origin, version, content_hash, note, saved_by, saved_at, manifest, bundle, bundle_store, bundle_bytes
       FROM org_app_version WHERE app_id=$1 AND version_no=$2`, [appId, versionNo]);
  const x = r.rows[0];
  return x ? {
    ...rowToVersionMeta(x), manifest: x.manifest ?? {}, bundle: x.bundle ?? null, bundle_store: x.bundle_store == null ? null : String(x.bundle_store),
    bundle_bytes: x.bundle_bytes == null ? null : Number(x.bundle_bytes),
  } : null;
}

/** #4481 판 1건의 내용 지문만(앱 주소가 요청마다 «그 판이 아직 그 내용인가» 를 싸게 본다). */
export async function getAppVersionHash(appId: string, versionNo: number): Promise<{ content_hash: string | null; has_bundle: boolean } | null> {
  const r = await itemsPool.query(`SELECT content_hash, (bundle IS NOT NULL) AS has_bundle FROM org_app_version WHERE app_id=$1 AND version_no=$2`, [appId, versionNo]);
  const x = r.rows[0];
  return x ? { content_hash: x.content_hash == null ? null : String(x.content_hash), has_bundle: x.has_bundle === true } : null;
}

// ── #4481 옛 판 옮기기 · 옛 코어 호환 사본 정리(apps/app-bundle-migrate.ts 가 하우스키핑에서 부른다) ──

/** 아직 파일 목록이 없는 옛 판(오래된 것부터). */
export async function listLegacyVersions(limit: number): Promise<AppVersionRow[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app_version WHERE bundle IS NULL ORDER BY saved_at ASC, app_id ASC, version_no ASC LIMIT $1`, [Math.max(1, limit)]);
  return r.rows.map((x) => ({
    ...rowToVersionMeta(x), manifest: x.manifest ?? {}, files: Array.isArray(x.files) ? (x.files as AppVersionRow["files"]) : [], bundle: null, bundle_store: null,
  }));
}

/** 옛 판에 파일 목록을 단다(files 는 그대로 둔다 — 호환 사본이 된다). 그 사이 누가 먼저 달았으면 false. */
export async function setLegacyVersionBundle(appId: string, versionNo: number, w: AppVersionBundleWrite): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_version SET bundle=$3::jsonb, bundle_store=$4, bundle_bytes=$5, bundle_at=now() WHERE app_id=$1 AND version_no=$2 AND bundle IS NULL`,
    [appId, versionNo, JSON.stringify(w.bundle), w.bundle_store, w.bundle_bytes]);
  return (r.rowCount ?? 0) > 0;
}

/** 파일 목록을 단 지 days 일이 지난 판의 옛 코어 호환 사본(files)을 비운다. 반환 = 비운 판 수. */
export async function purgeCompatCopies(days: number, limit = 500): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_app_version SET files='[]'::jsonb
      WHERE (app_id, version_no) IN (SELECT app_id, version_no FROM org_app_version
                                      WHERE bundle IS NOT NULL AND bundle_at < now() - make_interval(days => $1) AND files <> '[]'::jsonb LIMIT $2)`,
    [Math.max(0, days), Math.max(1, limit)]);
  return r.rowCount ?? 0;
}

/** 워크스페이스 전체 옛 코어 호환 사본(files)의 바이트 합 — 새 사본을 남길지 정할 때(옛 총량 상한 64MiB 안에서만). */
export async function compatBytesTotal(): Promise<number> {
  const r = await itemsPool.query(`SELECT COALESCE(SUM(octet_length(files::text)), 0)::bigint AS n FROM org_app_version WHERE files <> '[]'::jsonb`);
  return Number(r.rows[0]?.n ?? 0);
}

/** 판 여럿 삭제(보관 수 넘긴 구성원 판). 비면 아무것도 안 한다. */
export async function deleteAppVersions(appId: string, versionNos: number[]): Promise<void> {
  if (!versionNos.length) return;
  await itemsPool.query(`DELETE FROM org_app_version WHERE app_id=$1 AND version_no = ANY($2::int[])`, [appId, versionNos]);
}

/** 워크스페이스 전체 판 묶음(files)의 바이트 합 — 총량 상한 판정(#4600 7d). RLS 가 이 테넌트 행만 센다. */
export async function appVersionBytesTotal(): Promise<number> {
  const r = await itemsPool.query(`SELECT COALESCE(SUM(octet_length(files::text)), 0)::bigint AS n FROM org_app_version`);
  return Number(r.rows[0]?.n ?? 0);
}

/** 구성원 판을 오래된 순으로(앱 불문) — 총량 상한을 넘겼을 때 지울 후보. 지금 서빙 중인 판(org_app.current_version_no)과
 *  #4667 공개 판(published_version_no — 초안이 있는 동안 나머지 모두가 보는 판)은 is_current 로 표시만 하고 호출부가 건너뛴다. */
export async function listMemberVersionsOldestFirst(): Promise<Array<{ app_id: string; version_no: number; bytes: number; is_current: boolean }>> {
  const r = await itemsPool.query(
    `SELECT v.app_id, v.version_no, octet_length(v.files::text)::bigint AS bytes,
            (a.current_version_no = v.version_no OR a.published_version_no = v.version_no) AS is_current
       FROM org_app_version v LEFT JOIN org_app a ON a.id = v.app_id
      WHERE v.origin = 'member'
      ORDER BY v.saved_at ASC, v.app_id ASC, v.version_no ASC`);
  return r.rows.map((x) => ({ app_id: String(x.app_id), version_no: Number(x.version_no), bytes: Number(x.bytes ?? 0), is_current: x.is_current === true }));
}

/** 이 앱의 판 이력 전부 삭제 — 앱 제거 때(빌트인은 제거가 막혀 있어 거의 안 불린다). */
export async function pruneAllAppVersions(appId: string, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(`DELETE FROM org_app_version WHERE app_id=$1`, [appId]);
}

/** 패키지 폴더에 실린 릴리스 판 번호를 적는다(시더). 같은 값이면 쓰지 않는다 — 부팅마다 updated_at 을 흔들지 않게. */
export async function setAppBuiltinVersion(appId: string, version: string): Promise<void> {
  await itemsPool.query(`UPDATE org_app SET builtin_version=$2 WHERE id=$1 AND builtin_version IS DISTINCT FROM $2`, [appId, version]);
}

/** 지금 서빙 중인 상태가 어느 판인가. null = 모름(판 밖의 상태). */
export async function setAppCurrentVersion(appId: string, versionNo: number | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app SET current_version_no=$2 WHERE id=$1`, [appId, versionNo]);
}

/** 판 1건의 머리(파일 제외 — 목록·공개 판 대조용). 없으면 null. */
export interface AppVersionHead extends AppVersionMeta { manifest: unknown }
export async function getAppVersionHead(appId: string, versionNo: number): Promise<AppVersionHead | null> {
  const r = await itemsPool.query(
    `SELECT app_id, version_no, origin, version, content_hash, note, saved_by, saved_at, manifest FROM org_app_version WHERE app_id=$1 AND version_no=$2`,
    [appId, versionNo]);
  const x = r.rows[0];
  return x ? { ...rowToVersionMeta(x), manifest: x.manifest ?? {} } : null;
}

/** 이 내용(해시)을 담은 가장 최근 판 번호 — 설치된 상태를 판 행에 못 박을 때 새로 떠 두기 전에 찾아본다. 없으면 null. */
export async function findVersionByHash(appId: string, contentHash: string): Promise<number | null> {
  const r = await itemsPool.query(
    `SELECT version_no FROM org_app_version WHERE app_id=$1 AND content_hash=$2 ORDER BY version_no DESC LIMIT 1`, [appId, contentHash]);
  return r.rows[0] ? Number(r.rows[0].version_no) : null;
}

/** 여러 앱의 공개 판 머리를 한 번에(목록이 «공개 판을 보는 사람» 에게 제목·매니페스트를 갈아 끼울 때). 키 = 앱 id. */
export async function listPublishedHeads(appIds: readonly string[]): Promise<Map<string, AppVersionHead>> {
  const out = new Map<string, AppVersionHead>();
  if (!appIds.length) return out;
  const r = await itemsPool.query(
    `SELECT v.app_id, v.version_no, v.origin, v.version, v.content_hash, v.note, v.saved_by, v.saved_at, v.manifest
       FROM org_app a JOIN org_app_version v ON v.app_id = a.id AND v.version_no = a.published_version_no
      WHERE a.id = ANY($1::text[])`, [[...appIds]]);
  for (const x of r.rows) out.set(String(x.app_id), { ...rowToVersionMeta(x), manifest: x.manifest ?? {} });
  return out;
}

// ── #4667 공개 상태 · 만든 사람 · 만들기 세션 · 책임자 ─────────────────────────────
//  판정(누가 보나 · 누가 공개하나)은 apps/visibility.ts. 여기는 칸 쓰기뿐이다.

/**
 * 비어 있는 «나만 보는 앱» 을 예약한다 — 앱 만들기 「만들기 시작」 과 app_save 의 새 id 가 먼저 이 행을 만들고 설치가 그 위를 채운다.
 *  설치 코어의 upsertApp 은 ON CONFLICT 로 내용 칸(제목·매니페스트·해시·상태)만 바꾸고 이 칸들은 건드리지 않으므로, 한 번 찍은
 *  만든 사람 · 책임자 · 만들기 세션 · 원본이 그대로 남는다. 같은 id 가 이미 있으면 false(아무것도 안 바꾼다).
 *  content_hash NULL = 아직 첫 판 전 — 목록·붙이기에 서지 않는다(visibility.isEmptyDraftApp).
 */
export async function reserveDraftApp(
  a: { id: string; title: string; made_by: string; build_session: string | null; origin_app_id: string | null },
  ctx: WriteCtx = {},
): Promise<boolean> {
  const manifest = { id: a.id, title: a.title, version: "0.0.0" };
  const r = await itemsPool.query(
    `INSERT INTO org_app(id, title, version, manifest, source, content_hash, status, enabled, installed_by, installed_at, updated_at, updated_by,
                         visibility, made_by, owner_member, build_session, origin_app_id)
       VALUES($1, $2, '0.0.0', $3::jsonb, '{"kind":"inline"}'::jsonb, NULL, 'active', true, $4, now(), now(), $4,
              'me', $4, $4, $5, $6)
     ON CONFLICT (tenant_id, id) DO NOTHING
     RETURNING *`,
    [a.id, a.title, JSON.stringify(manifest), a.made_by, a.build_session, a.origin_app_id]);
  if (!r.rows[0]) return false;
  await audit("org_app", a.id, "insert", null, rowToApp(r.rows[0]), ctx.actor, ctx.source);
  return true;
}

/** 예약만 하고 첫 판을 못 채운 앱 행을 거둔다(그 호출 안에서 설치가 실패했을 때) — 내용이 생긴 앱은 지우지 않는다. */
export async function dropEmptyDraftApp(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app WHERE id=$1 AND content_hash IS NULL AND current_version_no IS NULL`, [appId]);
}

/** 그만둔 만들기가 남긴 빈 예약(이 사람의 것 · 첫 판 없이 days 일 지남)을 거둔다 — 새로 「만들기 시작」 할 때. 거둔 수. */
export async function dropStaleEmptyDrafts(owner: string, days = 3): Promise<number> {
  const r = await itemsPool.query(
    `DELETE FROM org_app WHERE owner_member=$1 AND visibility='me' AND content_hash IS NULL AND current_version_no IS NULL
        AND installed_at < now() - make_interval(days => $2::int)`, [owner, days]);
  return r.rowCount ?? 0;
}

/** 이 세션이 만드는 앱들(최근 것 먼저) — 세션 → 앱 역조회. 판정(볼 수 있나)은 호출부. */
export async function findAppsByBuildSession(sessionId: string): Promise<OrgApp[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app WHERE build_session=$1 ORDER BY updated_at DESC, id`, [sessionId]);
  return r.rows.map(rowToApp);
}

/** 이 앱을 만드는(고치는) 세션을 바꾼다 — 책임자가 새 만들기 세션을 열었을 때(앱빌더 「고치기」). */
export async function setAppBuildSession(appId: string, sessionId: string | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app SET build_session=$2 WHERE id=$1`, [appId, sessionId]);
}

/** 관리자 설치(org_app_install)로 새로 생긴 앱 — 만든 사람·책임자가 비었으면 설치한 사람으로(빈 칸만 채운다). */
export async function stampAppCreatorIfMissing(appId: string, member: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_app SET made_by=COALESCE(made_by,$2), owner_member=CASE WHEN made_by IS NULL THEN $2 ELSE owner_member END WHERE id=$1`,
    [appId, member]);
}

/** 초안 표식 — 설치된 상태가 공개 판과 다를 때 그 초안을 만든 사람(null = 초안 없음). */
export async function setAppDraftBy(appId: string, member: string | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app SET draft_by=$2 WHERE id=$1`, [appId, member]);
}

/** 공개 판을 판 행에 못 박는다(초안이 생기기 직전) — 공개 상태·시각은 그대로, 가리키는 번호만. */
export async function setAppPublishedPointer(appId: string, versionNo: number | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app SET published_version_no=$2 WHERE id=$1`, [appId, versionNo]);
}

/** 「공개하기」 — 이 판을 모두가 보는 판으로. 초안 표식은 걷힌다(설치된 상태 = 공개 판). */
export async function markAppPublished(appId: string, versionNo: number | null, by: string, ctx: WriteCtx = {}): Promise<OrgApp | null> {
  const before = await getApp(appId);
  const r = await itemsPool.query(
    `UPDATE org_app SET visibility='all', published_version_no=$2, published_at=now(), published_by=$3, draft_by=NULL,
                        updated_at=now(), updated_by=$3
      WHERE id=$1 RETURNING *`, [appId, versionNo, by]);
  const after = r.rows[0] ? rowToApp(r.rows[0]) : null;
  if (after) await audit("org_app", appId, "update", before, after, ctx.actor ?? by, ctx.source);
  return after;
}

/** 「나만」 으로 되돌리기(공개 취소) — 다시 책임자만 보는 앱으로. 공개 판 포인터·초안 표식은 걷는다(나만 보는 앱엔 판이 하나다 — 설치된 상태). */
export async function markAppPrivate(appId: string, ctx: WriteCtx = {}): Promise<OrgApp | null> {
  const before = await getApp(appId);
  const r = await itemsPool.query(
    `UPDATE org_app SET visibility='me', published_version_no=NULL, draft_by=NULL, updated_at=now(), updated_by=$2
      WHERE id=$1 RETURNING *`, [appId, ctx.actor ?? null]);
  const after = r.rows[0] ? rowToApp(r.rows[0]) : null;
  if (after) await audit("org_app", appId, "update", before, after, ctx.actor, ctx.source);
  return after;
}

/** 책임자를 바꾼다(관리자) — null = 관리자. 만든 사람(made_by)은 바꾸지 않는다. */
export async function setAppOwner(appId: string, member: string | null, ctx: WriteCtx = {}): Promise<OrgApp | null> {
  const before = await getApp(appId);
  if (!before) return null;
  const r = await itemsPool.query(`UPDATE org_app SET owner_member=$2, updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING *`,
    [appId, member, ctx.actor ?? null]);
  const after = r.rows[0] ? rowToApp(r.rows[0]) : null;
  if (after) await audit("org_app", appId, "update", before, after, ctx.actor, ctx.source);
  return after;
}

/** 떠난 사람이 책임지던 앱을 전부 관리자에게(owner NULL) — 돌려주는 값 = 넘어온 앱들(관리자 알림 재료). 만든 사람 기록은 그대로. */
export async function transferOwnedAppsToAdmins(memberId: string): Promise<Array<{ id: string; title: string; visibility: AppVisibility }>> {
  const r = await itemsPool.query(
    `UPDATE org_app SET owner_member=NULL, updated_at=now(), updated_by='system' WHERE owner_member=$1 RETURNING id, title, visibility`, [memberId]);
  return r.rows.map((x) => ({ id: String(x.id), title: String(x.title ?? x.id), visibility: x.visibility === "me" ? "me" as const : "all" as const }));
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

/** 한 멤버의 활성 grant 전부 — 앱 폴더 목록(#4673 홈 탐색기 root=apps)이 «동의한 앱» 을 한 번에 가린다. 부분 인덱스 org_app_grant_member_idx 가 받친다. */
export async function listActiveGrants(memberId: string): Promise<AppGrantRow[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app_grant WHERE member_id=$1 AND revoked_at IS NULL`, [memberId]);
  return r.rows.map(rowToGrant);
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

// ── org_app_member_pref — 앱 × 보는 사람의 개인 설정(#4601) ────────────────────
//  읽기 하나, 쓰기 하나. 병합·크기 규칙은 apps/app-prefs.ts 가 쥐고(순수), 여기는 **한 트랜잭션** 안에서 지금 값을 잠그고(FOR UPDATE)
//  → 병합 → 검사 → upsert 한다. 두 탭이 동시에 다른 키를 고쳐도 마지막 쓰기가 앞의 것을 지우지 않는다(격리 리뷰 비차단 2).
export async function getMemberPref(appId: string, memberId: string, client?: pg.PoolClient): Promise<Record<string, unknown>> {
  const exec: Q = client ?? itemsPool;
  const r = await exec.query(`SELECT prefs FROM org_app_member_pref WHERE app_id=$1 AND member_id=$2`, [appId, memberId]);
  const v = r.rows[0]?.prefs;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 지금 값을 잠근 채 merge 로 새 값을 만들어 저장한다. merge 가 던지면(400·413) 롤백 — 아무것도 안 바뀐다.
 *  ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, app_id, member_id)로 재작성한다(attachAppRow 와 같은 규약).
 *  돌려주는 값 = 저장된 전체.
 */
export async function updateMemberPref(
  appId: string, memberId: string,
  merge: (cur: Record<string, unknown>) => { prefs: Record<string, unknown>; json: string },
): Promise<Record<string, unknown>> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT prefs FROM org_app_member_pref WHERE app_id=$1 AND member_id=$2 FOR UPDATE`, [appId, memberId]);
    const v = r.rows[0]?.prefs;
    const cur = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const next = merge(cur);
    await client.query(
      `INSERT INTO org_app_member_pref(app_id, member_id, prefs, updated_at) VALUES($1,$2,$3::jsonb,now())
       ON CONFLICT (tenant_id, app_id, member_id) DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()`,
      [appId, memberId, next.json]);
    await client.query("COMMIT");
    return next.prefs;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 앱 제거 때 — 그 앱의 개인 설정을 전부 지운다(FK 가 없어 CASCADE 대신 명시 회수, schema/apps.ts 주석). */
export async function pruneMemberPrefs(appId: string, client?: pg.PoolClient): Promise<void> {
  const exec: Q = client ?? itemsPool;
  await exec.query(`DELETE FROM org_app_member_pref WHERE app_id=$1`, [appId]);
}

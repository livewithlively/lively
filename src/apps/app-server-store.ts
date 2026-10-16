// 앱 서버 저장 계층(#4484 앱 v2-5) — 빌드 기록(org_app_server_build) · 앱별 함수 상태(org_app_server) · 상한(org_runtime_config.app_server_policy).
//  표 정의는 org/schema/apps.ts. 테넌트 칸(tenant_id)은 컬럼 기본값이 채우고 ON CONFLICT 타깃은 그 칸을 포함한다(ensureTenantColumn 규약).
import { itemsPool, withTx } from "../db/client.js";
import { logger } from "../log.js";
import { audit } from "../org/store/audit.js";
import { codeCapDenial, resolveAppServerPolicy, type AppServerPolicy } from "./app-server-policy.js";

// ── 상한 ──
export async function appServerPolicyRow(): Promise<Record<string, unknown>> {
  const r = await itemsPool.query(`SELECT app_server_policy FROM org_runtime_config WHERE id=1`).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const row = r.rows[0]?.app_server_policy;
  return row && typeof row === "object" ? row as Record<string, unknown> : {};
}
export async function appServerPolicy(): Promise<AppServerPolicy> {
  const row = await appServerPolicyRow().catch((err) => { logger.warn({ err: String(err) }, "앱 서버 상한을 읽지 못해 기본값을 쓴다(#4484)"); return {}; });
  return resolveAppServerPolicy(Object.keys(row).length ? row : null);
}
export async function setAppServerPolicy(next: Record<string, number>, ctx: { actor?: string; source?: string }): Promise<void> {
  const before = await appServerPolicyRow();
  await itemsPool.query(`UPDATE org_runtime_config SET app_server_policy=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
  await audit("org_runtime_config", "1", "app_server_policy", before, next, ctx.actor, ctx.source);
}

// ── 빌드 기록 ──
export type BuildStatus = "building" | "ok" | "failed";
export interface ServerBuildRow {
  app_id: string;
  build_key: string;
  version_no: number | null;
  status: BuildStatus;
  zip_key: string | null;
  zip_bytes: number | null;
  zip_sha256: string | null;
  unzipped_bytes: number | null;
  entries: number | null;
  stage: string | null;
  error: string | null;
  log_tail: string | null;
  detail: Record<string, unknown>;
  built_by: string | null;
  session_id: string | null;
  started_at: string;
  finished_at: string | null;
  lease_until: string | null;
}
const BUILD_COLS = `app_id, build_key, version_no, status, zip_key, zip_bytes::float8 AS zip_bytes, zip_sha256, unzipped_bytes::float8 AS unzipped_bytes, entries,
  stage, error, log_tail, detail, built_by, session_id, started_at, finished_at, lease_until`;

export async function getServerBuild(appId: string, key: string): Promise<ServerBuildRow | null> {
  const r = await itemsPool.query(`SELECT ${BUILD_COLS} FROM org_app_server_build WHERE app_id=$1 AND build_key=$2`, [appId, key]);
  return (r.rows[0] as ServerBuildRow | undefined) ?? null;
}

export async function listServerBuilds(appId: string, limit = 5): Promise<ServerBuildRow[]> {
  const r = await itemsPool.query(`SELECT ${BUILD_COLS} FROM org_app_server_build WHERE app_id=$1 ORDER BY started_at DESC LIMIT $2`, [appId, limit]);
  return r.rows as ServerBuildRow[];
}

/**
 * 이 지문의 빌드를 잡는다 — 없거나 · 실패했거나 · 잡은 빌드가 죽었으면(lease 지남) 'building' 으로 다시 세우고 true.
 *  이미 성공했거나 남이 빌드 중이면 false(그 줄을 돌려준다). 한 문장이라 두 요청이 동시에 와도 한쪽만 잡는다.
 */
export async function claimServerBuild(appId: string, key: string, info: { version_no: number; built_by: string; session_id: string; leaseSec: number }): Promise<{ claimed: boolean; row: ServerBuildRow | null }> {
  const r = await itemsPool.query(
    `INSERT INTO org_app_server_build(app_id, build_key, version_no, status, built_by, session_id, started_at, lease_until)
     VALUES ($1, $2, $3, 'building', $4, $5, now(), now() + make_interval(secs => $6))
     ON CONFLICT (tenant_id, app_id, build_key) DO UPDATE SET
       version_no=EXCLUDED.version_no, status='building', built_by=EXCLUDED.built_by, session_id=EXCLUDED.session_id,
       started_at=now(), finished_at=NULL, lease_until=EXCLUDED.lease_until, stage=NULL, error=NULL, log_tail=NULL, detail='{}'::jsonb,
       zip_key=NULL, zip_bytes=NULL, zip_sha256=NULL, unzipped_bytes=NULL, entries=NULL
     WHERE org_app_server_build.status='failed'
        OR (org_app_server_build.status='building' AND org_app_server_build.lease_until < now())
     RETURNING ${BUILD_COLS}`,
    [appId, key, info.version_no, info.built_by, info.session_id, info.leaseSec]);
  if (r.rows[0]) return { claimed: true, row: r.rows[0] as ServerBuildRow };
  return { claimed: false, row: await getServerBuild(appId, key) };
}

/** 빌드가 살아 있다고 알린다(lease 늘리기) — 빌드하는 동안 30초마다. */
export async function touchServerBuild(appId: string, key: string, leaseSec: number): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server_build SET lease_until = now() + make_interval(secs => $3) WHERE app_id=$1 AND build_key=$2 AND status='building'`, [appId, key, leaseSec]);
}

export interface BuildFinish {
  ok: boolean;
  zip?: { key: string; bytes: number; sha256_b64: string; unzipped: number; entries: number };
  stage?: string | null;
  error?: string | null;
  log_tail?: string | null;
  detail?: Record<string, unknown>;
}
export async function finishServerBuild(appId: string, key: string, f: BuildFinish): Promise<ServerBuildRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_server_build SET status=$3, finished_at=now(), lease_until=NULL,
       zip_key=$4, zip_bytes=$5, zip_sha256=$6, unzipped_bytes=$7, entries=$8, stage=$9, error=$10, log_tail=$11, detail=$12::jsonb
     WHERE app_id=$1 AND build_key=$2 RETURNING ${BUILD_COLS}`,
    [appId, key, f.ok ? "ok" : "failed", f.zip?.key ?? null, f.zip?.bytes ?? null, f.zip?.sha256_b64 ?? null, f.zip?.unzipped ?? null, f.zip?.entries ?? null,
      f.stage ?? null, f.error ?? null, f.log_tail ?? null, JSON.stringify(f.detail ?? {})]);
  return (r.rows[0] as ServerBuildRow | undefined) ?? null;
}

/**
 * 성공한 빌드를 못 쓰게 됐다고 적는다(zip 이 저장소에 없음 · 크기 · 지문이 기록과 다름) — 실패로 돌려 두면 다음 배포가 다시 빌드한다
 *  (claimServerBuild 가 실패한 줄을 다시 잡는다). 'ok' 인 줄만 고친다(그 사이 다시 빌드된 줄을 덮지 않게). 고쳤으면 true.
 */
export async function invalidateServerBuild(appId: string, key: string, why: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_server_build SET status='failed', stage='zip', error=$3, finished_at=now() WHERE app_id=$1 AND build_key=$2 AND status='ok'`,
    [appId, key, why.slice(0, 1000)]);
  if ((r.rowCount ?? 0) > 0) logger.warn({ appId, key, why }, "앱 서버 빌드를 못 쓰게 됨 — 다음 배포가 다시 빌드한다(#4484)");
  return (r.rowCount ?? 0) > 0;
}

/** 죽은 빌드(lease 가 지난 building)를 실패로 — 게이트웨이가 빌드 도중 재기동된 경우. 고친 수. */
export async function failStaleServerBuilds(): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_app_server_build SET status='failed', finished_at=now(), lease_until=NULL, stage='interrupted',
       error='빌드가 끝나기 전에 게이트웨이가 다시 시작돼 중단됐습니다 — 다시 빌드하세요'
     WHERE status='building' AND lease_until < now() - interval '1 minute'`);
  return r.rowCount ?? 0;
}

/**
 * 지울 zip — 앱이 사라졌거나, 별칭이 안 가리키고 오래된 빌드(성공 · 실패). 실패한 빌드는 zip 이 없다(행만 지운다).
 *  keep_until(#4791) 이 남은 빌드는 앱이 있는 한 지우지 않는다 — 서버 선언을 뺀 앱의 함수를 걷을 때 그 함수가 쓰던 빌드에 유예를 준다
 *  (빌드한 지 30일이 지났어도 걷은 뒤 30일 동안은 서버 판으로 되돌리면 빌드 없이 함수를 다시 만든다 · 격리 리뷰).
 */
export async function serverBuildsToPrune(olderThanDays: number, limit = 50): Promise<Array<{ app_id: string; build_key: string; zip_key: string | null }>> {
  const r = await itemsPool.query(
    `SELECT b.app_id, b.build_key, b.zip_key FROM org_app_server_build b
       LEFT JOIN org_app a ON a.id = b.app_id
       LEFT JOIN org_app_server s ON s.app_id = b.app_id
      WHERE b.status <> 'building'
        AND (a.id IS NULL OR (b.started_at < now() - make_interval(days => $1)
             AND (b.keep_until IS NULL OR b.keep_until < now())
             AND b.build_key IS DISTINCT FROM s.cur_build_key AND b.build_key IS DISTINCT FROM s.pub_build_key))
      ORDER BY b.started_at LIMIT $2`, [olderThanDays, limit]);
  return r.rows as Array<{ app_id: string; build_key: string; zip_key: string | null }>;
}
/** 빌드 유예(#4791) — 걷는 함수가 쓰던 빌드(별칭이 가리키던 빌드)를 days 일 동안 정리에서 뺀다. */
export async function keepServerBuilds(appId: string, keys: Array<string | null>, days: number): Promise<void> {
  const ks = keys.filter((k): k is string => !!k);
  if (!ks.length) return;
  await itemsPool.query(`UPDATE org_app_server_build SET keep_until = now() + make_interval(days => $3) WHERE app_id=$1 AND build_key = ANY($2::text[])`, [appId, ks, days]);
}
/** zip 크기를 모르는 성공 빌드(옛 줄)에 저장소에서 본 크기를 적는다(#4792 — 코드 저장 셈이 0 으로 새지 않게). */
export async function setServerBuildZipBytes(appId: string, key: string, bytes: number): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server_build SET zip_bytes=$3 WHERE app_id=$1 AND build_key=$2 AND zip_bytes IS NULL`, [appId, key, bytes]);
}
export async function deleteServerBuild(appId: string, key: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_server_build WHERE app_id=$1 AND build_key=$2 AND status <> 'building'`, [appId, key]);
}

// ── 앱별 함수 상태 ──
export type AliasName = "cur" | "pub";
export interface ServerRow {
  app_id: string;
  function_name: string;
  cur_version_no: number | null; cur_build_key: string | null; cur_lambda_version: string | null; cur_at: string | null;
  pub_version_no: number | null; pub_build_key: string | null; pub_lambda_version: string | null; pub_at: string | null;
  stopped_at: string | null; stopped_by: string | null; stop_kind: "auto" | "manual" | null; stop_reason: string | null;
  lock_until: string | null; last_error: string | null;
  /** #4792 이 함수의 코드 저장(바이트) — 마지막 배포 · 옛 판 정리 때 AWS 가 알려 준 판마다의 CodeSize 합($LATEST 포함). */
  code_bytes: number;
  /** #4791 지금 판 · 공개 판 둘 다 서버 선언이 없다고 하우스키핑이 처음 본 때(null = 쓰는 중). unused_retire_days 가 지나면 함수를 걷는다. */
  unused_since: string | null;
  created_at: string; updated_at: string;
}
//  code_bytes 는 BIGINT 라 드라이버가 글자로 준다 — 숫자로 읽는다(빌드 기록의 ::float8 과 같은 까닭).
const toServerRow = (x: Record<string, unknown>): ServerRow => ({ ...x, code_bytes: Number(x.code_bytes ?? 0) || 0 }) as ServerRow;

export async function getServerRow(appId: string): Promise<ServerRow | null> {
  const r = await itemsPool.query(`SELECT * FROM org_app_server WHERE app_id=$1`, [appId]);
  return r.rows[0] ? toServerRow(r.rows[0] as Record<string, unknown>) : null;
}
export async function listServerRows(): Promise<ServerRow[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app_server ORDER BY app_id`);
  return r.rows.map((x) => toServerRow(x as Record<string, unknown>));
}

/** 이 워크스페이스의 함수 줄 수(#4792 상한이 센다 — 앱마다 하나 · 함수를 못 지워 남긴 줄도 함수가 있으니 센다). */
export async function countServerRows(): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_app_server`);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}
/** 이 워크스페이스 함수들의 코드 저장 합(바이트, #4792 — app_server_limits 의 usage). 배포의 판정은 reserveServerCode 가 락 안에서 따로 센다. */
export async function sumServerCodeBytes(): Promise<number> {
  const r = await itemsPool.query(`SELECT coalesce(sum(code_bytes), 0)::float8 AS n FROM org_app_server`);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}
export async function setServerCodeBytes(appId: string, bytes: number): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server SET code_bytes=$2 WHERE app_id=$1`, [appId, Math.max(0, Math.round(bytes))]);
}
/** 아직 모를 때(0)만 적는다 — 하우스키핑이 잰 사이 같은 앱의 배포가 자리를 잡았거나 실측을 적었으면 그 값이 맞다(재검토). 적었으면 true. */
export async function fillServerCodeBytes(appId: string, bytes: number): Promise<boolean> {
  const r = await itemsPool.query(`UPDATE org_app_server SET code_bytes=$2 WHERE app_id=$1 AND code_bytes = 0`, [appId, Math.max(0, Math.round(bytes))]);
  return (r.rowCount ?? 0) > 0;
}
/** 줄을 고른 순서(updated_at)의 뒤로 보낸다 — 영영 못 재는 줄이 하우스키핑의 앞자리를 차지해 다른 줄이 굶지 않게(재검토). */
export async function touchServerRow(appId: string): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server SET updated_at=now() WHERE app_id=$1`, [appId]);
}

/** 워크스페이스 상한(#4792) 자문 락 — 함수 수 줄 잡기와 코드 저장 자리 잡기가 같은 키로 한 줄로 선다. 클러스터 전역이라 테넌트를 섞는다. */
const QUOTA_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.tenant_id', true),'') || '|lvly-app-server-quota'))`;

/**
 * 함수 줄을 잡는다 — 없으면 만든다(함수 이름을 그때 못 박는다 — 슬러그가 나중에 바뀌어도 이 앱의 함수는 그대로).
 *  이미 있으면 그 줄(상한과 무관 — 있는 함수는 늘 고친다). 없으면 이 워크스페이스의 줄이 max 개 밑일 때만 만든다(#4792) — 못 만들면 row null 과 지금 수.
 *  세기와 만들기를 한 트랜잭션 · 워크스페이스 자문 락으로 묶는다: 두 앱의 첫 배포가 같은 때 와도 둘 다 «아직 밑» 을 보고 상한을 넘지 않게.
 *  락은 클러스터 전역이라 키에 테넌트를 섞는다(남의 워크스페이스 배포를 기다리지 않게 · v6 project-store 와 같은 꼴).
 */
export async function claimServerRow(appId: string, functionName: string, max: number): Promise<{ row: ServerRow | null; count: number }> {
  const out = await withTx(async (c) => {
    await c.query(QUOTA_LOCK_SQL);
    const have = await c.query(`SELECT 1 FROM org_app_server WHERE app_id=$1`, [appId]);
    const n = Number(((await c.query(`SELECT count(*)::int AS n FROM org_app_server`)).rows[0] as { n: number } | undefined)?.n ?? 0);
    if (!have.rows.length) {
      if (n >= max) return { created: false, count: n };
      await c.query(`INSERT INTO org_app_server(app_id, function_name) VALUES ($1, $2) ON CONFLICT (tenant_id, app_id) DO NOTHING`, [appId, functionName]);
      return { created: true, count: n + 1 };
    }
    return { created: false, count: n };
  });
  return { row: await getServerRow(appId), count: out.count };
}

/**
 * 코드 저장 상한(#4792) — 판정과 자리 잡기를 한 번에. 함수 수 줄 잡기와 같은 자문 락 안에서 다른 함수들의 합을 읽고, 통과하면 이 함수의
 *  code_bytes 를 max(지금 값, after) 로 올려 둔다 — 같은 때 다른 앱을 올리는 배포가 이 몫을 세게(격리 리뷰: 읽기와 쓰기 사이가 비어 동시 배포가
 *  상한을 넘었다). 배포가 끝나면(성공 · 코드를 올린 뒤의 실패) AWS 실측으로 덮는다. 막히면 그 까닭 · 통과하면 null.
 */
export async function reserveServerCode(appId: string, policy: AppServerPolicy, now: number, after: number): Promise<string | null> {
  return withTx(async (c) => {
    await c.query(QUOTA_LOCK_SQL);
    const r = await c.query(`SELECT coalesce(sum(code_bytes), 0)::float8 AS n FROM org_app_server WHERE app_id <> $1`, [appId]);
    const why = codeCapDenial(policy, Number((r.rows[0] as { n: number } | undefined)?.n ?? 0), now, after);
    if (why) return why;
    await c.query(`UPDATE org_app_server SET code_bytes = GREATEST(code_bytes, $2) WHERE app_id=$1`, [appId, Math.max(0, Math.round(after))]);
    return null;
  });
}

/** 별칭이 있는데 코드 크기를 모르는 줄(0) — 칸을 더하기 전에 올린 함수 · 재기에 실패한 함수. 하우스키핑이 AWS 에서 다시 잰다(#4792). */
export async function serverRowsWithoutCodeSize(limit = 20): Promise<Array<{ app_id: string; function_name: string }>> {
  const r = await itemsPool.query(
    `SELECT app_id, function_name FROM org_app_server WHERE code_bytes = 0 AND (cur_lambda_version IS NOT NULL OR pub_lambda_version IS NOT NULL)
      ORDER BY updated_at LIMIT $1`, [limit]);
  return r.rows as Array<{ app_id: string; function_name: string }>;
}

/** 배포 잠금 — 한 앱의 배포를 한 줄로(별칭을 둘이 동시에 옮기면 엉뚱한 판이 남는다). 잡으면 true. 끝나면 unlockServer. */
export async function lockServer(appId: string, sec: number): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_server SET lock_until = now() + make_interval(secs => $2) WHERE app_id=$1 AND (lock_until IS NULL OR lock_until < now()) RETURNING app_id`, [appId, sec]);
  return (r.rowCount ?? 0) > 0;
}
export async function unlockServer(appId: string): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server SET lock_until = NULL WHERE app_id=$1`, [appId]);
}

export async function setServerAlias(appId: string, alias: AliasName, v: { version_no: number | null; build_key: string; lambda_version: string }): Promise<void> {
  const c = alias === "cur" ? "cur" : "pub";
  //  별칭을 옮겼다 = 서버 선언이 있는 판을 올렸다 — «쓰지 않음» 표시(#4791)를 걷는다(다음 하우스키핑을 기다리지 않게).
  await itemsPool.query(
    `UPDATE org_app_server SET ${c}_version_no=$2, ${c}_build_key=$3, ${c}_lambda_version=$4, ${c}_at=now(), last_error=NULL, unused_since=NULL, updated_at=now() WHERE app_id=$1`,
    [appId, v.version_no, v.build_key, v.lambda_version]);
}
export async function setServerError(appId: string, error: string | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app_server SET last_error=$2, updated_at=now() WHERE app_id=$1`, [appId, error ? error.slice(0, 4000) : null]);
}
/**
 * 멈춤 기록 — 이미 멈춘 줄은 덮지 않는다(자동 멈춤 · 관리자의 멈춤을 책임자가 «손으로 멈춤» 으로 바꿔 스스로 다시 켜는 길을 막는다 — 격리 리뷰).
 *  멈춤을 적었으면 true. 풀기(null)는 늘 적는다.
 */
export async function setServerStopped(appId: string, stopped: { by: string; kind: "auto" | "manual"; reason: string } | null): Promise<boolean> {
  if (!stopped) {
    await itemsPool.query(`UPDATE org_app_server SET stopped_at=NULL, stopped_by=NULL, stop_kind=NULL, stop_reason=NULL, updated_at=now() WHERE app_id=$1`, [appId]);
    return true;
  }
  const r = await itemsPool.query(
    `UPDATE org_app_server SET stopped_at=now(), stopped_by=$2, stop_kind=$3, stop_reason=$4, updated_at=now() WHERE app_id=$1 AND stopped_at IS NULL`,
    [appId, stopped.by, stopped.kind, stopped.reason.slice(0, 1000)]);
  return (r.rowCount ?? 0) > 0;
}
/** 앱의 빌드 기록을 지우고 그 zip 키들을 돌려준다(zip 은 앱마다 따로라 지워도 남의 앱에 닿지 않는다). */
export async function deleteServerBuildRows(appId: string): Promise<{ zipKeys: string[] }> {
  const z = await itemsPool.query(`DELETE FROM org_app_server_build WHERE app_id=$1 RETURNING zip_key`, [appId]);
  return { zipKeys: z.rows.map((x) => (x as { zip_key: string | null }).zip_key).filter((k): k is string => !!k) };
}
export async function deleteServerRow(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_server WHERE app_id=$1`, [appId]);
}
/** 별칭이 하나도 없는 줄(막 만들어 아직 아무 판도 안 올린 줄)만 지운다 — 함수 이름이 남의 것으로 드러났을 때. */
export async function deleteServerRowIfUnused(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_server WHERE app_id=$1 AND cur_lambda_version IS NULL AND pub_lambda_version IS NULL`, [appId]);
}
// ── #4791 서버 선언을 뺀 앱의 함수 ──
/** 함수 줄과 그 앱의 서버 선언(설치된 상태 · 지금 판 · 공개 판의 web.server 원문) — 앱이 있는 줄만(앱이 없으면 고아 쓸기가 맡는다). */
export interface ServerUseRow {
  app_id: string; unused_since: string | null; stopped: boolean;
  /** unused_since 가 days 일 넘게 지났나(DB 시계로 — 표시도 DB 시계로 붙인다). */
  due: boolean;
  srv_app: unknown; srv_cur: unknown; srv_pub: unknown;
}
export async function serverUseRows(days: number, appId: string | null = null): Promise<ServerUseRow[]> {
  const r = await itemsPool.query(
    `SELECT s.app_id, s.unused_since, (s.stopped_at IS NOT NULL) AS stopped,
            (s.unused_since IS NOT NULL AND s.unused_since <= now() - make_interval(days => $1)) AS due,
            a.manifest->'web'->'server' AS srv_app, cv.manifest->'web'->'server' AS srv_cur, pv.manifest->'web'->'server' AS srv_pub
       FROM org_app_server s
       JOIN org_app a ON a.id = s.app_id
       LEFT JOIN org_app_version cv ON cv.app_id = a.id AND cv.version_no = a.current_version_no
       LEFT JOIN org_app_version pv ON pv.app_id = a.id AND pv.version_no = a.published_version_no
      WHERE $2::text IS NULL OR s.app_id = $2
      ORDER BY s.app_id`, [days, appId]);
  return r.rows as ServerUseRow[];
}
/** «쓰지 않음» 표시 — 이미 붙어 있으면 그대로(처음 본 때를 지킨다). 붙였으면 true. */
export async function markServerUnused(appId: string): Promise<boolean> {
  const r = await itemsPool.query(`UPDATE org_app_server SET unused_since=now(), updated_at=now() WHERE app_id=$1 AND unused_since IS NULL`, [appId]);
  return (r.rowCount ?? 0) > 0;
}
export async function clearServerUnused(appId: string): Promise<boolean> {
  const r = await itemsPool.query(`UPDATE org_app_server SET unused_since=NULL, updated_at=now() WHERE app_id=$1 AND unused_since IS NOT NULL`, [appId]);
  return (r.rowCount ?? 0) > 0;
}

/** 앱이 사라졌는데 남은 함수 줄 — 앱을 지울 때 함수를 못 지운 것(하우스키핑이 다시 지운다). */
export async function orphanServerRows(limit = 20): Promise<string[]> {
  const r = await itemsPool.query(
    `SELECT s.app_id FROM org_app_server s LEFT JOIN org_app a ON a.id = s.app_id WHERE a.id IS NULL ORDER BY s.updated_at LIMIT $1`, [limit]);
  return r.rows.map((x) => String((x as { app_id: string }).app_id));
}

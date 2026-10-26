// org_app_spec 읽고 쓰기(#4632 앱 「개발 정보」) — 표 정의는 org/schema/apps.ts, 규칙은 apps/app-spec.ts.
//  ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, app_id, content_hash)로 다시 쓴다(org_app_member_pref 와 같은 규약).
import { itemsPool } from "../db/client.js";
import type { AppSpecDoc, SpecRow } from "./app-spec.js";
import { SPEC_RUNNING_STALE_MS } from "./app-spec.js";

export const SPEC_KEEP = 30;

const ms = (v: unknown): number | null => (v instanceof Date ? v.getTime() : v == null ? null : new Date(String(v)).getTime());
function rowOf(x: Record<string, unknown>): SpecRow {
  const st = x.status === "ok" || x.status === "failed" ? x.status : "running";
  return {
    content_hash: String(x.content_hash), version_no: x.version_no == null ? null : Number(x.version_no), status: st,
    spec: (x.spec && typeof x.spec === "object" ? x.spec : null) as AppSpecDoc | null, error: x.error == null ? null : String(x.error),
    started_at: ms(x.started_at) ?? 0, made_at: ms(x.made_at), model: x.model == null ? null : String(x.model),
  };
}

/** 이 앱의 명세 행 전부(최근 것 먼저 · 앱마다 SPEC_KEEP 줄 안). */
export async function listAppSpecs(appId: string): Promise<SpecRow[]> {
  const r = await itemsPool.query(`SELECT * FROM org_app_spec WHERE app_id=$1 ORDER BY COALESCE(made_at, started_at) DESC`, [appId]);
  return r.rows.map(rowOf);
}

/** 가장 최근에 다 쓴 설명(직전 설명으로 실을 것). 없으면 null. */
export async function lastOkSpec(appId: string, exceptKey: string): Promise<SpecRow | null> {
  const r = await itemsPool.query(
    `SELECT * FROM org_app_spec WHERE app_id=$1 AND status='ok' AND spec IS NOT NULL AND content_hash<>$2 ORDER BY made_at DESC NULLS LAST LIMIT 1`, [appId, exceptKey]);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/**
 * 쓰기를 맡는다 — 행이 없거나, 쓰는 중이 10분을 넘었거나(죽은 것), force 이고 실패한 행이면 'running' 으로 잡고 true.
 *  이미 다 썼거나 누가 쓰는 중이면 false(게이트웨이가 여럿이어도 한 곳만 쓴다).
 */
export async function claimAppSpec(appId: string, key: string, versionNo: number | null, force: boolean): Promise<boolean> {
  const r = await itemsPool.query(
    `INSERT INTO org_app_spec(app_id, content_hash, version_no, status, started_at) VALUES($1,$2,$3,'running',now())
     ON CONFLICT (tenant_id, app_id, content_hash) DO UPDATE SET status='running', started_at=now(), error=NULL, version_no=EXCLUDED.version_no
       WHERE (org_app_spec.status='running' AND org_app_spec.started_at < now() - ($4::int * interval '1 millisecond'))
          OR (org_app_spec.status='failed' AND $5::boolean)
     RETURNING content_hash`,
    [appId, key, versionNo, SPEC_RUNNING_STALE_MS, force]);
  return (r.rowCount ?? 0) > 0;
}

export async function finishAppSpec(appId: string, key: string, out:
  { ok: true; spec: AppSpecDoc; model: string | null; inputTokens: number; outputTokens: number } | { ok: false; error: string; model?: string | null }): Promise<void> {
  if (out.ok) {
    await itemsPool.query(
      `UPDATE org_app_spec SET status='ok', spec=$3::jsonb, model=$4, input_tokens=$5, output_tokens=$6, error=NULL, made_at=now() WHERE app_id=$1 AND content_hash=$2`,
      [appId, key, JSON.stringify(out.spec), out.model, out.inputTokens, out.outputTokens]);
  } else {
    await itemsPool.query(`UPDATE org_app_spec SET status='failed', error=$3, model=COALESCE($4, model), made_at=now() WHERE app_id=$1 AND content_hash=$2`,
      [appId, key, out.error.slice(0, 400), out.model ?? null]);
  }
  //  앱마다 최근 SPEC_KEEP 줄만.
  await itemsPool.query(
    `DELETE FROM org_app_spec WHERE app_id=$1 AND content_hash NOT IN (
       SELECT content_hash FROM org_app_spec WHERE app_id=$1 ORDER BY COALESCE(made_at, started_at) DESC LIMIT $2)`, [appId, SPEC_KEEP]);
}

/** 앱 제거 때 — 그 앱의 명세를 전부 지운다(FK 가 없어 CASCADE 대신 명시 회수). */
export async function pruneAppSpecs(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_spec WHERE app_id=$1`, [appId]);
}

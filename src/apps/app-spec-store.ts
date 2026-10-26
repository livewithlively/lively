// org_app_spec 읽고 쓰기(#4632 앱 「개발 정보」) — 표 정의는 org/schema/apps.ts, 규칙은 apps/app-spec.ts.
//  ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, app_id, content_hash)로 다시 쓴다(org_app_member_pref 와 같은 규약).
import { itemsPool } from "../db/client.js";
import type { AppSpecDoc, SpecRow } from "./app-spec.js";
import { SPEC_RUNNING_STALE_MS } from "./app-spec.js";

export const SPEC_KEEP = 30;

const ms = (v: unknown): number | null => (v instanceof Date ? v.getTime() : v == null ? null : new Date(String(v)).getTime());
const LIGHT = `app_id, content_hash, version_no, status, error, model, started_at, made_at, (spec IS NOT NULL) AS has_spec`;
function rowOf(x: Record<string, unknown>): SpecRow {
  const st = x.status === "ok" || x.status === "failed" ? x.status : "running";
  return {
    content_hash: String(x.content_hash), version_no: x.version_no == null ? null : Number(x.version_no), status: st,
    has_spec: x.has_spec === true, error: x.error == null ? null : String(x.error),
    started_at: ms(x.started_at) ?? 0, made_at: ms(x.made_at), model: x.model == null ? null : String(x.model),
  };
}
const docOf = (v: unknown): AppSpecDoc | null => (v && typeof v === "object" && !Array.isArray(v) ? v as AppSpecDoc : null);

/** 이 앱의 명세 행 전부 — 설명 본문 없이(앱마다 SPEC_KEEP 줄 안). */
export async function listAppSpecs(appId: string): Promise<SpecRow[]> {
  const r = await itemsPool.query(`SELECT ${LIGHT} FROM org_app_spec WHERE app_id=$1`, [appId]);
  return r.rows.map(rowOf);
}

/** 설명 본문 한 줄. */
export async function getAppSpecDoc(appId: string, key: string): Promise<AppSpecDoc | null> {
  const r = await itemsPool.query(`SELECT spec FROM org_app_spec WHERE app_id=$1 AND content_hash=$2 AND status='ok'`, [appId, key]);
  return docOf(r.rows[0]?.spec);
}

/**
 * 직전 설명(프롬프트에 실을 것) — 쓰는 판보다 **앞선 판**의 다 쓴 설명 중 가장 가까운 것. 판 번호가 없으면 없음.
 *  최근에 쓴 아무 판이 아니라 앞선 판만 — 남의 공개 전 판(뒤 번호)의 내용이 공개 판 설명의 «달라진 점» 으로 새지 않게(격리 리뷰 #4632).
 */
export async function prevOkSpec(appId: string, versionNo: number | null): Promise<{ versionNo: number | null; doc: AppSpecDoc } | null> {
  if (versionNo == null) return null;
  const r = await itemsPool.query(
    `SELECT version_no, spec FROM org_app_spec WHERE app_id=$1 AND status='ok' AND spec IS NOT NULL AND version_no < $2 ORDER BY version_no DESC LIMIT 1`, [appId, versionNo]);
  const doc = docOf(r.rows[0]?.spec);
  return doc ? { versionNo: r.rows[0].version_no == null ? null : Number(r.rows[0].version_no), doc } : null;
}

/**
 * 쓰기를 맡는다 — 행이 없거나, 쓰는 중이 10분을 넘었거나(죽은 것), force 이고 실패한 행이면 'running' 으로 잡고 그 잡은 때(마침 표시)를 돌려준다.
 *  이미 다 썼거나 누가 쓰는 중이면 null(게이트웨이가 여럿이어도 한 곳만 쓴다).
 */
export async function claimAppSpec(appId: string, key: string, versionNo: number | null, force: boolean): Promise<string | null> {
  const r = await itemsPool.query(
    `INSERT INTO org_app_spec(app_id, content_hash, version_no, status, started_at) VALUES($1,$2,$3,'running',clock_timestamp())
     ON CONFLICT (tenant_id, app_id, content_hash) DO UPDATE SET status='running', started_at=clock_timestamp(), error=NULL, version_no=EXCLUDED.version_no
       WHERE (org_app_spec.status='running' AND org_app_spec.started_at < now() - ($4::int * interval '1 millisecond'))
          OR (org_app_spec.status='failed' AND $5::boolean)
     RETURNING started_at::text AS t`,
    [appId, key, versionNo, SPEC_RUNNING_STALE_MS, force]);
  return r.rows[0] ? String(r.rows[0].t) : null;
}

/** 다 썼다 · 못 썼다 — 내가 잡은 쓰기일 때만(10분이 지나 남이 다시 잡았으면 그쪽이 적는다). */
export async function finishAppSpec(appId: string, key: string, claim: string, out:
  { ok: true; spec: AppSpecDoc; model: string | null; inputTokens: number; outputTokens: number } | { ok: false; error: string; model?: string | null }): Promise<void> {
  if (out.ok) {
    await itemsPool.query(
      `UPDATE org_app_spec SET status='ok', spec=$4::jsonb, model=$5, input_tokens=$6, output_tokens=$7, error=NULL, made_at=now()
        WHERE app_id=$1 AND content_hash=$2 AND status='running' AND started_at=$3::timestamptz`,
      [appId, key, claim, JSON.stringify(out.spec), out.model, out.inputTokens, out.outputTokens]);
  } else {
    await itemsPool.query(`UPDATE org_app_spec SET status='failed', error=$4, model=COALESCE($5, model), made_at=now()
        WHERE app_id=$1 AND content_hash=$2 AND status='running' AND started_at=$3::timestamptz`,
      [appId, key, claim, out.error.slice(0, 400), out.model ?? null]);
  }
  //  앱마다 최근 SPEC_KEEP 줄만.
  await itemsPool.query(
    `DELETE FROM org_app_spec WHERE app_id=$1 AND content_hash NOT IN (
       SELECT content_hash FROM org_app_spec WHERE app_id=$1 ORDER BY COALESCE(made_at, started_at) DESC LIMIT $2)`, [appId, SPEC_KEEP]);
}

/** 지난 24시간 이 워크스페이스에서 시작한 설명 쓰기 수(하루 상한). */
export async function specsStartedToday(): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_app_spec WHERE started_at > now() - interval '1 day'`);
  return Number(r.rows[0]?.n ?? 0);
}

/** 이 앱에서 마지막으로 설명 쓰기를 시작한 때(ms) — 없으면 null. */
export async function lastSpecStart(appId: string): Promise<number | null> {
  const r = await itemsPool.query(`SELECT max(started_at) AS t FROM org_app_spec WHERE app_id=$1`, [appId]);
  return ms(r.rows[0]?.t);
}

/** 앱 제거 때 — 그 앱의 명세를 전부 지운다(FK 가 없어 CASCADE 대신 명시 회수). */
export async function pruneAppSpecs(appId: string): Promise<void> {
  await itemsPool.query(`DELETE FROM org_app_spec WHERE app_id=$1`, [appId]);
}

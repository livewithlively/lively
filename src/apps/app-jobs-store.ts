// 앱 백그라운드 작업 행(org_app_job) — 읽고 쓰기만 한다 (#4486 앱 v2-7). 판정은 app-jobs-plan.ts, 흐름은 app-jobs.ts.
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다 — 검사 층의 콜백도 워크스페이스 주소(LIVELY_API_URL)로 와서 앞단이 그 테넌트를 붙인다.
//  상태를 바꾸는 쓰기는 전부 «지금 상태가 이것일 때만» 조건을 단다 — 청/녹 두 슬롯 · 감시 · 검사 층 보고가 겹쳐도 한 번만 넘어간다.
import crypto from "node:crypto";
import { itemsPool, withTx } from "../db/client.js";
import { JOB_KEEP_DAYS, type AppJobRowLike, type AppJobStatus, type JobResultView } from "./app-jobs-plan.js";

export interface AppJobRow extends AppJobRowLike {
  function_name: string;
  lambda_version: string;
  token_hash: string | null;
  body: string;
  source: string | null;
  call_hash: string | null;
  run_hash: string | null;
  last_tick_at: Date | null;
  created_at: Date;
  dispatched_at: Date | null;
  claimed_at: Date | null;
  ended_at: Date | null;
}

const COLS = `id, app_id, status, requester, variant, alias, function_name, lambda_version, token_hash, route, body, body_bytes, label, timeout_s, source,
  parent_id, depth, call_hash, run_hash, attempts, cancel_requested, status_code, result, error, duration_ms, created_at, dispatched_at, claimed_at,
  last_tick_at, ended_at`;

const norm = (r: Record<string, unknown> | undefined): AppJobRow | null =>
  r ? ({ ...r, id: Number(r.id), parent_id: r.parent_id == null ? null : Number(r.parent_id) } as unknown as AppJobRow) : null;

// ── 비밀 — DB 엔 sha256 만(작업 컨테이너 #4490 · 로그인 판 #4067 과 같은 꼴) ──
export function newJobSecret(): { secret: string; hash: string } {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hash: hashJobSecret(secret) };
}
export function hashJobSecret(secret: string): string {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}
/** (순수) 비밀 대조 — 상수시간. 해시가 비었거나 모양이 다르면 늘 false(부재를 «통과» 로 접지 않는다). */
export function jobSecretMatches(hash: string | null | undefined, presented: string): boolean {
  const want = String(hash ?? "");
  if (!/^[0-9a-f]{64}$/.test(want) || !presented) return false;
  return crypto.timingSafeEqual(Buffer.from(hashJobSecret(presented), "hex"), Buffer.from(want, "hex"));
}

export interface NewAppJob {
  appId: string; requester: string; variant: "pub" | "draft"; alias: "cur" | "pub"; functionName: string; lambdaVersion: string; tokenHash: string | null;
  route: string; body: string; bodyBytes: number; label: string | null; timeoutS: number; source: string | null; parentId: number | null; depth: number;
}

/**
 * 줄을 세운다 — 앱의 대기 줄 · 최근 24시간 수를 같은 트랜잭션 · 앱 자문 락 안에서 세고(두 요청이 함께 와도 상한을 넘지 않게) 넣는다.
 *  admit 이 까닭을 돌려주면 넣지 않고 그 까닭을 돌려준다.
 */
export async function insertAppJob(j: NewAppJob, admit: (have: { queuedApp: number; dailyApp: number }) => string | null): Promise<{ row: AppJobRow } | { denied: string }> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.tenant_id', true),'') || '|lvly-app-job|' || $1))`, [j.appId]);
    const n = (await c.query(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS daily
         FROM org_app_job WHERE app_id = $1`, [j.appId])).rows[0] as { queued: number; daily: number } | undefined;
    const why = admit({ queuedApp: Number(n?.queued ?? 0), dailyApp: Number(n?.daily ?? 0) });
    if (why) return { denied: why };
    const r = await c.query(
      `INSERT INTO org_app_job(app_id, requester, variant, alias, function_name, lambda_version, token_hash, route, body, body_bytes, label, timeout_s, source, parent_id, depth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${COLS}`,
      [j.appId, j.requester, j.variant, j.alias, j.functionName, j.lambdaVersion, j.tokenHash, j.route, j.body, j.bodyBytes, j.label, j.timeoutS, j.source, j.parentId, j.depth]);
    return { row: norm(r.rows[0] as Record<string, unknown>)! };
  });
}

export async function getAppJob(id: number): Promise<AppJobRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_job WHERE id=$1`, [id]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

export async function listAppJobs(f: { appId?: string | null; requester?: string | null; status?: AppJobStatus | null; limit: number }): Promise<AppJobRow[]> {
  const r = await itemsPool.query(
    `SELECT ${COLS} FROM org_app_job
      WHERE ($1::text IS NULL OR app_id = $1) AND ($2::text IS NULL OR requester = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY id DESC LIMIT $4`,
    [f.appId ?? null, f.requester ?? null, f.status ?? null, Math.max(1, Math.min(100, f.limit))]);
  return r.rows.map((x) => norm(x as Record<string, unknown>)!);
}

/**
 * 부를 작업을 고른다 — 워크스페이스 · 앱 동시 상한 안에서 오래 기다린 것부터. 고른 줄은 그 자리에서 dispatched 로 넘기고 새 부르기 비밀을 단다
 *  (워크스페이스 자문 락 안 — 청/녹 두 슬롯 · 감시가 함께 골라도 상한을 넘지 않는다). 비밀 값은 이 호출만 안다(돌려준다).
 *  appCap = 앱 하나의 동시 상한(이미 워크스페이스 상한까지로 깎은 값).
 */
export async function claimDispatchable(caps: { workspace: number; app: number }, limit = 20): Promise<Array<{ row: AppJobRow; secret: string }>> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.tenant_id', true),'') || '|lvly-app-job-dispatch'))`);
    const busy = (await c.query(`SELECT app_id, count(*)::int AS n FROM org_app_job WHERE status IN ('dispatched','running') GROUP BY app_id`)).rows as Array<{ app_id: string; n: number }>;
    const perApp = new Map(busy.map((b) => [b.app_id, Number(b.n)]));
    let wsBusy = busy.reduce((s, b) => s + Number(b.n), 0);
    if (wsBusy >= caps.workspace) return [];
    const queued = (await c.query(`SELECT id, app_id FROM org_app_job WHERE status = 'queued' AND NOT cancel_requested ORDER BY id LIMIT 500`)).rows as Array<{ id: string; app_id: string }>;
    const out: Array<{ row: AppJobRow; secret: string }> = [];
    for (const q of queued) {
      if (out.length >= limit || wsBusy >= caps.workspace) break;
      const n = perApp.get(q.app_id) ?? 0;
      if (n >= caps.app) continue;
      const s = newJobSecret();
      const r = await c.query(
        `UPDATE org_app_job SET status='dispatched', call_hash=$2, dispatched_at=now(), attempts=attempts+1, updated_at=now()
          WHERE id=$1 AND status='queued' AND NOT cancel_requested RETURNING ${COLS}`, [Number(q.id), s.hash]);
      const row = norm(r.rows[0] as Record<string, unknown> | undefined);
      if (!row) continue;
      perApp.set(q.app_id, n + 1);
      wsBusy++;
      out.push({ row, secret: s.secret });
    }
    return out;
  });
}

/** 부르기가 확실히 실패했다 — 그 부르기의 비밀일 때만 줄로 되돌린다(새 비밀로 다시 부른다 · 늦게 온 옛 부르기는 claim 에서 틀린다). */
export async function requeueAppJob(id: number, callHash: string | null): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET status='queued', call_hash=NULL, updated_at=now()
      WHERE id=$1 AND status='dispatched' AND call_hash IS NOT DISTINCT FROM $2`, [id, callHash]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 시작(claim) — 부른 작업이고 · 그 부르기의 비밀이고 · 취소되지 않았을 때만 running 으로 넘기고 돌기 신원(run_hash)을 단다. 넘겼으면 그 줄.
 *  못 넘기면 null — 까닭은 부르는 쪽이 줄을 다시 읽어 가른다(없음 · 비밀 틀림 · 이미 시작 · 끝남 · 취소).
 */
export async function claimAppJob(id: number, callHash: string, runHash: string): Promise<AppJobRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET status='running', claimed_at=now(), last_tick_at=now(), run_hash=$3, updated_at=now()
      WHERE id=$1 AND status='dispatched' AND call_hash=$2 AND NOT cancel_requested RETURNING ${COLS}`, [id, callHash, runHash]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/** 박동 — 도는 작업이고 그 돌기 신원일 때만. 취소가 걸렸나를 돌려준다(null = 도는 그 작업이 아니다). */
export async function tickAppJob(id: number, runHash: string): Promise<{ cancel: boolean } | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET last_tick_at=now(), updated_at=now() WHERE id=$1 AND status='running' AND run_hash=$2 RETURNING cancel_requested`, [id, runHash]);
  const row = r.rows[0] as { cancel_requested?: boolean } | undefined;
  return row ? { cancel: row.cancel_requested === true } : null;
}

/** 끝 — 지금 상태가 from 중 하나일 때만(그리고 runHash 를 주면 그 돌기 신원일 때만). 끝냈으면 그 줄. */
export async function endAppJob(id: number, from: readonly AppJobStatus[], end: {
  status: "done" | "failed" | "canceled"; error: string | null; statusCode?: number | null; result?: JobResultView | null; durationMs?: number | null;
}, runHash?: string): Promise<AppJobRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET status=$3, error=$4, status_code=$5, result=$6::jsonb, duration_ms=$7, ended_at=now(), updated_at=now()
      WHERE id=$1 AND status = ANY($2::text[]) AND ($8::text IS NULL OR run_hash = $8) RETURNING ${COLS}`,
    [id, from, end.status, end.error ? end.error.slice(0, 2000) : null, end.statusCode ?? null, end.result ? JSON.stringify(end.result) : null,
      end.durationMs ?? null, runHash ?? null]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/** 취소 요청 — 열린 작업에만 표시한다. 기다리는 작업은 감시 · 배차가 곧바로 끝내고, 도는 작업은 검사 층이 다음 박동에 알아챈다. */
export async function requestCancelAppJob(id: number): Promise<AppJobRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET cancel_requested=true, updated_at=now() WHERE id=$1 AND status IN ('queued','dispatched','running') RETURNING ${COLS}`, [id]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/** 감시가 볼 열린 작업(오래된 것부터). */
export async function openAppJobs(limit = 200): Promise<AppJobRow[]> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_job WHERE status IN ('queued','dispatched','running') ORDER BY id LIMIT $1`, [limit]);
  return r.rows.map((x) => norm(x as Record<string, unknown>)!);
}

/** 앱의 열린 작업을 한꺼번에 끝낸다(앱 · 서버를 지울 때). 끝낸 수. */
export async function endOpenAppJobsForApp(appId: string, status: "failed" | "canceled", error: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_app_job SET status=$2, error=$3, ended_at=now(), updated_at=now() WHERE app_id=$1 AND status IN ('queued','dispatched','running')`, [appId, status, error]);
  return r.rowCount ?? 0;
}

/** 열린 작업이 붙잡은 함수 판 · 토큰(배포가 정리 · 회수에서 뺀다). */
export async function openJobPins(appId: string): Promise<{ versions: string[]; tokens: string[] }> {
  const r = await itemsPool.query(
    `SELECT DISTINCT lambda_version, token_hash FROM org_app_job WHERE app_id=$1 AND status IN ('queued','dispatched','running')`, [appId]);
  const rows = r.rows as Array<{ lambda_version: string | null; token_hash: string | null }>;
  return { versions: [...new Set(rows.map((x) => x.lambda_version).filter((v): v is string => !!v))], tokens: [...new Set(rows.map((x) => x.token_hash).filter((v): v is string => !!v))] };
}

/** 끝난 지 JOB_KEEP_DAYS 가 지난 작업 행을 지운다(한 판 limit 줄). 지운 수. */
export async function pruneAppJobs(limit = 1000, days = JOB_KEEP_DAYS): Promise<number> {
  const r = await itemsPool.query(
    `DELETE FROM org_app_job WHERE id IN (SELECT id FROM org_app_job WHERE ended_at IS NOT NULL AND ended_at < now() - make_interval(days => $2) ORDER BY ended_at LIMIT $1)`,
    [limit, days]);
  return r.rowCount ?? 0;
}

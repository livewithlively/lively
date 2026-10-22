// 앱 서버 호출 세기 · 동시 처리 상한(#4485 앱 v2-6) — 앱 주소 → 함수를 부르는 자리(app-front-server)가 쓴다.
//
//  ① 동시 처리 상한(#4792 결정 · 상민 2026-10-16): 워크스페이스마다 · 앱마다 지금 처리 중인 요청 수를 세고, 상한(app_server_policy
//     max_inflight_workspace · max_inflight_app)을 넘으면 함수를 부르지 않고 거절한다. 세는 곳은 이 게이트웨이 프로세스 하나다 — 매니지드는
//     중앙 게이트웨이(gw-central) 하나가 모든 앱 주소 요청을 받는다. 교대(롤) 동안 옛 · 새 프로세스가 몇 초 겹치면 그 사이만 합이 두 배까지 열린다.
//  ② 호출 세기 — 함수를 부르는 길이 게이트웨이 하나뿐이라(함수 주소 없음 · 설계 §19) 여기서 센 수가 곧 전부다. 자동 멈춤 감시(app-server-watch)가
//     CloudWatch 지표(1,000개당 $0.01) 대신 이 수를 본다. 5분 칸(org_app_server_usage)에 쌓고, 몇 초마다 한 번에 적는다(요청마다 DB 를 쓰지 않게).
//     실행 시간은 Lambda 가 흘려 받기 끝에 주는 REPORT 줄의 «Billed Duration» 이다(없으면 게이트웨이가 잰 시간).
//  ③ 백그라운드 작업(#4486)은 이 수에 넣지 않는다(의도) — 작업은 사람 요청이 아니라 게이트웨이가 함수를 비동기로 맡긴 것이고(app-jobs dispatchAppJobs),
//     하나가 15분까지 돌아 «5분 실행 시간 합 3,000초» 기준이 작업 넷에 걸린다. 작업의 비용 안전망은 작업 상한이다 — 동시 · 대기 줄 · 하루 수 ·
//     작업 시간 · 메모리 천장(app_server_policy jobs_* · job_timeout_s · memory_max_mb). 그래서 ②의 «여기서 센 수가 곧 전부» 는 사람 요청의 수다.
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { currentTenant, withTenant, type TenantContext } from "../org/tenant-context.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";

// ── ① 동시 처리 상한 ──

const inflight = new Map<string, number>();
const tenantKey = (): string => currentTenant()?.id ?? SINGLE_TENANT_ID;

export type InflightDenied = { denied: "workspace" | "app"; limit: number };

/** 자리 하나를 잡는다 — 잡으면 놓는 함수, 넘치면 무엇이 넘쳤는지. 놓는 함수는 여러 번 불러도 한 번만 센다. */
export function acquireInflight(appId: string, limits: { workspace: number; app: number }): (() => void) | InflightDenied {
  const t = tenantKey();
  const wk = `w\0${t}`, ak = `a\0${t}\0${appId}`;
  const w = inflight.get(wk) ?? 0, a = inflight.get(ak) ?? 0;
  if (w >= limits.workspace) return { denied: "workspace", limit: limits.workspace };
  if (a >= limits.app) return { denied: "app", limit: limits.app };
  inflight.set(wk, w + 1);
  inflight.set(ak, a + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const k of [wk, ak]) {
      const n = (inflight.get(k) ?? 1) - 1;
      if (n <= 0) inflight.delete(k); else inflight.set(k, n);
    }
  };
}

/** 시험 · 상태용 — 지금 처리 중인 수. */
export function inflightNow(appId?: string): { workspace: number; app: number | null } {
  const t = tenantKey();
  return { workspace: inflight.get(`w\0${t}`) ?? 0, app: appId ? inflight.get(`a\0${t}\0${appId}`) ?? 0 : null };
}
export function resetInflightForTest(): void { inflight.clear(); }

// ── ② 호출 세기 ──

export const USAGE_BUCKET_SEC = 300;
const FLUSH_MS = 5_000;
interface Acc { ctx: TenantContext | null; appId: string; bucket: number; calls: number; billedMs: number; errors: number; rejected: number; tries: number }
const pending = new Map<string, Acc>();
let timer: ReturnType<typeof setInterval> | null = null;
const bucketOf = (ms: number): number => Math.floor(ms / 1000 / USAGE_BUCKET_SEC) * USAGE_BUCKET_SEC;

/** 함수 호출 한 번(또는 상한으로 거절 한 번)을 센다 — 지금 테넌트 문맥으로. 몇 초 뒤 한 번에 적는다. */
export function recordAppServerCall(appId: string, r: { billedMs?: number | null; error?: boolean; rejected?: boolean }, nowMs: number = Date.now()): void {
  const ctx = currentTenant();
  const bucket = bucketOf(nowMs);
  const key = `${ctx?.id ?? SINGLE_TENANT_ID}\0${appId}\0${bucket}`;
  const a = pending.get(key) ?? { ctx, appId, bucket, calls: 0, billedMs: 0, errors: 0, rejected: 0, tries: 0 };
  if (r.rejected) a.rejected++;
  else {
    a.calls++;
    a.billedMs += Math.max(0, Math.round(Number(r.billedMs) || 0));
    if (r.error) a.errors++;
  }
  pending.set(key, a);
  if (!timer) {
    timer = setInterval(() => { void flushAppServerUsage(); }, FLUSH_MS);
    timer.unref?.();
  }
}

/** 쌓인 수를 적는다 — 실패한 칸은 남겨 두었다가 다음에(다섯 번까지). 시험이 직접 부른다. */
export async function flushAppServerUsage(): Promise<number> {
  const items = [...pending.entries()];
  let n = 0;
  for (const [key, a] of items) {
    pending.delete(key);
    const write = (): Promise<unknown> => itemsPool.query(
      `INSERT INTO org_app_server_usage(app_id, bucket, calls, billed_ms, errors, rejected)
       VALUES ($1, to_timestamp($2), $3, $4, $5, $6)
       ON CONFLICT (tenant_id, app_id, bucket) DO UPDATE SET
         calls = org_app_server_usage.calls + EXCLUDED.calls, billed_ms = org_app_server_usage.billed_ms + EXCLUDED.billed_ms,
         errors = org_app_server_usage.errors + EXCLUDED.errors, rejected = org_app_server_usage.rejected + EXCLUDED.rejected, updated_at = now()`,
      [a.appId, a.bucket, a.calls, a.billedMs, a.errors, a.rejected]);
    try {
      await (a.ctx ? withTenant(a.ctx, write) : write());
      n++;
    } catch (err) {
      if (++a.tries < 5) {
        //  그 사이 같은 칸에 더 쌓였으면 합친다.
        const cur = pending.get(key);
        if (cur) { cur.calls += a.calls; cur.billedMs += a.billedMs; cur.errors += a.errors; cur.rejected += a.rejected; cur.tries = Math.max(cur.tries, a.tries); }
        else pending.set(key, a);
      } else {
        logger.warn({ err: String((err as Error)?.message ?? err), app: a.appId }, "앱 서버 호출 수를 적지 못해 버렸다(#4485) — 자동 멈춤 감시가 그만큼 덜 본다");
      }
    }
  }
  if (!pending.size && timer) { clearInterval(timer); timer = null; }
  return n;
}

/**
 * 자동 멈춤 감시용 — 앱마다 «가장 바빴던 5분 칸» 의 호출 수 · 실행 시간(초). 지금 칸(덜 찬 칸)과 바로 앞 칸 중 큰 쪽이다
 *  (CloudWatch 지표를 10분 · 5분 단위로 보고 큰 값을 쓰던 v2-5 와 같은 뜻). 이 프로세스에 아직 안 적은 수도 더한다.
 */
export async function appServerUsage5m(nowMs: number = Date.now()): Promise<Map<string, { calls: number; billedSec: number }>> {
  const cur = bucketOf(nowMs), prev = cur - USAGE_BUCKET_SEC;
  const r = await itemsPool.query(
    `SELECT app_id, EXTRACT(EPOCH FROM bucket)::bigint AS b, calls, billed_ms::float8 AS billed_ms FROM org_app_server_usage WHERE bucket >= to_timestamp($1)`, [prev]);
  const per = new Map<string, Map<number, { calls: number; billedMs: number }>>();
  const add = (app: string, b: number, calls: number, billedMs: number): void => {
    const m = per.get(app) ?? new Map<number, { calls: number; billedMs: number }>();
    const x = m.get(b) ?? { calls: 0, billedMs: 0 };
    x.calls += calls; x.billedMs += billedMs;
    m.set(b, x); per.set(app, m);
  };
  for (const row of r.rows as Array<{ app_id: string; b: string | number; calls: number; billed_ms: number }>) add(row.app_id, Number(row.b), Number(row.calls), Number(row.billed_ms));
  const t = tenantKey();
  for (const a of pending.values()) if ((a.ctx?.id ?? SINGLE_TENANT_ID) === t && a.bucket >= prev) add(a.appId, a.bucket, a.calls, a.billedMs);
  const out = new Map<string, { calls: number; billedSec: number }>();
  for (const [app, m] of per) {
    let calls = 0, billed = 0;
    for (const x of m.values()) { calls = Math.max(calls, x.calls); billed = Math.max(billed, x.billedMs); }
    out.set(app, { calls, billedSec: billed / 1000 });
  }
  return out;
}

/** 옛 칸 지우기(하우스키핑) — 지운 줄 수. */
export async function pruneAppServerUsage(days = 7): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM org_app_server_usage WHERE bucket < now() - make_interval(days => $1)`, [days]);
  return r.rowCount ?? 0;
}

export function resetUsageForTest(): void { pending.clear(); if (timer) { clearInterval(timer); timer = null; } }

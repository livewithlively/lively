// 앱 서버 감시 · 정리(#4484 앱 v2-5) — 하우스키핑(매니지드 테넌트 틱 5분 · 자가호스팅은 쓰지 않는다)이 부른다.
//
//  ① 자동 멈춤(상민 2026-10-15): 앱별 5분 호출 수 · 실행 시간 합을 CloudWatch 지표로 보고 상한(app_server_policy)을 넘으면 그 함수의
//     동시 실행을 0 으로(멈춤) + 책임자 · 관리자 알림. 다시 켜기는 관리자(app_server_resume).
//     ⚠ 원가: GetMetricData 는 «지표 1,000개당 $0.01» 이다. 함수마다 5분마다 두 지표를 보면 앱 1,500개 규모에서 월 수백 달러가 된다.
//      그래서 지난번에 호출이 0 이던 함수는 30분에 한 번만 보고(조용한 앱이 갑자기 폭주해도 30분 안에 잡는다), 실행 시간은 호출이 있던 함수만 본다.
//      v2-6 이 앱 주소 앞단에서 요청을 세면(무료) 이 조회는 더 줄일 수 있다.
//  ② 죽은 빌드 걷기 — 게이트웨이가 빌드 도중 다시 시작되면 'building' 줄이 남는다(lease 지남 → failed).
//  ③ 옛 빌드 정리 — 앱이 사라졌거나, 별칭이 안 가리키고 30일 지난 빌드의 zip 을 지운다(판 묶음이 남아 있어 다시 빌드할 수 있다).
import { logger } from "../log.js";
import { appBundleS3Config, blobTenant } from "./app-blob-store.js";
import { appServerEnv } from "./app-server-config.js";
import { autoStopReason, type AppServerPolicy } from "./app-server-policy.js";
import * as st from "./app-server-store.js";
import { realLambdaApi, type LambdaApi } from "./app-server-deploy.js";
import { getMetricData, type MetricQuery, type MetricResult } from "../net/aws/lambda-lite.js";
import { s3Delete } from "../net/aws/s3-lite.js";
import { notifyAppInstaller } from "./notify.js";
import { listActiveAdminIds } from "../org/store/members.js";
import { getApp } from "../org/store/apps.js";

export const IDLE_RECHECK_MS = 30 * 60_000;
export const BUILD_PRUNE_DAYS = 30;

/** 함수마다 «마지막으로 본 때 · 그때 호출이 있었나»(이 게이트웨이 프로세스 안 — 재기동하면 한 번 전부 본다). */
const seen = new Map<string, { at: number; active: boolean }>();
export function resetWatchStateForTest(): void { seen.clear(); }

export interface WatchDeps {
  api?: LambdaApi;
  metrics?: (queries: MetricQuery[], range: { start: Date; end: Date; periodSec: number }) => Promise<MetricResult[]>;
  notify?: (appId: string, title: string, body: string) => Promise<void>;
  now?: () => number;
}

/** 이번 틱에 볼 함수 — 지난번에 바빴거나 · 처음 보거나 · 조용했어도 30분이 지났으면. */
export function dueForCheck(fn: string, now: number): boolean {
  const s = seen.get(`${blobTenant()}:${fn}`);
  return !s || s.active || now - s.at >= IDLE_RECHECK_MS;
}

const maxOf = (r: MetricResult | undefined): number | null => (r && r.values.length ? Math.max(...r.values) : null);

async function defaultNotify(appId: string, title: string, body: string): Promise<void> {
  const app = await getApp(appId).catch(() => null);
  const to = new Set<string>(await listActiveAdminIds().catch(() => [] as string[]));
  if (app?.owner_member) to.add(app.owner_member);
  for (const m of to) {
    await notifyAppInstaller({ appId, memberId: m, title, body, dedupe_key: `app-server-stop:${appId}` }).catch(() => null);
  }
}

/** ① 자동 멈춤 한 바퀴 — 멈춘 함수 수와 본 함수 수. */
export async function watchAppServers(policy: AppServerPolicy, deps: WatchDeps = {}): Promise<{ checked: number; stopped: string[] }> {
  const env = appServerEnv();
  if (!env) return { checked: 0, stopped: [] };
  const now = (deps.now ?? Date.now)();
  const rows = (await st.listServerRows()).filter((r) => !r.stopped_at && (r.cur_lambda_version || r.pub_lambda_version));
  const due = rows.filter((r) => dueForCheck(r.function_name, now));
  if (!due.length) return { checked: 0, stopped: [] };
  const range = { start: new Date(now - 10 * 60_000), end: new Date(now), periodSec: 300 };
  const metrics = deps.metrics ?? ((q, r) => getMetricData({ region: env.region }, q, r));
  const inv = await metrics(due.map((r, i) => ({ id: `i${i}`, fn: r.function_name, metric: "Invocations", stat: "Sum" })), range);
  const busy = due.map((r, i) => ({ r, i, n: maxOf(inv.find((x) => x.id === `i${i}`)) })).filter((x) => (x.n ?? 0) > 0);
  const dur = busy.length ? await metrics(busy.map((x) => ({ id: `d${x.i}`, fn: x.r.function_name, metric: "Duration", stat: "Sum" })), range) : [];
  const stopped: string[] = [];
  for (const [i, r] of due.entries()) {
    const n = maxOf(inv.find((x) => x.id === `i${i}`));
    const ms = maxOf(dur.find((x) => x.id === `d${i}`));
    seen.set(`${blobTenant()}:${r.function_name}`, { at: now, active: (n ?? 0) > 0 });
    const why = autoStopReason(policy, { invocations5m: n, durationSec5m: ms == null ? null : ms / 1000 });
    if (!why) continue;
    try {
      await (deps.api ?? realLambdaApi(env.region)).putConcurrency(r.function_name, 0);
      await st.setServerStopped(r.app_id, { by: "auto", reason: `auto: ${why}` });
      stopped.push(r.app_id);
      logger.warn({ app: r.app_id, fn: r.function_name, why }, "앱 서버 자동 멈춤(#4484)");
      const title = `앱 「${r.app_id}」 의 서버를 자동으로 멈췄습니다`;
      const body = `까닭: ${why}. 앱 화면은 그대로 열리지만 서버가 하는 일(데이터 처리 등)은 멈춥니다. 원인을 고친 뒤 관리자가 app_server_resume 으로 다시 켭니다. ` +
        "기준은 관리자가 app_server_limits_set(stop_invocations_5m · stop_duration_s_5m)으로 바꿀 수 있습니다.";
      await (deps.notify ?? defaultNotify)(r.app_id, title, body).catch(() => { /* 알림 실패는 멈춤을 되돌리지 않는다 */ });
    } catch (e) {
      logger.error({ err: e, app: r.app_id }, "앱 서버 자동 멈춤 실패(#4484) — 다음 틱에 다시 본다");
    }
  }
  return { checked: due.length, stopped };
}

/** ③ 옛 빌드 정리 — zip 을 지우고 줄을 지운다. 지운 수. */
export async function pruneServerBuilds(limit = 50): Promise<number> {
  const s3 = appBundleS3Config();
  let n = 0;
  for (const b of await st.serverBuildsToPrune(BUILD_PRUNE_DAYS, limit)) {
    try {
      if (b.zip_key && s3) await s3Delete(s3, b.zip_key, { attempts: 1, timeoutMs: 10_000 });
      await st.deleteServerBuild(b.app_id, b.build_key);
      n++;
    } catch (e) { logger.warn({ err: e, app: b.app_id, key: b.build_key }, "옛 앱 서버 빌드 정리 실패(비치명 — 다음 틱)"); }
  }
  return n;
}

/** 하우스키핑 한 번 — 매니지드 테넌트 틱(web.ts step "app-servers")이 부른다. 앱 서버가 꺼진 배포면 아무것도 안 한다. */
export async function runAppServerHousekeeping(deps: WatchDeps = {}): Promise<Record<string, unknown>> {
  if (!appServerEnv()) return { skipped: "disabled" };
  const out: Record<string, unknown> = {};
  out.stale_builds = await st.failStaleServerBuilds().catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  const policy = await st.appServerPolicy();
  out.watch = await watchAppServers(policy, deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.pruned = await pruneServerBuilds().catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  return out;
}

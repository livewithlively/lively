// 앱 서버 감시 · 정리(#4484 앱 v2-5) — 하우스키핑(매니지드 테넌트 틱 5분 · 자가호스팅은 쓰지 않는다)이 부른다.
//
//  ① 자동 멈춤(상민 2026-10-15): 앱별 5분 호출 수 · 실행 시간 합을 보고 상한(app_server_policy)을 넘으면 그 함수의
//     동시 실행을 0 으로(멈춤) + 책임자 · 관리자 알림. 다시 켜기는 관리자(app_server_resume).
//     #4485(v2-6) — 수는 **게이트웨이가 센 것**(app-server-usage · org_app_server_usage)을 본다. 함수를 부르는 길이 게이트웨이뿐이라(함수 주소 없음 ·
//      설계 §19) 그 수가 전부다. v2-5 는 CloudWatch 지표(GetMetricData — «지표 1,000개당 $0.01», 앱 1,500개 규모 월 약 $45 추정)를 봤다 — 그 조회는 없앴다.
//      실행 시간은 Lambda 가 흘려 받기 끝에 준 REPORT 의 Billed Duration 합이다.
//  ② 죽은 빌드 걷기 — 게이트웨이가 빌드 도중 다시 시작되면 'building' 줄이 남는다(lease 지남 → failed).
//  ③ 옛 빌드 정리 — 앱이 사라졌거나, 별칭이 안 가리키고 30일 지난 빌드의 zip 을 지운다(판 묶음이 남아 있어 다시 빌드할 수 있다).
//  ④ 고아 함수 — 앱을 지울 때 함수를 못 지워 남긴 줄(org_app_server)을 다시 지운다.
//  ⑤ 서버 선언을 뺀 앱의 함수(#4791 · 결정 상민 2026-10-16) — 설치된 상태 · 지금 판 · 공개 판 모두 web.server 가 없으면 표시(unused_since)를 붙이고,
//     unused_retire_days(기본 7일)가 지나면 함수 · 로그 그룹 · 함수 줄을 걷는다(빌드 기록은 남긴다). 알림은 보내지 않는다(상태에 retire_at).
//     멈춘 함수는 표시도 걷기도 하지 않는다 — 지웠다 새로 만들면 자동 멈춤 · 관리자 멈춤이 풀리는 길이 된다(되살린 함수는 멈춤 기록이 없다).
//  ⑥ 코드 크기를 모르는 함수(#4792) — 별칭이 있는데 code_bytes 가 0 인 줄을 AWS 에서 다시 잰다(틱마다 20개 · 못 잰 줄은 뒤로 보낸다).
import { logger } from "../log.js";
import { appBundleS3Config } from "./app-blob-store.js";
import { appServerEnv, serverDeclOf } from "./app-server-config.js";
import { autoStopReason, codeBytesOf, type AppServerPolicy } from "./app-server-policy.js";
import * as st from "./app-server-store.js";
import { publicError, realLambdaApi, type LambdaApi } from "./app-server-deploy.js";
import { removeServer, retireServer, stopServer } from "./app-server-lifecycle.js";
import { s3Delete } from "../net/aws/s3-lite.js";
import { appServerUsage5m, pruneAppServerUsage } from "./app-server-usage.js";
import { notifyAppInstaller } from "./notify.js";
import { listActiveAdminIds } from "../org/store/members.js";
import { getApp } from "../org/store/apps.js";

export const BUILD_PRUNE_DAYS = 30;
/** 호출 수 칸(org_app_server_usage) 보관 — 감시는 마지막 10분만 본다. */
export const USAGE_KEEP_DAYS = 7;

export interface WatchDeps {
  api?: LambdaApi;
  /** 시험 — 앱마다 5분 호출 수 · 실행 시간(초). 기본 = 게이트웨이가 센 수(app-server-usage). */
  usage?: () => Promise<Map<string, { calls: number; billedSec: number }>>;
  /** 시험 — ⑤ 걷기 직전(후보를 고른 뒤 · 잠그기 전). 그 사이 서버 판이 돌아오는 경합을 흉내 낸다. */
  beforeRetire?: (appId: string) => Promise<void>;
  /** kind — 'stopped'(멈춤) · 'stop-failed'(기준을 넘었는데 멈추지 못함). 같은 앱 · 같은 종류는 읽기 전까지 한 장. */
  notify?: (appId: string, title: string, body: string, kind: "stopped" | "stop-failed") => Promise<void>;
  now?: () => number;
}


async function defaultNotify(appId: string, title: string, body: string, kind: "stopped" | "stop-failed"): Promise<void> {
  const app = await getApp(appId).catch(() => null);
  const to = new Set<string>(await listActiveAdminIds().catch(() => [] as string[]));
  if (app?.owner_member) to.add(app.owner_member);
  for (const m of to) {
    await notifyAppInstaller({ appId, memberId: m, title, body, dedupe_key: `app-server-${kind}:${appId}` }).catch(() => null);
  }
}

/** ① 자동 멈춤 한 바퀴 — 멈춘 함수 수와 본 함수 수. */
export async function watchAppServers(policy: AppServerPolicy, deps: WatchDeps = {}): Promise<{ checked: number; stopped: string[] }> {
  const env = appServerEnv();
  if (!env) return { checked: 0, stopped: [] };
  const rows = (await st.listServerRows()).filter((r) => !r.stopped_at && (r.cur_lambda_version || r.pub_lambda_version));
  if (!rows.length) return { checked: 0, stopped: [] };
  const usage = await (deps.usage ?? (() => appServerUsage5m((deps.now ?? Date.now)())))();
  const stopped: string[] = [];
  for (const r of rows) {
    const u = usage.get(r.app_id);
    const why = autoStopReason(policy, { invocations5m: u ? u.calls : null, durationSec5m: u ? u.billedSec : null });
    if (!why) continue;
    try {
      //  멈춤은 손으로 멈추기와 같은 길 — 남의 워크스페이스 함수(태그)면 409 로 건너뛰고, 이미 멈춘 함수의 기록은 덮지 않는다.
      const res = await stopServer(r.app_id, "auto", "auto", why, deps.api ? { api: deps.api } : {});
      if (!res.changed) continue;
      stopped.push(r.app_id);
      logger.warn({ app: r.app_id, fn: r.function_name, why }, "앱 서버 자동 멈춤(#4484)");
      const title = `앱 「${r.app_id}」 의 서버를 자동으로 멈췄습니다`;
      const body = `까닭: ${why}. 앱 화면은 그대로 열리지만 서버가 하는 일(데이터 처리 등)은 멈춥니다. 원인을 고친 뒤 관리자가 app_server_resume 으로 다시 켭니다. ` +
        "기준은 관리자가 app_server_limits_set(stop_invocations_5m · stop_duration_s_5m)으로 바꿀 수 있습니다.";
      await (deps.notify ?? defaultNotify)(r.app_id, title, body, "stopped").catch(() => { /* 알림 실패는 멈춤을 되돌리지 않는다 */ });
    } catch (e) {
      logger.error({ err: e, app: r.app_id }, "앱 서버 자동 멈춤 실패(#4484) — 다음 틱에 다시 본다");
      //  비용 안전망이 풀린 채라는 걸 사람이 알아야 한다(예: 권한이 빠져 모든 함수가 «남의 것» 으로 보여 조용히 안 멈춤 — 격리 리뷰).
      const title = `앱 「${r.app_id}」 의 서버가 기준을 넘었는데 자동으로 멈추지 못했습니다`;
      const body = `까닭: ${why}. 멈추기 실패: ${publicError(e)}. 비용 상한이 풀린 상태일 수 있습니다 — 관리자가 app_server_status 로 보고 app_server_stop 으로 멈춰 주세요(다음 틱에 다시 시도합니다).`;
      await (deps.notify ?? defaultNotify)(r.app_id, title, body, "stop-failed").catch(() => { /* 알림 실패 — 로그는 남았다 */ });
    }
  }
  return { checked: rows.length, stopped };
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

/** ④ 고아 함수 — 앱이 사라진 함수 줄을 다시 지운다(removeServer 가 잠금 · 주인 확인 · 실패면 줄을 남김을 그대로 한다). 지운 수. */
export async function sweepOrphanServers(deps: WatchDeps = {}): Promise<number> {
  let n = 0;
  for (const appId of await st.orphanServerRows()) {
    const r = await removeServer(appId, deps.api ? { api: deps.api } : {});
    if (r.removed) n++;
    else if (r.errors.length) logger.warn({ appId, errors: r.errors }, "고아 앱 서버 함수 지우기 — 다음 틱에 다시(#4484)");
  }
  return n;
}

/** 이 줄의 앱이 서버를 쓰나 — 설치된 상태 · 지금 판 · 공개 판 중 하나라도 web.server 를 선언했으면 쓴다(넉넉히: 셋 다 없을 때만 «안 씀»). */
const serverInUse = (r: st.ServerUseRow): boolean => [r.srv_app, r.srv_cur, r.srv_pub].some((x) => x != null && serverDeclOf({ web: { server: x } }) != null);

/** ⑤ 서버 선언을 뺀 앱의 함수 — 표시 · 표시 걷기 · 기한이 지난 함수 걷기. */
export async function retireUnusedServers(policy: AppServerPolicy, deps: WatchDeps = {}): Promise<{ marked: number; cleared: number; retired: string[]; skipped: Array<{ app: string; why: string }> }> {
  const out = { marked: 0, cleared: 0, retired: [] as string[], skipped: [] as Array<{ app: string; why: string }> };
  for (const r of await st.serverUseRows(policy.unused_retire_days)) {
    if (serverInUse(r) || r.stopped) {
      if (r.unused_since && (await st.clearServerUnused(r.app_id))) out.cleared++;
      continue;
    }
    if (!r.unused_since) { if (await st.markServerUnused(r.app_id)) out.marked++; continue; }
    if (!r.due) continue;
    await deps.beforeRetire?.(r.app_id);
    const recheck = async (): Promise<boolean> => {
      const now = (await st.serverUseRows(policy.unused_retire_days, r.app_id))[0];
      return !!now && !serverInUse(now) && !now.stopped && now.due;
    };
    const res = await retireServer(r.app_id, recheck, deps.api ? { api: deps.api } : {});
    if (res.retired) {
      out.retired.push(r.app_id);
      logger.info({ app: r.app_id, errors: res.errors }, "서버 선언을 뺀 앱의 함수를 걷었다(#4791)");
    } else out.skipped.push({ app: r.app_id, why: res.skipped ?? "?" });
  }
  return out;
}

/**
 * ⑥ 코드 크기를 모르는 함수(#4792) — 별칭이 있는데 code_bytes 가 0 인 줄(칸을 더하기 전에 올린 함수 · 재기에 실패한 배포)을 AWS 에서 다시 잰다.
 *  0 이면 코드 저장 상한이 그 함수를 없는 것으로 센다(격리 리뷰 «모름 → 0 → 통과»). 틱마다 몇 개씩만. 잰 수.
 */
export async function refreshUnknownCodeBytes(deps: WatchDeps = {}, limit = 20): Promise<number> {
  const env = appServerEnv();
  if (!env) return 0;
  const api = deps.api ?? realLambdaApi(env.region);
  let n = 0;
  for (const r of await st.serverRowsWithoutCodeSize(limit)) {
    let done = false;
    try {
      const bytes = codeBytesOf(await api.listVersions(r.function_name));
      //  아직 0 일 때만 적는다 — 고른 뒤 같은 앱의 배포가 자리를 잡았거나 실측을 적었으면 늦게 온 이 값이 덮지 않게(재검토).
      done = bytes > 0 && await st.fillServerCodeBytes(r.app_id, bytes);
    } catch (e) { logger.warn({ err: e, app: r.app_id }, "함수 코드 크기 다시 재기 실패 — 다음 차례(#4792)"); }
    if (done) n++;
    //  못 잰 줄(함수가 AWS 에서 사라짐 등)은 뒤로 보낸다 — 앞자리에 남으면 틱마다 같은 줄만 보고 다른 줄이 굶는다(재검토).
    else await st.touchServerRow(r.app_id).catch(() => { /* 다음 틱 */ });
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
  out.retire = await retireUnusedServers(policy, deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.code_sizes = await refreshUnknownCodeBytes(deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.pruned = await pruneServerBuilds().catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.orphans = await sweepOrphanServers(deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.usage_pruned = await pruneAppServerUsage(USAGE_KEEP_DAYS).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  return out;
}

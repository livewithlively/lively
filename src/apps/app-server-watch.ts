// 앱 서버 감시 · 정리(#4484 앱 v2-5) — 하우스키핑(매니지드 테넌트 틱 5분 · 자가호스팅은 쓰지 않는다)이 부른다.
//
//  ① 자동 멈춤(상민 2026-10-15): 앱별 5분 호출 수 · 실행 시간 합을 보고 상한(app_server_policy)을 넘으면 그 함수의
//     동시 실행을 0 으로(멈춤) + 책임자 · 관리자 알림. 다시 켜기는 관리자(app_server_resume).
//     #4485(v2-6) — 수는 **게이트웨이가 센 것**(app-server-usage · org_app_server_usage)을 본다. 함수를 부르는 길이 게이트웨이뿐이라(함수 주소 없음 ·
//      설계 §19) 그 수가 전부다. v2-5 는 CloudWatch 지표(GetMetricData — «지표 1,000개당 $0.01», 앱 1,500개 규모 월 약 $45 추정)를 봤다 — 그 조회는 없앴다.
//      실행 시간은 Lambda 가 흘려 받기 끝에 준 REPORT 의 Billed Duration 합이다.
//  ② 죽은 빌드 걷기 — 게이트웨이가 빌드 도중 다시 시작되면 'building' 줄이 남는다(lease 지남 → failed).
//  ③ 옛 빌드 정리 — 앱이 사라졌거나, 별칭이 안 가리키고 30일 지난 빌드의 zip 을 지운다(판 묶음이 남아 있어 다시 빌드할 수 있다).
//     함수의 남은 판이 아직 읽는 zip 은 빼고(#4801 — 함수가 우리 S3 를 바로 읽는다 · 지우면 나중에 그 판이 멈춘다).
//  ④ 고아 함수 — 앱을 지울 때 함수를 못 지워 남긴 줄(org_app_server)을 다시 지운다.
//  ⑤ 서버 선언을 뺀 앱의 함수(#4791 · 결정 상민 2026-10-16) — 설치된 상태 · 지금 판 · 공개 판 모두 web.server 가 없으면 표시(unused_since)를 붙이고,
//     unused_retire_days(기본 7일)가 지나면 함수 · 로그 그룹 · 함수 줄을 걷는다(빌드 기록은 남긴다). 알림은 보내지 않는다(상태에 retire_at).
//     멈춘 함수는 표시도 걷기도 하지 않는다 — 지웠다 새로 만들면 자동 멈춤 · 관리자 멈춤이 풀리는 길이 된다(되살린 함수는 멈춤 기록이 없다).
//  ⑥ 코드 크기를 모르는 함수(#4792) — 별칭이 있는데 code_bytes 가 0 인 줄을 AWS 에서 다시 잰다(틱마다 20개 · 못 잰 줄은 뒤로 보낸다).
//  ⑦ 별칭 판 상태 점검(#4887 · 결정 상민 2026-10-19) — 함수마다 하루 한 번 cur · pub 이 가리키는 함수 판을 본다. 함수는 우리 S3 의 zip 을 그 판 번호로
//     바로 읽어서(#4801 REFERENCE) 그 zip 판이 사라지면 한동안 멀쩡하다가 Lambda 가 코드를 다시 다듬을 때 멈춘다(Inactive · 고정한 판은 못 고친다).
//     그 판이 원본을 잃었거나(저장소에 없음 · 코드 오류) 곧 지워질 옛 zip 판(같은 키를 다시 빌드한 뒤 · 수명 규칙 30일)을 읽으면, 같은 빌드의 지금 zip 으로
//     새 판을 고정해 별칭을 옮긴다(배포와 같은 길). 알림은 판이 실제로 멈췄을 때와 못 고쳤을 때만(책임자 + 관리자). 쉬는 판(오래 안 불려 Inactive ·
//     원본 멀쩡)은 건드리지 않는다 — 첫 호출 한 번이 실패하고 AWS 가 스스로 되살린다(그 재시도는 v2-6 앞단 몫 · #4485 메모).
import { logger } from "../log.js";
import { appServerEnv, serverDeclOf } from "./app-server-config.js";
import { appServerApi, appServerZipStore } from "./app-server-host.js";
import { autoStopReason, codeBytesOf, type AppServerPolicy } from "./app-server-policy.js";
import * as st from "./app-server-store.js";
import { appServerUnavailable, codeErrorOf, deployBuildToAliases, isServerChangedError, isServerLockedError, publicError, withDeps } from "./app-server-deploy.js";
import type { LambdaApi } from "./app-server-host.js";
import { usableBuild } from "./app-server-build.js";
import { removeServer, retireServer, stopServer } from "./app-server-lifecycle.js";
import { AwsError } from "../net/aws/aws-json.js";
import { S3Error } from "../net/aws/s3-lite.js";
import { HttpError } from "../http-error.js";
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
  /** 시험 — 옛 빌드 정리의 zip 지우기(기본 = setServerDepsForTest 의 deleteZip · 운영은 S3). */
  deleteZip?: (key: string) => Promise<void>;
  /**
   * kind — 'stopped'(멈춤) · 'stop-failed'(기준을 넘었는데 멈추지 못함) · #4887 'code-lost'(멈췄던 판을 다시 올림) · 'code-unfixed'(못 고침 — 상태가 바뀔 때만) ·
   *  'check-stuck'(점검을 하루 넘게 못 봄). 같은 앱 · 같은 종류는 1분 안에 한 장(notifyAppInstaller 기본 · dedupe_key app-server-<종류>:<앱>).
   */
  notify?: (appId: string, title: string, body: string, kind: ServerAlertKind) => Promise<void>;
  now?: () => number;
}


type ServerAlertKind = "stopped" | "stop-failed" | "code-lost" | "code-unfixed" | "check-stuck";

async function defaultNotify(appId: string, title: string, body: string, kind: ServerAlertKind): Promise<void> {
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

/**
 * ③ 옛 빌드 정리 — zip 을 지우고 줄을 지운다. 지운 수.
 *  ★ #4801 함수가 우리 S3 의 zip 을 바로 읽으므로(REFERENCE) 그 함수의 남은 판($LATEST · 별칭 밖에 남긴 최근 판)이 아직 읽는 zip 은 지우지 않는다.
 *   지워도 곧바로는 멀쩡하다가(2026-10-16 시험: 영구 삭제 뒤에도 새 실행 환경 · 설정 고치기가 됐다) Lambda 가 코드를 다시 다듬을 때 그 판이 멈춘다
 *   (Inactive — 고정한 판은 고칠 수도 없다). 함수의 판 목록(ListVersionsByFunction)에 그 빌드의 zip 지문(CodeSha256)이 있으면 남긴다(같은 바이트의
 *   다른 빌드도 함께 남는다 — 넉넉한 쪽). 판 목록을 못 읽으면 이번 틱엔 그 함수의 빌드를 지우지 않는다. COPY 함수도 같은 규칙(모드가 섞여도 하나로).
 *  ★ 배포와 한 줄로 — 함수가 남은 앱의 빌드는 그 앱의 배포 잠금을 쥔 채 별칭 · 판 목록을 새로 읽고 지운다(배포 중이면 이번 틱엔 건너뛴다). 안 그러면
 *   고른 뒤 그 빌드로 되돌리는 배포가 판을 고정한 사이에 zip 을 지워 «초록인데 30일 뒤 멈추는» 함수가 생긴다(격리 리뷰). 배포 쪽도 잠금 안에서 zip 을
 *   다시 본다(app-server-deploy deployBuildToAliases).
 *  건너뛴 후보(아직 읽히는 zip)가 앞자리를 차지해 뒤의 후보가 굶지 않게 넘겨 가며 훑는다 — 지운 수 limit · 훑은 수 scanMax 까지.
 *  «아직 읽힘» 은 먼저 이 틱 안의 판 목록 기억으로 잠금 없이 거른다(낡았어도 «남김» 쪽이라 안전) — 오래 쉰 앱의 영구 후보가 틱마다 잠금 · 판 목록을
 *  되풀이하지 않게(규모가 커지면 Lambda 제어면 호출 몫 · 재검토). 지울 후보만 잠금을 쥐고 새로 읽는다.
 */
export async function pruneServerBuilds(deps: WatchDeps = {}, limit = 50, scanMax = 500, pageSize = 50): Promise<number> {
  const store = appServerZipStore();
  //  zip 지우기 — 시험이 끼운 고리(deps · 앱 지우기 removeServer 와 같은 setServerDepsForTest 고리) · 운영은 비어 있어 S3 를 지운다.
  const deleteZip = deps.deleteZip ?? withDeps().deleteZip;
  const env = appServerEnv();
  const api = deps.api ?? (env ? appServerApi(env) : null);
  /** 그 함수의 남은 판들이 읽는 코드 지문 — null = 못 읽었다(지우지 않는다). 함수가 AWS 에 없으면 빈 묶음(읽는 판도 없다). */
  const liveShas = async (fn: string): Promise<Set<string> | null> => {
    if (!api) return null;
    try { return new Set((await api.listVersions(fn)).map((v) => v.CodeSha256).filter((x): x is string => !!x)); }
    catch (e) {
      if (e instanceof AwsError && (e.status === 404 || e.code === "ResourceNotFoundException")) return new Set();
      logger.warn({ err: e, fn }, "함수 판 목록을 못 읽어 그 함수의 옛 빌드는 이번 틱에 지우지 않는다(#4801)");
      return null;
    }
  };
  /** 이 틱 안의 판 목록 기억 — 거르기에만 쓴다(지우기 전엔 잠금 안에서 새로 읽는다). */
  const seenShas = new Map<string, Set<string> | null>();
  const readsNow = async (fn: string, sha: string | null): Promise<boolean> => {
    if (!seenShas.has(fn)) seenShas.set(fn, await liveShas(fn));
    const shas = seenShas.get(fn);
    return shas == null || (!!sha && shas.has(sha));   // 못 읽었으면 «읽는다» 로(남김)
  };
  const drop = async (b: st.PruneCandidate): Promise<void> => {
    if (b.zip_key && deleteZip) await deleteZip(b.zip_key);
    else if (b.zip_key && store) await store.remove(b.zip_key);
    await st.deleteServerBuild(b.app_id, b.build_key);
  };
  /** 후보 하나 — 지웠으면 true. */
  const pruneOne = async (b: st.PruneCandidate): Promise<boolean> => {
    if (!b.zip_key) { await drop(b); return true; }   // 실패한 빌드 — zip 이 없다(줄만)
    if (!b.function_name) {
      //  고를 때 함수 줄이 없던 앱(앱이 사라짐) — 그 사이 같은 id 로 다시 만든 앱의 배포가 줄을 잡았으면 건너뛴다(틈을 S3 지우기 한 번으로 좁힌다 ·
      //   줄 없이 잡히는 잠금이 없어 완전히 닫지는 못한다 — 재검토).
      if (await st.getServerRow(b.app_id)) return false;
      await drop(b);
      return true;
    }
    if (await readsNow(b.function_name, b.zip_sha256)) return false;
    //  배포 · 걷기 · 지우기가 잠금을 쥐고 있으면 다음 틱에. 임대는 removeServer · retireServer 와 같은 5분 — 판 목록 · S3 가 느려(시한 · 다시 하기)
    //   임대가 먼저 끝나면 배포가 그 잠금을 잡은 뒤 이쪽이 풀어 버릴 수 있다(잠금에 주인 표시가 없다 · 재검토).
    if (!(await st.lockServer(b.app_id, 5 * 60))) return false;
    try {
      const row = await st.getServerRow(b.app_id);
      //  고른 뒤 별칭이 이 빌드로 옮겨졌으면(되돌리기 · 공개) 정리 대상이 아니다.
      if (row && (row.cur_build_key === b.build_key || row.pub_build_key === b.build_key)) return false;
      const shas = await liveShas(row?.function_name ?? b.function_name);
      if (!shas || (b.zip_sha256 && shas.has(b.zip_sha256))) return false;
      await drop(b);
      return true;
    } finally {
      await st.unlockServer(b.app_id).catch(() => { /* 잠금은 5분 뒤 저절로 풀린다 */ });
    }
  };
  let n = 0;
  let scanned = 0;
  let after: st.PruneCursor | null = null;
  while (n < limit && scanned < scanMax) {
    const page = await st.serverBuildsToPrune(BUILD_PRUNE_DAYS, Math.min(pageSize, scanMax - scanned), after);
    if (!page.length) break;
    for (const b of page) {
      scanned++;
      after = { started_at: b.started_at, app_id: b.app_id, build_key: b.build_key };
      if (n >= limit) break;
      try { if (await pruneOne(b)) n++; }
      catch (e) { logger.warn({ err: e, app: b.app_id, key: b.build_key }, "옛 앱 서버 빌드 정리 실패(비치명 — 다음 틱)"); }
    }
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
      if (res.errors.length) logger.warn({ app: r.app_id, errors: res.errors }, "서버 선언을 뺀 앱의 함수를 걷었지만 못 치운 것이 있다(#4791 · 로그 그룹 · 토큰)");
      else logger.info({ app: r.app_id }, "서버 선언을 뺀 앱의 함수를 걷었다(#4791)");
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
  const api = deps.api ?? appServerApi(env);
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

/**
 * ⑦ 상태 점검(#4887) — 한 틱에 볼 함수 수 · 다시 올릴 수(코드 올리기 · 판 고정 · 시험 호출이라 느리다) · 주기(상민 2026-10-19 «하루 한 번») ·
 *  시간 예산(틱은 CP 가 기다리는 요청이다 — 넘으면 새 줄을 시작하지 않고 다음 틱에) · 이만큼 이어서 못 보면(한 시간마다 → 하루) 관리자에게 한 번 알린다.
 */
export const HEALTH_CHECK_LIMIT = 20;
export const HEALTH_REPAIR_LIMIT = 3;
export const HEALTH_EVERY_HOURS = 24;
export const HEALTH_BUDGET_MS = 60_000;
export const HEALTH_STUCK_DEFERS = 24;

/** 함수 판 하나를 본 것 — 상태 · 읽는 zip(REFERENCE · COPY 면 null) · 코드 오류 · 그 zip 판이 저장소에 아직 있나(null = 볼 판 번호가 없음 · 볼 수 없음). */
export interface VersionProbe {
  gone: boolean;
  state?: string;
  ref?: { S3Bucket?: string; S3Key?: string; S3ObjectVersion?: string } | null;
  err?: { ErrorCode?: string; Message?: string } | null;
  source?: boolean | null;
}
/** 판정 — move 면 같은 빌드의 지금 zip 으로 새 판을 고정해 옮긴다. broken = 판이 실제로 멈췄다(알림). */
export type HealthVerdict = { kind: "ok" | "idle" } | { kind: "move"; why: string; broken: boolean };

/**
 * 별칭 판 하나의 판정(#4887 사양). 판이 없음 · 코드를 못 읽음(Code.Error) · Failed 면 멈춤. 원본 zip 판이 저장소에 없으면 — 이미 멈췄으면(Inactive · Failed ·
 *  코드 오류) 멈춤, 아직 돌면 조용히 옮긴다(다시 다듬는 때 멈춘다). 빌드의 지금 zip 판과 다른 판을 읽으면(같은 키를 다시 빌드한 뒤 — 옛 판은 수명 규칙으로
 *  30일 뒤 지워진다) 조용히 옮긴다. 원본이 멀쩡한 Inactive 는 쉬는 판(첫 호출에 AWS 가 스스로 되살린다).
 *  지금 zip 판을 읽는데 코드 오류여도 고칠 수 있다 — 배포 길은 망가진 판을 재사용하지 않고, 판을 고정할 때마다 토큰을 새로 구워 늘 새 판이 생긴다(v2-6).
 */
export function healthVerdict(p: VersionProbe, want: { zipKey: string | null; zipVersion: string | null }): HealthVerdict {
  if (p.gone) return { kind: "move", why: "함수 판이 없음", broken: true };
  if (p.source === false) return { kind: "move", why: "읽는 zip 판이 저장소에 없음", broken: p.state === "Inactive" || p.state === "Failed" || !!p.err };
  if (p.err) return { kind: "move", why: `코드를 못 읽음(${p.err.ErrorCode ?? "오류"})`, broken: true };
  if (p.state === "Failed") return { kind: "move", why: "함수 판이 Failed", broken: true };
  if (p.ref && want.zipVersion && (p.ref.S3ObjectVersion !== want.zipVersion || (!!want.zipKey && p.ref.S3Key !== want.zipKey))) return { kind: "move", why: "곧 지워질 옛 zip 판을 읽음", broken: false };
  if (p.state === "Inactive") return { kind: "idle" };
  return { kind: "ok" };
}

const ALIAS_LABEL = { cur: "초안(cur)", pub: "공개(pub)" } as const;
interface HealthMove { alias: "cur" | "pub"; version: string; buildKey: string | null; versionNo: number | null; why: string; broken: boolean }

//  구성원이 보는 상태 · 알림에 싣는 글 — 원문(저장소 키 · 내부 오류)은 싣지 않고 기록(logger)에만 둔다(#4801 규칙 · 격리 리뷰).
/** 미룬 까닭 — 짧게 나눈 것만(AWS · 저장소 · 내부). */
function deferReasonOf(e: unknown): string {
  if (e instanceof AwsError) return `AWS 조회 실패(${e.code || e.status})`;
  if (e instanceof S3Error) return `저장소 조회 실패(${e.code})`;
  return "내부 오류(게이트웨이 기록 참고)";
}
/** 다시 올리기 실패 글 — 배포 길의 글(사람이 배포할 때 보는 것과 같다 · AWS 원문은 publicError 로 걷힌다). */
function repairErrorText(e: unknown): string {
  if (e instanceof HttpError) return e.message;
  if (e instanceof AwsError) return publicError(e);
  return deferReasonOf(e);
}

/**
 * ⑦ 별칭 판 상태 점검 — 하루 안에 안 본 함수(걷을 예정 · 잠긴 줄 제외)를 틱마다 limit 개, 시간 예산 안에서(새 줄을 시작할 때 본다).
 *  옮겨야 할 별칭은 빌드 · 판 번호가 같은 것끼리 한 번에 배포 길(deployBuildToAliases — 잠금 한 번만 · 고를 때 본 판이 아니면 아무것도 안 함)로 옮기고,
 *  옮긴 판을 다시 봐서 여전히 문제면 고쳐졌다고 적지 않는다. 빌드 zip 이 없으면(usableBuild — 그 빌드를 못 쓰게 적는다) 못 고침.
 *  알림: 멈췄던 판을 고쳤을 때(code-lost) · 못 고친 상태로 바뀌었을 때(code-unfixed — 같은 판 · 같은 까닭이면 다시 알리지 않는다) · 하루 넘게 못 봤을 때(check-stuck).
 *  한 틱 다시 올리기 repairMax 번 · AWS · 저장소 일시 오류 · 배포 잠금은 한 시간쯤 뒤 다시(결과에 deferred). 그사이 사람이 별칭을 옮겼으면(raced) 아무것도
 *  안 쓴다 — 사람의 배포가 결과를 비워 두었고 다음 틱에 새 판을 본다.
 */
export async function checkServerHealth(policy: AppServerPolicy, deps: WatchDeps = {}, limit = HEALTH_CHECK_LIMIT, repairMax = HEALTH_REPAIR_LIMIT, budgetMs = HEALTH_BUDGET_MS):
  Promise<{ checked: number; moved: string[]; unfixed: string[]; deferred: number; raced: number; budget_hit: boolean }> {
  const out = { checked: 0, moved: [] as string[], unfixed: [] as string[], deferred: 0, raced: 0, budget_hit: false };
  const env = appServerEnv();
  if (!env) return out;
  const api = deps.api ?? appServerApi(env);
  const sd = withDeps();
  const store = appServerZipStore();
  const clock = deps.now ?? Date.now;
  const started = clock();
  //  그 zip 판이 아직 있나 — 시험 고리(headZip) · 운영은 S3 HEAD ?versionId=(박스 역할 GetObjectVersion · ListBucket 이 있어 지운 판은 404). 저장소를 못 보는 배포면 모름.
  const headVersion = async (key: string, v: string): Promise<boolean | null> => {
    if (sd.headZip) return !!(await sd.headZip(key, v));
    if (!store) return null;
    return !!(await store.head(key, { attempts: 1, timeoutMs: 5_000, versionId: v }));
  };
  const notify = deps.notify ?? defaultNotify;
  const defer = async (row: st.ServerRow, why: string): Promise<void> => {
    out.deferred++;
    const d = await st.deferServerHealth(row.app_id, why, HEALTH_EVERY_HOURS, HEALTH_STUCK_DEFERS).catch(() => null);
    if (d?.tell) {
      await notify(row.app_id, `앱 서버 상태 점검이 하루 넘게 못 돌았습니다 — ${row.app_id}`,
        `한 시간마다 다시 보지만 ${d.n}번 이어서 못 봤습니다(마지막 까닭: ${why}). 운영자 확인이 필요합니다.`, "check-stuck");
    }
  };
  let repairs = 0;
  for (const row of await st.serverRowsForHealth(limit, HEALTH_EVERY_HOURS)) {
    if (clock() - started >= budgetMs) { out.budget_hit = true; break; }   // 남은 줄은 그대로 차례 — 다음 틱
    try {
      const probes = new Map<string, VersionProbe>();
      const probe = async (version: string): Promise<VersionProbe> => {
        if (!probes.has(version)) {
          const g = await api.getFunction(row.function_name, version);
          const ref = g?.Code?.ResolvedS3Object ?? null;
          probes.set(version, g
            ? { gone: false, state: g.Configuration.State, ref, err: codeErrorOf(g.Code), source: ref?.S3Key && ref.S3ObjectVersion ? await headVersion(ref.S3Key, ref.S3ObjectVersion) : null }
            : { gone: true });
        }
        return probes.get(version)!;
      };
      const prev = row.health ?? {};
      const health: st.ServerHealth = { checked_at: new Date(clock()).toISOString() };
      const markUnfixed = (): void => { if (!out.unfixed.includes(row.app_id)) out.unfixed.push(row.app_id); };
      const seen = { cur: row.cur_lambda_version, pub: row.pub_lambda_version };   // 결과를 쓸 때 별칭이 이 판이어야 한다(점검이 옮기면 옮긴 판)
      const moves: HealthMove[] = [];
      for (const alias of ["cur", "pub"] as const) {
        const version = alias === "cur" ? row.cur_lambda_version : row.pub_lambda_version;
        if (!version) continue;
        const buildKey = alias === "cur" ? row.cur_build_key : row.pub_build_key;
        const b = buildKey ? await st.getServerBuild(row.app_id, buildKey) : null;
        const v = healthVerdict(await probe(version), { zipKey: b?.zip_key ?? null, zipVersion: b?.zip_version ?? null });
        const p0 = prev[alias];
        if (v.kind === "move" && p0?.state === "unfixed" && p0.to === version && (p0.why ?? "").includes(v.why)) {
          //  지난 점검이 다시 올려 옮긴 판인데 여전히 **같은 까닭으로** 문제 — 날마다 새 판 · 토큰 · 시험 호출 · 알림이 쌓이지 않게 다시 올리지 않는다(알림은
          //   그때 나갔다 · to 를 남겨 다음 날도 같다 · 사람이 다시 넣으면 setServerAlias 가 결과를 비워 처음부터 본다 · 격리 리뷰). 까닭이 바뀌면(판이 지워짐 ·
          //   원본 분실 · 옛 판이 됨) 다시 고쳐 본다 — 판이 없는 채로 남지 않게(재검토).
          health[alias] = { state: "unfixed", version, to: version, why: `${v.why} — 지난번 다시 올린 판도 같은 문제라 다시 올리지 않는다(운영자 확인 · 서버를 다시 넣으면 처음부터 본다)` };
          markUnfixed();
        } else if (v.kind === "move") moves.push({ alias, version, buildKey, versionNo: alias === "cur" ? row.cur_version_no : row.pub_version_no, why: v.why, broken: v.broken });
        else health[alias] = { state: v.kind, version };
      }
      //  같은 빌드 · 같은 판 번호끼리 한 번에(별칭마다 판 번호를 지킨다 — setServerAlias 가 version_no 를 그대로 적는다). cur 가 먼저다 — pub 이
      //   같은 빌드면 배포 길이 cur 의 (새) 판을 재사용한다.
      const groups = new Map<string, HealthMove[]>();
      for (const m of moves) { const k = `${m.buildKey ?? ""}|${m.versionNo ?? ""}`; groups.set(k, [...(groups.get(k) ?? []), m]); }
      const app = groups.size ? await getApp(row.app_id) : null;
      const title = app ? app.title || app.id : row.app_id;
      //  못 고침 — 같은 판 · 같은 까닭(same — 바뀌는 꼬리(AWS 요청 번호 등) 앞까지)이면 어제 알렸다(하루마다 같은 알림이 쌓이지 않게 · 격리 리뷰).
      //   고아(앱 없음)는 알리지 않는다(④ 고아 쓸기가 걷는다). to — 별칭이 이미 새 판으로 옮겨졌을 때(새 판도 문제).
      const unfixed = async (ms: HealthMove[], text: string, o: { state?: "unfixed" | "failed"; tell?: boolean; same?: string; to?: string } = {}): Promise<void> => {
        const state = o.state ?? "unfixed";
        for (const m of ms) health[m.alias] = { state, version: m.version, ...(o.to ? { to: o.to } : {}), why: text };
        markUnfixed();
        const key = o.same ?? text;
        const already = ms.every((m) => { const p = prev[m.alias]; return !!p && p.state === state && p.version === m.version && (p.why ?? "").startsWith(key); });
        if ((o.tell ?? true) && !already) await notify(row.app_id, `앱 서버 판을 고치지 못했습니다 — ${title}`, `${ms.map((m) => ALIAS_LABEL[m.alias]).join(" · ")} 판이 ${text}.`, "code-unfixed");
      };
      let deferWhy: string | null = null;
      let raced = false;
      let recheckAny = false;
      if (groups.size && !app) {
        await unfixed(moves, `${[...new Set(moves.map((m) => m.why))].join(" · ")} — 앱이 없음(고아 쓸기가 함수를 걷는다)`, { tell: false });
      } else if (groups.size && repairs + groups.size > repairMax) {
        deferWhy = "한 틱 다시 올리기 몫이 찼다";
      } else if (app) {
        for (const ms of groups.values()) {
          const [first] = ms as [HealthMove, ...HealthMove[]];
          const broken = ms.some((m) => m.broken);
          const why = [...new Set(ms.map((m) => m.why))].join(" · ");
          const where = ms.map((m) => ALIAS_LABEL[m.alias]).join(" · ");
          //  멈춘 함수가 AWS 에서 사라졌으면 다시 만들지 않는다 — 새로 만든 함수는 멈춤(동시 실행 0)이 풀린 채다(⑤ 와 같은 까닭 · 격리 리뷰).
          if (row.stopped_at && (await api.getFunction(row.function_name)) == null) {
            await unfixed(ms, `${why} — 멈춘 함수가 AWS 에 없어 다시 만들지 않았다(관리자가 다시 켠 뒤 서버를 다시 넣어야 한다)`);
            continue;
          }
          const b = first.buildKey ? await st.getServerBuild(row.app_id, first.buildKey) : null;
          const usable = b ? await usableBuild(b, sd) : null;
          if (!usable?.zip_key || !usable.zip_sha256) {
            await unfixed(ms, `${why} — 다시 올릴 빌드 zip 이 저장소에 없다(서버를 다시 넣으면 다시 빌드한다 — app_server_deploy · 「이대로 넣기」 · 「공개하기」)`);
            continue;
          }
          repairs++;
          let d: Awaited<ReturnType<typeof deployBuildToAliases>>;
          try {
            d = await deployBuildToAliases({
              app, versionNo: first.versionNo, buildKey: usable.build_key, zipKey: usable.zip_key, zipSha256: usable.zip_sha256, zipBytes: Number(usable.zip_bytes ?? 0),
              zipVersion: usable.zip_version ?? null, aliases: ms.map((m) => m.alias), policy, lockTries: 1,
              expect: Object.fromEntries(ms.map((m) => [m.alias, m.version])),
            }, deps.api ? { api: deps.api } : {});
          } catch (e) {
            if (isServerLockedError(e)) { deferWhy = "배포 잠금(다른 배포 중)"; break; }
            if (isServerChangedError(e)) { raced = true; break; }
            logger.warn({ err: e, app: row.app_id }, "앱 서버 판 다시 올리기 실패(#4887)");
            const same = `${why} — 다시 올리다 실패했다`;
            await unfixed(ms, `${same}(${repairErrorText(e)}) — 서버를 다시 넣어 주세요(app_server_deploy · 「이대로 넣기」)`, { state: "failed", same });
            continue;
          }
          for (const m of ms) seen[m.alias] = d.lambda_version;
          //  옮긴 판을 한 번 더 본다 — 새 판도 코드를 못 읽으면 고쳐졌다고 적지 않는다. 같은 판이 돌아오면(재사용 길) 새 판이 안 생긴 것이다.
          //   재확인이 일시 오류면 옮긴 것은 그대로 적고 한 시간쯤 뒤 다시 본다(성공한 배포를 실패로 적지 않게 · 격리 리뷰).
          let after: HealthVerdict | null = null;
          let recheck = false;
          try { after = healthVerdict(await probe(d.lambda_version), { zipKey: usable.zip_key, zipVersion: usable.zip_version ?? null }); }
          catch (e) { logger.warn({ err: e, app: row.app_id }, "옮긴 앱 서버 판 재확인 실패 — 한 시간쯤 뒤 다시(#4887)"); recheck = true; recheckAny = true; }
          if (after?.kind === "move") {
            await unfixed(ms, `${why} — 다시 올렸지만 ${d.lambda_version === first.version ? "새 판이 생기지 않았다" : `새 판도 ${after.why}`}`, { to: d.lambda_version });
            continue;
          }
          for (const m of ms) health[m.alias] = { state: broken ? "repaired" : "moved", version: m.version, to: d.lambda_version, why: recheck ? `${why}(옮긴 판 재확인 못 함 — 곧 다시 본다)` : why };
          if (!out.moved.includes(row.app_id)) out.moved.push(row.app_id);
          if (broken) {
            await notify(row.app_id, `멈췄던 앱 서버 판을 다시 올렸습니다 — ${title}`,
              `${where} 판이 ${why}(멈춤). 같은 빌드의 zip 으로 새 판(${d.lambda_version})을 올려 옮겼습니다${row.stopped_at ? " — 멈춘 함수라 다시 켜기 전까지는 돌지 않습니다" : " — 앱 주소는 다시 돕니다"}.`, "code-lost");
          }
        }
      }
      if (raced) { out.raced++; continue; }
      if (deferWhy) { await defer(row, deferWhy); continue; }
      if (await st.setServerHealth(row.app_id, health, seen, HEALTH_EVERY_HOURS, recheckAny ? 1 : undefined)) out.checked++;
      else out.raced++;   // 그사이 사람이 별칭을 옮겼다 — 그 배포가 결과를 비웠고 다음 틱에 새 판을 본다
    } catch (e) {
      logger.warn({ err: e, app: row.app_id }, "앱 서버 함수 상태 점검 실패 — 한 시간쯤 뒤 다시(#4887)");
      await defer(row, `일시 오류 — ${deferReasonOf(e)}`).catch(() => { /* 다음 틱 */ });
    }
  }
  return out;
}

/** 하우스키핑 한 번 — 매니지드 테넌트 틱(web.ts step "app-servers")이 부른다. 앱 서버가 꺼진 배포면 아무것도 안 한다. */
export async function runAppServerHousekeeping(deps: WatchDeps = {}): Promise<Record<string, unknown>> {
  //  #4487 꺼진 까닭을 함께 — 실행면 이름(LIVELY_APP_SERVER_HOST)을 틀리면 감시 · 상태 점검까지 조용히 멈추므로 틱 결과에서 보이게(격리 리뷰).
  if (!appServerEnv()) { const why = appServerUnavailable(); return { skipped: "disabled", ...(why ? { why } : {}) }; }
  const out: Record<string, unknown> = {};
  out.stale_builds = await st.failStaleServerBuilds().catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  const policy = await st.appServerPolicy();
  out.watch = await watchAppServers(policy, deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.retire = await retireUnusedServers(policy, deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.code_sizes = await refreshUnknownCodeBytes(deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.pruned = await pruneServerBuilds(deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.orphans = await sweepOrphanServers(deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  out.usage_pruned = await pruneAppServerUsage(USAGE_KEEP_DAYS).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  //  #4487 자가호스팅 — 주인 없는 컨테이너 · 남은 빌드 컨테이너 · 지난 env 파일(재우기는 1분 타이머가 따로 — boot/housekeeping).
  if (appServerEnv()?.host === "local") {
    out.local = await (await import("./app-server-local.js")).localHousekeeping(policy.build_timeout_s).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  }
  //  ⑦ 은 맨 끝 — 다시 올리기가 느릴 수 있어 앞 단계(자동 멈춤 · 정리)를 밀지 않게(시간 예산 안에서만 돈다).
  out.health = await checkServerHealth(policy, deps).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
  return out;
}

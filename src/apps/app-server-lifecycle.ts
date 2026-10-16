// 앱 서버 멈춤 · 다시 켜기 · 지우기 · 상태(#4484 앱 v2-5) — 배포(app-server-deploy.ts)가 만든 함수를 다루는 쪽.
//  멈춤: 동시 실행 0(PutFunctionConcurrency) — 그 함수의 모든 판 · 별칭이 멈춘다(2026-10-15 실측 TooManyRequestsException).
//  파괴적인 길(멈추기 · 지우기)은 먼저 함수 주인(태그 lvly:tenant)을 본다 — 이름이 겹쳐도 남의 워크스페이스 함수에 닿지 않게(격리 리뷰).
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import { appBundleS3Config } from "./app-blob-store.js";
import { appServerEnv, logGroupFor, serverDeclOf } from "./app-server-config.js";
import { mbOf } from "./app-server-policy.js";
import { buildKeyFor, liveBuildProgress } from "./app-server-build.js";
import * as st from "./app-server-store.js";
import { revokeStaleFunctionTokens } from "./app-server-auth.js";
import {
  appServerUnavailable, foreignMsg, functionOwnership, installedTarget, publicError, realLambdaApi, sleepDefault, withDeps, type ServerDeps,
} from "./app-server-deploy.js";
import { AwsError } from "../net/aws/aws-json.js";
import { s3Delete } from "../net/aws/s3-lite.js";
import type { OrgApp } from "../org/store/apps.js";

/**
 * 멈춤 — 동시 실행 0. 이미 멈춘 함수면 아무것도 바꾸지 않는다(changed:false — 자동 멈춤 · 남의 멈춤 기록을 덮지 않는다).
 *  kind 'auto' 는 감시만 쓴다(관리자만 다시 켠다). 남의 워크스페이스 함수(태그)면 409 · 함수가 없으면 404.
 */
export async function stopServer(appId: string, by: string, kind: "auto" | "manual", reason: string, deps0: ServerDeps = {}): Promise<{ row: st.ServerRow; changed: boolean }> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const row = await st.getServerRow(appId);
  if (!row) throw new HttpError(404, `이 앱은 서버 함수가 없습니다: ${appId}`);
  if (row.stopped_at) return { row, changed: false };
  const api = deps.api ?? realLambdaApi(env.region);
  try {
    const own = await functionOwnership(api, row.function_name);
    if (own === "foreign") throw new HttpError(409, foreignMsg(row.function_name));
    if (own === "missing") throw new HttpError(404, `이 앱의 서버 함수가 AWS 에 없습니다: ${row.function_name}`);
    await api.putConcurrency(row.function_name, 0);
  } catch (e) {
    if (e instanceof AwsError) { logger.warn({ err: e, appId }, "앱 서버 멈추기 AWS 오류(#4484)"); throw new HttpError(502, publicError(e)); }
    throw e;
  }
  const changed = await st.setServerStopped(appId, { by, kind, reason });
  return { row: (await st.getServerRow(appId))!, changed };
}
export async function resumeServer(appId: string, deps0: ServerDeps = {}): Promise<st.ServerRow> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const row = await st.getServerRow(appId);
  if (!row) throw new HttpError(404, `이 앱은 서버 함수가 없습니다: ${appId}`);
  const api = deps.api ?? realLambdaApi(env.region);
  try {
    const own = await functionOwnership(api, row.function_name);
    if (own === "foreign") throw new HttpError(409, foreignMsg(row.function_name));
    if (own === "own") await api.deleteConcurrency(row.function_name);
    //  함수가 없으면 풀 것도 없다 — 기록만 푼다(다음 배포가 새로 만든다).
  } catch (e) {
    if (e instanceof AwsError) { logger.warn({ err: e, appId }, "앱 서버 다시 켜기 AWS 오류(#4484)"); throw new HttpError(502, publicError(e)); }
    throw e;
  }
  await st.setServerStopped(appId, null);
  return (await st.getServerRow(appId))!;
}

/**
 * 앱을 지울 때 — 함수 · 로그 그룹 · zip · 기록을 걷는다(되돌릴 수 없다 · 판 묶음이 남으니 다시 빌드할 수는 있다). best-effort: 실패는 돌려준다.
 *  함수를 못 지우면(AWS 오류 · 배포가 잠금을 쥐고 있음) 함수 줄(org_app_server)을 남긴다 — 앱이 없는 줄을 하우스키핑이 다시 지운다(고아 함수가
 *  단서 없이 남지 않게 · 격리 리뷰). 남의 워크스페이스 함수(태그)는 건드리지 않고 우리 줄만 지운다.
 */
export async function removeServer(appId: string, deps0: ServerDeps = {}): Promise<{ removed: boolean; errors: string[]; pending: boolean }> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  const row = await st.getServerRow(appId).catch(() => null);
  const errors: string[] = [];
  let pending = false;
  if (row && !env) pending = true;   // 이 배포가 앱 서버를 끈 채다 — 켜진 배포의 하우스키핑이 지우게 줄을 남긴다
  if (env && row) {
    const api = deps.api ?? realLambdaApi(env.region);
    const sleep = deps.sleep ?? sleepDefault;
    //  배포가 도는 중이면 지운 뒤 그 배포가 함수를 다시 만들 수 있다 — 잠금을 잡고 지운다(못 잡으면 하우스키핑에 미룬다).
    let locked = false;
    for (let n = 0; n < 10 && !locked; n++) { locked = await st.lockServer(appId, 5 * 60); if (!locked) await sleep(deps.pollMs ?? 2000); }
    if (!locked) { pending = true; errors.push("함수: 배포가 진행 중이라 지우기를 미룹니다(하우스키핑이 다시 지운다)"); }
    else {
      try {
        const own = await functionOwnership(api, row.function_name);
        if (own === "foreign") errors.push(`함수: ${foreignMsg(row.function_name)} — 지우지 않았습니다`);
        else if (own === "own") {
          await api.deleteFunction(row.function_name);
          await api.deleteLogGroup(logGroupFor(row.function_name)).catch((e) => errors.push(`로그: ${publicError(e)}`));
        }
      } catch (e) {
        pending = true;
        logger.warn({ err: e, appId, fn: row.function_name }, "앱 서버 함수 지우기 실패 — 하우스키핑이 다시 지운다(#4484)");
        errors.push(`함수: ${publicError(e)}`);
      } finally {
        if (pending) await st.unlockServer(appId).catch(() => { /* 저절로 풀린다 */ });
      }
    }
  }
  const s3 = appBundleS3Config();
  const { zipKeys } = await st.deleteServerBuildRows(appId).catch((e) => { errors.push(`기록: ${publicError(e)}`); return { zipKeys: [] as string[] }; });
  if (row && !pending) await st.deleteServerRow(appId).catch((e) => errors.push(`기록: ${publicError(e)}`));
  //  #4485 — 이 앱의 함수 토큰을 모두 회수한다 — 함수 줄이 없어도(앞서 걷기가 회수를 못 했을 수 있다 · 합치기 격리 리뷰). 같은 id 로 앱을 다시 만들어도
  //   옛 토큰이 살아나지 않게. 줄을 남기는 때(pending — 함수를 아직 못 지움)는 하우스키핑이 다시 지우며 거둔다.
  if (!pending) await (deps.revokeFunctionTokens ?? revokeStaleFunctionTokens)(appId, []).catch((e) => errors.push(`토큰: ${publicError(e)}`));
  for (const k of zipKeys) {
    if (deps.deleteZip) await deps.deleteZip(k).catch((e) => errors.push(`zip: ${publicError(e)}`));
    else if (s3) await s3Delete(s3, k, { attempts: 1, timeoutMs: 10_000 }).catch((e) => errors.push(`zip: ${publicError(e)}`));
  }
  return { removed: !!row && !pending, errors, pending };
}

/** 걷은 함수가 쓰던 빌드를 정리에서 빼 두는 날수(#4791) — 그동안 서버 판으로 되돌리면 빌드 없이 함수를 다시 만든다. */
export const BUILD_KEEP_AFTER_RETIRE_DAYS = 30;

/**
 * 서버 선언을 뺀 앱의 함수를 걷는다(#4791) — 함수 · 로그 그룹 · 함수 줄. 빌드 기록 · zip 은 남긴다: 서버 판으로 되돌리면 그 빌드로 함수를 다시
 *  만든다(빌드 없이). 별칭이 가리키던 빌드는 걷은 때부터 30일 정리 유예(keep_until)를 받는다. 잠금은 한 번만 잡아 본다(배포 중이면 다음 틱에 다시).
 *  잠근 뒤 recheck 로 «아직도 쓰지 않나» 를 다시 본다 — 고를 때 읽은 매니페스트가 낡았을 수 있다(그 사이 서버 판을 저장 · 배포하면 지우지 않는다).
 */
export async function retireServer(appId: string, recheck: () => Promise<boolean>, deps0: ServerDeps = {}): Promise<{ retired: boolean; skipped?: string; errors: string[] }> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) return { retired: false, skipped: "disabled", errors: [] };
  const row = await st.getServerRow(appId);
  if (!row) return { retired: false, skipped: "no-row", errors: [] };
  if (!(await st.lockServer(appId, 5 * 60))) return { retired: false, skipped: "locked", errors: [] };
  let gone = false;
  const errors: string[] = [];
  try {
    if (!(await recheck())) return { retired: false, skipped: "in-use", errors };
    const api = deps.api ?? realLambdaApi(env.region);
    const own = await functionOwnership(api, row.function_name);
    if (own === "foreign") errors.push(`함수: ${foreignMsg(row.function_name)} — 지우지 않았습니다`);
    else if (own === "own") {
      await api.deleteFunction(row.function_name);
      await api.deleteLogGroup(logGroupFor(row.function_name)).catch((e) => errors.push(`로그: ${publicError(e)}`));
    }
    //  이 함수가 쓰던 빌드(별칭이 가리키던 빌드)에 정리 유예를 준다 — 줄을 지우면 별칭 참조가 사라져, 빌드한 지 30일이 지난 빌드는 같은 틱의
    //   정리가 곧바로 지운다(격리 리뷰). 유예 동안은 서버 판으로 되돌리면 빌드 없이 함수를 다시 만든다.
    //  #4485 — 걷는 함수 판에 구운 앱 서버 토큰을 줄을 지우기 «전»에 회수한다. 잠금을 쥔 채라 기다리던 배포가 줄을 다시 잡아 새 토큰을 굽는 것과
    //   겹치지 않고(그 새 토큰까지 거두면 새 함수 판이 죽은 토큰을 구운 채 남는다), 줄이 사라진 뒤 게이트웨이가 멈춰도 거둘 것이 남지 않는다(합치기 격리 리뷰).
    //   못 거두면 errors 에 담고 걷기는 이어 간다 — 남은 토큰은 다음 배포 · 앱 지우기(removeServer)가 거둔다.
    await (deps.revokeFunctionTokens ?? revokeStaleFunctionTokens)(appId, []).catch((e) => errors.push(`토큰: ${publicError(e)}`));
    await st.keepServerBuilds(appId, [row.cur_build_key, row.pub_build_key], BUILD_KEEP_AFTER_RETIRE_DAYS);
    await st.deleteServerRow(appId);
    gone = true;
    return { retired: true, errors };
  } catch (e) {
    logger.warn({ err: e, appId, fn: row.function_name }, "서버 선언을 뺀 앱의 함수 걷기 실패 — 다음 틱에 다시(#4791)");
    errors.push(`함수: ${publicError(e)}`);
    return { retired: false, skipped: "error", errors };
  } finally {
    if (!gone) await st.unlockServer(appId).catch(() => { /* 저절로 풀린다 */ });
  }
}

// ── 상태 ──

export async function serverStatus(app: OrgApp, deps0: ServerDeps = {}): Promise<Record<string, unknown>> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  const decl = serverDeclOf(app.manifest);
  const row = await st.getServerRow(app.id);
  const builds = await st.listServerBuilds(app.id, 5);
  const retireDays = row?.unused_since ? (await st.appServerPolicy()).unused_retire_days : null;
  let installed: Record<string, unknown> | null = null;
  if (env && decl) {
    try {
      const t = await installedTarget(app);
      if (t?.bundle) {
        const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
        const b = builds.find((x) => x.build_key === key) ?? await st.getServerBuild(app.id, key);
        const progress = b?.status === "building" ? liveBuildProgress(app.id, key) : null;
        installed = {
          version_no: t.versionNo, build_key: key, saved_by: t.savedBy,
          build: b ? { status: b.status, stage: b.stage, error: b.error, started_at: b.started_at, finished_at: b.finished_at, ...(progress ? { now: progress.last, running_s: Math.round((Date.now() - progress.startedAt) / 1000) } : {}) } : null,
          //  «올라가 있음» 은 그 빌드를 아직 쓸 수 있을 때만 — 빌드가 무효(zip 유실)면 공개 확인(publishServerDenial)이 막으니 화면도 다시 빌드하게 한다.
          deployed_to_cur: row?.cur_build_key === key && b?.status === "ok", deployed_to_pub: row?.pub_build_key === key && b?.status === "ok",
        };
      }
    } catch (e) { installed = { error: (e as Error)?.message ?? String(e) }; }
  }
  return {
    app_id: app.id, server_declared: !!decl, ...(decl ? { decl } : {}),
    available: env ? null : appServerUnavailable(),
    installed,
    function: row ? {
      name: row.function_name,
      cur: row.cur_lambda_version ? { version_no: row.cur_version_no, lambda_version: row.cur_lambda_version, build_key: row.cur_build_key, at: row.cur_at } : null,
      pub: row.pub_lambda_version ? { version_no: row.pub_version_no, lambda_version: row.pub_lambda_version, build_key: row.pub_build_key, at: row.pub_at } : null,
      stopped: row.stopped_at ? { at: row.stopped_at, by: row.stopped_by, kind: row.stop_kind, reason: row.stop_reason } : null,
      last_error: row.last_error,
      code_mb: mbOf(row.code_bytes),   // #4792 이 함수의 코드 저장(판마다의 zip 합 · 워크스페이스 상한 workspace_code_mb 에 든다)
      //  #4791 지금 판 · 공개 판 둘 다 서버 선언이 없다 — retire_at 에 함수를 걷는다(서버 판을 다시 올리면 표시가 걷힌다 · 멈춘 함수는 걷지 않는다).
      retire: row.unused_since && retireDays != null
        ? { unused_since: row.unused_since, retire_at: new Date(new Date(row.unused_since).getTime() + retireDays * 86_400_000).toISOString(), stopped_kept: !!row.stopped_at }
        : null,
    } : null,
    builds: builds.map((b) => ({
      build_key: b.build_key, version_no: b.version_no, status: b.status, stage: b.stage, error: b.error, built_by: b.built_by,
      started_at: b.started_at, finished_at: b.finished_at, zip_mb: b.zip_bytes ? Math.round((b.zip_bytes / 1048576) * 10) / 10 : null,
      unzipped_mb: b.unzipped_bytes ? Math.round((b.unzipped_bytes / 1048576) * 10) / 10 : null, detail: b.detail,
    })),
  };
}

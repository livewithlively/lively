// 앱 서버 배포(#4484 앱 v2-5) — 빌드한 zip 을 앱 × 워크스페이스의 Lambda 함수에 올리고, 판을 고정하고, 시험 호출이 통과하면 별칭을 옮긴다.
//
//  별칭 둘: cur = 고친 사람이 보는 판(앱 주소의 초안 쪽 · 나만 보는 앱은 이것뿐) · pub = 공개 판(공개 앱에 남의 초안이 걸렸을 때 나머지가 보는 판).
//   v2-6 라우팅이 apps/visibility.ts addressViewFor 로 판(installed · published)을 고르고 별칭(cur · pub)으로 부른다.
//  언제 무엇을(결정 상민 2026-10-15):
//   · 「이대로 넣기」·「공개하기」·app_server_deploy — 지금 판(설치된 판)을 빌드(같은 지문이 있으면 그대로)해 cur 에 올린다. 그 판이 곧 모두가 보는 판이면
//     (공개 앱에 초안이 없으면) pub 도 같은 함수 판으로.
//   · 공개(publishCurrent) — 공개할 판의 빌드가 **이미 있어야** 한다(없으면 409 «먼저 넣기·app_server_deploy») · 공개된 뒤 pub(과 cur)을 그 빌드로.
//   · 되돌리기 — 그 판의 빌드가 있으면 cur 를 그것으로(빌드 없음 · 설계 «판 되돌리기는 그 판의 zip 을 다시 쓴다»).
//  ★ 빌드는 그 판을 **저장한 사람**의 세션에서만(상민 2026-10-15) — 남이 저장한 판은 이미 빌드돼 있을 때만 올린다.
//  멈춤: 동시 실행 0(PutFunctionConcurrency) — 그 함수의 모든 판 · 별칭이 멈춘다(2026-10-15 실측 TooManyRequestsException).
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import { tenantSlug } from "../terminal/catalog.js";
import { appBundleS3Config, blobTenant } from "./app-blob-store.js";
import {
  LAMBDA_HANDLER, appServerEnv, functionNameFor, lambdaEnvFor, logGroupFor, serverDeclOf, smokeEvent, smokeFailure, tailText,
  type AppServerDecl, type AppServerEnv,
} from "./app-server-config.js";
import type { AppServerPolicy } from "./app-server-policy.js";
import { buildKeyFor, ensureServerBuild, liveBuildProgress, type BuildDeps, type BuildSeat } from "./app-server-build.js";
import * as st from "./app-server-store.js";
import { versionBundle } from "./app-version-files.js";
import * as lam from "../net/aws/lambda-lite.js";
import { AwsError } from "../net/aws/aws-json.js";
import { s3Delete } from "../net/aws/s3-lite.js";
import type { OrgApp } from "../org/store/apps.js";
import { getAppVersionBundle } from "../org/store/apps.js";

/** 시험이 갈아 끼우는 AWS 면(기본 = lambda-lite 를 그 지역으로). */
export interface LambdaApi {
  getFunction(name: string): Promise<lam.FnGet | null>;
  getFunctionConfiguration(name: string, qualifier?: string): Promise<lam.FnConfiguration | null>;
  createFunction(input: lam.CreateFunctionInput): Promise<lam.FnConfiguration>;
  updateFunctionCode(name: string, code: { S3Bucket: string; S3Key: string }): Promise<lam.FnConfiguration>;
  updateFunctionConfiguration(name: string, input: lam.UpdateConfigInput): Promise<lam.FnConfiguration>;
  publishVersion(name: string, input: { CodeSha256?: string; Description?: string }): Promise<lam.FnConfiguration>;
  listVersions(name: string): Promise<lam.FnConfiguration[]>;
  putAlias(name: string, alias: string, version: string, description: string): Promise<lam.FnAlias>;
  invoke(name: string, qualifier: string, payload: unknown, timeoutMs: number): Promise<lam.InvokeOut>;
  deleteFunction(name: string, qualifier?: string): Promise<void>;
  putConcurrency(name: string, n: number): Promise<void>;
  deleteConcurrency(name: string): Promise<void>;
  ensureLogGroup(group: string, retentionDays: number): Promise<void>;
  deleteLogGroup(group: string): Promise<void>;
}

export function realLambdaApi(region: string): LambdaApi {
  const c = { region };
  return {
    getFunction: (n) => lam.getFunction(c, n),
    getFunctionConfiguration: (n, q) => lam.getFunctionConfiguration(c, n, q),
    createFunction: (i) => lam.createFunction(c, i),
    updateFunctionCode: (n, code) => lam.updateFunctionCode(c, n, code),
    updateFunctionConfiguration: (n, i) => lam.updateFunctionConfiguration(c, n, i),
    publishVersion: (n, i) => lam.publishVersion(c, n, i),
    listVersions: (n) => lam.listVersions(c, n),
    putAlias: (n, a, v, d) => lam.putAlias(c, n, a, v, d),
    invoke: (n, q, p, t) => lam.invoke(c, n, q, p, { timeoutMs: t }),
    deleteFunction: (n, q) => lam.deleteFunction(c, n, q),
    putConcurrency: (n, k) => lam.putConcurrency(c, n, k),
    deleteConcurrency: (n) => lam.deleteConcurrency(c, n),
    ensureLogGroup: (g, d) => lam.ensureLogGroup(c, g, d),
    deleteLogGroup: (g) => lam.deleteLogGroup(c, g),
  };
}

export interface ServerDeps extends BuildDeps {
  api?: LambdaApi;
  env?: AppServerEnv;
  /** 시험 — 기다리기(함수 준비 · 잠금)를 빨리. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 시험 — zip 버킷 이름. 기본 = LIVELY_APP_BUNDLE_BUCKET. */
  bucket?: string;
  /** 시험 — zip 지우기(앱 지우기). 기본 = S3. */
  deleteZip?: (key: string) => Promise<void>;
}

/** 시험이 끼우는 기본 의존(가짜 Lambda · zip 저장소 · 세션 실행) — 운영에서는 비어 있다. */
let testDeps: ServerDeps = {};
export function setServerDepsForTest(d: ServerDeps): void { testDeps = d; }
const withDeps = (d: ServerDeps = {}): ServerDeps => ({ ...testDeps, ...d });

/** 이 배포가 앱 서버를 돌리나 — 아니면 까닭(사람에게 그대로). */
export function appServerUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!appServerEnv(env)) return "이 워크스페이스는 앱 서버 실행이 아직 켜져 있지 않습니다(자가호스팅 박스는 v2-8 에서) — 화면(web.root)은 그대로 됩니다";
  if (!appBundleS3Config(env) && !testDeps.bucket) return "판 묶음 버킷(LIVELY_APP_BUNDLE_BUCKET)이 없어 앱 서버를 올릴 수 없습니다";
  return null;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lockedMsg = "이 앱의 서버를 다른 요청이 지금 올리고 있습니다 — 잠시 뒤 다시 하세요";

/** 함수가 준비될 때까지(만들기 · 코드/설정 고치기 뒤 Pending · InProgress) — 큰 zip(파일 수만 개)은 몇 분 걸린다(2026-10-15 실측). */
async function waitReady(api: LambdaApi, fn: string, deps: ServerDeps, maxMs = 6 * 60_000): Promise<lam.FnConfiguration> {
  const until = Date.now() + maxMs;
  const sleep = deps.sleep ?? sleepDefault;
  for (;;) {
    const c = await api.getFunctionConfiguration(fn);
    if (!c) throw new HttpError(500, `함수가 사라졌습니다: ${fn}`);
    if (c.State === "Failed") throw new HttpError(502, `함수를 만들지 못했습니다: ${c.StateReason ?? c.StateReasonCode ?? "까닭 모름"}`);
    if (c.LastUpdateStatus === "Failed") throw new HttpError(502, `함수를 고치지 못했습니다: ${c.LastUpdateStatusReason ?? "까닭 모름"}`);
    if (c.State === "Active" && c.LastUpdateStatus !== "InProgress") return c;
    if (Date.now() > until) throw new HttpError(504, `함수가 준비되지 않았습니다(${c.State}/${c.LastUpdateStatus}) — 잠시 뒤 다시 하세요`);
    await sleep(deps.pollMs ?? 2000);
  }
}

/** 함수 설정이 바라는 값과 다른가(고칠 칸만 돌려준다 — 빈 객체면 그대로). */
function configDrift(c: lam.FnConfiguration, want: { role: string; handler: string; runtime: string; memory: number; timeout: number; layer: string; vars: Record<string, string> }): lam.UpdateConfigInput {
  const out: lam.UpdateConfigInput = {};
  if (c.Role !== want.role) out.Role = want.role;
  if (c.Handler !== want.handler) out.Handler = want.handler;
  if (c.Runtime !== want.runtime) out.Runtime = want.runtime;
  if (c.MemorySize !== want.memory) out.MemorySize = want.memory;
  if (c.Timeout !== want.timeout) out.Timeout = want.timeout;
  const layers = (c.Layers ?? []).map((l) => l.Arn);
  if (layers.length !== 1 || layers[0] !== want.layer) out.Layers = [want.layer];
  const vars = c.Environment?.Variables ?? {};
  const same = Object.keys(want.vars).length === Object.keys(vars).length && Object.entries(want.vars).every(([k, v]) => vars[k] === v);
  if (!same) out.Environment = { Variables: want.vars };
  return out;
}

export interface DeployResult {
  function_name: string;
  aliases: Array<"cur" | "pub">;
  lambda_version: string;
  build_key: string;
  /** 시험 호출 — 앱의 GET / 응답 상태(앱이 «/» 를 안 받으면 404 여도 서버는 떠 있다). 멈춘 앱이면 건너뛴다. */
  smoke: { skipped?: string; http_status?: number; ms?: number } | null;
}

export class DeployError extends HttpError {
  constructor(status: number, message: string, readonly stage: string, readonly log: string | null = null) {
    super(status, message, { body: { stage, ...(log ? { log } : {}) } });
  }
}

/**
 * 빌드 하나를 별칭(들)에 올린다 — 함수 보장(만들기 · 코드 · 설정) → 판 고정 → 시험 호출 → 별칭 옮기기 → 기록 → 옛 판 정리.
 *  cur 가 이미 같은 빌드의 함수 판을 가리키면(공개하기 · 되돌리기 직후) 코드를 다시 올리지 않고 그 판을 그대로 쓴다.
 */
export async function deployBuildToAliases(i: {
  app: Pick<OrgApp, "id" | "title">; versionNo: number | null; buildKey: string; zipKey: string; zipSha256: string;
  aliases: Array<"cur" | "pub">; policy: AppServerPolicy;
}, deps0: ServerDeps = {}): Promise<DeployResult> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const api = deps.api ?? realLambdaApi(env.region);
  const bucket = deps.bucket ?? appBundleS3Config()?.bucket;
  if (!bucket) throw new HttpError(503, "판 묶음 버킷이 없습니다");
  const slug = tenantSlug() ?? "local";
  const fnNew = functionNameFor(env.prefix, i.app.id, slug);
  const row0 = await st.getServerRow(i.app.id);
  const fn = row0?.function_name ?? fnNew;
  if (!fn) throw new HttpError(400, `앱 id 와 워크스페이스 이름이 길어 함수 이름(64자)을 만들 수 없습니다: ${i.app.id}`);
  await st.ensureServerRow(i.app.id, fn);
  const sleep = deps.sleep ?? sleepDefault;
  let locked = false;
  for (let n = 0; n < 30 && !locked; n++) { locked = await st.lockServer(i.app.id, 15 * 60); if (!locked) await sleep(deps.pollMs ?? 2000); }
  if (!locked) throw new HttpError(409, lockedMsg);
  try {
    const row = await st.getServerRow(i.app.id);
    const reuse = row && row.cur_build_key === i.buildKey && row.cur_lambda_version ? row.cur_lambda_version : null;
    let version: string;
    let smoke: DeployResult["smoke"] = null;
    if (reuse) {
      version = reuse;
    } else {
      const want = {
        role: env.execRoleArn, handler: LAMBDA_HANDLER, runtime: env.runtime, memory: i.policy.memory_mb, timeout: i.policy.timeout_s,
        layer: env.layerArn, vars: lambdaEnvFor(i.app.id),
      };
      await api.ensureLogGroup(logGroupFor(fn), i.policy.log_retention_days);
      let got = await api.getFunction(fn);
      if (!got) {
        //  실행 역할을 막 만든 직후(인프라 적용 직후)엔 Lambda 가 그 역할을 아직 못 맡는다는 오류가 잠깐 난다 — 몇 번 다시 한다.
        for (let n = 0; ; n++) {
          try {
            await api.createFunction({
              FunctionName: fn, Runtime: env.runtime, Role: env.execRoleArn, Handler: LAMBDA_HANDLER,
              Code: { S3Bucket: bucket, S3Key: i.zipKey }, Architectures: [env.arch], MemorySize: want.memory, Timeout: want.timeout,
              Layers: [env.layerArn], Environment: { Variables: want.vars },
              Description: `lively app ${i.app.id} (${slug})`.slice(0, 256),
              Tags: { "lvly:tenant": blobTenant(), "lvly:app": i.app.id, "lvly:workspace": slug }, Publish: false,
            });
            break;
          } catch (e) {
            if (e instanceof AwsError && (e.status === 409 || e.code === "ResourceConflictException")) break;   // 그 사이 만들어졌다 — 아래에서 확인
            if (e instanceof AwsError && /cannot be assumed|role defined for the function/i.test(e.message) && n < 5) { await sleep(3000); continue; }
            throw e;
          }
        }
        await waitReady(api, fn, deps);
        got = await api.getFunction(fn);
        if (!got) throw new HttpError(500, `함수를 만든 뒤 찾지 못했습니다: ${fn}`);
      }
      const owner = got.Tags?.["lvly:tenant"];
      if (owner !== blobTenant()) throw new HttpError(409, `함수 이름 ${fn} 을 다른 워크스페이스가 쓰고 있습니다 — 운영자에게 알려 주세요`);
      if (got.Configuration.CodeSha256 !== i.zipSha256) {
        await waitReady(api, fn, deps);
        await api.updateFunctionCode(fn, { S3Bucket: bucket, S3Key: i.zipKey });
      }
      const cfg = await waitReady(api, fn, deps);
      if (cfg.CodeSha256 !== i.zipSha256) throw new HttpError(409, "함수 코드가 빌드한 zip 과 다릅니다(그 사이 다른 배포가 코드를 바꿨습니다) — 다시 하세요");
      const drift = configDrift(cfg, want);
      if (Object.keys(drift).length) { await api.updateFunctionConfiguration(fn, drift); await waitReady(api, fn, deps); }
      const pub = await api.publishVersion(fn, { CodeSha256: i.zipSha256, Description: `v${i.versionNo ?? "?"} build ${i.buildKey.slice(0, 12)}`.slice(0, 256) });
      if (!pub.Version || pub.Version === "$LATEST") throw new HttpError(502, "함수 판을 고정하지 못했습니다");
      version = pub.Version;
      if (row?.stopped_at) {
        smoke = { skipped: "멈춘 앱이라 시험 호출을 건너뜀" };
      } else {
        const t0 = Date.now();
        const out = await api.invoke(fn, version, smokeEvent("lively-deploy-check.invalid"), 60_000);
        const why = smokeFailure(out.functionError, out.payload, out.log);
        if (why) throw new DeployError(422, why, "smoke", tailText(out.log, 4000));
        let http: number | undefined;
        try { http = Number((JSON.parse(out.payload) as { statusCode?: unknown }).statusCode) || undefined; } catch { /* 본문 모양이 다르다 */ }
        smoke = { http_status: http, ms: Date.now() - t0 };
      }
    }
    for (const a of i.aliases) {
      await api.putAlias(fn, a, version, `v${i.versionNo ?? "?"} build ${i.buildKey.slice(0, 12)}`.slice(0, 256));
      await st.setServerAlias(i.app.id, a, { version_no: i.versionNo, build_key: i.buildKey, lambda_version: version });
    }
    await pruneVersions(api, fn, i.app.id, i.policy.keep_versions).catch((err) => logger.warn({ err, fn }, "옛 함수 판 정리 실패(비치명)"));
    return { function_name: fn, aliases: i.aliases, lambda_version: version, build_key: i.buildKey, smoke };
  } catch (e) {
    await st.setServerError(i.app.id, (e as Error)?.message ?? String(e)).catch(() => { /* 기록 실패는 원래 오류를 덮지 않는다 */ });
    throw e;
  } finally {
    await st.unlockServer(i.app.id).catch(() => { /* 잠금은 15분 뒤 저절로 풀린다 */ });
  }
}

/** 별칭이 가리키지 않는 옛 함수 판 — 최근 keep 개만 남긴다(코드 저장 합 300GiB 를 아껴 쓴다). */
async function pruneVersions(api: LambdaApi, fn: string, appId: string, keep: number): Promise<number> {
  const row = await st.getServerRow(appId);
  const pinned = new Set([row?.cur_lambda_version, row?.pub_lambda_version].filter((v): v is string => !!v));
  const nums = (await api.listVersions(fn)).map((v) => v.Version).filter((v): v is string => !!v && /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
  const drop = nums.filter((v, idx) => idx >= keep && !pinned.has(v));
  for (const v of drop) await api.deleteFunction(fn, v);
  return drop.length;
}

// ── 지금 판(설치된 판) 올리기 — app_server_deploy · 「이대로 넣기」·「공개하기」 ──

export interface InstalledTarget { app: OrgApp; decl: AppServerDecl; versionNo: number; savedBy: string | null; bundle: ReturnType<typeof versionBundle> }

/** 이 앱의 지금 판과 그 서버 선언 — 서버 앱이 아니면 null. 판 묶음이 아직 안 옮겨졌으면 409. */
export async function installedTarget(app: OrgApp): Promise<InstalledTarget | null> {
  const decl = serverDeclOf(app.manifest);
  if (!decl) return null;
  if (app.current_version_no == null) throw new HttpError(409, `「${app.title || app.id}」 은(는) 아직 저장된 판이 없습니다 — 먼저 app_save 로 저장하세요`);
  const v = await getAppVersionBundle(app.id, app.current_version_no);
  if (!v) throw new HttpError(409, `「${app.title || app.id}」 의 ${app.current_version_no}판 기록이 없습니다`);
  const vb = versionBundle(v);
  if (!vb) throw new HttpError(409, `「${app.title || app.id}」 의 ${app.current_version_no}판은 아직 파일 목록으로 옮겨지지 않았습니다 — 다시 저장(app_save)하거나 잠시 뒤 하세요`);
  return { app, decl: serverDeclOf(v.manifest) ?? decl, versionNo: app.current_version_no, savedBy: v.saved_by ?? null, bundle: vb };
}

/** 지금 판이 공개 판이기도 한가 — 공개 앱에 초안이 없으면 설치된 판이 곧 모두가 보는 판이다(pub 도 함께 옮긴다). */
export const installedIsPublished = (app: OrgApp): boolean => app.visibility === "all" && !app.draft_by;

export interface DeployOutcome {
  ok: boolean;
  app_id: string;
  version_no: number;
  build: { key: string; status: string; reused: boolean; stage?: string | null; error?: string | null; log_tail?: string | null; ms?: number | null; mem?: unknown; warnings?: unknown };
  deploy?: DeployResult;
  error?: string;
  stage?: string;
  log?: string | null;
}

/**
 * 지금 판을 빌드(필요하면 그 판을 저장한 사람의 세션에서)하고 cur(+ 공개 판이면 pub)에 올린다.
 *  seat — 빌드할 자리. 그 판을 저장한 사람이 아니면 null 로 넘긴다(빌드가 이미 있을 때만 올린다).
 */
export async function deployInstalled(t: InstalledTarget, seat: BuildSeat | null, policy: AppServerPolicy, deps0: ServerDeps = {}): Promise<DeployOutcome> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  if (!t.bundle) throw new HttpError(409, "판 파일 목록이 없습니다");
  const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
  const have = await st.getServerBuild(t.app.id, key);
  if (!(have?.status === "ok") && !seat) {
    throw new HttpError(409, `${t.versionNo}판의 서버가 아직 빌드되지 않았습니다 — 이 판은 ${t.savedBy ?? "다른 사람"} 님이 저장해서 그 사람의 세션에서 빌드해야 합니다` +
      "(그 사람이 「이대로 넣기」 또는 app_server_deploy). 남이 저장한 코드를 내 세션에서 돌리지 않습니다");
  }
  const built = have?.status === "ok" && have.zip_key
    ? { build: have, reused: true, key }
    : await ensureServerBuild({ appId: t.app.id, versionNo: t.versionNo, bundle: t.bundle.bundle, store: t.bundle.kind, decl: t.decl, env, policy, seat: seat! }, deps);
  const b = built.build;
  const detail = (b.detail ?? {}) as { ms?: number; mem?: unknown; warnings?: unknown };
  const buildView = { key, status: b.status, reused: built.reused, stage: b.stage, error: b.error, log_tail: b.status === "failed" ? b.log_tail : null, ms: detail.ms ?? null, mem: detail.mem ?? null, warnings: detail.warnings ?? [] };
  if (b.status !== "ok" || !b.zip_key || !b.zip_sha256) {
    return { ok: false, app_id: t.app.id, version_no: t.versionNo, build: buildView, error: b.error ?? "빌드가 실패했습니다", stage: b.stage ?? "build", log: b.log_tail };
  }
  const aliases: Array<"cur" | "pub"> = installedIsPublished(t.app) ? ["cur", "pub"] : ["cur"];
  try {
    const deploy = await deployBuildToAliases({ app: t.app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, aliases, policy }, deps);
    return { ok: true, app_id: t.app.id, version_no: t.versionNo, build: buildView, deploy };
  } catch (e) {
    const stage = e instanceof DeployError ? e.stage : "deploy";
    const log = e instanceof DeployError ? e.log : null;
    return { ok: false, app_id: t.app.id, version_no: t.versionNo, build: buildView, error: (e as Error)?.message ?? String(e), stage, log };
  }
}

/** 지금 판의 서버가 빌드됐나 · cur 에 올라가 있나 — 저장 응답의 안내용. 서버 앱이 아니거나 앱 서버가 꺼진 배포면 null. */
export async function installedBuildState(app: OrgApp, deps0: ServerDeps = {}): Promise<{ built: boolean; deployed: boolean } | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  const t = await installedTarget(app).catch(() => null);
  if (!t?.bundle) return null;
  const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
  const [b, row] = await Promise.all([st.getServerBuild(app.id, key), st.getServerRow(app.id)]);
  return { built: b?.status === "ok", deployed: row?.cur_build_key === key };
}

/** 공개 전 확인 — 공개할 판(설치된 판)의 서버 빌드가 있어야 한다. 서버 앱이 아니거나 앱 서버가 꺼진 배포면 그냥 통과(null). */
export async function publishServerDenial(app: OrgApp, deps0: ServerDeps = {}): Promise<string | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  const t = await installedTarget(app);
  if (!t || !t.bundle) return null;
  const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
  const b = await st.getServerBuild(app.id, key);
  if (b?.status === "ok") return null;
  return `「${app.title || app.id}」 의 ${t.versionNo}판은 서버가 아직 빌드되지 않아 공개할 수 없습니다 — 먼저 「이대로 넣기」 또는 app_server_deploy 로 서버를 빌드하세요` +
    (b?.status === "failed" ? `(지난 빌드 실패: ${b.error ?? b.stage ?? "?"})` : b?.status === "building" ? "(지금 빌드 중입니다)" : "");
}

/** 공개된 뒤 — 공개 판의 빌드를 pub(과 cur)에 올린다. 실패해도 공개는 이미 됐다(돌려준 글을 응답에 싣는다 · 다시 하기 = app_server_deploy). */
export async function afterPublishServer(app: OrgApp, policy: AppServerPolicy, deps0: ServerDeps = {}): Promise<{ ok: boolean; message?: string; deploy?: DeployResult } | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  try {
    const t = await installedTarget(app);
    if (!t || !t.bundle) return null;
    const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
    const b = await st.getServerBuild(app.id, key);
    if (b?.status !== "ok" || !b.zip_key || !b.zip_sha256) return { ok: false, message: "공개한 판의 서버 빌드가 없어 서버를 옮기지 못했습니다 — app_server_deploy" };
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, aliases: ["cur", "pub"], policy }, deps);
    return { ok: true, deploy };
  } catch (e) {
    logger.warn({ err: e, app: app.id }, "공개 뒤 앱 서버 옮기기 실패(#4484)");
    return { ok: false, message: `공개는 됐지만 서버를 공개 판으로 옮기지 못했습니다: ${(e as Error)?.message ?? e} — app_server_deploy 로 다시 하세요` };
  }
}

/** 되돌린 뒤 — 그 판의 빌드가 있으면 cur(+ 공개 판이면 pub)를 그 빌드로(빌드 없음). 빌드가 없으면 아무것도 안 한다(상태에 «빌드 안 됨» 으로 보인다). */
export async function afterRevertServer(app: OrgApp, policy: AppServerPolicy, deps0: ServerDeps = {}): Promise<{ ok: boolean; message?: string; deploy?: DeployResult } | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  try {
    const t = await installedTarget(app);
    if (!t || !t.bundle) return null;
    const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
    const b = await st.getServerBuild(app.id, key);
    if (b?.status !== "ok" || !b.zip_key || !b.zip_sha256) return { ok: false, message: `${t.versionNo}판은 서버가 빌드된 적이 없어 서버는 그대로입니다 — 「이대로 넣기」 또는 app_server_deploy` };
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, aliases: installedIsPublished(app) ? ["cur", "pub"] : ["cur"], policy }, deps);
    return { ok: true, deploy };
  } catch (e) {
    logger.warn({ err: e, app: app.id }, "되돌린 뒤 앱 서버 옮기기 실패(#4484)");
    return { ok: false, message: `서버를 되돌린 판으로 옮기지 못했습니다: ${(e as Error)?.message ?? e}` };
  }
}

// ── 멈춤 · 다시 켜기 · 지우기 ──

export async function stopServer(appId: string, by: string, reason: string, deps0: ServerDeps = {}): Promise<st.ServerRow> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const row = await st.getServerRow(appId);
  if (!row) throw new HttpError(404, `이 앱은 서버 함수가 없습니다: ${appId}`);
  await (deps.api ?? realLambdaApi(env.region)).putConcurrency(row.function_name, 0);
  await st.setServerStopped(appId, { by, reason });
  return (await st.getServerRow(appId))!;
}
export async function resumeServer(appId: string, deps0: ServerDeps = {}): Promise<st.ServerRow> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const row = await st.getServerRow(appId);
  if (!row) throw new HttpError(404, `이 앱은 서버 함수가 없습니다: ${appId}`);
  await (deps.api ?? realLambdaApi(env.region)).deleteConcurrency(row.function_name);
  await st.setServerStopped(appId, null);
  return (await st.getServerRow(appId))!;
}

/** 앱을 지울 때 — 함수 · 로그 그룹 · zip · 기록을 걷는다(되돌릴 수 없다 · 판 묶음이 남으니 다시 빌드할 수는 있다). best-effort: 실패는 돌려준다. */
export async function removeServer(appId: string, deps0: ServerDeps = {}): Promise<{ removed: boolean; errors: string[] }> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  const row = await st.getServerRow(appId).catch(() => null);
  const errors: string[] = [];
  if (env && row) {
    const api = deps.api ?? realLambdaApi(env.region);
    await api.deleteFunction(row.function_name).catch((e) => errors.push(`함수: ${(e as Error)?.message ?? e}`));
    await api.deleteLogGroup(logGroupFor(row.function_name)).catch((e) => errors.push(`로그: ${(e as Error)?.message ?? e}`));
  }
  const s3 = appBundleS3Config();
  const { zipKeys } = await st.deleteServerRows(appId).catch((e) => { errors.push(`기록: ${(e as Error)?.message ?? e}`); return { zipKeys: [] as string[] }; });
  for (const k of zipKeys) {
    if (deps.deleteZip) await deps.deleteZip(k).catch((e) => errors.push(`zip: ${(e as Error)?.message ?? e}`));
    else if (s3) await s3Delete(s3, k, { attempts: 1, timeoutMs: 10_000 }).catch((e) => errors.push(`zip: ${(e as Error)?.message ?? e}`));
  }
  return { removed: !!row, errors };
}

// ── 상태 ──

export async function serverStatus(app: OrgApp, deps0: ServerDeps = {}): Promise<Record<string, unknown>> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  const decl = serverDeclOf(app.manifest);
  const row = await st.getServerRow(app.id);
  const builds = await st.listServerBuilds(app.id, 5);
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
          deployed_to_cur: row?.cur_build_key === key, deployed_to_pub: row?.pub_build_key === key,
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
      stopped: row.stopped_at ? { at: row.stopped_at, by: row.stopped_by, reason: row.stop_reason } : null,
      last_error: row.last_error,
    } : null,
    builds: builds.map((b) => ({
      build_key: b.build_key, version_no: b.version_no, status: b.status, stage: b.stage, error: b.error, built_by: b.built_by,
      started_at: b.started_at, finished_at: b.finished_at, zip_mb: b.zip_bytes ? Math.round((b.zip_bytes / 1048576) * 10) / 10 : null,
      unzipped_mb: b.unzipped_bytes ? Math.round((b.unzipped_bytes / 1048576) * 10) / 10 : null, detail: b.detail,
    })),
  };
}

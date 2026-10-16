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
//  멈춤 · 다시 켜기 · 지우기 · 상태는 app-server-lifecycle.ts.
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import { tenantSlug } from "../terminal/catalog.js";
import { appBundleS3Config, blobTenant } from "./app-blob-store.js";
import {
  LAMBDA_HANDLER, appServerEnv, codeAt, functionCodeFor, functionNameFor, lambdaEnvFor, logGroupFor, logGroupTagBundleFor, serverDeclOf, smokeEvent, smokeFailure, tailText,
  type AppServerDecl, type AppServerEnv,
} from "./app-server-config.js";
import { codeBytesAfterDeploy, codeBytesOf, functionsCapDenial, type AppServerPolicy } from "./app-server-policy.js";
import { buildKeyFor, ensureServerBuild, usableBuild, type BuildDeps, type BuildSeat } from "./app-server-build.js";
import * as st from "./app-server-store.js";
import { versionBundle } from "./app-version-files.js";
import * as lam from "../net/aws/lambda-lite.js";
import { AwsError } from "../net/aws/aws-json.js";
import { s3Head } from "../net/aws/s3-lite.js";
import type { OrgApp } from "../org/store/apps.js";
import { getApp, getAppVersionBundle } from "../org/store/apps.js";

/** 시험이 갈아 끼우는 AWS 면(기본 = lambda-lite 를 그 지역으로). */
export interface LambdaApi {
  /** qualifier — 그 판의 설정 · 코드 자리(#4801 재사용 판정). 없으면 $LATEST. */
  getFunction(name: string, qualifier?: string): Promise<lam.FnGet | null>;
  getFunctionConfiguration(name: string, qualifier?: string): Promise<lam.FnConfiguration | null>;
  createFunction(input: lam.CreateFunctionInput): Promise<lam.FnConfiguration>;
  updateFunctionCode(name: string, code: lam.FnCode): Promise<lam.FnConfiguration>;
  updateFunctionConfiguration(name: string, input: lam.UpdateConfigInput): Promise<lam.FnConfiguration>;
  publishVersion(name: string, input: { CodeSha256?: string; Description?: string }): Promise<lam.FnConfiguration>;
  listVersions(name: string): Promise<lam.FnConfiguration[]>;
  putAlias(name: string, alias: string, version: string, description: string): Promise<lam.FnAlias>;
  invoke(name: string, qualifier: string, payload: unknown, timeoutMs: number): Promise<lam.InvokeOut>;
  deleteFunction(name: string, qualifier?: string): Promise<void>;
  putConcurrency(name: string, n: number): Promise<void>;
  deleteConcurrency(name: string): Promise<void>;
  /** tag — 로그 그룹 태그 묶음(#4790 · 없으면 태그 없이). */
  ensureLogGroup(group: string, retentionDays: number, tag?: lam.LogGroupTag | null): Promise<void>;
  deleteLogGroup(group: string): Promise<void>;
}

export function realLambdaApi(region: string): LambdaApi {
  const c = { region };
  return {
    getFunction: (n, q) => lam.getFunction(c, n, q),
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
    ensureLogGroup: (g, d, tag) => lam.ensureLogGroup(c, g, d, tag),
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
}

/** 시험이 끼우는 기본 의존(가짜 Lambda · zip 저장소 · 세션 실행) — 운영에서는 비어 있다. */
let testDeps: ServerDeps = {};
export function setServerDepsForTest(d: ServerDeps): void { testDeps = d; }
export const withDeps = (d: ServerDeps = {}): ServerDeps => ({ ...testDeps, ...d });

/** 이 배포가 앱 서버를 돌리나 — 아니면 까닭(사람에게 그대로). */
export function appServerUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!appServerEnv(env)) return "이 워크스페이스는 앱 서버 실행이 아직 켜져 있지 않습니다(자가호스팅 박스는 v2-8 에서) — 화면(web.root)은 그대로 됩니다";
  if (!appBundleS3Config(env) && !testDeps.bucket) return "판 묶음 버킷(LIVELY_APP_BUNDLE_BUCKET)이 없어 앱 서버를 올릴 수 없습니다";
  return null;
}

export const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lockedMsg = "이 앱의 서버를 다른 요청이 지금 올리고 있습니다 — 잠시 뒤 다시 하세요";

/**
 * 구성원에게 보일 오류 글 — AWS 오류 원문에는 플랫폼 계정 번호 · 박스 역할 · 인스턴스 이름이 들어갈 수 있다(AccessDenied 의 «User: arn:aws:sts::…»).
 *  권한 · 자격 오류는 코드와 요청 번호만, 그 밖은 ARN · 12자리 계정 번호를 지운 글로. 원문은 부르는 쪽이 로그에 남긴다(격리 리뷰).
 */
export function publicError(e: unknown): string {
  if (e instanceof AwsError) {
    const rid = e.requestId ? ` · 요청 ${e.requestId}` : "";
    //  #4801 코드를 우리 S3 에서 바로 읽는 길(REFERENCE)의 권한 거절도 플랫폼 설정 문제다 — 버킷 정책(Lambda 서비스) · 박스 역할(GetObjectVersion).
    //   Lambda 는 이 둘을 InvalidParameterValueException(400) 글로도 준다(2026-10-16 시험 원문).
    if (/AccessDenied|NotAuthorized|UnrecognizedClient|InvalidClientTokenId|ExpiredToken|NoCredentials|SignatureDoesNotMatch|InvalidSignature/i.test(e.code)
      || REFERENCE_PERMISSION_RE.test(e.message)) {
      return `플랫폼 쪽 AWS 권한 · 자격 문제로 실패했습니다(${e.code}${rid}) — 계속되면 운영자에게 알려 주세요`;
    }
    //  #4801 zip 없음 — 원문에 «s3://<판 묶음 버킷>/t/<워크스페이스>/z/…» 가 그대로 실린다(REFERENCE). 정해 둔 글로 바꾼다(그 빌드는 부르는 쪽이 무효로 적는다).
    if (ZIP_MISSING_RE.test(e.message)) return `빌드 결과(zip)를 저장소에서 찾지 못했습니다 — 다시 하면 새로 빌드합니다${rid ? ` (${rid.slice(3)})` : ""}`;
    return scrubAws(e.message) + (rid ? ` (${rid.slice(3)})` : "");
  }
  return (e as Error)?.message ?? String(e);
}

/** AWS 원문에서 플랫폼 자원 이름을 걷는다 — ARN · S3 주소(판 묶음 버킷 이름 · 워크스페이스 키 · #4801) · 12자리 계정 번호. */
export const scrubAws = (s: string): string =>
  s.replace(/arn:aws[^\s"',)]*/g, "(AWS 자원)").replace(/s3:\/\/[^\s"',)]*/g, "(저장소 객체)").replace(/\b\d{12}\b/g, "(계정)");

/**
 * Lambda 가 zip 을 못 찾았다는 글 — 그 빌드를 무효로 적고 다음 배포가 다시 빌드한다. COPY 는 «S3 Error Code: NoSuchKey», REFERENCE 는
 *  «The specified S3 object does not exist» · 판 번호 없이 줬는데 지금 판이 지움 표시면 «latest version of the S3 object is a delete marker»
 *  (2026-10-16 시험 원문 · #4801). 권한 거절(아래)은 zip 탓이 아니라 무효로 적지 않는다.
 */
export const ZIP_MISSING_RE = /S3 Error Code: NoSuchKey|The specified S3 object does not exist|latest version of the S3 object is a delete marker/i;
/** REFERENCE 의 권한 거절 — 버킷 정책이 Lambda 서비스에 GetObject · GetObjectVersion 을 안 줌 · 부르는 쪽(박스 역할)에 그 둘이 없음(2026-10-16 시험 원문). */
export const REFERENCE_PERMISSION_RE = /lambda\.amazonaws\.com does not have s3:GetObject|caller cannot access the referenced S3 object/i;

/** 이 함수가 이 워크스페이스의 것인가(태그 lvly:tenant) — 지우기 · 멈추기 · 감시 같은 파괴적인 길이 남의 함수에 닿지 않게(이름이 겹쳐도). */
export async function functionOwnership(api: LambdaApi, fn: string): Promise<"own" | "missing" | "foreign"> {
  const got = await api.getFunction(fn);
  if (!got) return "missing";
  return got.Tags?.["lvly:tenant"] === blobTenant() ? "own" : "foreign";
}
export const foreignMsg = (fn: string): string => `함수 이름 ${fn} 을 다른 워크스페이스가 쓰고 있습니다 — 운영자에게 알려 주세요`;

/** 새 함수를 만들어야 하는 앱이 워크스페이스 함수 수 상한에 닿았나(#4792) — 함수 줄이 있으면 늘 null. 막히면 까닭. */
export async function newFunctionDenial(appId: string, policy: AppServerPolicy): Promise<string | null> {
  if (await st.getServerRow(appId)) return null;
  return functionsCapDenial(policy, await st.countServerRows());
}

/** 이 앱의 함수 이름 — 이미 정한 이름(줄) 또는 새로 지을 이름. 64자를 넘어 못 지으면 null. */
async function functionNameOf(appId: string, env: AppServerEnv): Promise<string | null> {
  const row = await st.getServerRow(appId);
  return row?.function_name ?? functionNameFor(env.prefix, appId, tenantSlug() ?? "local");
}
const nameTooLong = (appId: string): HttpError => new HttpError(400, `앱 id 와 워크스페이스 이름이 길어 함수 이름(64자)을 만들 수 없습니다 — 더 짧은 앱 id 로 만드세요: ${appId}`);

/**
 * 함수가 준비될 때까지(만들기 · 코드/설정 고치기 뒤 Pending · InProgress) — 큰 zip(파일 수만 개)은 몇 분 걸린다(2026-10-15 실측).
 *  beforeUpdate — 코드를 올리기 바로 앞의 기다림: 다른 고치기가 도는 중(InProgress) · 만드는 중(Pending)만 기다린다.
 *   Inactive(오래 쉼 · #4801 원본 zip 을 잃음)는 코드를 다시 올려야 살아나고(AWS 문서 «restore access to the source artifact and update the function»),
 *   지난 고치기가 실패한 채(LastUpdateStatus Failed)도 다음 고치기가 덮어야 풀린다 — 여기서 막으면 6분 뒤 504 · 곧바로 502 로 끝나 스스로 못 고친다
 *   (격리 리뷰 · 재검토). 올린 뒤의 기다림은 Active 를 요구한다.
 */
async function waitReady(api: LambdaApi, fn: string, deps: ServerDeps, opts: { beforeUpdate?: boolean; maxMs?: number } = {}): Promise<lam.FnConfiguration> {
  const until = Date.now() + (opts.maxMs ?? 6 * 60_000);
  const sleep = deps.sleep ?? sleepDefault;
  for (;;) {
    const c = await api.getFunctionConfiguration(fn);
    if (!c) throw new HttpError(500, `함수가 사라졌습니다: ${fn}`);
    if (opts.beforeUpdate && (c.State === "Active" || c.State === "Inactive") && c.LastUpdateStatus !== "InProgress") return c;
    //  상태 설명은 AWS 원문이다 — 판 묶음 버킷 주소 · 계정 번호가 실릴 수 있어 걷는다(#4801 격리 리뷰).
    if (c.State === "Failed") throw new HttpError(502, `함수를 만들지 못했습니다: ${scrubAws(c.StateReason ?? c.StateReasonCode ?? "까닭 모름")}`);
    if (c.LastUpdateStatus === "Failed") throw new HttpError(502, `함수를 고치지 못했습니다: ${scrubAws(c.LastUpdateStatusReason ?? "까닭 모름")}`);
    if (c.State === "Active" && c.LastUpdateStatus !== "InProgress") return c;
    if (Date.now() > until) throw new HttpError(504, `함수가 준비되지 않았습니다(${c.State}/${c.LastUpdateStatus}) — 잠시 뒤 다시 하세요`);
    await sleep(deps.pollMs ?? 2000);
  }
}

/**
 * zip 이 아직 그 판으로 저장소에 있나(#4801) — 없거나(지움 표시) 지금 판이 기록과 다르면 까닭 글, 그대로면 null. 저장소를 못 봤으면(일시 오류) null —
 *  usableBuild 와 같은 쪽이다(못 본 채 막으면 S3 가 흔들릴 때 모든 배포가 멈춘다 · 그 길은 Lambda 가 다시 드러낸다).
 */
async function zipProblem(zipKey: string, zipVersion: string | null, deps: ServerDeps): Promise<string | null> {
  const s3 = appBundleS3Config();
  if (!deps.headZip && !s3) return null;
  let head: { size: number; versionId?: string | null } | null;
  try { head = deps.headZip ? await deps.headZip(zipKey) : await s3Head(s3!, zipKey, { attempts: 1, timeoutMs: 5_000 }); }
  catch (e) { logger.warn({ err: e, zipKey }, "잠금 안에서 zip 을 다시 보지 못했다 — 있다고 보고 진행(#4801)"); return null; }
  if (!head) return "빌드 결과(zip)가 방금 저장소에서 지워졌습니다 — 다시 하면 새로 빌드합니다";
  if (zipVersion && head.versionId && head.versionId !== zipVersion) return "빌드 결과(zip)가 다른 판으로 바뀌었습니다 — 다시 하면 새로 빌드합니다";
  return null;
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
  /** 같은 빌드를 다시 쓴 배포가 로그 그룹(보관 · 태그 lvly-fn)을 못 맞췄다 — 별칭은 옮겼지만 이 함수 기록이 CloudWatch 에 안 남을 수 있다(#4790). */
  logs_warning?: string;
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
  /** zip 크기(바이트) — 워크스페이스 코드 저장 상한(#4792)이 이번 배포가 더할 크기를 셈한다. */
  zipBytes: number;
  /** zip 의 S3 판 번호(#4801) — REFERENCE 면 함수가 이 판을 바로 읽는다. 모르면(옛 빌드 · 판 번호 없는 저장소) null — Lambda 가 지금 판으로 푼다. */
  zipVersion: string | null;
  aliases: Array<"cur" | "pub">; policy: AppServerPolicy;
}, deps0: ServerDeps = {}): Promise<DeployResult> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const api = deps.api ?? realLambdaApi(env.region);
  const bucket = deps.bucket ?? appBundleS3Config()?.bucket;
  if (!bucket) throw new HttpError(503, "판 묶음 버킷이 없습니다");
  const slug = tenantSlug() ?? "local";
  const fn = await functionNameOf(i.app.id, env);
  if (!fn) throw nameTooLong(i.app.id);
  //  #4792 새 함수는 워크스페이스 함수 수 상한 안에서만 — 공개 · 되돌리기도 이 길로 와서, 함수가 없는 앱이면 여기서 막힌다(있는 함수는 늘 고친다).
  const claimRow = async (): Promise<void> => {
    const claim = await st.claimServerRow(i.app.id, fn, i.policy.workspace_functions_max);
    if (!claim.row) throw new HttpError(409, functionsCapDenial(i.policy, claim.count) ?? "앱 서버 줄을 만들지 못했습니다");
  };
  await claimRow();
  const sleep = deps.sleep ?? sleepDefault;
  let locked = false;
  for (let n = 0; n < 30 && !locked; n++) {
    locked = await st.lockServer(i.app.id, 15 * 60);
    if (locked) break;
    //  줄이 사라졌으면(그 사이 하우스키핑이 서버 선언을 뺀 앱의 함수를 걷었다 · #4791) 잠금 다툼이 아니다 — 줄을 다시 잡는다(격리 리뷰).
    //   앱을 지워서 사라졌으면(removeServer) 되살리지 않는다 — 다시 만든 함수는 고아 쓸기가 걷을 것뿐이다(재검토).
    if (!(await st.getServerRow(i.app.id))) {
      if (!(await getApp(i.app.id))) throw new HttpError(404, `앱 없음: ${i.app.id} — 배포를 기다리는 사이 지워졌습니다`);
      await claimRow(); continue;
    }
    await sleep(deps.pollMs ?? 2000);
  }
  if (!locked) throw new HttpError(409, lockedMsg);
  let owned = false;   // 이 워크스페이스의 함수다(확인했거나 막 만들었다) — 도중에 실패해도 남은 판의 코드 크기를 다시 잰다(#4792)
  try {
    const row = await st.getServerRow(i.app.id);
    const want = {
      role: env.execRoleArn, handler: LAMBDA_HANDLER, runtime: env.runtime, memory: i.policy.memory_mb, timeout: i.policy.timeout_s,
      layer: env.layerArn, vars: lambdaEnvFor(i.app.id),
    };
    //  #4801 코드 자리 — REFERENCE(기본)면 Lambda 가 복사하지 않고 이 zip 의 이 판을 바로 읽는다(계정 코드 저장을 안 쓴다).
    const code = functionCodeFor(env, bucket, i.zipKey, i.zipVersion);
    //  cur 가 이미 같은 빌드의 함수 판을 가리키면 그 판을 그대로 쓴다(공개하기 · 되돌리기 직후) — 단 그 판의 설정(메모리 · 시간 · 레이어 · 역할 · 환경)이
    //   지금 바라는 값과 같을 때만. 다르면(관리자가 상한을 바꿈 · 어댑터 판을 올림) 아래에서 설정을 고쳐 새 판을 고정한다(«다음 배포부터» — 격리 리뷰).
    //   #4801 그 판이 읽는 코드 자리도 지금 빌드의 것(저장 방식 · 판 번호)이어야 한다 — 같은 지문을 다시 빌드해 zip 판이 바뀌었으면 옛 판을 읽는 함수 판은
    //   그 옛 판이 버킷 수명 규칙으로 사라질 때 멈춘다. COPY 로 만든 옛 함수 판도 여기서 REFERENCE 판으로 갈아탄다.
    //   Inactive 인 판도 재사용하지 않는다 — 별칭만 옮기면 멈춘 판에 그대로 묶인다. 아래 길이 코드를 다시 올려 되살린다(격리 리뷰).
    let reuse = row && row.cur_build_key === i.buildKey && row.cur_lambda_version ? row.cur_lambda_version : null;
    if (reuse) {
      const vg = await api.getFunction(fn, reuse);
      if (!vg || Object.keys(configDrift(vg.Configuration, want)).length || !codeAt(vg.Code, code) || vg.Configuration.State === "Inactive") reuse = null;
    }
    let version: string;
    let smoke: DeployResult["smoke"] = null;
    //  로그 그룹(보관 기간 · 태그 lvly-fn — #4790 실행 역할의 쓰기 조건이 이 태그를 본다). 같은 빌드를 다시 쓸 때도 맞춘다 — 태그가 빠진 그룹
    //   (태그를 달기 전에 만든 함수 · 손으로 지운 태그)은 그 함수 기록이 CloudWatch 에 안 써진다.
    const ensureLogs = (): Promise<void> => api.ensureLogGroup(logGroupFor(fn), i.policy.log_retention_days, logGroupTagBundleFor(env, fn));
    let logsWarning: string | null = null;
    if (reuse) {
      //  cur 가 이미 이 빌드일 때(공개하기 · 다시 넣기 · 되돌린 직후의 공개)는 코드를 안 올리고 별칭만 옮긴다 — 이 길은 #4484 까지 CloudWatch Logs 를
      //   안 불렀으니, 로그 그룹을 못 맞춰도 별칭은 옮긴다(Logs 장애 · 권한 문제로 공개가 막히지 않게). 삼키지 않고 결과 warnings · 마지막 오류로 보인다.
      //   다른 빌드로 가는 배포(되돌리기 포함)는 코드를 다시 올리는 아래 길이라 #4484 부터 로그 그룹 맞추기가 필수다(«배포가 초록이면 로그 배선도 됐다»).
      logsWarning = await ensureLogs().then(() => null, (err: unknown) => { logger.warn({ err, fn }, "로그 그룹 맞추기 실패 — 별칭은 옮긴다(#4790)"); return publicError(err); });
      version = reuse;
    } else {
      let got = await api.getFunction(fn);
      //  이름이 겹친 남의 워크스페이스 함수면 무엇을 재거나 고치기 전에 멈춘다(아래 만든 뒤의 확인과 같은 판정).
      if (got && got.Tags?.["lvly:tenant"] !== blobTenant()) {
        await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
        throw new HttpError(409, foreignMsg(fn));
      }
      //  #4801 잠금 안에서 zip 을 한 번 더 본다 — 잠금 밖에서 본 뒤(usableBuild) 옛 빌드 정리가 그 zip 을 지웠으면(지움 표시) 못 박을 판이 «옛 판» 이 된다.
      //   Lambda 는 옛 판도 읽어 배포는 초록인데, 그 판은 버킷 수명 규칙으로 30일 뒤 사라져 함수가 그때 멈춘다(조용한 성공 · 격리 리뷰). 정리는 이 잠금을
      //   잡아야 지우므로(app-server-watch pruneServerBuilds) 여기서 본 판은 이 배포가 끝날 때까지 지금 판으로 남는다.
      if (code.S3ObjectStorageMode === "REFERENCE") {
        const problem = await zipProblem(i.zipKey, i.zipVersion, deps);
        if (problem) {
          await st.invalidateServerBuild(i.app.id, i.buildKey, problem).catch(() => { /* 다음에 */ });
          if (!got) await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
          throw new HttpError(409, problem);
        }
      }
      //  zip 크기를 모르면(저장소를 못 본 옛 빌드) 상한이 이번 코드를 0 으로 센다 — 드물지만 보이게 남긴다(재검토).
      if (!(i.zipBytes > 0)) logger.warn({ app: i.app.id, build: i.buildKey }, "빌드 zip 크기를 모른다 — 코드 저장 상한이 이번 코드를 0 으로 센다(#4792)");
      //  #4792 코드 저장 상한 — 이 함수가 배포 뒤 차지할 크기(옛 판 정리와 같은 규칙)를 다른 함수들의 합에 더해 본다.
      //   이번에 옮기지 않는 별칭(초안만 올릴 때의 pub)이 가리키는 판은 정리에서 빠지니 남는 쪽에 센다.
      const vers = got ? await api.listVersions(fn) : [];
      const after = codeBytesAfterDeploy(vers, i.zipBytes, i.policy.keep_versions, i.aliases.includes("pub") ? [] : [row?.pub_lambda_version]);
      //   판정과 자리 잡기를 함수 수와 같은 워크스페이스 자문 락 안에서 — 같은 때 다른 앱을 올리는 배포가 이 몫을 센다(격리 리뷰).
      const full = await st.reserveServerCode(i.app.id, i.policy, codeBytesOf(vers), after);
      if (full) {
        //  함수가 아직 없는 앱이면 방금 잡은 줄을 지운다 — 남으면 함수 수 상한의 한 칸을 빈 줄이 차지한다.
        if (!got) await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
        throw new HttpError(409, full);
      }
      await ensureLogs();
      if (!got) {
        //  실행 역할을 막 만든 직후(인프라 적용 직후)엔 Lambda 가 그 역할을 아직 못 맡는다는 오류가 잠깐 난다 — 몇 번 다시 한다.
        for (let n = 0; ; n++) {
          try {
            await api.createFunction({
              FunctionName: fn, Runtime: env.runtime, Role: env.execRoleArn, Handler: LAMBDA_HANDLER,
              Code: code, Architectures: [env.arch], MemorySize: want.memory, Timeout: want.timeout,
              Layers: [env.layerArn], Environment: { Variables: want.vars },
              Description: `lively app ${i.app.id} (${slug})`.slice(0, 256),
              Tags: { "lvly:tenant": blobTenant(), "lvly:app": i.app.id, "lvly:workspace": slug }, Publish: false,
            });
            owned = true;   // 우리 태그로 막 만들었다 — 이 뒤에서 실패해도 코드 크기를 다시 잰다(격리 리뷰: 만든 직후 실패가 0 으로 남았다)
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
      if (owner !== blobTenant()) {
        //  막 만든(아무 판도 안 올린) 줄이면 지운다 — 남으면 멈추기 · 지우기가 남의 함수 이름을 붙잡는다.
        await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
        throw new HttpError(409, foreignMsg(fn));
      }
      owned = true;
      //  같은 코드 지문이어도 저장 방식 · 읽는 판이 다르면 다시 올린다(#4801 — COPY 로 만든 옛 함수를 REFERENCE 로 옮긴다 · 그 반대도).
      //   Inactive(오래 쉼 · 원본을 잃음)면 같은 코드라도 다시 올린다 — 코드 고치기가 되살리는 길이다(AWS 문서 · 격리 리뷰).
      const upload = got.Configuration.CodeSha256 !== i.zipSha256 || !codeAt(got.Code, code) || got.Configuration.State === "Inactive";
      if (upload) {
        await waitReady(api, fn, deps, { beforeUpdate: true });
        await api.updateFunctionCode(fn, code);
      }
      //  코드를 안 올렸으면 남은 «고치기 실패»(LastUpdateStatus Failed)는 지난 시도의 것이다 — AWS 는 실패한 고치기를 걷고 그 전 코드 · 설정을 둔다.
      //   여기서 막으면 그 전 판으로 되돌리기 · 설정만 고치기가 영영 502 다(재검토). 이번에 올렸으면 그 결과를 기다린다(실패면 502).
      const cfg = await waitReady(api, fn, deps, { beforeUpdate: !upload });
      if (cfg.CodeSha256 !== i.zipSha256) {
        //  zip 의 바이트가 빌드 기록과 다르다 — 그 빌드를 못 쓰게 적어 두면 다음 배포가 다시 빌드한다(같은 줄을 «재사용» 하며 영영 실패하지 않게).
        await st.invalidateServerBuild(i.app.id, i.buildKey, "함수에 올라간 코드가 빌드 기록의 지문과 다릅니다").catch(() => { /* 다음에 */ });
        throw new HttpError(409, "함수에 올라간 코드가 빌드 기록과 다릅니다 — 다시 하면 새로 빌드합니다");
      }
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
    //  별칭을 옮기면 마지막 오류가 지워진다 — 로그 그룹을 못 맞춘 것은 그 뒤에 적어 상태에서도 보이게(다음에 맞추면 다시 지워진다).
    if (logsWarning) await st.setServerError(i.app.id, logsWarningText(logsWarning)).catch(() => { /* 결과에 있다 */ });
    await pruneVersions(api, fn, i.app.id, i.policy.keep_versions).catch((err) => logger.warn({ err, fn }, "옛 함수 판 정리 실패(비치명)"));
    return { function_name: fn, aliases: i.aliases, lambda_version: version, build_key: i.buildKey, smoke, ...(logsWarning ? { logs_warning: logsWarning } : {}) };
  } catch (e) {
    //  zip 이 저장소에 없다(ZIP_MISSING_RE — COPY · REFERENCE 의 두 글) — 그 빌드를 못 쓰게 적는다(다음 배포가 다시 빌드).
    //   S3 권한 오류(AccessDenied · REFERENCE 권한 거절)는 zip 탓이 아니다 — 무효로 적으면 누를 때마다 저장한 사람의 세션에서 처음부터 다시 빌드한다.
    if (e instanceof AwsError && ZIP_MISSING_RE.test(e.message)) {
      await st.invalidateServerBuild(i.app.id, i.buildKey, "빌드 결과(zip)를 함수에 올리지 못했습니다(저장소에 없음)").catch(() => { /* 다음에 */ });
    }
    if (e instanceof AwsError) logger.warn({ err: e, app: i.app.id, fn }, "앱 서버 배포 AWS 오류(#4484)");
    //  코드를 올렸거나 판을 고정한 뒤 실패했으면 그 함수의 코드 크기가 바뀌었다 — 다시 재 둔다(상한이 낡은 값으로 세지 않게).
    if (owned) await recordCodeBytes(api, fn, i.app.id).catch((err) => logger.warn({ err, fn }, "함수 코드 크기 재기 실패(비치명)"));
    //  함수를 하나도 못 만든 채 끝난 첫 배포(역할 전파 · 계정 한도 등)면 빈 줄을 걷는다 — 남으면 함수 수 상한의 한 칸을 계속 잡는다(격리 리뷰).
    //   AWS 에 함수가 있으면(남이 만든 것 포함) 줄을 남긴다 — 확인을 못 했어도 남긴다. 우리 함수가 있으면(자리를 잡은 뒤 로그 그룹 등에서 실패 ·
    //   만들기가 응답 없이 끝났는데 함수는 생김) 잡아 둔 크기(배포 뒤 셈)를 실측으로 덮는다(재검토).
    else {
      const g = await api.getFunction(fn).catch(() => undefined);   // undefined = 확인 못 함
      if (g === null) await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
      else if (g && g.Tags?.["lvly:tenant"] === blobTenant()) await recordCodeBytes(api, fn, i.app.id).catch((err) => logger.warn({ err, fn }, "함수 코드 크기 재기 실패(비치명)"));
    }
    const msg = publicError(e);
    await st.setServerError(i.app.id, msg).catch(() => { /* 기록 실패는 원래 오류를 덮지 않는다 */ });
    if (e instanceof AwsError) throw new HttpError(502, msg);
    throw e;
  } finally {
    await st.unlockServer(i.app.id).catch(() => { /* 잠금은 15분 뒤 저절로 풀린다 */ });
  }
}

/**
 * 별칭이 가리키지 않는 옛 함수 판 — 최근 keep 개만 남긴다(COPY 판은 계정 코드 저장 300GiB 를 쓰고 · REFERENCE 판은 우리 zip 을 붙잡는다 — 남은 판이 읽는 zip 은
 *  옛 빌드 정리가 지우지 않는다 · #4801). 남은 판의 코드 크기 합을 적는다(#4792 — 지우다 실패해도 지운 것까지만 빼서 적는다).
 *  이 규칙을 바꾸면 codeBytesAfterDeploy(상한 셈)도 같이 바꾼다.
 */
async function pruneVersions(api: LambdaApi, fn: string, appId: string, keep: number): Promise<number> {
  const row = await st.getServerRow(appId);
  const pinned = new Set([row?.cur_lambda_version, row?.pub_lambda_version].filter((v): v is string => !!v));
  const all = await api.listVersions(fn);
  const nums = all.map((v) => v.Version).filter((v): v is string => !!v && /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
  const drop = nums.filter((v, idx) => idx >= keep && !pinned.has(v));
  const gone = new Set<string>();
  try {
    for (const v of drop) { await api.deleteFunction(fn, v); gone.add(v); }
  } finally {
    await st.setServerCodeBytes(appId, codeBytesOf(all.filter((v) => !gone.has(v.Version ?? "")))).catch((err) => logger.warn({ err, fn }, "함수 코드 크기 적기 실패(비치명)"));
  }
  return drop.length;
}

/** 이 함수의 지금 코드 크기를 AWS 에서 재 적는다(#4792 — 판 정리를 못 한 실패 길). */
async function recordCodeBytes(api: LambdaApi, fn: string, appId: string): Promise<number> {
  const bytes = codeBytesOf(await api.listVersions(fn));
  await st.setServerCodeBytes(appId, bytes);
  return bytes;
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
  /** 배포는 됐지만 알릴 것 — 예: 로그 그룹을 못 맞춤(이 함수 기록이 CloudWatch 에 안 남을 수 있다 · #4790). */
  warnings?: string[];
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
  //  함수 이름(64자)을 못 지으면 · 워크스페이스 함수 수가 상한에 닿았으면(#4792 · 함수가 아직 없는 앱만) 몇 분 빌드한 뒤가 아니라 지금 알린다.
  if (!(await functionNameOf(t.app.id, env))) throw nameTooLong(t.app.id);
  const full = await newFunctionDenial(t.app.id, policy);
  if (full) throw new HttpError(409, full);
  const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
  const have = await usableBuild(await st.getServerBuild(t.app.id, key), deps);
  if (!have && !seat) {
    throw new HttpError(409, `${t.versionNo}판의 서버가 아직 빌드되지 않았습니다 — 이 판은 ${t.savedBy ?? "다른 사람"} 님이 저장해서 그 사람의 세션에서 빌드해야 합니다` +
      "(그 사람이 「이대로 넣기」 또는 app_server_deploy). 남이 저장한 코드를 내 세션에서 돌리지 않습니다");
  }
  const built = have
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
    const deploy = await deployBuildToAliases({ app: t.app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases, policy }, deps);
    return { ok: true, app_id: t.app.id, version_no: t.versionNo, build: buildView, deploy, ...deployWarnings(deploy) };
  } catch (e) {
    const stage = e instanceof DeployError ? e.stage : "deploy";
    const log = e instanceof DeployError ? e.log : null;
    return { ok: false, app_id: t.app.id, version_no: t.versionNo, build: buildView, error: publicError(e), stage, log };
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
  if (await usableBuild(await st.getServerBuild(app.id, key), deps)) return null;
  const b = await st.getServerBuild(app.id, key);
  return `「${app.title || app.id}」 의 ${t.versionNo}판은 서버가 아직 빌드되지 않아 공개할 수 없습니다 — 먼저 「이대로 넣기」 또는 app_server_deploy 로 서버를 빌드하세요` +
    (b?.status === "failed" ? `(지난 빌드 실패: ${b.error ?? b.stage ?? "?"})` : b?.status === "building" ? "(지금 빌드 중입니다)" : "");
}

/** 공개 · 되돌리기 뒤 서버 옮기기의 결과 — 응답 server 칸(state: deployed · failed). */
export interface ServerMove { ok: boolean; state: "deployed" | "failed"; message?: string; deploy?: DeployResult; warnings?: string[] }

/** 로그 그룹을 못 맞춘 배포의 알림 글(#4790) — 마지막 오류 · 배포 결과 · 공개 · 되돌리기 응답이 같은 글을 쓴다. */
const logsWarningText = (w: string): string => `로그 그룹을 맞추지 못했습니다 — 이 함수 기록이 CloudWatch 에 안 남을 수 있습니다: ${w}`;
/** 배포는 됐지만 알릴 것 — 응답 최상위 warnings 로(상태만 읽는 쪽에도 보이게). 없으면 빈 객체. */
function deployWarnings(d: DeployResult): { warnings?: string[] } {
  return d.logs_warning ? { warnings: [logsWarningText(d.logs_warning)] } : {};
}

/** 공개된 뒤 — 공개 판의 빌드를 pub(과 cur)에 올린다. 실패해도 공개는 이미 됐다(돌려준 글을 응답에 싣는다 · 다시 하기 = app_server_deploy). */
export async function afterPublishServer(app: OrgApp, policy: AppServerPolicy, deps0: ServerDeps = {}): Promise<ServerMove | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  try {
    const t = await installedTarget(app);
    if (!t || !t.bundle) return null;
    const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
    const b = await usableBuild(await st.getServerBuild(app.id, key), deps);
    if (!b?.zip_key || !b.zip_sha256) return { ok: false, state: "failed", message: "공개한 판의 서버 빌드가 없어 서버를 옮기지 못했습니다 — app_server_deploy" };
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases: ["cur", "pub"], policy }, deps);
    return { ok: true, state: "deployed", deploy, ...deployWarnings(deploy) };
  } catch (e) {
    logger.warn({ err: e, app: app.id }, "공개 뒤 앱 서버 옮기기 실패(#4484)");
    return { ok: false, state: "failed", message: `공개는 됐지만 서버를 공개 판으로 옮기지 못했습니다: ${publicError(e)} — app_server_deploy 로 다시 하세요` };
  }
}

/** 되돌린 뒤 — 그 판의 빌드가 있으면 cur(+ 공개 판이면 pub)를 그 빌드로(빌드 없음). 빌드가 없으면 아무것도 안 한다(상태에 «빌드 안 됨» 으로 보인다). */
export async function afterRevertServer(app: OrgApp, policy: AppServerPolicy, deps0: ServerDeps = {}): Promise<ServerMove | null> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env || !serverDeclOf(app.manifest)) return null;
  try {
    const t = await installedTarget(app);
    if (!t || !t.bundle) return null;
    const key = buildKeyFor({ bundle: t.bundle.bundle, decl: t.decl, env });
    const b = await usableBuild(await st.getServerBuild(app.id, key), deps);
    if (!b?.zip_key || !b.zip_sha256) return { ok: false, state: "failed", message: `${t.versionNo}판은 서버가 빌드된 적이 없어(또는 빌드 결과가 없어져) 서버는 그대로입니다 — 「이대로 넣기」 또는 app_server_deploy` };
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases: installedIsPublished(app) ? ["cur", "pub"] : ["cur"], policy }, deps);
    return { ok: true, state: "deployed", deploy, ...deployWarnings(deploy) };
  } catch (e) {
    logger.warn({ err: e, app: app.id }, "되돌린 뒤 앱 서버 옮기기 실패(#4484)");
    return { ok: false, state: "failed", message: `서버를 되돌린 판으로 옮기지 못했습니다: ${publicError(e)}` };
  }
}

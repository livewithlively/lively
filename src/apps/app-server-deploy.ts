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
import { gatewayUrl } from "../gateway-url.js";
import { blobTenant } from "./app-blob-store.js";
import {
  ENV_ROTATING, LAMBDA_HANDLER, appServerApiUrl, appServerEnv, appServerHostUnavailable, codeAt, functionCodeFor, functionNameFor, functionSizingFor, lambdaEnvFor, logGroupFor, logGroupTagBundleFor, serverDeclOf, smokeEvent, smokeFailure, tailText,
  type AppServerDecl, type AppServerEnv,
} from "./app-server-config.js";
import { appServerApi, appServerZipStore, type LambdaApi } from "./app-server-host.js";
import { GUARD_HEADER, GUARD_READY_PATH, GUARD_VERSION } from "./app-server-guard.js";
import { openJobPins } from "./app-jobs-store.js";
import { ensureGuardLayer } from "./app-server-layer.js";
import { collectHttpStream, lambdaErrorOf } from "./app-server-stream.js";
import { mintAppServerFunctionToken, revokeStaleFunctionTokens } from "./app-server-auth.js";
import { appIdentityKeysFromEnv } from "./app-identity.js";
import { appSqlTenantId } from "./app-sql-exec.js";
import { codeBytesAfterDeploy, codeBytesOf, functionsCapDenial, type AppServerPolicy } from "./app-server-policy.js";
import { buildKeyFor, ensureServerBuild, usableBuild, type BuildDeps, type BuildSeat } from "./app-server-build.js";
import * as st from "./app-server-store.js";
import { versionBundle } from "./app-version-files.js";
import type * as lam from "../net/aws/lambda-lite.js";
import { AwsError } from "../net/aws/aws-json.js";
import { S3Error } from "../net/aws/s3-lite.js";
import type { OrgApp } from "../org/store/apps.js";
import { getApp, getAppVersionBundle } from "../org/store/apps.js";

//  함수 실행면(Lambda API 꼴) · zip 저장소는 실행면마다 하나씩이다(#4487 app-server-host) — 이 파일 · lifecycle · watch · app-front-server · app-jobs 는
//   그 겉면으로만 부른다. 시험은 아래 ServerDeps(api · bucket · headZip · deleteZip · presignPut)로 갈아 끼운다.
export { realLambdaApi, type LambdaApi } from "./app-server-host.js";

export interface ServerDeps extends BuildDeps {
  api?: LambdaApi;
  env?: AppServerEnv;
  /** 시험 — 기다리기(함수 준비 · 잠금)를 빨리. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 시험 — zip 버킷 이름. 기본 = LIVELY_APP_BUNDLE_BUCKET. */
  bucket?: string;
  /** #4485 시험 — 검사 층 레이어 판(기본 = ensureGuardLayer) · 신원 공개 키(기본 = env) · 라이블리 주소(기본 = 워크스페이스 주소) · 토큰 발급 · 회수. */
  guardLayerArn?: string;
  identityPubkeys?: string;
  apiUrl?: string;
  mintFunctionToken?: (appId: string) => Promise<{ token: string; tokenHash: string }>;
  revokeFunctionTokens?: (appId: string, keep: Array<string | null | undefined>, actor?: string, opts?: { jobPins?: boolean }) => Promise<number>;
}

/** 시험이 끼우는 기본 의존(가짜 Lambda · zip 저장소 · 세션 실행) — 운영에서는 비어 있다. */
let testDeps: ServerDeps = {};
export function setServerDepsForTest(d: ServerDeps): void { testDeps = d; }
export const withDeps = (d: ServerDeps = {}): ServerDeps => ({ ...testDeps, ...d });

/** 이 배포가 앱 서버를 돌리나 — 아니면 까닭(사람에게 그대로). */
export function appServerUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  //  #4487 실행면 이름이 틀렸거나 이 판에 없는 실행면이면 그 까닭이 먼저다(아래 «켜져 있지 않음» 보다 고칠 자리가 또렷하다).
  const host = appServerHostUnavailable(env);
  if (host) return `${host} — 화면(web.root)은 그대로 됩니다`;
  if (!appServerEnv(env)) return "이 워크스페이스는 앱 서버 실행이 아직 켜져 있지 않습니다 — 화면(web.root)은 그대로 됩니다";
  if (!appServerZipStore(env) && !testDeps.bucket) return "판 묶음 버킷(LIVELY_APP_BUNDLE_BUCKET)이 없어 앱 서버를 올릴 수 없습니다";
  return null;
}

export const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const lockedMsg = "이 앱의 서버를 다른 요청이 지금 올리고 있습니다 — 잠시 뒤 다시 하세요";
/** 배포 잠금을 못 잡아 실패했나(#4887 — 상태 점검은 그 앱을 다음에 다시 본다 · 고치기 실패로 알리지 않는다). */
export const isServerLockedError = (e: unknown): boolean => e instanceof HttpError && e.status === 409 && e.message === lockedMsg;
const changedMsg = "그사이 이 앱의 서버 별칭이 옮겨졌습니다 — 다시 보고 하세요";
/** expect 와 지금 별칭이 달라 아무것도 안 했나(#4887 — 점검이 본 뒤 사람이 배포 · 공개했다 · 되돌리지 않고 다음에 다시 본다). */
export const isServerChangedError = (e: unknown): boolean => e instanceof HttpError && e.status === 409 && e.message === changedMsg;
/**
 * 함수 판이 코드를 못 읽나(GetFunction Code.Error · #4887) — 오류 코드나 글이 있을 때만 오류로 본다. 빈 칸을 «코드를 못 읽음» 으로 읽으면 건강한 판을
 *  날마다 다시 올린다(재사용 길도 거른다 — 격리 리뷰).
 */
export function codeErrorOf(code: { Error?: { ErrorCode?: string; Message?: string } | null } | null | undefined): { ErrorCode?: string; Message?: string } | null {
  const e = code?.Error;
  return e && (e.ErrorCode || e.Message) ? e : null;
}

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
 *   지난 고치기가 실패한 채(LastUpdateStatus Failed)도 이번 고치기가 덮어야 풀린다 — 여기서 막으면 6분 뒤 504 · 곧바로 502 로 끝나 스스로 못 고친다
 *   (격리 리뷰 · 재검토). 올린 뒤 · 만든 뒤 · 설정을 고친 뒤의 기다림은 늘 Active · 고치기 성공을 요구한다(이번 배포 자신의 실패는 502).
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
  const store = appServerZipStore();
  if (!deps.headZip && !store) return null;
  let head: { size: number; versionId?: string | null } | null;
  try { head = deps.headZip ? await deps.headZip(zipKey) : await store!.head(zipKey, { attempts: 1, timeoutMs: 5_000 }); }
  catch (e) { logger.warn({ err: e, zipKey }, "잠금 안에서 zip 을 다시 보지 못했다 — 있다고 보고 진행(#4801)"); return null; }
  if (!head) return "빌드 결과(zip)가 방금 저장소에서 지워졌습니다 — 다시 하면 새로 빌드합니다";
  if (zipVersion && head.versionId && head.versionId !== zipVersion) return "빌드 결과(zip)가 다른 판으로 바뀌었습니다 — 다시 하면 새로 빌드합니다";
  return null;
}

/**
 * 함수 설정이 바라는 값과 다른가(고칠 칸만 돌려준다 — 빈 객체면 그대로).
 *  ENV_ROTATING(앱 서버 토큰)은 «있나» 만 본다 — 판마다 새로 굽는 값이라 값이 다르다고 새 판을 만들지 않는다(#4485).
 *   exact — 새 판을 고정하기 직전에는 토큰까지 그대로 맞춘다(아니면 $LATEST 의 옛 토큰이 새 판에 들어가고, 그 토큰을 회수하면 새 판이 깨진다).
 */
export function configDrift(c: lam.FnConfiguration, want: { role: string; handler: string; runtime: string; memory: number; timeout: number; tmp?: number; layers: string[]; vars: Record<string, string> },
  o: { exact?: boolean } = {}): lam.UpdateConfigInput {
  const out: lam.UpdateConfigInput = {};
  if (c.Role !== want.role) out.Role = want.role;
  if (c.Handler !== want.handler) out.Handler = want.handler;
  if (c.Runtime !== want.runtime) out.Runtime = want.runtime;
  if (c.MemorySize !== want.memory) out.MemorySize = want.memory;
  if (c.Timeout !== want.timeout) out.Timeout = want.timeout;
  //  #4486 임시 디스크 — AWS 는 안 고친 함수에 512 를 보인다(칸이 없으면 512 로 본다).
  if (want.tmp !== undefined && (c.EphemeralStorage?.Size ?? 512) !== want.tmp) out.EphemeralStorage = { Size: want.tmp };
  const layers = (c.Layers ?? []).map((l) => l.Arn);
  if (layers.length !== want.layers.length || layers.some((a, i) => a !== want.layers[i])) out.Layers = [...want.layers];
  const vars = c.Environment?.Variables ?? {};
  const same = Object.keys(want.vars).length === Object.keys(vars).length
    && Object.entries(want.vars).every(([k, v]) => (ENV_ROTATING.has(k) && !o.exact ? typeof vars[k] === "string" && vars[k] !== "" : vars[k] === v));
  if (!same) out.Environment = { Variables: want.vars };
  return out;
}

/** 이 워크스페이스의 신원 공개 키(JSON) — 쓸 만한 키가 하나도 없으면 null(검사 층이 모든 요청을 거부하는 함수를 만들지 않게). */
export function identityPubkeysForFunctions(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.LIVELY_APP_IDENTITY_PUBKEYS ?? "").trim();
  return raw && appIdentityKeysFromEnv(env).size > 0 ? raw : null;
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
  /** #4486 함수 크기(web.server.memory_mb · tmp_mb)를 줄였거나 못 읽었다 — 사람 말로. */
  sizing_notes?: string[];
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
  /** 배포 잠금을 몇 번 잡아 볼까(기본 30 — 2초 간격 · 약 1분). 하우스키핑의 상태 점검(#4887)은 1 — 잠겨 있으면 기다리지 않고 다음 틱에. */
  lockTries?: number;
  /**
   * 잠금을 잡은 뒤 별칭이 이 판이어야 한다(#4887 상태 점검 — 고를 때 본 판). 다르면 그사이 사람이 배포 · 공개 · 되돌리기를 끝낸 것이다 —
   *  아무것도 안 하고 409(isServerChangedError). 낡은 판단으로 사람이 방금 옮긴 별칭을 되돌리지 않게(격리 리뷰).
   */
  expect?: Partial<Record<"cur" | "pub", string | null>>;
  /**
   * #4486 그 판의 매니페스트 — 함수 크기(web.server.memory_mb · tmp_mb)를 읽는다. 안 주면 versionNo 의 판 기록에서 읽는다(상태 점검의 다시 올리기 —
   *  같은 판이면 같은 크기라 설정이 엇갈려 새 판이 생기지 않는다). 판 기록도 없으면 워크스페이스 기본.
   */
  manifest?: unknown;
}, deps0: ServerDeps = {}): Promise<DeployResult> {
  const deps = withDeps(deps0);
  const env = deps.env ?? appServerEnv();
  if (!env) throw new HttpError(503, appServerUnavailable() ?? "앱 서버 설정이 없습니다");
  const api = deps.api ?? appServerApi(env);
  const bucket = deps.bucket ?? appServerZipStore()?.bucket;
  if (!bucket) throw new HttpError(503, "판 묶음 버킷이 없습니다");
  const slug = tenantSlug() ?? "local";
  const fn = await functionNameOf(i.app.id, env);
  if (!fn) throw nameTooLong(i.app.id);
  //  #4485 — 검사 층이 볼 신원 공개 키 · 앱 서버가 부를 라이블리 주소. 없으면 함수를 만들어도 모든 요청이 거부되거나 라이블리를 못 부른다 — 지금 멈춘다.
  //   함수 줄을 잡기 전에 본다 — 줄을 잡은 뒤 여기서 멈추면 함수 없는 빈 줄이 함수 수 상한(#4792)의 한 칸을 차지한다.
  //   #4487 자가호스팅(결정 #5052 ① claim · ② 1판엔 앱 주소 없음) — 서명 신원은 쓰지 않으니 공개 키 없이 «{}» 로 굽는다(검사 층은 서명 신원 요청을 모두 401 ·
  //   작업 신원(claim)은 게이트웨이에 확인받아 공개 키를 쓰지 않는다). 박스에 공개 키가 있으면 그것을 굽는다.
  const identityPubkeys = deps.identityPubkeys ?? identityPubkeysForFunctions() ?? (env.host === "local" ? "{}" : null);
  if (!identityPubkeys) throw new HttpError(503, "사람 신원 공개 키(LIVELY_APP_IDENTITY_PUBKEYS)가 이 게이트웨이에 없어 앱 서버를 올리지 않습니다 — 운영 설정(앱 주소 앞단 신원 서명 키)을 먼저 하세요");
  const apiUrl = deps.apiUrl ?? appServerApiUrl(slug, await gatewayUrl().catch(() => null));
  if (!apiUrl) throw new HttpError(503, "이 워크스페이스의 라이블리 주소(LIVELY_API_URL)를 정하지 못해 앱 서버를 올리지 않습니다 — 조직 정보의 게이트웨이 주소 · PUBLIC_URL 을 보세요");
  const guardLayerArn = deps.guardLayerArn ?? await ensureGuardLayer(api, env);
  //  #4792 새 함수는 워크스페이스 함수 수 상한 안에서만 — 공개 · 되돌리기도 이 길로 와서, 함수가 없는 앱이면 여기서 막힌다(있는 함수는 늘 고친다).
  const claimRow = async (): Promise<void> => {
    const claim = await st.claimServerRow(i.app.id, fn, i.policy.workspace_functions_max);
    if (!claim.row) throw new HttpError(409, functionsCapDenial(i.policy, claim.count) ?? "앱 서버 줄을 만들지 못했습니다");
  };
  await claimRow();
  const sleep = deps.sleep ?? sleepDefault;
  let locked = false;
  const lockTries = Math.max(1, i.lockTries ?? 30);
  for (let n = 0; n < lockTries && !locked; n++) {
    locked = await st.lockServer(i.app.id, 15 * 60);
    if (locked) break;
    //  줄이 사라졌으면(그 사이 하우스키핑이 서버 선언을 뺀 앱의 함수를 걷었다 · #4791) 잠금 다툼이 아니다 — 줄을 다시 잡는다(격리 리뷰).
    //   앱을 지워서 사라졌으면(removeServer) 되살리지 않는다 — 다시 만든 함수는 고아 쓸기가 걷을 것뿐이다(재검토).
    if (!(await st.getServerRow(i.app.id))) {
      if (!(await getApp(i.app.id))) throw new HttpError(404, `앱 없음: ${i.app.id} — 배포를 기다리는 사이 지워졌습니다`);
      await claimRow(); continue;
    }
    if (n < lockTries - 1) await sleep(deps.pollMs ?? 2000);   // 마지막 시도 뒤엔 기다리지 않는다
  }
  if (!locked) throw new HttpError(409, lockedMsg);
  if (i.expect) {
    //  아래 try 밖이라 finally 가 잠금을 안 푼다 — 다시 읽기가 실패해도 · 달라도 여기서 푼다(15분 잠금이 사람의 배포를 막지 않게 · 격리 리뷰).
    let moved: boolean;
    try {
      const now = await st.getServerRow(i.app.id);
      moved = (Object.entries(i.expect) as Array<["cur" | "pub", string | null]>).some(([a, v]) => (a === "cur" ? now?.cur_lambda_version : now?.pub_lambda_version) !== v);
    } catch (e) { await st.unlockServer(i.app.id).catch(() => { /* 저절로 풀린다 */ }); throw e; }
    if (moved) { await st.unlockServer(i.app.id).catch(() => { /* 저절로 풀린다 */ }); throw new HttpError(409, changedMsg); }
  }
  let minted: { token: string; tokenHash: string } | null = null;
  let pinned = false;
  let owned = false;   // 이 워크스페이스의 함수다(확인했거나 막 만들었다) — 도중에 실패해도 남은 판의 코드 크기를 다시 잰다(#4792)
  try {
    const row = await st.getServerRow(i.app.id);
    //  토큰은 «새 판을 고정할 때만» 새로 굽는다 — 비교(configDrift)는 토큰 값을 보지 않으니 자리만 채워 둔다.
    //  #4486 함수 시간 = 작업 시간(job_timeout_s · 15분) — 사람 요청은 검사 층이 timeout_s 에서 끊는다(requestTimeoutS). 크기는 그 판의 선언.
    const rt = { tenantId: appSqlTenantId(), slug, apiUrl, identityPubkeys, token: "(rotating)", requestTimeoutS: i.policy.timeout_s };
    const manifest = i.manifest !== undefined ? i.manifest
      : i.versionNo != null ? (await getAppVersionBundle(i.app.id, i.versionNo).catch(() => null))?.manifest ?? null : null;
    const sizing = functionSizingFor(manifest, i.policy);
    const want = {
      role: env.execRoleArn, handler: LAMBDA_HANDLER, runtime: env.runtime, memory: sizing.memory, timeout: i.policy.job_timeout_s, tmp: sizing.tmp,
      layers: [env.layerArn, guardLayerArn], vars: lambdaEnvFor(i.app.id, rt),
    };
    //  #4801 코드 자리 — REFERENCE(기본)면 Lambda 가 복사하지 않고 이 zip 의 이 판을 바로 읽는다(계정 코드 저장을 안 쓴다).
    const code = functionCodeFor(env, bucket, i.zipKey, i.zipVersion);
    //  cur 가 이미 같은 빌드의 함수 판을 가리키면 그 판을 그대로 쓴다(공개하기 · 되돌리기 직후) — 단 그 판의 설정(메모리 · 시간 · 레이어 · 역할 · 환경)이
    //   지금 바라는 값과 같을 때만. 다르면(관리자가 상한을 바꿈 · 어댑터 판을 올림) 아래에서 설정을 고쳐 새 판을 고정한다(«다음 배포부터» — 격리 리뷰).
    //   그 판의 토큰 지문도 이어받는다(없으면 — v2-5 의 판 — 쓰지 않는다: 그 판엔 토큰도 검사 층도 없어 설정 비교에서 이미 걸린다).
    //   #4801 그 판이 읽는 코드 자리도 지금 빌드의 것(저장 방식 · 판 번호)이어야 한다 — 같은 지문을 다시 빌드해 zip 판이 바뀌었으면 옛 판을 읽는 함수 판은
    //   그 옛 판이 버킷 수명 규칙으로 사라질 때 멈춘다. COPY 로 만든 옛 함수 판도 여기서 REFERENCE 판으로 갈아탄다.
    //   Inactive 인 판도 재사용하지 않는다 — 별칭만 옮기면 멈춘 판에 그대로 묶인다. 아래 길이 코드를 다시 올려 되살린다(격리 리뷰).
    //   #4887 코드를 못 읽는 판(GetFunction Code.Error · Failed)도 — 아래 길은 토큰을 새로 구워 늘 새 판을 고정하니, 같은 zip 판이어도 새로 읽는다.
    //    재사용하면 공개하기 · 상태 점검이 망가진 판에 별칭을 묶는다(점검이 cur 의 망가진 판을 «다시 올려» 도 같은 판이 돌아오던 까닭).
    let reuse = row && row.cur_build_key === i.buildKey && row.cur_lambda_version && row.cur_token_hash ? row.cur_lambda_version : null;
    if (reuse) {
      const vg = await api.getFunction(fn, reuse);
      if (!vg || Object.keys(configDrift(vg.Configuration, want)).length || !codeAt(vg.Code, code) || vg.Configuration.State === "Inactive"
        || vg.Configuration.State === "Failed" || codeErrorOf(vg.Code)) reuse = null;
    }
    let version: string;
    let tokenHash: string | null;
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
      tokenHash = row!.cur_token_hash ?? null;
    } else {
      let got = await api.getFunction(fn);
      //  이름이 겹친 남의 워크스페이스 함수면 무엇을 재거나 고치기 전에 멈춘다(아래 만든 뒤의 확인과 같은 판정).
      if (got && got.Tags?.["lvly:tenant"] !== blobTenant()) {
        await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
        throw new HttpError(409, foreignMsg(fn));
      }
      //  #4801 잠금 안에서 zip 을 한 번 더 본다 — 잠금 밖에서 본 뒤(usableBuild) 옛 빌드 정리가 그 zip 을 지웠으면(지움 표시) 못 박을 판이 «옛 판» 이 된다.
      //   Lambda 는 옛 판도 읽어 배포는 초록인데, 그 판은 버킷 수명 규칙으로 30일 뒤 사라져 함수가 그때 멈춘다(조용한 성공 · 격리 리뷰). 정리는 이 잠금을
      //   잡아야 지우므로(app-server-watch pruneServerBuilds) 여기서 본 판은 이 배포가 끝날 때까지 지금 판으로 남는다 — 고를 때 함수 줄이 없던 후보만
      //   잠금 없이 지우되 지우기 직전 줄을 다시 본다(그쪽 주석 · 재검토).
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
      //  #4486 열린 백그라운드 작업이 붙잡은 판도 정리에서 빠지니 남는 쪽에 센다.
      const jobPins = await openJobPins(i.app.id).catch(() => ({ versions: [] as string[], tokens: [] as string[] }));
      const after = codeBytesAfterDeploy(vers, i.zipBytes, i.policy.keep_versions, [...(i.aliases.includes("pub") ? [] : [row?.pub_lambda_version]), ...jobPins.versions]);
      //   판정과 자리 잡기를 함수 수와 같은 워크스페이스 자문 락 안에서 — 같은 때 다른 앱을 올리는 배포가 이 몫을 센다(격리 리뷰).
      const full = await st.reserveServerCode(i.app.id, i.policy, codeBytesOf(vers), after);
      if (full) {
        //  함수가 아직 없는 앱이면 방금 잡은 줄을 지운다 — 남으면 함수 수 상한의 한 칸을 빈 줄이 차지한다.
        if (!got) await st.deleteServerRowIfUnused(i.app.id).catch(() => { /* 다음에 */ });
        throw new HttpError(409, full);
      }
      //  #4485 이 판에 구울 앱 서버 토큰 — 상한을 다 본 뒤에 굽는다(어느 별칭에도 못 올리면 아래 catch 가 회수한다).
      minted = await (deps.mintFunctionToken ?? ((id) => mintAppServerFunctionToken(id, "app-server-deploy")))(i.app.id);
      tokenHash = minted.tokenHash;
      want.vars = lambdaEnvFor(i.app.id, { ...rt, token: minted.token });
      await ensureLogs();
      if (!got) {
        //  실행 역할을 막 만든 직후(인프라 적용 직후)엔 Lambda 가 그 역할을 아직 못 맡는다는 오류가 잠깐 난다 — 몇 번 다시 한다.
        for (let n = 0; ; n++) {
          try {
            await api.createFunction({
              FunctionName: fn, Runtime: env.runtime, Role: env.execRoleArn, Handler: LAMBDA_HANDLER,
              Code: code, Architectures: [env.arch], MemorySize: want.memory, Timeout: want.timeout, EphemeralStorage: { Size: want.tmp },
              Layers: [...want.layers], Environment: { Variables: want.vars },
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
      //   지난 고치기가 실패한 채(LastUpdateStatus Failed)여도 다시 올린다 — 그때 보이는 코드 · 설정이 실제로 도는 것과 같은지 재 보지 않았으니
      //   «모름» 으로 보고 이번 배포 자신의 고치기 결과로 정한다. 바로 읽기는 복사가 없어 싸고, 다시 실패하면 아래 기다림이 진짜 까닭을 502 로 보인다.
      //   안 올리면 그 표시에 막혀 그 전 판으로 되돌리기 · 설정만 고치기가 영영 502 였다(#4484 부터 · 재검토).
      if (got.Configuration.CodeSha256 !== i.zipSha256 || !codeAt(got.Code, code) || got.Configuration.State === "Inactive"
        || got.Configuration.LastUpdateStatus === "Failed") {
        await waitReady(api, fn, deps, { beforeUpdate: true });
        await api.updateFunctionCode(fn, code);
      }
      const cfg = await waitReady(api, fn, deps);
      if (cfg.CodeSha256 !== i.zipSha256) {
        //  zip 의 바이트가 빌드 기록과 다르다 — 그 빌드를 못 쓰게 적어 두면 다음 배포가 다시 빌드한다(같은 줄을 «재사용» 하며 영영 실패하지 않게).
        await st.invalidateServerBuild(i.app.id, i.buildKey, "함수에 올라간 코드가 빌드 기록의 지문과 다릅니다").catch(() => { /* 다음에 */ });
        throw new HttpError(409, "함수에 올라간 코드가 빌드 기록과 다릅니다 — 다시 하면 새로 빌드합니다");
      }
      const drift = configDrift(cfg, want, { exact: true });
      if (Object.keys(drift).length) { await api.updateFunctionConfiguration(fn, drift); await waitReady(api, fn, deps); }
      const pub = await api.publishVersion(fn, { CodeSha256: i.zipSha256, Description: `v${i.versionNo ?? "?"} build ${i.buildKey.slice(0, 12)}`.slice(0, 256) });
      if (!pub.Version || pub.Version === "$LATEST") throw new HttpError(502, "함수 판을 고정하지 못했습니다");
      version = pub.Version;
      if (row?.stopped_at) {
        smoke = { skipped: "멈춘 앱이라 시험 호출을 건너뜀" };
      } else {
        //  #4485 — 검사 층의 준비 판정 주소를 부른다(신원 없이 앱에 닿는 길은 없다). 웹 어댑터는 앱 포트가 열린 뒤에야 넘기므로
        //   200 + x-lively-guard: ready 면 «검사 층이 앞에 섰고 앱도 떴다». 앱이 못 뜨면(포트 · 시작 실패) 종전처럼 Lambda 오류로 온다.
        const t0 = Date.now();
        const out = await api.invokeStream(fn, version, JSON.stringify(smokeEvent("lively-deploy-check.invalid", Date.now(), GUARD_READY_PATH)), { timeoutMs: 60_000, logTail: true });
        const got = await collectHttpStream(out, 16 * 1024);
        const log = got.complete?.log ?? "";
        if (got.kind === "error") {
          const le = lambdaErrorOf(got.payload);
          throw new DeployError(422, smokeFailure("Unhandled", JSON.stringify({ errorType: le.type ?? "Unknown" }), log) ?? "서버를 부르다 실패했습니다", "smoke", tailText(log, 4000));
        }
        if (got.prelude.headers[GUARD_HEADER] !== "ready") {
          throw new DeployError(422, `신원 검사 층이 응답하지 않았습니다(상태 ${got.prelude.statusCode}) — 함수에 검사 층 레이어가 빠졌거나 설정이 다릅니다`, "smoke", tailText(log, 4000));
        }
        smoke = { http_status: got.prelude.statusCode, ms: Date.now() - t0 };
      }
    }
    for (const a of i.aliases) {
      await api.putAlias(fn, a, version, `v${i.versionNo ?? "?"} build ${i.buildKey.slice(0, 12)}`.slice(0, 256));
      //  #4486 검사 층 판 — 재사용 판도 지금 설정(레이어 = 이 코어의 검사 층 지문)과 같을 때만 쓰므로 늘 이 판이다.
      await st.setServerAlias(i.app.id, a, { version_no: i.versionNo, build_key: i.buildKey, lambda_version: version, token_hash: tokenHash, guard: GUARD_VERSION });
      pinned = true;
    }
    //  별칭을 옮기면 마지막 오류가 지워진다 — 로그 그룹을 못 맞춘 것은 그 뒤에 적어 상태에서도 보이게(다음에 맞추면 다시 지워진다).
    if (logsWarning) await st.setServerError(i.app.id, logsWarningText(logsWarning)).catch(() => { /* 결과에 있다 */ });
    //  어느 별칭도 안 가리키게 된 판의 토큰 회수(#4485) — 실패해도 배포는 됐다(다음 배포가 다시 거둔다).
    //  #4486 열린 백그라운드 작업이 도는(돌) 판의 토큰은 회수 함수가 스스로 남긴다(작업을 못 읽으면 아무것도 거두지 않고 던진다).
    const after = await st.getServerRow(i.app.id);
    await (deps.revokeFunctionTokens ?? revokeStaleFunctionTokens)(i.app.id, [after?.cur_token_hash, after?.pub_token_hash])
      .catch((err) => logger.warn({ err: String((err as Error)?.message ?? err), app: i.app.id }, "옛 앱 서버 토큰 회수 실패(비치명 — 다음 배포에서)"));
    await pruneVersions(api, fn, i.app.id, i.policy.keep_versions).catch((err) => logger.warn({ err, fn }, "옛 함수 판 정리 실패(비치명)"));
    return { function_name: fn, aliases: i.aliases, lambda_version: version, build_key: i.buildKey, smoke, ...(logsWarning ? { logs_warning: logsWarning } : {}),
      ...(sizing.notes.length ? { sizing_notes: sizing.notes } : {}) };
  } catch (e) {
    //  #4485 — 새로 구운 토큰을 어느 별칭에도 못 올렸으면 회수한다(그 판은 쓰이지 않는다).
    if (minted && !pinned) {
      const keep = await st.getServerRow(i.app.id).then((r) => [r?.cur_token_hash, r?.pub_token_hash]).catch(() => null);
      //  #4486 열린 작업이 붙잡은 옛 판의 토큰은 회수 함수가 남긴다(이 길에서도 — 격리 리뷰).
      if (keep) await (deps.revokeFunctionTokens ?? revokeStaleFunctionTokens)(i.app.id, keep)
        .catch((err) => logger.warn({ err: String((err as Error)?.message ?? err), app: i.app.id }, "못 쓴 새 토큰 회수 실패(비치명 — 다음 배포에서)"));
    }
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
    //  구성원이 보는 마지막 오류(app_server_status) — 배포 길이 일부러 던진 글(HttpError) · 걷은 AWS 글만 그대로 싣고, 저장소 · 내부 오류는 나눈 글만(원문은 기록에).
    //   #4887 하우스키핑이 사람 없이 이 길을 타게 되어 «상태에 원문을 싣지 않는다» 를 여기서도 지킨다(격리 리뷰). 던지는 오류는 그대로다.
    const shown = e instanceof HttpError || e instanceof AwsError ? msg
      : e instanceof S3Error ? `저장소 조회 실패(${e.code})로 배포하지 못했습니다` : "내부 오류로 배포하지 못했습니다(게이트웨이 기록 참고)";
    if (!(e instanceof HttpError) && !(e instanceof AwsError)) logger.warn({ err: e, app: i.app.id, fn }, "앱 서버 배포 내부 오류(#4887)");
    await st.setServerError(i.app.id, shown).catch(() => { /* 기록 실패는 원래 오류를 덮지 않는다 */ });
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
  //  #4486 열린 백그라운드 작업이 돌(도는) 판도 남긴다 — 못 읽으면 이번엔 정리하지 않는다(작업 도중 판이 사라지지 않게).
  const jobs = await openJobPins(appId);
  const pinned = new Set([row?.cur_lambda_version, row?.pub_lambda_version, ...jobs.versions].filter((v): v is string => !!v));
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

export interface InstalledTarget { app: OrgApp; decl: AppServerDecl; versionNo: number; savedBy: string | null; bundle: ReturnType<typeof versionBundle>; manifest?: unknown }

/** 이 앱의 지금 판과 그 서버 선언 — 서버 앱이 아니면 null. 판 묶음이 아직 안 옮겨졌으면 409. */
export async function installedTarget(app: OrgApp): Promise<InstalledTarget | null> {
  const decl = serverDeclOf(app.manifest);
  if (!decl) return null;
  if (app.current_version_no == null) throw new HttpError(409, `「${app.title || app.id}」 은(는) 아직 저장된 판이 없습니다 — 먼저 app_save 로 저장하세요`);
  const v = await getAppVersionBundle(app.id, app.current_version_no);
  if (!v) throw new HttpError(409, `「${app.title || app.id}」 의 ${app.current_version_no}판 기록이 없습니다`);
  const vb = versionBundle(v);
  if (!vb) throw new HttpError(409, `「${app.title || app.id}」 의 ${app.current_version_no}판은 아직 파일 목록으로 옮겨지지 않았습니다 — 다시 저장(app_save)하거나 잠시 뒤 하세요`);
  return { app, decl: serverDeclOf(v.manifest) ?? decl, versionNo: app.current_version_no, savedBy: v.saved_by ?? null, bundle: vb, manifest: v.manifest };
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
/**
 *  by — 이 배포를 부른 구성원(빌드 기록의 built_by). 로컬 실행면(#4487)은 자격 없는 일회용 컨테이너에서 빌드하므로 «저장한 사람의 세션» 이 필요 없다(seat 없이 빌드).
 */
export async function deployInstalled(t: InstalledTarget, seat: BuildSeat | null, policy: AppServerPolicy, deps0: ServerDeps = {}, opts: { by?: string } = {}): Promise<DeployOutcome> {
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
  if (!have && !seat && env.host !== "local") {
    throw new HttpError(409, `${t.versionNo}판의 서버가 아직 빌드되지 않았습니다 — 이 판은 ${t.savedBy ?? "다른 사람"} 님이 저장해서 그 사람의 세션에서 빌드해야 합니다` +
      "(그 사람이 「이대로 넣기」 또는 app_server_deploy). 남이 저장한 코드를 내 세션에서 돌리지 않습니다");
  }
  const built = have
    ? { build: have, reused: true, key }
    : await ensureServerBuild({ appId: t.app.id, versionNo: t.versionNo, bundle: t.bundle.bundle, store: t.bundle.kind, decl: t.decl, env, policy, seat, by: seat?.memberId ?? opts.by ?? t.savedBy ?? "app-server" }, deps);
  const b = built.build;
  const detail = (b.detail ?? {}) as { ms?: number; mem?: unknown; warnings?: unknown };
  const buildView = { key, status: b.status, reused: built.reused, stage: b.stage, error: b.error, log_tail: b.status === "failed" ? b.log_tail : null, ms: detail.ms ?? null, mem: detail.mem ?? null, warnings: detail.warnings ?? [] };
  if (b.status !== "ok" || !b.zip_key || !b.zip_sha256) {
    return { ok: false, app_id: t.app.id, version_no: t.versionNo, build: buildView, error: b.error ?? "빌드가 실패했습니다", stage: b.stage ?? "build", log: b.log_tail };
  }
  const aliases: Array<"cur" | "pub"> = installedIsPublished(t.app) ? ["cur", "pub"] : ["cur"];
  try {
    const deploy = await deployBuildToAliases({ app: t.app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases, policy, manifest: t.manifest }, deps);
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
  const w = [...(d.logs_warning ? [logsWarningText(d.logs_warning)] : []), ...(d.sizing_notes ?? [])];
  return w.length ? { warnings: w } : {};
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
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases: ["cur", "pub"], policy, manifest: t.manifest }, deps);
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
    const deploy = await deployBuildToAliases({ app, versionNo: t.versionNo, buildKey: key, zipKey: b.zip_key, zipSha256: b.zip_sha256, zipBytes: Number(b.zip_bytes ?? 0), zipVersion: b.zip_version ?? null, aliases: installedIsPublished(app) ? ["cur", "pub"] : ["cur"], policy, manifest: t.manifest }, deps);
    return { ok: true, state: "deployed", deploy, ...deployWarnings(deploy) };
  } catch (e) {
    logger.warn({ err: e, app: app.id }, "되돌린 뒤 앱 서버 옮기기 실패(#4484)");
    return { ok: false, state: "failed", message: `서버를 되돌린 판으로 옮기지 못했습니다: ${publicError(e)}` };
  }
}

// 앱 서버 실행면(#4487 앱 v2-8) — 앱 서버 함수를 어디서 돌리나. 배포 · 부르기 · 멈춤 · 지우기 · 정리 · 상태 점검은 실행면을 아래 두 겉면으로만 본다.
//
//  · 함수 실행면(LambdaApi) — Lambda API 와 같은 꼴(함수 · 판 · 별칭 · 흘려 받기 · 비동기 부르기 · 동시 실행 · 로그 그룹 · 레이어).
//  · zip 저장소(ZipStore) — 빌드 결과(zip)를 두고 · 있나 보고 · 지우고 · 빌더가 올릴 주소를 준다.
//  그래서 그 흐름(잠금 · 상한 · 토큰 · 별칭 기록 · 판 정리 — app-server-deploy · lifecycle · watch · app-front-server · app-jobs)은 한 벌이고,
//  실행면마다 다른 것은 이 두 겉면의 구현뿐이다.
//
//  실행면(env LIVELY_APP_SERVER_HOST · 비면 lambda):
//   · lambda — AWS Lambda 함수(앱 × 워크스페이스) · 별칭 cur · pub · 판 묶음 버킷(S3)의 zip(#4484 · #4801). 매니지드.
//   · local — Lambda 가 없는 자가호스팅 박스. 같은 zip 을 이 박스의 Docker 컨테이너(앱 × 판)로 돌린다(결정 #5052 — 다음 단계에서 들어온다).
//   LIVELY_APP_SERVER_RUNTIME 은 이미 Lambda 런타임 이름(app-server-config)이라 실행면 이름으로 쓰지 않는다.
import { HttpError } from "../http-error.js";
import * as lam from "../net/aws/lambda-lite.js";
import { s3Delete, s3Head, s3PresignUrl, type S3Config, type S3Deps } from "../net/aws/s3-lite.js";
import { resolveGatewayBaseCredsWithin } from "../net/aws/aws-broker.js";
import { appBundleS3Config } from "./app-blob-store.js";
import { appServerHostKind, appServerHostUnavailable, type AppServerHostKind } from "./app-server-config.js";

/**
 * 함수 실행면 — Lambda API 와 같은 꼴. 시험이 갈아 끼운다(setServerDepsForTest api). 실행면마다 구현이 하나씩이다(lambda = lambda-lite).
 *  흐름이 기대는 것: 만든 함수는 판을 고정할 때까지 $LATEST · 판은 바뀌지 않는다 · 별칭은 판을 가리킨다 · 동시 실행 0 이면 부르기가 곧바로 거절된다 ·
 *  흘려 받기는 «HTTP 통합 응답» 틀(app-server-stream) · 비동기 부르기는 받아 두기만 한다(결과는 함수 안 검사 층이 게이트웨이에 보고한다).
 */
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
  /** #4485 흘려 받기 — 시험 호출 · 앱 주소 요청이 쓴다(함수가 응답 흘려 보내기 모드라 보통 부르기로는 틀이 섞여 온다). */
  invokeStream(name: string, qualifier: string, payloadJson: string, opts: { timeoutMs: number; logTail?: boolean; signal?: AbortSignal }): Promise<lam.StreamInvokeOut>;
  /** #4486 비동기로 부르기(백그라운드 작업) — 202 면 Lambda 가 받아 두었다. */
  invokeAsync(name: string, qualifier: string, payload: unknown): Promise<{ status: number; requestId: string | null }>;
  listLayerVersions(layer: string): Promise<lam.LayerVersion[]>;
  publishLayerVersion(layer: string, input: { zip: Buffer; description: string; architectures: string[] }): Promise<lam.LayerVersion>;
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
    invokeStream: (n, q, p, o) => lam.invokeStream(c, n, q, p, o),
    invokeAsync: (n, q, p) => lam.invokeAsync(c, n, q, p),
    listLayerVersions: (l) => lam.listLayerVersions(c, l),
    publishLayerVersion: (l, i) => lam.publishLayerVersion(c, l, i),
    deleteFunction: (n, q) => lam.deleteFunction(c, n, q),
    putConcurrency: (n, k) => lam.putConcurrency(c, n, k),
    deleteConcurrency: (n) => lam.deleteConcurrency(c, n),
    ensureLogGroup: (g, d, tag) => lam.ensureLogGroup(c, g, d, tag),
    deleteLogGroup: (g) => lam.deleteLogGroup(c, g),
  };
}

/** 이 실행면의 함수 실행면 — 흐름은 늘 이것으로 부른다(시험 고리 deps.api 가 있으면 그것이 먼저다). */
export function appServerApi(env: { host: AppServerHostKind; region: string }): LambdaApi {
  if (env.host === "lambda") return realLambdaApi(env.region);
  throw new HttpError(503, appServerHostUnavailable({ LIVELY_APP_SERVER_HOST: env.host }) ?? "앱 서버 실행면이 없습니다");
}

// ── zip 저장소 ───────────────────────────────────────────────────────────────────────────

/** 저장소 한 번 부르기의 조절 — 잠근 채 부르는 자리는 한 번 · 짧게(s3-lite «잠근 채 부르는 일은 attempts:1» 관례). 안 주면 저장소 기본. */
export interface ZipCallOpts { attempts?: number; timeoutMs?: number }

export interface ZipStore {
  /** 함수 코드 자리(FnCode.S3Bucket)에 적는 이름 — S3 는 판 묶음 버킷. */
  readonly bucket: string;
  /** zip 키 앞자리(app-server-config zipKeyFor 의 prefix · 끝에 / 하나 또는 빈 글). */
  readonly prefix: string;
  /** 있나 · 크기 · 지금 판 번호. versionId 를 주면 그 판이 아직 있나(#4887 — 지운 판 · 지움 표시 판은 null). */
  head(key: string, o?: ZipCallOpts & { versionId?: string }): Promise<{ size: number; versionId?: string | null } | null>;
  remove(key: string): Promise<void>;
  /** 빌더가 zip 을 올릴 주소(PUT) — expiresSec 까지 쓸 수 있다. */
  uploadUrl(key: string, expiresSec: number): Promise<string>;
}

/** S3 판 묶음 버킷(#4481 · #4484). base — 시험이 끼우는 자격 · fetch(운영은 비어 있다 · 게이트웨이 자격). */
export function s3ZipStore(cfg: S3Config & { prefix: string }, base: S3Deps = {}): ZipStore {
  const depsOf = (o?: ZipCallOpts): S3Deps => ({
    ...base, ...(o?.attempts !== undefined ? { attempts: o.attempts } : {}), ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  });
  return {
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    head: (key, o) => s3Head(cfg, key, depsOf(o), o?.versionId ? { versionId: o.versionId } : undefined),
    remove: (key) => s3Delete(cfg, key, { ...base, attempts: 1, timeoutMs: 10_000 }),
    uploadUrl: async (key, expiresSec) => {
      const got = await resolveGatewayBaseCredsWithin(expiresSec * 1000);
      if (!got) throw new HttpError(503, "S3 자격이 없어 빌드 결과를 올릴 주소를 만들지 못했습니다");
      //  자격이 먼저 끝나면 주소도 그때 죽는다 — 그 시각까지로 줄인다(빌더가 받은 주소로 403 을 보며 헤매지 않게 · 그래도 1분은 둔다).
      const left = got.expiresAtMs ? Math.floor((got.expiresAtMs - Date.now()) / 1000) - 30 : expiresSec;
      return s3PresignUrl(cfg, key, { method: "PUT", expiresSec: Math.max(60, Math.min(expiresSec, left)), creds: got.creds, now: new Date() });
    },
  };
}

/** 이 배포의 zip 저장소 — lambda 실행면은 판 묶음 버킷(없으면 null — 배포가 «버킷 없음» 을 말한다). */
export function appServerZipStore(env: NodeJS.ProcessEnv = process.env): ZipStore | null {
  if (appServerHostKind(env) !== "lambda") return null;
  const s3 = appBundleS3Config(env);
  return s3 ? s3ZipStore(s3) : null;
}

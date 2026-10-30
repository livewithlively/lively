// 앱 서버(#4484 앱 v2-5) — 배포 설정 · 함수 이름 · 서버 선언 · 빌드 지문 · 함수 환경. 전부 순수(판정만).
//
//  설계: 지식 app-framework-v2-general-web-design §3-C · §12 ③ · §17(결정 상민 2026-10-15).
//   앱은 매니페스트 최상위 `web.server` 로 서버가 있다고 알린다(`web` 은 passthrough — 옛 코어로 되돌려도 매니페스트를 읽는다, #4481).
//    {"web": {"server": {"start": "node server.js", "build": "npm run build"}}} — 둘 다 생략하면 package.json 의 scripts.start · scripts.build.
//    "dir" — 빌드가 자기 완결 출력 폴더를 만들면 그 폴더만 올린다(예 Next.js output:'standalone' → ".next/standalone"). 기본 Next.js 앱은
//     풀린 크기가 449MB 라 Lambda 250MB 를 넘는다(2026-10-15 실측 — next 131MB · swc 두 벌 259MB). 비거나 '.' 이면 앱 폴더 전체.
//   함수는 앱 × 워크스페이스마다 하나(`<접두>-<앱>-<워크스페이스 슬러그>`) · 별칭 둘(cur = 고친 사람이 보는 판(초안 주소) · pub = 공개 판).
//   같은 코드는 다시 빌드하지 않는다 — 빌드 지문 = 매니페스트를 뺀 파일 목록 + 서버 선언 + 빌더 판 + 런타임. 이름·설명만 바꾼 판 ·
//    되돌리기 · 공개하기는 그 지문의 zip 을 그대로 쓴다(설계 §3-C «판 되돌리기·판 복사는 그 판의 zip 을 다시 쓰므로 빌드가 필요 없다»).
import crypto from "node:crypto";
import type { AppBundle } from "./app-bundle.js";
import { BUILDER_VERSION, ZIP_EXCLUDE, RUN_SCRIPT } from "./app-server-builder.js";
import { APP_PORT, GUARD_BOOTSTRAP_PATH, GUARD_PORT, GUARD_READY_PATH } from "./app-server-guard.js";
import { currentTenant } from "../org/tenant-context.js";
import type { FnCode, FnCodeLocation, LogGroupTag } from "../net/aws/lambda-lite.js";

/**
 * 앱이 선언한 서버 — start/build 가 null 이면 package.json 의 scripts 를 쓴다 · dir 이 null 이면 앱 폴더 전체를 올린다.
 *  memory_mb · tmp_mb(#4486 앱 v2-7 · 결정 상민 2026-10-20) — 함수 메모리 · 임시 디스크(/tmp). null 이면 워크스페이스 기본(app_server_policy.memory_mb · 512MB).
 *   요청과 백그라운드 작업이 같은 함수라 같은 값을 쓴다(함수 하나). 빌드 지문에는 넣지 않는다 — 설정만 바뀌므로 다시 빌드하지 않는다.
 */
export interface AppServerDecl { start: string | null; build: string | null; dir: string | null; memory_mb?: number | null; tmp_mb?: number | null }

const cmd = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= 2000 && !s.includes("\0") ? s : null;
};

/** 매니페스트 → 서버 선언(없으면 null). `web.server` 가 객체이거나 true 면 서버 앱이다. */
export function serverDeclOf(manifest: unknown): AppServerDecl | null {
  const s = (manifest as { web?: { server?: unknown } } | null)?.web?.server;
  if (s === true) return { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null };
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  return { start: cmd(o.start), build: cmd(o.build), dir: dirOf(o.dir), memory_mb: mbOf(o.memory_mb, 128, 10_240), tmp_mb: mbOf(o.tmp_mb, 512, 10_240) };
}

/** 메모리 · 임시 디스크 선언(MB) — 정수가 아니거나 Lambda 범위 밖이면 null(= 기본값 · 배포가 «선언을 읽지 못함» 을 알린다). */
const mbOf = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * 함수 크기(#4486) — 메모리는 앱 선언(없으면 워크스페이스 기본 memory_mb)을 워크스페이스 천장(memory_max_mb)까지, 임시 디스크는 앱 선언(없으면 512MB).
 *  선언을 줄였거나 못 읽었으면 notes 에 사람 말로(배포 결과 warnings).
 */
export function functionSizingFor(manifest: unknown, policy: { memory_mb: number; memory_max_mb: number }): { memory: number; tmp: number; notes: string[] } {
  const raw = (manifest as { web?: { server?: unknown } } | null)?.web?.server;
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const decl = serverDeclOf(manifest);
  const notes: string[] = [];
  if (o.memory_mb !== undefined && decl?.memory_mb == null) notes.push("web.server.memory_mb 를 읽지 못해 기본 메모리로 올렸습니다(128~10240 사이 정수 · MB)");
  if (o.tmp_mb !== undefined && decl?.tmp_mb == null) notes.push("web.server.tmp_mb 를 읽지 못해 기본 임시 디스크(512MB)로 올렸습니다(512~10240 사이 정수 · MB)");
  let memory = decl?.memory_mb ?? policy.memory_mb;
  if (memory > policy.memory_max_mb) {
    notes.push(`메모리 ${memory}MB 를 이 워크스페이스의 천장 ${policy.memory_max_mb}MB 로 줄였습니다(관리자 app_server_limits_set memory_max_mb)`);
    memory = policy.memory_max_mb;
  }
  return { memory, tmp: decl?.tmp_mb ?? 512, notes };
}

/** 올릴 폴더 — 다듬기만 한다(경로 모양 검사는 빌더가 빌드 전에 한다 · 틀리면 빌드가 «dir» 로 실패해 까닭을 말한다). '.' · './' 는 전체(null). */
const dirOf = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\/+$/, "");
  return !s || s === "." || s.length > 200 ? null : s;
};

/**
 * 앱 서버 실행면(#4487 앱 v2-8 · app-server-host) — lambda(매니지드 · AWS Lambda) · local(자가호스팅 박스의 Docker 컨테이너 — 다음 단계).
 *  env LIVELY_APP_SERVER_HOST · 비면 lambda · 모르는 이름이면 null(앱 서버를 켜지 않는다 — 글자를 틀렸는데 조용히 Lambda 로 가지 않게).
 *  LIVELY_APP_SERVER_RUNTIME 은 이미 Lambda 런타임 이름(아래 appServerEnv)이라 실행면 이름으로 쓰지 않는다.
 */
export type AppServerHostKind = "lambda" | "local";
export function appServerHostKind(env: NodeJS.ProcessEnv = process.env): AppServerHostKind | null {
  const raw = String(env.LIVELY_APP_SERVER_HOST ?? "").trim().toLowerCase();
  if (!raw || raw === "lambda") return "lambda";
  if (raw === "local") return "local";
  return null;
}
/** 실행면을 못 켜는 까닭(사람에게 그대로) — 켤 수 있으면 null. */
export function appServerHostUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  const kind = appServerHostKind(env);
  if (!kind) return `앱 서버 실행면 이름(LIVELY_APP_SERVER_HOST=${String(env.LIVELY_APP_SERVER_HOST ?? "").trim().slice(0, 40)})을 모릅니다 — lambda 또는 local 입니다`;
  return null;
}

/** 배포 설정(env) — 매니지드(lambda)는 실행 역할이 없으면 null(= 이 배포는 앱 서버를 돌리지 않는다) · 자가호스팅(local)은 실행 역할 없이 켜진다(#4487). */
export interface AppServerEnv {
  /** 실행면(#4487) — 흐름은 이 값으로 함수 실행면 · zip 저장소를 고른다(app-server-host appServerApi). */
  host: AppServerHostKind;
  region: string;
  /** 함수 실행 역할(lively-infra app-servers.tf lvly-app-exec) — 제 함수의 로그 그룹에만 쓰기(#4790). */
  execRoleArn: string;
  /** AWS 계정 번호(12자리) — 실행 역할 ARN 에서 읽는다(로그 그룹 ARN 을 지을 때 · #4790 태그 달기). 구독 «계정»(v2-9)과 다른 말이다. */
  awsAccountId: string;
  /** Lambda Web Adapter 레이어(arm64) 판 ARN. */
  layerArn: string;
  /** 함수 이름 앞자리 — IAM 정책이 lvly-app-* 만 허락한다. 한 계정을 여러 배포가 나눠 쓰면 배포마다 다르게(예 lvly-app-dev-). */
  prefix: string;
  runtime: string;
  /** Lambda 는 늘 arm64 · 로컬(#4487)은 이 박스의 Docker 와 같은 아키텍처(빌드한 네이티브 모듈이 맞게 — 빌드 지문에 들어간다). */
  arch: "arm64" | "x86_64";
  /**
   * 함수 코드를 어디에 두나(#4801 · env LIVELY_APP_SERVER_CODE_STORAGE) — REFERENCE(기본) = Lambda 가 우리 판 묶음 버킷의 zip 을 그 판 번호로 바로 읽는다
   *  (계정 코드 저장 300GiB 를 쓰지 않는다) · COPY = Lambda 가 제 저장소로 복사한다(#4484 방식). REFERENCE 는 인프라(lively-infra app-bundles.tf 버킷 정책 ·
   *  app-servers.tf 박스 역할 GetObjectVersion)가 먼저 깔려 있어야 한다 — 없으면 함수 만들기 · 코드 고치기가 곧바로 거절된다. COPY 는 그 정책이 없는
   *  다른 배포(자기 버킷)를 위한 길이다.
   */
  codeStorage: "REFERENCE" | "COPY";
}

export const DEFAULT_ADAPTER_LAYER_VERSION = 30;   // LambdaAdapterLayerArm64:30 = Lambda Web Adapter 1.1.0(2026-09-18) · 서울 실측 2026-10-15
export const DEFAULT_RUNTIME = "nodejs22.x";        // 세션 이미지(node:22-bookworm-slim)와 같은 큰 판 — 빌드한 네이티브 모듈이 맞게
const PREFIX_RE = /^lvly-app-([a-z0-9]{1,8}-)?$/;
const ROLE_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]{1,64}$/;   // 1 = 계정 번호
const LAYER_RE = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:layer:[A-Za-z0-9_-]+:\d+$/;

/**
 * 워크스페이스 단위 스위치(앱 주소 #4480 과 같은 켜는 순서) — env `LIVELY_APP_SERVER_TENANTS`(쉼표로 가른 슬러그)에 든 워크스페이스만 앱 서버를 켠다.
 *  비거나 `*` 면 전부. 매니지드는 게이트웨이 하나가 모든 워크스페이스를 받아서, 실행 역할 한 줄로는 «우리 워크스페이스에서 먼저 실측 → 전체» 로
 *  나눠 켤 수 없다 — 그 사이를 이 목록이 맡는다(CP cp.env `LVLY_APP_SERVER_TENANTS` → lvly-gw.sh). 목록이 있는데 워크스페이스를 모르면 끈다.
 */
export function appServerEnabledFor(slug: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.LIVELY_APP_SERVER_TENANTS ?? "").trim().toLowerCase();
  if (!raw || raw === "*") return true;
  const s = String(slug ?? "").trim().toLowerCase();
  if (!s) return false;
  return raw.split(",").map((x) => x.trim()).filter(Boolean).includes(s);
}

/** 이 요청(워크스페이스)의 앱 서버 설정 — 실행 역할이 없거나 · 모양이 틀렸거나 · 워크스페이스 스위치 밖이면 null(= 앱 서버 꺼짐). */
export function appServerEnv(env: NodeJS.ProcessEnv = process.env, slug: string | null | undefined = currentTenant()?.slug): AppServerEnv | null {
  //  #4487 실행면 — 모르는 이름은 끈다(까닭은 appServerHostUnavailable) · local 은 이 박스의 Docker(app-server-local).
  const kind = appServerHostKind(env);
  if (!kind) return null;
  if (kind === "local") return localAppServerEnv(env, slug);
  const execRoleArn = String(env.LIVELY_APP_SERVER_EXEC_ROLE ?? "").trim();
  const role = ROLE_RE.exec(execRoleArn);
  if (!role) return null;
  if (!appServerEnabledFor(slug, env)) return null;
  const region = String(env.LIVELY_APP_SERVER_REGION ?? env.LIVELY_APP_BUNDLE_REGION ?? env.AWS_REGION ?? "").trim() || "ap-northeast-2";
  const layer = String(env.LIVELY_APP_SERVER_LAYER ?? "").trim();
  const layerArn = layer && LAYER_RE.test(layer) ? layer : `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:${DEFAULT_ADAPTER_LAYER_VERSION}`;
  const p = String(env.LIVELY_APP_SERVER_PREFIX ?? "").trim();
  const prefix = p && PREFIX_RE.test(p) ? p : "lvly-app-";
  const runtime = String(env.LIVELY_APP_SERVER_RUNTIME ?? "").trim() || DEFAULT_RUNTIME;
  //  모르는 값은 기본(REFERENCE)으로 — «copy» 라고 또렷이 적었을 때만 복사한다.
  const codeStorage = String(env.LIVELY_APP_SERVER_CODE_STORAGE ?? "").trim().toLowerCase() === "copy" ? "COPY" : "REFERENCE";
  return { host: "lambda", region, execRoleArn, awsAccountId: role[1]!, layerArn, prefix, runtime, arch: "arm64", codeStorage };
}

/**
 * 자가호스팅 박스의 설정(#4487 · LIVELY_APP_SERVER_HOST=local) — 실행 역할 · 레이어 · 계정 칸은 Lambda 꼴을 맞추는 자리 표시다(로컬 실행면은 읽지 않는다).
 *  runtime = 실행 · 빌드 이미지(env LIVELY_APP_SERVER_IMAGE · 기본 node:22-bookworm-slim — 빌드 지문에 들어가 이미지를 바꾸면 다시 빌드한다) ·
 *  arch = 이 박스의 아키텍처 · 코드 자리 = COPY(함수가 zip 을 제 폴더로 복사한다 — 판 번호가 없다). 워크스페이스 스위치(LIVELY_APP_SERVER_TENANTS)는 같다.
 */
function localAppServerEnv(env: NodeJS.ProcessEnv, slug: string | null | undefined): AppServerEnv | null {
  if (!appServerEnabledFor(slug, env)) return null;
  const p = String(env.LIVELY_APP_SERVER_PREFIX ?? "").trim();
  return {
    host: "local", region: "local", execRoleArn: "lively-local:role", awsAccountId: "000000000000", layerArn: LOCAL_ADAPTER_LAYER_ARN,
    prefix: p && PREFIX_RE.test(p) ? p : "lvly-app-",
    runtime: localImage(env),
    arch: process.arch === "arm64" ? "arm64" : "x86_64",
    codeStorage: "COPY",
  };
}
/** 로컬 실행면의 웹 어댑터 레이어 자리(app-server-local LOCAL_ADAPTER_LAYER 와 같은 값 — 마운트하지 않는다). */
export const LOCAL_ADAPTER_LAYER_ARN = "lively-local:adapter";
/** 자가호스팅 실행 · 빌드 이미지 기본값 · 이름 꼴 — 컨테이너 인자 검사기는 이 값만 허락한다(app-server-docker 정책). */
export const DEFAULT_LOCAL_IMAGE = "node:22-bookworm-slim";
export const LOCAL_IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/;
/** 실행 · 빌드 이미지(env LIVELY_APP_SERVER_IMAGE) — 꼴이 틀리면 기본값. */
export function localImage(env: NodeJS.ProcessEnv = process.env): string {
  const v = String(env.LIVELY_APP_SERVER_IMAGE ?? "").trim();
  return v && LOCAL_IMAGE_RE.test(v) ? v : DEFAULT_LOCAL_IMAGE;
}

/**
 * 함수에 줄 코드 자리(#4801) — REFERENCE 면 zip 의 판 번호까지 못 박는다(그 판을 Lambda 가 계속 읽는다 · 판 번호를 모르는 옛 빌드면 Lambda 가 지금 판으로
 *  풀어 적는다). COPY 는 #4484 그대로(판 번호 없이 — 판 번호를 주면 부르는 쪽에 GetObjectVersion 이 따로 든다).
 */
export function functionCodeFor(env: Pick<AppServerEnv, "codeStorage">, bucket: string, zipKey: string, zipVersion: string | null): FnCode {
  if (env.codeStorage === "COPY") return { S3Bucket: bucket, S3Key: zipKey };
  return { S3Bucket: bucket, S3Key: zipKey, ...(zipVersion ? { S3ObjectVersion: zipVersion } : {}), S3ObjectStorageMode: "REFERENCE" };
}

/**
 * 함수의 지금 코드($LATEST)가 바라는 자리에 이미 있나(#4801) — 같은 코드 지문이어도 저장 방식 · 객체 · 판 번호가 다르면 코드를 다시 올린다
 *  (COPY 로 만든 옛 함수를 REFERENCE 로 옮기기 · 그 반대). REFERENCE 면 GetFunction 의 Code.ResolvedS3Object 가 읽는 객체를 알려 주고,
 *  COPY 면 그 칸이 비어 있다(2026-10-16 시험). want 에 판 번호가 없으면(옛 빌드) 객체만 맞으면 된다.
 */
export function codeAt(have: FnCodeLocation | undefined, want: FnCode): boolean {
  const r = have?.ResolvedS3Object ?? null;
  if (want.S3ObjectStorageMode !== "REFERENCE") return !r;
  if (!r) return false;
  return r.S3Bucket === want.S3Bucket && r.S3Key === want.S3Key && (!want.S3ObjectVersion || r.S3ObjectVersion === want.S3ObjectVersion);
}

/**
 * 함수 이름 — `<접두><앱>-<워크스페이스 슬러그>`(앱 주소 `<앱>-<워크스페이스>.lvly.app` 와 같은 순서). 64자 · [A-Za-z0-9-_] 를 넘으면 null.
 *  앱 id `^[a-z0-9][a-z0-9-]{1,31}$` · 슬러그 ≤ 20자라 접두 lvly-app- 이면 최대 62자다. 같은 이름 두 쌍이 나오지 않는 근거는
 *  앱 주소와 같다 — CP 의 «다른 슬러그의 꼬리가 되는 슬러그 금지»(설계 §13-4). 그래도 함수에 워크스페이스 태그를 달고 고칠 때마다 확인한다.
 */
export function functionNameFor(prefix: string, appId: string, slug: string): string | null {
  const name = `${prefix}${appId}-${slug}`;
  return name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name) ? name : null;
}
export const logGroupFor = (fn: string): string => `/aws/lambda/${fn}`;

/**
 * 로그 그룹 태그(#4790 · 결정 상민 2026-10-16) — 모든 앱 함수가 실행 역할 하나를 같이 써서, 그 역할의 쓰기 권한에 «요청한 함수
 *  (lambda:SourceFunctionArn) = 그 로그 그룹 태그 lvly-fn 의 함수» 조건을 건다(lively-infra app-servers.tf WriteOwnAppLogs 의
 *  ${aws:ResourceTag/lvly-fn} — 이름을 바꾸면 둘 다). 태그가 없는 그룹엔 아무도 못 쓴다 — 그래서 배포마다 그룹에 태그를 맞춘다.
 */
export const LOG_GROUP_TAG = "lvly-fn";
export const logGroupTagsFor = (fn: string): Record<string, string> => ({ [LOG_GROUP_TAG]: fn });
/** 로그 그룹 ARN — TagResource 가 받는 꼴(끝 :* 없이 · AWS 문서 TagResource). */
export const logGroupArnFor = (env: Pick<AppServerEnv, "region" | "awsAccountId">, group: string): string => `arn:aws:logs:${env.region}:${env.awsAccountId}:log-group:${group}`;
/** 이 함수의 로그 그룹에 달 태그 묶음(태그 + 그 그룹 ARN) — 배포가 ensureLogGroup 에 넘긴다. */
export const logGroupTagBundleFor = (env: Pick<AppServerEnv, "region" | "awsAccountId">, fn: string): LogGroupTag => ({ tags: logGroupTagsFor(fn), arn: logGroupArnFor(env, logGroupFor(fn)) });

/**
 * zip 자리 — 판 묶음 버킷의 워크스페이스 앞자리 아래(판 파일 b/ 옆 z/) · **앱마다 따로**(z/<앱>/<빌드 지문>.zip).
 *  빌드 지문은 «입력» 지문이라 같은 파일을 가진 두 앱(사본 · 같은 시작 틀)이 같은 값을 낸다. 키를 그것만으로 지으면 두 앱이 객체 하나를 나눠 써서
 *  한 앱을 지우면(그 앱의 zip 을 지운다) 다른 앱의 zip 이 사라지고, 빌드가 매번 같은 바이트를 내지 않는 앱(Next.js 의 빌드 번호 등)은 남의 zip 을
 *  덮어쓴다(격리 리뷰 재현 — 되돌리기가 NoSuchKey · 지문 불일치로 영구 실패). 판 파일 b/<sha256> 은 내용 지문이라 나눠 써도 된다 — z/ 는 아니다.
 */
export const zipKeyFor = (prefix: string, tenant: string, appId: string, buildKey: string): string => `${prefix}t/${tenant}/z/${appId}/${buildKey}.zip`;

/**
 * 빌드 지문 — 같은 값이면 같은 zip 을 쓴다. 매니페스트(lively-app.json)는 뺀다(zip 에도 담지 않는다 — app-server-builder ZIP_EXCLUDE):
 *  이름·설명·자리만 바꾼 판(앱 만들기 「이대로 넣기」 의 마무리 저장이 그렇다)이 다시 빌드하지 않게. 서버에 닿는 선언(web.server)은 넣는다.
 */
export function buildKeyOf(bundle: AppBundle, decl: AppServerDecl, rt: { runtime: string; arch: string }): string {
  const files = bundle.files.filter((f) => !ZIP_EXCLUDE.includes(f.p)).map((f) => [f.p, f.h]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  const canon = JSON.stringify({ v: BUILDER_VERSION, runtime: rt.runtime, arch: rt.arch, start: decl.start, build: decl.build, dir: decl.dir, files });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

/** 앱 코드가 받는 라이블리 값(#4485 앱 v2-6) — 함수 판마다 굽는다. 토큰은 판마다 새로 발급한다(app-server-deploy). */
export interface AppServerRuntime {
  /** 워크스페이스(테넌트) UUID — 검사 층이 신원의 ws 칸과 대조한다. */
  tenantId: string;
  /** 워크스페이스 슬러그. */
  slug: string;
  /** 앱 서버가 라이블리를 부를 주소(SDK 의 LIVELY_API_URL) — 워크스페이스 주소(https://<slug>.app.lvly.io). */
  apiUrl: string;
  /** 앱 서버 토큰(app-server-auth) — 혼자서는 아무것도 못 한다(사람 신원과 함께일 때만). */
  token: string;
  /**
   * 신원 공개 키(JSON {kid: base64url}) — 검사 층이 서명을 본다. 비밀이 아니다.
   *  ⚠ 함수 판의 환경에 **구워진다**(다음 배포 때만 바뀐다). 서명 키를 바꿀 때는 ① 새 kid 를 공개 키 목록에 더해(옛 kid 와 함께) 게이트웨이를 롤하고
   *   ② 모든 서버 앱을 다시 올려(app_server_deploy — 설정이 달라진 함수는 새 판이 된다) ③ 그 뒤에 앞단의 서명 kid 를 바꾸고 ④ 옛 kid 를 맨 마지막에 뺀다.
   *   ③ 을 먼저 하면 다시 올리지 않은 함수의 검사 층이 새 kid 를 몰라 모두 401 이다(게이트웨이 쪽 판정은 env 를 바로 따른다).
   */
  identityPubkeys: string;
  /**
   * 사람 요청 하나의 시간(초 · app_server_policy.timeout_s) — #4486 부터 함수 시간은 작업 시간(15분)이라, 사람 요청은 검사 층이 이 시간에 끊는다(504).
   *  꼭 준다 — 빠뜨리면 사람 요청이 함수 시간(15분)까지 붙잡힌다(정책은 있는데 집행이 없는 꼴 · 격리 리뷰).
   */
  requestTimeoutS: number;
}

/** 검사 층(app-server-guard)과 웹 어댑터를 잇는 값 — 앱 코드가 보지 않아도 되는 칸이라 고칠 때는 문 판과 함께 본다. */
export const GUARD_ENV = {
  AWS_LAMBDA_EXEC_WRAPPER: GUARD_BOOTSTRAP_PATH,
  AWS_LWA_PORT: String(GUARD_PORT),
  AWS_LWA_READINESS_CHECK_PORT: String(GUARD_PORT),
  AWS_LWA_READINESS_CHECK_PATH: GUARD_READY_PATH,
  AWS_LWA_READINESS_CHECK_PROTOCOL: "http",
  AWS_LWA_INVOKE_MODE: "response_stream",
  LIVELY_GUARD_PORT: String(GUARD_PORT),
} as const;

/** 배포 때 판마다 바뀌어도 «같은 설정» 으로 보는 칸 — 앱 서버 토큰은 판마다 새로 굽지만 그것만으로 새 판을 만들지 않는다(app-server-deploy configDrift). */
export const ENV_ROTATING = new Set(["LIVELY_APP_TOKEN"]);

/**
 * 함수 환경 — 웹 어댑터(레이어)가 요청을 우리 검사 층(:8099)으로 넘기고, 검사 층이 사람 신원을 본 뒤 앱의 $PORT(8080)로 넘긴다(#4485).
 *  준비 판정은 검사 층의 /_lively/guard/ready — 앱 포트가 열렸을 때만 200 이다(그 전 v2-5 의 «포트가 열렸나(tcp)» 와 같은 뜻 · 앱의 «/» 가 500 이어도 뜬다).
 *  응답은 흘려 보낸다(response_stream) — 게이트웨이가 InvokeWithResponseStream 으로 부르고 조각째 잇는다(SSE · 큰 응답).
 *  앱 코드가 쓰는 값: PORT · LIVELY_APP_ID · LIVELY_WORKSPACE · LIVELY_API_URL · LIVELY_APP_TOKEN(SDK lively-db.mjs 가 읽는다).
 *  검사 층이 쓰는 값: LIVELY_TENANT_ID · LIVELY_APP_IDENTITY_PUBKEYS · LIVELY_REQUEST_TIMEOUT_S(#4486 사람 요청 시간) · LIVELY_API_URL · LIVELY_APP_TOKEN
 *   (#4486 백그라운드 작업의 시작 확인 · 박동 · 결과 보고를 게이트웨이에).
 *   LLM 주소(SDK 호환 base URL)는 v2-9(#4488)가 **워크스페이스 API 키가 있는 워크스페이스에서만** 여기에 더한다(설계 §3-E · §12 ⑤-3 — 고급 길).
 *   앱의 AI 작업 기본 입구는 `/_lively/ai/runs` 다.
 *  rt 가 없으면(시험 · 옛 판정) 검사 층 칸까지만 — 운영 배포는 늘 rt 를 넘긴다.
 */
export function lambdaEnvFor(appId: string, rt?: AppServerRuntime): Record<string, string> {
  return {
    ...GUARD_ENV,
    AWS_LWA_READINESS_CHECK_TIMEOUT_SECONDS: "20",
    PORT: String(APP_PORT),
    NODE_ENV: "production",
    LIVELY_APP_ID: appId,
    ...(rt ? {
      LIVELY_TENANT_ID: rt.tenantId.toLowerCase(),
      LIVELY_WORKSPACE: rt.slug,
      LIVELY_API_URL: rt.apiUrl,
      LIVELY_APP_TOKEN: rt.token,
      LIVELY_APP_IDENTITY_PUBKEYS: rt.identityPubkeys,
      LIVELY_REQUEST_TIMEOUT_S: String(rt.requestTimeoutS),
    } : {}),
  };
}
export const LAMBDA_HANDLER = RUN_SCRIPT;

/**
 * 앱 서버가 라이블리를 부를 주소 — 워크스페이스 주소. 매니지드는 `https://<슬러그>.<PUBLIC_URL 의 호스트>`(= https://lively-46e3.app.lvly.io).
 *  org 프로필의 게이트웨이 주소가 그 워크스페이스 주소면 그것을 쓴다. 매니지드 PUBLIC_URL 은 CP 주소(https://app.lvly.io)라 그대로 쓰면 CP 로 간다 —
 *  그래서 슬러그를 앞에 붙인다(lvly-cloud deploy/lvly-gw.sh PUBLIC_URL_FALLBACK). 못 정하면 null(배포가 까닭을 말하고 멈춘다).
 */
export function appServerApiUrl(slug: string | null | undefined, profileUrl: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const s = String(slug ?? "").trim().toLowerCase();
  const clean = (u: string): string | null => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? `${x.protocol}//${x.host}` : null; } catch { return null; } };
  //  #4487 자가호스팅 — 앱 서버는 이 박스의 컨테이너 안에서 게이트웨이를 부른다. 워크스페이스 주소에 슬러그를 붙이는 규칙(매니지드)은 쓰지 않는다:
  //   env LIVELY_APP_SERVER_API_URL(컨테이너에서 닿는 주소 — 예 http://host.docker.internal:8080) > 조직 정보의 게이트웨이 주소 > PUBLIC_URL.
  if (appServerHostKind(env) === "local") {
    return clean(String(env.LIVELY_APP_SERVER_API_URL ?? "").trim()) ?? (profileUrl ? clean(profileUrl) : null) ?? clean(String(env.PUBLIC_URL ?? "").trim());
  }
  const prof = profileUrl ? clean(profileUrl) : null;
  if (s && prof && new URL(prof).host.startsWith(`${s}.`)) return prof;
  const pub = clean(String(env.PUBLIC_URL ?? "").trim());
  if (s && pub) { const u = new URL(pub); return `${u.protocol}//${s}.${u.host}`; }
  return prof;
}

/** 시험 호출 — 함수 주소(Function URL) 모양의 이벤트. 웹 어댑터가 이 모양을 받아 검사 층으로 넘긴다(2026-10-15 · 16 실측). */
export function smokeEvent(host: string, now: number = Date.now(), path = "/"): Record<string, unknown> {
  return {
    version: "2.0", routeKey: "$default", rawPath: path, rawQueryString: "",
    headers: { host, "user-agent": "lively-deploy-check", accept: "*/*" },
    requestContext: {
      accountId: "anonymous", apiId: "lively", domainName: host, domainPrefix: host.split(".")[0] ?? host,
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "lively-deploy-check" },
      requestId: `deploy-check-${now}`, routeKey: "$default", stage: "$default", time: new Date(now).toUTCString(), timeEpoch: now,
    },
    isBase64Encoded: false,
  };
}

/** 시험 호출의 실패를 사람 말로 — 어댑터 · 런타임 오류 꼴(2026-10-15 실측)을 읽는다. null = 실패 아님. */
export function smokeFailure(functionError: string | null, payload: string, log: string): string | null {
  if (!functionError) return null;
  let type = "";
  try { type = String((JSON.parse(payload) as { errorType?: unknown }).errorType ?? ""); } catch { /* 본문이 JSON 이 아니다 */ }
  if (/did not become ready|is not ready after/.test(log)) {
    return "서버가 $PORT(8080)에서 응답하지 않았습니다 — 서버가 process.env.PORT 에서 받는지 보세요(시작 명령이 다른 포트를 열었거나 너무 늦게 열었습니다)";
  }
  if (type === "Runtime.ExitError") return "서버가 시작하자마자 끝났습니다 — 아래 기록의 오류를 보세요(모듈을 못 찾음 · 설정 없음 등)";
  return `서버를 부르다 실패했습니다(${type || functionError}) — 아래 기록을 보세요`;
}

/** 기록 끝부분 — 사람이 볼 만큼만(줄 단위로 자른다). */
export function tailText(s: string, max = 4000): string {
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const nl = cut.indexOf("\n");
  return "…\n" + (nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}

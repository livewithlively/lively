// 앱 서버(#4484 앱 v2-5) — 배포 설정 · 함수 이름 · 서버 선언 · 빌드 지문 · 함수 환경. 전부 순수(판정만).
//
//  설계: 지식 app-framework-v2-general-web-design §3-C · §12 ③ · §17(결정 상민 2026-10-15).
//   앱은 매니페스트 최상위 `web.server` 로 서버가 있다고 알린다(`web` 은 passthrough — 옛 코어로 되돌려도 매니페스트를 읽는다, #4481).
//    {"web": {"server": {"start": "node server.js", "build": "npm run build"}}} — 둘 다 생략하면 package.json 의 scripts.start · scripts.build.
//   함수는 앱 × 워크스페이스마다 하나(`<접두>-<앱>-<워크스페이스 슬러그>`) · 별칭 둘(cur = 고친 사람이 보는 판(초안 주소) · pub = 공개 판).
//   같은 코드는 다시 빌드하지 않는다 — 빌드 지문 = 매니페스트를 뺀 파일 목록 + 서버 선언 + 빌더 판 + 런타임. 이름·설명만 바꾼 판 ·
//    되돌리기 · 공개하기는 그 지문의 zip 을 그대로 쓴다(설계 §3-C «판 되돌리기·판 복사는 그 판의 zip 을 다시 쓰므로 빌드가 필요 없다»).
import crypto from "node:crypto";
import type { AppBundle } from "./app-bundle.js";
import { BUILDER_VERSION, ZIP_EXCLUDE, RUN_SCRIPT } from "./app-server-builder.js";

/** 앱이 선언한 서버 — start/build 가 null 이면 package.json 의 scripts 를 쓴다. */
export interface AppServerDecl { start: string | null; build: string | null }

const cmd = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= 2000 && !s.includes("\0") ? s : null;
};

/** 매니페스트 → 서버 선언(없으면 null). `web.server` 가 객체이거나 true 면 서버 앱이다. */
export function serverDeclOf(manifest: unknown): AppServerDecl | null {
  const s = (manifest as { web?: { server?: unknown } } | null)?.web?.server;
  if (s === true) return { start: null, build: null };
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  return { start: cmd(o.start), build: cmd(o.build) };
}

/** 배포 설정(env) — 실행 역할이 없으면 null(= 이 배포는 앱 서버를 돌리지 않는다 · 자가호스팅은 v2-8). */
export interface AppServerEnv {
  region: string;
  /** 함수 실행 역할(lively-infra app-servers.tf lvly-app-exec) — 로그 쓰기만. */
  execRoleArn: string;
  /** Lambda Web Adapter 레이어(arm64) 판 ARN. */
  layerArn: string;
  /** 함수 이름 앞자리 — IAM 정책이 lvly-app-* 만 허락한다. 한 계정을 여러 배포가 나눠 쓰면 배포마다 다르게(예 lvly-app-dev-). */
  prefix: string;
  runtime: string;
  arch: "arm64";
}

export const DEFAULT_ADAPTER_LAYER_VERSION = 30;   // LambdaAdapterLayerArm64:30 = Lambda Web Adapter 1.1.0(2026-09-18) · 서울 실측 2026-10-15
export const DEFAULT_RUNTIME = "nodejs22.x";        // 세션 이미지(node:22-bookworm-slim)와 같은 큰 판 — 빌드한 네이티브 모듈이 맞게
const PREFIX_RE = /^lvly-app-([a-z0-9]{1,8}-)?$/;
const ROLE_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]{1,64}$/;
const LAYER_RE = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:layer:[A-Za-z0-9_-]+:\d+$/;

export function appServerEnv(env: NodeJS.ProcessEnv = process.env): AppServerEnv | null {
  const execRoleArn = String(env.LIVELY_APP_SERVER_EXEC_ROLE ?? "").trim();
  if (!execRoleArn || !ROLE_RE.test(execRoleArn)) return null;
  const region = String(env.LIVELY_APP_SERVER_REGION ?? env.LIVELY_APP_BUNDLE_REGION ?? env.AWS_REGION ?? "").trim() || "ap-northeast-2";
  const layer = String(env.LIVELY_APP_SERVER_LAYER ?? "").trim();
  const layerArn = layer && LAYER_RE.test(layer) ? layer : `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:${DEFAULT_ADAPTER_LAYER_VERSION}`;
  const p = String(env.LIVELY_APP_SERVER_PREFIX ?? "").trim();
  const prefix = p && PREFIX_RE.test(p) ? p : "lvly-app-";
  const runtime = String(env.LIVELY_APP_SERVER_RUNTIME ?? "").trim() || DEFAULT_RUNTIME;
  return { region, execRoleArn, layerArn, prefix, runtime, arch: "arm64" };
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

/** zip 자리 — 판 묶음 버킷의 워크스페이스 앞자리 아래(판 파일 b/ 옆 z/). 지문 이름이라 같은 코드면 같은 키다. */
export const zipKeyFor = (prefix: string, tenant: string, buildKey: string): string => `${prefix}t/${tenant}/z/${buildKey}.zip`;

/**
 * 빌드 지문 — 같은 값이면 같은 zip 을 쓴다. 매니페스트(lively-app.json)는 뺀다(zip 에도 담지 않는다 — app-server-builder ZIP_EXCLUDE):
 *  이름·설명·자리만 바꾼 판(앱 만들기 「이대로 넣기」 의 마무리 저장이 그렇다)이 다시 빌드하지 않게. 서버에 닿는 선언(web.server)은 넣는다.
 */
export function buildKeyOf(bundle: AppBundle, decl: AppServerDecl, rt: { runtime: string; arch: string }): string {
  const files = bundle.files.filter((f) => !ZIP_EXCLUDE.includes(f.p)).map((f) => [f.p, f.h]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  const canon = JSON.stringify({ v: BUILDER_VERSION, runtime: rt.runtime, arch: rt.arch, start: decl.start, build: decl.build, files });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

/**
 * 함수 환경 — 웹 어댑터(레이어)가 우리 시작 스크립트를 띄우고 $PORT(8080)로 요청을 넘긴다.
 *  준비 판정은 «포트가 열렸나»(tcp) — 기본(http «/» 가 100~499)이면 «/» 가 500 을 내는 앱이 영영 못 뜬다(2026-10-15 실측: 안 받으면 20초 뒤
 *  «did not become ready» 로 실패). v2-6 이 앱 서버 토큰 · 서명 신원 검사 층을 여기에 더한다.
 */
export function lambdaEnvFor(appId: string): Record<string, string> {
  return {
    AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
    PORT: "8080",
    AWS_LWA_PORT: "8080",
    AWS_LWA_READINESS_CHECK_PROTOCOL: "tcp",
    AWS_LWA_READINESS_CHECK_TIMEOUT_SECONDS: "20",
    NODE_ENV: "production",
    LIVELY_APP_ID: appId,
  };
}
export const LAMBDA_HANDLER = RUN_SCRIPT;

/** 시험 호출 — 함수 주소(Function URL) 모양의 GET / . 웹 어댑터가 이 모양을 받아 앱의 $PORT 로 넘긴다(2026-10-15 실측). */
export function smokeEvent(host: string, now: number = Date.now()): Record<string, unknown> {
  return {
    version: "2.0", routeKey: "$default", rawPath: "/", rawQueryString: "",
    headers: { host, "user-agent": "lively-deploy-check", accept: "*/*" },
    requestContext: {
      accountId: "anonymous", apiId: "lively", domainName: host, domainPrefix: host.split(".")[0] ?? host,
      http: { method: "GET", path: "/", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "lively-deploy-check" },
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

// 앱 서버 순수 판정(#4484) 단위 시험 — 서버 선언 · 함수 이름 · 빌드 지문 · 배포 설정 · 시험 호출 판독 · 상한 정규화 · 자동 멈춤.
// 실행: npm run build && node dist/apps/app-server-config.test.js
//  B1~B12 는 사양 엣지 표(spec-4484.md B절 · E절)의 행 번호다.
import assert from "node:assert/strict";
import {
  GUARD_ENV, LOG_GROUP_TAG, appServerApiUrl, appServerEnv, buildKeyOf, codeAt, functionCodeFor, functionNameFor, functionSizingFor, lambdaEnvFor, logGroupArnFor, logGroupTagBundleFor,
  logGroupTagsFor, serverDeclOf, smokeFailure, zipKeyFor,
} from "./app-server-config.js";
import {
  APP_SERVER_POLICY_DEFAULT, APP_SERVER_POLICY_MAX, APP_SERVER_POLICY_MIN, autoStopReason, codeBytesAfterDeploy, codeBytesOf, codeCapDenial, envAppServerPolicy, functionsCapDenial,
  normalizeAppServerPolicy, retentionDaysFor,
} from "./app-server-policy.js";
import type { AppBundle } from "./app-bundle.js";
import { REFERENCE_PERMISSION_RE, ZIP_MISSING_RE, configDrift, publicError, realLambdaApi, scrubAws } from "./app-server-deploy.js";
import { GUARD_BOOTSTRAP_PATH, GUARD_PORT, GUARD_READY_PATH } from "./app-server-guard.js";
import type { FnConfiguration } from "../net/aws/lambda-lite.js";
import { appServerEnabledFor } from "./app-server-config.js";
import { withTenant } from "../org/tenant-context.js";
import { AwsError } from "../net/aws/aws-json.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const h = (c: string): string => c.repeat(64).slice(0, 64);

t("B1 서버 선언 — true · 객체(다듬음) · 없음 · 배열 · 문자열", () => {
  assert.deepEqual(serverDeclOf({ web: { server: true } }), { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "  node s.js ", build: "npm run b" } } }), { start: "node s.js", build: "npm run b", dir: null, memory_mb: null, tmp_mb: null });
  assert.equal(serverDeclOf({ web: { root: "dist" } }), null);
  assert.equal(serverDeclOf({}), null);
  assert.equal(serverDeclOf(null), null);
  assert.equal(serverDeclOf({ web: { server: [] } }), null);
  assert.equal(serverDeclOf({ web: { server: "node s.js" } }), null);
});

t("B2 서버 선언 칸 — 빈 글 · 2,001자 · NUL · 숫자는 null(=package.json 을 쓴다)", () => {
  assert.deepEqual(serverDeclOf({ web: { server: { start: "   " } } }), { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "x".repeat(2001), build: "a\0b" } } }), { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "x".repeat(2000) } } })?.start?.length, 2000);
  assert.deepEqual(serverDeclOf({ web: { server: { start: 5 } } }), { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null });
});

t("B11 서버 선언 dir — 다듬음 · 끝 빗금 · '.' · 200자 경계 · 201자 · 숫자", () => {
  assert.equal(serverDeclOf({ web: { server: { dir: "  .next/standalone/ " } } })?.dir, ".next/standalone");
  assert.equal(serverDeclOf({ web: { server: { dir: "." } } })?.dir, null, "'.' 은 앱 폴더 전체");
  assert.equal(serverDeclOf({ web: { server: { dir: "./" } } })?.dir, null, "'./' 도 전체");
  assert.equal(serverDeclOf({ web: { server: { dir: "" } } })?.dir, null);
  assert.equal(serverDeclOf({ web: { server: { dir: "d".repeat(200) } } })?.dir?.length, 200, "200자(경계)");
  assert.equal(serverDeclOf({ web: { server: { dir: "d".repeat(201) } } })?.dir, null, "201자");
  assert.equal(serverDeclOf({ web: { server: { dir: 3 } } })?.dir, null);
  //  모양 검사(.. · 절대)는 빌더가 한다 — 여기서 버리면 «왜 전체가 올라갔나» 를 아무도 모른다
  assert.equal(serverDeclOf({ web: { server: { dir: "../x" } } })?.dir, "../x");
});

t("B3 함수 이름 — 64자까지 · 65자 null · 금지 글자 null", () => {
  const app32 = "a".repeat(32), slug = "b".repeat(20);
  const name = functionNameFor("lvly-app-", app32, slug);
  assert.equal(name, `lvly-app-${app32}-${slug}`);
  assert.equal(name!.length, 62);
  assert.equal(functionNameFor("lvly-app-x-", app32, "c".repeat(20))!.length, 64, "11 + 32 + 1 + 20 = 64자(경계)");
  assert.equal(functionNameFor("lvly-app-x-", app32, "c".repeat(21)), null, "65자");
  assert.equal(functionNameFor("lvly-app-", "a.b", "ws"), null);
});

const bundle = (files: Array<[string, string]>): AppBundle => ({ v: 1, files: files.map(([p, c]) => ({ p, h: h(c), s: 1 })) });
const rt = { runtime: "nodejs22.x", arch: "arm64" };
const decl = { start: null, build: null, dir: null, memory_mb: null, tmp_mb: null };
t("B4 빌드 지문 — 매니페스트만 다름 · 파일 순서만 다름이면 같다", () => {
  const a = buildKeyOf(bundle([["lively-app.json", "1"], ["server.js", "2"], ["package.json", "3"]]), decl, rt);
  const b = buildKeyOf(bundle([["package.json", "3"], ["lively-app.json", "9"], ["server.js", "2"]]), decl, rt);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.equal(buildKeyOf(bundle([["server.js", "2"], ["package.json", "3"]]), decl, rt), a, "매니페스트가 아예 없어도 같다");
});

t("B5 빌드 지문 — 다른 파일 하나 · 경로만 다름 · start · build · 런타임 · 구조가 다르면 다르다", () => {
  const base = bundle([["server.js", "2"], ["package.json", "3"]]);
  const k = buildKeyOf(base, decl, rt);
  assert.notEqual(buildKeyOf(bundle([["server.js", "4"], ["package.json", "3"]]), decl, rt), k);
  assert.notEqual(buildKeyOf(bundle([["server2.js", "2"], ["package.json", "3"]]), decl, rt), k);
  assert.notEqual(buildKeyOf(base, { ...decl, start: "node x" }, rt), k);
  assert.notEqual(buildKeyOf(base, { ...decl, build: "npm run b" }, rt), k);
  assert.notEqual(buildKeyOf(base, { ...decl, dir: ".next/standalone" }, rt), k, "B12 올릴 폴더만 달라도 다른 zip");
  assert.notEqual(buildKeyOf(base, decl, { runtime: "nodejs24.x", arch: "arm64" }), k);
  assert.notEqual(buildKeyOf(base, decl, { runtime: "nodejs22.x", arch: "x86_64" }), k);
  assert.equal(zipKeyFor("p/", "ws-1", "app-a", k), `p/t/ws-1/z/app-a/${k}.zip`, "앱마다 따로 — 같은 코드의 두 앱이 zip 하나를 나눠 쓰지 않는다");
  assert.notEqual(zipKeyFor("p/", "ws-1", "app-a", k), zipKeyFor("p/", "ws-1", "app-b", k));
});

const ROLE = "arn:aws:iam::425515538094:role/lvly-app-exec";
t("B6 배포 설정 — 실행 역할 없음 · 모양 틀림이면 null(앱 서버 꺼짐)", () => {
  assert.equal(appServerEnv({}), null);
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: "lvly-app-exec" }), null);
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: "arn:aws:iam::12:role/x" }), null);
});

t("B7 배포 설정 — 지역 순서 · 레이어 · 접두 · 런타임 기본", () => {
  const e = appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE })!;
  assert.deepEqual(e, { host: "lambda", region: "ap-northeast-2", execRoleArn: ROLE, awsAccountId: ROLE.split(":")[4], layerArn: "arn:aws:lambda:ap-northeast-2:753240598075:layer:LambdaAdapterLayerArm64:30", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64", codeStorage: "REFERENCE" });
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, AWS_REGION: "us-east-1" })!.region, "us-east-1");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, AWS_REGION: "us-east-1", LIVELY_APP_BUNDLE_REGION: "ap-northeast-1" })!.region, "ap-northeast-1");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_BUNDLE_REGION: "ap-northeast-1", LIVELY_APP_SERVER_REGION: "eu-west-1" })!.region, "eu-west-1");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_LAYER: "not-an-arn" })!.layerArn, e.layerArn);
  const custom = "arn:aws:lambda:ap-northeast-2:753240598075:layer:LambdaAdapterLayerArm64:29";
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_LAYER: custom })!.layerArn, custom);
  //  IAM 정책이 lvly-app-* 만 허락한다 — 그 밖의 접두는 기본으로 되돌린다.
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_PREFIX: "evil-" })!.prefix, "lvly-app-");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_PREFIX: "lvly-app-dev-" })!.prefix, "lvly-app-dev-");
  assert.equal(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE, LIVELY_APP_SERVER_PREFIX: "lvly-app-toolongname-" })!.prefix, "lvly-app-");
});

t("B8 시험 호출 실패 판독 — 오류 없음 null · 시작 직후 끝남 · 포트 안 받음 · 그 밖", () => {
  assert.equal(smokeFailure(null, "{\"statusCode\":500}", ""), null, "HTTP 500 은 서버가 떠 있다는 뜻 — 실패 아님");
  assert.match(smokeFailure("Unhandled", JSON.stringify({ errorType: "Runtime.ExitError" }), "Error: Cannot find module")!, /시작하자마자/);
  assert.match(smokeFailure("Unhandled", JSON.stringify({ errorType: "Extension.Crash" }), "INFO app is not ready after 2000ms url=http://127.0.0.1:8080/")!, /PORT/);
  assert.match(smokeFailure("Unhandled", "not json", "")!, /Unhandled/);
});

t("I1 ★ 함수 환경(#4485) — 웹 어댑터는 검사 층(:8099)으로 · 준비 판정도 검사 층 · 흘려 보내기 · 앱은 $PORT 8080 · 앱 값(주소 · 토큰 · 워크스페이스 · 공개 키)", () => {
  const env = lambdaEnvFor("my-app", { tenantId: "11111111-2222-4333-8444-555555555555".toUpperCase(), slug: "lively-46e3", apiUrl: "https://lively-46e3.app.lvly.io", token: "lvk_x", identityPubkeys: "{\"k1\":\"x\"}", requestTimeoutS: 30 });
  assert.equal(env.AWS_LAMBDA_EXEC_WRAPPER, GUARD_BOOTSTRAP_PATH, "웹 어댑터의 /opt/bootstrap 을 그대로 쓰면 검사 층이 앞에 서지 않는다");
  assert.equal(env.AWS_LWA_PORT, String(GUARD_PORT));
  assert.equal(env.LIVELY_GUARD_PORT, String(GUARD_PORT));
  assert.equal(env.AWS_LWA_READINESS_CHECK_PORT, String(GUARD_PORT));
  assert.equal(env.AWS_LWA_READINESS_CHECK_PATH, GUARD_READY_PATH);
  assert.equal(env.AWS_LWA_READINESS_CHECK_PROTOCOL, "http");
  assert.equal(env.AWS_LWA_INVOKE_MODE, "response_stream");
  assert.equal(env.PORT, "8080");
  assert.notEqual(env.PORT, env.AWS_LWA_PORT, "앱과 검사 층이 같은 포트면 앱이 검사 층 없이 받는다");
  assert.equal(env.LIVELY_APP_ID, "my-app");
  assert.equal(env.LIVELY_TENANT_ID, "11111111-2222-4333-8444-555555555555", "검사 층은 소문자로 대조한다");
  assert.equal(env.LIVELY_WORKSPACE, "lively-46e3");
  assert.equal(env.LIVELY_API_URL, "https://lively-46e3.app.lvly.io");
  assert.equal(env.LIVELY_APP_TOKEN, "lvk_x");
  assert.equal(env.LIVELY_APP_IDENTITY_PUBKEYS, "{\"k1\":\"x\"}");
  for (const k of ["DATABASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "LIVELY_LLM_BASE_URL"]) assert.equal(env[k], undefined, `${k} 를 넣었다(설계 §3-D · §12 ⑤-3)`);
  assert.deepEqual(Object.keys(lambdaEnvFor("a")).filter((k) => k.startsWith("LIVELY_") && k !== "LIVELY_APP_ID" && k !== "LIVELY_GUARD_PORT"), [], "rt 없이 앱 값이 들어갔다");
  for (const [k, v] of Object.entries(GUARD_ENV)) assert.equal(lambdaEnvFor("a")[k], v);
});

t("I2 라이블리 주소 — 프로필이 그 워크스페이스 주소면 그대로 · CP 주소면 PUBLIC_URL 앞에 슬러그 · 슬러그 없음 → 프로필 · 둘 다 없음 → null", () => {
  const env = { PUBLIC_URL: "https://app.lvly.io" };
  assert.equal(appServerApiUrl("lively-46e3", "https://lively-46e3.app.lvly.io/", env), "https://lively-46e3.app.lvly.io");
  assert.equal(appServerApiUrl("lively-46e3", "https://app.lvly.io", env), "https://lively-46e3.app.lvly.io", "CP 주소로 보내면 앱 서버가 CP 를 부른다");
  assert.equal(appServerApiUrl("LIVELY-46E3", null, env), "https://lively-46e3.app.lvly.io");
  assert.equal(appServerApiUrl("lively-46e3", "https://other-1a2b.app.lvly.io", env), "https://lively-46e3.app.lvly.io", "남의 워크스페이스 주소");
  assert.equal(appServerApiUrl(null, "https://dev.lvly.io", {}), "https://dev.lvly.io");
  assert.equal(appServerApiUrl("x", "not a url", {}), null);
  assert.equal(appServerApiUrl(null, null, {}), null);
  assert.equal(appServerApiUrl("lively-46e3", "ftp://lively-46e3.app.lvly.io", env), "https://lively-46e3.app.lvly.io", "http(s) 밖 프로필은 쓰지 않는다");
});

t("I3 ★ 설정 비교 — 토큰 값만 다르면 같다(새 판 없음) · exact 면 다르다 · 토큰 칸이 없으면 다르다 · 레이어 순서 · 개수", () => {
  const want = { role: "r", handler: "h", runtime: "nodejs22.x", memory: 512, timeout: 30, layers: ["L1", "L2"], vars: { A: "1", LIVELY_APP_TOKEN: "new" } };
  const cfg = (o: Partial<FnConfiguration> = {}): FnConfiguration => ({ FunctionName: "f", FunctionArn: "a", Role: "r", Handler: "h", Runtime: "nodejs22.x", MemorySize: 512, Timeout: 30,
    Layers: [{ Arn: "L1" }, { Arn: "L2" }], Environment: { Variables: { A: "1", LIVELY_APP_TOKEN: "old" } }, ...o });
  assert.deepEqual(configDrift(cfg(), want), {}, "토큰 값만 다른데 새 판을 만든다");
  assert.ok(configDrift(cfg(), want, { exact: true }).Environment, "새 판을 고정할 때 옛 토큰을 그대로 둔다");
  assert.ok(configDrift(cfg({ Environment: { Variables: { A: "1" } } }), want).Environment, "토큰이 없는 판을 재사용한다(v2-5 판)");
  assert.ok(configDrift(cfg({ Environment: { Variables: { A: "1", LIVELY_APP_TOKEN: "" } } }), want).Environment, "빈 토큰");
  assert.ok(configDrift(cfg({ Environment: { Variables: { A: "2", LIVELY_APP_TOKEN: "old" } } }), want).Environment, "다른 값");
  assert.deepEqual(configDrift(cfg({ Layers: [{ Arn: "L2" }, { Arn: "L1" }] }), want).Layers, ["L1", "L2"], "레이어 순서");
  assert.deepEqual(configDrift(cfg({ Layers: [{ Arn: "L1" }] }), want).Layers, ["L1", "L2"], "검사 층 레이어가 빠진 판(v2-5)");
});

t("I4 동시 처리 상한 — 기본 워크스페이스 50 · 앱 20 · 앱 상한이 워크스페이스 상한을 넘으면 워크스페이스 값 · 바닥 1", () => {
  assert.equal(APP_SERVER_POLICY_DEFAULT.max_inflight_workspace, 50);
  assert.equal(APP_SERVER_POLICY_DEFAULT.max_inflight_app, 20);
  assert.equal(normalizeAppServerPolicy({ max_inflight_workspace: 10, max_inflight_app: 30 }).max_inflight_app, 10);
  assert.equal(normalizeAppServerPolicy({ max_inflight_workspace: 10, max_inflight_app: 10 }).max_inflight_app, 10, "경계 — 같으면 그대로");
  assert.equal(normalizeAppServerPolicy({ max_inflight_app: 0 }).max_inflight_app, 20, "0 은 «그 값 없음» = 기본");
  assert.equal(normalizeAppServerPolicy({ max_inflight_workspace: 999_999 }).max_inflight_workspace, APP_SERVER_POLICY_MAX.max_inflight_workspace);
  //  Q1 저장할 값은 칸끼리 맞추지 않는다 — 앱 500 · 워크스페이스 50 을 저장해 두면 지금은 50 을 쓰고, 워크스페이스를 600 으로 올리면 500 이 살아난다.
  const stored = normalizeAppServerPolicy({ max_inflight_workspace: 50, max_inflight_app: 500 }, APP_SERVER_POLICY_DEFAULT, { effective: false });
  assert.equal(stored.max_inflight_app, 500, "저장할 값을 깎았다");
  assert.equal(normalizeAppServerPolicy(stored).max_inflight_app, 50, "쓰는 값은 워크스페이스 값까지");
  assert.equal(normalizeAppServerPolicy({ ...stored, max_inflight_workspace: 600 }).max_inflight_app, 500, "워크스페이스를 올리면 저장한 앱 값이 살아난다");
});

t("B9 상한 정규화 — 모르는 키 버림 · 잡값 기본 · 바닥 · 천장 · 힙 0 허용 · 다른 칸 0 은 기본 · 보관 일수 맞춤", () => {
  const n = normalizeAppServerPolicy({ evil: 1, memory_mb: "abc", timeout_s: 1, build_timeout_s: 10 ** 9, build_heap_mb: 0, keep_versions: 0, log_retention_days: 10 });
  assert.equal((n as unknown as Record<string, unknown>).evil, undefined);
  assert.equal(n.memory_mb, APP_SERVER_POLICY_DEFAULT.memory_mb);
  assert.equal(n.timeout_s, APP_SERVER_POLICY_MIN.timeout_s);
  assert.equal(n.build_timeout_s, APP_SERVER_POLICY_MAX.build_timeout_s);
  assert.equal(n.build_heap_mb, 0);
  assert.equal(n.keep_versions, APP_SERVER_POLICY_DEFAULT.keep_versions);
  assert.equal(n.log_retention_days, 7, "CloudWatch 가 받는 값으로 내린다");
  assert.equal(normalizeAppServerPolicy({ log_retention_days: 400 }).log_retention_days, 365);
  assert.equal(retentionDaysFor(14), 14);
  assert.equal(retentionDaysFor(0), 1);
  assert.deepEqual(envAppServerPolicy({ LIVELY_APP_SERVER_POLICY: "{broken" }), APP_SERVER_POLICY_DEFAULT);
  assert.equal(envAppServerPolicy({ LIVELY_APP_SERVER_POLICY: "{\"memory_mb\":1024}" }).memory_mb, 1024);
  assert.equal(normalizeAppServerPolicy({}, { ...APP_SERVER_POLICY_DEFAULT, memory_mb: 1024 }).memory_mb, 1024, "바탕(env)을 잇는다");
});

t("B10 자동 멈춤 — 넘으면 이유 · 같으면 없음 · 지표 없으면 없음 · 호출이 먼저", () => {
  const p = APP_SERVER_POLICY_DEFAULT;
  assert.match(autoStopReason(p, { invocations5m: 30_001, durationSec5m: 0 })!, /호출/);
  assert.equal(autoStopReason(p, { invocations5m: 30_000, durationSec5m: 3_000 }), null);
  assert.equal(autoStopReason(p, { invocations5m: null, durationSec5m: null }), null);
  assert.match(autoStopReason(p, { invocations5m: 10, durationSec5m: 3_000.5 })!, /실행 시간/);
  assert.match(autoStopReason(p, { invocations5m: 99_999, durationSec5m: 99_999 })!, /호출/);
});

t("B13 구성원에게 보일 오류 — 권한 · 자격 오류는 코드와 요청 번호만 · 그 밖은 ARN · 계정 번호를 지운다 · 우리 오류는 그대로", () => {
  const denied = new AwsError(403, "AccessDeniedException", "lambda POST /x 실패: 403 AccessDeniedException — User: arn:aws:sts::425515538094:assumed-role/lvly-cloud-box/i-0abc is not authorized", "req-1");
  const a = publicError(denied);
  assert.ok(a.includes("AccessDeniedException") && a.includes("req-1"), a);
  assert.ok(!a.includes("425515538094") && !a.includes("lvly-cloud-box") && !a.includes("arn:aws"), a);
  const other = new AwsError(400, "InvalidParameterValueException", "Unzipped size must be smaller than 262144000 bytes (role arn:aws:iam::425515538094:role/lvly-app-exec)", "req-2");
  const b = publicError(other);
  assert.ok(b.includes("Unzipped size must be smaller") && b.includes("req-2"), b);
  assert.ok(!b.includes("425515538094") && !b.includes("arn:aws"), b);
  assert.equal(publicError(new Error("우리 오류")), "우리 오류");
});

t("B14 워크스페이스 스위치 — 목록 없음 · '*' 은 전부 · 목록이면 든 워크스페이스만(대소문자 · 빈칸 무시) · 목록이 있는데 워크스페이스를 모르면 끔", () => {
  assert.equal(appServerEnabledFor("any", {}), true);
  assert.equal(appServerEnabledFor("any", { LIVELY_APP_SERVER_TENANTS: " * " }), true);
  const L = { LIVELY_APP_SERVER_TENANTS: "lively-46e3, Other-1" };
  assert.equal(appServerEnabledFor("lively-46e3", L), true);
  assert.equal(appServerEnabledFor("OTHER-1", L), true);
  assert.equal(appServerEnabledFor("lively-46e", L), false, "앞부분만 같은 슬러그는 아니다");
  assert.equal(appServerEnabledFor(null, L), false);
  const ROLE2 = "arn:aws:iam::425515538094:role/lvly-app-exec";
  const env = { LIVELY_APP_SERVER_EXEC_ROLE: ROLE2, ...L };
  assert.notEqual(withTenant({ id: "t1", slug: "lively-46e3" }, () => appServerEnv(env)), null, "든 워크스페이스의 요청이면 켜짐");
  assert.equal(withTenant({ id: "t2", slug: "someone-else" }, () => appServerEnv(env)), null, "목록 밖 워크스페이스의 요청이면 꺼짐");
  assert.equal(appServerEnv(env), null, "워크스페이스를 모르면 꺼짐");
  assert.notEqual(appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: ROLE2 }), null, "목록이 없으면 워크스페이스를 몰라도 켜짐(자가호스팅 · 시험)");
});

//  #4792 워크스페이스 상한 — 사양 엣지 표(spec-4792.md P · F · C 절)의 행마다 시험 하나.
t("B15 워크스페이스 상한 정규화(P1~P4) — 0 · 잡값은 기본 20개 · 5120MB · 바닥 100MB · 천장 200개 · 20480MB · 글자 숫자 · env 기본", () => {
  assert.equal(APP_SERVER_POLICY_DEFAULT.workspace_functions_max, 20);
  assert.equal(APP_SERVER_POLICY_DEFAULT.workspace_code_mb, 5120);
  const z = normalizeAppServerPolicy({ workspace_functions_max: 0, workspace_code_mb: "x" });
  assert.equal(z.workspace_functions_max, 20, "0 은 «그 값 없음»");
  assert.equal(z.workspace_code_mb, 5120, "잡값");
  assert.equal(normalizeAppServerPolicy({ workspace_code_mb: 5 }).workspace_code_mb, 100, "바닥");
  assert.equal(normalizeAppServerPolicy({ workspace_functions_max: 1 }).workspace_functions_max, 1, "바닥(1개) 그대로");
  const big = normalizeAppServerPolicy({ workspace_functions_max: 10_000, workspace_code_mb: 10 ** 7 });
  assert.equal(big.workspace_functions_max, 200, "천장 — 관리자가 스스로 올릴 수 있는 끝");
  assert.equal(big.workspace_code_mb, 20480);
  assert.equal(normalizeAppServerPolicy({ workspace_functions_max: "7" }).workspace_functions_max, 7);
  assert.equal(envAppServerPolicy({ LIVELY_APP_SERVER_POLICY: "{\"workspace_functions_max\":50}" }).workspace_functions_max, 50, "플랫폼 기본(env)");
  assert.equal(APP_SERVER_POLICY_MIN.workspace_functions_max, 1);
  assert.equal(APP_SERVER_POLICY_MAX.workspace_code_mb, 20480);
});

t("B16 함수 수 판정(F6) — 상한−1 개면 통과 · 상한 개면 막음(까닭에 수 · 상한 · 고치는 길) · 상한을 내려 이미 넘친 수도 막음", () => {
  const p = { ...APP_SERVER_POLICY_DEFAULT, workspace_functions_max: 3 };
  assert.equal(functionsCapDenial(p, 0), null, "함수가 하나도 없는 워크스페이스");
  assert.equal(functionsCapDenial(p, 2), null, "2개 있으면 세 번째는 된다(경계)");
  const m = functionsCapDenial(p, 3)!;
  assert.ok(m.includes("3개") && m.includes("workspace_functions_max") && m.includes("org_app_remove"), m);
  assert.notEqual(functionsCapDenial(p, 9), null, "상한을 내려 이미 넘쳤으면 새 함수는 막는다");
});

const MB = 1024 * 1024;
t("B17 배포 뒤 코드 크기(C8 · C10) — 새 함수 2벌 · 최근 keep−1 판 · 옮기지 않는 별칭의 판 · 겹치면 한 번 · keep 1 · 크기 없는 줄 0 · zip 0", () => {
  const vs = [{ Version: "$LATEST", CodeSize: 3 * MB }, { Version: "1", CodeSize: 1 * MB }, { Version: "2", CodeSize: 2 * MB }, { Version: "3", CodeSize: 3 * MB }];
  assert.equal(codeBytesAfterDeploy([], 5 * MB, 3, []), 10 * MB, "새 함수 = $LATEST + 판 1");
  assert.equal(codeBytesAfterDeploy(vs, 5 * MB, 3, []), 10 * MB + 3 * MB + 2 * MB, "cur · pub 를 함께 옮김 — 옛 판은 최근 2개(3 · 2)만 남는다");
  assert.equal(codeBytesAfterDeploy(vs, 5 * MB, 3, ["1"]), 10 * MB + 3 * MB + 2 * MB + 1 * MB, "초안만 올림 — pub 가 가리키는 1판도 남는다");
  assert.equal(codeBytesAfterDeploy(vs, 5 * MB, 3, ["3", null]), 10 * MB + 3 * MB + 2 * MB, "pub 판이 이미 최근 판이면 한 번만 센다");
  assert.equal(codeBytesAfterDeploy(vs, 5 * MB, 1, []), 10 * MB, "keep 1 — 옛 판은 하나도 안 남는다");
  assert.equal(codeBytesAfterDeploy([{ Version: "$LATEST" }, { Version: "4" }], 0, 3, []), 0, "크기 없는 줄 · zip 0 은 0 으로 센다");
  assert.equal(codeBytesOf(vs), 9 * MB, "지금 크기 = $LATEST 포함 합(AWS TotalCodeSize 와 같은 셈)");
  assert.equal(codeBytesOf([]), 0, "함수가 없으면 0");
});

t("B18 코드 저장 판정(C3 · C4 · C5) — 합 = 상한이면 통과 · 1바이트 넘고 늘면 막음 · 넘어도 줄거나 그대로면 통과", () => {
  const p = { ...APP_SERVER_POLICY_DEFAULT, workspace_code_mb: 100 };
  assert.equal(codeCapDenial(p, 90 * MB, 0, 10 * MB), null, "합이 꼭 상한이면 된다(경계)");
  const m = codeCapDenial(p, 90 * MB, 0, 10 * MB + 1)!;
  assert.ok(m.includes("100MB") && m.includes("workspace_code_mb") && m.includes("org_app_remove"), m);
  assert.ok(m.includes("1KB 넘습니다"), `넘는 양을 적는다(반올림한 합만 보면 앞뒤가 안 맞아 보인다): ${m}`);
  assert.equal(codeCapDenial(p, 500 * MB, 20 * MB, 20 * MB), null, "이미 넘었어도 이 함수가 그대로면 막지 않는다");
  assert.equal(codeCapDenial(p, 500 * MB, 20 * MB, 15 * MB), null, "줄어드는 배포도 된다");
  assert.notEqual(codeCapDenial(p, 500 * MB, 20 * MB, 20 * MB + 1), null, "넘은 채로 늘리면 막는다");
});

//  #4790 앱마다 로그 그룹 — 실행 역할의 쓰기 조건(lively-infra WriteOwnAppLogs)이 보는 태그와 그룹 ARN.
t("B20 로그 그룹 태그 · ARN(#4790) — 태그 키 lvly-fn = 함수 이름 · ARN 은 끝 :* 없이 · 계정은 실행 역할 ARN 에서", () => {
  assert.equal(LOG_GROUP_TAG, "lvly-fn", "lively-infra app-servers.tf 의 ${aws:ResourceTag/lvly-fn} 과 같은 이름");
  assert.deepEqual(logGroupTagsFor("lvly-app-x-ws"), { "lvly-fn": "lvly-app-x-ws" });
  const env = appServerEnv({ LIVELY_APP_SERVER_EXEC_ROLE: "arn:aws:iam::425515538094:role/lvly-app-exec" })!;
  assert.equal(env.awsAccountId, "425515538094");
  assert.equal(logGroupArnFor(env, "/aws/lambda/lvly-app-x-ws"), "arn:aws:logs:ap-northeast-2:425515538094:log-group:/aws/lambda/lvly-app-x-ws");
  assert.deepEqual(logGroupTagBundleFor(env, "lvly-app-x-ws"), { tags: { "lvly-fn": "lvly-app-x-ws" }, arn: "arn:aws:logs:ap-northeast-2:425515538094:log-group:/aws/lambda/lvly-app-x-ws" }, "배포가 넘기는 묶음");
});

//  #4791 서버 선언을 뺀 앱의 함수 정리 — 사양 엣지 표 R10.
t("B19 걷기까지의 날수 정규화(R10) — 기본 7일 · 0 · 잡값은 기본 · 바닥 1 · 천장 365", () => {
  assert.equal(APP_SERVER_POLICY_DEFAULT.unused_retire_days, 7);
  assert.equal(normalizeAppServerPolicy({ unused_retire_days: 0 }).unused_retire_days, 7, "0 은 «그 값 없음»");
  assert.equal(normalizeAppServerPolicy({ unused_retire_days: "x" }).unused_retire_days, 7);
  assert.equal(normalizeAppServerPolicy({ unused_retire_days: 0.5 }).unused_retire_days, 1, "바닥");
  assert.equal(normalizeAppServerPolicy({ unused_retire_days: 9999 }).unused_retire_days, 365, "천장");
  assert.equal(normalizeAppServerPolicy({ unused_retire_days: 30 }).unused_retire_days, 30);
});

//  #4790 재검토 4 — 실제 어댑터(realLambdaApi)가 태그 묶음을 그대로 넘기는가. 다른 시험은 가짜 api 를 끼워 이 이음매를 지나지 않는다 —
//   여기서 태그가 빠지면 배포는 초록인데 운영에서 그 함수 기록만 사라진다. 전역 fetch 와 env 자격을 잠깐 바꿔 AWS 를 부르지 않는다.
{
  const seen: Array<{ op: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  const keep = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE"; process.env.AWS_SECRET_ACCESS_KEY = "example-secret"; delete process.env.AWS_SESSION_TOKEN;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = String(v);
    const op = String(h["x-amz-target"] ?? "").split(".")[1] ?? "";
    seen.push({ op, body: JSON.parse(String(init?.body ?? "{}")) });
    return op === "CreateLogGroup" ? new Response("{\"__type\":\"ResourceAlreadyExistsException\"}", { status: 400 }) : new Response("{}", { status: 200 });
  }) as typeof fetch;
  const tag = { tags: { "lvly-fn": "lvly-app-x-ws" }, arn: "arn:aws:logs:ap-northeast-2:425515538094:log-group:/aws/lambda/lvly-app-x-ws" };
  try {
    await realLambdaApi("ap-northeast-2").ensureLogGroup("/aws/lambda/lvly-app-x-ws", 14, tag);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["AWS_ACCESS_KEY_ID", keep.id], ["AWS_SECRET_ACCESS_KEY", keep.secret], ["AWS_SESSION_TOKEN", keep.token]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  t("B21 실제 어댑터가 로그 그룹 태그 묶음을 넘긴다 — 만들기에 tags · 있던 그룹은 TagResource(그룹 ARN)", () => {
    assert.deepEqual(seen.map((x) => x.op), ["CreateLogGroup", "TagResource", "PutRetentionPolicy"]);
    assert.deepEqual(seen[0]!.body, { logGroupName: "/aws/lambda/lvly-app-x-ws", tags: tag.tags });
    assert.deepEqual(seen[1]!.body, { resourceArn: tag.arn, tags: tag.tags });
  });
}

//  ── #4801 코드를 우리 S3 에서 바로 읽기(S3ObjectStorageMode REFERENCE) — 사양 엣지 표 S1~S6(spec-4801.md) ──
t("S1 코드 저장 방식 — 기본 바로 읽기 · 'copy'(대소문자 · 빈칸 무시)만 복사 · 그 밖의 값은 기본", () => {
  const base = { LIVELY_APP_SERVER_EXEC_ROLE: ROLE };
  assert.equal(appServerEnv(base)!.codeStorage, "REFERENCE");
  assert.equal(appServerEnv({ ...base, LIVELY_APP_SERVER_CODE_STORAGE: " COPY " })!.codeStorage, "COPY");
  assert.equal(appServerEnv({ ...base, LIVELY_APP_SERVER_CODE_STORAGE: "copy" })!.codeStorage, "COPY");
  assert.equal(appServerEnv({ ...base, LIVELY_APP_SERVER_CODE_STORAGE: "reference" })!.codeStorage, "REFERENCE");
  assert.equal(appServerEnv({ ...base, LIVELY_APP_SERVER_CODE_STORAGE: "copyx" })!.codeStorage, "REFERENCE", "모르는 값은 기본");
});

t("S2 함수에 줄 코드 자리 — 바로 읽기는 판 번호까지(모르면 칸째 빼고 Lambda 가 지금 판으로) · 복사는 #4484 그대로(판 번호 · 모드 없음)", () => {
  assert.deepEqual(functionCodeFor({ codeStorage: "REFERENCE" }, "b", "t/w/z/a/k.zip", "v1"), { S3Bucket: "b", S3Key: "t/w/z/a/k.zip", S3ObjectVersion: "v1", S3ObjectStorageMode: "REFERENCE" });
  const noVer = functionCodeFor({ codeStorage: "REFERENCE" }, "b", "k", null);
  assert.deepEqual(noVer, { S3Bucket: "b", S3Key: "k", S3ObjectStorageMode: "REFERENCE" });
  assert.ok(!("S3ObjectVersion" in noVer), "빈 판 번호 칸을 싣지 않는다(빈 글은 Lambda 가 거절)");
  assert.deepEqual(functionCodeFor({ codeStorage: "COPY" }, "b", "k", "v1"), { S3Bucket: "b", S3Key: "k" }, "복사에 판 번호를 주면 부르는 쪽에 GetObjectVersion 이 따로 든다");
});

t("S3 지금 코드가 바라는 자리에 있나 — 저장 방식 · 버킷 · 키 · 판(바라는 쪽에 판 번호가 없으면 키까지만)", () => {
  const want = functionCodeFor({ codeStorage: "REFERENCE" }, "b", "k", "v1");
  const ref = (o: Record<string, string>) => ({ RepositoryType: "S3", ResolvedS3Object: { S3Bucket: "b", S3Key: "k", S3ObjectVersion: "v1", ...o } });
  assert.equal(codeAt(ref({}), want), true, "S3a");
  assert.equal(codeAt(ref({ S3ObjectVersion: "v2" }), want), false, "S3b 다른 판");
  assert.equal(codeAt(ref({ S3Key: "k2" }), want), false, "S3b 다른 키");
  assert.equal(codeAt(ref({ S3Bucket: "b2" }), want), false, "S3b 다른 버킷");
  assert.equal(codeAt({ RepositoryType: "S3", ResolvedS3Object: null }, want), false, "S3c 복사로 만든 옛 함수 → 바로 읽기로 옮긴다");
  assert.equal(codeAt(undefined, want), false, "S3d 코드 자리를 못 받았으면 다시 올린다(넉넉한 쪽)");
  assert.equal(codeAt(ref({ S3ObjectVersion: "v9" }), functionCodeFor({ codeStorage: "REFERENCE" }, "b", "k", null)), true, "S3e 판 번호 모르는 옛 빌드 — 키가 같으면 그대로");
  const copy = functionCodeFor({ codeStorage: "COPY" }, "b", "k", "v1");
  assert.equal(codeAt({ RepositoryType: "S3", ResolvedS3Object: null }, copy), true, "S3f 복사 → 복사");
  assert.equal(codeAt(undefined, copy), true, "S3f 코드 자리 없음 = 복사로 본다");
  assert.equal(codeAt(ref({}), copy), false, "S3f 바로 읽기 함수를 복사로 되돌린다(env 로 끈 뒤)");
});

t("S4 zip 없음 판독 — 복사 · 바로 읽기 · 지움 표시 글(2026-10-16 실제 원문)은 무효로 · 권한 거절 글은 아니다", () => {
  const missing = [
    "Error occurred while GetObject. S3 Error Code: NoSuchKey. S3 Error Message: The specified key does not exist.",
    "The specified S3 object does not exist: s3://lvly-cloud-appbundles-(계정)/t/w/z/a/k.zip (versionId=GphB). Verify the object exists and the versionId is correct.",
    "The specified S3 object does not exist: s3://b/t/w/z/a/none.zip. Verify the object exists in the bucket.",
    "The latest version of the S3 object is a delete marker. Upload a new object version or pass an explicit S3ObjectVersion.",
  ];
  const denied = [
    "Lambda service principal lambda.amazonaws.com does not have s3:GetObject and s3:GetObjectVersion permission on s3://b/t/w/z/a/k.zip. Update the bucket policy to grant the Lambda service principal access and retry.",
    "The caller cannot access the referenced S3 object. Be sure to grant the caller s3:GetObject and s3:GetObjectVersion permission for the referenced object.",
    "Error occurred while GetObject. S3 Error Code: AccessDenied. S3 Error Message: Access Denied",
  ];
  for (const m of missing) assert.ok(ZIP_MISSING_RE.test(m), m);
  for (const m of denied) assert.ok(!ZIP_MISSING_RE.test(m), m);
  assert.ok(REFERENCE_PERMISSION_RE.test(denied[0]!) && REFERENCE_PERMISSION_RE.test(denied[1]!));
  assert.ok(!missing.some((m) => REFERENCE_PERMISSION_RE.test(m)) && !REFERENCE_PERMISSION_RE.test(denied[2]!));
});

t("S5 바로 읽기 권한 거절은 플랫폼 문제로 보인다 — 400 InvalidParameterValueException 이어도 코드 · 요청 번호만(버킷 · 계정 번호를 싣지 않음)", () => {
  const e = new AwsError(400, "InvalidParameterValueException",
    "lambda POST /x 실패: 400 InvalidParameterValueException — Lambda service principal lambda.amazonaws.com does not have s3:GetObject and s3:GetObjectVersion permission on s3://lvly-cloud-appbundles-425515538094/t/w/z/a/k.zip.", "req-9");
  const m = publicError(e);
  assert.ok(m.includes("플랫폼 쪽 AWS 권한") && m.includes("req-9"), m);
  assert.ok(!m.includes("425515538094") && !m.includes("appbundles"), m);
  const caller = new AwsError(403, "AccessDeniedException", "The caller cannot access the referenced S3 object. Be sure to grant the caller s3:GetObject and s3:GetObjectVersion permission for the referenced object.", "req-10");
  assert.ok(publicError(caller).includes("플랫폼 쪽 AWS 권한"));
});

t("S5b zip 없음 원문도 버킷 · 키를 싣지 않는다 — 정해 둔 글 + 요청 번호(격리 리뷰 막을 것 1) · 그 밖의 AWS 글은 s3:// 주소를 걷는다", () => {
  const missing = new AwsError(400, "InvalidParameterValueException",
    "lambda PUT /x 실패: 400 InvalidParameterValueException — The specified S3 object does not exist: s3://lvly-cloud-appbundles-425515538094/t/a4b6/z/app/abc.zip (versionId=GphB). Verify the object exists and the versionId is correct.", "req-11");
  const m = publicError(missing);
  assert.ok(m.includes("빌드 결과(zip)를 저장소에서 찾지 못했습니다") && m.includes("req-11"), m);
  assert.ok(!/appbundles|425515538094|s3:\/\/|\/z\//.test(m), m);
  const other = new AwsError(400, "InvalidParameterValueException", "Something about s3://lvly-cloud-appbundles-425515538094/t/x/z/y.zip went wrong", "req-12");
  const o = publicError(other);
  assert.ok(!/appbundles|425515538094|s3:\/\//.test(o) && o.includes("(저장소 객체)") && o.includes("req-12"), o);
  assert.equal(scrubAws("arn:aws:lambda:ap-northeast-2:425515538094:function:x · s3://b/k · 425515538094"), "(AWS 자원) · (저장소 객체) · (계정)");
});

//  S6 실제 어댑터(realLambdaApi)가 코드 자리 칸(판 번호 · 모드)을 떨어뜨리지 않고 보내는가 — 가짜 api 를 쓰는 다른 시험은 이 이음매를 지나지 않는다.
{
  const seen: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  const keep = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE"; process.env.AWS_SECRET_ACCESS_KEY = "example-secret"; delete process.env.AWS_SESSION_TOKEN;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ method: String(init?.method), url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ FunctionName: "f", FunctionArn: "arn" }), { status: 200 });
  }) as typeof fetch;
  const code = functionCodeFor({ codeStorage: "REFERENCE" }, "b", "t/w/z/a/k.zip", "v1");
  try {
    const api = realLambdaApi("ap-northeast-2");
    await api.createFunction({ FunctionName: "lvly-app-a-ws", Runtime: "nodejs22.x", Role: ROLE, Handler: "h", Code: code, Architectures: ["arm64"], MemorySize: 512, Timeout: 30, Layers: [], Environment: { Variables: {} } });
    await api.updateFunctionCode("lvly-app-a-ws", code);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["AWS_ACCESS_KEY_ID", keep.id], ["AWS_SECRET_ACCESS_KEY", keep.secret], ["AWS_SESSION_TOKEN", keep.token]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  t("S6 실제 어댑터가 판 번호 · 저장 방식을 그대로 보낸다 — 만들기 Code · 코드 고치기 본문(+ Publish false)", () => {
    assert.equal(seen.length, 2, "두 번 불렸다(배선)");
    assert.deepEqual(seen[0]!.body.Code, code);
    assert.ok(seen[1]!.method === "PUT" && seen[1]!.url.endsWith("/functions/lvly-app-a-ws/code"), seen[1]!.url);
    assert.deepEqual(seen[1]!.body, { ...code, Publish: false });
  });
}

// ── #4486 앱 v2-7 백그라운드 작업 — 함수 하나 · 함수 시간 = 작업 시간 · 사람 요청 시간은 검사 층이 끊는다 · 크기는 앱 선언 ──
t("J1 함수 크기 선언(web.server.memory_mb · tmp_mb) — Lambda 범위의 정수만 · 밖이면 null(기본값)", () => {
  assert.deepEqual(serverDeclOf({ web: { server: { memory_mb: 2048, tmp_mb: 4096 } } }), { start: null, build: null, dir: null, memory_mb: 2048, tmp_mb: 4096 });
  for (const [m, want] of [[128, 128], [10_240, 10_240], [127, null], [10_241, null], [1.5, null], ["1024", null], [-1, null]] as const) {
    assert.equal(serverDeclOf({ web: { server: { memory_mb: m } } })?.memory_mb, want, `memory_mb ${m}`);
  }
  for (const [m, want] of [[512, 512], [10_240, 10_240], [511, null], [10_241, null]] as const) assert.equal(serverDeclOf({ web: { server: { tmp_mb: m } } })?.tmp_mb, want, `tmp_mb ${m}`);
});

t("J2 함수 크기 — 선언 없으면 워크스페이스 기본(512 · 임시 512) · 선언은 천장까지 줄이고 알림 · 못 읽은 선언도 알림", () => {
  const pol = { memory_mb: 512, memory_max_mb: 4096 };
  assert.deepEqual(functionSizingFor({ web: { server: {} } }, pol), { memory: 512, tmp: 512, notes: [] });
  assert.deepEqual(functionSizingFor(null, pol), { memory: 512, tmp: 512, notes: [] }, "판 매니페스트를 못 읽은 상태 점검 길");
  assert.deepEqual(functionSizingFor({ web: { server: { memory_mb: 3008, tmp_mb: 2048 } } }, pol), { memory: 3008, tmp: 2048, notes: [] });
  const cut = functionSizingFor({ web: { server: { memory_mb: 8192 } } }, pol);
  assert.equal(cut.memory, 4096);
  assert.match(cut.notes[0]!, /8192MB.*4096MB/);
  const bad = functionSizingFor({ web: { server: { memory_mb: "big", tmp_mb: 100 } } }, pol);
  assert.deepEqual([bad.memory, bad.tmp], [512, 512]);
  assert.equal(bad.notes.length, 2, "못 읽은 두 선언을 모두 알린다");
});

t("J3 함수 환경 — 사람 요청 시간(LIVELY_REQUEST_TIMEOUT_S)을 검사 층에 늘 넘긴다(앱 값을 싣는 함수엔 빠질 수 없다)", () => {
  const rt = { tenantId: "11111111-2222-4333-8444-555555555555", slug: "w", apiUrl: "https://w.app.lvly.io", token: "t", identityPubkeys: "{}" };
  assert.equal(lambdaEnvFor("a", { ...rt, requestTimeoutS: 30 }).LIVELY_REQUEST_TIMEOUT_S, "30");
  assert.equal(lambdaEnvFor("a", { ...rt, requestTimeoutS: 60 }).LIVELY_REQUEST_TIMEOUT_S, "60");
});

t("J4 설정 비교 — 임시 디스크가 다르면 고친다 · AWS 가 칸을 안 보이면 512 로 본다 · want 에 없으면 보지 않는다(옛 부르는 쪽)", () => {
  const base = { role: "r", handler: "h", runtime: "nodejs22.x", memory: 512, timeout: 900, layers: ["L1"], vars: { A: "1" } };
  const cfg = (o: Partial<FnConfiguration> = {}): FnConfiguration => ({ FunctionName: "f", FunctionArn: "a", Role: "r", Handler: "h", Runtime: "nodejs22.x", MemorySize: 512, Timeout: 900,
    Layers: [{ Arn: "L1" }], Environment: { Variables: { A: "1" } }, ...o });
  assert.deepEqual(configDrift(cfg(), { ...base, tmp: 512 }), {}, "칸이 없는 함수 = 512");
  assert.deepEqual(configDrift(cfg({ EphemeralStorage: { Size: 512 } }), { ...base, tmp: 2048 }).EphemeralStorage, { Size: 2048 });
  assert.deepEqual(configDrift(cfg({ EphemeralStorage: { Size: 2048 } }), base), {}, "tmp 를 안 주면 보지 않는다");
  assert.deepEqual(configDrift(cfg({ Timeout: 30 }), { ...base, tmp: 512 }).Timeout, 900, "옛 함수(요청 시간 30초)는 작업 시간으로 고친다");
});

t("J5 작업 상한 — 기본(함수 900초 · 메모리 천장 10GB · 동시 10/5 · 대기 100 · 하루 1,000 · 대기 30분 · 본문 256KB) · 앱 동시 ≤ 워크스페이스 · 기본 메모리 ≤ 천장", () => {
  const d = APP_SERVER_POLICY_DEFAULT;
  assert.deepEqual([d.job_timeout_s, d.memory_max_mb, d.jobs_running_workspace, d.jobs_running_app, d.jobs_queued_app, d.jobs_daily_app, d.job_wait_s, d.job_body_kb],
    [900, 10_240, 10, 5, 100, 1000, 1800, 256]);
  assert.equal(APP_SERVER_POLICY_MAX.job_timeout_s, 900, "Lambda 의 끝");
  assert.equal(APP_SERVER_POLICY_MAX.memory_mb, 10_240);
  assert.ok(APP_SERVER_POLICY_MAX.job_body_kb * 1024 * 4 / 3 < 1_000_000, "본문 천장의 base64 가 비동기 호출 한도(1MB) 안");
  assert.equal(normalizeAppServerPolicy({ jobs_running_workspace: 3, jobs_running_app: 8 }).jobs_running_app, 3);
  assert.equal(normalizeAppServerPolicy({ jobs_running_workspace: 3, jobs_running_app: 8 }, APP_SERVER_POLICY_DEFAULT, { effective: false }).jobs_running_app, 8, "저장은 준 값 그대로");
  assert.equal(normalizeAppServerPolicy({ memory_mb: 8192, memory_max_mb: 2048 }).memory_mb, 2048);
  assert.equal(normalizeAppServerPolicy({ job_timeout_s: 10 }).job_timeout_s, 60, "바닥 60초");
  assert.equal(APP_SERVER_POLICY_MIN.job_timeout_s, 60);
  //  작업 기록 보존(일) — 기본 30 · 바닥 1 · 천장 3650(작업 컨테이너 keep_days 와 같은 자리 · 0 은 «값 없음» = 기본).
  assert.deepEqual([d.job_keep_days, APP_SERVER_POLICY_MIN.job_keep_days, APP_SERVER_POLICY_MAX.job_keep_days], [30, 1, 3650]);
  assert.equal(normalizeAppServerPolicy({ job_keep_days: 0 }).job_keep_days, 30);
  assert.equal(normalizeAppServerPolicy({ job_keep_days: 99_999 }).job_keep_days, 3650);
});

//  S7 재사용 판정이 기대는 이음매 — 실제 어댑터의 getFunction 이 판(Qualifier)을 실어 보내고 Code(코드 자리)를 그대로 돌려주는가(격리 리뷰).
{
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const keep = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE"; process.env.AWS_SECRET_ACCESS_KEY = "example-secret"; delete process.env.AWS_SESSION_TOKEN;
  const body = { Configuration: { FunctionName: "f", FunctionArn: "arn", State: "Active" }, Code: { RepositoryType: "S3", ResolvedS3Object: { S3Bucket: "b", S3Key: "k", S3ObjectVersion: "v3" } }, Tags: { "lvly:tenant": "t" } };
  globalThis.fetch = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  let atVer: unknown = null; let atLatest: unknown = null;
  try {
    const api = realLambdaApi("ap-northeast-2");
    atVer = await api.getFunction("lvly-app-a-ws", "3");
    atLatest = await api.getFunction("lvly-app-a-ws");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["AWS_ACCESS_KEY_ID", keep.id], ["AWS_SECRET_ACCESS_KEY", keep.secret], ["AWS_SESSION_TOKEN", keep.token]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  t("S7 실제 어댑터 getFunction — 판을 주면 ?Qualifier=판 · 안 주면 없음 · Code.ResolvedS3Object 를 그대로 돌려준다", () => {
    assert.equal(urls.length, 2);
    assert.ok(urls[0]!.endsWith("/2015-03-31/functions/lvly-app-a-ws?Qualifier=3"), urls[0]);
    assert.ok(urls[1]!.endsWith("/2015-03-31/functions/lvly-app-a-ws") && !urls[1]!.includes("Qualifier"), urls[1]);
    assert.deepEqual((atVer as { Code?: unknown })?.Code, body.Code);
    assert.deepEqual((atLatest as { Code?: unknown })?.Code, body.Code);
  });
}

console.log(`\n${pass} passed`);

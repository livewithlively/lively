// 앱 서버 순수 판정(#4484) 단위 시험 — 서버 선언 · 함수 이름 · 빌드 지문 · 배포 설정 · 시험 호출 판독 · 상한 정규화 · 자동 멈춤.
// 실행: npm run build && node dist/apps/app-server-config.test.js
//  B1~B12 는 사양 엣지 표(spec-4484.md B절 · E절)의 행 번호다.
import assert from "node:assert/strict";
import { GUARD_ENV, appServerApiUrl, appServerEnv, buildKeyOf, functionNameFor, lambdaEnvFor, serverDeclOf, smokeFailure, zipKeyFor } from "./app-server-config.js";
import { APP_SERVER_POLICY_DEFAULT, APP_SERVER_POLICY_MAX, APP_SERVER_POLICY_MIN, autoStopReason, envAppServerPolicy, normalizeAppServerPolicy, retentionDaysFor } from "./app-server-policy.js";
import type { AppBundle } from "./app-bundle.js";
import { configDrift, publicError } from "./app-server-deploy.js";
import { GUARD_BOOTSTRAP_PATH, GUARD_PORT, GUARD_READY_PATH } from "./app-server-guard.js";
import type { FnConfiguration } from "../net/aws/lambda-lite.js";
import { appServerEnabledFor } from "./app-server-config.js";
import { withTenant } from "../org/tenant-context.js";
import { AwsError } from "../net/aws/aws-json.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const h = (c: string): string => c.repeat(64).slice(0, 64);

t("B1 서버 선언 — true · 객체(다듬음) · 없음 · 배열 · 문자열", () => {
  assert.deepEqual(serverDeclOf({ web: { server: true } }), { start: null, build: null, dir: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "  node s.js ", build: "npm run b" } } }), { start: "node s.js", build: "npm run b", dir: null });
  assert.equal(serverDeclOf({ web: { root: "dist" } }), null);
  assert.equal(serverDeclOf({}), null);
  assert.equal(serverDeclOf(null), null);
  assert.equal(serverDeclOf({ web: { server: [] } }), null);
  assert.equal(serverDeclOf({ web: { server: "node s.js" } }), null);
});

t("B2 서버 선언 칸 — 빈 글 · 2,001자 · NUL · 숫자는 null(=package.json 을 쓴다)", () => {
  assert.deepEqual(serverDeclOf({ web: { server: { start: "   " } } }), { start: null, build: null, dir: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "x".repeat(2001), build: "a\0b" } } }), { start: null, build: null, dir: null });
  assert.deepEqual(serverDeclOf({ web: { server: { start: "x".repeat(2000) } } })?.start?.length, 2000);
  assert.deepEqual(serverDeclOf({ web: { server: { start: 5 } } }), { start: null, build: null, dir: null });
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
const decl = { start: null, build: null, dir: null };
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
  assert.deepEqual(e, { region: "ap-northeast-2", execRoleArn: ROLE, layerArn: "arn:aws:lambda:ap-northeast-2:753240598075:layer:LambdaAdapterLayerArm64:30", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64" });
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
  const env = lambdaEnvFor("my-app", { tenantId: "11111111-2222-4333-8444-555555555555".toUpperCase(), slug: "lively-46e3", apiUrl: "https://lively-46e3.app.lvly.io", token: "lvk_x", identityPubkeys: "{\"k1\":\"x\"}" });
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

console.log(`\n${pass} passed`);

// 앱 서버 순수 판정(#4484) 단위 시험 — 서버 선언 · 함수 이름 · 빌드 지문 · 배포 설정 · 시험 호출 판독 · 상한 정규화 · 자동 멈춤.
// 실행: npm run build && node dist/apps/app-server-config.test.js
//  B1~B12 는 사양 엣지 표(spec-4484.md B절 · E절)의 행 번호다.
import assert from "node:assert/strict";
import { appServerEnv, buildKeyOf, functionNameFor, lambdaEnvFor, serverDeclOf, smokeFailure, zipKeyFor } from "./app-server-config.js";
import { APP_SERVER_POLICY_DEFAULT, APP_SERVER_POLICY_MAX, APP_SERVER_POLICY_MIN, autoStopReason, envAppServerPolicy, normalizeAppServerPolicy, retentionDaysFor } from "./app-server-policy.js";
import type { AppBundle } from "./app-bundle.js";
import { publicError } from "./app-server-deploy.js";
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
  const env = lambdaEnvFor("my-app");
  assert.equal(env.AWS_LAMBDA_EXEC_WRAPPER, "/opt/bootstrap");
  assert.equal(env.AWS_LWA_READINESS_CHECK_PROTOCOL, "tcp", "«/» 가 500 이어도 뜬다(2026-10-15 실측)");
  assert.equal(env.PORT, env.AWS_LWA_PORT);
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

console.log(`\n${pass} passed`);

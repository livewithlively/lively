// AWS JSON 호출 · Lambda · Logs · 지표 클라이언트(#4484) 단위 시험 — 가짜 fetch 가 실제로 받은 주소 · 머리 · 본문 · 횟수로 본다.
// 실행: npm run build && node dist/net/aws/lambda-lite.test.js
//  C1~C9 는 사양 엣지 표(spec-4484.md C절)의 행 번호다(C10 서명 주소는 s3-lite.test P1·P2).
import assert from "node:assert/strict";
import { awsCall, awsErrorOf, AwsError, type AwsDeps } from "./aws-json.js";
import { signRequestV4 } from "./aws-sigv4.js";
import { deleteFunction, ensureLogGroup, getFunction, getMetricData, invoke, putAlias } from "./lambda-lite.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const NOW = new Date("2026-10-15T00:00:00Z");

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }
type Reply = { status: number; body?: string; headers?: Record<string, string> } | "net";
function fake(replies: Reply[] | ((s: Seen, i: number) => Reply)): { deps: AwsDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = String(v);
    const s: Seen = { url: String(url), method: String(init?.method), headers: h, body: init?.body ? String(init.body) : "" };
    seen.push(s);
    const r = typeof replies === "function" ? replies(s, seen.length - 1) : (replies[seen.length - 1] ?? replies[replies.length - 1]!);
    if (r === "net") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return new Response(r.body ?? "", { status: r.status, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return { deps: { creds: async () => creds, fetch: f, now: () => NOW, retryDelayMs: 0 }, seen };
}
const c = { region: "ap-northeast-2" };

await t("C1 경로 조각 — 보내는 주소는 한 번, 서명은 두 번 인코딩(Lambda 등 S3 밖 서비스 규칙)", async () => {
  const { deps, seen } = fake([{ status: 200, body: "{}" }]);
  await awsCall({ service: "lambda", region: "ap-northeast-2", host: "lambda.ap-northeast-2.amazonaws.com", method: "GET", path: ["2015-03-31", "functions", "a b:c"] }, deps);
  assert.equal(new URL(seen[0]!.url).pathname, "/2015-03-31/functions/a%20b%3Ac");
  const want = signRequestV4({ method: "GET", host: "lambda.ap-northeast-2.amazonaws.com", path: "/2015-03-31/functions/a%2520b%253Ac", region: "ap-northeast-2", service: "lambda", body: "", headers: {}, creds, now: NOW, query: "" });
  assert.equal(seen[0]!.headers.authorization, want.Authorization);
});

await t("C2 오류 코드 — x-amzn-errortype > __type > Type > HTTP<상태>", () => {
  const H = (o: Record<string, string>): Headers => new Headers(o);
  assert.equal(awsErrorOf(404, H({ "x-amzn-errortype": "ResourceNotFoundException:http://internal.amazon.com/coral/" }), "{\"Message\":\"m\"}", "w").code, "ResourceNotFoundException");
  assert.equal(awsErrorOf(400, H({}), "{\"__type\":\"com.amazonaws.logs#ResourceAlreadyExistsException\",\"message\":\"x\"}", "w").code, "ResourceAlreadyExistsException");
  assert.equal(awsErrorOf(400, H({}), "{\"Type\":\"User\"}", "w").code, "User");
  assert.equal(awsErrorOf(502, H({}), "<html>", "w").code, "HTTP502");
  assert.equal(awsErrorOf(400, H({ "x-amzn-requestid": "rid-1" }), "{}", "w").requestId, "rid-1");
});

await t("C3 429 · 5xx · 연결 실패는 다시 한다(attempts 까지)", async () => {
  const a = fake([{ status: 429, headers: { "x-amzn-errortype": "TooManyRequestsException" } }, { status: 503 }, { status: 200, body: "{\"ok\":1}" }]);
  const r = await awsCall({ service: "lambda", region: "x", host: "h", method: "POST", path: ["p"], body: {} }, a.deps);
  assert.equal(a.seen.length, 3);
  assert.equal(r.status, 200);
  const b = fake(["net", { status: 200, body: "{}" }]);
  await awsCall({ service: "lambda", region: "x", host: "h", method: "GET", path: ["p"] }, b.deps);
  assert.equal(b.seen.length, 2);
  const d = fake([{ status: 500 }]);
  await assert.rejects(awsCall({ service: "lambda", region: "x", host: "h", method: "GET", path: ["p"] }, { ...d.deps, attempts: 2 }), (e: unknown) => e instanceof AwsError && e.status === 500);
  assert.equal(d.seen.length, 2, "attempts 를 넘지 않는다");
});

await t("C4 4xx(조절 아님) · 자격 없음은 다시 하지 않는다", async () => {
  const a = fake([{ status: 400, headers: { "x-amzn-errortype": "InvalidParameterValueException" } }, { status: 200 }]);
  await assert.rejects(awsCall({ service: "lambda", region: "x", host: "h", method: "POST", path: ["p"], body: {} }, a.deps), (e: unknown) => e instanceof AwsError && e.code === "InvalidParameterValueException");
  assert.equal(a.seen.length, 1);
  const b = fake([{ status: 200 }]);
  await assert.rejects(awsCall({ service: "lambda", region: "x", host: "h", method: "GET", path: ["p"] }, { ...b.deps, creds: async () => null }), (e: unknown) => e instanceof AwsError && e.code === "NoCredentials");
  assert.equal(b.seen.length, 0, "자격이 없으면 부르지도 않는다");
});

await t("C5 함수 조회 404 → null · 함수 지우기 404 → 성공", async () => {
  const nf = { status: 404, headers: { "x-amzn-errortype": "ResourceNotFoundException" }, body: "{\"Message\":\"Function not found\"}" };
  assert.equal(await getFunction(c, "lvly-app-x", undefined, fake([nf]).deps), null);
  const d = fake([nf]);
  await deleteFunction(c, "lvly-app-x", "3", d.deps);
  assert.equal(new URL(d.seen[0]!.url).searchParams.get("Qualifier"), "3");
  assert.equal(d.seen[0]!.method, "DELETE");
});

await t("C6 부르기 — 한 번만(5xx 여도) · 함수 오류 · 기록(base64 풀기) · 실행 판 · Tail 요청", async () => {
  const a = fake([{ status: 200, body: "{\"errorType\":\"Runtime.ExitError\"}", headers: { "x-amz-function-error": "Unhandled", "x-amz-log-result": Buffer.from("START\nboom\nEND").toString("base64"), "x-amz-executed-version": "7" } }]);
  const r = await invoke(c, "lvly-app-x", "7", { a: 1 }, {}, a.deps);
  assert.equal(r.functionError, "Unhandled");
  assert.equal(r.log, "START\nboom\nEND");
  assert.equal(r.executedVersion, "7");
  assert.equal(a.seen[0]!.headers["x-amz-log-type"], "Tail");
  assert.equal(a.seen[0]!.headers["x-amz-invocation-type"], "RequestResponse");
  assert.equal(new URL(a.seen[0]!.url).searchParams.get("Qualifier"), "7");
  assert.deepEqual(JSON.parse(a.seen[0]!.body), { a: 1 });
  const b = fake([{ status: 502 }, { status: 200 }]);
  await assert.rejects(invoke(c, "lvly-app-x", "7", {}, {}, b.deps));
  assert.equal(b.seen.length, 1, "부르기는 다시 하지 않는다(앱 코드가 두 번 돌 수 있다)");
});

await t("C7 별칭 — 없으면 만들고 · 있으면 옮기고 · 만들다 겹치면 옮긴다", async () => {
  const nf = { status: 404, headers: { "x-amzn-errortype": "ResourceNotFoundException" } };
  const mk = fake([nf, { status: 201, body: "{\"Name\":\"cur\",\"FunctionVersion\":\"3\"}" }]);
  assert.equal((await putAlias(c, "f", "cur", "3", "d", mk.deps)).FunctionVersion, "3");
  assert.deepEqual(mk.seen.map((s) => s.method), ["GET", "POST"]);
  const up = fake([{ status: 200, body: "{\"Name\":\"cur\",\"FunctionVersion\":\"2\"}" }, { status: 200, body: "{\"Name\":\"cur\",\"FunctionVersion\":\"4\"}" }]);
  await putAlias(c, "f", "cur", "4", "d", up.deps);
  assert.deepEqual(up.seen.map((s) => s.method), ["GET", "PUT"]);
  assert.equal(JSON.parse(up.seen[1]!.body).FunctionVersion, "4");
  const race = fake([nf, { status: 409, headers: { "x-amzn-errortype": "ResourceConflictException" } }, { status: 200, body: "{\"FunctionVersion\":\"5\"}" }]);
  await putAlias(c, "f", "pub", "5", "d", race.deps);
  assert.deepEqual(race.seen.map((s) => s.method), ["GET", "POST", "PUT"]);
});

await t("C8 로그 그룹 — 이미 있어도 보관 기간을 건다(JSON 1.1 · 대상 머리)", async () => {
  const a = fake([{ status: 400, body: "{\"__type\":\"ResourceAlreadyExistsException\"}" }, { status: 200, body: "{}" }]);
  await ensureLogGroup(c, "/aws/lambda/lvly-app-x", 14, null, a.deps);
  assert.deepEqual(a.seen.map((s) => s.headers["x-amz-target"]), ["Logs_20140328.CreateLogGroup", "Logs_20140328.PutRetentionPolicy"]);
  assert.equal(a.seen[1]!.headers["content-type"], "application/x-amz-json-1.1");
  assert.deepEqual(JSON.parse(a.seen[1]!.body), { logGroupName: "/aws/lambda/lvly-app-x", retentionInDays: 14 });
  assert.equal(new URL(a.seen[0]!.url).host, "logs.ap-northeast-2.amazonaws.com");
  const b = fake([{ status: 400, body: "{\"__type\":\"AccessDeniedException\"}" }]);
  await assert.rejects(ensureLogGroup(c, "/aws/lambda/x", 14, null, b.deps));
});

//  #4790 — 실행 역할의 쓰기 조건이 로그 그룹 태그 lvly-fn 을 본다. 새 그룹은 만들 때 달고 · 있던 그룹은 TagResource 로 단다.
const ARN = "arn:aws:logs:ap-northeast-2:111122223333:log-group:/aws/lambda/lvly-app-x";
await t("C8b 로그 그룹 태그 — 새 그룹: 만들 때 tags 를 싣고 TagResource 는 부르지 않는다", async () => {
  const a = fake([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
  await ensureLogGroup(c, "/aws/lambda/lvly-app-x", 14, { tags: { "lvly-fn": "lvly-app-x" }, arn: ARN }, a.deps);
  assert.deepEqual(a.seen.map((s) => s.headers["x-amz-target"]), ["Logs_20140328.CreateLogGroup", "Logs_20140328.PutRetentionPolicy"]);
  assert.deepEqual(JSON.parse(a.seen[0]!.body), { logGroupName: "/aws/lambda/lvly-app-x", tags: { "lvly-fn": "lvly-app-x" } });
});
await t("C8c 로그 그룹 태그 — 이미 있던 그룹: TagResource(그룹 ARN · 끝 :* 없이)로 달고 보관 기간", async () => {
  const a = fake([{ status: 400, body: "{\"__type\":\"ResourceAlreadyExistsException\"}" }, { status: 200, body: "{}" }, { status: 200, body: "{}" }]);
  await ensureLogGroup(c, "/aws/lambda/lvly-app-x", 14, { tags: { "lvly-fn": "lvly-app-x" }, arn: ARN }, a.deps);
  assert.deepEqual(a.seen.map((s) => s.headers["x-amz-target"]), ["Logs_20140328.CreateLogGroup", "Logs_20140328.TagResource", "Logs_20140328.PutRetentionPolicy"]);
  assert.deepEqual(JSON.parse(a.seen[1]!.body), { resourceArn: ARN, tags: { "lvly-fn": "lvly-app-x" } });
});
//  태그만 주고 ARN 을 빠뜨리는 꼴은 타입(LogGroupTag — 둘이 한 묶음)이 막는다(재검토 4 — 런타임 가드를 걷었다).
await t("C8d 로그 그룹 태그 — 빈 태그는 싣지 않는다(종전 그대로 · 있던 그룹에도 TagResource 없음)", async () => {
  const b = fake([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
  await ensureLogGroup(c, "/aws/lambda/lvly-app-x", 14, { tags: {}, arn: ARN }, b.deps);
  assert.deepEqual(JSON.parse(b.seen[0]!.body), { logGroupName: "/aws/lambda/lvly-app-x" }, "빈 태그는 싣지 않는다");
  const e = fake([{ status: 400, body: "{\"__type\":\"ResourceAlreadyExistsException\"}" }, { status: 200, body: "{}" }]);
  await ensureLogGroup(c, "/aws/lambda/lvly-app-x", 14, { tags: {}, arn: ARN }, e.deps);
  assert.deepEqual(e.seen.map((s) => s.headers["x-amz-target"]), ["Logs_20140328.CreateLogGroup", "Logs_20140328.PutRetentionPolicy"]);
});

await t("C9 지표 — 500개씩 나눠 묻고 · 다음 쪽(NextToken)까지 합친다", async () => {
  const queries = Array.from({ length: 501 }, (_, i) => ({ id: `q${i}`, fn: `lvly-app-${i}`, metric: "Invocations" as const, stat: "Sum" as const }));
  const a = fake((s) => {
    const body = JSON.parse(s.body) as { MetricDataQueries: Array<{ Id: string }>; NextToken?: string };
    if (body.MetricDataQueries.length === 500 && !body.NextToken) return { status: 200, body: JSON.stringify({ MetricDataResults: [{ Id: "q0", Values: [1], Timestamps: [1] }], NextToken: "n2" }) };
    if (body.NextToken === "n2") return { status: 200, body: JSON.stringify({ MetricDataResults: [{ Id: "q0", Values: [2], Timestamps: [2] }] }) };
    return { status: 200, body: JSON.stringify({ MetricDataResults: [{ Id: "q500", Values: [9], Timestamps: [3] }] }) };
  });
  const r = await getMetricData(c, queries, { start: new Date(0), end: new Date(600_000), periodSec: 300 }, a.deps);
  assert.equal(a.seen.length, 3);
  assert.equal(a.seen[0]!.headers["x-amz-target"], "GraniteServiceVersion20100801.GetMetricData");
  assert.equal(JSON.parse(a.seen[2]!.body).MetricDataQueries.length, 1);
  assert.deepEqual(r.find((x) => x.id === "q0")!.values, [1, 2]);
  assert.deepEqual(r.find((x) => x.id === "q500")!.values, [9]);
  assert.equal(JSON.parse(a.seen[0]!.body).MetricDataQueries[0].MetricStat.Metric.Dimensions[0].Value, "lvly-app-0");
});

console.log(`\n${pass} passed`);

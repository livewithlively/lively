// AWS JSON 호출 · Lambda · Logs · 지표 클라이언트(#4484) 단위 시험 — 가짜 fetch 가 실제로 받은 주소 · 머리 · 본문 · 횟수로 본다.
// 실행: npm run build && node dist/net/aws/lambda-lite.test.js
//  C1~C8 은 사양 엣지 표(spec-4484.md C절)의 행 번호다(C10 서명 주소는 s3-lite.test P1·P2). C6 부르기 · C9 지표는 #4485 에서 그 코드와 함께 걷었다
//  (시험 호출은 흘려 받기 · 호출 셈은 게이트웨이). L1~L3 은 #4485 사양 표(흘려 받기 · REPORT · 레이어).
import assert from "node:assert/strict";
import { awsCall, awsErrorOf, AwsError, type AwsDeps } from "./aws-json.js";
import { signRequestV4 } from "./aws-sigv4.js";
import { deleteFunction, ensureLogGroup, getFunction, invokeAsync, invokeStream, listLayerVersions, parseReport, publishLayerVersion, putAlias, type StreamEvent } from "./lambda-lite.js";
import { encodeEventStreamMessage } from "./event-stream.js";

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

await t("L1 REPORT 줄 — 시간 · 청구 · 차가운 시작 · 상태(ok · error · timeout) · 오류 형 · 여러 줄이면 마지막 REPORT · 없으면 null", () => {
  const ok = parseReport("START RequestId: a\nEND RequestId: a\nREPORT RequestId: a\tDuration: 12.34 ms\tBilled Duration: 13 ms\tMemory Size: 512 MB\tMax Memory Used: 80 MB\tInit Duration: 255.01 ms\t");
  assert.deepEqual(ok, { durationMs: 12.34, billedMs: 13, initMs: 255.01, status: "ok", errorType: null });
  assert.equal(parseReport("REPORT RequestId: b\tDuration: 3.00 ms\tBilled Duration: 4 ms\tStatus: error\tError Type: Runtime.ExitError")?.errorType, "Runtime.ExitError");
  assert.equal(parseReport("REPORT RequestId: b\tDuration: 3.00 ms\tBilled Duration: 4 ms\tStatus: error")?.status, "error");
  assert.equal(parseReport("REPORT RequestId: c\tDuration: 10000.00 ms\tBilled Duration: 10000 ms\tStatus: timeout")?.status, "timeout");
  assert.equal(parseReport("REPORT RequestId: d\tDuration: 1.00 ms\tBilled Duration: 1 ms\t\nREPORT RequestId: e\tDuration: 2.00 ms\tBilled Duration: 7 ms\t")?.billedMs, 7, "마지막 REPORT");
  assert.equal(parseReport("START RequestId: f\nEND RequestId: f"), null);
  assert.equal(parseReport(""), null);
});

/** 흘려 받기 가짜 — 이벤트 흐름 바이트를 조각째(사이에 기다림) 보낸다 · 부른 쪽 signal 을 따른다(진짜 fetch 처럼). */
function streamFake(frames: Array<Buffer | { wait: number }>, o: { status?: number; headers?: Record<string, string>; hang?: boolean } = {}): { deps: AwsDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = String(v);
    seen.push({ url: String(url), method: String(init?.method), headers: h, body: init?.body ? String(init.body) : "" });
    const signal = init?.signal ?? undefined;
    if (o.hang) return new Promise<Response>((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason), { once: true }));
    if ((o.status ?? 200) >= 400) return new Response("{\"message\":\"Rate Exceeded\"}", { status: o.status, headers: o.headers ?? {} });
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        signal?.addEventListener("abort", () => { try { ctl.error(signal.reason); } catch { /* 이미 닫혔다 */ } }, { once: true });
        for (const fr of frames) {
          if (signal?.aborted) return;
          if (Buffer.isBuffer(fr)) ctl.enqueue(new Uint8Array(fr));
          else await new Promise((r) => setTimeout(r, fr.wait));
        }
        if (!signal?.aborted) ctl.close();
      },
    });
    return new Response(body, { status: 200, headers: { "x-amzn-remapped-content-type": "application/vnd.awslambda.http-integration-response", "x-amz-executed-version": "7", ...(o.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { deps: { creds: async () => creds, fetch: f, now: () => NOW, retryDelayMs: 0 }, seen };
}
const chunkFrame = (d: string): Buffer => encodeEventStreamMessage({ ":event-type": "PayloadChunk", ":message-type": "event" }, Buffer.from(d));
const completeFrame = (o: Record<string, unknown>): Buffer => encodeEventStreamMessage({ ":event-type": "InvokeComplete", ":message-type": "event" }, Buffer.from(JSON.stringify(o)));
async function drain(evs: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> { const out: StreamEvent[] = []; for await (const e of evs) out.push(e); return out; }

await t("L2 흘려 받기 — 경로 · 판 · 머리(Tail · RequestResponse) · 조각 · 끝(ErrorCode · 기록 base64 풀기) · 실행 판 · 틀 머리", async () => {
  const report = "REPORT RequestId: r\tDuration: 3.00 ms\tBilled Duration: 4 ms\t";
  const a = streamFake([chunkFrame("ab"), { wait: 20 }, chunkFrame("cd"), completeFrame({ ErrorCode: "Sandbox.Timedout", ErrorDetails: "late", LogResult: Buffer.from(report).toString("base64") })]);
  const out = await invokeStream(c, "lvly-app-x", "cur", "{\"rawPath\":\"/\"}", { timeoutMs: 5_000, logTail: true }, a.deps);
  const u = new URL(a.seen[0]!.url);
  assert.equal(u.pathname, "/2021-11-15/functions/lvly-app-x/response-streaming-invocations");
  assert.equal(u.searchParams.get("Qualifier"), "cur");
  assert.equal(a.seen[0]!.headers["x-amz-log-type"], "Tail");
  assert.equal(a.seen[0]!.headers["x-amz-invocation-type"], "RequestResponse");
  assert.equal(a.seen[0]!.body, "{\"rawPath\":\"/\"}", "본문은 받은 글 그대로");
  assert.equal(out.executedVersion, "7");
  assert.equal(out.contentType, "application/vnd.awslambda.http-integration-response");
  const evs = await drain(out.events);
  assert.deepEqual(evs.filter((e) => e.type === "chunk").map((e) => (e as { data: Buffer }).data.toString()), ["ab", "cd"]);
  assert.deepEqual(evs.at(-1), { type: "complete", errorCode: "Sandbox.Timedout", errorDetails: "late", log: report });
});

await t("L2 흘려 받기 — 예외 틀이면 그 코드로 AwsError 502 · 429 는 한 번만 부른다(다시 하기 없음) · 응답 없음은 시한 안에 Timeout", async () => {
  const ex = streamFake([chunkFrame("x"), encodeEventStreamMessage({ ":message-type": "exception", ":exception-type": "ServiceException" }, Buffer.from("{\"message\":\"boom\"}"))]);
  const out = await invokeStream(c, "f", "cur", "{}", { timeoutMs: 5_000 }, ex.deps);
  await assert.rejects(drain(out.events), (e: unknown) => e instanceof AwsError && e.status === 502 && e.code === "ServiceException" && /boom/.test(e.message));
  const busy = streamFake([], { status: 429, headers: { "x-amzn-errortype": "TooManyRequestsException" } });
  await assert.rejects(invokeStream(c, "f", "cur", "{}", { timeoutMs: 5_000 }, busy.deps), (e: unknown) => e instanceof AwsError && e.code === "TooManyRequestsException");
  assert.equal(busy.seen.length, 1, "흘려 받기를 다시 했다(앱 코드가 두 번 돈다)");
  const hang = streamFake([], { hang: true });
  const t0 = Date.now();
  //  AbortSignal.timeout 의 시계는 프로세스를 붙잡지 않는다(게이트웨이는 서버가 붙잡는다) — 시험 프로세스가 그 전에 끝나지 않게 잠깐 붙잡는다.
  const keep = setTimeout(() => undefined, 3_000);
  try {
    await assert.rejects(invokeStream(c, "f", "cur", "{}", { timeoutMs: 200 }, hang.deps), (e: unknown) => e instanceof AwsError && e.code === "Timeout");
  } finally { clearTimeout(keep); }
  assert.ok(Date.now() - t0 < 2_000, `시한(200ms)을 넘겨 기다렸다: ${Date.now() - t0}ms`);
});

await t("L2 흘려 받기 — 도중에 끊으면(signal) 흐름이 거절로 끝난다 · 처리 안 된 거절 0", async () => {
  let unhandled = 0;
  const onUnhandled = (): void => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const ac = new AbortController();
    const a = streamFake([chunkFrame("first"), { wait: 5_000 }, chunkFrame("never")]);
    const out = await invokeStream(c, "f", "cur", "{}", { timeoutMs: 10_000, signal: ac.signal }, a.deps);
    const it = out.events[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal((first.value as { data: Buffer }).data.toString(), "first");
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(it.next());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, 0, "처리 안 된 거절이 났다");
  } finally { process.off("unhandledRejection", onUnhandled); }
});

await t("L3 레이어 — 판 목록(GET · MaxItems · 다음 쪽 Marker · 없는 레이어 404 → []) · 올리기(POST · zip base64 · 설명 256자까지 · arm64)", async () => {
  const pages = fake([
    { status: 200, body: JSON.stringify({ LayerVersions: [{ LayerVersionArn: "arn:1", Version: 1 }], NextMarker: "m2" }) },
    { status: 200, body: JSON.stringify({ LayerVersions: [{ LayerVersionArn: "arn:2", Version: 2 }] }) },
  ]);
  const vs = await listLayerVersions(c, "lvly-app-guard", pages.deps);
  assert.deepEqual(vs.map((v) => v.Version), [1, 2]);
  assert.equal(new URL(pages.seen[0]!.url).pathname, "/2018-10-31/layers/lvly-app-guard/versions");
  assert.equal(pages.seen[0]!.method, "GET");
  assert.equal(new URL(pages.seen[0]!.url).searchParams.get("MaxItems"), "50");
  assert.equal(new URL(pages.seen[1]!.url).searchParams.get("Marker"), "m2");
  const none = fake([{ status: 404, headers: { "x-amzn-errortype": "ResourceNotFoundException" } }]);
  assert.deepEqual(await listLayerVersions(c, "lvly-app-guard", none.deps), []);
  const pub = fake([{ status: 201, body: JSON.stringify({ LayerVersionArn: "arn:3", Version: 3 }) }]);
  const zip = Buffer.from("PK\u0003\u0004zip");
  const got = await publishLayerVersion(c, "lvly-app-guard", { zip, description: "d".repeat(300), architectures: ["arm64"] }, pub.deps);
  assert.equal(got.LayerVersionArn, "arn:3");
  assert.equal(pub.seen[0]!.method, "POST");
  assert.equal(new URL(pub.seen[0]!.url).pathname, "/2018-10-31/layers/lvly-app-guard/versions");
  const body = JSON.parse(pub.seen[0]!.body);
  assert.equal(body.Content.ZipFile, zip.toString("base64"));
  assert.equal(body.Description.length, 256);
  assert.deepEqual(body.CompatibleArchitectures, ["arm64"]);
});

await t("L4 비동기 부르기(#4486 백그라운드 작업) — 경로 · 판 · Event · 본문 JSON · 202 · 요청 번호 · 일시 오류는 두 번까지(사람 요청 안이라 짧게)", async () => {
  const a = fake([{ status: 202, headers: { "x-amzn-requestid": "rid-9" } }]);
  const r = await invokeAsync(c, "lvly-app-x", "3", { rawPath: "/a" }, a.deps);
  const u = new URL(a.seen[0]!.url);
  assert.equal(a.seen[0]!.method, "POST");
  assert.equal(u.pathname, "/2015-03-31/functions/lvly-app-x/invocations");
  assert.equal(u.searchParams.get("Qualifier"), "3");
  assert.equal(a.seen[0]!.headers["x-amz-invocation-type"], "Event");
  assert.deepEqual(JSON.parse(a.seen[0]!.body), { rawPath: "/a" });
  assert.deepEqual(r, { status: 202, requestId: "rid-9" });
  const b = fake([{ status: 503 }]);
  await assert.rejects(invokeAsync(c, "f", "cur", {}, b.deps), (e: unknown) => e instanceof AwsError && e.status === 503);
  assert.equal(b.seen.length, 2, "두 번까지만(awsCall 기본 세 번이 아니다)");
});

console.log(`\n${pass} passed`);

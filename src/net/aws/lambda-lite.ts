// 작은 Lambda · CloudWatch Logs · CloudWatch 지표 클라이언트(#4484 앱 v2-5) — 앱 서버 함수를 만들고·고치고·판을 고정하고·별칭을 옮기고·
//  부르고·멈추고·지운다. SDK 무의존(aws-json.ts). 권한은 CP 박스 역할의 app-servers-lambda 정책(lively-infra app-servers.tf):
//  lvly-app-* 함수만 · 역할 넘기기는 실행 역할 하나 · 레이어는 웹 어댑터만 · VPC 거부 · 함수 주소(URL)는 없음.
//  API 모양: https://docs.aws.amazon.com/lambda/latest/api/API_Operations.html (2015-03-31 · 동시 실행 2017-10-31/2019-09-30 · 계정 2016-08-19)
import { awsCall, awsOpen, AwsError, jsonOf, type AwsDeps } from "./aws-json.js";
import { decodeEventStream } from "./event-stream.js";

export interface LambdaCfg { region: string }

export interface FnConfiguration {
  FunctionName: string;
  FunctionArn: string;
  Runtime?: string;
  Role?: string;
  Handler?: string;
  CodeSize?: number;
  CodeSha256?: string;
  Version?: string;
  MemorySize?: number;
  Timeout?: number;
  Architectures?: string[];
  Environment?: { Variables?: Record<string, string> };
  Layers?: Array<{ Arn: string; CodeSize?: number }>;
  State?: string;                 // Pending · Active · Inactive · Failed
  StateReason?: string;
  StateReasonCode?: string;
  LastUpdateStatus?: string;      // InProgress · Successful · Failed
  LastUpdateStatusReason?: string;
  RevisionId?: string;
  VpcConfig?: { VpcId?: string; SubnetIds?: string[] };
}
export interface FnGet { Configuration: FnConfiguration; Tags?: Record<string, string>; Concurrency?: { ReservedConcurrentExecutions?: number } }
export interface FnAlias { AliasArn: string; Name: string; FunctionVersion: string; RevisionId?: string; Description?: string }
export interface InvokeOut { status: number; functionError: string | null; log: string; payload: string; executedVersion: string | null }

const host = (c: LambdaCfg): string => `lambda.${c.region}.amazonaws.com`;
const isNotFound = (e: unknown): boolean => e instanceof AwsError && (e.status === 404 || e.code === "ResourceNotFoundException");

export async function getFunction(c: LambdaCfg, name: string, deps?: AwsDeps): Promise<FnGet | null> {
  try { return jsonOf<FnGet>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2015-03-31", "functions", name] }, deps)); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}

export async function getFunctionConfiguration(c: LambdaCfg, name: string, qualifier?: string, deps?: AwsDeps): Promise<FnConfiguration | null> {
  try {
    return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2015-03-31", "functions", name, "configuration"],
      ...(qualifier ? { query: { Qualifier: qualifier } } : {}) }, deps));
  } catch (e) { if (isNotFound(e)) return null; throw e; }
}

export interface CreateFunctionInput {
  FunctionName: string;
  Runtime: string;
  Role: string;
  Handler: string;
  Code: { S3Bucket: string; S3Key: string };
  Architectures: string[];
  MemorySize: number;
  Timeout: number;
  Layers: string[];
  Environment: { Variables: Record<string, string> };
  Description?: string;
  Tags?: Record<string, string>;
  Publish?: boolean;
}
export async function createFunction(c: LambdaCfg, input: CreateFunctionInput, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions"], body: input }, deps));
}

export async function updateFunctionCode(c: LambdaCfg, name: string, code: { S3Bucket: string; S3Key: string; RevisionId?: string }, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "PUT", path: ["2015-03-31", "functions", name, "code"], body: { ...code, Publish: false } }, deps));
}

export interface UpdateConfigInput {
  Role?: string; Handler?: string; Runtime?: string; MemorySize?: number; Timeout?: number; Layers?: string[];
  Environment?: { Variables: Record<string, string> }; Description?: string; RevisionId?: string;
}
export async function updateFunctionConfiguration(c: LambdaCfg, name: string, input: UpdateConfigInput, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "PUT", path: ["2015-03-31", "functions", name, "configuration"], body: input }, deps));
}

/** 판 고정 — CodeSha256 이 $LATEST 와 다르면 Lambda 가 거절한다(그 사이 남이 코드를 바꿨으면 엉뚱한 코드를 고정하지 않게). */
export async function publishVersion(c: LambdaCfg, name: string, input: { CodeSha256?: string; Description?: string; RevisionId?: string }, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions", name, "versions"], body: input }, deps));
}

export async function listVersions(c: LambdaCfg, name: string, deps?: AwsDeps): Promise<FnConfiguration[]> {
  const out: FnConfiguration[] = [];
  let marker: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q: Record<string, string> = { MaxItems: "50" };
    if (marker) q.Marker = marker;
    const r = jsonOf<{ Versions?: FnConfiguration[]; NextMarker?: string | null }>(
      await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2015-03-31", "functions", name, "versions"], query: q }, deps));
    out.push(...(r.Versions ?? []));
    marker = r.NextMarker ?? null;
    if (!marker) break;
  }
  return out;
}

export async function getAlias(c: LambdaCfg, name: string, alias: string, deps?: AwsDeps): Promise<FnAlias | null> {
  try { return jsonOf<FnAlias>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2015-03-31", "functions", name, "aliases", alias] }, deps)); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}

/** 별칭을 그 판으로 — 없으면 만들고 있으면 옮긴다. */
export async function putAlias(c: LambdaCfg, name: string, alias: string, version: string, description: string, deps?: AwsDeps): Promise<FnAlias> {
  const cur = await getAlias(c, name, alias, deps);
  if (!cur) {
    try {
      return jsonOf<FnAlias>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions", name, "aliases"],
        body: { Name: alias, FunctionVersion: version, Description: description } }, deps));
    } catch (e) {
      //  그 사이 남이 만들었다(같은 앱을 두 곳에서 배포) — 아래 고치기로 이어 간다.
      if (!(e instanceof AwsError && (e.status === 409 || e.code === "ResourceConflictException"))) throw e;
    }
  }
  return jsonOf<FnAlias>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "PUT", path: ["2015-03-31", "functions", name, "aliases", alias],
    body: { FunctionVersion: version, Description: description } }, deps));
}

/** 함수(또는 판 하나) 지우기 — 없으면 성공으로 본다. */
export async function deleteFunction(c: LambdaCfg, name: string, qualifier?: string, deps?: AwsDeps): Promise<void> {
  try {
    await awsCall({ service: "lambda", region: c.region, host: host(c), method: "DELETE", path: ["2015-03-31", "functions", name], ...(qualifier ? { query: { Qualifier: qualifier } } : {}) }, deps);
  } catch (e) { if (!isNotFound(e)) throw e; }
}

/** 동시 실행 예약 — 0 이면 그 함수(모든 판 · 별칭)가 멈춘다(부르면 TooManyRequestsException). */
export async function putConcurrency(c: LambdaCfg, name: string, n: number, deps?: AwsDeps): Promise<void> {
  await awsCall({ service: "lambda", region: c.region, host: host(c), method: "PUT", path: ["2017-10-31", "functions", name, "concurrency"], body: { ReservedConcurrentExecutions: n } }, deps);
}
export async function deleteConcurrency(c: LambdaCfg, name: string, deps?: AwsDeps): Promise<void> {
  try { await awsCall({ service: "lambda", region: c.region, host: host(c), method: "DELETE", path: ["2017-10-31", "functions", name, "concurrency"] }, deps); }
  catch (e) { if (!isNotFound(e)) throw e; }
}

/** 부르기(동기) — 기록 끝 4KB(LogType Tail)도 받는다. 함수 오류는 던지지 않고 functionError 로 돌려준다(부르는 쪽이 기록과 함께 사람에게 보인다). */
export async function invoke(c: LambdaCfg, name: string, qualifier: string | null, payload: unknown, opts: { timeoutMs?: number } = {}, deps?: AwsDeps): Promise<InvokeOut> {
  const r = await awsCall({
    service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions", name, "invocations"],
    query: qualifier ? { Qualifier: qualifier } : undefined, body: payload,
    headers: { "x-amz-invocation-type": "RequestResponse", "x-amz-log-type": "Tail" },
    timeoutMs: opts.timeoutMs ?? 60_000,
  }, { ...(deps ?? {}), attempts: 1 });
  const log = r.headers.get("x-amz-log-result");
  return {
    status: r.status,
    functionError: r.headers.get("x-amz-function-error"),
    log: log ? Buffer.from(log, "base64").toString("utf8") : "",
    payload: r.text,
    executedVersion: r.headers.get("x-amz-executed-version"),
  };
}

// ── 흘려 받기(#4485 앱 v2-6) — 앱 주소의 요청을 함수에 넘기고 응답을 조각째 받는다(InvokeWithResponseStream · 권한은 lambda:InvokeFunction) ──
//  웹 어댑터가 응답 흘려 보내기 모드(AWS_LWA_INVOKE_MODE=response_stream)면 본문 조각들이 «HTTP 통합 응답» 틀이다:
//   JSON 앞머리 {statusCode, headers, cookies} + NUL 8개 + 본문(app-front-server.ts 가 푼다). 응답 머리 x-amzn-remapped-content-type 이 그 틀을 알린다
//   (application/vnd.awslambda.http-integration-response). 앱이 응답 전에 죽으면 그 머리가 application/octet-stream 이고 본문은 Lambda 오류 JSON 이다
//   (2026-10-16 실측). 다시 하지 않는다 — 앱 코드가 도는 일이라 같은 요청을 두 번 보내면 안 된다.
export type StreamEvent =
  | { type: "chunk"; data: Buffer }
  | { type: "complete"; errorCode: string | null; errorDetails: string | null; log: string };

export interface StreamInvokeOut {
  status: number;
  executedVersion: string | null;
  /** 함수가 낸 본문의 틀 — HTTP 통합 응답이면 application/vnd.awslambda.http-integration-response. */
  contentType: string | null;
  events: AsyncGenerator<StreamEvent>;
}

export async function invokeStream(c: LambdaCfg, name: string, qualifier: string | null, payloadJson: string,
  opts: { timeoutMs: number; logTail?: boolean; signal?: AbortSignal }, deps?: AwsDeps): Promise<StreamInvokeOut> {
  const res = await awsOpen({
    service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2021-11-15", "functions", name, "response-streaming-invocations"],
    query: qualifier ? { Qualifier: qualifier } : undefined, rawBody: payloadJson,
    headers: { "x-amz-invocation-type": "RequestResponse", ...(opts.logTail ? { "x-amz-log-type": "Tail" } : {}) },
    timeoutMs: opts.timeoutMs, signal: opts.signal,
  }, deps);
  const body = res.body;
  async function* events(): AsyncGenerator<StreamEvent> {
    if (!body) return;
    for await (const m of decodeEventStream(body as unknown as AsyncIterable<Uint8Array>)) {
      const mt = m.headers[":message-type"] ?? "event";
      if (mt === "exception" || mt === "error") {
        const code = m.headers[":exception-type"] ?? m.headers[":error-code"] ?? "StreamError";
        let msg = m.headers[":error-message"] ?? "";
        try { const o = JSON.parse(m.payload.toString("utf8")) as { message?: unknown; Message?: unknown }; msg = String(o.message ?? o.Message ?? msg); } catch { /* 본문이 JSON 이 아니다 */ }
        throw new AwsError(502, code, `lambda 흘려 받기 오류: ${code}${msg ? ` — ${msg.slice(0, 500)}` : ""}`, res.headers.get("x-amzn-requestid"));
      }
      const et = m.headers[":event-type"];
      if (et === "PayloadChunk") { yield { type: "chunk", data: m.payload }; continue; }
      if (et === "InvokeComplete") {
        let o: { ErrorCode?: unknown; ErrorDetails?: unknown; LogResult?: unknown } = {};
        try { o = JSON.parse(m.payload.toString("utf8")) as typeof o; } catch { /* 빈 본문 */ }
        yield {
          type: "complete",
          errorCode: o.ErrorCode ? String(o.ErrorCode) : null,
          errorDetails: o.ErrorDetails ? String(o.ErrorDetails) : null,
          log: typeof o.LogResult === "string" && o.LogResult ? Buffer.from(o.LogResult, "base64").toString("utf8") : "",
        };
        return;
      }
      //  모르는 사건은 건너뛴다(앞으로 AWS 가 더할 수 있다).
    }
  }
  return {
    status: res.status,
    executedVersion: res.headers.get("x-amz-executed-version"),
    contentType: res.headers.get("x-amzn-remapped-content-type"),
    events: events(),
  };
}

/** 기록 끝부분의 REPORT 줄 → 시간 · 상태. 줄이 없으면 null(흘려 받기 기록 끝 4KB 안에 늘 있다 — 실측). */
export function parseReport(log: string): { durationMs: number | null; billedMs: number | null; initMs: number | null; status: "ok" | "error" | "timeout"; errorType: string | null } | null {
  const line = log.split("\n").reverse().find((l) => l.startsWith("REPORT RequestId:"));
  if (!line) return null;
  const num = (re: RegExp): number | null => { const m = re.exec(line); return m ? Number(m[1]) : null; };
  const st = /\tStatus: (\w+)/.exec(line)?.[1]?.toLowerCase();
  return {
    durationMs: num(/\tDuration: ([\d.]+) ms/),
    billedMs: num(/\tBilled Duration: ([\d.]+) ms/),
    initMs: num(/\tInit Duration: ([\d.]+) ms/),
    status: st === "timeout" ? "timeout" : st === "error" ? "error" : "ok",
    errorType: /\tError Type: ([\w.]+)/.exec(line)?.[1] ?? null,
  };
}

// ── 레이어(#4485) — 앱보다 먼저 도는 신원 검사 층(app-server-guard.ts)을 코어 판마다 올린다. 이름은 lvly-app-* 만(박스 역할 정책) ──
export interface LayerVersion { LayerVersionArn: string; Version: number; Description?: string; CreatedDate?: string }

export async function listLayerVersions(c: LambdaCfg, layer: string, deps?: AwsDeps): Promise<LayerVersion[]> {
  const out: LayerVersion[] = [];
  let marker: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q: Record<string, string> = { MaxItems: "50" };
    if (marker) q.Marker = marker;
    let r: { LayerVersions?: LayerVersion[]; NextMarker?: string | null };
    try {
      r = jsonOf(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2018-10-31", "layers", layer, "versions"], query: q }, deps));
    } catch (e) { if (isNotFound(e)) return out; throw e; }
    out.push(...(r.LayerVersions ?? []));
    marker = r.NextMarker ?? null;
    if (!marker) break;
  }
  return out;
}

export async function publishLayerVersion(c: LambdaCfg, layer: string, input: { zip: Buffer; description: string; architectures: string[]; runtimes?: string[] }, deps?: AwsDeps): Promise<LayerVersion> {
  return jsonOf<LayerVersion>(await awsCall({
    service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2018-10-31", "layers", layer, "versions"],
    body: { Content: { ZipFile: input.zip.toString("base64") }, Description: input.description.slice(0, 256), CompatibleArchitectures: input.architectures,
      ...(input.runtimes ? { CompatibleRuntimes: input.runtimes } : {}) },
  }, deps));
}

// ── CloudWatch Logs(JSON 1.1) — 함수마다 로그 그룹을 보관 기간과 함께 만든다 ──
const logsCall = (c: LambdaCfg, op: string, body: unknown, deps?: AwsDeps) =>
  awsCall({ service: "logs", region: c.region, host: `logs.${c.region}.amazonaws.com`, method: "POST", path: [""], body, target: { header: `Logs_20140328.${op}`, jsonVersion: "1.1" } }, deps);

/** 로그 그룹을 만들고(이미 있으면 그대로) 보관 기간을 건다. */
export async function ensureLogGroup(c: LambdaCfg, group: string, retentionDays: number, deps?: AwsDeps): Promise<void> {
  try { await logsCall(c, "CreateLogGroup", { logGroupName: group }, deps); }
  catch (e) { if (!(e instanceof AwsError && e.code === "ResourceAlreadyExistsException")) throw e; }
  await logsCall(c, "PutRetentionPolicy", { logGroupName: group, retentionInDays: retentionDays }, deps);
}
export async function deleteLogGroup(c: LambdaCfg, group: string, deps?: AwsDeps): Promise<void> {
  try { await logsCall(c, "DeleteLogGroup", { logGroupName: group }, deps); }
  catch (e) { if (!(e instanceof AwsError && e.code === "ResourceNotFoundException")) throw e; }
}

// ── CloudWatch 지표(JSON 1.0) — 앱별 호출 수 · 실행 시간(자동 멈춤 감시) ──
export interface MetricQuery { id: string; fn: string; metric: "Invocations" | "Duration" | "Throttles" | "Errors"; stat: "Sum" | "Maximum" }
export interface MetricResult { id: string; values: number[]; timestamps: number[] }

/** 최근 구간의 지표 — 한 번에 500개까지(GetMetricData 상한). 값은 period 마다 하나. */
export async function getMetricData(c: LambdaCfg, queries: MetricQuery[], range: { start: Date; end: Date; periodSec: number }, deps?: AwsDeps): Promise<MetricResult[]> {
  const out: MetricResult[] = [];
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    let next: string | null = null;
    for (let page = 0; page < 20; page++) {
      const body: Record<string, unknown> = {
        MetricDataQueries: chunk.map((q) => ({ Id: q.id, MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: q.metric, Dimensions: [{ Name: "FunctionName", Value: q.fn }] }, Period: range.periodSec, Stat: q.stat } })),
        StartTime: Math.floor(range.start.getTime() / 1000), EndTime: Math.floor(range.end.getTime() / 1000),
      };
      if (next) body.NextToken = next;
      const r = jsonOf<{ MetricDataResults?: Array<{ Id: string; Values?: number[]; Timestamps?: number[] }>; NextToken?: string }>(
        await awsCall({ service: "monitoring", region: c.region, host: `monitoring.${c.region}.amazonaws.com`, method: "POST", path: [""], body,
          target: { header: "GraniteServiceVersion20100801.GetMetricData", jsonVersion: "1.0" } }, deps));
      for (const m of r.MetricDataResults ?? []) {
        const got = out.find((x) => x.id === m.Id);
        if (got) { got.values.push(...(m.Values ?? [])); got.timestamps.push(...(m.Timestamps ?? [])); }
        else out.push({ id: m.Id, values: [...(m.Values ?? [])], timestamps: [...(m.Timestamps ?? [])] });
      }
      next = r.NextToken ?? null;
      if (!next) break;
    }
  }
  return out;
}

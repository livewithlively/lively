// 작은 Lambda · CloudWatch Logs 클라이언트(#4484 앱 v2-5 · #4485 v2-6) — 앱 서버 함수를 만들고·고치고·판을 고정하고·별칭을 옮기고·
//  흘려 받으며 부르고·멈추고·지운다 · 검사 층 레이어를 올린다. SDK 무의존(aws-json.ts). 권한은 CP 박스 역할의 app-servers-lambda 정책(lively-infra app-servers.tf):
//  lvly-app-* 함수 · 레이어만 · 역할 넘기기는 실행 역할 하나 · 레이어는 웹 어댑터 + lvly-app-* · VPC 거부 · 함수 주소(URL)는 없음.
//  CloudWatch 지표는 v2-6 부터 읽지 않는다 — 호출 셈은 게이트웨이가 적는다(app-server-usage).
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
  /** 임시 디스크(/tmp) 크기(MB · 512~10,240) — #4486 앱이 web.server.tmp_mb 로 고른다. 안 주면 512. */
  EphemeralStorage?: { Size?: number };
}
/**
 * 함수 코드를 어디서 받나(#4801). S3ObjectStorageMode — COPY(기본) = Lambda 가 코드를 제 저장소로 복사한다(계정 코드 저장 300GiB 를 쓴다) ·
 *  REFERENCE = 복사하지 않고 우리 S3 객체를 그 판 번호(S3ObjectVersion)로 바로 읽는다. REFERENCE 는 버킷이 판 번호를 켜고, 버킷 정책이
 *  lambda.amazonaws.com 에 GetObject · GetObjectVersion 을 주고, 부르는 쪽(박스 역할)도 그 둘을 가져야 한다 — 하나라도 빠지면 만들기 · 코드 고치기가
 *  곧바로 400 · 403 으로 거절된다(2026-10-16 시험). 모드를 빼고 코드를 고치면 COPY 로 돌아간다(AWS 문서 — 고칠 때마다 REFERENCE 를 다시 준다).
 */
export interface FnCode { S3Bucket: string; S3Key: string; S3ObjectVersion?: string; S3ObjectStorageMode?: "COPY" | "REFERENCE" }
/** GetFunction 의 Code — REFERENCE 면 ResolvedS3Object(읽는 객체와 그 판 번호) · COPY 면 그 칸이 없고 Location(Lambda 쪽 내려받기 주소)이 온다. */
export interface FnCodeLocation {
  RepositoryType?: string | null;
  ResolvedS3Object?: { S3Bucket?: string; S3Key?: string; S3ObjectVersion?: string } | null;
  Error?: { ErrorCode?: string; Message?: string } | null;
}
export interface FnGet { Configuration: FnConfiguration; Code?: FnCodeLocation; Tags?: Record<string, string>; Concurrency?: { ReservedConcurrentExecutions?: number } }
export interface FnAlias { AliasArn: string; Name: string; FunctionVersion: string; RevisionId?: string; Description?: string }

const host = (c: LambdaCfg): string => `lambda.${c.region}.amazonaws.com`;
const isNotFound = (e: unknown): boolean => e instanceof AwsError && (e.status === 404 || e.code === "ResourceNotFoundException");

/** 함수(또는 판 하나 — qualifier) — 설정 · 코드 자리(Code · #4801) · 태그. 판을 주면 그 판의 설정과 그 판이 읽는 코드 자리다. */
export async function getFunction(c: LambdaCfg, name: string, qualifier?: string, deps?: AwsDeps): Promise<FnGet | null> {
  try {
    return jsonOf<FnGet>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2015-03-31", "functions", name],
      ...(qualifier ? { query: { Qualifier: qualifier } } : {}) }, deps));
  } catch (e) { if (isNotFound(e)) return null; throw e; }
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
  Code: FnCode;
  Architectures: string[];
  MemorySize: number;
  Timeout: number;
  Layers: string[];
  Environment: { Variables: Record<string, string> };
  EphemeralStorage?: { Size: number };
  Description?: string;
  Tags?: Record<string, string>;
  Publish?: boolean;
}
export async function createFunction(c: LambdaCfg, input: CreateFunctionInput, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions"], body: input }, deps));
}

export async function updateFunctionCode(c: LambdaCfg, name: string, code: FnCode & { RevisionId?: string }, deps?: AwsDeps): Promise<FnConfiguration> {
  return jsonOf<FnConfiguration>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "PUT", path: ["2015-03-31", "functions", name, "code"], body: { ...code, Publish: false } }, deps));
}

export interface UpdateConfigInput {
  Role?: string; Handler?: string; Runtime?: string; MemorySize?: number; Timeout?: number; Layers?: string[];
  Environment?: { Variables: Record<string, string> }; EphemeralStorage?: { Size: number }; Description?: string; RevisionId?: string;
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

// ── 비동기로 부르기(#4486 앱 v2-7 백그라운드 작업) — InvocationType=Event · 권한은 lambda:InvokeFunction 그대로 ──
//  Lambda 가 이벤트를 제 줄에 받아 두고(202) 따로 돌린다 — 부른 쪽은 결과를 받지 않는다(함수 안 검사 층이 게이트웨이에 결과를 보고한다).
//  이벤트 한도 1MB(https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html). Lambda 는 같은 이벤트를 두 번 보낼 수 있고
//  함수가 오류로 끝나면 1분 · 2분 뒤 다시 부른다(invocation-async-error-handling) — 그래서 일시 오류에 다시 보내도 된다: 한 작업은 검사 층의
//  claim(게이트웨이가 한 번만 넘긴다)을 지나야 앱에 닿는다(awsCall 의 다시 하기를 그대로 쓴다).
export async function invokeAsync(c: LambdaCfg, name: string, qualifier: string, payload: unknown, deps?: AwsDeps): Promise<{ status: number; requestId: string | null }> {
  const r = await awsCall({
    service: "lambda", region: c.region, host: host(c), method: "POST", path: ["2015-03-31", "functions", name, "invocations"],
    query: { Qualifier: qualifier }, body: payload, headers: { "x-amz-invocation-type": "Event" },
  }, deps);
  return { status: r.status, requestId: r.headers.get("x-amzn-requestid") };
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

/** 로그 그룹 태그(#4790) — 태그와 그 그룹의 ARN(TagResource 가 받는 꼴 · 끝 :* 없이)을 한 묶음으로(태그만 주고 ARN 을 빠뜨리는 꼴이 없게). */
export interface LogGroupTag { tags: Record<string, string>; arn: string }

/**
 * 로그 그룹을 만들고(이미 있으면 그대로) 보관 기간을 건다. tag 를 주면 만들 때 달고, 이미 있던 그룹엔 TagResource 로 단다(#4790 — 실행 역할의
 *  쓰기 조건이 그 태그를 본다 · 같은 키면 값을 덮는다). 만들며 태그를 달려면 부르는 쪽에 logs:TagResource 권한이 있어야 한다(AWS 문서 CreateLogGroup).
 */
export async function ensureLogGroup(c: LambdaCfg, group: string, retentionDays: number, tag?: LogGroupTag | null, deps?: AwsDeps): Promise<void> {
  const withTags = tag && Object.keys(tag.tags).length ? tag : null;   // 빈 태그는 싣지 않는다
  let existed = false;
  try { await logsCall(c, "CreateLogGroup", { logGroupName: group, ...(withTags ? { tags: withTags.tags } : {}) }, deps); }
  catch (e) { if (!(e instanceof AwsError && e.code === "ResourceAlreadyExistsException")) throw e; existed = true; }
  if (existed && withTags) await logsCall(c, "TagResource", { resourceArn: withTags.arn, tags: withTags.tags }, deps);
  await logsCall(c, "PutRetentionPolicy", { logGroupName: group, retentionInDays: retentionDays }, deps);
}
export async function deleteLogGroup(c: LambdaCfg, group: string, deps?: AwsDeps): Promise<void> {
  try { await logsCall(c, "DeleteLogGroup", { logGroupName: group }, deps); }
  catch (e) { if (!(e instanceof AwsError && e.code === "ResourceNotFoundException")) throw e; }
}


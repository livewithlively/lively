// 작은 Lambda · CloudWatch Logs · CloudWatch 지표 클라이언트(#4484 앱 v2-5) — 앱 서버 함수를 만들고·고치고·판을 고정하고·별칭을 옮기고·
//  부르고·멈추고·지운다. SDK 무의존(aws-json.ts). 권한은 CP 박스 역할의 app-servers-lambda 정책(lively-infra app-servers.tf):
//  lvly-app-* 함수만 · 역할 넘기기는 실행 역할 하나 · 레이어는 웹 어댑터만 · VPC 거부 · 함수 주소(URL)는 없음.
//  API 모양: https://docs.aws.amazon.com/lambda/latest/api/API_Operations.html (2015-03-31 · 동시 실행 2017-10-31/2019-09-30 · 계정 2016-08-19)
import { awsCall, AwsError, jsonOf, type AwsDeps } from "./aws-json.js";

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
export async function getConcurrency(c: LambdaCfg, name: string, deps?: AwsDeps): Promise<number | null> {
  try {
    const r = jsonOf<{ ReservedConcurrentExecutions?: number }>(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2019-09-30", "functions", name, "concurrency"] }, deps));
    return typeof r.ReservedConcurrentExecutions === "number" ? r.ReservedConcurrentExecutions : null;
  } catch (e) { if (isNotFound(e)) return null; throw e; }
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

export async function getAccountSettings(c: LambdaCfg, deps?: AwsDeps): Promise<{ AccountLimit?: Record<string, number>; AccountUsage?: Record<string, number> }> {
  return jsonOf(await awsCall({ service: "lambda", region: c.region, host: host(c), method: "GET", path: ["2016-08-19", "account-settings", ""] }, deps));
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

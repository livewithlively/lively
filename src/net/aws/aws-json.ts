// AWS JSON 서비스 호출(#4484 앱 v2-5) — Lambda(REST JSON) · CloudWatch Logs(JSON 1.1) · JSON 1.0 서비스. SDK 무의존(s3-lite 와 같은 관례).
//
//  서명은 signRequestV4(AWS 공개 벡터로 못 박음) · 자격은 게이트웨이 base 자격(env → EC2 인스턴스 프로파일 = 매니지드 CP 박스 역할).
//  canonical URI 규칙(S3 와 다르다): 경로 조각을 **두 번** 인코딩한다 — https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html.
//   우리가 부르는 경로는 함수 이름 · 판 번호 · 별칭처럼 안전한 글자뿐이라 결과는 같지만, 규칙을 틀리게 두지 않는다.
//  다시 하기: 네트워크 · 시간 초과 · 5xx · 조절(429 · Throttling)은 두 번까지 다시 한다. 조절된 요청은 실행되지 않은 것이라 쓰기도 다시 해도 된다.
//   5xx 를 받은 쓰기(함수 만들기 등)는 실제로 됐을 수 있다 — 부르는 쪽이 «이미 있음»(409 ResourceConflict) 을 그 뜻으로 읽는다.
import { signRequestV4, type AwsCreds } from "./aws-sigv4.js";
import { resolveGatewayBaseCreds } from "./aws-broker.js";
import { s3CanonicalQuery, s3Encode } from "./s3-lite.js";

export interface AwsDeps {
  creds?: () => Promise<AwsCreds | null>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 한 번의 요청 시한(ms) — 기본 30초. */
  timeoutMs?: number;
  /** 처음 포함 몇 번까지(기본 3). */
  attempts?: number;
  /** 다시 하기 전 기다림(ms) — 시험은 0. */
  retryDelayMs?: number;
}

export class AwsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null = null) {
    super(message);
    this.name = "AwsError";
  }
}

export interface AwsCall {
  service: string;           // SigV4 서비스 이름 — lambda · logs
  region: string;
  host: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** 조각을 아직 인코딩하지 않은 경로 조각들(예 ["2015-03-31","functions","lvly-app-x"]). */
  path: string[];
  query?: Record<string, string>;
  body?: unknown;            // JSON 으로 보낸다(없으면 본문 없음)
  /** JSON 1.0 · 1.1 서비스(X-Amz-Target) — 주면 content-type 이 그 판이 된다. */
  target?: { header: string; jsonVersion: "1.0" | "1.1" };
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface AwsResponse { status: number; headers: Headers; text: string }

const RETRYABLE_CODES = new Set(["TooManyRequestsException", "ThrottlingException", "Throttling", "RequestLimitExceeded", "ServiceException", "ServiceUnavailableException", "InternalFailure", "Timeout", "NetworkError"]);
export const isRetryable = (e: unknown): boolean => {
  if (!(e instanceof AwsError)) return true;
  if (e.code === "NoCredentials") return false;
  return e.status >= 500 || e.status === 429 || RETRYABLE_CODES.has(e.code);
};

/** 오류 응답 → AwsError. 코드는 x-amzn-errortype 머리(«이름:주소») > 본문 __type(«…#이름») > Type > HTTP<상태>. */
export function awsErrorOf(status: number, headers: Headers, text: string, what: string): AwsError {
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text || "{}") as Record<string, unknown>; } catch { /* 본문이 JSON 이 아니다 */ }
  const hdr = (headers.get("x-amzn-errortype") ?? "").split(":")[0]?.trim();
  const typ = String(body.__type ?? "").split("#").pop()?.trim();
  const code = hdr || typ || String(body.Type ?? body.code ?? "") || `HTTP${status}`;
  const msg = String(body.Message ?? body.message ?? "").trim();
  return new AwsError(status, code, `${what} 실패: ${status} ${code}${msg ? ` — ${msg.slice(0, 500)}` : ""}`, headers.get("x-amzn-requestid"));
}

/** 서명해 보내고 응답(본문은 아직 안 읽음)을 돌려준다 — 4xx · 5xx 는 본문을 읽어 AwsError. once · awsOpen 공용. */
async function send(c: AwsCall & { rawBody?: string; signal?: AbortSignal }, deps: AwsDeps): Promise<Response> {
  const creds = await (deps.creds ?? resolveGatewayBaseCreds)();
  if (!creds) throw new AwsError(0, "NoCredentials", `${c.service} 자격이 없습니다 — 게이트웨이 env(AWS_*) 또는 EC2 인스턴스 프로파일이 필요합니다`);
  const reqPath = "/" + c.path.map((p) => s3Encode(p)).join("/");
  const canonPath = "/" + c.path.map((p) => s3Encode(s3Encode(p))).join("/");
  const query = c.query ? s3CanonicalQuery(c.query) : "";
  const body = c.rawBody ?? (c.body === undefined ? "" : JSON.stringify(c.body));
  const headers: Record<string, string> = { ...(c.headers ?? {}) };
  if (c.target) {
    headers["content-type"] = `application/x-amz-json-${c.target.jsonVersion}`;
    headers["x-amz-target"] = c.target.header;
  } else if (body) {
    headers["content-type"] = "application/json";
  }
  const auth = signRequestV4({ method: c.method, host: c.host, path: canonPath, region: c.region, service: c.service, body, headers, creds, now: (deps.now ?? (() => new Date()))(), query });
  const f = deps.fetch ?? fetch;
  const timeout = AbortSignal.timeout(c.timeoutMs ?? deps.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await f(`https://${c.host}${reqPath}${query ? "?" + query : ""}`, {
      method: c.method, headers: { ...headers, ...auth }, body: body || undefined,
      signal: c.signal ? AbortSignal.any([timeout, c.signal]) : timeout,
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const cause = (e as { cause?: { code?: unknown } })?.cause;
    throw new AwsError(0, name === "TimeoutError" || name === "AbortError" ? "Timeout" : "NetworkError",
      `${c.service} ${c.method} /${c.path.join("/")} 연결 실패: ${(e as Error)?.message ?? e}${cause?.code ? ` (${String(cause.code)})` : ""}`);
  }
  if (res.status >= 400) {
    const text = await res.text().catch(() => "");
    throw awsErrorOf(res.status, res.headers, text, `${c.service} ${c.method} /${c.path.join("/")}`);
  }
  return res;
}

async function once(c: AwsCall, deps: AwsDeps): Promise<AwsResponse> {
  const res = await send(c, deps);
  const text = await res.text().catch(() => "");
  return { status: res.status, headers: res.headers, text };
}

/**
 * 한 번만 보내고 응답 본문을 **흘려 읽을 수 있게** 돌려준다(#4485 흘려 받기 — InvokeWithResponseStream). 다시 하지 않는다:
 *  함수 호출은 앱 코드가 도는 일이라 같은 요청을 두 번 보내면 안 된다. rawBody = 이미 만든 JSON 글(큰 이벤트를 두 번 직렬화하지 않게).
 *  timeoutMs 는 응답을 다 받을 때까지의 시한이다(흘려 받는 동안에도 걸린다). signal 로 부르는 쪽이 끊을 수 있다 — 앱 주소 길(app-front-server)은
 *  쓰지 않는다: 브라우저가 떠나도 함수는 돌므로 흐름을 끝까지 읽어 상한 자리 · 실행 시간을 센다(#4485 격리 리뷰).
 */
export async function awsOpen(c: AwsCall & { rawBody?: string; signal?: AbortSignal }, deps: AwsDeps = {}): Promise<Response> {
  return send(c, deps);
}

/** 서명해 부르고, 일시 오류면 두 번까지 다시 한다. 4xx(조절 말고)는 곧바로 AwsError. */
export async function awsCall(c: AwsCall, deps: AwsDeps = {}): Promise<AwsResponse> {
  const n = Math.max(1, Math.floor(deps.attempts ?? 3));
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await once(c, deps); } catch (e) {
      last = e;
      if (!isRetryable(e) || i === n - 1) throw e;
      const wait = deps.retryDelayMs ?? 300 * 2 ** i;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/** JSON 본문을 읽는다(빈 본문은 {}). */
export function jsonOf<T>(r: AwsResponse): T {
  try { return (r.text ? JSON.parse(r.text) : {}) as T; } catch { return {} as T; }
}

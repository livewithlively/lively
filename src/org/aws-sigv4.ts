// AWS Signature V4 서명(자체 구현, SDK 무의존 — ssrf.ts·secret-box.ts 와 같은 "의존성 무추가" 관례, #746 P1/aws).
//  용도: 게이트웨이가 STS sts:AssumeRole 을 호출해 어니스트 제공 IAM role 의 단기자격을 발급(멤버 귀속 RoleSessionName).
//  SigV4 는 보안 임계경로라 AWS 공개 테스트벡터(get-vanilla)로 정확성을 못박고, 실 STS GetCallerIdentity 로 E2E 검증한다.
//  참고: https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
import crypto from "node:crypto";

export interface AwsCreds { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

const sha256hex = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => crypto.createHmac("sha256", key).update(data).digest();

// YYYYMMDD'T'HHMMSS'Z' (UTC, 구분자 없음) — X-Amz-Date. 호출자가 시각을 주입(테스트 결정성 + Date.now 금지 관례).
export function amzDate(d: Date): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 2015-08-30T12:36:00.000Z → 20150830T123600Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// 서명키 유도 — kSecret→kDate→kRegion→kService→kSigning.
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request");
}

export interface SignInput {
  method: string;
  host: string;                 // 예 sts.ap-northeast-2.amazonaws.com
  path: string;                 // 예 "/"
  region: string;
  service: string;              // 예 "sts"
  body: string;                 // POST 바디(폼인코딩) — GET 이면 ""
  headers?: Record<string, string>; // content-type 등(host/x-amz-date/x-amz-security-token 은 자동)
  creds: AwsCreds;
  now: Date;                    // 서명 시각(주입)
}

// SigV4 서명 → 요청에 실을 최종 헤더(Authorization·X-Amz-Date·[X-Amz-Security-Token]) 반환.
export function signRequestV4(inp: SignInput): Record<string, string> {
  const { amzDate: xAmzDate, dateStamp } = amzDate(inp.now);
  const canonicalHeadersMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(inp.headers ?? {})) canonicalHeadersMap[k.toLowerCase()] = String(v).trim();
  canonicalHeadersMap["host"] = inp.host;
  canonicalHeadersMap["x-amz-date"] = xAmzDate;
  if (inp.creds.sessionToken) canonicalHeadersMap["x-amz-security-token"] = inp.creds.sessionToken;

  const sortedKeys = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonicalHeadersMap[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  const payloadHash = sha256hex(inp.body);

  const canonicalRequest = [
    inp.method.toUpperCase(),
    inp.path || "/",
    "",                 // canonical query string(STS 는 POST 바디라 빈 문자열)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${inp.region}/${inp.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    xAmzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(inp.creds.secretAccessKey, dateStamp, inp.region, inp.service), stringToSign).toString("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${inp.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = { "X-Amz-Date": xAmzDate, Authorization: authorization };
  if (inp.creds.sessionToken) out["X-Amz-Security-Token"] = inp.creds.sessionToken;
  return out;
}

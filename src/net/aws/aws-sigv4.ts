// AWS Signature V4 서명(자체 구현, SDK 무의존 — ssrf.ts·secret-box.ts 와 같은 "의존성 무추가" 관례, #746 P1/aws).
//  용도: 게이트웨이가 STS sts:AssumeRole 을 호출해 고객사 A 제공 IAM role 의 단기자격을 발급(멤버 귀속 RoleSessionName).
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

/**
 * (#4484) 서명할 글(stringToSign)에 서명한다 — 머리 방식(signRequestV4)이 아닌 길(쿼리 문자열로 서명한 주소 · S3 presign)이 쓴다.
 *  canonical request 를 만드는 규칙은 서비스마다 달라 부르는 쪽이 만들고, 서명키 유도와 HMAC 만 여기 한 자리에 둔다.
 */
export function signStringV4(stringToSign: string, secret: string, dateStamp: string, region: string, service: string): string {
  return hmac(signingKey(secret, dateStamp, region, service), stringToSign).toString("hex");
}
export const sha256HexOf = (s: string | Buffer): string => sha256hex(s);

export interface SignInput {
  method: string;
  host: string;                 // 예 sts.ap-northeast-2.amazonaws.com
  path: string;                 // 예 "/" — 이미 URI 인코딩된 canonical URI(S3 는 경로 조각을 한 번만 인코딩한다)
  region: string;
  service: string;              // 예 "sts"
  body: string | Buffer;        // POST 바디(폼인코딩) — GET 이면 "" · S3 PUT 은 바이트(#4481)
  headers?: Record<string, string>; // content-type 등(host/x-amz-date/x-amz-security-token 은 자동)
  creds: AwsCreds;
  now: Date;                    // 서명 시각(주입)
  /** #4481 canonical query string — 이미 정렬·인코딩된 `a=1&b=2`(S3 목록 등). 없으면 ""(STS·MCP 는 쿼리가 없다). */
  query?: string;
  /** #4481 payload 해시(hex) — 호출자가 이미 안다면(S3 는 x-amz-content-sha256 헤더와 같은 값이어야 한다). 없으면 body 로 계산. */
  payloadHash?: string;
}

// SigV4 서명 → 요청에 실을 최종 헤더(Authorization·X-Amz-Date·[X-Amz-Security-Token]) 반환.
export function signRequestV4(inp: SignInput): Record<string, string> {
  const { amzDate: xAmzDate, dateStamp } = amzDate(inp.now);
  const canonicalHeadersMap: Record<string, string> = {};
  // 값 정규화: trim + 내부 연속 공백 1칸으로(AWS canonicalization). 현재 서명 헤더엔 내부공백 없으나 범용 export 안전.
  for (const [k, v] of Object.entries(inp.headers ?? {})) canonicalHeadersMap[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  canonicalHeadersMap["host"] = inp.host;
  canonicalHeadersMap["x-amz-date"] = xAmzDate;
  if (inp.creds.sessionToken) canonicalHeadersMap["x-amz-security-token"] = inp.creds.sessionToken;

  const sortedKeys = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonicalHeadersMap[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  const payloadHash = inp.payloadHash ?? sha256hex(inp.body);

  const canonicalRequest = [
    inp.method.toUpperCase(),
    inp.path || "/",
    inp.query ?? "",    // canonical query string(STS 는 POST 바디라 빈 문자열 · S3 목록은 호출자가 정렬·인코딩해 준다)
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

// AWS STS 브로커(#746 커넥터 파도2) — 게이트웨이가 '어니스트 제공 IAM role' 을 sts:AssumeRole 로 가정해
//  멤버 귀속(RoleSessionName=멤버ID → CloudTrail 사용자 식별) 단기자격을 발급한다. IAM Identity Center 미가용 +
//  장기 액세스키 금지 전제의 정석(프로젝트 개요). 발급된 단기자격은 credential_process(AWS SDK 표준 훅) JSON 으로
//  멤버 세션(aws cli·terraform)에 전달 — 장기 시크릿은 게이트웨이 밖으로 안 나가고 클라이언트엔 15분 스코프드만.
//
//  base 자격(role 을 가정하는 주체) = 게이트웨이 프로세스 env(AWS_ACCESS_KEY_ID/SECRET[/SESSION_TOKEN]) — 운영자 설정.
//  가정 대상 role ARN·region = vault(org_credential kind=aws_role_arn 의 meta) — 어니스트가 role·trust 를 세팅하면 등록.
//  SigV4 는 자체 구현(aws-sigv4.ts, 실 STS GetCallerIdentity 로 E2E 검증). STS 호출은 주입가능(fetchSts)라 단위테스트 가능.
import https from "node:https";
import http from "node:http";
import { signRequestV4, type AwsCreds } from "./aws-sigv4.js";

export const STS_MIN_DURATION = 900;
export const STS_MAX_DURATION = 3600; // 브로커 상한(짧은 JIT — role 자체 MaxSessionDuration 과 별개로 게이트웨이가 캡)

const ARN_RE = /^arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/; // us-gov-west-1 등 다중 하이픈 리전도 허용

// 멤버ID → 유효 RoleSessionName. AWS 규칙 [\w+=,.@-]{2,64}. 접두 'lively-' + 정제(비허용문자→-) + 64자 절단.
export function roleSessionName(memberId: string): string {
  const clean = String(memberId || "").replace(/[^\w+=,.@-]/g, "-").replace(/^-+/, "");
  const name = `lively-${clean || "member"}`.slice(0, 64);
  return name.length >= 2 ? name : "lively-member";
}

export function clampDuration(sec: unknown): number {
  const n = Math.floor(Number(sec));
  if (!Number.isFinite(n)) return STS_MAX_DURATION;
  return Math.min(Math.max(n, STS_MIN_DURATION), STS_MAX_DURATION);
}

export interface AssumeRoleInput {
  roleArn: string;
  region: string;
  memberId: string;
  externalId?: string | null;   // role trust 가 ExternalId 를 요구하면(혼동대리인 방지) 전달
  durationSeconds?: number;
  baseCreds: AwsCreds;          // 게이트웨이 base 신원(role 을 가정하는 주체)
  now: Date;
}
export interface TempCreds { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }

// XML 파서(경량 — 태그 사이 텍스트 추출). STS 응답의 <Credentials> 필드만 뽑는다(신뢰 소스=AWS STS).
function xmlField(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

export interface StsHttp { (url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> }

// 기본 STS 전송 — node https POST(공개 AWS 엔드포인트). 8s 타임아웃.
const defaultStsHttp: StsHttp = (url, headers, body) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = https.request({ host: u.host, path: u.pathname, method: "POST", headers, timeout: 8000 }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
  });
  req.on("timeout", () => req.destroy(new Error("STS 요청 타임아웃")));
  req.on("error", reject);
  req.write(body); req.end();
});

// role 가정 → 단기자격. fetchSts 주입 시 단위테스트(실 네트워크 없이). 실패는 안전 메시지로 throw(자격 값 미노출).
export async function assumeRole(inp: AssumeRoleInput, fetchSts: StsHttp = defaultStsHttp): Promise<TempCreds> {
  if (!ARN_RE.test(inp.roleArn)) throw new Error(`role ARN 형식 오류: ${inp.roleArn}`);
  if (!REGION_RE.test(inp.region)) throw new Error(`region 형식 오류: ${inp.region}`);
  const duration = clampDuration(inp.durationSeconds ?? STS_MAX_DURATION);
  const sessionName = roleSessionName(inp.memberId);

  const params: Record<string, string> = {
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: inp.roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: String(duration),
  };
  if (inp.externalId) params.ExternalId = inp.externalId;
  const body = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  const host = `sts.${inp.region}.amazonaws.com`; // 지역 엔드포인트(regional STS)
  const signed = signRequestV4({
    method: "POST", host, path: "/", region: inp.region, service: "sts", body,
    headers: { "content-type": "application/x-www-form-urlencoded" }, creds: inp.baseCreds, now: inp.now,
  });
  const headers: Record<string, string> = { ...signed, "Content-Type": "application/x-www-form-urlencoded", Host: host };

  const res = await fetchSts(`https://${host}/`, headers, body);
  if (res.status !== 200) {
    const code = xmlField(res.body, "Code") || `HTTP ${res.status}`;
    throw new Error(`STS AssumeRole 실패(${code}) — role/trust/base자격 확인`); // STS 에러 메시지엔 자격 없음
  }
  const credsXml = res.body.match(/<Credentials>[\s\S]*?<\/Credentials>/)?.[0] ?? "";
  const accessKeyId = xmlField(credsXml, "AccessKeyId");
  const secretAccessKey = xmlField(credsXml, "SecretAccessKey");
  const sessionToken = xmlField(credsXml, "SessionToken");
  const expiration = xmlField(credsXml, "Expiration");
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
    throw new Error("STS 응답 파싱 실패 — Credentials 누락");
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

// AWS credential_process 규격 JSON(Version 1) — 멤버 세션의 aws cli/SDK 가 이 형식을 stdout 으로 받는다.
//  https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sourcing-external.html
export function toCredentialProcessJson(c: TempCreds): string {
  return JSON.stringify({
    Version: 1,
    AccessKeyId: c.accessKeyId,
    SecretAccessKey: c.secretAccessKey,
    SessionToken: c.sessionToken,
    Expiration: c.expiration,
  });
}

// 게이트웨이 base 자격 해소(env) — 없으면 null. 운영자가 게이트웨이 프로세스 env 에 설정. IMDS 폴백은 resolveGatewayBaseCreds.
export function gatewayBaseCreds(): AwsCreds | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

// ── EC2 인스턴스 프로파일(IMDSv2) 폴백 ──
//  '장기키 금지' 전제상 base 자격은 정적 env 키가 아니라 EC2 인스턴스 프로파일(회전되는 단기자격)이 정석.
//  링크로컬 169.254.169.254 는 makeSsrfFetch 가 (정당히) 차단하므로 여기 전용 신뢰 fetch(의도된 메타데이터 호출)로.
//  IMDSv2(토큰) 만 사용 — v1 비활성 하드닝 환경 대비. 비EC2/미가용이면 즉시 null(부정 캐시로 느린 재시도 억제).
const IMDS_HOST = "169.254.169.254";
export interface ImdsHttp { (method: "GET" | "PUT", path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> }
const defaultImdsHttp: ImdsHttp = (method, path, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: IMDS_HOST, path, method, headers, timeout: 1000 }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
  });
  req.on("timeout", () => req.destroy(new Error("IMDS 타임아웃")));
  req.on("error", reject);
  req.end();
});

interface ImdsCache { creds: AwsCreds | null; expEpochMs: number }
let imdsCache: ImdsCache | null = null;
const IMDS_SKEW_MS = 300_000;   // 만료 5분 전 갱신(요청 중 만료 방지)
const IMDS_NEG_TTL_MS = 60_000; // 미가용(비EC2 등) 부정 캐시 — 매 호출 느린 재시도 방지

// IMDSv2 로 인스턴스 프로파일 단기자격 획득(캐시). imds 주입 시 단위테스트(실 네트워크 없이).
export async function fetchImdsBaseCreds(imds: ImdsHttp = defaultImdsHttp): Promise<AwsCreds | null> {
  const now = Date.now();
  if (imdsCache && imdsCache.expEpochMs > now + (imdsCache.creds ? IMDS_SKEW_MS : 0)) return imdsCache.creds;
  const neg = (): null => { imdsCache = { creds: null, expEpochMs: now + IMDS_NEG_TTL_MS }; return null; };
  try {
    const tok = await imds("PUT", "/latest/api/token", { "X-aws-ec2-metadata-token-ttl-seconds": "21600" });
    if (tok.status !== 200 || !tok.body.trim()) return neg();
    const h = { "X-aws-ec2-metadata-token": tok.body.trim() };
    const roleRes = await imds("GET", "/latest/meta-data/iam/security-credentials/", h);
    const role = roleRes.status === 200 ? (roleRes.body.trim().split(/\r?\n/)[0] ?? "").trim() : "";
    if (!role) return neg();
    const cr = await imds("GET", `/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, h);
    if (cr.status !== 200) return neg();
    const j = JSON.parse(cr.body) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string; Code?: string };
    if ((j.Code && j.Code !== "Success") || !j.AccessKeyId || !j.SecretAccessKey || !j.Token) return neg();
    const creds: AwsCreds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token };
    const exp = j.Expiration ? Date.parse(j.Expiration) : 0;
    imdsCache = { creds, expEpochMs: exp || (now + 3_600_000) };
    return creds;
  } catch { return neg(); }
}

// 게이트웨이 base 자격 해소 — env 우선(무변경) → 없으면 EC2 인스턴스 프로파일(IMDSv2). 둘 다 없으면 null.
//  additive·안전: env 설정 시 기존 동작 그대로, 없을 때만 IMDS 시도(비EC2면 null → 기존과 동일).
export async function resolveGatewayBaseCreds(imds?: ImdsHttp): Promise<AwsCreds | null> {
  const env = gatewayBaseCreds();
  if (env) return env;
  return fetchImdsBaseCreds(imds);
}

// 테스트용 — IMDS 캐시 리셋(테스트 케이스 간 격리).
export function __resetImdsCache(): void { imdsCache = null; }

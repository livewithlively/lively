// AWS STS 브로커(#746 커넥터 파도2) — 게이트웨이가 '어니스트 제공 IAM role' 을 sts:AssumeRole 로 가정해
//  멤버 귀속(RoleSessionName=멤버ID → CloudTrail 사용자 식별) 단기자격을 발급한다. IAM Identity Center 미가용 +
//  장기 액세스키 금지 전제의 정석(프로젝트 개요). 발급된 단기자격은 credential_process(AWS SDK 표준 훅) JSON 으로
//  멤버 세션(aws cli·terraform)에 전달 — 장기 시크릿은 게이트웨이 밖으로 안 나가고 클라이언트엔 15분 스코프드만.
//
//  base 자격(role 을 가정하는 주체) = 게이트웨이 프로세스 env(AWS_ACCESS_KEY_ID/SECRET[/SESSION_TOKEN]) — 운영자 설정.
//  가정 대상 role ARN·region = vault(org_credential kind=aws_role_arn 의 meta) — 어니스트가 role·trust 를 세팅하면 등록.
//  SigV4 는 자체 구현(aws-sigv4.ts, 실 STS GetCallerIdentity 로 E2E 검증). STS 호출은 주입가능(fetchSts)라 단위테스트 가능.
import https from "node:https";
import { signRequestV4, type AwsCreds } from "./aws-sigv4.js";

export const STS_MIN_DURATION = 900;
export const STS_MAX_DURATION = 3600; // 브로커 상한(짧은 JIT — role 자체 MaxSessionDuration 과 별개로 게이트웨이가 캡)

const ARN_RE = /^arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

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

// 게이트웨이 base 자격 해소(env) — 없으면 null(브로커 비활성, 명시적 안내). 운영자가 게이트웨이 프로세스 env 에 설정.
export function gatewayBaseCreds(): AwsCreds | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

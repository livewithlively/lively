// AWS 단기자격 발급 표면(#746 커넥터 파도2) — 멤버 세션(aws cli·terraform)이 credential_process 로 호출.
//  게이트웨이가 vault(org_credential kind=aws_role_arn)의 role 을 멤버 귀속으로 가정(RoleSessionName=멤버ID)해 15분 자격 반환.
//  scope=null(인증만) — 발급 자체는 role 의 readonly 정책 + JIT 만료로 통제(등급상 L1: 세션에 스코프드 단기자격).
//  자격이 게이트웨이 밖으로 나가는 유일 경로라 감사: mcp_call_log(자동) + logger. 실제 행위 감사는 CloudTrail(RoleSessionName).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { logger } from "../log.js";
import { resolveMemberSecret } from "../org/member-secret-store.js";
import { assumeRole, gatewayBaseCreds, toCredentialProcessJson, clampDuration } from "../org/aws-broker.js";

// aws_role_arn 자격의 meta 형태: { role_arn, region, external_id? }. 값 자체(secret)는 없어도 됨(meta-only kind).
interface AwsRoleMeta { role_arn?: unknown; region?: unknown; external_id?: unknown }

const awsCredentials: Capability = {
  name: "me_aws_credentials",
  title: "내 AWS 단기자격 발급",
  description:
    "게이트웨이가 조직 IAM role 을 나(요청자) 귀속으로 가정(sts:AssumeRole, RoleSessionName=내 id)해 15분 단기자격을 발급한다. 반환은 AWS credential_process 규격 JSON — aws cli/SDK/terraform 이 credential_process 로 소비한다. 장기키는 게이트웨이 밖으로 안 나간다. role·region 은 관리자가 org_credential(kind=aws_role_arn)로 등록. CloudTrail 에 내 id 로 귀속된다.",
  scope: null,
  input: {
    scope_key: z.string().optional().describe("여러 role 등록 시 대상 구분(org_credential scope_key). 단일이면 생략"),
    duration_seconds: z.number().int().optional().describe("자격 유효기간 초(900~3600, 기본 900=15분)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/me/aws-credentials"], parse: (req) => req.body ?? {} }],
  },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as Record<string, unknown>;
    const scopeKey = i.scope_key === undefined || i.scope_key === null ? "" : String(i.scope_key).trim();

    const base = gatewayBaseCreds();
    if (!base) throw new HttpError(503, "AWS 브로커 미설정 — 게이트웨이 프로세스 env(AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)가 필요합니다(운영자)");

    // role 해소 = per-user 오버라이드 체인: 멤버 오버라이드(관리자 지정, owner=member) 우선 → 없으면 org 디폴트.
    //  안전: 오버라이드는 **관리자만**(org_credential_set member=), 멤버 self-set 은 me_credential_set 이 거부 →
    //  멤버가 임의 role 을 못 고르니 confused-deputy 없음. 오버라이드 role 이 write 권한을 담으면 그 멤버는 write 가능(인가=IAM).
    const resolved = await resolveMemberSecret(user.userId, "aws_role_arn", { scopeKey, allowFallback: true });
    if (!resolved) {
      throw new HttpError(404, `AWS role 미등록 — 관리자가 org_credential(kind=aws_role_arn${scopeKey ? `, scope_key=${scopeKey}` : ""})에 role_arn·region 을 meta 로 등록해야 합니다`);
    }
    const meta = (resolved.meta ?? {}) as AwsRoleMeta;
    const roleArn = typeof meta.role_arn === "string" ? meta.role_arn : "";
    const region = typeof meta.region === "string" ? meta.region : "";
    const externalId = typeof meta.external_id === "string" ? meta.external_id : null;
    if (!roleArn || !region) throw new HttpError(400, "aws_role_arn 자격의 meta 에 role_arn·region 이 필요합니다");

    const duration = clampDuration(i.duration_seconds ?? 900); // 기본 최소(15분) — 짧은 JIT 의도에 맞춤(리뷰)
    let creds;
    try {
      creds = await assumeRole({ roleArn, region, memberId: user.userId, externalId, durationSeconds: duration, baseCreds: base, now: new Date() });
    } catch (e) {
      logger.warn({ err: (e as Error).message, user: user.userId, roleArn }, "AWS AssumeRole 실패");
      throw new HttpError(502, `AWS 자격 발급 실패: ${(e as Error).message}`);
    }
    // 발급 감사(자격 값 제외 — 만료·role·요청자만). 실제 AWS 행위는 CloudTrail(RoleSessionName=요청자)로 귀속.
    logger.info({ audit: "aws_assume_role", user: user.userId, roleArn, region, expiration: creds.expiration }, "AWS 단기자격 발급");
    // credential_process 규격 JSON 문자열(그대로 aws cli 가 파싱) + 편의 필드.
    return {
      credential_process_json: toCredentialProcessJson(creds),
      expiration: creds.expiration,
      role_arn: roleArn,
      region,
    };
  },
};

export const awsCredentialCapabilities: Capability[] = [awsCredentials];

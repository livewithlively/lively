// AWS per-user 자격 해소(#746) — org IAM role 을 요청자 귀속(RoleSessionName=memberId)으로 assume 해 STS 단기자격 반환.
//  SigV4 프록시(mcp-proxy sigv4 auth 모드) 공용. role_arn·region·service 는 org_credential(kind=aws_role_arn) meta 에서
//  (관리자 등록) — 엔드포인트별 SigV4 service 가 달라 코드 하드코딩 안 함. 15분 자격이라 (member,scope)별 캐시.
import { assumeRole, resolveGatewayBaseCreds } from "./aws-broker.js";
import { resolveMemberSecret } from "../../org/credentials/member-secret-store.js";
import type { AwsCreds } from "./aws-sigv4.js";

export interface MemberAwsCreds { creds: AwsCreds; region: string; service: string }

interface CacheEntry { v: MemberAwsCreds; expEpochMs: number }
const cache = new Map<string, CacheEntry>();
const SKEW_MS = 60000; // 만료 1분 전 갱신(요청 중 만료 방지)

// aws_role_arn 자격 meta: role_arn, region, external_id?, service?(기본 execute-api). role 등록은 org_credential(admin) 전용.
export async function assumeMemberRole(memberId: string, scopeKey = ""): Promise<MemberAwsCreds> {
  const key = memberId + " " + scopeKey;
  const hit = cache.get(key);
  if (hit && hit.expEpochMs > Date.now() + SKEW_MS) return hit.v;
  // per-user 오버라이드 체인: 멤버 오버라이드(관리자 지정 owner=member) 우선 → org 디폴트. 멤버 self-set 은 거부돼 안전(오버라이드=admin 전용).
  const resolved = await resolveMemberSecret(memberId, "aws_role_arn", { scopeKey, allowFallback: true });
  if (!resolved) throw new Error("AWS role 미등록 — 관리자가 org_credential(kind=aws_role_arn)에 role_arn·region 을 meta 로 등록해야 합니다");
  const meta = resolved.meta ?? {};
  const roleArn = String(meta.role_arn || "");
  const region = String(meta.region || "");
  const service = String(meta.service || "execute-api");
  if (!roleArn || !region) throw new Error("aws_role_arn 자격 meta 에 role_arn·region 이 필요합니다");
  const base = await resolveGatewayBaseCreds();
  if (!base) throw new Error("게이트웨이 AWS 베이스 자격 없음(env 또는 EC2 인스턴스 프로파일) — STS assume 불가");
  const t = await assumeRole({ roleArn, region, memberId, externalId: meta.external_id ? String(meta.external_id) : undefined, durationSeconds: 900, baseCreds: base, now: new Date() });
  const creds: AwsCreds = { accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey, sessionToken: t.sessionToken };
  const v: MemberAwsCreds = { creds, region, service };
  cache.set(key, { v, expEpochMs: Date.parse(t.expiration) || (Date.now() + 900000) });
  return v;
}

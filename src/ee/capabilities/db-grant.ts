// raw-PII 언마스크 grant 관리 표면(P4, #746) — 직무 RBAC + JIT(만료) + maker-checker(승인자 기록).
//  기본은 전원 마스킹(#186/#705). admin 이 이 표면으로 특정 멤버에게 (source, table, column) 언마스크 권한을
//  부여/회수한다. 집행은 db_query 가 요청자의 유효 grant 를 해소(policy.resolveUnmaskKeys)해 per-user 차감.
//  scope=admin(권한 부여는 관리 행위). v1 승인 = admin 이 approved_by 를 명시(관리탭 maker-checker),
//  v2 = 고객사 A generic ApprovalRequest 연계. 모든 grant/revoke 는 org_content_audit 에 남는다(store.audit).
import { z } from "zod";
import type { Capability } from "../../capabilities/types.js";
import { HttpError, qstr } from "../../capabilities/rest-util.js";
import { listUnmaskGrants, createUnmaskGrant, revokeUnmaskGrant } from "../../org/store.js";

function s(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  const t = String(v).trim();
  if (t.length > max) throw new HttpError(400, `인자가 ${max}자를 초과합니다`);
  return t;
}
function b(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}
// 만료(JIT) 정규화 — ISO8601 또는 상대(예: "72h"·"30d"·"90m"). 미지정이면 null(무기한, 지양).
function parseExpiry(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const t = String(v).trim();
  const rel = t.match(/^(\d+)\s*([mhd])$/i);
  if (rel) {
    const nRaw = Number(rel[1]);
    if (!Number.isFinite(nRaw) || nRaw <= 0) throw new HttpError(400, "expires 상대값이 잘못되었습니다");
    const unit = rel[2].toLowerCase();
    const ms = nRaw * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    // JIT 상한 — 상대 만료는 최대 3650일(≈10년). 초과 시 Date 범위 오버플로(toISOString throw) 대신 친절한 400.
    if (ms > 3650 * 86_400_000) throw new HttpError(400, "expires 는 3650일(10년) 이내여야 합니다");
    return new Date(Date.now() + ms).toISOString();
  }
  const ts = Date.parse(t);
  if (Number.isNaN(ts)) throw new HttpError(400, "expires 는 ISO8601 또는 상대값(72h·30d·90m)이어야 합니다");
  if (ts <= Date.now()) throw new HttpError(400, "expires 는 미래여야 합니다");
  return new Date(ts).toISOString();
}

const dbGrantList: Capability = {
  name: "db_unmask_grants",
  title: "raw-PII 언마스크 grant 목록",
  description:
    "raw-PII 언마스크 권한(org_db_unmask_grant) 목록. 특정 멤버·소스로 필터, active=true 면 유효(미해제·미만료)만. 기본 전원 마스킹이며 이 grant 를 받은 멤버만 지정 컬럼을 raw 로 조회한다(db_query 가 per-user 집행).",
  scope: "admin",
  input: {
    member: z.string().optional().describe("멤버 id 필터"),
    source: z.string().optional().describe("데이터소스 이름 필터"),
    active: z.boolean().optional().describe("true=유효(미해제·미만료)만"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/org/db-source/unmask-grants"],
      parse: (req) => ({ member: qstr(req.query?.member, "member"), source: qstr(req.query?.source, "source"), active: req.query?.active }),
    }],
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const grants = await listUnmaskGrants({
      memberId: s(i.member) || undefined, source: s(i.source) || undefined, activeOnly: b(i.active),
    });
    return { grants };
  },
};

const dbGrantCreate: Capability = {
  name: "db_unmask_grant_create",
  title: "raw-PII 언마스크 grant 부여",
  description:
    "멤버에게 (source, table, column) raw-PII 언마스크 권한을 부여한다. column 생략/'*'=그 테이블의 모든 마스킹 컬럼. expires=JIT 만료(ISO8601 또는 72h·30d·90m; 생략 시 무기한 — 지양). approved_by=승인자(maker-checker; 신청자와 다르게 권장). reason=사유(감사). 저장 즉시(≤5s) db_query 에 반영.",
  scope: "admin",
  input: {
    member: z.string().describe("대상 멤버 id"),
    source: z.string().describe("데이터소스 이름"),
    table: z.string().describe("테이블명"),
    column: z.string().optional().describe("컬럼명('*' 또는 생략=테이블 전체 마스킹 컬럼)"),
    expires: z.string().optional().describe("만료 — ISO8601 또는 72h·30d·90m"),
    reason: z.string().optional().describe("부여 사유(감사 기록)"),
    approved_by: z.string().optional().describe("승인자 id(maker-checker)"),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/org/db-source/unmask-grant"],
      parse: (req) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        return { member: body.member, source: body.source, table: body.table, column: body.column, expires: body.expires, reason: body.reason, approved_by: body.approved_by };
      },
    }],
  },
  handler: async (input, user) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const member = s(i.member, 128);
    const source = s(i.source, 128);
    const table = s(i.table, 128).toLowerCase();
    const column = (s(i.column, 128) || "*").toLowerCase();
    if (!member || !source || !table) throw new HttpError(400, "member·source·table 은 필수입니다");
    const expires_at = parseExpiry(i.expires);
    const grant = await createUnmaskGrant({
      member_id: member, source, table_name: table, column_name: column,
      reason: s(i.reason, 500) || null, approved_by: s(i.approved_by, 128) || null, expires_at,
    }, user.userId);
    return { ok: true, grant };
  },
};

const dbGrantRevoke: Capability = {
  name: "db_unmask_grant_revoke",
  title: "raw-PII 언마스크 권한 해제",
  description: "언마스크 grant 를 해제한다(revoked_at 세팅 — 멱등). 저장 즉시(≤5s) db_query 에서 그 멤버의 해당 컬럼이 다시 마스킹된다. 되돌릴 수 있다(재부여 가능).",
  scope: "admin",
  input: { id: z.union([z.string(), z.number()]).describe("grant id") },
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/org/db-source/unmask-grant/revoke"],
      parse: (req) => ({ id: (req.body ?? {} as Record<string, unknown>).id }),
    }],
  },
  handler: async (input, user) => {
    const id = s((input as Record<string, unknown> | undefined)?.id, 32);
    if (!id) throw new HttpError(400, "id 는 필수입니다");
    await revokeUnmaskGrant(id, user.userId);
    return { ok: true, revoked: id };
  },
};

export const dbGrantCapabilities: Capability[] = [dbGrantList, dbGrantCreate, dbGrantRevoke];

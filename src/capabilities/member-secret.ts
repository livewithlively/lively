// per-user 백엔드 자격 vault 표면(P1, #746) — 능동 커넥터 툴이 쓰는 자격의 등록/조회/삭제.
//  me/*(본인, scope=null 인증만) + org/*(게이트웨이 통합 자격, admin). git 자격(delivery.ts me_git_credential_*)의 일반화판.
//  시크릿은 절대 응답으로 나가지 않는다(has_secret 플래그·meta 만). 해소·복호는 커넥터 툴이 member-secret-store 로 직접.
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { secretsEnabled } from "../org/secret-box.js";
import {
  GATEWAY_OWNER, memberOwner, listMemberSecretsPublic, listSecretsByKindPublic,
  setMemberSecret, deleteMemberSecret,
} from "../org/member-secret-store.js";

// 알려진 kind — 표면 문서/검증용(스토어는 형식만 검증하므로 신규 커넥터가 kind 를 늘려도 되지만, 오타 방지 힌트).
const KNOWN_KINDS = [
  "gitlab_pat", "github_pat", "slack_user_token", "google_oauth_refresh", "clickup_token",
  "notion_token", "aws_role_arn", "prometheus_bearer", "figma_token",
];
const KIND_DESC = `자격 종류(예: ${KNOWN_KINDS.join(", ")} — 신규 커넥터가 확장 가능)`;

function s(v: unknown, max = 4096): string {
  if (v === undefined || v === null) return "";
  const t = String(v);
  if (t.length > max) throw new HttpError(400, `값이 ${max}자를 초과합니다`);
  return t;
}
function metaOf(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "meta 는 객체여야 합니다");
  return v as Record<string, unknown>;
}

const SET_INPUT = {
  kind: z.string().describe(KIND_DESC),
  scope_key: z.string().optional().describe("같은 kind 다중 대상 구분(예 gitlab host). 단일이면 생략"),
  secret: z.string().optional().describe("시크릿 값(토큰·refresh token 등). 생략 시 기존 유지 — meta/label 만 갱신"),
  meta: z.record(z.any()).optional().describe("비밀 아닌 부속정보(oauth client_id·aws account/region 등). ⚠ 평문 저장·admin 열람가능 — 토큰/시크릿은 절대 meta 에 넣지 말고 secret 에 넣을 것(secret 만 암호화·비노출)"),
  label: z.string().optional(),
};
const DEL_INPUT = { kind: z.string().describe(KIND_DESC), scope_key: z.string().optional() };

// ── me/* — 본인 자격(인증만) ──
const meCredentials: Capability = {
  name: "me_credentials", title: "내 백엔드 자격 목록",
  description: "현재 로그인/토큰 구성원의 등록된 백엔드 자격(kind·scope_key·meta·존재 플래그) 목록. 시크릿 값은 절대 반환하지 않는다. 커넥터 툴(gitlab·slack·aws…)이 write·raw 접근 시 이 자격을 쓴다.",
  scope: null, input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/me/credentials"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    return { credentials: await listMemberSecretsPublic(memberOwner(user.userId)), encryption_ready: secretsEnabled() };
  },
};
const meCredentialSet: Capability = {
  name: "me_credential_set", title: "내 백엔드 자격 등록",
  description: "본인 백엔드 자격을 등록/갱신한다(secret 봉투 암호화 저장). secret 생략 시 meta/label 만 갱신. 이 자격은 나의 세션 툴 호출에만 쓰이고 타 구성원에게 노출되지 않는다.",
  scope: null, input: SET_INPUT,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/credential"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as Record<string, unknown>;
    if (!s(i.kind)) throw new HttpError(400, "kind 는 필수입니다");
    // ⚠ aws_role_arn 은 멤버 개인 등록 금지(관리자 org_credential 전용) — 게이트웨이 공용 신원이 가정할 role 을
    //  멤버가 지정하면 confused-deputy/권한상승. AWS 단기자격은 me_aws_credentials 로 발급받는다(role 은 org 만).
    if (s(i.kind).toLowerCase() === "aws_role_arn") {
      throw new HttpError(403, "aws_role_arn 은 개인 자격으로 등록할 수 없습니다 — 관리자가 통합 자격(org)으로만 등록합니다. AWS 단기자격은 me_aws_credentials 로 발급받으세요.");
    }
    if (i.secret !== undefined && s(i.secret) && !secretsEnabled()) {
      throw new HttpError(400, "시크릿 암호화 키(CONNECTOR_SECRET_KEY) 미설정 — 자격을 저장할 수 없습니다");
    }
    const cred = await setMemberSecret(
      memberOwner(user.userId), i.kind, i.scope_key,
      { secret: i.secret === undefined ? null : s(i.secret), meta: metaOf(i.meta), label: s(i.label, 200) || null },
      user.userId,
    );
    return { credential: cred };
  },
};
const meCredentialDelete: Capability = {
  name: "me_credential_delete", title: "내 백엔드 자격 삭제",
  description: "본인 백엔드 자격을 삭제한다(kind·scope_key 지정).",
  scope: null, input: DEL_INPUT,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/credential/delete"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as Record<string, unknown>;
    if (!s(i.kind)) throw new HttpError(400, "kind 는 필수입니다");
    return { deleted: await deleteMemberSecret(memberOwner(user.userId), i.kind, i.scope_key) };
  },
};

// ── org/* — 게이트웨이 통합 자격(admin). 비-PII read 의 폴백(온보딩 0)으로 쓰인다. ──
const orgCredentials: Capability = {
  name: "org_credentials", title: "게이트웨이 통합 자격 목록",
  description: "게이트웨이(조직 통합) 백엔드 자격 목록. 비-PII read 커넥터에서 구성원 개인 자격이 없을 때 폴백으로 쓰인다. kind 를 주면 그 kind 의 전체 owner(구성원 포함) 개관. 시크릿 값은 반환하지 않는다.",
  scope: "admin", input: { kind: z.string().optional().describe("주면 그 kind 의 전 owner 개관(관리)") },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/credentials"], parse: (req) => ({ kind: req.query?.kind }) }] },
  handler: async (input) => {
    const kind = s((input as Record<string, unknown> | undefined)?.kind, 40);
    if (kind) return { kind, credentials: await listSecretsByKindPublic(kind) };
    return { credentials: await listMemberSecretsPublic(GATEWAY_OWNER), encryption_ready: secretsEnabled() };
  },
};
const orgCredentialSet: Capability = {
  name: "org_credential_set", title: "게이트웨이 통합/구성원 자격 등록",
  description: "백엔드 자격을 등록한다(admin). member 생략 시 조직 통합(기본, 전원 폴백); member 지정 시 그 구성원 개인 오버라이드(owner=member). aws_role_arn 오버라이드는 여기(admin)로만 — 멤버 self-set 은 거부(confused-deputy 방지). 오버라이드 role 에 write 권한이 있으면 그 구성원은 write 가능(인가 경계=IAM role).",
  scope: "admin", input: { ...SET_INPUT, member: z.string().optional().describe("지정 시 그 구성원 개인 오버라이드로 저장(owner=member:<id>). 생략 시 조직 통합 기본") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/credential"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    const i = (input ?? {}) as Record<string, unknown>;
    if (!s(i.kind)) throw new HttpError(400, "kind 는 필수입니다");
    if (i.secret !== undefined && s(i.secret) && !secretsEnabled()) {
      throw new HttpError(400, "시크릿 암호화 키(CONNECTOR_SECRET_KEY) 미설정 — 자격을 저장할 수 없습니다");
    }
    const target = s(i.member); // 지정 시 구성원 오버라이드, 아니면 조직 통합
    const owner = target ? memberOwner(target) : GATEWAY_OWNER;
    const cred = await setMemberSecret(
      owner, i.kind, i.scope_key,
      { secret: i.secret === undefined ? null : s(i.secret), meta: metaOf(i.meta), label: s(i.label, 200) || null },
      user.userId,
    );
    return { credential: cred, owner };
  },
};
const orgCredentialDelete: Capability = {
  name: "org_credential_delete", title: "게이트웨이 통합/구성원 자격 삭제",
  description: "자격을 삭제한다(admin). member 지정 시 그 구성원 오버라이드 삭제(owner=member), 생략 시 조직 통합.",
  scope: "admin", input: { ...DEL_INPUT, member: z.string().optional().describe("지정 시 그 구성원 오버라이드 삭제") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/credential/delete"], parse: (req) => req.body ?? {} }] },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    if (!s(i.kind)) throw new HttpError(400, "kind 는 필수입니다");
    const target = s(i.member);
    return { deleted: await deleteMemberSecret(target ? memberOwner(target) : GATEWAY_OWNER, i.kind, i.scope_key) };
  },
};

export const memberSecretCapabilities: Capability[] = [
  meCredentials, meCredentialSet, meCredentialDelete,
  orgCredentials, orgCredentialSet, orgCredentialDelete,
];

// OIDC 로그인의 '이 사람이 우리 조직의 누구인가' 매핑(#1520). 신원 입증(auth/oidc.ts)과 분리한 이유:
//  입증은 표준 프로토콜이고 매핑은 **조직 정책**이다(누구를 자동으로 들일지, 어떤 권한으로).
//
//  정책(윤상민 결정 2026-08-04): **도메인 allowlist 자동 가입**.
//   OIDC_ALLOWED_DOMAINS 에 있는 도메인의 검증된 이메일이면 첫 로그인에 멤버를 만든다. 없으면 거절한다
//   (기존 멤버는 도메인과 무관하게 통과 — 관리자가 이미 들인 사람이다).
//  자동 생성 멤버의 권한은 org_member 의 DB 기본값과 같은 최소 3종(items·context·memory)이다.
//   admin·runtime·db·code 는 **절대 자동으로 주지 않는다** — 그건 사람이 관리탭에서 올린다.
//   (세션 scope 는 매 요청 org_member.scopes 를 LIVE 로 읽으므로, 관리자가 올리면 즉시 반영되고
//    내리면 즉시 회수된다 — auth/sessions.ts 의 계약.)
//
//  매칭 순서: ① identities 의 oidc sub ② 이메일. sub 를 먼저 보는 이유는 사람이 회사 이메일을 바꿔도
//   같은 사람으로 이어지기 때문이고, 이메일 폴백이 필요한 이유는 **첫 로그인엔 sub 가 아직 없기** 때문이다
//   (기존 멤버는 관리자가 이메일로 등록해 뒀다). 이메일로 붙으면 그때 sub 를 새겨 다음부터 ①로 걸린다.
import { itemsPool } from "../db/client.js";
import { getMember, upsertMember, memberIdByEmail, type MemberIdentity } from "../org/store/members.js";
import { logger } from "../log.js";
import { domainOf, emailFromClaims, type IdTokenClaims, type OidcConfig } from "./oidc.js";

export const OIDC_IDENTITY_SYSTEM = "oidc";
// 자동 가입 멤버의 초기 권한 — org/schema/core.ts 의 org_member.scopes DEFAULT 와 같은 값(단일 출처는 DB
//  기본값이지만 여기서 명시적으로 준다: '자동 가입이 무엇을 주는가'가 코드에 보여야 검토가 가능하다).
export const AUTO_PROVISION_SCOPES = ["items", "context", "memory"] as const;

export type OidcLoginResult =
  | { ok: true; memberId: string; created: boolean }
  | { ok: false; reason: "no_email" | "not_member" | "domain_not_allowed" | "inactive" };

// sub → 멤버. identities 는 jsonb 배열이라 containment(@>)로 찾는다(멤버 수는 조직 규모라 인덱스 불요).
async function memberByOidcSub(sub: string): Promise<{ id: string; state: string } | null> {
  const r = await itemsPool.query(
    `SELECT id, state FROM org_member WHERE identities @> $1::jsonb LIMIT 1`,
    [JSON.stringify([{ system: OIDC_IDENTITY_SYSTEM, external_id: sub }])],
  );
  const row = r.rows[0] as { id: string; state: string } | undefined;
  return row ?? null;
}

// 이메일 로컬파트 → 멤버 id 후보. 기존 멤버 id 관례(짧은 소문자 슬러그)에 맞춘다. 충돌하면 -2, -3…
async function freshMemberId(email: string): Promise<string> {
  const base = email.slice(0, email.indexOf("@")).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "user";
  for (let i = 1; i <= 50; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    if (!(await getMember(cand))) return cand;
  }
  // 50개가 다 차는 건 사실상 없다 — 그래도 로그인이 막히지 않게 무작위 접미로 확정한다.
  return `${base}-${Math.floor(Date.now() % 100000)}`;
}

// identities 에 oidc sub 를 새긴다(있으면 그대로). upsertMember 는 identities 를 **통째로 교체**하므로
//  기존 배열을 읽어 덧붙여 넘긴다 — 슬랙·깃랩 등 다른 연결을 지우면 안 된다.
async function rememberSub(memberId: string, sub: string, email: string, name: string | null): Promise<void> {
  const m = await getMember(memberId);
  if (!m) return;
  if (m.identities.some((i) => i.system === OIDC_IDENTITY_SYSTEM && i.external_id === sub)) return;
  // 같은 IdP 의 다른 sub 가 이미 있으면 교체한다 — IdP 에서 계정을 지웠다 다시 만들면 sub 가 바뀐다
  //  (구글 워크스페이스 실동작). 이메일 소유권은 IdP 가 email_verified 로 보증하므로 최신 sub 를 따른다.
  const rest = m.identities.filter((i) => i.system !== OIDC_IDENTITY_SYSTEM);
  if (rest.length !== m.identities.length) {
    logger.warn({ memberId }, "[oidc] 같은 IdP 의 이전 sub 를 새 sub 로 교체한다(IdP 계정 재생성 추정)");
  }
  const next: MemberIdentity[] = [...rest, {
    system: OIDC_IDENTITY_SYSTEM, external_id: sub, email, display_name: name ?? undefined,
  }];
  await upsertMember({ id: memberId, identities: next }, memberId, "web");
}

// 신원(claims) → 우리 조직의 멤버. 실패 사유는 호출부가 사람에게 보여줄 문구를 고르는 데만 쓴다.
export async function resolveOidcMember(claims: IdTokenClaims, cfg: OidcConfig): Promise<OidcLoginResult> {
  const email = emailFromClaims(claims, cfg);
  if (!email) return { ok: false, reason: "no_email" };
  const sub = String(claims.sub);
  const name = claims.name ? String(claims.name) : null;

  // ① sub 로 이미 아는 사람인가.
  const bySub = await memberByOidcSub(sub);
  if (bySub) {
    if (bySub.state !== "active") return { ok: false, reason: "inactive" };
    return { ok: true, memberId: bySub.id, created: false };
  }

  // ② 이메일로 등록된 멤버인가(첫 로그인 경로). 도메인 allowlist 와 무관하게 통과 — 관리자가 들인 사람이다.
  const byEmail = await memberIdByEmail(email);
  if (byEmail) {
    const m = await getMember(byEmail);
    if (!m || m.state !== "active") return { ok: false, reason: "inactive" };
    await rememberSub(byEmail, sub, email, name);
    return { ok: true, memberId: byEmail, created: false };
  }

  // ③ 자동 가입 — allowlist 도메인만. hd(구글 워크스페이스 도메인)가 있으면 그것도 같아야 한다:
  //  개인 지메일이 회사 도메인을 흉내 낼 수는 없지만, hd 는 '이 계정이 그 워크스페이스 소속'이라는
  //  IdP 의 추가 진술이라 있으면 함께 본다(없는 IdP 도 많으므로 없을 때 막지는 않는다).
  const dom = domainOf(email);
  const allowed = cfg.allowedDomains.includes(dom);
  const hd = claims.hd ? String(claims.hd).toLowerCase() : null;
  if (!allowed || (hd !== null && hd !== dom)) {
    return { ok: false, reason: cfg.allowedDomains.length ? "domain_not_allowed" : "not_member" };
  }
  const id = await freshMemberId(email);
  await upsertMember({
    id, kind: "human", display_name: name ?? email.slice(0, email.indexOf("@")), email,
    identities: [{ system: OIDC_IDENTITY_SYSTEM, external_id: sub, email, display_name: name ?? undefined }],
    state: "active", scopes: [...AUTO_PROVISION_SCOPES],
  }, id, "web");
  logger.info({ memberId: id, domain: dom }, "[oidc] allowlist 도메인 자동 가입으로 멤버를 생성했다");
  return { ok: true, memberId: id, created: true };
}

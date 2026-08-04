// OIDC 로그인의 '이 사람이 우리 조직의 누구인가' 매핑(#1520). 신원 입증(auth/oidc.ts)과 분리한 이유:
//  입증은 표준 프로토콜이고 매핑은 **조직 정책**이다(누구를 자동으로 들일지, 어떤 권한으로).
//
//  정책(윤상민 결정 2026-08-04): **도메인 allowlist 자동 가입**.
//   OIDC_ALLOWED_DOMAINS 에 있는 도메인의 검증된 이메일이면 새 구성원으로 시작할 수 있다.
//   기존 구성원은 도메인과 무관하게 통과한다 — 관리자가 이미 들인 사람이다.
//  자동 생성 구성원의 권한은 org_member 의 DB 기본값과 같은 최소 3종(items·context·memory)이다.
//   admin·runtime·db·code 는 **절대 자동으로 주지 않는다** — 그건 사람이 관리탭에서 올린다.
//   (세션 scope 는 매 요청 org_member.scopes 를 LIVE 로 읽으므로, 관리자가 올리면 즉시 반영되고
//    내리면 즉시 회수된다 — auth/sessions.ts 의 계약.)
//
//  매칭 순서: ① identities 의 oidc sub ② 이메일. sub 를 먼저 보는 이유는 사람이 회사 이메일을 바꿔도
//   같은 사람으로 이어지기 때문이고, 이메일 폴백이 필요한 이유는 **첫 로그인엔 sub 가 아직 없기** 때문이다
//   (기존 구성원은 관리자가 이메일로 등록해 뒀다). 이메일로 붙으면 그때 sub 를 새겨 다음부터 ①로 걸린다.
//
//  ⚠ 둘 다 실패하면 **여기서 새 구성원을 만들지 않는다** — 호출부가 사람에게 묻는다(#1520 B).
//   이메일 표기만 다른 사람(a.b@ vs ab@)에게 조용히 빈 계정을 하나 더 만들어 주는 게 이 흐름의
//   가장 흔한 사고였다. 본인은 자기 데이터가 없는 화면을 보고, 관리자는 중복 구성원을 나중에 발견한다.
import { itemsPool } from "../db/client.js";
import { getMember, upsertMember, memberIdByEmail, type MemberIdentity } from "../org/store/members.js";
import { hasCredential } from "./local-accounts.js";
import { logger } from "../log.js";
import { domainOf, emailFromClaims, type IdTokenClaims, type OidcConfig } from "./oidc.js";

export const OIDC_IDENTITY_SYSTEM = "oidc";
// 자동 가입 구성원의 초기 권한 — org/schema/core.ts 의 org_member.scopes DEFAULT 와 같은 값(단일 출처는 DB
//  기본값이지만 여기서 명시적으로 준다: '자동 가입이 무엇을 주는가'가 코드에 보여야 검토가 가능하다).
export const AUTO_PROVISION_SCOPES = ["items", "context", "memory"] as const;

export interface OidcIdentity { sub: string; email: string; displayName: string | null }

export type OidcLoginResult =
  | { ok: true; memberId: string }
  // 신원은 검증됐지만 구성원을 못 정했다 — 호출부가 갈림길 화면을 띄운다. canProvision=새로 시작을 제안해도 되는가.
  | { ok: false; reason: "no_match"; identity: OidcIdentity; canProvision: boolean }
  | { ok: false; reason: "no_email" | "inactive" };

// sub → 구성원. identities 는 jsonb 배열이라 containment(@>)로 찾는다(구성원 수는 조직 규모라 인덱스 불요).
export async function memberByOidcSub(sub: string): Promise<{ id: string; state: string } | null> {
  const r = await itemsPool.query(
    `SELECT id, state FROM org_member WHERE identities @> $1::jsonb LIMIT 1`,
    [JSON.stringify([{ system: OIDC_IDENTITY_SYSTEM, external_id: sub }])],
  );
  return (r.rows[0] as { id: string; state: string } | undefined) ?? null;
}

// 이메일 로컬파트 → 구성원 id 후보. 기존 id 관례(짧은 소문자 슬러그)에 맞춘다. 충돌하면 -2, -3…
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

export type LinkResult = { ok: true } | { ok: false; reason: "taken" | "no_member" };

// 구성원에 IdP 신원을 붙인다 — 로그인 중 연결(B)과 설정에서 연결(A)이 **공유하는 단 하나의 자리**.
//  upsertMember 는 identities 를 통째로 교체하므로 기존 배열을 읽어 덧붙인다(슬랙·깃랩 등 다른 연결 보존).
//  ⚠ 그 sub 가 이미 **다른** 구성원에게 붙어 있으면 거절한다 — 허용하면 한 IdP 계정으로 두 사람에
//   로그인할 수 있게 되고, 나중 연결이 앞의 연결을 조용히 무력화한다.
export async function linkOidcToMember(memberId: string, idn: OidcIdentity): Promise<LinkResult> {
  const m = await getMember(memberId);
  if (!m) return { ok: false, reason: "no_member" };
  const owner = await memberByOidcSub(idn.sub);
  if (owner && owner.id !== memberId) return { ok: false, reason: "taken" };
  if (m.identities.some((i) => i.system === OIDC_IDENTITY_SYSTEM && i.external_id === idn.sub)) return { ok: true };
  // 같은 IdP 의 다른 sub 가 이미 있으면 교체한다 — IdP 에서 계정을 지웠다 다시 만들면 sub 가 바뀐다
  //  (구글 워크스페이스 실동작). 이메일 소유권은 IdP 가 email_verified 로 보증하므로 최신 sub 를 따른다.
  const rest = m.identities.filter((i) => i.system !== OIDC_IDENTITY_SYSTEM);
  if (rest.length !== m.identities.length) {
    logger.warn({ memberId }, "[oidc] 같은 IdP 의 이전 sub 를 새 sub 로 교체한다(IdP 계정 재생성 추정)");
  }
  const next: MemberIdentity[] = [...rest, {
    system: OIDC_IDENTITY_SYSTEM, external_id: idn.sub, email: idn.email,
    display_name: idn.displayName ?? undefined,
  }];
  await upsertMember({ id: memberId, identities: next }, memberId, "web");
  return { ok: true };
}

// 연결 해제 — 로컬 비밀번호가 없으면 **막는다**. 해제하는 순간 로그인 수단이 0이 되어 자기 계정에서 잠긴다.
export async function unlinkOidcFromMember(memberId: string): Promise<{ ok: true } | { ok: false; reason: "would_lock_out" | "no_member" }> {
  const m = await getMember(memberId);
  if (!m) return { ok: false, reason: "no_member" };
  if (!(await hasCredential(memberId))) return { ok: false, reason: "would_lock_out" };
  const next = m.identities.filter((i) => i.system !== OIDC_IDENTITY_SYSTEM);
  if (next.length !== m.identities.length) await upsertMember({ id: memberId, identities: next }, memberId, "web");
  return { ok: true };
}

// 내 로그인 수단 현황 — 설정 화면(A)이 '지금 무엇으로 들어올 수 있는지'를 보여주는 데 쓴다.
export async function oidcLinkStatus(memberId: string): Promise<{ linked: boolean; email: string | null; hasPassword: boolean }> {
  const m = await getMember(memberId);
  const idn = m?.identities.find((i) => i.system === OIDC_IDENTITY_SYSTEM) ?? null;
  return { linked: !!idn, email: idn?.email ?? null, hasPassword: await hasCredential(memberId) };
}

// 새 구성원으로 시작(#1520 B 의 ① 갈래) — 갈림길 화면에서 사람이 고른 뒤에만 불린다.
export async function provisionOidcMember(idn: OidcIdentity): Promise<string> {
  const id = await freshMemberId(idn.email);
  await upsertMember({
    id, kind: "human", display_name: idn.displayName ?? idn.email.slice(0, idn.email.indexOf("@")),
    email: idn.email,
    identities: [{
      system: OIDC_IDENTITY_SYSTEM, external_id: idn.sub, email: idn.email,
      display_name: idn.displayName ?? undefined,
    }],
    state: "active", scopes: [...AUTO_PROVISION_SCOPES],
  }, id, "web");
  logger.info({ memberId: id, domain: domainOf(idn.email) }, "[oidc] 새 구성원으로 시작(allowlist 도메인)");
  return id;
}

// 자동 가입을 **제안해도 되는가** — allowlist 도메인이고, IdP 가 워크스페이스 도메인(hd)을 말해줬다면 그것도 같을 때.
//  hd 는 '이 계정이 그 워크스페이스 소속'이라는 IdP 의 추가 진술이다. 안 주는 IdP 도 많으므로 없을 때 막지는 않는다.
function canProvision(claims: IdTokenClaims, cfg: OidcConfig, email: string): boolean {
  const dom = domainOf(email);
  const hd = claims.hd ? String(claims.hd).toLowerCase() : null;
  return cfg.allowedDomains.includes(dom) && (hd === null || hd === dom);
}

// 신원(claims) → 우리 조직의 구성원. 못 정하면 새로 만들지 않고 갈림길 재료를 돌려준다.
export async function resolveOidcMember(claims: IdTokenClaims, cfg: OidcConfig): Promise<OidcLoginResult> {
  const email = emailFromClaims(claims, cfg);
  if (!email) return { ok: false, reason: "no_email" };
  const identity: OidcIdentity = {
    sub: String(claims.sub), email, displayName: claims.name ? String(claims.name) : null,
  };

  // ① sub 로 이미 아는 사람인가.
  const bySub = await memberByOidcSub(identity.sub);
  if (bySub) {
    if (bySub.state !== "active") return { ok: false, reason: "inactive" };
    return { ok: true, memberId: bySub.id };
  }

  // ② 이메일로 등록된 구성원인가(첫 로그인 경로). allowlist 와 무관하게 통과 — 관리자가 들인 사람이다.
  const byEmail = await memberIdByEmail(email);
  if (byEmail) {
    const m = await getMember(byEmail);
    if (!m || m.state !== "active") return { ok: false, reason: "inactive" };
    await linkOidcToMember(byEmail, identity);
    return { ok: true, memberId: byEmail };
  }

  // ③ 못 정했다 — 사람에게 묻는다(새로 시작 / 기존 계정에 연결).
  return { ok: false, reason: "no_match", identity, canProvision: canProvision(claims, cfg, email) };
}

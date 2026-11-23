// 토큰 발급 흐름 공용 프리미티브 — 디바이스 코드(#880)와 OAuth 2.1 인가서버(#1473 T2)가 **같은 규율**을
//  쓰도록 한 곳에 둔다. 두 흐름은 표면만 다르고(CLI vs 브라우저 클라이언트) 보안 계약은 동일하다:
//   ① 비밀은 평문 저장 금지(sha256) ② PKCE 는 S256 만 ③ 발급 scope 는 확대 불가(교집합).
//  복제하면 한쪽만 고쳐지는 날이 온다 — 그래서 헬퍼로 뽑았다.
import crypto from "node:crypto";
import { DANGEROUS_SCOPES, isScope, type Scope } from "../../auth/scopes.js";
import type { LivelyUser } from "../../context.js";

// 저장용 해시 — 토큰·코드·요청 id 전부 이 형태로만 DB 에 남는다(auth_token 과 동일 계약).
export const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// PKCE S256: base64url(sha256(verifier)). 클라이언트가 보내는 code_challenge 와 같은 계산.
export const s256 = (verifier: string): string => crypto.createHash("sha256").update(verifier).digest("base64url");

// 추측 불가 비밀 생성(코드·리프레시·요청 id). 32바이트 = 256bit — 충돌·무차별 대입 모두 비현실적.
export const randomSecret = (bytes = 32): string => crypto.randomBytes(bytes).toString("base64url");

/**
 * 발급 가능한 scope 계산 — **절대 확대되지 않는다**.
 *  granted = memberScopes(발급 시점 LIVE 상한) ∩ allowed(승인자/요청자가 허용한 집합) − (위험 scope, opt-in 없으면)
 *
 * allowed 를 생략(undefined)하면 '멤버 상한 전체'가 후보다 — OAuth 클라이언트가 scope 파라미터를 안 보내는
 *  경우(챗 표면에서 흔하다)를 위한 것이고, 어차피 사람이 동의 화면에서 결과 목록을 보고 승인한다.
 *  빈 배열([])은 '아무것도 허용 안 함'이라는 명시적 의사이므로 그대로 빈 결과를 낸다(undefined 와 구분).
 */
export function grantableScopes(opts: {
  memberScopes: unknown;
  allowed?: string[] | null;
  allowDangerous?: boolean;
}): Scope[] {
  const live = (Array.isArray(opts.memberScopes) ? opts.memberScopes : []).filter(isScope);
  const allowed = opts.allowed == null ? null : new Set(opts.allowed);
  return live.filter((s) => (allowed === null || allowed.has(s)) && (opts.allowDangerous || !DANGEROUS_SCOPES.has(s)));
}

/**
 * 이 자격으로 굽는 로그인 토큰이 **구성원의 지금 권한을 따라도 되나**(#5712 — auth_token.follow_safe_scopes 를 켤지).
 *  디바이스 로그인 승인(device_approve)과 본인 발급(org_token_mint_self)이 같은 판정을 쓴다 — 한 곳에서만 고친다.
 *  이 판정이 «확대 불가» 를 지킨다. 범위가 고정된 자격이 구성원 권한 전체를 따르는 토큰을 낳으면, 그 자격을 좁혀 둔 뜻이 사라진다
 *  (그 토큰은 시간이 지나며 구성원을 따라 넓어지고, 원래 자격을 회수해도 남는다).
 *   · 웹 로그인 세션 — 참. 세션의 scope 는 구성원 라이브 scope 그 자체다(auth/sessions.ts).
 *   · DB 토큰 — **그 토큰이 구성원을 따르는 토큰일 때만** 참(LivelyUser.followsMemberSafe — 토큰의 성질이지 그때의 권한 견주기가 아니다).
 *     관리자가 scope 를 골라 구운 토큰은 그때 구성원 권한과 같았더라도 거짓이다. 데스크톱 앱 안에서 다시 로그인할 때의 승인 자격
 *     (이미 구성원을 따르는 로그인 토큰)이 참인 쪽이다.
 *   · OAuth 발급분 · 앱 토큰 · 앱 서버가 실어 온 신원 · 앱 주소로 들어온 신원 · 도구 상한이 걸린 토큰 · 정적 토큰 — 거짓. 그 범위는 동의 화면 · 앱 동의가 정한 계약이다.
 */
export function credentialFollowsMember(user: Pick<LivelyUser, "tokenSource" | "followsMemberSafe" | "oauthClientId" | "appId" | "appServer" | "toolCeiling" | "appAddress"> | undefined): boolean {
  if (!user) return false;
  //  앱 주소(`/_lively/*`)로 들어온 신원(appAddress)은 세션 꼴이어도 앱 화면의 것이다 — 앱이 선언한 도구만 부르므로 여기 닿지 않지만, 닿더라도 거짓.
  if (user.oauthClientId || user.appId || user.appServer === true || user.toolCeiling != null || user.appAddress != null) return false;
  if (user.tokenSource === "session") return true;
  return user.tokenSource === "db" && user.followsMemberSafe === true;
}

/**
 * 디바이스 로그인의 «승인자가 허용한 상한»(pending_device_auth.approver_scopes)에 «이 토큰은 비위험 권한에서 구성원을 따른다» 를 싣고 읽는다(#5712).
 *  **scope 가 아닌 표지 하나**(FOLLOW_SAFE_MARK)로 싣는다 — 승인 자격이 구성원을 따라도 되는 자격일 때(credentialFollowsMember)만.
 *  상한에 든 scope 의 수로 뜻을 미루어 읽지 않는다: 비위험 scope 를 전부 쥔 OAuth · 앱 자격의 승인이 따르는 토큰을 낳으면 안 된다.
 *  칸을 따로 두지 않는 까닭: 승인과 수령 사이(최대 15분)에 게이트웨이 판이 바뀌어도 안전하다 —
 *   · 옛 판이 수령: 상한을 «구성원 라이브 ∩ 상한» 으로만 읽는다(grantableScopes). 표지는 scope 가 아니라 아무것도 넓히지 않는다 → 종전 결과.
 *   · 옛 판이 승인: 표지가 없다 → 새 판은 따르지 않는 토큰을 굽는다(닫힌 쪽 · 종전 결과).
 *  발급 scope 계산(grantableScopes)은 그대로다.
 */
export const FOLLOW_SAFE_MARK = "~follow-safe";
export function ceilingWithSafeFollow(approverScopes: readonly string[]): string[] {
  return [...approverScopes.filter(isScope), FOLLOW_SAFE_MARK];
}
export function ceilingFollowsSafe(ceiling: readonly string[]): boolean {
  return ceiling.includes(FOLLOW_SAFE_MARK);
}

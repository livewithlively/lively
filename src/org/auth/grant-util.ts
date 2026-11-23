// 토큰 발급 흐름 공용 프리미티브 — 디바이스 코드(#880)와 OAuth 2.1 인가서버(#1473 T2)가 **같은 규율**을
//  쓰도록 한 곳에 둔다. 두 흐름은 표면만 다르고(CLI vs 브라우저 클라이언트) 보안 계약은 동일하다:
//   ① 비밀은 평문 저장 금지(sha256) ② PKCE 는 S256 만 ③ 발급 scope 는 확대 불가(교집합).
//  복제하면 한쪽만 고쳐지는 날이 온다 — 그래서 헬퍼로 뽑았다.
import crypto from "node:crypto";
import { DANGEROUS_SCOPES, SAFE_SCOPES, isScope, type Scope } from "../../auth/scopes.js";

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
 * 제시한 자격이 그 구성원의 **비위험 권한을 전부** 쥐고 있나(#5712) — 쥐고 있을 때만 그 자격으로 굽는 로그인 토큰이 구성원의 지금 권한을
 *  따른다(auth_token.follow_safe_scopes). 이 판정이 «확대 불가» 를 지킨다: 관리자가 일부러 좁게 구워 준 토큰으로 디바이스 로그인을
 *  승인하거나 본인 토큰을 다시 구워도, 구성원 권한 전체를 따르는 토큰으로 바뀌지 않는다(종전처럼 교집합에 묶인다).
 *   · 웹 로그인 세션은 scope 가 구성원 라이브 scope 그 자체다(auth/sessions.ts) → 언제나 참.
 *   · 토큰 자격은 구성원이 지금 가진 비위험 scope 를 **하나도 빠짐없이** 쥐고 있을 때 참 — 이미 구성원을 따르는 토큰(데스크톱 앱 안에서
 *     다시 로그인할 때의 승인 자격)이 여기 든다. 구성원에게 비위험 scope 가 하나도 없으면 견줄 것이 없어 거짓이다(닫힌 쪽).
 */
export function holdsMemberSafeScopes(opts: { memberScopes: unknown; presented: readonly string[]; session: boolean }): boolean {
  if (opts.session) return true;
  const safe = new Set<string>(SAFE_SCOPES);
  const live = (Array.isArray(opts.memberScopes) ? opts.memberScopes : []).filter((s): s is Scope => isScope(s) && safe.has(s));
  if (!live.length) return false;
  const held = new Set(opts.presented);
  return live.every((s) => held.has(s));
}

/**
 * 디바이스 로그인의 «승인자가 허용한 상한»(pending_device_auth.approver_scopes)에 «비위험 권한은 구성원을 따른다» 를 싣고 읽는다(#5712).
 *  상한에 비위험 scope 가 **전부** 들어 있으면 그 뜻이다 — 승인자가 구성원의 비위험 권한을 전부 쥐고 있을 때(holdsMemberSafeScopes)만
 *  그렇게 적는다. 칸을 따로 두지 않는 까닭: 승인과 수령 사이(최대 15분)에 게이트웨이 판이 바뀌어도 양쪽이 같은 값을 읽는다 —
 *  옛 판은 «구성원 라이브 ∩ 상한» 으로 종전 그대로 굽고, 새 판은 옛 판이 적은 상한(승인 때 권한 그대로)을 종전 뜻으로 읽는다.
 *  발급 scope 계산(grantableScopes)은 그대로다: 구성원 라이브와 교집합하므로 넓힌 상한이 발급 기록을 넓히지 않는다.
 */
export function ceilingWithSafeFollow(approverScopes: readonly string[]): string[] {
  return [...new Set<string>([...approverScopes.filter(isScope), ...SAFE_SCOPES])];
}
export function ceilingFollowsSafe(ceiling: readonly string[]): boolean {
  const held = new Set(ceiling);
  return SAFE_SCOPES.every((s) => held.has(s));
}

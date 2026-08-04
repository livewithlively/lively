// 토큰 발급 흐름 공용 프리미티브 — 디바이스 코드(#880)와 OAuth 2.1 인가서버(#1473 T2)가 **같은 규율**을
//  쓰도록 한 곳에 둔다. 두 흐름은 표면만 다르고(CLI vs 브라우저 클라이언트) 보안 계약은 동일하다:
//   ① 비밀은 평문 저장 금지(sha256) ② PKCE 는 S256 만 ③ 발급 scope 는 확대 불가(교집합).
//  복제하면 한쪽만 고쳐지는 날이 온다 — 그래서 헬퍼로 뽑았다.
import crypto from "node:crypto";
import { DANGEROUS_SCOPES, isScope, type Scope } from "../../auth/scopes.js";

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

// 권한 scope 단일 진실원천 (B2) — Capability.scope union · web.ts mw() · 토큰/멤버 검증이
// 전부 여기서 파생한다. 새 scope 를 추가하려면 이 배열만 고친다 — mw() 가 자동으로 fail-closed
// 게이트를 만들어, "scope 는 추가했는데 미들웨어 분기를 빠뜨려 인증만으로 통과"하는 권한 구멍(B1)을 차단.
// #1313 R9: capabilities/scopes.ts 에서 원문 이동 — 권한 공용층은 MCP 표면(capabilities/) 밖에 둔다.
export const SCOPES = ["items", "context", "admin", "runtime", "db", "memory", "code"] as const;
export type Scope = (typeof SCOPES)[number];

// 멤버/토큰에 부여 가능한(그리고 capability 가 요구할 수 있는) scope 집합.
export const SCOPES_ALLOWED: ReadonlySet<string> = new Set<string>(SCOPES);

export function isScope(s: unknown): s is Scope {
  return typeof s === "string" && SCOPES_ALLOWED.has(s);
}

// fleet 제어·정책 변경 scope — 멤버 머신에서 도는 코드(훅)나 조직 정책을 바꾼다.
// 회수 불가한 정적 토큰(AUTH_TOKENS_JSON)으로는 이 scope 의 행위를 금지한다(B5: kill-switch 보장).
export const DANGEROUS_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["admin", "runtime"]);

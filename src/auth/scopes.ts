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

// 위험 scope 를 뺀 나머지 — 구성원의 «평소 권한». 사람이 자기 컴퓨터를 연결해 받는 로그인 토큰은 이 범위에서
//  구성원의 지금 권한을 따른다(org/store/tokens.ts computeEffectiveScopes 의 followSafeScopes). SCOPES 에서 파생하므로
//  새 scope 를 더하면 위험 목록에 넣지 않는 한 여기에 저절로 든다.
export const SAFE_SCOPES: readonly Scope[] = SCOPES.filter((s) => !DANGEROUS_SCOPES.has(s));

// 새 구성원의 기본 권한 — scope 를 고르지 않고 구성원을 만들 때 주는 값(상민 2026-11-23: 종전 items · context · memory 는
//  너무 좁았다 — DB 조회 · 코드 도구까지가 기본). 만드는 길(웹 등록 폼 · REST/MCP org_member_upsert · 회사 계정 자동 가입 ·
//  DB 칸 기본값)이 전부 이 값을 쓴다: 웹은 web/admin-members.ts MEMBER_DEFAULT_SCOPES, DB 는 org/schema/core.ts 의 DEFAULT 가 같은 값이다.
//  ⚠ SAFE_SCOPES 에서 파생하지 않고 일부러 적는다 — 새 scope 를 더했다고 모든 새 구성원의 기본값이 저절로 넓어지면 안 된다.
//  ⚠ 공용 시트가 가져도 되는 권한(ai-runs/plan.ts SEAT_BASIC_SCOPES)은 이 값과 별개다(더 좁다).
export const DEFAULT_MEMBER_SCOPES: readonly Scope[] = ["items", "context", "memory", "db", "code"];

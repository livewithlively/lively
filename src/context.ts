// 요청 컨텍스트 — 모든 툴의 "보안 경계"가 여기서 시작된다.
// 모든 툴 핸들러는 첫 줄에서 resolveUser() → requireScope() 를 통과해야 한다.

export interface LivelyUser {
  userId: string;
  email: string;
  scopes: string[]; // 접근 가능 capability: items | context | admin | runtime | db | memory | code (단일 출처: capabilities/scopes.ts)
  projects: string[]; // 접근 가능 프로젝트 슬러그, "*" = 전체
  // 인증 출처 — 'static'=AUTH_TOKENS_JSON(회수 불가), 'db'=auth_token(즉시 회수 가능).
  // 정적 토큰은 admin/runtime 행위가 거부된다(B5: 회수 불가 토큰으로 fleet 코드 푸시 금지).
  tokenSource?: "static" | "db";
  tokenHashPrefix?: string; // DB 토큰 sha256 prefix(감사 상관추적용 — 비밀 아님)
}

// MCP 핸들러의 extra.authInfo.extra 에 우리가 심어둔 사용자 정보를 꺼낸다.
// (src/auth/bearer.ts 의 verifyAccessToken 이 여기에 LivelyUser 를 넣는다)
export function resolveUser(extra: unknown): LivelyUser {
  const authInfo = (extra as { authInfo?: { extra?: unknown } } | undefined)?.authInfo;
  const user = authInfo?.extra as LivelyUser | undefined;
  if (!user || !user.userId) {
    throw new Error("Unauthenticated: no user resolved from bearer token");
  }
  return user;
}

export function requireScope(user: LivelyUser, scope: string): void {
  if (!user.scopes.includes(scope)) {
    throw new Error(`Forbidden: user '${user.userId}' lacks scope '${scope}'`);
  }
}

export function canAccessProject(user: LivelyUser, project: string): boolean {
  return user.projects.includes("*") || user.projects.includes(project);
}

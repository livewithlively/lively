// 요청 컨텍스트 — 모든 툴의 "보안 경계"가 여기서 시작된다.
// 모든 툴 핸들러는 첫 줄에서 resolveUser() → requireScope() 를 통과해야 한다.

import { SELF_SOURCE } from "./db/self-source.js"; // 값 상수만(런타임 의존 없음 — self-source.ts 는 무-import)
import { permits, type Grants, type Need } from "./auth/permissions.js";

export interface LivelyUser {
  userId: string;
  email: string;
  scopes: string[]; // 접근 가능 capability: items | context | admin | runtime | db | memory | code (단일 출처: capabilities/scopes.ts)
  // 새 권한(#5799 auth/permissions.ts) — 영역마다 보기 · 고치기. **실려 있으면 판정은 이것만 본다**(grantsOf): scopes 는 옛 코드 ·
  //  되돌리기용 사본이 된다. 없으면(undefined) 종전 그대로 scopes 로 판정한다. 역할을 받은 구성원(org_member.role)의 주체에만 실린다 —
  //  웹 세션(auth/sessions.ts) · 토큰(org/store/tokens.ts) · 앱 주체(앱 동의로 좁혀서). ⚠ 주체를 `...user` 로 펼쳐 새 주체를 만들면 이 칸이
  //  통째로 따라간다 — 권한을 좁혀야 하는 자리(앱 주체)는 cappedGrantsField 로 반드시 덮는다(capabilities/app-principal.test A7).
  grants?: Grants;
  projects: string[]; // 접근 가능 프로젝트 슬러그, "*" = 전체
  // 인증 출처 — 'static'=AUTH_TOKENS_JSON(회수 불가), 'db'=auth_token(즉시 회수 가능),
  //  'session'=웹 로그인 세션(사람 본인, scope=멤버 LIVE). 정적 토큰만 admin/runtime 행위가 거부된다
  //  (B5: 회수 불가 토큰으로 fleet 코드 푸시 금지 — 세션·DB 토큰은 허용).
  tokenSource?: "static" | "db" | "session";
  tokenHashPrefix?: string; // DB 토큰 sha256 prefix(감사 상관추적용 — 비밀 아님)
  // OAuth 2.1 인가서버가 발급한 토큰이면 그 클라이언트 id(#1473 T2). 사람이 발급한 토큰은 없음(undefined).
  //  헤더를 못 넣는 챗 표면의 프로필(읽기전용 등)을 '토큰에 묶는' 축이 이 값이다(T3 #1499).
  oauthClientId?: string;
  // 앱 세션 토큰이면 그 앱 id(#1780). 일반 토큰은 undefined. 이 값이 있으면 그 세션의 능력 호출은
  //  **그 앱 grant 의 도구 allowlist 로 축소**된다(requireAppTool — 헤더 자기주장이 아니라 토큰에 구운 경계).
  appId?: string;
  // 앱 서버가 사람 신원(X-Lively-Identity)을 싣고 부른 요청이면 true(#4483) — 그때 userId 는 그 **구성원**이고 권한은
  //  그 사람 ∩ 그 사람의 앱 동의다(apps/app-server-auth). 빈도 한도를 사람마다 따로 센다.
  //  #4891 — 앱 서버 급 토큰(auth_token.app_server_principal — 사람 홈 없는 작업 AI)도 검증부터 true 다. 둘 다 능력 API(· 앱 서버 급은 /mcp)
  //   에서만 통하고 무조건 통과 도구가 꺼진다(auth/http-auth.appPrincipalGate · apps/principal.appToolAllowed).
  appServer?: boolean;
  // 앱 주소의 `/_lively/*` 로 들어온 호출이면 그 주소의 판(#4482) — 보는 판(선언한 도구 · 표)을 사람이 아니라 주소가 정한다
  //  (apps/visibility.ts Viewer.address). 앞단이 서명한 것에서만 채운다 — 기계 헤더(apps/app-front-api.ts) · 앱 서버가 실어 온 사람 신원의 판
  //  (#4485 apps/app-server-auth.ts — 서버 코드가 도는 판과 같은 판의 표).
  appAddress?: "pub" | "draft";
  // 앱 백그라운드 작업 안에서 온 호출이면 그 작업 번호(#4486) — 앱의 SDK 가 «돌기 신원» 을 실어 부른 것(apps/app-jobs.ts resolveJobRunPrincipal).
  //  그때 userId 는 작업을 시작한 사람이고 appServer 도 true 다. 작업이 시작하는 다음 작업은 이 번호를 부모로 적는다(깊이 상한).
  appJobId?: number;
  // 앱이 선언한 MCP 도구를 게이트웨이가 앱 서버로 부른 동안의 호출이면 그 부르기 번호(#5053) — 앱의 SDK 가 «돌기 신원» 을 실어 부른 것
  //  (apps/app-server-call.ts resolveCallRunPrincipal). 그때 userId 는 도구를 부른 사람이고 appServer 도 true 다.
  appCallId?: number;
  // 도구 상한(auth_token.tool_ceiling) — 앱 AI 작업 토큰이 앱의 작업별 허용 목록(매니페스트 ai.tools)을 싣는다. 있으면 그 이름들만 부를 수 있다
  //  (앱 동의와 둘 다 — apps/principal.appToolAllowed · 세션 배관 면제보다 앞선다). MCP 도구 목록에서도 그 밖은 감춘다(server.buildServer).
  toolCeiling?: readonly string[];
  // 이 DB 토큰이 **구성원의 비위험 권한(admin · runtime 밖)을 따르는 토큰**이면 true(#5712 — org/store/tokens.verifyDbToken 이 채운다).
  //  이 자격으로 디바이스 로그인을 승인하거나 본인 토큰을 다시 구울 때, 새 토큰도 구성원을 따르게 구워도 되는가의 근거다
  //  (org/auth/grant-util.credentialFollowsMember). 범위가 고정된 토큰(관리자가 scope 를 골라 구운 것 · OAuth · 앱 토큰)은 없다(undefined).
  followsMemberSafe?: boolean;
}

// MCP 핸들러의 extra.authInfo.extra 에 우리가 심어둔 사용자 정보를 꺼낸다.
// (src/auth/bearer.ts 의 verifyAccessToken 이 여기에 LivelyUser 를 넣는다)
/**
 * 이 주체의 도구가 모두 앱 도구 게이트(apps/principal.appToolAllowed)로만 다니나 — 앱 서버 급 주체(#4891)이거나 도구 상한이 실린 토큰(ai.tools).
 *  이런 주체는 그 게이트를 타는 문(능력 REST · /mcp)에서만 받고(auth/http-auth.appPrincipalGate), 제품 DB 도구도 그 게이트를 탄다(tools/db).
 *  빈 상한([])도 상한이다 — 길이가 아니라 있음으로 본다.
 */
export function confinedToAppTools(user: Pick<LivelyUser, "appServer" | "toolCeiling"> | undefined): boolean {
  return user?.appServer === true || user?.toolCeiling != null;
}

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

/**
 * 권한 판정(#5799) — 등록부 밖의 호출 경로(외부 앱 도구)가 쓴다. 새 권한이 실린 주체는 need 로, 옛 scope 만 가진 주체는 종전 그대로
 *  legacyScope 로 잰다(auth/permissions.ts permits). 거절 문구는 종전 꼴을 잇는다(사람이 읽을 문구는 화면 단계에서 바꾼다).
 */
export function requireNeed(user: LivelyUser, need: Need | null, legacyScope: string): void {
  if (!permits(user, legacyScope, need)) {
    throw new Error(`Forbidden: user '${user.userId}' lacks scope '${legacyScope}'`);
  }
}

export function canAccessProject(user: LivelyUser, project: string): boolean {
  return user.projects.includes("*") || user.projects.includes(project);
}

// ── DB 데이터소스 접근(db_query/db_schema/db_sources) ──
// 권한은 기존 scopes[] 를 재사용한다(컬럼 마이그레이션 불필요):
//   'db'          → 모든 소스 허용(후방호환 — 기존 db 스코프 토큰 무변경)
//   'db:<source>' → 특정 소스만 허용(세밀화)
export function canAccessDbSource(user: LivelyUser, source: string): boolean {
  //  #5799 — 역할을 받은 구성원에게 DB 소스는 **기본 불가**다(결정 2026-11-25: 등록한 관리자도 자동으로는 조회하지 못한다).
  //   소스마다 사람 · 팀을 지정하는 단계가 들어오기 전까지는 내장 self 소스만 관리자에게 열린다(아래 #604 와 같은 예외).
  //   옛 구성원은 아래 종전 판정 그대로다.
  if (user.grants) return source === SELF_SOURCE && permits(user, "admin", { perm: "admin", level: "write" });
  if (user.scopes.includes("db") || user.scopes.includes(`db:${source}`)) return true;
  // #604: 내장 self 소스(게이트웨이 자기 items DB, 콘텐츠 allow-list)는 admin 이면 별도 db 스코프 없이 읽기 허용.
  if (source === SELF_SOURCE && user.scopes.includes("admin")) return true;
  return false;
}

export function requireDbSource(user: LivelyUser, source: string): void {
  if (!canAccessDbSource(user, source)) {
    throw new Error(`Forbidden: user '${user.userId}' lacks db access to source '${source}'`);
  }
}

// 디스커버리(db_sources) 진입 게이트 — 어떤 형태든 db 권한이 하나라도 있으면 목록 열람 가능.
//  #604: admin 은 내장 self 소스를 발견/사용할 수 있어야 하므로 db 스코프가 없어도 목록 열람 허용(내용은 canAccessDbSource 로 재차 게이트).
export function hasAnyDbAccess(user: LivelyUser): boolean {
  //  #5799 — 역할을 받은 구성원: DB 조회 자격이 있거나 관리자면 목록을 본다(어느 소스가 열리는지는 canAccessDbSource 가 다시 잰다).
  if (user.grants) return permits(user, "db", { perm: "db", level: "read" }) || permits(user, "admin", { perm: "admin", level: "write" });
  return user.scopes.includes("admin") || user.scopes.some((s) => s === "db" || s.startsWith("db:"));
}

// 앱 서버 자격(#4483) — 앱 서버(Express · Lambda)가 게이트웨이를 부르는 길: «앱 서버 토큰 + 사람 신원 토큰».
//
// ── 두 조각 ──────────────────────────────────────────────────────────────────────────────
//  ① 앱 서버 토큰 — 멤버 없는 앱 토큰(auth_token: app_id 있음 · member_id 없음 · scope 없음). 토큰 저장소는 이 모양을
//     이미 안다(store/tokens.computeEffectiveScopes — 앱이 켜져 있을 때만 유효). user_id 에 (테넌트, 앱)을 굽는다:
//     `app-server:<테넌트 UUID>:<앱 id>`. 자가호스팅 다중 워크스페이스에선 auth_token 이 박스 전역(신원 전역 표)이라,
//     굽지 않으면 W1 에서 받은 토큰이 같은 앱 id 를 깐 W2 에서도 통한다 — 그래서 요청 테넌트와 대조한다.
//     v2-6 이 배포 때 이 토큰을 함수 환경변수(LIVELY_APP_TOKEN)로 넣는다. 그 전엔 관리자가 app_server_token_mint 로 받는다.
//  ② 사람 신원 토큰 — 앞단이 서명한 X-Lively-Identity(app-identity). 앱 서버가 받은 것을 그대로 다시 싣는다.
//
// ── 판정 ─────────────────────────────────────────────────────────────────────────────────
//  ① 만으로는 아무것도 못 한다(사람 없는 호출 = 앱 자체 주체는 v2-12). ①+② 가 같은 (테넌트, 앱)이고, 그 구성원이 활성이고
//  그 워크스페이스에 들어올 수 있고, 그 앱에 동의(grant)했을 때만 주체가 **그 구성원 ∩ 그 사람의 앱 동의** 가 된다 —
//  앱 화면에서 사람이 누른 요청과 같은 권한(설계 §6 «사람 대리»). 그 뒤는 기존 앱 도구 게이트(requireAppTool)가 그대로 돈다.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { mintToken } from "../org/store/tokens.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { canSeeApp } from "./visibility.js";
import { getMember } from "../org/store/members.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { isScope } from "../auth/scopes.js";
import { isBuiltinSource } from "./store-ddl.js";
import { appSqlTenantId } from "./app-sql-exec.js";
import { verifyAppIdentity, type VerifyAppIdentityOpts } from "./app-identity.js";
import { appServerUserId, parseAppServerUserId } from "./app-server-id.js";

export { appServerUserId, parseAppServerUserId };

/** 인증된 토큰이 앱 서버 토큰인가(아직 사람 신원을 붙이기 전). */
export function isAppServerToken(user: LivelyUser | undefined): boolean {
  return !!user?.appId && !user.appServer && parseAppServerUserId(user.userId) !== null;
}

/**
 * 앱 서버 토큰 발급 — 워크스페이스가 설치한 앱만(기본 앱은 서버가 없다). 평문은 이때 한 번만 돌려준다.
 *  scope 는 비운다 — 이 토큰의 권한은 늘 «사람 신원 ∩ 그 사람의 동의» 에서 온다.
 */
export async function mintAppServerToken(appId: string, actor: string): Promise<{ token: string; expiresAt: Date | null; userId: string }> {
  const app = await getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  if (isBuiltinSource(app.source)) throw new HttpError(400, `「${app.title || appId}」 은(는) 라이블리가 싣는 기본 앱이라 앱 서버 토큰을 만들지 않습니다`);
  if (!app.enabled || app.status !== "active") throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다(${app.status})`);
  const userId = appServerUserId(appSqlTenantId(), appId);
  const { token, expiresAt } = await mintToken({ userId, scopes: [], label: `app-server:${appId}`, memberId: null, appId }, actor, "app-server");
  return { token, expiresAt, userId };
}

export interface ResolveAppServerDeps {
  tenantId?: string;
  identity?: VerifyAppIdentityOpts;
}

/**
 * 앱 서버 토큰 + 사람 신원 → 그 구성원 ∩ 앱 동의 주체. 못 맞추면 HttpError(401 신원·토큰 / 403 동의·구성원).
 *  user = 인증 계층이 앱 서버 토큰으로 만든 주체(isAppServerToken). header = 요청의 X-Lively-Identity.
 */
export async function resolveAppServerPrincipal(user: LivelyUser, header: string | string[] | undefined, deps: ResolveAppServerDeps = {}): Promise<LivelyUser> {
  const bound = parseAppServerUserId(user.userId);
  if (!bound || bound.appId !== user.appId) throw new HttpError(401, "앱 서버 토큰 모양이 맞지 않습니다");
  const tenantId = (deps.tenantId ?? appSqlTenantId()).toLowerCase();
  if (bound.tenantId !== tenantId) throw new HttpError(401, "다른 워크스페이스의 앱 서버 토큰입니다");
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    throw new HttpError(401, "앱 서버 토큰만으로는 아무것도 할 수 없습니다 — 사람 신원(X-Lively-Identity)을 함께 보내세요"
      + "(SDK 는 들어온 요청의 신원을 그대로 넘깁니다). 사람 없는 호출(앱 자체 주체)은 아직 열리지 않았습니다");
  }
  const claims = verifyAppIdentity(raw, { ws: tenantId, app: bound.appId }, deps.identity);
  const member = await getMember(claims.sub);
  if (!member || member.state !== "active") throw new HttpError(403, "신원의 구성원이 이 워크스페이스에서 활성 상태가 아닙니다");
  if (!(await workspaceAccessAllowed(member.id))) throw new HttpError(403, "신원의 구성원이 이 워크스페이스의 구성원이 아닙니다");
  //  #4667 공개 범위 — 나만 보는 앱으로 되돌린 뒤엔 동의가 남은 다른 구성원도 못 쓴다(mintAppToken 과 같은 판정 · 재검토 3-(b)).
  const app = await getApp(bound.appId);
  if (!app || !canSeeApp(app, { userId: member.id, scopes: member.scopes })) throw new HttpError(403, `이 사람은 앱 '${bound.appId}' 을(를) 쓸 수 없습니다(나만 보는 앱)`);
  const grant = await getActiveGrant(bound.appId, member.id);
  if (!grant) throw new HttpError(403, `이 사람은 앱 '${bound.appId}' 사용에 동의하지 않았습니다 — 앱 화면에서 동의한 뒤 다시 하세요`);
  const allowed = new Set(member.scopes.filter(isScope));
  return {
    userId: member.id,
    email: member.email ?? "",
    scopes: grant.scopes.filter((s) => isScope(s) && allowed.has(s)),
    projects: ["*"],
    tokenSource: "db",
    tokenHashPrefix: user.tokenHashPrefix,
    appId: bound.appId,
    appServer: true,
  };
}

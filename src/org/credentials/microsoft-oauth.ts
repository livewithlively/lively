// Microsoft 직결 OAuth(#4211 Outlook) — [Outlook 연결] **한 번**으로 메일·캘린더를 함께 붙인다(Microsoft 365 회사 계정 + outlook.com 개인 계정).
//
//  구조는 구글 직결(google-oauth.ts)과 같은 틀이다 — 예약 서버명(state.s)으로 콜백을 라우팅하고, org_mcp_server 행에 기대지
//  않는다(도구는 처음부터 Graph REST http_proxy). 이 파일은 **순수 + fetch** 만 — 금고 읽기/쓰기는 oauth-broker 가 한다.
//
//  ── 구글과 다른 점 넷(전부 실제로 사람을 막는 자리) ─────────────────────────────────────────────
//  ① **회사 계정은 그 회사 관리자의 허용이 먼저다.** 2025-11 부터 Microsoft 관리형 기본 동의 정책(새 테넌트 기본값)이
//     Mail.Read·Calendars.Read 를 **사용자 동의 불가** 목록에 넣었다. 그래서 구성원이 [허용]을 누를 수가 없고, Microsoft 가
//     «관리자 승인 필요» 화면에서 멈춘다 — 이때 **우리 콜백으로 아무것도 안 돌아오는 경우가 많다**(그 화면에 갇힌다).
//     ⇒ 화면은 오류를 기다리지 말고 **연결 전부터** 관리자에게 보낼 링크(adminconsent)를 내밀어야 한다.
//     출처: learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies (Microsoft recommended user consent policy)
//  ② `prompt=consent` 를 **쓰면 안 된다.** 관리자가 조직 전체 허용을 해 둔 회사에서 prompt=consent 는 사용자에게 동의를 다시
//     강요하고, 사용자는 동의할 권한이 없으니 도로 «관리자 승인 필요»에 갇힌다. refresh_token 은 offline_access 만 있으면
//     늘 오므로(구글과 달리 consent 강제가 필요 없다) prompt=select_account 로 계정 고르기만 연다.
//  ③ **갱신할 때마다 새 refresh_token 을 줄 수 있다** — "Replace the old refresh token with this newly acquired refresh token"
//     (v2-oauth2-auth-code-flow). 받은 것은 즉시 덮어쓴다(oauth-proxy-auth.mergeRefreshedTokens 가 이미 그렇게 한다).
//  ④ 갱신에도 client_secret 이 필요하다(웹 앱 = confidential client). 매니지드 테넌트 금고엔 클라이언트가 없으므로
//     공유 게이트웨이 env 의 **플랫폼 클라이언트**로 갱신한다(resolveMicrosoftOAuthClient). 없으면 연결 1시간 뒤 전멸한다
//     (구글 #4211 §8 에서 같은 구멍을 찾았다).
import type { FetchLike } from "./slack-oauth.js";

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
/** `common` — 회사/학교 계정과 개인 Microsoft 계정을 **둘 다** 받는 끝점(앱 등록이 «멀티테넌트 + 개인 계정»이어야 한다). */
export const MICROSOFT_AUTHORIZE_URL = `${MICROSOFT_LOGIN}/common/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_URL = `${MICROSOFT_LOGIN}/common/oauth2/v2.0/token`;
export const GRAPH_URL = "https://graph.microsoft.com/v1.0";

/** 금고 슬롯 kind(member, scope_key ""). 계정을 바꿔 다시 연결하면 같은 슬롯을 덮어쓴다. */
export const MICROSOFT_KIND = "microsoft_oauth";
/** state.s 에 실리는 예약 서버명 — org_mcp_server 행이 **아니다**(구글 `google`·노션 `notion-public` 과 같은 규약). */
export const MICROSOFT_SERVER = "microsoft";

export function isMicrosoftServer(name: string | null | undefined): boolean {
  return String(name ?? "").toLowerCase() === MICROSOFT_SERVER;
}

/**
 * 요청 범위 — **최소**다. 읽기뿐(보내기·쓰기 없음)이고, 수집·도구가 실제로 부르는 것만.
 *  · openid profile email — 어느 계정으로 붙었는지 화면에 보이려고(id_token). 셋 다 사용자 동의 가능 범위다.
 *  · offline_access — 이게 없으면 refresh_token 이 **안 온다** → 1시간 뒤 도구·수집이 전부 죽는다.
 *  · User.Read — 로그인·프로필(사용자 동의 가능). Graph 호출의 기본 짝이라 빠지면 일부 계정에서 동의 화면이 어긋난다.
 *  · Mail.Read · Calendars.Read — 이 둘이 ①의 «관리자 허용» 대상이다. 메일 수집·메일 검색 도구·캘린더 도구가 쓴다.
 *  ⚠ CP 릴레이(lvly-cloud control/src/microsoftrelay.ts)가 **같은 문자열**을 갖고 있다 — 여기를 바꾸면 거기도 바꾼다.
 *   (릴레이는 테넌트가 보낸 scope 를 받지 않는다: app.lvly.io 주소로 «더 넓은 권한 허용» 피싱 링크를 만들 수 없게.)
 */
export const MICROSOFT_SCOPES = [
  "openid", "profile", "email", "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Calendars.Read",
] as const;
export const MICROSOFT_SCOPE = MICROSOFT_SCOPES.join(" ");

/** 개인 Microsoft 계정(outlook.com·hotmail)의 고정 테넌트 id — id_token 의 tid 가 이 값이면 개인 계정이다(관리자가 없다). */
export const MSA_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * 인가 URL. `response_mode=query`(코드가 쿼리로 온다 — 서버가 읽는다) · `prompt=select_account`(②: consent 강제 금지).
 *  PKCE 는 쓰지 않는다 — 매니지드는 CP 가 교환하는데 verifier 를 보관할 자리가 서명(비암호화) state 뿐이라 주소창에 새고,
 *  웹 앱은 client_secret 으로 교환하므로 필수가 아니다(Microsoft: "recommended", SPA 만 required). 직결도 같은 모양으로 둔다.
 */
export function buildMicrosoftAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(MICROSOFT_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MICROSOFT_SCOPE);
  u.searchParams.set("state", p.state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

/**
 * ★ 관리자에게 보낼 «조직 전체 허용» 링크(v2.0 adminconsent). 관리자가 열어 로그인하고 [수락]하면 그 회사 전원이
 *  이후 [Outlook 연결]에서 막히지 않는다.
 *  · tenant — 모르면 `organizations`(관리자가 로그인하는 회사로 간다). `common` 은 **안 된다**: 개인 계정은 테넌트 밖에서
 *    관리자 동의를 줄 수 없다(v2-admin-consent: "Do not use 'common'").
 *  · scope — 사용자 동의와 같은 목록(따로 두면 한쪽만 고쳐져 «관리자는 허용했는데 사용자는 또 막힌다»가 된다).
 */
export function buildMicrosoftAdminConsentUrl(p: { clientId: string; redirectUri: string; state: string; tenant?: string }): string {
  const tenant = (p.tenant ?? "").trim() || "organizations";
  const u = new URL(`${MICROSOFT_LOGIN}/${encodeURIComponent(tenant)}/v2.0/adminconsent`);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("scope", MICROSOFT_SCOPE);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  return u.toString();
}

/**
 * Microsoft 가 돌려준 오류가 «관리자 허용이 필요하다»인가 — 화면이 **다음 한 걸음**(관리자 링크)을 내밀지 정한다.
 *  · admin    — AADSTS90094(AdminConsentRequired)·90095(관리자 승인 요청 흐름)·65001(아무도 동의 안 함) 또는 error=consent_required.
 *  · declined — 사용자가 취소(AADSTS65004·access_denied). ⚠ 관리자 승인 **요청을 보낸 뒤** [앱으로 돌아가기]도 65004 로 온다
 *               (v2 docs: "an expected part of the admin consent workflow") — 그래서 declined 문구에도 관리자 얘기를 함께 한다.
 *  · other    — 그 밖(설정 오류 등). 원문을 보여 준다.
 *  근거: AADSTS 코드표(learn.microsoft.com/entra/identity-platform/reference-error-codes) · v2-oauth2-auth-code-flow 오류 표.
 */
export type MicrosoftConsentError = "admin" | "declined" | "other";
export function classifyMicrosoftAuthError(error: string | null | undefined, description: string | null | undefined): MicrosoftConsentError {
  const e = String(error ?? "").toLowerCase();
  const d = String(description ?? "");
  if (/AADSTS(90094|90095|65001)\b/.test(d) || e === "consent_required") return "admin";
  if (/AADSTS65004\b/.test(d) || e === "access_denied") return "declined";
  return "other";
}

/** 사람에게 보일 한 문장 — 분류별. 원문 AADSTS 설명은 영어·장문이라 싣지 않는다(코드만 괄호로). */
export function microsoftAuthErrorText(kind: MicrosoftConsentError, description?: string | null): string {
  const code = /AADSTS\d+/.exec(String(description ?? ""))?.[0];
  if (kind === "admin") return "회사 관리자의 허용이 먼저 필요합니다 — 관리자에게 «조직 전체 허용» 링크를 보내 주세요." + (code ? ` (${code})` : "");
  if (kind === "declined") return "연결을 취소했습니다. 회사 계정에서 관리자 승인을 요청하셨다면, 관리자가 허용한 뒤 다시 연결하세요." + (code ? ` (${code})` : "");
  return "Microsoft 연결에 실패했습니다" + (code ? ` (${code})` : "") + ".";
}

export interface MicrosoftInstall {
  access_token: string;
  /** offline_access 동의에서만 온다. 갱신 응답에도 대개 새 것이 온다(③) — 오면 덮어쓴다. */
  refresh_token: string | null;
  /** 절대 만료 시각(**epoch 초** — oauth-proxy-auth.isTokenExpired·tokenMeta 와 같은 단위). */
  expires_at: number | null;
  scope: string;
  /** 어느 계정으로 붙었나(표시용) — id_token 의 preferred_username(대개 UPN·메일 주소) 또는 email. */
  email: string | null;
  name: string | null;
  /** 계정의 테넌트 — 회사 id 또는 MSA_TENANT_ID(개인). 관리자 링크를 그 회사로 겨눌 때 쓴다. */
  tenant_id: string | null;
}

interface TokenResp {
  error?: unknown; error_description?: unknown;
  access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; id_token?: unknown;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * id_token 의 payload 만 꺼낸다(서명 검증 안 함 — **의도적**, google-oauth.decodeIdTokenClaims 와 같은 판단).
 *  토큰 엔드포인트가 TLS 로 직접 준 응답이고, 쓰임이 **화면 표시뿐**이다. 이 값으로 권한·신원을 판단하려 들면 검증이 필요하다.
 *  ⚠ access_token 은 열어 보지 않는다 — Microsoft 는 개인 계정 토큰을 암호화해 주기도 한다("don't take dependencies").
 */
export function decodeMicrosoftIdToken(idToken: string | null): { email: string | null; name: string | null; tenant_id: string | null } {
  const none = { email: null, name: null, tenant_id: null };
  if (!idToken) return none;
  const parts = idToken.split(".");
  if (parts.length < 2) return none;
  try {
    const j = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    return { email: str(j.preferred_username) ?? str(j.email), name: str(j.name), tenant_id: str(j.tid) };
  } catch { return none; }
}

/** 토큰 응답 파싱 — 실패는 던진다(Microsoft 는 4xx + {error, error_description, error_codes}). `nowSec` 는 테스트 주입용. */
export function parseMicrosoftTokenResponse(j: unknown, nowSec = Math.floor(Date.now() / 1000)): MicrosoftInstall {
  const r = (j ?? {}) as TokenResp;
  const errCode = str(r.error);
  if (errCode) {
    const desc = str(r.error_description);
    // invalid_grant = 갱신 토큰 만료·회수(비밀번호 변경·관리자 회수 포함). 재연결 말고 길이 없다.
    if (errCode === "invalid_grant") throw new Error("Microsoft 연결이 만료되었거나 회수되었습니다 — [Outlook 연결]을 다시 하세요.");
    const kind = classifyMicrosoftAuthError(errCode, desc);
    throw new Error(kind === "other" ? `Microsoft 토큰 교환 실패: ${errCode}${/AADSTS\d+/.exec(desc ?? "")?.[0] ? ` (${/AADSTS\d+/.exec(desc ?? "")![0]})` : ""}` : microsoftAuthErrorText(kind, desc));
  }
  const tok = str(r.access_token);
  if (!tok) throw new Error("Microsoft 가 access_token 을 주지 않았습니다 — 동의가 완료되지 않았습니다.");
  const ttl = Number(r.expires_in);
  const claims = decodeMicrosoftIdToken(str(r.id_token));
  return {
    access_token: tok,
    refresh_token: str(r.refresh_token),
    expires_at: Number.isFinite(ttl) && ttl > 0 ? nowSec + Math.floor(ttl) : null,
    scope: str(r.scope) ?? "",
    email: claims.email, name: claims.name, tenant_id: claims.tenant_id,
  };
}

/** code → 토큰. client_secret 은 이 호출 안에서만 산다(응답·로그에 실리지 않는다). form 인코딩(Microsoft 표준). */
export async function exchangeMicrosoftCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; fetchFn?: FetchLike; nowSec?: number;
}): Promise<MicrosoftInstall> {
  const f = p.fetchFn ?? fetch;
  const res = await f(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: p.clientId, client_secret: p.clientSecret,
      code: p.code, redirect_uri: p.redirectUri, scope: MICROSOFT_SCOPE,
    }).toString(),
  });
  let j: unknown;
  try { j = await res.json(); } catch { throw new Error(`Microsoft 토큰 응답을 읽지 못했습니다(HTTP ${res.status})`); }
  return parseMicrosoftTokenResponse(j, p.nowSec);
}

/**
 * 저장 직전 병합 — 새 응답에 없는 것은 이전 값을 지킨다. 갱신 응답엔 id_token 이 없을 수 있어 계정 표시(email·tenant)가
 *  사라지면 안 되고, refresh_token 을 안 주는 드문 경우에도 기존 것을 잃으면 1시간 뒤 영구 실패다(구글 #1652 의 교훈).
 */
export function mergeMicrosoftTokens(prev: MicrosoftInstall | null, next: MicrosoftInstall): MicrosoftInstall {
  return {
    access_token: next.access_token,
    refresh_token: next.refresh_token ?? prev?.refresh_token ?? null,
    expires_at: next.expires_at ?? prev?.expires_at ?? null,
    scope: next.scope || prev?.scope || "",
    email: next.email ?? prev?.email ?? null,
    name: next.name ?? prev?.name ?? null,
    tenant_id: next.tenant_id ?? prev?.tenant_id ?? null,
  };
}

/**
 * 금고에 넣을 모양. 블롭은 OAuthTokens 형식(decodeTokenBlob·oauth-proxy-auth 가 그대로 읽는다), refresh_token 은 **블롭(암호문)
 *  안에만**. meta 는 평문이라 토큰 금지 — 만료(epoch 초: isTokenExpired 가 이 단위로 읽는다)·범위·계정 표시만.
 *  ⚠ 구글 슬롯은 meta.expires_at 을 ms 로 적는다 — 초 단위로 읽는 갱신 판정이 그걸 «아직 멀었다»로 본다. 여기선 초로 맞춘다.
 */
export function microsoftInstallToSlot(i: MicrosoftInstall): { scopeKey: string; secret: string; meta: Record<string, unknown> } {
  return {
    scopeKey: "",
    secret: JSON.stringify({
      access_token: i.access_token,
      token_type: "Bearer",
      scope: i.scope,
      ...(i.refresh_token ? { refresh_token: i.refresh_token } : {}),
    }),
    meta: {
      ...(i.expires_at ? { expires_at: i.expires_at } : {}),
      scope: i.scope,
      ms_email: i.email, ms_name: i.name, ms_tenant_id: i.tenant_id,
      account_type: i.tenant_id ? (i.tenant_id === MSA_TENANT_ID ? "personal" : "work") : null,
      via: "microsoft_oauth_direct",
    },
  };
}

/** 금고 (secret, meta) → MicrosoftInstall(병합의 prev). 파싱 불가/토큰 없음은 null. */
export function microsoftInstallFromSlot(secret: string | null | undefined, meta?: Record<string, unknown> | null): MicrosoftInstall | null {
  if (!secret) return null;
  try {
    const t = JSON.parse(secret) as Record<string, unknown>;
    const tok = str(t.access_token);
    if (!tok) return null;
    const m = meta ?? {};
    const exp = Number(m.expires_at);
    return {
      access_token: tok,
      refresh_token: str(t.refresh_token),
      expires_at: Number.isFinite(exp) && exp > 0 ? exp : null,
      scope: str(t.scope) ?? str(m.scope) ?? "",
      email: str(m.ms_email), name: str(m.ms_name), tenant_id: str(m.ms_tenant_id),
    };
  } catch { return null; }
}

/**
 * 동의된 범위가 이 기능을 덮는가. Microsoft 는 응답 scope 를 전체 URI(`https://graph.microsoft.com/Mail.Read`)로도,
 *  짧은 이름(`Mail.Read`)으로도 준다(계정 종류에 따라 다르다) — 둘 다 받고, 대소문자를 가리지 않는다.
 *  `.ReadWrite` 도 읽기를 덮는다(더 넓은 권한을 가진 사람이 «권한 없음»으로 막히는 구글 mail.google.com 사고의 대칭).
 */
export function microsoftScopeCovers(scope: string | null | undefined, what: "mail" | "calendar"): boolean {
  const toks = String(scope ?? "").toLowerCase().split(/\s+/).map((t) => t.replace(/^https:\/\/graph\.microsoft\.com\//, ""));
  const want = what === "mail" ? ["mail.read", "mail.readwrite"] : ["calendars.read", "calendars.readwrite"];
  return toks.some((t) => want.includes(t));
}

/**
 * Outlook 도구가 막혔을 때 **사람이 다음에 뭘 누를지**. null 이면 Microsoft 얘기가 아니다(googleToolAuthHint 와 같은 역할).
 *  종전 기본 문구는 «me_credential_set 에 등록하세요»라 OAuth 앱엔 갈 곳이 없는 안내가 된다.
 *  @param scope 잡힌 슬롯의 동의 범위. **null = 슬롯 자체가 없음**, "" = 모름(그땐 막지 않는다).
 */
export function microsoftToolAuthHint(authKind: string | null | undefined, scope: string | null, toolName = ""): string | null {
  if (String(authKind ?? "").toLowerCase() !== MICROSOFT_KIND) return null;
  if (scope === null) return "Outlook 연결이 없습니다 — [외부 앱 연결 ▸ Outlook]에서 [Outlook 연결]을 누르세요(토큰을 복사할 일은 없습니다).";
  if (!scope) return null;
  const what = /calendar/i.test(toolName) ? "calendar" : /mail/i.test(toolName) ? "mail" : null;
  if (!what || microsoftScopeCovers(scope, what)) return null;
  return `이 Outlook 연결에는 ${what === "mail" ? "메일" : "캘린더"} 권한이 없습니다 — [외부 앱 연결 ▸ Outlook]에서 [다시 연결]하세요.`;
}

/**
 * 플랫폼 소유 Microsoft 앱(매니지드) — env `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET`
 *  (lvly-cloud deploy/lvly-gw.sh 가 CP 의 LVLY_MICROSOFT_CLIENT_* 를 공유 게이트웨이에 싣는다). **둘 다** 있을 때만.
 *  신뢰 경계 판단은 구글 플랫폼 클라이언트(#4211 §8)와 같다 — 공유 게이트웨이는 이미 전 테넌트 금고를 푸는 키를 쥐고 있다.
 */
export function envMicrosoftOAuthClient(env: NodeJS.ProcessEnv = process.env): { client_id: string; client_secret: string } | null {
  const client_id = env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  const client_secret = env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
  return client_id && client_secret ? { client_id, client_secret } : null;
}

/**
 * 조직 Microsoft 클라이언트 해소 — 금고(gateway microsoft_oauth/oauth:client) 다음 플랫폼 env.
 *  ⚠ **릴레이 모드면 플랫폼이 먼저다.** 그 토큰은 CP 가 플랫폼 앱으로 발급받은 것이라 금고에 다른 앱이 들어 있어도
 *   그걸로는 갱신이 안 된다(발급 앱으로만 갱신된다 → invalid_client). 직결(셀프호스팅)은 금고가 먼저다.
 */
export async function resolveMicrosoftOAuthClient(
  vaultClient: () => Promise<{ client_id: string; client_secret?: string } | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ client_id: string; client_secret: string; source: "platform" | "vault" } | null> {
  const platform = envMicrosoftOAuthClient(env);
  if (platform && env.MICROSOFT_OAUTH_RELAY_URL?.trim()) return { ...platform, source: "platform" };
  const v = await vaultClient().catch(() => null);
  if (v?.client_id && v.client_secret) return { client_id: v.client_id, client_secret: v.client_secret, source: "vault" };
  return platform ? { ...platform, source: "platform" } : null;
}

/** 릴레이 시작점(`…/oauth/microsoft/start`) → 같은 CP 의 관리자 허용 시작점(`…/oauth/microsoft/admin-consent`). 순수. */
export function relayAdminConsentUrl(relayStart: string, gatewayUrl: string): string {
  const u = new URL(relayStart);
  u.pathname = u.pathname.replace(/\/start\/?$/, "/admin-consent");
  u.search = "";
  if (gatewayUrl) u.searchParams.set("gw", gatewayUrl);
  return u.toString();
}

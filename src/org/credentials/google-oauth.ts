// 구글 직결 OAuth(#1881 G2) — [Google 연결] **한 번**으로 드라이브·Gmail·캘린더 세 서비스를 함께 붙인다.
//
//  왜 MCP 디스커버리를 안 쓰나: 지금 구글 연결은 `org_mcp_server` 행(`drivemcp.googleapis.com` 등)에서 OAuth 메타데이터를
//  디스커버리한다 — 그런데 **도구 호출은 이미 클래식 REST(http_proxy, #1652)로 내려가 있다.** 즉 인증 앵커만
//  Developer Preview 엔드포인트에 남아 있는 상태다. 동작은 하지만(디스커버리·동의·토큰 발급은 프리뷰 등록 없이도 된다 —
//  403 은 `tools/call` 에서만 난다) 상류가 배너를 걷거나 경로를 바꾸면 **연결 개시가 통째로 죽는다.**
//  구글의 OAuth 엔드포인트는 10년째 고정이라 디스커버리할 이유가 없다 → 상수로 박고 MCP 행 의존을 끊는다.
//  부수 효과: 매니지드 개인 테넌트에 구글 MCP 행이 없어 **연결 창구가 아예 안 뜨던 것**(T10 #1993 이 `0/4` 로 남긴 자리)이
//  같이 풀린다 — 창구의 근거가 서버 행이 아니라 http_proxy 도구가 되기 때문이다.
//
//  왜 auth_kind 를 합치나: 지금은 `google_drive_oauth`·`google_gmail_oauth`·`google_calendar_oauth` 3개라 사용자가
//  [연결]을 **세 번** 눌러야 한다. 구글은 한 동의 화면에서 여러 API 범위를 함께 받으므로 나눌 이유가 없다.
//
//  이 파일은 **순수 + fetch** 만 — 금고 읽기/쓰기는 oauth-broker 가 한다(slack-oauth.ts·notion-oauth.ts 와 같은 분업:
//  순환 import 회피 + 테스트가 DB 없이 돈다). PKCE 는 쓴다(구글 지원 — 슬랙·노션과 다른 점).
//
//  ⚠ 심사 등급은 범위마다 다르다(지식 google-single-connect-design-1881 §2):
//    `calendar.readonly` = 민감(검증만, 영업일 3~5일) · `gmail.readonly`·`drive.readonly` = **제한(검증 + CASA 연례 심사)**
//    · `drive.file` = 비민감(검증 0). 미검증 상태에선 민감/제한 범위에 **평생 100 계정 한도**가 걸린다.
import type { FetchLike } from "./slack-oauth.js";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** 통합 금고 슬롯 kind. 구 kind 3종(google_drive_oauth·google_gmail_oauth·google_calendar_oauth)을 대체한다.
 *  member 슬롯의 scope_key 는 ""(구글 계정 1개) — 계정을 바꿔 다시 연결하면 같은 슬롯을 덮어쓴다. */
export const GOOGLE_KIND = "google_oauth";

/** state.s 에 실리는 예약 서버명 — org_mcp_server 행이 **아니다**(노션 `notion-public` 과 같은 규약).
 *  콜백(/oauth/callback)이 이 마커로 구글 직결 교환 분기를 탄다. */
export const GOOGLE_SERVER = "google";

export function isGoogleServer(name: string | null | undefined): boolean {
  return String(name ?? "").toLowerCase() === GOOGLE_SERVER;
}

/**
 * 구 kind 3종 — 서비스마다 따로 연결하던 시절의 금고 슬롯(#1652 이전 구조).
 *  ★ **프리셋의 auth_kind 를 바꾸지 않는다.** 대신 이 셋을 `google_oauth` 의 별칭으로 읽는다(oauth-proxy-auth).
 *   이유: 금고 행은 `(owner, kind, scope_key)` 라 kind 를 갈아치우면 **기존 연결자의 토큰이 통째로 미아가 된다.**
 *   #1652 에서 정확히 그 사고가 났다 — 토큰은 살아 있는데 화면에서 사라져 아무도 재연결을 못 했다(어니스트 5인).
 *   별칭 방향이 이 문제를 없앤다:
 *     · 예전에 붙인 사람 → 자기 구 슬롯이 그대로 먼저 잡힌다(무회귀).
 *     · 새로 붙인 사람   → 통합 슬롯 하나가 세 서비스 도구 전부를 먹인다([Google 연결] 1회).
 *   전환이 끝나면(구 슬롯 0) 프리셋을 google_oauth 로 바꾸고 이 표를 지운다.
 */
export const GOOGLE_LEGACY_KINDS = ["google_drive_oauth", "google_gmail_oauth", "google_calendar_oauth"] as const;

/** 이 auth_kind 가 통합 슬롯으로 폴백해도 되는 구 구글 kind 인가 → 통합 kind, 아니면 null. */
export function googleUnifiedKindFor(authKind: string | null | undefined): string | null {
  const k = String(authKind ?? "").toLowerCase();
  return (GOOGLE_LEGACY_KINDS as readonly string[]).includes(k) ? GOOGLE_KIND : null;
}

/** 신원 범위 — 어느 구글 계정으로 붙었는지 화면에 보여주기 위한 것. 둘 다 **비민감**이라 심사 등급을 올리지 않는다. */
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"] as const;

/** 서비스별 범위. 화면에서 켠 서비스만 골라 합집합으로 요청한다(§6 '원큐').
 *  ⚠ drive 는 두 갈래다 — `drive.readonly`(제한·CASA) vs `drive.file`(비민감·검증 0, 단 Picker 로 고른 것만).
 *   어느 쪽을 기본으로 둘지는 G6(#2075) 실측이 정한다. 지금은 종전 동작(readonly)을 유지한다. */
export const GOOGLE_SERVICE_SCOPES = {
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  drive_file: ["https://www.googleapis.com/auth/drive.file"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
} as const;

export type GoogleService = keyof typeof GOOGLE_SERVICE_SCOPES;
export const GOOGLE_DEFAULT_SERVICES: GoogleService[] = ["drive", "gmail", "calendar"];

/**
 * ★ 각 서비스가 어느 심사 등급을 끌고 오는가 — **돈과 한도가 여기서 갈린다**(지식 §2·§9).
 *  · non_sensitive — 검증 0 · CASA 0 · 100명 한도 **0**
 *  · sensitive     — 검증 필요(영업일 3~5일·무료) · CASA 없음 · 미검증이면 100명 한도
 *  · restricted    — 검증 + **CASA**(연 $540~1,800·초회 6~12주) · 미검증이면 100명 한도
 */
export const GOOGLE_SERVICE_TIER = {
  drive: "restricted",       // drive.readonly
  drive_file: "non_sensitive", // drive.file — Picker 로 고른 것만
  gmail: "restricted",       // 본문을 읽는 Gmail scope 는 전부 제한범위다(비제한 대안 없음)
  calendar: "sensitive",     // 구글 제한범위 목록에 캘린더는 없다
} as const satisfies Record<GoogleService, "non_sensitive" | "sensitive" | "restricted">;

export type GoogleScopeTier = (typeof GOOGLE_SERVICE_TIER)[GoogleService];
const TIER_RANK: Record<GoogleScopeTier, number> = { non_sensitive: 0, sensitive: 1, restricted: 2 };

/** 이 조합이 끌고 오는 **가장 높은** 등급. 화면이 어떤 경고를 띄울지, 심사를 넣을지 정하는 근거. */
export function googleConsentTier(services: readonly GoogleService[] = GOOGLE_DEFAULT_SERVICES): GoogleScopeTier {
  const picked = services.length > 0 ? services : GOOGLE_DEFAULT_SERVICES;
  let top: GoogleScopeTier = "non_sensitive";
  for (const s of picked) {
    const t = GOOGLE_SERVICE_TIER[s];
    if (t && TIER_RANK[t] > TIER_RANK[top]) top = t;
  }
  return top;
}

/**
 * ★ 이 동의가 **미검증 100명 한도를 태우는가**. 민감·제한 범위를 미검증 상태로 요청할 때만 소모되고,
 *  그 100 은 **프로젝트 수명 누적이며 리셋·증액이 불가능**하다 — 그래서 "필요 없는 서비스를 기본으로 끼워 넣는 것"이
 *  단순한 과잉권한이 아니라 **되돌릴 수 없는 자원 낭비**다. 캘린더만 켠 사람이 Gmail 까지 동의하면 그 한 칸이 날아간다.
 */
export function consumesUnverifiedUserCap(services: readonly GoogleService[] = GOOGLE_DEFAULT_SERVICES): boolean {
  return googleConsentTier(services) !== "non_sensitive";
}

/**
 * 요청할 scope 문자열 — 신원 2종 + 고른 서비스들의 합집합. 순서는 안정적으로(중복 제거 후 입력 순).
 * 서비스를 하나도 안 고르면 기본 3종으로 떨어진다(빈 scope 로 authorize 하면 구글이 400 을 준다).
 */
export function googleScopeString(services: readonly GoogleService[] = GOOGLE_DEFAULT_SERVICES): string {
  const picked = services.length > 0 ? services : GOOGLE_DEFAULT_SERVICES;
  const out: string[] = [...IDENTITY_SCOPES];
  for (const s of picked) for (const sc of GOOGLE_SERVICE_SCOPES[s] ?? []) if (!out.includes(sc)) out.push(sc);
  return out.join(" ");
}

/**
 * 인가 URL. 표준 OAuth 2.1 밖의 구글 전용 파라미터 3개가 **전부 필수**다:
 *  · `access_type=offline` — 이게 없으면 refresh_token 을 아예 안 준다 → 1시간 뒤 모든 구글 도구·수집기가 죽는다.
 *  · `prompt=consent` — 기존 grant 가 있으면 구글은 refresh_token 을 **생략한다**. 재연결이 조용히 반쪽이 되는 걸 막는다.
 *  · `include_granted_scopes=true` — 증분 인가. 나중에 서비스를 추가로 켜도 **이미 준 동의가 안 날아간다**
 *    (이게 없으면 캘린더만 다시 붙이는 순간 드라이브·Gmail 권한을 잃는다).
 */
export function buildGoogleAuthorizeUrl(p: {
  clientId: string; redirectUri: string; state: string; scope: string;
  codeChallenge?: string; loginHint?: string;
}): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", p.state);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  if (p.codeChallenge) {
    u.searchParams.set("code_challenge", p.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  if (p.loginHint) u.searchParams.set("login_hint", p.loginHint);
  return u.toString();
}

export interface GoogleInstall {
  access_token: string;
  /** ⚠ 갱신 응답에는 **없다**(구글은 최초 동의 때만 준다). 저장 시 기존 값을 보존해야 한다 — mergeGoogleTokens 참조. */
  refresh_token: string | null;
  /** 절대 만료 시각(epoch ms). 응답의 expires_in(초, 보통 3599)을 발급 시각 기준으로 굳힌 값. */
  expires_at: number | null;
  scope: string;
  /** id_token 에서 뽑은 구글 계정 — 화면에 "연결됨: someone@example.com" 을 띄우는 용도. */
  email: string | null;
  sub: string | null;
}

interface TokenResp {
  error?: unknown; error_description?: unknown;
  access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; id_token?: unknown;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * id_token 의 payload 만 꺼낸다(서명 검증 안 함 — **의도적**).
 *  이 토큰은 구글 토큰 엔드포인트가 TLS 로 우리에게 직접 준 응답 본문이라 중간자가 없다. 게다가 쓰임이
 *  **화면 표시(어느 계정으로 붙었나)뿐**이고 인가 판단에 쓰지 않는다 — 검증 라이브러리를 들이지 않는 이유.
 *  ⚠ 이 값으로 권한·신원을 판단하려 들면 그때는 서명 검증이 필요하다.
 */
export function decodeIdTokenClaims(idToken: string | null): { email: string | null; sub: string | null } {
  if (!idToken) return { email: null, sub: null };
  const parts = idToken.split(".");
  if (parts.length < 2) return { email: null, sub: null };
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { email?: unknown; sub?: unknown };
    return { email: str(json.email), sub: str(json.sub) };
  } catch { return { email: null, sub: null }; }
}

/** 토큰 응답 파싱 — 실패는 던진다(구글은 4xx + {error, error_description}).
 *  `nowMs` 는 만료 시각 계산 기준(테스트 주입용). */
export function parseGoogleTokenResponse(j: unknown, nowMs = Date.now()): GoogleInstall {
  const r = (j ?? {}) as TokenResp;
  const errCode = str(r.error);
  if (errCode) {
    const detail = str(r.error_description);
    // invalid_grant = 사용자가 접근 권한을 철회했거나 refresh_token 이 만료·회수됐다. 재연결 외에 길이 없다.
    const hint = errCode === "invalid_grant" ? " — 구글 계정에서 접근 권한이 회수되었습니다. [Google 연결]을 다시 하세요." : "";
    throw new Error(`구글 토큰 교환 실패: ${errCode}${detail ? ` — ${detail}` : ""}${hint}`);
  }
  const tok = str(r.access_token);
  if (!tok) throw new Error("구글이 access_token 을 주지 않았습니다 — 동의가 완료되지 않았습니다.");
  const ttlSec = Number(r.expires_in);
  const claims = decodeIdTokenClaims(str(r.id_token));
  return {
    access_token: tok,
    refresh_token: str(r.refresh_token),
    expires_at: Number.isFinite(ttlSec) && ttlSec > 0 ? nowMs + ttlSec * 1000 : null,
    scope: str(r.scope) ?? "",
    email: claims.email,
    sub: claims.sub,
  };
}

async function googleTokenGrant(p: { body: Record<string, string>; fetchFn?: FetchLike; nowMs?: number }): Promise<GoogleInstall> {
  const f = p.fetchFn ?? fetch;
  const res = await f(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(p.body).toString(),
  });
  let j: unknown;
  try { j = await res.json(); } catch { throw new Error(`구글 토큰 응답을 읽지 못했습니다(HTTP ${res.status})`); }
  return parseGoogleTokenResponse(j, p.nowMs);
}

/** code → 토큰 교환. client_secret 은 이 호출 안에서만 산다(응답·로그에 실리지 않는다). */
export async function exchangeGoogleCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string;
  codeVerifier?: string; fetchFn?: FetchLike; nowMs?: number;
}): Promise<GoogleInstall> {
  return googleTokenGrant({
    fetchFn: p.fetchFn, nowMs: p.nowMs,
    body: {
      grant_type: "authorization_code",
      client_id: p.clientId, client_secret: p.clientSecret,
      code: p.code, redirect_uri: p.redirectUri,
      ...(p.codeVerifier ? { code_verifier: p.codeVerifier } : {}),
    },
  });
}

/** refresh_token → 새 access token. ⚠ 응답에 refresh_token 이 **없다** — 저장은 반드시 mergeGoogleTokens 를 거친다. */
export async function refreshGoogleToken(p: {
  clientId: string; clientSecret: string; refreshToken: string; fetchFn?: FetchLike; nowMs?: number;
}): Promise<GoogleInstall> {
  return googleTokenGrant({
    fetchFn: p.fetchFn, nowMs: p.nowMs,
    body: { grant_type: "refresh_token", client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken },
  });
}

/**
 * ★ 저장 직전 병합 — **이 프로젝트에서 가장 비싼 함정**(#1652 에서 이미 한 번 밟았다).
 *  구글은 갱신 응답에 refresh_token 을 안 준다. 새 응답으로 슬롯을 통째로 덮어쓰면 갱신 토큰이 사라지고
 *  **1시간 뒤 영구 실패**한다(그때는 재연결 말고 복구 수단이 없다). scope 도 갱신 응답에서 비어 올 수 있어 보존한다.
 */
export function mergeGoogleTokens(prev: GoogleInstall | null, next: GoogleInstall): GoogleInstall {
  return {
    access_token: next.access_token,
    refresh_token: next.refresh_token ?? prev?.refresh_token ?? null,
    expires_at: next.expires_at ?? prev?.expires_at ?? null,
    scope: next.scope || prev?.scope || "",
    email: next.email ?? prev?.email ?? null,
    sub: next.sub ?? prev?.sub ?? null,
  };
}

/** 금고에 넣을 모양 — 브로커가 그대로 setMemberSecret 에 넘긴다. 블롭은 OAuthTokens 형식(decodeTokenBlob·oauth-proxy-auth 호환).
 *  ⚠ refresh_token 은 **블롭(암호문) 안에만** — meta 는 평문이라 토큰 금지(oauth-broker 규약). */
export function googleInstallToSlot(i: GoogleInstall): { scopeKey: string; secret: string; meta: Record<string, unknown> } {
  return {
    scopeKey: "",
    secret: JSON.stringify({
      access_token: i.access_token,
      token_type: "bearer",
      scope: i.scope,
      ...(i.refresh_token ? { refresh_token: i.refresh_token } : {}),
      ...(i.expires_at ? { expires_at: i.expires_at } : {}),
    }),
    meta: {
      google_email: i.email, google_sub: i.sub, scope: i.scope,
      expires_at: i.expires_at, via: "google_oauth_direct",
    },
  };
}

/** 블롭 → GoogleInstall(병합·만료 판정용). 파싱 불가/토큰 없음은 null. */
export function googleInstallFromBlob(secret: string | null | undefined): GoogleInstall | null {
  if (!secret) return null;
  try {
    const t = JSON.parse(secret) as Record<string, unknown>;
    const tok = str(t.access_token);
    if (!tok) return null;
    const exp = Number(t.expires_at);
    return {
      access_token: tok,
      refresh_token: str(t.refresh_token),
      expires_at: Number.isFinite(exp) && exp > 0 ? exp : null,
      scope: str(t.scope) ?? "",
      email: null, sub: null, // meta 쪽에 산다 — 병합에서 prev 로 쓰일 때만 필요하고 표시는 meta 를 읽는다
    };
  } catch { return null; }
}

/** 만료 판정 — 60초 여유(google-auth.ts 의 기존 규약과 같다).
 *  ⚠ `expires_at` 이 없으면 **'만료 아님'** 이다. 모르는 걸 만료로 단정하면 멀쩡한 토큰을 매 호출 갱신하고,
 *   갱신 수단이 없는 정적 자격까지 실패로 민다(#1652 의 판단을 그대로 승계). */
export function googleTokenExpired(i: GoogleInstall | null, nowMs = Date.now()): boolean {
  if (!i?.expires_at) return false;
  return i.expires_at - 60_000 <= nowMs;
}

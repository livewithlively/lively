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

/**
 * 구 kind → 그 kind 가 대표하던 서비스. **통합 kind 는 여기 없다**(어느 서비스인지 kind 만으로 알 수 없다 —
 *  모르는 것을 추측하면 엉뚱한 범위 검사가 사람을 막는다).
 */
export const GOOGLE_SERVICE_BY_KIND: Record<string, GoogleService> = {
  google_drive_oauth: "drive",
  google_gmail_oauth: "gmail",
  google_calendar_oauth: "calendar",
};

export function googleServiceForKind(kind: string | null | undefined): GoogleService | null {
  return GOOGLE_SERVICE_BY_KIND[String(kind ?? "").toLowerCase()] ?? null;
}

/**
 * 저장된 동의 scope 가 이 서비스를 덮는가. **판정을 여기 한 곳에만 둔다** — 두 벌이면 한쪽만 고쳐져서
 *  "화면은 켤 수 있다는데 호출은 403" 같은 어긋남이 난다(google-connect 의 scopeCovers 도 이걸 부른다).
 *  ⚠ Gmail 은 접두가 둘이다: `/auth/gmail.*` 과 **접두가 아예 다른 최광 범위 `https://mail.google.com/`**.
 *   후자를 빠뜨리면 가장 넓은 권한을 가진 사람이 오히려 막힌다(실제로 그 버그를 냈다).
 */
const GOOGLE_SCOPE_MARKERS: Record<GoogleService, readonly string[]> = {
  drive: ["/auth/drive"],
  drive_file: ["/auth/drive"],
  gmail: ["/auth/gmail.", "https://mail.google.com/"],
  calendar: ["/auth/calendar"],
};

export function googleScopeCovers(scope: string | null | undefined, service: GoogleService): boolean {
  const s = String(scope ?? "");
  return (GOOGLE_SCOPE_MARKERS[service] ?? []).some((m) => s.includes(m));
}

/** 사람에게 보일 이름. 오류 문구가 `google_calendar_oauth` 같은 내부 이름을 뱉으면 아무도 못 알아본다. */
const GOOGLE_SERVICE_LABEL: Record<GoogleService, string> = {
  drive: "드라이브", drive_file: "드라이브", gmail: "Gmail", calendar: "캘린더",
};

/**
 * ★ 구글 도구가 막혔을 때 **사람이 다음에 뭘 누를지** 말해 주는 문구. null 이면 구글 얘기가 아니다.
 *
 *  왜 함수로 빼나: 종전 문구가 "개인 자격을 me_credential_set 에 등록하세요" 였다 — 그건 우리가 #1881 에서
 *  **없앤 붙여넣기 경로**다. 컴맹은 그 안내를 따라갈 수 없고, 따라가 봐야 그런 화면이 없다.
 *  게다가 진짜 원인이 둘로 갈린다(연결이 아예 없다 / 연결은 있는데 그 범위가 없다)는 걸 한 문장으로 뭉개고 있었다.
 *
 *  @param scope 잡힌 슬롯의 동의 범위. **null = 슬롯 자체가 없음**, "" = 모름(그땐 막지 않는다).
 */
export function googleToolAuthHint(authKind: string | null | undefined, scope: string | null): string | null {
  const kind = String(authKind ?? "").toLowerCase();
  if (kind !== GOOGLE_KIND && !googleServiceForKind(kind)) return null;
  if (scope === null) {
    return "Google 연결이 없습니다 — [외부 앱 연결 ▸ Google]에서 [Google 연결]을 누르세요(토큰을 복사할 일은 없습니다).";
  }
  const svc = googleServiceForKind(kind);
  if (!svc || !scope || googleScopeCovers(scope, svc)) return null; // 모르면 막지 않는다
  const label = GOOGLE_SERVICE_LABEL[svc];
  return isGoogleServiceOffered(svc)
    ? `이 Google 연결에는 ${label} 권한이 없습니다 — [외부 앱 연결 ▸ Google]의 [권한 넓히기]로 한 번 더 허용하면 바로 됩니다.`
    : `${label} 은 아직 준비 중입니다 — 구글 심사 범위라 1차 공개에서 제외했습니다.`;
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

/**
 * ★ **1차 런칭에서 파는 것**(윤상민 결정 2026-08-26: "1차 런칭에서 지메일 빼").
 *
 *  Gmail 을 뺀 이유는 취향이 아니라 **되돌릴 수 없는 비용** 때문이다. 본문을 읽는 Gmail 범위는 전부 제한범위이고
 *  비제한 대안이 없다 — 검증에 CASA(연 $540~1,800·초회 6~12주)가 붙고, 미검증으로 버티면 **프로젝트 수명 누적
 *  100 계정** 한도가 걸리는데 그 100 은 리셋도 증액도 안 된다. 첫 판에 Gmail 을 끼우면 그 한도를 "쓰지도 않는
 *  권한"으로 태우게 된다.
 *
 *  ⚠ **코드는 남긴다** — GOOGLE_SERVICE_SCOPES 의 gmail 행도, 수집기도 그대로다. 이미 붙여 둔 사람
 *   (구 google_gmail_oauth 슬롯)은 계속 돌아야 하고, 한도를 지불하기로 하면 이 배열에 한 줄 되돌리는 것으로 열린다.
 *   즉 여기 있는 것은 **기능의 유무가 아니라 지금 파는 범위의 선언**이다.
 *
 *  ⚠ 그리고 이걸 뺀다고 심사가 0이 되지는 않는다 — 수집용 drive 는 `drive.readonly`(제한범위)다. 정말 0으로
 *   내리려면 `drive_file` 이어야 하는데, G6(#2075) 실측이 "폴더를 골라도 안의 파일은 안 준다"를 확정해서 폴더
 *   단위 수집이 성립하지 않는다. 그래서 1차는 **미검증 Production + 100명**으로 간다.
 */
export const GOOGLE_LAUNCH_SERVICES: readonly GoogleService[] = ["drive", "drive_file", "calendar"];

/** 이 서비스를 지금 파는가. */
export function isGoogleServiceOffered(s: string | null | undefined): boolean {
  return (GOOGLE_LAUNCH_SERVICES as readonly string[]).includes(String(s ?? ""));
}

/**
 * 요청 가능한 것만 남긴다. **빈 배열을 그대로 돌려준다** — 여기서 기본값으로 폴백하면 "gmail 만 골랐는데
 *  드라이브 동의 화면이 열리는" 꼴이 된다(안 고른 범위를 몰래 요청하는 것). 판단은 호출자가 한다.
 */
export function googleOfferedServices(services: readonly GoogleService[]): GoogleService[] {
  return services.filter((s) => isGoogleServiceOffered(s));
}

export const GOOGLE_DEFAULT_SERVICES: GoogleService[] = ["drive", "calendar"];

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
  // ★ 최종 방어선. 모든 동의 경로(직결·CP 릴레이·권한 넓히기)가 이 함수를 지나므로 여기서 막으면 새 호출자가
  //  생겨도 안 파는 범위가 샐 수 없다. 화면의 체크박스는 안내일 뿐 게이트가 아니다.
  const offered = googleOfferedServices(services);
  const picked = offered.length > 0 ? offered : googleOfferedServices(GOOGLE_DEFAULT_SERVICES);
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

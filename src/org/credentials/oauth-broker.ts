// per-member OAuth 브로커(#746 T2) — 호스팅형 remote MCP(Notion·Slack·Google 등 정적 bearer 불가, OAuth 필수)를
//  게이트웨이 프록시로 붙이기 위한 per-user OAuth 자격 관리. T1(정적토큰)의 vault 해소 체인을 OAuth 로 확장한다.
//
//  헤드리스 게이트웨이 특성상 동의(consent)는 out-of-band 2단계:
//   ① 멤버가 웹('내 자격'의 커넥트)에서 서버 X 연결 개시 → 게이트웨이가 PKCE + 서명된 state(멤버·서버·만료 포함) 로
//      authorization URL 생성 → 웹이 그 URL 을 멤버 브라우저로 오픈 → 인가.
//   ② 인가 서버가 게이트웨이 콜백으로 code+state 리다이렉트 → 게이트웨이가 state 검증(HMAC·만료) 후 code→token 교환 →
//      해당 멤버 vault 에 토큰 저장. 이후 호출 시 resolveMemberSecret 이 그 토큰을 준다(T1 과 동일 슬롯).
//
//  이 파일(T2 코어): 리뷰-독립·신규파일. 순수 프리미티브(PKCE·서명 state·토큰 코덱) + vault 백엔드 OAuthClientProvider.
//  다음(배선): SDK auth() 오케스트레이션 래퍼 + 콜백 라우트 + connectUpstream 의 authProvider 주입 + 관리 커넥트 capability.
import crypto from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientMetadata, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getMemberSecret, setMemberSecret, deleteMemberSecret, memberOwner, GATEWAY_OWNER, CLIENT_SCOPE, PKCE_SCOPE } from "./member-secret-store.js";
import { getMcpServer, getRuntimeConfig, getOrgProfile } from "../store.js";
import { presetOAuthScope } from "../delivery/mcp-server-presets.js";
import { makeSsrfFetch } from "../../net/mcp-ssrf-fetch.js";
import { logger } from "../../log.js";
import { isSlackOAuthKind, buildSlackAuthorizeUrl, exchangeSlackCode, slackInstallToSlots, parseSlackAccessResponse, relayStartUrl, SLACK_BOT_KIND, type SlackInstall } from "./slack-oauth.js";
import { isNotionPublicServer, buildNotionAuthorizeUrl, exchangeNotionCode, parseNotionTokenResponse, refreshNotionToken, notionInstallToSlot, NOTION_PUBLIC_KIND, NOTION_PUBLIC_SERVER, type NotionInstall } from "./notion-oauth.js";
import { isGoogleServer, buildGoogleAuthorizeUrl, exchangeGoogleCode, parseGoogleTokenResponse, refreshGoogleToken, mergeGoogleTokens, googleInstallToSlot, googleInstallFromBlob, googleTokenExpired, googleScopeString, GOOGLE_KIND, GOOGLE_SERVER, GOOGLE_DEFAULT_SERVICES, type GoogleInstall, type GoogleService } from "./google-oauth.js";

const STATE_KEY_ENV = "CONNECTOR_SECRET_KEY"; // 상태 서명키는 봉투암호화 키와 같은 마스터에서 도메인 분리 파생(신규 env 불요).
const STATE_INFO = "lively-oauth-state-v1";
const B64 = "base64url" as const;

// ── 마스터키 → state HMAC 키(HKDF, 도메인 분리) — secret-box 의 masterKey 파생과 동일 규약(hex64 그대로/그 외 sha256). ──
function masterIkm(): Buffer {
  const raw = process.env[STATE_KEY_ENV]?.trim();
  if (!raw) throw new Error(`${STATE_KEY_ENV} 미설정 — OAuth state 서명 불가(커넥터 암호화도 비활성).`);
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw, "utf8").digest();
}
function stateKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterIkm(), Buffer.alloc(0), Buffer.from(STATE_INFO), 32));
}

// ── PKCE(RFC 7636, S256) — verifier=32바이트 base64url, challenge=base64url(sha256(verifier)). ──
export interface Pkce { verifier: string; challenge: string; method: "S256" }
export function generatePkce(): Pkce {
  const verifier = crypto.randomBytes(32).toString(B64); // 43자 url-safe(무패딩)
  const challenge = crypto.createHash("sha256").update(verifier).digest().toString(B64);
  return { verifier, challenge, method: "S256" };
}

// ── 서명된 state — CSRF·위변조 방지 + 콜백 라우팅용 문맥 운반(멤버·서버·토큰scope·nonce·만료). HMAC-SHA256. ──
//  포맷: base64url(payloadJSON) "." base64url(hmac). nonce 는 pkce vault 슬롯 키에도 쓰인다(콜백이 verifier 를 찾음).
export interface StatePayload { m: string; s: string; k: string; n: string; e: number } // member, serverName(콜백 조회키), tokenScopeKey, nonce, expiryEpochSec
export function signState(p: Omit<StatePayload, "e">, ttlSec = 600): string {
  const payload: StatePayload = { ...p, e: Math.floor(Date.now() / 1000) + ttlSec };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(B64);
  const mac = crypto.createHmac("sha256", stateKey()).update(body).digest().toString(B64);
  return `${body}.${mac}`;
}
export function verifyState(token: string): StatePayload {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("state 형식 오류");
  const expected = crypto.createHmac("sha256", stateKey()).update(parts[0]).digest();
  const got = Buffer.from(parts[1], B64);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new Error("state 서명 불일치(위변조/키 불일치)");
  let payload: StatePayload;
  try { payload = JSON.parse(Buffer.from(parts[0], B64).toString("utf8")); }
  catch { throw new Error("state 페이로드 파싱 실패"); }
  if (!payload || typeof payload.m !== "string" || typeof payload.s !== "string" || typeof payload.k !== "string" || typeof payload.n !== "string" || typeof payload.e !== "number") {
    throw new Error("state 페이로드 필드 누락");
  }
  if (Math.floor(Date.now() / 1000) > payload.e) throw new Error("state 만료");
  return payload;
}

// ── 토큰 코덱 — OAuthTokens 는 통째로 암호화 secret 슬롯에 저장(meta 는 평문이라 토큰 금지). 비밀 아닌 만료/scope 만 meta 로. ──
export function encodeTokenBlob(tokens: OAuthTokens): string { return JSON.stringify(tokens); }
export function decodeTokenBlob(secret: string | null | undefined): OAuthTokens | null {
  if (!secret) return null;
  try {
    const t = JSON.parse(secret);
    return t && typeof t.access_token === "string" ? (t as OAuthTokens) : null;
  } catch { return null; }
}
export function tokenMeta(tokens: OAuthTokens): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (typeof tokens.expires_in === "number") m.expires_at = Math.floor(Date.now() / 1000) + tokens.expires_in;
  if (typeof tokens.scope === "string") m.scope = tokens.scope;
  if (typeof tokens.token_type === "string") m.token_type = tokens.token_type;
  return m;
}

// ── OAuth 클라이언트 메타데이터 — public 클라이언트 + PKCE 기본(DCR 로 client_secret 받으면 SDK 가 사용). ──
export function buildClientMetadata(opts: { redirectUrl: string; clientName?: string; scope?: string }): OAuthClientMetadata {
  return {
    redirect_uris: [opts.redirectUrl],
    client_name: opts.clientName || "Lively Gateway",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
}

// vault 슬롯 키 — 토큰은 서버 설정 scope_key(resolveMemberSecret 이 읽는 슬롯), 클라정보/PKCE 는 예약 scope_key 로 분리.
//  정본은 member-secret-store(금고 슬롯의 예약 키니까). 여기서 재수출해 기존 import 경로를 유지한다 — 금고만
//  읽으면 되는 모듈이 이 무거운 파일을 끌어오다 import 순환이 났었다(#1881 G3).
//  · CLIENT_SCOPE — owner=gateway(조직 공용 DCR 등록). http_proxy 갱신 경로도 여기서 client_id/secret 을 읽는다(#1654).
//  · PKCE_SCOPE — owner=member, (member,kind)당 고정 슬롯(콜백까지 임시). 고정키라 재시도 시 덮어써 고아 누적 방지;
//    finishConsent 성공/실패/거부 모두 정리(try/finally + abandonConsent). listMemberSecretsPublic 는 이 슬롯을 숨긴다.
export { CLIENT_SCOPE, PKCE_SCOPE };

export interface VaultOAuthOpts {
  memberId: string;
  serverName: string;         // org_mcp_server.name — state 에 실려 콜백이 서버(url·authKind)를 조회.
  authKind: string;           // 서버 auth_kind(=vault kind). 토큰 슬롯의 kind.
  tokenScopeKey?: string;     // 서버 auth_scope_key(토큰 슬롯의 scope_key). 기본 "".
  redirectUrl: string;        // 게이트웨이 콜백 URL(고정 — start/finish 동일해야 OAuth 가 통과).
  clientName?: string;
  scope?: string;
  state?: string;             // 콜백 단계: 검증된 state 토큰을 넘겨 동일 nonce 로 PKCE verifier 를 찾게 함.
  actor?: string;
}

// per-member vault 백엔드 OAuthClientProvider — SDK auth() 가 이 인터페이스로 토큰/클라정보/PKCE 를 읽고 쓴다.
//  헤드리스: redirectToAuthorization 은 브라우저 리다이렉트 대신 URL 을 캡처(authorizationUrl) — 웹이 멤버에게 오픈.
export class VaultOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null; // redirectToAuthorization 이 채운다(헤드리스 캡처).
  private readonly o: VaultOAuthOpts;
  private readonly _state: string;
  private readonly _nonce: string;
  constructor(opts: VaultOAuthOpts) {
    this.o = opts;
    if (opts.state) { this._state = opts.state; this._nonce = verifyState(opts.state).n; }
    else {
      this._nonce = crypto.randomBytes(16).toString(B64);
      this._state = signState({ m: opts.memberId, s: opts.serverName, k: opts.tokenScopeKey ?? "", n: this._nonce });
    }
  }
  private owner(): string { return memberOwner(this.o.memberId); }
  private tokenScope(): string { return this.o.tokenScopeKey ?? ""; }

  get redirectUrl(): string { return this.o.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata { return buildClientMetadata({ redirectUrl: this.o.redirectUrl, clientName: this.o.clientName, scope: this.o.scope }); }
  state(): string { return this._state; }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const r = await getMemberSecret(GATEWAY_OWNER, this.o.authKind, CLIENT_SCOPE);
    if (!r?.secret) return undefined;
    try { return JSON.parse(r.secret) as OAuthClientInformationMixed; } catch { return undefined; }
  }
  async saveClientInformation(ci: OAuthClientInformationMixed): Promise<void> {
    await setMemberSecret(GATEWAY_OWNER, this.o.authKind, CLIENT_SCOPE,
      { secret: JSON.stringify(ci), meta: { client_id: (ci as { client_id?: string }).client_id ?? null } }, this.o.actor ?? "oauth");
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const r = await getMemberSecret(this.owner(), this.o.authKind, this.tokenScope());
    return decodeTokenBlob(r?.secret) ?? undefined;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setMemberSecret(this.owner(), this.o.authKind, this.tokenScope(),
      { secret: encodeTokenBlob(tokens), meta: tokenMeta(tokens) }, this.o.actor ?? "oauth");
  }

  redirectToAuthorization(authorizationUrl: URL): void { // 헤드리스: 캡처만
    // 구글은 refresh_token 을 access_type=offline (+ prompt=consent) 일 때만 발급한다(표준 OAuth2.1 밖 파라미터라 SDK 가 안 넣음).
    //  없으면 access_token(1h) 만 받아 만료 후 자동갱신 불가 → 구글 커넥터(gmail·drive·calendar) 전체가 1시간마다 재연결해야 함.
    //  prompt=consent 로 재연결 시에도 refresh_token 을 확실히 재발급(구글은 기존 grant 있으면 consent 없이는 refresh_token 생략).
    if (authorizationUrl.hostname === "accounts.google.com") {
      authorizationUrl.searchParams.set("access_type", "offline");
      authorizationUrl.searchParams.set("prompt", "consent");
    }
    this.authorizationUrl = authorizationUrl;
  }
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await setMemberSecret(this.owner(), this.o.authKind, PKCE_SCOPE, { secret: codeVerifier }, this.o.actor ?? "oauth");
  }
  async codeVerifier(): Promise<string> {
    const r = await getMemberSecret(this.owner(), this.o.authKind, PKCE_SCOPE);
    if (!r?.secret) throw new Error("PKCE code_verifier 없음(만료/미개시) — 동의를 다시 시작하세요.");
    return r.secret;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "tokens" || scope === "all") await deleteMemberSecret(this.owner(), this.o.authKind, this.tokenScope());
    if (scope === "verifier" || scope === "all") await deleteMemberSecret(this.owner(), this.o.authKind, PKCE_SCOPE);
    if (scope === "client" || scope === "all") await deleteMemberSecret(GATEWAY_OWNER, this.o.authKind, CLIENT_SCOPE);
    // 'discovery' — 캐시하지 않으므로 no-op.
  }
}

// ── 오케스트레이션(SDK auth() 래퍼) — 콜백 라우트/커넥트 capability 가 호출. OAuth 디스커버리·토큰교환도 SSRF-가드 fetch 로. ──
//  ⚠ 네트워크 경로 — 단위테스트 불가(빌드 타입검증만). 실 OAuth 서버 대상 통합검증은 콜백 라우트 배선 시.
//  TODO(T1 리뷰 후 DRY): connectUpstream(mcp-proxy.ts)와 동일한 ssrf-fetch 구성 — 공용 헬퍼로 추출.
export async function gatewaySsrfFetch(): Promise<ReturnType<typeof makeSsrfFetch>> {
  const cfg = await getRuntimeConfig().catch(() => null);
  const selfHosts: string[] = [];
  try { const p = await getOrgProfile(); if (p.gateway_url) selfHosts.push(new URL(p.gateway_url).hostname.toLowerCase()); } catch { /* 프로필 없음 */ }
  return makeSsrfFetch({ allowedInternalHosts: cfg?.allowed_internal_hosts ?? [], selfHosts, timeoutMs: 15000 });
}
// 콜백 URL(고정) — org_profile.gateway_url + /oauth/callback. start/finish 가 동일 값을 써야 OAuth redirect_uri 검증 통과.
async function callbackUrl(): Promise<string> {
  const p = await getOrgProfile();
  if (!p.gateway_url) throw new Error("org_profile.gateway_url 미설정 — OAuth 콜백 URL 을 만들 수 없습니다(관리탭에서 게이트웨이 URL 설정).");
  return new URL("/oauth/callback", p.gateway_url).toString();
}
async function loadProxyServer(name: string): Promise<{ url: string; authKind: string; scopeKey: string; scope?: string; clientName: string }> {
  const s = await getMcpServer(name);
  if (!s || s.mode !== "proxy") throw new Error(`proxy MCP 서버 없음: ${name}`);
  if (!s.url) throw new Error("proxy url 미설정");
  if (!s.auth_kind) throw new Error(`'${name}' 은 auth_kind(OAuth) 설정이 없습니다`);
  // OAuth scope — 상류가 scopes_supported 를 요구할 때만 authorize 에 실린다(프리셋 default). 없으면 undefined=미요청(Notion·Linear 현행 유지).
  return { url: s.url, authKind: s.auth_kind, scopeKey: s.auth_scope_key ?? "", scope: presetOAuthScope(s.auth_kind), clientName: `Lively Gateway (${name})` };
}

// 호출/새로고침 경로용 provider 팩토리 — 이미 서버 행을 쥔 호출자(mcp-proxy)가 DB 왕복 없이 provider 를 얻는다.
//  토큰 해소/자동 refresh 는 SDK 가 이 provider 로 수행(tokens()/saveTokens()). state/consent 는 이 경로에선 미사용.
export async function providerForServer(
  memberId: string,
  server: { name: string; auth_kind: string | null; auth_scope_key?: string | null },
  actor?: string,
): Promise<VaultOAuthProvider> {
  if (!server.auth_kind) throw new Error(`'${server.name}' 은 auth_kind(OAuth) 설정이 없습니다`);
  const redirectUrl = await callbackUrl();
  return new VaultOAuthProvider({ memberId, serverName: server.name, authKind: server.auth_kind, tokenScopeKey: server.auth_scope_key ?? "", redirectUrl, actor });
}

export interface ConsentStart { authorized: boolean; authorizationUrl?: string; state?: string }

// ── 슬랙 직결(#1881) — 표준 OAuth 2.1 디스커버리가 아니라 슬랙 설치 플로우(봇+유저 토큰 동시). 규칙은 slack-oauth.ts. ──
//  사전등록 client(관리탭 OAuth 클라이언트 → gateway 슬롯 oauth:client)가 없으면 시작하지 않는다 — 셀프호스팅은 매니페스트
//  링크로 자기 앱을 만들어 그 client 를 넣고, 매니지드는 CP 가 시딩한다(T5).
async function loadOAuthClient(authKind: string): Promise<{ client_id: string; client_secret?: string } | null> {
  const r = await getMemberSecret(GATEWAY_OWNER, authKind, CLIENT_SCOPE);
  if (!r?.secret) return null;
  try {
    const ci = JSON.parse(r.secret) as { client_id?: unknown; client_secret?: unknown };
    return typeof ci.client_id === "string" && ci.client_id ? { client_id: ci.client_id, ...(typeof ci.client_secret === "string" && ci.client_secret ? { client_secret: ci.client_secret } : {}) } : null;
  } catch { return null; }
}
async function startSlackConsent(memberId: string, serverName: string, srv: { authKind: string; scopeKey: string }, redirectUrl: string): Promise<ConsentStart> {
  const existing = await getMemberSecret(memberOwner(memberId), srv.authKind, srv.scopeKey);
  if (decodeTokenBlob(existing?.secret)) return { authorized: true };
  const nonce = crypto.randomBytes(16).toString(B64);
  const state = signState({ m: memberId, s: serverName, k: srv.scopeKey, n: nonce });
  // 매니지드(#1881 T5): 라이블리 CP 가 슬랙 앱(client)을 쥐고 콜백을 받는다 — 이 게이트웨이는 client 를 모른다.
  //  서명 state 를 들고 CP 시작점으로 보내면 CP 가 슬랙 동의 → 교환 → 이 게이트웨이의 /api/ui/org/slack/oauth-complete 로
  //  결과를 넣어 준다(state 검증은 여기서 — CP 는 state 를 열어 보지 않는다). gw 는 CP 가 테넌트를 알아보는 열쇠.
  const relay = process.env.SLACK_OAUTH_RELAY_URL?.trim();
  if (relay) {
    const gatewayUrl = (await getOrgProfile()).gateway_url ?? "";
    return { authorized: false, state, authorizationUrl: relayStartUrl(relay, state, gatewayUrl) };
  }
  const client = await loadOAuthClient(srv.authKind);
  if (!client?.client_id || !client.client_secret) {
    throw new Error("Slack 앱이 아직 등록되지 않았습니다 — 관리자가 [AI 도구 ▸ 외부 도구 서버 ▸ Slack] 에 Slack 앱의 Client ID/Secret 을 넣어야 구성원이 연결할 수 있습니다.");
  }
  return { authorized: false, state, authorizationUrl: buildSlackAuthorizeUrl({ clientId: client.client_id, redirectUri: redirectUrl, state }) };
}
// 설치 결과 → 금고. 유저 토큰 → 그 사람의 금고(A/B 어댑터가 읽는 슬롯). 봇 토큰 → 조직 슬롯(수집기 봇 모드가 읽는다, team_id 로 구분).
async function saveSlackInstall(p: StatePayload, authKind: string, install: SlackInstall, actor?: string): Promise<void> {
  const slots = slackInstallToSlots(install);
  await setMemberSecret(memberOwner(p.m), authKind, p.k, { secret: slots.user.secret, meta: slots.user.meta }, actor ?? "oauth");
  if (slots.bot) await setMemberSecret(GATEWAY_OWNER, SLACK_BOT_KIND, slots.bot.scopeKey, { secret: slots.bot.secret, meta: slots.bot.meta }, actor ?? "oauth");
}
async function finishSlackConsent(p: StatePayload, srv: { authKind: string }, code: string, redirectUrl: string, actor?: string): Promise<void> {
  const client = await loadOAuthClient(srv.authKind);
  if (!client?.client_id || !client.client_secret) throw new Error("Slack 앱 client 가 없어 토큰을 교환할 수 없습니다(연결 도중 설정이 지워졌습니다).");
  const install = await exchangeSlackCode({ clientId: client.client_id, clientSecret: client.client_secret, code, redirectUri: redirectUrl, fetchFn: await gatewaySsrfFetch() });
  await saveSlackInstall(p, srv.authKind, install, actor);
}

// ── 노션 공개 통합 직결(#1881 N2) — org_mcp_server 행이 아니라 예약 서버명(notion-public)으로 콜백을 라우팅한다.
//  개인 MCP 연결(notion, DCR)과 별개: 이 플로우의 산출은 **조직 수집 슬롯**(gateway, notion_public, scope_key=workspace_id).
//  규칙(인가 URL·교환·슬롯 모양)은 notion-oauth.ts. 재동의(=[페이지 더 고르기])가 정상 경로라 기존 토큰이 있어도
//  항상 새 동의를 시작한다(노션은 인가마다 새 토큰쌍 — 덮어써도 안전).
export async function notionPublicReady(): Promise<boolean> {
  if (process.env.NOTION_OAUTH_RELAY_URL?.trim()) return true;
  const c = await loadOAuthClient(NOTION_PUBLIC_KIND);
  return !!(c?.client_id && c.client_secret);
}
export async function startNotionPublicConsent(memberId: string): Promise<ConsentStart> {
  const nonce = crypto.randomBytes(16).toString(B64);
  const state = signState({ m: memberId, s: NOTION_PUBLIC_SERVER, k: "", n: nonce });
  // 매니지드(N4): 라이블리 CP 가 노션 통합(client)을 쥐고 콜백을 받는다 — 슬랙 릴레이와 같은 규약(gw=테넌트 열쇠).
  const relay = process.env.NOTION_OAUTH_RELAY_URL?.trim();
  if (relay) {
    const gatewayUrl = (await getOrgProfile()).gateway_url ?? "";
    return { authorized: false, state, authorizationUrl: relayStartUrl(relay, state, gatewayUrl) };
  }
  const client = await loadOAuthClient(NOTION_PUBLIC_KIND);
  if (!client?.client_id || !client.client_secret) {
    throw new Error("Notion 연결이 아직 준비되지 않았습니다 — 관리자가 Lively Notion 통합의 Client ID/Secret 을 조직 자격(kind notion_public, scope_key oauth:client)에 넣어야 합니다.");
  }
  return { authorized: false, state, authorizationUrl: buildNotionAuthorizeUrl({ clientId: client.client_id, redirectUri: await callbackUrl(), state }) };
}
/**
 * 노션 연결이 저장된 직후에 부를 후처리 — **상위 계층이 꽂는다**(capabilities/notion-connect.ts).
 *
 *  왜 훅인가: 동의가 끝나면 사용자 입장에서 그 일은 **끝나야 한다.** 그런데 저장 자체는 자격 계층의 일이고
 *  "그래서 수집기를 켠다"는 수집 계층의 일이라, 여기서 직접 부르면 순환 import 가 된다(notion-connect 는
 *  이 모듈의 startNotionPublicConsent 를 쓴다). 그래서 방향을 뒤집어 훅으로 받는다.
 *
 *  ★ 이게 없으면 무슨 일이 나는가(2026-08-25 매니지드 실측): 토글을 켜면 동의 화면으로 갔다가 돌아오는데
 *   **체크박스가 풀린 채**다 — 연결은 저장됐지만 수집기는 아무도 안 켰기 때문이다. 사용자는 "안 됐나?" 하고
 *   한 번 더 누르고, 그제야 켜진다(그땐 이미 연결이 있으니 동의 화면도 안 뜬다). 두 번 누르게 만드는 UX 는
 *   컴맹 페르소나(#1881)에서 그대로 이탈 지점이다.
 */
export type NotionInstalledHook = (memberId: string) => Promise<void>;
let notionInstalledHook: NotionInstalledHook | null = null;
export function onNotionInstalled(fn: NotionInstalledHook): void { notionInstalledHook = fn; }

// 설치 결과 → 조직 슬롯. connected_by 로 '누가 연결했나'를 남긴다(이탈 시 "다른 관리자로 다시 연결" 안내의 근거).
async function saveNotionInstall(p: StatePayload, install: NotionInstall, actor?: string): Promise<void> {
  const slot = notionInstallToSlot(install);
  await setMemberSecret(GATEWAY_OWNER, NOTION_PUBLIC_KIND, slot.scopeKey,
    { secret: slot.secret, meta: { ...slot.meta, connected_by: p.m } }, actor ?? "oauth");
  // 후처리는 **연결 저장을 막지 않는다** — 수집기 준비가 실패해도 토큰은 이미 저장됐고, 화면에서 토글을
  //  한 번 더 켜면 된다(그때는 연결이 있으니 동의 없이 켜진다). 실패를 삼키되 로그로 남긴다.
  if (notionInstalledHook) {
    await notionInstalledHook(p.m).catch((e) =>
      logger.warn({ err: (e as Error)?.message }, "노션 연결 후 수집기 준비 실패 — 화면에서 토글로 켤 수 있습니다"));
  }
}
async function finishNotionPublicConsent(p: StatePayload, code: string, actor?: string): Promise<void> {
  const client = await loadOAuthClient(NOTION_PUBLIC_KIND);
  if (!client?.client_id || !client.client_secret) throw new Error("Notion 통합 client 가 없어 토큰을 교환할 수 없습니다(연결 도중 설정이 지워졌습니다).");
  const install = await exchangeNotionCode({ clientId: client.client_id, clientSecret: client.client_secret, code, redirectUri: await callbackUrl(), fetchFn: await gatewaySsrfFetch() });
  await saveNotionInstall(p, install, actor);
}
/**
 * 릴레이 완료(#1881 N4) — CP 가 노션과 교환한 /v1/oauth/token 응답 원문을 들고 온다. state 는 이 게이트웨이가
 *  서명한 것이라 위조·만료·멤버 귀속을 여기서 검증한다(CP 는 통과만 시킨다). 노션 공개 통합 state 가 아니면 거부.
 */
export async function completeNotionInstall(stateToken: string, tokenResponse: unknown, actor?: string): Promise<{ ok: true; memberId: string; workspace_id: string; workspace_name: string | null }> {
  const p = verifyState(stateToken);
  if (!isNotionPublicServer(p.s)) throw new Error("이 state 는 노션 팀 자료 연결이 아닙니다");
  const install = parseNotionTokenResponse(tokenResponse);
  await saveNotionInstall(p, install, actor);
  return { ok: true, memberId: p.m, workspace_id: install.workspace.id, workspace_name: install.workspace.name };
}
/**
 * 만료 갱신(직결 모드) — 노션은 회전형(이전 refresh_token 즉시 무효)이라 새 쌍을 **받는 즉시** 저장한다.
 *  refresh_token 이 없거나 client 가 없으면(매니지드 테넌트) null — 호출자가 "다시 연결" 실패 클래스로 안내한다.
 *  ⚠ 아직 호출부 없음: access_token 만료 여부가 미확정(N1 실측 대기 — 지식 §1③)이라 401 배선은 실측 후 잇는다.
 */
export async function refreshNotionPublicToken(workspaceId: string, actor?: string): Promise<string | null> {
  const cur = await getMemberSecret(GATEWAY_OWNER, NOTION_PUBLIC_KIND, workspaceId);
  const blob = decodeTokenBlob(cur?.secret);
  if (!blob?.refresh_token) return null;
  const client = await loadOAuthClient(NOTION_PUBLIC_KIND);
  if (!client?.client_id || !client.client_secret) return null;
  const install = await refreshNotionToken({ clientId: client.client_id, clientSecret: client.client_secret, refreshToken: blob.refresh_token, fetchFn: await gatewaySsrfFetch() });
  const connectedBy = typeof cur?.meta?.connected_by === "string" ? (cur.meta.connected_by as string) : "";
  await saveNotionInstall({ m: connectedBy, s: NOTION_PUBLIC_SERVER, k: "", n: "", e: 0 }, install, actor ?? "oauth-refresh");
  return install.access_token;
}
// ── 구글 직결(#1881 G2) — 드라이브·Gmail·캘린더를 **한 동의**로. 예약 서버명(google)으로 콜백을 라우팅한다.
//  org_mcp_server 행을 쓰지 않는다: 도구 호출은 이미 클래식 REST(http_proxy, #1652)로 내려가 있는데 인증 앵커만
//  Developer Preview 엔드포인트(`*mcp.googleapis.com`)에 남아 있었다 — 상류가 바뀌면 연결 개시가 통째로 죽는 구조였다.
//  구글 OAuth 엔드포인트는 고정이라 디스커버리할 이유가 없다. 규칙(인가 URL·교환·병합·슬롯)은 google-oauth.ts.
//  ★ 부수 효과: 연결 창구의 근거가 '서버 행'이 아니라 'http_proxy 도구'가 되어, 매니지드 개인 테넌트에서 구글이
//   아예 안 보이던 것(T10 #1993 이 `0/4` 로 남긴 자리)이 함께 풀린다.
export async function googleReady(): Promise<boolean> {
  if (process.env.GOOGLE_OAUTH_RELAY_URL?.trim()) return true;
  const c = await loadOAuthClient(GOOGLE_KIND);
  return !!(c?.client_id && c.client_secret);
}
/** 현재 저장된 구글 설치 상태(병합·만료 판정의 prev). 없으면 null. */
async function loadGoogleInstall(memberId: string): Promise<GoogleInstall | null> {
  const cur = await getMemberSecret(memberOwner(memberId), GOOGLE_KIND, "");
  return googleInstallFromBlob(cur?.secret ?? null);
}
async function saveGoogleInstall(memberId: string, install: GoogleInstall, actor?: string): Promise<void> {
  const slot = googleInstallToSlot(install);
  await setMemberSecret(memberOwner(memberId), GOOGLE_KIND, slot.scopeKey, { secret: slot.secret, meta: slot.meta }, actor ?? "oauth");
}
/**
 * 동의 개시. **이미 토큰이 있어도 서비스를 더 켜려면 다시 동의해야 하므로** 슬랙처럼 조기 authorized:true 로 끊지 않는다
 *  — `include_granted_scopes=true` 라 재동의가 기존 권한을 보존하며 범위만 넓힌다(google-oauth.ts §인가 URL).
 */
export async function startGoogleConsent(
  memberId: string, services: readonly GoogleService[] = GOOGLE_DEFAULT_SERVICES, actor?: string,
): Promise<ConsentStart> {
  const nonce = crypto.randomBytes(16).toString(B64);
  const state = signState({ m: memberId, s: GOOGLE_SERVER, k: "", n: nonce });
  // 매니지드(G4): 라이블리 CP 가 구글 클라이언트를 쥐고 콜백을 받는다 — 슬랙 T5·노션 N4 와 같은 규약(gw=테넌트 열쇠).
  //  ⚠ CP 의 **로그인용** 구글 클라이언트와 다른 자격이어야 한다 — 로그인 앱에 데이터 범위를 얹으면 그 앱이 통째로
  //   검증 대상 + 100명 한도가 되어 가입 자체가 막힌다(지식 google-single-connect-design-1881 §6②).
  const relay = process.env.GOOGLE_OAUTH_RELAY_URL?.trim();
  if (relay) {
    const gatewayUrl = (await getOrgProfile()).gateway_url ?? "";
    // ★ 구글은 릴레이에 **scope 도 실어 보낸다**(슬랙·노션과 다른 점). CP 는 그걸 그대로 인가 URL 에 옮길 뿐,
    //  기본값을 끼워 넣지 않는다 — 그래야 사용자가 고른 서비스만 요청된다(안 고른 제한범위가 섞이면
    //  되돌릴 수 없는 미검증 100명 한도를 한 칸 태운다).
    const u = new URL(relayStartUrl(relay, state, gatewayUrl));
    u.searchParams.set("scope", googleScopeString(services));
    return { authorized: false, state, authorizationUrl: u.toString() };
  }
  const client = await loadOAuthClient(GOOGLE_KIND);
  if (!client?.client_id || !client.client_secret) {
    throw new Error("Google 연결이 아직 준비되지 않았습니다 — 관리자가 구글 OAuth 클라이언트의 Client ID/Secret 을 조직 자격(kind google_oauth, scope_key oauth:client)에 넣어야 합니다.");
  }
  // PKCE — 구글은 지원한다(슬랙·노션과 다른 점). verifier 는 표준 슬롯에 두고 콜백에서 1회 쓰고 지운다.
  const pkce = generatePkce();
  await setMemberSecret(memberOwner(memberId), GOOGLE_KIND, PKCE_SCOPE, { secret: pkce.verifier }, actor ?? "oauth");
  return {
    authorized: false, state,
    authorizationUrl: buildGoogleAuthorizeUrl({
      clientId: client.client_id, redirectUri: await callbackUrl(), state,
      scope: googleScopeString(services), codeChallenge: pkce.challenge,
    }),
  };
}
async function finishGoogleConsent(p: StatePayload, code: string, actor?: string): Promise<void> {
  const client = await loadOAuthClient(GOOGLE_KIND);
  if (!client?.client_id || !client.client_secret) throw new Error("Google OAuth 클라이언트가 없어 토큰을 교환할 수 없습니다(연결 도중 설정이 지워졌습니다).");
  const owner = memberOwner(p.m);
  const verifier = (await getMemberSecret(owner, GOOGLE_KIND, PKCE_SCOPE))?.secret ?? undefined;
  const install = await exchangeGoogleCode({
    clientId: client.client_id, clientSecret: client.client_secret, code,
    redirectUri: await callbackUrl(), codeVerifier: verifier, fetchFn: await gatewaySsrfFetch(),
  });
  // 최초 동의는 refresh_token 을 주지만, 구글이 생략하는 경로가 있어 병합을 항상 거친다(google-oauth.ts ★).
  await saveGoogleInstall(p.m, mergeGoogleTokens(await loadGoogleInstall(p.m), install), actor);
}
/**
 * 릴레이 완료(#1881 G4) — CP 가 구글과 교환한 토큰 응답 원문을 들고 온다. state 는 이 게이트웨이가 서명한 것이라
 *  위조·만료·멤버 귀속을 여기서 검증한다(CP 는 통과만 시킨다). 구글 직결 state 가 아니면 거부.
 */
export async function completeGoogleInstall(stateToken: string, tokenResponse: unknown, actor?: string): Promise<{ ok: true; memberId: string; email: string | null }> {
  const p = verifyState(stateToken);
  if (!isGoogleServer(p.s)) throw new Error("이 state 는 구글 연결이 아닙니다");
  const merged = mergeGoogleTokens(await loadGoogleInstall(p.m), parseGoogleTokenResponse(tokenResponse));
  await saveGoogleInstall(p.m, merged, actor);
  return { ok: true, memberId: p.m, email: merged.email };
}
/**
 * 만료 갱신 — 유효하면 그대로, 만료면 갱신 후 **병합해서** 되쓴다.
 *  ⚠ 구글은 갱신 응답에 refresh_token 을 **안 준다** — mergeGoogleTokens 없이 저장하면 1시간 뒤 영구 실패한다(#1652).
 *  refresh_token 이나 client 가 없으면 null — 호출자가 "다시 연결" 실패 클래스로 안내한다(매니지드는 CP 갱신 프록시, G4).
 */
export async function ensureGoogleAccessToken(memberId: string, actor?: string): Promise<string | null> {
  const cur = await loadGoogleInstall(memberId);
  if (!cur) return null;
  if (!googleTokenExpired(cur)) return cur.access_token;
  if (!cur.refresh_token) return null;
  const client = await loadOAuthClient(GOOGLE_KIND);
  if (!client?.client_id || !client.client_secret) return null;
  const refreshed = await refreshGoogleToken({
    clientId: client.client_id, clientSecret: client.client_secret,
    refreshToken: cur.refresh_token, fetchFn: await gatewaySsrfFetch(),
  });
  const merged = mergeGoogleTokens(cur, refreshed);
  await saveGoogleInstall(memberId, merged, actor ?? "oauth-refresh");
  return merged.access_token;
}

/**
 * 릴레이 완료(#1881 T5) — CP 가 슬랙과 교환한 `oauth.v2.access` 응답 원문을 들고 온다. state 는 이 게이트웨이가 서명한 것이라
 *  위조·만료·멤버 귀속을 여기서 검증한다(CP 는 통과만 시킨다). 슬랙 직결 서버가 아니면 거부.
 */
export async function completeSlackInstall(stateToken: string, access: unknown, actor?: string): Promise<{ ok: true; memberId: string; serverName: string; team_id: string | null }> {
  const p = verifyState(stateToken);
  const srv = await loadProxyServer(p.s);
  if (!isSlackOAuthKind(srv.authKind)) throw new Error(`'${p.s}' 는 슬랙 연결 창구가 아닙니다`);
  const install = parseSlackAccessResponse(access);
  await saveSlackInstall(p, srv.authKind, install, actor);
  return { ok: true, memberId: p.m, serverName: p.s, team_id: install.team?.id ?? null };
}

// 동의 개시 — PKCE·서명 state 로 authorization URL 생성(브라우저 오픈용). 이미 토큰 있으면 authorized:true.
export async function startConsent(memberId: string, serverName: string, actor?: string): Promise<ConsentStart> {
  // #1881 G2 구글 직결 — MCP 서버 행이 없으므로 loadProxyServer 앞에서 갈라야 한다(노션 공개 통합과 같은 규약).
  if (isGoogleServer(serverName)) return startGoogleConsent(memberId, GOOGLE_DEFAULT_SERVICES, actor);
  const srv = await loadProxyServer(serverName);
  const redirectUrl = await callbackUrl();
  if (isSlackOAuthKind(srv.authKind)) return startSlackConsent(memberId, serverName, srv, redirectUrl);
  const provider = new VaultOAuthProvider({ memberId, serverName, authKind: srv.authKind, tokenScopeKey: srv.scopeKey, redirectUrl, clientName: srv.clientName, scope: srv.scope, actor });
  const res = await auth(provider, { serverUrl: srv.url, scope: srv.scope, fetchFn: await gatewaySsrfFetch() });
  if (res === "AUTHORIZED") return { authorized: true }; // 유효 토큰 이미 있음
  if (!provider.authorizationUrl) throw new Error("authorization URL 생성 실패");
  return { authorized: false, authorizationUrl: provider.authorizationUrl.toString(), state: provider.state() };
}
// 콜백 완료 — state 검증 → code→token 교환 → 멤버 vault 저장. serverName·memberId·scopeKey 는 state 에서 복원.
export async function finishConsent(stateToken: string, code: string, actor?: string): Promise<{ ok: true; memberId: string; serverName: string }> {
  const p = verifyState(stateToken); // 위변조/만료 검증(HMAC)
  if (isNotionPublicServer(p.s)) { // #1881 N2 노션 공개 통합 — MCP 서버 행 없음, Basic 교환
    await finishNotionPublicConsent(p, code, actor);
    return { ok: true, memberId: p.m, serverName: p.s };
  }
  if (isGoogleServer(p.s)) { // #1881 G2 구글 직결 — MCP 서버 행 없음, form 교환 + PKCE
    try {
      await finishGoogleConsent(p, code, actor);
    } finally {
      // 1회용 verifier 정리 — 실패·예외 경로에서도 고아를 남기지 않는다(표준 경로와 같은 규율).
      await deleteMemberSecret(memberOwner(p.m), GOOGLE_KIND, PKCE_SCOPE).catch(() => { /* best-effort */ });
    }
    return { ok: true, memberId: p.m, serverName: p.s };
  }
  const srv = await loadProxyServer(p.s);
  const redirectUrl = await callbackUrl();
  if (isSlackOAuthKind(srv.authKind)) { // #1881 슬랙 직결 — PKCE 없음, 교환·저장은 finishSlackConsent
    await finishSlackConsent(p, srv, code, redirectUrl, actor);
    return { ok: true, memberId: p.m, serverName: p.s };
  }
  const provider = new VaultOAuthProvider({ memberId: p.m, serverName: p.s, authKind: srv.authKind, tokenScopeKey: p.k, redirectUrl, state: stateToken, actor });
  try {
    const res = await auth(provider, { serverUrl: srv.url, authorizationCode: code, fetchFn: await gatewaySsrfFetch() });
    if (res !== "AUTHORIZED") throw new Error("토큰 교환 실패");
    return { ok: true, memberId: p.m, serverName: p.s };
  } finally {
    // 성공/실패 무관 1회용 PKCE verifier 정리(리뷰 #1 — 실패·예외 경로에서도 고아 방지).
    await provider.invalidateCredentials("verifier").catch(() => { /* best-effort */ });
  }
}

// 동의 취소/거부/실패(콜백 error 경로 등) 시 임시 PKCE verifier 정리 — state 만으로. 위조/만료 state 는 조용히 무시(무해).
export async function abandonConsent(stateToken: string): Promise<void> {
  let p: StatePayload;
  try { p = verifyState(stateToken); } catch { return; }
  if (isNotionPublicServer(p.s)) return; // #1881 노션 공개 통합 — PKCE 슬롯이 없어 정리할 것도 없다
  if (isGoogleServer(p.s)) { // #1881 G2 구글 직결 — PKCE 를 쓰므로 취소 경로에서도 verifier 를 지운다
    await deleteMemberSecret(memberOwner(p.m), GOOGLE_KIND, PKCE_SCOPE).catch(() => { /* best-effort */ });
    return;
  }
  try {
    const srv = await loadProxyServer(p.s);
    const provider = new VaultOAuthProvider({ memberId: p.m, serverName: p.s, authKind: srv.authKind, tokenScopeKey: p.k, redirectUrl: await callbackUrl(), state: stateToken });
    await provider.invalidateCredentials("verifier");
  } catch { /* best-effort */ }
}

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
import { getMemberSecret, setMemberSecret, deleteMemberSecret, memberOwner, GATEWAY_OWNER } from "./member-secret-store.js";
import { getMcpServer, getRuntimeConfig, getOrgProfile } from "./store.js";
import { makeSsrfFetch } from "./mcp-ssrf-fetch.js";

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
const CLIENT_SCOPE = "oauth:client";  // owner=gateway(조직 공용 DCR 등록)
// PKCE verifier — owner=member, (member,kind)당 고정 슬롯(콜백까지 임시). 고정키라 재시도 시 덮어써 고아 누적 방지(리뷰 #1);
//  finishConsent 성공/실패/거부 모두 정리(try/finally + abandonConsent). listMemberSecretsPublic 는 이 슬롯을 숨긴다.
export const PKCE_SCOPE = "oauth:pkce";

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

  redirectToAuthorization(authorizationUrl: URL): void { this.authorizationUrl = authorizationUrl; } // 헤드리스: 캡처만
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
async function gatewaySsrfFetch(): Promise<ReturnType<typeof makeSsrfFetch>> {
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
  return { url: s.url, authKind: s.auth_kind, scopeKey: s.auth_scope_key ?? "", clientName: `Lively Gateway (${name})` };
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
// 동의 개시 — PKCE·서명 state 로 authorization URL 생성(브라우저 오픈용). 이미 토큰 있으면 authorized:true.
export async function startConsent(memberId: string, serverName: string, actor?: string): Promise<ConsentStart> {
  const srv = await loadProxyServer(serverName);
  const redirectUrl = await callbackUrl();
  const provider = new VaultOAuthProvider({ memberId, serverName, authKind: srv.authKind, tokenScopeKey: srv.scopeKey, redirectUrl, clientName: srv.clientName, scope: srv.scope, actor });
  const res = await auth(provider, { serverUrl: srv.url, scope: srv.scope, fetchFn: await gatewaySsrfFetch() });
  if (res === "AUTHORIZED") return { authorized: true }; // 유효 토큰 이미 있음
  if (!provider.authorizationUrl) throw new Error("authorization URL 생성 실패");
  return { authorized: false, authorizationUrl: provider.authorizationUrl.toString(), state: provider.state() };
}
// 콜백 완료 — state 검증 → code→token 교환 → 멤버 vault 저장. serverName·memberId·scopeKey 는 state 에서 복원.
export async function finishConsent(stateToken: string, code: string, actor?: string): Promise<{ ok: true; memberId: string; serverName: string }> {
  const p = verifyState(stateToken); // 위변조/만료 검증(HMAC)
  const srv = await loadProxyServer(p.s);
  const redirectUrl = await callbackUrl();
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
  try {
    const srv = await loadProxyServer(p.s);
    const provider = new VaultOAuthProvider({ memberId: p.m, serverName: p.s, authKind: srv.authKind, tokenScopeKey: p.k, redirectUrl: await callbackUrl(), state: stateToken });
    await provider.invalidateCredentials("verifier");
  } catch { /* best-effort */ }
}

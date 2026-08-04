// OIDC 로그인 — providers.ts 의 'oidc' 구현(P4). 사람 웹 로그인의 '누구인가'를 외부 IdP 가 입증한다.
//  ⚠ 방향 주의: 여기서 **우리는 OIDC 클라이언트**다(고객 조직의 구글/사내 SSO 로 웹 로그인, #1520).
//   우리가 인가서버인 쪽(#1473 T2)은 org/auth/oauth-*.ts 다 — 이름이 닮았지만 반대편이고 섞으면 안 된다.
//   둘은 /authorize 에서 만난다: T2 의 동의 화면이 요구하는 '세션'을 만드는 게 이 파일의 로그인이다.
//
//  왜 구글 전용이 아니라 제네릭 OIDC 인가:
//   셀프호스팅은 배포마다 IdP 가 다르다(어니스트=구글 워크스페이스, 다음 고객은 Azure AD·Okta 일 수 있다).
//   issuer 하나만 받으면 discovery 가 authorization/token/jwks 주소를 전부 알려주므로 고객이 늘어도 코드는 그대로다.
//   (lvly-cloud/control/src/accounts.ts 에 구글 로그인이 이미 있지만 가져오지 않았다 — 그건 CP 가입 계정용이고
//    accounts.google.com URL 3개를 하드코딩한 단일-SaaS 전제라, 배포마다 IdP 가 갈리는 여기엔 맞지 않는다.
//    중복을 없앤다면 방향은 반대다: 이 제네릭 구현이 서고 난 뒤 CP 쪽을 이 위로 올린다.)
//
//  설정(배포별 opt-in — 셋 중 하나라도 비면 제공자가 통째로 꺼지고 local 로그인만 남는다):
//   OIDC_ISSUER           https://accounts.google.com
//   OIDC_CLIENT_ID        IdP 콘솔에서 발급
//   OIDC_CLIENT_SECRET    IdP 콘솔에서 발급(웹 앱 = 기밀 클라이언트)
//   OIDC_ALLOWED_DOMAINS  자동 가입을 허용할 이메일 도메인(콤마, 예 "honest.ai"). 비면 자동 가입 없음.
//   OIDC_LABEL            로그인 버튼 문구(기본은 issuer 로 추정 — 구글이면 "Google 계정으로 로그인")
//   OIDC_TRUST_UNVERIFIED_EMAIL=1  email_verified 를 안 주는 IdP 에서만 명시 opt-in(아래 주석 참조)
//
//  id_token 검증: OIDC Core 3.1.3.7 은 code flow(토큰 엔드포인트와 TLS 직접통신)면 서명 검증을 생략해도
//   된다고 허용하지만, 서명까지 검증한다. 외부 의존이 필요 없기 때문이다 — node:crypto 의
//   createPublicKey({format:'jwk'}) 가 JWKS 의 JWK 를 그대로 키로 받는다(jose 등 새 런타임 의존 0).
import crypto from "node:crypto";
import { logger } from "../log.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];   // 소문자. 비었으면 자동 가입 없음(기존 멤버만).
  label: string;
  trustUnverifiedEmail: boolean;
  scopes: string;
}

// 설정 읽기 — 셋이 다 있어야 켜진다. 값이 없으면 null(제공자 미등록 → 로그인 화면에 버튼도 안 뜬다).
//  매번 env 를 읽는다(캐시 없음): 호출 빈도가 로그인 시점뿐이라 비용이 없고, 재기동 없이 값을 고쳐 볼 수 있다.
export function oidcConfig(): OidcConfig | null {
  const issuer = (process.env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, "");
  const clientId = (process.env.OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.OIDC_CLIENT_SECRET ?? "").trim();
  if (!issuer || !clientId || !clientSecret) return null;
  // issuer 는 https 만 — id_token 의 iss 대조 기준이자 discovery 대상이라 평문 HTTP 면 중간자가 신원을 통째로 바꾼다.
  //  (개발용 http IdP 를 붙일 일이 생기면 그때 명시적 escape hatch 를 추가할 것. 지금 열어두지 않는다.)
  if (!/^https:\/\//i.test(issuer)) {
    logger.warn({ issuer }, "[oidc] OIDC_ISSUER 가 https 가 아니라 OIDC 제공자를 켜지 않는다");
    return null;
  }
  const allowedDomains = (process.env.OIDC_ALLOWED_DOMAINS ?? "")
    .split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return {
    issuer, clientId, clientSecret, allowedDomains,
    label: (process.env.OIDC_LABEL ?? "").trim() || defaultLabel(issuer),
    trustUnverifiedEmail: process.env.OIDC_TRUST_UNVERIFIED_EMAIL === "1",
    scopes: (process.env.OIDC_SCOPES ?? "").trim() || "openid email profile",
  };
}

// 버튼 문구 기본값 — 사람이 보는 건 IdP 이름이지 'OIDC' 가 아니다. 모르면 중립 문구.
function defaultLabel(issuer: string): string {
  const h = (() => { try { return new URL(issuer).hostname.toLowerCase(); } catch { return ""; } })();
  if (h.endsWith("accounts.google.com") || h.endsWith("google.com")) return "Google 계정으로 로그인";
  if (h.includes("microsoftonline") || h.includes("microsoft.com")) return "Microsoft 계정으로 로그인";
  if (h.includes("okta")) return "Okta 로 로그인";
  return "회사 SSO 로 로그인";
}

// ── discovery ────────────────────────────────────────────────────────────────
export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

const HTTP_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — 엔드포인트는 거의 안 바뀐다.
let discoveryCache: { issuer: string; at: number; doc: OidcDiscovery } | null = null;

export async function discover(cfg: OidcConfig): Promise<OidcDiscovery> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.issuer === cfg.issuer && now - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OIDC discovery 실패(${res.status}) — ${url}`);
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("OIDC discovery 문서에 필수 엔드포인트가 없다");
  }
  // discovery 문서의 issuer 는 우리가 설정한 issuer 와 정확히 같아야 한다(사양 요구) — 다르면 id_token 의
  //  iss 대조 기준이 흔들려 IdP 혼동 공격의 문이 된다.
  if (doc.issuer && doc.issuer.replace(/\/+$/, "") !== cfg.issuer) {
    throw new Error(`OIDC issuer 불일치 — 설정 ${cfg.issuer} / 문서 ${doc.issuer}`);
  }
  const full: OidcDiscovery = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    issuer: doc.issuer ?? cfg.issuer,
  };
  discoveryCache = { issuer: cfg.issuer, at: now, doc: full };
  return full;
}

// ── JWKS ─────────────────────────────────────────────────────────────────────
interface Jwk { kid?: string; kty?: string; alg?: string; use?: string; [k: string]: unknown }
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000; // 키 롤오버 대응 재조회의 최소 간격(미지의 kid 로 도는 DoS 방지)
let jwksCache: { uri: string; at: number; keys: Jwk[] } | null = null;
let jwksLastFetchAt = 0;

async function fetchJwks(uri: string): Promise<Jwk[]> {
  const res = await fetch(uri, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`JWKS 조회 실패(${res.status})`);
  const doc = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) throw new Error("JWKS 에 키가 없다");
  jwksLastFetchAt = Date.now();
  jwksCache = { uri, at: jwksLastFetchAt, keys: doc.keys };
  return doc.keys;
}

// kid 로 키를 찾는다. 캐시에 없으면 **한 번만** 다시 받는다 — IdP 는 키를 주기적으로 굴리고(구글은 수일)
//  그때 캐시만 믿으면 롤오버 순간 전원이 로그인 불가가 된다. 반대로 무제한 재조회는 위조 kid 로
//  JWKS 를 두드리게 하는 증폭기가 되므로 최소 간격을 둔다.
async function keyForKid(uri: string, kid: string | undefined): Promise<Jwk | null> {
  const now = Date.now();
  let keys = jwksCache && jwksCache.uri === uri && now - jwksCache.at < JWKS_TTL_MS ? jwksCache.keys : null;
  if (!keys) keys = await fetchJwks(uri);
  const pick = (ks: Jwk[]): Jwk | undefined => (kid ? ks.find((k) => k.kid === kid) : ks[0]);
  let k = pick(keys);
  if (!k && now - jwksLastFetchAt > JWKS_MIN_REFETCH_MS) k = pick(await fetchJwks(uri));
  return k ?? null;
}

// ── id_token(JWS) 검증 ───────────────────────────────────────────────────────
// alg 화이트리스트 — 'none' 과 대칭키(HS*) 는 절대 받지 않는다. HS* 를 허용하면 공개키(JWKS)를 HMAC 키로
//  써서 누구나 토큰을 위조할 수 있는 고전적 알고리즘 혼동 취약점이 된다.
const ALLOWED_ALGS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]);
const CLOCK_SKEW_MS = 60 * 1000;

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;               // 구글: 워크스페이스 도메인
  [k: string]: unknown;
}

const b64uJson = (s: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

function verifySignature(alg: string, signingInput: string, sig: Buffer, key: crypto.KeyObject): boolean {
  const hash = `sha${alg.slice(2)}`; // RS256 → sha256
  const data = Buffer.from(signingInput, "utf8");
  try {
    if (alg.startsWith("RS")) return crypto.verify(hash, data, key, sig);
    if (alg.startsWith("PS")) {
      return crypto.verify(hash, data,
        { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
    }
    // ES*: JWS 서명은 raw (r||s) 인데 node 기본은 DER 을 기대한다 → ieee-p1363 을 명시해야 통과한다.
    if (alg.startsWith("ES")) return crypto.verify(hash, data, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
  return false;
}

// nonce 대조는 **해시로** 한다 — pending_oidc_auth 에 원본을 저장하지 않기 때문이다(store/oidc-auth.ts).
//  org/store/audit.ts 의 sha256 과 같은 식(hex) — 두 자리에서 같은 값을 만들어야 대조가 성립한다.
export const sha256hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// id_token 전체 검증 — 서명 + iss/aud/exp/iat/nonce. 하나라도 어긋나면 throw(로그인 거부).
export async function verifyIdToken(
  idToken: string, cfg: OidcConfig, disc: OidcDiscovery, expectedNonceHash: string,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 형식이 아니다");
  const [h, p, s] = parts;
  const header = b64uJson(h) as { alg?: string; kid?: string };
  const alg = String(header.alg ?? "");
  if (!ALLOWED_ALGS.has(alg)) throw new Error(`id_token alg 를 허용하지 않는다(${alg || "none"})`);

  const jwk = await keyForKid(disc.jwks_uri, header.kid);
  if (!jwk) throw new Error("id_token 을 검증할 키(kid)를 JWKS 에서 찾지 못했다");
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  if (!verifySignature(alg, `${h}.${p}`, Buffer.from(s, "base64url"), key)) {
    throw new Error("id_token 서명 검증 실패");
  }

  const c = b64uJson(p) as unknown as IdTokenClaims;
  const now = Date.now();
  if (String(c.iss ?? "").replace(/\/+$/, "") !== disc.issuer.replace(/\/+$/, "")) throw new Error("id_token iss 불일치");
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(cfg.clientId)) throw new Error("id_token aud 가 우리 client_id 가 아니다");
  // azp: aud 가 여럿이면 authorized party 가 우리여야 한다(사양).
  if (auds.length > 1 && c.azp && c.azp !== cfg.clientId) throw new Error("id_token azp 불일치");
  if (!Number.isFinite(c.exp) || c.exp * 1000 + CLOCK_SKEW_MS < now) throw new Error("id_token 이 만료됐다");
  if (Number.isFinite(c.iat) && c.iat * 1000 - CLOCK_SKEW_MS > now) throw new Error("id_token iat 가 미래다");
  // nonce 는 재생공격 차단의 핵심 — 우리가 이 인가요청에 심은 값과 정확히 같아야 한다.
  if (!c.nonce || !safeEq(sha256hex(String(c.nonce)), expectedNonceHash)) throw new Error("id_token nonce 불일치");
  if (!c.sub) throw new Error("id_token 에 sub 가 없다");
  return c;
}

const safeEq = (a: string, b: string): boolean => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// ── 인가 개시 / 코드 교환 ────────────────────────────────────────────────────
export const S256 = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

export function buildAuthorizeUrl(
  cfg: OidcConfig, disc: OidcDiscovery,
  args: { redirectUri: string; state: string; nonce: string; codeVerifier: string },
): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: cfg.scopes,
    state: args.state,
    nonce: args.nonce,
    code_challenge: S256(args.codeVerifier),
    code_challenge_method: "S256",
    // 여러 계정을 쓰는 사람이 '어느 계정으로 들어갈지' 매번 고를 수 있게 — 잘못된 계정에 갇히지 않는다.
    prompt: "select_account",
  });
  // 구글 워크스페이스: hd 힌트를 주면 계정 선택기가 그 도메인으로 좁혀진다(강제는 아니라 검증은 별도로 한다).
  if (cfg.allowedDomains.length === 1) p.set("hd", cfg.allowedDomains[0]);
  const sep = disc.authorization_endpoint.includes("?") ? "&" : "?";
  return `${disc.authorization_endpoint}${sep}${p}`;
}

// 인가코드 → id_token. client_secret 은 요청 바디로만 나가고 절대 로그에 남기지 않는다.
export async function exchangeCode(
  cfg: OidcConfig, disc: OidcDiscovery,
  args: { code: string; redirectUri: string; codeVerifier: string; nonceHash: string },
): Promise<IdTokenClaims> {
  const res = await fetch(disc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: args.codeVerifier,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 본문에 client_secret 은 없지만(에러 설명뿐) 원문을 그대로 흘리지 않고 상태코드만 남긴다.
    throw new Error(`토큰 교환 실패(${res.status})`);
  }
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) throw new Error("토큰 응답에 id_token 이 없다");
  return verifyIdToken(tok.id_token, cfg, disc, args.nonceHash);
}

// 로그인에 쓸 이메일 확정 — 신원의 전부다. 여기서 느슨해지면 남의 계정으로 들어갈 수 있다.
//  email_verified=false 는 언제나 거부. claim 자체를 안 주는 IdP(일부 Azure AD 구성)만
//  OIDC_TRUST_UNVERIFIED_EMAIL=1 로 운영자가 명시적으로 책임지고 연다.
export function emailFromClaims(c: IdTokenClaims, cfg: OidcConfig): string | null {
  const email = String(c.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  if (c.email_verified === false) return null;
  if (c.email_verified === undefined && !cfg.trustUnverifiedEmail) return null;
  return email;
}

export const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

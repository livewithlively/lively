// #1520 — 외부 IdP 로그인(우리가 OIDC 클라이언트)의 신원 검증 경계. DB 불요(순수 함수 + fetch 스텁).
//  차단하는 회귀 3건:
//   🔴 id_token 검증이 느슨하면 **누구나 남의 계정으로 로그인**한다. V 표가 그 경계를 고정한다
//      (특히 알고리즘 혼동: 대칭키/무서명을 받으면 공개키만 알면 토큰을 위조할 수 있다).
//   🔴 email_verified 를 안 보면 **미검증 이메일로 남의 멤버에 붙는다** — 매핑 키가 이메일이다(E 표).
//   🔴 return_to 를 안 거르면 로그인 직후 외부 사이트로 튕기는 오픈 리다이렉트가 된다(R 표).
//  시나리오는 scratchpad/spec.md 의 엣지 표와 1:1 이다(행 번호 = 아래 라벨).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  oidcConfig, verifyIdToken, emailFromClaims, buildAuthorizeUrl, S256, sha256hex,
  type OidcConfig, type OidcDiscovery,
} from "./oidc.js";
import { safeReturnTo } from "../org/store/oidc-auth.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

const ISSUER = "https://idp.example";
const CLIENT_ID = "client-abc";
const cfgBase: OidcConfig = {
  issuer: ISSUER, clientId: CLIENT_ID, clientSecret: "s3cret", allowedDomains: ["honest.ai"],
  label: "Google 계정으로 로그인", trustUnverifiedEmail: false, scopes: "openid email profile",
};

// ── 키·토큰 헬퍼 ────────────────────────────────────────────────────────────
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwkOf = (k: crypto.KeyObject, kid: string | null, alg: string): Record<string, unknown> => {
  const j: Record<string, unknown> = { ...(k.export({ format: "jwk" }) as Record<string, unknown>), alg, use: "sig" };
  if (kid) j.kid = kid;
  return j;
};

const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: crypto.KeyObject): string {
  const input = `${b64u(header)}.${b64u(payload)}`;
  const alg = String(header.alg);
  const data = Buffer.from(input);
  let sig: Buffer;
  if (alg.startsWith("ES")) sig = crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
  else if (alg.startsWith("PS")) {
    sig = crypto.sign("sha256", data,
      { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  } else sig = crypto.sign("sha256", data, key);
  return `${input}.${sig.toString("base64url")}`;
}

// JWKS 를 주는 가짜 fetch. **배선 단언**: 실제로 불렸는지(jwksHits)를 보고, 안 불렸으면 그 자체가 실패다
//  — 관측 장치가 죽은 채 통과하는 vacuous test 를 막는다.
const realFetch = globalThis.fetch;
let jwksHits: string[] = [];
function stubJwks(keys: Record<string, unknown>[]): void {
  jwksHits = [];
  globalThis.fetch = (async (u: unknown) => {
    jwksHits.push(String(u));
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// jwks_uri 는 케이스마다 다르게 준다 — 모듈 내부 캐시가 케이스 사이에 섞이지 않게.
let uriSeq = 0;
const discFor = (): OidcDiscovery => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks/${++uriSeq}`,
});

const NONCE = "nonce-plain-value";
const NONCE_HASH = sha256hex(NONCE);
const now = (): number => Math.floor(Date.now() / 1000);
const claimsBase = (): Record<string, unknown> => ({
  iss: ISSUER, aud: CLIENT_ID, sub: "sub-123", exp: now() + 300, iat: now(),
  nonce: NONCE, email: "a@honest.ai", email_verified: true, name: "테스터",
});
const without = (k: string): Record<string, unknown> => {
  const c = claimsBase(); delete c[k]; return c;
};

// 통과해야 하는 케이스 — 검증을 태우고 claims 를 돌려준다(+ JWKS 를 실제로 조회했는지 확인).
async function accepts(payload: Record<string, unknown>, header: Record<string, unknown>, key: crypto.KeyObject,
  jwks: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const disc = discFor();
  stubJwks(jwks);
  const c = await verifyIdToken(signJwt(header, payload, key), cfgBase, disc, NONCE_HASH);
  assert.equal(jwksHits.length >= 1, true, "배선: JWKS 를 실제로 조회했어야 한다");
  assert.equal(jwksHits[0], disc.jwks_uri, "배선: discovery 가 준 jwks_uri 로 나갔어야 한다");
  return c as unknown as Record<string, unknown>;
}

// 거부해야 하는 케이스 — 토큰 문자열을 직접 받는다(형식 파손·alg none 처럼 서명이 없는 것도 태우기 위해).
async function rejectsToken(token: string, jwks: Record<string, unknown>[], hint: string): Promise<void> {
  const disc = discFor();
  stubJwks(jwks);
  await assert.rejects(() => verifyIdToken(token, cfgBase, disc, NONCE_HASH), (e: unknown) => e instanceof Error, hint);
}

const RSA_JWKS = [jwkOf(rsa.publicKey, "k1", "RS256")];
const RS = { alg: "RS256", kid: "k1", typ: "JWT" };

// ── C: 제공자 활성화(배포별 opt-in) ─────────────────────────────────────────
{
  const saved = { ...process.env };
  const KEYS = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ALLOWED_DOMAINS", "OIDC_LABEL", "OIDC_TRUST_UNVERIFIED_EMAIL"];
  const setEnv = (v: Record<string, string>): void => {
    for (const k of KEYS) delete process.env[k];
    for (const [k, val] of Object.entries(v)) process.env[k] = val;
  };

  setEnv({});
  assert.equal(oidcConfig(), null);
  ok("C1 설정 없음 → 제공자 꺼짐");

  setEnv({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "x" });
  assert.equal(oidcConfig(), null);
  ok("C2 secret 누락 → 꺼짐(반쯤 켜진 상태를 만들지 않는다)");

  setEnv({ OIDC_ISSUER: "http://idp.example", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y" });
  assert.equal(oidcConfig(), null);
  ok("C3 issuer 가 http → 꺼짐(iss 대조 기준이 중간자에게 열린다)");

  setEnv({
    OIDC_ISSUER: "https://accounts.google.com/", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y",
    OIDC_ALLOWED_DOMAINS: " honest.ai , @Example.COM ",
  });
  const c4 = oidcConfig();
  assert.ok(c4);
  assert.equal(c4.issuer, "https://accounts.google.com");
  assert.deepEqual(c4.allowedDomains, ["honest.ai", "example.com"]);
  assert.equal(c4.label, "Google 계정으로 로그인");
  assert.equal(c4.trustUnverifiedEmail, false);
  ok("C4 issuer 말미 슬래시·도메인 대소문자/@/공백 정규화 + 라벨 추정");

  setEnv({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y" });
  const c5 = oidcConfig();
  assert.ok(c5);
  assert.deepEqual(c5.allowedDomains, [], "도메인 env 부재 → 빈 목록(자동 가입 대상 0개)");
  assert.equal(c5.label, "회사 SSO 로 로그인", "모르는 issuer 는 중립 문구");
  ok("C5 허용 도메인 env 부재 → 켜지되 자동 가입 대상 없음");

  process.env = saved;
}

// ── V: id_token 수용 조건 ───────────────────────────────────────────────────
{
  const c = await accepts(claimsBase(), RS, rsa.privateKey, RSA_JWKS);
  assert.equal(c.sub, "sub-123");
  assert.equal(c.email, "a@honest.ai");
  ok("V1 정상 RS256 통과");
}
{
  await accepts(claimsBase(), { alg: "ES256", kid: "e1" }, ec.privateKey, [jwkOf(ec.publicKey, "e1", "ES256")]);
  ok("V2 ES256(raw r‖s 서명) 통과");
}
{
  await accepts(claimsBase(), { alg: "PS256", kid: "k1" }, rsa.privateKey, [jwkOf(rsa.publicKey, "k1", "PS256")]);
  ok("V3 PS256 통과");
}
{
  const good = signJwt(RS, claimsBase(), rsa.privateKey);
  const [h, , s] = good.split(".");
  await rejectsToken(`${h}.${b64u({ ...claimsBase(), sub: "attacker", email: "boss@honest.ai" })}.${s}`,
    RSA_JWKS, "위조 페이로드");
  ok("V4 페이로드 바꿔치기(서명 그대로) 거부");
}
{
  const jwk = jwkOf(rsa.publicKey, "k1", "RS256");
  const input = `${b64u({ alg: "HS256", kid: "k1" })}.${b64u(claimsBase())}`;
  const mac = crypto.createHmac("sha256", String(jwk.n)).update(input).digest("base64url");
  await rejectsToken(`${input}.${mac}`, [jwk], "HS256");
  ok("V5 공개키를 HMAC 키로 쓴 HS256 거부(알고리즘 혼동)");
}
{
  await rejectsToken(`${b64u({ alg: "none" })}.${b64u(claimsBase())}.`, RSA_JWKS, "alg none");
  ok("V6 alg=none 거부");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), aud: "someone-else" }, rsa.privateKey), RSA_JWKS, "aud");
  ok("V7 aud 가 남의 client_id 면 거부");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), aud: [CLIENT_ID, "other"], azp: "other" }, rsa.privateKey),
    RSA_JWKS, "azp");
  ok("V8 aud 다중 + azp 가 남 → 거부");
}
{
  const c = await accepts({ ...claimsBase(), aud: [CLIENT_ID, "other"], azp: CLIENT_ID }, RS, rsa.privateKey, RSA_JWKS);
  assert.equal(c.sub, "sub-123");
  ok("V9 aud 다중 + azp 가 우리 → 통과");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), iss: "https://evil.example" }, rsa.privateKey), RSA_JWKS, "iss");
  ok("V10 iss 가 다른 IdP 면 거부");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), exp: now() - 3600 }, rsa.privateKey), RSA_JWKS, "만료");
  ok("V11 만료(오차 밖) 거부");
}
{
  const c = await accepts({ ...claimsBase(), exp: now() - 30 }, RS, rsa.privateKey, RSA_JWKS);
  assert.equal(c.sub, "sub-123");
  ok("V12 만료 직후지만 시계 오차 1분 안 → 통과(경계값)");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), iat: now() + 3600 }, rsa.privateKey), RSA_JWKS, "iat 미래");
  ok("V13 iat 가 먼 미래면 거부");
}
{
  await rejectsToken(signJwt(RS, { ...claimsBase(), nonce: "다른-논스" }, rsa.privateKey), RSA_JWKS, "nonce 불일치");
  ok("V14 nonce 불일치 거부");
}
{
  await rejectsToken(signJwt(RS, without("nonce"), rsa.privateKey), RSA_JWKS, "nonce 부재");
  ok("V15 nonce 부재 거부(인가응답 재생 차단)");
}
{
  await rejectsToken(signJwt(RS, without("sub"), rsa.privateKey), RSA_JWKS, "sub 부재");
  ok("V16 sub 부재 거부");
}
{
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await rejectsToken(signJwt({ alg: "RS256", kid: "unknown-kid" }, claimsBase(), other.privateKey), RSA_JWKS, "미지 kid");
  ok("V17 JWKS 에 없는 kid 거부");
}
{
  const c = await accepts(claimsBase(), { alg: "RS256" }, rsa.privateKey, [jwkOf(rsa.publicKey, null, "RS256")]);
  assert.equal(c.sub, "sub-123");
  ok("V18 kid 부재 + JWKS 키 1개 → 그 키로 검증해 통과");
}
{
  await rejectsToken("not-a-jwt", RSA_JWKS, "형식");
  await rejectsToken("a.b", RSA_JWKS, "형식(2조각)");
  ok("V19 JWT 형식이 아니면 거부");
}

// ── E: 로그인에 쓸 이메일 ───────────────────────────────────────────────────
{
  assert.equal(emailFromClaims({ ...claimsBase(), email: "A@Honest.AI" } as never, cfgBase), "a@honest.ai");
  ok("E1 이메일 소문자 정규화");

  assert.equal(emailFromClaims({ ...claimsBase(), email_verified: false } as never, cfgBase), null);
  ok("E2 email_verified=false 거부");

  assert.equal(emailFromClaims(without("email_verified") as never, cfgBase), null);
  ok("E3 email_verified 부재 → 기본 거부");

  assert.equal(emailFromClaims(without("email_verified") as never, { ...cfgBase, trustUnverifiedEmail: true }), "a@honest.ai");
  ok("E4 email_verified 부재 + 운영자가 명시 opt-in → 통과");

  assert.equal(emailFromClaims(without("email") as never, cfgBase), null);
  ok("E5 이메일 부재 거부");

  assert.equal(emailFromClaims({ ...claimsBase(), email: "no-at-sign" } as never, cfgBase), null);
  ok("E6 이메일 형식 파손(@ 없음) 거부");
}

// ── R: 로그인 후 복귀 주소 ──────────────────────────────────────────────────
{
  assert.equal(safeReturnTo("/ui/#/knowledge"), "/ui/#/knowledge");
  ok("R1 내부 경로는 통과");
  assert.equal(safeReturnTo("//evil.example/x"), null);
  ok("R2 스킴 상대 URL 무시");
  assert.equal(safeReturnTo("/\\evil.example"), null);
  ok("R3 역슬래시 우회 무시");
  assert.equal(safeReturnTo("https://evil.example"), null);
  ok("R4 절대 URL 무시");
  assert.equal(safeReturnTo(""), null);
  assert.equal(safeReturnTo(null), null);
  ok("R5 빈 값·null 무시");
}

// ── A: 인가 요청 ────────────────────────────────────────────────────────────
{
  const mk = (cfg: OidcConfig): URL => new URL(buildAuthorizeUrl(cfg, discFor(),
    { redirectUri: "https://gw.example/api/ui/auth/oidc/callback", state: "st", nonce: "no", codeVerifier: "ver" }));

  const u = mk(cfgBase);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), S256("ver"));
  assert.notEqual(u.searchParams.get("code_challenge"), "ver", "verifier 원문이 그대로 나가면 PKCE 가 무의미하다");
  assert.equal(u.searchParams.get("nonce"), "no");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("client_secret"), null);
  assert.equal(u.href.includes(cfgBase.clientSecret), false, "secret 은 브라우저가 보는 주소에 실리지 않는다");
  ok("A1 PKCE(S256)·nonce·state 를 싣고 secret 은 싣지 않는다");

  assert.equal(mk(cfgBase).searchParams.get("hd"), "honest.ai");
  ok("A2 허용 도메인 1개 → 계정 선택 힌트");

  assert.equal(mk({ ...cfgBase, allowedDomains: [] }).searchParams.get("hd"), null);
  assert.equal(mk({ ...cfgBase, allowedDomains: ["a.com", "b.com"] }).searchParams.get("hd"), null);
  ok("A3 허용 도메인 0개·2개 이상 → 힌트 없음(경계)");
}

globalThis.fetch = realFetch;
console.log(`oidc tests: ${pass} groups passed`);

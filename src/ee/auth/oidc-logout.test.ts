// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// IdP 로그인 세션의 로그아웃 주소(RP-Initiated Logout). DB 불요 — 설정·discovery 는 주입, discovery 배선만 fetch 스텁.
//  사양·엣지 표:
//   L1 IdP 세션 + 보관 토큰 → end_session 주소에 client_id·post_logout_redirect_uri·id_token_hint
//   L2 IdP 세션 + 보관 토큰 없음 → id_token_hint 만 빠진다(로그아웃 문은 그래도 간다)
//   L3 보관 토큰 복호화 실패(마스터키 교체) → L2 와 같다
//   L4 IdP 가 아닌 세션(비밀번호·CP 교환) → null, discovery 도 안 탄다
//   L5 discovery 에 end_session_endpoint 없음(구글) → null
//   L6 discovery 실패 → null(던지지 않는다 — 로그아웃은 끝까지 가야 한다)
//   L7 SSO 설정이 꺼짐 → null
//   L8 end_session 주소에 이미 쿼리가 있으면 & 로 잇는다
//   D1 discover() 가 end_session_endpoint 를 실제로 넘겨준다(배선) · D2 없으면 필드 자체가 없다
//   S1 sealIdToken — 마스터키 있으면 암호문(평문 아님)·복원 가능 · S2 마스터키 없으면 보관 안 함
import test from "node:test";
import assert from "node:assert/strict";
import { oidcLogoutUrl, buildEndSessionUrl, sealIdToken, type OidcLogoutDeps } from "./oidc-logout.js";
import { OIDC_AUTH_METHOD } from "../../enterprise/registry.js";
import { discover, type OidcConfig, type OidcDiscovery } from "./oidc.js";
import { tryDecryptSecret } from "../../org/credentials/secret-box.js";

// DB 가 있으면 oidcConfig 가 관리탭(DB) 설정을 읽어 시험이 주입한 설정 밖으로 나간다 — 이 스위트는 DB 없이 돈다.
delete process.env.ITEMS_DATABASE_URL;
process.env.CONNECTOR_SECRET_KEY = "a".repeat(64);

const ISSUER = "https://sso.example/realms/acme";
const END = `${ISSUER}/protocol/openid-connect/logout`;
const BACK = "https://gw.example/ui/";
const HINT_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
const cfg: OidcConfig = {
  issuer: ISSUER, clientId: "lively", clientSecret: "s3cret", allowedDomains: [],
  label: "회사 계정", trustUnverifiedEmail: false, scopes: "openid email profile",
};
const disc = (extra: Partial<OidcDiscovery> = {}): OidcDiscovery => ({
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/certs`, end_session_endpoint: END, ...extra,
});

// 배선 단언용 — discovery 가 몇 번 불렸는지 센다(L4 는 0 이어야 한다).
function depsWith(d: () => Promise<OidcDiscovery>, c: OidcConfig | null = cfg): OidcLogoutDeps & { hits: () => number } {
  let n = 0;
  return { config: async () => c, discover: async () => { n++; return d(); }, hits: () => n };
}
const oidcSession = (enc: string | null) => ({ authMethod: OIDC_AUTH_METHOD, ssoIdTokenEnc: enc });

test("L1 IdP 세션 + 보관 토큰 → client_id·post_logout_redirect_uri·id_token_hint 를 싣는다", async () => {
  const enc = sealIdToken(HINT_JWT);
  assert.ok(enc);
  const got = await oidcLogoutUrl(oidcSession(enc), BACK, depsWith(async () => disc()));
  assert.ok(got, "IdP 세션인데 로그아웃 문이 없다 — IdP 세션이 살아 남는다");
  const u = new URL(got!);
  assert.equal(u.origin + u.pathname, END, "discovery 가 준 end_session_endpoint 로 가야 한다");
  assert.equal(u.searchParams.get("client_id"), "lively");
  assert.equal(u.searchParams.get("post_logout_redirect_uri"), BACK);
  assert.equal(u.searchParams.get("id_token_hint"), HINT_JWT, "보관 토큰은 평문으로 복원돼 실려야 한다");
  assert.equal(got!.includes(cfg.clientSecret), false, "client_secret 은 브라우저 주소에 실리지 않는다");
});

test("L2 보관 토큰 없음 → id_token_hint 만 빠진다", async () => {
  const u = new URL((await oidcLogoutUrl(oidcSession(null), BACK, depsWith(async () => disc())))!);
  assert.equal(u.searchParams.get("id_token_hint"), null);
  assert.equal(u.searchParams.get("client_id"), "lively");
  assert.equal(u.searchParams.get("post_logout_redirect_uri"), BACK);
});

test("L3 복호화 실패 토큰 → 힌트 없이 간다(던지지 않는다)", async () => {
  const u = new URL((await oidcLogoutUrl(oidcSession("gcm$broken$x$y"), BACK, depsWith(async () => disc())))!);
  assert.equal(u.searchParams.get("id_token_hint"), null);
  assert.equal(u.origin + u.pathname, END);
});

test("L4 IdP 가 아닌 세션 → null, discovery 를 타지 않는다", async () => {
  for (const authMethod of [null, "password", "exchange"]) {
    const deps = depsWith(async () => disc());
    assert.equal(await oidcLogoutUrl({ authMethod, ssoIdTokenEnc: null }, BACK, deps), null, `authMethod=${authMethod}`);
    assert.equal(deps.hits(), 0, "IdP 와 무관한 로그아웃이 IdP 를 두드린다");
  }
});

test("L5 end_session_endpoint 가 없는 IdP → null(웹 세션만 끝낸다)", async () => {
  const deps = depsWith(async () => disc({ end_session_endpoint: undefined }));
  assert.equal(await oidcLogoutUrl(oidcSession(sealIdToken(HINT_JWT)), BACK, deps), null);
  assert.equal(deps.hits(), 1, "배선: discovery 를 실제로 봤어야 한다");
});

test("L6 discovery 실패 → null(던지지 않는다)", async () => {
  const deps = depsWith(async () => { throw new Error("IdP down"); });
  assert.equal(await oidcLogoutUrl(oidcSession(null), BACK, deps), null);
  assert.equal(deps.hits(), 1);
});

test("L7 SSO 설정이 꺼져 있으면 → null", async () => {
  const deps = depsWith(async () => disc(), null);
  assert.equal(await oidcLogoutUrl(oidcSession(null), BACK, deps), null);
  assert.equal(deps.hits(), 0);
});

test("L8 end_session 주소에 쿼리가 있으면 & 로 잇는다", () => {
  const got = buildEndSessionUrl(`${END}?ui_locales=ko`, { clientId: "lively", postLogoutRedirectUri: BACK, idToken: null });
  const u = new URL(got);
  assert.equal(u.searchParams.get("ui_locales"), "ko");
  assert.equal(u.searchParams.get("client_id"), "lively");
});

test("D1·D2 discover() 는 end_session_endpoint 를 넘기고, 없으면 필드를 만들지 않는다", async () => {
  const realFetch = globalThis.fetch;
  const doc = (withEnd: boolean): Record<string, unknown> => ({
    issuer: "", authorization_endpoint: "a", token_endpoint: "t", jwks_uri: "j",
    ...(withEnd ? { end_session_endpoint: "https://e.example/logout" } : {}),
  });
  try {
    // discover 는 issuer 단위로 캐시한다 — 케이스마다 다른 issuer 를 써서 캐시가 섞이지 않게 한다.
    for (const [withEnd, iss] of [[true, "https://d1.example"], [false, "https://d2.example"]] as const) {
      let hit = "";
      globalThis.fetch = (async (u: unknown) => {
        hit = String(u);
        return new Response(JSON.stringify({ ...doc(withEnd), issuer: iss }), { status: 200 });
      }) as typeof fetch;
      const d = await discover({ ...cfg, issuer: iss });
      assert.equal(hit, `${iss}/.well-known/openid-configuration`, "배선: discovery 문서를 실제로 받았어야 한다");
      if (withEnd) assert.equal(d.end_session_endpoint, "https://e.example/logout", "D1");
      else assert.equal("end_session_endpoint" in d, false, "D2");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("S1·S2 sealIdToken — 마스터키가 있으면 암호문으로, 없으면 보관하지 않는다", () => {
  const enc = sealIdToken(HINT_JWT);
  assert.ok(enc && enc !== HINT_JWT && !enc.includes(HINT_JWT), "DB 에 평문 토큰이 들어간다");
  assert.equal(tryDecryptSecret(enc!), HINT_JWT);
  const saved = process.env.CONNECTOR_SECRET_KEY;
  delete process.env.CONNECTOR_SECRET_KEY;
  try {
    assert.equal(sealIdToken(HINT_JWT), null, "마스터키 없이 평문을 보관하면 안 된다");
  } finally {
    process.env.CONNECTOR_SECRET_KEY = saved;
  }
});

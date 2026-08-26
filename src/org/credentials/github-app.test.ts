// GitHub App 직결(#1881 G5) 순수 단위 체크 — DB/네트워크 불요(fetch 는 스텁).
// 실행: npm run build && node dist/org/credentials/github-app.test.js
//  사양·엣지 표대로 행마다 시나리오 하나(A·P·J·I·M·C·U·K·G). fail-first 로 red 를 먼저 확인했다.
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  buildGithubAuthorizeUrl, githubInstallUrl, parseGithubTokenResponse, exchangeGithubCode,
  refreshGithubUserToken, buildAppJwt, parseInstallationTokenResponse, mintInstallationToken,
  installationCloneUrl, parseInstallCallback, isGithubAppKind, GITHUB_TOKEN_URL,
} from "./github-app.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): void => {
  const r = fn();
  if (r instanceof Promise) { void r.then(() => { pass++; console.log(`ok  ${name}`); }); return; }
  pass++; console.log(`ok  ${name}`);
};
// 비동기 테스트는 순서를 지키려고 직렬로 await 한다(위 t 는 동기 전용).
const at = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// 테스트 전용 RSA 키 — 실제 서명·검증을 돌려야 J6 가 의미를 갖는다(모양만 보면 아무것도 검증 못 한다).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

// ══ A · 인가 URL ══
t("A1 인가 URL — client_id·redirect_uri·state 를 싣고 scope 는 싣지 않는다", () => {
  const u = new URL(buildGithubAuthorizeUrl({ clientId: "Iv1.abc", redirectUri: "https://dev.lvly.io/oauth/callback", state: "s1" }));
  assert.equal(u.origin + u.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "Iv1.abc");
  assert.equal(u.searchParams.get("redirect_uri"), "https://dev.lvly.io/oauth/callback");
  assert.equal(u.searchParams.get("state"), "s1");
  // GitHub App 은 권한이 앱 설정에 고정이라 scope 를 요청 시점에 못 넓힌다 — 실으면 잘못된 기대를 코드에 박는 것이다.
  assert.equal(u.searchParams.get("scope"), null);
});

// ══ P · 토큰 응답 파싱 (GitHub 은 실패도 200 + {error}) ══
t("P1·P5·P7 정상 응답 — 만료·refresh 보존, token_type 기본값", () => {
  const a = parseGithubTokenResponse({ access_token: "ghu_x", token_type: "bearer", expires_in: 28800, refresh_token: "ghr_y", refresh_token_expires_in: 15811200, scope: "" });
  assert.equal(a.access_token, "ghu_x");
  assert.equal(a.expires_in, 28800);
  assert.equal(a.refresh_token, "ghr_y");
  assert.equal(parseGithubTokenResponse({ access_token: "ghu_x" }).token_type, "bearer");
});

t("P2 ★ 실패가 HTTP 200 으로 온다 — 본문의 error 를 보지 않으면 그대로 통과한다", () => {
  assert.throws(
    () => parseGithubTokenResponse({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }),
    /bad_verification_code[\s\S]*incorrect or expired/);
});

t("P3·P4 access_token 이 없거나 비면 거부", () => {
  assert.throws(() => parseGithubTokenResponse({}), /access_token/);
  assert.throws(() => parseGithubTokenResponse({ access_token: "" }), /access_token/);
});

t("P6 숫자가 아닌 만료값은 필드를 생략한다 — NaN 을 금고에 저장하면 만료 판정이 영원히 틀린다", () => {
  const r = parseGithubTokenResponse({ access_token: "ghu_x", expires_in: "28800", refresh_token_expires_in: null });
  assert.equal("expires_in" in r, false);
  assert.equal("refresh_token_expires_in" in r, false);
});

// ══ J · App JWT ══
t("J1·J2 JWT 모양과 시간 경계 — alg RS256 · iss=appId · iat=now-60 · exp-iat=540(≤600)", () => {
  const now = 1_700_000_000;
  const parts = buildAppJwt({ appId: "12345", privateKeyPem: PEM, nowSec: now }).split(".");
  assert.equal(parts.length, 3);
  const head = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const body = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.deepEqual(head, { alg: "RS256", typ: "JWT" });
  assert.equal(body.iss, "12345");
  assert.equal(body.iat, now - 60, "시계가 빠르면 GitHub 이 거부한다 — iat 은 뒤로 민다");
  assert.equal(body.exp - body.iat, 540);
  assert.ok(body.exp - body.iat <= 600, "GitHub 제약: 10분 초과 JWT 는 거부된다");
});

t("J6 ★ 서명이 공개키로 실제 검증된다 — 모양만 맞으면 상류가 401 을 준다", () => {
  const jwt = buildAppJwt({ appId: "12345", privateKeyPem: PEM, nowSec: 1_700_000_000 });
  const [h, p, s] = jwt.split(".");
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

t("J3·J4·J5 빈 appId·빈 키·깨진 PEM 은 거부", () => {
  assert.throws(() => buildAppJwt({ appId: "", privateKeyPem: PEM, nowSec: 1 }), /App ID/);
  assert.throws(() => buildAppJwt({ appId: "1", privateKeyPem: "  ", nowSec: 1 }), /private key/);
  assert.throws(() => buildAppJwt({ appId: "1", privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----", nowSec: 1 }));
});

// ══ I · installation token 응답 ══
t("I1·I3 정상 — 레포 목록은 full_name 만 추린다", () => {
  const r = parseInstallationTokenResponse({
    token: "ghs_x", expires_at: "2026-08-26T10:00:00Z", repository_selection: "selected",
    repositories: [{ full_name: "o/a", id: 1 }, { full_name: "o/b" }],
  });
  assert.equal(r.token, "ghs_x");
  assert.equal(r.repository_selection, "selected");
  assert.deepEqual(r.repositories, ["o/a", "o/b"]);
});

t("I2 실패 응답(message)은 그대로 드러낸다", () => {
  assert.throws(() => parseInstallationTokenResponse({ message: "Not Found" }), /Not Found/);
  assert.throws(() => parseInstallationTokenResponse({}), /발급 실패/);
});

t("I4 repositories 가 비면 필드를 만들지 않는다", () => {
  assert.equal("repositories" in parseInstallationTokenResponse({ token: "t", expires_at: "", repositories: [] }), false);
});

// ══ C · clone 주소 ══
t("C1·C2·C4 clone 주소 — .git·슬래시 정리, 토큰은 URL 인코딩", () => {
  assert.equal(installationCloneUrl("livewithlively/lively", "ghs_x"),
    "https://x-access-token:ghs_x@github.com/livewithlively/lively.git");
  assert.equal(installationCloneUrl("/o/r.git/", "ghs_x"), "https://x-access-token:ghs_x@github.com/o/r.git");
  // 토큰에 @ 나 / 가 섞이면 URL 이 통째로 깨진다(다른 호스트로 나갈 수도 있다).
  assert.ok(installationCloneUrl("o/r", "a/b@c").includes("a%2Fb%40c"));
});

t("C3 owner/repo 형식이 아니면 거부 — 지어낸 주소로 clone 하지 않는다", () => {
  assert.throws(() => installationCloneUrl("justname", "t"), /형식 오류/);
  assert.throws(() => installationCloneUrl("a/b/c", "t"), /형식 오류/);
});

// ══ U · 설치 URL / K · 콜백 / G · kind ══
t("U1·U2·U3 설치 URL", () => {
  assert.equal(githubInstallUrl("lively"), "https://github.com/apps/lively/installations/new");
  assert.equal(new URL(githubInstallUrl("lively", "st8")).searchParams.get("state"), "st8");
  assert.throws(() => githubInstallUrl("  "), /slug/);
});

t("K1·K2 콜백의 installation_id 는 숫자만 받는다 — 그 값이 API 경로에 들어간다", () => {
  assert.equal(parseInstallCallback({ installation_id: "12345", setup_action: "install" }).installationId, "12345");
  assert.equal(parseInstallCallback({ installation_id: "12345/../../x" }).installationId, null);
  assert.equal(parseInstallCallback({}).installationId, null);
});

t("G1·G2 이 auth_kind 가 GitHub 직결을 타는가", () => {
  assert.equal(isGithubAppKind("github_pat"), true);
  assert.equal(isGithubAppKind("GitHub_PAT"), true);
  assert.equal(isGithubAppKind("gitlab_pat"), false);
  assert.equal(isGithubAppKind(null), false);
});

// ══ M · 실제 호출 형태(fetch 스텁) ══
await at("M1 installation_id 가 숫자가 아니면 네트워크에 나가기 전에 막는다", async () => {
  let called = 0;
  await assert.rejects(
    () => mintInstallationToken({ appId: "1", privateKeyPem: PEM, installationId: "abc", fetchFn: async () => { called++; return json({}); } }),
    /installation_id/);
  assert.equal(called, 0, "형식 검사가 fetch 뒤에 있으면 잘못된 경로가 상류로 나간다");
});

await at("M2·M3 repositories 를 주면 body 로 좁히고, 안 주면 body 를 안 보낸다", async () => {
  const seen: Array<{ url: string; body?: string; auth?: string }> = [];
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(url), body: init?.body as string | undefined, auth: h.authorization });
    return json({ token: "ghs_x", expires_at: "2026-08-26T10:00:00Z" }, 201);
  };
  await mintInstallationToken({ appId: "1", privateKeyPem: PEM, installationId: "42", repositories: ["o/a"], fetchFn });
  assert.equal(seen[0].url, "https://api.github.com/app/installations/42/access_tokens");
  assert.deepEqual(JSON.parse(seen[0].body as string), { repositories: ["o/a"] });
  assert.ok(seen[0].auth?.startsWith("Bearer "), "App JWT 로 인증해야 한다");

  await mintInstallationToken({ appId: "1", privateKeyPem: PEM, installationId: "42", fetchFn });
  assert.equal(seen[1].body, undefined, "빈 body 를 보내면 상류가 400 을 준다");
});

await at("교환·갱신은 같은 토큰 엔드포인트에 form 으로 나간다(grant_type 만 다르다)", async () => {
  const seen: string[] = [];
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(String(url), GITHUB_TOKEN_URL);
    seen.push(String(init?.body));
    return json({ access_token: "ghu_x", token_type: "bearer" });
  };
  await exchangeGithubCode({ clientId: "c", clientSecret: "s", code: "co", redirectUri: "https://g/oauth/callback", fetchFn });
  await refreshGithubUserToken({ clientId: "c", clientSecret: "s", refreshToken: "ghr_y", fetchFn });
  assert.ok(new URLSearchParams(seen[0]).get("code") === "co");
  assert.equal(new URLSearchParams(seen[0]).get("grant_type"), null, "교환은 grant_type 을 안 쓴다");
  assert.equal(new URLSearchParams(seen[1]).get("grant_type"), "refresh_token");
});

await at("HTTP 4xx 는 상태코드로 잡는다(본문 error 와 별개 경로)", async () => {
  await assert.rejects(
    () => exchangeGithubCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", fetchFn: async () => json({ error: "x" }, 401) }),
    /401/);
});

console.log(`\ngithub-app tests: ${pass} passed`);

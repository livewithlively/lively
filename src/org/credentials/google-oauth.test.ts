// #1881 G2 구글 직결 OAuth — 순수 함수 회귀 잠금. DB·네트워크 불요.
//   실행: npm run build && node dist/org/credentials/google-oauth.test.js
//
//   사양·엣지 표 23행 기준(스크래치패드 spec.md). 여기 행들은 전부 "빼먹으면 조용히 망가지는 것"을 겨눈다:
//    · 인가 URL 표시 3종 중 하나만 빠져도 1시간 뒤 또는 서비스 추가 때 무너진다
//    · mergeGoogleTokens 의 refresh_token 보존 — 놓치면 갱신 1회 뒤 **영구 실패**(재연결 말고 복구 수단 없음)
//    · 최소 권한 — 안 고른 서비스 범위가 새면 제한범위가 되어 CASA·100명 한도에 걸린다
import assert from "node:assert/strict";
import {
  buildGoogleAuthorizeUrl, googleScopeString, parseGoogleTokenResponse, mergeGoogleTokens,
  googleInstallToSlot, googleInstallFromBlob, googleTokenExpired, decodeIdTokenClaims,
  isGoogleServer, GOOGLE_AUTHORIZE_URL, type GoogleInstall,
} from "./google-oauth.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const DRIVE_RO = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_RO = "https://www.googleapis.com/auth/gmail.readonly";
const CAL_RO = "https://www.googleapis.com/auth/calendar.readonly";

// ── 표 1~3 · 인가 URL ────────────────────────────────────────────────────────
t("[1] 인가 URL: 갱신가능(access_type)·재동의강제(prompt)·증분인가(include_granted_scopes) 셋이 모두 실린다", () => {
  const u = new URL(buildGoogleAuthorizeUrl({
    clientId: "cid.apps.googleusercontent.com", redirectUri: "https://gw.example/oauth/callback",
    state: "st", scope: googleScopeString(),
  }));
  assert.equal(`${u.origin}${u.pathname}`, GOOGLE_AUTHORIZE_URL);
  assert.equal(u.searchParams.get("access_type"), "offline");       // 없으면 refresh_token 미발급 → 1시간 뒤 전멸
  assert.equal(u.searchParams.get("prompt"), "consent");            // 없으면 재연결이 refresh_token 없이 반쪽
  assert.equal(u.searchParams.get("include_granted_scopes"), "true"); // 없으면 서비스 추가 시 기존 동의 소실
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://gw.example/oauth/callback");
  assert.equal(u.searchParams.get("state"), "st");
});

t("[2] 인가 URL: PKCE 챌린지가 있으면 챌린지 + S256 방식이 실린다", () => {
  const u = new URL(buildGoogleAuthorizeUrl({
    clientId: "c", redirectUri: "https://gw/cb", state: "s", scope: "openid", codeChallenge: "abc",
  }));
  assert.equal(u.searchParams.get("code_challenge"), "abc");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

t("[3] 인가 URL: 챌린지가 없으면 챌린지 관련 파라미터가 하나도 안 실린다", () => {
  const u = new URL(buildGoogleAuthorizeUrl({ clientId: "c", redirectUri: "https://gw/cb", state: "s", scope: "openid" }));
  // method 만 남으면 구글이 code_challenge 누락으로 400 — 짝이 맞아야 한다
  assert.equal(u.searchParams.get("code_challenge"), null);
  assert.equal(u.searchParams.get("code_challenge_method"), null);
});

// ── 표 4~7 · scope 합집합(= "원큐"의 실체, 동시에 심사 등급을 정하는 자리) ──────────────
t("[4] scope: 고른 서비스의 합집합 + 신원 2종, 중복 0", () => {
  const s = googleScopeString(["drive", "gmail", "calendar"]).split(" ");
  for (const want of ["openid", "https://www.googleapis.com/auth/userinfo.email", DRIVE_RO, GMAIL_RO, CAL_RO]) {
    assert.ok(s.includes(want), `${want} 가 빠졌다`);
  }
  assert.equal(new Set(s).size, s.length, "중복 scope");
});

t("[5] scope: 캘린더만 고르면 메일·드라이브 범위가 새지 않는다(최소권한 — 제한범위 회피)", () => {
  const s = googleScopeString(["calendar"]).split(" ");
  assert.ok(s.includes(CAL_RO));
  assert.ok(!s.some((x) => x.includes("gmail")), "안 고른 Gmail 범위 누출 — 제한범위가 되어 CASA·100명 한도에 걸린다");
  assert.ok(!s.some((x) => x.includes("drive")), "안 고른 드라이브 범위 누출");
});

t("[6] scope: drive_file 은 비민감 범위만 — 제한범위(drive.readonly)가 섞이지 않는다", () => {
  const s = googleScopeString(["drive_file"]).split(" ");
  assert.ok(s.includes(DRIVE_FILE));
  assert.ok(!s.includes(DRIVE_RO), "제한범위가 섞이면 '검증 0' 경로의 의미가 통째로 사라진다");
});

t("[7] scope: 빈 목록(경계)은 기본 3종으로 떨어진다 — 빈 scope 요청은 상류가 거부한다", () => {
  assert.equal(googleScopeString([]), googleScopeString(["drive", "gmail", "calendar"]));
});

// ── 표 8~13 · 토큰 응답 파싱 ──────────────────────────────────────────────────
t("[8] parse: 상대 수명(expires_in)을 발급 시각 기준 절대 만료로 굳힌다", () => {
  const i = parseGoogleTokenResponse({ access_token: "at", expires_in: 3599, scope: "a b" }, 1_000_000);
  assert.equal(i.access_token, "at");
  assert.equal(i.expires_at, 1_000_000 + 3599 * 1000);
  assert.equal(i.scope, "a b");
});

t("[9] parse: 오류는 던진다 — 권한 회수(invalid_grant)는 재연결 안내를 붙인다", () => {
  assert.throws(() => parseGoogleTokenResponse({ error: "invalid_client", error_description: "bad" }), /invalid_client/);
  // 이 문구가 없으면 사용자는 '왜 안 되는지'를 모른 채 같은 화면을 반복한다
  assert.throws(() => parseGoogleTokenResponse({ error: "invalid_grant" }), /다시 하세요/);
});

t("[10] parse: access_token 이 없으면 연결이 아니다(던진다)", () => {
  assert.throws(() => parseGoogleTokenResponse({ expires_in: 100 }), /access_token/);
});

t("[11] parse: 수명 정보가 없거나 비수치면 만료 미상(null) — 만료로 단정하지 않는다", () => {
  assert.equal(parseGoogleTokenResponse({ access_token: "at" }).expires_at, null);
  assert.equal(parseGoogleTokenResponse({ access_token: "at", expires_in: "later" }).expires_at, null);
  assert.equal(parseGoogleTokenResponse({ access_token: "at", expires_in: 0 }).expires_at, null);
});

t("[12] parse: 신원 토큰에서 계정 식별자 2종을 뽑는다(표시용)", () => {
  const payload = Buffer.from(JSON.stringify({ email: "a@b.com", sub: "123" }), "utf8").toString("base64url");
  const i = parseGoogleTokenResponse({ access_token: "at", id_token: `h.${payload}.sig` });
  assert.equal(i.email, "a@b.com");
  assert.equal(i.sub, "123");
});

t("[13] 신원 토큰이 깨졌거나 없으면 던지지 않고 null — 표시용이라 연결을 막으면 안 된다", () => {
  assert.deepEqual(decodeIdTokenClaims("garbage"), { email: null, sub: null });
  assert.deepEqual(decodeIdTokenClaims("h.@@@.s"), { email: null, sub: null });
  assert.deepEqual(decodeIdTokenClaims(null), { email: null, sub: null });
  // 파싱 실패해도 토큰 자체는 살아 있어야 한다
  assert.equal(parseGoogleTokenResponse({ access_token: "at", id_token: "garbage" }).access_token, "at");
});

// ── 표 14~17 · ★ 병합(가장 비싼 함정) ──────────────────────────────────────────
t("[14] ★ merge: 갱신 응답에 refresh_token 이 없으면 기존 값을 보존한다", () => {
  const prev: GoogleInstall = { access_token: "old", refresh_token: "RT", expires_at: 1, scope: "a", email: "e@x", sub: "s" };
  const refreshed: GoogleInstall = { access_token: "new", refresh_token: null, expires_at: 2, scope: "a", email: null, sub: null };
  const m = mergeGoogleTokens(prev, refreshed);
  // 덮어쓰면 1시간 뒤 영구 실패 — 재연결 말고는 복구 수단이 없다
  assert.equal(m.refresh_token, "RT");
  assert.equal(m.access_token, "new");
  assert.equal(m.expires_at, 2);
  assert.equal(m.email, "e@x", "표시용 정보도 갱신 응답에 없으면 보존");
});

t("[15] merge: 갱신 응답이 refresh_token 을 주면 새 값을 채택한다(재연결 = 새 grant)", () => {
  const prev: GoogleInstall = { access_token: "old", refresh_token: "OLD", expires_at: 1, scope: "a", email: null, sub: null };
  const m = mergeGoogleTokens(prev, { access_token: "new", refresh_token: "NEW", expires_at: 2, scope: "b", email: null, sub: null });
  assert.equal(m.refresh_token, "NEW");
  assert.equal(m.scope, "b");
});

t("[16] merge: 이전 상태가 없으면(최초 연결) 새 값 그대로", () => {
  const m = mergeGoogleTokens(null, { access_token: "a", refresh_token: "R", expires_at: 9, scope: "s", email: "e", sub: "u" });
  assert.equal(m.refresh_token, "R");
  assert.equal(m.access_token, "a");
  assert.equal(m.scope, "s");
});

t("[17] merge: 갱신 응답의 scope 가 빈 문자열이면(경계) 기존 범위를 보존한다", () => {
  const prev: GoogleInstall = { access_token: "o", refresh_token: "R", expires_at: 1, scope: "drive gmail", email: null, sub: null };
  const m = mergeGoogleTokens(prev, { access_token: "n", refresh_token: null, expires_at: 2, scope: "", email: null, sub: null });
  // 빈 문자열을 그대로 채택하면 화면이 "권한 없음"으로 보이고 재연결을 유도한다(멀쩡한 연결인데)
  assert.equal(m.scope, "drive gmail");
});

// ── 표 18~20 · 금고 슬롯 ─────────────────────────────────────────────────────
t("[18] slot: 토큰은 암호문 블롭에만 — 평문 meta 에 새지 않는다", () => {
  const slot = googleInstallToSlot({ access_token: "AT", refresh_token: "RT", expires_at: 5, scope: "s", email: "e@x", sub: "u" });
  assert.equal(slot.scopeKey, "");
  const metaJson = JSON.stringify(slot.meta);
  assert.ok(!metaJson.includes("RT"), "meta 는 평문 — refresh_token 유출");
  assert.ok(!metaJson.includes("AT"), "meta 는 평문 — access_token 유출");
  assert.equal(slot.meta.google_email, "e@x");
  const blob = JSON.parse(slot.secret) as Record<string, unknown>;
  assert.equal(blob.access_token, "AT");
  assert.equal(blob.refresh_token, "RT");
  assert.equal(blob.token_type, "bearer", "oauth-proxy-auth 가 Bearer 로 싣는 계약");
});

t("[19] slot: 블롭 왕복 — 복원이 refresh_token·만료를 되살린다", () => {
  const slot = googleInstallToSlot({ access_token: "AT", refresh_token: "RT", expires_at: 5, scope: "s", email: null, sub: null });
  const back = googleInstallFromBlob(slot.secret);
  assert.equal(back?.access_token, "AT");
  assert.equal(back?.refresh_token, "RT");
  assert.equal(back?.expires_at, 5);
  assert.equal(back?.scope, "s");
});

t("[20] 복원: 깨짐·빈값·토큰 없음은 null(호출부가 '연결 없음'으로 명확히 실패하게)", () => {
  assert.equal(googleInstallFromBlob(null), null);
  assert.equal(googleInstallFromBlob(""), null);
  assert.equal(googleInstallFromBlob("not json"), null);
  assert.equal(googleInstallFromBlob('{"token_type":"bearer"}'), null);
});

// ── 표 21~22 · 만료 판정 ─────────────────────────────────────────────────────
const mk = (exp: number | null): GoogleInstall =>
  ({ access_token: "a", refresh_token: null, expires_at: exp, scope: "", email: null, sub: null });

t("[21] expired: 여유 시간 경계 ±1 — 정확히 60초 남으면 만료, 1ms 더 남으면 아님", () => {
  const now = 1_000_000;
  assert.equal(googleTokenExpired(mk(now + 60_000), now), true, "경계 포함(<=) 이어야 한다");
  assert.equal(googleTokenExpired(mk(now + 60_001), now), false, "1ms 더 남았는데 만료로 보면 매 호출 갱신한다");
  assert.equal(googleTokenExpired(mk(now - 1), now), true);
});

t("[22] ★ expired: 만료 시각이 없으면 '만료 아님' — 모르는 걸 만료로 단정하지 않는다", () => {
  assert.equal(googleTokenExpired(mk(null), Date.now()), false);
  assert.equal(googleTokenExpired(null, Date.now()), false);
});

// ── 표 23 · 예약 이름 ────────────────────────────────────────────────────────
t("[23] isGoogleServer: 대소문자 무시, 유사 이름은 거부", () => {
  assert.equal(isGoogleServer("google"), true);
  assert.equal(isGoogleServer("GOOGLE"), true);
  assert.equal(isGoogleServer("google-drive"), false, "구 MCP 서버명과 겹치면 콜백이 잘못된 분기를 탄다");
  assert.equal(isGoogleServer(null), false);
});

console.log(`\n${pass} passed`);

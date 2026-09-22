// #4211 Outlook 직결 OAuth — 순수 함수 회귀 잠금(DB·네트워크 불요).
//   실행: npm run build && node dist/org/credentials/microsoft-oauth.test.js
//
//   엣지 표(행마다 테스트 1개) — 전부 «빼먹으면 조용히 망가지는 것»을 겨눈다:
//    M1  인가 URL: common 끝점·code·query·offline_access·Mail/Calendars·prompt=select_account(**consent 금지**)
//    M2  관리자 허용 URL: 기본 organizations(**common 금지**)·지정 테넌트·사용자 동의와 같은 scope
//    M3  오류 분류: 90094·90095·65001·consent_required=admin / 65004·access_denied=declined / 그 밖=other
//    M4  토큰 응답: 만료는 **epoch 초**·id_token 에서 계정·테넌트 / invalid_grant·관리자 필요·토큰 없음은 던진다
//    M5  병합: 새 refresh_token 이 오면 교체(회전), 안 오면 보존 · 계정 표시 보존
//    M6  슬롯: meta 에 토큰 없음·만료 초 단위·개인/회사 판정 · 슬롯 → 설치 왕복
//    M7  범위 판정: 전체 URI·짧은 이름·대소문자·ReadWrite
//    M8  도구 안내: 남의 kind=null · 슬롯 없음=연결 안내 · 모름=막지 않음 · 범위 없음=안내
//    M9  클라이언트 해소: 릴레이면 플랫폼 먼저 · 직결이면 금고 먼저 · 반쪽 env 는 없음
//    M10 릴레이 관리자 허용 주소: /start → /admin-consent + gw
//    M11 교환: form POST · common 토큰 끝점 · secret 은 본문에만
//    M12 id_token 이 깨져 있어도 던지지 않는다(표시용일 뿐)
import assert from "node:assert/strict";
import {
  buildMicrosoftAuthorizeUrl, buildMicrosoftAdminConsentUrl, classifyMicrosoftAuthError, parseMicrosoftTokenResponse,
  mergeMicrosoftTokens, microsoftInstallToSlot, microsoftInstallFromSlot, microsoftScopeCovers, microsoftToolAuthHint,
  resolveMicrosoftOAuthClient, relayAdminConsentUrl, exchangeMicrosoftCode, decodeMicrosoftIdToken,
  MICROSOFT_SCOPE, MICROSOFT_TOKEN_URL, MSA_TENANT_ID, type MicrosoftInstall,
} from "./microsoft-oauth.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const idToken = (claims: Record<string, unknown>): string =>
  `x.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.sig`;
const WORK_TID = "72f988bf-86f1-41af-91ab-2d7cd011db47";

t("M1 인가 URL — common 끝점·code·query·필수 범위, 그리고 prompt=consent 는 **쓰지 않는다**", () => {
  const u = new URL(buildMicrosoftAuthorizeUrl({ clientId: "cid", redirectUri: "https://app.lvly.io/oauth/microsoft/callback", state: "st" }));
  assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "회사·개인 계정을 둘 다 받으려면 common");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("response_mode"), "query", "fragment 면 서버가 code 를 못 읽는다");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.lvly.io/oauth/microsoft/callback");
  assert.equal(u.searchParams.get("state"), "st");
  const scope = (u.searchParams.get("scope") ?? "").split(" ");
  assert.ok(scope.includes("offline_access"), "offline_access 가 없으면 refresh_token 이 안 온다 → 1시간 뒤 전멸");
  assert.ok(scope.includes("https://graph.microsoft.com/Mail.Read"));
  assert.ok(scope.includes("https://graph.microsoft.com/Calendars.Read"));
  assert.ok(!scope.some((s) => /ReadWrite|Send/i.test(s)), "읽기 전용이어야 한다(최소 권한)");
  // ★ 관리자가 조직 전체 허용을 해 둔 회사에서 prompt=consent 는 사용자에게 동의를 다시 강요해 도로 막는다.
  assert.equal(u.searchParams.get("prompt"), "select_account");
});

t("M2 관리자 허용 URL — 기본 organizations(common 은 개인 계정이 관리자 동의를 못 줘 안 된다), 사용자 동의와 같은 범위", () => {
  const u = new URL(buildMicrosoftAdminConsentUrl({ clientId: "cid", redirectUri: "https://app.lvly.io/oauth/microsoft/callback", state: "a" }));
  assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/organizations/v2.0/adminconsent");
  assert.equal(u.searchParams.get("scope"), MICROSOFT_SCOPE, "관리자는 허용했는데 사용자는 또 막히는 어긋남을 막는다 — 같은 목록");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.lvly.io/oauth/microsoft/callback");
  assert.equal(u.searchParams.get("state"), "a");
  const v = new URL(buildMicrosoftAdminConsentUrl({ clientId: "cid", redirectUri: "https://x/cb", state: "a", tenant: WORK_TID }));
  assert.equal(v.pathname, `/${WORK_TID}/v2.0/adminconsent`, "회사를 알면 그 회사로 겨눈다");
  const w = new URL(buildMicrosoftAdminConsentUrl({ clientId: "cid", redirectUri: "https://x/cb", state: "a", tenant: "  " }));
  assert.equal(w.pathname, "/organizations/v2.0/adminconsent", "빈 테넌트는 organizations 로");
});

t("M3 오류 분류 — 관리자 필요 / 사용자 취소 / 그 밖", () => {
  assert.equal(classifyMicrosoftAuthError("access_denied", "AADSTS90094: Admin consent is required."), "admin");
  assert.equal(classifyMicrosoftAuthError("access_denied", "AADSTS90095: request admin approval"), "admin");
  assert.equal(classifyMicrosoftAuthError("invalid_grant", "AADSTS65001: The user or administrator has not consented"), "admin");
  assert.equal(classifyMicrosoftAuthError("consent_required", ""), "admin");
  assert.equal(classifyMicrosoftAuthError("access_denied", "AADSTS65004: User declined to consent"), "declined");
  assert.equal(classifyMicrosoftAuthError("access_denied", "the user canceled"), "declined");
  assert.equal(classifyMicrosoftAuthError("invalid_request", "AADSTS50011: redirect mismatch"), "other");
  assert.equal(classifyMicrosoftAuthError(null, null), "other");
  // 90094 가 설명에 있으면 error 값이 무엇이든 관리자 쪽이다(사람에게 필요한 다음 한 걸음이 그것이다).
  assert.equal(classifyMicrosoftAuthError("server_error", "... AADSTS90094 ..."), "admin");
});

t("M4 토큰 응답 — 만료는 epoch 초, id_token 에서 계정·테넌트, 실패는 던진다", () => {
  const i = parseMicrosoftTokenResponse({
    access_token: "eyJ.at", refresh_token: "0.AR.rt", expires_in: 3599, scope: "Mail.Read Calendars.Read User.Read openid profile email",
    id_token: idToken({ preferred_username: "kim@contoso.com", name: "김철수", tid: WORK_TID }),
  }, 1_700_000_000);
  assert.equal(i.expires_at, 1_700_003_599, "초 단위여야 isTokenExpired(초)와 맞는다 — ms 면 영영 갱신 안 한다");
  assert.equal(i.refresh_token, "0.AR.rt");
  assert.equal(i.email, "kim@contoso.com");
  assert.equal(i.name, "김철수");
  assert.equal(i.tenant_id, WORK_TID);
  assert.throws(() => parseMicrosoftTokenResponse({ error: "invalid_grant", error_description: "AADSTS70008: expired" }), /다시 하세요/);
  assert.throws(() => parseMicrosoftTokenResponse({ error: "invalid_client", error_description: "AADSTS90094: admin" }), /관리자/);
  assert.throws(() => parseMicrosoftTokenResponse({ token_type: "Bearer" }), /access_token/);
  // email 클레임 폴백 — preferred_username 이 없는 계정
  assert.equal(parseMicrosoftTokenResponse({ access_token: "a", id_token: idToken({ email: "me@outlook.com", tid: MSA_TENANT_ID }) }).email, "me@outlook.com");
  // expires_in 이 없으면 만료 모름(null) — 모르는 것을 만료로 단정하지 않는다
  assert.equal(parseMicrosoftTokenResponse({ access_token: "a" }).expires_at, null);
});

const base: MicrosoftInstall = { access_token: "A1", refresh_token: "R1", expires_at: 100, scope: "Mail.Read", email: "kim@contoso.com", name: "김", tenant_id: WORK_TID };

t("M5 병합 — 새 refresh_token 이 오면 교체(회전), 안 오면 보존, 계정 표시는 지킨다", () => {
  const rotated = mergeMicrosoftTokens(base, { ...base, access_token: "A2", refresh_token: "R2", expires_at: 200, email: null, name: null, tenant_id: null });
  assert.equal(rotated.refresh_token, "R2", "Microsoft 가 준 새 refresh_token 을 버리면 옛 것이 회수됐을 때 끊긴다");
  assert.equal(rotated.access_token, "A2");
  assert.equal(rotated.email, "kim@contoso.com", "갱신 응답엔 id_token 이 없을 수 있다 — 표시가 사라지면 안 된다");
  assert.equal(rotated.tenant_id, WORK_TID);
  const kept = mergeMicrosoftTokens(base, { ...base, access_token: "A3", refresh_token: null, scope: "" });
  assert.equal(kept.refresh_token, "R1", "갱신 토큰이 사라지면 1시간 뒤 영구 실패");
  assert.equal(kept.scope, "Mail.Read", "빈 scope 로 덮으면 도구가 «권한 없음»으로 오판한다");
  assert.equal(mergeMicrosoftTokens(null, base).refresh_token, "R1", "처음 연결");
});

t("M6 슬롯 — meta 에 토큰이 없고, 만료는 초, 개인/회사 판정, 왕복", () => {
  const slot = microsoftInstallToSlot(base);
  const metaJson = JSON.stringify(slot.meta);
  assert.ok(!metaJson.includes("A1") && !metaJson.includes("R1"), "meta 는 평문이다 — 토큰이 새면 안 된다");
  assert.equal(slot.meta.expires_at, 100);
  assert.equal(slot.meta.account_type, "work");
  assert.equal(slot.scopeKey, "");
  const blob = JSON.parse(slot.secret) as Record<string, unknown>;
  assert.equal(blob.access_token, "A1");
  assert.equal(blob.refresh_token, "R1");
  assert.equal(microsoftInstallToSlot({ ...base, tenant_id: MSA_TENANT_ID }).meta.account_type, "personal");
  assert.equal(microsoftInstallToSlot({ ...base, tenant_id: null }).meta.account_type, null, "모르면 지어내지 않는다");
  const back = microsoftInstallFromSlot(slot.secret, slot.meta)!;
  assert.deepEqual(back, base, "슬롯 → 설치가 되돌아와야 병합의 prev 가 맞다");
  assert.equal(microsoftInstallFromSlot("not json", {}), null);
  assert.equal(microsoftInstallFromSlot(JSON.stringify({ token_type: "Bearer" }), {}), null);
});

t("M7 범위 판정 — 전체 URI·짧은 이름·대소문자·ReadWrite 모두 받는다", () => {
  assert.ok(microsoftScopeCovers("https://graph.microsoft.com/Mail.Read openid", "mail"));
  assert.ok(microsoftScopeCovers("mail.read", "mail"));
  assert.ok(microsoftScopeCovers("Mail.ReadWrite", "mail"), "더 넓은 권한을 가진 사람이 막히면 안 된다");
  assert.ok(!microsoftScopeCovers("Mail.ReadBasic", "mail"), "ReadBasic 은 본문을 못 읽는다 — 덮지 않는다");
  assert.ok(microsoftScopeCovers("https://graph.microsoft.com/Calendars.Read", "calendar"));
  assert.ok(!microsoftScopeCovers("Mail.Read", "calendar"));
  assert.ok(!microsoftScopeCovers("", "mail"));
});

t("M8 도구 안내 — 남의 kind 는 null · 슬롯 없음은 연결 안내 · 모르면 막지 않음 · 범위가 없으면 다시 연결", () => {
  assert.equal(microsoftToolAuthHint("google_oauth", null), null);
  assert.match(microsoftToolAuthHint("microsoft_oauth", null) ?? "", /Outlook 연결/);
  assert.equal(microsoftToolAuthHint("microsoft_oauth", "", "outlook_mail_search"), null, "범위를 모르면 막지 않는다");
  assert.match(microsoftToolAuthHint("microsoft_oauth", "Calendars.Read", "outlook_mail_search") ?? "", /메일 권한/);
  assert.equal(microsoftToolAuthHint("microsoft_oauth", "Calendars.Read", "outlook_calendar_events"), null);
  assert.equal(microsoftToolAuthHint("microsoft_oauth", "Mail.Read", "outlook_mail_folders"), null);
});

await ta("M9 클라이언트 해소 — 릴레이면 플랫폼 먼저(발급 앱으로만 갱신된다) · 직결이면 금고 먼저 · 반쪽은 없음", async () => {
  const vault = async () => ({ client_id: "vault-id", client_secret: "vault-sec" });
  const none = async () => null;
  const plat = { MICROSOFT_OAUTH_CLIENT_ID: "plat-id", MICROSOFT_OAUTH_CLIENT_SECRET: "plat-sec" };
  const relay = { ...plat, MICROSOFT_OAUTH_RELAY_URL: "https://app.lvly.io/oauth/microsoft/start" };
  assert.equal((await resolveMicrosoftOAuthClient(vault, relay))?.client_id, "plat-id", "릴레이 토큰을 금고 앱으로 갱신하면 invalid_client");
  assert.equal((await resolveMicrosoftOAuthClient(vault, plat))?.client_id, "vault-id", "셀프호스팅은 자기 앱이 먼저");
  assert.equal((await resolveMicrosoftOAuthClient(none, plat))?.client_id, "plat-id");
  assert.equal(await resolveMicrosoftOAuthClient(none, { MICROSOFT_OAUTH_CLIENT_ID: "only-id" }), null, "시크릿 없는 반쪽 env 는 없다");
  assert.equal(await resolveMicrosoftOAuthClient(async () => ({ client_id: "x" }), {}), null, "금고 반쪽도 없다");
  assert.equal(await resolveMicrosoftOAuthClient(none, {}), null, "아무것도 없으면 null — 화면이 «준비 안 됨»을 말할 근거");
  assert.equal((await resolveMicrosoftOAuthClient(async () => { throw new Error("db down"); }, plat))?.client_id, "plat-id", "금고 실패는 플랫폼으로");
});

t("M10 릴레이 관리자 허용 주소 — 같은 CP 의 /admin-consent + 이 게이트웨이 주소", () => {
  const u = new URL(relayAdminConsentUrl("https://app.lvly.io/oauth/microsoft/start", "https://acme.app.lvly.io"));
  assert.equal(u.origin + u.pathname, "https://app.lvly.io/oauth/microsoft/admin-consent");
  assert.equal(u.searchParams.get("gw"), "https://acme.app.lvly.io");
  const v = new URL(relayAdminConsentUrl("https://app.lvly.io/oauth/microsoft/start?x=1", ""));
  assert.equal(v.search, "", "시작점의 쿼리를 물려받지 않는다 · 게이트웨이 주소를 모르면 gw 를 싣지 않는다");
});

await ta("M11 교환 — form POST 로 common 토큰 끝점에, client_secret 은 본문에만", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
  };
  const i = await exchangeMicrosoftCode({ clientId: "cid", clientSecret: "shh", code: "c0de", redirectUri: "https://gw/oauth/callback", fetchFn, nowSec: 10 });
  assert.equal(i.expires_at, 3610);
  assert.equal(calls.length, 1, "배선 — 교환이 실제로 나갔다");
  assert.equal(calls[0].url, MICROSOFT_TOKEN_URL);
  assert.ok(!calls[0].url.includes("shh"), "secret 이 URL 에 실리면 로그에 남는다");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(body.get("client_secret"), "shh");
  assert.equal(body.get("code"), "c0de");
  assert.equal(body.get("redirect_uri"), "https://gw/oauth/callback", "인가 때와 같은 redirect_uri 여야 교환이 통과한다");
});

t("M12 깨진 id_token 은 던지지 않는다 — 표시용일 뿐이다", () => {
  assert.deepEqual(decodeMicrosoftIdToken("garbage"), { email: null, name: null, tenant_id: null });
  assert.deepEqual(decodeMicrosoftIdToken("a.!!!notb64json.c"), { email: null, name: null, tenant_id: null });
  assert.deepEqual(decodeMicrosoftIdToken(null), { email: null, name: null, tenant_id: null });
  assert.equal(parseMicrosoftTokenResponse({ access_token: "a", id_token: "x.y" }).email, null);
});

console.log(`\nmicrosoft-oauth tests: ${pass} passed`);

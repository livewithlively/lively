// 매니지드 로그아웃이 CP 세션까지 끝내는가 (#2536) — 웹 모듈 계약 검증.
//
// 증상(장원준 2026-09-02): 매니지드에서 로그아웃 → 로그인 창 1~2초 → 자동 재로그인. 코어 로그아웃은 테넌트 세션만 끝내고
//  게이트를 띄웠고, 게이트는 CP 로 튕기고, CP 는 살아 있는 자기 세션(lvly_sid)으로 묻지 않고 재입장시켰다.
//
// 사양·엣지 표(spec-failfirst):
//  T1 CP 주소가 있고 호스트가 다르면 → CP 의 /auth/logout 으로, 돌아올 자리(to=현재 주소)를 들고 간다
//  T2 CP 주소가 서브패스(https://host/cp)면 그 아래 /auth/logout 이다 — 접두사를 잃으면 다른 문을 두드린다(#1541 계열)
//  T3 CP 주소가 없다(셀프호스팅) → null(종전 게이트)
//  T4 CP 주소가 같은 호스트다(리다이렉트 루프 방지 규칙과 동일) → null
//  T5 깨진 주소 → null(던지지 않는다 — 로그아웃은 끝까지 가야 한다)
//  C1 core.ts 의 logout 은 이 문을 지나야 한다 — 게이트만 띄우면 CP 가 도로 로그인시킨다
//  C2 main.ts(클래식 셸)에 **자기 로그아웃 경로가 따로 있으면 안 된다** — 문이 둘이면 하나만 고쳐지고 다른 하나는 도로 재로그인된다
//
// 웹 모듈은 src 테스트가 import 할 수 없어(별도 tsconfig·번들) 소스를 그 자리에서 transpile 해 data: URL 로 import 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");

async function loadPure<T>(rel: string): Promise<T> {
  const js = ts.transpileModule(readWeb(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as T;
}

test("T1 매니지드 — CP 의 로그아웃 문으로, 돌아올 자리를 들고", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string | null | undefined, here: string) => string | null }>("lib/logout-target.ts");
  const here = "https://acme.app.lvly.io/ui/#/s/box-a-1";
  const got = logoutRedirectTarget("https://app.lvly.io", here);
  assert.ok(got, "🔴 CP 주소가 있는데 문이 없다 — 게이트만 띄우면 CP 세션으로 도로 로그인된다");
  const u = new URL(got!);
  assert.equal(u.origin + u.pathname, "https://app.lvly.io/auth/logout");
  assert.equal(u.searchParams.get("to"), here, "재로그인 뒤 같은 자리로 돌아와야 한다");
});

test("T2 서브패스 CP — 접두사를 보존한다", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string, here: string) => string | null }>("lib/logout-target.ts");
  const got = logoutRedirectTarget("https://dev.lvly.io/preview/p1/", "https://acme.app.lvly.io/ui/");
  assert.ok(got);
  assert.equal(new URL(got!).pathname, "/preview/p1/auth/logout", "🔴 서브패스가 날아가면 다른 게이트웨이의 문을 두드린다");
});

test("T3·T4·T5 셀프호스팅·같은 호스트·깨진 주소 → null(종전 게이트)", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string | null | undefined, here: string) => string | null }>("lib/logout-target.ts");
  const here = "https://olddev.lvly.io/ui/";
  assert.equal(logoutRedirectTarget(null, here), null, "T3 셀프호스팅");
  assert.equal(logoutRedirectTarget("", here), null, "T3 빈 값");
  assert.equal(logoutRedirectTarget("https://olddev.lvly.io", here), null, "🔴 T4 같은 호스트로 보내면 자기 자신에게 튕겨 루프다");
  assert.equal(logoutRedirectTarget("nope://[", here), null, "T5 깨진 주소는 던지지 않는다");
});

test("C1 core.ts 의 logout 은 CP 로그아웃 문을 지난다", () => {
  const core = readWeb("core.ts");
  const fn = core.slice(core.indexOf("async function logout("));
  assert.ok(fn.includes("logoutRedirectTarget("), "🔴 logout 이 게이트만 띄운다 — 매니지드에선 CP 세션으로 자동 재로그인된다");
  assert.ok(/location\.replace\(/.test(fn), "문이 있으면 그 문으로 **최상위 이동**해야 한다(fetch 로는 남의 오리진 쿠키를 못 지운다)");
});

test("C2 클래식 셸(main.ts)은 자기 로그아웃 경로를 갖지 않는다 — 문은 하나(core.logout)", () => {
  const main = readWeb("main.ts");
  assert.ok(!main.includes("fetch(apiUrl('/api/ui/logout')"), "🔴 main.ts 에 별도 로그아웃 fetch 가 있다 — 그 경로는 CP 세션을 남긴다");
  assert.ok(/\blogout\(\)/.test(main), "클래식 셸 버튼은 core 의 logout() 을 부른다");
});

// ── SSO 로그아웃 문 — 서버가 {ok:true, redirect} 로 IdP 로그아웃 주소를 주면 그리로 간다 ──
//  S1 https 절대주소면 그대로 · S2 없음·종전 응답·비객체 → null · S3 javascript:·http: 등 다른 스킴·깨진 값 → null
//  C3 core.ts 의 logout 은 응답의 redirect 를 읽어 CP 문보다 먼저 최상위 이동한다 — 데스크톱 앱 창에선 건너뛴다
test("S1 IdP 로그아웃 주소가 오면 그대로 간다", async () => {
  const { ssoLogoutTarget } = await loadPure<{ ssoLogoutTarget: (b: unknown) => string | null }>("lib/logout-target.ts");
  const idp = "https://sso.example/realms/acme/protocol/openid-connect/logout?client_id=lively&post_logout_redirect_uri=https%3A%2F%2Fgw.example%2Fui%2F";
  assert.equal(ssoLogoutTarget({ ok: true, redirect: idp }), idp);
});

test("S2·S3 종전 응답·비정상 값 → null(종전 흐름)", async () => {
  const { ssoLogoutTarget } = await loadPure<{ ssoLogoutTarget: (b: unknown) => string | null }>("lib/logout-target.ts");
  assert.equal(ssoLogoutTarget({ ok: true }), null, "S2 비 SSO 로그인의 종전 응답");
  assert.equal(ssoLogoutTarget(null), null);
  assert.equal(ssoLogoutTarget("https://x.example"), null, "응답 본문이 객체가 아니다");
  assert.equal(ssoLogoutTarget({ ok: true, redirect: "" }), null);
  assert.equal(ssoLogoutTarget({ ok: true, redirect: 42 }), null);
  assert.equal(ssoLogoutTarget({ ok: true, redirect: "javascript:alert(1)" }), null, "🔴 S3 스크립트 스킴으로 이동하면 안 된다");
  assert.equal(ssoLogoutTarget({ ok: true, redirect: "/ui/" }), null, "상대 경로는 IdP 문이 아니다");
  assert.equal(ssoLogoutTarget({ ok: true, redirect: "http://sso.example/logout?id_token_hint=x" }), null,
    "🔴 S3 평문 http 로 id_token 을 싣고 가면 안 된다");
});

test("C3 core.ts 의 logout 은 서버가 준 IdP 문으로 CP 문보다 먼저 이동한다", () => {
  const core = readWeb("core.ts");
  const fn = core.slice(core.indexOf("async function logout("));
  const sso = fn.indexOf("ssoLogoutTarget(");
  const cp = fn.indexOf("logoutRedirectTarget(");
  assert.ok(sso >= 0, "🔴 logout 이 응답의 redirect 를 안 본다 — SSO 세션이 살아 남아 다음 로그인이 묻지 않고 들어온다");
  assert.ok(sso < cp, "IdP 문은 CP 문·게이트보다 먼저 결정돼야 한다");
  assert.match(fn, /if \(ssoDoor && !desk\) \{ location\.replace\(ssoDoor\); return; \}/,
    "데스크톱 앱 창은 다른 출처 이동을 시스템 브라우저로 넘긴다 — 앱 창에선 IdP 문으로 가지 않는다");
});

// ── 탈퇴 뒤 로그아웃(#5009) — 워크스페이스가 지워진 뒤에도 CP 로그인·가입 화면으로 나가야 한다 ──
//  증상(원준 2026-10-27): 탈퇴 → «Lively 회사 계정으로 로그인하세요. 로그아웃되었습니다.» 게이트가 지워진 주소 위에 남음.
//   로그아웃 순간에 CP 주소를 물으니 이미 지워진 워크스페이스가 404 → null → 셀프호스팅 게이트.
//  T6 returnTo=null → CP 문에 to 를 싣지 않는다(CP 는 첫 화면으로) · 기본값은 종전대로 to=here
//  C4 core.ts 는 CP 주소를 페이지가 뜰 때 미리 묻는다(로그아웃 순간이 아니라)
//  C5 탈퇴 완료는 logout 에 accountGone 을 넘기고, logout 은 그때 돌아올 자리를 비운다
test("T6 돌아올 자리 없음 — CP 문에 to 를 싣지 않는다", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string, here: string, to?: string | null) => string | null }>("lib/logout-target.ts");
  const here = "https://acme.app.lvly.io/ui/#/s/box-a-1";
  const gone = new URL(logoutRedirectTarget("https://app.lvly.io", here, null)!);
  assert.equal(gone.origin + gone.pathname, "https://app.lvly.io/auth/logout");
  assert.equal(gone.searchParams.get("to"), null, "🔴 지워진 워크스페이스로 돌려보내면 «워크스페이스를 찾을 수 없습니다» 로 떨어진다");
  assert.equal(new URL(logoutRedirectTarget("https://app.lvly.io", here)!).searchParams.get("to"), here, "기본값은 종전대로");
});

test("C4 core.ts 는 CP 주소를 페이지가 뜰 때 미리 묻는다", () => {
  const core = readWeb("core.ts");
  assert.match(core, /^void loginRedirectUrl\(\);$/m, "🔴 로그아웃 순간에만 물으면 탈퇴로 지워진 워크스페이스가 404 를 주고 죽은 게이트가 남는다");
});

test("C5 탈퇴 완료 → logout(accountGone) → 돌아올 자리 없이 CP 로", () => {
  const modal = readWeb("v2/me-modal.ts");
  assert.match(modal, /logout\(undefined, \{ accountGone: true \}\)/, "🔴 탈퇴 뒤 로그아웃이 지워진 자리를 to 로 들고 간다");
  const fn = readWeb("core.ts").slice(readWeb("core.ts").indexOf("async function logout("));
  assert.match(fn, /location\.href, opts\?\.accountGone \? null : location\.href\)/);
});

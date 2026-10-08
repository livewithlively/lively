// 로그아웃 응답의 redirect 판단(코어) — IdP 로 로그인한 세션만 IdP 로그아웃 문으로 보낸다.
//  사양·엣지 표:
//   R1 IdP 세션 → EE 가 만든 주소를 그대로, post_logout_redirect_uri 는 공개 주소의 /ui/
//   R2 IdP 가 아닌 세션(비밀번호·CP 교환, auth_method NULL) → null, EE 를 부르지 않는다
//   R3 이미 끊긴 세션(revokeSession=null) → null
//   R4 EE 미탑재(sso 훅 없음) → null
//   R5 공개 주소 미확정 → null · R6 EE 가 던지면 → null(로그아웃은 끝까지 간다)
//   W1 web.ts 의 로그아웃 라우트가 회수 결과를 이 판단에 넘기고 redirect 를 응답에 싣는다(배선)
//   W2 revokeSession 은 회수와 함께 보관 토큰을 지운다 · W3 스키마가 두 컬럼을 추가한다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ssoLogoutRedirect } from "./logout-redirect.js";

type Call = { session: { authMethod: string | null; ssoIdTokenEnc: string | null }; back: string };
function fakeSso(out: string | null | Error): { hooks: { ssoLogoutUrl: (s: Call["session"], b: string) => Promise<string | null> }; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    hooks: {
      ssoLogoutUrl: async (session, back) => {
        calls.push({ session, back });
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}
const base = (v: string | null) => async (): Promise<string | null> => v;
const IDP = "https://sso.example/logout?client_id=lively";

test("R1 IdP 세션 → EE 주소, 돌아올 자리는 공개 주소의 /ui/", async () => {
  const f = fakeSso(IDP);
  const ended = { authMethod: "oidc", ssoIdTokenEnc: "gcm$x" };
  assert.equal(await ssoLogoutRedirect(ended, base("https://gw.example/"), f.hooks), IDP);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].session, ended, "보관 토큰을 EE 에 그대로 넘겨야 id_token_hint 가 붙는다");
  assert.equal(f.calls[0].back, "https://gw.example/ui/");
});

test("R2 IdP 가 아닌 세션 → null, EE 를 부르지 않는다", async () => {
  for (const authMethod of [null, "password"]) {
    const f = fakeSso(IDP);
    assert.equal(await ssoLogoutRedirect({ authMethod, ssoIdTokenEnc: null }, base("https://gw.example"), f.hooks), null);
    assert.equal(f.calls.length, 0, "비밀번호 로그인의 로그아웃이 IdP 로 튕긴다");
  }
});

test("R3·R4 이미 끊긴 세션·EE 미탑재 → null", async () => {
  const f = fakeSso(IDP);
  assert.equal(await ssoLogoutRedirect(null, base("https://gw.example"), f.hooks), null);
  assert.equal(f.calls.length, 0);
  assert.equal(await ssoLogoutRedirect({ authMethod: "oidc", ssoIdTokenEnc: null }, base("https://gw.example"), undefined), null);
});

test("R5·R6 공개 주소 미확정·EE 실패 → null", async () => {
  const f = fakeSso(IDP);
  assert.equal(await ssoLogoutRedirect({ authMethod: "oidc", ssoIdTokenEnc: null }, base(null), f.hooks), null);
  assert.equal(f.calls.length, 0);
  const g = fakeSso(new Error("boom"));
  assert.equal(await ssoLogoutRedirect({ authMethod: "oidc", ssoIdTokenEnc: null }, base("https://gw.example"), g.hooks), null);
});

// DB·express 바운드라 라우트와 SQL 은 소스에서 못박는다(nonhuman-login.test.ts 선례).
test("W1 로그아웃 라우트가 회수 결과로 redirect 를 정해 응답에 싣는다", () => {
  const web = readFileSync("src/web.ts", "utf8");
  const at = web.indexOf('app.post("/api/ui/logout"');
  assert.ok(at >= 0);
  const route = web.slice(at, web.indexOf("}));", at));
  assert.match(route, /const ended = sid \? await revokeSession\(sid\) : null/);
  assert.match(route, /ssoLogoutRedirect\(ended, \(\) => gatewayUrlForRequest\(req\), ee\(\)\.sso\)/);
  assert.match(route, /res\.json\(redirect \? \{ ok: true, redirect \} : \{ ok: true \}\)/, "redirect 가 없으면 종전 응답 그대로여야 한다");
});

test("W2 revokeSession 은 회수와 함께 보관 토큰을 지우고 옛 로그인 방식을 돌려준다", () => {
  const src = readFileSync("src/auth/sessions.ts", "utf8");
  const body = src.slice(src.indexOf("export async function revokeSession("));
  assert.match(body, /SET revoked_at=now\(\), sso_id_token_enc=NULL/);
  assert.match(body, /RETURNING old\.auth_method, old\.sso_id_token_enc/, "UPDATE 뒤 값(NULL)을 돌려주면 힌트가 영영 안 붙는다");
});

test("W3 web_session 에 로그인 방식·보관 토큰 컬럼을 멱등으로 추가한다", () => {
  const src = readFileSync("src/org/schema/member-auth.ts", "utf8");
  assert.match(src, /ALTER TABLE web_session ADD COLUMN IF NOT EXISTS auth_method TEXT/);
  assert.match(src, /ALTER TABLE web_session ADD COLUMN IF NOT EXISTS sso_id_token_enc TEXT/);
});

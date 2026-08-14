// http_proxy 의 per-member OAuth 자격 해소 테스트 (#1654). 사양·엣지 표 = spec-1654 표 H/I/J/K.
//
//  회귀 대상 ①: **묶음을 통째로 헤더에 싣던 것.** OAuth 는 토큰 묶음(JSON)을 한 슬롯에 저장하는데 http_proxy 는
//   정적 토큰 전제라 그대로 실었다 → `Authorization: Bearer {"access_token":…}` → 상류가 전부 거부.
//  회귀 대상 ②: **정적 토큰 경로 무회귀**(H1·H3·H4) — 이 변경이 기존 커넥터(gitlab PAT 등)를 깨면 안 된다.
//  회귀 대상 ③: **갱신 결과를 금고에 다시 쓰지 않던 것**(J1) — 안 쓰면 다음 호출이 또 만료 토큰을 쓴다.
//  회귀 대상 ④: **구글이 refresh 응답에 갱신 토큰을 안 준다**(J2) — 덮어쓰면 갱신 토큰이 사라져 영구 실패한다.
//  회귀 대상 ⑤: **갱신 불가를 조용히 넘기지 않는다**(J3·J6·J7) — 옛 토큰으로 진행하면 상류 401 이 되어
//   '자격 만료'인지 '권한 변경'인지 구분이 안 된다. 그 혼동이 이번 구글 403 진단을 몇 달 늦춘 것과 같은 종류다.
//
//  네트워크·DB 는 deps 주입으로 갈아끼운다 — **호출 0건**(부작용 부재)까지 단언하려면 스텁이 필요하다.
import assert from "node:assert/strict";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  isTokenExpired, mergeRefreshedTokens, resolveProxyBearer, EXPIRY_SKEW_SEC,
  type ProxyAuthDeps, type OAuthClientInfo,
} from "./oauth-proxy-auth.js";
import type { MemberSecretResolved } from "./member-secret-store.js";

let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const NOW = 1_770_000_000; // 고정 기준시각(테스트는 실시간에 의존하지 않는다)
const vault = (secret: string, meta: Record<string, unknown> = {}): MemberSecretResolved =>
  ({ owner: "member:sh-lee", kind: "google_drive_oauth", scope_key: "", secret, meta });
const blob = (t: Partial<OAuthTokens>): string => JSON.stringify(t);

// 스텁 묶음 — 무엇이 실제로 불렸는지(부작용)를 기록한다. 아무것도 불리면 안 되는 행에서 이게 관측 장치다.
function spy(over: Partial<ProxyAuthDeps> = {}): ProxyAuthDeps & {
  refreshCalls: Array<{ url: string; form: Record<string, string> }>;
  persisted: Array<{ owner: string; kind: string; scopeKey: string; tokens: OAuthTokens }>;
  clientCalls: string[];
} {
  const refreshCalls: Array<{ url: string; form: Record<string, string> }> = [];
  const persisted: Array<{ owner: string; kind: string; scopeKey: string; tokens: OAuthTokens }> = [];
  const clientCalls: string[] = [];
  return {
    refreshCalls, persisted, clientCalls,
    nowSec: () => NOW,
    tokenUrlOf: () => "https://oauth2.googleapis.com/token",
    loadClient: async (k: string): Promise<OAuthClientInfo | null> => { clientCalls.push(k); return { client_id: "cid-123", client_secret: "csecret" }; },
    postRefresh: async (url: string, form: URLSearchParams) => {
      refreshCalls.push({ url, form: Object.fromEntries(form) });
      return { status: 200, ok: true, text: JSON.stringify({ access_token: "ya29.NEW", expires_in: 3599, token_type: "Bearer" }) };
    },
    persist: async (owner: string, kind: string, scopeKey: string, tokens: OAuthTokens) => { persisted.push({ owner, kind, scopeKey, tokens }); },
    ...over,
  };
}

// ── H. 금고 값 해석 ──
await ta("H1 정적 토큰은 그대로 실린다(무회귀)", async () => {
  const d = spy();
  assert.equal(await resolveProxyBearer(vault("glpat-STATIC-123"), "gitlab_pat", d), "glpat-STATIC-123");
  assert.equal(d.refreshCalls.length, 0, "정적 토큰인데 갱신을 시도했다");
});

await ta("H2 OAuth 묶음이면 access token 만 실린다", async () => {
  const secret = blob({ access_token: "ya29.LIVE", refresh_token: "1//RT", token_type: "Bearer" });
  const got = await resolveProxyBearer(vault(secret, { expires_at: NOW + 3600 }), "google_drive_oauth", spy());
  assert.equal(got, "ya29.LIVE");
  assert.ok(!got.includes("refresh_token"), "묶음이 통째로 실렸다 — 상류가 Bearer {json} 을 받는다");
});

await ta("H3 JSON 이지만 access token 필드가 없으면 정적으로 취급", async () => {
  const secret = JSON.stringify({ note: "이건 토큰 묶음이 아니다" });
  assert.equal(await resolveProxyBearer(vault(secret), "some_kind", spy()), secret);
});

await ta("H4 깨진 JSON 은 정적으로 취급", async () => {
  assert.equal(await resolveProxyBearer(vault("{not-json"), "some_kind", spy()), "{not-json");
});

await ta("H5 묶음인데 access token 이 비어 있으면 실패(빈 Bearer 금지)", async () => {
  const secret = blob({ access_token: "", refresh_token: "1//RT" });
  await assert.rejects(() => resolveProxyBearer(vault(secret, { expires_at: NOW + 3600 }), "google_drive_oauth", spy()));
});

// ── I. 만료 판정 ──
t("I1 expires_at 이 없으면 만료 아님(판정 불가 → 보수적)", () => {
  assert.equal(isTokenExpired({}, NOW), false);
  assert.equal(isTokenExpired(undefined, NOW), false);
});
t("I2 충분히 미래면 만료 아님", () => {
  assert.equal(isTokenExpired({ expires_at: NOW + 3600 }, NOW), false);
});
t("I3 과거면 만료", () => {
  assert.equal(isTokenExpired({ expires_at: NOW - 1 }, NOW), true);
});
t("I4 여유(60초) 안에 들면 만료로 본다 — 호출 도중 만료 방지", () => {
  assert.equal(isTokenExpired({ expires_at: NOW + 30 }, NOW), true);
});
t("I5 경계 — 여유 정확히는 만료, 여유+1 은 유효", () => {
  assert.equal(isTokenExpired({ expires_at: NOW + EXPIRY_SKEW_SEC }, NOW), true);
  assert.equal(isTokenExpired({ expires_at: NOW + EXPIRY_SKEW_SEC + 1 }, NOW), false);
});
t("I6 숫자가 아니면 만료 아님", () => {
  assert.equal(isTokenExpired({ expires_at: "2026-01-01" }, NOW), false);
  assert.equal(isTokenExpired({ expires_at: null }, NOW), false);
  assert.equal(isTokenExpired({ expires_at: Number.NaN }, NOW), false);
});

// ── J. 갱신 동작 ──
await ta("J1 만료면 갱신해서 쓰고 — 금고에 다시 쓴다", async () => {
  const d = spy();
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//RT", token_type: "Bearer" });
  const got = await resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d);
  assert.equal(got, "ya29.NEW", "갱신된 토큰이 실리지 않았다");
  assert.equal(d.refreshCalls.length, 1);
  assert.equal(d.refreshCalls[0].form.grant_type, "refresh_token");
  assert.equal(d.refreshCalls[0].form.refresh_token, "1//RT");
  assert.equal(d.refreshCalls[0].form.client_id, "cid-123");
  assert.equal(d.persisted.length, 1, "금고에 안 썼다 — 다음 호출이 또 만료 토큰을 쓴다");
  assert.equal(d.persisted[0].tokens.access_token, "ya29.NEW");
  assert.equal(d.persisted[0].owner, "member:sh-lee", "다른 소유자 슬롯에 썼다");
  assert.equal(d.persisted[0].scopeKey, "");
});

await ta("J2 갱신 응답에 갱신 토큰이 없으면(구글) 기존 것을 보존해 저장", async () => {
  const d = spy({
    postRefresh: async () => ({ status: 200, ok: true, text: JSON.stringify({ access_token: "ya29.NEW", expires_in: 3599 }) }),
  });
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//KEEPME", token_type: "Bearer" });
  await resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d);
  assert.equal(d.persisted[0].tokens.refresh_token, "1//KEEPME", "갱신 토큰이 사라졌다 — 1시간 뒤 영구 실패한다");
});

await ta("J3 갱신 토큰이 없으면 실패하고 금고를 건드리지 않는다", async () => {
  const d = spy();
  const secret = blob({ access_token: "ya29.OLD" }); // access_type=offline 픽스 이전 연결분
  await assert.rejects(() => resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d));
  assert.equal(d.refreshCalls.length, 0);
  assert.equal(d.persisted.length, 0, "실패했는데 금고를 덮어썼다");
});

await ta("J4 갱신 요청이 HTTP 실패하면 실패 — 응답 본문이 통째로 새지 않는다", async () => {
  const leak = "x".repeat(5_000);
  const d = spy({ postRefresh: async () => ({ status: 400, ok: false, text: `{"error":"invalid_grant","detail":"${leak}"}` }) });
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//RT" });
  await assert.rejects(
    () => resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d),
    (err: Error) => {
      assert.ok(err.message.includes("invalid_grant"), "진단 단서가 사라졌다");
      assert.ok(err.message.length < 500, `본문이 통째로 실렸다(len=${err.message.length})`);
      return true;
    },
  );
  assert.equal(d.persisted.length, 0);
});

await ta("J5 갱신 응답에 access token 이 없으면 실패", async () => {
  const d = spy({ postRefresh: async () => ({ status: 200, ok: true, text: JSON.stringify({ expires_in: 3599 }) }) });
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//RT" });
  await assert.rejects(() => resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d));
  assert.equal(d.persisted.length, 0);
});

await ta("J6 OAuth 클라이언트 정보가 없으면 갱신 요청을 보내지 않고 실패", async () => {
  const d = spy({ loadClient: async () => null });
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//RT" });
  await assert.rejects(() => resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "google_drive_oauth", d));
  assert.equal(d.refreshCalls.length, 0, "client_id 없이 토큰 엔드포인트를 때렸다");
});

await ta("J7 토큰 발급처를 모르는 auth_kind 면 갱신 요청을 보내지 않고 실패", async () => {
  const d = spy({ tokenUrlOf: () => undefined });
  const secret = blob({ access_token: "ya29.OLD", refresh_token: "1//RT" });
  await assert.rejects(() => resolveProxyBearer(vault(secret, { expires_at: NOW - 10 }), "unknown_oauth", d));
  assert.equal(d.refreshCalls.length, 0);
  assert.equal(d.clientCalls.length, 0, "발급처도 모르는데 클라이언트 정보를 읽었다");
});

await ta("J8 만료가 아니면 갱신도 금고 쓰기도 하지 않는다", async () => {
  const d = spy();
  const secret = blob({ access_token: "ya29.LIVE", refresh_token: "1//RT" });
  assert.equal(await resolveProxyBearer(vault(secret, { expires_at: NOW + 3600 }), "google_drive_oauth", d), "ya29.LIVE");
  assert.equal(d.refreshCalls.length, 0, "멀쩡한 토큰으로 갱신 왕복을 돌았다");
  assert.equal(d.persisted.length, 0);
});

// ── K. 병합(무엇을 저장하나) ──
t("K1 병합 — 상류가 준 값만 얹고 안 준 필드는 지킨다", () => {
  const prev = { access_token: "OLD", refresh_token: "RT", token_type: "Bearer", scope: "drive.readonly" } as OAuthTokens;
  const merged = mergeRefreshedTokens(prev, { access_token: "NEW", expires_in: 3599 });
  assert.equal(merged.access_token, "NEW");
  assert.equal(merged.refresh_token, "RT");
  assert.equal(merged.scope, "drive.readonly");
});
t("K2 병합 — 상류가 새 갱신 토큰을 주면 그것으로 교체(회전 지원)", () => {
  const prev = { access_token: "OLD", refresh_token: "RT-OLD" } as OAuthTokens;
  assert.equal(mergeRefreshedTokens(prev, { access_token: "NEW", refresh_token: "RT-NEW" }).refresh_token, "RT-NEW");
});

console.log(`\n${pass} passed`);

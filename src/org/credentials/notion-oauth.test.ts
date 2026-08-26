// 노션 공개 통합 OAuth 직결(#1881 N2) — 인가 URL·교환 응답 파싱·금고 슬롯 모양. 순수(네트워크 불요).
//  실행: npm run build && node dist/org/credentials/notion-oauth.test.js
import assert from "node:assert/strict";
import {
  buildNotionAuthorizeUrl, parseNotionTokenResponse, notionInstallToSlot, exchangeNotionCode, refreshNotionToken,
  isNotionPublicServer, NOTION_PUBLIC_KIND, NOTION_PUBLIC_SERVER, NOTION_TOKEN_URL,
} from "./notion-oauth.js";
import { decodeTokenBlob } from "./oauth-broker.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const FULL = {
  access_token: "ntn_access_1", token_type: "bearer", bot_id: "b0t-id-1",
  workspace_id: "ws-1111", workspace_name: "라이블리", workspace_icon: "https://img.example/x.png",
  owner: { type: "user", user: { object: "user", id: "u-yoon", name: "윤상민", type: "person" } },
  duplicated_template_id: null, request_id: "req-1", refresh_token: "ntn_refresh_1",
};

await t("N10 isNotionPublicServer — notion-public 만(대소문자 무시), MCP 행 이름(notion)은 아님", () => {
  assert.equal(isNotionPublicServer(NOTION_PUBLIC_SERVER), true);
  assert.equal(isNotionPublicServer("Notion-Public"), true);
  assert.equal(isNotionPublicServer("notion"), false);
  assert.equal(isNotionPublicServer(null), false);
  assert.equal(NOTION_PUBLIC_KIND, "notion_public");
});

await t("N1 인가 URL — api.notion.com/v1/oauth/authorize + owner=user·response_type=code·state (scope 파라미터 없음)", () => {
  const u = new URL(buildNotionAuthorizeUrl({ clientId: "cid-1", redirectUri: "https://gw.example/oauth/callback", state: "st.sig" }));
  assert.equal(u.hostname, "api.notion.com");
  assert.equal(u.pathname, "/v1/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "cid-1");
  assert.equal(u.searchParams.get("owner"), "user");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://gw.example/oauth/callback");
  assert.equal(u.searchParams.get("state"), "st.sig");
  assert.equal(u.searchParams.get("scope"), null); // 범위는 노션 동의 화면의 페이지 선택이 정한다
});

await t("N2 정상 응답 — 토큰·refresh·워크스페이스·오너를 전부 뽑는다", () => {
  const i = parseNotionTokenResponse(FULL);
  assert.equal(i.access_token, "ntn_access_1");
  assert.equal(i.refresh_token, "ntn_refresh_1");
  assert.equal(i.workspace.id, "ws-1111");
  assert.equal(i.workspace.name, "라이블리");
  assert.equal(i.owner_user?.id, "u-yoon");
});

await t("N3 error 응답은 예외 — 노션 error 코드·설명이 메시지에 실린다", () => {
  assert.throws(() => parseNotionTokenResponse({ error: "invalid_grant", error_description: "Code expired" }), /invalid_grant.*Code expired/);
});

await t("N4 access_token 없으면 예외 · workspace_id 없으면 예외(슬롯 키 부재)", () => {
  assert.throws(() => parseNotionTokenResponse({}), /access_token/);
  const { workspace_id: _drop, ...noWs } = FULL;
  void _drop;
  assert.throws(() => parseNotionTokenResponse(noWs), /workspace_id/);
});

await t("N5 refresh_token 이 null(옛 연결)이어도 연결은 성립 — 블롭에 refresh 없음", () => {
  const i = parseNotionTokenResponse({ ...FULL, refresh_token: null });
  assert.equal(i.refresh_token, null);
  const slot = notionInstallToSlot(i);
  const blob = decodeTokenBlob(slot.secret);
  assert.equal(blob?.access_token, "ntn_access_1");
  assert.equal((blob as Record<string, unknown> | null)?.refresh_token, undefined);
});

await t("N6 슬롯 — scope_key=workspace_id, 블롭은 브로커 코덱으로 복원, refresh 는 블롭에만(평문 meta 금지)", () => {
  const slot = notionInstallToSlot(parseNotionTokenResponse(FULL));
  assert.equal(slot.scopeKey, "ws-1111");
  const blob = decodeTokenBlob(slot.secret);
  assert.equal(blob?.access_token, "ntn_access_1");
  assert.equal(blob?.refresh_token, "ntn_refresh_1");
  assert.equal(slot.meta.workspace_name, "라이블리");
  assert.equal(slot.meta.owner_user_id, "u-yoon");
  assert.equal(slot.meta.via, "notion_public_oauth");
  const metaJson = JSON.stringify(slot.meta);
  assert.ok(!metaJson.includes("ntn_access_1") && !metaJson.includes("ntn_refresh_1"), "meta 에 토큰이 새면 안 된다(평문 저장)");
});

await t("N7 교환 — Basic(client_id:client_secret) + JSON body(grant_type=authorization_code·code·redirect_uri)", async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify(FULL), { status: 200, headers: { "content-type": "application/json" } });
  };
  const i = await exchangeNotionCode({ clientId: "cid-1", clientSecret: "sec-1", code: "code-1", redirectUri: "https://gw.example/oauth/callback", fetchFn });
  assert.equal(i.access_token, "ntn_access_1");
  const s = seen as unknown as { url: string; init?: RequestInit };
  assert.equal(s.url, NOTION_TOKEN_URL);
  const h = s.init?.headers as Record<string, string>;
  assert.equal(h.authorization, `Basic ${Buffer.from("cid-1:sec-1").toString("base64")}`);
  const body = JSON.parse(String(s.init?.body));
  assert.deepEqual(body, { grant_type: "authorization_code", code: "code-1", redirect_uri: "https://gw.example/oauth/callback" });
});

await t("N8 갱신 — grant_type=refresh_token, 응답은 교환과 같은 파서(회전된 새 쌍)", async () => {
  let body: Record<string, unknown> = {};
  const fetchFn = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ...FULL, access_token: "ntn_access_2", refresh_token: "ntn_refresh_2" }), { status: 200 });
  };
  const i = await refreshNotionToken({ clientId: "cid-1", clientSecret: "sec-1", refreshToken: "ntn_refresh_1", fetchFn });
  assert.deepEqual(body, { grant_type: "refresh_token", refresh_token: "ntn_refresh_1" });
  assert.equal(i.access_token, "ntn_access_2");
  assert.equal(i.refresh_token, "ntn_refresh_2");
});

await t("N9 비-JSON 응답(HTTP 502 등)은 상태코드가 실린 예외", async () => {
  const fetchFn = async (): Promise<Response> => new Response("bad gateway", { status: 502 });
  await assert.rejects(
    exchangeNotionCode({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://gw/cb", fetchFn }),
    /502/);
});

console.log(`\n${pass} tests passed (notion-oauth)`);

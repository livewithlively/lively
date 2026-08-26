// 커넥터 카탈로그 OAuth scope 결정(#746) 순수 단위 체크 — DB/네트워크 불요.
// 실행: npm run build && node dist/org/delivery/mcp-server-presets.test.js
//  커버: Slack scope(부분집합·필수포함·민감제외) / Google gmail·drive·calendar(URL형식·readonly 최소권한) /
//        Notion·Linear·미등록·null·빈문자열 undefined / 불변식(DCR 상류=scope없음, 비-DCR=scope있음).
import assert from "node:assert/strict";
import { MCP_SERVER_PRESETS, presetOAuthScope } from "./mcp-server-presets.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 레인(#1881) — mode 미지정은 종전대로 proxy(게이트웨이 대리). client 는 멤버 클라 직접등록이라 규칙이 다르다. */
const isProxy = (c: { mode?: "proxy" | "client" }): boolean => (c.mode ?? "proxy") === "proxy";

// Slack 이 실제 지원하는 scope (실측 26개, 사양 참고표) — 이 밖 토큰이 나오면 오타/버그.
const SLACK_SUPPORTED = new Set([
  "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
  "search:read.files", "search:read.users", "chat:write", "channels:history",
  "groups:history", "mpim:history", "im:history", "canvases:read", "canvases:write",
  "users:read", "users:read.email", "reactions:write", "reactions:read", "emoji:read",
  "files:read", "channels:write", "groups:write", "im:write", "mpim:write",
  "channels:read", "groups:read", "mpim:read", "im:read", // im:read — #1226 DM 목록(users.conversations)용, 프리셋에 실제 추가됨
]);
const scopeTokens = (s: string | undefined): string[] => (s ?? "").split(/\s+/).filter(Boolean);

// ── Slack (slack_oauth) — scope 를 요구하는 상류 ──
t("presetOAuthScope: slack_oauth → 비어있지 않은 scope 문자열", () => {
  const s = presetOAuthScope("slack_oauth");
  assert.equal(typeof s, "string");
  assert.ok(scopeTokens(s).length > 0); // 최소 하나 이상의 scope
});
t("presetOAuthScope: slack scope 는 실제 지원 scope 의 부분집합(오타·미지원 토큰 없음)", () => {
  for (const tok of scopeTokens(presetOAuthScope("slack_oauth"))) {
    assert.ok(SLACK_SUPPORTED.has(tok), `미지원 slack scope 토큰: ${tok}`);
  }
});
t("presetOAuthScope: slack scope 는 필수 권한 포함(chat:write · search:read.public)", () => {
  const toks = new Set(scopeTokens(presetOAuthScope("slack_oauth")));
  assert.ok(toks.has("chat:write"), "메시지 전송 권한 chat:write 누락");
  assert.ok(toks.has("search:read.public"), "공개채널 검색 search:read.public 누락");
});
t("presetOAuthScope: slack scope 는 과다·민감 권한 제외(users:read.email · channels:write)", () => {
  const toks = new Set(scopeTokens(presetOAuthScope("slack_oauth")));
  assert.ok(!toks.has("users:read.email"), "개인정보 scope users:read.email 이 포함됨");
  assert.ok(!toks.has("channels:write"), "파괴적 쓰기 scope channels:write 가 포함됨");
});

// ── Notion / Linear — scope 미요구 상류(회귀 방지) ──
t("presetOAuthScope: notion_oauth → undefined(scope 미요청)", () => {
  assert.equal(presetOAuthScope("notion_oauth"), undefined);
});
t("presetOAuthScope: linear_oauth → undefined(scope 미요청)", () => {
  assert.equal(presetOAuthScope("linear_oauth"), undefined);
});

// ── 알 수 없거나 없는 입력 → 모두 undefined ──
t("presetOAuthScope: 미등록 auth_kind → undefined", () => {
  assert.equal(presetOAuthScope("nope_oauth"), undefined);
  assert.equal(presetOAuthScope("does-not-exist"), undefined);
});
t("presetOAuthScope: null / undefined / 빈문자열 → undefined", () => {
  assert.equal(presetOAuthScope(null), undefined);
  assert.equal(presetOAuthScope(undefined), undefined);
  assert.equal(presetOAuthScope(""), undefined);
});

// ── 데이터 불변식 — 카탈로그 전체 ──
t("MCP_SERVER_PRESETS: 비어있지 않은 배열, 각 엔트리에 name 문자열 · proxy 레인은 auth_kind 필수", () => {
  assert.ok(Array.isArray(MCP_SERVER_PRESETS));
  assert.ok(MCP_SERVER_PRESETS.length > 0);
  for (const c of MCP_SERVER_PRESETS) {
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0);
    // 금고 슬롯은 게이트웨이가 대리하는 proxy 레인에서만 의미가 있다(#1881). 레인 C 는 클라가 자체 인증한다.
    if (isProxy(c)) assert.equal(typeof c.auth_kind, "string", `proxy 레인 ${c.name} 에 auth_kind 누락(연결 슬롯이 없다)`);
  }
});
t("MCP_SERVER_PRESETS: [proxy 레인] DCR 상류(notion·linear)는 oauth_scope 미지정, 비-DCR(slack·google)은 지정", () => {
  for (const c of MCP_SERVER_PRESETS) {
    if (!isProxy(c)) continue;   // 레인 C 는 게이트웨이가 authorize 를 만들지 않아 이 불변식의 대상이 아니다
    if (c.dcr) assert.ok(!c.oauth_scope, `DCR 상류 ${c.name} 에 예기치 않은 scope(넣으면 깨짐): ${c.oauth_scope}`);
    else assert.ok(c.oauth_scope && c.oauth_scope.length > 0, `비-DCR 상류 ${c.name} 에 scope 누락(authorize 가 거부됨)`);
  }
});

// ── 레인 C(클라 직접등록, #1881) — 게이트웨이가 대리하지 않는 상류 ──
//  왜 이 불변식이 필요한가: 레인 C 항목에 auth_kind·oauth_scope 를 실수로 달면 bootstrap·관리탭이 그걸 보고
//  프록시처럼 심으려 하고(금고 슬롯 생성·[발행] 시도), 상류는 클라이언트 allowlist 로 거부한다 — 조용히 깨진다.
t("MCP_SERVER_PRESETS: [레인 C] 게이트웨이 자격이 없어야 한다(auth_kind·oauth_scope·oauth_token_url 미지정)", () => {
  const lanC = MCP_SERVER_PRESETS.filter((c) => c.mode === "client");
  assert.ok(lanC.length > 0, "레인 C 프리셋이 하나도 없다(figma 가 빠졌는지 확인)");
  for (const c of lanC) {
    assert.ok(!c.auth_kind, `레인 C ${c.name} 에 auth_kind 가 있다 — 게이트웨이는 이 상류의 토큰을 갖지 않는다`);
    assert.ok(!c.oauth_scope, `레인 C ${c.name} 에 oauth_scope 가 있다 — authorize 를 만드는 쪽은 멤버 클라이언트다`);
    assert.ok(!c.oauth_token_url, `레인 C ${c.name} 에 oauth_token_url 이 있다 — 갱신도 클라이언트가 한다`);
    assert.ok(/^https:\/\//.test(c.url), `레인 C ${c.name} 의 url 은 https 여야 한다: ${c.url}`);
  }
});
t("MCP_SERVER_PRESETS: [레인 C] figma 는 카탈로그 allowlist 상류라 dcr=false·seed=true 여야 한다", () => {
  const f = MCP_SERVER_PRESETS.find((c) => c.name === "figma");
  assert.ok(f, "figma 프리셋이 없다");
  assert.equal(f.mode, "client", "figma 는 레인 C 다 — mcp.figma.com 은 DCR 을 403 으로 막는다(2026-08-26 실측)");
  assert.equal(f.dcr, false, "figma 는 registration_endpoint 를 광고하지만 실제 등록이 403 이라 dcr=false 다");
  assert.equal(f.seed, true, "figma 는 관리자 세팅이 0 이라 자동 시드 대상이다");
});
t("presetOAuthScope: 레인 C 는 auth_kind 가 없어 조회되지 않는다(프록시 authorize 에 섞이지 않음)", () => {
  assert.equal(presetOAuthScope("figma_token"), undefined);
  assert.equal(presetOAuthScope("figma_oauth"), undefined);
});

// ── Google (비-DCR, scope 요구; 인가서버 accounts.google.com) ──
t("presetOAuthScope: google gmail/drive/calendar → 비어있지 않은 구글 API scope(URL 형식)", () => {
  for (const k of ["google_gmail_oauth", "google_drive_oauth", "google_calendar_oauth"]) {
    const toks = scopeTokens(presetOAuthScope(k));
    assert.ok(toks.length > 0, `${k} scope 누락`);
    for (const tok of toks) assert.ok(/^https:\/\//.test(tok), `구글 scope 는 URL 형식이어야: ${tok}`);
  }
});
t("presetOAuthScope: gmail scope — readonly·compose·modify 포함(gmailmcp create_draft 가 modify 요구), 전체(mail.google.com)만 제외", () => {
  const toks = new Set(scopeTokens(presetOAuthScope("google_gmail_oauth")));
  assert.ok(toks.has("https://www.googleapis.com/auth/gmail.readonly"), "gmail.readonly 누락");
  assert.ok(toks.has("https://www.googleapis.com/auth/gmail.compose"), "gmail.compose 누락");
  assert.ok(toks.has("https://www.googleapis.com/auth/gmail.modify"), "gmail.modify 누락(gmailmcp create_draft 가 요구)");
  assert.ok(!toks.has("https://mail.google.com/"), "전체 접근 scope(mail.google.com) 포함됨");
});
t("presetOAuthScope: drive·calendar 최소권한 — readonly, 전체 쓰기 scope 제외", () => {
  const d = new Set(scopeTokens(presetOAuthScope("google_drive_oauth")));
  assert.ok(d.has("https://www.googleapis.com/auth/drive.readonly"), "drive.readonly 누락");
  assert.ok(!d.has("https://www.googleapis.com/auth/drive"), "drive 전체 scope 포함됨");
  const c = new Set(scopeTokens(presetOAuthScope("google_calendar_oauth")));
  assert.ok(c.has("https://www.googleapis.com/auth/calendar.readonly"), "calendar.readonly 누락");
  assert.ok(!c.has("https://www.googleapis.com/auth/calendar"), "calendar 전체 scope 포함됨");
});

console.log(`\nmcp-server-presets tests: ${pass} passed`);

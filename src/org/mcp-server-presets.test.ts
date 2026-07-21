// 커넥터 카탈로그 OAuth scope 결정(#746) 순수 단위 체크 — DB/네트워크 불요.
// 실행: npm run build && node dist/org/mcp-server-presets.test.js
//  커버: Slack scope(비어있지 않음·지원목록 부분집합·필수포함·민감제외) / Notion·Linear undefined /
//        미등록·null·undefined·빈문자열 undefined / 카탈로그 불변식(scope 지정은 slack 하나뿐).
import assert from "node:assert/strict";
import { MCP_SERVER_PRESETS, presetOAuthScope } from "./mcp-server-presets.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// Slack 이 실제 지원하는 scope (실측 26개, 사양 참고표) — 이 밖 토큰이 나오면 오타/버그.
const SLACK_SUPPORTED = new Set([
  "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
  "search:read.files", "search:read.users", "chat:write", "channels:history",
  "groups:history", "mpim:history", "im:history", "canvases:read", "canvases:write",
  "users:read", "users:read.email", "reactions:write", "reactions:read", "emoji:read",
  "files:read", "channels:write", "groups:write", "im:write", "mpim:write",
  "channels:read", "groups:read", "mpim:read",
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
t("MCP_SERVER_PRESETS: 비어있지 않은 배열, 각 엔트리에 name·auth_kind 문자열", () => {
  assert.ok(Array.isArray(MCP_SERVER_PRESETS));
  assert.ok(MCP_SERVER_PRESETS.length > 0);
  for (const c of MCP_SERVER_PRESETS) {
    assert.equal(typeof c.name, "string");
    assert.ok(c.name.length > 0);
    assert.equal(typeof c.auth_kind, "string");
  }
});
t("MCP_SERVER_PRESETS: scope 를 지정한 커넥터는 slack_oauth 하나뿐, 나머지는 미지정", () => {
  const withScope = MCP_SERVER_PRESETS.filter((c) => typeof c.oauth_scope === "string" && c.oauth_scope.length > 0);
  assert.equal(withScope.length, 1);                    // 딱 하나만 scope 지정
  assert.equal(withScope[0].auth_kind, "slack_oauth");  // 그게 slack
  for (const c of MCP_SERVER_PRESETS) {                  // 나머지는 전부 미지정(빈문자열/undefined)
    if (c.auth_kind !== "slack_oauth") assert.ok(!c.oauth_scope, `${c.name} 에 예기치 않은 scope: ${c.oauth_scope}`);
  }
});

console.log(`\nmcp-server-presets tests: ${pass} passed`);

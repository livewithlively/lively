// OAuth 연결 표면 확장 테스트 (#1656). 사양 = 표 M.
//
//  회귀 대상 ①: **어댑터를 A→B 로 내리면 자격 화면에서 그 서비스가 통째로 사라지던 것.**
//   웹은 connectors[].server 를 키로 매칭한다(web/me-logins.ts) — MCP 서버 행이 비활성이 되어 목록에서 빠지면
//   토큰은 살아 있는데 아무도 연결·재연결을 못 하는 상태가 된다. 영향 대상은 실제로 있다(어니스트 5인).
//  회귀 대상 ②: **서버 이름이 바뀌면 안 된다** — 이름이 곧 승계의 열쇠다(M8).
//  회귀 대상 ③: **연결 창구 없는 자격을 조용히 넘기지 않는다**(M6) — 목록에 넣으면 눌러도 안 되는 버튼이 되고,
//   그냥 빼면 왜 안 보이는지 아무도 모른다. 그래서 orphan 으로 보고한다.
import assert from "node:assert/strict";
import { foldOAuthConnectors, connectorReadyField, type ConnectorServerLike, type ConnectorToolLike } from "./oauth-connect.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const srv = (over: Partial<ConnectorServerLike> & { name: string }): ConnectorServerLike =>
  ({ mode: "proxy", auth_mode: "oauth", auth_kind: `${over.name.replace(/-/g, "_")}_oauth`, auth_scope_key: null, note: null, enabled: true, ...over });
const tool = (name: string, auth_kind: string): ConnectorToolLike => ({ name, auth_kind });
const kinds = (r: { connectors: Array<{ auth_kind: string }> }): string[] => r.connectors.map((c) => c.auth_kind).sort();

t("M1 켜져 있는 OAuth 프록시 서버는 목록에 나온다(무회귀)", () => {
  const r = foldOAuthConnectors([srv({ name: "notion" })], []);
  assert.deepEqual(kinds(r), ["notion_oauth"]);
  assert.deepEqual(r.connectors[0].used_by, ["mcp:notion"]);
});

// ⚠ 이 행은 원래 구글(google-drive)로 썼다. #1881 G2 가 구글을 **의도적으로** 한 줄(server='google')로 접으면서
//  구글은 이 불변식의 예외가 됐다(이름 변경은 web/me-logins.ts 의 카탈로그를 같은 커밋에서 함께 고쳐 짝을 맞췄다).
//  불변식 자체는 다른 모든 커넥터에 그대로 살아 있어야 하므로, 구글이 아닌 서비스로 겨눈다.
t("M2 ★ 서버를 내려도 그 자격을 쓰는 도구가 있으면 연결 대상으로 남는다(무중단 승계)", () => {
  const r = foldOAuthConnectors(
    [srv({ name: "linear", auth_kind: "linear_oauth", enabled: false })],
    [tool("linear_issue_search", "linear_oauth"), tool("linear_issue_read", "linear_oauth")],
  );
  assert.deepEqual(kinds(r), ["linear_oauth"], "B 로 내렸더니 자격 화면에서 사라졌다");
  assert.equal(r.connectors[0].server, "linear", "서버 이름이 바뀌면 웹 매칭이 깨진다");
  assert.deepEqual(r.orphanKinds, []);
});

t("M3 아무도 안 쓰는 비활성 서버는 목록에서 빠진다", () => {
  const r = foldOAuthConnectors([srv({ name: "old-thing", enabled: false })], []);
  assert.deepEqual(r.connectors, []);
});

// ⚠ M2 와 같은 이유로 구글이 아닌 서비스로 겨눈다 — 구글은 #1881 G2 에서 서버 행을 거치지 않고 접힌다(N1~N6).
t("M4 같은 자격을 여러 서버가 선언하면 하나로 접고, 켜진 쪽이 대표가 된다", () => {
  const r = foldOAuthConnectors([
    srv({ name: "linear-old", auth_kind: "linear_oauth", enabled: false }),
    srv({ name: "linear", auth_kind: "linear_oauth", enabled: true }),
  ], [tool("linear_issue_search", "linear_oauth")]);
  assert.equal(r.connectors.length, 1, "같은 자격이 두 줄로 보인다");
  assert.equal(r.connectors[0].server, "linear", "연결이 실제로 되는 행(켜진 쪽)이 대표여야 한다");
});

t("M4b 순서가 반대여도 켜진 쪽이 대표(순서 의존이면 안 된다)", () => {
  // ⚠ 도구를 함께 줘야 비활성 행도 후보로 남아 '접기'가 실제로 일어난다. 안 주면 비활성이 앞 단계에서
  //  걸러져 후보가 하나뿐이 되고, 이 행은 순서 의존을 전혀 검증하지 못한다(실측 — mutation 이 통과했다).
  const r = foldOAuthConnectors([
    srv({ name: "linear", auth_kind: "linear_oauth", enabled: true }),
    srv({ name: "linear-old", auth_kind: "linear_oauth", enabled: false }),
  ], [tool("linear_issue_search", "linear_oauth")]);
  assert.equal(r.connectors.length, 1);
  assert.equal(r.connectors[0].server, "linear", "나중 행이 켜진 행을 밀어냈다(순서 의존)");
  assert.equal(r.connectors[0].enabled, true);
});

t("M5 OAuth 커넥터가 아닌 행은 제외(mode·auth_mode·auth_kind)", () => {
  const r = foldOAuthConnectors([
    srv({ name: "a", mode: "local" }),
    srv({ name: "b", auth_mode: "sigv4" }),
    srv({ name: "c", auth_kind: null }),
  ], []);
  assert.deepEqual(r.connectors, []);
});

t("M6 도구는 쓰는데 연결 창구가 없으면 — 목록엔 안 넣고 orphan 으로 보고한다", () => {
  const r = foldOAuthConnectors([], [tool("some_tool", "unknown_oauth")]);
  assert.deepEqual(r.connectors, [], "눌러도 아무 일 없는 버튼을 만들면 안 된다");
  assert.deepEqual(r.orphanKinds, [{ auth_kind: "unknown_oauth", tools: ["some_tool"] }], "조용히 사라지면 아무도 원인을 못 찾는다");
});

t("M7 used_by 로 어느 어댑터가 그 자격을 쓰는지 보인다", () => {
  const both = foldOAuthConnectors(
    [srv({ name: "linear", auth_kind: "linear_oauth", enabled: true })],
    [tool("linear_issue_search", "linear_oauth")],
  );
  assert.deepEqual(both.connectors[0].used_by, ["mcp:linear", "tool:linear_issue_search"]);
  const onlyB = foldOAuthConnectors(
    [srv({ name: "linear", auth_kind: "linear_oauth", enabled: false })],
    [tool("linear_issue_search", "linear_oauth")],
  );
  assert.deepEqual(onlyB.connectors[0].used_by, ["tool:linear_issue_search"], "내린 A 가 아직 쓰는 것처럼 보인다");
});

t("M8 자격 슬롯 키(auth_kind·scope_key)가 그대로 실려 나간다 — 연결 여부 판정의 근거다", () => {
  const r = foldOAuthConnectors([srv({ name: "x", auth_kind: "k1", auth_scope_key: "eu" })], []);
  assert.equal(r.connectors[0].auth_kind, "k1");
  assert.equal(r.connectors[0].auth_scope_key, "eu");
});

// ── N. 구글 한 줄 접기(#1881 G2) — [연결] ×3 을 [Google 연결] ×1 로. ──
//  회귀 대상: ① 서비스마다 줄이 서던 것 ② MCP 서버 행이 없으면 창구가 통째로 사라지던 것(매니지드, T10 #1993)
//   ③ 구 kind 로 붙은 사람이 '연결 안 됨'으로 보여 재연결을 유도하던 것(#1652 에서 실제로 사람을 잃은 실패 모드).
const G_LEGACY = ["google_drive_oauth", "google_gmail_oauth", "google_calendar_oauth"];

t("N1 ★ 구글 도구 3종 → 줄 하나(server=google), 서비스별 줄은 사라진다", () => {
  const r = foldOAuthConnectors(
    G_LEGACY.map((k, i) => srv({ name: ["google-drive", "google-gmail", "google-calendar"][i], auth_kind: k, enabled: false })),
    [tool("google_drive_search", "google_drive_oauth"), tool("google_gmail_labels", "google_gmail_oauth"), tool("google_calendar_list", "google_calendar_oauth")],
  );
  assert.deepEqual(kinds(r), ["google_oauth"], "서비스마다 줄이 서면 사용자는 [연결]을 3번 눌러야 한다");
  assert.equal(r.connectors[0].server, "google");
  assert.deepEqual(r.connectors[0].used_by.sort(), ["tool:google_calendar_list", "tool:google_drive_search", "tool:google_gmail_labels"]);
});

t("N2 ★ MCP 서버 행이 하나도 없어도 도구만 있으면 창구가 선다(매니지드 개인 테넌트)", () => {
  const r = foldOAuthConnectors([], [tool("google_drive_search", "google_drive_oauth")]);
  assert.deepEqual(kinds(r), ["google_oauth"]);
  assert.equal(r.connectors[0].enabled, true, "직결은 서버 행의 enabled 와 무관하다");
  assert.deepEqual(r.orphanKinds, [], "구글은 서버 행이 없어도 고아가 아니다 — 직결 창구가 있다");
});

t("N3 ★ 구 kind 를 alias_kinds 로 물고 간다 — 예전에 붙은 사람이 '연결 안 됨'으로 보이면 안 된다", () => {
  const r = foldOAuthConnectors([], [tool("google_gmail_labels", "google_gmail_oauth")]);
  assert.deepEqual((r.connectors[0].alias_kinds ?? []).sort(), [...G_LEGACY].sort());
});

t("N4 통합 kind 를 쓰는 도구만 있어도 같은 한 줄(전환 완료 후 상태)", () => {
  const r = foldOAuthConnectors([], [tool("google_drive_search", "google_oauth")]);
  assert.deepEqual(kinds(r), ["google_oauth"]);
  assert.deepEqual(r.connectors[0].used_by, ["tool:google_drive_search"]);
});

t("N5 구글 도구가 하나도 없으면 구글 줄을 만들지 않는다(빈 버튼 금지)", () => {
  const r = foldOAuthConnectors([srv({ name: "notion" })], [tool("notion_search", "notion_oauth")]);
  assert.deepEqual(kinds(r), ["notion_oauth"]);
});

t("N6 다른 커넥터는 접기의 영향을 받지 않는다(무회귀)", () => {
  const r = foldOAuthConnectors(
    [srv({ name: "slack", auth_kind: "slack_oauth" })],
    [tool("slack_search_messages", "slack_oauth"), tool("google_drive_search", "google_drive_oauth")],
  );
  assert.deepEqual(kinds(r), ["google_oauth", "slack_oauth"]);
  assert.equal(r.connectors.find((c) => c.auth_kind === "slack_oauth")?.alias_kinds, undefined);
});

// ── #4211 «준비 중» 을 서버가 걷는다 — 커넥터 줄의 ready ─────────────────────────
//  화면(catalogSoon)은 구글 줄의 ready===true 일 때만 «준비 중» 을 걷는다. 그 입력을 만드는 쪽을 여기서 잠근다.
t("R1 ★ 구글 줄에는 ready 가 실린다 — 참/거짓 그대로", () => {
  assert.deepEqual(connectorReadyField("google", true), { ready: true });
  assert.deepEqual(connectorReadyField("google", false), { ready: false }, "준비 안 됨도 «모름» 이 아니라 false 로 말한다");
  assert.deepEqual(connectorReadyField("GOOGLE", true), { ready: true }, "구글 판정은 대소문자를 가리지 않는다(isGoogleServer)");
});

t("R2 다른 커넥터에는 ready 를 싣지 않는다 — 구글 밖에서 그 값의 뜻을 정한 적이 없다", () => {
  for (const s of ["slack", "notion", "linear", "gitlab", "google-drive"]) {
    assert.deepEqual(connectorReadyField(s, true), {}, s);
  }
});

// ── #4211 Outlook — [Outlook 연결] 한 줄(server='microsoft'). 구글과 달리 **도구가 없어도** 앱이 준비됐으면 선다:
//  도구는 첫 연결 때 심기 때문에(onMicrosoftInstalled), «도구가 있어야 창구가 선다»면 아무도 첫 연결을 못 한다(닭과 달걀).
t("F1 도구도 없고 앱도 준비 안 됐으면 Outlook 줄이 없다 — 눌러도 안 되는 버튼을 내밀지 않는다", () => {
  const r = foldOAuthConnectors([srv({ name: "notion" })], [], { microsoft: false });
  assert.deepEqual(kinds(r), ["notion_oauth"]);
  assert.deepEqual(kinds(foldOAuthConnectors([], [])), [], "기본값(인자 없음)도 없음");
});

t("F2 ★ 도구가 없어도 앱이 준비됐으면 Outlook 줄이 선다(server=microsoft, 쓰는 도구 없음)", () => {
  const r = foldOAuthConnectors([], [], { microsoft: true });
  assert.equal(r.connectors.length, 1);
  assert.equal(r.connectors[0].server, "microsoft", "웹 카탈로그가 이 이름으로 찾는다(me-logins oauth:'microsoft')");
  assert.equal(r.connectors[0].auth_kind, "microsoft_oauth");
  assert.equal(r.connectors[0].auth_scope_key, "");
  assert.deepEqual(r.connectors[0].used_by, []);
});

t("F3 도구가 있으면 줄이 서고 used_by 에 실린다 — 고아 자격으로 경고하지 않는다", () => {
  const r = foldOAuthConnectors([], [tool("outlook_mail_search", "microsoft_oauth"), tool("outlook_calendar_events", "microsoft_oauth")]);
  assert.deepEqual(kinds(r), ["microsoft_oauth"]);
  assert.deepEqual(r.connectors[0].used_by, ["tool:outlook_mail_search", "tool:outlook_calendar_events"]);
  assert.deepEqual(r.orphanKinds, [], "서버 행이 없다고 고아로 보고하면 운영 로그가 거짓 경보로 찬다");
});

console.log(`\noauth-connect: ${pass} passed`);

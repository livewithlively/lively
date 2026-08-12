// OAuth 연결 표면 확장 테스트 (#1656). 사양 = 표 M.
//
//  회귀 대상 ①: **어댑터를 A→B 로 내리면 자격 화면에서 그 서비스가 통째로 사라지던 것.**
//   웹은 connectors[].server 를 키로 매칭한다(web/me-logins.ts) — MCP 서버 행이 비활성이 되어 목록에서 빠지면
//   토큰은 살아 있는데 아무도 연결·재연결을 못 하는 상태가 된다. 영향 대상은 실제로 있다(어니스트 5인).
//  회귀 대상 ②: **서버 이름이 바뀌면 안 된다** — 이름이 곧 승계의 열쇠다(M8).
//  회귀 대상 ③: **연결 창구 없는 자격을 조용히 넘기지 않는다**(M6) — 목록에 넣으면 눌러도 안 되는 버튼이 되고,
//   그냥 빼면 왜 안 보이는지 아무도 모른다. 그래서 orphan 으로 보고한다.
import assert from "node:assert/strict";
import { foldOAuthConnectors, type ConnectorServerLike, type ConnectorToolLike } from "./oauth-connect.js";

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

t("M2 ★ 서버를 내려도 그 자격을 쓰는 도구가 있으면 연결 대상으로 남는다(무중단 승계)", () => {
  const r = foldOAuthConnectors(
    [srv({ name: "google-drive", auth_kind: "google_drive_oauth", enabled: false })],
    [tool("google_drive_search", "google_drive_oauth"), tool("google_drive_file_read", "google_drive_oauth")],
  );
  assert.deepEqual(kinds(r), ["google_drive_oauth"], "B 로 내렸더니 자격 화면에서 사라졌다");
  assert.equal(r.connectors[0].server, "google-drive", "서버 이름이 바뀌면 웹 매칭이 깨진다");
  assert.deepEqual(r.orphanKinds, []);
});

t("M3 아무도 안 쓰는 비활성 서버는 목록에서 빠진다", () => {
  const r = foldOAuthConnectors([srv({ name: "old-thing", enabled: false })], []);
  assert.deepEqual(r.connectors, []);
});

t("M4 같은 자격을 여러 서버가 선언하면 하나로 접고, 켜진 쪽이 대표가 된다", () => {
  const r = foldOAuthConnectors([
    srv({ name: "google-drive-old", auth_kind: "google_drive_oauth", enabled: false }),
    srv({ name: "google-drive", auth_kind: "google_drive_oauth", enabled: true }),
  ], [tool("google_drive_search", "google_drive_oauth")]);
  assert.equal(r.connectors.length, 1, "같은 자격이 두 줄로 보인다");
  assert.equal(r.connectors[0].server, "google-drive", "연결이 실제로 되는 행(켜진 쪽)이 대표여야 한다");
});

t("M4b 순서가 반대여도 켜진 쪽이 대표(순서 의존이면 안 된다)", () => {
  // ⚠ 도구를 함께 줘야 비활성 행도 후보로 남아 '접기'가 실제로 일어난다. 안 주면 비활성이 앞 단계에서
  //  걸러져 후보가 하나뿐이 되고, 이 행은 순서 의존을 전혀 검증하지 못한다(실측 — mutation 이 통과했다).
  const r = foldOAuthConnectors([
    srv({ name: "google-drive", auth_kind: "google_drive_oauth", enabled: true }),
    srv({ name: "google-drive-old", auth_kind: "google_drive_oauth", enabled: false }),
  ], [tool("google_drive_search", "google_drive_oauth")]);
  assert.equal(r.connectors.length, 1);
  assert.equal(r.connectors[0].server, "google-drive", "나중 행이 켜진 행을 밀어냈다(순서 의존)");
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
    [srv({ name: "google-drive", auth_kind: "google_drive_oauth", enabled: true })],
    [tool("google_drive_search", "google_drive_oauth")],
  );
  assert.deepEqual(both.connectors[0].used_by, ["mcp:google-drive", "tool:google_drive_search"]);
  const onlyB = foldOAuthConnectors(
    [srv({ name: "google-drive", auth_kind: "google_drive_oauth", enabled: false })],
    [tool("google_drive_search", "google_drive_oauth")],
  );
  assert.deepEqual(onlyB.connectors[0].used_by, ["tool:google_drive_search"], "내린 A 가 아직 쓰는 것처럼 보인다");
});

t("M8 자격 슬롯 키(auth_kind·scope_key)가 그대로 실려 나간다 — 연결 여부 판정의 근거다", () => {
  const r = foldOAuthConnectors([srv({ name: "x", auth_kind: "k1", auth_scope_key: "eu" })], []);
  assert.equal(r.connectors[0].auth_kind, "k1");
  assert.equal(r.connectors[0].auth_scope_key, "eu");
});

console.log(`\noauth-connect: ${pass} passed`);

import { strict as assert } from "node:assert";
import test from "node:test";
import { parseAppManifest, appAssetId, APP_ID_RE } from "./manifest.js";
import { assertAssetId } from "../org/asset-id.js";

// 최소 유효 매니페스트(각 케이스가 이걸 얕게 변형).
function base(): Record<string, unknown> {
  return { id: "slack-dash", title: "슬랙 대시보드", version: "1.0.0" };
}

test("최소 매니페스트 통과 + 기본값 채움(새 필드 부재 엣지)", () => {
  const m = parseAppManifest(base());
  assert.equal(m.id, "slack-dash");
  assert.deepEqual(m.permissions.scopes, []);
  assert.deepEqual(m.permissions.tools, []);
  assert.deepEqual(m.permissions.hosts, []);
  assert.deepEqual(m.ui.pages, []);
  assert.deepEqual(m.jobs, []);
  assert.deepEqual(m.data.tables, []);
});

// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 1개) ────────────────────────────
const REJECTS: Array<{ what: string; patch: (m: Record<string, unknown>) => void }> = [
  { what: "id 대문자", patch: (m) => { m.id = "SlackDash"; } },
  { what: "id 1자(경계-아래)", patch: (m) => { m.id = "a"; } },
  { what: "id 33자(경계-위)", patch: (m) => { m.id = "a".repeat(33); } },
  { what: "id 하이픈 시작", patch: (m) => { m.id = "-slack"; } },
  { what: "id 점 포함", patch: (m) => { m.id = "slack.dash"; } },
  { what: "version 2-파트", patch: (m) => { m.version = "1.0"; } },
  { what: "version 비수 접두", patch: (m) => { m.version = "v1.0.0"; } },
  { what: "admin scope 선언", patch: (m) => { m.permissions = { scopes: ["admin"] }; } },
  { what: "runtime scope 선언", patch: (m) => { m.permissions = { scopes: ["runtime"] }; } },
  { what: "알 수 없는 scope", patch: (m) => { m.permissions = { scopes: ["superuser"] }; } },
  { what: "알 수 없는 최상위 키(strict)", patch: (m) => { (m as Record<string, unknown>).extra = 1; } },
  { what: "permissions 알 수 없는 키(strict)", patch: (m) => { m.permissions = { bogus: 1 }; } },
  { what: "host 에 스킴 포함", patch: (m) => { m.permissions = { hosts: ["https://x.com"] }; } },
  { what: "ui.pages key 중복", patch: (m) => { m.ui = { pages: [{ key: "a", title: "A", entry: "a.html" }, { key: "a", title: "B", entry: "b.html" }] }; } },
  { what: "jobs key 중복", patch: (m) => { m.jobs = [{ key: "j", schedule: "* * * * *", run: { kind: "headless", prompt: "x" } }, { key: "j", schedule: "* * * * *", run: { kind: "headless", prompt: "y" } }]; } },
  { what: "job run 에 prompt 없음", patch: (m) => { m.jobs = [{ key: "j", schedule: "0 * * * *", run: { kind: "headless" } }]; } },
  { what: "잘못된 display 모드", patch: (m) => { m.ui = { pages: [{ key: "a", title: "A", entry: "a.html", display: ["giant"] }] }; } },
  { what: "data 컬럼명 대문자", patch: (m) => { m.data = { tables: [{ name: "t", columns: [{ name: "Bad", type: "int" }] }] }; } },
  { what: "data 테이블 컬럼 0개", patch: (m) => { m.data = { tables: [{ name: "t", columns: [] }] }; } },
  { what: "title 빈 문자열", patch: (m) => { m.title = ""; } },
  { what: "id 누락", patch: (m) => { delete m.id; } },
];

for (const { what, patch } of REJECTS) {
  test(`거부: ${what}`, () => {
    const m = base();
    patch(m);
    assert.throws(() => parseAppManifest(m), /매니페스트 오류|형식/, `"${what}" 는 거부돼야 한다`);
  });
}

const ACCEPTS: Array<{ what: string; patch: (m: Record<string, unknown>) => void }> = [
  { what: "id 2자(경계-최소)", patch: (m) => { m.id = "ab"; } },
  { what: "id 32자(경계-최대)", patch: (m) => { m.id = "a".repeat(32); } },
  { what: "context scope", patch: (m) => { m.permissions = { scopes: ["context"] }; } },
  { what: "memory+context scope", patch: (m) => { m.permissions = { scopes: ["memory", "context"] }; } },
  { what: "ext 도구 글롭", patch: (m) => { m.permissions = { ext_tools: ["ext__slack__*"] }; } },
  { what: "host:port", patch: (m) => { m.permissions = { hosts: ["api.x.com:8443"] }; } },
  { what: "job prompt_asset", patch: (m) => { m.jobs = [{ key: "j", schedule: "0 * * * *", run: { kind: "headless", prompt_asset: "jobs/a.md" } }]; } },
  { what: "prerelease semver", patch: (m) => { m.version = "1.0.0-beta.1"; } },
  { what: "build semver", patch: (m) => { m.version = "1.0.0+2026"; } },
  { what: "ui page+widget", patch: (m) => { m.ui = { pages: [{ key: "main", title: "M", entry: "ui/i.html", display: ["inline", "fullscreen"] }], widgets: [{ key: "w", title: "W", entry: "ui/w.html", surfaces: ["home"] }] }; } },
];

for (const { what, patch } of ACCEPTS) {
  test(`통과: ${what}`, () => {
    const m = base();
    patch(m);
    assert.doesNotThrow(() => parseAppManifest(m), `"${what}" 는 통과해야 한다`);
  });
}

// ── appAssetId (design R1-F4) ────────────────────────────────────────────────
test("appAssetId 는 STRICT_SLUG 를 만족한다(물질화 경로 안전)", () => {
  const id = appAssetId("slack-dash", "hourly-agg");
  assert.match(id, /^app-[0-9a-f]{10}-hourly-agg$/);
  assert.doesNotThrow(() => assertAssetId(id));
});

test("appAssetId 는 32자 앱 id 에서도 ≤64자(앱id 10hex 접힘)", () => {
  const id = appAssetId("a".repeat(32), "skill-x");
  assert.ok(id.length <= 64, `id length ${id.length}`);
});

test("appAssetId 결정론", () => {
  assert.equal(appAssetId("foo", "bar"), appAssetId("foo", "bar"));
});

test("appAssetId 하이픈 구분자 모호성 없음", () => {
  assert.notEqual(appAssetId("foo", "bar-baz"), appAssetId("foo-bar", "baz"));
});

test("APP_ID_RE 경계값", () => {
  assert.ok(APP_ID_RE.test("ab"));
  assert.ok(APP_ID_RE.test("a".repeat(32)));
  assert.ok(!APP_ID_RE.test("a"));
  assert.ok(!APP_ID_RE.test("a".repeat(33)));
});

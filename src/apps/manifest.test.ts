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
  assert.deepEqual(m.instances, { project: "optional", multiplicity: "multiple" });
  assert.equal(m.system, undefined);
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
  // (최상위 미지 키는 #1780 v2 §7-1 전방호환으로 **통과**한다 — 아래 H6 테스트. 중첩 미지 키는 여전히 거부.)
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

// ── csp 선언 (#1780 SDK — MCP Apps 채택) ────────────────────────────────────
//  「입력 × 기대」 표: 미선언 = 아무것도 안 열림 / frame 은 * 허용(남의 페이지를 불투명 오리진으로 싣기만) /
//  connect 의 * 는 거부(데이터 유출 통로) / 호스트 형식 검증 / $schema 는 통과하되 그 밖의 미지 키는 여전히 거부.

test("csp 미선언 → 기본값 빈 배열(= 네트워크·프레임 0)", () => {
  const m = parseAppManifest(base());
  assert.deepEqual(m.csp.connect_domains, []);
  assert.deepEqual(m.csp.resource_domains, []);
  assert.deepEqual(m.csp.frame_domains, []);
});

test("csp.frame_domains 는 '*' 를 허용한다(브라우저형 앱)", () => {
  const m = parseAppManifest({ ...base(), csp: { frame_domains: ["*"] } });
  assert.deepEqual(m.csp.frame_domains, ["*"]);
});

test("csp.connect_domains 의 '*' 는 거부한다(유출 통로 — 명시 호스트만)", () => {
  assert.throws(() => parseAppManifest({ ...base(), csp: { connect_domains: ["*"] } }), /connect_domains/);
  // 명시 호스트·와일드카드 서브도메인은 통과.
  const m = parseAppManifest({ ...base(), csp: { connect_domains: ["api.example.com", "*.corp.example.com"] } });
  assert.deepEqual(m.csp.connect_domains, ["api.example.com", "*.corp.example.com"]);
});

test("csp 도메인 형식 위반 거부(스킴·경로·공백)", () => {
  for (const bad of ["https://x.com", "x.com/path", "a b", "http://*", ""]) {
    assert.throws(() => parseAppManifest({ ...base(), csp: { frame_domains: [bad] } }), /csp|매니페스트/);
  }
});

test("$schema 는 통과(편집기 자동완성) — 최상위 미지 키도 통과(#1780 v2 §7-1 전방호환), 중첩 미지 키는 거부", () => {
  const m = parseAppManifest({ ...base(), $schema: "https://dev.lvly.io/ui/lively-app.schema.json" });
  assert.equal(m.id, "slack-dash");
  assert.doesNotThrow(() => parseAppManifest({ ...base(), nope: 1 }));
  assert.throws(() => parseAppManifest({ ...base(), ui: { nope: 1 } }), /매니페스트/);
});

// ── AppInstance 선언(#1780 v2.1) ────────────────────────────────────────────
test("instances.project 3정책과 multiplicity를 정규화한다", () => {
  for (const project of ["global", "optional", "required"] as const) {
    const m = parseAppManifest({ ...base(), instances: { project, multiplicity: "single" } });
    assert.deepEqual(m.instances, { project, multiplicity: "single" });
  }
});

test("instances 중첩 미지 키와 잘못된 정책은 거부한다", () => {
  assert.throws(() => parseAppManifest({ ...base(), instances: { project: "sometimes" } }), /instances/);
  assert.throws(() => parseAppManifest({ ...base(), instances: { project: "optional", typo: true } }), /instances/);
});

test("builtin system renderer 선언은 파싱·보존하고 형식은 제한한다", () => {
  const m = parseAppManifest({ ...base(), system: { renderer: "browser", home: "https://www.google.com/" } });
  assert.deepEqual(m.system, { renderer: "browser", home: "https://www.google.com/" });
  assert.throws(() => parseAppManifest({ ...base(), system: { renderer: "native-code" } }), /system/);
  assert.throws(() => parseAppManifest({ ...base(), system: { renderer: "session", secret: true } }), /system/);
});

test("runtime은 worker 하나만 — entry 단축형과 중앙·원격 동일 계약을 정규화한다", () => {
  const m = parseAppManifest({ ...base(), runtime: { entry: "main.mjs", placement: "remote" } });
  assert.deepEqual(m.runtime, { kind: "worker", entry: "main.mjs", placement: "remote", idle_timeout_sec: 300, memory_mb: 256 });
  assert.throws(() => parseAppManifest({ ...base(), runtime: { kind: "external", entry: "main.mjs" } }), /runtime/);
  assert.throws(() => parseAppManifest({ ...base(), runtime: { kind: "worker", entry: "../main.mjs" } }), /runtime/);
  assert.throws(() => parseAppManifest({ ...base(), runtime: { kind: "worker", entry: "main.mjs", placement: "gateway-only" } }), /runtime/);
});

// ── #1780 v2 §7-1(사양 H6) — 전방호환: 최상위 미지 키 통과 · schema_version · 설치 게이트 ──
import { assertInstallableManifest, SUPPORTED_MANIFEST_SCHEMA } from "./manifest.js";
import { HttpError } from "../http-error.js";

test("정식 runtime은 정규화되고, 그 밖의 최상위 미지 키는 보존된다(롤백 재파싱 안전)", () => {
  const m = parseAppManifest({ ...base(), runtime: { kind: "worker", entry: "main.js" }, triggers: [{ kind: "cron" }] });
  assert.deepEqual((m as Record<string, unknown>).runtime, { kind: "worker", entry: "main.js", placement: "any", idle_timeout_sec: 300, memory_mb: 256 });
  assert.deepEqual((m as Record<string, unknown>).triggers, [{ kind: "cron" }]);
});

test("중첩 미지 키(permissions.foo)는 종전대로 400", () => {
  assert.throws(() => parseAppManifest({ ...base(), permissions: { foo: 1 } }), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("schema_version 없음 → 1 로 정규화", () => {
  assert.equal(parseAppManifest(base()).schema_version, 1);
});

test("schema_version 2 는 파싱(재파싱)엔 성공하지만 설치 게이트는 400", () => {
  const m = parseAppManifest({ ...base(), schema_version: 2 });
  assert.equal(m.schema_version, 2);
  assert.throws(() => assertInstallableManifest(m), (e: unknown) => e instanceof HttpError && e.status === 400 && /schema_version/.test(e.message));
});

test("schema_version 경계: 지원 상한(1)은 설치 통과", () => {
  assert.doesNotThrow(() => assertInstallableManifest(parseAppManifest({ ...base(), schema_version: SUPPORTED_MANIFEST_SCHEMA })));
});

for (const [what, v] of [["0", 0], ["1.5", 1.5], ["'1'(문자열)", "1"]] as const) {
  test(`schema_version ${what} 는 400`, () => {
    assert.throws(() => parseAppManifest({ ...base(), schema_version: v }), (e: unknown) => e instanceof HttpError && e.status === 400);
  });
}

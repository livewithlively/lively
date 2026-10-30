import { strict as assert } from "node:assert";
import test from "node:test";
import { parseAppManifest, appAssetId, APP_ID_RE, webRootOf, webDevicesOf, APP_DEVICES } from "./manifest.js";
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
  // #4595 agent — AI 지침. 매 턴 맥락에 들어가는 글이라 상한이 있고, 중첩 미지 키는 다른 중첩과 같이 거부.
  { what: "agent.instructions 4001자(경계-위)", patch: (m) => { m.agent = { instructions: "가".repeat(4001) }; } },
  { what: "agent.instructions 빈 문자열(경계-아래)", patch: (m) => { m.agent = { instructions: "" }; } },
  { what: "agent.reinject_every 4(경계-아래)", patch: (m) => { m.agent = { instructions: "x", reinject_every: 4 }; } },
  { what: "agent.reinject_every 501(경계-위)", patch: (m) => { m.agent = { instructions: "x", reinject_every: 501 }; } },
  { what: "agent.reinject_every 소수", patch: (m) => { m.agent = { instructions: "x", reinject_every: 10.5 }; } },
  { what: "agent 알 수 없는 키(strict)", patch: (m) => { m.agent = { instructions: "x", foo: 1 }; } },
  { what: "agent 가 문자열", patch: (m) => { m.agent = "HTML 을 만들면 올린다"; } },
  { what: "agent 에 instructions 없음", patch: (m) => { m.agent = { reinject_every: 40 }; } },
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
  { what: "agent.instructions 4000자(경계-최대)", patch: (m) => { m.agent = { instructions: "가".repeat(4000) }; } },
  { what: "agent.reinject_every 5(경계-최소)", patch: (m) => { m.agent = { instructions: "x", reinject_every: 5 }; } },
  { what: "agent.reinject_every 500(경계-최대)", patch: (m) => { m.agent = { instructions: "x", reinject_every: 500 }; } },
];

// ── agent — 세션에 붙었을 때 AI 에게 실리는 지침(#4595) ─────────────────────────
test("M1 agent 없음 → undefined(기존 매니페스트 무회귀) · M2 instructions 만 → reinject_every 기본 40", () => {
  assert.equal(parseAppManifest(base()).agent, undefined);
  const m = parseAppManifest({ ...base(), agent: { instructions: "HTML 을 만들면 이 앱에 올린다" } });
  assert.equal(m.agent?.instructions, "HTML 을 만들면 이 앱에 올린다");
  assert.equal(m.agent?.reinject_every, 40);
});

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

// ── #4483 칸 타입·제약·구조 변경 — 모양 검증(DB 없이). 뜻(검사 식의 칸·함수)은 설치 때 검사기가 본다 ─────────────
const withTables = (tables: unknown[]): Record<string, unknown> => ({ ...base(), data: { tables } });
const T = (columns: unknown[], extra: Record<string, unknown> = {}) => ({ name: "orders", columns, ...extra });

test("#4483 받는 것 — 새 타입 · not_null · default(값·식) · unique · check · enum values · references · renamed_from · checks · drop_columns", () => {
  const m = parseAppManifest(withTables([
    { name: "contacts", columns: [{ name: "name", type: "text", not_null: true }, { name: "stage", type: "enum", values: ["lead", "won"], default: "lead" }] },
    T([
      { name: "contact_id", type: "bigint", references: { table: "contacts", on_delete: "cascade" } },
      { name: "amount", type: "numeric(12,2)", not_null: true, default: 0, check: "amount >= 0" },
      { name: "tags", type: "text[]", default: ["a"] },
      { name: "made", type: "timestamp", default_expr: "now()" },
      { name: "code", type: "varchar(20)", unique: true, renamed_from: "old_code" },
    ], { checks: ["amount < 1000000"], drop_columns: ["legacy"] }),
  ]));
  const o = m.data.tables[1];
  assert.deepEqual(o.checks, ["amount < 1000000"]);
  assert.deepEqual(o.drop_columns, ["legacy"]);
  assert.equal(o.columns[1].not_null, true);
  assert.equal(parseAppManifest(withTables([T([{ name: "a", type: "text" }])])).data.tables[0].checks.length, 0);   // 기본값 []
});

const REJECTS_4483: Array<[string, unknown[]]> = [
  ["허용 밖 타입", [T([{ name: "a", type: "money" }])]],
  ["numeric 소수 자릿수 > 자릿수", [T([{ name: "a", type: "numeric(4,5)" }])]],
  ["enum 인데 values 없음", [T([{ name: "a", type: "enum" }])]],
  ["values 는 enum 에만", [T([{ name: "a", type: "text", values: ["x"] }])]],
  ["values 중복", [T([{ name: "a", type: "enum", values: ["x", "x"] }])]],
  ["default 와 default_expr 함께", [T([{ name: "a", type: "timestamp", default: "2026-01-01", default_expr: "now()" }])]],
  ["default_expr 목록 밖", [T([{ name: "a", type: "timestamp", default_expr: "clock_timestamp()" }])]],
  ["default_expr 상속 키 constructor", [T([{ name: "a", type: "timestamp", default_expr: "constructor" }])]],
  ["default_expr 상속 키 __proto__", [T([{ name: "a", type: "timestamp", default_expr: "__proto__" }])]],
  ["default_expr 상속 키 hasownproperty", [T([{ name: "a", type: "timestamp", default_expr: "hasOwnProperty" }])]],
  ["배열 칸에 배열 아닌 default", [T([{ name: "a", type: "text[]", default: "x" }])]],
  ["enum default 가 values 밖", [T([{ name: "a", type: "enum", values: ["x"], default: "y" }])]],
  ["references 가 없는 표", [T([{ name: "a", type: "bigint", references: { table: "nope" } }])]],
  ["references 칸이 정수가 아님", [{ name: "c", columns: [{ name: "n", type: "text" }] }, T([{ name: "a", type: "text", references: { table: "c" } }])]],
  ["on_delete set null + not_null", [{ name: "c", columns: [{ name: "n", type: "text" }] }, T([{ name: "a", type: "bigint", not_null: true, references: { table: "c", on_delete: "set null" } }])]],
  ["on_delete 목록 밖", [{ name: "c", columns: [{ name: "n", type: "text" }] }, T([{ name: "a", type: "bigint", references: { table: "c", on_delete: "explode" } }])]],
  ["renamed_from 이 지금 선언한 칸", [T([{ name: "a", type: "text", renamed_from: "b" }, { name: "b", type: "text" }])]],
  ["check 에 세미콜론", [T([{ name: "a", type: "int", check: "a > 0; DROP TABLE x" }])]],
  ["drop_columns 가 선언한 칸", [T([{ name: "a", type: "text" }], { drop_columns: ["a"] })]],
  ["drop_columns 가 시스템 칸", [T([{ name: "a", type: "text" }], { drop_columns: ["id"] })]],
  ["같은 칸 이름 두 번", [T([{ name: "a", type: "text" }, { name: "a", type: "int" }])]],
  ["칸에 모르는 속성", [T([{ name: "a", type: "text", nullable: false }])]],
];
for (const [what, tables] of REJECTS_4483) {
  test(`#4483 거부 — ${what}`, () => {
    assert.throws(() => parseAppManifest(withTables(tables)), /매니페스트 오류|허용되지 않은 컬럼 타입|default|형식|Unrecognized|unrecognized/, what);
  });
}

// ── #4481 여러 파일 앱의 화면 폴더(web.root) — 최상위 칸이라 옛 코어(이 칸을 모름)로 되돌려도 매니페스트가 읽힌다 ─────────────
test("#4481 web.root — 최상위 web 칸 · 정규 상대경로 · 맨 위는 \"\" · 틀린 꼴은 null", () => {
  const m = parseAppManifest({ ...base(), web: { root: "./dist/" } });
  assert.equal(webRootOf(m), "dist");
  assert.equal(webRootOf(parseAppManifest({ ...base(), web: { root: "." } })), "", "패키지 맨 위");
  assert.equal(webRootOf(parseAppManifest(base())), null, "web 없음 = 화면 한 장 앱(v1)");
  for (const bad of ["../x", "/abs", "a\\b", "a/.hidden", "  "]) assert.equal(webRootOf({ web: { root: bad } }), null, bad);
});
test("#4481 web 안의 모르는 칸은 통과(다음 단계가 더한 칸 — 되돌려도 읽힘) · ui.root 는 없다(ui 는 strict)", () => {
  assert.doesNotThrow(() => parseAppManifest({ ...base(), web: { root: "dist", server: { entry: "server.js" } } }));
  assert.throws(() => parseAppManifest({ ...base(), ui: { root: "dist", pages: [] } }), /매니페스트/);
  assert.throws(() => parseAppManifest({ ...base(), web: { root: "" } }), /매니페스트/, "빈 값");
});

// ── #4482 앱 주소 iframe 의 장치 권한 선언(web.devices) — 선언한 앱의 iframe 에만 위임된다(상민님 2026-10-16 «선언한 앱만») ─────────────
//  이게 틀리면: 모르는 장치 이름이 저장돼 화면이 엉뚱한 권한을 위임하거나(allow 속성), 선언이 저장은 되는데 읽는 쪽이 못 읽어 위임이 안 된다.
test("#4482 web.devices — 아는 장치만 저장 · 모르는 값 · 꼴 밖은 거절 · 읽을 땐 정해진 순서로 거른다", () => {
  assert.doesNotThrow(() => parseAppManifest({ ...base(), web: { devices: ["microphone", "camera"] } }));
  assert.doesNotThrow(() => parseAppManifest({ ...base(), web: { root: "dist", devices: [] } }), "빈 목록 · root 와 함께");
  assert.throws(() => parseAppManifest({ ...base(), web: { devices: ["usb"] } }), /매니페스트/, "모르는 장치");
  assert.throws(() => parseAppManifest({ ...base(), web: { devices: "microphone" } }), /매니페스트/, "배열이 아님");
  assert.throws(() => parseAppManifest({ ...base(), web: { devices: ["microphone; camera *"] } }), /매니페스트/, "지시문을 끼워 넣는 값");
  assert.deepEqual(webDevicesOf({ web: { devices: ["camera", "usb", "microphone", "camera"] } }), ["microphone", "camera"], "읽을 땐 아는 것만 · 정해진 순서 · 한 번씩");
  assert.deepEqual(webDevicesOf({ web: { devices: "microphone" } }), [], "배열 아님 → 없음");
  assert.deepEqual(webDevicesOf(null), []);
  assert.deepEqual([...APP_DEVICES], ["microphone", "camera", "clipboard-read", "geolocation"]);
});

// ── #4486 서버를 선언한 앱 → 백그라운드 작업 도구 넷 함의 ─────────────────────────────────────────────
//  이게 틀리면: 서버 앱의 SDK livelyJobs() · 앱 주소 /_lively/jobs 가 «권한 밖» 으로 막히거나, 서버 없는 앱이 작업 도구를 얻는다.
test("#4486 web.server(객체 · true) → app_job_* 넷 함의(중복 없음) · 서버 없음 · 배열 · 글은 없음", () => {
  const JOB = ["app_job_start", "app_job_get", "app_jobs", "app_job_cancel"];
  for (const server of [{}, { start: "node s.js" }, true]) {
    const tools = parseAppManifest({ ...base(), web: { server }, permissions: { tools: ["app_jobs"] } }).permissions.tools;
    for (const t of JOB) assert.ok(tools.includes(t), `${JSON.stringify(server)} ${t}`);
    assert.equal(tools.filter((t) => t === "app_jobs").length, 1, "이미 적은 도구는 한 번만");
  }
  for (const server of [undefined, false, [], "node s.js", null]) {
    const tools = parseAppManifest({ ...base(), ...(server === undefined ? {} : { web: { server } }) }).permissions.tools;
    assert.ok(!tools.some((t) => t.startsWith("app_job")), `${JSON.stringify(server)} 에 작업 도구가 붙었다`);
  }
});

// ── #4488 AI 실행 선언(permissions.ai_runs · ai.jobs) — M1~M2 ─────────────────────────────────────────────────────────────────────────
//  이게 틀리면: 선언만 하고 도구가 grant 에 안 들어가 앱 주소 /_lively/ai/* 가 «권한 밖» 으로 막히거나, 작업 이름 꼴 밖 선언이 저장돼 설정 칸과 어긋난다.
test("#4488 permissions.ai_runs → AI 실행 도구 다섯 함의(중복 없음) · 기본 false 면 없음 · ai.jobs 이름 꼴", () => {
  const m = parseAppManifest({ ...base(), permissions: { ai_runs: true, tools: ["app_ai_run"] } });
  const tools = m.permissions.tools;
  for (const t of ["app_ai_run", "app_ai_run_get", "app_ai_runs", "app_ai_run_cancel", "app_ai_targets"]) assert.ok(tools.includes(t), t);
  assert.equal(tools.filter((t) => t === "app_ai_run").length, 1, "이미 적은 도구는 한 번만");
  const off = parseAppManifest(base());
  assert.equal(off.permissions.ai_runs, false);
  assert.ok(!off.permissions.tools.some((t) => t.startsWith("app_ai_")), "선언 없으면 도구 없음(fail-closed)");
  assert.doesNotThrow(() => parseAppManifest({ ...base(), ai: { jobs: [{ name: "summarize", title: "요약", description: "d" }] } }));
  assert.throws(() => parseAppManifest({ ...base(), ai: { jobs: [{ name: "Bad Name" }] } }), /매니페스트/, "이름 꼴 밖");
  assert.throws(() => parseAppManifest({ ...base(), ai: { jobs: [{ name: "x", prompt: "y" }] } }), /매니페스트/, "jobs 안 미지 키는 거부");
  assert.doesNotThrow(() => parseAppManifest({ ...base(), ai: { jobs: [], later: 1 } }), "ai 의 미지 키는 통과(전방호환)");
});

// ── #5100 앱 맥락 범위 — context 칸(저장 관문 · 사양 B) ─────────────────────────
//  M1 없음 = 칸 없음(종전) · M2 {} = 두 목록 빈 것(닫힘) · M3 key 64자 통과 · 65자 400 · M4 key 꼴 · M5 50개 통과 · 51개 400
//  M6 자료 종류 표준 / 모르는 값 · M7 folders 는 빈 배열이라도 400(context.folders) · M8 오타 칸 400 · M9 글 · 배열 · null 400
//  M10 최상위 모르는 칸은 context 와 함께여도 종전대로 통과
const withContext = (context: unknown): Record<string, unknown> => ({ ...base(), context });
const rejects400 = (raw: Record<string, unknown>, where: RegExp): void => {
  assert.throws(() => parseAppManifest(raw), (e: unknown) => (e as { status?: number }).status === 400 && where.test(String((e as Error).message)));
};

test("#5100 M1 context 없음 — 칸 없음(범위 없음 · 종전)", () => {
  assert.equal(parseAppManifest(base()).context, undefined);
});

test("#5100 M2 context {} — 두 목록 모두 빈 것(선언했지만 비었다 = 닫힘)", () => {
  assert.deepEqual(parseAppManifest(withContext({})).context, { knowledge_categories: [], source_kinds: [] });
});

test("#5100 M3 카테고리 key 64자 통과 · 65자 400", () => {
  const k64 = "a" + "b".repeat(63);
  assert.deepEqual(parseAppManifest(withContext({ knowledge_categories: [k64] })).context?.knowledge_categories, [k64]);
  rejects400(withContext({ knowledge_categories: [k64 + "c"] }), /context\.knowledge_categories/);
});

test("#5100 M4 key 꼴 — 대문자 · 하이픈으로 시작 · 한글은 400", () => {
  for (const bad of ["Policy", "-policy", "정책"]) rejects400(withContext({ knowledge_categories: [bad] }), /context\.knowledge_categories/);
  assert.deepEqual(parseAppManifest(withContext({ knowledge_categories: ["d-156e8f8e77", "runtime-ops", "a_b"] })).context?.knowledge_categories, ["d-156e8f8e77", "runtime-ops", "a_b"]);
});

test("#5100 M5 카테고리 50개 통과 · 51개 400", () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
  assert.equal(parseAppManifest(withContext({ knowledge_categories: keys(50) })).context?.knowledge_categories.length, 50);
  rejects400(withContext({ knowledge_categories: keys(51) }), /context\.knowledge_categories/);
});

test("#5100 M6 자료 종류 — 표준 값 통과 · 모르는 값 400", () => {
  assert.deepEqual(parseAppManifest(withContext({ source_kinds: ["slack", "local_file"] })).context?.source_kinds, ["slack", "local_file"]);
  rejects400(withContext({ source_kinds: ["gmail"] }), /context\.source_kinds/);
});

test("#5100 M7 folders 는 빈 배열이라도 400 — 다음 판", () => {
  rejects400(withContext({ folders: [] }), /context\.folders/);
  rejects400(withContext({ knowledge_categories: ["a1"], folders: ["shared/x"] }), /context\.folders/);
});

test("#5100 M8 모르는 칸(오타) 400 — 좁히는 선언은 모르는 칸을 버리지 않는다", () => {
  rejects400(withContext({ knowledge_category: ["a1"] }), /context/);
});

test("#5100 M9 context 가 글 · 배열 · null 이면 400", () => {
  for (const bad of ["policy", ["policy"], null]) rejects400(withContext(bad), /context/);
});

test("#5100 M10 최상위 모르는 칸은 context 와 함께여도 종전대로 통과", () => {
  const m = parseAppManifest({ ...withContext({ knowledge_categories: ["a1"] }), future_key: { x: 1 } }) as Record<string, unknown>;
  assert.deepEqual(m.future_key, { x: 1 });
  assert.deepEqual((m.context as { knowledge_categories: string[] }).knowledge_categories, ["a1"]);
});

// ── #5082 작업별 앱 지시(ai.instructions) ── 엣지 표 I1~I4
//  parseAppManifest 는 모양(작업 이름 글 → 경로 글)만 본다 — 뜻(선언한 작업 · 상대 경로 · 파일)은 설치 · 판 저장 때 loader 가 본다(loader.test L1~L6).
//   저장된 매니페스트를 다시 읽는 자리(동의 · 인스턴스 · 워커)가 옛 코어가 남긴 매니페스트로 400 이 되지 않게(격리 리뷰 N4).
test("I1·I3 ai.instructions — 작업 이름 → 경로 글을 그대로 보존 · 선언이 없으면 없다", () => {
  const m = parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer" }, { name: "sum-up" }], instructions: { answer: "ai/answer.md", "sum-up": "prompts/s.txt" } } });
  assert.deepEqual(m.ai?.instructions, { answer: "ai/answer.md", "sum-up": "prompts/s.txt" });
  assert.equal(parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer" }] } }).ai?.instructions, undefined, "선언이 없으면 없다(종전 매니페스트 무회귀)");
});

test("I2 다시 읽기는 뜻을 따지지 않는다 — 선언 안 한 작업 이름 · 묶음 밖 경로도 저장된 그대로 읽힌다(설치 · 판 저장에서 막는다) · 모양이 틀리면 거절", () => {
  const stored = parseAppManifest({ ...base(), ai: { jobs: [], instructions: { gone: "../x.md" } } });
  assert.deepEqual(stored.ai?.instructions, { gone: "../x.md" });
  for (const bad of [{ answer: 3 }, ["ai/a.md"], "ai/a.md"]) {
    assert.throws(() => parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer" }], instructions: bad } }), /ai\.instructions/, JSON.stringify(bad));
  }
});

test("I4 지시는 ai 바로 아래 자리다 — ai.jobs[] 안(strict)에 두면 거절(이 칸을 모르는 옛 코어가 ai 바로 아래는 무시한다 · 롤백 안전)", () => {
  assert.throws(() => parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer", instructions: "ai/answer.md" }] } }), /ai\.jobs\.0/);
});

// ── ai.mcp_only — 라이블리 MCP 만 쓰는 작업 이름(사양 S2 · S3) ──
//  모양(글 목록 · 32개까지)만 본다 — 선언한 작업 이름인지(뜻)는 설치 · 판 저장 때 loader 가 본다(loader.test mcp_only S1).
//  이게 틀리면: 저장된 매니페스트를 다시 읽는 자리가 400 으로 막히거나, 모양이 틀린 선언이 저장돼 그 작업이 도구를 연 채 돈다.
const withMcpOnly = (mcpOnly: unknown): Record<string, unknown> => ({ ...base(), ai: { jobs: [{ name: "answer" }], mcp_only: mcpOnly } });
const mcpOnlyIn = (m: unknown): unknown => (m as { ai?: { mcp_only?: unknown } }).ai?.mcp_only;
const manifestErr = (e: unknown): boolean => e instanceof HttpError && e.status === 400 && /매니페스트|형식|mcp_only/.test(e.message);
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `job-${i}`);

test("mcp_only S2 글 목록은 그대로 실린다 · 32개(경계-최대)까지 통과", () => {
  assert.deepEqual(mcpOnlyIn(parseAppManifest(withMcpOnly(["answer"]))), ["answer"]);
  assert.deepEqual(mcpOnlyIn(parseAppManifest(withMcpOnly(names(32)))), names(32));
});

test("mcp_only S2 33개(경계-위)면 매니페스트 오류", () => {
  assert.throws(() => parseAppManifest(withMcpOnly(names(33))), manifestErr);
});

test("mcp_only S2 배열이 아니거나 글이 아닌 항목이 있으면 매니페스트 오류", () => {
  for (const bad of ["answer", { answer: true }, 1, true, null]) {
    assert.throws(() => parseAppManifest(withMcpOnly(bad)), manifestErr, `배열 아님: ${JSON.stringify(bad)}`);
  }
  for (const bad of [[1], [null], [["answer"]], [{ name: "answer" }], ["answer", 2]]) {
    assert.throws(() => parseAppManifest(withMcpOnly(bad)), manifestErr, `글 아닌 항목: ${JSON.stringify(bad)}`);
  }
});

test("mcp_only S2 선언 여부는 보지 않는다 — 선언 안 한 이름 · 작업 선언이 아예 없어도 저장된 그대로 읽힌다", () => {
  assert.deepEqual(mcpOnlyIn(parseAppManifest({ ...base(), ai: { jobs: [], mcp_only: ["gone"] } })), ["gone"]);
  assert.deepEqual(mcpOnlyIn(parseAppManifest({ ...base(), ai: { mcp_only: ["answer", "typo"] } })), ["answer", "typo"]);
});

test("mcp_only S3 없거나 빈 목록이면 종전대로 통과(«MCP 만» 작업 없음)", () => {
  assert.deepEqual(mcpOnlyIn(parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer" }] } })) ?? [], []);
  assert.deepEqual(mcpOnlyIn(parseAppManifest(withMcpOnly([]))) ?? [], []);
});

// ── ai.tools — 작업별 라이블리 도구 허용 목록(도구 허용 목록 사양 T1 · T3 · T4) ──
//  모양(작업 이름 → 도구 이름 글 배열 · 배열마다 64개까지)만 본다 — 뜻(선언한 작업 · 정확한 이름 · 요청한 도구 · T2)은 설치 · 판 저장 때 loader 가 본다.
//  이게 틀리면: 저장된 매니페스트를 다시 읽는 자리(동의 · 인스턴스 · 워커)가 400 으로 막히거나, 모양이 틀린 목록이 저장돼 작업 토큰이 엉뚱하게 좁혀진다.
import { toolsOf } from "./app-job-tools.js";
const withTools = (tools: unknown): Record<string, unknown> => ({ ...base(), ai: { jobs: [{ name: "answer" }, { name: "lookup" }], tools } });
const toolsIn = (m: unknown): unknown => (m as { ai?: { tools?: unknown } }).ai?.tools;
const toolsErr = (e: unknown): boolean => e instanceof HttpError && e.status === 400 && /매니페스트|형식|tools/.test(e.message);
const toolNames = (n: number): string[] => Array.from({ length: n }, (_, i) => `tool_${i}`);

test("T1 ai.tools — 작업 이름 → 도구 이름 배열이 그대로 실린다(작업 여럿)", () => {
  const tools = { answer: ["store_sql", "knowledge_search"], lookup: ["knowledge_get"] };
  assert.deepEqual(toolsIn(parseAppManifest(withTools(tools))), tools);
});

test("T1 배열마다 64개(경계-최대)까지 통과", () => {
  assert.deepEqual(toolsIn(parseAppManifest(withTools({ answer: toolNames(64), lookup: toolNames(64) }))), { answer: toolNames(64), lookup: toolNames(64) });
});

test("T1 65개(경계-위)면 매니페스트 오류 — 다른 작업의 배열이 짧아도", () => {
  assert.throws(() => parseAppManifest(withTools({ answer: toolNames(65) })), toolsErr);
  assert.throws(() => parseAppManifest(withTools({ answer: ["store_sql"], lookup: toolNames(65) })), toolsErr);
});

test("T1 작업의 값이 배열이 아니면 매니페스트 오류", () => {
  for (const bad of ["store_sql", { store_sql: true }, { 0: "store_sql", length: 1 }, 1, true, null]) {
    assert.throws(() => parseAppManifest(withTools({ answer: bad })), toolsErr, `배열 아님: ${JSON.stringify(bad)}`);
  }
});

test("T1 도구 이름이 문자열이 아닌 원소가 있으면 매니페스트 오류", () => {
  for (const bad of [[1], [null], [["store_sql"]], [{ name: "store_sql" }], ["store_sql", 2]]) {
    assert.throws(() => parseAppManifest(withTools({ answer: bad })), toolsErr, `문자열 아닌 원소: ${JSON.stringify(bad)}`);
  }
});

test("T1 ai.tools 가 객체가 아니면(글 · 배열 · 수) 매니페스트 오류", () => {
  for (const bad of ["store_sql", ["store_sql"], [["answer", ["store_sql"]]], 3]) {
    assert.throws(() => parseAppManifest(withTools(bad)), toolsErr, `객체 아님: ${JSON.stringify(bad)}`);
  }
});

test("T1 뜻(T2)은 보지 않는다 — 선언 안 한 작업 이름 · 글롭 · 이름 꼴 밖 · 요청하지 않은 도구 · 작업 선언이 없어도 저장된 그대로 읽힌다", () => {
  const odd = { gone: ["store_*", "not requested", "a".repeat(200)], answer: ["never_requested_tool"] };
  assert.deepEqual(toolsIn(parseAppManifest({ ...base(), ai: { jobs: [], tools: odd } })), odd, "작업 선언이 빈 앱");
  assert.deepEqual(toolsIn(parseAppManifest({ ...base(), ai: { tools: { answer: ["store_sql"] } } })), { answer: ["store_sql"] }, "ai.jobs 가 아예 없는 앱");
});

test("T3 빈 배열(도구 0)도 그대로 실린다 — 목록 읽기에서 null 이 아니라 빈 목록", () => {
  const m = parseAppManifest(withTools({ answer: [] }));
  assert.deepEqual(toolsIn(m), { answer: [] });
  assert.deepEqual(toolsOf(m, "answer"), [], "빈 목록 = 라이블리 도구를 하나도 쓰지 못한다");
});

test("T4 ai.tools 가 없거나 그 작업 이름이 키에 없으면 좁히지 않는다(종전 매니페스트 무회귀)", () => {
  const none = parseAppManifest({ ...base(), ai: { jobs: [{ name: "answer" }] } });
  assert.equal(toolsOf(none, "answer"), null);
  assert.equal(toolsOf(parseAppManifest(base()), "answer"), null, "ai 칸 자체가 없는 앱");
  assert.equal(toolsOf(parseAppManifest(withTools({ lookup: ["knowledge_get"] })), "answer"), null, "다른 작업만 목록이 있다");
});

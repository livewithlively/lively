import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memberAppViolations, editDenial } from "./member-app.js";
import { parseAppManifest } from "./manifest.js";
import type { OrgApp } from "../org/store/apps.js";

// ── 구성원이 저장하는 앱 (#4225, 사양 표 S7·S8) ─────────────────────────────────────
//  이게 틀리면: S7 이 새면 아무 구성원이 다른 사람 컴퓨터에서 도는 훅·정기 작업·서버 코드를 심는다 ·
//   S8 이 새면 지정한 사람만 고치게 해 둔 앱을 아무나 덮어쓰거나, 관리자가 넓게 설치한 앱을 저장 한 번으로 걷어 낸다.

const base = { id: "memo", title: "메모", version: "1.0.0", ui: { pages: [{ key: "main", title: "메모", entry: "ui/index.html" }] },
  data: { tables: [{ name: "notes", columns: [{ name: "text", type: "text" }] }] } };
const m = (extra: Record<string, unknown> = {}) => parseAppManifest({ ...base, ...extra });

test("S7-1 화면·테이블·라이블리 도구·scopes·알림·frame/resource 도메인만 → 위반 0(허용 경계)", () => {
  assert.deepEqual(memberAppViolations(m({
    permissions: { scopes: ["memory"], tools: ["store_*", "knowledge_search"], notifications: true },
    csp: { frame_domains: ["example.com"], resource_domains: ["cdn.example.com"] },
    instances: { project: "optional", multiplicity: "multiple" },
  })), []);
});

test("S7-2~12 화면·데이터 밖의 선언은 하나씩 전부 위반으로 나온다", () => {
  const rows: Array<[string, Record<string, unknown>]> = [
    ["harness", { harness: { plugin: "./" } }],
    ["tools.mcp_servers", { tools: { mcp_servers: [{ name: "x" }] } }],
    ["tools.http_tools", { tools: { http_tools: [{ name: "x" }] } }],
    ["permissions.ext_tools", { permissions: { ext_tools: ["ext__slack__*"] } }],
    ["permissions.hosts", { permissions: { hosts: ["api.example.com"] } }],
    ["permissions.db_sources", { permissions: { db_sources: ["src.crm"] } }],
    ["runtime", { runtime: { entry: "worker.mjs" } }],
    ["jobs", { jobs: [{ key: "daily", schedule: "0 9 * * *", run: { kind: "headless", prompt: "hi" } }] }],
    ["sections", { sections: [{ key: "persona", file: "persona.md" }] }],
    ["system", { system: { renderer: "browser" } }],
    ["csp.connect_domains", { csp: { connect_domains: ["api.example.com"] } }],
  ];
  for (const [what, extra] of rows) {
    const v = memberAppViolations(m(extra));
    assert.equal(v.length, 1, `${what}: 위반이 하나여야 하는데 ${JSON.stringify(v)}`);
    assert.ok(v[0].startsWith(what.split(".")[0]), `${what}: 위반 이름이 그 선언을 가리켜야 한다 — ${v[0]}`);
  }
});

const app = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "memo", title: "메모", version: "1.0.0", manifest: base, source: { kind: "inline" }, content_hash: null,
  status: "active", enabled: true, installed_by: "alice", installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], ...over,
});
const ok = m();
const bob = { userId: "bob", scopes: ["memory"] };
const admin = { userId: "root", scopes: ["memory", "admin"] };

test("S8-1 빌트인 앱은 누구도 못 고친다(관리자도)", () => {
  assert.ok(editDenial(app({ source: { kind: "builtin" } }), admin, ok));
  assert.ok(editDenial(app({ source: { kind: "builtin" } }), bob, ok));
});

test("S8-2 저장된 매니페스트가 확장 앱이면 app_save 로 못 고친다 — 저장하면 그 전개물이 걷힌다", () => {
  assert.ok(editDenial(app(), bob, m({ harness: { plugin: "./" } })));
  assert.ok(editDenial(app(), admin, m({ jobs: [{ key: "d", schedule: "0 9 * * *", run: { kind: "headless", prompt: "x" } }] })));
});

test("S8-3 저장된 매니페스트를 못 읽었으면(null) 막는다 — 모르면 막는다", () => {
  assert.ok(editDenial(app(), bob, null));
  assert.ok(editDenial(app(), admin, null));
});

test("S8-4 기본(전원) — 아무 구성원이나 고친다", () => {
  assert.equal(editDenial(app({ edit_mode: "all" }), bob, ok), null);
});

test("S8-5·6·7 지정한 사람만 — 명단 안은 된다 · 관리자는 명단 밖이어도 된다 · 그 밖은 안 된다", () => {
  const a = app({ edit_mode: "members", edit_members: ["carol"] });
  assert.equal(editDenial(a, { userId: "carol", scopes: [] }, ok), null);
  assert.equal(editDenial(a, admin, ok), null);
  assert.ok(editDenial(a, bob, ok));
});

test("S8-8 지정인데 명단이 비었다(경계) — 일반은 안 되고 관리자만", () => {
  const a = app({ edit_mode: "members", edit_members: [] });
  assert.ok(editDenial(a, bob, ok));
  assert.equal(editDenial(a, admin, ok), null);
});

test("S7-13 app_save 로 화면·데이터 밖을 선언한 묶음을 보내면 403 — DB 에 닿기 전에", async () => {
  const { appCapabilities } = await import("../capabilities/apps.js");
  const cap = appCapabilities.find((c) => c.name === "app_save");
  assert.ok(cap, "app_save 가 등록돼 있다");
  assert.equal(cap!.scope, null, "구성원 누구나 — scope 없음");
  const home = mkdtempSync(path.join(tmpdir(), "app-save-"));
  try {
    const files = [
      { path: "lively-app.json", content: JSON.stringify({ ...base, harness: { plugin: "./" } }) },
      { path: "ui/index.html", content: "<!doctype html><p>x</p>" },
    ];
    let status: unknown = "ok";
    try { await cap!.handler({ files }, { userId: "bob", email: "b@x", scopes: ["memory"], projects: ["*"] }, { source: "mcp" }); }
    catch (e) { status = (e as { status?: number }).status ?? (e as Error).message; }
    assert.equal(status, 403);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

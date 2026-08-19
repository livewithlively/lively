import { strict as assert } from "node:assert";
import test from "node:test";
import { planDeclaredComponents, diffComponents, type AppComponentRef } from "./install-plan.js";
import { parseAppManifest } from "./manifest.js";

function mani(patch: Record<string, unknown> = {}): ReturnType<typeof parseAppManifest> {
  return parseAppManifest({ id: "slack-dash", title: "T", version: "1.0.0", ...patch });
}

test("빈 매니페스트 → 구성요소 0", () => {
  assert.deepEqual(planDeclaredComponents(mani()), []);
});

test("ui.pages/widgets → ui_page/ui_widget (ref=key)", () => {
  const m = mani({ ui: { pages: [{ key: "main", title: "M", entry: "i.html" }], widgets: [{ key: "sum", title: "S", entry: "w.html" }] } });
  const c = planDeclaredComponents(m);
  assert.ok(c.some((x) => x.kind === "ui_page" && x.ref === "main"));
  assert.ok(c.some((x) => x.kind === "ui_widget" && x.ref === "sum"));
});

test("jobs → cron (ref 앱 스코프 `app:<id>:<key>` — 워크스페이스 간/앱 간 크론 이름 충돌 방지)", () => {
  const m = mani({ jobs: [{ key: "agg", schedule: "0 * * * *", run: { kind: "headless", prompt: "x" } }] });
  const c = planDeclaredComponents(m);
  const cron = c.find((x) => x.kind === "cron");
  assert.equal(cron?.ref, "app:slack-dash:agg");
  assert.equal(cron?.orig_name, "agg");
});

test("data.tables → data_table (ref=테이블명)", () => {
  const m = mani({ data: { tables: [{ name: "stats", columns: [{ name: "c", type: "int" }] }] } });
  assert.ok(planDeclaredComponents(m).some((x) => x.kind === "data_table" && x.ref === "stats"));
});

test("hosts → host (소문자 정규화)", () => {
  const m = mani({ permissions: { hosts: ["API.X.com"] } });
  assert.ok(planDeclaredComponents(m).some((x) => x.kind === "host" && x.ref === "api.x.com"));
});

test("mcp_servers/http_tools → appAssetId 로 접힌 ref + orig_name 보존", () => {
  const m = mani({ tools: { mcp_servers: [{ name: "myserver", url: "https://x" }], http_tools: [{ name: "mytool" }] } });
  const c = planDeclaredComponents(m);
  const srv = c.find((x) => x.kind === "mcp_server");
  const tool = c.find((x) => x.kind === "tool");
  assert.match(srv!.ref, /^app-[0-9a-f]{10}-myserver$/);
  assert.equal(srv!.orig_name, "myserver");
  assert.match(tool!.ref, /^app-[0-9a-f]{10}-mytool$/);
  assert.equal(tool!.orig_name, "mytool");
});

test("mcp_server 에 name 없으면 400", () => {
  const m = mani({ tools: { mcp_servers: [{ url: "https://x" }] } });
  assert.throws(() => planDeclaredComponents(m), /name 이 필요/);
});

test("sections → section (appAssetId ref)", () => {
  const m = mani({ sections: [{ key: "persona", file: "p.md" }] });
  const sec = planDeclaredComponents(m).find((x) => x.kind === "section");
  assert.match(sec!.ref, /^app-[0-9a-f]{10}-persona$/);
  assert.equal(sec!.orig_name, "persona");
});

// ── diffComponents (design R2-5) ──────────────────────────────────────────────
const A: AppComponentRef = { kind: "host", ref: "a.com" };
const B: AppComponentRef = { kind: "host", ref: "b.com" };
const C: AppComponentRef = { kind: "tool", ref: "app-xxxxxxxxxx-t" };

test("diff: 신규만 → add", () => {
  const d = diffComponents([], [A, B]);
  assert.equal(d.add.length, 2); assert.equal(d.keep.length, 0); assert.equal(d.drop.length, 0);
});

test("diff: 교집합 → keep, 빠진 것 → drop, 새 것 → add", () => {
  const d = diffComponents([A, B], [A, C]);
  assert.deepEqual(d.keep.map((r) => r.ref), ["a.com"]);
  assert.deepEqual(d.add.map((r) => r.ref), ["app-xxxxxxxxxx-t"]);
  assert.deepEqual(d.drop.map((r) => r.ref), ["b.com"]); // 빠진 b.com 은 삭제가 아니라 disable 대상
});

test("diff: 같은 ref 다른 kind 는 다른 것으로 취급", () => {
  const host: AppComponentRef = { kind: "host", ref: "x" };
  const tool: AppComponentRef = { kind: "tool", ref: "x" };
  const d = diffComponents([host], [tool]);
  assert.equal(d.drop.length, 1); assert.equal(d.add.length, 1);
});

test("diff: 완전 동일 → 전부 keep(내용 재upsert 대상)", () => {
  const d = diffComponents([A, B], [A, B]);
  assert.equal(d.keep.length, 2); assert.equal(d.drop.length, 0); assert.equal(d.add.length, 0);
});

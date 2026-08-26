import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAppPackage } from "./loader.js";

async function stage(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "app-load-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}
const MANIFEST = (extra: Record<string, unknown> = {}) => JSON.stringify({ id: "hello", title: "T", version: "1.0.0", harness: { plugin: "./" }, ...extra });

test("lively-app.json 없으면 400", async () => {
  const d = await stage({ "readme.md": "x" });
  await assert.rejects(() => loadAppPackage(d), /lively-app\.json 이 없/);
  await rm(d, { recursive: true });
});

test("스킬 트리 → harness_asset(skill) item + content_hash", async () => {
  const d = await stage({ "lively-app.json": MANIFEST(), "skills/greet/SKILL.md": "# greet\nhi" });
  const loaded = await loadAppPackage(d);
  assert.match(loaded.contentHash, /^[0-9a-f]{64}$/);
  const ha = loaded.items.find((i) => i.comp.kind === "harness_asset");
  assert.ok(ha, "harness_asset 있어야");
  assert.equal(ha!.comp.orig_name, "greet");
  assert.match(ha!.comp.ref, /^app-[0-9a-f]{10}-greet$/);
  assert.deepEqual((ha!.payload as Record<string, unknown>).kind, "skill");
  assert.equal((ha!.payload as Record<string, unknown>).harness, "all");   // #1884 — 앱 자산은 하네스를 가리지 않는다
  assert.ok(String((ha!.payload as Record<string, unknown>).body).includes("# greet"));
});

test("agents/commands 파일 레이아웃 → subagent/command", async () => {
  const d = await stage({ "lively-app.json": MANIFEST(), "agents/rev.md": "a", "commands/do.md": "c" });
  const loaded = await loadAppPackage(d);
  const kinds = loaded.items.filter((i) => i.comp.kind === "harness_asset").map((i) => (i.payload as Record<string, unknown>).kind).sort();
  assert.deepEqual(kinds, ["command", "subagent"]);
});

test("ui.pages → ui_page item(저널만, payload null) + entry HTML 은 uiAssets 로 보존", async () => {
  // PR5 — loader 가 이제 entry 파일을 읽어 uiAssets 에 담는다. 파일이 없으면 로드 실패(선언한 UI 는 실려야 한다).
  const d = await stage({
    "lively-app.json": MANIFEST({ ui: { pages: [{ key: "main", title: "M", entry: "ui/i.html" }] } }),
    "ui/i.html": "<!doctype html><title>M</title><body>hi</body>",
  });
  const loaded = await loadAppPackage(d);
  const ui = loaded.items.find((i) => i.comp.kind === "ui_page");
  assert.ok(ui); assert.equal(ui!.payload, null);          // component 는 저널만(payload null) — 종전 계약 유지
  assert.equal(loaded.uiAssets.length, 1);                  // entry HTML 은 uiAssets 로
  assert.equal(loaded.uiAssets[0].page_key, "main");
  assert.equal(loaded.uiAssets[0].kind, "page");
  assert.match(loaded.uiAssets[0].html, /hi<\/body>/);
  await rm(d, { recursive: true });
});

test("ui.pages entry 파일이 없으면 로드 실패(선언한 UI 는 실려야 한다)", async () => {
  const d = await stage({ "lively-app.json": MANIFEST({ ui: { pages: [{ key: "main", title: "M", entry: "ui/missing.html" }] } }) });
  await assert.rejects(() => loadAppPackage(d), /ui entry 파일이 없습니다/);
  await rm(d, { recursive: true });
});

test("ui entry 경로탈출 거부", async () => {
  const d = await stage({ "lively-app.json": MANIFEST({ ui: { pages: [{ key: "main", title: "M", entry: "../evil.html" }] } }) });
  await assert.rejects(() => loadAppPackage(d), /패키지 밖/);
  await rm(d, { recursive: true });
});

test("runtime worker entry 는 설치할 단일 ESM 번들로 실제 존재해야 한다", async () => {
  const ok = await stage({
    "lively-app.json": MANIFEST({ runtime: { entry: "dist/worker.mjs", placement: "any" } }),
    "dist/worker.mjs": "export default {};",
  });
  const loaded = await loadAppPackage(ok);
  assert.equal(loaded.manifest.runtime?.entry, "dist/worker.mjs");
  assert.equal(loaded.runtimeAsset?.entry, "dist/worker.mjs");
  assert.equal(loaded.runtimeAsset?.code.toString("utf8"), "export default {};");
  assert.match(loaded.runtimeAsset?.code_hash ?? "", /^[0-9a-f]{64}$/);
  const runtime = loaded.items.find((i) => i.comp.kind === "runtime_worker");
  assert.equal(runtime?.comp.ref, "dist/worker.mjs");
  assert.equal((runtime?.payload as { package_hash?: string }).package_hash, loaded.contentHash);
  await rm(ok, { recursive: true });

  const missing = await stage({ "lively-app.json": MANIFEST({ runtime: { entry: "dist/missing.mjs" } }) });
  await assert.rejects(() => loadAppPackage(missing), /runtime entry 파일이 없습니다/);
  await rm(missing, { recursive: true });
});

test("jobs → cron item(payload=schedule+run)", async () => {
  const d = await stage({ "lively-app.json": MANIFEST({ jobs: [{ key: "agg", schedule: "0 * * * *", run: { kind: "headless", prompt: "x" } }] }) });
  const loaded = await loadAppPackage(d);
  const cron = loaded.items.find((i) => i.comp.kind === "cron");
  assert.equal((cron!.payload as Record<string, unknown>).schedule, "0 * * * *");
  await rm(d, { recursive: true });
});

test("mcp_server payload = 매니페스트 항목(name 으로 매칭)", async () => {
  const d = await stage({ "lively-app.json": MANIFEST({ tools: { mcp_servers: [{ name: "srv", url: "https://x" }] } }) });
  const loaded = await loadAppPackage(d);
  const srv = loaded.items.find((i) => i.comp.kind === "mcp_server");
  assert.equal((srv!.payload as Record<string, unknown>).url, "https://x");
  await rm(d, { recursive: true });
});

test("plugin 경로 패키지 밖 → 거부(경로 탈출)", async () => {
  const d = await stage({ "lively-app.json": MANIFEST({ harness: { plugin: "../.." } }) });
  await assert.rejects(() => loadAppPackage(d), /패키지 밖/);
  await rm(d, { recursive: true });
});

test("스킬 트리 심링크 → content_hash 단계에서 거부(R2-3)", async () => {
  const d = await stage({ "lively-app.json": MANIFEST(), "skills/greet/SKILL.md": "x", "real.txt": "y" });
  await symlink(path.join(d, "real.txt"), path.join(d, "link.txt"));
  await assert.rejects(() => loadAppPackage(d), /심링크/);
  await rm(d, { recursive: true });
});

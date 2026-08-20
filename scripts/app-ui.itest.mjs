// 앱 UI 보존·서빙 실-DB 스모크 (#1780 PR5) — 설치가 entry HTML 을 org_app_ui_asset 에 보존하고,
//  org_app_ui 가 그 HTML 을 서빙하며, 앱 제거 시 UI 자산 명시 삭제 로 사라지는지 본다. fail-first: UI 보존/서빙은 이 PR 이전 없었다.
//  ⚠ 수동 실행(docker):  node scripts/app-ui.itest.mjs
import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 59465, CNAME = "co-app-ui-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

let fx = null;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { appCapabilities } = await import("../dist/capabilities/apps.js");
  const { getUiAsset, setAppEnabled } = await import("../dist/org/store/apps.js");

  await initAllSchemas();
  ok("스키마 체인 완주(org_app_ui_asset 포함)");

  const installCap = appCapabilities.find((c) => c.name === "org_app_install");
  const removeCap = appCapabilities.find((c) => c.name === "org_app_remove");
  const uiCap = appCapabilities.find((c) => c.name === "org_app_ui");
  assert.ok(installCap && removeCap && uiCap, "install/remove/ui 능력 존재");
  ok("org_app_ui 능력 존재");

  const user = { userId: "admin", memberId: "admin", email: "", scopes: ["admin", "context"], projects: ["*"] };
  const ctx = { source: "test" };

  // 픽스처 앱: ui page 1개(main → ui/index.html)
  fx = await mkdtemp(path.join(os.tmpdir(), "ui-app-"));
  await writeFile(path.join(fx, "lively-app.json"), JSON.stringify({
    id: "uiapp", title: "UI 앱", version: "0.1.0", permissions: { scopes: ["context"] },
    ui: { pages: [{ key: "main", title: "메인", entry: "ui/index.html" }] },
  }));
  await mkdir(path.join(fx, "ui"), { recursive: true });
  const MARKER = "MARKER-9f3a";
  await writeFile(path.join(fx, "ui", "index.html"), `<!doctype html><title>메인</title><body><h1>${MARKER}</h1></body>`);

  await installCap.handler({ source: { kind: "path", path: fx } }, user, ctx);
  ok("설치 완료");

  // ── 보존: org_app_ui_asset 에 html ──
  const stored = await getUiAsset("uiapp", "main");
  assert.ok(stored && stored.html.includes(MARKER), "설치가 entry HTML 을 org_app_ui_asset 에 보존");
  assert.equal(stored.kind, "page", "kind=page");
  ok("보존: entry HTML → org_app_ui_asset");

  // ── 서빙: org_app_ui (page 지정) ──
  const served = await uiCap.handler({ app_id: "uiapp", page: "main" }, user, ctx);
  assert.ok(served.html.includes(MARKER), "org_app_ui 가 HTML 서빙");
  assert.equal(served.page_key, "main");
  assert.ok(Array.isArray(served.pages) && served.pages.length === 1, "pages 목록 포함");
  ok("서빙: org_app_ui(page=main) → HTML + pages");

  // ── 기본 페이지(page 미지정) = 첫 페이지 ──
  const def = await uiCap.handler({ app_id: "uiapp" }, user, ctx);
  assert.equal(def.page_key, "main", "page 미지정 → 첫 페이지");
  ok("서빙: page 미지정 → 첫 페이지");

  // ── 비활성 앱은 409 ──
  await setAppEnabled("uiapp", false, { actor: "test" });
  await assert.rejects(() => uiCap.handler({ app_id: "uiapp" }, user, ctx), /활성|409|active/i, "비활성 앱 UI 는 409");
  ok("비활성 앱 UI → 409");
  await setAppEnabled("uiapp", true, { actor: "test" });

  // ── 제거 시 UI 자산 명시 삭제 ──
  await removeCap.handler({ app_id: "uiapp" }, user, ctx);
  assert.equal(await getUiAsset("uiapp", "main"), null, "앱 제거 시 UI 자산 삭제");
  ok("제거: UI 자산 삭제");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  if (fx) await rm(fx, { recursive: true, force: true }).catch(() => {});
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}

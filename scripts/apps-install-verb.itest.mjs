// 앱 설치/제거 verb 실-DB 스모크 (#1780) — org_app_install(path) → org_app_remove 왕복이 실제로
//  ① 스테이지→로드→저널드 전개(하네스 자산 실전개) ② 재설치=업데이트(멱등) ③ 제거=전개물 회수+레지스트리 삭제
//  ④ builtin 은 제거 차단(409) 을 타는지 본다. 순수 유닛(install.test)은 오케스트레이션만, 이 스모크는
//  stageAppSource→loadAppPackage→installLoadedApp→makeDeployDeps.reclaim 왕복이 실제 스토어를 타는지 본다.
//  ⚠ 수동 실행(docker):  node scripts/apps-install-verb.itest.mjs  (*.itest.mjs 라 run-tests 제외)
//  fail-first: 이 verb(org_app_install/remove)는 이 PR 이전엔 없었다 → import 자체가 red 였다.
import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 59463, CNAME = "co-app-install-verb-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

let fixture = null;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { appCapabilities } = await import("../dist/capabilities/apps.js");
  const { getApp, listComponents } = await import("../dist/org/store/apps.js");
  const { seedBuiltinApps } = await import("../dist/apps/seed.js");

  await initAllSchemas();
  ok("스키마 체인 완주");

  const installCap = appCapabilities.find((c) => c.name === "org_app_install");
  const removeCap = appCapabilities.find((c) => c.name === "org_app_remove");
  assert.ok(installCap && removeCap, "org_app_install/remove 능력 존재(= 이 PR 로 생김)");
  ok("설치/제거 verb 능력 존재");

  const user = { userId: "admin", memberId: "admin", email: "", scopes: ["admin", "context"], projects: ["*"] };
  const ctx = { source: "test" };

  // ── 픽스처 앱 패키지: id=itest-inst, 스킬 1개(hi) ──
  fixture = await mkdtemp(path.join(os.tmpdir(), "itest-app-src-"));
  await writeFile(path.join(fixture, "lively-app.json"), JSON.stringify({
    id: "itest-inst", title: "설치 verb 테스트앱", version: "0.1.0",
    permissions: { scopes: ["context"], tools: ["knowledge_search"] },
  }));
  await mkdir(path.join(fixture, "skills", "hi"), { recursive: true });
  await writeFile(path.join(fixture, "skills", "hi", "SKILL.md"), "---\nname: \"hi\"\ndescription: \"인사\"\n---\n\n인사하는 스킬.\n");

  const assetCount = async () => Number((await itemsPool.query("SELECT count(*)::int AS n FROM org_harness_asset")).rows[0].n);
  const base = await assetCount();

  // ── 1) 설치(path) — created + 스킬 실전개 ──
  const r1 = await installCap.handler({ source: { kind: "path", path: fixture } }, user, ctx);
  assert.equal(r1.created, true, "신규 설치 created=true");
  assert.ok(r1.components >= 1, `component 전개 ≥1 (실제 ${r1.components})`);
  const app1 = await getApp("itest-inst");
  assert.ok(app1 && app1.status === "active", `설치 후 status=active (실제 ${app1?.status})`);
  const comps1 = await listComponents("itest-inst");
  assert.ok(comps1.some((c) => c.kind === "harness_asset"), "harness_asset(스킬) component 기록됨");
  assert.equal(await assetCount(), base + 1, "org_harness_asset +1(스킬 실전개)");
  ok("설치(path): active + 스킬 실전개 + 조인 기록");

  // ── 2) 재설치 = 업데이트(멱등) — created=false, 자산 안 늘어남 ──
  const r2 = await installCap.handler({ source: { kind: "path", path: fixture } }, user, ctx);
  assert.equal(r2.created, false, "재설치 created=false(업데이트)");
  assert.equal(await assetCount(), base + 1, "재설치 후 자산 그대로(멱등)");
  ok("재설치: 업데이트(멱등) — 자산 중복 안 됨");

  // ── 3) 제거 — 전개물 회수 + 레지스트리 삭제 ──
  const r3 = await removeCap.handler({ app_id: "itest-inst" }, user, ctx);
  assert.equal(r3.ok, true, "제거 ok");
  assert.equal(await getApp("itest-inst"), null, "제거 후 org_app 없음");
  assert.equal((await listComponents("itest-inst")).length, 0, "제거 후 component 조인 CASCADE");
  assert.equal(await assetCount(), base, "제거 후 org_harness_asset 원복(reclaim)");
  ok("제거: 자산 회수 + 레지스트리/조인 삭제");

  // ── 4) 존재하지 않는 앱 제거 → 404 ──
  await assert.rejects(() => removeCap.handler({ app_id: "nope-nope" }, user, ctx), /없음|not|404/i, "없는 앱 제거는 거부");
  ok("없는 앱 제거 → 거부");

  // ── 5) builtin 은 제거 차단(409) ──
  await seedBuiltinApps();
  if (await getApp("hello")) {
    await assert.rejects(() => removeCap.handler({ app_id: "hello" }, user, ctx), /builtin|재시드|409/i, "builtin 제거는 차단");
    ok("builtin(hello) 제거 차단");
  } else {
    console.log("skip builtin 차단 검사(hello 시드 안 됨)");
  }

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  if (fixture) await rm(fixture, { recursive: true, force: true }).catch(() => {});
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}

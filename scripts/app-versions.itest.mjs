// 앱 판(#4600) 실-DB 스모크 — 빈 pg 에 전체 스키마를 올리고, 화면·데이터만으로 된 빌트인(픽스처 폴더)을 시딩한 뒤
//  ① app_save 로 덮어쓰기(판 1 원본 + 판 2 구성원 · source 는 kind builtin + overrides_builtin) ② 두 번째 저장(판 3) ③ app_pull 이
//  폴더의 bin/ 위에 DB 화면을 덮어 주는지 ④ 시더가 덮어쓴 앱을 다시 덮지 않는지(builtin_version 만 갱신) ⑤ app_revert 1 → 릴리스 원본
//  재설치(덮어쓰기 표식 걷힘) ⑥ revert 2 → 다시 덮어쓰기 ⑦ 보관 20 초과 시 오래된 구성원 판만 지워지는지 를 잰다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/app-versions.itest.mjs   — *.itest.mjs 라 run-tests(자동)에서 제외. 로컬 dev 맥에선 돌리지 않았다
//   (팀 규칙 — 전체 스위트·실DB 는 CI 몫). 유닛 표는 src/apps/app-versions.test.ts.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 59463, CNAME = "co-app-versions-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

// 픽스처 빌트인 — 화면 + 데이터 + bin/ 스크립트(장표 수정 앱과 같은 꼴). 폴더를 시더 root 로 준다.
const ROOT = mkdtempSync(path.join(tmpdir(), "app-versions-builtin-"));
const APP = path.join(ROOT, "memo2");
const manifest = (version) => JSON.stringify({
  id: "memo2", title: "메모2", version, publisher: { name: "Lively" },
  permissions: { scopes: [], tools: ["store_insert", "store_query"] },
  data: { tables: [{ name: "notes", columns: [{ name: "text", type: "text" }] }] },
  ui: { pages: [{ key: "main", title: "메모2", entry: "ui/index.html" }] },
}, null, 2);
mkdirSync(path.join(APP, "ui"), { recursive: true });
mkdirSync(path.join(APP, "bin"), { recursive: true });
writeFileSync(path.join(APP, "lively-app.json"), manifest("1.0.0"));
writeFileSync(path.join(APP, "ui", "index.html"), "<!doctype html><p>release 1.0.0</p>");
writeFileSync(path.join(APP, "bin", "push.mjs"), "console.log('push')");

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { seedBuiltinApps } = await import("../dist/apps/seed.js");
  const { appCapabilities } = await import("../dist/capabilities/apps.js");
  const cap = (n) => appCapabilities.find((c) => c.name === n);
  const bob = { userId: "bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
  const ctx = { source: "mcp" };

  await initAllSchemas();
  ok("전체 스키마 체인 완주(org_app_version 포함)");
  const t = await itemsPool.query(`SELECT to_regclass('public.org_app_version') AS v, to_regclass('public.org_app') AS a`);
  assert.ok(t.rows[0].v && t.rows[0].a);

  // ── 시딩 → 릴리스 그대로 ──
  const s1 = await seedBuiltinApps(ROOT);
  assert.ok(s1.seeded.includes("memo2"), JSON.stringify(s1));
  let app = (await itemsPool.query(`SELECT source, builtin_version, current_version_no, content_hash FROM org_app WHERE id='memo2'`)).rows[0];
  assert.equal(app.source.kind, "builtin"); assert.equal(app.source.overrides_builtin, undefined);
  assert.equal(app.builtin_version, "1.0.0", "시더가 릴리스 판 번호를 적는다");
  ok("시딩 — source builtin · builtin_version 1.0.0");
  const releaseHash = app.content_hash;

  // ── ① 구성원이 덮어쓴다 ──
  const files = (html, version = "1.0.0") => [{ path: "lively-app.json", content: manifest(version) }, { path: "ui/index.html", content: html }];
  const r1 = await cap("app_save").handler({ files: files("<!doctype html><p>ws 1</p>"), note: "글 줄 칸을 아래로" }, bob, ctx);
  assert.equal(r1.version_no, 2, `첫 덮어쓰기는 원본 판 1 + 구성원 판 2 (실제 ${JSON.stringify(r1.version_no)})`);
  app = (await itemsPool.query(`SELECT source, current_version_no FROM org_app WHERE id='memo2'`)).rows[0];
  assert.equal(app.source.kind, "builtin", "kind 는 builtin 유지(데이터 스키마)"); assert.equal(app.source.overrides_builtin, true);
  assert.equal(app.current_version_no, 2);
  let vs = (await cap("app_versions").handler({ app_id: "memo2" }, bob, ctx)).versions;
  assert.deepEqual(vs.map((v) => [v.version_no, v.origin, v.is_current]), [[2, "member", true], [1, "builtin", false]]);
  assert.equal(vs[1].note, "원본 · 릴리스 1.0.0"); assert.equal(vs[0].note, "글 줄 칸을 아래로");
  const ui1 = (await cap("org_app_ui").handler({ app_id: "memo2" }, bob, ctx)).html;
  assert.ok(ui1.includes("ws 1"), "서빙 화면이 바뀌었다");
  ok("① 덮어쓰기 — 판 1(원본)+판 2(구성원) · source builtin+overrides · 화면 교체");

  // ── ② 두 번째 저장 ──
  const r2 = await cap("app_save").handler({ files: files("<!doctype html><p>ws 2</p>"), note: "둘째" }, bob, ctx);
  assert.equal(r2.version_no, 3);
  ok("② 두 번째 저장 — 판 3");

  // ── ③ pull — 폴더의 bin/ 위에 DB 화면 ──
  const p = await cap("app_pull").handler({ app_id: "memo2" }, bob, ctx);
  assert.equal(p.overrides_builtin, true); assert.equal(p.from, "folder+db");
  assert.ok(p.files.find((f) => f.path === "bin/push.mjs"), "폴더의 bin/ 이 들어 있다");
  assert.ok(p.files.find((f) => f.path === "ui/index.html").content.includes("ws 2"), "화면은 DB 의 지금 판");
  ok("③ app_pull — bin/ + 지금 화면");

  // ── ④ 릴리스가 올라가도 시더는 덮지 않는다 ──
  writeFileSync(path.join(APP, "lively-app.json"), manifest("1.1.0"));
  writeFileSync(path.join(APP, "ui", "index.html"), "<!doctype html><p>release 1.1.0</p>");
  const s2 = await seedBuiltinApps(ROOT);
  assert.ok(s2.skipped.includes("memo2") && !s2.updated.includes("memo2"), JSON.stringify(s2));
  app = (await itemsPool.query(`SELECT builtin_version, source FROM org_app WHERE id='memo2'`)).rows[0];
  assert.equal(app.builtin_version, "1.1.0", "원본에 새 판이 있다는 것만 적는다");
  assert.equal(app.source.overrides_builtin, true);
  assert.ok((await cap("org_app_ui").handler({ app_id: "memo2" }, bob, ctx)).html.includes("ws 2"), "화면은 그대로 워크스페이스 판");
  ok("④ 시더 — 덮어쓴 앱은 건너뛰고 builtin_version 1.1.0 만 기록");

  // ── ⑤ 원본으로 ──
  const rv1 = await cap("app_revert").handler({ app_id: "memo2", version_no: 1 }, bob, ctx);
  assert.equal(rv1.changed, true);
  app = (await itemsPool.query(`SELECT source, current_version_no, version FROM org_app WHERE id='memo2'`)).rows[0];
  assert.equal(app.source.overrides_builtin, undefined, "덮어쓰기 표식이 걷힌다"); assert.equal(app.source.kind, "builtin");
  assert.equal(app.version, "1.1.0", "원본으로 = 지금 폴더에 실린 릴리스");
  assert.ok((await cap("org_app_ui").handler({ app_id: "memo2" }, bob, ctx)).html.includes("release 1.1.0"));
  vs = (await cap("app_versions").handler({ app_id: "memo2" }, bob, ctx)).versions;
  assert.ok(vs.some((v) => v.note === "되돌리기 직전"), "되돌리기 직전 상태도 떠 둔다");
  ok("⑤ app_revert 1 — 릴리스 원본 재설치 · 표식 걷힘");

  // ── ⑥ 다시 구성원 판으로 ──
  const rv2 = await cap("app_revert").handler({ app_id: "memo2", version_no: 2 }, bob, ctx);
  assert.equal(rv2.changed, true);
  app = (await itemsPool.query(`SELECT source, current_version_no FROM org_app WHERE id='memo2'`)).rows[0];
  assert.equal(app.source.overrides_builtin, true); assert.equal(app.current_version_no, 2);
  assert.ok((await cap("org_app_ui").handler({ app_id: "memo2" }, bob, ctx)).html.includes("ws 1"));
  ok("⑥ app_revert 2 — 다시 덮어쓰기(ws 1)");

  // ── ⑦ 보관 20 — 구성원 판만 지워지고 원본 판은 남는다 ──
  for (let i = 0; i < 24; i++) await cap("app_save").handler({ files: files(`<!doctype html><p>n${i}</p>`), note: `n${i}` }, bob, ctx);
  vs = (await cap("app_versions").handler({ app_id: "memo2" }, bob, ctx)).versions;
  assert.equal(vs.filter((v) => v.origin === "member").length, 20);
  assert.ok(vs.some((v) => v.version_no === 1 && v.origin === "builtin"), "원본 판 1 은 남는다");
  ok("⑦ 보관 — 구성원 판 20 · 원본 판 유지");

  // ── 음성: 셸 렌더러 빌트인은 못 덮는다 ──
  {
    const SYS = path.join(ROOT, "sysapp"); mkdirSync(SYS, { recursive: true });
    writeFileSync(path.join(SYS, "lively-app.json"), JSON.stringify({ id: "sysapp", title: "s", version: "1.0.0", system: { renderer: "inbox", route: "#/x" }, permissions: { scopes: [], tools: [] } }));
    await seedBuiltinApps(ROOT);
    let status = "ok";
    try { await cap("app_save").handler({ files: [{ path: "lively-app.json", content: JSON.stringify({ id: "sysapp", title: "s", version: "1.0.1", ui: { pages: [{ key: "m", title: "m", entry: "ui/i.html" }] } }) }, { path: "ui/i.html", content: "<p>x</p>" }] }, bob, ctx); }
    catch (e) { status = e.status ?? e.message; }
    assert.equal(status, 403);
    ok("음성 — 셸 렌더러 빌트인 덮어쓰기 403");
  }

  console.log(`\n모두 통과 (${pass})`);
  await itemsPool.end();
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
  rmSync(ROOT, { recursive: true, force: true });
}

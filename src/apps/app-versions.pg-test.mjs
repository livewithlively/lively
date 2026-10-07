// 앱 판(#4600) PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-versions.pg-test.mjs
//
// 화면·데이터만으로 된 빌트인(픽스처 폴더)을 시딩한 뒤 구성원이 app_save 로 덮어쓰고 → 판 이력 → 시더가 덮지 않는지 → 되돌리기 → 보관 규칙을
//  **새 DB** 위에서 끝까지 돈다(목이 아니라 initAllSchemas 를 적용한 DB · 주어진 DSN 의 서버에 전용 DB 를 만들고 끝나면 지운다).
//  유닛(app-versions.test.ts · seed-override.test.ts)은 순수 판정과 배선만 잡는다 — 실제 행·스키마·source 가 DB 에 어떻게 착지하는지는 여기.
//
//  P1 시딩 → source builtin · builtin_version   P2 app_save 덮어쓰기 → 판 1(원본)+판 2(구성원) · source builtin+overrides · 화면 교체
//  P3 두 번째 저장 → 판 3   P4 app_pull → 지금 판의 files(bin/ 포함)   P5 릴리스가 올라가도 시더는 덮지 않고 builtin_version 만
//  P6 app_revert 1 → 릴리스 원본 재설치 · 표식 걷힘 · 「되돌리기 직전」 판   P7 app_revert 2 → 다시 덮어쓰기   P8 보관 20 · 원본 유지
//  P9 셸 렌더러 빌트인 덮어쓰기 403   P10 덮어쓰기에서 새로 선언한 표는 이름 검증을 지난다(63자 초과 400)
import pg from "pg";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_versions_4600";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG — 렉시컬 폴백 */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
delete process.env.LIVELY_APP_DDL_DATABASE_URL;
delete process.env.LIVELY_OWNER_DATABASE_URL;
delete process.env.LIVELY_APP_DB_ROLE;
delete process.env.LIVELY_APP_TABLE_FUSE;
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { seedBuiltinApps } = await import(`${D}/apps/seed.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const cap = (n) => appCapabilities.find((c) => c.name === n);
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const ctx = { source: "mcp" };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;

// 픽스처 빌트인 — 화면 + 데이터 + bin/ 스크립트(장표 수정 앱과 같은 꼴)
const ROOT = mkdtempSync(path.join(tmpdir(), "pgt-app-versions-"));
const APP = path.join(ROOT, "memo2");
const manifest = (version, tables = [{ name: "notes", columns: [{ name: "text", type: "text" }] }]) => JSON.stringify({
  id: "memo2", title: "메모2", version, publisher: { name: "Lively" },
  permissions: { scopes: [], tools: ["store_insert", "store_query"] },
  data: { tables },
  ui: { pages: [{ key: "main", title: "메모2", entry: "ui/index.html" }] },
}, null, 2);
mkdirSync(path.join(APP, "ui"), { recursive: true });
mkdirSync(path.join(APP, "bin"), { recursive: true });
writeFileSync(path.join(APP, "lively-app.json"), manifest("1.0.0"));
writeFileSync(path.join(APP, "ui", "index.html"), "<!doctype html><p>release 1.0.0</p>");
writeFileSync(path.join(APP, "bin", "push.mjs"), "console.log('push')");
const files = (html, version = "1.0.0", extra = []) => [{ path: "lively-app.json", content: manifest(version) }, { path: "ui/index.html", content: html }, ...extra];
const ui = async () => (await cap("org_app_ui").handler({ app_id: "memo2" }, bob, ctx)).html;
const versions = async () => (await cap("app_versions").handler({ app_id: "memo2" }, bob, ctx)).versions;
const app = async () => (await q(`SELECT source, builtin_version, current_version_no, content_hash, version FROM org_app WHERE id='memo2'`))[0];

try {
  // P1
  const s1 = await seedBuiltinApps(ROOT);
  let a = await app();
  chk("P1 시딩 — source builtin · builtin_version 1.0.0", s1.seeded.includes("memo2") && a.source.kind === "builtin" && a.source.overrides_builtin === undefined && a.builtin_version === "1.0.0", JSON.stringify({ s1, a }));

  // P2
  const r1 = await cap("app_save").handler({ files: files("<!doctype html><p>ws 1</p>", "1.0.0", [{ path: "bin/push.mjs", content: "console.log('ws push')" }]), note: "글 줄 칸을 아래로" }, bob, ctx);
  a = await app();
  let vs = await versions();
  chk("P2 덮어쓰기 — 판 1(원본)+판 2(구성원) · source builtin+overrides · 화면 교체",
    r1.version_no === 2 && a.source.kind === "builtin" && a.source.overrides_builtin === true && a.current_version_no === 2
      && JSON.stringify(vs.map((v) => [v.version_no, v.origin, v.is_current])) === JSON.stringify([[2, "member", true], [1, "builtin", false]])
      && vs[1].note === "원본 · 릴리스 1.0.0" && vs[0].note === "글 줄 칸을 아래로" && (await ui()).includes("ws 1"),
    JSON.stringify({ r1: r1.version_no, a, vs }));

  // P3
  const r2 = await cap("app_save").handler({ files: files("<!doctype html><p>ws 2</p>", "1.0.0", [{ path: "bin/push.mjs", content: "console.log('ws push 2')" }]), note: "둘째" }, bob, ctx);
  chk("P3 두 번째 저장 — 판 3", r2.version_no === 3, String(r2.version_no));

  // P4 — 덮어쓴 앱의 pull 은 지금 판의 files 그대로(구성원이 고친 bin/ 이 돌아온다 · 격리 리뷰 7a)
  const p = await cap("app_pull").handler({ app_id: "memo2" }, bob, ctx);
  chk("P4 app_pull — 지금 판의 files(구성원이 고친 bin/ 포함) · from version",
    p.overrides_builtin === true && p.from === "version" && p.files.find((f) => f.path === "bin/push.mjs")?.content === "console.log('ws push 2')"
      && p.files.find((f) => f.path === "ui/index.html")?.content.includes("ws 2"), JSON.stringify({ from: p.from, paths: p.files.map((f) => f.path) }));

  // P5
  writeFileSync(path.join(APP, "lively-app.json"), manifest("1.1.0"));
  writeFileSync(path.join(APP, "ui", "index.html"), "<!doctype html><p>release 1.1.0</p>");
  const s2 = await seedBuiltinApps(ROOT);
  a = await app();
  chk("P5 시더 — 덮어쓴 앱은 건너뛰고 builtin_version 1.1.0 만 · 화면은 워크스페이스 판 그대로",
    s2.skipped.includes("memo2") && !s2.updated.includes("memo2") && a.builtin_version === "1.1.0" && a.source.overrides_builtin === true && (await ui()).includes("ws 2"),
    JSON.stringify({ s2, a }));

  // P6
  const rv1 = await cap("app_revert").handler({ app_id: "memo2", version_no: 1 }, bob, ctx);
  a = await app(); vs = await versions();
  chk("P6 app_revert 1 — 릴리스 원본(1.1.0) 재설치 · 표식 걷힘 · 「되돌리기 직전」 판",
    rv1.changed === true && a.source.overrides_builtin === undefined && a.source.kind === "builtin" && a.version === "1.1.0" && (await ui()).includes("release 1.1.0")
      && vs.some((v) => v.note === "되돌리기 직전"), JSON.stringify({ rv1: rv1.changed, a, notes: vs.map((v) => v.note) }));

  // P7
  const rv2 = await cap("app_revert").handler({ app_id: "memo2", version_no: 2 }, bob, ctx);
  a = await app();
  chk("P7 app_revert 2 — 다시 덮어쓰기(ws 1)", rv2.changed === true && a.source.overrides_builtin === true && a.current_version_no === 2 && (await ui()).includes("ws 1"), JSON.stringify(a));
  const rv2b = await cap("app_revert").handler({ app_id: "memo2", version_no: 2 }, bob, ctx);
  chk("P7b 같은 판으로 다시 — changed:false", rv2b.changed === false);

  // P8
  for (let i = 0; i < 24; i++) await cap("app_save").handler({ files: files(`<!doctype html><p>n${i}</p>`), note: `n${i}` }, bob, ctx);
  vs = await versions();
  chk("P8 보관 — 구성원 판 20 · 원본 판 1 유지", vs.filter((v) => v.origin === "member").length === 20 && vs.some((v) => v.version_no === 1 && v.origin === "builtin"),
    JSON.stringify(vs.map((v) => [v.version_no, v.origin])));

  // P9 — 셸 렌더러 빌트인은 못 덮는다
  {
    const SYS = path.join(ROOT, "sysapp"); mkdirSync(SYS, { recursive: true });
    writeFileSync(path.join(SYS, "lively-app.json"), JSON.stringify({ id: "sysapp", title: "s", version: "1.0.0", system: { renderer: "inbox", route: "#/x" }, permissions: { scopes: [], tools: [] } }));
    await seedBuiltinApps(ROOT);
    let e = null;
    try { await cap("app_save").handler({ files: [{ path: "lively-app.json", content: JSON.stringify({ id: "sysapp", title: "s", version: "1.0.1", ui: { pages: [{ key: "m", title: "m", entry: "ui/i.html" }] } }) }, { path: "ui/i.html", content: "<p>x</p>" }] }, bob, ctx); }
    catch (err) { e = err; }
    chk("P9 셸 렌더러 빌트인 덮어쓰기 403", e && e.status === 403, String(e?.message));
  }

  // P10 — 덮어쓰기에서 **새로 선언한 표**는 이름 검증을 지난다(63자 초과 → 400, 아무것도 안 바뀜)
  {
    const long = "t".repeat(70);
    const before = (await versions()).length;
    let e = null;
    try { await cap("app_save").handler({ files: [{ path: "lively-app.json", content: manifest("1.0.0", [{ name: "notes", columns: [{ name: "text", type: "text" }] }, { name: long, columns: [{ name: "a", type: "text" }] }]) }, { path: "ui/index.html", content: "<p>long</p>" }] }, bob, ctx); }
    catch (err) { e = err; }
    chk("P10 새 표 이름 검증(63자 초과) → 400 · 판 행도 남지 않는다", e && e.status === 400 && (await versions()).length === before, JSON.stringify({ status: e?.status, msg: e?.message?.slice(0, 80) }));
  }
} catch (e) { fail++; console.error("FAIL 예외 —", e); }
finally {
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch((e) => console.error("정리 실패", e));
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);

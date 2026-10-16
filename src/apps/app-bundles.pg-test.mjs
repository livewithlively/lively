// 앱 판 묶음(#4481 앱 v2-2) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-bundles.pg-test.mjs
//
// 사양 표 D — 새 DB(initAllSchemas) 위에서 끝까지 돈다. 저장소는 DB(자가호스팅 길 — S3 설정 없음): 장부 · 내용 · 정리가 같은 규칙을 탄다.
//  D1 여러 파일 앱 저장(web.root=dist) → 판 행에 파일 목록 · 장부에 지문마다 한 줄(stored) · 옛 코어 호환 사본
//  D2 앱 주소 — `/` 는 런타임을 넣은 index.html · 스크립트는 제 종류 · web.root 밖(매니페스트 · 소스)은 못 받는다 · 한 페이지 앱
//  D3 공개 판 · 초안 — 공개한 뒤 고친 판은 고친 사람의 초안 주소에서만(공개 주소는 모두에게 공개 판 · #4667) · 공개 판으로 되돌리면 초안이 걷힌다
//  D4 N → N-1 되돌리기 — 앱 주소가 앞 판의 내용을 낸다(뒤 판에만 있던 파일은 없다)
//  D5 사본 — 큰 판 내려받기는 큰 파일을 지문만 · 그 줄 그대로 새 id 로 저장 · 새 앱이 같은 파일을 낸다(장부는 한 벌)
//  D6 옛 판 옮기기 — bundle 없는 판 → 하우스키핑이 목록을 단다(files 그대로) · 30일 뒤 files 비움 · 그 뒤에도 되돌리기 · 내려받기 ·
//     매니지드인데 버킷이 없으면 미룬다
//  D7 정리 — 어떤 판도 안 가리키고 24시간 지난 파일만 지운다(가리키는 파일 · 방금 쓴 파일은 남는다)
//  D9 구성원 저장은 하네스 자산(skills/ · agents/ · commands/)을 싣지 않는다
//  D8 상한 — 워크스페이스 상한 · 파일 하나 상한을 넘는 저장은 413 이고 앱이 생기지 않는다 · 고치기는 관리자 도구(scope admin)
//  D10 화면 한 장(v1) 공개 판의 호환 사본(files)을 30일 뒤 비워도 앱 주소 · org_app_ui 가 공개 판 화면을 낸다(격리 리뷰 B2 — 살아 있는 의존으로)
//  D11 정리 후보가 «오래됐지만 살아 있는» 파일로 막히지 않는다 — 한 바퀴 볼 수(1)보다 그런 파일이 많아도 고아를 지운다(격리 리뷰 B3)
//  D12 관리자 설치도 판 파일을 설치 **전에** 둔다 — 상한에 걸리면 413 이고 앱이 안 생긴다 · 되는 설치는 판 1개 · 앱 주소가 그 판을 낸다
//  D13 정리가 S3 실패를 연달아 만나면 그 바퀴를 접는다(후보마다 한 번만 · 잠금을 오래 안 붙든다) · 실패한 줄은 이 프로세스에선 건너뛰고
//      (늘 실패하는 줄이 앞줄을 막지 않게) 나머지를 지운다 · 재기동 뒤엔 그 줄도 지운다
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로 — 앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게
import pg from "pg";
import crypto from "node:crypto";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_bundles_4481";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_APP_BUNDLE_BUCKET", "LIVELY_APP_BUNDLE_POLICY"]) delete process.env[k];
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appBundleCapabilities } = await import(`${D}/capabilities/app-bundles.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const appStore = await import(`${D}/org/store/apps.js`);
const blob = await import(`${D}/apps/app-blob-store.js`);
const { runAppBundleHousekeeping, resetAppBundleHousekeepingForTest } = await import(`${D}/apps/app-bundle-migrate.js`);
const { appFrontPage, clearFrontBundleCacheForTest, appFrontLiveDepsForTest } = await import(`${D}/apps/app-front-routes.js`);
const { signAppFront } = await import(`${D}/apps/app-front-auth.js`);
const { getMember } = await import(`${D}/org/store.js`);
const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);
const { versionFiles } = await import(`${D}/apps/app-version-files.js`);
const { launchAppFor, launchLiveDepsForTest } = await import(`${D}/capabilities/app-launch.js`);

const all = [...appCapabilities, ...appBundleCapabilities];
const cap = (n) => { const c = all.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };
const call = (n, input, user, ctx = { source: "mcp" }) => cap(n).handler(input, user, ctx);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const alice = { userId: "pgt-alice", email: "a@x", scopes: ["memory"], projects: ["*"] };
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const boss = { userId: "pgt-boss", email: "boss@x", scopes: ["memory", "admin"], projects: ["*"] };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$1,'active',$2::jsonb)`, [id, JSON.stringify(scopes)]);
}

// ── 앱 주소 — 앞단 서명 + 살아 있는 저장소(판 지문 · 목록 · 내용) ──
const ENV = { LIVELY_TENANT_HEADER_SECRET: "pgt", LIVELY_APP_DOMAIN: "lvly.app" };
const T = { id: SINGLE_TENANT_ID, slug: "pgt-ws" };
const deps = {
  env: ENV, tenant: () => T, getMember: (id) => getMember(id), getApp: (id) => appStore.getApp(id),
  listUiAssets: (id) => appStore.listUiAssets(id), getUiAsset: (id, k) => appStore.getUiAsset(id, k), getAppVersion: (id, no) => appStore.getAppVersion(id, no),
  redeem: async () => null, scripts: async () => ({ runtime: "window.lively={}", probe: "P()" }),
  versionHash: (id, no) => appStore.getAppVersionHash(id, no), versionBundle: (id, no) => appStore.getAppVersionBundle(id, no),
  readBlob: (k, h) => blob.getBlob(k, h),
};
const get = (mid, app, path, extra = {}, variant = "pub") => appFrontPage({
  "x-lvly-app-front": signAppFront("pgt", { op: "act", t: T.id, ws: T.slug, app, var: variant, mid, iat: Math.floor(Date.now() / 1000) }), ...extra,
}, path, deps);
//  초안 주소(`…-draft`) — 공개 앱에 걸린 초안은 그 초안을 고친 사람이 이 주소에서만 본다(#4667 · 설계 §13-5).
const getDraft = (mid, app, path, extra = {}) => get(mid, app, path, extra, "draft");
const text = (r) => (r.body ? r.body.toString() : String(r.html ?? ""));

const manifest = (id, o = {}) => JSON.stringify({
  id, title: o.title ?? "웹 앱", version: o.version ?? "0.1.0", permissions: { scopes: [], tools: [] }, data: { tables: [] },
  web: { root: "dist" }, ui: { pages: [{ key: "main", title: o.title ?? "웹 앱", entry: "dist/index.html" }] },
}, null, 2);
const JS = "assets/app-ab12cd34.js";
const web = (id, label, extra = []) => [
  { path: "lively-app.json", content: manifest(id) },
  { path: "src/main.ts", content: `// 소스 ${label}` },
  { path: "dist/index.html", content: `<!doctype html><title>${label}</title><script type="module" src="/${JS}"></script>` },
  { path: `dist/${JS}`, content: `console.log("${label}")` },
  { path: "dist/logo.bin", content: Buffer.from([0, 1, 254, 255]).toString("base64"), encoding: "base64" },
  ...extra,
];

try {
  // D1
  const s1 = await call("app_save", { files: web("webapp", "v1"), note: "첫 판" }, alice);
  const v1 = (await q(`SELECT * FROM org_app_version WHERE app_id='webapp' AND version_no=$1`, [s1.version_no]))[0];
  const hashes = (v1?.bundle?.files ?? []).map((f) => f.h);
  const ledger = await q(`SELECT sha256, stored, store, size FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [hashes]);
  chk("D1 여러 파일 앱 저장 — 판 행에 파일 목록(5개 · 정렬) · DB 저장소 · 장부 지문마다 stored · 호환 사본",
    s1.version_no === 1 && v1?.bundle?.v === 1 && v1.bundle.files.length === 5 && v1.bundle_store === "db" && Number(v1.bundle_bytes) > 0 && v1.bundle_at
      && v1.bundle.files.map((f) => f.p).join(",") === ["dist/assets/app-ab12cd34.js", "dist/index.html", "dist/logo.bin", "lively-app.json", "src/main.ts"].join(",")
      && ledger.length === 5 && ledger.every((x) => x.stored === true && x.store === "db") && Array.isArray(v1.files) && v1.files.length === 5,
    JSON.stringify({ s1: s1.version_no, v1: v1 && { b: v1.bundle?.files?.length, store: v1.bundle_store, files: v1.files?.length }, ledger: ledger.length }));

  // D2
  clearFrontBundleCacheForTest();
  const home = await get("pgt-alice", "webapp", "/");
  const js = await get("pgt-alice", "webapp", `/${JS}`);
  const bin = await get("pgt-alice", "webapp", "/logo.bin");
  const man = await get("pgt-alice", "webapp", "/lively-app.json");
  const src = await get("pgt-alice", "webapp", "/src/main.ts");
  const spa = await get("pgt-alice", "webapp", "/deep/route");
  chk("D2 앱 주소 — index.html(런타임 주입 · CSP 'self') · 스크립트 종류 · 바이트 그대로 · web.root 밖 404 · 한 페이지 앱",
    home.status === 200 && text(home).includes("window.lively={}") && text(home).includes("<title>v1</title>")
      && String(home.headers?.["Content-Security-Policy"]).includes("script-src 'self'")
      && js.status === 200 && js.headers?.["Content-Type"] === "text/javascript; charset=utf-8" && text(js) === 'console.log("v1")'
      && js.headers?.["Cache-Control"] === "private, max-age=31536000, immutable"
      && bin.status === 200 && Buffer.compare(bin.body, Buffer.from([0, 1, 254, 255])) === 0
      && man.status === 404 && src.status === 404 && spa.status === 200 && text(spa).includes("<title>v1</title>"),
    JSON.stringify({ home: home.status, js: [js.status, js.headers?.["Content-Type"]], bin: bin.status, man: man.status, src: src.status, spa: spa.status }));

  // D3
  await call("app_visibility_set", { app_id: "webapp", visibility: "all" }, alice);
  const s2 = await call("app_save", { files: web("webapp", "v2", [{ path: "dist/only-v2.txt", content: "new" }]), note: "둘째 판" }, alice);
  clearFrontBundleCacheForTest();
  const bobJs = text(await get("pgt-bob", "webapp", `/${JS}`));
  const alicePubJs = text(await get("pgt-alice", "webapp", `/${JS}`));
  const aliceJs = text(await getDraft("pgt-alice", "webapp", `/${JS}`));
  const bobDraft = (await getDraft("pgt-bob", "webapp", `/${JS}`)).status;
  const bobOnly = (await get("pgt-bob", "webapp", "/only-v2.txt")).status;
  const aliceOnly = (await getDraft("pgt-alice", "webapp", "/only-v2.txt")).status;
  chk("D3 공개 판 · 초안 — 공개 주소는 모두에게 1판(고친 사람 포함) · 초안 주소는 고친 사람만 2판 · 남의 초안 주소 404 · 초안에만 있는 파일은 남에게 404",
    s2.version_no === 2 && s2.state === "draft" && bobJs === 'console.log("v1")' && alicePubJs === 'console.log("v1")' && aliceJs === 'console.log("v2")'
      && bobDraft === 404 && bobOnly === 404 && aliceOnly === 200,
    JSON.stringify({ s2: [s2.version_no, s2.state], bobJs, alicePubJs, aliceJs, bobDraft, bobOnly, aliceOnly }));

  const r1 = await call("app_revert", { app_id: "webapp", version_no: 1 }, alice);
  clearFrontBundleCacheForTest();
  const afterRevert = text(await get("pgt-alice", "webapp", `/${JS}`));
  const row1 = (await q(`SELECT draft_by, current_version_no FROM org_app WHERE id='webapp'`))[0];
  chk("D3b 공개 판(1판)으로 되돌리면 초안이 걷히고 고친 사람도 1판을 본다", r1.ok === true && row1.draft_by === null && row1.current_version_no === 1 && afterRevert === 'console.log("v1")',
    JSON.stringify({ r1: r1.state, row1, afterRevert }));

  // D4
  const s3 = await call("app_save", { files: web("webapp", "v3", [{ path: "dist/only-v3.txt", content: "3" }]), note: "셋째 판", publish: true }, alice);
  clearFrontBundleCacheForTest();
  const v3js = text(await get("pgt-bob", "webapp", `/${JS}`));
  const r2 = await call("app_revert", { app_id: "webapp", version_no: s3.version_no - 1, publish: true }, alice);
  clearFrontBundleCacheForTest();
  const backJs = text(await get("pgt-bob", "webapp", `/${JS}`));
  const v3only = (await get("pgt-bob", "webapp", "/only-v3.txt")).status;
  const v2only = (await get("pgt-bob", "webapp", "/only-v2.txt")).status;
  chk("D4 N → N-1 — 3판(공개) → 2판으로 되돌려 공개하면 앱 주소가 2판을 낸다(3판에만 있던 파일 404)",
    s3.version_no === 3 && v3js === 'console.log("v3")' && r2.version_no === 2 && backJs === 'console.log("v2")' && v3only === 404 && v2only === 200,
    JSON.stringify({ s3: s3.version_no, v3js, r2: r2.version_no, backJs, v3only, v2only }));

  // D5
  const big = crypto.randomBytes(2_600_000);
  await call("app_save", { files: web("bigapp", "big", [{ path: "dist/media/big.bin", content: big.toString("base64"), encoding: "base64" }]), publish: true }, alice);
  const pulled = await call("app_pull", { app_id: "bigapp" }, bob);
  const bigLine = pulled.files.find((f) => f.path === "dist/media/big.bin");
  const manLine = pulled.files.find((f) => f.path === "lively-app.json");
  const mf = JSON.parse(manLine.content); mf.id = "bigapp-copy"; mf.title = "큰 앱 사본";
  manLine.content = JSON.stringify(mf);   // 앱 만들기 화면 makeCopy 와 같은 손질 — 다른 줄(지문만 받은 줄 포함)은 그대로 되보낸다
  const s5 = await call("app_save", { files: pulled.files, origin_app_id: "bigapp" }, bob);
  clearFrontBundleCacheForTest();
  const copyBig = await get("pgt-bob", "bigapp-copy", "/media/big.bin");
  const bigRows = await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256=$1`, [sha(big)]);
  chk("D5 사본 — 큰 판 내려받기는 큰 파일을 지문만(내용 없음) · 그 줄 그대로 새 id 로 저장 · 새 앱이 같은 바이트 · 장부는 한 벌",
    pulled.refs >= 1 && bigLine && bigLine.content === undefined && bigLine.sha256 === sha(big) && typeof manLine.content === "string"
      && s5.created === true && copyBig.status === 200 && Buffer.compare(copyBig.body ?? Buffer.alloc(0), big) === 0 && bigRows[0].n === 1,
    JSON.stringify({ refs: pulled.refs, bigLine: bigLine && { c: bigLine.content === undefined, h: bigLine.sha256?.slice(0, 8) }, s5: s5.created, copy: copyBig.status, bigRows }));

  // D6 — 옛 판(#4600 꼴): 화면 한 장 앱을 저장한 뒤 그 판을 옛 모양(bundle 없음 · files 내용)으로 되돌려 둔다.
  const oldFiles = [{ path: "lively-app.json", content: JSON.stringify({ id: "oldapp", title: "옛 앱", version: "0.1.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title: "옛 앱", entry: "ui/index.html" }] } }) },
    { path: "ui/index.html", content: "<p>옛 판 한 장</p>" }];
  await call("app_save", { files: oldFiles, note: "옛 판" }, alice);
  await call("app_save", { files: [oldFiles[0], { path: "ui/index.html", content: "<p>둘째</p>" }], note: "둘째" }, alice);
  await q(`UPDATE org_app_version SET bundle=NULL, bundle_store=NULL, bundle_bytes=NULL, bundle_at=NULL WHERE app_id='oldapp'`);
  await q(`DELETE FROM org_app_blob WHERE sha256 IN (SELECT e->>'h' FROM org_app_version v, jsonb_array_elements(COALESCE(v.bundle->'files','[]'::jsonb)) e WHERE v.app_id='oldapp')`);
  resetAppBundleHousekeepingForTest();
  //  매니지드(공용 DB)인데 버킷이 없으면 옮기지 않는다 — 공용 DB 를 가볍게 하려는 이관이 DB 저장소로 다시 쌓지 않게.
  const hk0 = await runAppBundleHousekeeping(Date.now(), { LIVELY_TENANT_HEADER_SECRET: "x" });
  const still = await q(`SELECT count(*)::int AS n FROM org_app_version WHERE app_id='oldapp' AND bundle IS NULL`);
  resetAppBundleHousekeepingForTest();
  const hk = await runAppBundleHousekeeping();
  const migrated = await q(`SELECT version_no, bundle, jsonb_array_length(files) AS nf, bundle_at FROM org_app_version WHERE app_id='oldapp' ORDER BY version_no`);
  await q(`UPDATE org_app_version SET bundle_at = now() - interval '31 days' WHERE app_id='oldapp'`);
  const hk2 = await runAppBundleHousekeeping();
  const purged = await q(`SELECT jsonb_array_length(files) AS nf FROM org_app_version WHERE app_id='oldapp' ORDER BY version_no`);
  const rv = await call("app_revert", { app_id: "oldapp", version_no: 1 }, alice);
  const uiAfter = (await call("org_app_ui", { app_id: "oldapp" }, alice)).html;
  const pullAfter = await call("app_pull", { app_id: "oldapp" }, alice);
  const v1row = await appStore.getAppVersion("oldapp", 1);
  const v1files = await versionFiles(v1row);
  chk("D6 옛 판 옮기기 — 목록을 달고 files 는 그대로 · 30일 뒤 files 비움 · 그 뒤에도 되돌리기 · 화면 · 내려받기",
    hk0.migrate_deferred === "no-bucket" && hk0.migrated === 0 && still[0].n === 2
      && hk.migrated >= 2 && migrated.every((m) => m.bundle && m.nf > 0 && m.bundle_at) && hk2.compat_purged >= 2 && purged.every((p) => p.nf === 0)
      && rv.ok === true && String(uiAfter).includes("옛 판 한 장") && pullAfter.files.some((f) => f.path === "ui/index.html" && String(f.content).includes("옛 판 한 장"))
      && v1files.some((f) => f.path === "ui/index.html" && f.content.includes("옛 판 한 장")),
    JSON.stringify({ hk0, still: still[0].n, hk, migrated: migrated.map((m) => [m.version_no, !!m.bundle, m.nf]), hk2: hk2.compat_purged, purged, rv: rv.ok }));

  // D7
  const orphan = Buffer.from("고아 " + Date.now());
  const fresh = Buffer.from("갓 쓴 고아 " + Date.now());
  await blob.storeBlobs("db", [{ h: sha(orphan), size: orphan.length, read: async () => orphan }, { h: sha(fresh), size: fresh.length, read: async () => fresh }]);
  const refH = (await q(`SELECT e->>'h' AS h FROM org_app_version v, jsonb_array_elements(v.bundle->'files') e WHERE v.app_id='webapp' LIMIT 1`))[0].h;
  await q(`UPDATE org_app_blob SET last_used_at = now() - interval '25 hours' WHERE sha256 = ANY($1::text[])`, [[sha(orphan), refH]]);
  const gc = await blob.gcBlobs();
  const left = await q(`SELECT sha256 FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [[sha(orphan), sha(fresh), refH]]);
  const leftSet = new Set(left.map((x) => x.sha256));
  chk("D7 정리 — 안 가리키고 24시간 지난 파일만 지운다 · 가리키는 파일(오래돼도) · 방금 쓴 고아는 남는다",
    gc.removed >= 1 && !leftSet.has(sha(orphan)) && leftSet.has(sha(fresh)) && leftSet.has(refH) && (await blob.getBlob("db", refH)) !== null,
    JSON.stringify({ gc, left: [...leftSet].map((h) => h.slice(0, 8)) }));

  // D9 — 구성원 저장은 앱 폴더의 skills/ · agents/ · commands/ 를 싣지 않는다(로더가 매니페스트 harness 칸 없이도 읽어 조직 전체에 깐다)
  const e9 = await errOf(call("app_save", { files: [...web("withskill", "s"), { path: "skills/evil/SKILL.md", content: "---\nname: evil\n---\n몰래" }] }, alice));
  const skillRows = await q(`SELECT count(*)::int AS n FROM org_harness_asset WHERE body LIKE '%몰래%'`).catch(() => [{ n: -1 }]);
  chk("D9 구성원 저장에 하네스 자산(skills/)이 딸려 오면 403 · 앱도 자산도 안 생긴다",
    e9?.status === 403 && String(e9?.message).includes("skills") && (await q(`SELECT id FROM org_app WHERE id='withskill'`)).length === 0 && skillRows[0].n === 0,
    JSON.stringify({ e9: [e9?.status, String(e9?.message).slice(0, 80)], skillRows }));

  // D10 — 화면 한 장 앱: 공개(1판) → 고침(2판, alice 의 초안) → 판 행의 호환 사본을 비운다(30일 하우스키핑과 같은 결과)
  const oneMan = JSON.stringify({ id: "onepage", title: "한 장", version: "0.1.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title: "한 장", entry: "ui/index.html" }] } });
  await call("app_save", { files: [{ path: "lively-app.json", content: oneMan }, { path: "ui/index.html", content: "<p>공개 판 한 장</p>" }], publish: true }, alice);
  await call("app_save", { files: [{ path: "lively-app.json", content: oneMan }, { path: "ui/index.html", content: "<p>초안 한 장</p>" }] }, alice);
  await q(`UPDATE org_app_version SET files='[]'::jsonb WHERE app_id='onepage'`);
  const live = { ...appFrontLiveDepsForTest(), env: ENV, tenant: () => T, scripts: deps.scripts };
  const hdr = (mid, app, variant = "pub") => ({ "x-lvly-app-front": signAppFront("pgt", { op: "act", t: T.id, ws: T.slug, app, var: variant, mid, iat: Math.floor(Date.now() / 1000) }) });
  clearFrontBundleCacheForTest();
  const bobOne = await appFrontPage(hdr("pgt-bob", "onepage"), "/", live);
  const aliceOne = await appFrontPage(hdr("pgt-alice", "onepage", "draft"), "/", live);
  const bobUi = await call("org_app_ui", { app_id: "onepage" }, bob);
  //  앱 주소 열기(launch)도 같은 자리에서 — 살아 있는 의존 그대로(호환 사본 files 를 읽으면 화면이 없어 404 였다 · 격리 리뷰 재검토 2).
  let launched = null, launchErr = null;
  try { launched = await launchAppFor({ app_id: "onepage", mode: "embed" }, bob, { ...launchLiveDepsForTest(), env: ENV, tenant: () => T, mint: async () => ({ code: "pgt-code" }) }); } catch (e) { launchErr = e; }
  const emptied = await q(`SELECT count(*)::int AS n FROM org_app_version WHERE app_id='onepage' AND jsonb_array_length(files)=0 AND bundle IS NOT NULL`);
  chk("D10 화면 한 장 공개 판 — 호환 사본을 비워도 앱 주소 · org_app_ui 가 공개 판(파일 목록에서) · 초안을 만든 사람은 초안 주소에서 초안",
    emptied[0].n === 2 && bobOne.status === 200 && text(bobOne).includes("공개 판 한 장") && aliceOne.status === 200 && text(aliceOne).includes("초안 한 장")
      && bobUi.view === "published" && String(bobUi.html).includes("공개 판 한 장") && launched?.page_key === "main" && launched?.variant === "pub",
    JSON.stringify({ emptied: emptied[0].n, bob: [bobOne.status, text(bobOne).slice(0, 80)], alice: [aliceOne.status], ui: [bobUi.view, String(bobUi.html).slice(0, 40)], launch: launchErr ? [launchErr.status, String(launchErr.message).slice(0, 60)] : launched?.page_key }));

  // D11 — 살아 있는 파일을 모두 오래된 것으로(50시간) · 고아 하나는 30시간 → 한 바퀴 1개만 봐도 고아가 지워진다
  const orphan2 = Buffer.from("고아 둘 " + Date.now());
  await blob.storeBlobs("db", [{ h: sha(orphan2), size: orphan2.length, read: async () => orphan2 }]);
  const liveHs = (await q(`SELECT DISTINCT e->>'h' AS h FROM org_app_version v, jsonb_array_elements(v.bundle->'files') e WHERE v.bundle IS NOT NULL`)).map((x) => x.h);
  await q(`UPDATE org_app_blob SET last_used_at = now() - interval '50 hours' WHERE sha256 = ANY($1::text[])`, [liveHs]);
  await q(`UPDATE org_app_blob SET last_used_at = now() - interval '30 hours' WHERE sha256 = $1`, [sha(orphan2)]);
  const liveBefore = (await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [liveHs]))[0].n;
  const gc2 = await blob.gcBlobs({ limit: 1 });
  const orphanLeft = (await q(`SELECT 1 FROM org_app_blob WHERE sha256 = $1`, [sha(orphan2)])).length;
  const liveAfter = (await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [liveHs]))[0].n;
  chk("D11 정리 — 오래된 살아 있는 파일이 한 바퀴 볼 수보다 많아도 고아를 지운다 · 살아 있는 파일은 그대로",
    liveBefore > 1 && gc2.removed === 1 && orphanLeft === 0 && liveAfter === liveBefore,
    JSON.stringify({ liveBefore, gc2, orphanLeft, liveAfter }));

  // D8
  //  관리자 문은 도구 입구(MCP · REST 의 scope 관문)가 지킨다 — 이 코드베이스의 다른 관리자 도구와 같다. 여기선 선언을 본다.
  const adminOnly = cap("app_bundle_limits_set").scope === "admin" && cap("app_bundle_limits").scope === null;
  await call("app_bundle_limits_set", { workspace_max_mb: 1 }, boss);
  const lim = await call("app_bundle_limits", {}, alice);
  const e8 = await errOf(call("app_save", { files: web("toobig", "x", [{ path: "dist/huge.bin", content: crypto.randomBytes(1_200_000).toString("base64"), encoding: "base64" }]) }, alice));
  const noApp = (await q(`SELECT id FROM org_app WHERE id='toobig'`)).length === 0;
  await call("app_bundle_limits_set", { reset: true }, boss);
  await call("app_bundle_limits_set", { file_max_mb: 1 }, boss);
  const e8b = await errOf(call("app_save", { files: web("toobig2", "x", [{ path: "dist/huge.bin", content: crypto.randomBytes(1_100_000).toString("base64"), encoding: "base64" }]) }, alice));
  await call("app_bundle_limits_set", { reset: true }, boss);
  const after = await call("app_bundle_limits", {}, alice);
  chk("D8 상한 — 관리자만 고친다 · 워크스페이스 상한 넘는 저장 413(앱 안 생김) · 파일 하나 상한 413(그 파일 이름) · 되돌리면 기본값",
    adminOnly && lim.policy.workspace_max_mb === 1 && lim.used_mb > 0 && e8?.status === 413 && noApp
      && e8b?.status === 413 && String(e8b?.message).includes("huge.bin") && after.policy.workspace_max_mb === 10240 && after.policy.file_max_mb === 50,
    JSON.stringify({ adminOnly, lim: lim.policy, e8: [e8?.status, String(e8?.message).slice(0, 80)], noApp, e8b: [e8b?.status, String(e8b?.message).slice(0, 80)], after: after.policy }));

  // D12
  await call("app_bundle_limits_set", { workspace_max_mb: 1 }, boss);
  const e12 = await errOf(call("org_app_install", { source: { kind: "inline", files: web("adminbig", "x", [{ path: "dist/huge.bin", content: crypto.randomBytes(1_200_000).toString("base64"), encoding: "base64" }]) } }, boss));
  const noAdminApp = (await q(`SELECT id FROM org_app WHERE id='adminbig'`)).length === 0;
  const noAdminVer = (await q(`SELECT 1 FROM org_app_version WHERE app_id='adminbig'`)).length === 0;
  await call("app_bundle_limits_set", { reset: true }, boss);
  const i12 = await call("org_app_install", { source: { kind: "inline", files: web("adminok", "관리자") } }, boss);
  const ver12 = await q(`SELECT version_no, bundle_store, (bundle IS NOT NULL) AS has_bundle FROM org_app_version WHERE app_id='adminok'`);
  clearFrontBundleCacheForTest();
  const js12 = await get("pgt-bob", "adminok", `/${JS}`);
  chk("D12 관리자 설치 — 상한에 걸리면 413 이고 앱 · 판이 안 생긴다 · 되는 설치는 판 1개(파일 목록) · 앱 주소가 그 판을 낸다",
    e12?.status === 413 && noAdminApp && noAdminVer && i12.created === true && ver12.length === 1 && ver12[0].has_bundle === true
      && js12.status === 200 && text(js12) === 'console.log("관리자")',
    JSON.stringify({ e12: [e12?.status, String(e12?.message).slice(0, 80)], noAdminApp, noAdminVer, i12: i12.created, ver12, js12: [js12.status, text(js12).slice(0, 40)] }));

  // D13 — S3 저장소의 고아 5개(오래됨 · 안 가리킴) · 가짜 S3 는 지우기를 500 으로 → 3번 연달아 실패하면 접는다
  const s3Hs = Array.from({ length: 5 }, (_, i) => sha(Buffer.from(`s3 고아 ${i} ${Date.now()}`)));
  await q(`INSERT INTO org_app_blob(sha256, store, size, stored, created_at, last_used_at) SELECT h, 's3', 10, TRUE, now() - interval '3 days', now() - interval '3 days' FROM unnest($1::text[]) AS h`, [s3Hs]);
  process.env.LIVELY_APP_BUNDLE_BUCKET = "pgt-bucket";
  const s3calls = { n: 0, mode: "fail" };
  blob.setBlobS3DepsForTest({
    creds: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }), retryDelayMs: 0,
    fetch: async (_url, init) => { s3calls.n++; return init?.method === "DELETE" && s3calls.mode === "ok" ? new Response(null, { status: 204 }) : new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }); },
  });
  let gcFail, gcOk, gcAfterRestart, leftFail, leftOk, leftEnd, callsFail;
  blob.resetGcFailedForTest();
  try {
    gcFail = await blob.gcBlobs({ limit: 10 });
    callsFail = s3calls.n;
    leftFail = (await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256 = ANY($1::text[]) AND store='s3' AND stored`, [s3Hs]))[0].n;
    s3calls.mode = "ok"; s3calls.n = 0;
    gcOk = await blob.gcBlobs({ limit: 10 });                 // 실패한 셋은 건너뛰고 나머지 둘
    leftOk = (await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [s3Hs]))[0].n;
    blob.resetGcFailedForTest();                               // 재기동
    gcAfterRestart = await blob.gcBlobs({ limit: 10 });
    leftEnd = (await q(`SELECT count(*)::int AS n FROM org_app_blob WHERE sha256 = ANY($1::text[])`, [s3Hs]))[0].n;
  } finally {
    blob.setBlobS3DepsForTest(undefined);
    blob.resetGcFailedForTest();
    delete process.env.LIVELY_APP_BUNDLE_BUCKET;
  }
  const STREAK = blob.GC_S3_FAIL_STREAK_MAX;
  chk("D13 정리 — S3 지우기가 연달아 실패하면 그 바퀴를 접는다(후보마다 한 번 · 장부 그대로) · 실패한 줄은 건너뛰고 나머지를 지운다 · 재기동 뒤 그 줄도",
    STREAK === 3 && gcFail.checked === STREAK && gcFail.failed === STREAK && gcFail.removed === 0 && callsFail === STREAK && leftFail === 5
      && gcOk.checked === 5 - STREAK && gcOk.removed === 5 - STREAK && leftOk === STREAK && gcAfterRestart.removed === STREAK && leftEnd === 0,
    JSON.stringify({ gcFail, callsFail, leftFail, gcOk, leftOk, gcAfterRestart, leftEnd }));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}

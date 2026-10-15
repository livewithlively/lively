// 파일 서명 주소(#4673 완료 조건 «앱 서버가 앱 토큰으로 apps/<앱>/ 에 올리고 받기» 의 로컬판) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/files/file-url.pg-test.mjs
//
// 한 프로세스에 게이트웨이를 띄운다 — 진짜 인증(구성원 토큰 · 앱 서버 토큰 + 서명한 X-Lively-Identity) · 능력 REST(/api/ui/files/url) ·
//  서명 주소 받는 곳(/api/files/s, 전역 JSON 파서 앞 — index.ts 와 같은 순서) · 홈 탐색기(/api/ui/terminal/browse). 파일은 임시 폴더.
//  «앱 서버» 는 Lambda 가 할 일 그대로다 — 앱 서버 토큰과 들어온 요청의 사람 신원으로 file_url 을 받고 그 url 에 PUT/GET.
//  P1 앱 서버 — 제 앱 폴더에 올리고(바이트 같음 · 디스크 그 자리) 받는다
//  P2 앱 서버 — 동의 안 한 사람의 신원 403 · 공유 폴더 403 · 남의 앱 폴더 403 · 신원 없음 401
//  P3 사람(구성원 토큰) — 동의한 앱 폴더 받기 주소는 받는다 · 올리기 주소 403 · 동의 없는 사람 403
//  P4 동의를 거두면 이미 받은 주소도 쓰는 순간 막힌다
//  P5 홈 탐색기 root=apps — 동의한 사람에게만 그 앱 폴더가 보인다 · 웹 쓰기 403
//  P6 공유 폴더 올리기 — 다른 업로드처럼 자료가 생긴다(앱 폴더 올리기는 자료가 안 생긴다)
import pg from "pg";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_file_url_4673";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);

const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-file-url-pg-"));
process.env.LIVELY_MEMBER_ISOLATION = "off";
process.env.TERMINAL_ROOT_SHARED = path.join(ROOT, "shared");
process.env.TERMINAL_ROOT_APPS = path.join(ROOT, "apps");
process.env.TERMINAL_ROOT_PERSONAL = path.join(ROOT, "box");
for (const d of ["shared", "apps", "box"]) mkdirSync(path.join(ROOT, d), { recursive: true });
process.env.CONNECTOR_SECRET_KEY = crypto.randomBytes(32).toString("hex");

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const ID = await import(`${D}/apps/app-identity.js`);
const KEY = ID.ed25519FromSeed(Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"));
process.env.LIVELY_APP_IDENTITY_PUBKEYS = JSON.stringify({ "test-1": KEY.publicKeyB64 });

const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerWebUi } = await import(`${D}/web.js`);
const { registerTerminalFiles } = await import(`${D}/terminal/terminal-files.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { fileUrlRouter } = await import(`${D}/files/signed-routes.js`);
const { liveSignedRouteDeps } = await import(`${D}/files/files-live.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { mintAppServerToken } = await import(`${D}/apps/app-server-auth.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const cap = (n) => appCapabilities.find((c) => c.name === n);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const SINGLE = "00000000-0000-0000-0000-000000000000";
const now = () => Math.floor(Date.now() / 1000);
const identity = (sub, app = "files-app") => ID.signAppIdentity({ ws: SINGLE, app, var: "pub", sub, name: sub, iat: now(), exp: now() + 600 }, KEY.privateKey, "test-1");
const appManifest = (id, appFolder) => ({ id, title: id, version: "0.1.0", permissions: { app_folder: appFolder }, ui: { pages: [{ key: "main", title: id, entry: "ui/index.html" }] } });
const install = (id, appFolder) => cap("org_app_install").handler({ source: { kind: "inline", files: [
  { path: "lively-app.json", content: JSON.stringify(appManifest(id, appFolder)) }, { path: "ui/index.html", content: "<p>x</p>" }] } },
  { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] }, { source: "mcp" });

let server = null;
try {
  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  await upsertMember({ id: "pgt-user", display_name: "사용자", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-other", display_name: "동의 안 함", state: "active", scopes: ["items"] }, "pgt");
  await install("files-app", true);
  await install("other-app", true);
  await cap("me_app_grant").handler({ app_id: "files-app" }, { userId: "pgt-user", scopes: ["items"] }, { source: "mcp" });
  await cap("me_app_grant").handler({ app_id: "other-app" }, { userId: "pgt-user", scopes: ["items"] }, { source: "mcp" });
  const { token: appToken } = await mintAppServerToken("files-app", "pgt-admin");
  const userTok = (await mintToken({ userId: "pgt-user", memberId: "pgt-user", scopes: ["items"] }, "pgt")).token;
  const otherTok = (await mintToken({ userId: "pgt-other", memberId: "pgt-other", scopes: ["items"] }, "pgt")).token;

  const gw = express();
  gw.use("/api/files/s", fileUrlRouter(liveSignedRouteDeps));
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  registerTerminalFiles(gw, verifier);
  server = http.createServer(gw);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = GW;   // 서명 주소의 base(org 프로필 주소가 빈 새 DB 라 PUBLIC_URL 로 정해진다)

  const mintAsApp = (sub, body) => fetch(GW + "/api/ui/files/url", { method: "POST",
    headers: { authorization: `Bearer ${appToken}`, ...(sub ? { "x-lively-identity": identity(sub) } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });
  const mintAs = (tok, body) => fetch(GW + "/api/ui/files/url", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  // ── P1 ──
  const bytes = crypto.randomBytes(200_000);
  const r1 = await mintAsApp("pgt-user", { address: "apps/files-app/reports/r.bin", method: "PUT" });
  const u1 = await r1.json();
  chk("P1a 앱 서버가 올리기 주소를 받는다(url = <게이트웨이>/api/files/s/…)", r1.status === 200 && String(u1.url).startsWith(GW + "/api/files/s/") && u1.method === "PUT", JSON.stringify(u1));
  const put = await fetch(u1.url, { method: "PUT", body: bytes });
  const onDisk = path.join(ROOT, "apps", "files-app", "reports", "r.bin");
  chk("P1b 그 url 에 쿠키 · 토큰 없이 올린다 — 디스크에 바이트 그대로", put.status === 200 && existsSync(onDisk) && readFileSync(onDisk).equals(bytes), `${put.status} ${await put.clone().text()}`);
  const g1 = await (await mintAsApp("pgt-user", { address: "apps/files-app/reports/r.bin" })).json();
  const got = Buffer.from(await (await fetch(g1.url)).arrayBuffer());
  chk("P1c 받기 주소로 같은 바이트를 받는다", got.equals(bytes), `${got.length} vs ${bytes.length}`);

  // ── P2 ──
  const p2a = await mintAsApp("pgt-other", { address: "apps/files-app/x.txt", method: "PUT" });
  const p2b = await mintAsApp("pgt-user", { address: "shared/x.txt", method: "PUT" });
  const p2c = await mintAsApp("pgt-user", { address: "apps/other-app/x.txt", method: "PUT" });
  const p2d = await mintAsApp(null, { address: "apps/files-app/x.txt", method: "PUT" });
  chk("P2 앱 서버 — 동의 안 한 사람 403 · 공유 폴더 403 · 남의 앱 폴더 403 · 신원 없음 401",
    p2a.status === 403 && p2b.status === 403 && p2c.status === 403 && p2d.status === 401, JSON.stringify([p2a.status, p2b.status, p2c.status, p2d.status]));

  // ── P3 ──
  const p3a = await mintAs(userTok, { address: "apps/files-app/reports/r.bin" });
  const p3aBody = await p3a.json();
  const p3aGot = p3a.status === 200 ? Buffer.from(await (await fetch(p3aBody.url)).arrayBuffer()) : Buffer.alloc(0);
  const p3b = await mintAs(userTok, { address: "apps/files-app/y.txt", method: "PUT" });
  const p3c = await mintAs(otherTok, { address: "apps/files-app/reports/r.bin" });
  chk("P3 사람 — 동의한 앱 폴더 받기 OK(같은 바이트) · 올리기 403 · 동의 없는 사람 403",
    p3a.status === 200 && p3aGot.equals(bytes) && p3b.status === 403 && p3c.status === 403, JSON.stringify([p3a.status, p3b.status, p3c.status]));

  // ── P5 (P4 전에 — 동의를 거두기 전) ──
  const listUser = await (await fetch(GW + "/api/ui/terminal/browse?root=apps&path=", { headers: { authorization: `Bearer ${userTok}` } })).json();
  const listOther = await (await fetch(GW + "/api/ui/terminal/browse?root=apps&path=", { headers: { authorization: `Bearer ${otherTok}` } })).json();
  const intoOther = await fetch(GW + "/api/ui/terminal/browse?root=apps&path=files-app", { headers: { authorization: `Bearer ${otherTok}` } });
  const webPut = await fetch(GW + "/api/ui/terminal/browse/file?root=apps&path=files-app%2Fw.txt", { method: "PUT", headers: { authorization: `Bearer ${userTok}` }, body: "w" });
  chk("P5 홈 탐색기 — 동의한 사람만 그 앱 폴더를 보고(목록 · 들어가기) · 웹 올리기 403",
    (listUser.dirs ?? []).includes("files-app") && !(listOther.dirs ?? []).includes("files-app") && intoOther.status === 404 && webPut.status === 403
    && !existsSync(path.join(ROOT, "apps", "files-app", "w.txt")),
    JSON.stringify({ user: listUser.dirs, other: listOther.dirs, intoOther: intoOther.status, webPut: webPut.status }));

  // ── P4 ──
  const pending = await (await mintAsApp("pgt-user", { address: "apps/files-app/late.txt", method: "PUT" })).json();
  await cap("me_app_revoke").handler({ app_id: "files-app" }, { userId: "pgt-user", scopes: ["items"] }, { source: "mcp" });
  const late = await fetch(pending.url, { method: "PUT", body: "late" });
  chk("P4 동의를 거두면 이미 받은 주소도 쓰는 순간 403 · 파일이 안 생긴다", late.status === 403 && !existsSync(path.join(ROOT, "apps", "files-app", "late.txt")), String(late.status));

  // ── P6 ──
  const s1 = await (await mintAs(userTok, { address: "shared/docs/note.md", method: "PUT" })).json();
  const sp = await fetch(s1.url, { method: "PUT", body: "# 공유 메모\n본문" });
  const spBody = await sp.json();
  const appFileSources = await itemsPool.query(`SELECT count(*)::int AS n FROM source WHERE external_system='local' AND external_id LIKE '%files-app%'`);
  chk("P6 공유 폴더 올리기는 자료가 생기고(ref · source_id) 앱 폴더 올리기는 자료가 없다",
    sp.status === 200 && spBody.ref === "shared/docs/note.md" && Number(spBody.source_id) > 0 && appFileSources.rows[0].n === 0, JSON.stringify(spBody));
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  if (server) server.close();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

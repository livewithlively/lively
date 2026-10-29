// 자가호스팅 앱 서버(#4487 앱 v2-8 2단계) PG 흐름 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-servers-local.pg-test.mjs
//
// 사양 엣지 표 D(#4487 PR 2): LIVELY_APP_SERVER_HOST=local 에서 능력(app_save · app_server_deploy · app_server_stop/resume · app_server_idle_set ·
//  app_server_status · org_app_remove)과 작업 길(startAppJob → 비동기 부르기 → 검사 층 claim → 앱 → 결과)을 그대로 돈다.
//  빌드는 **진짜 빌더**(SERVER_BUILDER_JS) · 함수 실행면은 **진짜 로컬 실행면**(app-server-local — 판 폴더 · 별칭 · 재우기)이고, 컨테이너 겉면만
//  이 기계의 프로세스(검사 층 guard.cjs + 앱)다 — 인자는 운영과 같은 검사기를 지난다. 게이트웨이 콜백은 진짜 경로(registerAppJobRoutes)를 작은 서버에 단다.
//  P1 세션 없이 배포(일회용 빌드 → 로컬 zip · 함수 판 · cur · 상태 host local) · P2 같은 판 다시(빌드 · 판 고정 0) · P3 멈춤 · 다시 켬
//  P4 백그라운드 작업 done(사람 = 시작한 사람 · 검사 층 열쇠) · P5 같은 부르기 비밀 다시 → 409 · P6 앱 지우기 · P7 판 폴더 잃음 → 점검이 다시 올림
//  P8 재우기 설정 권한 · 범위 · lambda 409 · P9 정비 — 주인 없는 컨테이너
import "../../scripts/test-apps-root.mjs";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import express from "express";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_servers_local_4487";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_APP_BUNDLE_BUCKET", "LIVELY_APP_BUNDLE_POLICY", "LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_PREFIX",
  "AWS_REGION", "LIVELY_APP_SERVER_REGION", "LIVELY_APP_BUNDLE_REGION", "LIVELY_APP_SERVER_TENANTS", "LIVELY_APP_SERVER_LAYER", "LIVELY_APP_SERVER_RUNTIME", "LIVELY_APP_SERVER_CODE_STORAGE",
  "LIVELY_APP_SERVER_EXEC_ROLE", "LIVELY_APP_IDENTITY_PUBKEYS", "LIVELY_APP_SERVER_IMAGE", "LIVELY_APP_SERVER_NETWORK", "LIVELY_APP_SERVER_LOCAL_MEMORY_MAX_MB", "LIVELY_APP_SERVER_BUILD_CONCURRENCY",
  "LIVELY_APP_SERVER_BUILD_MEMORY_MB", "LIVELY_APP_DOMAIN"]) delete process.env[k];
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pgt-4487-")));
process.env.LIVELY_APP_SERVER_HOST = "local";
process.env.LIVELY_APP_SERVER_LOCAL_DIR = path.join(work, "app-servers");

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appServerCapabilities } = await import(`${D}/capabilities/app-servers.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { appJobCapabilities } = await import(`${D}/capabilities/app-jobs.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { upsertGrant } = await import(`${D}/org/store/apps.js`);
const svc = await import(`${D}/apps/app-jobs.js`);
const { setLocalDepsForTest, localLambdaApi, LOCAL_BUCKET } = await import(`${D}/apps/app-server-local.js`);
const { appRunArgs, buildRunArgs, DockerError } = await import(`${D}/apps/app-server-docker.js`);
const { assertSafeDockerRun } = await import(`${D}/ops/docker-run-guard.js`);
const { checkServerHealth, runAppServerHousekeeping } = await import(`${D}/apps/app-server-watch.js`);
const { appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
const { registerAppJobRoutes } = await import(`${D}/apps/app-jobs-routes.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);

const all = [...appCapabilities, ...appServerCapabilities, ...appStoreCapabilities, ...appJobCapabilities];
const cap = (n) => { const c = all.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };
const call = (n, input, user, ctx = { source: "mcp" }) => cap(n).handler(input, user, ctx);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const alice = { userId: "pgt-alice", email: "a@x", scopes: ["memory"], projects: ["*"] };
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const boss = { userId: "pgt-boss", email: "boss@x", scopes: ["memory", "admin"], projects: ["*"] };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const exited = (p) => p.exitCode !== null || p.signalCode !== null;
const waitExit = (p) => (exited(p) ? Promise.resolve() : new Promise((r) => p.once("exit", () => r())));
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$1,'active',$2::jsonb)`, [id, JSON.stringify(scopes)]);
}

// ── 게이트웨이 콜백(진짜 경로) — 검사 층이 LIVELY_API_URL 로 claim · tick · result 를 부른다 ──
const gw = express();
gw.use(express.json({ limit: "4mb" }));
registerAppJobRoutes(gw, new BearerVerifier());
const gwSrv = http.createServer(gw);
await new Promise((r) => gwSrv.listen(0, "127.0.0.1", r));
process.env.LIVELY_APP_SERVER_API_URL = `http://127.0.0.1:${gwSrv.address().port}`;

// ── 컨테이너 겉면 = 이 기계의 프로세스(인자는 운영 검사기를 지난다) ──
const parseEnv = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const driver = {
  c: new Map(), runs: [], builds: [],
  async info() { return { memMb: 8192, cpus: 4 }; },
  async ensureImage() {}, async ensureNetwork() {},
  async runApp(spec, policy) {
    assertSafeDockerRun(appRunArgs(spec), policy);
    this.runs.push(spec);
    if (this.c.has(spec.name)) throw new DockerError(`Conflict: ${spec.name}`);
    const env = parseEnv(fs.readFileSync(spec.envFile, "utf8"));
    const code = spec.ro.find((m) => m.target === "/var/task").host, opt = spec.ro.find((m) => m.target === "/opt/lively").host;
    const port = await freePort(), appPort = await freePort();
    const penv = { PATH: process.env.PATH ?? "", ...env, LIVELY_GUARD_HOST: "127.0.0.1", LIVELY_GUARD_PORT: String(port), PORT: String(appPort), LAMBDA_TASK_ROOT: code };
    const guard = spawn(process.execPath, [path.join(opt, "guard.cjs")], { env: penv, stdio: ["ignore", "pipe", "pipe"] });
    const app = spawn("/bin/sh", [path.join(code, env._HANDLER)], { cwd: code, env: penv, stdio: ["ignore", "pipe", "pipe"] });
    const fc = { spec, guard, app, port, running: true, exitCode: null, log: "", startedAt: new Date().toISOString(), env: penv };
    const capLog = (d) => { fc.log = (fc.log + d.toString("utf8")).slice(-20_000); };
    for (const p of [guard, app]) { p.stdout.on("data", capLog); p.stderr.on("data", capLog); }
    app.on("exit", (c) => { fc.running = false; fc.exitCode = c ?? 137; if (!exited(guard)) guard.kill("SIGKILL"); });
    this.c.set(spec.name, fc);
    return { port };
  },
  async state(name) { const fc = this.c.get(name); return fc ? { running: fc.running, exitCode: fc.running ? null : fc.exitCode, oomKilled: false, startedAt: fc.startedAt } : null; },
  async logs(name) { return this.c.get(name)?.log ?? ""; },
  async remove(name) {
    const fc = this.c.get(name);
    if (!fc) return;
    this.c.delete(name);
    if (fc.fake) return;
    for (const p of [fc.app, fc.guard]) if (!exited(p)) p.kill("SIGKILL");
    await Promise.all([waitExit(fc.app), waitExit(fc.guard)]);
  },
  async list(label) {
    const [k, v] = label.split("=");
    return [...this.c.entries()].filter(([, fc]) => fc.spec.labels[k] === v).map(([name, fc]) => ({ name, labels: { ...fc.spec.labels }, running: fc.running, port: fc.running ? fc.port : null }));
  },
  //  빌드 = 이 기계의 node 로 진짜 빌더 — /out 은 그 빌드의 박스 폴더 그대로(buildOutInContainer).
  spawnBuild(spec, policy) {
    assertSafeDockerRun(buildRunArgs(spec), policy);
    this.builds.push(spec);
    const home = fs.mkdtempSync(path.join(work, "bhome-"));
    return spawn(process.execPath, spec.command.slice(1), { cwd: home, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", ...spec.env, HOME: home, npm_config_cache: path.join(home, ".npm"), npm_config_offline: "true" } });
  },
  buildOutInContainer(spec) { return spec.outDir; },
  async stopAll() { for (const n of [...this.c.keys()]) await this.remove(n); },
};
setLocalDepsForTest({ driver, user: "1000:1000", boxCeilingMb: 8192, readyTimeoutMs: 15_000 });

// ── 표본 서버 앱 — 작업 라우트는 받은 사람 · 열쇠가 맞는지를 돌려준다 ──
const LOCK = JSON.stringify({ name: "srv", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "srv", version: "1.0.0" } } });
const SERVER = `const http = require("http");
http.createServer((q, s) => {
  let b = ""; q.on("data", (c) => { b += c; });
  q.on("end", () => {
    const member = q.headers["x-lively-member"] ? decodeURIComponent(q.headers["x-lively-member"]) : null;
    const keyOk = !!process.env.LIVELY_GUARD_KEY && q.headers["x-lively-guard-key"] === process.env.LIVELY_GUARD_KEY;
    s.writeHead(200, { "content-type": "application/json" });
    s.end(JSON.stringify({ route: q.url, member, job: q.headers["x-lively-job"] ?? null, keyOk, body: b ? JSON.parse(b) : null }));
  });
}).listen(Number(process.env.PORT));`;
const filesOf = ({ title = "서버 앱", server = SERVER } = {}) => [
  { path: "lively-app.json", content: JSON.stringify({ id: "srv", title, version: "1.0.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title, entry: "ui/index.html" }] }, web: { server: {} } }) },
  { path: "ui/index.html", content: "<p>서버 앱</p>" },
  { path: "package.json", content: JSON.stringify({ name: "srv", version: "1.0.0", private: true, scripts: { start: "node server.js", build: "node build.js" } }) },
  { path: "package-lock.json", content: LOCK },
  { path: "server.js", content: server },
  { path: "build.js", content: "require('fs').writeFileSync('built.txt','ok');" },
];
const FN = "lvly-app-srv-local";
const ROOT = process.env.LIVELY_APP_SERVER_LOCAL_DIR;
const fnDir = path.join(ROOT, "fn", SINGLE_TENANT_ID, FN);
const serverRow = async () => (await q(`SELECT * FROM org_app_server WHERE app_id='srv'`))[0];
const containersOf = (fn) => [...driver.c.values()].filter((c) => c.spec.labels["lvly.fn"] === fn);

try {
  // P1 세션 없이 배포
  const s1 = await call("app_save", { files: filesOf() }, alice);
  const d1 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice);
  const r1 = await serverRow();
  const b1 = (await q(`SELECT * FROM org_app_server_build WHERE app_id='srv'`))[0];
  chk("P1a 세션 없이 배포 — 일회용 빌드 1번 · 빌드 ok(지은 사람 = 부른 사람 · 세션 없음)",
    d1.status === "deployed" && driver.builds.length === 1 && b1?.status === "ok" && b1?.built_by === "pgt-alice" && b1?.session_id == null, JSON.stringify({ d1, b1 }));
  chk("P1b 빌드 컨테이너 — 자격 env 없음 · /out 만 쓰기 · 이미지 = 실행 이미지",
    Object.keys(driver.builds[0]?.env ?? {}).every((k) => /^(HOME|CI|npm_config_[a-z_]+)$/.test(k)) && driver.builds[0]?.image === "node:22-bookworm-slim", JSON.stringify(driver.builds[0]?.env));
  const meta = JSON.parse(fs.readFileSync(path.join(fnDir, "meta.json"), "utf8"));
  chk("P1c 로컬 zip(zips/…) · 함수 판 1 · 별칭 cur · 코드 풀림 · 기록 cur = 1",
    meta.aliases.cur?.version === "1" && fs.existsSync(path.join(fnDir, "v", "1", "code", "server.js")) && r1?.cur_lambda_version === "1" && r1?.cur_version_no === s1.version_no
    && b1?.zip_key && fs.existsSync(path.join(ROOT, "zips", ...b1.zip_key.split("/"))) && meta.config.Code === undefined, JSON.stringify({ aliases: meta.aliases, zip: b1?.zip_key }));
  chk("P1d 함수 env — 게이트웨이 주소(env 그대로) · 공개 키 없음(claim 만) · 검사 층 레이어는 로컬 판",
    meta.config.Environment.Variables.LIVELY_API_URL === process.env.LIVELY_APP_SERVER_API_URL && meta.config.Environment.Variables.LIVELY_APP_IDENTITY_PUBKEYS === "{}"
    && meta.config.Layers.some((l) => /^lively-local:layer:lvly-app-guard:\d+$/.test(l.Arn)), JSON.stringify(meta.config.Environment.Variables.LIVELY_API_URL));
  const st1 = await call("app_server_status", { app_id: "srv" }, alice);
  chk("P1e 상태 — host local · 재우기(기본 10분)", st1.host === "local" && st1.function?.local?.idle_sleep_effective_min === 10, JSON.stringify(st1.function?.local));

  // P2 같은 판 다시 — 빌드 · 판 고정 없음
  const versionsBefore = fs.readdirSync(path.join(fnDir, "v")).length;
  await call("app_save", { files: filesOf({ title: "서버 앱 · 이름만" }) }, alice);
  const d2 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice);
  chk("P2 이름만 바꾼 판 — 빌드 0 · 새 함수 판 0", d2.status === "deployed" && driver.builds.length === 1 && fs.readdirSync(path.join(fnDir, "v")).length === versionsBefore,
    JSON.stringify({ d2, builds: driver.builds.length }));

  // P2b 공개 — pub 별칭이 cur 와 같은 함수 판(로컬 별칭) · 이제 bob 에게도 보인다(P8 의 403)
  {
    const pub = await call("app_visibility_set", { app_id: "srv", visibility: "all" }, alice);
    const r = await serverRow();
    const m = JSON.parse(fs.readFileSync(path.join(fnDir, "meta.json"), "utf8"));
    chk("P2b 공개 — pub = cur 함수 판(로컬 별칭)", pub.changed === true && r.pub_lambda_version === r.cur_lambda_version && m.aliases.pub?.version === r.cur_lambda_version,
      JSON.stringify({ server: pub.server, aliases: m.aliases }));
  }

  // P8 재우기 설정
  {
    const ok1 = await call("app_server_idle_set", { app_id: "srv", idle_sleep_min: 0 }, alice);
    const ok2 = await call("app_server_idle_set", { app_id: "srv", idle_sleep_min: 30 }, boss);
    const eBob = await errOf(call("app_server_idle_set", { app_id: "srv", idle_sleep_min: 5 }, bob));
    const eBad = await errOf(call("app_server_idle_set", { app_id: "srv", idle_sleep_min: 2000 }, alice));
    await call("app_save", { files: [{ path: "lively-app.json", content: JSON.stringify({ id: "plain", title: "그냥 앱", version: "1.0.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title: "x", entry: "ui/index.html" }] } }) }, { path: "ui/index.html", content: "<p>x</p>" }] }, alice);
    const eNone = await errOf(call("app_server_idle_set", { app_id: "plain", idle_sleep_min: 5 }, alice));
    process.env.LIVELY_APP_SERVER_HOST = "lambda"; process.env.LIVELY_APP_SERVER_EXEC_ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
    const eLambda = await errOf(call("app_server_idle_set", { app_id: "srv", idle_sleep_min: 5 }, alice));
    process.env.LIVELY_APP_SERVER_HOST = "local"; delete process.env.LIVELY_APP_SERVER_EXEC_ROLE;
    const st = await call("app_server_status", { app_id: "srv" }, alice);
    chk("P8 재우기 설정 — 책임자 0 · 관리자 30 · 남 403 · 범위 밖 400 · 서버 없음 404 · lambda 409 · 상태에 앱별 값",
      ok1.effective_min === 0 && ok2.effective_min === 30 && eBob?.status === 403 && eBad?.status === 400 && eNone?.status === 404 && eLambda?.status === 409
      && st.function?.local?.idle_sleep_min === 30 && (await serverRow()).idle_sleep_min === 30,
      JSON.stringify({ ok1, ok2, bob: eBob?.status, bad: eBad?.status, none: eNone?.status, lambda: eLambda?.status, local: st.function?.local }));
    await call("app_server_idle_set", { app_id: "srv", idle_sleep_min: null }, alice);
  }

  // P4 백그라운드 작업 — 부르기 사건을 붙잡아 둔다(P5 다시 보내기)
  await upsertGrant("srv", "pgt-alice", ["memory"], []);
  const caught = [];
  const deps = { ...svc.liveAppJobDeps(), invokeAsync: async (env, fn, qual, payload) => { caught.push({ fn, qual, payload }); await localLambdaApi().invokeAsync(fn, qual, payload); } };
  const waitJob = async (id) => { for (let i = 0; i < 100; i++) { const j = await call("app_job_get", { id, wait: 2 }, alice); if (["done", "failed", "canceled"].includes(j.status)) return j; await sleep(100); } return null; };
  const j1 = await svc.startAppJob({ app_id: "srv", route: "/api/jobs/work?x=1", body: { n: 7 } }, alice, { source: "mcp" }, deps);
  const done1 = await waitJob(j1.id);
  const res1 = done1?.result?.json;
  chk("P4 백그라운드 작업 — 부름 1 · done · 앱은 시작한 사람(pgt-alice)으로 · 작업 번호 · 검사 층 열쇠 · 본문 그대로",
    caught.length === 1 && done1?.status === "done" && res1?.member === "pgt-alice" && res1?.job === String(j1.id) && res1?.keyOk === true && res1?.body?.n === 7 && res1?.route === "/api/jobs/work?x=1",
    JSON.stringify({ caught: caught.length, done1 }));

  // P5 같은 부르기 비밀 다시 → 검사 층 409(앱에 안 닿음)
  {
    const { fn, qual, payload } = caught[0];
    const out = await localLambdaApi().invokeStream(fn, qual, JSON.stringify(payload), { timeoutMs: 20_000 });
    const parts = [];
    for await (const ev of out.events) if (ev.type === "chunk") parts.push(ev.data);
    const all2 = Buffer.concat(parts);
    const cut = all2.indexOf(Buffer.alloc(8));
    const prelude = JSON.parse(all2.subarray(0, cut).toString("utf8"));
    const body = JSON.parse(all2.subarray(cut + 8).toString("utf8"));
    chk("P5 같은 부르기 비밀 다시 — 409 job_replayed", prelude.statusCode === 409 && body.error === "job_replayed", JSON.stringify({ prelude, body }));
  }

  // P3 멈춤 · 다시 켬
  {
    chk("P3a 멈추기 전 — 컨테이너가 떠 있다", containersOf(FN).length >= 1, String(containersOf(FN).length));
    await call("app_server_stop", { app_id: "srv" }, alice);
    const eJob = await errOf(svc.startAppJob({ app_id: "srv", route: "/api/jobs/work", body: {} }, alice, { source: "mcp" }, deps));
    chk("P3b 멈춤 — 컨테이너 내림 · 작업 거절", containersOf(FN).length === 0 && eJob?.status >= 400, JSON.stringify({ n: containersOf(FN).length, e: eJob?.status, m: eJob?.message }));
    await call("app_server_resume", { app_id: "srv" }, alice);
    const j2 = await svc.startAppJob({ app_id: "srv", route: "/api/jobs/work", body: { n: 2 } }, alice, { source: "mcp" }, deps);
    const done2 = await waitJob(j2.id);
    chk("P3c 다시 켬 — 작업이 다시 된다(컨테이너 다시 뜸)", done2?.status === "done" && containersOf(FN).length === 1, JSON.stringify(done2));
  }

  // P7 판 폴더가 사라짐 → 상태 점검이 같은 빌드로 새 판 · 별칭 옮김
  {
    const before = await serverRow();
    //  코드 폴더만 잃는다(판 설정 version.json 은 남음) — 판 폴더째 잃는 것보다 엄한 쪽(설정만 보고 «있다» 고 하면 안 된다).
    fs.rmSync(path.join(fnDir, "v", before.cur_lambda_version, "code"), { recursive: true, force: true });
    await q(`UPDATE org_app_server SET health_checked_at = NULL WHERE app_id='srv'`).catch(() => null);
    const h = await checkServerHealth(await appServerPolicy());
    const after = await serverRow();
    const metaAfter = JSON.parse(fs.readFileSync(path.join(fnDir, "meta.json"), "utf8"));
    chk("P7 판의 코드 폴더 잃음 → 점검이 같은 빌드로 다시 올림 · 별칭 옮김 · 빌드 0",
      h.moved.length >= 1 && after.cur_lambda_version !== before.cur_lambda_version && fs.existsSync(path.join(fnDir, "v", after.cur_lambda_version, "code", "server.js"))
      && metaAfter.aliases.cur.version === after.cur_lambda_version && driver.builds.length === 1,
      JSON.stringify({ h, before: before.cur_lambda_version, after: after.cur_lambda_version }));
  }

  // P9 정비 — 주인 없는 컨테이너(함수가 없는 이름)는 걷는다 · 제 것은 그대로
  {
    driver.c.set("lvly-app-ghost-local-v1", { fake: true, spec: { labels: { "lvly.app-server": "1", "lvly.tenant": SINGLE_TENANT_ID, "lvly.fn": "lvly-app-ghost-local", "lvly.version": "1" } }, running: true, port: 1, log: "", startedAt: new Date().toISOString() });
    const hk = await runAppServerHousekeeping(await appServerPolicy());
    chk("P9 정비 — 주인 없는 컨테이너 걷음 · 살아 있는 앱 것은 그대로", hk.local?.removed?.includes("lvly-app-ghost-local-v1") && !driver.c.has("lvly-app-ghost-local-v1") && containersOf(FN).length === 1,
      JSON.stringify(hk.local));
  }

  // P6 앱 지우기 — 함수 폴더 · zip · 기록 · 컨테이너
  {
    const zipKey = (await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='srv'`))[0]?.zip_key;
    await call("org_app_remove", { app_id: "srv" }, alice);
    chk("P6 앱 지우기 — 컨테이너 · 함수 폴더 · zip · 서버 · 빌드 기록 걷힘",
      containersOf(FN).length === 0 && !fs.existsSync(fnDir) && !fs.existsSync(path.join(ROOT, "zips", ...String(zipKey).split("/")))
      && (await q(`SELECT 1 FROM org_app_server WHERE app_id='srv'`)).length === 0 && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='srv'`)).length === 0,
      JSON.stringify({ c: containersOf(FN).length, dir: fs.existsSync(fnDir), zipKey }));
  }
  void LOCAL_BUCKET;
} finally {
  await driver.stopAll();
  await new Promise((r) => { gwSrv.closeAllConnections(); gwSrv.close(() => r()); });
  await itemsPool.end().catch(() => {});
  await dbc.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);

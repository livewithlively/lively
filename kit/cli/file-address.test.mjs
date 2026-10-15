#!/usr/bin/env node
// lively file (#4673) — 세션 안 경로 ↔ 파일 주소 · 서명 주소. 가짜 게이트웨이 + 진짜 CLI 서브프로세스.
//  실행: node kit/cli/file-address.test.mjs   (npm test 체인)
//  계약(사양 표 L1~L9): 판정 · 변환은 게이트웨이가 하고 CLI 는 그 REST 를 부르는 겉이다 — 그래서 단언은 «무엇을 보냈나»(경로 · 본문 · 머리글)
//   와 «무엇을 stdout 에 냈나»(스크립트가 `$(lively file path …)` 로 받는 한 줄) · 종료코드다.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv, pathWith, writeNoopBin } from "../testlib/os-sandbox.mjs";

const CLI = path.join(fileURLToPath(import.meta.url), "..", "lively.mjs");
let pass = 0; const ok = (n) => { pass++; console.error(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 받은 요청을 적고, 정해 둔 답을 준다 ──
let seen = [], reply = () => ({ status: 200, body: {} });
const server = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 빈 본문 */ }
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, url: req.url, pathname: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    const r = reply({ url: req.url, body });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
});
//  키트 시험 샌드박스는 루프백 32768 이상만 연다(LIVELY_HOST_EFFECTS_TEST_MODE=sandbox). 임시 포트 범위가 더 아래에서 시작하는
//   호스트(gVisor 16000~)에선 listen(0) 이 그 아래를 받아 «HostEffects denied network» 로 흔들린다 — 범위 안을 받을 때까지 다시 연다.
for (let i = 0; ; i++) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  if (server.address().port >= 32768 || i >= 50) break;
  await new Promise((r) => server.close(r));
}
const BASE = `http://127.0.0.1:${server.address().port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lively-file-cmd-"));
const STUB_BIN = path.join(root, "stub-bin");
fs.mkdirSync(STUB_BIN, { recursive: true });
for (const b of ["claude", "codex"]) writeNoopBin(STUB_BIN, b);   // 하네스를 PATH 에서 가린다(cli-spawn-harness-sandbox 규약)
const home = fs.mkdtempSync(path.join(root, "home-"));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, "proj-")));
fs.writeFileSync(path.join(cwd, "notes.md"), "n");

function run(args, { session = "box-me-1", mode = "" } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...offlineLivelyEnv(), PATH: pathWith(STUB_BIN), LIVELY_HOME: home, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "tok-1" };
    if (session) env.LIVELY_SESSION_ID = session; else delete env.LIVELY_SESSION_ID;
    if (mode) env.LIVELY_MODE = mode; else delete env.LIVELY_MODE;
    const c = spawn(process.execPath, [CLI, "file", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
  });
}
const reset = (fn) => { seen = []; reply = fn ?? (() => ({ status: 200, body: {} })); };

try {
  {
    reset(() => ({ status: 200, body: { address: "shared/project/4670/notes.md", link: `${BASE}/ui/#/f?root=shared&path=project%2F4670%2Fnotes.md` } }));
    const r = await run(["address", "notes.md"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "GET", "경로 → 주소는 읽기(GET)");
    assert.equal(seen[0].pathname, "/api/ui/files/address");
    assert.deepEqual(seen[0].query, { path: path.join(cwd, "notes.md") }, "있는 상대경로는 지금 폴더 기준 절대경로로 보낸다");
    assert.equal(seen[0].headers["x-lively-session"], "box-me-1", "부른 세션을 싣는다");
    assert.equal(seen[0].headers.authorization, "Bearer tok-1");
    assert.equal(r.stdout, "shared/project/4670/notes.md\n", "stdout 은 주소 한 줄");
    assert.match(r.stderr, /#\/f\?root=shared/);
    ok("L1 file address <있는 상대경로> → 절대경로로 보내고 주소 한 줄");
  }
  {
    reset(() => ({ status: 200, body: { address: "apps/crm/a.png", link: "x" } }));
    await run(["address", "apps/crm/a.png"]);
    assert.deepEqual(seen[0].query, { path: "apps/crm/a.png" }, "그 자리에 파일이 없는 글자는 그대로(주소 · 링크 · 좌표)");
    ok("L2 file address <주소 글자> → 그대로 보낸다");
  }
  {
    reset(() => ({ status: 200, body: { address: "apps/crm/out/a.png", path: "/work/shared/project/4670/.lively/apps/crm/out/a.png" } }));
    const r = await run(["path", "apps/crm/out/a.png"]);
    assert.equal(r.status, 0);
    assert.equal(seen[0].method, "GET");
    assert.equal(seen[0].pathname, "/api/ui/files/path");
    assert.deepEqual(seen[0].query, { address: "apps/crm/out/a.png" });
    assert.equal(r.stdout, "/work/shared/project/4670/.lively/apps/crm/out/a.png\n");
    ok("L3 file path <주소> → 경로 한 줄");
  }
  {
    reset(() => ({ status: 200, body: { address: "shared/project/9/x", path: null, reason: "이 세션에는 작업 폴더만 붙어 있어 — file_url 로 받으세요" } }));
    const r = await run(["path", "shared/project/9/x"]);
    assert.equal(r.status, 1, "이 세션에 없는 자리면 1");
    assert.equal(r.stdout, "", "없는 경로를 stdout 에 내면 스크립트가 그걸 경로로 쓴다");
    assert.match(r.stderr, /file_url/);
    ok("L4 경로가 없으면 종료 1 · stdout 비움 · 까닭은 stderr");
  }
  {
    reset(() => ({ status: 200, body: { url: `${BASE}/api/files/s/v1.a.b`, method: "PUT", expires_at: "2026-10-15T00:00:00.000Z" } }));
    const r = await run(["url", "apps/crm/out/a.png", "--put", "--ttl", "60"]);
    assert.equal(r.status, 0);
    assert.equal(seen[0].method, "POST", "발급은 POST 본문");
    assert.equal(seen[0].url, "/api/ui/files/url");
    assert.deepEqual(seen[0].body, { address: "apps/crm/out/a.png", method: "PUT", expires_in: 60 });
    assert.equal(r.stdout, `${BASE}/api/files/s/v1.a.b\n`);
    assert.match(r.stderr, /curl -fsS -T/);
    reset(() => ({ status: 200, body: { url: "u", method: "GET", expires_at: "t" } }));
    await run(["url", "shared/x"]);
    assert.deepEqual(seen[0].body, { address: "shared/x", method: "GET" }, "--put 이 없으면 받기 · --ttl 없으면 칸도 없다");
    ok("L5 file url <주소> [--put] [--ttl] → 서명 주소 한 줄");
  }
  {
    reset(() => ({ status: 403, body: { error: "앱 폴더는 그 앱이 씁니다 — 사람과 AI 는 보고 내려받기만 할 수 있습니다" } }));
    const r = await run(["url", "apps/crm/x", "--put"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /앱 폴더는 그 앱이 씁니다/, "서버 문장을 그대로 보인다");
    assert.doesNotMatch(r.stderr, /접속 열쇠/, "판정 거절(403)을 «토큰이 틀렸다» 로 바꾸면 사람이 재로그인만 반복한다");
    ok("L6 서버 거절은 그 문장 그대로 · 종료 1");
  }
  {
    reset();
    for (const args of [[], ["bogus", "x"], ["path"], ["address", "--json"]]) {
      const r = await run(args);
      assert.equal(r.status, 2, `잘못된 사용 ${JSON.stringify(args)} → 2`);
    }
    assert.equal(seen.length, 0, "잘못된 사용으로 게이트웨이를 부르면 안 된다");
    ok("L7 하위 명령 틀림 · 인자 없음 → 종료 2 · 요청 0");
  }
  {
    reset(() => ({ status: 200, body: { address: "shared/x", link: "l" } }));
    const r = await run(["address", "shared/x", "--json"]);
    assert.deepEqual(JSON.parse(r.stdout), { address: "shared/x", link: "l" });
    ok("L8 --json → stdout 이 응답 JSON");
  }
  {
    reset(() => ({ status: 200, body: { address: "shared/x", link: "l" } }));
    await run(["address", "shared/x"], { session: "" });
    assert.equal(seen[0].headers["x-lively-session"], undefined, "세션 밖에서 세션 머리글을 지어내지 않는다");
    ok("L9 LIVELY_SESSION_ID 가 없으면 세션 머리글 없음");
  }
  {
    reset(() => ({ status: 403, body: { error: "읽기전용 세션 — 올리기 주소는 줄 수 없습니다(#1007)" } }));
    const r = await run(["url", "shared/x", "--put"], { mode: "readonly" });
    assert.equal(seen[0].headers["x-lively-mode"], "readonly", "세션 모드를 MCP 프록시와 같은 머리글로 싣는다");
    assert.equal(r.status, 1);
    reset(() => ({ status: 200, body: { address: "shared/x", link: "l" } }));
    await run(["address", "shared/x"]);
    assert.equal(seen[0].headers["x-lively-mode"], undefined, "모드가 없으면 머리글도 없다");
    ok("L10 LIVELY_MODE 를 x-lively-mode 로 싣는다(읽기전용 세션이면 게이트웨이가 올리기 주소를 막는다)");
  }
  console.error(`\n${pass} passed`);
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}

#!/usr/bin/env node
// lively share (#905 C1 · #911) — 세션을 팀원과 공유. 가짜 게이트웨이 + 진짜 CLI 서브프로세스 e2e.
//  실행: node kit/cli/session-share.test.mjs   (npm test 체인)
//  계약:
//   ✅ 인자 없음 → 이 cwd 의 '가장 최근' 트랜스크립트(현재 세션)를 골라 최신 델타를 올리고 열람 링크 출력.
//   ✅ 마커(.lively/project.json)의 project_id 를 append 에 실어 보낸다(팀원 열람 근거).
//   ✅ --json → stdout 에 {session_id, link, pushed_bytes, project_id}. 사람 출력은 stderr.
//   ✅ 이미 서버가 최신이면 델타 안 올리고 링크만.
//   🔴 세션 공유 꺼짐 → 델타 안 올리고 경고(링크는 출력).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathWith, writeNoopBin } from "../testlib/os-sandbox.mjs";   // 스텁은 윈도우에서도 실행 가능해야 한다(#1510)
import { encodeCwd } from "./cmd-session.mjs";   // 트랜스크립트 폴더 인코딩 — 제품 정본을 그대로 쓴다(두 벌이면 어긋난다)

const CLI = path.join(fileURLToPath(import.meta.url), "..", "lively.mjs");
let pass = 0; const ok = (n) => { pass++; console.error(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 세션별 워터마크 + 캡처 정책 + 받은 append 기록(offset-CAS 흉내). ──
let SERVER = {}, CAPTURE = { enabled: true }, appends = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/api\/ui\/v6\/sessions\/([^/]+)\/log(\/watermark)?$/);
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!m) { res.writeHead(404); return res.end(); }
    const sid = decodeURIComponent(m[1]);
    const s = SERVER[sid] || (SERVER[sid] = { bytes: 0 });
    if (m[2] === "/watermark" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(CAPTURE.enabled
        ? { bytes: s.bytes, capture: { enabled: true, harnesses: ["claude"] } }
        : { bytes: s.bytes, capture: { enabled: false } }));
    }
    if (req.method === "POST") {
      const at = Number(u.searchParams.get("at")); const body = Buffer.concat(chunks);
      appends.push({ sid, at, len: body.length, project: u.searchParams.get("project") });
      res.writeHead(200, { "content-type": "application/json" });
      if (at === s.bytes) { s.bytes += body.length; return res.end(JSON.stringify({ ok: true, verdict: "append", bytes: s.bytes })); }
      return res.end(JSON.stringify({ ok: false, verdict: "gap", bytes: s.bytes }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-share-"));
// ⚠ 하네스(claude·codex)를 PATH 에서 가린다 — CLI 하위명령이 하네스를 만지는 순간 유닛 테스트가 **사람의 로컬
//  설치·MCP 설정에 시간과 결과를 의존**한다(#1431 실측: project-status 가 실제 `claude mcp list` 를 불러 36.5초).
//  가드: kit/cli/cli-spawn-harness-sandbox.test.mjs
const STUB_BIN = path.join(root, "stub-bin");
fs.mkdirSync(STUB_BIN, { recursive: true });
for (const b of ["claude", "codex"]) writeNoopBin(STUB_BIN, b);

// 픽스처: cwd(프로젝트 폴더) + 마커 + cwd 인코딩 경로에 트랜스크립트. cmdShare 는 process.cwd() 인코딩 경로를 본다.
function mkFixture({ sid, body, projectId, mtimeBump }) {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  // ⚠ realpath — 자식 process.cwd() 는 심볼릭(macOS /var→/private/var)을 해소하므로 cwd 인코딩 경로가 어긋난다. 실경로로 맞춘다.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, "proj-")));
  if (projectId) { fs.mkdirSync(path.join(cwd, ".lively"), { recursive: true }); fs.writeFileSync(path.join(cwd, ".lively", "project.json"), JSON.stringify({ project_id: projectId, sync: "none" })); }
  const enc = path.join(home, ".claude", "projects", encodeCwd(cwd));
  fs.mkdirSync(enc, { recursive: true });
  fs.writeFileSync(path.join(enc, `${sid}.jsonl`), body);
  if (mtimeBump) { const t = Date.now() / 1000 + mtimeBump; fs.utimesSync(path.join(enc, `${sid}.jsonl`), t, t); }
  return { home, cwd };
}
function runShare(home, cwd, extra = []) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "share", ...extra], {
      cwd, env: { ...process.env, PATH: pathWith(STUB_BIN), LIVELY_HOME: home, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "t" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
  });
}
const reset = () => { SERVER = {}; appends = []; CAPTURE = { enabled: true }; };

try {
  // ── ✅ 인자 없음 → 현재(가장 최근) 세션 델타 업로드 + 마커 project + 링크 ──
  {
    reset();
    const cwdBody = (q) => JSON.stringify({ type: "user", cwd: null, message: { content: q } });   // cwd 는 아래서 치환
    const { home, cwd } = mkFixture({ sid: "cur-sess", projectId: 42, body: "x".repeat(0) });   // 자리표시, 아래서 실 트랜스크립트로 덮음
    // 실제 트랜스크립트(cwd 라인 포함 — 마커 탐색 근거).
    const enc = path.join(home, ".claude", "projects", encodeCwd(cwd));
    const body = JSON.stringify({ type: "user", cwd, message: { content: "공유할 질문" } }) + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "답변" }] } }) + "\n";
    fs.writeFileSync(path.join(enc, "cur-sess.jsonl"), body);
    void cwdBody;
    const r = await runShare(home, cwd);
    assert.equal(r.status, 0, "정상 종료");
    const a = appends.find((x) => x.sid === "cur-sess");
    assert.ok(a && a.at === 0 && a.len === Buffer.byteLength(body), "현재 세션 델타 전량 업로드");
    assert.equal(a.project, "42", "마커의 project_id(42)를 append 에 실음");
    assert.match(r.stderr, new RegExp(`${BASE}/ui/#/sessions/cur-sess`), "열람 링크 출력(stderr)");
    ok("✅ 인자 없음 → 현재 세션 델타 업로드 + 마커 project + 링크");
  }

  // ── ✅ --json → stdout 에 링크·세션. 사람 출력은 stderr. ──
  {
    reset();
    const { home, cwd } = mkFixture({ sid: "js-sess", projectId: 7, body: "" });
    const enc = path.join(home, ".claude", "projects", encodeCwd(cwd));
    const body = JSON.stringify({ type: "user", cwd, message: { content: "q" } }) + "\n";
    fs.writeFileSync(path.join(enc, "js-sess.jsonl"), body);
    const r = await runShare(home, cwd, ["--json"]);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.session_id, "js-sess");
    assert.equal(j.link, `${BASE}/ui/#/sessions/js-sess`, "stdout json.link");
    assert.equal(j.project_id, 7);
    ok("✅ --json → stdout 에 {session_id, link, project_id}");
  }

  // ── ✅ 이미 서버가 최신 → 델타 안 올림, 링크만 ──
  {
    reset();
    const { home, cwd } = mkFixture({ sid: "done-sess", projectId: null, body: "" });
    const enc = path.join(home, ".claude", "projects", encodeCwd(cwd));
    const body = JSON.stringify({ type: "user", message: { content: "q" } }) + "\n";
    fs.writeFileSync(path.join(enc, "done-sess.jsonl"), body);
    SERVER["done-sess"] = { bytes: Buffer.byteLength(body) };   // 서버가 이미 다 가짐
    const r = await runShare(home, cwd);
    assert.equal(r.status, 0);
    assert.equal(appends.length, 0, "이미 최신이면 델타 안 올린다");
    assert.match(r.stderr, /ui\/#\/sessions\/done-sess/, "링크는 출력");
    ok("✅ 서버가 최신 → 델타 없이 링크만");
  }

  // ── 🔴 세션 공유 꺼짐 → 델타 안 올리고 경고(링크는 출력) ──
  {
    reset(); CAPTURE.enabled = false;
    const { home, cwd } = mkFixture({ sid: "off-sess", projectId: 9, body: "" });
    const enc = path.join(home, ".claude", "projects", encodeCwd(cwd));
    fs.writeFileSync(path.join(enc, "off-sess.jsonl"), JSON.stringify({ type: "user", cwd, message: { content: "q" } }) + "\n");
    const r = await runShare(home, cwd);
    assert.equal(appends.length, 0, "🔴 꺼져 있으면 델타 안 올린다");
    assert.match(r.stderr, /세션 공유가 꺼|꺼져 있어/, "경고 안내");
    ok("🔴 세션 공유 꺼짐 → 델타 없이 경고 + 링크");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

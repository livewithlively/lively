#!/usr/bin/env node
// lively backfill (#905 C1) — 기존 로컬 트랜스크립트 소급 업로드. 가짜 게이트웨이 + 진짜 CLI 서브프로세스 e2e.
//  실행: node kit/cli/session-backfill.test.mjs   (npm test 체인)
//  계약:
//   🔴 세션 공유 꺼짐 → 아무것도 안 올린다(중단).
//   ✅ 켜짐 → ~/.claude/projects/*/*.jsonl 전체를 서버 워터마크부터 올린다(offset-CAS).
//   ✅ 이미 올라간 세션(워터마크=파일크기)은 다시 안 올린다(멱등).
//   --dry-run 은 조회만(전송 0).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
      if (!CAPTURE.enabled) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ bytes: s.bytes, capture: { enabled: false } })); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ bytes: s.bytes, capture: { enabled: true, harnesses: ["claude"] } }));
    }
    if (req.method === "POST") {
      const at = Number(u.searchParams.get("at")); const body = Buffer.concat(chunks);
      appends.push({ sid, at, len: body.length, harness: u.searchParams.get("harness"), project: u.searchParams.get("project") });
      if (at === s.bytes) { s.bytes += body.length; res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, verdict: "append", bytes: s.bytes })); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: false, verdict: "gap", bytes: s.bytes }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-backfill-"));
// ⚠ 하네스(claude·codex)를 PATH 에서 가린다 — CLI 하위명령이 하네스를 만지는 순간 유닛 테스트가 **사람의 로컬
//  설치·MCP 설정에 시간과 결과를 의존**한다(#1431 실측: project-status 가 실제 `claude mcp list` 를 불러 36.5초).
//  가드: kit/cli/cli-spawn-harness-sandbox.test.mjs
const STUB_BIN = path.join(root, "stub-bin");
fs.mkdirSync(STUB_BIN, { recursive: true });
for (const b of ["claude", "codex"]) {
  fs.writeFileSync(path.join(STUB_BIN, b), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(STUB_BIN, b), 0o755);
}

// 격리 HOME 에 claude 프로젝트 기록 픽스처를 깐다.
function mkHome(files) {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  for (const { dir, sid, body } of files) {
    const p = path.join(home, ".claude", "projects", dir);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, sid + ".jsonl"), body);
  }
  return home;
}
function runBackfill(home, extra = []) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "backfill", ...extra], {
      cwd: root, env: { ...process.env, PATH: `${STUB_BIN}:${process.env.PATH}`, LIVELY_HOME: home, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "t" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (status) => resolve({ status, out }));
  });
}
const reset = () => { SERVER = {}; appends = []; CAPTURE = { enabled: true }; };

try {
  // ── ✅ 켜짐 → 두 세션 전문 업로드(워터마크 0부터) ──
  {
    reset();
    const home = mkHome([
      { dir: "-Users-a-proj1", sid: "sess-a", body: '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant"}\n' },
      { dir: "-Users-a-proj2", sid: "sess-b", body: '{"type":"user","message":{"content":"yo"}}\n' },
    ]);
    const r = await runBackfill(home);
    assert.equal(r.status, 0, "정상 종료");
    const sids = new Set(appends.map((a) => a.sid));
    assert.ok(sids.has("sess-a") && sids.has("sess-b"), "두 세션 모두 업로드");
    assert.ok(appends.every((a) => a.at === 0 && a.harness === "claude"), "워터마크 0부터, harness=claude");
    assert.match(r.out, /전송 2/, "요약: 전송 2");
    ok("✅ 켜짐 → 로컬 트랜스크립트 전체 업로드");
  }

  // ── 🔴 세션 공유 꺼짐 → 아무것도 안 올림(중단) ──
  {
    reset(); CAPTURE.enabled = false;
    const home = mkHome([{ dir: "-Users-a-p", sid: "sess-c", body: "x\n" }]);
    const r = await runBackfill(home);
    assert.notEqual(r.status, 0, "꺼져 있으면 실패 종료");
    assert.equal(appends.length, 0, "🔴 꺼져 있으면 아무 델타도 안 보낸다");
    assert.match(r.out, /세션 공유가 꺼|거부/, "이유 안내");
    ok("🔴 세션 공유 꺼짐 → 업로드 안 함");
  }

  // ── ✅ 이미 올라간 세션(워터마크=파일크기) → 다시 안 올림(멱등) ──
  {
    reset();
    const body = '{"type":"user","message":{"content":"done"}}\n';
    SERVER["sess-d"] = { bytes: Buffer.byteLength(body) };   // 서버가 이미 다 가짐
    const home = mkHome([{ dir: "-Users-a-p", sid: "sess-d", body }]);
    const r = await runBackfill(home);
    assert.equal(r.status, 0);
    assert.equal(appends.length, 0, "이미 다 있으면 재전송 안 함");
    assert.match(r.out, /이미있음 1/, "요약: 이미있음 1");
    ok("✅ 이미 올라간 세션 → 재전송 안 함(멱등)");
  }

  // ── --dry-run → 조회만, 전송 0 ──
  {
    reset();
    const home = mkHome([{ dir: "-Users-a-p", sid: "sess-e", body: "line\n" }]);
    const r = await runBackfill(home, ["--dry-run"]);
    assert.equal(r.status, 0);
    assert.equal(appends.length, 0, "dry-run 은 전송 안 함");
    assert.match(r.out, /dry-run|dry/, "dry-run 표기");
    ok("--dry-run → 조회만(전송 0)");
  }

  // ── ✅ .lively/project.json 마커 → append 에 project 실려 감(구조화된 정본, 경로 휴리스틱 아님) ──
  {
    reset();
    const projDir = fs.mkdtempSync(path.join(root, "proj-"));
    fs.mkdirSync(path.join(projDir, ".lively"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".lively", "project.json"), JSON.stringify({ project_id: 42, sync: "pull" }));
    const body = JSON.stringify({ type: "user", cwd: projDir, message: { content: "hi" } }) + "\n";
    const home = mkHome([{ dir: "-proj", sid: "sess-m", body }]);
    const r = await runBackfill(home);
    assert.equal(r.status, 0, "정상 종료");
    const a = appends.find((x) => x.sid === "sess-m");
    assert.ok(a, "세션 업로드됨");
    assert.equal(a.project, "42", "🔑 마커의 project_id(42)를 append 에 실어 보낸다");
    ok("✅ 마커(.lively/project.json) → append 에 project 실림");
  }

  // ── 마커 없으면 project 미전송(귀속 불가는 조용히) ──
  {
    reset();
    const body = JSON.stringify({ type: "user", cwd: "/tmp/nowhere-xyz-none", message: { content: "hi" } }) + "\n";
    const home = mkHome([{ dir: "-noproj", sid: "sess-n", body }]);
    const r = await runBackfill(home);
    assert.equal(r.status, 0);
    const a = appends.find((x) => x.sid === "sess-n");
    assert.equal(a.project, null, "마커 없으면 project 미전송");
    ok("마커 없음 → project 미전송(귀속 없음)");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

#!/usr/bin/env node
// lively resume (#905 C1 슬⑤c) — 다른 환경에서 내 세션 이어받기. 가짜 게이트웨이 + 진짜 CLI 서브프로세스 e2e.
//  실행: node kit/cli/session-resume.test.mjs   (npm test 체인)
//  계약:
//   🔴 소유자가 아니면(워터마크 403) 이어받지 못한다 — 파일도 안 내려온다.
//   🔴 중앙 기록이 없으면(bytes 0) 이어받을 내용이 없다고 알리고 멈춘다.
//   ✅ 소유자면 트랜스크립트를 이 머신의 claude 프로젝트 경로로 물질화하고 `claude --resume <sid>` 를 준비한다.
//   --print 는 물질화만 하고 명령만 출력(실제 claude 실행 없이 검증).
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

// ── 가짜 게이트웨이 — 세션별 소유/바이트/트랜스크립트. ──
const TRANSCRIPT = '{"type":"user","message":{"content":"안녕"}}\n{"type":"assistant","message":{"content":"네"}}\n';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/api\/ui\/v6\/sessions\/([^/]+)\/log(\/watermark)?$/);
  if (!m) { res.writeHead(404); return res.end(); }
  const sid = decodeURIComponent(m[1]);
  // 소유권 모사: 'notmine' 은 워터마크 403(비소유자), 'empty' 는 bytes 0, 그 외는 소유자+내용 있음.
  if (m[2] === "/watermark") {
    if (sid === "notmine") { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "이 세션 로그의 소유자가 아닙니다" })); }
    const bytes = sid === "empty" ? 0 : Buffer.byteLength(TRANSCRIPT);
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ bytes, capture: { enabled: true } }));
  }
  // 로그 원문(x-ndjson).
  res.writeHead(200, { "content-type": "application/x-ndjson" }); res.end(TRANSCRIPT);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-resume-"));
// CLI 를 격리 HOME + 격리 cwd 로 실행. --print 라 claude 는 안 뜬다.
//  ⚠ **async spawn 필수** — 가짜 게이트웨이가 이 프로세스에 있어, spawnSync 로 블로킹하면 이벤트루프가 멈춰
//    자식의 요청을 서버가 못 받아 교착한다(child↔server 상호대기).
function runResume(sid, extra = []) {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const cwd = fs.mkdtempSync(path.join(root, "work-"));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "resume", sid, "--print", "--node", "", ...extra], {
      cwd, env: { ...process.env, LIVELY_HOME: home, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "t" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (status) => resolve({ status, out }));
  });
}

try {
  // ── 🔴 비소유자 → 이어받기 거부, 파일 없음 ──
  {
    const r = await runResume("notmine");
    assert.notEqual(r.status, 0, "비소유자는 실패 종료");
    assert.match(r.out, /소유자가 아니거나|이어받을 수 없습니다/, "권한 없음 안내");
    assert.doesNotMatch(r.out, /물질화/, "🔴 비소유자에겐 트랜스크립트를 안 내려준다");
    ok("🔴 비소유자 → 이어받기 거부(파일 안 내려옴)");
  }

  // ── 🔴 중앙 기록 없음(bytes 0) → 이어받을 내용 없음 ──
  {
    const r = await runResume("empty");
    assert.notEqual(r.status, 0, "빈 세션은 실패 종료");
    assert.match(r.out, /이어받을 내용이 없습니다|중앙 기록이 없습니다/, "빈 기록 안내");
    ok("🔴 중앙 기록 0 → 이어받을 내용 없음");
  }

  // ── ✅ 소유자 → 물질화 + claude --resume 준비 ──
  {
    const r = await runResume("s-mine");
    assert.equal(r.status, 0, "소유자는 정상 종료");
    assert.match(r.out, /claude --resume s-mine/, "claude --resume 명령을 준비");
    // 물질화 경로를 stdout 에서 추출해 실제 파일·내용 검증.
    const mm = r.out.match(/물질화:\s*(\S+\.jsonl)/);
    assert.ok(mm, "물질화 경로를 출력");
    const file = mm[1];
    assert.ok(file.endsWith(path.join("s-mine.jsonl")), "파일명이 <sid>.jsonl");
    assert.match(file, /\.claude\/projects\//, "claude 프로젝트 경로로 물질화");
    assert.equal(fs.readFileSync(file, "utf8"), TRANSCRIPT, "✅ 중앙 트랜스크립트를 그대로 로컬에 물질화");
    ok("✅ 소유자 → 트랜스크립트 물질화 + claude --resume 준비");
  }

  // ── 잘못된 세션 id → 사용법(2) ──
  {
    const r = await runResume("bad id!");
    assert.equal(r.status, 2, "형식 오류는 exit 2");
    assert.match(r.out, /사용법/, "사용법 안내");
    ok("잘못된 세션 id → 사용법(exit 2)");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

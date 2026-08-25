#!/usr/bin/env node
// 세션이력 캡처 훅 (#905 C1 슬2c) — 가짜 게이트웨이 + 진짜 훅 프로세스 e2e.
//  실행: node kit/hooks/session-log-capture.test.mjs   (npm test 체인)
//
//  계약(대부분 "무엇을 안 하는가" — 대화 전문이 중앙에 나가므로):
//   🔴 capture.enabled 꺼짐 → 아무것도 안 보냄(조직이 켜야 캡처).
//   🔴 정책 밖 하네스 → 안 보냄.
//   🔴 로컬 오프셋 상태 파일 없음 — 서버 워터마크(GET)부터 트랜스크립트를 읽어 그 지점에 append.
//   🔴 session_id·transcript_path 없으면 no-op.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = path.join(fileURLToPath(import.meta.url), "..", "examples", "session-log-capture.org-hook.mjs");
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 세션별 워터마크 + 캡처 정책 + 받은 append 기록 ──
let SERVER = {};        // sessionId → { bytes, chunks: [{at, body}] }
let CAPTURE = { enabled: true, harnesses: ["claude"], scope: "main", store: "raw" };
let appends = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/api\/ui\/v6\/sessions\/([^/]+)\/log(\/watermark)?$/);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!m) { res.writeHead(404); return res.end(); }
    const sid = decodeURIComponent(m[1]);
    const s = SERVER[sid] || (SERVER[sid] = { bytes: 0, chunks: [] });
    if (m[2] === "/watermark" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ bytes: s.bytes, capture: CAPTURE }));
    }
    if (req.method === "POST") {   // append
      const at = Number(u.searchParams.get("at"));
      const body = Buffer.concat(chunks);
      appends.push({ sid, at, harness: u.searchParams.get("harness"), node: u.searchParams.get("node"),
        execution: u.searchParams.get("execution"), headerSession: req.headers["x-lively-session"], body: body.toString() });
      if (at === s.bytes) { s.bytes += body.length; s.chunks.push({ at, body: body.toString() }); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, verdict: "append", bytes: s.bytes })); }
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: false, verdict: "gap", bytes: s.bytes }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-slog-"));
async function runHook(ev, { harness = "claude", env = {} } = {}) {
  const home = await fsp.mkdtemp(path.join(root, "home-"));
  await fsp.mkdir(path.join(home, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(home, ".lively", "token"), "t\n");
  await fsp.writeFile(path.join(home, ".lively", "gateway-url"), BASE + "\n");
  const c = spawn(process.execPath, [HOOK], {
    cwd: root, env: { ...process.env, LIVELY_HOME: home, LIVELY_HARNESS: harness, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "t",
      LIVELY_SESSION_ID: "box-log-e2e", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify(ev));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
async function mkTranscript(name, content) {
  const p = path.join(root, name);
  await fsp.writeFile(p, content);
  return p;
}
const reset = () => { SERVER = {}; appends = []; CAPTURE = { enabled: true, harnesses: ["claude"], scope: "main", store: "raw" }; };

try {
  // ── 🔴 조직 스위치 꺼짐 → 아무것도 안 보냄 ──
  {
    reset(); CAPTURE.enabled = false;
    const tp = await mkTranscript("t1.jsonl", '{"type":"user"}\n{"type":"assistant"}\n');
    await runHook({ session_id: "s1", transcript_path: tp });
    assert.equal(appends.length, 0, "🔴 capture.enabled 꺼졌는데 전송함 — 조직이 안 켰으면 안 보냄");
    ok("🔴 enabled 꺼짐 → 전송 안 함");
  }

  // ── 🔴 정책 밖 하네스 → 안 보냄 ──
  {
    reset(); CAPTURE.harnesses = ["claude"];
    const tp = await mkTranscript("t2.jsonl", "line\n");
    await runHook({ session_id: "s2", transcript_path: tp }, { harness: "codex" });
    assert.equal(appends.length, 0, "🔴 harnesses 에 없는 codex 인데 전송함");
    ok("🔴 정책 밖 하네스 → 전송 안 함");
  }

  // ── 첫 캡처 → 워터마크 0 부터 전문 전송 ──
  {
    reset();
    const body = '{"type":"user","message":{"content":"안녕"}}\n{"type":"assistant"}\n';
    const tp = await mkTranscript("t3.jsonl", body);
    await runHook({ session_id: "s3", transcript_path: tp });
    assert.equal(appends.length, 1, "첫 턴에 한 번 전송");
    assert.equal(appends[0].at, 0, "워터마크 0 부터");
    assert.equal(appends[0].harness, "claude");
    assert.equal(appends[0].execution, "box-log-e2e", "대화 id와 별개인 실행 세션 id를 명시");
    assert.equal(appends[0].headerSession, "box-log-e2e", "query 실행 id와 인증 헤더가 일치");
    assert.equal(appends[0].body, body, "트랜스크립트 전문을 보냄");
    assert.equal(SERVER["s3"].bytes, Buffer.byteLength(body), "서버 워터마크가 그만큼 전진");
    ok("첫 캡처 → 워터마크 0부터 전문 전송 + 서버 전진");
  }

  // ── 둘째 턴 → 늘어난 꼬리만(서버 워터마크부터) ──
  {
    reset();
    const first = "aaaa\n";
    const tp = await mkTranscript("t4.jsonl", first);
    await runHook({ session_id: "s4", transcript_path: tp });
    const before = SERVER["s4"].bytes;
    const added = "bbbbbb\n";
    await fsp.appendFile(tp, added);
    appends = [];
    await runHook({ session_id: "s4", transcript_path: tp });
    assert.equal(appends.length, 1);
    assert.equal(appends[0].at, before, "둘째 턴은 서버 워터마크(=첫 턴 끝)부터");
    assert.equal(appends[0].body, added, "🔴 늘어난 꼬리만 보냄(중복 전송 없음)");
    ok("둘째 턴 → 서버 워터마크부터 늘어난 꼬리만(로컬 상태 파일 없이)");
  }

  // ── 늘어난 게 없으면 안 보냄 ──
  {
    reset();
    const body = "same\n";
    const tp = await mkTranscript("t5.jsonl", body);
    await runHook({ session_id: "s5", transcript_path: tp });   // 전송 1
    appends = [];
    await runHook({ session_id: "s5", transcript_path: tp });   // 변화 없음
    assert.equal(appends.length, 0, "파일이 안 늘었으면 전송 안 함");
    ok("변화 없음 → 전송 안 함");
  }

  // ── session_id / transcript_path 없으면 no-op ──
  {
    reset();
    const tp = await mkTranscript("t6.jsonl", "x\n");
    await runHook({ transcript_path: tp });                 // session_id 없음
    await runHook({ session_id: "s6" });                    // transcript_path 없음
    await runHook({ session_id: "s6", transcript_path: path.join(root, "nope.jsonl") }); // 파일 없음
    assert.equal(appends.length, 0, "필수정보 없거나 파일 없으면 no-op");
    ok("session_id·transcript_path 부재/파일 없음 → no-op");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

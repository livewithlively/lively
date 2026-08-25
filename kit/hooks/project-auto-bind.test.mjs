// 실행 세션 DB 소속 기반 자동 프로젝트 생성 E2E — 가짜 게이트웨이 + 실제 훅 프로세스.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "examples", "project-auto-bind.org-hook.mjs");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

async function bodyOf(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

async function startGateway() {
  const states = new Map();
  const revisions = new Map();
  const hits = [];
  const deleted = [];
  const failBindOnce = new Set();
  let nextProject = 100;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://test");
    const session = String(req.headers["x-lively-session"] || "");
    const body = await bodyOf(req);
    hits.push({ method: req.method, path: url.pathname, session, body });
    res.setHeader("content-type", "application/json");

    const context = /^\/api\/ui\/execution-sessions\/([^/]+)\/project-context$/.exec(url.pathname);
    if (req.method === "GET" && context) {
      const sid = decodeURIComponent(context[1]);
      const projectId = states.get(sid) ?? null;
      const revision = revisions.get(sid) ?? (projectId == null ? 0 : 1);
      res.writeHead(200); res.end(JSON.stringify({ found: revisions.has(sid) || projectId != null, project_id: projectId, revision })); return;
    }
    if (req.method === "POST" && url.pathname === "/api/ui/v6/projects") {
      const id = nextProject++;
      res.writeHead(200); res.end(JSON.stringify({ project: { id } })); return;
    }
    const bind = /^\/api\/ui\/terminal\/sessions\/([^/]+)\/project$/.exec(url.pathname);
    if (req.method === "POST" && bind) {
      const sid = decodeURIComponent(bind[1]);
      if (failBindOnce.delete(sid)) { res.writeHead(500); res.end("{}"); return; }
      states.set(sid, Number(body.projectId));
      revisions.set(sid, (revisions.get(sid) ?? 0) + 1);
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }
    const del = /^\/api\/ui\/v6\/projects\/(\d+)\/delete$/.exec(url.pathname);
    if (req.method === "POST" && del) {
      deleted.push(Number(del[1]));
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, states, revisions, hits, deleted, failBindOnce };
}

async function runHook(cwd, base, env, prompt = "이 작업을 실제 코드로 구현하고 테스트까지 완료해줘", input = {}) {
  const child = spawn(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: base, LIVELY_HOME: cwd,
      LIVELY_SESSION_ID: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ cwd, prompt, ...input }));
  let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, `훅은 항상 exit 0 — 실제 ${code}`);
  return out;
}

const flagPath = (sid, revision = 0) => path.join(os.tmpdir(), "lively-hooks", `${sid}.${revision}.projauto`);

async function main() {
  const gw = await startGateway();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-autobind-"));
  const sids = [];
  const sid = (suffix) => { const id = `box-e2e-${process.pid}-${suffix}`; sids.push(id); return id; };
  try {
    {
      const s = sid("create");
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(out, /프로젝트 #100/);
      assert.equal(gw.states.get(s), 100);
      const calls = gw.hits.filter((h) => h.session === s);
      assert.deepEqual(calls.map((h) => `${h.method} ${h.path}`), [
        `GET /api/ui/execution-sessions/${s}/project-context`,
        "POST /api/ui/v6/projects",
        `POST /api/ui/terminal/sessions/${s}/project`,
      ]);
      assert.ok(String(calls[1].body.description).includes("첫 지시(원문)"));
      ok("미연결 관리 세션 → 프로젝트 생성·DB 바인딩");
    }
    {
      const s = sid("bound"); gw.states.set(s, 77);
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.equal(out, "");
      assert.equal(gw.hits.length - before, 1);
      ok("이미 연결된 세션 → 생성 없음");
    }
    {
      const cwd = path.join(root, "marker"); await fsp.mkdir(path.join(cwd, ".lively"), { recursive: true });
      await fsp.writeFile(path.join(cwd, ".lively", "project.json"), JSON.stringify({ kind: "session", project_id: 999 }));
      const s = sid("marker");
      const out = await runHook(cwd, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(out, /프로젝트 #101/);
      assert.equal(gw.states.get(s), 101);
      assert.deepEqual((await fsp.readdir(cwd)).sort(), [".lively"]);
      ok("cwd의 구 session marker를 무시하고 DB만 판정");
    }
    {
      const native = `thread-${process.pid}-codex`;
      const execution = `codex-${native}`; sids.push(execution);
      const out = await runHook(root, gw.base, { LIVELY_HARNESS: "codex" }, undefined, { session_id: native });
      assert.match(out, /프로젝트 #102/);
      assert.equal(gw.states.get(execution), 102);
      assert.ok(gw.hits.filter((h) => h.session === execution).length >= 3);
      ok("외부 Codex stdin session_id → codex-* 실행 ID로 생성·바인딩");
    }
    {
      const s = sid("retry"); gw.failBindOnce.add(s);
      const out1 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.equal(out1, "");
      assert.deepEqual(gw.deleted.slice(-1), [103]);
      assert.equal(fs.existsSync(flagPath(s)), false, "실패 플래그는 되돌려 다음 턴 재시도");
      const out2 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(out2, /프로젝트 #104/);
      assert.equal(gw.states.get(s), 104);
      ok("바인딩 실패 → 생성 프로젝트 보상 삭제·다음 턴 재시도");
    }
    {
      const s = sid("detach");
      const first = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(first, /프로젝트 #105/);
      assert.equal(gw.revisions.get(s), 1);
      gw.states.set(s, null); gw.revisions.set(s, 2);
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(out, /프로젝트 #106/);
      assert.equal(gw.states.get(s), 106);
      assert.equal(gw.revisions.get(s), 3);
      ok("detach 뒤 새 revision → 이전 single-flight 플래그와 무관하게 다시 자동 생성");
    }
    {
      const s = sid("short");
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }, "계속");
      assert.equal(out, ""); assert.equal(gw.hits.length, before);
      assert.equal(fs.existsSync(flagPath(s)), false);
      ok("짧은 지시 → 생성·플래그 소모 없음");
    }
    {
      // 하네스 미지정(외부 Claude Code) + stdin session_id → claude-* 실행 ID 로 생성·바인딩(러너 규약: 미지정=claude).
      const native = `thread-${process.pid}-claude`;
      const execution = `claude-${native}`; sids.push(execution);
      const out = await runHook(root, gw.base, {}, undefined, { session_id: native });
      assert.match(out, /프로젝트 #107/);
      assert.equal(gw.states.get(execution), 107);
      ok("하네스 미지정 + stdin session_id → claude-* 실행 ID로 생성·바인딩");
    }
    console.log(`\n${pass} passed`);
  } finally {
    gw.server.close();
    for (const s of sids) for (let rev = 0; rev < 5; rev++) await fsp.rm(flagPath(s, rev), { force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

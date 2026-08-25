// 실행 세션 DB 바인딩 기반 AGENTS 주입 E2E — 가짜 게이트웨이 + 실제 훅 프로세스.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(process.argv[2] || process.env.PROJECT_AGENTS_HOOK || path.join(here, "examples", "project-agents-inject.org-hook.mjs"));
const AGENTS = { 11: "# 프로젝트 11 규칙\n- 커밋 전 빌드\n", 22: "# 프로젝트 22 규칙\n- 다른 규칙\n", 33: "X".repeat(40 * 1024) };
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

async function startGateway() {
  const hits = [];
  const acks = [];
  const states = new Map();
  let fail = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://test");
    hits.push({ url: req.url, session: req.headers["x-lively-session"] });
    const ack = /^\/api\/ui\/execution-sessions\/([^/]+)\/project-context\/applied$/.exec(u.pathname);
    if (ack && req.method === "POST") {
      let raw = "";
      req.setEncoding("utf8"); req.on("data", (c) => { raw += c; }); req.on("end", () => {
        const sid = decodeURIComponent(ack[1]);
        let revision = -1; try { revision = Number(JSON.parse(raw || "{}").revision); } catch { /* 400 below */ }
        const state = states.get(sid);
        if (!state || !Number.isSafeInteger(revision) || revision < 0 || revision > state.revision) {
          res.writeHead(400); res.end(); return;
        }
        state.applied_revision = Math.max(Number(state.applied_revision || 0), revision);
        acks.push({ sid, revision, session: req.headers["x-lively-session"] });
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    const m = /^\/api\/ui\/execution-sessions\/([^/]+)\/project-context$/.exec(u.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    if (fail) { res.writeHead(500); res.end(); return; }
    const sid = decodeURIComponent(m[1]);
    const state = states.get(sid) || { found: false, project_id: null, revision: 0, binding_epoch: 0 };
    const known = Number(u.searchParams.get("knownRevision"));
    const changed = known !== state.revision;
    const content = state.project_id ? AGENTS[state.project_id] : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...state, session_id: sid, changed, ...(changed && content !== undefined ? { content } : {}) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, hits, acks, states, setFail: (v) => { fail = v; } };
}

async function runHook(cwd, base, env = {}, input = {}) {
  const child = spawn(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: base, LIVELY_HOME: cwd,
      LIVELY_SESSION_ID: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ cwd, prompt: "이 프로젝트 어떻게 되고 있어?", ...input }));
  let out = ""; child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, `훅은 항상 exit 0 — 실제 ${code}`);
  return out;
}
const statePathOf = (sid) => path.join(os.tmpdir(), "lively-hooks", `${sid}.projagents`);

async function main() {
  const gw = await startGateway();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-agentsinject-"));
  const sids = [];
  // run-tests가 파일 단위를 병렬 실행해도 tmp 상태파일이 서로 충돌하지 않게 프로세스별 id를 쓴다.
  const sid = (n) => { const id = `box-test-${process.pid}-${n}`; sids.push(id); return id; };
  try {
    {
      const s = sid("f1"); gw.states.set(s, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.ok(out.includes("# 프로젝트 11 규칙") && out.includes("#11"));
      assert.equal(gw.hits.at(-1).session, s);
      assert.deepEqual(gw.acks.at(-1), { sid: s, revision: 1, session: s });
      ok("B1 관리 세션 → DB 프로젝트 본문 주입");
    }
    {
      const s = sid("f2"); gw.states.set(s, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.equal(out.trim(), "");
      assert.equal(gw.hits.length - before, 1, "매 턴 revision 조회는 한 번, 본문은 생략");
      assert.match(gw.hits.at(-1).url, /knownRevision=1/);
      ok("같은 revision → 본문 재주입 없음");
    }
    {
      const s = sid("f3"); gw.states.set(s, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      gw.states.set(s, { found: true, project_id: 22, revision: 2, binding_epoch: 2 });
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.ok(out.includes("# 프로젝트 22 규칙") && out.includes("#11") && out.includes("더 이상 적용되지 않습니다"));
      ok("B4 전환 → 이전 규칙 무효화 + 새 본문");
    }
    {
      const s = sid("f4"); gw.states.set(s, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      gw.states.set(s, { found: true, project_id: null, revision: 2, binding_epoch: 2 });
      const out1 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      const out2 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.ok(out1.includes("#11") && out1.includes("더 이상 적용되지 않습니다"));
      assert.equal(out2.trim(), "");
      assert.deepEqual(gw.acks.at(-1), { sid: s, revision: 2, session: s });
      ok("B5 해제 → 무효화 한 번");
    }
    {
      const cwd = path.join(root, "shared-cwd"); await fsp.mkdir(cwd);
      const marker = path.join(cwd, "sentinel.txt"); await fsp.writeFile(marker, "keep");
      const a = sid("f5a"), b = sid("f5b");
      gw.states.set(a, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      gw.states.set(b, { found: true, project_id: 22, revision: 1, binding_epoch: 1 });
      const [oa, ob] = await Promise.all([runHook(cwd, gw.base, { LIVELY_SESSION_ID: a }), runHook(cwd, gw.base, { LIVELY_SESSION_ID: b })]);
      assert.ok(oa.includes("프로젝트 11") && !oa.includes("프로젝트 22"));
      assert.ok(ob.includes("프로젝트 22") && !ob.includes("프로젝트 11"));
      assert.deepEqual((await fsp.readdir(cwd)).sort(), ["sentinel.txt"]);
      assert.equal(await fsp.readFile(marker, "utf8"), "keep");
      ok("B3 같은 cwd·서로 다른 실행 세션 → 격리 + cwd 무변형");
    }
    {
      const native = `thread-${process.pid}-abcdef`;
      const execution = `codex-${native}`; sids.push(execution);
      gw.states.set(execution, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      const out = await runHook(root, gw.base, { LIVELY_HARNESS: "codex" }, { session_id: native });
      assert.ok(out.includes("프로젝트 11"));
      assert.equal(gw.hits.at(-1).session, execution);
      ok("B2 외부 Codex stdin session_id → codex-* 실행 ID");
    }
    {
      const s = sid("f7"); gw.states.set(s, { found: true, project_id: 11, revision: 1, binding_epoch: 1 });
      gw.setFail(true); const out1 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }); gw.setFail(false);
      assert.equal(out1.trim(), ""); assert.equal(fs.existsSync(statePathOf(s)), false);
      assert.ok(!gw.acks.some((a) => a.sid === s), "조회 실패를 applied로 오인하면 안 된다");
      const out2 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }); assert.ok(out2.includes("프로젝트 11"));
      ok("B11 조회 실패 → 무출력·다음 턴 재시도");
    }
    {
      const s = sid("f8"); gw.states.set(s, { found: true, project_id: 33, revision: 1, binding_epoch: 1 });
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.ok(out.length < AGENTS[33].length && out.includes("project_get_v6(33)"));
      ok("B12 상한 초과 → 절단 + 전문 안내");
    }
    {
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, {});
      assert.equal(out.trim(), ""); assert.equal(gw.hits.length, before);
      ok("B7·B17 실행 ID 없음 → no-op");
    }
    {
      const cwd = path.join(root, "marker-ignored"); await fsp.mkdir(path.join(cwd, ".lively"), { recursive: true });
      await fsp.writeFile(path.join(cwd, ".lively", "project.json"), JSON.stringify({ kind: "session", project_id: 11 }));
      const s = sid("f10"); gw.states.set(s, { found: false, project_id: null, revision: 0, binding_epoch: 0 });
      const out = await runHook(cwd, gw.base, { LIVELY_SESSION_ID: s });
      assert.equal(out.trim(), "");
      ok("cwd의 구 session project.json은 소속으로 읽지 않음");
    }
    assert.ok(gw.hits.length > 0 && gw.hits.every((h) => h.url.includes("/execution-sessions/")));
    console.log(`\n${pass} passed`);
  } finally {
    gw.server.close();
    for (const s of sids) await fsp.rm(statePathOf(s), { force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

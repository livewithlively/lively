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
      // 짧은 지시도 만든다(2026-08-25 상민님 지적): 종전 12자 게이트는 짧은 말만 오가는 세션을 **영영 미연결**로 남겼다.
      //  귀속은 기본값이고, 짧은 제목은 정련이 고친다.
      const s = sid("short");
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }, "계속");
      assert.match(out, /프로젝트 #\d+/);
      assert.ok(Number(gw.states.get(s)) > 0, "짧은 지시로도 바인딩된다");
      ok("짧은 지시 → 그래도 생성·바인딩(제목은 정련이 고친다)");
    }
    {
      // 슬래시·뱅·주입물은 여전히 미룬다 — 사람의 지시가 아니다. 플래그를 안 써야 다음 프롬프트에 다시 본다.
      const s = sid("slash");
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }, "/status");
      assert.equal(out, ""); assert.equal(gw.hits.length, before);
      assert.equal(fs.existsSync(flagPath(s)), false, "플래그를 소모하면 다음 실질 지시에서 못 만든다");
      const out2 = await runHook(root, gw.base, { LIVELY_SESSION_ID: s }, "이제 진짜 지시를 준다");
      assert.match(out2, /프로젝트 #\d+/, "미룬 뒤 다음 프롬프트에서 만든다");
      ok("슬래시 커맨드 → 미룸(플래그 미소모) · 다음 실질 지시에서 생성");
    }
    {
      // 하네스 미지정(외부 Claude Code) + stdin session_id → claude-* 실행 ID 로 생성·바인딩(러너 규약: 미지정=claude).
      const native = `thread-${process.pid}-claude`;
      const execution = `claude-${native}`; sids.push(execution);
      const out = await runHook(root, gw.base, {}, undefined, { session_id: native });
      // ⚠ id 를 박지 않는다 — 앞 행이 몇 개를 만들었는지에 따라 번호가 밀린다(행을 더할 때마다 깨지는 자리였다).
      assert.match(out, /프로젝트 #\d+/);
      assert.ok(Number(gw.states.get(execution)) > 0, "그 실행 ID 로 바인딩됐다");
      ok("하네스 미지정 + stdin session_id → claude-* 실행 ID로 생성·바인딩");
    }
    // ── #1979 항목4 — **위탁(task) 세션은 프로젝트를 만들지 않는다.** ────────────────────────────
    //  🔴 이 가드가 없어서 실제로 났던 일(프로덕션 실측 2026-08-25~27): 위탁 워커(spawnTaskSession)는 자기
    //   LIVELY_SESSION_ID 를 제대로 실어 **정상 세션으로** 뜨는데, 그 세션의 첫 프롬프트가 **서버가 조립한
    //   시스템 프롬프트**라 이 훅이 사람의 첫 지시로 오인했다. 배치 1회 = 프로젝트 1개:
    //     #2019 «이 사람이 방금 라이블리에 올린 파일 목록입니다…» · #2123 «도메인맵 미분류 매핑»
    //     #2152 «내 컴퓨터 자료 증류 배치»  ← 10분 주기 증류 크론만으로 하루 100건대
    //  단언은 **부작용**으로 한다: 게이트웨이 요청이 한 건도 없어야 한다(문구 대조가 아니라 관측 가능한 효과).
    {
      const s = sid("task-ws");
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s, LIVELY_TASK_WS: "/tmp/lively-task-ws-e2e" });
      assert.equal(out, "", "위탁 세션엔 아무것도 주입하지 않는다");
      assert.equal(gw.hits.length - before, 0, "위탁 세션은 게이트웨이를 **한 번도** 부르지 않는다(조회조차 안 한다)");
      assert.equal(gw.states.get(s), undefined, "위탁 세션에 프로젝트가 붙으면 안 된다");
      ok("★위탁 세션(LIVELY_TASK_WS) → 프로젝트 생성 0 · 게이트웨이 요청 0");
    }
    // 대조군 — 같은 조건에서 표식만 빼면 **종전대로 생성된다**. 이게 없으면 위 단언이 vacuous 하다
    //  (훅이 다른 이유로 죽어도 '요청 0건'은 참이 되므로).
    {
      const s = sid("task-ws-control");
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s });
      assert.match(out, /프로젝트 #\d+/, "대조군은 종전대로 프로젝트를 만든다");
      assert.ok(gw.hits.length - before >= 3, "대조군은 조회·생성·바인딩을 실제로 부른다");
      assert.ok(Number(gw.states.get(s)) > 0);
      ok("대조군(표식 없음) — 종전대로 생성·바인딩(가드가 일반 세션을 안 건드린다)");
    }
    // 경계 — 빈 값·공백은 표식이 아니다. env 를 ""로 지우는 배선(runHook 의 기본값)이 실수로 가드를 켜면
    //  **모든 세션이 프로젝트를 잃는다**. 그 자리를 못박는다.
    for (const [label, val] of [["빈 문자열", ""], ["공백만", "   "]]) {
      const s = sid(`task-ws-empty-${val.length}`);
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s, LIVELY_TASK_WS: val });
      assert.match(out, /프로젝트 #\d+/, `LIVELY_TASK_WS=${label} 은 표식이 아니다 — 종전대로 생성돼야 한다`);
      ok(`경계 — LIVELY_TASK_WS ${label} 은 위탁 표식이 아니다`);
    }
    // 이미 프로젝트에 바인딩된 위탁(delegate_run 등)은 **종전에도** 아무 일도 안 했다 — 가드가 그 동작을
    //  바꾸지 않는지 본다(의도된 바인딩을 깨지 않는다는 근거).
    {
      const s = sid("task-ws-bound"); gw.states.set(s, 88);
      const before = gw.hits.length;
      const out = await runHook(root, gw.base, { LIVELY_SESSION_ID: s, LIVELY_TASK_WS: "/tmp/lively-task-ws-e2e" });
      assert.equal(out, "");
      assert.equal(gw.states.get(s), 88, "이미 붙은 소속은 그대로다");
      assert.equal(gw.hits.length - before, 0);
      ok("명시 바인딩된 위탁 — 소속 유지, 아무 변화 없음");
    }

    console.log(`\n${pass} passed`);
  } finally {
    gw.server.close();
    for (const s of sids) for (let rev = 0; rev < 5; rev++) await fsp.rm(flagPath(s, rev), { force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

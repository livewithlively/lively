// 프로젝트 AGENTS.md 주입 훅 e2e (#1856 B) — 가짜 게이트웨이 + 진짜 훅 프로세스로 검증.
//  실행: node kit/hooks/project-agents-inject.test.mjs
//
//  왜 e2e 인가: 이 훅의 가치는 **무엇이 stdout 에 실리는가**(= 모델이 실제로 읽는 것)와 **언제 네트워크를
//   타는가**(= 턴당 비용)다. 둘 다 프로세스를 돌려 출력과 요청 로그를 봐야만 안다.
//  단언은 부작용 기반 — 출력 포함 여부·요청 카운트·상태파일. 문구 전체 매칭은 하지 않는다(문안은 바뀐다).
//  검증 대상 = kit/hooks/examples/project-agents-inject.org-hook.mjs (SoT).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "examples", "project-agents-inject.org-hook.mjs");

let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

const AGENTS = {
  11: "# 프로젝트 11 규칙\n- 커밋 전 빌드\n",
  22: "# 프로젝트 22 규칙\n- 다른 프로젝트의 규칙\n",
  33: "X".repeat(40 * 1024),   // 주입 상한(24KB) 초과 — 잘려야 한다
};

// ── 가짜 게이트웨이 — 요청을 전부 기록한다(배선 단언: 안 탔어야 할 네트워크를 안 탔는가). ──
async function startGateway() {
  const hits = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const m = /^\/api\/ui\/v6\/projects\/(\d+)\/agents/.exec(req.url || "");
    if (!m) { res.writeHead(404); res.end(); return; }
    if (fail) { res.writeHead(500); res.end(); return; }
    const id = Number(m[1]);
    const content = AGENTS[id];
    if (content === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ project_id: id, name: `P${id}`, content, bytes: Buffer.byteLength(content) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, hits, setFail: (v) => { fail = v; } };
}

// 훅을 진짜 프로세스로 실행. 훅 불변식상 항상 exit 0. stdout 이 곧 주입 컨텍스트다.
async function runHook(cwd, base, sessionId, env = {}) {
  const child = spawn(process.execPath, [HOOK], {
    cwd,
    env: {
      ...process.env, LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: base, LIVELY_HOME: cwd,
      LIVELY_SESSION_ID: sessionId, ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ cwd, prompt: "이 프로젝트 어떻게 되고 있어?" }));
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, `훅은 절대 프롬프트를 막지 않는다(exit 0) — 실제 ${code}`);
  return out;
}

const writeMarker = async (dir, marker) => {
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
};
const rmMarker = async (dir) => { await fsp.rm(path.join(dir, ".lively", "project.json"), { force: true }); };
const statePathOf = (sid) => path.join(os.tmpdir(), "lively-hooks", `${sid}.projagents`);

async function main() {
  const { server, base, hits, setFail } = await startGateway();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-agentsinject-"));
  const sids = [];
  const sid = (n) => { const s = `box-test-${process.pid}-${n}`; sids.push(s); return s; };
  try {
    // ── F1 — 첫 주입: 전문이 stdout 에 실린다 ──
    {
      const dir = path.join(root, "f1"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f1");
      const before = hits.length;
      const out = await runHook(dir, base, s);
      assert.ok(out.includes("# 프로젝트 11 규칙"), "AGENTS.md 전문이 주입되지 않았다");
      assert.ok(out.includes("#11"), "어느 프로젝트의 규칙인지 밝혀야 한다");
      assert.equal(hits.length - before, 1, "첫 주입은 서버를 정확히 한 번 탄다");
      assert.ok(fs.existsSync(statePathOf(s)), "주입 이력이 남아야 다음 턴에 반복하지 않는다");
      ok("[F1] 세션 마커 · 첫 주입 → 전문 주입 + 이력 기록");
    }

    // ── F2 🔴 같은 바인딩 재실행: 무출력 + **네트워크 0** (턴당 비용의 핵심) ──
    {
      const dir = path.join(root, "f2"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f2");
      await runHook(dir, base, s);
      const before = hits.length;
      const out = await runHook(dir, base, s);
      assert.equal(out.trim(), "", "같은 바인딩인데 또 주입했다(매 턴 컨텍스트 낭비)");
      assert.equal(hits.length - before, 0, "같은 바인딩인데 서버를 탔다 — 매 턴 왕복이 붙는다");
      ok("[F2] 같은 바인딩 재실행 → 무출력 · 서버 요청 0건");
    }

    // ── F3 — 다른 프로젝트로 전환: 옛 규칙 무효화 + 새 본문 ──
    //  이미 실린 컨텍스트는 회수할 수 없어서, 말로 취소하지 않으면 두 프로젝트 규칙이 함께 남는다.
    {
      const dir = path.join(root, "f3"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f3");
      await runHook(dir, base, s);
      await writeMarker(dir, { kind: "session", project_id: 22, project_dir: null, bound_at: "T2" });
      const out = await runHook(dir, base, s);
      assert.ok(out.includes("# 프로젝트 22 규칙"), "새 프로젝트의 규칙이 주입되지 않았다");
      assert.ok(out.includes("#11"), "옛 프로젝트를 지목해 무효화해야 한다");
      assert.ok(/더 이상 적용되지 않습니다/.test(out), "옛 규칙 무효화 선언이 없다 — 모델이 둘 다 유효로 읽는다");
      ok("[F3] 프로젝트 전환 → 옛 프로젝트 무효화 + 새 본문");
    }

    // ── F4 — 같은 프로젝트로 **재바인딩**(bound_at 만 갱신): 다시 주입한다 ──
    {
      const dir = path.join(root, "f4"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f4");
      await runHook(dir, base, s);
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T9" });
      const out = await runHook(dir, base, s);
      assert.ok(out.includes("# 프로젝트 11 규칙"), "재바인딩인데 주입하지 않았다(bound_at 을 신원에 안 넣었다)");
      ok("[F4] 같은 프로젝트 재바인딩(bound_at 갱신) → 다시 주입");
    }

    // ── F5 — 뗌: 무효화 문장만 한 번, 두 번째는 조용 ──
    {
      const dir = path.join(root, "f5"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f5");
      await runHook(dir, base, s);
      await rmMarker(dir);
      const out1 = await runHook(dir, base, s);
      assert.ok(/더 이상 적용되지 않습니다/.test(out1) && out1.includes("#11"), "뗐는데 옛 규칙을 취소하지 않았다");
      assert.ok(!out1.includes("# 프로젝트 11 규칙"), "뗌인데 본문을 다시 실었다");
      const before = hits.length;
      const out2 = await runHook(dir, base, s);
      assert.equal(out2.trim(), "", "뗌 고지는 1회 — 매 턴 반복하면 소음이다");
      assert.equal(hits.length - before, 0, "뗌 상태에서 서버를 탔다");
      ok("[F5] 뗌 → 무효화 문장 1회만 · 이후 조용 · 네트워크 0");
    }

    // ── F6 — 프로젝트 폴더에서 직접 뜬 세션(kind 없음): 하네스가 파일로 이미 읽었다 → 주입 금지 ──
    {
      const dir = path.join(root, "f6"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { project_id: 11, sync: "pull" });
      const s = sid("f6");
      const before = hits.length;
      const out = await runHook(dir, base, s);
      assert.equal(out.trim(), "", "프로젝트 폴더 세션에 중복 주입했다(cwd 의 AGENTS.md 를 이미 읽는다)");
      assert.equal(hits.length - before, 0, "프로젝트 폴더 세션인데 서버를 탔다");
      ok("[F6] 프로젝트 폴더 마커(kind 없음) → no-op · 요청 0건");
    }

    // ── F7 🔴 서버 5xx: 무출력 + 상태 미기록 → 다음 턴 재시도(일시 장애로 영영 못 받으면 안 된다) ──
    {
      const dir = path.join(root, "f7"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const s = sid("f7");
      setFail(true);
      const before = hits.length;
      const out = await runHook(dir, base, s);
      assert.equal(out.trim(), "", "서버 실패인데 뭔가를 주입했다");
      assert.ok(!fs.existsSync(statePathOf(s)), "실패했는데 이력을 남겼다 — 다음 턴 재시도가 막힌다");
      setFail(false);
      const out2 = await runHook(dir, base, s);
      assert.ok(out2.includes("# 프로젝트 11 규칙"), "다음 턴에 재시도하지 않았다");
      assert.equal(hits.length - before, 2, "재시도 왕복이 정확히 2회여야 한다");
      ok("[F7] 서버 5xx → 무출력 · 이력 미기록 · 다음 턴 재시도");
    }

    // ── F8 — 상한 초과: 잘라 내되 전문 조회 경로를 남긴다 ──
    {
      const dir = path.join(root, "f8"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 33, project_dir: null, bound_at: "T1" });
      const out = await runHook(dir, base, sid("f8"));
      assert.ok(out.length < AGENTS[33].length, "상한을 넘겼는데 통째로 실었다");
      assert.ok(out.includes("project_get_v6(33)"), "잘랐으면 전문 조회 경로를 줘야 한다");
      ok("[F8] 주입 상한 초과 → 절단 + 전문 조회 안내");
    }

    // ── F9 — 라이블리 세션이 아니다(세션 id 없음): 아무것도 하지 않는다 ──
    {
      const dir = path.join(root, "f9"); await fsp.mkdir(dir, { recursive: true });
      await writeMarker(dir, { kind: "session", project_id: 11, project_dir: null, bound_at: "T1" });
      const before = hits.length;
      const out = await runHook(dir, base, "", { LIVELY_SESSION_ID: "" });
      assert.equal(out.trim(), "", "라이블리 세션이 아닌데 주입했다");
      assert.equal(hits.length - before, 0, "세션 id 가 없는데 서버를 탔다");
      ok("[F9] 라이블리 세션 아님 → 완전 no-op");
    }

    // ── F10 — 마커도 없고 이력도 없다: 완전 no-op ──
    {
      const dir = path.join(root, "f10"); await fsp.mkdir(dir, { recursive: true });
      const before = hits.length;
      const out = await runHook(dir, base, sid("f10"));
      assert.equal(out.trim(), "", "프로젝트가 없는 세션에 뭔가를 주입했다");
      assert.equal(hits.length - before, 0, "마커가 없는데 서버를 탔다");
      ok("[F10] 마커 없음 + 이력 없음 → 완전 no-op");
    }

    // 배선 단언 — 관측 장치가 죽어 있으면 위 '요청 0건'들은 전부 공허하게 통과한다.
    assert.ok(hits.length > 0 && hits.some((u) => u.includes("/agents")), "가짜 게이트웨이가 한 번도 안 불렸다 — 테스트가 공허하다");
    console.log(`\n${pass} passed`);
  } finally {
    server.close();
    for (const s of sids) await fsp.rm(statePathOf(s), { force: true }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

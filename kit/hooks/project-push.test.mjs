#!/usr/bin/env node
// project-push up-sync 훅 (#905 C3) — 가짜 게이트웨이 + 진짜 훅 프로세스 e2e.
//  실행: node kit/hooks/project-push.test.mjs   (npm test 체인)
//
//  이 훅은 **팀 공유문서를 덮어쓸 수 있다.** 그래서 여기 계약은 전부 "무엇을 안 하는가"다:
//   🔴 sync="both" 아니면 아무것도 안 한다(기존 설치 전원 무영향 — 옵트인).
//   🔴 서버가 우리 기준선(last_pull) 이후 바뀐 파일은 **절대 안 올린다** — 올리면 남의 작업이 사라진다.
//   🔴 삭제는 전파하지 않는다 — '로컬에 없음'이 '지웠음'을 뜻하지 않기 때문(안 받은 파일을 서버에서 지우게 된다).
//   🔴 코드(git 서브트리)·숨김은 절대 안 올린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = path.join(fileURLToPath(import.meta.url), "..", "examples", "project-push.org-hook.mjs");
const PROJECT_ID = 905;
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 서버 상태 + 받은 PUT 기록 ──
let SERVER = {};          // path → { body, mtime }
let puts = [], deletes = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
      const files = Object.entries(SERVER).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ files, newest: Math.max(0, ...files.map((f) => f.mtime)), count: files.length, truncated: false }));
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file` && req.method === "PUT") {
      const p = u.searchParams.get("path");
      puts.push({ path: p, body: Buffer.concat(chunks).toString() });
      SERVER[p] = { body: Buffer.concat(chunks).toString(), mtime: Date.now() };
      res.writeHead(200); return res.end("{}");
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file` && req.method === "DELETE") {
      deletes.push(u.searchParams.get("path")); res.writeHead(200); return res.end("{}");
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-push-"));
async function mkProj(name, marker, files = {}) {
  const dir = path.join(root, name);
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  for (const [p, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fsp.writeFile(path.join(dir, p), body);
  }
  return dir;
}
async function runHook(dir) {
  const c = spawn(process.execPath, [HOOK], {
    cwd: dir, env: { ...process.env, LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: dir }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify({ cwd: dir }));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
const upOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "sync-up.json"), "utf8")); } catch { return null; } };

try {
  // ── 🔴 옵트인 — sync 가 both 가 아니면 **아무것도 안 한다**(기존 설치 전원 무영향) ──
  for (const mode of [{ sync: "none" }, { sync: "pull" }, {}]) {
    puts = []; SERVER = {};
    const dir = await mkProj(`optin-${mode.sync || "unset"}`, { project_id: PROJECT_ID, ...mode }, { "doc.md": "로컬 변경" });
    await runHook(dir);
    assert.equal(puts.length, 0, `sync=${mode.sync || "(미명시)"} 인데 올렸다 — 옵트인 위반`);
    assert.equal(upOf(dir), null, "동작 안 했으면 기록도 남기지 않는다");
  }
  ok("🔴 sync 가 both 가 아니면(none·pull·미명시) 아무것도 안 올림 — 옵트인");

  // ── 새 문서 → 올린다 ──
  {
    puts = []; SERVER = {};
    const dir = await mkProj("new-doc", { project_id: PROJECT_ID, sync: "both", last_pull: Date.now() }, { "새문서.md": "내용", "sub/깊은문서.md": "안쪽" });
    await runHook(dir);
    assert.deepEqual(puts.map((p) => p.path).sort(), ["sub/깊은문서.md", "새문서.md"]);
    assert.equal(puts.find((p) => p.path === "새문서.md").body, "내용");
    assert.equal(upOf(dir).pushed, 2);
    ok("서버에 없는 새 문서(하위 폴더 포함) → 올림");
  }

  // ── 🔴 서버가 기준선 이후 바뀌었으면 **안 올린다**(남의 작업 보호) ──
  {
    puts = [];
    const lastPull = 1_000_000;
    SERVER = { "doc.md": { body: "남이 고친 서버본", mtime: lastPull + 5000 } };  // 우리가 받아간 뒤에 바뀜
    const dir = await mkProj("conflict", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, { "doc.md": "내 로컬 변경" });
    await runHook(dir);
    assert.equal(puts.length, 0, "🔴 서버가 그 사이 바뀌었는데 올렸다 — 남의 작업이 사라진다");
    assert.equal(SERVER["doc.md"].body, "남이 고친 서버본", "서버 본문이 보존돼야 함");
    const up = upOf(dir);
    assert.equal(up.conflicts.length, 1);
    assert.equal(up.conflicts[0].path, "doc.md");
    ok("🔴 서버가 기준선(last_pull) 이후 바뀐 파일 → 안 올리고 충돌로 기록(남의 작업 보호)");
  }

  // ── 서버가 기준선 이후 안 바뀌었으면 → 올린다(로컬만 변경) ──
  {
    puts = [];
    const lastPull = 1_000_000;
    SERVER = { "doc.md": { body: "옛 서버본", mtime: lastPull - 5000 } };
    const dir = await mkProj("safe-push", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, { "doc.md": "내 로컬 변경(더 김)" });
    await runHook(dir);
    assert.equal(puts.length, 1, "로컬만 바뀐 건 올려야 함");
    assert.equal(puts[0].body, "내 로컬 변경(더 김)");
    assert.equal(upOf(dir).conflicts.length, 0);
    ok("서버는 그대로 · 로컬만 변경 → 안전하게 올림");
  }

  // ── 🔴 삭제는 전파하지 않는다(의도) — '로컬에 없음' ≠ '지웠음' ──
  {
    puts = []; deletes = [];
    const lastPull = Date.now();
    SERVER = { "서버에만.md": { body: "서버 문서", mtime: lastPull - 1000 } };
    const dir = await mkProj("no-delete", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {});
    await runHook(dir);
    assert.equal(deletes.length, 0, "🔴 로컬에 없다고 서버에서 지우면 안 된다 — 애초에 안 받은 파일일 수 있다");
    assert.ok(SERVER["서버에만.md"], "서버 문서 보존");
    ok("🔴 로컬에 없는 서버 문서를 지우지 않는다(삭제 미전파 — 안 받은 파일 파괴 방지)");
  }

  // ── 🔴 코드·숨김은 안 올린다(git 이 수렴시킨다) ──
  {
    puts = []; SERVER = {};
    const dir = await mkProj("no-code", { project_id: PROJECT_ID, sync: "both", last_pull: Date.now() }, { "문서.md": "ok" });
    // git 레포 서브트리(클론형·워크트리형 둘 다)
    await fsp.mkdir(path.join(dir, "repoA", ".git"), { recursive: true });
    await fsp.writeFile(path.join(dir, "repoA", "code.ts"), "코드");
    await fsp.mkdir(path.join(dir, "repoB"), { recursive: true });
    await fsp.writeFile(path.join(dir, "repoB", ".git"), "gitdir: /x");
    await fsp.writeFile(path.join(dir, "repoB", "lib.js"), "코드");
    await fsp.writeFile(path.join(dir, ".env"), "SECRET=1");           // 숨김 — 시크릿
    await runHook(dir);
    const paths = puts.map((p) => p.path);
    assert.deepEqual(paths, ["문서.md"], `문서만 올려야 함 — 실제: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.includes("repoA") || p.includes("repoB")), "🔴 코드가 올라갔다");
    assert.ok(!paths.some((p) => p.startsWith(".")), "🔴 숨김/시크릿이 올라갔다");
    ok("🔴 git 레포 서브트리(.git 디렉터리·파일)·숨김(.env) 제외 — 문서만 올림");
  }

  // ── 로컬이 서버와 같으면 아무것도 안 올린다(무의미한 왕복 없음) ──
  {
    puts = [];
    const now = Date.now();
    SERVER = { "같음.md": { body: "동일", mtime: now } };
    const dir = await mkProj("nochange", { project_id: PROJECT_ID, sync: "both", last_pull: now }, { "같음.md": "동일" });
    await fsp.utimes(path.join(dir, "같음.md"), new Date(now - 10000), new Date(now - 10000)); // 로컬이 더 옛것
    await runHook(dir);
    assert.equal(puts.length, 0, "변경 없는데 올렸다");
    ok("로컬이 서버와 같거나 더 옛것 → 안 올림");
  }

  // ── 마커 없으면 no-op(비프로젝트 세션) ──
  {
    puts = [];
    const plain = path.join(root, "plain"); await fsp.mkdir(plain, { recursive: true });
    await fsp.writeFile(path.join(plain, "x.md"), "아무거나");
    await runHook(plain);
    assert.equal(puts.length, 0);
    ok("마커 없는 폴더 → no-op");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

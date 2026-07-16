#!/usr/bin/env node
// project-push up-sync 훅 (#905 C3) — 가짜 게이트웨이 + 진짜 훅 프로세스 e2e.
//  실행: node kit/hooks/project-push.test.mjs   (npm test 체인)
//
//  이 훅은 **팀 공유문서를 지우고 덮을 수 있다.** 그래서 여기 계약은 대부분 "무엇을 안 하는가"다:
//   🔴 sync="both" 아니면 아무것도 안 한다(기존 설치 전원 무영향 — 옵트인).
//   🔴 서버가 우리 기준선(last_pull) 이후 바뀐 파일은 **절대 안 올린다** — 올리면 남의 작업이 사라진다.
//   🔴 삭제는 **원장에 있는 것만** 전파한다 — '로컬에 없음'은 '지웠음'과 '애초에 안 받았음'을 구분 못 한다.
//   🔴 판정 근거(서버 매니페스트·로컬 walk)가 불완전하면 삭제도 신규 판정도 통째로 포기한다.
//   🔴 코드(git 서브트리)·숨김·서버 생성물(AGENTS.md)은 절대 안 올리고 안 지운다.
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

// ── 가짜 게이트웨이 — 서버 상태 + 받은 PUT/DELETE 기록 ──
let SERVER = {};          // path → { body, mtime }
let TRUNCATED = false;    // 서버 매니페스트가 상한(5000)에 잘렸는가
let SLOW_MS = 0;          // 모든 응답을 이만큼 지연 — 느린 게이트웨이(데드라인 계약 검증용)
let puts = [], deletes = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => setTimeout(() => {
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
      const files = Object.entries(SERVER).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ files, newest: Math.max(0, ...files.map((f) => f.mtime)), count: files.length, truncated: TRUNCATED }));
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file` && req.method === "PUT") {
      const p = u.searchParams.get("path");
      puts.push({ path: p, body: Buffer.concat(chunks).toString() });
      SERVER[p] = { body: Buffer.concat(chunks).toString(), mtime: Date.now() };
      res.writeHead(200, { "content-type": "application/json" });   // 진짜 라우트와 동형 — 결과 mtime/size 반환
      return res.end(JSON.stringify({ ok: true, mtime: SERVER[p].mtime, size: Buffer.byteLength(SERVER[p].body) }));
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file` && req.method === "DELETE") {
      const p = u.searchParams.get("path");
      deletes.push(p); delete SERVER[p];
      res.writeHead(200); return res.end("{}");
    }
    res.writeHead(404); res.end();
  }, SLOW_MS));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-push-"));
async function mkProj(name, marker, files = {}, ledger = null) {
  const dir = path.join(root, name);
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  if (ledger) await fsp.writeFile(path.join(dir, ".lively", "sync-ledger.json"), JSON.stringify({ v: 1, files: ledger }, null, 2) + "\n");
  for (const [p, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fsp.writeFile(path.join(dir, p), body);
  }
  return dir;
}
// hookTimeoutMs = run-custom 이 넘겨주는 '내가 SIGKILL 되는 시각'(LIVELY_HOOK_TIMEOUT_MS). 훅은 그 70% 에서 자력 종료한다.
async function runHook(dir, hookTimeoutMs = null) {
  const c = spawn(process.execPath, [HOOK], {
    cwd: dir,
    env: {
      ...process.env, LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: dir,
      ...(hookTimeoutMs ? { LIVELY_HOOK_TIMEOUT_MS: String(hookTimeoutMs) } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify({ cwd: dir }));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
const upOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "sync-up.json"), "utf8")); } catch { return null; } };
const ledgerOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "sync-ledger.json"), "utf8")).files; } catch { return null; } };
const reset = () => { puts = []; deletes = []; SERVER = {}; TRUNCATED = false; SLOW_MS = 0; };
// 원장 항목 = '우리가 받은 서버 버전의 신원'. 서버 상태에서 그대로 떠서 만든다.
const heldFrom = (paths) => Object.fromEntries(paths.map((p) => [p, { mtime: SERVER[p].mtime, size: Buffer.byteLength(SERVER[p].body) }]));

try {
  // ── 🔴 옵트인 — sync 가 both 가 아니면 **아무것도 안 한다**(기존 설치 전원 무영향) ──
  for (const mode of [{ sync: "none" }, { sync: "pull" }, {}]) {
    reset();
    const dir = await mkProj(`optin-${mode.sync || "unset"}`, { project_id: PROJECT_ID, ...mode }, { "doc.md": "로컬 변경" });
    await runHook(dir);
    assert.equal(puts.length, 0, `sync=${mode.sync || "(미명시)"} 인데 올렸다 — 옵트인 위반`);
    assert.equal(upOf(dir), null, "동작 안 했으면 기록도 남기지 않는다");
  }
  ok("🔴 sync 가 both 가 아니면(none·pull·미명시) 아무것도 안 올림 — 옵트인");

  // ── 새 문서 → 올린다 ──
  {
    reset();
    const dir = await mkProj("new-doc", { project_id: PROJECT_ID, sync: "both", last_pull: Date.now() }, { "새문서.md": "내용", "sub/깊은문서.md": "안쪽" });
    await runHook(dir);
    assert.deepEqual(puts.map((p) => p.path).sort(), ["sub/깊은문서.md", "새문서.md"]);
    assert.equal(puts.find((p) => p.path === "새문서.md").body, "내용");
    assert.equal(upOf(dir).pushed, 2);
    ok("서버에 없는 새 문서(하위 폴더 포함) → 올림");
  }

  // ── 🔴 서버가 기준선 이후 바뀌었으면 **안 올린다**(남의 작업 보호) ──
  {
    reset();
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
    reset();
    const lastPull = 1_000_000;
    SERVER = { "doc.md": { body: "옛 서버본", mtime: lastPull - 5000 } };
    const dir = await mkProj("safe-push", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, { "doc.md": "내 로컬 변경(더 김)" });
    await runHook(dir);
    assert.equal(puts.length, 1, "로컬만 바뀐 건 올려야 함");
    assert.equal(puts[0].body, "내 로컬 변경(더 김)");
    assert.equal(upOf(dir).conflicts.length, 0);
    ok("서버는 그대로 · 로컬만 변경 → 안전하게 올림");
  }

  // ── 🔴 원장에 없는 파일은 **안 지운다** — '로컬에 없음' ≠ '지웠음'(애초에 안 받았을 수 있다) ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "안받은문서.md": { body: "서버 문서", mtime: lastPull - 1000 } };
    const dir = await mkProj("no-ledger-no-delete", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {});
    await runHook(dir);   // 원장 없음
    assert.equal(deletes.length, 0, "🔴 받은 적 없는 파일을 지웠다 — 예산초과·실패로 못 받은 남의 문서가 이렇게 사라진다");
    assert.ok(SERVER["안받은문서.md"], "서버 문서 보존");
    ok("🔴 원장에 없는(=받은 적 없는) 서버 문서는 로컬에 없어도 안 지움");
  }

  // ── ✅ 원장에 있고(받았었다) 서버가 그때 그대로 → **지운다**(C3 삭제 전파의 본체) ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "지운문서.md": { body: "받았던 문서", mtime: lastPull - 1000 }, "남길문서.md": { body: "그대로", mtime: lastPull - 1000 } };
    const dir = await mkProj(
      "delete-propagates", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull },
      { "남길문서.md": "그대로" },                       // 지운문서.md 만 로컬에서 사라짐
      heldFrom(["지운문서.md", "남길문서.md"]),
    );
    await runHook(dir);
    assert.deepEqual(deletes, ["지운문서.md"], "받아뒀다가 로컬에서 지운 문서는 서버에서도 지워야 함");
    assert.equal(SERVER["지운문서.md"], undefined);
    assert.ok(SERVER["남길문서.md"], "로컬에 있는 문서를 지우면 안 된다");
    assert.equal(upOf(dir).deleted, 1);
    assert.deepEqual(Object.keys(ledgerOf(dir)), ["남길문서.md"], "지운 항목은 원장에서도 빠져야 함");
    ok("✅ 원장에 있고 서버가 기준선 그대로 → 삭제 전파 + 원장 정리");
  }

  // ── 🔴 원장에 있어도 서버가 그 뒤 바뀌었으면 **안 지운다**(남이 고친 걸 지우게 된다) ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "doc.md": { body: "원래본", mtime: lastPull - 5000 } };
    const held = heldFrom(["doc.md"]);
    SERVER["doc.md"] = { body: "남이 고친 새 본문", mtime: lastPull + 5000 };  // 우리가 받은 뒤 남이 고침
    const dir = await mkProj("delete-conflict", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {}, held);
    await runHook(dir);
    assert.equal(deletes.length, 0, "🔴 우리가 받은 뒤 남이 고친 문서를 지웠다");
    assert.equal(SERVER["doc.md"].body, "남이 고친 새 본문");
    assert.equal(upOf(dir).conflicts.length, 1);
    assert.match(upOf(dir).conflicts[0].why, /지우지 않음/);
    ok("🔴 원장에 있어도 서버본이 기준선 이후 바뀌었으면 → 안 지우고 충돌로 기록");
  }

  // ── 🔴 서버에서 지운 문서를 **되살리지 않는다**(원장이 '받았었다'를 증언 → 신규 아님) ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "삭제된문서.md": { body: "받았던 문서", mtime: lastPull - 1000 } };
    const held = heldFrom(["삭제된문서.md"]);
    delete SERVER["삭제된문서.md"];                       // 남이 중앙에서 지움
    const dir = await mkProj("no-resurrect", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull },
      { "삭제된문서.md": "받았던 문서" }, held);           // 로컬엔 아직 남아 있다(pull 은 삭제를 안 내린다)
    await runHook(dir);
    assert.equal(puts.length, 0, "🔴 남이 중앙에서 지운 문서를 되살려 올렸다");
    assert.equal(SERVER["삭제된문서.md"], undefined, "서버에 되살아나면 안 된다");
    assert.equal(upOf(dir).conflicts.length, 1);
    assert.match(upOf(dir).conflicts[0].why, /서버에서 사라짐/);
    ok("🔴 중앙에서 삭제된 문서를 로컬본으로 되살리지 않음(원장이 '신규'와 구분)");
  }

  // ── 🔴 서버 매니페스트가 잘렸으면(truncated) 삭제·신규 판정을 **통째로 포기**한다 ──
  //  안 보이는 서버 파일을 '없음'으로 읽으면 → 신규로 오인해 **덮고**, 원장 항목을 지운다.
  {
    reset();
    TRUNCATED = true;
    const lastPull = Date.now();
    SERVER = { "보이는문서.md": { body: "옛 서버본", mtime: lastPull - 5000 } };
    const dir = await mkProj("truncated", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull },
      { "안보이는문서.md": "상한에 잘려 매니페스트에 없는 서버 문서의 로컬본", "보이는문서.md": "내 로컬 변경(더 김)" },
      { "지운문서.md": { mtime: lastPull - 9000, size: 3 } });
    await runHook(dir);
    assert.deepEqual(puts.map((p) => p.path), ["보이는문서.md"],
      "🔴 매니페스트에 안 보이는 파일을 '새 문서'로 오인해 올렸다 — 서버 최신본을 옛 로컬본으로 덮는다");
    assert.equal(deletes.length, 0, "🔴 서버 전체를 못 봤는데 삭제 전파를 했다");
    ok("🔴 매니페스트 truncated → 신규 판정·삭제 전파 중단(수정분 올리기는 유지)");
  }

  // ── 🔴 로컬 walk 가 상한에 잘리면 삭제 전파를 안 한다 — 실재하는 파일이 '없음'으로 보이기 때문 ──
  //  walk 상한을 업로드 상한(200)과 묶었다면 문서 201번째부터 전부 '지워진 것'이 된다.
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "원장문서.md": { body: "받았던 문서", mtime: lastPull - 1000 } };
    const held = heldFrom(["원장문서.md"]);
    const dir = await mkProj("walk-cap", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {}, held);
    // 로컬 walk 상한(MAX_WALK=5000) 을 넘겨 truncated 를 만든다 — 서버엔 없는 파일들이라 업로드 후보이기도 하다.
    const bulk = path.join(dir, "bulk");
    await fsp.mkdir(bulk, { recursive: true });
    await Promise.all(Array.from({ length: 5001 }, (_, i) => fsp.writeFile(path.join(bulk, `f${i}.md`), "x")));
    await runHook(dir);
    assert.equal(deletes.length, 0, "🔴 로컬 walk 가 잘렸는데 삭제 전파를 했다 — 실재 파일이 '없음'으로 보인 것뿐이다");
    assert.ok(SERVER["원장문서.md"], "서버 문서 보존");
    ok("🔴 로컬 walk 상한 도달(파일 5001개) → 삭제 전파 중단(거짓 부재 방지)");
  }

  // ── 🔴 git 서브트리 밑의 원장 경로는 '없음'이 아니라 '안 봄' → 안 지운다 ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "repoA/문서.md": { body: "옛날에 문서였던 경로", mtime: lastPull - 1000 } };
    const held = heldFrom(["repoA/문서.md"]);
    const dir = await mkProj("git-subtree-ledger", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {}, held);
    await fsp.mkdir(path.join(dir, "repoA", ".git"), { recursive: true });   // 그 자리에 이제 레포가 있다
    await runHook(dir);
    assert.equal(deletes.length, 0, "🔴 git 서브트리라 안 들여다본 경로를 '지워졌다'고 판정했다");
    ok("🔴 git 서브트리 밑 원장 경로 → 안 지움(제외한 것이지 없는 게 아니다)");
  }

  // ── 🔴 서버 생성물(AGENTS.md)은 올리지도 지우지도 않는다 ──
  //  지우면 그 안의 '규칙'(사람이 쓴 유일본)이 사라지고, 올리면 digest 재생성과 매 턴 싸운다.
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "AGENTS.md": { body: "서버가 만든 digest", mtime: lastPull - 1000 } };
    const held = heldFrom(["AGENTS.md"]);
    const dir1 = await mkProj("agents-nodelete", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, {}, held);
    await runHook(dir1);
    assert.equal(deletes.length, 0, "🔴 AGENTS.md 를 서버에서 지웠다 — 프로젝트 규칙이 사라진다");
    const dir2 = await mkProj("agents-nopush", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull }, { "AGENTS.md": "내가 고친 digest(길이 다름)" }, held);
    await runHook(dir2);
    assert.equal(puts.length, 0, "AGENTS.md 는 서버 생성물 — 올리면 digest 재생성과 매 턴 거짓 충돌이 난다");
    ok("🔴 AGENTS.md(서버 생성물) → 올리지도 지우지도 않음");
  }

  // ── 서버에도 없는 원장 항목은 삭제 호출 없이 원장에서만 정리한다 ──
  {
    reset();
    const lastPull = Date.now();
    SERVER = { "남은문서.md": { body: "그대로", mtime: lastPull - 1000 } };
    const dir = await mkProj("ledger-gc", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull },
      { "남은문서.md": "그대로" },
      { ...heldFrom(["남은문서.md"]), "이미없음.md": { mtime: lastPull - 9000, size: 3 } });
    await runHook(dir);
    assert.equal(deletes.length, 0, "서버에 이미 없는 걸 지우려 하면 안 된다");
    assert.deepEqual(Object.keys(ledgerOf(dir)), ["남은문서.md"], "서버에도 없는 원장 항목은 정리돼야 함");
    ok("서버에도 이미 없는 원장 항목 → 삭제 호출 없이 원장만 정리");
  }

  // ── 🔴 코드·숨김은 안 올린다(git 이 수렴시킨다) ──
  {
    reset();
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
    reset();
    const now = Date.now();
    SERVER = { "같음.md": { body: "동일", mtime: now } };
    const dir = await mkProj("nochange", { project_id: PROJECT_ID, sync: "both", last_pull: now }, { "같음.md": "동일" });
    await fsp.utimes(path.join(dir, "같음.md"), new Date(now - 10000), new Date(now - 10000)); // 로컬이 더 옛것
    await runHook(dir);
    assert.equal(puts.length, 0, "변경 없는데 올렸다");
    ok("로컬이 서버와 같거나 더 옛것 → 안 올림");
  }

  // ── 🔴 느린 게이트웨이여도 **자기가 SIGKILL 되는 시각 전에** 스스로 끝내고 기록을 남긴다 ──
  //  run-custom 은 execFileSync(timeout, SIGKILL) 로 훅을 돌린다. SIGKILL 되면 정리 코드가 아예 안 돌아
  //  sync-up.json 을 못 쓴다 = 충돌이 있어도 사용자가 볼 표면이 사라진다. 상한은 run-custom 이 env 로 알려준다.
  {
    reset();
    const KILL_AT = 3000;   // run-custom 이 3초에 죽인다고 알려준 상황(관리탭에서 timeout_sec 을 줄인 경우 등)
    SLOW_MS = 1500;         // 매 응답 1.5초 — 매니페스트 1회만으로 이미 예산의 절반
    const lastPull = Date.now();
    SERVER = { "a.md": { body: "옛본", mtime: lastPull - 9000 }, "b.md": { body: "옛본", mtime: lastPull - 9000 } };
    const dir = await mkProj("deadline", { project_id: PROJECT_ID, sync: "both", last_pull: lastPull },
      { "a.md": "내 변경(더 긴 본문)", "b.md": "내 변경(더 긴 본문)", "c.md": "새 문서", "d.md": "새 문서2", "e.md": "새 문서3" });
    const t0 = Date.now();
    await runHook(dir, KILL_AT);
    const took = Date.now() - t0;
    assert.ok(took < KILL_AT, `🔴 SIGKILL 시각(${KILL_AT}ms) 안에 못 끝냄(${took}ms) — 죽으면 충돌 기록이 통째로 사라진다`);
    const up = upOf(dir);
    assert.ok(up, "데드라인에 걸려도 기록(sync-up.json)은 남겨야 한다 — 그게 유일한 표면이다");
    // 조용히 잘리면 안 된다 — 못 올린 게 있으면 개수를 남겨야 "다 올라갔다"로 오독되지 않는다.
    assert.ok(up.remaining > 0, `데드라인에 5개 중 일부만 올렸는데 remaining=${up.remaining} — 잘린 사실이 안 보인다`);
    assert.ok(up.pushed + up.remaining + up.failed >= 5, "올린 것 + 남은 것 + 실패가 후보 수와 맞아야 한다");
    ok(`🔴 느린 게이트웨이 + 짧은 timeout_sec → SIGKILL 전 자력 종료(${took}ms < ${KILL_AT}ms) + 기록 보존`);
  }

  // ── 마커 없으면 no-op(비프로젝트 세션) ──
  {
    reset();
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

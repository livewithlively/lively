#!/usr/bin/env node
// project-push ⑥ — 같은 노드의 다른 프로젝트 폴더(형제 슬롯)를 Stop 에 올리는가 (가짜 게이트웨이 + 진짜 훅 프로세스 e2e).
//  실행: node kit/hooks/project-push-sibling.test.mjs   (npm test 체인)
//
//  배경(실측 2026-11-09): #3625 세션이 #5020 폴더에 문서를 쓰고 그 경로를 링크로 줬는데 «대상을 찾을 수 없어요» 였다.
//   훅이 «이 세션이 속한 프로젝트» 폴더 하나만 올렸기 때문이다. ⑥ 은 Stop 에 한 번, 이 세션 폴더와 **같은 부모** 아래의
//   형제 슬롯(마커 { project_id: 폴더 이름, sync: "both" })에서 **올리기만** 한다.
//  아래 E1~E25 는 사양 엣지 표의 행 번호다(행마다 시나리오 하나 이상).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const HOOK = path.join(fileURLToPath(import.meta.url), "..", "examples", "project-push.org-hook.mjs");
const OWN = 101, SIB = 202;
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 프로젝트별 서버 상태 + 받은 요청 기록 ──
let SERVER = {};            // projectId → { path → { body, mtime } }
let TRUNC = new Set();      // 매니페스트가 잘렸다고 답할 프로젝트
let FAIL_PUT = new Map();   // PUT 을 이 상태로 거절할 프로젝트(500 = 일시 오류 · 403 = 쓰기 권한 없음)
let FAIL_PATH = new Set();  // 이 «프로젝트:경로» 의 PUT 만 500 으로 거절(일부만 실패)
let MANIFEST_STATUS = new Map();   // 매니페스트를 이 상태로 거절할 프로젝트(404 = 지운 프로젝트 · 500 = 일시 오류)
let DELAY = new Map();      // 매니페스트 응답을 이만큼 늦출 프로젝트(동시 실행 시험)
let NO_MTIME = false;       // PUT 응답에 mtime 을 안 싣는 옛 게이트웨이
let SESSION_CTX = null;     // project-context 응답(세션 판) — null 이면 404
let reqs = [];              // { pid, method, kind, path }
let epoch = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  const at = epoch;
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => setTimeout(() => {
    if (at !== epoch) { res.writeHead(503); return res.end("{}"); }   // 앞 케이스가 남긴 늦은 요청
    if (/^\/api\/ui\/execution-sessions\/[^/]+\/project-context$/.test(u.pathname)) {
      if (!SESSION_CTX) { res.writeHead(404); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(SESSION_CTX));
    }
    const m = u.pathname.match(/^\/api\/ui\/v6\/projects\/(\d+)\/(shared\/manifest|file)$/);
    if (!m) { reqs.push({ pid: -1, method: req.method, kind: u.pathname, path: null }); res.writeHead(404); return res.end(); }   // 모르는 주소도 남긴다(번호 아닌 폴더가 새면 여기 찍힌다)
    const pid = Number(m[1]);
    const files = SERVER[pid] || (SERVER[pid] = {});
    reqs.push({ pid, method: req.method, kind: m[2], path: u.searchParams.get("path") });
    if (m[2] === "shared/manifest") {
      if (MANIFEST_STATUS.has(pid)) { res.writeHead(MANIFEST_STATUS.get(pid)); return res.end("{}"); }
      const list = Object.entries(files).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ files: list, newest: Math.max(0, ...list.map((f) => f.mtime)), count: list.length, truncated: TRUNC.has(pid) }));
    }
    const p = u.searchParams.get("path");
    if (req.method === "PUT") {
      if (FAIL_PUT.has(pid)) { res.writeHead(FAIL_PUT.get(pid)); return res.end("{}"); }
      if (FAIL_PATH.has(`${pid}:${p}`)) { res.writeHead(500); return res.end("{}"); }
      files[p] = { body: Buffer.concat(chunks).toString(), mtime: Date.now() };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(NO_MTIME ? { ok: true } : { ok: true, mtime: files[p].mtime, size: Buffer.byteLength(files[p].body) }));
    }
    if (req.method === "DELETE") { delete files[p]; res.writeHead(200); return res.end("{}"); }
    res.writeHead(404); res.end();
  }, (() => { const mm = u.pathname.match(/^\/api\/ui\/v6\/projects\/(\d+)\/shared\/manifest$/); return mm ? (DELAY.get(Number(mm[1])) || 0) : 0; })()));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-push-sib-"));
let caseNo = 0;
// 케이스마다 새 루트 <c>: 공유 루트 <c>/workspace/project/<번호> · 홈 · tmp(형제 상태)도 케이스마다 따로 둔다.
async function freshCase() {
  epoch++; reqs = []; SERVER = {}; TRUNC = new Set(); FAIL_PUT = new Map(); SESSION_CTX = null;
  FAIL_PATH = new Set(); MANIFEST_STATUS = new Map(); DELAY = new Map(); NO_MTIME = false;
  const c = path.join(root, `c${++caseNo}`);
  for (const d of [path.join(c, "workspace", "project"), path.join(c, "home"), path.join(c, "tmp")]) await fsp.mkdir(d, { recursive: true });
  return c;
}
// files: { 경로: 본문 } · ledger/tombs: { 경로: { mtime, size } } — 기준선이 있는 파일은 로컬 시각을 그 기준선으로 맞춘다.
async function mkDir(dir, marker, files = {}, ledger = null, tombs = null) {
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  if (marker) await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  const led = ledger ? JSON.parse(JSON.stringify(ledger)) : null;
  const tmb = tombs ? JSON.parse(JSON.stringify(tombs)) : null;
  for (const [p, body] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body);
    const b = (led && led[p]) || (tmb && tmb[p]);
    if (b && typeof b.mtime === "number") {
      const t = new Date(b.mtime);
      await fsp.utimes(abs, t, t);
      b.mtime = Math.floor((await fsp.stat(abs)).mtimeMs);   // 파일시스템 정밀도로 되읽은 값을 기준선으로(project-push.test.mjs 와 같은 까닭)
    }
  }
  if (led || tmb) await fsp.writeFile(path.join(dir, ".lively", "sync-ledger.json"), JSON.stringify({ v: 2, files: led || {}, tombs: tmb || {} }, null, 2) + "\n");
  return dir;
}
const slot = (c, id) => path.join(c, "workspace", "project", String(id));
async function runHook(c, cwd, event, extraEnv = {}) {
  const ch = spawn(process.execPath, [HOOK], {
    cwd,
    env: {
      ...process.env, ...sandboxEnv({ home: path.join(c, "home"), tmp: path.join(c, "tmp") }),
      LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: path.join(c, "home"), TERMINAL_ROOT_SHARED: path.join(c, "workspace"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  ch.stdin.end(JSON.stringify({ cwd, ...(event ? { hook_event_name: event } : {}) }));
  const code = await new Promise((r) => ch.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
const of = (pid, method = null) => reqs.filter((r) => r.pid === pid && (!method || r.method === method));
const putsOf = (pid) => of(pid, "PUT").map((r) => r.path).sort();
const upOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "sync-up.json"), "utf8")); } catch { return null; } };
const ledOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "sync-ledger.json"), "utf8")).files; } catch { return null; } };
const both = (id, extra = {}) => ({ project_id: id, sync: "both", ...extra });
// 노드 공용 형제 상태(tmp) — 시각을 옮겨 «시간이 지난 뒤» 를 흉내 낼 때만 쓴다(형제 하나인 케이스에서).
const sibFiles = (c, re) => { const d = path.join(c, "tmp", "lively-hooks"); try { return fs.readdirSync(d).filter((f) => re.test(f)).map((f) => path.join(d, f)); } catch { return []; } };
const editJson = (f, patch) => fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...patch }));
async function newDoc(dir, rel, body, ageMs) {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body);
  if (ageMs != null) { const t = new Date(Date.now() - ageMs); await fsp.utimes(abs, t, t); }
}

try {
  // ── E1 Stop — 형제의 새 문서를 그 프로젝트로 올리고 기준선을 맞춘다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN, { last_pull: Date.now() }));
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "콜드메일.md": "새 문서", "deck/소개서.html": "<html>" });
    await runHook(c, own, "Stop");
    assert.ok(of(SIB, "GET").length >= 1, "배선: 가짜 게이트웨이가 형제 매니페스트 요청을 받아야 한다");
    assert.deepEqual(putsOf(SIB), ["deck/소개서.html", "콜드메일.md"], "형제의 새 문서가 그 프로젝트로 안 올라갔다");
    assert.equal(SERVER[SIB]["콜드메일.md"].body, "새 문서");
    assert.equal(of(OWN, "PUT").length, 0, "이 세션 폴더에는 올릴 것이 없었다");
    const led = ledOf(sib);
    for (const p of ["콜드메일.md", "deck/소개서.html"]) {
      assert.equal(led[p].mtime, SERVER[SIB][p].mtime, `${p} 원장 기준선 = 서버 결과값`);
      assert.equal(Math.floor(fs.statSync(path.join(sib, p)).mtimeMs), SERVER[SIB][p].mtime, `${p} 로컬 시각 = 서버 결과값`);
    }
    const up = upOf(sib);
    assert.equal(up.pushed, 2);
    assert.equal(up.upload_only, true, "형제 보고는 «삭제 판정 안 함» 을 밝힌다");
    ok("E1 Stop — 형제 슬롯의 새 문서를 그 프로젝트로 올리고 원장 · 로컬 시각을 서버 결과값으로 맞춤");
  }

  // ── E2~E4 Stop 이 아닌 이벤트에서는 형제를 안 본다 ──
  for (const ev of ["PostToolUse", "UserPromptSubmit", null]) {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB), { "새.md": "x" });
    await runHook(c, own, ev);
    assert.equal(of(SIB).length, 0, `${ev ?? "(이벤트 없음)"} 에서 형제에 요청했다`);
  }
  ok("E2~E4 PostToolUse · UserPromptSubmit · 이벤트 이름 없음 → 형제 요청 0");

  // ── E5~E11 모르는 폴더는 안 건드린다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, 203), { project_id: 203, sync: "pull" }, { "a.md": "x" });           // E5 pull
    await mkDir(slot(c, 204), null, { "a.md": "x" });                                         // E6 마커 없음
    await mkDir(slot(c, 205), { project_id: 205 }, { "a.md": "x" });                          // E7 sync 미명시
    await mkDir(slot(c, 206), both(999), { "a.md": "x" });                                    // E8 번호가 다른 마커
    await mkDir(slot(c, 207), { kind: "session", project_id: 207, sync: "both", project_dir: own }, { "a.md": "x" });   // E9 세션 마커(번호 · both 가 있어도)
    await mkDir(path.join(c, "workspace", "project", "abc"), { project_id: "abc", sync: "both" }, { "a.md": "x" });   // E10 숫자 아닌 이름(마커도 그 이름)
    const outside = await mkDir(path.join(c, "outside-209"), both(209), { "a.md": "x" });     // E11 링크 너머 폴더
    let linked = true;
    try { fs.symlinkSync(outside, slot(c, 209), "dir"); } catch { linked = false; }
    await runHook(c, own, "Stop");
    const touched = [...new Set(reqs.map((r) => r.pid))].filter((p) => p !== OWN);
    assert.deepEqual(touched, [], `모르는 폴더에 요청했다: ${touched.join(",")}`);
    ok(`E5~E11 pull · 마커 없음 · sync 미명시 · 번호 다른 마커 · 세션 마커 · 숫자 아닌 이름${linked ? " · 심볼릭 링크" : "(링크 생성 불가 환경 — E11 생략)"} → 요청 0`);
  }

  // ── E12 형제에서는 삭제를 전파하지 않는다(이 세션 폴더는 종전대로 전파) ──
  {
    const c = await freshCase();
    SERVER[OWN] = { "지운문서.md": { body: "own", mtime: 1_000_000 } };
    SERVER[SIB] = { "지운문서.md": { body: "sib", mtime: 1_000_000 } };
    const own = await mkDir(slot(c, OWN), both(OWN, { last_pull: 2_000_000 }), {}, { "지운문서.md": { mtime: 1_000_000, size: 3 } });
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: 2_000_000 }), { "새.md": "새 문서" }, { "지운문서.md": { mtime: 1_000_000, size: 3 } });
    await runHook(c, own, "Stop");
    assert.deepEqual(of(OWN, "DELETE").map((r) => r.path), ["지운문서.md"], "이 세션 폴더의 삭제 전파는 그대로여야 한다");
    assert.equal(of(SIB, "DELETE").length, 0, "형제 폴더의 로컬 삭제를 서버로 전파했다");
    assert.equal(SERVER[SIB]["지운문서.md"].body, "sib", "형제 서버본이 남아 있어야 한다");
    assert.deepEqual(putsOf(SIB), ["새.md"], "삭제는 안 해도 새 문서는 올린다");
    assert.ok(ledOf(sib)["지운문서.md"], "형제 원장의 그 기준선은 그대로 둔다(그 프로젝트 세션이 판정한다)");
    ok("E12 형제 폴더의 로컬 삭제는 전파 안 함 · 이 세션 폴더의 삭제 전파는 종전대로");
  }

  // ── E13 형제에서도 남의 변경은 안 덮는다 ──
  {
    const c = await freshCase();
    SERVER[SIB] = { "공유문서.md": { body: "남이 고친 서버본", mtime: 3_000_000 } };   // 기준선(1_000_000) · last_pull(2_000_000) 뒤에 바뀜
    const own = await mkDir(slot(c, OWN), both(OWN));
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: 2_000_000 }), { "공유문서.md": "옛 판" }, { "공유문서.md": { mtime: 1_000_000, size: 7 } });
    await fsp.writeFile(path.join(sib, "공유문서.md"), "내가 고친 판(더 김)");
    await runHook(c, own, "Stop");
    assert.equal(of(SIB, "GET").length, 1, "배선: 형제 매니페스트는 물었어야 한다");
    assert.equal(of(SIB, "PUT").length, 0, "서버가 기준선 이후 바뀐 파일을 형제 경로로 덮었다");
    assert.equal(SERVER[SIB]["공유문서.md"].body, "남이 고친 서버본");
    const up = upOf(sib);
    assert.deepEqual(up.conflicts.map((x) => x.path), ["공유문서.md"]);
    assert.equal(up.upload_only, true);
    ok("E13 형제에서도 서버가 기준선 이후 바뀐 파일 → 안 올리고 충돌로 기록");
  }

  // ── E14 잘린 매니페스트 → 새 문서를 안 올린다 ──
  {
    const c = await freshCase();
    TRUNC.add(SIB);
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    await runHook(c, own, "Stop");
    assert.equal(of(SIB, "GET").length, 1, "배선: 형제 매니페스트는 물었어야 한다");
    assert.equal(of(SIB, "PUT").length, 0, "잘린 매니페스트로 «서버에 없음» 을 단정해 올렸다");
    ok("E14 형제 매니페스트가 잘렸으면 새 문서를 안 올림");
  }

  // ── E15 원장 그대로 · E16 묘비 그대로인 형제 → 요청 0 ──
  {
    const c = await freshCase();
    SERVER[SIB] = { "a.md": { body: "aaa", mtime: 1_000_000 } };
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: 2_000_000 }), { "a.md": "aaa" }, { "a.md": { mtime: 1_000_000, size: 3 } });
    await mkDir(slot(c, 203), both(203, { last_pull: 2_000_000 }), { "묘비.md": "bbb" }, null, { "묘비.md": { mtime: 1_500_000, size: 3, at: "2026-11-01T00:00:00Z" } });
    await runHook(c, own, "Stop");
    assert.equal(of(SIB).length, 0, "원장과 같은 형제에 매니페스트를 물었다");
    assert.equal(of(203).length, 0, "묘비와 같은(중앙이 지운) 형제 파일 때문에 요청했다");
    ok("E15 · E16 원장 기준선 · 묘비와 같은 형제 → 요청 0");
  }

  // ── E17 지난번에 끝까지 처리한(충돌만 남은) 형제는 그대로인 동안 다시 안 묻는다 ──
  {
    const c = await freshCase();
    SERVER[SIB] = { "공유문서.md": { body: "남이 고친 서버본", mtime: 3_000_000 } };
    const own = await mkDir(slot(c, OWN), both(OWN));
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: 2_000_000 }), { "공유문서.md": "옛 판" }, { "공유문서.md": { mtime: 1_000_000, size: 7 } });
    await fsp.writeFile(path.join(sib, "공유문서.md"), "내가 고친 판(더 김)");
    await runHook(c, own, "Stop");
    assert.equal(of(SIB, "GET").length, 1, "첫 Stop 은 매니페스트를 한 번 묻는다");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(of(SIB).length, 0, "같은 충돌만 남았는데 다음 Stop 에 또 물었다");
    await fsp.writeFile(path.join(sib, "새로쓴.md"), "새 문서");             // 그 폴더에 새로 쓰면 다시 본다
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(SIB), ["새로쓴.md"], "충돌이 남은 폴더에 새로 쓴 문서가 안 올라갔다");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(of(SIB).length, 0, "올린 뒤 남은 것이 지난번 충돌뿐인데 또 물었다");
    ok("E17 충돌만 남은 형제 → 다음 Stop 요청 0 · 새로 쓰면 다시 보고 올림 · 그 뒤 다시 요청 0");
  }

  // ── E18 올리기에 실패한 형제는 다음 Stop 이 바로 다시 본다 ──
  {
    const c = await freshCase();
    FAIL_PUT.set(SIB, 500);
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    await runHook(c, own, "Stop");
    assert.equal(of(SIB, "PUT").length, 1, "배선: 첫 시도는 PUT 을 보냈어야 한다");
    assert.equal(SERVER[SIB]["새.md"], undefined);
    FAIL_PUT.delete(SIB); reqs = [];
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(SIB), ["새.md"], "실패한 형제를 다음 Stop 에 다시 시도하지 않았다");
    assert.equal(SERVER[SIB]["새.md"].body, "새 문서");
    ok("E18 형제 PUT 실패 → 다음 Stop 이 바로 다시 시도해 올림");
  }

  // ── E19 이 세션 폴더가 슬롯 꼴이 아니면 형제를 안 본다 ──
  {
    const c = await freshCase();
    const shapes = [
      { own: path.join(c, "code", "myapp"), sib: path.join(c, "code", "202") },                        // 사람이 init 한 자기 폴더
      { own: path.join(c, "lively", "projects", "101"), sib: path.join(c, "lively", "projects", "202") },  // 구 work.mjs 자리
      { own: path.join(c, "workspace", "project", "101-copy"), sib: slot(c, SIB) },                       // 이름이 번호가 아님
    ];
    for (const s of shapes) {
      await mkDir(s.own, both(OWN));
      await mkDir(s.sib, both(SIB), { "새.md": "x" });
      reqs = [];
      await runHook(c, s.own, "Stop");
      assert.equal(of(SIB).length, 0, `슬롯 꼴이 아닌 세션 폴더(${path.relative(c, s.own)})에서 형제를 올렸다`);
    }
    ok("E19 세션 폴더가 <…>/project/<번호> 꼴이 아님(자기 폴더 · 구 work.mjs 자리 · 번호 아닌 이름) → 형제 요청 0");
  }

  // ── E20 소속이 없으면 형제를 안 본다 ──
  {
    const c = await freshCase();
    await mkDir(slot(c, SIB), both(SIB), { "새.md": "x" });
    const loose = path.join(c, "loose"); await fsp.mkdir(loose, { recursive: true });
    await runHook(c, loose, "Stop");
    assert.equal(of(SIB).length, 0, "소속 없는 세션이 형제를 올렸다");
    ok("E20 소속 없음(마커 없는 cwd · 세션 없음) → 형제 요청 0");
  }

  // ── E21 서버가 세션 폴더를 지목하는 실제 경로(project-context · session_dir) ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN, { last_pull: Date.now() }));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    SESSION_CTX = { found: true, project_id: OWN, sync: "both", folder: `project/${OWN}`, folder_abs_path: null, session_dir: own, revision: 1, applied_revision: 1, binding_epoch: 1 };
    await runHook(c, path.join(c, "home"), "Stop", { LIVELY_SESSION_ID: "box-test-sib" });   // cwd 와 무관하게 서버가 지목한 폴더가 기준점
    assert.deepEqual(putsOf(SIB), ["새.md"]);
    ok("E21 서버가 지목한 세션 폴더(session_dir)를 기준점으로 형제의 새 문서를 올림");
  }

  // ── E22 이 세션 폴더가 pull 이어도(이 세션 폴더는 안 올림) 형제는 올린다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), { project_id: OWN, sync: "pull" }, { "내문서.md": "pull 폴더의 로컬 문서" });
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    await runHook(c, own, "Stop");
    assert.equal(of(OWN, "PUT").length, 0, "pull 인 이 세션 폴더를 올렸다");
    assert.deepEqual(putsOf(SIB), ["새.md"]);
    ok("E22 이 세션 폴더가 pull → 그 폴더는 안 올리고 형제(both)는 올림");
  }

  // ── E23 · E24 형제 마커에 last_pull 이 없을 때 ──
  {
    const c = await freshCase();
    SERVER[SIB] = { "있던문서.md": { body: "서버본", mtime: 5_000_000 } };
    const own = await mkDir(slot(c, OWN), both(OWN));
    const sib = await mkDir(slot(c, SIB), both(SIB), { "새.md": "새 문서", "있던문서.md": "로컬에서 다르게 고친 판" });
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(SIB), ["새.md"], "last_pull 이 없을 때: 새 문서만 올리고, 원장 없는 기존 문서는 안 덮어야 한다");
    assert.equal(SERVER[SIB]["있던문서.md"].body, "서버본");
    assert.deepEqual(upOf(sib).conflicts.map((x) => x.path), ["있던문서.md"]);
    ok("E23 · E24 형제 마커에 last_pull 없음 → 새 문서는 올리고, 원장 없는 기존 문서 수정은 충돌로 남김");
  }

  // ── E25 경계: 원장과 다른 형제 9곳 → 첫 Stop 에 최근 8곳, 다음 Stop 에 나머지 1곳 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    const t0 = Date.now() - 600_000;
    for (let i = 1; i <= 9; i++) {
      const dir = await mkDir(slot(c, 300 + i), both(300 + i, { last_pull: Date.now() }), { "새.md": `문서 ${i}` });
      const t = new Date(t0 + i * 10_000);                                    // 301 이 가장 오래됐다
      await fsp.utimes(path.join(dir, "새.md"), t, t);
    }
    await runHook(c, own, "Stop");
    const firstPids = reqs.filter((r) => r.method === "PUT").map((r) => r.pid).sort();
    assert.deepEqual(firstPids, [302, 303, 304, 305, 306, 307, 308, 309], `첫 Stop 은 최근 8곳만(받은 것: ${firstPids.join(",")})`);
    reqs = [];
    await runHook(c, own, "Stop");
    assert.deepEqual(reqs.filter((r) => r.method === "PUT").map((r) => r.pid), [301], "남은 1곳은 다음 Stop 에 올라가야 한다");
    ok("E25 원장과 다른 형제 9곳 → 첫 Stop 에 최근 8곳 · 다음 Stop 에 가장 오래된 1곳");
  }

  // ── R1 (리뷰 차단 건) 서버가 거절하는 형제 8곳이 자리를 차지해도, 9번째 형제는 늦어도 두 번째 Stop 에 올라간다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    for (let i = 1; i <= 8; i++) {                                            // 401~408: 지운 프로젝트(매니페스트 404) · 더 최근에 씀
      const d = await mkDir(slot(c, 400 + i), both(400 + i));
      await newDoc(d, "남은.md", `x${i}`, 10_000 - i * 100);
      MANIFEST_STATUS.set(400 + i, 404);
    }
    const good = await mkDir(slot(c, 409), both(409, { last_pull: Date.now() }));
    await newDoc(good, "올릴것.md", "올라가야 할 문서", 600_000);            // 가장 오래됐다 → 첫 Stop 에선 8자리 밖
    await runHook(c, own, "Stop");
    assert.equal(reqs.filter((r) => r.pid >= 401 && r.pid <= 408).length, 8, "배선: 거절하는 8곳을 한 번씩 물었어야 한다");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(reqs.filter((r) => r.pid >= 401 && r.pid <= 408).length, 0, "거절한 프로젝트를 쉬지 않고 또 물었다");
    assert.deepEqual(putsOf(409), ["올릴것.md"], "거절하는 형제들에 막혀 정작 올릴 형제에 못 닿았다");
    ok("R1 거절(404) 형제 8곳 → 쉬게 하고, 9번째 형제는 두 번째 Stop 에 올림");
  }

  // ── R2 일시 오류(500) — 그 Stop 은 멈추고, 그 형제는 다음 Stop 에 맨 뒤로 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    const a = await mkDir(slot(c, 501), both(501, { last_pull: Date.now() }));
    const b = await mkDir(slot(c, 502), both(502, { last_pull: Date.now() }));
    await newDoc(a, "a.md", "a", 1_000);                                      // a 가 더 최근
    await newDoc(b, "b.md", "b", 60_000);
    MANIFEST_STATUS.set(501, 500);
    await runHook(c, own, "Stop");
    assert.equal(of(501, "GET").length, 1, "배선: 먼저 a 를 물었어야 한다");
    assert.equal(of(502).length, 0, "일시 오류 뒤에도 같은 Stop 에서 계속 물었다");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(502), ["b.md"], "오류 난 형제를 뒤로 미루지 않아 b 가 안 올라갔다");
    assert.ok(reqs.findIndex((r) => r.pid === 502) < reqs.findIndex((r) => r.pid === 501), "오류 난 형제가 맨 뒤로 가야 한다");
    MANIFEST_STATUS.delete(501); reqs = [];
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(501), ["a.md"], "오류가 풀린 뒤 a 를 다시 시도하지 않았다");
    ok("R2 일시 오류(500) → 그 Stop 은 멈춤 · 다음 Stop 에 그 형제는 맨 뒤 · 풀리면 올림");
  }

  // ── R3 두 세션이 같은 형제를 동시에 올리지 않는다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "동시.md": "한 번만 올라가야 한다" });
    DELAY.set(SIB, 700);                                                       // 두 훅의 매니페스트 요청이 겹치게
    await Promise.all([runHook(c, own, "Stop"), runHook(c, own, "Stop")]);
    assert.deepEqual(of(SIB, "PUT").map((r) => r.path), ["동시.md"], "두 세션이 같은 형제를 동시에 올렸다(중복 PUT)");
    ok("R3 동시에 끝난 두 세션 → 같은 형제 파일 PUT 1번");
  }

  // ── R4 끝까지 처리한 형제도 SIB_RECHECK_MS(30분)가 지나면 다시 본다 ──
  {
    const c = await freshCase();
    SERVER[SIB] = { "공유문서.md": { body: "남이 고친 서버본", mtime: 3_000_000 } };
    const own = await mkDir(slot(c, OWN), both(OWN));
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: 2_000_000 }), { "공유문서.md": "옛 판" }, { "공유문서.md": { mtime: 1_000_000, size: 7 } });
    await fsp.writeFile(path.join(sib, "공유문서.md"), "내가 고친 판(더 김)");
    await runHook(c, own, "Stop");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(of(SIB).length, 0, "배선: 30분 안에는 다시 묻지 않아야 한다");
    const [st] = sibFiles(c, /^push-sib-[0-9a-f]+\.state$/);
    assert.ok(st, "배선: 형제 상태 파일이 있어야 한다");
    editJson(st, { at: Date.now() - 31 * 60_000 });
    await runHook(c, own, "Stop");
    assert.equal(of(SIB, "GET").length, 1, "30분이 지났는데 다시 보지 않았다");
    ok("R4 충돌만 남은 형제 → 30분 안엔 요청 0 · 30분 뒤엔 다시 물음");
  }

  // ── R5 남은 예산이 3초 미만이면 형제를 안 본다(같은 Stop 의 다음 훅 몫) ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "x" });
    await runHook(c, own, "Stop", { LIVELY_HOOK_TIMEOUT_MS: "3000" });       // 자력 종료 70% = 2.1초 → 남은 예산 < 3초
    assert.equal(of(SIB).length, 0, "예산이 모자란데 형제를 봤다");
    await runHook(c, own, "Stop", { LIVELY_HOOK_TIMEOUT_MS: "15000" });
    assert.deepEqual(putsOf(SIB), ["새.md"], "배선: 예산이 넉넉하면 올려야 한다");
    ok("R5 훅 상한 3초(남은 예산 < 3초) → 형제 요청 0 · 15초면 올림");
  }

  // ── R6 서버가 지목한 세션 폴더가 디스크에 없어도 형제는 올린다 ──
  {
    const c = await freshCase();
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    SESSION_CTX = { found: true, project_id: OWN, sync: "both", folder: `project/${OWN}`, folder_abs_path: null, session_dir: slot(c, OWN), revision: 1, applied_revision: 1, binding_epoch: 1 };
    assert.equal(fs.existsSync(slot(c, OWN)), false);
    await runHook(c, path.join(c, "home"), "Stop", { LIVELY_SESSION_ID: "box-test-sib-missing" });
    assert.deepEqual(putsOf(SIB), ["새.md"]);
    assert.equal(fs.existsSync(slot(c, OWN)), false, "없는 세션 폴더를 만들면 안 된다");
    ok("R6 세션 폴더가 디스크에 없음 → 그 폴더는 안 만들고 형제는 올림");
  }

  // ── R7 옛 게이트웨이(PUT 응답에 mtime 없음) — 같은 파일을 다시 올리지 않고 조용해진다 ──
  {
    const c = await freshCase();
    NO_MTIME = true;
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "새.md": "새 문서" });
    await runHook(c, own, "Stop");
    await runHook(c, own, "Stop");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(Object.keys(SERVER[SIB]).length, 1);
    assert.equal(of(SIB).length, 0, "옛 게이트웨이에서 세 번째 Stop 에도 계속 물었다");
    ok("R7 옛 게이트웨이(mtime 미반환) → 한 번 올리고, 세 번째 Stop 부터 요청 0");
  }

  // ── R8 걷기가 느린 노드 — 지난 걷기가 1.5초를 넘었으면 1분 안에는 다시 안 걷는다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    const sib = await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }));
    await runHook(c, own, "Stop");                                            // 걷기 기록을 남긴다
    const [scan] = sibFiles(c, /^push-sib-scan-[0-9a-f]+\.json$/);
    assert.ok(scan, "배선: 걷기 기록이 있어야 한다");
    editJson(scan, { ms: 5000, at: Date.now() });
    await newDoc(sib, "새.md", "새 문서");
    await runHook(c, own, "Stop");
    assert.equal(of(SIB).length, 0, "느린 노드인데 1분 안에 또 걸었다");
    editJson(scan, { ms: 5000, at: Date.now() - 61_000 });
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(SIB), ["새.md"], "1분이 지났는데 다시 걷지 않았다");
    ok("R8 지난 걷기 5초(느린 노드) → 1분 안엔 형제 요청 0 · 1분 뒤엔 올림");
  }

  // ── R9 (재검토) 매니페스트는 되는데 올리기가 전부 거절(403)되는 형제 8곳도 자리를 차지하지 못한다 ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    for (let i = 1; i <= 8; i++) {                                            // 601~608: 읽기만 되는 프로젝트 · 더 최근에 씀
      const d = await mkDir(slot(c, 600 + i), both(600 + i, { last_pull: Date.now() }));
      await newDoc(d, "남은.md", `x${i}`, 10_000 - i * 100);
      FAIL_PUT.set(600 + i, 403);
    }
    const good = await mkDir(slot(c, 609), both(609, { last_pull: Date.now() }));
    await newDoc(good, "올릴것.md", "올라가야 할 문서", 600_000);
    await runHook(c, own, "Stop");
    assert.equal(reqs.filter((r) => r.pid >= 601 && r.pid <= 608 && r.method === "PUT").length, 8, "배선: 8곳 모두 PUT 을 시도했어야 한다");
    reqs = [];
    await runHook(c, own, "Stop");
    assert.equal(reqs.filter((r) => r.pid >= 601 && r.pid <= 608).length, 0, "올리기를 전부 거절한 형제를 쉬지 않고 또 시도했다");
    assert.deepEqual(putsOf(609), ["올릴것.md"], "올리기를 거절하는 형제들에 막혀 정작 올릴 형제에 못 닿았다");
    ok("R9 매니페스트는 되고 PUT 이 전부 403 인 형제 8곳 → 쉬게 하고, 9번째 형제는 두 번째 Stop 에 올림");
  }

  // ── R10 쉬는 길이 — 404 는 1시간, 403(게이트웨이 전체의 일시 인증 문제일 수도 있다)은 10분 ──
  for (const [status, minMin, maxMin] of [[404, 59, 61], [403, 9, 11]]) {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB), { "남은.md": "x" });
    MANIFEST_STATUS.set(SIB, status);
    await runHook(c, own, "Stop");
    const [st] = sibFiles(c, /^push-sib-[0-9a-f]+\.state$/);
    assert.ok(st, "배선: 형제 상태 파일이 있어야 한다");
    const v = JSON.parse(fs.readFileSync(st, "utf8"));
    const restMin = (v.denied_until - Date.now()) / 60_000;
    assert.ok(restMin > minMin && restMin < maxMin, `${status} 의 쉼이 ${minMin}~${maxMin}분이 아니다: ${restMin.toFixed(1)}분`);
  }
  ok("R10 매니페스트 404 → 1시간 쉼 · 403 → 10분 쉼");

  // ── R11 일부만 올라가고 일부는 실패 → 다음 Stop 이 실패한 파일을 이어서 올린다(끝낸 것으로 치지 않는다) ──
  {
    const c = await freshCase();
    const own = await mkDir(slot(c, OWN), both(OWN));
    await mkDir(slot(c, SIB), both(SIB, { last_pull: Date.now() }), { "된다.md": "ok", "실패.md": "fail" });
    FAIL_PATH.add(`${SIB}:실패.md`);
    await runHook(c, own, "Stop");
    assert.deepEqual(Object.keys(SERVER[SIB]), ["된다.md"], "배선: 한 파일만 올라갔어야 한다");
    FAIL_PATH.clear(); reqs = [];
    await runHook(c, own, "Stop");
    assert.deepEqual(putsOf(SIB), ["실패.md"], "일부만 실패한 형제를 «끝냄» 으로 적어 실패한 파일을 다시 안 올렸다");
    ok("R11 두 파일 중 하나만 실패 → 다음 Stop 에 실패한 파일만 이어서 올림");
  }

  console.log(`\nproject-push-sibling: ${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true });
}

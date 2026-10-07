#!/usr/bin/env node
// pull 훅의 싱크 원장 + 로컬 보호 e2e (#905 C3) — 가짜 게이트웨이 + 진짜 훅 프로세스.
//  실행: node kit/hooks/project-sync-ledger.test.mjs   (npm test 체인)
//
//  원장(.lively/sync-ledger.json)이 왜 pull 쪽에 있나: **삭제 전파의 근거**는 '우리가 그걸 받았었다'는 사실인데,
//  그걸 아는 건 받아준 pull 뿐이다. 그리고 원장이 생기면 pull 자신도 새 능력이 생긴다 — '로컬이 받은 그대로인가'를
//  알 수 있으니 **아직 안 올라간 로컬 편집을 안 덮을 수 있다**(pull 은 매 턴 push 보다 먼저 돈다).
//
//  여기 계약:
//   🔴 원장은 sync="both" 전용 — pull 모드 폴더의 동작·파일은 C3 이전과 완전히 동일해야 한다.
//   🔴 both 에서 받은 뒤 고친 로컬 파일은 안 덮는다. 그리고 그때 last_pull 을 올리면 안 된다(올리면 push 의
//      충돌검사가 뚫려 남의 최신본이 우리 옛본으로 덮인다 — 이 훅의 버그가 저쪽 훅의 파괴로 나타난다).
//   🔴 원장은 '받은 것'만 적는다 — 못 받은 건(개별 실패) 적지 않고 last_pull 도 안 올린다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = {
  "project-pull": path.join(here, "examples", "project-pull.org-hook.mjs"),
  "project-pull-turn": path.join(here, "examples", "project-pull-turn.org-hook.mjs"),
};
const PROJECT_ID = 905;
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이(가변 상태) ──
let SERVER = {};        // path → { body, mtime }
let FAIL = new Set();   // 이 경로의 본문 GET 은 실패시킨다(개별 파일 실패 재현)
// #4609 — 진짜 라우트(src/project/project-routes.ts `/:id/file`)처럼 군다: `download=1` 이 없으면 미리보기 상한을
//  넘는 본문은 413. 상한은 진짜(25MB) 대신 작은 값이다 — 훅은 상한을 모르고 언제나 download=1 을 실어야 한다.
const PREVIEW_MAX = 256;
let STAMP = false;      // 응답에 판 도장(X-File-Mtime · X-File-Size)을 싣는다(지금 서버) / 안 싣는다(옛 서버)
let SWAP = {};          // path → { body, mtime } — 매니페스트와 다른 판을 내준다(매니페스트를 읽은 뒤 서버본이 바뀜)
let SLOW = new Set();   // 이 경로는 머리와 첫 바이트만 보내고 본문 끝을 4초 끈다
let HOLD = null;        // { path, requested(), release: Promise } — 본문을 시험이 풀어 줄 때까지 붙든다
let GETS = [];          // 본문 요청 기록 { path, download }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
    const files = Object.entries(SERVER).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ files, newest: Math.max(0, ...files.map((f) => f.mtime)), count: files.length, truncated: false }));
  }
  if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file`) {
    const p = u.searchParams.get("path");
    const download = u.searchParams.get("download") === "1";
    GETS.push({ path: p, download });
    if (FAIL.has(p)) { res.writeHead(500); return res.end(); }
    const v = SWAP[p] || SERVER[p];
    if (!v) { res.writeHead(404); return res.end(); }
    const buf = Buffer.from(v.body);
    if (!download && buf.length > PREVIEW_MAX) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "미리보기엔 너무 큽니다 — 다운로드하세요" }));
    }
    const head = { "content-type": download ? "application/octet-stream" : "text/plain" };
    if (STAMP) { head["x-file-mtime"] = String(v.mtime); head["x-file-size"] = String(buf.length); }
    if (SLOW.has(p)) {
      res.writeHead(200, head); res.write(buf.subarray(0, 1));
      const t = setTimeout(() => res.end(buf.subarray(1)), 4000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    if (HOLD && HOLD.path === p) {
      const hold = HOLD;
      res.writeHead(200, head); res.flushHeaders();
      hold.requested();
      hold.release.then(() => res.end(buf));
      return;
    }
    res.writeHead(200, head);
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-ledger-"));
let seq = 0;
async function mkProj(marker, files = {}, ledger = null) {
  const dir = path.join(root, `p${++seq}`);
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  if (ledger) await fsp.writeFile(path.join(dir, ".lively", "sync-ledger.json"), JSON.stringify({ v: 1, files: ledger }, null, 2) + "\n");
  for (const [p, spec] of Object.entries(files)) {
    const body = typeof spec === "string" ? spec : spec.body;
    await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fsp.writeFile(path.join(dir, p), body);
    if (spec && spec.mtime) { const t = new Date(spec.mtime); await fsp.utimes(path.join(dir, p), t, t); }
  }
  return dir;
}
function spawnHook(hookPath, dir, extraEnv = {}) {
  const c = spawn(process.execPath, [hookPath], {
    cwd: dir, env: { ...process.env, ...offlineLivelyEnv(), LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: dir, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify({ cwd: dir }));
  const t0 = Date.now();
  return new Promise((r) => c.on("exit", (code) => r({ code, ms: Date.now() - t0 })));
}
async function runHook(hookPath, dir, extraEnv) {
  const { code, ms } = await spawnHook(hookPath, dir, extraEnv);
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
  return ms;
}
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const ledgerOf = (dir) => { const s = readOr(path.join(dir, ".lively", "sync-ledger.json")); return s ? JSON.parse(s).files : null; };
// 원장이 아예 없을 때 Object.keys 가 TypeError 로 죽으면 '왜 실패했는지'가 안 보인다 — 계약 문장으로 먼저 실패시킨다.
const ledgerMust = (dir, why) => { const L = ledgerOf(dir); assert.ok(L, `원장이 없다 — ${why}`); return L; };
const markerOf = (dir) => JSON.parse(readOr(path.join(dir, ".lively", "project.json")));
const mtimeOf = (p) => Math.floor(fs.statSync(p).mtimeMs);
// 받기 임시 파일(숨김 `.<이름>.lively-pull-…`)이 남았나 — 폴더 전체를 훑는다(.lively 는 제외).
function tempsIn(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".lively") continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.includes(".lively-pull-")) out.push(path.relative(dir, path.join(d, e.name)));
    }
  })(dir);
  return out;
}
function resetServer(files) {
  SERVER = files; FAIL = new Set(); STAMP = false; SWAP = {}; SLOW = new Set(); HOLD = null; GETS = [];
}
const within = (p, ms, why) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(why)), ms))]);

try {
  for (const [id, hookPath] of Object.entries(HOOKS)) {
    // ── 🔴 pull 모드는 원장을 만들지 않는다 — C3 이전과 완전 동일(기존 설치 286개 프로젝트 무영향) ──
    {
      SERVER = { "doc.md": { body: "서버본", mtime: 5_000_000 } }; FAIL = new Set();
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "pull" });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "doc.md")), "서버본", `[${id}] pull 이 안 됨(회귀)`);
      assert.equal(ledgerOf(dir), null, `[${id}] pull 모드인데 원장을 만들었다 — both 전용이어야 함`);
      ok(`[${id}] sync:"pull" → 원장 안 만듦(기존 동작 그대로)`);
    }

    // ── both: 받은 것을 원장에 적는다 — 서버 mtime·size 그대로(우리가 보유한 '서버 버전'의 신원) ──
    {
      SERVER = { "doc.md": { body: "서버본", mtime: 5_000_000 }, "sub/deep.md": { body: "안쪽", mtime: 4_000_000 } };
      FAIL = new Set();
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      const L = ledgerMust(dir, "both 는 받은 것을 원장에 적어야 한다");
      assert.deepEqual(Object.keys(L).sort(), ["doc.md", "sub/deep.md"]);
      assert.deepEqual(L["doc.md"], { mtime: 5_000_000, size: Buffer.byteLength("서버본") });
      assert.equal(markerOf(dir).last_pull, 5_000_000, `[${id}] 전량 받았으면 last_pull 갱신`);
      ok(`[${id}] sync:"both" → 받은 파일을 원장에 기록(경로·서버 mtime·size)`);
    }

    // ── 🔴 both: 받은 뒤 로컬에서 고친 파일은 **안 덮는다**(아직 안 올라간 편집 — push 훅 소관) ──
    //  이게 없으면 매 턴 pull 이 먼저 돌면서 그 턴에 쓴 편집을 지운다.
    {
      const T0 = 5_000_000;
      SERVER = { "doc.md": { body: "서버가 새로 바꾼 본문(길이 다름)", mtime: 9_000_000 } };
      FAIL = new Set();
      const MINE = "내가 고친 로컬본";
      const dir = await mkProj(
        { project_id: PROJECT_ID, sync: "both", last_pull: T0 },
        { "doc.md": { body: MINE, mtime: 8_000_000 } },              // 기준선(T0)과 mtime·size 모두 다르다 = 내가 고침
        { "doc.md": { mtime: T0, size: Buffer.byteLength("옛 서버본") } },
      );
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "doc.md")), MINE, `[${id}] 🔴 안 올라간 로컬 편집이 pull 에 덮여 사라졌다`);
      assert.deepEqual(ledgerMust(dir, "기준선 보존 확인")["doc.md"], { mtime: T0, size: Buffer.byteLength("옛 서버본") },
        `[${id}] 서버본을 못 받았으니 기준선은 예전 그대로여야 한다`);
      assert.equal(markerOf(dir).last_pull, T0,
        `[${id}] 🔴 서버본을 안 받았는데 last_pull 을 올렸다 — push 충돌검사가 뚫려 남의 최신본이 덮인다`);
      ok(`[${id}] 🔴 both + 로컬 편집본 → 안 덮음 · 기준선 유지 · last_pull 미갱신(push 충돌검사 보호)`);
    }

    // ── both: 받은 그대로인 로컬(기준선과 정확히 일치)은 서버 최신본으로 갱신한다 — 과잉보호 아님 ──
    {
      const T0 = 5_000_000, OLD = "옛 서버본";
      SERVER = { "doc.md": { body: "서버 최신본(길이 다름)", mtime: 9_000_000 } };
      FAIL = new Set();
      const dir = await mkProj(
        { project_id: PROJECT_ID, sync: "both", last_pull: T0 },
        { "doc.md": { body: OLD, mtime: T0 } },                       // 기준선과 mtime·size 일치 = 손 안 댐
        { "doc.md": { mtime: T0, size: Buffer.byteLength(OLD) } },
      );
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "doc.md")), "서버 최신본(길이 다름)", `[${id}] 손 안 댄 로컬인데 서버 최신본을 안 받았다(과잉보호)`);
      assert.deepEqual(ledgerMust(dir, "기준선 이동 확인")["doc.md"], { mtime: 9_000_000, size: Buffer.byteLength("서버 최신본(길이 다름)") });
      assert.equal(markerOf(dir).last_pull, 9_000_000);
      ok(`[${id}] both + 손 안 댄 로컬 → 서버본으로 갱신 + 기준선 이동(보호가 과하지 않음)`);
    }

    // ── 🔴 못 받은 파일은 원장에 안 적고 last_pull 도 안 올린다 — '받았다'는 거짓 주장이 곧 남의 파일 삭제다 ──
    {
      SERVER = { "ok.md": { body: "받음", mtime: 5_000_000 }, "broken.md": { body: "못받음", mtime: 5_000_000 } };
      FAIL = new Set(["broken.md"]);
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      const L = ledgerMust(dir, "받은 것만 적혀야 한다");
      assert.deepEqual(Object.keys(L), ["ok.md"], `[${id}] 🔴 못 받은 파일이 원장에 들어갔다 — 삭제 전파의 근거가 거짓이 된다`);
      assert.equal(markerOf(dir).last_pull, undefined,
        `[${id}] 개별 실패가 있는데 last_pull 을 올렸다 — 그 파일은 서버가 또 바뀔 때까지 영구 누락된다`);
      ok(`[${id}] 🔴 개별 다운로드 실패 → 원장 미기록 + last_pull 미갱신(다음 실행 재시도)`);
    }

    // ── 서버에서 사라진 파일은 원장에서도 빠진다(완주 시 통째 교체) ──
    {
      SERVER = { "kept.md": { body: "남음", mtime: 5_000_000 } };
      FAIL = new Set();
      const dir = await mkProj(
        { project_id: PROJECT_ID, sync: "both" },
        {},
        { "kept.md": { mtime: 1, size: 1 }, "gone.md": { mtime: 1, size: 1 } },
      );
      await runHook(hookPath, dir);
      assert.deepEqual(Object.keys(ledgerMust(dir, "완주 시 교체")), ["kept.md"], `[${id}] 서버에 없는 항목이 원장에 남았다`);
      ok(`[${id}] 완주 시 원장 통째 교체 → 서버에서 사라진 항목 정리`);
    }

    // ── 원장이 깨져 있어도 죽지 않는다(빈 원장 = fail-safe) ──
    {
      SERVER = { "doc.md": { body: "서버본", mtime: 5_000_000 } };
      FAIL = new Set();
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await fsp.writeFile(path.join(dir, ".lively", "sync-ledger.json"), "{ 깨진 JSON");
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "doc.md")), "서버본", `[${id}] 깨진 원장이 pull 을 막았다`);
      assert.deepEqual(Object.keys(ledgerMust(dir, "깨진 원장 재작성")), ["doc.md"], `[${id}] 깨진 원장이 재작성돼야 함`);
      ok(`[${id}] 깨진 원장 → 빈 원장으로 취급하고 정상 pull + 재작성`);
    }
  }

  // ═══ #4609 — 수렴을 영영 막던 셋(큰 파일 413 · 바이트는 같고 시각만 다름 · 로컬=서버인데 기준선이 옛 판)과
  //  받기 안전장치(받은 판을 적는다 · 받는 사이 고친 로컬을 안 덮는다 · 강제 종료 전에 끊는다 · 임시 파일 정리).
  //  실측 출처: 2026-10-07 프로젝트 3625 맥북 폴더 — 마커에 last_pull 이 한 번도 없었다.
  //  위 기존 묶음이 다 돈 뒤에 따로 돈다(가짜 서버의 새 상태가 기존 시나리오에 새지 않게 매번 resetServer).
  //  한 시나리오가 실패해도 나머지를 다 돌리고 끝에 모아 보고한다 — 고치기 전 코드에 돌려 행마다 빨간불을 보기 위해서다.
  const failures = [];
  const scenario = async (name, fn) => {
    try { await fn(); ok(name); }
    catch (e) { failures.push(name); console.log(`FAIL ${name}\n      ${String(e && e.message).split("\n")[0]}`); }
  };
  for (const [id, hookPath] of Object.entries(HOOKS)) {
    // ── ① 미리보기 상한을 넘는 파일도 받는다 — 요청에 download=1 ──
    await scenario(`[${id}] #4609 미리보기 상한 초과 파일 → download=1 로 받음 · 기준선 · last_pull`, async () => {
      const BIG = "B".repeat(PREVIEW_MAX + 1);
      resetServer({ "big.bin": { body: BIG, mtime: 5_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      assert.ok(GETS.length > 0, `[${id}] 본문 요청이 한 번도 없었다(관측 장치 확인)`);
      assert.ok(GETS.every((g) => g.download), `[${id}] 🔴 본문 요청에 download=1 이 없다 — 상한 넘는 파일은 413: ${JSON.stringify(GETS)}`);
      assert.equal(readOr(path.join(dir, "big.bin")), BIG, `[${id}] 🔴 상한 넘는 파일을 못 받았다 — 이 파일 하나가 last_pull 을 영영 막는다`);
      assert.deepEqual(ledgerMust(dir, "큰 파일 기준선")["big.bin"], { mtime: 5_000_000, size: PREVIEW_MAX + 1 });
      assert.equal(markerOf(dir).last_pull, 5_000_000, `[${id}] 큰 파일까지 다 받았으면 last_pull 이 적혀야 한다`);
    });

    // ── ①-경계 상한과 정확히 같은 크기 ──
    await scenario(`[${id}] #4609 상한과 같은 크기(경계) → 받음`, async () => {
      const EDGE = "E".repeat(PREVIEW_MAX);
      resetServer({ "edge.bin": { body: EDGE, mtime: 5_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "edge.bin")), EDGE, `[${id}] 상한과 같은 크기를 못 받았다`);
      assert.equal(markerOf(dir).last_pull, 5_000_000);
    });

    // ── ② 기준선 없음 · 바이트는 같고 시각만 다름 → 시각을 서버 판으로 맞추고 기준선을 세운다 ──
    //  (실측: 올리기가 올린 뒤 시각을 맞추기 전에 끊긴 파일 — 서버보다 13초 이른 로컬 시각)
    await scenario(`[${id}] #4609 기준선 없음 + 바이트 같음 + 시각만 다름 → 시각 맞춤 · 기준선 · last_pull`, async () => {
      const SAME = "같은 내용";
      resetServer({ "same.txt": { body: SAME, mtime: 7_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" }, { "same.txt": { body: SAME, mtime: 6_987_000 } });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "same.txt")), SAME);
      assert.equal(mtimeOf(path.join(dir, "same.txt")), 7_000_000, `[${id}] 🔴 바이트가 같은데 시각을 안 맞췄다 — 이 파일이 수렴을 영영 막는다`);
      assert.deepEqual(ledgerMust(dir, "같은 바이트 기준선")["same.txt"], { mtime: 7_000_000, size: Buffer.byteLength(SAME) });
      assert.equal(markerOf(dir).last_pull, 7_000_000);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 임시 파일이 남았다`);
    });

    // ── ③ 기준선 없음 · 크기는 같고 내용이 다름 → 종전대로 아무것도 안 한다(과잉 치유 금지) ──
    await scenario(`[${id}] #4609 기준선 없음 + 같은 크기 다른 내용 → 손대지 않음 · 기준선 없음 · last_pull 없음`, async () => {
      const MINE = "로컬본CD";
      resetServer({ "diff.txt": { body: "로컬본AB", mtime: 7_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" }, { "diff.txt": { body: MINE, mtime: 6_000_000 } });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "diff.txt")), MINE, `[${id}] 🔴 공통 조상 없는 로컬 판본을 덮었다`);
      assert.equal(mtimeOf(path.join(dir, "diff.txt")), 6_000_000, `[${id}] 내용이 다른데 시각을 바꿨다`);
      assert.equal((ledgerOf(dir) || {})["diff.txt"], undefined, `[${id}] 🔴 내용이 다른데 기준선을 세웠다 — 삭제 전파 근거가 거짓이 된다`);
      assert.equal(markerOf(dir).last_pull, undefined);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 비교에 쓴 임시 파일이 남았다`);
    });

    // ── ④ 기준선이 옛 판인데 로컬 = 서버(크기·밀리초 시각) → 받지 않고 기준선만 서버 판으로 ──
    //  (실측: 원장 갱신이 유실된 파일 4개가 «로컬도 서버도 바뀜»으로 판정돼 last_pull 을 막고 있었다)
    await scenario(`[${id}] #4609 옛 기준선 + 로컬=서버 → 기준선만 서버 판으로 · 요청 0건 · last_pull`, async () => {
      const NOW = "서버와 같은 지금 판";
      resetServer({ "conv.txt": { body: NOW, mtime: 9_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" },
        { "conv.txt": { body: NOW, mtime: 9_000_000 } },
        { "conv.txt": { mtime: 5_000_000, size: 3 } });
      await runHook(hookPath, dir);
      assert.deepEqual(ledgerMust(dir, "옛 기준선 갱신")["conv.txt"], { mtime: 9_000_000, size: Buffer.byteLength(NOW) },
        `[${id}] 🔴 로컬이 서버와 같은데 기준선을 옛 판에 두었다 — 영영 수렴 못 한다`);
      assert.equal(GETS.filter((g) => g.path === "conv.txt").length, 0, `[${id}] 이미 같은 판인데 다시 받았다`);
      assert.equal(readOr(path.join(dir, "conv.txt")), NOW);
      assert.equal(markerOf(dir).last_pull, 9_000_000);
    });

    // ── ④-경계 같은 경우인데 로컬 시각이 1ms 다르다 → 같은 판으로 단정하지 않고 바이트를 대 본다 ──
    await scenario(`[${id}] #4609 옛 기준선 + 시각 1ms 차이 + 같은 바이트 → 비교 후 시각 맞춤 · last_pull`, async () => {
      const NOW = "서버와 같은 내용인데 시각만 1ms 차이";
      resetServer({ "near.txt": { body: NOW, mtime: 9_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" },
        { "near.txt": { body: NOW, mtime: 9_000_001 } },
        { "near.txt": { mtime: 5_000_000, size: 3 } });
      await runHook(hookPath, dir);
      assert.equal(GETS.filter((g) => g.path === "near.txt").length, 1, `[${id}] 1ms 라도 다르면 바이트를 대 봐야 한다(요청 1건)`);
      assert.equal(mtimeOf(path.join(dir, "near.txt")), 9_000_000, `[${id}] 🔴 바이트가 같은데 시각을 안 맞췄다`);
      assert.deepEqual(ledgerMust(dir, "1ms 경계")["near.txt"], { mtime: 9_000_000, size: Buffer.byteLength(NOW) });
      assert.equal(markerOf(dir).last_pull, 9_000_000);
    });

    // ── ⑤ 기준선 옛 판 · 로컬 편집(같은 크기 다른 내용) · 서버도 바뀜 → 로컬 보존(충돌 그대로) ──
    await scenario(`[${id}] #4609 옛 기준선 + 같은 크기 로컬 편집 + 서버 변경 → 로컬 보존 · last_pull 그대로`, async () => {
      const MINE = "내가고친판";
      resetServer({ "edit.txt": { body: "서버의새판", mtime: 9_000_000 } });
      assert.equal(Buffer.byteLength(MINE), Buffer.byteLength("서버의새판"), "시험 전제: 같은 크기");
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both", last_pull: 5_000_000 },
        { "edit.txt": { body: MINE, mtime: 8_000_000 } },
        { "edit.txt": { mtime: 5_000_000, size: 9 } });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "edit.txt")), MINE, `[${id}] 🔴 안 올라간 로컬 편집이 덮였다`);
      assert.equal(mtimeOf(path.join(dir, "edit.txt")), 8_000_000);
      assert.deepEqual(ledgerMust(dir, "충돌 기준선")["edit.txt"], { mtime: 5_000_000, size: 9 }, `[${id}] 기준선은 옛 판 그대로여야 한다`);
      assert.equal(markerOf(dir).last_pull, 5_000_000, `[${id}] 🔴 충돌인데 last_pull 을 올렸다 — push 충돌검사가 뚫린다`);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 비교에 쓴 임시 파일이 남았다`);
    });

    // ── ⑥ 매니페스트를 읽은 뒤 서버본이 바뀜 · 응답 도장 있음 → 받은 판의 시각·크기를 적는다 ──
    await scenario(`[${id}] #4609 받는 사이 서버본 바뀜(도장 있음) → 받은 판의 시각·크기로 기록`, async () => {
      const V2 = "v2 — 매니페스트 뒤에 바뀐 더 긴 새 판";
      resetServer({ "race.txt": { body: "v1", mtime: 9_000_000 } });
      STAMP = true; SWAP = { "race.txt": { body: V2, mtime: 9_500_000 } };
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "race.txt")), V2);
      assert.equal(mtimeOf(path.join(dir, "race.txt")), 9_500_000,
        `[${id}] 🔴 받은 판이 아니라 매니페스트 판의 시각을 찍었다 — 로컬이 기준선과 어긋나 «내가 고친 파일»로 굳는다`);
      assert.deepEqual(ledgerMust(dir, "받은 판 기준선")["race.txt"], { mtime: 9_500_000, size: Buffer.byteLength(V2) });
    });

    // ── ⑥-옛 서버 같은 경우인데 응답 도장이 없다 → 매니페스트와 크기가 다른 본문은 버린다 ──
    await scenario(`[${id}] #4609 받는 사이 서버본 바뀜(도장 없음) → 버림 · 기준선 없음 · last_pull 없음`, async () => {
      resetServer({ "race2.txt": { body: "v1", mtime: 9_000_000 } });
      SWAP = { "race2.txt": { body: "v2 — 더 긴 새 판", mtime: 9_500_000 } };
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "race2.txt")), null, `[${id}] 🔴 매니페스트와 크기가 다른 본문을 그대로 놓았다 — 로컬과 기준선이 어긋난다`);
      assert.equal((ledgerOf(dir) || {})["race2.txt"], undefined);
      assert.equal(markerOf(dir).last_pull, undefined);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 버린 본문의 임시 파일이 남았다`);
    });

    // ── ⑦ 판정 뒤 받는 동안 로컬이 고쳐졌다 → 덮지 않는다 ──
    await scenario(`[${id}] #4609 받는 사이 로컬 편집 → 안 덮음 · last_pull 그대로`, async () => {
      const OLD = "옛 서버본", MINE = "받는 사이에 고친 로컬";
      resetServer({ "hold.txt": { body: "새 서버본", mtime: 9_000_000 } });
      let requested; const req = new Promise((r) => { requested = r; });
      let release; const rel = new Promise((r) => { release = r; });
      HOLD = { path: "hold.txt", requested, release: rel };
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both", last_pull: 5_000_000 },
        { "hold.txt": { body: OLD, mtime: 5_000_000 } },
        { "hold.txt": { mtime: 5_000_000, size: Buffer.byteLength(OLD) } });
      const run = spawnHook(hookPath, dir);
      try {
        await within(req, 10_000, `[${id}] 훅이 hold.txt 본문을 요청하지 않았다`);   // 훅이 판정을 끝내고 받는 중
        fs.writeFileSync(path.join(dir, "hold.txt"), MINE);                          // 그 사이 사람이 고친다
      } finally { release(); }   // 실패해도 붙든 응답을 풀어 준다(안 풀면 열린 연결이 시험 프로세스를 붙든다)
      const { code } = await run;
      assert.equal(code, 0);
      assert.equal(readOr(path.join(dir, "hold.txt")), MINE, `[${id}] 🔴 받는 사이 고친 로컬을 서버본으로 덮었다`);
      assert.equal(markerOf(dir).last_pull, 5_000_000, `[${id}] 못 놓았는데 last_pull 을 올렸다`);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 못 놓은 임시 파일이 남았다`);
    });

    // ── ⑧ 느린 본문 + 작은 문서 · 짧은 제한 시간 → 작은 것부터 받고, 느린 것은 강제 종료 전에 끊는다 ──
    await scenario(`[${id}] #4609 느린 본문 + 짧은 제한 시간 → 작은 것 먼저 · 강제 종료 전에 끊음 · 임시 파일 없음`, async () => {
      const SLOW_BODY = "느린 본문 — 작은 문서보다 길다", SMALL = "작은 문서";
      resetServer({ "slow.txt": { body: SLOW_BODY, mtime: 9_000_000 }, "small.txt": { body: SMALL, mtime: 9_000_000 } });
      SLOW = new Set(["slow.txt"]);
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      const ms = await runHook(hookPath, dir, { LIVELY_HOOK_TIMEOUT_MS: "1500" });
      assert.ok(ms < 3000, `[${id}] 🔴 느린 본문을 끝까지 기다렸다(${ms}ms) — 실제로는 제한 시간에 SIGKILL 되어 원장도 못 남긴다`);
      assert.equal(readOr(path.join(dir, "small.txt")), SMALL, `[${id}] 작은 문서를 못 받았다(작은 것부터 받아야 한다)`);
      assert.deepEqual(Object.keys(ledgerMust(dir, "끊긴 실행의 진척")), ["small.txt"]);
      assert.equal(readOr(path.join(dir, "slow.txt")), null, `[${id}] 끊긴 본문이 제자리에 놓였다`);
      assert.equal(markerOf(dir).last_pull, undefined);
      assert.deepEqual(tempsIn(dir), [], `[${id}] 끊긴 받기의 임시 파일이 남았다`);
    });

    // ── ⑪ 강제 종료로 남은 10분 넘은 임시 파일만 지운다 ──
    await scenario(`[${id}] #4609 옛 임시 파일(10분 초과)만 정리`, async () => {
      resetServer({ "sw.txt": { body: "새 판", mtime: 9_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both" });
      const old = path.join(dir, `.sw.txt.lively-pull-${Date.now() - 11 * 60_000}-1-dead`);
      const fresh = path.join(dir, `.sw.txt.lively-pull-${Date.now() - 60_000}-2-live`);
      fs.writeFileSync(old, "x"); fs.writeFileSync(fresh, "y");
      await runHook(hookPath, dir);
      assert.equal(fs.existsSync(old), false, `[${id}] 10분 넘은 임시 파일을 안 지웠다`);
      assert.equal(fs.existsSync(fresh), true, `[${id}] 10분 안 된 임시 파일을 지웠다(다른 실행이 쓰는 중일 수 있다)`);
      assert.equal(readOr(path.join(dir, "sw.txt")), "새 판");
    });

    // ── ⑬ 서버본으로 갈아 끼워도 기존 파일의 권한(실행 비트)을 잇는다 — 종전 그 자리 덮어쓰기와 같게 ──
    await scenario(`[${id}] #4609 서버본으로 갈아 끼워도 실행 권한 유지`, async () => {
      if (process.platform === "win32") return;   // 권한 비트가 없는 OS
      const OLD = "#!/bin/sh\necho old\n", NEW = "#!/bin/sh\necho new — 서버가 고친 판\n";
      resetServer({ "run.sh": { body: NEW, mtime: 9_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "both", last_pull: 5_000_000 },
        { "run.sh": { body: OLD, mtime: 5_000_000 } },
        { "run.sh": { mtime: 5_000_000, size: Buffer.byteLength(OLD) } });
      fs.chmodSync(path.join(dir, "run.sh"), 0o755);   // chmod 은 mtime 을 안 바꾼다 — 로컬은 여전히 «받은 그대로»
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "run.sh")), NEW, `[${id}] 손 안 댄 로컬인데 서버본을 안 받았다`);
      assert.equal(fs.statSync(path.join(dir, "run.sh")).mode & 0o777, 0o755, `[${id}] 🔴 서버본을 받으면서 실행 권한이 사라졌다`);
      assert.equal(markerOf(dir).last_pull, 9_000_000);
    });

    // ── ⑫ pull 모드도 상한 넘는 파일을 받는다 ──
    await scenario(`[${id}] #4609 pull 모드 + 상한 초과 파일 → 받음`, async () => {
      const BIG = "P".repeat(PREVIEW_MAX + 10);
      resetServer({ "pbig.bin": { body: BIG, mtime: 5_000_000 } });
      const dir = await mkProj({ project_id: PROJECT_ID, sync: "pull" });
      await runHook(hookPath, dir);
      assert.equal(readOr(path.join(dir, "pbig.bin")), BIG, `[${id}] 🔴 pull 모드에서 상한 넘는 파일을 못 받았다`);
      assert.equal(markerOf(dir).last_pull, 5_000_000);
    });
  }
  if (failures.length) throw new Error(`#4609 시나리오 ${failures.length}건 실패:\n  ${failures.join("\n  ")}`);
  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

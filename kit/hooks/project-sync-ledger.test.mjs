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
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
    const files = Object.entries(SERVER).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ files, newest: Math.max(0, ...files.map((f) => f.mtime)), count: files.length, truncated: false }));
  }
  if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file`) {
    const p = u.searchParams.get("path");
    if (FAIL.has(p)) { res.writeHead(500); return res.end(); }
    const v = SERVER[p];
    if (!v) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(v.body);
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
async function runHook(hookPath, dir) {
  const c = spawn(process.execPath, [hookPath], {
    cwd: dir, env: { ...process.env, LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: dir }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify({ cwd: dir }));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const ledgerOf = (dir) => { const s = readOr(path.join(dir, ".lively", "sync-ledger.json")); return s ? JSON.parse(s).files : null; };
// 원장이 아예 없을 때 Object.keys 가 TypeError 로 죽으면 '왜 실패했는지'가 안 보인다 — 계약 문장으로 먼저 실패시킨다.
const ledgerMust = (dir, why) => { const L = ledgerOf(dir); assert.ok(L, `원장이 없다 — ${why}`); return L; };
const markerOf = (dir) => JSON.parse(readOr(path.join(dir, ".lively", "project.json")));

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
  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

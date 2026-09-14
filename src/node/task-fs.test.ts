// 위탁 작업 폴더 파일 op 의 자리(2026-09-14 매니지드 첫 증류) — 저장소 분리 배포(매니지드)에선 멤버 경계, 그 밖엔 로컬 fs.
//
// 왜: 매니지드 게이트웨이는 격리 사용자의 공유 루트(`/work/shared`)를 **직접 못 본다**(CP 호스트의 그 경로는 빈 디렉터리).
//  종전엔 작업 폴더를 게이트웨이 fsp 로 만들어 중앙 위탁이 `mkdir '/work/shared/delegated'` 에서 죽었고
//  (새 워크스페이스의 첫 증류가 그대로 막혔다), 만들기만 고치면 종료 파일을 못 봐 1시간 매달린다.
//  이 시험은 ① 고르는 규칙 ② 멤버 쪽 읽기 한 줄이 로컬과 같은 답을 내는지 ③ 가짜 중계를 끼워 준비·감지·tail 이
//  **정말 멤버 경계를 거치는지** ④ 두 번째 위탁자도 들어갈 수 있게 상위 폴더에 그룹 쓰기가 걸리는지를 잠근다.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TASK_READ_JS, TASK_EXISTS_JS, localTaskFs, taskFsIsMember,
  prepareTaskDir, checkTask, tailTask, readTaskText, taskDirDone,
} from "./tasks.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co-taskfs-"));
after(() => { delete process.env.LIVELY_MEMBER_EXEC; fs.rmSync(TMP, { recursive: true, force: true }); });

const runJs = (js: string, input: unknown): unknown => {
  const r = spawnSync(process.execPath, ["-e", js], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("고르는 규칙은 하나 — 격리 사용자 && 저장소 분리일 때만 멤버 경계", () => {
  assert.equal(taskFsIsMember("box_a", true), true);
  assert.equal(taskFsIsMember("box_a", false), false, "자체 호스팅 격리 박스 — 게이트웨이가 그 폴더를 실제로 본다(7월 계약 그대로)");
  assert.equal(taskFsIsMember(null, true), false, "비격리 — 게이트웨이 소유 경로");
  assert.equal(taskFsIsMember(undefined, false), false);
});

test("멤버 쪽 읽기 한 줄은 로컬과 **같은 답**을 낸다 — from 클램프 · tail · 없음=null", async () => {
  const f = path.join(TMP, "read.jsonl");
  await fsp.writeFile(f, "0123456789");
  const reqs = [
    { key: "all", path: f, max: Number.MAX_SAFE_INTEGER },
    { key: "mid", path: f, from: 3, max: 4 },
    { key: "past", path: f, from: 99, max: 10 },
    { key: "tail", path: f, max: 3, tail: true },
    { key: "none", path: path.join(TMP, "nope"), max: 10 },
  ];
  const local = await localTaskFs.readMany(reqs);
  const member = runJs(TASK_READ_JS, reqs) as Record<string, { size: number; b64: string } | null>;
  for (const r of reqs) {
    const l = local[r.key], m = member[r.key];
    if (!l) { assert.equal(m, null, `${r.key}: 로컬은 없음인데 멤버는 있다`); continue; }
    assert.ok(m, `${r.key}: 로컬은 있는데 멤버는 없다`);
    assert.equal(m.size, l.size, `${r.key}: size`);
    assert.equal(Buffer.from(m.b64, "base64").toString(), l.buf.toString(), `${r.key}: 내용`);
  }
  assert.equal(local.all?.buf.toString(), "0123456789");
  assert.equal(local.mid?.buf.toString(), "3456");
  assert.equal(local.past?.buf.length, 0, "from 이 길이를 넘으면 빈 조각(파일이 짧아진 재시도)");
  assert.equal(local.tail?.buf.toString(), "789");
  assert.equal(local.none, null);
});

test("존재 확인 한 줄도 로컬과 같다", async () => {
  const f = path.join(TMP, "exists.txt");
  await fsp.writeFile(f, "x");
  const ps = [TMP, f, path.join(TMP, "nope")];
  assert.deepEqual(runJs(TASK_EXISTS_JS, ps), await localTaskFs.exists(ps));
  assert.deepEqual(await localTaskFs.exists(ps), [true, true, false]);
});

test("★★ 저장소 분리면 작업 폴더 준비·종료 감지·tail 이 **멤버 경계를 거친다** — 게이트웨이 fs 를 직접 만지지 않는다", async () => {
  // 가짜 중계: `<중계> <osUser> -- argv…` 를 받아 argv 를 이 기계에서 그대로 돌리고, 누구로 불렸는지 적는다.
  const log = path.join(TMP, "relay.log");
  const relay = path.join(TMP, "relay.cjs");
  await fsp.writeFile(relay, [
    "const { spawnSync } = require('child_process'); const fs = require('fs');",
    "const i = process.argv.indexOf('--'); const argv = process.argv.slice(i + 1);",
    `fs.appendFileSync(${JSON.stringify(log)}, process.argv[2] + ' ' + argv[0] + '\\n');`,
    "const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' }); process.exit(r.status == null ? 1 : r.status);",
  ].join("\n"));
  process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${relay}`;
  try {
    const root = path.join(TMP, "shared");
    await fsp.mkdir(root, { recursive: true });
    const rootMode = fs.statSync(root).mode & 0o7777;
    const ws = path.join(root, "delegated", "task-7");

    const dir = await prepareTaskDir(ws, root, 7, "증류해라", "box_tester");
    assert.equal(dir, path.join(ws, ".lively-task", "7"));
    assert.equal(await fsp.readFile(path.join(dir, "prompt.txt"), "utf8"), "증류해라");
    //  ★ 두 번째 위탁자 — 첫 위탁자가 만든 `delegated/` 에 그룹 쓰기가 없으면 다음 사람부터 EACCES 다.
    for (const d of [path.join(root, "delegated"), ws, path.join(ws, ".lively-task"), dir]) {
      assert.equal(fs.statSync(d).mode & 0o070, 0o070, `${path.relative(root, d)} 에 그룹 rwx 가 없다 — 다른 위탁자가 못 들어온다`);
    }
    assert.equal(fs.statSync(root).mode & 0o7777, rootMode, "공유 루트 자체는 넓히지 않는다(경계)");

    const w = { taskId: 7, sessionId: "box-t-1", taskDir: dir, harness: "claude", osUser: "box_tester" };
    assert.equal(await checkTask(w), null, "exit 전엔 실행 중");
    assert.equal(await taskDirDone(dir, "box_tester"), false);

    await fsp.writeFile(path.join(dir, "stream.jsonl"), '{"type":"result","result":"끝"}\n');
    const t1 = await tailTask(dir, 0, "box_tester");
    assert.equal(t1.done, false);
    assert.ok(t1.chunk.includes("끝") && t1.next > 0, "스트림을 멤버 경계로 이어 읽어야 한다");
    const t2 = await tailTask(dir, t1.next, "box_tester");
    assert.equal(t2.chunk, "");
    assert.equal(t2.next, t1.next);

    await fsp.writeFile(path.join(dir, "exit"), "0\n");
    const out = await checkTask(w);
    assert.equal(out?.ok, true, "종료 파일을 봐야 끝난 걸 안다 — 못 보면 1시간 타임아웃까지 매달린다");
    assert.equal(out?.exit, 0);
    assert.equal((await tailTask(dir, t1.next, "box_tester")).done, true);
    assert.equal(await taskDirDone(dir, "box_tester"), true);
    assert.equal(await taskDirDone(path.join(root, "nope"), "box_tester"), null, "폴더가 없으면 관측 불가");

    await fsp.writeFile(path.join(dir, "session"), "box-t-1\n");
    assert.equal((await readTaskText(dir, "session", "box_tester"))?.trim(), "box-t-1");

    //  재시도 — 이전 시도의 종결 흔적이 남으면 시작하자마자 «가짜 완료» 다.
    await prepareTaskDir(ws, root, 7, "다시", "box_tester");
    assert.equal(await checkTask(w), null, "재시도면 이전 exit 가 지워져야 한다");
    assert.equal(await fsp.readFile(path.join(dir, "prompt.txt"), "utf8"), "다시");

    const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.ok(calls.length >= 8, `멤버 경계 호출이 너무 적다(${calls.length}) — 로컬 fs 로 샌 op 가 있다`);
    assert.ok(calls.every((l) => l.startsWith("box_tester ")), "모든 op 가 그 사용자 경계로 가야 한다");

    //  대조군 — 저장소 분리가 아니면(자체 호스팅 격리 박스) 종전 로컬 fs 그대로다. 중계가 불리면 안 된다.
    delete process.env.LIVELY_MEMBER_EXEC;
    const before = calls.length;
    const dir2 = await prepareTaskDir(path.join(root, "delegated", "task-8"), root, 8, "로컬", "box_tester");
    assert.equal(await fsp.readFile(path.join(dir2, "prompt.txt"), "utf8"), "로컬");
    assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length, before, "저장소가 붙어 있으면 중계를 타면 안 된다");
  } finally {
    delete process.env.LIVELY_MEMBER_EXEC;
  }
});

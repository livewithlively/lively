// 노드의 «gone» 답 — tmux 서버가 아예 없으면 끝남 확답 (#4917).
//
// 실측(2026-10-19~20, 맥미니): tmux 서버가 죽은 뒤 다음 세션이 뜨기 전까지 `has-session` 은
//  "error connecting to …" 를 냈고, 노드는 그걸 «모른다 → 살아 있음» 으로 접어 `POST …/restore` 가
//  `already:true` 로 끝났다. 세 세션이 17시간 동안 되살릴 수 없었다.
//
// 이 파일은 **진짜 tmux** 를 빈 TMUX_TMPDIR 에 띄워 잰다 — 문구는 tmux 판마다 다를 수 있어서 흉내 낸 stderr 만으로는
//  «이 tmux 가 정말 그 문구를 내나» 를 못 잡는다. tmux 가 없거나 윈도우면 그 칸만 건너뛴다.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ⚠ tmux-exec 는 모듈을 읽을 때 env 를 복사하고(TMUX_ENV) 실행 파일 자리를 굳힌다(catalog TMUX_BIN — 기본값이
//  맥 Homebrew 경로라 리눅스 CI 에선 없다). 둘 다 **import 전에** 정한다 — 이 PATH 의 tmux 를 쓰고, 소켓은 빈 자리에.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "gone-node-"));
const TMUX = process.platform === "win32" ? "" : spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
process.env.TMUX_TMPDIR = TMPDIR;
if (TMUX) process.env.TMUX_BIN = TMUX;
delete process.env.TMUX;          // 바깥 tmux 안에서 돌려도 그 서버에 붙지 않게
delete process.env.LIVELY_TMUX_EXEC;
const { isTmuxServerAbsentError } = await import("./tmux-exec.js");
const { runSessionOp } = await import("./session-ops.js");

const skip = TMUX ? false : "tmux 없음";
const tmuxHere = (...a: string[]) => spawnSync(TMUX || "tmux", a, { encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: TMPDIR } });
after(() => { tmuxHere("kill-server"); fs.rmSync(TMPDIR, { recursive: true, force: true }); });

async function asNode<T>(fn: () => Promise<T>): Promise<T> {
  process.env.LIVELY_NODE_TOKEN = "test-node-token";
  try { return await fn(); } finally { delete process.env.LIVELY_NODE_TOKEN; }
}
/** 이 시험이 보는 소켓에 정말 서버가 없나 — 바깥 서버에 붙어 «있는 세션» 으로 잘못 재는 걸 막는 배선 확인. */
function assertNoServer(): void {
  const r = tmuxHere("list-sessions");
  assert.notEqual(r.status, 0, "격리 실패 — 시험 소켓에 tmux 서버가 있다");
  assert.ok(isTmuxServerAbsentError({ stderr: r.stderr }), `이 tmux 의 서버 부재 문구를 못 알아본다: ${r.stderr.trim()}`);
}

test("6·7행 · 서버 부재 문구 — 스테일 소켓·소켓 파일 없음은 부재, 세션 없음·타임아웃·빈 값은 아니다", () => {
  assert.equal(isTmuxServerAbsentError({ stderr: "no server running on /private/tmp/tmux-501/default\n" }), true);
  assert.equal(isTmuxServerAbsentError({ stderr: "error connecting to /private/tmp/tmux-501/default (No such file or directory)\n" }), true);
  assert.equal(isTmuxServerAbsentError({ stderr: "can't find session: box-x\n" }), false, "세션 없음은 서버 부재가 아니다");
  assert.equal(isTmuxServerAbsentError({ stderr: "no server running on /x", killed: true }), false, "타임아웃으로 죽인 호출은 답이 아니다");
  assert.equal(isTmuxServerAbsentError(null), false);
});

test("★ 1행 · 노드 · tmux 서버가 없다 → gone op 는 끝남(true)", { skip }, async () => {
  tmuxHere("kill-server");
  assertNoServer();
  assert.equal(await asNode(() => runSessionOp("gone", { id: "box-yoon-0000dead" })), true,
    "서버가 없는데 «살아 있음» 이라고 답하면 복원이 already 로 막힌다(#4917)");
});

test("5행 · 노드 · 서버가 없어도 형식이 틀린 id 는 끝남이 아니다", { skip }, async () => {
  tmuxHere("kill-server");
  assertNoServer();
  assert.equal(await asNode(() => runSessionOp("gone", { id: "../etc" })), false);
});

test("4행 · 게이트웨이(노드 아님) · 서버 부재는 종전대로 «모름 → 살아 있음»(#835 무회귀)", { skip }, async () => {
  tmuxHere("kill-server");
  assertNoServer();
  assert.equal(await runSessionOp("gone", { id: "box-yoon-0000dead" }), false);
});

test("2·3행 · 노드 · 서버가 있으면 종전 판정 — 있는 세션은 살아 있음, 없는 세션은 끝남", { skip }, async () => {
  const r = tmuxHere("new-session", "-d", "-s", "box-yoon-1111aaaa", "sleep", "60");
  assert.equal(r.status, 0, r.stderr);
  try {
    assert.equal(await asNode(() => runSessionOp("gone", { id: "box-yoon-1111aaaa" })), false);
    assert.equal(await asNode(() => runSessionOp("gone", { id: "box-yoon-2222bbbb" })), true);
  } finally { tmuxHere("kill-server"); }
});

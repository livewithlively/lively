// killEmptyTmuxServer(#869 노드 부팅 자가치유) — **언제 kill-server 를 치는가**를 못박는다.
//  이 함수는 노드 에이전트가 뜰 때마다 돈다(자가 갱신 재시작 포함 — 하루에도 몇 번). kill-server 는 그 서버의
//  **모든 세션**을 죽이므로, "비었다"의 판정이 한 번이라도 틀리면 그 PC 의 라이브 세션이 통째로 사라진다
//  (2026-08-18 hammurabi 실측: kill-server 한 번에 윈도우 노드의 라이블리 세션 5개가 동시에 죽어 웹에서
//   "세션을 찾을 수 없어요"로 보였다 — 그 kill 은 테스트가 쳤지만, 이 함수도 같은 명령을 같은 서버에 친다).
// 검증은 tmux 실행 seam(LIVELY_TMUX_EXEC)에 가짜 tmux 를 꽂아 **어떤 tmux 명령이 실제로 나갔는가**로 한다
//  (tmux-exec-seam.test 와 같은 장치). 실 tmux 는 건드리지 않는다.
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killEmptyTmuxServer } from "./sessions.js";

const skip = process.platform === "win32" ? "가짜 tmux 가 POSIX 셸 스크립트라 윈도우에선 못 돈다(실 psmux 를 건드리지 않기 위한 의도적 생략)" : false;

afterEach(() => { delete process.env.LIVELY_TMUX_EXEC; });

// 가짜 tmux — 받은 명령을 로그에 남기고, list-sessions 만 시나리오대로 답한다.
//  fail=true 는 "no server running"(tmux 가 답을 못 준 모든 경우 — 서버 없음·타임아웃·과부하의 대역).
function fakeTmux(opts: { fail?: boolean; sessions?: string }): { dir: string; bin: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kill-empty-"));
  const bin = path.join(dir, "tmux.sh");
  const log = path.join(dir, "calls.log");
  const listBody = opts.fail ? 'echo "no server running" >&2; exit 1' : `printf '%s' '${opts.sessions ?? ""}'`;
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\ncase "$1" in\n  list-sessions) ${listBody} ;;\nesac\n`, { mode: 0o755 });
  return { dir, bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

async function run(opts: { fail?: boolean; sessions?: string }): Promise<string[]> {
  const f = fakeTmux(opts);
  try {
    process.env.LIVELY_TMUX_EXEC = f.bin;
    await killEmptyTmuxServer();
    return f.calls();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}

test("★ 세션이 하나도 없다고 tmux 가 답하면 → kill-server (자가치유의 본래 목적)", { skip }, async () => {
  const calls = await run({ sessions: "" });
  assert.deepEqual(calls, ["list-sessions", "kill-server"]);
});

test("★★ 조회가 실패하면(서버 없음·타임아웃·과부하) → kill-server 를 치지 않는다 — 못 봤다 ≠ 비었다", { skip }, async () => {
  // 종전엔 collectSessions 가 실패를 빈 배열로 접어 여기서 kill-server 가 나갔다. 서버가 정말 없으면 무해하지만,
  //  과부하 타임아웃(5s)이면 **살아있는 세션 전부**를 죽이는 판정이다 — 부팅 직후가 하필 가장 바쁜 순간이다.
  const calls = await run({ fail: true });
  assert.deepEqual(calls, ["list-sessions"]);
});

test("★★ box-* 세션이 있으면 → 보존", { skip }, async () => {
  const calls = await run({ sessions: "box-yoon-93e1f84a\nbox-yoon-403c8b77\n" });
  assert.deepEqual(calls, ["list-sessions"]);
});

test("★★ box-* 가 아닌 세션(사용자의 개인 tmux 세션)만 있어도 → 보존 — 그건 빈 서버가 아니다", { skip }, async () => {
  // 종전 판정은 box-* 만 세어 개인 세션이 있는 서버도 '비었다'며 죽였다. Windows psmux 는 소켓 격리가 없어
  //  kill-server = 'PC 의 모든 세션 종료'라 이 구멍이 그대로 사용자 세션 손실이다.
  const calls = await run({ sessions: "main\nwork\n" });
  assert.deepEqual(calls, ["list-sessions"]);
});

test("★ 빈 줄만 있는 답(개행 하나)은 0 세션으로 본다 → kill-server", { skip }, async () => {
  const calls = await run({ sessions: "\n" });
  assert.deepEqual(calls, ["list-sessions", "kill-server"]);
});

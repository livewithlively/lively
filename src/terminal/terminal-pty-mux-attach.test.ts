// 노드 tmux 세대의 attach — 세대를 찾는 틈(has-session)에 생기는 세 가지 (#4931, 리뷰 지적 N1).
//  ① 그 틈에 온 메시지(첫 크기·입력)를 버리지 않고 띄운 뒤 순서대로 싣는다
//  ② 그 틈에 소켓이 닫히면 띄우지 않는다(회수할 사람이 없는 attach 클라이언트가 남지 않게)
//  ③ 그 틈에 노드가 종료를 시작하면 띄우지 않고 소켓을 닫는다
//  가짜 tmux(셸 스크립트)의 has-session 이 0.3초 걸리게 해 그 틈을 만든다. 진짜 tmux 서버는 안 건드린다.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachSession, attachRefCount, killAttachedPtys, type AttachSocket, type AttachTerm } from "./terminal-pty.js";
import { configureMuxGenerations, resetMuxGenerationsForTest } from "./mux-generations.js";

const skip = process.platform === "win32" ? "윈도우 — 셸 스크립트 실행파일" : false;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mux-attach-"));
const FAKE_BIN = path.join(DIR, "fake-tmux");
fs.writeFileSync(FAKE_BIN, `#!/bin/sh
[ "$1" = "-L" ] && shift 2
[ "$1" = "-N" ] && shift
case "$1" in has-session) sleep 0.3; exit 0;; esac
exit 0
`, { mode: 0o755 });
const SOCK = "lively-mux-9.9z";
configureMuxGenerations({
  current: { key: SOCK, socket: SOCK, bin: FAKE_BIN, noStart: true },
  legacy: { key: "default", socket: null, bin: FAKE_BIN, noStart: true },
  socketDir: path.join(DIR, "no-sockets"), binFor: () => null,
});
after(() => { resetMuxGenerationsForTest(); fs.rmSync(DIR, { recursive: true, force: true }); });

class FakeTerm implements AttachTerm {
  readonly writes: string[] = [];
  private readonly dataCbs: Array<(d: Buffer) => void> = [];
  constructor(readonly bin: string, readonly args: string[]) {}
  onData(cb: (d: Buffer) => void): void { this.dataCbs.push(cb); }
  onExit(): void { /* 시험에선 끝나지 않는다 */ }
  write(s: string): void { this.writes.push(s); }
  resize(): void { /* control mode 는 refresh-client 로 통지한다 */ }
  kill(): void { /* noop */ }
  emit(s: string): void { const b = Buffer.from(s, "latin1"); for (const cb of this.dataCbs) cb(b); }
}
/** 노드 에이전트의 ChanSocket 처럼 close() 가 'close' 를 **동기로** 쏜다. */
class FakeSock implements AttachSocket {
  closes = 0;
  private readonly ls = new Map<string, Array<(...a: unknown[]) => void>>();
  send(): void { /* 화면으로 가는 바이트 — 이 시험은 안 본다 */ }
  close(): void { this.closes++; this.emit("close"); }
  on(ev: string, fn: (...a: unknown[]) => void): void { const a = this.ls.get(ev) ?? []; a.push(fn); this.ls.set(ev, a); }
  emit(ev: string, ...a: unknown[]): void { for (const fn of this.ls.get(ev) ?? []) fn(...a); }
  msg(m: object): void { this.emit("message", JSON.stringify(m)); }
}
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`${ms}ms 안에 안 섰다: ${what}`); await tick(5); }
}
function spawner(): { spawned: FakeTerm[]; spawn: (bin: string, args: string[]) => AttachTerm } {
  const spawned: FakeTerm[] = [];
  return { spawned, spawn: (bin, args) => { const t = new FakeTerm(bin, args); spawned.push(t); return t; } };
}

test("① 세대를 찾는 틈에 온 첫 크기·입력은 버리지 않는다 — 띄운 뒤 온 순서대로 tmux 에 간다", { skip }, async () => {
  const ws = new FakeSock();
  const { spawned, spawn } = spawner();
  attachSession(ws, "box-t-0000aaa1", { spawn });
  ws.msg({ t: "r", c: 120, r: 40 });          // 게이트웨이는 노드의 opened 를 기다리지 않고 흘린다
  ws.msg({ t: "i", d: "a" });
  assert.equal(spawned.length, 0, "아직 세대를 찾는 중이다(has-session 0.3초) — 배선 확인");
  await until("attach 를 띄웠다", () => spawned.length === 1);
  const term = spawned[0]!;
  assert.equal(term.bin, FAKE_BIN);
  assert.deepEqual(term.args, ["-L", SOCK, "-N", "-u", "-CC", "attach", "-t", "box-t-0000aaa1"], "그 세션의 세대로 · 서버를 새로 띄우지 않게(-N)");
  term.emit("\x1bP1000p");                       // tmux 가 control 모드에 들어섰다 → 쥐고 있던 명령이 나간다
  const sent = term.writes.join("");
  assert.match(sent, /refresh-client -C 120x40/, `첫 크기가 갔다: ${JSON.stringify(sent)}`);
  assert.match(sent, /send-keys/, "첫 입력도 갔다");
  assert.ok(sent.indexOf("refresh-client") < sent.indexOf("send-keys"), "온 순서 그대로");
  ws.close();
});

test("② 세대를 찾는 틈에 소켓이 닫히면 띄우지 않는다 — 참조수도 안 남는다", { skip }, async () => {
  const ws = new FakeSock();
  const { spawned, spawn } = spawner();
  attachSession(ws, "box-t-0000aaa2", { spawn });
  ws.close();
  await tick(700);
  assert.equal(spawned.length, 0, "아무도 회수하지 않을 attach 클라이언트를 띄웠다");
  assert.equal(attachRefCount("box-t-0000aaa2"), 0);
});

//  ⚠ 맨 끝에 둔다 — killAttachedPtys 는 «종료 중» 표지를 되돌리지 않는다(종료 경로 전용).
test("③ 세대를 찾는 틈에 노드가 종료를 시작하면 띄우지 않고 소켓을 닫는다", { skip }, async () => {
  const ws = new FakeSock();
  const { spawned, spawn } = spawner();
  attachSession(ws, "box-t-0000aaa3", { spawn });
  killAttachedPtys();                            // SIGTERM — SessionHost.shutdown 이 부르는 그것
  await tick(700);
  assert.equal(spawned.length, 0, "종료 뒤에 띄운 PTY 는 고아가 된다(노드엔 고아 attach 회수가 없다)");
  assert.equal(ws.closes, 1, "브라우저가 다시 붙게 소켓을 닫았다");
});

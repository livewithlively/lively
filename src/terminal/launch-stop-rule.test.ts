// #4695 T5 — 하네스 종료 규칙 세션의 런처(catalog LAUNCH_STOP_SH — 상민님 2026-10-15 ①②③)를 **진짜 셸로** 돌려 본다.
//  ① 한동안 돌던 하네스가 죽으면 셸 없이 끝낸다(tmux 가 끝나야 컨테이너가 걷힌다 — 셸이 붙잡으면 예약 1GB 가 남는다)
//  ② 이어 열기가 기동 직후(20초 안) 죽으면 이어 열기 인자를 빼고 새 대화로 한 번 더(없는 대화 id 는 claude·codex 모두 exit 1 — T2 §4)
//  ③ 새 대화로도 곧바로 죽으면(로그인 만료·실행 파일 없음) 종전처럼 안내 + 셸(사람이 원인을 읽고 고칠 자리 — #1516)
//  틀리면 티가 크다:
//   🔴 ①을 놓치면 — 돌다 죽은 세션이 셸로 남아 tmux·컨테이너를 붙잡는다(이 규칙의 목적이 깨진다).
//   🔴 ②의 인자 빼기가 한 칸 어긋나면 — 모델 플래그를 잃거나(--model 이 빠짐) 대화 id 가 남아 또 죽는다.
//   🔴 시계를 못 읽을 때 ①로 떨어지면 — 로그인 만료로 즉사한 세션이 안내도 없이 사라진다.
//  관측: 가짜 하네스가 찍는 «ARGS:» 줄(무엇으로 몇 번 불렸나) · 폴백 셸만 실행하는 표식(SHELL_ALIVE) · 종료코드.
import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessLaunchArgv, STOP_RULE_HARNESSES } from "./catalog.js";

const dir = mkdtempSync(join(tmpdir(), "launch-stop-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
/** 가짜 하네스 — 받은 인자를 찍고, 이어 열기(--resume)면 resumeRc 로, 아니면 sleep 뒤 rc 로 끝난다. 외부 명령은 sleep 하나뿐이다. */
function fakeHarness(name: string, o: { resumeRc: number; rc: number; sleep?: number }): string {
  const f = join(dir, name);
  writeFileSync(f, [
    "#!/bin/sh",
    'echo "ARGS:$*"',
    `case " $* " in *" --resume "*) exit ${o.resumeRc};; esac`,
    ...(o.sleep ? [`sleep ${o.sleep}`] : []),
    `exit ${o.rc}`,
  ].join("\n") + "\n");
  chmodSync(f, 0o755);
  return f;
}
const ALIVE = "echo SHELL_ALIVE\n";   // 폴백 셸이 떴을 때만 실행된다
function run(argv: string[], env: Record<string, string> = {}): { out: string; code: number | null } {
  const stdin = join(dir, `stdin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(stdin, ALIVE);
  const fd = openSync(stdin, "r");
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
      stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SHELL: "/bin/sh", ENV: "", ...env } as NodeJS.ProcessEnv,
    });
    assert.ok(!r.error && r.status !== null, `[배선] 런처가 실제로 실행됐다 — ${r.error?.message ?? r.signal ?? ""}`);
    return { out: (r.stdout || "") + (r.stderr || ""), code: r.status };
  } finally { closeSync(fd); }
}
const argsLines = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("ARGS:"));
const RETRY = "이어서 열 대화를 찾지 못해 새 대화로 시작합니다.";
const stop = (bin: string, rest: string[], resumeArgc: number, harness = "claude") =>
  harnessLaunchArgv(harness, [bin, ...rest], "linux", { stopRule: true, resumeArgc });

test("L1 정상 종료(rc 0)면 세션이 끝난다 — 셸도 안내도 없다", () => {
  const h = fakeHarness("ok", { resumeRc: 0, rc: 0 });
  const r = run(stop(h, ["--resume", "c-1"], 2));
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /SHELL_ALIVE|예기치 않게 종료/);
});
test("L2 ① 한동안 돌던 하네스가 죽으면(기동 시간 > 기준) 셸 없이 끝낸다 — 종료코드는 하네스의 것", () => {
  const h = fakeHarness("died", { resumeRc: 0, rc: 3, sleep: 1 });
  const r = run(stop(h, ["--model", "opus"], 0), { LIVELY_LAUNCH_QUICK_SEC: "0" });
  assert.deepEqual(argsLines(r.out), ["ARGS:--model opus"]);
  assert.equal(r.code, 3);
  assert.doesNotMatch(r.out, /SHELL_ALIVE/, "🔴 셸이 tmux 를 붙잡는다");
  assert.doesNotMatch(r.out, /예기치 않게 종료/);
});
test("L3 ② 이어 열기가 곧바로 죽으면 이어 열기 인자만 빼고(나머지 플래그는 그대로) 새 대화로 한 번 더 띄운다", () => {
  const h = fakeHarness("resume-dead", { resumeRc: 1, rc: 0 });
  const r = run(stop(h, ["--resume", "c-404", "--model", "opus", "--effort", "high"], 2));
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-404 --model opus --effort high", "ARGS:--model opus --effort high"]);
  assert.match(r.out, new RegExp(RETRY));
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /SHELL_ALIVE/);
});
test("L3b ② codex 처럼 이어 열기가 서브커맨드 하나(resume <id> = 2칸)여도 같은 자리에서 뺀다", () => {
  const h = fakeHarness("codex-like", { resumeRc: 1, rc: 0 });
  //  codex 이어 열기는 `codex resume <id> <플래그…>` — 가짜 하네스는 --resume 만 알아보므로 첫 칸을 --resume 으로 둔다.
  const r = run(stop(h, ["--resume", "019a-…", "-a", "on-request"], 2, "codex"));
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume 019a-… -a on-request", "ARGS:-a on-request"]);
});
test("L4 ②→③ 새 대화로도 곧바로 죽으면 종전처럼 안내 + 셸(원인을 읽고 고칠 자리)", () => {
  const h = fakeHarness("login-expired", { resumeRc: 1, rc: 1 });
  const r = run(stop(h, ["--resume", "c-1"], 2));
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1", "ARGS:"]);
  assert.match(r.out, /예기치 않게 종료/);
  assert.match(r.out, /SHELL_ALIVE/);
});
test("L4b ②→① 새 대화가 한동안 돌다 죽으면 셸 없이 끝낸다", () => {
  const h = fakeHarness("new-then-died", { resumeRc: 1, rc: 4, sleep: 2 });
  const r = run(stop(h, ["--resume", "c-1"], 2), { LIVELY_LAUNCH_QUICK_SEC: "1" });
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1", "ARGS:"]);
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.out, /SHELL_ALIVE/);
});
test("L5 새 대화로 연 세션(이어 열기 인자 0)이 곧바로 죽으면 다시 띄우지 않고 안내 + 셸", () => {
  const h = fakeHarness("new-dead", { resumeRc: 0, rc: 1 });
  const r = run(stop(h, ["--model", "opus"], 0));
  assert.deepEqual(argsLines(r.out), ["ARGS:--model opus"]);
  assert.match(r.out, /SHELL_ALIVE/);
  assert.match(r.out, /예기치 않게 종료/);
});
test("L6 실행 파일이 없으면(127) 이어 열기여도 다시 띄우지 않는다 — 곧바로 «찾지 못했다» 안내 + 셸(«대화를 못 찾았다» 는 틀린 안내다)", () => {
  const r = run(stop(join(dir, "no-such-harness"), ["--resume", "c-1"], 2));
  assert.match(r.out, /PATH 에서 찾지 못했습니다/);
  assert.doesNotMatch(r.out, new RegExp(RETRY));
  assert.match(r.out, /SHELL_ALIVE/);
});
test("L7 시계(date)를 못 읽으면 종전 런처처럼 군다 — 다시 띄우지도, 조용히 끝내지도 않는다(안내 + 셸)", () => {
  const h = fakeHarness("noclock", { resumeRc: 1, rc: 1 });
  const argv = stop(h, ["--resume", "c-1"], 2);
  //  PATH 를 비워 date 를 못 찾게 한다(sh·가짜 하네스는 절대경로로 부른다).
  const r = run(["/bin/sh", ...argv.slice(1)], { PATH: join(dir, "empty-path") });
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1"], "🔴 시계 없이 ②로 가면 근거 없이 대화를 버린다");
  assert.match(r.out, /SHELL_ALIVE/);
});
test("L8 이어 열기 인자 수가 깨졌으면(숫자 아님·빈 값) 0 으로 본다 — 다시 띄우지 않는다", () => {
  const h = fakeHarness("bad-nres", { resumeRc: 1, rc: 1 });
  for (const bad of ["2x", ""]) {
    const argv = stop(h, ["--resume", "c-1"], 2);
    argv[6] = bad;   // ["sh","-c",<스크립트>,"lively-launch",<안내>,<못찾음 안내>,<nres>,…]
    const r = run(argv);
    assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1"], `nres=${JSON.stringify(bad)}`);
    assert.match(r.out, /SHELL_ALIVE/);
    assert.doesNotMatch(r.out, /\[: /, "깨진 값이 사람 화면에 셸 오류를 찍지 않는다");
  }
});
test("L9 이어 열기 인자 수가 실행 인자보다 많으면(있을 수 없는 조합) 다시 띄우지 않는다", () => {
  const h = fakeHarness("short", { resumeRc: 1, rc: 1 });
  const r = run(stop(h, [], 2));
  assert.deepEqual(argsLines(r.out), ["ARGS:"]);
  assert.match(r.out, /SHELL_ALIVE/);
});
test("L10 기준 초(LIVELY_LAUNCH_QUICK_SEC)가 깨졌으면 20초로 본다 — 곧바로 죽은 이어 열기는 여전히 새 대화로", () => {
  const h = fakeHarness("bad-quick", { resumeRc: 1, rc: 0 });
  const r = run(stop(h, ["--resume", "c-1"], 2), { LIVELY_LAUNCH_QUICK_SEC: "abc" });
  assert.deepEqual(argsLines(r.out), ["ARGS:--resume c-1", "ARGS:"]);
});
test("L11 런처 고르기 — 규칙 세션(stopRule) ∧ claude·codex·agy 만 새 런처 · 그 밖은 종전 런처(셸로 떨어짐) · 인자 수는 정수만", () => {
  const isNew = (a: string[]) => a[2].includes("quick_sec");
  for (const k of ["claude", "codex", "antigravity"]) assert.ok(isNew(harnessLaunchArgv(k, ["x"], "linux", { stopRule: true })), k);
  assert.deepEqual([...STOP_RULE_HARNESSES].sort(), ["antigravity", "claude", "codex"]);
  for (const k of ["grok", "opencode"]) assert.ok(!isNew(harnessLaunchArgv(k, ["x"], "linux", { stopRule: true })), k);
  assert.ok(!isNew(harnessLaunchArgv("claude", ["x"], "linux")), "규칙 밖(셀프호스트·위탁)");
  assert.equal(harnessLaunchArgv("claude", ["x", "--resume", "c"], "linux", { stopRule: true, resumeArgc: 2 })[6], "2");
  for (const bad of [-1, 1.5, Number.NaN, undefined]) assert.equal(harnessLaunchArgv("claude", ["x"], "linux", { stopRule: true, resumeArgc: bad })[6], "0", String(bad));
  //  윈도우는 런처를 씌우지 않는다(종전 그대로 — raw argv)
  assert.deepEqual(harnessLaunchArgv("claude", ["claude"], "win32", { stopRule: true, resumeArgc: 0 }), ["claude"]);
});

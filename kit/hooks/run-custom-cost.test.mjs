#!/usr/bin/env node
// run-custom 러너 비용 사양테스트(#5034) — 실행 단위(스레드·프로세스) · 시드 훅 묶음 · 시간 예산 · 훅 목록 재사용.
//  사양·엣지 표는 이 파일의 절 머리(§R·§Y·§Z·§T)와 runbooks/hooks.ko.md §1.5 «비용».
//  실행: node scripts/run-tests.mjs run-custom (하네스는 run-custom.test.mjs 와 같은 kit/testlib/run-custom-harness.mjs).
//
//  왜(2026-10-26 실측, 중앙 r8g 2 vCPU 노드): 세션 12개가 노드를 포화시키자 UserPromptSubmit 러너가 평시 3~5초에서
//   26~32초로 늘어 하네스 상한 30초에 통째로 취소됐다(모아 둔 맥락 주입까지 버려짐). 러너가 훅마다 node 프로세스를
//   새로 띄우는 비용(훅 하나 CPU 50~64ms)이 Bash 한 번에 9개씩 쌓였고, 프롬프트마다 목록을 다시 받고 훅을 하나씩 돌렸다.
//  ⚠ 여기 시험 훅의 «어디서 돌았나» 는 훅이 스스로 말한다(worker_threads.isMainThread) — 러너 내부 상태를 보지 않는다.
//  ⚠ 혼자 돈다 — Z1(예산 근처에서 끝남)·R8(곧 끝남)·R17(끊긴 스레드가 멈춤)이 벽시계 마감을 단언한다. 그 마감이 곧 사양이라
//   상한을 늘려 덮지 않는다(scripts/test-runner-schedule.mjs).
// @lively-test exclusive
import { rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  RUNNER, HOME, ENV, ok, bad, finish, sha256, run, decisionOf, dbg, decide,
  UPS, wDir, sleepSrc, sayHook, meet, readLog,
} from "../testlib/run-custom-harness.mjs";

// ── §R 실행 단위(#5034) — 스레드 기본은 제품 시드 훅만, 직접 만든 훅은 본문 표식이 있을 때만 · 스레드에서 다르게 도는 훅은 프로세스 ──
//  어디서 돌았나는 훅이 스스로 말하게 한다(worker_threads.isMainThread — 스레드면 false, 별도 프로세스면 true).
const whereHook = (tag, pre = "") => pre + `process.stdout.write(${JSON.stringify(tag + ":")} + require("node:worker_threads").isMainThread + " ");\n`;
const noBudget = { LIVELY_HOOK_EVENT_BUDGET_MS: "0" };
// R1·R1b·R1c·R4·R5a·R5b·R6: 시드 → 스레드 · 직접 만든 훅 → 프로세스(본문에 worker 표식이 있으면 스레드) · 시드여도 본문 표식 process
//  → 프로세스 · 자식 프로세스 API → 프로세스(주석에만 있으면 스레드) · fd 직접 쓰기 → 프로세스
{
  const r = run("UserPromptSubmit", [
    { id: "r1-seed", seed: true, src: whereHook("R1") },
    { id: "r1b-custom", src: whereHook("R1B") },
    { id: "r1c-optin", src: whereHook("R1C", "// lively-hook-runtime: worker\n") },
    { id: "r4-pragma", seed: true, src: whereHook("R4", "// lively-hook-runtime: process\n") },
    { id: "r5a-child", seed: true, src: whereHook("R5A", 'const cp = require("node:child_process"); void cp;\n') },
    { id: "r5b-comment", seed: true, src: whereHook("R5B", "// child_process 는 이 주석에만 있다 — execFileSync(\n") },
    { id: "r6-fd", seed: true, src: whereHook("R6", 'require("node:fs").writeSync(1, "");\n') },
  ], { payload: UPS });
  const o = r.stdout;
  r.status === 0 && o.includes("R1:false") ? ok("R1 제품 시드 훅은 설정이 없으면 러너 안의 스레드에서 돈다") : bad("R1 시드 기본 스레드", dbg(r));
  o.includes("R1B:true") ? ok("R1b 직접 만든 훅은 기본으로 프로세스로 돈다") : bad("R1b 직접 만든 훅 기본 프로세스", dbg(r));
  o.includes("R1C:false") ? ok("R1c 직접 만든 훅도 본문에 lively-hook-runtime: worker 가 있으면 스레드로 돈다") : bad("R1c 본문 worker 표식", dbg(r));
  o.includes("R4:true") ? ok("R4 본문에 lively-hook-runtime: process 가 있으면 시드여도 프로세스로 돈다") : bad("R4 본문 process 표식", dbg(r));
  o.includes("R5A:true") ? ok("R5a 자식 프로세스 API 를 쓰는 훅은 시드여도 프로세스로 돈다") : bad("R5a child_process", dbg(r));
  o.includes("R5B:false") ? ok("R5b 그 낱말이 주석 줄에만 있으면 스레드로 돈다") : bad("R5b 주석은 무시", dbg(r));
  o.includes("R6:true") ? ok("R6 fd 를 직접 쓰는 훅은 프로세스로 돈다") : bad("R6 fd 직접 쓰기", dbg(r));
}
// R1d: 이 머신이 LIVELY_HOOK_RUNTIME=worker 면 직접 만든 훅도 스레드로 돈다.
{
  const r = run("UserPromptSubmit", [{ id: "r1d-machine", src: whereHook("R1D") }], { payload: UPS, env: { LIVELY_HOOK_RUNTIME: "worker" } });
  r.status === 0 && r.stdout.includes("R1D:false") ? ok("R1d LIVELY_HOOK_RUNTIME=worker 면 이 머신의 직접 만든 훅도 스레드로 돈다") : bad("R1d 머신 worker", dbg(r));
}
// R16: 스레드에선 다르게 도는 모양은 시드여도 프로세스로 — 모양마다 훅 하나(실행은 안 되게 if (false) 로 감싼 것도 있다).
//  주석 «줄» 에만 있는 것은 스레드 · fd 10 같은 0~2 밖의 숫자는 스레드 · 정규식 리터럴의 «/*» 뒤 코드도 본다.
{
  const PROC = {
    wf1: 'if (false) require("node:fs").writeFileSync(1, "");',
    af2: 'if (false) require("node:fs").appendFileSync(2, "");',
    rf0: 'if (false) require("node:fs").readFileSync(0, "utf8");',
    cl1: 'if (false) require("node:fs").closeSync(1);',
    ws1: 'if (false) { const { WriteStream } = require("node:tty"); new WriteStream(1); }',
    fdk: 'const o = { fd: 1 }; void o;',
    dev: 'const p = "/dev/stdout"; void p;',
    prc: 'const p = "/proc/self/fd/1"; void p;',
    sfd: 'void process.stdout.fd;',
    chd: 'if (false) process.chdir("/");',
    umk: 'if (false) process.umask(0o22);',
    abt: 'if (false) process.abort();',
    kil: 'if (false) process.kill(process.pid, 0);',
    mmd: 'if (false) void process.mainModule;',
    cls: 'if (false) require("node:cluster");',
    efs: 'const execFileSync = () => 0; if (false) execFileSync("x");',
    // 정규식 리터럴의 «/*» 뒤에 자식 프로세스 사용 — 이 훅은 모듈 종류 판정(moduleExt)도 그 «/*» 에 속아 .mjs 로 도니
    //  require 대신 CJS·ESM 어디서나 되는 process.getBuiltinModule 로 쓴다(그쪽은 이 시험의 대상이 아니다).
    rgx: 'const b = "u/".replace(/\\/*$/, ""); void b;\nconst cp = process.getBuiltinModule("node:child_process"); void cp;\n'
      + 'process.stdout.write("R16rgx:" + process.getBuiltinModule("node:worker_threads").isMainThread + " ");',
  };
  const WORK = {
    cmt: '// fs.writeFileSync(1, x) · /dev/stdout · process.chdir( · require.main · child_process\n/* execFileSync(\n * spawnSync(\n */',
    fd10: 'const write = (a) => a; write(10);',
  };
  const hooks = [...Object.entries(PROC), ...Object.entries(WORK)].map(([k, pre]) => ({ id: `r16-${k}`, seed: true, src: k === "rgx" ? pre + "\n" : whereHook(`R16${k}`, pre + "\n") }));
  const r = run("UserPromptSubmit", hooks, { payload: UPS, timeoutMs: 60000 });
  const miss = [...Object.keys(PROC).filter((k) => !r.stdout.includes(`R16${k}:true`)), ...Object.keys(WORK).filter((k) => !r.stdout.includes(`R16${k}:false`))];
  r.status === 0 && !miss.length
    ? ok(`R16 스레드에서 다르게 도는 모양 ${Object.keys(PROC).length}종은 프로세스로, 주석 줄·0~2 밖 fd 는 스레드로 간다`)
    : bad("R16 분류 표", `빗나간 것=${miss.join(",")} ${dbg(r)}`);
}
// R2: 조직 실행 방식이 process 면 시드도 전부 프로세스.
{
  const r = run("UserPromptSubmit", [{ id: "r2-org", seed: true, src: whereHook("R2") }], { payload: UPS, runtime: "process" });
  r.status === 0 && r.stdout.includes("R2:true") ? ok("R2 조직 실행 방식이 process 면 훅은 프로세스로 돈다") : bad("R2 조직 되돌리기", dbg(r));
}
// R3: 이 머신 env 로 되돌린다.
{
  const r = run("UserPromptSubmit", [{ id: "r3-env", seed: true, src: whereHook("R3") }], { payload: UPS, env: { LIVELY_HOOK_RUNTIME: "process" } });
  r.status === 0 && r.stdout.includes("R3:true") ? ok("R3 LIVELY_HOOK_RUNTIME=process 면 이 머신의 훅은 프로세스로 돈다") : bad("R3 머신 되돌리기", dbg(r));
}
// R12: 조직 실행 방식 칸이 모르는 값이면 기본(스레드) — 잡값이 «프로세스로 되돌림» 으로 읽히지 않는다.
{
  const r = run("UserPromptSubmit", [{ id: "r12-junk", seed: true, src: whereHook("R12") }], { payload: UPS, runtime: "banana" });
  r.status === 0 && r.stdout.includes("R12:false") ? ok("R12 실행 방식 칸이 모르는 값이면 기본(스레드)") : bad("R12 잡값", dbg(r));
}
// R7: 스레드에서도 stdin 으로 입력 전체를 받는다(200KB — 러너가 읽는 상한 256KB 안).
{
  const prompt = "P".repeat(200 * 1024) + "END7";
  const src = 'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; });\n'
    + 'process.stdin.on("end", () => { const p = JSON.parse(d).prompt; process.stdout.write("R7:" + p.length + ":" + p.endsWith("END7") + " "); });\n';
  const r = run("UserPromptSubmit", [{ id: "r7-stdin", seed: true, src: whereHook("R7W") + src }], { payload: { session_id: "s1", prompt } });
  r.status === 0 && r.stdout.includes("R7W:false") && r.stdout.includes(`R7:${prompt.length}:true`)
    ? ok("R7 스레드에서도 훅이 stdin 으로 입력 전체를 받는다")
    : bad("R7 스레드 stdin", dbg({ ...r, stdout: r.stdout.slice(0, 300) }));
}
// R8: stdin 을 안 읽고 exitCode 만 정한 훅도 곧 끝난다(상한 10초까지 매달리지 않는다) · 0 아닌 종료는 크래시로 드러난다.
{
  const t0 = Date.now();
  const r = run("UserPromptSubmit", [{ id: "r8-code", seed: true, timeout_sec: 10, src: "process.exitCode = 3;\n" }], { payload: UPS });
  const ms = Date.now() - t0;
  r.status === 0 && ms < 4000 && r.stderr.includes("[lively] hook 'r8-code' crash exit=3")
    ? ok(`R8 stdin 을 안 읽은 훅도 곧 끝나고 종료코드가 드러난다(${ms}ms)`)
    : bad("R8 stdin 안 읽는 훅", `${dbg(r)} ms=${ms}`);
}
// R9: 출력 직후 process.exit(0) 해도 출력이 잘리지 않는다.
{
  const src = 'process.stdout.write("a".repeat(48 * 1024) + "END9"); process.exit(0);\n';
  const r = run("UserPromptSubmit", [{ id: "r9-flush", seed: true, src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("a".repeat(48 * 1024) + "END9")
    ? ok("R9 출력 직후 exit 해도 출력이 전부 전달된다")
    : bad("R9 출력 보존", dbg({ ...r, stdout: r.stdout.slice(-80) }));
}
// R10: 스레드 훅의 stderr 가 출력 상한(4MB)을 넘으면 실패로 드러나고 이웃 출력은 그대로 전달된다.
{
  const flood = "for (let i = 0; i < 5; i++) process.stderr.write(Buffer.alloc(1024 * 1024, 120));\n";
  const r = run("UserPromptSubmit", [
    { id: "r10-flood", sort: 1, seed: true, timeout_sec: 20, src: flood },
    { id: "r10-ok", sort: 1, seed: true, src: sayHook("R10-SURVIVOR ") },
  ], { payload: UPS, concurrent: true, timeoutMs: 30000 });
  r.status === 0 && r.stdout.includes("R10-SURVIVOR") && r.stderr.includes("[lively] hook 'r10-flood'")
    ? ok("R10 스레드 훅이 출력 상한을 넘기면 실패로 드러나고 이웃 출력은 전달된다")
    : bad("R10 스레드 출력 상한", dbg({ ...r, stderr: r.stderr.slice(-600) }));
}
// R11: 스레드 훅도 러너가 고른 env 를 본다 — 자기 상한(LIVELY_HOOK_TIMEOUT_MS).
{
  const src = 'process.stdout.write("R11:" + process.env.LIVELY_HOOK_TIMEOUT_MS + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r11-env", seed: true, timeout_sec: 7, src: whereHook("R11W") + src }], { payload: UPS, env: noBudget });
  r.status === 0 && r.stdout.includes("R11W:false") && /R11:7000\b/.test(r.stdout)
    ? ok("R11 스레드 훅도 러너가 실은 env(자기 상한)를 본다")
    : bad("R11 스레드 env", dbg(r));
}

// R13: 스레드에서도 process.argv[1] 은 훅 자기 파일이다 — 자기 경로를 쓰는 훅(A9·A10 이 그 모양)이 엉뚱한 자리(cwd)에 쓰지 않는다.
{
  const src = 'const path = require("node:path"); const a = process.argv[1] || "";\n'
    + 'process.stdout.write("R13:" + (path.isAbsolute(a) && path.basename(a).startsWith("lively-hook-")) + ":" + process.argv.length + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r13-argv", seed: true, src: whereHook("R13W") + src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R13W:false") && /R13:true:2\b/.test(r.stdout)
    ? ok("R13 스레드에서도 process.argv 는 [node, 훅 파일] 이다")
    : bad("R13 스레드 argv", dbg(r));
}
// R14: «직접 실행일 때만» 도는 관용구(require.main === module)를 쓴 훅도 프로세스 때처럼 본문이 돈다.
{
  const src = 'const fs = require("node:fs"); void fs;\nif (require.main === module) process.stdout.write("R14-MAIN ");\n';
  const r = run("UserPromptSubmit", [{ id: "r14-main", seed: true, src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R14-MAIN") ? ok("R14 require.main === module 관용구를 쓴 훅도 본문이 돈다") : bad("R14 require.main", dbg(r));
}

// R15: ESM 훅이 require 를 쓰면 스레드에서도 프로세스 때처럼 죽는다 — 부트스트랩의 CJS 전역이 훅에 새지 않는다.
{
  const src = 'import os from "node:os"; void os;\nprocess.stdout.write("R15:" + typeof require + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r15-leak", seed: true, src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R15:undefined")
    ? ok("R15 스레드의 CJS 전역(require 등)이 ESM 훅에 새지 않는다")
    : bad("R15 전역 누수", dbg(r));
}

// R17: 상한에 끊긴 스레드는 정말 멈춘다(terminate) — 끊긴 뒤에도 돌면 러너가 다음 훅을 도는 동안 부작용을 계속 낸다.
//  틱 훅은 1초에 끊기고 다음 묶음이 3초를 더 돈다 — 끊긴 스레드가 살아 있으면 틱이 그 3초 동안에도 쌓인다.
{
  const d = wDir("r17"); const log = join(d, "ticks.log");
  const tick = `const fs = require("node:fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(log)}, Date.now() + "\\n"), 50);\n`;
  const r = run("UserPromptSubmit", [
    { id: "r17-tick", sort: 1, seed: true, timeout_sec: 1, src: tick },
    { id: "r17-later", sort: 2, seed: true, timeout_sec: 10, src: sleepSrc(3000) + sayHook("R17-LATER ") },
  ], { payload: UPS, env: noBudget, timeoutMs: 30000 });
  const ts = (() => { try { return readFileSync(log, "utf8").trim().split("\n").map(Number); } catch { return []; } })();
  const span = ts.length ? ts[ts.length - 1] - ts[0] : -1;
  r.status === 0 && r.stdout.includes("R17-LATER") && ts.length > 3 && span < 1800
    ? ok(`R17 상한에 끊긴 스레드는 멈춘다(틱 ${ts.length}개 · 첫 틱부터 마지막 틱까지 ${span}ms)`)
    : bad("R17 끊긴 스레드가 계속 돈다", `ticks=${ts.length} span=${span} ${dbg(r)}`);
}
// R18: 실패한 훅을 다시 돌리는 것은 «이 확장자로는 파싱조차 안 된다» 가 확실할 때뿐이다 — PATH 에 node 가 없는 기계(번들 node 로
//  띄운 러너)에서 런타임 오류가 난 훅이 두 번 돌면 안 되고, 프로세스로 도는 훅도 그 기계에서 돌아야 한다. 둘 다 정확히 한 번.
//  훅은 CJS·ESM 어느 쪽으로도 돌게 쓴다(동적 import) — 확장자를 바꿔 다시 돌리면 그대로 두 번째 흔적이 남는다.
if (process.platform !== "win32") {
  const d = wDir("r18"); const a = join(d, "seed.log"); const b = join(d, "custom.log");
  const boom = (f) => `import("node:fs").then((fs) => { fs.appendFileSync(${JSON.stringify(f)}, "x\\n"); throw new Error("r18-boom"); });\n`;
  const r = run("UserPromptSubmit", [
    { id: "r18-seed", sort: 1, seed: true, src: boom(a) },
    { id: "r18-custom", sort: 2, src: boom(b) },
  ], { payload: UPS, env: { ...noBudget, PATH: "" } });
  const n = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  r.status === 0 && n(a) === 1 && n(b) === 1
    ? ok("R18 PATH 에 node 가 없어도 실패한 훅은 정확히 한 번 돈다(스레드 훅·프로세스 훅 둘 다)")
    : bad("R18 실패 훅 재실행", `seed=${n(a)} custom=${n(b)} ${dbg(r)}`);
} else ok("R18 (윈도우는 PATH 를 비우는 이 시험을 건너뛴다)");

// ── §Y 묶음 — 제품 시드 훅은 조직 설정 없이도 같은 sort 끼리 겹친다(#5034) ──
// Y1: 시드 둘 · 같은 sort · 설정 없음 → 겹친다(둘 다 상대를 본다).
{
  const d = wDir("y1");
  const r = run("UserPromptSubmit", [
    { id: "y1-p", sort: 3, seed: true, timeout_sec: 10, src: meet(d, "p", "q", 1500) },
    { id: "y1-q", sort: 3, seed: true, timeout_sec: 10, src: meet(d, "q", "p", 1500) },
  ], { payload: UPS });
  r.status === 0 && r.stdout.includes("p:SAW") && r.stdout.includes("q:SAW")
    ? ok("Y1 같은 sort 의 시드 훅은 조직 설정이 없어도 겹쳐 돈다")
    : bad("Y1 시드 동시", dbg(r));
}
// Y2: 직접 만든 훅(seed:false) 둘 · 같은 sort · 설정 없음 → 안 겹친다.
{
  const d = wDir("y2");
  const r = run("UserPromptSubmit", [
    { id: "y2-p", sort: 3, seed: false, timeout_sec: 10, src: meet(d, "p", "q", 600) },
    { id: "y2-q", sort: 3, seed: false, timeout_sec: 10, src: meet(d, "q", "p", 600) },
  ], { payload: UPS });
  r.status === 0 && r.stdout.includes("p:ALONE") && r.stdout.includes("q:SAW")
    ? ok("Y2 직접 만든 훅은 조직 설정 전에는 같은 sort 여도 겹치지 않는다")
    : bad("Y2 직접 훅 직렬", dbg(r));
}
// Y3: 시드·직접·시드(같은 sort) — 직접 만든 훅은 앞뒤 시드와 겹치지 않고 순서는 받은 그대로다.
{
  const d = wDir("y3"); const log = join(d, "order.log");
  const mark = (id) => `require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(id + "\n")});\n`;
  const r = run("UserPromptSubmit", [
    { id: "y3-a", sort: 3, seed: true, timeout_sec: 10, src: mark("a") + meet(d, "a", "b", 800) },
    { id: "y3-c", sort: 3, seed: false, timeout_sec: 10, src: mark("c") },
    { id: "y3-b", sort: 3, seed: true, timeout_sec: 10, src: mark("b") + meet(d, "b", "a", 800) },
  ], { payload: UPS });
  readLog(log) === "a,c,b" && r.stdout.includes("a:ALONE")
    ? ok("Y3 직접 만든 훅은 앞뒤 시드 훅과 겹치지 않고 받은 순서대로 돈다")
    : bad("Y3 시드 사이의 직접 훅", `order=${readLog(log)} ${dbg(r)}`);
}
// Y4: sort 가 다른 시드 훅은 겹치지 않는다(작은 sort 먼저).
{
  const d = wDir("y4");
  const r = run("UserPromptSubmit", [
    { id: "y4-p", sort: 1, seed: true, timeout_sec: 10, src: meet(d, "p", "q", 600) },
    { id: "y4-q", sort: 2, seed: true, timeout_sec: 10, src: meet(d, "q", "p", 600) },
  ], { payload: UPS });
  r.status === 0 && r.stdout.includes("p:ALONE") && r.stdout.includes("q:SAW")
    ? ok("Y4 sort 가 다른 시드 훅은 겹치지 않는다")
    : bad("Y4 시드 sort 경계", dbg(r));
}

// ── §Z 시간 예산(#5034) — UserPromptSubmit·SessionStart 는 예산 안에서 끝내고 모은 출력을 싣는다 ──
// Z1: 예산을 넘기면 남은 훅은 시작하지 않는다(부작용 0) · 앞에서 모은 출력은 전달된다 · 러너는 예산 근처에서 끝난다.
{
  const d = wDir("z1"); const marker = join(d, "c-ran");
  const t0 = Date.now();
  const r = run("UserPromptSubmit", [
    { id: "z1-a", sort: 1, src: sayHook("Z1-A ") },
    { id: "z1-b", sort: 2, timeout_sec: 10, src: sleepSrc(4000) + sayHook("Z1-B ") },
    { id: "z1-c", sort: 3, src: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n` + sayHook("Z1-C ") },
  ], { payload: UPS, env: { LIVELY_HOOK_EVENT_BUDGET_MS: "2500" } });
  const ms = Date.now() - t0;
  r.status === 0 && r.stdout.includes("Z1-A") && !r.stdout.includes("Z1-B") && !existsSync(marker) && ms < 4500
    ? ok(`Z1 예산을 넘기면 남은 훅은 돌지 않고 모은 출력은 전달된다(${ms}ms)`)
    : bad("Z1 예산 초과", `marker=${existsSync(marker)} ms=${ms} ${dbg(r)}`);
  r.stderr.includes("[lively] hook 'z1-c' budget")
    ? ok("Z1b 예산 때문에 건너뛴 훅은 진단 채널에 드러난다")
    : bad("Z1b 건너뜀 드러내기", dbg(r));
  // 예산이 줄인 상한에 끊긴 훅(z1-b, 제 상한은 10초)은 훅 탓(timeout)이 아니라 예산 탓(budget)이다 — 게이트웨이에 훅 실패로 안 올린다.
  r.stderr.includes("[lively] hook 'z1-b' budget") && !r.stderr.includes("[lively] hook 'z1-b' timeout")
    ? ok("Z1c 예산이 줄인 상한에 끊긴 훅은 timeout 이 아니라 budget 으로 드러난다")
    : bad("Z1c 줄인 상한의 사유", dbg(r));
}
// Z2: 예산 아래에서 도는 훅의 상한은 남은 예산으로 준다 — 훅이 보는 LIVELY_HOOK_TIMEOUT_MS 도 그 값이다.
{
  const src = 'process.stdout.write("Z2:" + process.env.LIVELY_HOOK_TIMEOUT_MS + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "z2-cap", timeout_sec: 10, src }], { payload: UPS, env: { LIVELY_HOOK_EVENT_BUDGET_MS: "3000" } });
  const m = /Z2:(\d+)/.exec(r.stdout); const v = m ? Number(m[1]) : NaN;
  r.status === 0 && v > 0 && v <= 3000
    ? ok(`Z2 훅의 상한이 남은 예산으로 줄어든다(${v}ms ≤ 3000)`)
    : bad("Z2 상한 줄이기", dbg(r));
}
// Z3: PreToolUse 에는 예산이 없다 — 막는 훅을 예산 때문에 건너뛰지 않는다. 예산을 바닥(1ms)으로 두면 예산이 걸리는 순간
//  모든 훅을 건너뛰므로(Z5) 결정이 나왔다는 것만으로 «이 이벤트엔 예산이 없다» 가 드러난다.
{
  const r = run("PreToolUse", [{ id: "z3-deny", sort: 1, src: decide({ decision: "deny", reason: "Z3" }) }],
    { env: { LIVELY_HOOK_EVENT_BUDGET_MS: "1" } });
  decisionOf(r) === "deny" ? ok("Z3 PreToolUse 는 예산과 무관하게 결정을 전달한다") : bad("Z3 결정 이벤트 예산 없음", dbg(r));
}
// Z4 (경계): 예산 0 은 «예산 없음» 이다 — «0ms 예산» 으로 읽으면 모든 훅을 건너뛰어(Z5) 두 출력이 다 빠진다.
{
  const r = run("UserPromptSubmit", [
    { id: "z4-a", sort: 1, src: sayHook("Z4-A ") },
    { id: "z4-b", sort: 2, src: sayHook("Z4-LATE ") },
  ], { payload: UPS, env: noBudget });
  r.status === 0 && r.stdout.includes("Z4-A") && r.stdout.includes("Z4-LATE") ? ok("Z4 예산 0 이면 예산 없이 끝까지 돈다") : bad("Z4 예산 0", dbg(r));
}

// Z5 (경계): 예산이 처음부터 묶음 하나를 시작할 여유보다 작으면 어떤 훅도 시작하지 않는다 — 부작용 0 · exit 0.
//  훅은 첫 줄에서 표식을 남긴다 — 잠깐이라도 시작되면 남으므로 «짧은 상한으로 시작했다 끊김» 과 «시작 안 함» 이 갈린다.
{
  const d = wDir("z5"); const marker = join(d, "ran");
  const r = run("UserPromptSubmit", [
    { id: "z5-a", sort: 1, timeout_sec: 10, src: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n` + sayHook("Z5-A ") },
  ], { payload: UPS, env: { LIVELY_HOOK_EVENT_BUDGET_MS: "250" } });
  r.status === 0 && !existsSync(marker) && !r.stdout.includes("Z5-A")
    ? ok("Z5 예산이 처음부터 모자라면 어떤 훅도 시작하지 않는다(부작용 0)")
    : bad("Z5 시작 전 예산 소진", `marker=${existsSync(marker)} ${dbg(r)}`);
}

// Z6: 예산은 하네스가 러너를 끊는 상한보다 앞선다 — 코덱스 UserPromptSubmit 상한은 15초라 예산은 10초(훅이 보는 상한 ≤ 10초).
//  상한을 모르고 20초를 쓰면 코덱스가 15초에 러너를 통째로 끊어 사고 때와 같은 «모은 맥락 전부 유실» 이 난다.
{
  const src = 'process.stdout.write("Z6:" + process.env.LIVELY_HOOK_TIMEOUT_MS + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "z6-codex", timeout_sec: 30, src }], { payload: UPS, env: { LIVELY_HARNESS: "codex" } });
  const v = Number((/Z6:(\d+)/.exec(r.stdout) || [])[1]);
  r.status === 0 && v > 5000 && v <= 10000 ? ok(`Z6 코덱스 맥락 이벤트 예산은 하네스 상한(15초) 안이다(훅 상한 ${v}ms)`) : bad("Z6 하네스별 예산", dbg(r));
}
// Z7: 클로드 SessionStart 예산은 하네스 기본 상한 60초에 맞춘다(55초) — 더 짧게 잡으면 timeout_sec 120 인 project-pull 같은
//  훅을, 하네스라면 60초까지 기다려 줬을 것을 일찍 자른다.
{
  const src = 'process.stdout.write("Z7:" + process.env.LIVELY_HOOK_TIMEOUT_MS + " ");\n';
  const r = run("SessionStart", [{ id: "z7-start", timeout_sec: 120, src }], { payload: { session_id: "s1", source: "startup" } });
  const v = Number((/Z7:(\d+)/.exec(r.stdout) || [])[1]);
  r.status === 0 && v > 50000 && v <= 55000 ? ok(`Z7 클로드 SessionStart 예산은 하네스 상한 60초에 맞춘다(훅 상한 ${v}ms)`) : bad("Z7 SessionStart 예산", dbg(r));
}

// ── §T 훅 목록 재사용(#5034) — 같은 세션이 방금 받은 목록이면 게이트웨이에 다시 묻지 않는다 ──
//  가짜 게이트웨이를 세워 «몇 번 물었나» 를 센다(부작용으로 단언). 러너는 비동기로 띄운다 — 같은 프로세스의 서버가 답해야 한다.
const TT_LIST = join(HOME, ".lively", "hook-list-cache");
const HCFG = join(HOME, ".lively", "hooks-config.json");
function runAsync(event, payload, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [RUNNER, event], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (b) => { stdout += b; }); c.stderr.on("data", (b) => { stderr += b; });
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.on("close", (status, signal) => { clearTimeout(t); resolve({ status, signal, stdout, stderr }); });
    c.stdin.end(JSON.stringify(payload));
  });
}
// 가짜 게이트웨이 — 기본은 «어디서 돌았나» 를 말하는 시드 훅 하나 · 조직 실행 방식 worker. 실패 보고(hook-report) 몸통도 받아 적는다.
async function withGateway(fn, { runtime = "worker", hooks } = {}) {
  const hits = []; const reports = [];
  const list = (hooks || [{ id: "t-srv", sort: 0, seed: true, src: whereHook("TSRV") }]).map((h) => ({
    id: h.id, event: "UserPromptSubmit", matcher: null, timeout_sec: h.timeout_sec ?? 5, sort: h.sort ?? 0, seed: h.seed === true,
    source_code: h.src, content_hash: sha256(h.src),
  }));
  const body = JSON.stringify({ hooks: list, relay_decisions: ["deny", "ask", "defer"], concurrent: false, runtime });
  const srv = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith("/api/ui/org/runner/hooks")) { res.writeHead(200, { "content-type": "application/json" }); res.end(body); return; }
    if (req.url.startsWith("/api/ui/org/runner/hook-report")) {
      let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { reports.push(b); res.writeHead(200); res.end("{}"); }); return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, () => hits.filter((u) => u.startsWith("/api/ui/org/runner/hooks")).length, reports); }
  finally { await new Promise((r) => srv.close(r)); }
}
const liveEnv = (gw, extra = {}) => ({ ...ENV, LIVELY_TOKEN: "tok-t", LIVELY_GATEWAY_URL: gw, LIVELY_SESSION_ID: "box-t-1", ...extra });
async function twice(extraA, extraB, between = 0, gwOpts = {}) {
  rmSync(TT_LIST, { recursive: true, force: true });
  return withGateway(async (gw, count, reports) => {
    const a = await runAsync("UserPromptSubmit", UPS, liveEnv(gw, extraA));
    if (between) await new Promise((r) => setTimeout(r, between));
    const b = await runAsync("UserPromptSubmit", UPS, liveEnv(gw, extraB));
    return { a, b, n: count(), reports };
  }, gwOpts);
}
// T1: 같은 세션이 연속으로 부르면 한 번만 묻는다 — 둘째는 받아 둔 목록으로 돈다(가짜 게이트웨이의 시드 훅이 두 번 다 스레드로 돈 것도 본다).
{
  rmSync(HCFG, { force: true });
  const { a, b, n } = await twice({}, {});
  a.stdout.includes("TSRV:false") && b.stdout.includes("TSRV:false") && n === 1
    ? ok("T1 같은 세션이 방금 받은 목록이면 게이트웨이에 다시 묻지 않는다(1회)")
    : bad("T1 목록 재사용", `n=${n} a=${dbg(a)} b=${dbg(b)}`);
}
// T7: 조직의 되돌리기(runtime="process")는 게이트웨이에서 받은 목록에도, 그 목록을 재사용하는 둘째 실행에도 실린다 — 둘 다 프로세스.
{
  const { a, b, n } = await twice({}, {}, 0, { runtime: "process" });
  a.stdout.includes("TSRV:true") && b.stdout.includes("TSRV:true") && n === 1
    ? ok("T7 조직 되돌리기는 받은 목록과 재사용한 목록 모두에서 지켜진다(둘 다 프로세스)")
    : bad("T7 온라인 되돌리기", `n=${n} a=${dbg(a)} b=${dbg(b)}`);
}
// T2: 재사용 시간이 지나면 다시 묻는다.
{
  const ttl = { LIVELY_HOOK_LIST_TTL_MS: "300" };
  const { b, n } = await twice(ttl, ttl, 600);
  b.stdout.includes("TSRV") && n === 2 ? ok("T2 재사용 시간이 지나면 다시 묻는다") : bad("T2 재사용 만료", `n=${n} ${dbg(b)}`);
}
// T3: 세션이 다르면 묻는다.
{
  const { n } = await twice({ LIVELY_SESSION_ID: "box-t-a" }, { LIVELY_SESSION_ID: "box-t-b" });
  n === 2 ? ok("T3 다른 세션은 남의 목록을 재사용하지 않는다") : bad("T3 세션별 재사용", `n=${n}`);
}
// T4: 워크스페이스가 다르면 묻는다.
{
  const { n } = await twice({ LVLY_TENANT_SLUG: "ws-a" }, { LVLY_TENANT_SLUG: "ws-b" });
  n === 2 ? ok("T4 다른 워크스페이스는 목록을 재사용하지 않는다") : bad("T4 워크스페이스별 재사용", `n=${n}`);
}
// T5: 재사용 시간 0 이면 매번 묻는다(종전 동작).
{
  const z = { LIVELY_HOOK_LIST_TTL_MS: "0" };
  const { n } = await twice(z, z);
  n === 2 ? ok("T5 재사용 시간 0 이면 매번 묻는다") : bad("T5 재사용 끔", `n=${n}`);
}
// T6: 조직의 오프라인 유효기간이 0 이면 재사용하지 않는다 — 회수창을 넓히지 않는다.
{
  writeFileSync(HCFG, JSON.stringify({ hook_grace_ms: 0 }));
  const { n } = await twice({}, {});
  rmSync(HCFG, { force: true });
  n === 2 ? ok("T6 hook_grace_ms 가 재사용 시간보다 짧으면 그쪽을 따른다") : bad("T6 grace 우선", `n=${n}`);
}

// T8: 보고할 시간이 없던 실패는 스로틀 도장을 찍지 않는다 — 다음 실행이 그 크래시를 보고한다. 예산 탓(«budget»)은 보고하지 않는다.
//  첫 실행: 예산 1.5초 — 크래시 훅은 곧 죽고, 느린 훅이 예산 끝까지 잡아먹어 보고할 시간이 없다. 둘째 실행(같은 세션 · 받아 둔
//  목록 · 예산 기본): 크래시가 다시 나고 이번엔 보고된다. 도장을 먼저 찍었다면 둘째 보고가 스로틀(10분)에 막혀 0건이다.
{
  rmSync(join(HOME, ".lively", "hook-report-sent.json"), { force: true });
  const hooks = [
    { id: "t8-crash", sort: 1, seed: true, src: 'throw new Error("t8-boom");\n' },
    { id: "t8-slow", sort: 2, seed: true, timeout_sec: 10, src: sleepSrc(3000) },
  ];
  const { a, reports } = await twice({ LIVELY_HOOK_EVENT_BUDGET_MS: "1500" }, {}, 0, { hooks });
  const crashReports = reports.filter((b) => b.includes("t8-crash") && b.includes("crash"));
  a.stderr.includes("[lively] hook 't8-crash' crash") && crashReports.length === 1 && !reports.some((b) => b.includes("budget"))
    ? ok("T8 보고할 시간이 없던 크래시는 다음 실행이 보고한다(도장 없음) · «budget» 은 보고하지 않는다")
    : bad("T8 실패 보고", `reports=${JSON.stringify(reports).slice(0, 400)} a=${dbg(a)}`);
}

finish("run-custom-cost");

#!/usr/bin/env node
// run-custom 러너 비용 사양테스트(#5034) — 실행 단위(스레드·프로세스) · 시드 훅 묶음 · 시간 예산 · 훅 목록 재사용.
//  사양·엣지 표는 이 파일의 절 머리(§R·§Y·§Z·§T)와 runbooks/hooks.ko.md §1.5 «비용».
//  실행: node scripts/run-tests.mjs run-custom (하네스는 run-custom.test.mjs 와 같은 kit/testlib/run-custom-harness.mjs).
//
//  왜(2026-10-26 실측, 중앙 r8g 2 vCPU 노드): 세션 12개가 노드를 포화시키자 UserPromptSubmit 러너가 평시 3~5초에서
//   26~32초로 늘어 하네스 상한 30초에 통째로 취소됐다(모아 둔 맥락 주입까지 버려짐). 러너가 훅마다 node 프로세스를
//   새로 띄우는 비용(훅 하나 CPU 50~64ms)이 Bash 한 번에 9개씩 쌓였고, 프롬프트마다 목록을 다시 받고 훅을 하나씩 돌렸다.
//  ⚠ 여기 시험 훅의 «어디서 돌았나» 는 훅이 스스로 말한다(worker_threads.isMainThread) — 러너 내부 상태를 보지 않는다.
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  RUNNER, HOME, ENV, ok, bad, finish, sha256, run, decisionOf, dbg, decide,
  UPS, wDir, sleepSrc, sayHook, meet, readLog,
} from "../testlib/run-custom-harness.mjs";

// ── §R 실행 단위(#5034) — 기본은 러너 안의 스레드, 스레드에서 다르게 도는 훅만 프로세스 ──
//  어디서 돌았나는 훅이 스스로 말하게 한다(worker_threads.isMainThread — 스레드면 false, 별도 프로세스면 true).
const whereHook = (tag, pre = "") => pre + `process.stdout.write(${JSON.stringify(tag + ":")} + require("node:worker_threads").isMainThread + " ");\n`;
const noBudget = { LIVELY_HOOK_EVENT_BUDGET_MS: "0" };
// R1·R4·R5a·R5b·R6: 설정 없음 → 스레드 · 본문 표식 → 프로세스 · 자식 프로세스 API → 프로세스(주석에만 있으면 스레드) · fd 직접 쓰기 → 프로세스
{
  const r = run("UserPromptSubmit", [
    { id: "r1-plain", src: whereHook("R1") },
    { id: "r4-pragma", src: whereHook("R4", "// lively-hook-runtime: process\n") },
    { id: "r5a-child", src: whereHook("R5A", 'const cp = require("node:child_process"); void cp;\n') },
    { id: "r5b-comment", src: whereHook("R5B", "// child_process 는 이 주석에만 있다 — execFileSync(\n") },
    { id: "r6-fd", src: whereHook("R6", 'require("node:fs").writeSync(1, "");\n') },
  ], { payload: UPS });
  const o = r.stdout;
  r.status === 0 && o.includes("R1:false") ? ok("R1 설정이 없으면 훅은 러너 안의 스레드에서 돈다") : bad("R1 기본 스레드", dbg(r));
  o.includes("R4:true") ? ok("R4 본문에 lively-hook-runtime: process 가 있으면 그 훅만 프로세스로 돈다") : bad("R4 본문 표식", dbg(r));
  o.includes("R5A:true") ? ok("R5a 자식 프로세스 API 를 쓰는 훅은 프로세스로 돈다") : bad("R5a child_process", dbg(r));
  o.includes("R5B:false") ? ok("R5b 그 낱말이 주석에만 있으면 스레드로 돈다") : bad("R5b 주석은 무시", dbg(r));
  o.includes("R6:true") ? ok("R6 fd 를 직접 쓰는 훅은 프로세스로 돈다") : bad("R6 fd 직접 쓰기", dbg(r));
}
// R2: 조직 실행 방식이 process 면 전부 프로세스.
{
  const r = run("UserPromptSubmit", [{ id: "r2-org", src: whereHook("R2") }], { payload: UPS, runtime: "process" });
  r.status === 0 && r.stdout.includes("R2:true") ? ok("R2 조직 실행 방식이 process 면 훅은 프로세스로 돈다") : bad("R2 조직 되돌리기", dbg(r));
}
// R3: 이 머신 env 로 되돌린다.
{
  const r = run("UserPromptSubmit", [{ id: "r3-env", src: whereHook("R3") }], { payload: UPS, env: { LIVELY_HOOK_RUNTIME: "process" } });
  r.status === 0 && r.stdout.includes("R3:true") ? ok("R3 LIVELY_HOOK_RUNTIME=process 면 이 머신의 훅은 프로세스로 돈다") : bad("R3 머신 되돌리기", dbg(r));
}
// R12: 조직 실행 방식 칸이 모르는 값이면 기본(스레드) — 잡값이 «프로세스로 되돌림» 으로 읽히지 않는다.
{
  const r = run("UserPromptSubmit", [{ id: "r12-junk", src: whereHook("R12") }], { payload: UPS, runtime: "banana" });
  r.status === 0 && r.stdout.includes("R12:false") ? ok("R12 실행 방식 칸이 모르는 값이면 기본(스레드)") : bad("R12 잡값", dbg(r));
}
// R7: 스레드에서도 stdin 으로 입력 전체를 받는다(200KB — 러너가 읽는 상한 256KB 안).
{
  const prompt = "P".repeat(200 * 1024) + "END7";
  const src = 'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; });\n'
    + 'process.stdin.on("end", () => { const p = JSON.parse(d).prompt; process.stdout.write("R7:" + p.length + ":" + p.endsWith("END7") + " "); });\n';
  const r = run("UserPromptSubmit", [{ id: "r7-stdin", src: whereHook("R7W") + src }], { payload: { session_id: "s1", prompt } });
  r.status === 0 && r.stdout.includes("R7W:false") && r.stdout.includes(`R7:${prompt.length}:true`)
    ? ok("R7 스레드에서도 훅이 stdin 으로 입력 전체를 받는다")
    : bad("R7 스레드 stdin", dbg({ ...r, stdout: r.stdout.slice(0, 300) }));
}
// R8: stdin 을 안 읽고 exitCode 만 정한 훅도 곧 끝난다(상한 10초까지 매달리지 않는다) · 0 아닌 종료는 크래시로 드러난다.
{
  const t0 = Date.now();
  const r = run("UserPromptSubmit", [{ id: "r8-code", timeout_sec: 10, src: "process.exitCode = 3;\n" }], { payload: UPS });
  const ms = Date.now() - t0;
  r.status === 0 && ms < 4000 && r.stderr.includes("[lively] hook 'r8-code' crash exit=3")
    ? ok(`R8 stdin 을 안 읽은 훅도 곧 끝나고 종료코드가 드러난다(${ms}ms)`)
    : bad("R8 stdin 안 읽는 훅", `${dbg(r)} ms=${ms}`);
}
// R9: 출력 직후 process.exit(0) 해도 출력이 잘리지 않는다.
{
  const src = 'process.stdout.write("a".repeat(48 * 1024) + "END9"); process.exit(0);\n';
  const r = run("UserPromptSubmit", [{ id: "r9-flush", src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("a".repeat(48 * 1024) + "END9")
    ? ok("R9 출력 직후 exit 해도 출력이 전부 전달된다")
    : bad("R9 출력 보존", dbg({ ...r, stdout: r.stdout.slice(-80) }));
}
// R10: 스레드 훅의 stderr 가 출력 상한(4MB)을 넘으면 실패로 드러나고 이웃 출력은 그대로 전달된다.
{
  const flood = "for (let i = 0; i < 5; i++) process.stderr.write(Buffer.alloc(1024 * 1024, 120));\n";
  const r = run("UserPromptSubmit", [
    { id: "r10-flood", sort: 1, timeout_sec: 20, src: flood },
    { id: "r10-ok", sort: 1, src: sayHook("R10-SURVIVOR ") },
  ], { payload: UPS, concurrent: true, timeoutMs: 30000 });
  r.status === 0 && r.stdout.includes("R10-SURVIVOR") && r.stderr.includes("[lively] hook 'r10-flood'")
    ? ok("R10 스레드 훅이 출력 상한을 넘기면 실패로 드러나고 이웃 출력은 전달된다")
    : bad("R10 스레드 출력 상한", dbg({ ...r, stderr: r.stderr.slice(-600) }));
}
// R11: 스레드 훅도 러너가 고른 env 를 본다 — 자기 상한(LIVELY_HOOK_TIMEOUT_MS).
{
  const src = 'process.stdout.write("R11:" + process.env.LIVELY_HOOK_TIMEOUT_MS + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r11-env", timeout_sec: 7, src: whereHook("R11W") + src }], { payload: UPS, env: noBudget });
  r.status === 0 && r.stdout.includes("R11W:false") && /R11:7000\b/.test(r.stdout)
    ? ok("R11 스레드 훅도 러너가 실은 env(자기 상한)를 본다")
    : bad("R11 스레드 env", dbg(r));
}

// R13: 스레드에서도 process.argv[1] 은 훅 자기 파일이다 — 자기 경로를 쓰는 훅(A9·A10 이 그 모양)이 엉뚱한 자리(cwd)에 쓰지 않는다.
{
  const src = 'const path = require("node:path"); const a = process.argv[1] || "";\n'
    + 'process.stdout.write("R13:" + (path.isAbsolute(a) && path.basename(a).startsWith("lively-hook-")) + ":" + process.argv.length + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r13-argv", src: whereHook("R13W") + src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R13W:false") && /R13:true:2\b/.test(r.stdout)
    ? ok("R13 스레드에서도 process.argv 는 [node, 훅 파일] 이다")
    : bad("R13 스레드 argv", dbg(r));
}
// R14: «직접 실행일 때만» 도는 관용구(require.main === module)를 쓴 훅도 프로세스 때처럼 본문이 돈다.
{
  const src = 'const fs = require("node:fs"); void fs;\nif (require.main === module) process.stdout.write("R14-MAIN ");\n';
  const r = run("UserPromptSubmit", [{ id: "r14-main", src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R14-MAIN") ? ok("R14 require.main === module 관용구를 쓴 훅도 본문이 돈다") : bad("R14 require.main", dbg(r));
}

// R15: ESM 훅이 require 를 쓰면 스레드에서도 프로세스 때처럼 죽는다 — 부트스트랩의 CJS 전역이 훅에 새지 않는다.
{
  const src = 'import os from "node:os"; void os;\nprocess.stdout.write("R15:" + typeof require + " ");\n';
  const r = run("UserPromptSubmit", [{ id: "r15-leak", src }], { payload: UPS });
  r.status === 0 && r.stdout.includes("R15:undefined")
    ? ok("R15 스레드의 CJS 전역(require 등)이 ESM 훅에 새지 않는다")
    : bad("R15 전역 누수", dbg(r));
}

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
async function withGateway(fn) {
  const hits = [];
  const src = sayHook("TSRV ");
  const body = JSON.stringify({ hooks: [{ id: "t-srv", event: "UserPromptSubmit", matcher: null, timeout_sec: 5, sort: 0, seed: false, source_code: src, content_hash: sha256(src) }],
    relay_decisions: ["deny", "ask", "defer"], concurrent: false, runtime: "worker" });
  const srv = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith("/api/ui/org/runner/hooks")) { res.writeHead(200, { "content-type": "application/json" }); res.end(body); return; }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, () => hits.filter((u) => u.startsWith("/api/ui/org/runner/hooks")).length); }
  finally { await new Promise((r) => srv.close(r)); }
}
const liveEnv = (gw, extra = {}) => ({ ...ENV, LIVELY_TOKEN: "tok-t", LIVELY_GATEWAY_URL: gw, LIVELY_SESSION_ID: "box-t-1", ...extra });
async function twice(extraA, extraB, between = 0) {
  rmSync(TT_LIST, { recursive: true, force: true });
  return withGateway(async (gw, count) => {
    const a = await runAsync("UserPromptSubmit", UPS, liveEnv(gw, extraA));
    if (between) await new Promise((r) => setTimeout(r, between));
    const b = await runAsync("UserPromptSubmit", UPS, liveEnv(gw, extraB));
    return { a, b, n: count() };
  });
}
// T1: 같은 세션이 연속으로 부르면 한 번만 묻는다 — 둘째는 받아 둔 목록으로 돈다(가짜 게이트웨이 훅이 실제로 돈 것도 본다).
{
  rmSync(HCFG, { force: true });
  const { a, b, n } = await twice({}, {});
  a.stdout.includes("TSRV") && b.stdout.includes("TSRV") && n === 1
    ? ok("T1 같은 세션이 방금 받은 목록이면 게이트웨이에 다시 묻지 않는다(1회)")
    : bad("T1 목록 재사용", `n=${n} a=${dbg(a)} b=${dbg(b)}`);
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

finish("run-custom-cost");

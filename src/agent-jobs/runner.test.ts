// 작업 컨테이너 판(부트 + 본체) — **진짜 노드 프로세스**로 돌려 부작용을 본다 (#4490).
//  가짜 게이트웨이(HTTP)가 boot·tick·result 를 받고, 가짜 하네스(노드 스크립트)가 stream-json 을 낸다. 판이 실제로 무엇을 불렀고
//  무엇을 하네스에 넘겼는지(stdin·argv·env·MCP 파일)를 그쪽 기록으로 단언한다. 행 번호(R1~R6)는 지식 agent-job-container-research-4490 엣지 표.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BOOT_SOURCE, RUNNER_SOURCE, MCP_CONFIG_PLACEHOLDER, JOB_BOOT_ENV, JOB_ID_ENV, TMUX_ARG_MAX, RUNNER_GATEWAY, claudeJobArgv } from "./runner.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvly-job-test-"));
const FAKE = path.join(tmp, "fake-harness.cjs");
//  가짜 하네스 — 받은 것(argv · env 일부 · stdin · MCP 파일 내용)을 기록 파일에 남기고, 모드대로 stream-json 을 낸다.
fs.writeFileSync(FAKE, `
const fs = require("fs");
const rec = process.env.FAKE_RECORD;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  const i = process.argv.indexOf("--mcp-config");
  const mcpFile = i > 0 ? process.argv[i + 1] : null;
  fs.writeFileSync(rec, JSON.stringify({
    argv: process.argv.slice(2), stdin, cwd: process.cwd(),
    env: { boot: process.env.${JOB_BOOT_ENV} ?? null, id: process.env.${JOB_ID_ENV} ?? null, extra: process.env.EXTRA ?? null },
    mcp: mcpFile && fs.existsSync(mcpFile) ? fs.readFileSync(mcpFile, "utf8") : null,
    mcpMode: mcpFile && fs.existsSync(mcpFile) ? (fs.statSync(mcpFile).mode & 0o777) : null,
  }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: "0a1b2c3d-0000-4000-8000-000000000001", model: "fake-model" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "일하는 중" }, { type: "tool_use", name: "Bash" }] } });
  process.stderr.write("fake stderr line\\n");
  if (process.env.FAKE_MODE === "hang") { setInterval(() => {}, 1000); return; }
  setTimeout(() => {
    out({ type: "result", subtype: "success", is_error: false, result: "끝난 답", num_turns: 2, duration_ms: 42, total_cost_usd: 0.01, usage: { input_tokens: 3 }, session_id: "0a1b2c3d-0000-4000-8000-000000000001" });
    process.exit(1);   // 답을 내고 1 로 끝나는 하네스도 있다 — 판은 종료코드를 그대로 보고한다
  }, 700);
});
`);

interface Seen {
  boot: number; ticks: Array<Record<string, unknown>>; results: Array<Record<string, unknown>>; auth: string[]; tickAt: number[]; resultAt: number[];
  /** 시작 실패 보고(#4829 boot-failed) — 비밀 · 본문. */
  failed: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
}

/** 가짜 게이트웨이 — 시나리오별 응답. */
async function gateway(o: {
  mode: "ok" | "hang"; timeoutMs: number; cancelAfterTicks?: number; resultFailFirst?: boolean; resultDelayMs?: number; record: string;
  /** 부트 200 의 본문을 이 글로(JSON 아님) · 판 본체 코드를 이것으로(곧바로 던지는 본체) · 시작 실패 보고에 답하지 않기 · 머리만 주고 멈추기. */
  bootRaw?: string; runnerCode?: string; failedHang?: boolean; failedStall?: boolean;
}): Promise<{ port: number; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = { boot: 0, ticks: [], results: [], auth: [], tickAt: [], resultAt: [], failed: [] };
  let resultCalls = 0;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.auth.push(`${req.url} ${req.headers.authorization}`);
      const json = (status: number, v: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/api/agent-jobs/1/boot") {
        seen.boot++;
        if (req.headers.authorization !== "Bearer BOOT-SECRET") return json(401, { error: "no" });
        if (o.bootRaw !== undefined) { res.writeHead(200, { "content-type": "text/html" }); res.end(o.bootRaw); return; }
        return json(200, {
          id: 1, secret: "CALLBACK-SECRET", code: o.runnerCode ?? RUNNER_SOURCE.replace(/port: 8080/, `port: ${port}`),
          argv: [process.execPath, FAKE, "--mcp-config", MCP_CONFIG_PLACEHOLDER, "--flag"],
          prompt: "프롬프트 — 한글과 \"따옴표\"\n둘째 줄", mcp: { mcpServers: { lively: { type: "http", url: "x" } } },
          env: { EXTRA: "1", FAKE_MODE: o.mode, FAKE_RECORD: o.record }, cwd: tmp,
          timeoutMs: o.timeoutMs, tickMs: 150, tailMax: 4000, resultMax: 1000, stderrMax: 500,
        });
      }
      if (req.url === "/api/agent-jobs/1/boot-failed") {
        seen.failed.push({ auth: req.headers.authorization, body: JSON.parse(body || "{}") });
        if (o.failedHang) return;   // 답하지 않는다 — 판은 5초 뒤 스스로 끝나야 한다
        if (o.failedStall) { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); return; }   // 머리만 주고 본문이 멈춘다
        return json(200, { ok: true });
      }
      if (req.url === "/api/agent-jobs/1/tick") {
        seen.ticks.push(JSON.parse(body || "{}"));
        seen.tickAt.push(Date.now());
        return json(200, { cancel: o.cancelAfterTicks !== undefined && seen.ticks.length >= o.cancelAfterTicks });
      }
      if (req.url === "/api/agent-jobs/1/result") {
        resultCalls++;
        seen.results.push(JSON.parse(body || "{}"));
        seen.resultAt.push(Date.now());
        if (o.resultFailFirst && resultCalls === 1) return json(503, { error: "busy" });
        if (o.resultDelayMs) { setTimeout(() => json(200, { ok: true }), o.resultDelayMs); return; }
        return json(200, { ok: true });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { port, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** 진짜 부트를 진짜 노드로 — 포트만 가짜 게이트웨이로 바꾼다(한 군데 — 배선 단언). */
function runBoot(port: number): Promise<number | null> {
  const src = BOOT_SOURCE.replace(/port:8080/, `port:${port}`);
  assert.notEqual(src, BOOT_SOURCE, "부트의 포트 자리를 못 찾았다(시험 배선)");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", src], { cwd: tmp, env: { ...process.env, [JOB_ID_ENV]: "1", [JOB_BOOT_ENV]: "BOOT-SECRET" }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    const kill = setTimeout(() => { p.kill("SIGKILL"); }, 30_000);
    p.on("close", (code) => { clearTimeout(kill); if (code !== 0) console.log(`  (부트 stderr: ${err.slice(0, 300)})`); resolve(code); });
  });
}

await t("R1 부트는 tmux 인자 상한 안 · 부트와 본체 둘 다 문법이 맞다 · 게이트웨이 주소는 루프백 8080", () => {
  assert.ok(BOOT_SOURCE.length <= TMUX_ARG_MAX, `부트 ${BOOT_SOURCE.length}자`);
  assert.doesNotThrow(() => new Function(BOOT_SOURCE));
  assert.doesNotThrow(() => new Function("job", "require", RUNNER_SOURCE));
  assert.deepEqual(RUNNER_GATEWAY, { host: "127.0.0.1", port: 8080 });
  assert.equal((RUNNER_SOURCE.match(/port: 8080/g) ?? []).length, 1);
  assert.equal((BOOT_SOURCE.match(/port:8080/g) ?? []).length, 1);
});

await t("R2 정상 — 박동 · 결과 한 번(답·대화 id·종료코드) · 프롬프트는 stdin · MCP 자리표는 0600 파일 · 부트 env 는 하네스에 안 간다", async () => {
  const record = path.join(tmp, "r2.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.boot, 1);
    assert.ok(g.seen.ticks.length >= 1, `박동 ${g.seen.ticks.length}`);
    assert.equal(g.seen.results.length, 1);
    const r = g.seen.results[0] as Record<string, any>;
    assert.equal(r.exit_code, 1);
    assert.equal(r.stopped, null);
    assert.equal(r.conversation_id, "0a1b2c3d-0000-4000-8000-000000000001");
    assert.equal(r.model, "fake-model");
    assert.equal(r.result.text, "끝난 답");
    assert.equal(r.result.is_error, false);
    assert.equal(r.result.cost_usd, 0.01);
    assert.match(r.tail, /일하는 중/);
    assert.match(r.tail, /▸ Bash/);
    assert.match(r.stderr_tail, /fake stderr line/);
    //  콜백은 부트 뒤 전부 콜백 비밀로 — 부트 비밀은 부트 한 번에만 실렸다.
    const after = g.seen.auth.filter((a) => !a.includes("/boot"));
    assert.ok(after.length >= 2 && after.every((a) => a.endsWith("Bearer CALLBACK-SECRET")), JSON.stringify(g.seen.auth));
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(h.stdin, "프롬프트 — 한글과 \"따옴표\"\n둘째 줄");
    assert.deepEqual(h.env, { boot: null, id: null, extra: "1" });
    assert.equal(h.cwd, fs.realpathSync(tmp));
    assert.equal(h.argv[0], "--mcp-config");
    assert.notEqual(h.argv[1], MCP_CONFIG_PLACEHOLDER);
    assert.equal(h.argv[2], "--flag");
    assert.deepEqual(JSON.parse(h.mcp), { mcpServers: { lively: { type: "http", url: "x" } } });
    assert.equal(h.mcpMode, 0o600);
    assert.ok(!fs.existsSync(h.argv[1]), "판이 끝나면 임시 폴더(프롬프트·MCP 파일)를 지운다");
  } finally { await g.close(); }
});

await t("R3 시간 상한 — 하네스를 끊고 stopped=timeout 으로 보고한다", async () => {
  const record = path.join(tmp, "r3.json");
  const g = await gateway({ mode: "hang", timeoutMs: 600, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.results.length, 1);
    const r = g.seen.results[0] as Record<string, any>;
    assert.equal(r.stopped, "timeout");
    assert.equal(r.result, null);
    assert.equal(r.signal, "SIGTERM");
  } finally { await g.close(); }
});

await t("R4 박동 응답이 cancel 이면 — 하네스를 끊고 stopped=canceled", async () => {
  const record = path.join(tmp, "r4.json");
  const g = await gateway({ mode: "hang", timeoutMs: 20_000, cancelAfterTicks: 1, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.results.length, 1);
    assert.equal((g.seen.results[0] as Record<string, unknown>).stopped, "canceled");
  } finally { await g.close(); }
});

await t("R5 결과 콜백이 5xx 면 다시 보낸다 — 두 번째를 받는다", async () => {
  const record = path.join(tmp, "r5.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, resultFailFirst: true, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.results.length, 2);
    assert.deepEqual(g.seen.results[0], g.seen.results[1]);
  } finally { await g.close(); }
});

await t("부트 비밀이 틀리면(401) 판은 하네스를 안 띄우고 실패를 알린 뒤(같은 비밀 · #4829) 0 아닌 코드로 끝난다", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "x.json") });
  try {
    const src = BOOT_SOURCE.replace(/port:8080/, `port:${g.port}`);
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, ["-e", src], { env: { ...process.env, [JOB_ID_ENV]: "1", [JOB_BOOT_ENV]: "WRONG" }, stdio: "ignore" });
      p.on("close", resolve);
    });
    assert.equal(code, 3);
    assert.equal(g.seen.ticks.length + g.seen.results.length, 0);
    assert.ok(!fs.existsSync(path.join(tmp, "x.json")), "하네스가 떴다");
    assert.deepEqual(g.seen.failed, [{ auth: "Bearer WRONG", body: { stage: "boot", status: 401, message: '{"error":"no"}' } }], "한 번 · 부트에 쓴 비밀로");
  } finally { await g.close(); }
});

await t("F1 부트 응답이 JSON 이 아니면 — stage boot · 200 으로 알리고 4 로 끝난다(하네스 안 띄움)", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "f1.json"), bootRaw: "<html>proxy</html>" });
  try {
    assert.equal(await runBoot(g.port), 4);
    assert.equal(g.seen.failed.length, 1);
    assert.deepEqual(g.seen.failed[0]!.body, { stage: "boot", status: 200, message: "응답이 JSON 이 아닙니다" });
    assert.equal(g.seen.failed[0]!.auth, "Bearer BOOT-SECRET");
    assert.equal(g.seen.ticks.length + g.seen.results.length, 0);
  } finally { await g.close(); }
});

await t("F2 판 본체가 곧바로 던지면 — stage runner 와 그 말로 알리고 5 로 끝난다", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "f2.json"), runnerCode: `throw new Error("본체 깨짐 " + job.id)` });
  try {
    assert.equal(await runBoot(g.port), 5);
    assert.deepEqual(g.seen.failed.map((f) => f.body), [{ stage: "runner", status: 0, message: "본체 깨짐 1" }]);
    assert.ok(!fs.existsSync(path.join(tmp, "f2.json")), "하네스가 떴다");
  } finally { await g.close(); }
});

await t("F4 실패 보고의 답이 머리만 오고 멈춰도 5초 남짓에 같은 종료 코드로 끝난다(격리 리뷰 — 종전엔 0)", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "f4.json"), bootRaw: "x", failedStall: true });
  try {
    const t0 = Date.now();
    assert.equal(await runBoot(g.port), 4);
    const took = Date.now() - t0;
    assert.equal(g.seen.failed.length, 1);
    assert.ok(took >= 4_500 && took < 9_000, `${took}ms`);
  } finally { await g.close(); }
});

await t("F3 실패 보고에 게이트웨이가 답하지 않아도 판은 5초 남짓에 끝난다(컨테이너가 남지 않게)", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "f3.json"), bootRaw: "x", failedHang: true });
  try {
    const t0 = Date.now();
    assert.equal(await runBoot(g.port), 4);
    const took = Date.now() - t0;
    assert.equal(g.seen.failed.length, 1);
    assert.ok(took >= 4_500 && took < 9_000, `${took}ms`);
  } finally { await g.close(); }
});

await t("claudeJobArgv — 훅 끔 · 멤버 MCP 안 실음 · MCP 자리표 · 모델·이어받기 · 모델 이름이 플래그로 못 들어간다", () => {
  const a = claudeJobArgv({ model: "sonnet", resume: "0a1b2c3d-0000-4000-8000-000000000001", mcp: true });
  assert.deepEqual(a.slice(0, 6), ["claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
  assert.equal(a[a.indexOf("--settings") + 1], JSON.stringify({ disableAllHooks: true }));
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--mcp-config") + 1], MCP_CONFIG_PLACEHOLDER);
  assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  assert.equal(a[a.indexOf("--resume") + 1], "0a1b2c3d-0000-4000-8000-000000000001");
  assert.ok(!a.includes("--no-session-persistence"), "이어받기를 위해 대화를 남긴다");
  const b = claudeJobArgv({ mcp: false });
  assert.ok(b.includes("--strict-mcp-config") && !b.includes("--mcp-config") && !b.includes("--model") && !b.includes("--resume"));
  assert.ok(!a.includes("--tools") && !b.includes("--tools"), "단발이 아니면 도구를 끄지 않는다");
  //  #4488 단발(bare) — 내장 도구 전부 끔(`--tools ""`) · MCP 없음.
  const c = claudeJobArgv({ mcp: false, bare: true });
  assert.equal(c[c.indexOf("--tools") + 1], "", "빈 문자열 인자 하나로 도구를 끈다");
  assert.ok(!c.includes("--mcp-config"));
  for (const bad of ["--dangerously-x", "-p", "a b", "x;rm"]) assert.throws(() => claudeJobArgv({ model: bad, mcp: false }), bad);
});

await t("R6 결과를 올리는 동안에도 박동한다 — 게이트웨이가 결과를 늦게 받아도 «응답 없음» 으로 끊기지 않게", async () => {
  const record = path.join(tmp, "r6.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, resultDelayMs: 1_200, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.results.length, 1);
    const sent = g.seen.resultAt[0]!;
    const during = g.seen.tickAt.filter((at) => at > sent && at < sent + 1_200).length;
    assert.ok(during >= 3, `결과를 기다리는 1.2초 동안 박동 ${during}번(박동 간격 150ms)`);
  } finally { await g.close(); }
});

// ── #4489 stream 입력(세션 분기) — 지시를 메시지 한 줄씩 · 되돌려 받은 내 메시지 뒤의 답만 · 턴 보고 · 판 파일과 자리표 ──
//  가짜 하네스는 claude `--input-format stream-json --replay-user-messages` 의 꼴을 흉내 낸다: 이어받은 대화의 대기 알림이 내 메시지보다 먼저
//  빈 답(0 토큰 · 누적 비용)을 내고(FAKE_PRE), 받은 메시지마다 되돌려 준 뒤(isReplay) 답을 낸다. 입력이 닫히면 받은 것을 기록하고 끝난다.
const FAKE_STREAM = path.join(tmp, "fake-stream.cjs");
fs.writeFileSync(FAKE_STREAM, `
const fs = require("fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const got = [];
out({ type: "system", subtype: "init", session_id: "fork-conv-0001", model: "fake-model" });
if (process.env.FAKE_PRE === "1") out({ type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 13.6, usage: { input_tokens: 0, output_tokens: 0 } });
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line); got.push(m);
    const n = got.length;
    if (process.env.FAKE_NOREPLAY !== "1") out({ type: "user", isReplay: true, message: m.message });
    out({ type: "assistant", message: { content: [{ type: "text", text: "생각 " + n }] } });
    const bad = process.env.FAKE_ERR_TURN === String(n);
    out({ type: "result", subtype: bad ? "error_during_execution" : "success", is_error: bad, result: process.env["FAKE_T" + n] || ("답 " + n), total_cost_usd: 99, usage: { input_tokens: 10 * n, output_tokens: n } });
  }
});
process.stdin.on("end", () => {
  const si = process.argv.indexOf("--settings");
  const settingsPath = si > 0 ? process.argv[si + 1] : null;
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    argv: process.argv.slice(2), texts: got.map((m) => m.message.content[0].text), types: got.map((m) => m.type),
    env: { session: process.env.LIVELY_SESSION_ID ?? null, guardEnv: process.env.GUARD_AT ?? null },
    settingsPath, settings: settingsPath && fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null,
    settingsMode: settingsPath && fs.existsSync(settingsPath) ? (fs.statSync(settingsPath).mode & 0o777) : null,
  }));
  process.exit(0);
});
`);

//  판 폴더 밖으로 나가려는 파일 이름(«../»)의 표적 — 시험마다 다른 이름이라 남은 흔적에 걸리지 않는다.
const EVIL = `evil-${process.pid}-${Date.now()}`;
/** stream 판의 가짜 게이트웨이 — 턴 보고(/turn)에 대본대로 다음 지시를 준다. */
async function streamGateway(o: { record: string; env?: Record<string, string>; turns: number; next?: (n: number) => string | null; timeoutMs?: number; replayWaitMs?: number }):
  Promise<{ port: number; turns: Array<Record<string, unknown>>; results: Array<Record<string, any>>; close: () => Promise<void> }> {
  const turns: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, any>> = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const json = (status: number, v: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/api/agent-jobs/1/boot") {
        return json(200, {
          id: 1, secret: "CALLBACK-SECRET", code: RUNNER_SOURCE.replace(/port: 8080/, `port: ${port}`),
          argv: [process.execPath, FAKE_STREAM, "-p", "--settings", "{{LVLY_FILE:settings.json}}"],
          prompt: "첫 지시", mcp: null, cwd: tmp,
          env: { FAKE_RECORD: o.record, GUARD_AT: "{{LVLY_FILE:guard.json}}", LIVELY_SESSION_ID: "box-alice", ...(o.env ?? {}) },
          files: [
            { name: "settings.json", content: JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "\"{{LVLY_NODE}}\" \"{{LVLY_FILE:guard.cjs}}\"" }] }] } }) },
            { name: "guard.cjs", content: "// 판정기" }, { name: "guard.json", content: "{}" }, { name: `../${EVIL}`, content: "x" },
          ],
          input: "stream", turns: o.turns, ...(o.replayWaitMs ? { replayWaitMs: o.replayWaitMs } : {}),
          timeoutMs: o.timeoutMs ?? 20_000, tickMs: 150, tailMax: 4000, resultMax: 1000, stderrMax: 500,
        });
      }
      if (req.url === "/api/agent-jobs/1/tick") return json(200, { cancel: false });
      if (req.url === "/api/agent-jobs/1/turn") {
        const b = JSON.parse(body || "{}");
        turns.push(b);
        return json(200, { next: o.next ? o.next(Number(b.n)) : null });
      }
      if (req.url === "/api/agent-jobs/1/result") { results.push(JSON.parse(body || "{}")); return json(200, { ok: true }); }
      json(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { port, turns, results, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

await t("RS1 stream — 대기 알림의 빈 답은 버리고 내 답만 · 턴 보고에 «다시» 가 오면 같은 프로세스에 둘째 지시 · 마지막 답 · 턴 2 · 토큰 합 · 비용은 안 싣는다", async () => {
  const record = path.join(tmp, "rs1.json");
  const g = await streamGateway({ record, env: { FAKE_PRE: "1", FAKE_T1: "모양 틀린 답", FAKE_T2: "{\"result\":\"r\",\"session_note\":\"n\"}" }, turns: 1, next: (n) => (n === 1 ? "형식에 맞게 다시" : null) });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.deepEqual(g.turns.map((x) => [x.n, x.text, x.is_error]), [[1, "모양 틀린 답", false]], "턴 보고는 첫 턴 한 번(남은 턴 1)");
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(h.texts, ["첫 지시", "형식에 맞게 다시"], "두 지시가 한 프로세스에 메시지 한 줄씩");
    assert.deepEqual(h.types, ["user", "user"]);
    assert.equal(g.results.length, 1);
    const r = g.results[0]!.result;
    assert.equal(r.text, "{\"result\":\"r\",\"session_note\":\"n\"}"); assert.equal(r.turns, 2);
    assert.deepEqual(r.usage, { input_tokens: 30, output_tokens: 3 }, "빈 답(0 토큰)은 안 세고 두 턴의 합");
    assert.equal(r.cost_usd, null, "누적 비용(빈 답의 13.6 · 턴마다 99)을 싣지 않는다");
    assert.equal(g.results[0]!.conversation_id, "fork-conv-0001");
  } finally { await g.close(); }
});

await t("RS2 stream — 다음 지시가 없으면 첫 답에서 입력을 닫아 끝낸다(턴 1)", async () => {
  const record = path.join(tmp, "rs2.json");
  const g = await streamGateway({ record, env: { FAKE_T1: "한 번에 맞은 답" }, turns: 1, next: () => null });
  try {
    assert.equal(await runBoot(g.port), 0);
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(h.texts, ["첫 지시"]);
    assert.equal(g.results[0]!.result.text, "한 번에 맞은 답"); assert.equal(g.results[0]!.result.turns, 1);
    assert.equal(g.turns.length, 1);
  } finally { await g.close(); }
});

await t("RS3 판 파일 — 0600 으로 쓰고 자리표를 그 경로 · 노드 실행 파일로 바꾼다(argv · env · 파일 내용) · 이름의 경로 문자는 지운다 · 끝나면 지운다", async () => {
  const record = path.join(tmp, "rs3.json");
  const g = await streamGateway({ record, turns: 0 });
  try {
    assert.equal(await runBoot(g.port), 0);
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.ok(h.settingsPath && !h.settingsPath.includes("{{"), `settings 자리표가 그대로: ${h.settingsPath}`);
    assert.equal(h.settingsMode, 0o600);
    const cmd = JSON.parse(h.settings).hooks.PreToolUse[0].hooks[0].command as string;
    assert.ok(cmd.startsWith(`"${process.execPath}" "`) && !cmd.includes("{{"), `훅 명령의 자리표: ${cmd}`);
    const guardPath = cmd.split("\" \"")[1]!.replace(/"$/, "");
    assert.equal(path.dirname(guardPath), path.dirname(h.settingsPath), "판정기는 같은 판 폴더에");
    assert.equal(h.env.guardEnv, path.join(path.dirname(h.settingsPath), "f-guard.json"), "env 값의 자리표도 바뀐다");
    assert.equal(h.env.session, "box-alice");
    assert.ok(!fs.existsSync(path.join(path.dirname(path.dirname(h.settingsPath)), EVIL)), "이름의 경로 문자로 판 폴더 밖에 쓰지 않는다");
    assert.ok(!fs.existsSync(h.settingsPath), "끝나면 판 폴더를 지운다");
    assert.equal(g.turns.length, 0, "턴 0 이면 묻지 않는다");
  } finally { fs.rmSync(path.join(os.tmpdir(), EVIL), { force: true }); await g.close(); }   // 판(같은 TMPDIR)이 새어 썼다면 치운다
});

await t("RS4 stream — 첫 턴이 오류면 묻지 않고 끝낸다(오류 답 그대로)", async () => {
  const record = path.join(tmp, "rs4.json");
  const g = await streamGateway({ record, env: { FAKE_ERR_TURN: "1", FAKE_T1: "오류 답" }, turns: 1, next: () => "다시" });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.turns.length, 0);
    assert.equal(g.results[0]!.result.is_error, true); assert.equal(g.results[0]!.result.text, "오류 답");
  } finally { await g.close(); }
});

await t("RS5 stream — 하네스가 내 메시지를 되돌려 주지 않으면 그 답을 내 답으로 읽지 않는다(기다림 상한 없음 → 시간 상한에 끝남)", async () => {
  const record = path.join(tmp, "rs5.json");
  const g = await streamGateway({ record, env: { FAKE_NOREPLAY: "1", FAKE_PRE: "1" }, turns: 1, next: () => null, timeoutMs: 1_500 });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.turns.length, 0);
    assert.equal(g.results[0]!.stopped, "timeout"); assert.equal(g.results[0]!.result, null);
  } finally { await g.close(); }
});

await t("RS6 stream — 되돌려 받기 상한을 넘기면 시간 상한을 기다리지 않고 사유를 남겨 끝낸다 · 상한 안에 되돌려 받으면 그대로", async () => {
  const record = path.join(tmp, "rs6.json");
  const g = await streamGateway({ record, env: { FAKE_NOREPLAY: "1" }, turns: 1, next: () => null, timeoutMs: 20_000, replayWaitMs: 700 });
  const t0 = Date.now();
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.ok(Date.now() - t0 < 10_000, `시간 상한(20초)까지 기다렸다: ${Date.now() - t0}ms`);
    const r = g.results[0]!;
    assert.equal(r.stopped, "no_replay"); assert.equal(r.result, null);
    assert.match(String(r.stderr_tail), /되돌려 주지 않았습니다/);
  } finally { await g.close(); }
  const ok2 = path.join(tmp, "rs6b.json");
  const g2 = await streamGateway({ record: ok2, env: { FAKE_T1: "제때 되돌려 받은 답" }, turns: 1, next: () => null, replayWaitMs: 5_000 });
  try {
    assert.equal(await runBoot(g2.port), 0);
    assert.equal(g2.results[0]!.stopped, null); assert.equal(g2.results[0]!.result.text, "제때 되돌려 받은 답");
  } finally { await g2.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`# ${pass} pass`);

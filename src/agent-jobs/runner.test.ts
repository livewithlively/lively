// 작업 컨테이너 판(부트 + 본체) — **진짜 노드 프로세스**로 돌려 부작용을 본다 (#4490).
//  가짜 게이트웨이(HTTP)가 boot·tick·result 를 받고, 가짜 하네스(노드 스크립트)가 stream-json 을 낸다. 판이 실제로 무엇을 불렀고
//  무엇을 하네스에 넘겼는지(stdin·argv·env·MCP 파일)를 그쪽 기록으로 단언한다. 행 번호(R1~R6)는 지식 agent-job-container-research-4490 엣지 표.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { BOOT_SOURCE, RUNNER_SOURCE, MCP_CONFIG_PLACEHOLDER, CONFIG_DIR_PLACEHOLDER, SYSTEM_PROMPT_PLACEHOLDER, JOB_BOOT_ENV, JOB_ID_ENV, JOB_PORT_ENV, JOB_WS_ENV, TMUX_ARG_MAX, RUNNER_GATEWAY, claudeJobArgv } from "./runner.js";

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
  //  #5101 — 설정 폴더(CLAUDE_CONFIG_DIR)에 판이 되돌려 놓은 앞 대화가 있나 보고(projects/ 아래 어느 폴더든 · 그 안의 «저장한 파일» 안내가 가리키는
  //   파일이 실제로 있나), 진짜 claude 처럼 제 대화 파일 · 큰 도구 결과 파일을 남긴다(projects/<폴더>/<대화 id>.jsonl · <대화 id>/tool-results/*.txt).
  const path = require("path");
  const cfg = process.env.CLAUDE_CONFIG_DIR || null;
  let restored = null, restoredRef = null, strays = null;
  if (process.env.FAKE_TRANSCRIPT && cfg) {
    const pj = path.join(cfg, "projects");
    const conv = process.env.FAKE_RESUME_CONV || "none";
    for (const sub of fs.existsSync(pj) ? fs.readdirSync(pj) : []) {
      const rf = path.join(pj, sub, conv + ".jsonl");
      if (fs.existsSync(rf)) restored = fs.readFileSync(rf, "utf8");
    }
    const m = restored && /saved to (\\/[^ \\n]+)/.exec(restored);
    restoredRef = m ? (fs.existsSync(m[1]) ? fs.readFileSync(m[1], "utf8") : "없음:" + m[1]) : null;
    strays = fs.readdirSync(path.dirname(cfg)).filter((n) => n !== "cfg" && n !== "prompt.txt" && n !== "mcp.json" && n !== "system.md");
    const d = path.join(pj, "-fake-cwd");
    const sid = "0a1b2c3d-0000-4000-8000-000000000001";
    fs.mkdirSync(path.join(d, sid, "tool-results"), { recursive: true });
    if (process.env.FAKE_BIG) fs.writeFileSync(path.join(d, sid + ".jsonl"), require("crypto").randomBytes(65536));
    else {
      fs.writeFileSync(path.join(d, sid, "tool-results", "big.txt"), "큰 결과");
      fs.writeFileSync(path.join(d, sid + ".jsonl"), "line1 Output has been saved to " + path.join(d, sid, "tool-results", "big.txt") + " end\\n");
      //  묶음에 실리면 안 되는 것 — 설정 폴더 밖을 가리키는 링크(파일 · 폴더 — 따라가면 판의 임시 폴더를 돌며 지시 원문까지 싣는다) · 꼴 밖 이름(공백 · 한글).
      fs.symlinkSync(path.join(path.dirname(cfg), "prompt.txt"), path.join(d, "link.jsonl"));
      fs.symlinkSync(path.dirname(cfg), path.join(d, "linkdir"));
      fs.writeFileSync(path.join(d, "공백 이름.txt"), "꼴 밖");
      if (process.env.FAKE_MANY) { fs.mkdirSync(path.join(d, "many")); for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(d, "many", "f" + i + ".txt"), "x"); }
    }
  }
  const si = process.argv.indexOf("--append-system-prompt-file");
  const sysFile = si > 0 ? process.argv[si + 1] : null;
  fs.writeFileSync(rec, JSON.stringify({
    cfg, restored, restoredRef, strays,
    argv: process.argv.slice(2), stdin, cwd: process.cwd(),
    env: { boot: process.env.${JOB_BOOT_ENV} ?? null, id: process.env.${JOB_ID_ENV} ?? null, extra: process.env.EXTRA ?? null,
      port: process.env.${JOB_PORT_ENV} ?? null, ws: process.env.${JOB_WS_ENV} ?? null },
    mcp: mcpFile && fs.existsSync(mcpFile) ? fs.readFileSync(mcpFile, "utf8") : null,
    mcpMode: mcpFile && fs.existsSync(mcpFile) ? (fs.statSync(mcpFile).mode & 0o777) : null,
    sys: sysFile && fs.existsSync(sysFile) ? fs.readFileSync(sysFile, "utf8") : null,
    sysMode: sysFile && fs.existsSync(sysFile) ? (fs.statSync(sysFile).mode & 0o777) : null,
    sysFile,
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
  /** 요청마다 실린 워크스페이스 머리(#5082 — 박스 위 판만 싣는다) · 그 요청의 경로. */
  ws: Array<{ url: string; ws: string | string[] | undefined }>;
  /** 시작 실패 보고(#4829 boot-failed) — 비밀 · 본문. */
  failed: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
  /** #5101 대화 기록 보고 — 받은 시각 · 비밀 · 내용 형식 · 대화 id 머리 · 본문(바이트). */
  transcripts: Array<{ at: number; auth: string | undefined; type: string | undefined; conv: string | string[] | undefined; body: Buffer }>;
}

/** 가짜 게이트웨이 — 시나리오별 응답. */
async function gateway(o: {
  mode: "ok" | "hang"; timeoutMs: number; cancelAfterTicks?: number; resultFailFirst?: boolean; resultDelayMs?: number; record: string;
  /** 부트 200 의 본문을 이 글로(JSON 아님) · 판 본체 코드를 이것으로(곧바로 던지는 본체) · 시작 실패 보고에 답하지 않기 · 머리만 주고 멈추기. */
  bootRaw?: string; runnerCode?: string; failedHang?: boolean; failedStall?: boolean;
  /** #5101 부트 응답에 더할 칸(transcriptMax · transcript …) · 하네스 env 에 더할 것(CLAUDE_CONFIG_DIR 자리표 · 가짜 하네스 모드). */
  bootExtra?: Record<string, unknown>; envExtra?: Record<string, string>;
  /** #5082 앱 판 지시 — 주면 부트 응답에 system 과 지시 파일 자리표 인자를 싣는다. */
  system?: string;
  /** #5101 대화 기록 보고에 이 상태로 답한다(4xx — 판은 다시 보내지 않는다) · 또는 받지 않음(200 stored:false). */
  transcriptStatus?: number; transcriptNotStored?: boolean;
}): Promise<{ port: number; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = { boot: 0, ticks: [], results: [], auth: [], tickAt: [], resultAt: [], failed: [], ws: [], transcripts: [] };
  let resultCalls = 0;
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => { chunks.push(d); });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString("utf8");
      seen.auth.push(`${req.url} ${req.headers.authorization}`);
      seen.ws.push({ url: String(req.url), ws: req.headers["x-lively-workspace"] });
      const json = (status: number, v: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
      if (req.url === "/api/agent-jobs/1/boot") {
        seen.boot++;
        if (req.headers.authorization !== "Bearer BOOT-SECRET") return json(401, { error: "no" });
        if (o.bootRaw !== undefined) { res.writeHead(200, { "content-type": "text/html" }); res.end(o.bootRaw); return; }
        return json(200, {
          id: 1, secret: "CALLBACK-SECRET", code: o.runnerCode ?? RUNNER_SOURCE.replace(/port: 8080/, `port: ${port}`),
          argv: [process.execPath, FAKE, "--mcp-config", MCP_CONFIG_PLACEHOLDER, ...(o.system !== undefined ? ["--append-system-prompt-file", SYSTEM_PROMPT_PLACEHOLDER] : []), "--flag"],
          ...(o.system !== undefined ? { system: o.system } : {}),
          prompt: "프롬프트 — 한글과 \"따옴표\"\n둘째 줄", mcp: { mcpServers: { lively: { type: "http", url: "x" } } },
          env: { EXTRA: "1", FAKE_MODE: o.mode, FAKE_RECORD: o.record, ...(o.envExtra ?? {}) }, cwd: tmp,
          timeoutMs: o.timeoutMs, tickMs: 150, tailMax: 4000, resultMax: 1000, stderrMax: 500, ...(o.bootExtra ?? {}),
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
      if (req.url === "/api/agent-jobs/1/transcript") {
        seen.transcripts.push({ at: Date.now(), auth: req.headers.authorization, type: req.headers["content-type"], conv: req.headers["x-lvly-conversation"], body: raw });
        if (o.transcriptStatus) return json(o.transcriptStatus, { error: "거절" });
        return json(200, { ok: true, stored: !o.transcriptNotStored });
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
    assert.deepEqual(h.env, { boot: null, id: null, extra: "1", port: null, ws: null });
    assert.ok(g.seen.ws.length >= 3 && g.seen.ws.every((x) => x.ws === undefined), "#5082 F1 — 포트 · 워크스페이스 env 가 없으면 머리를 싣지 않는다(매니지드 종전 그대로)");
    assert.equal(h.cwd, fs.realpathSync(tmp));
    assert.equal(h.argv[0], "--mcp-config");
    assert.notEqual(h.argv[1], MCP_CONFIG_PLACEHOLDER);
    assert.equal(h.argv[2], "--flag");
    assert.deepEqual(JSON.parse(h.mcp), { mcpServers: { lively: { type: "http", url: "x" } } });
    assert.equal(h.mcpMode, 0o600);
    assert.ok(!fs.existsSync(h.argv[1]), "판이 끝나면 임시 폴더(프롬프트·MCP 파일)를 지운다");
  } finally { await g.close(); }
});

await t("#5082 U1 앱 판 지시 — 판이 지시 글을 작업 폴더(0700) 안 0600 파일로 쓰고 자리표를 그 경로로 · 하네스가 같은 글을 읽는다 · 끝나면 폴더째 지운다", async () => {
  const record = path.join(tmp, "u1.json");
  const sys = "정책 표를 조회해 답하라 — 한글과 \"따옴표\"\n둘째 줄";
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record, system: sys });
  try {
    assert.equal(await runBoot(g.port), 0);
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    const at = h.argv.indexOf("--append-system-prompt-file");
    assert.ok(at >= 0 && h.argv[at + 1] !== SYSTEM_PROMPT_PLACEHOLDER, JSON.stringify(h.argv));
    assert.equal(h.sys, sys, "하네스가 읽은 지시 = 받은 지시");
    assert.equal(h.sysMode, 0o600);
    assert.equal(path.basename(path.dirname(h.sysFile)).startsWith("lvly-job-"), true, "판의 임시 작업 폴더 안");
    assert.ok(!fs.existsSync(h.sysFile), "끝나면 지운다");
    assert.equal(g.seen.results.length, 1);
  } finally { await g.close(); }
});

await t("#5082 U2 앱 판 지시가 없으면 — 지시 파일을 만들지 않고 인자도 그대로(종전 작업 무회귀)", async () => {
  const record = path.join(tmp, "u2.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record });
  try {
    assert.equal(await runBoot(g.port), 0);
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.ok(!h.argv.includes("--append-system-prompt-file"));
    assert.equal(h.sysFile, null);
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
  assert.equal(a[a.indexOf("--resume") + 2], "--fork-session", "#5101 이어받기는 늘 갈라서 — 앞 대화 파일은 그대로");
  assert.ok(!a.includes("--no-session-persistence"), "이어받기를 위해 대화를 남긴다");
  const b = claudeJobArgv({ mcp: false });
  assert.ok(b.includes("--strict-mcp-config") && !b.includes("--mcp-config") && !b.includes("--model") && !b.includes("--resume"));
  assert.ok(!b.includes("--fork-session"), "이어받지 않으면 가르지도 않는다");
  assert.ok(!a.includes("--tools") && !b.includes("--tools"), "단발이 아니면 도구를 끄지 않는다");
  //  #4488 단발(bare) — 내장 도구 전부 끔(`--tools ""`) · MCP 없음.
  const c = claudeJobArgv({ mcp: false, bare: true });
  assert.equal(c[c.indexOf("--tools") + 1], "", "빈 문자열 인자 하나로 도구를 끈다");
  assert.ok(!c.includes("--mcp-config"));
  for (const bad of ["--dangerously-x", "-p", "a b", "x;rm"]) assert.throws(() => claudeJobArgv({ model: bad, mcp: false }), bad);
  //  #5082 앱 판 지시 — 지시 파일 자리표 · 작업 폴더 설정 끔(user 만). 없으면 둘 다 없다(단발 · MCP 작업 모두).
  for (const o of [{ mcp: true }, { mcp: false, bare: true }]) {
    const s = claudeJobArgv({ ...o, system: true });
    assert.equal(s[s.indexOf("--append-system-prompt-file") + 1], SYSTEM_PROMPT_PLACEHOLDER, JSON.stringify(o));
    assert.equal(s[s.indexOf("--setting-sources") + 1], "user", JSON.stringify(o));
    const n = claudeJobArgv({ ...o, system: false });
    assert.ok(!n.includes("--append-system-prompt-file") && !n.includes("--setting-sources"), JSON.stringify(o));
  }
  assert.ok(!a.includes("--setting-sources"), "지시가 없으면 종전 그대로(작업 폴더 설정을 읽는다)");
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

/** 진짜 부트를 **원문 그대로**(포트 자리를 바꾸지 않고) — 박스 위 판처럼 포트 · 워크스페이스를 env 로 준다(#5082). */
function runBootEnv(env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", BOOT_SOURCE], { cwd: tmp, env: { ...process.env, [JOB_ID_ENV]: "1", [JOB_BOOT_ENV]: "BOOT-SECRET", ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    const kill = setTimeout(() => { p.kill("SIGKILL"); }, 30_000);
    p.on("close", (code) => { clearTimeout(kill); if (code !== 0) console.log(`  (부트 stderr: ${err.slice(0, 300)})`); resolve(code); });
  });
}

await t("#5082 F2·F3·F4 포트 · 워크스페이스 env — 부트 · 박동 · 결과가 모두 그 포트로 · 모든 콜백에 x-lively-workspace · 하네스는 그 env 를 안 받는다", async () => {
  const record = path.join(tmp, "p1.json");
  //  본체도 원문 그대로 준다 — 본체가 env 의 포트를 따라오지 못하면 박동 · 결과가 8080 으로 가서 이 게이트웨이에 안 닿는다.
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record, runnerCode: RUNNER_SOURCE });
  try {
    assert.equal(await runBootEnv({ [JOB_PORT_ENV]: String(g.port), [JOB_WS_ENV]: "acme" }), 0);
    assert.equal(g.seen.boot, 1);
    assert.ok(g.seen.ticks.length >= 1, `박동 ${g.seen.ticks.length}`);
    assert.equal(g.seen.results.length, 1, "결과가 그 포트로 왔다");
    assert.ok(g.seen.ws.length >= 3, JSON.stringify(g.seen.ws));
    for (const x of g.seen.ws) assert.equal(x.ws, "acme", `머리 없는 콜백: ${x.url}`);
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(h.env, { boot: null, id: null, extra: "1", port: null, ws: null }, "작업 내부 env 는 하네스에 안 간다");
  } finally { await g.close(); }
});

await t("#5082 F2 포트 env 만(워크스페이스 없음) — 그 포트로 가고 머리는 싣지 않는다", async () => {
  const record = path.join(tmp, "p2.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record, runnerCode: RUNNER_SOURCE });
  try {
    assert.equal(await runBootEnv({ [JOB_PORT_ENV]: String(g.port) }), 0);
    assert.equal(g.seen.results.length, 1);
    assert.ok(g.seen.ws.every((x) => x.ws === undefined), JSON.stringify(g.seen.ws));
  } finally { await g.close(); }
});

// ── #5101 API 키 작업의 대화 기록 묶음 — 판이 올리고(T1 · T2 · T4) · 되돌려 놓는다(T3) — 태스크 #5101 · 지식 app-ai-run-resume-asbuilt-5101 ──
const KEY_ENV = { CLAUDE_CONFIG_DIR: CONFIG_DIR_PLACEHOLDER, FAKE_TRANSCRIPT: "1" };
const SID = "0a1b2c3d-0000-4000-8000-000000000001";
type Bundle = { v: number; cfg: string; files: Array<{ p: string; d: string }> };
const unbundle = (gz: Buffer): Bundle => JSON.parse(zlib.gunzipSync(gz).toString("utf8")) as Bundle;
const bundleB64 = (b: Bundle): string => zlib.gzipSync(Buffer.from(JSON.stringify(b), "utf8")).toString("base64");
const b64 = (t: string): string => Buffer.from(t, "utf8").toString("base64");

await t("T1(#5101) API 키 작업 — 끝나면 설정 폴더 projects/ 아래 파일 전부(대화 파일 · 큰 도구 결과 파일)를 묶어 결과보다 먼저 올린다(콜백 비밀 · 대화 id 머리) · 설정 폴더는 지운다", async () => {
  const record = path.join(tmp, "t1.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record, envExtra: KEY_ENV, bootExtra: { transcriptMax: 1_000_000, transcriptRawMax: 10_000_000 } });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.transcripts.length, 1, "한 번");
    const tr = g.seen.transcripts[0]!;
    assert.equal(tr.auth, "Bearer CALLBACK-SECRET"); assert.equal(tr.type, "application/gzip");
    assert.equal(tr.conv, SID, "하네스가 밝힌 대화 id");
    const h = JSON.parse(fs.readFileSync(record, "utf8"));
    const b = unbundle(tr.body);
    assert.equal(b.v, 1); assert.equal(b.cfg, h.cfg, "이 작업의 설정 폴더 경로(되돌릴 때 바꿔 쓸 앞자리)");
    const files = Object.fromEntries(b.files.map((f) => [f.p, Buffer.from(f.d, "base64").toString("utf8")]));
    assert.deepEqual(Object.keys(files).sort(), [`-fake-cwd/${SID}.jsonl`, `-fake-cwd/${SID}/tool-results/big.txt`],
      "projects/ 기준 상대 경로 · 큰 도구 결과 파일까지 — 링크(파일 · 폴더) · 꼴 밖 이름은 싣지 않는다");
    assert.match(files[`-fake-cwd/${SID}.jsonl`]!, /saved to \//); assert.equal(files[`-fake-cwd/${SID}/tool-results/big.txt`], "큰 결과");
    assert.equal(g.seen.results.length, 1);
    assert.ok(tr.at <= g.seen.resultAt[0]!, "결과보다 먼저(결과가 곧바로 같은 대화를 잇는 작업을 낳을 수 있다)");
    assert.ok(typeof h.cfg === "string" && h.cfg !== CONFIG_DIR_PLACEHOLDER, "자리표가 이 작업만의 폴더로 바뀌었다");
    assert.ok(!fs.existsSync(h.cfg), "끝나면 설정 폴더를 지운다");
    assert.doesNotMatch(String(g.seen.results[0]!.stderr_tail), /transcript (skipped|upload)/, "올렸으면 까닭 줄이 없다");
  } finally { await g.close(); }
});

await t("T2(#5101) 올리기가 꺼진 작업(구독 — 대화는 홈에 남는다 · 보관 꺼짐) — 설정 폴더에 대화가 있어도 올리지 않는다 · 결과는 그대로", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t2.json"), envExtra: KEY_ENV });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.transcripts.length, 0);
    assert.equal(g.seen.results.length, 1);
  } finally { await g.close(); }
});

await t("T3(#5101) 이어받는 작업 — 받은 묶음을 하네스를 띄우기 전에 설정 폴더 projects/ 아래 원래 자리에 되돌리고, 대화 파일 속 앞 작업의 설정 폴더 경로를 이 작업의 것으로 바꾼다 · 위험한 경로 · 꼴 밖 대화 id · 풀면 상한 초과는 안 놓는다", async () => {
  const CONV_R = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const OLD = "/tmp/lvly-job-OLD123/cfg";
  const prev: Bundle = { v: 1, cfg: OLD, files: [
    { p: `-fake-cwd/${CONV_R}.jsonl`, d: b64(`앞 대화 Output has been saved to ${OLD}/projects/-fake-cwd/${CONV_R}/tool-results/r.txt end\n`) },
    { p: `-fake-cwd/${CONV_R}/tool-results/r.txt`, d: b64("앞 작업의 큰 결과") },
    { p: "../../evil.txt", d: b64("밖으로") },
    { p: "-fake-cwd/../../../evil2.txt", d: b64("밖으로") },
  ] };
  const r1 = path.join(tmp, "t3.json");
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: r1, envExtra: { ...KEY_ENV, FAKE_RESUME_CONV: CONV_R },
    bootExtra: { transcriptMax: 1_000_000, transcriptRawMax: 1_000_000, transcript: { conv: CONV_R, gz: bundleB64(prev) } } });
  try {
    assert.equal(await runBoot(g.port), 0);
    const h = JSON.parse(fs.readFileSync(r1, "utf8"));
    assert.ok(typeof h.restored === "string" && h.restored.startsWith("앞 대화"), "하네스가 뜰 때 그 대화 파일이 있다");
    assert.ok(!h.restored.includes(OLD) && h.restored.includes(`${h.cfg}/projects/-fake-cwd/${CONV_R}/tool-results/r.txt`), "앞 작업의 경로를 이 작업의 경로로 바꿔 썼다");
    assert.equal(h.restoredRef, "앞 작업의 큰 결과", "안내가 가리키는 큰 결과 파일이 그 자리에 있다(이어받은 AI 가 다시 읽는다)");
    assert.deepEqual(h.strays, [], "위험한 경로(..)는 설정 폴더 밖에 아무것도 쓰지 않는다");
    assert.equal(g.seen.results.length, 1);
    //  이어받은 작업이 올리는 묶음엔 되돌린 앞 대화 · 큰 결과도 담긴다(손자 작업이 같은 길로 잇는다).
    const up = unbundle(g.seen.transcripts[0]!.body).files.map((f) => f.p).sort();
    assert.ok(up.includes(`-fake-cwd/${CONV_R}.jsonl`) && up.includes(`-fake-cwd/${CONV_R}/tool-results/r.txt`) && up.includes(`-fake-cwd/${SID}.jsonl`), JSON.stringify(up));
  } finally { await g.close(); }
  const r2 = path.join(tmp, "t3b.json");
  const g2 = await gateway({ mode: "ok", timeoutMs: 20_000, record: r2, envExtra: { ...KEY_ENV, FAKE_RESUME_CONV: CONV_R },
    bootExtra: { transcriptMax: 1_000_000, transcript: { conv: "../../evil", gz: bundleB64(prev) } } });
  try {
    assert.equal(await runBoot(g2.port), 0);
    assert.equal(JSON.parse(fs.readFileSync(r2, "utf8")).restored, null, "대화 id 꼴이 아니면 묶음을 풀지 않는다");
    assert.equal(g2.seen.results.length, 1, "그래도 하네스는 돌고 결과를 올린다(하네스가 «대화 없음» 을 낼 것이다)");
  } finally { await g2.close(); }
  const r3 = path.join(tmp, "t3c.json");
  const g3 = await gateway({ mode: "ok", timeoutMs: 20_000, record: r3, envExtra: { ...KEY_ENV, FAKE_RESUME_CONV: CONV_R },
    bootExtra: { transcriptMax: 1_000_000, transcriptRawMax: 50, transcript: { conv: CONV_R, gz: bundleB64(prev) } } });
  try {
    assert.equal(await runBoot(g3.port), 0);
    assert.equal(JSON.parse(fs.readFileSync(r3, "utf8")).restored, null, "풀면 상한을 넘는 묶음(압축 폭탄)은 안 놓는다");
    const why3 = String((g3.seen.results[0] as Record<string, unknown>).stderr_tail);
    assert.match(why3, /transcript restore/, "까닭을 결과에 남긴다");
    assert.doesNotMatch(why3, /되돌릴 크기/, "푸는 도중에 멈춘다 — 다 풀어 메모리에 올린 뒤 세지 않는다(쓰는 총량 상한은 그 뒤의 둘째 막이)");
  } finally { await g3.close(); }
});

await t("T3d(#5101) 되돌리기 — 모르는 묶음 형식(v 1 이 아님)은 안 놓는다 · 경로를 바꿔 쓰며 늘어난 총량이 풀린 상한을 넘으면 거기서 멈춘다(까닭은 결과에)", async () => {
  const CONV_R = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const r1 = path.join(tmp, "t3d.json");
  const v2: Bundle = { v: 2, cfg: "/old/cfg", files: [{ p: `-fake-cwd/${CONV_R}.jsonl`, d: b64("앞 대화\n") }] };
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: r1, envExtra: { ...KEY_ENV, FAKE_RESUME_CONV: CONV_R },
    bootExtra: { transcriptMax: 1_000_000, transcript: { conv: CONV_R, gz: bundleB64(v2) } } });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(JSON.parse(fs.readFileSync(r1, "utf8")).restored, null, "모르는 형식은 놓지 않는다");
    assert.match(String(g.seen.results[0]!.stderr_tail), /transcript restore: 묶음 형식\(v 2\)을 모른다/);
  } finally { await g.close(); }
  //  앞 설정 폴더 경로가 짧으면(«/a») 바꿔 쓸 때마다 수십 배로 는다 — 3천 바이트 상한에서 «/a/» 300 번(900 바이트)은 넘친다.
  const r2 = path.join(tmp, "t3e.json");
  const grow: Bundle = { v: 1, cfg: "/a", files: [{ p: `-fake-cwd/${CONV_R}.jsonl`, d: b64("/a/".repeat(300)) }] };
  const g2 = await gateway({ mode: "ok", timeoutMs: 20_000, record: r2, envExtra: { ...KEY_ENV, FAKE_RESUME_CONV: CONV_R },
    bootExtra: { transcriptMax: 1_000_000, transcriptRawMax: 3000, transcript: { conv: CONV_R, gz: bundleB64(grow) } } });
  try {
    assert.equal(await runBoot(g2.port), 0);
    assert.equal(JSON.parse(fs.readFileSync(r2, "utf8")).restored, null, "넘치는 파일은 쓰지 않는다");
    assert.match(String(g2.seen.results[0]!.stderr_tail), /transcript restore: 되돌릴 크기가 상한\(3000\)을 넘는다/);
  } finally { await g2.close(); }
});

await t("T4(#5101) 압축한 묶음이 상한을 넘거나 · 풀린 크기가 상한에 가까우면(읽기 전에 잰다) — 올리지 않는다 · 결과는 올린다", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t4.json"), envExtra: { ...KEY_ENV, FAKE_BIG: "1" }, bootExtra: { transcriptMax: 1_000 } });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.transcripts.length, 0, "압축 상한");
    assert.equal(g.seen.results.length, 1);
    assert.match(String(g.seen.results[0]!.stderr_tail), /transcript skipped: 압축 \d+ > 1000/, "까닭을 결과에 한 줄(격리 리뷰)");
  } finally { await g.close(); }
  const g2 = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t4b.json"), envExtra: { ...KEY_ENV, FAKE_BIG: "1" }, bootExtra: { transcriptMax: 10_000_000, transcriptRawMax: 50_000 } });
  try {
    assert.equal(await runBoot(g2.port), 0);
    assert.equal(g2.seen.transcripts.length, 0, "64KB 대화 > 풀린 상한 50KB 의 70% — 읽지 않고 건너뛴다");
    assert.equal(g2.seen.results.length, 1);
    assert.match(String(g2.seen.results[0]!.stderr_tail), /transcript skipped: 풀린 크기 \d+ > 35000/);
  } finally { await g2.close(); }
});

await t("T4c(#5101) 파일이 상한(2000)보다 많으면 올리지 않는다 · 게이트웨이가 보고를 거절하거나(4xx · 다시 보내지 않음) 받지 않으면 그 까닭을 결과에 남긴다", async () => {
  const g = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t4c.json"), envExtra: { ...KEY_ENV, FAKE_MANY: "1" }, bootExtra: { transcriptMax: 1_000_000 } });
  try {
    assert.equal(await runBoot(g.port), 0);
    assert.equal(g.seen.transcripts.length, 0);
    assert.match(String(g.seen.results[0]!.stderr_tail), /transcript skipped: 파일이 너무 많다\(2000 초과\)/);
  } finally { await g.close(); }
  const g2 = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t4d.json"), envExtra: KEY_ENV, bootExtra: { transcriptMax: 1_000_000 }, transcriptStatus: 400 });
  try {
    assert.equal(await runBoot(g2.port), 0);
    assert.equal(g2.seen.transcripts.length, 1, "4xx 는 다시 보내지 않는다");
    assert.match(String(g2.seen.results[0]!.stderr_tail), /transcript upload: 400/);
  } finally { await g2.close(); }
  const g3 = await gateway({ mode: "ok", timeoutMs: 20_000, record: path.join(tmp, "t4e.json"), envExtra: KEY_ENV, bootExtra: { transcriptMax: 1_000_000 }, transcriptNotStored: true });
  try {
    assert.equal(await runBoot(g3.port), 0);
    assert.match(String(g3.seen.results[0]!.stderr_tail), /transcript upload: 게이트웨이가 받지 않았다/);
  } finally { await g3.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`# ${pass} pass`);

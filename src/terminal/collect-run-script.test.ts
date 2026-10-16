// 수집 실행 러너·훅의 **행위 계약** (#4213 T11) — 컨테이너 안에서 도는 문자열 스크립트를 실제 node 로 돌려 본다.
//
//  이 스크립트들은 TS 컴파일러가 안 본다. 틀리면 증상이 조용하다 — 문지기가 비정상 종료하면 Claude Code 는 «차단 아님» 으로
//   읽어 쓰기 도구가 통과하고, 러너가 끝 신호(exit.json)를 못 쓰면 게이트웨이는 «잃음» 까지 기다린다. 그래서 판정·종료 코드·
//   파일 모양을 여기서 못박는다. 진짜 claude 대신 가짜 claude(같은 플래그 · 같은 훅 호출 규약)를 쓴다.
//
//  엣지 표(사양 → 시나리오, 행마다 단언 하나 이상)
//   G1 허락 서버의 읽기 도구 → 0             G2 쓰기 동사(읽기 낱말과 섞여도) → 2      G3 허락 안 한 커넥터 → 2
//   G4 내장 도구·라이블리 MCP → 2            G5 읽기 동사 없음 → 2                     G6 깨진/빈 입력 → 2
//   G7 허락 목록 파일 없음 → 2               G8 접두가 같은 다른 서버 → 2
//   C1 원문 그대로 · 목록 한 줄(글자 수·sha256)   C2 깨진 입력 → 0 · 목록에 error 줄
//   R1 apps=[Slack] → allow 하나 · 나머지 서버·내장 deny · 플래그 · stdin · 토큰 env 없음 · 요약/끝 신호
//   R2 요청 앱이 없음 → claude -p 안 뜸 · no-connector · missing      R3 apps=[] → 연결된 것 전부(needs-auth 제외)
//   R4 옛 claude(플래그 없음) → 그 플래그를 안 붙인다                   R5 서버 목록이 빔 → no-connector
//   R6 시간 상한 초과 → 끊고 timeout · 끝 신호                        R7 일감 깨짐 → job.json 실패 · 끝 신호
//   S1 쓰기 셸 0600 · S2 끝난 폴더(done·세션 id·목록) · S3 없음/도는 중(반쯤 쓰인 줄 버림)
//   P1 id · P2 폴더 모양 · P3 판 명령 · P4 일감 경계 · P5 메모리 env 경계 · P6 쓰기 셸 입력 거절
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COLLECT_CAPTURE_JS, COLLECT_GATE_JS, COLLECT_RUNNER_JS, COLLECT_RUN_ID_RE, collectJob, collectMemLimits, collectPaneArgv,
  collectReadSh, collectRunDir, collectRunStartedAt, collectSessionNoteSh, collectWriteSh, isCollectRunDir, newCollectRunId, parseCollectRead,
} from "./collect-run-script.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collect-run-"));
const NODE = process.execPath;

// ── 문지기 ──
const gateDir = path.join(tmp, "gate");
fs.mkdirSync(gateDir);
fs.writeFileSync(path.join(gateDir, "gate.cjs"), COLLECT_GATE_JS);
fs.writeFileSync(path.join(gateDir, "gate.json"), JSON.stringify({ servers: ["claude_ai_Slack", "claude_ai_Google_Drive"] }));
const gate = (input: string, dir = gateDir): { code: number | null; err: string } => {
  const r = spawnSync(NODE, [path.join(gateDir, "gate.cjs"), dir], { input, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
};
const call = (name: string): string => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {} });

t("G1 허락한 서버의 읽기 도구는 통과(0)", () => {
  for (const n of ["mcp__claude_ai_Slack__slack_read_channel", "mcp__claude_ai_Slack__slack_search_public", "mcp__claude_ai_Google_Drive__google_drive_fetch"]) {
    assert.equal(gate(call(n)).code, 0, n);
  }
});
t("G2 쓰기 동사가 하나라도 있으면 막는다(2) — 읽기 낱말이 같이 있어도", () => {
  for (const n of ["mcp__claude_ai_Slack__slack_send_message", "mcp__claude_ai_Slack__slack_send_message_draft", "mcp__claude_ai_Slack__slack_create_canvas",
    "mcp__claude_ai_Google_Drive__google_drive_update_file", "mcp__claude_ai_Slack__slack_read_and_delete"]) {
    assert.equal(gate(call(n)).code, 2, n);
  }
  //  읽기 낱말이 함께 있어도 쓰기 동사 하나면 막힌다 — 동사마다 확인한다(하나를 빼먹으면 «읽기» 로 새어 나간다).
  for (const v of ["send", "create", "update", "delete", "remove", "post", "reply", "add", "edit", "move", "archive", "draft", "upload",
    "schedule", "invite", "react", "write", "share", "publish", "assign", "batch", "export", "copy", "forward", "submit"]) {
    assert.equal(gate(call(`mcp__claude_ai_Slack__read_${v}`)).code, 2, `read_${v}`);
  }
});
t("G3 허락하지 않은 커넥터는 읽기라도 막는다(2)", () => {
  assert.equal(gate(call("mcp__claude_ai_Notion__notion-search")).code, 2);
});
t("G4 내장 도구·라이블리 MCP 는 막는다(2)", () => {
  for (const n of ["Bash", "Read", "Write", "WebFetch", "mcp__lively__knowledge_save", "mcp__lively__source_list"]) assert.equal(gate(call(n)).code, 2, n);
});
t("G5 읽기 동사가 없는 이름은 막는다(2) — 모르는 도구는 기본 거절", () => {
  assert.equal(gate(call("mcp__claude_ai_Slack__slack_conversations")).code, 2);
});
t("G6 깨진·빈 입력은 막는다(2) — 비정상 종료가 «차단 아님» 으로 읽히지 않게", () => {
  assert.equal(gate("{not json").code, 2);
  assert.equal(gate("").code, 2);
});
t("G7 허락 목록 파일이 없으면 전부 막는다(2)", () => {
  const empty = path.join(tmp, "gate-empty");
  fs.mkdirSync(empty);
  assert.equal(gate(call("mcp__claude_ai_Slack__slack_read_channel"), empty).code, 2);
});
t("G8 접두가 같아도 다른 서버는 막는다(Slack ≠ Slack_Enterprise)", () => {
  assert.equal(gate(call("mcp__claude_ai_Slack_Enterprise__slack_read_channel")).code, 2);
});
t("G 배선 — 판정이 gate.log 에 실제로 남았다(문지기가 돌았다)", () => {
  const log = fs.readFileSync(path.join(gateDir, "gate.log"), "utf8");
  assert.match(log, /^allow mcp__claude_ai_Slack__slack_read_channel$/m);
  assert.match(log, /^deny mcp__claude_ai_Slack__slack_send_message$/m);
});

// ── 원문 받기 ──
const capDir = path.join(tmp, "cap");
fs.mkdirSync(capDir);
fs.writeFileSync(path.join(capDir, "cap.cjs"), COLLECT_CAPTURE_JS);
t("C1 원문을 고치지 않고 남기고, 목록 줄에 글자 수·sha256·파일을 적는다", () => {
  const resp = [{ type: "text", text: "회의록 — 결제 출시 10/20 확정 \"따옴표\" \n줄바꿈" }];
  const r = spawnSync(NODE, [path.join(capDir, "cap.cjs"), capDir], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__claude_ai_Slack__slack_read_channel", tool_input: { channel: "C1" }, tool_use_id: "toolu_1", tool_response: resp }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const lines = fs.readFileSync(path.join(capDir, "caps.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  const flat = JSON.stringify(resp);
  assert.equal(row.tool, "mcp__claude_ai_Slack__slack_read_channel");
  assert.equal(row.id, "toolu_1");
  assert.equal(row.chars, flat.length);
  assert.equal(row.sha256, crypto.createHash("sha256").update(flat).digest("hex"));
  const saved = JSON.parse(fs.readFileSync(path.join(capDir, "cap", row.file), "utf8"));
  assert.deepEqual(saved.tool_response, resp, "원문이 그대로다");
  assert.deepEqual(saved.tool_input, { channel: "C1" });
});
t("C2 깨진 입력이어도 수집을 막지 않는다(0) — 목록에 error 줄", () => {
  const r = spawnSync(NODE, [path.join(capDir, "cap.cjs"), capDir], { input: "{broken", encoding: "utf8" });
  assert.equal(r.status, 0);
  const lines = fs.readFileSync(path.join(capDir, "caps.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(JSON.parse(lines[1]).error, "error 줄");
});

// ── 러너(가짜 claude) ──
//  FAKE_MODE: old = 플래그 없는 옛 claude · empty = 서버 목록이 빔 · hang = -p 가 안 끝남
const FAKE = String.raw`#!__NODE__
const fs = require("fs"), cp = require("child_process");
const a = process.argv.slice(2), log = process.env.FAKE_CLAUDE_LOG, mode = process.env.FAKE_MODE || "";
if (a[0] === "--version") { console.log("2.1.301 (Claude Code)"); process.exit(0); }
if (a[0] === "--help") {
  console.log(mode === "old" ? "  -p, --print\n  --permission-mode <mode> (choices: \"acceptEdits\", \"default\")"
    : "  --tools <tools...>  built-ins\n  --permission-mode <mode> (choices: \"dontAsk\")\n  --no-session-persistence\n  --disable-slash-commands");
  process.exit(0);
}
if (a[0] === "mcp" && a[1] === "list") {
  if (mode !== "empty") console.log("Checking MCP server health…\n\nclaude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected\nclaude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\nclaude.ai Microsoft 365: https://m365.example/mcp - ! Needs authentication\nlively: /x/bin/lively mcp - ✔ Connected\nplugin:playwright:playwright: npx @playwright/mcp@latest - ✘ Failed to connect");
  process.exit(0);
}
if (a[0] === "-p") {
  let prompt = "";
  process.stdin.on("data", (c) => { prompt += c; }).on("end", () => {
    fs.writeFileSync(log, JSON.stringify({ argv: a, prompt, home: process.env.HOME, off: process.env.LIVELY_OFF, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null }));
    if (mode === "hang") { setInterval(() => {}, 1000); return; }
    const s = JSON.parse(fs.readFileSync(a[a.indexOf("--settings") + 1], "utf8"));
    const pre = s.hooks.PreToolUse[0].hooks[0].command, post = s.hooks.PostToolUse[0].hooks[0].command;
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    out({ type: "system", subtype: "init", claude_code_version: "2.1.301", model: "claude-haiku-5-5", permissionMode: "dontAsk", tools: ["mcp__claude_ai_Slack__slack_read_channel"], mcp_servers: [{ name: "claude.ai Slack", status: "connected" }] });
    const call = (id, name, resp) => {
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });
      const g = cp.spawnSync("sh", ["-c", pre], { input: JSON.stringify({ tool_name: name, tool_input: {}, tool_use_id: id }), encoding: "utf8" });
      if (g.status !== 0) { out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: g.stderr }] } }); return; }
      cp.spawnSync("sh", ["-c", post], { input: JSON.stringify({ tool_name: name, tool_input: {}, tool_use_id: id, tool_response: resp }), encoding: "utf8" });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: resp }] } });
    };
    call("t1", "mcp__claude_ai_Slack__slack_read_channel", [{ type: "text", text: "원문 하나" }]);
    call("t2", "mcp__claude_ai_Slack__slack_send_message", [{ type: "text", text: "보냄" }]);
    out({ type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 1234, total_cost_usd: 0.0012, usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 7 }, result: "Slack: 성공" });
    process.exit(0);
  });
  return;
}
process.exit(3);
`.replace("__NODE__", NODE);
const fakeBin = path.join(tmp, "fake-claude");
fs.writeFileSync(fakeBin, FAKE, { mode: 0o755 });

type Run = { dir: string; exit: Record<string, unknown>; summary: Record<string, any>; fake: Record<string, any> | null };
/** 실행 폴더를 쓰기 셸(collectWriteSh)로 만들고 러너를 돌린다 — 게이트웨이가 하는 일과 같은 순서. */
function runOnce(label: string, o: { apps: string[]; mode?: string; timeoutSec?: number; job?: string }): Run {
  const home = path.join(tmp, `home-${label}`);
  fs.mkdirSync(home, { recursive: true });
  const runId = newCollectRunId(new Date(), crypto.randomBytes(6).toString("hex"));
  const dir = collectRunDir(home, runId);
  const job = { ...collectJob({ runId, home, prompt: "점검 지시", apps: o.apps }), bin: fakeBin, ...(o.timeoutSec ? { timeoutSec: o.timeoutSec } : {}) };
  const w = spawnSync("sh", ["-c", collectWriteSh(dir, { "job.json": o.job ?? JSON.stringify(job), "run.cjs": COLLECT_RUNNER_JS, "gate.cjs": COLLECT_GATE_JS, "cap.cjs": COLLECT_CAPTURE_JS })], { encoding: "utf8" });
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /written/);
  const logFile = path.join(tmp, `fake-${label}.json`);
  const r = spawnSync(NODE, [path.join(dir, "run.cjs"), dir], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, FAKE_MODE: o.mode ?? "", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-SHOULD-NOT-LEAK" },
  });
  assert.equal(r.status, 0, `러너 종료 코드 — ${r.stderr}`);
  const read = (f: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  return { dir, exit: read("exit.json"), summary: fs.existsSync(path.join(dir, "summary.json")) ? read("summary.json") : {}, fake: fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : null };
}
const flagArgs = (argv: string[], flag: string): string[] => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const end = argv.findIndex((x, k) => k > i && x.startsWith("--"));
  return argv.slice(i + 1, end < 0 ? argv.length : end);
};

const R1 = runOnce("r1", { apps: ["Slack"] });
t("R1 배선 — claude -p 가 실제로 불렸다", () => assert.ok(R1.fake, "가짜 claude 의 -p 기록이 없다"));
t("R1 허락 앱만 allow · 그 밖의 서버는 전부 deny · 내장 도구도 deny", () => {
  const argv = R1.fake!.argv as string[];
  assert.deepEqual(flagArgs(argv, "--allowedTools"), ["mcp__claude_ai_Slack"]);
  const deny = flagArgs(argv, "--disallowedTools");
  for (const d of ["mcp__claude_ai_Notion", "mcp__claude_ai_Microsoft_365", "mcp__lively", "mcp__plugin_playwright_playwright", "Bash", "WebFetch"]) assert.ok(deny.includes(d), `deny 에 ${d}`);
  assert.ok(!deny.includes("mcp__claude_ai_Slack"), "허락한 앱은 deny 에 없다");
});
t("R1 지원하는 플래그를 붙인다 · 지시는 stdin · 모델 고정", () => {
  const argv = R1.fake!.argv as string[];
  assert.deepEqual(flagArgs(argv, "--tools"), [""], "--tools \"\" — 내장 도구를 아예 싣지 않는다");
  assert.deepEqual(flagArgs(argv, "--permission-mode"), ["dontAsk"]);
  assert.ok(argv.includes("--no-session-persistence") && argv.includes("--disable-slash-commands"));
  assert.deepEqual(flagArgs(argv, "--model"), ["haiku"]);
  assert.ok(!argv.includes("점검 지시"), "지시는 argv 가 아니라 stdin 으로 간다");
  assert.equal(R1.fake!.prompt, "점검 지시");
});
t("R1 정식 로그인으로만 돈다 — 토큰 env 는 지우고 HOME 은 그 사람 홈 · 라이블리 훅은 끈다", () => {
  assert.equal(R1.fake!.token, null, "CLAUDE_CODE_OAUTH_TOKEN 이 claude 까지 가면 커넥터가 안 뜬다");
  assert.match(String(R1.fake!.home), /home-r1$/);
  assert.equal(R1.fake!.off, "1");
});
t("R1 요약·끝 신호 — 커넥터·허락·호출·원문 목록·결과", () => {
  assert.equal(R1.exit.code, 0);
  assert.equal(R1.exit.error, null);
  const s = R1.summary;
  assert.equal(s.claude.version, "2.1.301");
  assert.deepEqual(s.allowed, ["Slack"]);
  assert.deepEqual(s.missing, []);
  assert.equal(s.denied, 4, "Notion · Microsoft 365 · lively · playwright");
  assert.equal(s.captures, 1, "막힌 쓰기 호출은 원문이 없다");
  assert.deepEqual(s.calls.map((c: any) => [c.tool, c.error]), [["mcp__claude_ai_Slack__slack_read_channel", false], ["mcp__claude_ai_Slack__slack_send_message", true]]);
  assert.equal(s.result.subtype, "success");
  assert.deepEqual(s.result.usage, { in: 5, cacheWrite: 100, cacheRead: 50, out: 7 });
  assert.equal(typeof s.mem.samples, "number");
  assert.equal(s.connectors.find((c: any) => c.app === "Microsoft 365").status, "needs-auth");
  assert.ok(!fs.existsSync(path.join(R1.dir, "runner.pid")), "끝나면 pid 파일을 치운다");
});

const R2 = runOnce("r2", { apps: ["Gmail"] });
t("R2 요청 앱이 없으면 claude -p 를 안 띄우고 실패로 적는다(«새 글 없음» 이 아니다)", () => {
  assert.equal(R2.exit.error, "no-connector");
  assert.deepEqual(R2.summary.missing, ["Gmail"]);
  assert.equal(R2.fake, null, "claude -p 가 돌지 않았다");
});
const R3 = runOnce("r3", { apps: [] });
t("R3 apps 가 비면 연결된 커넥터 전부 — needs-auth 는 뺀다", () => {
  assert.deepEqual(flagArgs(R3.fake!.argv, "--allowedTools").sort(), ["mcp__claude_ai_Notion", "mcp__claude_ai_Slack"]);
  assert.ok(flagArgs(R3.fake!.argv, "--disallowedTools").includes("mcp__claude_ai_Microsoft_365"));
  assert.deepEqual(R3.summary.allowed.sort(), ["Notion", "Slack"]);
});
const R4 = runOnce("r4", { apps: ["Slack"], mode: "old" });
t("R4 옛 claude 에는 모르는 플래그를 안 붙인다", () => {
  const argv = R4.fake!.argv as string[];
  for (const f of ["--tools", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(!argv.includes(f), f);
  assert.ok(!argv.includes("dontAsk"));
  assert.deepEqual(flagArgs(argv, "--allowedTools"), ["mcp__claude_ai_Slack"], "allow/deny 는 그대로");
  assert.equal(R4.exit.code, 0);
});
const R5 = runOnce("r5", { apps: ["Slack"], mode: "empty" });
t("R5 서버 목록이 비면 no-connector — claude -p 안 뜸", () => {
  assert.equal(R5.exit.error, "no-connector");
  assert.equal(R5.fake, null);
});
const R6 = runOnce("r6", { apps: ["Slack"], mode: "hang", timeoutSec: 2 });
t("R6 시간 상한을 넘기면 끊고 timeout 으로 끝낸다 — 끝 신호가 남는다", () => {
  assert.ok(R6.fake, "claude -p 는 떴다");
  assert.equal(R6.exit.timedOut, true);
  assert.equal(R6.exit.error, "timeout");
});
const R7 = runOnce("r7", { apps: ["Slack"], job: "{not json" });
t("R7 일감이 깨지면 실패로 끝 신호를 남긴다", () => {
  assert.match(String(R7.exit.error), /^job\.json/);
  assert.equal(R7.fake, null);
});

// ── 쓰기·읽기 셸 ──
t("S1 쓰기 셸 — 파일 넷 · 0600", () => {
  for (const f of ["job.json", "run.cjs", "gate.cjs", "cap.cjs"]) assert.equal(fs.statSync(path.join(R1.dir, f)).mode & 0o777, 0o600, f);
});
t("S2 읽기 셸 — 끝난 실행 · 세션 id · 원문 목록", () => {
  const note = spawnSync("sh", ["-c", collectSessionNoteSh(R1.dir, "box-yoon-1a2b3c4d")], { encoding: "utf8" });
  assert.equal(note.status, 0);
  const r = parseCollectRead(spawnSync("sh", ["-c", collectReadSh(R1.dir)], { encoding: "utf8" }).stdout);
  assert.equal(r.state, "done");
  assert.equal(r.sessionId, "box-yoon-1a2b3c4d");
  assert.equal(r.captures.length, 1);
  assert.equal(r.captures[0].tool, "mcp__claude_ai_Slack__slack_read_channel");
  assert.equal((r.summary as Record<string, unknown>).runId, path.basename(R1.dir));
});
t("S3 읽기 셸 — 없는 폴더 · 도는 중(끝 신호 없음, 반쯤 쓰인 줄은 버림)", () => {
  const dir = collectRunDir(path.join(tmp, "home-s3"), newCollectRunId(new Date(), "abcdef"));
  assert.equal(parseCollectRead(spawnSync("sh", ["-c", collectReadSh(dir)], { encoding: "utf8" }).stdout).state, "missing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "caps.jsonl"), "{\"ts\":\"x\",\"tool\":\"a\"}\n{\"ts\":\"y\",\"to");
  const r = parseCollectRead(spawnSync("sh", ["-c", collectReadSh(dir)], { encoding: "utf8" }).stdout);
  assert.equal(r.state, "running");
  assert.equal(r.captures.length, 1);
  assert.equal(r.sessionId, null);
});

// ── 순수 함수 ──
t("P1 실행 id 모양 · 시작 시각", () => {
  const id = newCollectRunId(new Date(Date.UTC(2026, 9, 16, 3, 4, 5)), "AB-c9xyz");
  assert.equal(id, "cr-20261016030405-abc9xy");
  assert.ok(COLLECT_RUN_ID_RE.test(id));
  assert.equal(collectRunStartedAt(id), Date.UTC(2026, 9, 16, 3, 4, 5));
  assert.equal(collectRunStartedAt("nope"), null);
});
t("P2 실행 폴더 모양 — 판 명령의 재료라 좁힌다", () => {
  assert.ok(isCollectRunDir("/home/box_yoon/.cache/lvly-collect/cr-20261016030405-abc9xy"));
  for (const bad of ["home/box/.cache/lvly-collect/cr-20261016030405-abc9xy", "/home/box/../etc/.cache/lvly-collect/cr-20261016030405-abc9xy",
    "/home/box x/.cache/lvly-collect/cr-20261016030405-abc9xy", "/home/box;rm/.cache/lvly-collect/cr-20261016030405-abc9xy",
    "/home/box/.cache/lvly-collect/cr-2026", "/home/box/.cache/other/cr-20261016030405-abc9xy", ""]) {
    assert.ok(!isCollectRunDir(bad), bad);
  }
  assert.throws(() => collectRunDir("/home/x", "../../etc"));
});
t("P3 판 명령 — 러너 하나(셸로 감싸지 않는다)", () => {
  const d = "/home/box_yoon/.cache/lvly-collect/cr-20261016030405-abc9xy";
  assert.deepEqual(collectPaneArgv(d), ["node", `${d}/run.cjs`, d]);
  assert.throws(() => collectPaneArgv("/tmp/x; rm -rf /"));
});
t("P4 일감 경계 — 턴 1·60 · 시간 60·3600 · 빈 지시 거절 · 이상한 모델 · 앱 이름 거르기", () => {
  const J = (o: Partial<Parameters<typeof collectJob>[0]>) => collectJob({ runId: "cr-20261016030405-abc9xy", home: "/h", prompt: "x", ...o });
  assert.equal(J({ maxTurns: 1 }).maxTurns, 1);
  assert.equal(J({ maxTurns: 60 }).maxTurns, 60);
  assert.equal(J({ maxTurns: 0 }).maxTurns, 1);
  assert.equal(J({ maxTurns: 61 }).maxTurns, 60);
  assert.equal(J({}).maxTurns, 12);
  assert.equal(J({ timeoutSec: 60 }).timeoutSec, 60);
  assert.equal(J({ timeoutSec: 3600 }).timeoutSec, 3600);
  assert.equal(J({ timeoutSec: 59 }).timeoutSec, 60);
  assert.equal(J({ timeoutSec: 3601 }).timeoutSec, 3600);
  assert.equal(J({}).timeoutSec, 900);
  assert.equal(J({ prompt: "  지시  " }).prompt, "지시");
  assert.throws(() => J({ prompt: "   " }));
  assert.equal(J({}).model, "haiku");
  assert.equal(J({ model: "sonnet; rm" }).model, "haiku");
  assert.equal(J({ model: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
  assert.deepEqual(J({ apps: ["Slack", "Google Drive", "bad;app", "", "Slack"] }).apps, ["Slack", "Google Drive"]);
});
t("P5 메모리 env 경계 — 128·8192 그대로 · 범위 밖은 기본 · 예약은 캡 이하", () => {
  assert.deepEqual(collectMemLimits({}), { maxMb: 768, requestMb: 384 });
  assert.deepEqual(collectMemLimits({ LIVELY_COLLECT_MEM_MB: "128", LIVELY_COLLECT_MEM_REQUEST_MB: "128" }), { maxMb: 128, requestMb: 128 });
  assert.deepEqual(collectMemLimits({ LIVELY_COLLECT_MEM_MB: "8192", LIVELY_COLLECT_MEM_REQUEST_MB: "8192" }), { maxMb: 8192, requestMb: 8192 });
  assert.deepEqual(collectMemLimits({ LIVELY_COLLECT_MEM_MB: "127", LIVELY_COLLECT_MEM_REQUEST_MB: "8193" }), { maxMb: 768, requestMb: 384 });
  assert.deepEqual(collectMemLimits({ LIVELY_COLLECT_MEM_MB: "512", LIVELY_COLLECT_MEM_REQUEST_MB: "900" }), { maxMb: 512, requestMb: 512 });
  assert.deepEqual(collectMemLimits({ LIVELY_COLLECT_MEM_MB: "abc" }), { maxMb: 768, requestMb: 384 });
});
t("P6 쓰기 셸은 이상한 파일 이름·폴더·세션 id 를 거절한다", () => {
  const d = "/home/box_yoon/.cache/lvly-collect/cr-20261016030405-abc9xy";
  assert.throws(() => collectWriteSh(d, { "../x": "1" }));
  assert.throws(() => collectWriteSh("/tmp/x", { "a.json": "1" }));
  assert.throws(() => collectSessionNoteSh(d, "box;rm"));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed`);

#!/usr/bin/env node
// grok **실기기** E2E 테스트(#1701, 런북 ⑤층) — 실제 grok 바이너리가 우리 배선(lively-grok.json → grok-adapter →
//  러너)을 정말로 읽고·발화하고·deny 를 존중하는지를 **밀폐(무계정)** 로 검증한다.
//  핵심 장치: [model.stub] base_url → 로컬 OpenAI 호환 스텁 서버 + api_key="dummy" 가 grok 의 로그인 게이트를
//  완전 우회한다([[grok-harness-spec-1701]] §8 실측). 스텁이 tool_calls 를 내면 실툴 실행·훅 발화까지 전부 진짜다.
//
//  grok 미설치면 skip(exit 0) — CI 에 grok 이 없어도 초록. 러너 5종은 캡처 스텁으로 바꿔 argv/stdin/env 를 관측한다
//  (어댑터·lively-grok.json·grok 바이너리는 전부 **진짜** — 관측 지점만 러너다. 러너 로직은 자기 테스트가 있다).
//  엣지 표(E0~E5): 스크래치패드 spec.md — 케이스 이름의 [E#] 가 그 행 번호다.
//  실행: node kit/setup/grok-e2e.test.mjs   (느림 ~30s — grok 세션 3회)
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── grok 존재 판정(skip 게이트) ──
function grokBin() {
  for (const c of [process.env.GROK_E2E_BIN, join(process.env.HOME || "", ".grok", "bin", "grok"), "grok"]) {
    if (!c) continue;
    try { execFileSync(c, ["--version"], { stdio: "pipe", timeout: 15000 }); return c; } catch { /* 다음 후보 */ }
  }
  return null;
}
const GROK_BIN = grokBin();
if (!GROK_BIN) {
  console.log("· grok 바이너리 없음 — 실기기 E2E skip (설치: curl -fsSL https://x.ai/cli/install.sh | bash)");
  process.exit(0);
}

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SB = mkdtempSync(join(tmpdir(), "grok-e2e-"));
const HOME = join(SB, "home");
const GROKHOME = join(HOME, ".grok");
const PROJ = join(SB, "proj");
const CAP = join(SB, "captures");
const REQLOG = join(SB, "reqlog");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const capOf = (name) => {
  try { return readFileSync(join(CAP, name + ".log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
  catch { return []; }
};
const resetCaps = () => { rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true }); };

// ── 스텁 모델 서버(OpenAI 호환 SSE) — **반드시 별도 프로세스**로 띄운다. 같은 프로세스에 두고 grok 을
//  spawnSync 로 돌리면 이벤트 루프가 멈춰 서버가 응답을 못 하고 세션이 통째로 매달린다(런북 ③층 함정 —
//  이 테스트 첫 판이 정확히 그렇게 죽었다). 시나리오는 파일로 넘긴다(프로세스 경계 너머 제어).
//  main 호출(run_terminal_command 광고)엔 툴콜 1회 → 결과 오면 STUB_DONE. mcp 시나리오면 use_tool 호출.
const SCENARIO_FILE = join(SB, "scenario");
const setScenario = (v) => writeFileSync(SCENARIO_FILE, v);
setScenario("shell");
writeFileSync(join(SB, "stub-model.mjs"), `
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const REQLOG = ${JSON.stringify(REQLOG)};
let reqNo = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let d = {}; try { d = JSON.parse(body); } catch { /* */ }
    try { writeFileSync(join(REQLOG, "req-" + String(reqNo++).padStart(3, "0") + ".json"), JSON.stringify(d)); } catch { /* */ }
    let scenario = "shell"; try { scenario = readFileSync(${JSON.stringify(SCENARIO_FILE)}, "utf8").trim(); } catch { /* */ }
    const tools = (d.tools || []).map((t) => t?.function?.name);
    const hasToolResult = (d.messages || []).some((m) => m?.role === "tool");
    // ⚠ "connection: close" 필수(실측) — keep-alive 로 두면 grok(1.0.3)의 SSE 클라이언트가 [DONE] 뒤에도
    //  스트림 종료를 못 보고 세션이 매달린다(python HTTP/1.0 스텁에선 우연히 닫혀 발현 안 했던 함정).
    res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
    const chunk = (delta, finish) => res.write("data: " + JSON.stringify({
      id: "c", object: "chat.completion.chunk", created: 0, model: "stub",
      choices: [{ index: 0, delta, finish_reason: finish || null }],
      ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    }) + "\\n\\n");
    const isMain = tools.includes("run_terminal_command");
    if (isMain && !hasToolResult) {
      const call = scenario === "mcp" && tools.includes("use_tool")
        ? { name: "use_tool", arguments: JSON.stringify({ tool_name: "livelystub__whoami", tool_input: {} }) }
        : { name: "run_terminal_command", arguments: JSON.stringify({ command: "echo E2E_OK", description: "probe" }) };
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: call }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "STUB_DONE" });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\\n\\n");
  });
});
server.listen(0, "127.0.0.1", () => { console.log("PORT=" + server.address().port); });
`);
mkdirSync(REQLOG, { recursive: true });
const serverProc = spawn(process.execPath, [join(SB, "stub-model.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const PORT = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("스텁 모델 서버 기동 타임아웃")), 10000);
  serverProc.stdout.on("data", (c) => {
    buf += c;
    const m = /PORT=(\d+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});

// ── 샌드박스 구성: 발행 번들 재현 → user-install --harness grok → 러너를 캡처 스텁으로 치환 ──
const { HOOK_SCRIPTS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
// 번들 setup/ 목록은 매니페스트 단일 출처를 따른다 — 사본을 두면 파일이 하나 늘 때 여기만 빠져
//  "설치기가 번들 안에서 import 크래시" 로 죽는다(kit-manifest.SETUP_FILES 주석 참조).
const { SETUP_FILES } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
function setup() {
  mkdirSync(join(PROJ), { recursive: true });
  mkdirSync(CAP, { recursive: true }); mkdirSync(REQLOG, { recursive: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "gateway-url"), "http://127.0.0.1:9\n");   // 토큰 없음 = 네트워크 미접촉
  const BUNDLE = join(SB, "bundle");
  mkdirSync(join(BUNDLE, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(BUNDLE, ".lively"), { recursive: true });
  mkdirSync(join(BUNDLE, "setup"), { recursive: true });
  mkdirSync(join(BUNDLE, "cli"), { recursive: true });
  for (const h of HOOK_SCRIPTS) cpSync(join(KIT, "hooks", h), join(BUNDLE, ".claude", "hooks", h));
  for (const f of SETUP_FILES) cpSync(join(KIT, "setup", f), join(BUNDLE, "setup", f));
  for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: ["mcp__lively__whoami"] }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
  // 사용자 영역 config.toml — 스텁 모델(로그인 게이트 우회, §8) + MCP 스텁 서버. 설치기는 이 사용자 영역을 보존한다.
  mkdirSync(GROKHOME, { recursive: true });
  writeFileSync(join(GROKHOME, "config.toml"), [
    "[model.stub]",
    'model = "stub-1"',
    `base_url = "http://127.0.0.1:${PORT}/v1"`,
    'api_key = "dummy"',
    "context_window = 128000", "",
    "[models]",
    'default = "stub"', "",
    "[mcp_servers.livelystub]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(join(SB, "stub-mcp.mjs"))}]`, "",
  ].join("\n"));
  // stdio MCP 스텁(툴 1개: whoami) — MCP 네이밍 축(E5) 관측용.
  writeFileSync(join(SB, "stub-mcp.mjs"), `
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    const { method: m, id } = req;
    if (m === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: req.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "livelystub", version: "0.0.1" } } });
    else if (m === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [{ name: "whoami", description: "who am i", inputSchema: { type: "object", properties: {} } }] } });
    else if (m === "tools/call") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "MCP_WHOAMI_OK" }], isError: false } });
    else if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result: {} });
  }
});
`);
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "grok", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  // 러너 5종을 캡처 스텁으로 치환(관측 장치) — 어댑터·harness-registry 는 진짜 그대로 둔다.
  for (const f of ["run-custom.mjs", "work-flag.mjs", "session-preload.mjs", "sync-harness-assets.mjs", "stop-writeback-gate.mjs"]) {
    writeFileSync(join(HOME, ".lively", "hooks", f), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(join(CAP, f + ".log"))}, JSON.stringify({ argv: process.argv.slice(2), stdin, harness: process.env.LIVELY_HARNESS || "" }) + "\\n");
  try { process.stdout.write(readFileSync(${JSON.stringify(join(SB, f + ".out"))}, "utf8")); } catch { /* 무출력 */ }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
`);
    chmodSync(join(HOME, ".lively", "hooks", f), 0o755);
  }
}
const setRunnerOut = (name, out) => writeFileSync(join(SB, name + ".out"), out);
const clearRunnerOut = (name) => { try { rmSync(join(SB, name + ".out"), { force: true }); } catch { /* */ } };

// grok 실행 — env 를 최소로 통제(HOME·GROK_HOME 샌드박스 + node/grok PATH). compat 스캔도 샌드박스 HOME 을 본다.
function runGrok(args, { timeout = 90000 } = {}) {
  const PATH = [dirname(process.execPath), dirname(GROK_BIN), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return spawnSync(GROK_BIN, args, {
    cwd: PROJ, encoding: "utf8", timeout,
    env: { HOME, GROK_HOME: GROKHOME, PATH, TERM: "xterm", GROK_DISABLE_AUTOUPDATER: "1" },
  });
}

try {
  setup();

  // [E0] 실기기 로더가 우리 배선을 읽나 — inspect --json 의 hooks/mcpServers 로 단언(파일 존재 ≠ 로드, 런북 ⑫).
  {
    const r = runGrok(["inspect", "--json"]);
    let d = {}; try { d = JSON.parse(r.stdout); } catch { /* */ }
    const ours = (d.hooks || []).filter((h) => String(h.target || "").includes("grok-adapter.mjs"));
    const events = [...new Set(ours.map((h) => h.event))].sort();
    eq("E0a 우리 훅 10이벤트 로드", events, ["notification", "post_tool_use", "pre_compact", "pre_tool_use", "post_compact", "session_end", "session_start", "stop", "subagent_stop", "user_prompt_submit"].sort());
    const mcp = (d.mcpServers || []).find((m) => m.name === "lively");
    eq("E0b MCP lively 등재(configToml 출처)", [!!mcp, mcp?.source?.type], [true, "configToml"]);
  }

  // [E1][E2][E3] 스텁 모델 세션 — 툴콜 1회 완주 + 어댑터 경유 러너 발화 + 페이로드.
  {
    resetCaps();
    const r = runGrok(["-p", "run the echo command", "-m", "stub", "--always-approve", "--output-format", "json"]);
    let out = {}; try { out = JSON.parse(r.stdout); } catch { /* */ }
    eq("E1 세션 완주(text=STUB_DONE)", [r.status, out.text], [0, "STUB_DONE"]);
    const events = capOf("run-custom.mjs").map((c) => c.argv[0]);
    const want = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
    eq("E2a run-custom 이벤트 발화(각 ≥1회)", want.map((e) => events.includes(e)), want.map(() => true));
    eq("E2b 전부 LIVELY_HARNESS=grok", [...new Set(capOf("run-custom.mjs").map((c) => c.harness))], ["grok"]);
    const pre = capOf("run-custom.mjs").find((c) => c.argv[0] === "PreToolUse");
    const sent = JSON.parse(pre?.stdin || "{}");
    const okE3 = sent.tool_name === "run_terminal_command" && String(sent.session_id || "").length > 0 && String(sent.transcript_path || "").endsWith("updates.jsonl");
    okE3 ? ok("E3 PreToolUse 페이로드(tool_name·session_id·transcript_path)") : bad("E3 PreToolUse 페이로드", JSON.stringify(sent).slice(0, 300));
  }

  // [E4] org deny E2E — 러너가 deny 를 내면 실툴이 안 돌고 모델에 사유가 간다(세션은 계속).
  {
    resetCaps();
    // reqNo 는 자식(스텁 서버)이 세므로 파일만 비운다 — 번호는 이어지지만 디렉터리 전수 스캔이라 무관.
    rmSync(REQLOG, { recursive: true, force: true }); mkdirSync(REQLOG, { recursive: true });
    setRunnerOut("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "E2E_POLICY_BLOCK" } }));
    const r = runGrok(["-p", "run the echo command", "-m", "stub", "--always-approve", "--output-format", "json"]);
    let out = {}; try { out = JSON.parse(r.stdout); } catch { /* */ }
    eq("E4a deny 세션도 완주", [r.status, out.text], [0, "STUB_DONE"]);
    eq("E4b post_tool_use 0회(툴 미실행)", capOf("run-custom.mjs").filter((c) => c.argv[0] === "PostToolUse").length, 0);
    const toolMsgs = readdirSync(REQLOG).flatMap((f) => {
      try { return (JSON.parse(readFileSync(join(REQLOG, f), "utf8")).messages || []).filter((m) => m.role === "tool"); } catch { return []; }
    });
    toolMsgs.some((m) => /Hook denied/.test(String(m.content)) && /E2E_POLICY_BLOCK/.test(String(m.content)))
      ? ok("E4c 모델이 받은 결과에 Hook denied + 사유") : bad("E4c 모델이 받은 결과에 Hook denied + 사유", JSON.stringify(toolMsgs).slice(0, 300));
    clearRunnerOut("run-custom.mjs");
  }

  // [E5] MCP 네이밍 E2E — use_tool 경유 호출이 훅에 `<server>__<tool>`(mcp__ 접두 없음)로 오고 언랩된다.
  {
    resetCaps();
    setScenario("mcp");
    const r = runGrok(["-p", "call the whoami mcp tool", "-m", "stub", "--always-approve", "--output-format", "json"]);
    let out = {}; try { out = JSON.parse(r.stdout); } catch { /* */ }
    eq("E5a MCP 세션 완주", [r.status, out.text], [0, "STUB_DONE"]);
    const pre = capOf("run-custom.mjs").filter((c) => c.argv[0] === "PreToolUse").map((c) => JSON.parse(c.stdin || "{}"));
    const hit = pre.find((p) => p.tool_name === "livelystub__whoami");
    hit ? ok("E5b 훅 tool_name = livelystub__whoami(mcp__ 접두 없음)") : bad("E5b 훅 tool_name = livelystub__whoami", JSON.stringify(pre.map((p) => p.tool_name)));
    if (hit) eq("E5c use_tool 래퍼 언랩(tool_input 내부값)", hit.tool_input, {});
  }
} catch (e) {
  bad("E2E 수행", e?.message || String(e));
} finally {
  try { serverProc.kill(); } catch { /* */ }
  rmSync(SB, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} grok-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

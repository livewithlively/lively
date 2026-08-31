#!/usr/bin/env node
// codex **실기기** E2E 테스트(#1884, grok-e2e 의 codex 판) — 실제 codex 바이너리가 우리 배선(~/.codex/config.toml 의
//  lively-managed 블록 → [[hooks.*]] 러너 · [mcp_servers.*])을 정말로 읽고·발화하고·deny 를 존중하고·주입 컨텍스트를
//  모델에 넘기는지를 **밀폐(무계정)** 로 검증한다.
//  핵심 장치: [model_providers.stub] base_url → 로컬 Responses API 스텁 서버 + requires_openai_auth=false + env_key 더미가
//  codex 의 로그인 게이트를 완전 우회한다(0.149.1 실측). 스텁이 function_call 을 내면 실툴 실행·훅 발화까지 전부 진짜다.
//   ⚠ wire_api 는 "responses" 여야 한다 — "chat" 은 0.149 에서 "no longer supported" 로 거부된다(실측).
//
//  codex 미설치면 skip(exit 0) — CI 에 codex 가 없어도 초록. 러너 5종은 캡처 스텁으로 바꿔 argv/stdin/env 를 관측한다
//  (설치기·config.toml·codex 바이너리는 전부 **진짜** — 관측 지점만 러너다. 러너 로직은 자기 테스트가 있다).
//  정적 배선 사양은 codex-wiring.test.mjs(설치기 출력 텍스트) — 이 파일은 그 위층(실제 로더·실제 발화)이다.
//  실행: node kit/setup/codex-e2e.test.mjs   (느림 ~30-60s — codex 세션 4회)
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

// ── codex 존재 판정(skip 게이트) ──
function codexBin() {
  for (const c of [process.env.CODEX_E2E_BIN, join(homedir(), ".local", "bin", "codex"), "codex"]) {
    if (!c) continue;
    try { execFileSync(c, ["--version"], { stdio: "pipe", timeout: 15000 }); return c; } catch { /* 다음 후보 */ }
  }
  return null;
}
const CODEX_BIN = codexBin();
if (!CODEX_BIN) {
  console.log("· codex 바이너리 없음 — 실기기 E2E skip (설치: npm i -g @openai/codex)");
  process.exit(0);
}
// 심링크(~/.local/bin/codex → releases/…/bin/codex)를 풀어 PATH 에 실제 디렉터리를 넣는다.
const CODEX_REAL = (() => { try { return realpathSync(CODEX_BIN); } catch { return CODEX_BIN; } })();

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
// realpath — macOS 의 tmpdir 은 /var → /private/var 심링크라 seatbelt(workspace-write) 경로 판정이 어긋날 수 있다.
const SB = realpathSync(mkdtempSync(join(tmpdir(), "codex-e2e-")));
const HOME = join(SB, "home");
const CODEXHOME = join(HOME, ".codex");
const PROJ = join(SB, "proj");
const CAP = join(SB, "captures");
const REQLOG = join(SB, "reqlog");
const MARKER = join(PROJ, "RAN");               // 실툴이 실제로 돌았는지의 물증(cwd 안 = workspace-write 쓰기 가능)
const CMD = `echo E2E_OK > ${MARKER}`;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const capOf = (name) => {
  try { return readFileSync(join(CAP, name + ".log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
  catch { return []; }
};
const stdinOf = (c) => { try { return JSON.parse(c?.stdin || "{}"); } catch { return {}; } };
const resetCaps = () => { rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true }); };
const resetReqlog = () => { rmSync(REQLOG, { recursive: true, force: true }); mkdirSync(REQLOG, { recursive: true }); };
const reqBodies = () => readdirSync(REQLOG).sort().map((f) => { try { return readFileSync(join(REQLOG, f), "utf8"); } catch { return ""; } });

// ── 스텁 모델 서버(Responses API SSE) — **반드시 별도 프로세스**로 띄운다. 같은 프로세스에 두고 codex 를
//  spawnSync 로 돌리면 이벤트 루프가 멈춰 서버가 응답을 못 하고 세션이 통째로 매달린다(grok-e2e 첫 판이 그렇게 죽었다).
//  시나리오는 파일로 넘긴다(프로세스 경계 너머 제어): text = 곧장 STUB_DONE · shell = exec_command 툴콜 1회 → 결과
//  (function_call_output)가 오면 STUB_DONE. 요청 본문은 전부 REQLOG 에 남긴다(deny 사유·컨텍스트 주입 관측용).
const SCENARIO_FILE = join(SB, "scenario");
const setScenario = (v) => writeFileSync(SCENARIO_FILE, v);
setScenario("text");
writeFileSync(join(SB, "stub-model.mjs"), `
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const REQLOG = ${JSON.stringify(REQLOG)};
const CMD = ${JSON.stringify(CMD)};
let reqNo = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (!/\\/responses$/.test(req.url || "")) { res.writeHead(404, { "content-type": "application/json", "connection": "close" }); res.end("{}"); return; }
    let d = {}; try { d = JSON.parse(body); } catch { /* */ }
    try { writeFileSync(join(REQLOG, "req-" + String(reqNo++).padStart(3, "0") + ".json"), JSON.stringify(d)); } catch { /* */ }
    let scenario = "text"; try { scenario = readFileSync(${JSON.stringify(SCENARIO_FILE)}, "utf8").trim(); } catch { /* */ }
    const tools = (d.tools || []).map((t) => t?.name || t?.function?.name);
    const input = Array.isArray(d.input) ? d.input : [];
    const hasToolResult = input.some((i) => /output/.test(String(i?.type || "")));
    // ⚠ "connection: close" — keep-alive 로 두면 SSE 클라이언트가 스트림 종료를 못 보고 매달릴 수 있다(grok 실측 함정).
    res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
    const sse = (type, obj) => res.write("event: " + type + "\\ndata: " + JSON.stringify({ type, ...obj }) + "\\n\\n");
    const item = (scenario === "shell" && tools.includes("exec_command") && !hasToolResult)
      ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: CMD }), status: "completed" }
      : { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "STUB_DONE", annotations: [] }] };
    sse("response.created", { response: { id: "resp_1", object: "response", status: "in_progress", output: [] } });
    sse("response.output_item.done", { output_index: 0, item });
    sse("response.completed", { response: { id: "resp_1", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
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

// ── 샌드박스 구성: 발행 번들 재현 → user-install --harness codex → 러너를 캡처 스텁으로 치환 ──
const { HOOK_SCRIPTS } = await import(pathToFileURL(join(KIT, "setup", "user-install.mjs")).href);
// 번들 setup/ 목록은 매니페스트 단일 출처를 따른다 — 사본을 두면 파일이 하나 늘 때 여기만 빠져
//  "설치기가 번들 안에서 import 크래시" 로 죽는다(kit-manifest.SETUP_FILES 주석 참조).
const { SETUP_FILES } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
function setup() {
  mkdirSync(PROJ, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: PROJ, stdio: "ignore" });   // 실패해도 --skip-git-repo-check 가 있다
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
  for (const f of ["lively.mjs", "lively-mcp-gateway.mjs"]) cpSync(join(KIT, "cli", f), join(BUNDLE, "cli", f));   // 심+프록시 = stdio 경로(lively·lively-local 등재 조건)
  writeFileSync(join(BUNDLE, ".lively-org-name"), "테스트조직\n");
  writeFileSync(join(BUNDLE, ".lively", "auto-approve.json"), JSON.stringify({ allow: ["mcp__lively__whoami"] }));
  writeFileSync(join(BUNDLE, ".lively", "mcp-servers.json"), JSON.stringify({ servers: [] }));
  // 사용자 영역 config.toml — 스텁 프로바이더(로그인 게이트 우회). 설치기는 센티넬 블록만 덧붙이고 이 줄들을 보존한다.
  mkdirSync(CODEXHOME, { recursive: true });
  writeFileSync(join(CODEXHOME, "config.toml"), [
    'model_provider = "stub"',
    'model = "stub-1"', "",
    "[model_providers.stub]",
    'name = "Stub"',
    `base_url = "http://127.0.0.1:${PORT}/v1"`,
    'env_key = "STUB_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false", "",
  ].join("\n"));
  const r = spawnSync(process.execPath, [join(BUNDLE, "setup", "user-install.mjs"), "--harness", "codex", "--clone-root", BUNDLE],
    { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`설치기 exit=${r.status}\n${r.stderr || r.stdout}`);
  // 러너 5종을 캡처 스텁으로 치환(관측 장치) — 설치기가 쓴 config.toml 은 진짜 그대로 둔다.
  //  출력은 `<name>.<Event>.out`(이벤트별) → `<name>.out`(공통) 순으로 찾는다 — deny JSON 을 PreToolUse 에만 주기 위함
  //  (모든 이벤트에 permissionDecision 을 흘리면 다른 이벤트의 해석이 오염된다).
  for (const f of ["run-custom.mjs", "work-flag.mjs", "session-preload.mjs", "sync-harness-assets.mjs", "stop-writeback-gate.mjs"]) {
    writeFileSync(join(HOME, ".lively", "hooks", f), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(join(CAP, f + ".log"))}, JSON.stringify({ argv: process.argv.slice(2), stdin, harness: process.env.LIVELY_HARNESS || "" }) + "\\n");
  const ev = process.argv[2] || "";
  for (const p of [${JSON.stringify(join(SB, f))} + "." + ev + ".out", ${JSON.stringify(join(SB, f + ".out"))}]) {
    try { process.stdout.write(readFileSync(p, "utf8")); break; } catch { /* 다음 후보 */ }
  }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
`);
    chmodSync(join(HOME, ".lively", "hooks", f), 0o755);
  }
}
const setRunnerOut = (name, out) => writeFileSync(join(SB, name + ".out"), out);
const clearRunnerOut = (name) => { try { rmSync(join(SB, name + ".out"), { force: true }); } catch { /* */ } };

// codex 실행 — env 를 최소로 통제(HOME·CODEX_HOME 샌드박스 + node/codex PATH). 훅 command 는 bare `node` 라 PATH 필수.
//  stdin 은 /dev/null — 열어 두면 "Reading additional input from stdin" 에서 매달린다(실측). exec 는 -a 를 받지 않는다.
function codexEnv() {
  const PATH = [dirname(process.execPath), dirname(CODEX_REAL), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return { HOME, CODEX_HOME: CODEXHOME, LIVELY_HOME: HOME, PATH, STUB_API_KEY: "dummy", TERM: "xterm", NO_COLOR: "1" };
}
function runCodex(prompt, { timeout = 90000 } = {}) {
  const args = ["exec", "-C", PROJ, "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-s", "workspace-write", "-m", "stub-1", prompt];
  const r = spawnSync(CODEX_BIN, args, { cwd: PROJ, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], env: codexEnv() });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: !!r.error };
}
const tail = (r) => `exit=${r.status}${r.timedOut ? "(timeout)" : ""} stdout=${JSON.stringify(r.stdout.slice(-200))} stderr=${JSON.stringify(r.stderr.slice(-300))}`;
const rmMarker = () => { try { rmSync(MARKER, { force: true }); } catch { /* */ } };

try {
  setup();

  // [E0] 실기기 로더가 우리 config.toml 을 읽나 — `codex mcp list` 는 설정을 파싱해 서버를 나열한다(파일 존재 ≠ 로드).
  //  lively(stdio 프록시)·lively-local(#1884 패리티 홀 메움) 둘 다 등재돼야 한다. 연결 성공은 요구하지 않는다(토큰 없음).
  {
    const r = spawnSync(CODEX_BIN, ["mcp", "list"], { env: codexEnv(), encoding: "utf8", timeout: 30000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const loaded = r.status === 0 && !/failed to load configuration|error/i.test(out);
    const names = ["lively", "lively-local"].filter((n) => new RegExp(`(^|\\s)${n}(\\s|$)`, "m").test(out));
    loaded && names.length === 2
      ? ok("E0 codex mcp list — config.toml 로드 + lively·lively-local 등재")
      : bad("E0 codex mcp list", `exit=${r.status} found=${names.join(",")} · ${out.split("\n").slice(0, 6).join(" | ")}`);
  }

  // [E1][E2][E6] 텍스트 세션 — 툴콜 없이 완주 + 세션 수명주기 4이벤트가 run-custom(조직 훅 러너)·work-flag(실행단계 보고) 양쪽에 온다.
  {
    resetCaps(); setScenario("text");
    const r = runCodex("say done");
    r.status === 0 && r.stdout.includes("STUB_DONE") ? ok("E1 텍스트 세션 완주(exit 0 · STUB_DONE)") : bad("E1 텍스트 세션 완주", tail(r));
    const caps = capOf("run-custom.mjs");
    const events = caps.map((c) => c.argv[0]);
    const want = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
    const missing = want.filter((e) => !events.includes(e));
    missing.length === 0 ? ok(`E2a run-custom 수명주기 이벤트 발화(${want.join("·")})`) : bad("E2a run-custom 이벤트", `누락: ${missing.join(",")} · 관측: ${[...new Set(events)].join(",")}`);
    eq("E2b run-custom 전부 LIVELY_HARNESS=codex", [...new Set(caps.map((c) => c.harness))], ["codex"]);
    // work-flag 는 이벤트 argv 가 없다(codexHookCmd) — stdin 의 hook_event_name 으로 읽는다.
    const wf = capOf("work-flag.mjs");
    const wfEvents = wf.map((c) => stdinOf(c).hook_event_name);
    const wfMissing = want.filter((e) => !wfEvents.includes(e));
    wfMissing.length === 0 ? ok(`E6a work-flag 수명주기 이벤트 발화(${want.join("·")})`) : bad("E6a work-flag 이벤트", `누락: ${wfMissing.join(",")} · 관측: ${[...new Set(wfEvents)].join(",")}`);
    eq("E6b work-flag 전부 LIVELY_HARNESS=codex", [...new Set(wf.map((c) => c.harness))], ["codex"]);
  }

  // [E3] 툴 세션 — exec_command 툴콜 1회가 PreToolUse(tool_name=Bash)·PostToolUse 로 오고 실제로 돈다(마커 파일).
  {
    resetCaps(); rmMarker(); setScenario("shell");
    const r = runCodex("run the echo command");
    r.status === 0 && r.stdout.includes("STUB_DONE") ? ok("E3a 툴 세션 완주(exit 0 · STUB_DONE)") : bad("E3a 툴 세션 완주", tail(r));
    const caps = capOf("run-custom.mjs");
    const pre = caps.find((c) => c.argv[0] === "PreToolUse");
    const post = caps.find((c) => c.argv[0] === "PostToolUse");
    pre && post ? ok("E3b PreToolUse + PostToolUse 발화") : bad("E3b PreToolUse + PostToolUse 발화", `pre=${!!pre} post=${!!post} · 관측: ${[...new Set(caps.map((c) => c.argv[0]))].join(",")}`);
    const sent = stdinOf(pre);
    const checks = {
      tool_name: sent.tool_name === "Bash",
      command: sent.tool_input?.command === CMD,
      session_id: String(sent.session_id || "").length > 0,
      transcript_path: String(sent.transcript_path || "").endsWith(".jsonl"),
    };
    Object.values(checks).every(Boolean)
      ? ok("E3c PreToolUse 페이로드(tool_name=Bash · tool_input.command · session_id · transcript_path=*.jsonl)")
      : bad("E3c PreToolUse 페이로드", `${JSON.stringify(checks)} · ${JSON.stringify(sent).slice(0, 300)}`);
    existsSync(MARKER) ? ok("E3d 실툴이 실제로 돌았다(마커 파일 존재)") : bad("E3d 실툴 실행", "마커 파일 없음");
    // 설치기가 work-flag 를 PostToolUse matcher "…|Bash" 에 붙였다 — 셸 툴이 Bash 로 매칭돼 실행단계 보고가 오는지.
    const wfPost = capOf("work-flag.mjs").map(stdinOf).find((s) => s.hook_event_name === "PostToolUse");
    wfPost && wfPost.tool_name === "Bash" ? ok("E6c work-flag PostToolUse(matcher Bash) 발화") : bad("E6c work-flag PostToolUse", JSON.stringify(wfPost || null).slice(0, 200));
  }

  // [E4] org deny E2E — PreToolUse 러너가 deny 를 내면 실툴이 안 돌고(마커 없음·PostToolUse 0) 세션은 계속(STUB_DONE).
  {
    //  ⚠ codex 는 `hookSpecificOutput.hookEventName` 이 **없으면 그 출력을 통째로 무시**한다("hook: PreToolUse Failed" + 툴 실행 =
    //   fail-open, 0.149.1 실측). grok 은 같은 필드를 안 봐서 grok-e2e 의 스텁이 그걸 빼고도 통과했다 — 하네스마다 다른 자리다.
    //   우리 러너(run-custom mergePreToolUse)는 hookEventName 을 항상 넣는다 → 여기 스텁도 러너와 같은 형태여야 한다(E4d 가 반대 경우를 고정).
    resetCaps(); rmMarker(); resetReqlog(); setScenario("shell");
    setRunnerOut("run-custom.mjs.PreToolUse", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "E2E_POLICY_BLOCK" } }));
    const r = runCodex("run the echo command");
    clearRunnerOut("run-custom.mjs.PreToolUse");
    r.status === 0 && r.stdout.includes("STUB_DONE") ? ok("E4a deny 세션도 완주(exit 0 · STUB_DONE)") : bad("E4a deny 세션 완주", tail(r));
    const post = capOf("run-custom.mjs").filter((c) => c.argv[0] === "PostToolUse").length;
    const ran = existsSync(MARKER);
    !ran && post === 0 ? ok("E4b 실툴 미실행(마커 없음 · PostToolUse 0회)") : bad("E4b 실툴 미실행", `marker=${ran} postToolUse=${post}`);
    // 모델이 받은 툴 결과(function_call_output)에 거부 사유가 실리나 — 느슨하게: 요청 본문 어디든 사유 문자열.
    const reasonSeen = reqBodies().some((b) => b.includes("E2E_POLICY_BLOCK"));
    reasonSeen ? ok("E4c 모델에 거부 사유(E2E_POLICY_BLOCK) 전달") : bad("E4c 모델에 거부 사유 전달", `요청 ${reqBodies().length}건 중 사유 없음`);
  }

  // [E4d] 계약 고정 — hookEventName 없는 deny 는 codex 가 **무시하고 툴을 실행**한다(fail-open). 이 케이스가 초록인 동안은
  //  "러너가 hookEventName 을 빼도 된다"는 리팩터링이 조용히 거버넌스를 끈다는 사실이 문서로 남는다. codex 가 계약을 바꾸면 여기가 먼저 깨진다.
  {
    resetCaps(); rmMarker(); resetReqlog(); setScenario("shell");
    setRunnerOut("run-custom.mjs.PreToolUse", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "E2E_POLICY_BLOCK" } }));
    const r = runCodex("run the echo command");
    clearRunnerOut("run-custom.mjs.PreToolUse");
    const ran = existsSync(MARKER);
    r.status === 0 && ran ? ok("E4d hookEventName 없는 deny 는 무시됨(fail-open — 러너는 반드시 hookEventName 을 넣는다)") : bad("E4d fail-open 계약", `status=${r.status} marker=${ran}`);
  }

  // [E5] 컨텍스트 주입 E2E — SessionStart(session-preload)·UserPromptSubmit(run-custom) 훅 stdout 의 JSON 봉투
  //  (hookSpecificOutput.additionalContext — 우리 러너가 codex 에 내는 형식, contextEnvelope:"json")가 다음 모델 요청 본문에 실린다.
  {
    resetCaps(); resetReqlog(); setScenario("text");
    setRunnerOut("session-preload.mjs", JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "PROBE_CTX_E5" } }));
    setRunnerOut("run-custom.mjs.UserPromptSubmit", JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "PROBE_CTX_E5U" } }));
    const r = runCodex("say done");
    clearRunnerOut("session-preload.mjs"); clearRunnerOut("run-custom.mjs.UserPromptSubmit");
    r.status === 0 && r.stdout.includes("STUB_DONE") ? ok("E5a 주입 세션 완주") : bad("E5a 주입 세션 완주", tail(r));
    const bodies = reqBodies();
    bodies.some((b) => b.includes("PROBE_CTX_E5")) ? ok("E5b SessionStart additionalContext 가 모델 요청에 실림") : bad("E5b SessionStart 주입", `요청 ${bodies.length}건에 PROBE_CTX_E5 없음`);
    bodies.some((b) => b.includes("PROBE_CTX_E5U")) ? ok("E5c UserPromptSubmit additionalContext 가 모델 요청에 실림") : bad("E5c UserPromptSubmit 주입", `요청 ${bodies.length}건에 PROBE_CTX_E5U 없음`);
  }
} catch (e) {
  bad("E2E 수행", e?.stack || e?.message || String(e));
} finally {
  try { serverProc.kill(); } catch { /* */ }
  rmSync(SB, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} codex-e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// 라이블리 ↔ Cursor(IDE·CLI) 어댑터 (#4927) — claude·codex·opencode·antigravity·grok 과 **같은 거버넌스**를 Cursor 세션에 붙인다.
//
// 왜 어댑터가 필요한가(번들 실측 — cursor-agent 2026.10.19): Cursor 훅은 이벤트 이름이 camelCase 이고(sessionStart·
//  beforeSubmitPrompt·preToolUse…), 툴 이름이 Cursor 것이며(Shell·Write·`MCP:<툴>`), 출력 어휘도 다르다
//  (permission·additional_context·followup_message). 우리 러너(~/.lively/hooks/*.mjs)는 claude 형 계약이므로 이 얇은
//  어댑터가 번역만 한다 — 로직을 여기 복제하면 그 순간 여섯 번째 구현이 생긴다(grok·antigravity 어댑터와 같은 원칙).
//
// 설치: user-install 이 ~/.cursor/hooks.json 에 이 파일을 가리키는 command 를 이벤트별로 넣는다(argv = Cursor 이벤트 이름).
//  파일 자체는 ~/.lively/hooks/ 에 살므로(HOOK_SCRIPTS) 자동 업데이트가 러너와 함께 갱신한다.
//
// Cursor 훅 계약 요점(번들 실측 — 어댑터가 지키는 것):
//  · ⚠⚠ **권한 단계(preToolUse·beforeMCPExecution 등)는 비어 있지 않은 비JSON 출력이면 그 툴을 막는다.** 그래서 이 어댑터는
//    어떤 실패 경로에서도 stdout 에 **정확히 한 번, 유효한 JSON 객체**를 쓴다(antigravity 어댑터와 같은 불변식). 빈 출력·
//    다른 종료코드·타임아웃은 무시되고(fail-open) 툴이 그대로 간다.
//  · 결정 — preToolUse 는 deny 만 강제된다(allow·ask 무시, allow 가 승인 창을 건너뛰게 하지도 않는다) → deny 만 전파한다.
//    beforeMCPExecution 은 검증기가 ask 도 받는다 — CLI 는 deny 만 집행하고(번들 실측) IDE 는 문서상 ask 를 사람에게 묻는다
//    → MCP 는 deny·ask 를 싣는다(CLI 에선 ask 가 그냥 통과 — 종전과 같다). ⚠ 셸 명령의 ask 는 beforeShellExecution 에서만
//    집행되는데(CLI 실측) 셸은 preToolUse 로 받으므로 지금은 빠진다(알려진 공백 — 기본 조직 훅에 ask 를 내는 것은 없다).
//  · MCP 툴은 preToolUse·postToolUse 에 **서버 이름 없이** `MCP:<툴>` 로 온다. 서버 이름은 beforeMCPExecution 의
//    mcp_server_name 에만 있다. 같은 툴 호출의 훅들은 tool_use_id 를 공유하므로, beforeMCPExecution 에서
//    `mcp__<서버>__<툴>`(claude 형)로 정규화해 org 훅을 돌리고 그 서버를 tool_use_id 로 남겨 postToolUse 가 이어 쓴다.
//    (서버를 모르면 우리 MCP 판정이 오탐 방향 — 남의 서버의 동명 툴이 «기록함» 으로 잡힌다 — 이라 추측하지 않는다.)
//  · additional_context 는 beforeSubmitPrompt·postToolUse 에서 **1만 자를 넘으면 통째로 버려진다** — 잘라서 싣는다.
//    sessionStart 는 클라이언트 상한이 없고 첫 턴이 이 훅을 기다린다(맥락 주입의 정본 자리).
//  · Cursor 는 ~/.claude/settings.json 의 우리 훅도 compat 로 돌린다(CLI 는 끌 수 없다). 러너들의 이중발화 가드
//    (harness-registry isForeignCursorInvocation)는 LIVELY_HARNESS=cursor 를 보고 이 경로만 통과시킨다.
//
// ⚠ 이 파일은 ~/.lively/hooks/ 안에서 러너들과 같은 디렉터리에 살지만 grok·antigravity 어댑터와 같은 이유로
//   **자립(상대 import 0)** 을 유지한다 — 툴 이름 상수는 인라인이고, harness-registry 의 cursor.tools 와의
//   일치는 kit/hooks/cursor-adapter.test.mjs 가 고정한다.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";

const spawnSync = (command, args, options) => {
  const sandboxNode = process.env.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox"
    && /(?:^|[\\/])node(?:\.exe)?$/i.test(String(command));
  if (process.env.LIVELY_HOST_EFFECTS === "deny" && !sandboxNode) {
    const e = new Error(`HostEffects denied external-cli: ${command}`);
    e.code = "LIVELY_HOST_EFFECT_DENIED";
    throw e;
  }
  return nodeSpawnSync(command, args, options);
};

const HARNESS = "cursor";
const EVENT = process.argv[2] || "";
const LIVELY = join(process.env.LIVELY_HOME || homedir(), ".lively");
const HOOKS = join(LIVELY, "hooks");
// hooks.json command 가 이미 번들 node 절대경로로 이 파일을 실행한다(#355) → 자식도 같은 실행자면 충분하다.
const NODE = process.execPath;
// work-flag 와 같은 자리(전 플랫폼 per-user tmp) — MCP 서버 이름을 tool_use_id 로 잇는 메모를 둔다.
const FLAG_DIR = join(tmpdir(), "lively-hooks");
// beforeSubmitPrompt·postToolUse·preToolUse 의 additional_context 상한(번들 실측: 1e4 초과면 throw → 통째로 버림). 여유를 둔다.
const CTX_MAX = 9500;

// Cursor 툴 이름 → 러너가 보는 이름(claude 형). **입력 모양이 claude 와 같은 것만** 옮긴다 — Cursor 의 claude-compat
//  매핑(Bash→Shell·Edit→Write…)의 역방향이다. 그래서 claude 이름으로 쓴 조직 훅(spec-blind 쌍 등 harness=all)이
//  고치지 않고 Cursor 에서도 걸린다. 모르는 이름은 그대로 넘긴다(원래 이름은 cursor_tool_name 에도 싣는다).
//   Shell {command,cwd,timeout} ≈ Bash · Write {file_path,content}(편집도 전문 쓰기로 온다) ≈ Write · Read {file_path}
//   · Grep {pattern,…} · Fetch {url} ≈ WebFetch · Task(백엔드 실행 — 이름은 백엔드가 준다).
//  ⚠ harness-registry.mjs 의 cursor.tools 는 **이 번역 뒤의 이름**을 적는다(antigravity 의 MCP 정규화와 같은 규약).
const TOOL_MAP = { Shell: "Bash", Write: "Write", Read: "Read", Grep: "Grep", Fetch: "WebFetch", Task: "Task" };
// work-flag(세션 상태·기록 인정)를 부를 툴 — claude 의 PostToolUse matcher 와 같은 범위(번역 뒤 이름):
//  ① 우리 MCP 툴(정규화 뒤 mcp__lively__*) ② 파일 편집(Write) ③ 셸(Bash — 셸만 쓰는 긴 턴의 «작업 중» 신선도).
//  ⚠ harness-registry.mjs 의 cursor.tools({mcpMatcher, edit, shell}) 와 일치해야 한다(테스트가 고정).
const WORK_FLAG_TOOLS = /^(?:mcp__lively__.*|Write|Bash)$/;

const tryJson = (s) => { try { const v = JSON.parse(String(s)); return v; } catch { return undefined; } };
const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : null;

// tool_input 은 객체로 오지만(일반 툴) beforeMCPExecution 에선 **JSON 문자열**이다(실측) — 둘 다 객체로 맞춘다.
const argsOf = (ti) => asObj(ti) || asObj(typeof ti === "string" ? tryJson(ti) : null) || {};

// ── 시간 상한 ──────────────────────────────────────────────────────────────
// handle() 은 동기(spawnSync)라 타이머가 돌 수 없다 — 이 어댑터의 상한은 러너마다 건 SIGKILL 타임박스의 **합**이다.
//  이벤트별 합(BUDGET_MS) + stdin 이 hooks.json timeout(user-install CURSOR_HOOK_EVENTS)보다 작아야 Cursor 가 우리를 죽이기
//  전에 유효 출력으로 끝난다 — cursor-adapter 시험(P5)이 `node cursor-adapter.mjs --budget` 으로 읽어 그 표와 대조한다.
// T.runner = harness-registry cursor.runnerCapMs — 러너가 이보다 앞서 끝내도록 예산을 잡는다(#5034). 바꾸면 함께 바꾼다.
const T = { preload: 20000, sync: 20000, runner: 15000, runnerEnd: 10000, gate: 10000, workFlag: 5000, stdin: 2000 };
const BUDGET_MS = {
  sessionStart: T.preload + T.sync + T.runner + T.workFlag,
  beforeSubmitPrompt: T.runner + T.workFlag,
  preToolUse: T.runner,
  beforeMCPExecution: T.runner,
  postToolUse: T.runner + T.workFlag,
  stop: T.gate + T.runner + T.workFlag,
  sessionEnd: T.runnerEnd + T.workFlag,
  subagentStop: T.runner + T.workFlag,
  preCompact: T.runner + T.workFlag,
};
// 시험 전용 — 러너 타임박스를 줄여 «러너가 멈춰도 제때 유효 출력» 을 몇 초 안에 잰다(제품 경로엔 이 env 가 없다).
const TEST_TIMEBOX_MS = Number(process.env.LIVELY_TEST_CURSOR_TIMEBOX_MS) || 0;

// 러너 1회 실행 → stdout(문자열). 어떤 실패든 "" 로 삼킨다(fail-open).
//  killSignal SIGKILL: 러너가 타임아웃을 살아남아 세션을 막는 일이 없게(no-block 불변식, 타 어댑터와 동형).
// 세션 폴더(#5016) — 훅은 이 값으로 기록 범위를 판정한다(record-scope.mjs sessionDirOf). 어댑터가 띄운 훅 프로세스의 cwd 는
//  세션 작업 위치가 아니라서(hooks.json 자리·workspace root·~/.cursor) 시작 훅(session-preload — 빈 입력으로 부른다)이 엉뚱한 폴더를
//  보지 않게 env 로 함께 넘긴다. main 이 입력을 읽자마자 채운다.
let SESSION_DIR = "";
function runScript(script, args, stdin, timeout) {
  try {
    const r = spawnSync(NODE, [join(HOOKS, script), ...args], {
      input: stdin, encoding: "utf8", timeout: TEST_TIMEBOX_MS ? Math.min(timeout, TEST_TIMEBOX_MS) : timeout, killSignal: "SIGKILL",
      env: { ...process.env, LIVELY_HARNESS: HARNESS, ...(SESSION_DIR ? { LIVELY_SESSION_DIR: SESSION_DIR } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (r && typeof r.stdout === "string") ? r.stdout : "";
  } catch { return ""; }   // 러너 부재·spawn 실패 등 — 세션은 그대로 간다
}

// stdin 을 타임박스로 읽는다 — Cursor 는 stdin 으로 페이로드를 쓰고 닫지만 hang 은 원리적으로 차단.
function readStdin(ms = T.stdin) {
  return new Promise((resolve) => {
    let buf = ""; let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { buf += c; if (buf.length > 1024 * 1024) finish(); });
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      setTimeout(finish, ms);
    } catch { finish(); }
  });
}

// claude 형 러너 페이로드. session_id 는 Cursor 가 주는 session_id(없으면 conversation_id — 번들이 그렇게 채운다),
//  cwd 는 페이로드 cwd → 워크스페이스 첫 경로 → CURSOR_PROJECT_DIR 순(사용자 훅의 실제 cwd 는 ~/.cursor 라 세션 작업
//  위치가 아니다 — stop-writeback-gate 의 work-root 판정이 이 값을 쓴다). transcript_path 는 파일이 있을 때만 온다(없으면 null).
//  ⚠ transcript_path 는 **.jsonl 만** 넘긴다 — 우리가 읽는 형식(harness-io/cursor.ts)은 CLI 가 쓰는 JSONL 뿐이다(번들 실측). 번들의
//   경로 후보엔 .txt(옛 판)도 있고 IDE 의 형식은 미실측이라, 그런 파일을 기록 수집(기본 켬 — #4927 2026-10-22)이 올리면 서버가
//   못 읽는 원본만 쌓이고 화면이 빈다. 서버의 보고 경로 판정(locate reportedPathOk)도 .jsonl 만 받는다.
const sessionIdOf = (input) => String(input?.session_id || input?.conversation_id || "");
const cwdOf = (input) => (typeof input?.cwd === "string" && input.cwd)
  || (Array.isArray(input?.workspace_roots) && typeof input.workspace_roots[0] === "string" && input.workspace_roots[0])
  || process.env.CURSOR_PROJECT_DIR || process.cwd();
const payload = (event, input, extra) => JSON.stringify({
  hook_event_name: event,
  session_id: sessionIdOf(input),
  transcript_path: typeof input?.transcript_path === "string" && /\.jsonl$/i.test(input.transcript_path) ? input.transcript_path : "",
  cwd: cwdOf(input),
  ...extra,
});

const runner = (event, input, extra, timeout = T.runner) =>
  runScript("run-custom.mjs", [event, "--harness", HARNESS], payload(event, input, extra), timeout);
const workFlag = (event, input, extra) =>
  runScript("work-flag.mjs", ["--harness", HARNESS], payload(event, input, extra), T.workFlag);

// 러너 출력에서 컨텍스트 본문을 꺼낸다 — JSON 봉투(hookSpecificOutput.additionalContext)면 그 본문, 아니면 원문.
//  (cursor 의 contextEnvelope 는 json 이라 러너는 봉투로 낸다. 원문 폴백은 구버전 러너 대비.)
function contextOf(out) {
  const t = String(out || "").trim();
  if (!t) return "";
  const envText = (j) => { const h = asObj(j?.hookSpecificOutput); return h && typeof h.additionalContext === "string" ? h.additionalContext.trim() : ""; };
  const whole = asObj(tryJson(t));
  if (whole) return envText(whole);    // 봉투 한 개(정상 경로) — 결정·systemMessage 등 다른 뜻의 JSON 이면 빈 문자열
  const parsed = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => asObj(tryJson(l.trim())));
  if (parsed.every(Boolean)) return parsed.map(envText).filter(Boolean).join("\n\n");   // 봉투 여러 줄
  return t;                            // 원문(구버전 러너의 raw 봉투) — 서식 그대로
}
const joinCtx = (parts) => parts.map((s) => String(s || "").trim()).filter(Boolean).join("\n\n");
const capCtx = (s) => (s.length > CTX_MAX ? s.slice(0, CTX_MAX) + "\n…(Lively: Cursor 훅 컨텍스트 상한 1만 자 — 나머지는 잘렸습니다)" : s);

// run-custom PreToolUse 출력에서 결정 봉투를 꺼낸다. 비JSON/무출력이면 null(= 아무 결정 없음).
function decisionOf(out) {
  for (const l of String(out || "").split(/\r?\n/)) {
    const h = asObj(asObj(tryJson(l.trim()))?.hookSpecificOutput);
    if (h) return h;
  }
  return null;
}

// org 훅 결정 → Cursor 권한 출력. deny 는 늘, ask 는 그 단계가 받을 때만(ask:true — beforeMCPExecution, 위 머리말).
//  ⚠ ask 를 못 받는 단계에 실으면 검증에서 출력 전체가 틀린 것이 된다 — 그래서 단계별로 연다.
//  컨텍스트는 상한 안에서 함께 싣는다.
function permissionOut(d, { ask = false } = {}) {
  const out = {};
  const pd = d?.permissionDecision;
  if (pd === "deny" || (ask && pd === "ask")) {
    const why = d.permissionDecisionReason || (pd === "deny" ? "관리자 훅이 이 도구 호출을 거부했습니다." : "관리자 훅이 이 도구 호출에 확인을 요청했습니다.");
    const msg = `${pd === "deny" ? "Lively 정책으로 차단됨" : "Lively 정책이 확인을 요청함"}: ${why}`;
    out.permission = pd;
    out.user_message = msg;
    out.agent_message = msg;
  }
  if (typeof d?.additionalContext === "string" && d.additionalContext.trim()) out.additional_context = capCtx(d.additionalContext.trim());
  return out;
}

// ── MCP 서버 이름 잇기(tool_use_id) ─────────────────────────────────────────
const safeId = (id) => String(id || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const mcpNote = (id) => join(FLAG_DIR, `cursor-mcp.${safeId(id)}`);
function rememberMcpServer(toolUseId, server) {
  if (!toolUseId || !server) return;
  try {
    mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(mcpNote(toolUseId), server);
    // 남은 메모 청소 — 툴이 막히거나 세션이 끊겨 postToolUse 가 안 오면 메모가 남는다. 1시간 넘은 것만.
    const now = Date.now();
    for (const f of readdirSync(FLAG_DIR)) {
      if (!f.startsWith("cursor-mcp.")) continue;
      try { if (now - statSync(join(FLAG_DIR, f)).mtimeMs > 3600_000) unlinkSync(join(FLAG_DIR, f)); } catch { /* 경합 */ }
    }
  } catch { /* 메모를 못 남기면 postToolUse 가 서버를 모를 뿐 — 그 호출은 건너뛴다 */ }
}
function recallMcpServer(toolUseId) {
  if (!toolUseId) return "";
  try { const s = readFileSync(mcpNote(toolUseId), "utf8").trim(); try { unlinkSync(mcpNote(toolUseId)); } catch { /* */ } return s; }
  catch { return ""; }
}
const isMcpName = (name) => /^MCP:/.test(String(name || ""));
const mcpBare = (name) => String(name || "").replace(/^MCP:/, "");
const mcpFull = (server, tool) => `mcp__${server}__${tool}`;

// 비-MCP 툴 → 러너 이름·인자.
function toolOf(input) {
  const raw = String(input?.tool_name || "");
  return { tool_name: TOOL_MAP[raw] || raw, tool_input: argsOf(input?.tool_input), cursor_tool_name: raw };
}

// 이벤트별 처리 → Cursor 에 낼 출력 객체(stdout 쓰기는 main 이 한 번만).
function handle(input) {
  if (EVENT === "sessionStart") {
    // 맥락 주입의 정본 자리 — 첫 턴이 이 훅을 기다리고(실측) additional_context 에 클라이언트 상한이 없다.
    //  session-preload(조직 맥락·라이브 현황 + 런타임설정 갱신·자가 업데이트 트리거) · 자산 sync · 조직 SessionStart 훅 ·
    //  work-flag(압축 직후 재개 넛지)를 차례로 돌리고 본문만 모아 한 번에 싣는다.
    const extra = { source: "startup" };
    const ctx = [];
    ctx.push(contextOf(runScript("session-preload.mjs", ["--harness", HARNESS], "", T.preload)));
    runScript("sync-harness-assets.mjs", ["--harness", HARNESS], "", T.sync);
    ctx.push(contextOf(runner("SessionStart", input, extra)));
    ctx.push(contextOf(workFlag("SessionStart", input, extra)));
    const text = joinCtx(ctx);
    return text ? { additional_context: text } : {};
  }

  if (EVENT === "beforeSubmitPrompt") {
    // 턴 시작 — 조직 UserPromptSubmit 훅(관련 지식 소환·프로젝트 AGENTS.md 주입 등)의 컨텍스트를 싣고, work-flag 가
    //  «작업 중»·방금 친 말을 보고한다. 막지는 않는다(continue:true — org 훅에 프롬프트 차단 계약이 없다).
    const extra = { prompt: String(input?.prompt || "") };
    const text = joinCtx([contextOf(runner("UserPromptSubmit", input, extra)), contextOf(workFlag("UserPromptSubmit", input, extra))]);
    return text ? { continue: true, additional_context: capCtx(text) } : { continue: true };
  }

  if (EVENT === "preToolUse") {
    // MCP 툴은 여기서 서버를 모른다 → beforeMCPExecution 이 org 훅을 돌린다(이중 실행 방지 — 중립값 {}).
    if (isMcpName(input?.tool_name)) return {};
    const { tool_name, tool_input, cursor_tool_name } = toolOf(input);
    return permissionOut(decisionOf(runner("PreToolUse", input, { tool_name, tool_input, cursor_tool_name, tool_use_id: String(input?.tool_use_id || "") })));
  }

  if (EVENT === "beforeMCPExecution") {
    // ── MCP 툴의 조직 거버넌스 자리 — 서버 이름이 여기에만 있다(mcp_server_name). claude 형으로 정규화해 org 훅을 돌린다.
    const server = String(input?.mcp_server_name || "");
    const tool = mcpBare(input?.tool_name);
    const toolUseId = String(input?.tool_use_id || "");
    if (!server || !tool) return {};
    rememberMcpServer(toolUseId, server);
    const d = decisionOf(runner("PreToolUse", input, { tool_name: mcpFull(server, tool), tool_input: argsOf(input?.tool_input), cursor_tool_name: `MCP:${tool}`, tool_use_id: toolUseId }));
    const out = permissionOut(d, { ask: true });
    delete out.additional_context;     // beforeMCPExecution 은 컨텍스트 계약이 없다(결정만) — 실어도 버려진다
    return out;
  }

  if (EVENT === "postToolUse") {
    let tool_name, tool_input, cursor_tool_name;
    const toolUseId = String(input?.tool_use_id || "");
    if (isMcpName(input?.tool_name)) {
      const server = recallMcpServer(toolUseId);
      if (!server) return {};          // 서버를 모른다 — 추측하지 않는다(머리말 MCP 항)
      const tool = mcpBare(input?.tool_name);
      tool_name = mcpFull(server, tool); tool_input = argsOf(input?.tool_input); cursor_tool_name = `MCP:${tool}`;
    } else ({ tool_name, tool_input, cursor_tool_name } = toolOf(input));
    // tool_response: claude 계약의 이름. Cursor 는 tool_output(JSON 문자열)로 준다 — 풀 수 있으면 객체, 아니면 원문.
    const rawOut = input?.tool_output;
    const parsed = typeof rawOut === "string" ? tryJson(rawOut) : rawOut;
    const extra = { tool_name, tool_input, cursor_tool_name, tool_use_id: toolUseId, tool_response: parsed === undefined ? (rawOut ?? null) : parsed };
    const ctx = [contextOf(runner("PostToolUse", input, extra))];
    // work-flag 는 matcher 범위 안에서만(툴콜마다 프로세스를 하나 더 띄우지 않기 위해 — claude 와 같은 이유).
    if (WORK_FLAG_TOOLS.test(tool_name)) ctx.push(contextOf(workFlag("PostToolUse", input, extra)));
    const text = joinCtx(ctx);
    return text ? { additional_context: capCtx(text) } : {};
  }

  if (EVENT === "stop") {
    // 턴 종료. 상태 보고(쉼)·조직 Stop 훅은 상태와 무관하게, 기록 게이트는 **정상 완료(completed)** 일 때만 —
    //  중단·오류로 끝난 턴에 «기록하라» 를 덧붙이면 사람이 멈춘 것을 다시 굴린다(claude StopFailure 에 게이트를 안 거는 것과 같다).
    //  게이트의 {"decision":"block","reason"} 은 Cursor 의 followup_message 로 옮긴다(자동 후속 메시지 — 기록 넛지가 실제로 선다).
    //  루프가드: 게이트가 <sid>.blocked 로 세션당 1회를 보장하고, 후속 턴이면(loop_count>0) stop_hook_active 로 알린다.
    const status = String(input?.status || "");
    const extra = { stop_hook_active: Number(input?.loop_count) > 0 };
    const gate = status === "completed" ? runScript("stop-writeback-gate.mjs", [], payload("Stop", input, extra), T.gate) : "";
    runner("Stop", input, extra);
    workFlag("Stop", input, extra);
    for (const l of String(gate || "").split(/\r?\n/)) {
      const g = asObj(tryJson(l.trim()));
      if (g && g.decision === "block" && String(g.reason || "").trim()) return { followup_message: String(g.reason) };
    }
    return {};
  }

  if (EVENT === "sessionEnd") {
    const extra = { reason: String(input?.reason || input?.final_status || "") };
    runner("SessionEnd", input, extra, T.runnerEnd);
    workFlag("SessionEnd", input, extra);
    return {};
  }

  if (EVENT === "subagentStop" || EVENT === "preCompact") {
    const ev = EVENT === "subagentStop" ? "SubagentStop" : "PreCompact";
    runner(ev, input, {});
    workFlag(ev, input, {});
    return {};
  }

  // 모르는 이벤트(hooks.json 이 더 넓게 배선된 경우) — 아무것도 막지 않는 빈 객체.
  return {};
}

// stdout 은 **정확히 한 번**. 권한 단계에서 비JSON·중복이면 그 툴이 막힌다(머리말 ⚠⚠).
//  ⚠ 끝내기는 쓰기가 다 나간 **뒤**다 — process.exit 는 파이프에 남은 쓰기를 버린다. macOS 의 파이프 쓰기는 비동기라
//   64KB 를 넘는 sessionStart 맥락이 잘린 JSON 으로 나갔다(격리 리뷰 재현 2026-10-20: 65,537바이트에서 끊김 → 맥락 주입
//   통째로 유실). 읽는 쪽이 멈춰 콜백이 영영 안 오면 5초 뒤 끝낸다(그땐 어차피 Cursor 가 우리를 기다리지 않는다).
let wrote = false;
function emitAndExit(obj) {
  if (wrote) return;
  wrote = true;
  setTimeout(() => process.exit(0), 5000);
  try { process.stdout.write(JSON.stringify(obj) + "\n", () => process.exit(0)); }
  catch { process.exit(0); }   // 파이프가 이미 닫혔다
}
const fallbackFor = (ev) => (ev === "beforeSubmitPrompt" ? { continue: true } : {});

async function main() {
  let out = fallbackFor(EVENT);
  try {
    let input = {};
    try { input = JSON.parse((await readStdin()) || "{}"); } catch { /* 비JSON — 빈 입력으로 진행 */ }
    //  범위 판정은 «세션을 연 자리» 여야 흔들리지 않는다 — 이벤트마다 바뀔 수 있는 cwd 보다 작업 공간 첫 폴더를 먼저 본다.
    SESSION_DIR = (Array.isArray(input?.workspace_roots) && typeof input.workspace_roots[0] === "string" && input.workspace_roots[0]) || (typeof input?.cwd === "string" && input.cwd) || process.env.CURSOR_PROJECT_DIR || "";
    out = handle(asObj(input) || {}) || out;
  } catch { /* 어떤 실패도 아래 유효 출력 한 번으로 수렴 */ }
  emitAndExit(out);
}

// `--budget` 은 Cursor 이벤트가 아니다 — 시험이 시간 예산 표를 읽는 입구(위 «시간 상한»).
if (EVENT === "--budget") process.stdout.write(JSON.stringify({ stdinMs: T.stdin, events: BUDGET_MS }) + "\n");
else main().catch(() => emitAndExit(fallbackFor(EVENT)));   // 최후 방어 — main 이 죽어도 유효 JSON 한 줄(권한 단계 차단 방지)

#!/usr/bin/env node
// cursor 어댑터 사양테스트(#4927) — 어댑터를 **직접 실행**해 검증한다(순수 stdin/stdout 이라 모델·계정 없이 된다).
//  실행: node scripts/run-tests.mjs cursor-adapter   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//  사양·엣지 표: 스크래치패드 spec.md §A — 케이스 이름의 [A#] 가 그 행 번호다. 근거는 지식 cursor-harness-judgment-4927.
//
// Cursor 계약의 요점(번들 실측 — cursor-agent 2026.10.19):
//  · 권한 단계(preToolUse·beforeMCPExecution)는 **비어 있지 않은 비JSON 출력이면 툴을 막는다** → 1급 불변식은
//    "어떤 경로에서도 stdout 에 유효 JSON 객체 정확히 한 줄"이다(antigravity 와 같은 극, grok 과 반대 극).
//  · MCP 는 preToolUse·postToolUse 에 `MCP:<툴>`(서버 없음)로 오고 서버는 beforeMCPExecution 에만 있다 — 잇기 계약.
//  단언은 문구가 아니라 **부작용**으로: stdout JSON · 스텁 러너가 기록한 argv/stdin/env · 호출 0건의 무기록.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HARNESS, mcpMatcher, toolMatcher } from "./harness-registry.mjs";
import { HOOK_SCRIPTS } from "../setup/kit-manifest.mjs";
import { CURSOR_HOOK_EVENTS } from "../setup/user-install.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HOOKS_DIR, "cursor-adapter.mjs");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const SRC = readFileSync(ADAPTER, "utf8");

// ── P1. 자립성 — 상대 import 0(설치되면 ~/.lively/hooks 에 혼자 놓인다) ──
{
  const rel = [...SRC.matchAll(/from\s+["']\.\.?\//g)];
  rel.length ? bad("P1 자립(상대 import 0)", `${rel.length}건`) : ok("P1 자립(상대 import 0)");
}

// ── P2. 인라인 상수 ↔ 레지스트리 — 어긋나면 그 방향의 판정만 조용히 무음이 된다 ──
{
  const m = SRC.match(/WORK_FLAG_TOOLS\s*=\s*\/(.+)\/;/);
  if (!m) bad("P2 WORK_FLAG_TOOLS 존재", "정규식을 못 찾음");
  else {
    const re = new RegExp(m[1]);
    const t = HARNESS.cursor.tools;
    const want = [t.mcp("lively", "knowledge_save"), ...t.edit, ...t.shell];
    eq("P2a 우리 MCP·편집·셸이 work-flag 범위", want.map((x) => re.test(x)), want.map(() => true));
    eq("P2b 남의 MCP·읽기·Cursor 원래 이름은 범위 밖",
      [re.test("mcp__notion__search"), re.test("Read"), re.test("Shell"), re.test("MCP:knowledge_save")], [false, false, false, false]);
  }
  // 번역표(TOOL_MAP)의 목적지 = 레지스트리 tools 축(어댑터 번역 뒤 이름이라는 규약).
  const tm = SRC.match(/TOOL_MAP\s*=\s*(\{[^}]+\})/);
  let map = null; try { map = tm ? Function(`return (${tm[1]})`)() : null; } catch { map = null; }
  if (!map) bad("P2c TOOL_MAP 존재", "객체를 못 읽음");
  else eq("P2c 번역 목적지 = 레지스트리 edit·shell·read", [map.Write, map.Shell, map.Read, map.Grep],
    [HARNESS.cursor.tools.edit[0], HARNESS.cursor.tools.shell[0], HARNESS.cursor.tools.read[0], HARNESS.cursor.tools.read[1]]);
  eq("P2d 레지스트리 matcher 정합(claude 형 — 어댑터 정규화 규약)", [mcpMatcher("cursor", "lively"), toolMatcher("cursor", "edit")],
    ["mcp__lively__.*", "Write"]);
}

// ── P3. 매니페스트 등재 — 누락 시 설치 자리에 어댑터가 없어 hooks.json 이 죽은 경로를 가리킨다 ──
HOOK_SCRIPTS.includes("cursor-adapter.mjs") ? ok("P3 HOOK_SCRIPTS 등재") : bad("P3 HOOK_SCRIPTS 등재", "누락");

// ── P4. ⭐ 배선 이벤트 이름 ⊆ Cursor 가 아는 이벤트 — 모르는 이름이 하나라도 있으면 Cursor 가 **hooks.json 전체**를
//   버린다(사용자 훅까지 — 번들 실측 `Unknown hook type`). 목록은 cursor-agent 2026.10.19 의 훅 스텝 전수다.
{
  const KNOWN = new Set(["sessionStart", "sessionEnd", "preToolUse", "postToolUse", "postToolUseFailure", "subagentStart", "subagentStop",
    "beforeShellExecution", "afterShellExecution", "beforeMCPExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit",
    "beforeSubmitPrompt", "preCompact", "stop", "afterAgentResponse", "afterAgentThought", "beforeTabFileRead", "afterTabFileEdit", "workspaceOpen"]);
  const unknown = CURSOR_HOOK_EVENTS.map(([e]) => e).filter((e) => !KNOWN.has(e));
  eq("P4 배선 이벤트가 전부 Cursor 이벤트", unknown, []);
  // 배선한 이벤트는 어댑터가 전부 다룬다(모르는 이벤트 분기로 떨어지면 그 훅은 하는 일이 없다).
  const handled = CURSOR_HOOK_EVENTS.map(([e]) => e).filter((e) => !SRC.includes(`"${e}"`));
  eq("P4b 배선 이벤트마다 어댑터 분기가 있다", handled, []);
}

// ── R. 실행 검증 — 스텁 러너를 심은 샌드박스(LIVELY_HOME·TMPDIR 격리)에서 어댑터를 직접 실행 ──
const SB = mkdtempSync(join(tmpdir(), "cursor-adapter-test-"));
const HOOKS = join(SB, ".lively", "hooks");
const CAP = join(SB, "captures");
const TMP = join(SB, "tmp");
mkdirSync(CAP, { recursive: true }); mkdirSync(TMP, { recursive: true });

// 스텁 — 이름·argv·stdin·하네스 env 를 캡처 파일에 기록하고 지정 응답을 stdout 에 쓴다(부작용 관측 장치).
const stub = (name, out = "") => writeFileSync(join(HOOKS, name), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(join(CAP, name + ".log"))}, JSON.stringify({ argv: process.argv.slice(2), stdin, harness: process.env.LIVELY_HARNESS || "" }) + "\\n");
  process.stdout.write(${JSON.stringify(out)});
  process.exit(0);
});
`);
const envelope = (ev, text) => JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: text } });

// 실기기에서 어댑터는 Cursor 훅 프로세스로 스폰된다 — CURSOR_VERSION·CURSOR_PROJECT_DIR 가 실려 있고 자식(러너)에게 상속된다.
//  러너의 이중발화 가드는 LIVELY_HARNESS=cursor 스탬프 덕에 통과해야 한다(R3e 가 그 스탬프를 고정).
const runAdapter = (event, payload, extraEnv = {}) => spawnSync(process.execPath, [ADAPTER, event], {
  input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 30000,
  env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: SB, TMPDIR: TMP, TEMP: TMP, TMP,
    CURSOR_VERSION: "2026.10.19-test", CURSOR_PROJECT_DIR: "/ws-env", CLAUDECODE: "", ...extraEnv },
});
const lines = (r) => String(r.stdout || "").split("\n").filter((l) => l.trim());
const outOf = (r) => { const ls = lines(r); try { return ls.length === 1 ? JSON.parse(ls[0]) : { __lines: ls.length }; } catch { return { __invalid: ls[0]?.slice(0, 120) }; } };
const isOneObject = (r) => { const ls = lines(r); try { const v = JSON.parse(ls[0]); return r.status === 0 && ls.length === 1 && !!v && typeof v === "object" && !Array.isArray(v); } catch { return false; } };
const capOf = (name) => { try { return readFileSync(join(CAP, name + ".log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sentOf = (name, i = 0) => { try { return JSON.parse(capOf(name)[i]?.stdin || "{}"); } catch { return {}; } };
const resetCaps = () => { rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true }); };
const RUNNERS = ["run-custom.mjs", "work-flag.mjs", "session-preload.mjs", "sync-harness-assets.mjs", "stop-writeback-gate.mjs"];
const BASE = { conversation_id: "conv-1", generation_id: "gen-1", model: "m", cursor_version: "2026.10.19", workspace_roots: ["/ws"], transcript_path: "/t/conv-1.jsonl", session_id: "sess-1" };

try {
  // [A1] 러너 전무(~/.lively/hooks 자체 없음) → 유효 JSON 한 줄. beforeSubmitPrompt 는 continue:true(프롬프트를 막지 않는다).
  {
    const r = runAdapter("preToolUse", { ...BASE, tool_name: "Shell", tool_input: { command: "ls" } });
    isOneObject(r) ? ok("R1a[A1] 러너 부재 → 유효 JSON 한 줄") : bad("R1a[A1] 러너 부재 → 유효 JSON 한 줄", JSON.stringify([r.status, r.stdout]));
    eq("R1b[A1] beforeSubmitPrompt 는 continue:true", outOf(runAdapter("beforeSubmitPrompt", { ...BASE, prompt: "hi" })), { continue: true });
    // 배선하는 **모든** 이벤트에서 같은 불변식 — 한 이벤트라도 비JSON·두 줄이면 그 단계가 권한 단계일 때 툴이 막힌다.
    const broken = CURSOR_HOOK_EVENTS.map(([e]) => e).filter((e) => !isOneObject(runAdapter(e, { ...BASE, tool_name: "Shell", tool_input: {} })));
    eq("R1c[A1] 배선 이벤트 전부 유효 JSON 한 줄(러너 부재)", broken, []);
  }
  // [A2] 비JSON stdin → 유효 JSON 한 줄(입력 파손이 툴을 막지 않는다).
  {
    const r = runAdapter("preToolUse", "not json!!");
    isOneObject(r) ? ok("R2[A2] 비JSON stdin → 유효 JSON 한 줄") : bad("R2[A2] 비JSON stdin → 유효 JSON 한 줄", JSON.stringify([r.status, r.stdout]));
  }

  mkdirSync(HOOKS, { recursive: true });
  for (const f of RUNNERS) stub(f);

  // [A3] Shell → Bash · 같은 입력 · 러너 argv/env 계약.
  {
    resetCaps();
    const r = runAdapter("preToolUse", { ...BASE, tool_name: "Shell", tool_input: { command: "ls -la", cwd: "/ws" }, tool_use_id: "t1" });
    eq("R3a[A3] 결정 없음 → {}", outOf(r), {});
    const c = capOf("run-custom.mjs");
    eq("R3b[A3] run-custom 1회 · argv(이벤트+하네스)", [c.length, c[0]?.argv], [1, ["PreToolUse", "--harness", "cursor"]]);
    const s = sentOf("run-custom.mjs");
    eq("R3c[A3] claude 형 이름·같은 입력·원래 이름 보존", [s.hook_event_name, s.tool_name, s.tool_input, s.cursor_tool_name, s.tool_use_id],
      ["PreToolUse", "Bash", { command: "ls -la", cwd: "/ws" }, "Shell", "t1"]);
    eq("R3e[A3] LIVELY_HARNESS stamp(가드 통과 계약)", c[0]?.harness, "cursor");
  }
  // [A4] Write → Write(입력 그대로) · [A5] 모르는 툴은 이름 그대로.
  {
    resetCaps();
    runAdapter("preToolUse", { ...BASE, tool_name: "Write", tool_input: { file_path: "/ws/a.test.ts", content: "x" } });
    eq("R4[A4] Write 그대로", [sentOf("run-custom.mjs").tool_name, sentOf("run-custom.mjs").tool_input], ["Write", { file_path: "/ws/a.test.ts", content: "x" }]);
    resetCaps();
    runAdapter("preToolUse", { ...BASE, tool_name: "Delete", tool_input: { file_path: "/ws/x" } });
    eq("R5[A5] 모르는 툴은 그대로", sentOf("run-custom.mjs").tool_name, "Delete");
  }
  // [A6] deny → permission:deny + 사유. [A7] allow·ask 는 싣지 않는다. [A8] 러너 비JSON → 막지 않는다.
  {
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "정책상 금지" } }));
    const r = runAdapter("preToolUse", { ...BASE, tool_name: "Shell", tool_input: { command: "rm -rf /" } });
    const o = outOf(r);
    o.permission === "deny" && /정책상 금지/.test(o.user_message || "") && /정책상 금지/.test(o.agent_message || "")
      ? ok("R6[A6] org deny → permission:deny + 사유") : bad("R6[A6] org deny → permission:deny + 사유", JSON.stringify(o));
    isOneObject(r) ? ok("R6b[A6] deny 도 JSON 정확히 한 줄") : bad("R6b[A6] deny 도 JSON 정확히 한 줄", r.stdout);
    for (const d of ["allow", "ask"]) {
      stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d } }));
      eq(`R7[A7] org ${d} → permission 없음`, "permission" in outOf(runAdapter("preToolUse", { ...BASE, tool_name: "Shell", tool_input: {} })), false);
    }
    stub("run-custom.mjs", "garbage not json");
    const g = runAdapter("preToolUse", { ...BASE, tool_name: "Shell", tool_input: {} });
    eq("R8[A8] 러너 비JSON → 유효 {}", [isOneObject(g), outOf(g)], [true, {}]);
    stub("run-custom.mjs");
  }
  // [A9] preToolUse 의 MCP 는 org 훅을 안 돌린다(서버를 모르는 자리).
  {
    resetCaps();
    const r = runAdapter("preToolUse", { ...BASE, tool_name: "MCP:knowledge_save", tool_input: { name: "x" }, tool_use_id: "m0" });
    eq("R9[A9] MCP preToolUse → {} · org 훅 0회", [outOf(r), capOf("run-custom.mjs").length], [{}, 0]);
  }
  // [A10][A11] beforeMCPExecution — 서버 정규화 · 문자열 입력 해석 · deny 전파(컨텍스트 없음).
  {
    resetCaps();
    runAdapter("beforeMCPExecution", { ...BASE, tool_name: "knowledge_save", tool_input: JSON.stringify({ name: "k" }), mcp_server_name: "lively", command: "lively mcp", tool_use_id: "m1" });
    const s = sentOf("run-custom.mjs");
    eq("R10[A10] mcp__<server>__<tool> · 객체 입력", [s.hook_event_name, s.tool_name, s.tool_input], ["PreToolUse", "mcp__lively__knowledge_save", { name: "k" }]);
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "쓰기 금지", additionalContext: "ctx" } }));
    const o = outOf(runAdapter("beforeMCPExecution", { ...BASE, tool_name: "knowledge_save", tool_input: "{}", mcp_server_name: "lively", tool_use_id: "m2" }));
    eq("R11[A11] deny 전파 · additional_context 없음", [o.permission, /쓰기 금지/.test(o.user_message || ""), "additional_context" in o], ["deny", true, false]);
    stub("run-custom.mjs");
  }
  // [A12] 서버 이름 없음 → org 훅 안 돌림.
  {
    resetCaps();
    const r = runAdapter("beforeMCPExecution", { ...BASE, tool_name: "x", tool_input: "{}", tool_use_id: "m3" });
    eq("R12[A12] 서버 없음 → {} · org 훅 0회", [outOf(r), capOf("run-custom.mjs").length], [{}, 0]);
  }
  // [A13] 같은 tool_use_id 의 postToolUse 는 서버를 이어받는다 · lively 면 work-flag 1회.
  {
    resetCaps();
    runAdapter("beforeMCPExecution", { ...BASE, tool_name: "knowledge_save", tool_input: "{}", mcp_server_name: "lively", tool_use_id: "m4" });
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "MCP:knowledge_save", tool_input: { name: "k" }, tool_output: JSON.stringify({ ok: true }), tool_use_id: "m4" });
    eq("R13a[A13] org PostToolUse 가 서버 정규화 이름", sentOf("run-custom.mjs").tool_name, "mcp__lively__knowledge_save");
    eq("R13b[A13] lively → work-flag 1회", capOf("work-flag.mjs").length, 1);
    // 같은 id 로 다시 오면 메모는 이미 걷혔다 — 두 번째는 서버를 모른다(메모가 영원히 쌓이지 않는다).
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "MCP:knowledge_save", tool_input: {}, tool_use_id: "m4" });
    eq("R13c[A13] 메모는 한 번 쓰고 걷힌다", capOf("run-custom.mjs").length, 0);
  }
  // [A14] 앞선 beforeMCPExecution 없음 → 서버 모름 → 추측하지 않는다.
  {
    resetCaps();
    const r = runAdapter("postToolUse", { ...BASE, tool_name: "MCP:knowledge_save", tool_input: {}, tool_use_id: "never-seen" });
    eq("R14[A14] 서버 모름 → {} · org 훅·work-flag 0회", [outOf(r), capOf("run-custom.mjs").length, capOf("work-flag.mjs").length], [{}, 0, 0]);
  }
  // [A15] 남의 서버 → work-flag 0회(동명 툴 오탐 방지) · org 훅은 1회.
  {
    resetCaps();
    runAdapter("beforeMCPExecution", { ...BASE, tool_name: "knowledge_save", tool_input: "{}", mcp_server_name: "notion", tool_use_id: "m5" });
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "MCP:knowledge_save", tool_input: {}, tool_use_id: "m5" });
    eq("R15[A15] 남의 서버 → org 1회 · work-flag 0회", [sentOf("run-custom.mjs").tool_name, capOf("work-flag.mjs").length], ["mcp__notion__knowledge_save", 0]);
  }
  // [A16] tool_output(JSON 문자열) → tool_response 객체. [A17] Read 는 work-flag 범위 밖. [A18] Write·Shell 은 안.
  {
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "Shell", tool_input: { command: "ls" }, tool_output: JSON.stringify({ output: "a", exitCode: 0 }), tool_use_id: "s1" });
    eq("R16[A16] tool_response 가 풀린 객체", sentOf("run-custom.mjs").tool_response, { output: "a", exitCode: 0 });
    eq("R18a[A18] Shell → work-flag 1회", capOf("work-flag.mjs").length, 1);
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "Read", tool_input: { file_path: "/x" }, tool_output: "{}" });
    eq("R17[A17] Read → org 1회 · work-flag 0회", [capOf("run-custom.mjs").length, capOf("work-flag.mjs").length], [1, 0]);
    resetCaps();
    runAdapter("postToolUse", { ...BASE, tool_name: "Write", tool_input: { file_path: "/x", content: "y" }, tool_output: "{}" });
    eq("R18b[A18] Write → work-flag 1회", capOf("work-flag.mjs").length, 1);
  }
  // [A19] sessionStart — 셋의 컨텍스트가 봉투를 벗고 한데 실린다 · [A20] 아무도 안 내면 {}.
  {
    resetCaps();
    stub("session-preload.mjs", envelope("SessionStart", "ORG-CONTEXT"));
    stub("run-custom.mjs", envelope("SessionStart", "HOOK-CONTEXT"));
    stub("work-flag.mjs", envelope("SessionStart", "RESUME-CONTEXT"));
    const o = outOf(runAdapter("sessionStart", { ...BASE, is_background_agent: false, composer_mode: "agent" }));
    const t = String(o.additional_context || "");
    eq("R19a[A19] 셋 다 실림 · 봉투 없음", [t.includes("ORG-CONTEXT"), t.includes("HOOK-CONTEXT"), t.includes("RESUME-CONTEXT"), t.includes("hookSpecificOutput")], [true, true, true, false]);
    eq("R19b[A19] 부수효과 4종 각 1회", ["session-preload.mjs", "sync-harness-assets.mjs", "run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [1, 1, 1, 1]);
    eq("R19c[A19] preload argv", capOf("session-preload.mjs")[0]?.argv, ["--harness", "cursor"]);
    for (const f of ["session-preload.mjs", "run-custom.mjs", "work-flag.mjs"]) stub(f);
    eq("R20[A20] 컨텍스트 없음 → {}", outOf(runAdapter("sessionStart", { ...BASE })), {});
  }
  // [A21] beforeSubmitPrompt 상한 — 1만 자 이상이면 잘라서 < 10000(넘기면 Cursor 가 통째로 버린다). [A22] 상한 이하는 그대로.
  {
    stub("run-custom.mjs", envelope("UserPromptSubmit", "가".repeat(12000)));
    const o = outOf(runAdapter("beforeSubmitPrompt", { ...BASE, prompt: "q" }));
    eq("R21[A21] continue:true · 길이 < 10000", [o.continue, typeof o.additional_context === "string" && o.additional_context.length < 10000 && o.additional_context.length > 9000], [true, true]);
    const exact = "나".repeat(9500);
    stub("run-custom.mjs", envelope("UserPromptSubmit", exact));
    eq("R22[A22] 상한 이하 원문 그대로", outOf(runAdapter("beforeSubmitPrompt", { ...BASE, prompt: "q" })).additional_context, exact);
    stub("run-custom.mjs");
  }
  // [A23] stop completed + 게이트 block → followup_message. [A24] aborted → 게이트 0회(org·work-flag 1회). [A25] loop_count>0.
  {
    resetCaps();
    stub("stop-writeback-gate.mjs", JSON.stringify({ decision: "block", reason: "기록을 남기세요" }));
    eq("R23[A23] completed + block → followup_message", outOf(runAdapter("stop", { ...BASE, status: "completed", loop_count: 0 })), { followup_message: "기록을 남기세요" });
    eq("R23b[A23] 게이트 페이로드 stop_hook_active:false", sentOf("stop-writeback-gate.mjs").stop_hook_active, false);
    resetCaps();
    eq("R24a[A24] aborted → {}", outOf(runAdapter("stop", { ...BASE, status: "aborted", loop_count: 0 })), {});
    eq("R24b[A24] 게이트 0회 · org·work-flag 1회", [capOf("stop-writeback-gate.mjs").length, capOf("run-custom.mjs").length, capOf("work-flag.mjs").length], [0, 1, 1]);
    resetCaps();
    runAdapter("stop", { ...BASE, status: "completed", loop_count: 1 });
    eq("R25[A25] loop_count 1 → stop_hook_active:true", sentOf("stop-writeback-gate.mjs").stop_hook_active, true);
    stub("stop-writeback-gate.mjs");
  }
  // [A26] 페이로드 폴백 — session_id ?? conversation_id · cwd ?? workspace_roots[0] ?? CURSOR_PROJECT_DIR.
  {
    resetCaps();
    const { session_id: _s, ...noSid } = BASE;
    runAdapter("preToolUse", { ...noSid, tool_name: "Shell", tool_input: {} });
    eq("R26a[A26] session_id 없음 → conversation_id · cwd=workspace_roots[0]", [sentOf("run-custom.mjs").session_id, sentOf("run-custom.mjs").cwd], ["conv-1", "/ws"]);
    resetCaps();
    runAdapter("preToolUse", { ...BASE, workspace_roots: [], tool_name: "Shell", tool_input: { command: "x", cwd: "/ws/sub" }, cwd: "/ws/sub" });
    eq("R26b[A26] 페이로드 cwd 우선", sentOf("run-custom.mjs").cwd, "/ws/sub");
    resetCaps();
    runAdapter("preToolUse", { conversation_id: "c2", tool_name: "Shell", tool_input: {} });
    eq("R26c[A26] cwd 마지막 폴백 = CURSOR_PROJECT_DIR", sentOf("run-custom.mjs").cwd, "/ws-env");
  }
  // [A27] 모르는 이벤트 → {}.
  eq("R27[A27] 모르는 이벤트 → {}", outOf(runAdapter("afterAgentThought", { ...BASE })), {});
} finally {
  rmSync(SB, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} cursor-adapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// grok 어댑터 사양테스트(#1701) — 어댑터를 **직접 실행**해 검증한다(순수 stdin/stdout 이라 모델 없이 된다).
//  실행: node kit/hooks/grok-adapter.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//  사양·엣지 표(22행): 스크래치패드 spec.md ← [[grok-harness-spec-1701]] §3·§7. 케이스 이름의 [S#] 가 그 행 번호다.
//
// grok 계약의 요점(antigravity 와 반대 극):
//  · **전부 fail-open · 중립은 무출력** — 그래서 여기 1급 불변식은 반대로 "**명시 결정(deny·block) 외에는
//    stdout 에 아무것도 쓰지 않는다**"다(빈 {} 도 안 쓴다 — 안 내는 게 계약상 중립의 정본).
//  · MCP 는 toolName 이 이미 `server__tool` 로 정규화돼 오지만 **toolInput 은 use_tool 래퍼**다 — 언랩 계약.
//  · Stop 은 세션 종료 시에도 발화한다(reason:"shutdown") — end_turn 만 처리하는 필터 계약.
//  단언은 문구가 아니라 **부작용**으로: stdout · 스텁 러너가 기록한 argv/stdin/env · 호출 0건의 무기록.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HARNESS, mcpMatcher, toolMatcher } from "./harness-registry.mjs";
import { HOOK_SCRIPTS } from "../setup/kit-manifest.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HOOKS_DIR, "grok-adapter.mjs");
const KIT = join(HOOKS_DIR, "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const SRC = readFileSync(ADAPTER, "utf8");

// ── P1. 자립성 — 상대 import 0 (러너들과 같은 디렉터리에 살지만 opencode·antigravity 어댑터와 같은 규약) ──
{
  const rel = [...SRC.matchAll(/from\s+["']\.\.?\//g)];
  rel.length ? bad("P1 자립(상대 import 0)", `${rel.length}건`) : ok("P1 자립(상대 import 0)");
}

// ── P2. 인라인 상수 ↔ 레지스트리 일치 — 어긋나면 그 방향의 판정만 조용히 무음이 된다 ──
{
  const m = SRC.match(/WORK_FLAG_TOOLS\s*=\s*\/(.+)\/;/);
  if (!m) bad("P2 WORK_FLAG_TOOLS 존재", "정규식을 못 찾음");
  else {
    const re = new RegExp(m[1]);
    // 레지스트리에서 파생한 이름들이 실제로 걸리는지 — 문자열 비교가 아니라 **동작**으로 확인한다.
    const mcpName = HARNESS.grok.tools.mcp("lively", "whoami");   // "lively__whoami"
    const edits = HARNESS.grok.tools.edit;                        // ["search_replace", "write"]
    const hits = [mcpName, ...edits].map((t) => re.test(t));
    eq("P2a 우리 MCP·편집 툴이 work-flag 범위", hits, hits.map(() => true));
    // 오탐 방지 — 남의 MCP·읽기 툴·claude 형 접두어는 안 걸린다(grok 은 mcp__ 접두가 없다 — 걸리면 표가 틀린 것).
    eq("P2b 남의 MCP·읽기 툴·mcp__ 형은 범위 밖",
      [re.test("notion__search"), re.test("read_file"), re.test("run_terminal_command"), re.test("mcp__lively__whoami")],
      [false, false, false, false]);
  }
  // matcher 축과의 정합(레지스트리 정본): grok 훅 matcher 는 `lively__.*` 형이어야 한다 —
  //  ⚠ `mcp__lively__.*` 는 grok 훅 matcher 에서 **영영 안 걸린다**(mcp__ 재작성은 permission rules 전용, #1701 실측).
  eq("P2c 레지스트리 matcher 정합", [mcpMatcher("grok", "lively"), toolMatcher("grok", "edit")],
    ["lively__.*", "search_replace|write"]);
}

// ── P3. HOOK_SCRIPTS 등재(두 목록 모두) — 누락 시 설치 자리에 어댑터가 없어 lively-grok.json 이 죽은 경로를 가리킨다 ──
{
  // 목록은 kit/setup/kit-manifest.mjs 단일 출처다(2026-08-27 «멤버 훅 전멸» 이후). 그래서 볼 것이 둘이다 —
  //  ① 매니페스트에 등재됐는가 ② 소비자가 지역 사본을 되살리지 않았는가(되살아나면 다시 드리프트한다).
  HOOK_SCRIPTS.includes("grok-adapter.mjs")
    ? ok("P3 매니페스트 HOOK_SCRIPTS 등재")
    : bad("P3 매니페스트 HOOK_SCRIPTS 등재", "누락 — 설치기·번들 조립이 복사할 소스가 없다");
  const revived = ["setup/user-install.mjs", "generator/build-context.mjs"]
    .filter((rel) => /const HOOK_SCRIPTS\s*=\s*\[/.test(readFileSync(join(KIT, rel), "utf8")));
  revived.length === 0
    ? ok("P3 소비자가 목록 사본을 두지 않음(단일 출처 유지)")
    : bad("P3 소비자가 목록 사본을 두지 않음(단일 출처 유지)", `${revived.join(", ")} 가 지역 리터럴을 되살렸다`);
}

// ── R. 실행 검증 — 스텁 러너를 심은 샌드박스(LIVELY_HOME 격리)에서 어댑터를 직접 실행 ──
const SB = mkdtempSync(join(tmpdir(), "grok-adapter-test-"));
const HOOKS = join(SB, ".lively", "hooks");
const CAP = join(SB, "captures");
mkdirSync(CAP, { recursive: true });

// 스텁 — 자기 이름·argv·stdin·하네스 env 를 캡처 파일에 기록하고 지정 응답을 stdout 에 쓴다(부작용 관측 장치).
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

// GROK_HOOK_EVENT 를 함께 준다 — 실기기에서 어댑터는 항상 grok 훅 프로세스로 스폰되므로 그 env 가 실려 있고,
//  자식(러너)에게 상속된다. 러너의 compat 이중발화 가드는 LIVELY_HARNESS=grok 스탬프 덕에 통과해야 한다
//  (스탬프가 빠지면 스텁이 아니라 **실제 러너가 exit 0 으로 조용히 죽는다** — R3d 가 그 회귀를 잡는다).
const runAdapter = (event, payload) => spawnSync(process.execPath, [ADAPTER, event], {
  input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 30000,
  env: { ...process.env, LIVELY_HOME: SB, GROK_HOOK_EVENT: event.toLowerCase() },
});
const outRaw = (r) => String(r.stdout || "").trim();
const outOf = (r) => { try { return JSON.parse(outRaw(r)); } catch { return { __invalid: outRaw(r).slice(0, 120) }; } };
const capOf = (name) => {
  try { return readFileSync(join(CAP, name + ".log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
  catch { return []; }
};
const resetCaps = () => { rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true }); };
// grok 실기기 페이로드 형(#1701 실측 캡처와 동일 키) — camelCase.
const BASE = {
  sessionId: "sess-1", transcriptPath: "/t/updates.jsonl", cwd: "/ws/sub", workspaceRoot: "/ws",
  timestamp: "2026-08-14T00:00:00Z", permissionMode: "bypassPermissions",
};

try {
  // [S1] 러너 전무(~/.lively/hooks 디렉터리 자체 없음 — 신규 도입물 부재 행) → exit0 + **무출력**(fail-open 중립).
  {
    const r = runAdapter("PreToolUse", { ...BASE, toolName: "run_terminal_command", toolUseId: "c1", toolInput: { command: "ls", description: "d" } });
    eq("R1[S1] 러너 부재 → exit0 + 무출력", [r.status, outRaw(r)], [0, ""]);
  }
  // [S2] 비JSON stdin → exit0 + 무출력(입력 파손이 세션을 못 막는다).
  eq("R2[S2] 비JSON stdin → 무출력", outRaw(runAdapter("PreToolUse", "not json!!")), "");

  // 이제 스텁 관측 장치를 심는다.
  mkdirSync(HOOKS, { recursive: true });
  for (const f of ["run-custom.mjs", "work-flag.mjs", "session-preload.mjs", "sync-harness-assets.mjs", "stop-writeback-gate.mjs"]) stub(f);

  // [S3] 내장 툴 PreToolUse — 러너에 claude 형 스냅샷(argv 이벤트+하네스 · snake_case 페이로드 · env stamp).
  {
    resetCaps();
    const r = runAdapter("PreToolUse", { ...BASE, toolName: "run_terminal_command", toolUseId: "c1", toolInput: { command: "ls", description: "d" }, toolInputTruncated: false });
    eq("R3a[S3] 결정 없음 → 무출력", outRaw(r), "");
    const c = capOf("run-custom.mjs");
    eq("R3b[S3] run-custom argv(이벤트+하네스)", c[0]?.argv, ["PreToolUse", "--harness", "grok"]);
    const sent = JSON.parse(c[0]?.stdin || "{}");
    eq("R3c[S3] claude 형 페이로드(camelCase→snake_case)",
      [sent.hook_event_name, sent.tool_name, sent.session_id, sent.transcript_path, sent.cwd, sent.tool_input],
      ["PreToolUse", "run_terminal_command", "sess-1", "/t/updates.jsonl", "/ws/sub", { command: "ls", description: "d" }]);
    eq("R3d[S3] LIVELY_HARNESS stamp(가드 통과 계약)", c[0]?.harness, "grok");
  }

  // [S4] ⭐ use_tool 래퍼 언랩 — toolName 은 정규화된 server__tool 로 오지만 toolInput 은 래퍼다(#1701 실측).
  //  이 계약이 깨지면 org 훅·work-flag 가 '그 툴의 인자' 자리에서 래퍼를 보게 된다(반쯤 되는 상태).
  {
    resetCaps();
    runAdapter("PreToolUse", { ...BASE, toolName: "lively__whoami", toolUseId: "c2", toolInput: { tool_name: "lively__whoami", tool_input: { a: 1 } } });
    const sent = JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}");
    eq("R4a[S4] 래퍼 언랩 → tool_name + 내부 인자", [sent.tool_name, sent.tool_input], ["lively__whoami", { a: 1 }]);
    // [S4b](경계) 래퍼 형태가 아니면(내장 툴·직접 광고 MCP — tool_name 불일치) passthrough — 과잉 언랩 금지.
    resetCaps();
    runAdapter("PreToolUse", { ...BASE, toolName: "lively__whoami", toolUseId: "c3", toolInput: { q: "x" } });
    eq("R4b[S4b] 비래퍼는 passthrough", JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}").tool_input, { q: "x" });
  }

  // [S5] org deny → decision:deny + 사유. [S6] allow 는 중립(무출력 — 동의 UI 우회 금지). [S7] 러너 쓰레기 → 무출력.
  {
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "정책상 금지" } }));
    const r = runAdapter("PreToolUse", { ...BASE, toolName: "run_terminal_command", toolInput: { command: "x", description: "d" } });
    const o = outOf(r);
    o.decision === "deny" && /정책상 금지/.test(o.reason || "") ? ok("R5[S5] org deny → decision:deny + reason") : bad("R5[S5] org deny → decision:deny + reason", JSON.stringify(o));
    eq("R5b[S5] deny 는 정확히 JSON 한 줄", outRaw(r).split("\n").filter(Boolean).length, 1);
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));
    eq("R6[S6] org allow 도 중립(무출력)", outRaw(runAdapter("PreToolUse", { ...BASE, toolName: "run_terminal_command", toolInput: {} })), "");
    stub("run-custom.mjs", "garbage not json");
    eq("R7[S7] 러너 비JSON → 무출력", outRaw(runAdapter("PreToolUse", { ...BASE, toolName: "run_terminal_command", toolInput: {} })), "");
    stub("run-custom.mjs"); // 원복
  }

  // [S8] toolName 부재 — 크래시 금지·유효(무출력) + run-custom 은 그래도 1회(빈 tool_name 으로 — org 훅 matcher 가 판단).
  {
    resetCaps();
    eq("R8a[S8] toolName 부재 → 무출력", outRaw(runAdapter("PreToolUse", { ...BASE })), "");
    eq("R8b[S8] run-custom 은 1회(빈 tool_name)", capOf("run-custom.mjs").length, 1);
  }

  // [S9][S10] PostToolUse — work-flag 는 범위(lively__*·편집)에서만, run-custom 은 전 툴(claude matcher .* 패리티).
  {
    resetCaps();
    const r = runAdapter("PostToolUse", { ...BASE, toolName: "lively__knowledge_save", toolUseId: "c4", toolInput: { tool_name: "lively__knowledge_save", tool_input: {} }, toolResult: { type: "MCP", tool_name: "knowledge_save", server_name: "lively" }, toolResultTruncated: false });
    eq("R9a[S9] PostToolUse 무출력", outRaw(r), "");
    eq("R9b[S9] lively MCP → work-flag 1회", capOf("work-flag.mjs").length, 1);
    eq("R9c[S9] run-custom 1회", capOf("run-custom.mjs").length, 1);
    // tool_response passthrough — claude 계약 필드명에 grok toolResult 를 싣는다.
    eq("R9d[S9] tool_response=toolResult", JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}").tool_response?.type, "MCP");
    resetCaps();
    runAdapter("PostToolUse", { ...BASE, toolName: "read_file", toolInput: { path: "/x" }, toolResult: {} });
    eq("R10a[S10] 범위 밖 툴 → work-flag 0회", capOf("work-flag.mjs").length, 0);
    eq("R10b[S10] run-custom 은 그래도 1회", capOf("run-custom.mjs").length, 1);
    resetCaps();
    runAdapter("PostToolUse", { ...BASE, toolName: "search_replace", toolInput: { file_path: "/x" }, toolResult: {} });
    eq("R10c[S10b] 편집 툴 → work-flag 1회", capOf("work-flag.mjs").length, 1);
  }

  // [S11] SessionStart — 부수효과 4종 각 1회 + source 전달 + 무출력(grok 은 SessionStart stdout 을 무시한다 —
  //  컨텍스트는 rules 파일이 정본이라 여기서 내면 낭비·오해만 생긴다).
  {
    resetCaps();
    eq("R11a[S11] SessionStart 무출력", outRaw(runAdapter("SessionStart", { ...BASE, source: "new" })), "");
    eq("R11b[S11] 부수효과 4종 각 1회", ["session-preload.mjs", "sync-harness-assets.mjs", "run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [1, 1, 1, 1]);
    eq("R11c[S11] source 필드 전달", JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}").source, "new");
    eq("R11d[S11] preload argv 에 --harness grok", capOf("session-preload.mjs")[0]?.argv, ["--harness", "grok"]);
  }

  // [S12] Stop(end_turn) — 게이트 block 을 **그대로 전파**(grok 은 claude 와 같은 decision:block 어휘 — 번역 불요).
  {
    resetCaps();
    stub("stop-writeback-gate.mjs", JSON.stringify({ decision: "block", reason: "기록하고 종료하세요" }));
    const o = outOf(runAdapter("Stop", { ...BASE, reason: "end_turn", stopHookActive: false, lastAssistantMessage: "done" }));
    o.decision === "block" && /기록하고/.test(o.reason || "") ? ok("R12a[S12] 게이트 block → block+reason 전파") : bad("R12a[S12] 게이트 block → block+reason 전파", JSON.stringify(o));
    const gsent = JSON.parse(capOf("stop-writeback-gate.mjs")[0]?.stdin || "{}");
    eq("R12b[S12] 게이트 stdin 에 session_id·cwd·stop_hook_active", [gsent.session_id, gsent.cwd, gsent.stop_hook_active], ["sess-1", "/ws/sub", false]);
  }

  // [S13] ⭐(경계) Stop(shutdown — 세션 종료 관측 발화) — 게이트·러너 전부 무발화(end_turn 필터). 종료는 SessionEnd 담당.
  {
    resetCaps();
    stub("stop-writeback-gate.mjs", JSON.stringify({ decision: "block", reason: "x" }));   // 발화했다면 잡혔을 미끼
    eq("R13a[S13] Stop(shutdown) 무출력", outRaw(runAdapter("Stop", { ...BASE, reason: "shutdown" })), "");
    eq("R13b[S13] 게이트·러너 0회", ["stop-writeback-gate.mjs", "run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [0, 0, 0]);
    stub("stop-writeback-gate.mjs"); // 원복
  }

  // [S14] Stop 게이트 무출력 → 무출력(종료 허용) + run-custom·work-flag 는 1회.
  {
    resetCaps();
    eq("R14a[S14] 게이트 무출력 → 무출력", outRaw(runAdapter("Stop", { ...BASE, reason: "end_turn", stopHookActive: false })), "");
    eq("R14b[S14] run-custom·work-flag 1회", ["run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [1, 1]);
  }

  // [S15] 서브에이전트 내부 발화(subagentType) — SubagentStop 외엔 필터(claude 는 그 이벤트들을 안 준다 — 패리티).
  {
    resetCaps();
    eq("R15a[S15] 서브에이전트 PostToolUse 필터", outRaw(runAdapter("PostToolUse", { ...BASE, subagentType: "explore", toolName: "search_replace", toolInput: {}, toolResult: {} })), "");
    eq("R15b[S15] 러너 0회", ["run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [0, 0]);
    resetCaps();
    runAdapter("SubagentStop", { ...BASE, subagentType: "explore", subagentId: "sa1", phase: "gate" });
    eq("R15c[S15] SubagentStop 은 run-custom 1회", capOf("run-custom.mjs").length, 1);
  }

  // [S16] UserPromptSubmit — prompt 전달 + run-custom·work-flag 각 1회(grok 은 이 이벤트 출력을 무시 — 무출력).
  {
    resetCaps();
    eq("R16a[S16] 무출력", outRaw(runAdapter("UserPromptSubmit", { ...BASE, prompt: "hello", promptId: "p1" })), "");
    eq("R16b[S16] prompt 필드", JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}").prompt, "hello");
    eq("R16c[S16] work-flag 1회", capOf("work-flag.mjs").length, 1);
  }

  // [S17] Notification — notificationType → notification_type 번역(work-flag 의 '확인 필요' 판정 필드).
  {
    resetCaps();
    runAdapter("Notification", { ...BASE, notificationType: "permission_prompt", message: "approve?" });
    const sent = JSON.parse(capOf("work-flag.mjs")[0]?.stdin || "{}");
    eq("R17[S17] notification_type·message 번역", [sent.notification_type, sent.message], ["permission_prompt", "approve?"]);
  }

  // [S18] SessionEnd — reason 전달 + run-custom·work-flag 각 1회.
  {
    resetCaps();
    eq("R18a[S18] 무출력", outRaw(runAdapter("SessionEnd", { ...BASE, reason: "shutdown" })), "");
    eq("R18b[S18] reason 필드", JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}").reason, "shutdown");
    eq("R18c[S18] work-flag 1회", capOf("work-flag.mjs").length, 1);
  }

  // [S19] 모르는 이벤트 → 무출력·무발화(lively-grok.json 이 더 넓게 배선돼도 아무것도 안 막는다).
  {
    resetCaps();
    eq("R19a[S19] 모르는 이벤트 무출력", outRaw(runAdapter("StopFailure", { ...BASE, error: "rate_limit" })), "");
    eq("R19b[S19] 러너 0회", capOf("run-custom.mjs").length, 0);
  }

  // [S20] PreCompact — run-custom 만 1회(claude runnerHooksBlock 패리티 — work-flag 는 이 이벤트에 없다).
  {
    resetCaps();
    runAdapter("PreCompact", { ...BASE, source: "auto" });
    eq("R20[S20] PreCompact run-custom 1회·work-flag 0회", [capOf("run-custom.mjs").length, capOf("work-flag.mjs").length], [1, 0]);
  }

  // 배선 단언(⓪) — 관측 장치 자체가 살아 있었나: R3b·R9b 가 스텁 캡처 실존의 증거를 겸한다(vacuous 방지).
} finally { rmSync(SB, { recursive: true, force: true }); }

console.log(`\n${fail ? "✗" : "✓"} grok-adapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

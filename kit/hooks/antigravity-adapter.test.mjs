#!/usr/bin/env node
// antigravity 어댑터 사양테스트(#1689) — 어댑터를 **직접 실행**해 검증한다(순수 stdin/stdout 이라 모델 없이 된다).
//  실행: node kit/hooks/antigravity-adapter.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//  사양·엣지 표(17행): 프로젝트 #1689 spec — 케이스 이름의 [S#] 가 그 행 번호다. fail-first: mutation 5발 red 확인.
//
// 왜 이 테스트인가 — antigravity 는 PreToolUse 훅 출력이 invalid 면 **그 세션의 모든 툴 호출을 fail-closed
//  deny** 한다(#1689 실측 — 에러 문구에 훅 언급도 없어 원인 추적 불가). 그래서 이 어댑터의 1급 불변식은
//  "어떤 실패 경로에서도 유효한 decision 을 정확히 한 줄 출력한다"이고, 그걸 실패 경로별로 못박는다.
//  단언은 문구가 아니라 **부작용**으로: stdout JSON · 스텁 러너가 기록한 호출 argv/stdin · 호출 0건의 무기록.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HARNESS, mcpMatcher, toolMatcher } from "./harness-registry.mjs";
import { HOOK_SCRIPTS } from "../setup/kit-manifest.mjs";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HOOKS_DIR, "antigravity-adapter.mjs");
const KIT = join(HOOKS_DIR, "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const SRC = readFileSync(ADAPTER, "utf8");

// ── P1. 자립성 — 상대 import 0 (러너들과 같은 디렉터리에 살지만 opencode 어댑터와 같은 규약을 유지한다) ──
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
    const mcpName = HARNESS.antigravity.tools.mcp("lively", "whoami");
    const edits = HARNESS.antigravity.tools.edit;
    const hits = [mcpName, ...edits].map((t) => re.test(t));
    eq("P2a 우리 MCP·편집 툴이 work-flag 범위", hits, hits.map(() => true));
    // 오탐 방지 — 남의 MCP·읽기 툴은 안 걸린다.
    eq("P2b 남의 MCP·읽기 툴은 범위 밖", [re.test("mcp__notion__search"), re.test("view_file"), re.test("run_command")], [false, false, false]);
  }
  // matcher 축과의 정합(레지스트리 정본): antigravity matcher 는 claude 형이어야 한다(어댑터 정규화 계약).
  eq("P2c 레지스트리 matcher 정합", [mcpMatcher("antigravity", "lively"), toolMatcher("antigravity", "edit")],
    ["mcp__lively__.*", "write_to_file|replace_file_content"]);
}

// ── P3. HOOK_SCRIPTS 등재(두 목록 모두) — 누락 시 설치 자리에 어댑터가 없어 hooks.json 이 죽은 경로를 가리킨다 ──
{
  // 목록은 kit/setup/kit-manifest.mjs 단일 출처다(2026-08-27 «멤버 훅 전멸» 이후). 그래서 볼 것이 둘이다 —
  //  ① 매니페스트에 등재됐는가 ② 소비자가 지역 사본을 되살리지 않았는가(되살아나면 다시 드리프트한다).
  HOOK_SCRIPTS.includes("antigravity-adapter.mjs")
    ? ok("P3 매니페스트 HOOK_SCRIPTS 등재")
    : bad("P3 매니페스트 HOOK_SCRIPTS 등재", "누락 — 설치기·번들 조립이 복사할 소스가 없다");
  const revived = ["setup/user-install.mjs", "generator/build-context.mjs"]
    .filter((rel) => /const HOOK_SCRIPTS\s*=\s*\[/.test(readFileSync(join(KIT, rel), "utf8")));
  revived.length === 0
    ? ok("P3 소비자가 목록 사본을 두지 않음(단일 출처 유지)")
    : bad("P3 소비자가 목록 사본을 두지 않음(단일 출처 유지)", `${revived.join(", ")} 가 지역 리터럴을 되살렸다`);
}

// ── R. 실행 검증 — 스텁 러너를 심은 샌드박스(LIVELY_HOME 격리)에서 어댑터를 직접 실행 ──
const SB = mkdtempSync(join(tmpdir(), "agy-adapter-test-"));
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

const runAdapter = (event, payload) => spawnSync(process.execPath, [ADAPTER, event], {
  input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", timeout: 30000,
  env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: SB },
});
const outOf = (r) => { try { return JSON.parse(String(r.stdout || "").trim()); } catch { return { __invalid: String(r.stdout).slice(0, 120) }; } };
const capOf = (name) => {
  try { return readFileSync(join(CAP, name + ".log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
  catch { return []; }
};
const resetCaps = () => { rmSync(CAP, { recursive: true, force: true }); mkdirSync(CAP, { recursive: true }); };
const BASE = { conversationId: "conv-1", transcriptPath: "/t/transcript.jsonl", workspacePaths: ["/ws"], modelName: "m" };

try {
  // [S1] 러너 전무(~/.lively/hooks 디렉터리 자체 없음 — 신규 도입물 부재 행) → 유효 decision (fail-open 1급).
  {
    const r = runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: { CommandLine: "ls" } } });
    eq("R1[S1] 러너 부재 → exit0 + decision:ask", [r.status, outOf(r)], [0, { decision: "ask" }]);
  }
  // [S2] 비JSON stdin → 유효 출력(입력 파손이 출력 계약을 깨지 않는다).
  eq("R2[S2] 비JSON stdin → decision:ask", outOf(runAdapter("PreToolUse", "not json!!")), { decision: "ask" });

  // 이제 스텁 관측 장치를 심는다.
  mkdirSync(HOOKS, { recursive: true });
  for (const f of ["run-custom.mjs", "work-flag.mjs", "session-preload.mjs", "sync-harness-assets.mjs", "stop-writeback-gate.mjs"]) stub(f);

  // [S3] 일반 툴 — 러너에 claude 형 스냅샷(argv 이벤트+하네스 · P-D 페이로드 · env stamp).
  {
    resetCaps();
    const r = runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/x" } } });
    eq("R3a[S3] 결정 없음 → ask", outOf(r), { decision: "ask" });
    const c = capOf("run-custom.mjs");
    eq("R3b[S3] run-custom argv(이벤트+하네스)", c[0]?.argv, ["PreToolUse", "--harness", "antigravity"]);
    const sent = JSON.parse(c[0]?.stdin || "{}");
    eq("R3c[S3] claude 형 페이로드", [sent.hook_event_name, sent.tool_name, sent.session_id, sent.transcript_path, sent.cwd],
      ["PreToolUse", "run_command", "conv-1", "/t/transcript.jsonl", "/ws"]);
    eq("R3d[S3] LIVELY_HARNESS stamp", c[0]?.harness, "antigravity");
  }

  // [S4] ⭐ MCP 정규화 — 이 계약이 깨지면 org matcher(mcp__lively__.*)·기록 인정이 전부 무음(#1519 §4 급).
  {
    resetCaps();
    runAdapter("PreToolUse", { ...BASE, toolCall: { name: "call_mcp_tool", args: { ServerName: "lively", ToolName: "whoami", Arguments: { a: 1 } } } });
    const sent = JSON.parse(capOf("run-custom.mjs")[0]?.stdin || "{}");
    eq("R4[S4] call_mcp_tool → mcp__lively__whoami + Arguments", [sent.tool_name, sent.tool_input], ["mcp__lively__whoami", { a: 1 }]);
  }

  // [S5] org deny → decision:deny + 사유. [S6] allow 는 중립(동의 UI 우회 금지). [S7] 러너 쓰레기 → ask.
  {
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "정책상 금지" } }));
    const o = outOf(runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: {} } }));
    o.decision === "deny" && /정책상 금지/.test(o.reason || "") ? ok("R5[S5] org deny → decision:deny + reason") : bad("R5[S5] org deny → decision:deny + reason", JSON.stringify(o));
    stub("run-custom.mjs", JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));
    eq("R6[S6] org allow 도 중립 ask", outOf(runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: {} } })), { decision: "ask" });
    stub("run-custom.mjs", "garbage not json");
    eq("R7[S7] 러너 비JSON → ask", outOf(runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: {} } })), { decision: "ask" });
    stub("run-custom.mjs"); // 원복
  }

  // [S8] toolCall 필드 자체 부재(신규 도입물 부재 행) — 크래시·무출력 금지.
  eq("R8[S8] toolCall 부재 → 유효 ask", outOf(runAdapter("PreToolUse", { ...BASE })), { decision: "ask" });

  // [S9][S10] PostToolUse — {} + work-flag 는 정규화 후 범위에서만, run-custom 은 전 툴(claude 패리티).
  {
    resetCaps();
    eq("R9a[S9] PostToolUse 출력 {}", outOf(runAdapter("PostToolUse", { ...BASE, toolCall: { name: "call_mcp_tool", args: { ServerName: "lively", ToolName: "knowledge_save", Arguments: {} } } })), {});
    eq("R9b[S9] lively MCP → work-flag 1회", capOf("work-flag.mjs").length, 1);
    eq("R9c[S9] run-custom 1회", capOf("run-custom.mjs").length, 1);
    resetCaps();
    runAdapter("PostToolUse", { ...BASE, toolCall: { name: "view_file", args: { AbsolutePath: "/x" } } });
    eq("R10a[S10] 범위 밖 툴 → work-flag 0회", capOf("work-flag.mjs").length, 0);
    eq("R10b[S10] run-custom 은 그래도 1회", capOf("run-custom.mjs").length, 1);
  }

  // [S11][S12][S13] PreInvocation — invocationNum==0 만 세션시작 부수효과. 부재(undefined)면 오발화 금지.
  {
    resetCaps();
    eq("R11a[S11] invocationNum=0 출력 {}", outOf(runAdapter("PreInvocation", { ...BASE, invocationNum: 0 })), {});
    eq("R11b[S11] 부수효과 4종 각 1회", ["session-preload.mjs", "sync-harness-assets.mjs", "run-custom.mjs", "work-flag.mjs"].map((f) => capOf(f).length), [1, 1, 1, 1]);
    resetCaps();
    eq("R12a[S12] invocationNum=3 출력 {}", outOf(runAdapter("PreInvocation", { ...BASE, invocationNum: 3 })), {});
    eq("R12b[S12] 부수효과 0회", ["session-preload.mjs", "run-custom.mjs"].map((f) => capOf(f).length), [0, 0]);
    resetCaps();
    eq("R13a[S13] invocationNum 부재 출력 {}", outOf(runAdapter("PreInvocation", { ...BASE })), {});
    eq("R13b[S13] 부재 시 부수효과 0회(오발화 금지)", ["session-preload.mjs", "run-custom.mjs"].map((f) => capOf(f).length), [0, 0]);
  }

  // [S14][S15] Stop — 게이트 block → continue 번역(+게이트에 session_id·cwd 전달) · 무출력 → {}.
  {
    resetCaps();
    stub("stop-writeback-gate.mjs", JSON.stringify({ decision: "block", reason: "기록하고 종료하세요" }));
    const o = outOf(runAdapter("Stop", { ...BASE, terminationReason: "model_stop" }));
    o.decision === "continue" && /기록하고/.test(o.reason || "") ? ok("R14a[S14] 게이트 block → continue+reason") : bad("R14a[S14] 게이트 block → continue+reason", JSON.stringify(o));
    const gsent = JSON.parse(capOf("stop-writeback-gate.mjs")[0]?.stdin || "{}");
    eq("R14b[S14] 게이트 stdin 에 session_id·cwd", [gsent.session_id, gsent.cwd], ["conv-1", "/ws"]);
    stub("stop-writeback-gate.mjs"); // 무출력 게이트
    eq("R15[S15] 게이트 무출력 → {}(종료 허용)", outOf(runAdapter("Stop", { ...BASE, terminationReason: "model_stop" })), {});
  }

  // [S16] 모르는 이벤트 → {}(안 막음). [S17] stdout 은 정확히 JSON 한 줄.
  eq("R16[S16] 모르는 이벤트 → {}", outOf(runAdapter("PostInvocation", { ...BASE, invocationNum: 1 })), {});
  {
    const r = runAdapter("PreToolUse", { ...BASE, toolCall: { name: "run_command", args: {} } });
    eq("R17[S17] stdout 은 JSON 한 줄", String(r.stdout).trim().split("\n").filter(Boolean).length, 1);
  }

  // 배선 단언(⓪) — 관측 장치 자체가 살아 있었나: 위 케이스들에서 스텁 캡처가 실제로 쌓였다(R3b·R9b 가 그 증거).
  //  스텁이 죽어 있으면 R3b/R9b 가 빈 배열로 실패한다 — vacuous 방지는 그 두 케이스가 겸한다.
} finally { rmSync(SB, { recursive: true, force: true }); }

console.log(`\n${fail ? "✗" : "✓"} antigravity-adapter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

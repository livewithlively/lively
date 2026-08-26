#!/usr/bin/env node
// 라이블리 ↔ Grok Build 어댑터 (#1701) — claude·codex·opencode·antigravity 와 **같은 거버넌스**를 grok 세션에 붙인다.
//
// 왜 어댑터가 필요한가(#1701 실측): grok 의 훅은 이벤트명·decision 어휘가 claude 와 동형이지만 **stdin 페이로드가
//  camelCase**(sessionId·toolName·toolInput·toolResult…)고, MCP 호출은 use_tool 래퍼(toolInput 이
//  {tool_name, tool_input})로 온다. 우리 러너(~/.lively/hooks/*.mjs)는 claude 형(snake_case) 계약이므로 이 얇은
//  어댑터가 번역만 한다 — 로직을 여기 복제하면 그 순간 다섯 번째 구현이 생긴다(antigravity-adapter 와 같은 원칙).
//
// 설치: user-install 이 <grok home>/hooks/lively-grok.json 에 이 파일을 가리키는 command 를 이벤트별로 등록한다.
//  파일 자체는 ~/.lively/hooks/ 에 살므로(HOOK_SCRIPTS) 자동 업데이트가 러너와 함께 갱신한다.
//
// grok 훅 계약 요점([[grok-harness-spec-1701]] §3 — 어댑터가 지키는 것):
//  · **전부 fail-open** — 우리가 아무 출력을 안 내도 세션은 그대로 간다(antigravity 의 fail-closed 와 정반대라
//    상시 유효출력 강박이 없다). 차단은 PreToolUse 의 명시 deny(stdout JSON) 하나뿐이어야 한다.
//  · Stop 은 세션 종료 시에도 관측용으로 한 번 더 발화한다(reason:"shutdown") — 게이트·기록은 end_turn 만.
//  · 서브에이전트 내부 발화는 subagentType 이 실려 온다 — claude 는 서브에이전트 내부 이벤트를 우리 훅에 안
//    주므로(SubagentStop 제외) 같은 범위로 필터한다(세션 상태 오염·이중 기록 방지).
//  · GROK_HOOK_EVENT 가 이 프로세스 env 에 있고, 자식(러너)에게 상속된다 — 러너의 compat 이중발화 가드
//    (isForeignGrokInvocation)는 LIVELY_HARNESS=grok 을 보고 우리 경로를 통과시킨다.
//
// ⚠ 이 파일은 ~/.lively/hooks/ 안에서 러너들과 같은 디렉터리에 살지만, opencode-plugin.js 와 같은 이유로
//   **자립(상대 import 0)** 을 유지한다 — 툴 이름 상수는 인라인이고, harness-registry 의 grok.tools 와의
//   일치는 kit/hooks/grok-adapter.test.mjs 가 고정한다.

import { homedir } from "node:os";
import { join } from "node:path";
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

const HARNESS = "grok";
const EVENT = process.argv[2] || "";
const LIVELY = join(process.env.LIVELY_HOME || homedir(), ".lively");
const HOOKS = join(LIVELY, "hooks");
// lively-grok.json 의 command 가 이미 번들 node 절대경로로 이 파일을 실행한다(#355) → 자식도 같은 실행자면 충분하다.
const NODE = process.execPath;

// work-flag(세션 상태·기록 인정)를 부를 툴 — claude 의 PostToolUse matcher 두 개와 **같은 범위**(grok 이름):
//  ① 우리 MCP 툴(grok 은 `lively__<tool>` — mcp__ 접두 없음, use_tool 경유도 이 이름으로 정규화돼 온다)
//  ② 파일 편집 툴(search_replace·write — Edit|Write|MultiEdit 별칭의 실체).
//  ⚠ harness-registry.mjs 의 grok.tools({mcpMatcher, edit}) 와 일치해야 한다(테스트가 고정).
const WORK_FLAG_TOOLS = /^(?:lively__.*|search_replace|write)$/;

// grok 페이로드에서 툴 이름·인자를 꺼낸다. toolName 은 이미 정규화돼 있다(use_tool 경유 MCP 도 `server__tool`).
//  ⚠ 단 use_tool 경유면 toolInput 이 **래퍼**({tool_name, tool_input})다(#1701 실측) — 내부 인자로 언랩해
//  러너에 넘긴다(org 훅·work-flag 는 claude 계약대로 '그 툴의 인자'를 기대한다).
function toolOf(input) {
  const name = String(input?.toolName || "");
  let args = (input?.toolInput && typeof input.toolInput === "object" && !Array.isArray(input.toolInput)) ? input.toolInput : {};
  if (String(args.tool_name || "") === name && args.tool_input && typeof args.tool_input === "object" && !Array.isArray(args.tool_input)) {
    args = args.tool_input;
  }
  return { tool_name: name, tool_input: args };
}

// 러너 1회 실행 → stdout(문자열). 어떤 실패든 "" 로 삼킨다(fail-open).
//  killSignal SIGKILL: 러너가 타임아웃을 살아남아 세션을 막는 일이 없게(no-block 불변식, 타 어댑터와 동형).
function runScript(script, args, stdin, timeout) {
  try {
    const r = spawnSync(NODE, [join(HOOKS, script), ...args], {
      input: stdin, encoding: "utf8", timeout, killSignal: "SIGKILL",
      env: { ...process.env, LIVELY_HARNESS: HARNESS },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (r && typeof r.stdout === "string") ? r.stdout : "";
  } catch { return ""; }   // 러너 부재·spawn 실패 등 — 세션은 그대로 간다
}

// stdin(camelCase 페이로드)을 타임박스로 읽는다 — grok 은 stdin 을 즉시 쓰고 닫지만 hang 은 원리적으로 차단.
function readStdin(ms = 2000) {
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

// claude 형 러너 페이로드 — camelCase → snake_case 번역. cwd 는 grok 페이로드의 세션 cwd(훅 프로세스의
//  실제 cwd 는 workspace root 라 서브디렉 세션에서 어긋난다 — stop-writeback-gate 의 work-root 판정이 이 값을 쓴다).
//  transcript_path 는 grok 이 주는 updates.jsonl 절대경로(세션로그 캡처 축이 공짜로 해결되는 자리).
const payload = (event, input, extra) => JSON.stringify({
  hook_event_name: event,
  session_id: String(input?.sessionId || ""),
  transcript_path: String(input?.transcriptPath || ""),
  cwd: (typeof input?.cwd === "string" && input.cwd) || process.cwd(),
  permission_mode: String(input?.permissionMode || ""),
  ...extra,
});

const runner = (event, input, extra, timeout = 15000) =>
  runScript("run-custom.mjs", [event, "--harness", HARNESS], payload(event, input, extra), timeout);
const workFlag = (event, input, extra) =>
  runScript("work-flag.mjs", ["--harness", HARNESS], payload(event, input, extra), 5000);

// run-custom PreToolUse 출력에서 결정을 꺼낸다. 비JSON/무출력이면 null(= 아무 결정 없음).
function decisionOf(out) {
  try {
    const h = JSON.parse(String(out || "").trim()).hookSpecificOutput;
    return (h && typeof h === "object" && !Array.isArray(h)) ? h : null;
  } catch { return null; }
}

// 이벤트별 처리 → grok 에 낼 출력 객체(null 이면 무출력 — grok 은 fail-open 이라 무출력=통과).
function handle(input) {
  // 서브에이전트 내부 발화 필터 — claude 는 서브에이전트 내부 이벤트를 우리 훅에 주지 않는다(SubagentStop 제외).
  //  같은 범위를 유지해 세션 상태(work-flag)·조직 훅이 이중으로 울리지 않게 한다.
  if (input?.subagentType && EVENT !== "SubagentStop") return null;

  if (EVENT === "SessionStart") {
    // grok 은 SessionStart stdout 을 **무시**한다(관측 전용 — 실측). 컨텍스트 주입은 설치기가 발행·갱신하는
    //  <grok home>/rules/lively.md 를 하네스가 네이티브 로드하므로, 여기선 opencode·antigravity 와 동형으로
    //  **부수효과만** 쓴다: 런타임설정 갱신 · context.md write-back · 키트 자가 업데이트 트리거 · 자산 sync.
    runScript("session-preload.mjs", ["--harness", HARNESS], "", 20000);
    runScript("sync-harness-assets.mjs", ["--harness", HARNESS], "", 20000);
    runner("SessionStart", input, { source: String(input?.source || "") });
    workFlag("SessionStart", input, { source: String(input?.source || "") });
    return null;
  }

  if (EVENT === "PreToolUse") {
    // ── 조직 거버넌스가 실제로 걸리는 자리 ──
    //  claude 의 permissionDecision 중 deny 만 grok decision 으로 전파한다. grok 의 중립은 **무출력**이다 —
    //  allow 를 상시 반환하지 않는다(권한 파이프라인에서 훅 allow 는 이후 검사를 건너뛰게 하지 않지만,
    //  없는 결정을 만들어 보내지 않는 원칙은 타 하네스와 같다).
    const { tool_name, tool_input } = toolOf(input);
    const d = decisionOf(runner("PreToolUse", input, { tool_name, tool_input, tool_use_id: String(input?.toolUseId || "") }));
    if (d?.permissionDecision === "deny") {
      return { decision: "deny", reason: `Lively 정책으로 차단됨: ${d.permissionDecisionReason || "관리자 훅이 이 도구 호출을 거부했습니다."}` };
    }
    return null;
  }

  if (EVENT === "PostToolUse") {
    const { tool_name, tool_input } = toolOf(input);
    // tool_response: claude 계약의 필드명. grok 의 toolResult(구조화 객체)를 그대로 싣는다 — org 훅이 내용을
    //  뜯는 경우는 드물고, 뜯더라도 '없는 것'보단 grok 형이 낫다(정직한 passthrough).
    const extra = { tool_name, tool_input, tool_response: input?.toolResult ?? null };
    runner("PostToolUse", input, extra);
    // work-flag 는 matcher 범위 안에서만(툴콜마다 프로세스를 하나 더 띄우지 않기 위해 — claude 와 같은 이유).
    if (WORK_FLAG_TOOLS.test(tool_name)) workFlag("PostToolUse", input, extra);
    return null;
  }

  if (EVENT === "UserPromptSubmit") {
    const extra = { prompt: String(input?.prompt || "") };
    runner("UserPromptSubmit", input, extra);
    workFlag("UserPromptSubmit", input, extra);
    return null;
  }

  if (EVENT === "Notification") {
    // grok 의 notificationType(idle_prompt·permission_prompt·task_complete…)을 claude 계약의
    //  notification_type 으로 번역한다 — work-flag 의 '확인 필요' 판정이 이 필드(없으면 message)를 본다.
    const extra = { notification_type: String(input?.notificationType || ""), message: String(input?.message || "") };
    runner("Notification", input, extra);
    workFlag("Notification", input, extra);
    return null;
  }

  if (EVENT === "Stop") {
    // ⚠ Stop 은 세션 종료 시에도 발화한다(reason:"shutdown" — 결정은 무시되는 관측용, 실측). 게이트·기록은
    //  **진짜 턴 종료(end_turn)만** — 종료 쪽은 SessionEnd 가 담당한다(안 거르면 종료마다 게이트가 헛돈다).
    if (String(input?.reason || "") !== "end_turn") return null;
    const extra = { stop_hook_active: input?.stopHookActive === true };
    // 종료 게이트 — 출력 어휘가 claude 와 동형이라({"decision":"block","reason"}) **그대로 전파**한다.
    const gate = runScript("stop-writeback-gate.mjs", [], payload("Stop", input, extra), 10000);
    runner("Stop", input, extra);
    workFlag("Stop", input, extra);
    try {
      const g = JSON.parse(String(gate || "").trim());
      if (g && g.decision === "block") return { decision: "block", reason: String(g.reason || "") };
    } catch { /* 게이트 무출력/비JSON = 차단 없음 */ }
    return null;
  }

  if (EVENT === "SessionEnd") {
    const extra = { reason: String(input?.reason || "") };
    runner("SessionEnd", input, extra, 10000);
    workFlag("SessionEnd", input, extra);
    return null;
  }

  if (EVENT === "SubagentStop" || EVENT === "PreCompact" || EVENT === "PostCompact") {
    runner(EVENT, input, {});
    return null;
  }

  // 모르는 이벤트(lively-grok.json 이 더 넓게 배선된 경우) — 아무것도 막지 않는다.
  return null;
}

async function main() {
  let out = null;
  try {
    let input = {};
    try { input = JSON.parse((await readStdin()) || "{}"); } catch { /* 비JSON — 빈 입력으로 진행 */ }
    out = handle(input);
  } catch { out = null; }   // 어떤 실패도 무출력(fail-open) — grok 은 무출력을 통과로 다룬다
  if (out) process.stdout.write(JSON.stringify(out) + "\n");
}

main().then(() => process.exit(0)).catch(() => process.exit(0));

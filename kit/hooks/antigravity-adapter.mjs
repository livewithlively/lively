#!/usr/bin/env node
// 라이블리 ↔ Antigravity CLI 어댑터 — claude·codex·opencode 와 **같은 거버넌스**를 antigravity 세션에 붙인다.
//
// 왜 어댑터가 필요한가(#1689 실측): antigravity 의 훅은 hooks.json 에 command 를 등록하는 방식이라 claude 와
//  비슷해 보이지만, **stdin 페이로드(camelCase/protojson)와 stdout 계약(decision 필수)이 다르다.** 우리 러너
//  (~/.lively/hooks/*.mjs)는 claude 형(snake_case) 계약이므로, 이 얇은 어댑터가 양쪽을 번역한다 — 러너 쪽
//  로직은 하네스 공통이고 여기엔 매핑만 있다(로직을 여기 복제하면 그 순간 네 번째 구현이 생긴다).
//
// 설치: user-install 이 hooks.json(플러그인 ~/.gemini/config/plugins/lively/)에 이 파일을 가리키는 command 를
//  등록한다. 파일 자체는 ~/.lively/hooks/ 에 살므로(HOOK_SCRIPTS) 자동 업데이트가 러너와 함께 갱신한다.
//
// ⚠⚠ **유효한 decision 출력이 최우선 불변식이다(#1689 실측).** antigravity 는 PreToolUse 훅 출력이 invalid 면
//   (예: `{}` — decision 누락) 그 세션의 **모든 툴 호출을 fail-closed deny** 한다 — 에러 문구에 훅 언급도 없어
//   ("invalid tool call error (invalid_args) tool call denied with reason: ") 원인 추적이 안 된다. 그래서 이
//   어댑터는 어떤 실패 경로에서도 stdout 에 **정확히 한 번, 유효한 JSON** 을 쓴다. 러너가 아예 없어도 통과한다.
//
// ⚠ **중립값은 `ask` 다(실측).** permissions.allow 에 있는 툴은 훅이 ask 를 줘도 프롬프트 없이 실행되고
//   (Always-Allow 캐시 존중), 없는 툴은 기본 흐름(대화형=프롬프트·헤드리스=auto-deny)을 그대로 탄다 — 즉 ask 는
//   사용자의 기존 승인 상태를 완화도 강화도 하지 않는다. `allow` 를 상시 반환하면 사용자 동의 UI 를 소리 없이
//   건너뛰게 되므로(과권한 — opencode 판의 "강제력 과장 금지"와 대칭) org 훅이 명시로 낸 결정만 전파한다.
//
// ⚠ 이 파일은 ~/.lively/hooks/ 안에서 러너들과 같은 디렉터리에 살지만, opencode-plugin.js 와 같은 이유로
//   **자립(상대 import 0)** 을 유지한다 — 툴 이름 상수는 인라인이고, harness-registry 의 antigravity.tools 와의
//   일치는 kit/hooks/antigravity-adapter.test.mjs 가 고정한다.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HARNESS = "antigravity";
const EVENT = process.argv[2] || "";
const LIVELY = join(process.env.LIVELY_HOME || homedir(), ".lively");
const HOOKS = join(LIVELY, "hooks");
// hooks.json command 가 이미 번들 node 절대경로로 이 파일을 실행한다(#355) → 자식도 같은 실행자면 충분하다.
const NODE = process.execPath;

// work-flag(세션 상태·기록 인정)를 부를 툴 — claude 의 PostToolUse matcher 두 개와 **같은 범위**:
//  ① 우리 MCP 툴(어댑터 정규화 후 mcp__lively__* — 아래 normalizeTool) ② 파일 편집 툴(antigravity 실측 이름).
//  ⚠ harness-registry.mjs 의 antigravity.tools({mcpMatcher, edit}) 와 일치해야 한다(테스트가 고정).
const WORK_FLAG_TOOLS = /^(?:mcp__lively__.*|write_to_file|replace_file_content)$/;

// antigravity 의 MCP 호출은 이름이 전부 `call_mcp_tool` 이고 서버·툴은 args 에 온다(#1689 실측) —
//  이름 접두어 파싱이 불가하므로 여기서 claude 형(`mcp__<server>__<tool>`)으로 정규화해 러너에 넘긴다.
//  work-flag 의 mcpToolName()·org 훅의 matcher(mcp__lively__.*)가 전부 이 정규화를 전제로 동작한다.
function normalizeTool(name, args) {
  if (name === "call_mcp_tool") {
    const server = String(args?.ServerName || "");
    const tool = String(args?.ToolName || "");
    return { tool_name: `mcp__${server}__${tool}`, tool_input: (args && typeof args.Arguments === "object") ? args.Arguments : {} };
  }
  return { tool_name: String(name || ""), tool_input: (args && typeof args === "object") ? args : {} };
}

// 러너 1회 실행 → stdout(문자열). 어떤 실패든 "" 로 삼킨다(fail-open).
//  killSignal SIGKILL: 러너가 타임아웃을 살아남아 세션을 막는 일이 없게(no-block 불변식, opencode 어댑터와 동형).
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

// stdin(camelCase 페이로드)을 타임박스로 읽는다 — antigravity 는 stdin 을 바로 닫지만 hang 은 원리적으로 차단.
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

// claude 형 러너 페이로드 — session_id 는 conversationId, cwd 는 워크스페이스 첫 경로(없으면 프로세스 cwd —
//  훅 cwd 는 hooks.json 디렉터리라 세션 작업 위치가 아니다. stop-writeback-gate 의 work-root 판정이 이 값을 쓴다).
const payload = (event, input, extra) => JSON.stringify({
  hook_event_name: event,
  session_id: String(input?.conversationId || ""),
  transcript_path: String(input?.transcriptPath || ""),
  cwd: (Array.isArray(input?.workspacePaths) && input.workspacePaths[0]) || process.cwd(),
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

// 이벤트별 처리 → antigravity 가 요구하는 출력 객체를 반환한다(stdout 쓰기는 main 이 한 번만).
function handle(input) {
  if (EVENT === "PreInvocation") {
    // SessionStart 등가 = invocationNum==0 (매 모델 호출마다 발화하므로 0회차에만 부수효과를 건다).
    //  컨텍스트 주입은 여기서 하지 않는다 — 플러그인 rules/AGENTS.md 를 하네스가 네이티브 로드하고(설치기가
    //  발행·갱신), injectSteps 로 org-context 를 실으면 세션마다/호출마다 중복 주입 위험이 있다(#1689 실측 설계).
    //  그래서 session-preload 는 stdout 을 버리고 **부수효과만** 쓴다(opencode 와 동형): 런타임설정 갱신 ·
    //  context.md write-back · 키트 자가 업데이트 트리거.
    if (Number(input?.invocationNum) === 0) {
      runScript("session-preload.mjs", ["--harness", HARNESS], "", 20000);
      runScript("sync-harness-assets.mjs", ["--harness", HARNESS], "", 20000);
      runner("SessionStart", input, {});
      workFlag("SessionStart", input, {});
    }
    return {};
  }

  if (EVENT === "PreToolUse") {
    // ── 조직 거버넌스가 실제로 걸리는 자리 ──
    //  claude 의 permissionDecision 중 deny 만 antigravity decision 으로 전파하고, 그 외엔 중립값 ask.
    //  (run-custom 의 relay 기본값이 deny·ask·defer 라 allow 는 애초에 안 온다 — 와도 중립으로 둔다:
    //   관리자 훅이 멤버의 동의 UI 를 소리 없이 건너뛰게 하지 않는다는 원칙은 하네스가 바뀌어도 같다.)
    const { tool_name, tool_input } = normalizeTool(input?.toolCall?.name, input?.toolCall?.args);
    const d = decisionOf(runner("PreToolUse", input, { tool_name, tool_input }));
    if (d?.permissionDecision === "deny") {
      return { decision: "deny", reason: `Lively 정책으로 차단됨: ${d.permissionDecisionReason || "관리자 훅이 이 도구 호출을 거부했습니다."}` };
    }
    return { decision: "ask" };
  }

  if (EVENT === "PostToolUse") {
    const { tool_name, tool_input } = normalizeTool(input?.toolCall?.name, input?.toolCall?.args);
    runner("PostToolUse", input, { tool_name, tool_input });
    // work-flag 는 matcher 범위 안에서만(툴콜마다 프로세스를 하나 더 띄우지 않기 위해 — claude 와 같은 이유).
    if (WORK_FLAG_TOOLS.test(tool_name)) workFlag("PostToolUse", input, { tool_name, tool_input });
    return {};
  }

  if (EVENT === "Stop") {
    // 종료 게이트 — claude 의 {"decision":"block"} 을 antigravity 의 {"decision":"continue"} 로 번역한다.
    //  antigravity 는 Stop 차단을 네이티브 지원하므로(codex·opencode 에선 못 하던) 기록 너지가 실제로 선다.
    //  루프가드: 게이트 자체가 <sid>.blocked 플래그로 세션당 1회를 보장한다(두 번째 Stop 은 무출력 통과).
    const gate = runScript("stop-writeback-gate.mjs", [], payload("Stop", input, {}), 10000);
    runner("Stop", input, {});
    workFlag("Stop", input, {});
    try {
      const g = JSON.parse(String(gate || "").trim());
      if (g && g.decision === "block") return { decision: "continue", reason: String(g.reason || "") };
    } catch { /* 게이트 무출력/비JSON = 차단 없음 */ }
    return {};
  }

  // 모르는 이벤트(hooks.json 이 더 넓게 배선된 경우) — 아무것도 막지 않는 빈 객체.
  return {};
}

async function main() {
  let out = EVENT === "PreToolUse" ? { decision: "ask" } : {};   // 실패 시에도 이 값이 나간다(fail-open)
  try {
    let input = {};
    try { input = JSON.parse((await readStdin()) || "{}"); } catch { /* 비JSON — 빈 입력으로 진행 */ }
    out = handle(input) || out;
  } catch { /* 어떤 실패도 아래 유효 출력 한 번으로 수렴 */ }
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().then(() => process.exit(0)).catch(() => {
  // 최후 방어 — main 자체가 죽어도 유효 JSON 을 내고 끝낸다(fail-closed deny 방지, 상단 ⚠⚠ 참조).
  try { process.stdout.write(JSON.stringify(EVENT === "PreToolUse" ? { decision: "ask" } : {}) + "\n"); } catch { /* */ }
  process.exit(0);
});

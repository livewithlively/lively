// 라이블리 ↔ OpenCode 어댑터 (플러그인) — claude·codex 와 **같은 거버넌스**를 opencode 세션에 붙인다.
//
// 왜 이 파일만 형태가 다른가: claude·codex 는 설정 파일에 *command 문자열*을 등록하면 하네스가 우리 훅을
//  직접 실행한다. opencode 는 그런 자리가 없고 **JS 플러그인 모듈**만 받는다(#1519 실측). 그래서 이 얇은
//  어댑터가 하네스 훅을 받아 우리 러너(~/.lively/hooks/*.mjs)를 spawn 한다 — 러너 쪽 로직은 하네스 공통이고
//  여기엔 매핑만 있다(로직을 여기 복제하면 그 순간 세 번째 구현이 생긴다).
//
// 설치: user-install 이 이 파일을 ~/.config/opencode/plugin/lively.js 로 복사한다(opencode 가 그 디렉터리를
//  자동 스캔). 자동 업데이트가 HOOK_SCRIPTS 를 매번 다시 깔므로 이 어댑터도 함께 갱신된다.
//
// ⚠ 자립 파일이다 — opencode 의 플러그인 디렉터리로 **혼자** 복사되므로 상대 import 를 쓸 수 없다.
//   (그래서 툴 이름 상수를 인라인으로 둔다. harness-registry 의 opencode.tools 와 일치해야 하고,
//    그 일치는 kit/hooks/opencode-plugin.test.mjs 가 고정한다.)
//
// ⚠ **fail-open 이 불변식이다.** 어댑터의 어떤 실패도 세션을 막으면 안 된다 — 우리 배선이 고장 났을 때
//   사용자가 일을 못 하게 되는 건 거버넌스가 아니라 장애다. throw 는 **조직 훅이 deny 를 낸 경우에만** 한다.
//
// ⚠ opencode 는 bun 으로 돈다 → `process.execPath` 는 **opencode 바이너리**이지 node 가 아니다.
//   우리 러너는 node 스크립트이므로 node 를 따로 찾아야 한다(아래 NODE).

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const HARNESS = "opencode";
const spawnSync = (command, args, options) => {
  const norm = (p) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  const file = norm(command);
  const sandboxRoots = [process.env.LIVELY_HOME, process.env.TEMP, process.env.TMP, process.env.TMPDIR, tmpdir()].filter(Boolean);
  const inSandbox = sandboxRoots.some((root) => {
    const r = norm(root);
    return file === r || file.startsWith(r.endsWith(sep) ? r : r + sep);
  });
  const internalNode = /(?:^|[\\/])node(?:\.exe)?$/i.test(String(command));
  const sandbox = process.env.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox" && (internalNode || inSandbox);
  if (process.env.LIVELY_HOST_EFFECTS === "deny" && !sandbox) {
    const e = new Error(`HostEffects denied external-cli: ${command}`);
    e.code = "LIVELY_HOST_EFFECT_DENIED";
    throw e;
  }
  return nodeSpawnSync(command, args, options);
};
const LIVELY = join(process.env.LIVELY_HOME || homedir(), ".lively");
const HOOKS = join(LIVELY, "hooks");

// 번들 node(부트스트랩이 깐 안정 심링크)가 있으면 그 절대경로 — 없으면 PATH 의 node.
//  opencode 를 어디서 켜든(런처·GUI·PATH 빈약한 셸) 러너가 뜨게 하려는 것(#355 와 같은 이유).
const NODE = (() => {
  const bundled = join(LIVELY, "runtime", "current", "bin", "node");
  try { if (existsSync(bundled)) return bundled; } catch { /* 접근 불가 → PATH */ }
  return "node";
})();

// work-flag(세션 상태·기록 인정)를 부를 툴 — claude 의 PostToolUse matcher 두 개와 **같은 범위**다:
//  ① 우리 MCP 툴(`lively_*` — opencode 는 `<server>_<tool>`) ② 파일 편집 툴(opencode 는 소문자 edit/write).
//  모든 툴에 붙이지 않는 이유는 claude 와 같다 — 툴콜마다 프로세스를 하나 더 띄우게 된다.
//  ⚠ harness-registry.mjs 의 opencode.tools({mcpMatcher, edit}) 와 일치해야 한다(테스트가 고정).
const WORK_FLAG_TOOLS = /^(?:lively_.*|edit|write)$/;

// 러너 1회 실행 → stdout(문자열). 어떤 실패든 "" 로 삼킨다(fail-open).
//  killSignal SIGKILL: 러너가 타임아웃을 살아남아 세션을 막는 일이 없게(no-block 불변식, run-custom 과 동형).
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

const payload = (event, sessionID, extra) => JSON.stringify({
  hook_event_name: event,
  session_id: sessionID || "",
  cwd: process.cwd(),
  ...extra,
});

// 조직 커스텀 훅 러너(run-custom) — 이벤트는 argv, 페이로드는 stdin(claude·codex 와 같은 계약).
const runner = (event, sessionID, extra, timeout = 15000) =>
  runScript("run-custom.mjs", [event, "--harness", HARNESS], payload(event, sessionID, extra), timeout);

// 세션 상태·기록 인정(work-flag) — 이벤트는 stdin 의 hook_event_name 으로 판정한다(argv 아님).
const workFlag = (event, sessionID, extra) =>
  runScript("work-flag.mjs", ["--harness", HARNESS], payload(event, sessionID, extra), 5000);

// run-custom 의 PreToolUse 출력에서 결정을 꺼낸다. 비JSON/무출력이면 null(= 아무 결정 없음).
function decisionOf(out) {
  try {
    const h = JSON.parse(String(out || "").trim()).hookSpecificOutput;
    return (h && typeof h === "object" && !Array.isArray(h)) ? h : null;
  } catch { return null; }
}

export const LivelyAdapter = async () => ({
  // ── 세션 라이프사이클 ──
  //  SessionStart 대응 = session.created. **컨텍스트 주입은 여기서 하지 않는다** — opencode 는
  //   ~/.config/opencode/AGENTS.md 를 네이티브로 읽고, 유일한 주입 훅(experimental.chat.system.transform)은
  //   **매 요청마다** 발화해서 거기에 org-context 를 실으면 턴마다 같은 텍스트가 다시 실린다(#1519 실측).
  //   그래서 session-preload 는 stdout 을 버리고 **부수효과만** 쓴다: 런타임설정 갱신 · 자동승인 reconcile ·
  //   context.md write-back(다음 세션 AGENTS.md 시드) · 키트 자가 업데이트 트리거.
  event: async ({ event }) => {
    try {
      const t = event?.type;
      if (t === "session.created") {
        const sid = event?.properties?.info?.id || "";
        runScript("session-preload.mjs", ["--harness", HARNESS], "", 20000);
        runScript("sync-harness-assets.mjs", ["--harness", HARNESS], "", 20000);
        runner("SessionStart", sid, {});
        workFlag("SessionStart", sid, {});
      } else if (t === "session.idle") {
        // Stop 대응 — 턴 종료. 게이트웨이의 '작업 중/대기 중' 판정과 종료 게이트가 여기에 걸린다.
        const sid = event?.properties?.sessionID || "";
        runner("Stop", sid, {});
        workFlag("Stop", sid, {});
      }
    } catch { /* fail-open — 관측·부수효과 실패가 세션을 막지 않는다 */ }
  },

  // ── UserPromptSubmit 대응 ──
  //  run-custom 의 stdout 은 컨텍스트 주입용인데(지식 회수·도메인 라우팅) opencode 엔 이 훅에서 컨텍스트를
  //  실을 자리가 없다. 부수효과(세션 상태 보고)는 그대로 살리고, 주입은 미지원으로 둔다(정직 표기 — 없는
  //  기능을 있는 척하지 않는다). ⚠ 후속: experimental.chat.system.transform 에 sessionID dedup 을 걸어
  //  '그 턴에 한 번만' 싣는 방법이 있다(#1519 미확정 항목).
  "chat.message": async (input) => {
    try {
      const sid = input?.sessionID || "";
      runner("UserPromptSubmit", sid, {});
      workFlag("UserPromptSubmit", sid, {});
    } catch { /* fail-open */ }
  },

  // ── PreToolUse 대응 — **조직 거버넌스가 실제로 걸리는 자리** ──
  //  claude 의 permissionDecision(deny/ask/allow) 중 opencode 에서 강제할 수 있는 건 deny 뿐이다:
  //  이 훅의 차단 수단은 throw 이고, throw 는 이분법이라 '사용자에게 물어보기(ask)'로 번역되지 않는다.
  //  그래서 deny 만 막고 나머지는 통과시킨다 — **없는 강제력을 있는 척하면 관리자가 막았다고 믿는 것이
  //  안 막힌다**(그게 #892·#1475 에서 반복된 조용한 무력화의 형태다).
  "tool.execute.before": async (input, output) => {
    let d = null;
    try {
      d = decisionOf(runner("PreToolUse", input?.sessionID, {
        tool_name: input?.tool || "",
        tool_input: output?.args ?? {},
      }));
    } catch { return; }   // 러너 실패 = 결정 없음 → 통과(fail-open)
    if (d?.permissionDecision === "deny") {
      // 유일한 의도적 throw. 메시지는 사용자에게 그대로 보인다 — 왜 막혔는지가 화면에 남아야 한다.
      throw new Error(`Lively 정책으로 차단됨: ${d.permissionDecisionReason || "관리자 훅이 이 도구 호출을 거부했습니다."}`);
    }
  },

  // ── PostToolUse 대응 ──
  //  work-flag 는 matcher 범위 안에서만 부른다(툴콜마다 프로세스를 하나 더 띄우지 않기 위해 — claude 와 같은 이유).
  //  run-custom 은 claude 에서 matcher `.*` 로 전 툴에 걸려 있으므로 여기서도 전 툴에 건다(패리티).
  "tool.execute.after": async (input) => {
    try {
      const sid = input?.sessionID || "";
      const tool = input?.tool || "";
      runner("PostToolUse", sid, { tool_name: tool });
      if (WORK_FLAG_TOOLS.test(tool)) workFlag("PostToolUse", sid, { tool_name: tool });
    } catch { /* fail-open */ }
  },

  // ── 승인 대기 신호 ──
  //  claude 의 Notification, codex 의 PermissionRequest 자리. 세션이 '확인 필요' 상태임을 게이트웨이에 알린다
  //  (#1221 — 이게 없으면 웹에서 그 세션은 영영 '작업 중'으로만 보인다).
  //  ⚠ 여기서 status 를 바꾸지 않는다 — 승인 정책은 관리자 auto-approve(설정의 permission)가 담당하고,
  //   훅이 사용자 동의 UI 를 소리 없이 건너뛰게 하지 않는다(run-custom 의 relay 기본값과 같은 원칙).
  "permission.ask": async (input) => {
    try { workFlag("PermissionRequest", input?.sessionID, { tool_name: input?.type || "" }); }
    catch { /* fail-open */ }
  },
});

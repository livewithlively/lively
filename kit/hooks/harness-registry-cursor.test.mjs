#!/usr/bin/env node
// harness-registry 의 cursor 행 단위 테스트(#4927) — 경로 축·승인 표면·설치 계획. 순수 함수라 env 를 인자로 주입한다.
//  실행: node scripts/run-tests.mjs harness-registry-cursor
//  ⚠ Cursor 는 경로가 **두 갈래**다(번들 실측): hooks.json·mcp.json·자산은 ~/.cursor 고정 · cli-config.json 만
//   CURSOR_CONFIG_DIR > $XDG_CONFIG_HOME/cursor > ~/.cursor. 한쪽만 맞으면 승인이나 배선 한쪽이 조용히 엉뚱한 파일로 간다.
import { HARNESS, cursorCliConfigDir, placementFor, mcpToolName, installPlanFor, assetDirNames } from "./harness-registry.mjs";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const norm = (p) => String(p ?? "").replace(/\\/g, "/");
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const H = "/home/u";
// 우선순위 — CURSOR_CONFIG_DIR > XDG_CONFIG_HOME/cursor > HOME/.cursor. 빈 문자열·공백은 없는 것으로 본다.
eq("CR1 CURSOR_CONFIG_DIR 이 이긴다", norm(cursorCliConfigDir(H, { CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" })), "/c");
eq("CR2 XDG 다음", norm(cursorCliConfigDir(H, { XDG_CONFIG_HOME: "/x" })), "/x/cursor");
eq("CR3 없으면 HOME/.cursor", norm(cursorCliConfigDir(H, {})), "/home/u/.cursor");
eq("CR4 공백 값은 없는 것", norm(cursorCliConfigDir(H, { CURSOR_CONFIG_DIR: "  ", XDG_CONFIG_HOME: " " })), "/home/u/.cursor");
// LIVELY_HOME 격리면 env 를 따르지 않는다 — 테스트가 개발자 실홈의 Cursor 설정을 오염시키지 않게(opencode XDG·grok GROK_HOME 과 같은 계약).
eq("CR5 LIVELY_HOME 격리는 env 를 무시", norm(cursorCliConfigDir(H, { LIVELY_HOME: H, CURSOR_CONFIG_DIR: "/real", XDG_CONFIG_HOME: "/real-x" })), "/home/u/.cursor");
eq("CR6 승인 파일 = cli 설정 디렉터리의 cli-config.json", norm(HARNESS.cursor.autoApprove.file(H, { XDG_CONFIG_HOME: "/x" })), "/x/cursor/cli-config.json");
// 자산·훅은 env 를 타지 않는다(~/.cursor 고정) — CLI 설정을 옮긴 사람도 훅·자산은 같은 자리다.
eq("CR7 홈은 env 무관 ~/.cursor", norm(HARNESS.cursor.home(H, { CURSOR_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" })), "/home/u/.cursor");
eq("CR8 자산 자리", ["skill", "subagent", "command"].map((k) => norm(placementFor("cursor", k, "x", H, {}).file)),
  ["/home/u/.cursor/skills/x/SKILL.md", "/home/u/.cursor/agents/x.md", "/home/u/.cursor/commands/x.md"]);
// 회수 화이트리스트에 새 디렉터리명이 없다(claude 와 같은 skills·agents·commands) — 늘어나면 제거기 정규식도 늘려야 한다.
eq("CR9 자산 디렉터리명 ⊆ 기존 집합", ["skills", "agents", "commands"].every((d) => assetDirNames().has(d)), true);
eq("CR10 우리 MCP 판정(어댑터가 claude 형으로 정규화)", [mcpToolName("cursor", "lively", "mcp__lively__whoami"), mcpToolName("cursor", "lively", "MCP:whoami")], ["whoami", null]);
eq("CR11 승인 키 형태(와일드카드 포함)", [HARNESS.cursor.autoApprove.key("lively", "whoami"), HARNESS.cursor.autoApprove.key("lively", "")], ["Mcp(lively:whoami)", "Mcp(lively:*)"]);
// 설치 계획 — 바이너리는 cursor-agent(`agent` 별칭은 다른 하네스와 겹친다). POSIX 설치기는 rc 를 안 건드린다(우리가 심는다).
{
  const p = installPlanFor("cursor", { platform: "darwin", homeDir: H, env: {} });
  eq("CR12 POSIX 설치 계획", [p.bin, p.shell, p.wiresPath, norm(p.binDir), /cursor\.com\/install/.test(p.cmd)], ["cursor-agent", "sh", false, "/home/u/.local/bin", true]);
  const w = installPlanFor("cursor", { platform: "win32", homeDir: "C:\\Users\\u", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } });
  eq("CR13 윈도우 설치 계획", [w.shell, w.wiresPath, norm(w.binDir)], ["powershell", true, "C:/Users/u/AppData/Local/cursor-agent"]);
}

console.log(`\n${fail ? "✗" : "✓"} harness-registry-cursor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

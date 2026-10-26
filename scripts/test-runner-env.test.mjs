#!/usr/bin/env node
import { testChildEnv, isSoloTest, soloLast, mayStart } from "./test-runner-env.mjs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const got = testChildEnv({ LIVELY_HOST_EFFECTS: "allow", LIVELY_NO_BROWSER: "", KEEP: "yes" });
const ok = got.LIVELY_HOST_EFFECTS === "deny"
  && got.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox"
  && got.LIVELY_NO_BROWSER === "1"
  && got.KEEP === "yes";
if (!ok) {
  console.error(`FAIL E10 러너 자식 env가 capability를 닫지 못함: ${JSON.stringify(got)}`);
  process.exit(1);
}
console.log("ok  E10 직렬·병렬 공통 자식 env가 호스트 효과 deny로 수렴");

// E10b — 실행 자리의 세션 신원은 자식에게 가지 않는다(#5029). 표본은 실측한 세 자리의 env 이름 그대로다:
//  맥미니 노드 세션(LIVELY_NODE_TOKEN·LIVELY_NODE_ID·TMUX_BIN) · 중앙 박스 세션(LVLY_TENANT_SLUG·TMUX) · 하네스(CLAUDECODE·CLAUDE_CODE_*).
//  세션과 무관한 값(PATH·HOME·NODE_OPTIONS·CI)은 그대로 가야 한다 — 다 걷으면 시험이 node 도 못 찾는다.
{
  const session = {
    LIVELY_NODE_TOKEN: "n", LIVELY_NODE_ID: "laibeulliui-macmini", LIVELY_TOKEN: "t", LIVELY_MCP_TOKEN: "m",
    LIVELY_SESSION_ID: "box-x", LIVELY_SESSION_KIND: "human", LIVELY_GATEWAY_URL: "https://gw.example", LIVELY_HOME: "/real/.lively",
    LVLY_TENANT_SLUG: "ws", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%0", TMUX_BIN: "/opt/homebrew/bin/tmux", TMUX_TMPDIR: "/tmp/t",
    CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "/real/profile",
    GROK_HOME: "/real/grok", CODEX_HOME: "/real/codex",
  };
  const keep = { PATH: "/usr/bin", HOME: "/home/me", NODE_OPTIONS: "--max-old-space-size=896", CI: "true", CLAUDE_HOME_NOTE: "x" };
  const child = testChildEnv({ ...session, ...keep });
  const leaked = Object.keys(session).filter((k) => k in child);
  const lost = Object.entries(keep).filter(([k, v]) => child[k] !== v).map(([k]) => k);
  const runner = child.LIVELY_HOST_EFFECTS === "deny" && child.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox" && child.LIVELY_NO_BROWSER === "1";
  if (leaked.length || lost.length || !runner) {
    console.error(`FAIL E10b 세션 신원이 시험 자식에게 샜다: ${leaked.join(",") || "-"} · 잃은 값: ${lost.join(",") || "-"} · 러너 값: ${runner}`);
    process.exit(1);
  }
}
console.log("ok  E10b 실행 자리의 세션 신원(LIVELY_*·LVLY_*·TMUX*·CLAUDE_CODE_*…)은 시험 자식에게 가지 않고, 나머지 env 는 그대로 간다");

const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-tests.mjs"), "utf8");
const preflight = runner.indexOf("const isolationPreflight");
const firstSpawn = runner.indexOf("const jobs =");
if (preflight < 0 || firstSpawn < 0 || preflight > firstSpawn) {
  console.error("FAIL E11 격리 린트가 테스트 spawn보다 먼저 실행되지 않음");
  process.exit(1);
}
console.log("ok  E11 격리 린트 preflight가 어떤 테스트 spawn보다 먼저 실행됨");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "test.yml"), "utf8");
// E12 — 윈도우 잡의 capability 경계. 2026-08-31(#2457)에 **계약이 한 단계 강해졌다**:
//  종전엔 PowerShell foreach 로 테스트를 직접 순회했기에 그 스텝이 deny+sandbox env 를 손으로 심어야 했다.
//  그런데 러너를 우회한다는 건 env 뿐 아니라 **러너가 심는 가드 전부**(실 홈 오염 런타임 가드·격리
//  preflight·산출물 누락 검사)를 건너뛴다는 뜻이었다 — 윈도우는 '초록인데 아무도 안 보는 면'이었다.
//  이제 윈도우도 공통 러너(`run-tests.mjs --scope=…`)를 쓰므로 env 는 러너가 수렴시킨다(이 파일 위쪽 단언).
//  그래서 검사는 둘 중 하나를 요구한다: **러너를 쓰거나, 직접 순회한다면 deny+sandbox 를 손으로 심거나.**
const windowsJob = workflow.indexOf("test-windows:");
const windowsStep = workflow.indexOf("kit·desktop 테스트 (윈도우", windowsJob);
const windowsLoop = workflow.indexOf("foreach ($f in $files)", windowsJob);
const disposableStep = workflow.indexOf("Windows User PATH 호스트 효과 왕복 (disposable runner)");
const disposableAllow = workflow.indexOf("LIVELY_HOST_EFFECTS: allow", disposableStep);
// 러너 경로 — 스텝이 run-tests.mjs 를 부르고, 직접 순회 루프가 남아 있지 않다.
const usesRunner = windowsStep > 0
  && workflow.indexOf("run-tests.mjs", windowsStep) > windowsStep
  && workflow.indexOf("run-tests.mjs", windowsStep) < (windowsLoop < 0 ? Infinity : windowsLoop)
  && windowsLoop < 0;
// 직접 순회 경로(종전) — 그렇다면 루프 **앞에** 세 env 가 있어야 한다.
const loopIsClosed = windowsLoop > 0
  && ["LIVELY_HOST_EFFECTS: deny", "LIVELY_HOST_EFFECTS_TEST_MODE: sandbox", "LIVELY_NO_BROWSER: '1'"]
      .every((k) => { const at = workflow.indexOf(k, windowsStep); return at > windowsStep && at < windowsLoop; });
if (windowsJob < 0 || windowsStep < 0 || !(usesRunner || loopIsClosed) || disposableStep < 0 || disposableAllow < disposableStep) {
  console.error("FAIL E12 Windows 잡이 공통 러너를 쓰지도, 직접 순회를 deny+sandbox 로 닫지도 않았다(또는 disposable 단계가 allow 로 열리지 않음)");
  process.exit(1);
}
console.log(`ok  E12 Windows 잡 capability 경계 — ${usesRunner ? "공통 러너 경유" : "직접 순회 + deny/sandbox 명시"}, disposable 만 allow`);

// E13 — 혼자 도는 시험(#5029). 판정(머리 표식)·순서(맨 뒤로)·띄우기(혼자일 땐 아무것도 안 돌 때만)를 표로 고정하고,
//  러너가 실제로 그 순서로 내는지(--list 의 꼬리)를 배선으로 본다 — 표식만 있고 러너가 안 읽으면 그 넷은 다시 병렬로 흔들린다.
{
  const fails = [];
  const want = (label, got, exp) => { if (JSON.stringify(got) !== JSON.stringify(exp)) fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`); };
  for (const [label, src, exp] of [
    ["셔뱅 다음 줄의 표식", "#!/usr/bin/env node\n// @lively-test exclusive — 이유\n", true],
    ["첫 줄의 표식", "// @lively-test exclusive", true],
    ["들여쓰기·여러 칸", "   //   @lively-test    exclusive — x", true],
    ["단어 경계(exclusiveX 는 아니다)", "// @lively-test exclusiveX", false],
    ["줄 머리가 아닌 자리(문자열 안)", "const s = \"// @lively-test exclusive\";", false],
    ["블록 주석은 아니다", "/* @lively-test exclusive */", false],
    ["앞 4KB 밖", "x".repeat(4096) + "\n// @lively-test exclusive", false],
    ["빈 글 · 없음", "", false],
  ]) want(`isSoloTest ${label}`, isSoloTest(src), exp);
  want("isSoloTest undefined", isSoloTest(undefined), false);
  want("soloLast 혼자 도는 것을 맨 뒤로 · 묶음 안 순서 유지", soloLast(["a", "S1", "b", "S2", "c"], new Set(["S1", "S2"])), ["a", "b", "c", "S1", "S2"]);
  want("soloLast 혼자 도는 것 없음 → 그대로", soloLast(["a", "b"], new Set()), ["a", "b"]);
  for (const [label, args, exp] of [
    ["보통 · 0/2 → 띄운다", [false, 0, 2], true],
    ["보통 · 1/2 → 띄운다", [false, 1, 2], true],
    ["보통 · 2/2(경계) → 안 띄운다", [false, 2, 2], false],
    ["혼자 · 아무것도 안 돎 → 띄운다", [true, 0, 2], true],
    ["혼자 · 하나라도 돎 → 안 띄운다", [true, 1, 2], false],
    ["혼자 · 직렬(-j 1) · 0 → 띄운다", [true, 0, 1], true],
  ]) want(`mayStart ${label}`, mayStart(...args), exp);
  // 배선 — 러너의 --list 꼬리가 표식 단 파일들이다(앞에는 하나도 없다).
  const listed = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "run-tests.mjs"), "--list"], { encoding: "utf8" });
  const order = String(listed.stdout || "").trim().split("\n").filter(Boolean);
  const marked = order.map((f) => { try { return isSoloTest(readFileSync(join(repoRoot, f), "utf8")); } catch { return false; } });
  const firstSolo = marked.indexOf(true);
  if (listed.status !== 0 || firstSolo < 0) fails.push(`배선: --list exit=${listed.status} · 표식 단 파일 ${marked.filter(Boolean).length}개`);
  else if (marked.slice(firstSolo).includes(false)) fails.push(`배선: 표식 단 파일이 맨 뒤에 모이지 않았다(첫 표식 ${order[firstSolo]} 뒤에 보통 파일이 있다)`);
  if (fails.length) {
    console.error(`FAIL E13 혼자 도는 시험\n  ${fails.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`ok  E13 혼자 도는 시험 — 표식 판정·맨 뒤 순서·띄우기 규칙 · 러너가 표식 단 ${marked.filter(Boolean).length}개를 맨 뒤에 낸다`);
}

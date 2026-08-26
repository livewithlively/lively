#!/usr/bin/env node
// 비파괴 MCP 라운드트립 (②계층 itest) — 유저가 설치 전부터 쓰던 org-겹침 MCP(linear)를 install 이 덮어써도
//  uninstall 이 **유저 원본으로 되돌려 놓는가**. 설치가 덮어쓰기 전 최초 1회 스냅샷
//  (~/.lively/mcp-user-backup.json) → 제거가 add-json 으로 복원. 신규(설치 전 없던 notion)는 제거 유지.
//
// ★ 왜 kit/setup/user-uninstall.test.mjs 가 아니라 여기인가 (2026-08-27 이관)
//  이 블록은 **진짜 `claude` CLI** 를 부른다. 그런데 기본 테스트 계층의 자식 env 는 호스트 효과를 막는다
//  (scripts/test-runner-env.mjs → LIVELY_HOST_EFFECTS=deny, 그리고 os-sandbox 의 sandboxEnv 도 deny 를 싣는다).
//  그래서 그 자리에 두면 **claude 가 깔린 머신에서는 구조적으로 통과할 수 없었다**:
//     ⚠️ claude mcp remove 경고: HostEffects denied external-cli: claude
//     ⚠️ linear 복원 실패 — HostEffects denied external-cli: claude
//  claude 가 없는 리눅스 CI 는 이 블록을 **스킵**하므로 초록불이었고, 개발자 맥에서만 영구 빨간불이었다
//  (실측 2026-08-27). "원래 저래" 로 굳으면 그 파일의 다른 회귀도 같이 안 보이게 된다.
//
//  고치는 길이 하나뿐이다: 실 CLI 를 부르려면 호스트 효과를 열어야 하는데, 그건 R3 가 **기본 계층 테스트에
//  금지**한다(kit/testlib/test-isolation-rules.mjs violatesR3 — `LIVELY_HOST_EFFECTS: "allow"` 도, 
//  `--allow-host-effects` 도 소스에 있으면 위반). R3 가 적어 둔 처방이 그대로 이 이관이다:
//  "fake executor를 쓰거나 *.itest.mjs + disposable Windows CI로 옮기세요". 린트는 `kit/**/*.test.mjs` 만
//  훑으므로 여기는 면제이고, 기본 수집(run-tests)도 *.itest.mjs 를 제외한다.
//
// 실행: node scripts/uninstall-mcp-roundtrip.itest.mjs   (또는 node scripts/run-tests.mjs --itest)
//  claude 가 없으면 스킵한다(종전과 같은 규약 — 없는 것을 실패로 만들지 않는다).
//
// ⚠ 격리: 실 claude 를 부르므로 새면 실행한 사람의 진짜 ~/.claude.json 을 덮어쓴다(2026-08-20 실측 사고).
//  ① HOME 만으로는 윈도우에서 무효 — sandboxEnv() 가 HOME·USERPROFILE·TMPDIR·TEMP·TMP 를 한 벌로 돌린다(#1510).
//  ② 셸에 CLAUDE_CONFIG_DIR 가 export 돼 있으면 그게 HOME 을 이겨 claude 가 실 프로필에 쓴다(#1786) — 상속을 끊는다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../kit/testlib/os-sandbox.mjs";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

const SETUP = join(fileURLToPath(import.meta.url), "..", "..", "kit", "setup");

const hasClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasClaude) {
  console.log("skip 비파괴 MCP 라운드트립 (claude 미설치 — 통합테스트 건너뜀)");
} else {
  const box = mkdtempSync(join(tmpdir(), "uninst-mcp-"));
  const home = join(box, "home");
  const USER_URL = "https://user-owns-this.example/mcp"; // 유저가 설치 전부터 쓰던 linear URL
  // sandboxEnv 는 격리를 위해 LIVELY_HOST_EFFECTS=deny 를 싣는다. 이 왕복의 **주제가 실 CLI 호출**이라
  //  그 한 축만 연다 — HOME·TMPDIR 격리는 그대로다(열리는 건 "외부 CLI 를 부를 수 있다" 뿐이고,
  //  그 CLI 가 쓰는 자리는 위 샌드박스 홈이다).
  const boxEnv = {
    ...process.env, ...sandboxEnv({ home, tmp: box }),
    CLAUDE_CONFIG_DIR: "", LIVELY_HOST_EFFECTS: "allow",
  };
  mkdirSync(join(home, ".claude"), { recursive: true });
  // d.claude=true 되도록 lively 훅 심긴 settings.json(.lively/hooks/ 마커) — 없으면 uninstall 이 claude 블록을 건너뛴다.
  writeFileSync(join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "$HOME/.lively/hooks/session-preload.mjs"' }] }] } }) + "\n");
  spawnSync("claude", ["mcp", "add-json", "linear", JSON.stringify({ type: "http", url: USER_URL }), "--scope", "user"],
    { env: boxEnv, stdio: "ignore" }); // 유저의 설치-전 linear
  mkdirSync(join(home, ".lively"), { recursive: true });
  writeFileSync(join(home, ".lively", "mcp-servers.json"),
    JSON.stringify({ servers: [
      { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", command: null, auth_env: null }, // org 겹침
      { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", command: null, auth_env: null }, // 신규
    ] }) + "\n");
  writeFileSync(join(home, ".lively", "kit-version"), "test\n");
  // 설치: register-clients.sh — 덮어쓰기 전 최초 1회 스냅샷 + 덮어쓰기
  spawnSync("bash", [join(SETUP, "register-clients.sh")],
    { env: { ...boxEnv, STORE_URL: "http://localhost:8080/mcp", LIVELY_TOKEN: "dummy" }, stdio: "ignore" });
  // 제거: user-uninstall — remove 후 유저 원본 복원
  spawnSync(process.execPath, [join(SETUP, "user-uninstall.mjs"), "--yes"],
    { env: { ...boxEnv, LIVELY_HOME: home }, stdio: "ignore" });
  let m = {};
  try { m = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers || {}; } catch { /* */ }
  const linearOk = !!(m.linear && m.linear.url === USER_URL); // 유저 원본으로 복원
  const notionGone = !m.notion;   // 설치 전 없었으니 제거 유지
  const livelyGone = !m.lively;   // 라이블리 본체 제거
  (linearOk && notionGone && livelyGone)
    ? ok("비파괴 MCP 라운드트립 — 유저 기존 linear 원복 + 신규 notion 제거 유지 + lively 제거")
    : bad("MCP 라운드트립", `linear=${m.linear && m.linear.url} notionGone=${notionGone} livelyGone=${livelyGone}`);
  rmSync(box, { recursive: true, force: true });
}

console.log(`uninstall-mcp-roundtrip: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// user-uninstall 회귀테스트 — 심링크 경로(/tmp→/private/tmp · /var→/private/var)에서 제거기 main 이
//  **실제로 돌아야 한다**. 로그인 상태 `lively uninstall` 은 번들을 mkdtemp(/var/folders/...)에서 실행하는데,
//  진입 가드가 URL 문자열 비교(import.meta.url === `file://${process.argv[1]}`)면 Node ESM 이 엔트리를
//  realpath 로 풀어(/private/var...) argv[1](/var...)과 어긋나 main 이 조용히 스킵된다 → "아무것도 안 지워짐".
//  실측 2026-07-15(로그인 사용자 전원). install 측 user-install.test.mjs ⑥ 과 대칭 — install 만 있고
//  uninstall 엔 없어서 이 버그가 배포됐다. 가드는 realpath 비교(DIRECT_RUN)로 고쳤고 이 테스트가 재발을 막는다.
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME)에서만, 실제 ~/.lively·~/.claude·rc 무접촉.
//  실행: node kit/setup/user-uninstall.test.mjs  (npm test 체인에 포함)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

const HERE = join(fileURLToPath(import.meta.url), "..");

// setup/ 전체(user-uninstall.mjs 포함)를 심링크 뒤 번들로 복사하고, link/ → real/ 심링크로 실행 경로를 만든다.
//  (macOS 표준 임시경로 /var/folders·/tmp 의 /private/* 심링크를 소형으로 재현.)
function symlinkedBundle(prefix) {
  const box = mkdtempSync(join(tmpdir(), prefix));
  const bundle = join(box, "real", "bundle");
  mkdirSync(bundle, { recursive: true });
  cpSync(HERE, join(bundle, "setup"), { recursive: true });
  symlinkSync(join(box, "real"), join(box, "link"));
  return { box, entry: join(box, "link", "bundle", "setup", "user-uninstall.mjs") };
}

// ① 심링크 경로 직접 실행 → main 이 실제로 돈다(헤더 출력 = 진입 증거). 옛 가드면 stdout 이 텅 빈다.
{
  const { box, entry } = symlinkedBundle("uninst-sym-");
  const home = join(box, "home");
  mkdirSync(home, { recursive: true });
  const out = execFileSync(process.execPath, [entry, "--dry-run"],
    { env: { ...process.env, LIVELY_HOME: home }, encoding: "utf8" });
  out.includes("lively 제거")
    ? ok("① 심링크 경로 실행에도 제거기 main 진입(헤더 출력)")
    : bad("① 심링크 직접실행", `stdout 에 헤더 없음(main 스킵?): ${JSON.stringify(out.slice(0, 80))}`);
  rmSync(box, { recursive: true, force: true });
}

// ② 심링크 경로 + 실제 설치(~/.lively 존재) → 제거가 실제로 일어난다(main 이 돌 뿐 아니라 작동).
//    detect() 게이트(user-uninstall.mjs)는 existsSync(LIVELY) 면 no-op 하지 않고 [3] ~/.lively 제거까지 간다.
{
  const { box, entry } = symlinkedBundle("uninst-real-");
  const home = join(box, "home");
  const lively = join(home, ".lively");
  mkdirSync(lively, { recursive: true });
  writeFileSync(join(lively, "kit-version"), "test\n"); // 설치 마커
  execFileSync(process.execPath, [entry, "--yes", "--purge"],
    { env: { ...process.env, LIVELY_HOME: home }, stdio: "ignore" });
  !existsSync(lively)
    ? ok("② 심링크 경로 실행이 ~/.lively 를 실제 제거(--purge)")
    : bad("② 심링크 실제제거", "~/.lively 가 남아있음 — main 이 스킵됐거나 제거가 안 됨");
  rmSync(box, { recursive: true, force: true });
}

// ③ 비파괴 MCP 라운드트립 — 유저가 설치 전부터 쓰던 org-겹침 MCP(linear)를 install 이 덮어써도 uninstall 이 원복.
//    설치가 덮어쓰기 전 최초 1회 스냅샷(~/.lively/mcp-user-backup.json) → 제거가 add-json 으로 복원. 신규(설치 전 없던 notion)는 제거 유지.
//    실제 claude 로 register-clients.sh(스냅샷+덮어쓰기)→user-uninstall(복원) 왕복. CI 에 claude 없으면 스킵(스킵도 통과로 센다).
{
  const hasClaude = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
  if (!hasClaude) {
    console.log("skip ③ 비파괴 MCP 라운드트립 (claude 미설치 — 통합테스트 건너뜀)");
  } else {
    const box = mkdtempSync(join(tmpdir(), "uninst-mcp-"));
    const home = join(box, "home");
    const USER_URL = "https://user-owns-this.example/mcp"; // 유저가 설치 전부터 쓰던 linear URL
    mkdirSync(join(home, ".claude"), { recursive: true });
    // d.claude=true 되도록 lively 훅 심긴 settings.json(.lively/hooks/ 마커) — 없으면 uninstall 이 claude 블록을 건너뛴다.
    writeFileSync(join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "$HOME/.lively/hooks/session-preload.mjs"' }] }] } }) + "\n");
    spawnSync("claude", ["mcp", "add-json", "linear", JSON.stringify({ type: "http", url: USER_URL }), "--scope", "user"],
      { env: { ...process.env, HOME: home }, stdio: "ignore" }); // 유저의 설치-전 linear
    mkdirSync(join(home, ".lively"), { recursive: true });
    writeFileSync(join(home, ".lively", "mcp-servers.json"),
      JSON.stringify({ servers: [
        { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", command: null, auth_env: null }, // org 겹침
        { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", command: null, auth_env: null }, // 신규
      ] }) + "\n");
    writeFileSync(join(home, ".lively", "kit-version"), "test\n");
    // 설치: register-clients.sh — 덮어쓰기 전 최초 1회 스냅샷 + 덮어쓰기
    spawnSync("bash", [join(HERE, "register-clients.sh")],
      { env: { ...process.env, HOME: home, STORE_URL: "http://localhost:8080/mcp", LIVELY_TOKEN: "dummy" }, stdio: "ignore" });
    // 제거: user-uninstall — remove 후 유저 원본 복원
    spawnSync(process.execPath, [join(HERE, "user-uninstall.mjs"), "--yes"],
      { env: { ...process.env, HOME: home, LIVELY_HOME: home }, stdio: "ignore" });
    let m = {};
    try { m = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers || {}; } catch { /* */ }
    const linearOk = !!(m.linear && m.linear.url === USER_URL); // 유저 원본으로 복원
    const notionGone = !m.notion;   // 설치 전 없었으니 제거 유지
    const livelyGone = !m.lively;   // 라이블리 본체 제거
    (linearOk && notionGone && livelyGone)
      ? ok("③ 비파괴 MCP 라운드트립 — 유저 기존 linear 원복 + 신규 notion 제거 유지 + lively 제거")
      : bad("③ MCP 라운드트립", `linear=${m.linear && m.linear.url} notionGone=${notionGone} livelyGone=${livelyGone}`);
    rmSync(box, { recursive: true, force: true });
  }
}

console.log(`user-uninstall tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

#!/usr/bin/env node
// Windows 에서 lively stdio MCP 와 훅이 심(lively.cmd)·맨몸 node 대신 node.exe 절대경로로 뜨는지 — 사양 테스트.
//  배경: 보안 솔루션이 배치 실행을 막는 PC 에서 `lively.cmd` 가 «액세스가 거부되었습니다» 로 못 뜬다(2026-11-05).
//  CLI(livelyStdioLaunch)와 self-update(livelyStdioEntry)는 같은 규칙을 따로 갖는다 — 같은 표로 함께 시험한다.
//  self-update 가 이미 등록된 항목을 고치는 규칙(correctStdioEntry)도 여기서 win 을 주입해 잰다(통합은 self-update.test ⑮i·⑮j).
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closedPath, nodeOnlyDir, noBrowserEnv, sandboxEnv } from "../testlib/os-sandbox.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "lvly-stdio-launch-"));
process.env.LIVELY_HOME = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { livelyStdioEntry, isOurShimEntry, correctStdioEntry } = await import(pathToFileURL(join(HERE, "stdio-launch.mjs")));
const { livelyStdioLaunch, missingLaunchTargets } = await import(pathToFileURL(join(HERE, "..", "cli", "lively.mjs")));
const { winNodeBin, winNodeToken, connectCommandFiles } = await import(pathToFileURL(join(HERE, "..", "setup", "user-install.mjs")));

const SHIM = "C:\\Profiles\\홍길동\\.lively\\bin\\lively.cmd";
const CLI = "C:\\Profiles\\홍길동\\.lively\\lib\\lively.mjs";

// [win, nodeExe, 기대: node 직결이면 true]
const CASES = [
  [true, "C:\\Profiles\\홍길동\\.lively\\runtime\\node-v22.14.0-win-x64\\node.exe", true],
  [true, "C:/Program Files/nodejs/node.exe", true],
  [true, "\\\\fileserver\\tools\\node.exe", true],
  [true, "D:\\nodejs\\NODE.EXE", true],
  [true, "node", false],
  [true, "node.exe", false],
  [true, ".\\runtime\\node.exe", false],
  [true, "C:\\tools\\bun.exe", false],
  [true, "C:\\nodejs\\node.exe.bak", false],
  [true, "", false],
  [true, undefined, false],
  [false, "C:\\Program Files\\nodejs\\node.exe", false],
  [false, "/usr/local/bin/node", false],
];

for (const [win, nodeExe, direct] of CASES) {
  for (const sub of ["mcp", "mcp-local"]) {
    test(`실행 형태 win=${win} node=${JSON.stringify(nodeExe)} ${sub} → ${direct ? "node 직결" : "심"}`, () => {
      const cliArgv = livelyStdioLaunch({ win, shim: SHIM, nodeExe, cliPath: CLI, sub });
      const entry = livelyStdioEntry({ win, shim: SHIM, nodeExe, cliPath: CLI, sub });
      const want = direct ? [nodeExe, CLI, sub] : [SHIM, sub];
      assert.deepEqual(cliArgv, want);
      assert.deepEqual(entry, { type: "stdio", command: want[0], args: want.slice(1), env: {} });
    });
  }
}

test("심 직결형 판정 — 우리가 심은 모양만 참", () => {
  assert.equal(isOurShimEntry({ type: "stdio", command: SHIM, args: ["mcp"], env: {} }, SHIM, "mcp"), true);
  // 저장 표기가 대소문자·구분자만 달라도 같은 심이다
  assert.equal(isOurShimEntry({ type: "stdio", command: SHIM.replace(/\\/g, "/").toUpperCase(), args: ["mcp-local"] }, SHIM, "mcp-local"), true);
  // 사람이 바꾼 항목·다른 서버는 건드리지 않는다
  assert.equal(isOurShimEntry({ type: "stdio", command: SHIM, args: ["mcp", "--debug"] }, SHIM, "mcp"), false);
  assert.equal(isOurShimEntry({ type: "stdio", command: SHIM, args: ["mcp-local"] }, SHIM, "mcp"), false);
  assert.equal(isOurShimEntry({ type: "stdio", command: "C:\\other\\lively.cmd", args: ["mcp"] }, SHIM, "mcp"), false);
  assert.equal(isOurShimEntry({ type: "http", url: "https://x/mcp" }, SHIM, "mcp"), false);
  assert.equal(isOurShimEntry(null, SHIM, "mcp"), false);
  // 이미 node 직결로 옮긴 항목은 다시 교정 대상이 아니다(멱등)
  const direct = livelyStdioEntry({ win: true, shim: SHIM, nodeExe: "C:\\n\\node.exe", cliPath: CLI, sub: "mcp" });
  assert.equal(isOurShimEntry(direct, SHIM, "mcp"), false);
});

// ── 기존 등록의 교정(self-update reconcile) ──────────────────────────────────
//  우리 것(심 직결형 · node.exe 가 사라진 node 직결형)만 command·args 를 지금 기준으로 바꾸고 나머지 필드는 그대로 둔다.
//  win 을 주입해 비 Windows 러너에서도 Windows 모양(node 직결)을 잰다. exists 는 가짜 — 살아 있는 경로만 참.
const OLD_NODE = "C:\\Profiles\\홍길동\\.lively\\runtime\\node-v22.14.0-win-x64\\node.exe";
const NEW_NODE = "C:\\Profiles\\홍길동\\.lively\\runtime\\node-v22.15.0-win-x64\\node.exe";
const aliveOnly = (...alive) => (p) => alive.includes(p);
const wantFor = (sub, nodeExe = NEW_NODE) => livelyStdioEntry({ win: true, shim: SHIM, nodeExe, cliPath: CLI, sub });
const fix = (cur, sub, { want = wantFor(sub), exists = aliveOnly(NEW_NODE) } = {}) =>
  correctStdioEntry(cur, want, { shim: SHIM, cliPath: CLI, sub, exists });
const deadEntry = (sub, extra = {}) => ({ type: "stdio", command: OLD_NODE, args: [CLI, sub], env: {}, ...extra });

for (const sub of ["mcp", "mcp-local"]) {
  test(`교정 B1 — node.exe 가 사라진 node 직결형(${sub})은 지금 node 로`, () => {
    const r = fix(deadEntry(sub), sub);
    assert.equal(r?.from, "dead-node");
    assert.deepEqual(r.entry, { type: "stdio", command: NEW_NODE, args: [CLI, sub], env: {} });
  });
}

test("교정 B2 — 사람이 붙인 env·timeout·disabled·모르는 필드는 그대로 둔다", () => {
  const cur = deadEntry("mcp", { env: { HTTPS_PROXY: "http://proxy.corp:8080" }, timeout: 45000, disabled: false, note: "사내 프록시" });
  assert.deepEqual(fix(cur, "mcp")?.entry, {
    type: "stdio", command: NEW_NODE, args: [CLI, "mcp"],
    env: { HTTPS_PROXY: "http://proxy.corp:8080" }, timeout: 45000, disabled: false, note: "사내 프록시",
  });
});

test("교정 B3 — 살아 있는 node 를 가리키면 지금 node 와 달라도 그대로(실행마다 오가지 않는다)", () => {
  assert.equal(fix(deadEntry("mcp"), "mcp", { exists: aliveOnly(OLD_NODE, NEW_NODE) }), null);
});

test("교정 B4~B7 — 남의 설치·사람이 바꾼 모양·node 가 아닌 실행 파일은 경로가 죽었어도 그대로", () => {
  const OTHER_CLI = "C:\\dev\\lively-checkout\\.lively\\lib\\lively.mjs";
  assert.equal(fix({ type: "stdio", command: OLD_NODE, args: [OTHER_CLI, "mcp"] }, "mcp"), null);           // B4 다른 설치
  assert.equal(fix({ type: "stdio", command: OLD_NODE, args: [CLI, "mcp", "--debug"] }, "mcp"), null);     // B5 인자 추가
  assert.equal(fix({ type: "stdio", command: OLD_NODE, args: [CLI, "mcp"] }, "mcp-local"), null);           // B6 다른 서버
  assert.equal(fix({ type: "stdio", command: "C:\\tools\\bun.exe", args: [CLI, "mcp"] }, "mcp"), null);     // B7 node 아님
});

test("교정 B8 — stdio 항목이 아니거나 비었으면 그대로", () => {
  for (const cur of [{ type: "http", url: "https://gw.example/mcp" }, null, undefined, OLD_NODE]) {
    assert.equal(fix(cur, "mcp"), null, JSON.stringify(cur));
  }
});

test("교정 B9 — 심 직결형은 node 직결로 옮기되 사람이 붙인 env·timeout 은 그대로", () => {
  const r = fix({ type: "stdio", command: SHIM, args: ["mcp-local"], env: { LIVELY_DEBUG: "1" }, timeout: 30000 }, "mcp-local");
  assert.equal(r?.from, "shim");
  assert.deepEqual(r.entry, { type: "stdio", command: NEW_NODE, args: [CLI, "mcp-local"], env: { LIVELY_DEBUG: "1" }, timeout: 30000 });
});

test("교정 B10 — 이미 지금 꼴이면 그대로(멱등) · 심 꼴 기준에서 심 직결형도 그대로", () => {
  assert.equal(fix(wantFor("mcp"), "mcp"), null);
  const shimWant = livelyStdioEntry({ win: false, shim: SHIM, nodeExe: NEW_NODE, cliPath: CLI, sub: "mcp" });
  assert.equal(fix({ type: "stdio", command: SHIM, args: ["mcp"], env: {} }, "mcp", { want: shimWant }), null);
});

test("교정 B11 — 죽은 node 직결형은 지금 규칙의 대상이 심이면 심으로(필드는 그대로)", () => {
  const shimWant = wantFor("mcp", "C:\\tools\\node22.exe");   // 절대 node.exe 가 아니다 → 심 꼴
  const r = fix(deadEntry("mcp", { env: { A: "1" } }), "mcp", { want: shimWant });
  assert.equal(r?.from, "dead-node");
  assert.deepEqual(r.entry, { type: "stdio", command: SHIM, args: ["mcp"], env: { A: "1" } });
});

test("교정 B12 — 저장 표기가 대소문자·구분자만 달라도 우리 것 · UNC 죽은 경로도 교정", () => {
  const mixed = { type: "stdio", command: OLD_NODE.replace(/\\/g, "/"), args: [CLI.replace(/\\/g, "/").toUpperCase(), "mcp"] };
  assert.deepEqual(fix(mixed, "mcp")?.entry, { type: "stdio", command: NEW_NODE, args: [CLI, "mcp"] });
  const unc = { type: "stdio", command: "\\\\fileserver\\tools\\node.exe", args: [CLI, "mcp"] };
  assert.equal(fix(unc, "mcp")?.entry.command, NEW_NODE);
});

test("교정 B13 — 지금 꼴이 stdio 가 아니면(롤백 스위치 http) 손대지 않는다", () => {
  assert.equal(fix(deadEntry("mcp"), "mcp", { want: { type: "http", url: "https://gw.example/mcp", headers: {} } }), null);
});

// ── doctor — 훅·MCP 가 가리키는 실행 파일이 사라졌나 ─────────────────────────────
//  설치 때 구운 node 경로가 지워지면 훅이 전부 죽고, 훅이 띄우는 자가 업데이트도 못 떠 스스로 못 돌아온다.
//  «배선»·«등록» 칸은 그래도 ✓ 라 doctor 가 따로 짚어야 한다. 절대경로만 판정한다(PATH 이름은 모른다).
test("실행 파일 D1~D4 — 훅 첫 토큰(따옴표 유무)·MCP command 의 절대경로 중 없는 것만, 한 번씩", () => {
  const WIN_DEAD = "C:/Profiles/홍길동/.lively/runtime/node-v22.14.0-win-x64/node.exe";
  const POSIX_DEAD = "/Users/me/.lively/runtime/current/bin/node";
  const hookCommands = [
    `${WIN_DEAD} "C:/Profiles/홍길동/.lively/hooks/session-preload.mjs"`,                 // D1 윈도우 — 따옴표 없는 첫 토큰
    `${WIN_DEAD} "C:/Profiles/홍길동/.lively/hooks/run-custom.mjs" Stop`,                 //    같은 경로는 한 번만
    `"${POSIX_DEAD}" "$HOME/.lively/hooks/work-flag.mjs"`,                                // D2 POSIX — 큰따옴표로 감싼 첫 토큰
    `node "C:/Profiles/홍길동/.lively/hooks/stop-writeback-gate.mjs"`,                    // D3 맨몸 node — 판정하지 않는다
    `"node" "$HOME/.lively/hooks/sync-harness-assets.mjs"`,
    `C:/alive/node.exe "C:/Profiles/홍길동/.lively/hooks/x.mjs"`,                         // D4 살아 있는 경로
  ];
  const mcpCommands = ["\\\\fileserver\\tools\\node.exe", "C:\\Profiles\\홍길동\\.lively\\bin\\lively.cmd", "C:/alive/node.exe"];
  const alive = new Set(["C:/alive/node.exe", "C:\\Profiles\\홍길동\\.lively\\bin\\lively.cmd"]);
  assert.deepEqual(missingLaunchTargets({ hookCommands, mcpCommands, exists: (p) => alive.has(p) }).sort(),
    [WIN_DEAD, POSIX_DEAD, "\\\\fileserver\\tools\\node.exe"].sort());
});

test("실행 파일 D5 — 넣을 게 없으면 빈 목록(부재)", () => {
  assert.deepEqual(missingLaunchTargets({ exists: () => false }), []);
  assert.deepEqual(missingLaunchTargets({ hookCommands: ["", "   "], mcpCommands: [null, undefined, ""], exists: () => false }), []);
});

test("실행 파일 D6 — doctor 가 실제 설정 파일에서 읽어 사라진 실행 파일을 ✗ 로 짚는다(배선 단언 포함)", () => {
  const box = mkdtempSync(join(SANDBOX, "doctor-"));
  const run = (home) => {
    const r = spawnSync(process.execPath, [join(HERE, "..", "cli", "lively.mjs"), "doctor", "--json"], {
      cwd: home, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, ...sandboxEnv({ home }), ...noBrowserEnv(), LIVELY_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
        LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", PATH: closedPath(nodeOnlyDir(box)), NO_COLOR: "1" },
    });
    try { return JSON.parse(r.stdout).checks.find((c) => c.name === "훅·MCP 실행 파일") ?? null; }
    catch { return { error: `exit=${r.status} ${String(r.stderr).slice(-300)}` }; }
  };
  const mkHome = (name, hookCmd, mcpCmd) => {
    const home = join(box, name);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCmd }] }] } }));
    writeFileSync(join(home, ".claude", ".claude.json"), JSON.stringify({ mcpServers: { "lively-local": { type: "stdio", command: mcpCmd, args: ["mcp-local"], env: {} } } }));
    return home;
  };
  const DEAD = "C:/lvly-gone/runtime/node-v0.0.0-win-x64/node.exe";
  const dead = run(mkHome("dead", `${DEAD} "C:/u/.lively/hooks/session-preload.mjs"`, "/lvly-gone/bin/lively"));
  assert.equal(dead?.pass, false, JSON.stringify(dead));
  assert.ok(dead.detail.includes(DEAD) && dead.detail.includes("/lvly-gone/bin/lively"), JSON.stringify(dead));
  const healthy = run(mkHome("healthy", `"node" "$HOME/.lively/hooks/session-preload.mjs"`, process.execPath));
  assert.equal(healthy?.pass, true, JSON.stringify(healthy));
});

test("훅용 node — 절대경로 node.exe 는 forward-slash 로, 그 밖은 맨몸 node", () => {
  assert.equal(winNodeBin("C:\\Profiles\\홍길동\\.lively\\runtime\\node-v22.14.0-win-x64\\node.exe"),
    "C:/Profiles/홍길동/.lively/runtime/node-v22.14.0-win-x64/node.exe");
  assert.equal(winNodeBin("C:/Program Files/nodejs/node.exe"), "C:/Program Files/nodejs/node.exe");
  for (const bad of ["node", "", undefined, "/usr/bin/node", "C:\\tools\\bun.exe", "node.exe"]) assert.equal(winNodeBin(bad), "node", String(bad));
});

test("훅 명령 첫 토큰 — 따옴표 없이 절대경로, 공백 든 경로·맨몸 node 는 종전 `node`", () => {
  // PowerShell 은 따옴표로 시작하는 줄을 실행하지 않는다 — 첫 토큰에 따옴표를 쓰지 않는다
  assert.equal(winNodeToken("C:/Profiles/홍길동/.lively/runtime/node-v22.14.0-win-x64/node.exe"), "C:/Profiles/홍길동/.lively/runtime/node-v22.14.0-win-x64/node.exe");
  assert.equal(winNodeToken("C:/Program Files/nodejs/node.exe"), "node");
  assert.equal(winNodeToken("node"), "node");
});

test("훅 명령 첫 토큰 — 셸 메타문자·유니코드 따옴표·공백류가 하나라도 든 경로는 종전 `node`", () => {
  //  git-bash · cmd · PowerShell 이 따옴표 없는 첫 토큰을 글자 그대로 받지 않는 문자들(C4·C5·C2)
  const at = (ch) => `C:/Users/a${ch}b/.lively/runtime/node-v22.14.0-win-x64/node.exe`;
  for (const ch of ["(", ")", "&", ";", "'", '"', "$", "^", ",", "%", "!", "=", "#", "@", "+", "[", "]", "{", "}", "`",
    "\u2018", "\u2019", "\u201C", "\u201D", "\u2013", "\u2014", " ", "\t", "\u00A0"]) {
    assert.equal(winNodeToken(at(ch)), "node", JSON.stringify(ch));
  }
  assert.equal(winNodeToken("C:/Program Files (x86)/nodejs/node.exe"), "node");
  // C6 경계 — 8.3 짧은 이름의 `~` 는 세 셸 모두 글자 그대로다
  assert.equal(winNodeToken("C:/Users/HONGGI~1/.lively/runtime/node-v22.14.0-win-x64/node.exe"), "C:/Users/HONGGI~1/.lively/runtime/node-v22.14.0-win-x64/node.exe");
  // C7 부재 — 빈 값은 맨몸 node
  assert.equal(winNodeToken(""), "node");
});

test("«여기 연결» 커맨드 — Windows 에서 node 경로를 알면 심을 거치지 않는 명령을 준다", () => {
  const NODE = "C:/Profiles/홍길동/.lively/runtime/node-v22.14.0-win-x64/node.exe";
  const LIB = "C:/Profiles/홍길동/.lively/lib/lively.mjs";
  const SHIM_P = "C:\\Profiles\\홍길동\\.lively\\bin\\lively.cmd";
  for (const format of ["claude", "codex", "cursor"]) {
    const files = connectCommandFiles({ format, shim: SHIM_P, win: true, nodeBin: NODE, cliPath: LIB });
    for (const f of files) {
      const verb = f.id === "lively-connect" ? "add" : "remove";
      assert.ok(f.text.includes(`"${NODE}" "${LIB}" work-root ${verb} "<폴더>"`), `${format}/${f.id}: node 직결 명령 없음`);
      assert.ok(!f.text.includes(`\`lively work-root ${verb}`), `${format}/${f.id}: 심 명령이 남아 있음`);
    }
  }
  // node 경로를 모르면(맨몸 node)·Windows 가 아니면 종전 명령 그대로
  for (const o of [{ win: true, nodeBin: "node" }, { win: false, nodeBin: NODE }]) {
    for (const f of connectCommandFiles({ format: "claude", shim: SHIM_P, cliPath: LIB, ...o })) {
      const verb = f.id === "lively-connect" ? "add" : "remove";
      assert.ok(f.text.includes(`\`lively work-root ${verb} "<폴더>"\``), `${JSON.stringify(o)}/${f.id}: 종전 명령 없음`);
      assert.ok(!f.text.includes(LIB), `${JSON.stringify(o)}/${f.id}: node 직결이 섞임`);
    }
  }
});

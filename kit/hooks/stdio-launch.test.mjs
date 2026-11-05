#!/usr/bin/env node
// Windows 에서 lively stdio MCP 와 훅이 심(lively.cmd)·맨몸 node 대신 node.exe 절대경로로 뜨는지 — 사양 테스트.
//  배경: 보안 솔루션이 배치 실행을 막는 PC 에서 `lively.cmd` 가 «액세스가 거부되었습니다» 로 못 뜬다(2026-11-05).
//  CLI(livelyStdioLaunch)와 self-update(livelyStdioEntry)는 같은 규칙을 따로 갖는다 — 같은 표로 함께 시험한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "lvly-stdio-launch-"));
process.env.LIVELY_HOME = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { livelyStdioEntry, isOurShimEntry } = await import(pathToFileURL(join(HERE, "stdio-launch.mjs")));
const { livelyStdioLaunch } = await import(pathToFileURL(join(HERE, "..", "cli", "lively.mjs")));
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

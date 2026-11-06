#!/usr/bin/env node
// 설치가 끝났다는 말과 실제 동작이 갈리지 않게 — 사양 표의 행마다 시나리오 하나.
//  배경(실측 2026-11-02): 기록 범위 기본값이 «작업 폴더에서만» 이 된 뒤에도 설치 끝 문구는 «아무 폴더에서든 맥락이 따라온다» 였고,
//   status 는 배선만 봐서 전부 ✓ 였다. 그래서 사람은 연결됐다고 믿는데 일반 폴더의 세션엔 «라이블리 꺼짐» 만 들어갔다.
//   또 `curl … | sh` 뒤 같은 창에서 안내대로 `lively status` 를 치면 `command not found` 가 나온다.
//  N 설치 끝 안내(판정과의 일치 포함 · 실제 `lively install` 끝은 lively.test ③) · W 윈도 node 직결 등록 안내 · P setup 끝의 PATH 안내 · S status · D doctor.
//  ⚠ 안내가 판정과 어긋나는지는 **실제 판정 함수**로 잰다 — 문구만 맞추면 판정이 바뀔 때 또 거짓이 된다.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closedPath, nodeOnlyDir, noBrowserEnv, sandboxEnv } from "../testlib/os-sandbox.mjs";
import * as rs from "../hooks/record-scope.mjs";
import { launchNotice, setupDoneHints, workRootAddCommand, workRootAddHint } from "./lively.mjs";
import { connectCommandFiles, winNodeBin } from "../setup/user-install.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");
const BOX = mkdtempSync(join(tmpdir(), "lively-scope-notice-test-"));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

let seq = 0;
const mkdir = (...parts) => { const d = join(BOX, ...parts); mkdirSync(d, { recursive: true }); return d; };
// 홈 하나 — scope 가 없으면 사본이 없는 컴퓨터(서버에서 아직 못 받음)다.
function mkHome({ scope = null, roots = [] } = {}) {
  const home = mkdir(`home-${++seq}`);
  const lively = join(home, ".lively");
  mkdirSync(lively, { recursive: true });
  if (scope) rs.writeScopeFile(lively, { scope, work_roots: roots });
  return { home, lively };
}
const WORK_FOLDERS = "work_folders", ANYWHERE = "anywhere";

// 실제 CLI 프로세스 — 홈 샌드박스 · 닫힌 PATH · 게이트웨이 없음(로그인 전 이른 return 도 함께 지난다).
//  세션 폴더를 바꾸는 값은 비운다(이 시험을 AI 세션 안에서 돌려도 cwd 로 판정되게).
const envOf = (home) => ({
  ...process.env, ...sandboxEnv({ home }), ...noBrowserEnv(), LIVELY_HOME: home, LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  PATH: closedPath(nodeOnlyDir(BOX)), NO_COLOR: "1", CLAUDE_PROJECT_DIR: "", CURSOR_PROJECT_DIR: "", LIVELY_HARNESS: "", LIVELY_WORK_ROOTS: "",
});
const cli = (home, cwd, args, file = CLI) => spawnSync(process.execPath, [file, ...args], { cwd, env: envOf(home), encoding: "utf8", timeout: 60_000 });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
// 이 플랫폼에서 CLI 가 낼 등록 안내 — 윈도 CI 에선 node 직결형이다(W 절). 홈은 CLI 의 LIVELY_HOME(없으면 OS 홈).
const hintFor = (home) => workRootAddHint({ win: process.platform === "win32", nodeExe: process.execPath, cliPath: join(home, ".lively", "lib", "lively.mjs") });

try {
  // ── N. 설치 끝 안내 ─────────────────────────────────────────────────────────────
  const anyPlace = (n) => n.line.includes("아무 폴더");
  const n1 = launchNotice("Cursor", { scope: null, roots: 0 });
  check("N1 ★ 사본 없음 — 받으면 꺼질 수 있으니 아무 폴더라고 단정하지 않고 등록 명령을 함께 말한다",
    !anyPlace(n1) && !n1.needsRoot && n1.line.includes("Cursor") && n1.line.includes(hintFor(process.env.LIVELY_HOME || homedir())), JSON.stringify(n1));
  const n2 = launchNotice("Cursor", { scope: ANYWHERE, roots: 0 });
  check("N2 어디서나 — 아무 폴더", anyPlace(n2) && !n2.needsRoot, JSON.stringify(n2));
  const n3 = launchNotice("Cursor", { scope: WORK_FOLDERS, roots: 0 });
  check("N3 ★ 작업 폴더에서만 · 0개 — 아무 폴더라고 하지 않고 등록을 시킨다", !anyPlace(n3) && n3.needsRoot, JSON.stringify(n3));
  const n4 = launchNotice("Cursor", { scope: WORK_FOLDERS, roots: 1 });
  check("N4 경계 — 작업 폴더 1개면 재촉하지 않는다", !anyPlace(n4) && !n4.needsRoot, JSON.stringify(n4));
  check("N5 값을 안 줘도 멈추지 않는다(판정 모듈이 없는 옛 설치의 빈 값)", launchNotice("Cursor").line.includes("Cursor"), "");

  // ── W. 배치 실행이 막힌 윈도우 PC(2026-11-05) — 등록 안내가 lively.cmd 대신 node 를 바로 부른다 ─────────────
  //  CLI 와 훅(record-scope.mjs)은 서로 import 하지 않고 같은 규칙을 두 벌 둔다 — 같은 입력에 같은 명령을 내는지 여기서 맞대 본다.
  //  기대값 표 자체는 kit/hooks/record-scope.test.mjs W1.
  const NODE = "C:\\Profiles\\me\\.lively\\runtime\\node-v22.11.0-win-x64\\node.exe";
  const CLI_JS = "C:\\Profiles\\me\\.lively\\lib\\lively.mjs";
  const same = [
    { win: true, nodeExe: NODE, cliPath: CLI_JS },
    { win: true, nodeExe: NODE, cliPath: CLI_JS, dir: "C:\\work\\my proj" },
    { win: true, nodeExe: NODE, cliPath: CLI_JS, dir: "C:\\work\\it's" },
    { win: true, nodeExe: "D:/rt/NODE.EXE", cliPath: CLI_JS },
    { win: true, nodeExe: "\\\\srv\\rt\\node.exe", cliPath: CLI_JS },
    { win: true, nodeExe: "node", cliPath: CLI_JS, dir: "C:\\w\\p" },
    { win: true, nodeExe: "rt\\node.exe", cliPath: CLI_JS },
    { win: true, nodeExe: "C:\\rt\\node", cliPath: CLI_JS },
    { win: false, nodeExe: NODE, cliPath: CLI_JS },
    { win: false, nodeExe: "/usr/bin/node", cliPath: "/home/me/.lively/lib/lively.mjs", dir: "/home/me/a b" },
    { win: false, nodeExe: "/usr/bin/node", cliPath: "/x", dir: "/home/me/it's" },
  ];
  for (const o of same) {
    const a = workRootAddCommand(o), b = rs.workRootAddCommand(o);
    check(`W1 CLI·훅 등록 명령이 같다 — ${JSON.stringify(o)}`, a === b, `cli=${a} hook=${b}`);
  }
  const direct = rs.workRootAddCommand({ win: true, nodeExe: NODE, cliPath: CLI_JS });
  //  /lively-connect 본문(user-install.mjs connectCommandFiles)도 같은 node 판정으로 같은 명령을 싣는다 — 세 번째 사본의 드리프트를 잡는다.
  for (const o of same.filter((x) => x.win && !x.dir)) {
    const body = connectCommandFiles({ format: "codex", win: true, nodeBin: winNodeBin(o.nodeExe), cliPath: o.cliPath.replace(/\\/g, "/") })[0].text;
    const want = `\`${workRootAddCommand(o)} "<폴더>"\``;
    check(`W1 /lively-connect 본문도 같은 명령 — ${o.nodeExe}`, body.includes(want), `want=${want}\n${body}`);
  }
  const winHint = workRootAddHint({ win: true, nodeExe: NODE, cliPath: CLI_JS });
  check("W2 ★ 윈도 node 직결 — /lively-connect 를 먼저, 셸 명령은 node 직접 호출", winHint.startsWith("/lively-connect") && winHint.endsWith(direct) && !winHint.includes("lively work-root"), winHint);
  check("W2 그 밖엔 종전 명령 그대로", workRootAddHint({ win: false, nodeExe: "/usr/bin/node", cliPath: "/x" }) === "lively work-root add");
  const wn = launchNotice("Cursor", { scope: null, roots: 0, hint: winHint });
  check("W3 설치 끝 안내도 같은 안내를 쓴다", wn.line.includes(winHint) && !wn.line.includes("lively work-root"), wn.line);

  // 일관성 — 안내가 «등록 필요» 라고 하는 곳은 실제 판정도 꺼져 있고, 아니라고 하는 곳은 켜져 있다.
  const plain = mkdir("plain-work");
  const rows = [
    ["사본 없음", {}, plain],
    ["어디서나", { scope: ANYWHERE }, plain],
    ["작업 폴더 0개", { scope: WORK_FOLDERS }, plain],
    ["작업 폴더 1개 · 그 안", { scope: WORK_FOLDERS, roots: [plain] }, plain],
  ];
  for (const [name, setup, dir] of rows) {
    const { lively } = mkHome(setup);
    const s = rs.effectiveSettings(lively);
    const n = launchNotice("Cursor", { scope: s?.scope ?? null, roots: rs.workRootsOf(lively, s, {}).length });
    const d = rs.decideRecordScope({ env: {}, dir, lively });
    check(`N6 안내와 실제 판정이 같다 — ${name}`, n.needsRoot === !d.inScope, `needsRoot=${n.needsRoot} inScope=${d.inScope}`);
  }

  // 설치가 실제로 부르는 함수를 실제 판정과 함께 — 샌드박스 프로세스에서(홈이 안 갈리면 위 N6 과 다른 값을 볼 수 있다).
  const sayNotice = (home) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(CLI).href)}); await m.sayLaunchNotice(["cursor"], (l) => console.log(l));`],
  { cwd: plain, env: envOf(home), encoding: "utf8", timeout: 30_000 });
  const offHome = mkHome({ scope: WORK_FOLDERS }).home;
  const off = sayNotice(offHome);
  check("N7 ★ 작업 폴더 0개인 컴퓨터의 설치 끝에 등록 명령이 나온다",
    off.status === 0 && off.stdout.includes("Cursor") && off.stdout.includes(hintFor(offHome)) && !off.stdout.includes("아무 폴더"), off.stdout + off.stderr);
  const on = sayNotice(mkHome({ scope: ANYWHERE }).home);
  check("N7 어디서나인 컴퓨터엔 등록 명령이 없다", on.status === 0 && on.stdout.includes("아무 폴더") && !on.stdout.includes("work-root"), on.stdout + on.stderr);

  // ── P. setup 끝 — 이 창의 PATH ─────────────────────────────────────────────────
  const hints = [];
  setupDoneHints((l) => hints.push(l));
  check("P1 ★ setup 끝에 같은 창의 command not found 를 어떻게 할지 말한다", hints.some((l) => l.includes("command not found")), JSON.stringify(hints));

  // ── S. status ─────────────────────────────────────────────────────────────────
  const inside = mkdir("registered", "repo");
  const cases = {
    off: { ...mkHome({ scope: WORK_FOLDERS }), cwd: plain },
    root: { ...mkHome({ scope: WORK_FOLDERS, roots: [join(BOX, "registered")] }), cwd: inside },
    any: { ...mkHome({ scope: ANYWHERE }), cwd: plain },
    none: { ...mkHome(), cwd: plain },
  };
  for (const c of Object.values(cases)) {
    c.json = json(cli(c.home, c.cwd, ["status", "--json"]));
    c.text = cli(c.home, c.cwd, ["status"]).stderr;
  }
  check("S-배선 네 경우 모두 JSON 을 냈고 값이 들어 있다",
    Object.values(cases).every((c) => c.json && "recordScope" in c.json), JSON.stringify(Object.values(cases).map((c) => c.json && Object.keys(c.json).length)));
  const hasHint = (c) => c.text.includes(hintFor(c.home));
  const off1 = cases.off.json?.recordScope;
  check("S1 ★ 작업 폴더 0개 · 일반 폴더 — 꺼짐으로 나온다", off1?.scope === WORK_FOLDERS && off1?.roots === 0 && off1?.inScope === false, JSON.stringify(off1));
  check("S1 ★ 사람 출력에 꺼짐과 등록 명령이 나온다", cases.off.text.includes("꺼짐") && hasHint(cases.off), cases.off.text);
  const root1 = cases.root.json?.recordScope;
  check("S2 등록한 폴더 아래 — 켜짐 · 등록 명령 없음", root1?.inScope === true && root1?.roots === 1 && !hasHint(cases.root), JSON.stringify(root1) + cases.root.text);
  const any1 = cases.any.json?.recordScope;
  check("S3 어디서나 — 켜짐 · 등록 명령 없음", any1?.scope === ANYWHERE && any1?.inScope === true && !hasHint(cases.any), JSON.stringify(any1) + cases.any.text);
  const none1 = cases.none.json?.recordScope;
  check("S4 사본 없음 — 범위 값 없음 · 범위 줄 없음(판정도 켬)", none1?.scope === null && none1?.inScope === true && !cases.none.text.includes("기록 범위"), JSON.stringify(none1));

  // 판정 모듈이 없는 옛 설치 — 설치 자리(lib)엔 hooks 가 옆에 없을 수 있다. CLI 파일들만 따로 놓고 돌린다.
  const lone = mkdir("lone", "cli");
  for (const f of readdirSync(HERE)) if (f.endsWith(".mjs") && !f.endsWith(".test.mjs")) cpSync(join(HERE, f), join(lone, f));
  const oldKit = cli(cases.off.home, plain, ["status", "--json"], join(lone, "lively.mjs"));
  check("S5 판정 모듈이 없으면 null · status 는 죽지 않는다", oldKit.status === 0 && json(oldKit)?.recordScope === null, `exit=${oldKit.status} ${oldKit.stderr.slice(-300)}`);

  // ── D. doctor — 꺼진 폴더는 고장이 아니다 ───────────────────────────────────────
  const dr = (c) => json(cli(c.home, c.cwd, ["doctor", "--json"]));
  const scopeCheck = (c) => dr(c)?.checks?.find((x) => x.name === "기록 범위");
  const dOff = scopeCheck(cases.off);
  check("D1 ★ doctor 가 꺼진 폴더를 보여 주되 실패로 세지 않는다", dOff?.pass === true && dOff?.detail.includes("꺼짐"), JSON.stringify(dOff));
  const noneChecks = dr(cases.none)?.checks;
  check("D2 사본이 없으면 범위 항목이 없다(doctor 는 돌았다)",
    Array.isArray(noneChecks) && noneChecks.length > 0 && !noneChecks.some((x) => x.name === "기록 범위"), JSON.stringify(noneChecks?.map((x) => x.name)));
} finally {
  try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);

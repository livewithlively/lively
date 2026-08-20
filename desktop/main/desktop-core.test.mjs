// 데스크톱 앱 코어 (#1541 T2) — Electron 없이 도는 층 전부.
//  CLI 탐색 · NDJSON 파싱 · CLI 구동(스텁 spawn) · 진행 리듀서 · IPC argv · 트레이 메뉴 모델.
//  실행: node desktop/main/desktop-core.test.mjs
//
// ⚠ 여기가 앱 로직의 **유일한 검증 지점**이다: Electron 을 띄우는 건 CI 에서 못 하고 사람 손이 필요하다.
//  그래서 Electron API 의존을 main.mjs 한 파일에 가두고, 판단이 있는 코드는 전부 이쪽에 둔다.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, existsSync as existsSyncReal } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCandidates, locateCli, cliShimName, cliMissingHelp, bootstrapOneLiner, cliLaunchSpec } from "./cli-locate.mjs";
import { bootstrapCommand, runBootstrap } from "./bootstrap.mjs";
import { createNdjsonParser, runCli, reduceProgress, lastError, cliContractVerdict } from "./cli-runner.mjs";
import { argvFor, RUN_KINDS, IPC } from "./ipc-contract.mjs";
import { trayMenuModel, statusLabel } from "./tray-menu.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";
import { shouldCheckForUpdates, updateFailureNote, UPDATE_INTERVAL_MS, UPDATE_OPT_OUT_ENV, shouldAutoApplyUpdate, updateReadyNote, AUTO_APPLY_DELAY_MS, downloadProgressNote, PROGRESS_NOTE_MIN_MS } from "./update-policy.mjs";
import { STALE_QUERY_PS, parseStaleQuery, pickStaleInstalls, uninstallerPath, uninstallerArgs, staleCleanupPs, staleInstallNote, psQuote, APP_ID, APP_GUID, UNINSTALLER_NAME, uuidV5 } from "./win-stale-install.mjs";
import { createRequire } from "node:module";
import { normalizeBounds, pickBounds, MIN_SIZE, DEFAULT_SIZE, MIN_VISIBLE } from "./window-bounds.mjs";
import { LOG_VIEWS, resolveLogPath, tailText } from "./log-view.mjs";
import { manifestRefs, manifestProblems, GITHUB_SAFE } from "../verify-update-manifest.mjs";
import { versionLabel } from "./tray-menu.mjs";
import { RETRYABLE_KINDS } from "./ipc-contract.mjs";
import { updateStatusNote } from "./update-policy.mjs";
import { posix as pposix } from "node:path";

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };
const ta = async (n, fn) => { await fn(); pass++; console.log(`ok  ${n}`); };

// ── A. CLI 탐색 ──────────────────────────────────────────────────────────────
const WENV = { USERPROFILE: "C:\\Users\\yoon", LOCALAPPDATA: "C:\\Users\\yoon\\AppData\\Local" };

t("A1 설치 규약이 정한 자리(~/.lively/bin)가 1순위 — GUI 앱은 PATH 가 빈약하다", () => {
  assert.equal(cliCandidates("darwin", { HOME: "/Users/yoon" })[0], "/Users/yoon/.lively/bin/lively");
  assert.equal(cliCandidates("win32", WENV)[0], "C:\\Users\\yoon\\.lively\\bin\\lively.cmd");
});

t("A2 윈도우 심 이름은 .cmd, 경로 구분자도 진짜 Windows 것", () => {
  assert.equal(cliShimName("win32"), "lively.cmd");
  assert.equal(cliShimName("darwin"), "lively");
  for (const p of cliCandidates("win32", WENV)) {
    assert.ok(!p.includes("/"), `POSIX 구분자가 섞였다: ${p}`);
    assert.ok(p.endsWith("lively.cmd"), p);
  }
});

t("A3 LIVELY_CLI 가 있으면 그것만 본다(개발·테스트의 지목을 폴백이 덮지 않게)", () => {
  assert.deepEqual(cliCandidates("darwin", { HOME: "/Users/yoon", LIVELY_CLI: "/tmp/build/lively" }), ["/tmp/build/lively"]);
});

t("A4 LIVELY_HOME 을 홈으로 존중(샌드박스 계약)", () => {
  assert.equal(cliCandidates("darwin", { HOME: "/Users/yoon", LIVELY_HOME: "/tmp/box" })[0], "/tmp/box/.lively/bin/lively");
});

t("A5 env 가 비어도 throw 하지 않고 목록을 낸다", () => {
  for (const plat of ["darwin", "linux", "win32"]) {
    const c = cliCandidates(plat, {});
    assert.ok(Array.isArray(c), plat);
    assert.ok(c.every((p) => typeof p === "string" && p.length), `빈 항목: ${plat}`);
  }
});

t("A6 locateCli 는 존재하는 첫 후보 — 없으면 null(추측한 경로를 반환하지 않는다)", () => {
  const env = { HOME: "/Users/yoon" };
  assert.equal(locateCli((p) => p === "/usr/local/bin/lively", "darwin", env), "/usr/local/bin/lively");
  // 1순위가 있으면 그게 이긴다
  assert.equal(locateCli(() => true, "darwin", env), "/Users/yoon/.lively/bin/lively");
  assert.equal(locateCli(() => false, "darwin", env), null);
});

t("A7 CLI 부재 안내는 **다음 행동**을 준다(플랫폼별 부트스트랩 한 줄)", () => {
  assert.equal(bootstrapOneLiner("https://dev.lvly.io", "darwin"), "curl -fsSL https://dev.lvly.io/cli | sh");
  assert.equal(bootstrapOneLiner("https://dev.lvly.io/", "win32"), "irm https://dev.lvly.io/cli.ps1 | iex");
  assert.match(cliMissingHelp("https://dev.lvly.io", "darwin"), /curl -fsSL https:\/\/dev\.lvly\.io\/cli \| sh/);
  // 주소를 모르면 명령을 지어내지 않는다 — 주소부터 물어야 한다고 말한다.
  assert.equal(bootstrapOneLiner("", "darwin"), null);
  assert.ok(!/curl|irm/.test(cliMissingHelp("", "darwin")));
});

t("A8 ★ 부트스트랩 URL 이 웹 관리화면이 주는 한 줄과 같다(다르면 사람은 404 를 받는다)", () => {
  // 진실원천: 게이트웨이 라우트(src/web.ts `/cli`·`/cli.ps1`)와 그걸 복붙시키는 화면(public/app/admin-install.js).
  //  앱이 그와 다른 주소를 안내하면 아무도 그 사실을 모른 채 설치가 막힌다.
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const web = readFileSync(join(repo, "src", "web.ts"), "utf8");
  assert.match(web, /app\.get\("\/cli",\s*serveBootstrap\("bootstrap\.sh"\)\)/, "게이트웨이 라우트가 바뀌었다");
  assert.match(web, /app\.get\("\/cli\.ps1",\s*serveBootstrap\("bootstrap\.ps1"\)\)/, "게이트웨이 라우트가 바뀌었다");
  const admin = readFileSync(join(repo, "public", "app", "admin-install.js"), "utf8");
  const gw = "https://gw.example";
  for (const [plat, needle] of [["darwin", `curl -fsSL ${gw}/cli | sh`], ["win32", `irm ${gw}/cli.ps1 | iex`]]) {
    const mine = bootstrapOneLiner(gw, plat);
    assert.equal(mine, needle, plat);
    // 화면 코드가 같은 모양의 템플릿을 쓰는지(경로 조각으로 확인 — 변수명·따옴표는 자유).
    assert.ok(admin.includes(plat === "win32" ? "/cli.ps1 | iex" : "/cli | sh"), `admin-install.js 와 어긋남: ${plat}`);
  }
});

// ── B. NDJSON 파서 ───────────────────────────────────────────────────────────
t("B1 청크가 줄 중간에서 잘려도 이벤트가 유실되지 않는다", () => {
  const got = [];
  const p = createNdjsonParser((e) => got.push(e));
  p.push('{"v":1,"t":"start"');
  p.push(',"cmd":"setup"}\n{"v":1,"t":"st');
  p.push('ep","id":"a","status":"start"}\n');
  assert.deepEqual(got.map((e) => e.t), ["start", "step"]);
  assert.equal(got[0].cmd, "setup");
});

t("B2 이벤트가 아닌 줄(비-JSON·배열·t 없음)은 raw 로 넘어간다 — 조용히 버리지 않는다", () => {
  const got = [], raw = [];
  const p = createNdjsonParser((e) => got.push(e), (l) => raw.push(l));
  for (const l of ["쓰레기\n", "[1,2]\n", '{"no":"type"}\n', '"str"\n']) p.push(l);
  assert.equal(got.length, 0);
  assert.deepEqual(raw, ["쓰레기", "[1,2]", '{"no":"type"}', '"str"']);
});

t("B3 flush 는 개행 없이 끝난 마지막 줄까지 흘린다", () => {
  const got = [];
  const p = createNdjsonParser((e) => got.push(e));
  p.push('{"v":1,"t":"end","ok":true}');
  assert.equal(got.length, 0, "개행 전엔 안 나간다");
  p.flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].t, "end");
});

// ── C. CLI 구동 — 스텁 spawn 으로 부작용 관측 ────────────────────────────────
/** 가짜 자식 프로세스. script(child) 로 원하는 시나리오를 연출한다. */
function stubSpawn(script) {
  const calls = [];
  const spawn = (cli, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { written: [], write(s) { this.written.push(s); }, end() { this.ended = true; } };
    child.killed = null;
    child.kill = (sig) => { child.killed = sig || "SIGTERM"; };
    calls.push({ cli, args, opts, child });
    setImmediate(() => script(child));
    return child;
  };
  return { spawn, calls };
}
const ev = (o) => JSON.stringify(o) + "\n";

await ta("C1 정상 실행 — 이벤트·result 를 모으고 ok=true", async () => {
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "start", cmd: "status" }));
    c.stdout.emit("data", ev({ v: 1, t: "result", data: { cli: "0.1.0" } }));
    c.stdout.emit("data", ev({ v: 1, t: "end", ok: true, code: 0 }));
    c.emit("close", 0, null);
  });
  const r = await runCli({ cli: "/bin/lively", args: ["status", "--json"], spawn: s.spawn });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { cli: "0.1.0" });
  assert.equal(r.error, null);
  // --json-events 를 **구동기가** 붙인다(호출자가 잊어도 계약이 지켜진다).
  assert.deepEqual(s.calls[0].args, ["status", "--json", "--json-events"]);
});

await ta("C2 ★ end 를 못 받으면 종료코드 0 이어도 실패다", async () => {
  // CLI 가 중간에 죽으면(크래시·강제종료) 이벤트는 그럴싸하게 몇 개 와 있다. 종료코드만 보면 성공으로 읽힌다.
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "start", cmd: "install" }));
    c.stdout.emit("data", ev({ v: 1, t: "step", id: "kit-download", status: "start" }));
    c.emit("close", 0, null);
  });
  const r = await runCli({ cli: "/bin/lively", args: ["install"], spawn: s.spawn });
  assert.equal(r.ok, false);
  assert.match(r.error, /완료 신호/);
});

await ta("C3 실패는 마지막 error notice 문구를 이유로 준다", async () => {
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "notice", level: "error", message: "게이트웨이 주소가 없습니다" }));
    c.stdout.emit("data", ev({ v: 1, t: "end", ok: false, code: 1 }));
    c.emit("close", 1, null);
  });
  const r = await runCli({ cli: "/bin/lively", args: ["login"], spawn: s.spawn });
  assert.equal(r.ok, false);
  assert.equal(r.error, "게이트웨이 주소가 없습니다");
});

await ta("C4 강제 종료(signal)는 성공으로 위장하지 않는다", async () => {
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "end", ok: true, code: 0 }));   // end 는 왔지만
    c.emit("close", null, "SIGKILL");                                    // 시그널로 끝났다
  });
  const r = await runCli({ cli: "/bin/lively", args: ["install"], spawn: s.spawn });
  assert.equal(r.ok, false);
  assert.match(r.error, /강제 종료/);
});

await ta("C5 prompt 에 답하면 stdin 으로 한 줄이 나간다(같은 id)", async () => {
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "prompt", id: "confirm-1", kind: "confirm", label: "계속?" }));
    setTimeout(() => { c.stdout.emit("data", ev({ v: 1, t: "end", ok: true, code: 0 })); c.emit("close", 0, null); }, 20);
  });
  const asked = [];
  const r = await runCli({ cli: "/bin/lively", args: ["login"], spawn: s.spawn, onPrompt: (p) => { asked.push(p); return true; } });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].id, "confirm-1");
  assert.deepEqual(s.calls[0].child.stdin.written.map((l) => JSON.parse(l)), [{ t: "answer", id: "confirm-1", value: true }]);
});

await ta("C6 통지형 prompt(device-code)엔 답하지 않는다 — undefined 를 주면 조용히 넘어간다", async () => {
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "prompt", id: "device-code", kind: "device-code", user_code: "AB-12" }));
    setTimeout(() => { c.stdout.emit("data", ev({ v: 1, t: "end", ok: true, code: 0 })); c.emit("close", 0, null); }, 20);
  });
  const r = await runCli({ cli: "/bin/lively", args: ["login"], spawn: s.spawn, onPrompt: () => undefined });
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls[0].child.stdin.written, [], "답할 게 없는 프롬프트에 답하면 CLI 가 오독한다");
});

await ta("C7 stderr 는 버리지 않는다(줄 단위 + 전문 보존)", async () => {
  const s = stubSpawn((c) => {
    c.stderr.emit("data", "✗ 토큰이 거부됐습니다\n두 번째 줄\n");
    c.stdout.emit("data", ev({ v: 1, t: "end", ok: false, code: 1 }));
    c.emit("close", 1, null);
  });
  const lines = [];
  const r = await runCli({ cli: "/bin/lively", args: ["login"], spawn: s.spawn, onStderr: (l) => lines.push(l) });
  assert.deepEqual(lines, ["✗ 토큰이 거부됐습니다", "두 번째 줄"]);
  assert.match(r.stderr, /토큰이 거부/);
});

await ta("C8 spawn 자체가 실패해도(실행파일 없음) throw 하지 않고 이유를 준다", async () => {
  const r = await runCli({ cli: "/nope", args: ["status"], spawn: () => { throw new Error("ENOENT"); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /실행하지 못했습니다/);
});

await ta("C9 취소 손잡이는 stdin 을 닫는다(대기 중 프롬프트를 fail-closed 로 푼다)", async () => {
  let handle = null;
  const s = stubSpawn((c) => {
    c.stdout.emit("data", ev({ v: 1, t: "prompt", id: "confirm-1", kind: "confirm" }));
    setTimeout(() => c.emit("close", 1, null), 30);
  });
  await runCli({ cli: "/bin/lively", args: ["login"], spawn: s.spawn, onHandle: (h) => { handle = h; setTimeout(() => h.cancel(), 10); } });
  assert.ok(handle, "취소 손잡이가 없으면 사용자가 멈출 방법이 없다");
  assert.equal(s.calls[0].child.stdin.ended, true, "stdin 을 안 닫으면 CLI 가 영원히 기다린다");
});

// ── C2. 부트스트랩(새 PC — CLI 자체가 없을 때) ──────────────────────────────
t("H1 플랫폼별 부트스트랩 명령 — 게이트웨이가 서빙하는 그 스크립트를 그대로 실행한다", () => {
  const mac = bootstrapCommand("https://dev.lvly.io", "darwin");
  assert.equal(mac.cmd, "/bin/sh");
  assert.deepEqual(mac.args, ["-c", "curl -fsSL https://dev.lvly.io/cli | sh"]);
  const win = bootstrapCommand("https://dev.lvly.io/", "win32");
  assert.equal(win.cmd, "powershell.exe");
  assert.ok(win.args.includes("-NoProfile"), "프로필이 출력·PATH 를 오염시킨다");
  assert.ok(win.args[win.args.length - 1] === "irm https://dev.lvly.io/cli.ps1 | iex");
});

t("H2 ★ 셸 문자열에 주소가 들어간다 — 셸 메타문자는 절대 통과시키지 않는다", () => {
  // 여기가 뚫리면 게이트웨이 주소 입력칸이 곧 임의 명령 실행이다(`sh -c` 문자열 안이니까).
  for (const bad of [
    "https://a.io; rm -rf /", "https://a.io && curl evil", "https://a.io | sh", "https://a.io`id`",
    "https://a.io$(id)", "https://a.io'x'", 'https://a.io"x"', "https://a.io\\x", "http://a.io >out", "ftp://a.io",
    "", "   ",
  ]) {
    assert.throws(() => bootstrapCommand(bad, "darwin"), /형식/, `통과해버림: ${JSON.stringify(bad)}`);
  }
});

await ta("H3 출력은 줄 단위로 흘리고, 실패는 실패로 보고한다", async () => {
  const lines = [];
  const s = stubSpawn((c) => {
    c.stdout.emit("data", "  ✓ Node 준비 완료\n  · lively 설치");
    c.stdout.emit("data", " 중…\n");
    c.emit("close", 1, null);
  });
  const r = await runBootstrap({ gatewayUrl: "https://a.io", spawn: s.spawn, onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ["  ✓ Node 준비 완료", "  · lively 설치 중…"], "청크 경계에서 줄이 깨졌다");
  assert.equal(r.ok, false);
  assert.match(r.error, /실패/);
});

await ta("H4 stdio 는 파이프다 — TTY 를 주면 스크립트가 `lively setup` 으로 인계해 흐름이 갈라진다", async () => {
  const s = stubSpawn((c) => c.emit("close", 0, null));
  await runBootstrap({ gatewayUrl: "https://a.io", spawn: s.spawn });
  assert.deepEqual(s.calls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
});

// ── D. 진행 리듀서 ───────────────────────────────────────────────────────────
t("D1 같은 id 의 step 은 줄을 늘리지 않고 갱신한다", () => {
  let s;
  s = reduceProgress(s, { t: "start", cmd: "install" });
  s = reduceProgress(s, { t: "step", id: "kit", label: "키트", status: "start", i: 1, n: 3 });
  s = reduceProgress(s, { t: "step", id: "kit", label: "키트", status: "done", i: 1, n: 3 });
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].status, "done");
  assert.equal(s.i, 1); assert.equal(s.n, 3);
});

t("D2 진행률을 모르면 null — 0% 로 그리면 멈춘 것처럼 보인다", () => {
  const s = reduceProgress(undefined, { t: "step", id: "x", status: "start" });
  assert.equal(s.i, null); assert.equal(s.n, null);
});

t("D3 end 는 done/ok 를 확정하고 남은 프롬프트를 지운다", () => {
  let s = reduceProgress(undefined, { t: "prompt", id: "q", kind: "confirm" });
  assert.ok(s.prompt);
  s = reduceProgress(s, { t: "end", ok: false, code: 1 });
  assert.equal(s.done, true); assert.equal(s.ok, false);
  assert.equal(s.prompt, null, "끝난 뒤에도 프롬프트가 떠 있으면 사용자가 답을 기다린다");
});

t("D4 리듀서는 이전 상태를 변형하지 않는다(렌더러가 스냅샷을 보관한다)", () => {
  const a = reduceProgress(undefined, { t: "step", id: "x", status: "start" });
  const b = reduceProgress(a, { t: "step", id: "y", status: "start" });
  assert.equal(a.steps.length, 1);
  assert.equal(b.steps.length, 2);
});

t("D5 lastError 는 **마지막** error notice", () => {
  assert.equal(lastError([{ t: "notice", level: "error", message: "첫" }, { t: "notice", level: "info", message: "중간" }, { t: "notice", level: "error", message: "끝" }]), "끝");
  assert.equal(lastError([{ t: "notice", level: "info", message: "x" }]), null);
});

// ── E. IPC argv — 렌더러가 argv 를 만들지 못하게 ─────────────────────────────
t("E1 작업 종류별 argv 는 여기서만 만든다", () => {
  assert.deepEqual(argvFor("setup"), ["setup"]);
  assert.deepEqual(argvFor("install"), ["install"]);
  assert.deepEqual(argvFor("node-start"), ["node", "--daemon"]);
  assert.deepEqual(argvFor("node-stop"), ["node", "stop"]);
  assert.deepEqual(argvFor("status"), ["status", "--json"]);
  assert.deepEqual(argvFor("login", { gateway: "https://dev.lvly.io" }), ["login", "--gateway", "https://dev.lvly.io"]);
  assert.deepEqual(argvFor("login", {}), ["login"]);
});

t("E2 ★ 게이트웨이 주소는 http(s) 만 — 아니면 argv 를 안 만든다", () => {
  // 여기서 안 막으면 렌더러(웹 컨텐츠) 한 방이 임의 인자 주입으로 승격된다.
  //  ⚠ 플래그처럼 생긴 값(`--token`)이 특히 위험하다 — `--gateway --token` 이 되면 다음 인자가 토큰으로 먹힌다.
  for (const bad of ["--token", "-x", "file:///etc/passwd", "javascript:alert(1)", "https://a b", "https://ok --token X", "https://ok\n--token X"]) {
    assert.throws(() => argvFor("login", { gateway: bad }), /형식/, `통과해버림: ${JSON.stringify(bad)}`);
  }
  // 빈 값·공백만 = **미입력**이다(형식 오류가 아니다) → --gateway 없이 저장된 주소를 쓴다.
  for (const empty of ["", "  ", "\t\n"]) assert.deepEqual(argvFor("login", { gateway: empty }), ["login"], JSON.stringify(empty));
});

t("E3 알 수 없는 작업은 거부한다(화이트리스트)", () => {
  assert.throws(() => argvFor("rm-rf", {}), /알 수 없는 작업/);
  for (const k of RUN_KINDS) assert.doesNotThrow(() => argvFor(k, { gateway: "https://x.io" }), k);
});

t("E4 IPC 채널 이름은 유일하다(오타·중복이 조용한 무동작을 만든다)", () => {
  const vals = Object.values(IPC);
  assert.equal(new Set(vals).size, vals.length, "중복 채널");
  assert.ok(vals.every((v) => v.startsWith("lively:")), "네임스페이스 없는 채널");
});

// ── F. 트레이 메뉴 모델 ──────────────────────────────────────────────────────
const ids = (m) => m.filter((x) => x.id).map((x) => x.id);
const find = (m, id) => m.find((x) => x.id === id);

t("F1 설치 전에는 '설치' 만 — 노드 제어를 보여주지 않는다", () => {
  const m = trayMenuModel({ cliFound: false });
  assert.ok(ids(m).includes("setup"));
  assert.ok(!ids(m).includes("node-start") && !ids(m).includes("node-stop"));
  assert.equal(find(m, "status").label, "라이블리 CLI 없음");
});

t("F2 ★ 노드가 도는 중이면 '시작' 이 아니라 '정지' 가 보인다", () => {
  const on = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true });
  assert.ok(ids(on).includes("node-stop") && !ids(on).includes("node-start"));
  const off = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: false });
  assert.ok(ids(off).includes("node-start") && !ids(off).includes("node-stop"));
});

t("F3 자동 시작 체크박스는 등록된 뒤에만 켤 수 있다", () => {
  const m = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: false });
  assert.equal(find(m, "node-autostart").enabled, false, "등록 전엔 켤 대상이 없다");
  const m2 = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeDaemon: true });
  assert.equal(find(m2, "node-autostart").enabled, true);
  assert.equal(find(m2, "node-autostart").checked, true);
});

t("F4 실행 중(busy)이면 상태를 바꾸는 항목을 전부 잠근다", () => {
  const m = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true, busy: true });
  for (const id of ["node-stop", "node-autostart"]) assert.equal(find(m, id).enabled, false, id);
  // 반대로 '창 열기'·'종료' 는 언제나 눌린다 — 잠그면 사용자가 갇힌다.
  assert.notEqual(find(m, "open").enabled, false);
  assert.notEqual(find(m, "quit").enabled, false);
});

t("F7 ★ 노드 자동시작과 앱 자동시작은 **다른 축**이다(문구·상태가 안 섞인다)", () => {
  const base = { cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true };
  const m = trayMenuModel({ ...base, nodeDaemon: true, appAutoLaunch: false });
  assert.equal(find(m, "node-autostart").checked, true, "노드 데몬은 켜짐");
  assert.equal(find(m, "app-autolaunch").checked, false, "앱 자동시작은 꺼짐 — 두 축이 섞이면 안 된다");
  assert.ok(/노드/.test(find(m, "node-autostart").label) && !/노드/.test(find(m, "app-autolaunch").label), "문구가 축을 구분해야 한다");
});

t("F8 앱 자동시작을 지원 못 하는 플랫폼(null)이면 항목 자체를 안 보여준다", () => {
  // Electron 의 로그인 항목은 Linux 미지원이다. 눌러도 아무 일 없는 체크박스를 보여주면 그건 거짓말이다.
  const m = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, appAutoLaunch: null });
  assert.equal(find(m, "app-autolaunch"), undefined);
});

t("F5 앱 종료 문구가 '노드는 계속 실행' 을 말한다(상시성의 주체는 OS 데몬)", () => {
  assert.match(find(trayMenuModel({ nodeDaemon: true, cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true }), "quit").label, /노드는 계속 실행/);
  assert.equal(find(trayMenuModel({ cliFound: false }), "quit").label, "앱 종료");
});

t("F6 상태 문구는 가장 급한 것부터(CLI→로그인→키트→노드)", () => {
  assert.equal(statusLabel({ cliFound: false, loggedIn: true, kitInstalled: true }), "라이블리 CLI 없음");
  assert.equal(statusLabel({ cliFound: true, loggedIn: false }), "로그인 필요");
  assert.equal(statusLabel({ cliFound: true, loggedIn: true, kitInstalled: false }), "키트 설치 필요");
  assert.equal(statusLabel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true, nodeDaemon: true }), "노드 실행 중 (자동 시작 켜짐)");
  assert.equal(statusLabel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true }), "노드 실행 중 (이 세션만)");
  assert.equal(statusLabel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true }), "노드 정지됨");
  assert.equal(statusLabel({ cliFound: true, loggedIn: true, kitInstalled: true }), "노드 미등록");
});

// ── G. 구조 가드 — 검증 가능성이 설계다 ─────────────────────────────────────
// Electron 을 띄우는 검증은 CI 에서 못 한다. 그래서 "Electron 의존은 main.mjs 한 파일에만" 이 곧 계약이고,
//  그게 무너지면 로직이 조용히 검증 사각지대로 흘러든다. 정적으로 못박는다.
t("G1 Electron import 는 main.mjs 에만 있다(나머지는 Electron 없이 검증된다)", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && f !== "main.mjs")
    .filter((f) => /from\s+["']electron["']|require\(["']electron["']\)/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], `Electron 의존이 샜다 — 이 파일들은 테스트에서 import 조차 못 한다: ${offenders}`);
});

t("G2 preload 의 채널 문자열이 ipc-contract 와 정확히 일치한다", () => {
  // preload 는 sandbox 라 모듈을 import 할 수 없어 문자열을 인라인한다 → 두 곳이 갈라질 수 있다.
  //  갈라지면 렌더러 버튼이 **조용히 아무 일도 안 한다**(에러도 안 난다). 그래서 여기서 맞춘다.
  const src = readFileSync(fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)), "utf8");
  const found = new Set((src.match(/"lively:[a-z-]+"/g) || []).map((s) => s.slice(1, -1)));
  for (const ch of Object.values(IPC)) assert.ok(found.has(ch), `preload 에 없는 채널: ${ch}`);
  for (const ch of found) assert.ok(Object.values(IPC).includes(ch), `contract 에 없는 채널: ${ch}`);
});

t("G3 preload 는 ipcRenderer 를 통째로 노출하지 않는다(임의 채널 호출 차단)", () => {
  const src = readFileSync(fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)), "utf8");
  const bridge = src.slice(src.indexOf("exposeInMainWorld"));
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(src), "ipcRenderer 자체를 노출했다");
  assert.ok(!/ipcRenderer\s*:/.test(bridge), "브리지에 ipcRenderer 를 실었다");
});

t("G4 창은 렌더러를 신뢰하지 않는다(contextIsolation·sandbox 켜짐 · nodeIntegration 꺼짐)", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
  assert.match(src, /contextIsolation:\s*true/);
  assert.match(src, /nodeIntegration:\s*false/);
  assert.match(src, /sandbox:\s*true/);
});

t("G5 ★ 창을 다 닫아도 앱이 죽지 않는다(트레이 상주 — 기본 동작을 덮어야 한다)", () => {
  // Electron 기본은 win/linux 에서 앱 종료다. 안 덮으면 창을 닫는 순간 노드 리모컨이 사라진다.
  const src = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
  assert.match(src, /app\.on\("window-all-closed"/);
  assert.ok(!/window-all-closed[\s\S]{0,120}app\.quit\(\)/.test(src), "window-all-closed 에서 quit 하면 트레이 상주가 아니다");
});

t("G6 트레이 아이콘 데이터가 진짜 PNG 다(1x·2x, 정사각, 알파 있음)", () => {
  // `new Tray(잘못된 이미지)` 는 던지거나 **빈 아이콘으로 조용히 뜬다** — 후자면 아무도 못 찾는다.
  //  Electron 없이 검증하려고 data URL 의 바이트를 직접 읽는다(재생성기는 desktop/tools-gen-icon.mjs).
  for (const [name, url, want] of [["1x", TRAY_ICON_1X, 22], ["2x", TRAY_ICON_2X, 44]]) {
    assert.match(url, /^data:image\/png;base64,/, name);
    const b = Buffer.from(url.split(",")[1], "base64");
    assert.equal(b.subarray(1, 4).toString("ascii"), "PNG", `${name}: PNG 시그니처 아님`);
    assert.equal(b.readUInt32BE(16), want, `${name}: 너비`);
    assert.equal(b.readUInt32BE(20), want, `${name}: 높이`);
    assert.equal(b[25], 6, `${name}: 알파 없는 컬러타입 — 메뉴바에서 검은 사각형이 된다`);
  }
});

// ── U. 자동 업데이트 정책(#1541 T6) ─────────────────────────────────────────
// 이 판단이 틀리면 증상이 **조용하다** — 개발 중에 릴리스를 두드리거나, 서명 안 된 mac 빌드가 6시간마다
//  같은 오류 팝업을 반복하거나, 꺼 뒀는데 계속 확인한다. 전부 로그를 봐야 아는 부류라 표로 못박는다.
const UOK = { packaged: true, platform: 'win32', hasPublishConfig: true, macSigned: true };

t('U1 정상 조건이면 확인한다', () => {
  assert.deepEqual(shouldCheckForUpdates(UOK), { ok: true, reason: 'ok' });
});

t('U2 개발 실행(electron .)에서는 확인하지 않는다', () => {
  // 로컬 빌드가 남의 릴리스로 덮이려 하면 개발이 통째로 이상해진다.
  assert.equal(shouldCheckForUpdates({ ...UOK, packaged: false }).ok, false);
  assert.equal(shouldCheckForUpdates({ ...UOK, packaged: false }).reason, 'dev-run');
});

t('U3 배포처 설정이 없으면 확인하지 않는다(볼 곳이 없다)', () => {
  assert.equal(shouldCheckForUpdates({ ...UOK, hasPublishConfig: false }).reason, 'no-publish-config');
});

t('U4 ★ mac 미서명은 구조적 불가 — 시도조차 하지 않는다', () => {
  // Squirrel.Mac 은 서명을 요구한다. 시도하면 매번 같은 오류가 나고 사용자는 그걸 6시간마다 본다.
  assert.equal(shouldCheckForUpdates({ ...UOK, platform: 'darwin', macSigned: false }).reason, 'mac-unsigned');
  assert.equal(shouldCheckForUpdates({ ...UOK, platform: 'darwin', macSigned: true }).ok, true);
  // 다른 OS 는 서명과 무관하다.
  assert.equal(shouldCheckForUpdates({ ...UOK, platform: 'win32', macSigned: false }).ok, true);
  assert.equal(shouldCheckForUpdates({ ...UOK, platform: 'linux', macSigned: false }).ok, true);
});

t('U5 한 번 실패하면 이 세션엔 다시 묻지 않는다', () => {
  assert.equal(shouldCheckForUpdates({ ...UOK, failedBefore: true }).reason, 'failed-before');
});

t('U6 opt-out 은 무엇보다 먼저 이긴다 · 0 은 opt-out 이 아니다', () => {
  assert.equal(shouldCheckForUpdates({ ...UOK, optOut: '1' }).reason, 'opt-out');
  assert.equal(shouldCheckForUpdates({ ...UOK, optOut: 'yes' }).reason, 'opt-out');
  assert.equal(shouldCheckForUpdates({ ...UOK, optOut: '0' }).ok, true, '0 을 opt-out 으로 읽으면 끌 수가 없다');
  assert.equal(shouldCheckForUpdates({ ...UOK, optOut: '' }).ok, true);
  assert.equal(UPDATE_OPT_OUT_ENV, 'LIVELY_DESKTOP_NO_UPDATE');
});

t('U7 실패 문구는 원인별로 다르고, 앱을 못 쓰게 됐다고 말하지 않는다', () => {
  assert.match(updateFailureNote(new Error('Could not get code signature')), /서명되지 않/);
  assert.match(updateFailureNote(new Error('getaddrinfo ENOTFOUND github.com')), /네트워크/);
  for (const e of [new Error('Could not get code signature'), new Error('ENOTFOUND')]) {
    assert.ok(!/설치|재설치|중단/.test(updateFailureNote(e)), '자동 업데이트 실패는 치명이 아니다');
  }
  assert.ok(UPDATE_INTERVAL_MS >= 60 * 60 * 1000, '너무 잦으면 레이트리밋에 걸린다');
});

t('U8 빌드 설정 — 배포처·아이콘·무인 설치 계약', () => {
  // electron-builder 설정이 빠지면 **빌드는 성공하는데** 자동 업데이트가 조용히 죽는다(볼 곳이 없어서).
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(pkg.build.publish?.[0]?.provider, 'github', '배포처가 없으면 electron-updater 는 어디도 안 본다');
  assert.ok(pkg.dependencies?.['electron-updater'], 'electron-updater 는 런타임 의존성이어야 한다(devDep 이면 번들에서 빠진다)');
  assert.equal(pkg.build.icon, 'build/icon.png');
  assert.ok(pkg.scripts.dist.includes('icon'), '아이콘 생성 없이 빌드하면 기본 Electron 아이콘이 나간다');
  assert.equal(pkg.build.mac.hardenedRuntime, true, '공증(notarization)의 전제');
});

t('U9 ★ 설치기 없는 빌드(app-update.yml 부재)는 확인하지 않는다 — 실기기가 잡은 결함', () => {
  // Windows 실기기 실측: `--dir` 빌드에서 electron-updater 가 'Checking for update' 후
  //  ENOENT app-update.yml 로 죽었다. 그 파일이 곧 '이 빌드에 배포처가 박혔다'의 증거다.
  //  상수 true 로 두면 포터블·개발 빌드가 매번 같은 오류를 낸다.
  assert.equal(shouldCheckForUpdates({ ...UOK, hasPublishConfig: false }).ok, false);
  assert.equal(shouldCheckForUpdates({ ...UOK, hasPublishConfig: false }).reason, 'no-publish-config');
  // 배선 확인 — main.mjs 가 상수가 아니라 **파일 존재**로 판정하는가.
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  const line = main.split('\n').find((l) => l.includes('hasPublishConfig:'));
  assert.ok(line && /existsSync/.test(line), `상수로 되돌아갔다: ${line}`);
  assert.ok(line.includes('app-update.yml'), line);
});

// ── U10~U12. 받은 업데이트의 **적용** — 앱이 스스로 닫고·설치하고·다시 뜬다 (#1541) ──────────────
// 실측(2026-08-18, 사용자 Windows 0.1.320→0.1.324): "두 번 재시작해야 했고, 바로가기가 사라졌다고 나왔고,
//  트레이에서 껐다 켜는 게 불편하다." 셋 다 한 원인 — 종전 안내("앱을 다시 켜면 적용")는 사람과 설치기를
//  경쟁시켰다: 설치기(--updated)는 떠 있는 앱을 묻지 않고 죽이고(app-builder-lib CHECK_APP_RUNNING), 조용한
//  설치(/S)는 --force-run 없이는 앱을 다시 띄우지 않는다. 그래서 적용은 앱이 quitAndInstall(true,true) 로 한다.
t('U10 자동 적용 판정 — 엣지 표(창이 안 보일 때만 · 작업 중/질문 대기 중 금지 · 받은 게 없으면 금지)', () => {
  const R = { ready: true, busy: false, windowVisible: false, promptsPending: 0 };
  assert.equal(shouldAutoApplyUpdate(R), true, '트레이 상주(창 안 보임)·한가함 → 자동 적용');
  assert.equal(shouldAutoApplyUpdate({ ...R, windowVisible: true }), false, '창을 보고 있으면 자동으로 사라지면 안 된다(버튼으로)');
  assert.equal(shouldAutoApplyUpdate({ ...R, busy: true }), false, 'CLI 작업 중엔 재시작하면 작업이 끊긴다');
  assert.equal(shouldAutoApplyUpdate({ ...R, promptsPending: 1 }), false, '사람의 답을 기다리는 질문이 있으면 금지');
  assert.equal(shouldAutoApplyUpdate({ ...R, ready: false }), false, '받아 둔 게 없으면 적용할 게 없다');
  // 새 헬퍼의 빈 입력 — undefined/빈 객체는 "하지 않는다"(안전측)
  assert.equal(shouldAutoApplyUpdate(undefined), false);
  assert.equal(shouldAutoApplyUpdate({}), false);
  // 경계: promptsPending 0 은 허용, 1 부터 금지 · 지연은 '방금 닫은 창을 곧 다시 여는' 경우를 흡수할 만큼
  assert.equal(shouldAutoApplyUpdate({ ...R, promptsPending: 0 }), true);
  assert.ok(AUTO_APPLY_DELAY_MS >= 3000 && AUTO_APPLY_DELAY_MS <= 30_000, `지연이 비상식적: ${AUTO_APPLY_DELAY_MS}`);
  // 문구: 종전의 함정 문구("다시 켜면")를 다시 쓰지 않는다 — 사람이 켜는 순간 설치기와 경쟁한다.
  assert.match(updateReadyNote('0.1.325'), /0\.1\.325/);
  assert.ok(!/다시 켜면/.test(updateReadyNote('0.1.325')), '사람에게 직접 켜라고 하면 종전 경쟁이 재현된다');
  assert.match(updateReadyNote(''), /준비됨/);
});

t('U11 트레이 — 받아 둔 업데이트가 있으면 적용 항목이 **가장 위**에, 작업 중엔 잠긴다', () => {
  const base = { cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true };
  const none = trayMenuModel(base);
  assert.ok(!none.some((m) => m.id === 'apply-update'), '받은 게 없으면 항목이 없어야 한다');
  const m = trayMenuModel({ ...base, updateReady: '0.1.325' });
  const i = m.findIndex((x) => x.id === 'apply-update');
  assert.ok(i >= 0, '적용 항목이 없다 — 트레이만 보는 사람에겐 유일한 입구다');
  assert.ok(i < m.findIndex((x) => x.id === 'node-stop' || x.id === 'node-start'), '노드 항목보다 위여야 눈에 띈다');
  assert.match(m[i].label, /0\.1\.325/, '어느 버전인지 적는다');
  assert.notEqual(m[i].enabled, false);
  assert.equal(trayMenuModel({ ...base, updateReady: '0.1.325', busy: true })[i].enabled, false, '작업 중엔 잠근다');
});

t('U12 ★ 배선 — 적용은 quitAndInstall(조용히+다시 띄우기)이고, "종료하면 설치" OS 알림은 쓰지 않는다', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  // isSilent=true, isForceRunAfter=true — 둘 중 하나라도 빠지면 종전 경쟁이 그대로다(설치기가 앱을 안 띄우거나 UI 를 띄운다).
  assert.match(main, /quitAndInstall\(\s*true\s*,\s*true\s*\)/, 'quitAndInstall(true, true) 가 아니다');
  // checkForUpdatesAndNotify 는 "종료하면 설치됩니다" 알림을 띄워 사람을 종전 함정으로 부른다.
  const code = main.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');   // 주석 제외 — 코드만 본다
  assert.ok(!/checkForUpdatesAndNotify/.test(code), 'checkForUpdatesAndNotify 를 다시 쓰고 있다');
  // 리스너는 한 번만 — 확인할 때마다 on() 을 걸면 누적돼 같은 문구가 n 번 찍힌다.
  const onCount = (main.match(/autoUpdater\.on\("update-downloaded"/g) || []).length;
  assert.equal(onCount, 1, `update-downloaded 리스너 등록이 ${onCount}곳`);
  assert.ok(/updater\s*=\s*autoUpdater/.test(main) && /if \(updater\) return updater/.test(main), '업데이터 인스턴스를 재사용하지 않는다');
  // 창 숨김 → 자동 적용 예약 · 창 표시 → 취소 (사람이 보고 있으면 사라지지 않는다)
  assert.match(main, /win\.on\("hide",\s*\(\)\s*=>\s*scheduleAutoApply\(\)\)/, '창을 숨길 때 자동 적용을 예약하지 않는다');
  assert.match(main, /win\.on\("show"/, '창을 다시 열 때 예약을 취소하지 않는다');
  // IPC·preload·렌더러가 같은 채널을 본다
  assert.equal(IPC.APPLY_UPDATE, 'lively:apply-update');
  assert.match(main, /ipcMain\.handle\(IPC\.APPLY_UPDATE/, '메인에 APPLY_UPDATE 핸들러가 없다');
  const preload = readFileSync(fileURLToPath(new URL('../preload/preload.cjs', import.meta.url)), 'utf8');
  assert.match(preload, /applyUpdate:/, 'preload 가 applyUpdate 를 노출하지 않는다');
  const html = readFileSync(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), 'utf8');
  const js = readFileSync(fileURLToPath(new URL('../renderer/app.js', import.meta.url)), 'utf8');
  assert.match(html, /id="apply-update"/, '렌더러에 적용 버튼이 없다');
  assert.match(js, /window\.lively\.applyUpdate\(\)/, '버튼이 applyUpdate 를 부르지 않는다');
  assert.match(js, /updateReady/, '렌더러가 updateReady 로 버튼을 보이지 않는다');
});

t('U13 받는 동안의 문구 — 확인이 끝난 뒤 침묵하지 않는다(진행률·양·속도)', () => {
  // 실측: 확인은 1초 만에 끝났고 3분 넘게 100MB 를 받는 중이었는데 화면은 "업데이트를 확인합니다." 그대로였다.
  const n = downloadProgressNote('0.1.326', { percent: 42.7, transferred: 41.9 * 1048576, total: 99.9 * 1048576, bytesPerSecond: 1.2 * 1048576 });
  assert.match(n, /0\.1\.326/); assert.match(n, /42%/); assert.match(n, /41\.9\/99\.9MB/); assert.match(n, /1\.2MB\/s/);
  // 새 헬퍼의 빈 입력 — 필드가 없어도(초기 이벤트) 크래시 없이 '받는 중' 만
  assert.match(downloadProgressNote('0.1.326', undefined), /받는 중/);
  assert.match(downloadProgressNote('', {}), /받는 중/);
  // 경계: percent 는 0~100 으로 자르고 정수로, total 0 이면 양을 적지 않는다
  assert.match(downloadProgressNote('v', { percent: 100.4 }), /100%/);
  assert.match(downloadProgressNote('v', { percent: -3 }), /0%/);
  assert.ok(!/MB\b.*\//.test(downloadProgressNote('v', { percent: 5, transferred: 10, total: 0 })), '총량 0 인데 양을 적었다');
  // 확인 단계의 문구는 '확인 중' 이어야 한다 — 종전 "확인합니다" 는 결과처럼 읽혀 사람이 3분을 기다렸다
  assert.match(updateStatusNote('ok'), /확인 중/);
  assert.ok(!/확인합니다\./.test(updateStatusNote('ok')));
  assert.ok(PROGRESS_NOTE_MIN_MS >= 200 && PROGRESS_NOTE_MIN_MS <= 2000, '스로틀이 비상식적');
  // 배선: 메인이 download-progress·update-available·checking-for-update 를 다 듣고, 렌더러는 IPC 응답으로 문구를 덮지 않는다
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  for (const ev of ['checking-for-update', 'update-available', 'download-progress']) assert.match(main, new RegExp(`autoUpdater\\.on\\("${ev}"`), `${ev} 리스너가 없다`);
  assert.match(main, /PROGRESS_NOTE_MIN_MS/, '진행률 스로틀이 없다(초당 수십 번 다시 그린다)');
  const js = readFileSync(fileURLToPath(new URL('../renderer/app.js', import.meta.url)), 'utf8');
  const seg = js.slice(js.indexOf('$("check-update").addEventListener'), js.indexOf('// ── 로그 두 축'));
  assert.ok(!/upd-note"\)\.textContent = r\.note/.test(seg), '렌더러가 IPC 응답 문구로 진행률 문구를 덮는다');
});

// ── S. Windows: 다른 자리에 남은 옛 설치본 (#1541 · win-stale-install.mjs) ────────────────────
// 실측: "라이블리 바로가기로 열면 0.1.325 를 설치한 뒤에도 0.1.320 이 열린다" — 0.1.320 은 '모든 사용자'(Program Files/HKLM),
//  그 뒤 업데이트는 사용자 자리(HKCU). 사용자 설치기는 HKLM 옛 설치본을 못 지운다 → 옛 바로가기가 옛 exe 를 연다.
{
  const ownExe = "C:\\Users\\a\\AppData\\Local\\Programs\\Lively\\Lively.exe";
  // ⚠ DisplayName 은 electron-builder 기본값 `${productName} ${version}` 이다("Lively 0.1.320") — v0.1.326 은 `-eq 'Lively'` 로 걸어
  //  **전부 놓쳤다**(실측: 카드가 안 떴다). 픽스처는 실제 값으로 둔다. 미끼("Lively Wallpaper" — 실재하는 남의 제품)도 넣는다.
  const rows = [
    { key: APP_GUID, hive: "HKLM", name: "Lively 0.1.320", version: "0.1.320", location: "C:\\Program Files\\Lively", uninstall: '"C:\\Program Files\\Lively\\Uninstall Lively.exe" /allusers', quiet: "" },
    { key: APP_GUID, hive: "HKCU", name: "Lively 0.1.326", version: "0.1.326", location: "C:\\Users\\a\\AppData\\Local\\Programs\\Lively", uninstall: '"C:\\Users\\a\\AppData\\Local\\Programs\\Lively\\Uninstall Lively.exe" /currentuser', quiet: "" },
    { key: "{9c1b-other}", hive: "HKLM", name: "Lively Wallpaper 2.0", version: "2.0", location: "C:\\Program Files\\Lively Wallpaper", uninstall: '"C:\\Program Files\\Lively Wallpaper\\Uninstall Lively Wallpaper.exe"', quiet: "" },
  ];
  t('S1 감지 — 우리 자리(HKCU)는 빼고 다른 자리(HKLM 옛 설치본)만 잡는다', () => {
    const st = pickStaleInstalls(parseStaleQuery("\uFEFF" + JSON.stringify(rows)), ownExe);
    assert.equal(st.length, 1); assert.equal(st[0].version, "0.1.320");
    assert.equal(st[0].uninstaller, "C:\\Program Files\\Lively\\Uninstall Lively.exe");
    assert.deepEqual(st[0].uninstallArgs, ["/allusers"], '등록된 모드 토큰(/allusers)을 그대로 넘겨야 같은 컨텍스트로 지운다');
    // 우리 자리만 있으면 아무것도 없다(정상 상태에서 카드가 뜨면 안 된다) — 대소문자·구분자 차이도 같은 자리
    assert.deepEqual(pickStaleInstalls(parseStaleQuery(JSON.stringify([rows[1]])), ownExe), []);
    assert.deepEqual(pickStaleInstalls(parseStaleQuery(JSON.stringify([{ ...rows[1], location: "c:/users/a/appdata/local/programs/lively/" }])), ownExe), []);
    // 단일 객체 출력(ConvertTo-Json 이 원소 하나면 배열을 안 만든다)·빈 출력·쓰레기 출력
    assert.equal(pickStaleInstalls(parseStaleQuery(JSON.stringify(rows[0])), ownExe).length, 1);
    assert.deepEqual(parseStaleQuery(""), []); assert.deepEqual(parseStaleQuery("not json"), []); assert.deepEqual(parseStaleQuery(undefined), []);
    // ★ 우리 제품 판정은 GUID 키(정본) 또는 언인스톨러 파일명 — 이름만 비슷한 남의 제품(Lively Wallpaper)은 제외
    assert.ok(!st.some((e) => /Wallpaper/.test(e.location)), '남의 제품(Lively Wallpaper)을 옛 설치본으로 잡았다 — 지우면 사고다');
    // 키가 없어도(구버전 레코드) 언인스톨러 파일명이 우리 것이면 잡는다
    assert.equal(pickStaleInstalls(parseStaleQuery(JSON.stringify([{ ...rows[0], key: "" }])), ownExe).length, 1);
    // 키도 파일명도 다르면 이름이 'Lively 0.1.1' 이어도 제외
    assert.deepEqual(pickStaleInstalls(parseStaleQuery(JSON.stringify([{ ...rows[0], key: "x", uninstall: '"C:\\z\\Remove.exe"' }])), ownExe), []);
    // ★ GUID 는 electron-builder 가 실제로 쓰는 값과 같아야 한다 — 그 라이브러리(builder-util-runtime)로 직접 대조한다
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.equal(APP_ID, pkg.build.appId, 'APP_ID 가 package.json build.appId 와 다르다 — GUID 가 다른 앱을 가리킨다');
    // ★ 고정값 = **실기기 레지스트리에서 확인한 실제 키**(hammurabi HKLM, 2026-08-18). 종전엔 NS 끝자리를 틀리게
    //  옮겨 적은 값(…360a5f6d0d1a)으로 계산해 GUID 가 통째로 달랐고, 그 틀린 값끼리 맞춰 본 대조는 초록불이었다.
    //  이제 NS 는 app-builder-lib NsisTarget.js 소스에서 **직접 읽어** 대조한다(있을 때만 — 루트 잡은 desktop 의존성 없음).
    assert.equal(uuidV5("io.lvly.desktop", "50e065bc-3134-11e6-9bab-38c9862bdaf3"), "c70fc652-f177-5d81-a865-695715b3f6c0");
    assert.equal(APP_GUID, "c70fc652-f177-5d81-a865-695715b3f6c0", 'GUID 가 실기기 레지스트리 키와 다르다');
    try {
      const nsisSrc = readFileSync(fileURLToPath(new URL('../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js', import.meta.url)), 'utf8');
      const ns = /ELECTRON_BUILDER_NS_UUID = [^"]*"([0-9a-f-]{36})"/.exec(nsisSrc);
      assert.ok(ns, 'NsisTarget.js 에서 NS 상수를 못 찾았다(구조 변경 — 파싱을 고칠 것)');
      assert.equal(uuidV5(pkg.build.appId, ns[1]), APP_GUID, 'app-builder-lib 의 NS 로 계산한 GUID 가 우리 상수와 다르다');
      const { UUID } = createRequire(import.meta.url)("builder-util-runtime");
      assert.equal(APP_GUID, UUID.v5(pkg.build.appId, UUID.parse(ns[1])), 'GUID 가 electron-builder 계산과 다르다');
    } catch (e) { if (!/Cannot find module|ENOENT/.test(String(e?.message))) throw e; }
    assert.ok(!pkg.build.nsis.guid, 'nsis.guid 를 박으면 여기 계산과 갈린다 — 박을 거면 APP_GUID 도 그 값으로');
    assert.equal(UNINSTALLER_NAME, `Uninstall ${pkg.build.productName}.exe`);
    // 쿼리는 GUID 키로도 잡는다(이름은 보조) — DisplayName -eq 'Lively' 는 다시는 안 된다
    assert.ok(STALE_QUERY_PS.includes(`PSChildName -eq '${APP_GUID}'`), '쿼리가 GUID 키를 안 본다');
    assert.ok(!/DisplayName -eq 'Lively'/.test(STALE_QUERY_PS), "DisplayName -eq 'Lively' 는 제품명+버전 형식을 전부 놓친다(v0.1.326 실측)");
    // 지울 수단이 없는 항목은 감지해도 목록에 안 넣는다(버튼을 줘도 할 게 없다)
    assert.deepEqual(pickStaleInstalls(parseStaleQuery(JSON.stringify([{ ...rows[0], uninstall: "", quiet: "" }])), ownExe), []);
    // 파서 보조
    assert.equal(uninstallerPath('"C:\\P F\\U.exe" /S'), "C:\\P F\\U.exe"); assert.equal(uninstallerPath("C:\\x\\u.exe /a"), "C:\\x\\u.exe");
    assert.deepEqual(uninstallerArgs('"C:\\P F\\U.exe"'), []);
  });
  t('S2 ★ 정리 스크립트 — 권한상승·조용히·모드 토큰 유지·끝나면 우리를 다시 띄운다 (옛 언인스톨러가 우리를 죽이므로)', () => {
    const st = pickStaleInstalls(parseStaleQuery(JSON.stringify(rows)), ownExe);
    const ps = staleCleanupPs({ stale: st, ownExe });
    assert.match(ps, /Start-Process -Verb RunAs -Wait -FilePath 'C:\\Program Files\\Lively\\Uninstall Lively\.exe' -ArgumentList @\('\/S','\/allusers'\)/);
    assert.ok(ps.indexOf("Uninstall Lively.exe") < ps.indexOf("Start-Process -FilePath 'C:\\Users\\a"), '언인스톨 뒤에 우리를 띄워야 한다');
    assert.match(ps, /try \{[^}]*RunAs[^}]*\} catch/, 'UAC 거절(예외)해도 스크립트가 끝까지 가서 앱을 다시 띄워야 한다');
    // 인용부호 안전 — 값의 따옴표는 두 배로(레지스트리 값이 스크립트를 깨지 못한다)
    assert.equal(psQuote("it's"), "'it''s'");
    assert.match(staleCleanupPs({ stale: [{ uninstaller: "C:\\o'k\\u.exe" }], ownExe: "C:\\a.exe" }), /'C:\\o''k\\u\.exe'/);
    // 빈 목록이면 언인스톨 줄 없이 재실행만(호출자가 막지만 크래시는 없어야 한다)
    assert.ok(!/RunAs/.test(staleCleanupPs({ stale: [], ownExe: "C:\\a.exe" })));
    // 문구
    assert.match(staleInstallNote(st), /0\.1\.320/); assert.equal(staleInstallNote([]), "");
    // 쿼리 상수: 네 자리(HKLM 네이티브·WOW6432Node·HKCU)를 다 보고, 보간이 없다(인젝션 표면 없음)
    assert.match(STALE_QUERY_PS, /HKLM:\\SOFTWARE\\Microsoft/); assert.match(STALE_QUERY_PS, /WOW6432Node/); assert.match(STALE_QUERY_PS, /HKCU:/);
    assert.ok(!/\$\{/.test(STALE_QUERY_PS), '쿼리에 JS 보간 흔적이 있다(GUID 는 이미 치환된 hex 상수여야 한다)');
    assert.match(STALE_QUERY_PS, /ConvertTo-Json/);
  });
  t('S3 배선 — 시작 때 감지·카드·트레이 항목·IPC·preload, 정리는 사람이 누를 때만', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
    assert.match(main, /detectStaleInstall\(\{ force: true \}\)/, '시작 때 감지하지 않는다');
    assert.match(main, /platform !== "win32" \|\| !app\.isPackaged\) return/, 'Windows 패키지 앱에서만 감지해야 한다');
    assert.match(main, /-EncodedCommand/, '정리 스크립트를 EncodedCommand 로 넘기지 않는다(인용부호가 argv 에 실린다)');
    // ★ 정리 런처는 **보이는 콘솔**이어야 한다 — 숨김 프로세스의 승격 요청은 작업 표시줄에 최소화돼 사람이 못 본다
    //  (실기기: UAC 를 5분 뒤에야 발견). cleanupStaleInstall 구간만 본다(감지 execFile 의 windowsHide 는 별개).
    const cl = main.slice(main.indexOf('async function cleanupStaleInstall'), main.indexOf('async function cleanupStaleInstall') + 2200);
    assert.ok(!/WindowStyle",\s*"Hidden"/.test(cl), '정리 런처가 -WindowStyle Hidden 이다 — UAC 가 작업 표시줄에 숨는다');
    assert.ok(!/windowsHide:\s*true/.test(cl) && !/detached:\s*true/.test(cl), '정리 런처가 숨김/분리다 — UAC 가 작업 표시줄에 숨는다');
    assert.match(staleCleanupPs({ stale: [], ownExe: "C:\\a.exe" }), /방패 아이콘/, '콘솔 안내 문구가 없다');
    assert.match(main, /shell\.writeShortcutLink/, '바탕화면 바로가기를 이 버전으로 잇지 않는다');
    assert.match(main, /setLoginItemSettings\(\{ openAtLogin: true/, '로그인 자동 시작을 이 버전으로 잇지 않는다');
    assert.ok(!/void cleanupStaleInstall\(\)/.test(main), '정리를 자동으로 돌리면 UAC 창이 느닷없이 뜬다 — 사람이 눌러야 한다');
    assert.match(main, /ipcMain\.handle\(IPC\.CLEANUP_STALE/);
    assert.equal(IPC.CLEANUP_STALE, 'lively:cleanup-stale');
    const preload = readFileSync(fileURLToPath(new URL('../preload/preload.cjs', import.meta.url)), 'utf8');
    assert.match(preload, /cleanupStale:/);
    const html = readFileSync(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), 'utf8');
    assert.match(html, /id="stale-card"/); assert.match(html, /id="stale-clean"/);
    const js = readFileSync(fileURLToPath(new URL('../renderer/app.js', import.meta.url)), 'utf8');
    assert.match(js, /window\.lively\.cleanupStale\(\)/); assert.match(js, /staleInstall/);
    const m = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true, staleVersions: "0.1.320" });
    const i = m.findIndex((x) => x.id === 'cleanup-stale');
    assert.ok(i >= 0, '트레이에 정리 항목이 없다'); assert.match(m[i].label, /0\.1\.320/);
    assert.ok(!trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true }).some((x) => x.id === 'cleanup-stale'), '옛 설치본이 없으면 항목이 없어야 한다');
    // 새 설치는 바탕화면 바로가기를 만든다(사용자는 바로가기로 앱을 연다 — 실측). 업데이트 땐 keep 메커니즘이라 늘지 않는다.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.notEqual(pkg.build.nsis.createDesktopShortcut, false, 'createDesktopShortcut:false 면 옛 바로가기를 지운 뒤 아무 바로가기도 없다');
  });
}

// ── N. 노드 '붙어 있는가' 축 — 프로세스는 도는데 게이트웨이엔 안 붙은 좀비를 '실행 중' 이라 그리지 않는다 (#1541) ──
t('N1 트레이 — running 인데 connected=false 면 "연결 끊김" + 다시 시작 항목, 모름(null)이면 종전대로 실행 중', () => {
  const base = { cliFound: true, loggedIn: true, kitInstalled: true, nodeRegistered: true, nodeRunning: true, nodeDaemon: true };
  assert.match(statusLabel({ ...base, nodeConnected: false }), /연결 끊김/);
  assert.match(statusLabel({ ...base, nodeConnected: true }), /실행 중/);
  assert.match(statusLabel({ ...base, nodeConnected: null }), /실행 중/, '모름은 종전대로 — 게이트웨이에 못 물었다고 끊김이라 하면 거짓말');
  assert.match(statusLabel({ ...base }), /실행 중/, '축이 아예 없어도(구 CLI) 종전대로');
  const z = trayMenuModel({ ...base, nodeConnected: false });
  const i = z.findIndex((m) => m.id === 'node-start');
  assert.ok(i >= 0 && /다시 시작/.test(z[i].label), '좀비면 다시 시작 항목이 있어야 한다');
  assert.ok(z.some((m) => m.id === 'node-stop'), '정지도 남긴다');
  assert.ok(!trayMenuModel({ ...base, nodeConnected: true }).some((m) => m.id === 'node-start'), '정상 실행 중엔 시작 항목이 없다');
  // 배선: 메인이 status 의 connected 를 상태로 옮기고(boolean 만), 렌더러가 그걸로 문구·버튼을 바꾼다
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  assert.match(main, /nodeConnected: typeof n\.connected === "boolean" \? n\.connected : null/, 'connected 를 boolean 일 때만 옮기지 않는다');
  const js = readFileSync(fileURLToPath(new URL('../renderer/app.js', import.meta.url)), 'utf8');
  assert.match(js, /nodeConnected === false/, '렌더러가 좀비를 구분하지 않는다');
  assert.match(js, /연결돼 있지 않습니다/, '렌더러 문구가 없다');
  assert.match(js, /"노드 다시 시작"/, '좀비면 버튼이 다시 시작이어야 한다');
});

t('U14 업데이트 적용 재시작 후 창 복원 — 창에서 눌렀을 때만 마커, 시작 때 마커 소비 후 창 (#1541 실측: 트레이에만 떠 손으로 열었다)', () => {
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  // applyUpdate: 창이 보일 때만 마커 — 자동 적용(창 숨김)이 마커를 남기면 안 보는 사람 앞에 창이 튀어나온다
  const ap = main.slice(main.indexOf('async function applyUpdate'), main.indexOf('async function applyUpdate') + 1600);
  const mk = ap.indexOf('desktop-reopen');
  assert.ok(mk >= 0, 'applyUpdate 가 재열기 마커를 안 남긴다');
  assert.match(ap.slice(Math.max(0, mk - 200), mk), /win\.isVisible\(\)/, '창 표시 여부 확인 없이 마커를 남긴다');
  assert.ok(ap.indexOf('desktop-reopen') < ap.indexOf('quitAndInstall'), '마커는 quitAndInstall 전에 남겨야 한다(후엔 프로세스가 죽는다)');
  // 시작: 마커가 있으면 지우고 창을 연다(지우지 않으면 다음 시작마다 창이 뜬다)
  const boot = main.slice(main.indexOf('app.whenReady'), main.indexOf('app.whenReady') + 2000);
  const bm = boot.indexOf('desktop-reopen');
  assert.ok(bm >= 0, '시작 경로가 마커를 확인하지 않는다');
  const after = boot.slice(bm, bm + 200);
  assert.match(after, /rmSync/, '마커를 지우지 않는다 — 다음 시작마다 창이 뜬다');
  assert.match(after, /showWindow\(\)/, '마커를 보고도 창을 안 연다');
});

t('D6 ★ 답한 프롬프트는 다시 뜨지 않는다(리듀서가 옛 prompt 를 물고 있으면 안 된다)', () => {
  // 실측(맥 풀 플로우): '예' 를 누르고 나서도 다음 step 이벤트마다 확인 카드가 되살아나 세 번 눌러야 했다.
  //  리듀서는 prompt 를 end 까지 들고 있으므로, **답한 순간** 메인이 그 자리를 비워 줘야 한다.
  let s2 = reduceProgress(undefined, { t: 'prompt', id: 'confirm-1', kind: 'confirm', label: '계속?' });
  assert.ok(s2.prompt, '프롬프트가 상태에 들어와야 화면이 그린다');
  s2 = { ...s2, prompt: null };                       // 메인이 답 직후 하는 일
  s2 = reduceProgress(s2, { t: 'step', id: 'kit', label: '설치 중', status: 'start' });
  assert.equal(s2.prompt, null, '답한 뒤 step 이 오면 카드가 되살아난다');
  // 배선 확인 — 메인의 ANSWER 핸들러가 실제로 그렇게 하는가.
  const main = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
  const seg = main.slice(main.indexOf('IPC.ANSWER'), main.indexOf('IPC.SET_GATEWAY'));
  assert.ok(/prompt:\s*null/.test(seg), '답 처리에서 progress.prompt 를 비우지 않는다');
  assert.ok(/send\(IPC\.PROGRESS/.test(seg), '비운 상태를 렌더러에 안 보내면 화면은 그대로다');
});

// ── J. 어떻게 띄우나 — Windows `.cmd` 는 그대로 spawn 하면 EINVAL (#1541 실기기) ──
// 실측: Windows 심은 `lively.cmd` 배치인데 Node 는 CVE-2024-27980 이후 shell 없는 배치 실행을 거부한다.
//  → 앱이 CLI 를 **한 번도** 못 불렀다(`spawn EINVAL` 반복). 스텁 spawn 단위테스트도, mac 실동작 검증도 못 본다.
{
  const WIN = "C:\\Users\\yoon";
  const LV = WIN + "\\.lively";
  const has = (...ps) => (p) => ps.includes(p);
  const rd = (map) => (d) => map[d] || [];

  t("J1 ★ Windows — 번들 런타임의 node.exe 로 lively.mjs 를 직접 띄운다(셸 미경유)", () => {
    const spec = cliLaunchSpec({
      platform: "win32", cliPath: LV + "\\bin\\lively.cmd", livelyDir: LV, args: ["node", "--daemon"],
      exists: has(LV + "\\lib\\lively.mjs", LV + "\\runtime\\node-v22.11.0-win-x64\\node.exe"),
      readdir: rd({ [LV + "\\runtime"]: ["node-v22.11.0-win-x64"] }),
    });
    assert.equal(spec.cmd, LV + "\\runtime\\node-v22.11.0-win-x64\\node.exe");
    assert.deepEqual(spec.args, [LV + "\\lib\\lively.mjs", "node", "--daemon"]);
    assert.equal(spec.shell, false, "셸을 거치면 값이 cmd.exe 파서에 들어간다");
    assert.equal(spec.via, "runtime");
  });

  t("J2 런타임이 여럿이면 **최신**을 고른다(심의 `dir /o-n` 과 같은 규칙이라 둘이 안 갈린다)", () => {
    const spec = cliLaunchSpec({
      platform: "win32", cliPath: LV + "\\bin\\lively.cmd", livelyDir: LV, args: [],
      exists: () => true,
      readdir: rd({ [LV + "\\runtime"]: ["node-v20.1.0-win-x64", "node-v22.11.0-win-x64", "other"] }),
    });
    assert.match(spec.cmd, /node-v22\.11\.0-win-x64/);
  });

  t("J3 번들 런타임이 없으면 심 + shell 로 폴백한다(그래야 EINVAL 을 안 맞는다)", () => {
    const spec = cliLaunchSpec({
      platform: "win32", cliPath: LV + "\\bin\\lively.cmd", livelyDir: LV, args: ["status", "--json"],
      exists: has(LV + "\\lib\\lively.mjs"), readdir: rd({}),
    });
    assert.equal(spec.cmd, LV + "\\bin\\lively.cmd");
    assert.equal(spec.shell, true);
    assert.deepEqual(spec.args, ["status", "--json"]);
  });

  t("J4 POSIX 는 종전 그대로 — 심이 셰방 스크립트라 셸이 필요 없다", () => {
    const spec = cliLaunchSpec({
      platform: "darwin", cliPath: "/Users/yoon/.lively/bin/lively", livelyDir: "/Users/yoon/.lively",
      args: ["setup"], exists: () => true, readdir: rd({}),
    });
    assert.deepEqual(spec, { cmd: "/Users/yoon/.lively/bin/lively", args: ["setup"], shell: false, via: "shim" });
  });

  t("J5 readdir 이 throw 해도 죽지 않고 폴백한다(권한 없는 폴더 등)", () => {
    const spec = cliLaunchSpec({
      platform: "win32", cliPath: LV + "\\bin\\lively.cmd", livelyDir: LV, args: [],
      exists: () => true, readdir: () => { throw new Error("EACCES"); },
    });
    assert.equal(spec.shell, true);
  });

  await ta("J6 ★ runCli 는 launch 스펙을 그대로 쓴다 — 찾은 경로를 다시 spawn 하지 않는다", async () => {
    const s = stubSpawn((c) => { c.stdout.emit("data", ev({ v: 1, t: "end", ok: true })); c.emit("close", 0, null); });
    await runCli({ cli: "IGNORED.cmd", launch: { cmd: "C:\\node.exe", args: ["C:\\lively.mjs", "status"], shell: false }, spawn: s.spawn });
    assert.equal(s.calls[0].cli, "C:\\node.exe", "launch.cmd 가 아니라 cli 를 띄웠다");
    assert.deepEqual(s.calls[0].args, ["C:\\lively.mjs", "status", "--json-events"]);
    assert.equal(s.calls[0].opts.shell, false);
  });

  t("J7 못 띄운 CLI 는 '멀쩡함' 이 아니다 — 화면이 그 사실을 말해야 한다", () => {
    const st = { cliFound: true, cliBroken: "CLI 를 실행하지 못했습니다: spawn EINVAL", loggedIn: true, kitInstalled: true };
    assert.match(statusLabel(st), /실행할 수 없음/);
    const setup = trayMenuModel(st).find((m) => m.id === "setup");
    assert.ok(setup, "다시 설치로 이끄는 항목이 없다 — 사용자는 빠져나갈 길이 없다");
    assert.match(setup.label, /다시 설치/);
  });
}

// ── J8. ★ **진짜로 띄워 본다** — 이 층이 없어서 EINVAL 이 실기기까지 나갔다 ─────────
// 위 J1~J7 은 전부 스텁이라 '계획' 만 본다. `.cmd` 를 Node 가 거부하는지는 **실제로 spawn 해야** 안다.
//  그래서 여기서 심을 진짜로 만들고 진짜로 돌린다. Windows CI 에서 이 파일이 도는 게 이 케이스의 존재 이유다.
await ta("J8 ★ 설치된 모양 그대로의 심을 실제로 실행한다(Windows 면 .cmd — EINVAL 이 나면 안 된다)", async () => {
  const { mkdtempSync, mkdirSync: mkd, writeFileSync: wf, chmodSync: chm } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const box = mkdtempSync(join(tmpdir(), "lively-launch-"));
  const lv = join(box, ".lively");
  mkd(join(lv, "bin"), { recursive: true });
  mkd(join(lv, "lib"), { recursive: true });
  // 진짜 CLI 처럼 계약대로 한 줄 뱉는 최소 구현.
  wf(join(lv, "lib", "lively.mjs"), 'process.stdout.write(JSON.stringify({v:1,t:"end",ok:true,code:0})+"\\n");\n');

  const win = process.platform === "win32";
  const shim = join(lv, "bin", win ? "lively.cmd" : "lively");
  if (win) {
    // user-install.mjs 의 CLI_SHIM_CMD 와 같은 모양(배치가 node 로 lively.mjs 를 넘긴다).
    wf(shim, `@echo off\r\n"${process.execPath}" "${join(lv, "lib", "lively.mjs")}" %*\r\n`, "ascii");
  } else {
    wf(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(lv, "lib", "lively.mjs")}" "$@"\n`);
    chm(shim, 0o755);
  }

  // ① 번들 런타임이 없는 상태 → 폴백 경로(Windows 면 심 + shell). **여기가 EINVAL 이 터지던 자리다.**
  const fb = cliLaunchSpec({ cliPath: shim, livelyDir: lv, args: ["status"], exists: (p) => existsSyncReal(p), readdir: () => [] });
  const r1 = await runCli({ cli: shim, launch: fb, env: { ...process.env } });
  assert.equal(r1.error, null, `폴백 경로 실행 실패: ${r1.error}`);
  assert.equal(r1.ok, true, "심을 실제로 실행하지 못했다");

  // ② 번들 런타임이 있는 상태 → 직접 경로(셸 미경유). 실제 설치가 쓰는 경로다.
  const rtDir = join(lv, "runtime", "node-v22.0.0-test");
  mkd(rtDir, { recursive: true });
  const fakeNode = join(rtDir, win ? "node.exe" : "node");
  // 번들 런타임 자리에 **진짜 node** 를 놓는다(복사 대신 심는 건 플랫폼마다 다르니 실행파일을 그대로 쓴다).
  const spec = cliLaunchSpec({
    cliPath: shim, livelyDir: lv, args: ["status"],
    exists: (p) => (p === fakeNode ? true : existsSyncReal(p)),
    readdir: (d) => (d === join(lv, "runtime") ? ["node-v22.0.0-test"] : []),
  });
  if (win) {
    assert.equal(spec.via, "runtime");
    assert.equal(spec.shell, false, "직접 경로는 셸을 거치지 않는다");
  }
  // 실제 실행은 **진짜 node 경로**로 바꿔 확인한다(위 fakeNode 는 존재 판정만 흉내낸 것).
  const real = { ...spec, cmd: win ? process.execPath : spec.cmd };
  const r2 = await runCli({ cli: shim, launch: real, env: { ...process.env } });
  assert.equal(r2.ok, true, `직접 경로 실행 실패: ${r2.error}`);

  try { (await import("node:fs")).rmSync(box, { recursive: true, force: true }); } catch { /* */ }
});

// ── K. '있다' 와 '쓸 수 있다' 는 다르다 — 구 CLI 판정 (#1541) ──────────────────
// 실측(2026-08-11): #1541 이전 CLI 에 `--json-events` 를 주면 **조용히 무시하고 exit 0**, 평범한 JSON 을
//  stdout 에 뱉고 NDJSON 이벤트는 0개다. 앱은 "성공한 것 같은데 아무 일도 안 일어남" 이 된다.
//  앱보다 먼저 CLI 를 깔아 둔 PC(=지금까지 CLI 로 쓰던 모든 사람)가 전부 여기 걸린다.
t("K1 우리 말을 한 마디라도 했으면 계약을 안다", () => {
  assert.equal(cliContractVerdict({ events: [{ t: "start" }], code: 0 }), "ok");
  assert.equal(cliContractVerdict({ events: [{ t: "end", ok: false }], code: 1 }), "ok", "실패해도 '말은 통한다'");
});

t("K2 ★ 깨끗이 끝났는데 한 마디도 안 했다 = 플래그를 모른다(구 CLI)", () => {
  assert.equal(cliContractVerdict({ events: [], code: 0, error: "CLI 가 완료 신호(end) 없이 끝났습니다." }), "too-old");
});

t("K3 ★ 죽은 것은 '오래됨' 이 아니다 — 실패를 오래됨으로 읽으면 멀쩡한 CLI 를 오류마다 재설치한다", () => {
  assert.equal(cliContractVerdict({ events: [], code: 1 }), "failed");
  assert.equal(cliContractVerdict({ events: [], code: 0, signal: "SIGKILL" }), "failed");
  assert.equal(cliContractVerdict({ events: [], code: null }), "failed", "종료코드를 모르면 단정하지 않는다");
});

t("K4 아예 못 띄웠으면 unusable(재설치가 아니라 경로·권한 문제다)", () => {
  assert.equal(cliContractVerdict({ events: [], code: null, error: "CLI 를 실행하지 못했습니다: ENOENT" }), "unusable");
});

t("K5 입력이 없거나 망가져도 throw 하지 않는다", () => {
  for (const bad of [null, undefined, {}, { events: null }]) {
    const v = cliContractVerdict(bad);
    assert.ok(["ok", "too-old", "failed", "unusable"].includes(v), `${JSON.stringify(bad)} → ${v}`);
  }
});

t("K6 ★ 구 CLI 는 화면이 '설치 완료' 라고 말하면 안 된다", () => {
  const st = { cliFound: true, cliOutdated: true, loggedIn: true, kitInstalled: true };
  assert.match(statusLabel(st), /업데이트/);
  const model = trayMenuModel(st);
  const setup = model.find((m) => m.id === "setup");
  assert.ok(setup, "업데이트로 이끄는 항목이 없다 — 사용자는 빠져나갈 길이 없다");
  assert.match(setup.label, /업데이트/);
});

// ── W. 창 배치 기억 (#1541 갭) ────────────────────────────────────────────────
// 이게 틀리면 증상이 **"앱이 안 열린다"** 다 — 실제로는 보이지 않는 좌표에 떠 있다. 표로 못박는다.
const D1 = { x: 0, y: 0, width: 1440, height: 900 };            // 주 디스플레이
const D2 = { x: 1440, y: 0, width: 1920, height: 1080 };        // 오른쪽 보조

t("W1 저장값 없음 → 기본 크기 · 좌표는 **주지 않는다**(0,0 은 '모른다'가 아니라 '좌상단'이다)", () => {
  const b = normalizeBounds(null, [D1]);
  assert.deepEqual(b, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
  assert.ok(!("x" in b) && !("y" in b));
});

t("W2 저장값이 그 디스플레이 안 → 그대로 복원", () => {
  assert.deepEqual(normalizeBounds({ x: 100, y: 80, width: 800, height: 600 }, [D1]),
    { width: 800, height: 600, x: 100, y: 80 });
});

t("W3 ★ 화면 밖 좌표(뺀 모니터 자리) → 크기만 살리고 위치는 버린다", () => {
  const b = normalizeBounds({ x: 2000, y: 200, width: 800, height: 600 }, [D1]);
  assert.deepEqual(b, { width: 800, height: 600 });
});

t("W4 경계에 걸쳐 있어도 충분히 보이면 유지 — 완전 포함을 요구하면 멀쩡한 배치를 매번 되돌린다", () => {
  const b = normalizeBounds({ x: 1440 - 300, y: 0, width: 800, height: 600 }, [D1]);
  assert.equal(b.x, 1140);
});

t("W5 살짝만 걸치면(잡을 수 없다) 버린다", () => {
  const x = 1440 - (MIN_VISIBLE.width - 10);
  assert.ok(!("x" in normalizeBounds({ x, y: 0, width: 800, height: 600 }, [D1])), "잡을 수 없는 배치를 유지했다");
});

t("W6 최소 크기 밑으로는 못 내려간다", () => {
  const b = normalizeBounds({ x: 10, y: 10, width: 100, height: 50 }, [D1]);
  assert.equal(b.width, MIN_SIZE.width); assert.equal(b.height, MIN_SIZE.height);
});

t("W7 디스플레이보다 큰 창은 작업영역으로 제한", () => {
  const small = { x: 0, y: 0, width: 800, height: 600 };
  const b = normalizeBounds({ x: 0, y: 0, width: 5000, height: 4000 }, [small]);
  assert.equal(b.width, 800); assert.equal(b.height, 600);
});

t("W8 디스플레이를 모르면(빈 목록) 좌표를 믿지 않는다", () => {
  assert.deepEqual(normalizeBounds({ x: 100, y: 100, width: 800, height: 600 }, []), { width: 800, height: 600 });
});

t("W9 값이 망가져도(NaN·문자열·빈 객체) throw 없이 기본으로 접힌다", () => {
  for (const bad of [{}, { x: NaN, y: 1, width: "800", height: null }, { x: "a", y: "b" }, undefined]) {
    const b = normalizeBounds(bad, [D1]);
    assert.equal(b.width, DEFAULT_SIZE.width, JSON.stringify(bad));
    assert.ok(!("x" in b), JSON.stringify(bad));
  }
});

t("W10 두 번째 디스플레이의 배치도 유효하다(멀티모니터에서 매번 주화면으로 끌려오면 안 된다)", () => {
  const b = normalizeBounds({ x: 1600, y: 100, width: 800, height: 600 }, [D1, D2]);
  assert.equal(b.x, 1600);
});

t("W11 pickBounds — 네 값이 다 있어야 저장한다(부분 저장은 다음 복원을 망친다)", () => {
  assert.deepEqual(pickBounds({ x: 1, y: 2, width: 3, height: 4, extra: 9 }), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(pickBounds({ x: 1, y: 2, width: 3 }), null);
  assert.equal(pickBounds(null), null);
});

// ── L. 로그 보기 (#1541 갭) ───────────────────────────────────────────────────
t("L1 화이트리스트된 id 만 경로가 된다 — 렌더러가 경로를 정하면 임의 파일 읽기가 된다", () => {
  assert.equal(resolveLogPath(pposix.join, "/home/u/.lively", "node"), "/home/u/.lively/logs/node-agent.log");
  for (const bad of ["../../etc/passwd", "node-agent.log", "", null, "NODE", "logs/node"]) {
    assert.equal(resolveLogPath(pposix.join, "/home/u/.lively", bad), null, `열려서는 안 되는 id: ${String(bad)}`);
  }
  assert.equal(resolveLogPath(pposix.join, "", "node"), null, "livelyDir 이 없으면 경로를 지어내지 않는다");
});

t("L2 목록은 id·label·file 을 모두 갖는다(화면이 고를 수 있어야 한다)", () => {
  assert.ok(LOG_VIEWS.length >= 1);
  for (const v of LOG_VIEWS) {
    assert.ok(v.id && v.label && v.file, JSON.stringify(v));
    assert.ok(!v.file.includes("/") && !v.file.includes("\\"), `파일명에 경로가 섞였다: ${v.file}`);
  }
});

t("L3 짧은 로그는 그대로 — 자르지 않았으면 truncated=false", () => {
  const r = tailText("a\nb\nc\n");
  assert.equal(r.text, "a\nb\nc");
  assert.equal(r.truncated, false);
  assert.equal(r.lines, 3, "끝 개행을 한 줄로 세면 안 된다");
});

t("L4 줄 수를 넘으면 **뒤에서** 남긴다(최신이 뒤에 있다)", () => {
  const src = Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n");
  const r = tailText(src, { maxLines: 5 });
  assert.equal(r.text, "L45\nL46\nL47\nL48\nL49");
  assert.equal(r.truncated, true);
});

t("L5 ★ 한 줄이 거대해도 바이트 상한을 지킨다(스택트레이스 한 줄로 창이 얼면 안 된다)", () => {
  const r = tailText("x".repeat(500_000), { maxLines: 400, maxBytes: 1000 });
  assert.ok(Buffer.byteLength(r.text, "utf8") <= 1000, `상한 초과: ${Buffer.byteLength(r.text, "utf8")}`);
  assert.equal(r.truncated, true);
});

t("L6 빈 입력·null 에도 throw 하지 않는다", () => {
  for (const v of ["", null, undefined]) {
    const r = tailText(v);
    assert.equal(r.text, ""); assert.equal(r.truncated, false); assert.equal(r.lines, 0);
  }
});

// ── V. 버전 표시 · 재시도 화이트리스트 · 업데이트 문구 (#1541 갭) ───────────────
t("V1 버전은 앱과 키트를 **따로** 적는다 — 합치면 어느 쪽이 낡았는지 못 가린다", () => {
  assert.equal(versionLabel({ appVersion: "0.1.317", kitVersion: "abc123" }), "앱 0.1.317 · 키트 abc123");
  assert.equal(versionLabel({ appVersion: "0.1.317" }), "앱 0.1.317 · 키트 미설치");
  assert.equal(versionLabel({}), "앱 알 수 없음 · 키트 미설치");
});

t("V2 트레이에 버전 줄이 있고 **누를 수 없다**(정보 항목)", () => {
  const item = trayMenuModel({ cliFound: true, loggedIn: true, kitInstalled: true, appVersion: "1.2.3" })
    .find((m) => m.id === "version");
  assert.ok(item, "버전 항목이 없다");
  assert.equal(item.enabled, false);
  assert.match(item.label, /1\.2\.3/);
});

t("V3 ★ 재시도 대상은 RUN_KINDS 의 부분집합이고, 되돌리는 작업은 빠져 있다", () => {
  for (const k of RETRYABLE_KINDS) assert.ok(RUN_KINDS.includes(k), `RUN_KINDS 에 없는 재시도 대상: ${k}`);
  for (const k of ["logout", "node-stop"]) {
    assert.ok(!RETRYABLE_KINDS.includes(k), `${k} 는 자동 재시도 대상이면 안 된다(사람이 다시 판단해야 한다)`);
  }
});

t("V4 로그아웃·키트 업데이트 argv — 로그아웃은 게이트웨이 인자를 받지 않는다", () => {
  assert.deepEqual(argvFor("logout", { gateway: "https://x.example" }), ["logout"]);
  assert.deepEqual(argvFor("update", {}), ["update"]);
});

t("V5 업데이트 상태 문구 — reason 마다 다르고, '구조적 불가'와 '지금은 안 함'을 갈라 말한다", () => {
  const seen = new Set();
  for (const r of ["ok", "opt-out", "dev-run", "no-publish-config", "failed-before", "mac-unsigned"]) {
    const s = updateStatusNote(r);
    assert.ok(s && s.length > 5, r);
    assert.ok(!seen.has(s), `문구가 겹친다: ${r}`);
    seen.add(s);
  }
  assert.match(updateStatusNote("mac-unsigned"), /서명/);
  assert.match(updateStatusNote("dev-run"), /개발/);
  assert.ok(updateStatusNote("듣도보도못한값").length > 0, "모르는 reason 도 문구를 준다");
});

// ── Z. 릴리스 배선 — 자동 업데이트가 조용히 죽는 두 자리 (#1541) ──────────────────
// 둘 다 "빌드는 성공하고 설치도 되는데 그 뒤로 아무도 새 버전을 못 받는" 부류라 실행으로는 안 드러난다.
//  릴리스를 낸 뒤 몇 달 있다 알게 되는 종류의 고장이므로 여기서 못박는다.
{
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const wf = readFileSync(fileURLToPath(new URL("../../.github/workflows/release-desktop.yml", import.meta.url)), "utf8");

  t("Z1 ★ publish 대상이 실제 레포다 — 개명된 옛 이름이면 업데이터가 없는 곳을 본다", () => {
    const pub = (pkg.build && pkg.build.publish) || [];
    assert.equal(pub.length, 1, "publish 항목이 정확히 하나여야 한다");
    assert.equal(pub[0].provider, "github");
    assert.equal(pub[0].owner, "livewithlively");
    // 레포는 2026-08-02 공개 전환 때 context-ontology → lively 로 개명됐다. 옛 이름이 남아 있으면
    //  electron-updater 가 존재하지 않는 레포의 릴리스를 조회한다(실제로 그 상태로 있었다).
    assert.equal(pub[0].repo, "lively", "레포 개명(context-ontology→lively)이 반영되지 않았다");
  });

  t("Z3 ★ 빈 서명 시크릿을 electron-builder 에 넘기지 않는다 — mac 빌드가 통째로 실패한다", () => {
    // GitHub Actions 는 없는 시크릿을 **빈 문자열 env** 로 넘긴다. electron-builder 는 CSC_LINK 가 정의돼
    //  있으면 인증서 '파일 경로' 로 보고 열려 하므로 빈 값이면 projectDir 을 가리켜 `not a file` 로 죽는다.
    //  실측 A/B(같은 맥): 빈 문자열 → EXIT 1 · unset → EXIT 0. 시크릿이 없어도 미서명으로 빌드되는 게 계약이다.
    const macStep = wf.split("빌드 (mac)")[1].split("- name: 서명 유효성")[0];
    assert.match(macStep, /unset "\$v"/, "빈 서명 env 를 unset 하지 않는다");
    for (const v of ["CSC_LINK", "APPLE_API_KEY", "APPLE_ID"]) {
      assert.ok(macStep.includes(v), `${v} 가 정리 대상 목록에 없다`);
    }
    // 러너에 남의 인증서가 있어도 그걸로 서명하지 않는다 — 종전엔 키체인 자동탐색을 꺼서 지켰고,
    //  지금은 **신원을 ad-hoc 으로 명시 고정**해 지킨다(Z4). 둘 중 하나는 반드시 있어야 한다.
    assert.ok(/CSC_IDENTITY_AUTO_DISCOVERY=false/.test(macStep) || /-c\.mac\.identity=-/.test(macStep),
      "인증서 부재 시 서명 신원이 열려 있다 — 러너의 아무 인증서로 서명될 수 있다");
  });

  t("Z4 ★ 인증서가 없어도 mac 은 ad-hoc 으로 **다시 봉인**한다 — 안 하면 '손상됨' 하드블록", () => {
    // 실측(2026-08-11, v0.1.321): identity 미설정 + 인증서 부재 → electron-builder 가 서명을 통째로 스킵한다
    //  (ad-hoc 자동 폴백 없음). 그러면 Electron 바이너리의 linker-signed 서명이 그대로 남아 무효가 되고
    //  (app.asar 주입 + 실행파일 개명으로 봉인이 깨진다), 내려받은 사용자는 우회 버튼조차 없는
    //  "손상되었기 때문에 열 수 없습니다" 를 본다. ad-hoc 재봉인 후엔 단순 rejected(우클릭▸열기 가능).
    const macStep = wf.split("빌드 (mac)")[1].split("- name: 서명 유효성")[0];
    assert.match(macStep, /-c\.mac\.identity=-/, "인증서 없을 때 ad-hoc 재봉인을 하지 않는다");
    // ad-hoc + hardenedRuntime 은 라이브러리 검증에 걸려 앱이 안 뜬다 — 그 조합을 만들면 안 된다.
    assert.match(macStep, /-c\.mac\.hardenedRuntime=false/, "ad-hoc 인데 hardenedRuntime 을 끄지 않는다");
    // 배포 의도는 package.json 에 남아 있어야 한다(진짜 인증서가 들어오면 그 경로로 간다).
    assert.equal(pkg.build.mac.hardenedRuntime, true, "package.json 의 배포 설정까지 낮추면 공증 때 되돌려야 한다");
    assert.ok(!("identity" in pkg.build.mac), "identity 를 package.json 에 박으면 진짜 인증서를 무시하게 된다");
    // 그리고 **유효한지 실제로 확인**하는 스텝이 있어야 한다 — 빌드 성공은 서명 유효를 뜻하지 않는다.
    assert.match(wf, /codesign --verify --deep --strict/, "서명 유효성 검증 스텝이 없다");
  });

  t("Z2 ★ 릴리스 버전은 태그에서 온다 — package.json 에 박힌 값이 산출물로 나가면 안 된다", () => {
    // electron-builder 는 package.json.version 으로 산출물 이름과 latest*.yml 을 만든다. 그 값이 고정이면
    //  릴리스를 몇 번을 내도 업데이터가 보는 버전이 안 올라가 '이미 최신'으로 판정한다.
    assert.match(wf, /GITHUB_REF_NAME#v/, "태그에서 버전을 뽑는 스텝이 없다");
    assert.match(wf, /j\.version = process\.argv\[1\]/, "뽑은 버전을 package.json 에 쓰지 않는다");
    // 순서 불변식: npm ci 뒤여야 한다(먼저 바꾸면 package-lock 과 어긋나 npm ci 가 거부한다).
    assert.ok(wf.indexOf("npm ci") < wf.indexOf("GITHUB_REF_NAME#v"), "버전 스탬프가 npm ci 보다 앞에 있다");
    // 스탬프 스텝보다 빌드가 뒤여야 한다 — 앞이면 옛 버전으로 굽는다.
    assert.ok(wf.indexOf("GITHUB_REF_NAME#v") < wf.indexOf("electron-builder --win"), "빌드가 버전 스탬프보다 앞에 있다");
  });
}

// ── Z5/Z6. 업데이트 자산 이름 — 매니페스트와 실제 자산이 **같은 이름**이어야 한다 (#1541) ────────
// 실측(2026-08-18, 사용자 Windows · 앱 0.1.320): "Cannot download …/Lively-Setup-0.1.323.exe, status 404".
//  자산은 있었다 — `Lively.Setup.0.1.323.exe` 로. NSIS 기본 이름(공백)을 우리가 action-gh-release 로 그대로 올리면
//  GitHub 이 공백을 점으로 바꾸고, electron-updater 는 latest.yml 의 이름에서 공백을 하이픈으로 바꿔 요청한다.
//  둘은 영영 못 만난다 → 그 사용자는 영영 업데이트를 못 받는다. 이번엔 그 업데이트가 EINVAL(0.1.321) 수정이라 잠금이었다.
{
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const wf = readFileSync(fileURLToPath(new URL("../../.github/workflows/release-desktop.yml", import.meta.url)), "utf8");
  // 패턴 → 예시 이름(electron-builder 매크로 치환). 검사 대상은 리터럴 부분이다.
  const expand = (pat) => String(pat).replace(/\$\{productName\}/g, "Lively").replace(/\$\{version\}/g, "0.1.0")
    .replace(/\$\{ext\}/g, "exe").replace(/\$\{arch\}/g, "x64").replace(/\$\{[a-zA-Z]+\}/g, "x");

  t("Z5 ★ NSIS 산출물 이름을 명시한다 — 기본값(공백)이면 GitHub 자산과 latest.yml 이 갈려 404", () => {
    const name = pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName;
    assert.ok(name, "nsis.artifactName 이 없다 — electron-builder 기본값은 `${productName} Setup ${version}.${ext}`(공백)이다");
    assert.ok(!/\s/.test(name), `nsis.artifactName 에 공백: ${name}`);
    assert.match(expand(name), GITHUB_SAFE, `치환 후 이름에 GitHub 이 바꾸는 문자: ${expand(name)}`);
    assert.match(expand(name), /\.exe$/, "확장자는 ${ext} 로 끝나야 업데이터가 설치기로 인식한다");
    // Setup 이 이름에 남아야 한다 — 사람이 릴리스 페이지에서 '설치기'를 알아보는 단서다(mac zip·dmg 와 구분).
    assert.match(name, /Setup/, "설치기 이름에 Setup 표기가 없다");
    // mac/linux 는 electron-builder 기본값이 이미 공백 없음(`${productName}-${version}-${arch}.${ext}`) — 덮어썼다면 그것도 안전해야 한다.
    for (const k of ["mac", "linux", "dmg", "appImage"]) {
      const v = pkg.build && pkg.build[k] && pkg.build[k].artifactName;
      if (v) assert.match(expand(v), GITHUB_SAFE, `${k}.artifactName 이 GitHub-불안전: ${v}`);
    }
  });

  t("Z6 매니페스트 검증기 — 엣지 표", () => {
    const files = ["Lively-Setup-0.1.324.exe", "Lively-Setup-0.1.324.exe.blockmap", "latest.yml", "Lively-0.1.324-arm64-mac.zip", "Lively-0.1.324-arm64.dmg"];
    // ① 정상: 이름 일치 + 안전 → 문제 없음
    assert.deepEqual(manifestProblems("version: 0.1.324\nfiles:\n  - url: Lively-Setup-0.1.324.exe\n    sha512: x\npath: Lively-Setup-0.1.324.exe\n", files), []);
    // ② ★ 이번 사고: 로컬엔 파일이 **있는데** 이름에 공백 — GitHub 이 바꾼다 → 반드시 잡아야 한다
    const spaced = manifestProblems("path: Lively Setup 0.1.324.exe\n", ["Lively Setup 0.1.324.exe", "Lively Setup 0.1.324.exe.blockmap"]);
    assert.equal(spaced.length, 1, `공백 이름을 못 잡았다: ${JSON.stringify(spaced)}`);
    assert.match(spaced[0], /공백/);
    // ③ 매니페스트가 없는 파일을 가리킴(빌드 산출물 이름 ≠ 매니페스트 이름 — 정확히 0.1.323 의 상태)
    const missing = manifestProblems("path: Lively-Setup-0.1.324.exe\n", ["Lively Setup 0.1.324.exe"]);
    assert.ok(missing.some((p) => /release\/ 에 없다/.test(p)), JSON.stringify(missing));
    // ④ 새 헬퍼의 빈 입력: 참조가 0건이면 그 자체가 문제(업데이터가 받을 게 없다) — 통과시키면 안 된다
    assert.ok(manifestProblems("", files).length >= 1, "빈 매니페스트를 통과시켰다");
    assert.ok(manifestProblems("version: 0.1.324\n", files).length >= 1, "url/path 없는 매니페스트를 통과시켰다");
    // ⑤ GitHub 이 바꾸는 다른 문자(괄호·한글) — 공백이 아니어도 잡는다
    assert.ok(manifestProblems("path: Lively(1).exe\n", ["Lively(1).exe"]).length >= 1);
    // ⑥ 여러 파일(mac: zip + dmg) 전부 있으면 통과 · 하나만 빠져도 실패
    const mac = "files:\n  - url: Lively-0.1.324-arm64-mac.zip\n  - url: Lively-0.1.324-arm64.dmg\npath: Lively-0.1.324-arm64-mac.zip\n";
    assert.deepEqual(manifestProblems(mac, files), []);
    assert.ok(manifestProblems(mac, files.filter((f) => !/dmg$/.test(f))).length >= 1, "dmg 누락을 못 잡았다");
    // ⑦ ★ 차등 다운로드 재료 — Windows 설치기 옆에 .blockmap 이 없으면 업데이트마다 100MB 전체를 받는다(실측 3분+ 침묵). 실패로 막는다.
    const noBm = manifestProblems("path: Lively-Setup-0.1.324.exe\n", ["Lively-Setup-0.1.324.exe"]);
    assert.ok(noBm.some((p) => /blockmap/.test(p)), `exe 옆 blockmap 부재를 못 잡았다: ${JSON.stringify(noBm)}`);
    // mac zip 은 강제하지 않는다(미서명이라 mac 자동 업데이트가 꺼져 있다) — zip 만 있고 blockmap 없어도 통과
    assert.deepEqual(manifestProblems("path: Lively-0.1.324-arm64-mac.zip\n", ["Lively-0.1.324-arm64-mac.zip"]), []);
    // 워크플로가 blockmap 을 **올린다** — 검사만 하고 안 올리면 업데이터는 여전히 404 를 받는다
    assert.match(wf, /desktop\/release\/\*\.blockmap/, "릴리스 업로드 목록에 *.blockmap 이 없다");
    // 파서: url/path 만 읽고 sha512·size 같은 다른 키는 무시한다
    assert.deepEqual(manifestRefs("path: a.exe\nsha512: b\nfiles:\n  - url: c.exe\n    size: 1\n"), ["a.exe", "c.exe"]);
    // 배선: 워크플로에 검증 스텝이 **빌드 뒤·업로드 앞**에 있어야 한다 — 없으면 이 함수는 CI 에서 아무것도 안 본다
    assert.match(wf, /verify-update-manifest\.mjs/, "워크플로에 매니페스트 검증 스텝이 없다");
    assert.ok(wf.indexOf("electron-builder --win") < wf.indexOf("verify-update-manifest.mjs"), "검증이 빌드보다 앞이다");
    assert.ok(wf.indexOf("verify-update-manifest.mjs") < wf.indexOf("softprops/action-gh-release"), "검증이 업로드보다 뒤다 — 막을 수 없다");
    const step = wf.split("verify-update-manifest.mjs")[0].split("- name:").pop();
    assert.ok(!/continue-on-error:\s*true/.test(step), "검증 스텝이 continue-on-error 라 실패해도 릴리스가 나간다");
  });
}


// ── H. 웹 UI 셸 (#1541 · web-shell.mjs) — 앱 창에 게이트웨이의 /ui/ 를 그대로 싣는다(화면 코드 두 벌 금지) ─────────
{
  const { appReady, webUiUrl, webOrigin, openTargetFor, startupWindow, startedHiddenFrom, AUTOLAUNCH_ARGS, isTokenRejection, tokenWatchFilter, webBootPayload, APP_WINDOW_DEFAULT, APP_WINDOW_MIN } = await import("./web-shell.mjs");
  const { IPC_WEB } = await import("./ipc-contract.mjs");
  const GW = "https://dev.lvly.io";
  const okState = { cliFound: true, cliOutdated: false, cliBroken: null, loggedIn: true, kitInstalled: true };

  t("H1 준비 판정은 한 자리 — 다섯 축 중 하나라도 빠지면 false, 토큰 거부도 false", () => {
    assert.equal(appReady(okState), true);
    for (const k of ["cliFound", "loggedIn", "kitInstalled"]) assert.equal(appReady({ ...okState, [k]: false }), false, k);
    assert.equal(appReady({ ...okState, cliOutdated: true }), false, "구 CLI 인데 준비됐다고 한다");
    assert.equal(appReady({ ...okState, cliBroken: "spawn EINVAL" }), false, "못 띄우는 CLI 인데 준비됐다고 한다");
    assert.equal(appReady({ ...okState, tokenRejected: true }), false, "게이트웨이가 토큰을 거부했는데 준비됐다고 한다");
    assert.equal(appReady(null), false); assert.equal(appReady({}), false);
    // ★ 세 곳(메인·트레이·렌더러)이 각자 식을 적지 않는다 — 트레이는 appReady 를 import 하고, 렌더러는 state.ready 를 받는다
    const tray = readFileSync(fileURLToPath(new URL("./tray-menu.mjs", import.meta.url)), "utf8");
    assert.match(tray, /import \{ appReady \} from "\.\/web-shell\.mjs"/, "트레이가 appReady 를 안 쓴다");
    assert.ok(!/!s\.cliFound \|\| s\.cliOutdated \|\| s\.cliBroken \|\| !s\.loggedIn \|\| !s\.kitInstalled/.test(tray), "트레이에 준비 식이 따로 남아 있다");
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    assert.match(main, /next\.ready = appReady\(next\)/, "메인이 state.ready 를 안 채운다");
    assert.ok(!/if \(!state\.cliFound \|\| state\.cliOutdated \|\| state\.cliBroken \|\| !state\.loggedIn \|\| !state\.kitInstalled\) showWindow\(\)/.test(main), "메인 시작 경로에 옛 준비 식이 남아 있다");
    const js = readFileSync(fileURLToPath(new URL("../renderer/app.js", import.meta.url)), "utf8");
    assert.match(js, /const ready = !!s\?\.ready;/, "렌더러가 state.ready 대신 자기 식을 쓴다");
  });

  t("H2 웹 UI 주소·출처 — 뒤 슬래시 정리·경로 접두 보존·형식 아니면 null", () => {
    assert.equal(webUiUrl("https://dev.lvly.io"), "https://dev.lvly.io/ui/");
    assert.equal(webUiUrl("https://dev.lvly.io///"), "https://dev.lvly.io/ui/");
    assert.equal(webUiUrl("http://localhost:8080"), "http://localhost:8080/ui/");
    assert.equal(webUiUrl("https://corp.example.com/lively"), "https://corp.example.com/lively/ui/", "경로 접두가 있는 게이트웨이를 잘랐다");
    for (const bad of ["", null, "dev.lvly.io", "ftp://x", "https://a b", "https://x;rm -rf"]) assert.equal(webUiUrl(bad), null, String(bad));
    assert.equal(webOrigin("https://dev.lvly.io/lively/"), "https://dev.lvly.io");
    assert.equal(webOrigin("http://localhost:8080"), "http://localhost:8080");
    assert.equal(webOrigin("nope"), null);
  });

  t("H3 ★ 창 열기 규칙 — 같은 출처는 앱 안 새 창, 다른 출처는 브라우저, http(s) 아니면 거부", () => {
    assert.equal(openTargetFor("https://dev.lvly.io/ui/terminal.html?session=abc", GW), "child");
    assert.equal(openTargetFor("https://dev.lvly.io/ui/#/k/foo", GW), "child");
    assert.equal(openTargetFor("https://www.notion.so/page", GW), "external");
    assert.equal(openTargetFor("https://accounts.google.com/o/oauth2", GW), "external");
    assert.equal(openTargetFor("http://dev.lvly.io/ui/", GW), "external", "스킴이 다르면 다른 출처다");
    assert.equal(openTargetFor("https://dev.lvly.io:444/ui/", GW), "external", "포트가 다르면 다른 출처다");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "about:blank", "", null]) assert.equal(openTargetFor(bad, GW), "deny", String(bad));
    assert.equal(openTargetFor("https://dev.lvly.io/ui/", null), "external", "게이트웨이를 모르면 아무것도 앱 안에 열지 않는다");
    // 배선: 모든 웹 컨텐츠에 같은 규칙 — window.open(child/external/deny) + 최상위 이동(will-navigate)
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    assert.match(main, /app\.on\("web-contents-created"/, "web-contents-created 훅이 없다 — 자식 창은 규칙 밖이 된다");
    assert.match(main, /setWindowOpenHandler/, "window.open 을 다루지 않는다 — 터미널 새 창이 시스템 브라우저로 나간다");
    assert.match(main, /wc\.on\("will-navigate"/, "최상위 이동을 막지 않는다 — 앱 창이 남의 사이트로 넘어갈 수 있다");
    const seg = main.slice(main.indexOf("setWindowOpenHandler"), main.indexOf('wc.on("will-navigate"'));
    assert.match(seg, /openTargetFor\(url, state\.gatewayUrl\)/, "핸들러가 openTargetFor 를 안 쓴다");
    assert.match(seg, /shell\.openExternal\(url\); return \{ action: "deny" \}/, "외부 링크를 브라우저로 넘긴 뒤 거부하지 않는다");
    assert.match(seg, /preload: WEB_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true/, "자식 창에 같은 preload·격리를 안 준다");
  });

  t("H4 시작 창 — 할 일 있으면 마법사(숨겨 떴어도), 갖춰졌으면 사람이 켰을 때만 라이블리 화면", () => {
    assert.equal(startupWindow({ ready: false, startedHidden: false }), "setup");
    assert.equal(startupWindow({ ready: false, startedHidden: true }), "setup", "할 일이 있는데 숨겨 뜨면 '앱이 안 켜진다' 로 보인다");
    assert.equal(startupWindow({ ready: true, startedHidden: false }), "app");
    assert.equal(startupWindow({ ready: true, startedHidden: true }), "none", "로그인 자동시작마다 창이 뜨면 방해다");
    // 숨겨 떴나 — Windows 는 우리가 넣은 --hidden, macOS 는 로그인 항목 신호. 못 재면 false(창을 띄우는 쪽이 안전)
    assert.equal(startedHiddenFrom({ platform: "win32", argv: ["Lively.exe", "--hidden"] }), true);
    assert.equal(startedHiddenFrom({ platform: "win32", argv: ["Lively.exe"] }), false);
    assert.equal(startedHiddenFrom({ platform: "darwin", argv: [], loginItem: { wasOpenedAsHidden: true } }), true);
    assert.equal(startedHiddenFrom({ platform: "darwin", argv: [], loginItem: { wasOpenedAtLogin: true } }), true);
    assert.equal(startedHiddenFrom({ platform: "darwin", argv: [], loginItem: {} }), false);
    assert.equal(startedHiddenFrom({ platform: "linux", argv: [] }), false);
    assert.deepEqual(AUTOLAUNCH_ARGS, ["--hidden"]);
    // 배선: 등록·조회 둘 다 같은 인자(Windows 는 조회에도 args 를 줘야 openAtLogin 을 제대로 읽는다) + 시작 경로가 startupWindow 를 쓴다
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    assert.match(main, /setLoginItemSettings\(\{ openAtLogin: !!on, openAsHidden: true, args: AUTOLAUNCH_ARGS \}\)/, "등록에 --hidden 이 없다");
    assert.match(main, /getLoginItemSettings\(\{ args: AUTOLAUNCH_ARGS \}\)\.openAtLogin/, "조회에 args 를 안 준다(Windows 에서 항상 꺼짐으로 읽힌다)");
    const boot = main.slice(main.indexOf("app.whenReady"), main.indexOf("app.whenReady") + 2500);
    assert.match(boot, /startupWindow\(\{ ready: state\.ready, startedHidden \}\)/, "시작 경로가 startupWindow 를 안 쓴다");
    assert.match(boot, /if \(first === "setup"\) showWindow\(\); else if \(first === "app"\) showApp\(\);/, "판정대로 창을 안 연다");
    assert.match(main, /app\.on\("second-instance", \(\) => showMain\(\)\)/, "두 번째 실행이 갖춰진 뒤에도 마법사를 연다");
    assert.match(main, /app\.on\("activate", \(\) => showMain\(\)\)/, "dock 클릭이 갖춰진 뒤에도 마법사를 연다");
  });

  t("H5 ★ 토큰 거부 감지 — 그 게이트웨이의 /api/ui/* 401 만, /api/ui/login 은 제외, 다른 출처는 무시", () => {
    assert.equal(isTokenRejection({ url: GW + "/api/ui/me", statusCode: 401 }, GW), true);
    assert.equal(isTokenRejection({ url: GW + "/api/ui/v6/projects?mine=1", statusCode: 401 }, GW), true);
    assert.equal(isTokenRejection({ url: GW + "/api/ui/login", statusCode: 401 }, GW), false, "비밀번호 틀림은 토큰과 무관하다");
    assert.equal(isTokenRejection({ url: GW + "/api/ui/login?x=1", statusCode: 401 }, GW), false);
    assert.equal(isTokenRejection({ url: GW + "/api/ui/me", statusCode: 200 }, GW), false);
    assert.equal(isTokenRejection({ url: GW + "/api/ui/me", statusCode: 403 }, GW), false, "403 은 권한이지 로그인이 아니다");
    assert.equal(isTokenRejection({ url: "https://other.example/api/ui/me", statusCode: 401 }, GW), false);
    assert.equal(isTokenRejection({ url: GW + "/ui/", statusCode: 401 }, GW), false);
    assert.equal(isTokenRejection(null, GW), false);
    assert.deepEqual(tokenWatchFilter(GW + "/"), { urls: [GW + "/api/ui/*"] });
    assert.equal(tokenWatchFilter(""), null);
    // 배선: 응답을 바꾸지 않고 보기만(cb({})) · 401 은 **후보**일 뿐 — 메인이 /api/ui/me 재검증으로 확정(#1541 오탐 루프)
    //  · 거부된 **그 토큰**을 기억 · 파일 토큰이 바뀌거나 재로그인 성공(start ok)하면 풀림 · 준비 판정에 반영
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    const w = main.slice(main.indexOf("function watchTokenRejection"), main.indexOf('app.on("web-contents-created"'));
    assert.match(w, /webRequest\.onHeadersReceived\(filter/, "onHeadersReceived 를 안 건다");
    assert.match(w, /cb\(\{\}\);/, "응답을 그대로 통과시키지 않는다");
    assert.match(w, /void verifyTokenAfter401\(gatewayUrl\)/, "401 을 재검증 없이 그대로 믿는다(무인증 요청 401 오탐 → 만료 루프)");
    assert.match(w, /\/api\/ui\/me/, "재검증이 /api/ui/me 를 안 친다");
    assert.match(w, /if \(res\.status !== 401\) return;/, "멀쩡한 토큰(401 아님)을 거부로 눕힌다");
    assert.match(w, /rejectedToken = tok;/, "거부된 토큰을 기억하지 않는다");
    assert.ok(w.indexOf("res.status !== 401") < w.indexOf("rejectedToken = tok;"), "재검증 확인보다 먼저 거부를 기록한다");
    // 회복: 재로그인(setup·login) 성공 시 해제 — CLI 는 토큰이 먹히면 재발급 없이 끝나(파일 불변) 파일 비교만으론 안 풀린다
    assert.match(main, /if \(r\.ok && \(kind === "setup" \|\| kind === "login"\)\) rejectedToken = null;/, "재로그인 성공이 오판 플래그를 안 푼다(만료 화면 무한 루프)");
    assert.match(main, /next\.tokenRejected = !!\(rejectedToken && readTrim\(join\(LIVELY_DIR, "token"\)\) === rejectedToken\)/, "파일 토큰과 비교하지 않는다(재로그인해도 안 풀린다)");
    // 트레이·마법사 문구
    assert.match(statusLabel({ ...okState, tokenRejected: true }), /다시 로그인/);
    assert.ok(trayMenuModel({ ...okState, tokenRejected: true }).some((m) => m.id === "setup" && /다시 로그인/.test(m.label)), "트레이에 '다시 로그인…' 이 없다");
    const js = readFileSync(fileURLToPath(new URL("../renderer/app.js", import.meta.url)), "utf8");
    assert.match(js, /tokenRejected \? "로그인이 만료되었습니다/, "마법사가 만료를 '로그인 필요' 와 구분하지 않는다");
  });

  t("H6 preload 부팅 값 — 출처·토큰(공백은 없음으로)·버전·플랫폼. 토큰은 출처와 함께 가야 남의 사이트에 안 샌다", () => {
    assert.deepEqual(webBootPayload({ gatewayUrl: GW + "/", token: " abc ", appVersion: "0.1.330", platform: "darwin" }), { origin: GW, token: "abc", appVersion: "0.1.330", platform: "darwin" });
    assert.deepEqual(webBootPayload({ gatewayUrl: "bad", token: "  ", appVersion: null, platform: null }), { origin: null, token: null, appVersion: null, platform: null });
    assert.deepEqual(webBootPayload({}), { origin: null, token: null, appVersion: null, platform: null });
  });

  t("H7 ★ 웹 preload — 채널이 IPC_WEB 과 정확히 같고, 마법사 채널(CLI 실행 통로)은 하나도 없다, ipcRenderer 를 안 넘긴다, 출처를 본다", () => {
    const src = readFileSync(fileURLToPath(new URL("../preload/web.cjs", import.meta.url)), "utf8");
    const found = new Set((src.match(/"lively-web:[a-z-]+"/g) || []).map((s) => s.slice(1, -1)));
    for (const ch of Object.values(IPC_WEB)) assert.ok(found.has(ch), `web preload 에 없는 채널: ${ch}`);
    for (const ch of found) assert.ok(Object.values(IPC_WEB).includes(ch), `contract 에 없는 채널: ${ch}`);
    assert.ok(!/"lively:[a-z-]+"/.test(src), "웹 preload 에 마법사 채널이 있다 — 원격 페이지가 CLI 를 돌릴 수 있게 된다");
    assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(src) && !/ipcRenderer\s*:/.test(src.slice(src.indexOf("exposeInMainWorld"))), "ipcRenderer 를 노출했다");
    assert.match(src, /window\.location\.origin === boot\.origin/, "출처를 안 보고 토큰을 넣는다");
    assert.match(src, /localStorage\.setItem\(TOKEN_KEY, boot\.token\)/, "토큰을 localStorage 에 안 넣는다");
    assert.match(src, /"lively_ui_token"/, "웹이 보는 키(web/lib/net.ts TOKEN_KEY)와 다르다");
    // 두 접두는 서로 겹치지 않는다(마법사 preload 계약 검사 G2 가 웹 채널을 오인하지 않게)
    for (const ch of Object.values(IPC_WEB)) assert.ok(ch.startsWith("lively-web:") && !Object.values(IPC).includes(ch));
    // 메인: BOOT 는 동기 응답, LOGOUT 은 CLI logout, 둘 다 게이트웨이 출처에서 온 요청에만
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    assert.match(main, /ipcMain\.on\(IPC_WEB\.BOOT, \(e\) => \{[\s\S]*?e\.returnValue = \{ \.\.\.webBootPayload\(/, "BOOT 가 동기 응답이 아니다(비동기면 웹이 토큰 없이 부팅해 로그인 화면이 깜빡인다)");
    assert.match(main, /frameless: framelessOn\(process\.platform\)/, "BOOT 가 frameless 를 안 준다 — preload 가 타이틀바를 언제 그릴지 모른다");
    const bootSeg = main.slice(main.indexOf("ipcMain.on(IPC_WEB.BOOT"), main.indexOf("ipcMain.handle(IPC_WEB.LOGOUT"));
    assert.match(bootSeg, /fromGateway\(e\)/, "BOOT 가 보내는 프레임의 출처를 안 본다");
    const lo = main.slice(main.indexOf("ipcMain.handle(IPC_WEB.LOGOUT"), main.indexOf("ipcMain.handle(IPC_WEB.LOGOUT") + 400);
    assert.match(lo, /fromGateway\(e\)/); assert.match(lo, /start\("logout", \{\}\)/, "웹 로그아웃이 CLI 로그아웃으로 안 이어진다");
    // 웹 쪽 다리: core.ts logout 이 데스크톱 안이면 먼저 앱을 부른다(브라우저에선 없는 다리 — 그대로 지나간다)
    const core = readFileSync(fileURLToPath(new URL("../../web/core.ts", import.meta.url)), "utf8");
    assert.match(core, /window as any\)\.livelyDesktop/, "web/core.ts 가 데스크톱 다리를 모른다");
    assert.match(core, /desk\.logout\(\)/, "웹 logout 이 데스크톱 logout 을 안 부른다");
    assert.match(src, /logout: \(\) => ipcRenderer\.invoke\("lively-web:logout"\)/, "preload 가 logout 다리를 안 준다");
  });

  t("H8 웹 창 배선 — 준비됐을 때만·/ui/·전용 preload·격리·주소/토큰 바뀌면 다시 싣기·실패는 마법사 카드로·닫아도 트레이", () => {
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    const a = main.slice(main.indexOf("function showApp"), main.indexOf("function loadAppBounds"));
    assert.match(a, /if \(!state\.ready\) return \{ ok: false/, "준비 안 됐는데 웹 창을 연다");
    assert.match(a, /const url = webUiUrl\(state\.gatewayUrl\)/, "주소를 webUiUrl 로 안 만든다");
    assert.match(a, /preload: WEB_PRELOAD/, "웹 창이 마법사 preload 를 쓴다(원격 페이지에 CLI 통로가 열린다)");
    assert.match(a, /contextIsolation: true, nodeIntegration: false, sandbox: true/, "웹 창 격리가 빠졌다");
    assert.match(a, /if \(appLoaded\.url !== url \|\| appLoaded\.token !== token\)/, "재로그인·다른 게이트웨이에서 다시 싣지 않는다");
    assert.match(a, /appWin\.webContents\.on\("did-fail-load"/, "못 실었을 때를 다루지 않는다(빈 창이 남는다)");
    assert.match(a, /code === -3\) return/, "ERR_ABORTED 를 실패로 오인한다");
    assert.match(a, /appWin\.on\("close", \(e\) => \{ saveAppBounds\(\); if \(!quitting\) \{ e\.preventDefault\(\); appWin\.hide\(\); \} \}\)/, "웹 창을 닫으면 앱이 죽거나 자리를 잃는다");
    assert.match(a, /watchTokenRejection\(state\.gatewayUrl\)/, "401 감시를 안 건다");
    assert.match(main, /const WEB_PRELOAD = join\(HERE, "\.\.", "preload", "web\.cjs"\)/);
    // 마법사 창과 자리를 따로 기억하고, 크기 기본이 웹 셸에 맞다
    assert.match(main, /APP_BOUNDS_FILE = join\(LIVELY_DIR, "desktop-app-window\.json"\)/);
    assert.ok(APP_WINDOW_DEFAULT.width >= 1200 && APP_WINDOW_MIN.width >= 800, "웹 3열 셸이 접히는 크기다");
    const nb = normalizeBounds(null, [{ x: 0, y: 0, width: 1920, height: 1080 }], { defaultSize: APP_WINDOW_DEFAULT, minSize: APP_WINDOW_MIN });
    assert.deepEqual(nb, { width: 1280, height: 840 });
    assert.deepEqual(normalizeBounds({ width: 100, height: 100 }, [], { defaultSize: APP_WINDOW_DEFAULT, minSize: APP_WINDOW_MIN }), { width: 900, height: 600 }, "웹 창 최소치가 안 먹는다");
    assert.deepEqual(normalizeBounds(null, []), { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height }, "옵션 없으면 마법사 기본 그대로");
    // 준비 상태 전이 → 창 전환(syncWindows): 무너지면 웹 창 내리고 마법사, 마법사에서 갖춰지면 웹 창
    const sy = main.slice(main.indexOf("function syncWindows"), main.indexOf("function syncWindows") + 900);
    assert.match(sy, /if \(wasReady && !ready\)/); assert.match(sy, /appWin\.hide\(\); showWindow\(\);/);
    assert.match(sy, /if \(!wasReady && ready && win/); assert.match(sy, /showApp\(\)/);
    assert.match(main, /syncWindows\(wasReady\)/, "refreshState 가 전이를 안 본다");
    // 업데이트 자동 적용의 '보고 있나' 는 두 창 다
    assert.match(main, /windowVisible: anyWindowVisible\(\)/, "웹 창을 보는 중에도 자동 적용된다");
    // 마법사: 카드·버튼·IPC
    const html = readFileSync(fileURLToPath(new URL("../renderer/index.html", import.meta.url)), "utf8");
    const js = readFileSync(fileURLToPath(new URL("../renderer/app.js", import.meta.url)), "utf8");
    assert.match(html, /id="app-card"/); assert.match(html, /id="app-open"/); assert.match(html, /id="done-open"/);
    assert.match(js, /window\.lively\.openApp\(\)/, "마법사 버튼이 openApp 을 안 부른다");
    assert.match(js, /s\?\.webError/, "마법사가 못 실은 사유를 안 보여준다");
    assert.match(main, /ipcMain\.handle\(IPC\.OPEN_APP, \(\) => showApp\(\)\)/);
    // 트레이: 갖춰지면 '라이블리 열기' + '설치·노드 설정…'
    const ready = trayMenuModel({ ...okState, nodeRunning: true, nodeRegistered: true, gatewayUrl: GW });
    assert.ok(ready.some((m) => m.id === "open" && m.label === "라이블리 열기"));
    assert.ok(ready.some((m) => m.id === "settings"), "갖춰진 뒤 마법사로 가는 문이 없다");
    const not = trayMenuModel({ ...okState, loggedIn: false });
    assert.ok(not.some((m) => m.id === "open" && m.label === "창 열기") && !not.some((m) => m.id === "settings"));
    assert.match(main, /if \(id === "settings"\) return showWindow\(\)/);
  });
}


// ── P. 로그인 셸 PATH 보강 (#1541 · login-path.mjs) — GUI 최소 PATH 로 CLI 를 몰던 근본 원인 ─────────
{
  const { mergePath, extractPath, loginShellCmd, enrichPathFromLoginShell } = await import("./login-path.mjs");
  t("P1 합집합 — 로그인 셸 우선·중복/빈 조각 제거·현재 PATH 성분 보존", () => {
    assert.equal(mergePath("/a:/b:/usr/bin", "/usr/bin:/bin:/c", ":"), "/a:/b:/usr/bin:/bin:/c");
    assert.equal(mergePath("", "/usr/bin:/bin", ":"), "/usr/bin:/bin");
    assert.equal(mergePath("/a::/a", "", ":"), "/a");
  });
  t("P2 마커 추출 — 셸 rc 잡음(모트·에코)에 안 속는다", () => {
    assert.equal(extractPath("Welcome!\n<<<LIVELY_PATH:/a:/b>>>"), "/a:/b");
    assert.equal(extractPath("no marker"), null);
    assert.equal(extractPath(""), null);
  });
  t("P3 질의 명령 — SHELL 존중, GUI(미설정)는 darwin=zsh 폴백, -l 만(-i 는 tty 대기 행)", () => {
    assert.deepEqual(loginShellCmd({ SHELL: "/bin/bash" }, "darwin")[0], "/bin/bash");
    assert.equal(loginShellCmd({}, "darwin")[0], "/bin/zsh");
    assert.equal(loginShellCmd({}, "linux")[0], "/bin/sh");
    const argv = loginShellCmd({}, "darwin")[1];
    assert.equal(argv[0], "-lc");
    assert.ok(!argv.includes("-i"), "-i 가 섞였다(무tty 에서 매달린다)");
  });
  t("P4 ★ enrich — darwin 은 env.PATH 를 덮고, win32 는 손대지 않고, 실패는 무해", () => {
    const env = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const got = enrichPathFromLoginShell(env, "darwin", () => "<<<LIVELY_PATH:/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin>>>");
    assert.equal(got, "/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin");
    assert.equal(env.PATH, got, "env.PATH 에 심지 않으면 자식이 못 물려받는다");
    const w = { PATH: "C:\\x" };
    assert.equal(enrichPathFromLoginShell(w, "win32", () => { throw new Error("호출되면 안 된다"); }), null);
    assert.equal(w.PATH, "C:\\x");
    const e2 = { PATH: "/usr/bin" };
    assert.equal(enrichPathFromLoginShell(e2, "darwin", () => { throw new Error("셸 실패"); }), null);
    assert.equal(e2.PATH, "/usr/bin", "실패가 PATH 를 건드렸다");
    assert.equal(enrichPathFromLoginShell({ PATH: "/a" }, "darwin", () => "<<<LIVELY_PATH:/a>>>"), null, "변화 없음 = null");
  });
  t("P5 배선 — 메인이 whenReady 초입(첫 refreshState 전)에 보강한다", () => {
    const main = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
    const boot = main.slice(main.indexOf("app.whenReady"), main.indexOf("app.whenReady") + 1200);
    const at = boot.indexOf("enrichPathFromLoginShell");
    assert.ok(at >= 0, "whenReady 에서 PATH 를 보강하지 않는다");
    assert.ok(at < boot.indexOf("refreshState"), "첫 CLI 실행(refreshState deep)보다 앞서야 한다");
  });
}

console.log(`\n${pass} passed`);

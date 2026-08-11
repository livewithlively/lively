// 데스크톱 앱 코어 (#1541 T2) — Electron 없이 도는 층 전부.
//  CLI 탐색 · NDJSON 파싱 · CLI 구동(스텁 spawn) · 진행 리듀서 · IPC argv · 트레이 메뉴 모델.
//  실행: node desktop/main/desktop-core.test.mjs
//
// ⚠ 여기가 앱 로직의 **유일한 검증 지점**이다: Electron 을 띄우는 건 CI 에서 못 하고 사람 손이 필요하다.
//  그래서 Electron API 의존을 main.mjs 한 파일에 가두고, 판단이 있는 코드는 전부 이쪽에 둔다.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCandidates, locateCli, cliShimName, cliMissingHelp, bootstrapOneLiner } from "./cli-locate.mjs";
import { bootstrapCommand, runBootstrap } from "./bootstrap.mjs";
import { createNdjsonParser, runCli, reduceProgress, lastError, cliContractVerdict } from "./cli-runner.mjs";
import { argvFor, RUN_KINDS, IPC } from "./ipc-contract.mjs";
import { trayMenuModel, statusLabel } from "./tray-menu.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";
import { shouldCheckForUpdates, updateFailureNote, UPDATE_INTERVAL_MS, UPDATE_OPT_OUT_ENV } from "./update-policy.mjs";
import { normalizeBounds, pickBounds, MIN_SIZE, DEFAULT_SIZE, MIN_VISIBLE } from "./window-bounds.mjs";
import { LOG_VIEWS, resolveLogPath, tailText } from "./log-view.mjs";
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
    const macStep = wf.split("빌드 (mac)")[1].split("- name:")[0];
    assert.match(macStep, /unset "\$v"/, "빈 서명 env 를 unset 하지 않는다");
    assert.match(macStep, /CSC_IDENTITY_AUTO_DISCOVERY=false/, "인증서가 없을 때 키체인 자동탐색을 끄지 않는다");
    for (const v of ["CSC_LINK", "APPLE_API_KEY", "APPLE_ID"]) {
      assert.ok(macStep.includes(v), `${v} 가 정리 대상 목록에 없다`);
    }
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

console.log(`\n${pass} passed`);

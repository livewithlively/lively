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
import { cliCandidates, locateCli, cliShimName, cliMissingHelp } from "./cli-locate.mjs";
import { createNdjsonParser, runCli, reduceProgress, lastError } from "./cli-runner.mjs";
import { argvFor, RUN_KINDS, IPC } from "./ipc-contract.mjs";
import { trayMenuModel, statusLabel } from "./tray-menu.mjs";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.mjs";

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
  assert.match(cliMissingHelp("https://dev.lvly.io", "darwin"), /curl -fsSL https:\/\/dev\.lvly\.io\/cli \| sh/);
  assert.match(cliMissingHelp("https://dev.lvly.io/", "win32"), /irm https:\/\/dev\.lvly\.io\/cli\/bootstrap\.ps1 \| iex/);
  // 주소를 모르면 명령을 지어내지 않는다 — 주소부터 물어야 한다고 말한다.
  assert.ok(!/curl|irm/.test(cliMissingHelp("", "darwin")));
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

console.log(`\n${pass} passed`);

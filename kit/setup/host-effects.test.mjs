#!/usr/bin/env node
// Windows User PATH host-effect 경계 단위테스트. 실제 PowerShell/HKCU는 절대 호출하지 않고 순수 포트+fake executor만 쓴다.
import {
  addWindowsUserPath, createHostEffects, entrypointHostEffects, hostEffectsAllowed,
  mutateWindowsUserPath, removeWindowsUserPath,
} from "./host-effects.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`ok  ${name}`); }
  else { fail++; console.error(`FAIL ${name} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};
const denied = async (fn) => {
  try { await fn(); return null; } catch (e) { return { code: e.code, kind: e.kind }; }
};

// 외부 CLI 포트 — native/fake만 실행하고, 기본/deny는 executor를 호출하기 전에 막는다.
{
  const calls = [];
  const native = createHostEffects({ mode: "native", execFile: (...a) => { calls.push(a); return "ok"; } });
  eq("P-E1 native CLI → executor 1회·결과 보존", { result: native.execFileSync("tool", ["a"]), calls },
    { result: "ok", calls: [["tool", ["a"], {}]] });
}
{
  let calls = 0;
  const effect = createHostEffects({ mode: "deny", execFile: () => { calls++; } });
  eq("P-E2 deny CLI → executor 0회", { error: await denied(() => effect.execFileSync("tool")), calls },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "external-cli" }, calls: 0 });
}
{
  const calls = [];
  const fake = createHostEffects({ mode: "fake", execFile: (...a) => { calls.push(a); return 7; } });
  eq("P-E3 fake CLI → fake만 1회", { result: fake.execFileSync("stub", ["x"]), calls },
    { result: 7, calls: [["stub", ["x"], {}]] });
}
{
  let calls = 0;
  const effect = createHostEffects({ execFile: () => { calls++; } });
  eq("P-E4 capability 부재 CLI → 기본 deny", { error: await denied(() => effect.execFileSync("tool")), calls },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "external-cli" }, calls: 0 });
}
{
  const calls = [];
  const effect = createHostEffects({ mode: "native", execFile: (...a) => { calls.push(a); return 0; } });
  effect.execFileSync("tool");
  eq("P-E5 argv 0개 경계 → 빈 argv 그대로", calls, [["tool", [], {}]]);
}

// 네트워크 포트 — 실제 소켓 대신 URL·init 호출 기록만 관찰한다.
{
  const calls = [], response = { ok: true };
  const native = createHostEffects({ mode: "native", fetcher: async (...a) => { calls.push(a); return response; } });
  eq("P-N1 native network → fetcher 1회·응답 보존", { same: await native.fetch("https://example.test") === response, calls },
    { same: true, calls: [["https://example.test", undefined]] });
}
for (const [id, mode] of [["P-N2", "deny"], ["P-N4", undefined]]) {
  let calls = 0;
  const effect = createHostEffects({ ...(mode ? { mode } : {}), fetcher: async () => { calls++; } });
  eq(`${id} network → 요청 0회`, { error: await denied(() => effect.fetch("https://example.test")), calls },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "network" }, calls: 0 });
}
{
  const calls = [];
  const fake = createHostEffects({ mode: "fake", fetcher: async (...a) => { calls.push(a); return "fake"; } });
  eq("P-N3 fake network → fake만 1회", { result: await fake.fetch("https://example.test", { method: "POST" }), calls },
    { result: "fake", calls: [["https://example.test", { method: "POST" }]] });
}
{
  const calls = [];
  const native = createHostEffects({ mode: "native", fetcher: async (...a) => { calls.push(a); return "ok"; } });
  await native.fetch("https://example.test", { timeout: 0 });
  eq("P-N5 timeout=0 경계 → init 그대로 전달", calls, [["https://example.test", { timeout: 0 }]]);
}

// 스케줄러 포트 — command 이름으로도 scheduler 종류를 유지한다.
{
  const calls = [];
  const native = createHostEffects({ mode: "native", spawnSync: (...a) => { calls.push(a); return { status: 0 }; } });
  eq("P-S1 native scheduler → 1회", { result: native.schedulerSync("schtasks", ["/Query"]), calls },
    { result: { status: 0 }, calls: [["schtasks", ["/Query"], {}]] });
}
for (const [id, mode] of [["P-S2", "deny"], ["P-S4", undefined]]) {
  let calls = 0;
  const effect = createHostEffects({ ...(mode ? { mode } : {}), spawnSync: () => { calls++; } });
  eq(`${id} scheduler → 실행 0회`, { error: await denied(() => effect.schedulerSync("schtasks")), calls },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "scheduler" }, calls: 0 });
}
{
  const calls = [];
  const fake = createHostEffects({ mode: "fake", spawnSync: (...a) => { calls.push(a); return "fake"; } });
  eq("P-S3 fake scheduler → fake만 1회", { result: fake.schedulerSync("schtasks", ["/Run"]), calls },
    { result: "fake", calls: [["schtasks", ["/Run"], {}]] });
}
{
  let calls = 0;
  const native = createHostEffects({ mode: "native", spawnSync: () => { calls++; return { status: 1 }; } });
  native.schedulerSync("schtasks", [], { retries: 0 });
  eq("P-S5 재시도 0회 경계 → 최초 호출만", calls, 1);
}

eq("P-W1 테스트 env deny → entrypoint도 승격 안 됨",
  entrypointHostEffects({ env: { LIVELY_HOST_EFFECTS: "deny" } }).mode, "deny");
eq("P-W2 제품 entrypoint → native capability 명시",
  entrypointHostEffects({ env: {} }).mode, "native");
{
  const calls = [];
  const sandbox = entrypointHostEffects({
    env: { LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox" },
    fetcher: async (...a) => { calls.push(a); return "mock"; },
    execFile: (...a) => { calls.push(a); return "node"; },
    spawnSync: (...a) => { calls.push(a); return "scheduler"; },
  });
  eq("P-W1a sandbox → Linux 하한 포함 동적 고포트 loopback mock 허용",
    { mode: sandbox.mode, result: await sandbox.fetch("http://127.0.0.1:32768/mock"), calls: calls.length },
    { mode: "sandbox", result: "mock", calls: 1 });
  eq("P-W1b sandbox → 현재 Node helper 허용",
    { result: sandbox.execFileSync(process.execPath, []), calls: calls.length },
    { result: "node", calls: 2 });
  eq("P-W1c sandbox → 기본 로컬 서비스 포트 차단",
    { error: await denied(() => sandbox.fetch("http://127.0.0.1:8080/api")), calls: calls.length },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "network" }, calls: 2 });
  eq("P-W1c2 sandbox → 동적 고포트 바로 아래 경계 차단",
    { error: await denied(() => sandbox.fetch("http://127.0.0.1:32767/api")), calls: calls.length },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "network" }, calls: 2 });
  eq("P-W1d sandbox → 작업 스케줄러 차단",
    { error: await denied(() => sandbox.schedulerSync("schtasks", ["/Create"])), calls: calls.length },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "scheduler" }, calls: 2 });
}
{
  const calls = [];
  const sandboxRoot = join(tmpdir(), "lively-host-effects-sandbox");
  const scheduler = join(sandboxRoot, "bin", process.platform === "win32" ? "schtasks.exe" : "systemctl");
  const sandbox = entrypointHostEffects({
    env: { LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: sandboxRoot },
    spawnSync: (...a) => { calls.push(a); return { status: 0 }; },
  });
  eq("P-W1d2 sandbox → 샌드박스 내부 스케줄러 stub만 허용",
    { result: sandbox.schedulerSync(scheduler, ["status"]), calls: calls.length },
    { result: { status: 0 }, calls: 1 });
}
{
  const calls = [];
  const env = { LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", LIVELY_HOME: "C:\\sandbox" };
  const sandbox = entrypointHostEffects({ env, execFile: (...a) => { calls.push(a); return "ok"; }, spawnSync: (...a) => { calls.push(a); return { status: 0 }; } });
  eq("P-W1e sandbox → 샌드박스 절대경로 stub 허용",
    { result: sandbox.execFileSync("C:\\sandbox\\bin\\stub.exe"), calls: calls.length },
    { result: "ok", calls: 1 });
  eq("P-W1f sandbox → 샌드박스 cwd의 git 허용",
    { result: sandbox.spawnSync("git", ["status"], { cwd: "C:\\sandbox\\repo" }), calls: calls.length },
    { result: { status: 0 }, calls: 2 });
  eq("P-W1g sandbox → 샌드박스 밖 외부 CLI 차단",
    { error: await denied(() => sandbox.execFileSync("C:\\real\\tool.exe")), calls: calls.length },
    { error: { code: "LIVELY_HOST_EFFECT_DENIED", kind: "external-cli" }, calls: 2 });
}

// E1/E8 — 기본 deny이며 LIVELY_HOME은 capability가 아니다.
eq("E1 기본/임시 LIVELY_HOME → 호스트 효과 권한 없음",
  hostEffectsAllowed({ args: [], env: { LIVELY_HOME: "C:\\tmp\\home" } }), false);

// E2/E6 — 빈 User PATH에는 항목 하나만 생긴다.
eq("E2 빈 PATH install → bin 하나 추가", mutateWindowsUserPath("", "C:\\x\\bin", "add"),
  { value: "C:\\x\\bin", changed: true });

// E3 — Windows PATH 정체성은 대소문자·슬래시·후행 구분자를 무시한다.
eq("E3 동등 항목 재설치 → 중복 없음",
  mutateWindowsUserPath("c:/X/bin/;C:\\keep", "C:\\x\\bin", "add"),
  { value: "c:/X/bin/;C:\\keep", changed: false });

// E4 — deny에서는 executor 자체가 호출되지 않는다.
{
  let calls = 0;
  const got = removeWindowsUserPath("C:\\x\\bin", {
    platform: "win32", allowed: false, exec: () => { calls++; return { status: 0, stdout: "changed" }; },
  });
  eq("E4 deny uninstall → executor 0회", { got, calls }, { got: { status: "denied", changed: false }, calls: 0 });
}

// E5 — 제거는 우리 항목만 걷고 빈 세그먼트·사용자 항목을 보존한다.
eq("E5 uninstall → lively만 제거·사용자 PATH 보존",
  mutateWindowsUserPath("C:\\keep;;c:/X/bin/;D:\\user;", "C:\\x\\bin", "remove"),
  { value: "C:\\keep;;D:\\user;", changed: true });

// E6 — 빈 PATH 제거는 무변경이다.
eq("E6 빈 PATH uninstall → 무변경", mutateWindowsUserPath("", "C:\\x\\bin", "remove"),
  { value: "", changed: false });

// E7 — 비-Windows에서는 allow여도 executor를 부르지 않는다.
{
  let calls = 0;
  const got = addWindowsUserPath("/x/bin", {
    platform: "linux", allowed: true, exec: () => { calls++; return { status: 0, stdout: "changed" }; },
  });
  eq("E7 비-Windows → registry adapter 무호출", { got, calls }, { got: { status: "not-windows", changed: false }, calls: 0 });
}

// E9 — 권한은 플래그 또는 정확한 allow env만 연다.
eq("E9 명시 capability만 allow", {
  flag: hostEffectsAllowed({ args: ["--allow-host-effects"], env: {} }),
  env: hostEffectsAllowed({ args: [], env: { LIVELY_HOST_EFFECTS: "allow" } }),
  nearMiss: hostEffectsAllowed({ args: [], env: { LIVELY_HOST_EFFECTS: "true" } }),
}, { flag: true, env: true, nearMiss: false });

// fake executor 배선 — allow일 때 결과 토큰을 상태로 번역한다.
eq("E2 adapter allow → changed 상태",
  addWindowsUserPath("C:\\x\\bin", { platform: "win32", allowed: true, exec: () => ({ status: 0, stdout: "changed\n" }) }),
  { status: "changed", changed: true });

// 생산 오케스트레이터는 safe-by-default 엔진에 capability를 실제로 전달해야 한다.
{
  const setup = dirname(fileURLToPath(import.meta.url));
  const kit = join(setup, "..");
  const repo = join(kit, "..");
  const sources = [
    readFileSync(join(kit, "cli", "lively.mjs"), "utf8"),
    readFileSync(join(kit, "hooks", "self-update.mjs"), "utf8"),
    readFileSync(join(setup, "uninstall-windows.ps1"), "utf8"),
    readFileSync(join(repo, "deploy", "install-kit.sh"), "utf8"),
    readFileSync(join(repo, "src", "terminal", "member-kit-seed.ts"), "utf8"),
  ];
  eq("E9b 생산 설치·업데이트 진입점이 capability를 명시",
    sources.map((src) => src.includes("--allow-host-effects")), [true, true, true, true, true]);
}

console.log(`host-effects tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

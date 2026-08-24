#!/usr/bin/env node
// Windows User PATH host-effect 경계 단위테스트. 실제 PowerShell/HKCU는 절대 호출하지 않고 순수 포트+fake executor만 쓴다.
import {
  addWindowsUserPath, hostEffectsAllowed, mutateWindowsUserPath, removeWindowsUserPath,
} from "./host-effects.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`ok  ${name}`); }
  else { fail++; console.error(`FAIL ${name} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

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

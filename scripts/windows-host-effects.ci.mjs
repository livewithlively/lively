#!/usr/bin/env node
// 실제 HKCU User PATH 왕복. 기본 *.itest 수집에도 넣지 않고 disposable GitHub windows-latest가 직접 실행한다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWindowsUserPath, removeWindowsUserPath } from "../kit/setup/host-effects.mjs";

const disposable = process.platform === "win32"
  && process.env.GITHUB_ACTIONS === "true"
  && process.env.RUNNER_OS === "Windows"
  && process.env.LIVELY_HOST_EFFECTS === "allow";
if (!disposable) {
  console.error("이 테스트는 LIVELY_HOST_EFFECTS=allow인 disposable GitHub windows-latest에서만 실행합니다.");
  process.exit(2);
}

const readPath = () => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  "[Console]::Out.Write([Environment]::GetEnvironmentVariable('PATH','User'))"], { encoding: "utf8" });
const box = mkdtempSync(join(tmpdir(), "lively-host-effects-itest-"));
const bin = join(box, "bin");
const before = readPath();
let added = false;
try {
  const a = addWindowsUserPath(bin, { allowed: true });
  added = a.status === "changed";
  if (!added) throw new Error(`install status=${a.status}`);
  const once = readPath();
  const again = addWindowsUserPath(bin + "\\", { allowed: true });
  if (again.status !== "unchanged" || readPath() !== once) throw new Error("동등 항목 재설치가 중복/변경을 만들었다");
  const u = removeWindowsUserPath(bin + "\\", { allowed: true });
  if (u.status === "changed") added = false;
  if (u.status !== "changed" || readPath() !== before) throw new Error("제거 뒤 User PATH가 원본과 다르다");
  console.log("ok  E13 disposable Windows CI에서 install→멱등→uninstall User PATH 완전 왕복");
} finally {
  if (added) removeWindowsUserPath(bin, { allowed: true });
  rmSync(box, { recursive: true, force: true });
}

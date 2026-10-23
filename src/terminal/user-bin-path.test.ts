// 셀프호스트 게이트웨이 PATH 에 사용자 몫 프로그램 폴더를 잇는다(#4970) — 설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16 · 엣지 표 = 아래 A 행.
//  실측 사고: 위시스트 박스에서 claude 가 /home/lively/.local/bin 에만 있고 게이트웨이 PATH 로는 못 찾았다(세션·화면 안 로그인·설치 확인 전부).
//  실행: npm run build && node dist/terminal/user-bin-path.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withUserBinDirs, USER_BIN_DIRS } from "./user-bin-path.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const H = "/home/lively";
const SYS = "/usr/bin:/usr/local/bin:/bin";
const ALL = `${H}/.local/bin:${H}/.npm-global/bin:${H}/.lively/bin`;

t("A1 원래 PATH 뒤에 세션 계약 순서로 붙는다", () => {
  assert.equal(withUserBinDirs(SYS, H), `${SYS}:${ALL}`);
});

t("A2 이미 들어 있는 폴더는 다시 넣지 않는다(옛 서비스 PATH 끝의 ~/.npm-global/bin)", () => {
  const p = `${SYS}:${H}/.npm-global/bin`;
  assert.equal(withUserBinDirs(p, H), `${p}:${H}/.local/bin:${H}/.lively/bin`);
});

t("A3 폴더가 아직 없어도 붙인다 — 게이트웨이가 뜬 뒤 깔린 프로그램도 찾게(설치 확인과 같은 폴더를 본다)", () => {
  //  종전 판은 «있는 폴더만» 이라 부팅 뒤에 생긴 ~/.local/bin 의 AI 를 설치 확인은 «있음», 세션은 «없음» 으로 봤다(격리 리뷰).
  assert.equal(withUserBinDirs(SYS, "/home/nobody-yet"), `${SYS}:/home/nobody-yet/.local/bin:/home/nobody-yet/.npm-global/bin:/home/nobody-yet/.lively/bin`);
});

t("A4 home 이 비면 PATH 그대로", () => {
  assert.equal(withUserBinDirs(SYS, ""), SYS);
});

t("A5 PATH 가 비었거나 없으면 사용자 몫 폴더만", () => {
  assert.equal(withUserBinDirs("", H), ALL);
  assert.equal(withUserBinDirs(undefined, H), ALL);
});

t("A6 원래 항목이 앞에 그대로 — 시스템에 같은 이름이 있으면 그것이 이긴다", () => {
  assert.deepEqual(withUserBinDirs(SYS, H).split(":").slice(0, 3), SYS.split(":"));
});

t("A7 빈 칸(`::`·끝 `:`)의 뜻을 바꾸지 않는다 — 원래 문자열을 손대지 않는다", () => {
  assert.equal(withUserBinDirs("/usr/bin::/bin:", H), `/usr/bin::/bin::${ALL}`);
});

t("A8 붙일 게 없으면 입력과 같다", () => {
  const full = `${SYS}:${ALL}`;
  assert.equal(withUserBinDirs(full, H), full);
});

// ── 세 벌의 목록이 어긋나지 않는다 — TS 상수 · 세션 계약(session-env.sh ②) · 서비스 유닛 템플릿(common.sh) ──
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
t("A11 세 벌(TS 상수 · 세션 계약 · 유닛 템플릿)이 같은 셋 · 같은 순서다", () => {
  const env = readFileSync(path.join(ROOT, "deploy", "linux", "session-env.sh"), "utf8");
  const want = USER_BIN_DIRS.map((d) => `$_home/${d}`).join(":");
  assert.ok(env.includes(`export PATH="${want}:`), `세션 계약 PATH 가 ${want} 로 시작하지 않는다`);
  const common = readFileSync(path.join(ROOT, "deploy", "lib", "common.sh"), "utf8");
  const lines = common.split("\n").filter((l) => l.includes("s#@PATH@#"));
  assert.equal(lines.length, 3, "유닛 템플릿 PATH 줄을 못 찾았다(리눅스 둘 · 맥 하나) — 검사가 헛돈다");
  for (const l of lines) {
    const home = l.includes("$svc_home") ? "$svc_home" : "$HOME";
    assert.ok(l.includes(`${USER_BIN_DIRS.map((d) => `${home}/${d}`).join(":")}#g`), `템플릿 끝이 세션 계약 순서가 아니다: ${l.trim().slice(0, 80)}…`);
  }
});

// ── 부팅 모듈 — 실제로 import 해 PATH 를 본다(자식 프로세스: 이 프로세스의 PATH 를 건드리지 않게) ──
const BOOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "boot", "user-bin-path.js");
const tmp = mkdtempSync(path.join(os.tmpdir(), "ubp-"));
const bootPath = (env: Record<string, string>): string => execFileSync(process.execPath,
  ["--input-type=module", "-e", `await import(${JSON.stringify(BOOT)}); process.stdout.write(process.env.PATH || "")`],
  { env: { HOME: tmp, PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });

t("A9 세션 경계 중계가 있는 배포(매니지드)는 PATH 를 안 바꾼다", () => {
  assert.equal(bootPath({ LIVELY_SESSION_EXEC: "/bin/true {slug}" }), "/usr/bin:/bin");
});

t("A10 셀프호스트는 홈의 사용자 몫 폴더를 잇는다(배선 — 부팅 모듈이 실제로 고친다)", () => {
  if (process.platform === "win32") return;
  assert.equal(bootPath({}), `/usr/bin:/bin:${tmp}/.local/bin:${tmp}/.npm-global/bin:${tmp}/.lively/bin`);
});
rmSync(tmp, { recursive: true, force: true });

console.log(`user-bin-path.test: ${pass} ok`);

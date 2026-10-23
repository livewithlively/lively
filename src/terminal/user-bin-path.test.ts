// 셀프호스트 게이트웨이 PATH 에 사용자 몫 프로그램 폴더를 잇는다(#4970) — 사양·엣지 표: 스크래치패드 spec-ai-step.md §A.
//  실측 사고: 위시스트 박스에서 claude 가 /home/lively/.local/bin 에만 있고 게이트웨이 PATH 로는 못 찾았다(세션·화면 안 로그인·설치 확인 전부).
//  실행: npm run build && node dist/terminal/user-bin-path.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withUserBinDirs, USER_BIN_DIRS } from "./user-bin-path.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const H = "/home/lively";
const all = (p: string): boolean => p.startsWith(`${H}/`);
const none = (): boolean => false;
const SYS = "/usr/bin:/usr/local/bin:/bin";

t("A1 세 폴더가 있으면 원래 PATH 뒤에 세션 계약 순서로 붙는다", () => {
  assert.equal(withUserBinDirs(SYS, H, all), `${SYS}:${H}/.local/bin:${H}/.npm-global/bin:${H}/.lively/bin`);
  assert.deepEqual([...USER_BIN_DIRS], [".local/bin", ".npm-global/bin", ".lively/bin"], "세션 계약(session-env.sh ②)과 같은 셋·순서");
});

t("A2 이미 들어 있는 폴더는 다시 넣지 않는다(서비스 PATH 끝의 ~/.npm-global/bin)", () => {
  const p = `${SYS}:${H}/.npm-global/bin`;
  assert.equal(withUserBinDirs(p, H, all), `${p}:${H}/.local/bin:${H}/.lively/bin`);
});

t("A3 없는 폴더는 붙이지 않는다", () => {
  const onlyLocal = (d: string): boolean => d === `${H}/.local/bin`;
  assert.equal(withUserBinDirs(SYS, H, onlyLocal), `${SYS}:${H}/.local/bin`);
});

t("A4 home 이 비면 PATH 그대로", () => {
  assert.equal(withUserBinDirs(SYS, "", all), SYS);
});

t("A5 PATH 가 비었거나 없으면 있는 폴더만", () => {
  assert.equal(withUserBinDirs("", H, all), `${H}/.local/bin:${H}/.npm-global/bin:${H}/.lively/bin`);
  assert.equal(withUserBinDirs(undefined, H, (d) => d === `${H}/.lively/bin`), `${H}/.lively/bin`);
});

t("A6 원래 항목이 앞에 그대로 — 시스템에 같은 이름이 있으면 그것이 이긴다", () => {
  const out = withUserBinDirs(SYS, H, all).split(":");
  assert.deepEqual(out.slice(0, 3), SYS.split(":"));
});

t("A7 빈 칸(`::`·끝 `:`)의 뜻을 바꾸지 않는다 — 원래 문자열을 손대지 않는다", () => {
  assert.equal(withUserBinDirs("/usr/bin::/bin:", H, (d) => d === `${H}/.local/bin`), `/usr/bin::/bin::${H}/.local/bin`);
});

t("A8 붙일 게 없으면 입력과 같다", () => {
  assert.equal(withUserBinDirs(SYS, H, none), SYS);
  const full = `${SYS}:${H}/.local/bin:${H}/.npm-global/bin:${H}/.lively/bin`;
  assert.equal(withUserBinDirs(full, H, all), full);
});

// ── 부팅 모듈 — 실제로 import 해 PATH 를 본다(자식 프로세스: 이 프로세스의 PATH 를 건드리지 않게) ──
const BOOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "boot", "user-bin-path.js");
const tmp = mkdtempSync(path.join(os.tmpdir(), "ubp-"));
mkdirSync(path.join(tmp, ".local", "bin"), { recursive: true });
const bootPath = (env: Record<string, string>): string => execFileSync(process.execPath,
  ["--input-type=module", "-e", `await import(${JSON.stringify(BOOT)}); process.stdout.write(process.env.PATH || "")`],
  { env: { HOME: tmp, PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });

t("A9 세션 경계 중계가 있는 배포(매니지드)는 PATH 를 안 바꾼다", () => {
  assert.equal(bootPath({ LIVELY_SESSION_EXEC: "/bin/true {slug}" }), "/usr/bin:/bin");
});

t("A10 셀프호스트는 홈의 ~/.local/bin 을 잇는다(배선 — 부팅 모듈이 실제로 고친다)", () => {
  if (process.platform === "win32") return;
  assert.equal(bootPath({}), `/usr/bin:/bin:${tmp}/.local/bin`);
});
rmSync(tmp, { recursive: true, force: true });

console.log(`user-bin-path.test: ${pass} ok`);

// #2255 — 하네스 자동 설치. 사양 엣지 표 20행 → 행마다 단언 1개 이상.
//
//  ── 무엇이 잘못됐었나 (구멍 셋) ──
//  ① **윈도우는 자동 설치가 없었다.** 근거 주석은 "Windows 엔 sh 가 없다" 였는데, 필요한 건 sh 가 아니라
//     PowerShell 이었다 — 5종 중 4종이 공식 .ps1 설치기를 갖고 있다(2026-08-28 실측, 전부 200). 안내만 하면
//     사람이 브라우저에 나갔다 돌아와 명령을 **한 번 더** 쳐야 한다.
//  ② **5종 중 claude 하나만** 제안했고, 조건이 `if (!harnesses.length)` 라 「둘 다 없을 때만」 물었다 —
//     codex 만 있는 사람이 claude 를 쓰겠다고 해도 아무도 안 물었다.
//  ③ 온보딩이 고른 LLM 이 설치로 이어지지 않았다(그건 web/desktop 쪽 변경).
//
//  🔴 이 코드가 하는 일은 **남의 기계에 소프트웨어를 까는 것**이다. 그래서 아래가 지키는 사실은 둘이다:
//   · 무엇을 까는지 표가 정확히 말한다(오타를 claude 로 폴백하지 않는다 — E8).
//   · 성공을 성공이라고만 말한다(설치기가 0 으로 끝나도 bin 이 없으면 실패다 — E18).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const HERE = join(fileURLToPath(import.meta.url), "..");
const { installTarget } = await import(pathToFileURL(join(HERE, "lively.mjs")));
const { installPlanFor, HARNESS_IDS } =
  await import(pathToFileURL(join(HERE, "..", "hooks", "harness-registry.mjs")));

const plan = (id, platform, extra = {}) =>
  installPlanFor(id, { platform, homeDir: "/h", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ...extra } });

// ── A. 무엇을 깔지 고르는 규칙 (E1~E7) — 구멍 ② 의 자리 ────────────────────
test("E1 안 골랐고 하네스가 있으면 아무것도 묻지 않는다", () => {
  assert.equal(installTarget("", ["claude"]), "");
});
test("E2 안 골랐고 하네스가 하나도 없으면 claude (종전 규약 보존)", () => {
  assert.equal(installTarget("", []), "claude");
});
test("E3 고른 것이 이미 있으면 묻지 않는다", () => {
  assert.equal(installTarget("claude", ["claude", "codex"]), "");
});
test("E4 codex 만 있는 사람이 claude 를 고르면 묻는다 ← 구멍 ②", () => {
  assert.equal(installTarget("claude", ["codex"]), "claude",
    "종전 조건(!harnesses.length)이면 여기서 \"\" 가 나와 영영 안 물었다");
});
test("E5 고른 것이 claude 가 아니어도 그대로 존중한다", () => {
  assert.equal(installTarget("grok", []), "grok");
});
test("E6 대소문자·공백을 정규화한다", () => {
  assert.equal(installTarget("  CLAUDE \n", []), "claude");
});
test("E7 모르는 이름도 선택 단계에선 통과한다(거르는 건 표의 일)", () => {
  assert.equal(installTarget("claud", []), "claud");
});

// ── B. 표가 무엇을 까는지 말한다 (E8~E17) ──────────────────────────────────
test("E8 모르는 하네스는 null — claude 로 폴백하지 않는다", () => {
  assert.equal(plan("claud", "darwin"), null,
    "표 조회(harness())는 모르는 id 를 claude 로 접는다. 설치에서 그러면 엉뚱한 걸 깐다");
});
test("E9 윈도우 claude 는 PowerShell 설치기 ← 구멍 ①", () => {
  const p = plan("claude", "win32");
  assert.equal(p.shell, "powershell");
  assert.ok(p.cmd.includes("install.ps1"), p.cmd);
  assert.ok(!/\bsh\b|bash/.test(p.cmd), "sh 를 부르면 윈도우에서 조용히 실패한다");
});
test("E10 POSIX claude 는 sh + rc 는 우리가 심는다", () => {
  const p = plan("claude", "darwin");
  assert.equal(p.shell, "sh");
  assert.ok(p.cmd.includes("install.sh"));
  assert.equal(p.wiresPath, false, "claude 설치기는 PATH 영속화를 사용자에게 떠넘긴다(실측)");
});
test("E11 codex 는 양 OS 다 CODEX_NON_INTERACTIVE=1 — 없으면 무인 설치가 아니다", () => {
  for (const os of ["darwin", "win32"]) {
    assert.equal(plan("codex", os).env?.CODEX_NON_INTERACTIVE, "1",
      `${os}: codex 설치기는 끝에서 "Start Codex now?" 를 묻는다(실측 install.sh:888)`);
  }
});
test("E12 윈도우 opencode 는 npm 이 선행조건이다", () => {
  const p = plan("opencode", "win32");
  assert.equal(p.requires, "npm", "opencode.ai/install.ps1 은 404 다 — 공급사가 안 준다(실측)");
});
test("E13 POSIX opencode 는 선행조건 없이 자기 스크립트로 깐다", () => {
  const p = plan("opencode", "darwin");
  assert.equal(p.requires, null);
  assert.equal(p.binDir, "/h/.opencode/bin");
});
test("E14 윈도우 antigravity 자리는 LOCALAPPDATA 기준이다", () => {
  //  ⚠ 표는 **실행 중인 호스트**의 구분자로 잇는다(레지스트리 SEP) — 맥에서 win32 계획을 뽑으면 `/` 가 섞인다.
  //   검증하려는 건 구분자가 아니라 **경로 구성**이라 정규화해서 본다(harness-registry.test.mjs 와 같은 규약).
  const norm = (p) => String(p).replace(/\\/g, "/");
  assert.equal(norm(plan("antigravity", "win32").binDir), "C:/Users/u/AppData/Local/agy/bin");
  assert.equal(norm(plan("antigravity", "darwin").binDir), "/h/.local/bin");
  // LOCALAPPDATA 가 없는 환경(원격 셸 등)이면 홈 기준으로 접는다 — 조용히 undefined 를 잇지 않는다.
  const noEnv = installPlanFor("antigravity", { platform: "win32", homeDir: "/h", env: {} });
  assert.equal(norm(noEnv.binDir), "/h/AppData/Local/agy/bin");
});
test("E15 무결성 검증이 없는 칸은 없다고 적는다(정직 표기)", () => {
  assert.equal(plan("grok", "darwin").integrity, null, "x.ai 설치기는 체크섬을 안 본다(실측)");
  assert.equal(plan("claude", "darwin").integrity, "sha256");
  assert.equal(plan("antigravity", "darwin").integrity, "sha512");
});
test("E16 5종 × 2 OS 전 칸이 https 로만 나간다", () => {
  const holes = [];
  for (const id of HARNESS_IDS) for (const os of ["darwin", "win32"]) {
    const p = plan(id, os);
    if (!p.cmd) { holes.push(`${id}/${os}: 설치 경로 없음`); continue; }
    // 평문 http 로 스크립트를 받아 실행하면 중간자가 남의 기계에서 임의 코드를 돌린다.
    for (const m of p.cmd.match(/https?:\/\/\S+/g) || []) if (!m.startsWith("https://")) holes.push(`${id}/${os}: ${m}`);
  }
  assert.deepEqual(holes, []);
});
test("E17 설치기가 PATH 를 안 심는 칸은 반드시 binDir 을 안다", () => {
  const holes = [];
  for (const id of HARNESS_IDS) for (const os of ["darwin", "win32"]) {
    const p = plan(id, os);
    if (p.cmd && !p.wiresPath && !p.binDir) holes.push(`${id}/${os}`);   // 심을 자리를 모르면 못 심는다
  }
  assert.deepEqual(holes, []);
});

// ── C. 호출부 계약 (E18~E20) — 순수 함수로 못 보는 자리는 소스 형태로 못박는다 ──
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CLI = code(readFileSync(join(HERE, "lively.mjs"), "utf8"));

test("E18 설치기가 0 으로 끝나도 bin 이 없으면 실패로 말한다", () => {
  assert.ok(/function probeHarness\(bin\)/.test(CLI), "부작용 확인 함수가 없다");
  assert.ok(/const ver = probeHarness\(plan\.bin\);\s*if \(!ver\) \{/.test(CLI),
    "종료코드만 보고 '설치 완료' 라고 말하면 반쪽 설치를 성공이라 부르게 된다");
});
test("E19 표를 못 읽는 구 번들에서도 죽지 않고 안내로 떨어진다", () => {
  assert.ok(/if \(!reg\) \{ warn\(/.test(CLI), "레지스트리 부재를 안 다룬다");
  assert.ok(/typeof m\?\.installPlanFor === "function"/.test(CLI),
    "구 번들엔 install 축이 없다 — 존재만 보고 채택하면 그 자리에서 TypeError 다");
});
test("E20 윈도우 설치기는 **자식 프로세스**로 돌린다(사용자 세션에 iex 하지 않는다)", () => {
  assert.ok(/"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", plan\.cmd/.test(CLI),
    "남의 프로필을 태우거나 실행정책에 걸리면 조용히 아무 일도 안 일어난다");
  assert.ok(/has\("pwsh"\) \? "pwsh" : "powershell"/.test(CLI), "pwsh 우선 · 없으면 내장 powershell");
});

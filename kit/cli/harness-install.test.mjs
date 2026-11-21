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
const { installTarget, launchNames } = await import(pathToFileURL(join(HERE, "lively.mjs")));
const { installPlanFor, HARNESS_IDS } =
  await import(pathToFileURL(join(HERE, "..", "hooks", "harness-registry.mjs")));

const plan = (id, platform, extra = {}) =>
  installPlanFor(id, { platform, homeDir: "/h", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ...extra } });

// 경로 단언은 **구분자를 정규화해서** 비교한다 — 표는 «실행 중인 호스트»의 구분자로 잇는다(레지스트리 SEP).
//  맥에서 win32 계획을 뽑으면 `/` 가, 윈도우 CI 에서 darwin 계획을 뽑으면 `\` 가 섞인다. 검증하려는 건
//  구분자가 아니라 **경로 구성**이다. (harness-registry.test.mjs 가 #1510 를 근거로 못박은 같은 규약 —
//  안 지키면 «윈도우에서만 전부 빨간불» 이 되고, 그 플랫폼 실패가 가장 늦게 발견된다.)
const norm = (p) => String(p).replace(/\\/g, "/");

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
  assert.equal(norm(p.binDir), "/h/.opencode/bin");
});
test("E14 윈도우 antigravity 자리는 LOCALAPPDATA 기준이다", () => {
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
  //  #5650 — 설치 루프는 probe 를 주입받는다(테스트가 공급사 설치기를 안 돌리게). 기본값이 probeHarness 여야 한다.
  assert.ok(/probe = probeHarness/.test(CLI), "설치 루프의 기본 판정이 probeHarness 가 아니다");
  assert.ok(/const ver = probe\(plan\.bin\);\s*if \(!ver\) \{/.test(CLI),
    "종료코드만 보고 '설치 완료' 라고 말하면 반쪽 설치를 성공이라 부르게 된다");
});
test("E19 표를 못 읽는 구 번들에서도 죽지 않고 안내로 떨어진다", () => {
  assert.ok(/if \(!reg\) \{\s*warn\(/.test(CLI), "레지스트리 부재를 안 다룬다");
  assert.ok(/typeof m\?\.installPlanFor === "function"/.test(CLI),
    "구 번들엔 install 축이 없다 — 존재만 보고 채택하면 그 자리에서 TypeError 다");
});
test("E20 윈도우 설치기는 **자식 프로세스**로 돌린다(사용자 세션에 iex 하지 않는다)", () => {
  assert.ok(/"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", plan\.cmd/.test(CLI),
    "남의 프로필을 태우거나 실행정책에 걸리면 조용히 아무 일도 안 일어난다");
  assert.ok(/has\("pwsh"\) \? "pwsh" : "powershell"/.test(CLI), "pwsh 우선 · 없으면 내장 powershell");
});

//  #4927 격리 리뷰 — 설치 끝 안내가 claude(+codex)로 고정이라 Cursor·grok 만 쓰는 사람에게 «claude 를 켜면» 이라고 말했다.
test("E21 설치 끝 안내는 배선한 하네스를 켜는 이름으로 말한다(비면 claude)", () => {
  assert.deepEqual(launchNames(["cursor"]), ["Cursor"]);
  assert.deepEqual(launchNames(["claude", "codex", "antigravity"]), ["claude", "codex", "agy"]);
  assert.deepEqual(launchNames([]), ["claude"], "종전 규약 — 아무것도 없으면 claude");
  assert.deepEqual(launchNames(["newharness"]), ["newharness"], "모르는 id 는 그대로(지우지 않는다)");
});

// ── D. 여러 하네스를 한 번에 (#5650) — 데스크톱 앱이 `lively install --harness a,b,c --only --yes --json-events` 로 부른다 ──
//  지키는 사실: 쉼표 목록을 받는다 · 모르는 id 는 경고하고 건너뛴다(claude 로 접지 않는다) · 하나만 주면 종전과 같다 ·
//   --only 는 고른 것만 배선한다 · --yes 는 묻지 않는다 · 하나가 실패해도 다음 도구를 계속 깐다(이유는 fail step 에).
const M = await import(pathToFileURL(join(HERE, "lively.mjs")));
const KNOWN = ["claude", "codex", "opencode", "antigravity", "grok", "cursor"];

test("M1 쉼표 목록을 순서대로 · 중복 없이 · 소문자로 정규화한다", () => {
  assert.deepEqual(M.parseHarnessList(" Claude, codex,,cursor ,CODEX", KNOWN), { ids: ["claude", "codex", "cursor"], unknown: [] });
});
test("M2 모르는 id 는 따로 모은다(claude 로 접지 않는다)", () => {
  assert.deepEqual(M.parseHarnessList("claude,claud,cursor", KNOWN), { ids: ["claude", "cursor"], unknown: ["claud"] });
});
test("M3 설치할 것 = 고른 것 중 이 컴퓨터에 없는 것(고른 순서 그대로)", () => {
  const p = M.planHarnessInstalls("cursor,claude,codex", ["codex"], { known: KNOWN });
  assert.deepEqual(p.toInstall, ["cursor", "claude"]);
  assert.deepEqual(p.present, ["codex"]);
  assert.deepEqual(p.unknown, []);
});
test("M4 하나만 주면 installTarget 과 같은 답(종전 동작 보존)", () => {
  for (const [w, d] of [["", []], ["", ["codex"]], ["claude", []], ["claude", ["claude"]], ["claude", ["codex"]], ["grok", []], ["  CURSOR ", ["claude"]]]) {
    assert.deepEqual(M.planHarnessInstalls(w, d, { known: KNOWN }).toInstall, [installTarget(w, d)].filter(Boolean), JSON.stringify([w, d]));
  }
});
test("M5 모르는 것만 주면 아무것도 깔지 않는다(종전 규약의 claude 로도 떨어지지 않는다)", () => {
  const p = M.planHarnessInstalls("claud", [], { known: KNOWN });
  assert.deepEqual(p.toInstall, []);
  assert.deepEqual(p.unknown, ["claud"]);
});
test("M6 --only: 고른 것만 배선한다(설치 뒤 있는 것과의 교집합)", () => {
  assert.deepEqual(M.wireTargets(["claude", "codex", "grok"], "claude,cursor", true), ["claude"]);
});
test("M7 --only 가 없으면 있는 것 전부를 배선한다(종전)", () => {
  assert.deepEqual(M.wireTargets(["claude", "codex", "grok"], "claude,cursor", false), ["claude", "codex", "grok"]);
});
test("M8 --only 인데 --harness 를 안 줬으면 거르지 않는다", () => {
  assert.deepEqual(M.wireTargets(["claude", "codex"], "", true), ["claude", "codex"]);
});
test("M9 --only 교집합이 비면 빈 목록(호출부가 «하네스 없이 진행» 폴백을 탄다)", () => {
  assert.deepEqual(M.wireTargets(["codex"], "cursor", true), []);
});

// 설치 실행 — 공급사 설치기는 절대 돌리지 않는다(exec·probe·ask·hasBin 을 전부 주입).
const fakeReg = {
  installPlanFor: (id) => id === "nope" ? null : ({
    id, label: id.toUpperCase(), bin: `${id}-bin`, wiresPath: true, binDir: null, integrity: null,
    cmd: id === "blocked" ? null : `echo ${id}`, requires: id === "npmtool" ? "npm" : null, docs: `https://docs.example/${id}`,
  }),
};
const harnessDeps = (over = {}) => {
  const steps = [], asks = [], execs = [];
  const deps = {
    reg: fakeReg, yes: false,
    ask: async (label) => { asks.push(label); return true; },
    exec: (plan) => { execs.push(plan.id); return { code: 0 }; },
    probe: (bin) => `${bin} 1.0`,
    hasBin: () => true,
    step: (id, label, status, extra) => steps.push({ id, label, status, ...(extra || {}) }),
    ...over,
  };
  return { deps, steps, asks, execs };
};

test("M10 --yes 면 하나도 묻지 않고 전부 깐다", async () => {
  const { deps, asks, execs, steps } = harnessDeps({ yes: true });
  const r = await M.installHarnesses({ toInstall: ["claude", "cursor"] }, deps);
  assert.equal(asks.length, 0, "--yes 인데 물었다 — 앱(--json-events)에선 확인 카드가 도구마다 뜬다");
  assert.deepEqual(execs, ["claude", "cursor"]);
  assert.deepEqual(r.installed, ["claude", "cursor"]);
  assert.deepEqual(steps.map((s) => `${s.id}:${s.status}`),
    ["harness-install:claude:start", "harness-install:claude:done", "harness-install:cursor:start", "harness-install:cursor:done"]);
  assert.equal(steps[0].label, "CLAUDE 설치");
});
test("M11 --yes 가 없으면 도구마다 묻고, 아니오는 건너뛰고 다음으로 간다", async () => {
  const { deps, asks, execs, steps } = harnessDeps({ ask: async (l) => { asks.push(l); return asks.length > 1; } });
  const r = await M.installHarnesses({ toInstall: ["claude", "cursor"] }, deps);
  assert.equal(asks.length, 2);
  assert.deepEqual(execs, ["cursor"]);
  assert.deepEqual(r.installed, ["cursor"]);
  const f = steps.find((s) => s.id === "harness-install:claude" && s.status === "fail");
  assert.ok(f && f.reason && f.declined === true, JSON.stringify(steps));
});
test("M12 하나가 실패해도 다음 도구를 계속 깔고, 실패마다 이유를 fail step 에 싣는다", async () => {
  const { deps, execs, steps } = harnessDeps({
    yes: true,
    hasBin: (b) => b !== "npm",
    probe: (bin) => ["ghost-bin", "boom-bin"].includes(bin) ? null : `${bin} 1.0`,   // ghost: 설치기는 돌았는데 실행 파일이 없다 · boom: 설치기가 못 떴다
    exec: (plan) => { if (plan.id === "boom") throw new Error("spawn EACCES"); execs.push(plan.id); return { code: 0 }; },
  });
  const r = await M.installHarnesses({ toInstall: ["blocked", "npmtool", "ghost", "boom", "nope", "claude"] }, deps);
  assert.deepEqual(r.installed, ["claude"], "실패 하나가 나머지를 멈추면 안 된다");
  assert.deepEqual(r.failed.map((x) => x.id), ["blocked", "npmtool", "ghost", "boom", "nope"]);
  for (const id of ["blocked", "npmtool", "ghost", "boom", "nope"]) {
    const f = steps.find((s) => s.id === `harness-install:${id}` && s.status === "fail");
    assert.ok(f && typeof f.reason === "string" && f.reason, `${id}: fail step 에 이유가 없다 ${JSON.stringify(steps)}`);
    assert.ok(!f.reason.includes("—"), `${id}: 새 문구에 em-dash`);
  }
  assert.equal(steps.find((s) => s.id === "harness-install:blocked" && s.status === "fail").docs, "https://docs.example/blocked");
  assert.ok(steps.some((s) => s.id === "harness-install:claude" && s.status === "done"));
});
test("M13 이미 있는 것은 done(present) · 모르는 것은 fail 로 알린다(앱이 고른 도구마다 상태를 그린다)", async () => {
  const { deps, steps, execs } = harnessDeps({ yes: true });
  await M.installHarnesses({ toInstall: [], present: ["codex"], unknown: ["claud"] }, deps);
  assert.deepEqual(execs, []);
  assert.ok(steps.some((s) => s.id === "harness-install:codex" && s.status === "done" && s.present === true), JSON.stringify(steps));
  assert.ok(steps.some((s) => s.id === "harness-install:claud" && s.status === "fail" && s.reason), JSON.stringify(steps));
});
test("M14 표를 못 읽으면(구 번들) 도구마다 fail 로 떨어지고 죽지 않는다", async () => {
  const { deps, steps } = harnessDeps({ yes: true, reg: null });
  const r = await M.installHarnesses({ toInstall: ["claude", "cursor"] }, deps);
  assert.deepEqual(r.installed, []);
  assert.equal(steps.filter((s) => s.status === "fail").length, 2);
});
test("M15 --only · --yes 를 파서가 받는다(install 에 모르는 옵션으로 거절되지 않게)", () => {
  const o = M.parse(["install", "--harness", "claude,codex,cursor", "--only", "--yes", "--json-events"]);
  assert.equal(o.harness, "claude,codex,cursor");
  assert.equal(o.only, true);
  assert.equal(o.yes, true);
  assert.deepEqual(o._, ["install"]);
});
test("M16 status --json 이 지원 능력(caps)을 싣는다 — 구 CLI 는 이 칸이 없다", () => {
  assert.ok(Array.isArray(M.CLI_CAPS));
  assert.ok(M.CLI_CAPS.includes("install-multi") && M.CLI_CAPS.includes("work-root-add"));
  assert.ok(/caps: CLI_CAPS/.test(CLI), "gatherStatus 가 caps 를 싣지 않는다");
});

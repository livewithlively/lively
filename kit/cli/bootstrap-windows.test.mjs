#!/usr/bin/env node
// Windows 부트스트랩(bootstrap.ps1) **실행 계약** 회귀테스트 (#1087).
//
//  이 파일은 POSIX CI 에서 **한 줄도 실행되지 않는다**(PowerShell 부재). 짝인 bootstrap-node-gate.test.mjs 는
//  win32 에서 skip 하므로 bootstrap.ps1 의 자동 검증은 **0 이었고**, 그래서 아래 두 사고가 배포까지 갔다:
//    ① `exit` 로 중단 → `irm | iex` 는 사용자 세션에서 도니까 **사용자 창이 닫히고 에러가 증발**했다.
//       (실측: `iex 'Write-Host A; exit 3'` → A 만 찍히고 세션 종료. 사용자는 "갑자기 창이 닫혔다"만 안다.)
//    ② node 를 `-p 'x.split(".")[0]'` 로 불러 버전 판정 → PS 5.1 이 인자 안의 `"` 를 안 넘겨
//       node 가 `split(.)` 를 받고 SyntaxError → **멀쩡한 Node 를 '못 씀'으로 판정**(v22.15.0 실측).
//       매 실행 30MB 재다운로드 + "Node 20 미만" 이라는 거짓 안내.
//
//  → 레포 관례(lively.test.mjs ⑪ 심 동일성 = 정적 비교)를 따라 **언어 수준 제약을 텍스트로 못박는다.**
//    실행 검증이 불가능한 표면에서 이게 유일하게 가능한 방어선이다.
//  실행: node kit/cli/bootstrap-windows.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why || "조건 불만족"));

const HERE = join(fileURLToPath(import.meta.url), "..");
const PS1 = readFileSync(join(HERE, "bootstrap.ps1"), "utf8");
const MJS = readFileSync(join(HERE, "lively.mjs"), "utf8");

// ── 주석·here-string 을 걷어낸 "실제 PowerShell 코드"만 남긴다 ────────────────
//  · here-string(@'…'@)은 .cmd 심 **본문**이다 — 그 안의 `exit /b` 는 cmd.exe 코드지 PowerShell 이 아니다.
//    (표 ④ 오탐 금지: 이걸 안 걷어내면 올바른 파일이 빨간불이 된다.)
//  · 주석은 이 사고를 설명하느라 `exit`·`split(".")` 같은 문구를 일부러 담고 있다 → 반드시 제외.
const ps1Code = PS1
  .replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "\n<<HERESTRING>>\n")   // here-string 통째로
  .split("\n").map((l) => l.replace(/^\s*#.*$/, "")).join("\n"); // 줄 전체가 주석인 줄

// ① P1 — PowerShell `exit` 금지 (사용자 창이 닫힌다)
{
  const hits = ps1Code.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(^|[;{}\s])exit(\s|$)/.test(l));
  check("① bootstrap.ps1 에 PowerShell `exit` 가 없다 (irm|iex = 사용자 세션 → 창이 닫힌다)",
    hits.length === 0,
    `발견: ${hits.map(([n, l]) => `${n}행 "${l.trim()}"`).join(" / ")} — 중단은 throw 또는 top-level return 으로`);
}

// ①-b 오탐 금지: .cmd 심 안의 `exit /b` 는 살아 있어야 한다(걷어내기가 과하면 계약이 헐거워진다)
check("① (오탐 금지) .cmd 심 본문의 `exit /b` 는 그대로 존재한다",
  /exit \/b/.test(PS1), "심 본문이 사라졌거나 here-string 추출이 어긋났다");

// ①-c 중단 수단이 실제로 배선돼 있는가 — 계약을 '금지'만 하고 대안이 없으면 다음 사람이 exit 로 돌아간다
check("① 중단 수단이 있다 — PipelineStoppedException",
  /PipelineStoppedException/.test(ps1Code), "Die 가 무엇으로 중단하는지 불명");

// ② P2 — node 를 eval(-p/-e)로 부르지 않는다
{
  const evals = ps1Code.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => /&\s*\$\w+\s+-[pe]\b/.test(l));
  check("② node 를 eval(-p/-e)로 부르지 않는다 (PS 5.1 이 인자 안의 \" 를 못 넘긴다)",
    evals.length === 0,
    `발견: ${evals.map(([n, l]) => `${n}행 "${l.trim()}"`).join(" / ")} — 버전 판정은 인자 없는 -v 로`);
}

// ③ P2 — 작은따옴표 리터럴 안에 `"` 가 없다 (그게 네이티브 인자로 나가면 벗겨진다)
{
  const hits = ps1Code.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => (l.match(/'[^']*'/g) || []).some((q) => q.includes('"')));
  check("③ 작은따옴표 리터럴에 큰따옴표가 없다 (PS 5.1 네이티브 인자 이스케이프 불가)",
    hits.length === 0,
    `발견: ${hits.map(([n, l]) => `${n}행 "${l.trim()}"`).join(" / ")}`);
}

// ④ P3 + 새 헬퍼 — 버전 판정이 `-v` 경로를 쓰고, 못 읽음을 '구버전'으로 단정하지 않는다
check("④ 버전 판정이 `node -v` 를 쓴다", /&\s*\$exe\s+-v\b/.test(ps1Code), "Get-NodeMajor 가 -v 로 읽지 않는다");
check("④ 판정 불가와 구버전을 구분해 안내한다", /버전 확인 실패/.test(PS1),
  "Say-OldSysNode 가 못 읽은 경우에도 '미만'이라 단정하고 있다");

// ⑤ mjs — 셸 재적용 안내가 플랫폼 분기다 (윈도우에 `source ~/.zshrc` 안내 금지)
{
  const code = MJS.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n"); // 줄 주석 제외
  const hard = code.split("\n").map((l, i) => [i + 1, l])
    .filter(([, l]) => /source ~\/\.zshrc/.test(l) && !/RELOAD_SHELL_HINT\s*=/.test(l));
  check("⑤ lively.mjs 에 `source ~/.zshrc` 하드코딩이 없다 (윈도우에서 실행 불가한 안내)",
    hard.length === 0,
    `발견: ${hard.map(([n]) => `${n}행`).join(" / ")} — RELOAD_SHELL_HINT 를 쓸 것`);
  check("⑤ 분기 상수가 윈도우 분기를 갖는다",
    /RELOAD_SHELL_HINT\s*=\s*WIN\s*\?/.test(code), "RELOAD_SHELL_HINT 가 플랫폼 분기가 아니다");
}

// ⑥ mjs — setup 은 토큰의 **존재**가 아니라 **수용 여부**로 로그인을 건너뛴다
check("⑥ cmdSetup 이 토큰 유효성을 확인한다 (존재만 보면 401 로 [1/3] 에서 죽는다)",
  /tokenAccepted\(gateway\(\), token\(\)\)/.test(MJS) && !/if \(token\(\) && gateway\(\)\) info\("이미 로그인/.test(MJS),
  "존재 검사(token() && gateway())로 되돌아갔다");

// ── 보너스: pwsh 가 있으면 **실제로 실행**한다 (없으면 조용히 건너뜀 — POSIX CI 가 정상 경로) ──
//  정적 단언은 "코드가 그렇게 생겼나"까지만 본다. pwsh 가 있는 곳에선 한 걸음 더 가서 **그렇게 동작하나**를 본다.
//  이 파일이 사고를 낸 근본 이유가 '실행 커버리지 0' 이었으므로, 실행할 수 있는 곳에선 반드시 실행한다.
{
  const pwsh = (process.env.PATH || "").split(":").map((d) => join(d, "pwsh")).find((p) => existsSync(p));
  if (!pwsh) console.log("skip ⑦⑧ 실제 PowerShell 실행 검사 — pwsh 없음(POSIX CI 정상)");
  else {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const ps1Path = join(HERE, "bootstrap.ps1");

    // ⑦ 파서 통과 — BOM·따옴표·괄호 등 문법 사고 전반의 그물
    const parse = `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseInput((Get-Content -Raw '${ps1Path}'),[ref]$t,[ref]$e)|Out-Null;$e.Count`;
    const pr = spawnSync(pwsh, ["-NoProfile", "-Command", parse], { encoding: "utf8" });
    check("⑦ PowerShell 파서 통과(파스 에러 0)", pr.stdout.trim() === "0", `에러 ${pr.stdout.trim()}건 / ${pr.stderr}`);

    // ⑧ 버전 게이트를 **실제 코드 그대로** 떼어내 스텁 node 로 돌린다(사본 재작성 아님 — 드리프트 불가).
    //   ⚠ 경계값 행(정확히 최소 major)을 반드시 포함한다 — `>` vs `>=` 오프바이원은 그 행이 없으면 안 잡힌다.
    //   ⚠ "판정 자체가 실패하는 node" 행도 포함 — #1087 이 정확히 그 경로였다(그때는 '구버전'으로 오분류됐다).
    const box = mkdtempSync(join(tmpdir(), "lively-nodegate-"));
    const stub = (name, ver) => {
      const p = join(box, name);
      writeFileSync(p, ver ? `#!/bin/sh\n[ "$1" = "-v" ] && echo ${ver} && exit 0\nexit 1\n` : `#!/bin/sh\necho boom >&2\nexit 1\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const cases = [
      ["v22.15.0 (현장 실측 — 옛 코드가 '20 미만'이라 오판한 바로 그 버전)", stub("n-new", "v22.15.0"), "True"],
      ["v16.20.2 (진짜 구버전)", stub("n-old", "v16.20.2"), "False"],
      ["v20.0.0 (경계 = 정확히 최소)", stub("n-exact", "v20.0.0"), "True"],
      ["버전을 못 내놓는 node", stub("n-broken", null), "False"],
      ["존재하지 않는 경로", join(box, "n-missing"), "False"],
    ];
    const driver = join(box, "drive.ps1");
    writeFileSync(driver, [
      `$src = Get-Content -Raw '${ps1Path}'`,
      // 부트스트랩에서 판정 함수 2개만 떼어내 **그대로** 실행한다.
      `$fn = [regex]::Match($src, '(?ms)^function Get-NodeMajor.*?^\\}\\r?\\n(?:.*?)^function Test-NodeUsable.*?^\\}')`,
      `if (-not $fn.Success) { Write-Output 'EXTRACT_FAIL'; exit 0 }`,
      `$NODE_MIN_MAJOR = 20`,
      `Invoke-Expression $fn.Value`,
      `foreach ($p in $args) { Write-Output ([string](Test-NodeUsable $p)) }`,
    ].join("\n"));
    const dr = spawnSync(pwsh, ["-NoProfile", "-File", driver, ...cases.map((c) => c[1])], { encoding: "utf8" });
    const got = dr.stdout.trim().split(/\r?\n/);
    check("⑧ 판정 함수 추출 성공(구조가 안 바뀌었다)", got[0] !== "EXTRACT_FAIL", "Get-NodeMajor/Test-NodeUsable 를 못 찾음 — 테스트가 공허해진다");
    cases.forEach(([name, , want], i) => {
      check(`⑧ ${name} → usable=${want}`, got[i] === want, `got=${got[i] ?? "(무응답)"} / ${dr.stderr}`);
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

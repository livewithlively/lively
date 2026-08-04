#!/usr/bin/env node
// OpenCode 플러그인 어댑터 사양테스트 (#1519) — 어댑터가 **자립 파일**이라서 생기는 위험을 고정한다.
//  실행: node kit/hooks/opencode-plugin.test.mjs
//
// 이 어댑터는 `~/.config/opencode/plugin/lively.js` 로 **혼자** 복사되므로 상대 import 를 쓸 수 없고,
//  그래서 툴 이름 같은 하네스 상수를 인라인으로 갖는다. 그 인라인 값이 harness-registry 의 표와 어긋나면
//  **어댑터만 조용히 옛 규약으로 동작한다**(에러도 안 난다 — matcher 가 안 걸릴 뿐). 여기서 그 일치를 강제한다.
//
// 엣지(사양):
//  P1 어댑터가 import 하는 로컬 모듈이 없다(자립) — 있으면 설치된 자리에서 ERR_MODULE_NOT_FOUND 로 죽는다
//  P2 work-flag 대상 툴 패턴이 표의 opencode 툴 이름과 일치(MCP 접두어 + 편집 툴)
//  P3 그 패턴이 claude/codex 이름에는 걸리지 않는다(대소문자·형태가 다르므로 — 오탐 방지)
//  P4 하네스 stamp 가 "opencode" (프록시·게이트웨이 집계 축 — 틀리면 세션이 남의 하네스로 집계된다)
//  P5 배포 목록(HOOK_SCRIPTS)에 등재 — 안 그러면 설치기가 복사할 소스가 없다
//  P6 유일한 throw 는 deny 경로 하나뿐(fail-open 불변식)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS } from "./harness-registry.mjs";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const KIT = join(HOOKS_DIR, "..");
const SRC = readFileSync(join(HOOKS_DIR, "opencode-plugin.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// ── P1 자립 — 상대 import 금지 ────────────────────────────────────────────────
{
  const rel = [...SRC.matchAll(/^\s*import\s[^"']*["'](\.[^"']+)["']/gm)].map((m) => m[1]);
  rel.length ? bad("P1 어댑터는 자립 파일(상대 import 없음)", `상대 import 발견: ${rel.join(", ")} — 플러그인 디렉터리엔 그 파일이 없다`)
    : ok("P1 어댑터는 자립 파일(상대 import 없음)");
}

// ── P2/P3 툴 패턴이 표와 일치 ────────────────────────────────────────────────
{
  const m = /const WORK_FLAG_TOOLS = (\/.*\/);/.exec(SRC);
  if (!m) bad("P2 WORK_FLAG_TOOLS 파싱", "패턴을 못 찾음(이름이 바뀌었으면 이 테스트를 고칠 것)");
  else {
    // eslint-disable-next-line no-new-func — 소스에서 읽은 리터럴을 그대로 평가(테스트 전용, 코드 상수)
    const re = new Function(`return ${m[1]}`)();
    const oc = HARNESS.opencode.tools;
    // MCP 툴 — 표가 만든 이름이 실제로 걸려야 한다.
    const mcpName = oc.mcp("lively", "whoami");                       // lively_whoami
    re.test(mcpName) ? ok("P2a 표의 MCP 툴 이름이 걸린다") : bad("P2a 표의 MCP 툴 이름이 걸린다", `${mcpName} 미매치`);
    // 편집 툴 — 표의 opencode 편집 툴이 전부 걸려야 한다.
    const missEdit = oc.edit.filter((t) => !re.test(t));
    missEdit.length ? bad("P2b 표의 편집 툴이 전부 걸린다", `미매치: ${missEdit.join(",")}`) : ok("P2b 표의 편집 툴이 전부 걸린다");
    // P3 오탐 방지 — 다른 하네스 이름·무관 툴은 안 걸려야 한다(걸리면 툴콜마다 헛프로세스가 뜬다).
    const shouldNot = [...HARNESS.claude.tools.edit, HARNESS.claude.tools.mcp("lively", "whoami"), "bash", "read", "grep"];
    const wrong = shouldNot.filter((t) => re.test(t));
    wrong.length ? bad("P3 다른 하네스 이름·무관 툴은 안 걸린다", `오탐: ${wrong.join(",")}`) : ok("P3 다른 하네스 이름·무관 툴은 안 걸린다");
  }
}

// ── P4 하네스 stamp ──────────────────────────────────────────────────────────
{
  const m = /const HARNESS = "([a-z]+)";/.exec(SRC);
  m && m[1] === "opencode" ? ok("P4 하네스 stamp 가 opencode")
    : bad("P4 하네스 stamp 가 opencode", `got ${m ? m[1] : "(없음)"} — 틀리면 게이트웨이가 이 세션을 남의 하네스로 집계한다`);
}

// ── P5 배포 목록 등재 ────────────────────────────────────────────────────────
{
  const listOf = (f) => {
    const m = /const HOOK_SCRIPTS\s*=\s*\[([^\]]*)\]/.exec(readFileSync(f, "utf8"));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  const inInstall = listOf(join(KIT, "setup", "user-install.mjs")).includes("opencode-plugin.js");
  const inBuild = listOf(join(KIT, "generator", "build-context.mjs")).includes("opencode-plugin.js");
  (inInstall && inBuild) ? ok("P5 어댑터가 두 배포 목록에 등재됨")
    : bad("P5 어댑터가 두 배포 목록에 등재됨", `install=${inInstall} build=${inBuild} — 빠지면 설치기가 복사할 소스가 없다`);
}

// ── P6 fail-open — throw 는 deny 경로 하나뿐 ─────────────────────────────────
//  어댑터의 어떤 실패도 세션을 막으면 안 된다. throw 가 늘어나면 그 자체가 사고다.
{
  const throws = [...SRC.matchAll(/^\s*throw new /gm)];
  if (throws.length !== 1) bad("P6 throw 는 deny 경로 하나뿐", `throw ${throws.length}개 — fail-open 불변식 위반 가능`);
  else if (!/permissionDecision === "deny"[\s\S]{0,400}throw new /.test(SRC)) bad("P6 throw 는 deny 경로 하나뿐", "유일한 throw 가 deny 분기에 있지 않다");
  else ok("P6 throw 는 deny 경로 하나뿐(fail-open)");
  // 각 훅이 try/catch 로 감싸였나 — catch 없는 훅은 예외가 세션으로 샌다.
  const hooks = [...SRC.matchAll(/"(chat\.message|tool\.execute\.after|permission\.ask)":\s*async[^{]*\{([\s\S]*?)\n  \}/g)];
  const nocatch = hooks.filter((h) => !/catch\s*\{/.test(h[2])).map((h) => h[1]);
  nocatch.length ? bad("P6b 부수효과 훅은 전부 catch 로 감싼다", `미보호: ${nocatch.join(",")}`)
    : ok("P6b 부수효과 훅은 전부 catch 로 감싼다");
}

console.log(`\n${fail ? "✗" : "✓"} opencode-plugin: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

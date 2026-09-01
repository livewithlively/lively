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
//  P5 설치 매니페스트(HOOK_SCRIPTS)에 등재 + 소비자들이 목록 사본을 되살리지 않음
//  P6 유일한 throw 는 deny 경로 하나뿐(fail-open 불변식)
//  P7 **어댑터를 직접 실행**해 deny→차단 / 결정없음→통과 / 러너부재→통과(fail-open) 확인
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
//  종전엔 user-install.mjs·build-context.mjs 두 곳의 리터럴을 각각 정규식으로 확인했다. 그 이중 목록이
//  실제로 드리프트해 사고를 냈으므로(2026-08-27, deploy/refresh-member-kits.sh 의 글롭까지 셋째 사본이었다)
//  목록은 kit/setup/kit-manifest.mjs 단일 출처로 합쳤다. 그래서 여기서 볼 것도 둘이 됐다 —
//  ① 매니페스트에 등재됐는가 ② 소비자가 지역 사본을 **되살리지 않았는가**(되살아나면 다시 드리프트한다).
{
  const { HOOK_SCRIPTS } = await import(pathToFileURL(join(KIT, "setup", "kit-manifest.mjs")).href);
  HOOK_SCRIPTS.includes("opencode-plugin.js")
    ? ok("P5 어댑터가 설치 매니페스트에 등재됨")
    : bad("P5 어댑터가 설치 매니페스트에 등재됨", "빠지면 설치기·번들 조립이 복사할 소스가 없다");

  const revived = ["setup/user-install.mjs", "generator/build-context.mjs"]
    .filter((rel) => /const HOOK_SCRIPTS\s*=\s*\[/.test(readFileSync(join(KIT, rel), "utf8")));
  revived.length === 0
    ? ok("P5 소비자가 목록 사본을 두지 않음(단일 출처 유지)")
    : bad("P5 소비자가 목록 사본을 두지 않음(단일 출처 유지)", `${revived.join(", ")} 가 지역 리터럴을 되살렸다 — 매니페스트와 조용히 어긋난다`);
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

// ── P7 차단이 실제로 걸리는가 — **어댑터를 직접 실행**한다 ────────────────────────────────
//  실기기 세션(모델 필요)으로는 무료 모델 큐 때문에 안정적으로 못 돈다. 어댑터는 순수 함수라
//  러너를 스텁으로 두고 훅을 직접 부르면 **차단 로직 자체**를 모델 없이 검증할 수 있다.
//  P6 은 "throw 가 deny 분기에 있다"를 소스로만 본다 — 여기서는 실제로 던지는지 실행으로 본다.
{
  const SB = mkdtempSync(join(tmpdir(), "oc-plugin-run-"));
  try {
    const hooksDir = join(SB, ".lively", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    // 스텁 러너 — 입력에 BLOCK 이 있으면 deny 결정을, 아니면 아무것도 내지 않는다.
    writeFileSync(join(hooksDir, "run-custom.mjs"), `
import { readFileSync } from "node:fs";
let s = ""; try { s = readFileSync(0, "utf8"); } catch {}
if (process.argv[2] === "PreToolUse" && s.includes("BLOCK")) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "테스트 정책" } }) + "\\n");
}
`);
    // 어댑터는 모듈 로드 시점에 경로를 굳힌다 → LIVELY_HOME 을 먼저 세우고 dynamic import.
    const prev = process.env.LIVELY_HOME;
    process.env.LIVELY_HOME = SB;
    const mod = await import(`./opencode-plugin.js?t=${SB.replace(/\W/g, "")}`);
    const hooks = await mod.LivelyAdapter({});
    process.env.LIVELY_HOME = prev;

    // ① deny → throw (거버넌스가 실제로 툴을 막는다)
    let threw = null;
    try { await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c1" }, { args: { command: "BLOCK me" } }); }
    catch (e) { threw = e; }
    threw ? ok("P7a deny 결정이 실제로 툴을 막는다(throw)") : bad("P7a deny 결정이 실제로 툴을 막는다(throw)", "throw 하지 않음 — 관리자가 막았다고 믿는 것이 안 막힌다");
    // 사유가 사용자에게 보이는 메시지에 실려야 한다(왜 막혔는지가 화면에 남아야 한다).
    (threw && /테스트 정책/.test(String(threw.message))) ? ok("P7b 차단 사유가 메시지에 실린다")
      : bad("P7b 차단 사유가 메시지에 실린다", `got ${threw ? threw.message : "(없음)"}`);

    // ② 결정 없음 → 통과 (fail-open — 훅이 아무 말도 안 하면 막지 않는다)
    let passed = true;
    try { await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c2" }, { args: { command: "safe" } }); }
    catch { passed = false; }
    passed ? ok("P7c 결정이 없으면 통과한다") : bad("P7c 결정이 없으면 통과한다", "막혔다 — fail-open 위반");

    // ③ 러너가 아예 없어도 통과 (설치 파손 시 세션을 막지 않는다)
    rmSync(join(hooksDir, "run-custom.mjs"), { force: true });
    let passed2 = true;
    try { await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1", callID: "c3" }, { args: { command: "BLOCK me" } }); }
    catch { passed2 = false; }
    passed2 ? ok("P7d 러너가 없어도 세션을 막지 않는다(fail-open)") : bad("P7d 러너가 없어도 세션을 막지 않는다(fail-open)", "막혔다 — 배선 파손이 곧 장애가 된다");
  } finally { rmSync(SB, { recursive: true, force: true }); }
}

console.log(`\n${fail ? "✗" : "✓"} opencode-plugin: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

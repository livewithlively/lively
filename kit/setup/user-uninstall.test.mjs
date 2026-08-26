#!/usr/bin/env node
// user-uninstall 회귀테스트 — 심링크 경로(/tmp→/private/tmp · /var→/private/var)에서 제거기 main 이
//  **실제로 돌아야 한다**. 로그인 상태 `lively uninstall` 은 번들을 mkdtemp(/var/folders/...)에서 실행하는데,
//  진입 가드가 URL 문자열 비교(import.meta.url === `file://${process.argv[1]}`)면 Node ESM 이 엔트리를
//  realpath 로 풀어(/private/var...) argv[1](/var...)과 어긋나 main 이 조용히 스킵된다 → "아무것도 안 지워짐".
//  실측 2026-07-15(로그인 사용자 전원). install 측 user-install.test.mjs ⑥ 과 대칭 — install 만 있고
//  uninstall 엔 없어서 이 버그가 배포됐다. 가드는 realpath 비교(DIRECT_RUN)로 고쳤고 이 테스트가 재발을 막는다.
//  오프라인·fs-only: 샌드박스 HOME(LIVELY_HOME)에서만, 실제 ~/.lively·~/.claude·rc 무접촉.
//  실행: node kit/setup/user-uninstall.test.mjs  (npm test 체인에 포함)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };
const bad = (name, why) => { fail++; console.error(`FAIL ${name} — ${why}`); };

const HERE = join(fileURLToPath(import.meta.url), "..");

// setup/ 전체(user-uninstall.mjs 포함)를 심링크 뒤 번들로 복사하고, link/ → real/ 심링크로 실행 경로를 만든다.
//  (macOS 표준 임시경로 /var/folders·/tmp 의 /private/* 심링크를 소형으로 재현.)
function symlinkedBundle(prefix) {
  const box = mkdtempSync(join(tmpdir(), prefix));
  const bundle = join(box, "real", "bundle");
  mkdirSync(bundle, { recursive: true });
  cpSync(HERE, join(bundle, "setup"), { recursive: true });
  symlinkSync(join(box, "real"), join(box, "link"));
  return { box, entry: join(box, "link", "bundle", "setup", "user-uninstall.mjs") };
}

// ① 심링크 경로 직접 실행 → main 이 실제로 돈다(헤더 출력 = 진입 증거). 옛 가드면 stdout 이 텅 빈다.
{
  const { box, entry } = symlinkedBundle("uninst-sym-");
  const home = join(box, "home");
  mkdirSync(home, { recursive: true });
  const out = execFileSync(process.execPath, [entry, "--dry-run"],
    { env: { ...process.env, LIVELY_HOME: home }, encoding: "utf8" });
  out.includes("lively 제거")
    ? ok("① 심링크 경로 실행에도 제거기 main 진입(헤더 출력)")
    : bad("① 심링크 직접실행", `stdout 에 헤더 없음(main 스킵?): ${JSON.stringify(out.slice(0, 80))}`);
  rmSync(box, { recursive: true, force: true });
}

// ② 심링크 경로 + 실제 설치(~/.lively 존재) → 제거가 실제로 일어난다(main 이 돌 뿐 아니라 작동).
//    detect() 게이트(user-uninstall.mjs)는 existsSync(LIVELY) 면 no-op 하지 않고 [3] ~/.lively 제거까지 간다.
{
  const { box, entry } = symlinkedBundle("uninst-real-");
  const home = join(box, "home");
  const lively = join(home, ".lively");
  mkdirSync(lively, { recursive: true });
  writeFileSync(join(lively, "kit-version"), "test\n"); // 설치 마커
  execFileSync(process.execPath, [entry, "--yes", "--purge"],
    { env: { ...process.env, LIVELY_HOME: home }, stdio: "ignore" });
  !existsSync(lively)
    ? ok("② 심링크 경로 실행이 ~/.lively 를 실제 제거(--purge)")
    : bad("② 심링크 실제제거", "~/.lively 가 남아있음 — main 이 스킵됐거나 제거가 안 됨");
  rmSync(box, { recursive: true, force: true });
}

// ③ 비파괴 MCP 라운드트립 — **여기 있었는데 scripts/uninstall-mcp-roundtrip.itest.mjs 로 옮겼다**(2026-08-27).
//  그 블록은 진짜 `claude` 를 부르는데 이 계층의 자식 env 는 호스트 효과를 막는다(test-runner-env.mjs 의
//  LIVELY_HOST_EFFECTS=deny + sandboxEnv 의 같은 값). 그래서 claude 가 깔린 머신에서는 구조적으로 통과할
//  수 없었고("HostEffects denied external-cli: claude" → 복원 실패), claude 가 없는 리눅스 CI 는 스킵해
//  초록불이었다 — **CI 초록 · 개발자 맥 영구 빨강**. 실 CLI 를 부르려면 호스트 효과를 열어야 하는데 그건
//  R3 가 기본 계층에 금지하고(kit/testlib/test-isolation-rules.mjs) 처방으로 *.itest.mjs 이관을 적어 뒀다.
//  ⚠ 되돌리지 마라 — 여기로 다시 가져오면 같은 이유로 다시 빨강이 된다. 돌리려면:
//     node scripts/uninstall-mcp-roundtrip.itest.mjs   (또는 node scripts/run-tests.mjs --itest)

console.log(`user-uninstall tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

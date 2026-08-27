#!/usr/bin/env node
// 설치 검증기 사양테스트 — 「심어놓은 트리가 실행 가능한가」 축의 red 입증.
//  실행: node kit/setup/verify-kit-install.test.mjs
//
// 이 축이 왜 따로 필요한가 — 2026-08-27 사고에서 기존 배포 테스트는 전부 초록이었다. 그것들은
//  「리프레시가 호출되는가·순서가 맞는가」라는 **배선**만 보기 때문이다. 파일 개수도 오히려 늘어서
//  개수 기반 점검으로도 안 잡혔다. 여기서 고정하는 건 개수가 아니라 **import 가 풀리는가**이다.
//
// 각 케이스는 «옛 글롭 리프레시가 실제로 만들어 놓던 트리»를 그대로 재현한다 — 그래서 이 테스트는
//  수정 전 상태에 대해 정의상 빨간불이다(V2 가 그날의 실측 그 자체).
import { mkdtempSync, mkdirSync, rmSync, cpSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HOOK_SCRIPTS, LIB_FILES } from "./kit-manifest.mjs";
import { verifyKitInstall } from "./verify-kit-install.mjs";

const SETUP_DIR = dirname(fileURLToPath(import.meta.url));
const KIT = join(SETUP_DIR, "..");
const VERIFY_CLI = join(SETUP_DIR, "verify-kit-install.mjs");
const SB = mkdtempSync(join(tmpdir(), "lively-verify-"));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// 설치된 ~/.lively 를 흉내 낸다. opts 로 «그날의 트리»를 만든다.
function makeTree(name, { withLib = true, dropHooks = [] } = {}) {
  const root = join(SB, name);
  mkdirSync(join(root, "hooks"), { recursive: true });
  for (const f of HOOK_SCRIPTS) {
    if (dropHooks.includes(f)) continue;
    cpSync(join(KIT, "hooks", f), join(root, "hooks", f));
  }
  if (withLib) {
    for (const f of LIB_FILES) {
      mkdirSync(join(root, dirname(f.dest)), { recursive: true });
      cpSync(join(KIT, "setup", f.src), join(root, f.dest));
    }
  }
  return root;
}

// ── V1 정상 설치 트리는 통과한다 ─────────────────────────────────────────────
//  ★ 동시에 «포트 패턴 오탐 없음»의 증거다: 설치 자리엔 host-effects-port 가 먼저 시도하는
//   `../setup/host-effects.mjs` 가 **없는 게 정상**이고(그건 소스트리 레이아웃), `../lib/` 만 있다.
//   동적 import 를 파일 단위 any-of 로 보지 않으면 여기서 거짓 실패가 난다.
{
  const root = makeTree("complete");
  const { ok: good, problems } = verifyKitInstall(root);
  const setupAbsent = !existsSync(join(root, "setup", "host-effects.mjs"));
  (good && setupAbsent) ? ok("V1 정상 트리 통과 — 포트의 대체 경로(../setup/)를 오탐하지 않음")
    : bad("V1 정상 트리 통과", `problems=${JSON.stringify(problems)} setupAbsent=${setupAbsent}`);
}

// ── V2 그날의 트리: 훅은 다 있는데 lib 공유모듈만 없다 ───────────────────────
//  옛 글롭(`kit/hooks/*.mjs`)이 만들던 상태 그대로. 파일 개수는 정상보다 **많았고**(테스트까지 복사)
//  그래도 훅은 전멸이었다.
{
  const { ok: good, problems } = verifyKitInstall(makeTree("no-lib", { withLib: false }));
  const namesLib = problems.some((p) => p.includes("lib/host-effects.mjs"));
  const namesClosure = problems.some((p) => p.includes("host-effects-port.mjs"));
  (!good && namesLib && namesClosure)
    ? ok("V2 lib 공유모듈 누락을 잡는다(누락 축 + import 폐포 축 둘 다)")
    : bad("V2 lib 공유모듈 누락을 잡는다", `ok=${good} problems=${JSON.stringify(problems)}`);
}

// ── V3 정적 의존 누락 — 개수만 보면 안 보이는 자리 ───────────────────────────
//  harness-registry.mjs 는 훅이 아니라 훅들이 import 하는 모듈이다. 빠지면 그걸 import 하는 훅이
//  통째로 죽는데, 훅 파일은 그대로 다 있으므로 «개수 초록»이다.
{
  const { ok: good, problems } = verifyKitInstall(makeTree("no-registry", { dropHooks: ["harness-registry.mjs"] }));
  const named = problems.some((p) => p.includes("harness-registry.mjs"));
  (!good && named) ? ok("V3 정적 import 대상 누락을 잡는다")
    : bad("V3 정적 import 대상 누락을 잡는다", `ok=${good} problems=${JSON.stringify(problems)}`);
}

// ── V4 주석은 의존이 아니다 ─────────────────────────────────────────────────
//  추출기 회귀 가드. 이 레포 주석엔 `~/.lively/hooks/*.mjs` 같은 경로가 흔한데, 블록주석을 정규식으로
//  먼저 지우면 그 `/*` 부터 파일 절반이 사라져 **정적 의존이 0건**으로 보인다(실측: user-install.mjs
//  72KB→37KB). 그러면 검증기가 아무것도 못 보면서 초록을 준다 — 가장 나쁜 실패다.
{
  const root = makeTree("comments");
  appendFileSync(join(root, "hooks", "harness-registry.mjs"),
    '\n// 예시: import { x } from "./ghost-module.mjs";  경로 표기 ~/.lively/hooks/*.mjs 도 섞여 있다\n');
  const { ok: good, problems } = verifyKitInstall(root);
  good ? ok("V4 주석 안의 import 예시를 의존으로 세지 않는다")
    : bad("V4 주석 안의 import 예시를 의존으로 세지 않는다", `problems=${JSON.stringify(problems)}`);
}

// ── V5 CLI 종료코드 — 배포 스크립트가 이걸로 판정한다 ────────────────────────
{
  const good = spawnSync(process.execPath, [VERIFY_CLI, makeTree("cli-ok")], { encoding: "utf8" });
  const brokenRoot = makeTree("cli-broken", { withLib: false });
  const broken = spawnSync(process.execPath, [VERIFY_CLI, brokenRoot], { encoding: "utf8" });
  (good.status === 0 && broken.status === 1 && /host-effects/.test(broken.stderr))
    ? ok("V5 CLI 종료코드 0/1 + 실패 사유를 stderr 에 이름으로 찍는다")
    : bad("V5 CLI 종료코드 0/1", `ok=${good.status} broken=${broken.status} stderr=${JSON.stringify(broken.stderr)}`);
}

rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} verify-kit-install.test — ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

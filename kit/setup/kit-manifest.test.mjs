#!/usr/bin/env node
// 설치 목록 단일 출처 사양테스트 — 2026-08-27 «멤버 훅 전멸» 회귀의 재발 가드.
//  실행: node kit/setup/kit-manifest.test.mjs   (kit/**/*.test.mjs 라 npm test 체인에 자동 포함)
//
// 그날 무슨 일이 있었나 — 배포는 성공했고 멤버 홈의 파일 개수는 **늘었는데** 훅은 전멸이었다.
//  `deploy/refresh-member-kits.sh` 가 `kit/hooks/*.mjs` 글롭으로 복사 대상을 자체 판단했고, 그 글롭이
//  최초 설치기(user-install.mjs)와 조용히 어긋나 세 가지를 동시에 틀렸다:
//   ① hooks/ **밖**의 공유 모듈(lib/host-effects.mjs)을 못 날라 전 훅이 ERR_MODULE_NOT_FOUND
//   ② opencode-plugin.js 를 놓침(확장자가 .js 라 *.mjs 에 미매치)
//   ③ 반대로 .test.mjs 25개를 멤버 홈에 뿌림
//  훅은 non-blocking 이라 세션은 그대로 떠서, 발견은 **사용자 제보**로만 됐다.
//
// 그래서 여기서 잠그는 건 「목록이 맞다」가 아니라 「목록이 **한 곳에만 있고 실물과 일치한다**」이다.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_SCRIPTS, LIB_FILES, SETUP_FILES, installPlan, hookSourceFiles } from "./kit-manifest.mjs";
import { relativeImports } from "./verify-kit-install.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// ── M1 등재된 훅이 실물로 있는가 ─────────────────────────────────────────────
{
  const missing = HOOK_SCRIPTS.filter((f) => !existsSync(join(KIT, "hooks", f)));
  missing.length === 0 ? ok("M1 HOOK_SCRIPTS 전원이 kit/hooks 에 실재")
    : bad("M1 HOOK_SCRIPTS 전원이 kit/hooks 에 실재", `없음: ${missing.join(", ")} — 설치기가 «발행물에 훅 누락»으로 중단한다`);
}

// ── M2 실물 훅이 전부 등재됐는가(유령 항목도 없는가) ─────────────────────────
//  훅을 새로 추가하고 등재를 잊는 것이 ②의 형태다. 양방향으로 잠근다.
{
  const actual = hookSourceFiles(KIT);
  const unlisted = actual.filter((f) => !HOOK_SCRIPTS.includes(f));
  const ghost = HOOK_SCRIPTS.filter((f) => !actual.includes(f));
  (unlisted.length === 0 && ghost.length === 0)
    ? ok("M2 kit/hooks 의 코드 파일과 HOOK_SCRIPTS 가 정확히 일치")
    : bad("M2 kit/hooks 의 코드 파일과 HOOK_SCRIPTS 가 정확히 일치",
        `미등재: [${unlisted.join(", ")}] · 유령: [${ghost.join(", ")}] — 미등재는 설치 자리에서 조용히 없고, 유령은 설치기를 중단시킨다`);
}

// ── M3 hooks/ 밖 공유 모듈 ───────────────────────────────────────────────────
//  이 축이 비어 있던 것이 ①의 직접 원인이다. 평면 복사로는 절대 안 따라오는 자리임을 명시적으로 잠근다.
{
  const missing = LIB_FILES.filter((f) => !existsSync(join(KIT, "setup", f.src)));
  const inHooks = LIB_FILES.filter((f) => f.dest.startsWith("hooks/"));
  (missing.length === 0 && inHooks.length === 0 && LIB_FILES.length > 0)
    ? ok("M3 LIB_FILES 가 실재하고 전부 hooks/ 밖에 설치된다")
    : bad("M3 LIB_FILES 가 실재하고 전부 hooks/ 밖에 설치된다",
        `없음: [${missing.map((f) => f.src).join(", ")}] · hooks/ 안: [${inHooks.map((f) => f.dest).join(", ")}] · 개수=${LIB_FILES.length}`);
}

// ── M4 발행번들 setup/ 페이로드 ──────────────────────────────────────────────
{
  const missing = SETUP_FILES.filter((f) => !existsSync(join(KIT, "setup", f)));
  const selfListed = SETUP_FILES.includes("kit-manifest.mjs");
  (missing.length === 0 && selfListed)
    ? ok("M4 SETUP_FILES 전원이 실재 + 매니페스트 자신이 동봉됨")
    : bad("M4 SETUP_FILES 전원이 실재 + 매니페스트 자신이 동봉됨",
        `없음: [${missing.join(", ")}] · 자기등재=${selfListed} — 매니페스트가 빠지면 설치기가 번들 안에서 import 크래시로 죽는다`);
}

// ── M5 번들 setup/ 이 import-닫혀 있는가 ────────────────────────────────────
//  설치기는 **번들 안에서 자기 자신을 실행**한다. 그래서 설치기가 import 하는 형제 모듈이 SETUP_FILES 에
//  없으면 훅이 아니라 **설치 자체**가 죽는다 — 이번 수정에서 kit-manifest.mjs 를 동봉 목록에 넣지
//  않았다면 곧바로 그 사고가 났을 자리다(실측: e2e·wiring 테스트 6곳이 같은 사본을 들고 있었다).
{
  const problems = [];
  for (const f of SETUP_FILES) {
    const { statics } = relativeImports(readFileSync(join(KIT, "setup", f), "utf8"));
    for (const spec of statics) {
      const base = spec.replace(/^\.\//, "");
      if (spec.startsWith("../") || !SETUP_FILES.includes(base)) problems.push(`${f} → ${spec}`);
    }
  }
  problems.length === 0 ? ok("M5 번들 setup/ 페이로드가 import-닫힘")
    : bad("M5 번들 setup/ 페이로드가 import-닫힘", `번들에 없는 형제를 import: ${problems.join(", ")}`);
}

// ── M6 설치 계획이 사고 지점을 실제로 담는가 ────────────────────────────────
//  ①②③ 을 한 줄씩 고정한다 — 계획에 lib 목적지가 있고, .js 어댑터가 있고, 테스트 파일이 없다.
{
  const plan = installPlan(KIT);
  const dests = plan.map((e) => e.dest);
  // dest 는 POSIX 논리 경로다 — join() 으로 기대값을 만들면 윈도우에서만 어긋난다(실측).
  const hasLib = dests.includes("lib/host-effects.mjs");
  const hasOpencode = dests.includes("hooks/opencode-plugin.js");
  const tests = dests.filter((d) => d.includes(".test."));
  (hasLib && hasOpencode && tests.length === 0)
    ? ok("M6 설치 계획: lib 공유모듈 포함 · .js 어댑터 포함 · 테스트 파일 제외")
    : bad("M6 설치 계획: lib 공유모듈 포함 · .js 어댑터 포함 · 테스트 파일 제외",
        `lib=${hasLib} opencode=${hasOpencode} tests=[${tests.join(", ")}] — 2026-08-27 회귀의 세 축`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} kit-manifest.test — ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

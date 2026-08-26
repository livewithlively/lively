#!/usr/bin/env node
// 멤버 홈(~/.lively)에 설치되는 **훅 런타임** 파일 목록의 단일 출처.
//
// 왜 파일을 따로 뒀나 — 이 목록의 소비자가 셋인데 서로 다른 언어·다른 트리에서 산다:
//   ① kit/setup/user-install.mjs        최초 설치 (발행번들 .claude/hooks/ → ~/.lively/hooks/)
//   ② kit/generator/build-context.mjs   발행번들 조립 (kit/hooks/ → 번들 .claude/hooks/)
//   ③ deploy/refresh-member-kits.sh     배포 후 기존 멤버 리프레시 (릴리스 kit/hooks/ → ~/.lively/hooks/)
//
//  ③ 은 셸이라 ①의 export 를 import 할 수 없어, 종전엔 `kit/hooks/*.mjs` 글롭으로 **자체 판단**했다.
//  그 글롭이 2026-08-27 사고를 냈다 — 신규 `host-effects-port.mjs` 가 `../lib/host-effects.mjs` 를
//  import 하는데 글롭은 hooks/ 안만 보므로 lib 의존을 안 날랐고, **kit 설치 멤버 전원의 훅이 전멸**했다.
//  훅은 non-blocking 이라 세션은 그대로 떠서(맥락주입·작업기록만 조용히 죽은 채) 아무도 몰랐다.
//  같은 글롭이 `opencode-plugin.js`(확장자가 .js 라 미매치)도 놓치고, 반대로 `.test.mjs` 25개는
//  멤버 홈에 뿌리고 있었다 — 한 글롭이 **과소·과대 복사를 동시에** 하고 있었다.
//   → 목록을 여기 한 곳에 두고 ③ 은 `--install-plan` 으로 **같은 목록을 읽어 간다**(글롭 금지).
//
// ⚠ 여기는 **훅 런타임만** 담는다. ~/.lively/work.mjs · lively CLI(lib/lively.mjs 등)는 설치 단위가
//  달라 user-install 이 따로 다룬다 — 이 매니페스트를 "멤버 홈 전체 목록"으로 오해하지 말 것.
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 훅 디렉터리로 **평평하게** 설치되는 파일 ─────────────────────────────────
//  self-update.mjs(#858)는 settings 에 배선되지 않는다 — 훅이 아니라 session-preload 가 detached 로
//   띄우는 백그라운드 업데이터다. 파일만 놓는다.
//  ⚠ harness-registry.mjs · host-effects-port.mjs 는 실행되는 훅이 아니라 **훅들이 import 하는 모듈**이다.
//   훅은 평평하게 복사되므로 같은 목록에 있어야 하고, 빠지면 그걸 import 하는 훅이 ERR_MODULE_NOT_FOUND
//   로 통째로 죽는다(등재 누락은 kit/hooks/harness-registry.test.mjs 와 kit-manifest.test.mjs 가 잡는다).
export const HOOK_SCRIPTS = [
  "session-preload.mjs",
  "work-flag.mjs",
  "stop-writeback-gate.mjs",
  "run-custom.mjs",
  "sync-harness-assets.mjs",
  "self-update.mjs",
  "harness-registry.mjs",
  "host-effects-port.mjs",
  "opencode-plugin.js",
  "antigravity-adapter.mjs",
  "grok-adapter.mjs",
  // usage-report.mjs 는 훅(이벤트 배선)이 아니라 **statusLine 스크립트**다 — settings 훅 블록에 안 걸리고,
  //  스폰타임 `--settings` 로 상시세션에만 얹힌다(src/terminal/catalog.ts managedStatusLineSpec).
  //  여기 등재하는 건 파일을 ~/.lively/hooks/ 로 같은 복사·chmod·자동업데이트 파이프라인에 태우기 위해서다
  //  — 그래야 그 statusLine command 가 실재 파일을 가리킨다. 빠지면 command 가 없는 경로를 가리키며
  //  **조용히** 아무것도 안 나온다(타입체크·테스트로는 안 잡히는 무증상 실패).
  "usage-report.mjs",
];

// ── 훅이 hooks/ **밖에서** 끌어 쓰는 공유 모듈 ───────────────────────────────
//  훅 디렉터리 밖이라 위 목록(=hooks/ 평면 복사)으로는 절대 안 따라온다. 이 축이 비어 있던 것이
//  2026-08-27 사고의 직접 원인이다. src 는 kit/setup/ 기준, dest 는 ~/.lively 기준.
export const LIB_FILES = [
  { src: "host-effects.mjs", dest: "lib/host-effects.mjs" },
];

// ── 발행번들 setup/ 에 동봉되는 파일 ─────────────────────────────────────────
//  번들은 kit 없이 홀로 서야 한다 — 설치기가 **번들 안에서 자기 자신을 실행**하므로, 여기서 하나라도
//  빠지면 설치기가 ERR_MODULE_NOT_FOUND 로 죽는다(훅이 아니라 설치 자체가 실패한다).
//  종전엔 kit/generator/build-context.mjs 와 e2e·wiring 테스트 6곳이 각자 사본을 갖고 있었다.
export const SETUP_FILES = [
  "user-install.mjs",       // 설치 엔진 자체
  "user-uninstall.mjs",     // 제거기(설치/제거 대칭) — uninstall-mac.sh 가 부른다
  "host-effects.mjs",       // 설치·제거의 영속 호스트 효과 capability(엔진과 같은 번들 필수)
  "work-roots-header.mjs",  // user-install 이 import 하는 공유 상수(#270)
  "work.mjs",               // '내 컴퓨터에서 작업' 부트스트랩 — 설치기가 ~/.lively/work.mjs 로 복사
  "kit-manifest.mjs",       // 이 파일 — 설치 목록 단일 출처(user-install 이 import)
];

// kit 트리(<repo>/kit 또는 릴리스 <release>/kit)에서 읽어 갈 실제 경로 + 설치 위치 쌍.
//  훅은 <kitRoot>/hooks/, 공유 모듈은 <kitRoot>/setup/ 에 있다(발행번들 레이아웃은 다르므로
//  user-install 이 자기 매핑을 따로 갖는다 — 공유되는 건 **목록**이지 레이아웃이 아니다).
//  ⚠ dest 는 **논리 경로**라 항상 POSIX 구분자(`/`)로 쓴다 — join() 을 섞으면 윈도우에서만 hooks 는
//   `hooks\\x` 인데 lib 는 `lib/y` 가 돼 두 축의 표기가 갈린다(실측: 그렇게 짰다가 윈도우 CI 에서만 M6 가
//   깨졌다 — 이 레포가 이미 겪은 부류다). 소비자는 셸(`$h/.lively/$dest`)과 node(`join(LIVELY, dest)`)
//   둘인데 양쪽 다 `/` 를 받는다. src 는 반대로 실제 파일을 열어야 하므로 join() 으로 플랫폼 경로를 쓴다.
export function installPlan(kitRoot) {
  const root = resolve(kitRoot);
  return [
    ...HOOK_SCRIPTS.map((f) => ({ src: join(root, "hooks", f), dest: `hooks/${f}` })),
    ...LIB_FILES.map((f) => ({ src: join(root, "setup", f.src), dest: f.dest })),
  ];
}

// kit/hooks 안의 "코드 파일"(테스트·설정·셸 제외) — 매니페스트 등재 누락 검사의 기준면.
export function hookSourceFiles(kitRoot) {
  return readdirSync(join(resolve(kitRoot), "hooks"), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => (n.endsWith(".mjs") || n.endsWith(".js")) && !n.endsWith(".test.mjs") && !n.endsWith(".test.js"))
    .sort();
}

// ── "이 파일이 직접 실행됐나" 판정 (공유) ───────────────────────────────────
//  ⚠ **심링크를 반드시 푼다.** `path.resolve` 는 어휘적 정규화라 심링크를 남기는데, `import.meta.url` 은
//   Node 가 실제로 로드한 **realpath** 다. 심링크 경로로 부르면 두 값이 어긋나 CLI 블록이 통째로 안 돌고
//   **출력 0줄에 exit 0** 이 된다 — 실패가 아니라 침묵이라 부르는 쪽은 «결과가 비었다»로만 본다.
//
//  이게 왜 사고였나: 배포 레이아웃은 심링크 투성이다(`current → <color> → releases/<id>`, deploy-release.sh)
//   이고 bash 의 `cd`+`pwd` 는 심링크를 **보존**한다. 그래서 `/opt/lively/current/deploy` 에서 부르면
//   ① kit-manifest --install-plan 이 빈 목록을 내 refresh-member-kits.sh 가 중단하고
//   ② verify-kit-install 은 **검증을 통째로 건너뛰고 exit 0** 을 내 «설치 검증 통과» 로 오독된다.
//   ②가 특히 나쁘다 — 2026-08-27 «멤버 훅 전멸» 을 잡으라고 만든 안전망이 그 자체로 무음이 된다.
//
//  ⚠ 새 CLI 진입점을 만들 땐 이 함수를 써라. 손으로 `pathToFileURL(resolve(argv[1]))` 를 비교하면 같은
//   침묵이 재생산된다(회귀 가드: kit/setup/kit-manifest.test.mjs 의 M7).
export function isDirectRun(importMetaUrl) {
  if (!process.argv[1]) return false;
  const abs = resolve(process.argv[1]);
  // realpathSync 는 경로가 없으면 throw — 그땐 어휘 경로로 떨어진다(판정만 못할 뿐 안전).
  let href;
  try { href = pathToFileURL(realpathSync(abs)).href; } catch { href = pathToFileURL(abs).href; }
  return href === importMetaUrl;
}

// ── CLI: 셸(deploy/refresh-member-kits.sh)이 목록을 읽어 가는 창구 ───────────
//  출력은 `<절대 src>\t<~/.lively 기준 dest>` TSV — 셸에서 while read 로 그대로 돈다.
if (isDirectRun(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes("--install-plan")) {
    console.error("사용: node kit/setup/kit-manifest.mjs --install-plan [--kit-root <dir>]");
    process.exit(2);
  }
  const i = args.indexOf("--kit-root");
  const kitRoot = i > -1 && args[i + 1] ? args[i + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const { src, dest } of installPlan(kitRoot)) console.log(`${src}\t${dest}`);
}

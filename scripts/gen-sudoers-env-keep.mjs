#!/usr/bin/env node
// sudoers 의 세션 env 허용목록을 **생성**한다 (#2599 T1).
//
//  목록의 주인은 `src/terminal/session-env-contract.ts` 하나다. 이 스크립트는 그 계약을 렌더해
//  `deploy/linux/sudoers-lively` 의 생성 구역(마커 사이)을 갈아끼운다 — 그래서 「코어가 싣는 목록」과
//  「sudo 가 통과시키는 목록」의 diff 가 **정의상 0** 이 된다.
//
//  왜 «설치 시 생성» 이 아니라 «커밋된 생성물» 인가:
//   ⓐ `visudo -cf` 로 검증되는 실체 파일이 리뷰 diff 에 보인다(권한 경계 변경은 눈으로 봐야 한다).
//   ⓑ 설치 경로(install-isolation.sh)에 «빌드 산출물이 있어야 설치된다» 는 새 실패 모드를 안 만든다.
//   대신 `src/terminal/session-env-contract.test.ts` 가 「체크인된 파일 == 지금 렌더한 값」을 강제한다.
//
//  사용:
//    node scripts/gen-sudoers-env-keep.mjs --write   재생성(=npm run gen:sudoers)
//    node scripts/gen-sudoers-env-keep.mjs --check    어긋나면 비-0 (CI·훅용. 시험도 같은 것을 잰다)
//  ⚠ 계약은 TS 다 → `npm run build` 뒤에 돈다. dist 가 없으면 **조용히 통과하지 않고** 죽는다
//   (kit-manifest 의 교훈: 검사기의 무음이 검사 실패보다 나쁘다).
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const SUDOERS = repo("deploy/linux/sudoers-lively");
const CONTRACT = repo("dist/terminal/session-env-contract.js");
const CONTRACT_SRC = repo("src/terminal/session-env-contract.ts");

const args = process.argv.slice(2);
const write = args.includes("--write");
const check = args.includes("--check");
if (write === check) {
  console.error("사용: node scripts/gen-sudoers-env-keep.mjs (--write | --check)");
  process.exit(2);
}
if (!existsSync(CONTRACT)) {
  console.error(`✗ 계약 모듈이 빌드돼 있지 않다: ${CONTRACT}\n  → npm run build 후 다시 실행하라.`);
  process.exit(2);
}
//  ⚠ **있는 것만으로는 모자라다 — 최신이어야 한다.** 계약(.ts)을 고치고 빌드 없이 이 스크립트를 부르면
//   스테일 dist 에서 렌더해 «✓ 갱신» 을 찍는다: 방금 한 편집이 반영되지 않았는데 성공으로 보인다.
//   나쁜 것이 배포되지는 않지만(CI 는 항상 새로 빌드하고 시험이 어긋남을 잡는다) 로컬 개발 루프에서
//   가장 헷갈리는 자리라 여기서 죽인다. 이 모듈의 원칙 그대로 — 조용히 통과하지 않는다.
if (existsSync(CONTRACT_SRC) && statSync(CONTRACT_SRC).mtimeMs > statSync(CONTRACT).mtimeMs) {
  console.error(
    `✗ 계약 모듈의 빌드본이 소스보다 오래됐다(스테일):\n` +
    `    소스 ${CONTRACT_SRC}\n    빌드 ${CONTRACT}\n` +
    "  → 지금 생성하면 방금 고친 내용이 빠진 채로 «갱신됨» 이 찍힌다. `npx tsc -p tsconfig.json`(또는 npm run build) 후 다시 실행하라.",
  );
  process.exit(2);
}

const { spliceSudoers } = await import(CONTRACT);
const before = readFileSync(SUDOERS, "utf8");
const after = spliceSudoers(before);   // 마커가 없으면 던진다 — 무음 통과 금지

if (after === before) {
  console.log("sudoers env_keep: 계약과 일치(변경 없음)");
  process.exit(0);
}
if (check) {
  console.error(
    "✗ deploy/linux/sudoers-lively 의 생성 구역이 계약과 어긋났다.\n" +
    "  허용목록은 src/terminal/session-env-contract.ts 가 소유하는 생성물이다 — 파일을 직접 고치지 말고\n" +
    "  `npm run gen:sudoers` 로 재생성하라.",
  );
  process.exit(1);
}
writeFileSync(SUDOERS, after);
console.log(`✓ deploy/linux/sudoers-lively 생성 구역 갱신 — 커밋에 포함하라(visudo -cf 로 검증 권장)`);

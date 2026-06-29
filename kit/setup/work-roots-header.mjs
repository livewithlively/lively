// lively work-roots 파일 헤더 — 단일 출처(#270). 설치기 3종이 공유한다:
//   setup/user-install.mjs · adapters/claude/install.mjs · adapters/codex/install.mjs.
// ⚠ 부수효과 없는 순수 export 모듈이어야 한다(설치기가 import 만 하고 실행하지 않음).
// ⚠ 발행물(번들)에 동봉된다 — build-context.mjs(emitClaudeArtifact)의 copied 목록에 포함되어야
//    번들 안 user-install.mjs 의 `./work-roots-header.mjs` import 가 해결된다(누락 시 설치 크래시).
// 서버측 src/org/publish.ts 는 배포물 경계상 이 .mjs 를 빌드타임 import 하지 않으므로 동일 텍스트를 수동 유지한다
//   (그 사본은 번들 .lively/work-roots 에 쓰이지만, 멤버 머신 최종본은 user-install 의 seed = 이 상수).
export const WORK_ROOTS_HEADER =
  "# lively work-root 레지스트리 — 줄당 절대경로 prefix. 이 아래에서 켠 세션은 writeback 게이트가 작동.\n" +
  "# 추가/제거 자유. env LIVELY_WORK_ROOTS 로도 augment 가능.";

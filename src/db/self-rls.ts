// 배럴 — 구현은 src/db/self/self-rls.ts 로 이동했다(#1313 R48, self 특화층 분리). 소비자 import 경로 유지용.
//  (rlsReady 모듈 전역 상태는 구현 파일이 그대로 소유한다 — 배럴은 재수출만.)
export * from "./self/self-rls.js";

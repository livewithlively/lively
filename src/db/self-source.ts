// 배럴 — 구현은 src/db/self/self-source.ts 로 이동했다(#1313 R48, self 특화층 분리). 소비자 import 경로 유지용.
//  ⚠ 디렉터리 배럴(./self/index.js)이 아니라 **구현 파일에 직결**한다. index 는 self-rls·self-guard 까지
//   묶어 v6 를 끌고 오는데, 이 상수를 쓰는 쪽에는 범용 스택(policy·sources)이 섞여 있어 그 v6 무의존이
//   불변식이기 때문이다(계약: src/db/self/index.ts 헤더).
export * from "./self/self-source.js";

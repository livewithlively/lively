// coverage-version.ts — 증류기 커버리지 캐시(coverage-cache.ts)의 무효화 세대(#5147). 리프 모듈이다 —
//  레인을 저장·삭제하는 store(ingest.ts · classifiers.ts)가 이것만 물어서, store → 커버리지 계산 → store 의 순환 import 가 생기지 않는다.
let version = 0;

/** 지금 세대 — 캐시는 자기가 센 세대와 이 값이 같을 때만 옛 값을 돌려준다. */
export function coverageVersion(): number { return version; }

/** 레인(자료·카테고리 붙이기)을 저장·삭제했을 때 부른다 — 다음 요청은 옛 숫자를 받지 않는다. */
export function bumpCoverageVersion(): void { version++; }

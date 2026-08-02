// 런타임 설정(DB 단일행) → 정책 조각 로더(#1313 R46).
//  종전엔 boot/housekeeping.ts 의 두 상수와 terminal/sessions.ts 의 인라인 람다 2곳이 같은 한 줄을 복붙하고 있었다
//  (`() => getRuntimeConfig().then((c) => c.storage_policy)`). 정책 seam(effectiveStoragePolicy 등)이 로더를 주입받는
//  구조는 그대로 두고, **주입할 로더의 정의만** 여기로 모은다 — 소비자는 seam 에 이 함수를 그대로 넘긴다.
//
//  ⚠ 왜 org/policies/storage-policy.ts 가 아니라 별도 파일인가: storage-policy.ts 는 org/store(runtime-config)가
//   import 하는 seam 이다. 거기서 getRuntimeConfig 를 역-import 하면 policies ↔ store 순환이 생겨
//   scripts/check-imports.mjs 의 '순환 0' 게이트가 막는다. 이 파일은 store 를 **단방향으로만** 쓰는 얇은 조립층이다.
import { getRuntimeConfig } from "../store.js";

// 저장소 정책(#813) — 디스크 임계치·로그 상한의 단일 출처는 **관리탭(DB)**, .env 는 시드일 뿐(고객 박스는 우리가
//  못 들어가므로 env 전용이면 아무도 못 바꾼다). effectiveStoragePolicy 는 짧게 캐시하고 **DB 가 죽어도 throw 하지
//  않는다** — /readyz 가 가장 필요한 순간이 바로 DB 다운이라 그때도 디스크 판정은 나와야 한다.
export const loadStoragePolicy = () => getRuntimeConfig().then((c) => c.storage_policy);

// #1082 감사로그 보존기간
export const loadCallLogPolicy = () => getRuntimeConfig().then((c) => c.call_log_policy);

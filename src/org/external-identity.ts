// V4-P4 (P4-dedup) — 외부 정체성 도출 단일 출처(SoT).
//
//   knowledge-mirror.ts(라이브 듀얼라이트 인입)와 scripts/migrate-items-to-ku.mjs(일회성 마이그)에
//   byte-identical 로 복붙돼 있던 dedup 정체성 키 도출을 **여기 한 곳**으로 모은다(복붙 2벌→1벌).
//   동작 불변(byte-identical): 옮긴 로직은 원본 인라인과 문자 단위로 동일하며 external-identity.test.ts 가
//   골든 기대값으로 회귀를 단언한다. .mjs 는 빌드 산출물 ../dist/org/external-identity.js 를 import 한다
//   (마이그 스크립트가 이미 ../dist/* 를 import 하는 기존 패턴 그대로 — 단일 출처 공유).
//
//   포함:
//     · KIND_MAP / kindForSource(type, system) — (type,system) → kind('W'/'K') 또는 undefined(미정의=미러 skip).
//     · unitName(system, externalId) — 안정 슬러그 PK. 소문자·영숫자/_/- 외 '-'·선두 영숫자 보장·64자 상한.
//     · normalizeExternalInstance(instance) — NULL/undefined→'' 정규화(부분 UNIQUE 갭 메움, pg NULL distinct 회피).
//     · conflictKey({externalSystem,externalInstance,externalId}) — 멱등 충돌키 3필드
//       `(external_system, external_instance, external_id)` 도출(instance 정규화 포함).

// (type, system) → kind. V4-P2a: 본질 4종 R/K/H/W 로 narrow — notion doc=산출물→**K**(A 흡수, 외부수집은
//  provenance=observed 가 잡음), clickup task→W. data_source.into_kinds 와 정합. 미정의는 undefined(미러 skip).
export const KIND_MAP: Record<string, string> = {
  "task:clickup": "W",
  "doc:notion": "K",
};

// (type, system) → kind 또는 undefined(미정의 조합 — 미러 skip). 원 인라인 `KIND_MAP[`${type}:${system}`]` 와 동치.
export function kindForSource(type: string, system: string): string | undefined {
  return KIND_MAP[`${type}:${system}`];
}

// 안정 슬러그 PK — `${system}-${externalId}`. 소문자, 영숫자/_/- 외는 '-', 선두 영숫자 보장, 64자 상한.
export function unitName(system: string, externalId: string): string {
  let s = `${system}-${externalId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  if (!s || !/^[a-z0-9]/.test(s)) s = "ku-" + s; // 선두 비영숫자 방어
  return s.slice(0, 64);
}

// external_instance NULL/undefined → '' 정규화(부분 UNIQUE 중복차단 갭 메움 — pg NULL distinct 회피).
//  원 인라인 `instance == null ? "" : String(instance)` 와 동치.
export function normalizeExternalInstance(instance: unknown): string {
  return instance == null ? "" : String(instance);
}

// 멱등 충돌키 3필드 `(external_system, external_instance, external_id)`. external_instance 는 정규화('') 적용.
export function conflictKey(coord: {
  externalSystem: string;
  externalInstance?: unknown;
  externalId: string;
}): { externalSystem: string; externalInstance: string; externalId: string } {
  return {
    externalSystem: coord.externalSystem,
    externalInstance: normalizeExternalInstance(coord.externalInstance),
    externalId: coord.externalId,
  };
}

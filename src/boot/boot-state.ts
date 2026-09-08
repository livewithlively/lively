// 부팅 상태(#2578) — «포트를 열었다(listen)»와 «스키마·시딩까지 끝났다(ready)»를 가른다.
//
// ⚠ 왜 필요한가(2026-09-03 EC2 실측): /healthz 는 listen 직후부터 200 이지만 스키마 마이그레이션은 listen **뒤**
//  비동기로 돈다(housekeeping.ts DB_BOOT_STEPS). 2 vCPU 박스에서 `tenant column ready` 는 listen 보다 ~2초 늦고,
//  첫 부팅은 워크스페이스 등록부 활성화 뒤 스스로 exit(0) 해 슈퍼바이저가 다시 띄운다. 설치 스크립트가 healthz 만
//  보고 부트스트랩을 돌리면 `column "tenant_id" does not exist`(42703) 로 관리자 계정 없는 박스가 '완료'로 끝났다.
//  이 모듈이 그 사이를 /readyz 의 `schema` 로 밖에 알린다(index.ts readyz · deploy/lib/common.sh wait_ready).
//
// 상태 전이 — pending 에서 **한 번만** 나간다(뒤로도, 옆으로도 안 간다. 프로세스 수명 = 상태 수명):
//   pending ──▶ ready        DB 부팅 체인이 끝까지 돌았다(부트스트랩·업데이트 후속 작업이 안전하다).
//   pending ──▶ restarting   등록부 활성화로 곧 exit(0) 한다 — **ready 가 아니다**(다음 부팅이 ready 를 낸다).
//   pending ──▶ failed       스키마가 서기 전에 체인이 던졌다('schema init failed'). 기다려도 안 온다.
//   pending ──▶ skipped      이 프로세스는 체인을 안 돌린다(DB 없음 · 요청별 테넌시 = 매니지드 중앙 게이트웨이).
//                            기다릴 것이 없다 — pending 에 영영 걸리지 않게 명시한다.
//
// leaf — 우리 모듈 import 0. index.ts(readyz)·housekeeping.ts(체인)·ops/health.ts(게이트 판정 타입) 가 본다.
export type SchemaBootPhase = "pending" | "ready" | "restarting" | "failed" | "skipped";

let phase: SchemaBootPhase = "pending";
let changedAt = Date.now();

export function schemaBootPhase(): SchemaBootPhase { return phase; }
/** 마지막 전이 시각(ms) — readyz 에 실어 «얼마나 오래 pending 인가»를 밖에서 볼 수 있게. */
export function schemaBootChangedAt(): number { return changedAt; }

/**
 * 전이. pending 이 아니면 **무시**한다 — restarting 뒤에 체인 꼬리가 ready 를 찍거나, failed 뒤에 누가 ready 를
 *  덮는 일이 없게. 되돌리려면 프로세스를 다시 띄우는 것뿐이다(그게 이 상태의 뜻이다).
 */
export function markSchemaBoot(next: SchemaBootPhase): void {
  if (phase !== "pending" || next === "pending") return;
  phase = next;
  changedAt = Date.now();
}

/** 테스트 전용 — 프로세스 전역 상태를 되돌린다. */
export function _resetSchemaBootForTest(): void { phase = "pending"; changedAt = Date.now(); }

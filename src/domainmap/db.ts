// domainmap 엔진 DB 연결 — **통합 DB(P0+P1)**: domainmap 테이블이 items DB(ITEMS_DATABASE_URL)로
// 물리 병합돼, domainmap 엔진도 items 의 단일 풀(itemsPool)을 그대로 쓴다. 게이트웨이 메인
// DATABASE_URL(읽기전용 lively 리플리카)로는 절대 폴백하지 않는다(쓰기 통합 DB ≠ 읽기전용 리플리카).
// #1313 R10: 실체(풀 재노출 + q/one/withTx/endPool)는 db/client.ts 로 원문 이동(pg 외 무의존 leaf).
// 이 파일은 domainmap 내부 소비자·dist 참조 스크립트 호환 재수출 shim — 신규 코드는 db/client.js 를 직결한다.
export { itemsPool, q, one, withTx, endPool } from "../db/client.js";
export type { Db } from "../db/client.js";

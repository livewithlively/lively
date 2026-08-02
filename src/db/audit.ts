// db/audit.ts — db_query 의 **운영 로그라인**(pino stdout). 휘발성 관측용이다.
//  ⚠ 짝 파일 주의: 컴플라이언스 기록의 SoT 는 여기가 아니라 access-log.ts 다(db_access_log 테이블 +
//   해시체인 + fail-closed). 이름이 '감사(audit)'라 헷갈리지만, **여기는 stdout, 저기는 영속**이다.
//   '누가·언제·무엇을 조회했나'를 남겨야 하는 요구는 전부 access-log.ts 로 간다.
import { logger } from "../log.js";
import { scrubSqlLiterals } from "./sql-scrub.js";

// 모든 db_query 를 전수 기록 (사후 추적 · 이상탐지용). source 로 어느 데이터소스를 읽었는지 남긴다.
// 운영에서는 별도 감사 테이블/스트림으로 보내세요.
export function auditQuery(params: {
  userId: string;
  source: string;
  sql: string;
  rowCount: number;
  ms: number;
  ok: boolean;
  error?: string;
  masked?: number; // 마스킹된 출력 컬럼 수(#186) — 컴플라이언스 사후추적
}): void {
  // SQL 에 박힌 PII 리터럴이 로그에 잔존하지 않도록 값만 스크럽(#705) — 구조는 보존.
  logger.info({ audit: "db_query", ...params, sql: scrubSqlLiterals(params.sql) });
}

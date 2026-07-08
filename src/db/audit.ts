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

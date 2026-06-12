import { logger } from "../log.js";

// 모든 db_query 를 전수 기록 (사후 추적 · 이상탐지용).
// 운영에서는 별도 감사 테이블/스트림으로 보내세요.
export function auditQuery(params: {
  userId: string;
  sql: string;
  rowCount: number;
  ms: number;
  ok: boolean;
  error?: string;
}): void {
  logger.info({ audit: "db_query", ...params });
}

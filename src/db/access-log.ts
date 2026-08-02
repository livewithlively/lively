// db 접근 감사 경계(#746 P5) — **계약·에러형은 코어(AGPL), 해시체인 기록 구현은 Enterprise(src/ee/db/access-log.ts).**
//  감사(db_access_log)는 컴플라이언스 기록의 SoT 다. EE 미탑재(무료 배포판)면 감사 기록 기능 자체가 없다.
//  ⚠ 감사 대상 컬럼(org_db_subject_key)이 설정된 박스에서 EE 만 빠지는 상황은 db/policy.ts 가 fail-closed 로 거부한다.
//
//  AuditWriteError 가 코어에 남는 이유: tools/db.ts 가 `instanceof AuditWriteError` 로 '이미 감사 실패로 거부된
//  에러'를 구분한다. 클래스가 EE 쪽에 있으면 EE 유무에 따라 identity 가 갈려 그 분기가 조용히 깨진다.
import { ee } from "../enterprise/registry.js";

// 감사 INSERT 실패 표식 — tools/db.ts 가 이걸로 '이미 감사 실패로 거부된 에러'를 구분해 이중 기록을 피한다.
export class AuditWriteError extends Error {
  constructor(message: string) { super(message); this.name = "AuditWriteError"; }
}

// ── 조회 대상 식별자 수집 결과 ──
export interface SubjectKeyCapture { values: string[]; distinct: number; truncated: boolean }

// ── 기록 ──
export interface DbAccessRecord {
  userId: string;
  tokenHashPrefix?: string | null;
  harness?: string | null;
  op: "query" | "schema";
  source: string;
  sql?: string | null; // 원문 — 저장 전 EE 에서 리터럴 스크럽(#705)
  tables: string[];
  maskedColumns: string[];
  unmaskedColumns?: string[]; // P4 — grant 로 언마스크된 컬럼(`table.col`)
  grantIds?: unknown; // P4 — 적용된 언마스크 grant id 배열(없으면 null)
  rowCount: number;
  durationMs: number | null;
  ok: boolean;
  error?: string | null;
  subjectKeys?: Record<string, SubjectKeyCapture> | null;
}

/** 지정 subject 컬럼의 반환값 수집. EE 미탑재면 수집 대상 없음(null). */
export function collectSubjectKeys(
  fields: Array<{ name: string; srcKey?: string | null }>,
  rows: unknown[][],
  subjectOf: (srcKey: string) => string | null,
): Record<string, SubjectKeyCapture> | null {
  const h = ee().dbAudit;
  return h ? h.collectSubjectKeys(fields, rows, subjectOf) : null;
}

/** 성공 경로 — 기록 못 하면 결과를 반환하지 않는다(fail-closed). EE 미탑재면 감사 자체가 없으므로 통과. */
export async function persistAccessOrThrow(rec: DbAccessRecord): Promise<void> {
  const h = ee().dbAudit;
  if (h) await h.persistAccessOrThrow(rec);
}

/** 실패/스키마 경로 — 기록 실패해도 원래 흐름 유지(경고 로그만). */
export function persistAccessBestEffort(rec: DbAccessRecord): void {
  ee().dbAudit?.persistAccessBestEffort(rec);
}

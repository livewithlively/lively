// db 접근 감사 v1(#746 P5) — db_query/db_schema 의 '데이터 접근'을 전용 append-only 테이블
//  db_access_log 에 해시체인으로 기록한다. 기존 auditQuery(pino stdout, audit.ts)는 운영 로그로 병행 유지 —
//  이 모듈이 컴플라이언스 기록(신용정보법 R8: 누가·언제·어떤 정보를 조회했나)의 SoT 다.
//
//  위변조 방지 = 해시체인: row_hash = sha256(canonical([prev_hash, ...본문])). UPDATE/DELETE 는 DB 트리거로
//  차단(append-only 백스톱)하되, 진짜 방어는 체인 — 슈퍼유저가 트리거를 지워도 행을 고치면 이후 전 행의
//  검증(db_audit_verify)이 깨진다. 주기 검증 + (후속) 외부 앵커로 보강.
//
//  fail-closed: db_query 성공 경로는 감사 INSERT 가 성공해야 결과를 반환한다(기록 못 하면 안 보여준다).
//  items DB 는 게이트웨이 콘텐츠 스토어와 같은 DB 라 "감사만 죽는" 시나리오는 드물다. 비상 우회는
//  env DB_AUDIT_FAIL_OPEN=1 (운영자 결정 — 기본 닫힘).
//
//  subject_keys(조회 대상 식별자): 관리자가 org_db_subject_key 로 지정한 '서로게이트 키 컬럼'(고객ID 등)의
//  반환값만 상한부 수집한다 — 감사로그 자체가 PII 저장소가 되지 않게 민감 원값 컬럼은 지정하지 않는 운영 규약.
import { createHash } from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../items/store.js";
import { scrubSqlLiterals } from "./sql-scrub.js";
import { logger } from "../log.js";

export const GENESIS = "genesis"; // 체인 첫 행의 prev_hash

const MAX_ERR = 2_000; // error 메시지 보존 상한(tool-log.ts 와 동일)
const SUBJECT_VALUES_MAX = 200; // subject 컬럼당 보존하는 distinct 값 상한(초과분은 truncated 표시 + distinct 총계만)
const SUBJECT_VALUE_LEN = 128; // subject 값 하나의 보존 길이 상한

// 감사 INSERT 실패 표식 — tools/db.ts 가 이걸로 '이미 감사 실패로 거부된 에러'를 구분해 이중 기록을 피한다.
export class AuditWriteError extends Error {
  constructor(message: string) { super(message); this.name = "AuditWriteError"; }
}

export function auditFailOpen(): boolean {
  return process.env.DB_AUDIT_FAIL_OPEN === "1";
}

// 에러 문자열 스크럽 — DB 에러는 문제의 리터럴을 그대로 되쏜다(pg: invalid input syntax ... "값" / mysql:
//  Incorrect integer value: '값'). WORM 테이블(체인 — 사후 리댁션 불가)에 PII 가 박제되면 안 되므로
//  sql 리터럴 스크럽(작은따옴표·긴 숫자) + 큰따옴표 스팬("값")까지 가린다 — 에러 텍스트에선 식별자 손실보다
//  PII 잔존이 훨씬 비싸다(리뷰 blocking②). 절단(MAX_ERR)보다 먼저 수행해 값이 잘려 살아남지 않게 한다.
export function scrubErrorText(msg: string): string {
  return scrubSqlLiterals(msg).replace(/"[^"]*"/g, '"?"');
}

// ── canonical 직렬화 — jsonb 왕복(키 순서 비보존)에도 해시가 재현되도록 객체 키를 재귀 정렬한다. ──
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// 해시에 들어가는 본문 필드 — 저장 컬럼과 1:1(id 제외). 검증(db_audit_verify)이 DB 행에서 이 형태로 복원한다.
export interface HashedRowFields {
  at: string; // ISO(밀리초) — 앱이 생성해 저장·해시에 동일 문자열 사용(timestamptz 왕복 재현 가능)
  userId: string;
  tokenHashPrefix: string | null;
  harness: string | null;
  op: string; // query | schema
  source: string;
  sql: string | null; // 스크럽본
  tables: string[];
  maskedColumns: string[];
  unmaskedColumns: string[]; // P4 — grant 로 언마스크돼 raw 반환된 컬럼(`table.col`, 출력 실재분만)
  grantIds: unknown; // P4 — 그 언마스크를 연 grant id 배열(관여 grant 만), 없으면 null
  subjectKeys: unknown; // Record<table.col, SubjectKeyCapture> | null
  rowCount: number;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
}

export function computeRowHash(prevHash: string, f: HashedRowFields): string {
  const canonical = canonicalJson([
    prevHash, f.at, f.userId, f.tokenHashPrefix, f.harness, f.op, f.source, f.sql,
    f.tables, f.maskedColumns, f.unmaskedColumns, f.grantIds, f.subjectKeys,
    f.rowCount, f.durationMs, f.ok, f.error,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

// ── 조회 대상 식별자 수집(순수) — 지정 subject 컬럼(table.col)에 해당하는 출력 필드의 값을 distinct 수집. ──
export interface SubjectKeyCapture { values: string[]; distinct: number; truncated: boolean }

export function collectSubjectKeys(
  fields: Array<{ name: string; srcKey?: string | null }>,
  rows: unknown[][],
  subjectOf: (srcKey: string) => string | null, // srcKey → 지정 subject "table.col" (미지정이면 null)
): Record<string, SubjectKeyCapture> | null {
  const byKey = new Map<string, { idx: number[] }>();
  fields.forEach((f, i) => {
    if (!f.srcKey) return;
    const subj = subjectOf(f.srcKey);
    if (!subj) return;
    const e = byKey.get(subj) ?? { idx: [] };
    e.idx.push(i);
    byKey.set(subj, e);
  });
  if (byKey.size === 0) return null;
  const out: Record<string, SubjectKeyCapture> = {};
  for (const [subj, { idx }] of byKey) {
    const set = new Set<string>();
    for (const row of rows) {
      for (const i of idx) {
        const v = row[i];
        if (v === null || v === undefined) continue;
        set.add(String(v).slice(0, SUBJECT_VALUE_LEN));
      }
    }
    out[subj] = {
      values: [...set].slice(0, SUBJECT_VALUES_MAX),
      distinct: set.size,
      truncated: set.size > SUBJECT_VALUES_MAX,
    };
  }
  return out;
}

// ── 기록 ──
export interface DbAccessRecord {
  userId: string;
  tokenHashPrefix?: string | null;
  harness?: string | null;
  op: "query" | "schema";
  source: string;
  sql?: string | null; // 원문 — 저장 전 여기서 리터럴 스크럽(#705)
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

interface Queryable { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

// 체인 INSERT 한 건 — advisory xact lock 으로 체인 선형화(동시 db_query 에도 prev_hash 경합 없음).
//  트랜잭션은 이 함수가 소유(BEGIN..COMMIT). 목 클라이언트로 단위테스트 가능하도록 client 를 받는다.
export async function writeAccessRow(client: Queryable, rec: DbAccessRecord, atIso?: string): Promise<void> {
  const at = atIso ?? new Date().toISOString();
  const f: HashedRowFields = {
    at,
    userId: rec.userId,
    tokenHashPrefix: rec.tokenHashPrefix ?? null,
    harness: rec.harness ?? null,
    op: rec.op,
    source: rec.source,
    sql: rec.sql ? scrubSqlLiterals(rec.sql) : null,
    tables: rec.tables,
    maskedColumns: rec.maskedColumns,
    unmaskedColumns: rec.unmaskedColumns ?? [],
    grantIds: rec.grantIds ?? null,
    subjectKeys: rec.subjectKeys ?? null,
    rowCount: rec.rowCount,
    durationMs: rec.durationMs === null ? null : Math.round(rec.durationMs),
    ok: rec.ok,
    error: rec.error ? scrubErrorText(String(rec.error)).slice(0, MAX_ERR) : null,
  };
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('db_access_log'))");
    const last = await client.query("SELECT row_hash FROM db_access_log ORDER BY id DESC LIMIT 1");
    const prev = (last.rows[0]?.row_hash as string | undefined) ?? GENESIS;
    const rowHash = computeRowHash(prev, f);
    await client.query(
      `INSERT INTO db_access_log(at, user_id, token_hash_prefix, harness, op, source, sql, tables,
         masked_columns, unmasked_columns, grant_ids, subject_keys, row_count, duration_ms, ok, error, prev_hash, row_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
      [
        f.at, f.userId, f.tokenHashPrefix, f.harness, f.op, f.source, f.sql,
        JSON.stringify(f.tables), JSON.stringify(f.maskedColumns), JSON.stringify(f.unmaskedColumns),
        f.grantIds === null ? null : JSON.stringify(f.grantIds),
        f.subjectKeys === null ? null : JSON.stringify(f.subjectKeys),
        f.rowCount, f.durationMs, f.ok, f.error, prev, rowHash,
      ],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* 이미 실패 — 정리 시도만 */ });
    throw e;
  }
}

// 한 건 기록(itemsPool) — 실패는 AuditWriteError 로 승격(호출측이 fail-closed/open 판단).
export async function recordDbAccess(rec: DbAccessRecord): Promise<void> {
  // items DB 미설정 개발환경 — 외부 소스 등록 자체가 불가(SoT=DB)라 감사할 접근도 없다. 조용히 스킵.
  if (!process.env.ITEMS_DATABASE_URL) return;
  let client: pg.PoolClient;
  try {
    client = await itemsPool.connect();
  } catch (e) {
    throw new AuditWriteError(`감사 저장소 연결 실패: ${(e as Error).message}`);
  }
  try {
    await writeAccessRow(client as unknown as Queryable, rec);
  } catch (e) {
    throw new AuditWriteError(`감사 기록 실패: ${(e as Error).message}`);
  } finally {
    client.release();
  }
}

// db_query/db_schema 배선용 — fail-closed 정책을 한 곳에 모은다.
//  성공 경로: await persistAccessOrThrow(rec) — 실패 시 AuditWriteError throw(결과 미반환).
//  실패/스키마 경로: persistAccessBestEffort(rec) — 실패해도 원래 흐름 유지(경고 로그만).
export async function persistAccessOrThrow(rec: DbAccessRecord): Promise<void> {
  try {
    await recordDbAccess(rec);
  } catch (e) {
    if (auditFailOpen()) {
      logger.error({ err: e, source: rec.source, user: rec.userId }, "db_access_log 기록 실패 — DB_AUDIT_FAIL_OPEN=1 이라 결과는 반환(감사 공백)");
      return;
    }
    throw new AuditWriteError(
      "데이터 접근 감사 기록 실패 — 안전을 위해 결과를 반환하지 않습니다(운영자: items DB 상태 확인, 비상 우회 env DB_AUDIT_FAIL_OPEN=1)",
    );
  }
}

export function persistAccessBestEffort(rec: DbAccessRecord): void {
  recordDbAccess(rec).catch((err) =>
    logger.warn({ err, source: rec.source, user: rec.userId, op: rec.op }, "db_access_log 기록 실패(best-effort 경로 — 무시)"),
  );
}

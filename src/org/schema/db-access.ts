// org 스키마 조각 — db-access: db_query 데이터 접근 통제. org_db_source(소스 레지스트리)·
//  org_db_table_policy(테이블 허용/차단)·org_db_column_mask(PII 마스킹)·org_db_subject_key(조회 대상 키)·
//  org_db_unmask_grant(언마스크 권한)·db_access_log(append-only 해시체인 감사).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initDbAccessPolicies(pool: Pool): Promise<void> {
  // ── org_db_source — db_query/db_schema 가 읽는 외부 데이터소스 레지스트리(웹 관리). ──
  // 시크릿 금지: url 은 비밀번호 없는 접속문자열, 인증은 auth_mode(password|iam|mtls|vault) + auth_ref(참조: env 이름/
  //  파일경로/role/path)만. 실제 비번 등은 런타임에 참조에서 해소(src/db/sources.ts resolveConnectionString).
  //  env(DB_SOURCES_JSON) 소스와 병합되며, 여기 행은 무재시작 반영(db_query 가 매 호출 읽음 + 캐시 무효화).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_db_source(
      name TEXT PRIMARY KEY,
      driver TEXT NOT NULL DEFAULT 'postgres',
      url TEXT,
      auth_mode TEXT NOT NULL DEFAULT 'password',
      auth_ref TEXT,
      rls TEXT,
      max_rows INT,
      timeout_ms INT,
      note TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      -- #715: driver 제약 확장(postgres→postgres|mysql). 구버전 pg-only chk 가 있으면 교체(멱등).
      IF EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_driver_chk'
                   AND pg_get_constraintdef(oid) NOT ILIKE '%mysql%') THEN
        ALTER TABLE org_db_source DROP CONSTRAINT org_db_source_driver_chk;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_driver_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_driver_chk CHECK (driver IN ('postgres','mysql'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_auth_mode_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_auth_mode_chk
          CHECK (auth_mode IN ('password','iam','mtls','vault'));
      END IF;
    END $$;
  `);

  // ── org_db_source 확장: 소스별 테이블 '기본자세'(#186). 'allow'=deny-list(후방호환 — 명시 deny만 차단) /
  //  'deny'=allow-list(개인정보 컴플라이언스 — 명시 allow만 허용, 신규 테이블 자동노출 방지). 기존 소스 무변경 위해 기본 allow. ──
  await pool.query(`
    ALTER TABLE org_db_source ADD COLUMN IF NOT EXISTS table_default TEXT NOT NULL DEFAULT 'allow';
    ${ensureCheck("org_db_source", { org_db_source_table_default_chk: "table_default IN ('allow','deny')" })}
  `);

  // ── org_db_table_policy — db_query 대상 소스의 '테이블별 조회 허용/차단'(웹 관리, #186). ──
  //  라이브 스키마(information_schema) 위 오버레이 — 스키마 사본은 저장 안 함(쉬프트 드리프트 원천 없음), 여기엔 정책(on/off)만.
  //  effective(t) = 정책행 있으면 그 mode, 없으면 org_db_source.table_default. 쉬프트로 사라진 테이블 행 = 무해한 고아(무시).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_db_table_policy(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'deny',
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name));
    ${ensureCheck("org_db_table_policy", { org_db_table_policy_mode_chk: "mode IN ('allow','deny')" })}
  `);

  // ── org_db_column_mask — 개인정보 컬럼 마스킹 정책(웹 관리, 컴플라이언스, #186). 라이브 스키마 위 오버레이. ──
  //  집행은 게이트웨이가 결정론적으로(고객 DB 무수정): 게이트1(AST 파생차단)+게이트2(출처기반 결과 마스킹, src/db/firewall.ts·tools/db.ts).
  //  style: full(전체) | partial(부분) | email(로컬부) | hash(sha256) | null(널).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_db_column_mask(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'full',
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name, column_name));
    ${ensureCheck("org_db_column_mask", { org_db_column_mask_style_chk: "style IN ('full','partial','email','hash','null')" })}
  `);

  // ── org_db_subject_key — db 접근 감사(P5, #746)의 '조회 대상 식별자' 컬럼 지정(웹/REST 관리). ──
  //  관리자가 소스별로 '이 컬럼 값 = 조회 대상의 서로게이트 키(고객ID 등)'를 지정하면, db_query 가 그 컬럼의
  //  반환값을 db_access_log.subject_keys 에 상한부 수집한다(신용정보법 R8 '누구의 정보를 조회했나').
  //  ⚠ 운영 규약: 민감 원값 컬럼(주민번호·계좌 등)은 지정 금지 — 감사로그가 PII 저장소가 되면 안 된다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_db_subject_key(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name, column_name));
  `);

  // ── org_db_unmask_grant — raw-PII 언마스크 권한(P4, #746). 직무 RBAC + JIT(만료) + maker-checker(승인자 기록). ──
  //  기본은 전원 마스킹(#186/#705). 이 grant 를 받은 멤버만 지정 (source, table, column) 을 raw 로 조회한다.
  //  column='*' = 그 테이블의 모든 마스킹 컬럼 언마스크(편의). effective = revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()).
  //  집행: db_query 가 요청 userId 의 유효 grant 를 해소해 그 컬럼을 마스킹 대상에서 per-user 차감(Gate1/Gate2 자동 정합).
  //  언마스크 조회는 db_access_log 에 unmasked_columns·grant_ids 로 구분 기록(P5). FK 없음(정책 오버레이 — 소스 연결 전 사전작성 가능).
  //  ⚠ expires_at NULL(무기한)은 지양 — JIT 원칙상 기간 제한 권장. approved_by ≠ member_id 권장(maker-checker).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_db_unmask_grant(
      id BIGSERIAL PRIMARY KEY,
      member_id TEXT NOT NULL,
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL DEFAULT '*',
      reason TEXT,
      approved_by TEXT,
      granted_by TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT);
    CREATE INDEX IF NOT EXISTS org_db_unmask_grant_lookup_idx
      ON org_db_unmask_grant(member_id, source) WHERE revoked_at IS NULL;
  `);

  // ── db_access_log — 데이터 접근 감사(P5, #746). append-only + 해시체인(위변조 증거). ──
  //  db_query(성공·차단·실패)와 db_schema 접근을 전건 기록한다. 기록 실패 시 db_query 는 fail-closed
  //  (결과 미반환 — 비상 우회 env DB_AUDIT_FAIL_OPEN=1). 쓰기 단일 진입점 = src/db/access-log.ts(advisory lock 으로 체인 선형화).
  //  row_hash = sha256(canonical([prev_hash, at, user_id, …])) — UPDATE/DELETE/TRUNCATE 는 트리거로 차단하되,
  //  진짜 방어는 체인(db_audit_verify 가 재계산 검증 — 슈퍼유저가 행을 고치면 이후 전 행이 깨진다).
  //  sql 은 리터럴 스크럽본(#705, PII 미잔존). subject_keys 는 org_db_subject_key 지정 컬럼의 반환값 상한부 수집.
  //  unmasked_columns/grant_ids 는 P4(언마스크 게이트) 예약 — v1 에선 항상 []/null.
  //  보존정책: v1 무제한(컴플라이언스 기록 — prune 하지 않는다). 성장 시 파티셔닝/아카이브를 별도 설계.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS db_access_log(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      user_id TEXT NOT NULL,
      token_hash_prefix TEXT,
      harness TEXT,
      op TEXT NOT NULL DEFAULT 'query',
      source TEXT NOT NULL,
      sql TEXT,
      tables JSONB NOT NULL DEFAULT '[]'::jsonb,
      masked_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      unmasked_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      grant_ids JSONB,
      subject_keys JSONB,
      row_count INT NOT NULL DEFAULT 0,
      duration_ms INT,
      ok BOOLEAN NOT NULL,
      error TEXT,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS db_access_log_at_idx ON db_access_log(at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_user_at_idx ON db_access_log(user_id, at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_source_at_idx ON db_access_log(source, at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_tables_gin ON db_access_log USING GIN (tables);
    ${ensureCheck("db_access_log", { db_access_log_op_chk: "op IN ('query','schema')" })}
    CREATE OR REPLACE FUNCTION db_access_log_block_mutation() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'db_access_log is append-only (P5 감사 — 수정/삭제 불가)'; RETURN NULL; END
    $fn$ LANGUAGE plpgsql;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='db_access_log_immutable' AND tgrelid='db_access_log'::regclass) THEN
        CREATE TRIGGER db_access_log_immutable BEFORE UPDATE OR DELETE ON db_access_log
          FOR EACH ROW EXECUTE FUNCTION db_access_log_block_mutation();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='db_access_log_no_truncate' AND tgrelid='db_access_log'::regclass) THEN
        CREATE TRIGGER db_access_log_no_truncate BEFORE TRUNCATE ON db_access_log
          FOR EACH STATEMENT EXECUTE FUNCTION db_access_log_block_mutation();
      END IF;
    END $$;
  `);
}

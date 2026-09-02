// domainmap 스키마 init — store-core.mjs init() verbatim 이식(DDL 문자열 무수정).
// 10개 테이블 + UNIQUE 제약 + provenance 부분 유니크 인덱스 + state CHECK(pg_constraint 프로브 멱등)
// + code_unit/repo/project 마이그레이션 컬럼. 반환 문자열 'initialized schema' 도 계약(CLI 출력).
import { itemsPool } from "../db.js";

export async function init(): Promise<string> {
  const pool = itemsPool;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS repo(
    id SERIAL PRIMARY KEY, name TEXT UNIQUE, root_path TEXT,
    detected_stack JSONB, created_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS scan_run(
    id SERIAL PRIMARY KEY, repo_id INT, runbook TEXT, harness TEXT,
    actor_type TEXT, actor_id TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, summary JSONB);
  -- v6 드랍(2026-06-24): domain 테이블 폐기 → category(v6/schema.ts). 스캔 write·읽기·CRUD 전부 category 로 cutover.
  CREATE TABLE IF NOT EXISTS code_unit(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, path TEXT, label TEXT,
    created_at TIMESTAMPTZ, UNIQUE(repo_id, path));
  CREATE TABLE IF NOT EXISTS data_entity(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, name TEXT, source TEXT,
    created_at TIMESTAMPTZ, UNIQUE(repo_id, kind, name, source));
  -- v6 드랍(2026-06-24): mapping 은 category_id 로 착지(v6/schema.ts ALTER + mapping_target_category_uq). 구 domain_id 컬럼·유니크 제거.
  CREATE TABLE IF NOT EXISTS mapping(
    id SERIAL PRIMARY KEY, repo_id INT, target_kind TEXT, target_id INT,
    origin TEXT, confidence REAL, status TEXT DEFAULT 'confirmed',
    run_id INT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS debt_finding(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, title TEXT, detail TEXT,
    cited_refs JSONB, status TEXT DEFAULT 'open', origin TEXT, run_id INT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(repo_id, title));
  CREATE TABLE IF NOT EXISTS change_log(
    id SERIAL PRIMARY KEY, repo_id INT, entity_type TEXT, entity_id INT,
    op TEXT, actor_type TEXT, actor_id TEXT, run_id INT, at TIMESTAMPTZ,
    before JSONB, after JSONB, note TEXT);
  `);
  // ---- migrations (idempotent; DB already has data, so ALTER ... ADD COLUMN IF
  // NOT EXISTS rather than re-CREATE). Supports incremental refresh (state-aware
  // code_units + per-repo refresh checkpoint). Safe to run repeatedly.
  await pool.query(`
  ALTER TABLE code_unit ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'active';
  ALTER TABLE code_unit ADD COLUMN IF NOT EXISTS prev_path TEXT;
  ALTER TABLE code_unit ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
  ALTER TABLE repo ADD COLUMN IF NOT EXISTS last_refreshed_sha TEXT;
  -- Webhook-driven refresh: the box clones/fetches each repo from git_url and runs
  -- the deterministic refresh on push. git_url MAY embed a credential token for
  -- private repos (the org configures it in the DB) — it is NEVER logged or returned.
  ALTER TABLE repo ADD COLUMN IF NOT EXISTS git_url TEXT;
  ALTER TABLE repo ADD COLUMN IF NOT EXISTS default_branch TEXT DEFAULT 'main';
  `);
  // (P8: project/project_touch + provenance_kind/uq/state_chk DDL 제거 — initiative 드롭·task→W 만 유지.)
  // v6 드랍(2026-06-24): domain 의 state/space CHECK·유니크인덱스·business 시드 DDL 전부 폐기(테이블 자체 드랍).
  //  통제어휘(gtm·가격·펀딩 등)는 category 로 이행 완료 — v6/schema.ts·v6-migrate 가 소유(#1631: space 축 자체가 폐기).
  // ── P-V3-4a: repo CRUD lifecycle ──
  // repo.state: repo_deprecate 가 쓰는 lifecycle 축. NULL=active(pre-migration 행). repo 는 cross-DB
  //  cascade 가 없는 도메인맵 자기완결 엔티티라 컬럼 추가만으로 충분(deprecate=숨김 신호, 삭제 아님).
  await pool.query(`ALTER TABLE repo ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'active';`);
  await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='repo'::regclass AND conname='repo_state_chk') THEN
      ALTER TABLE repo ADD CONSTRAINT repo_state_chk
        CHECK (state IS NULL OR state IN ('active','deprecated'));
    END IF;
  END $$;
  `);
  // v6 드랍(2026-06-24): domain_alias(소프트별칭) 폐기 — 단일 DB라 category.key 직접 변경(별칭 불요). 테이블 드랍.
  // #1313 R23 적출: activity/activity_touch/dash_watch DDL + change_log.activity_id → src/activity/schema.ts.
  //  (게이트웨이 전역 이벤트 레이어지 스캔 엔진 테이블이 아니다. boot/schemas.ts 가 이 init 직후 initActivitySchema 를 부른다.)
  // v6 드랍(2026-06-24): 레거시 테이블·컬럼 명시 드랍(DDL 제거 후 잔존/재생성 정리). category·activity_knowledge·project 가 진실원천.
  //  멱등: IF EXISTS. activity_task→activity.project_id, activity_ku_ref→activity_knowledge, mapping.domain_id→category_id(v6/schema.ts) 로 대체됨.
  await pool.query(`ALTER TABLE mapping DROP CONSTRAINT IF EXISTS mapping_repo_id_target_kind_target_id_domain_id_key;`);
  await pool.query(`ALTER TABLE mapping DROP COLUMN IF EXISTS domain_id;`);
  // evidence — 매핑 판단 근거(LLM/사람)를 행에 영속(change_log 감사와 별개로 queryable). 2026-06-26.
  await pool.query(`ALTER TABLE mapping ADD COLUMN IF NOT EXISTS evidence TEXT;`);
  await pool.query(`DROP TABLE IF EXISTS activity_task;`);
  await pool.query(`DROP TABLE IF EXISTS activity_ku_ref;`);
  await pool.query(`DROP TABLE IF EXISTS domain_alias;`);
  await pool.query(`DROP TABLE IF EXISTS domain;`);
  return "initialized schema";
}

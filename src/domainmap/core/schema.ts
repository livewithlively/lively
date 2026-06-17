// domainmap 스키마 init — store-core.mjs init() verbatim 이식(DDL 문자열 무수정).
// 10개 테이블 + UNIQUE 제약 + provenance 부분 유니크 인덱스 + state CHECK(pg_constraint 프로브 멱등)
// + code_unit/repo/project 마이그레이션 컬럼. 반환 문자열 'initialized schema' 도 계약(CLI 출력).
import { dmPool } from "../db.js";

export async function init(): Promise<string> {
  const pool = dmPool();
  await pool.query(`
  CREATE TABLE IF NOT EXISTS repo(
    id SERIAL PRIMARY KEY, name TEXT UNIQUE, root_path TEXT,
    detected_stack JSONB, created_at TIMESTAMPTZ, last_scan_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS scan_run(
    id SERIAL PRIMARY KEY, repo_id INT, runbook TEXT, harness TEXT,
    actor_type TEXT, actor_id TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, summary JSONB);
  CREATE TABLE IF NOT EXISTS domain(
    id SERIAL PRIMARY KEY, repo_id INT, key TEXT, name TEXT, description TEXT,
    state TEXT DEFAULT 'active', cross_cutting BOOLEAN DEFAULT false,
    origin TEXT, status TEXT DEFAULT 'confirmed', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    UNIQUE(repo_id, key));
  CREATE TABLE IF NOT EXISTS code_unit(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, path TEXT, label TEXT,
    created_at TIMESTAMPTZ, UNIQUE(repo_id, path));
  CREATE TABLE IF NOT EXISTS data_entity(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, name TEXT, source TEXT,
    created_at TIMESTAMPTZ, UNIQUE(repo_id, kind, name, source));
  CREATE TABLE IF NOT EXISTS mapping(
    id SERIAL PRIMARY KEY, repo_id INT, target_kind TEXT, target_id INT,
    domain_id INT, origin TEXT, confidence REAL, status TEXT DEFAULT 'confirmed',
    run_id INT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    UNIQUE(repo_id, target_kind, target_id, domain_id));
  CREATE TABLE IF NOT EXISTS debt_finding(
    id SERIAL PRIMARY KEY, repo_id INT, kind TEXT, title TEXT, detail TEXT,
    cited_refs JSONB, status TEXT DEFAULT 'open', origin TEXT, run_id INT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(repo_id, title));
  CREATE TABLE IF NOT EXISTS project(
    id SERIAL PRIMARY KEY, repo_id INT, key TEXT, name TEXT, description TEXT,
    kind TEXT, status TEXT DEFAULT 'confirmed', origin TEXT,
    started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, source_ref TEXT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(repo_id, key));
  CREATE TABLE IF NOT EXISTS project_touch(
    id SERIAL PRIMARY KEY, repo_id INT, target_kind TEXT, target_id INT,
    project_id INT, commit_count INT, first_at TIMESTAMPTZ, last_at TIMESTAMPTZ,
    origin TEXT, created_at TIMESTAMPTZ, UNIQUE(repo_id, target_kind, target_id, project_id));
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
  -- PM-tool project provenance (설계결정 2026-06-11 §1-②). lifecycle 'state'(tool truth:
  -- active|completed|archived|cancelled)는 curation 'status'(proposed|confirmed)와 별개 축.
  ALTER TABLE project ADD COLUMN IF NOT EXISTS prov_system TEXT;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS prov_instance TEXT;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS external_id TEXT;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS external_url TEXT;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS state TEXT;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS fields JSONB;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS raw JSONB;
  ALTER TABLE project ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
  `);
  // Provenance dedup: one project row per (prov_system, prov_instance, external_id).
  // NULLS NOT DISTINCT (PG15+) closes the prov_instance=NULL dup hole; partial WHERE
  // keeps the 45 doc-derived rows (external_id IS NULL) entirely outside the index.
  await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS project_provenance_uq
    ON project(prov_system, prov_instance, external_id) NULLS NOT DISTINCT
    WHERE external_id IS NOT NULL;
  `);
  // project.state lifecycle enum CHECK — 앱 레벨 SYNC_STATES 검증과 별개로 아웃오브밴드 SQL 의
  // 엉뚱한 state 를 DB 불변식으로 차단(items 스토어의 CHECK 마이그레이션과 같은 pg_constraint 프로브 멱등).
  await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='project'::regclass AND conname='project_state_chk') THEN
      ALTER TABLE project ADD CONSTRAINT project_state_chk
        CHECK (state IS NULL OR state IN ('active','completed','archived','cancelled'));
    END IF;
  END $$;
  `);
  // domain.state lifecycle CHECK — 컬럼은 이미 존재(active 기본). 'merged' 는 mergeDomains 가
  // 라이브로 쓰는 값이라 반드시 포함, 'deprecated' 는 ⑤ lifecycle 추가분. NULL 허용(pre-migration 행).
  await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='domain'::regclass AND conname='domain_state_chk') THEN
      ALTER TABLE domain ADD CONSTRAINT domain_state_chk
        CHECK (state IS NULL OR state IN ('active','merged','deprecated'));
    END IF;
  END $$;
  `);
  // ── P-V3-4a: repo CRUD lifecycle + domain rename soft-alias(H3) ──
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
  // domain_alias: soft-alias 매핑(repo_id, old_key → new_key). domain_rename 이 물리 domain.key 를
  //  건드리지 않는 이유(H3): items DB(knowledge_unit.domain_key 약결합 슬러그)와 domainmap DB 는 별 DB라
  //  cross-DB 트랜잭션 불가 — 물리 key 를 바꾸면 items 쪽 매핑이 원자적으로 못 따라온다. 대신 물리 key 는
  //  고정하고, 표시명(domain.name)만 갱신하며 (old_key → new_key) 별칭만 적재한다. 읽기/검증이 alias 를
  //  해소(resolveDomainKey)해 옛 슬러그가 가리키던 도메인을 계속 찾는다. UNIQUE(repo_id, old_key) —
  //  한 옛키는 한 곳만 가리킨다. new_key 는 domain.key(물리) 와 같을 수도, 더 옛 별칭일 수도(체인) 있어
  //  resolveDomainKey 가 사이클 가드와 함께 해소한다.
  await pool.query(`
  CREATE TABLE IF NOT EXISTS domain_alias(
    id SERIAL PRIMARY KEY, repo_id INT NOT NULL,
    old_key TEXT NOT NULL, new_key TEXT NOT NULL, created_at TIMESTAMPTZ,
    UNIQUE(repo_id, old_key));
  `);
  return "initialized schema";
}

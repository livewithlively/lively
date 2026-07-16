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
  -- v6 드랍(2026-06-24): domain 테이블 폐기 → category(space='product', v6/schema.ts). 스캔 write·읽기·CRUD 전부 category 로 cutover.
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
  //  business 통제어휘(gtm·가격·펀딩 등)는 category(space='business')로 이행 완료 — v6/schema.ts·v6-migrate 가 소유.
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
  // ── 작업(Activity) 모델 (통합 DB 신설 P2) — domainmap 구조(is)와 ku(should/맥락)를 잇는 이벤트 레이어. ──
  //  과업(Task)=project(level='task', v6)이고, '작업'은 과업을 향해 실제로 한 행위(이벤트)다.
  //  type=작업의 성격(feature/fix/decision/docs/research/review/chore/other, 프로젝트 #182). 커밋은 유형이 아니라
  //  commit_sha 존재(commit_occurred 파생)로 표현 — 어떤 유형이든 commit_sha+activity_touch 로 code_unit 연결 → is 갱신.
  //  external_* 로 PM 미러 가능(출처=external_system). 한 트랜잭션(withTx=itemsPool)에서 activity +
  //  activity_touch(코드)를 원자 기록. v6: 과업 링크=activity.project_id, 지식 참조=activity_knowledge(v6/schema.ts).
  //  *_review = 3-state('na'|'checked_no_change'|'changed') — "점검했으나 수정 안 됨"을 안 한 것과 구분 명시기록.
  //  author_person=토큰 신원, author_agent='어떤 AI'(모델/세션 — 하네스가 activity_log 인자로 명시 전달).
  await pool.query(`
  CREATE TABLE IF NOT EXISTS activity(
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    body TEXT,
    author_person TEXT,
    author_agent TEXT,
    session_id TEXT,
    repo_id INT,
    commit_sha TEXT,
    committed_at TIMESTAMPTZ,
    external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
    should_review TEXT NOT NULL DEFAULT 'na',
    is_review TEXT NOT NULL DEFAULT 'na',
    created_at TIMESTAMPTZ);
  -- v6 드랍(2026-06-24): activity_task(→project_id)·activity_ku_ref(→activity_knowledge, v6/schema.ts) 폐기.
  --  과업 링크=activity.project_id 스칼라, 지식 참조=activity_knowledge(→knowledge). 구 테이블은 knowledge_unit FK 라 제거.
  CREATE TABLE IF NOT EXISTS activity_touch(
    id SERIAL PRIMARY KEY,
    activity_id INT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL, target_id INT NOT NULL,
    created_at TIMESTAMPTZ,
    UNIQUE(activity_id, target_kind, target_id));
  CREATE TABLE IF NOT EXISTS dash_watch(
    owner TEXT NOT NULL,
    member_id TEXT NOT NULL,
    sort INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ,
    PRIMARY KEY(owner, member_id));
  `);
  // external 멱등 — PM 코멘트 라운드트립(comment:clickup) dedup. external_id 보유 행만(부분), NULLS NOT
  //  DISTINCT(PG15+)로 instance=NULL 중복 구멍 차단. knowledge/project 외부키 인덱스와 동형.
  await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS activity_external_uq
    ON activity(external_system, external_instance, external_id) NULLS NOT DISTINCT
    WHERE external_id IS NOT NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_author_idx ON activity(author_person, author_agent);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_committed_idx ON activity(committed_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_repo_idx ON activity(repo_id);`);
  // #852 session_id 역방향 조회('이 세션이 무슨 작업을 했나') — 여태 인덱스도 필터도 없어 사실상 쓰기 전용이었다.
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_session_idx ON activity(session_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_touch_target_idx ON activity_touch(target_kind, target_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dash_watch_owner_idx ON dash_watch(owner);`);
  // summary — 비개발자도 한눈에 읽는 쉬운 한 줄(겉에 노출). title 은 기술 상세(펼침). 기존 DB 보강(신규 설치는 위 DDL).
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS summary TEXT;`);
  // 작업 유형(type) 재정립(2026-06-26, 프로젝트 #182) — type = "이 작업이 무엇인가"(성격). 8종:
  //  feature(기능개발)·fix(오류수정)·decision(의사결정)·docs(문서작성)·research(리서치·조사)·
  //  review(검토·리뷰)·chore(운영·잡무: 배포·리팩토링·의존성)·other(기타). 'commit' 은 더 이상 유형이 아니다
  //  — 커밋 발생은 commit_sha 존재(아래 commit_occurred 파생컬럼)로 표현하고, 어떤 유형이든 커밋 메타를 동반할 수 있다.
  //  구 comment/status_change(PM 미러 유형)는 폐기 — 미러 출처는 external_system 이 식별한다.
  // commit_occurred — "커밋이 발생했나" 파생(생성)컬럼 = commit_sha 존재. 조회·집계 편의용, 별도 동기화 불요(STORED, PG12+).
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS commit_occurred BOOLEAN GENERATED ALWAYS AS (commit_sha IS NOT NULL) STORED;`);
  // type CHECK — 신(8종)으로 교체. 구 CHECK(정의에 'commit' 포함) 잔존 시 레거시 행을 새 어휘로 1회 remap 후 스왑.
  //  멱등·자가치유: 신규 설치(제약 없음)는 바로 8종 추가, 이미 이관된 DB(정의에 'commit' 없음)는 무변.
  //  ⚠ 순서: 제약을 먼저 DROP 한 뒤 remap 한다 — 구 CHECK 가 살아있는 채로 'feature'/'other' 로 UPDATE 하면 제약 위반.
  await pool.query(`
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_type_chk'
               AND pg_get_constraintdef(oid) LIKE '%commit%') THEN
      ALTER TABLE activity DROP CONSTRAINT activity_type_chk;
      UPDATE activity SET type='feature' WHERE type='commit';          -- 커밋 작업(commit_sha 보존) → 기능개발(휴리스틱)
      UPDATE activity SET type='other'   WHERE type IN ('comment','status_change'); -- 구 PM 미러 → 기타(external_system 이 출처 식별)
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_type_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_type_chk
        CHECK (type IN ('feature','fix','decision','docs','research','review','chore','other'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_should_review_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_should_review_chk
        CHECK (should_review IN ('na','checked_no_change','changed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_is_review_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_is_review_chk
        CHECK (is_review IN ('na','checked_no_change','changed'));
    END IF;
  END $$;
  `);
  // change_log.activity_id — 이 변경을 유발한 작업 귀속(누가/왜). FK 없이 plain INT(change_log 의
  //  (entity_type,entity_id) FK-less 관성 유지 — 과거 project 감사행도 NULL 로 안전).
  await pool.query(`ALTER TABLE change_log ADD COLUMN IF NOT EXISTS activity_id INT;`);
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

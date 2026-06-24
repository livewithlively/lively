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
    origin TEXT, status TEXT DEFAULT 'confirmed', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
    -- area 탈-repo(V5): domain 유니크는 (space,key) — 부분유니크 인덱스로 아래에서 건다(merged 제외).
    --  옛 인라인 UNIQUE(repo_id,key) 는 repo_id NULL(business 조직평면)을 distinct 취급해 멱등을 깨므로 폐기.
    --  CREATE TABLE 인라인이 아닌 별도 인덱스인 이유: 부분(WHERE state<>'merged')·NULL-merge 의미가 필요.
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
  // ── V4-P1 area 2단(B): domain.space — 주제(area)의 상위 축. ──
  //  space='product'  = 코드앵커·부채추적·CRUD 를 갖는 제품 도메인(domainmap 본래 의미, 31행 전부 이쪽).
  //  space='business' = 코드매핑 없는 비즈니스 기능(gtm·가격·펀딩·시장경쟁·브랜드·조직) — vocab-only.
  //  provenance_kind ADD 패턴 재사용(비파괴·멱등): ① ADD COLUMN DEFAULT 'product' → ② 기존행 백필
  //  (DEFAULT 가 신규행만 채우므로 NULL 일 수 있는 기존행을 명시 백필) → ③ 백필 후 CHECK(순서 강제 —
  //  enum 밖 행이 있으면 ADD CONSTRAINT throw). 코드매핑/부채/touch 는 space 와 무관(product 만 git
  //  스캔으로 채워짐). business 시드6 은 아래 블록이 repo_id=NULL(조직평면) 로 직삽입한다(키 전역 멱등·V5 탈-repo).
  await pool.query(`ALTER TABLE domain ADD COLUMN IF NOT EXISTS space TEXT DEFAULT 'product';`);
  await pool.query(`UPDATE domain SET space='product' WHERE space IS NULL;`);
  await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='domain'::regclass AND conname='domain_space_chk') THEN
      ALTER TABLE domain ADD CONSTRAINT domain_space_chk
        CHECK (space IS NULL OR space IN ('product','business'));
    END IF;
  END $$;
  `);
  // ── area 탈-repo(V5): domain 유니크를 (space,key) 부분유니크 인덱스로 승격 + 옛 UNIQUE(repo_id,key) 폐기. ──
  //  순서(부팅 멱등): ① (space,key) 부분유니크 인덱스 생성(merged 제외 — 활성 도메인이 merged 잔재와 충돌 안 함,
  //   NULL repo_id 무관 멱등) → ② 옛 자동제약 domain_repo_id_key_key 존재 시 DROP(pg_constraint 프로브) →
  //   ③ business 시드는 인덱스 생성 후(아래) — 부분유니크 + NOT EXISTS 가드가 함께 성립해야 멱등.
  //  이 인덱스가 product/business 양쪽을 (space,key)로 못박아 repo_id 유무(business=NULL 조직평면)와 무관하게
  //   멱등을 보장한다(옛 UNIQUE 는 NULL 을 distinct 취급해 business 멱등을 깼다).
  await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS domain_space_key_uq ON domain(space, key) WHERE state <> 'merged';
  `);
  await pool.query(`
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid='domain'::regclass AND conname='domain_repo_id_key_key') THEN
      ALTER TABLE domain DROP CONSTRAINT domain_repo_id_key_key;
    END IF;
  END $$;
  `);
  // ── business 시드6(B): space='business' 통제어휘 도메인행(코드매핑 없음 — §B vocab-only).
  //  **고객-불변·탈-repo(V5)**: business 는 조직평면 area 라 코드 레포에 귀속되지 않는다 → repo_id=NULL 직삽입.
  //   (옛 코드는 라이블리 내부 레포명('productivity')에 하드코딩 또는 sentinel '_org' 레포로 호스팅했으나,
  //    repo_id nullable + (space,key) 부분유니크로 sentinel 레포가 불필요해졌다 — '_org' 폐기.)
  //   멱등: key 가 어느 곳에도 space='business'(state<>'merged')로 없을 때만 적재(NOT EXISTS) — 키 전역 멱등.
  //   라이브는 6개가 이미 존재 → 6행 모두 skip → **부팅 시 라이브 무변화**(데이터 이행은 별도 마이그 스크립트).
  //   부분유니크 domain_space_key_uq 가 repo_id NULL 에서도 (business,key) 중복을 차단 → ON CONFLICT 불요.
  await pool.query(`
  INSERT INTO domain(repo_id,key,name,description,state,cross_cutting,origin,status,space,created_at,updated_at)
  SELECT NULL, v.key, v.name, v.descr, 'active', false, 'human', 'confirmed', 'business', now(), now()
  FROM (VALUES
    ('gtm','GTM(시장진입)','고객 획득·세일즈·마케팅·파트너십 등 시장 진입 전략 기능.'),
    ('business-model-pricing','비즈니스모델·가격','수익모델·가격정책·요금제·과금 구조 기능.'),
    ('fundraising','펀드레이징','투자유치·IR·자금조달·캡테이블 기능.'),
    ('market-competition','시장·경쟁','시장 규모·경쟁사·포지셔닝·경쟁지도 기능.'),
    ('brand','브랜드','브랜드 아이덴티티·메시징·디자인 언어 기능.'),
    ('org','조직','채용·조직설계·운영·문화 등 조직 기능.')
  ) AS v(key,name,descr)
  WHERE NOT EXISTS (SELECT 1 FROM domain d WHERE d.key=v.key AND d.space='business' AND d.state<>'merged');
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
  // ── 작업(Activity) 모델 (통합 DB 신설 P2) — domainmap 구조(is)와 ku(should/맥락)를 잇는 이벤트 레이어. ──
  //  과업(Task)=knowledge_unit(kind='W')은 그대로 두고, '작업'은 과업을 향해 실제로 한 행위(이벤트)다.
  //  commit 은 작업의 한 유형(commit_sha 보유, activity_touch 로 code_unit 연결 → is 갱신). comment/decision/
  //  status_change/review 는 PM 코멘트 미러 가능(external_*). 한 트랜잭션(withTx=itemsPool)에서 activity +
  //  activity_task(과업 n:n) + activity_ku_ref(산출/참조 ku) + activity_touch(코드)를 원자 기록(통합의 산물).
  //  *_review = 3-state('na'|'checked_no_change'|'changed') — "점검했으나 수정 안 됨"을 안 한 것과 구분 명시기록.
  //  author_person=토큰 신원, author_agent='어떤 AI'(모델/세션 — 하네스가 activity_log 인자로 명시 전달).
  //  ku FK 는 ON DELETE CASCADE(knowledge_unit_domain 선례와 동형 — 링크만 소멸, activity 이벤트는 생존).
  //  *** initOrgSchema(knowledge_unit 생성) 가 이 init 보다 먼저 끝나야 FK 해소(index.ts 직렬체인이 보장). ***
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
  CREATE TABLE IF NOT EXISTS activity_task(
    activity_id INT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
    ku_name TEXT NOT NULL REFERENCES knowledge_unit(name) ON DELETE CASCADE,
    created_at TIMESTAMPTZ,
    PRIMARY KEY(activity_id, ku_name));
  CREATE TABLE IF NOT EXISTS activity_ku_ref(
    id SERIAL PRIMARY KEY,
    activity_id INT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
    ku_name TEXT NOT NULL REFERENCES knowledge_unit(name) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    created_at TIMESTAMPTZ,
    UNIQUE(activity_id, ku_name, relation));
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
  //  DISTINCT(PG15+)로 instance=NULL 중복 구멍 차단. knowledge_unit/project 외부키 인덱스와 동형.
  await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS activity_external_uq
    ON activity(external_system, external_instance, external_id) NULLS NOT DISTINCT
    WHERE external_id IS NOT NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_author_idx ON activity(author_person, author_agent);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_committed_idx ON activity(committed_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_repo_idx ON activity(repo_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_touch_target_idx ON activity_touch(target_kind, target_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dash_watch_owner_idx ON dash_watch(owner);`);
  // summary — 비개발자도 한눈에 읽는 쉬운 한 줄(겉에 노출). title 은 기술 상세(펼침). 기존 DB 보강(신규 설치는 위 DDL).
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS summary TEXT;`);
  // type/review/relation CHECK — 신설이라 백필 불요. pg_constraint 프로브 멱등(기존 idiom).
  await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_type_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_type_chk
        CHECK (type IN ('commit','comment','decision','status_change','review'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_should_review_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_should_review_chk
        CHECK (should_review IN ('na','checked_no_change','changed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity'::regclass AND conname='activity_is_review_chk') THEN
      ALTER TABLE activity ADD CONSTRAINT activity_is_review_chk
        CHECK (is_review IN ('na','checked_no_change','changed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity_ku_ref'::regclass AND conname='activity_ku_ref_relation_chk') THEN
      ALTER TABLE activity_ku_ref ADD CONSTRAINT activity_ku_ref_relation_chk
        CHECK (relation IN ('produced','references','decided'));
    END IF;
  END $$;
  `);
  // change_log.activity_id — 이 변경을 유발한 작업 귀속(누가/왜). FK 없이 plain INT(change_log 의
  //  (entity_type,entity_id) FK-less 관성 유지 — 과거 project 감사행도 NULL 로 안전).
  await pool.query(`ALTER TABLE change_log ADD COLUMN IF NOT EXISTS activity_id INT;`);
  // domain.should — 의도(당위) 스펙 1급화. is(코드 구조)와 별 축: should=의도, description=자유서술,
  //  evidence(propose 근거)와도 구분. 맥락(주입 기획서/대화)에서 갱신, is 와의 괴리가 debt(P5).
  await pool.query(`ALTER TABLE domain ADD COLUMN IF NOT EXISTS should TEXT;`);
  return "initialized schema";
}

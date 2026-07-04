// Context OS v6 스키마 — greenfield 온톨로지 재설계.
//  맥락(Context) = Category(분류축) + Knowledge(맥락의 기록) + Project(맥락의 변화).
//  컷오버 완료(2026-06-24): 레거시 domain/knowledge_unit/org_project 는 드랍됨 — v6 가 단일 캐노니컬.
//  단일 통합 DB(itemsPool). 신규 정션은 같은 DB라 **진짜 FK** 를 쓴다.
//  ⚠ 호출 순서: index.ts 직렬체인에서 initOrgSchema(kind_registry/data_source 등)·initDomainmapSchema(activity/
//   mapping/debt) **이후** 호출 — activity_knowledge.activity_id 와 activity/mapping/debt ALTER 가 그 테이블에 의존.
//  내부 FK 순서: category → knowledge/project → 정션(knowledge_category/project_*) → activity/mapping/debt ALTER.
//  멱등: CREATE TABLE IF NOT EXISTS · ADD COLUMN IF NOT EXISTS · CHECK 은 pg_constraint 프로브(기존 idiom 그대로).
import { itemsPool } from "../items/store.js";
import { getRuntimeConfig } from "../org/store.js";
import { ensureEmbeddingSchema } from "./embedding-provider.js";

export async function initV6Schema(): Promise<string> {
  const pool = itemsPool;

  // ── 1) category — 구 domain 일반화. space 3값(business/product/system), repo_id 없음(도메인=멀티레포). ──
  //  도메인 = space='product' 부분집합(is/debt/엣지 보유 — 쓰기경로가 product 를 강제). should=정의·범위·규칙(전 space).
  //  유니크 (space,key) 부분(merged 제외) — 구 domain_space_key_uq 와 동형(domainmap/core/schema.ts:93).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category(
      id SERIAL PRIMARY KEY,
      space TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT,
      description TEXT,
      should TEXT,
      cross_cutting BOOLEAN DEFAULT false,
      origin TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='category'::regclass AND conname='category_space_chk') THEN
        ALTER TABLE category ADD CONSTRAINT category_space_chk CHECK (space IN ('business','product','system'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='category'::regclass AND conname='category_state_chk') THEN
        ALTER TABLE category ADD CONSTRAINT category_state_chk CHECK (state IN ('active','merged','deprecated'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS category_space_key_uq ON category(space, key) WHERE state <> 'merged';
    CREATE INDEX IF NOT EXISTS category_space_idx ON category(space);
    ALTER TABLE category ADD COLUMN IF NOT EXISTS layout_x REAL;
    ALTER TABLE category ADD COLUMN IF NOT EXISTS layout_y REAL;
  `);

  // ── 2) category_edge — 도메인間 관계. axis='should'(의도, 수동 저작) | 'is'(코드 import 의존, 스캔 도출). ──
  //  should↔is 갭 = 아키텍처 부채 신호(후속). 한 (from,to,axis) 당 1엣지: is 는 스캔 upsert, should 는 수동.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category_edge(
      id SERIAL PRIMARY KEY,
      from_category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      to_category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      axis TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'depends_on',
      origin TEXT,
      weight INT,
      run_id INT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='category_edge'::regclass AND conname='category_edge_axis_chk') THEN
        ALTER TABLE category_edge ADD CONSTRAINT category_edge_axis_chk CHECK (axis IN ('should','is'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='category_edge'::regclass AND conname='category_edge_noself_chk') THEN
        ALTER TABLE category_edge ADD CONSTRAINT category_edge_noself_chk CHECK (from_category_id <> to_category_id);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS category_edge_uq ON category_edge(from_category_id, to_category_id, axis);
    CREATE INDEX IF NOT EXISTS category_edge_from_idx ON category_edge(from_category_id, axis);
    CREATE INDEX IF NOT EXISTS category_edge_to_idx ON category_edge(to_category_id, axis);
  `);

  // ── 2-b) team — 조직 내 팀(스쿼드/사일로). 카테고리 오너십의 주체. category 뒤(team_category 가 category FK 의존). ──
  //  ★원칙: 오너십 ≠ 접근권한. 권한은 scopes[]/auth_token.projects[] 가 따로 강제 — 팀 소유는 표면화·주입의 '소프트 렌즈'다
  //   (우리 팀 맥락을 먼저 보여줄 뿐, 다른 팀 맥락도 전원 열람·검색 가능). '분절 없는 집중'.
  //  body_md = 팀 charter(주입될 '팀 층' — org_profile 섹션·org_member.body_md 와 같은 층, WIKI 와 직교).
  //  lead_member_id = org_member.id(FK 없음 — project_member 관례, 미러/외부신원 허용). key 유니크(archived 제외, category idiom).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team(
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT,
      description TEXT,
      body_md TEXT,
      lead_member_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      sort INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='team'::regclass AND conname='team_state_chk') THEN
        ALTER TABLE team ADD CONSTRAINT team_state_chk CHECK (state IN ('active','archived'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS team_key_uq ON team(key) WHERE state <> 'archived';
  `);

  // ── 2-c) team_member — 팀원(n:n). 사람은 여러 팀 가능(겸직). member_id=org_member.id(FK 없음, project_member 관례). ──
  //  role = lead|pm|dev|design|member (표시 메타 — '누구한테 물어봐'. 표면화/주입은 소속 여부만 보고 role 은 안 본다).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_member(
      team_id INT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (team_id, member_id));
    CREATE INDEX IF NOT EXISTS team_member_member_idx ON team_member(member_id);
  `);

  // ── 2-d) team_category — ★핵심 경첩: 팀↔카테고리 오너십(n:n). relation=owner|stakeholder. ──
  //  지식(knowledge_category)·프로젝트(project_category)·도메인맵이 이미 category 에 매달려 있어, 여기 한 줄(팀↔카테고리)이
  //   팀의 맥락 귀속 전체를 끌어온다(새 축 X, 기존 축에 오너 부착). 카테고리당 owner 팀은 최대 1(부분 유니크) = '우리 팀' 기준.
  //   stakeholder 는 여럿 허용(공유/크로스커팅 카테고리 — brand·gtm 등 여러 팀이 이해관계자).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_category(
      team_id INT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'owner',
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (team_id, category_id));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='team_category'::regclass AND conname='team_category_relation_chk') THEN
        ALTER TABLE team_category ADD CONSTRAINT team_category_relation_chk CHECK (relation IN ('owner','stakeholder'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS team_category_owner_uq ON team_category(category_id) WHERE relation='owner';
    CREATE INDEX IF NOT EXISTS team_category_team_idx ON team_category(team_id);
    CREATE INDEX IF NOT EXISTS team_category_cat_idx ON team_category(category_id);
  `);

  // ── 3) knowledge — 구 knowledge_unit 대체. kind(R/K/H/W) **폐기**(직교축으로 분리). ──
  //  injection=always(구 kind=R 규칙·페르소나 — 항상 주입, materialize 의 급소) | recalled(검색 소환).
  //  provenance=authored(저작) | observed(외부 미러 — 구 confidence='observed'). confidence 는 저작신뢰로 유지.
  //  외부좌표/스레드/원본보존 컬럼은 구 knowledge_unit 동형(커넥터 미러 흡수) — 구 테이블은 v6 드랍됨.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge(
      name TEXT PRIMARY KEY,
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      injection TEXT NOT NULL DEFAULT 'recalled',
      provenance TEXT NOT NULL DEFAULT 'authored',
      lifecycle TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      confidence TEXT NOT NULL DEFAULT 'human',
      source TEXT NOT NULL DEFAULT 'authored',
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      sync_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ, last_synced_at TIMESTAMPTZ, as_of TIMESTAMPTZ,
      parent_external_id TEXT, parent_name TEXT,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw JSONB,
      summary TEXT,
      author TEXT, source_ref TEXT,
      sort INT NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1,
      is_wiki BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge'::regclass AND conname='knowledge_injection_chk') THEN
        ALTER TABLE knowledge ADD CONSTRAINT knowledge_injection_chk CHECK (injection IN ('always','recalled'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge'::regclass AND conname='knowledge_provenance_chk') THEN
        ALTER TABLE knowledge ADD CONSTRAINT knowledge_provenance_chk CHECK (provenance IN ('authored','observed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge'::regclass AND conname='knowledge_confidence_chk') THEN
        ALTER TABLE knowledge ADD CONSTRAINT knowledge_confidence_chk CHECK (confidence IN ('ai','rule','human','observed'));
      END IF;
    END $$;
    -- lifecycle 단순화(2026-06-23): rejected 폐기 — 제거는 삭제(휴지통, 복원가능)로 통일. 가역 숨김(반려) 개념 삭제.
    --  기존 rejected 행은 active 복귀(비파괴). 제약은 redefine 이라 DROP+ADD(멱등). superseded 는 버전 교체 축이라 유지.
    -- archived 추가(2026-07-04 #551): 외부 미러의 원본 아카이브/휴지통/삭제 전파 자리 — 하드삭제 대신 보존(기본 목록에선 lifecycle='active' 필터로 숨음).
    UPDATE knowledge SET lifecycle='active' WHERE lifecycle='rejected';
    ALTER TABLE knowledge DROP CONSTRAINT IF EXISTS knowledge_lifecycle_chk;
    ALTER TABLE knowledge ADD CONSTRAINT knowledge_lifecycle_chk CHECK (lifecycle IN ('active','superseded','archived'));
    -- WIKI 핀(2026-06-23): is_wiki=true 인 지식의 제목+메타만 가이드 위키섹션으로 항상-주입(본문 제외, 인덱스).
    --  injection(always/recalled)과 직교 — recalled 지식이되 인덱스엔 핀. 멱등 ADD COLUMN(기존 테이블 보강).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS is_wiki BOOLEAN NOT NULL DEFAULT false;
    -- type(2026-06-30 #290): page-type facet — 엔터프라이즈 표준 합성(DITA Concept/Reference + Diátaxis How-to/Explanation + ADR Decision + LLM위키 Entity).
    --  6종: decision|concept|how-to|reference|research|entity. NULL 허용(미분류). 옛 kind(R/K/H/W)는 폐기 — 무관. 비파괴 ADD COLUMN.
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS type TEXT;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge'::regclass AND conname='knowledge_type_chk') THEN
        ALTER TABLE knowledge ADD CONSTRAINT knowledge_type_chk CHECK (type IS NULL OR type IN ('decision','concept','how-to','reference','research','entity'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge(type) WHERE type IS NOT NULL;
    -- created_at(2026-06-30 #290): 최초 작성 시점. 비파괴 ADD COLUMN(NULL) → 기존 행은 updated_at 으로 1회 백필(WHERE NULL, 멱등) → 이후 DEFAULT now().
    --  주의: 백필값은 '마지막 갱신' 기준 근사(편집된 지식은 실제 생성보다 늦을 수 있음 — 더 정확한 출처가 없음). 신규 INSERT 는 DEFAULT now(), ON CONFLICT 갱신은 created_at 미변경(보존).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    UPDATE knowledge SET created_at = updated_at WHERE created_at IS NULL;
    ALTER TABLE knowledge ALTER COLUMN created_at SET DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_external_uidx ON knowledge(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS knowledge_injection_idx ON knowledge(injection);
    CREATE INDEX IF NOT EXISTS knowledge_wiki_idx ON knowledge(is_wiki) WHERE is_wiki;
    CREATE INDEX IF NOT EXISTS knowledge_provenance_idx ON knowledge(provenance);
    CREATE INDEX IF NOT EXISTS knowledge_lifecycle_idx ON knowledge(lifecycle);
    CREATE INDEX IF NOT EXISTS knowledge_parent_idx ON knowledge(parent_name);
  `);

  // (#335) 항상-주입 섹션 N개화 — 정렬 시드 + 팀블록 위치 보존. 1회성: 두 기본 섹션이 모두 pristine(sort=0)일 때만 실행
  //  → 한 번 정렬(0,1)되면 조건 거짓이라 재실행 안 됨(관리자 재정렬·${team} 제거를 덮어쓰지 않음).
  await pool.query(`
    DO $$
    BEGIN
      IF (SELECT COUNT(*) FROM knowledge
            WHERE injection='always' AND lifecycle='active'
              AND name IN ('org-defaults','context-ontology-guide') AND sort=0) = 2 THEN
        UPDATE knowledge SET sort=0 WHERE name='org-defaults' AND injection='always';
        UPDATE knowledge SET sort=1 WHERE name='context-ontology-guide' AND injection='always';
        -- 팀블록 위치 보존 — 이전 조립은 org-defaults 직후 team 블록. org-defaults 말미에 \${team} 플레이스홀더로 시드(1회).
        UPDATE knowledge SET body_md = body_md || E'\n\n\${team}'
          WHERE name='org-defaults' AND injection='always' AND lifecycle='active' AND body_md NOT LIKE '%\${team}%';
      END IF;
    END $$;
  `);

  // ── 4) knowledge_category — 지식↔카테고리 정션(구 knowledge_unit_domain). #290 knowledge_category_single_uq 로 지식당 단일-home(0/1). 진짜 FK(같은 DB). ──
  //  빈 정션 = '카테고리 없음(general)' 허용(센티넬 행 회피). state/mapped_by enum 은 구 조인과 동일.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_category(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      mapped_by TEXT NOT NULL DEFAULT 'rule',
      confidence REAL,
      state TEXT NOT NULL DEFAULT 'proposed',
      evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(name, category_id));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_category'::regclass AND conname='knowledge_category_state_chk') THEN
        ALTER TABLE knowledge_category ADD CONSTRAINT knowledge_category_state_chk CHECK (state IN ('proposed','confirmed','rejected'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_category'::regclass AND conname='knowledge_category_mappedby_chk') THEN
        ALTER TABLE knowledge_category ADD CONSTRAINT knowledge_category_mappedby_chk CHECK (mapped_by IN ('rule','llm','manual','declared'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS knowledge_category_cat_idx ON knowledge_category(category_id);
    CREATE INDEX IF NOT EXISTS knowledge_category_state_idx ON knowledge_category(state);
  `);

  // ── 5) project — 1급 엔티티. 위계 project▸task▸subtask(parent_id self-FK). 구 org_project 확장. ──
  //  task = 구 W ku 대체(별도 엔티티 아님). external_* = ClickUp 미러 좌표(부분유니크 멱등 upsert).
  //  level↔parent 불변식(task.parent=project, subtask.parent=task)은 쓰기경로가 강제(CHECK 는 타행 참조 불가).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project(
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'project',
      parent_id INT REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      folder TEXT,
      created_by TEXT,
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      sort INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='project'::regclass AND conname='project_level_chk') THEN
        ALTER TABLE project ADD CONSTRAINT project_level_chk CHECK (level IN ('project','task','subtask'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='project'::regclass AND conname='project_status_chk') THEN
        ALTER TABLE project ADD CONSTRAINT project_status_chk CHECK (status IN ('active','done'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS project_external_uidx ON project(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS project_parent_idx ON project(parent_id);
    CREATE INDEX IF NOT EXISTS project_level_idx ON project(level);
  `);

  // ── 5b) 태스크 필드 보강(2026-06-24) — 프로젝트 탭의 클릭업형 리스트뷰: 우선순위·담당자·기간. ──
  //  가산(ADD COLUMN IF NOT EXISTS) — task/subtask 행만 의미(project 행은 NULL 유지). assignee=member_id(org_member).
  //  기간(start_date/due_date)은 DATE 아닌 **TEXT 'YYYY-MM-DD'** — node-pg 의 DATE→JS Date 파싱이 KST 에서 하루
  //   밀리는 footgun 회피. 사전식 정렬=시간순이라 정렬도 무손실. 형식 검증은 쓰기경로(projects-v6) 파서가 담당.
  //  status 다단계화: project=active|done 유지, task/subtask=todo|in_progress|done. **합집합 CHECK** 로 완화 —
  //   클릭업 커넥터 미러가 task 를 status='active' 로 적재(connector-mirror.ts:152, 정규화 후속)하므로 active 도 계속
  //   허용해 미러 적재가 깨지지 않게 한다. 기존 행은 전부 합집합 안 → 비파괴(이관 UPDATE 불필요). 제약 재정의는
  //   기존 idiom(knowledge_lifecycle, 위)처럼 DROP+ADD(멱등). 원 project_status_chk(active|done)는 이 블록이 대체.
  await pool.query(`
    ALTER TABLE project ADD COLUMN IF NOT EXISTS priority TEXT;
    ALTER TABLE project ADD COLUMN IF NOT EXISTS assignee TEXT;
    ALTER TABLE project ADD COLUMN IF NOT EXISTS start_date TEXT;
    ALTER TABLE project ADD COLUMN IF NOT EXISTS due_date TEXT;
    ALTER TABLE project DROP CONSTRAINT IF EXISTS project_status_chk;
    ALTER TABLE project ADD CONSTRAINT project_status_chk CHECK (status IN ('active','done','todo','in_progress'));
    ALTER TABLE project DROP CONSTRAINT IF EXISTS project_priority_chk;
    ALTER TABLE project ADD CONSTRAINT project_priority_chk CHECK (priority IS NULL OR priority IN ('urgent','high','normal','low'));
    CREATE INDEX IF NOT EXISTS project_assignee_idx ON project(assignee) WHERE assignee IS NOT NULL;
    CREATE INDEX IF NOT EXISTS project_status_idx ON project(status);
  `);

  // ── 5c) status 정규화(2026-06-26, #177 다툴 일반화) — 폐쇄 enum 위에 두 축을 **가산**. 비파괴. ──
  //  외부 PM툴(ClickUp/Jira/Linear/Notion)은 per-workspace 커스텀 상태(개방 어휘)라, 기존 status enum
  //  (active/done/todo/in_progress)으로는 무손실 보존이 불가능하다. 두 컬럼을 더한다(기존 status·CHECK·UI 전부 불변):
  //   · status_raw      = 소스의 **원문 상태명**(개방 어휘, CHECK 없음). 네이티브 행은 NULL(=status 가 표시값).
  //   · status_category = **정규 카테고리**(크로스툴 공통분모): backlog|unstarted|started|done|canceled.
  //  status 는 당분간 'CHECK 유효 네이티브 투영'으로 유지(UI 호환) — 커넥터는 카테고리→네이티브로 투영해 status 를 채우고,
  //  원문은 status_raw, 정규값은 status_category 에 둔다. 소비자(UI·done 집계) 이행은 후속 인크리먼트.
  //  백필은 멱등(WHERE status_category IS NULL) — 매 부팅, 신규 NULL 행(아직 미설정 쓰기경로)도 함께 수렴한다.
  await pool.query(`
    ALTER TABLE project ADD COLUMN IF NOT EXISTS status_raw TEXT;
    ALTER TABLE project ADD COLUMN IF NOT EXISTS status_category TEXT;
    ALTER TABLE project DROP CONSTRAINT IF EXISTS project_status_category_chk;
    ALTER TABLE project ADD CONSTRAINT project_status_category_chk
      CHECK (status_category IS NULL OR status_category IN ('backlog','unstarted','started','done','canceled'));
    UPDATE project SET status_category = CASE
        WHEN status='done' THEN 'done'
        WHEN status='in_progress' THEN 'started'
        WHEN status='active' THEN 'started'
        WHEN status='todo' THEN 'unstarted'
        ELSE 'unstarted' END
      WHERE status_category IS NULL;
    CREATE INDEX IF NOT EXISTS project_status_category_idx ON project(status_category);
  `);

  // ── 5d) task_assignee(2026-06-26, #177) — 단일 assignee 컬럼 → n:n **가산**. 멀티담당자(ClickUp/Notion people) 무손실용. ──
  //  전환기: 기존 `assignee` 컬럼이 primary(UI·리스트뷰 호환), task_assignee 는 가산 섀도(쓰기경로가 동기, 백필로 시드).
  //  member_id = org_member.id 또는 외부 신원(FK 없음 — 미러/외부 담당자 허용, project_member·assignee 관례와 동일).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_assignee(
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(task_id, member_id));
    CREATE INDEX IF NOT EXISTS task_assignee_member_idx ON task_assignee(member_id);
    -- 백필: 기존 단일 assignee 컬럼 → n:n(멱등, ON CONFLICT skip). 매 부팅 안전(이미 시드면 no-op).
    --  ⚠ JSON 배열 문자열('["a","b"]' — UI 다중담당 규약)은 제외(#541) — 통째 복사 시 member_id 오염.
    --   배열 값의 섀도 동기는 쓰기경로(syncTaskAssignees·connector-mirror)가 담당.
    INSERT INTO task_assignee(task_id, member_id, sort)
      SELECT id, assignee, 0 FROM project
      WHERE assignee IS NOT NULL AND assignee <> '' AND assignee NOT LIKE '[%'
      ON CONFLICT (task_id, member_id) DO NOTHING;
    -- 과거 부팅이 복사해 둔 JSON 배열 오염 행 정리(멱등 — 정상 member_id 는 '[' 로 시작하지 않음).
    DELETE FROM task_assignee WHERE member_id LIKE '[%';
  `);

  // ── 5e) external_outbox(2026-06-26, #177 아웃바운드 write-through) — 로컬 편집(web/MCP)→외부 PM(ClickUp) 푸시 큐. ──
  //  우리 DB=master 라 로컬 변경을 외부로 흘린다. 커넥터(인바운드)는 project-store 를 우회(connector-mirror 직접 INSERT)하므로
  //  여기 적재되지 않는다 → 인바운드→아웃바운드 루프 원천 차단(이중 방어로 enqueue 가 source='connector' skip).
  //  pending(done_at IS NULL)은 (system, entity_id)당 1행 coalesce — 여러 편집이 한 번의 푸시로 수렴(드레인이 현재 project 행 재읽기, 멱등).
  //  op='delete' 는 ext_id_snapshot(삭제 전 external_id)을 실어 행 CASCADE 삭제 후에도 외부 삭제 가능.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_outbox(
      id BIGSERIAL PRIMARY KEY,
      entity_id INT NOT NULL,                 -- project.id(project/task/subtask 행). FK 미설정(delete 후에도 행 남아야 외부 삭제 가능).
      system TEXT NOT NULL DEFAULT 'clickup',
      op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
      ext_id_snapshot TEXT,                   -- delete 용: enqueue 시점 external_id.
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at TIMESTAMPTZ,                     -- 푸시 성공 시각(NULL=pending).
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS external_outbox_pending_uidx ON external_outbox(system, entity_id) WHERE done_at IS NULL;
    CREATE INDEX IF NOT EXISTS external_outbox_pending_idx ON external_outbox(system, created_at) WHERE done_at IS NULL;
  `);

  // ── 5f) external_base(2026-06-26, #177 #6d 3-way 머지) — 마지막 양측 합의값(공통조상) JSONB. ──
  //  {name, description, status_category}. 인바운드 머지의 base: INSERT=theirs, 아웃바운드 푸시 후=ours, 인바운드 머지 후=merged.
  //  merge3(base, ours, theirs): theirs==base→ours유지(외부불변), ours==base→theirs채택(우리불변), 양쪽변경→ours(우리 DB master 타이브레이크).
  await pool.query(`ALTER TABLE project ADD COLUMN IF NOT EXISTS external_base JSONB;`);

  // ── 5g) 무손실 백스톱(#541) — 커넥터가 typed 컬럼으로 못 옮기는 소스 고유 데이터 전체 보존. ──
  //  knowledge(schema.ts §14 fields+raw)·source(§14-c raw) 미러처럼 project 도 fields(구조화 소스필드)+raw(원본 전체 JSON)
  //  백스톱을 갖는다 — 이게 없어서 ClickUp attachment/custom_field/watchers/points/orderindex/time 등 미모델 데이터가
  //  쓰기 시점에 영구 소실됐다(#541 무손실 이관 감사). 커넥터 미러가 typed 컬럼 + 이 백스톱을 함께 채운다(무손실 fallback).
  await pool.query(`
    ALTER TABLE project ADD COLUMN IF NOT EXISTS fields JSONB;
    ALTER TABLE project ADD COLUMN IF NOT EXISTS raw JSONB;
  `);

  // ── 6) project_member — 프로젝트 팀원(n:n, level=project). 구 project_member 동형(org/schema.ts:304). ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_member(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, member_id));
    CREATE INDEX IF NOT EXISTS project_member_member_idx ON project_member(member_id);
    -- 상태 메시지를 (프로젝트, 사람) 단위로 — 프로필 전역(org_member.status_message)이 아니라 프로젝트마다 따로.
    ALTER TABLE project_member ADD COLUMN IF NOT EXISTS status_message TEXT;
  `);

  // ── 세션↔프로젝트 매핑 — 프로젝트 터미널 세션에서 한 AI 작업(activity.session_id)만 타임라인에 모으기 위한 영속 링크.
  //   tmux @box_project 는 휘발성(끝난 세션 사라짐)이라, 세션 생성 시 여기 기록해 끝난 세션 작업도 귀속한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_project(
      session_id TEXT PRIMARY KEY,
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS session_project_project_idx ON session_project(project_id);
  `);

  // ── 6b) project_member FK 교정 — 구 org/schema.ts(:304)가 project_member 를 org_project 참조로 **먼저**
  //   만들면, 위 CREATE TABLE IF NOT EXISTS(project 참조)가 기존 테이블을 덮지 못한다(IF NOT EXISTS 함정).
  //   그 결과 FK 가 org_project 를 가리킨 채 남아, v6 project 생성+팀원추가가 FK 위반(500)으로 깨졌다.
  //   → project 참조로 재지정. 멱등: 이미 project 를 가리키면 skip. 재지정 전 project 에 없는 잔재 행 제거(FK 충족 불가).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='project_member_project_id_fkey'
          AND conrelid='project_member'::regclass
          AND confrelid <> 'project'::regclass
      ) THEN
        ALTER TABLE project_member DROP CONSTRAINT project_member_project_id_fkey;
        DELETE FROM project_member pm WHERE NOT EXISTS (SELECT 1 FROM project p WHERE p.id = pm.project_id);
        ALTER TABLE project_member ADD CONSTRAINT project_member_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // ── 6c) project_list — 프로젝트 묶음(클릭업 List▸Task 의 List). level='project' 행을 0~1개 리스트로 그룹핑. ──
  //  네이티브 전용(외부 PM 미러 없음 — 우리 ClickUp 매핑은 단일 컨테이너 List 유지, db-clickup-시드-매핑 결정 정합).
  //  list_id 는 project 에 nullable FK(ON DELETE SET NULL) — 리스트 삭제 시 프로젝트는 보존되고 '미분류'로 떨어진다.
  //  멤버(project_list_member)=리스트 참여자 → 웹 보드의 기본 펼침/접힘을 가른다(내 리스트=펼침). 프로젝트 팀원(project_member)과 직교.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_list(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      sort INT NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS project_list_member(
      list_id INT NOT NULL REFERENCES project_list(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, member_id));
    CREATE INDEX IF NOT EXISTS project_list_member_member_idx ON project_list_member(member_id);
    ALTER TABLE project ADD COLUMN IF NOT EXISTS list_id INT REFERENCES project_list(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS project_list_id_idx ON project(list_id) WHERE list_id IS NOT NULL;
  `);

  // ── 6d) project_folder — 폴더(클릭업 Folder). '리스트'(project_list) 위의 순수 정리용 상위 층(#475). ──
  //  3단계 = 폴더 › 리스트 › 프로젝트. 폴더는 멤버·권한 없이 '정리용'만 담당(멤버·visibility·목록 UI 는 리스트가 담당).
  //  folder_id 는 project_list 에 nullable FK(ON DELETE SET NULL) — 폴더 삭제 시 리스트는 보존되고 '미분류 폴더'로 떨어진다.
  //  ⚠명칭 전환(#475): #356 에서 'project_list = 폴더'였으나, 이제 project_list = '리스트'(중간), 신규 project_folder = '폴더'(상위).
  //  코드 심볼(project_list·list_id 등)은 그대로 두고 UI 라벨만 '리스트'로 전환 — API/스키마 하위호환.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_folder(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      sort INT NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS folder_id INT REFERENCES project_folder(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS project_list_folder_id_idx ON project_list(folder_id) WHERE folder_id IS NOT NULL;
    -- 리스트 단위 공개범위(#475): 'open'=전원(기존 #280 정합) / 'members'=리스트 멤버만 목록·프로젝트 열람.
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open';
    -- 리스트 단위 목록 UI 커스텀(#475) — 기본 보기(그룹/정렬)·표시필드 등 프리퍼런스 백. 스키마 고정 없이 확장.
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── 6e) 커넥터 무손실 계층 이관(#541) — 폴더 nestable(ClickUp Space›Folder 2층 흡수) + folder/list external 멱등 좌표. ──
  //  ClickUp Space›Folder›List›Task 4층을 우리 폴더(nestable)›리스트›프로젝트로: Space=최상위 project_folder(parent_id=NULL),
  //  ClickUp Folder=하위 project_folder(parent_id=Space행). external_* 로 커넥터가 멱등 upsert(재싱크 중복 0). settings=원본 메타 백스톱.
  await pool.query(`
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES project_folder(id) ON DELETE SET NULL;
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS external_system TEXT;
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS external_instance TEXT;
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS project_folder_external_uidx ON project_folder(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS project_folder_parent_idx ON project_folder(parent_id) WHERE parent_id IS NOT NULL;
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS external_system TEXT;
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS external_instance TEXT;
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS project_list_external_uidx ON project_list(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
  `);

  // ── 6f) project_view — 리스트/폴더 뷰(#541: ClickUp View 이관 + 우리 커스텀 뷰·컬럼 저장). ──
  //  config JSONB = { columns:[{field,idx,width,hidden,name}], grouping, sorting, filters, settings } — 클릭업 View shape 보존 + 우리 커스텀 컬럼.
  //  external_* 있으면 ClickUp 이관 뷰(멱등), NULL 이면 우리가 만든 로컬 뷰. 사용자 "뷰 저장 안됨/커스텀 컬럼" 해소의 저장층.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_view(
      id SERIAL PRIMARY KEY,
      list_id INT REFERENCES project_list(id) ON DELETE CASCADE,
      folder_id INT REFERENCES project_folder(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'list',
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort INT NOT NULL DEFAULT 0,
      created_by TEXT,
      external_system TEXT, external_instance TEXT, external_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS project_view_list_idx ON project_view(list_id) WHERE list_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS project_view_folder_idx ON project_view(folder_id) WHERE folder_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS project_view_external_uidx ON project_view(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
  `);

  // ── 7) project_category — 프로젝트↔카테고리 정션(프로젝트 탭 사업/제품/시스템 탐색). #290 project_category_single_uq 로 프로젝트당 단일-home(0/1). ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_category(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (project_id, category_id));
    CREATE INDEX IF NOT EXISTS project_category_cat_idx ON project_category(category_id);
  `);

  // ── 8) project_knowledge — 필요지식(required)/산출지식(produced). ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_knowledge(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (project_id, name, relation));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='project_knowledge'::regclass AND conname='project_knowledge_relation_chk') THEN
        ALTER TABLE project_knowledge ADD CONSTRAINT project_knowledge_relation_chk CHECK (relation IN ('required','produced'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS project_knowledge_name_idx ON project_knowledge(name);
  `);

  // ── 8-b) project_repo — 프로젝트↔레포(n:n, repo 레지스트리 이름 참조). AGENTS.md '관련 레포' + '내 컴퓨터에서 작업' 모달 기본값. ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_repo(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (project_id, repo));
    CREATE INDEX IF NOT EXISTS project_repo_repo_idx ON project_repo(repo);
  `);

  // ── 9) activity_knowledge — 구 activity_ku_ref 개명·repoint(→knowledge). 작업↔지식(산출/참조/결정). ──
  //  activity 는 initDomainmapSchema 가 생성(이미 존재). 구 activity_task(작업↔W ku)는 activity.project_id 로 대체.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_knowledge(
      id SERIAL PRIMARY KEY,
      activity_id INT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(activity_id, name, relation));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='activity_knowledge'::regclass AND conname='activity_knowledge_relation_chk') THEN
        ALTER TABLE activity_knowledge ADD CONSTRAINT activity_knowledge_relation_chk CHECK (relation IN ('produced','references','decided'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS activity_knowledge_name_idx ON activity_knowledge(name);
  `);

  // ── 10) 레거시 도메인맵 테이블 ALTER(가산·비파괴) — activity/mapping/debt_finding 에 v6 링크 컬럼. ──
  //  activity.project_id: 작업→프로젝트(task/subtask) 귀속(구 activity_task 대체). FK SET NULL(링크만 소멸·이벤트 생존).
  //  mapping.category_id: 코드유닛→카테고리(구 domain_id). repo_id 는 타깃(code_unit)이 이미 가지므로 mapping 에선 잉여.
  //   부분유니크(category_id NOT NULL) — 백필 전 NULL 행 다수와 충돌 회피, 백필 후 (target,category) 유일 강제.
  //  debt_finding.category_id: 도메인부채(should↔is)는 카테고리귀속. 구조부채는 repo_id 유지(둘 다 nullable·부분유니크).
  await pool.query(`
    ALTER TABLE activity ADD COLUMN IF NOT EXISTS project_id INT REFERENCES project(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS activity_project_idx ON activity(project_id);
    ALTER TABLE activity ADD COLUMN IF NOT EXISTS reply_to INT REFERENCES activity(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS activity_reply_to_idx ON activity(reply_to);
    ALTER TABLE mapping ADD COLUMN IF NOT EXISTS category_id INT REFERENCES category(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS mapping_target_category_uq ON mapping(target_kind, target_id, category_id) WHERE category_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS mapping_category_idx ON mapping(category_id);
    ALTER TABLE debt_finding ADD COLUMN IF NOT EXISTS category_id INT REFERENCES category(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS debt_finding_category_title_uq ON debt_finding(category_id, title) WHERE category_id IS NOT NULL;
  `);

  // ── 11) 태스크 상세(클릭업형 모달) — 태그·시간추적·체크리스트·의존성. 모두 task/subtask 행(project.id) 귀속. ──
  //  활동 피드(getTaskFeed)는 둘을 시간순 병합한다: ① 사용자 댓글 = task_comment(task_id=task id) — 전용 테이블(⑧,
  //  프로젝트 #183 에서 activity(type='comment') 재활용에서 분리), ② 시스템 이벤트(상태변경·담당자·우선순위·기간·이름·설명·생성)
  //  = org_content_audit(entity='project', entity_key=task id)의 before/after 를 읽기경로에서 diff(전용 이벤트 테이블 없이 전 이력 자동 포착).
  //  member/assignee = org_member.id 문자열(리스트뷰 assignee 관례와 동일, FK 없음 — 미러/외부 신원도 허용).
  await pool.query(`
    -- 태그 레지스트리(워크스페이스 공용, 색상) + 태스크↔태그 정션. 이름은 대소문자 무시 유일.
    CREATE TABLE IF NOT EXISTS task_tag(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS task_tag_name_uidx ON task_tag(lower(name));
    CREATE TABLE IF NOT EXISTS task_tag_link(
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      tag_id INT NOT NULL REFERENCES task_tag(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(task_id, tag_id));
    CREATE INDEX IF NOT EXISTS task_tag_link_tag_idx ON task_tag_link(tag_id);

    -- 시간추적 — 실행중(ended_at NULL)=타이머, 종료/수동입력=duration_seconds 확정. source=timer|manual.
    CREATE TABLE IF NOT EXISTS task_time_entry(
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      member TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INT,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'timer',
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_time_entry_task_idx ON task_time_entry(task_id);
    -- 한 (task,member) 당 실행중 타이머는 최대 1개(부분 유니크 — 이중 시작 방지).
    CREATE UNIQUE INDEX IF NOT EXISTS task_time_running_uidx ON task_time_entry(task_id, member) WHERE ended_at IS NULL;

    -- 체크리스트(태스크 안 가벼운 점검) + 항목(담당자·완료). 서브태스크보다 가벼운 점검용.
    CREATE TABLE IF NOT EXISTS task_checklist(
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_checklist_task_idx ON task_checklist(task_id);
    CREATE TABLE IF NOT EXISTS task_checklist_item(
      id SERIAL PRIMARY KEY,
      checklist_id INT NOT NULL REFERENCES task_checklist(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT false,
      assignee TEXT,
      sort INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_checklist_item_cl_idx ON task_checklist_item(checklist_id);

    -- 의존성/연결 — type=blocking|waiting_on|linked. 쓰기경로가 역방향을 동기(상호적: blocking↔waiting_on, linked↔linked).
    CREATE TABLE IF NOT EXISTS task_link(
      from_task INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      to_task INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(from_task, to_task, type));
    CREATE INDEX IF NOT EXISTS task_link_to_idx ON task_link(to_task);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='task_link'::regclass AND conname='task_link_type_chk') THEN
        ALTER TABLE task_link ADD CONSTRAINT task_link_type_chk CHECK (type IN ('blocking','waiting_on','linked'));
      END IF;
    END $$;
  `);

  // ── ⑫ 커스텀 필드(클릭업형 "+ 컬럼 추가") — 루트 프로젝트에 형식을 지정해 컬럼을 정의하고, 그 아래 모든 ──
  //  task/subtask 가 컬럼별 값을 갖는다. field_type=text|textarea|number|money|date|dropdown|labels|checkbox|
  //  website|email|phone|rating|progress|tshirt|location(프론트 FIELD_TYPES 와 1:1). config=타입별 설정(dropdown/
  //  labels=options[], money=currency, rating=max …), value=타입별 형태(JSONB) — 둘 다 자유형이라 쓰기경로(store)가 검증.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_field(
      id SERIAL PRIMARY KEY,
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      field_type TEXT NOT NULL,
      name TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort INT NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_field_project_idx ON task_field(project_id);

    -- 태스크별 필드값 — (field, task) 1행. 값 해제 시 행 삭제(부재=무값). 필드 삭제 시 FK CASCADE 로 값 동반 제거.
    CREATE TABLE IF NOT EXISTS task_field_value(
      field_id INT NOT NULL REFERENCES task_field(id) ON DELETE CASCADE,
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(field_id, task_id));
    CREATE INDEX IF NOT EXISTS task_field_value_task_idx ON task_field_value(task_id);
  `);

  // ── ⑫-b task_attachment(#541) — 태스크 첨부/이미지. ClickUp attachments[] + 인라인 이미지 이관. external 멱등. ──
  //  raw=원본 attachment JSON 백스톱. parent_type=tasks|comments(첨부 출처). 우리 네이티브 첨부에도 재사용 가능.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_attachment(
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      external_id TEXT,
      title TEXT,
      url TEXT,
      mimetype TEXT,
      extension TEXT,
      size BIGINT,
      source TEXT,
      thumbnail TEXT,
      parent_type TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_attachment_task_idx ON task_attachment(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS task_attachment_external_uidx ON task_attachment(external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS task_attachment_inline_uidx ON task_attachment(task_id, url) WHERE external_id IS NULL AND url IS NOT NULL;
  `);

  // ── ⑫-c 커넥터 멱등 좌표 가산(#541 무손실) — 기존 상세 테이블(체크리스트·댓글·커스텀필드·타임엔트리)에
  //  external_id 를 더해 재싱크가 중복 없이 수렴하게 한다. 네이티브 행은 NULL(부분유니크 밖 — 영향 0).
  //  task_comment.raw = ClickUp 댓글 원본(구조화 blocks·반응·assignee 등) 백스톱. created_at 은 미러가 원시각으로 직접 INSERT.
  //  task_field 는 (project_id, external_id) 유니크 — ClickUp 필드정의(UUID)가 리스트 단위라 여러 루트 프로젝트에 복제되기 때문.
  await pool.query(`
    ALTER TABLE task_checklist ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS task_checklist_external_uidx ON task_checklist(external_id) WHERE external_id IS NOT NULL;
    ALTER TABLE task_checklist_item ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS task_checklist_item_external_uidx ON task_checklist_item(external_id) WHERE external_id IS NOT NULL;
    ALTER TABLE task_field ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS task_field_external_uidx ON task_field(project_id, external_id) WHERE external_id IS NOT NULL;
    ALTER TABLE task_time_entry ADD COLUMN IF NOT EXISTS external_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS task_time_entry_external_uidx ON task_time_entry(external_id) WHERE external_id IS NOT NULL;
  `);

  // ── ⑧ 태스크 댓글 + 이모지 반응 — 전용 테이블(프로젝트 #183: 구 activity(type='comment') 재활용에서 분리). ──
  //  댓글=task_comment(task_id→project, reply_to 자기FK 1단계 스레드), 반응=task_comment_reaction(comment_id→task_comment).
  //  activity 와 분리 → activity 차원 운영(타입 리맵·project_id ON DELETE SET NULL)이 더는 댓글 정체성에 새지 않는다. 댓글 삭제 시 반응 CASCADE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_comment(
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      author TEXT,
      body TEXT NOT NULL,
      reply_to INT REFERENCES task_comment(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS task_comment_task_idx ON task_comment(task_id);
    CREATE INDEX IF NOT EXISTS task_comment_reply_idx ON task_comment(reply_to);

    -- 반응 테이블: 구 스키마(activity_id→activity)면 신 스키마(comment_id→task_comment)로 1회 이관.
    --  전환 시점 활성 댓글 0건 → 구 반응(삭제 태스크의 고아)은 대응 댓글이 없어 폐기(프로젝트 #183 검토).
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='task_comment_reaction' AND column_name='activity_id') THEN
        DROP TABLE task_comment_reaction;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS task_comment_reaction(
      comment_id INT NOT NULL REFERENCES task_comment(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      member TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(comment_id, emoji, member));
    CREATE INDEX IF NOT EXISTS task_comment_reaction_cmt_idx ON task_comment_reaction(comment_id);

    -- ⑧-b 커넥터 멱등 좌표(#541 무손실) — ClickUp 댓글 이관: external_id 재싱크 중복 방지 + raw 원본 백스톱.
    --  created_at 은 미러가 원시각으로 직접 INSERT(네이티브 행은 DEFAULT now() 그대로).
    ALTER TABLE task_comment ADD COLUMN IF NOT EXISTS external_id TEXT;
    ALTER TABLE task_comment ADD COLUMN IF NOT EXISTS raw JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS task_comment_external_uidx ON task_comment(external_id) WHERE external_id IS NOT NULL;
  `);

  // ════════ #290(2026-06-30) 분류·링크·자료 재설계 — 모든 base 테이블 뒤(knowledge/project/*_category 의존). ════════

  // ── ⑭-a) knowledge_category·project_category 단일화 — 카테고리는 엔티티당 1개(또는 0=general). ──
  //  근거(#290): 단일=디시전 포싱 + 깨끗한 사이드바 트리(복수면 DAG) + 도메인 should/is 귀속 명확. 교차연결은 knowledge_link 가 흡수.
  //  전체 UNIQUE(name|project_id) — 0/1 만 허용. ⚠ 기존 복수매핑 잔존 시 생성 실패 → org_member_email idiom 처럼 **비치명적 보류**
  //  (scripts/290-single-and-source 가 단일화한 뒤 확정 생성, 이후 부팅은 IF NOT EXISTS no-op). 앱 쓰기경로도 single-mode(replace)로 강제.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_category_single_uq ON knowledge_category(name)`,
  ).catch((e) => { console.warn("[v6 schema] knowledge_category 단일 유니크 보류(기존 복수매핑 정리 후 적용):", (e as Error)?.message); });
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS project_category_single_uq ON project_category(project_id)`,
  ).catch((e) => { console.warn("[v6 schema] project_category 단일 유니크 보류(기존 복수매핑 정리 후 적용):", (e as Error)?.message); });

  // ── ⑭-b) knowledge_link — 지식↔지식 그래프(빠진 1급 프리미티브). category_edge idiom. ──
  //  relation=related(대칭)|refines|contradicts|depends_on(통제 어휘). 정션이 그래프뷰·백링크·recall 그래프의 쿼리 SoT
  //  (MediaWiki pagelinks·Notion relation 패턴). 지식 PK 가 name TEXT 라 from/to TEXT FK(CASCADE). no-self + (from,to,relation) 유니크.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_link(
      id SERIAL PRIMARY KEY,
      from_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      to_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_link'::regclass AND conname='knowledge_link_relation_chk') THEN
        ALTER TABLE knowledge_link ADD CONSTRAINT knowledge_link_relation_chk CHECK (relation IN ('related','refines','contradicts','depends_on'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_link'::regclass AND conname='knowledge_link_noself_chk') THEN
        ALTER TABLE knowledge_link ADD CONSTRAINT knowledge_link_noself_chk CHECK (from_name <> to_name);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_link_uq ON knowledge_link(from_name, to_name, relation);
    CREATE INDEX IF NOT EXISTS knowledge_link_from_idx ON knowledge_link(from_name);
    CREATE INDEX IF NOT EXISTS knowledge_link_to_idx ON knowledge_link(to_name);
    -- origin(2026-07-04 #551): 링크 생성 주체 — 'user'(사람/MCP) | 'connector:<system>'(커넥터가 노션 멘션/링크를 자동 물질화).
    --  커넥터는 자기 origin 링크만 삭제·재작성한다(사람이 만든 링크 불가침). 비파괴 ADD COLUMN(기존 행=user).
    ALTER TABLE knowledge_link ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
    CREATE INDEX IF NOT EXISTS knowledge_link_origin_idx ON knowledge_link(origin) WHERE origin <> 'user';
  `);

  // ── ⑭-b2) project_edge — 프로젝트↔프로젝트 그래프(후속 관계 등, knowledge_link idiom). ──
  //  relation=follow_up(from 이 to 의 후속 = from 은 후속, to 는 선행)|supersedes|depends_on|related. 1차 UI 노출=follow_up.
  //  project PK 가 INT id 라 from/to INT FK(CASCADE). no-self + (from,to,relation) 유니크. parent_id(=task 위계)와 직교.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_edge(
      id SERIAL PRIMARY KEY,
      from_project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      to_project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'follow_up',
      created_at TIMESTAMPTZ DEFAULT now(),
      created_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='project_edge'::regclass AND conname='project_edge_relation_chk') THEN
        ALTER TABLE project_edge ADD CONSTRAINT project_edge_relation_chk CHECK (relation IN ('follow_up','supersedes','depends_on','related'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='project_edge'::regclass AND conname='project_edge_noself_chk') THEN
        ALTER TABLE project_edge ADD CONSTRAINT project_edge_noself_chk CHECK (from_project_id <> to_project_id);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS project_edge_uq ON project_edge(from_project_id, to_project_id, relation);
    CREATE INDEX IF NOT EXISTS project_edge_from_idx ON project_edge(from_project_id);
    CREATE INDEX IF NOT EXISTS project_edge_to_idx ON project_edge(to_project_id);
  `);

  // ── ⑭-c) source — 자료층. raw 입력(이메일·슬랙·회의 전사록/minutes·외부 미러). knowledge 와 별도 테이블. ──
  //  ★별도 테이블 = recall(knowledge_search)이 자료를 **자동 미포함**(읽기경로 무수정). knowledge 의 미러/raw 컬럼이 귀속될 자리.
  //  kind=transcript|minutes|email|slack|notion_doc|clickup_doc|other. provenance=authored(우리 캡처)|observed(외부 미러).
  //  증류물(지식)은 knowledge_source 로 인용(카파시 source→wiki citation). name=선택적 슬러그(전사록 등 안정 키).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source(
      id SERIAL PRIMARY KEY,
      name TEXT,
      kind TEXT NOT NULL DEFAULT 'other',
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      raw JSONB,
      provenance TEXT NOT NULL DEFAULT 'observed',
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      sync_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ, last_synced_at TIMESTAMPTZ,
      author TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='source'::regclass AND conname='source_provenance_chk') THEN
        ALTER TABLE source ADD CONSTRAINT source_provenance_chk CHECK (provenance IN ('authored','observed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='source'::regclass AND conname='source_lifecycle_chk') THEN
        ALTER TABLE source ADD CONSTRAINT source_lifecycle_chk CHECK (lifecycle IN ('active','superseded'));
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS source_name_uq ON source(name) WHERE name IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS source_external_uidx ON source(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS source_kind_idx ON source(kind);
    CREATE INDEX IF NOT EXISTS source_occurred_idx ON source(occurred_at DESC NULLS LAST);
  `);

  // ── ⑭-d) knowledge_source — 지식→자료 인용. relation=derived_from(증류)|cites(참조). recall 그래프가 tier 가로지르는 다리. ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_source(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      source_id INT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'derived_from',
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(name, source_id, relation));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_source'::regclass AND conname='knowledge_source_relation_chk') THEN
        ALTER TABLE knowledge_source ADD CONSTRAINT knowledge_source_relation_chk CHECK (relation IN ('derived_from','cites'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS knowledge_source_source_idx ON knowledge_source(source_id);
  `);

  // ── ⑬ 임베딩(pgvector) — 벡터검색(#172) opt-in. provider≠off 일 때만 확장/컬럼(embedding_vector)/HNSW 인덱스 생성. ──
  //  기본 off=완전 no-op(pgvector 미설치 고객 DB 무손상). fail-open: 확장 없거나 실패해도 부팅·렉시컬 검색 무손상.
  //  설계: 지식 [[vector-search-172-design-pluggable-seam-oss]]. config SoT=org_runtime_config.embedding_config(getRuntimeConfig).
  try {
    const ec = await getRuntimeConfig();
    // ⚠ 컬럼/확장은 provider 와 무관하게 '항상' 보장한다. 쓰기·유사도 SQL 이 `embedding_vector IS NOT NULL` 로
    //  컬럼 존재를 가정하므로(off=NULL 이라 렉시컬 폴백 의도), 컬럼 자체가 없으면 폴백이 아니라
    //  'column "embedding_vector" does not exist' 크래시가 난다 — 임베딩 off(기본) 신규 박스에서 knowledge_save 가
    //  통째로 실패(어니스트 실박스 재현). items-db 는 pgvector 이미지(불변식)라 확장 상시 가용 → 항상 만들어도 안전
    //  (빈 컬럼/HNSW 도 저렴·멱등). 실제 벡터 채우기(백필)만 provider on 일 때(embedKnowledgeBestEffort).
    const ok = await ensureEmbeddingSchema(pool, ec.embedding_config.dimensions);
    console.log(`[v6 schema] 임베딩 스키마 ${ok ? "준비됨" : "건너뜀(렉시컬 폴백)"} (dim=${ec.embedding_config.dimensions}, provider=${ec.embedding_config.provider})`);
  } catch (e) {
    console.warn(`[v6 schema] 임베딩 스키마 준비 건너뜀(비치명적): ${(e as Error)?.message}`);
  }

  return "initialized v6 schema";
}

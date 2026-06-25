// Context OS v6 스키마 — greenfield 온톨로지 재설계.
//  맥락(Context) = Category(분류축) + Knowledge(맥락의 기록) + Project(맥락의 변화).
//  컷오버 완료(2026-06-24): 레거시 domain/knowledge_unit/org_project 는 드랍됨 — v6 가 단일 캐노니컬.
//  단일 통합 DB(itemsPool). 신규 정션은 같은 DB라 **진짜 FK** 를 쓴다.
//  ⚠ 호출 순서: index.ts 직렬체인에서 initOrgSchema(kind_registry/data_source 등)·initDomainmapSchema(activity/
//   mapping/debt) **이후** 호출 — activity_knowledge.activity_id 와 activity/mapping/debt ALTER 가 그 테이블에 의존.
//  내부 FK 순서: category → knowledge/project → 정션(knowledge_category/project_*) → activity/mapping/debt ALTER.
//  멱등: CREATE TABLE IF NOT EXISTS · ADD COLUMN IF NOT EXISTS · CHECK 은 pg_constraint 프로브(기존 idiom 그대로).
import { itemsPool } from "../items/store.js";

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
    UPDATE knowledge SET lifecycle='active' WHERE lifecycle='rejected';
    ALTER TABLE knowledge DROP CONSTRAINT IF EXISTS knowledge_lifecycle_chk;
    ALTER TABLE knowledge ADD CONSTRAINT knowledge_lifecycle_chk CHECK (lifecycle IN ('active','superseded'));
    -- WIKI 핀(2026-06-23): is_wiki=true 인 지식의 제목+메타만 가이드 위키섹션으로 항상-주입(본문 제외, 인덱스).
    --  injection(always/recalled)과 직교 — recalled 지식이되 인덱스엔 핀. 멱등 ADD COLUMN(기존 테이블 보강).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS is_wiki BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_external_uidx ON knowledge(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS knowledge_injection_idx ON knowledge(injection);
    CREATE INDEX IF NOT EXISTS knowledge_wiki_idx ON knowledge(is_wiki) WHERE is_wiki;
    CREATE INDEX IF NOT EXISTS knowledge_provenance_idx ON knowledge(provenance);
    CREATE INDEX IF NOT EXISTS knowledge_lifecycle_idx ON knowledge(lifecycle);
    CREATE INDEX IF NOT EXISTS knowledge_parent_idx ON knowledge(parent_name);
  `);

  // ── 4) knowledge_category — 지식↔카테고리 n:n(구 knowledge_unit_domain). 진짜 FK(같은 DB). ──
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

  // ── 7) project_category — 프로젝트↔카테고리 n:n(프로젝트 탭 사업/제품/시스템 탐색). ──
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
    ALTER TABLE mapping ADD COLUMN IF NOT EXISTS category_id INT REFERENCES category(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS mapping_target_category_uq ON mapping(target_kind, target_id, category_id) WHERE category_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS mapping_category_idx ON mapping(category_id);
    ALTER TABLE debt_finding ADD COLUMN IF NOT EXISTS category_id INT REFERENCES category(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS debt_finding_category_title_uq ON debt_finding(category_id, title) WHERE category_id IS NOT NULL;
  `);

  // ── 11) 태스크 상세(클릭업형 모달) — 태그·시간추적·체크리스트·의존성. 모두 task/subtask 행(project.id) 귀속. ──
  //  댓글/활동 피드는 전용 테이블 없이 재활용한다: ① 사용자 댓글 = activity(project_id=task id, type='comment'),
  //  ② 시스템 이벤트(상태변경·담당자·우선순위·기간·이름·설명·생성) = org_content_audit(entity='project', entity_key=task id)
  //  의 before/after 를 읽기경로에서 diff. → 새 이벤트 테이블 불필요, 전 이력 자동 포착. (org-wide activity/대시보드 오염도 없음 —
  //  태스크 댓글의 project_id 는 '태스크' id 라 프로젝트 타임라인(project_id=프로젝트) 필터에 안 잡힘.)
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

  // ── ⑧ 댓글 반응(클릭업식 이모지 리액션) — 댓글=activity(type=comment)의 id 에 (emoji, member) 토글. ──
  //  activity 는 initDomainmapSchema 가 먼저 생성(존재 보장) → 진짜 FK(같은 DB). 댓글 삭제 시 반응 동반 제거.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_comment_reaction(
      activity_id INT NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      member TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(activity_id, emoji, member));
    CREATE INDEX IF NOT EXISTS task_comment_reaction_act_idx ON task_comment_reaction(activity_id);
  `);

  return "initialized v6 schema";
}

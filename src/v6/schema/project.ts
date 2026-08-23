// v6 스키마 조각 — project core: 프로젝트/태스크 본체. project(위계 project▸task▸subtask) + 태스크 필드
//  보강(§5b)·status 정규화(§5c #177)·task_assignee(§5d)·external_outbox(§5e)·external_base(§5f 3-way 머지)·
//  fields/raw 무손실 백스톱(§5g #541).
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck, redefineCheck } from "../../org/schema/ddl-util.js";

export async function initV6ProjectCore(pool: Pool): Promise<void> {
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
    ${ensureCheck("project", {
      project_level_chk: "level IN ('project','task','subtask')",
      project_status_chk: "status IN ('active','done')",
    })}
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
    ${redefineCheck("project", "project_status_chk", "status IN ('active','done','todo','in_progress')")}
    ${redefineCheck("project", "project_priority_chk", "priority IS NULL OR priority IN ('urgent','high','normal','low')")}
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
    ${redefineCheck("project", "project_status_category_chk", "status_category IS NULL OR status_category IN ('backlog','unstarted','started','done','canceled')")}
    UPDATE project SET status_category = CASE
        WHEN status='done' THEN 'done'
        WHEN status='in_progress' THEN 'started'
        WHEN status='active' THEN 'started'
        WHEN status='todo' THEN 'unstarted'
        ELSE 'unstarted' END
      WHERE status_category IS NULL;
    CREATE INDEX IF NOT EXISTS project_status_category_idx ON project(status_category);
  `);

  // ── 5e) 아카이브(#1851, 2026-08-23) — 프로젝트를 **통째로 보관**하는 표식. 삭제가 아니라 '평소 화면에서 뺀다'. ──
  //  archived_at 이 있으면 목록(project_list_v6)은 기본으로 그 행을 빼고(archived=include|only 로 본다), 새 셸은
  //  사이드바에서 감추고 「아카이브」 화면에서 그 프로젝트와 그 아래 세션을 보여 준다. 되돌리면(NULL) 그대로 복귀.
  //  클래식 프로젝트 탭의 '아카이브 폴더'(#1067, project_folder.settings.kind='archive')와는 별개 표식 — 그쪽은 이동(리스트
  //  소속 변경)이고, 이쪽은 프로젝트 자신의 상태라 원래 리스트를 잃지 않는다.
  await pool.query(`
    ALTER TABLE project ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS project_archived_idx ON project(archived_at) WHERE archived_at IS NOT NULL;
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
}

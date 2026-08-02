// v6 스키마 조각 — task-detail: 클릭업형 태스크 상세 모달의 저장층. 태그·시간추적·체크리스트·의존성(§11)·
//  커스텀 필드(⑫)·첨부(⑫-b)·커넥터 멱등 좌표 가산(⑫-c #541)·댓글+이모지 반응(⑧).
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "../../org/schema/ddl-util.js";

export async function initV6TaskDetail(pool: Pool): Promise<void> {
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
    ${ensureCheck("task_link", { task_link_type_chk: "type IN ('blocking','waiting_on','linked')" })}
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
    -- #607/D 리스트별 커스텀 필드 — 필드가 어느 리스트(project_list) 전용인지. NULL=전역(모든 리스트에 표시, 기존 필드 하위호환).
    --  리스트 삭제 시 그 리스트 전용 필드도 함께 제거(FK CASCADE). 멱등 ADD COLUMN(기존 컬럼이면 스킵).
    ALTER TABLE task_field ADD COLUMN IF NOT EXISTS list_id INT REFERENCES project_list(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS task_field_list_idx ON task_field(list_id);

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
}

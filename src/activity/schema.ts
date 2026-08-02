// 작업(Activity) 스키마 init — domainmap/core/schema.ts 에서 원문 적출(#1313 R23. DDL 문자열 무수정).
//  왜 여기: activity/activity_touch/dash_watch 는 **게이트웨이 전역** 이벤트 레이어지 도메인맵 스캔 엔진의
//  테이블이 아니다. domainmap/core 는 '자기완결 스캔 엔진'(capabilities/domainmap-compat.ts 불변식)이어야 하므로
//  전역 기능을 여기로 뺀다 — store.ts(쓰기·읽기)와 같은 디렉터리에 스키마를 둔다.
//  ⚠ 실행 순서: boot/schemas.ts 의 직렬 체인에서 **initDomainmapSchema 직후 · initV6Schema 이전**.
//   앞(domainmap): change_log 가 있어야 activity_id ALTER 가 붙는다.
//   뒤(v6): initV6Schema 의 activity_knowledge.activity_id 가 activity(id) 를 FK 참조한다.
import { itemsPool } from "../db/client.js";

export async function initActivitySchema(): Promise<void> {
  const pool = itemsPool;
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
  // DISTINCT(PG15+)로 instance=NULL 중복 구멍 차단. knowledge/project 외부키 인덱스와 동형.
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
}

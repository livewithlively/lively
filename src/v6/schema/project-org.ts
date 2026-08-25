// v6 스키마 조각 — project-org: 프로젝트의 조직화 층. project_member(+FK 교정)·session_project(시간구간)·
//  session/session_log(#905 세션이력 자산화)·project_folder_binding(#905 P1-①)·project_list/folder/view
//  (§6c~6f 클릭업형 계층)·status_template(#729) + 정션(§7 project_category·§8 project_knowledge·§8-b
//  project_repo·§9 activity_knowledge)·§10 레거시 도메인맵 ALTER.
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "../../org/schema/ddl-util.js";

export async function initV6ProjectOrg(pool: Pool): Promise<void> {
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
  //   ⚠ **시간구간(temporal) 모델**(#905 C1) — 행 하나가 "이 세션이 valid_from 부터 이 프로젝트에 속했다"는 구간이다.
  //     한 세션이 재바인딩되면 옛 구간을 덮지 않고 **새 구간을 덧붙인다**. 그래야 A 밑에서 한 과거 작업이 B 로
  //     소급 재귀속되지 않는다(옛 단일키 UPSERT 의 라이브 버그). 작업 귀속은 '작업 발생시각이 어느 구간에 드느냐'로 판정.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_project(
      session_id TEXT NOT NULL,
      project_id INT REFERENCES project(id) ON DELETE CASCADE,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      binding_epoch BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, valid_from));
    CREATE INDEX IF NOT EXISTS session_project_project_idx ON session_project(project_id);
    -- 기존 배포(단일키 PK) → 시간구간 모델 이관. 신규 설치는 위 CREATE 로 이미 복합키라 아래는 전부 no-op.
    ALTER TABLE session_project ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
    ALTER TABLE session_project ADD COLUMN IF NOT EXISTS binding_epoch BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE session_project ALTER COLUMN project_id DROP NOT NULL;
    UPDATE session_project SET valid_from = created_at WHERE valid_from IS NULL;   -- 옛 바인딩은 기록 시각부터 유효했다
    ALTER TABLE session_project ALTER COLUMN valid_from SET NOT NULL;
    ALTER TABLE session_project ALTER COLUMN valid_from SET DEFAULT now();
    DO $$ BEGIN
      -- PK 가 아직 단일컬럼(session_id)이면 복합키(session_id, valid_from)로 교체. 이미 복합이면 건너뛴다(부팅마다 재구축 방지).
      IF EXISTS (
        SELECT 1 FROM pg_constraint con JOIN pg_index i ON i.indexrelid = con.conindid
        WHERE con.conrelid = 'session_project'::regclass AND con.contype = 'p'
          AND array_length(i.indkey, 1) = 1) THEN
        ALTER TABLE session_project DROP CONSTRAINT session_project_pkey;
        ALTER TABLE session_project ADD CONSTRAINT session_project_pkey PRIMARY KEY (session_id, valid_from);
      END IF;
    END $$;
  `);

  // 실행 세션의 **현재** 프로젝트 소속 정본. session_project 는 과거 구간(해제 포함)을 보존하고,
  // 이 표는 다음 턴에 적용할 desired와 실제로 전달된 applied revision을 분리한다. id는 tmux box id뿐 아니라
  // `codex-<thread uuid>` 같은 외부 하네스 실행 id도 받는다. cwd/대화 UUID는 정체성으로 쓰지 않는다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS execution_session(
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'unknown',
      managed_node_id TEXT,
      desired_project_id INT REFERENCES project(id) ON DELETE SET NULL,
      desired_revision BIGINT NOT NULL DEFAULT 0,
      applied_revision BIGINT NOT NULL DEFAULT 0,
      binding_epoch BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS execution_session_owner_idx ON execution_session(owner, last_seen DESC);
    CREATE INDEX IF NOT EXISTS execution_session_project_idx ON execution_session(desired_project_id) WHERE desired_project_id IS NOT NULL;

    -- 프로젝트 물리삭제도 실행 세션에는 명시 detach 전환이다. FK SET NULL만 두면 revision/epoch가 안 올라
    -- 이미 주입된 AGENTS 맥락이 영구 잔류한다. BEFORE trigger가 null 이력까지 남긴 뒤 FK가 no-op이 되게 한다.
    CREATE OR REPLACE FUNCTION execution_session_detach_deleted_project() RETURNS trigger AS $$
    BEGIN
      WITH changed AS (
        UPDATE execution_session
           SET desired_project_id=NULL, desired_revision=desired_revision+1, binding_epoch=binding_epoch+1,
               last_seen=now(), updated_at=now()
         WHERE desired_project_id=OLD.id
         RETURNING id, binding_epoch)
      INSERT INTO session_project(session_id, project_id, binding_epoch)
        SELECT id, NULL, binding_epoch FROM changed
      ON CONFLICT (tenant_id, session_id, valid_from) DO NOTHING;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS execution_session_project_delete_detach ON project;
    CREATE TRIGGER execution_session_project_delete_detach BEFORE DELETE ON project
      FOR EACH ROW EXECUTE FUNCTION execution_session_detach_deleted_project();
  `);

  // ── 세션이력 자산화(#905 C1) — 트랜스크립트를 중앙에 무결하게 append + 회수. 설계: [[project-905-design-assetization]] §5. ──
  //  ① session — **불멸** 세션 레지스트리. tmux 세션은 휘발이라(끝나면 사라짐) 로그·귀속의 안정된 기준점이 없었다.
  //     한 번 생기면 안 지운다(session_log 는 30일 reap 하지만 이 레코드는 남아 '있었다'를 증언). **키는 (node_id,
  //     session_id) 복합** — 같은 session_id 가 두 머신에 존재할 수 있다(경로무관 resume). node_id='' = 게이트웨이 로컬(박스).
  //  ② session_log — offset-CAS 워터마크. bytes = 지금까지 커밋된 총 바이트(= 다음 델타가 와야 할 offset). append 는
  //     조건부 UPDATE(WHERE bytes=$atOffset)로 원자적 — **락 없이** tailer 중복·재시작 재push·순서역전을 배제(설계 §5 ①).
  //  ③ session_log_chunk — 실제 내용(append-only). at_offset = append 당시 워터마크 = (node,session) 안에서 유일(CAS 보장).
  //     data = 캡처측이 슬림한 JSONL 바이트(zstd·채널필터는 후속 슬라이스 — 이 슬라이스는 내용 무관 바이트 append).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session(
      node_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      harness TEXT,
      owner TEXT,                    -- 첫 append 를 한 멤버 = 이 로그의 소유자(#905 C1 슬2b). 이후 그 사람만 append.
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));
    ALTER TABLE session ADD COLUMN IF NOT EXISTS owner TEXT;  -- 슬라이스1 스키마로 만들어진 기존 테이블 보강
    ALTER TABLE session ADD COLUMN IF NOT EXISTS title TEXT;  -- 웹뷰용 제목(#905 C1 슬⑤b) — 첫 사람 발화에서 자동 유도(uuid 대신).

    CREATE TABLE IF NOT EXISTS session_log(
      node_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id));

    CREATE TABLE IF NOT EXISTS session_log_chunk(
      node_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      at_offset BIGINT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (node_id, session_id, at_offset));
    -- reap(30일) 는 updated_at 기준 — 오래된 세션 로그부터. 인덱스로 스윕을 싸게.
    CREATE INDEX IF NOT EXISTS session_log_reap_idx ON session_log(updated_at);
    -- 무손실 압축 저장(#905 C1 슬②): data 는 압축될 수 있다. raw_len=원본(압축 전) 바이트, codec='zstd'면 data 가 압축본.
    --  ⚠ 워터마크·오프셋 회계는 항상 raw_len(원본) 기준. 구청크(raw_len NULL)는 octet_length(data)=원본(비압축)으로 취급.
    ALTER TABLE session_log_chunk ADD COLUMN IF NOT EXISTS raw_len BIGINT;
    ALTER TABLE session_log_chunk ADD COLUMN IF NOT EXISTS codec TEXT;
    -- 서브에이전트 트리 캡처(#905 C1 슬⑥): 서브에이전트 세션은 parent_session_id=부모(주) 세션 id. 최상위(주) 세션은 NULL.
    --  목록(내 세션·프로젝트)엔 최상위만, 서브에이전트는 부모 대화록 아래에서만 보인다.
    ALTER TABLE session ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
    CREATE INDEX IF NOT EXISTS session_parent_idx ON session(parent_session_id) WHERE parent_session_id IS NOT NULL;

    -- ④ session_purged — 소유자가 **완전 삭제**한 세션의 묘비(#1850). 내용은 담지 않는다(그게 삭제의 목적이다).
    --  왜 필요한가: 완전 삭제는 session/session_log 행을 통째로 지우므로 **워터마크가 0으로 돌아간다**. 그런데
    --  캡처 훅은 매 턴 "서버 워터마크부터" 올리므로, 그 세션이 아직 살아 있으면 다음 턴에 **대화 전문을 처음부터
    --  다시 올린다** — 지운 것이 스스로 부활한다. 이 묘비가 그 재수집을 거부하는 근거다(append 게이트).
    --  담는 것은 좌표(node_id·session_id)와 '누가 언제 지웠나'뿐 — 대화·제목·바이트 어느 것도 남기지 않는다.
    CREATE TABLE IF NOT EXISTS session_purged(
      node_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      purged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      purged_by TEXT,
      PRIMARY KEY (node_id, session_id));
  `);

  // ── 6a-2) project_folder_binding — 한 프로젝트가 **어느 멤버의 어느 환경에서 어느 절대경로에 사는가**(N:M, #905 P1-①). ──
  //  ⚠ 이름 주의: **project_folder(6d) 와 무관하다.** 그건 클릭업 Folder(폴더›리스트›프로젝트 의 정리용 상위층)이고,
  //   이건 **파일시스템 폴더의 호스트별 실물 위치**다. (같은 혼동이 코드에도 이미 있다 — createProjectFolder 가
  //   v6/folder-store.ts[클릭업 폴더]와 project-fs.ts[물리 디렉터리] 두 곳에 서로 다른 뜻으로 존재한다.)
  //
  //  왜 필요한가: project.folder 는 **1:1 컬럼**이고 "게이트웨이 공유베이스 하위 project/<id>" 전용이다
  //   (createProjectFolder(id) 가 project/<id> 만 만들고, projectAbsPath 가 그 밖이면 400). 그런데 실제로 한
  //   프로젝트는 **1 프로젝트 × N 멤버 × N 환경**에서 벌어진다 — 지금도 같은 project_id 로 폴더가 셋이다:
  //     ~/code/myapp(멤버가 진짜 일하는 곳) · ~/lively/projects/<id>(work.mjs) · workspace/project/<id>(정본이나 빈 껍데기).
  //   1:1 컬럼으로는 표현 자체가 불가 → 이 테이블이 나머지를 표현한다(project.folder 는 그대로 '박스 정본'을 유지).
  //
  //  키 설계:
  //   · node_id = 환경 식별자. 'central'=게이트웨이 박스(CENTRAL_NODE_ID 선례) · 등록 워커노드 id · 멤버 노트북은
  //     slugHost()(kit/cli/lively.mjs). **FK 없음** — 멤버 노트북은 노드 레지스트리에 없는 게 정상이라 참조무결성을
  //     걸면 정상 케이스가 막힌다.
  //   · member_id '' = **환경 공유(멤버 무관)** — 박스/워커노드의 프로젝트 폴더는 특정 멤버의 것이 아니다.
  //     (NULL 을 쓰면 PK 에 못 들어간다 → 빈 문자열 센티널.)
  //   · abs_path 가 키에 포함 — (프로젝트,멤버,환경) 하나에 폴더가 여럿인 게 **현재 실측 사실**이라(위 3개) 그걸 표현해야 한다.
  //   · sync = 그 폴더의 공유폴더 동기화 모드(none|pull|both). **로컬 마커(.lively/project.json)가 그 호스트의
  //     권위**이고(훅이 오프라인·DB 무관하게 읽어 fail-safe 판정) 이 컬럼은 **보고된 사본**이다 — 중앙에서
  //     "어디가 both 인가"를 보기 위한 것(웹/lively status/C3 up-sync 대상 선정). 권위를 여기로 옮기면
  //     게이트가 네트워크에 의존하게 되어 오프라인에서 fail-open 이 된다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_folder_binding(
      project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL DEFAULT '',
      node_id TEXT NOT NULL,
      abs_path TEXT NOT NULL,
      sync TEXT NOT NULL DEFAULT 'none',
      origin_key TEXT,
      binding_kind TEXT NOT NULL DEFAULT 'canonical',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, member_id, node_id, abs_path));
    CREATE INDEX IF NOT EXISTS project_folder_binding_member_idx ON project_folder_binding(member_id, node_id);
    CREATE INDEX IF NOT EXISTS project_folder_binding_origin_idx ON project_folder_binding(origin_key) WHERE origin_key IS NOT NULL;
    ALTER TABLE project_folder_binding ADD COLUMN IF NOT EXISTS binding_kind TEXT NOT NULL DEFAULT 'canonical';
    ${ensureCheck("project_folder_binding", { project_folder_binding_kind_chk: "binding_kind IN ('canonical','ephemeral')" })}
    -- 구 데이터 정규화는 유니크 인덱스를 처음 만드는 마이그레이션에서만 한다. 매 부팅마다 전 행을 갱신하지 않는다.
    DO $$
    BEGIN
      IF to_regclass('project_folder_binding_one_canonical_idx') IS NULL THEN
        WITH ranked AS (
          SELECT ctid, row_number() OVER (PARTITION BY project_id, node_id ORDER BY seen_at DESC, created_at DESC, abs_path) AS rn
            FROM project_folder_binding)
        UPDATE project_folder_binding b SET binding_kind=CASE WHEN ranked.rn=1 THEN 'canonical' ELSE 'ephemeral' END
          FROM ranked WHERE b.ctid=ranked.ctid;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS project_folder_binding_one_canonical_idx
      ON project_folder_binding(project_id, node_id) WHERE binding_kind='canonical';
    ${ensureCheck("project_folder_binding", { project_folder_binding_sync_chk: "sync IN ('none','pull','both')" })}
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
    -- 리스트↔카테고리(도메인) 소유(N:1) — 카테고리는 분류 SoT, 리스트가 카테고리를 이고 소속 프로젝트가 상속(프로젝트 단위
    --  project_category 를 대체). NULL=미분류. ON DELETE SET NULL(카테고리 삭제해도 리스트·프로젝트 보존). 상속 조회는
    --  project→project_list.category_id→category (구 project_category JOIN 을 리포인트). 기존 project_category 데이터 이관은
    --  별도 백필 스크립트(scripts/…)가 리스트 다수결로 채운다 — 이 컬럼은 그때까지 NULL(신규 리스트는 UI 피커로 지정).
    ALTER TABLE project_list ADD COLUMN IF NOT EXISTS category_id INT REFERENCES category(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS project_list_category_idx ON project_list(category_id) WHERE category_id IS NOT NULL;
  `);

  // ── 6e-2) 상태 체계 템플릿(#729) — 리스트 상태 스킴을 워크스페이스('스페이스') 단위 재사용 템플릿으로 관리.
  //  리스트를 새로 만들 때마다 상태 체계를 재생성하던 문제 해소: is_default=true 인 1개가 '스페이스 기본'으로,
  //  inherit(기본 상태 사용) 리스트가 이 스킴을 물려받는다(하드코딩 3단계 대신). 나머지는 이름있는 템플릿
  //  (상태편집기·새 리스트 폼에서 불러오기/적용). statuses=[{key,label,color,category(active|done|closed)}].
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_status_template(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS project_status_template_default_uidx ON project_status_template(is_default) WHERE is_default;
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
    ${ensureCheck("project_knowledge", { project_knowledge_relation_chk: "relation IN ('required','produced')" })}
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
    ${ensureCheck("activity_knowledge", { activity_knowledge_relation_chk: "relation IN ('produced','references','decided')" })}
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
}

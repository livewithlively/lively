// v6 스키마 조각 — ui-vis: UI 확장·임베딩·개인화·가시성. #592 지식/위키 UI(⑮-a~d 속성·폴더·카테고리 뷰·
//  댓글·전역 뷰 설정)·⑬ 임베딩(pgvector #172 — config 는 org_runtime_config.embedding_config 직접 SELECT)·
//  멤버 개인화(즐겨찾기 #670·대시보드 #1129·사이드바 #1227)·맥락 가시성(#1291 팀 grant·break-glass·경로 ACL).
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "../../org/schema/ddl-util.js";
import { ensureEmbeddingSchema, resolveEmbeddingConfig } from "../embedding-provider.js";

export async function initV6UiVis(pool: Pool): Promise<void> {
  // ════════ #592(2026-07-06) 지식/위키 UI 개편 — 속성 노출·폴더 트리·카테고리 뷰·댓글·전역 뷰 설정. ════════
  //  전부 가산(ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS) — 기존 행·쓰기경로 비파괴.
  //  knowledge/category 가 위(§1·§3)에서 이미 존재하는 시점(FK·ALTER 의존)이라 여기(⑮)에 몰아둔다.

  // ── ⑮-a) knowledge UI 확장 — props_ui(항목 단위 속성 노출 오버라이드) · is_folder(트리 그룹핑 폴더 노드). ──
  //  props_ui 를 fields 에 넣지 않는 이유: 커넥터 미러가 fields 를 통째로 재작성(connector-mirror.ts) —
  //  별도 컬럼이라야 재싱크에도 생존한다(observed 지식에도 속성 노출 설정 허용의 근거). 형태
  //  { show:[키], hide:[키], full_width:bool } — 자유형 JSONB, 검증은 쓰기경로(setKnowledgePropsUi/capability zod).
  //  is_folder = 본문 없이 저작 지식 트리를 그룹핑하는 폴더 노드(#592). 부분 인덱스(폴더는 소수 — 트리 조립용).
  await pool.query(`
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS props_ui JSONB;
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS is_folder BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS knowledge_folder_idx ON knowledge(is_folder) WHERE is_folder;
  `);

  // ── ⑮-b) category 뷰 설정 — entry_name(엔트리 문서 = knowledge.name 소프트 참조) · view_mode(list|table|entry). ──
  //  entry 뷰 = 카테고리 본문 영역에 엔트리 문서를 인라인 렌더(노션 위키 홈 패턴). FK 없는 소프트 참조 —
  //  지식 삭제 시 카테고리가 깨지지 않게(UI 가 부재를 우아하게 처리, 존재 검증은 쓰기경로 setCategoryView).
  await pool.query(`
    ALTER TABLE category ADD COLUMN IF NOT EXISTS entry_name TEXT;
    ALTER TABLE category ADD COLUMN IF NOT EXISTS view_mode TEXT NOT NULL DEFAULT 'list';
    ${ensureCheck("category", { category_view_mode_chk: "view_mode IN ('list','table','entry')" })}
  `);

  // ── ⑮-c) knowledge_comment(+reaction) — task_comment(⑧) 동형을 knowledge(name TEXT PK)로 이식. ──
  //  시스템 이벤트 병합 없음(태스크 피드와 달리 댓글+반응만 — knowledge-comment-store). reply_to 자기FK =
  //  1단계 스레드(쓰기경로가 중첩을 평탄화). 지식 삭제 시 댓글·반응 FK CASCADE 동반 정리.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_comment(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      author TEXT,
      body TEXT NOT NULL,
      reply_to INT REFERENCES knowledge_comment(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS knowledge_comment_name_idx ON knowledge_comment(name);
    CREATE INDEX IF NOT EXISTS knowledge_comment_reply_idx ON knowledge_comment(reply_to);
    CREATE TABLE IF NOT EXISTS knowledge_comment_reaction(
      comment_id INT NOT NULL REFERENCES knowledge_comment(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      member TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(comment_id, emoji, member));
    CREATE INDEX IF NOT EXISTS knowledge_comment_reaction_cmt_idx ON knowledge_comment_reaction(comment_id);
  `);

  // ── ⑮-d) knowledge_view_config 싱글턴(org_profile 패턴, org/schema.ts) — 전역 기본 숨김 속성 키 배열. ──
  //  전역 노출 = 속성 카탈로그 전체 − hidden_props. 항목 오버라이드(knowledge.props_ui show/hide)가 우선.
  //  시드는 빈 배열('[]') — 공장 기본 숨김 제안은 UI 의 '기본값 제안'으로만(#592 §1: 서버 시드 금지).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_view_config(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      hidden_props JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    INSERT INTO knowledge_view_config(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
  `);

  // ── ⑬ 임베딩(pgvector) — 벡터검색(#172) opt-in. provider≠off 일 때만 확장/컬럼(embedding_vector)/HNSW 인덱스 생성. ──
  //  기본 off=완전 no-op(pgvector 미설치 고객 DB 무손상). fail-open: 확장 없거나 실패해도 부팅·렉시컬 검색 무손상.
  //  설계: 지식 [[vector-search-172-design-pluggable-seam-oss]]. config SoT=org_runtime_config.embedding_config.
  //  ⚠ R19c org/store import 절단: 종전 getRuntimeConfig()(org/store/runtime-config) 대신 embedding_config 만 직접
  //   SELECT + resolveEmbeddingConfig — 그 함수가 getRuntimeConfig 의 병합 정책 그 자체라(DB 우선 → explicit-off →
  //   env(EMBEDDINGS_*) 시드, #688) 폴백 의미론 동일. 행 부재(undefined)도 동일하게 env 시드로 접힌다.
  try {
    const r = await pool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    const ec = resolveEmbeddingConfig((r.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config);
    // ⚠ 컬럼/확장은 provider 와 무관하게 '항상' 보장한다. 쓰기·유사도 SQL 이 `embedding_vector IS NOT NULL` 로
    //  컬럼 존재를 가정하므로(off=NULL 이라 렉시컬 폴백 의도), 컬럼 자체가 없으면 폴백이 아니라
    //  'column "embedding_vector" does not exist' 크래시가 난다 — 임베딩 off(기본) 신규 박스에서 knowledge_save 가
    //  통째로 실패(고객사 A 실박스 재현). items-db 는 pgvector 이미지(불변식)라 확장 상시 가용 → 항상 만들어도 안전
    //  (빈 컬럼/HNSW 도 저렴·멱등). 실제 벡터 채우기(백필)만 provider on 일 때(embedKnowledgeBestEffort).
    const ok = await ensureEmbeddingSchema(pool, ec.dimensions);
    console.log(`[v6 schema] 임베딩 스키마 ${ok ? "준비됨" : "건너뜀(렉시컬 폴백)"} (dim=${ec.dimensions}, provider=${ec.provider})`);
    // 프로젝트(project·task·subtask 통합 테이블) 임베딩 컬럼도 같은 config·차원으로 보장(#631 프로젝트 검색).
    //  knowledge 와 동일 이유로 provider 무관 항상 생성(embed/유사도 SQL 이 컬럼 존재 가정). 벡터 채우기는 백필/쓰기훅이 provider on 일 때.
    const okP = await ensureEmbeddingSchema(pool, ec.dimensions, "project");
    console.log(`[v6 schema] 프로젝트 임베딩 스키마 ${okP ? "준비됨" : "건너뜀(렉시컬 폴백)"} (dim=${ec.dimensions})`);
    // 카테고리(#1153) — 분류의 정의(should)를 벡터로. 소속 지식과의 거리 = 정의-내용 불일치(분류체계 탭이 드러내는 것).
    //  검색 대상이 아니라 **재는 고정점**이라 임베딩한다 — centroid 로 재면 분류 전체가 정의를 벗어나 표류할 때 못 잡는다.
    const okC = await ensureEmbeddingSchema(pool, ec.dimensions, "category");
    console.log(`[v6 schema] 카테고리 임베딩 스키마 ${okC ? "준비됨" : "건너뜀(렉시컬 폴백)"} (dim=${ec.dimensions})`);
  } catch (e) {
    console.warn(`[v6 schema] 임베딩 스키마 준비 건너뜀(비치명적): ${(e as Error)?.message}`);
  }

  // ── 멤버 즐겨찾기(#670) — 사용자별 '즐겨찾기' 핀. 리스트(project_list)·카테고리(category)를 사이드바 맨 위에 고정.
  //  개인 UI 상태(감사 대상 아님). target_kind='project_list'|'category', target_id=해당 id(TEXT 로 통일 저장).
  //  member_id 는 org_member.id(TEXT). 하드 FK 대신 다른 정션과 동일한 느슨한 참조(멤버 삭제 정리는 별도).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_favorite(
      member_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (member_id, target_kind, target_id));
    CREATE INDEX IF NOT EXISTS member_favorite_member_idx ON member_favorite(member_id);
  `);

  // ── 멤버 대시보드 개인화(#1129) — '내 프로젝트' 위젯 개요 카드 정리(리스트 순서·숨김·직접추가 핀)를 멤버별 서버 저장.
  //  즐겨찾기(member_favorite)와 같은 개인 UI 상태(감사 대상 아님). 기존엔 localStorage(기기별)라 다른 기기/브라우저로
  //  들어오면 정리가 사라졌다 — 계정에 묶어 어디서 들어와도 유지. prefs=JSON 한 덩어리(멤버당 1행, upsert).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_dash_pref(
      member_id TEXT PRIMARY KEY,
      prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);

  // ── 프로젝트 사이드바 개인화(#1227) — 폴더·스페이스 접힘/펼침을 멤버별 서버 저장.
  //  기존엔 인메모리 Map(탭 세션 한정)이라 새로고침만 해도 접어둔 폴더가 전부 다시 펼쳐졌다.
  //  대시보드 개인화(member_dash_pref)와 같은 개인 UI 상태(감사 대상 아님). prefs=JSON 한 덩어리(멤버당 1행, upsert).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_side_pref(
      member_id TEXT PRIMARY KEY,
      prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);

  // ── 맥락 가시성(#1291) — 열람 가시성(read)을 프로젝트 계층 밖(지식·자료)까지 확장하고, 대상(audience)에 팀 축을 연다. ──
  //  전부 additive + 기본값이 현행 동치('open') → 아무도 잠그지 않으면 동작 변화 0.
  //  ⚠ project_list_member(멤버 grant)는 **건드리지 않는다**: PK 를 (list_id, subject_kind, member_id) 로 확장하면
  //   구코드의 `ON CONFLICT (list_id, member_id)` arbiter 가 42P10 으로 깨지고(list-store createProjectList),
  //   kind 를 모르는 구코드 DELETE 가 팀 grant 를 지운다. 다운 마이그레이션이 없는 배포(롤백=구코드 rsync)라
  //   신스키마 위에서 구코드가 무결히 돌아야 한다 → 팀은 분리 테이블로.
  await pool.query(`
    -- 팀 grant(리스트) — v1 은 스키마만(API/UI 는 후속). 팀은 라이브 그룹핑이라 멤버 churn 이 자동 반영된다.
    CREATE TABLE IF NOT EXISTS project_list_team(
      list_id INT NOT NULL REFERENCES project_list(id) ON DELETE CASCADE,
      team_id INT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (list_id, team_id));
    CREATE INDEX IF NOT EXISTS project_list_team_team_idx ON project_list_team(team_id);
    -- 스페이스(최상위 project_folder) 공개범위 — 하위 리스트가 상속(AND). 폴더 중첩 재귀를 피하려 v1 은 스페이스 한정 운용.
    ALTER TABLE project_folder ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open';
    CREATE TABLE IF NOT EXISTS project_folder_member(
      folder_id INT NOT NULL REFERENCES project_folder(id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL DEFAULT 'member',
      member_id TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (folder_id, subject_kind, member_id));
    CREATE INDEX IF NOT EXISTS project_folder_member_member_idx ON project_folder_member(member_id);
    -- 지식·자료 문서 단위 가시성 + grant. 'members' 인데 grant 가 비면 admin 만(빈 audience 는 fail-closed).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open';
    CREATE TABLE IF NOT EXISTS knowledge_member(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL DEFAULT 'member',
      member_id TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (name, subject_kind, member_id));
    CREATE INDEX IF NOT EXISTS knowledge_member_member_idx ON knowledge_member(member_id);
    -- 컨테이너 참조 grant — 세션 산출 지식은 멤버를 열거하지 않고 '그 리스트를 보는 사람'을 가리킨다(라이브 추종).
    --  멤버를 굳혀두면 리스트에서 빠진 사람이 과거 지식에 계속 접근하고, 새로 합류한 사람은 못 본다(스냅샷 부패).
    CREATE TABLE IF NOT EXISTS knowledge_list_grant(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      list_id INT NOT NULL REFERENCES project_list(id) ON DELETE CASCADE,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (name, list_id));
    ALTER TABLE source ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open';
    CREATE TABLE IF NOT EXISTS source_member(
      source_id INT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL DEFAULT 'member',
      member_id TEXT NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, subject_kind, member_id));
  `);
  // ── 공유폴더 경로 ACL(#1291 v2) — 프로젝트 폴더 밖의 공유 워크스페이스를 폴더 단위로 잠근다. ──
  //  프로젝트 폴더(project/<id>)는 프로젝트 가시성을 상속하므로 여기 넣지 않는다. 판정은 v6/shared-folder-store.ts.
  //  path = 공유 루트 기준 상대경로(POSIX, 앞뒤 / 없음). 루트 자신은 빈 문자열.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_folder_acl(
      path TEXT PRIMARY KEY,
      visibility TEXT NOT NULL DEFAULT 'open',
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS shared_folder_member(
      path TEXT NOT NULL REFERENCES shared_folder_acl(path) ON DELETE CASCADE ON UPDATE CASCADE,
      subject_kind TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'team'
      member_id TEXT NOT NULL,                        -- subject_kind='team' 이면 team.id 의 문자열
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (path, subject_kind, member_id));
    CREATE INDEX IF NOT EXISTS shared_folder_member_member_idx ON shared_folder_member(member_id);
  `);

  // ── 긴급 열람(break-glass, #1291 v2) — admin 이 공개범위를 **한시적으로** 넘는 유일한 문. ──
  //  admin 은 더 이상 그냥 우회하지 않는다(그러면 admin 의 AI 자동화가 잠긴 내용을 읽어 공개 지식으로 되뱉는다).
  //  대신 사유를 적고 열면 그 사실이 감사에 남고 대상자에게 통지된다 — 열람 자체를 막는 게 아니라 **흔적 없는 열람**을 막는 것이다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vis_break_glass(
      id SERIAL PRIMARY KEY,
      member_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      scope_kind TEXT,                  -- NULL=전체 / 'project_list' / 'project_folder'
      scope_id TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      notified_at TIMESTAMPTZ);
    -- 활성 판정은 요청마다 도는 뜨거운 경로다 — (member, 만료) 인덱스로 즉답하게.
    CREATE INDEX IF NOT EXISTS vis_break_glass_active_idx
      ON vis_break_glass(member_id, expires_at) WHERE ended_at IS NULL;
  `);

  // CHECK 는 비정규 값을 먼저 정규화한 뒤 건다(구 데이터에 'open'|'members' 밖 값이 있으면 ADD CONSTRAINT 가 실패).
  //  술어 두 개(IS DISTINCT FROM 'members' / = 'members')가 비정규 값에 서로 다르게 반응하는 걸 막는 게 목적.
  await pool.query(`UPDATE project_list SET visibility='open' WHERE visibility NOT IN ('open','members')`);
  for (const [table, name] of [["project_list", "project_list_visibility_chk"], ["project_folder", "project_folder_visibility_chk"],
    ["knowledge", "knowledge_visibility_chk"], ["source", "source_visibility_chk"]] as const) {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (visibility IN ('open','members'));
      END IF;
    END $$;`);
  }
}

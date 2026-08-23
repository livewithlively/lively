// org 스키마 조각 — sessions-infra: 게이트웨이 실행 인프라. org_cron(스케줄 잡+시드)·org_managed_session
//  (상시 세션)·org_session_state(세션 desired-state 미러)·org_preview_env/org_stack_profile(프리뷰)·
//  org_node(분산 노드)·org_task(위탁 태스크).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";

/**
 * org_cron.action 허용목록 — **이 배열이 유일한 출처**다. 아래 CHECK 제약을 여기서 조립한다.
 *
 * ⚠ 왜 상수로 뺐나(#1419): 같은 목록이 여기(DB 제약)와 scheduler/registry.ts(CRON_ACTIONS — 화면
 *  드롭다운의 출처)에 **손으로 두 번** 적혀 있었다. 그래서 T5 가 registry 에 'run_managers' 를
 *  추가하고 이쪽을 안 고쳤고, 결과는 **화면이 제공하는 액션을 저장하면 제약 위반으로 실패**였다 —
 *  관리기 4종에 자동 실행 경로가 아예 없었는데, 실패가 크론 저장 시점에만 나므로 아무도 몰랐다.
 *  이제 scheduler/cron-action-allowlist.test.ts 가 두 목록의 일치를 잠근다(한쪽만 늘리면 red).
 *
 * 확장 절차: 이 배열에 키를 넣는다. 아래가 DROP+ADD 라 기존 박스도 다음 부팅에 제약이 갱신된다
 *  (ADD CONSTRAINT IF NOT EXISTS 만으론 라이브 제약이 안 바뀐다).
 */
export const CRON_ACTION_ALLOWLIST = [
  "refresh_all", "refresh_repo", "refresh_bases",
  "connector_sync", "connector_push", "wiki_push",
  "eval_domain_debt",
  "map_unmapped", "map_unmapped_headless",
  "classify_knowledge", "classify_knowledge_headless",
  "bootstrap_is",
  "distill_sources", "distill_sources_headless",
  "run_managers",          // #1419 T5 — 관리기 실행(어긋남·아웃데이티드·모순·코드괴리)
  "agent_inject", "agent_headless",
  "ensure_managed_sessions", "wikilink_sweep", "preview_reconcile",
  "run_canary",            // #1657 — 상류 회귀 자동탐지(카나리)
] as const;

export async function initSessionsInfra(pool: Pool): Promise<void> {
  // ── org_cron — 서버사이드 스케줄 잡(웹 관리). is 신선화·커넥터 sync 등을 게이트웨이 프로세스가 주기 실행. ──
  //  트리거 표준화: git push 웹훅(도달성+repo당 등록 필요)을 대체 — 게이트웨이가 바깥으로 fetch 하므로 직원 0·repo셋업 0.
  //  보안: action 은 allowlist enum(임의 셸 금지 — org_hook 은 멤버 머신, 이건 게이트웨이 권한이라 블래스트 반경↑).
  //  params = 액션 인자(예: {repo} / {system}). interval_sec = 폴 주기(최소 60 앱 강제). 단일 프로세스 전제(리더선출 불요).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_cron(
      id TEXT PRIMARY KEY,
      label TEXT,
      action TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}'::jsonb,
      interval_sec INT NOT NULL DEFAULT 600,
      cron_expr TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_run_at TIMESTAMPTZ,
      last_status TEXT,
      last_summary JSONB,
      next_run_at TIMESTAMPTZ,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      -- action allowlist — 확장 시 DROP+ADD(IF NOT EXISTS 만으론 라이브 제약이 안 바뀜).
      --  목록은 CRON_ACTION_ALLOWLIST 에서 조립한다(이 파일 상단 — 손으로 두 번 적지 않는다).
      ALTER TABLE org_cron DROP CONSTRAINT IF EXISTS org_cron_action_chk;
      ALTER TABLE org_cron ADD CONSTRAINT org_cron_action_chk
        CHECK (action IN (${CRON_ACTION_ALLOWLIST.map((a) => `'${a}'`).join(",")}));
    END $$;
    -- cron_expr(절대 벽시계 스케줄, 5필드). NULL=interval_sec 상대 모드. 기존 테이블 비파괴 추가.
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS cron_expr TEXT;
    -- run_once = 1회 실행 후 자동 비활성(반복 안 함). 부트스트랩 등 일회성 잡용. 비파괴 추가.
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS run_once BOOLEAN NOT NULL DEFAULT false;
    -- ── 연속 실패 서킷 브레이커(#1675 ④) ──
    --  어니스트 2026-08-12: 증류 크론이 **200건 넘게 연속 실패**하는 동안 아무 제동이 없었다. 잡 하나가
    --  10분마다 계속 실패하는 상태는 그 자체로 고장이지, 다음 주기에 나아질 일이 아니다.
    --  fail_streak = 연속 실패 횟수(성공 1회로 0 리셋) · max_fail_streak = 이 값에 닿으면 자동 정지(0=끔).
    --  잡별 컬럼인 이유: 적정 임계가 잡마다 다르다(증류는 짧게, 외부 API 커넥터는 일시 장애를 견디게 길게).
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS fail_streak INT NOT NULL DEFAULT 0;
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS max_fail_streak INT NOT NULL DEFAULT 5;
    -- 자동 정지 흔적 — 관리탭이 "누가 껐나"를 사람 손과 구분해 보여줘야 재개 버튼을 낼 수 있다.
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS auto_disabled_at TIMESTAMPTZ;
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS auto_disabled_reason TEXT;
  `);
  // 기본 잡 시드(최초 1회만 — 운영자 변경 보존).
  //  refresh_all: 커밋→is 자동 반영(결정적, LLM 없음). map_unmapped: 미매핑→도메인 LLM 분류(라이블리 시드 에이전트) — 토큰 설정 전이라 기본 OFF.
  await pool.query(`
    INSERT INTO org_cron(id, label, action, interval_sec, enabled, note) VALUES
      ('refresh-all-domainmap','도메인맵 is 신선화 (전 repo)','refresh_all',600,true,
       'last_refreshed_sha→origin/HEAD 증분 diff 를 결정적 refresh 엔진에 먹인다(LLM 없음). 멱등.'),
      ('refresh-provision-bases','작업 base 레포 확보·최신화 (워크트리 원본)','refresh_bases',1800,true,
       '관리탭 등록 레포를 이 호스트 workspace/repos 에 없으면 clone·있으면 FF — 워크트리 셀프서비스(lively_local_repo_worktree)의 최신 원본을 무인 보장. 도메인맵 스캐너 클론(refresh_all, stateDir/repos)과 대상이 다르다.'),
      ('map-unmapped-domains','미매핑 코드유닛 LLM 분류 (상시 세션 주입)','map_unmapped',1800,false,
       '상시 LLM 세션(라이블리 시드, 팀플랜 과금)에 분류 태스크를 tmux send-keys 로 주입 → 세션이 도메인 should+DDD 로 분류(propose+근거→audit). 활성화 전 params.session 에 타깃 세션 id 설정 필요 → 기본 enabled=false.'),
      ('classify-unmapped-knowledge','미분류 지식 LLM 분류 (상시 세션 주입, #982)','classify_knowledge',3600,false,
       'map_unmapped 의 지식판 — 카테고리 0건 지식(노션 미러 등 인입분)을 상시 세션에 주입해 카테고리(사업·제품·시스템 전체)로 분류(propose+근거→proposed). 미분류=recall INNER JOIN 에서 소환 불가라 편입의 핵심. 활성화 전 params.session 설정 필요 → 기본 enabled=false.'),
      ('keepalive-managed-sessions','상시 세션 keep-alive','ensure_managed_sessions',120,true,
       'enabled 상시 세션(org_managed_session)의 tmux 세션을 보장 — 죽었으면 격리 워크스페이스에 재생성. 등록된 상시 세션 없으면 no-op.')
    ON CONFLICT DO NOTHING;
  `);
  // #177 아웃바운드 푸시 잡 — external_outbox(우리 편집)→ClickUp. 우리 DB=master 반영. params.system='clickup'(run-push 는 clickup 전용).
  //  검증 전이라 기본 enabled=false — 수동 run-push 1회 확인 후 관리탭/DB 로 활성화. 별도 INSERT(params 컬럼 포함).
  await pool.query(`
    INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, note) VALUES
      ('push-clickup','ClickUp 아웃바운드 푸시 (우리 편집→ClickUp)','connector_push','{"system":"clickup"}'::jsonb,120,false,
       'external_outbox(pending) 드레인 → ClickUp create/update/delete. 로컬 편집을 미러에 반영(멱등, 부모 미푸시면 다음 틱 수렴). 검증 후 enabled=true.'),
      ('push-wiki-notion','위키 아웃바운드 푸시 (산출 지식→노션 피드, #976)','wiki_push','{}'::jsonb,600,false,
       '등록 노션 feed_target(category_feed N:M 매핑)으로 정본·authored 지식을 피드 카드로 투영. 옵트인: 매핑 없으면 무동작. 멱등(content_hash skip). 피드 DB 부트스트랩+exclude_pages 등록·라이브 E2E 검증 후 enabled=true.')
    ON CONFLICT DO NOTHING;
  `);
  // #177 #6d 인바운드 싱크 잡 — ClickUp→우리, external_base 3-way 머지(name/desc/status_category). 충돌=우리 DB master.
  //  검증 전 기본 enabled=false. 아웃바운드(push-clickup)와 함께 가동하면 <5분 양방향 항상 싱크.
  await pool.query(`
    INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, note) VALUES
      ('sync-clickup','ClickUp 인바운드 싱크 (ClickUp→우리, 3-way 머지)','connector_sync','{"system":"clickup"}'::jsonb,240,false,
       'run-sync clickup — 컨테이너 Task 당겨 external_base 3-way 머지(theirs==base→ours, ours==base→theirs, 충돌→ours). 검증 후 enabled=true.')
    ON CONFLICT DO NOTHING;
  `);
  // #1289 자료 증류 잡 — ⚠ **여기서 시드하지 않는다.** 이 잡이 어느 박스에도 없어서 증류가 0이었으니(고객사 A 실측:
  //  10,900건 중 13건) 시드가 자연스러워 보이지만, 그러면 이 릴리스가 **롤백 불가**가 된다:
  //  시드 행의 action('distill_sources_headless')은 구버전 코드의 org_cron_action_chk 허용목록에 없다 →
  //  구버전으로 되돌려 기동하면 위 DROP+ADD CONSTRAINT 가 그 행을 검증하다 실패해 **게이트웨이가 아예 안 뜬다**.
  //  (신규 enum 값을 참조하는 행을 마이그레이션이 만들면 항상 이 성질이 생긴다 — 값 추가와 행 생성을 같은 배포에 묶지 마라.)
  //  대신 발견성은 UI 가 맡는다: 관리탭 [AI 맥락 ▸ 자료 증류기]에 '증류 잡 만들기' 버튼이 있어 증류기를 설정한
  //  그 자리에서 한 번에 만든다 — 숨어 있는 비활성 시드보다 오히려 눈에 띄고, 사람이 만든 행이라 롤백도 사람 몫이 된다.

  // ── org_managed_session — 상시 에이전트 세션의 desired state(관리탭 CRUD). keep-alive(ensure_managed_sessions 크론)가 ──
  //  실제 tmux box-* 세션을 보장(없으면 재생성). account = 어떤 라이블리 계정/프로필(=클로드 로그인)으로 띄울지 —
  //  지금 맥미니 단일 프로필, 멀티프로필 대비 필드. session_id = 현재 살아있는 tmux 세션(provision 시 기록).
  //  격리 워크스페이스(공유폴더 managed/<id>)·하네스·플래그·자동승인은 프로젝트 터미널 생성(createSession) 그대로 재사용.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_managed_session(
      id TEXT PRIMARY KEY,
      label TEXT,
      account TEXT,
      workspace_subpath TEXT,
      harness TEXT NOT NULL DEFAULT 'claude',
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      auto_approve BOOLEAN NOT NULL DEFAULT true,
      enabled BOOLEAN NOT NULL DEFAULT true,
      session_id TEXT,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

  // ── org_session_state — 웹터미널 세션의 desired-state DB 미러(#1059 E). ──
  //  왜(#1059): 세션 메타(owner·label·harness·dir·flags·invites·project·mode)의 SoT 는 tmux @box_* user-option 인데
  //   **재부팅 = tmux 서버 사망 = 그 메타 전부 증발** → 어떤 세션이 있었는지조차 알 수 없어 복원 진입점이 사라진다.
  //   이 테이블이 그 desired-state 를 DB 에 미러해, 재부팅 후에도 세션이 '복원 가능(restorable)' 목록으로 살아남고,
  //   사용자가 '열 때' lazy 하게 createSession(resume=<id>)로 재생성된다(부팅 시 전부 자동 spawn 은 OOM 재현이라 금물).
  //  ⚠ **미러지 SoT 아님**(storage_policy 교리와 달리 여긴 tmux 가 SoT): tmux 가 살아있으면 tmux 가 진실,
  //   DB 는 재부팅 백업 + F(reaper)의 desired-state 보존처. listSessions 병합이 tmux 우선(라이브)·DB 폴백(offline).
  //  root_key/subpath = 재생성 좌표(createSession 입력). last_busy = F(reaper)의 idle 판정 기준(@box_last_busy 미러).
  //  last_seen = 마지막으로 라이브(tmux)로 관측된 시각 — 오래 안 보이면 stale 정리 후보(도그푸드; 지금은 조회만).
  //  managed 세션(org_managed_session)은 여기 넣지 않는다 — keep-alive 가 그 영속을 소유하므로(createSession managed 플래그가 upsert skip).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_state(
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      label TEXT,
      harness TEXT NOT NULL DEFAULT 'claude',
      dir TEXT,
      root_key TEXT,
      subpath TEXT,
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      auto_approve BOOLEAN NOT NULL DEFAULT false,
      invites JSONB NOT NULL DEFAULT '[]'::jsonb,
      project_id INT,
      project_src TEXT,
      read_only BOOLEAN NOT NULL DEFAULT false,
      incognito BOOLEAN NOT NULL DEFAULT false,
      created BIGINT,
      last_busy BIGINT,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // owner 로 자주 조회(복원 목록 = 이 사용자의 tmux 에 없는 레코드) — 인덱스로 스캔 회피.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_state_owner_idx ON org_session_state(owner);`);
  // #1059 정밀 복원 — 이 box 세션이 **현재 도는 claude 자신의 세션 UUID**(box-id ≠ claude UUID). work-flag 훅이 세션
  //  활동 시 (box-id, claude session_id)를 보고해 last-write-wins 로 갱신(한 box 안에서 branch·resume·/clear 로 UUID 가
  //  바뀔 수 있으므로 최신만 유지). 복원 시 이 값으로 `claude --resume <uuid>` 정밀 이어받기. null=미상(셸·코덱스·미보고)→picker 폴백.
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS claude_session_id TEXT;`);
  // #1746 — 하네스 대화 파일의 절대경로(훅 보고). 대화창이 하네스 무관하게 그 파일을 읽는 근거(harness-io/locate.ts).
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS transcript_path TEXT;`);
  // #1059 — **사용자 정상 종료** 표시(exited_at). claude SessionEnd 훅이 reason=prompt_input_exit(/exit·Ctrl-D)·logout
  //  일 때 보고 → 이 box 가 tmux 에서 사라진 뒤 복원목록에서 '종료됨(대화 이어보기)'으로 뜬다. NULL 이면(재부팅·강제kill·
  //  reaper 회수 — 훅이 프로세스 사망으로 못 뜸) '복원 가능(중단됨)'. exit_reason 은 진단용(어떤 사유였나).
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS exited_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS exit_reason TEXT;`);
  // #1791 — **노드 세션도 이 표에 산다.** node_id = 그 세션이 도는 노드(멤버 PC·워커·매니지드 실행환경). NULL = 게이트웨이 박스.
  //  왜: 노드 세션은 노드 에이전트가 만드는데 노드엔 DB 가 없어 행이 없었고, 그 tmux/psmux 가 죽으면 흔적 없이 사라졌다
  //   (2026-08-18 hammurabi — 세션 5개가 동시에 "세션을 찾을 수 없어요", 복원 카드조차 없음). 이제 **게이트웨이가**
  //   노드 create 릴레이 직후 행을 쓴다(정본 = DB, 노드 = 실행 표면). 복원(restore)은 node_id 의 노드에 create 를 다시 릴레이한다.
  //  ⚠ 소비자는 이 컬럼을 보고 갈라야 한다 — 복원 목록은 그 노드의 것으로 표시하고, reaper·백필(중앙 tmux 만 훑는다)은
  //   라이브 목록에 없는 id 라 원래 건드리지 않는다. 종전 node-session-map.ts 헤더의 "INSERT 기각" 근거가 이 컬럼으로 해소된다.
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS node_id TEXT;`);
  // #1291 v2 — 세션 **기록 범위**(write cap)와 read 축소의 desired-state 미러.
  //  tmux user-option 이 권위지만 tmux 가 죽으면(재부팅·회수) 그 값이 사라진다 → 복원 때 캡이 넓어지지 않게 여기 남긴다.
  //  write_vis: 'open'|'audience'|'private' (NULL=미설정 → 실행 폴더에서 재파생). restrict: read 축소(owner∪invites) 여부.
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS write_vis TEXT;`);
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS restrict_read BOOLEAN NOT NULL DEFAULT false;`);

  // ── org_session_trash — 세션 휴지통(#1851). ──
  //  왜: 새 셸의 '지난 세션'에서 ×(완전 삭제)를 누르면 desired-state 행이 곧바로 사라졌다 — 되돌릴 길이 없고, 중앙 기록(uuid)
  //   행은 남아 '기록' 세션으로 다시 떠올랐다(같은 대화가 지웠는데도 목록에 돌아온다). 그래서 **두 단계**로 나눈다:
  //   휴지통으로(trashed_at) → 거기서 되돌리기 / 완전 삭제(purged_at). 목록 응답은 trashed 행에 표식만 얹고(화면이 가른다),
  //   purged 행은 아예 빼서(desired-state 는 지우고, 중앙 기록은 조직 보존정책대로 남되 이 사람 목록에선 안 보인다) '지웠는데
  //   돌아오는' 일을 막는다. 세션 하나가 두 id(박스 id·대화 uuid)로 잡히므로 **둘 다** 행으로 둔다(한쪽만 두면 다른 쪽으로 되살아난다).
  //  owner 게이트 — 자기 세션만(복원·되살리기와 같은 규칙).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_trash(
      session_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      trashed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      purged_at TIMESTAMPTZ);
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_trash_owner_idx ON org_session_trash(owner);`);

  // ── org_session_outbox — 세션 프롬프트 아웃박스(#1719 #1753). ──
  //  왜: send-keys 는 ack 가 없는 통로 — 로그인·대화상자에 멈춘 세션에 밀어 넣은 프롬프트가 조용히 사라졌다(실측).
  //   보내기는 여기 쌓고, 박스별 배달자가 준비 판정(입력창 표식) 후 넣고 트랜스크립트 에코로 delivered 를 확정한다
  //   (src/sessions/session-outbox.ts). 화면은 queued·failed 를 그대로 보여 새로고침에도 안 사라진다.
  //  status: queued(대기) · sending(배달 중) · delivered(에코 확인) · sent(보냈으나 에코 미확인 — 재전송 금지) · failed(사유 last_error).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_outbox(
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INT NOT NULL DEFAULT 0,
      trust_ok BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ);
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_outbox_session_idx ON org_session_outbox(session_id, status);`);
  //  kind: prompt(사람이 보낸 말 — 대화창에 말풍선으로 뜬다) · control(설정 슬래시 명령 — 모델·추론강도 바꾸기, #1758).
  //   control 은 ⓐ 대화창 목록에서 빠지고(사람이 친 말이 아니다) ⓑ 에코 확인을 건너뛴다 — 슬래시 명령은
  //   트랜스크립트에 친 글자 그대로가 아니라 `<command-name>` 형태로 적혀 그 바늘로는 영영 못 찾는다.
  //   같은 큐를 타는 이유는 순서다: 모델 바꾸기가 그 다음 프롬프트보다 먼저 들어가야 하고, 배달자는 세션당 직렬이다.
  await pool.query(`ALTER TABLE org_session_outbox ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'prompt';`);
  // 끝난 행(delivered·sent)은 하루 지나면 청소 대상 — resumeOutbox 가 부팅 때 지운다(무한 적재 방지).

  // ── org_preview_env — 프리뷰 환경(작업자별 격리 미리보기)의 desired state (#1036). 관리탭 CRUD. ──
  //  kind=work: 작업 워크트리(project/<id>)를 게이트웨이가 /preview/<id>/ 서브패스로 정적 서빙(shared-proxy — /api 는 게이트웨이 자신).
  //   프론트가 API 를 root-relative(/api/ui)로 부르므로 페이지가 서브패스에서 로드돼도 진짜 API 로 간다 → 별도 프로세스·포트·프록시 불필요.
  //  worktree_path = 서빙할 워크트리 절대경로(비우면 project_id+repo 로 canonical 슬롯 workspace/project/<id>/<repo> 계산).
  //  kind=stage(2단계): 여러 브랜치를 base 위에 merge 한 통합 워크트리. backing_mode·backing_ref 는 3단계(throwaway·existing-ref) 확장 대비.
  //  포트·pid 컬럼은 3단계에서 별도 백엔드 프로세스를 띄울 때 ALTER ADD(shared-proxy 는 불요). §설계 preview-environment-design-1036.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_preview_env(
      id TEXT PRIMARY KEY,
      label TEXT,
      kind TEXT NOT NULL DEFAULT 'work',
      owner_member TEXT,
      project_id INT,
      repo TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      backing_mode TEXT NOT NULL DEFAULT 'shared-proxy',
      backing_ref TEXT,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_error TEXT,
      last_active_at TIMESTAMPTZ,
      ttl_idle_sec INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);
  // #1036 2단계 stage 통합 — 여러 작업 브랜치를 base 위에 merge 한 통합 워크트리. 기존 org_preview_env 에 비파괴 추가.
  //  member_branches = 통합할 브랜치 목록(project/<id> 등). base_ref = merge base(비면 origin/main). merge_trigger = auto(reconcile 재-merge)|manual.
  //  merge_status = 브랜치별 결과(merged|conflict|missing|invalid) — 충돌 표면화.
  await pool.query(`
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS member_branches JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS base_ref TEXT;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS merge_trigger TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS merge_status JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS port INT;          -- throwaway: 할당된 백엔드 포트
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS pid INT;           -- throwaway: 백엔드 프로세스 PID
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS stack_profile TEXT; -- 어떻게 띄우나(org_stack_profile.id) — throwaway 필수
  `);
  // #1036 3단계 — org_stack_profile: '어떻게 띄우나'(start_cmd·포트env·env·헬스체크)를 데이터로. throwaway backing 프로세스가 참조.
  //  비개발자는 프리셋을 드롭다운으로 고르기만(제로 입력 회피). Heroku Procfile / devcontainer.json / .gitpod.yml 모델.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_stack_profile(
      id TEXT PRIMARY KEY,
      label TEXT,
      repo TEXT,
      static_only BOOLEAN NOT NULL DEFAULT false,
      start_cmd TEXT,
      port_env TEXT NOT NULL DEFAULT 'PORT',
      env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      healthcheck_path TEXT,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);
  // build_cmd — 미리보기를 띄우기 전에 워크트리에서 실행할 빌드(예: 프론트 번들). 사람이 터미널을 안 열어도 되게 하는 핵심.
  await pool.query(`ALTER TABLE org_stack_profile ADD COLUMN IF NOT EXISTS build_cmd TEXT;`);
  await pool.query(`
    INSERT INTO org_stack_profile(id,label,repo,static_only,start_cmd,build_cmd,port_env,env_json,healthcheck_path,note) VALUES
      ('co-frontend','context-ontology 프론트 (정적·shared-proxy)','context-ontology',true,NULL,'npm run build:web','PORT','{}'::jsonb,'/',
       '프론트(public/)만 서빙 — /api 는 게이트웨이 자신. 별도 프로세스·포트 없음(가장 싸고 안전).'),
      ('co-fullstack','context-ontology 풀스택 (throwaway 게이트웨이)','context-ontology',false,'node dist/index.js','npm run build','PORT','{"LIVELY_NO_SCHEDULER":"1"}'::jsonb,'/healthz',
       '자체 게이트웨이 프로세스를 워크트리에서 기동 — 백엔드 변경까지 격리 확인. DB 등 backing 은 env 로 지정(라이브 DB 쓰기 금지).')
    ON CONFLICT DO NOTHING;
  `);
  // 기존 프리셋 보정 — 위 INSERT 는 ON CONFLICT DO NOTHING 이라 이미 있던 행엔 build_cmd 가 안 들어간다.
  //  운영자가 직접 채운 값은 건드리지 않는다(IS NULL 조건).
  await pool.query(`
    UPDATE org_stack_profile SET build_cmd='npm run build:web' WHERE id='co-frontend' AND build_cmd IS NULL;
    UPDATE org_stack_profile SET build_cmd='npm run build'     WHERE id='co-fullstack' AND build_cmd IS NULL;
  `);

  // ── org_node — 분산 노드 레지스트리(#869). 멤버 PC(member)/워커(worker)에 도는 노드 에이전트의 desired state. ──
  //  연결은 항상 노드→게이트웨이 아웃바운드 WSS(/node/ws) — 노드는 포트를 열지 않는다(단일 정문 유지).
  //  token_hash = 이 노드 전용 auth_token(scopes=[] — REST/MCP 표면 접근 불가, 노드 채널 전용)의 해시.
  //   재발급 시 교체(구 토큰 revoke). 인증 = org_node⋈auth_token(revoked_at IS NULL)⋈org_member(active) — 멤버
  //   비활성/토큰 회수/노드 비활성 어느 하나로도 즉시 차단. platform/agent_ver/host/last_seen 은 hello 시 갱신(관측 필드).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_node(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member','worker')),
      owner_member TEXT NOT NULL,
      token_hash TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      -- 공유 노드(#1540) — '전체 구성원이 쓸 수 있나'의 **유일한 근거**. 관리자만 켠다.
      --  기본은 비공유 = 등록한 사람 것. 판정은 src/node/node-access.ts 단일 술어(kind 는 자격·용량 축이지
      --  개방 축이 아니다 — 종전엔 kind='worker' 가 개방을 겸해서 위탁이 그 경계를 우회했다).
      shared BOOLEAN NOT NULL DEFAULT false,
      platform TEXT,
      agent_ver TEXT,
      -- 노드가 hello 로 선언한 op 목록(#905 C4). 오프라인 노드의 능력도 관리탭에서 보이게 저장한다.
      --  NULL = 아직 선언한 적 없음(구 에이전트) → 코드가 v1 기준선으로 해석(protocol.nodeCaps).
      agent_caps TEXT[],
      agent_harnesses TEXT[],
      host TEXT,
      last_seen TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  
    -- 기존 테이블에도 붙인다(#905 C4) — CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블을 안 고친다.
    ALTER TABLE org_node ADD COLUMN IF NOT EXISTS agent_caps TEXT[];
    -- #1713 — 이 노드에서 실제로 띄울 수 있는 하네스(번들 카탈로그 ∩ PATH). 미보고(구 번들)면 NULL → 기준선으로 본다.
    ALTER TABLE org_node ADD COLUMN IF NOT EXISTS agent_harnesses TEXT[];

    -- shared 이관(#1540) — **컬럼을 방금 만든 경우에만** 백필한다.
    --  ⚠ 조건 없이 UPDATE 로 두면, 관리자가 공유를 끈 worker 노드가 게이트웨이 재시작마다 다시 공유로
    --   되살아난다(정책이 코드에 의해 조용히 되돌려지는 최악의 형태). 그래서 컬럼 부재를 조건으로 1회만 돈다.
    --  구 모델에서 kind='worker' 는 **admin 만** 등록할 수 있는 조직 공용 실행기였고(node/routes.ts) 접근 게이트가
    --   그 종류를 전원 개방으로 취급했다 → '관리자가 공유로 등록한 노드'와 동의. 그 행만 옮겨 무회귀를 만든다.
    --   멤버 노드는 전부 비공유로 시작한다(= 이 프로젝트가 닫으려는 구멍).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_node' AND column_name='shared') THEN
        ALTER TABLE org_node ADD COLUMN shared BOOLEAN NOT NULL DEFAULT false;
        UPDATE org_node SET shared=true WHERE kind='worker';
      END IF;
    END $$;
  `);

  // ── org_task — 위탁 태스크(P2 #869). 의뢰자가 delegate_run 으로 넣고, 태스크 스케줄러가 리소스-적합 노드에 ──
  //  배치(§10: 예상 소모량 vs 노드 상시 리소스 push). 노드 사망 시 grace 후 재큐(attempt<max) 또는 실패+알림.
  //  결과 전문은 워크스페이스 .lively-task/<id>/ 에, 여기엔 요약(result jsonb)만.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_task(
      id BIGSERIAL PRIMARY KEY,
      requester TEXT NOT NULL,
      requester_session TEXT,
      prompt TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'claude',
      subpath TEXT NOT NULL DEFAULT '',
      repo TEXT,
      git_ref TEXT,
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      need_cpu REAL,
      need_ram_mb INT,
      need_disk_mb INT,
      needs_docker BOOLEAN NOT NULL DEFAULT false,
      node_pref TEXT,
      env_lease BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
      node_id TEXT,
      session_id TEXT,
      task_dir TEXT,
      attempt INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 2,
      timeout_sec INT NOT NULL DEFAULT 3600,
      node_lost_at TIMESTAMPTZ,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // 레포 자동 provision(#869 P2 후속) — 기존 org_task 테이블에도 소급(CREATE IF NOT EXISTS 는 컬럼 추가 안 함).
  await pool.query(`ALTER TABLE org_task ADD COLUMN IF NOT EXISTS repo TEXT`);
  await pool.query(`ALTER TABLE org_task ADD COLUMN IF NOT EXISTS git_ref TEXT`);
}

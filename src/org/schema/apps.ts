// org 스키마 조각 — apps: 라이블리 앱 레지스트리(#1780). "OS/앱 계층 분리"의 저장층.
//  org_app(package) · org_app_component(전개 저널) · org_app_grant(동의) · org_app_ui_asset(UI) ·
//  org_app_runtime_asset(worker 번들) · org_app_instance(실행 단위) · org_app_worker_run(실행 이력) ·
//  org_app_instance_project(프로젝트 귀속 이력).
//  설계: project/1780/design-v1.md (R1·R2 적대검증 반영). 신규 조각 규약 — org/schema.ts 오케스트레이터 **맨 끝**에서 호출.
//
// 멀티테넌트: 이 표들은 전부 public 스키마 → ensureTenantColumn/ensureTenantPolicies 가 tenant_id + 복합 UNIQUE +
//  RLS 를 **자동** 부착한다(initAllSchemas 끝에서). ⚠ 그 자동은 public 전용이다(activate.ts:97 nspname='public') —
//  앱의 **데이터 테이블**(app 스키마)은 이 자동을 못 받으므로 별도 처리한다(design D6, 이 파일 밖).
//
// 저널드 2-phase(design R2-1): 설치는 단일 DB 트랜잭션이 될 수 없다(합성 대상 스토어가 autocommit). 그래서
//  org_app.status 로 진행을 저널링하고(installing→active/failed), component 행을 먼저 기록한 뒤 전개하며,
//  실패 시 component 역순 보상 삭제 + 부팅 스위퍼가 installing/failed 잔재를 회수한다.
import type { Pool } from "pg";

// org_app.status — 설치 저널.
export const APP_STATUS = ["installing", "active", "failed", "disabled"] as const;

// org_app_component.kind — 앱이 전개한 구성요소의 종류(각 ref 는 대상 행의 PK 를 문자열로).
export const APP_COMPONENT_KINDS = [
  "harness_asset", // org_harness_asset.id
  "hook",          // org_hook.id
  "tool",          // org_tool.name
  "mcp_server",    // org_mcp_server.name
  "cron",          // org_cron.id
  "host",          // url_allowlist 의 호스트 문자열(참조카운트 회수 대상 — design R1-F5)
  "ui_page",       // 매니페스트 ui.pages[].key
  "ui_widget",     // 매니페스트 ui.widgets[].key
  "data_table",    // app 스키마 테이블명(design D6 — DDL 은 부팅 자식)
  "section",       // 앱 페르소나 섹션 key
  "runtime_worker",// org_app_runtime_asset 의 entry
] as const;

export async function initAppRegistry(pool: Pool): Promise<void> {
  // ── org_app — 설치된 앱 1건 + 저널 상태 ──
  //  id = 매니페스트 id(워크스페이스 유일 — tenant_id 와 복합키는 ensureTenantColumn 이 만든다).
  //  content_hash = 앱 패키지 지문(src/apps/package-hash.ts — 전체 sha256). manifest = 정규화된 매니페스트 JSON.
  //  source = {kind: 'upload'|'git'|'builtin', url?, ref?}.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.0',
      manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
      source JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'installing'
        CHECK (status IN ('installing','active','failed','disabled')),
      enabled BOOLEAN NOT NULL DEFAULT true,
      installed_by TEXT,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_status_idx ON org_app(status);`);
  //  #4225 — 누가 이 앱을 고칠 수 있나(app_save). 기본은 구성원 전원이고, 워크스페이스(관리자)가 앱마다 지정한 사람으로 좁힌다.
  //   앱은 라이블리 팀이 아니라 **그 워크스페이스가** 마음에 안 드는 곳을 바로 고쳐 쓰는 것이다(상민 2026-09-30).
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS edit_mode TEXT NOT NULL DEFAULT 'all';`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS edit_members JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE org_app DROP CONSTRAINT IF EXISTS org_app_edit_mode_check;`);
  await pool.query(`ALTER TABLE org_app ADD CONSTRAINT org_app_edit_mode_check CHECK (edit_mode IN ('all','members'));`);
  //  #4632 — 공개 범위(apps/visibility.ts). 'all' = 구성원 모두(설치 · 기본 앱의 기본) · 'me' = 나만 보는 앱(app_save 로 새로 생긴 앱의 기본 —
  //   원준 2026-10-14 «디폴트가 내가 만든 앱은 나만»). 있던 행은 'all' 그대로. 'me' 앱을 보는 사람은 책임자(owner_member, #4667 아래)와 관리자.
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'all';`);
  await pool.query(`ALTER TABLE org_app DROP CONSTRAINT IF EXISTS org_app_visibility_check;`);
  await pool.query(`ALTER TABLE org_app ADD CONSTRAINT org_app_visibility_check CHECK (visibility IN ('all','me'));`);

  // ── org_app_component — 앱이 전개한 구성요소 행 조인(무엇을 심었나 = 무엇을 회수하나) ──
  //  PK(app_id, kind, ref). ref 는 대상 행의 자연키(문자열). orig_name = 자산 번들 내 원명(물질화 시 복원, design R1-F4).
  //  ON DELETE CASCADE 로 org_app 제거 시 조인은 함께 사라진다(대상 행 자체 회수는 remove 로직이 이 조인을 읽어 수행).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_component(
      app_id TEXT NOT NULL REFERENCES org_app(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
        CHECK (kind IN ('harness_asset','hook','tool','mcp_server','cron','host','ui_page','ui_widget','data_table','section','runtime_worker')),
      ref TEXT NOT NULL,
      orig_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, kind, ref)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_component_app_idx ON org_app_component(app_id);`);
  // 기존 DB의 자동 생성 CHECK도 새 kind를 받아야 한다(CREATE TABLE IF NOT EXISTS만으로는 갱신되지 않음).
  await pool.query(`ALTER TABLE org_app_component DROP CONSTRAINT IF EXISTS org_app_component_kind_check;`);
  await pool.query(`ALTER TABLE org_app_component ADD CONSTRAINT org_app_component_kind_check
    CHECK (kind IN ('harness_asset','hook','tool','mcp_server','cron','host','ui_page','ui_widget','data_table','section','runtime_worker'));`);
  // host 참조카운트 회수(design R1-F5) — kind='host' 행을 ref(호스트)로 역조회.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_component_host_idx ON org_app_component(kind, ref) WHERE kind = 'host';`);

  // ── org_app_grant — 멤버별 동의(설치 동의는 앱을 켜는 것과 별개: 멤버가 자기 자격으로 이 앱을 쓰겠다는 승인) ──
  //  scopes/tools = 매니페스트 선언의 **부분집합**(설치 시 상한, grant 시 사람이 좁힐 수 있음). revoked_at 로 회수.
  //  ⚠ appToolAllowed 캐시 키는 (tenant, app_id, member) — auth_token 은 identity-global 이나 이 테이블은 RLS(design R2-8).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_grant(
      app_id TEXT NOT NULL REFERENCES org_app(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      tools JSONB NOT NULL DEFAULT '[]'::jsonb,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by TEXT,
      revoked_at TIMESTAMPTZ,
      PRIMARY KEY (app_id, member_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_grant_member_idx ON org_app_grant(member_id) WHERE revoked_at IS NULL;`);

  // ── org_app_ui_asset — 앱 UI 페이지/위젯 entry HTML 보존(#1780 PR5) ──
  //  왜 보존? ui_page/ui_widget component 는 저널만이고, UI 파일은 패키지 안에만 있다 — git/upload 설치는 스테이지가
  //  삭제되므로 UI 가 유실된다. 설치 시 entry HTML 을 여기 담아, 소스(builtin/git/upload) 무관하게 서빙한다.
  //  전달 = **인증 API → 샌드박스 srcdoc iframe**(정적 URL 아님) — 앱 UI 는 오리진 격리(불투명), 네트워크 없음,
  //  tools/call 은 postMessage 로 호스트가 중개(앱 grant 로 제약, PR5b). PK(app_id, page_key).
  //  ⚠ FK 를 org_app(id) 로 걸지 **않는다**: 이 테이블은 org_app 보다 늦게 도입돼, 기존 DB 에선 ensureTenantColumn 이
  //   org_app PK 를 (tenant_id,id)로 이미 재작성한 뒤라 id 단독 unique 가 없어 FK 생성이 42830 으로 실패한다
  //   (component/grant 는 fresh DB 때 만들어져 살아남은 것 — 신규 테이블엔 그 전제가 없다). 앱 제거 시 UI 자산 정리는
  //   org_app_remove 가 pruneUiAssets 로 명시 수행한다(CASCADE 대체).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_ui_asset(
      app_id TEXT NOT NULL,
      page_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('page','widget')),
      title TEXT,
      html TEXT NOT NULL,
      content_hash TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, page_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ui_asset_app_idx ON org_app_ui_asset(app_id);`);

  // ── org_app_version — 앱 코드의 판 이력(#4600, 「장표 수정 앱」 #4592) ──
  //  원준(2026-10-07): «개개인도 AI 에게 시켜 앱을 고칠 수 있어야 한다». 그런데 화면 코드는 org_app_ui_asset 에 한 벌뿐이라
  //  고치면 전 것이 사라졌고, 빌트인은 아예 못 고쳤다. 판마다 **파일 묶음 전체**(files JSONB — 매니페스트·화면·bin/ 까지)를 적어 둔다:
  //  설치가 보존하는 것은 매니페스트와 화면뿐이라, 되돌리기가 그 둘만으로는 세션 스크립트 같은 나머지를 잃기 때문이다.
  //  origin 'builtin' = 릴리스 원본 그대로였던 상태(「원본으로」 의 목적지 · 지우지 않는다) · 'member' = 구성원이 저장한 판(최근 20개 보관).
  //  FK 는 org_app_ui_asset 과 같은 이유로 걸지 않는다. 제거 verb 가 명시로 지운다(빌트인은 제거가 막혀 있어 사실상 남는다).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_version(
      app_id TEXT NOT NULL,
      version_no INT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('builtin','member')),
      version TEXT NOT NULL DEFAULT '0.0.0',
      manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
      files JSONB NOT NULL DEFAULT '[]'::jsonb,
      content_hash TEXT,
      note TEXT,
      saved_by TEXT,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, version_no)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_version_app_idx ON org_app_version(app_id);`);
  //  #4481(앱 v2-2) — 판의 파일 내용은 S3(자가호스팅은 org_app_blob.bytes)로 옮긴다. 여기 남는 것은 «파일 목록»(apps/app-bundle.ts):
  //   bundle = {v:1, files:[{p 경로, h sha256, s 크기}]} · bundle_store = 그 파일들이 있는 저장소('s3' | 'db' — 설정이 바뀌어도 옛 판은 제자리에서 읽는다)
  //   · bundle_bytes = 판 하나의 합 · bundle_at = 목록을 적은 때(옛 코어 호환 사본 files 를 30일 뒤 지우는 기준 — 상민 2026-10-15).
  //   bundle 이 NULL 인 줄은 아직 안 옮긴 옛 판이다 — files 가 정본(하우스키핑이 옮긴다 · app-bundle-migrate.ts).
  await pool.query(`ALTER TABLE org_app_version ADD COLUMN IF NOT EXISTS bundle JSONB;`);
  await pool.query(`ALTER TABLE org_app_version ADD COLUMN IF NOT EXISTS bundle_store TEXT;`);
  await pool.query(`ALTER TABLE org_app_version ADD COLUMN IF NOT EXISTS bundle_bytes BIGINT;`);
  await pool.query(`ALTER TABLE org_app_version ADD COLUMN IF NOT EXISTS bundle_at TIMESTAMPTZ;`);

  // ── org_app_blob — 앱 판 파일의 장부(#4481) ──
  //  파일 하나(지문 하나)당 한 줄: 어느 저장소에 · 크기 · 실제로 올라갔나(stored) · 마지막으로 판이 가리키려 한 때(last_used_at).
  //   자가호스팅(S3 없음)은 bytes 칸에 내용을 둔다. 판 쓰기는 파일을 가리키기 전에 이 줄을 «방금 씀» 으로 찍고, 정리는 이 줄을 잠근 채
  //   «24시간 안 쓰였고 어떤 판도 안 가리킴» 을 다시 본 뒤에만 지운다(엇갈림 규칙은 apps/app-blob-store.ts 머리말).
  //   PK 는 ensureTenantColumn 이 (tenant_id, sha256, store) 로 다시 쓴다 — ON CONFLICT 타깃도 그 셋.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_blob(
      sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      store TEXT NOT NULL CHECK (store IN ('s3','db')),
      size BIGINT NOT NULL CHECK (size >= 0),
      stored BOOLEAN NOT NULL DEFAULT FALSE,
      bytes BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (sha256, store)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_blob_last_used_idx ON org_app_blob(last_used_at);`);

  // ── org_app_server_build · org_app_server — 앱 서버(#4484 앱 v2-5) ──
  //  앱이 매니페스트 web.server 로 서버를 알리면, 「이대로 넣기」·「공개하기」·app_server_deploy 가 그 판을 **그 판을 저장한 사람의 세션 컨테이너**
  //   에서 빌드해 zip 을 판 묶음 버킷(t/<워크스페이스>/z/<앱>/<빌드 지문>.zip — 앱마다 따로)에 두고, 앱 × 워크스페이스마다 Lambda 함수 하나에 올린다(apps/app-server-*.ts).
  //  org_app_server_build — 빌드 지문(매니페스트를 뺀 파일 목록 + 서버 선언 + 빌더 판)마다 한 줄. 같은 지문은 다시 빌드하지 않는다.
  //   status building(lease_until 이 지나면 죽은 빌드) · ok(zip_*) · failed(stage · error · log_tail). FK 는 org_app_version 과 같은 까닭으로 걸지 않는다.
  //   PK 는 ensureTenantColumn 이 (tenant_id, app_id, build_key) 로 다시 쓴다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_server_build(
      app_id TEXT NOT NULL,
      build_key TEXT NOT NULL CHECK (build_key ~ '^[0-9a-f]{64}$'),
      version_no INT,
      status TEXT NOT NULL CHECK (status IN ('building','ok','failed')),
      zip_key TEXT,
      zip_bytes BIGINT,
      zip_sha256 TEXT,
      unzipped_bytes BIGINT,
      entries INT,
      stage TEXT,
      error TEXT,
      log_tail TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      built_by TEXT,
      session_id TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      lease_until TIMESTAMPTZ,
      PRIMARY KEY (app_id, build_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_server_build_app_idx ON org_app_server_build(app_id, started_at DESC);`);
  //  org_app_server — 앱마다 한 줄: 함수 이름 · 별칭 둘(cur = 고친 사람이 보는 판 · pub = 공개 판)이 어느 판·빌드·함수 판을 가리키나 · 멈춤 ·
  //   배포 잠금(lock_until — 한 앱의 배포를 한 줄로). v2-6 라우팅이 «이 주소의 판 = 별칭이 가리키는 판인가» 를 이 줄로 본다.
  //   stop_kind — 'auto'(감시가 멈춤 · 관리자만 다시 켠다) · 'manual'(사람이 멈춤). 사람이 쓰는 stop_reason 글이 아니라 이 칸으로 가른다(격리 리뷰).
  //   FK 를 걸지 않는다 — 앱을 지울 때 함수를 못 지우면 이 줄을 남겨 하우스키핑이 다시 지운다(app-server-watch).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_server(
      app_id TEXT NOT NULL PRIMARY KEY,
      function_name TEXT NOT NULL,
      cur_version_no INT,
      cur_build_key TEXT,
      cur_lambda_version TEXT,
      cur_at TIMESTAMPTZ,
      pub_version_no INT,
      pub_build_key TEXT,
      pub_lambda_version TEXT,
      pub_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      stopped_by TEXT,
      stop_reason TEXT,
      lock_until TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  //  stop_kind 는 표를 만든 뒤에 더한 칸이라 ALTER 로(이미 만들어진 표에도 붙게 — 관례).
  await pool.query(`ALTER TABLE org_app_server ADD COLUMN IF NOT EXISTS stop_kind TEXT CHECK (stop_kind IN ('auto','manual'));`);
  //  org_app.builtin_version — 패키지 폴더(apps/builtin)에 지금 실린 릴리스 판 번호. 시더가 적는다. 워크스페이스가 빌트인을
  //   덮어쓴 뒤(source.overrides_builtin) 릴리스가 올라가도 덮지 않으므로, 화면이 「원본에 새 판이 있다」 를 이 값으로 안다.
  //  org_app.current_version_no — 지금 서빙 중인 상태가 org_app_version 의 어느 판인가(없으면 NULL — 판 이력 도입 전 설치).
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS builtin_version TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS current_version_no INT;`);

  //  #4667(앱 v2-15) — 공개 판 · 초안 · 만든 사람 · 만들기 세션 · 책임자(공개 범위 visibility 칸은 위 #4632). 판정은 apps/visibility.ts 머리말.
  //   published_version_no = 모두가 보는 판(org_app_version) · draft_by = 설치된 상태가 공개 판과 다를 때 그 초안을 만든 사람(그 사람만 초안을 본다).
  //   made_by = 처음 만든 사람(서버가 만들 때 한 번 찍는다 · 매니페스트 studio.made_by 는 앱 코드라 믿지 않는다) · owner_member = 지금 책임자
  //    (NULL = 관리자 — 만든 사람이 떠나면 여기로 넘어온다 · 'me' 앱을 보는 사람) · build_session = 이 앱을 만드는 세션(세션 → 앱 역조회 ·
  //    다른 기기에서 이어 만들기) · origin_app_id = 사본이면 원본 앱.
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS published_version_no INT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS published_by TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS draft_by TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS made_by TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS owner_member TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS build_session TEXT;`);
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS origin_app_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_build_session_idx ON org_app(build_session) WHERE build_session IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_owner_idx ON org_app(owner_member) WHERE owner_member IS NOT NULL;`);
  //  옛 앱 채우기(멱등) — 워크스페이스가 만든 앱의 «만든 사람» 은 처음 설치한 사람이다(installed_by 는 upsertApp 이 처음 한 번만 쓴다).
  //   made_by 가 빈 줄만 채우므로 한 번 채운 뒤엔 다시 돌지 않는다 — 떠난 사람의 책임자를 관리자로 넘긴 줄(owner NULL · made_by 있음)을 되돌리지 않는다.
  //   책임자는 그 사람이 지금 활성 구성원일 때만 — 이미 떠난 사람이면 비워 둔다(= 관리자 · 떠날 때의 이관 훅은 앞으로의 전이에서만 돈다 · 격리 리뷰 NB-11).
  //   관리자가 고치기를 «지정한 사람만» 으로 좁히며 만든 사람을 뺀 앱도 비워 둔다 — 책임자는 고치기 설정과 무관하게 고치므로(member-app editDenial)
  //   채우기 하나로 관리자가 막아 둔 고치기가 풀리면 안 된다(격리 리뷰 2-8b).
  //   빌트인(릴리스가 만든 앱)·시더/익명 행위자는 비워 둔다(책임자 = 관리자). 두 표에 tenant_id 가 있으면(첫 부팅 뒤) 같은 워크스페이스의 구성원만 본다.
  const tenantCols = await pool.query(`SELECT table_name FROM information_schema.columns
                                        WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND table_name IN ('org_app','org_member')`);
  const sameTenant = tenantCols.rows.length === 2 ? "AND m.tenant_id = a.tenant_id" : "";
  await pool.query(`UPDATE org_app a SET made_by = a.installed_by,
                            owner_member = CASE WHEN EXISTS (SELECT 1 FROM org_member m WHERE m.id = a.installed_by AND m.state = 'active' ${sameTenant})
                                                     AND (a.edit_mode <> 'members' OR a.edit_members ? a.installed_by)
                                                THEN a.installed_by ELSE NULL END
                     WHERE a.made_by IS NULL AND a.installed_by IS NOT NULL AND a.installed_by NOT IN ('system','unknown','')
                       AND COALESCE(a.source->>'kind','') <> 'builtin';`);

  // ── org_app_runtime_asset — 설치 stage가 사라진 뒤에도 정확한 package hash의 worker를 실행한다 ──
  //  코드는 단일 ESM 번들(8MiB 이하). FK 대신 remove/reclaim에서 명시 회수(v2.1 신규표 규약).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_runtime_asset(
      app_id TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      entry TEXT NOT NULL,
      code BYTEA NOT NULL CHECK (octet_length(code) <= 8388608),
      code_hash TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
      size_bytes INT NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, package_hash)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_runtime_asset_app_idx ON org_app_runtime_asset(app_id);`);

  // ── org_app_instance — 설치된 package 와 실제 실행 단위를 분리(#1780 v2.1) ──
  //  project_id NULL = 프로젝트 비소속. 프로젝트 귀속은 package 가 아니라 instance 별 현재 맥락이며 권한이 아니다.
  //  subject_kind/ref 는 외부 정체성을 가진 인스턴스(첫 기준: session)를 멱등 확보하는 키다.
  //  신규 앱 표는 기존 org_app 에 FK 를 걸지 않는다(v2.1 K 규칙) — 제거 시 store.pruneAppInstances 가 명시 회수한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_instance(
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      owner_member TEXT NOT NULL,
      project_id INT,
      subject_kind TEXT,
      subject_ref TEXT,
      page_key TEXT,
      title TEXT,
      state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(state::text) <= 131072),
      execution_host_kind TEXT CHECK (execution_host_kind IN ('central','remote')),
      execution_host_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ,
      CHECK ((subject_kind IS NULL) = (subject_ref IS NULL)),
      CONSTRAINT org_app_instance_execution_host_pair_check CHECK ((execution_host_kind IS NULL AND execution_host_id IS NULL)
          OR (execution_host_kind='central' AND execution_host_id IS NULL)
          OR (execution_host_kind='remote' AND execution_host_id IS NOT NULL))
    );
  `);
  await pool.query(`ALTER TABLE org_app_instance ADD COLUMN IF NOT EXISTS execution_host_kind TEXT;`);
  await pool.query(`ALTER TABLE org_app_instance ADD COLUMN IF NOT EXISTS execution_host_id TEXT;`);
  //  #3855·#3857 — **왜 닫혔나**. 세션 인스턴스의 closed 에 두 뜻이 섞여 있었다: 사람이 목록에서 치운 것(user)과
  //   시스템 뒷정리(되살리기로 옛 id 를 닫음·완전 삭제·유령 청소·강제 종료·열기 실패). 사이드바의 «보임 축» 정본이
  //   이 행이 되면서 둘을 가르지 않으면 «치운 세션» 에 사람이 안 치운 것이 뜬다. NULL = 사유 미상(이 칸 이전에 닫힌 행).
  await pool.query(`ALTER TABLE org_app_instance ADD COLUMN IF NOT EXISTS closed_reason TEXT;`);
  await pool.query(`ALTER TABLE org_app_instance DROP CONSTRAINT IF EXISTS org_app_instance_closed_reason_check;`);
  await pool.query(`ALTER TABLE org_app_instance ADD CONSTRAINT org_app_instance_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ('user','restore','kill','purge','janitor','system'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_instance_dismissed_idx ON org_app_instance(owner_member, closed_at DESC)
    WHERE subject_kind='session' AND status='closed' AND closed_reason='user';`);
  await pool.query(`ALTER TABLE org_app_instance DROP CONSTRAINT IF EXISTS org_app_instance_execution_host_kind_check;`);
  await pool.query(`ALTER TABLE org_app_instance ADD CONSTRAINT org_app_instance_execution_host_kind_check
    CHECK (execution_host_kind IS NULL OR execution_host_kind IN ('central','remote'));`);
  await pool.query(`ALTER TABLE org_app_instance DROP CONSTRAINT IF EXISTS org_app_instance_execution_host_pair_check;`);
  await pool.query(`ALTER TABLE org_app_instance ADD CONSTRAINT org_app_instance_execution_host_pair_check
    CHECK ((execution_host_kind IS NULL AND execution_host_id IS NULL)
        OR (execution_host_kind='central' AND execution_host_id IS NULL)
        OR (execution_host_kind='remote' AND execution_host_id IS NOT NULL));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_instance_app_owner_idx ON org_app_instance(app_id, owner_member, updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_instance_project_idx ON org_app_instance(project_id) WHERE project_id IS NOT NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_app_instance_subject_uq
    ON org_app_instance(app_id, owner_member, subject_kind, subject_ref)
    WHERE subject_kind IS NOT NULL AND subject_ref IS NOT NULL;`);

  // 귀속 시간구간 — 인스턴스를 옮겨도 과거 활동의 프로젝트 맥락을 소급 변경하지 않는다.
  // project_id NULL 행은 명시적인 비소속 전환이다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_instance_project(
      id BIGSERIAL PRIMARY KEY,
      instance_id TEXT NOT NULL,
      project_id INT,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_instance_project_instance_idx ON org_app_instance_project(instance_id, valid_from DESC);`);

  // ── org_app_worker_run — AppInstance와 별도인 worker 생애주기/실행 위치/예산 결과 ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_worker_run(
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      owner_member TEXT NOT NULL,
      project_id INT,
      host_kind TEXT NOT NULL CHECK (host_kind IN ('central','remote')),
      host_id TEXT,
      package_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared','starting','ready','idle','running','stopping','stopped','failed')),
      pid INT,
      exit_code INT,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      last_active_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((host_kind='central' AND host_id IS NULL) OR (host_kind='remote' AND host_id IS NOT NULL))
    );
  `);
  // memory_mb(#1780 Stage B): 그 run 이 **선언한** 메모리(MiB). 조직 예산의 합산 근거라 run 행에 보존한다 —
  //  매니페스트를 나중에 다시 읽으면 패키지가 업데이트된 뒤엔 당시 값을 알 수 없다.
  await pool.query(`ALTER TABLE org_app_worker_run ADD COLUMN IF NOT EXISTS memory_mb INT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_worker_run_instance_idx ON org_app_worker_run(instance_id, created_at DESC);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS org_app_worker_run_active_uq ON org_app_worker_run(instance_id)
    WHERE status IN ('prepared','starting','ready','idle','running','stopping');`);

  // ── org_app_notification — 앱이 보낸 알림의 이력(#1891) ──
  //  종전 「확인할 것」은 라이브 세션에서 파생돼 남는 게 없었다. 화면을 안 보고 있으면 지나갔고,
  //  나중에 "무슨 알림이 왔었지"를 물을 데가 없었다. 그래서 저장한다(읽음도 멤버별로).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_notification(
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      href TEXT,
      dedupe_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );
  `);
  //  받은 사람의 최신순 조회가 기본 질의다.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_notification_member_idx ON org_app_notification(member_id, created_at DESC);`);
  //  중복 억제는 (앱·멤버·key) 의 최근 1건만 본다 — 그 조회를 받치는 인덱스.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_notification_dedupe_idx ON org_app_notification(app_id, member_id, dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL;`);
  //  #4180 — 알림의 **종류**(kind)와 **한 사람**(actor). 「확인할 것」은 종류로 가른다(notify-policy.inInbox):
  //   세션 대기·완료(session)는 배너만 울리고 목록엔 서지 않는다(회의 2026-09-21: «하루에 세션을 수십 개 쓰면 모든 답이
  //   쌓여 무의미»). comment·mention(사람이 나를 지목한 것)·liv(리브의 답)·app(앱이 보낸 것)이 목록에 선다.
  //   actor 는 «누가 한 일인가»(구성원 id) — 화면이 얼굴·이름을 붙이는 재료. 앱 알림은 비어 있다.
  await pool.query(`ALTER TABLE org_app_notification ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'app';`);
  await pool.query(`ALTER TABLE org_app_notification ADD COLUMN IF NOT EXISTS actor TEXT;`);
  //  옛 행 되분류 — 이 열이 생기기 전에 ai-session 스윕이 남긴 «답을 기다려요» 는 전부 세션 알림이다. 그대로 두면
  //   열이 생긴 첫날 「확인할 것」에 옛 세션 알림 수십 건이 그대로 서 있다(이 프로젝트가 지우려는 바로 그 화면). 멱등.
  await pool.query(`UPDATE org_app_notification SET kind='session' WHERE app_id='ai-session' AND kind='app';`);

  // ── org_session_app — 일반 세션에 **붙은** 앱(#4225) ──
  //  앱 세션(토큰에 app_id 를 구운 세션)과 다르다: 세션은 사람의 평범한 세션이고, 앱은 필요할 때 붙였다 뗀다
  //  (9/21 회의 «맥락에 기능이 속한다»). 붙어 있는 동안만 그 세션의 AI 가 그 앱 테이블을 읽고 쓴다 — 판정은
  //  매 호출 이 행을 다시 읽는다(apps/session-apps.ts requireAttachedApp). 떼면 detached_at 이 서고 그 순간부터 막힌다.
  //  PK(session_id, app_id) — 다시 붙이면 같은 행을 되살린다(attached_at 갱신). member_id = 붙인 사람(= 세션 주인).
  //  v2.1 K 규칙대로 org_app 에 FK 를 걸지 않는다 — 앱 제거 때 pruneSessionApps 가 명시 회수한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_app(
      session_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      detached_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, app_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_session_app_live_idx ON org_session_app(session_id) WHERE detached_at IS NULL;`);

  //  #4785 — 앱 폴더 상한(GiB). NULL = 무제한(기본 — 상민님 2026-10-16). 관리자 · 앱 책임자가 앱마다 건다(app_folder_limit_set).
  //   실제로 거는 것은 CP 의 5분 쿼터 정비다(JuiceFS `/<워크스페이스>/apps/<앱>` — lvly-cloud appfolderquota.ts). 이 열은 «원하는 상한» 이고,
  //   지금 걸려 있는 값은 아래 사용량 행(limit_gb)이 말한다.
  await pool.query(`ALTER TABLE org_app ADD COLUMN IF NOT EXISTS folder_limit_gb INT;`);

  // ── org_app_folder_usage — 앱 폴더 사용량(#4785) ──
  //  CP 가 5분마다 JuiceFS 쿼터 목록에서 읽어 보낸다(app_folder_usage_report). limit_gb = 잰 때 걸려 있던 상한(NULL = 무제한).
  //  warned_level = 마지막으로 알린 단계(0 · 80 · 100) — 같은 단계는 거듭 알리지 않고, 내려가면 되돌려 다시 넘을 때 또 알린다.
  //  v2.1 K 규칙대로 org_app 에 FK 를 걸지 않는다 — 앱을 지울 때 remove-run 이 함께 지운다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_folder_usage(
      app_id TEXT PRIMARY KEY,
      used_bytes BIGINT NOT NULL,
      limit_gb INT,
      measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      warned_level INT NOT NULL DEFAULT 0 CHECK (warned_level IN (0, 80, 100)),
      warned_at TIMESTAMPTZ
    );
  `);

  // ── org_session_app_folder — 세션의 앱 폴더를 노드 브로커가 마지막으로 어떻게 맞췄나(#4786 주기 재조정) ──
  //  붙은 앱 기록(org_session_app)은 «무엇을 붙여야 하나» 이고 이 행은 «노드에 지금 무엇이 붙어 있다고 들었나» 다. 앱을 지우거나 뗀 뒤
  //  맞추기가 실패하면 붙은 기록은 사라지거나 떼어진 채인데 노드엔 폴더가 남는다 — 주기 맞추기는 이 행으로 그 세션을 찾는다.
  //  state: ok(다 맞췄다) · failed(일부 못 붙이거나 못 뗐다) · unsupported(접점 없는 옛 컨테이너) · not-running(컨테이너 없음) ·
  //   error(브로커·DB 실패 — bound 는 모른다) · old-broker. 세션마다 한 행 — 끝났거나 이어진 세션의 행은 주기 정비가 지운다(FK 없음).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_session_app_folder(
      session_id TEXT PRIMARY KEY,
      bound JSONB NOT NULL DEFAULT '[]'::jsonb,
      state TEXT NOT NULL CHECK (state IN ('ok','failed','unsupported','not-running','error','old-broker')),
      detail TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      fixed_count INT NOT NULL DEFAULT 0,
      last_fixed_at TIMESTAMPTZ
    );
  `);

  // ── org_app_snapshot — 앱 데이터 일일 내보내기(#4226) ──
  //  앱 자유 SQL 은 AI 한 줄로 행을 지울 수 있다. RDS 백업(7일)은 DB 전체 단위라 한 워크스페이스·한 앱만 되돌릴 수 없다 →
  //  (워크스페이스, 앱) 데이터를 하루 한 번 떠 둔다(7일 보관). 앱 제거·복원 직전에도 뜬다(reason). 테이블 하나의 행을
  //  1,000행씩 묶어 jsonb 로 담는다(TOAST 가 압축한다). 떠 두기·복원은 apps/app-snapshot.ts.
  //  v2.1 K 규칙대로 org_app 에 FK 를 걸지 않는다 — 앱을 지워도 7일 동안은 남아야 되돌릴 수 있다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_snapshot(
      app_id TEXT NOT NULL,
      taken_at TIMESTAMPTZ NOT NULL,
      table_name TEXT NOT NULL,
      chunk INT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'daily',
      row_count INT NOT NULL DEFAULT 0,
      rows JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (app_id, taken_at, table_name, chunk)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_snapshot_taken_idx ON org_app_snapshot(taken_at);`);

  // ── org_app_folder_archive — 보관으로 옮긴 앱 폴더(#4778) ──
  //  앱을 지우면 그 앱 폴더(<apps 자리>/<앱>/)를 apps 자리 안의 점 이름(name)으로 옮긴다 — 같은 id 로 새로 만든 앱은 빈 앱 폴더로 시작한다.
  //  보관 하나 = 행 하나(언제 · 누가 · 어느 입구 · 크기 · 파일 수). 정비는 이 표만 보고 기간이 지난 보관이 있을 때만 파일을 만진다.
  //  파일 쪽이 진짜다 — 목록이 파일을 훑어 행 없는 보관은 채우고 파일 없는 행은 «사라짐» 으로 보인다(apps/app-folder-archive.ts).
  //  v2.1 K 규칙대로 org_app 에 FK 를 걸지 않는다 — 앱이 지워진 뒤에 남는 기록이다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_folder_archive(
      name TEXT NOT NULL,
      app_id TEXT NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_by TEXT,
      entry TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'dir',
      files BIGINT,
      bytes BIGINT,
      truncated BOOLEAN NOT NULL DEFAULT false,
      last_try_at TIMESTAMPTZ,
      last_error TEXT,
      PRIMARY KEY (name)
    );
  `);
  //  last_try_at · last_error — 지우려다 못 지운 보관(권한 · 시간 예산). 정비는 안 해 본 것부터 고르고 못 지운 것은 뒤로 보낸다(앞줄 막힘 없게) ·
  //   되돌리기는 이 칸이 찬 보관(지우다 멈춘 것)을 거절한다. 표가 먼저 생긴 DB(두 칸 없이 만든 개발 · 시험 DB)에도 칸을 붙인다.
  await pool.query(`ALTER TABLE org_app_folder_archive ADD COLUMN IF NOT EXISTS last_try_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE org_app_folder_archive ADD COLUMN IF NOT EXISTS last_error TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_folder_archive_at_idx ON org_app_folder_archive(archived_at);`);

  // ── org_app_member_pref — 앱 × 보는 사람의 개인 설정(#4601) ──
  //  앱 화면은 불투명 오리진이라 localStorage 가 막히고(#4593 실측), SDK 에 보는 사람 신원이 없어 앱 표에 둘 수도 없다. 그래서
  //  (앱, 구성원) 키의 작은 JSON 한 칸을 서버가 든다(apps/app-prefs.ts 머리말 — 16KB 상한). PK(app_id, member_id) — 사람마다 한 행,
  //  tenant_id 는 ensureTenantColumn 이 복합키로 붙인다(ON CONFLICT 타깃에 tenant_id, upsertGrant·attachAppRow 와 같은 규약).
  //  v2.1 K 규칙대로 org_app 에 FK 를 걸지 않는다 — 앱 제거 때 pruneMemberPrefs 가 명시 회수한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_member_pref(
      app_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, member_id)
    );
  `);

  // ── app_launch_code — 앱 주소 로그인의 일회용 코드(#4480 v2-1) ──
  //  라이블리 화면(로그인한 구성원)이 받아 앱 주소(<앱>-<워크스페이스>.lvly.app)에 붙이고, 앱 주소 앞단(CP 라우터)이 앱 주소 전용
  //   쿠키로 바꾼다. 평문 코드는 저장하지 않고 sha256 만(code_hash) · TTL 60초 · used_at 으로 1회. host = 그 코드가 열 수 있는
  //   앱 주소 하나 · mode = embed(라이블리 안 iframe) | top(직접 접속) · state_hash = top 의 앞단 상태 쿠키 지문. 저장 계층은
  //   apps/app-launch-store.ts. **테넌트 범위의 일반 표**다(발급·교환 모두 그 워크스페이스 헤더를 달고 온다 — 매니지드 RLS 가 가른다).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_launch_code(
      code_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'pub' CHECK (variant IN ('pub','draft')),
      host TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('embed','top')),
      state_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS app_launch_code_exp_idx ON app_launch_code(expires_at);`);

  // ── 기존 테이블 앱 축(design D1) — 전부 ADD COLUMN IF NOT EXISTS(무회귀) ──
  //  auth_token.app_id — 앱 세션 토큰 귀속(NULL = 일반 토큰). 기능 롤백 런북이 `WHERE app_id IS NOT NULL` 로 일괄 revoke.
  await pool.query(`ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS app_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS auth_token_app_idx ON auth_token(app_id) WHERE app_id IS NOT NULL;`);
  //  org_session_state.app_id — 세션이 어느 앱으로 떴나(desired-state 미러).
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS app_id TEXT;`);
  //  mcp_call_log.app — 호출 귀속(관측 전용, 권한 판정 불사용 — design D3-5).
  await pool.query(`ALTER TABLE mcp_call_log ADD COLUMN IF NOT EXISTS app TEXT;`);
}

// org 스키마 조각 — apps: 라이블리 앱 레지스트리(#1780). "OS/앱 계층 분리"의 저장층.
//  org_app(설치된 앱 + 저널 상태) · org_app_component(앱→전개된 구성요소 행 조인) · org_app_grant(멤버별 동의).
//  설계: project/1780/design-v1.md (R1·R2 적대검증 반영). 신규 조각 규약 — org/schema.ts 오케스트레이터 **맨 끝**에서 호출.
//
// 멀티테넌트: 이 세 테이블은 전부 public 스키마 → ensureTenantColumn/ensureTenantPolicies 가 tenant_id + 복합 UNIQUE +
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

  // ── org_app_component — 앱이 전개한 구성요소 행 조인(무엇을 심었나 = 무엇을 회수하나) ──
  //  PK(app_id, kind, ref). ref 는 대상 행의 자연키(문자열). orig_name = 자산 번들 내 원명(물질화 시 복원, design R1-F4).
  //  ON DELETE CASCADE 로 org_app 제거 시 조인은 함께 사라진다(대상 행 자체 회수는 remove 로직이 이 조인을 읽어 수행).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_component(
      app_id TEXT NOT NULL REFERENCES org_app(id) ON DELETE CASCADE,
      kind TEXT NOT NULL
        CHECK (kind IN ('harness_asset','hook','tool','mcp_server','cron','host','ui_page','ui_widget','data_table','section')),
      ref TEXT NOT NULL,
      orig_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, kind, ref)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_component_app_idx ON org_app_component(app_id);`);
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

  // ── 기존 테이블 앱 축(design D1) — 전부 ADD COLUMN IF NOT EXISTS(무회귀) ──
  //  auth_token.app_id — 앱 세션 토큰 귀속(NULL = 일반 토큰). 기능 롤백 런북이 `WHERE app_id IS NOT NULL` 로 일괄 revoke.
  await pool.query(`ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS app_id TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS auth_token_app_idx ON auth_token(app_id) WHERE app_id IS NOT NULL;`);
  //  org_session_state.app_id — 세션이 어느 앱으로 떴나(desired-state 미러).
  await pool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS app_id TEXT;`);
  //  mcp_call_log.app — 호출 귀속(관측 전용, 권한 판정 불사용 — design D3-5).
  await pool.query(`ALTER TABLE mcp_call_log ADD COLUMN IF NOT EXISTS app TEXT;`);
}

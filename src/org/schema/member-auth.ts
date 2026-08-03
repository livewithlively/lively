// org 스키마 조각 — member-auth: 사람/멤버 자격 축. member_credential(로컬 로그인)·member_secret(자격 vault)·
//  member_channel_policy/meta(대화 열람·발송 통제)·web_session(웹 세션)·git_credential(git 자격)·
//  pending_device_auth(CLI 디바이스 로그인)·pending_session_mint(세션 SSO 브리지) + 멤버 이메일 유일성 인덱스.
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { softUniqueIndex } from "./ddl-util.js";

export async function initMemberAuth(pool: Pool): Promise<void> {
  // ── member_credential — 로컬 로그인 자격(P4). 비번은 scrypt 해시만 저장(평문·복원 불가). ──
  //  member_id = org_member.id. must_change=초기 비번(관리자 발급) → 첫 로그인 후 변경 권장.
  //  failed_attempts+locked_until 로 브루트포스 완화. OIDC 도입 시에도 이 테이블은 로컬 폴백(IdP 없는 고객)으로 유지.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_credential(
      member_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      must_change BOOLEAN NOT NULL DEFAULT false,
      failed_attempts INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

  // ── member_secret — per-user 백엔드 자격 vault(P1, #746). 능동 커넥터 툴(gitlab·slack·google·aws…)이 쓰는
  //  자격을 사용자별 격리 보관. git_credential(owner=gateway|member:<id>) 패턴을 임의 kind 로 일반화한 것.
  //  ⚠ member_credential(로컬 로그인 비번, scrypt 단방향)과 다르다 — 여기는 API 호출용이라 복원 가능해야 함(secret-box AES-GCM).
  //  owner: 'gateway'(라이블리 통합 자격, 관리자 설정 — 비-PII read 폴백) | 'member:<id>'(개인 자격 — write·raw-PII 필수).
  //  kind: gitlab_pat|slack_user_token|google_oauth_refresh|clickup_token|notion_token|aws_role_arn|prometheus_bearer|… (확장 TEXT).
  //  scope_key: 같은 kind 의 다중 대상 구분(예 gitlab host, aws account) — 없으면 ''(단일). PK=(owner,kind,scope_key).
  //  secret_enc: 봉투 암호화된 시크릿(secret-box). meta: 비밀 아닌 부속정보(oauth client_id·aws region 등, jsonb 평문).
  //  해소 체인 resolveMemberSecret: member 우선 → (허용 시) gateway 폴백 → null. write/외부발신은 폴백 금지(per-user 필수).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_secret(
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      secret_enc TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      last_used_at TIMESTAMPTZ,
      PRIMARY KEY (owner, kind, scope_key));
    CREATE INDEX IF NOT EXISTS member_secret_kind_idx ON member_secret(kind, scope_key);
  `);

  // ── member_channel_policy — 개인이 대화별로 정한 열람/발송 허용(#1226 · 기본값 재설계 #1262). ──
  //  슬랙 OAuth 에는 채널 단위 권한이 없다(워크스페이스 통째 all-or-nothing) → 채널별 통제는 우리 프록시가
  //  상류 호출을 가로채는 자리에서만 가능하다. 집행은 org/channels/channel-guard, 소비는 mcp/mcp-proxy.
  //  **override 테이블**(#1262 전환): 행은 '사람이 끈 것' 이 아니라 **'기본값과 다른 명시 설정'** 이다.
  //   기본값이 대화 종류에 따라 갈리기 때문이다 — 공개 채널은 열람·발송 허용, 비공개·그룹DM·DM 은 둘 다 거부.
  //   그래서 행이 없다 = 허용이 아니라 **행이 없다 = 그 종류의 기본값**이고, 기본값과 같아지면 행을 지운다.
  //   (#1226 은 '전부 허용 + 끈 것만 저장' 이었다. 연결하자마자 비공개 대화가 통째로 AI 에게 열리는 것이
  //    실제로 확인돼 뒤집었다 — 사람이 손대기 전의 안전한 쪽은 '닫힘' 이어야 한다.)
  //  ⚠ 기본값을 가르려면 **집행 시점에 대화 종류를 알아야** 하는데 채널 id 로는 알 수 없다 → member_channel_meta.
  //  system: 지금은 'slack' 만(팀즈·디스코드가 붙어도 같은 표에 살 수 있게 축만 열어 둠).
  //  내부 정책 테이블 → firewall DENIED_TABLES 등록: '누가 어떤 채널을 숨겼는지'도 그 사람의 사생활이라
  //   db_query 자유 SELECT 대상이 아니다(member_secret 과 동급 취급).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_channel_policy(
      member_id TEXT NOT NULL,
      system TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      allow_read BOOLEAN NOT NULL DEFAULT true,
      allow_write BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY(member_id, system, channel_id));
    CREATE INDEX IF NOT EXISTS member_channel_policy_member_idx ON member_channel_policy(member_id, system);
    -- peer_id: DM 일 때 상대의 slack user_id(U…). 슬랙은 DM 을 **상대 user_id 로도** 연다
    --  (slack_read_channel/slack_send_message 의 channel_id 에 U… 허용 — 툴 설명 실측) → D… 만 저장하면
    --  U… 로 부르는 경로에서 열람 차단이 그대로 뚫린다. 채널 정책은 이 값도 함께 대조한다.
    ALTER TABLE member_channel_policy ADD COLUMN IF NOT EXISTS peer_id TEXT;
    -- legacy(#1262): 이 행이 **#1226 시절(기본 전부 허용)에 저장된 것**인가.
    --  그 시절 allow_read/write=true 는 '사람이 허용을 골랐다' 가 아니라 **'기본값을 안 건드렸다'** 였다.
    --  #1262 로 비공개 기본값이 '거부' 가 된 뒤 그 true 를 명시 허용으로 읽으면, 사람이 결정한 적 없는
    --  비공개 채널·DM 열람이 열린다(실측으로 확인: 재설계 배포 직후 #lively-비공개 가 그대로 읽혔다).
    --  그래서 구 행은 **false(사람이 끈 것)만 뜻이 있는 것으로** 해석한다 — org/channels/channel-guard.overrideOf.
    --  ⚠ 마이그레이션 트릭: DEFAULT true 로 컬럼을 만들어 **기존 행에만** true 가 박히게 하고, 곧바로
    --   기본값을 false 로 내린다(이후 INSERT 는 새 시대). ADD COLUMN IF NOT EXISTS 라 재실행에 멱등이고,
    --   행을 지우지 않으므로 공개 채널에 걸어 둔 차단 같은 사람의 뜻은 그대로 보존된다.
    ALTER TABLE member_channel_policy ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE member_channel_policy ALTER COLUMN legacy SET DEFAULT false;
  `);

  // ── member_channel_meta — 대화 id → 종류(공개/비공개/그룹DM/DM) 캐시(#1262). ──
  //  왜 캐시가 **필수**인가: 기본값이 대화 종류에 따라 갈리는데, **채널 id 로는 종류를 알 수 없다.**
  //   슬랙 비공개 채널도 'C' 로 시작한다(실측: private #lively-비공개 = C0BL393EKCP, 공개 = C0BLJKT7534).
  //   공개↔비공개 전환 시 id 가 유지되기 때문이고, 슬랙 공식 문서도 "id 첫 글자 휴리스틱에 의존하지 말고
  //   is_private 를 보라"고 못박는다. 그런데 집행 자리(mcp-proxy)엔 id·이름밖에 없다 → 여기서 해소한다.
  //  채우는 경로: ① 관리탭 대화 목록(users.conversations) ② 정책 저장 시 그 대화 ③ 집행 중 캐시 미스
  //   → conversations.info 단건 조회. 어느 경로로도 못 알아내면 **비공개로 간주해 막는다**(fail-closed) —
  //   '모르니까 일단 보여준다' 는 이 기능의 목적을 정면으로 배신한다.
  //  member 별인 이유: 비공개 채널·DM 은 사람마다 보이는 것이 다르다. 이름→종류 대조도 그 사람 시야 기준.
  //  firewall DENIED_TABLES: '누가 어떤 대화에 속해 있는지' 도 정책 테이블과 같은 급의 사생활.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_channel_meta(
      member_id TEXT NOT NULL,
      system TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      channel_type TEXT NOT NULL,            -- public | private | group_dm | dm
      peer_id TEXT,                          -- DM 상대 user_id(U…) — U… 경로 대조용
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(member_id, system, channel_id));
    CREATE INDEX IF NOT EXISTS member_channel_meta_member_idx ON member_channel_meta(member_id, system);
  `);

  // ── web_session — 사람 웹 로그인 세션(P4). HttpOnly 쿠키가 나르는 평문 세션ID 는 저장 안 함(sha256 만). ──
  //  revoke=logout/회수, expires_at 만료. scope 는 저장하지 않는다 — 인증 시 org_member.scopes 를 LIVE 로 읽어
  //  desync 를 원천 차단(토큰과 달리 세션은 사람이 본인으로 행위 → 멤버 권한 그대로, 최소권한 캡 없음).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_session(
      session_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      ip TEXT,
      user_agent TEXT);
    CREATE INDEX IF NOT EXISTS web_session_member_idx ON web_session(member_id);
  `);

  // ── git_credential — 레포 클론·세션 git 용 자격(#540). 웹UI로 관리(→DB 저장)하되 시크릿(개인키·토큰)은
  //  봉투 암호화(secret-box, CONNECTOR_SECRET_KEY)만 저장 — 공개키는 평문(웹 노출 OK). owner='gateway'(조직 머신
  //  계정) | 'member:<id>'(개별 사용자). (owner,host) 1행. kind 가 어느 필드가 채워졌는지 결정.
  //   게이트웨이 provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS git_credential(
      owner TEXT NOT NULL,                     -- 'gateway' | 'member:<id>'
      host  TEXT NOT NULL DEFAULT 'github.com',
      kind  TEXT NOT NULL,                     -- 'ssh' | 'https'
      ssh_public_key      TEXT,                -- 공개키(평문 — 웹 노출·GitHub 등록용)
      ssh_private_key_enc TEXT,                -- SSH 개인키(봉투 암호화)
      https_username      TEXT,                -- HTTPS 사용자명(GitHub 토큰이면 임의값 무관)
      https_token_enc     TEXT,                -- HTTPS 토큰/PAT(봉투 암호화)
      label TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by   TEXT,
      last_used_at TIMESTAMPTZ,
      PRIMARY KEY (owner, host));
  `);

  // ── 멤버 이메일 유일성(로그인 아이디) — 부분 유니크(비어있지 않은 이메일만, 대소문자 무시). ──
  //  앱 레벨(org_member_upsert)이 1차 방어, 이 인덱스가 DB 보증. 기존 중복 데이터가 있으면 생성 실패 →
  //  **비치명적**으로 보류(중복 정리 후 다음 부팅에 자동 적용). 앱 검증은 그 사이에도 신규 중복을 막는다.
  await softUniqueIndex(pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS org_member_email_lc_uniq ON org_member (lower(email)) WHERE email IS NOT NULL AND email <> ''`,
    "[org schema] 멤버 이메일 유니크 인덱스 보류(기존 중복 데이터?)");

  // ── pending_device_auth — CLI 브라우저 로그인(디바이스 코드, #880). CLI 가 device_code 보유, 사람이 user_code
  //  를 브라우저에서 승인, CLI 가 폴링해 토큰 수령. 평문 토큰은 저장 안 함(폴 시점 발급) — sha256 지문만.
  //  device_code_hash=sha256(평문 32B), code_challenge=S256(verifier)로 개시자 바인딩(도난 device_code 상환 차단).
  //  status pending→approved→consumed / denied. TTL 15분, GC 로 회수(reaper + lazy delete-on-read).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_device_auth(
      device_code_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL,                          -- 저장형: 8자 대문자, 하이픈 없음
      code_challenge TEXT NOT NULL,                     -- S256(code_verifier) base64url
      status TEXT NOT NULL DEFAULT 'pending',           -- pending | approved | denied | consumed
      member_id TEXT,                                   -- 승인 시 세션 멤버
      approver_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,-- 승인자 scope 스냅샷(poll 이 ∩ 재교집합 → 증폭 차단)
      include_control_plane BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ,
      last_polled_at TIMESTAMPTZ,
      client_label TEXT);
  `);
  //  pending 중 user_code 유일(부분 유니크) — terminal 행은 자유 충돌 허용(user_code 재사용). 이메일 인덱스처럼
  //  비치명 보류(신규 테이블이라 사실 충돌 불가지만 관례 유지).
  await softUniqueIndex(pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS pending_device_user_code_idx ON pending_device_auth(user_code) WHERE status='pending'`,
    "[org schema] pending_device_auth user_code 유니크 인덱스 보류");

  // ── pending_session_mint — 컨트롤플레인 → 테넌트 세션 SSO 브리지(#1454 S1). 관리자(컨트롤플레인)가
  //  org_session_mint 로 1회용 코드를 발급하고, 사용자의 브라우저가 GET /api/ui/session/exchange?code= 로
  //  교환해 웹 세션 쿠키를 받는다(자동 로그인). pending_device_auth 와 동형 관례: 평문 코드는 저장하지 않고
  //  sha256 만(code_hash PK), TTL 60초(도메인 간 리다이렉트 한 홉이면 충분 — 길수록 코드 유출 창만 넓어진다),
  //  used_at 으로 1회성 강제(교환은 원자적 UPDATE … WHERE used_at IS NULL). GC 는 교환 시 lazy delete(만료분).
  //  셀프호스트 무해: 테이블만 생기고 발급 창구(org_session_mint, admin scope)를 쓰지 않으면 영원히 빈 표다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_session_mint(
      code_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_by TEXT);
  `);
}

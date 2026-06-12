-- lively 제품 DB(덤프 복원본 또는 RDS)용 읽기 전용 role + (선택) RLS.
-- 게이트웨이는 master(lively_admin)가 아니라 이 role 로만 접속한다.
-- 적용: psql "<admin DATABASE_URL>" -v ropw="<강한-비밀번호>" -f sql/lively-readonly.sql
\set ON_ERROR_STOP on

-- 1) 읽기 전용 role ------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    CREATE ROLE mcp_readonly LOGIN PASSWORD :'ropw';
  END IF;
END $$;

GRANT CONNECT ON DATABASE lively TO mcp_readonly;
GRANT USAGE  ON SCHEMA public    TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- 쿼리 폭주 방어: role 기본 statement_timeout (게이트웨이도 SET LOCAL 로 한 번 더 건다)
ALTER ROLE mcp_readonly SET statement_timeout = '5s';

-- 2) (선택) 퍼유저 RLS — 유저 스코프 테이블에만 ------------------------------
-- 카탈로그성(brands, shop_products, campaigns ...)은 공개 읽기라 불필요.
-- 게이트웨이가 요청마다 set_config('app.current_user', <uuid>, true) 주입(db.ts 가 이미 함).
-- mcp_readonly 는 테이블 소유자가 아니므로 ENABLE 만으로 정책이 적용된다.
--
-- 예시(messages): 본인 메시지만 조회
--   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY messages_owner_read ON messages FOR SELECT
--     USING (user_id = current_setting('app.current_user', true)::uuid);
--
-- user_id / author_id 를 가진 테이블(conversations, conversation_participants,
-- messages, user_profiles, careers, sns_content_notes ...)에 동일 패턴으로 확장.
-- v0(팀 flat-trust)에서는 RLS 없이 read-only role + 쿼리 방화벽 + timeout 만으로 시작 가능.

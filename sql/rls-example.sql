-- ============================================================
-- "권한으로 조절"의 실제 구현체 = 읽기 전용 role + RLS
-- 게이트웨이는 매 요청 app.current_user 세션변수에 사용자를 주입하고,
-- DB의 RLS 정책이 그 값을 보고 row 를 자동 필터한다.
-- (자유 SQL이어도 권한 밖 row 는 DB가 내주지 않음)
-- ============================================================

-- 1) 게이트웨이가 접속할 읽기 전용 role (DATABASE_URL 의 user)
CREATE ROLE mcp_readonly NOLOGIN;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_readonly;

-- 2) 예시 테이블에 RLS 적용
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;  -- 테이블 소유자도 우회 못 하게

-- 본인 소유 row 만 조회 허용
CREATE POLICY documents_owner_read ON documents
  FOR SELECT
  USING (owner_id = current_setting('app.current_user', true));

-- 조직 공개 row 는 모두 조회 허용
CREATE POLICY documents_shared_read ON documents
  FOR SELECT
  USING (visibility = 'org');

-- 참고: current_setting('app.current_user', true) 의 두 번째 인자 true =
--       세션변수가 없을 때 에러 대신 NULL 반환 → 미인증 요청은 0 row.

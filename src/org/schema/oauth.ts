// OAuth 2.1 인가서버(AS) 스키마 (#1473 T2) — 게이트웨이가 MCP 클라이언트에게 토큰을 발급하는 쪽.
//  왜 필요한가: claude.ai 챗·ChatGPT 웹의 커넥터 UI 에는 **Bearer·커스텀 헤더 입력란이 없다**(2026-08-04 실측 —
//  커넥터 추가 모달은 URL + OAuth 클라이언트 ID/시크릿뿐). 그래서 인증이 걸린 우리 게이트웨이를 그 표면에
//  붙이는 길은 OAuth 하나뿐이다. MCP 사양(2025-11-25)도 PRM(RFC 9728)·AS 메타데이터·PKCE·resource 바인딩을 요구한다.
//
//  ⚠ 액세스 토큰은 **새 테이블을 만들지 않고 기존 auth_token 을 쓴다**(아래 ALTER). 이유:
//   ① 검증 경로가 하나로 유지된다 — verifyDbToken 이 그대로 OAuth 토큰도 통과시킨다(bearer.ts 무개조).
//   ② 회수 경로가 하나다 — 관리탭의 토큰 회수가 OAuth 발급분에도 그대로 듣는다(kill-switch 일원화).
//   ③ 감사·귀속(member_id·scopes·projects)이 이미 그 테이블의 계약이다.
//   대신 만료(expires_at)·클라이언트(client_id)·대상(resource) 세 컬럼을 더한다 — 종전 토큰은 NULL 이라
//   무회귀(만료 없음·클라이언트 없음 = 사람이 발급한 장기 토큰).
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initOAuthServer(pool: Pool): Promise<void> {
  // ── oauth_client — 등록된 MCP 클라이언트. 세 가지 경로로 들어온다(MCP 사양의 3 등록 방식). ──
  //  · cimd   : client_id 가 https URL 이고 그 URL 이 클라이언트 메타데이터 문서다(RFC 초안, 사양 권장 기본).
  //             ChatGPT 가 이 방식을 쓴다. 문서를 fetch·검증해 여기 캐시하고 HTTP 캐시 헤더를 존중한다.
  //  · dcr    : POST /register 로 동적 등록(RFC 7591). 사양상 deprecated 지만 하위호환으로 유지.
  //  · static : 관리자가 미리 등록(Gemini Enterprise 처럼 client_id/secret 을 손으로 넣는 표면용).
  //  client_secret 은 평문 저장 금지 — sha256 해시만(auth_token 과 같은 계약). public client 는 NULL.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_client(
      client_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'dcr',
      client_name TEXT,
      client_secret_hash TEXT,
      redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
      grant_types JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
      token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- CIMD 문서 캐시 갱신 시각. HTTP 캐시 헤더가 만료를 정하고, 이 값은 관측·디버깅용.
      refreshed_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ);
    ${ensureCheck("oauth_client", {
      oauth_client_kind_chk: "kind IN ('cimd','dcr','static')",
    })}
  `);

  // ── oauth_auth_code — 인가코드(단명). 평문은 저장하지 않는다(sha256). ──
  //  PKCE(code_challenge)는 필수다 — 사양이 S256 을 요구하고, 우리 디바이스 코드 흐름(#880)도 같은 규율을 쓴다.
  //  resource = RFC 8707 대상 지정. 이 값이 그대로 발급 토큰의 audience 가 되고, 자원서버가 자기 앞 토큰인지 검증한다.
  //  consumed_at 으로 1회성을 강제한다(재사용 시도는 거부 + 감사 대상 — 코드 도난 신호).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_auth_code(
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      redirect_uri TEXT NOT NULL,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS oauth_auth_code_expiry_idx ON oauth_auth_code(expires_at);
    ${ensureCheck("oauth_auth_code", {
      oauth_auth_code_method_chk: "code_challenge_method = 'S256'",
    })}
  `);

  // ── oauth_refresh — 리프레시 토큰. 공개 클라이언트는 사양상 **회전 필수**라 rotated_to 로 사슬을 남긴다. ──
  //  회전된 옛 토큰이 다시 쓰이면 = 도난 신호 → 그 사슬 전체를 무효화하는 근거가 이 컬럼이다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_refresh(
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      resource TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rotated_to TEXT,
      revoked_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS oauth_refresh_member_idx ON oauth_refresh(member_id);
    CREATE INDEX IF NOT EXISTS oauth_refresh_expiry_idx ON oauth_refresh(expires_at);
  `);

  // ── auth_token 확장 — OAuth 액세스 토큰을 같은 테이블에 둔다(위 헤더 주석의 3가지 이유). ──
  //  expires_at IS NULL = 만료 없음(사람이 발급한 장기 토큰, 종전 동작 그대로).
  //  resource 는 발급 시 요청된 RFC 8707 대상 — 자원서버가 "내 앞으로 발급된 토큰인가"를 이 값으로 판정한다.
  await pool.query(`
    ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS client_id TEXT;
    ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS resource TEXT;
    ALTER TABLE auth_token ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS auth_token_expiry_idx ON auth_token(expires_at) WHERE expires_at IS NOT NULL;
  `);
}

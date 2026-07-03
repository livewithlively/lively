// Google OAuth2 refresh-token → access token (Gmail/Drive 공용, 프로젝트 #541). CTO gcp-adc-token.py 이식.
//
//   인증 방식 = OAuth2 "authorized user" refresh-token flow (service account 아님). 고객이 자기 GCP 프로젝트에서
//   Desktop/Installed OAuth 클라이언트를 만들고 consent 후 얻은 client_id/client_secret/refresh_token 을 설정한다.
//   1개 refresh token 이 여러 scope(gmail.readonly + drive.readonly)를 한꺼번에 커버할 수 있다.
//
//   교환: POST {token_uri} form(grant_type=refresh_token, client_id, client_secret, refresh_token) → access_token(~1h).
//   access token 은 프로세스 메모리에 만료(expires_in)까지 캐시 — 매 API 호출마다 재발급하지 않는다(CTO는 매번 재발급).
//   fetch 만 사용(googleapis SDK 미도입 — 기존 원칙).
//
//   ⚠ OAuth 클라이언트가 "Testing" 상태면 refresh token 이 7일 만료(Google 정책) — consent 화면 publish 필요.
import { resolveConnectorConfig } from "./config.js";

const TOKEN_URI_DEFAULT = "https://oauth2.googleapis.com/token";

interface CachedToken { token: string; expMs: number }
const cache = new Map<string, CachedToken>();

// 커넥터 system('gmail'|'gdrive')의 config 에서 access token 획득(만료 캐시). config 는 커넥터별(각자 client_id 등).
export async function googleAccessToken(system: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(system);
  if (hit && hit.expMs - 60_000 > now) return hit.token; // 만료 60s 여유 안에서 재사용

  const cfg = await resolveConnectorConfig(system);
  const clientId = cfg.client_id;
  const clientSecret = cfg.client_secret;
  const refreshToken = cfg.refresh_token;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`${system}: Google OAuth 자격 미설정 — client_id·client_secret·refresh_token 이 필요합니다(관리탭 커넥터 설정 또는 .env).`);
  }
  const tokenUri = cfg.token_uri || TOKEN_URI_DEFAULT;

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // 본문에 토큰이 섞이지 않도록 앞부분만. invalid_grant 면 refresh token 만료/취소(재발급 안내).
    throw new Error(`${system}: Google 토큰 교환 실패 ${res.status} — ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error(`${system}: Google 토큰 응답에 access_token 이 없습니다.`);
  const ttl = (Number(json.expires_in) || 3599) * 1000;
  cache.set(system, { token: json.access_token, expMs: now + ttl });
  return json.access_token;
}

// 테스트/재설정용 — 토큰 캐시 무효화.
export function resetGoogleTokenCache(): void { cache.clear(); }

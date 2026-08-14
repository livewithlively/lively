// OAuth 2.1 인가서버 저장계층 (#1473 T2) — oauth_client / oauth_auth_request / oauth_auth_code / oauth_refresh
//  + auth_token(액세스 토큰은 기존 테이블 공유, schema/oauth.ts 머리주석 참조) 에 대한 모든 DB 접근.
//  프로토콜 판단(무엇이 유효한 요청인가)은 oauth-provider.ts 가, '그걸 원자적으로 어떻게 쓰나'는 여기가 소유한다.
//
//  ★ 이 파일의 두 불변식 —
//   ① 비밀(코드·리프레시·요청id·클라이언트 시크릿)은 **평문으로 저장되지 않는다**. 전부 sha256.
//   ② 소비(consume)와 발급(mint)은 **한 트랜잭션**이다. #880 디바이스 흐름에서 확립한 규율 그대로:
//      따로 커밋하면 COMMIT 실패 시 고아 토큰이 남거나, 동시 요청이 같은 코드로 두 번 발급받는다.
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { mintToken } from "./tokens.js";
import { getMember } from "./members.js";
import { audit } from "./audit.js";
import { sha256Hex, randomSecret, grantableScopes } from "../auth/grant-util.js";
import { logger } from "../../log.js";

// ── 수명 상수 ──
export const AUTH_REQUEST_TTL = 600;  // 미결 인가요청 10분 — 사람이 로그인하고 동의를 누르는 시간.
export const CODE_TTL = 300;          // 인가코드 5분(RFC 6749 권고 상한 10분 이내). 1회용 + PKCE.
export const ACCESS_TTL = 3600;       // 액세스 토큰 1시간. 짧게 두고 리프레시로 갱신한다.
export const REFRESH_TTL = 30 * 24 * 3600; // 리프레시 30일. 사용할 때마다 회전(공개 클라이언트 필수).

export type ClientKind = "cimd" | "dcr" | "static";

export interface ClientRow {
  client_id: string;
  kind: ClientKind;
  client_name: string | null;
  client_secret_hash: string | null;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  metadata: Record<string, unknown>;
  refreshed_at: string | null;
  disabled_at: string | null;
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function toClientRow(row: Record<string, unknown>): ClientRow {
  return {
    client_id: String(row.client_id),
    kind: (row.kind as ClientKind) ?? "dcr",
    client_name: (row.client_name as string | null) ?? null,
    client_secret_hash: (row.client_secret_hash as string | null) ?? null,
    redirect_uris: strArr(row.redirect_uris),
    grant_types: strArr(row.grant_types),
    token_endpoint_auth_method: String(row.token_endpoint_auth_method ?? "none"),
    metadata: (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>,
    refreshed_at: (row.refreshed_at as string | null) ?? null,
    disabled_at: (row.disabled_at as string | null) ?? null,
  };
}

// ── 클라이언트 ──

// disabled 클라이언트는 '없는 것'으로 취급한다 — 관리자가 끄면 즉시 인가·토큰이 막힌다(kill-switch).
export async function getClient(clientId: string): Promise<ClientRow | null> {
  const r = await itemsPool.query(
    `SELECT * FROM oauth_client WHERE client_id=$1 AND disabled_at IS NULL`, [clientId]);
  return r.rowCount ? toClientRow(r.rows[0] as Record<string, unknown>) : null;
}

// 관리탭·관리자 에이전트용 목록. **시크릿 해시는 내보내지 않는다** — 있는지 여부(has_secret)만 알면 충분하고,
//  해시가 밖으로 도는 순간 오프라인 대입의 표적이 된다(토큰 목록이 prefix 만 노출하는 것과 같은 규율).
export interface ClientSummary {
  client_id: string; kind: ClientKind; client_name: string | null;
  redirect_uris: string[]; has_secret: boolean;
  created_at: string; refreshed_at: string | null; disabled_at: string | null;
}
export async function listClients(): Promise<ClientSummary[]> {
  const r = await itemsPool.query(
    `SELECT client_id, kind, client_name, redirect_uris,
            (client_secret_hash IS NOT NULL) AS has_secret, created_at, refreshed_at, disabled_at
       FROM oauth_client ORDER BY created_at DESC`);
  return r.rows as ClientSummary[];
}

// 비활성화 = 즉시 kill-switch. getClient 가 disabled 행을 '없음'으로 보므로 인가·토큰교환이 바로 막힌다.
//  이미 발급된 액세스 토큰까지 끊으려면 그 클라이언트의 토큰도 함께 회수한다(기본 동작).
export async function disableClient(clientId: string, actor?: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE oauth_client SET disabled_at=now() WHERE client_id=$1 AND disabled_at IS NULL`, [clientId]);
  await itemsPool.query(
    `UPDATE auth_token SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL`, [clientId]);
  await itemsPool.query(
    `UPDATE oauth_refresh SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL`, [clientId]);
  await audit("oauth_client", clientId, "disable", null, null, actor, "web");
  return (r.rowCount ?? 0) === 1;
}

export async function saveClient(input: {
  clientId: string;
  kind: ClientKind;
  clientName?: string | null;
  clientSecretHash?: string | null;
  redirectUris: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
  metadata?: Record<string, unknown>;
  actor?: string;
}): Promise<void> {
  await itemsPool.query(
    `INSERT INTO oauth_client(client_id, kind, client_name, client_secret_hash, redirect_uris,
                              grant_types, token_endpoint_auth_method, metadata, refreshed_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb, now())
     ON CONFLICT (client_id) DO UPDATE SET
       kind=EXCLUDED.kind, client_name=EXCLUDED.client_name,
       -- 시크릿은 새 값이 있을 때만 교체한다(CIMD 문서 갱신이 static 클라이언트의 시크릿을 지우지 않게).
       client_secret_hash=COALESCE(EXCLUDED.client_secret_hash, oauth_client.client_secret_hash),
       redirect_uris=EXCLUDED.redirect_uris, grant_types=EXCLUDED.grant_types,
       token_endpoint_auth_method=EXCLUDED.token_endpoint_auth_method,
       metadata=EXCLUDED.metadata, refreshed_at=now()`,
    [input.clientId, input.kind, input.clientName ?? null, input.clientSecretHash ?? null,
     JSON.stringify(input.redirectUris), JSON.stringify(input.grantTypes ?? ["authorization_code", "refresh_token"]),
     input.tokenEndpointAuthMethod ?? "none", JSON.stringify(input.metadata ?? {})],
  );
  await audit("oauth_client", input.clientId, "upsert", null,
    { kind: input.kind, redirect_uris: input.redirectUris, client_name: input.clientName ?? null },
    input.actor, "web");
}

// ── 미결 인가요청(동의 화면 왕복) ──

export interface AuthRequestRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  state: string | null;
  resource: string | null;
}

// 반환값은 **평문 request id** — 동의 URL 에 실린다. DB 엔 sha256 만 남는다.
export async function createAuthRequest(input: {
  clientId: string; redirectUri: string; codeChallenge: string;
  scopes: string[]; state?: string | null; resource?: string | null;
}): Promise<string> {
  const rid = randomSecret();
  await itemsPool.query(
    `INSERT INTO oauth_auth_request(request_hash, client_id, redirect_uri, code_challenge, scopes,
                                    state, resource, expires_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7, now() + ($8::int * interval '1 second'))`,
    [sha256Hex(rid), input.clientId, input.redirectUri, input.codeChallenge,
     JSON.stringify(input.scopes), input.state ?? null, input.resource ?? null, String(AUTH_REQUEST_TTL)],
  );
  return rid;
}

// 동의 화면 렌더용 조회(소비하지 않는다). 만료·소비된 요청은 null.
export async function readAuthRequest(rid: string): Promise<AuthRequestRow | null> {
  const r = await itemsPool.query(
    `SELECT client_id, redirect_uri, code_challenge, scopes, state, resource
       FROM oauth_auth_request
      WHERE request_hash=$1 AND consumed_at IS NULL AND expires_at > now()`,
    [sha256Hex(rid)],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    client_id: String(row.client_id), redirect_uri: String(row.redirect_uri),
    code_challenge: String(row.code_challenge), scopes: strArr(row.scopes),
    state: (row.state as string | null) ?? null, resource: (row.resource as string | null) ?? null,
  };
}

export interface ApprovedGrant { code: string; redirectUri: string; state: string | null; scopes: string[] }

/**
 * 동의 승인 → 인가코드 발급. **요청 소비와 코드 삽입이 한 트랜잭션**이라 뒤로가기·더블클릭으로 코드가
 *  두 번 나오지 않는다(첫 UPDATE 가 1행을 못 잡으면 통째로 실패).
 *  발급 scope 는 여기서 최종 확정한다 — 요청 scope ∩ 멤버 LIVE 상한 − 위험 scope.
 *  ⚠ 위험 scope(admin/runtime)는 OAuth 로는 **어떤 경우에도** 나가지 않는다: 이 경로의 클라이언트는 외부
 *   챗 표면(ChatGPT·claude.ai)이고, 그쪽에 fleet 제어 권한을 주는 건 프롬프트 인젝션 한 방과 같다.
 */
export async function approveAuthRequest(rid: string, memberId: string): Promise<ApprovedGrant | null> {
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE oauth_auth_request SET consumed_at=now()
         WHERE request_hash=$1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING client_id, redirect_uri, code_challenge, scopes, state, resource`,
      [sha256Hex(rid)],
    );
    if (claim.rowCount !== 1) { await client.query("ROLLBACK"); return null; }
    const req = claim.rows[0] as Record<string, unknown>;
    const mem = await getMember(memberId);
    if (!mem || mem.state !== "active") { await client.query("ROLLBACK"); return null; }
    const requested = strArr(req.scopes);
    const scopes = grantableScopes({
      memberScopes: mem.scopes,
      allowed: requested.length ? requested : null, // 요청 scope 미지정 = 멤버 상한 전체가 후보(동의 화면이 결과를 보여준다)
    });
    const code = randomSecret();
    await client.query(
      `INSERT INTO oauth_auth_code(code_hash, client_id, member_id, scopes, code_challenge,
                                   redirect_uri, resource, expires_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,$7, now() + ($8::int * interval '1 second'))`,
      [sha256Hex(code), String(req.client_id), memberId, JSON.stringify(scopes),
       String(req.code_challenge), String(req.redirect_uri), (req.resource as string | null) ?? null, String(CODE_TTL)],
    );
    await audit("oauth_auth_code", String(req.client_id), "authorize", null,
      { memberId, scopes, resource: (req.resource as string | null) ?? null }, memberId, "web", client);
    await client.query("COMMIT");
    return {
      code, redirectUri: String(req.redirect_uri),
      state: (req.state as string | null) ?? null, scopes,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* */ });
    throw e;
  } finally {
    client.release();
  }
}

// 거부 — 요청만 소비한다(코드 없음). 실패해도 흐름은 redirect_uri 로 error=access_denied 를 보낸다.
export async function denyAuthRequest(rid: string): Promise<void> {
  await itemsPool.query(
    `UPDATE oauth_auth_request SET consumed_at=now() WHERE request_hash=$1 AND consumed_at IS NULL`,
    [sha256Hex(rid)]);
}

// ── 토큰 발급 ──

export interface GrantResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  scopes: string[];
}

/** 도난 대응 — 한 (클라이언트, 멤버) 조합의 **모든** 액세스·리프레시를 즉시 무효화한다.
 *  코드 재사용·회전된 리프레시 재사용은 둘 다 "제3자가 비밀을 쥐고 있다"는 신호이고, 그때 무엇이 유출됐는지
 *  정확히 알 수 없다. 그래서 그 조합을 통째로 끊는다(사용자는 다시 연결하면 된다 — 정상 클라이언트에겐
 *  재인가 한 번, 공격자에겐 완전 차단). OAuth 2.1 §4.3.1 의 권고를 우리 저장구조에 맞게 구현한 것. */
async function revokeGrantFamily(exec: pg.PoolClient | typeof itemsPool, clientId: string, memberId: string): Promise<void> {
  await exec.query(
    `UPDATE auth_token SET revoked_at=now() WHERE client_id=$1 AND member_id=$2 AND revoked_at IS NULL`,
    [clientId, memberId]);
  await exec.query(
    `UPDATE oauth_refresh SET revoked_at=now() WHERE client_id=$1 AND member_id=$2 AND revoked_at IS NULL`,
    [clientId, memberId]);
}

// SDK tokenHandler 가 PKCE 검증에 쓰는 조회 — **소비하지 않는다**(소비는 exchange 단계의 원자 트랜잭션).
//  코드가 그 클라이언트 것인지도 여기서 본다(남의 코드로 challenge 를 캐가는 것 차단).
export async function challengeForCode(clientId: string, code: string): Promise<string | null> {
  const r = await itemsPool.query(
    `SELECT code_challenge FROM oauth_auth_code
      WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NULL AND expires_at > now()`,
    [sha256Hex(code), clientId],
  );
  return r.rowCount ? String((r.rows[0] as { code_challenge: string }).code_challenge) : null;
}

/**
 * 인가코드 → 액세스+리프레시. 소비·발급이 한 트랜잭션(불변식 ②).
 *  반환 null = invalid_grant(만료·이미 소비·클라이언트 불일치·redirect_uri 불일치·멤버 비활성).
 *  ★ 이미 소비된 코드가 다시 오면 도난 신호로 보고 그 (클라이언트, 멤버) 조합을 통째로 회수한다.
 */
export async function redeemAuthCode(input: {
  clientId: string; code: string; redirectUri?: string; resource?: string | null;
}): Promise<GrantResult | null> {
  const codeHash = sha256Hex(input.code);
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE oauth_auth_code SET consumed_at=now()
         WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NULL AND expires_at > now()
       RETURNING member_id, scopes, redirect_uri, resource`,
      [codeHash, input.clientId],
    );
    if (claim.rowCount !== 1) {
      await client.query("ROLLBACK");
      await detectCodeReplay(codeHash, input.clientId);
      return null;
    }
    const row = claim.rows[0] as { member_id: string; scopes: unknown; redirect_uri: string; resource: string | null };
    // redirect_uri 는 인가 때와 **정확히** 같아야 한다(RFC 6749 §4.1.3 — 코드 주입 방어).
    if (input.redirectUri !== undefined && input.redirectUri !== row.redirect_uri) {
      await client.query("ROLLBACK");
      return null;
    }
    // 토큰 요청의 resource 가 인가 때와 다르면 거부 — audience 를 사후에 갈아끼우지 못하게(RFC 8707).
    if (input.resource != null && row.resource != null && input.resource !== row.resource) {
      await client.query("ROLLBACK");
      return null;
    }
    const mem = await getMember(row.member_id);
    if (!mem || mem.state !== "active") { await client.query("ROLLBACK"); return null; }
    // 발급 시점 LIVE 상한과 다시 교집합 — 인가~교환 사이에 강등됐으면 그만큼만 나간다.
    const scopes = grantableScopes({ memberScopes: mem.scopes, allowed: strArr(row.scopes) });
    const result = await issueTokens(client, {
      clientId: input.clientId, memberId: row.member_id, scopes,
      resource: row.resource, label: "oauth",
    });
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* */ });
    throw e;
  } finally {
    client.release();
  }
}

// 소비 실패가 '재사용'이었는지 확인하고, 맞으면 그 조합을 회수한다(별 트랜잭션 — 실패 경로라 지연 무해).
async function detectCodeReplay(codeHash: string, clientId: string): Promise<void> {
  try {
    const r = await itemsPool.query(
      `SELECT member_id FROM oauth_auth_code WHERE code_hash=$1 AND client_id=$2 AND consumed_at IS NOT NULL`,
      [codeHash, clientId]);
    if (!r.rowCount) return; // 단순 만료·오타 — 도난 신호 아님
    const memberId = String((r.rows[0] as { member_id: string }).member_id);
    logger.warn({ clientId, memberId }, "인가코드 재사용 감지 — 해당 클라이언트·멤버의 토큰 전량 회수");
    await revokeGrantFamily(itemsPool, clientId, memberId);
    await audit("oauth_auth_code", clientId, "replay_detected", null, { memberId }, "system", "mcp");
  } catch (err) {
    logger.warn({ err }, "인가코드 재사용 점검 실패(무시)");
  }
}

/**
 * 리프레시 → 새 액세스+새 리프레시. **회전 필수**(공개 클라이언트) — 옛 토큰은 rotated_to 로 사슬을 남기고 죽는다.
 *  ★ 이미 회전된 리프레시가 다시 오면 도난 신호 → 그 조합 전량 회수(위 revokeGrantFamily).
 *  scope 는 확대 불가 — 원래 발급분 ∩ 요청 ∩ 멤버 LIVE.
 */
export async function redeemRefreshToken(input: {
  clientId: string; refreshToken: string; requestedScopes?: string[]; resource?: string | null;
}): Promise<GrantResult | null> {
  const oldHash = sha256Hex(input.refreshToken);
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE oauth_refresh SET revoked_at=now()
         WHERE token_hash=$1 AND client_id=$2 AND revoked_at IS NULL AND rotated_to IS NULL AND expires_at > now()
       RETURNING member_id, scopes, resource`,
      [oldHash, input.clientId],
    );
    if (claim.rowCount !== 1) {
      await client.query("ROLLBACK");
      await detectRefreshReplay(oldHash, input.clientId);
      return null;
    }
    const row = claim.rows[0] as { member_id: string; scopes: unknown; resource: string | null };
    if (input.resource != null && row.resource != null && input.resource !== row.resource) {
      await client.query("ROLLBACK");
      return null;
    }
    const mem = await getMember(row.member_id);
    if (!mem || mem.state !== "active") { await client.query("ROLLBACK"); return null; }
    const granted = strArr(row.scopes);
    const allowed = input.requestedScopes?.length ? granted.filter((s) => input.requestedScopes!.includes(s)) : granted;
    const scopes = grantableScopes({ memberScopes: mem.scopes, allowed });
    const result = await issueTokens(client, {
      clientId: input.clientId, memberId: row.member_id, scopes,
      resource: row.resource, label: "oauth-refresh",
    });
    // 회전 사슬 — 옛 행이 새 행을 가리킨다. 이 링크가 '재사용 탐지'의 근거다.
    await client.query(`UPDATE oauth_refresh SET rotated_to=$2 WHERE token_hash=$1`,
      [oldHash, sha256Hex(result.refreshToken)]);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* */ });
    throw e;
  } finally {
    client.release();
  }
}

async function detectRefreshReplay(tokenHash: string, clientId: string): Promise<void> {
  try {
    const r = await itemsPool.query(
      `SELECT member_id FROM oauth_refresh
        WHERE token_hash=$1 AND client_id=$2 AND (rotated_to IS NOT NULL OR revoked_at IS NOT NULL)`,
      [tokenHash, clientId]);
    if (!r.rowCount) return;
    const memberId = String((r.rows[0] as { member_id: string }).member_id);
    logger.warn({ clientId, memberId }, "회전된 리프레시 토큰 재사용 감지 — 해당 클라이언트·멤버의 토큰 전량 회수");
    await revokeGrantFamily(itemsPool, clientId, memberId);
    await audit("oauth_refresh", clientId, "replay_detected", null, { memberId }, "system", "mcp");
  } catch (err) {
    logger.warn({ err }, "리프레시 재사용 점검 실패(무시)");
  }
}

// 액세스 토큰(auth_token 공유) + 리프레시 발급. 호출자의 트랜잭션 안에서만 돈다.
async function issueTokens(client: pg.PoolClient, input: {
  clientId: string; memberId: string; scopes: string[]; resource: string | null; label: string;
}): Promise<GrantResult> {
  const { token } = await mintToken({
    userId: input.memberId, scopes: input.scopes, memberId: input.memberId,
    label: input.label, clientId: input.clientId, resource: input.resource, expiresInSec: ACCESS_TTL,
  }, input.memberId, "mcp", client);
  const refreshToken = randomSecret();
  await client.query(
    `INSERT INTO oauth_refresh(token_hash, client_id, member_id, scopes, resource, expires_at)
       VALUES($1,$2,$3,$4::jsonb,$5, now() + ($6::int * interval '1 second'))`,
    [sha256Hex(refreshToken), input.clientId, input.memberId, JSON.stringify(input.scopes),
     input.resource, String(REFRESH_TTL)],
  );
  return { accessToken: token, expiresIn: ACCESS_TTL, refreshToken, scopes: input.scopes };
}

// RFC 7009 취소 — 어느 종류인지 클라이언트가 안 알려줘도 되게 둘 다 시도한다(사양 권고).
//  자기 클라이언트의 토큰만 취소할 수 있다(client_id 조건) — 남의 토큰 원격 무효화 차단.
export async function revokeGrantToken(clientId: string, token: string): Promise<void> {
  const hash = sha256Hex(token);
  await itemsPool.query(
    `UPDATE auth_token SET revoked_at=now() WHERE token_hash=$1 AND client_id=$2 AND revoked_at IS NULL`,
    [hash, clientId]);
  await itemsPool.query(
    `UPDATE oauth_refresh SET revoked_at=now() WHERE token_hash=$1 AND client_id=$2 AND revoked_at IS NULL`,
    [hash, clientId]);
}

// reaper — 만료 후 1시간 지난 단명 행 정리(device-auth reaper 와 같은 규율).
//  auth_token 은 지우지 않는다(감사 대상 — 만료 검사가 이미 무효화한다).
export async function reapOAuth(): Promise<number> {
  let n = 0;
  for (const t of ["oauth_auth_request", "oauth_auth_code"]) {
    const r = await itemsPool.query(`DELETE FROM ${t} WHERE expires_at < now() - interval '1 hour'`);
    n += r.rowCount ?? 0;
  }
  // 리프레시는 회전 사슬(도난 탐지 근거)이라 더 오래 둔다 — 만료 후 30일.
  const r = await itemsPool.query(`DELETE FROM oauth_refresh WHERE expires_at < now() - interval '30 days'`);
  return n + (r.rowCount ?? 0);
}

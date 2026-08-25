// auth_token — DB 기반 bearer 토큰(발급·조회·회수) + 유효 권한 계산 + 인증 핫패스 verifyDbToken.
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리. mintToken 의 PoolClient 오버로드(#880) 시그니처 불변.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { isScope } from "../../auth/scopes.js";
import { audit, sha256 } from "./audit.js";

// ── auth_token (DB 기반 bearer) ──
// 발급 — 평문 토큰을 1회 반환(저장은 해시만). prefix 'lvk_' 로 verifyDbToken 의 빠른 게이팅 가능.
// email 은 토큰에 저장하지 않는다 — 귀속/표시용 email 은 member_id → org_member 에서 파생(중복·stale 제거).
// client 를 넘기면 그 커넥션(트랜잭션 중)에서 INSERT+audit 을 실행한다(#880 device flow: consume-UPDATE 와
//  같은 BEGIN/COMMIT 원자성 — 안 그러면 토큰이 독립 커밋돼 COMMIT 실패 시 orphan 토큰 누수). 기본은 풀(autocommit).
// clientId/resource/expiresInSec 는 OAuth 인가서버(#1473 T2)가 채우는 바인딩 3종 — 생략하면 종전 그대로
//  '만료 없는·클라이언트 없는' 사람 발급 토큰이다(무회귀).
export async function mintToken(input: {
  userId: string;
  scopes: string[];
  projects?: string[];
  label?: string | null;
  memberId?: string | null;
  clientId?: string | null;
  resource?: string | null;
  expiresInSec?: number | null;
  appId?: string | null;   // 앱 세션 토큰(#1780) — 이 값이 있으면 requireAppTool 이 도구를 그 앱 grant 로 축소.
}, actor?: string, source?: string, client?: pg.PoolClient): Promise<{ token: string; tokenHash: string; expiresAt: Date | null }> {
  const exec = client ?? itemsPool;
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  const ttl = input.expiresInSec != null && Number.isFinite(input.expiresInSec) && input.expiresInSec > 0
    ? Math.floor(input.expiresInSec) : null;
  // 만료는 DB now() 기준으로 계산한다 — 검증(verifyDbToken)도 DB now() 라 시계가 하나로 유지된다.
  const r = await exec.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by,
                            client_id, resource, app_id, expires_at)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$11,
              now() + ($10::int * interval '1 second'))
     RETURNING expires_at`,
    [tokenHash, input.userId, JSON.stringify(input.scopes),
     JSON.stringify(input.projects ?? ["*"]), input.label ?? null, input.memberId ?? null, actor ?? null,
     input.clientId ?? null, input.resource ?? null, ttl == null ? null : String(ttl), input.appId ?? null],
  );
  await audit("auth_token", input.userId, "mint",
    null, { userId: input.userId, scopes: input.scopes, label: input.label, memberId: input.memberId,
            clientId: input.clientId ?? null, resource: input.resource ?? null }, actor, source, client);
  const expiresAt = (r.rows[0] as { expires_at: string | null } | undefined)?.expires_at ?? null;
  return { token, tokenHash, expiresAt: expiresAt ? new Date(expiresAt) : null };
}

export interface TokenMeta {
  token_hash: string;
  user_id: string;
  scopes: string[];
  label: string | null;
  member_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listTokens(): Promise<TokenMeta[]> {
  const r = await itemsPool.query(
    `SELECT token_hash, user_id, scopes, label, member_id, created_at, last_used_at, revoked_at
       FROM auth_token ORDER BY created_at DESC`,
  );
  return r.rows as TokenMeta[];
}

export async function revokeToken(tokenHash: string, actor?: string, source?: string): Promise<void> {
  await itemsPool.query(
    `UPDATE auth_token SET revoked_at = now() WHERE token_hash=$1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  await audit("auth_token", tokenHash, "revoke", null, null, actor, source); // 전체 해시 기록(상관추적용 — 해시는 비밀 아님)
}

// 유효 권한 계산(순수 함수 — 단위 테스트 대상). 토큰은 '발급된 상한', 멤버는 '라이브 상한' →
//  유효 = 둘의 intersection. 멤버 연결 토큰(member_id 있음)인데 멤버가 active 가 아니면(비활성/삭제 → LEFT JOIN
//  state=null) null=거부 → 퇴사·강등이 즉시 모든 토큰을 무효화(보안 핵심). member_id 없는 서비스/레거시 토큰은
//  교집합 대상이 없어 토큰 scope 그대로. (상향은 토큰 재발급으로 — 최소권한 보존, 자동 확대 안 함.)
//  #1780 v2 §7-1(설계 R2-C7) — **멤버 없는 앱 토큰**(app_id 있음·member_id 없음 = v2 의 앱 봇 토큰 형태)은
//  멤버 대신 **앱이 라이브 상한**이다: 앱이 켜져 있고(enabled) active 일 때만 유효, 꺼짐·삭제·조회불가면 null=거부.
//  v1 에 이걸 먼저 심어 두는 이유 — v2 배포 뒤 롤백하면 v1 코드가 그 토큰을 만나는데, 이 가드가 없으면
//  "앱 disable 로도 안 죽는 전역 토큰" 이 된다(전방 방어). 멤버 연결 앱 토큰(v1 앱 세션)은 종전대로 멤버 축.
export function computeEffectiveScopes(opts: {
  memberId: string | null;
  memberState: string | null;
  tokenScopes: string[];
  memberScopes: string[];
  appId?: string | null;
  appLive?: boolean | null;   // 앱 enabled ∧ status='active'. null = 앱 행 없음/조회 불가(거부).
}): string[] | null {
  // B4: 허용 scope 만(JSONB 손상·마이그레이션·위조로 admin/runtime 섞여 들어와도 여기서 떨군다).
  const tokenScopes = opts.tokenScopes.filter(isScope);
  if (!opts.memberId) {
    if (opts.appId) return opts.appLive === true ? tokenScopes : null;
    return tokenScopes;
  }
  if (opts.memberState !== "active") return null;
  const memberScopes = new Set(opts.memberScopes.filter(isScope));
  return tokenScopes.filter((s) => memberScopes.has(s));
}

// verifyDbToken 이 돌려주는 토큰 신원 — LivelyUser 원재료 + OAuth 발급분의 바인딩 3종(#1473 T2).
//  clientId/resource/expiresAt 은 사람이 발급한 장기 토큰이면 전부 null(종전 동작 그대로).
export interface DbTokenIdentity {
  userId: string;
  email: string;
  scopes: string[];
  projects: string[];
  clientId: string | null;   // 발급 OAuth 클라이언트(oauth_client.client_id). 감사·읽기전용 프로필(T3)의 축.
  resource: string | null;   // RFC 8707 대상(audience) — 자원서버가 '내 앞으로 발급된 토큰인가'를 이걸로 판정.
  expiresAt: number | null;  // Unix 초. null = 만료 없음.
  appId: string | null;      // 앱 세션 토큰이면 그 앱 id(#1780). null = 일반 토큰. requireAppTool 이 도구를 축소한다.
}

// 인증 경로(bearer.ts) — 평문 토큰 → 해시 조회. revoked 아니면 LivelyUser shape 반환, 아니면 null.
// ITEMS_DATABASE_URL 미설정/오류 시 null(fail-closed: 무효 토큰 취급).
// ⚠ 만료는 **DB 의 now() 로** 판정한다(#1473 T2) — 앱 서버 시계에 의존하지 않고, web_session 검증과 같은
//  규율이다. 이 검사가 없으면 OAuth 액세스 토큰(1시간)이 영구 토큰이 된다(만료가 장식이 됨).
export async function verifyDbToken(token: string): Promise<DbTokenIdentity | null> {
  if (!process.env.ITEMS_DATABASE_URL) return null;
  try {
    // email·권한 상한 모두 토큰이 아니라 구성원에서 파생(같은 쿼리 LEFT JOIN — 라운드트립 0, 항상 최신).
    const r = await itemsPool.query(
      //  app_live — 멤버 없는 앱 토큰의 라이브 상한(computeEffectiveScopes 주석). 서브쿼리 집계라 org_app 이
      //  테넌트 PK(tenant_id,id) 로 여러 행이어도 토큰 행이 불어나지 않는다. bool_and = 어느 테넌트든 꺼져 있으면
      //  거부(보수적). 행 0 → NULL → 거부.
      `SELECT t.user_id, t.member_id, m.email AS email, m.state AS member_state,
              t.scopes AS token_scopes, m.scopes AS member_scopes, t.projects,
              t.client_id, t.resource, t.app_id, EXTRACT(EPOCH FROM t.expires_at) AS expires_epoch,
              (SELECT bool_and(a.enabled AND a.status = 'active') FROM org_app a WHERE a.id = t.app_id) AS app_live
         FROM auth_token t LEFT JOIN org_member m ON m.id = t.member_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > now())`,
      [sha256(token)],
    );
    const row = r.rows[0] as {
      user_id: string; member_id: string | null; email: string | null;
      member_state: string | null; token_scopes: unknown; member_scopes: unknown; projects: unknown;
      client_id: string | null; resource: string | null; app_id: string | null; expires_epoch: string | null;
      app_live: boolean | null;
    } | undefined;
    if (!row) return null;
    // JSONB scopes/projects 는 런타임에 무엇이든 될 수 있다(마이그레이션 버그·손상) → 보안 경계에서
    //  .includes() 가 깨지지 않게 '문자열 배열'로 강제 정규화(비배열/비문자 원소는 버린다).
    const strArr = (v: unknown, fb: string[]): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;
    // 유효 권한 = intersection(토큰 scope, 멤버 scope). 멤버가 '라이브 상한' — 비활성/삭제면 거부.
    const scopes = computeEffectiveScopes({
      memberId: row.member_id,
      memberState: row.member_state,
      tokenScopes: strArr(row.token_scopes, []),
      memberScopes: strArr(row.member_scopes, []),
      appId: row.app_id,
      appLive: row.app_live,
    });
    if (scopes === null) return null; // 멤버 비활성/삭제 → 토큰 무효(→ 401)
    // last_used 갱신은 베스트에포트(인증 핫패스 — 실패 무시).
    itemsPool.query(`UPDATE auth_token SET last_used_at=now() WHERE token_hash=$1`, [sha256(token)]).catch(() => {});
    return {
      userId: row.user_id, email: row.email ?? "", scopes, projects: strArr(row.projects, ["*"]),
      clientId: row.client_id ?? null,
      resource: row.resource ?? null,
      appId: row.app_id ?? null,
      // numeric → JS number. NaN/음수는 만료없음으로 오독되면 안 되므로 유한수만 통과시킨다.
      expiresAt: row.expires_epoch == null ? null : (Number.isFinite(Number(row.expires_epoch)) ? Math.floor(Number(row.expires_epoch)) : null),
    };
  } catch {
    return null;
  }
}

// 멤버의 활성 install 토큰 존재 여부(웹 '구성원' 상태 칩용).
export async function memberHasActiveToken(memberId: string): Promise<boolean> {
  if (!process.env.ITEMS_DATABASE_URL) return false;
  try {
    const r = await itemsPool.query(
      `SELECT 1 FROM auth_token WHERE member_id=$1 AND revoked_at IS NULL LIMIT 1`, [memberId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

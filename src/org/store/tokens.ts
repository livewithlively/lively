// auth_token — DB 기반 bearer 토큰(발급·조회·회수) + 유효 권한 계산 + 인증 핫패스 verifyDbToken.
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리. mintToken 의 PoolClient 오버로드(#880) 시그니처 불변.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { isScope, DANGEROUS_SCOPES, SAFE_SCOPES } from "../../auth/scopes.js";
import { memberGrants, principalGrants, type Grants } from "../../auth/permissions.js";
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
  // 멤버 추종(#2174) — scope 를 박제하지 않고 멤버 라이브 scope 를 그대로 유효권한으로 쓴다. **우리가 굽는
  //  세션·박스 토큰에만** 켠다(computeEffectiveScopes 주석). scopes 인자는 그래도 넘겨 둔다 — 감사/토큰탭이
  //  '발급 당시 무엇이었나'를 읽고, 이 플래그를 끄면 그 값이 그대로 상한으로 돌아온다.
  followMemberScopes?: boolean;
  /**
   * 비위험 권한 추종(#5712) — 위험 scope(admin · runtime)를 뺀 나머지는 박제하지 않고 **구성원의 지금 권한**을 따른다. 위험 scope 는
   *  발급 때 실은 것(scopes 인자)만, 구성원이 지금도 갖고 있을 때 유효하다. **사람이 자기 컴퓨터를 연결해 받는 로그인 토큰**에 켠다
   *  (lively login · 데스크톱 앱 = device-cli · 설치 탭 본인 발급 · 관리자가 scope 를 고르지 않고 구워 준 토큰). 규칙 본문은
   *  computeEffectiveScopes. memberId 와 함께만 — 없으면 던진다(따를 구성원이 없다).
   *  ★ 칸(auth_token.follow_safe_scopes)이 아직 없는 롤 창(새 게이트웨이가 먼저 · 마이그레이션은 끝에)에는 **이 표시 없이** 굽는다 —
   *   로그인이 «없는 칸» 으로 깨지지 않게. 그 토큰은 종전처럼 발급 때 권한에 묶이고(닫힌 쪽), 칸이 생기는 순간의 백필(schema/core.ts)이
   *   라벨로 찾아 표시를 단다. 실제로 달았는지는 응답의 followSafeScopes 가 말한다.
   */
  followSafeScopes?: boolean;
  /**
   * #4891 — 이 앱 토큰의 주체를 앱 서버 급으로(검증이 LivelyUser.appServer 를 켠다): 능력 API · /mcp 에서만 통하고(auth/http-auth) 무조건
   *  통과 도구(EXEMPT)가 꺼진다(apps/principal). appId 와 함께만 — 없으면 던진다.
   */
  appServerPrincipal?: boolean;
  /**
   * 이 토큰으로 부를 수 있는 도구 상한(정확한 이름) — 앱 AI 작업 토큰이 앱의 작업별 허용 목록(ai.tools)을 싣는다. 앱 동의와 둘 다 통과해야 한다
   *  (apps/principal.appToolAllowed). 생략 · null = 상한 없음(종전). appId 와 함께만 — 없으면 던진다(앱 동의 판정을 타지 않는 토큰에 걸면 뜻이 없다).
   *  ★ 칸(auth_token.tool_ceiling)은 상한이 있을 때만 적는다 — 롤 창(새 게이트웨이가 먼저 · 마이그레이션은 끝에)에 다른 토큰의 발급이 «없는 칸» 으로
   *   깨지지 않게. 상한을 실은 발급은 그때 실패한다(작업이 돌지 않는다 — 닫힌 쪽).
   */
  toolCeiling?: readonly string[] | null;
}, actor?: string, source?: string, client?: pg.PoolClient): Promise<{ token: string; tokenHash: string; expiresAt: Date | null; followSafeScopes: boolean }> {
  if (input.appServerPrincipal === true && !input.appId) throw new Error("앱 서버 급 토큰은 앱 토큰(appId)이어야 한다");
  if (input.toolCeiling != null && !input.appId) throw new Error("도구 상한은 앱 토큰(appId)에만 건다");
  if (input.followSafeScopes === true && !input.memberId) throw new Error("비위험 권한 추종은 구성원 토큰(memberId)에만 건다");
  const exec = client ?? itemsPool;
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  const ttl = input.expiresInSec != null && Number.isFinite(input.expiresInSec) && input.expiresInSec > 0
    ? Math.floor(input.expiresInSec) : null;
  // 만료는 DB now() 기준으로 계산한다 — 검증(verifyDbToken)도 DB now() 라 시계가 하나로 유지된다.
  const ceiling = input.toolCeiling != null ? JSON.stringify([...input.toolCeiling]) : null;
  //  follow_safe_scopes 칸도 tool_ceiling 처럼 **켤 때만** 적는다(롤 창에 다른 토큰의 발급이 «없는 칸» 으로 깨지지 않게).
  const insert = (withFollowSafe: boolean) => exec.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by,
                            client_id, resource, app_id, expires_at, follow_member_scopes, app_server_principal${ceiling != null ? ", tool_ceiling" : ""}${withFollowSafe ? ", follow_safe_scopes" : ""})
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$11,
              now() + ($10::int * interval '1 second'), $12, $13${ceiling != null ? ", $14::jsonb" : ""}${withFollowSafe ? ", true" : ""})
     RETURNING expires_at`,
    [tokenHash, input.userId, JSON.stringify(input.scopes),
     JSON.stringify(input.projects ?? ["*"]), input.label ?? null, input.memberId ?? null, actor ?? null,
     input.clientId ?? null, input.resource ?? null, ttl == null ? null : String(ttl), input.appId ?? null,
     input.followMemberScopes === true, input.appServerPrincipal === true, ...(ceiling != null ? [ceiling] : [])],
  );
  let followSafe = input.followSafeScopes === true;
  let r: pg.QueryResult;
  if (!followSafe) {
    r = await insert(false);
  } else {
    //  칸이 아직 없으면(42703 — 롤 창) 표시 없이 다시 굽는다. 트랜잭션 안(client)에서는 실패한 문장이 트랜잭션 전체를 못 쓰게 만들므로
    //   SAVEPOINT 로 그 문장만 되돌린다(디바이스 로그인은 consume 과 발급이 한 트랜잭션이다 — #880).
    const SP = "mint_follow_safe";
    if (client) await client.query(`SAVEPOINT ${SP}`);
    try {
      r = await insert(true);
      if (client) await client.query(`RELEASE SAVEPOINT ${SP}`);
    } catch (e) {
      //  없는 칸이 **이 칸**일 때만 물러선다 — 다른 칸(tool_ceiling 등)이 없어서 난 42703 을 이 칸 탓으로 읽지 않는다.
      const err = e as { code?: string; message?: string };
      if (err?.code !== "42703" || !/follow_safe_scopes/.test(String(err.message ?? ""))) throw e;
      if (client) await client.query(`ROLLBACK TO SAVEPOINT ${SP}`);
      followSafe = false;
      r = await insert(false);
    }
  }
  await audit("auth_token", input.userId, "mint",
    null, { userId: input.userId, scopes: input.scopes, label: input.label, memberId: input.memberId,
            clientId: input.clientId ?? null, resource: input.resource ?? null,
            followMemberScopes: input.followMemberScopes === true,
            ...(input.followSafeScopes === true ? { followSafeScopes: followSafe } : {}),
            ...(input.toolCeiling != null ? { toolCeiling: [...input.toolCeiling] } : {}) }, actor, source, client);
  const expiresAt = (r.rows[0] as { expires_at: string | null } | undefined)?.expires_at ?? null;
  return { token, tokenHash, expiresAt: expiresAt ? new Date(expiresAt) : null, followSafeScopes: followSafe };
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
  /** 만료 시각(없으면 null = 만료 없음). 세션 훅 토큰은 null 로 굽고, 세션이 내려가면 expireTokenSoon 이 유예 뒤로 당긴다(#5611). */
  expires_at: string | null;
  /**
   * 이 토큰이 구성원의 지금 권한을 따르나 — 'all' = 전부(세션 · 박스 토큰 #2174) · 'safe' = 위험 scope 를 뺀 나머지(로그인 토큰 #5712 —
   *  위험 scope 는 scopes 에 든 것만) · null = 따르지 않음(scopes 가 상한). 따르는 토큰의 scopes 는 «발급 때 무엇이었나» 기록이다.
   */
  follows_member: "all" | "safe" | null;
}

export async function listTokens(): Promise<TokenMeta[]> {
  //  follow_safe_scopes 는 칸 이름으로 고르지 않는다(verifyDbToken 의 tool_ceiling 과 같은 까닭 — 롤 창에 목록이 «없는 칸» 으로 깨지지 않게).
  const r = await itemsPool.query(
    `SELECT token_hash, user_id, scopes, label, member_id, created_at, last_used_at, revoked_at, expires_at,
            CASE WHEN follow_member_scopes THEN 'all'
                 WHEN (to_jsonb(auth_token) -> 'follow_safe_scopes') = 'true'::jsonb THEN 'safe' END AS follows_member
       FROM auth_token ORDER BY created_at DESC`,
  );
  return r.rows as TokenMeta[];
}

// 회수 결과(#2646) — **셋을 가른다**. 사람이 그 뒤에 할 행동이 각각 다르기 때문이다:
//   revoked          → 끝. 이번 호출이 죽였다.
//   already-revoked  → 끝. 다만 내가 지운 게 아니다(멱등 성공).
//   not-found        → **아직 안 끝났다.** 올바른 핸들을 다시 찾아 다시 회수해야 한다.
//  뒤의 둘을 한 값으로 뭉개면 마지막 줄이 사라진다 — 그게 정확히 아래 사고의 모양이었다.
export type RevokeOutcome = "revoked" | "already-revoked" | "not-found";

// client 를 넘기면 그 트랜잭션에서 UPDATE+audit 을 실행한다 — mintToken 과 대칭(#880 의 이유가 그대로 적용된다).
//  회수와 교체가 갈리면 '구 토큰은 죽었는데 새 토큰은 안 붙은' 상태가 남는다(#2161 rotateNodeToken).
//
// ★ 갱신 건수를 본다(#2646). 종전엔 `Promise<void>` 로 rowCount 를 버렸고, 그래서 **0건 갱신도 성공**이었다.
//  실측(2026-09-04 셀프호스트): 회수 호출이 {ok:true} 를 돌려줬는데 그 토큰은 살아 있었다(같은 토큰으로 200).
//  자격증명 회수는 「즉시 무효화한다」는 약속을 믿고 자리를 뜨는 동작이라, 틀렸을 때 알아차릴 계기가 없다.
//  그리고 감사는 **실제로 지운 경우에만** 남긴다 — 안 지웠는데 'revoke' 로 남으면 나중에 사고를 조사할 때
//  「그때 분명히 회수했다」는 거짓 근거가 로그 쪽에 서 버린다(delegate-failure-brakes ★② 의 자격증명판).
export async function revokeToken(tokenHash: string, actor?: string, source?: string, client?: pg.PoolClient): Promise<RevokeOutcome> {
  const exec = client ?? itemsPool;
  const r = await exec.query(
    `UPDATE auth_token SET revoked_at = now() WHERE token_hash=$1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  if ((r.rowCount ?? 0) > 0) {
    await audit("auth_token", tokenHash, "revoke", null, null, actor, source, client); // 전체 해시 기록(상관추적용 — 해시는 비밀 아님)
    return "revoked";
  }
  // 0건 — '이미 회수됨'인지 '그런 토큰 없음'인지는 여기서만 갈 수 있다(UPDATE 술어가 둘을 같이 떨군다).
  const e = await exec.query(`SELECT 1 FROM auth_token WHERE token_hash=$1`, [tokenHash]);
  return (e.rowCount ?? 0) > 0 ? "already-revoked" : "not-found";
}

// 유예 뒤에 죽게 한다(#5611) — 즉시 회수(revokeToken)와 달리 만료 시각을 **now() + inSec** 로 당긴다.
//  왜: 세션이 내려갈 때 뜨는 SessionEnd 훅(session-log-capture-end)이 그 세션의 훅 토큰으로 마지막 답을 올린다.
//   종전처럼 kill 직후 회수하면 훅 목록 조회부터 401 이라 아무것도 안 돈다(실측 2026-11-20 매니지드 — 보관 뒤 중앙 기록 0바이트 그대로).
//  만료 판정은 verifyDbToken 이 DB now() 로 하므로 게이트웨이가 재시작해도 이 약속은 지켜진다(타이머가 아니다).
//  ★ 수명을 **줄이는 쪽으로만** 움직인다 — 이미 그보다 일찍 죽게 돼 있거나 회수된 토큰은 건드리지 않는다(0건 = false).
export async function expireTokenSoon(tokenHash: string, inSec: number, actor?: string, source?: string): Promise<boolean> {
  const sec = Number.isFinite(inSec) && inSec > 0 ? Math.floor(inSec) : 0;
  const r = await itemsPool.query(
    `UPDATE auth_token SET expires_at = now() + ($2::int * interval '1 second')
      WHERE token_hash=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now() + ($2::int * interval '1 second'))
      RETURNING expires_at`,
    [tokenHash, String(sec)],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await audit("auth_token", tokenHash, "expire", null, { expires_at: (r.rows[0] as { expires_at: unknown }).expires_at }, actor, source);
  return true;
}

// ── 회수 핸들(#2646) ──────────────────────────────────────────────────────────
// 발급 응답의 `tokenHash` 와 회수 입력의 `tokenHash` 는 **이름이 같으면 값도 호환돼야 한다.** 종전엔
//  발급이 12자로 잘라 주고 회수가 64자 exact match 라, 발급이 준 값을 그대로 넣는 가장 자연스러운 사용이
//  정확히 안 되는 조합이었다 — 그리고 위 revokeToken 이 0건을 성공으로 답했으니 그 실패가 성공으로 보였다.
// 해시는 비밀이 아니다(tokens/node 전반의 관례) — 그래서 발급이 전체 해시를 주고, 회수는 앞자리도 받는다.
//  다만 **유일할 때만** 회수한다: 앞자리가 둘 이상에 걸리면 아무거나 죽이면 안 된다(엉뚱한 사람의 접속이 끊긴다).
export const TOKEN_HASH_LEN = 64;
// 최소 앞자리 길이 — 짧을수록 남의 토큰을 긁을 위험이 커진다. 12 는 종전 발급 응답이 주던 길이이기도 해서,
//  이미 사람 손에 나간 핸들이 그대로 통한다.
export const MIN_HANDLE_LEN = 12;

export type TokenHandle =
  | { kind: "exact"; tokenHash: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "invalid"; reason: "empty" | "not-hex" | "too-short" | "too-long" };

/** 핸들의 형식 판정(순수 — 표 고정 테스트 대상). DB 를 안 본다: 여기서 갈리는 건 '무엇으로 찾을까'까지다. */
export function classifyTokenHandle(raw: string): TokenHandle {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return { kind: "invalid", reason: "empty" };
  // hex 만 통과시킨다 — 아래 prefix 조회가 LIKE 라, `%`·`_` 가 섞이면 와일드카드가 된다(무관한 토큰이 걸린다).
  if (!/^[0-9a-f]+$/.test(s)) return { kind: "invalid", reason: "not-hex" };
  if (s.length > TOKEN_HASH_LEN) return { kind: "invalid", reason: "too-long" };
  if (s.length === TOKEN_HASH_LEN) return { kind: "exact", tokenHash: s };
  if (s.length < MIN_HANDLE_LEN) return { kind: "invalid", reason: "too-short" };
  return { kind: "prefix", prefix: s };
}

export type ResolvedHandle =
  | { ok: true; tokenHash: string }
  | { ok: false; reason: "empty" | "not-hex" | "too-short" | "too-long" | "not-found" | "ambiguous"; matches?: number };

/** 핸들 → 회수 대상 해시. 앞자리는 **정확히 하나**일 때만 풀린다(둘 이상이면 회수하지 않고 모호를 답한다). */
export async function resolveTokenHandle(raw: string): Promise<ResolvedHandle> {
  const h = classifyTokenHandle(raw);
  if (h.kind === "invalid") return { ok: false, reason: h.reason };
  // 전체 해시는 DB 를 안 보고 그대로 넘긴다 — '없음' 판정은 revokeToken 이 내린다(왕복 1회 절약, 판정은 한 곳).
  if (h.kind === "exact") return { ok: true, tokenHash: h.tokenHash };
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n, min(token_hash) AS hash FROM auth_token WHERE token_hash LIKE $1 || '%'`,
    [h.prefix],
  );
  const row = r.rows[0] as { n: number; hash: string | null } | undefined;
  const n = row?.n ?? 0;
  if (n === 0) return { ok: false, reason: "not-found" };
  if (n > 1) return { ok: false, reason: "ambiguous", matches: n };
  return { ok: true, tokenHash: row?.hash as string };
}

// ── 소스 한정 DB scope 'db:<source>' — 토큰 발급 검증(org_token_mint)과 아래 유효 권한 계산만 쓴다.
//  SCOPES(auth/scopes.ts)에 넣지 않는 이유: 그 배열은 Capability.scope union·mw() 게이트·멤버 scope 검증의
//  원천이라, 넣으면 capability 가 'db:x' 를 요구 scope 로 쓸 수 있게 되고 멤버에게도 부여 가능해진다.
//  판정은 context.canAccessDbSource 가 한다('db' = 전 소스, 'db:<source>' = 그 소스만).
//
// 이름 규칙은 org_db_source_upsert 의 name 검증(http/rest-util slug)과 같아야 한다 — 다르면 등록은 되는데
//  그 소스로 좁힌 토큰을 못 만들거나, 등록될 수 없는 이름이 토큰에 실린다. org → http import 가 금지라
//  (scripts/check-imports.mjs) 정규식을 공유하지 못하고 복제했다. 일치는 token-scope.test 의 대조 표가 지킨다.
const DB_SOURCE_NAME = /^[A-Za-z0-9가-힣_-]+$/;
const DB_SOURCE_NAME_MAX = 100;
const DB_SOURCE_SCOPE_PREFIX = "db:";

/**
 * 토큰이 DB 를 소스 몇 개로만 연다면 그 소스 이름들(아니면 null). 'db' 가 함께 있으면 전 소스라 상한이 없다.
 *  옛 scope 주체는 canAccessDbSource 가 scopes 로 이미 좁히지만, 역할을 받은 구성원(#5799)의 주체는 'db:<source>' 가
 *  새 권한 'db' 로 번역돼(legacyScopesToGrants) 소스 한정이 사라진다 — 그래서 이 목록을 주체에 따로 싣고
 *  dbSourceAllowed·visibleDbSources 가 지정 판정 앞에 건다. 비우면 좁힌 서비스 토큰이 그 사람이 지정된 모든 소스를 연다.
 */
export function dbSourceCeilingOf(tokenScopes: readonly string[]): string[] | null {
  if (tokenScopes.includes("db")) return null;
  //  'db:' 접두가 하나라도 있으면 상한을 건다 — 이름 규칙에 안 맞는 손상 행은 빈 상한(아무 소스도 못 연다). 번역(legacyScopesToGrants)은
  //   접두만 보고 'db' 권한을 주므로, 여기서 null 로 두면 그런 행이 지정된 전 소스를 연다.
  if (!tokenScopes.some((s) => s.startsWith(DB_SOURCE_SCOPE_PREFIX))) return null;
  return tokenScopes.filter(isDbSourceScope).map((s) => s.slice(DB_SOURCE_SCOPE_PREFIX.length));
}

export function isDbSourceScope(s: unknown): s is string {
  if (typeof s !== "string" || !s.startsWith(DB_SOURCE_SCOPE_PREFIX)) return false;
  const name = s.slice(DB_SOURCE_SCOPE_PREFIX.length);
  return name.length <= DB_SOURCE_NAME_MAX && DB_SOURCE_NAME.test(name);
}

// 발급 입력의 길이 상한(org_token_mint)이 이 값을 따른다.
export const DB_SOURCE_SCOPE_MAX = DB_SOURCE_SCOPE_PREFIX.length + DB_SOURCE_NAME_MAX;

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
  followMemberScopes?: boolean;   // 세션·박스 토큰(우리가 굽는 것) — scope 를 박제하지 않고 멤버를 따른다.
  followSafeScopes?: boolean;     // 로그인 토큰(#5712) — 위험 scope 를 뺀 나머지만 멤버를 따른다. 위험 scope 는 토큰에 실린 것만.
}): string[] | null {
  // B4: 허용 scope 만(JSONB 손상·마이그레이션·위조로 admin/runtime 섞여 들어와도 여기서 떨군다).
  //  소스 한정 'db:<source>' 도 허용 — 이걸 떨구면 소스 하나로 좁힌 토큰을 만들 수 없어 'db' 전체를 줘야 한다.
  const tokenScopes = opts.tokenScopes.filter((s) => isScope(s) || isDbSourceScope(s));
  if (!opts.memberId) {
    if (opts.appId) return opts.appLive === true ? tokenScopes : null;
    return tokenScopes;
  }
  if (opts.memberState !== "active") return null;
  const memberScopes = opts.memberScopes.filter(isScope);
  // 추종 토큰 — 발급 시점 박제 없이 **멤버 라이브 scope 그대로**. 멤버가 상한이라는 규칙은 그대로고(여기서도
  //  멤버에 없는 scope 는 나올 수 없다), 달라지는 건 '승격이 반영되는가' 하나다.
  //  왜 필요한가: 종전엔 강등만 즉시 반영되고 **승격은 토큰 재발급을 요구**하는 비대칭이었다. 그런데 세션이
  //   쓰는 토큰은 사람이 직접 들고 다니는 것이 아니라 **박스 홈(~/.lively/token)에 심긴 것**이라, 관리자가
  //   권한을 올려도 그 파일이 다시 심길 때까지 세션은 옛 권한이었다. 재프로비저닝이 그 파일까지 닿지 못하면
  //   (2026-08-28 실측 — 격리 박스에서 토큰만 안 갱신됨) 올린 권한이 영영 도달하지 않는다.
  //  적용 범위는 발급부가 정한다 — 우리가 굽는 세션·박스 토큰만. OAuth 발급분은 **어느 추종도 켜지 않는다**:
  //   그건 사람이 동의 화면에서 본 범위가 계약이라, 나중에 조용히 넓어지면 그 동의가 거짓이 된다.
  if (opts.followMemberScopes) return memberScopes;
  // 비위험 권한 추종(#5712) — 사람이 자기 컴퓨터를 연결해 받은 로그인 토큰(lively login · 데스크톱 앱 · 설치 탭 본인 발급).
  //  위험 scope 를 뺀 나머지는 **멤버 라이브 scope 그대로**, 위험 scope(admin · runtime)는 **토큰에 실린 것만**(멤버가 지금도 가질 때).
  //  왜 필요한가(2026-11-23): 관리자가 구성원 권한을 바꿔도 그 사람 컴퓨터의 토큰은 발급 때 권한에 묶여 있어, 올린 권한을 쓰려면
  //   `lively login` 을 다시 해야 했다. 세션 시작 훅은 키트를 새로 받지만 토큰은 새로 받지 않는다 — 사람은 왜 안 되는지 알 길이 없다.
  //   구성원 편집 화면은 «변경 시 활성 토큰에도 즉시 반영» 이라고 말하는데, 그 말이 내릴 때만 참이었다.
  //  왜 위험 scope 는 따르지 않나: 연결 승인 화면의 «AI 에게 관리자 기능 허용» 은 기본이 끔이고 켤 때 비밀번호를 다시 확인한다.
  //   그 답(끔)을 한 사람의 토큰이 나중에 관리자로 승격됐다고 저절로 관리자 기능을 얻으면, 그 화면에서 한 답이 거짓이 된다.
  //   승인 화면은 비위험 권한의 목록을 보여 주지 않는다(«이 컴퓨터를 연결할까요?») — 그래서 그쪽은 따라가도 본 것과 어긋나지 않는다.
  if (opts.followSafeScopes) {
    const issued = new Set(tokenScopes);
    return memberScopes.filter((s) => !DANGEROUS_SCOPES.has(s) || issued.has(s));
  }
  const allowed = new Set<string>(memberScopes);
  // 멤버는 'db:<source>' 를 가질 수 없다(org_member_upsert 가 거부) — 멤버 'db' 가 모든 'db:<source>' 의 상한이다.
  return tokenScopes.filter((s) => allowed.has(s) || (isDbSourceScope(s) && allowed.has("db")));
}

// verifyDbToken 이 돌려주는 토큰 신원 — LivelyUser 원재료 + OAuth 발급분의 바인딩 3종(#1473 T2).
//  clientId/resource/expiresAt 은 사람이 발급한 장기 토큰이면 전부 null(종전 동작 그대로).
export interface DbTokenIdentity {
  userId: string;
  email: string;
  scopes: string[];
  /** 새 권한(#5799) — 역할을 받은 구성원의 토큰만 싣는다. LivelyUser.grants 로 그대로 간다(bearer.ts). */
  grants?: Grants;
  projects: string[];
  clientId: string | null;   // 발급 OAuth 클라이언트(oauth_client.client_id). 감사·읽기전용 프로필(T3)의 축.
  resource: string | null;   // RFC 8707 대상(audience) — 자원서버가 '내 앞으로 발급된 토큰인가'를 이걸로 판정.
  expiresAt: number | null;  // Unix 초. null = 만료 없음.
  appId: string | null;      // 앱 세션 토큰이면 그 앱 id(#1780). null = 일반 토큰. requireAppTool 이 도구를 축소한다.
  /** #4891 — 앱 서버 급 주체(auth_token.app_server_principal). 켜진 토큰만 싣는다 — LivelyUser.appServer 로 그대로 간다(bearer.ts). */
  appServer?: true;
  /** 도구 상한(auth_token.tool_ceiling). 걸린 토큰만 싣는다 — LivelyUser.toolCeiling 으로 그대로 간다(bearer.ts). */
  toolCeiling?: string[];
  /**
   * 이 토큰이 구성원의 비위험 권한을 따르는 토큰인가(#5712) — 그런 토큰만 싣는다. LivelyUser.followsMemberSafe 로 그대로 간다(bearer.ts).
   *  판정은 **그때의 권한 견주기가 아니라 토큰의 성질**이다: 추종 표시(follow_member_scopes · follow_safe_scopes)가 켜졌거나, 발급 상한에
   *  비위험 scope 가 전부 들어 있다(그 토큰은 교집합만으로 이미 구성원의 비위험 권한을 그대로 따른다 — 컨트롤플레인이 굽는 꼴).
   *  관리자가 scope 를 골라 구운 토큰은 그때 구성원 권한과 우연히 같았더라도 여기 들지 않는다. OAuth 발급분 · 앱 토큰도 들지 않는다.
   */
  followsMemberSafe?: true;
  /** 소스 한정 DB scope(db:<source>)가 실린 토큰의 소스 목록 — LivelyUser.dbSourceCeiling 으로 간다(dbSourceCeilingOf). */
  dbSourceCeiling?: string[];
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
              t.follow_member_scopes AS follow_member_scopes,
              t.client_id, t.resource, t.app_id, t.app_server_principal, EXTRACT(EPOCH FROM t.expires_at) AS expires_epoch,
              -- 도구 상한은 칸 이름으로 고르지 않고 행에서 꺼낸다 — 롤 창(새 게이트웨이가 먼저 · 마이그레이션은 끝에)에 칸이 아직 없어도
              --  이 인증 쿼리가 «없는 칸» 으로 깨지지 않게(칸이 없으면 NULL — 그 칸을 단 토큰도 없다). 칸이 모든 배포에 생긴 뒤에는
              --  t.tool_ceiling 으로 바꿔도 된다(롤 창이 지난 다음 정리 때 — 인증 핫패스에서 행 전체를 JSON 으로 만들지 않게).
              to_jsonb(t) -> 'tool_ceiling' AS tool_ceiling,
              -- 비위험 권한 추종(#5712)도 같은 까닭으로 행에서 꺼낸다(칸이 없으면 NULL = 따르지 않음 — 종전 판정 그대로).
              to_jsonb(t) -> 'follow_safe_scopes' AS follow_safe_scopes,
              -- 구성원의 역할 · 개별 권한(#5799)도 같은 까닭으로 행에서 꺼낸다(칸이 없거나 구성원이 없으면 NULL = 옛 구성원).
              to_jsonb(m) -> 'role' AS member_role, to_jsonb(m) -> 'grants' AS member_grants,
              (SELECT bool_and(a.enabled AND a.status = 'active') FROM org_app a WHERE a.id = t.app_id) AS app_live
         FROM auth_token t LEFT JOIN org_member m ON m.id = t.member_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > now())`,
      [sha256(token)],
    );
    const row = r.rows[0] as {
      user_id: string; member_id: string | null; email: string | null;
      member_state: string | null; token_scopes: unknown; member_scopes: unknown; projects: unknown;
      follow_member_scopes: boolean | null; follow_safe_scopes: unknown; member_role: unknown; member_grants: unknown;
      client_id: string | null; resource: string | null; app_id: string | null; expires_epoch: string | null;
      app_live: boolean | null; app_server_principal: boolean | null; tool_ceiling: unknown;
    } | undefined;
    if (!row) return null;
    // JSONB scopes/projects 는 런타임에 무엇이든 될 수 있다(마이그레이션 버그·손상) → 보안 경계에서
    //  .includes() 가 깨지지 않게 '문자열 배열'로 강제 정규화(비배열/비문자 원소는 버린다).
    const strArr = (v: unknown, fb: string[]): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;
    // 유효 권한 = intersection(토큰 scope, 멤버 scope). 멤버가 '라이브 상한' — 비활성/삭제면 거부.
    const tokenScopes = strArr(row.token_scopes, []);
    //  OAuth 발급분(client_id)과 앱 토큰(app_id)에는 켜져 있어도 듣지 않는다 — 그 둘의 범위는 동의 화면 · 앱 동의가 정한다
    //   (발급부가 켜지 않지만, 칸이 잘못 켜진 행이 범위를 넓히지 못하게 여기서도 막는다).
    const followSafeScopes = row.follow_safe_scopes === true && !row.client_id && !row.app_id;
    const scopes = computeEffectiveScopes({
      memberId: row.member_id,
      memberState: row.member_state,
      tokenScopes,
      memberScopes: strArr(row.member_scopes, []),
      appId: row.app_id,
      appLive: row.app_live,
      followMemberScopes: row.follow_member_scopes === true,
      followSafeScopes,
    });
    if (scopes === null) return null; // 멤버 비활성/삭제 → 토큰 무효(→ 401)
    //  역할을 받은 구성원의 토큰이면 새 권한을 싣는다(#5799) = 구성원의 지금 권한 ∩ 이 토큰에 발급된 상한(같은 추종 규칙 — principalGrants).
    //   옛 구성원 · 구성원 없는 토큰은 싣지 않는다 — 위 scopes 가 종전 그대로 판정한다.
    const mg = row.member_id ? memberGrants({ role: row.member_role, grants: row.member_grants }) : undefined;
    const grants = mg === undefined ? undefined : principalGrants(mg,
      row.follow_member_scopes === true ? { follow: "all" } : { follow: followSafeScopes ? "safe" : "none", scopes: tokenScopes });
    //  #4891 — 앱 서버 급 표시는 앱 토큰에만 뜻이 있다. 앱 없이 켜져 있으면(있어선 안 되는 행) 받지 않는다 — 앱 도구 게이트가 안 걸린다.
    const appServer = row.app_server_principal === true;
    if (appServer && !row.app_id) return null;
    //  도구 상한 — 앱 토큰에만 뜻이 있다(앱 없이 걸려 있으면 받지 않는다). 글 배열이 아니면(손상) 빈 상한 — 아무 도구도 허락하지 않는다(닫힌 쪽).
    //   칸의 JSON null 은 SQL NULL 과 구분되지 않아(to_jsonb) «상한 없음» 이다 — 쓰는 쪽(mintToken)은 배열만 적는다.
    const ceilingRaw = row.tool_ceiling;
    const toolCeiling = ceilingRaw == null ? null
      : Array.isArray(ceilingRaw) && ceilingRaw.every((x) => typeof x === "string") ? (ceilingRaw as string[]) : [];
    if (toolCeiling != null && !row.app_id) return null;
    //  구성원의 비위험 권한을 따르는 토큰인가(DbTokenIdentity.followsMemberSafe 머리말) — 구성원 토큰이고 OAuth · 앱 토큰이 아닐 때만.
    const held = new Set(tokenScopes);
    //  추종 토큰은 비위험 scope 를 구성원에게서 가져오고 박제를 보지 않으므로(computeEffectiveScopes) 소스 상한도 걸지 않는다 — 옛 주체와 역할 주체의 판정을 맞춘다.
    const dbSourceCeiling = row.follow_member_scopes === true || followSafeScopes ? null : dbSourceCeilingOf(tokenScopes);
    const followsMemberSafe = !!row.member_id && !row.client_id && !row.app_id
      && (row.follow_member_scopes === true || followSafeScopes || SAFE_SCOPES.every((s) => held.has(s)));
    // last_used 갱신은 베스트에포트(인증 핫패스 — 실패 무시).
    itemsPool.query(`UPDATE auth_token SET last_used_at=now() WHERE token_hash=$1`, [sha256(token)]).catch(() => {});
    return {
      userId: row.user_id, email: row.email ?? "", scopes, projects: strArr(row.projects, ["*"]),
      ...(grants ? { grants } : {}),
      ...(dbSourceCeiling ? { dbSourceCeiling } : {}),
      clientId: row.client_id ?? null,
      resource: row.resource ?? null,
      appId: row.app_id ?? null,
      ...(appServer ? { appServer: true as const } : {}),
      ...(toolCeiling != null ? { toolCeiling } : {}),
      ...(followsMemberSafe ? { followsMemberSafe: true as const } : {}),
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

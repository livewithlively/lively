// app_launch_code — 앱 주소 로그인의 일회용 코드(#4480 v2-1) 저장 계층. 시험: app-launch-store.test.ts(가짜 풀).
//
//  흐름: 라이블리 화면(이미 로그인한 구성원)이 POST /api/ui/apps/:id/launch 로 코드를 받아 앱 주소에 붙이고
//   (`https://<앱 주소>/_lively/auth?code=…`), 앱 주소 앞단(CP 라우터)이 그 코드를 POST /api/app-front/redeem 으로 바꿔
//   앱 주소 전용 쿠키를 만든다. 앞단은 라이블리 쿠키를 읽지 않는다 — 다른 도메인이라 애초에 오지도 않는다.
//  관례는 pending_session_mint(org/store/session-mint.ts)와 같다: 평문 코드는 한 번만 돌려주고 저장은 sha256 ·
//   TTL 60초(DB now() 기준) · 소비는 UPDATE 한 문장(동시 교환을 DB 가 막는다) · 지난 행은 게으른 청소 · 성공만 감사.
//  다른 점 — 코드가 **그 앱 주소 하나**에 묶이고(host), 받는 자리가 둘로 갈린다:
//   · embed(라이블리 안 iframe) — iframe 으로 열렸을 때만(Sec-Fetch-Dest: iframe). 최상위로 열면 거부 = 남의 코드를 링크로
//     밀어 넣어 «그 사람으로 로그인시키는» 로그인 위조를 막는다(frame-ancestors 가 그 응답의 쿠키까지 막지는 못한다).
//   · top(직접 접속) — 앞단이 심어 둔 상태 쿠키(state)와 코드의 state 가 같을 때만. 상태는 해시로만 둔다.
//   묶음이 안 맞으면 코드는 **소비되지 않는다**(60초 뒤 저절로 죽는다) — 남이 엉뚱한 자리로 가져가 봐야 아무것도 안 된다.
//  테넌트 범위: 일반 표다(신원 전역 표 IDENTITY_GLOBAL_TABLES 아님) — 발급(화면)과 교환(앞단) 둘 다 그 워크스페이스의
//   테넌트 헤더를 달고 오므로, 매니지드 RLS 가 남의 워크스페이스 코드를 아예 못 보게 한다.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool, type Db } from "../db/client.js";
import { audit, sha256 } from "../org/store/audit.js";
import type { AppVariant } from "./app-address.js";

export const APP_LAUNCH_TTL_MS = 60_000;
export type AppLaunchMode = "embed" | "top";
// 'lva_' + 24바이트 base64url(=32자) — 세션 브리지 'lvm_'·토큰 'lvk_' 와 같은 식별 관례.
const CODE_RE = /^lva_[A-Za-z0-9_-]{32}$/;
export const genAppLaunchCode = (): string => "lva_" + crypto.randomBytes(24).toString("base64url");
export const isAppLaunchCodeShape = (code: string): boolean => CODE_RE.test(code);
/** 상태값 꼴 — 앞단이 만드는 32바이트 base64url(43자). 화면이 주소창에서 옮겨 오므로 꼴을 다시 잰다. */
export const isLaunchStateShape = (s: string): boolean => /^[A-Za-z0-9_-]{32,128}$/.test(s);

export interface MintLaunchInput {
  memberId: string; appId: string; variant: AppVariant; host: string; mode: AppLaunchMode; state?: string | null;
}

/** 발급 — 평문 코드를 한 번 돌려준다(저장은 지문만). 권한 판정(구성원·앱·공개 범위)은 호출부(capability)가 끝낸 뒤다. */
export async function mintAppLaunchCode(i: MintLaunchInput, db: Db = itemsPool): Promise<{ code: string; expiresAt: Date }> {
  if (i.mode === "top" && !(i.state && isLaunchStateShape(i.state))) throw new Error("top 코드는 state 가 필요합니다");
  const code = genAppLaunchCode();
  const expiresAt = new Date(Date.now() + APP_LAUNCH_TTL_MS);
  await db.query(
    `INSERT INTO app_launch_code(code_hash, member_id, app_id, variant, host, mode, state_hash, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sha256(code), i.memberId, i.appId, i.variant, i.host, i.mode, i.mode === "top" ? sha256(String(i.state)) : null, expiresAt.toISOString()],
  );
  return { code, expiresAt };
}

export interface RedeemLaunchInput {
  code: string;
  /** 앞단이 해석한 앱 주소(소문자 호스트) — 코드가 묶인 주소와 같아야 한다 */
  host: string;
  /** 브라우저의 Sec-Fetch-Dest 값(앞단이 그대로 옮긴다) */
  dest: string;
  /** 앞단 상태 쿠키 값(없으면 빈 문자열) */
  state: string;
}
export interface RedeemedLaunch { memberId: string; appId: string; variant: AppVariant; mode: AppLaunchMode }

/**
 * 교환 — 묶음(주소·자리)이 맞을 때만 원자적으로 소비한다. 실패 사유는 가르지 않는다(무인증에 가까운 표면이라 존재 여부도 정보다).
 *  ⚠ 자리 묶음을 SQL 조건에 넣는 이유: 맞지 않는 교환 시도가 코드를 태워 버리면, 앞단을 거치지 않은 잡음이 진짜 사용자의
 *   코드를 먼저 소진시킬 수 있다. 조건이 안 맞으면 행은 그대로 두고 60초 만료에 맡긴다.
 */
export async function redeemAppLaunchCode(i: RedeemLaunchInput, db: Db = itemsPool): Promise<RedeemedLaunch | null> {
  const code = String(i.code ?? "");
  if (!isAppLaunchCodeShape(code)) return null;
  const host = String(i.host ?? "").trim().toLowerCase();
  if (!host || host.length > 253) return null;
  const dest = String(i.dest ?? "").trim().toLowerCase();
  const state = String(i.state ?? "");
  const stateHash = isLaunchStateShape(state) ? sha256(state) : "";
  try { await db.query(`DELETE FROM app_launch_code WHERE expires_at < now() - interval '1 hour'`); } catch { /* 청소 실패는 교환과 무관 */ }
  const r = await db.query(
    `UPDATE app_launch_code SET used_at=now()
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() AND host=$2
        AND ((mode='embed' AND $3='iframe') OR (mode='top' AND state_hash IS NOT NULL AND state_hash=$4))
      RETURNING member_id, app_id, variant, mode`,
    [sha256(code), host, dest, stateHash],
  );
  const row = r.rows[0] as { member_id: string; app_id: string; variant: string; mode: string } | undefined;
  if (!row) return null;
  // 발급↔교환 사이에 비활성이 된 사람 — 앱 주소 쿠키를 만들면 안 된다(코드는 이미 소비됐다 · 살려 둘 이유가 없다).
  const m = await db.query(`SELECT state, kind FROM org_member WHERE id=$1`, [row.member_id]);
  const mem = m.rows[0] as { state?: string; kind?: string } | undefined;
  if (mem?.state !== "active" || (mem.kind && mem.kind !== "human")) return null;
  // 감사 — 성공만(무인증에 가까운 표면이라 실패를 남기면 난사가 감사 표를 키운다 — session-mint 와 같은 판단).
  await audit("app_launch_code", row.member_id, "redeem", null,
    { member_id: row.member_id, app_id: row.app_id, variant: row.variant, mode: row.mode, host },
    row.member_id, "web", db as unknown as pg.PoolClient);
  return {
    memberId: row.member_id, appId: row.app_id,
    variant: row.variant === "draft" ? "draft" : "pub",
    mode: row.mode === "top" ? "top" : "embed",
  };
}

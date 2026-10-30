// 게이트웨이 → 앱 서버 동기 부르기 행(org_app_call) — 읽고 쓰기만 한다(#5053 앱 v2-42). 판정은 app-server-call-plan.ts, 흐름은 app-server-call.ts.
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다 — 검사 층의 claim 도 워크스페이스 주소(LIVELY_API_URL)로 와서 앞단이 그 테넌트를 붙인다.
//  상태를 바꾸는 쓰기는 전부 «지금 상태가 이것일 때만» 조건을 단다 — claim 이 두 번 와도(재전송 · 위조) 한 번만 넘어간다.
//  비밀은 백그라운드 작업과 같은 꼴(sha256 만 · app-jobs-store newJobSecret · jobSecretMatches)이다.
import { itemsPool } from "../db/client.js";
import { CALL_CLAIM_WINDOW_SEC, CALL_RUN_GRACE_SEC } from "./app-server-call-plan.js";
import { newJobSecret } from "./app-jobs-store.js";

export type AppCallStatus = "dispatched" | "running" | "done" | "failed";

export interface AppCallRow {
  id: number;
  app_id: string;
  /** 무엇으로 불렀나 — 'mcp_tool'(앱이 선언한 MCP 도구 · #5053). v2-12 app_call(앱 자체 주체)이 같은 표를 쓴다. */
  purpose: string;
  tool: string | null;
  requester: string;
  requester_name: string | null;
  variant: "pub" | "draft";
  alias: "cur" | "pub";
  function_name: string;
  level: "L0" | "L1";
  /** 부른 연결(토큰)의 권한 ∩ 그 사람의 앱 동의 — 돌기 신원의 권한 상한(그때의 동의 · 구성원 권한과 다시 교집합한다). */
  scopes: string[];
  timeout_s: number;
  status: AppCallStatus;
  call_hash: string | null;
  run_hash: string | null;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  bytes: number | null;
  created_at: Date;
  claimed_at: Date | null;
  ended_at: Date | null;
}

const COLS = `id, app_id, purpose, tool, requester, requester_name, variant, alias, function_name, level, scopes, timeout_s, status, call_hash, run_hash,
  status_code, error, duration_ms, bytes, created_at, claimed_at, ended_at`;

const norm = (r: Record<string, unknown> | undefined): AppCallRow | null =>
  r ? ({ ...r, id: Number(r.id), scopes: Array.isArray(r.scopes) ? (r.scopes as unknown[]).map(String) : [] } as unknown as AppCallRow) : null;

export interface NewAppCall {
  appId: string; purpose: string; tool: string | null; requester: string; requesterName: string | null; variant: "pub" | "draft"; alias: "cur" | "pub";
  functionName: string; level: "L0" | "L1"; scopes: string[]; timeoutS: number;
}

/** 부르기 한 건을 적는다(dispatched + 새 부르기 비밀). 비밀 값은 이 호출만 안다(돌려준다). */
export async function insertAppCall(c: NewAppCall): Promise<{ row: AppCallRow; secret: string }> {
  const s = newJobSecret();
  const r = await itemsPool.query(
    `INSERT INTO org_app_call(app_id, purpose, tool, requester, requester_name, variant, alias, function_name, level, scopes, timeout_s, call_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12) RETURNING ${COLS}`,
    [c.appId, c.purpose, c.tool, c.requester, c.requesterName, c.variant, c.alias, c.functionName, c.level, c.scopes, c.timeoutS, s.hash]);
  return { row: norm(r.rows[0] as Record<string, unknown>)!, secret: s.secret };
}

export async function getAppCall(id: number): Promise<AppCallRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_call WHERE id=$1`, [id]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/**
 * 시작(claim) — 부른 그 부르기이고 · 그 비밀이고 · 아직 시작 안 했고 · 부른 지 CALL_CLAIM_WINDOW_SEC 안일 때만 running 으로 넘기고 돌기 신원(run_hash)을 단다.
 *  못 넘기면 null — 까닭은 부르는 쪽이 줄을 다시 읽어 가른다(없음 · 비밀 틀림 · 이미 시작 · 끝남 · 늦음).
 */
export async function claimAppCall(id: number, callHash: string, runHash: string): Promise<AppCallRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_call SET status='running', claimed_at=now(), run_hash=$3
      WHERE id=$1 AND status='dispatched' AND call_hash=$2 AND created_at > now() - make_interval(secs => $4) RETURNING ${COLS}`,
    [id, callHash, runHash, CALL_CLAIM_WINDOW_SEC]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/** 끝 — 지금 상태가 열린(dispatched · running) 때만. 끝냈으면 그 줄(이미 끝났으면 null). */
export async function endAppCall(id: number, end: { status: "done" | "failed"; error?: string | null; statusCode?: number | null; durationMs?: number | null; bytes?: number | null }): Promise<AppCallRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_call SET status=$2, error=$3, status_code=$4, duration_ms=$5, bytes=$6, ended_at=now()
      WHERE id=$1 AND status IN ('dispatched','running') RETURNING ${COLS}`,
    [id, end.status, end.error ? end.error.slice(0, 500) : null, end.statusCode ?? null, end.durationMs ?? null, end.bytes ?? null]);
  return norm(r.rows[0] as Record<string, unknown> | undefined);
}

/**
 * 끝맺지 못한 부르기를 닫는다 — 게이트웨이가 답을 기다리다 죽었거나(교대 · 재시작) 끝 적기를 놓친 줄. 시작 못 한 줄은 claim 창이,
 *  도는 줄은 요청 시간 + 여유가 지나면 failed. 돌기 신원은 그 전에도 수명 판정(app-server-call resolveCallRunPrincipal)이 막는다 — 이것은 기록 정리다.
 */
export async function expireStaleAppCalls(): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_app_call SET status='failed', error='게이트웨이가 끝맺지 못한 부르기(시간 지남)', ended_at=now()
      WHERE (status='dispatched' AND created_at < now() - make_interval(secs => $1))
         OR (status='running' AND claimed_at < now() - make_interval(secs => timeout_s + $2))`,
    [CALL_CLAIM_WINDOW_SEC, CALL_RUN_GRACE_SEC]);
  return r.rowCount ?? 0;
}

/** 끝난 지 days 일이 지난 부르기 행을 지운다(한 판 limit 줄). 지운 수. */
export async function pruneAppCalls(limit: number, days: number): Promise<number> {
  const r = await itemsPool.query(
    `DELETE FROM org_app_call WHERE id IN (SELECT id FROM org_app_call WHERE ended_at IS NOT NULL AND ended_at < now() - make_interval(days => $2) ORDER BY ended_at LIMIT $1)`,
    [limit, days]);
  return r.rowCount ?? 0;
}

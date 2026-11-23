// 세션 요청 저장소(#5713) — org_session_ask CRUD. 표의 뜻은 org/schema/session-ask.ts 머리말.
//
//  ⚠ **모든 읽기·쓰기가 member_id 를 조건에 건다.** id 는 주소(#/ask/<id>)에 실려 다니므로 «id 를 안다» 가 권한이 아니다 —
//   요청을 건 사람만 보고 답한다. 조건을 빼먹은 조회가 하나라도 있으면 남의 요청 내용(무슨 자격을 받으려 했나)이 샌다.
import crypto from "node:crypto";
import { itemsPool } from "../db/client.js";

export type AskStatus = "open" | "done" | "dismissed" | "canceled";

export interface AskRow {
  id: string;
  member_id: string;
  session_id: string | null;
  kind: string;
  /** 같은 세션 · 같은 종류에서 «같은 것을 다시 물었다» 를 가르는 열쇠(종류가 정한다 — 없으면 빈 문자열). */
  slot: string;
  payload: Record<string, unknown>;
  status: AskStatus;
  result: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
function rowOf(r: Record<string, unknown>): AskRow {
  return {
    id: String(r.id), member_id: String(r.member_id), session_id: r.session_id == null ? null : String(r.session_id),
    kind: String(r.kind), slot: String(r.slot ?? ""),
    payload: (r.payload ?? {}) as Record<string, unknown>, status: String(r.status) as AskStatus,
    result: (r.result ?? null) as Record<string, unknown> | null,
    created_at: iso(r.created_at), resolved_at: r.resolved_at == null ? null : iso(r.resolved_at),
  };
}
const COLS = "id, member_id, session_id, kind, slot, payload, status, result, created_at, resolved_at";

/** 주소에 실리는 id — 추측 못 하는 임의 값(96비트). 앞머리는 로그에서 알아보려고 붙인다. */
export function newAskId(): string { return "ask_" + crypto.randomBytes(12).toString("base64url"); }

/**
 * 요청을 건다. 같은 사람 · 같은 세션 · 같은 종류 · 같은 slot 으로 열려 있던 요청은 내린다(canceled) —
 *  AI 가 같은 것을 다시 물으면 카드가 둘이 서는 대신 새 것으로 갈린다. 돌려주는 값 = 새 행과 내린 행의 id 들.
 */
export async function createAsk(i: { member: string; session: string | null; kind: string; slot?: string; payload: Record<string, unknown> }): Promise<{ ask: AskRow; replaced: string[] }> {
  const slot = i.slot ?? "";
  const gone = await itemsPool.query(
    `UPDATE org_session_ask SET status='canceled', resolved_at=now(), result='{"replaced":true}'::jsonb
      WHERE member_id=$1 AND session_id IS NOT DISTINCT FROM $2 AND kind=$3 AND slot=$4 AND status='open' RETURNING id`,
    [i.member, i.session, i.kind, slot]);
  const r = await itemsPool.query(
    `INSERT INTO org_session_ask(id, member_id, session_id, kind, slot, payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING ${COLS}`,
    [newAskId(), i.member, i.session, i.kind, slot, JSON.stringify(i.payload ?? {})]);
  return { ask: rowOf(r.rows[0]), replaced: gone.rows.map((x) => String(x.id)) };
}

/** 그 사람의 요청 하나(상태 무관). 없거나 남의 것이면 null. */
export async function getAsk(member: string, id: string): Promise<AskRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_session_ask WHERE id=$1 AND member_id=$2`, [id, member]);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** 그 사람의 **열린** 요청들(건 순서). session 을 주면 그 세션 것만 — `null` 은 «세션 없이 건 것만», 생략은 전부. */
export async function listOpenAsks(member: string, session?: string | null): Promise<AskRow[]> {
  const r = session === undefined
    ? await itemsPool.query(`SELECT ${COLS} FROM org_session_ask WHERE member_id=$1 AND status='open' ORDER BY created_at, id`, [member])
    : await itemsPool.query(
      `SELECT ${COLS} FROM org_session_ask WHERE member_id=$1 AND session_id IS NOT DISTINCT FROM $2 AND status='open' ORDER BY created_at, id`,
      [member, session]);
  return r.rows.map(rowOf);
}

/** 그 세션의 최근 요청들(상태 무관 · 최신 먼저) — AI 가 «아까 건 요청이 어떻게 됐나» 를 id 없이 볼 때. */
export async function listRecentAsks(member: string, session: string | null, limit = 10): Promise<AskRow[]> {
  const r = await itemsPool.query(
    `SELECT ${COLS} FROM org_session_ask WHERE member_id=$1 AND session_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
    [member, session, Math.max(1, Math.min(50, limit))]);
  return r.rows.map(rowOf);
}

/**
 * 열린 요청을 닫는다 — **열려 있을 때만**(두 탭에서 동시에 답하면 하나만 이긴다). 닫았으면 그 행, 이미 닫혀 있었으면 null.
 *  result 에는 AI 가 읽을 요약만 — 시크릿 값은 부르는 쪽이 애초에 넘기지 않는다.
 */
export async function resolveAsk(member: string, id: string, status: Exclude<AskStatus, "open">, result: Record<string, unknown> | null): Promise<AskRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_session_ask SET status=$3, result=$4::jsonb, resolved_at=now()
      WHERE id=$1 AND member_id=$2 AND status='open' RETURNING ${COLS}`,
    [id, member, status, result == null ? null : JSON.stringify(result)]);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** 그 세션에서 그 종류로 열려 있는 요청을 모두 내린다(AI 가 «더는 필요 없다» 고 했을 때). 내린 id 들. */
export async function cancelOpenAsks(member: string, session: string | null, kind?: string): Promise<string[]> {
  const r = await itemsPool.query(
    `UPDATE org_session_ask SET status='canceled', resolved_at=now()
      WHERE member_id=$1 AND session_id IS NOT DISTINCT FROM $2 AND status='open' AND ($3::text IS NULL OR kind=$3) RETURNING id`,
    [member, session, kind ?? null]);
  return r.rows.map((x) => String(x.id));
}

/**
 * 새 id 로 복원된 세션에 **열린** 요청을 넘긴다 — 세션은 되살리면 id 가 바뀌는데, 요청이 옛 id 에 남으면 곁칸에서 사라진다.
 *  붙은 앱(carrySessionApps)과 달리 행을 옮긴다(요청은 주소 id 가 정본이라 복제하면 같은 요청이 둘이 된다). 옮긴 수.
 */
export async function carrySessionAsks(fromId: string, toId: string): Promise<number> {
  if (!fromId || !toId || fromId === toId) return 0;
  const r = await itemsPool.query(`UPDATE org_session_ask SET session_id=$2 WHERE session_id=$1 AND status='open'`, [fromId, toId]);
  return r.rowCount ?? 0;
}

/**
 * «이 요청의 한 마디를 세션에 넣었다» 를 잡는다 — 잡았으면 true, 이미 잡혀 있었으면 false(두 탭이 동시에 불러도 한 번만 넣게).
 *  끝난(done) 요청에만 선다. 표시는 result.told 에 둔다(열이 아니라 — 요청마다 한 번 쓰고 마는 값이다).
 */
export async function claimAskTold(member: string, id: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_session_ask SET result = COALESCE(result, '{}'::jsonb) || '{"told":true}'::jsonb
      WHERE id=$1 AND member_id=$2 AND status='done' AND COALESCE(result->>'told','') <> 'true'`, [id, member]);
  return (r.rowCount ?? 0) > 0;
}

/** 잡았던 표시를 놓는다 — 넣기가 실패했을 때(다음 시도가 다시 넣을 수 있게). */
export async function releaseAskTold(member: string, id: string): Promise<void> {
  await itemsPool.query(`UPDATE org_session_ask SET result = result - 'told' WHERE id=$1 AND member_id=$2`, [id, member]);
}

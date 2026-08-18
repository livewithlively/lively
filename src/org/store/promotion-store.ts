// 승격 요청 큐 CRUD(#1750) — org_promotion_request 의 순수 DB 층. 실행(원격 발행)은 capability 가 한다(여기선 상태만).
//  개인 워크스페이스의 사람/AI 가 지식·프로젝트를 연결한 팀으로 올리려 할 때 한 행이 선다.
import { itemsPool } from "../../db/client.js";

export interface PromotionRow {
  id: number;
  member_id: string;
  link_scope: string;       // org_linked_workspace 의 scope_key(host[:port])
  kind: "knowledge" | "project";
  target_ref: string;       // 지식 name 또는 프로젝트 id(문자열)
  title: string | null;
  note: string | null;
  remote_category: string | null;
  state: "pending" | "approved" | "rejected" | "done" | "failed";
  requested_by: string | null;
  requested_via: string | null; // 'web' | 'mcp'
  actor_kind: string | null;    // 'human' | 'ai'
  result: unknown | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  done_at: string | null;
}

const COLS = "id, member_id, link_scope, kind, target_ref, title, note, remote_category, state, requested_by, requested_via, actor_kind, result, error, created_at, decided_at, decided_by, done_at";

// 멱등: 같은 (member, link, kind, target) 의 pending 이 이미 있으면 그 행을 돌려준다(중복 요청 안 쌓임). 없으면 새로 만든다.
export async function upsertPendingPromotion(p: {
  member_id: string; link_scope: string; kind: "knowledge" | "project"; target_ref: string;
  title?: string | null; note?: string | null; remote_category?: string | null;
  requested_by?: string | null; requested_via?: string | null; actor_kind?: string | null;
}): Promise<{ row: PromotionRow; existed: boolean }> {
  const existing = (await itemsPool.query(
    `SELECT ${COLS} FROM org_promotion_request
      WHERE member_id=$1 AND link_scope=$2 AND kind=$3 AND target_ref=$4 AND state='pending'`,
    [p.member_id, p.link_scope, p.kind, p.target_ref])).rows[0] as PromotionRow | undefined;
  if (existing) return { row: existing, existed: true };
  const r = await itemsPool.query(
    `INSERT INTO org_promotion_request(member_id, link_scope, kind, target_ref, title, note, remote_category, requested_by, requested_via, actor_kind)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
    [p.member_id, p.link_scope, p.kind, p.target_ref, p.title ?? null, p.note ?? null, p.remote_category ?? null,
     p.requested_by ?? null, p.requested_via ?? null, p.actor_kind ?? null]);
  return { row: r.rows[0] as PromotionRow, existed: false };
}

export async function getPromotion(id: number, memberId: string): Promise<PromotionRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_promotion_request WHERE id=$1 AND member_id=$2`, [id, memberId]);
  return (r.rows[0] as PromotionRow) ?? null;
}

export async function listPromotions(memberId: string, opts?: { state?: string; limit?: number }): Promise<PromotionRow[]> {
  const params: unknown[] = [memberId];
  let where = "member_id=$1";
  if (opts?.state) { params.push(opts.state); where += ` AND state=$${params.length}`; }
  params.push(Math.min(Math.max(opts?.limit ?? 100, 1), 500));
  const r = await itemsPool.query(
    `SELECT ${COLS} FROM org_promotion_request WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows as PromotionRow[];
}

export async function countPendingPromotions(memberId: string): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_promotion_request WHERE member_id=$1 AND state='pending'`, [memberId]);
  return Number((r.rows[0] as { n: number })?.n ?? 0);
}

export async function setPromotionState(
  id: number, memberId: string, state: PromotionRow["state"],
  patch?: { decided_by?: string | null; result?: unknown; error?: string | null },
): Promise<PromotionRow | null> {
  const sets: string[] = ["state=$3"]; const params: unknown[] = [id, memberId, state];
  if (state === "approved" || state === "rejected") { sets.push("decided_at=now()"); if (patch?.decided_by !== undefined) { params.push(patch.decided_by); sets.push(`decided_by=$${params.length}`); } }
  if (state === "done" || state === "failed") sets.push("done_at=now()");
  if (patch?.result !== undefined) { params.push(JSON.stringify(patch.result)); sets.push(`result=$${params.length}::jsonb`); }
  if (patch?.error !== undefined) { params.push(patch.error === null ? null : String(patch.error).slice(0, 1000)); sets.push(`error=$${params.length}`); }
  const r = await itemsPool.query(
    `UPDATE org_promotion_request SET ${sets.join(", ")} WHERE id=$1 AND member_id=$2 RETURNING ${COLS}`, params);
  return (r.rows[0] as PromotionRow) ?? null;
}

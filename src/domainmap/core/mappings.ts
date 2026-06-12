// 매핑 행 단위 큐레이션 3종 — 이 파일의 모든 함수는 매핑 1행을 다룬다(merge 의 대량 이동은
// domains.ts 소유). store-core.mjs 의 confirm/reject/reassignMapping verbatim 이식.
import { dmPool, one } from "../db.js";
import { httpErr, type Actor, type CurationResult, type ReassignResult } from "./types.js";
import { logChange } from "./changelog.js";

const now = () => new Date().toISOString();

export async function confirmMapping(id: number, actor: Actor): Promise<CurationResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM mapping WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such mapping: " + id);
  const before = { status: ex.status, origin: ex.origin };
  const after = { status: "confirmed", origin: "human" };
  await pool.query("UPDATE mapping SET status=$1,origin=$2,updated_at=$3 WHERE id=$4", ["confirmed", "human", now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "mapping", entityId: id, op: "update", actor,
    before, after, note: "human confirm assignment",
  });
  return { id, change_id: cid };
}

export async function rejectMapping(id: number, actor: Actor): Promise<CurationResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM mapping WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such mapping: " + id);
  const before = { status: ex.status, origin: ex.origin };
  const after = { status: "rejected", origin: "human" };
  await pool.query("UPDATE mapping SET status=$1,origin=$2,updated_at=$3 WHERE id=$4", ["rejected", "human", now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "mapping", entityId: id, op: "update", actor,
    before, after, note: "human reject assignment",
  });
  return { id, change_id: cid };
}

// reassign — UNIQUE(repo_id,target_kind,target_id,domain_id) 충돌(pg 23505)을 절대 잡지 않는다.
// raw pg 에러 전파가 계약: 409 한국어 번역은 capability 계층(dm_mapping_move) 한 곳의 책임이다.
// (projects.syncProject 의 23505→409 자체 번역과 패턴이 다른 것은 의도 — 통일 금지.)
export async function reassignMapping(id: number, domain_id: number, actor: Actor): Promise<ReassignResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM mapping WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such mapping: " + id);
  const dom = await one(pool, "SELECT id FROM domain WHERE id=$1 AND repo_id=$2", [domain_id, ex.repo_id]);
  if (!dom) throw httpErr(400, "no such target domain: " + domain_id);
  // Origin follows actor.type so agent-driven reassigns aren't mislabeled as human.
  const origin = actor.type === "agent" ? "agent" : "human";
  const before = { domain_id: ex.domain_id, status: ex.status, origin: ex.origin };
  const after = { domain_id, status: "confirmed", origin };
  await pool.query("UPDATE mapping SET domain_id=$1,status=$2,origin=$3,updated_at=$4 WHERE id=$5",
    [domain_id, "confirmed", origin, now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "mapping", entityId: id, op: "reassign", actor,
    before, after, note: `${origin} reassign`,
  });
  return { id, change_id: cid, after };
}

// 매핑 행 단위 큐레이션 3종 — 이 파일의 모든 함수는 매핑 1행을 다룬다(merge 의 대량 이동은
// domains.ts 소유). store-core.mjs 의 confirm/reject/reassignMapping verbatim 이식.
import { dmPool, one } from "../db.js";
import { httpErr, type Actor, type CurationResult } from "./types.js";
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

// v6 드랍(2026-06-24): reassignMapping 폐기 — mapping.domain_id→category_id 이동은 dm_mapping_move 핸들러가
//  category 로 직접 수행(domainmap-curation). 구 domain 테이블 참조 제거(드랍 가능화).

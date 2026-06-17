// P6a 보강 — 기존 agent-origin proposed → confirmed 소급(신뢰우선 결정 "proposed 림보 폐기"를 기존 데이터에도 완성).
//   안전: origin='agent' 행만(human/source 소유 proposed 는 보존). 멱등(재실행 시 proposed 0 → no-op).
//   change_log 감사(op='backfill', before/after). 도메인맵 DB(DOMAINMAP_DATABASE_URL)만 — items 무관.
//   실행: node --env-file=/tmp/co-p1a-worktree/.env scripts/backfill-domainmap-trust.mjs [--dry]
import { dmPool } from "../dist/domainmap/db.js";

const DRY = process.argv.includes("--dry");
const pool = dmPool();
const ACTOR = { type: "migration", id: "P6a-trust-backfill" };
const NOTE = "신뢰우선 소급: agent-origin proposed→confirmed (림보 폐기 결정 완성)";

async function backfill(table, entityType) {
  const sel = await pool.query(`SELECT id, repo_id FROM ${table} WHERE status='proposed' AND origin='agent'`);
  const rows = sel.rows;
  // 안전 점검 — human/source 소유 proposed 는 소급 대상 아님(WHERE origin='agent' 가 제외). 개수만 보고.
  const other = await pool.query(
    `SELECT count(*)::int n FROM ${table} WHERE status='proposed' AND origin IS DISTINCT FROM 'agent'`);
  console.log(`${table}: agent-proposed=${rows.length} · non-agent-proposed(보존)=${other.rows[0].n}`);
  if (DRY || rows.length === 0) return rows.length;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO change_log(repo_id, entity_type, entity_id, op, actor_type, actor_id, at, before, after, note)
       VALUES($1,$2,$3,'backfill',$4,$5,now(),$6::jsonb,$7::jsonb,$8)`,
      [r.repo_id, entityType, r.id, ACTOR.type, ACTOR.id,
       JSON.stringify({ status: "proposed" }), JSON.stringify({ status: "confirmed" }), NOTE]);
  }
  const upd = await pool.query(
    `UPDATE ${table} SET status='confirmed', updated_at=now() WHERE status='proposed' AND origin='agent'`);
  return upd.rowCount;
}

console.log(`[P6a domainmap trust-backfill] dry=${DRY}`);
let total = 0;
for (const [t, e] of [["domain", "domain"], ["mapping", "mapping"], ["project", "project"]]) {
  total += await backfill(t, e);
}
console.log(`backfilled→confirmed: ${total}`);
if (!DRY) {
  for (const t of ["domain", "mapping", "project"]) {
    const left = await pool.query(`SELECT count(*)::int n FROM ${t} WHERE status='proposed' AND origin='agent'`);
    console.log(`${t} remaining agent-proposed: ${left.rows[0].n}`);
  }
}
await pool.end();
process.exit(0);

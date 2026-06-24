// 감사 불변식의 단일 거처 — change_log 테이블의 모든 SQL 이 이 파일에만 산다.
// (1) logChange: 유일한 change_log writer — 모든 writer 모듈이 이것만 import 한다.
// (2) restore: before 스냅샷 복원(allow-list + 의존행 가드 + undo-insert 하드 DELETE).
// (3) history/historyGlobal: 열람. 읽기 경로(queries.ts)는 이 파일을 import 하지 않는다 —
//     스냅샷 기록·역연산·열람을 한 파일에서 리뷰 가능하게 묶는 것이 응집의 핵심.
// store-core.mjs 의 logChange/restore/history 를 시맨틱 무수정 이식(op 어휘·에러 문구 byte 동일).
import { dmPool, one, q, type Db } from "../db.js";
import { httpErr, saneLimit, type Actor, type RestoreResult } from "./types.js";
import { getRepo } from "./repos.js";

const now = () => new Date().toISOString();

export interface LogChangeArgs {
  repoId: number;
  entityType: string;
  entityId: number;
  // op 어휘(불변): insert|update|drift|rename|remove|revive|retomb|merge|reassign|restore
  op: string;
  actor: Actor;
  runId?: number | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
  // 통합 후(P2): 이 변경을 유발한 작업(activity) 귀속. optional — 기존 호출부 무변경(점진 배선).
  activityId?: number | null;
}

// 유일한 change_log writer. before/after 는 명시적 JSON.stringify(객체→jsonb),
// at 은 클라이언트측 now() — store-core 와 동일(서버시간 아님).
export async function logChange(db: Db, a: LogChangeArgs): Promise<number> {
  const r = await one(db,
    `INSERT INTO change_log(repo_id,entity_type,entity_id,op,actor_type,actor_id,run_id,at,before,after,note,activity_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [a.repoId, a.entityType, a.entityId, a.op, a.actor.type, a.actor.id, a.runId ?? null, now(),
     a.before ? JSON.stringify(a.before) : null, a.after ? JSON.stringify(a.after) : null, a.note ?? null, a.activityId ?? null]);
  return r.id;
}

// Restore: revert a change_log entry to its 'before' snapshot.
// Tables a restore is allowed to touch. entity_type is system-written (never user
// input), but this allow-list keeps the interpolated identifier provably safe.
// v6 드랍(2026-06-24): "domain" 제거(테이블 드랍 → category 는 org_content_audit/content_restore 경로로 복원).
const RESTORABLE = new Set(["repo", "scan_run", "code_unit", "data_entity", "mapping", "debt_finding", "activity", "activity_touch"]);

// Per-table allow-list of restorable columns (mirrors the schema in init()).
// A 'before' snapshot is attacker-influenced only via change_log content, which is
// system-written — but we still intersect snapshot keys with this Set so the
// interpolated UPDATE identifiers are provably safe and never trust JSONB keys.
// `id` is deliberately excluded: it's the WHERE target, never a SET column.
const RESTORE_COLUMNS: Record<string, Set<string>> = {
  repo: new Set(["name", "root_path", "detected_stack", "created_at", "last_scan_at", "state", "last_refreshed_sha", "git_url", "default_branch"]),
  scan_run: new Set(["repo_id", "runbook", "harness", "actor_type", "actor_id", "started_at", "finished_at", "summary"]),
  code_unit: new Set(["repo_id", "kind", "path", "label", "created_at", "state", "prev_path", "updated_at"]),
  data_entity: new Set(["repo_id", "kind", "name", "source", "created_at"]),
  // v6: mapping 은 category_id 로 착지(구 domain_id 폐기). 옛 domain_id 스냅샷은 비복원(레거시).
  mapping: new Set(["repo_id", "target_kind", "target_id", "category_id", "origin", "confidence", "status", "run_id", "created_at", "updated_at"]),
  debt_finding: new Set(["repo_id", "kind", "title", "detail", "cited_refs", "status", "origin", "run_id", "created_at", "updated_at"]),
  activity: new Set(["type", "title", "body", "author_person", "author_agent", "session_id", "repo_id", "commit_sha", "committed_at", "external_system", "external_instance", "external_id", "external_url", "should_review", "is_review", "created_at"]),
  activity_touch: new Set(["activity_id", "target_kind", "target_id", "created_at"]),
};

// Columns that reference each restorable row. Used to refuse a hard DELETE
// (undo-insert) when dependents exist — the schema has no FK cascades, so a blind
// delete would orphan mappings/debts/scan-run-scoped rows.
async function restoreDependents(table: string, eid: number, _cur: unknown, db: Db): Promise<any[]> {
  switch (table) {
    // v6 드랍: "domain" 케이스 제거(테이블 드랍). category 의존성은 mapping.category_id(FK CASCADE)가 관리.
    case "code_unit":
      return q(db, "SELECT id FROM mapping WHERE target_kind='code_unit' AND target_id=$1 LIMIT 1", [eid]);
    case "data_entity":
      return q(db, "SELECT id FROM mapping WHERE target_kind='data_entity' AND target_id=$1 LIMIT 1", [eid]);
    case "scan_run":
      return q(db, "SELECT id FROM mapping WHERE run_id=$1 UNION ALL SELECT id FROM debt_finding WHERE run_id=$1 LIMIT 1", [eid]);
    case "repo": {
      // 레포 스코프 자식(코드측)이 있으면 삭제 차단. v6: domain 은 repo-free(category)라 union 에서 제외.
      return q(db, `SELECT 1 FROM code_unit WHERE repo_id=$1
        UNION ALL SELECT 1 FROM data_entity WHERE repo_id=$1
        UNION ALL SELECT 1 FROM mapping WHERE repo_id=$1
        UNION ALL SELECT 1 FROM debt_finding WHERE repo_id=$1
        UNION ALL SELECT 1 FROM scan_run WHERE repo_id=$1 LIMIT 1`, [eid]);
    }
    default:
      return []; // mapping, debt_finding, activity_touch: leaf rows, nothing references them.
  }
}

export async function restore(change_id: number, actor: Actor): Promise<RestoreResult> {
  const pool = dmPool();
  const ch = await one(pool, "SELECT * FROM change_log WHERE id=$1", [change_id]);
  if (!ch) throw httpErr(404, "no such change: " + change_id);
  const table = ch.entity_type, eid = ch.entity_id;
  if (!RESTORABLE.has(table)) throw httpErr(400, "not a restorable entity_type: " + table);
  const allowed = RESTORE_COLUMNS[table];
  const before = ch.before; // JSONB -> already object
  const cur = await one(pool, `SELECT * FROM ${table} WHERE id=$1`, [eid]);
  if (before === null) {
    // Undo an insert => hard delete. The schema has no FK cascades, so refuse if
    // any dependent row exists (it would otherwise be orphaned).
    const deps = await restoreDependents(table, eid, cur, pool);
    if (deps.length) {
      throw httpErr(400, `cannot undo insert of ${table} #${eid}: dependent rows exist (would orphan them)`);
    }
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [eid]);
    const cid = await logChange(pool, {
      repoId: ch.repo_id, entityType: table, entityId: eid, op: "restore", actor,
      before: cur, after: null, note: `reverted change #${change_id} (undo insert)`,
    });
    return { restored: change_id, change_id: cid, action: "deleted", table, entity_id: eid };
  }
  // Intersect snapshot keys with the known-columns allow-list; reject unknown keys.
  const keys = Object.keys(before);
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw httpErr(400, `restore snapshot has unknown column(s) for ${table}: ${unknown.join(", ")}`);
  }
  if (!keys.length) throw httpErr(400, `restore snapshot for ${table} #${eid} has no restorable columns`);
  const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(",");
  // before[k] 는 raw 전달 — jsonb 배열 컬럼의 node-pg 직렬화 거동('버그')까지 기존 그대로 보존.
  await pool.query(`UPDATE ${table} SET ${set} WHERE id=$${keys.length + 1}`, [...keys.map((k) => before[k]), eid]);
  const cid = await logChange(pool, {
    repoId: ch.repo_id, entityType: table, entityId: eid, op: "restore", actor,
    before: cur, after: before, note: `reverted change #${change_id}`,
  });
  return { restored: change_id, change_id: cid, action: "reverted", table, entity_id: eid };
}

// repo 스코프 열람(HTTP /history 의 소스 — 최신순, saneLimit 기본 50/최대 500).
export async function history(name: string, limit: unknown = 50): Promise<any[]> {
  const r = await getRepo(name);
  return q(dmPool(),
    "SELECT id,at,op,entity_type,entity_id,actor_type,actor_id,before,after,note FROM change_log WHERE repo_id=$1 ORDER BY id DESC LIMIT $2",
    [r.id, saneLimit(limit)]);
}

// CLI 전용 글로벌 열람(전 repo 무필터, SELECT * — store.mjs historyCmd 의 쿼리 그대로).
export async function historyGlobal(limit: unknown): Promise<any[]> {
  return q(dmPool(), "SELECT * FROM change_log ORDER BY id DESC LIMIT $1", [limit]);
}

// ── 도메인맵 탭(should↔is) 전용 열람 2종 — change_log 를 의도(should)/구조(is) 축으로 슬라이스. ──
// 둘 다 읽기 전용 SELECT 이지만 change_log 소유 파일(여기)에 둔다(queries.ts 는 감사테이블 무접촉 격리).

// (1) should 변경 이력 — domain.should(의도)가 실제로 달라진 change_log 행만(NULL-aware IS DISTINCT FROM:
//  NULL→값, 값→NULL, 값→다른값 모두 잡고 동일값/둘다NULL 은 제외). 그 변경을 유발한 작업(activity)을
//  activity_id 로 LEFT JOIN(귀속 없으면 activity_* null). before/after 는 도메인 전체 스냅샷이라 should
//  필드만 추출(->>'should'). 현 도메인 key/name 도 함께(개명 후에도 식별).

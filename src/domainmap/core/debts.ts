// debt_finding 쓰기 SQL 의 단일 소유 모듈 — 같은 (repo_id,title) upsert 로직이
// ingest 경로(reconcile.ts)와 구조 리프레시 경로(refresh.ts)에서 쓰이므로 1벌만 둔다.
// 사람이 닫은 finding(resolved/dismissed/ack)은 재개하지 않는다('kept-<status>') — 불변식.
import { dmPool, one, type Db } from "../db.js";
import { httpErr, type Actor, type CurationResult } from "./types.js";
import { logChange } from "./changelog.js";

const now = () => new Date().toISOString();

export interface DebtUpsertInput {
  kind?: string;
  title: string;
  detail?: string;
  cited_refs?: unknown[];
  note?: string | null;
  // V6: 도메인부채(should↔is)는 category 귀속 — category_id 가 주어지면 debt_finding.category_id 로 키.
  //  (구조부채 flagStructuralDrift 는 repo_id 키 유지 — class C, 미설정.) 둘 다 미설정이면 repo_id 키(레거시).
  category_id?: number | null;
}

// ingest 경로 upsert — store-core.upsertDebt 시맨틱. V6: d.category_id 가 있으면 (category_id,title) 키
//  (debt_finding_category_title_uq), 없으면 (repo_id,title) 키(레거시 구조부채 경로). repo_id 는 provenance 로
//  항상 INSERT(category 경로도 어느 레포 스캔에서 났는지 보존 — change_log 도 repo_id 로 귀속).
export async function upsertDebtRow(
  db: Db, repo_id: number, run_id: number | null, actor: Actor, d: DebtUpsertInput,
): Promise<string> {
  const byCat = d.category_id != null;
  const ex = byCat
    ? await one(db, "SELECT * FROM debt_finding WHERE category_id=$1 AND title=$2", [d.category_id, d.title])
    : await one(db, "SELECT * FROM debt_finding WHERE repo_id=$1 AND title=$2", [repo_id, d.title]);
  if (!ex) {
    const r = await one(db, `INSERT INTO debt_finding(repo_id,category_id,kind,title,detail,cited_refs,status,origin,run_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$9) RETURNING id`,
      [repo_id, d.category_id ?? null, d.kind, d.title, d.detail ?? "", JSON.stringify(d.cited_refs ?? []), actor.type, run_id, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "debt_finding", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { title: d.title }, note: null,
    });
    return "insert";
  }
  if (["resolved", "dismissed", "ack"].includes(ex.status)) return "kept-" + ex.status;
  return "unchanged";
}

// Audited soft "removed" debt flag helper (kind='structural_drift'). Upsert by
// (repo_id, title) like upsertDebtRow — re-running refresh won't duplicate, and a
// human-closed finding (resolved/dismissed/ack) is not reopened.
// change_log after={kind:'structural_drift', title}, note=d.note — ingest 경로와 비대칭(기존 그대로).
export async function flagStructuralDrift(
  db: Db, repo_id: number, run_id: number | null, actor: Actor, d: DebtUpsertInput,
): Promise<string> {
  const ex = await one(db, "SELECT * FROM debt_finding WHERE repo_id=$1 AND title=$2", [repo_id, d.title]);
  if (!ex) {
    const r = await one(db, `INSERT INTO debt_finding(repo_id,kind,title,detail,cited_refs,status,origin,run_id,created_at,updated_at)
      VALUES($1,'structural_drift',$2,$3,$4,'open',$5,$6,$7,$7) RETURNING id`,
      [repo_id, d.title, d.detail ?? "", JSON.stringify(d.cited_refs ?? []), actor.type, run_id, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "debt_finding", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { kind: "structural_drift", title: d.title }, note: d.note ?? null,
    });
    return "insert";
  }
  if (["resolved", "dismissed", "ack"].includes(ex.status)) return "kept-" + ex.status;
  return "unchanged";
}

// 상태 전환(open|ack|resolved|dismissed) — store-core.setDebtStatus verbatim.
export async function setDebtStatus(id: number, status: string, actor: Actor): Promise<CurationResult> {
  const allowed = ["open", "ack", "resolved", "dismissed"];
  if (!allowed.includes(status)) throw httpErr(400, "bad status: " + status);
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM debt_finding WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such finding: " + id);
  const before = { status: ex.status };
  const after = { status };
  await pool.query("UPDATE debt_finding SET status=$1,updated_at=$2 WHERE id=$3", [status, now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "debt_finding", entityId: id, op: "update", actor,
    before, after, note: "human set status",
  });
  return { id, change_id: cid };
}

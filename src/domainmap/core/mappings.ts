// 매핑 행 단위 큐레이션 3종 — 이 파일의 모든 함수는 매핑 1행을 다룬다(merge 의 대량 이동은
// domains.ts 소유). store-core.mjs 의 confirm/reject/reassignMapping verbatim 이식.
import { itemsPool, one, q, withTx } from "../db.js";
import { httpErr, type Actor, type CurationResult } from "./types.js";
import { logChange } from "./changelog.js";

const now = () => new Date().toISOString();

export async function confirmMapping(id: number, actor: Actor): Promise<CurationResult> {
  const pool = itemsPool;
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
  const pool = itemsPool;
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

// ── 미매핑 인박스 + 코드유닛 매핑 생성(propose/confirm) — LLM 판단주체 모델의 손잡이(에이전트·사람 공용). ──
//  refresh 가 add 를 unmapped 로 떨구면(매핑 행 0), 이 둘로 드레인한다. 기존행 confirm/reject 는 위 3종.
//  설계(2026-06-26): 코드→도메인 매핑은 룰도 사람-per-item 도 아닌 LLM 판단 — 도메인 should(정의·범위) + DDD 가 근거.
//   org_cron 'map_unmapped' 가 라이블리 시드 에이전트를 띄워 이 함수들을 MCP 로 호출(propose+근거 → audit → verify).

// 미매핑 = active code_unit 중 비-rejected 매핑이 0건인 것(repo 스코프). 분류 대상 인박스.
export async function listUnmappedCodeUnits(repoName: string): Promise<Array<{ id: number; path: string; kind: string; label: string }>> {
  const repo = await one(itemsPool, "SELECT id FROM repo WHERE name=$1", [repoName]);
  if (!repo) throw httpErr(404, "no such repo: " + repoName);
  return q(itemsPool, `
    SELECT cu.id, cu.path, cu.kind, cu.label
    FROM code_unit cu
    WHERE cu.repo_id=$1 AND COALESCE(cu.state,'active')='active'
      AND NOT EXISTS (SELECT 1 FROM mapping m
                      WHERE m.target_kind='code_unit' AND m.target_id=cu.id AND m.status<>'rejected')
    ORDER BY cu.path`, [repo.id]);
}

export interface SetMappingArgs {
  repoName: string;
  path?: string; targetId?: number;          // 코드유닛: path(권장) 또는 id
  categoryKey?: string; categoryId?: number; // 제품 도메인: key(권장) 또는 id
  origin?: string;        // 기본 'llm'(에이전트 판단). 사람이면 'human'.
  confidence?: number;    // 0~1
  status?: string;        // 'proposed'(기본·불확실) | 'confirmed'(확신) | 'rejected'
  evidence: string;       // 근거(필수) — 도메인 should 의 어느 부분 ↔ 코드의 어느 신호. change_log 감사.
  actor: Actor;
}

// 코드유닛→제품도메인 매핑 생성/갱신. propose+근거 필수. (target_kind,target_id,category_id) upsert. 감사=change_log.
export async function setCodeUnitMapping(args: SetMappingArgs): Promise<{ id: number; change_id: number; action: string; path: string; category: string; status: string }> {
  if (!args.evidence || !args.evidence.trim()) throw httpErr(400, "evidence(근거)는 필수입니다 — propose+근거 불변식");
  const status = args.status ?? "proposed";
  if (!["proposed", "confirmed", "rejected"].includes(status)) throw httpErr(400, "status 는 proposed|confirmed|rejected");
  const origin = args.origin ?? "llm";
  const confidence = args.confidence ?? null;
  return withTx(async (client) => {
    const repo = await one(client, "SELECT id FROM repo WHERE name=$1", [args.repoName]);
    if (!repo) throw httpErr(404, "no such repo: " + args.repoName);
    const cu = args.targetId != null
      ? await one(client, "SELECT id, path FROM code_unit WHERE id=$1 AND repo_id=$2", [args.targetId, repo.id])
      : await one(client, "SELECT id, path FROM code_unit WHERE repo_id=$1 AND path=$2 AND COALESCE(state,'active')='active'", [repo.id, args.path]);
    if (!cu) throw httpErr(404, "no such code_unit: " + (args.path ?? args.targetId));
    const cat = args.categoryId != null
      ? await one(client, "SELECT id, key FROM category WHERE id=$1 AND space='product' AND state<>'merged'", [args.categoryId])
      : await one(client, "SELECT id, key FROM category WHERE space='product' AND key=$1 AND state<>'merged'", [args.categoryKey]);
    if (!cat) throw httpErr(400, "no such product category: " + (args.categoryKey ?? args.categoryId));
    const ex = await one(client, "SELECT id FROM mapping WHERE target_kind='code_unit' AND target_id=$1 AND category_id=$2", [cu.id, cat.id]);
    let id: number, action: string;
    if (ex) {
      await client.query("UPDATE mapping SET status=$1, origin=$2, confidence=$3, updated_at=now() WHERE id=$4", [status, origin, confidence, ex.id]);
      id = ex.id; action = "update";
    } else {
      const r = await one(client, `INSERT INTO mapping(repo_id,target_kind,target_id,category_id,origin,confidence,status,created_at,updated_at)
        VALUES($1,'code_unit',$2,$3,$4,$5,$6,now(),now()) RETURNING id`, [repo.id, cu.id, cat.id, origin, confidence, status]);
      id = r.id; action = "insert";
    }
    const change_id = await logChange(client, {
      repoId: repo.id, entityType: "mapping", entityId: id, op: action === "insert" ? "insert" : "update", actor: args.actor,
      before: null, after: { code_unit: cu.path, category: cat.key, status, origin, confidence }, note: args.evidence.slice(0, 4000),
    });
    return { id, change_id, action, path: cu.path, category: cat.key, status };
  });
}

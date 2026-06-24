// ingest(reconcile) 정책 전체 = '비-agent 소유(origin∈{human,source}) 절대 미덮어쓰기' 불변식의 단일 거처.
// store-core.mjs 의 reconciliation-aware upsert 군 + ingest 를 시맨틱 이식하되,
// P6a 신뢰우선(trust-default, 공동대표 확정 2026-06-17)으로 자동매핑/정의의 착지 상태를 개정:
//  - 자동매핑/도메인은 proposed 림보 없이 곧바로 status='confirmed' 로 착지(AI 매핑=참).
//    origin(actor.type: agent|human)이 '누가 만들었나'를 보존 —
//    이제 confirmed 라고 다 사람·툴 소유가 아니다(agent 도 confirmed).
//  - '미덮어쓰기' 가드는 status='confirmed' 가 아니라 origin≠'agent' 로 키한다(이제 agent 도
//    confirmed 로 착지하므로 status 만으로는 권위 소유를 식별 못 한다). 비-agent 소유 행과
//    agent 제안이 다르면 → op='drift' 기록 후 기존 값 보존(덮어쓰기 금지). agent 자기 확정행은 갱신.
//  - mapping kept-* (비-agent 소유 또는 rejected)는 change_log 무기록
//  - code_unit/data_entity insert-only + change_log 무기록(비대칭 보존 — ingest 경로 한정)
//  - 모든 쓰기는 단일 트랜잭션(withTx): 중도 실패 = 전체 롤백, 부분 상태 없음
//  - tally 키 문자열('domain:insert','mapping:skip-nodomain' 등 콜론 합성)은 한 글자도 불변
//    (V6: domain=space='product' category 로 이전됐어도 tally 라벨은 'domain:*' 그대로 — 외부 계약 보존).
// V6: 스캔 쓰기 타깃이 레거시 domain→category(space='product'), mapping.domain_id→category_id 로 이동했다.
//  도메인은 멀티레포(repo_id 없음 — (space,key)로 유니크): 둘째 레포가 같은 key 를 ingest 하면 SAME category 공유.
//  code_unit/data_entity 는 여전히 repo_id 보유(멀티레포 = 여기 산다). is-엣지(category_edge axis='is')는 신설.
// upsert* 는 비공개 — ingest 만이 reconcile 진입점이다.
import { one, withTx, type Db } from "../db.js";
import { type Actor, type IngestResult } from "./types.js";
import { logChange } from "./changelog.js";
import { upsertRepo } from "./repos.js";
import { upsertDebtRow } from "./debts.js";

const now = () => new Date().toISOString();

// V6: 도메인 = space='product' 카테고리. 키는 (space='product', key) — repo_id 없음(도메인=멀티레포).
//  같은 key 의 두 번째 레포 ingest 는 SAME category 행을 찾는다(멀티레포 공유 — per-repo 도메인 없음).
//  반환은 action 문자열 + 해소된 category id(매핑이 category_id 로 쓰려면 필요) — { action, id }.
//  change_log 는 통합 후 entity_type='category' 로 기록(repo_id 는 provenance 로 유지 — category 자체는 repo-free).
async function upsertCategory(
  db: Db, repo_id: number, run_id: number, actor: Actor, d: any,
): Promise<{ action: string; id: number }> {
  const ex = await one(db, "SELECT * FROM category WHERE space='product' AND key=$1 AND state<>'merged'", [d.key]);
  if (!ex) {
    // 신뢰우선: 자동 정의는 proposed 림보 없이 곧바로 confirmed 로 착지. origin=actor.type 가
    // '누가 만들었나'(agent/human)를 보존 — 사람 큐레이션 식별은 status 가 아니라 origin='human'.
    // 코드스캔(reconcile) 파생 도메인은 항상 space='product'(코드앵커 보유). business 는 vocab-only(create 경로).
    const r = await one(db, `INSERT INTO category(space,key,name,description,state,cross_cutting,origin,status,created_at,updated_at)
      VALUES('product',$1,$2,$3,$4,$5,$6,'confirmed',$7,$7) RETURNING id`,
      [d.key, d.name, d.description ?? "", d.state ?? "active", !!d.cross_cutting, actor.type, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "category", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { key: d.key, name: d.name }, note: null,
    });
    return { action: "insert", id: r.id };
  }
  // 비-agent 소유(origin∈{human,source}) 행은 agent 덮어쓰기 차단 — agent 자기 확정행만 정상 갱신(멱등 재인제스트).
  if (ex.origin !== "agent" && actor.type === "agent") {
    if (ex.name !== d.name || (ex.description || "") !== (d.description || "")) {
      await logChange(db, {
        repoId: repo_id, entityType: "category", entityId: ex.id, op: "drift", actor, runId: run_id,
        before: { name: ex.name, description: ex.description },
        after: { name: d.name, description: d.description },
        note: "agent proposal differs from human-confirmed; kept human value",
      });
      return { action: "drift", id: ex.id };
    }
    return { action: "unchanged", id: ex.id };
  }
  if (ex.name === d.name && (ex.description || "") === (d.description || "")) return { action: "unchanged", id: ex.id };
  await logChange(db, {
    repoId: repo_id, entityType: "category", entityId: ex.id, op: "update", actor, runId: run_id,
    before: { name: ex.name, description: ex.description },
    after: { name: d.name, description: d.description }, note: null,
  });
  await db.query("UPDATE category SET name=$1,description=$2,updated_at=$3 WHERE id=$4", [d.name, d.description ?? "", now(), ex.id]);
  return { action: "update", id: ex.id };
}

// insert-only + change_log 무기록(비대칭 보존) — store-core.upsertCodeUnit verbatim.
async function upsertCodeUnit(db: Db, repo_id: number, u: any): Promise<number> {
  const ex = await one(db, "SELECT id FROM code_unit WHERE repo_id=$1 AND path=$2", [repo_id, u.path]);
  if (ex) return ex.id;
  const r = await one(db, "INSERT INTO code_unit(repo_id,kind,path,label,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [repo_id, u.kind, u.path, u.label ?? u.path, now()]);
  return r.id;
}

async function upsertDataEntity(db: Db, repo_id: number, e: any): Promise<number> {
  // Normalize source to '' so NULL/'' don't split the same entity across two rows
  // (and stay consistent with the deId key + touch lookups, which use ?? '').
  const source = e.source ?? "";
  const ex = await one(db, "SELECT id FROM data_entity WHERE repo_id=$1 AND kind=$2 AND name=$3 AND source IS NOT DISTINCT FROM $4", [repo_id, e.kind, e.name, source]);
  if (ex) return ex.id;
  const r = await one(db, "INSERT INTO data_entity(repo_id,kind,name,source,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [repo_id, e.kind, e.name, source, now()]);
  return r.id;
}

// V6: 매핑은 category_id 로 착지(구 domain_id). 유니크는 mapping_target_category_uq(target_kind,target_id,
//  category_id) WHERE category_id IS NOT NULL — repo_id 는 타깃(code_unit)이 이미 가지므로 매핑 식별에선 잉여.
async function upsertMapping(
  db: Db, repo_id: number, run_id: number, actor: Actor,
  target_kind: string, target_id: number, category_id: number, confidence: number | null | undefined,
): Promise<string> {
  const ex = await one(db, "SELECT * FROM mapping WHERE target_kind=$1 AND target_id=$2 AND category_id=$3",
    [target_kind, target_id, category_id]);
  if (!ex) {
    // 신뢰우선: 자동매핑은 proposed 림보 없이 곧바로 confirmed 로 착지. origin=actor.type 보존.
    const r = await one(db, `INSERT INTO mapping(repo_id,target_kind,target_id,category_id,origin,confidence,status,run_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'confirmed',$7,$8,$8) RETURNING id`,
      [repo_id, target_kind, target_id, category_id, actor.type, confidence ?? null, run_id, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "mapping", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { target_kind, target_id, category_id }, note: null,
    });
    return "insert";
  }
  // 비-agent 소유(origin∈{human,source})거나 rejected 면 보존(kept-*) — agent 자기 확정행 재인제스트는 unchanged.
  // (매핑 행은 이 경로에서 갱신할 가변 필드가 없어 agent-confirmed 는 사실상 no-op = unchanged.)
  if (ex.origin !== "agent" || ex.status === "rejected") return "kept-" + ex.status;
  return "unchanged";
}

// is-엣지 도출(NEW, V6) — 모듈 import 의존을 category 간 'is' 엣지로 사상한다. 결정론적(LLM 없음):
//  하네스가 p.imports=[{from_path,to_path}] 를 공급(매핑과 동일하게 상류 스캔이 준다).
//  ① from_path/to_path → code_unit(WHERE repo_id,path; soft-removed 제외) → 그 unit 의 best category
//     (mapping.category_id, status<>'rejected', confidence 우선·동률은 category_id 작은쪽 — 결정론).
//  ② 두 category 가 다르면 (from_cat→to_cat) 카운트 누적. 같으면 무시(category_edge_noself_chk — 자기엣지 금지).
//  ③ (from,to,axis='is') upsert: weight=이번 run 의 count, run_id=이번 run. UNIQUE(from,to,axis) 충돌 시 갱신.
//  ④ stale-sweep: 같은 레포의 *이전* scan_run 이 찍은 is-엣지 중 이번 run 이 다시 안 찍은 것 삭제
//     (멀티레포 안전 — 다른 레포가 찍은 엣지는 그 레포 run_id 라 건드리지 않는다).
async function deriveIsEdges(db: Db, repo_id: number, run_id: number, imports: any[]): Promise<void> {
  if (!Array.isArray(imports) || imports.length === 0) {
    // import 없음 = 이 레포 기여분 0. 그래도 이전 run 의 잔여 is-엣지는 쓸어야 한다(아래 sweep 만 수행).
    await sweepStaleIsEdges(db, repo_id, run_id, new Set<string>());
    return;
  }
  // path → 그 code_unit 의 best category_id(없으면 미해소). repo 스코프(code_unit.repo_id)는 여기서 건다.
  const catCache = new Map<string, number | null>();
  const bestCategoryForPath = async (path: unknown): Promise<number | null> => {
    if (typeof path !== "string" || path === "") return null;
    if (catCache.has(path)) return catCache.get(path)!;
    const row = await one(db, `
      SELECT m.category_id
        FROM code_unit cu
        JOIN mapping m ON m.target_kind='code_unit' AND m.target_id=cu.id
         AND m.category_id IS NOT NULL AND m.status<>'rejected'
       WHERE cu.repo_id=$1 AND cu.path=$2 AND COALESCE(cu.state,'active')='active'
       ORDER BY m.confidence DESC NULLS LAST, m.category_id ASC
       LIMIT 1`, [repo_id, path]);
    const cid = row ? (row.category_id as number) : null;
    catCache.set(path, cid);
    return cid;
  };

  // (from_cat,to_cat) → count. 두 category 가 다를 때만(자기엣지 제외).
  const counts = new Map<string, { from: number; to: number; n: number }>();
  for (const im of imports) {
    if (!im || typeof im !== "object") continue;
    const fc = await bestCategoryForPath((im as any).from_path);
    const tc = await bestCategoryForPath((im as any).to_path);
    if (fc == null || tc == null || fc === tc) continue;
    const k = fc + "->" + tc;
    const cur = counts.get(k) ?? { from: fc, to: tc, n: 0 };
    cur.n++;
    counts.set(k, cur);
  }

  // 이번 run 의 is-엣지 upsert(weight=count, run_id=이번 run). origin='scan'(스캔 도출 — 수동 should 와 구분).
  const keep = new Set<string>();
  for (const { from, to, n } of counts.values()) {
    await db.query(`
      INSERT INTO category_edge(from_category_id,to_category_id,axis,relation,origin,weight,run_id,created_at,updated_at)
      VALUES($1,$2,'is','depends_on','scan',$3,$4,now(),now())
      ON CONFLICT (from_category_id,to_category_id,axis)
      DO UPDATE SET weight=EXCLUDED.weight, run_id=EXCLUDED.run_id, origin='scan', updated_at=now()`,
      [from, to, n, run_id]);
    keep.add(from + "->" + to);
  }
  await sweepStaleIsEdges(db, repo_id, run_id, keep);
}

// 같은 레포의 *이전* scan_run 이 찍은 is-엣지 중 이번 run 이 유지하지 않은 것 삭제. run_id 로 레포 귀속을
//  판별(category_edge 는 repo-free 라 scan_run.repo_id 로 거른다) — 다른 레포가 찍은 엣지는 보존(멀티레포).
async function sweepStaleIsEdges(db: Db, repo_id: number, run_id: number, keep: Set<string>): Promise<void> {
  const stale = await db.query(`
    SELECT e.id, e.from_category_id, e.to_category_id
      FROM category_edge e
      JOIN scan_run sr ON sr.id=e.run_id
     WHERE e.axis='is' AND sr.repo_id=$1 AND e.run_id<>$2`, [repo_id, run_id]);
  for (const row of stale.rows) {
    if (keep.has(row.from_category_id + "->" + row.to_category_id)) continue;
    await db.query("DELETE FROM category_edge WHERE id=$1", [row.id]);
  }
}

// Ingest a full scan payload. All writes (scan_run, domains, code_units,
// data_entities, mappings, debts, audit rows, run summary) run inside ONE
// transaction on a single client; a mid-payload failure rolls back entirely so
// the store never lands in a partial state.
export async function ingest(payload: unknown): Promise<IngestResult> {
  const p: any = typeof payload === "string" ? JSON.parse(payload) : payload;
  const run = p.run ?? {};
  const actor: Actor = { type: run.actor_type ?? "agent", id: run.actor_id ?? "agent" };
  return withTx(async (client) => {
    const repo_id = await upsertRepo(client, p.repo.name, p.repo.root_path, p.repo.detected_stack ?? {});
    const sr = await one(client, "INSERT INTO scan_run(repo_id,runbook,harness,actor_type,actor_id,started_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [repo_id, run.runbook ?? "bootstrap-domains", run.harness ?? null, actor.type, actor.id, now()]);
    const run_id = sr.id;
    const tally: Record<string, number> = {};
    const bump = (k: string) => tally[k] = (tally[k] ?? 0) + 1;

    // 도메인 → category(space='product', key). 해소된 category id 를 key 로 기억(매핑·is-엣지가 재사용).
    //  멀티레포: 두 번째 레포가 같은 key 를 ingest 하면 upsertCategory 가 SAME 행을 찾아 같은 id 를 돌려준다.
    const catId: Record<string, number> = {};
    for (const d of p.domains ?? []) {
      const r = await upsertCategory(client, repo_id, run_id, actor, d);
      catId[d.key] = r.id;
      bump("domain:" + r.action);
    }
    const cuId: Record<string, number> = {}, deId: Record<string, number> = {};
    for (const u of p.code_units ?? []) { cuId[u.path] = await upsertCodeUnit(client, repo_id, u); bump("code_unit"); }
    for (const e of p.data_entities ?? []) { deId["model|" + e.name + "|" + (e.source ?? "")] = await upsertDataEntity(client, repo_id, e); bump("data_entity"); }
    for (const m of p.mappings ?? []) {
      // domain_key → category(space='product', key). 이번 run 에서 upsert 한 catId 우선, 없으면 DB 조회
      //  (페이로드가 매핑만 보내고 도메인 선언을 생략한 경우 — 기존 category 재사용 멀티레포 공유).
      let cid = catId[m.domain_key];
      if (cid == null) {
        const cat = await one(client, "SELECT id FROM category WHERE space='product' AND key=$1 AND state<>'merged'", [m.domain_key]);
        if (!cat) { bump("mapping:skip-nodomain"); continue; }
        cid = cat.id;
        catId[m.domain_key] = cid;
      }
      const tid = m.target_kind === "code_unit" ? cuId[m.target] : deId["model|" + m.target + "|" + (m.target_source ?? "")];
      if (!tid) { bump("mapping:skip-notarget"); continue; }
      bump("mapping:" + await upsertMapping(client, repo_id, run_id, actor, m.target_kind, tid, cid, m.confidence));
    }
    for (const d of p.debts ?? []) bump("debt:" + await upsertDebtRow(client, repo_id, run_id, actor, d));

    // is-엣지: 모듈 import(p.imports = [{from_path,to_path}]) → code_unit → 그 unit 의 best category(매핑) →
    //  두 category 가 다르면 category_edge(axis='is') upsert(weight=count). 결정론적(LLM 없음 — 하네스가 imports 공급).
    await deriveIsEdges(client, repo_id, run_id, p.imports ?? []);

    await client.query("UPDATE scan_run SET finished_at=$1, summary=$2 WHERE id=$3", [now(), JSON.stringify(tally), run_id]);
    return { repo: p.repo.name, run_id, tally };
  });
}

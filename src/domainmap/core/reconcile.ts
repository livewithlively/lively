// ingest(reconcile) 정책 전체 = '비-agent 소유(origin∈{human,source}) 절대 미덮어쓰기' 불변식의 단일 거처.
// store-core.mjs 의 reconciliation-aware upsert 군 + ingest 를 시맨틱 이식하되,
// P6a 신뢰우선(trust-default, 공동대표 확정 2026-06-17)으로 자동매핑/정의의 착지 상태를 개정:
//  - 자동매핑/도메인/프로젝트는 proposed 림보 없이 곧바로 status='confirmed' 로 착지(AI 매핑=참).
//    origin(actor.type: agent|human, syncProject 는 'source')이 '누가 만들었나'를 보존 —
//    이제 confirmed 라고 다 사람·툴 소유가 아니다(agent 도 confirmed).
//  - '미덮어쓰기' 가드는 status='confirmed' 가 아니라 origin≠'agent' 로 키한다(이제 agent 도
//    confirmed 로 착지하므로 status 만으로는 권위 소유를 식별 못 한다). 비-agent 소유 행과
//    agent 제안이 다르면 → op='drift' 기록 후 기존 값 보존(덮어쓰기 금지). agent 자기 확정행은 갱신.
//  - mapping kept-* (비-agent 소유 또는 rejected)는 change_log 무기록
//  - code_unit/data_entity insert-only + change_log 무기록(비대칭 보존 — ingest 경로 한정)
//  - 모든 쓰기는 단일 트랜잭션(withTx): 중도 실패 = 전체 롤백, 부분 상태 없음
//  - tally 키 문자열('domain:insert','mapping:skip-nodomain' 등 콜론 합성)은 한 글자도 불변
// upsert* 는 비공개 — ingest 만이 reconcile 진입점이다.
import { one, withTx, type Db } from "../db.js";
import { httpErr, isReservedProvenanceKey, PROVENANCE_KEY_PREFIXES, type Actor, type IngestResult } from "./types.js";
import { logChange } from "./changelog.js";
import { upsertRepo } from "./repos.js";
import { upsertDebtRow } from "./debts.js";

const now = () => new Date().toISOString();

async function upsertDomain(db: Db, repo_id: number, run_id: number, actor: Actor, d: any): Promise<string> {
  const ex = await one(db, "SELECT * FROM domain WHERE repo_id=$1 AND key=$2", [repo_id, d.key]);
  if (!ex) {
    // 신뢰우선: 자동 정의는 proposed 림보 없이 곧바로 confirmed 로 착지. origin=actor.type 가
    // '누가 만들었나'(agent/human)를 보존 — 사람 큐레이션 식별은 status 가 아니라 origin='human'.
    const r = await one(db, `INSERT INTO domain(repo_id,key,name,description,state,cross_cutting,origin,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$8) RETURNING id`,
      [repo_id, d.key, d.name, d.description ?? "", d.state ?? "active", !!d.cross_cutting, actor.type, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "domain", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { key: d.key, name: d.name }, note: null,
    });
    return "insert";
  }
  // 비-agent 소유(origin∈{human,source}) 행은 agent 덮어쓰기 차단 — agent 자기 확정행만 정상 갱신(멱등 재인제스트).
  if (ex.origin !== "agent" && actor.type === "agent") {
    if (ex.name !== d.name || (ex.description || "") !== (d.description || "")) {
      await logChange(db, {
        repoId: repo_id, entityType: "domain", entityId: ex.id, op: "drift", actor, runId: run_id,
        before: { name: ex.name, description: ex.description },
        after: { name: d.name, description: d.description },
        note: "agent proposal differs from human-confirmed; kept human value",
      });
      return "drift";
    }
    return "unchanged";
  }
  if (ex.name === d.name && (ex.description || "") === (d.description || "")) return "unchanged";
  await logChange(db, {
    repoId: repo_id, entityType: "domain", entityId: ex.id, op: "update", actor, runId: run_id,
    before: { name: ex.name, description: ex.description },
    after: { name: d.name, description: d.description }, note: null,
  });
  await db.query("UPDATE domain SET name=$1,description=$2,updated_at=$3 WHERE id=$4", [d.name, d.description ?? "", now(), ex.id]);
  return "update";
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

async function upsertMapping(
  db: Db, repo_id: number, run_id: number, actor: Actor,
  target_kind: string, target_id: number, domain_id: number, confidence: number | null | undefined,
): Promise<string> {
  const ex = await one(db, "SELECT * FROM mapping WHERE repo_id=$1 AND target_kind=$2 AND target_id=$3 AND domain_id=$4",
    [repo_id, target_kind, target_id, domain_id]);
  if (!ex) {
    // 신뢰우선: 자동매핑은 proposed 림보 없이 곧바로 confirmed 로 착지. origin=actor.type 보존.
    const r = await one(db, `INSERT INTO mapping(repo_id,target_kind,target_id,domain_id,origin,confidence,status,run_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'confirmed',$7,$8,$8) RETURNING id`,
      [repo_id, target_kind, target_id, domain_id, actor.type, confidence ?? null, run_id, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "mapping", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { target_kind, target_id, domain_id }, note: null,
    });
    return "insert";
  }
  // 비-agent 소유(origin∈{human,source})거나 rejected 면 보존(kept-*) — agent 자기 확정행 재인제스트는 unchanged.
  // (매핑 행은 이 경로에서 갱신할 가변 필드가 없어 agent-confirmed 는 사실상 no-op = unchanged.)
  if (ex.origin !== "agent" || ex.status === "rejected") return "kept-" + ex.status;
  return "unchanged";
}

// Project = a change initiative (a "diff"/footprint over the repo). Upsert by
// (repo_id,key). Reconciliation-aware: once a human confirms a project, an agent
// re-run must not clobber its curated fields — divergence is logged as 'drift'
// and the human value is kept (mirrors upsertDomain).
async function upsertProject(db: Db, repo_id: number, run_id: number, actor: Actor, p: any): Promise<{ id: number; action: string }> {
  const ex = await one(db, "SELECT * FROM project WHERE repo_id=$1 AND key=$2", [repo_id, p.key]);
  if (!ex) {
    // P-V3-4b 네임스페이스 가드(M-나): doc-derived(code_grouping) 신규 key 가 PM-provenance 접두
    //  ('clickup-' 등)를 침범 못 하게 막는다 — initiative 의 키 공간 보존(붕뜸 재발 방지). 기존 행(ex)
    //  UPDATE 는 통과(이미 적재된 데이터 비파괴), 신규 INSERT 만 차단한다.
    if (isReservedProvenanceKey(p.key)) {
      throw httpErr(400, `project key '${p.key}' uses a reserved PM-provenance prefix — doc-derived(code_grouping) projects cannot use ${PROVENANCE_KEY_PREFIXES.join("/")} keys (those belong to connector-synced initiatives)`);
    }
    // 신뢰우선: 자동 정의 프로젝트는 proposed 림보 없이 곧바로 confirmed 로 착지. origin=actor.type 보존.
    // doc-derived 정의 경로 → provenance_kind='code_grouping'(P-V3-4b 붕뜸 해소).
    const r = await one(db, `INSERT INTO project(repo_id,key,name,description,kind,status,origin,provenance_kind,started_at,ended_at,source_ref,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'confirmed',$6,'code_grouping',$7,$8,$9,$10,$10) RETURNING id`,
      [repo_id, p.key, p.name, p.description ?? "", p.kind ?? null, actor.type,
       p.started_at ?? null, p.ended_at ?? null, p.source_ref ?? null, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "project", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { key: p.key, name: p.name, kind: p.kind ?? null }, note: null,
    });
    return { id: r.id, action: "insert" };
  }
  const cur = { name: ex.name, description: ex.description, kind: ex.kind, source_ref: ex.source_ref, started_at: ex.started_at, ended_at: ex.ended_at };
  const proposed = {
    name: p.name, description: p.description ?? "", kind: p.kind ?? ex.kind,
    source_ref: p.source_ref ?? ex.source_ref, started_at: p.started_at ?? ex.started_at, ended_at: p.ended_at ?? ex.ended_at,
  };
  // Normalize pg Date|ISO-string vs proposed ISO-string before comparing, mirroring
  // upsertProjectTouch — otherwise date-only re-runs are silently dropped (the UPDATE
  // does write started_at/ended_at) and confirmed-row drift on dates goes unlogged.
  // (의도적으로 projects.ts 의 sameInstant(epoch 비교)와 다르다 — 절대 통일하지 말 것.)
  const sameDate = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");
  const changed = cur.name !== proposed.name || (cur.description || "") !== (proposed.description || "")
    || (cur.kind || "") !== (proposed.kind || "") || (cur.source_ref || "") !== (proposed.source_ref || "")
    || !sameDate(cur.started_at, proposed.started_at) || !sameDate(cur.ended_at, proposed.ended_at);
  // 비-agent 소유(origin∈{human,source}) 행은 agent 덮어쓰기 차단 — agent 자기 확정행만 정상 갱신(멱등 재인제스트).
  if (ex.origin !== "agent" && actor.type === "agent") {
    if (changed) {
      await logChange(db, {
        repoId: repo_id, entityType: "project", entityId: ex.id, op: "drift", actor, runId: run_id,
        before: cur, after: proposed, note: "agent proposal differs from human-confirmed; kept human value",
      });
      return { id: ex.id, action: "drift" };
    }
    return { id: ex.id, action: "unchanged" };
  }
  if (!changed) return { id: ex.id, action: "unchanged" };
  await logChange(db, {
    repoId: repo_id, entityType: "project", entityId: ex.id, op: "update", actor, runId: run_id,
    before: cur, after: proposed, note: null,
  });
  await db.query("UPDATE project SET name=$1,description=$2,kind=$3,source_ref=$4,started_at=$5,ended_at=$6,updated_at=$7 WHERE id=$8",
    [proposed.name, proposed.description, proposed.kind, proposed.source_ref, proposed.started_at, proposed.ended_at, now(), ex.id]);
  return { id: ex.id, action: "update" };
}

// project_touch = "project P touched code_unit/data_entity X over commit_count
// commits between first_at..last_at". Upsert by (repo_id,target_kind,target_id,
// project_id). These are derived facts (git footprint), so a re-run refreshes the
// counts/window; every change is audited.
async function upsertProjectTouch(
  db: Db, repo_id: number, run_id: number, actor: Actor,
  target_kind: string, target_id: number, project_id: number, t: any,
): Promise<string> {
  const ex = await one(db, "SELECT * FROM project_touch WHERE repo_id=$1 AND target_kind=$2 AND target_id=$3 AND project_id=$4",
    [repo_id, target_kind, target_id, project_id]);
  const after = { commit_count: t.commit_count ?? null, first_at: t.first_at ?? null, last_at: t.last_at ?? null };
  if (!ex) {
    const r = await one(db, `INSERT INTO project_touch(repo_id,target_kind,target_id,project_id,commit_count,first_at,last_at,origin,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [repo_id, target_kind, target_id, project_id, after.commit_count, after.first_at, after.last_at, actor.type, now()]);
    await logChange(db, {
      repoId: repo_id, entityType: "project_touch", entityId: r.id, op: "insert", actor, runId: run_id,
      before: null, after: { target_kind, target_id, project_id, ...after }, note: null,
    });
    return "insert";
  }
  const before = { commit_count: ex.commit_count, first_at: ex.first_at, last_at: ex.last_at };
  const same = (before.commit_count ?? null) === (after.commit_count ?? null)
    && String(before.first_at ?? "") === String(after.first_at ?? "")
    && String(before.last_at ?? "") === String(after.last_at ?? "");
  if (same) return "unchanged";
  await logChange(db, {
    repoId: repo_id, entityType: "project_touch", entityId: ex.id, op: "update", actor, runId: run_id,
    before, after, note: null,
  });
  await db.query("UPDATE project_touch SET commit_count=$1,first_at=$2,last_at=$3 WHERE id=$4",
    [after.commit_count, after.first_at, after.last_at, ex.id]);
  return "update";
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

    for (const d of p.domains ?? []) bump("domain:" + await upsertDomain(client, repo_id, run_id, actor, d));
    const cuId: Record<string, number> = {}, deId: Record<string, number> = {};
    for (const u of p.code_units ?? []) { cuId[u.path] = await upsertCodeUnit(client, repo_id, u); bump("code_unit"); }
    for (const e of p.data_entities ?? []) { deId["model|" + e.name + "|" + (e.source ?? "")] = await upsertDataEntity(client, repo_id, e); bump("data_entity"); }
    for (const m of p.mappings ?? []) {
      const dom = await one(client, "SELECT id FROM domain WHERE repo_id=$1 AND key=$2", [repo_id, m.domain_key]);
      if (!dom) { bump("mapping:skip-nodomain"); continue; }
      const tid = m.target_kind === "code_unit" ? cuId[m.target] : deId["model|" + m.target + "|" + (m.target_source ?? "")];
      if (!tid) { bump("mapping:skip-notarget"); continue; }
      bump("mapping:" + await upsertMapping(client, repo_id, run_id, actor, m.target_kind, tid, dom.id, m.confidence));
    }
    for (const d of p.debts ?? []) bump("debt:" + await upsertDebtRow(client, repo_id, run_id, actor, d));

    // Projects (change initiatives). Upsert first so touches can resolve project_key.
    const projId: Record<string, number> = {};
    for (const pr of p.projects ?? []) {
      const res = await upsertProject(client, repo_id, run_id, actor, pr);
      projId[pr.key] = res.id;
      bump("project:" + res.action);
    }
    // Touches resolve target -> id (reusing this run's cuId/deId, falling back to
    // the DB for code_units/entities that already exist from a prior run) and
    // project_key -> project_id. Unresolved touches are skipped and tallied.
    for (const t of p.touches ?? []) {
      let pid = projId[t.project_key];
      if (pid == null) {
        const pr = await one(client, "SELECT id FROM project WHERE repo_id=$1 AND key=$2", [repo_id, t.project_key]);
        pid = pr?.id;
      }
      if (pid == null) { bump("touch:skip-noproject"); continue; }
      let tid;
      if (t.target_kind === "code_unit") {
        tid = cuId[t.target];
        if (tid == null) {
          const cu = await one(client, "SELECT id FROM code_unit WHERE repo_id=$1 AND path=$2", [repo_id, t.target]);
          tid = cu?.id;
        }
      } else if (t.target_kind === "data_entity") {
        tid = deId["model|" + t.target + "|" + (t.target_source ?? "")];
        if (tid == null) {
          // Fallback omits `kind` (touches carry none) and (name,source) can collide
          // across kinds, so pin a deterministic row with ORDER BY id LIMIT 1.
          // IS NOT DISTINCT FROM treats NULL/'' source consistently with upsert/key.
          const de = await one(client, `SELECT id FROM data_entity WHERE repo_id=$1 AND name=$2
            AND source IS NOT DISTINCT FROM $3 ORDER BY id LIMIT 1`,
            [repo_id, t.target, t.target_source ?? ""]);
          tid = de?.id;
        }
      } else { bump("touch:skip-badkind"); continue; }
      if (tid == null) { bump("touch:skip-notarget"); continue; }
      bump("touch:" + await upsertProjectTouch(client, repo_id, run_id, actor, t.target_kind, tid, pid, t));
    }

    await client.query("UPDATE scan_run SET finished_at=$1, summary=$2 WHERE id=$3", [now(), JSON.stringify(tally), run_id]);
    return { repo: p.repo.name, run_id, tally };
  });
}

// 도메인 생애주기 상태기계(active|merged|deprecated)와 큐레이션 — store-core.mjs 이식.
// mergeDomains 의 mapping UPDATE 는 매핑 큐레이션이 아니라 도메인 생애주기 시맨틱의 일부 —
// 트랜잭션을 모듈 경계로 쪼개지 않는다(fold 시맨틱 포함 이 파일 소유).
import { dmPool, one, q, withTx } from "../db.js";
import {
  httpErr, syncBlockedRepos, type Actor, type CreateDomainResult, type CurationResult,
  type DomainDeleteResult, type DomainEditResult, type DomainSetResult, type DomainStateResult,
  type MergeResult, type ProposeDomainResult, type RenameDomainResult,
} from "./types.js";
import { logChange } from "./changelog.js";
import { getRepo } from "./repos.js";
import { resolveDomainKey } from "./domain-alias.js";

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

const now = () => new Date().toISOString();

// Edit a domain by its numeric id; stamp the editing actor's origin.
// HUMAN path (default): auto-confirm + origin='human' — byte-compat with the original behavior.
// AGENT path (actor.type==='agent'): may ONLY edit non-human-owned rows, and the edit
// keeps the row's current status (P6a trust-default: agent-authored rows already land
// confirmed, so the agent edits its own confirmed rows in place; human curation owns the
// transition to origin='human').
// Agent edit on a non-agent-owned row (origin≠'agent', i.e. human-curated) => 403
// (human-curated definitions are agent-immutable here; agents must go through drift/propose
// flows instead). Domains are never origin='source' (only syncProject sets that, on projects).
export async function editDomainById(id: number, patch: Record<string, unknown>, actor: Actor): Promise<DomainEditResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  const isAgent = actor.type === "agent";
  if (isAgent && ex.origin !== "agent") {
    throw httpErr(403, `agent cannot edit a human-curated domain: ${id} (human curation owns it)`);
  }
  const origin = isAgent ? "agent" : "human";
  const status = isAgent ? ex.status : "confirmed"; // agent: keep current status; human: confirm + own (기존 거동)
  const before = { name: ex.name, description: ex.description, cross_cutting: ex.cross_cutting, status: ex.status, origin: ex.origin };
  const name = patch.name ?? ex.name;
  const description = patch.description ?? ex.description;
  const cross_cutting = patch.cross_cutting ?? ex.cross_cutting;
  const after = { name, description, cross_cutting, status, origin };
  await pool.query("UPDATE domain SET name=$1,description=$2,cross_cutting=$3,status=$4,origin=$5,updated_at=$6 WHERE id=$7",
    [name, description, cross_cutting, status, origin, now(), id]);
  const note = isAgent ? "agent edit (kept status)" : `${origin} edit (auto-confirm)`;
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "domain", entityId: id, op: "update", actor, before, after, note,
  });
  return { id, change_id: cid, after };
}

// Day-2 domain authoring: create a single domain with REQUIRED evidence.
// P6a 신뢰우선(trust-default): proposed 림보 없이 곧바로 status='confirmed' 로 착지하고
// origin=actor.type 로 '누가 만들었나'를 보존(evidence 는 게이트가 아니라 provenance 로 유지).
// 사람은 사후에 edit/deprecate/merge 로 큐레이션한다(reject 경로는 매핑 단위로 유지).
// The evidence is persisted in change_log.note (no schema addition) — surfaced via history.
// Reuses the SYNC_BLOCKED_REPOS deny-list (store-level guard: HTTP route, CLI and any
// future entrypoint all pass through here).
// INSERT mirrors reconcile.upsertDomain's columns; state='active' is explicit because
// every domain read filters state<>'merged' (NULL-hostile under future filters).
export async function proposeDomain(repoName: string, fields: Record<string, unknown> | null | undefined, actor: Actor): Promise<ProposeDomainResult> {
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is write-protected (domain authoring blocked; see SYNC_BLOCKED_REPOS)`);
  }
  const bad = (msg: string) => { throw httpErr(400, msg); };
  const f = fields ?? {};
  const key = typeof f.key === "string" ? f.key.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(key)) bad(`bad key: '${key}' (lowercase slug a-z0-9 and '-', 1~100 chars)`);
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name || name.length > 200) bad("name required (1~200 chars)");
  const evidence = typeof f.evidence === "string" ? f.evidence.trim() : "";
  if (!evidence) bad("evidence required (non-empty, why this domain should exist)");
  if (evidence.length > 4000) bad("evidence too long (max 4000 chars)");
  const description = f.description == null ? "" : String(f.description);
  if (description.length > 4000) bad("description too long (max 4000 chars)");
  const pool = dmPool();
  const r = await getRepo(repoName); // 404 on unknown repo
  const ex = await one(pool, "SELECT id FROM domain WHERE repo_id=$1 AND key=$2", [r.id, key]);
  if (ex) throw httpErr(409, `domain key already exists in repo '${repoName}': ${key} (#${ex.id})`);
  const row = await one(pool, `INSERT INTO domain(repo_id,key,name,description,state,cross_cutting,origin,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'active',$5,$6,'confirmed',$7,$7) RETURNING id`,
    [r.id, key, name, description, !!f.cross_cutting, actor.type, now()]);
  const cid = await logChange(pool, {
    repoId: r.id, entityType: "domain", entityId: row.id, op: "insert", actor,
    before: null, after: { key, name, status: "confirmed" }, note: "propose (evidence): " + evidence,
  });
  return { repo: repoName, id: row.id, key, status: "confirmed", change_id: cid };
}

// P-V3-4a 통제어휘 CRUD: createDomain — repo 하위에 도메인 1개를 만든다(통제어휘 집합 확장).
// proposeDomain 과의 차이: evidence 게이트가 없다(통제어휘 채워넣기 — '왜 필요한지' 근거 요구는
//  propose 의 day-2 authoring 의도이고, create 는 어휘 관리 UI 의 단순 추가). 중복/형식 검증 + 보호 리포
//  가드(SYNC_BLOCKED_REPOS — proposeDomain 과 동일 단일 가드)는 동일. 신뢰우선: status='confirmed'
//  착지 + origin=actor.type. INSERT 컬럼은 proposeDomain/reconcile.upsertDomain 과 동일(state='active').
// 중복검사는 물리 key 직접 비교 + alias 해소(옛 별칭으로 잡혀 있는 key 재사용도 막음).
export async function createDomain(repoName: string, fields: Record<string, unknown> | null | undefined, actor: Actor): Promise<CreateDomainResult> {
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is write-protected (domain create blocked; see SYNC_BLOCKED_REPOS)`);
  }
  const bad = (msg: string) => { throw httpErr(400, msg); };
  const f = fields ?? {};
  const key = typeof f.key === "string" ? f.key.trim() : "";
  if (!KEY_RE.test(key)) bad(`bad key: '${key}' (lowercase slug a-z0-9 and '-', 1~100 chars)`);
  const name = typeof f.name === "string" ? f.name.trim() : "";
  if (!name || name.length > 200) bad("name required (1~200 chars)");
  const description = f.description == null ? "" : String(f.description);
  if (description.length > 4000) bad("description too long (max 4000 chars)");
  // V4-P1 area 2단(B): space — 'product'(코드앵커 도메인, 기본) | 'business'(코드매핑 없는 비즈니스 기능).
  //  미지정·빈값은 'product'(domainmap 본래 의미 유지 — 기존 거동 byte-compat). enum 밖이면 400.
  const space = f.space == null || f.space === "" ? "product" : String(f.space);
  if (space !== "product" && space !== "business") bad(`bad space: '${space}' (allowed: product|business)`);
  const pool = dmPool();
  const r = await getRepo(repoName); // 404 on unknown repo
  // alias 해소: 옛 별칭으로도 같은 도메인을 가리키면 중복(예: old_key 가 'billing' alias 인데 'billing' 재생성).
  const canon = await resolveDomainKey(r.id, key, pool);
  const ex = await one(pool, "SELECT id,key FROM domain WHERE repo_id=$1 AND key=$2", [r.id, canon]);
  if (ex) throw httpErr(409, `domain key already exists in repo '${repoName}': ${key} (#${ex.id})`);
  const aliasRow = await one(pool, "SELECT id FROM domain_alias WHERE repo_id=$1 AND old_key=$2", [r.id, key]);
  if (aliasRow) throw httpErr(409, `domain key '${key}' is a rename-alias in repo '${repoName}' — choose a different key`);
  const row = await one(pool, `INSERT INTO domain(repo_id,key,name,description,state,cross_cutting,origin,status,space,created_at,updated_at)
    VALUES($1,$2,$3,$4,'active',$5,$6,'confirmed',$7,$8,$8) RETURNING id`,
    [r.id, key, name, description, !!f.cross_cutting, actor.type, space, now()]);
  const cid = await logChange(pool, {
    repoId: r.id, entityType: "domain", entityId: row.id, op: "insert", actor,
    before: null, after: { key, name, status: "confirmed" }, note: "create domain (controlled vocab)",
  });
  return { repo: repoName, id: row.id, key, status: "confirmed", change_id: cid };
}

// P-V3-4a domain_rename = soft-alias(H3). 물리 domain.key 는 절대 바꾸지 않는다 — items DB
// (knowledge_unit.domain_key) 와 domainmap DB 는 별 DB라 cross-DB 트랜잭션으로 양쪽 key 를 원자적으로
// 못 바꾼다. 대신 (a) 표시명(domain.name)을 newName 으로 갱신(선택), (b) newKey 가 물리 key 와 다르면
// (old=물리key → new=newKey) 별칭을 적재해 '사람이 이제부터 부르고 싶은 새 슬러그'로도 이 도메인을
// 찾게 한다. 물리 cascade 금지 — knowledge_unit 의 옛 domain_key 값은 그대로 두고 resolveDomainKey 가
// 양방향 중 'old→canonical' 방향을 해소한다. (UI 가 새 슬러그로 저장하면 그 값이 alias old_key 가 되어
// 다시 canonical 로 접힌다.)
// agent 가 human-소유(origin='human') 도메인을 rename → 403(human 큐레이션 불가침, edit/deprecate 와 동일).
// 보호 리포 가드(SYNC_BLOCKED_REPOS) 동일.
export async function renameDomain(
  id: number, patch: { newKey?: string; newName?: string }, actor: Actor,
): Promise<RenameDomainResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  if (ex.state === "merged") throw httpErr(400, "cannot rename a merged domain: " + id);
  const repoRow = await one(pool, "SELECT name FROM repo WHERE id=$1", [ex.repo_id]);
  const repoName = repoRow?.name ?? "";
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is write-protected (domain rename blocked; see SYNC_BLOCKED_REPOS)`);
  }
  const isAgent = actor.type === "agent";
  if (isAgent && ex.origin === "human") {
    throw httpErr(403, `agent cannot rename a human-curated domain: ${id} (human curation owns it)`);
  }
  const bad = (msg: string) => { throw httpErr(400, msg); };
  const newName = patch.newName != null ? String(patch.newName).trim() : undefined;
  if (newName !== undefined && (!newName || newName.length > 200)) bad("newName required (1~200 chars)");
  const rawNewKey = patch.newKey != null ? String(patch.newKey).trim() : undefined;
  if (rawNewKey !== undefined && !KEY_RE.test(rawNewKey)) bad(`bad newKey: '${rawNewKey}' (lowercase slug a-z0-9 and '-', 1~100 chars)`);
  if (newName === undefined && rawNewKey === undefined) bad("nothing to rename — provide newKey and/or newName");

  return withTx(async (client) => {
    let aliased = false;
    const physicalKey = ex.key as string;
    // newKey 가 물리 key 와 다르면 (물리key → newKey) 별칭 적재. 단 newKey 가 다른 살아있는 도메인의
    // 물리 key 거나 다른 별칭의 old_key 면 충돌(409) — 한 슬러그가 두 도메인을 가리키게 둘 수 없다.
    if (rawNewKey !== undefined && rawNewKey !== physicalKey) {
      const clashDomain = await one(client, "SELECT id FROM domain WHERE repo_id=$1 AND key=$2 AND id<>$3 AND state<>'merged'", [ex.repo_id, rawNewKey, id]);
      if (clashDomain) throw httpErr(409, `newKey '${rawNewKey}' already used by domain #${clashDomain.id} in repo '${repoName}'`);
      const clashAlias = await one(client, "SELECT new_key FROM domain_alias WHERE repo_id=$1 AND old_key=$2", [ex.repo_id, rawNewKey]);
      if (clashAlias && clashAlias.new_key !== physicalKey) {
        throw httpErr(409, `newKey '${rawNewKey}' is already an alias pointing elsewhere in repo '${repoName}'`);
      }
      // 멱등: 같은 별칭이 이미 있으면 INSERT 생략. UNIQUE(repo_id, old_key) 덕에 ON CONFLICT 안전.
      await client.query(
        `INSERT INTO domain_alias(repo_id,old_key,new_key,created_at) VALUES($1,$2,$3,$4)
         ON CONFLICT (repo_id, old_key) DO UPDATE SET new_key=EXCLUDED.new_key`,
        [ex.repo_id, rawNewKey, physicalKey, now()]);
      aliased = true;
    }
    const finalName = newName ?? ex.name;
    if (newName !== undefined) {
      await client.query("UPDATE domain SET name=$1,updated_at=$2 WHERE id=$3", [finalName, now(), id]);
    }
    const cid = await logChange(client, {
      repoId: ex.repo_id, entityType: "domain", entityId: id, op: "rename", actor,
      before: { key: physicalKey, name: ex.name },
      after: { key: physicalKey, name: finalName, ...(aliased ? { alias: rawNewKey } : {}) },
      note: aliased
        ? `rename (soft-alias): '${rawNewKey}' → physical '${physicalKey}'${newName !== undefined ? `; name '${ex.name}'→'${finalName}'` : ""}`
        : `rename (name only): '${ex.name}'→'${finalName}'`,
    });
    return {
      repo: repoName, id, key: physicalKey, old_key: physicalKey,
      new_key: rawNewKey ?? physicalKey, aliased, change_id: cid, after: { name: finalName },
    };
  });
}

// Domain lifecycle: active <-> deprecated. 'merged' rows are terminal (mergeDomains
// owns that transition) — refuse to touch them. RESTORE_COLUMNS.domain already
// includes 'state', so /restore round-trips deprecate/undeprecate without changes.
// NOTE: deprecated domains stay visible in every list read (only state<>'merged' is
// filtered) and bestDomainByTarget deliberately does NOT exclude them — existing
// mappings remain valid; deprecation is a curation signal, not a delete.
export async function setDomainState(id: number, state: string, actor: Actor): Promise<DomainStateResult> {
  if (state !== "active" && state !== "deprecated") {
    throw httpErr(400, `bad state: ${state} (allowed: active|deprecated)`);
  }
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  if (ex.state === "merged") throw httpErr(400, "cannot change state of a merged domain: " + id);
  // 보호 리포 가드(agent 한정) — proposeDomain 의 SYNC_BLOCKED_REPOS 거부와 동일 원칙.
  // lifecycle 변경(가역·감사됨)이지만 보호 리포의 human-confirmed 도메인을 에이전트가 deprecate
  // 할 수 있던 비대칭을 막는다. human(웹) 경로는 기존 거동 그대로. 스토어 단일 가드 관례 유지.
  if (actor?.type === "agent") {
    const r = await one(pool, "SELECT name FROM repo WHERE id=$1", [ex.repo_id]);
    if (r && syncBlockedRepos().has(r.name)) {
      throw httpErr(403, `repo '${r.name}' is write-protected (agent domain lifecycle change blocked; see SYNC_BLOCKED_REPOS)`);
    }
  }
  // no-op 은 change_id 없는 별도 shape — 키 부재가 계약(추가 금지).
  if ((ex.state ?? "active") === state) return { id, action: "unchanged", state };
  await pool.query("UPDATE domain SET state=$1,updated_at=$2 WHERE id=$3", [state, now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "domain", entityId: id, op: "update", actor,
    before: { state: ex.state }, after: { state },
    note: state === "deprecated" ? "deprecate domain" : "undeprecate domain",
  });
  return { id, change_id: cid, state };
}

// domainDeleteRefs — hard-delete 가드 사전조회(삭제 없음). 도메인 key/repo + domainmap-DB 쪽 살아있는
//  (status<>'rejected') mapping 카운트를 반환한다. capability 가 이걸 cross-DB(kud/ku) 카운트와 합산해
//  '연결 있으면 막고 카운트 안내'(blocked) 판정을 내린다(가드 결정은 한 곳=capability). merged/보호리포/없음은 throw.
export interface DomainDeleteRefs { id: number; key: string; repo: string; repo_id: number; liveMappings: number }
export async function domainDeleteRefs(id: number): Promise<DomainDeleteRefs> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  if (ex.state === "merged") throw httpErr(400, "cannot hard-delete a merged domain: " + id);
  const repoRow = await one(pool, "SELECT name FROM repo WHERE id=$1", [ex.repo_id]);
  const repoName = repoRow?.name ?? "";
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is write-protected (domain hard-delete blocked; see SYNC_BLOCKED_REPOS)`);
  }
  const live = await one(pool,
    "SELECT COUNT(*)::int AS n FROM mapping WHERE domain_id=$1 AND status<>'rejected'", [id]);
  return { id, key: ex.key, repo: repoName, repo_id: ex.repo_id, liveMappings: Number(live?.n) || 0 };
}

// hardDeleteDomain — 도메인 영구삭제 실행(deprecate=숨김 보존과 구분). domainmap-DB cascade 만 여기 책임
//  (cross-DB kud/ku 클리어는 capability 가 org/knowledge.clearDomainKnowledgeRefs 로). 가드 결정은 호출 전
//  domainDeleteRefs 로 capability 가 내린다 — 이 함수는 항상 cascade 한다(force 전제). merged/없음은 재확인 throw.
//  cascade: 모든 mapping(rejected 포함 — 도메인이 사라지므로 잔류 무의미) + 물리key 별칭 + 도메인 행을 한 TX 에서.
//  ⚠ alias 는 new_key=물리key 로 적재되므로(soft-alias) 물리 key 로 가리키는 별칭 전부를 지운다.
export async function hardDeleteDomain(id: number, actor: Actor): Promise<DomainDeleteResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  if (ex.state === "merged") throw httpErr(400, "cannot hard-delete a merged domain: " + id);
  const repoRow = await one(pool, "SELECT name FROM repo WHERE id=$1", [ex.repo_id]);
  const repoName = repoRow?.name ?? "";
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is write-protected (domain hard-delete blocked; see SYNC_BLOCKED_REPOS)`);
  }
  return withTx(async (client) => {
    const delMap = await client.query("DELETE FROM mapping WHERE domain_id=$1", [id]);
    const delAlias = await client.query("DELETE FROM domain_alias WHERE repo_id=$1 AND new_key=$2", [ex.repo_id, ex.key]);
    await client.query("DELETE FROM domain WHERE id=$1", [id]);
    await logChange(client, {
      repoId: ex.repo_id, entityType: "domain", entityId: id, op: "delete", actor,
      before: { key: ex.key, name: ex.name, state: ex.state },
      after: null,
      note: `hard-delete domain '${ex.key}' (cascade mappings=${delMap.rowCount ?? 0}, aliases=${delAlias.rowCount ?? 0})`,
    });
    return {
      deleted: true, id, key: ex.key, repo: repoName,
      removed: { mappings: delMap.rowCount ?? 0, aliases: delAlias.rowCount ?? 0 },
    };
  });
}

// CLI convenience: edit a domain by (repo, key). Wraps editDomainById.
export async function domainSet(repo: string, key: string, flags: Record<string, unknown>, actor: Actor): Promise<DomainSetResult> {
  const r = await getRepo(repo);
  const ex = await one(dmPool(), "SELECT id FROM domain WHERE repo_id=$1 AND key=$2", [r.id, key]);
  if (!ex) throw httpErr(404, "no such domain: " + key);
  const patch: Record<string, unknown> = {};
  if (flags.name) patch.name = flags.name;
  if (flags.description) patch.description = flags.description;
  if (flags.cross_cutting != null) patch.cross_cutting = flags.cross_cutting === true || flags.cross_cutting === "true";
  const res = await editDomainById(ex.id, patch, actor);
  return { domain: key, ...res };
}

// Confirm a domain (no field edits) — mark confirmed + human-owned.
export async function confirmDomain(id: number, actor: Actor): Promise<CurationResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM domain WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such domain: " + id);
  const before = { status: ex.status, origin: ex.origin };
  const after = { status: "confirmed", origin: "human" };
  await pool.query("UPDATE domain SET status=$1,origin=$2,updated_at=$3 WHERE id=$4", ["confirmed", "human", now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "domain", entityId: id, op: "update", actor,
    before, after, note: "human confirm",
  });
  return { id, change_id: cid };
}

// Merge: move from's mappings + debts to into; mark from as merged.
// All writes run inside ONE transaction so a clash/failure mid-merge can't leave
// some mappings reassigned and others not.
export async function mergeDomains(from_id: number, into_id: number, actor: Actor): Promise<MergeResult> {
  if (Number(from_id) === Number(into_id)) throw httpErr(400, "cannot merge a domain into itself");
  return withTx(async (client) => {
    const from = await one(client, "SELECT * FROM domain WHERE id=$1", [from_id]);
    const into = await one(client, "SELECT * FROM domain WHERE id=$1", [into_id]);
    if (!from) throw httpErr(404, "no such source domain: " + from_id);
    if (!into) throw httpErr(404, "no such target domain: " + into_id);
    if (from.repo_id !== into.repo_id) throw httpErr(400, "domains belong to different repos");

    // Select each mapping's real status + origin so the audit 'before' reflects
    // the true prior state (not a hardcoded 'proposed').
    const moved = await q(client, "SELECT id, target_kind, target_id, domain_id, status, origin FROM mapping WHERE domain_id=$1", [from_id]);
    let reassigned = 0, folded = 0;
    for (const m of moved) {
      // Respect UNIQUE(repo_id,target_kind,target_id,domain_id): if `into` already
      // maps this same target, moving would violate the constraint. Fold the source
      // mapping (mark rejected) instead of throwing mid-merge and leaving partial state.
      // fold 행은 from 도메인에 rejected 로 잔류(domain_id 불변) — 시맨틱 보존.
      const clash = await one(client,
        "SELECT id FROM mapping WHERE repo_id=$1 AND target_kind=$2 AND target_id=$3 AND domain_id=$4",
        [from.repo_id, m.target_kind, m.target_id, into_id]);
      if (clash) {
        await client.query("UPDATE mapping SET status=$1,updated_at=$2 WHERE id=$3", ["rejected", now(), m.id]);
        await logChange(client, {
          repoId: from.repo_id, entityType: "mapping", entityId: m.id, op: "merge", actor,
          before: { domain_id: from_id, status: m.status, origin: m.origin },
          after: { domain_id: from_id, status: "rejected" },
          note: `merge ${from_id}->${into_id}: duplicate target already mapped to #${into_id}; folded`,
        });
        folded++;
      } else {
        await client.query("UPDATE mapping SET domain_id=$1,updated_at=$2 WHERE id=$3", [into_id, now(), m.id]);
        await logChange(client, {
          repoId: from.repo_id, entityType: "mapping", entityId: m.id, op: "merge", actor,
          before: { domain_id: from_id, status: m.status, origin: m.origin },
          after: { domain_id: into_id }, note: `merged from domain #${from_id}`,
        });
        reassigned++;
      }
    }
    const beforeState = { state: from.state };
    await client.query("UPDATE domain SET state='merged',updated_at=$1 WHERE id=$2", [now(), from_id]);
    const cid = await logChange(client, {
      repoId: from.repo_id, entityType: "domain", entityId: from_id, op: "merge", actor,
      before: beforeState, after: { state: "merged", merged_into: into_id }, note: `merged into domain #${into_id}`,
    });
    return { from_id, into_id, moved_mappings: reassigned, folded_mappings: folded, change_id: cid };
  });
}

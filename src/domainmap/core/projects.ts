// 커넥터 싱크 경로(tool-is-master)와 프로젝트 확정 — store-core.mjs 이식.
// sync 는 reconcile 과 정반대 정책(도구가 마스터, drift 가드 없음) — reconcile.ts 와 절대 섞지 않는다.
// 비교 함수도 의도적으로 다르다: 여기는 canonJson(재귀 키정렬)/sameInstant(epoch),
// reconcile.upsertProject 는 String() 비교 — 통일하려는 유혹이 최대 리스크(블루프린트 명시).
import { dmPool, one, withTx } from "../db.js";
import { httpErr, syncBlockedRepos, type Actor, type CurationResult, type SyncProjectResult } from "./types.js";
import { logChange } from "./changelog.js";

const now = () => new Date().toISOString();

// Connector-driven project sync (PM tool → store). SINGLE-MASTER: the tool is
// master for name/state (+description/external_url/kind/fields/dates) — this is
// deliberately NOT reconcile.upsertProject (whose confirmed+agent guard would drop tool
// updates as 'drift'; here the tool IS the declared truth). Synced projects land
// status='confirmed' (the org already declared them in the tool) with
// origin='source' — forever distinguishable from 'human'(curation) and
// 'agent'(inference). Every field change is logged to change_log (op insert/update);
// an unchanged re-sync only touches last_synced_at/raw (timestamp touch ≠ change).
const SYNC_STATES = new Set(["active", "completed", "archived", "cancelled"]);
const slugKey = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// jsonb 는 객체 키를 재정렬해 저장하므로(길이→바이트 순) 원문 JSON.stringify 비교는 키 순서만 달라도
// '변경'으로 오판한다 — 커넥터가 매번 같은 fields 를 보내도 영원히 'update'가 찍히는 churn. 재귀 키 정렬로
// 정규화한 뒤 비교한다(jsonb 동등성과 같은 의미; undefined/null 은 null 로 수렴).
const canonJson = (v: any): string => {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  if (typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
  return JSON.stringify(v);
};
const sameJsonCanon = (a: unknown, b: unknown) => canonJson(a) === canonJson(b);
// pg 의 timestamptz 는 JS Date 로 돌아오고 커넥터는 ISO 문자열을 보낸다 — String 비교는 항상 불일치(영구
// churn). epoch 으로 정규화해 같은 순간인지 비교한다(파싱 불가 값은 NaN!==NaN 으로 '변경' 처리 — 안전 폴백).
const sameInstant = (a: any, b: any) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return new Date(a).getTime() === new Date(b).getTime();
};

export async function syncProject(repoName: string, payload: unknown, actor: Actor | null | undefined): Promise<SyncProjectResult> {
  if (syncBlockedRepos().has(repoName)) {
    throw httpErr(403, `repo '${repoName}' is sync-protected (connector sync write-blocked; see SYNC_BLOCKED_REPOS)`);
  }
  const p: any = typeof payload === "string" ? JSON.parse(payload) : payload;
  const bad = (msg: string) => { throw httpErr(400, msg); };
  for (const f of ["prov_system", "external_id", "name"]) {
    if (typeof p?.[f] !== "string" || !p[f].trim()) bad(`${f} required (non-empty string)`);
  }
  const state = p.state ?? null;
  if (state !== null && !SYNC_STATES.has(state)) bad(`bad state: ${state} (allowed: ${[...SYNC_STATES].join("|")} or null)`);
  for (const f of ["fields", "raw"]) {
    if (p[f] != null && (typeof p[f] !== "object" || Array.isArray(p[f]))) bad(`${f} must be an object`);
  }
  const prov_system = p.prov_system.trim();
  const prov_instance = p.prov_instance ?? null; // NULLS NOT DISTINCT index makes NULL self-consistent
  const external_id = p.external_id.trim();
  const act: Actor = actor ?? { type: "agent", id: "agent" };

  try {
    return await withTx(async (client) => {
      const repo = await one(client, "SELECT * FROM repo WHERE name=$1", [repoName]);
      if (!repo) throw httpErr(404, "no such repo: " + repoName);
      const ex = await one(client,
        `SELECT * FROM project WHERE repo_id=$1 AND prov_system=$2
           AND prov_instance IS NOT DISTINCT FROM $3 AND external_id=$4`,
        [repo.id, prov_system, prov_instance, external_id]);

      if (!ex) {
        // INSERT — deterministic key (prov_system prefix avoids collision with doc-derived keys).
        const key = p.key ?? slugKey(`${prov_system}-${external_id}`);
        const r = await one(client,
          `INSERT INTO project(repo_id,key,name,description,kind,status,origin,
                               prov_system,prov_instance,external_id,external_url,state,fields,raw,
                               started_at,ended_at,last_synced_at,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,'confirmed','source',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$15) RETURNING id`,
          [repo.id, key, p.name, p.description ?? "", p.kind ?? "initiative",
           prov_system, prov_instance, external_id, p.external_url ?? null, state,
           p.fields != null ? JSON.stringify(p.fields) : null, p.raw != null ? JSON.stringify(p.raw) : null,
           p.started_at ?? null, p.ended_at ?? null, now()]);
        const cid = await logChange(client, {
          repoId: repo.id, entityType: "project", entityId: r.id, op: "insert", actor: act,
          before: null, after: { key, name: p.name, state, prov_system, external_id },
          note: "connector sync: declared in tool",
        });
        return { repo: repoName, id: r.id, key, action: "insert", change_id: cid };
      }

      // UPDATE — tool is master; raw excluded from snapshots (bloat), refreshed silently.
      // 비교는 반드시 정규화 동등성(sameJsonCanon/sameInstant) — jsonb 키 재정렬·pg Date vs ISO 문자열이
      // '항상 다름'으로 보이면 '변경 없는 재싱크는 timestamp touch 만'이라는 설계가 깨지고 change_log 가 오염된다.
      const proposed = {
        name: p.name,
        description: p.description ?? ex.description,
        kind: p.kind ?? ex.kind,
        state,
        external_url: p.external_url ?? ex.external_url,
        fields: p.fields ?? ex.fields,
        started_at: p.started_at ?? ex.started_at,
        ended_at: p.ended_at ?? ex.ended_at,
        status: "confirmed",
        origin: "source",
      };
      const changed = ex.name !== proposed.name
        || (ex.description || "") !== (proposed.description || "")
        || (ex.kind || "") !== (proposed.kind || "")
        || (ex.state ?? null) !== proposed.state
        || (ex.external_url ?? null) !== (proposed.external_url ?? null)
        || !sameJsonCanon(ex.fields ?? null, proposed.fields ?? null)
        || !sameInstant(ex.started_at, proposed.started_at)
        || !sameInstant(ex.ended_at, proposed.ended_at)
        || ex.status !== "confirmed" || ex.origin !== "source";
      if (!changed) {
        await client.query("UPDATE project SET last_synced_at=$1, raw=COALESCE($2,raw) WHERE id=$3",
          [now(), p.raw != null ? JSON.stringify(p.raw) : null, ex.id]);
        // unchanged 응답에 change_id 키 부재가 계약(키 추가 금지).
        return { repo: repoName, id: ex.id, key: ex.key, action: "unchanged" };
      }
      const before = {
        name: ex.name, description: ex.description, kind: ex.kind, state: ex.state ?? null,
        external_url: ex.external_url ?? null, fields: ex.fields ?? null,
        started_at: ex.started_at, ended_at: ex.ended_at, status: ex.status, origin: ex.origin,
      };
      await client.query(
        `UPDATE project SET name=$1,description=$2,kind=$3,state=$4,external_url=$5,fields=$6,
           started_at=$7,ended_at=$8,status='confirmed',origin='source',
           raw=COALESCE($9,raw),last_synced_at=$10,updated_at=$10 WHERE id=$11`,
        [proposed.name, proposed.description, proposed.kind, proposed.state, proposed.external_url ?? null,
         proposed.fields != null ? JSON.stringify(proposed.fields) : null,
         proposed.started_at, proposed.ended_at,
         p.raw != null ? JSON.stringify(p.raw) : null, now(), ex.id]);
      const cid = await logChange(client, {
        repoId: repo.id, entityType: "project", entityId: ex.id, op: "update", actor: act,
        before, after: proposed, note: "connector sync (tool is master); raw refreshed",
      });
      return { repo: repoName, id: ex.id, key: ex.key, action: "update", change_id: cid };
    });
  } catch (e: any) {
    // unique 충돌을 불투명 500 대신 409 로: (a) project_provenance_uq 는 전역(repo_id 미포함)이라 같은
    // 외부 객체를 다른 리포에 싱크하면 repo-scoped SELECT 미스 후 INSERT 가 충돌하고, (b) 동시 최초 싱크
    // 경합, (c) 클라이언트 지정 p.key 의 UNIQUE(repo_id,key) 충돌도 여기로 온다. 소유 리포를 찾아 알려준다.
    if (e?.code === "23505") {
      const own = await one(dmPool(),
        `SELECT r.name AS repo, p.key FROM project p JOIN repo r ON r.id=p.repo_id
          WHERE p.prov_system=$1 AND p.prov_instance IS NOT DISTINCT FROM $2 AND p.external_id=$3`,
        [prov_system, prov_instance, external_id],
      ).catch(() => null);
      throw httpErr(409, own
        ? `conflict: ${prov_system}/${external_id} already synced into repo '${own.repo}' (key '${own.key}') — provenance is unique across repos`
        : `conflict: duplicate key on project sync (${e.constraint ?? "unique violation"}) — retry or pick another key`);
    }
    throw e;
  }
}

// Confirm a project (no field edits) — mark confirmed + human-owned.
// Mirrors confirmDomain; RESTORE_COLUMNS.project already covers undo via /restore.
export async function confirmProject(id: number, actor: Actor): Promise<CurationResult> {
  const pool = dmPool();
  const ex = await one(pool, "SELECT * FROM project WHERE id=$1", [id]);
  if (!ex) throw httpErr(404, "no such project: " + id);
  const before = { status: ex.status, origin: ex.origin };
  const after = { status: "confirmed", origin: "human" };
  await pool.query("UPDATE project SET status=$1,origin=$2,updated_at=$3 WHERE id=$4", ["confirmed", "human", now(), id]);
  const cid = await logChange(pool, {
    repoId: ex.repo_id, entityType: "project", entityId: id, op: "update", actor,
    before, after, note: "human confirm",
  });
  return { id, change_id: cid };
}

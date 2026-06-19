// item 폐기·ku 컷오버 — 매핑 큐레이션의 ku-좌표(knowledge_unit.name) 단일 쓰기/읽기 경로.
//
//   store.ts 의 item_domain 가드레일(propose/confirm/reject)을
//   knowledge_unit_domain 로 1:1 포팅하되, **좌표를 itemId(BIGINT) → name(TEXT, ku 내부 PK)** 로
//   바꾼다. 매핑 큐레이션이 item 테이블을 전혀 읽지/쓰지 않게 만드는 컷오버의 코어.
//
//   동일 가드레일(불변식 보존):
//     · provenance rank(rule<llm<manual=declared) — 재실행이 강한 출처를 약한 출처로 강등 금지.
//     · ON CONFLICT WHERE 가 confirmed/manual 행 보호(조용한 손상 금지), rejected 행은 rule/llm/manual
//       재제안 영구차단(부활은 confirm 뿐), declared(툴 구조 마스터)는 rejected/manual 도 덮되 별도 액션 감사.
//     · 모든 쓰기는 knowledge_unit_mapping_audit(append-only)에 검증경로 통과를 기록 — CTE 원자(감사 없는 쓰기 불가).
//     · vocab 검증(loadCandidates/validateDomainKey)은 item 무의존 — 그대로 재사용.
//   참조 존재 검증: `SELECT 1 FROM item WHERE id` → `SELECT 1 FROM knowledge_unit WHERE name`.
import { itemsPool } from "../items/store.js";
import { resolveRepo } from "../domainmap/core/types.js";
import {
  loadCandidates, validateDomainKey, type Candidates,
} from "../items/mapping-candidates.js";
import { logger } from "../log.js";

export type MappedBy = "rule" | "llm" | "manual" | "declared";
export interface AuditCtx { source?: string; actor?: string }
function auditDefaults(a?: AuditCtx): { source: string; actor: string } {
  return {
    source: a?.source ?? "unknown",
    actor: a?.actor ?? process.env.USER ?? process.env.LOGNAME ?? "unknown",
  };
}

export interface ProposeResult {
  name: string; repo: string; key: string; mappedBy: string; state: string;
  action: "inserted" | "refreshed" | "skipped-confirmed" | "skipped-manual" | "skipped-rejected" | "skipped-provenance";
}

// provenance 우선순위 rule < llm < manual=declared(rank 3). SQL CASE 로 강등 방지.
const PROVENANCE_RANK_SQL = `CASE WHEN mapped_by='manual' THEN 3 WHEN mapped_by='declared' THEN 3 WHEN mapped_by='llm' THEN 2 ELSE 1 END`;
function provenanceRank(by: MappedBy): number {
  return by === "manual" || by === "declared" ? 3 : by === "llm" ? 2 : 1;
}

// 공통 검증: repo 해소 → mapped_by 검증 → llm 근거 필수 → ku 존재 → 후보 vocab 로드.
async function validateProposeBase(
  input: { name: string; mappedBy: MappedBy; repo?: string; evidence?: string },
  deps?: { candidates?: Candidates },
): Promise<{ repo: string; candidates: Candidates }> {
  const repo = resolveRepo(input.repo);
  if (!["rule", "llm", "manual"].includes(input.mappedBy)) {
    throw new Error(`mapped_by 는 rule|llm|manual 만 허용 (받은 값: ${input.mappedBy})`);
  }
  if (input.mappedBy === "llm" && (!input.evidence || !input.evidence.trim())) {
    throw new Error("llm 매핑은 근거(evidence) 필수");
  }
  // 참조 ku 존재 검증(item_id 존재검증의 ku-좌표 대응물). '없음' 토큰 → REST 404.
  const exists = (await itemsPool.query(`SELECT 1 FROM knowledge_unit WHERE name=$1`, [input.name])).rowCount ?? 0;
  if (!exists) throw new Error(`knowledge_unit ${input.name} 없음`);
  let candidates = deps?.candidates;
  if (!candidates) {
    try {
      candidates = await loadCandidates(repo);
    } catch (err) {
      throw new Error(`domainmap 후보 로드 실패(repo=${repo}): ${(err as Error).message}`);
    }
  }
  return { repo, candidates };
}

// upsert 결과 해석 + 감사 로깅. 0행 = WHERE 가드로 보호된 행(throw 안 함). store.ts finishPropose 와 동치.
async function finishPropose(
  audit: string, table: "knowledge_unit_domain", keyCol: "domain_key",
  name: string, repo: string, key: string, mappedBy: string,
  r: { rowCount: number | null; rows: unknown[] }, auditCtx: { source: string; actor: string },
): Promise<ProposeResult> {
  const target = "domain";
  if ((r.rowCount ?? 0) === 0) {
    const cur = (await itemsPool.query(
      `SELECT state, mapped_by FROM ${table} WHERE name=$1 AND repo=$2 AND ${keyCol}=$3`,
      [name, repo, key],
    )).rows[0] as { state: string; mapped_by: string } | undefined;
    const state = cur?.state ?? "proposed";
    const action = state === "rejected"
      ? "skipped-rejected" as const
      : state === "confirmed"
        ? "skipped-confirmed" as const
        : cur?.mapped_by === "manual"
          ? "skipped-manual" as const
          : "skipped-provenance" as const;
    await itemsPool.query(
      `INSERT INTO knowledge_unit_mapping_audit(target,name,repo,key,mapped_by,action,state,source,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [target, name, repo, key, mappedBy, action, state, auditCtx.source, auditCtx.actor],
    );
    logger.info({ audit, name, repo, key, mappedBy, action, existing: cur?.mapped_by, state });
    return { name, repo, key, mappedBy: cur?.mapped_by ?? mappedBy, state, action };
  }
  const row = r.rows[0] as { inserted: boolean; state: string };
  const action = row.inserted ? "inserted" : "refreshed";
  logger.info({ audit, name, repo, key, mappedBy, action });
  return { name, repo, key, mappedBy, state: row.state, action };
}

// 공통 propose — domain/project 분기는 테이블/키컬럼/target 만 다르다.
async function proposeUnit(
  table: "knowledge_unit_domain", keyCol: "domain_key", target: "domain",
  input: { name: string; key: string; mappedBy: MappedBy; repo?: string; confidence?: number; evidence?: string },
  candidates: Candidates, repo: string, audit: { source: string; actor: string },
): Promise<ProposeResult> {
  const inRank = provenanceRank(input.mappedBy);
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO ${table}(name,repo,${keyCol},mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,$4,$5,'proposed',$6)
       ON CONFLICT (name,repo,${keyCol}) DO UPDATE
         SET confidence=EXCLUDED.confidence, mapped_by=EXCLUDED.mapped_by, evidence=EXCLUDED.evidence
         WHERE ${table}.state='proposed' AND ${table}.mapped_by<>'manual'
           AND $7 >= (${PROVENANCE_RANK_SQL.replace(/mapped_by/g, `${table}.mapped_by`)})
       RETURNING (xmax=0) AS inserted, state
     )
     INSERT INTO knowledge_unit_mapping_audit(target,name,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT $10,$1,$2,$3,$4,
            CASE WHEN up.inserted THEN 'inserted' ELSE 'refreshed' END, up.state, $5,$6,$8,$9
     FROM up
     RETURNING (action='inserted') AS inserted, state`,
    [input.name, repo, input.key, input.mappedBy, input.confidence ?? null,
     input.evidence ?? null, inRank, audit.source, audit.actor, target],
  );
  return finishPropose(`${table}_propose`, table, keyCol, input.name, repo, input.key, input.mappedBy, r, audit);
}

// ku → domain 제안.
export async function proposeUnitDomain(
  input: { name: string; domainKey: string; mappedBy: MappedBy; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ProposeResult> {
  const { repo, candidates } = await validateProposeBase(input, deps);
  if (!validateDomainKey(candidates, input.domainKey)) throw new Error(`domain_key ${input.domainKey} 검증 실패(repo=${repo})`);
  return proposeUnit("knowledge_unit_domain", "domain_key", "domain",
    { ...input, key: input.domainKey }, candidates, repo, auditDefaults(deps?.audit));
}

// ── 확정(proposed → confirmed) — state='confirmed', mapped_by='manual'(사람 진실). ──
export interface ConfirmResult {
  name: string; repo: string; key: string; mappedBy: "manual"; state: "confirmed";
  action: "inserted" | "updated";
}
async function confirmUnit(
  table: "knowledge_unit_domain", keyCol: "domain_key", target: "domain",
  name: string, key: string, repo: string, confidence: number | null, evidence: string | null,
  audit: { source: string; actor: string },
): Promise<ConfirmResult> {
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO ${table}(name,repo,${keyCol},mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,'manual',$4,'confirmed',$5)
       ON CONFLICT (name,repo,${keyCol}) DO UPDATE
         SET mapped_by='manual', state='confirmed',
             confidence=COALESCE(EXCLUDED.confidence, ${table}.confidence),
             evidence=COALESCE(EXCLUDED.evidence, ${table}.evidence)
       RETURNING (xmax=0) AS inserted
     )
     INSERT INTO knowledge_unit_mapping_audit(target,name,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT $8,$1,$2,$3,'manual',
            CASE WHEN up.inserted THEN 'confirm-inserted' ELSE 'confirm-updated' END,'confirmed',$4,$5,$6,$7
     FROM up
     RETURNING (action='confirm-inserted') AS inserted`,
    [name, repo, key, confidence, evidence, audit.source, audit.actor, target],
  );
  const inserted = (r.rows[0] as { inserted: boolean }).inserted;
  logger.info({ audit: `${table}_confirm`, name, repo, key, source: audit.source, actor: audit.actor });
  return { name, repo, key, mappedBy: "manual", state: "confirmed", action: inserted ? "inserted" : "updated" };
}

export async function confirmUnitDomain(
  input: { name: string; domainKey: string; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ConfirmResult> {
  const { repo, candidates } = await validateProposeBase({ ...input, mappedBy: "manual" }, deps);
  if (!validateDomainKey(candidates, input.domainKey)) throw new Error(`domain_key ${input.domainKey} 검증 실패(repo=${repo})`);
  return confirmUnit("knowledge_unit_domain", "domain_key", "domain",
    input.name, input.domainKey, repo, input.confidence ?? null, input.evidence ?? null, auditDefaults(deps?.audit));
}

// ── 기각(→ rejected) — store.ts rejectMapping 의 ku-좌표 대응물(CTE 원자, TOCTOU 제거). ──
export interface RejectResult {
  name: string; repo: string; key: string; mappedBy: string;
  state: "rejected"; previousState: string;
  action: "rejected" | "already-rejected";
}
async function rejectMapping(
  table: "knowledge_unit_domain", keyCol: "domain_key",
  input: { name: string; key: string; repo?: string; reason?: string },
  deps?: { audit?: AuditCtx },
): Promise<RejectResult> {
  const repo = resolveRepo(input.repo);
  const target = "domain";
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       UPDATE ${table} t SET state='rejected'
       FROM ${table} old
       WHERE t.name=$1 AND t.repo=$2 AND t.${keyCol}=$3 AND t.state <> 'rejected'
         AND old.name=t.name AND old.repo=t.repo AND old.${keyCol}=t.${keyCol}
       RETURNING old.state AS previous_state, old.mapped_by
     ),
     aud AS (
       INSERT INTO knowledge_unit_mapping_audit(target,name,repo,key,mapped_by,action,state,evidence,source,actor)
       SELECT $4,$1,$2,$3, up.mapped_by, 'rejected','rejected',$5,$6,$7 FROM up
     )
     SELECT previous_state, mapped_by FROM up`,
    [input.name, repo, input.key, target, input.reason ?? null, audit.source, audit.actor],
  );
  const hit = r.rows[0] as { previous_state: string; mapped_by: string } | undefined;
  if (!hit) {
    const cur = (await itemsPool.query(
      `SELECT state, mapped_by FROM ${table} WHERE name=$1 AND repo=$2 AND ${keyCol}=$3`,
      [input.name, repo, input.key],
    )).rows[0] as { state: string; mapped_by: string } | undefined;
    if (!cur || cur.state !== "rejected") {
      throw new Error(`매핑 없음 — knowledge_unit ${input.name} repo=${repo} key=${input.key}`); // '없음' → 404
    }
    return {
      name: input.name, repo, key: input.key, mappedBy: cur.mapped_by,
      state: "rejected", previousState: "rejected", action: "already-rejected",
    };
  }
  logger.info({
    audit: `${table}_reject`, name: input.name, repo, key: input.key,
    previousState: hit.previous_state, source: audit.source, actor: audit.actor,
  });
  return {
    name: input.name, repo, key: input.key, mappedBy: hit.mapped_by,
    state: "rejected", previousState: hit.previous_state, action: "rejected",
  };
}

export async function rejectUnitDomain(
  input: { name: string; domainKey: string; repo?: string; reason?: string },
  deps?: { audit?: AuditCtx },
): Promise<RejectResult> {
  return rejectMapping("knowledge_unit_domain", "domain_key",
    { name: input.name, key: input.domainKey, repo: input.repo, reason: input.reason }, deps);
}

// ════════ 읽기(큐레이션 inbox/카운트) — item 좌표 → ku 좌표(name) ════════

export interface UnmappedUnitsParams {
  missing?: "domain" | "either";
  repo?: string; system?: string; type?: string; since?: string; limit?: number; offset?: number;
}

// 큐레이션 inbox(ku) — observed 미러 ku 중 도메인 매핑이 없는 단위. '매핑 있음' = state IN
//  ('proposed','confirmed')(rejected-only 는 미매핑 복귀). repo 는 NOT EXISTS 내부 스코프.
//  observed 한정(confidence='observed') — 저작물(R/K/H)은 큐레이션 inbox 대상이 아니다.
export async function unmappedUnitsUi(p: UnmappedUnitsParams): Promise<{ count: number; rows: unknown[] }> {
  const where: string[] = [`k.confidence='observed'`];
  const args: unknown[] = [];
  const ph = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const LIVE = `state IN ('proposed','confirmed')`;
  const noDomain = () => p.repo
    ? `NOT EXISTS (SELECT 1 FROM knowledge_unit_domain d WHERE d.name=k.name AND d.repo=${ph(p.repo)} AND d.${LIVE})`
    : `NOT EXISTS (SELECT 1 FROM knowledge_unit_domain d WHERE d.name=k.name AND d.${LIVE})`;
  // missing 은 domain|either 로 축소(project 폐기) — 둘 다 '도메인 미매핑' 동일 의미.
  where.push(noDomain());
  if (p.system) where.push(`k.external_system = ${ph(p.system)}`);
  if (p.type) where.push(`k.fields->>'_item_type' = ${ph(p.type)}`);
  if (p.since) where.push(`k.occurred_at >= ${ph(p.since)}`);
  const condition = where.join(" AND ");
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 20), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(p.offset ?? 0), 0), 5000);
  const count = ((await itemsPool.query(
    `SELECT count(*)::int AS count FROM knowledge_unit k WHERE ${condition}`, args)).rows[0] as { count: number }).count;
  const rows = (await itemsPool.query(
    `${uiUnitListSelect()}
     WHERE ${condition}
     ORDER BY k.occurred_at DESC NULLS LAST
     LIMIT ${limit} OFFSET ${offset}`, args)).rows;
  return { count, rows };
}

// 리스트 행 — item uiListSelect 의 ku 대응(name 키, _item_type → type, 매핑 배지는 kud). rejected 배지 제외.
function uiUnitListSelect(): string {
  return `
  SELECT k.name AS id, k.fields->>'_item_type' AS type, k.external_system AS system,
         k.external_instance AS container_ref, k.title,
         left(k.body_md, 400) AS snippet, length(k.body_md)::int AS body_length,
         k.external_url, k.occurred_at, k.parent_name AS parent_id, k.author AS actor,
         (SELECT COALESCE(json_agg(json_build_object('repo', d.repo, 'key', d.domain_key, 'state', d.state, 'by', d.mapped_by)
                                   ORDER BY d.repo, d.domain_key), '[]'::json)
            FROM knowledge_unit_domain d WHERE d.name = k.name AND d.state <> 'rejected') AS domains
  FROM knowledge_unit k`;
}

// 키별 매핑 카운트(ku) — mappingKeyCounts 의 ku 대응물. rejected 제외.
export async function mappingKeyCountsUnit(repo: string): Promise<{
  domains: { key: string; count: number; confirmed: number }[];
}> {
  const domains = (await itemsPool.query(
    `SELECT domain_key AS key, count(*)::int AS count, count(*) FILTER (WHERE state='confirmed')::int AS confirmed
     FROM knowledge_unit_domain WHERE repo=$1 AND state <> 'rejected' GROUP BY 1 ORDER BY 2 DESC`, [repo])).rows;
  return { domains };
}

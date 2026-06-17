// 읽기 전용 엔드포인트 전부 — store-core.mjs read helpers 이식. change_log import 없음
// (읽기 경로가 감사 테이블에 구조적으로 못 쓰게 격리; history 열람만 changelog.ts 소유).
// 응답 shape byte-compat 의 리스크가 전부 이 파일에 갇힌다 — 골든 리드 diff 시 여기만 의심하면 됨.
// SQL verbatim 원칙: COUNT(*)::int 캐스트(미캐스트 시 pg 가 int8 을 string 으로 반환 — shape 파손),
// state<>'merged' 술어(IS DISTINCT FROM 로 '개선' 금지), confidence(float4) 재반올림 금지 passthrough.
import { dmPool, one, q, type Db } from "../db.js";
import {
  httpErr, type BestDomainRef, type CodeListItem, type DebtListItem, type DomainListItem,
  type EntityListItem, type ProjectListItem, type TouchProjectRef,
} from "./types.js";
import { getRepo } from "./repos.js";
// 반환 타입 방침: 리터럴 객체를 '구성'하는 리스트 읽기 4+1종은 types.ts 의 *ListItem 으로 키 집합을
// 고정하고, SELECT * passthrough·조건부 키(undefined 생략) 가 섞이는 listRepos/overview/domainDetail/
// queue 는 동적(any) 유지 — 골든 리드가 byte 단위로 핀(pin)하고 있어 타입 선언이 계약을 흐리면 역효과.

// git_url(자격증명 토큰이 박혀 있을 수 있음 — core/schema.ts 경고)에서 userinfo 를 벗긴 안전한 clone 주소.
//  파싱 불가 시 null(fail-closed — 시크릿 누출 금지). scp-식 ssh(git@host:path)는 시크릿 없음 → 그대로 통과.
export function sanitizeCloneUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (!s.includes("://") && /^[\w.-]+@[\w.-]+:/.test(s)) return s; // scp-식 ssh — 임베드 시크릿 없음
  try {
    const u = new URL(s);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return null; // 파싱 불가 → 노출 금지(잠재 시크릿 보유 문자열일 수 있음)
  }
}

// 구조층(detected_stack/code_unit/mapping)이 '낡았을 수 있음'을 소비자(인덱스·웹·에이전트)에게
// 알리는 freshness 신호. PURE·DB-무접촉·git-무접촉(읽기 경로는 싸야 하고 클론 존재에 의존하면 안 됨) —
// 오직 이미 로드된 repo 행 메타데이터(last_refreshed_sha/last_scan_at)와 active code_unit 수만으로 판정.
//   - never_refreshed: code_unit 이 있는데 last_refreshed_sha 가 한 번도 안 찍혔다(증분 refresh 미실행).
//       → 부트스트랩 스냅샷 이후 코드가 움직였어도 구조층이 못 따라왔을 수 있다는 신호.
//   - empty: 스캔된 적이 없다(code_unit 0) — stale 이 아니라 '미초기화'로 구분(소비자가 다르게 취급).
//   stale=true 면 소비자는 '구조층이 현 코드와 어긋날 수 있음'을 가정하고 refresh/재스캔을 권고할 수 있다.
//   (P3 인덱스의 freshness 와 정합: 둘 다 last_refreshed_sha 체크포인트를 단일 진실로 쓴다.)
export function computeFreshness(repoRow: any, activeCodeUnits: number): {
  stale: boolean; reason: string; last_refreshed_sha: string | null; last_scan_at: unknown;
} {
  const sha = repoRow.last_refreshed_sha ?? null;
  let reason: string;
  let stale: boolean;
  if (activeCodeUnits === 0) { reason = "empty"; stale = false; }
  else if (sha == null) { reason = "never_refreshed"; stale = true; }
  else { reason = "checkpoint"; stale = false; }
  return { stale, reason, last_refreshed_sha: sha, last_scan_at: repoRow.last_scan_at ?? null };
}

export async function listRepos(): Promise<any[]> {
  const pool = dmPool();
  const repos = await q(pool, "SELECT * FROM repo ORDER BY name");
  const out = [];
  for (const r of repos) {
    const t = await one(pool, `SELECT
      (SELECT COUNT(*)::int FROM domain WHERE repo_id=$1 AND state<>'merged') domains,
      (SELECT COUNT(*)::int FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active') code_units,
      (SELECT COUNT(*)::int FROM data_entity WHERE repo_id=$1) data_entities,
      (SELECT COUNT(*)::int FROM mapping WHERE repo_id=$1) mappings,
      (SELECT COUNT(*)::int FROM debt_finding WHERE repo_id=$1) debts,
      (SELECT COUNT(*)::int FROM change_log WHERE repo_id=$1) changes`, [r.id]);
    out.push({
      name: r.name, clone_url: sanitizeCloneUrl(r.git_url), detected_stack: r.detected_stack ?? {}, totals: t,
      freshness: computeFreshness(r, t.code_units),
    });
  }
  return out;
}

export async function overview(name: string): Promise<any> {
  const pool = dmPool();
  const r = await getRepo(name);
  const totals = await one(pool, `SELECT
    (SELECT COUNT(*)::int FROM domain WHERE repo_id=$1 AND state<>'merged') domains,
    (SELECT COUNT(*)::int FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active') code_units,
    (SELECT COUNT(*)::int FROM data_entity WHERE repo_id=$1) data_entities,
    (SELECT COUNT(*)::int FROM mapping WHERE repo_id=$1) mappings,
    (SELECT COUNT(*)::int FROM debt_finding WHERE repo_id=$1) debts,
    (SELECT COUNT(*)::int FROM change_log WHERE repo_id=$1) changes`, [r.id]);
  const scan_runs = await q(pool, "SELECT id,runbook,harness,actor_type,actor_id,started_at,finished_at,summary FROM scan_run WHERE repo_id=$1 ORDER BY id DESC LIMIT 20", [r.id]);
  return { repo: { name: r.name, detected_stack: r.detected_stack ?? {}, root_path: r.root_path, last_scan_at: r.last_scan_at, last_refreshed_sha: r.last_refreshed_sha ?? null }, totals, scan_runs, freshness: computeFreshness(r, totals.code_units) };
}

export async function listDomainsApi(name: string): Promise<DomainListItem[]> {
  const pool = dmPool();
  const r = await getRepo(name);
  const rows = await q(pool, `SELECT * FROM domain WHERE repo_id=$1 AND state<>'merged' ORDER BY cross_cutting, key`, [r.id]);
  const out: DomainListItem[] = [];
  for (const d of rows) {
    // units count joins code_unit and excludes soft-removed rows (state='removed')
    // so a domain's live size reflects the current repo, not deleted-but-flagged code.
    const c = await one(pool, `SELECT
      (SELECT COUNT(*)::int FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
         WHERE m.repo_id=$1 AND m.target_kind='code_unit' AND m.domain_id=$2 AND m.status<>'rejected'
         AND COALESCE(cu.state,'active')='active') units,
      (SELECT COUNT(*)::int FROM mapping WHERE repo_id=$1 AND target_kind='data_entity' AND domain_id=$2 AND status<>'rejected') entities,
      (SELECT COUNT(*)::int FROM mapping WHERE repo_id=$1 AND domain_id=$2 AND status='proposed') proposed`, [r.id, d.id]);
    // structure issues that cite this domain's mapped code paths
    out.push({
      id: d.id, key: d.key, name: d.name, description: d.description,
      state: d.state, cross_cutting: d.cross_cutting, origin: d.origin, status: d.status,
      units: c.units, entities: c.entities, debts: 0, proposed: c.proposed,
    });
  }
  // attach per-domain debt counts via cited code-unit paths (best effort)
  const debts = await q(pool, "SELECT id,title,cited_refs,status FROM debt_finding WHERE repo_id=$1", [r.id]);
  // map domain -> set of code paths
  const domPaths: Record<number, Set<string>> = {};
  for (const d of out) {
    const paths = await q(pool, `SELECT cu.path FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
      WHERE m.repo_id=$1 AND m.target_kind='code_unit' AND m.domain_id=$2 AND m.status<>'rejected'`, [r.id, d.id]);
    domPaths[d.id] = new Set(paths.map((p) => p.path));
  }
  for (const dt of debts) {
    if (dt.status === "resolved" || dt.status === "dismissed") continue;
    const refs = Array.isArray(dt.cited_refs) ? dt.cited_refs : [];
    for (const d of out) {
      if (refs.some((rf: any) => domPaths[d.id]?.has(typeof rf === "string" ? rf : rf?.path))) d.debts++;
    }
  }
  return out;
}

export async function domainDetail(name: string, id: number): Promise<any> {
  const pool = dmPool();
  const r = await getRepo(name);
  const domain = await one(pool, "SELECT * FROM domain WHERE id=$1 AND repo_id=$2", [id, r.id]);
  if (!domain) throw httpErr(404, "no such domain in repo: " + id);

  // Includes soft-removed code_units (state='removed') on purpose: a human reviewing
  // the domain should still see a deleted-but-confirmed-mapped path (it's flagged
  // debt). `state` lets the UI mark it. Public assets aren't edited here, so the
  // extra field is additive/back-compatible.
  const code_units = await q(pool, `SELECT cu.id, cu.kind, cu.path, cu.label, COALESCE(cu.state,'active') state,
      m.id mid, m.status mstatus, m.origin morigin, m.confidence mconf
    FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
    WHERE m.repo_id=$1 AND m.target_kind='code_unit' AND m.domain_id=$2
    ORDER BY cu.path`, [r.id, id]);
  const data_entities = await q(pool, `SELECT de.id, de.kind, de.name, de.source,
      m.id mid, m.status mstatus, m.origin morigin, m.confidence mconf
    FROM mapping m JOIN data_entity de ON de.id=m.target_id
    WHERE m.repo_id=$1 AND m.target_kind='data_entity' AND m.domain_id=$2
    ORDER BY de.name`, [r.id, id]);

  // shape(): 원본 JS 의 'undefined 키는 JSON 직렬화에서 사라진다' 거동을 조건부 spread 로 재현.
  // code_unit 행에는 name/source 키 자체가 없어야 하고(data_entity 에는 path 가 없어야 함),
  // null 대입은 골든 byte 비교를 깨뜨린다 — 키 부재가 계약.
  const shape = (rows: any[], labelKey: string) => rows.map((x) => ({
    id: x.id, kind: x.kind,
    ...(x.path !== undefined ? { path: x.path } : {}),
    label: x.label ?? x[labelKey],
    ...(x.name !== undefined ? { name: x.name } : {}),
    ...(x.source !== undefined ? { source: x.source } : {}),
    state: x.state ?? "active",
    mapping: { id: x.mid, status: x.mstatus, origin: x.morigin, confidence: x.mconf },
  }));

  // structure issues citing this domain's code paths
  const paths = new Set(code_units.map((c) => c.path));
  const allDebts = await q(pool, "SELECT * FROM debt_finding WHERE repo_id=$1 ORDER BY id", [r.id]);
  const debts = allDebts.filter((dt) => {
    const refs = Array.isArray(dt.cited_refs) ? dt.cited_refs : [];
    return refs.some((rf: any) => paths.has(typeof rf === "string" ? rf : rf?.path));
  }).map((dt) => ({ id: dt.id, kind: dt.kind, title: dt.title, detail: dt.detail, cited_refs: dt.cited_refs, status: dt.status, origin: dt.origin }));

  return {
    domain: {
      id: domain.id, key: domain.key, name: domain.name, description: domain.description,
      state: domain.state, cross_cutting: domain.cross_cutting, origin: domain.origin, status: domain.status,
    },
    code_units: shape(code_units, "path"),
    data_entities: shape(data_entities, "name"),
    debts,
  };
}

// ⚠ 표면 동결(Stage⑥ 컷오버 기록): 구 :7700 의 GET /api/repo/:name/queue 전용이던 읽기 — :7700 퇴역
// 후 HTTP/MCP 표면이 '없다'(게이트웨이 DM_KINDS 동결: domains|projects|entities|overview). 코어 함수로만
// 존재하며 큐레이션 UI 가 제안 큐 뷰를 필요로 하면 그때 capability 로 노출한다. listCodeApi 동일.
export async function queue(name: string): Promise<any> {
  const pool = dmPool();
  const r = await getRepo(name);
  const proposed_domains = await q(pool, `SELECT id,key,name,description,cross_cutting,origin,status,state
    FROM domain WHERE repo_id=$1 AND status='proposed' AND state<>'merged' ORDER BY key`, [r.id]);
  const proposed_mappings_raw = await q(pool, `SELECT m.id, m.target_kind, m.target_id, m.domain_id, m.origin, m.confidence, m.status,
      d.name domain_name, d.key domain_key,
      cu.path cu_path, cu.label cu_label, de.name de_name, de.source de_source
    FROM mapping m
    JOIN domain d ON d.id=m.domain_id
    LEFT JOIN code_unit cu ON (m.target_kind='code_unit' AND cu.id=m.target_id)
    LEFT JOIN data_entity de ON (m.target_kind='data_entity' AND de.id=m.target_id)
    WHERE m.repo_id=$1 AND m.status='proposed' ORDER BY m.id`, [r.id]);
  const proposed_mappings = proposed_mappings_raw.map((m) => ({
    id: m.id, target_kind: m.target_kind, target_id: m.target_id, domain_id: m.domain_id,
    origin: m.origin, confidence: m.confidence, status: m.status,
    domain_name: m.domain_name, domain_key: m.domain_key,
    target_label: m.target_kind === "code_unit" ? (m.cu_path ?? m.cu_label) : m.de_name,
    target_source: m.de_source ?? null,
  }));
  // drift 는 SELECT * 풀행(change_log 컬럼 전부) — 읽기 전용 SELECT 이며 shape 계약의 일부.
  const drift = await q(pool, `SELECT * FROM change_log WHERE repo_id=$1 AND op='drift' ORDER BY id DESC`, [r.id]);
  return { proposed_domains, proposed_mappings, drift };
}

export async function listDebts(name: string): Promise<DebtListItem[]> {
  const r = await getRepo(name);
  return q(dmPool(), "SELECT id,kind,title,detail,cited_refs,status,origin FROM debt_finding WHERE repo_id=$1 ORDER BY id", [r.id]);
}

// ---------------------------------------------------------------------------
// Project layer + tree/explorer reads
// ---------------------------------------------------------------------------

// The domain for a target = its "best" non-rejected mapping's domain: a confirmed
// mapping wins over a proposed one (DISTINCT ON keeps the top row per target in the
// status ordering). Returns a Map<target_id, {id,key,name,cross_cutting,status}>.
// deprecated 도메인을 의도적으로 제외하지 않는다(기존 매핑은 유효 — deprecation 은 큐레이션 신호).
async function bestDomainByTarget(db: Db, repo_id: number, target_kind: string): Promise<Map<number, BestDomainRef>> {
  const rows = await q(db, `
    SELECT DISTINCT ON (m.target_id)
      m.target_id, d.id, d.key, d.name, d.cross_cutting, d.status
    FROM mapping m JOIN domain d ON d.id=m.domain_id
    WHERE m.repo_id=$1 AND m.target_kind=$2 AND m.status<>'rejected' AND d.state<>'merged'
    ORDER BY m.target_id, (m.status='confirmed') DESC, m.id`, [repo_id, target_kind]);
  const out = new Map<number, BestDomainRef>();
  for (const x of rows) out.set(x.target_id, { id: x.id, key: x.key, name: x.name, cross_cutting: x.cross_cutting, status: x.status });
  return out;
}

// Projects touching each target, sorted by last_at desc. Returns a Map<target_id, projects[]>.
async function projectsByTarget(db: Db, repo_id: number, target_kind: string): Promise<Map<number, TouchProjectRef[]>> {
  const rows = await q(db, `
    SELECT pt.target_id, p.key, p.name, p.kind, pt.last_at, pt.commit_count
    FROM project_touch pt JOIN project p ON p.id=pt.project_id
    WHERE pt.repo_id=$1 AND pt.target_kind=$2
    ORDER BY pt.target_id, pt.last_at DESC NULLS LAST, p.key`, [repo_id, target_kind]);
  const out = new Map<number, TouchProjectRef[]>();
  for (const x of rows) {
    if (!out.has(x.target_id)) out.set(x.target_id, []);
    out.get(x.target_id)!.push({ key: x.key, name: x.name, kind: x.kind, last_at: x.last_at, commit_count: x.commit_count });
  }
  return out;
}

// GET /api/repo/:name/code — flat code_unit list; the client builds the directory
// tree from `path`. Each row carries its best-mapping domain (or null) and the
// projects that touched it (last_at desc).
// `includeRemoved` (default false): when false, soft-removed code_units (state=
// 'removed') are excluded so the tree reflects the live repo. COALESCE covers
// pre-migration rows with NULL state (treated as active).
export async function listCodeApi(name: string, includeRemoved = false): Promise<CodeListItem[]> {
  const pool = dmPool();
  const r = await getRepo(name);
  const units = includeRemoved
    ? await q(pool, "SELECT id,path,kind,label,COALESCE(state,$2) state,prev_path FROM code_unit WHERE repo_id=$1 ORDER BY path", [r.id, "active"])
    : await q(pool, `SELECT id,path,kind,label,COALESCE(state,'active') state,prev_path FROM code_unit
        WHERE repo_id=$1 AND COALESCE(state,'active')='active' ORDER BY path`, [r.id]);
  const dom = await bestDomainByTarget(pool, r.id, "code_unit");
  const proj = await projectsByTarget(pool, r.id, "code_unit");
  return units.map((u) => ({
    id: u.id, path: u.path, kind: u.kind, label: u.label ?? u.path,
    state: u.state, prev_path: u.prev_path ?? null, // null 은 명시 방출(키 생략 아님)
    domain: dom.get(u.id) ?? null,
    projects: proj.get(u.id) ?? [],
  }));
}

// GET /api/repo/:name/entities — flat data_entity list with best-mapping domain + projects.
export async function listEntitiesApi(name: string): Promise<EntityListItem[]> {
  const pool = dmPool();
  const r = await getRepo(name);
  const ents = await q(pool, "SELECT id,name,source,kind FROM data_entity WHERE repo_id=$1 ORDER BY name,source", [r.id]);
  const dom = await bestDomainByTarget(pool, r.id, "data_entity");
  const proj = await projectsByTarget(pool, r.id, "data_entity");
  return ents.map((e) => ({
    id: e.id, name: e.name, source: e.source, kind: e.kind,
    domain: dom.get(e.id) ?? null,
    projects: proj.get(e.id) ?? [],
  }));
}

// GET /api/repo/:name/projects — the Project layer with touched_code / touched_entities counts.
export async function listProjectsApi(name: string): Promise<ProjectListItem[]> {
  const pool = dmPool();
  const r = await getRepo(name);
  const rows = await q(pool, "SELECT * FROM project WHERE repo_id=$1 ORDER BY ended_at DESC NULLS LAST, key", [r.id]);
  const out: ProjectListItem[] = [];
  for (const p of rows) {
    const c = await one(pool, `SELECT
      (SELECT COUNT(*)::int FROM project_touch WHERE repo_id=$1 AND project_id=$2 AND target_kind='code_unit') touched_code,
      (SELECT COUNT(*)::int FROM project_touch WHERE repo_id=$1 AND project_id=$2 AND target_kind='data_entity') touched_entities`,
      [r.id, p.id]);
    out.push({
      id: p.id, key: p.key, name: p.name, description: p.description, kind: p.kind, status: p.status, origin: p.origin,
      started_at: p.started_at, ended_at: p.ended_at,
      // ?? null 5종은 null 명시 방출 — pre-migration NULL 컬럼도 키가 있어야 한다(키 생략 금지).
      state: p.state ?? null, prov_system: p.prov_system ?? null,
      external_url: p.external_url ?? null, last_synced_at: p.last_synced_at ?? null,
      touched_code: c.touched_code, touched_entities: c.touched_entities,
      // P-V3-4b: 붕뜸 해소 — DB 백필값 우선, NULL 행은 동일 휴리스틱으로 즉석 분류(스키마 마이그 전 폴백).
      provenance_kind: p.provenance_kind
        ?? ((p.external_id != null || p.origin === "human") ? "initiative" : "code_grouping"),
    });
  }
  return out;
}

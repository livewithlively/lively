// v6 도메인맵 read — 구 domain/mapping/debt_finding(레포 스코프) 대신 category(space='product') 소스.
//  골든리드로 핀(pin)된 src/domainmap/core/queries.ts 는 건드리지 않는다(레거시 #/domainmap 와 byte-compat 보존).
//  이 파일은 **신규 v6 reader** — 같은 응답 shape(domains/debts/should_changes/is_commit_changes)를 category 에서 조립한다.
//  프론트(public/app.js domainmapBody)가 읽는 도메인별 필드 이름을 그대로 방출한다:
//    key,name,description,should,state,cross_cutting,origin,status,space,units,entities,debts,proposed
//  category 는 멀티레포(repo_id 없음)라 repos(도달 레포 distinct 수)를 추가 신호로 더한다(프론트는 무시 — 가산·하위호환).
//  DB 는 물리 통합(domainmap 도 itemsPool 공유)이라 category(items)와 code_unit/debt_finding/activity(domainmap)를 한 풀에서 조인한다.
import { itemsPool } from "../items/store.js";
import { q } from "../domainmap/db.js";
import { httpErr } from "../domainmap/core/types.js";
// queries.ts 의 순수 헬퍼(domain 테이블 무관 — clone_url 시크릿 제거·freshness 계산)만 재사용(골든리드 무변형).
import { sanitizeCloneUrl, computeFreshness } from "../domainmap/core/queries.js";
import { listCategoryEdges, type CategoryEdgeRow } from "./category-store.js";

// 레거시 DomainListItem(types.ts:123) 과 키 집합 동형 + repos(v6 멀티레포 신호) 가산.
//  units/entities/debts/proposed 는 ::int 캐스트(미캐스트 시 pg int8 → string, 프론트 fmtNum 깨짐).
export interface V6DomainItem {
  id: number; key: string; name: string | null; description: string | null;
  should: string | null; state: string | null; cross_cutting: boolean;
  origin: string | null; status: string; space: string;
  units: number; entities: number; debts: number; proposed: number;
  repos: number; // v6 가산: 매핑으로 도달하는 distinct code_unit.repo_id 수(멀티레포 신호). 프론트 무시.
  layout_x: number | null; layout_y: number | null; // 저장된 노드 좌표(조직 공유). null=자동 배치.
}

// 도메인 목록 — category WHERE space='product' AND state<>'merged'.
//  units = mapping(category_id, target_kind='code_unit', status<>'rejected') 중 code_unit active 만(soft-removed 제외 — 레거시 동일).
//  entities = mapping(category_id, target_kind='data_entity', status<>'rejected').
//  proposed = mapping(category_id, status='proposed') — 레거시 listDomainsApi 와 동형.
//  debts = debt_finding(category_id) 중 open/ack 만(resolved/dismissed 제외 — 레거시는 cited_refs 경로지만 v6 는 category_id 직결).
//  repos = mapping→code_unit 으로 도달하는 distinct repo_id(멀티레포 신호).
//  정렬: cross_cutting, key (레거시 listDomainsApi ORDER BY 동일).
export async function listProductDomains(): Promise<V6DomainItem[]> {
  const rows = await q(itemsPool, `
    SELECT
      c.id, c.key, c.name, c.description, c.should, c.state, c.cross_cutting,
      c.origin, c.status, c.layout_x, c.layout_y,
      COALESCE(c.space,'product') AS space,
      (SELECT COUNT(*)::int FROM mapping m
         JOIN code_unit cu ON cu.id=m.target_id
        WHERE m.category_id=c.id AND m.target_kind='code_unit'
          AND m.status<>'rejected' AND COALESCE(cu.state,'active')='active') AS units,
      (SELECT COUNT(*)::int FROM mapping m
        WHERE m.category_id=c.id AND m.target_kind='data_entity' AND m.status<>'rejected') AS entities,
      (SELECT COUNT(*)::int FROM mapping m
        WHERE m.category_id=c.id AND m.status='proposed') AS proposed,
      (SELECT COUNT(*)::int FROM debt_finding d
        WHERE d.category_id=c.id AND d.status NOT IN ('resolved','dismissed')) AS debts,
      (SELECT COUNT(DISTINCT cu.repo_id)::int FROM mapping m
         JOIN code_unit cu ON cu.id=m.target_id
        WHERE m.category_id=c.id AND m.target_kind='code_unit' AND m.status<>'rejected') AS repos
    FROM category c
    WHERE c.space='product' AND c.state<>'merged'
    ORDER BY c.cross_cutting, c.key`);
  return rows.map((d) => ({
    id: d.id, key: d.key, name: d.name ?? null, description: d.description ?? null,
    should: d.should ?? null, state: d.state ?? null, cross_cutting: !!d.cross_cutting,
    origin: d.origin ?? null, status: d.status, space: d.space ?? "product",
    units: d.units, entities: d.entities, debts: d.debts, proposed: d.proposed, repos: d.repos,
    layout_x: d.layout_x ?? null, layout_y: d.layout_y ?? null,
  }));
}

// ── 노드 위치 저장(조직 공유 레이아웃) — category.layout_x/y 에 persist. product 만. ──
export async function saveDomainLayout(positions: { id: number; x: number; y: number }[]): Promise<{ saved: number }> {
  if (!Array.isArray(positions)) return { saved: 0 };
  let saved = 0;
  for (const p of positions) {
    if (!p || typeof p.id !== "number" || typeof p.x !== "number" || typeof p.y !== "number") continue;
    const r = await itemsPool.query(
      `UPDATE category SET layout_x=$1, layout_y=$2, updated_at=now() WHERE id=$3 AND space='product' AND state<>'merged'`,
      [p.x, p.y, p.id]);
    saved += r.rowCount || 0;
  }
  return { saved };
}

// 레거시 DebtListItem(types.ts:142) 동형 — 프론트 debtRow 는 title/detail/status 만 읽지만
//  레거시 listDebts 의 전 필드(id,kind,title,detail,cited_refs,status,origin)를 방출(하위호환).
export interface V6DebtItem {
  id: number; kind: string; title: string; detail: string | null;
  cited_refs: unknown; status: string; origin: string | null;
}

// debt 목록 — debt_finding WHERE category_id IS NOT NULL(카테고리 귀속 부채만). id 순(레거시 listDebts 동일).
export async function listProductDebts(): Promise<V6DebtItem[]> {
  return q(itemsPool,
    `SELECT id,kind,title,detail,cited_refs,status,origin
       FROM debt_finding WHERE category_id IS NOT NULL ORDER BY id`);
}

// should 변경 이력 — best-effort. org_content_audit(entity='category', op∈update/insert) 에서
//  should 가 실제로 달라진 행만(NULL-aware) 슬라이스해 프론트 shouldChangeRow 가 읽는 필드로 매핑한다.
//  프론트 shouldChangeRow 가 읽는 키: domain_key,domain_id,domain_name,at,should_before,should_after,
//    activity_id,activity_type,activity_title,author_person,author_agent,actor_id.
//  audit 에는 activity 귀속이 없으므로 activity_* 는 null(프론트가 '작업 귀속 없음' 표시). actor=author_person 위치로.
//  entity_key='product/<key>' → domain_key 파생. category 매핑 좌표(현 key/name)도 LEFT JOIN.
export async function listShouldChanges(limit = 100): Promise<any[]> {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return q(itemsPool, `
    SELECT a.id AS change_id, a.at, a.op,
           c.id AS domain_id, c.key AS domain_key, c.name AS domain_name,
           a.before->>'should' AS should_before,
           a.after->>'should'  AS should_after,
           a.actor AS actor_id, a.actor AS author_person, NULL::text AS author_agent,
           NULL::int AS activity_id, NULL::text AS activity_type, NULL::text AS activity_title
    FROM org_content_audit a
    LEFT JOIN category c
      ON c.space='product'
     AND c.key = regexp_replace(a.entity_key, '^product/', '')
    WHERE a.entity='category'
      AND a.op IN ('update','insert')
      AND (a.before->>'should') IS DISTINCT FROM (a.after->>'should')
      AND a.entity_key LIKE 'product/%'
    ORDER BY a.id DESC LIMIT $1`, [lim]);
}

// commit→is 변경 이력 — best-effort. category 는 mapping.category_id 로 코드에 닿지만, change_log 의
//  mapping 변경 스냅샷(before/after)은 구 domain_id 만 담아 category 귀속이 불명확하다(백필은 컬럼만, 감사스냅은 구형).
//  v6 commit→is 의 깨끗한 매핑이 아직 없으므로 [] 반환(프론트 isChangeRow 는 빈 배열 → '아직 기록 없음' 표시).
//  후속: activity_touch(target_kind/target_id) → mapping.category_id 연결 또는 change_log 에 category_id 기록 시 채운다.
export async function listCommitIsChanges(_limit = 100): Promise<any[]> {
  return [];
}

// 한 번에 4묶음 — dmDomainmapView 핸들러가 이걸 호출(레거시 listDomainsApi/listDebts/shouldChangeHistory/
//  commitIsChangeHistory 4종 Promise.all 을 v6 소스로 대체). 응답 shape 는 레거시와 동일(repo 키 포함).
export async function productDomainmapView(limit = 100): Promise<{
  repo: string; domains: V6DomainItem[]; debts: V6DebtItem[];
  should_changes: any[]; is_commit_changes: any[];
  edges: { should: CategoryEdgeRow[]; is: CategoryEdgeRow[] };
}> {
  const [domains, debts, should_changes, is_commit_changes, shouldEdges, isEdges] = await Promise.all([
    listProductDomains(),
    listProductDebts(),
    listShouldChanges(limit),
    listCommitIsChanges(limit),
    listCategoryEdges({ axis: "should" }),
    listCategoryEdges({ axis: "is" }),
  ]);
  // repo 키: category 는 repo-free 라 라벨로 'product' 고정(레거시는 입력 repo 명). 프론트는 repo 키를 안 읽음.
  // edges: 도메인 간 의존 — should(수동 저작 의도) / is(스캔 도출 코드 import). 프론트가 노드 id 로 매칭해
  //  should∖is=선언만(괴리) · is∖should=코드만(괴리) · 교집합=일치 로 3레이어(의도/실제/대조) 렌더.
  //  is 는 refresh 가 imports 를 공급하기 전엔 빈 배열(정직 — '아직 측정 안 됨'으로 표기, 거짓 괴리 방지).
  return { repo: "product", domains, debts, should_changes, is_commit_changes,
    edges: { should: shouldEdges, is: isEdges } };
}

// ── repo-free 개요(구 overview(repo) 대체) — 제품 전체(category) 기준 집계. ──
//  레포-스코프 폐기(v6 결정): code_unit/data_entity/mapping/debt 는 전 레포 합산, domains=product category 수.
//  context_overview(MCP) 가 이걸 서빙 — repo 파람은 accept-and-ignore(category=repo-free). scan_runs/repos 는 다중레포 신호.
export async function productOverview(): Promise<any> {
  const totals = (await q(itemsPool, `SELECT
    (SELECT COUNT(*)::int FROM category WHERE space='product' AND state<>'merged') domains,
    (SELECT COUNT(*)::int FROM code_unit WHERE COALESCE(state,'active')='active') code_units,
    (SELECT COUNT(*)::int FROM data_entity) data_entities,
    (SELECT COUNT(*)::int FROM mapping WHERE category_id IS NOT NULL AND status<>'rejected') mappings,
    (SELECT COUNT(*)::int FROM debt_finding WHERE category_id IS NOT NULL AND status NOT IN ('resolved','dismissed')) debts,
    (SELECT COUNT(*)::int FROM change_log) changes`))[0];
  const scan_runs = await q(itemsPool,
    `SELECT s.id, r.name AS repo, s.runbook, s.harness, s.actor_type, s.actor_id, s.started_at, s.finished_at, s.summary
       FROM scan_run s LEFT JOIN repo r ON r.id=s.repo_id ORDER BY s.id DESC LIMIT 20`);
  const repos = await q(itemsPool, "SELECT name FROM repo ORDER BY name");
  return { space: "product", totals, scan_runs, repos: repos.map((r: any) => r.name) };
}

// ── repo-free 도메인 상세(구 domainDetail(repo,id) 대체) — category(space='product') 1건 + 매핑 코드/엔티티(전 레포) + 부채. ──
//  code_unit 은 멀티레포라 repo 명을 같이 방출(repo-free 뷰에서 어느 레포 코드인지 식별). 매핑 status 무관(removed 포함 — 레거시 동일, 부채 가시화).
export async function productDomainDetail(id: number): Promise<any> {
  const cat = (await q(itemsPool, "SELECT * FROM category WHERE id=$1 AND space='product'", [id]))[0];
  if (!cat) throw httpErr(404, "no such product category: " + id);
  const code_units = await q(itemsPool, `
    SELECT cu.id, cu.kind, cu.path, cu.label, COALESCE(cu.state,'active') state, rp.name AS repo,
           m.id mid, m.status mstatus, m.origin morigin, m.confidence mconf
      FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
      LEFT JOIN repo rp ON rp.id=cu.repo_id
     WHERE m.category_id=$1 AND m.target_kind='code_unit' ORDER BY rp.name, cu.path`, [id]);
  const data_entities = await q(itemsPool, `
    SELECT de.id, de.kind, de.name, de.source, m.id mid, m.status mstatus, m.origin morigin, m.confidence mconf
      FROM mapping m JOIN data_entity de ON de.id=m.target_id
     WHERE m.category_id=$1 AND m.target_kind='data_entity' ORDER BY de.name`, [id]);
  const debts = await q(itemsPool,
    `SELECT id,kind,title,detail,cited_refs,status,origin FROM debt_finding WHERE category_id=$1 ORDER BY id`, [id]);
  return {
    domain: {
      id: cat.id, key: cat.key, name: cat.name, description: cat.description, should: cat.should ?? null,
      state: cat.state, cross_cutting: cat.cross_cutting, origin: cat.origin, status: cat.status, space: cat.space ?? "product",
    },
    code_units: code_units.map((x: any) => ({
      id: x.id, kind: x.kind, path: x.path, label: x.label ?? x.path, state: x.state ?? "active", repo: x.repo ?? null,
      mapping: { id: x.mid, status: x.mstatus, origin: x.morigin, confidence: x.mconf },
    })),
    data_entities: data_entities.map((x: any) => ({
      id: x.id, kind: x.kind, name: x.name, source: x.source, state: "active",
      mapping: { id: x.mid, status: x.mstatus, origin: x.morigin, confidence: x.mconf },
    })),
    debts,
  };
}

// ── 엔티티 vocab(구 listEntitiesApi 대체) — data_entity + best category(mapping.category_id). repo-free. ──
//  mapping-candidates(매핑 검증 vocab)·domainmap_proxy(entities) 가 소비. domain 자리에 {key} 방출(구 shape 호환).
export async function listProductEntities(): Promise<{ id: number; name: string; source: string | null; kind: string; domain: { key: string } | null }[]> {
  const rows = await q(itemsPool, `
    SELECT de.id, de.name, de.source, de.kind,
      (SELECT c.key FROM mapping m JOIN category c ON c.id=m.category_id
        WHERE m.target_kind='data_entity' AND m.target_id=de.id
          AND m.category_id IS NOT NULL AND m.status<>'rejected'
        ORDER BY m.confidence DESC NULLS LAST, m.category_id ASC LIMIT 1) AS domain_key
    FROM data_entity de ORDER BY de.name, de.source`);
  return rows.map((e: any) => ({ id: e.id, name: e.name, source: e.source ?? null, kind: e.kind, domain: e.domain_key ? { key: e.domain_key } : null }));
}

// v6 은퇴(2026-06-24): listAllCategories(평면 vocab 목록)·categoryActiveCounts(카테고리별 active 지식수)는
//  유일 소비자였던 all_domains(/api/ui/domains) 제거로 고아 → 삭제. 카테고리 목록은 category_list(category-store) 단일 표면.

// ── 레포 목록(구 listRepos 대체) — repo 는 실엔티티(유지). domains 카운트만 category-도달 기준으로 v6화. ──
//  domains = 그 레포 code_unit 이 매핑으로 닿는 distinct category 수(멀티레포 — category 는 repo-free라 '도달' 개념).
export async function listReposV6(): Promise<any[]> {
  const repos = await q(itemsPool, "SELECT * FROM repo ORDER BY name");
  const out: any[] = [];
  for (const r of repos) {
    const t = (await q(itemsPool, `SELECT
      (SELECT COUNT(DISTINCT m.category_id)::int FROM mapping m JOIN code_unit cu ON cu.id=m.target_id
         WHERE cu.repo_id=$1 AND m.target_kind='code_unit' AND m.category_id IS NOT NULL AND m.status<>'rejected') domains,
      (SELECT COUNT(*)::int FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active') code_units,
      (SELECT COUNT(*)::int FROM data_entity WHERE repo_id=$1) data_entities,
      (SELECT COUNT(*)::int FROM mapping WHERE repo_id=$1) mappings,
      (SELECT COUNT(*)::int FROM debt_finding WHERE repo_id=$1) debts,
      (SELECT COUNT(*)::int FROM change_log WHERE repo_id=$1) changes`, [r.id]))[0];
    out.push({
      name: r.name, clone_url: sanitizeCloneUrl(r.git_url), default_branch: r.default_branch ?? "main", state: r.state ?? "active",
      detected_stack: r.detected_stack ?? {}, totals: t,
      freshness: computeFreshness(r, t.code_units),
    });
  }
  return out;
}

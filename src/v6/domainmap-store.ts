// v6 도메인맵 read — 구 domain/mapping/debt_finding(레포 스코프) 대신 category(space='product') 소스.
//  골든리드로 핀(pin)된 src/domainmap/core/queries.ts 는 건드리지 않는다(레거시 #/domainmap 와 byte-compat 보존).
//  이 파일은 **신규 v6 reader** — 같은 응답 shape(domains/debts/should_changes/is_commit_changes)를 category 에서 조립한다.
//  프론트(public/app.js domainmapBody)가 읽는 도메인별 필드 이름을 그대로 방출한다:
//    key,name,description,should,state,cross_cutting,origin,status,space,units,entities,debts,proposed
//  category 는 멀티레포(repo_id 없음)라 repos(도달 레포 distinct 수)를 추가 신호로 더한다(프론트는 무시 — 가산·하위호환).
//  DB 는 물리 통합(dmPool()=itemsPool)이라 category(items)와 code_unit/debt_finding/activity(domainmap)를 한 풀에서 조인한다.
import { itemsPool } from "../items/store.js";
import { q } from "../domainmap/db.js";

// 레거시 DomainListItem(types.ts:123) 과 키 집합 동형 + repos(v6 멀티레포 신호) 가산.
//  units/entities/debts/proposed 는 ::int 캐스트(미캐스트 시 pg int8 → string, 프론트 fmtNum 깨짐).
export interface V6DomainItem {
  id: number; key: string; name: string | null; description: string | null;
  should: string | null; state: string | null; cross_cutting: boolean;
  origin: string | null; status: string; space: string;
  units: number; entities: number; debts: number; proposed: number;
  repos: number; // v6 가산: 매핑으로 도달하는 distinct code_unit.repo_id 수(멀티레포 신호). 프론트 무시.
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
      c.origin, c.status,
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
  }));
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
}> {
  const [domains, debts, should_changes, is_commit_changes] = await Promise.all([
    listProductDomains(),
    listProductDebts(),
    listShouldChanges(limit),
    listCommitIsChanges(limit),
  ]);
  // repo 키: category 는 repo-free 라 라벨로 'product' 고정(레거시는 입력 repo 명). 프론트는 repo 키를 안 읽음.
  return { repo: "product", domains, debts, should_changes, is_commit_changes };
}

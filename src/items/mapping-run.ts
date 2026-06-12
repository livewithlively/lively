// 결정적 매퍼 오케스트레이션 (DESIGN §7 우선순위) — LLM 0, 전부 mapped_by='rule', state='proposed'.
// 흐름: 후보 로드 → 아이템 페이지 순회 → D2 컨테이너맵 → D3 엔티티/슬러그 토큰 → D4 parent 상속
//       → D5 xref(mentions)+상속 / P1 명시참조(코로보레이션된 것만) → P2 proto-project lift → P3 컨테이너→프로젝트 → P4 상속.
// 모든 쓰기는 store.ts 의 proposeItemDomain/proposeItemProject 단일 경로(검증·가드레일 공유).
// 절대 규칙을 넓혀 pre-pivot 데이터를 억지 매핑하지 않는다 — 미매핑은 신호.
import { itemsPool, proposeItemDomain, proposeItemProject, addRelation } from "./store.js";
import { loadCandidates, type Candidates } from "./mapping-candidates.js";
import { containerDomains, containerProjects } from "./mapping-config.js";
import {
  capText, extractEntityTokens, extractDomainSlugTokens, extractProjectSlugs,
  extractIssueKeys, extractHashRefs, extractCloseRefs, extractUrls,
  parseDiscordDeepLink, parseNotionPageId,
} from "./mapping-extract.js";
import { logger } from "../log.js";

export interface MapReport {
  repo: string;
  scanned: number;
  domainWrites: Record<string, number>;  // 규칙별 inserted/refreshed 합
  projectWrites: Record<string, number>;
  relations: number;
  unmapped: number;
  propagationPasses?: number;  // 전파 fixpoint 에 든 패스 수(진단용)
}

interface ItemRow {
  id: number;
  prov_system: string;
  container_ref: string | null;
  parent_id: number | null;
  title: string | null;
  body: string | null;
  fields: Record<string, unknown> | null;
}

const inc = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

// 매퍼 발 쓰기의 감사 표식 — item_mapping_audit.source/actor 로 영속(검증 경로 입증).
const MAPPER_AUDIT = { source: "mapper", actor: process.env.USER ?? process.env.LOGNAME ?? "mapper" };

export async function runDeterministicMapping(
  opts: { repo?: string; since?: string; systems?: string[]; limit?: number } = {},
): Promise<MapReport> {
  const candidates = await loadCandidates(opts.repo); // domainmap 다운이면 여기서 throw → run 중단(미검증 write 금지)
  const repo = candidates.repo;
  const entityNames = [...candidates.entityToDomainKey.keys()];

  const report: MapReport = {
    repo, scanned: 0, domainWrites: {}, projectWrites: {}, relations: 0, unmapped: 0,
  };

  // 매핑 결과 누적 헬퍼 — propose 결과 action 을 규칙 라벨별로 집계.
  // 헬퍼 반환값 = '새 매핑이 생겼나'(inserted). refreshed(동일 confidence 멱등 재기록)는
  // 새 정보가 아니므로 fixpoint 신호로도, 리포트 카운트로도 세지 않는다(전파 루프 무한반복 방지).
  // skipped-*(보호) 역시 제외. → 리포트 카운터는 'net 신규 매핑 수'를 뜻한다.
  const writeDomain = async (itemId: number, key: string, rule: string, confidence: number): Promise<boolean> => {
    const r = await proposeItemDomain(
      { itemId, domainKey: key, mappedBy: "rule", repo, confidence }, { candidates, audit: MAPPER_AUDIT },
    );
    if (r.action === "inserted") { inc(report.domainWrites, rule); return true; }
    return false;
  };
  const writeProject = async (itemId: number, key: string, rule: string, confidence: number): Promise<boolean> => {
    const r = await proposeItemProject(
      { itemId, projectKey: key, mappedBy: "rule", repo, confidence }, { candidates, audit: MAPPER_AUDIT },
    );
    if (r.action === "inserted") { inc(report.projectWrites, rule); return true; }
    return false;
  };

  // 아이템 페이지 순회 — raw jsonb 는 안 끌어옴(본문은 capped). 시스템/since 필터.
  const where: string[] = [];
  const args: unknown[] = [];
  const ph = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (opts.systems?.length) where.push(`prov_system = ANY(${ph(opts.systems)})`);
  if (opts.since) where.push(`occurred_at >= ${ph(opts.since)}`);
  const limitClause = opts.limit ? `LIMIT ${Math.max(1, opts.limit | 0)}` : "";
  const sql = `
    SELECT id, prov_system, container_ref, parent_id, title,
           left(body, ${capTextLen()}) AS body, fields
    FROM item
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id ASC ${limitClause}`;

  // 매핑이 하나라도 생긴 아이템 집합(진단용).
  const mappedItems = new Set<number>();

  const cur = await itemsPool.query<ItemRow>(sql, args);

  // ── 패스 1: 비전파 구조 규칙(D2/D3/D3b/P1/P3/P2) + xref relation 생성 ──
  // 이 규칙들은 다른 아이템의 매핑에 의존하지 않으므로 1패스로 충분.
  // D5/P4 xref relation('mentions')은 여기서 만들어두고(매핑 상속 자체는 전파 루프에서), URL 해소만 1회.
  for (const it of cur.rows) {
    report.scanned++;
    const text = `${it.title ?? ""}\n${capText(it.body)}`;

    // ── D2: 컨테이너→도메인 (config) ──
    for (const dk of containerDomains(it.prov_system, it.container_ref)) {
      if (await writeDomain(it.id, dk, "D2_container", 0.9)) mappedItems.add(it.id);
    }

    // ── D3: 엔티티 토큰 → 그 엔티티의 domain_key ──
    for (const ent of extractEntityTokens(text, entityNames)) {
      const dk = candidates.entityToDomainKey.get(ent);
      if (dk && await writeDomain(it.id, dk, "D3_entity", 0.7)) mappedItems.add(it.id);
    }
    // ── D3b: 도메인 slug 토큰 → domain_key ──
    for (const dk of extractDomainSlugTokens(text, candidates.domainKeys, candidates.domainNames)) {
      if (await writeDomain(it.id, dk, "D3_slug", 0.6)) mappedItems.add(it.id);
    }

    // ── P3: 컨테이너→프로젝트 (config) ──
    for (const pk of containerProjects(it.prov_system, it.container_ref)) {
      if (await writeProject(it.id, pk, "P3_container", 0.9)) mappedItems.add(it.id);
    }

    // ── P1: 명시 참조 — 코로보레이션된 것만(억지 매핑 방지) ──
    // 프로젝트 slug 직접 언급.
    for (const pk of extractProjectSlugs(text, candidates.projectKeys, candidates.projectNames)) {
      if (await writeProject(it.id, pk, "P1_project_slug", 0.7)) mappedItems.add(it.id);
    }
    // 이슈키/해시는 외부 트래커 식별자 — 우리 domainmap project_key 와 직접 일치하는 경우만 채택.
    // (현재 라이브엔 외부 트래커 아이템이 없어 0건이지만 엔진은 갖춰둠.)
    const issueKeys = extractIssueKeys(text).filter((k) => k.corroborated);
    void issueKeys; // resolveExternalRefToProject 자리 — domainmap 에 외부키 매핑 테이블 생기면 연결.
    const closeRefs = extractCloseRefs(text);
    void closeRefs;
    void extractHashRefs; // 엔진 보존(현재 데이터 0건)

    // ── P2: proto-project lift — Jira epic/sprint, GitHub milestone (fields 기반) ──
    for (const pk of protoProjectKeys(it.fields, candidates)) {
      if (await writeProject(it.id, pk, "P2_proto", 0.6)) mappedItems.add(it.id);
    }

    // ── xref relation 생성: 본문 URL → 다른 item 해소 → relation('mentions') ──
    // 매핑 상속(D5/P4)은 전파 루프에서. 여기선 relation 만 1회 만들고 캐시.
    for (const url of extractUrls(text)) {
      const target = await resolveUrlToItem(url, it.prov_system);
      if (target && target !== it.id) {
        if (await addRelation(it.id, target, "mentions")) report.relations++;
      }
    }
  }

  // ── 패스 2..N: 전파 규칙 fixpoint — D5/P4 xref 상속 + D4/P4 parent 상속 ──
  // 전파 규칙은 다른 아이템의 매핑에 의존(낮은 id 가 높은 id 를 참조하면 1패스로 미수렴).
  // 쓰기 0 이 될 때까지 반복(상한 가드 MAX_PROPAGATION_PASSES). 멱등 upsert 라 안전.
  const MAX_PROPAGATION_PASSES = 5;
  let passes = 0;
  let converged = false;
  for (let i = 0; i < MAX_PROPAGATION_PASSES; i++) {
    passes++;
    let writes = 0;
    writes += await propagateXrefInheritance(cur.rows, repo, candidates, report, mappedItems, writeDomain, writeProject);
    writes += await propagateParentInheritance(cur.rows, repo, candidates, report, mappedItems);
    if (writes === 0) { converged = true; break; } // fixpoint: 이번 패스에 새 매핑 0
  }
  if (!converged) {
    logger.warn({ msg: "전파 fixpoint 미수렴(상한 도달) — 한 번 더 실행 권장", passes });
  }

  // unmapped 카운트: DB 권위(inbox 와 동일 술어) — NOT EXISTS item_domain OR NOT EXISTS item_project.
  // in-memory 근사가 아니라 실제 DB 상태로 계산해 inbox 툴과 일치시킨다(과거 run 의 잔존 매핑도 정확 반영).
  report.unmapped = await countUnmapped(cur.rows.map((r) => r.id), repo);
  report.propagationPasses = passes;
  logger.info({ msg: "mapping run 완료", ...report });
  return report;
}

function capTextLen(): number {
  return 50_000;
}

// P2 — fields 에서 proto-project 신호 추출(Jira epic/sprint, GitHub milestone). 우리 project_key 와 일치할 때만.
function protoProjectKeys(fields: Record<string, unknown> | null, c: Candidates): string[] {
  if (!fields) return [];
  const out = new Set<string>();
  const candidates = [
    fields["epic"], fields["epic_key"], fields["sprint"],
    fields["milestone"], fields["milestone_title"],
  ];
  for (const v of candidates) {
    if (typeof v === "string" && c.projectsByKey.has(v)) out.add(v);
  }
  return [...out];
}

// 본문 URL → 우리 item.id 해소(D5). discord 딥링크 / notion page id 만 현재 지원.
async function resolveUrlToItem(url: string, _system: string): Promise<number | null> {
  const dl = parseDiscordDeepLink(url);
  if (dl) {
    const r = await itemsPool.query<{ id: number }>(
      `SELECT id FROM item WHERE prov_system='discord' AND external_id=$1 LIMIT 1`, [dl.externalId],
    );
    return r.rows[0]?.id ?? null;
  }
  const pid = parseNotionPageId(url);
  if (pid) {
    // notion external_id 는 하이픈 포함 uuid — 하이픈 제거 비교.
    const r = await itemsPool.query<{ id: number }>(
      `SELECT id FROM item WHERE prov_system='notion'
         AND replace(lower(external_id),'-','')=$1 LIMIT 1`, [pid],
    );
    return r.rows[0]?.id ?? null;
  }
  return null;
}

// repo 스코프 필수 — 멀티 repo 환경에서 다른 repo(예: lively)의 매핑을 끌어와
// 현재 repo 에 쓰려고 하면 key 검증에서 throw 되어 run 전체가 죽는다(실제 발생).
// state 필터: rule 전파(D5/P4 xref 상속)가 rejected 행에서 파생되지 않게 살아있는 매핑만 소스로.
async function targetDomains(itemId: number, repo: string): Promise<string[]> {
  const r = await itemsPool.query<{ domain_key: string }>(
    `SELECT domain_key FROM item_domain WHERE item_id=$1 AND repo=$2 AND state IN ('proposed','confirmed')`,
    [itemId, repo]);
  return r.rows.map((x) => x.domain_key);
}
async function targetProjects(itemId: number, repo: string): Promise<string[]> {
  const r = await itemsPool.query<{ project_key: string }>(
    `SELECT project_key FROM item_project WHERE item_id=$1 AND repo=$2 AND state IN ('proposed','confirmed')`,
    [itemId, repo]);
  return r.rows.map((x) => x.project_key);
}

type WriteDomainFn = (itemId: number, key: string, rule: string, confidence: number) => Promise<boolean>;
type WriteProjectFn = (itemId: number, key: string, rule: string, confidence: number) => Promise<boolean>;

// D5/P4 — xref(relation 'mentions') 타깃의 현재 DB 매핑을 source 로 상속(proposed rule 0.5).
// relation 은 패스1에서 이미 생성됨 — 여기선 매핑 상속만(타깃이 이번 run 에 새로 매핑됐을 수 있어 반복 호출됨).
// 반환: 실제 inserted/refreshed 쓰기 수(fixpoint 판정용).
async function propagateXrefInheritance(
  rows: ItemRow[], repo: string, _candidates: Candidates,
  _report: MapReport, mappedItems: Set<number>,
  writeDomain: WriteDomainFn, writeProject: WriteProjectFn,
): Promise<number> {
  let writes = 0;
  for (const it of rows) {
    // 이 아이템이 'mentions' 하는 타깃들.
    const tgts = await itemsPool.query<{ to_item: number }>(
      `SELECT to_item FROM relation WHERE from_item=$1 AND type='mentions'`, [it.id]);
    for (const { to_item } of tgts.rows) {
      for (const dk of await targetDomains(to_item, repo)) {
        if (await writeDomain(it.id, dk, "D5_xref_inherit", 0.5)) { writes++; mappedItems.add(it.id); }
      }
      for (const pk of await targetProjects(to_item, repo)) {
        if (await writeProject(it.id, pk, "P4_xref_inherit", 0.5)) { writes++; mappedItems.add(it.id); }
      }
    }
  }
  return writes;
}

// D4/P4 — parent_id 체인을 사이클 가드와 함께 올라가며 조상 매핑을 상속.
// WITH RECURSIVE + CYCLE 절(Postgres 14+)로 사이클 종료, depth<=32 로 추가 안전망.
// 반환: 실제 inserted/refreshed 쓰기 수(fixpoint 판정용).
async function propagateParentInheritance(
  rows: ItemRow[], repo: string, candidates: Candidates,
  report: MapReport, mappedItems: Set<number>,
): Promise<number> {
  let writes = 0;
  for (const it of rows) {
    if (it.parent_id == null) continue;
    // 조상의 도메인/프로젝트 키 수집(사이클 안전).
    const anc = await itemsPool.query<{ domain_key: string | null; project_key: string | null }>(
      `WITH RECURSIVE chain(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM item WHERE id=$1
         UNION ALL
         SELECT i.id, i.parent_id, c.depth+1
         FROM item i JOIN chain c ON i.id = c.parent_id
         WHERE c.depth < 32
       ) CYCLE id SET is_cycle USING path
       SELECT DISTINCT d.domain_key, NULL::text AS project_key
         FROM chain c JOIN item_domain d ON d.item_id=c.id AND d.repo=$2
              AND d.state IN ('proposed','confirmed')  -- D4 상속 소스에서 rejected 제외
         WHERE c.depth>0
       UNION
       SELECT NULL::text, p.project_key
         FROM chain c JOIN item_project p ON p.item_id=c.id AND p.repo=$2
              AND p.state IN ('proposed','confirmed')
         WHERE c.depth>0`,
      [it.id, repo],
    );
    for (const a of anc.rows) {
      if (a.domain_key && candidates.domainsByKey.has(a.domain_key)) {
        const r = await proposeItemDomain(
          { itemId: it.id, domainKey: a.domain_key, mappedBy: "rule", repo, confidence: 0.5 },
          { candidates, audit: MAPPER_AUDIT });
        if (r.action === "inserted") { inc(report.domainWrites, "D4_parent_inherit"); mappedItems.add(it.id); writes++; }
      }
      if (a.project_key && candidates.projectsByKey.has(a.project_key)) {
        const r = await proposeItemProject(
          { itemId: it.id, projectKey: a.project_key, mappedBy: "rule", repo, confidence: 0.5 },
          { candidates, audit: MAPPER_AUDIT });
        if (r.action === "inserted") { inc(report.projectWrites, "P4_parent_inherit"); mappedItems.add(it.id); writes++; }
      }
    }
  }
  return writes;
}

// unmapped 카운트 — inbox(unmappedItemsUi missing='either')와 동일 술어를 DB 에서 직접 계산하되,
// **현재 run 의 repo 로 스코프**한다(다른 repo 의 매핑이 '매핑됨'으로 잘못 집계되는 것 방지).
// 도메인 누락 OR 프로젝트 누락 = unmapped. 스캔 대상(ids)으로 한정.
// '매핑 있음' = state IN ('proposed','confirmed') — rejected-only 아이템은 미매핑(inbox 술어와 정렬).
async function countUnmapped(ids: number[], repo: string): Promise<number> {
  if (!ids.length) return 0;
  const r = await itemsPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM item i
       WHERE i.id = ANY($1)
         AND (NOT EXISTS (SELECT 1 FROM item_domain d  WHERE d.item_id=i.id AND d.repo=$2 AND d.state IN ('proposed','confirmed'))
           OR NOT EXISTS (SELECT 1 FROM item_project p WHERE p.item_id=i.id AND p.repo=$2 AND p.state IN ('proposed','confirmed')))`,
    [ids, repo],
  );
  return Number(r.rows[0]?.n ?? 0);
}

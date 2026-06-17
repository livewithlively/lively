// 통합 지식스토어(데이터층) — knowledge_unit 단일 캐노니컬 접근 계층.
// org_memory(메모) + org_content(규칙/페르소나)을 흡수한 단일 테이블 위의 읽기/쓰기. 기존 store.ts 의
//  section/memory 함수는 이 모듈 위 얇은 래퍼로 재구현된다(시그니처·반환 shape 불변, 듀얼라이트 없음).
// 모든 쓰기는 org_content_audit(append-only)에 before/after 를 남기고 version 을 올린다(store.ts audit 과 동일 계약,
//  redactDeep 로 시크릿 제거). 검색은 title/body_md ILIKE + kind/lifecycle/domain 필터(pgvector 의미검색은 후속).
import { itemsPool } from "../items/store.js";
import { redactDeep } from "./redact.js";
import { embeddingsUsable, embedOne, toVectorLiteral } from "../embeddings/index.js";
import { logger } from "../log.js";

// confidence 는 호출자가 자칭하지 못한다 — 쓰기 출처(source)로 서버에서 강제한다.
//  source='mcp'(에이전트 생산) → 'ai', source='web'(사람 편집) → 'human', 그 외/지정 → 'rule'.
export type KnowledgeConfidence = "ai" | "rule" | "human";
export type KnowledgeLifecycle = "active" | "rejected" | "superseded";
// lifecycle 화이트리스트(런타임) — setLifecycle 검증 1곳. schema CHECK(knowledge_unit_lifecycle_chk)와 동치.
//  ReadonlySet<string> 로 노출(has 는 임의 문자열 입력 검증용) — 멤버 값 자체는 리터럴로 고정.
export const KNOWLEDGE_LIFECYCLES: ReadonlySet<string> = new Set<KnowledgeLifecycle>(["active", "rejected", "superseded"]);

export interface KnowledgeUnit {
  name: string;
  kind: string;
  kinds: string[];
  title: string | null;
  body_md: string;
  domain_key: string | null;   // domainmap 도메인 귀속(슬러그 약결합 — FK 아님)
  domain_repo: string | null;  // 그 도메인의 repo(domainmap 은 repo 별 스코프)
  lifecycle: KnowledgeLifecycle;
  supersedes: string | null;
  confidence: KnowledgeConfidence;
  author: string | null;
  source_ref: string | null;
  as_of: string | null;
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export const KNOWLEDGE_COLS =
  "name, kind, kinds, title, body_md, domain_key, domain_repo, lifecycle, supersedes, confidence, author, source_ref, as_of, sort, version, updated_at, updated_by";

function mapKnowledge(row: Record<string, unknown>): KnowledgeUnit {
  return {
    name: row.name as string,
    kind: (row.kind as string) ?? "K",
    kinds: Array.isArray(row.kinds) ? (row.kinds as string[]) : [],
    title: (row.title as string) ?? null,
    body_md: (row.body_md as string) ?? "",
    domain_key: (row.domain_key as string) ?? null,
    domain_repo: (row.domain_repo as string) ?? null,
    lifecycle: (row.lifecycle as KnowledgeLifecycle) ?? "active",
    supersedes: (row.supersedes as string) ?? null,
    confidence: (row.confidence as KnowledgeConfidence) ?? "human",
    author: (row.author as string) ?? null,
    source_ref: (row.source_ref as string) ?? null,
    as_of: (row.as_of as string) ?? null,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

// ── 감사(append-only) — store.ts audit 과 동일 계약. before/after 는 redactDeep 후 굳힌다. ──
async function auditKnowledge(
  key: string | null,
  op: string,
  before: unknown,
  after: unknown,
  actor: string | undefined,
  source: string | undefined,
): Promise<void> {
  const b = before == null ? null : JSON.stringify(redactDeep(before));
  const a = after == null ? null : JSON.stringify(redactDeep(after));
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source)
     VALUES('knowledge_unit',$1,$2,$3::jsonb,$4::jsonb,$5,$6)`,
    [key, op, b, a, actor ?? null, source ?? null],
  );
}

// ── 읽기 ──
export async function getKnowledge(name: string): Promise<KnowledgeUnit | null> {
  const r = await itemsPool.query(
    `SELECT ${KNOWLEDGE_COLS} FROM knowledge_unit WHERE name=$1`, [name],
  );
  return r.rows[0] ? mapKnowledge(r.rows[0]) : null;
}

export async function listKnowledge(opts: {
  kind?: string | null;
  lifecycle?: KnowledgeLifecycle | null;
  domainKey?: string | null;
  confidence?: string | null;
} = {}): Promise<KnowledgeUnit[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) { params.push(opts.kind); where.push(`kind=$${params.length}`); }
  if (opts.lifecycle) { params.push(opts.lifecycle); where.push(`lifecycle=$${params.length}`); }
  if (opts.domainKey) { params.push(opts.domainKey); where.push(`domain_key=$${params.length}`); }
  if (opts.confidence) { params.push(opts.confidence); where.push(`confidence=$${params.length}`); } // Review 피드용
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await itemsPool.query(
    `SELECT ${KNOWLEDGE_COLS} FROM knowledge_unit ${clause} ORDER BY sort, name`, params,
  );
  return r.rows.map(mapKnowledge);
}

// ── overview — kind_registry LEFT JOIN active knowledge_unit 집계(웹 UI 대시보드용). ──
//  kind_registry 정렬순(sort, kind) 으로 종류별 active 개수·최신 갱신시각, 전체 active 합,
//  Review 대기(confidence='ai' AND lifecycle='active') 카운트를 한 번에 반환. 소수 쿼리.
export interface KnowledgeOverviewKind {
  kind: string; label: string; injection_mode: string;
  active_count: number; latest_updated_at: string | null;
}
export interface KnowledgeOverview {
  kinds: KnowledgeOverviewKind[];
  total_active: number;
  review_pending: number;
}

export async function overviewKnowledge(): Promise<KnowledgeOverview> {
  // kind 별 집계 — registry 가 좌측(종류 0건도 행 유지), active 만 집계(LEFT JOIN 조건절).
  const kindsRes = await itemsPool.query(
    `SELECT r.kind, r.label, r.injection_mode,
            COUNT(k.name)::int AS active_count,
            MAX(k.updated_at) AS latest_updated_at
       FROM kind_registry r
       LEFT JOIN knowledge_unit k ON k.kind = r.kind AND k.lifecycle = 'active'
      GROUP BY r.kind, r.label, r.injection_mode, r.sort
      ORDER BY r.sort, r.kind`,
  );
  // 전체 active + Review 대기(ai·active)를 한 행으로.
  const aggRes = await itemsPool.query(
    `SELECT COUNT(*) FILTER (WHERE lifecycle='active')::int AS total_active,
            COUNT(*) FILTER (WHERE lifecycle='active' AND confidence='ai')::int AS review_pending
       FROM knowledge_unit`,
  );
  const agg = aggRes.rows[0] ?? {};
  return {
    kinds: kindsRes.rows.map((row) => ({
      kind: row.kind as string,
      label: (row.label as string) ?? "",
      injection_mode: (row.injection_mode as string) ?? "manual",
      active_count: Number(row.active_count) || 0,
      latest_updated_at: (row.latest_updated_at as string) ?? null,
    })),
    total_active: Number(agg.total_active) || 0,
    review_pending: Number(agg.review_pending) || 0,
  };
}

// ════════ ground-truth 레지스트리(kind_registry + data_source) — 런북·웹 #/learn 단일 출처(D-GT). ════════
// 지식유형/분류기준/저장방식/전달방식을 DB 한 곳에 두고 런북(LLM)·웹(비개발자)이 여기서 렌더(non-stale).
//  하드코딩(materialize.ts RECALLED_KINDS 등) 제거의 원천. 전부 읽기(시드는 schema.ts).

export interface KindRegistryRow {
  kind: string;
  label: string;
  injection_mode: string;
  audience: string | null;
  cardinality: string;
  domain_scoped: boolean;
  description: string;
  criteria: string;
  storage: string;
  delivery: string;
  sort: number;
}

const KIND_REGISTRY_COLS =
  "kind, label, injection_mode, audience, cardinality, domain_scoped, description, criteria, storage, delivery, sort";

function mapKindRegistry(row: Record<string, unknown>): KindRegistryRow {
  return {
    kind: row.kind as string,
    label: (row.label as string) ?? "",
    injection_mode: (row.injection_mode as string) ?? "manual",
    audience: (row.audience as string) ?? null,
    cardinality: (row.cardinality as string) ?? "many",
    domain_scoped: !!row.domain_scoped,
    description: (row.description as string) ?? "",
    criteria: (row.criteria as string) ?? "",
    storage: (row.storage as string) ?? "",
    delivery: (row.delivery as string) ?? "",
    sort: (row.sort as number) ?? 0,
  };
}

// 전체 kind 레지스트리(정의 ground-truth). sort, kind 순.
export async function listKindRegistry(): Promise<KindRegistryRow[]> {
  const r = await itemsPool.query(
    `SELECT ${KIND_REGISTRY_COLS} FROM kind_registry ORDER BY sort, kind`,
  );
  return r.rows.map(mapKindRegistry);
}

// injection_mode 로 kind 목록 — materialize.ts 가 하드코딩 RECALLED_KINDS 대신 이걸로(non-stale).
//  {kind,label} 의 sort 순 배열을 반환. 빈 레지스트리(스키마 미초기화)면 빈 배열(호출자 폴백 없이 안전).
export async function kindsByInjectionMode(mode: string): Promise<{ kind: string; label: string }[]> {
  const r = await itemsPool.query(
    `SELECT kind, label FROM kind_registry WHERE injection_mode=$1 ORDER BY sort, kind`, [mode],
  );
  return r.rows.map((row) => ({ kind: row.kind as string, label: (row.label as string) ?? (row.kind as string) }));
}

export interface DataSourceRow {
  system: string;
  label: string;
  status: string;          // 'active' | 'dropped'
  collection_method: string;
  cadence: string | null;
  into_kinds: string[];
  note: string | null;
  sort: number;
}

const DATA_SOURCE_COLS = "system, label, status, collection_method, cadence, into_kinds, note, sort";

function mapDataSource(row: Record<string, unknown>): DataSourceRow {
  return {
    system: row.system as string,
    label: (row.label as string) ?? "",
    status: (row.status as string) ?? "active",
    collection_method: (row.collection_method as string) ?? "",
    cadence: (row.cadence as string) ?? null,
    into_kinds: Array.isArray(row.into_kinds) ? (row.into_kinds as string[]) : [],
    note: (row.note as string) ?? null,
    sort: (row.sort as number) ?? 0,
  };
}

export async function listDataSources(): Promise<DataSourceRow[]> {
  const r = await itemsPool.query(
    `SELECT ${DATA_SOURCE_COLS} FROM data_source ORDER BY sort, system`,
  );
  return r.rows.map(mapDataSource);
}

// learn ground-truth 묶음 — 웹 #/learn(GET /api/ui/learn)·런북 빌더 공용. kind 정의 + 소스별 수집방식.
export interface LearnGroundTruth {
  kinds: KindRegistryRow[];
  sources: DataSourceRow[];
}
export async function learnGroundTruth(): Promise<LearnGroundTruth> {
  const [kinds, sources] = await Promise.all([listKindRegistry(), listDataSources()]);
  return { kinds, sources };
}

// 검색 — org_memory searchMemory 의 ILIKE 백엔드를 knowledge_unit 에 이식 + kind/lifecycle/domain 필터.
//  본문은 스니펫(240자)만. LIKE 메타문자(\ % _)는 백슬래시 이스케이프(기본 escape=백슬래시).
export interface KnowledgeSearchHit {
  name: string; title: string | null; domain_key: string | null; snippet: string; updated_at: string | null;
}

function mapSearchRow(row: Record<string, unknown>): KnowledgeSearchHit {
  return {
    name: row.name as string, title: (row.title as string) ?? null,
    domain_key: (row.domain_key as string) ?? null, updated_at: (row.updated_at as string) ?? null,
    snippet: String(row.body_md ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

export async function searchKnowledge(opts: {
  query: string;
  kind?: string | null;
  kindNot?: string | null;
  domainKey?: string | null;
  lifecycle?: KnowledgeLifecycle | null;
  limit?: number;
}): Promise<KnowledgeSearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  // ── 공통 필터 빌더 — ILIKE/벡터 양 경로가 동일 kind/lifecycle/domain WHERE 를 공유한다. ──
  const buildFilters = (params: unknown[]): string[] => {
    const where: string[] = [];
    if (opts.kind) { params.push(opts.kind); where.push(`kind=$${params.length}`); }
    if (opts.kindNot) { params.push(opts.kindNot); where.push(`kind <> $${params.length}`); }
    if (opts.lifecycle) { params.push(opts.lifecycle); where.push(`lifecycle=$${params.length}`); }
    if (opts.domainKey) { params.push(opts.domainKey); where.push(`domain_key=$${params.length}`); }
    return where;
  };

  // ── ILIKE 검색(현 동작, 항상 실행) — OFF 기본에선 이 경로만 탄다(동작 변화 0). ──
  const ilike = async (): Promise<KnowledgeSearchHit[]> => {
    const params: unknown[] = [];
    const like = `%${opts.query.replace(/[\\%_]/g, (m) => "\\" + m)}%`; // LIKE 메타문자 이스케이프
    params.push(like);
    const where = [`(title ILIKE $${params.length} OR body_md ILIKE $${params.length})`, ...buildFilters(params)];
    params.push(limit);
    const r = await itemsPool.query(
      `SELECT name, title, domain_key, body_md, updated_at FROM knowledge_unit
         WHERE ${where.join(" AND ")} ORDER BY updated_at DESC NULLS LAST LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(mapSearchRow);
  };

  // OFF 기본/provider 미사용/컬럼 미가용 → 임베딩 코드 경로 진입조차 안 함. 반환 shape·snippet 240 불변.
  if (!embeddingsUsable()) return ilike();

  // ── ON 경로: ILIKE 후보 ∪ 코사인 top-N 을 RRF(Reciprocal Rank Fusion)로 병합. 실패하면 ILIKE 폴백. ──
  try {
    const vec = await embedOne(opts.query);
    if (!vec) return ilike(); // 임베딩 계산 실패 → 폴백

    const ilikeHits = await ilike();

    // 벡터 후보: 같은 필터 + embedding NOT NULL, 코사인거리 오름차순 top-N(over-fetch 로 병합 품질 확보).
    const vparams: unknown[] = [];
    const where = ["embedding IS NOT NULL", ...buildFilters(vparams)];
    vparams.push(toVectorLiteral(vec)); const vecIdx = vparams.length;
    vparams.push(Math.min(limit * 4, 50)); const limIdx = vparams.length;
    const vr = await itemsPool.query(
      `SELECT name, title, domain_key, body_md, updated_at FROM knowledge_unit
         WHERE ${where.join(" AND ")}
         ORDER BY embedding <=> $${vecIdx}::vector LIMIT $${limIdx}`,
      vparams,
    );
    const vecHits = vr.rows.map(mapSearchRow);

    // RRF 병합(k=60) — 두 랭킹의 역수합 점수로 정렬, name 으로 중복 제거. 동점 안정정렬은 삽입 순서.
    const K = 60;
    const score = new Map<string, number>();
    const byName = new Map<string, KnowledgeSearchHit>();
    const accum = (hits: KnowledgeSearchHit[]) => {
      hits.forEach((h, i) => {
        score.set(h.name, (score.get(h.name) ?? 0) + 1 / (K + i + 1));
        if (!byName.has(h.name)) byName.set(h.name, h);
      });
    };
    accum(ilikeHits);
    accum(vecHits);
    return [...byName.keys()]
      .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
      .slice(0, limit)
      .map((n) => byName.get(n)!);
  } catch (err) {
    logger.warn({ err }, "하이브리드 검색 실패 — ILIKE 로 폴백");
    return ilike();
  }
}

export interface KnowledgeInput {
  name: string;
  kind?: string;
  kinds?: string[];
  title?: string | null;
  body_md?: string;
  domain_key?: string | null;
  domain_repo?: string | null;
  lifecycle?: KnowledgeLifecycle;
  supersedes?: string | null;
  author?: string | null;
  source_ref?: string | null;
  as_of?: string | null;
  sort?: number;
}

// confidence 서버강제 — 호출자가 'human' 을 자칭하지 못하게 source 로 결정한다.
function confidenceFor(source: string | undefined): KnowledgeConfidence {
  if (source === "mcp") return "ai";     // 에이전트 생산
  if (source === "web") return "human";  // 사람(관리 UI) 편집
  return "rule";                          // migration/기타 — 규칙 파생 취급
}

// upsert — ON CONFLICT(name) version+1(낙관락 관례) + audit + confidence 서버강제. lifecycle 기본 'active'.
//  undefined 인자는 미변경(이전값 유지), 명시 null 은 클리어 — null 의미를 보존한다.
export async function upsertKnowledge(unit: KnowledgeInput, actor?: string, source?: string): Promise<KnowledgeUnit> {
  const before = await getKnowledge(unit.name);
  const confidence = confidenceFor(source);
  const kind = unit.kind ?? before?.kind ?? "K";
  // 이름 충돌 가드: 섹션(R)과 메모리(비R)는 단일 name PK 를 공유하므로, 기존 단위의 R-여부를 뒤집는
  //  쓰기를 거부한다(동명 충돌로 강제규칙/메모리가 무경고 소멸하는 것 방지 — section↔memory 격리).
  if (before && (before.kind === "R") !== (kind === "R")) {
    throw new Error(
      `이름 충돌: '${unit.name}' 은 이미 ${before.kind === "R" ? "섹션(규칙/페르소나)" : "메모리"} 으로 존재합니다 — 섹션과 메모리는 같은 이름이 허용되지 않습니다.`,
    );
  }
  const kinds = unit.kinds ?? before?.kinds ?? [];
  const lifecycle = unit.lifecycle ?? before?.lifecycle ?? "active";
  await itemsPool.query(
    `INSERT INTO knowledge_unit(name, kind, kinds, title, body_md, domain_key, domain_repo,
        lifecycle, supersedes, confidence, author, source_ref, as_of, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,now(),$15)
     ON CONFLICT (name) DO UPDATE SET
       kind=EXCLUDED.kind, kinds=EXCLUDED.kinds, title=EXCLUDED.title, body_md=EXCLUDED.body_md,
       domain_key=EXCLUDED.domain_key, domain_repo=EXCLUDED.domain_repo,
       lifecycle=EXCLUDED.lifecycle, supersedes=EXCLUDED.supersedes, confidence=EXCLUDED.confidence,
       author=EXCLUDED.author, source_ref=EXCLUDED.source_ref, as_of=EXCLUDED.as_of, sort=EXCLUDED.sort,
       version=knowledge_unit.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [unit.name, kind, JSON.stringify(kinds),
     unit.title ?? before?.title ?? null,
     unit.body_md ?? before?.body_md ?? "",
     unit.domain_key === undefined ? (before?.domain_key ?? null) : unit.domain_key,
     unit.domain_repo === undefined ? (before?.domain_repo ?? null) : unit.domain_repo,
     lifecycle,
     unit.supersedes === undefined ? (before?.supersedes ?? null) : unit.supersedes,
     confidence,
     unit.author === undefined ? (before?.author ?? null) : unit.author,
     unit.source_ref === undefined ? (before?.source_ref ?? null) : unit.source_ref,
     unit.as_of === undefined ? (before?.as_of ?? null) : unit.as_of,
     unit.sort ?? before?.sort ?? 0, actor ?? null],
  );
  const after = await getKnowledge(unit.name);
  await auditKnowledge(unit.name, before ? "update" : "insert", before, after, actor, source);

  // 임베딩 갱신(enabled 시 best-effort) — 본문을 임베딩해 embedding 컬럼에 UPDATE. 실패는 무시(검색이 ILIKE 로
  //  폴백하므로 무해). OFF 면 embeddingsUsable()=false 라 진입조차 안 함(컬럼 없음 → UPDATE 미실행).
  if (embeddingsUsable()) {
    try {
      const vec = await embedOne(after?.body_md ?? unit.body_md ?? "");
      if (vec) {
        await itemsPool.query(
          `UPDATE knowledge_unit SET embedding=$2::vector WHERE name=$1`,
          [unit.name, toVectorLiteral(vec)],
        );
      }
    } catch (err) {
      logger.warn({ err, name: unit.name }, "임베딩 저장 실패(무시) — 검색은 ILIKE 폴백");
    }
  }

  return after as KnowledgeUnit;
}

// setLifecycle — lifecycle 만 전환(사람의 사후 반려/복원 — 신뢰우선 모델). version+1 + audit.
//  upsertKnowledge 의 본문/메타 경로를 타지 않는 좁은 쓰기(다른 필드 불변·confidence 도 그대로 보존).
//  없는 name 은 '없음' 토큰 throw(wrap→404), 잘못된 lifecycle 은 '허용' 토큰 throw(wrap→400).
export async function setLifecycle(
  name: string, lifecycle: string, actor?: string, source?: string,
): Promise<KnowledgeUnit> {
  if (!KNOWLEDGE_LIFECYCLES.has(lifecycle)) {
    throw new Error(`lifecycle 은 ${[...KNOWLEDGE_LIFECYCLES].join("|")} 만 허용됩니다`);
  }
  const before = await getKnowledge(name);
  if (!before) throw new Error(`메모리/유닛 없음: ${name}`);
  await itemsPool.query(
    `UPDATE knowledge_unit SET lifecycle=$2, version=version + 1, updated_at=now(), updated_by=$3 WHERE name=$1`,
    [name, lifecycle, actor ?? null],
  );
  const after = await getKnowledge(name);
  await auditKnowledge(name, "set_lifecycle", before, after, actor, source);
  return after as KnowledgeUnit;
}

export async function removeKnowledge(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getKnowledge(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM knowledge_unit WHERE name=$1`, [name]);
  await auditKnowledge(name, "delete", before, null, actor, source);
}

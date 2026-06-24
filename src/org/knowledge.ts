// 지식유형/수집 ground-truth(데이터층) — kind_registry + data_source 테이블 읽기 전용.
//  웹 #/learn(GET /api/ui/learn)·런북 빌더가 여기서 렌더(non-stale, 시드는 schema.ts).
//
// v6 컷오버(2026-06-24): 구 knowledge_unit 단일 접근계층(CRUD·ILIKE/벡터 검색·도메인참조·섹션 래퍼)은 이 모듈에서 제거됐다.
//  - 지식(기록) → v6 knowledge 테이블(src/v6/knowledge-store.ts)
//  - 섹션(규칙·페르소나) → knowledge injection='always' 위 org/store.ts 래퍼
//  - 도메인 active 카운트 → knowledge_category 기준 집계(구 domainActiveCounts/domain_key 폐기; 현재 미소비)
//  - 임베딩(벡터검색) → 폐기(v6 검색은 ILIKE 비-벡터)
//  남은 건 kind_registry/data_source(별도 테이블) 읽기 + learnGroundTruth 묶음뿐 — knowledge_unit 무의존.
import { itemsPool } from "../items/store.js";

// ── 지식유형/수집 ground-truth(kind_registry + data_source) ──
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

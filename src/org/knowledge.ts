// 통합 지식스토어(데이터층) — knowledge_unit 단일 캐노니컬 접근 계층.
// org_memory(메모) + org_content(규칙/페르소나)을 흡수한 단일 테이블 위의 읽기/쓰기. 기존 store.ts 의
//  section/memory 함수는 이 모듈 위 얇은 래퍼로 재구현된다(시그니처·반환 shape 불변, 듀얼라이트 없음).
// 모든 쓰기는 org_content_audit(append-only)에 before/after 를 남기고 version 을 올린다(store.ts audit 과 동일 계약,
//  redactDeep 로 시크릿 제거). 검색은 title/body_md ILIKE + kind/lifecycle/domain 필터(pgvector 의미검색은 후속).
import { itemsPool } from "../items/store.js";
import { redactDeep } from "./redact.js";

// confidence 는 호출자가 자칭하지 못한다 — 쓰기 출처(source)로 서버에서 강제한다.
//  source='mcp'(에이전트 생산) → 'ai', source='web'(사람 편집) → 'human', 그 외/지정 → 'rule'.
export type KnowledgeConfidence = "ai" | "rule" | "human";
export type KnowledgeLifecycle = "active" | "rejected" | "superseded";

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
} = {}): Promise<KnowledgeUnit[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) { params.push(opts.kind); where.push(`kind=$${params.length}`); }
  if (opts.lifecycle) { params.push(opts.lifecycle); where.push(`lifecycle=$${params.length}`); }
  if (opts.domainKey) { params.push(opts.domainKey); where.push(`domain_key=$${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await itemsPool.query(
    `SELECT ${KNOWLEDGE_COLS} FROM knowledge_unit ${clause} ORDER BY sort, name`, params,
  );
  return r.rows.map(mapKnowledge);
}

// 검색 — org_memory searchMemory 의 ILIKE 백엔드를 knowledge_unit 에 이식 + kind/lifecycle/domain 필터.
//  본문은 스니펫(240자)만. LIKE 메타문자(\ % _)는 백슬래시 이스케이프(기본 escape=백슬래시).
export async function searchKnowledge(opts: {
  query: string;
  kind?: string | null;
  kindNot?: string | null;
  domainKey?: string | null;
  lifecycle?: KnowledgeLifecycle | null;
  limit?: number;
}): Promise<{ name: string; title: string | null; domain_key: string | null; snippet: string; updated_at: string | null }[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const like = `%${opts.query.replace(/[\\%_]/g, (m) => "\\" + m)}%`; // LIKE 메타문자 이스케이프
  params.push(like); where.push(`(title ILIKE $${params.length} OR body_md ILIKE $${params.length})`);
  if (opts.kind) { params.push(opts.kind); where.push(`kind=$${params.length}`); }
  if (opts.kindNot) { params.push(opts.kindNot); where.push(`kind <> $${params.length}`); }
  if (opts.lifecycle) { params.push(opts.lifecycle); where.push(`lifecycle=$${params.length}`); }
  if (opts.domainKey) { params.push(opts.domainKey); where.push(`domain_key=$${params.length}`); }
  params.push(Math.min(Math.max(opts.limit ?? 10, 1), 50));
  const r = await itemsPool.query(
    `SELECT name, title, domain_key, body_md, updated_at FROM knowledge_unit
       WHERE ${where.join(" AND ")} ORDER BY updated_at DESC NULLS LAST LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    name: row.name as string, title: (row.title as string) ?? null,
    domain_key: (row.domain_key as string) ?? null, updated_at: (row.updated_at as string) ?? null,
    snippet: String(row.body_md ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
  }));
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
  return after as KnowledgeUnit;
}

export async function removeKnowledge(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getKnowledge(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM knowledge_unit WHERE name=$1`, [name]);
  await auditKnowledge(name, "delete", before, null, actor, source);
}

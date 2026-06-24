// v6 knowledge 데이터 접근 — 구 knowledge_unit 대체(kind 폐기 → injection/provenance 직교축).
//  injection=always(규칙·페르소나, 항상 주입) | recalled(검색 소환). provenance=authored | observed(외부 미러).
//  knowledge_category(n:n)로 카테고리 매핑. 감사 org_content_audit(entity='knowledge'). 갱신 시 version+1.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";

const K_COLS =
  `name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source,
   external_system, external_instance, external_id, external_url, occurred_at, last_synced_at,
   as_of, parent_name, summary, author, source_ref, sort, is_wiki, version, updated_at, updated_by`;
const K_SEL = K_COLS.split(",").map((c) => "k." + c.trim()).join(", ");
const K_COL_LIST = K_COLS.split(",").map((c) => c.trim()); // 복원 재적재용 컬럼 순서

export interface KnowledgeRow {
  name: string; title: string | null; body_md: string;
  injection: string; provenance: string; lifecycle: string;
  confidence: string; source: string; summary: string | null;
  sort: number; is_wiki: boolean; version: number; updated_at: string;
  [k: string]: unknown;
}

type WriteCtx = { actor?: string | null; source?: string };

function slugify(s: string): string {
  return ((s || "untitled").toLowerCase().trim()
    .replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)) || "untitled";
}

async function auditKnowledge(name: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> {
  const source = ctx?.source ?? null;
  const actorKind = source === "mcp" ? "ai" : source === "web" ? "human" : null;
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
     VALUES('knowledge',$1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8)`,
    [name, op,
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after),
     ctx?.actor ?? null, source, source, actorKind]);
}

export interface KnowledgeFilter {
  space?: string; categoryId?: number; injection?: string; provenance?: string;
  lifecycle?: string; q?: string; limit?: number; orderBy?: string; is_wiki?: boolean;
}

export async function listKnowledge(f: KnowledgeFilter = {}): Promise<KnowledgeRow[]> {
  const params: unknown[] = [];
  let join = "";
  // 카테고리/스페이스 필터 = knowledge_category 조인(rejected 매핑 제외).
  if (f.categoryId != null) {
    params.push(f.categoryId);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.category_id=$${params.length} AND kc.state<>'rejected'`;
  } else if (f.space) {
    params.push(f.space);
    join = `JOIN knowledge_category kc ON kc.name=k.name AND kc.state<>'rejected'
            JOIN category c ON c.id=kc.category_id AND c.space=$${params.length}`;
  }
  const wh: string[] = [];
  if (f.injection) { params.push(f.injection); wh.push(`k.injection=$${params.length}`); }
  if (f.provenance) { params.push(f.provenance); wh.push(`k.provenance=$${params.length}`); }
  if (f.is_wiki != null) { params.push(f.is_wiki); wh.push(`k.is_wiki=$${params.length}`); }
  if (f.lifecycle) { params.push(f.lifecycle); wh.push(`k.lifecycle=$${params.length}`); }
  else wh.push(`k.lifecycle='active'`);
  if (f.q) { params.push(`%${f.q}%`); wh.push(`(k.title ILIKE $${params.length} OR k.body_md ILIKE $${params.length})`); }
  const where = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
  const order = f.orderBy === "name" ? "k.name" : "k.updated_at DESC";
  params.push(Math.min(f.limit ?? 200, 500));
  return q(itemsPool,
    `SELECT DISTINCT ${K_SEL} FROM knowledge k ${join} ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
}

export async function getKnowledge(name: string): Promise<(KnowledgeRow & { categories: unknown[] }) | undefined> {
  const k = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!k) return undefined;
  const categories = await q(itemsPool,
    `SELECT kc.category_id, kc.state, c.space, c.key, c.name
     FROM knowledge_category kc JOIN category c ON c.id=kc.category_id WHERE kc.name=$1`, [name]);
  return { ...k, categories };
}

export async function upsertKnowledge(
  input: { name?: string; title?: string; body_md: string; injection?: string; provenance?: string; confidence?: string; source?: string; supersedes?: string; summary?: string | null; sort?: number; is_wiki?: boolean },
  ctx?: WriteCtx,
): Promise<KnowledgeRow> {
  let name: string;
  if (input.name) {
    name = slugify(input.name);
  } else {
    const base = slugify(input.title || input.body_md.slice(0, 40));
    name = base;
    for (let i = 2; await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [name]); i++) {
      if (i > 999) throw new Error("이름 자동생성 실패");
      name = `${base}-${i}`;
    }
  }
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  // confidence 는 source 로 서버강제(mcp→ai, web→human) 또는 명시값. injection/provenance 는 명시 우선·기존 보존.
  const confidence = input.confidence ?? (ctx?.source === "mcp" ? "ai" : "human");
  const injection = input.injection ?? (before?.injection as string) ?? "recalled";
  const provenance = input.provenance ?? (before?.provenance as string) ?? "authored";
  // summary/sort/is_wiki: 명시(undefined 아님) 우선, 없으면 기존 보존(편집 저장이 핀·요약·정렬 유실 안 하게). 신규면 기본값.
  const summary = input.summary !== undefined ? input.summary : ((before?.summary as string | null) ?? null);
  const sort = input.sort !== undefined ? input.sort : (Number(before?.sort) || 0);
  const isWiki = input.is_wiki !== undefined ? input.is_wiki : ((before?.is_wiki as boolean) ?? false);
  await itemsPool.query(
    `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, supersedes, confidence, source, summary, sort, is_wiki, version, updated_at, updated_by)
     VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,1,now(),$12)
     ON CONFLICT (name) DO UPDATE SET
       title=COALESCE(EXCLUDED.title, knowledge.title), body_md=EXCLUDED.body_md,
       injection=EXCLUDED.injection, provenance=EXCLUDED.provenance, supersedes=EXCLUDED.supersedes,
       confidence=EXCLUDED.confidence, source=EXCLUDED.source,
       summary=EXCLUDED.summary, sort=EXCLUDED.sort, is_wiki=EXCLUDED.is_wiki,
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [name, input.title ?? null, input.body_md, injection, provenance, input.supersedes ?? null, confidence, input.source ?? "authored", summary, sort, isWiki, ctx?.actor ?? null]);
  const after = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  await auditKnowledge(name, before ? "update" : "insert", before, after, ctx);
  return after;
}

export async function setKnowledgeLifecycle(name: string, lifecycle: string, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  const after = await one(itemsPool,
    `UPDATE knowledge SET lifecycle=$2, updated_at=now() WHERE name=$1 RETURNING ${K_COLS}`, [name, lifecycle]);
  await auditKnowledge(name, "set_lifecycle", before, after, ctx);
  return after;
}

// WIKI 핀 토글 — is_wiki 만 갱신(본문·메타 불변, version 안 올림). 핀된 지식의 제목+메타가 가이드 ${wiki} 로 항상-주입된다.
export async function setKnowledgeWiki(name: string, isWiki: boolean, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  const after = await one(itemsPool,
    `UPDATE knowledge SET is_wiki=$2, updated_at=now() WHERE name=$1 RETURNING ${K_COLS}`, [name, isWiki]);
  await auditKnowledge(name, "set_wiki", before, after, ctx);
  return after;
}

// 삭제 — 활성 테이블에서 제거하되 감사(org_content_audit op='delete')에 before 전문 스냅샷을 남긴다.
//  = "감사로그를 휴지통 삼는 소프트삭제" — restoreKnowledge 로 복원 가능. knowledge_category/project_knowledge/
//  activity_knowledge 는 FK ON DELETE CASCADE 라 링크가 동반 삭제된다(복원 시 링크는 돌아오지 않음 — project 와 동형).
//  사람전용 게이트(에이전트 403)는 capability 계층(knowledge_delete)에서 선행한다(여기는 순수 데이터).
export async function deleteKnowledge(name: string, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const before = await one(itemsPool, `SELECT ${K_SEL} FROM knowledge k WHERE k.name=$1`, [name]);
  if (!before) throw new Error(`지식 '${name}' 없음`);
  await itemsPool.query(`DELETE FROM knowledge WHERE name=$1`, [name]);
  await auditKnowledge(name, "delete", before, null, ctx);
  return before;
}

// 복원 — 마지막 delete 의 before 스냅샷(전문)을 그대로 재적재한다. 본문/메타는 삭제 시점 그대로,
//  복원 사실(누가/언제)은 감사 op='restore' 로 기록된다. 이미 존재하면(삭제 상태 아님) 거부.
export async function restoreKnowledge(before: Record<string, unknown>, ctx?: WriteCtx): Promise<KnowledgeRow> {
  const name = before.name as string | undefined;
  if (!name) throw new Error("복원 스냅샷에 name 이 없습니다");
  if (await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [name])) {
    throw new Error(`지식 '${name}' 은(는) 이미 존재합니다(삭제 상태가 아님)`);
  }
  const placeholders = K_COL_LIST.map((_, i) => `$${i + 1}`).join(", ");
  const values = K_COL_LIST.map((c) => before[c] ?? null);
  const after: KnowledgeRow = await one(itemsPool,
    `INSERT INTO knowledge(${K_COL_LIST.join(", ")}) VALUES(${placeholders}) RETURNING ${K_COLS}`, values);
  await auditKnowledge(name, "restore", null, after, ctx);
  return after;
}

// 검색 — title/body_md ILIKE + 매치 주변 ~160자 스니펫(레거시 ctx_grep 대체). 전문은 getKnowledge.
export interface KnowledgeSearchRow extends KnowledgeRow { snippet: string; }
export async function searchKnowledge(
  qstr: string,
  opts: { injection?: string; provenance?: string; limit?: number } = {},
): Promise<KnowledgeSearchRow[]> {
  const params: unknown[] = [`%${qstr}%`];
  const wh: string[] = [`(k.title ILIKE $1 OR k.body_md ILIKE $1)`, `k.lifecycle='active'`];
  if (opts.injection) { params.push(opts.injection); wh.push(`k.injection=$${params.length}`); }
  if (opts.provenance) { params.push(opts.provenance); wh.push(`k.provenance=$${params.length}`); }
  params.push(Math.min(opts.limit ?? 20, 100));
  const rows: KnowledgeRow[] = await q(itemsPool,
    `SELECT ${K_SEL} FROM knowledge k WHERE ${wh.join(" AND ")} ORDER BY k.updated_at DESC LIMIT $${params.length}`, params);
  const needle = qstr.toLowerCase();
  return rows.map((r) => {
    const body = r.body_md ?? "";
    const at = body.toLowerCase().indexOf(needle);
    let snippet: string;
    if (at < 0) snippet = body.slice(0, 160);
    else {
      const start = Math.max(0, at - 60);
      snippet = (start > 0 ? "…" : "") + body.slice(start, at + needle.length + 100) + (at + needle.length + 100 < body.length ? "…" : "");
    }
    return { ...r, snippet: snippet.replace(/\s+/g, " ").trim() };
  });
}

// 개요 — injection/provenance/space 별 집계 + review_pending(observed·active). 레거시 ctx_overview 대체.
export interface KnowledgeOverview {
  total_active: number;
  review_pending: number;
  by_injection: Record<string, number>;
  by_provenance: Record<string, number>;
  by_space: Record<string, number>;
}
export async function knowledgeOverview(): Promise<KnowledgeOverview> {
  const [byInjection, byProvenance, totals, bySpace] = await Promise.all([
    q(itemsPool, `SELECT injection, COUNT(*)::int AS n FROM knowledge WHERE lifecycle='active' GROUP BY injection`),
    q(itemsPool, `SELECT provenance, COUNT(*)::int AS n FROM knowledge WHERE lifecycle='active' GROUP BY provenance`),
    one(itemsPool,
      `SELECT COUNT(*) FILTER (WHERE lifecycle='active')::int AS total_active,
              COUNT(*) FILTER (WHERE provenance='observed' AND lifecycle='active')::int AS review_pending
       FROM knowledge`),
    q(itemsPool,
      `SELECT c.space, COUNT(DISTINCT k.name)::int AS n
       FROM knowledge k
       JOIN knowledge_category kc ON kc.name=k.name AND kc.state<>'rejected'
       JOIN category c ON c.id=kc.category_id
       WHERE k.lifecycle='active'
       GROUP BY c.space`),
  ]);
  const toMap = (rows: any[], key: string) =>
    Object.fromEntries(rows.map((r) => [r[key], r.n])) as Record<string, number>;
  return {
    total_active: totals?.total_active ?? 0,
    review_pending: totals?.review_pending ?? 0,
    by_injection: toMap(byInjection, "injection"),
    by_provenance: toMap(byProvenance, "provenance"),
    by_space: toMap(bySpace, "space"),
  };
}

export async function linkKnowledgeCategory(name: string, categoryId: number, state = "confirmed", ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(
    `INSERT INTO knowledge_category(name, category_id, mapped_by, state, created_at)
     VALUES($1,$2,'manual',$3,now())
     ON CONFLICT (name, category_id) DO UPDATE SET state=EXCLUDED.state`,
    [name, categoryId, state]);
  await auditKnowledge(name, "link_category", null, { category_id: categoryId, state }, ctx);
}

export async function unlinkKnowledgeCategory(name: string, categoryId: number, ctx?: WriteCtx): Promise<void> {
  await itemsPool.query(`DELETE FROM knowledge_category WHERE name=$1 AND category_id=$2`, [name, categoryId]);
  await auditKnowledge(name, "unlink_category", { category_id: categoryId }, null, ctx);
}

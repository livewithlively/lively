// v6 source(자료) 데이터 접근 — #290. raw 입력(이메일·슬랙·회의 전사록/minutes·외부 미러)의 집.
//  ★지식(knowledge)과 별도 테이블 = recall(knowledge_search)이 자료를 자동 미포함(읽기경로 무수정).
//  증류물(지식)은 knowledge_source(knowledge-store.ts)로 인용 — 카파시 source→wiki citation 모델.
import { itemsPool } from "../items/store.js";
import { q, one } from "../domainmap/db.js";
import { auditOrgContent, type WriteCtx } from "../db/write.js";

const S_COLS =
  `id, name, kind, title, body_md, provenance, external_system, external_instance, external_id, external_url,
   occurred_at, last_synced_at, author, lifecycle, created_at, updated_at, updated_by`;
const S_SEL = S_COLS.split(",").map((c) => "s." + c.trim()).join(", ");
// 목록/그래프용 얕은 컬럼(본문 제외 — 자료는 28k+ 전사록이라 목록에 전문 싣지 않는다).
const S_LIST_SEL = `s.id, s.name, s.kind, s.title, s.provenance, s.external_system, s.external_url, s.occurred_at, s.updated_at`;

export interface SourceRow {
  id: number; name: string | null; kind: string; title: string | null; body_md: string;
  provenance: string; lifecycle: string; created_at: string; updated_at: string;
  [k: string]: unknown;
}

const auditSource = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("source", key, op, before, after, ctx);

export interface SourceFilter { kind?: string; provenance?: string; q?: string; limit?: number }

// 목록 — kind/provenance/q(title·body ILIKE) 필터. 최신 발생/수정순. 본문 미포함(얕게).
export async function listSources(f: SourceFilter = {}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const wh: string[] = [`s.lifecycle='active'`];
  if (f.kind) { params.push(f.kind); wh.push(`s.kind=$${params.length}`); }
  if (f.provenance) { params.push(f.provenance); wh.push(`s.provenance=$${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); wh.push(`(s.title ILIKE $${params.length} OR s.body_md ILIKE $${params.length})`); }
  params.push(Math.min(f.limit ?? 100, 500));
  return q(itemsPool,
    `SELECT ${S_LIST_SEL} FROM source s WHERE ${wh.join(" AND ")}
     ORDER BY COALESCE(s.occurred_at, s.updated_at) DESC LIMIT $${params.length}`, params);
}

// distill 대상 — 아직 지식으로 증류되지 않은 자료(knowledge_source 링크가 하나도 없는 active source). 최근 발생순.
//  distill 세션(스케줄러 distill_sources)이 이걸로 지식화 대상을 가져온다. 지식화하면 source_link_knowledge 가 생겨
//  다음 조회에서 빠진다(멱등 수렴). 본문 미포함(source_get 으로 전문). #541.
export async function listUndistilledSources(limit = 50): Promise<Record<string, unknown>[]> {
  return q(itemsPool,
    `SELECT ${S_LIST_SEL} FROM source s
     WHERE s.lifecycle='active'
       AND NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)
     ORDER BY COALESCE(s.occurred_at, s.updated_at) DESC LIMIT $1`,
    [Math.min(limit, 500)]);
}

// 단건 + 이 자료에서 파생된 지식(knowledge_source 역방향) — 자료 상세에서 "여기서 나온 지식" 표시.
export async function getSource(id: number): Promise<(SourceRow & { knowledge: unknown[] }) | undefined> {
  const s = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1`, [id]);
  if (!s) return undefined;
  const knowledge = await q(itemsPool,
    `SELECT ks.name, ks.relation, k.title FROM knowledge_source ks JOIN knowledge k ON k.name=ks.name
     WHERE ks.source_id=$1 AND k.lifecycle='active' ORDER BY ks.relation`, [id]);
  return { ...(s as SourceRow), knowledge };
}

export async function upsertSource(
  input: { id?: number; name?: string | null; kind?: string; title?: string | null; body_md?: string;
    provenance?: string; external_system?: string | null; external_instance?: string | null;
    external_id?: string | null; external_url?: string | null; occurred_at?: string | null; author?: string | null },
  ctx?: WriteCtx,
): Promise<SourceRow> {
  if (input.id) {
    const before = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1`, [input.id]);
    if (!before) throw new Error(`자료 #${input.id} 없음`);
    const after = await one(itemsPool,
      `UPDATE source SET title=COALESCE($2,title), body_md=COALESCE($3,body_md), kind=COALESCE($4,kind),
         provenance=COALESCE($5,provenance), occurred_at=COALESCE($6,occurred_at), author=COALESCE($7,author),
         updated_at=now(), updated_by=$8 WHERE id=$1 RETURNING ${S_COLS}`,
      [input.id, input.title ?? null, input.body_md ?? null, input.kind ?? null, input.provenance ?? null,
        input.occurred_at ?? null, input.author ?? null, ctx?.actor ?? null]);
    await auditSource(String(input.id), "update", before, after, ctx);
    return after as SourceRow;
  }
  const after = await one(itemsPool,
    `INSERT INTO source(name, kind, title, body_md, provenance, external_system, external_instance, external_id, external_url, occurred_at, author, updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${S_COLS}`,
    [input.name ?? null, input.kind ?? "other", input.title ?? null, input.body_md ?? "", input.provenance ?? "observed",
      input.external_system ?? null, input.external_instance ?? null, input.external_id ?? null, input.external_url ?? null,
      input.occurred_at ?? null, input.author ?? null, ctx?.actor ?? null]);
  await auditSource(String((after as SourceRow).id), "insert", null, after, ctx);
  return after as SourceRow;
}

// 삭제 — 감사 스냅샷(before)에 전문 보존. knowledge_source 는 FK CASCADE 로 동반 정리(인용만 끊김, 지식은 생존).
export async function deleteSource(id: number, ctx?: WriteCtx): Promise<SourceRow> {
  const before = await one(itemsPool, `SELECT ${S_SEL} FROM source s WHERE s.id=$1`, [id]);
  if (!before) throw new Error(`자료 #${id} 없음`);
  await itemsPool.query(`DELETE FROM source WHERE id=$1`, [id]);
  await auditSource(String(id), "delete", before, null, ctx);
  return before as SourceRow;
}

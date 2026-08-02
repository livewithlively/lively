// v6 상태 체계 템플릿(#729) 데이터 접근 — 리스트 상태 스킴을 워크스페이스('스페이스') 단위 재사용 템플릿으로.
//  리스트를 새로 만들 때마다 상태 체계를 재생성하던 문제 해소: is_default=true 인 1개가 '스페이스 기본'으로,
//  inherit(기본 상태 사용) 리스트가 이 스킴을 물려받는다. 나머지는 이름있는 템플릿(상태편집기·새 리스트 폼에서 적용).
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";

export interface StatusTemplateRow {
  id: number;
  name: string;
  statuses: Array<{ key: string; label: string; color: string; category: string }>;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const TCOLS = "id, name, statuses, is_default, created_by, created_at, updated_at";
const audit = (key: string, op: string, before: unknown, after: unknown, ctx?: WriteCtx): Promise<void> =>
  auditOrgContent("project_status_template", key, op, before, after, ctx);

// 상태 정의 정규화 — {key,label,color,category(active|done|closed)} 만 취한다(방어적, 리스트 커스텀 상태와 동형).
function normStatuses(input: unknown): Array<{ key: string; label: string; color: string; category: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ key: string; label: string; color: string; category: string }> = [];
  for (const x of input as any[]) {
    if (!x || x.key == null) continue;
    const cat = (x.category === "done" || x.category === "closed") ? x.category : "active";
    out.push({ key: String(x.key), label: String(x.label ?? x.key), color: x.color ? String(x.color) : "#94a3b8", category: cat });
  }
  return out;
}

export async function listStatusTemplates(): Promise<StatusTemplateRow[]> {
  return q(itemsPool, `SELECT ${TCOLS} FROM project_status_template ORDER BY is_default DESC, lower(name)`, []);
}

export async function getDefaultStatusTemplate(): Promise<StatusTemplateRow | undefined> {
  return one(itemsPool, `SELECT ${TCOLS} FROM project_status_template WHERE is_default LIMIT 1`, []);
}

export async function createStatusTemplate(name: string, statuses: unknown, isDefault: boolean, ctx?: WriteCtx): Promise<StatusTemplateRow> {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("템플릿 이름이 필요합니다");
  const norm = normStatuses(statuses);
  const row: StatusTemplateRow = await one(itemsPool,
    `INSERT INTO project_status_template(name, statuses, created_by) VALUES($1, $2::jsonb, $3) RETURNING ${TCOLS}`,
    [nm, JSON.stringify(norm), ctx?.actor ?? null]);
  await audit(String(row.id), "create", null, row, ctx);
  if (isDefault) return (await setDefaultStatusTemplate(row.id, ctx)) as StatusTemplateRow;
  return row;
}

export async function updateStatusTemplate(id: number, patch: { name?: string; statuses?: unknown }, ctx?: WriteCtx): Promise<StatusTemplateRow> {
  const before: StatusTemplateRow | undefined = await one(itemsPool, `SELECT ${TCOLS} FROM project_status_template WHERE id=$1`, [id]);
  if (!before) throw new Error(`템플릿 #${id} 없음`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) { const nm = String(patch.name).trim(); if (!nm) throw new Error("템플릿 이름은 비울 수 없습니다"); vals.push(nm); sets.push(`name=$${vals.length}`); }
  if (patch.statuses !== undefined) { vals.push(JSON.stringify(normStatuses(patch.statuses))); sets.push(`statuses=$${vals.length}::jsonb`); }
  if (!sets.length) return before;
  sets.push("updated_at=now()");
  vals.push(id);
  const after: StatusTemplateRow = await one(itemsPool,
    `UPDATE project_status_template SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING ${TCOLS}`, vals);
  await audit(String(id), "update", before, after, ctx);
  return after;
}

export async function deleteStatusTemplate(id: number, ctx?: WriteCtx): Promise<StatusTemplateRow> {
  const before: StatusTemplateRow | undefined = await one(itemsPool, `SELECT ${TCOLS} FROM project_status_template WHERE id=$1`, [id]);
  if (!before) throw new Error(`템플릿 #${id} 없음`);
  await itemsPool.query(`DELETE FROM project_status_template WHERE id=$1`, [id]);
  await audit(String(id), "delete", before, null, ctx);
  return before;
}

// 스페이스 기본 지정 — 대상 1개만 is_default=true, 그 외 전부 false(부분 유니크 인덱스 보호). id=null 이면 기본 해제(하드코딩 3단계 폴백).
export async function setDefaultStatusTemplate(id: number | null, ctx?: WriteCtx): Promise<StatusTemplateRow | null> {
  await itemsPool.query(`UPDATE project_status_template SET is_default=false, updated_at=now() WHERE is_default AND ($1::int IS NULL OR id<>$1)`, [id]);
  if (id == null) { await audit("*", "set_default", null, null, ctx); return null; }
  const after: StatusTemplateRow = await one(itemsPool,
    `UPDATE project_status_template SET is_default=true, updated_at=now() WHERE id=$1 RETURNING ${TCOLS}`, [id]);
  if (!after) throw new Error(`템플릿 #${id} 없음`);
  await audit(String(id), "set_default", null, after, ctx);
  return after;
}

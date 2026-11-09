// 워크스페이스 간 옮기기(#5458) — 내보내기: 고른 지식을 모아 묶음 파일을 만든다.
//
// 고르는 단위(상민님 2026-11-09): **분류 단위가 기본**, 개별 문서도 고를 수 있다. 둘을 합친 것이 내보낼 지식이다.
//  · 분류를 고르면 그 분류의 지식 전부(보관한 지식은 «보관한 것도 포함» 일 때만, 설치 시드는 빼고).
//  · 개별로 고른 문서는 상태와 무관하게 그대로 넣는다(사람이 지목한 것).
//  · 고른 문서가 폴더 안에 있으면 그 위 폴더들을 함께 담는다(받는 쪽에서 트리 위치가 살게).
// 권한: 관리자만(상민님 2026-11-09). 관리자는 모든 지식을 보므로 열람 필터는 걸리지 않지만, 같은 술어를 그대로 탄다.
//
// 내보낼 때 알려 주는 것(미리보기): 대상자를 제한한 지식은 받는 쪽에서 공개로 들어간다(상민님 결정) ·
//  위키 핀은 핀 없이 · 외부 미러는 일반 지식으로 · 분류 없는 지식 수.
import { itemsPool, q } from "../db/client.js";
import { knowledgeVisWhere } from "../v6/knowledge-common.js";
import { sourceVisWhere } from "../v6/source-store.js";
import type { Viewer } from "../v6/visibility.js";
import { getOrgProfile } from "../org/store/profile.js";
import { audit } from "../org/store/audit.js";
import { gatewayUrl } from "../gateway-url.js";
import { buildInfo } from "../build-info.js";
import { BUNDLE_FORMAT, BUNDLE_VERSION, writeBundleZip, type BundleCategory, type BundleKnowledge, type BundleSource, type BundleManifest } from "./bundle.js";
import { sealBundle } from "./seal.js";
import { getWorkspaceUid } from "./store.js";
import { UNSORTED } from "./plan.js";

/** 올리기 상한과 같은 값 — 받는 쪽이 못 받는 파일은 만들지 않는다(보완 8). */
export const BUNDLE_MAX_BYTES = 100 * 1024 * 1024;

export interface ExportSelection {
  /** 워크스페이스 전체 */
  all?: boolean;
  /** 분류 key — 그 분류의 지식 전부 */
  categories?: string[];
  /** 개별 지식 이름 */
  knowledge?: string[];
  /** 담긴 지식에 연결된 자료도 함께 */
  include_sources?: boolean;
  /** 보관한 지식도 함께(분류·전체 선택에만 적용 — 개별로 고른 것은 늘 들어간다) */
  include_archived?: boolean;
}

export interface ExportPreview {
  knowledge: number;
  /** 고른 문서의 위 폴더라 함께 담기는 수(knowledge 에 포함) */
  folders_added: number;
  categories: number;
  sources: number;
  /** 대상자를 제한한 지식 — 받는 쪽에서 공개로 들어간다 */
  restricted: number;
  /** 위키 핀 — 받는 쪽에서 핀 없이 들어간다 */
  pinned: number;
  /** 외부 미러 — 받는 쪽에서 일반 지식으로 들어간다 */
  observed: number;
  /** 분류 없는 지식 */
  uncategorized: number;
  /** 본문 글자 수 합(바이트 근사) */
  body_bytes: number;
  /** 개별로 고른 이름 중 없는 것 */
  missing: string[];
  notes: string[];
}

const LIFECYCLE_DEFAULT = `k.lifecycle <> 'archived'`;
const NOT_SEED = `COALESCE(k.updated_by,'') <> 'system'`;

const uniq = (xs: readonly string[] | undefined): string[] => [...new Set((xs ?? []).map((x) => String(x).trim()).filter(Boolean))];

const strList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, max);

/** 고른 것 — 본문을 그대로 믿지 않는다(모양만 골라 담는다). 파일 경로(routes.ts)와 미리보기 capability 가 같은 함수를 쓴다. */
export function parseSelection(b: Record<string, unknown>): ExportSelection {
  return {
    all: b.all === true,
    categories: strList(b.categories, 2000),
    knowledge: strList(b.knowledge, 20_000),
    include_sources: b.include_sources === true,
    include_archived: b.include_archived === true,
  };
}

/** 고른 것 → 내보낼 지식 이름(위 폴더 포함). */
export async function resolveSelection(sel: ExportSelection, viewer: Viewer): Promise<{ names: string[]; foldersAdded: number; missing: string[] }> {
  const names = new Set<string>();
  const lifecycle = sel.include_archived ? "TRUE" : LIFECYCLE_DEFAULT;
  if (sel.all) {
    const params: unknown[] = [];
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool, `SELECT k.name FROM knowledge k WHERE ${lifecycle} AND ${NOT_SEED} AND ${vis}`, params);
    for (const r of rows) names.add(String(r.name));
  }
  const cats = uniq(sel.categories);
  const wantsUnsorted = cats.includes(UNSORTED.ref);
  const realCats = cats.filter((c) => c !== UNSORTED.ref);
  if (realCats.length) {
    const params: unknown[] = [realCats];
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool,
      `SELECT DISTINCT k.name FROM knowledge k
         JOIN knowledge_category kc ON kc.name = k.name AND kc.state <> 'rejected'
         JOIN category c ON c.id = kc.category_id
        WHERE c.key = ANY($1::text[]) AND ${lifecycle} AND ${NOT_SEED} AND ${vis}`, params);
    for (const r of rows) names.add(String(r.name));
  }
  if (wantsUnsorted) {
    const params: unknown[] = [];
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool,
      `SELECT k.name FROM knowledge k
        WHERE NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name = k.name AND kc.state <> 'rejected')
          AND ${lifecycle} AND ${NOT_SEED} AND ${vis}`, params);
    for (const r of rows) names.add(String(r.name));
  }
  const picked = uniq(sel.knowledge);
  const missing: string[] = [];
  if (picked.length) {
    const params: unknown[] = [picked];
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool, `SELECT k.name FROM knowledge k WHERE k.name = ANY($1::text[]) AND ${vis}`, params);
    const found = new Set(rows.map((r) => String(r.name)));
    for (const n of picked) { if (found.has(n)) names.add(n); else missing.push(n); }
  }
  // 위 폴더 — parent_name 사슬을 따라 올라간다(깊이 50 에서 멈춘다: 순환 방어는 저장 경로가 하지만 여기서도 끝을 둔다).
  let frontier = [...names];
  let foldersAdded = 0;
  for (let depth = 0; depth < 50 && frontier.length; depth++) {
    const rows = await q(itemsPool,
      `SELECT DISTINCT k.parent_name FROM knowledge k WHERE k.name = ANY($1::text[]) AND k.parent_name IS NOT NULL`, [frontier]);
    const next: string[] = [];
    for (const r of rows) {
      const p = String(r.parent_name);
      if (!names.has(p)) { names.add(p); next.push(p); foldersAdded++; }
    }
    frontier = next;
  }
  // 위 폴더가 실제로 있고 보이는 것만 남긴다(지워진 부모를 가리키는 이름이 남아 있을 수 있다).
  if (foldersAdded) {
    const params: unknown[] = [[...names]];
    const vis = await knowledgeVisWhere(viewer, params);
    const rows = await q(itemsPool, `SELECT k.name FROM knowledge k WHERE k.name = ANY($1::text[]) AND ${vis}`, params);
    const ok = new Set(rows.map((r) => String(r.name)));
    for (const n of [...names]) if (!ok.has(n)) { names.delete(n); foldersAdded--; }
  }
  return { names: [...names].sort(), foldersAdded: Math.max(0, foldersAdded), missing };
}

interface KRow {
  name: string; title: string | null; body_md: string; type: string | null; lifecycle: string; provenance: string;
  injection: string; confidence: string | null; summary: string | null; is_wiki: boolean; searchable: boolean;
  is_folder: boolean; parent_name: string | null; sort: number; visibility: string; supersedes: string | null;
  fields: Record<string, unknown> | null; external_system: string | null; external_url: string | null;
  updated_at: Date | string | null; version: number | null; category_key: string | null;
}

async function fetchKnowledge(names: string[]): Promise<KRow[]> {
  if (!names.length) return [];
  return q(itemsPool,
    `SELECT k.name, k.title, k.body_md, k.type, k.lifecycle, k.provenance, k.injection, k.confidence, k.summary,
            k.is_wiki, true AS searchable, k.is_folder, k.parent_name, k.sort, k.visibility, k.supersedes, k.fields,
            k.external_system, k.external_url, k.updated_at, k.version,
            (SELECT c.key FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
              WHERE kc.name = k.name AND kc.state <> 'rejected'
              ORDER BY (kc.state = 'confirmed') DESC, kc.category_id LIMIT 1) AS category_key
       FROM knowledge k WHERE k.name = ANY($1::text[]) ORDER BY k.name`, [names]) as Promise<KRow[]>;
}

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** 미리보기 — 무엇이 몇 건 담기는지(파일은 만들지 않는다). */
export async function previewExport(sel: ExportSelection, viewer: Viewer): Promise<ExportPreview & { names: string[] }> {
  const { names, foldersAdded, missing } = await resolveSelection(sel, viewer);
  const stats = names.length ? (await q(itemsPool,
    `WITH sel AS (
       SELECT k.visibility, k.is_wiki, k.provenance, octet_length(k.body_md) AS bytes,
              (SELECT c.key FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
                WHERE kc.name = k.name AND kc.state <> 'rejected'
                ORDER BY (kc.state = 'confirmed') DESC, kc.category_id LIMIT 1) AS ckey
         FROM knowledge k WHERE k.name = ANY($1::text[]))
     SELECT count(*)::int AS n,
            count(*) FILTER (WHERE visibility <> 'open')::int AS restricted,
            count(*) FILTER (WHERE is_wiki)::int AS pinned,
            count(*) FILTER (WHERE provenance = 'observed')::int AS observed,
            count(*) FILTER (WHERE ckey IS NULL)::int AS uncategorized,
            COALESCE(sum(bytes), 0)::bigint AS bytes,
            count(DISTINCT ckey)::int AS cats
       FROM sel`, [names]))[0] : null;
  let sources = 0;
  let sourceBytes = 0;
  if (sel.include_sources && names.length) {
    const params: unknown[] = [names];
    const vis = await sourceVisWhere(viewer, params);
    const r = (await q(itemsPool,
      `SELECT count(DISTINCT s.id)::int AS n, COALESCE(sum(octet_length(s.body_md)), 0)::bigint AS bytes
         FROM source s WHERE s.id IN (SELECT ks.source_id FROM knowledge_source ks WHERE ks.name = ANY($1::text[])) AND ${vis}`, params))[0];
    sources = Number(r?.n ?? 0);
    sourceBytes = Number(r?.bytes ?? 0);
  }
  const p: ExportPreview = {
    knowledge: Number(stats?.n ?? 0),
    folders_added: foldersAdded,
    categories: Number(stats?.cats ?? 0) + (Number(stats?.uncategorized ?? 0) > 0 ? 1 : 0),
    sources,
    restricted: Number(stats?.restricted ?? 0),
    pinned: Number(stats?.pinned ?? 0),
    observed: Number(stats?.observed ?? 0),
    uncategorized: Number(stats?.uncategorized ?? 0),
    body_bytes: Number(stats?.bytes ?? 0) + sourceBytes,
    missing,
    notes: [],
  };
  p.notes = exportNotes(p);
  return { ...p, names };
}

/** 내보낼 때 보여 줄 안내 문장 — 화면과 API 가 같은 문장을 쓴다. */
export function exportNotes(p: Pick<ExportPreview, "restricted" | "pinned" | "observed" | "uncategorized" | "missing" | "body_bytes">): string[] {
  const n: string[] = [];
  if (p.restricted) n.push(`대상자를 제한한 지식 ${p.restricted}건이 들어 있습니다 — 받는 쪽에서는 공개로 들어갑니다.`);
  if (p.pinned) n.push(`위키 핀으로 둔 지식 ${p.pinned}건은 받는 쪽에서 핀 없이 들어갑니다.`);
  if (p.observed) n.push(`외부 앱에서 그대로 옮겨 온 지식 ${p.observed}건은 받는 쪽에서 일반 지식으로 들어갑니다(원래 주소는 남습니다).`);
  if (p.uncategorized) n.push(`분류가 없는 지식 ${p.uncategorized}건은 받는 쪽에서 «${UNSORTED.name}»에 들어갑니다(가져올 때 바꿀 수 있습니다).`);
  if (p.missing.length) n.push(`고른 문서 중 ${p.missing.length}건은 찾지 못해 빠졌습니다.`);
  if (p.body_bytes > BUNDLE_MAX_BYTES * 0.9) n.push("파일이 받는 쪽 올리기 상한(100MB)에 가깝습니다 — 넘으면 분류를 나눠 내보내 주세요.");
  return n;
}

export interface ExportResult {
  file: Buffer;
  filename: string;
  sealed: boolean;
  manifest: BundleManifest;
  preview: ExportPreview;
}

const pad = (n: number): string => String(n).padStart(2, "0");
function fileStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** 내보내기 — 묶음 파일을 만든다. password 가 있으면 잠근다(.lively), 없으면 zip(.zip). */
export async function buildExport(sel: ExportSelection, viewer: Viewer, opts: { actor: string | null; password?: string | null; now?: Date }): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const preview = await previewExport(sel, viewer);
  const { names } = preview;
  if (!names.length) throw new Error("내보낼 지식이 없습니다 — 분류나 문서를 하나 이상 골라 주세요");
  const rows = await fetchKnowledge(names);
  const nameSet = new Set(rows.map((r) => r.name));

  // 본문 밖 연결 — 본문 [[…]] 에서 생긴 엣지는 본문이 진실이라 빼고, 사람이 단 연결만 싣는다.
  const linkRows = await q(itemsPool,
    `SELECT from_name, to_name, relation FROM knowledge_link
      WHERE from_name = ANY($1::text[]) AND COALESCE(origin, 'user') <> 'wikilink'
      ORDER BY from_name, to_name, relation`, [names]) as Array<{ from_name: string; to_name: string; relation: string }>;
  const linksBy = new Map<string, Array<{ to: string; relation: string }>>();
  for (const l of linkRows) {
    const arr = linksBy.get(l.from_name) ?? [];
    arr.push({ to: l.to_name, relation: l.relation });
    linksBy.set(l.from_name, arr);
  }

  // 자료 — 고를 때만. 지식 → 자료 연결(관계 포함)과 자료 본문.
  const sourcesBy = new Map<string, Array<{ ref: string; relation: string }>>();
  const sources: BundleSource[] = [];
  if (sel.include_sources) {
    const params: unknown[] = [names];
    const vis = await sourceVisWhere(viewer, params);
    const ks = await q(itemsPool,
      `SELECT ks.name, ks.source_id, ks.relation FROM knowledge_source ks JOIN source s ON s.id = ks.source_id
        WHERE ks.name = ANY($1::text[]) AND ${vis} ORDER BY ks.name, ks.source_id`, params) as Array<{ name: string; source_id: number; relation: string }>;
    const ids = [...new Set(ks.map((r) => Number(r.source_id)))];
    for (const r of ks) {
      const arr = sourcesBy.get(r.name) ?? [];
      arr.push({ ref: String(r.source_id), relation: r.relation });
      sourcesBy.set(r.name, arr);
    }
    if (ids.length) {
      const srows = await q(itemsPool,
        `SELECT id, kind, title, body_md, fields, provenance, visibility, external_system, external_instance, external_id,
                external_url, parent_external_id, occurred_at, author
           FROM source WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
      for (const s of srows) {
        sources.push({
          ref: String(s.id), kind: String(s.kind ?? "other"), title: (s.title as string | null) ?? null, body_md: String(s.body_md ?? ""),
          fields: (s.fields as Record<string, unknown>) ?? {}, provenance: String(s.provenance ?? "observed"), visibility: String(s.visibility ?? "open"),
          external_system: (s.external_system as string | null) ?? null, external_instance: (s.external_instance as string | null) ?? null,
          external_id: (s.external_id as string | null) ?? null, external_url: (s.external_url as string | null) ?? null,
          parent_external_id: (s.parent_external_id as string | null) ?? null, occurred_at: iso(s.occurred_at as Date | null), author: (s.author as string | null) ?? null,
        });
      }
    }
  }

  const knowledge: BundleKnowledge[] = rows.map((r) => ({
    ref: r.name, title: r.title, body_md: r.body_md ?? "", type: r.type, category: r.category_key,
    lifecycle: r.lifecycle, provenance: r.provenance, injection: r.injection, confidence: r.confidence, summary: r.summary,
    is_wiki: !!r.is_wiki, searchable: r.searchable !== false, is_folder: !!r.is_folder,
    // 위 폴더가 묶음에 없으면(보이지 않아 빠졌으면) 끊는다 — 받는 쪽에서 없는 부모를 가리키지 않게.
    parent: r.parent_name && nameSet.has(r.parent_name) ? r.parent_name : null,
    sort: Number(r.sort ?? 0), visibility: r.visibility ?? "open", supersedes: r.supersedes,
    fields: r.fields ?? {}, external_system: r.external_system, external_url: r.external_url,
    links: linksBy.get(r.name) ?? [], sources: sourcesBy.get(r.name) ?? [],
    updated_at: iso(r.updated_at), version: r.version == null ? null : Number(r.version),
  }));

  const keys = [...new Set(rows.map((r) => r.category_key).filter((k): k is string => !!k))];
  const categories: BundleCategory[] = keys.length
    ? (await q(itemsPool,
        `SELECT key, name, description, should, COALESCE(cross_cutting, false) AS cross_cutting FROM category
          WHERE key = ANY($1::text[]) AND state <> 'merged' ORDER BY key`, [keys])).map((c) => ({
        key: String(c.key), name: (c.name as string | null) ?? null, description: (c.description as string | null) ?? null,
        should: (c.should as string | null) ?? null, cross_cutting: !!c.cross_cutting,
      }))
    : [];

  let orgName: string | null = null;
  try { const p = await getOrgProfile(); orgName = p.display_name || p.name || null; } catch { /* 프로필 없음 — 이름 없이 */ }
  const manifestBase: Omit<BundleManifest, "files" | "counts"> = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created_at: now.toISOString(),
    origin: { workspace_uid: await getWorkspaceUid(), name: orgName, gateway_url: await gatewayUrl().catch(() => null), core_version: buildInfo().version },
    exported_by: opts.actor,
    selection: {
      all: !!sel.all, categories: uniq(sel.categories), knowledge: uniq(sel.knowledge).length,
      include_sources: !!sel.include_sources, include_archived: !!sel.include_archived,
    },
  };
  const { zip, manifest } = writeBundleZip({ manifest: manifestBase, knowledge, categories, sources }, now);
  const sealed = !!opts.password;
  const file = sealed ? await sealBundle(zip, opts.password!) : zip;
  if (file.length > BUNDLE_MAX_BYTES) {
    throw new Error(`묶음이 ${(file.length / 1024 / 1024).toFixed(1)}MB 라 받는 쪽 올리기 상한(100MB)을 넘습니다 — 분류를 나눠 내보내 주세요`);
  }
  const slug = (orgName ?? "workspace").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  const filename = `lively-${slug}-${fileStamp(now)}.${sealed ? "lively" : "zip"}`;
  return { file, filename, sealed, manifest, preview };
}

/** 관리자 내보내기 — 파일을 만들고 «누가 무엇을 몇 건 내보냈나» 를 관리 감사에 남긴다(지식이 워크스페이스 밖으로 나가는 경로).
 *  관리자는 모든 지식을 보므로 열람 신원은 특권(null)이다 — 호출부(routes.ts)가 admin 을 이미 확인했다. */
export async function exportBundle(sel: ExportSelection, opts: { actor: string; password?: string | null; source: string; now?: Date }): Promise<ExportResult> {
  const out = await buildExport(sel, null, { actor: opts.actor, password: opts.password, now: opts.now });
  await audit("org_transfer", null, "export", null, {
    counts: out.manifest.counts, all: !!sel.all, categories: uniq(sel.categories), picked: uniq(sel.knowledge).length,
    include_sources: !!sel.include_sources, include_archived: !!sel.include_archived, sealed: out.sealed,
    restricted: out.preview.restricted, bytes: out.file.length,
  }, opts.actor, opts.source);
  return out;
}

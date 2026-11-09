// 워크스페이스 간 옮기기(#5458) — 가져오기: 올리기(미리보기) → 적용 → 되돌리기. DB 를 만지는 쪽.
//
// 흐름:
//  ① stageImport  — 파일을 읽어 미리보기를 만들고 배치 한 행으로 둔다(파일 바이트는 적용 때까지만 보관).
//  ② applyImport  — 사람이 고른 결정으로 실제로 들인다. 미리보기 뒤에 받는 쪽이 바뀌었을 수 있어 **계획을 다시 세운 뒤**
//                   결정을 대어 본다(그사이 이름이 차면 «새로 만들기» 결정은 허용 범위를 벗어나 기본값 «새 이름으로» 가 된다).
//  ③ undoImport   — 웹에서 사람만(보완 5). 만든 지식은 휴지통으로, 갱신한 지식은 가져오기 전 판으로, 만든 분류·자료는 비었으면 지운다.
//
// 원자성: 지식 저장·필드·연결·분류 함수가 각자 풀 연결을 쓰므로 한 트랜잭션으로 묶을 수 없다. 그래서 **항목 단위로** 처리하고
//  항목이 실패해도 나머지는 계속한다. 무엇을 했는지는 결과(result)에 전부 남겨 되돌리기가 그대로 거꾸로 밟는다.
//  배치 상태는 전이 조건부(transitionBatch)라 두 사람이 동시에 «적용» 을 눌러도 한 번만 돈다.
import { itemsPool, q, one } from "../db/client.js";
import { upsertKnowledge, deleteKnowledge, patchKnowledgeFields, KnowledgeExistsError } from "../v6/knowledge-store.js";
import { linkKnowledge, linkKnowledgeSource } from "../v6/knowledge-links.js";
import { createCategory, getCategoryByKey, deleteCategory } from "../v6/category-store.js";
import { upsertSource, deleteSource } from "../v6/source-store.js";
import type { WriteCtx } from "../v6/content-audit.js";
import { audit } from "../org/store/audit.js";
import { readBundle, bundleContentHash, sha256Hex, type Bundle, type BundleKnowledge } from "./bundle.js";
import {
  planImport, resolveDecisions, rewriteWikiLinks, sourceExternalKey, targetContentHash, freeName,
  TARGET_LINK_RELATIONS, TARGET_SOURCE_RELATIONS, UNSORTED,
  type Plan, type Decisions, type TargetState, type TargetKnowledge, type KnowledgeAction, type ResolvedItem,
} from "./plan.js";
import {
  createBatch, getBatch, getBatchPayload, transitionBatch, expireStalePlans, recoverStuckBatches, getWorkspaceUid, saveBatchProgress,
  listOrigins, upsertOrigin, deleteOrigin, type BatchRow, type OriginRow,
} from "./store.js";
import { BUNDLE_MAX_BYTES } from "./export.js";

const VALID_INJECTION = new Set(["always", "recalled"]);
const VALID_CONFIDENCE = new Set(["ai", "rule", "human"]);
const ORIGIN_URL_FIELD = "원본 주소";
/** 적용 중간 결과를 몇 건마다 저장하나 — 프로세스가 죽어도 되돌리기가 «여기까지 한 것» 을 치울 수 있게. */
const PROGRESS_EVERY = 20;

// ── 받는 쪽 상태 ─────────────────────────────────────────────────────────────────────

const K_TARGET_SQL = `SELECT k.name, k.title, k.body_md, k.type, k.summary, k.is_folder, k.parent_name, k.fields, k.provenance,
    (SELECT c.key FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
      WHERE kc.name = k.name AND kc.state <> 'rejected' ORDER BY (kc.state = 'confirmed') DESC, kc.category_id LIMIT 1) AS category
  FROM knowledge k WHERE k.name = ANY($1::text[])`;

function toTarget(r: Record<string, unknown>): TargetKnowledge {
  return {
    name: String(r.name), title: (r.title as string | null) ?? null, body_md: String(r.body_md ?? ""), type: (r.type as string | null) ?? null,
    category: (r.category as string | null) ?? null, summary: (r.summary as string | null) ?? null, is_folder: !!r.is_folder,
    parent_name: (r.parent_name as string | null) ?? null, fields: (r.fields as Record<string, unknown>) ?? {}, provenance: String(r.provenance ?? "authored"),
  };
}

async function readTargetKnowledge(names: string[]): Promise<Map<string, TargetKnowledge>> {
  if (!names.length) return new Map();
  const rows = await q(itemsPool, K_TARGET_SQL, [names]);
  return new Map(rows.map((r) => { const t = toTarget(r as Record<string, unknown>); return [t.name, t]; }));
}

export async function loadTargetState(bundle: Bundle): Promise<TargetState> {
  const uid = bundle.manifest.origin.workspace_uid;
  const [workspaceUid, nameRows, catRows, originsKnowledge, originsCategory, originsSource] = await Promise.all([
    getWorkspaceUid(),
    q(itemsPool, `SELECT name FROM knowledge`, []),
    q(itemsPool, `SELECT key, name, state FROM category`, []),
    listOrigins(uid, "knowledge"),
    listOrigins(uid, "category"),
    listOrigins(uid, "source"),
  ]);
  const names = new Set(nameRows.map((r) => String(r.name)));
  const wanted = new Set<string>();
  for (const k of bundle.knowledge) wanted.add(k.ref);
  for (const o of originsKnowledge.values()) wanted.add(o.local_ref);
  const knowledge = await readTargetKnowledge([...wanted].filter((n) => names.has(n)));
  // 자료 — 전에 가져온 것이 아직 있나 · 같은 외부 원본이 이미 있나
  const linIds = [...originsSource.values()].map((o) => Number(o.local_ref)).filter((n) => Number.isFinite(n));
  const sourceIds = new Set<number>(linIds.length
    ? (await q(itemsPool, `SELECT id FROM source WHERE id = ANY($1::int[])`, [linIds])).map((r) => Number(r.id))
    : []);
  const extIds = [...new Set(bundle.sources.map((s) => s.external_id).filter((x): x is string => !!x))];
  const sourcesByExternal = new Map<string, number>();
  if (extIds.length) {
    const rows = await q(itemsPool,
      `SELECT id, external_system, external_instance, external_id FROM source WHERE external_id = ANY($1::text[])`, [extIds]);
    for (const r of rows) {
      const key = sourceExternalKey(r.external_system as string | null, r.external_instance as string | null, r.external_id as string | null);
      if (key) sourcesByExternal.set(key, Number(r.id));
    }
  }
  return {
    workspaceUid, names, knowledge,
    categories: catRows.map((c) => ({ key: String(c.key), name: (c.name as string | null) ?? null, state: String(c.state ?? "active") })),
    originsKnowledge, originsCategory, originsSource, sourceIds, sourcesByExternal,
  };
}

// ── ① 올리기 → 미리보기 ──────────────────────────────────────────────────────────────

export class TransferInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message); }
}

/** 배치 정리 — 하루 지난 미리보기의 파일 바이트를 비우고, 멈춘 적용·되돌리기를 «일부만 들임» 으로 내린다.
 *  옮기기 화면·API 가 열릴 때마다 돌고, 아무도 다시 열지 않아도 요청 정비표(sessions/outbox-request-sweep.ts «transfer-housekeeping»,
 *  10분)가 워크스페이스마다 부른다 — 매니지드는 요청에 얹어, 셀프호스트는 boot/housekeeping 이 같은 정의로. */
export async function transferHousekeeping(): Promise<void> {
  await expireStalePlans().catch(() => 0);
  await recoverStuckBatches().catch(() => 0);
}

export async function stageImport(file: Buffer, opts: { password?: string | null; fileName?: string | null; ctx: WriteCtx }): Promise<{ batch: BatchRow; plan: Plan }> {
  await transferHousekeeping();
  if (!file.length) throw new TransferInputError("빈 파일입니다");
  if (file.length > BUNDLE_MAX_BYTES) throw new TransferInputError("파일이 100MB 를 넘습니다 — 보내는 쪽에서 분류를 나눠 다시 내보내 주세요", 413);
  const { bundle, problems, sealed, zip } = await readBundle(file, opts.password ?? null);
  const target = await loadTargetState(bundle);
  const plan = planImport(bundle, target, problems);
  const batch = await createBatch({
    file_name: opts.fileName ? opts.fileName.slice(0, 300) : null,
    file_sha256: sha256Hex(file), file_bytes: file.length, sealed,
    origin_uid: bundle.manifest.origin.workspace_uid, origin_name: bundle.manifest.origin.name,
    format_version: bundle.manifest.version,
    manifest: { ...bundle.manifest, files: undefined },
    plan, payload: zip, created_by: opts.ctx.actor ?? null,
  });
  await audit("org_transfer", String(batch.id), "import_plan", null,
    { file_name: batch.file_name, origin: plan.origin, summary: plan.summary, sealed }, opts.ctx.actor ?? undefined, opts.ctx.source);
  return { batch, plan };
}

// ── ② 적용 ──────────────────────────────────────────────────────────────────────────

interface KnowledgeSnapshot {
  name: string; title: string | null; body_md: string; type: string | null; category: string | null; summary: string | null;
  is_folder: boolean; parent_name: string | null; sort: number; searchable: boolean; supersedes: string | null;
  provenance: string; fields: Record<string, unknown>;
}

export interface ApplyKnowledgeResult {
  ref: string;
  action: KnowledgeAction;
  name: string | null;
  ok: boolean;
  created?: boolean;
  error?: string;
  notes?: string[];
  /** 덮어쓰기·갱신이면 그 전 판(되돌리기용) */
  before?: KnowledgeSnapshot | null;
  /** 가져온 기록의 그 전 값(되돌리기용 — 없었으면 null) */
  prev_origin?: OriginRow | null;
  /** 문서는 들어갔지만 뒤 단계(필드·가져온 기록)가 실패했다 — notes 에 이유 */
  warning?: boolean;
}

export interface ApplyResult {
  knowledge: ApplyKnowledgeResult[];
  categories_created: Array<{ ref: string; key: string }>;
  sources_created: number[];
  sources_linked: number;
  links: { created: number; dropped: number };
  counts: { created: number; updated: number; skipped: number; failed: number };
  sources_failed?: number;
  notes?: string[];
  undo?: UndoReport;
}

async function snapshot(name: string): Promise<KnowledgeSnapshot | null> {
  const r = await one(itemsPool,
    `SELECT k.name, k.title, k.body_md, k.type, k.summary, k.is_folder, k.parent_name, k.sort, k.searchable, k.supersedes, k.provenance, k.fields,
       (SELECT c.key FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
         WHERE kc.name = k.name AND kc.state <> 'rejected' ORDER BY (kc.state = 'confirmed') DESC, kc.category_id LIMIT 1) AS category
     FROM knowledge k WHERE k.name = $1`, [name]) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    name: String(r.name), title: (r.title as string | null) ?? null, body_md: String(r.body_md ?? ""), type: (r.type as string | null) ?? null,
    category: (r.category as string | null) ?? null, summary: (r.summary as string | null) ?? null, is_folder: !!r.is_folder,
    parent_name: (r.parent_name as string | null) ?? null, sort: Number(r.sort ?? 0), searchable: r.searchable !== false,
    supersedes: (r.supersedes as string | null) ?? null, provenance: String(r.provenance ?? "authored"), fields: (r.fields as Record<string, unknown>) ?? {},
  };
}

/** 필드를 «정확히 이 값» 으로 — patchKnowledgeFields 는 병합이라 없는 키는 null 로 지워 준다. */
async function setFieldsExactly(name: string, want: Record<string, unknown>, current: Record<string, unknown>, ctx: WriteCtx): Promise<void> {
  const patch: Record<string, unknown> = { ...want };
  for (const k of Object.keys(current)) if (!(k in want)) patch[k] = null;
  if (!Object.keys(patch).length) return;
  await patchKnowledgeFields(name, patch, { changeNote: "워크스페이스 간 옮기기" }, ctx);
}

/** 상위 폴더가 먼저 서도록 — 묶음 안 조상 수가 적은 것부터. */
function byDepth(items: ResolvedItem[], byRef: Map<string, BundleKnowledge>): ResolvedItem[] {
  const depth = (ref: string): number => {
    let d = 0;
    let cur = byRef.get(ref)?.parent ?? null;
    const seen = new Set<string>([ref]);
    while (cur && byRef.has(cur) && !seen.has(cur) && d < 50) { seen.add(cur); d++; cur = byRef.get(cur)?.parent ?? null; }
    return d;
  };
  return [...items].sort((a, b) => depth(a.ref) - depth(b.ref));
}

export async function applyImport(batchId: number, decisions: Decisions, ctx: WriteCtx): Promise<{ batch: BatchRow; result: ApplyResult }> {
  const claimed = await transitionBatch(batchId, ["planned"], "applying", { decisions });
  if (!claimed) {
    const b = await getBatch(batchId);
    if (!b) throw new TransferInputError("가져오기를 찾을 수 없습니다", 404);
    throw new TransferInputError(`이미 처리된 가져오기입니다(${b.state})`, 409);
  }
  const result: ApplyResult = { knowledge: [], categories_created: [], sources_created: [], sources_linked: 0, links: { created: 0, dropped: 0 }, counts: { created: 0, updated: 0, skipped: 0, failed: 0 } };
  try {
    const payload = await getBatchPayload(batchId);
    if (!payload) throw new TransferInputError("올린 파일이 만료됐습니다 — 다시 올려 주세요", 410);
    const { bundle, problems } = await readBundle(payload);
    const target = await loadTargetState(bundle);
    const plan = planImport(bundle, target, problems);
    const resolved = resolveDecisions(plan, decisions, target, bundle.categories);
    const originUid = bundle.manifest.origin.workspace_uid;
    const byRef = new Map(bundle.knowledge.map((k) => [k.ref, k]));

    // ⓐ 분류 — 만들 것을 만들고, 맞춘 결과를 기록해 다음 가져오기의 기본값으로 쓴다.
    for (const c of resolved.createCategories) {
      await createCategory({ key: c.key, name: c.name ?? c.key, description: c.description ?? undefined, should: c.should ?? undefined }, ctx);
      result.categories_created.push({ ref: c.ref, key: c.key });
    }
    for (const [ref, key] of resolved.categoryMap) {
      await upsertOrigin({ origin_uid: originUid, kind: "category", origin_ref: ref, local_ref: key, origin_hash: null, local_hash: null, batch_id: batchId });
    }

    // ⓑ 지식 — 상위 폴더부터. 저장 뒤처리(임베딩 표시·[[링크]] 엣지)는 전부 들인 다음에 돈다(가리키는 문서가 먼저 서 있어야 엣지가 선다).
    const posts: Array<() => Promise<unknown>> = [];
    const written = new Map<string, string>(); // ref → 받는 쪽 이름(이번에 쓴 것)
    let sinceSave = 0;
    for (const it of byDepth(resolved.items, byRef)) {
      const k = byRef.get(it.ref)!;
      if (it.final === "skip" || !it.target_name) {
        result.knowledge.push({ ref: it.ref, action: "skip", name: resolved.nameMap.get(it.ref) ?? null, ok: true, notes: it.reason ? [it.reason] : undefined });
        result.counts.skipped++;
        continue;
      }
      const notes: string[] = [];
      let name = it.target_name;
      const parentLocal = k.parent ? (resolved.nameMap.get(k.parent) ?? null) : null;
      if (k.parent && !parentLocal) notes.push("상위 폴더가 들어오지 않아 맨 위에 둡니다.");
      const input = {
        title: k.title ?? undefined,
        body_md: rewriteWikiLinks(k.body_md, resolved.nameMap),
        type: k.type ?? "reference",
        category: it.target_category,
        provenance: "authored",
        summary: k.summary,
        searchable: k.searchable,
        is_folder: k.is_folder,
        parent_name: parentLocal && (written.has(k.parent!) || target.names.has(parentLocal)) ? parentLocal : null,
        sort: k.sort,
        supersedes: k.supersedes ? (resolved.nameMap.get(k.supersedes) ?? undefined) : undefined,
      };
      const wantFields: Record<string, unknown> = { ...k.fields };
      if (k.provenance === "observed" && k.external_url) wantFields[ORIGIN_URL_FIELD] = k.external_url;
      const prevOrigin = target.originsKnowledge.get(it.ref);
      const created = it.final === "create" || it.final === "rename";
      let before: KnowledgeSnapshot | null = null;

      // ① 쓰기 — 여기서 실패하면 받는 쪽은 그대로다(아무것도 안 썼다). 실패로 적고 다음 항목으로.
      try {
        if (created) {
          const extra = {
            lifecycle: k.lifecycle,
            injection: VALID_INJECTION.has(k.injection) ? k.injection : "recalled",
            confidence: k.provenance !== "observed" && k.confidence && VALID_CONFIDENCE.has(k.confidence) ? k.confidence : undefined,
            is_wiki: false,
          };
          try {
            const saved = await upsertKnowledge({ name, ...input, ...extra }, ctx, { insertOnly: true, visibility: "open", deferPost: true });
            if (saved.post) posts.push(saved.post);
          } catch (e) {
            if (!(e instanceof KnowledgeExistsError)) throw e;
            // 미리보기 뒤 누가 같은 이름을 만들었다 — 비어 있는 새 이름으로 한 번 더(덮어쓰지 않는다).
            const like = `${name.slice(0, 40).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
            const taken = new Set((await q(itemsPool, `SELECT name FROM knowledge WHERE name LIKE $1`, [like])).map((r) => String(r.name)));
            name = freeName(name, taken, new Set(written.values()));
            notes.push(`같은 이름이 그사이 생겨 '${name}' 으로 들였습니다.`);
            const saved = await upsertKnowledge({ name, ...input, ...extra }, ctx, { insertOnly: true, visibility: "open", deferPost: true });
            if (saved.post) posts.push(saved.post);
          }
        } else {
          before = await snapshot(name);
          if (!before) throw new Error(`덮어쓸 지식 '${name}' 이 사라졌습니다`);
          if (before.provenance === "observed") throw new Error(`'${name}' 은 외부 미러라 덮어쓸 수 없습니다`);
          const saved = await upsertKnowledge({ name, ...input }, ctx, { deferPost: true });
          if (saved.post) posts.push(saved.post);
        }
      } catch (e) {
        result.knowledge.push({ ref: it.ref, action: it.final, name: it.target_name, ok: false, error: (e as Error).message, notes: notes.length ? notes : undefined });
        result.counts.failed++;
        continue;
      }

      // ② 썼다 — 결과를 **지금** 남긴다(만든 것인지 · 덮어쓰기 전 판). 뒤 단계가 실패해도 되돌리기가 이 기록으로 치운다.
      //  (리뷰 지적 2026-11-09: 종전엔 필드·기록 단계의 실패가 이 항목을 «실패» 로만 남겨, 만든 문서는 되돌리기에서 빠지고
      //   덮어쓴 문서는 전 판을 잃었다.)
      written.set(it.ref, name);
      resolved.nameMap.set(it.ref, name);
      if (k.visibility !== "open") notes.push("대상자 제한을 풀고 공개로 들였습니다.");
      const entry: ApplyKnowledgeResult = {
        ref: it.ref, action: it.final, name, ok: true, created, notes, before,
        prev_origin: prevOrigin ? { origin_uid: originUid, kind: "knowledge", origin_ref: it.ref, local_ref: prevOrigin.local_ref, origin_hash: prevOrigin.origin_hash, local_hash: prevOrigin.local_hash, batch_id: null } : null,
      };
      result.knowledge.push(entry);
      if (created) result.counts.created++; else result.counts.updated++;

      // ③ 뒤 단계 — 실패해도 문서는 들어가 있다. 경고로 남긴다.
      try {
        if (created) { if (Object.keys(wantFields).length) await setFieldsExactly(name, wantFields, {}, ctx); }
        else await setFieldsExactly(name, wantFields, before?.fields ?? {}, ctx);
      } catch (e) { entry.warning = true; notes.push(`필드를 옮기지 못했습니다: ${(e as Error).message}`); }
      try {
        const row = (await readTargetKnowledge([name])).get(name);
        await upsertOrigin({
          origin_uid: originUid, kind: "knowledge", origin_ref: it.ref, local_ref: name,
          origin_hash: bundleContentHash(k), local_hash: row ? targetContentHash(row) : null, batch_id: batchId,
        });
      } catch (e) { entry.warning = true; notes.push(`가져온 기록을 남기지 못했습니다(다시 가져오면 처음 보는 문서로 봅니다): ${(e as Error).message}`); }
      if (!notes.length) delete entry.notes;
      if (++sinceSave >= PROGRESS_EVERY) { sinceSave = 0; await saveBatchProgress(batchId, result).catch(() => {}); }
    }

    // ⓒ 본문 밖 연결 — 양 끝이 다 받는 쪽에 있을 때만(묶음 밖 이름은 받는 쪽의 다른 문서일 수 있어 잇지 않는다).
    for (const [ref, fromName] of written) {
      for (const l of byRef.get(ref)?.links ?? []) {
        const to = resolved.nameMap.get(l.to);
        if (!to || to === fromName || !TARGET_LINK_RELATIONS.includes(l.relation)) { result.links.dropped++; continue; }
        try { await linkKnowledge(fromName, to, l.relation, ctx); result.links.created++; }
        catch { result.links.dropped++; }
      }
    }

    // ⓓ 자료 — 고를 때만. 이미 있는 것(전에 가져왔거나 같은 외부 원본)은 연결만.
    if (resolved.include_sources && bundle.sources.length && written.size) {
      const neededRefs = new Set<string>();
      for (const ref of written.keys()) for (const s of byRef.get(ref)?.sources ?? []) neededRefs.add(s.ref);
      const sourceMap = new Map<string, number>();
      const byExternal = new Map(target.sourcesByExternal);
      for (const s of bundle.sources) {
        if (!neededRefs.has(s.ref)) continue;
        try {
          const lin = target.originsSource.get(s.ref);
          const ext = sourceExternalKey(s.external_system, s.external_instance, s.external_id);
          let id: number | undefined;
          if (lin && target.sourceIds.has(Number(lin.local_ref))) id = Number(lin.local_ref);
          else if (ext && byExternal.has(ext)) id = byExternal.get(ext);
          if (id === undefined) {
            const row = await upsertSource({
              kind: s.kind, title: s.title, body_md: s.body_md, provenance: s.provenance === "authored" ? "authored" : "observed",
              external_system: s.external_system, external_instance: s.external_instance, external_id: s.external_id,
              external_url: s.external_url, occurred_at: s.occurred_at, author: s.author,
            }, ctx);
            id = Number((row as { id: number }).id);
            result.sources_created.push(id);
            if (ext) byExternal.set(ext, id); // 묶음 안에 같은 원본이 또 있으면 두 번째는 연결만
            if (Object.keys(s.fields).length || s.parent_external_id) {
              await itemsPool.query(`UPDATE source SET fields = $2::jsonb, parent_external_id = $3 WHERE id = $1`,
                [id, JSON.stringify(s.fields ?? {}), s.parent_external_id]);
            }
          }
          sourceMap.set(s.ref, id);
          await upsertOrigin({ origin_uid: originUid, kind: "source", origin_ref: s.ref, local_ref: String(id), origin_hash: null, local_hash: null, batch_id: batchId });
        } catch (e) {
          result.sources_failed = (result.sources_failed ?? 0) + 1;
          result.notes = [...(result.notes ?? []), `자료 ${s.title ?? s.ref} 를 들이지 못했습니다: ${(e as Error).message}`];
        }
      }
      for (const [ref, name] of written) {
        for (const s of byRef.get(ref)?.sources ?? []) {
          const sid = sourceMap.get(s.ref);
          if (!sid || !TARGET_SOURCE_RELATIONS.includes(s.relation)) continue;
          try { await linkKnowledgeSource(name, sid, s.relation, ctx, { viewer: null, allowNarrow: true }); result.sources_linked++; }
          catch { /* 연결 하나가 실패해도 지식은 들어가 있다 — 결과의 수에서 빠진다 */ }
        }
      }
    }

    // ⓔ 저장 뒤처리 — 임베딩 표시 · 낱말 색인 · [[링크]] 엣지(이제 모든 문서가 서 있다).
    for (const post of posts) { try { await post(); } catch { /* best-effort — 스윕이 수렴시킨다 */ } }

    const state = result.counts.failed ? "partial" : "applied";
    const batch = await transitionBatch(batchId, ["applying"], state, { result, applied_by: ctx.actor ?? null, clearPayload: true });
    await audit("org_transfer", String(batchId), "import_apply", null, { counts: result.counts, categories_created: result.categories_created.length, sources_created: result.sources_created.length }, ctx.actor ?? undefined, ctx.source);
    return { batch: batch!, result };
  } catch (e) {
    const touched = result.knowledge.some((r) => r.ok && r.action !== "skip") || result.categories_created.length > 0 || result.sources_created.length > 0;
    await transitionBatch(batchId, ["applying"], touched ? "partial" : "failed", { result, error: (e as Error).message, applied_by: ctx.actor ?? null, clearPayload: true }).catch(() => {});
    throw e;
  }
}

// ── ③ 되돌리기 ──────────────────────────────────────────────────────────────────────

export interface UndoReport {
  deleted: number;
  restored: number;
  kept: Array<{ name: string; reason: string }>;
  categories_deleted: number;
  sources_deleted: number;
}

export async function undoImport(batchId: number, ctx: WriteCtx): Promise<{ batch: BatchRow; report: UndoReport }> {
  const claimed = await transitionBatch(batchId, ["applied", "partial"], "undoing");
  if (!claimed) {
    const b = await getBatch(batchId);
    if (!b) throw new TransferInputError("가져오기를 찾을 수 없습니다", 404);
    throw new TransferInputError(`되돌릴 수 없는 상태입니다(${b.state})`, 409);
  }
  const result = (claimed.result ?? {}) as ApplyResult;
  const report: UndoReport = { deleted: 0, restored: 0, kept: [], categories_deleted: 0, sources_deleted: 0 };
  const originUid = claimed.origin_uid ?? "";
  try {
    // 지식 — 들인 순서의 거꾸로(하위 문서를 상위 폴더보다 먼저).
    for (const r of [...(result.knowledge ?? [])].reverse()) {
      if (!r.ok || r.action === "skip" || !r.name) continue;
      try {
        if (r.created) {
          const exists = await one(itemsPool, `SELECT 1 FROM knowledge WHERE name = $1`, [r.name]);
          if (exists) { await deleteKnowledge(r.name, ctx); report.deleted++; }
        } else if (r.before) {
          const b = r.before;
          const still = await one(itemsPool, `SELECT 1 FROM knowledge WHERE name = $1`, [b.name]);
          if (!still) {
            // 가져온 뒤 사람이 지웠다 — 되돌리기가 그 문서를 되살리면 지운 결정을 거스른다.
            report.kept.push({ name: b.name, reason: "가져온 뒤 지워진 문서라 되살리지 않았습니다" });
            if (r.prev_origin) await upsertOrigin(r.prev_origin); else if (originUid) await deleteOrigin(originUid, "knowledge", r.ref);
            continue;
          }
          await upsertKnowledge({
            name: b.name, title: b.title ?? undefined, body_md: b.body_md, type: b.type ?? undefined, category: b.category ?? undefined,
            provenance: b.provenance, summary: b.summary, searchable: b.searchable, is_folder: b.is_folder, parent_name: b.parent_name,
            sort: b.sort, supersedes: b.supersedes ?? undefined,
          }, ctx);
          const cur = await snapshot(b.name);
          await setFieldsExactly(b.name, b.fields, cur?.fields ?? {}, ctx);
          // 원래 분류가 없던 문서 — 저장(upsert)은 분류를 «안 바꿈» 으로 읽으니, 들일 때 붙인 분류를 직접 뗀다.
          if (!b.category) await itemsPool.query(`DELETE FROM knowledge_category WHERE name = $1`, [b.name]);
          report.restored++;
        }
        if (r.prev_origin) await upsertOrigin(r.prev_origin);
        else if (originUid) await deleteOrigin(originUid, "knowledge", r.ref);
      } catch (e) {
        report.kept.push({ name: r.name, reason: (e as Error).message });
      }
    }
    // 자료 — 이번에 만든 것만(연결은 FK 로 함께 사라진다).
    for (const id of result.sources_created ?? []) {
      try {
        const exists = await one(itemsPool, `SELECT 1 FROM source WHERE id = $1`, [id]);
        if (exists) { await deleteSource(id, ctx); report.sources_deleted++; }
      } catch (e) { report.kept.push({ name: `자료 #${id}`, reason: (e as Error).message }); }
    }
    // 분류 — 이번에 만든 것 중 비어 있는 것만(그사이 다른 지식이 들어갔으면 남긴다 — deleteCategory 가 검사한다).
    for (const c of result.categories_created ?? []) {
      try {
        const cat = await getCategoryByKey(c.key);
        if (cat) { await deleteCategory(Number((cat as { id: number }).id), ctx); report.categories_deleted++; }
      } catch (e) { report.kept.push({ name: `분류 ${c.key}`, reason: (e as Error).message }); }
    }
    const batch = await transitionBatch(batchId, ["undoing"], "undone", { result: { ...result, undo: report }, undone_by: ctx.actor ?? null });
    await audit("org_transfer", String(batchId), "import_undo", null, report, ctx.actor ?? undefined, ctx.source);
    return { batch: batch!, report };
  } catch (e) {
    await transitionBatch(batchId, ["undoing"], "partial", { result: { ...result, undo: report }, error: (e as Error).message }).catch(() => {});
    throw e;
  }
}

/** 분류 맞추기 고르기 재료 — 받는 쪽의 살아 있는 분류(미리보기 화면이 «어디로 맞출지» 고르는 목록). */
export async function listActiveCategories(): Promise<Array<{ key: string; name: string | null }>> {
  const rows = await q(itemsPool, `SELECT key, name FROM category WHERE state = 'active' ORDER BY cross_cutting DESC, name NULLS LAST, key`, []);
  return rows.map((r) => ({ key: String(r.key), name: (r.name as string | null) ?? null }));
}

/** 미리보기 다시 보기 — 저장해 둔 계획을 돌려준다(적용 전이면 받는 쪽이 바뀌었을 수 있어 새로 세운다). */
export async function refreshPlan(batchId: number): Promise<{ batch: BatchRow; plan: Plan | null }> {
  const batch = await getBatch(batchId);
  if (!batch) throw new TransferInputError("가져오기를 찾을 수 없습니다", 404);
  if (batch.state !== "planned") return { batch, plan: (batch.plan as Plan) ?? null };
  const payload = await getBatchPayload(batchId);
  if (!payload) return { batch, plan: (batch.plan as Plan) ?? null };
  const { bundle, problems } = await readBundle(payload);
  const plan = planImport(bundle, await loadTargetState(bundle), problems);
  return { batch: { ...batch, plan }, plan };
}

export { UNSORTED };

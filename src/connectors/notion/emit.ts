// Notion 방출 계층(#1313 R22 분할 — 구 notion.ts 1116-1329) — 수집된 트래버설 상태 → canonical RawItem.
import type { RawItem } from "../types.js";
import { unitName } from "../../org/ingest/external-identity.js";
import {
  blocksToMd, commentsToMd, dataSourceSchemaMd, normalizeNotionId, normalizeProperties,
  propertiesTableMd,
} from "../notion-md.js";
import type { NotionMdCtx, NormalizedProp } from "../notion-md.js";
import type { NotionDataSource } from "../notion-types.js";
import { asRec } from "./client.js";
import type { Rec } from "./client.js";
import { dsOwnerDb, titleOfDb, titleOfPage } from "./state.js";
import type { DbNode, PageNode, Traversal } from "./state.js";
import { assetFileName } from "./assets.js";

// ── 방출 단계 헬퍼 ───────────────────────────────────────────────────────────
function makeCtx(t: Traversal, ownerId: string, links: Map<string, string>): NotionMdCtx {
  return {
    resolveRef: (nid) => {
      const id = normalizeNotionId(nid);
      const viaDs = dsOwnerDb(t, id);
      const target = viaDs ?? id;
      const pn = t.pages.get(target);
      if (pn?.page) return { name: unitName("notion", target), title: titleOfPage(pn.page) || null };
      const dn = t.dbs.get(target);
      if (dn?.db) return { name: unitName("notion", target), title: titleOfDb(dn.db) || null };
      // 델타(#586) — 이번 run 이 안 건드린 미변경 대상은 원장으로 해소(링크·제목이 델타에서도 끊기지 않게).
      //  활성만: archived 를 해소하면 full 렌더(트래버스 미포함=null)와 어긋나 본문이 모드 따라 왕복(리뷰).
      //  이번 run 실패 노드(page/db null)는 원장 제목이 있으면 그걸 우선(실패가 제목을 가리지 않게).
      const led = t.ledger?.byId.get(target);
      if (led?.lifecycle === "active") return { name: unitName("notion", target), title: led.title || null };
      if (pn || dn) return { name: unitName("notion", target), title: null };
      return null;
    },
    resolveUser: (uid) => t.users.get(uid)?.name ?? null,
    assetUrl: (file, hint) => {
      const f = asRec(file);
      const type = String(f.type ?? "");
      let url = "";
      let expiring = false;
      if (type === "external") url = String(asRec(f.external).url ?? "");
      else if (type === "file") { url = String(asRec(f.file).url ?? ""); expiring = true; }
      else if (type === "custom_emoji") url = String(asRec(f.custom_emoji).url ?? "");
      else if (asRec(f.file).url) { url = String(asRec(f.file).url); expiring = true; } // 댓글 첨부 {category, file:{url}} — type 필드 없음
      else if (asRec(f.external).url) url = String(asRec(f.external).url);
      else if (typeof f.url === "string") url = f.url;
      if (!url) return null;
      if (!expiring) return url; // external — 만료 없음, 원본 유지
      const fname = assetFileName({ ...hint, pageId: ownerId }, url);
      if (!t.assetJobs.has(fname)) {
        const expiry = String(asRec(f.file).expiry_time ?? "") || undefined;
        t.assetJobs.set(fname, { url, file: fname, blockId: hint.blockId, pageId: ownerId, kind: hint.kind, expiry });
      }
      return `/api/ui/notion-assets/${fname}`;
    },
    addLink: (target, kind) => {
      const id = normalizeNotionId(target);
      if (!id || id === ownerId) return;
      if (!links.has(id)) links.set(id, kind);
    },
  };
}

function coverMd(ctx: NotionMdCtx, obj: { cover?: Rec | null } | null): string {
  const cover = obj?.cover;
  if (!cover) return "";
  const url = ctx.assetUrl(cover, { kind: "cover" });
  return url ? `![cover](${url})` : "";
}

function iconValue(icon: Rec | null | undefined, ctx?: NotionMdCtx): unknown {
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji ?? null;
  // 파일형/커스텀 이모지 아이콘 — 업로드형은 1시간 만료 URL 이라 자산으로 다운로드해 영구 참조로 치환.
  const url = ctx ? ctx.assetUrl(icon, { kind: "icon" }) : null;
  return url ? { type: icon.type ?? "file", url } : icon;
}

function linksArray(t: Traversal, links: Map<string, string>): Array<{ target_external_id: string; target_name: string; kind: string }> {
  return [...links.entries()]
    .filter(([, kind]) => kind !== "child") // 자식 엣지는 트리(parent_name)가 진실 — 링크 그래프에 중복 물질화하지 않음
    .filter(([id]) => {
      if (t.pages.has(id) || t.dbs.has(id) || t.dsToDb.has(id)) return true;
      // 델타 — 미변경 대상은 원장으로 유지(링크 유실 방지). 활성만: archived 는 full 렌더와의 결정성(리뷰).
      const tgt = t.ledger?.dsToDb.get(id) ?? id;
      return t.ledger?.byId.get(tgt)?.lifecycle === "active";
    })
    .map(([id, kind]) => {
      const target = dsOwnerDb(t, id) ?? id;
      return { target_external_id: target, target_name: unitName("notion", target), kind };
    });
}

export function emitPage(t: Traversal, node: PageNode, parentExtId: string | undefined): RawItem {
  const page = node.page!;
  const links = new Map<string, string>();
  const ctx = makeCtx(t, node.id, links);

  const parts: string[] = [];
  const cover = coverMd(ctx, page as { cover?: Rec | null });
  if (cover) parts.push(cover);
  const normProps = normalizeProperties(page.properties, ctx);
  if (node.isDbRow) {
    const table = propertiesTableMd(normProps);
    if (table) parts.push(table);
  }
  if (node.blocks) parts.push(blocksToMd(node.blocks, ctx));
  if (node.comments.length) parts.push(commentsToMd(node.comments, ctx));
  const body = parts.filter(Boolean).join("\n\n").trim();

  // 자식 순서를 부모가 들고 간다 — 증분에서 부모만 변경돼도(자식 재정렬) run-sync 후처리가 자식 sort 수렴.
  const childrenOrder = node.childrenOrder;
  const propsForFields: Record<string, NormalizedProp> = {};
  for (const [k, v] of Object.entries(normProps)) if (v.type !== "title") propsForFields[k] = v;

  const actorId = page.created_by?.id;
  const actorUser = actorId ? t.users.get(actorId) : null;
  const archived = page.archived === true || page.in_trash === true;

  t.stats.emitted++;
  return {
    type: "doc",
    provenance: {
      category: "collab_tool", system: "notion", instance: t.cfg.instance,
      external_id: node.id, external_url: page.url,
    },
    actor: actorId ? {
      external_id: actorId,
      display_name: actorUser?.name,
      email: actorUser?.person?.email,
      is_bot: actorUser?.type === "bot",
    } : undefined,
    container_ref: parentExtId,
    parent_external_id: parentExtId,
    sort: node.sort ?? undefined,
    title: titleOfPage(page) || "(제목 없음)",
    body: body || undefined,
    occurred_at: page.created_time,
    updated_at: page.last_edited_time,
    fields: {
      archived: page.archived ?? false,
      in_trash: page.in_trash ?? false,
      parent_type: page.parent?.type,
      last_edited_by: page.last_edited_by?.id,
      notion: {
        kind: node.isDbRow ? "db_row" : "page",
        url: page.url ?? null,
        icon: iconValue(page.icon as Rec | null, ctx),
        archived,
        properties: propsForFields,
        links: linksArray(t, links),
        children_order: childrenOrder,
        comment_count: node.comments.length,
      },
    },
    raw: {
      page,
      blocks: node.blocks ?? [],
      comments: node.comments,
      property_items: node.propertyItems,
    },
  };
}

export function emitDb(t: Traversal, node: DbNode, parentExtId: string | undefined): RawItem {
  const db = node.db!;
  const links = new Map<string, string>();
  const ctx = makeCtx(t, node.id, links);

  const parts: string[] = [];
  const cover = coverMd(ctx, db as { cover?: Rec | null });
  if (cover) parts.push(cover);
  const desc = (db.description ?? []).map((rt) => rt.plain_text ?? "").join("").trim();
  if (desc) parts.push(desc);
  const schemaSrc = node.dataSources.length ? node.dataSources : (db.properties ? [{ id: db.id, properties: db.properties } as NotionDataSource] : []);
  if (schemaSrc.length) {
    parts.push("## 스키마", dataSourceSchemaMd(schemaSrc));
  }
  if (node.unsupported) {
    parts.push([
      ":::callout icon=ℹ️",
      "연결된 데이터베이스 보기(linked view)라 노션 API 가 행 조회를 지원하지 않습니다 — 원본 데이터베이스가 공유 범위에 있으면 내용은 그쪽 노드로 수집됩니다.",
      ":::",
    ].join("\n"));
  }
  if (node.rowIds.length) {
    const listed = node.rowIds.slice(0, 100).map((rid) => {
      const rn = t.pages.get(rid);
      const title = titleOfPage(rn?.page ?? null) || "(제목 없음)";
      return `- 📄 [${title}](#/k/${unitName("notion", rid)})`;
    });
    parts.push(`## 항목 (${node.rowIds.length})`, listed.join("\n") + (node.rowIds.length > 100 ? `\n- … 외 ${node.rowIds.length - 100}건(하위 페이지 트리 참조)` : ""));
  }
  const body = parts.filter(Boolean).join("\n\n").trim();
  const archived = db.archived === true || db.in_trash === true;

  t.stats.emitted++;
  return {
    type: "doc",
    provenance: {
      category: "collab_tool", system: "notion", instance: t.cfg.instance,
      external_id: node.id, external_url: db.url,
    },
    actor: db.created_by?.id ? { external_id: db.created_by.id, display_name: t.users.get(db.created_by.id)?.name } : undefined,
    container_ref: parentExtId,
    parent_external_id: parentExtId,
    sort: node.sort ?? undefined,
    title: titleOfDb(db) || "(제목 없는 데이터베이스)",
    body: body || undefined,
    occurred_at: db.created_time,
    updated_at: db.last_edited_time,
    fields: {
      archived: db.archived ?? false,
      in_trash: db.in_trash ?? false,
      parent_type: db.parent?.type,
      notion: {
        kind: "database",
        url: db.url ?? null,
        icon: iconValue(db.icon as Rec | null, ctx),
        is_inline: db.is_inline ?? false,
        unsupported: node.unsupported || undefined, // linked 뷰 — 행 조회 API 미지원(한계 고지)
        archived,
        links: linksArray(t, links),
        children_order: node.rowIds,
        data_source_ids: node.dataSources.map((d) => normalizeNotionId(d.id)),
      },
    },
    raw: { database: db, data_sources: node.dataSources },
  };
}

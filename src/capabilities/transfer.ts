// 워크스페이스 간 옮기기(#5458) — JSON 표면(REST + MCP 같은 handler). 파일이 오가는 두 경로는 src/transfer/routes.ts.
//  권한: 전부 관리자(상민님 2026-11-09 — 내보내기·가져오기 모두 관리자만). 되돌리기는 사람(웹)만(보완 5 — 에이전트는 지식을 못 지운다).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";
import { itemsPool, q } from "../db/client.js";
import { knowledgeVisWhere } from "../v6/knowledge-common.js";
import { previewExport, parseSelection } from "../transfer/export.js";
import { applyImport, undoImport, refreshPlan, listActiveCategories } from "../transfer/apply.js";
import { listBatches } from "../transfer/store.js";
import { UNSORTED, type Decisions, type KnowledgeAction, type CategoryDecision } from "../transfer/plan.js";
import { mapTransferErrors } from "../transfer/http-errors.js";
import { batchView } from "../transfer/view.js";

const ACTIONS = ["create", "rename", "overwrite", "update", "skip"] as const;

const actorCtx = (user: LivelyUser, ctx?: CapabilityCtx) => ({ actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });

const idParam = (req: { params?: unknown }): number => Number((req.params as Record<string, string> | undefined)?.id);

const selectionInput = {
  all: z.boolean().optional().describe("워크스페이스 전체(설치 시드 제외)"),
  categories: z.array(z.string()).optional().describe(`분류 key 목록 — 그 분류의 지식 전부. 분류 없는 지식은 '${UNSORTED.ref}'`),
  knowledge: z.array(z.string()).optional().describe("개별로 고른 지식 이름"),
  include_sources: z.boolean().optional().describe("담긴 지식에 연결된 자료도 함께"),
  include_archived: z.boolean().optional().describe("보관한 지식도 함께(분류·전체 선택에만 적용)"),
};

const catalogKnowledgeInput = {
  category: z.string().optional().describe(`분류 key(분류 없는 지식은 '${UNSORTED.ref}'). q 와 함께 쓰면 그 분류 안에서 찾는다`),
  q: z.string().optional().describe("제목·이름에 이 글자가 든 지식 찾기(분류 무관, 최대 200건)"),
  include_archived: z.boolean().optional(),
};
type CatalogKnowledgeInput = z.infer<z.ZodObject<typeof catalogKnowledgeInput>>;

const applyInput = {
  id: z.number().int().positive().describe("가져오기 번호(올리기 응답의 batch.id)"),
  knowledge: z.record(z.enum(ACTIONS)).optional().describe("지식 원래 이름 → 행동(create|rename|overwrite|update|skip). 없거나 허용 밖이면 미리보기의 기본값"),
  categories: z.record(z.object({
    action: z.enum(["map", "create"]),
    to: z.string().optional().describe("map 일 때 받는 쪽 분류 key"),
    key: z.string().optional().describe("create 일 때 새 분류 key(없으면 제안값)"),
    name: z.string().optional().describe("create 일 때 새 분류 이름"),
  })).optional().describe("묶음 쪽 분류 key → 맞추기(map) 또는 새로 만들기(create)"),
  include_sources: z.boolean().optional().describe("묶음에 자료가 있으면 함께 들일지(기본 true)"),
};
type ApplyInput = z.infer<z.ZodObject<typeof applyInput>>;

function parseDecisions(b: Record<string, unknown>): Decisions {
  const knowledge: Record<string, KnowledgeAction> = {};
  const kin = b.knowledge && typeof b.knowledge === "object" ? b.knowledge as Record<string, unknown> : {};
  for (const [ref, a] of Object.entries(kin)) if ((ACTIONS as readonly string[]).includes(String(a))) knowledge[ref] = a as KnowledgeAction;
  const categories: Record<string, CategoryDecision> = {};
  const cin = b.categories && typeof b.categories === "object" ? b.categories as Record<string, unknown> : {};
  for (const [ref, v] of Object.entries(cin)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (o.action === "map" && typeof o.to === "string") categories[ref] = { action: "map", to: o.to };
    else if (o.action === "create") categories[ref] = { action: "create", key: typeof o.key === "string" ? o.key : undefined, name: typeof o.name === "string" ? o.name : undefined };
  }
  return { knowledge, categories, include_sources: b.include_sources !== false };
}

export const transferCapabilities: Capability[] = [
  {
    name: "transfer_export_catalog",
    title: "옮기기 — 내보낼 분류 목록",
    description: "워크스페이스 간 옮기기에서 내보낼 것을 고르는 첫 화면 재료 — 분류마다 지식 수(보관·대상자 제한 수 포함)와 분류 없는 지식 수. 관리자만.",
    scope: "admin",
    mutates: false,
    input: {},
    expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/transfer/catalog"], parse: () => ({}) }] },
    async handler() {
      const params: unknown[] = [];
      const vis = await knowledgeVisWhere(null, params);
      const rows = await q(itemsPool,
        `WITH vk AS (
           SELECT k.name, k.lifecycle, k.visibility FROM knowledge k WHERE COALESCE(k.updated_by, '') <> 'system' AND ${vis}),
         kc1 AS (
           SELECT DISTINCT ON (kc.name) kc.name, kc.category_id FROM knowledge_category kc
            WHERE kc.state <> 'rejected' ORDER BY kc.name, (kc.state = 'confirmed') DESC, kc.category_id)
         SELECT c.key, c.name,
                count(vk.name) FILTER (WHERE vk.lifecycle <> 'archived')::int AS count,
                count(vk.name) FILTER (WHERE vk.lifecycle = 'archived')::int AS archived,
                count(vk.name) FILTER (WHERE vk.lifecycle <> 'archived' AND vk.visibility <> 'open')::int AS restricted
           FROM category c
           LEFT JOIN kc1 ON kc1.category_id = c.id
           LEFT JOIN vk ON vk.name = kc1.name
          WHERE c.state <> 'merged'
          GROUP BY c.id, c.key, c.name, c.cross_cutting
          ORDER BY c.cross_cutting DESC, c.name NULLS LAST, c.key`, params);
      const p2: unknown[] = [];
      const vis2 = await knowledgeVisWhere(null, p2);
      const un = (await q(itemsPool,
        `SELECT count(*) FILTER (WHERE k.lifecycle <> 'archived')::int AS count,
                count(*) FILTER (WHERE k.lifecycle = 'archived')::int AS archived,
                count(*) FILTER (WHERE k.lifecycle <> 'archived' AND k.visibility <> 'open')::int AS restricted
           FROM knowledge k
          WHERE NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.name = k.name AND kc.state <> 'rejected')
            AND COALESCE(k.updated_by, '') <> 'system' AND ${vis2}`, p2))[0] ?? { count: 0, archived: 0, restricted: 0 };
      const categories = rows.map((r) => ({ key: String(r.key), name: (r.name as string | null) ?? null, count: Number(r.count), archived: Number(r.archived), restricted: Number(r.restricted) }));
      if (Number(un.count) || Number(un.archived)) {
        categories.push({ key: UNSORTED.ref, name: "(분류 없음)", count: Number(un.count), archived: Number(un.archived), restricted: Number(un.restricted) });
      }
      return { categories };
    },
  },
  {
    name: "transfer_export_catalog_knowledge",
    title: "옮기기 — 분류 안 문서 목록·찾기",
    description: "내보낼 문서를 하나씩 고를 때 — category 를 주면 그 분류의 문서 목록, q 를 주면 제목·이름으로 찾기(분류 무관). 관리자만.",
    scope: "admin",
    mutates: false,
    input: catalogKnowledgeInput,
    expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/transfer/catalog/knowledge"], parse: (req) => ({
      category: typeof req.query?.category === "string" ? req.query.category : undefined,
      q: typeof req.query?.q === "string" ? req.query.q : undefined,
      include_archived: req.query?.include_archived === "1" || req.query?.include_archived === "true",
    }) }] },
    async handler(input: CatalogKnowledgeInput) {
      const category = input.category?.trim() || null;
      const text = input.q?.trim() || null;
      if (!category && !text) throw new HttpError(400, "category 또는 q 가 필요합니다");
      const params: unknown[] = [];
      const where: string[] = [`COALESCE(k.updated_by, '') <> 'system'`];
      if (!input.include_archived && !text) where.push(`k.lifecycle <> 'archived'`);
      if (category === UNSORTED.ref) where.push(`NOT EXISTS (SELECT 1 FROM knowledge_category x WHERE x.name = k.name AND x.state <> 'rejected')`);
      else if (category) { params.push(category); where.push(`c.key = $${params.length}`); }
      if (text) { params.push(`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(k.title ILIKE $${params.length} OR k.name ILIKE $${params.length})`); }
      where.push(await knowledgeVisWhere(null, params));
      const limit = text ? 200 : 3000;
      const rows = await q(itemsPool,
        `SELECT k.name, k.title, k.is_folder, k.visibility, k.lifecycle, k.parent_name, k.updated_at, c.key AS category, c.name AS category_name
           FROM knowledge k
           LEFT JOIN LATERAL (
             SELECT kc.category_id FROM knowledge_category kc WHERE kc.name = k.name AND kc.state <> 'rejected'
              ORDER BY (kc.state = 'confirmed') DESC, kc.category_id LIMIT 1) kc1 ON true
           LEFT JOIN category c ON c.id = kc1.category_id
          WHERE ${where.join(" AND ")}
          ORDER BY k.is_folder DESC, lower(COALESCE(k.title, k.name)) LIMIT ${limit + 1}`, params);
      return {
        knowledge: rows.slice(0, limit).map((r) => ({
          name: String(r.name), title: (r.title as string | null) ?? null, is_folder: !!r.is_folder,
          restricted: r.visibility !== "open", archived: r.lifecycle === "archived", parent: (r.parent_name as string | null) ?? null,
          category: (r.category as string | null) ?? UNSORTED.ref, category_name: (r.category_name as string | null) ?? null,
        })),
        truncated: rows.length > limit,
      };
    },
  },
  {
    name: "transfer_export_preview",
    title: "옮기기 — 내보내기 미리보기",
    description: "고른 것(분류·개별 문서)을 내보내면 무엇이 몇 건 담기는지와 안내 문장(대상자를 제한한 지식은 받는 쪽에서 공개로 들어간다 등). 파일은 만들지 않는다 — 파일은 POST /api/ui/transfer/export. 관리자만.",
    scope: "admin",
    mutates: false,
    input: selectionInput,
    expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/transfer/export/preview"], parse: (req) => parseSelection((req.body ?? {}) as Record<string, unknown>) as Record<string, unknown> }] },
    async handler(input: Record<string, unknown>) {
      const { names: _names, ...preview } = await previewExport(parseSelection(input), null);
      return { preview };
    },
  },
  {
    name: "transfer_imports",
    title: "옮기기 — 가져오기 목록",
    description: "이 워크스페이스로 올린 묶음 파일 목록(상태: planned=미리보기만 · applied=들임 · partial=일부 실패 · undone=되돌림 · expired=적용 안 하고 만료). 관리자만.",
    scope: "admin",
    mutates: false,
    input: {},
    expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/transfer/imports"], parse: () => ({}) }] },
    async handler() {
      return { imports: (await listBatches(50)).map((b) => batchView(b)) };
    },
  },
  {
    name: "transfer_import_get",
    title: "옮기기 — 가져오기 미리보기 보기",
    description: "올린 묶음의 미리보기(지식마다 새로 만들기·이름 겹침·다시 가져오기 판정과 기본 행동, 분류 맞추기 제안)와 결과. 적용 전이면 받는 쪽의 지금 상태로 다시 세운다. 관리자만.",
    scope: "admin",
    mutates: false,
    input: { id: z.number().int().positive() },
    expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/transfer/imports/:id"], parse: (req) => ({ id: idParam(req) }) }] },
    async handler(input: { id: number }) {
      if (!Number.isInteger(input.id) || input.id <= 0) throw new HttpError(400, "가져오기 번호가 필요합니다");
      const { batch } = await mapTransferErrors(() => refreshPlan(input.id));
      return { batch: batchView(batch, { withPlan: true }), target_categories: await listActiveCategories() };
    },
  },
  {
    name: "transfer_import_apply",
    title: "옮기기 — 가져오기 적용",
    description: "올린 묶음을 실제로 들인다. knowledge·categories 로 미리보기의 기본 행동을 바꿀 수 있다(없거나 허용 밖이면 기본값 — 기본값은 덮어쓰지 않는다). 대상자를 제한했던 지식은 공개로 들어간다. 관리자만.",
    scope: "admin",
    input: applyInput,
    expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/transfer/imports/:id/apply"], parse: (req) => ({ ...(req.body as object ?? {}), id: idParam(req) }) }] },
    async handler(input: ApplyInput, user: LivelyUser, ctx?: CapabilityCtx) {
      if (!Number.isInteger(input.id) || input.id <= 0) throw new HttpError(400, "가져오기 번호가 필요합니다");
      const decisions = parseDecisions(input as unknown as Record<string, unknown>);
      const { batch } = await mapTransferErrors(() => applyImport(input.id, decisions, actorCtx(user, ctx)));
      return { batch: batchView(batch) };
    },
  },
  {
    name: "transfer_import_undo",
    title: "옮기기 — 가져오기 되돌리기",
    description: "들인 묶음을 되돌린다 — 새로 만든 지식은 휴지통으로, 덮어쓴 지식은 가져오기 전 판으로, 새로 만든 분류·자료는 비었으면 지운다. ⚠ 사람(웹)만 — 에이전트는 403. 관리자만.",
    scope: "admin",
    input: { id: z.number().int().positive() },
    expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/transfer/imports/:id/undo"], parse: (req) => ({ id: idParam(req) }) }] },
    async handler(input: { id: number }, user: LivelyUser, ctx?: CapabilityCtx) {
      //  이중 잠금 — MCP 표면엔 세우지 않지만(mcp:false), 휴지통 복원과 같은 문을 핸들러에도 건다(한쪽이 풀려도 다른 쪽이 막는다).
      if (ctx?.source === "mcp") throw new HttpError(403, "되돌리기는 사람(웹)만 할 수 있습니다 — 에이전트는 지식을 지울 수 없습니다");
      if (!Number.isInteger(input.id) || input.id <= 0) throw new HttpError(400, "가져오기 번호가 필요합니다");
      const { batch, report } = await mapTransferErrors(() => undoImport(input.id, actorCtx(user, ctx)));
      return { batch: batchView(batch), report };
    },
  },
];

// v6 source(자료) capability — #290. raw 입력층(회의 전사록·이메일·슬랙·외부 미러). knowledge(지식)와 분리.
//  ★별도 테이블이라 recall(knowledge_search)에 안 섞인다. 정제하면 knowledge_save 로 지식을 만들고 source_link_knowledge 로 인용.
//  scope='memory'(조직 지식과 동일 축). 전부 expose.mcp:true(자동등록) + REST(웹 자료 탭 /api/ui/sources).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listSources, getSource, upsertSource, deleteSource, listUndistilledSources } from "../v6/source-store.js";
import { linkKnowledgeSource, unlinkKnowledgeSource } from "../v6/knowledge-store.js";

const SOURCE_KINDS = ["transcript", "minutes", "email", "slack", "notion_doc", "clickup_doc", "other"] as const;

const sourceList: Capability = {
  name: "source_list",
  title: "자료 목록",
  description:
    "자료(raw 입력 — 회의 전사록·이메일·슬랙·외부 미러)를 kind/provenance/q 로 조회. 지식(knowledge)과 별도 테이블이라 recall(knowledge_search)에 안 섞인다. 본문은 미포함(목록은 얕게).",
  scope: "memory",
  input: {
    kind: z.enum(SOURCE_KINDS).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    q: z.string().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          kind: query.kind ? String(query.kind) : undefined,
          provenance: query.provenance ? String(query.provenance) : undefined,
          q: query.q ? String(query.q) : undefined,
        };
      } }],
  },
  handler: async (input: any) => ({ entries: await listSources(input) }),
};

const sourceGet: Capability = {
  name: "source_get",
  title: "자료 상세",
  description: "자료 1건(전문) + 이 자료에서 파생된 지식(knowledge_source 역방향).",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources/:id"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: any) => {
    const source = await getSource(input.id);
    if (!source) throw new Error(`자료 #${input.id} 없음`);
    return { source };
  },
};

const sourceSave: Capability = {
  name: "source_save",
  title: "자료 저장",
  description:
    "자료(raw)를 저장/수정한다(id 주면 수정). kind=transcript|minutes|email|slack|notion_doc|clickup_doc|other. provenance=authored(우리 캡처)|observed(외부 미러). " +
    "정제해서 지식을 만들려면 knowledge_save 로 지식을 쓰고 source_link_knowledge 로 이 자료를 인용(derived_from) 잇는다.",
  scope: "memory",
  input: {
    id: z.number().int().positive().optional(),
    name: z.string().max(64).optional(),
    kind: z.enum(SOURCE_KINDS).optional(),
    title: z.string().max(200).optional(),
    body_md: z.string().max(200000).optional(),
    provenance: z.enum(["authored", "observed"]).optional(),
    occurred_at: z.string().optional().describe("발생 시각(ISO) — 회의·메일 시각"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: b.id ? Number(b.id) : undefined,
          name: b.name ? String(b.name) : undefined,
          kind: b.kind ? String(b.kind) : undefined,
          title: b.title ? String(b.title) : undefined,
          body_md: b.body_md != null ? String(b.body_md) : undefined,
          provenance: b.provenance ? String(b.provenance) : undefined,
          occurred_at: b.occurred_at ? String(b.occurred_at) : undefined,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { source: await upsertSource(input, writeCtx) };
  },
};

const sourceLinkKnowledge: Capability = {
  name: "source_link_knowledge",
  title: "자료↔지식 인용",
  description: "지식이 어느 자료에서 파생됐는지 잇는다(derived_from=증류 | cites=참조). 또는 unlink=true 로 해제. 카파시 source→wiki citation.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(64).describe("지식 이름"),
    source_id: z.number().int().positive(),
    relation: z.enum(["derived_from", "cites"]).default("derived_from"),
    unlink: z.boolean().optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources/:id/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name(지식 이름)이 필요합니다");
        return {
          name, source_id: Number(req.params?.id),
          relation: b.relation ? String(b.relation) : "derived_from",
          unlink: b.unlink === true,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkKnowledgeSource(input.name, input.source_id, input.relation, writeCtx); return { unlinked: true }; }
    await linkKnowledgeSource(input.name, input.source_id, input.relation, writeCtx);
    return { linked: true };
  },
};

const sourceDelete: Capability = {
  name: "source_delete",
  title: "자료 삭제",
  description: "자료를 삭제한다(감사 스냅샷 보존, knowledge_source 인용은 CASCADE 정리·지식은 생존). ⚠ 사람(웹)만 — 에이전트(MCP)는 403.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/sources/:id/delete"],
      parse: (req) => ({ id: Number(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    if (ctx?.source === "mcp") throw new HttpError(403, "자료 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const before = await deleteSource(input.id, writeCtx);
    return { deleted: true, id: input.id, title: (before as any)?.title ?? null };
  },
};

// distill 대상 — 아직 지식으로 증류 안 된 자료(knowledge_source 링크 없는 것). distill 세션이 지식화 대상 조회(#541).
const sourceUndistilled: Capability = {
  name: "source_undistilled",
  title: "미증류 자료 목록",
  description:
    "아직 지식으로 증류되지 않은 자료(knowledge_source 링크가 없는 것)를 최근순으로 조회한다 — distill 세션이 지식화 대상을 가져올 때 쓴다. 본문 미포함(source_get 으로 전문). 지식화(source_link_knowledge)하면 다음 조회에서 빠진다.",
  scope: "memory",
  input: { limit: z.number().int().positive().max(500).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/sources/undistilled"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return { limit: query.limit ? Number(query.limit) : undefined };
      } }],
  },
  handler: async (input: any) => ({ entries: await listUndistilledSources(input.limit) }),
};

// ⚠ REST 순서: sourceUndistilled(/sources/undistilled, GET) 은 sourceGet(/sources/:id) 보다 **먼저** 마운트되어야
//  'undistilled' 가 :id 로 먹히지 않는다(구체 경로 우선). sourceGet(/sources/:id)·sourceList(/sources) 는 세그먼트 수로 구분.
//  POST 들(/sources, /sources/:id/knowledge, /sources/:id/delete)도 상호 구분.
export const sourceCapabilities: Capability[] = [
  sourceList, sourceUndistilled, sourceGet, sourceSave, sourceLinkKnowledge, sourceDelete,
];

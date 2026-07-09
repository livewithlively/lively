// v6 상태 체계 템플릿 capability(#729) — 리스트 상태 스킴을 워크스페이스('스페이스') 단위 재사용 템플릿으로.
//  is_default=true 인 1개가 '스페이스 기본'(inherit 리스트가 상속). 경로 prefix=/api/ui/v6/status-templates. scope='memory'.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listStatusTemplates, getDefaultStatusTemplate, createStatusTemplate,
  updateStatusTemplate, deleteStatusTemplate, setDefaultStatusTemplate,
} from "../v6/status-template-store.js";

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
const writeCtxOf = (user: any, ctx: any) => ({ actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" });

// 상태 정의 배열 스키마(리스트 커스텀 상태와 동형) — key/label/color/category.
const statusesSchema = z.array(z.object({
  key: z.string().min(1).max(120),
  label: z.string().max(120).optional(),
  color: z.string().max(32).optional(),
  category: z.string().max(16).optional(),
})).optional();

// ── 목록(+ 기본 id) ──
const statusTemplateIndexV6: Capability = {
  name: "project_status_template_index_v6",
  title: "상태 체계 템플릿 목록(v6)",
  description: "저장된 상태 체계 템플릿 전체 + 스페이스 기본 템플릿 id 를 돌려준다. inherit(기본 상태 사용) 리스트는 이 기본 템플릿 스킴을 물려받는다.",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/status-templates"], parse: () => ({}) }],
  },
  handler: async () => {
    const templates = await listStatusTemplates();
    const def = templates.find((t) => t.is_default) || null;
    return { templates, default_id: def ? def.id : null, default: def };
  },
};

// ── 생성 ──
const statusTemplateCreateV6: Capability = {
  name: "project_status_template_create_v6",
  title: "상태 체계 템플릿 생성(v6)",
  description: "상태 체계 템플릿을 만든다. statuses=[{key,label,color,category(active|done|closed)}]. is_default=true 면 스페이스 기본으로 지정(기존 기본 해제).",
  scope: "memory",
  input: { name: z.string().min(1).max(120), statuses: statusesSchema, is_default: z.boolean().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/status-templates"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return { name, statuses: Array.isArray(b.statuses) ? b.statuses : [], is_default: b.is_default === true || b.is_default === "true" };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const tpl = await createStatusTemplate(input.name, input.statuses ?? [], !!input.is_default, writeCtxOf(user, ctx));
    return { template: tpl };
  },
};

// ── 수정(이름·상태) ──
const statusTemplateUpdateV6: Capability = {
  name: "project_status_template_update_v6",
  title: "상태 체계 템플릿 수정(v6)",
  description: "상태 체계 템플릿의 이름·상태 배열을 수정한다. 주어진 키만 변경.",
  scope: "memory",
  input: { id: z.number().int().positive(), name: z.string().min(1).max(120).optional(), statuses: statusesSchema },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/status-templates/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) { const nm = String(b.name ?? "").trim(); if (!nm) throw new HttpError(400, "name 은 비울 수 없습니다"); patch.name = nm; }
        if ("statuses" in b) patch.statuses = Array.isArray(b.statuses) ? b.statuses : [];
        return patch;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, ...patch } = input;
    const tpl = await updateStatusTemplate(id, patch, writeCtxOf(user, ctx));
    return { template: tpl };
  },
};

// ── 삭제 ──
const statusTemplateDeleteV6: Capability = {
  name: "project_status_template_delete_v6",
  title: "상태 체계 템플릿 삭제(v6)",
  description: "상태 체계 템플릿을 삭제한다. 이 템플릿을 상속하던 리스트는 다음 렌더부터 남은 스페이스 기본(없으면 표준 3단계)을 따른다.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/status-templates/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const tpl = await deleteStatusTemplate(input.id, writeCtxOf(user, ctx));
    return { deleted: true, id: input.id, template: tpl };
  },
};

// ── 스페이스 기본 지정/해제 ──
const statusTemplateSetDefaultV6: Capability = {
  name: "project_status_template_set_default_v6",
  title: "스페이스 기본 상태 템플릿 지정(v6)",
  description: "한 템플릿을 스페이스 기본으로 지정한다(그 외 전부 해제). id=null 이면 기본 해제(표준 3단계로 폴백). inherit 리스트가 이 스킴을 물려받는다.",
  scope: "memory",
  input: { id: z.number().int().positive().nullable() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/status-templates/set-default"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const raw = b.id;
        const id = (raw == null || raw === "") ? null : parseId(raw);
        return { id };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const tpl = await setDefaultStatusTemplate(input.id ?? null, writeCtxOf(user, ctx));
    return { default: tpl, default_id: tpl ? tpl.id : null };
  },
};

// 참고 노출 — 기본 템플릿 단건(선택). index 로 충분해 별도 미노출.
void getDefaultStatusTemplate;

export const statusTemplateV6Capabilities: Capability[] = [
  statusTemplateIndexV6, statusTemplateCreateV6, statusTemplateUpdateV6,
  statusTemplateDeleteV6, statusTemplateSetDefaultV6,
];

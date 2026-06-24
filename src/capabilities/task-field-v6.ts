// v6 커스텀 필드(클릭업형 "+ 컬럼 추가") capability — 루트 프로젝트에 필드를 형식 지정해 정의/수정/삭제하고,
//  각 태스크의 필드값을 패치한다. 전부 REST 전용(웹 프로젝트 탭 <태스크> 박스가 소비), scope='memory'.
//  데이터 접근은 v6/task-field-store. 경로 prefix=/api/ui/v6/projects/:id/fields · /fields/:fieldId · /tasks/:id/fields/:fieldId.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  createField, updateField, deleteField, setFieldValue, listFieldCatalog,
} from "../v6/task-field-store.js";

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
function body(req: any): Record<string, unknown> { return (req.body ?? {}) as Record<string, unknown>; }
function actorOf(user: any, ctx: any): string | null { return ctx?.actor ?? user?.userId ?? null; }

// ── 필드(컬럼) 생성 — {field_type, name, config?} ──
const fieldCreateV6: Capability = {
  name: "task_field_create_v6",
  title: "커스텀 필드 추가(v6)",
  description: "프로젝트에 클릭업형 커스텀 컬럼(필드)을 형식 지정해 추가한다. {field_type, name, config?}. 웹 전용.",
  scope: "memory",
  input: {
    projectId: z.number().int().positive(),
    field_type: z.string().min(1),
    name: z.string().max(120).optional(),
    config: z.any().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/fields"],
      parse: (req) => {
        const b = body(req);
        const ft = String(b.field_type ?? "").trim();
        if (!ft) throw new HttpError(400, "field_type 이 필요합니다");
        return {
          projectId: parseId(req.params?.id),
          field_type: ft,
          name: b.name != null ? String(b.name) : undefined,
          config: b.config ?? {},
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: actorOf(user, ctx), source: ctx?.source ?? "web" };
    try {
      return { field: await createField(input.projectId, { field_type: input.field_type, name: input.name ?? input.field_type, config: input.config }, writeCtx) };
    } catch (e: any) { throw new HttpError(400, e?.message ?? "필드 추가 실패"); }
  },
};

// ── 필드 정의 수정 — 이름/설정(타입 불변). 주어진 키만 변경 ──
const fieldUpdateV6: Capability = {
  name: "task_field_update_v6",
  title: "커스텀 필드 수정(v6)",
  description: "커스텀 필드의 이름/설정(config)을 수정한다. 타입은 불변. 주어진 키만 변경. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive(), name: z.string().max(120).optional(), config: z.any().optional() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/fields/:fieldId"],
      parse: (req) => {
        const b = body(req);
        const out: Record<string, unknown> = { id: parseId(req.params?.fieldId) };
        if ("name" in b) out.name = String(b.name ?? "");
        if ("config" in b) out.config = b.config ?? {};
        return out;
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, ...patch } = input;
    const writeCtx = { actor: actorOf(user, ctx), source: ctx?.source ?? "web" };
    try { return { field: await updateField(id, patch, writeCtx) }; }
    catch (e: any) { throw new HttpError(400, e?.message ?? "필드 수정 실패"); }
  },
};

// ── 필드 삭제(컬럼 통째) — 값은 FK CASCADE 로 동반 제거 ──
const fieldDeleteV6: Capability = {
  name: "task_field_delete_v6",
  title: "커스텀 필드 삭제(v6)",
  description: "커스텀 필드(컬럼)를 삭제한다. 해당 컬럼의 모든 값이 함께 제거된다. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/fields/:fieldId/delete"],
      parse: (req) => ({ id: parseId(req.params?.fieldId) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: actorOf(user, ctx), source: ctx?.source ?? "web" };
    try { return { deleted: true, ...(await deleteField(input.id, writeCtx)) }; }
    catch (e: any) { throw new HttpError(400, e?.message ?? "필드 삭제 실패"); }
  },
};

// ── 태스크의 필드값 패치 — {value}. 빈값=해제(행 삭제). false·0 보존 ──
const fieldValueSetV6: Capability = {
  name: "task_field_value_set_v6",
  title: "태스크 필드값 수정(v6)",
  description: "한 태스크의 커스텀 필드값을 설정/해제한다. {value}(빈값이면 해제). 웹 전용.",
  scope: "memory",
  input: { taskId: z.number().int().positive(), fieldId: z.number().int().positive(), value: z.any() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/fields/:fieldId"],
      parse: (req) => {
        const b = body(req);
        // 키 부재 = 해제(null). value 가 명시되면 그대로(false·0·[] 포함) 전달.
        return {
          taskId: parseId(req.params?.id),
          fieldId: parseId(req.params?.fieldId),
          value: "value" in b ? b.value : null,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: actorOf(user, ctx), source: ctx?.source ?? "web" };
    try { return { value: await setFieldValue(input.taskId, input.fieldId, input.value, writeCtx) }; }
    catch (e: any) { throw new HttpError(400, e?.message ?? "필드값 수정 실패"); }
  },
};

// ── "기존 항목" 탭 — 다른 프로젝트에 만든 필드 정의를 템플릿으로 가져오기(이름·타입·설정만, 값은 미복제) ──
const fieldCatalogV6: Capability = {
  name: "task_field_catalog_v6",
  title: "커스텀 필드 카탈로그(v6)",
  description: "다른 프로젝트들에 정의된 커스텀 필드 목록(이름·타입·설정). '기존 항목' 추가용. 웹 전용.",
  scope: "memory",
  input: { projectId: z.number().int().positive() },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id/field-catalog"],
      parse: (req) => ({ projectId: parseId(req.params?.id) }) }],
  },
  handler: async (input: any) => ({ fields: await listFieldCatalog(input.projectId) }),
};

export const taskFieldV6Capabilities: Capability[] = [
  fieldCreateV6, fieldUpdateV6, fieldDeleteV6, fieldValueSetV6, fieldCatalogV6,
];

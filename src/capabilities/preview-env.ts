// 프리뷰 환경 capability — org_preview_env CRUD + ensure(서빙 준비)/stop. admin scope, REST+MCP. #1036.
//  managed-session.ts 를 1:1 복제. registry(index.ts all[])에 넣으면 web.ts restMounts 루프가 REST 라우트를,
//  registerMcpCapabilities 가 MCP 툴을 자동 생성한다(수동 라우트 등록 불요).
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listPreviewEnvs, getPreviewEnv, upsertPreviewEnv, deletePreviewEnv, ensurePreviewEnv, stopPreviewEnv,
} from "../org/preview-envs.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function pid(v: unknown): string {
  const id = String(v ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return id;
}
function numOpt(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return undefined;
}

const list: Capability = {
  name: "preview_env_list",
  title: "프리뷰 환경 목록",
  description: "프리뷰 환경(org_preview_env) 목록 — 작업자·프로젝트·레포·워크트리·kind(work|stage)·backing·상태. URL = /preview/<id>/.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/preview-envs"], parse: () => ({}) }] },
  handler: async () => ({ envs: await listPreviewEnvs() }),
};

const set: Capability = {
  name: "preview_env_set",
  title: "프리뷰 환경 생성/수정",
  description:
    "프리뷰 환경을 upsert(id 기준). kind=work(작업 워크트리 1:1, 기본)|stage(통합, 2단계). project_id+repo 로 워크트리 특정 " +
    "(worktree_path 직접 지정 가능, 비우면 workspace/project/<id>/<repo> 계산). backing_mode=shared-proxy(기본, /api 는 게이트웨이 자신)|throwaway|existing-ref. " +
    "ttl_idle_sec(0=무제한 유휴 유지). enabled 면 reconcile 이 서빙 준비를 보장.",
  scope: "admin",
  input: {
    id: z.string(),
    label: z.string().max(200).optional(),
    kind: z.enum(["work", "stage"]).optional(),
    owner_member: z.string().max(120).optional(),
    project_id: z.number().int().positive().optional(),
    repo: z.string().max(100).optional(),
    branch: z.string().max(200).optional(),
    worktree_path: z.string().max(500).optional(),
    backing_mode: z.enum(["shared-proxy", "throwaway", "existing-ref"]).optional(),
    backing_ref: z.string().max(500).optional(),
    ttl_idle_sec: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    member_branches: z.array(z.string().max(200)).max(50).optional(), // stage: 통합할 작업 브랜치들(project/<id> 등)
    base_ref: z.string().max(200).optional(),                          // stage: merge base(비면 origin/main)
    merge_trigger: z.enum(["auto", "manual"]).optional(),              // stage: auto=reconcile 재-merge / manual=수동 편입
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/preview-envs"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, label: b.label, kind: b.kind, owner_member: b.owner_member, repo: b.repo, branch: b.branch,
        worktree_path: b.worktree_path, backing_mode: b.backing_mode, backing_ref: b.backing_ref, note: b.note,
        project_id: numOpt(b.project_id), ttl_idle_sec: numOpt(b.ttl_idle_sec),
        enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
        member_branches: Array.isArray(b.member_branches) ? b.member_branches : undefined,
        base_ref: b.base_ref, merge_trigger: b.merge_trigger,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    return { env: await upsertPreviewEnv({ ...input, id: pid(input.id) }, actor) };
  },
};

const del: Capability = {
  name: "preview_env_delete",
  title: "프리뷰 환경 삭제",
  description: "프리뷰 환경 등록을 삭제(레지스트리에서 제거). 워크트리 자체는 별도 — 제거는 워크트리 셀프서비스.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deletePreviewEnv(pid(input.id)),
};

const ensure: Capability = {
  name: "preview_env_ensure",
  title: "프리뷰 환경 띄우기(서빙 준비)",
  description: "프리뷰 서빙을 지금 보장 — shared-proxy(work)는 워크트리 public/ 존재 확인 후 running. 반환 {status, url, action}.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/ensure"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => {
    const p = await getPreviewEnv(pid(input.id));
    if (!p) throw new HttpError(404, "no such preview env: " + input.id);
    return ensurePreviewEnv(p);
  },
};

const stop: Capability = {
  name: "preview_env_stop",
  title: "프리뷰 환경 정지",
  description: "프리뷰를 stopped 로 — 서브패스 서빙 중단(shared-proxy 는 프로세스 없이 상태만; 3단계 throwaway 는 프로세스 종료).",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/stop"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => {
    const p = await getPreviewEnv(pid(input.id));
    if (!p) throw new HttpError(404, "no such preview env: " + input.id);
    return stopPreviewEnv(p.id);
  },
};

export const previewEnvCapabilities: Capability[] = [list, set, del, ensure, stop];

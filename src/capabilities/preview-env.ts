// 프리뷰 환경 capability — org_preview_env CRUD + ensure/stop, + org_stack_profile CRUD. admin scope, REST+MCP. #1036.
//  managed-session.ts 패턴. registry(index.ts all[])에 넣으면 web.ts restMounts 가 REST 를, registerMcpCapabilities 가 MCP 를 자동 생성.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listPreviewEnvs, getPreviewEnv, upsertPreviewEnv, deletePreviewEnv, ensurePreviewEnv, stopPreviewEnv,
  listStackProfiles, upsertStackProfile, deleteStackProfile,
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

// ── preview_env ──
const list: Capability = {
  name: "preview_env_list",
  title: "프리뷰 환경 목록",
  description: "프리뷰 환경(org_preview_env) 목록 — 작업자·프로젝트·레포·워크트리·kind(work|stage)·backing(shared-proxy|throwaway|existing-ref)·상태·포트. URL = /preview/<id>/.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/preview-envs"], parse: () => ({}) }] },
  handler: async () => ({ envs: await listPreviewEnvs() }),
};

const set: Capability = {
  name: "preview_env_set",
  title: "프리뷰 환경 생성/수정",
  description:
    "프리뷰 환경 upsert(id 기준). kind=work(작업 1:1)|stage(통합). backing_mode=shared-proxy(워크트리 public 정적·API=게이트웨이 자신, 기본) | " +
    "throwaway(stack_profile 의 start_cmd 로 백엔드 프로세스를 워크트리에서 띄워 프록시) | existing-ref(backing_ref=기존 인스턴스 URL 로 프록시). " +
    "throwaway 는 stack_profile 필수. project_id+repo 로 워크트리 특정(worktree_path 직접 가능). stage 는 member_branches/base_ref/merge_trigger.",
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
    stack_profile: z.string().max(64).optional(),
    ttl_idle_sec: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    member_branches: z.array(z.string().max(200)).max(50).optional(),
    base_ref: z.string().max(200).optional(),
    merge_trigger: z.enum(["auto", "manual"]).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/preview-envs"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, label: b.label, kind: b.kind, owner_member: b.owner_member, repo: b.repo, branch: b.branch,
        worktree_path: b.worktree_path, backing_mode: b.backing_mode, backing_ref: b.backing_ref, stack_profile: b.stack_profile, note: b.note,
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
  description: "프리뷰 환경 등록을 삭제(throwaway 프로세스는 함께 정지). 워크트리 자체는 별도 — 제거는 워크트리 셀프서비스.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deletePreviewEnv(pid(input.id)),
};

const ensure: Capability = {
  name: "preview_env_ensure",
  title: "프리뷰 환경 띄우기",
  description: "프리뷰 서빙을 지금 보장 — shared-proxy/stage=워크트리 확인, throwaway=백엔드 프로세스 spawn+헬스체크, existing-ref=대상 검증. 반환 {status, url, action, port?}.",
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
  description: "프리뷰를 stopped 로 — throwaway 는 백엔드 프로세스 종료(SIGTERM), 정적/existing-ref 는 상태만.",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/stop"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => {
    const p = await getPreviewEnv(pid(input.id));
    if (!p) throw new HttpError(404, "no such preview env: " + input.id);
    return stopPreviewEnv(p);
  },
};

// ── stack_profile (어떻게 띄우나 — throwaway backing 이 참조. 비개발자는 프리셋을 드롭다운으로 고른다) ──
const spList: Capability = {
  name: "stack_profile_list",
  title: "스택 프로필 목록",
  description: "스택 프로필(org_stack_profile) 목록 — 프리뷰 throwaway 가 '어떻게 띄우나'(start_cmd·port_env·env·healthcheck). 프리셋 + 커스텀.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/stack-profiles"], parse: () => ({}) }] },
  handler: async () => ({ profiles: await listStackProfiles() }),
};

const spSet: Capability = {
  name: "stack_profile_set",
  title: "스택 프로필 생성/수정",
  description:
    "스택 프로필 upsert(id 기준). static_only=true 면 정적(shared-proxy 용, start_cmd 불요). false 면 start_cmd 를 워크트리에서 실행하고 " +
    "port_env(기본 PORT)로 할당 포트를 주입, env_json 을 추가 env 로 넣는다. healthcheck_path 로 기동 확인. 비개발자용 프리셋을 관리자가 정의.",
  scope: "admin",
  input: {
    id: z.string(),
    label: z.string().max(200).optional(),
    repo: z.string().max(100).optional(),
    static_only: z.boolean().optional(),
    start_cmd: z.string().max(1000).optional(),
    port_env: z.string().max(64).optional(),
    env_json: z.record(z.string()).optional(),
    healthcheck_path: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/stack-profiles"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, label: b.label, repo: b.repo, start_cmd: b.start_cmd, port_env: b.port_env,
        healthcheck_path: b.healthcheck_path, note: b.note,
        static_only: typeof b.static_only === "boolean" ? b.static_only : undefined,
        env_json: (b.env_json && typeof b.env_json === "object" && !Array.isArray(b.env_json)) ? b.env_json : undefined,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const actor = ctx?.actor ?? user?.userId ?? null;
    return { profile: await upsertStackProfile({ ...input, id: pid(input.id) }, actor) };
  },
};

const spDel: Capability = {
  name: "stack_profile_delete",
  title: "스택 프로필 삭제",
  description: "스택 프로필 삭제. 이 프로필을 쓰는 throwaway 프리뷰는 다음 띄우기에서 오류가 난다(프로필 재지정 필요).",
  scope: "admin",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/stack-profiles/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deleteStackProfile(pid(input.id)),
};

export const previewEnvCapabilities: Capability[] = [list, set, del, ensure, stop, spList, spSet, spDel];

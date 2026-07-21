// 미리보기 capability — org_preview_env CRUD + ensure/stop, + org_stack_profile 조회/정의. REST+MCP. #1036.
//  ⚠ **권한이 갈린다.** 미리보기 사용(list/set/ensure/stop/delete)과 프로필 **조회**는 `code`(작업자) —
//   관리자 전용으로 잠그면 정작 화면을 확인해야 할 사람이 못 쓴다. 반면 프로필 **정의**(stack_profile_set/delete)는
//   `admin` — start_cmd·build_cmd 는 셸 명령이라 아무나 만들면 그게 곧 임의 코드 실행이다.
//  managed-session.ts 패턴. registry(index.ts all[])에 넣으면 web.ts restMounts 가 REST 를, registerMcpCapabilities 가 MCP 를 자동 생성.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listPreviewEnvs, getPreviewEnv, upsertPreviewEnv, deletePreviewEnv, ensurePreviewEnv, stopPreviewEnv, resolvePreviewId,
  listStackProfiles, upsertStackProfile, deleteStackProfile,
} from "../org/preview-envs.js";
import { listRepoBranches } from "../org/preview-stage.js";

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
  description: "미리보기(org_preview_env) 목록 — 담당자·프로젝트·레포·작업폴더·kind(work|stage)·backing(shared-proxy|throwaway|existing-ref)·상태(running|preparing|error|stopped)·포트. 주소 = /preview/<id>/.",
  scope: "code", // 쓰는 사람은 **작업자**다 — 관리자 전용으로 잠그면 정작 화면을 봐야 할 사람이 못 쓴다.
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
    "throwaway 는 stack_profile 필요. **project_id+repo 만 주면 충분** — 작업 폴더 생성·빌드는 ensure 가 자동으로 한다. stage 는 member_branches/base_ref/merge_trigger.",
  scope: "code",
  input: {
    id: z.string().optional(), // 안 주면 같은 프로젝트·레포의 기존 미리보기를 재사용하거나 새로 만든다
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
    // id 는 선택 — 안 주면 같은 프로젝트·레포의 기존 미리보기를 재사용하고, 없으면 읽을 만한 아이디를 만든다.
    const id = input.id ? pid(input.id) : await resolvePreviewId(input);
    return { env: await upsertPreviewEnv({ ...input, id }, actor) };
  },
};

const del: Capability = {
  name: "preview_env_delete",
  title: "프리뷰 환경 삭제",
  description: "미리보기 등록을 삭제(throwaway 로 띄운 서버는 함께 정지). 작업 폴더와 코드는 그대로 남는다.",
  scope: "code",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/delete"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => deletePreviewEnv(pid(input.id)),
};

const ensure: Capability = {
  name: "preview_env_ensure",
  title: "프리뷰 환경 띄우기",
  description: "미리보기를 지금 띄운다 — 작업 폴더가 없으면 만들고(provision) 스택 프로필의 build_cmd 로 빌드까지 한다. " +
    "준비가 길면 **status='preparing' 을 먼저 돌려주고 백그라운드로 진행**하므로(요청을 막지 않는다) 목록을 폴링해 running 을 확인하라. 반환 {status, url, action, port?}.",
  scope: "code",
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
  description: "미리보기를 끈다(stopped) — throwaway 로 띄운 서버는 종료(SIGTERM), 정적·existing-ref 는 상태만 바뀐다.",
  scope: "code",
  input: { id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/preview-envs/:id/stop"], parse: (req) => ({ id: req.params?.id }) }] },
  handler: async (input: any) => {
    const p = await getPreviewEnv(pid(input.id));
    if (!p) throw new HttpError(404, "no such preview env: " + input.id);
    return stopPreviewEnv(p);
  },
};

// ── 레포 브랜치 목록 — stage 의 '합쳐서 볼 작업'을 **타이핑이 아니라 고르게** 하기 위한 조회. ──
//  base 클론에서 fetch 후 원격 브랜치를 최근 갱신순으로. 읽기 전용이고 브랜치명·커밋 제목만 나가므로 scope=code.
const branchList: Capability = {
  name: "repo_branch_list",
  title: "레포 브랜치 목록",
  description:
    "등록된 레포의 원격 브랜치를 최근 갱신순으로 — [{name, updated_at, author, subject}]. " +
    "stage 미리보기의 member_branches 나 base_ref 를 고를 때 쓴다(브랜치명을 외워서 적지 않게).",
  scope: "code",
  input: { repo: z.string().max(100), limit: z.number().int().min(1).max(1000).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/repos/:repo/branches"], parse: (req) => ({ repo: req.params?.repo, limit: numOpt(req.query?.limit) }) }],
  },
  handler: async (input: any) => {
    const repo = String(input.repo ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)) throw new HttpError(400, "레포 이름 형식이 올바르지 않습니다");
    try { return { branches: await listRepoBranches(repo, input.limit ?? 300) }; }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  },
};

// ── stack_profile (어떻게 띄우나 — throwaway backing 이 참조. 비개발자는 프리셋을 드롭다운으로 고른다) ──
const spList: Capability = {
  name: "stack_profile_list",
  title: "스택 프로필 목록",
  description: "스택 프로필(org_stack_profile) 목록 — '어떻게 띄우나'(build_cmd·start_cmd·port_env·env·healthcheck). 미리보기를 만들 때 고르거나, 비우면 레포로 자동 매칭된다.",
  scope: "code", // 조회는 작업자도 필요(만들 때 고른다). 정의(set/delete)는 셸 명령을 담으므로 admin.
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/stack-profiles"], parse: () => ({}) }] },
  handler: async () => ({ profiles: await listStackProfiles() }),
};

const spSet: Capability = {
  name: "stack_profile_set",
  title: "스택 프로필 생성/수정",
  description:
    "스택 프로필 upsert(id 기준). static_only=true 면 정적(shared-proxy 용, start_cmd 불요). false 면 start_cmd 를 워크트리에서 실행하고 " +
    "port_env(기본 PORT)로 할당 포트를 주입, env_json 을 추가 env 로 넣는다. build_cmd 는 띄우기 전 빌드. healthcheck_path 로 기동 확인.",
  scope: "admin", // start_cmd·build_cmd = 셸 명령 → **정의는 관리자만**(사용은 code).
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

export const previewEnvCapabilities: Capability[] = [list, set, del, ensure, stop, branchList, spList, spSet, spDel];

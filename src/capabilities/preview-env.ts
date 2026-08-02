// 미리보기 capability — org_preview_env CRUD + ensure/stop. REST+MCP. #1036.
//  ⚠ 사용(list/set/ensure/stop/delete)은 `code`(작업자) — 관리자 전용으로 잠그면 정작 화면을 확인해야 할 사람이 못 쓴다.
//  '어떻게 띄우나' 정의(stack_profile_*)는 권한 축이 달라 stack-profiles.ts 로 분리했다(#1313 R25).
//   레포 브랜치 조회(repo_branch_list)는 repo_* 군집인 context.ts 로 갔다(등록 자리는 index.ts 가 유지).
//  managed-session.ts 패턴. registry(index.ts all[])에 넣으면 web.ts restMounts 가 REST 를, registerMcpCapabilities 가 MCP 를 자동 생성.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listPreviewEnvs, getPreviewEnv, upsertPreviewEnv, deletePreviewEnv, ensurePreviewEnv, stopPreviewEnv, resolvePreviewId,
} from "../preview/preview-envs.js";
import { gatewayUrl } from "../gateway-url.js";

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
  description: "미리보기(org_preview_env) 목록 — 담당자·프로젝트·레포·작업폴더·kind(work|stage)·backing(shared-proxy|throwaway|existing-ref)·상태(running|preparing|error|stopped)·포트. " +
    "각 항목의 **url 은 절대 주소**(`<게이트웨이>/preview/<id>/ui/`)라 사람에게 그대로 전달하면 바로 열린다 — 뒤에 해시 라우트를 붙여도 된다(`…/ui/#/knowledge`).",
  scope: "code", // 쓰는 사람은 **작업자**다 — 관리자 전용으로 잠그면 정작 화면을 봐야 할 사람이 못 쓴다.
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/preview-envs"], parse: () => ({}) }] },
  // url 을 여기서 붙인다(#1169) — 목록만 보고도 사람에게 줄 링크가 나와야 한다. 예전엔 id 로 조립해야 했고,
  //  그러려면 에이전트가 게이트웨이 주소를 따로 캐야 했다(관리탭 전체를 쏟는 org_overview 가 유일한 경로였다).
  handler: async () => {
    const envs = await listPreviewEnvs();
    const base = await gatewayUrl();
    return { envs: envs.map((e) => ({ ...e, url: (base ?? "") + "/preview/" + e.id + "/ui/" })) };
  },
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
    "준비가 길면 **status='preparing' 을 먼저 돌려주고 백그라운드로 진행**하므로(요청을 막지 않는다) 목록을 폴링해 running 을 확인하라. 반환 {status, url, action, port?} — " +
    "url 은 **절대 주소**(`<게이트웨이>/preview/<id>/ui/`)라 사람에게 그대로 전달하면 바로 열린다(뒤에 해시 라우트를 붙여도 된다).",
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

export const previewEnvCapabilities: Capability[] = [list, set, del, ensure, stop];

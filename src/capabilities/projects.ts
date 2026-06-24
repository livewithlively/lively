// 라이블리 자체 프로젝트 capability — 사람이 :8080 웹에서 선언·관리하는 독립 프로젝트
//  (ClickUp 미러 과업 W·activity 작업과 분리). scope='memory'(조직 공유 작업/지식 평면과 동일 — 사람·AI 쓰기).
//  REST 전용(웹 프로젝트 탭 전용 — MCP 표면 불변). status: 'active'(진행중) | 'done'(완료) 토글이 핵심.
//  생성 시 workspace/project/<이름> 폴더 자동 생성 + 팀원(project_member) 저장. 상세 페이지가 폴더·터미널·타임라인을 엮는다.
import { z } from "zod";
import {
  listProjects, createProject, setProjectStatus, getProject,
  listProjectMembers, setProjectMembers, setMemberStatus, isProjectMember,
} from "../org/store.js";
import { createProjectFolder, moveProjectFolder, PROJECT_SUBDIR, LEGACY_SUBDIR } from "../project-fs.js";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";

const projectList: Capability = {
  name: "project_list",
  title: "프로젝트 목록",
  description: "라이블리 자체 프로젝트를 진행중(active)·완료(done) 모두 최신순으로 조회한다. 웹 프로젝트 탭 전용.",
  scope: "memory",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/projects"], parse: () => ({}) }] },
  handler: async (_input: any, user: any, ctx: any) => ({ projects: await listProjects(ctx?.actor ?? user?.userId ?? null) }),
};

const projectGet: Capability = {
  name: "project_get",
  title: "프로젝트 상세",
  description: "프로젝트 1건 + 팀원 목록 + 폴더 경로. 프로젝트 상세 페이지 전용.",
  scope: "memory",
  input: { id: z.number().int() },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/projects/:id"],
      parse: (req) => {
        const id = Number(req.params?.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효한 프로젝트 id 가 필요합니다");
        return { id };
      },
    }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const id = Number(input.id);
    const project = await getProject(id);
    if (!project) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    if (!(await isProjectMember(id, ctx?.actor ?? user?.userId ?? null))) throw new HttpError(403, "초대받은 팀원만 볼 수 있습니다");
    return { project, members: await listProjectMembers(id) };
  },
};

const projectCreate: Capability = {
  name: "project_create",
  title: "프로젝트 생성",
  description: "새 프로젝트를 만든다(진행중으로 시작) — workspace/project/<이름> 폴더 자동 생성 + 팀원 저장. 웹 전용.",
  scope: "memory",
  input: {
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    members: z.array(z.string()).optional(),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/projects"],
      parse: (req) => {
        const name = String(req.body?.name ?? "").trim();
        if (!name) throw new HttpError(400, "프로젝트 이름이 필요합니다");
        return {
          name,
          description: req.body?.description ? String(req.body.description) : undefined,
          members: Array.isArray(req.body?.members) ? req.body.members.map((x: unknown) => String(x)) : [],
        };
      },
    }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const folder = await createProjectFolder(input.name); // 폴더 먼저 — 실패 시 DB 미생성
    const project = await createProject(
      { name: input.name, description: input.description ?? null, folder }, writeCtx,
    );
    const member_ids = await setProjectMembers(project.id, Array.isArray(input.members) ? input.members : [], writeCtx);
    return { project, member_ids };
  },
};

const projectSetStatus: Capability = {
  name: "project_set_status",
  title: "프로젝트 상태 변경",
  description: "프로젝트를 진행중(active)↔완료(done)로 토글한다. 완료 시 완료시각 기록. 웹 전용.",
  scope: "memory",
  input: {
    id: z.number().int(),
    status: z.enum(["active", "done"]),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/projects/:id/status"],
      parse: (req) => {
        const id = Number(req.params?.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효한 프로젝트 id 가 필요합니다");
        const status = String(req.body?.status ?? "");
        if (status !== "active" && status !== "done") throw new HttpError(400, "status 는 'active' 또는 'done' 이어야 합니다");
        return { id, status };
      },
    }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const id = Number(input.id);
    const status = input.status;
    // 완료 시 폴더를 legacy-project/ 로 보관 이동, 진행중 복귀 시 project/ 로 되돌림(folder 갱신).
    const cur = await getProject(id);
    if (!cur) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    let newFolder: string | undefined;
    if (cur.folder) {
      const inProject = cur.folder.startsWith(PROJECT_SUBDIR + "/");
      const inLegacy = cur.folder.startsWith(LEGACY_SUBDIR + "/");
      if (status === "done" && inProject) newFolder = await moveProjectFolder(cur.folder, true);
      else if (status === "active" && inLegacy) newFolder = await moveProjectFolder(cur.folder, false);
    }
    return { project: await setProjectStatus(id, status, writeCtx, newFolder) };
  },
};

const projectSetMembers: Capability = {
  name: "project_set_members",
  title: "프로젝트 팀원 변경",
  description: "프로젝트 팀원(project_member)을 member_id 배열로 통째 교체. 웹 전용.",
  scope: "memory",
  input: { id: z.number().int(), members: z.array(z.string()) },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/projects/:id/members"],
      parse: (req) => {
        const id = Number(req.params?.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "유효한 프로젝트 id 가 필요합니다");
        return { id, members: Array.isArray(req.body?.members) ? req.body.members.map((x: unknown) => String(x)) : [] };
      },
    }],
  },
  handler: async (input: any, user: any, ctx: any) => ({
    member_ids: await setProjectMembers(
      Number(input.id),
      Array.isArray(input.members) ? input.members : [],
      { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" },
    ),
  }),
};

// 본인 상태메시지 설정 — actor(토큰 신원) 본인만. 프로필 밑 '현재 상태' 공유.
const meStatusSet: Capability = {
  name: "me_status_set",
  title: "내 상태메시지 설정",
  description: "본인 프로필의 상태메시지(현재 상태)를 설정한다. 본인만. 웹 전용.",
  scope: "memory",
  input: { message: z.string().max(200) },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/me/status"], parse: (req) => ({ message: String(req.body?.message ?? "") }) }],
  },
  handler: async (input: any, user: any, ctx: any) =>
    setMemberStatus(ctx?.actor ?? user?.userId ?? null, input.message ?? ""),
};

export const projectCapabilities: Capability[] = [
  projectList, projectGet, projectCreate, projectSetStatus, projectSetMembers, meStatusSet,
];

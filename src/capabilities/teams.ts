// v6 team capability — 팀(스쿼드/사일로) CRUD + 멤버 + 카테고리 오너십.
//  ★오너십 ≠ 접근권한: 팀↔카테고리는 표면화(프로젝트/위키 탭)·주입의 '소프트 렌즈'일 뿐(권한은 scopes[]/projects[] 별도).
//  scope='context'(category authoring 계열과 동일 — 도메인/맥락 저작 권한). 읽기(team_list/get)만 MCP 노출(에이전트가
//  '이 도메인 누가 소유?' 조회), 쓰기(create/update/delete/members/owner)는 REST/웹 전용(조직 구조 변경은 사람) = expose.mcp:false.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import {
  listTeams, getTeam, createTeam, updateTeam, deleteTeam,
  setTeamMembers, setTeamCategory, removeTeamCategory, setCategoryOwner,
} from "../v6/team-store.js";

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseId(v: unknown): number {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 가 올바르지 않습니다");
  return id;
}
function parseKey(v: unknown): string {
  const key = String(v ?? "").trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new HttpError(400, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return key;
}
function writeCtxOf(user: any, ctx: any) {
  return { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
}

const teamList: Capability = {
  name: "team_list",
  title: "팀 목록",
  description: "조직 내 팀(스쿼드/사일로) 목록 + 팀원수·카테고리수. 팀은 카테고리 오너십을 통해 맥락(지식·프로젝트·도메인)을 귀속한다.",
  scope: "context",
  input: { includeArchived: z.boolean().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/teams"],
      parse: (req) => ({ includeArchived: req.query?.includeArchived === "1" || req.query?.includeArchived === "true" }) }],
  },
  handler: async (input: any) => ({ teams: await listTeams({ includeArchived: !!input.includeArchived }) }),
};

const teamGet: Capability = {
  name: "team_get",
  title: "팀 상세",
  description: "팀 1건 + 팀원(role)·소유/이해관계 카테고리 조회.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/teams/:id"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any) => {
    const team = await getTeam(input.id);
    if (!team) throw new HttpError(404, `팀 #${input.id} 없음`);
    return { team };
  },
};

const teamCreate: Capability = {
  name: "team_create",
  title: "팀 생성",
  description: "팀(스쿼드/사일로)을 만든다. body_md 는 팀 charter(주입될 '팀 층'). 웹 전용.",
  scope: "context",
  input: {
    key: z.string(), name: z.string().optional(), description: z.string().optional(),
    body_md: z.string().optional(), lead_member_id: z.string().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          key: parseKey(b.key),
          name: b.name != null ? String(b.name) : undefined,
          description: b.description != null ? String(b.description) : undefined,
          body_md: b.body_md != null ? String(b.body_md) : undefined,
          lead_member_id: b.lead_member_id ? String(b.lead_member_id) : undefined,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => ({ team: await createTeam(input, writeCtxOf(user, ctx)) }),
};

const teamUpdate: Capability = {
  name: "team_update",
  title: "팀 수정",
  description: "팀 이름·설명·charter(body_md)·리드·상태(active/archived)를 수정. 웹 전용.",
  scope: "context",
  input: {
    id: z.number().int().positive(),
    key: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
    body_md: z.string().optional(), lead_member_id: z.string().nullable().optional(),
    state: z.enum(["active", "archived"]).optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          key: b.key != null ? parseKey(b.key) : undefined,
          name: b.name != null ? String(b.name) : undefined,
          description: b.description != null ? String(b.description) : undefined,
          body_md: b.body_md != null ? String(b.body_md) : undefined,
          // 명시적 빈값/null → 리드 해제(null), 미포함 → 보존(undefined).
          lead_member_id: "lead_member_id" in b ? (b.lead_member_id ? String(b.lead_member_id) : null) : undefined,
          state: b.state === "archived" || b.state === "active" ? b.state : undefined,
        };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const { id, ...patch } = input;
    return { team: await updateTeam(id, patch, writeCtxOf(user, ctx)) };
  },
};

const teamDelete: Capability = {
  name: "team_delete",
  title: "팀 삭제",
  description: "팀을 삭제한다(팀원·카테고리 오너십 cascade 해제 — 카테고리 자체는 남음). 감사 스냅샷 보존. 웹 전용.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: any, user: any, ctx: any) => deleteTeam(input.id, writeCtxOf(user, ctx)),
};

const teamSetMembers: Capability = {
  name: "team_set_members",
  title: "팀원 설정",
  description: "팀원을 전체 교체한다. members=[{member_id, role}]. role: lead|pm|dev|design|member(표시 메타). 웹 전용.",
  scope: "context",
  input: {
    id: z.number().int().positive(),
    members: z.array(z.object({ member_id: z.string(), role: z.string().optional() })),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams/:id/members"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const arr = Array.isArray(b.members) ? b.members : [];
        const members = arr.map((m: any) => ({ member_id: String(m?.member_id ?? ""), role: m?.role != null ? String(m.role) : undefined }));
        return { id: parseId(req.params?.id), members };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => ({ members: await setTeamMembers(input.id, input.members, writeCtxOf(user, ctx)) }),
};

// 팀-중심 카테고리 연결 — stakeholder 추가/해제(owner 는 category_set_owner 권장). relation='none' → 제거. 웹 전용.
const teamSetCategory: Capability = {
  name: "team_set_category",
  title: "팀 카테고리 연결",
  description: "팀↔카테고리 관계를 설정한다. relation=owner|stakeholder|none(제거). owner 는 카테고리당 1팀(이양). 웹 전용.",
  scope: "context",
  input: {
    id: z.number().int().positive(),
    category_id: z.number().int().positive(),
    relation: z.enum(["owner", "stakeholder", "none"]),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams/:id/categories"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const relation = String(b.relation ?? "");
        if (!["owner", "stakeholder", "none"].includes(relation)) throw new HttpError(400, "relation 은 owner|stakeholder|none");
        return { id: parseId(req.params?.id), category_id: parseId(b.category_id), relation };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const wc = writeCtxOf(user, ctx);
    if (input.relation === "none") await removeTeamCategory(input.id, input.category_id, wc);
    else await setTeamCategory(input.id, input.category_id, input.relation, wc);
    return { ok: true };
  },
};

// 카테고리-중심 오너 배정(어드민 분류체계관리 드롭다운) — team_id=null 이면 오너 해제. 웹 전용.
const categorySetOwner: Capability = {
  name: "category_set_owner",
  title: "카테고리 오너 팀 설정",
  description: "카테고리의 오너 팀을 설정/해제한다(카테고리당 1팀, 이양). team_id=null 이면 해제. 표면화·주입의 '우리 팀' 기준. 웹 전용.",
  scope: "context",
  input: {
    id: z.number().int().positive(),
    team_id: z.number().int().positive().nullable(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id/owner"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const teamId = b.team_id == null || b.team_id === "" ? null : parseId(b.team_id);
        return { id: parseId(req.params?.id), team_id: teamId };
      } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    await setCategoryOwner(input.id, input.team_id, writeCtxOf(user, ctx));
    return { ok: true, category_id: input.id, owner_team_id: input.team_id };
  },
};

export const teamCapabilities: Capability[] = [
  teamList, teamGet, teamCreate, teamUpdate, teamDelete, teamSetMembers, teamSetCategory, categorySetOwner,
];

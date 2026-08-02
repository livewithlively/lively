// v6 team capability — 팀(스쿼드/사일로) CRUD + 멤버 + 카테고리 오너십.
//  ★오너십 ≠ 접근권한: 팀↔카테고리는 표면화(프로젝트/위키 탭)·주입의 '소프트 렌즈'일 뿐(권한은 scopes[]/projects[] 별도).
//  scope='context'(category authoring 계열과 동일 — 도메인/맥락 저작 권한). 읽기(team_list/get)만 MCP 노출(에이전트가
//  '이 도메인 누가 소유?' 조회), 쓰기(create/update/delete/members/owner)는 REST/웹 전용(조직 구조 변경은 사람) = expose.mcp:false.
// ⚠ #1291 v2 — 팀 **쓰기**(생성·수정·삭제·멤버·카테고리)는 조건부로 admin 전용이다(읽기는 종전대로 context).
//  팀이 가시성 주체가 되면서(리스트·폴더·지식 grant 의 대상) 팀 편집이 곧 접근권한 편집이 됐다.
//  전 멤버(context)가 팀 멤버를 바꿀 수 있으면 **자기를 임의 팀에 넣어 잠긴 맥락을 여는** 셀프가입이 된다.
//  (오너십 렌즈였을 땐 무해했다 — 축이 바뀌면 권한도 따라와야 한다.)
//  ⚠ 다만 **무조건** 좁히지 않는다. 이 기능의 전제는 "아무도 안 잠그면 동작 변화 0" 이고, 팀 grant 가 하나도
//   없는 조직에서 팀 편집은 여전히 그냥 조직도 편집이다(실측: 고객사 A 팀 0개 / 라이블리 6개, context 보유 66/66).
//   그래서 db self(tools/db.ts)와 **같은 규칙**을 쓴다 — 팀을 대상으로 한 grant 가 하나라도 생기는 순간부터 admin.
import { z } from "zod";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import {
  listTeams, getTeam, createTeam, updateTeam, deleteTeam,
  setTeamMembers, setTeamCategory, removeTeamCategory, setCategoryOwner, anyTeamGrant,
} from "../v6/team-store.js";

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseKey(v: unknown): string {
  const key = String(v ?? "").trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new HttpError(400, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return key;
}
// 팀이 실제로 접근권한의 주체가 됐나(판정은 team-store.anyTeamGrant) — 팀 grant 가 하나라도 있으면 팀 편집 = 권한 편집이다.
//  판정 불가면 닫는 쪽(admin 요구). 30초 캐시 — 쓰기 경로라 호출 빈도가 낮다.
let tgAt = 0, tgAny = false;
async function anyTeamGrantCached(): Promise<boolean> {
  const now = Date.now();
  if (now - tgAt < 30_000) return tgAny;
  try {
    tgAny = await anyTeamGrant(); tgAt = now;
  } catch { tgAny = true; }
  return tgAny;
}

/** 팀 쓰기 게이트 — grant 가 생긴 뒤로는 admin 만. 각 쓰기 핸들러 첫 줄에서 부른다. */
async function requireTeamWrite(user: LivelyUser): Promise<void> {
  if ((user?.scopes ?? []).includes("admin")) return;
  if (!(await anyTeamGrantCached())) return;   // 팀이 아직 권한 주체가 아니면 종전대로(context 로 충분)
  throw new HttpError(403,
    "팀 편집은 관리자만 가능합니다 — 이 조직에는 팀을 대상으로 지정한 공개범위가 있어, "
    + "팀 멤버 변경이 곧 접근권한 변경입니다(자기를 넣어 잠긴 맥락을 여는 것을 막습니다).");
}

function writeCtxOf(user: LivelyUser, ctx?: CapabilityCtx) {
  return { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
}

const teamListInput = { includeArchived: z.boolean().optional() };
type TeamListInput = z.infer<z.ZodObject<typeof teamListInput>>;
const teamList: Capability = {
  name: "team_list",
  title: "팀 목록",
  description: "조직 내 팀(스쿼드/사일로) 목록 + 팀원수·카테고리수. 팀은 카테고리 오너십을 통해 맥락(지식·프로젝트·도메인)을 귀속한다.",
  scope: "context",
  input: teamListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/teams"],
      parse: (req) => ({ includeArchived: req.query?.includeArchived === "1" || req.query?.includeArchived === "true" }) }],
  },
  handler: async (input: TeamListInput) => ({ teams: await listTeams({ includeArchived: !!input.includeArchived }) }),
};

const teamGetInput = { id: z.number().int().positive() };
type TeamGetInput = z.infer<z.ZodObject<typeof teamGetInput>>;
const teamGet: Capability = {
  name: "team_get",
  title: "팀 상세",
  description: "팀 1건 + 팀원(role)·소유/이해관계 카테고리 조회.",
  scope: "context",
  input: teamGetInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/teams/:id"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: TeamGetInput) => {
    const team = await getTeam(input.id);
    if (!team) throw new HttpError(404, `팀 #${input.id} 없음`);
    return { team };
  },
};

const teamCreateInput = {
  key: z.string(), name: z.string().optional(), description: z.string().optional(),
  body_md: z.string().optional(), lead_member_id: z.string().optional(),
};
type TeamCreateInput = z.infer<z.ZodObject<typeof teamCreateInput>>;
const teamCreate: Capability = {
  name: "team_create",
  title: "팀 생성",
  description: "팀(스쿼드/사일로)을 만든다. body_md 는 팀 charter(주입될 '팀 층'). 웹 전용.",
  scope: "context",
  input: teamCreateInput,
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
  handler: async (input: TeamCreateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    return { team: await createTeam(input, writeCtxOf(user, ctx)) };
  },
};

const teamUpdateInput = {
  id: z.number().int().positive(),
  key: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
  body_md: z.string().optional(), lead_member_id: z.string().nullable().optional(),
  state: z.enum(["active", "archived"]).optional(),
};
type TeamUpdateInput = z.infer<z.ZodObject<typeof teamUpdateInput>>;
const teamUpdate: Capability = {
  name: "team_update",
  title: "팀 수정",
  description: "팀 이름·설명·charter(body_md)·리드·상태(active/archived)를 수정. 웹 전용.",
  scope: "context",
  input: teamUpdateInput,
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
  handler: async (input: TeamUpdateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    const { id, ...patch } = input;
    return { team: await updateTeam(id, patch, writeCtxOf(user, ctx)) };
  },
};

const teamDeleteInput = { id: z.number().int().positive() };
type TeamDeleteInput = z.infer<z.ZodObject<typeof teamDeleteInput>>;
const teamDelete: Capability = {
  name: "team_delete",
  title: "팀 삭제",
  description: "팀을 삭제한다(팀원·카테고리 오너십 cascade 해제 — 카테고리 자체는 남음). 감사 스냅샷 보존. 웹 전용.",
  scope: "context",
  input: teamDeleteInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/teams/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: TeamDeleteInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    return deleteTeam(input.id, writeCtxOf(user, ctx));
  },
};

const teamSetMembersInput = {
  id: z.number().int().positive(),
  members: z.array(z.object({ member_id: z.string(), role: z.string().optional() })),
};
type TeamSetMembersInput = z.infer<z.ZodObject<typeof teamSetMembersInput>>;
const teamSetMembers: Capability = {
  name: "team_set_members",
  title: "팀원 설정",
  description: "팀원을 전체 교체한다. members=[{member_id, role}]. role: lead|pm|dev|design|member(표시 메타). 웹 전용.",
  scope: "context",
  input: teamSetMembersInput,
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
  handler: async (input: TeamSetMembersInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    return { members: await setTeamMembers(input.id, input.members, writeCtxOf(user, ctx)) };
  },
};

// 팀-중심 카테고리 연결 — stakeholder 추가/해제(owner 는 category_set_owner 권장). relation='none' → 제거. 웹 전용.
const teamSetCategoryInput = {
  id: z.number().int().positive(),
  category_id: z.number().int().positive(),
  relation: z.enum(["owner", "stakeholder", "none"]),
};
type TeamSetCategoryInput = z.infer<z.ZodObject<typeof teamSetCategoryInput>>;
const teamSetCategory: Capability = {
  name: "team_set_category",
  title: "팀 카테고리 연결",
  description: "팀↔카테고리 관계를 설정한다. relation=owner|stakeholder|none(제거). owner 는 카테고리당 1팀(이양). 웹 전용.",
  scope: "context",
  input: teamSetCategoryInput,
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
  handler: async (input: TeamSetCategoryInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    const wc = writeCtxOf(user, ctx);
    if (input.relation === "none") await removeTeamCategory(input.id, input.category_id, wc);
    else await setTeamCategory(input.id, input.category_id, input.relation, wc);
    return { ok: true };
  },
};

// 카테고리-중심 오너 배정(어드민 분류체계관리 드롭다운) — team_id=null 이면 오너 해제. 웹 전용.
const categorySetOwnerInput = {
  id: z.number().int().positive(),
  team_id: z.number().int().positive().nullable(),
};
type CategorySetOwnerInput = z.infer<z.ZodObject<typeof categorySetOwnerInput>>;
const categorySetOwner: Capability = {
  name: "category_set_owner",
  title: "카테고리 오너 팀 설정",
  description: "카테고리의 오너 팀을 설정/해제한다(카테고리당 1팀, 이양). team_id=null 이면 해제. 표면화·주입의 '우리 팀' 기준. 웹 전용.",
  scope: "context",
  input: categorySetOwnerInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id/owner"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const teamId = b.team_id == null || b.team_id === "" ? null : parseId(b.team_id);
        return { id: parseId(req.params?.id), team_id: teamId };
      } }],
  },
  handler: async (input: CategorySetOwnerInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await setCategoryOwner(input.id, input.team_id, writeCtxOf(user, ctx));
    return { ok: true, category_id: input.id, owner_team_id: input.team_id };
  },
};

export const teamCapabilities: Capability[] = [
  teamList, teamGet, teamCreate, teamUpdate, teamDelete, teamSetMembers, teamSetCategory, categorySetOwner,
];

// v6 team capability — 팀(스쿼드/사일로) CRUD + 멤버.
//  ⚠ #4233(원준 2026-09-25): 분류를 팀에 할당하는 개념(team_set_category · category_set_owner · 소유/이해관계 분류)은 폐기했다.
//  scope='context'. 읽기(team_list/get)만 MCP 노출, 쓰기(create/update/delete/members)는 REST/웹 전용(조직 구조 변경은 사람) = expose.mcp:false.
// ⚠ #1291 v2 — 팀 **쓰기**(생성·수정·삭제·멤버)는 조건부로 admin 전용이다(읽기는 종전대로 context).
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
  setTeamMembers, anyTeamGrant, setTeamKind, setTeamAccess, isTeamKind, type TeamKind, type TeamRow,
} from "../v6/team-store.js";
import {
  PERMISSIONS, PERMISSION_INFO, ROLES, grantsOf, isPermission, isRole, permits, sanitizeGrants, teamGrants, ungivable,
  type Grants, type Role,
} from "../auth/permissions.js";

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 종류 입력 — 없으면 undefined(그대로), 모르는 값이면 400. */
function parseKind(v: unknown): TeamKind | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isTeamKind(v)) throw new HttpError(400, "kind 는 team|group 입니다");
  return v;
}
//  ── 팀이 주는 권한(#5799) ── 팀의 구성원이 함께 받는 역할(access_role) · 개별 권한(access_grants).
//   팀에 권한을 싣는 것은 그 팀 전원에게 권한을 주는 것이다 — 그래서 ① 관리 고치기가 있어야 하고(팀 grant 가 아직 없어 팀 편집이 열려 있는 조직에서도)
//   ② 내가 갖지 않은 위험 권한의 고치기는 팀으로도 못 준다(구성원 역할을 줄 때와 같은 규칙 — auth/permissions.ts ungivable).
//   권한이 실린 팀에 사람을 **새로 넣는 것**도 주는 것이라 ②를 건다.
interface AccessInput { role?: Role | null; grants?: Grants }
/** 요청 몸통에서 팀 권한 칸을 꺼낸다 — 입력 스키마와 같은 이름(access_role · access_grants)으로 돌려준다. 주지 않은 칸은 싣지 않는다(= 그대로). */
function parseAccess(b: Record<string, unknown>): { access_role?: Role | null; access_grants?: Grants } {
  const out: { access_role?: Role | null; access_grants?: Grants } = {};
  if ("access_role" in b && b.access_role !== undefined) {
    if (b.access_role !== null && b.access_role !== "" && !isRole(b.access_role)) throw new HttpError(400, `access_role 은 ${ROLES.join("|")} 중 하나거나 null 입니다`);
    out.access_role = b.access_role === "" ? null : (b.access_role as Role | null);
  }
  if ("access_grants" in b && b.access_grants !== undefined) {
    const g = b.access_grants;
    if (g === null) out.access_grants = {};
    else {
      if (typeof g !== "object" || Array.isArray(g)) throw new HttpError(400, "access_grants 는 {권한: \"read\"|\"write\"} 객체여야 합니다");
      for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
        if (!isPermission(k)) throw new HttpError(400, `모르는 권한: ${k} — ${PERMISSIONS.join("|")}`);
        if (v !== "read" && v !== "write") throw new HttpError(400, `권한 ${k} 의 수준은 read|write 입니다`);
      }
      out.access_grants = sanitizeGrants(g);
    }
  }
  return out;
}
/** 입력(스키마 이름)에서 «바꿀 권한» 을 꺼낸다 — access_grants null 은 비우기. */
const accessInputOf = (input: { access_role?: Role | null; access_grants?: Record<string, string> | null }): AccessInput => ({
  ...(input.access_role === undefined ? {} : { role: input.access_role }),
  ...(input.access_grants === undefined ? {} : { grants: sanitizeGrants(input.access_grants ?? {}) }),
});
const accessOf = (t: Pick<TeamRow, "access_role" | "access_grants"> | undefined | null): { role: Role | null; grants: Grants } =>
  ({ role: isRole(t?.access_role) ? t.access_role : null, grants: sanitizeGrants(t?.access_grants) });
/** 이 권한 묶음을 내가 줄 수 있나 — 못 주면 403(어느 권한 때문인지 화면 이름으로). */
function assertGivable(user: LivelyUser, giving: Grants): void {
  const blocked = ungivable(grantsOf(user), giving);
  if (blocked.length) throw new HttpError(403, `${blocked.map((p) => PERMISSION_INFO[p].label).join(" · ")} 고치기 권한은 그 권한을 가진 사람만 줄 수 있습니다`);
}
/** 팀의 권한을 바꾼다(준 것만 · 나머지는 그대로). 바뀐 팀 행을 돌려준다. 준 것이 없으면 null. */
async function applyAccess(id: number, input: AccessInput, user: LivelyUser, ctx?: CapabilityCtx): Promise<TeamRow | null> {
  if (input.role === undefined && input.grants === undefined) return null;
  if (!permits(user, "admin", { perm: "admin", level: "write" })) throw new HttpError(403, "팀에 권한을 싣는 것은 관리자만 할 수 있습니다 — 그 팀의 구성원 전원이 그 권한을 받습니다");
  const now = accessOf(await getTeam(id));
  const next = { role: input.role === undefined ? now.role : input.role, grants: input.grants === undefined ? now.grants : input.grants };
  assertGivable(user, teamGrants(next));
  const row = await setTeamAccess(id, next, writeCtxOf(user, ctx));
  tgAt = 0;   // 팀이 방금 권한 주체가 됐을 수 있다 — 팀 쓰기 게이트의 캐시를 버린다
  return row;
}
const ACCESS_ROLE_DESC = "이 팀의 구성원이 함께 받는 역할(guest|member|admin|owner) — 역할을 받은 구성원에게만 더해진다(옛 방식 구성원에게는 효과 없음). null = 없음. 관리자만";
const ACCESS_GRANTS_DESC = "이 팀의 구성원이 함께 받는 개별 권한 {권한: read|write} — 권한: content|pipeline|external|code|session|run|db|admin|secrets|harness. null · {} = 없음. 관리자만";

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
  description: "조직 내 팀(스쿼드/사일로) 목록 + 팀원수.",
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
  description: "팀 1건 + 팀원(role) 조회.",
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

const KIND_DESC = "종류 — team = 소속 팀(조직도 · 프로필에 보인다) / group = 권한 그룹(접근을 묶으려고 만든 것 · 권한 화면에만 보인다). 접근 판정은 같다";
const teamCreateInput = {
  key: z.string(), name: z.string().optional(), description: z.string().optional(),
  body_md: z.string().optional(), lead_member_id: z.string().optional(),
  kind: z.enum(["team", "group"]).optional().describe(`${KIND_DESC}. 생략 = team`),
  access_role: z.enum(ROLES).nullable().optional().describe(ACCESS_ROLE_DESC),
  access_grants: z.record(z.enum(["read", "write"])).nullable().optional().describe(ACCESS_GRANTS_DESC),
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
          kind: parseKind(b.kind),
          ...parseAccess(b),
        };
      } }],
  },
  handler: async (input: TeamCreateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    const { kind, access_role: _ar, access_grants: _ag, ...rest } = input;
    const a = accessInputOf(input);
    //  권한을 실어 만드는 팀이면 만들기 전에 자격을 본다(팀만 생기고 권한 저장이 거절되는 반쪽 상태를 만들지 않는다).
    if (a.role !== undefined || a.grants !== undefined) {
      if (!permits(user, "admin", { perm: "admin", level: "write" })) throw new HttpError(403, "팀에 권한을 싣는 것은 관리자만 할 수 있습니다 — 그 팀의 구성원 전원이 그 권한을 받습니다");
      assertGivable(user, teamGrants({ role: a.role ?? null, grants: a.grants ?? {} }));
    }
    const team = await createTeam(rest, writeCtxOf(user, ctx));
    //  종류 · 권한은 따로 쓴다(team-store.setTeamKind 머리말). 소속 팀(기본값)이면 쓸 것이 없다.
    const kinded = kind && kind !== "team" ? await setTeamKind(team.id, kind, writeCtxOf(user, ctx)) : { ...team, kind: "team" as const };
    return { team: (await applyAccess(team.id, a, user, ctx)) ?? kinded };
  },
};

const teamUpdateInput = {
  id: z.number().int().positive(),
  key: z.string().optional(), name: z.string().optional(), description: z.string().optional(),
  body_md: z.string().optional(), lead_member_id: z.string().nullable().optional(),
  state: z.enum(["active", "archived"]).optional(),
  kind: z.enum(["team", "group"]).optional().describe(`${KIND_DESC}. 생략 = 그대로`),
  access_role: z.enum(ROLES).nullable().optional().describe(`${ACCESS_ROLE_DESC}. 생략 = 그대로`),
  access_grants: z.record(z.enum(["read", "write"])).nullable().optional().describe(`${ACCESS_GRANTS_DESC}. 생략 = 그대로`),
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
          kind: parseKind(b.kind),
          ...parseAccess(b),
        };
      } }],
  },
  handler: async (input: TeamUpdateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    await requireTeamWrite(user);
    const { id, kind, access_role: _ar, access_grants: _ag, ...patch } = input;
    const a = accessInputOf(input);
    //  권한을 바꾸는 저장이면 다른 칸을 쓰기 전에 자격을 본다(이름만 바뀌고 권한 저장이 거절되는 반쪽 저장을 만들지 않는다).
    if (a.role !== undefined || a.grants !== undefined) {
      if (!permits(user, "admin", { perm: "admin", level: "write" })) throw new HttpError(403, "팀에 권한을 싣는 것은 관리자만 할 수 있습니다 — 그 팀의 구성원 전원이 그 권한을 받습니다");
      const cur = accessOf(await getTeam(id));
      assertGivable(user, teamGrants({ role: a.role === undefined ? cur.role : a.role, grants: a.grants === undefined ? cur.grants : a.grants }));
    }
    await updateTeam(id, patch, writeCtxOf(user, ctx));
    //  종류 · 권한은 따로 쓴다(team-store.setTeamKind 머리말) — 준 값이 지금과 다를 때만.
    const now = (await getTeam(id))?.kind ?? "team";
    if (kind && kind !== now) await setTeamKind(id, kind, writeCtxOf(user, ctx));
    await applyAccess(id, a, user, ctx);
    const { members: _m, ...team } = (await getTeam(id))!;
    return { team };
  },
};

const teamDeleteInput = { id: z.number().int().positive() };
type TeamDeleteInput = z.infer<z.ZodObject<typeof teamDeleteInput>>;
const teamDelete: Capability = {
  name: "team_delete",
  title: "팀 삭제",
  description: "팀을 삭제한다(팀원 cascade 해제). 감사 스냅샷 보존. 웹 전용.",
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
    //  권한이 실린 팀에 사람을 새로 넣는 것은 그 권한을 주는 것이다(#5799) — 내가 갖지 않은 위험 권한의 고치기가 실린 팀에는 넣지 못한다.
    //   이미 있던 팀원을 그대로 두거나 빼는 것은 주는 것이 아니다.
    const cur = await getTeam(input.id);
    const giving = teamGrants(accessOf(cur));
    if (Object.keys(giving).length) {
      const had = new Set((cur?.members ?? []).map((m) => m.member_id));
      if (input.members.some((m) => m.member_id && !had.has(m.member_id.trim()))) assertGivable(user, giving);
    }
    return { members: await setTeamMembers(input.id, input.members, writeCtxOf(user, ctx)) };
  },
};

export const teamCapabilities: Capability[] = [
  teamList, teamGet, teamCreate, teamUpdate, teamDelete, teamSetMembers,
];

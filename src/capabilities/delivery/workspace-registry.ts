// delivery ▸ workspace-registry(#1750 S1) — 셀프호스트 다중 워크스페이스 **셀프서브 CRUD.**
//
//  워크스페이스 모델(#1750): 워크스페이스 = 개인|팀. 기존 셀프호스트 단일 워크스페이스 = primary(팀).
//   활성화(1회, admin) 후에는 누구나 자기 워크스페이스를 만든다(노션과 같은 결) — 개인 ws 는 만든 사람만
//   보고(멤버 게이트, admin 우회 없음 — org/tenancy/gate.ts), 팀 ws 는 owner 가 명부로 사람을 넣는다.
//  전환은 클라이언트가 `x-lively-workspace` 헤더로 한다(미들웨어가 등록부로 해석) — 여기 CRUD 는 어느
//   컨텍스트에서 불러도 같은 등록부를 본다(전역 표).
//
//  매니지드는 이 축을 쓰지 않는다 — CP(app.lvly.io /home)가 만들기·목록의 권위이고, 게이트웨이는
//   CP 서명 헤더로 컨텍스트를 받는다. registry 모드가 아닐 때 상태 조회는 그 사실을 안내한다.
import { z } from "zod";
import crypto from "node:crypto";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead, restWork, restOnly, actorOf } from "./shared.js";
import { registryModeActive } from "../../org/tenancy/state.js";
import { activateWorkspaceRegistry, lastActivationError } from "../../org/tenancy/activate.js";
import {
  PRIMARY_SLUG, PRIMARY_TENANT_ID, normalizeWorkspaceSlug, listWorkspacesForMember, getWorkspaceBySlug,
  insertWorkspace, updateWorkspaceName, archiveWorkspace, addWorkspaceMember, removeWorkspaceMember,
  getWorkspaceMemberRole, listWorkspaceMembers, type RegistryWorkspace,
  // #1875 — 개인/팀 파생 + 구성원 초대
  kindEffective, countWorkspaceMembers, memberCounts, normalizeInviteEmail, createInvite,
  listWorkspaceInvites, listInvitesForEmail, getInvite, resolveInvite, revokeInvitesForWorkspace,
  inviteResolvable, inviteDecisionActor, inviteNextState, inviteRecipientMatches, type InviteDecision,
} from "../../org/tenancy/registry.js";
import { currentTenant, withTenant } from "../../org/tenant-context.js";
import { itemsPool } from "../../db/client.js";
import { getMember, listMembers } from "../../org/store.js";
import { updateOrgProfile } from "../../org/store/profile.js";
import { updateRuntimeConfig } from "../../org/store/runtime-config.js";
import { seedDefaultContent } from "../../org/delivery/seed-content.js";
import { logger } from "../../log.js";

const requireMember = (user: LivelyUser): string => {
  const id = user?.userId;
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
};

// #1875 — 화면이 쓰는 것은 `kind_effective`(인원 수 파생)다. `kind` 컬럼도 계속 실어 보내되 그건
//  "만들 때의 의도"이지 지금의 사실이 아니다 — 사람이 들고 나면 조용히 거짓이 된다.
//  primary 는 명부를 쓰지 않으므로(박스 로그인 = 접근) 언제나 팀으로 본다.
const wsView = (w: RegistryWorkspace & { role?: string }, memberCount?: number, pending = 0) => {
  const isPrimary = w.id === PRIMARY_TENANT_ID;
  const n = memberCount ?? 0;
  return {
    slug: w.slug, name: w.name, kind: w.kind, state: w.state, role: w.role ?? null,
    is_primary: isPrimary, created_at: w.created_at,
    member_count: isPrimary ? null : n,
    pending_invites: pending,
    kind_effective: isPrimary ? "team" : kindEffective(n),
  };
};

/** 초대 대상 후보 — 이 박스의 사람들. 이메일이 없는 멤버(AI 등)는 부를 수 없다. */
const invitableMembers = async (): Promise<Array<{ id: string; email: string; display_name: string | null }>> =>
  (await listMembers())
    .filter((m) => m.kind === "human" && m.state === "active" && !!(m.email || "").trim())
    .map((m) => ({ id: m.id, email: String(m.email).toLowerCase(), display_name: m.display_name ?? null }));

/** slug 미지정 시 자동 생성 — 이름이 한글이면 슬러그화가 불가능하므로 무작위가 정직하다(추측하지 않는다). */
const autoSlug = (): string => `ws-${crypto.randomBytes(4).toString("hex")}`;

/** owner 판정 — 등록부 owner_member 이거나 명부 role=owner. primary 는 여기 안 온다(각 핸들러가 먼저 거른다). */
async function requireOwner(ws: RegistryWorkspace, memberId: string): Promise<void> {
  if (ws.owner_member === memberId) return;
  if ((await getWorkspaceMemberRole(ws.id, memberId)) === "owner") return;
  throw new HttpError(403, "이 워크스페이스의 owner 만 할 수 있습니다");
}

async function findWs(slugRaw: unknown): Promise<RegistryWorkspace> {
  const slug = normalizeWorkspaceSlug(slugRaw);
  const ws = await getWorkspaceBySlug(slug);
  if (!ws) throw new HttpError(404, `워크스페이스 '${slug}' 가 없습니다`);
  return ws;
}

const requireRegistry = (): void => {
  if (!registryModeActive()) {
    // 보통은 여기 올 일이 없다 — 부팅이 자동 활성화한다(boot/housekeeping 'workspace-registry' 스텝).
    //  왔다는 건 자동 활성화가 실패했거나(사유는 workspace_registry_status 의 activation_error) 매니지드라는 뜻.
    const err = lastActivationError();
    throw new HttpError(400,
      "다중 워크스페이스가 아직 활성화되지 않았습니다 — 부팅 자동 활성화가 안 됐다면 사유를 확인하세요" +
      (err ? ` (마지막 실패: ${err})` : "") +
      " (매니지드 워크스페이스라면 app.lvly.io 홈에서 만듭니다)");
  }
};

export const workspaceRegistryCapabilities: Capability[] = [
  restRead("workspace_registry_status", "워크스페이스 목록·상태",
    "이 게이트웨이의 다중 워크스페이스 상태와 **내가 속한 워크스페이스 목록**(좌상단 스위처 재료). " +
    "mode: registry=다중 활성화됨 | single=단일(활성화 전) | managed=매니지드(만들기는 app.lvly.io 홈). current = 지금 요청의 워크스페이스.",
    [{ method: "GET", paths: ["/api/ui/me/workspaces"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const id = requireMember(user);
      const managed = !!(process.env.LIVELY_TENANT_HEADER_SECRET || "").trim();
      const mode = managed ? "managed" : registryModeActive() ? "registry" : "single";
      const current = currentTenant()?.slug ?? PRIMARY_SLUG;
      if (mode !== "registry") {
        // single = 자동 활성화가 아직/실패 — 실패 사유는 admin 에게만(오류 문구에 DSN 호스트 등이 실릴 수 있다).
        const err = (user.scopes || []).includes("admin") ? lastActivationError() : null;
        return { mode, current, workspaces: [], ...(err ? { activation_error: err } : {}) };
      }
      const mine = await listWorkspacesForMember(id);
      // primary 는 명부 없이도 모두의 것 — 명부에 없어도 목록 맨 앞에 세운다(박스 로그인 = primary 접근).
      const rows = mine.some((w) => w.id === PRIMARY_TENANT_ID) ? mine
        : [...((await getWorkspaceBySlug(PRIMARY_SLUG).then((p) => p ? [{ ...p, role: "member" }] : [])) as Array<RegistryWorkspace & { role: string }>), ...mine];
      // #1875 — 인원 수를 한 번에 세어 함께 보낸다. 스위처 배지가 이 값에서 나오므로(파생 kind),
      //  목록과 배지가 서로 다른 시점의 사실을 말하는 일이 없다.
      const counts = await memberCounts(rows.map((w) => w.id));
      // 나에게 온 보류 초대 — **내 이메일** 기준이라 지금 어느 워크스페이스에 있든 보인다.
      //  이게 없으면 초대받은 사람이 자기 화면에서 초대를 볼 방법이 없다(종전: 링크를 따로 받아야 했다).
      const me = await getMember(id);
      const inbox = me?.email ? await listInvitesForEmail(String(me.email).toLowerCase()) : [];
      return {
        mode, current,
        workspaces: rows.map((w) => wsView(w, counts.get(w.id) ?? 0)),
        invites_for_me: inbox.map((i) => ({
          id: i.id, workspace_slug: i.workspace_slug, workspace_name: i.workspace_name,
          role: i.role, invited_by: i.invited_by, created_at: i.created_at,
        })),
      };
    }, true),

  restOnly("workspace_activate", "다중 워크스페이스 활성화(수동 — 보통 불필요)",
    "**보통은 부팅이 자동으로 한다** — 이 op 는 자동 활성화가 실패한 박스의 수동 복구용이다(사유는 workspace_registry_status 의 " +
    "activation_error). DB 에 앱 role 을 만들고 전 콘텐츠 테이블에 격리 정책(RLS)을 건 뒤, 기존 데이터를 primary 워크스페이스로 " +
    "시드하고 **프로세스를 재기동**한다(상시구동 슈퍼바이저 전제). 격리 검증이 실패하면 아무것도 바꾸지 않는다. " +
    "app_dsn: 소켓 DSN 등 자동 변환이 안 될 때 앱 role 접속 DSN 직접 지정 — 자동 활성화가 실패하는 대표 사유.",
    [{ method: "POST", paths: ["/api/ui/org/workspaces/activate"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      if (registryModeActive()) return { already_active: true, message: "이미 다중 워크스페이스 모드입니다" };
      if ((process.env.LIVELY_TENANT_HEADER_SECRET || "").trim())
        throw new HttpError(400, "매니지드 공유 게이트웨이에서는 활성화할 수 없습니다 — 워크스페이스는 app.lvly.io 홈에서 만듭니다");
      const r = await activateWorkspaceRegistry({
        ownerMember: id,
        appDsn: input.app_dsn === undefined ? undefined : String(input.app_dsn ?? ""),
      });
      // 응답이 나간 뒤 종료 — 슈퍼바이저가 재기동하며 boot/tenancy-env 가 앱 role 로 재배선한다.
      setTimeout(() => { logger.info("워크스페이스 활성화 — 재기동합니다"); process.exit(0); }, 1500).unref();
      return { ...r, restarting: true, message: "활성화 완료 — 게이트웨이가 곧 재기동합니다(수 초 뒤 새로고침)" };
    }, { app_dsn: z.string().optional().describe("앱 role 접속 DSN 직접 지정(소켓 DSN 등 자동 변환 불가 시)") }),

  restWork("workspace_create", "워크스페이스 만들기",
    "새 워크스페이스를 만든다(만든 사람이 owner). kind: personal=나만 보는 개인 공간 | team=명부로 사람을 넣는 팀 공간. " +
    "slug 미지정이면 자동 생성. 만든 뒤 그 워크스페이스로 가려면 요청에 `x-lively-workspace: <slug>` 헤더를 쓴다(웹 UI 는 좌상단 스위처).",
    [{ method: "POST", paths: ["/api/ui/me/workspaces"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const name = String(input.name ?? "").trim();
      if (!name) throw new HttpError(400, "name 이 필요합니다");
      const kind = input.kind === "team" ? "team" as const : "personal" as const;
      const slug = input.slug ? normalizeWorkspaceSlug(input.slug) : autoSlug();
      if (slug === PRIMARY_SLUG) throw new HttpError(400, "'primary' 는 예약된 이름입니다");
      if (await getWorkspaceBySlug(slug)) throw new HttpError(409, `워크스페이스 '${slug}' 가 이미 있습니다`);
      const wsId = crypto.randomUUID();
      const ws = await insertWorkspace({ id: wsId, slug, name, kind, owner: id });
      // ── 새 컨텍스트 안에서 기본 콘텐츠 시딩 — org_profile 싱글턴·워크스페이스 종류 노브·기본 지식/훅. ──
      //  binding 리졸버가 AsyncLocalStorage 를 읽으므로 withTenant 안의 모든 쿼리가 새 테넌트로 스코프된다.
      await withTenant({ id: wsId, slug }, async () => {
        await itemsPool.query(`INSERT INTO org_profile(id) VALUES(1) ON CONFLICT DO NOTHING`);
        await updateOrgProfile({ name }, actorOf(user), "workspace_create");
        await updateRuntimeConfig({ workspace_kind: kind }, actorOf(user), "workspace_create");
        await seedDefaultContent().catch((err) => logger.warn({ err, slug }, "새 워크스페이스 시딩 실패(비치명 — 다음 부팅 시딩이 보충하지 않으므로 수동 확인)"));
      });
      return { workspace: wsView({ ...ws, role: "owner" }), header: { "x-lively-workspace": slug } };
    }, {
      name: z.string().describe("워크스페이스 이름(표시용)"),
      kind: z.enum(["personal", "team"]).optional().describe("personal(기본)=개인 | team=팀"),
      slug: z.string().optional().describe("주소용 짧은 이름(소문자·숫자·하이픈 3~40자). 미지정이면 자동"),
    }),

  restWork("workspace_update", "워크스페이스 이름 변경",
    "워크스페이스 표시 이름을 바꾼다(owner 전용). 등록부와 그 워크스페이스 안의 조직 프로필을 함께 바꾼다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/update"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const name = String(input.name ?? "").trim();
      if (!name) throw new HttpError(400, "name 이 필요합니다");
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID) throw new HttpError(400, "primary 이름은 조직 프로필(org_update_profile)에서 바꿉니다");
      await requireOwner(ws, id);
      await updateWorkspaceName(ws.id, name);
      await withTenant({ id: ws.id, slug: ws.slug }, () => updateOrgProfile({ name }, actorOf(user), "workspace_update"));
      return { workspace: wsView({ ...(await getWorkspaceBySlug(ws.slug))!, role: "owner" }) };
    }, {
      slug: z.string().describe("대상 워크스페이스 slug"),
      name: z.string().describe("새 이름"),
    }),

  restWork("workspace_delete", "워크스페이스 보관(삭제)",
    "워크스페이스를 보관(archive)한다(owner 전용) — 스위처·접근에서 사라지지만 **데이터는 지우지 않는다**" +
    "(복구는 관리자가 등록부 state 를 되돌리면 된다. 물리 삭제는 v1 범위 밖 — 파괴 반경이 워크스페이스 전체라 사람 손으로만). primary 는 보관할 수 없다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID) throw new HttpError(400, "primary(기존 박스 워크스페이스)는 보관할 수 없습니다");
      await requireOwner(ws, id);
      await archiveWorkspace(ws.id);
      // 보관된 워크스페이스로 가는 초대는 갈 곳이 없다 — 함께 거둬야 받는 사람 화면에 유령이 남지 않는다.
      const revoked = await revokeInvitesForWorkspace(ws.id, actorOf(user));
      return { archived: ws.slug, revoked_invites: revoked };
    }, { slug: z.string().describe("보관할 워크스페이스 slug") }),

  restWork("workspace_member_add", "워크스페이스 멤버 추가",
    "워크스페이스 명부에 이 박스의 멤버를 **바로** 넣는다(owner 전용 — 상대의 수락 없이). role=owner 면 공동 owner. " +
    "사람을 불러서 본인이 수락하게 하려면 workspace_invite 를 쓴다(그쪽이 사람 대상 기본 경로다). " +
    "개인 워크스페이스에도 넣을 수 있고, 두 번째 사람이 들어온 순간 그 워크스페이스는 팀이 된다(#1875).",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/members/add"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID) throw new HttpError(400, "primary 는 명부가 없습니다 — 박스 멤버 전원이 접근합니다");
      await requireOwner(ws, id);
      // #1875 — 종전엔 여기서 "개인 워크스페이스에는 멤버를 넣을 수 없습니다"로 막았다. 그 벽이
      //  개인→팀 경로를 통째로 막고 있었다(사람을 부르려면 워크스페이스를 새로 만들어 옮겨야 했다).
      //  이제 사람이 들어오면 그 워크스페이스가 팀이 된다 — 그게 전환이다(kindEffective).
      const memberId = String(input.member_id ?? "").trim();
      if (!memberId) throw new HttpError(400, "member_id 가 필요합니다");
      if (!(await getMember(memberId))) throw new HttpError(404, `멤버 '${memberId}' 가 없습니다(org_members 로 확인)`);
      await addWorkspaceMember(ws.id, memberId, input.role === "owner" ? "owner" : "member");
      const n = await countWorkspaceMembers(ws.id);
      return { workspace: ws.slug, members: await listWorkspaceMembers(ws.id), member_count: n, kind_effective: kindEffective(n) };
    }, {
      slug: z.string().describe("팀 워크스페이스 slug"),
      member_id: z.string().describe("넣을 멤버 id(org_members 의 id)"),
      role: z.enum(["owner", "member"]).optional().describe("기본 member"),
    }),

  restWork("workspace_member_remove", "워크스페이스 멤버 제거",
    "팀 워크스페이스 명부에서 멤버를 뺀다(owner 전용). 등록부 owner_member(만든 사람)는 뺄 수 없다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/members/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID) throw new HttpError(400, "primary 는 명부가 없습니다");
      await requireOwner(ws, id);
      const memberId = String(input.member_id ?? "").trim();
      if (!memberId) throw new HttpError(400, "member_id 가 필요합니다");
      if (memberId === ws.owner_member) throw new HttpError(400, "만든 사람(owner)은 뺄 수 없습니다 — 워크스페이스를 보관하세요");
      await removeWorkspaceMember(ws.id, memberId);
      const n = await countWorkspaceMembers(ws.id);
      return { workspace: ws.slug, members: await listWorkspaceMembers(ws.id), member_count: n, kind_effective: kindEffective(n) };
    }, {
      slug: z.string().describe("팀 워크스페이스 slug"),
      member_id: z.string().describe("뺄 멤버 id"),
    }),

  // ── #1875 구성원 초대 ─────────────────────────────────────────────────────
  //  종전에 사람을 부르는 화면은 매니지드 관리페이지(app.lvly.io)에만 있었고, 게이트웨이에는
  //  "이미 아는 member_id 를 명부에 꽂는" 조작만 있었다. 아래 넷이 그 축을 앱 안으로 들여온다.

  restRead("workspace_people", "구성원 · 초대 현황",
    "이 워크스페이스의 명부(사람·역할)와 **보류 중인 초대**, 그리고 부를 수 있는 사람 후보를 함께 준다. " +
    "member_count 로 개인/팀이 갈린다(kind_effective) — 저장된 kind 가 아니라 지금 몇 명인가가 정본이다.",
    [{ method: "GET", paths: ["/api/ui/me/workspaces/people"], parse: (req) => ({ slug: req.query?.slug }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID)
        throw new HttpError(400, "primary 는 명부가 없습니다 — 이 박스의 구성원 전원이 접근합니다(설정 ▸ 구성원)");
      // 명부 안의 사람만 본다. 남의 개인 워크스페이스 명부가 admin 에게도 보이면 안 된다(#1750 의 규율).
      const role = await getWorkspaceMemberRole(ws.id, id);
      if (!role && ws.owner_member !== id) throw new HttpError(403, "이 워크스페이스의 구성원만 볼 수 있습니다");
      const isOwner = role === "owner" || ws.owner_member === id;
      const [members, pending, people] = await Promise.all([
        listWorkspaceMembers(ws.id), listWorkspaceInvites(ws.id), invitableMembers(),
      ]);
      const byId = new Map(people.map((p) => [p.id, p]));
      const memberIds = new Set(members.map((m) => m.member_id));
      const pendingEmails = new Set(pending.map((i) => i.email));
      const n = members.length;
      return {
        workspace: wsView({ ...ws, role: role ?? "owner" }, n, pending.length),
        member_count: n,
        kind_effective: kindEffective(n),
        can_invite: isOwner,
        members: members.map((m) => ({
          member_id: m.member_id, role: m.role,
          email: byId.get(m.member_id)?.email ?? null,
          display_name: byId.get(m.member_id)?.display_name ?? null,
          is_creator: m.member_id === ws.owner_member,
        })),
        // 보류 초대는 owner 에게만 — 누가 아직 안 받았는지는 명부 관리 정보다.
        pending: isOwner ? pending.map((i) => ({ id: i.id, email: i.email, role: i.role, invited_by: i.invited_by, created_at: i.created_at })) : [],
        // 이미 들어와 있거나 이미 부른 사람은 후보에서 뺀다(같은 사람을 두 번 부르는 화면을 만들지 않는다).
        candidates: isOwner ? people.filter((p) => !memberIds.has(p.id) && !pendingEmails.has(p.email)) : [],
      };
    }, true, { slug: z.string().describe("대상 워크스페이스 slug") }),

  restWork("workspace_invite", "구성원 초대(이메일)",
    "이 워크스페이스로 사람을 부른다(owner 전용). 초대는 **보류**로 만들어지고, 받는 사람이 수락해야 명부에 들어온다 — " +
    "보내는 것만으로는 아무것도 바뀌지 않는다. **개인 워크스페이스에도 걸 수 있다**: 수락되는 순간 두 번째 사람이 " +
    "생기므로 그 워크스페이스는 팀이 된다(개인→팀 경로). 이미 이 박스에 없는 이메일도 받아 둔다 — 그 사람이 " +
    "합류하는 순간 자기 화면에서 이 초대를 보게 된다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/invite"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID)
        throw new HttpError(400, "primary 에는 초대가 없습니다 — 이 박스의 구성원 전원이 이미 접근합니다");
      await requireOwner(ws, id);
      let email: string;
      try { email = normalizeInviteEmail(input.email); }
      catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }

      const me = await getMember(id);
      if (me?.email && String(me.email).toLowerCase() === email)
        throw new HttpError(400, "이미 이 워크스페이스에 있는 본인입니다");
      // 이미 명부에 있는 사람인지 — 이메일로 되짚는다(초대는 이메일 축, 명부는 member_id 축이라 여기서 만난다).
      const people = await invitableMembers();
      const already = people.find((p) => p.email === email);
      if (already && (await getWorkspaceMemberRole(ws.id, already.id))) {
        throw new HttpError(409, `${email} 님은 이미 이 워크스페이스의 구성원입니다`);
      }
      const role = input.role === "owner" ? "owner" as const : "member" as const;
      try {
        const inv = await createInvite({ id: crypto.randomUUID(), workspaceId: ws.id, email, role, invitedBy: id });
        const n = await countWorkspaceMembers(ws.id);
        return {
          invite: { id: inv.id, email: inv.email, role: inv.role, state: inv.state, created_at: inv.created_at },
          workspace: ws.slug,
          // 화면이 "수락하면 팀이 된다"를 말할 수 있게, 지금 상태를 함께 준다.
          member_count: n, kind_effective: kindEffective(n),
          becomes_team: kindEffective(n) === "personal",
          known_member: !!already,
        };
      } catch (e) {
        // 부분 유니크(workspace_id, email) WHERE pending — 같은 사람을 두 번 부른 경우.
        if (String((e as { code?: string })?.code) === "23505")
          throw new HttpError(409, `${email} 님에게 보낸 초대가 이미 수락을 기다리고 있습니다`);
        throw e;
      }
    }, {
      slug: z.string().describe("초대할 워크스페이스 slug"),
      email: z.string().describe("부를 사람의 이메일"),
      role: z.enum(["owner", "member"]).optional().describe("기본 member. owner 면 공동 owner"),
    }),

  restWork("workspace_invite_resolve", "초대 수락 · 거절 · 취소",
    "보류 중인 초대를 처리한다. decision=accept|decline 은 **받는 사람**이(초대의 이메일과 로그인한 사람의 이메일이 " +
    "같아야 한다), revoke 는 **보낸 쪽 owner** 가 한다. accept 면 그 자리에서 명부에 들어가고, 그게 두 번째 사람이면 " +
    "그 워크스페이스는 팀이 된다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/invite/resolve"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const inviteId = String(input.invite_id ?? "").trim();
      if (!inviteId) throw new HttpError(400, "invite_id 가 필요합니다");
      const decision = String(input.decision ?? "") as InviteDecision;
      if (!["accept", "decline", "revoke"].includes(decision))
        throw new HttpError(400, "decision 은 accept | decline | revoke 입니다");

      const inv = await getInvite(inviteId);
      if (!inv) throw new HttpError(404, "그런 초대가 없습니다");
      const ws = (await itemsPool.query(`SELECT id, slug, name, kind, owner_member, state, created_at FROM gw_workspace WHERE id=$1`, [inv.workspace_id]))
        .rows[0] as RegistryWorkspace | undefined;
      if (!ws || ws.state !== "active") throw new HttpError(400, "이 워크스페이스는 더 이상 참여할 수 없습니다");

      // 이미 끝난 초대는 여기서 걸러 사람에게 사유를 말한다(아래 UPDATE 도 같은 조건으로 한 번 더 막는다 —
      //  이쪽은 문구를 위해, 저쪽은 경합을 위해. 둘 다 있어야 한다).
      if (!inviteResolvable(inv.state)) throw new HttpError(409, "이 초대는 이미 처리되었습니다");

      if (inviteDecisionActor(decision) === "owner") {
        await requireOwner(ws, id);
      } else {
        // 받는 사람 확인 — 초대 id 가 남에게 새도 남의 초대를 대신 수락할 수 없다.
        const me = await getMember(id);
        if (!inviteRecipientMatches(inv.email, me?.email))
          throw new HttpError(403, `이 초대는 ${inv.email} 님 앞으로 온 것입니다`);
      }

      // 상태 전이는 보류일 때만 통과한다 — 경합에서 두 번 들어가지 않는다.
      const moved = await resolveInvite(inviteId, inviteNextState(decision), id);
      if (!moved) throw new HttpError(409, "이 초대는 이미 처리되었습니다");

      if (decision !== "accept") {
        const n = await countWorkspaceMembers(ws.id);
        return { invite: { id: inviteId, state: inviteNextState(decision) }, workspace: ws.slug, member_count: n, kind_effective: kindEffective(n) };
      }

      const before = await countWorkspaceMembers(ws.id);
      await addWorkspaceMember(ws.id, id, inv.role);
      const after = await countWorkspaceMembers(ws.id);
      return {
        invite: { id: inviteId, state: "accepted" },
        workspace: ws.slug, workspace_name: ws.name,
        member_count: after, kind_effective: kindEffective(after),
        // 화면이 "팀이 되었습니다"를 말할 자격 — 이번 수락이 전환을 일으켰는가.
        became_team: kindEffective(after) === "team" && kindEffective(before) === "personal",
        header: { "x-lively-workspace": ws.slug },
      };
    }, {
      invite_id: z.string().describe("초대 id"),
      decision: z.enum(["accept", "decline", "revoke"]).describe("accept·decline=받는 사람 / revoke=보낸 owner"),
    }),
];

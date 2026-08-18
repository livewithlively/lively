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
import { activateWorkspaceRegistry } from "../../org/tenancy/activate.js";
import {
  PRIMARY_SLUG, PRIMARY_TENANT_ID, normalizeWorkspaceSlug, listWorkspacesForMember, getWorkspaceBySlug,
  insertWorkspace, updateWorkspaceName, archiveWorkspace, addWorkspaceMember, removeWorkspaceMember,
  getWorkspaceMemberRole, listWorkspaceMembers, type RegistryWorkspace,
} from "../../org/tenancy/registry.js";
import { currentTenant, withTenant } from "../../org/tenant-context.js";
import { itemsPool } from "../../db/client.js";
import { getMember } from "../../org/store.js";
import { updateOrgProfile } from "../../org/store/profile.js";
import { updateRuntimeConfig } from "../../org/store/runtime-config.js";
import { seedDefaultContent } from "../../org/delivery/seed-content.js";
import { logger } from "../../log.js";

const requireMember = (user: LivelyUser): string => {
  const id = user?.userId;
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
};

const wsView = (w: RegistryWorkspace & { role?: string }) => ({
  slug: w.slug, name: w.name, kind: w.kind, state: w.state, role: w.role ?? null,
  is_primary: w.id === PRIMARY_TENANT_ID, created_at: w.created_at,
});

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
    throw new HttpError(400,
      "다중 워크스페이스가 아직 활성화되지 않았습니다 — 관리자가 workspace_activate 를 먼저 실행하세요" +
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
      if (mode !== "registry") return { mode, current, workspaces: [] };
      const mine = await listWorkspacesForMember(id);
      // primary 는 명부 없이도 모두의 것 — 명부에 없어도 목록 맨 앞에 세운다(박스 로그인 = primary 접근).
      const rows = mine.some((w) => w.id === PRIMARY_TENANT_ID) ? mine
        : [...((await getWorkspaceBySlug(PRIMARY_SLUG).then((p) => p ? [{ ...p, role: "member" }] : [])) as Array<RegistryWorkspace & { role: string }>), ...mine];
      return { mode, current, workspaces: rows.map(wsView) };
    }, true),

  restOnly("workspace_activate", "다중 워크스페이스 활성화",
    "셀프호스트 게이트웨이를 다중 워크스페이스 모드로 전환한다(1회). DB 에 앱 role(lvly_app)을 만들고 전 콘텐츠 " +
    "테이블에 격리 정책(RLS)을 건 뒤, 기존 데이터를 primary 워크스페이스로 시드하고 **프로세스를 재기동**한다" +
    "(상시구동 슈퍼바이저 전제 — launchd/systemd 가 새 모드로 다시 띄운다). 격리 검증이 실패하면 아무것도 바꾸지 않는다. " +
    "app_dsn: 소켓 DSN 등 자동 변환이 안 될 때 앱 role 접속 DSN 직접 지정.",
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
      return { archived: ws.slug };
    }, { slug: z.string().describe("보관할 워크스페이스 slug") }),

  restWork("workspace_member_add", "워크스페이스 멤버 추가",
    "팀 워크스페이스 명부에 이 박스의 멤버를 넣는다(owner 전용). role=owner 로 넣으면 공동 owner. " +
    "개인(personal) 워크스페이스에는 넣을 수 없다 — 사람이 필요하면 팀으로 만든다.",
    [{ method: "POST", paths: ["/api/ui/me/workspaces/members/add"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      requireRegistry();
      const ws = await findWs(input.slug);
      if (ws.id === PRIMARY_TENANT_ID) throw new HttpError(400, "primary 는 명부가 없습니다 — 박스 멤버 전원이 접근합니다");
      await requireOwner(ws, id);
      if (ws.kind === "personal") throw new HttpError(400, "개인 워크스페이스에는 멤버를 넣을 수 없습니다");
      const memberId = String(input.member_id ?? "").trim();
      if (!memberId) throw new HttpError(400, "member_id 가 필요합니다");
      if (!(await getMember(memberId))) throw new HttpError(404, `멤버 '${memberId}' 가 없습니다(org_members 로 확인)`);
      await addWorkspaceMember(ws.id, memberId, input.role === "owner" ? "owner" : "member");
      return { workspace: ws.slug, members: await listWorkspaceMembers(ws.id) };
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
      return { workspace: ws.slug, members: await listWorkspaceMembers(ws.id) };
    }, {
      slug: z.string().describe("팀 워크스페이스 slug"),
      member_id: z.string().describe("뺄 멤버 id"),
    }),
];

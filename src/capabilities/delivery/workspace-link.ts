// delivery ▸ workspace-link(#1750) — 연결한 (팀) 워크스페이스 관리 + 개인→팀 **승격**.
//  워크스페이스 1개 = 게이트웨이 1개. 개인 워크스페이스의 사람/AI 가 지식·프로젝트를 연결한 팀으로 올린다.
//   · 연결 CRUD: 내 자격(scope=null) — 그 팀에서 발급한 내 토큰을 vault(member_secret)에 맡긴다.
//   · 승격: scope=memory — auto_promote 꺼짐(기본)이면 요청 큐에 적재(사람 승인 대기), 켜짐이면 즉시 원격 발행.
//  원격 발행 = 그 팀 게이트웨이의 REST(POST /api/ui/knowledge · /api/ui/v6/projects)를 내 토큰으로 호출(복사 — 원본은 개인에 남는다).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead, restWork, actorOf } from "./shared.js";
import {
  listLinkedWorkspaces, getLinkedWorkspace, setLinkedWorkspace, removeLinkedWorkspace,
  markLinkedWorkspace, remoteCall, type LinkedWorkspace,
} from "../../org/store/linked-workspaces.js";
import {
  upsertPendingPromotion, listPromotions, getPromotion, setPromotionState, countPendingPromotions,
  type PromotionRow,
} from "../../org/store/promotion-store.js";
import { getKnowledge } from "../../v6/knowledge-store.js";
import { getProject } from "../../v6/project-store.js";

const requireMember = (user: LivelyUser): string => {
  const id = user?.userId;
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
};

const linkView = (l: LinkedWorkspace) => ({
  scope_key: l.scope_key, base_url: l.base_url, name: l.name, kind: l.kind,
  remote_member_id: l.remote_member_id, remote_display_name: l.remote_display_name,
  auto_promote: l.auto_promote, state: l.state, last_error: l.last_error, last_ok_at: l.last_ok_at,
});

// ── 승격 실행 — 큐 행 하나를 원격 팀 워크스페이스에 실제로 발행한다. 성공/실패를 행에 기록하고 돌려준다. ──
async function executePromotion(row: PromotionRow, actor: string): Promise<PromotionRow> {
  const link = await getLinkedWorkspace(row.member_id, row.link_scope);
  if (!link) return (await setPromotionState(row.id, row.member_id, "failed", { error: `연결 '${row.link_scope}' 가 없습니다 — 다시 연결하세요` }))!;
  try {
    if (row.kind === "knowledge") {
      const k = await getKnowledge(row.target_ref);
      if (!k) throw new Error(`지식 '${row.target_ref}' 을 찾을 수 없습니다`);
      const cats = (k.categories as Array<{ key: string; state: string }>) || [];
      const category = row.remote_category || cats.find((c) => c.state !== "rejected")?.key || null;
      if (!category) throw new Error("올릴 분류(category)가 필요합니다 — 이 지식엔 분류가 없어 remote_category 로 팀 워크스페이스의 분류 key 를 지정하세요");
      const body = {
        name: String(k.name), title: k.title ?? String(k.name), body_md: String(k.body_md ?? ""),
        type: k.type ?? "reference", category, provenance: "authored",
      };
      const res = await remoteCall(row.member_id, link, "/api/ui/knowledge", { method: "POST", body });
      if (res.status === 400 && String(res.text).includes("category"))
        throw new Error(`팀 워크스페이스에 분류 '${category}' 가 없습니다 — remote_category 로 그 워크스페이스의 분류 key 를 지정하세요`);
      if (res.status < 200 || res.status >= 300) throw new Error(`팀 워크스페이스가 ${res.status} 로 거부했습니다: ${String(res.text).slice(0, 200)}`);
      await markLinkedWorkspace(row.member_id, row.link_scope, true);
      return (await setPromotionState(row.id, row.member_id, "done", { result: { name: body.name, remote: link.base_url, gate: (res.json as { gate?: unknown })?.gate ?? null } }))!;
    }
    // kind === "project" — 이름·설명만 복사(태스크·상태·필드는 v1 범위 밖). 팀 워크스페이스에 새 프로젝트로 선다.
    const pid = Number(row.target_ref);
    const p = await getProject(pid);
    if (!p) throw new Error(`프로젝트 #${row.target_ref} 를 찾을 수 없습니다`);
    const body = { name: String(p.name), description: p.description ? String(p.description) : undefined };
    const res = await remoteCall(row.member_id, link, "/api/ui/v6/projects", { method: "POST", body });
    if (res.status < 200 || res.status >= 300) throw new Error(`팀 워크스페이스가 ${res.status} 로 거부했습니다: ${String(res.text).slice(0, 200)}`);
    await markLinkedWorkspace(row.member_id, row.link_scope, true);
    const rp = (res.json as { project?: { id?: number } })?.project;
    return (await setPromotionState(row.id, row.member_id, "done", { result: { remote: link.base_url, remote_project_id: rp?.id ?? null, note: "이름·설명만 복사했습니다(태스크는 아직)" } }))!;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await markLinkedWorkspace(row.member_id, row.link_scope, false, msg).catch(() => {});
    return (await setPromotionState(row.id, row.member_id, "failed", { error: msg }))!;
  }
}

export const workspaceLinkCapabilities: Capability[] = [
  restRead("workspace_links_list", "연결한 워크스페이스 목록",
    "지금 내가 (이 개인 워크스페이스에서) 지식·프로젝트를 올릴 수 있는 팀 워크스페이스 연결 목록. 대기 중인 승격 요청 수도 함께.",
    [{ method: "GET", paths: ["/api/ui/me/linked-workspaces"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const id = requireMember(user);
      const [links, pending] = await Promise.all([listLinkedWorkspaces(id), countPendingPromotions(id)]);
      return { links: links.map(linkView), pending_promotions: pending };
    }, false),

  restWork("workspace_link_set", "워크스페이스 연결 등록·수정",
    "팀 워크스페이스를 연결한다. url = 그 워크스페이스의 라이블리 게이트웨이 주소, token = 거기서 발급한 **내 토큰**(memory·context 스코프). " +
    "auto_promote=true 면 앞으로 AI 가 이 워크스페이스로 올릴 때 사람 승인 없이 즉시 발행한다(기본 false — 사람 승인). 토큰 없이 부르면 이름·auto_promote 만 바꾼다.",
    [{ method: "POST", paths: ["/api/ui/me/linked-workspaces"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      const link = await setLinkedWorkspace(id, {
        url: String(input.url ?? ""),
        token: input.token === undefined ? undefined : (input.token === null ? null : String(input.token)),
        name: input.name === undefined ? undefined : String(input.name ?? ""),
        auto_promote: input.auto_promote === undefined ? undefined : input.auto_promote === true,
      }, actorOf(user));
      return { link: linkView(link) };
    }, {
      url: z.string().describe("팀 워크스페이스 게이트웨이 주소(예: https://team.lvly.io)"),
      token: z.string().nullable().optional().describe("그 워크스페이스에서 발급한 내 토큰(lvk_…, memory·context). 첫 연결 시 필수"),
      name: z.string().optional().describe("표시 이름(미지정이면 원격 조직 이름)"),
      auto_promote: z.boolean().optional().describe("true=AI 승격을 사람 승인 없이 즉시 발행(기본 false)"),
    }),

  restWork("workspace_link_remove", "워크스페이스 연결 해제",
    "연결한 팀 워크스페이스를 목록에서 뺀다(맡긴 토큰도 함께 지운다). scope_key = 연결 목록의 scope_key(host).",
    [{ method: "POST", paths: ["/api/ui/me/linked-workspaces/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      const scopeKey = String(input.scope_key ?? "").trim();
      if (!scopeKey) throw new HttpError(400, "scope_key 가 필요합니다");
      return { removed: await removeLinkedWorkspace(id, scopeKey) };
    }, { scope_key: z.string().describe("연결 목록의 scope_key(host[:port])") }),

  restWork("workspace_promote", "팀 워크스페이스로 올리기(승격)",
    "이 개인 워크스페이스의 지식(kind='knowledge', ref=지식 name) 또는 프로젝트(kind='project', ref=프로젝트 id)를 연결한 팀 워크스페이스로 올린다(복사 — 원본은 그대로 남는다). " +
    "그 연결의 auto_promote 가 꺼져 있으면(기본) **바로 올라가지 않고 승인 대기 요청**이 생긴다 — 응답 state='pending'. 사용자가 승인해야 올라간다(사용자가 자동 허락을 켜 두면 state='done'). " +
    "지식은 팀 워크스페이스의 분류(category)가 필요하다 — remote_category 미지정 시 원본 지식의 분류 key 를 그대로 쓴다(팀에 그 key 가 없으면 실패하며 안내한다).",
    [{ method: "POST", paths: ["/api/ui/workspace-promote"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const id = requireMember(user);
      const kind = String(input.kind ?? "");
      if (kind !== "knowledge" && kind !== "project") throw new HttpError(400, "kind 는 knowledge|project");
      const targetRef = String(input.ref ?? input.name ?? input.id ?? "").trim();
      if (!targetRef) throw new HttpError(400, "ref(지식 name 또는 프로젝트 id)가 필요합니다");
      const scopeKey = String(input.link ?? input.scope_key ?? "").trim();
      const links = await listLinkedWorkspaces(id);
      if (!links.length) throw new HttpError(400, "연결한 팀 워크스페이스가 없습니다 — 먼저 workspace_link_set 으로 연결하세요");
      const link = scopeKey ? links.find((l) => l.scope_key === scopeKey) : (links.length === 1 ? links[0] : null);
      if (!link) throw new HttpError(400, scopeKey ? `연결 '${scopeKey}' 가 없습니다` : "연결이 여러 개입니다 — link=scope_key 로 올릴 팀을 지정하세요");

      // 대상이 실제로 있는지 먼저 확인(없는 걸 큐에 넣지 않게).
      let title: string | null = null;
      if (kind === "knowledge") { const k = await getKnowledge(targetRef, ctx?.viewer ?? null); if (!k) throw new HttpError(404, `지식 '${targetRef}' 없음`); title = (k.title as string) ?? targetRef; }
      else { const p = await getProject(Number(targetRef), ctx?.viewer ?? null); if (!p) throw new HttpError(404, `프로젝트 #${targetRef} 없음`); title = p.name; }

      const via = ctx?.source === "mcp" ? "mcp" : "web";
      const actor_kind = via === "mcp" ? "ai" : "human";
      const { row } = await upsertPendingPromotion({
        member_id: id, link_scope: link.scope_key, kind, target_ref: targetRef, title,
        note: input.note ? String(input.note) : null,
        remote_category: input.remote_category ? String(input.remote_category) : null,
        requested_by: actorOf(user), requested_via: via, actor_kind,
      });
      // 자동 허락이 켜져 있으면 그 자리에서 발행. 아니면 승인 대기로 남긴다(사람이 workspace_promotion_resolve).
      if (link.auto_promote) {
        const done = await executePromotion(row, actorOf(user));
        return { promotion: done, auto: true };
      }
      return { promotion: row, auto: false,
        message: `'${link.name}' 로 올리려면 승인이 필요합니다 — 승인 대기 요청을 만들었습니다(사용자 확인 후 올라갑니다).` };
    }, {
      kind: z.enum(["knowledge", "project"]).describe("올릴 것의 종류"),
      ref: z.string().optional().describe("올릴 대상 — 지식이면 name, 프로젝트면 id(name/id 로도 됨)"),
      name: z.string().optional().describe("ref 대신 지식 name 으로 지정할 때"),
      id: z.union([z.string(), z.number()]).optional().describe("ref 대신 프로젝트 id 로 지정할 때"),
      link: z.string().optional().describe("올릴 팀 워크스페이스의 scope_key(연결이 하나면 생략 가능)"),
      scope_key: z.string().optional().describe("link 의 다른 이름 — 올릴 팀 워크스페이스의 scope_key"),
      remote_category: z.string().optional().describe("팀 워크스페이스의 분류 key(지식 전용, 미지정 시 원본 분류를 그대로)"),
      note: z.string().optional().describe("승인 화면에 보일 메모"),
    }),

  restRead("workspace_promotions_list", "승격 요청 목록",
    "내가 낸 승격 요청 목록(대기·완료·거절·실패). 승인 화면·배지가 읽는다.",
    [{ method: "GET", paths: ["/api/ui/me/promotions"], parse: (req) => ({ state: req.query?.state ? String(req.query.state) : undefined }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      return { promotions: await listPromotions(id, { state: input.state ? String(input.state) : undefined }) };
    }, false, { state: z.enum(["pending", "approved", "rejected", "done", "failed"]).optional() }),

  restWork("workspace_promotion_resolve", "승격 요청 승인·거절",
    "대기 중인 승격 요청을 처리한다. decision='approve' 면 지금 팀 워크스페이스로 올리고(state→done|failed), 'reject' 면 취소(state→rejected). **사람이 웹에서 누르는 경로**가 기본이다.",
    [{ method: "POST", paths: ["/api/ui/me/promotions/:id/resolve"], parse: (req) => ({ id: Number((req.params as Record<string, string>)?.id), ...(req.body as object ?? {}) }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const id = requireMember(user);
      const pid = Number(input.id);
      if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, "요청 id 필요");
      const decision = String(input.decision ?? "");
      if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "decision 은 approve|reject");
      const row = await getPromotion(pid, id);
      if (!row) throw new HttpError(404, "승격 요청을 찾을 수 없습니다");
      if (row.state !== "pending") throw new HttpError(409, `이미 처리된 요청입니다(${row.state})`);
      if (decision === "reject") return { promotion: await setPromotionState(pid, id, "rejected", { decided_by: actorOf(user) }) };
      const approved = await setPromotionState(pid, id, "approved", { decided_by: actorOf(user) });
      return { promotion: await executePromotion(approved!, actorOf(user)) };
    }, {
      id: z.number().int().positive(),
      decision: z.enum(["approve", "reject"]),
    }),
];

// 노션 "팀 자료로 모으기"(#1881 N3·N5 백엔드) — 노션 수집기를 **토큰 복사 없이** 켠다.
//
//  슬랙(slack-connect.ts)과 같은 그림이되 연결의 결이 다르다: 슬랙은 구성원의 [Slack 연결](개인 금고)을 수집기가
//  가리키지만, 노션은 개인 MCP 연결(DCR)의 토큰이 REST 수집에 안 통한다(지식 notion-single-connect-design-1881 §1①).
//  그래서 토글 자체가 **라이블리 공개 통합 OAuth** 를 연다 — 노션 동의 화면의 페이지 선택기가 곧 수집 범위 선언이고,
//  토큰은 조직 슬롯(gateway, notion_public, scope_key=workspace_id)에 저장된다. 수집기는 token_source=org 로 그 슬롯을
//  가리킨다. 관리탭 ▸ 외부 자료 수집에 가서 내부 통합 시크릿을 붙여 넣는 5단계가 사라진다(오너 제한도 함께).
//
//  인스턴스는 하나다(`lively-notion`) — 범위는 노션 쪽 페이지 선택이 정하므로 root_pages 를 두지 않는다(search 스윕이
//  공유된 범위만 돌려준다). 끄면 enabled=false 로 남긴다(삭제 아님 — 커서·자료가 남고 다시 켜면 이어받는다).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { listCollectors, upsertCollector, type CollectorView } from "../org/store/collectors.js";
import { listSecretsByKindPublic, GATEWAY_OWNER } from "../org/credentials/member-secret-store.js";
import { NOTION_PUBLIC_KIND } from "../org/credentials/notion-oauth.js";
import { startNotionPublicConsent, completeNotionInstall, notionPublicReady } from "../org/credentials/oauth-broker.js";

export const NOTION_INSTANCE = "lively-notion";

function findInstance(all: CollectorView[]): CollectorView | undefined {
  return all.find((c) => c.preset_key === "notion" && c.instance_key === NOTION_INSTANCE);
}

interface NotionWorkspaceRow { id: string; name: string | null; icon: string | null; connected_by: string | null; updated_at: string | null }

async function orgWorkspaces(): Promise<NotionWorkspaceRow[]> {
  const rows = await listSecretsByKindPublic(NOTION_PUBLIC_KIND).catch(() => []);
  return rows
    .filter((r) => r.owner === GATEWAY_OWNER && r.has_secret)
    .map((r) => ({
      id: r.scope_key,
      name: typeof r.meta.workspace_name === "string" ? r.meta.workspace_name : null,
      icon: typeof r.meta.workspace_icon === "string" ? r.meta.workspace_icon : null,
      connected_by: typeof r.meta.connected_by === "string" ? r.meta.connected_by : null,
      updated_at: r.updated_at,
    }));
}

export interface NotionCollectState {
  /** 수집기 — 켜져 있으면 어느 워크스페이스 연결로 도는지(token_source). */
  enabled: boolean;
  collector_id: number | null;
  token_source: string | null;
  /** [팀 자료로 모으기]로 연결된 노션 워크스페이스들(조직 슬롯). 비어 있으면 아직 동의 전. */
  workspaces: NotionWorkspaceRow[];
  /** 동의를 시작할 수 있는가 — 통합 client(직결) 또는 CP 릴레이가 있어야 한다. */
  ready: boolean;
}

export async function notionCollectState(): Promise<NotionCollectState> {
  const inst = findInstance(await listCollectors());
  return {
    enabled: !!inst?.enabled,
    collector_id: inst?.id ?? null,
    token_source: inst?.config?.token_source ?? null,
    workspaces: await orgWorkspaces(),
    ready: await notionPublicReady().catch(() => false),
  };
}

/** 수집기 생성/켜기 — 워크스페이스가 하나면 token_source=org(가장 단순), 여럿이면 명시 지목. */
async function enableCollector(actor: string, source: string): Promise<{ collector_id: number; token_source: string }> {
  const all = await listCollectors();
  const inst = findInstance(all);
  const ws = await orgWorkspaces();
  if (ws.length === 0) throw new HttpError(400, "노션 연결이 아직 없습니다 — 먼저 노션 동의 화면에서 모을 페이지를 골라 주세요.");
  const cur = inst?.config?.token_source ?? "";
  const tokenSource = ws.length === 1 ? "org"
    : (cur === "org" || cur.startsWith("org:")) ? cur : `org:${ws[0].id}`;
  const saved = await upsertCollector({
    id: inst?.id, preset_key: "notion", instance_key: NOTION_INSTANCE,
    label: inst?.label ?? "Notion — 팀 문서", enabled: true,
    config: { ...(inst?.config ?? {}), token_source: tokenSource },
    note: inst?.note ?? "[팀 자료로 모으기] 토글로 만들어진 수집기 — 노션 동의 화면에서 고른 페이지(와 그 하위)를 모읍니다(#1881). 토큰 칸은 비워 두세요. 범위 변경은 [페이지 더 고르기]로.",
  }, actor, source);
  return { collector_id: saved.id, token_source: tokenSource };
}

const orgNotionCollect: Capability = {
  name: "org_notion_collect", title: "노션 팀 자료 수집 상태",
  description: "\"팀 자료로 모으기\" 상태 — 노션 수집기의 켜짐 여부, 연결된 워크스페이스(조직 슬롯), 동의 시작 가능 여부. 토글은 org_notion_collect_set, 범위 재선택은 org_notion_collect_connect.",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/notion/collect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    return notionCollectState();
  },
};

const orgNotionCollectSet: Capability = {
  name: "org_notion_collect_set", title: "노션 팀 자료 수집 켜기/끄기",
  description:
    "\"팀 자료로 모으기\" 토글(admin). enabled=true 인데 노션 연결(조직 슬롯)이 아직 없으면 needs_connect=true 와 " +
    "authorization_url 을 돌려준다 — 그 URL 의 노션 화면에서 모을 페이지를 고르고 [허용]하면 연결이 저장되고, 다시 " +
    "이 토글을 부르면 수집기가 만들어진다(token_source=org, 토큰 복사 0). false 면 끈다(삭제 아님 — 커서·자료 보존).",
  scope: "admin",
  input: { enabled: z.boolean().describe("true=켜기 · false=끄기") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/notion/collect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const enabled = (input as { enabled?: unknown })?.enabled === true;
    const actor = user.userId;
    const source = ctx?.source ?? "web";
    if (!enabled) {
      const inst = findInstance(await listCollectors());
      if (inst?.enabled) await upsertCollector({ id: inst.id, enabled: false }, actor, source);
      return { ok: true, enabled: false, state: await notionCollectState() };
    }
    if ((await orgWorkspaces()).length === 0) {
      // 아직 동의 전 — 여기서 동의를 시작한다(토글이 곧 연결). 웹은 이 URL 을 새 탭으로 열고, 복귀 후 다시 켠다.
      const c = await startNotionPublicConsent(actor);
      return { ok: false, needs_connect: true, authorization_url: c.authorizationUrl, state: await notionCollectState() };
    }
    const r = await enableCollector(actor, source);
    return { ok: true, enabled: true, ...r, state: await notionCollectState() };
  },
};

const orgNotionCollectConnect: Capability = {
  name: "org_notion_collect_connect", title: "노션 팀 자료 연결(범위 선택) 시작",
  description: "노션 공개 통합 동의를 시작한다(admin) — 반환된 authorization_url 의 노션 화면에서 모을 페이지를 고르면 조직 수집 슬롯이 저장·갱신된다. 이미 연결된 뒤에도 부르면 [페이지 더 고르기](재동의)가 된다.",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/notion/collect/connect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const c = await startNotionPublicConsent(user.userId);
    return { ok: true, authorization_url: c.authorizationUrl, message: "이 URL 의 노션 화면에서 모을 페이지를 고르고 허용하세요 — 완료되면 자동으로 저장됩니다." };
  },
};

// 매니지드 릴레이 완료(#1881 N4) — CP 가 admin 토큰으로 부른다. state 검증·저장은 브로커(completeNotionInstall). 응답에 토큰 없음.
const orgNotionOauthComplete: Capability = {
  name: "org_notion_oauth_complete", title: "노션 OAuth 릴레이 완료(CP 전용)",
  description: "라이블리 컨트롤플레인이 노션과 교환한 /v1/oauth/token 응답을 이 게이트웨이의 서명 state 와 함께 넣는다. 조직 수집 슬롯(notion_public, scope_key=workspace_id)에 저장한다. 사람이 직접 부를 일은 없다.",
  scope: "admin", input: { state: z.string().describe("이 게이트웨이가 발급한 서명 state"), token: z.record(z.unknown()).describe("노션 /v1/oauth/token 응답 JSON 원문") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/notion/oauth-complete"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    const i = (input ?? {}) as { state?: unknown; token?: unknown };
    if (typeof i.state !== "string" || !i.state) throw new HttpError(400, "state 는 필수입니다");
    if (!i.token || typeof i.token !== "object") throw new HttpError(400, "token(노션 응답)은 필수입니다");
    try {
      const r = await completeNotionInstall(i.state, i.token, user?.userId ?? "cp-relay");
      return { ok: true, member: r.memberId, workspace_id: r.workspace_id, workspace_name: r.workspace_name };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
};

export const notionConnectCapabilities: Capability[] = [orgNotionCollect, orgNotionCollectSet, orgNotionCollectConnect, orgNotionOauthComplete];

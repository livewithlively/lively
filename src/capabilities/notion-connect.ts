// 노션 "팀 자료로 모으기"(#1881 N3·N5·N7 백엔드) — 노션 수집기를 **토큰 복사 없이** 켠다.
//
//  슬랙(slack-connect.ts)과 같은 그림이되 연결의 결이 다르다: 슬랙은 구성원의 [Slack 연결](개인 금고)을 수집기가
//  가리키지만, 노션은 개인 MCP 연결(DCR)의 토큰이 REST 수집에 안 통한다(지식 notion-single-connect-design-1881 §1①).
//  그래서 토글 자체가 **라이블리 공개 통합 OAuth** 를 연다 — 노션 동의 화면의 페이지 선택기가 곧 수집 범위 선언이고,
//  토큰은 조직 슬롯(gateway, notion_public, scope_key=workspace_id)에 저장된다. 수집기는 token_source 로 그 슬롯을
//  가리킨다. 관리탭 ▸ 외부 자료 수집에 가서 내부 통합 시크릿을 붙여 넣는 5단계가 사라진다(오너 제한도 함께).
//
//  ★ 워크스페이스 하나당 수집기 하나다(#1881 N7). 예전엔 인스턴스를 하나(`lively-notion`)로 강제했는데, 그건
//   설계가 아니라 **미러 후처리가 인스턴스를 몰랐기 때문**이었다: 전체 스윕이 external_system='notion' 만 보고
//   돌아서, 워크스페이스가 둘이면 A 의 run 이 B 의 문서를 전부 아카이브하고 다음 run 에 B 가 A 를 죽였다.
//   그 두 쿼리를 external_instance 로 좁힌 뒤(v6/mirror/notion-post.ts) 제약이 사라졌으므로 N 개를 연다.
//   왜 '하나가 여러 워크스페이스를 순회'가 아니라 N 개인가: 커서·실행기록·켜고끄기·실패격리가 전부 수집기
//   인스턴스 단위(#1419)라, 순회형이면 한 워크스페이스의 실패가 전체 커서를 얼린다.
//
//  범위는 노션 쪽 페이지 선택이 정하므로 root_pages 를 두지 않는다(search 스윕이 공유된 범위만 돌려준다).
//  끄면 enabled=false 로 남긴다(삭제 아님 — 커서·자료가 남고 다시 켜면 이어받는다).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { listCollectors, upsertCollector, type CollectorView } from "../org/store/collectors.js";
import { listSecretsByKindPublic, GATEWAY_OWNER } from "../org/credentials/member-secret-store.js";
import { NOTION_PUBLIC_KIND } from "../org/credentials/notion-oauth.js";
import { startNotionPublicConsent, completeNotionInstall, notionPublicReady, onNotionInstalled } from "../org/credentials/oauth-broker.js";

/** 최초(단일 워크스페이스) 시절의 인스턴스 키 — 이미 만들어진 배포가 있으므로 이름을 바꾸지 않는다.
 *  instance_key 는 커서 네임스페이스라 생성 후 불변이고(org/store/collectors.ts), 바꾸면 전체 재수집이 된다. */
export const LEGACY_INSTANCE_KEY = "lively-notion";

/** 워크스페이스별 수집기의 키 — 사람이 로그·URL 에서 읽을 수 있게 짧게. uuid 앞 8자면 충돌이 실질적으로 없다. */
function keyForWorkspace(workspaceId: string): string {
  return `notion-${workspaceId.replace(/-/g, "").slice(0, 8)}`;
}

interface NotionWorkspaceRow { id: string; name: string | null; icon: string | null; connected_by: string | null; created_at: string | null; updated_at: string | null }

async function orgWorkspaces(): Promise<NotionWorkspaceRow[]> {
  const rows = await listSecretsByKindPublic(NOTION_PUBLIC_KIND).catch(() => []);
  return rows
    .filter((r) => r.owner === GATEWAY_OWNER && r.has_secret)
    .map((r) => ({
      id: r.scope_key,
      name: typeof r.meta.workspace_name === "string" ? r.meta.workspace_name : null,
      icon: typeof r.meta.workspace_icon === "string" ? r.meta.workspace_icon : null,
      connected_by: typeof r.meta.connected_by === "string" ? r.meta.connected_by : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
    // 연결된 **순서**로 — created_at 이 축이다. updated_at 으로 정렬하면 [페이지 더 고르기](재동의) 한 번에
    //  '첫 워크스페이스'가 뒤바뀌어, 옛 단일 수집기가 엉뚱한 워크스페이스에 붙는다(그 수집기의 미러는 그대로인 채로).
    .sort((a, b) => String(a.created_at ?? a.updated_at ?? "").localeCompare(String(b.created_at ?? b.updated_at ?? "")));
}

const notionCollectors = (all: CollectorView[]): CollectorView[] => all.filter((c) => c.preset_key === "notion");

/** 이 수집기가 지목한 워크스페이스 id — `org:<id>` 만 확정으로 본다(`org` 는 '아직 안 묶임'). */
function boundWorkspace(c: CollectorView): string | null {
  const s = String(c.config?.token_source ?? "").trim();
  return s.startsWith("org:") ? s.slice(4).trim() || null : null;
}

/**
 * 아직 아무 워크스페이스에도 묶이지 않은 수집기 중 **재사용해도 안전한 것**.
 *  ⓐ 예전 단일 인스턴스(`lively-notion`, token_source='org') — 이 자리의 자료를 그대로 물려받아야 한다.
 *  ⓑ 빈 껍데기 — CP 프로비저너가 새 워크스페이스마다 심어 두는 'Notion(토큰 붙여넣기)' 칸(instance_key='_').
 *     토큰도 없고 한 번도 안 돈 껍데기만 접수한다. 토큰이 들어 있거나 실행 이력이 있으면 **남의 살림**이므로
 *     건드리지 않는다(셀프호스팅에서 내부 통합 토큰으로 잘 돌던 수집기를 토글이 가로채면 안 된다).
 *  이걸 안 하면 화면에 노션 수집기가 둘 보인다 — 하나는 "토큰을 넣으세요" 안내가 붙은 빈 칸(#1881 매니지드 실측).
 */
function adoptable(all: CollectorView[], allowLegacy: boolean): CollectorView | null {
  const free = notionCollectors(all).filter((c) => !boundWorkspace(c));
  // 레거시는 **첫 워크스페이스에만** 붙인다(allowLegacy). 그 수집기엔 이미 자료가 쌓여 있고 스탬프 축은
  //  'default' 로 고정돼 있으므로, 두 번째 워크스페이스에 붙이면 A 의 자료가 B 의 수집기 밑으로 들어간다.
  if (allowLegacy) {
    const legacy = free.find((c) => c.instance_key === LEGACY_INSTANCE_KEY);
    if (legacy) return legacy;
  }
  return free.find((c) => c.instance_key !== LEGACY_INSTANCE_KEY && !c.secretsSet?.token && !c.last_run && !c.config?.token_source) ?? null;
}

export interface NotionWorkspaceState extends NotionWorkspaceRow {
  /** 이 워크스페이스를 모으는 수집기(없으면 아직 안 만들어짐 = 동의만 끝난 상태). */
  collector_id: number | null;
  enabled: boolean;
  /** 미러 스탬프 축(external_instance) — 스윕 범위가 이 값이다. 진단용으로 드러낸다. */
  instance: string | null;
}

export interface NotionCollectState {
  /** 하나라도 켜져 있으면 true — 화면의 대표 토글. */
  enabled: boolean;
  /** 연결된 노션 워크스페이스마다 한 줄(수집기 유무·켜짐 포함). 비어 있으면 아직 동의 전. */
  workspaces: NotionWorkspaceState[];
  /** 동의를 시작할 수 있는가 — 통합 client(직결) 또는 CP 릴레이가 있어야 한다. */
  ready: boolean;
}

export async function notionCollectState(): Promise<NotionCollectState> {
  const [all, ws] = await Promise.all([listCollectors(), orgWorkspaces()]);
  const byWs = new Map(notionCollectors(all).map((c) => [boundWorkspace(c), c] as const));
  const workspaces: NotionWorkspaceState[] = ws.map((w) => {
    const c = byWs.get(w.id);
    return {
      ...w,
      collector_id: c?.id ?? null,
      enabled: !!c?.enabled,
      instance: c ? (c.config?.instance ?? "default") : null,
    };
  });
  return {
    enabled: workspaces.some((w) => w.enabled),
    workspaces,
    ready: await notionPublicReady().catch(() => false),
  };
}

/**
 * 워크스페이스 하나를 수집기에 묶는다(없으면 만든다). 멱등.
 *
 *  ⚠ 이미 있는 수집기의 `config.instance` 는 **건드리지 않는다.** 그 값이 곧 그 수집기가 지금까지 쌓아 둔
 *   미러의 external_instance 스탬프이고, 바꾸는 순간 기존 자료가 스윕 범위 밖으로 떨어져 나간다(고아 + 중복 재수집).
 *   신규 생성일 때만 workspace_id 를 스탬프로 쓴다 — 그래서 새 배포는 깔끔한 워크스페이스 id 축을 갖고,
 *   기존 배포는 'default' 축을 그대로 유지한 채 두 번째 워크스페이스부터 갈린다(무이관·무손실).
 */
async function bindWorkspace(w: NotionWorkspaceRow, actor: string, source: string, enable: boolean, allowLegacy: boolean): Promise<CollectorView> {
  const all = await listCollectors();
  const existing = notionCollectors(all).find((c) => boundWorkspace(c) === w.id) ?? adoptable(all, allowLegacy);
  const label = w.name ? `Notion — ${w.name}` : "Notion — 팀 문서";
  const note = "[팀 자료로 모으기] 토글로 만들어진 수집기 — 노션 동의 화면에서 고른 페이지(와 그 하위)를 모읍니다(#1881). "
    + "토큰 칸은 비워 두세요(연결은 '토큰 출처'가 가리킵니다). 범위 변경은 [페이지 더 고르기]로.";
  // 토글 경로로 **처음 들어오는** 수집기면 안내문을 바꿔 준다 — CP 가 심어 둔 껍데기의 안내문은
  //  "노션 통합 토큰을 넣고 활성화하세요"라, 접수한 뒤에도 그대로 두면 없는 절차를 시키는 글이 남는다.
  const enteringToggle = !existing?.config?.token_source;
  return upsertCollector({
    id: existing?.id,
    preset_key: "notion",
    ...(existing ? {} : { key: keyForWorkspace(w.id), instance_key: keyForWorkspace(w.id) }),
    label: existing?.label && existing.label !== "Notion" ? existing.label : label,
    enabled: enable,
    config: {
      ...(existing?.config ?? {}),
      token_source: `org:${w.id}`,
      // 신규만 스탬프 지정 — 기존 수집기는 지금 축(대개 'default')을 지킨다. 위 주석의 이유.
      ...(existing ? {} : { instance: w.id }),
    },
    note: enteringToggle ? note : existing.note,
  }, actor, source);
}

/** 연결된 모든 워크스페이스에 수집기를 맞춘다. enable=null 이면 켜짐 상태를 건드리지 않는다(껍데기만 준비). */
async function syncCollectors(actor: string, source: string, enable: boolean | null): Promise<NotionWorkspaceState[]> {
  const ws = await orgWorkspaces();
  if (ws.length === 0) throw new HttpError(400, "노션 연결이 아직 없습니다 — 먼저 노션 동의 화면에서 모을 페이지를 골라 주세요.");
  for (const [i, w] of ws.entries()) {
    const all = await listCollectors();
    const cur = notionCollectors(all).find((c) => boundWorkspace(c) === w.id);
    // 이미 있으면 enable=null 일 때 그대로 둔다 — 관리자가 일부러 꺼 둔 것을 재동의가 조용히 되살리지 않는다.
    const target = enable === null ? (cur ? cur.enabled : true) : enable;
    await bindWorkspace(w, actor, source, target, i === 0);
  }
  return (await notionCollectState()).workspaces;
}

// ★ 동의가 끝나면 그 자리에서 끝난다 — 연결이 저장되는 순간 수집기를 준비한다.
//
//  사람이 [팀 자료로 모으기]를 켜서 시작한 흐름이다. 그런데 저장은 OAuth 콜백(다른 탭·매니지드면 다른
//  도메인)에서 끝나므로, 아무도 수집기를 켜 주지 않으면 **돌아온 화면의 체크박스가 풀려 있다**. 사용자는
//  실패한 줄 알고 한 번 더 누른다(#1881 매니지드 실측). 의도는 이미 표현됐으니 서버가 마무리한다.
//
//  ⚠ **이미 있는 수집기의 enabled 는 건드리지 않는다**(enable=null) — 관리자가 꺼 둔 것을 [페이지 더 고르기]
//   재동의가 되살리면 안 된다. 새로 연결된 워크스페이스만 켜진 채로 만들어진다.
onNotionInstalled(async (memberId) => {
  await syncCollectors(memberId, "oauth", null);
});

const orgNotionCollect: Capability = {
  name: "org_notion_collect", title: "노션 팀 자료 수집 상태",
  description: "\"팀 자료로 모으기\" 상태 — 연결된 노션 워크스페이스마다 수집기 유무·켜짐 여부, 동의 시작 가능 여부. 토글은 org_notion_collect_set, 워크스페이스 추가·범위 재선택은 org_notion_collect_connect.",
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
    "authorization_url 을 돌려준다 — 그 URL 의 노션 화면에서 모을 페이지를 고르고 [허용]하면 연결이 저장되고 수집기가 " +
    "자동으로 준비된다(token_source=org:<workspace_id>, 토큰 복사 0). workspace_id 를 주면 그 워크스페이스만, " +
    "안 주면 연결된 전부를 켜고 끈다. 끄기는 삭제가 아니다 — 커서·자료가 남고 다시 켜면 이어받는다.",
  scope: "admin",
  input: {
    enabled: z.boolean().describe("true=켜기 · false=끄기"),
    workspace_id: z.string().optional().describe("노션 워크스페이스 id — 지정하면 그 워크스페이스만(생략 시 전체)"),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/notion/collect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as { enabled?: unknown; workspace_id?: unknown };
    const enabled = i.enabled === true;
    const wantWs = typeof i.workspace_id === "string" && i.workspace_id.trim() ? i.workspace_id.trim() : null;
    const actor = user.userId;
    const source = ctx?.source ?? "web";

    if (!enabled) {
      // ⚠ **토글이 묶은 수집기만** 끈다(bound != null). 셀프호스팅에서 내부 통합 토큰을 직접 넣어 돌리던
      //  노션 수집기까지 이 토글이 끄면, 관리자가 만지지도 않은 수집이 조용히 멈춘다.
      for (const c of notionCollectors(await listCollectors())) {
        const bound = boundWorkspace(c);
        if (!bound) continue;
        if (wantWs && bound !== wantWs) continue;
        if (c.enabled) await upsertCollector({ id: c.id, enabled: false }, actor, source);
      }
      return { ok: true, enabled: false, state: await notionCollectState() };
    }

    const ws = await orgWorkspaces();
    if (ws.length === 0) {
      // 아직 동의 전 — 여기서 동의를 시작한다(토글이 곧 연결). 웹은 이 URL 을 새 탭으로 열고, 복귀 후 다시 켠다.
      const c = await startNotionPublicConsent(actor);
      return { ok: false, needs_connect: true, authorization_url: c.authorizationUrl, state: await notionCollectState() };
    }
    if (wantWs) {
      const idx = ws.findIndex((x) => x.id === wantWs);
      if (idx < 0) throw new HttpError(404, `연결된 노션 워크스페이스가 아닙니다: ${wantWs}`);
      await bindWorkspace(ws[idx], actor, source, true, idx === 0);
    } else {
      await syncCollectors(actor, source, true);
    }
    const state = await notionCollectState();
    return { ok: true, enabled: true, state };
  },
};

const orgNotionCollectConnect: Capability = {
  name: "org_notion_collect_connect", title: "노션 팀 자료 연결(워크스페이스 추가·범위 선택) 시작",
  description: "노션 공개 통합 동의를 시작한다(admin) — 반환된 authorization_url 의 노션 화면에서 워크스페이스를 고르고 모을 페이지를 고르면 조직 수집 슬롯이 저장·갱신되고 그 워크스페이스의 수집기가 준비된다. 이미 연결된 워크스페이스를 다시 고르면 [페이지 더 고르기](범위 재선언), 다른 워크스페이스를 고르면 **추가 연결**이 된다.",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/notion/collect/connect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const c = await startNotionPublicConsent(user.userId);
    return { ok: true, authorization_url: c.authorizationUrl, message: "이 URL 의 노션 화면에서 워크스페이스와 모을 페이지를 고르고 허용하세요 — 완료되면 자동으로 저장됩니다. 다른 워크스페이스를 고르면 추가로 연결됩니다." };
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

/** 테스트 훅 — 순수 판정(워크스페이스 결속·접수 대상·키 생성). 프로덕션 코드에서 사용 금지. */
export const __notionCollectTestables = { boundWorkspace, adoptable, keyForWorkspace };

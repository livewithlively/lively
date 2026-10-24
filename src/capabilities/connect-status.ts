// org_connect_status — 외부 앱 연결 상태를 **한 번에**(#4970). 연결 스킬(liv-connect)의 첫 걸음.
//
//  왜 따로 있나: 앱마다 상태 도구가 따로다(org_slack_collect · org_notion_collect · org_google_collect · org_<앱>_collect …).
//   스킬이 그걸 하나씩 부르면 아홉 번 왕복하고, 앱마다 응답 모양이 달라 «다음에 뭘 하나»를 스킬 본문이 다시 판정하게 된다.
//   여기서 기존 상태 함수를 그대로 불러 공통 사실(앱 준비 · 내 연결 · 수집 중)로 옮기고, 판정은 순수 함수에 맡긴다 —
//   앱마다 길과 상태 · 권하는 길(#4970, org/connect-routes.ts decideRoutes)이 화면과 스킬의 정본이다.
//   옛 «다음 걸음» 한 칸(next — org/connect-next.ts decideConnectNext)은 그것을 읽던 쪽이 남아 있을 수 있어 함께 싣는다
//   (같은 판정이 두 벌이라 라이블리 앱 길과 next 가 어긋나지 않는지 connect-status.test 가 교차로 본다). 앱 상태의 SoT 는 각 앱 파일이다.
//
//  앱 하나의 조회가 실패해도 나머지는 돌려준다(fail-open, 그 앱만 error). 연결 안내가 앱 하나 때문에 통째로 멈추면 안 된다.
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { canManageWorkspace, isAdmin } from "./principal.js";
import { gatewayUrl } from "../gateway-url.js";
import { connectVariant } from "../org/delivery/connect-skills.js";
import { decideConnectNext, type ConnectNext } from "../org/connect-next.js";
import { slackCollectState } from "./slack-connect.js";
import { notionCollectState } from "./notion-connect.js";
import { googleCollectState } from "./google-connect.js";
import {
  clickupCollectCapabilities, figmaCollectCapabilities, githubCollectCapabilities, gitlabCollectCapabilities,
  linearCollectCapabilities, outlookCollectCapabilities,
} from "./member-collect-apps.js";
import { githubAppReady } from "../org/credentials/oauth-broker.js";
import { decideRoutes, type AppRouteFacts, type ConnectRoute } from "../org/connect-routes.js";
import { registrationView, type RegistrationView } from "../org/connect-registration.js";
import { registrationEditable } from "../org/connect-unregister.js";
import { memberAiConnectorsPolicy, listMemberAiConnectors, type AiConnectorStatus } from "../org/store/member-ai-connectors.js";
import { connectorOfApp } from "../org/collect/connector-names.js";
import { listMemberSecretsPublic, memberOwner } from "../org/credentials/member-secret-store.js";
import { GITHUB_TOKEN_KIND, isGithubAppToken, pickGithubSlot } from "../org/credentials/github-token-source.js";
import { secretsEnabled } from "../org/credentials/secret-box.js";
import { getOrgProfile } from "../org/store.js";

interface Probe {
  app_ready: boolean; me_connected: boolean; collecting: boolean; note?: string | null;
  /** 수집기가 누구 연결로 도나(구성원 토큰 수집기의 member) — 모르면 null. */
  runner?: string | null;
  /**
   * (#4970 길) 앱 연결과 개인 토큰이 한 수집기를 함께 쓰는 앱(깃허브) — 내 연결이 어느 쪽인가(app · token)와,
   *  모으는 중이면 수집기가 실제로 쓰는 칸이 어느 쪽인가(collecting — 모으는 사람의 칸을 수집기와 같은 규칙 pickGithubSlot 으로 고른다).
   */
  via?: { app: boolean; token: boolean; collecting?: "app" | "token" | null };
}

interface AppSpec {
  app: string;
  label: string;
  /** 앱 등록(OAuth 앱 client)이 있어야 연결할 수 있는가. 개인 토큰 앱·토큰으로도 되는 앱은 false. */
  needsApp: boolean;
  /** 앱 등록에 필요한 권한 — admin(org_credential_set) | manage(워크스페이스 관리, org_github_app_register). */
  registerBy: "admin" | "manage";
  probe: (user: LivelyUser) => Promise<Probe>;
  /**
   * (#4970) 이 앱에 있는 «길» — 우선순위 판정은 org/connect-routes.ts.
   *  app = 라이블리 앱(OAuth 앱 · 공식 API) · aiApp = 구성원 Claude 커넥터로 모으는 앱 키(수집은 슬랙·지메일·노션만 — web/lib/claude-connectors CLAUDE_COLLECT_APP_KEYS)
   *  · token = 개인 토큰·API 키.
   */
  routes: { app?: true; aiApp?: string; token?: true };
}

/**
 * (#4970 길) 깃허브 — 내 연결이 앱 연결인가 개인 토큰인가. 순수.
 *  같은 금고 칸(github_pat)에 두 형태가 산다: [GitHub 연결]이 저장한 **토큰 묶음**(scope_key "" · meta 에 token_type·expires_at —
 *  oauth-broker tokenMeta)과 사람이 붙여 넣은 **개인 토큰**(연결 스킬은 scope_key "" 로, 옛 수집기 폼은 호스트로 · meta 는 헤더 모양만).
 *  그래서 scope_key 로는 못 가르고 meta 로 가른다.
 */
export function githubViaOf(rows: ReadonlyArray<GithubRow>): { app: boolean; token: boolean } {
  const mine = rows.filter((r) => r.kind === GITHUB_TOKEN_KIND && r.has_secret);
  return { app: mine.some((r) => isGithubAppToken(r)), token: mine.some((r) => !isGithubAppToken(r)) };
}

type GithubRow = { kind: string; scope_key: string; has_secret: boolean; meta: Record<string, unknown> };

/** (#4970 길) 깃허브 수집기가 이 사람의 칸 중 실제로 쓰는 것이 앱 연결인가 개인 토큰인가 — 수집기와 같은 규칙(pickGithubSlot: 호스트 칸 → "" 칸 → 아무거나). 순수. */
export function githubSlotKindOf(rows: ReadonlyArray<GithubRow>): "app" | "token" | null {
  const slot = pickGithubSlot(rows, "github.com");
  return slot ? (isGithubAppToken(slot) ? "app" : "token") : null;
}

/** makeMemberTokenCollect 가 만든 상태 도구(org_<앱>_collect)를 그대로 부른다 — 상태 계산을 여기서 다시 하지 않는다. */
function memberCollectProbe(caps: Capability[], system: string): (user: LivelyUser) => Promise<Probe> {
  const get = caps.find((c) => c.name === `org_${system}_collect`);
  if (!get) throw new Error(`org_${system}_collect 가 없다`);
  return async (user) => {
    const s = await get.handler({}, user) as { enabled?: boolean; me_connected?: boolean; app_ready?: boolean; needs_scope?: boolean; member?: string | null };
    return {
      app_ready: s.app_ready === undefined ? true : !!s.app_ready,
      me_connected: !!s.me_connected,
      collecting: !!s.enabled,
      runner: typeof s.member === "string" && s.member ? s.member : null,
      note: s.enabled && s.needs_scope ? "수집은 켜져 있지만 모을 범위가 비어 있습니다" : null,
    };
  };
}

// 순서 = 화면·스킬이 보여 줄 순서. 앱 스킬은 liv-connect-<app>(connect-skills.ts 카탈로그와 같은 키).
export const CONNECT_APPS: readonly AppSpec[] = [
  {
    app: "slack", label: "슬랙", needsApp: true, registerBy: "admin", routes: { app: true, aiApp: "slack" },
    probe: async (user) => {
      const s = await slackCollectState(user.userId);
      const collecting = s.search.enabled || s.bot.enabled;
      return {
        app_ready: s.app_ready, me_connected: s.me_connected, collecting,
        note: collecting && !s.bot.available ? "봇이 아직 설치되지 않아, 공개 채널만 모읍니다" : null,
      };
    },
  },
  {
    app: "notion", label: "노션", needsApp: true, registerBy: "admin", routes: { app: true, aiApp: "notion" },
    probe: async () => {
      const s = await notionCollectState();
      // 노션 연결은 사람이 아니라 **노션 워크스페이스** 단위다(동의 화면에서 고른 페이지가 곧 범위) — 연결된 워크스페이스가 있으면 연결됨.
      return { app_ready: s.ready, me_connected: s.workspaces.length > 0, collecting: s.enabled };
    },
  },
  { app: "linear", label: "리니어", needsApp: true, registerBy: "admin", routes: { app: true }, probe: memberCollectProbe(linearCollectCapabilities, "linear") },
  {
    app: "github", label: "깃허브", needsApp: false, registerBy: "manage", routes: { app: true, token: true },
    probe: async (user) => {
      const base = await memberCollectProbe(githubCollectCapabilities, "github")(user);
      // GitHub App 이 없어도 개인 토큰으로 연결된다 — 그래서 막지 않고(needsApp=false) 준비 여부만 알린다.
      const ready = await githubAppReady().catch(() => false);
      const rows = await listMemberSecretsPublic(memberOwner(user.userId)).catch(() => []);
      //  모으는 중이면 모으는 사람의 칸을 본다 — 남이 개인 토큰으로 모으는데 내 연결로 «앱으로 모으는 중» 이라 말하지 않게.
      const runnerRows = base.collecting && base.runner
        ? (base.runner === user.userId ? rows : await listMemberSecretsPublic(memberOwner(base.runner)).catch(() => null))
        : null;
      const via = { ...githubViaOf(rows), collecting: runnerRows ? githubSlotKindOf(runnerRows) : null };
      return { ...base, app_ready: ready, via, note: base.note ?? (ready ? null : "GitHub App 이 아직 없어 개인 토큰으로 연결합니다(관리자가 앱을 등록하면 저장소를 골라 연결할 수 있습니다)") };
    },
  },
  { app: "gitlab", label: "깃랩", needsApp: false, registerBy: "manage", routes: { token: true }, probe: memberCollectProbe(gitlabCollectCapabilities, "gitlab") },
  {
    app: "google", label: "구글", needsApp: true, registerBy: "admin", routes: { app: true, aiApp: "gmail" },
    probe: async (user) => {
      const s = await googleCollectState(user.userId);
      return { app_ready: s.ready, me_connected: !!s.connected, collecting: s.collectors.some((c) => c.enabled) };
    },
  },
  { app: "outlook", label: "아웃룩", needsApp: true, registerBy: "admin", routes: { app: true }, probe: memberCollectProbe(outlookCollectCapabilities, "outlook") },
  { app: "clickup", label: "클릭업", needsApp: false, registerBy: "manage", routes: { token: true }, probe: memberCollectProbe(clickupCollectCapabilities, "clickup") },
  { app: "figma", label: "피그마", needsApp: false, registerBy: "manage", routes: { token: true }, probe: memberCollectProbe(figmaCollectCapabilities, "figma") },
];

export interface ConnectAppStatus {
  app: string;
  label: string;
  skill: string;
  /** 이 사람이 이 앱을 등록할 수 있는가(셀프호스트에서 앱이 아직 없을 때 의미가 있다). */
  can_register: boolean;
  app_ready: boolean | null;
  me_connected: boolean | null;
  collecting: boolean | null;
  next: ConnectNext | null;
  connect_url: string | null;
  note: string | null;
  /** (#4970) 이 앱의 길 — 우선순위 순서(app → ai → token, 있는 것만). 화면·스킬은 이것만 읽는다. 조회 실패면 null. */
  routes: ConnectRoute[] | null;
  /** 권하는 길(routes 의 자리) · 그보다 앞의 막힌 길들(관리자에게 요청 · 라이블리 준비 중 · 꺼짐). */
  recommended: number | null;
  blocked_before: number[] | null;
  /** 라이블리 앱 길이 «앱 등록»·«관리자에게 요청»(앱 미준비)일 때만 — 등록 안내(화면 앱 등록 칸 · 스킬 앱 등록 절과 같은 데이터). */
  registration?: RegistrationView | null;
  /**
   * (#4991) 등록한 뒤의 «앱 등록 보기 · 바꾸기 · 지우기» 를 이 사람에게 보이나 — 셀프호스트(회사가 앱을 쥔다) · 등록할 수 있는 사람 ·
   *  앱이 준비됨 · 이 서버가 그 앱을 쥠(릴레이 아님). 매니지드는 라이블리 클라우드가 앱을 쥐어 늘 false 다.
   */
  can_edit_registration: boolean;
  error?: string;
}

/**
 * (#4970 길) 내 커넥터 기록 → 이름별 상태. 순수. 기록의 앱 이름은 claude.ai 가 보여 주는 이름 그대로다(Slack · Gmail · Google Drive —
 *  schema/member-ai-connector 머리말 «우리 앱 키로 바꾸지 않는다, 매핑은 읽는 쪽의 몫»). 그래서 대소문자를 접어 두고,
 *  찾을 때는 커넥터 이름 표(connectorOfApp — 수집 단위와 같은 표)로 앱 키를 이름으로 바꿔 찾는다(aiStatusOf).
 */
export function aiStatusByName(connectors: ReadonlyArray<{ app: string; status: AiConnectorStatus }>): Map<string, AiConnectorStatus> {
  return new Map(connectors.map((c) => [String(c.app).trim().toLowerCase(), c.status]));
}
export function aiStatusOf(byName: ReadonlyMap<string, AiConnectorStatus> | null, aiApp: string): AiConnectorStatus | null {
  if (!byName) return null;
  return byName.get(connectorOfApp(aiApp).trim().toLowerCase()) ?? null;
}

/** (#4970 길) 마지막 커넥터 확인 → 서버에서 이 사람의 Claude 로그인. 순수. 로그인 사유가 아닌 실패(시간 초과 등)는 모른다(null). */
export function claudeLoginOf(scan: { ok: boolean; error: string | null } | null | undefined): boolean | null {
  if (!scan) return null;
  if (scan.ok) return true;
  return scan.error === "not-logged-in" || scan.error === "not-claude-ai-login" ? false : null;
}

/** (#4970) 프로브 결과 → 길 사실. 순수 — 시험이 직접 부른다. */
export function routeFactsOf(
  spec: Pick<AppSpec, "routes">, p: Probe,
  ctx: {
    heldBy: "lively" | "workspace"; canRegister: boolean; canCollect: boolean;
    aiPolicy: "allowed" | "blocked" | "unknown"; aiMine: ReadonlyMap<string, AiConnectorStatus> | null; aiLogin?: boolean | null;
  },
): AppRouteFacts {
  const f: AppRouteFacts = {};
  //  한 수집기를 앱 연결·개인 토큰이 함께 쓰는 앱(깃허브): 모으는 중이면 어느 길로인가 — 수집기가 실제로 쓰는 칸(via.collecting)이 정본이다.
  //   그걸 못 읽었으면 앱이 없으면 토큰, 내가 토큰만 있으면 토큰, 그 밖엔 앱으로 어림한다.
  const shared = !!(spec.routes.app && spec.routes.token);
  const viaToken = !shared ? p.collecting
    : !p.collecting ? false
    : p.via?.collecting ? p.via.collecting === "token" || !p.app_ready
    : (!!p.via?.token && !p.via?.app) || !p.app_ready;
  if (spec.routes.app) {
    f.app = {
      ready: p.app_ready, heldBy: ctx.heldBy, canRegister: ctx.canRegister, canCollect: ctx.canCollect,
      meConnected: shared ? !!p.via?.app : p.me_connected,
      collecting: shared ? p.collecting && !viaToken : p.collecting,
    };
  }
  if (spec.routes.aiApp) {
    f.ai = { aiApp: spec.routes.aiApp, policy: ctx.aiPolicy, mine: aiStatusOf(ctx.aiMine, spec.routes.aiApp), login: ctx.aiLogin ?? null };
  }
  if (spec.routes.token) {
    f.token = { canCollect: ctx.canCollect, meConnected: shared ? !!p.via?.token : p.me_connected, collecting: shared ? viaToken : p.collecting };
  }
  return f;
}

const orgConnectStatus: Capability = {
  name: "org_connect_status", title: "외부 앱 연결 상태(한 번에)",
  description:
    "외부 앱 연결 상태를 앱마다 한 번에 돌려준다 — 연결 스킬(liv-connect)의 첫 걸음. " +
    "prereq{vault_ready(자격 금고 키 — 없으면 어떤 연결도 저장 못 함)·callback_url(외부 앱에 등록할 콜백 주소, gateway_url 미설정이면 null)} · " +
    "can_collect(수집 켜기 가능) · apps[]{app·label·skill(넘길 스킬)·connect_url(라이블리 화면 절대 주소)·note · " +
    "routes[](연결할 수 있는 길, 우선순위 순: kind app=라이블리 앱 · ai=구성원 Claude 커넥터(ai_app) · token=개인 토큰 / " +
    "state collecting·set_scope·connected·connect·register·reconnect·ask_admin·preparing·off / needs=claude_login 이면 Claude 로그인부터 / " +
    "off 면 off_reason=blocked(관리자가 끔)·unknown(설정을 못 읽음 — 관리자가 껐다고 말하지 않는다)) · " +
    "recommended(권하는 길의 자리) · blocked_before(그 앞의 막힌 길) · registration(앱 등록 안내 — 라이블리 앱 길이 register·ask_admin 일 때만) · " +
    "can_edit_registration(셀프호스트에서 등록한 앱을 이 사람이 보고 바꾸고 지울 수 있나 — org_connect_registration · org_connect_unregister)}. " +
    "옛 칸(variant·next·app_ready·me_connected·collecting·can_register)도 함께 온다. 앱 하나의 조회가 실패해도 나머지는 돌려준다(그 앱만 error · routes=null).",
  scope: "memory", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/connect-status"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const variant = connectVariant();
    const canCollect = canManageWorkspace(user);
    const admin = isAdmin(user);
    const base = await gatewayUrl().catch(() => null);
    // 콜백 주소는 **org_profile.gateway_url** 만 본다 — 서버가 OAuth redirect_uri 로 실제 쓰는 값이 그것이다(oauth-broker callbackUrl).
    //  사람에게 줄 링크(base)는 PUBLIC_URL 로 폴백될 수 있어 콜백 근거로 쓰면 외부 앱에 엉뚱한 주소를 등록하게 된다.
    const profileUrl = await getOrgProfile().then((p) => p.gateway_url ?? null).catch(() => null);
    let callbackUrl: string | null = null;
    try { callbackUrl = profileUrl ? new URL("/oauth/callback", profileUrl).toString() : null; } catch { callbackUrl = null; }
    //  (#4970 길) 배포 차이는 «라이블리 앱을 누가 쥐나» 하나로만 길 판정에 들어간다.
    const heldBy = variant === "managed" ? "lively" as const : "workspace" as const;
    //  구성원 Claude 커넥터 — 정책(못 읽으면 unknown = 막음) · 내 커넥터 상태(못 읽으면 null = «연결» 로 권한다, R14).
    //  마지막 확인(scan)으로 서버의 Claude 로그인도 본다 — 로그인이 없으면 Claude 길의 첫 걸음이 «로그인» 이다.
    const [aiPolicy, aiMe] = await Promise.all([
      memberAiConnectorsPolicy().catch(() => "unknown" as const),
      listMemberAiConnectors({ memberId: user.userId }).then((ms) => ms[0] ?? null).catch(() => undefined),
    ]);
    const aiMine = aiMe === undefined ? null : aiStatusByName(aiMe?.connectors ?? []);
    const aiLogin = aiMe === undefined ? null : claudeLoginOf(aiMe?.scan);
    const apps = await Promise.all(CONNECT_APPS.map(async (a): Promise<ConnectAppStatus> => {
      const canRegister = a.registerBy === "admin" ? admin : canCollect;
      const common = {
        app: a.app, label: a.label, skill: `liv-connect-${a.app}`, can_register: canRegister,
        connect_url: base ? `${base.replace(/\/+$/, "")}/ui/#/connect/${a.app}` : null,
      };
      try {
        const p = await a.probe(user);
        const next = decideConnectNext({
          variant, needsApp: a.needsApp, appReady: p.app_ready,
          canRegister, canCollect, meConnected: p.me_connected, collecting: p.collecting,
        });
        const d = decideRoutes(routeFactsOf(a, p, { heldBy, canRegister, canCollect, aiPolicy, aiMine, aiLogin }));
        const appRoute = d.routes.find((r) => r.kind === "app");
        const registration = appRoute && !p.app_ready && (appRoute.state === "register" || appRoute.state === "ask_admin")
          ? registrationView(a.app, { callbackUrl, gatewayUrl: profileUrl }) : null;
        const canEditRegistration = registrationEditable({ app: a.app, heldBy, canRegister, appReady: p.app_ready });
        return {
          ...common, app_ready: p.app_ready, me_connected: p.me_connected, collecting: p.collecting, next, note: p.note ?? null,
          routes: d.routes, recommended: d.recommended, blocked_before: d.blocked_before, ...(registration ? { registration } : {}),
          can_edit_registration: canEditRegistration,
        };
      } catch (e) {
        return {
          ...common, app_ready: null, me_connected: null, collecting: null, next: null, note: null,
          routes: null, recommended: null, blocked_before: null, can_edit_registration: false, error: (e as Error)?.message?.slice(0, 200) ?? "조회 실패",
        };
      }
    }));
    return { variant, prereq: { vault_ready: secretsEnabled(), callback_url: callbackUrl }, can_collect: canCollect, gateway_url: base, apps };
  },
};

export const connectStatusCapabilities: Capability[] = [orgConnectStatus];

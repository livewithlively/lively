// org_connect_status — 외부 앱 연결 상태를 **한 번에**(#4970). 연결 스킬(liv-connect)의 첫 걸음.
//
//  왜 따로 있나: 앱마다 상태 도구가 따로다(org_slack_collect · org_notion_collect · org_google_collect · org_<앱>_collect …).
//   스킬이 그걸 하나씩 부르면 아홉 번 왕복하고, 앱마다 응답 모양이 달라 «다음에 뭘 하나»를 스킬 본문이 다시 판정하게 된다.
//   여기서 기존 상태 함수를 그대로 불러 공통 사실(앱 준비 · 내 연결 · 수집 중)로 옮기고, 판정은 순수 함수 하나
//   (org/connect-next.ts decideConnectNext)에 맡긴다. 새 판정을 만들지 않는다 — 앱 상태의 SoT 는 각 앱 파일이다.
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
import { secretsEnabled } from "../org/credentials/secret-box.js";
import { getOrgProfile } from "../org/store.js";

interface Probe { app_ready: boolean; me_connected: boolean; collecting: boolean; note?: string | null }

interface AppSpec {
  app: string;
  label: string;
  /** 앱 등록(OAuth 앱 client)이 있어야 연결할 수 있는가. 개인 토큰 앱·토큰으로도 되는 앱은 false. */
  needsApp: boolean;
  /** 앱 등록에 필요한 권한 — admin(org_credential_set) | manage(워크스페이스 관리, org_github_app_register). */
  registerBy: "admin" | "manage";
  probe: (user: LivelyUser) => Promise<Probe>;
}

/** makeMemberTokenCollect 가 만든 상태 도구(org_<앱>_collect)를 그대로 부른다 — 상태 계산을 여기서 다시 하지 않는다. */
function memberCollectProbe(caps: Capability[], system: string): (user: LivelyUser) => Promise<Probe> {
  const get = caps.find((c) => c.name === `org_${system}_collect`);
  if (!get) throw new Error(`org_${system}_collect 가 없다`);
  return async (user) => {
    const s = await get.handler({}, user) as { enabled?: boolean; me_connected?: boolean; app_ready?: boolean; needs_scope?: boolean };
    return {
      app_ready: s.app_ready === undefined ? true : !!s.app_ready,
      me_connected: !!s.me_connected,
      collecting: !!s.enabled,
      note: s.enabled && s.needs_scope ? "수집은 켜져 있지만 모을 범위가 비어 있습니다" : null,
    };
  };
}

// 순서 = 화면·스킬이 보여 줄 순서. 앱 스킬은 liv-connect-<app>(connect-skills.ts 카탈로그와 같은 키).
export const CONNECT_APPS: readonly AppSpec[] = [
  {
    app: "slack", label: "슬랙", needsApp: true, registerBy: "admin",
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
    app: "notion", label: "노션", needsApp: true, registerBy: "admin",
    probe: async () => {
      const s = await notionCollectState();
      // 노션 연결은 사람이 아니라 **노션 워크스페이스** 단위다(동의 화면에서 고른 페이지가 곧 범위) — 연결된 워크스페이스가 있으면 연결됨.
      return { app_ready: s.ready, me_connected: s.workspaces.length > 0, collecting: s.enabled };
    },
  },
  { app: "linear", label: "리니어", needsApp: true, registerBy: "admin", probe: memberCollectProbe(linearCollectCapabilities, "linear") },
  {
    app: "github", label: "깃허브", needsApp: false, registerBy: "manage",
    probe: async (user) => {
      const base = await memberCollectProbe(githubCollectCapabilities, "github")(user);
      // GitHub App 이 없어도 개인 토큰으로 연결된다 — 그래서 막지 않고(needsApp=false) 준비 여부만 알린다.
      const ready = await githubAppReady().catch(() => false);
      return { ...base, app_ready: ready, note: base.note ?? (ready ? null : "GitHub App 이 아직 없어 개인 토큰으로 연결합니다(관리자가 앱을 등록하면 저장소를 골라 연결할 수 있습니다)") };
    },
  },
  { app: "gitlab", label: "깃랩", needsApp: false, registerBy: "manage", probe: memberCollectProbe(gitlabCollectCapabilities, "gitlab") },
  {
    app: "google", label: "구글", needsApp: true, registerBy: "admin",
    probe: async (user) => {
      const s = await googleCollectState(user.userId);
      return { app_ready: s.ready, me_connected: !!s.connected, collecting: s.collectors.some((c) => c.enabled) };
    },
  },
  { app: "outlook", label: "아웃룩", needsApp: true, registerBy: "admin", probe: memberCollectProbe(outlookCollectCapabilities, "outlook") },
  { app: "clickup", label: "클릭업", needsApp: false, registerBy: "manage", probe: memberCollectProbe(clickupCollectCapabilities, "clickup") },
  { app: "figma", label: "피그마", needsApp: false, registerBy: "manage", probe: memberCollectProbe(figmaCollectCapabilities, "figma") },
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
  error?: string;
}

const orgConnectStatus: Capability = {
  name: "org_connect_status", title: "외부 앱 연결 상태(한 번에)",
  description:
    "외부 앱 연결 상태를 앱마다 한 번에 돌려준다 — 연결 스킬(liv-connect)의 첫 걸음. variant(managed=라이블리 클라우드 · selfhost=직접 설치) · " +
    "prereq{vault_ready(자격 금고 키 — 없으면 어떤 연결도 저장 못 함)·callback_url(외부 앱에 등록할 콜백 주소, gateway_url 미설정이면 null)} · " +
    "can_collect(수집 켜기 가능) · apps[]{app·label·skill(넘길 스킬)·can_register(앱 등록 가능)·app_ready·me_connected·collecting·" +
    "next(register_app|ask_admin|preparing|connect|set_scope|collecting)·connect_url(라이블리 화면 절대 주소)·note}. " +
    "앱 하나의 조회가 실패해도 나머지는 돌려준다(그 앱만 error).",
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
        return { ...common, app_ready: p.app_ready, me_connected: p.me_connected, collecting: p.collecting, next, note: p.note ?? null };
      } catch (e) {
        return { ...common, app_ready: null, me_connected: null, collecting: null, next: null, note: null, error: (e as Error)?.message?.slice(0, 200) ?? "조회 실패" };
      }
    }));
    return { variant, prereq: { vault_ready: secretsEnabled(), callback_url: callbackUrl }, can_collect: canCollect, gateway_url: base, apps };
  },
};

export const connectStatusCapabilities: Capability[] = [orgConnectStatus];

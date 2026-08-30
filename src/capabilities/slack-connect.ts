// "팀 자료로 모으기"(#1881) — 슬랙 수집기를 **토큰 복사 없이** 켠다.
//
//  구성원이 [Slack 연결](me_oauth_connect, auth_kind=slack_oauth)을 마치면 그 사람 금고에 유저 토큰, 조직 슬롯에 봇 토큰이
//  이미 있다. 관리자가 토글 하나를 켜면 이 capability 가 수집기 인스턴스를 만들고 token_source 로 금고를 가리킨다 —
//  관리탭 ▸ 외부 자료 수집 에 가서 xoxp 를 붙여 넣는 단계가 사라진다(컴맹 페르소나의 탈락 지점이 그 단계였다).
//
//  인스턴스는 둘이다(#1531 상보 규약 — 커서가 갈려 서로 안 민다):
//   · `lively-search` — 켠 관리자의 유저 토큰으로 전 공개채널 검색 스윕(token_source=member:<id>)
//   · `lively-bot`    — 라이블리 앱 봇 토큰으로 봇 초대 채널(비공개 포함) 스윕(token_source=bot). 봇 토큰이 있을 때만 켠다.
//  끄면 enabled=false 로 남긴다(삭제 아님 — 커서·자료가 남고 다시 켜면 이어받는다).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { listCollectors, upsertCollector, type CollectorView } from "../org/store/collectors.js";
import { getMemberSecret, listSecretsByKindPublic, memberOwner, GATEWAY_OWNER } from "../org/credentials/member-secret-store.js";
import { SLACK_BOT_KIND, buildSlackAppManifest, slackAppCreateUrl } from "../org/credentials/slack-oauth.js";
import { getOrgProfile } from "../org/store.js";
import { completeSlackInstall } from "../org/credentials/oauth-broker.js";

export const SEARCH_INSTANCE = "lively-search";
export const BOT_INSTANCE = "lively-bot";

function findInstance(all: CollectorView[], instanceKey: string): CollectorView | undefined {
  return all.find((c) => c.preset_key === "slack" && c.instance_key === instanceKey);
}
function tokenSourceMember(c: CollectorView | undefined): string | null {
  const ts = c?.config?.token_source ?? "";
  return ts.startsWith("member:") ? ts.slice("member:".length) : null;
}

export interface SlackCollectState {
  /** 검색 수집기(공개채널) — 켜져 있으면 누구의 연결로 도는지. */
  search: { enabled: boolean; collector_id: number | null; member: string | null; member_connected: boolean | null };
  /** 봇 수집기(초대 채널·비공개) — 봇 토큰이 있어야 켤 수 있다. */
  bot: { enabled: boolean; collector_id: number | null; available: boolean; team_ids: string[] };
  /** 호출자 본인이 Slack 을 연결해 뒀는가 — 켜기 버튼의 활성 조건. */
  me_connected: boolean;
  /** 지금 저장된 «모을 채널»(공백 구분, 비면 전체). #2243 — 화면이 토글 목록을 미리 체크하는 근거. */
  channels: string;
}

async function memberConnected(memberId: string): Promise<boolean> {
  const r = await getMemberSecret(memberOwner(memberId), "slack_oauth", "").catch(() => null);
  return !!r?.secret;
}
async function botTeams(): Promise<string[]> {
  const rows = await listSecretsByKindPublic(SLACK_BOT_KIND).catch(() => []);
  return rows.filter((r) => r.owner === GATEWAY_OWNER && r.has_secret).map((r) => r.scope_key);
}

export async function slackCollectState(callerId: string): Promise<SlackCollectState> {
  const all = await listCollectors();
  const search = findInstance(all, SEARCH_INSTANCE);
  const bot = findInstance(all, BOT_INSTANCE);
  const member = tokenSourceMember(search);
  const teams = await botTeams();
  return {
    search: {
      enabled: !!search?.enabled, collector_id: search?.id ?? null, member,
      member_connected: member ? await memberConnected(member) : null,
    },
    bot: { enabled: !!bot?.enabled, collector_id: bot?.id ?? null, available: teams.length > 0, team_ids: teams },
    me_connected: await memberConnected(callerId),
    channels: String(search?.config?.channels ?? bot?.config?.channels ?? ""),
  };
}

const orgSlackCollect: Capability = {
  name: "org_slack_collect", title: "슬랙 팀 자료 수집 상태",
  description: "\"팀 자료로 모으기\" 상태 — 검색 수집기(공개채널, 켠 관리자의 연결로 돈다)와 봇 수집기(초대 채널·비공개)의 켜짐 여부, 봇 토큰 유무, 내 연결 여부. 토글은 org_slack_collect_set.",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/slack/collect"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    return slackCollectState(user.userId);
  },
};

const orgSlackCollectSet: Capability = {
  name: "org_slack_collect_set", title: "슬랙 팀 자료 수집 켜기/끄기",
  description:
    "\"팀 자료로 모으기\" 토글(admin). enabled=true 면 호출자의 Slack 연결(금고)로 공개채널 검색 수집기를 만들거나 켜고(token_source=member:<나>), " +
    "봇 토큰이 있으면 봇 수집기도 함께 켠다(비공개 채널은 그 채널에서 /invite @Lively 한 것만). 토큰을 복사하지 않는다. " +
    "false 면 둘 다 끈다(삭제 아님 — 커서·자료 보존). 켜려면 호출자가 먼저 me_oauth_connect 로 Slack 을 연결해야 한다.",
  scope: "admin",
  input: {
    enabled: z.boolean().describe("true=켜기(내 연결로) · false=끄기"),
    bot: z.boolean().optional().describe("봇 수집기도 함께(기본 true — 봇 토큰이 없으면 조용히 건너뛴다)"),
    channels: z.string().optional().describe("모을 채널(채널명·id, 공백·쉼표 구분). 비우면 전체. #2243 — 화면의 채널 토글이 이 값을 보낸다"),
  },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/slack/collect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as { enabled?: unknown; bot?: unknown; channels?: unknown };
    const enabled = i.enabled === true;
    //  채널 지정은 «켜기»와 독립이다 — 이미 켜진 뒤 범위만 바꾸는 경로가 정상 사용이다.
    const channels = i.channels === undefined ? undefined : String(i.channels ?? "").trim();
    const withBot = i.bot !== false;
    const actor = user.userId;
    const source = ctx?.source ?? "web";
    const all = await listCollectors();
    const search = findInstance(all, SEARCH_INSTANCE);
    const bot = findInstance(all, BOT_INSTANCE);
    const changed: string[] = [];

    if (!enabled) {
      if (search?.enabled) { await upsertCollector({ id: search.id, enabled: false }, actor, source); changed.push(SEARCH_INSTANCE); }
      if (bot?.enabled) { await upsertCollector({ id: bot.id, enabled: false }, actor, source); changed.push(BOT_INSTANCE); }
      return { ok: true, enabled: false, changed, state: await slackCollectState(actor) };
    }

    if (!(await memberConnected(actor))) {
      throw new HttpError(400, "먼저 [외부 앱 연결 ▸ Slack] 에서 내 계정을 연결하세요 — 팀 자료 수집은 그 연결로 돕니다.");
    }
    // 검색 수집기 — 항상 **호출자**의 연결로 갈아끼운다(전임자가 나가서 멈춘 수집기를 다른 관리자가 이어받는 경로).
    await upsertCollector({
      id: search?.id, preset_key: "slack", instance_key: SEARCH_INSTANCE,
      label: search?.label ?? "Slack — 팀 공개 채널", enabled: true,
      config: { ...(search?.config ?? {}), token_source: `member:${actor}`, ...(channels === undefined ? {} : { channels }) },
      note: search?.note ?? "[Slack 연결] 토글로 만들어진 수집기 — 켠 사람의 연결로 전 공개채널을 검색 수집합니다(#1881). 토큰 칸은 비워 두세요.",
    }, actor, source);
    changed.push(SEARCH_INSTANCE);

    if (withBot) {
      const teams = await botTeams();
      if (teams.length > 0) {
        const src = teams.length === 1 ? "bot" : (bot?.config?.token_source?.startsWith("bot:") ? bot.config.token_source : `bot:${teams[0]}`);
        await upsertCollector({
          id: bot?.id, preset_key: "slack", instance_key: BOT_INSTANCE,
          label: bot?.label ?? "Slack — Lively 봇이 초대된 채널", enabled: true,
          config: { ...(bot?.config ?? {}), token_source: src, ...(channels === undefined ? {} : { channels }) },
          note: bot?.note ?? "[Slack 연결] 토글로 만들어진 수집기 — Lively 봇이 초대된 채널(비공개 포함)을 수집합니다. 채널에서 /invite @Lively 로 범위를 넓히세요(#1881).",
        }, actor, source);
        changed.push(BOT_INSTANCE);
      }
    }
    return { ok: true, enabled: true, changed, state: await slackCollectState(actor) };
  },
};

// 셀프호스팅용 — 이 게이트웨이의 콜백이 박힌 Slack 앱 매니페스트 + 한 클릭 생성 링크(#1881 §4). 관리탭 슬랙 셋업이 연다.
const orgSlackAppManifest: Capability = {
  name: "org_slack_app_manifest", title: "Slack 앱 매니페스트(한 클릭 생성 링크)",
  description: "이 게이트웨이의 OAuth 콜백(org_profile.gateway_url + /oauth/callback)이 redirect 로 박힌 Slack 앱 매니페스트와 api.slack.com 생성 링크. 셀프호스팅 관리자는 링크를 열어 [Create] → Client ID/Secret 만 [AI 도구 ▸ Slack ▸ OAuth 클라이언트] 에 넣으면 된다(구 7단계 → 3단계).",
  scope: "admin", input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/slack/app-manifest"], parse: () => ({}) }] },
  handler: async () => {
    const p = await getOrgProfile();
    if (!p.gateway_url) throw new HttpError(400, "게이트웨이 URL(org_profile.gateway_url)이 없어 콜백을 만들 수 없습니다 — 관리탭 ▸ 조직 정보에서 먼저 설정하세요.");
    const redirect = new URL("/oauth/callback", p.gateway_url).toString();
    const manifest = buildSlackAppManifest([redirect], { name: p.display_name ? `Lively (${p.display_name})` : "Lively" });
    return { redirect_url: redirect, manifest, create_url: slackAppCreateUrl(manifest) };
  },
};

// 매니지드 릴레이 완료(#1881 T5) — CP 가 admin 토큰으로 부른다. state 검증·저장은 브로커(completeSlackInstall). 응답에 토큰 없음.
const orgSlackOauthComplete: Capability = {
  name: "org_slack_oauth_complete", title: "슬랙 OAuth 릴레이 완료(CP 전용)",
  description: "라이블리 컨트롤플레인이 슬랙과 교환한 oauth.v2.access 응답을 이 게이트웨이의 서명 state 와 함께 넣는다. state 가 가리키는 구성원 금고에 유저 토큰을, 조직 슬롯에 봇 토큰을 저장한다. 사람이 직접 부를 일은 없다.",
  scope: "admin", input: { state: z.string().describe("이 게이트웨이가 발급한 서명 state"), access: z.record(z.unknown()).describe("슬랙 oauth.v2.access 응답 JSON 원문") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/org/slack/oauth-complete"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    const i = (input ?? {}) as { state?: unknown; access?: unknown };
    if (typeof i.state !== "string" || !i.state) throw new HttpError(400, "state 는 필수입니다");
    if (!i.access || typeof i.access !== "object") throw new HttpError(400, "access(슬랙 응답)는 필수입니다");
    try {
      const r = await completeSlackInstall(i.state, i.access, user?.userId ?? "cp-relay");
      return { ok: true, member: r.memberId, server: r.serverName, team_id: r.team_id };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
};

export const slackConnectCapabilities: Capability[] = [orgSlackCollect, orgSlackCollectSet, orgSlackAppManifest, orgSlackOauthComplete];

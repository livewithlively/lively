// 슬랙 다리(#1782) — 관리 도구 셋(org_slack_bridges · org_slack_bridge_set · org_slack_bridge_remove)과 앱 서버가 부르는 slack_bridge_call.
//  흐름은 org/slack-bridge/manager.ts · 판정은 plan.ts.
//
//  slack_bridge_call 을 앱 서버만 부르게 한 까닭: ① 이슈가 정한 자리(«앱 서버가 부르는 새 능력») ② 브라우저 쪽 앱 코드가 봇 이름으로 글을 쓰지 않게
//   ③ 앱 화면 다리(org_app_tool_call)는 인자를 호출 기록에 남긴다 — 보낸 글이 기록에 남지 않게(이슈 «본문은 남기지 않는다»). MCP 에도 올리지 않는다
//   (구성원 모두의 도구 목록에 보이는 것이 이슈가 짚은 바깥 중계 우회의 문제였다).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";
import { getApp, getActiveGrant } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { serverDeclOf } from "../apps/app-server-config.js";
import { buildSlackBridgeManifest, slackAppCreateUrl, slackManifestProblems } from "../org/credentials/slack-oauth.js";
import {
  BRIDGE_CALL_METHODS, BRIDGE_EVENT_TYPES, BRIDGE_ID_RE, bridgeCallPlan, isAppLevelToken, isBotToken, normalizeBridgeInput, sameRef, shortError,
  type BridgeRow, type BridgeStatus, type TokenRef,
} from "../org/slack-bridge/plan.js";
import * as store from "../org/slack-bridge/store.js";
import { liveBridgeStatus, readSecretOf, reconcileSlackBridges } from "../org/slack-bridge/manager.js";
import { liveSlackApi, slackCall, slackError, slackOk } from "../org/slack-bridge/slack-api.js";
import { logger } from "../log.js";

/** 사람이 보는 다리 한 줄 — 토큰 값은 없다(금고 칸 참조만). 상태는 이 게이트웨이가 쥔 연결의 것이 있으면 그것, 없으면 DB 에 적힌 마지막 것. */
function viewOf(r: BridgeRow): Record<string, unknown> {
  const live = liveBridgeStatus(r.id);
  return {
    id: r.id, app_id: r.app_id, route: r.route, enabled: r.enabled,
    app_token_ref: r.app_token_ref, bot_token_ref: r.bot_token_ref,
    events: r.events, channels: r.channels, bot_messages: r.bot_messages, bot_ids: r.bot_ids, run_as: r.run_as, react: r.react, note: r.note,
    status: (live ?? r.status ?? {}) as BridgeStatus, status_from: live ? "this_gateway" : "last_saved",
    created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by,
  };
}

const SETUP = [
  "1) 슬랙 앱 만들기 — create_url 을 열어 [Create] (소켓 모드 · 이벤트 구독 · 버튼(Interactivity)이 켜진 매니페스트가 채워져 있다).",
  "2) 앱 수준 토큰 — 슬랙 앱 ▸ Basic Information ▸ App-Level Tokens ▸ Generate(권한 connections:write) → xapp- 토큰.",
  "3) 봇 토큰 — Install to Workspace → OAuth & Permissions 의 Bot User OAuth Token(xoxb-).",
  "4) 금고에 넣기 — org_credential_set { kind: \"slack_bridge_app\", scope_key: \"<다리 id>\", secret: \"xapp-…\" } · { kind: \"slack_bridge_bot\", scope_key: \"<다리 id>\", secret: \"xoxb-…\" }.",
  "5) 다리 만들기 — org_slack_bridge_set { id, app_id, route, app_token_ref: \"slack_bridge_app:<id>\", bot_token_ref: \"slack_bridge_bot:<id>\", channels: [\"C…\"], run_as? }.",
  "6) 봇을 채널에 초대(/invite @lively-bridge) — 봇이 들어간 채널의 글만 온다. 앱은 permissions.tools 에 slack_bridge_call 을 선언하고, 쓰는 사람은 앱에 동의해야 한다.",
];

// ── 관리 ────────────────────────────────────────────────────────────────────────────────
const tokenRefSchema = z.union([
  z.string().max(200),
  z.object({ owner: z.string().max(140).optional(), kind: z.string().max(40), scope_key: z.string().max(120).optional() }),
]);

const bridgeSetInput = {
  id: z.string().max(40).describe("다리 id(소문자 · 숫자 · - · 예 policy-ops). 있으면 고친다 — 생략한 칸은 그대로"),
  app_id: z.string().max(32).optional().describe("받은 이벤트를 넘길 앱(설치된 앱 id). 새로 만들 때 필수"),
  route: z.string().max(2048).optional().describe("앱 서버 라우트(경로 — 예 /api/slack/event · 'POST /api/slack/event' 도 받는다). 작업은 POST 로 이 라우트를 부른다. 새로 만들 때 필수"),
  enabled: z.boolean().optional().describe("켜기(기본 true). 끄면 연결을 내린다"),
  app_token_ref: tokenRefSchema.optional().describe("앱 수준 토큰(xapp- · connections:write)이 든 금고 칸 — \"kind:scope_key\" 또는 { kind, scope_key?, owner? }. owner 는 조직 금고(gateway, 기본) 또는 고치는 본인(member:<본인>)만. 값은 org_credential_set 으로 먼저 넣는다. 새로 만들 때 필수"),
  bot_token_ref: tokenRefSchema.optional().describe("봇 토큰(xoxb-)이 든 금고 칸 — 모양은 app_token_ref 와 같다. 안내 · 받음 표시 · 앱의 답(slack_bridge_call)이 이 토큰으로 나간다. 새로 만들 때 필수"),
  events: z.array(z.string().max(40)).max(20).optional().describe(`넘길 종류(기본 message · app_mention · block_actions). 고를 수 있는 것: ${[...BRIDGE_EVENT_TYPES].join(" · ")}. 사람이 봇을 태그한 글은 app_mention 을 고르면 그 하나로만 넘긴다(슬랙은 message 로도 보내지만 다리가 거른다 · 같은 글은 한 번만)`),
  channels: z.array(z.string().max(32)).max(100).optional().describe("넘길 채널 id 목록(C… · G… · D…). 비우면 봇이 들어간 모든 채널. 고르면 앱의 답(slack_bridge_call)도 그 채널과 DM 으로만 나간다"),
  bot_messages: z.boolean().optional().describe("워크플로 · 봇이 쓴 글도 넘기나(기본 false). 켜면 run_as 가 필요하다 — 그 글은 run_as 구성원 이름으로 돈다. 이 봇 자신의 글은 늘 거른다"),
  bot_ids: z.array(z.string().max(32)).max(20).optional().describe("넘길 봇 · 워크플로의 bot_id 목록(B…). 비우면 bot_messages 가 켜졌을 때 채널의 모든 봇 글을 넘긴다 — 정한 워크플로 글만 받으려면 적는다"),
  run_as: z.string().max(64).nullable().optional().describe("사람이 쓰지 않은 글(워크플로 · 봇)을 돌릴 구성원 id. 그 작업은 자동화로 표시돼 AI 실행에 개인 구독은 못 쓰고 공용 시트나 워크스페이스 API 키를 쓴다. null 이면 지운다"),
  react: z.string().max(64).nullable().optional().describe("작업을 시작한 글에 다는 받음 표시(슬랙 이모지 이름 — 예 eyes). 봇에 reactions:write 가 필요하다. null 이면 안 단다"),
  note: z.string().max(500).nullable().optional().describe("메모"),
};
type BridgeSetInput = z.infer<z.ZodObject<typeof bridgeSetInput>>;

const pickSet = (b: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(bridgeSetInput)) if (b[k] !== undefined) out[k] = b[k];
  return out;
};

async function checkToken(ref: TokenRef, field: string, want: "app" | "bot"): Promise<void> {
  let v: string | null;
  try { v = await readSecretOf(ref); }
  catch (e) { throw new HttpError(500, `${field} 금고 칸을 읽지 못했습니다: ${shortError(e)}`); }
  const label = `${ref.owner === "gateway" ? "" : ref.owner + " · "}${ref.kind}${ref.scope_key ? ":" + ref.scope_key : ""}`;
  if (!v) throw new HttpError(400, `${field} — 금고 칸(${label})에 값이 없습니다. org_credential_set { kind: "${ref.kind}", scope_key: "${ref.scope_key}", secret } 으로 먼저 넣으세요`);
  if (want === "app" && !isAppLevelToken(v)) throw new HttpError(400, `${field} — 금고 칸(${label})의 값이 앱 수준 토큰(xapp-)이 아닙니다. 슬랙 앱 ▸ Basic Information ▸ App-Level Tokens(connections:write)에서 만든 토큰을 넣으세요`);
  if (want === "bot" && !isBotToken(v)) throw new HttpError(400, `${field} — 금고 칸(${label})의 값이 봇 토큰(xoxb-)이 아닙니다. 슬랙 앱 ▸ OAuth & Permissions 의 Bot User OAuth Token 을 넣으세요`);
}

const orgSlackBridges: Capability = {
  name: "org_slack_bridges",
  title: "슬랙 다리 목록 · 상태",
  description:
    "슬랙 다리(#1782) — 게이트웨이가 슬랙 소켓 모드로 받은 이벤트를 앱 백그라운드 작업으로 넘기고, 앱은 다리의 봇 토큰(금고)으로 답한다(slack_bridge_call). " +
    "다리마다 설정(앱 · 라우트 · 금고 칸 참조 · 거르기 · run_as)과 상태(연결 여부 · 마지막 이벤트 · 받은/넘긴/거른 수 · 마지막 오류)와 최근 호출 기록을 준다. " +
    "manifest · create_url = 다리용 슬랙 앱을 한 번에 만드는 매니페스트와 링크, setup = 만드는 순서. 토큰 값은 주지 않는다.",
  scope: "admin",
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/slack/bridges"], parse: () => ({}) }] },
  handler: async () => {
    const rows = await store.listBridges();
    const bridges = await Promise.all(rows.map(async (r) => ({ ...viewOf(r), recent_calls: await store.recentBridgeCalls(r.id, 5) })));
    const manifest = buildSlackBridgeManifest();
    const problems = slackManifestProblems(manifest);
    return {
      bridges, count: bridges.length,
      manifest, create_url: problems.length ? null : slackAppCreateUrl(manifest), ...(problems.length ? { manifest_problems: problems } : {}),
      setup: SETUP, call_methods: [...BRIDGE_CALL_METHODS], event_types: [...BRIDGE_EVENT_TYPES],
    };
  },
};

const orgSlackBridgeSet: Capability = {
  name: "org_slack_bridge_set",
  title: "슬랙 다리 만들기 · 고치기",
  description:
    "슬랙 다리(#1782)를 만들거나 고친다(admin). 다리 하나 = 슬랙 앱 하나(앱 수준 토큰) ↔ 라이블리 앱 하나의 라우트. 저장하면 이 게이트웨이가 곧바로 소켓 모드로 붙는다. " +
    "토큰 값은 받지 않는다 — app_token_ref(xapp-) · bot_token_ref(xoxb-)는 금고 칸(org_credential_set 으로 넣은 칸)을 가리킨다. " +
    "받은 글 · 태그 · 버튼은 그 슬랙 사람을 구성원으로 찾아(구성원 신원 system=slack · [Slack 연결] 한 계정 · 같은 이메일) 그 사람 이름으로 앱 작업(source slack-bridge)을 시작한다. " +
    "못 찾거나 그 사람이 앱에 동의하지 않았으면 시작하지 않고, 봇을 직접 부른 것(태그 · DM · 버튼)이면 그 사람에게만 보이는 안내를 스레드에 단다. " +
    "워크플로 · 봇 글(bot_messages · bot_ids)은 run_as 구성원 이름으로 돌고 자동화로 표시된다(AI 실행은 공용 시트나 워크스페이스 API 키 — 개인 구독은 못 쓴다). 작업 본문: { kind, bridge, team_id, received_at, actor:{slack_user,member,via}, event_id, event | payload }. " +
    "봇을 태그한 사람의 글은 app_mention 하나로만 넘긴다(같은 글이 두 번 작업이 되지 않게). 전달은 최대 한 번이다 — ack 를 먼저 보내므로 게이트웨이가 넘기던 중에 죽으면 그 이벤트는 다시 오지 않는다. " +
    "한 슬랙 앱에는 다리 하나만 — 슬랙이 같은 앱의 이벤트를 연결 하나에만 준다. 응답의 warnings 는 저장은 됐지만 그대로면 동작하지 않을 것들이다. " +
    "연결은 게이트웨이가 쥔다 — 셀프호스트는 30초마다 맞춘다. 매니지드는 그 워크스페이스에 요청이 올 때 맞추므로 게이트웨이가 다시 뜬 뒤 멈춘(한가한) 워크스페이스는 다음 요청까지 붙지 않는다.",
  scope: "admin",
  input: bridgeSetInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/slack/bridge"], parse: (req) => pickSet((req.body ?? {}) as Record<string, unknown>) }] },
  handler: async (input: BridgeSetInput, user: LivelyUser) => {
    const raw = input as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
    if (!BRIDGE_ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 · 숫자 · - 1~40자입니다(소문자 · 숫자로 시작 — 예 policy-ops)");
    const prev = await store.getBridge(id);
    const b = normalizeBridgeInput({ ...raw, app_token: raw.app_token_ref, bot_token: raw.bot_token_ref }, prev, user.userId);
    const warnings: string[] = [];

    const app = await getApp(b.app_id);
    if (!app) throw new HttpError(400, `앱 없음: ${b.app_id} — 설치된 앱 id 를 적으세요(org_apps)`);
    if (app.status !== "active" || !app.enabled) warnings.push(`앱 '${b.app_id}' 이 꺼져 있어 작업이 시작되지 않습니다`);
    if (!serverDeclOf(app.manifest)) warnings.push(`앱 '${b.app_id}' 은 서버(web.server)를 선언하지 않았습니다 — 라우트를 받을 앱 서버가 있어야 작업이 돈다`);
    const tools = (app.manifest as { permissions?: { tools?: unknown } } | null)?.permissions?.tools;
    if (!Array.isArray(tools) || !tools.some((t) => t === "slack_bridge_call" || t === "*")) {
      warnings.push(`앱 '${b.app_id}' 이 permissions.tools 에 slack_bridge_call 을 선언하지 않았습니다 — 선언하고 구성원이 동의해야 앱이 다리로 답할 수 있습니다`);
    }
    if (b.run_as) {
      const m = await getMember(b.run_as);
      if (!m || m.state !== "active") throw new HttpError(400, `run_as 구성원 '${b.run_as}' 이 없거나 활성 상태가 아닙니다`);
      //  봇 · 워크플로 글 하나가 그 사람의 권한(앱 동의 안)으로 돈다 — 높은 권한을 가진 사람이면 알린다(공용 시트의 «기본 권한만 가진 전용 계정» 과 같은 판단).
      const high = (m.scopes ?? []).filter((x) => !["items", "context", "memory"].includes(x));
      if (high.length) warnings.push(`run_as 구성원 '${b.run_as}' 에 높은 권한(${high.join(" · ")})이 있습니다 — 봇 · 워크플로 글 하나가 그 사람 이름으로 돕니다. 기본 권한(items · context · memory)만 가진 전용 구성원을 쓰세요`);
      if (b.bot_messages && !b.bot_ids.length) warnings.push("bot_ids 를 비워 두면 채널의 모든 봇 · 워크플로 글이 run_as 이름으로 돕니다 — 받을 워크플로의 bot_id 를 적으세요");
      if (!(await getActiveGrant(b.app_id, m.id))) warnings.push(`run_as 구성원 '${b.run_as}' 이 앱 '${b.app_id}' 에 동의하지 않았습니다 — 그 사람이 앱을 한 번 열어 동의해야 워크플로 · 봇 글의 작업이 시작됩니다`);
    } else if (b.bot_messages) {
      warnings.push("bot_messages 를 켰지만 run_as 가 없습니다 — 워크플로 · 봇 글은 돌릴 사람이 없어 넘기지 않습니다");
    }
    if (b.enabled) {
      await checkToken(b.app_token_ref, "app_token_ref", "app");
      await checkToken(b.bot_token_ref, "bot_token_ref", "bot");
    }
    const others = (await store.listBridges()).filter((o) => o.id !== b.id);
    const dup = others.find((o) => sameRef(o.app_token_ref, b.app_token_ref));
    if (dup) throw new HttpError(409, `다리 '${dup.id}' 가 같은 앱 수준 토큰 칸을 씁니다 — 슬랙은 한 앱의 이벤트를 연결 하나에만 줍니다. 다리마다 다른 슬랙 앱을 쓰세요`);

    const row = await store.upsertBridge(b, user.userId);
    //  곧바로 맞춘다 — 저장한 다리가 다음 정비(30초)를 기다리지 않고 붙는다. 실패해도 저장은 그대로(다음 정비가 다시 맞춘다).
    await reconcileSlackBridges(undefined, { fresh: true }).catch((e) => { warnings.push(`곧바로 붙지 못했습니다(다음 정비가 다시 합니다): ${shortError(e)}`); });
    logger.info({ bridge: row.id, app: row.app_id, by: user.userId, created: !prev }, "[slack-bridge] 다리를 저장했다(#1782)");
    return { bridge: viewOf(row), created: !prev, warnings };
  },
};

const orgSlackBridgeRemove: Capability = {
  name: "org_slack_bridge_remove",
  title: "슬랙 다리 지우기",
  description: "슬랙 다리를 지운다(admin) — 연결을 내리고, 한 번만 넘기기 기록도 함께 지운다. 금고의 토큰 칸은 그대로 둔다(org_credential_delete 로 따로 지운다). 앱 호출 기록은 보존 기간(30일)까지 남는다.",
  scope: "admin",
  input: { id: z.string().max(40).describe("지울 다리 id") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/slack/bridge/remove"], parse: (req) => ({ id: (req.body ?? {}).id }) }] },
  handler: async (input: { id?: unknown }) => {
    const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
    if (!BRIDGE_ID_RE.test(id)) throw new HttpError(400, "id 는 다리 id 입니다");
    const removed = await store.removeBridge(id);
    if (!removed) throw new HttpError(404, `다리 없음: ${id}`);
    await reconcileSlackBridges(undefined, { fresh: true }).catch(() => { /* 다음 정비가 내린다 */ });
    return { removed: true, id };
  },
};

// ── 앱이 답하기 ─────────────────────────────────────────────────────────────────────────
/** 다리마다 분당 호출 상한 — 앱 코드의 고리(답이 답을 부르는 것)가 봇 이름으로 채널을 덮지 않게. 슬랙 자체 상한(chat.postMessage 채널당 초당 1회 안팎)보다 넉넉하다. */
export const BRIDGE_CALLS_PER_MIN = 120;
const callWindow = new Map<string, number[]>();
function takeCall(key: string, now: number): boolean {
  const arr = (callWindow.get(key) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= BRIDGE_CALLS_PER_MIN) { callWindow.set(key, arr); return false; }
  arr.push(now);
  callWindow.set(key, arr);
  return true;
}

const scrubToken = (body: Record<string, unknown>, token: string): Record<string, unknown> => {
  const s = JSON.stringify(body);
  return s.includes(token) ? JSON.parse(s.split(token).join("[REDACTED]")) as Record<string, unknown> : body;
};

const bridgeCallInput = {
  bridge: z.string().max(40).describe("다리 id — 작업 본문의 bridge 그대로"),
  method: z.enum(BRIDGE_CALL_METHODS).describe("부를 슬랙 Web API 메서드"),
  args: z.record(z.unknown()).optional().describe("메서드 인자(슬랙 문서 그대로 — 예 chat.postMessage { channel, text, thread_ts, blocks }). token 은 넣지 않는다 — 다리가 금고의 봇 토큰을 싣는다"),
};

const slackBridgeCall: Capability = {
  name: "slack_bridge_call",
  title: "슬랙 다리로 답하기(앱 서버)",
  description:
    "앱 서버가 슬랙 다리(#1782)의 봇 토큰(금고)으로 슬랙 Web API 를 부른다 — 토큰은 게이트웨이 밖으로 나가지 않는다. 그 다리의 앱(app_id)인 앱 서버만 부를 수 있다" +
    "(앱이 permissions.tools 에 slack_bridge_call 을 선언하고 · 부르는 사람이 동의했어야 한다 — 다리 작업 안에서는 작업 돌기 신원 그대로). " +
    `메서드는 ${BRIDGE_CALL_METHODS.join(" · ")} 만. 다리에 채널을 골라 두었으면 채널을 가리키는 호출은 그 채널과 DM 으로만 나간다. ` +
    `다리마다 분당 ${BRIDGE_CALLS_PER_MIN}회. 답: { ok, method, status, error, response } — response 는 슬랙 응답 그대로(슬랙의 실패는 ok:false · error 로 돌려준다 — HTTP 는 200). ` +
    "호출마다 메서드 · 채널 · ts · 결과를 기록한다(보낸 글은 남기지 않는다).",
  scope: null,
  input: bridgeCallInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/slack-bridge/call"], parse: (req) => { const b = (req.body ?? {}) as Record<string, unknown>; return { bridge: b.bridge, method: b.method, args: b.args }; } }],
  },
  handler: async (input: { bridge?: unknown; method?: unknown; args?: unknown }, user: LivelyUser) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (!user.appId || user.appServer !== true) {
      throw new HttpError(403, "slack_bridge_call 은 앱 서버만 부릅니다 — 다리에 걸린 앱의 서버 코드가 앱 서버 토큰 + 사람(또는 작업) 신원으로 부르세요");
    }
    const id = typeof input.bridge === "string" ? input.bridge.trim().toLowerCase() : "";
    const b = BRIDGE_ID_RE.test(id) ? await store.getBridge(id) : null;
    //  남의 앱의 다리는 «없음» 과 같다(있는지도 말하지 않는다).
    if (!b || b.app_id !== user.appId) throw new HttpError(404, `다리 없음: ${id || "(빈 값)"}`);
    if (!b.enabled) throw new HttpError(409, `다리 '${b.id}' 가 꺼져 있습니다`);
    const plan = bridgeCallPlan(input.method, input.args, b);
    if (!takeCall(`${b.id}`, Date.now())) throw new HttpError(429, `다리 '${b.id}' 의 호출이 분당 ${BRIDGE_CALLS_PER_MIN}회를 넘었습니다 — 잠시 뒤 다시 하세요`);
    const token = await readSecretOf(b.bot_token_ref).catch(() => null);
    if (!token || !isBotToken(token)) throw new HttpError(409, `다리 '${b.id}' 의 봇 토큰이 금고에 없습니다 — 관리자가 금고 칸을 채워야 합니다`);
    const rec = { bridge_id: b.id, app_id: b.app_id, member: user.userId, job_id: user.appJobId ?? null, method: plan.method, channel: plan.channel, ts: plan.ts };
    let r;
    try {
      r = await slackCall(token, plan.method, plan.args, { json: plan.json }, liveSlackApi());
    } catch (e) {
      const why = shortError(e);
      await store.logBridgeCall({ ...rec, ok: false, error: why }).catch(() => {});
      throw new HttpError(502, why);
    }
    const ok = slackOk(r);
    const body = r.body ? scrubToken(r.body, token) : null;
    const msg = body?.message && typeof body.message === "object" ? body.message as Record<string, unknown> : null;
    const ts = rec.ts ?? (typeof body?.ts === "string" ? body.ts : typeof msg?.ts === "string" ? msg.ts : null);
    const channel = rec.channel ?? (typeof body?.channel === "string" ? body.channel : null);
    await store.logBridgeCall({ ...rec, channel, ts, ok, error: ok ? null : slackError(r) })
      .catch((e) => logger.warn({ bridge: b.id, err: shortError(e) }, "[slack-bridge] 호출 기록 실패(비치명)"));
    return { ok, method: plan.method, status: r.status, error: ok ? null : slackError(r), response: body };
  },
};

export const slackBridgeCapabilities: Capability[] = [orgSlackBridges, orgSlackBridgeSet, orgSlackBridgeRemove, slackBridgeCall];

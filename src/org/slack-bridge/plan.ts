// 슬랙 다리(#1782) — 순수 판정. 받은 envelope 중 무엇을 앱 작업으로 넘기나 · 작업 본문 · 다리 설정 검사 · 앱이 부르는 슬랙 메서드 검사.
//  저장은 store.ts · 연결은 socket.ts · 흐름(신원 · 작업 시작 · 안내)은 manager.ts · 능력은 capabilities/slack-bridge.ts.
//
// ── 다리가 하는 일과 하지 않는 일(이슈 #1782 «정할 것» 3) ───────────────────────────────────────
//  다리는 통로다 — 받기(소켓 모드) · 넘기기(앱 백그라운드 작업) · 답하기(금고의 봇 토큰으로 슬랙 부르기)만 한다.
//  무엇에 답할지 · 답을 어떻게 꾸밀지 · «확인 중» 표시는 앱이 정한다. 다리 쪽 선택지는 «받는 즉시 반응 달기(react)» 하나뿐이다.
//  그래서 여기 거르기는 «앱이 받으면 안 되는 것» 만 거른다: 고른 종류 · 고른 채널 밖, 봇 자신의 글(답이 다시 이벤트로 돌아오는 고리), 고친 · 지운 글 같은
//  부수 이벤트, 고르지 않았으면 봇 · 워크플로 글, 다른 워크스페이스(Slack Connect) 사람의 글.
import { HttpError } from "../../http-error.js";
import { jobRouteError } from "../../apps/app-jobs-plan.js";

/** 금고 칸 하나를 가리키는 참조 — 값은 여기 없다(org/credentials/member-secret-store getMemberSecret 이 읽는다). */
export interface TokenRef { owner: string; kind: string; scope_key: string }

/** 다리 한 줄(org_slack_bridge) — status 는 연결을 쥔 게이트웨이가 적는 마지막 상태. */
export interface BridgeRow {
  id: string;
  app_id: string;
  route: string;
  enabled: boolean;
  app_token_ref: TokenRef;
  bot_token_ref: TokenRef;
  events: string[];
  channels: string[];
  bot_messages: boolean;
  /** 넘길 봇 · 워크플로(bot_id B…) — 비면 bot_messages 가 켜졌을 때 모든 봇 글. */
  bot_ids: string[];
  run_as: string | null;
  /** run_as 로 도는 글을 «사람이 낸 질문»으로 본다 — 자동화 표시를 달지 않는다(공용 시트를 쓸 수 있다). bot_ids 를 골랐을 때만 켤 수 있다. */
  run_as_human: boolean;
  react: string | null;
  note: string | null;
  status: BridgeStatus;
  created_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** 연결 상태 — 사람이 «돌고 있나» 를 보는 칸(org_slack_bridges). 시각은 ISO 글. */
export interface BridgeStatus {
  connected?: boolean;
  state?: string;              // connecting · connected · waiting(다시 붙기 전) · stopped · error
  since?: string | null;       // 지금 상태가 된 시각
  last_event_at?: string | null;
  received?: number;           // 받은 envelope(소켓)
  forwarded?: number;          // 작업을 시작한 수
  filtered?: number;           // 거른 수(고른 종류 · 채널 밖 · 봇 글 · 사람 매핑 없음 …)
  duplicates?: number;         // 같은 이벤트를 다시 받아 건너뛴 수
  failed?: number;             // 넘기려다 실패한 수(작업 상한 · 서버 없음 …)
  last_filtered?: string | null;
  last_error?: string | null;
  last_error_at?: string | null;
  slack?: { team_id?: string | null; team?: string | null; bot_user_id?: string | null; bot_id?: string | null; app_id?: string | null };
  holder?: string | null;      // 연결을 쥔 게이트웨이(호스트 · 프로세스)
  updated_at?: string | null;
}

// ── 고를 수 있는 것 ────────────────────────────────────────────────────────────────────────
/** Events API 의 event.type 중 다리가 넘길 수 있는 것. */
export const EVENTS_API_TYPES = ["message", "app_mention", "reaction_added", "reaction_removed", "member_joined_channel", "app_home_opened"] as const;
/** Interactivity 의 payload.type 중 다리가 넘길 수 있는 것. */
export const INTERACTIVE_TYPES = ["block_actions", "view_submission", "view_closed", "shortcut", "message_action"] as const;
export const BRIDGE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([...EVENTS_API_TYPES, ...INTERACTIVE_TYPES]);
export const DEFAULT_BRIDGE_EVENTS = ["message", "app_mention", "block_actions"];

/** 앱이 다리의 봇 토큰으로 부를 수 있는 슬랙 Web API 메서드(이슈 #1782 «답하기»). 이 밖은 부르지 않는다. */
export const BRIDGE_CALL_METHODS = [
  "chat.postMessage", "chat.update", "chat.delete", "chat.getPermalink", "chat.postEphemeral",
  "users.info", "conversations.replies", "reactions.add", "views.open",
] as const;
export type BridgeCallMethod = (typeof BRIDGE_CALL_METHODS)[number];
/** JSON 본문을 받는 메서드(쓰기) — 슬랙 Web API 는 JSON 본문을 쓰기 메서드에만 받는다. 나머지는 form 으로 보낸다. */
export const JSON_BODY_METHODS: ReadonlySet<string> = new Set(["chat.postMessage", "chat.update", "chat.delete", "chat.postEphemeral", "reactions.add", "views.open"]);

export const BRIDGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
export const SLACK_BOT_ID_RE = /^B[A-Z0-9]{2,30}$/;
export const BRIDGE_BOT_IDS_MAX = 20;
const MEMBER_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EMOJI_RE = /^[a-z0-9_+'-]{1,64}$/;
const KIND_RE = /^[a-z0-9_]{1,40}$/;              // member-secret-rules.KIND_RE 와 같은 꼴
const SCOPE_RE = /^[A-Za-z0-9._:-]{0,120}$/;      // member-secret-rules.SCOPE_RE 와 같은 꼴
export const BRIDGE_CHANNELS_MAX = 100;
export const BRIDGE_NOTE_MAX = 500;
/** 앱이 넘기는 args 의 JSON 크기 상한 — 블록 키트 메시지 · 모달 한 장이 넉넉히 들어가는 크기. */
export const BRIDGE_CALL_ARGS_MAX = 100 * 1024;

/** 앱 수준 토큰(소켓 모드 연결 — connections:write)인가. */
export const isAppLevelToken = (t: string): boolean => /^xapp-/.test(t);
/** 봇 토큰인가(connectors/slack.ts isSlackBotToken 과 같은 꼴 — 토큰 회전을 켠 앱의 xoxe.xoxb- 도 받는다). */
export const isBotToken = (t: string): boolean => /^(xoxb-|xoxe\.xoxb-)/.test(t);

// ── 다리 설정 검사(관리자 입력) ─────────────────────────────────────────────────────────────
/** 다리 설정의 저장 모양(검사를 통과한 것). 생략한 칸은 기존 값 · 기본값으로 채운 뒤다. */
export interface BridgeInput {
  id: string; app_id: string; route: string; enabled: boolean;
  app_token_ref: TokenRef; bot_token_ref: TokenRef;
  events: string[]; channels: string[]; bot_messages: boolean; bot_ids: string[];
  run_as: string | null; run_as_human: boolean; react: string | null; note: string | null;
}

const bad = (msg: string): HttpError => new HttpError(400, msg);
const strOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 금고 참조 — { owner?, kind, scope_key? } 또는 "kind" · "kind:scope_key" 글. owner 는 조직 금고(gateway, 기본) 또는 다리를 고치는 관리자 본인의 칸(member:<본인>)만 —
 *  남의 개인 금고를 조직 다리에 걸면 그 사람이 모르는 사이에 그 사람의 토큰으로 슬랙을 부르게 된다.
 */
export function parseTokenRef(raw: unknown, field: string, actor: string): TokenRef {
  let owner = "gateway", kind = "", scope = "";
  if (typeof raw === "string") {
    const s = raw.trim();
    const i = s.indexOf(":");
    kind = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase();
    scope = i < 0 ? "" : s.slice(i + 1).trim();
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    owner = strOf(o.owner) || "gateway";
    kind = strOf(o.kind).toLowerCase();
    scope = strOf(o.scope_key);
  } else {
    throw bad(`${field} 는 금고 칸 참조입니다 — { kind, scope_key?, owner? } 또는 "kind:scope_key"(조직 금고 · org_credential_set 으로 넣은 칸)`);
  }
  if (!KIND_RE.test(kind)) throw bad(`${field}.kind 는 금고 칸의 종류(소문자 · 숫자 · _ 1~40자)입니다`);
  if (!SCOPE_RE.test(scope)) throw bad(`${field}.scope_key 형식이 아닙니다(영문 · 숫자 · . _ : - 120자까지)`);
  if (owner !== "gateway" && owner !== `member:${actor}`) {
    throw bad(`${field}.owner 는 조직 금고(gateway) 또는 다리를 고치는 본인의 칸(member:${actor})만 가리킬 수 있습니다 — 남의 개인 금고는 그 사람 모르게 쓰이게 됩니다`);
  }
  return { owner, kind, scope_key: scope };
}

/** 라우트 — "POST /api/slack/event" 처럼 메서드를 앞에 붙여도 받는다(작업은 늘 POST 다). 경로 규칙은 앱 작업과 같다(jobRouteError). */
export function normalizeRoute(raw: unknown): string {
  let s = strOf(raw);
  const m = /^([A-Za-z]+)\s+(\/.*)$/.exec(s);
  if (m) {
    if (m[1]!.toUpperCase() !== "POST") throw bad("route 는 POST 로만 부릅니다(앱 백그라운드 작업) — 메서드를 빼거나 POST 로 적으세요");
    s = m[2]!.trim();
  }
  const err = jobRouteError(s);
  if (err) throw bad(err);
  return s;
}

function listOf(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return [];
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
  if (!arr) throw bad(`${field} 는 목록(배열 또는 쉼표로 나눈 글)입니다`);
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") throw bad(`${field} 의 항목은 글이어야 합니다`);
    const s = v.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 관리자 입력 → 저장 모양. 생략한 칸은 기존 줄(prev)의 값, 없으면 기본값. 어긋나면 400(HttpError).
 *  앱 · 구성원 · 금고 칸이 정말 있는지는 부르는 쪽(능력)이 DB 로 본다 — 여기는 모양만.
 */
export function normalizeBridgeInput(input: Record<string, unknown>, prev: BridgeRow | null, actor: string): BridgeInput {
  const id = strOf(input.id).toLowerCase();
  if (!BRIDGE_ID_RE.test(id)) throw bad("id 는 소문자 · 숫자 · - 1~40자입니다(소문자 · 숫자로 시작 — 예 policy-ops)");
  const appId = input.app_id === undefined ? prev?.app_id ?? "" : strOf(input.app_id);
  if (!appId) throw bad("app_id(이 다리가 넘길 앱)가 필요합니다");
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(appId)) throw bad("app_id 형식이 아닙니다(앱 id — 소문자 · 숫자 · -)");
  const route = input.route === undefined ? (prev?.route ?? "") : normalizeRoute(input.route);
  if (!route) throw bad("route(슬랙 이벤트를 받을 앱 서버 라우트 — 예 /api/slack/event)가 필요합니다");
  const appRef = input.app_token === undefined ? prev?.app_token_ref : parseTokenRef(input.app_token, "app_token", actor);
  if (!appRef) throw bad("app_token(앱 수준 토큰 xapp- 이 든 금고 칸 — 소켓 모드 연결용)이 필요합니다");
  const botRef = input.bot_token === undefined ? prev?.bot_token_ref : parseTokenRef(input.bot_token, "bot_token", actor);
  if (!botRef) throw bad("bot_token(봇 토큰 xoxb- 이 든 금고 칸 — 답하기용)이 필요합니다");
  if (appRef.owner === botRef.owner && appRef.kind === botRef.kind && appRef.scope_key === botRef.scope_key) {
    throw bad("app_token 과 bot_token 이 같은 금고 칸을 가리킵니다 — 앱 수준 토큰(xapp-)과 봇 토큰(xoxb-)은 다른 칸에 넣습니다");
  }

  const events = listOf(input.events, "events") ?? prev?.events ?? [...DEFAULT_BRIDGE_EVENTS];
  if (!events.length) throw bad(`events 가 비었습니다 — 넘길 종류를 하나 이상 고르세요(${[...BRIDGE_EVENT_TYPES].join(" · ")})`);
  const unknownEvents = events.filter((e) => !BRIDGE_EVENT_TYPES.has(e));
  if (unknownEvents.length) throw bad(`모르는 events: ${unknownEvents.join(", ")} — 고를 수 있는 것: ${[...BRIDGE_EVENT_TYPES].join(" · ")}`);

  const channels = listOf(input.channels, "channels") ?? prev?.channels ?? [];
  if (channels.length > BRIDGE_CHANNELS_MAX) throw bad(`channels 는 ${BRIDGE_CHANNELS_MAX}개까지입니다`);
  const badCh = channels.filter((c) => !SLACK_CHANNEL_RE.test(c));
  if (badCh.length) throw bad(`channels 는 슬랙 채널 id(C… · G… · D…)입니다 — 이름(#채널)이 아니라 id 를 적으세요: ${badCh.slice(0, 5).join(", ")}`);

  const botIds = listOf(input.bot_ids, "bot_ids") ?? prev?.bot_ids ?? [];
  if (botIds.length > BRIDGE_BOT_IDS_MAX) throw bad(`bot_ids 는 ${BRIDGE_BOT_IDS_MAX}개까지입니다`);
  const badBot = botIds.filter((b) => !SLACK_BOT_ID_RE.test(b));
  if (badBot.length) throw bad(`bot_ids 는 슬랙 봇 id(B…)입니다 — 봇 이름이 아니라 메시지의 bot_id 를 적으세요: ${badBot.slice(0, 5).join(", ")}`);

  let runAs: string | null = prev?.run_as ?? null;
  if (input.run_as !== undefined) {
    const r = input.run_as === null ? "" : strOf(input.run_as).toLowerCase();
    if (r && !MEMBER_ID_RE.test(r)) throw bad("run_as 는 구성원 id 입니다");
    runAs = r || null;
  }
  let react: string | null = prev?.react ?? null;
  if (input.react !== undefined) {
    const r = input.react === null ? "" : strOf(input.react).replace(/^:|:$/g, "");
    if (r && !EMOJI_RE.test(r)) throw bad("react 는 슬랙 이모지 이름입니다(예 eyes — 콜론 없이)");
    react = r || null;
  }
  let note: string | null = prev?.note ?? null;
  if (input.note !== undefined) {
    const n = input.note === null ? "" : String(input.note).trim();
    if (n.length > BRIDGE_NOTE_MAX) throw bad(`note 는 ${BRIDGE_NOTE_MAX}자까지입니다`);
    note = n || null;
  }
  const enabled = input.enabled === undefined ? (prev?.enabled ?? true) : input.enabled === true || input.enabled === "true";
  const botMessages = input.bot_messages === undefined ? (prev?.bot_messages ?? false) : input.bot_messages === true || input.bot_messages === "true";
  //  run_as 작업을 사람의 질문으로 보기 — 사람이 양식을 내고 답을 기다리는 워크플로만 고를 때 켠다. 넘길 봇을 고르지 않으면(채널의 모든 봇 글)
  //   알림 · 연동 봇의 글까지 사람의 질문으로 보게 되므로 bot_ids 가 있어야 한다.
  const runAsHuman = input.run_as_human === undefined ? (prev?.run_as_human ?? false) : input.run_as_human === true || input.run_as_human === "true";
  if (runAsHuman && !botIds.length) {
    throw bad("run_as_human 을 켜려면 bot_ids 로 넘길 워크플로를 고르세요 — 고르지 않으면 채널의 모든 봇 글(알림 · 연동 봇 포함)을 사람의 질문으로 보게 됩니다");
  }
  return { id, app_id: appId, route, enabled, app_token_ref: appRef, bot_token_ref: botRef, events, channels, bot_messages: botMessages, bot_ids: botIds, run_as: runAs, run_as_human: runAsHuman, react, note };
}

/** 같은 금고 칸인가 — 한 슬랙 앱(앱 수준 토큰)에 다리 둘이 붙으면 슬랙이 이벤트를 둘 중 한 연결에만 줘 서로 반씩 잃는다. */
export const sameRef = (a: TokenRef, b: TokenRef): boolean => a.owner === b.owner && a.kind === b.kind && a.scope_key === b.scope_key;

// ── 받은 envelope 판정 ─────────────────────────────────────────────────────────────────────
/** 소켓 모드 envelope(슬랙이 보낸 그대로). */
export interface SocketEnvelope {
  envelope_id?: unknown;
  type?: unknown;
  payload?: unknown;
  retry_attempt?: unknown;
  retry_reason?: unknown;
  accepts_response_payload?: unknown;
}

/** 다리가 쥔 봇의 신원(auth.test) — 봇 자신의 글을 거르고 · 다른 워크스페이스 글을 가르는 데 쓴다. 모르면 null 칸. */
export interface BotIdentity { user_id: string | null; bot_id: string | null; team_id: string | null }

export interface EnvelopeVerdict {
  forward: boolean;
  /** 거른 까닭(forward=false) — 상태의 last_filtered 로 보인다. */
  reason: string | null;
  kind: "events_api" | "interactive" | "other";
  /** event.type 또는 payload.type */
  type: string | null;
  /** 한 번만 넘기는 열쇠 — events_api 는 event_id, interactive 는 trigger_id, 없으면 envelope_id. */
  key: string | null;
  /**
   * 같은 글 열쇠(m:<채널>:<ts>) — 글 · 태그(message · app_mention)만. 슬랙은 봇을 태그한 글 하나를 event_id 가 다른 두 이벤트로 보낸다 —
   *  이 열쇠도 함께 쥐어 둘째를 «같은 글» 로 건너뛴다(작업 · AI 실행 · 답이 둘이 되지 않게).
   */
  alt_key: string | null;
  channel: string | null;
  /** 반응을 달 메시지 ts(글 · 태그 · 반응의 대상) */
  ts: string | null;
  /** 안내(ephemeral)를 달 스레드 */
  thread_ts: string | null;
  /** 글쓴이 · 누른 사람(사람일 때) */
  slack_user: string | null;
  /** 워크플로 · 봇이 쓴 글 */
  bot_authored: boolean;
  team_id: string | null;
  /** 사람이 봇을 직접 부른 것(태그 · DM · 버튼 · 모달) — 신원 · 동의가 없을 때 안내를 남기는 자리. 채널의 평범한 글은 안내하지 않는다(시끄럽다). */
  explicit: boolean;
}

const sOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const objOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** 넘기는 메시지 subtype — 여기 없는 것(message_changed · message_deleted · channel_join …)은 글이 아니라 부수 이벤트라 거른다. bot_message 는 bot_messages 가 켜졌을 때만. */
const MESSAGE_SUBTYPES_OK: ReadonlySet<string> = new Set(["", "thread_broadcast", "file_share", "me_message", "bot_message"]);

function verdictBase(kind: EnvelopeVerdict["kind"], type: string | null): EnvelopeVerdict {
  return { forward: false, reason: null, kind, type, key: null, alt_key: null, channel: null, ts: null, thread_ts: null, slack_user: null, bot_authored: false, team_id: null, explicit: false };
}
const drop = (v: EnvelopeVerdict, reason: string): EnvelopeVerdict => ({ ...v, forward: false, reason });

/**
 * envelope 하나를 넘기나(순수). 거르는 순서: 종류 → 고른 종류 → 워크스페이스 → 봇 자신 → 부수 이벤트 → 봇 · 워크플로 글 → 채널 → 글쓴이.
 *  bridge 는 거르기 칸만 본다(events · channels · bot_messages). 신원(구성원 매핑) · 동의는 여기서 보지 않는다 — DB 가 필요하다(manager.ts).
 */
export function envelopeVerdict(env: SocketEnvelope, bridge: Pick<BridgeRow, "events" | "channels" | "bot_messages"> & { bot_ids?: string[] }, bot: BotIdentity): EnvelopeVerdict {
  const envType = sOf(env.type);
  const payload = objOf(env.payload);
  const envelopeKey = sOf(env.envelope_id);
  if (envType === "events_api") {
    if (!payload) return drop(verdictBase("events_api", null), "본문(payload)이 없습니다");
    const ev = objOf(payload.event);
    const type = sOf(ev?.type);
    const v0 = verdictBase("events_api", type);
    if (sOf(payload.type) !== "event_callback" || !ev || !type) return drop(v0, `넘기지 않는 Events API 꼴(${sOf(payload.type) ?? "?"})`);
    const eventId = sOf(payload.event_id);
    const team = sOf(payload.team_id) ?? sOf(ev.team);
    const v: EnvelopeVerdict = { ...v0, key: eventId ? `e:${eventId}` : envelopeKey ? `v:${envelopeKey}` : null, team_id: team };
    if (!bridge.events.includes(type)) return drop(v, `고르지 않은 종류(${type})`);
    if (bot.team_id && team && team !== bot.team_id) return drop(v, "다른 슬랙 워크스페이스의 이벤트");
    const userTeam = sOf(ev.user_team);
    if (bot.team_id && userTeam && userTeam !== bot.team_id) return drop(v, "다른 워크스페이스 사람의 글(Slack Connect)");

    const subtype = sOf(ev.subtype) ?? "";
    const botId = sOf(ev.bot_id);
    const user = sOf(ev.user);
    //  봇 자신의 글 — 앱이 다리로 단 답이 다시 message 이벤트로 돌아온다. 넘기면 끝없는 고리가 된다.
    if ((bot.bot_id && botId === bot.bot_id) || (bot.user_id && user === bot.user_id)) return drop(v, "이 봇 자신의 글");
    if (ev.hidden === true) return drop(v, "숨은 이벤트(hidden)");
    if (type === "message" && !MESSAGE_SUBTYPES_OK.has(subtype)) return drop(v, `글이 아닌 메시지 이벤트(${subtype})`);
    const botAuthored = subtype === "bot_message" || !!botId;
    if (botAuthored && !bridge.bot_messages) return drop({ ...v, bot_authored: true }, "봇 · 워크플로가 쓴 글(bot_messages 꺼짐)");
    const botIds = bridge.bot_ids ?? [];
    if (botAuthored && botIds.length && (!botId || !botIds.includes(botId))) return drop({ ...v, bot_authored: true }, `고르지 않은 봇의 글(${botId ?? "bot_id 없음"})`);
    //  사람이 채널에서 봇을 태그한 글 — 앱이 app_mention 도 고르면 그쪽으로 받는다(같은 글이 두 이벤트로 와 작업이 둘이 되지 않게 · 앱은 태그를 app_mention 으로 가른다).
    //   채널(공개 · 비공개)에서만 — 슬랙은 DM 의 글을 app_mention 으로 보내지 않는다(DM · 그룹 DM 에서 거르면 그 글이 사라진다). 둘 다 오는 자리는 같은 글 열쇠가 막는다.
    const channelType = sOf(ev.channel_type);
    const chId = sOf(ev.channel) ?? "";
    const inChannel = channelType ? channelType === "channel" || channelType === "group" : !!chId && !chId.startsWith("D");
    if (type === "message" && !botAuthored && inChannel && bot.user_id && bridge.events.includes("app_mention")
      && typeof ev.text === "string" && ev.text.includes(`<@${bot.user_id}>`)) {
      return drop(v, "봇을 태그한 글 — app_mention 으로 넘긴다");
    }

    //  채널 · 대상 메시지 — 반응 이벤트는 item 안에 있다.
    const item = objOf(ev.item);
    const channel = type === "reaction_added" || type === "reaction_removed" ? sOf(item?.channel) : sOf(ev.channel);
    const ts = type === "reaction_added" || type === "reaction_removed" ? sOf(item?.ts) : sOf(ev.ts);
    const threadTs = sOf(ev.thread_ts) ?? ts;
    const w: EnvelopeVerdict = { ...v, channel, ts, thread_ts: threadTs, bot_authored: botAuthored, slack_user: botAuthored ? null : user };
    if (bridge.channels.length && (!channel || !bridge.channels.includes(channel))) return drop(w, `고르지 않은 채널(${channel ?? "채널 없음"})`);
    if (!botAuthored && !user) return drop(w, "글쓴이를 알 수 없는 이벤트");
    if (!w.key) return drop(w, "event_id 가 없습니다");
    const explicit = type === "app_mention" || (!!channel && channel.startsWith("D"));
    const altKey = (type === "message" || type === "app_mention") && channel && ts ? `m:${channel}:${ts}` : null;
    return { ...w, forward: true, explicit, alt_key: altKey };
  }
  if (envType === "interactive") {
    if (!payload) return drop(verdictBase("interactive", null), "본문(payload)이 없습니다");
    const type = sOf(payload.type);
    const v0 = verdictBase("interactive", type);
    if (!type) return drop(v0, "payload.type 이 없습니다");
    const userObj = objOf(payload.user);
    const user = sOf(userObj?.id);
    const team = sOf(objOf(payload.team)?.id) ?? sOf(userObj?.team_id);
    const container = objOf(payload.container);
    const message = objOf(payload.message);
    const channel = sOf(objOf(payload.channel)?.id) ?? sOf(container?.channel_id);
    const ts = sOf(container?.message_ts) ?? sOf(message?.ts);
    const trigger = sOf(payload.trigger_id);
    const v: EnvelopeVerdict = {
      ...v0, team_id: team, channel, ts, thread_ts: sOf(message?.thread_ts) ?? ts, slack_user: user,
      key: trigger ? `i:${trigger}` : envelopeKey ? `v:${envelopeKey}` : null,
    };
    if (!bridge.events.includes(type)) return drop(v, `고르지 않은 종류(${type})`);
    if (bot.team_id && team && team !== bot.team_id) return drop(v, "다른 슬랙 워크스페이스의 상호작용");
    if (bridge.channels.length && (!channel || !bridge.channels.includes(channel))) return drop(v, `고르지 않은 채널(${channel ?? "채널 없음 — 모달 등"})`);
    if (!user) return drop(v, "누른 사람을 알 수 없는 상호작용");
    if (!v.key) return drop(v, "trigger_id · envelope_id 가 없습니다");
    return { ...v, forward: true, explicit: true };
  }
  return drop(verdictBase("other", envType), `다리가 넘기지 않는 envelope 종류(${envType ?? "?"})`);
}

/** 앱에 넘기기 전에 뺄 칸 — 슬랙의 옛 검증 토큰(token)은 그 슬랙 앱의 공유 비밀이다(남의 HTTP 요청을 이 앱인 척 꾸미는 데 쓰인다). */
function withoutToken(o: Record<string, unknown>): Record<string, unknown> {
  const { token: _t, ...rest } = o;
  return rest;
}

/** 작업을 돌리는 사람 — 어떻게 찾았나(via): identity(구성원 신원) · slack_login(그 사람이 [Slack 연결] 한 계정) · email · run_as(사람이 쓰지 않은 글). */
export interface BridgeActor { slack_user: string | null; member: string; via: "identity" | "slack_login" | "email" | "run_as" }

/**
 * 앱 라우트가 받는 작업 본문(이슈 #1782 «넘기기»). events_api 는 event 를, interactive 는 payload 를 그대로(옛 검증 토큰만 뺀다) 싣는다.
 *  bridge = 이 다리 id(앱이 slack_bridge_call 로 답할 때 그대로 넘긴다) · actor = 작업을 돌리는 사람과 찾은 길.
 */
export function bridgeJobBody(env: SocketEnvelope, v: EnvelopeVerdict, bridgeId: string, actor: BridgeActor, receivedAt: Date): Record<string, unknown> {
  const payload = objOf(env.payload) ?? {};
  const base: Record<string, unknown> = {
    kind: v.kind, bridge: bridgeId, team_id: v.team_id, received_at: receivedAt.toISOString(),
    actor: { slack_user: actor.slack_user, member: actor.member, via: actor.via },
  };
  if (v.kind === "events_api") {
    return { ...base, event_id: sOf(payload.event_id), event_time: typeof payload.event_time === "number" ? payload.event_time : null, event: objOf(payload.event) ?? {} };
  }
  return { ...base, event_id: null, payload: withoutToken(payload) };
}

/** 작업 이름표 — 앱의 작업 목록에서 «슬랙 app_mention» 처럼 보인다. */
export const bridgeJobLabel = (v: EnvelopeVerdict): string => `슬랙 ${v.type ?? v.kind}`;

// ── 앱이 부르는 슬랙 메서드 검사 ────────────────────────────────────────────────────────────
export interface CallPlan { method: BridgeCallMethod; args: Record<string, unknown>; json: boolean; channel: string | null; ts: string | null }

/**
 * slack_bridge_call 입력 검사(순수) — 메서드 허용 목록 · args 모양 · 크기 · 채널. 다리에 채널을 골라 두었으면 채널을 가리키는 호출은 그 채널(또는 DM)만 —
 *  다리 설정이 앱이 움직이는 자리를 정한다(앱 코드가 다른 채널에 글을 뿌리지 못하게).
 */
export function bridgeCallPlan(method: unknown, args: unknown, bridge: Pick<BridgeRow, "channels">): CallPlan {
  const m = typeof method === "string" ? method.trim() : "";
  if (!(BRIDGE_CALL_METHODS as readonly string[]).includes(m)) throw bad(`method 는 ${BRIDGE_CALL_METHODS.join(" · ")} 중 하나입니다`);
  const a = args === undefined || args === null ? {} : objOf(args);
  if (!a) throw bad("args 는 슬랙 메서드에 넘길 객체입니다(예 { channel, text, thread_ts })");
  if ("token" in a) throw bad("args 에 token 을 넣지 않습니다 — 다리가 금고의 봇 토큰을 싣습니다");
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(a), "utf8"); } catch { throw bad("args 를 JSON 으로 만들 수 없습니다"); }
  if (size > BRIDGE_CALL_ARGS_MAX) throw bad(`args 가 너무 큽니다(${size}바이트 — ${BRIDGE_CALL_ARGS_MAX}바이트까지)`);
  const channel = sOf(a.channel);
  if (channel && bridge.channels.length && !bridge.channels.includes(channel) && !channel.startsWith("D")) {
    throw new HttpError(403, `이 다리는 고른 채널(${bridge.channels.join(", ")})과 DM 에서만 부를 수 있습니다 — ${channel} 은(는) 다리 설정(channels) 밖입니다`);
  }
  const ts = sOf(a.ts) ?? sOf(a.thread_ts) ?? sOf(a.timestamp) ?? sOf(a.message_ts);
  return { method: m as BridgeCallMethod, args: a, json: JSON_BODY_METHODS.has(m), channel, ts };
}

/** form 본문 — 객체 · 배열 값은 JSON 글로(슬랙 form 관례 — blocks 등). */
export function formBodyOf(args: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return p.toString();
}

// ── 앱이 읽는 슬랙 파일(slack_bridge_file) ─────────────────────────────────────────────────
/** 슬랙 파일 id(F…). */
export const SLACK_FILE_ID_RE = /^F[A-Z0-9]{6,20}$/;
/** 내려받는 파일의 크기 상한 — 넘으면 받지 않는다. */
export const BRIDGE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** 그림을 줄일 긴 변(px) — 모델이 그림을 보는 크기. PNG · JPEG · HEIC 는 이 크기의 JPEG 로 바꿔 준다. */
export const BRIDGE_FILE_IMAGE_EDGE = 1568;
/** 바꾸지 못하는 그림(GIF · WEBP)을 그대로 줄 때의 크기 상한 — 넘으면 주지 않는다(모델 입력 상한 5MB 를 base64 로 넘지 않게). */
export const BRIDGE_FILE_RAW_IMAGE_MAX = 3_500_000;
/** 글 파일을 줄 때의 글자 상한 — 넘으면 앞부분만 주고 truncated 로 알린다. */
export const BRIDGE_FILE_TEXT_MAX = 100_000;

/** 파일을 무엇으로 주나 — image(그림 조각) · text(글) · unsupported(읽지 않는다 · 까닭은 reason). */
export type BridgeFileKind = "image" | "text" | "unsupported";
export interface BridgeFilePlan {
  id: string; name: string; mimetype: string | null; filetype: string | null; size: number | null;
  kind: BridgeFileKind;
  /** image 일 때 — 줄여 JPEG 로 바꿀 형식. null 이면 그대로 준다(GIF · WEBP). */
  convert: "png" | "jpeg" | "heic" | null;
  /** 내려받을 주소(슬랙 파일 서버) — unsupported 면 null. */
  url: string | null;
  /** unsupported 인 까닭(사람이 읽는 글). */
  reason: string | null;
  /** 이 파일이 공유된 채널 중 다리가 고른 채널(기록용 · 다리가 채널을 고르지 않았으면 첫 채널). */
  channel: string | null;
}

/** 슬랙 파일 서버의 주소인가 — https 이고 files.slack.com(또는 그 아래)만. 파일 정보(files.info)가 준 주소를 그대로 믿지 않는다(봇 토큰을 실어 보내는 자리다). */
export function isSlackFileUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && (u.hostname === "files.slack.com" || u.hostname.endsWith(".files.slack.com"));
  } catch { return false; }
}

/** 파일이 공유된 채널 — files.info 의 channels · groups · ims 와 shares(public · private)의 열쇠. */
export function slackFileChannels(file: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of ["channels", "groups", "ims"]) {
    const v = file[k];
    if (Array.isArray(v)) for (const c of v) if (typeof c === "string" && c) out.add(c);
  }
  const shares = objOf(file.shares);
  for (const k of ["public", "private"]) {
    const m = objOf(shares?.[k]);
    if (m) for (const c of Object.keys(m)) if (c) out.add(c);
  }
  return [...out];
}

const TEXT_MIMES: ReadonlySet<string> = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml", "application/csv"]);

/**
 * slack_bridge_file 판정(순수) — files.info 가 준 파일 하나를 이 다리로 읽어도 되나 · 무엇으로 주나.
 *  다리에 채널을 골라 두었으면 그 채널에 공유된 파일만(403) — slack_bridge_call 과 같이 다리 설정이 앱이 닿는 자리를 정한다(봇이 들어간 다른 채널의 파일을 앱이 읽지 못하게).
 *  읽지 못하는 파일(바깥 저장소의 파일 · 너무 큰 파일 · 그림도 글도 아닌 형식)은 던지지 않고 unsupported 로 답한다 — 부른 쪽(AI)이 까닭을 사람에게 전하게.
 */
export function bridgeFilePlan(file: unknown, bridge: Pick<BridgeRow, "channels">, urlOk: (url: string) => boolean = isSlackFileUrl): BridgeFilePlan {
  const f = objOf(file);
  const id = sOf(f?.id);
  if (!f || !id || !SLACK_FILE_ID_RE.test(id)) throw new HttpError(502, "슬랙이 파일 정보를 주지 않았습니다");
  const shared = slackFileChannels(f);
  const hit = bridge.channels.length ? shared.find((c) => bridge.channels.includes(c)) ?? null : shared[0] ?? null;
  if (bridge.channels.length && !hit) {
    throw new HttpError(403, `이 다리는 고른 채널(${bridge.channels.join(", ")})에 공유된 파일만 읽습니다 — ${id} 은(는) 그 채널에 없습니다`);
  }
  const mimetype = sOf(f.mimetype)?.toLowerCase().split(";")[0]!.trim() || null;
  const size = typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : null;
  const base = {
    id, name: (sOf(f.name) ?? sOf(f.title) ?? id).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || id,
    mimetype, filetype: sOf(f.filetype), size, channel: hit,
  };
  const no = (reason: string): BridgeFilePlan => ({ ...base, kind: "unsupported", convert: null, url: null, reason });
  const mode = sOf(f.mode);
  if (mode === "external" || f.is_external === true) return no("슬랙 밖 저장소(구글 드라이브 등)에 있는 파일이라 슬랙에서 받을 수 없습니다");
  if (mode === "tombstone" || mode === "hidden_by_limit") return no("지워졌거나 슬랙 요금제 한도로 가려진 파일입니다");
  //  urlOk — 내려받아도 되는 주소(기본은 슬랙 파일 서버). 시험이 가짜 슬랙의 주소를 받게 바꿔 끼운다(slack-api SlackApiDeps.fileUrlOk 와 같은 것).
  const url = [f.url_private_download, f.url_private].find((u): u is string => typeof u === "string" && urlOk(u));
  if (!url) return no("슬랙이 내려받을 주소를 주지 않았습니다");
  if (size !== null && size > BRIDGE_FILE_MAX_BYTES) return no(`파일이 너무 큽니다(${size}바이트 — ${BRIDGE_FILE_MAX_BYTES}바이트까지)`);
  if (mimetype === "image/png") return { ...base, kind: "image", convert: "png", url, reason: null };
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") return { ...base, kind: "image", convert: "jpeg", url, reason: null };
  if (mimetype === "image/heic" || mimetype === "image/heif") return { ...base, kind: "image", convert: "heic", url, reason: null };
  if (mimetype === "image/gif" || mimetype === "image/webp") {
    if (size !== null && size > BRIDGE_FILE_RAW_IMAGE_MAX) return no(`줄일 수 없는 형식(${mimetype})인데 너무 큽니다(${size}바이트 — ${BRIDGE_FILE_RAW_IMAGE_MAX}바이트까지)`);
    return { ...base, kind: "image", convert: null, url, reason: null };
  }
  if (mimetype && (mimetype.startsWith("text/") || TEXT_MIMES.has(mimetype))) return { ...base, kind: "text", convert: null, url, reason: null };
  return no(`읽지 못하는 형식입니다(${mimetype ?? base.filetype ?? "형식 모름"}) — 그림(PNG · JPEG · HEIC · GIF · WEBP)과 글 파일만 읽습니다`);
}

// ── 연결 ──────────────────────────────────────────────────────────────────────────────────
/** 다시 붙기까지 기다릴 시간 — 1초부터 두 배씩 60초까지 + 0~0.5초 흔들기(여러 다리가 한꺼번에 몰리지 않게). */
export function reconnectDelayMs(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(0, Math.min(6, Math.floor(attempt)));
  return Math.min(60_000, 1000 * 2 ** n) + Math.floor(rand() * 500);
}

/** 슬랙이 준 소켓 주소인가 — wss 이고 slack.com 아래만(apps.connections.open 응답을 그대로 믿지 않는다). */
export function isSlackSocketUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "wss:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"));
  } catch { return false; }
}

/** 소켓 주소의 app_id(슬랙 앱) — 한 슬랙 앱에 다리 둘이 붙었는지 가르는 데 쓴다. 없으면 null. */
export function socketAppIdOf(raw: string): string | null {
  try { return new URL(raw).searchParams.get("app_id"); } catch { return null; }
}

/** 오류 글 — 상태 칸에 남길 짧은 글(토큰 모양은 가린다 · 300자). */
export function shortError(e: unknown): string {
  const s = String((e as { message?: unknown })?.message ?? e ?? "오류");
  return s.replace(/x(?:app|oxb|oxp|oxe)[-.][A-Za-z0-9.-]+/g, "[토큰]").slice(0, 300);
}

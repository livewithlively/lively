// 내가 속한 슬랙 대화 목록(#1226) — 채널별 열람/발송 정책 화면이 '무엇을 고를지' 보여주려면 필요하다.
//
// 왜 슬랙 MCP 툴이 아니라 Web API 직접인가: 정책 화면은 **정책이 아직 없을 때도** 떠야 하고,
//  슬랙 MCP 서버가 발행(tools_snapshot)되기 전에도 떠야 한다. 목록 조회는 users.conversations 한 방이면
//  끝나므로 상류 MCP 를 거칠 이유가 없다. 인증은 같은 개인 자격을 쓴다:
//   ① OAuth 커넥터(auth_kind=slack_oauth) 로 연결한 access_token — 관리자가 슬랙 MCP 를 등록한 배포.
//   ② 개인 정적 사용자토큰(member_secret kind=slack_user_token, xoxp-) — MCP 미등록 배포의 대안 경로.
//
// scope: channels:read·groups:read·mpim:read 는 프리셋 기본. im:read 는 나중에 추가돼 **먼저 연결한 사람의
//  토큰엔 없다** → im 을 넣은 요청이 missing_scope 로 통째 거부되므로, 그 땐 im 을 빼고 한 번 더 부른다.
import { getMemberSecret, memberOwner } from "../credentials/member-secret-store.js";
import { listMcpServers } from "../store.js";
import { providerForServer } from "../credentials/oauth-broker.js";
import { upsertChannelMeta } from "./channel-meta-store.js";
import { logger } from "../../log.js";

const API_BASE = "https://slack.com/api";
const CALL_TIMEOUT_MS = 15000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;          // 최대 2000개 대화 — 그 이상은 화면에서도 다룰 수 없다.
const USER_MAX_PAGES = 5;      // DM 상대 이름 해소용 users.list(최대 1000명)
// 집행 중 캐시 미스로 단건 조회할 대화 수 상한. 슬랙 검색은 한 번에 최대 20건을 주고 `only_my_channels`
//  기본값이 false 라 **내가 안 속한 공개 채널도 결과에 섞인다** — 그런 채널은 users.conversations(내가 속한
//  대화)로는 영영 안 잡혀 이 단건 조회가 유일한 해소 경로다. 상한이 결과 수보다 작으면 나머지가 unknown 으로
//  남아 '공개 채널인데 차단' 이 된다. 병렬 호출이라 20개여도 지연은 1회분에 가깝다.
const INFO_MAX = 20;

export type SlackChannelType = "public" | "private" | "group_dm" | "dm";

export interface SlackConversation {
  id: string;
  name: string;               // 표시명(공개/비공개=채널명, DM=상대 이름)
  type: SlackChannelType;
  is_member: boolean;
  /** DM 이면 상대 user_id(U…) — 슬랙이 DM 을 user_id 로도 열기 때문에 정책이 이 값도 대조한다. */
  peer_id?: string | null;
}

export interface SlackChannelListResult {
  connected: boolean;
  auth: "oauth" | "token" | null;
  conversations: SlackConversation[];
  /** im 을 못 받아온 경우(구 토큰에 im:read 없음) — 화면이 "DM 은 목록에 없습니다"를 정직하게 알리게. */
  dm_listed: boolean;
  warning?: string;
}

interface SlackEnvelope { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } }
interface ConversationRow {
  id?: string; name?: string; user?: string;
  is_channel?: boolean; is_group?: boolean; is_im?: boolean; is_mpim?: boolean; is_private?: boolean;
  is_archived?: boolean; is_member?: boolean;
}
interface UserRow { id?: string; name?: string; real_name?: string; deleted?: boolean; profile?: { display_name?: string; real_name?: string } }

// 개인 슬랙 자격 해소 — OAuth 연결 우선, 없으면 정적 사용자토큰. 둘 다 없으면 미연결.
export async function resolveSlackToken(memberId: string): Promise<{ token: string; auth: "oauth" | "token" } | null> {
  try {
    const servers = await listMcpServers();
    const slack = servers.find((s) => s.mode === "proxy" && s.auth_kind === "slack_oauth" && s.enabled !== false);
    if (slack) {
      const provider = await providerForServer(memberId, slack);
      const tk = await provider.tokens();
      if (tk?.access_token) return { token: tk.access_token, auth: "oauth" };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "슬랙 OAuth 토큰 해소 실패 — 정적 토큰으로 폴백");
  }
  const stat = await getMemberSecret(memberOwner(memberId), "slack_user_token", "").catch(() => null);
  if (stat?.secret) return { token: stat.secret, auth: "token" };
  return null;
}

type SlackBody = SlackEnvelope & Record<string, unknown>;
async function slackCall(method: string, token: string, params: Record<string, string>): Promise<SlackBody> {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
    if (res.status === 429) {
      throw new Error("슬랙이 요청을 제한하고 있습니다(429) — 잠시 후 다시 시도하세요.");
    }
    const body = (await res.json()) as SlackEnvelope & Record<string, unknown>;
    if (!body.ok) throw new Error(`slack ${method}: ${body.error ?? "unknown_error"}`);
    return body;
  } finally { clearTimeout(timer); }
}

function classify(c: ConversationRow): SlackChannelType {
  if (c.is_im) return "dm";
  if (c.is_mpim) return "group_dm";
  if (c.is_private || c.is_group) return "private";
  return "public";
}

// truncated: 페이지 상한에 걸려 뒤가 잘렸는가 — 조용히 자르면 '목록에 없으니 안 열려 있다'는 오해를 부른다(화면이 알린다).
async function fetchConversations(token: string, types: string): Promise<{ rows: ConversationRow[]; truncated: boolean }> {
  const out: ConversationRow[] = [];
  let cursor = "";
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await slackCall("users.conversations", token, {
      types, exclude_archived: "true", limit: String(PAGE_LIMIT), cursor,
    });
    out.push(...((body.channels as ConversationRow[] | undefined) ?? []));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows: out, truncated };
}

// DM 상대 이름 — users.list 1회(페이지네이션)로 id→표시명 맵. DM 이 없으면 아예 부르지 않는다.
async function fetchUserNames(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor = "";
  for (let page = 0; page < USER_MAX_PAGES; page++) {
    const body = await slackCall("users.list", token, { limit: String(PAGE_LIMIT), cursor });
    for (const u of ((body.members as UserRow[] | undefined) ?? [])) {
      if (!u.id) continue;
      const nm = u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || u.id;
      map.set(u.id, nm);
    }
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return map;
}

// 내가 속한 대화 전부(공개·비공개·그룹DM·DM). 미연결이면 connected:false 로 조용히 돌아간다(에러 아님 — 화면이 안내).
export async function listMySlackConversations(memberId: string): Promise<SlackChannelListResult> {
  const cred = await resolveSlackToken(memberId);
  if (!cred) return { connected: false, auth: null, conversations: [], dm_listed: false };

  const FULL = "public_channel,private_channel,mpim,im";
  const NO_DM = "public_channel,private_channel,mpim";
  let fetched: { rows: ConversationRow[]; truncated: boolean };
  let dmListed = true;
  const warnings: string[] = [];
  try {
    fetched = await fetchConversations(cred.token, FULL);
  } catch (err) {
    const msg = (err as Error).message;
    if (!/missing_scope|not_allowed_token_type|invalid_scope/i.test(msg)) throw err;
    // im:read 가 없는 (먼저 연결해 둔) 토큰 — DM 만 빼고 다시. 재연결하면 DM 도 목록에 잡힌다.
    fetched = await fetchConversations(cred.token, NO_DM);
    dmListed = false;
    warnings.push("이 슬랙 연결에는 DM 목록 권한(im:read)이 없어 1:1 DM 은 목록에 없습니다 — [다시 연결]하면 DM 도 고를 수 있습니다.");
  }
  const rows = fetched.rows;
  if (fetched.truncated) warnings.push(`대화가 많아 앞의 ${MAX_PAGES * PAGE_LIMIT}개까지만 불러왔습니다 — 목록에 없는 대화도 지금은 허용 상태입니다.`);

  const needNames = rows.some((c) => c.is_im && c.user);
  const names = needNames ? await fetchUserNames(cred.token).catch(() => new Map<string, string>()) : new Map<string, string>();

  const conversations: SlackConversation[] = [];
  for (const c of rows) {
    if (!c.id || c.is_archived) continue;
    const type = classify(c);
    const name = type === "dm"
      ? (names.get(c.user ?? "") ?? c.user ?? c.id)
      : (c.name ?? c.id);
    conversations.push({ id: c.id, name, type, is_member: c.is_member !== false, peer_id: type === "dm" ? (c.user ?? null) : null });
  }
  conversations.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "ko") : TYPE_ORDER[a.type] - TYPE_ORDER[b.type]));
  // 알아낸 종류를 캐시에 남긴다(#1262) — 집행 자리(mcp-proxy)는 채널 id 로 공개/비공개를 가릴 수 없어
  //  이 캐시에만 의존한다. 목록을 부르는 경로가 어디든(화면·집행) 여기서 한 번에 채워진다.
  //  실패해도 목록 조회 자체는 성공시킨다 — 화면이 뜨는 것과 캐시가 차는 것은 별개 관심사다.
  await upsertChannelMeta(memberId, "slack", conversations.map((c) => ({
    channel_id: c.id, channel_name: c.name, channel_type: c.type, peer_id: c.peer_id ?? null,
  }))).catch((err) => { logger.warn({ err: (err as Error).message }, "대화 종류 캐시 저장 실패"); return 0; });
  return { connected: true, auth: cred.auth, conversations, dm_listed: dmListed, warning: warnings.join(" ") || undefined };
}

// 캐시에 없는 대화의 종류를 슬랙에 직접 물어본다(conversations.info) — 집행 중 캐시 미스 경로(#1262).
//  목록 전체 동기화(users.conversations, 최대 10페이지 + users.list)는 무거워서 매 호출에 쓸 수 없다.
//  지목된 대화 몇 개만 알면 되는 자리라 단건 조회가 맞다. 상한(INFO_MAX)을 넘는 건 조회하지 않는다 —
//  그 대화들은 unknown 으로 남아 기본값(거부)에 걸린다(모르면 막는다).
//  ⚠ U…(DM 상대 user_id)는 여기서 못 푼다 — conversations.info 는 대화 id 만 받는다. DM 은 목록 동기화가 해소한다.
export async function fetchConversationTypes(memberId: string, ids: string[]): Promise<SlackConversation[]> {
  const wanted = [...new Set(ids)].filter((id) => /^[CGD][A-Z0-9]{6,20}$/.test(id)).slice(0, INFO_MAX);
  if (!wanted.length) return [];
  const cred = await resolveSlackToken(memberId);
  if (!cred) return [];
  const out = await Promise.all(wanted.map(async (id) => {
    try {
      const body = await slackCall("conversations.info", cred.token, { channel: id });
      const c = body.channel as ConversationRow | undefined;
      if (!c?.id) return null;
      const type = classify(c);
      return {
        id: c.id, name: type === "dm" ? (c.user ?? c.id) : (c.name ?? c.id), type,
        is_member: c.is_member !== false, peer_id: type === "dm" ? (c.user ?? null) : null,
      } as SlackConversation;
    } catch (err) {
      // 못 물어본 대화(권한 밖·없는 id·429)는 조용히 넘긴다 — unknown 으로 남아 기본값(거부)이 적용된다.
      logger.debug({ id, err: (err as Error).message }, "conversations.info 실패 — 종류 미해소");
      return null;
    }
  }));
  const found = out.filter((c): c is SlackConversation => !!c);
  if (found.length) {
    await upsertChannelMeta(memberId, "slack", found.map((c) => ({
      channel_id: c.id, channel_name: c.name, channel_type: c.type, peer_id: c.peer_id ?? null,
    }))).catch(() => 0);
  }
  return found;
}

const TYPE_ORDER: Record<SlackChannelType, number> = { public: 0, private: 1, group_dm: 2, dm: 3 };

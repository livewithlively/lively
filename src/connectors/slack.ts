// Slack 커넥터 (DESIGN §8, #541 유저토큰 재작성) — 슬랙 메시지를 canonical RawItem 으로.
//
// ── 두 모드(#1531) ──────────────────────────────────────────────────────────
//  어느 토큰이 설정됐는지가 곧 모드다. 둘은 경쟁이 아니라 **상보**다 — 서로가 못 보는 것을 본다.
//   · 유저 토큰(xoxp-) = **검색 스윕**(search.messages) — 봇 초대 없이 전 공개채널. 비공개는 원리적으로 불가.
//   · 봇 토큰(xoxb-)   = **멤버십 스윕**(conversations.*) — 봇이 초대된 채널만, 대신 **비공개 채널이 들어온다**.
//  둘 다 필요하면 수집기 인스턴스를 두 개 만든다(#1419) — 커서가 인스턴스별로 갈려 서로의 진행을 밀지 않는다.
//  한 수집기에 둘 다 들어 있으면 **유저 토큰이 이긴다**(기존 배포가 env SLACK_BOT_TOKEN 을 갖고 있어도 모드가
//  조용히 바뀌지 않게 하는 안전장치 — 모드 전환은 언제나 명시적 선택이어야 한다).
//
// 왜 search.messages(유저 토큰) 인가:
//   봇 토큰(xoxb-)의 conversations.history 는 **봇이 가입한 채널만** 읽힌다(미가입 공개채널은 not_in_channel).
//   유저 토큰(xoxp-)이어도 conversations.history 는 여전히 멤버십을 요구한다. 반면 워크스페이스 멤버는
//   **가입하지 않은 공개채널의 메시지도 검색으로 볼 수 있어**, search.messages 는 봇/사람 누구도 채널에 조인하지
//   않고 전 공개채널을 훑는다(조인 시스템 메시지·권한 재설치 불필요). 이것이 CTO wiki-sync 가 택한 sweep 경로다.
//   ⚠ search.messages 는 봇 토큰을 거부한다(not_allowed_token_type) — **반드시 유저 토큰(xoxp-)**.
//
// 인증/스코프(유저 토큰): search:read(검색) · channels:read(채널 메타) · users:read(+users:read.email 작성자 해소).
//   (스레드 재구성은 permalink 의 thread_ts 로 하므로 groups:history 등은 불필요.)
// 인증/스코프(봇 토큰): groups:history·groups:read(비공개) · channels:history·channels:read(공개) · users:read
//   (+첨부 본문까지 받으려면 files:read). 봇을 대상 채널에 /invite 해야 읽힌다.
//
// 수집 범위(유저 토큰): 공개채널만 — search match 의 channel 플래그로 DM/비공개/mpim 을 제외(토큰 소유자 개인 대화 유입 방지).
// 수집 범위(봇 토큰): 봇이 초대된 공개·**비공개** 채널(보관 채널 포함). '대상 채널' 설정으로 더 좁힐 수 있고,
//   DM/그룹DM 은 어느 설정에서도 들어오지 않는다. 스레드 답글은 history 가 주지 않으므로 replies 로 따로 받는다.
//
// 최초 마이그레이션 vs 증분:
//   · search.messages 의 after:/before: 는 **일 단위·exclusive** → 하루 넉넉히 잡고 ts 로 재필터. count 100/page,
//     page 는 최대 100 → **쿼리당 최신 10,000건 상한**. 이를 넘기면 창을 이분(bisect)해 완결성 보전(무손실 불변식).
//   · backfill({since}) — since 있으면 [since, now] 만(증분). 없으면(최초) now 에서 30일 창을 과거로 밀며
//     활동이 끊길 때까지(DRY_STOP 연속 빈 창) 또는 backfill_since 하한까지 스윕. run-sync 가 max(occurred_at)로 커서 전진.
//   · 편집(edited)은 게시일 기준 search 라 증분 창 밖이면 못 잡지만, 일일 full 스윕(store.ts 가 자동 등록하는
//     sync-slack-full)이 전 이력을 재수집(멱등 upsert)해 치유한다 — notion full 스윕과 동일 패턴.
//
// 참고: 엔드포인트 https://slack.com/api/<method>, 응답 { ok, error?, ... }. 429 는 Retry-After 존중(slackCall).
//   external_id = `${channel}:${ts}`(system+instance 내 안정·고유). 스레드 답글 = permalink 의 thread_ts 로 부모 링크.

import { Readable } from "node:stream";
import type { Connector, RawItem, BackfillOpts, ConnectorUser } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { ooxmlKindFromMime, extractOoxml, printableRatio, type OoxmlKind } from "./ooxml.js";

const API_BASE = "https://slack.com/api";

// 토큰 형식 판별(#1881) — 토큰 회전을 켠 앱은 `xoxe.xoxp-…`/`xoxe.xoxb-…` 를 준다(라이블리 앱은 v1 회전 OFF 지만 형식은 받아 둔다).
//  검색 스윕은 유저 토큰만(search.messages 가 봇 토큰을 거부), 봇 모드는 봇 토큰만 — 칸을 바꿔 넣은 실수를 부팅 때 잡는다.
export const isSlackUserToken = (t: string): boolean => /^(xoxp-|xoxe\.xoxp-)/.test(t);
export const isSlackBotToken = (t: string): boolean => /^(xoxb-|xoxe\.xoxb-)/.test(t);

// ── 스윕 파라미터 ────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS; // 최초 마이그레이션 스윕 기본 창(월 단위) — 대부분 상한 미만이라 이분 없이 통과.
const SEARCH_COUNT = 100; // search.messages count 상한.
const SEARCH_MAXP = 100; // search.messages page 상한 → 쿼리당 최신 SEARCH_COUNT*SEARCH_MAXP(=10k)건까지.
const BISECT_FLOOR_MS = 2 * DAY_MS; // 이 이하로는 이분해도 after/before(일 granular)가 더 못 좁힘 → 잘림 경고만.
const DRY_STOP = 12; // 최초 스윕 시 연속 빈 창 이만큼이면 이력 시작으로 보고 종료(하한 미지정일 때만).
const MAX_WINDOWS = 400; // 무한루프 백스톱(하한 -Infinity 안전장치).
// ── 봇 모드(conversations.*) 파라미터 ───────────────────────────────────────
const HISTORY_LIMIT = 200; // conversations.history/replies 페이지 크기(상한 1000이나 200이 권장 상한대).
const CHANNEL_LIST_LIMIT = 200; // users.conversations 페이지 크기.
// 증분에서 **오래된 스레드에 달린 새 답글**을 잡기 위한 부모 역스캔 창.
//  왜 필요한가: conversations.history 는 스레드 답글을 돌려주지 않고(부모만), oldest 필터는 **부모의 ts** 로
//  건다. 그래서 커서 이후만 훑으면 "3개월 전 스레드에 오늘 달린 답글"이 영영 안 잡힌다. 부모를 이 창만큼
//  거슬러 훑고 그중 latest_reply 가 커서 이후인 것만 replies 를 호출한다(호출 수는 변경된 스레드 수에 비례).
//  이 창보다 오래된 스레드의 새 답글은 일일 full 스윕(collector-<id>-full)이 치유한다 — search 모드가
//  편집(edited)을 치유하는 것과 같은 구조.
const THREAD_LOOKBACK_MS = 30 * DAY_MS;
// 채널 하나에서 history 페이지를 무한히 넘기지 않기 위한 백스톱(200 * 500 = 10만 건).
const HISTORY_PAGE_MAX = 500;
// 파일 수집(files.list) 파라미터.
const FILE_INCR_LOOKBACK_MS = 2 * DAY_MS; // 증분 시 파일 ts_from 을 커서보다 넉넉히 당김 — 단일 커서가 메시지에
//  끌려 앞서갈 때 그 사이 업로드된 파일 스트래글러 유실 방지(멱등 upsert 라 재수집 무해). 일일 full 스윕이 최종 백스톱.
const FILE_BODY_MAX = 100_000; // 텍스트 파일 본문 상한(byte) — 과대 파일 방어.
const FILE_PAGE_MAX = 200; // files.list 페이지 백스톱.
// 텍스트로 간주해 본문을 다운로드할 filetype(그 외 + 바이너리는 메타+링크만).
const TEXT_FILETYPES = new Set([
  "text", "markdown", "post", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "log", "diff", "patch",
  "javascript", "js", "typescript", "ts", "tsx", "jsx", "python", "py", "ruby", "go", "rust", "java",
  "c", "cpp", "h", "css", "scss", "shell", "bash", "sh", "sql", "toml", "ini", "conf",
]);

// ── Slack 응답 타입(필요한 필드만) ──────────────────────────────────────────
interface SlackResponseMeta {
  next_cursor?: string;
}
interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: SlackResponseMeta;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string; // epoch seconds 문자열
  user?: string; // 사람 작성자 id
  bot_id?: string; // 봇 작성자 id (user 없을 때)
  username?: string; // 봇/레거시 메시지의 표시 이름
  text?: string;
  thread_ts?: string; // 스레드 소속 ts (부모면 자기 ts 와 동일)
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string; // 스레드 부모에만 — 마지막 답글 ts(증분에서 '이 스레드를 다시 열어볼까' 판정에 쓴다)
  parent_user_id?: string;
  edited?: { user?: string; ts?: string };
  [k: string]: unknown; // raw 보존용 — 그 외 필드 통과
}

// users.list 결과(작성자 해소용 최소 형태).
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
}

// toRawItem 에 넘기는 컨텍스트 — 변환을 네트워크와 분리하기 위한 순수 입력.
export interface SlackToRawItemCtx {
  channel: string; // 채널 id (container_ref)
  channelName?: string; // 채널 표시명(#735 — search match channel.name). container_name 으로 보존(지식화 맥락).
  channelPrivate?: boolean; // 비공개 채널 여부(맥락/민감도 라벨) → fields.channel_is_private.
  instance: string; // 워크스페이스/팀 식별자 (provenance.instance)
  teamDomain?: string; // 딥링크용 <team>.slack.com 의 <team>. 없으면 딥링크 생략.
  /** user id → 표시이름/이메일 해소 맵 (네트워크 없이 주입). */
  userMap?: Map<string, SlackUser>;
  /** 권위 있는 permalink(search match) — 있으면 teamDomain 재구성 대신 이걸 external_url 로 쓴다. */
  explicitUrl?: string;
}

// ── 순수 변환: 원본 메시지 1건 → RawItem (네트워크 없음, 단위테스트 대상) ──────
export function toRawItem(msg: SlackMessage, ctx: SlackToRawItemCtx): RawItem {
  const { channel, instance, teamDomain, userMap, explicitUrl, channelName, channelPrivate } = ctx;

  // external_id: system+instance 내에서 안정·고유. 채널 + ts 조합.
  const external_id = `${channel}:${msg.ts}`;

  // 작성자 해소: user(사람) 우선, 없으면 bot_id. 표시이름은 userMap → username 폴백.
  const actorExternalId = msg.user ?? msg.bot_id;
  const resolvedUser = msg.user && userMap ? userMap.get(msg.user) : undefined;
  const displayName =
    resolvedUser?.profile?.display_name?.trim() ||
    resolvedUser?.real_name?.trim() ||
    resolvedUser?.profile?.real_name?.trim() ||
    resolvedUser?.name?.trim() ||
    msg.username?.trim() ||
    undefined;
  const email = resolvedUser?.profile?.email?.trim() || undefined;

  // 스레드 부모: thread_ts 가 존재하고 자기 ts 와 다르면 답글 → 부모 external_id 지정.
  const parent_external_id =
    msg.thread_ts && msg.thread_ts !== msg.ts ? `${channel}:${msg.thread_ts}` : undefined;

  // 딥링크: 권위 permalink(explicitUrl) 우선, 없으면 teamDomain 으로 결정적 구성.
  const external_url =
    explicitUrl ?? (teamDomain ? buildPermalink(teamDomain, channel, msg) : undefined);

  const occurred_at = tsToIso(msg.ts);
  // edited.ts 가 있으면 updated_at 으로 반영.
  const updated_at = msg.edited?.ts ? tsToIso(msg.edited.ts) : undefined;

  const item: RawItem = {
    type: "message",
    provenance: {
      category: "messenger",
      system: "slack",
      instance,
      external_id,
      external_url,
    },
    actor: actorExternalId
      ? {
          external_id: actorExternalId,
          display_name: displayName,
          email,
          // bot_id 폴백(external_id 가 bot_id 인 케이스) 포함 — user 없는 봇 메시지.
          is_bot: Boolean(msg.bot_id) && !msg.user,
        }
      : undefined,
    container_ref: channel,
    container_name: channelName,
    parent_external_id,
    // 메시지엔 별도 제목이 없다. 본문 첫 줄을 짧게 잘라 제목 보조로 둔다.
    title: deriveTitle(msg.text),
    body: msg.text ?? undefined,
    occurred_at,
    updated_at,
    fields: {
      ts: msg.ts,
      channel_is_private: channelPrivate,
      thread_ts: msg.thread_ts,
      subtype: msg.subtype,
      reply_count: msg.reply_count,
      reply_users_count: msg.reply_users_count,
      is_bot: Boolean(msg.bot_id) && !msg.user,
      bot_id: msg.bot_id,
      parent_user_id: msg.parent_user_id,
      edited: msg.edited,
    },
    raw: msg,
  };
  return item;
}

// epoch seconds 문자열("1700000000.000100") → ISO8601. 파싱 실패 시 undefined.
export function tsToIso(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const sec = Number.parseFloat(ts);
  if (!Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000).toISOString();
}

// 딥링크 구성: https://<team>.slack.com/archives/<channel>/p<ts에서 점 제거>.
// 스레드 답글이면 ?thread_ts=<원래 ts>&cid=<channel> 부가(웹에서 스레드 펼침).
export function buildPermalink(teamDomain: string, channel: string, msg: SlackMessage): string {
  const pts = msg.ts.replace(".", "");
  let url = `https://${teamDomain}.slack.com/archives/${channel}/p${pts}`;
  if (msg.thread_ts && msg.thread_ts !== msg.ts) {
    url += `?thread_ts=${encodeURIComponent(msg.thread_ts)}&cid=${encodeURIComponent(channel)}`;
  }
  return url;
}

// 본문 첫 줄을 잘라 제목 보조값 생성(메시지는 고유 제목이 없으므로).
function deriveTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const firstLine = text.split("\n", 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

// ── 네트워크 계층 ────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Slack Web API 호출 — GET. 429 Retry-After 존중(재시도), ok:false 는 에러 throw.
// 파라미터는 querystring 으로 전달(GET 방식 권장 메서드들에 충분).
/**
 * 권한 부족일 때 «무엇이 없고 어디서 고치는지» 를 덧붙인다(#1631).
 *  ⚠ 아는 것만 말한다 — 표에 없는 메서드면 아무 말도 안 붙인다(지어낸 스코프를 켜게 하면 더 나쁘다).
 */
const SCOPE_BY_METHOD: Record<string, string> = {
  "search.messages": "search:read (유저 토큰 전용 — 봇 토큰은 이 메서드를 거부합니다)",
  "conversations.history": "channels:history · groups:history",
  "conversations.list": "channels:read · groups:read",
  "conversations.replies": "channels:history · groups:history",
  "users.list": "users:read · users:read.email",
};
function scopeHint(method: string, err: unknown): string {
  if (!/missing_scope|not_allowed_token_type|invalid_scope/i.test(String(err ?? ""))) return "";
  const need = SCOPE_BY_METHOD[method];
  const what = need ? ` 이 수집에는 ${need} 권한이 필요합니다.` : "";
  return `${what} [외부 앱 연결 ▸ Slack]에서 다시 연결하면 권한을 새로 받습니다 — 권한이 그대로면 다음 실행도 같은 자리에서 멈춥니다.`;
}

async function slackCall<T extends SlackEnvelope>(
  method: string,
  token: string,
  params: Record<string, string | number | boolean | undefined>,
  maxRetries = 5,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${API_BASE}/${method}?${qs.toString()}`;

  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });

    // rate limit: 429 → Retry-After(초) 대기 후 재시도.
    if (res.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`slack ${method} rate limited: 429 재시도 한도(${maxRetries}) 초과`);
      }
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt;
      attempt++;
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`slack ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as T;
    if (!json.ok) {
      // ok:false 도 본문에 ratelimited 로 올 수 있음 → 동일하게 대기 후 재시도.
      if (json.error === "ratelimited" && attempt < maxRetries) {
        const waitSec = 2 ** attempt;
        attempt++;
        await sleep(waitSec * 1000);
        continue;
      }
      //  ★ 권한 부족은 «고장» 이 아니라 **사람이 할 일이 남은 것**이다(#1631, 원준님 2026-08-31).
      //   종전엔 `slack search.messages error: missing_scope` 만 남아서, 화면엔 «실패» 라고만 뜨고
      //   무엇이 없는지도, 어디서 고치는지도 없었다(실측: 슬랙 공개채널 수집이 매 주기 같은 자리에서 실패).
      //   메서드마다 필요한 스코프가 다르므로 **그 메서드의 것**을 말한다 — 뭉뚱그리면 엉뚱한 걸 켜게 한다.
      throw new Error(`slack ${method} error: ${json.error ?? "unknown"}` + scopeHint(method, json.error));
    }
    return json;
  }
}

// cursor 페이지네이션 공통 헬퍼 — 각 페이지의 배열을 끝까지(next_cursor 소진) 흘린다.
async function* paginate<T extends SlackEnvelope, K extends keyof T>(
  method: string,
  token: string,
  listKey: K,
  baseParams: Record<string, string | number | boolean | undefined>,
): AsyncGenerator<NonNullable<T[K]> extends Array<infer E> ? E : never> {
  let cursor: string | undefined;
  for (;;) {
    const json = await slackCall<T>(method, token, { ...baseParams, cursor });
    const arr = (json[listKey] ?? []) as unknown as Array<
      NonNullable<T[K]> extends Array<infer E> ? E : never
    >;
    for (const el of arr) yield el;
    cursor = json.response_metadata?.next_cursor;
    if (!cursor) break; // 빈 문자열/undefined → 끝.
  }
}

interface UsersListResp extends SlackEnvelope {
  members?: SlackUser[];
}
interface AuthTestResp extends SlackEnvelope {
  team_id?: string;
  team?: string;
  url?: string; // https://<team>.slack.com/
}

// ── search.messages 응답(필요한 필드만) ────────────────────────────────────
interface SearchMatchChannel {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_private?: boolean;
  is_mpim?: boolean;
  is_im?: boolean;
}
interface SearchMatch {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  permalink?: string;
  channel?: SearchMatchChannel;
  type?: string;
}
interface SearchPaging {
  count?: number;
  total?: number;
  page?: number;
  pages?: number;
}
interface SearchMessagesBlock {
  total?: number;
  matches?: SearchMatch[];
  paging?: SearchPaging;
  pagination?: { total_count?: number; page_count?: number };
}
interface SearchResp extends SlackEnvelope {
  messages?: SearchMessagesBlock;
}

// 모든 워크스페이스 사용자 끌어와 user id → SlackUser 맵 구성(작성자 해소 캐시).
async function fetchUserMap(token: string): Promise<Map<string, SlackUser>> {
  const map = new Map<string, SlackUser>();
  for await (const u of paginate<UsersListResp, "members">("users.list", token, "members", { limit: 200 })) {
    if (u?.id) map.set(u.id, u);
  }
  return map;
}

// 백필의 작성자 해소용 — **보조**라 실패해도 수집 자체는 진행한다(표시이름만 비게 됨).
async function loadUserMap(token: string): Promise<Map<string, SlackUser>> {
  try {
    return await fetchUserMap(token);
  } catch (err) {
    console.warn(`slack users.list 실패(작성자 해소 생략): ${(err as Error).message}`);
    return new Map();
  }
}

// auth.test 로 team 식별자/딥링크 도메인 확보. instance = team_id 우선.
async function loadWorkspaceMeta(
  token: string,
): Promise<{ instance: string; teamDomain?: string }> {
  try {
    const r = await slackCall<AuthTestResp>("auth.test", token, {});
    const instance = r.team_id ?? r.team ?? "unknown";
    // url 예: https://acme.slack.com/ → teamDomain = "acme".
    let teamDomain: string | undefined;
    if (r.url) {
      const m = /^https?:\/\/([^.]+)\.slack\.com/.exec(r.url);
      if (m) teamDomain = m[1];
    }
    return { instance, teamDomain };
  } catch (err) {
    console.warn(`slack auth.test 실패(instance=unknown 으로 진행): ${(err as Error).message}`);
    return { instance: "unknown" };
  }
}

// ── search sweep 계층 ────────────────────────────────────────────────────────

// ms → "YYYY-MM-DD"(UTC). search after:/before: 는 일 단위이므로 날짜만 필요.
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// 노이즈 채널 파싱 — 공백/쉼표 구분 채널명(선행 # 제거). 쿼리에서 -in:<name> 으로 제외.
function parseNoise(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
}

// [startMs, endMs) 창의 search 쿼리 — after/before 는 exclusive·일 granular라 하루씩 넉넉히 감싼다.
function buildSearchQuery(startMs: number, endMs: number, noise: string[]): string {
  let q = `after:${dayStr(startMs - DAY_MS)} before:${dayStr(endMs + DAY_MS)}`;
  for (const ch of noise) q += ` -in:${ch}`;
  return q;
}

async function searchMessages(token: string, query: string, page: number): Promise<SearchResp> {
  return slackCall<SearchResp>("search.messages", token, {
    query,
    count: SEARCH_COUNT,
    page,
    sort: "timestamp",
    sort_dir: "desc",
  });
}

interface SweepBase {
  instance: string;
  teamDomain?: string;
  userMap?: Map<string, SlackUser>;
}

// search match 1건 → RawItem. 공개채널만 통과(DM/비공개/mpim 제외). 스레드는 permalink 의 thread_ts 로 부모 링크.
function searchMatchToRawItem(m: SearchMatch, base: SweepBase): RawItem | null {
  const channel = m.channel?.id;
  if (!channel || !m.ts) return null;
  const c = m.channel!;
  // 전체 공개채널만 — 유저 DM/비공개/mpim/그룹 제외(토큰 소유자 개인 대화 유입 방지).
  if (c.is_private || c.is_im || c.is_mpim || c.is_group) return null;

  // 스레드 답글이면 permalink 쿼리에 thread_ts 가 있다(search match 엔 thread_ts 필드 부재) → 부모 링크 복원.
  let thread_ts: string | undefined;
  if (m.permalink) {
    try {
      thread_ts = new URL(m.permalink).searchParams.get("thread_ts") ?? undefined;
    } catch {
      /* permalink 파싱 실패는 무시(부모 링크만 생략) */
    }
  }

  const msg: SlackMessage = {
    type: "message",
    ts: m.ts,
    user: m.user,
    username: m.username,
    text: m.text,
    thread_ts,
  };
  return toRawItem(msg, {
    channel,
    channelName: c.name,
    channelPrivate: c.is_private,
    instance: base.instance,
    teamDomain: base.teamDomain,
    userMap: base.userMap,
    explicitUrl: m.permalink,
  });
}

// 한 페이지의 matches 중 [startMs,endMs) 안의 것만 RawItem 으로. 인접일 스필오버·창 경계 중복 제거.
function* emitMatches(
  matches: SearchMatch[] | undefined,
  base: SweepBase,
  startMs: number,
  endMs: number,
): Generator<RawItem> {
  for (const m of matches ?? []) {
    const tsMs = Number.parseFloat(m.ts) * 1000;
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs >= endMs) continue;
    const it = searchMatchToRawItem(m, base);
    if (it) yield it;
  }
}

// [startMs,endMs) 창을 스윕 — 상한(10k) 초과면 이분해 완결성 보전(무손실 불변식). BISECT_FLOOR 이하는 잘림 경고.
async function* sweepRange(
  token: string,
  base: SweepBase,
  startMs: number,
  endMs: number,
  noise: string[],
): AsyncGenerator<RawItem> {
  const query = buildSearchQuery(startMs, endMs, noise);
  const first = await searchMessages(token, query, 1);
  const block = first.messages ?? {};
  const total = block.total ?? block.pagination?.total_count ?? block.matches?.length ?? 0;
  const capacity = SEARCH_COUNT * SEARCH_MAXP;

  // 상한 초과 + 아직 좁힐 여지(>BISECT_FLOOR) → 이분(최신 절반 먼저). 1페이지는 total 측정용이라 여기선 방출 안 함
  //  (재귀 최신 절반이 재수집 — 멱등이라 무해).
  if (total > capacity && endMs - startMs > BISECT_FLOOR_MS) {
    const mid = startMs + Math.floor((endMs - startMs) / 2);
    yield* sweepRange(token, base, mid, endMs, noise);
    yield* sweepRange(token, base, startMs, mid, noise);
    return;
  }

  const pages = Math.min(block.paging?.pages ?? block.pagination?.page_count ?? 1, SEARCH_MAXP);
  yield* emitMatches(block.matches, base, startMs, endMs);
  for (let p = 2; p <= pages; p++) {
    const r = await searchMessages(token, query, p);
    yield* emitMatches(r.messages?.matches, base, startMs, endMs);
  }
  if (total > capacity) {
    console.warn(
      `slack search 잘림: [${dayStr(startMs)}~${dayStr(endMs)}] total=${total} > ${capacity} — 최신 ${capacity}건만 수집(일 granular 한계)`,
    );
  }
}

// ── files.list 수집 계층 ─────────────────────────────────────────────────────
// 파일 업로드는 텍스트가 거의 없어 search.messages 로는 안 잡힌다(file_share) → files.list 로 파일 인덱스를 직접
//  훑는다(CTO wiki-sync files-since 와 동형). 텍스트 파일은 본문을 내려받아 자료(source)로 적재해 distill 이 지식화,
//  바이너리(PDF/이미지 등)는 본문 추출 불가라 메타+permalink 만 기록(존재·링크 보존 — 사람/후속이 원본 열람).
//  파일도 메시지처럼 type='note'(→source→distill). 공개채널 공유분만(비공개 groups/DM ims 전용 파일 제외).
interface SlackFile {
  id?: string;
  created?: number; // epoch seconds
  name?: string;
  title?: string;
  filetype?: string;
  mimetype?: string;
  size?: number;
  user?: string;
  channels?: string[]; // 공개채널 id
  groups?: string[]; // 비공개채널 id
  ims?: string[]; // DM id
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
}
interface FilesListResp extends SlackEnvelope {
  files?: SlackFile[];
  paging?: SearchPaging;
}
interface FilesInfoResp extends SlackEnvelope {
  file?: SlackFile;
}

function isTextFile(f: SlackFile): boolean {
  const mt = (f.mimetype ?? "").toLowerCase();
  if (mt.startsWith("text/")) return true;
  if (mt === "application/json" || mt === "application/xml") return true;
  return TEXT_FILETYPES.has((f.filetype ?? "").toLowerCase());
}

// 텍스트 파일 본문 다운로드 — url_private 는 Authorization 헤더 필요(JSON 아님). 실패/과대는 undefined(메타 폴백).
async function fetchFileText(token: string, f: SlackFile): Promise<string | undefined> {
  const url = f.url_private_download ?? f.url_private;
  if (!url) return undefined;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buf.slice(0, FILE_BODY_MAX));
    return text.trim() || undefined;
  } catch {
    return undefined; // 다운로드 실패는 비치명 — 메타 본문으로 폴백.
  }
}

// OOXML(docx/pptx/xlsx) 업로드 — 바이트를 받아 공용 extractOoxml 로 텍스트만 뽑는다(바이트는 버림 = 저장 0).
//  Claude Read 는 OOXML(zip)을 못 파싱하므로 sync 시점 결정적 추출이 정답(gdrive 와 동일 버킷). 깨진 추출은 폐기(printableRatio).
async function fetchOoxmlText(token: string, f: SlackFile, kind: OoxmlKind): Promise<string | undefined> {
  const url = f.url_private_download ?? f.url_private;
  if (!url) return undefined;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const text = extractOoxml(kind, buf);
    if (!text || printableRatio(text) < 0.6) return undefined; // 깨진 추출 폐기(gdrive 동일 임계)
    return text.slice(0, FILE_BODY_MAX).trim() || undefined;
  } catch {
    return undefined; // 추출 실패는 비치명 — [BINARY] 스텁으로 폴백(on-demand 재시도 가능).
  }
}

// 바이너리(PDF·이미지 등) 스텁 — sync 시 다운로드 안 함(저장 0). distill 이 메타로 볼 가치 판단 →
//  가치 있으면 source_artifact(source_id)로 원본 on-demand 페치 → Read. gdrive 와 동일 [BINARY] 포맷(+slack channel/uploader).
function buildBinaryStub(f: SlackFile, channel: string | undefined, uploader: string | undefined): string {
  const p: string[] = ["[BINARY]"];
  const fn = f.name ?? f.title;
  if (fn) p.push(`filename=${fn}`);
  if (f.mimetype) p.push(`mime=${f.mimetype}`);
  if (f.size != null) p.push(`size=${f.size}`);
  if (f.permalink) p.push(`url=${f.permalink}`);
  if (channel) p.push(`channel=${channel}`);
  if (uploader) p.push(`uploader=${uploader}`);
  return `${p.join(" ")}\n바이너리 파일(내용 미추출). 볼 가치가 있으면 source_artifact(source_id)로 원본을 받아 판단하고, 노이즈(밈·UI캡처 등)면 fetch 없이 skip 하세요.`;
}

// 파일 1건 → RawItem(type='note'→source). 텍스트·OOXML 은 본문 추출, 그 외 바이너리는 [BINARY] 스텁(on-demand).
//  범위는 모드가 정한다: 유저 모드 = 공개채널 공유분만 · 봇 모드 = 대상 채널(비공개 포함) 공유분만.
async function fileToRawItem(
  f: SlackFile, base: SweepBase, token: string,
  opts?: { includePrivate?: boolean; channelIds?: Set<string> },
): Promise<RawItem | null> {
  if (!f.id) return null;
  // 기본(유저 모드): 공개채널 공유분만 — 비공개/DM 전용 파일 제외(메시지 공개필터와 일관, 토큰 소유자 개인 파일 유입 방지).
  // 봇 모드: 비공개 채널(groups)까지 포함하되, **수집 대상 채널에 공유된 것만** — 봇이 낀 다른 채널의 파일이
  //  '대상 채널만 수집' 설정을 우회해 흘러드는 것을 막는다(DM 전용 파일 f.ims 는 어느 모드에서도 제외).
  const shared = opts?.includePrivate ? [...(f.channels ?? []), ...(f.groups ?? [])] : (f.channels ?? []);
  const publicChannels = opts?.channelIds ? shared.filter((c) => opts.channelIds!.has(c)) : shared;
  if (publicChannels.length === 0) return null;

  const created = typeof f.created === "number" ? f.created : Number.parseFloat(String(f.created ?? ""));
  const occurred_at = Number.isFinite(created) ? new Date(created * 1000).toISOString() : undefined;

  const resolvedUser = f.user && base.userMap ? base.userMap.get(f.user) : undefined;
  const displayName =
    resolvedUser?.profile?.display_name?.trim() ||
    resolvedUser?.real_name?.trim() ||
    resolvedUser?.profile?.real_name?.trim() ||
    resolvedUser?.name?.trim() ||
    undefined;
  const email = resolvedUser?.profile?.email?.trim() || undefined;

  // split(조율 확정): 결정적 텍스트(text/* · json/xml · 코드 filetype, 그리고 OOXML)는 sync 시 본문 추출(검색가능·
  //  distill 이 fetch 없이 판단). vision 바이너리(PDF·이미지 등)는 다운로드 안 하고 [BINARY] 스텁 → distill 이 on-demand.
  const ooxmlKind = ooxmlKindFromMime(f.mimetype);
  let body: string | undefined;
  if (isTextFile(f)) body = await fetchFileText(token, f);
  else if (ooxmlKind) body = await fetchOoxmlText(token, f, ooxmlKind);
  const extracted = !!body;
  if (!body) body = buildBinaryStub(f, publicChannels[0], displayName);

  return {
    type: "note",
    provenance: {
      category: "messenger",
      system: "slack",
      instance: base.instance,
      external_id: `file:${f.id}`, // 메시지(`channel:ts`)와 네임스페이스 분리.
      external_url: f.permalink,
    },
    actor: f.user
      ? { external_id: f.user, display_name: displayName, email, is_bot: Boolean(resolvedUser?.is_bot) }
      : undefined,
    container_ref: publicChannels[0],
    title: f.title?.trim() || f.name?.trim() || undefined,
    body,
    occurred_at,
    fields: {
      file_id: f.id,
      filetype: f.filetype,
      mimetype: f.mimetype,
      size: f.size,
      extracted, // true=본문 추출됨(텍스트/OOXML), false=[BINARY] 스텁(on-demand 대상)
      channels: publicChannels,
    },
    raw: f,
  };
}

// files.list 페이지네이션 — ts_from(epoch초, inclusive) 하한부터 끝까지. search 와 달리 일 granular/10k 상한 이슈
//  없어 창/이분 불필요(파일 수는 메시지보다 훨씬 적음). 페이지는 FILE_PAGE_MAX 백스톱.
async function* sweepFiles(
  token: string,
  base: SweepBase,
  sinceMs: number,
): AsyncGenerator<RawItem> {
  const tsFrom = Number.isFinite(sinceMs) ? Math.max(0, Math.floor(sinceMs / 1000)) : 0;
  let page = 1;
  for (;;) {
    const r = await slackCall<FilesListResp>("files.list", token, {
      ts_from: tsFrom,
      count: 100,
      page,
      show_files_hidden_by_limit: true,
    });
    for (const f of r.files ?? []) {
      const it = await fileToRawItem(f, base, token);
      if (it) yield it;
    }
    const pages = Math.min(r.paging?.pages ?? 1, FILE_PAGE_MAX);
    if (page >= pages) break;
    page++;
  }
}

// ── 봇 모드: 멤버십 스윕(conversations.*) ───────────────────────────────────
//  search 모드가 못 보는 것 하나를 위해 존재한다 — **비공개 채널**. 봇이 초대된 채널만 읽히므로 범위는
//  좁지만, 그 대신 초대된 곳은 공개·비공개를 가리지 않고 전량(개설일부터)을 읽을 수 있다.

interface SlackConversation {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}
interface ConversationsListResp extends SlackEnvelope {
  channels?: SlackConversation[];
}
interface HistoryResp extends SlackEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}

// 수집에서 빼는 시스템 메시지 subtype — 사람이 쓴 말이 아니라 채널 상태 변화의 부산물이다.
//  search 모드는 이런 게 애초에 검색되지 않아 문제가 없었지만, history 는 전부 돌려주므로 여기서 거른다
//  (안 거르면 '○○님이 채널에 참여했습니다' 수천 건이 자료로 쌓여 증류를 오염시킨다).
const SYSTEM_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive", "channel_convert_to_private", "channel_convert_to_public",
  "group_join", "group_leave", "group_topic", "group_purpose", "group_name",
  "group_archive", "group_unarchive",
  "bot_add", "bot_remove", "pinned_item", "unpinned_item", "reminder_add",
  "huddle_thread", "tombstone", "sh_room_created",
]);

/** 이 메시지를 자료로 남길 가치가 있는가 — 시스템 부산물·빈 메시지 제외(순수 함수). */
export function isCollectableMessage(msg: SlackMessage): boolean {
  if (msg.subtype && SYSTEM_SUBTYPES.has(msg.subtype)) return false;
  // 본문도 첨부도 없는 메시지(파일 삭제 흔적 등)는 남길 것이 없다. 파일 공유는 files.list 가 따로 담는다.
  const hasText = typeof msg.text === "string" && msg.text.trim().length > 0;
  const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;
  const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
  return hasText || hasFiles || hasAttachments;
}

/**
 * 대상 채널 선별(순수 함수) — 봇이 초대된 목록에서 allow(대상)·noise(제외)를 적용한다.
 *  · allow 가 비면 "초대된 전체"가 대상이다(봇 초대 자체가 이미 범위 선언이므로).
 *  · 이름·id 어느 쪽으로 적어도 맞는다(운영자는 보통 이름으로 적고, 이름은 바뀔 수 있어 id 도 받는다).
 *  · DM/그룹DM 은 언제나 제외 — 봇이 초대된 '채널'을 수집하는 것이지 대화상대의 사담이 아니다.
 *  · 보관(archived) 채널은 **남긴다** — 종료된 프로젝트의 기록이 오히려 이관 가치가 크다.
 */
export function selectBotChannels(
  all: SlackConversation[], allow: string[], noise: string[],
): SlackConversation[] {
  const norm = (s: string): string => s.trim().replace(/^#/, "").toLowerCase();
  const allowSet = new Set(allow.map(norm));
  const noiseSet = new Set(noise.map(norm));
  return all.filter((c) => {
    if (!c.id || c.is_im || c.is_mpim) return false;
    const keys = [c.id.toLowerCase(), ...(c.name ? [norm(c.name)] : [])];
    if (noiseSet.size && keys.some((k) => noiseSet.has(k))) return false;
    if (allowSet.size && !keys.some((k) => allowSet.has(k))) return false;
    return true;
  });
}

/**
 * 이 스레드의 답글을 (다시) 받아와야 하는가(순수 함수).
 *  전량 수집이면 답글이 있는 모든 스레드가 대상이고, 증분이면 **커서 이후에 새 답글이 달린 스레드만**이다
 *  — 이 판정이 증분 비용을 스레드 수가 아니라 '변경된 스레드 수'로 묶는다.
 */
export function threadNeedsReplies(msg: SlackMessage, sinceMs: number | undefined): boolean {
  const replies = msg.reply_count ?? 0;
  if (replies <= 0) return false;
  if (sinceMs === undefined) return true; // 전량 수집
  const latestMs = Number.parseFloat(msg.latest_reply ?? "") * 1000;
  if (!Number.isFinite(latestMs)) return true; // latest_reply 부재 = 판단 불가 → 안전하게 받아온다
  return latestMs >= sinceMs;
}

/**
 * 이 채널을 어느 시각부터 훑을 것인가(순수 함수).
 *  두 요구가 만나는 지점이라 한 곳에 둔다 —
 *   ① 증분은 커서보다 THREAD_LOOKBACK 만큼 거슬러야 오래된 스레드의 새 답글을 잡는다.
 *   ② 그 역스캔이 운영자가 정한 `backfill_since` 하한을 **뚫으면 안 된다**(#1531 — 전량 수집만 보면
 *      범위가 지켜지는 것처럼 보여 증분에서만 조용히 깨지던 결함).
 *  전량(커서 없음)이면 그냥 하한부터. 0 = 하한 없음 = 채널 개설일부터.
 */
export function channelScanFromMs(backfillSinceMs: number, sinceMs: number | undefined): number {
  if (sinceMs === undefined) return backfillSinceMs;
  return Math.max(backfillSinceMs, sinceMs - THREAD_LOOKBACK_MS);
}

/** 봇이 초대된 대화 목록(공개+비공개). 보관 채널 포함 — 종료 프로젝트 기록도 자산이다. */
async function fetchBotChannels(token: string): Promise<SlackConversation[]> {
  const out: SlackConversation[] = [];
  for await (const c of paginate<ConversationsListResp, "channels">(
    "users.conversations", token, "channels",
    { types: "public_channel,private_channel", exclude_archived: false, limit: CHANNEL_LIST_LIMIT },
  )) {
    if (c?.id) out.push(c);
  }
  return out;
}

// 채널 1개의 [oldest, ∞) 구간을 스윕 — 부모는 history 로, 답글은 변경된 스레드만 replies 로.
//  oldest 는 **부모 ts** 기준이라 THREAD_LOOKBACK 만큼 당겨 부른다(위 상수 주석 참조). 당겨서 다시 온 부모는
//  멱등 upsert 라 무해하고, 커서 전진은 관측 최대시각 기준이라 되감기지 않는다.
async function* sweepChannel(
  token: string,
  ch: SlackConversation,
  base: SweepBase,
  sinceMs: number | undefined,
  floorMs: number,
): AsyncGenerator<RawItem> {
  const scanFromMs = channelScanFromMs(floorMs, sinceMs);
  const oldest = Number.isFinite(scanFromMs) && scanFromMs > 0 ? (scanFromMs / 1000).toFixed(6) : undefined;
  // 채널 안에서는 변하지 않는 맥락 — 메시지마다 새로 만들 이유가 없다(딥링크는 toRawItem 이 ts 로 구성).
  const ctx: SlackToRawItemCtx = {
    channel: ch.id,
    channelName: ch.name,
    channelPrivate: ch.is_private,
    instance: base.instance,
    teamDomain: base.teamDomain,
    userMap: base.userMap,
  };

  // ⚠ 진행 로그는 **장식이 아니라 생존 조건**이다(#1531 실측). 실행 감시자는 일정 시간 출력이 없으면
  //  멈춘 프로세스로 보고 죽인다. 전량 백필은 채널 하나만으로도 그 시간을 넘길 수 있다 — 스레드 수천 개의
  //  replies 를 tier-3 레이트리밋 아래서 부르기 때문이다. 실제로 첫 전량 run 이 "15분간 출력 없음"으로
  //  종료됐다(12,543건까지 넣고 커서는 동결). 그래서 페이지·스레드 단위로 살아 있음을 알린다.
  let cursor: string | undefined;
  let page = 0;
  let msgs = 0;
  let threads = 0;
  const label = ch.name ?? ch.id;
  for (;;) {
    const r = await slackCall<HistoryResp>("conversations.history", token, {
      channel: ch.id, limit: HISTORY_LIMIT, oldest, cursor, inclusive: true,
    });
    for (const msg of r.messages ?? []) {
      if (!msg?.ts) continue;
      if (isCollectableMessage(msg)) { yield toRawItem(msg, ctx); msgs++; }
      // 스레드 답글 — history 는 부모만 준다. 변경된 스레드만 열어본다(threadNeedsReplies).
      if (threadNeedsReplies(msg, sinceMs)) {
        threads++;
        for await (const reply of paginate<HistoryResp, "messages">(
          "conversations.replies", token, "messages",
          { channel: ch.id, ts: msg.thread_ts ?? msg.ts, limit: HISTORY_LIMIT },
        )) {
          // replies 의 첫 항목은 부모 자신 — 위에서 이미 냈으므로 ts 로 건너뛴다(중복 인입 방지).
          if (!reply?.ts || reply.ts === msg.ts) continue;
          if (isCollectableMessage(reply)) { yield toRawItem(reply, ctx); msgs++; }
        }
        // 스레드 묶음마다 한 줄 — replies 가 느린 구간에서도 침묵이 길어지지 않게.
        if (threads % 25 === 0) console.log(`slack #${label}: 스레드 ${threads}개·메시지 ${msgs}건 처리 중`);
      }
    }
    cursor = r.response_metadata?.next_cursor;
    console.log(`slack #${label}: ${++page}페이지 완료 (메시지 ${msgs}건, 스레드 ${threads}개)${cursor ? "" : " — 채널 끝"}`);
    if (!cursor || page >= HISTORY_PAGE_MAX) {
      if (cursor) {
        console.warn(`slack history 페이지 백스톱: #${label} 가 ${HISTORY_PAGE_MAX} 페이지 초과 — 남은 구간은 다음 run 이 이어받습니다`);
      }
      break;
    }
  }
}

// 봇 모드 파일 수집 — files.list 는 봇이 볼 수 있는 파일만 돌려주므로 채널 필터는 대상 채널 집합으로 건다.
//  유저 모드와 달리 **비공개 채널 공유분(groups)** 을 포함한다(그게 이 모드의 존재 이유다).
async function* sweepBotFiles(
  token: string,
  base: SweepBase,
  sinceMs: number,
  channelIds: Set<string>,
): AsyncGenerator<RawItem> {
  const tsFrom = Number.isFinite(sinceMs) ? Math.max(0, Math.floor(sinceMs / 1000)) : 0;
  let page = 1;
  for (;;) {
    const r = await slackCall<FilesListResp>("files.list", token, {
      ts_from: tsFrom, count: 100, page, show_files_hidden_by_limit: true,
    });
    for (const f of r.files ?? []) {
      const it = await fileToRawItem(f, base, token, { includePrivate: true, channelIds });
      if (it) yield it;
    }
    const pages = Math.min(r.paging?.pages ?? 1, FILE_PAGE_MAX);
    if (page >= pages) break;
    page++;
  }
}

// 봇 모드 백필 — 채널을 나열하고 채널별로 스윕한다. 채널 하나의 실패가 나머지를 막지 않게 채널 단위로 격리한다
//  (권한 누락·보관 채널 등 개별 사유는 흔하고, 하나 때문에 run 전체를 접으면 그날 수집이 통째로 멈춘다).
//  ⚠ 단, 실패를 삼키기만 하면 '조용한 유실'이 된다 — 실패한 채널이 하나라도 있으면 마지막에 throw 해
//   run 을 실패로 만들고, 커서를 동결시켜 다음 run 이 같은 구간을 다시 읽게 한다(유실 없음 불변식).
async function* botBackfill(
  token: string,
  cfg: Record<string, string | undefined>,
  sinceMs: number | undefined,
): AsyncGenerator<RawItem> {
  const { instance, teamDomain } = await loadWorkspaceMeta(token);
  const userMap = await loadUserMap(token);
  const base: SweepBase = { instance, teamDomain, userMap };

  const backfillSinceMs =
    cfg.backfill_since && Number.isFinite(Date.parse(cfg.backfill_since))
      ? Date.parse(cfg.backfill_since)
      : 0;
  // 수집 하한 — **전량이든 증분이든 같다.** 0 이면 채널 개설일부터.
  //  ⚠ 증분에서 이 하한을 0 으로 열어두면 아래 THREAD_LOOKBACK 역스캔이 설정값을 뚫고 30일을 더 거슬러 올라간다.
  //   관리탭이 "이 날짜 이후의 자료만 수집합니다"라고 약속한 값이 증분에서만 조용히 깨지는 것이라, 운영자는
  //   전량 수집 결과만 보고 범위가 지켜진다고 믿게 된다(#1531 어니스트 실측: 7/28 설정에 7/5 자료가 들어왔다).
  const floorMs = backfillSinceMs;

  const all = await fetchBotChannels(token);
  const targets = selectBotChannels(all, parseNoise(cfg.channels), parseNoise(cfg.noise_exclude));
  console.log(
    `slack 봇 모드: 초대된 ${all.length}개 중 ${targets.length}개 채널 수집` +
      `(비공개 ${targets.filter((c) => c.is_private).length}개) — ${sinceMs !== undefined ? `증분 since=${new Date(sinceMs).toISOString()}` : `전량 from=${floorMs ? new Date(floorMs).toISOString().slice(0, 10) : "채널 개설일"}`}`,
  );
  if (targets.length === 0 && parseNoise(cfg.channels).length > 0) {
    throw new Error(
      `'대상 채널' 에 적은 채널 중 봇이 초대된 것이 하나도 없습니다 — 채널명 오타이거나 /invite 가 안 된 상태입니다(봇이 보는 채널: ${all.length}개)`,
    );
  }

  const failures: string[] = [];
  let done = 0;
  for (const ch of targets) {
    const label = ch.name ?? ch.id;
    console.log(`slack 봇 모드: [${++done}/${targets.length}] #${label} 시작${ch.is_private ? " (비공개)" : ""}`);
    try {
      yield* sweepChannel(token, ch, base, sinceMs, floorMs);
    } catch (err) {
      failures.push(`${label}(${(err as Error).message})`);
      console.warn(`slack 채널 수집 실패 — 계속 진행: #${label}: ${(err as Error).message}`);
    }
  }

  // 파일 — 메시지 스윕 후 1회. files:read 스코프가 없는 설치가 흔해 실패는 경고로 흘린다(메시지는 이미 수집됨).
  const fileSinceMs = sinceMs !== undefined ? Math.max(0, sinceMs - FILE_INCR_LOOKBACK_MS) : floorMs;
  try {
    yield* sweepBotFiles(token, base, fileSinceMs, new Set(targets.map((c) => c.id)));
  } catch (err) {
    console.warn(
      `slack files.list 수집 skip(files:read 스코프 누락 등 — 메시지는 정상 수집됨): ${(err as Error).message}`,
    );
  }

  if (failures.length) {
    throw new Error(
      `슬랙 채널 ${failures.length}개 수집 실패(커서 동결 — 다음 run 이 재수집): ${failures.slice(0, 5).join(", ")}`,
    );
  }
}

// ── Connector 구현 ───────────────────────────────────────────────────────────
// on-demand 아티팩트 페치(SPI Connector.fetchArtifact) — distill 시점에 공용 source_artifact 도구가 호출.
//  externalId = 소스 external_id 원문(slack 파일은 `file:<id>` → prefix strip). files.info 로 신선한
//  url_private_download 얻어 Bearer 스트림 반환. 삭제/권한상실 = null(도구가 unavailable→skip). 크기 캡은 도구가 강제.
export async function slackFetchArtifact(
  externalId: string,
): Promise<{ stream: Readable; mime: string; filename?: string; size?: number } | null> {
  const fileId = externalId.replace(/^file:/, "");
  if (!fileId) return null;
  // ⚠ 이 경로는 **수집기 바인딩 없이** 불린다(게이트웨이의 distill 이 소스만 보고 호출) — 그래서 어느 인스턴스가
  //  넣은 파일인지 모른 채 기본 설정으로 해소된다. 비공개 채널 파일은 유저 토큰으로 못 여니 봇 토큰을 폴백으로
  //  둔다(둘 다 있으면 유저 우선 — 공개채널 파일이 다수라 적중률이 높다). 인스턴스별 정확한 라우팅은 소스에
  //  수집기 id 가 실린 뒤에 붙이는 게 맞다(그 전엔 여기서 추측하지 않는다).
  const cfg = await resolveConnectorConfig("slack");
  const token = cfg.user_token ?? cfg.bot_token;
  if (!token) return null;
  let info: FilesInfoResp;
  try {
    info = await slackCall<FilesInfoResp>("files.info", token, { file: fileId });
  } catch {
    return null; // file_not_found/file_deleted 등 → unavailable
  }
  const f = info.file;
  const url = f?.url_private_download ?? f?.url_private;
  if (!url) return null;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok || !res.body) {
    await res.text().catch(() => "");
    return null;
  }
  const mime =
    f?.mimetype || res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const clen = Number(res.headers.get("content-length") ?? f?.size ?? "");
  return {
    stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    mime,
    filename: f?.name,
    size: Number.isFinite(clen) && clen > 0 ? clen : undefined,
  };
}

export const slackConnector: Connector = {
  name: "slack",
  // #837 — 사람 매핑 후보. loadUserMap 이 이미 users.list 를 부르므로(작성자 해소용) 그대로 재사용한다.
  //  봇은 제외 — 사람 매핑 대상이 아니다. 토큰 실패 시 loadUserMap 이 빈 맵을 주므로 목록도 빈다(경고는 로그).
  async listUsers(): Promise<ConnectorUser[]> {
    const cfg = await resolveConnectorConfig("slack");
    // users.list 는 두 토큰 다 된다(users:read) — 봇 전용 수집기에서도 멤버 매핑 화면이 비지 않게 폴백한다.
    const token = cfg.user_token ?? cfg.bot_token;
    if (!token) throw new Error("Slack 토큰이 없습니다 — [외부 자료 수집]에서 User Token 또는 Bot Token 을 등록하세요");
    // ⚠ 여기선 실패를 **삼키지 않는다**. 멤버 매핑 화면의 주역이라, 빈 맵을 돌려주면 화면이 "사용자 0명"으로
    //  보여 원인을 못 찾는다(어니스트에서 실제로 그랬다 — 슬랙 매핑 0명의 정체가 이 조용한 실패였다).
    //  users.list 는 `users:read`(+이메일까지 받으려면 `users:read.email`) 스코프가 필요하다.
    let map: Map<string, SlackUser>;
    try { map = await fetchUserMap(token); }
    catch (err) {
      const m = (err as Error).message ?? String(err);
      throw new Error(/missing_scope|not_allowed|invalid_auth/i.test(m)
        ? `Slack 사용자 목록 권한이 없습니다(${m}) — 토큰에 users:read 와 users:read.email 스코프를 추가하고 재발급하세요. 이메일이 없으면 구성원 자동 매칭이 불가능합니다.`
        : `Slack 사용자 목록을 불러오지 못했습니다: ${m}`);
    }
    return [...map.values()]
      .filter((u) => !u.is_bot)
      .map((u) => ({
        id: u.id,
        name: u.profile?.display_name || u.real_name || u.name || null,
        email: u.profile?.email ?? null,
        inactive: !!u.deleted,
      }));
  },
  fetchArtifact: slackFetchArtifact,

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("slack");
    const token = cfg.user_token;
    // 증분 하한(두 모드 공용) — run-sync 가 커서에서 계산해 넘긴 시각.
    const sinceMs =
      opts?.since && Number.isFinite(Date.parse(opts.since)) ? Date.parse(opts.since) : undefined;

    // ── 모드 선택(#1531) — 유저 토큰이 있으면 검색 스윕, 없고 봇 토큰만 있으면 멤버십 스윕. ──
    //  유저 토큰 우선인 이유는 파일 상단 참조(기존 배포의 env 봇 토큰으로 모드가 조용히 바뀌지 않게).
    if (!token) {
      const botToken = cfg.bot_token;
      if (!botToken) {
        throw new Error(
          "Slack 토큰이 없습니다 — 관리탭 ▸ 외부 자료 수집 ▸ Slack 에 User Token(xoxp-… 전 공개채널 검색 수집) 또는 Bot Token(xoxb-… 봇이 초대된 채널·비공개 포함)을 저장하세요.",
        );
      }
      // 접두 검사 — 토큰 회전을 켠 앱은 `xoxe.xoxb-…` 를 준다(#1881: 라이블리 앱은 v1 에서 회전 OFF 지만 형식은 미리 받아 둔다).
      if (!isSlackBotToken(botToken)) {
        throw new Error(
          "Bot Token 이 봇 토큰(xoxb-) 형식이 아닙니다 — OAuth & Permissions 의 'Bot User OAuth Token' 을 저장하세요(유저 토큰 xoxp- 는 위 User Token 칸입니다).",
        );
      }
      yield* botBackfill(botToken, cfg, sinceMs);
      return;
    }
    if (!isSlackUserToken(token)) {
      throw new Error(
        "Slack 토큰이 유저 토큰(xoxp-)이 아닙니다 — search.messages 는 봇 토큰(xoxb-)을 거부합니다(not_allowed_token_type). 봇 토큰으로 비공개 채널을 수집하려면 User Token 칸을 비우고 Bot Token 칸에 저장하세요.",
      );
    }

    // 워크스페이스 메타 + 작성자 맵 선적재(스윕 전 1회).
    const { instance, teamDomain } = await loadWorkspaceMeta(token);
    const userMap = await loadUserMap(token);
    const base: SweepBase = { instance, teamDomain, userMap };
    const noise = parseNoise(cfg.noise_exclude);
    //  #2243 — 검색 모드에도 **포함 지정**을 준다. 종전엔 allowlist 가 봇 모드 전용이라 개인 연결(유저 토큰)로는
    //   «내가 고른 채널만»이 성립하지 않았다(제외만 가능). search.messages 는 여러 채널을 OR 로 묶는 문법이 없어
    //   쿼리로는 못 좁히므로 **매치 단계에서 고른 채널만 통과**시킨다(요청 수는 그대로, 들어오는 자료가 정확해진다).
    const only = new Set(parseNoise(cfg.channels).map((c) => c.replace(/^#/, "").toLowerCase()));

    // 증분: since 하한(위에서 계산). 최초: backfill_since(설정) 하한, 없으면 -Infinity(활동 끊길 때까지 과거 탐색).
    const incremental = sinceMs !== undefined;
    const backfillSinceMs =
      cfg.backfill_since && Number.isFinite(Date.parse(cfg.backfill_since))
        ? Date.parse(cfg.backfill_since)
        : undefined;
    const hardFloorMs = incremental ? (sinceMs as number) : (backfillSinceMs ?? Number.NEGATIVE_INFINITY);
    const dryStopEnabled = !incremental && backfillSinceMs === undefined;

    // now 에서 30일 창을 과거로 밀며 스윕. 창은 반열림 [windowStart, cursorEnd) 로 인접 무중복 타일링.
    let cursorEnd = Date.now() + DAY_MS; // 오늘 포함(before: 내일).
    let consecutiveEmpty = 0;
    let windows = 0;
    while (cursorEnd > hardFloorMs) {
      if (++windows > MAX_WINDOWS) {
        console.warn(`slack backfill: MAX_WINDOWS(${MAX_WINDOWS}) 초과 — 스윕 중단`);
        break;
      }
      const windowStart = Number.isFinite(hardFloorMs)
        ? Math.max(hardFloorMs, cursorEnd - WINDOW_MS)
        : cursorEnd - WINDOW_MS;

      let n = 0;
      for await (const it of sweepRange(token, base, windowStart, cursorEnd, noise)) {
        n++;   // ⚠ 창의 «비었나» 판정(dry stop)은 **고르기 전** 건수로 센다 — 고른 채널이 조용하다고 과거 탐색을 멈추면
               //  그 창 너머의 자료를 영영 못 본다(전체는 활발한데 내 채널만 뜸한 것이 정상이다).
        if (only.size && !only.has(String(it.container_name ?? "").replace(/^#/, "").toLowerCase())) continue;
        yield it;
      }

      if (n === 0) {
        consecutiveEmpty++;
        if (dryStopEnabled && consecutiveEmpty >= DRY_STOP) break; // 연속 빈 창 → 이력 시작 도달로 종료.
      } else {
        consecutiveEmpty = 0;
      }
      cursorEnd = windowStart;
    }

    // ── 파일 수집(files.list) — 메시지 스윕 후 1회. best-effort: files:read 스코프 부재 등 실패는 경고 후 진행
    //  (메시지 수집은 이미 완료). ts_from: 증분은 커서보다 넉넉히 당겨(스트래글러 방지), 최초는 backfill_since/0.
    const fileSinceMs = incremental
      ? Math.max(0, (sinceMs as number) - FILE_INCR_LOOKBACK_MS)
      : (backfillSinceMs ?? 0);
    try {
      yield* sweepFiles(token, base, fileSinceMs);
    } catch (err) {
      console.warn(
        `slack files.list 수집 skip(files:read 스코프 누락 등 — 메시지는 정상 수집됨): ${(err as Error).message}`,
      );
    }
  },
};

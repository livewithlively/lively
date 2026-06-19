// Discord 커넥터 (DESIGN §8) — Discord REST API v10 → canonical RawItem 변환.
// 컨테이너(길드→텍스트 채널/스레드) 나열 → 채널별 메시지 백필(before 커서로 끝까지 페이지네이션)
// → 메시지 1건을 type:"message" RawItem 으로 정규화.
//
// 인증: Authorization: Bot <DISCORD_BOT_TOKEN>.
// rate limit: 응답 헤더(X-RateLimit-Remaining/Reset-After) 존중 + 429 시 Retry-After/retry_after 대기.
// external_id = `${channelId}:${messageId}` (system+instance 내 안정·고유).
// instance = guild id (워크스페이스 식별자).
import type { Connector, RawItem, BackfillOpts } from "./types.js";

export type { Connector, RawItem, BackfillOpts };

// ── Discord API 타입(부분) — 변환에 쓰는 필드만 정의 ──
export interface DiscordUser {
  id: string;
  username?: string;
  /** 새 핸들 시스템의 표시명(있으면 우선) */
  global_name?: string | null;
  discriminator?: string;
  bot?: boolean;
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  /** ISO8601 — 생성 시각(snowflake 대신 이걸 사용) */
  timestamp: string;
  edited_timestamp?: string | null;
  /** 메시지 타입(0 DEFAULT, 19 REPLY 등) */
  type?: number;
  /** 리플라이/크로스포스트 등 참조 */
  message_reference?: DiscordMessageReference | null;
  referenced_message?: DiscordMessage | null;
  embeds?: unknown[];
  attachments?: unknown[];
  pinned?: boolean;
  tts?: boolean;
  mention_everyone?: boolean;
}

export interface DiscordChannel {
  id: string;
  /** 0 GUILD_TEXT, 5 GUILD_ANNOUNCEMENT, 10/11/12 스레드, 15 GUILD_FORUM 등 */
  type: number;
  guild_id?: string;
  name?: string | null;
  /** 일반 채널: 상위 카테고리 id / 스레드: 부모 텍스트 채널 id */
  parent_id?: string | null;
  topic?: string | null;
}

export interface DiscordGuild {
  id: string;
  name?: string;
}

// 메시지를 담는(=백필 대상) 채널 타입.
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]); // ANNOUNCEMENT/PUBLIC/PRIVATE THREAD

const API_BASE = "https://discord.com/api/v10";

// ── 순수 변환 함수: 원본 메시지 1건 → RawItem (네트워크 없음, 단위 테스트 대상) ──
export interface ToRawItemCtx {
  /** 워크스페이스 식별자(= guild id). 딥링크/instance 에 사용 */
  guildId: string;
  /** 메시지가 속한 채널 id (스레드면 스레드 id) */
  channelId: string;
  /**
   * 이 채널이 스레드일 때 부모 텍스트 채널 id.
   * 메시지에 명시적 리플라이(message_reference)가 없을 때 parent_external_id 후보로 사용.
   */
  threadParentChannelId?: string | null;
}

export function toRawItem(msg: DiscordMessage, ctx: ToRawItemCtx): RawItem {
  const { guildId, channelId, threadParentChannelId } = ctx;
  // external_id 는 system+instance 내에서 안정·고유해야 함. 채널+메시지 조합 사용.
  const externalId = `${channelId}:${msg.id}`;
  const externalUrl = `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`;

  // 작성자 해소: global_name(새 표시명) → username → id 순.
  const displayName = msg.author?.global_name || msg.author?.username || msg.author?.id;

  // 부모 해소:
  //  1) 리플라이(message_reference.message_id)가 있으면 같은 채널의 그 메시지가 부모.
  //     (참조 메시지의 실제 채널은 message_reference.channel_id, 보통 동일 채널)
  //  2) 없고 이 채널이 스레드면, 스레드 부모 텍스트 채널의 "시작 메시지"는
  //     스레드 id 와 동일한 snowflake 를 가지므로 `${parentChannel}:${threadId}` 가 부모.
  let parentExternalId: string | undefined;
  const ref = msg.message_reference;
  if (ref?.message_id) {
    const refChannel = ref.channel_id ?? channelId;
    parentExternalId = `${refChannel}:${ref.message_id}`;
  } else if (threadParentChannelId) {
    // 스레드 메시지: 스레드를 만든 부모 채널의 시작 메시지(id == 스레드 id)를 부모로 연결.
    parentExternalId = `${threadParentChannelId}:${channelId}`;
  }

  // title: 본문 첫 줄을 잘라 요약(메시지엔 별도 제목이 없음).
  const title = deriveTitle(msg.content);

  return {
    type: "message",
    provenance: {
      category: "messenger",
      system: "discord",
      instance: guildId,
      external_id: externalId,
      external_url: externalUrl,
    },
    actor: {
      external_id: msg.author?.id,
      display_name: displayName,
      is_bot: msg.author?.bot ?? false,
    },
    container_ref: channelId,
    parent_external_id: parentExternalId,
    title,
    body: msg.content ?? "",
    occurred_at: toIso(msg.timestamp),
    updated_at: msg.edited_timestamp ? toIso(msg.edited_timestamp) : undefined,
    // 소스 고유 필드.
    fields: {
      message_type: msg.type,
      author_username: msg.author?.username,
      author_global_name: msg.author?.global_name ?? null,
      author_is_bot: msg.author?.bot ?? false,
      edited: !!msg.edited_timestamp,
      pinned: msg.pinned ?? false,
      attachment_count: Array.isArray(msg.attachments) ? msg.attachments.length : 0,
      embed_count: Array.isArray(msg.embeds) ? msg.embeds.length : 0,
      is_thread_message: !!threadParentChannelId,
      reply_to: ref?.message_id ?? null,
    },
    raw: msg,
  };
}

// 본문에서 제목 한 줄 추출(공백 정리 + 길이 제한). 빈 메시지면 undefined.
function deriveTitle(content?: string): string | undefined {
  if (!content) return undefined;
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

// Discord timestamp 는 이미 ISO8601 이지만, Date 로 한번 정규화(밀리초/오프셋 통일).
function toIso(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

// ── HTTP 계층 ──

function getToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN 미설정 — Discord 봇 토큰을 환경변수로 주입하세요 (Authorization: Bot <token>).",
    );
  }
  return token;
}

// 채널 allowlist — env DISCORD_CHANNELS=쉼표구분 채널 id. 설정 시 그 채널(+그 채널의 스레드)만 백필.
// 미설정이면 종전대로 봇이 보는 모든 텍스트/공지 채널을 백필한다.
function getChannelAllowlist(): Set<string> | null {
  const raw = process.env.DISCORD_CHANNELS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// rate limit 을 존중하는 GET. 429 면 Retry-After/retry_after 만큼 대기 후 재시도.
// 남은 토큰(X-RateLimit-Remaining)이 0 이면 Reset-After 만큼 선제 대기해 429 를 줄인다.
async function discordGet<T>(path: string, token: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const maxRetries = 5;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "context-ontology (https://example.invalid, 0.1.0)",
        accept: "application/json",
      },
    });

    if (res.status === 429) {
      // 본문 retry_after(초, 소수) 우선, 없으면 Retry-After 헤더(초).
      let retryAfterSec = 1;
      const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
      if (body && typeof body.retry_after === "number") {
        retryAfterSec = body.retry_after;
      } else {
        const h = res.headers.get("retry-after");
        if (h) retryAfterSec = Number(h);
      }
      if (attempt >= maxRetries) {
        throw new Error(`Discord 429 재시도 초과(${maxRetries}회): ${path}`);
      }
      // +250ms 여유. 글로벌/공유 한도도 동일 처리.
      await sleep(Math.ceil(retryAfterSec * 1000) + 250);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord ${res.status} ${path}: ${text.slice(0, 200)}`);
    }

    // 정상 응답이라도 버킷이 소진됐으면 다음 호출 전 선제 대기.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAfter = res.headers.get("x-ratelimit-reset-after");
    if (remaining === "0" && resetAfter) {
      const waitMs = Math.ceil(Number(resetAfter) * 1000) + 50;
      if (waitMs > 0) await sleep(waitMs);
    }

    return (await res.json()) as T;
  }
}

// 현재 봇이 속한 길드 나열(페이지네이션). (instance = guild id)
// /users/@me/guilds 는 기본 100·최대 200 — after 커서로 끝까지 돌아야 100개 초과 길드도 누락 없음.
async function listGuilds(token: string): Promise<DiscordGuild[]> {
  const out: DiscordGuild[] = [];
  let after: string | undefined;
  for (;;) {
    const q = `limit=200${after ? `&after=${after}` : ""}`;
    const page = await discordGet<DiscordGuild[]>(`/users/@me/guilds?${q}`, token);
    if (!page.length) break;
    out.push(...page);
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  return out;
}

// 길드의 채널 나열(텍스트/공지만 백필 대상으로 필터는 호출부에서).
async function listGuildChannels(guildId: string, token: string): Promise<DiscordChannel[]> {
  return discordGet<DiscordChannel[]>(`/guilds/${guildId}/channels`, token);
}

// 길드의 활성 스레드 나열. (보관된 스레드는 별도 엔드포인트지만 활성분 우선)
async function listActiveThreads(
  guildId: string,
  token: string,
): Promise<DiscordChannel[]> {
  const res = await discordGet<{ threads?: DiscordChannel[] }>(
    `/guilds/${guildId}/threads/active`,
    token,
  );
  return res.threads ?? [];
}

// since(ISO8601) → snowflake 하한. Discord snowflake 는 (ms_since_epoch - DISCORD_EPOCH) << 22.
// `after` 커서로 쓰면 since 이후 메시지만 받을 수 있다.
const DISCORD_EPOCH = 1420070400000n;
function isoToSnowflakeLowerBound(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const snowflake = (BigInt(ms) - DISCORD_EPOCH) << 22n;
  return (snowflake < 0n ? 0n : snowflake).toString();
}

// 한 채널의 메시지를 끝까지 페이지네이션하며 yield.
// since 가 있으면 since 이후만(오래된→최신 방향, after 커서) 가져온다.
// since 가 없으면 before 커서로 최신→과거 방향으로 전부 가져온다.
async function* fetchChannelMessages(
  channelId: string,
  token: string,
  since?: string,
): AsyncGenerator<DiscordMessage> {
  const PAGE = 100; // API 최대치

  if (since) {
    // 증분: after 커서. 응답은 newest→oldest 이므로 가장 오래된 id 를 다음 after 로 쓴다.
    let after: string = isoToSnowflakeLowerBound(since) ?? "0";
    for (;;) {
      const page: DiscordMessage[] = await discordGet<DiscordMessage[]>(
        `/channels/${channelId}/messages?limit=${PAGE}&after=${after}`,
        token,
      );
      if (!page.length) break;
      // newest→oldest. 오래된 순으로 정렬해 안정적으로 흘린다.
      const ordered: DiscordMessage[] = [...page].sort((a, b) => snowCmp(a.id, b.id)); // oldest→newest
      for (const m of ordered) yield m;
      // 다음 after = 이번 페이지에서 가장 큰(최신) id
      after = ordered[ordered.length - 1].id;
      if (page.length < PAGE) break;
    }
  } else {
    // 전체: before 커서. 응답은 newest→oldest, 가장 오래된 id 를 다음 before 로.
    let before: string | undefined;
    for (;;) {
      const q = `limit=${PAGE}${before ? `&before=${before}` : ""}`;
      const page = await discordGet<DiscordMessage[]>(
        `/channels/${channelId}/messages?${q}`,
        token,
      );
      if (!page.length) break;
      for (const m of page) yield m; // newest→oldest 그대로
      before = page[page.length - 1].id; // 가장 오래된 id
      if (page.length < PAGE) break;
    }
  }
}

// snowflake 문자열 비교(BigInt). a<b → 음수.
function snowCmp(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// 한 채널/스레드를 끝까지 백필하며 RawItem 으로 변환해 yield. 단일 메시지 에러는 skip.
async function* drainChannel(
  token: string,
  guildId: string,
  channelId: string,
  threadParentChannelId: string | null,
  since?: string,
): AsyncGenerator<RawItem> {
  try {
    for await (const msg of fetchChannelMessages(channelId, token, since)) {
      try {
        yield toRawItem(msg, { guildId, channelId, threadParentChannelId });
      } catch (err) {
        // 단일 메시지 변환 실패는 건너뛰고 계속(전체 백필을 죽이지 않음).
        console.error(`[discord] 메시지 변환 실패 ${channelId}:${msg?.id}, skip:`, err);
      }
    }
  } catch (err) {
    // 채널 도중(페이지네이션 중) 실패도 다음 채널로 진행할 수 있게 채널 단위에서 흡수.
    console.error(`[discord] 채널 ${channelId} 백필 중단(부분 수집됨):`, err);
  }
}

// ── Connector 구현 ──
export const discordConnector: Connector = {
  name: "discord",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const token = getToken();
    const since = opts?.since;
    const allow = getChannelAllowlist();

    const guilds = await listGuilds(token);
    for (const guild of guilds) {
      // 단일 길드 실패가 전체를 죽이지 않도록 보호.
      let channels: DiscordChannel[];
      let activeThreads: DiscordChannel[] = [];
      try {
        channels = await listGuildChannels(guild.id, token);
      } catch (err) {
        // 권한 없는 길드 등은 건너뜀.
        console.error(`[discord] 길드 ${guild.id} 채널 나열 실패, skip:`, err);
        continue;
      }
      try {
        activeThreads = await listActiveThreads(guild.id, token);
      } catch (err) {
        // 스레드 나열 실패는 채널 백필을 막지 않음.
        console.error(`[discord] 길드 ${guild.id} 스레드 나열 실패, 채널만 진행:`, err);
      }

      // 백필 대상 = 텍스트/공지 채널 + 활성 스레드. allowlist 설정 시 그 채널(+그 채널의 스레드)만.
      const textChannels = channels.filter(
        (c) => TEXT_CHANNEL_TYPES.has(c.type) && (!allow || allow.has(c.id)),
      );
      const threadChannels = activeThreads.filter(
        (c) =>
          THREAD_CHANNEL_TYPES.has(c.type) &&
          (!allow || allow.has(c.id) || (c.parent_id != null && allow.has(c.parent_id))),
      );

      for (const ch of textChannels) {
        yield* drainChannel(token, guild.id, ch.id, null, since);
      }
      for (const th of threadChannels) {
        // 스레드의 부모 텍스트 채널 id 는 parent_id.
        yield* drainChannel(token, guild.id, th.id, th.parent_id ?? null, since);
      }
    }
  },
};

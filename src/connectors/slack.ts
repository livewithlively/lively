// Slack 커넥터 (DESIGN §8) — Slack Web API 의 메시지/스레드를 canonical RawItem 으로 정규화한다.
// 컨테이너 나열(conversations.list) → 채널별 메시지(conversations.history) → 스레드 답글(conversations.replies).
// 작성자는 users.list 로 한 번에 끌어와 캐싱(history/replies 의 user id → display_name 해소).
// 인증: Authorization: Bearer xoxb-... (process.env.SLACK_BOT_TOKEN). GLOBAL fetch 사용, 새 의존성 없음.
//
// 참고(2026-06 확인):
//   - 엔드포인트: https://slack.com/api/<method>, 응답은 항상 { ok, error?, response_metadata? }.
//   - 페이지네이션: response_metadata.next_cursor (빈 문자열이면 끝). limit≤999(history)/1000(replies).
//   - rate limit: 429 + Retry-After(초). 단일 워크스페이스 내부앱은 2025-05 변경 면제이나 그래도 존중한다.
//   - message ts: epoch seconds 문자열("1700000000.000100") → ISO8601 변환.
//   - external_id = `${channel}:${ts}` (system+instance 내 안정·고유).
//   - 스레드 부모 = thread_ts 가 자기 ts 와 다를 때 → parent_external_id = `${channel}:${thread_ts}`.
//   - 딥링크 = https://<team>.slack.com/archives/<channel>/p<ts에서 점 제거> (스레드면 ?thread_ts=&cid= 부가).

import type { Connector, RawItem, BackfillOpts } from "./types.js";

const API_BASE = "https://slack.com/api";

// ── Slack 응답 타입(필요한 필드만) ──────────────────────────────────────────
interface SlackResponseMeta {
  next_cursor?: string;
}
interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: SlackResponseMeta;
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_im?: boolean;
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
  instance: string; // 워크스페이스/팀 식별자 (provenance.instance)
  teamDomain?: string; // 딥링크용 <team>.slack.com 의 <team>. 없으면 딥링크 생략.
  /** user id → 표시이름/이메일 해소 맵 (네트워크 없이 주입). */
  userMap?: Map<string, SlackUser>;
}

// ── 순수 변환: 원본 메시지 1건 → RawItem (네트워크 없음, 단위테스트 대상) ──────
export function toRawItem(msg: SlackMessage, ctx: SlackToRawItemCtx): RawItem {
  const { channel, instance, teamDomain, userMap } = ctx;

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

  // 딥링크: teamDomain 이 있을 때만 결정적으로 구성(추가 API 호출 불필요).
  const external_url = teamDomain ? buildPermalink(teamDomain, channel, msg) : undefined;

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
    parent_external_id,
    // 메시지엔 별도 제목이 없다. 본문 첫 줄을 짧게 잘라 제목 보조로 둔다.
    title: deriveTitle(msg.text),
    body: msg.text ?? undefined,
    occurred_at,
    updated_at,
    fields: {
      ts: msg.ts,
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

function getToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN 환경변수가 없습니다 — Slack 봇 토큰(xoxb-...)을 설정하세요.");
  }
  return token;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Slack Web API 호출 — GET. 429 Retry-After 존중(재시도), ok:false 는 에러 throw.
// 파라미터는 querystring 으로 전달(GET 방식 권장 메서드들에 충분).
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
      throw new Error(`slack ${method} error: ${json.error ?? "unknown"}`);
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

interface ChannelsListResp extends SlackEnvelope {
  channels?: SlackChannel[];
}
interface HistoryResp extends SlackEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}
interface RepliesResp extends SlackEnvelope {
  messages?: SlackMessage[];
  has_more?: boolean;
}
interface UsersListResp extends SlackEnvelope {
  members?: SlackUser[];
}
interface AuthTestResp extends SlackEnvelope {
  team_id?: string;
  team?: string;
  url?: string; // https://<team>.slack.com/
}

// 모든 워크스페이스 사용자 끌어와 user id → SlackUser 맵 구성(작성자 해소 캐시).
async function loadUserMap(token: string): Promise<Map<string, SlackUser>> {
  const map = new Map<string, SlackUser>();
  try {
    for await (const u of paginate<UsersListResp, "members">("users.list", token, "members", {
      limit: 200,
    })) {
      if (u?.id) map.set(u.id, u);
    }
  } catch (err) {
    // 작성자 해소는 보조 — 실패해도 백필 자체는 진행(표시이름만 비게 됨).
    console.warn(`slack users.list 실패(작성자 해소 생략): ${(err as Error).message}`);
  }
  return map;
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

// ── Connector 구현 ───────────────────────────────────────────────────────────
export const slackConnector: Connector = {
  name: "slack",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const token = getToken();

    // since(ISO8601) → epoch seconds 문자열(oldest 파라미터). 부동소수 손실 없이 정수+소수 유지.
    const oldest =
      opts?.since && Number.isFinite(Date.parse(opts.since))
        ? (Date.parse(opts.since) / 1000).toFixed(6)
        : undefined;

    // 워크스페이스 메타 + 작성자 맵 선적재(채널 루프 전 1회).
    const { instance, teamDomain } = await loadWorkspaceMeta(token);
    const userMap = await loadUserMap(token);

    // 1) 컨테이너 나열: public + private 채널, 아카이브 제외, 봇이 멤버인 것만 history 가능.
    for await (const ch of paginate<ChannelsListResp, "channels">(
      "conversations.list",
      token,
      "channels",
      {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
      },
    )) {
      if (!ch?.id) continue;
      // 멤버가 아닌 채널은 history 에서 not_in_channel 에러가 나므로 건너뛴다(공개라도 미가입이면 제외).
      if (ch.is_member === false) continue;

      const ctxBase: SlackToRawItemCtx = {
        channel: ch.id,
        instance,
        teamDomain,
        userMap,
      };

      try {
        // 2) 채널 메시지: conversations.history 끝까지 페이지네이션.
        for await (const msg of paginate<HistoryResp, "messages">(
          "conversations.history",
          token,
          "messages",
          { channel: ch.id, limit: 200, oldest, inclusive: false },
        )) {
          if (!msg?.ts) continue;
          try {
            yield toRawItem(msg, ctxBase);
          } catch (err) {
            // 단일 아이템 변환 에러는 skip — 전체 백필을 죽이지 않는다.
            console.warn(
              `slack 메시지 변환 skip (channel=${ch.id} ts=${msg.ts}): ${(err as Error).message}`,
            );
            continue;
          }

          // 3) 스레드: 부모(자기 ts == thread_ts)이고 답글이 있으면 replies 펼침.
          //    부모 메시지 자체는 위에서 이미 yield 됐으므로 답글에서 부모 ts 는 건너뛴다.
          const isThreadParent = Boolean(msg.thread_ts) && msg.thread_ts === msg.ts;
          if (isThreadParent && (msg.reply_count ?? 0) > 0) {
            try {
              for await (const reply of paginate<RepliesResp, "messages">(
                "conversations.replies",
                token,
                "messages",
                { channel: ch.id, ts: msg.ts, limit: 200 },
              )) {
                if (!reply?.ts || reply.ts === msg.ts) continue; // 부모 중복 방지.
                try {
                  yield toRawItem(reply, ctxBase);
                } catch (err) {
                  console.warn(
                    `slack 답글 변환 skip (channel=${ch.id} ts=${reply.ts}): ${(err as Error).message}`,
                  );
                  continue;
                }
              }
            } catch (err) {
              // 스레드 한 건 실패는 skip — 다음 메시지 계속.
              console.warn(
                `slack 스레드 조회 skip (channel=${ch.id} ts=${msg.ts}): ${(err as Error).message}`,
              );
              continue;
            }
          }
        }
      } catch (err) {
        // 채널 한 곳 실패(예: not_in_channel)는 skip — 다음 채널 계속.
        console.warn(`slack 채널 history skip (channel=${ch.id}): ${(err as Error).message}`);
        continue;
      }
    }
  },
};

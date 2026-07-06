// Slack 커넥터 (DESIGN §8, #541 유저토큰 재작성) — 워크스페이스 **전체 공개채널**의 메시지를 canonical RawItem 으로.
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
//
// 수집 범위: 공개채널만 — search match 의 channel 플래그로 유저 DM/비공개/mpim 을 제외(토큰 소유자 개인 대화 유입 방지).
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

import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";

const API_BASE = "https://slack.com/api";

// ── 스윕 파라미터 ────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS; // 최초 마이그레이션 스윕 기본 창(월 단위) — 대부분 상한 미만이라 이분 없이 통과.
const SEARCH_COUNT = 100; // search.messages count 상한.
const SEARCH_MAXP = 100; // search.messages page 상한 → 쿼리당 최신 SEARCH_COUNT*SEARCH_MAXP(=10k)건까지.
const BISECT_FLOOR_MS = 2 * DAY_MS; // 이 이하로는 이분해도 after/before(일 granular)가 더 못 좁힘 → 잘림 경고만.
const DRY_STOP = 12; // 최초 스윕 시 연속 빈 창 이만큼이면 이력 시작으로 보고 종료(하한 미지정일 때만).
const MAX_WINDOWS = 400; // 무한루프 백스톱(하한 -Infinity 안전장치).
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
  /** 권위 있는 permalink(search match) — 있으면 teamDomain 재구성 대신 이걸 external_url 로 쓴다. */
  explicitUrl?: string;
}

// ── 순수 변환: 원본 메시지 1건 → RawItem (네트워크 없음, 단위테스트 대상) ──────
export function toRawItem(msg: SlackMessage, ctx: SlackToRawItemCtx): RawItem {
  const { channel, instance, teamDomain, userMap, explicitUrl } = ctx;

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

// 파일 1건 → RawItem(type='note'→source). 공개채널 공유분만. 텍스트는 본문, 그 외는 메타+링크.
async function fileToRawItem(f: SlackFile, base: SweepBase, token: string): Promise<RawItem | null> {
  if (!f.id) return null;
  // 공개채널 공유분만 — 비공개/DM 전용 파일 제외(메시지 공개필터와 일관, 토큰 소유자 개인 파일 유입 방지).
  const publicChannels = f.channels ?? [];
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

  const isText = isTextFile(f);
  let body = isText ? await fetchFileText(token, f) : undefined;
  if (!body) {
    // 바이너리(또는 다운로드 실패) — 존재·링크만 기록. distill 은 메타로만 판단(원본은 permalink 로 사람 열람).
    body = `[Slack 파일] ${f.name ?? f.title ?? f.id}${f.mimetype ? ` (${f.mimetype})` : ""}${f.permalink ? `\n${f.permalink}` : ""}`;
  }

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
      is_text: isText,
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

// ── Connector 구현 ───────────────────────────────────────────────────────────
export const slackConnector: Connector = {
  name: "slack",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("slack");
    const token = cfg.user_token;
    if (!token) {
      throw new Error(
        "Slack User Token(xoxp-…)이 설정되지 않았습니다 — 관리탭 ▸ 커넥터 ▸ Slack 에 저장하세요. (search.messages 는 봇 토큰 xoxb- 를 거부하므로 유저 토큰 필요)",
      );
    }
    if (!token.startsWith("xoxp-")) {
      throw new Error(
        "Slack 토큰이 유저 토큰(xoxp-)이 아닙니다 — search.messages 는 봇 토큰(xoxb-)을 거부합니다(not_allowed_token_type). User Token Scopes(search:read 등)로 재발급하세요.",
      );
    }

    // 워크스페이스 메타 + 작성자 맵 선적재(스윕 전 1회).
    const { instance, teamDomain } = await loadWorkspaceMeta(token);
    const userMap = await loadUserMap(token);
    const base: SweepBase = { instance, teamDomain, userMap };
    const noise = parseNoise(cfg.noise_exclude);

    // 증분: since 하한. 최초: backfill_since(설정) 하한, 없으면 -Infinity(활동 끊길 때까지 과거 탐색).
    const sinceMs =
      opts?.since && Number.isFinite(Date.parse(opts.since)) ? Date.parse(opts.since) : undefined;
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
        n++;
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

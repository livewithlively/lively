// Notion 커넥터 — 페이지를 canonical RawItem(type:'doc')으로 정규화한다.
// 소스: Notion API v1 (https://api.notion.com/v1)
//   - POST /search           : 공유된 페이지/DB 나열 (object 필터 + 커서 페이지네이션)
//   - GET  /blocks/{id}/children : 페이지 본문 블록 (재귀적으로 자식까지 끌어와 평문 합침)
//   - GET  /users/{id}       : 작성자(created_by.id) → 사람 이름 해소
// 헤더: Authorization: Bearer <NOTION_TOKEN>, Notion-Version: 2022-06-28(최신 안정), Content-Type: application/json
// rate limit: 평균 ~3 req/s, 초과 시 429 + Retry-After(초). → 본 커넥터는 429 시 Retry-After 만큼 대기 후 재시도.
// 단일 페이지 처리 실패는 skip/continue — 전체 백필을 죽이지 않는다.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // 최신 안정 버전(page/database 객체 모델)
const SEARCH_PAGE_SIZE = 100; // search 최대 페이지 크기
const BLOCK_PAGE_SIZE = 100; // blocks children 최대 페이지 크기
const MAX_BLOCK_DEPTH = 5; // 본문 블록 재귀 최대 깊이(무한·과도한 트래버스 방지)
const REQ_INTERVAL_MS = 350; // 자발적 스로틀(~3 req/s) — rate limit 선제 회피
const MAX_RETRY = 5; // 429/일시 오류 재시도 횟수

// ── Notion API 타입(부분) ───────────────────────────────────────────────────
// 우리가 실제로 읽는 필드만 좁게 선언. 나머지는 raw 로 보존.
interface NotionRichText {
  plain_text?: string;
}

interface NotionPropertyValue {
  type?: string;
  title?: NotionRichText[]; // type === 'title' 인 속성에만 존재
  [k: string]: unknown;
}

interface NotionPage {
  object: "page";
  id: string;
  created_time?: string; // ISO8601
  last_edited_time?: string; // ISO8601
  created_by?: { id?: string };
  last_edited_by?: { id?: string };
  url?: string;
  parent?: {
    type?: string;
    page_id?: string;
    database_id?: string;
    block_id?: string;
    workspace?: boolean;
  };
  properties?: Record<string, NotionPropertyValue>;
  archived?: boolean;
  in_trash?: boolean;
  [k: string]: unknown;
}

interface NotionSearchResponse {
  results: Array<{ object?: string } & Record<string, unknown>>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionUser {
  id: string;
  name?: string;
  type?: string;
  person?: { email?: string };
  bot?: unknown;
}

// ── 작은 유틸 ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 토큰 조회 — 없으면 명확히 실패시킨다(부분 백필 방지).
async function requireToken(): Promise<string> {
  const tok = (await resolveConnectorConfig("notion")).token;
  if (!tok) throw new Error("NOTION_TOKEN 환경변수가 없습니다 — Notion integration 토큰(secret_…)을 설정하세요");
  return tok;
}

// instance 식별자: 워크스페이스 식별값. 토큰별로 워크스페이스가 갈리므로
// 명시 설정(NOTION_INSTANCE)이 없으면 'default' 로 둔다(external_id 유일성은 page uuid 가 보장).
async function getInstance(): Promise<string> {
  return (await resolveConnectorConfig("notion")).instance || "default";
}

// ── HTTP 호출(인증/버전 헤더 + rate limit 존중 + 자발적 스로틀) ───────────────
let lastReqAt = 0;

async function notionFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    // 자발적 스로틀: 직전 요청과 최소 간격 유지(평균 3 req/s 선제 준수)
    const wait = lastReqAt + REQ_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();

    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: init?.body != null ? JSON.stringify(init.body) : undefined,
    });

    // rate limit: 429 → Retry-After(초) 만큼 대기 후 재시도
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : REQ_INTERVAL_MS * (attempt + 2);
      await res.text().catch(() => "");
      if (attempt < MAX_RETRY) {
        await sleep(delay);
        continue;
      }
      throw new Error(`Notion 429 rate_limited (재시도 소진): ${path}`);
    }

    // 일시적 서버 오류(5xx)는 백오프 후 재시도
    if (res.status >= 500 && attempt < MAX_RETRY) {
      await res.text().catch(() => "");
      await sleep(REQ_INTERVAL_MS * (attempt + 2));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Notion ${res.status} ${path}: ${body.slice(0, 300)}`);
    }

    return res.json();
  }
  // 위 루프에서 반드시 return/throw 되지만 타입 만족용 가드.
  throw new Error(`Notion 요청 실패(예상치 못한 종료): ${path}`);
}

// ── 본문 블록 → 평문 ─────────────────────────────────────────────────────────
// 블록의 rich_text 를 평문으로 추출. 블록 타입은 다양하지만 본문 텍스트는
// 대부분 block[type].rich_text 배열에 plain_text 로 들어있다.
function blockToText(block: NotionBlock): string {
  const inner = block[block.type] as { rich_text?: NotionRichText[] } | undefined;
  const rich = inner?.rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((rt) => rt.plain_text ?? "").join("");
}

// 페이지 본문을 끝까지 페이지네이션하며 재귀적으로 평문 합침.
// has_children 블록은 자식까지 끌어와(깊이 제한) 줄바꿈으로 이어붙인다.
async function fetchPageBodyText(
  token: string,
  blockId: string,
  depth: number,
): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) return "";
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const qs = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) });
    if (cursor) qs.set("start_cursor", cursor);
    const data = (await notionFetch(
      token,
      `/blocks/${blockId}/children?${qs.toString()}`,
    )) as NotionBlocksResponse;

    for (const block of data.results ?? []) {
      const text = blockToText(block);
      if (text) lines.push(text);
      // 자식 블록 재귀(토글/리스트/콜아웃 등 중첩 본문)
      if (block.has_children) {
        const child = await fetchPageBodyText(token, block.id, depth + 1);
        if (child) lines.push(child);
      }
    }

    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor);

  return lines.join("\n");
}

// ── 작성자 해소(이름 캐시) ───────────────────────────────────────────────────
// created_by.id 만으로는 사람 이름을 모른다. GET /users/{id} 로 1회 조회 후 캐시.
const userCache = new Map<string, NotionUser | null>();

async function resolveUser(token: string, userId: string): Promise<NotionUser | null> {
  if (userCache.has(userId)) return userCache.get(userId) ?? null;
  let user: NotionUser | null = null;
  try {
    user = (await notionFetch(token, `/users/${userId}`)) as NotionUser;
  } catch {
    // 권한 부족/봇 사용자 등으로 실패할 수 있음 — id 만이라도 보존하도록 null 캐시.
    user = null;
  }
  userCache.set(userId, user);
  return user;
}

// ── 순수 변환(네트워크 X) — 단위 테스트 대상 ─────────────────────────────────
// 원본 page 1건(+선택적으로 미리 받아둔 bodyText/작성자 표시명) → RawItem.
// 네트워크 의존을 인자로 주입받아 순수하게 유지한다.
export function toRawItem(
  page: NotionPage,
  opts: {
    instance: string;
    bodyText?: string;
    actorDisplayName?: string;
    actorEmail?: string;
    actorIsBot?: boolean;
  } = { instance: "default" },
): RawItem {
  const instance = opts.instance || "default";
  const title = extractTitle(page);
  const actorId = page.created_by?.id;

  const parentExternalId = extractParentPageId(page);

  return {
    type: "doc", // Notion page → doc
    provenance: {
      category: "collab_tool",
      system: "notion",
      instance,
      external_id: page.id, // system+instance 내 안정·고유(page uuid)
      external_url: page.url, // 딥링크
    },
    actor: actorId
      ? {
          external_id: actorId,
          display_name: opts.actorDisplayName,
          email: opts.actorEmail,
          is_bot: opts.actorIsBot,
        }
      : undefined,
    container_ref: parentExternalId, // 부모 페이지/DB id(컨테이너)
    parent_external_id: parentExternalId, // 부모 페이지가 있으면 트리 부모로
    title: title || undefined,
    body: opts.bodyText || undefined,
    occurred_at: page.created_time, // 이미 ISO8601
    updated_at: page.last_edited_time, // 이미 ISO8601
    fields: {
      archived: page.archived ?? false,
      in_trash: page.in_trash ?? false,
      parent_type: page.parent?.type,
      last_edited_by: page.last_edited_by?.id,
    },
    raw: page, // 원본 보존
  };
}

// properties 에서 type==='title' 인 속성의 plain_text 를 이어붙여 제목 추출.
export function extractTitle(page: NotionPage): string {
  const props = page.properties;
  if (!props) return "";
  for (const value of Object.values(props)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      const t = value.title.map((rt) => rt.plain_text ?? "").join("").trim();
      if (t) return t;
    }
  }
  return "";
}

// 부모가 page/database 면 그 id 를 컨테이너/부모 external_id 로 사용.
// 워크스페이스 루트면 부모 없음(undefined).
function extractParentPageId(page: NotionPage): string | undefined {
  const p = page.parent;
  if (!p) return undefined;
  if (p.type === "page_id") return p.page_id;
  if (p.type === "database_id") return p.database_id;
  if (p.type === "block_id") return p.block_id;
  return undefined; // workspace 등
}

// ── 백필: search 로 페이지를 끝까지 나열 → 각 페이지 본문/작성자 채워 RawItem yield ──
async function* backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
  const token = await requireToken();
  const instance = await getInstance();
  const since = opts?.since ? Date.parse(opts.since) : undefined; // 증분 백필 기준(ms)

  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" }, // 페이지만
      sort: { timestamp: "last_edited_time", direction: "descending" },
      page_size: SEARCH_PAGE_SIZE,
    };
    if (cursor) body.start_cursor = cursor;

    const search = (await notionFetch(token, "/search", {
      method: "POST",
      body,
    })) as NotionSearchResponse;

    for (const result of search.results ?? []) {
      if (result.object !== "page") continue; // 안전망(필터가 무시될 경우 대비)
      const page = result as NotionPage;
      try {
        // 증분: since 보다 오래 수정된 페이지는 skip(내림차순이라 이후도 더 오래됐지만,
        // 보수적으로 continue 만 — sort 신뢰성에만 의존하지 않음).
        if (since != null) {
          const edited = page.last_edited_time ? Date.parse(page.last_edited_time) : NaN;
          if (Number.isFinite(edited) && edited < since) continue;
        }

        // 본문 블록 평문화(끝까지 페이지네이션 + 재귀)
        let bodyText = "";
        try {
          bodyText = await fetchPageBodyText(token, page.id, 0);
        } catch {
          // 본문 fetch 실패는 본문만 비우고 메타는 살린다.
          bodyText = "";
        }

        // 작성자 표시명/이메일/봇 신호 해소(캐시) — API 가 이미 주는 신호를 버리지 않는다.
        let actorDisplayName: string | undefined;
        let actorEmail: string | undefined;
        let actorIsBot: boolean | undefined;
        const actorId = page.created_by?.id;
        if (actorId) {
          const user = await resolveUser(token, actorId);
          actorDisplayName = user?.name;
          actorEmail = user?.person?.email;
          actorIsBot = user?.type === "bot";
        }

        yield toRawItem(page, { instance, bodyText, actorDisplayName, actorEmail, actorIsBot });
      } catch {
        // 단일 페이지 처리 실패는 skip/continue — 전체 백필을 죽이지 않는다.
        continue;
      }
    }

    cursor = search.has_more && search.next_cursor ? search.next_cursor : undefined;
  } while (cursor); // 끝까지 페이지네이션
}

export const notionConnector: Connector = {
  name: "notion",
  backfill,
};

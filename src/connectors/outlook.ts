// Outlook 커넥터(#4211) — Microsoft Graph v1.0 의 메일을 canonical RawItem(type:'message')으로 정규화한다. 자료(source, kind=email)로 들어간다.
//  소스: GET /me/messages?$filter=receivedDateTime ge <since>&$orderby=receivedDateTime asc&$top=50&$select=…  (@odata.nextLink 로 쪽 넘김)
//  인증: 켠 사람의 [Outlook 연결](금고 microsoft_oauth) — token_source=member:<id>. 토큰은 **쪽마다** 금고에서 다시 해소한다
//   (microsoft-token-source 머리말: 액세스 토큰이 60~90분이라 첫 수집이 그보다 길면 캐시한 토큰이 도중에 죽는다).
//
//  ── 설계 판단(태스크 본문의 «Graph messages/delta» 를 쓰지 않은 이유) ─────────────────────────────
//   delta 는 **폴더 하나** 단위다(`/me/mailFolders/{id}/messages/delta`) — 메일함 전체를 보려면 폴더마다 deltaLink 를 따로
//   들고 다녀야 하는데, 이 코드베이스의 커서는 «관측한 최대 시각» 하나다(sync-cursor.planCursorWrite). 그래서 Gmail 커넥터와
//   **같은 모양**으로 간다: 받은 시각 하한(receivedDateTime ge)으로 전체 메일함을 한 번에, 오름차순으로 훑는다.
//   메일은 받은 뒤 내용이 안 바뀌므로 «받은 시각»이 곧 변경 시각이다(Gmail internalDate 와 같은 판단). 잃는 것은 옮김·읽음
//   표시 같은 상태 변화뿐이고, 자료의 본문엔 영향이 없다.
//
//  특이점(주의):
//   · `$filter` 와 `$orderby` 를 함께 쓰려면 orderby 속성이 filter 에 **먼저** 나와야 한다(아니면 InefficientFilter) — 둘 다 receivedDateTime.
//   · id 는 **ImmutableId** 로 받는다(`Prefer: IdType="ImmutableId"`) — 기본 id 는 메일을 다른 폴더로 옮기면 바뀌어, 같은 메일이
//     자료에 두 번 생긴다.
//   · 본문은 텍스트로 달라고 한다(`Prefer: outlook.body-content-type="text"`) — 그래도 HTML 이 오면 태그를 벗긴다.
//   · /me/messages 는 **지운 편지함·정크까지** 준다(Graph 문서: "including the Deleted Items and Clutter folders"). 그 폴더들과
//     임시 보관함은 자료로 받지 않는다 — 스팸·지운 메일이 팀 자료함에 쌓이면 안 된다.
//   · 429 는 Retry-After(초)를 따르고, 5xx 는 지수 백오프.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { sinceFloor } from "./sync-cursor.js";
import { resolveMicrosoftTokenSource, microsoftVaultDeps } from "../org/credentials/microsoft-token-source.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 50;              // 쪽당 메일 수 — 본문이 실려 무겁다(문서: 큰 $top 은 504 를 부른다)
const MAX_PAGES = 20_000;          // 폭주 방지 상한(정상 종료는 nextLink 소진)
const MAX_RETRY = 5;
const BACKOFF_BASE_MS = 500;
const INSTANCE = "default";        // 켠 사람의 메일함 하나
const FIRST_EVER = "1900-01-01T00:00:00Z"; // 커서도 «언제부터»도 없을 때 — $orderby 를 쓰려면 같은 속성의 $filter 가 있어야 한다
/** 받지 않는 폴더(잘 알려진 이름) — 지운 편지함·정크·임시 보관함·보낼 편지함. */
export const OUTLOOK_SKIP_FOLDERS = ["deleteditems", "junkemail", "drafts", "outbox"] as const;
const SELECT = [
  "id", "subject", "from", "toRecipients", "ccRecipients", "receivedDateTime", "sentDateTime",
  "conversationId", "parentFolderId", "webLink", "body", "bodyPreview", "isDraft", "internetMessageId",
  "hasAttachments", "categories",
].join(",");

// ── Graph 타입(부분) — 실제로 읽는 칸만 ──
interface GraphAddress { emailAddress?: { name?: string; address?: string } }
export interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphAddress | null;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  conversationId?: string;
  parentFolderId?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string } | null;
  bodyPreview?: string;
  isDraft?: boolean;
  internetMessageId?: string;
  hasAttachments?: boolean;
  categories?: string[];
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 순수 변환 계층(네트워크 없음 — 단위 테스트 대상) ──────────────────────────

/** HTML 본문 → 근사 텍스트(텍스트 형식이 안 왔을 때만). gmail 커넥터의 stripHtml 과 같은 규칙. */
export function outlookStripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 본문 텍스트 — text 면 그대로, html 이면 태그를 벗긴다. 비면 미리보기. */
export function outlookBodyText(m: Pick<GraphMessage, "body" | "bodyPreview">): string {
  const c = typeof m.body?.content === "string" ? m.body.content : "";
  const text = String(m.body?.contentType ?? "").toLowerCase() === "html" ? outlookStripHtml(c) : c.trim();
  return text || String(m.bodyPreview ?? "").trim();
}

const addr = (a: GraphAddress | null | undefined): string => String(a?.emailAddress?.address ?? "").trim().toLowerCase();

/** 이 메일을 자료로 받을 것인가 — 임시 보관함 메일·건너뛸 폴더에 있는 메일은 받지 않는다(순수). */
export function outlookKeep(m: Pick<GraphMessage, "isDraft" | "parentFolderId">, skipFolderIds: ReadonlySet<string>): boolean {
  if (m.isDraft) return false;
  if (m.parentFolderId && skipFolderIds.has(m.parentFolderId)) return false;
  return true;
}

export interface OutlookToRawItemCtx { instance?: string; folderName?: string }

/** 메일 1건 → RawItem(순수). */
export function toRawItem(m: GraphMessage, ctx: OutlookToRawItemCtx = {}): RawItem {
  const email = addr(m.from);
  const name = String(m.from?.emailAddress?.name ?? "").trim();
  const when = m.receivedDateTime || m.sentDateTime || undefined;
  //  원본 보존은 본문을 뺀 것 — 본문은 body 로 이미 들어가고, 원본에 한 벌 더 두면 자료 크기만 두 배가 된다.
  const { body: _body, ...rest } = m;
  void _body;
  return {
    type: "message",
    provenance: {
      category: "messenger",
      system: "outlook",
      instance: ctx.instance || INSTANCE,
      external_id: m.id,
      ...(m.webLink ? { external_url: m.webLink } : {}),
    },
    actor: email ? { external_id: email, display_name: name || undefined, email } : undefined,
    title: (m.subject ?? "").trim() || undefined,
    body: outlookBodyText(m) || undefined,
    occurred_at: when,
    updated_at: when, // 메일은 받은 뒤 안 바뀐다 — 받은 시각이 곧 커서 시각(머리말 «설계 판단»)
    // 채널(#2416) = 폴더 이름(받은 편지함·보낸 편지함·사람이 만든 폴더). 모르면 비운다 — 지어내지 않는다.
    container_name: ctx.folderName?.trim() || undefined,
    fields: {
      //  thread_ts — 증류기가 «같은 대화»를 묶는 열쇠(distiller.threadIdSql). 슬랙 전용 이름이지만 뜻은 «스레드 id» 다.
      //   Gmail 은 이걸 안 채워 메일 한 통이 한 스레드였는데, Outlook 은 conversationId 가 있으니 대화 단위로 판정받게 한다.
      ...(m.conversationId ? { thread_ts: m.conversationId, conversationId: m.conversationId } : {}),
      to: (m.toRecipients ?? []).map(addr).filter(Boolean),
      cc: (m.ccRecipients ?? []).map(addr).filter(Boolean),
      internetMessageId: m.internetMessageId,
      hasAttachments: !!m.hasAttachments,
      ...(m.categories?.length ? { categories: m.categories } : {}),
    },
    raw: rest,
  };
}

/** 첫 쪽 URL(순수) — 받은 시각 하한 + 오름차순. 값은 RFC 3986 인코딩(공백 %20 — Graph 는 `+` 를 공백으로 안 읽을 수 있다). */
export function firstPageUrl(sinceIso: string | undefined): string {
  const since = sinceIso && Number.isFinite(Date.parse(sinceIso)) ? new Date(Date.parse(sinceIso)).toISOString() : FIRST_EVER;
  const q = [
    `$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`,
    `$orderby=${encodeURIComponent("receivedDateTime asc")}`,
    `$top=${PAGE_SIZE}`,
    `$select=${SELECT}`,
  ].join("&");
  return `${GRAPH}/me/messages?${q}`;
}

/** 다음 쪽 — Graph 가 준 nextLink 를 그대로 따르되, 다른 호스트면 따르지 않는다(토큰을 싣고 나가는 요청이다). */
export function safeNextLink(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  try { const u = new URL(next); return u.origin === "https://graph.microsoft.com" ? u.toString() : null; } catch { return null; }
}

// ── HTTP 계층 ────────────────────────────────────────────────────────────────

/** Graph 호출 — 토큰은 부를 때마다 해소한다. 401 이면 한 번 더 해소해 본다(만료 직전 경계). */
async function graphGet(url: string, token: () => Promise<string>): Promise<unknown> {
  let reauth = false;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${await token()}`,
        accept: "application/json",
        Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
      },
    });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after"));
      await res.text().catch(() => "");
      if (attempt < MAX_RETRY) { await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : BACKOFF_BASE_MS * 2 ** attempt); continue; }
      throw new Error(`outlook ${res.status} 요청 한도(재시도 소진)`);
    }
    if (res.status >= 500 && attempt < MAX_RETRY) { await res.text().catch(() => ""); await sleep(BACKOFF_BASE_MS * 2 ** attempt); continue; }
    if (res.status === 401 && !reauth) { reauth = true; await res.text().catch(() => ""); continue; }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      //  본문에 토큰이 되비칠 일은 없지만(Graph 오류는 {error:{code,message}}) 길이는 자른다.
      throw new Error(`outlook ${res.status} ${new URL(url).pathname}: ${t.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`outlook 요청 실패(예상치 못한 종료): ${new URL(url).pathname}`);
}

async function* backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
  const cfg = await resolveConnectorConfig("outlook");
  if (!cfg.token_source) throw new Error("Outlook 수집기에 토큰 출처가 없습니다 — [외부 앱 연결 ▸ Outlook ▸ 자료 가져오기]로 켜세요(token_source=member:<id>).");
  const token = async (): Promise<string> => {
    const r = await resolveMicrosoftTokenSource(cfg.token_source, microsoftVaultDeps);
    if (!r?.token) throw new Error(r?.warning ?? "Outlook 연결을 찾지 못했습니다");
    return r.token;
  };

  // 건너뛸 폴더 id — 잘 알려진 이름으로 한 번씩 묻는다(없는 폴더는 404 — 그 폴더가 없으면 건너뛸 것도 없다).
  const skip = new Set<string>();
  for (const name of OUTLOOK_SKIP_FOLDERS) {
    try {
      const f = (await graphGet(`${GRAPH}/me/mailFolders/${name}?$select=id`, token)) as { id?: string };
      if (f?.id) skip.add(f.id);
    } catch (e) {
      if (!/ 404 /.test((e as Error).message)) throw e; // 404 만 «없음». 그 밖은 전체를 멈춘다(지운 메일이 새어 들어가면 안 된다)
    }
  }
  // 폴더 이름(채널) — 처음 보는 parentFolderId 만 묻고 캐시한다. 실패는 채널 없음으로 수렴(수집을 멈출 이유가 아니다).
  const folderNames = new Map<string, string>();
  const folderName = async (id: string | undefined): Promise<string> => {
    if (!id) return "";
    if (folderNames.has(id)) return folderNames.get(id)!;
    let name = "";
    try { name = String(((await graphGet(`${GRAPH}/me/mailFolders/${encodeURIComponent(id)}?$select=displayName`, token)) as { displayName?: string })?.displayName ?? ""); }
    catch (e) { console.warn(`outlook: 폴더 이름 조회 실패 — 채널 없이 진행합니다: ${(e as Error).message}`); }
    folderNames.set(id, name);
    return name;
  };

  let url: string | null = firstPageUrl(sinceFloor(opts?.since, cfg.backfill_since));
  for (let pages = 0; url && pages < MAX_PAGES; pages++) {
    const page = (await graphGet(url, token)) as { value?: GraphMessage[]; "@odata.nextLink"?: string };
    for (const m of page.value ?? []) {
      if (!m?.id || !outlookKeep(m, skip)) continue;
      try {
        yield toRawItem(m, { instance: INSTANCE, folderName: await folderName(m.parentFolderId) });
      } catch (err) {
        console.warn(`outlook 메일 처리 skip (id=${String(m.id).slice(0, 24)}…): ${(err as Error).message}`);
      }
    }
    url = safeNextLink(page["@odata.nextLink"]);
  }
}

export const outlookConnector: Connector = { name: "outlook", backfill };

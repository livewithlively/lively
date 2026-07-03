// Gmail 커넥터 (프로젝트 #541) — Gmail API v1 의 메일을 canonical RawItem(type:'message')으로 정규화한다.
// 소스: Gmail API (https://gmail.googleapis.com/gmail/v1)
//   - GET /users/me/messages?q=&maxResults=&pageToken=  : 메시지 id 나열(쿼리 필터 + nextPageToken 페이지네이션)
//   - GET /users/me/messages/{id}?format=full           : 메시지 1건(헤더+본문 payload) — N+1 개별 조회
// 인증: Authorization: Bearer <access_token>, token = await googleAccessToken("gmail")
//   (google-auth.ts 의 OAuth2 refresh-token 교환·만료캐시. gmail.readonly scope). GLOBAL fetch 만 — googleapis SDK 미도입(원칙).
// rate limit: per-user ~250 quota units/s. messages.list·messages.get 각 5 units → 자발적 스로틀(~20req/s=~100u/s)로 선제 회피,
//   429 는 Retry-After(초) 존중 + 지수 백오프(≤5회). 5xx 백오프 재시도.
// external_id = message id (users/me 단일 메일박스 내 안정·고유). instance='default'(gmail 은 mailbox 1개).
// 단일 메시지 fetch/파싱 실패는 console.warn + skip/continue — 전체 백필을 죽이지 않는다.
//
// gmail 특이점(주의):
//   · 본문 body.data 는 base64url 인코딩(‘+/’→‘-_’, ‘=’ 패딩 제거) — 표준 base64 로 되돌려 UTF-8 디코드.
//   · 증분 after:<n> 은 UNIX 초 + day 단위(coarse). Date.parse 가 ISO tz offset 을 존중해 UTC epoch ms 를 주므로 /1000 = 진짜 UTC epoch 초.
//   · occurred_at 은 internalDate(서버 권위 ms epoch)에서 — Date 헤더(스푸핑·누락 가능)보다 신뢰.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { googleAccessToken } from "./google-auth.js";

// ── 상수 ───────────────────────────────────────────────────────────────────
const API_BASE = "https://gmail.googleapis.com/gmail/v1";
const LIST_PAGE_SIZE = 100; // messages.list maxResults (max 500) — 응답 크기 절제
const MAX_LIST_PAGES = 10_000; // 페이지 상한(nextPageToken 폭주 방지) — 정상 종료는 토큰 소진
const MAX_PART_DEPTH = 10; // payload 파트 재귀 최대 깊이(중첩 multipart 방지)
const REQ_INTERVAL_MS = 50; // 자발적 스로틀 ~20 req/s = ~100 quota units/s (< 250/user/s 상한, 여유 확보)
const MAX_RETRY = 5; // 429/5xx 재시도 횟수
const BACKOFF_BASE_MS = 500; // 지수 백오프 기준(Retry-After 부재 시 500·1000·2000·4000·8000ms)
const INSTANCE = "default"; // gmail 은 users/me 단일 메일박스 — instance 고정

// ── Gmail API 타입(부분) — 실제로 읽는 필드만 좁게 선언. 나머지는 raw 로 보존. ──
interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  data?: string; // base64url 인코딩 본문(작은/중간 크기는 인라인)
  attachmentId?: string; // 대용량 본문은 data 대신 이 id(별도 fetch 필요) — 본 커넥터는 미조회(→snippet 폴백)
}

interface GmailPayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPayload[]; // multipart 이면 자식 파트
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // ms epoch 문자열(서버 수신시각)
  payload?: GmailPayload;
  [k: string]: unknown; // raw 보존용 — 그 외 필드 통과
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

// ── 작은 유틸 ───────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 순수 변환 계층 (네트워크 없음, 단위 테스트 대상) ─────────────────────────

// Gmail body.data(base64url) → 평문. ‘-’/‘_’ 를 ‘+’/‘/’ 로 되돌리고 ‘=’ 패딩 복원 후 UTF-8 디코드.
function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? 0 : 4 - (b64.length % 4);
  return Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf-8");
}

// text/html 폴백용 최소 태그 스트립(text/plain 이 없을 때만). 완전한 HTML 파싱은 목표 아님 — 본문 텍스트 근사.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// payload 트리를 DFS 로 걸어 첫 mimeType 파트의 base64url data 를 찾는다(깊이 제한).
function findPartData(part: GmailPayload | undefined, mimeType: string, depth: number): string | undefined {
  if (!part || depth > MAX_PART_DEPTH) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPartData(child, mimeType, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// 본문 추출: text/plain 우선 → text/html(strip) 폴백. 디코드 가능한 본문이 없으면 "".
// (호출자가 snippet 으로 폴백한다.) 순수 — payload 는 이미 fetch 된 상태로 주입된다.
export function extractBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const plain = findPartData(payload, "text/plain", 0);
  if (plain) return decodeBase64Url(plain).trim();
  const html = findPartData(payload, "text/html", 0);
  if (html) return stripHtml(decodeBase64Url(html));
  return "";
}

// payload.headers[] 에서 이름(대소문자 무시) 매치의 첫 값.
function getHeader(headers: GmailHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? undefined;
  }
  return undefined;
}

// From 헤더("Name <email>" | "\"Name\" <email>" | "email") → {email(소문자), displayName}.
// 이메일이 액터 external_id — clickup 의 email-as-external_id 컨벤션과 동형(resolveActor 이메일조인 정합).
export function parseFrom(from: string | undefined): { email?: string; displayName?: string } {
  if (!from) return {};
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (m) {
    let name = m[1].trim();
    // 감싼 큰따옴표 제거(RFC 5322 display-name quoting).
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).trim();
    const email = m[2].trim().toLowerCase();
    return { email: email || undefined, displayName: name || undefined };
  }
  // 꺾쇠 없는 형태 = 이메일만 있는 경우로 간주.
  const bare = from.trim();
  return { email: bare ? bare.toLowerCase() : undefined, displayName: undefined };
}

// internalDate(ms epoch 문자열) → ISO8601. 파싱 불가/부재는 undefined.
function internalDateToIso(internalDate: string | undefined): string | undefined {
  if (!internalDate) return undefined;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

// toRawItem 에 넘기는 컨텍스트 — 변환을 네트워크와 분리하기 위한 순수 입력.
export interface GmailToRawItemCtx {
  instance: string; // provenance.instance (gmail 은 단일 메일박스라 'default')
}

// ── 순수 변환: 원본 메시지 1건(format=full) → RawItem (네트워크 없음, 단위테스트 대상) ──
export function toRawItem(message: GmailMessage, ctx: GmailToRawItemCtx): RawItem {
  const instance = ctx.instance || INSTANCE;
  const headers = message.payload?.headers;

  const subject = getHeader(headers, "Subject");
  const { email, displayName } = parseFrom(getHeader(headers, "From"));

  // 본문: payload 트리에서 text/plain(→html strip) 디코드, 없으면 snippet 폴백.
  const decoded = extractBodyText(message.payload);
  const body = decoded || message.snippet || undefined;

  // 시각: internalDate(서버 권위 ms epoch)이 진실. 메시지는 불변 → updated_at = occurred_at.
  const occurredAt = internalDateToIso(message.internalDate);

  // 스레드 부모: 대화 첫 메시지는 threadId == id. 답장이면 threadId != id → 부모(스레드) external_id.
  const threadId = message.threadId;
  const parentExternalId = threadId && threadId !== message.id ? threadId : undefined;

  return {
    type: "message",
    provenance: {
      category: "messenger",
      system: "gmail",
      instance,
      external_id: message.id, // system+instance 내 안정·고유(message id)
      external_url: `https://mail.google.com/mail/u/0/#all/${message.id}`,
    },
    actor: email
      ? {
          external_id: email, // 소문자 이메일(email-as-external_id)
          display_name: displayName,
          email,
        }
      : undefined,
    parent_external_id: parentExternalId,
    title: subject || undefined,
    body,
    occurred_at: occurredAt,
    updated_at: occurredAt,
    fields: {
      threadId,
      labelIds: message.labelIds,
      snippet: message.snippet,
    },
    raw: message, // 원본 보존
  };
}

// ── HTTP 계층(인증 헤더 + rate limit 존중 + 자발적 스로틀) ─────────────────────
let lastReqAt = 0;

// Gmail API 호출 — GET. token 은 매 호출마다 googleAccessToken 캐시에서(만료 시 자동 재발급 —
// 장기 백필이 access token TTL(~1h)을 넘겨도 무중단). 429 Retry-After 존중 + 지수 백오프, 5xx 백오프.
async function gmailFetch(path: string): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    // 자발적 스로틀: 직전 요청과 최소 간격 유지(quota 선제 준수).
    const wait = lastReqAt + REQ_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReqAt = Date.now();

    const token = await googleAccessToken("gmail");
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });

    // rate limit: 429 → Retry-After(초) 또는 지수 백오프 후 재시도.
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : BACKOFF_BASE_MS * 2 ** attempt;
      await res.text().catch(() => "");
      if (attempt < MAX_RETRY) {
        await sleep(delay);
        continue;
      }
      throw new Error(`gmail 429 rate_limited (재시도 소진): ${path}`);
    }

    // 일시적 서버 오류(5xx)는 지수 백오프 후 재시도.
    if (res.status >= 500 && attempt < MAX_RETRY) {
      await res.text().catch(() => "");
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      continue;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`gmail ${res.status} ${path}: ${bodyText.slice(0, 300)}`);
    }

    return res.json();
  }
  // 위 루프에서 반드시 return/throw 되지만 타입 만족용 가드.
  throw new Error(`gmail 요청 실패(예상치 못한 종료): ${path}`);
}

// ── 백필: messages.list 로 id 를 끝까지 나열 → 각 id 를 format=full 로 개별 조회(N+1) → RawItem yield ──
async function* backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
  const cfg = await resolveConnectorConfig("gmail");

  // 쿼리 조립: config query(선택) + 증분 after:. after: 는 사용자 쿼리 앞에 prepend.
  //  ⚠ after:<n> 은 UNIX 초 + day 단위. Date.parse 가 ISO tz offset 을 존중해 UTC epoch ms → /1000 = UTC epoch 초.
  let q = cfg.query?.trim() || undefined;
  let sinceMs: number | undefined;
  if (opts?.since) {
    const parsed = Date.parse(opts.since);
    if (Number.isFinite(parsed)) {
      sinceMs = parsed;
      const afterSec = Math.floor(parsed / 1000);
      q = q ? `after:${afterSec} ${q}` : `after:${afterSec}`;
    }
  }

  let pageToken: string | undefined;
  let pages = 0;
  do {
    const params = new URLSearchParams({ maxResults: String(LIST_PAGE_SIZE) });
    if (q) params.set("q", q);
    if (pageToken) params.set("pageToken", pageToken);

    const list = (await gmailFetch(`/users/me/messages?${params.toString()}`)) as GmailListResponse;

    for (const ref of list.messages ?? []) {
      if (!ref?.id) continue;
      try {
        // N+1: 목록은 id/threadId 만 주므로 본문·헤더는 개별 format=full 조회.
        const full = (await gmailFetch(
          `/users/me/messages/${encodeURIComponent(ref.id)}?format=full`,
        )) as GmailMessage;

        // 정밀 증분 보정: after: 는 day 단위라 since 당일 이른 메시지를 과다포함할 수 있다.
        //  internalDate 로 정밀 하한(멱등 인입이라 없어도 무해하지만, 재처리를 줄이고 경계를 정확히 한다).
        if (sinceMs != null && full.internalDate) {
          const t = Number(full.internalDate);
          if (Number.isFinite(t) && t < sinceMs) continue;
        }

        yield toRawItem(full, { instance: INSTANCE });
      } catch (err) {
        // 단일 메시지 fetch/파싱 실패는 skip/continue — 전체 백필을 죽이지 않는다.
        console.warn(`gmail 메시지 처리 skip (id=${ref.id}): ${(err as Error).message}`);
        continue;
      }
    }

    pageToken = list.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_LIST_PAGES); // nextPageToken 소진(정상) 또는 상한까지
}

export const gmailConnector: Connector = {
  name: "gmail",
  backfill,
};

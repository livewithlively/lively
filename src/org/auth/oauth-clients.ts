// OAuth 클라이언트 스토어 (#1473 T2) — MCP 사양이 인정하는 **3가지 등록 경로**를 한 인터페이스 뒤에 둔다.
//   · cimd   : client_id 가 https URL 이고 그 URL 이 곧 클라이언트 메타데이터 문서(사양 권장 기본, ChatGPT 가 쓴다).
//              SDK 1.29 의 서버측은 이걸 **처리하지 않는다** — authorize 핸들러가 getClient(client_id) 를 그대로
//              부르므로, URL 형태 client_id 를 만나면 여기서 문서를 가져와 검증·캐시해야 한다.
//   · dcr    : POST /register 동적 등록(RFC 7591). 사양상 deprecated 지만 claude.ai 가 이 경로를 쓴다.
//   · static : 관리자가 미리 등록(Gemini Enterprise 처럼 client_id/secret 을 손으로 넣는 표면용).
//
// ★★ getClient 는 client_secret 을 **절대 돌려주지 않는다** ★★
//   SDK 의 authenticateClient 는 `client.client_secret !== 제시값` 평문 비교를 한다. 우리는 시크릿을 sha256 으로만
//   저장하므로(비밀 평문 보관 금지) 해시를 그대로 얹으면 정상 클라이언트가 100% 인증 실패한다. 그래서 여기서는
//   시크릿을 비워 SDK 가 '공개 클라이언트'로 보고 지나가게 하고, **시크릿 검증은 우리 게이트**
//   (oauth-router.ts 의 clientSecretGate → verifyClientSecret)가 /token·/revoke 앞에서 먼저 수행한다.
//   ⚠ 그 게이트를 빼면 시크릿 검사가 통째로 사라진다. 둘은 한 몸이다.
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { type OAuthClientInformationFull, OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { makeSsrfFetch } from "../../net/mcp-ssrf-fetch.js";
import { getOrgProfile } from "../store/profile.js";
import { getClient as getClientRow, saveClient, type ClientRow } from "../store/oauth.js";
import { sha256Hex } from "./grant-util.js";
import { logger } from "../../log.js";

const CIMD_TIMEOUT_MS = 10_000;
const CIMD_MAX_BYTES = 256 * 1024;   // 클라이언트 메타데이터 문서는 작다 — 크면 뭔가 잘못된 것.
const CIMD_MIN_TTL = 300;            // 캐시 하한 5분(문서가 no-store 여도 매 요청 fetch 하지 않는다).
const CIMD_MAX_TTL = 24 * 3600;      // 캐시 상한 24시간(회수 반영이 하루 넘게 늦지 않게).
const CIMD_DEFAULT_TTL = 3600;
const CIMD_USER_AGENT = "Lively-Gateway (+https://github.com/livewithlively/lively)";

// CIMD 문서 메모리 캐시. DB(oauth_client) 는 영속·감사·폴백용이고, 핫패스는 이 맵이 받는다.
const cimdCache = new Map<string, { info: OAuthClientInformationFull; expiresAt: number }>();

export function resetCimdCache(): void { cimdCache.clear(); }

// client_id 가 CIMD 형식인가 — https URL + fragment 없음(초안 요구). 그 외는 전부 DB 조회 대상.
export function isCimdClientId(clientId: string): boolean {
  if (!clientId.startsWith("https://")) return false;
  try { const u = new URL(clientId); return !u.hash; } catch { return false; }
}

// redirect_uri 형태 게이트 — https 이거나 loopback(네이티브 앱 RFC 8252) 만. 그 외(custom scheme·http 원격)는 거부.
//  느슨하게 두면 우리가 발급한 코드를 임의 평문 엔드포인트로 흘리는 오픈 리다이렉터가 된다.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export function isAcceptableRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false; // redirect_uri 는 fragment 를 가질 수 없다(RFC 6749 §3.1.2)
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch { return false; }
}

async function cimdFetch(): Promise<ReturnType<typeof makeSsrfFetch>> {
  const selfHosts: string[] = [];
  try {
    const p = await getOrgProfile();
    if (p.gateway_url) selfHosts.push(new URL(p.gateway_url).hostname.toLowerCase());
  } catch { /* 프로필 없음 — selfHosts 비움 */ }
  // ⚠ allowedInternalHosts 는 **의도적으로 비운다**. 상류 MCP 프록시와 달리 CIMD 문서의 정당한 출처는
  //  외부 챗 벤더뿐이다. 내부 host 를 열면 client_id 하나로 사내망을 훑는 SSRF 창구가 된다.
  return makeSsrfFetch({ allowedInternalHosts: [], selfHosts, timeoutMs: CIMD_TIMEOUT_MS, maxBytes: CIMD_MAX_BYTES });
}

// Cache-Control: max-age 를 존중하되 [5분, 24시간] 으로 클램프. 헤더가 없으면 1시간.
export function ttlFromHeaders(h: Headers): number {
  const cc = h.get("cache-control") ?? "";
  if (/no-store|no-cache/i.test(cc)) return CIMD_MIN_TTL;
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  const raw = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(raw)) return CIMD_DEFAULT_TTL;
  return Math.min(CIMD_MAX_TTL, Math.max(CIMD_MIN_TTL, Math.floor(raw)));
}

// DB 행 → SDK 형태. metadata JSONB 에 원문 메타데이터를 통째로 넣어 두었으므로 그걸 펼치고 핵심 필드를 덮어쓴다.
function rowToClientInfo(row: ClientRow): OAuthClientInformationFull {
  return {
    ...(row.metadata as Record<string, unknown>),
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: row.redirect_uris,
    grant_types: row.grant_types,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    client_secret: undefined, // ★ 위 머리주석 — 시크릿은 우리 게이트가 검증한다.
  } as OAuthClientInformationFull;
}

/** CIMD 문서 검증 — 순수 함수(네트워크·DB 무접촉). 위반이면 throw. 이 파일의 **보안 핵심**이라 따로 뺐다. */
export function validateCimdDocument(clientId: string, doc: unknown): OAuthClientInformationFull {
  const d = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  // ★ 초안의 핵심 검증 — 문서 안의 client_id 가 우리가 요청한 URL 과 **정확히** 같아야 한다.
  //  이게 없으면 아무 URL 이나 남의 client_id 를 참칭하는 문서를 올려 신원을 훔칠 수 있다.
  if (String(d.client_id ?? "") !== clientId) throw new Error("CIMD 문서의 client_id 가 URL 과 일치하지 않음");
  const parsed = OAuthClientMetadataSchema.safeParse(d);
  if (!parsed.success) throw new Error(`CIMD 메타데이터 형식 오류: ${parsed.error.message}`);
  const meta = parsed.data;
  const redirectUris = (meta.redirect_uris ?? []).filter(isAcceptableRedirectUri);
  if (!redirectUris.length) throw new Error("CIMD 문서에 사용 가능한 redirect_uris 가 없음(https 또는 loopback 만 허용)");
  return {
    ...meta,
    client_id: clientId,
    redirect_uris: redirectUris,
    client_secret: undefined, // CIMD 클라이언트는 공개 클라이언트다 — 문서에 비밀이 적혀 있어도 무시한다.
  } as OAuthClientInformationFull;
}

/** CIMD 문서를 가져와 검증한다. 실패하면 throw. 성공하면 메모리 캐시 + DB 미러(폴백·감사)에 남긴다. */
async function fetchCimd(clientId: string): Promise<OAuthClientInformationFull> {
  const fetchFn = await cimdFetch();
  // ⚠ User-Agent 필수 — 우리 SSRF fetch 는 node:https 로 직접 요청하느라 UA 를 안 붙이는데, **UA 없는 요청을
  //  403 으로 막는 문서 호스트가 실제로 있다**(2026-08-04 실측: api.github.com 은 UA 없으면 403, 붙이면 200).
  //  챗 벤더의 CIMD 문서 서버가 같은 정책이면 인가가 통째로 실패한다. 우리가 누구인지 밝히는 게 예의이기도 하다.
  const res = await fetchFn(clientId, { headers: { accept: "application/json", "user-agent": CIMD_USER_AGENT } });
  if (!res.ok) throw new Error(`CIMD 문서 응답 ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!/json/i.test(ct)) throw new Error(`CIMD 문서 content-type 이 JSON 이 아님: ${ct}`);
  const info = validateCimdDocument(clientId, await res.json());
  cimdCache.set(clientId, { info, expiresAt: Date.now() + ttlFromHeaders(res.headers) * 1000 });
  // DB 미러 — 재기동 후 문서 서버가 잠깐 죽어도 기존 연결이 살아 있게(아래 stale 폴백) + 누가 붙었는지 감사.
  await saveClient({
    clientId, kind: "cimd", clientName: info.client_name ?? null,
    redirectUris: info.redirect_uris, grantTypes: info.grant_types ?? ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none", metadata: info as unknown as Record<string, unknown>,
    actor: "system",
  }).catch((err) => logger.warn({ err, clientId }, "CIMD 미러 저장 실패(무시)"));
  return info;
}

export class LivelyClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (isCimdClientId(clientId)) {
      const hit = cimdCache.get(clientId);
      if (hit && hit.expiresAt > Date.now()) return hit.info;
      try {
        return await fetchCimd(clientId);
      } catch (err) {
        // stale 폴백 — 문서 서버 일시 장애로 **이미 연결된 커넥터가 죽지 않게**. 없으면 그냥 미등록 취급.
        logger.warn({ err: (err as Error).message, clientId }, "CIMD 문서 조회 실패 — DB 미러로 폴백");
        const row = await getClientRow(clientId).catch(() => null);
        if (row) return rowToClientInfo(row);
      }
      return undefined;
    }
    const row = await getClientRow(clientId);
    return row ? rowToClientInfo(row) : undefined;
  }

  /** DCR(RFC 7591). SDK 가 client_id·client_secret 을 만들어 넘기고, 평문 시크릿은 이 응답에서 **한 번만** 나간다.
   *  무인증 등록이 위험해 보이지만 등록 자체로는 아무 권한도 생기지 않는다 — 사람이 로그인하고 동의를 눌러야
   *  토큰이 나온다. 남용은 SDK 의 rate limit(시간당 20건)이 받는다. */
  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const redirectUris = (client.redirect_uris ?? []).filter(isAcceptableRedirectUri);
    if (!redirectUris.length) throw new Error("redirect_uris 가 필요합니다(https 또는 loopback 만 허용)");
    await saveClient({
      clientId: client.client_id,
      kind: "dcr",
      clientName: client.client_name ?? null,
      clientSecretHash: client.client_secret ? sha256Hex(client.client_secret) : null,
      redirectUris,
      grantTypes: client.grant_types ?? ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none"),
      metadata: { ...client, client_secret: undefined } as unknown as Record<string, unknown>,
      actor: "system",
    });
    return { ...client, redirect_uris: redirectUris };
  }
}

/**
 * 클라이언트 시크릿 검증 — /token·/revoke 앞의 우리 게이트가 부른다(머리주석 ★★ 참조).
 *  반환: "ok"(공개 클라이언트거나 시크릿 일치) | "missing"(시크릿 필요한데 없음) | "mismatch" | "unknown"(미등록).
 *  ⚠ 타이밍 공격 방어로 timingSafeEqual 을 쓴다 — 비교 대상은 해시라 길이가 고정이다.
 */
export async function verifyClientSecret(clientId: string, presented: string | undefined): Promise<"ok" | "missing" | "mismatch" | "unknown"> {
  if (isCimdClientId(clientId)) return "ok"; // CIMD = 공개 클라이언트(시크릿 개념 없음)
  const row = await getClientRow(clientId);
  if (!row) return "unknown";
  if (!row.client_secret_hash) return "ok";  // 공개 클라이언트로 등록됨
  if (!presented) return "missing";
  return timingSafeEqualHex(sha256Hex(presented), row.client_secret_hash) ? "ok" : "mismatch";
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 노션 공개 통합(public integration) OAuth 직결(#1881 N2) — 라이블리가 소유한 Notion 공개 통합으로 관리자가
//  [팀 자료로 모으기] 한 번에 조직 수집 토큰을 만든다. 동의 화면의 **페이지 선택기가 곧 수집 범위**다.
//
//  왜 MCP SDK auth() 를 안 쓰나: 구성원 개인 도구는 mcp.notion.com(DCR) 그대로다 — 거기서 받은 토큰은
//  api.notion.com REST 에 안 통한다(노션이 API 토큰을 MCP 서버측에 보관, issuer 도 다름 —
//  지식 notion-single-connect-design-1881 §1①). 수집기는 REST 전제(#551 무손실)라 **별도의 공개 통합 OAuth**
//  (api.notion.com/v1/oauth/*)가 필요하고, 이 교환은 HTTP Basic(client_id:client_secret) + JSON 이라 SDK 밖이다.
//
//  이 파일은 **순수 + fetch** 만 — 금고 읽기/쓰기는 oauth-broker 가 한다(슬랙 slack-oauth.ts 와 같은 분업).
//  PKCE 는 안 쓴다(노션 공개 통합은 미지원 — confidential client·Basic 교환). CSRF 는 브로커의 서명 state.
//
//  토큰 수명: 노션은 공개 통합 access_token 의 만료를 문서에 명시하지 않고 refresh_token(null 가능)을 준다.
//  2026-06-08 부터 새 공개 연결은 인가마다 새 토큰쌍 — 재동의([페이지 더 고르기])가 슬롯을 덮어써도 안전하다.
//  갱신(grant_type=refresh_token)에도 client_secret 이 필요해 매니지드에선 CP 가 갱신 프록시가 된다(N4).

export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/** 조직 수집 토큰이 들어가는 금고 슬롯 kind. scope_key = workspace_id — 워크스페이스 둘을 붙여도 안 섞인다.
 *  같은 kind 의 CLIENT_SCOPE("oauth:client") 슬롯에 공개 통합 client_id/secret 이 산다(슬랙과 같은 규약). */
export const NOTION_PUBLIC_KIND = "notion_public";

/** state.s 에 실리는 예약 서버명 — org_mcp_server 행이 **아니다**(개인 MCP 연결 'notion' 과 별개 플로우).
 *  콜백(/oauth/callback)이 이 마커로 공개 통합 교환 분기를 탄다. */
export const NOTION_PUBLIC_SERVER = "notion-public";

export function isNotionPublicServer(name: string | null | undefined): boolean {
  return String(name ?? "").toLowerCase() === NOTION_PUBLIC_SERVER;
}

/** 인가 URL — owner=user 가 노션 공개 통합의 필수 파라미터(사용자 동의 + 페이지 선택기). scope 파라미터는 없다
 *  (노션은 기능(capabilities)을 통합 설정에서 정한다 — 수집 전용이라 Read 3종만, 지식 §5). */
export function buildNotionAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(NOTION_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("owner", "user");
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  return u.toString();
}

/** 토큰 응답에서 우리가 쓰는 것만. */
export interface NotionInstall {
  access_token: string;
  refresh_token: string | null; // 노션이 안 주면 null — 만료 시 재연결이 유일 경로가 된다
  bot_id: string | null;
  workspace: { id: string; name: string | null; icon: string | null };
  owner_user: { id: string; name: string | null } | null;
}

interface TokenResp {
  error?: unknown; error_description?: unknown;
  access_token?: unknown; refresh_token?: unknown; bot_id?: unknown;
  workspace_id?: unknown; workspace_name?: unknown; workspace_icon?: unknown;
  owner?: { type?: unknown; user?: { id?: unknown; name?: unknown } | null } | null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * 토큰 응답 파싱 — 실패는 던진다(노션은 400 + {error, error_description}).
 *  workspace_id 가 없으면 저장할 슬롯 키가 없다 — 연결 실패로 취급(정상 응답엔 항상 있다).
 */
export function parseNotionTokenResponse(j: unknown): NotionInstall {
  const r = (j ?? {}) as TokenResp;
  const errCode = str(r.error);
  if (errCode) throw new Error(`노션 토큰 교환 실패: ${errCode}${str(r.error_description) ? ` — ${str(r.error_description)}` : ""}`);
  const tok = str(r.access_token);
  if (!tok) throw new Error("노션이 access_token 을 주지 않았습니다 — 동의가 완료되지 않았습니다.");
  const wsId = str(r.workspace_id);
  if (!wsId) throw new Error("노션 응답에 workspace_id 가 없습니다 — 어느 워크스페이스인지 몰라 저장할 수 없습니다.");
  const ou = r.owner?.user ?? null;
  const ouId = str(ou?.id);
  return {
    access_token: tok,
    refresh_token: str(r.refresh_token),
    bot_id: str(r.bot_id),
    workspace: { id: wsId, name: str(r.workspace_name), icon: str(r.workspace_icon) },
    owner_user: ouId ? { id: ouId, name: str(ou?.name) } : null,
  };
}

/** SSRF-가드 fetch(makeSsrfFetch)와 전역 fetch 둘 다 받는 최소 시그니처(slack-oauth 와 동일). */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

async function notionTokenGrant(p: { clientId: string; clientSecret: string; body: Record<string, string>; fetchFn?: FetchLike }): Promise<NotionInstall> {
  const basic = Buffer.from(`${p.clientId}:${p.clientSecret}`, "utf8").toString("base64");
  const f = p.fetchFn ?? fetch;
  const res = await f(NOTION_TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/json" },
    body: JSON.stringify(p.body),
  });
  let j: unknown;
  try { j = await res.json(); } catch { throw new Error(`노션 토큰 응답을 읽지 못했습니다(HTTP ${res.status})`); }
  return parseNotionTokenResponse(j);
}

/** code → 토큰 교환(HTTP Basic + JSON — 노션 공식). client_secret 은 이 호출 안에서만 산다(응답·로그 금지). */
export async function exchangeNotionCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; fetchFn?: FetchLike;
}): Promise<NotionInstall> {
  return notionTokenGrant({ clientId: p.clientId, clientSecret: p.clientSecret, fetchFn: p.fetchFn,
    body: { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri } });
}

/** refresh_token → 새 토큰쌍. 노션은 회전형 — 이전 refresh_token 은 무효가 되므로 응답을 **반드시** 저장해야 한다. */
export async function refreshNotionToken(p: {
  clientId: string; clientSecret: string; refreshToken: string; fetchFn?: FetchLike;
}): Promise<NotionInstall> {
  return notionTokenGrant({ clientId: p.clientId, clientSecret: p.clientSecret, fetchFn: p.fetchFn,
    body: { grant_type: "refresh_token", refresh_token: p.refreshToken } });
}

/** 금고에 넣을 모양 — 브로커가 그대로 setMemberSecret 에 넘긴다. 블롭은 OAuthTokens 형식(decodeTokenBlob 호환).
 *  refresh_token 은 **블롭(암호문) 안**에만 — meta 는 평문이라 토큰 금지(oauth-broker 규약). */
export function notionInstallToSlot(i: NotionInstall): {
  scopeKey: string; secret: string; meta: Record<string, unknown>;
} {
  return {
    scopeKey: i.workspace.id,
    secret: JSON.stringify({
      access_token: i.access_token, token_type: "bearer",
      ...(i.refresh_token ? { refresh_token: i.refresh_token } : {}),
    }),
    meta: {
      workspace_id: i.workspace.id, workspace_name: i.workspace.name, workspace_icon: i.workspace.icon,
      bot_id: i.bot_id, owner_user_id: i.owner_user?.id ?? null, owner_name: i.owner_user?.name ?? null,
      via: "notion_public_oauth",
    },
  };
}

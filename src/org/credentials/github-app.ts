// GitHub App 직결(#1881 G5) — 라이블리(또는 셀프호스팅 고객)가 소유한 GitHub App 으로 구성원이 [GitHub 연결] 한 번에 붙는다.
//
// ── 왜 OAuth App 이 아니라 GitHub App 인가 ──────────────────────────────────────────────────
//  ① **레포 선택기**: 설치 화면에서 사용자가 어느 저장소를 줄지 고른다. 그 화면이 곧 접근 범위 선언이다
//     (노션의 페이지 선택기와 같은 모델). OAuth App 의 `repo` scope 는 전부 아니면 전무라 이 장치가 없다.
//  ② **clone 이 된다**: installation access token 으로 `git clone https://x-access-token:<T>@github.com/o/r.git`.
//     PAT 발급·SSH 키 등록이라는 두 벽이 통째로 사라진다 — 컴맹 셀프서브의 핵심.
//  상류가 DCR 을 지원하지 않으므로(2026-08-26 프로브: github.com 에 oauth-authorization-server 메타데이터 없음)
//  앱 소유 말고는 셀프서브 경로가 없다. 그게 이 파일이 존재하는 이유다.
//
// ── 이 파일의 경계 ────────────────────────────────────────────────────────────────────────
//  **순수 + fetch 만** — 금고 읽기/쓰기는 oauth-broker 가 한다(순환 import 회피 + 테스트가 DB 없이 돈다).
//  슬랙(slack-oauth.ts)·노션(notion-oauth.ts)과 같은 규약이다.
//
// ── 토큰이 둘인 이유(그리고 만료가 다른 이유) ──────────────────────────────────────────────
//  · **user access token**(ghu_) — "그 사람으로서" 이슈·PR 을 다룬다. 8시간 만료 + refresh token(6개월).
//    금고의 `github_pat` 슬롯에 **토큰 묶음**으로 들어간다 — 붙여넣기 PAT 과 같은 슬롯이라 도구(G4)는
//    한 글자도 안 바뀐다(oauth-proxy-auth 가 묶음/정적을 알아서 가른다).
//  · **installation access token** — "앱으로서" 선택된 레포를 clone·읽는다. **1시간 만료, refresh 없음.**
//    ⚠ 그래서 이 토큰은 **저장하지 않는다.** 저장하면 1시간 뒤 전부 죽는다. 대신 app_id + installation_id 만
//    두고 필요할 때마다 App JWT 로 새로 찍는다(mintInstallationToken). private key 가 있어야 찍을 수 있고,
//    매니지드에선 그 key 가 CP 에만 있으므로 CP 프록시가 대신 찍는다(G7).
import { createSign, createPrivateKey } from "node:crypto";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API = "https://api.github.com";
/** GitHub 이 요구하는 User-Agent — 없으면 403(administrative rules)이다. */
export const GITHUB_USER_AGENT = "lively-gateway";

/**
 * 콜백 라우팅용 예약 서버명(#1881 G5).
 *  GitHub 은 `org_mcp_server` 행이 **없다** — 도구 면을 REST(http_proxy)로 내렸기 때문이다(G4). 그래서 브로커가
 *  서버 행을 읽는 일반 경로를 못 탄다. 노션 공개 통합이 먼저 같은 처지였고(notion-public) 같은 해법을 쓴다:
 *  예약 이름으로 state 를 서명해 콜백을 라우팅하고, 서버 행 없이 자격만으로 동작한다.
 */
export const GITHUB_APP_SERVER = "github-app";
export function isGithubAppServer(name: string | null | undefined): boolean {
  return String(name ?? "").toLowerCase() === GITHUB_APP_SERVER;
}

/** 앱 자격(client_id/secret·app_id·private key)이 들어가는 조직 금고 kind. */
export const GITHUB_APP_KIND = "github_app";
/** private key 를 담는 예약 scope_key — client 묶음(oauth:client)과 다른 행이다(용도·수명이 다르다). */
export const GITHUB_APP_KEY_SCOPE = "app:key";
/** 설치 결과(레포 선택 범위)를 담는 조직 슬롯 kind. scope_key = installation_id. */
export const GITHUB_INSTALL_KIND = "github_app_install";

/**
 * 이 auth_kind 가 GitHub App 직결 플로우를 타는가.
 *  `github_pat` 인 이유: 도구 묶음(G4)이 그 슬롯을 쓰고, 이미 PAT 을 넣어 둔 사람이 재입력 없이 도구를 갖는다.
 *  OAuth 로 받은 토큰을 같은 슬롯에 넣으면 그 사람은 붙여넣기에서 연결로 **조용히 승계**된다.
 */
export function isGithubAppKind(authKind: string | null | undefined): boolean {
  return String(authKind ?? "").toLowerCase() === "github_pat";
}

/**
 * 사용자 인가 URL.
 *  ⚠ GitHub App 은 `scope` 파라미터를 쓰지 않는다 — 권한은 앱 설정에 고정돼 있고 요청 시점에 못 넓힌다
 *  (OAuth App 과 다른 점이고, 최소권한이 앱 수준에서 보장되는 이유이기도 하다). 넣으면 무시되거나 거부된다.
 */
export function buildGithubAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  return u.toString();
}

/**
 * 설치(레포 선택) 화면 URL — 아직 앱을 설치하지 않은 사람의 첫 걸음.
 *  "Request user authorization (OAuth) during installation" 을 켠 앱이면 설치가 끝나며 code 도 함께 돌아와
 *  한 번의 왕복으로 설치 + 인가가 같이 끝난다.
 */
export function githubInstallUrl(appSlug: string, state?: string): string {
  const slug = String(appSlug ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!slug) throw new Error("GitHub App slug 가 필요합니다");
  const u = new URL(`https://github.com/apps/${slug}/installations/new`);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

/** 우리가 쓰는 것만 추린 user token 묶음. */
export interface GithubUserTokens {
  access_token: string;
  token_type: string;
  /** 앱이 'Expire user authorization tokens' 를 켰을 때만(기본 켜짐) — 없으면 만료 없는 토큰이다. */
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * 토큰 응답 파싱.
 *  ⚠ GitHub 은 실패도 **HTTP 200 + {error}** 로 준다(슬랙의 ok:false 와 같은 함정). 상태코드만 보면 통과한다.
 */
export function parseGithubTokenResponse(j: unknown): GithubUserTokens {
  const o = (j ?? {}) as Record<string, unknown>;
  if (typeof o.error === "string" && o.error) {
    const desc = typeof o.error_description === "string" ? o.error_description : "";
    throw new Error(`GitHub OAuth 실패: ${o.error}${desc ? ` — ${desc}` : ""}`);
  }
  const at = o.access_token;
  if (typeof at !== "string" || !at) throw new Error("GitHub OAuth 응답에 access_token 이 없습니다");
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    access_token: at,
    token_type: typeof o.token_type === "string" && o.token_type ? o.token_type : "bearer",
    ...(num(o.expires_in) !== undefined ? { expires_in: num(o.expires_in) } : {}),
    ...(typeof o.refresh_token === "string" && o.refresh_token ? { refresh_token: o.refresh_token } : {}),
    ...(num(o.refresh_token_expires_in) !== undefined ? { refresh_token_expires_in: num(o.refresh_token_expires_in) } : {}),
    ...(typeof o.scope === "string" ? { scope: o.scope } : {}),
  };
}

async function postToken(body: Record<string, string>, fetchFn: FetchLike): Promise<GithubUserTokens> {
  const res = await fetchFn(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  // 200 이어도 본문에 error 가 올 수 있고(위 파서가 잡는다), 4xx/5xx 는 여기서 잡는다.
  if (!res.ok) throw new Error(`GitHub 토큰 요청 실패(${res.status})`);
  return parseGithubTokenResponse(await res.json());
}

export function exchangeGithubCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; fetchFn: FetchLike;
}): Promise<GithubUserTokens> {
  return postToken({
    client_id: p.clientId, client_secret: p.clientSecret, code: p.code, redirect_uri: p.redirectUri,
  }, p.fetchFn);
}

export function refreshGithubUserToken(p: {
  clientId: string; clientSecret: string; refreshToken: string; fetchFn: FetchLike;
}): Promise<GithubUserTokens> {
  return postToken({
    client_id: p.clientId, client_secret: p.clientSecret,
    grant_type: "refresh_token", refresh_token: p.refreshToken,
  }, p.fetchFn);
}

/**
 * App JWT — "앱 자신"으로 인증하는 짧은 토큰(installation token 을 찍을 때만 쓴다).
 *  RS256 서명. GitHub 제약: exp - iat ≤ 10분. iat 을 60초 뒤로 미는 건 GitHub 권장(우리 시계가 빠르면 거부된다).
 *  ⚠ 이 값은 로그에 남기지 않는다 — 짧아도 앱 전체 권한이다.
 */
export function buildAppJwt(p: { appId: string; privateKeyPem: string; nowSec: number }): string {
  const appId = String(p.appId ?? "").trim();
  if (!appId) throw new Error("GitHub App ID 가 필요합니다");
  const pem = String(p.privateKeyPem ?? "").trim();
  if (!pem) throw new Error("GitHub App private key 가 필요합니다");
  const iat = Math.floor(p.nowSec) - 60;
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: appId })}`;
  const sig = createSign("RSA-SHA256").update(data).sign(createPrivateKey(pem), "base64url");
  return `${data}.${sig}`;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
  /** 'all' | 'selected' — 설치 시 사용자가 무엇을 골랐는가. */
  repository_selection?: string;
  /** repositories 를 지정해 좁혀 받은 경우 그 목록(full_name). */
  repositories?: string[];
}

export function parseInstallationTokenResponse(j: unknown): InstallationToken {
  const o = (j ?? {}) as Record<string, unknown>;
  const t = o.token;
  if (typeof t !== "string" || !t) {
    const msg = typeof o.message === "string" ? o.message : "";
    throw new Error(`installation token 발급 실패${msg ? `: ${msg}` : ""}`);
  }
  const repos = Array.isArray(o.repositories)
    ? (o.repositories as Array<Record<string, unknown>>).map((r) => String(r?.full_name ?? "")).filter(Boolean)
    : undefined;
  return {
    token: t,
    expires_at: typeof o.expires_at === "string" ? o.expires_at : "",
    ...(typeof o.repository_selection === "string" ? { repository_selection: o.repository_selection } : {}),
    ...(repos && repos.length ? { repositories: repos } : {}),
  };
}

/**
 * installation access token 발급(1시간).
 *  `repositories` 를 주면 그 레포로만 좁힌 토큰이 나온다 — clone 하나 때문에 설치 전체 권한을 들고 다니지 않는다.
 *  ⚠ 저장하지 마라. 쓰기 직전에 찍고 버리는 것이 이 토큰의 사용법이다(파일 상단 주석).
 */
export async function mintInstallationToken(p: {
  appId: string; privateKeyPem: string; installationId: string | number;
  repositories?: string[]; fetchFn: FetchLike; nowSec?: number;
}): Promise<InstallationToken> {
  const id = String(p.installationId ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error(`installation_id 형식 오류: ${id}`);
  const jwt = buildAppJwt({ appId: p.appId, privateKeyPem: p.privateKeyPem, nowSec: p.nowSec ?? Math.floor(Date.now() / 1000) });
  const res = await p.fetchFn(`${GITHUB_API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      //  ⚠ GitHub 은 User-Agent 없는 요청을 **403 으로 거부한다**("Request forbidden by administrative rules.
      //   Please make sure your request has a User-Agent header"). 2026-08-26 실호출에서 이것 때문에 발급이
      //   통째로 막혔다 — fetch 스텁 테스트로는 절대 안 보이는 종류다(스텁은 헤더를 검사하지 않으면 다 통과시킨다).
      "user-agent": GITHUB_USER_AGENT,
      ...(p.repositories?.length ? { "content-type": "application/json" } : {}),
    },
    ...(p.repositories?.length ? { body: JSON.stringify({ repositories: p.repositories }) } : {}),
  });
  if (!res.ok && res.status !== 201) {
    const body = await res.text().catch(() => "");
    throw new Error(`installation token 발급 실패(${res.status})${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  return parseInstallationTokenResponse(await res.json());
}

/** clone 에 쓰는 HTTPS 주소 — 사용자명은 관례상 x-access-token(서버가 검사하는 값은 아니지만 의도를 드러낸다). */
export function installationCloneUrl(repoFullName: string, token: string): string {
  const name = String(repoFullName ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(name)) throw new Error(`저장소 이름 형식 오류(owner/repo): ${repoFullName}`);
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${name}.git`;
}

/** 설치 콜백 쿼리 → 우리가 쓰는 값. GitHub 은 설치 직후 installation_id·setup_action 을 함께 보낸다. */
export function parseInstallCallback(q: Record<string, string | undefined>): { installationId: string | null; setupAction: string | null } {
  const raw = String(q.installation_id ?? "").trim();
  return {
    installationId: /^\d+$/.test(raw) ? raw : null,
    setupAction: String(q.setup_action ?? "").trim() || null,
  };
}

// http_proxy(B 어댑터)가 per-member OAuth 자격을 쓰게 하는 조각 (#1654).
//
//  왜 필요한가 — 금고 슬롯은 이미 맞다. OAuth 브로커도 `setMemberSecret(member:<id>, auth_kind, scope_key)` 로 저장하고
//  http_proxy 의 `resolveMemberSecret` 도 같은 키로 읽는다. 어긋나는 건 **꺼내 쓰는 방식** 둘뿐이다:
//   ① 저장 형식 — OAuth 는 토큰 묶음(OAuthTokens)을 통째로 JSON 으로 넣는다(encodeTokenBlob). 그대로 헤더에 실으면
//      `Authorization: Bearer {"access_token":…}` 이 나가 상류가 전부 거부한다. → access token 하나만 뽑아 싣는다.
//   ② 만료 — access token 은 보통 1시간이다. A 경로(MCP 프록시)는 SDK auth() 가 알아서 갱신하지만 B 엔 그 경로가 없다.
//      상류가 MCP 서버가 아니라 그냥 REST API 라(www.googleapis.com/drive/v3) 디스커버리할 곳도 없다.
//      → 발급처는 auth_kind 프리셋에서 얻고, 갱신 결과는 **금고에 다시 쓴다**(다음 호출이 또 만료 토큰을 쓰지 않게).
//
//  설계 원칙: 정적 토큰 경로는 한 글자도 바뀌지 않는다. 묶음으로 해석되지 않으면 그대로 통과시킨다(무회귀).
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { decodeTokenBlob, encodeTokenBlob, tokenMeta, CLIENT_SCOPE, gatewaySsrfFetch } from "./oauth-broker.js";
import { getMemberSecret, setMemberSecret, type MemberSecretResolved } from "./member-secret-store.js";
import { presetOAuthTokenUrl } from "../delivery/mcp-server-presets.js";
import { logger } from "../../log.js";

/** 만료 여유(초) — 호출이 나가는 동안 만료돼 상류가 401 을 주는 것까지 막는다. */
export const EXPIRY_SKEW_SEC = 60;

/**
 * 이 자격이 만료됐는가. 판정 근거는 meta.expires_at(브로커의 tokenMeta 가 저장하는 epoch 초).
 *  ⚠ 판정 불가(필드 없음·숫자 아님)는 **만료 아님**이다 — 모르는 걸 만료로 단정하면 멀쩡한 토큰을 매 호출 갱신하고,
 *  갱신 수단이 없는 정적 토큰 커넥터까지 실패로 밀어낸다. 만료를 놓치면 상류가 401 로 알려주지만 그 반대는 자해다.
 */
export function isTokenExpired(meta: Record<string, unknown> | undefined, nowSec: number, skewSec = EXPIRY_SKEW_SEC): boolean {
  const raw = meta?.expires_at;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return false;
  return raw <= nowSec + skewSec;
}

/**
 * 갱신 응답을 기존 묶음에 병합. 구글은 refresh 응답에 refresh_token 을 **안 준다**(기존 것을 계속 쓰라는 뜻) —
 *  덮어쓰면 갱신 토큰이 사라져 1시간 뒤 영구 실패한다. 그래서 상류가 준 값만 얹고, 안 준 필드는 기존 값을 지킨다.
 */
export function mergeRefreshedTokens(prev: OAuthTokens, next: Partial<OAuthTokens>): OAuthTokens {
  return {
    ...prev,
    ...next,
    access_token: (next.access_token as string) ?? prev.access_token,
    refresh_token: next.refresh_token ?? prev.refresh_token,
  } as OAuthTokens;
}

export interface OAuthClientInfo { client_id: string; client_secret?: string }

/** 갱신 경로의 부수효과 — 테스트가 갈아끼운다(네트워크·DB 없이 J 표를 전수 검증하려고). */
export interface ProxyAuthDeps {
  nowSec?: () => number;
  tokenUrlOf?: (authKind: string) => string | undefined;
  loadClient?: (authKind: string) => Promise<OAuthClientInfo | null>;
  postRefresh?: (tokenUrl: string, form: URLSearchParams) => Promise<{ status: number; ok: boolean; text: string }>;
  persist?: (owner: string, kind: string, scopeKey: string, tokens: OAuthTokens) => Promise<void>;
}

async function defaultLoadClient(authKind: string): Promise<OAuthClientInfo | null> {
  const r = await getMemberSecret("gateway", authKind, CLIENT_SCOPE);
  if (!r?.secret) return null;
  try {
    const ci = JSON.parse(r.secret) as OAuthClientInfo;
    return typeof ci?.client_id === "string" && ci.client_id ? ci : null;
  } catch { return null; }
}

async function defaultPostRefresh(tokenUrl: string, form: URLSearchParams): Promise<{ status: number; ok: boolean; text: string }> {
  const f = await gatewaySsrfFetch(); // 토큰 교환도 SSRF 가드를 지난다(브로커 경로와 동일 구성)
  const res = await f(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  return { status: res.status, ok: res.ok, text: await res.text().catch(() => "") };
}

async function defaultPersist(owner: string, kind: string, scopeKey: string, tokens: OAuthTokens): Promise<void> {
  await setMemberSecret(owner, kind, scopeKey, { secret: encodeTokenBlob(tokens), meta: tokenMeta(tokens) }, "oauth-refresh");
}

/**
 * 만료된 묶음을 갱신한다. 실패는 전부 **명시적 에러** — 조용히 옛 토큰으로 진행하지 않는다(상류에서 401 로 터지면
 *  원인이 '자격 만료'인지 '권한 변경'인지 구분이 안 되고, 그 혼동이 이번 구글 403 진단을 몇 달 늦춘 것과 같은 종류다).
 */
async function refreshBlob(
  resolved: MemberSecretResolved, authKind: string, tokens: OAuthTokens, deps: ProxyAuthDeps,
): Promise<OAuthTokens> {
  const reconnect = "'내 자격'에서 이 커넥터를 다시 연결하세요.";
  if (!tokens.refresh_token) {
    // access_type=offline 픽스(#746, 2026-07-22) 이전 연결분 — 갱신 토큰 자체가 없다. 이미 죽은 연결이다.
    throw new Error(`자격이 만료됐고 갱신 토큰이 없습니다 — ${reconnect}`);
  }
  const tokenUrl = (deps.tokenUrlOf ?? presetOAuthTokenUrl)(authKind);
  if (!tokenUrl) throw new Error(`자격이 만료됐는데 '${authKind}' 의 토큰 발급처를 모릅니다 — 관리자에게 프리셋 설정을 요청하세요.`);
  const client = await (deps.loadClient ?? defaultLoadClient)(authKind);
  if (!client) throw new Error(`자격이 만료됐는데 '${authKind}' 의 OAuth 클라이언트 정보가 없습니다 — 관리자에게 등록을 요청하세요.`);

  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  if (client.client_secret) form.set("client_secret", client.client_secret);
  const res = await (deps.postRefresh ?? defaultPostRefresh)(tokenUrl, form);
  if (!res.ok) {
    // 본문을 통째로 싣지 않는다 — 토큰 교환 실패 응답에 자격이 되비쳐 오는 상류가 있다. invalid_grant 면 갱신 토큰 폐기(재연결).
    throw new Error(`자격 갱신 실패(${res.status}) — ${res.text.slice(0, 160)}${res.text.length > 160 ? "…" : ""} / ${reconnect}`);
  }
  let next: Partial<OAuthTokens>;
  try { next = JSON.parse(res.text) as Partial<OAuthTokens>; }
  catch { throw new Error(`자격 갱신 응답을 해석할 수 없습니다 — ${reconnect}`); }
  if (typeof next.access_token !== "string" || !next.access_token) throw new Error(`자격 갱신 응답에 access_token 이 없습니다 — ${reconnect}`);

  const merged = mergeRefreshedTokens(tokens, next);
  // 저장 실패는 호출을 막지 않는다 — 방금 받은 토큰은 유효하므로 이번 호출은 성공시키고, 다음 호출이 다시 갱신할 뿐이다.
  await (deps.persist ?? defaultPersist)(resolved.owner, resolved.kind, resolved.scope_key, merged)
    .catch((err) => logger.warn({ err, kind: resolved.kind }, "갱신된 OAuth 토큰 저장 실패 — 이번 호출은 진행(다음 호출이 재갱신)"));
  return merged;
}

/**
 * 금고 해소 결과 → **헤더에 실제로 실을 값**. http_proxy 의 자격 해소 구간이 부른다.
 *  · 묶음이 아니면 그대로(정적 토큰 무회귀).
 *  · 묶음이면 access token 만. 만료면 갱신하고 금고에 다시 쓴다.
 */
export async function resolveProxyBearer(
  resolved: MemberSecretResolved, authKind: string, deps: ProxyAuthDeps = {},
): Promise<string> {
  const secret = resolved.secret ?? "";
  const tokens = decodeTokenBlob(secret);
  if (!tokens) return secret; // 정적 토큰(또는 묶음으로 해석 불가) — 종전 동작 그대로
  const nowSec = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const fresh = isTokenExpired(resolved.meta, nowSec) ? await refreshBlob(resolved, authKind, tokens, deps) : tokens;
  const access = fresh.access_token;
  // 묶음으로 해석됐는데 access token 이 비어 있으면 빈 Bearer 가 나간다 — 상류는 401 로만 답하고 원인을 못 알려준다.
  if (typeof access !== "string" || !access) throw new Error(`'${authKind}' 자격에 access token 이 없습니다 — '내 자격'에서 다시 연결하세요.`);
  return access;
}

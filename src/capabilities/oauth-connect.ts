// OAuth 커넥터 연결 표면(#746 T2) — 멤버가 auth_mode='oauth' 프록시 MCP 서버에 per-user 로 1회 동의(consent)한다.
//  me_oauth_connect: 동의 개시 → authorization URL 반환(멤버가 브라우저로 오픈). 인가 후 /oauth/callback 이 토큰을 vault 저장.
//  me_oauth_disconnect: 내 토큰 삭제(연결 해제). 시크릿은 절대 응답으로 나가지 않는다(URL·플래그만).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { secretsEnabled } from "../org/credentials/secret-box.js";
import { getMcpServer, listMcpServers, listEnabledProxyTools } from "../org/store.js";
import { deleteMemberSecret, memberOwner, listMemberSecretsPublic } from "../org/credentials/member-secret-store.js";
import { startConsent } from "../org/credentials/oauth-broker.js";
import { GOOGLE_KIND, GOOGLE_SERVER, GOOGLE_LEGACY_KINDS, isGoogleServer } from "../org/credentials/google-oauth.js";
import { logger } from "../log.js";

function s(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  const t = String(v);
  if (t.length > max) throw new HttpError(400, `값이 ${max}자를 초과합니다`);
  return t;
}
async function requireOAuthServer(name: string): Promise<{ auth_kind: string; auth_scope_key: string | null }> {
  // #1881 G2 구글 직결 — org_mcp_server 행이 **없다**(인증 앵커를 Developer Preview 엔드포인트에서 뗐다).
  //  여기서 갈라 주지 않으면 연결 버튼이 404 로 죽는다(매니지드 개인 테넌트가 정확히 그 상태였다 — T10 #1993).
  if (isGoogleServer(name)) return { auth_kind: GOOGLE_KIND, auth_scope_key: "" };
  const srv = await getMcpServer(name);
  if (!srv || srv.mode !== "proxy") throw new HttpError(404, `proxy MCP 서버 없음: ${name}`);
  if (srv.auth_mode !== "oauth" || !srv.auth_kind) throw new HttpError(400, `'${name}' 은 OAuth 커넥터가 아닙니다(auth_mode=oauth 필요)`);
  return { auth_kind: srv.auth_kind, auth_scope_key: srv.auth_scope_key };
}

const meOauthConnect: Capability = {
  name: "me_oauth_connect", title: "OAuth 커넥터 연결",
  description: "auth_mode=oauth 프록시 MCP 서버에 내 계정으로 연결(동의)한다. 반환된 authorization_url 을 브라우저에서 열어 인가하면 게이트웨이 콜백이 토큰을 내 vault 에 저장한다. 이후 그 커넥터의 프록시 툴 호출 시 내 토큰이 쓰인다(자동 refresh). 이미 유효 토큰이 있으면 authorized:true.",
  scope: null, input: { server: z.string().describe("연결할 프록시 MCP 서버 이름(org_mcp_server.name, auth_mode=oauth)") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/oauth/connect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (!secretsEnabled()) throw new HttpError(400, "시크릿 암호화 키(CONNECTOR_SECRET_KEY) 미설정 — OAuth 토큰을 저장할 수 없습니다");
    const name = s((input as Record<string, unknown>)?.server);
    if (!name) throw new HttpError(400, "server 는 필수입니다");
    await requireOAuthServer(name);
    const r = await startConsent(user.userId, name, user.userId);
    if (r.authorized) return { authorized: true, message: "이미 연결되어 있습니다" };
    return { authorized: false, authorization_url: r.authorizationUrl, message: "이 URL 을 브라우저에서 열어 인가하세요 — 완료되면 자동으로 연결됩니다." };
  },
};

const meOauthDisconnect: Capability = {
  name: "me_oauth_disconnect", title: "OAuth 커넥터 연결 해제",
  description: "OAuth 커넥터에 저장된 내 토큰을 삭제한다(연결 해제). 이후 그 커넥터 호출은 다시 연결(me_oauth_connect) 전까지 실패한다.",
  scope: null, input: { server: z.string().describe("연결 해제할 프록시 MCP 서버 이름") },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/me/oauth/disconnect"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const name = s((input as Record<string, unknown>)?.server);
    if (!name) throw new HttpError(400, "server 는 필수입니다");
    const srv = await requireOAuthServer(name);
    let deleted = await deleteMemberSecret(memberOwner(user.userId), srv.auth_kind, srv.auth_scope_key ?? "");
    // 구글은 구 kind 슬롯도 함께 지운다 — 하나만 지우면 별칭 폴백으로 **연결이 계속 살아 있다**(해제가 거짓말이 된다).
    if (isGoogleServer(name)) {
      for (const k of GOOGLE_LEGACY_KINDS) {
        if (await deleteMemberSecret(memberOwner(user.userId), k, "")) deleted = true;
      }
    }
    return { disconnected: deleted };
  },
};

/**
 * 연결 대상 해소(#1656) — 축은 서버 행이 아니라 **auth_kind**(금고 슬롯 키)다.
 *
 *  왜 넓히나: 구글을 A(MCP 프록시)에서 B(http_proxy)로 내리면 MCP 서버 행은 비활성이 되는데, 그 행이 목록에서
 *   빠지는 순간 자격 화면에서 구글이 통째로 사라진다(웹은 connectors[].server 를 키로 매칭한다). 토큰은 살아
 *   있는데 아무도 연결·재연결을 못 하는 상태가 된다.
 *  그래서 판정을 '이 서버 행이 켜져 있나' 에서 **'이 auth_kind 를 실제로 쓰는 도구가 있나'** 로 바꾼다.
 *   비활성 서버라도 같은 auth_kind 를 쓰는 http_proxy 도구가 켜져 있으면 연결 대상이다.
 *
 *  ⚠ 서버 행 자체는 여전히 필요하다 — 연결 개시(startConsent)가 OAuth 디스커버리를 하려면 상류 URL 을 알아야
 *   한다. 그래서 org_tool 만 있고 대응 서버 행이 없는 auth_kind 는 **목록에 넣지 않고 경고를 남긴다**:
 *   넣으면 눌러도 아무 일이 없는 버튼이 되고, 조용히 빼면 왜 안 보이는지 아무도 모른다.
 */
export interface OAuthConnectorRow {
  server: string; auth_kind: string; auth_scope_key: string | null; note: string | null; enabled: boolean; used_by: string[];
  /** 이 kind 들의 토큰도 '연결됨'으로 친다(#1881 G2 전환기 — 구 kind 로 붙은 사람이 '연결 안 됨'으로 보이면 안 된다). */
  alias_kinds?: string[];
}
export interface ConnectorServerLike {
  name: string; mode: string; auth_mode?: string | null; auth_kind?: string | null; auth_scope_key?: string | null;
  note?: string | null; enabled?: boolean;
}
export interface ConnectorToolLike { name: string; auth_kind?: string | null }

/** 접기 규칙(순수 — 테스트가 실물 로직을 본다). orphanKinds = 도구는 쓰는데 연결 창구가 없는 자격. */
export function foldOAuthConnectors(
  servers: ConnectorServerLike[], tools: ConnectorToolLike[],
): { connectors: OAuthConnectorRow[]; orphanKinds: Array<{ auth_kind: string; tools: string[] }> } {
  const kindUsers = new Map<string, string[]>(); // auth_kind → 그 자격을 쓰는 http_proxy 도구 이름들
  for (const t of tools) {
    if (!t.auth_kind) continue;
    kindUsers.set(t.auth_kind, [...(kindUsers.get(t.auth_kind) ?? []), t.name]);
  }
  const byKind = new Map<string, OAuthConnectorRow>();
  for (const s of servers) {
    if (s.mode !== "proxy" || s.auth_mode !== "oauth" || !s.auth_kind) continue;
    const usedByTools = kindUsers.get(s.auth_kind) ?? [];
    const enabled = s.enabled !== false;
    if (!enabled && usedByTools.length === 0) continue; // 아무도 안 쓰는 비활성 커넥터 — 목록에 낼 이유가 없다
    const row: OAuthConnectorRow = {
      server: s.name, auth_kind: s.auth_kind, auth_scope_key: s.auth_scope_key ?? null, note: s.note ?? null, enabled,
      used_by: [...(enabled ? [`mcp:${s.name}`] : []), ...usedByTools.map((n) => `tool:${n}`)],
    };
    const prev = byKind.get(s.auth_kind);
    // 같은 자격을 여러 서버가 선언하면 하나로 접는다 — 켜져 있는 쪽을 대표로(연결 개시가 실제로 되는 행).
    if (!prev || (!prev.enabled && enabled)) byKind.set(s.auth_kind, row);
  }
  // ── #1881 G2 구글 — 서비스마다 한 줄(드라이브·Gmail·캘린더 ×3)이던 것을 **[Google 연결] 한 줄**로 접는다. ──
  //  이 줄은 MCP 서버 행에 기대지 않는다(직결이라 필요 없다). 그래서 서버 행이 없는 매니지드 개인 테넌트에서도
  //  창구가 선다 — 구글이 아예 안 보이던 T10(#1993) 의 나머지 절반이 여기서 풀린다.
  //  ⚠ 구 kind 는 alias_kinds 로 물고 간다: 예전에 붙은 사람이 '연결 안 됨'으로 보이면 재연결을 유도하게 되고,
  //   그게 #1652 에서 실제로 사람을 잃은 실패 모드다(토큰은 살아 있는데 화면에서 사라짐).
  const googleKinds = [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS];
  const googleTools = googleKinds.flatMap((k) => kindUsers.get(k) ?? []);
  if (googleTools.length > 0) {
    const legacyRows = GOOGLE_LEGACY_KINDS.map((k) => byKind.get(k)).filter(Boolean) as OAuthConnectorRow[];
    for (const k of googleKinds) byKind.delete(k); // 서비스별 줄을 걷어낸다(한 줄로 접히는 것이 요점)
    byKind.set(GOOGLE_KIND, {
      server: GOOGLE_SERVER, auth_kind: GOOGLE_KIND, auth_scope_key: "",
      note: legacyRows.find((r) => r.note)?.note ?? null,
      enabled: true, // 직결이라 서버 행의 enabled 와 무관하다 — 도구가 있으면 연결할 수 있다
      used_by: googleTools.map((n) => `tool:${n}`),
      alias_kinds: [...GOOGLE_LEGACY_KINDS],
    });
  }
  const orphanKinds = [...kindUsers.entries()]
    .filter(([kind]) => !byKind.has(kind) && !googleKinds.includes(kind))
    .map(([auth_kind, toolNames]) => ({ auth_kind, tools: toolNames }));
  return { connectors: [...byKind.values()], orphanKinds };
}

export async function resolveOAuthConnectors(): Promise<OAuthConnectorRow[]> {
  const [servers, tools] = await Promise.all([listMcpServers(), listEnabledProxyTools()]);
  const { connectors, orphanKinds } = foldOAuthConnectors(servers, tools);
  for (const o of orphanKinds) {
    // 도구는 이 자격을 요구하는데 연결을 개시할 창구가 없다 — 호출하면 '자격 없음'으로 죽고 사용자는 켤 방법이 없다.
    logger.warn(o, "이 자격을 쓰는 도구가 있는데 OAuth 연결 창구(프록시 MCP 서버 행)가 없습니다 — 구성원이 연결할 방법이 없습니다");
  }
  return connectors;
}

// OAuth 커넥터 목록 + 내 연결 여부 — 웹 '자격' 화면·에이전트가 무엇을 연결할지 안내. 시크릿·URL 미노출(이름·설명·연결플래그만).
const meOauthConnectors: Capability = {
  name: "me_oauth_connectors", title: "OAuth 커넥터 목록(내 연결 상태)",
  description:
    "OAuth 로 연결하는 커넥터 목록과 내 연결 여부. 프록시 MCP 서버(A)든 http_proxy 도구(B)든 **같은 자격(auth_kind)** 을 " +
    "쓰면 한 줄로 접힌다 — 어느 어댑터가 쓰는지는 used_by 로 보인다. 연결은 me_oauth_connect, 해제는 me_oauth_disconnect.",
  scope: null, input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/me/oauth/connectors"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const rows = await resolveOAuthConnectors();
    const mine = await listMemberSecretsPublic(memberOwner(user.userId)); // has_secret 플래그만(복호·last_used 부작용 없음)
    const hasSlot = (kind: string, sk: string | null) => mine.some((c) => c.kind === kind && c.scope_key === (sk ?? "") && c.has_secret);
    // 별칭 kind 의 토큰도 '연결됨'이다 — 구 방식으로 붙은 사람에게 재연결을 요구하지 않는다(#1881 G2 전환기).
    //  별칭 슬롯의 scope_key 는 그 kind 자신의 기본값("")이지 이 줄의 scope_key 가 아니다.
    const connected = (r: OAuthConnectorRow) =>
      hasSlot(r.auth_kind, r.auth_scope_key) || (r.alias_kinds ?? []).some((k) => hasSlot(k, ""));
    return {
      connectors: rows.map((r) => ({
        server: r.server, // 웹이 이 값을 키로 매칭한다 — 어댑터를 바꿔도 이름이 같으면 화면·연결이 그대로다(무중단 승계)
        note: r.note, used_by: r.used_by,
        connected: connected(r),
      })),
    };
  },
};

export const oauthConnectCapabilities: Capability[] = [meOauthConnect, meOauthDisconnect, meOauthConnectors];

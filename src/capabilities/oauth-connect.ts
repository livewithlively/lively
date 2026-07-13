// OAuth 커넥터 연결 표면(#746 T2) — 멤버가 auth_mode='oauth' 프록시 MCP 서버에 per-user 로 1회 동의(consent)한다.
//  me_oauth_connect: 동의 개시 → authorization URL 반환(멤버가 브라우저로 오픈). 인가 후 /oauth/callback 이 토큰을 vault 저장.
//  me_oauth_disconnect: 내 토큰 삭제(연결 해제). 시크릿은 절대 응답으로 나가지 않는다(URL·플래그만).
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { secretsEnabled } from "../org/secret-box.js";
import { getMcpServer, listMcpServers } from "../org/store.js";
import { deleteMemberSecret, memberOwner, listMemberSecretsPublic } from "../org/member-secret-store.js";
import { startConsent } from "../org/oauth-broker.js";

function s(v: unknown, max = 200): string {
  if (v === undefined || v === null) return "";
  const t = String(v);
  if (t.length > max) throw new HttpError(400, `값이 ${max}자를 초과합니다`);
  return t;
}
async function requireOAuthServer(name: string): Promise<{ auth_kind: string; auth_scope_key: string | null }> {
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
    const deleted = await deleteMemberSecret(memberOwner(user.userId), srv.auth_kind, srv.auth_scope_key ?? "");
    return { disconnected: deleted };
  },
};

// OAuth 커넥터 목록 + 내 연결 여부 — 웹 '자격' 화면·에이전트가 무엇을 연결할지 안내. 시크릿·URL 미노출(이름·설명·연결플래그만).
const meOauthConnectors: Capability = {
  name: "me_oauth_connectors", title: "OAuth 커넥터 목록(내 연결 상태)",
  description: "auth_mode=oauth 인 프록시 MCP 서버(커넥터) 목록과 내 연결 여부. 연결은 me_oauth_connect, 해제는 me_oauth_disconnect.",
  scope: null, input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/me/oauth/connectors"], parse: () => ({}) }] },
  handler: async (_input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const servers = (await listMcpServers()).filter((s) => s.mode === "proxy" && s.auth_mode === "oauth" && s.enabled !== false && s.auth_kind);
    const mine = await listMemberSecretsPublic(memberOwner(user.userId)); // has_secret 플래그만(복호·last_used 부작용 없음)
    const connected = (kind: string, sk: string | null) => mine.some((c) => c.kind === kind && c.scope_key === (sk ?? "") && c.has_secret);
    return { connectors: servers.map((s) => ({ server: s.name, note: s.note ?? null, connected: connected(s.auth_kind as string, s.auth_scope_key) })) };
  },
};

export const oauthConnectCapabilities: Capability[] = [meOauthConnect, meOauthDisconnect, meOauthConnectors];

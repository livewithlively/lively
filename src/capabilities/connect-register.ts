// org_connect_register — 외부 앱 «앱 등록» 값을 한 곳에서 저장(#4970). [외부 앱 연결] ▸ 그 앱 ▸ 앱 등록 칸과 연결 스킬이 함께 쓴다.
//
//  왜 따로 있나: 앱마다 저장 자리가 달랐다 — 노션·구글·리니어·아웃룩은 금고 한 줄(org_credential_set), 슬랙은 금고 + 연결 창구
//   (MCP 서버 항목 — 관리 ▸ 도구 화면의 프리셋), 깃허브는 GitHub App 다섯 값(org_github_app_register · 화면 입력칸 없음).
//   그래서 슬랙은 다른 화면에서, 깃허브는 비밀을 대화에 붙여 넣어야 했다. 이 문 하나가 앱마다 맞는 저장을 부른다.
//  새 저장을 만들지 않는다 — 기존 도구의 핸들러를 그대로 부른다(검증·감사 기록이 그쪽에 있다). 다만 직접 부르면 전송 층의
//   권한 확인(requireScope)을 건너뛰므로 여기서 같은 권한을 먼저 본다 — 화면이 사람 말로 보이게 403(HttpError)으로
//   (requireScope 는 영문 일반 오류를 던져 화면에 500 으로 갔다).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { canManageWorkspace, isAdmin } from "./principal.js";
import { APP_REGISTRATIONS } from "../org/connect-registration.js";
import { memberSecretCapabilities } from "./member-secret.js";
import { githubConnectCapabilities } from "./github-connect.js";
import { mcpServersCapabilities } from "./delivery/mcp-servers.js";
import { MCP_SERVER_PRESETS } from "../org/delivery/mcp-server-presets.js";
import { getMcpServer } from "../org/store/mcp-servers.js";
import { isSlackOAuthKind } from "../org/credentials/slack-oauth.js";

/** 앱마다 저장 자리 — 금고 kind(OAuth 클라이언트 한 줄) 또는 GitHub App. 등록 권한은 org_connect_status 의 registerBy 와 같다. */
export const REGISTER_SAVE: Readonly<Record<string, { cred?: string; slackServer?: true; github?: true; by: "admin" | "manage" }>> = Object.freeze({
  slack: { cred: "slack_oauth", slackServer: true, by: "admin" },
  notion: { cred: "notion_public", by: "admin" },
  google: { cred: "google_oauth", by: "admin" },
  linear: { cred: "linear_app", by: "admin" },
  outlook: { cred: "microsoft_oauth", by: "admin" },
  github: { github: true, by: "manage" },
});

const capOf = (caps: Capability[], name: string): Capability => {
  const c = caps.find((x) => x.name === name);
  if (!c) throw new Error(`${name} 가 없다`);
  return c;
};
//  부를 도구는 모듈을 불러올 때 찾는다 — 이름이 바뀌면 고객의 첫 [등록] 이 아니라 부팅·시험에서 깨지게.
const CRED_SET = capOf(memberSecretCapabilities, "org_credential_set");
const GITHUB_APP_REGISTER = capOf(githubConnectCapabilities, "org_github_app_register");
const MCP_UPSERT = capOf(mcpServersCapabilities, "org_mcp_upsert");

/** 슬랙 연결 창구가 [연결]을 받을 모양인가 — slackAppReady(oauth-broker)가 보는 조건 그대로(proxy · oauth · 슬랙 인증). 켜짐 여부는 보지 않는다(관문도 안 본다). */
export function slackServerUsable(srv: { mode?: string | null; auth_mode?: string | null; auth_kind?: string | null } | null): boolean {
  return !!srv && srv.mode === "proxy" && srv.auth_mode === "oauth" && isSlackOAuthKind(srv.auth_kind);
}

/** 슬랙 연결 창구(MCP 서버 항목 slack) — 관리 ▸ 도구 화면의 프리셋 «Slack» 과 같은 값. 이게 없으면 [연결] 이 «proxy MCP 서버 없음» 으로 실패한다. */
export function slackServerPayload(): Record<string, unknown> {
  const p = MCP_SERVER_PRESETS.find((x) => x.name === "slack");
  if (!p) throw new Error("슬랙 MCP 프리셋이 없다");
  return {
    name: "slack", transport: "http", url: p.url, mode: "proxy", auth_mode: "oauth", auth_kind: p.auth_kind,
    scope: p.scope, level: p.level, pii_scrub: p.pii_scrub, log_args: false, enabled: true,
  };
}

const registerInput = {
  app: z.enum(Object.keys(REGISTER_SAVE) as [string, ...string[]]).describe("등록할 앱 — slack · notion · google · linear · outlook · github"),
  values: z.record(z.string(), z.string()).describe("앱마다 넣을 값 — client_id·client_secret(깃허브는 + app_id·app_slug·private_key PEM 전문)"),
};

const orgConnectRegister: Capability = {
  name: "org_connect_register", title: "외부 앱 앱 등록 값 저장(관리자)",
  description:
    "셀프호스트에서 외부 앱의 «앱 등록» 값(OAuth 클라이언트 · GitHub App)을 금고에 저장한다 — [외부 앱 연결] ▸ 그 앱 ▸ 앱 등록 칸과 같은 저장. " +
    "app: slack(+ 슬랙 연결 창구도 함께) · notion · google · linear · outlook(관리자) · github(워크스페이스 관리, App ID·Client ID·Client secret·Private key·앱 주소 이름). " +
    "⚠ 비밀 값은 화면에서 넣게 하는 것이 원칙이다 — 대화로 받을 때는 사람에게 먼저 경고한다(연결 스킬 공통 규칙 6). 저장된 값은 다시 볼 수 없다. " +
    "REST 등가: POST /api/ui/org/connect/register {app, values}.",
  scope: "memory", input: registerInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/connect/register"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user: LivelyUser, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const i = (input ?? {}) as { app?: unknown; values?: unknown };
    const app = String(i.app ?? "");
    const save = REGISTER_SAVE[app];
    const reg = APP_REGISTRATIONS[app];
    if (!save || !reg) throw new HttpError(400, `앱 등록을 받지 않는 앱입니다: ${app}`);
    if (save.by === "admin") {
      if (!isAdmin(user)) throw new HttpError(403, "라이블리 관리자만 앱을 등록할 수 있습니다 — 관리자에게 이 화면을 열어 달라고 부탁해 주세요");
    } else if (!canManageWorkspace(user)) throw new HttpError(403, "워크스페이스 관리 권한이 있어야 앱을 등록할 수 있습니다");
    const raw = (i.values && typeof i.values === "object" ? i.values : {}) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const f of reg.fields) {
      const v = typeof raw[f.key] === "string" ? String(raw[f.key]).trim() : "";
      if (!v && !f.optional) throw new HttpError(400, `«${f.label}» 칸을 채워 주세요`);
      if (v) values[f.key] = v;
    }
    if (save.github) {
      await GITHUB_APP_REGISTER.handler(values, user, ctx);
      return { ok: true, app };
    }
    if (save.slackServer) {
      //  연결 창구가 이미 [연결]을 받을 모양이면 손대지 않는다(관리자가 고쳐 둔 범위·단계·기록 설정을 덮지 않게 — 꺼 둔 행도 그대로).
      //   없거나 모양이 틀리면(그대로면 [연결]이 «proxy MCP 서버 없음» 으로 실패한다) 프리셋 값으로 만든다.
      const have = await getMcpServer("slack").catch(() => null);
      if (!slackServerUsable(have)) await MCP_UPSERT.handler(slackServerPayload(), user, ctx);
    }
    await CRED_SET.handler({
      kind: save.cred, scope_key: "oauth:client",
      secret: JSON.stringify({ client_id: values.client_id, client_secret: values.client_secret }),
    }, user, ctx);
    return { ok: true, app };
  },
};

export const connectRegisterCapabilities: Capability[] = [orgConnectRegister];

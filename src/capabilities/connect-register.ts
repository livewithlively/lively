// org_connect_register — 외부 앱 «앱 등록» 값을 한 곳에서 저장(#4970). [외부 앱 연결] ▸ 그 앱 ▸ 앱 등록 칸과 연결 스킬이 함께 쓴다.
//
//  왜 따로 있나: 앱마다 저장 자리가 달랐다 — 노션·구글·리니어·아웃룩은 금고 한 줄(org_credential_set), 슬랙은 금고 + 연결 창구
//   (MCP 서버 항목 — 관리 ▸ 도구 화면의 프리셋), 깃허브는 GitHub App 다섯 값(org_github_app_register · 화면 입력칸 없음).
//   그래서 슬랙은 다른 화면에서, 깃허브는 비밀을 대화에 붙여 넣어야 했다. 이 문 하나가 앱마다 맞는 저장을 부른다.
//  새 저장을 만들지 않는다 — 기존 도구의 핸들러를 그대로 부른다(검증·감사 기록이 그쪽에 있다). 다만 직접 부르면 전송 층의
//   권한 확인(requireScope)을 건너뛰므로 여기서 같은 권한을 먼저 본다 — 화면이 사람 말로 보이게 403(HttpError)으로
//   (requireScope 는 영문 일반 오류를 던져 화면에 500 으로 갔다).
//  (#4991) 등록한 뒤의 길도 여기 있다 — org_connect_registration(지금 등록 · 바꾸거나 지우면 끊기는 것) · org_connect_unregister(지우기).
//   바꾸기는 위 등록 문 그대로다(덮어쓴다). 등록 칸이 «등록 전에만» 보여 Client ID 를 다른 앱으로 바꿀 길이 없었다(위시스트 2026-10-25).
//   셀프호스트 전용이다 — 매니지드는 라이블리 클라우드가 앱을 쥐어 이 서버에 바꾸거나 지울 등록이 없다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { canManageWorkspace, isAdmin } from "./principal.js";
import { APP_REGISTRATIONS, registrationView } from "../org/connect-registration.js";
import { APP_LINKS, REGISTRATION_SLOTS, memberLinks, registrationImpact, relayHeld, type RegistrationLinks, type VaultSlot } from "../org/connect-unregister.js";
import { memberSecretCapabilities } from "./member-secret.js";
import { githubConnectCapabilities } from "./github-connect.js";
import { mcpServersCapabilities } from "./delivery/mcp-servers.js";
import { MCP_SERVER_PRESETS } from "../org/delivery/mcp-server-presets.js";
import { getMcpServer } from "../org/store/mcp-servers.js";
import { isSlackOAuthKind } from "../org/credentials/slack-oauth.js";
import {
  GATEWAY_OWNER, deleteMemberSecret, getMemberSecret, getMemberSecretPublic, listSecretsByKindPublic, type MemberSecretPublic,
} from "../org/credentials/member-secret-store.js";
import { isGithubAppToken } from "../org/credentials/github-token-source.js";
import { GITHUB_APP_KIND, GITHUB_APP_KEY_SCOPE } from "../org/credentials/github-app.js";
import { envGoogleOAuthClient } from "../org/credentials/google-token-source.js";
import { envMicrosoftOAuthClient } from "../org/credentials/microsoft-oauth.js";
import { githubAppReady, googleReady, linearAppReady, microsoftReady, notionPublicReady, slackAppReady } from "../org/credentials/oauth-broker.js";
import { connectVariant } from "../org/delivery/connect-skills.js";
import { CONNECT_APPS, routeFactsOf } from "./connect-status.js";
import { getOrgProfile } from "../org/store.js";
import { logger } from "../log.js";

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

/** 등록·보기·지우기 권한은 하나다 — org_connect_status 의 registerBy(admin · 깃허브만 manage)와 같다. 화면이 사람 말로 보이게 403. */
function assertCanRegister(user: LivelyUser, save: { by: "admin" | "manage" }, verb: string): void {
  if (save.by === "admin") {
    if (!isAdmin(user)) throw new HttpError(403, `라이블리 관리자만 ${verb} 수 있습니다 — 관리자에게 이 화면을 열어 달라고 부탁해 주세요`);
  } else if (!canManageWorkspace(user)) throw new HttpError(403, `워크스페이스 관리 권한이 있어야 ${verb} 수 있습니다`);
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
    assertCanRegister(user, save, "앱을 등록할");
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
      //  읽기 실패는 그대로 올린다 — «없음» 으로 읽으면 관리자가 손본 창구를 프리셋으로 덮는다.
      const have = await getMcpServer("slack");
      if (!slackServerUsable(have)) await MCP_UPSERT.handler(slackServerPayload(), user, ctx);
    }
    await CRED_SET.handler({
      kind: save.cred, scope_key: "oauth:client",
      secret: JSON.stringify({ client_id: values.client_id, client_secret: values.client_secret }),
    }, user, ctx);
    return { ok: true, app };
  },
};

// ══ (#4991) 등록한 뒤 — 보기 · 지우기 ══════════════════════════════════════════════════════════════

/** 앱마다 준비 판정 — 지운 뒤 «등록 칸이 다시 열리나» 를 같은 판정으로 잰다(org_connect_status 의 app_ready 와 같은 함수). */
const APP_READY: Readonly<Record<string, () => Promise<boolean>>> = {
  slack: slackAppReady, notion: notionPublicReady, google: googleReady, linear: linearAppReady, outlook: microsoftReady, github: githubAppReady,
};

/** 금고 값을 지운 뒤에도 서버 설정(환경 변수)의 앱으로 연결하는가 — 직결 모드의 해소 순서가 금고 → 서버 설정인 앱(구글·아웃룩). */
function envFallbackOf(app: string): boolean {
  if (app === "google") return !!envGoogleOAuthClient();
  if (app === "outlook") return !!envMicrosoftOAuthClient();
  return false;
}

export interface CurrentRegistration {
  /** 등록 값이 어디서 오나 — vault(이 화면·대화로 넣은 값) · env(서버 설정) · relay(라이블리 클라우드) · null(없음). */
  source: "vault" | "env" | "relay" | null;
  /** 금고 값이면 그 칸 — 비밀은 싣지 않는다(Client ID 는 연결 화면 주소에 늘 실리는 공개 값이다). */
  client_id: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  private_key?: boolean;
  updated_at: string | null;
}

/** 지금 등록 — 앱 준비 판정이 읽는 순서 그대로(릴레이 → 금고 칸 순서 → 서버 설정). */
async function currentRegistration(app: string): Promise<CurrentRegistration> {
  const none: CurrentRegistration = { source: null, client_id: null, updated_at: null };
  if (relayHeld(app)) return { ...none, source: "relay" };
  let hit: { slot: VaultSlot; row: MemberSecretPublic } | null = null;
  for (const slot of REGISTRATION_SLOTS[app] ?? []) {
    const row = await getMemberSecretPublic(GATEWAY_OWNER, slot.kind, slot.scope_key);
    if (row?.has_secret) { hit = { slot, row }; break; }
  }
  if (!hit) return envFallbackOf(app) ? { ...none, source: "env" } : none;
  let clientId: string | null = null;
  try {
    const j = JSON.parse((await getMemberSecret(GATEWAY_OWNER, hit.slot.kind, hit.slot.scope_key))?.secret ?? "") as { client_id?: unknown };
    clientId = typeof j.client_id === "string" && j.client_id ? j.client_id : null;
  } catch { clientId = null; }   // 깃허브 키 칸만 남은 경우 등 — 묶음이 아니면 Client ID 를 말하지 않는다
  const out: CurrentRegistration = { source: "vault", client_id: clientId, updated_at: hit.row.updated_at };
  if (app === "github") {
    //  App ID 는 client 칸과 키 칸 meta 에 함께 적힌다(saveGithubAppCredentials) — 어느 칸이 남았든 읽힌다. 앱 주소 이름은 client 칸에만.
    const meta = hit.row.meta ?? {};
    out.app_id = typeof meta.app_id === "string" ? meta.app_id : null;
    out.app_slug = typeof meta.app_slug === "string" ? meta.app_slug : null;
    out.private_key = !!(await getMemberSecretPublic(GATEWAY_OWNER, GITHUB_APP_KIND, GITHUB_APP_KEY_SCOPE))?.has_secret;
  }
  return out;
}

/** 이 앱 등록으로 이어진 연결 — 구성원 칸 · 조직 칸(워크스페이스·봇·설치) · 지금 모으는가. 모으는가는 org_connect_status 와 같은 판정이다. */
async function registrationLinks(app: string, user: LivelyUser): Promise<RegistrationLinks> {
  const spec = APP_LINKS[app]!;
  const memberRows = (await Promise.all(spec.memberKinds.map((k) => listSecretsByKindPublic(k)))).flat()
    //  깃허브 칸(github_pat)에는 붙여 넣은 개인 토큰도 산다 — 그건 앱 등록과 무관하다.
    .filter((r) => app !== "github" || isGithubAppToken(r));
  const place = spec.place;
  const places = place
    ? (await listSecretsByKindPublic(place.kind)).filter((r) => r.owner === GATEWAY_OWNER && r.has_secret).map((r) => ({
      id: r.scope_key, name: place.nameKey && typeof r.meta[place.nameKey] === "string" ? String(r.meta[place.nameKey]) : null,
    }))
    : [];
  let collecting = false;
  const status = CONNECT_APPS.find((a) => a.app === app);
  if (status) {
    //  못 재면 «모으는 중» 이라 말하지 않는다(그 한 줄을 빼는 쪽 — 거짓 경고를 만들지 않는다).
    const p = await status.probe(user).catch(() => null);
    if (p) collecting = !!routeFactsOf(status, p, { heldBy: "workspace", canRegister: true, canCollect: true, aiPolicy: "unknown", aiMine: null }).app?.collecting;
  }
  return { members: memberLinks(memberRows), places, collecting, envFallback: envFallbackOf(app) };
}

const appInput = { app: z.enum(Object.keys(REGISTER_SAVE) as [string, ...string[]]).describe("앱 — slack · notion · google · linear · outlook · github") };

/** 보기·지우기 공통 관문 — 앱 · 신원 · 권한 · 배포(매니지드는 라이블리가 앱을 쥔다). */
function gate(input: unknown, user: LivelyUser, verb: string): { app: string; label: string } {
  if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
  const app = String((input as { app?: unknown } | undefined)?.app ?? "");
  const save = REGISTER_SAVE[app];
  if (!save || !REGISTRATION_SLOTS[app]) throw new HttpError(400, `앱 등록이 없는 앱입니다: ${app}`);
  assertCanRegister(user, save, verb);
  if (connectVariant() === "managed") throw new HttpError(409, "이 워크스페이스는 라이블리가 앱을 쥐고 있어요 — 바꾸거나 지울 앱 등록이 없습니다");
  return { app, label: CONNECT_APPS.find((a) => a.app === app)?.label ?? app };
}

const orgConnectRegistration: Capability = {
  name: "org_connect_registration", title: "외부 앱 앱 등록 보기(관리자)",
  description:
    "셀프호스트에서 등록해 둔 외부 앱 «앱 등록» 을 본다 — current{source(vault=화면·대화로 넣은 값 · env=서버 설정 · relay=라이블리 클라우드 · null=없음) · " +
    "client_id(공개 값) · 깃허브는 app_id·app_slug·private_key 유무 · updated_at} · impact{replace(다른 앱으로 바꾸면 끊기는 것 — 같은 앱의 값만 새로 넣으면 연결은 그대로) · " +
    "remove(지우면 끊기는 것)} · registration(바꿀 때 쓸 걸음·칸 — org_connect_status 의 registration 과 같은 모양). 비밀 값은 돌려주지 않는다. " +
    "바꾸기는 org_connect_register(덮어쓴다), 지우기는 org_connect_unregister — 둘 다 그 전에 impact 를 사람에게 그대로 말한다. " +
    "매니지드는 라이블리가 앱을 쥐어 409. REST 등가: GET /api/ui/org/connect/registration?app=",
  scope: "memory", input: appInput,
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/org/connect/registration"], parse: (req) => ({ app: req.query?.app }) }] },
  handler: async (input, user: LivelyUser) => {
    const { app, label } = gate(input, user, "앱 등록을 볼");
    const [current, links, profileUrl] = await Promise.all([
      currentRegistration(app), registrationLinks(app, user),
      getOrgProfile().then((p) => p.gateway_url ?? null).catch(() => null),
    ]);
    //  돌아올 주소는 org_connect_status 와 같은 규칙 — org_profile.gateway_url 만 본다(서버가 redirect_uri 로 실제 쓰는 값).
    let callbackUrl: string | null = null;
    try { callbackUrl = profileUrl ? new URL("/oauth/callback", profileUrl).toString() : null; } catch { callbackUrl = null; }
    return {
      app, label, current,
      impact: registrationImpact(app, label, links),
      registration: registrationView(app, { callbackUrl, gatewayUrl: profileUrl }),
    };
  },
};

const orgConnectUnregister: Capability = {
  name: "org_connect_unregister", title: "외부 앱 앱 등록 지우기(관리자)",
  description:
    "셀프호스트에서 등록해 둔 외부 앱 «앱 등록» 값을 금고에서 지운다(그 앱의 준비 판정이 읽는 칸 전부 — 구글 옛 칸 · 깃허브 앱 키 포함). " +
    "그 뒤로는 아무도 새로 연결하거나 다시 연결할 수 없고, [외부 앱 연결] 의 등록 칸이 다시 열린다. 이미 된 연결·수집기·모은 자료는 지우지 않는다. " +
    "⚠ 부르기 전에 org_connect_registration 의 impact.remove 를 사람에게 그대로 말하고 확인을 받는다. 매니지드는 409. " +
    "응답 deleted(지운 칸 수 — 0 이면 지울 것이 없었다) · app_ready(지운 뒤에도 준비면 서버 설정의 앱이 남았다). REST 등가: POST /api/ui/org/connect/unregister {app}.",
  scope: "memory", input: appInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/org/connect/unregister"], parse: (req) => req.body ?? {} }] },
  handler: async (input, user: LivelyUser) => {
    const { app } = gate(input, user, "앱 등록을 지울");
    if (relayHeld(app)) throw new HttpError(409, "이 앱은 라이블리 클라우드로 연결해요 — 이 서버에는 지울 앱 등록이 없습니다");
    let deleted = 0;
    for (const s of REGISTRATION_SLOTS[app]!) if (await deleteMemberSecret(GATEWAY_OWNER, s.kind, s.scope_key)) deleted++;
    const appReady = await APP_READY[app]!().catch(() => false);
    logger.info({ app, deleted, app_ready: appReady, actor: user.userId }, "외부 앱 앱 등록 지움(#4991)");
    return { ok: true, app, deleted, app_ready: appReady };
  },
};

export const connectRegisterCapabilities: Capability[] = [orgConnectRegister, orgConnectRegistration, orgConnectUnregister];

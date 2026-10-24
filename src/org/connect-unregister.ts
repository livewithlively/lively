// 외부 앱 «앱 등록» 바꾸기·지우기 — 지울 금고 칸과, 바꾸거나 지우면 끊기는 것(#4991). 순수.
//
//  왜 따로 있나: 앱 등록 칸(connect-registration.ts · 화면 registrationPanel)은 «등록 전에만» 보였다 — 셀프호스트 관리자가
//   Client ID 를 다른 계정의 앱으로 바꾸려 해도 화면에 길이 없었다(2026-10-25 위시스트: 관리자 API org_credential_delete 로
//   지워 등록 칸을 되살렸다). 관리 화면 자격 금고도 앱 등록 행(oauth:client)을 숨겨 거기서도 못 지운다(member-secret-store HIDDEN_SCOPE_KEYS).
//  지울 칸은 앱마다 다르다 — 등록 문(org_connect_register)이 쓰는 칸과 그 앱의 준비 판정(*Ready)이 읽는 칸 전부다.
//   하나라도 남기면 «지웠는데 여전히 등록됨» 이 된다(구글은 옛 kind 의 client 도 읽는다 — google-token-source GOOGLE_CLIENT_KINDS ·
//   깃허브는 앱 키가 다른 행이다 — oauth-broker saveGithubAppCredentials).
//  끊기는 것은 화면(확인 창)과 연결 스킬(AI)이 같은 말로 먼저 말한다 — 그 말을 여기 한 곳에서 만든다(registrationImpact).
//   근거는 코드의 사실 하나다: 기한이 있는 연결은 기한을 늘릴 때 그 앱의 등록 값을 쓴다(oauth-proxy-auth refreshBlob ·
//   oauth-broker ensureGoogleAccessToken). 기한이 없는 연결(슬랙 — 토큰 회전 off)과 노션 워크스페이스(갱신 호출부 없음)는
//   등록 값 없이 계속 쓰이고, 깃허브 저장소 가져오기는 쓸 때마다 앱 키로 자격을 찍는다(github-app-git githubAppGitSecret).
import { CLIENT_SCOPE } from "./credentials/member-secret-store.js";
import { NOTION_PUBLIC_KIND } from "./credentials/notion-oauth.js";
import { GOOGLE_KIND, GOOGLE_LEGACY_KINDS } from "./credentials/google-oauth.js";
import { LINEAR_APP_KIND } from "./credentials/linear-oauth.js";
import { MICROSOFT_KIND } from "./credentials/microsoft-oauth.js";
import { GITHUB_APP_KIND, GITHUB_APP_KEY_SCOPE, GITHUB_INSTALL_KIND } from "./credentials/github-app.js";
import { SLACK_BOT_KIND } from "./credentials/slack-oauth.js";

export interface VaultSlot { kind: string; scope_key: string }

/** 앱 등록이 사는 조직 칸(owner=gateway) — [등록 지우기] 가 지우는 전부. 맨 앞 칸이 등록 문이 쓰는 칸이다(지금 값을 읽는 자리). */
export const REGISTRATION_SLOTS: Readonly<Record<string, readonly VaultSlot[]>> = Object.freeze({
  slack: [{ kind: "slack_oauth", scope_key: CLIENT_SCOPE }],
  notion: [{ kind: NOTION_PUBLIC_KIND, scope_key: CLIENT_SCOPE }],
  google: [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS].map((kind) => ({ kind, scope_key: CLIENT_SCOPE })),
  linear: [{ kind: LINEAR_APP_KIND, scope_key: CLIENT_SCOPE }],
  outlook: [{ kind: MICROSOFT_KIND, scope_key: CLIENT_SCOPE }],
  github: [{ kind: GITHUB_APP_KIND, scope_key: CLIENT_SCOPE }, { kind: GITHUB_APP_KIND, scope_key: GITHUB_APP_KEY_SCOPE }],
});

/** 그 앱 등록으로 이어진 조직 단위의 자리 — 노션 워크스페이스 · 슬랙 봇(팀) · 깃허브 설치. */
export type PlaceKind = "notion_workspace" | "slack_bot" | "github_install";

/**
 * 그 앱 등록으로 이어진 연결이 사는 칸.
 *  memberKinds = 구성원이 [연결]로 저장한 토큰 kind(owner=member:*) · place = 조직 칸(owner=gateway)의 자리와 이름 meta 키.
 *  깃허브 칸(github_pat)에는 붙여 넣은 개인 토큰도 산다 — 앱으로 받은 묶음만 센다(호출자가 isGithubAppToken 으로 거른다).
 */
export const APP_LINKS: Readonly<Record<string, { memberKinds: readonly string[]; place?: { kind: string; what: PlaceKind; nameKey?: string } }>> = Object.freeze({
  slack: { memberKinds: ["slack_oauth"], place: { kind: SLACK_BOT_KIND, what: "slack_bot", nameKey: "team_name" } },
  notion: { memberKinds: [], place: { kind: NOTION_PUBLIC_KIND, what: "notion_workspace", nameKey: "workspace_name" } },
  google: { memberKinds: [GOOGLE_KIND, ...GOOGLE_LEGACY_KINDS] },
  linear: { memberKinds: [LINEAR_APP_KIND] },
  outlook: { memberKinds: [MICROSOFT_KIND] },
  github: { memberKinds: ["github_pat"], place: { kind: GITHUB_INSTALL_KIND, what: "github_install" } },
});

/** 이 배포가 그 앱을 릴레이(라이블리 클라우드가 쥔 앱)로 잇는가 — 그러면 이 서버에는 바꾸거나 지울 등록이 없다(oauth-broker *Ready 의 첫 줄). */
export const RELAY_ENV: Readonly<Record<string, string>> = Object.freeze({
  slack: "SLACK_OAUTH_RELAY_URL", notion: "NOTION_OAUTH_RELAY_URL", google: "GOOGLE_OAUTH_RELAY_URL",
  linear: "LINEAR_OAUTH_RELAY_URL", outlook: "MICROSOFT_OAUTH_RELAY_URL", github: "GITHUB_OAUTH_RELAY_URL",
});
export function relayHeld(app: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const k = RELAY_ENV[app];
  return !!(k && env[k]?.trim());
}

/**
 * 등록한 뒤의 «앱 등록 보기 · 바꾸기 · 지우기» 를 이 사람에게 보이나(org_connect_status can_edit_registration).
 *  회사가 앱을 쥐는 배포(셀프호스트)에서 · 등록할 수 있는 사람에게 · 앱이 준비됐을 때(미준비면 등록 칸이 대신 선다) ·
 *  이 서버가 그 앱을 쥘 때(릴레이 아님)만. 매니지드는 라이블리 클라우드가 앱을 쥐어 늘 false 다.
 */
export function registrationEditable(
  f: { app: string; heldBy: "lively" | "workspace"; canRegister: boolean; appReady: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return f.heldBy === "workspace" && f.canRegister && f.appReady && !!REGISTRATION_SLOTS[f.app] && !relayHeld(f.app, env);
}

interface SlotRow { owner: string; has_secret: boolean; meta: Record<string, unknown> | null }

/** 기한이 있는 연결인가 — 묶음을 저장할 때 tokenMeta 가 expires_at 을 적는다(기한을 늘릴 때 앱 등록 값이 든다). */
export function expiringRow(row: Pick<SlotRow, "meta">): boolean {
  const v = (row.meta ?? {}).expires_at;
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
}

/** 구성원 연결 수 — 사람 단위(한 사람이 칸 여럿이어도 한 명). 그 사람의 칸 중 하나라도 기한이 있으면 «기한 있음» 으로 센다. */
export function memberLinks(rows: ReadonlyArray<SlotRow>): { total: number; expiring: number } {
  const byOwner = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.has_secret || !String(r.owner).startsWith("member:")) continue;
    byOwner.set(r.owner, (byOwner.get(r.owner) ?? false) || expiringRow(r));
  }
  return { total: byOwner.size, expiring: [...byOwner.values()].filter(Boolean).length };
}

export interface RegistrationLinks {
  /** 이 앱 등록으로 연결한 구성원 — 그중 기한이 있는 연결. */
  members: { total: number; expiring: number };
  /** 조직 단위로 붙은 곳(노션 워크스페이스 · 슬랙 봇 · 깃허브 설치). */
  places: Array<{ id: string; name: string | null }>;
  /** 이 앱의 라이블리 앱 길로 지금 모으고 있나(org_connect_status 의 그 판정). */
  collecting: boolean;
  /** 지운 뒤에도 서버 설정(환경 변수)의 앱 값으로 연결하는가(구글·아웃룩 직결 — 금고 다음 순서). */
  envFallback: boolean;
}

function placeNames(places: RegistrationLinks["places"]): string {
  const names = places.map((p) => (p.name && p.name.trim()) || p.id.slice(0, 8));
  return names.slice(0, 3).join(", ") + (names.length > 3 ? ` 외 ${names.length - 3}곳` : "");
}

/**
 * 바꾸거나 지우면 어떻게 되나 — 사람에게 먼저 할 말. 화면 확인 창과 연결 스킬이 이 문장을 그대로 쓴다.
 *  replace = **다른 앱**으로 바꿀 때(같은 앱의 값만 새로 넣으면 이미 된 연결은 그대로다 — 그 말은 읽는 쪽이 앞에 붙인다).
 *  remove = 지울 때.
 */
export function registrationImpact(app: string, label: string, l: RegistrationLinks): { replace: string[]; remove: string[] } {
  const what = APP_LINKS[app]?.place?.what ?? null;
  const n = l.places.length;
  const e = l.members.expiring;
  const k = Math.max(0, l.members.total - e);
  const replace: string[] = ["그 뒤로 연결하는 사람은 새 앱으로 연결돼요."];
  const remove: string[] = [];
  if (l.envFallback) {
    remove.push("서버 설정(환경 변수)에도 이 앱의 값이 있어서, 지운 뒤에는 그 값으로 연결해요 — 여기서 지우는 것은 이 화면에서 넣은 값뿐이에요.");
    if (e) remove.push(`구성원 ${e}명의 연결은 이 화면에서 넣은 앱으로 받은 것이에요 — 서버 설정의 앱이 다른 앱이면 기한이 지나면 끊겨요.`);
  } else {
    remove.push("아무도 새로 연결하거나 다시 연결할 수 없어요 — 앱을 다시 등록하면 다시 할 수 있어요.");
    if (e) remove.push(`구성원 ${e}명의 연결은 기한이 지나면 끊겨요 — 라이블리가 이 앱의 값으로 연결 기한을 늘려 왔는데, 지우면 더 늘릴 수 없어요.`);
    if (k) remove.push(`구성원 ${k}명의 연결은 그대로 쓰여요 — ${label}에서 이 앱을 지우면 그때 끊겨요.`);
  }
  if (e) replace.push(`구성원 ${e}명의 연결은 기한이 지나면 끊겨요 — 새 앱으로 다시 연결해야 해요.`);
  if (k) replace.push(`구성원 ${k}명의 연결은 옛 앱으로 계속 쓰여요 — 새 앱으로 옮기려면 각자 연결을 지우고 다시 연결해야 해요.`);
  if (n && what === "notion_workspace") {
    remove.push(`노션 워크스페이스 ${n}곳(${placeNames(l.places)})의 연결은 그대로예요 — 노션에서 이 통합을 지우면 그때 끊겨요. 한 곳씩 끊으려면 «자료 가져오기» 칸의 [연결 끊기]를 쓰세요.`);
    replace.push(`노션 워크스페이스 ${n}곳(${placeNames(l.places)})은 옛 통합으로 계속 이어져요 — 새 통합으로 옮기려면 «자료 가져오기» 칸의 [페이지 더 고르기]로 같은 워크스페이스를 다시 고르세요.`);
  }
  if (n && what === "slack_bot") {
    remove.push(`슬랙 봇(워크스페이스 ${n}곳)은 그대로예요 — 슬랙에서 이 앱을 지우면 그때 끊겨요.`);
    replace.push(`슬랙 봇(워크스페이스 ${n}곳)은 옛 앱으로 계속 이어져요 — 새 앱의 봇은 누군가 슬랙 연결을 지우고 다시 연결할 때 설치돼요.`);
  }
  if (n && what === "github_install") {
    if (!l.envFallback) remove.push(`앱으로 저장소 코드를 가져오는 자격(설치 ${n}곳)은 바로 끊겨요 — 그 자격을 이 앱의 키로 그때그때 만들어요.`);
    replace.push(`앱으로 저장소 코드를 가져오는 자격(설치 ${n}곳)이 끊겨요 — 새 앱을 깃허브에 다시 설치해야 해요.`);
  }
  if (l.collecting && e) {
    const stop = "이 앱의 연결로 모으던 자료 가져오기는 연결이 끊기면 함께 멈춰요 — 이미 모은 자료는 남아요.";
    if (!l.envFallback) remove.push(stop);
    replace.push(stop);
  }
  if (!l.members.total && !n) remove.push("이 앱으로 연결된 것은 아직 없어요.");
  return { replace, remove };
}

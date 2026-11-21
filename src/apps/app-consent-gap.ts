// 동의가 앱의 지금 선언을 덮나(#1644) — DB 를 읽는 쪽. 판정 자체는 grant.ts 의 순수 함수(grantableOf · grantGap · needsRegrant · scopeNeedsRegrant).
//
//  왜: 앱 판이 권한을 넓히면(예 permissions.ai_runs · scopes 에 db) 그 전에 동의한 사람의 동의에는 새 권한이 없다. 그 사람으로 도는 앱은
//   ① 새 도구 · scope 를 부르는 순간 «권한 밖» 으로 막히고 앱은 그 까닭을 사람에게 전할 길이 없거나(앱 서버 · 앱 화면),
//   ② 작업 AI 안에서 새 기능만 조용히 빠진다(작업 토큰 = 그 사람 ∩ 그 사람의 동의 — 막힌 까닭은 작업 AI 에게만 보인다).
//  그래서 두 종류의 자리가 같은 판정을 쓴다:
//   · 막힌 자리 — 앱 주체가 도구 · scope 에서 거절됐는데 그것이 «앱이 선언했고 동의엔 없는 것» 이면 «다시 동의» 거절(403 · consent_required · 동의할 곳).
//     principal.requireAppTool · web.ts 능력 REST 의 scope 문 · capabilities/app-tool-call runAppTool(앱 화면 다리).
//   · 사람 대신 앱 일을 시작하는 자리 — 앱 코드 · 작업 AI 가 무엇을 부를지 미리 알 수 없으니 «선언 전체를 덮나» 로 보고, 덮지 못하면 시작하지 않는다.
//     mcp/app-declared-tools(앱 선언 MCP 도구) · org/slack-bridge/manager(슬랙 다리) · ai-runs/service(작업 컨테이너 AI 실행).
//  동의 창은 늘 선언 전체로 동의하므로(web/v2/app-session ensureAppGrant) 한 번 다시 동의하면 풀린다 — 구성원에게 없는 scope 는 다시 동의해도
//   못 얻으니 묻지 않는다(grant.ts scopeNeedsRegrant). 다시 동의(me_app_grant)는 그 사람이 보는 판의 선언으로 동의를 다시 쓴다.
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { isScope } from "../auth/scopes.js";
import { getApp, getActiveGrant, type AppGrantRow, type OrgApp } from "../org/store/apps.js";
import { getMember } from "../org/store/members.js";
import { gatewayUrl } from "../gateway-url.js";
import { viewAppFor } from "./app-view.js";
import { addressVariantFor, type Viewer } from "./visibility.js";
import { appConsentUrl } from "./app-mcp-decl.js";
import { CONSENT_REQUIRED } from "./app-consent.js";
import { isAppScreenSource } from "./app-screen-sources.js";
import {
  grantableOf, grantGap, grantGapEmpty, intersectGrantable, needsRegrant, regrantMessage, regrantScopePhrase, regrantToolPhrase, scopeNeedsRegrant,
  type GrantGap, type ResolvedGrant,
} from "./grant.js";

/** 이 사람의 이 앱 동의를 그 판의 지금 선언과 견준 결과. */
export interface ConsentCoverage {
  grant: AppGrantRow;
  /** 그 사람(구성원)이 가진 scope — 다시 동의해서 앱이 얻을 수 있는 상한. */
  memberScopes: string[];
  /** 동의가 덮어야 할 것 — 그 판의 선언 중 다시 동의로 얻을 수 있는 것(주소의 판과 그 사람이 보는 판이 다르면 둘 다에 있는 것). */
  declared: ResolvedGrant;
  /** 덮지 못한 것(구성원에게 없는 scope 는 뺀다). 비면 덮는다. */
  gap: GrantGap;
  /** 견준 판의 앱(이름표 · 판 칸은 그 판의 것). */
  app: OrgApp;
  /** 동의 자리에 실을 판 이름 — 주소를 준 호출은 그 주소, 아니면 그 사람에게 고를 주소(addressVariantFor). */
  variant: "pub" | "draft";
}

/**
 * 이 사람의 이 앱 동의를 그 판의 지금 선언과 견준다. 판정할 수 없으면 null — 활성 구성원 아님 · 앱 없음 · 그 사람이 못 보는 판 ·
 *  동의 없음(«동의 없음» 은 부르는 쪽이 따로 말한다) · 이 코어가 못 읽는 매니페스트(다시 동의도 같은 파서로 막힌다 — grantableOf).
 *  판: address 를 주면 그 주소의 판(앱 서버 · 앱 주소로 도는 주체 — 서버 코드가 도는 판), 아니면 그 사람이 보는 판.
 *   다시 동의(me_app_grant)는 그 사람이 보는 판의 선언으로 쓰이므로, 두 판이 다르면(공개 앱의 초안을 고친 사람이 공개 주소로 열 때) 다시 동의로
 *   얻을 수 있는 것만 «덮어야 할 것» 으로 센다 — 다시 동의해도 안 풀리는 «다시 동의» 안내를 내지 않게.
 *  installed — 부르는 쪽이 이미 읽은 앱 행(다시 읽지 않는다).
 */
export async function consentCoverage(appId: string, memberId: string, o: { address?: "pub" | "draft"; installed?: OrgApp | null } = {}): Promise<ConsentCoverage | null> {
  const member = await getMember(memberId);
  if (!member || member.state !== "active") return null;
  const installed = o.installed !== undefined ? o.installed : await getApp(appId);
  if (!installed || installed.id !== appId) return null;
  const memberScopes = (Array.isArray(member.scopes) ? member.scopes : []).filter(isScope);
  const mine: Viewer = { userId: member.id, scopes: member.scopes ?? [] };
  const seen = await viewAppFor(installed, o.address ? { ...mine, address: o.address } : mine);
  if (seen.view === "none") return null;
  const grant = await getActiveGrant(appId, member.id);
  if (!grant) return null;
  let declared = grantableOf(seen.app.manifest);
  if (!declared) return null;
  if (o.address) {
    const own = await viewAppFor(installed, mine);
    const regrantable = own.view === "none" ? null : grantableOf(own.app.manifest);
    if (!regrantable) return null;
    declared = intersectGrantable(declared, regrantable);
  }
  return { grant, memberScopes, declared, gap: grantGap(grant, declared, memberScopes), app: seen.app, variant: o.address ?? addressVariantFor(installed, mine) };
}

/**
 * 이 호출이 앱 화면에서 왔나 — 동의 자리 꼴을 고른다(동의 뒤 앱 주소로 돌아가나 · «하던 곳으로 돌아가» 를 말하나). 권한 판정에는 쓰지 않는다(겉모양뿐).
 *  · 앱 주소 앞단이 서명한 사람 신원으로 온 앱 서버 호출(#4483 — 주소의 판을 단다). 앱 서버 급 토큰(#4891 작업 AI)엔 주소가 없고, 도구 부르기 · 작업은 번호를 단다.
 *  · 앱 화면(app-ui · app-front)이나 그 화면의 앱 서버 코드(app-server — 사람 신원으로 온 앱 서버가 시작한 작업)가 시작한 작업.
 *  그 밖(앱 선언 MCP 도구 부르기 · AI 대화창 · 작업 AI · 슬랙 · 작업 안의 작업)은 앱 화면이 아니다.
 */
export async function calledFromAppScreen(user: LivelyUser, jobSource?: (id: number) => Promise<string | null>): Promise<boolean> {
  if (!user.appServer || user.appCallId != null) return false;
  if (user.appJobId != null) {
    const read = jobSource ?? (async (id: number) => (await (await import("./app-jobs-store.js")).getAppJob(id))?.source ?? null);
    const src = await read(user.appJobId).catch(() => null);
    return isAppScreenSource(src) || src === "app-server";
  }
  return user.appAddress != null;
}

/**
 * 앱 주체에게 줄 동의할 곳 — 라이블리 화면의 동의 자리(`#/app-grant/<앱>?v=<판>`). 공개 주소(org 프로필 gateway_url > PUBLIC_URL)를 모르면 null.
 *  앱 화면에서 온 호출이면 동의 뒤 그 앱 주소로 돌아가는 꼴(from 없음), 그 밖은 from=mcp(돌아가지 않고 «하던 곳으로 돌아가 다시 해 달라» 를 말한다).
 */
export async function consentUrlForPrincipal(user: LivelyUser, appId: string, variant: "pub" | "draft"): Promise<string | null> {
  const base = await gatewayUrl().catch(() => null);
  if (!base) return null;
  return appConsentUrl(base, appId, variant, (await calledFromAppScreen(user)) ? null : "mcp");
}

/**
 * 막힌 자리 — 앱 주체(user.appId)가 도구 · scope 에서 거절됐을 때, 그것이 앱이 지금 선언했는데 동의엔 없는 것(동의가 예전 범위)이면 «다시 동의» 거절을
 *  돌려준다: 403 · 앱 화면 다리와 같은 글(regrantMessage) + 동의할 곳 · body { code: consent_required, consent_url?, missing }.
 *  아니면 null — 부르는 쪽이 종전 «권한 밖» 을 그대로 던진다. 막힌 길에서만 부른다(구성원 · 앱 · 판 · 동의를 다시 읽는다 — 통과하는 호출의 비용은 그대로).
 *  읽기가 실패해도 null(종전 거절 그대로 — 판정을 못 해서 더 열지는 않는다).
 */
export async function appRegrantError(user: LivelyUser, need: { tool: string } | { scope: string }): Promise<HttpError | null> {
  if (!user?.appId || !user.userId) return null;
  const appId = user.appId;
  const c = await consentCoverage(appId, user.userId, user.appAddress ? { address: user.appAddress } : {}).catch(() => null);
  if (!c) return null;
  const hit = "tool" in need
    ? needsRegrant(c.grant.tools, c.declared.tools, need.tool)
    : scopeNeedsRegrant(c.grant.scopes, c.declared.scopes, need.scope, c.memberScopes);
  if (!hit) return null;
  const url = await consentUrlForPrincipal(user, appId, c.variant).catch(() => null);
  const msg = regrantMessage(appId, "tool" in need ? regrantToolPhrase(need.tool) : regrantScopePhrase(need.scope));
  return new HttpError(403, url ? `${msg}. 동의할 곳: ${url}` : msg, { body: { code: CONSENT_REQUIRED, missing: c.gap, ...(url ? { consent_url: url } : {}) } });
}

/**
 * 시작하는 자리 — 이 사람으로 앱 일을 띄우기 전에, 그 사람의 동의가 앱의 지금 선언 전체를 덮나. 덮지 못하면 그것과 동의할 곳, 덮으면 null.
 *  판정할 수 없으면(동의 없음 · 못 보는 앱 등) null — 그 거절은 띄우는 쪽의 기존 판정이 한다.
 *  user — 띄우는 주체(판 · 동의 자리 꼴을 정한다). memberId — 그 일이 돌 사람(작업 토큰의 주인).
 */
export async function launchConsentGap(user: LivelyUser, appId: string, memberId: string, installed?: OrgApp | null): Promise<{ missing: GrantGap; consent_url: string | null } | null> {
  const c = await consentCoverage(appId, memberId, { ...(user.appAddress ? { address: user.appAddress } : {}), ...(installed !== undefined ? { installed } : {}) });
  if (!c || grantGapEmpty(c.gap)) return null;
  return { missing: c.gap, consent_url: await consentUrlForPrincipal(user, appId, c.variant).catch(() => null) };
}

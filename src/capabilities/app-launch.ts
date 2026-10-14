// 앱 주소 열기 capability (#4480 v2-1) — 라이블리 화면(로그인한 구성원)이 앱 주소(<앱>-<워크스페이스>.lvly.app)로 들어갈
//  일회용 코드를 받는다. REST 전용(화면이 부른다 · 하네스가 앱 주소를 열 일은 없다 → MCP 로 열지 않는다).
//
//  누가: **사람 구성원 본인**만 — 웹 세션 또는 그 사람의 DB 토큰(데스크톱 앱이 쓰는 것). 앱 세션 토큰(appId 가 박힌 것 —
//   앱이 앱을 여는 길이 된다)과 정적 토큰(회수 불가 — 누구인지가 사람이 아니다)은 거부한다. 에이전트 구성원도 거부.
//  무엇을: 앱이 있고(active·enabled) 이 사람에게 보이고(공개 범위 — apps/visibility.ts) 화면이 있을 때, 그 앱 주소 하나에 묶인
//   60초짜리 코드. 자리 둘 — embed(라이블리 안 iframe) · top(직접 접속, 앞단 상태값 state 필수). 교환은 앱 주소 앞단이 한다
//   (apps/app-front-routes.ts redeem). 초안 판(draft)은 «만든 사람만 연다» 가 맞는데, 서버가 기록한 «만든 사람» 이
//   v2-15(#4667)에서 생긴다 — 그 전에는 409 draft_unavailable 로 닫아 둔다(매니페스트 studio.made_by 는 앱 코드라 위조 가능).
//  꺼짐: 매니지드가 아니거나 LIVELY_APP_DOMAIN 이 없으면 409 app_domain_off — 화면은 종전 srcdoc 으로 띄운다(무회귀).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import * as store from "../org/store/apps.js";
import { getMember } from "../org/store.js";
import { appVisibilityDenial } from "../apps/visibility.js";
import { appDomainFor, appHost, appOrigin, parseAppPath, safeAppNext, type AppVariant } from "../apps/app-address.js";
import { APP_LAUNCH_TTL_MS, isLaunchStateShape, mintAppLaunchCode, type AppLaunchMode, type MintLaunchInput } from "../apps/app-launch-store.js";
import type { OrgMember } from "../org/store/members.js";
import { currentTenant } from "../org/tenant-context.js";
import { managedMode } from "../org/tenancy/state.js";

const launchInput = {
  app_id: z.string(),
  mode: z.enum(["embed", "top"]).optional(),
  variant: z.enum(["pub", "draft"]).optional(),
  next: z.string().optional(),
  state: z.string().optional(),
};

const deny = (status: number, code: string, msg: string): HttpError => new HttpError(status, msg, { body: { code } });

/** 살아 있는 의존 — 시험은 같은 꼴의 가짜를 꽂는다(app-launch.test.ts). */
export interface LaunchDeps {
  env: NodeJS.ProcessEnv;
  tenant: () => { id: string; slug: string } | null;
  getMember: (id: string) => Promise<Pick<OrgMember, "id" | "kind" | "state"> | null>;
  getApp: (id: string) => Promise<store.OrgApp | null>;
  listUiAssets: (id: string) => Promise<Array<{ page_key: string }>>;
  mint: (i: MintLaunchInput) => Promise<{ code: string }>;
}
const liveDeps: LaunchDeps = {
  env: process.env,
  tenant: currentTenant,
  getMember: (id) => getMember(id),
  getApp: (id) => store.getApp(id),
  listUiAssets: (id) => store.listUiAssets(id),
  mint: (i) => mintAppLaunchCode(i),
};

export async function launchAppFor(input: Record<string, unknown>, user: LivelyUser | undefined, d: LaunchDeps = liveDeps): Promise<Record<string, unknown>> {
  const memberId = user?.userId || "";
  if (!memberId) throw new HttpError(401, "인증이 필요합니다");
  if (user?.appId) throw deny(403, "app_token", "앱 토큰으로는 앱 주소를 열 수 없습니다 — 사람 구성원의 로그인이 필요합니다");
  if (user?.tokenSource === "static") throw deny(403, "static_token", "정적 토큰으로는 앱 주소를 열 수 없습니다 — 사람 구성원의 로그인이 필요합니다");
  const member = await d.getMember(memberId).catch(() => null);
  if (!member || member.state !== "active" || (member.kind && member.kind !== "human")) {
    throw deny(403, "not_human", "앱 주소는 사람 구성원만 열 수 있습니다");
  }

  const tenant = d.tenant();
  //  워크스페이스 단위 스위치(LIVELY_APP_DOMAIN_TENANTS)까지 본다 — 목록 밖 워크스페이스는 꺼진 것과 같다.
  const domain = tenant ? appDomainFor(tenant.slug, d.env) : null;
  if (!managedMode(d.env) || !domain || !tenant) throw deny(409, "app_domain_off", "이 워크스페이스에서는 앱 주소가 꺼져 있습니다");

  const mode: AppLaunchMode = input.mode === "top" ? "top" : "embed";
  const variant: AppVariant = input.variant === "draft" ? "draft" : "pub";
  //  v2-15(#4667) 가 «만든 사람» 을 서버에 기록하면 그 사람에게만 연다. 그 전에는 닫아 둔다.
  if (variant === "draft") throw deny(409, "draft_unavailable", "초안 판 주소는 아직 열리지 않습니다 — 공개 판 주소로 열어 주세요");
  const next = safeAppNext(input.next);
  if (next === null) throw deny(400, "bad_next", "next 는 앱 주소 안의 상대 경로(/ 로 시작)여야 합니다");
  const state = typeof input.state === "string" ? input.state : "";
  if (mode === "top" && !isLaunchStateShape(state)) throw deny(400, "bad_state", "직접 접속에는 앞단이 준 state 가 필요합니다");

  const appId = String(input.app_id ?? "").trim();
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
  const app = await d.getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  const why = appVisibilityDenial(app, { userId: memberId, scopes: user?.scopes });
  if (why) throw new HttpError(403, why);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  const pages = await d.listUiAssets(appId);
  if (pages.length === 0) throw new HttpError(404, `앱 '${appId}' 에 UI 페이지가 없습니다`);
  const path = parseAppPath(next);
  const pageKey = path?.page ?? pages[0].page_key;
  if (path?.page && !pages.some((p) => p.page_key === path.page)) throw new HttpError(404, `UI 페이지 없음: ${path.page}`);

  const host = appHost(tenant.slug, appId, variant, domain);
  if (!host) throw deny(409, "no_address", `앱 '${appId}' 은(는) 앱 주소를 만들 수 없습니다(이름이 길거나 쓸 수 없는 꼴)`);
  const { code } = await d.mint({ memberId, appId, variant, host, mode, state: mode === "top" ? state : null });
  const origin = appOrigin(host);
  return {
    url: `${origin}/_lively/auth?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`,
    origin, expires_in: Math.round(APP_LAUNCH_TTL_MS / 1000),
    app_id: appId, title: app.title || appId, page_key: pageKey, variant, mode,
  };
}

const appLaunch: Capability = {
  name: "org_app_launch",
  title: "앱 주소 열기",
  description: "앱을 자기 주소(<앱>-<워크스페이스>.<앱 도메인>)로 열 일회용 코드를 준다(60초 · 1회 · 그 주소 전용). "
    + "mode=embed 는 라이블리 안 iframe, top 은 직접 접속(앞단 state 필수). 사람 구성원 본인만(앱 토큰 · 정적 토큰 거부). "
    + "앱 주소가 꺼진 배포면 409 app_domain_off. REST 전용.",
  scope: null,
  input: launchInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/launch"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, mode: b.mode, variant: b.variant, next: b.next, state: b.state };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) => launchAppFor(input, user),
};

export const appLaunchCapabilities: Capability[] = [appLaunch];

// 앱 주소 열기 capability (#4480 v2-1) — 라이블리 화면(로그인한 구성원)이 앱 주소(<앱>-<워크스페이스>.lvly.app)로 들어갈
//  일회용 코드를 받는다. REST 전용(화면이 부른다 · 하네스가 앱 주소를 열 일은 없다 → MCP 로 열지 않는다).
//
//  누가: **사람 구성원 본인**만 — 웹 세션 또는 그 사람의 DB 토큰(데스크톱 앱이 쓰는 것). 앱 세션 토큰(appId 가 박힌 것 —
//   앱이 앱을 여는 길이 된다)과 정적 토큰(회수 불가 — 누구인지가 사람이 아니다)은 거부한다. 에이전트 구성원도 거부.
//  무엇을: 앱이 있고(active·enabled) 이 사람에게 보이고(공개 범위 — apps/visibility.ts) 화면이 있을 때, 그 앱 주소 하나에 묶인
//   60초짜리 코드. 자리 둘 — embed(라이블리 안 iframe) · top(직접 접속, 앞단 상태값 state 필수). 교환은 앱 주소 앞단이 한다
//   (apps/app-front-routes.ts redeem). 판(variant): 공개 주소는 모두에게 공개 판, 초안 주소는 그 초안을 고친 사람에게만(#4667 서버 기록
//   draft_by · 판정 apps/visibility.ts addressViewFor — 남의 초안 주소는 없는 판과 같은 404). 판을 안 정하면 이 사람이 라이블리 화면에서
//   보는 판의 주소를 고른다(고친 초안이 걸려 있으면 초안 주소 — addressVariantFor).
//  꺼짐: 매니지드가 아니거나 LIVELY_APP_DOMAIN 이 없으면 409 app_domain_off — 화면은 종전 srcdoc 으로 띄운다(무회귀).
//  지난 경유 주소: top 의 exp(앞단이 #/app-open 주소에 붙인 만료 · 초)가 지났으면 410 app_open_expired — 화면은 앱으로 가지 않고
//   첫 화면으로 간다(되살린 탭 · 방문 기록으로 같은 주소에 다시 들어온 사람 — 2026-10-14 사파리 실측). 서버 시계로 본다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import * as store from "../org/store/apps.js";
import { getMember } from "../org/store.js";
import { addressVariantFor, addressViewFor, canSeeApp } from "../apps/visibility.js";
import { uiPagesFromFiles, type AppFile } from "../apps/app-versions.js";
import { publishedScreens } from "../apps/app-version-files.js";
import { appDomainFor, appHost, appOrigin, parseAppPath, safeAppNext, type AppVariant } from "../apps/app-address.js";
import { APP_LAUNCH_TTL_MS, isLaunchStateShape, mintAppLaunchCode, type AppLaunchMode, type MintLaunchInput } from "../apps/app-launch-store.js";
import type { OrgMember } from "../org/store/members.js";
import { currentTenant } from "../org/tenant-context.js";
import { managedMode } from "../org/tenancy/state.js";
import { logger } from "../log.js";

const launchInput = {
  app_id: z.string(),
  mode: z.enum(["embed", "top"]).optional(),
  variant: z.enum(["pub", "draft"]).optional(),
  next: z.string().optional(),
  state: z.string().optional(),
  exp: z.number().optional(),
};

const deny = (status: number, code: string, msg: string): HttpError => new HttpError(status, msg, { body: { code } });

/** 살아 있는 의존 — 시험은 같은 꼴의 가짜를 꽂는다(app-launch.test.ts). */
export interface LaunchDeps {
  env: NodeJS.ProcessEnv;
  tenant: () => { id: string; slug: string } | null;
  getMember: (id: string) => Promise<Pick<OrgMember, "id" | "kind" | "state"> | null>;
  getApp: (id: string) => Promise<store.OrgApp | null>;
  listUiAssets: (id: string) => Promise<Array<{ page_key: string }>>;
  /** #4667 공개 판 행 — 공개 주소로 여는데 남의 초안이 걸려 있으면 화면 키를 공개 판에서 본다. 없으면(시험 등) 설치된 화면으로 본다.
   *  null = 판 행 없음(설치된 화면으로) · 던짐 = 저장소 실패(503 — 설치된 화면, 곧 남의 초안으로 떨어지지 않는다). */
  getAppVersion?: (appId: string, versionNo: number) => Promise<{ manifest: unknown; files: unknown[] } | null>;
  mint: (i: MintLaunchInput) => Promise<{ code: string }>;
  now: () => number;
}
export const launchLiveDepsForTest = (): LaunchDeps => liveDeps;
const liveDeps: LaunchDeps = {
  env: process.env,
  tenant: currentTenant,
  getMember: (id) => getMember(id),
  getApp: (id) => store.getApp(id),
  listUiAssets: (id) => store.listUiAssets(id),
  //  #4481 판 묶음에서 화면 entry 만(호환 사본 files 는 30일 뒤 비고, 큰 판엔 처음부터 없다 — 격리 리뷰 재검토 2).
  getAppVersion: (id, no) => publishedScreens(id, no),
  mint: (i) => mintAppLaunchCode(i),
  now: () => Date.now(),
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
  const asked: AppVariant | null = input.variant === "draft" ? "draft" : input.variant === "pub" ? "pub" : null;
  const next = safeAppNext(input.next);
  if (next === null) throw deny(400, "bad_next", "next 는 앱 주소 안의 상대 경로(/ 로 시작)여야 합니다");
  const state = typeof input.state === "string" ? input.state : "";
  if (mode === "top" && !isLaunchStateShape(state)) throw deny(400, "bad_state", "직접 접속에는 앞단이 준 state 가 필요합니다");
  //  경유 주소는 한 번 쓰고 끝이다 — exp 는 앞단 상태 쿠키 수명과 같다(그 뒤엔 교환이 어차피 실패한다). 브라우저 시계가 아니라
  //   서버 시계로 본다(시계가 틀린 기기에서도 직접 접속이 된다). 값을 바꿔도 얻는 것은 없다 — 코드는 여전히 state 에 묶인다.
  if (mode === "top" && input.exp !== undefined && input.exp !== null) {
    const exp = Number(input.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= d.now()) throw deny(410, "app_open_expired", "지난 앱 주소 경유 주소입니다 — 앱 주소로 다시 들어가 주세요");
  }

  const appId = String(input.app_id ?? "").trim();
  if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
  const app = await d.getApp(appId);
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  //  #4667 남이 만들고 있는(나만 보는) 앱은 없는 앱과 같다(404 — 있는지조차 알리지 않는다).
  const viewer = { userId: memberId, scopes: user?.scopes };
  if (!canSeeApp(app, viewer)) throw new HttpError(404, `앱 없음: ${appId}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다`);
  //  판 — 정하지 않았으면 이 사람이 보는 판의 주소. 남의 초안이 걸린 앱의 초안 주소는 없는 판과 같다(그 초안은 고친 사람만 본다).
  const variant: AppVariant = asked ?? addressVariantFor(app, viewer);
  const view = addressViewFor(app, viewer, variant);
  if (view === "none") throw new HttpError(404, `앱 '${appId}' 에 열 수 있는 초안 판이 없습니다`);
  //  화면 키는 그 판의 화면에서 — 공개 판을 여는데 남의 초안이 깔려 있으면 설치된 화면이 아니라 공개 판 행의 화면을 본다.
  //  저장소 실패는 503 — «공개 판 없음» 으로 읽어 설치된 화면(남의 초안)의 화면 키로 판정하지 않는다.
  let pub: { manifest: unknown; files: unknown[] } | null = null;
  if (view === "published" && d.getAppVersion) {
    try { pub = await d.getAppVersion(appId, app.published_version_no as number); } catch (e) {
      //  까닭은 로그로만 — DB · 저장소 오류 글(주소 · 역할 이름)을 구성원에게 내보이지 않는다.
      logger.error({ err: e instanceof Error ? e.message : String(e), app: appId }, "[app-launch] 공개 판 화면을 읽지 못했다");
      throw new HttpError(503, `앱 '${appId}' 의 공개 판 화면을 읽지 못했습니다 — 잠시 뒤 다시 열어 주세요`);
    }
  }
  const pages = pub ? uiPagesFromFiles(pub.manifest, pub.files as AppFile[]) : await d.listUiAssets(appId);
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
    + "앱 주소가 꺼진 배포면 409 app_domain_off. top 의 exp(앞단 만료 · 초)가 지났으면 410 app_open_expired. REST 전용.",
  scope: null,
  input: launchInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/launch"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, mode: b.mode, variant: b.variant, next: b.next, state: b.state, exp: b.exp };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser | undefined) => launchAppFor(input, user),
};

export const appLaunchCapabilities: Capability[] = [appLaunch];

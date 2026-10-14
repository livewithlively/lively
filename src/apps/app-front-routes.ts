// 앱 주소 앞단(CP 라우터)이 부르는 기계 엔드포인트 셋(#4480 v2-1) — /api/app-front/{redeem, me, page}.
//
//  누가 부르나: 앱 주소(<앱>-<워크스페이스>.lvly.app) 앞단(lvly-cloud control/src/appfront.ts)만. 사람 로그인 미들웨어를 타지 않고
//   `x-lvly-app-front` 서명(apps/app-front-auth.ts)으로 연다 — 테넌트 헤더만으로는 부족하다(그 헤더는 인터넷의 모든 요청에 붙는다).
//  꺼짐: 매니지드가 아니거나(테넌트 헤더 비밀 없음) LIVELY_APP_DOMAIN 이 없으면 경로가 없는 것과 같다(404) — 자가호스팅 무회귀.
//
//   POST /api/app-front/redeem  {code, host, dest, state}           (op=redeem)
//        → 200 {member_id, name, app_id, variant, mode} | 404 {error:"invalid_code"}
//        dest = 브라우저의 Sec-Fetch-Dest, state = 앞단 상태 쿠키(없으면 "") — 묶음 판정은 apps/app-launch-store.ts.
//   GET  /api/app-front/me                                          (op=act)
//        → 200 {member:{id,name,email}, workspace:{slug}, app:{id,variant}, session:null}
//   GET  /api/app-front/page?path=<앱 주소 안 경로+쿼리>             (op=act)
//        → 200 text/html(v1 화면 + SDK 런타임 [+ 탐침]) · CSP 는 헤더 · 경로는 `/` 뿐(?page=<키>), 나머지는 404
//  ⓘ 매번 구성원(활성 · 사람)과 앱(있음 · 이 사람에게 보임)을 다시 본다 — 앱 주소 쿠키가 살아 있는 동안 빠진 사람·닫힌 앱을 바로 막는다.
import type express from "express";
import { wrap } from "../http/rest-util.js";
import { logger } from "../log.js";
import { currentTenant, type TenantContext } from "../org/tenant-context.js";
import { managedMode } from "../org/tenancy/state.js";
import { getMember } from "../org/store.js";
import * as appStore from "../org/store/apps.js";
import type { OrgMember } from "../org/store/members.js";
import { appViewFor, canSeeApp } from "./visibility.js";
import { uiPagesFromFiles, type AppFile } from "./app-versions.js";
import { appDomain, appDomainFor, parseAppPath } from "./app-address.js";
import { APP_FRONT_HEADER, verifyAppFront, type AppFrontAct, type AppFrontOp } from "./app-front-auth.js";
import { redeemAppLaunchCode, type RedeemedLaunch, type RedeemLaunchInput } from "./app-launch-store.js";
import { appErrorHtml, appPageCsp, buildAppPageHtml, loadAppScripts, type AppCsp, type AppScripts } from "./app-front-page.js";

/** 화면 규칙과 같은 이름(web/lib/person-name.ts · v6/comment-notify.ts memberName) — 닉네임을 쓰기로 켠 사람만 닉네임. */
export function memberDisplayName(m: Pick<OrgMember, "id" | "display_name" | "nickname" | "use_nickname">): string {
  const nick = String(m.nickname ?? "").trim();
  if (m.use_nickname && nick) return nick;
  return String(m.display_name ?? "").trim() || m.id;
}

export interface AppFrontDeps {
  env: NodeJS.ProcessEnv;
  tenant: () => TenantContext | null;
  getMember: (id: string) => Promise<OrgMember | null>;
  getApp: (id: string) => Promise<appStore.OrgApp | null>;
  listUiAssets: (appId: string) => Promise<Array<{ page_key: string }>>;
  getUiAsset: (appId: string, key: string) => Promise<{ page_key: string; html: string } | null>;
  /** #4667 공개 판 행(매니페스트 · 파일) — 남의 초안이 걸린 공개 앱을 공개 판으로 보여 줄 때. 없으면(시험 등) 설치된 화면을 준다. */
  getAppVersion?: (appId: string, versionNo: number) => Promise<{ manifest: unknown; files: unknown[] } | null>;
  redeem: (i: RedeemLaunchInput) => Promise<RedeemedLaunch | null>;
  scripts: () => Promise<AppScripts>;
}
const liveDeps = (): AppFrontDeps => ({
  env: process.env,
  tenant: currentTenant,
  getMember: (id) => getMember(id),
  getApp: (id) => appStore.getApp(id),
  listUiAssets: (id) => appStore.listUiAssets(id),
  getUiAsset: (id, key) => appStore.getUiAsset(id, key),
  getAppVersion: (id, no) => appStore.getAppVersion(id, no),
  redeem: (i) => redeemAppLaunchCode(i),
  scripts: () => loadAppScripts(),
});

export interface FrontReply { status: number; json?: unknown; html?: string; headers?: Record<string, string> }

/** 문 — 꺼졌으면 404, 서명이 틀리면 401(사유는 로그로만). 통과하면 서명 안의 값. */
export function appFrontGate(headers: Record<string, string | string[] | undefined>, op: AppFrontOp, d: AppFrontDeps):
  { ok: true; tenant: TenantContext; act: AppFrontAct | null } | { ok: false; reply: FrontReply } {
  const secret = String(d.env.LIVELY_TENANT_HEADER_SECRET ?? "").trim();
  const tenant = d.tenant();
  //  워크스페이스 단위 스위치(LIVELY_APP_DOMAIN_TENANTS) 밖이면 경로가 없는 것과 같다(404).
  if (!secret || !managedMode(d.env) || !appDomainFor(tenant?.slug, d.env)) return { ok: false, reply: { status: 404, json: { error: "not found" } } };
  const v = verifyAppFront(headers[APP_FRONT_HEADER], { secret, tenant, op });
  if (!v.ok || !tenant) {
    logger.warn({ op, why: v.ok ? "테넌트 없음" : v.why, ws: tenant?.slug }, "[app-front] 기계 헤더 거부");
    return { ok: false, reply: { status: 401, json: { error: "unauthorized" } } };
  }
  return { ok: true, tenant, act: v.payload.op === "act" ? v.payload : null };
}

/** 그 사람이 지금도 활성 사람 구성원인가 · 그 앱이 있고 그 사람에게 보이나. 문제면 응답, 아니면 null. */
async function whoAndApp(act: AppFrontAct, d: AppFrontDeps, asHtml: boolean):
  Promise<{ member: OrgMember; app: appStore.OrgApp } | { reply: FrontReply }> {
  const fail = (status: number, title: string, detail: string): { reply: FrontReply } => ({ reply: asHtml
    ? { status, html: appErrorHtml(title, detail) }
    : { status, json: { error: detail } } });
  const member = await d.getMember(act.mid).catch(() => null);
  if (!member || member.state !== "active" || (member.kind && member.kind !== "human")) {
    return fail(403, "이 앱을 열 수 없습니다", "이 워크스페이스의 활성 구성원만 앱을 열 수 있습니다. 라이블리에서 다시 로그인해 주세요.");
  }
  const app = await d.getApp(act.app).catch(() => null);
  if (!app) return fail(404, "앱을 찾지 못했습니다", `앱 '${act.app}' 이(가) 이 워크스페이스에 없습니다.`);
  //  #4667 남이 만들고 있는(나만 보는) 앱은 없는 앱과 같다 — 없는 앱과 같은 답(있는지조차 알리지 않는다).
  if (!canSeeApp(app, { userId: member.id, scopes: member.scopes })) return fail(404, "앱을 찾지 못했습니다", `앱 '${act.app}' 이(가) 이 워크스페이스에 없습니다.`);
  return { member, app };
}

export async function appFrontRedeem(headers: Record<string, string | string[] | undefined>, body: unknown, d: AppFrontDeps): Promise<FrontReply> {
  const g = appFrontGate(headers, "redeem", d);
  if (!g.ok) return g.reply;
  const b = (body ?? {}) as Record<string, unknown>;
  const domain = appDomain(d.env) as string;
  const host = String(b.host ?? "").trim().toLowerCase();
  if (!host.endsWith("." + domain)) return { status: 404, json: { error: "invalid_code" } };
  const r = await d.redeem({ code: String(b.code ?? ""), host, dest: String(b.dest ?? ""), state: String(b.state ?? "") });
  if (!r) return { status: 404, json: { error: "invalid_code" } };
  const m = await d.getMember(r.memberId).catch(() => null);
  return { status: 200, json: { member_id: r.memberId, name: m ? memberDisplayName(m) : r.memberId, app_id: r.appId, variant: r.variant, mode: r.mode } };
}

export async function appFrontMe(headers: Record<string, string | string[] | undefined>, d: AppFrontDeps): Promise<FrontReply> {
  const g = appFrontGate(headers, "act", d);
  if (!g.ok) return g.reply;
  const act = g.act as AppFrontAct;
  const w = await whoAndApp(act, d, false);
  if ("reply" in w) return w.reply;
  return { status: 200, json: {
    member: { id: w.member.id, name: memberDisplayName(w.member), email: w.member.email ?? null },
    workspace: { slug: g.tenant.slug },
    app: { id: w.app.id, variant: act.var },
    session: null,   // 붙은 세션 — 라이블리 화면이 감싸는 iframe 에서만 있다(v2-3 이 채운다). 새 탭 · 직접 접속은 늘 null.
  } };
}

export async function appFrontPage(headers: Record<string, string | string[] | undefined>, rawPath: unknown, d: AppFrontDeps): Promise<FrontReply> {
  const g = appFrontGate(headers, "act", d);
  if (!g.ok) {
    return { status: g.reply.status, html: g.reply.status === 404
      ? appErrorHtml("화면을 찾지 못했습니다", "이 워크스페이스에서는 앱 주소가 꺼져 있습니다.")
      : appErrorHtml("앱을 열 수 없습니다", "앱 주소의 앞단을 거치지 않은 요청입니다.") };
  }
  const act = g.act as AppFrontAct;
  const w = await whoAndApp(act, d, true);
  if ("reply" in w) return w.reply;
  const notFound = (detail: string): FrontReply => ({ status: 404, html: appErrorHtml("화면을 찾지 못했습니다", detail) });
  if (w.app.status !== "active" || !w.app.enabled) return { status: 409, html: appErrorHtml("앱이 꺼져 있습니다", `앱 '${w.app.id}' 이(가) 지금 활성 상태가 아닙니다.`) };
  const path = parseAppPath(rawPath);
  if (!path || !path.root) return notFound("이 앱의 화면은 주소 맨 앞(/) 에만 있습니다.");
  //  #4667 공개 앱에 남의 초안이 걸려 있으면 이 사람은 공개 판을 본다 — 설치된 화면(초안)이 아니라 공개 판 행의 파일에서 꺼낸다(org_app_ui 와 같은 규칙).
  let asset: { page_key: string; html: string } | null = null;
  let manifest: unknown = w.app.manifest;
  const pub = appViewFor(w.app, { userId: w.member.id, scopes: w.member.scopes }) === "published" && d.getAppVersion
    ? await d.getAppVersion(w.app.id, w.app.published_version_no as number).catch(() => null) : null;
  if (pub) {
    const ui = uiPagesFromFiles(pub.manifest, pub.files as AppFile[]);
    if (!ui.length) return notFound(`앱 '${w.app.id}' 에 화면이 없습니다.`);
    const key = path.page ?? ui[0].page_key;
    asset = ui.find((u) => u.page_key === key) ?? null;
    if (!asset) return notFound(`화면 '${key}' 이(가) 없습니다.`);
    manifest = pub.manifest;
  } else {
    const pages = await d.listUiAssets(w.app.id);
    if (!pages.length) return notFound(`앱 '${w.app.id}' 에 화면이 없습니다.`);
    const key = path.page ?? pages[0].page_key;
    asset = await d.getUiAsset(w.app.id, key);
    if (!asset) return notFound(`화면 '${key}' 이(가) 없습니다.`);
  }
  let scripts: AppScripts;
  try { scripts = await d.scripts(); } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[app-front] SDK 런타임 준비물 없음");
    return { status: 503, html: appErrorHtml("앱 화면을 준비하지 못했습니다", "게이트웨이에 웹 빌드 산출물이 없습니다. 잠시 뒤 다시 열어 주세요.") };
  }
  const csp = ((manifest as { csp?: AppCsp } | null)?.csp ?? {}) as AppCsp;
  return {
    status: 200,
    html: buildAppPageHtml(asset.html, { runtime: scripts.runtime, probe: path.probe ? scripts.probe : null }),
    headers: { "Content-Security-Policy": appPageCsp(csp) },
  };
}

function send(res: express.Response, r: FrontReply): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  if (r.html !== undefined) { res.status(r.status).type("html").send(r.html); return; }
  res.status(r.status).json(r.json ?? {});
}

/** web.ts 가 사람 로그인 라우트(세션 교환 등)와 같은 자리 — capability 마운트보다 **먼저** — 에서 부른다. */
export function registerAppFrontRoutes(app: express.Express, deps: () => AppFrontDeps = liveDeps): void {
  const H = (req: express.Request) => req.headers as Record<string, string | string[] | undefined>;
  app.post("/api/app-front/redeem", wrap(async (req, res) => { send(res, await appFrontRedeem(H(req), req.body, deps())); }));
  app.get("/api/app-front/me", wrap(async (req, res) => { send(res, await appFrontMe(H(req), deps())); }));
  app.get("/api/app-front/page", wrap(async (req, res) => { send(res, await appFrontPage(H(req), (req.query as Record<string, unknown>)?.path, deps())); }));
}

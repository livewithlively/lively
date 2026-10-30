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
//        → #4481 여러 파일 앱(보는 판의 매니페스트에 web.root): 그 판 묶음의 파일을 그 경로로(규칙은 app-front-files.ts) · HTML 문서엔 SDK 런타임 ·
//          ETag(내용 지문) · 304 · gzip · 지문 이름은 1년 캐시
//        → #4485 서버 앱(보는 판의 매니페스트에 web.server · 이 워크스페이스에 앱 서버 켜짐): 그 판의 함수가 답한다(app-front-server.ts serveAppServer)
//   *    /api/app-front/lively?path=<경로+쿼리>                     (op=act · #4482 v2-3)
//        → 앱 주소의 같은 주소 API `/_lively/<경로>`(store · tools · prefs) — 경로 · 판정 · 답은 app-front-api.ts
//        → `/_lively/sdk.js` · `/_lively/probe.js`(GET · HEAD): SDK 런타임 · 탐침 파일(#4485 후속 — 인라인을 막는 CSP 의 서버 화면에 넣는 것)
//   POST · PUT · PATCH · DELETE /api/app-front/server?path=<경로+쿼리>  (op=act · #4485 v2-6 · index.ts 가 전역 JSON 읽기 전에 붙인다)
//        → 서버 앱의 쓰기 요청 — 본문 날것(4MB · 압축 본문 415) 그대로 함수로 · 서버가 없는 판이면 405 · 답은 함수의 것(막히면 JSON)
//  ⓘ 매번 구성원(활성 · 사람)과 앱(있음 · 이 사람에게 보임)을 다시 본다 — 앱 주소 쿠키가 살아 있는 동안 빠진 사람·닫힌 앱을 바로 막는다.
import express from "express";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { Readable, pipeline } from "node:stream";
import { createHash } from "node:crypto";
import { wrap } from "../http/rest-util.js";
import { viewerOf } from "../capabilities/principal.js";
import { logger } from "../log.js";
import { currentTenant, type TenantContext } from "../org/tenant-context.js";
import { managedMode } from "../org/tenancy/state.js";
import { getMember } from "../org/store.js";
import * as appStore from "../org/store/apps.js";
import type { OrgMember } from "../org/store/members.js";
import { addressViewFor, canSeeApp } from "./visibility.js";
import { uiPagesFromFiles, type AppFile } from "./app-versions.js";
import { publishedScreens } from "./app-version-files.js";
import { appDomain, appDomainFor, parseAppPath } from "./app-address.js";
import { APP_FRONT_HEADER, verifyAppFront, type AppFrontAct, type AppFrontOp } from "./app-front-auth.js";
import { redeemAppLaunchCode, type RedeemedLaunch, type RedeemLaunchInput } from "./app-launch-store.js";
import { appErrorHtml, appPageCsp, appPageCspMulti, buildAppPageHtml, loadAppScripts, type AppCsp, type AppScripts } from "./app-front-page.js";
import { filesCspSource } from "../files/app-screen-csp.js";   // #4673 앱 폴더 서명 주소 자리
import { webRootOf } from "./manifest.js";
import { APP_FRONT_API_BODY_LIMIT, consentUrlFor, handleAppFrontApi, type AppFrontApiDeps } from "./app-front-api.js";
import { runAppTool } from "../capabilities/app-tool-call.js";
import { appPrefsCapabilities } from "../capabilities/app-prefs.js";
import { workspaceAccessAllowed } from "../org/tenancy/gate.js";
import { gatewayUrl } from "../gateway-url.js";
import { serverDeclOf, appServerEnv } from "./app-server-config.js";   // #4485 앱 서버(web.server) — 주소의 판이 서버를 선언했으면 함수로
import { APP_SERVER_BODY_LIMIT, serveAppServer, type AppServerFrontDeps, type ServerTarget } from "./app-front-server.js";
import { PROBE_PATH, SDK_PATH, scriptVersion } from "./app-server-page.js";   // #4485 후속 — 서버 화면용 같은 주소 파일
import { parseBundle, type AppBundle, type BundleEntry } from "./app-bundle.js";
import { BLOB_CACHE_ENTRY_MAX, getBlob, streamBlob, type BlobStoreKind } from "./app-blob-store.js";
import {
  cacheControlFor, compressible, contentTypeFor, etagMatches, indexUnderRoot, isHtmlPath, parseFrontUrl, resolveFrontPath, REVALIDATE,
} from "./app-front-files.js";

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
  /** #4667 공개 판 행(매니페스트 · 파일) — 남의 초안이 걸린 공개 앱을 공개 판으로 보여 줄 때. 없으면(시험 등) 설치된 화면을 준다.
   *  null = 판 행 없음(설치된 화면으로) · 던짐 = 저장소 실패(503 — 설치된 화면, 곧 남의 초안으로 떨어지지 않는다). */
  getAppVersion?: (appId: string, versionNo: number) => Promise<{ manifest: unknown; files: unknown[] } | null>;
  redeem: (i: RedeemLaunchInput) => Promise<RedeemedLaunch | null>;
  scripts: () => Promise<AppScripts>;
  /** #4481 판 하나의 내용 지문(요청마다 — 싸다) · 그 판의 머리 + 파일 목록(캐시가 비었을 때만) · 파일 내용(작으면 바이트, 크면 흘려 받기). */
  versionHash?: (appId: string, versionNo: number) => Promise<{ content_hash: string | null; has_bundle: boolean } | null>;
  versionBundle?: (appId: string, versionNo: number) => Promise<{ manifest: unknown; content_hash: string | null; bundle: unknown | null; bundle_store: string | null } | null>;
  readBlob?: (kind: BlobStoreKind, h: string, size: number) => Promise<Buffer | Readable | null>;
  /** #4482 같은 주소 API(/_lively/*)의 실행 배관. 없으면(시험 등) 그 길은 503. */
  api?: AppFrontApiDeps;
  /** #4485 앱 서버로 넘길 때의 의존(Lambda · 서버 줄 · 상한). 없으면 살아 있는 것(app-front-server liveServerFrontDeps) — 시험이 가짜 Lambda 를 넣는다. */
  server?: (tenantId: string) => AppServerFrontDeps;
}
/** 앱 개인 설정 능력(capabilities/app-prefs.ts) — 같은 규칙(보이는 앱만 · 16KB · 분당 60)을 한 벌로. */
const prefsCap = (name: string) => {
  const c = appPrefsCapabilities.find((x) => x.name === name);
  if (!c) throw new Error(`앱 개인 설정 능력이 없다: ${name}`);
  return c;
};
const liveApiDeps: AppFrontApiDeps = {
  workspaceAccess: (id) => workspaceAccessAllowed(id),
  runTool: (member, appId, name, args, address) => runAppTool(member, appId, name, args, { source: "app-front", address }),
  prefsGet: (member, appId) => prefsCap("app_prefs_get").handler({ app_id: appId }, member, { source: "app-front", actor: member.userId, viewer: viewerOf(member) }),
  prefsSet: (member, appId, patch) => prefsCap("app_prefs_set").handler({ app_id: appId, patch }, member, { source: "app-front", actor: member.userId, viewer: viewerOf(member) }),
  gatewayBase: () => gatewayUrl(),
};
const liveDeps = (): AppFrontDeps => ({
  env: process.env,
  tenant: currentTenant,
  getMember: (id) => getMember(id),
  getApp: (id) => appStore.getApp(id),
  listUiAssets: (id) => appStore.listUiAssets(id),
  getUiAsset: (id, key) => appStore.getUiAsset(id, key),
  //  #4481 공개 판의 화면 entry 만 — 판 묶음이 있으면 저장소에서(옛 코어 호환 사본 files 는 30일 뒤 비워지므로 거기서 읽지 않는다).
  getAppVersion: (id, no) => publishedScreens(id, no),
  redeem: (i) => redeemAppLaunchCode(i),
  scripts: () => loadAppScripts(),
  versionHash: (id, no) => appStore.getAppVersionHash(id, no),
  versionBundle: (id, no) => appStore.getAppVersionBundle(id, no),
  readBlob: (kind, h, size) => (size <= BLOB_CACHE_ENTRY_MAX ? getBlob(kind, h) : streamBlob(kind, h, size)),
  api: liveApiDeps,
});

/** 시험용 — 살아 있는 의존(실제 DB · 저장소)을 그대로(시험이 env · 워크스페이스만 바꿔 쓴다 — app-bundles.pg-test D10). */
export const appFrontLiveDepsForTest = liveDeps;

export interface FrontReply { status: number; json?: unknown; html?: string; headers?: Record<string, string>; body?: Buffer; stream?: Readable; gzip?: boolean;
  /** #4485 — 이 요청은 앱 서버(함수)가 답한다(라우트가 serveAppServer 로 넘긴다). */
  server?: ServerTarget }

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
  //  #4482 동의 자리 — 맨몸(새 탭 · 폰)의 SDK 가 lively.requestConsent() 로 이리 보낸다(라이블리 화면 안이면 그 자리 동의 창을 쓴다).
  const base = d.api ? await d.api.gatewayBase().catch(() => null) : null;
  return { status: 200, json: {
    member: { id: w.member.id, name: memberDisplayName(w.member), email: w.member.email ?? null },
    workspace: { slug: g.tenant.slug },
    app: { id: w.app.id, variant: act.var },
    //  붙은 세션은 늘 null — 앱 주소 쿠키는 그 앱의 모든 iframe 이 같이 써서(같은 파티션) 어느 세션 칸에서 왔는지 모른다(#4482).
    //   세션 칸에서 연 화면은 SDK(lively.me() · lively.session)가 감싸는 라이블리 화면에게서 받는다.
    session: null,
    consent_url: consentUrlFor(base, g.tenant.slug, w.app.id, act.var, d.env),
  } };
}

/**
 * #4482 같은 주소 API — `/_lively/<경로>`(앞단이 `?path=` 로 넘김). 문 · 사람 · 앱은 화면과 같은 판정, 그 뒤는 app-front-api.ts.
 *  답은 JSON(앱 코드가 fetch 로 받는다) — 문이 닫혀도 화면용 HTML 이 아니라 JSON. 단 `/_lively/sdk.js` · `/_lively/probe.js` 는 JS 파일(sdkFile · #4485 후속).
 */
export async function appFrontLively(headers: Record<string, string | string[] | undefined>, method: string, rawPath: unknown, body: unknown, d: AppFrontDeps): Promise<FrontReply> {
  const g = appFrontGate(headers, "act", d);
  if (!g.ok) return g.reply;
  const act = g.act as AppFrontAct;
  const w = await whoAndApp(act, d, false);
  if ("reply" in w) return w.reply;
  const file = await sdkFile(method, rawPath, headers, d);
  if (file) return file;
  if (!d.api) return { status: 503, json: { error: "이 게이트웨이에서는 앱 API 가 준비되지 않았습니다" } };
  const r = await handleAppFrontApi({ act, tenant: g.tenant, member: w.member, app: w.app, method, rawPath, body, env: d.env }, d.api);
  return { status: r.status, json: r.json };
}

/**
 * #4485 후속 — 서버 화면에 넣는 SDK 런타임 · 탐침을 같은 주소의 파일로 낸다(앱의 CSP 가 인라인을 막으면 app-server-page.ts 가 이 주소를 넣는다).
 *  `?v=` 가 지금 판의 지문이면 1년 캐시(판이 바뀌면 지문도 바뀐다), 아니면 늘 다시 묻게. `/_lively/*` 는 앱 서버로 가지 않는 우리 자리다.
 *  이 둘이 아닌 경로면 null(같은 주소 API 로).
 */
async function sdkFile(method: string, rawPath: unknown, headers: Record<string, string | string[] | undefined>, d: AppFrontDeps): Promise<FrontReply | null> {
  const raw = String(rawPath ?? "");
  const q = raw.indexOf("?");
  const p = "/_lively" + (q < 0 ? raw : raw.slice(0, q));
  if (p !== SDK_PATH && p !== PROBE_PATH) return null;
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return { status: 405, json: { error: "method_not_allowed" }, headers: { Allow: "GET, HEAD" } };
  let s: AppScripts;
  try { s = await d.scripts(); } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : String(e) }, "[app-front] SDK 런타임 준비물 없음(같은 주소 파일)");
    return { status: 503, json: { error: "SDK 런타임을 준비하지 못했습니다 — 잠시 뒤 다시 열어 주세요", code: "sdk_unavailable" } };
  }
  const js = p === SDK_PATH ? s.runtime : s.probe;
  const ver = scriptVersion(js);
  const v = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1)).get("v");
  const base: Record<string, string> = {
    "Content-Type": "text/javascript; charset=utf-8", Vary: "Accept-Encoding",
    "Cache-Control": v === ver ? "public, max-age=31536000, immutable" : "no-cache",
  };
  const body = Buffer.from(js, "utf8");
  //  화면마다 기본으로 받는 파일이다(판마다 한 번) — 21KB 를 압축해 낸다(압축본은 판 지문으로 한 벌만 기억).
  if (/\bgzip\b/.test(hdr(headers, "accept-encoding"))) return { status: 200, headers: { ...base, "Content-Encoding": "gzip" }, body: await gzipCached(`sdk:${p}:${ver}`, body) };
  return { status: 200, body, headers: base };
}

/**
 * 화면 길(/page)과 서버 쓰기 길(/server)이 함께 쓰는 문 — 기계 헤더 · 사람 · 앱 · 활성 · 주소의 판. 한쪽만 고쳐 어긋나지 않게 한 곳에 둔다(#4485).
 *  asHtml: 막혔을 때 화면 오류(HTML · /page)로 답할지, JSON(/server)으로 답할지.
 */
async function frontTarget(headers: Record<string, string | string[] | undefined>, d: AppFrontDeps, asHtml: boolean):
  Promise<{ ok: true; target: ServerTarget } | { ok: false; reply: FrontReply }> {
  const g = appFrontGate(headers, "act", d);
  if (!g.ok) {
    return { ok: false, reply: !asHtml ? g.reply : { status: g.reply.status, html: g.reply.status === 404
      ? appErrorHtml("화면을 찾지 못했습니다", "이 워크스페이스에서는 앱 주소가 꺼져 있습니다.")
      : appErrorHtml("앱을 열 수 없습니다", "앱 주소의 앞단을 거치지 않은 요청입니다.") } };
  }
  const act = g.act as AppFrontAct;
  const w = await whoAndApp(act, d, asHtml);
  if ("reply" in w) return { ok: false, reply: w.reply };
  if (w.app.status !== "active" || !w.app.enabled) {
    return { ok: false, reply: asHtml ? { status: 409, html: appErrorHtml("앱이 꺼져 있습니다", `앱 '${w.app.id}' 이(가) 지금 활성 상태가 아닙니다.`) }
      : { status: 409, json: { error: "app_disabled" } } };
  }
  //  #4667 주소의 판 — 공개 주소는 모두에게 공개 판(초안이 걸려 있으면 공개 판 행의 파일), 초안 주소는 그 초안을 고친 사람에게만 설치된 화면
  //   (남의 초안은 없는 판 · apps/visibility.ts addressViewFor). 초안 코드가 공개 판 주소에서 돌지 않게 — 설계 §13-5.
  const view = addressViewFor(w.app, { userId: w.member.id, scopes: w.member.scopes }, act.var === "draft" ? "draft" : "pub");
  if (view === "none") {
    return { ok: false, reply: asHtml ? { status: 404, html: appErrorHtml("화면을 찾지 못했습니다", `앱 '${w.app.id}' 에 열 수 있는 초안 판이 없습니다.`) }
      : { status: 404, json: { error: "not_found" } } };
  }
  return { ok: true, target: { tenant: g.tenant, act, member: w.member, app: w.app, view } };
}

export async function appFrontPage(headers: Record<string, string | string[] | undefined>, rawPath: unknown, d: AppFrontDeps): Promise<FrontReply> {
  const f = await frontTarget(headers, d, true);
  if (!f.ok) return f.reply;
  const { tenant, view } = f.target;
  const w = { member: f.target.member, app: f.target.app };
  const notFound = (detail: string): FrontReply => ({ status: 404, html: appErrorHtml("화면을 찾지 못했습니다", detail) });
  //  #4485 앱 서버 — 주소의 판이 web.server 를 선언했고 이 워크스페이스에 앱 서버가 켜져 있으면 그 판의 함수가 답한다(`/_lively/*` 밖의 모든 경로).
  //   status 0 은 «여기서 답하지 않는다» 표시다 — 라우트가 serveAppServer 로 넘긴다(send 는 이 답을 받지 않는다).
  if (await viewDeclaresServer(w.app, view === "published", d, tenant.id)) return { status: 0, server: f.target };
  //  #4481 여러 파일 앱 — 보는 판의 매니페스트에 web.root 가 있으면 판 묶음에서 낸다(아니면 null → 아래 v1 길). 판은 위 주소의 판 그대로.
  const multi = await multiFilePage(w, view === "published", rawPath, headers, d, tenant.id);
  if (multi) return multi;
  const path = parseAppPath(rawPath);
  if (!path || !path.root) return notFound("이 앱의 화면은 주소 맨 앞(/) 에만 있습니다.");
  let asset: { page_key: string; html: string } | null = null;
  let manifest: unknown = w.app.manifest;
  let pub: { manifest: unknown; files: unknown[] } | null = null;
  if (view === "published" && d.getAppVersion) {
    try { pub = await d.getAppVersion(w.app.id, w.app.published_version_no as number); } catch (e) {
      //  저장소(S3) 실패를 «공개 판 없음» 으로 읽으면 아래가 설치된 화면 — 남의 초안 — 을 공개 주소에 낸다. 503 으로 닫는다(격리 리뷰 재검토 1).
      logger.error({ err: e instanceof Error ? e.message : String(e), app: w.app.id }, "[app-front] 공개 판 화면을 읽지 못했다");
      return { status: 503, html: appErrorHtml("앱 화면을 준비하지 못했습니다", "공개 판의 화면 파일을 읽지 못했습니다. 잠시 뒤 다시 열어 주세요.") };
    }
  }
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
    headers: { "Content-Security-Policy": appPageCsp({ ...csp, files: await filesCspSource(manifest) }) },
  };
}

// ── #4481 여러 파일 앱 ───────────────────────────────────────────────────────────

interface CachedBundle { kind: BlobStoreKind; bundle: AppBundle; manifest: unknown; index: Map<string, BundleEntry> | null; rootRel: string | null }
/** 판 묶음 캐시 — 키에 내용 지문을 넣는다(「원본 · 릴리스」 판은 번호 그대로 내용이 바뀐다 · store.refreshOriginVersion). */
const bundleCache = new Map<string, CachedBundle>();
const BUNDLE_CACHE_MAX = 200;
export function clearFrontBundleCacheForTest(): void { bundleCache.clear(); gzCache.clear(); gzBytes = 0; }
/** 시험용 — 압축본 캐시의 셈(줄 수 · 바이트)과 실제 합. */
export function gzCacheStatsForTest(): { entries: number; counted: number; actual: number } {
  let actual = 0;
  for (const v of gzCache.values()) actual += v.length;
  return { entries: gzCache.size, counted: gzBytes, actual };
}

async function loadBundle(d: AppFrontDeps, tenant: string, appId: string, no: number): Promise<CachedBundle | "no-bundle" | null> {
  if (!d.versionHash || !d.versionBundle) return null;
  const h = await d.versionHash(appId, no);
  if (!h) return null;
  if (!h.has_bundle) return "no-bundle";
  const key = `${tenant}|${appId}|${no}|${h.content_hash ?? ""}`;
  const hit = bundleCache.get(key);
  if (hit) { bundleCache.delete(key); bundleCache.set(key, hit); return hit; }
  const head = await d.versionBundle(appId, no);
  const bundle = head ? parseBundle(head.bundle) : null;
  if (!head || !bundle) return "no-bundle";
  const rootRel = webRootOf(head.manifest);
  const c: CachedBundle = { kind: head.bundle_store === "db" ? "db" : "s3", bundle, manifest: head.manifest, rootRel, index: rootRel === null ? null : indexUnderRoot(bundle, rootRel) };
  bundleCache.set(key, c);
  while (bundleCache.size > BUNDLE_CACHE_MAX) bundleCache.delete(bundleCache.keys().next().value as string);
  return c;
}

/**
 * #4485 — 이 주소의 판이 앱 서버를 선언했나(web.server). 설치된 판은 앱 행의 매니페스트, 공개 판은 그 판 묶음의 매니페스트(캐시)로 본다.
 *  앱 서버가 꺼진 워크스페이스(env 없음 · 스위치 밖)면 늘 거짓 — 화면(web.root)은 그대로 정적으로 낸다(v2-5 와 같다).
 */
async function viewDeclaresServer(app: appStore.OrgApp, published: boolean, d: AppFrontDeps, tenant: string): Promise<boolean> {
  if (!appServerEnv(d.env, d.tenant()?.slug)) return false;
  if (!published) return serverDeclOf(app.manifest) !== null;
  if (app.published_version_no == null) return false;
  const c = await loadBundle(d, tenant, app.id, app.published_version_no);
  return !!c && c !== "no-bundle" && serverDeclOf(c.manifest) !== null;
}

/** 화면 키 → web.root 기준 entry 경로(`/?page=<키>` 를 풀 때). */
function pageEntries(manifest: unknown, rootRel: string): Map<string, string> {
  const ui = (manifest as { ui?: { pages?: Array<{ key?: unknown; entry?: unknown }> } } | null)?.ui;
  const pre = rootRel ? rootRel + "/" : "";
  const m = new Map<string, string>();
  for (const p of Array.isArray(ui?.pages) ? ui!.pages! : []) {
    const e = String(p?.entry ?? "").split("/").filter((x) => x && x !== ".").join("/");
    if (p?.key && (!pre || e.startsWith(pre))) m.set(String(p.key), e.slice(pre.length));
  }
  return m;
}

const hdr = (headers: Record<string, string | string[] | undefined>, k: string): string => {
  const v = headers[k];
  return Array.isArray(v) ? v.join(",") : String(v ?? "");
};

/**
 * 여러 파일 앱이면 응답, 아니면 null(v1 길). published — 이 주소가 보이는 판(#4667 addressViewFor): 공개 판이면 공개 판 번호,
 *  아니면 설치된 판(지금 판 번호 — 내용이 같을 때만 · 초안 주소의 초안 주인 · 나만 보는 앱 · 초안 없는 공개 앱).
 *  판 묶음 쪽 문제는 그 판으로 다시 저장하라고 알린다(조용히 v1 화면으로 떨어지면 깨진 화면이 남는다).
 */
async function multiFilePage(w: { member: OrgMember; app: appStore.OrgApp }, published: boolean, rawPath: unknown, headers: Record<string, string | string[] | undefined>,
  d: AppFrontDeps, tenant: string): Promise<FrontReply | null> {
  //  설치된 판을 보는 사람 — 앱 행의 매니페스트로 먼저 가른다(v1 앱은 DB 를 더 안 읽는다).
  if (!published && webRootOf(w.app.manifest) === null) return null;
  const no = published ? w.app.published_version_no : w.app.current_version_no;
  const broken = (detail: string): FrontReply => ({ status: 409, html: appErrorHtml("앱 파일을 찾지 못했습니다", detail) });
  if (no == null) return published ? null : broken(`앱 '${w.app.id}' 의 지금 판에 파일 묶음이 없습니다 — 앱을 다시 저장해 주세요(app_save).`);
  const c = await loadBundle(d, tenant, w.app.id, no);
  if (c === null) return published ? null : broken(`앱 '${w.app.id}' 의 ${no}판을 찾지 못했습니다 — 앱을 다시 저장해 주세요.`);
  if (c === "no-bundle") {
    //  공개 판에 목록이 없다 = #4481 전에 저장된 판 = 화면 한 장 앱(v1) — 종전 길로.
    if (published) return null;
    return broken(`앱 '${w.app.id}' 의 ${no}판은 아직 파일 묶음으로 옮겨지지 않았습니다 — 잠시 뒤 다시 열어 주세요.`);
  }
  if (c.rootRel === null || !c.index) return null;   // 그 판이 v1 앱이다(공개 판이 web.root 를 넣기 전 판)
  if (!published) {
    const h = d.versionHash ? await d.versionHash(w.app.id, no) : null;
    if (!h || h.content_hash !== w.app.content_hash) return broken(`앱 '${w.app.id}' 의 설치된 내용과 ${no}판이 다릅니다 — 앱을 다시 저장해 주세요(app_save).`);
  }
  const url = parseFrontUrl(rawPath);
  if (!url) return { status: 400, html: appErrorHtml("주소가 틀렸습니다", "앱 주소 안의 경로를 읽지 못했습니다.") };
  const r = resolveFrontPath(c.index, url, pageEntries(c.manifest, c.rootRel));
  if (r.kind === "redirect") return { status: 308, headers: { Location: r.location, "Cache-Control": REVALIDATE }, html: appErrorHtml("옮겨 갑니다", r.location) };
  if (r.kind === "notfound") return { status: 404, html: appErrorHtml("화면을 찾지 못했습니다", `'/${url.path}' 에 해당하는 파일이 이 앱에 없습니다.`) };
  const e = r.entry;
  const type = contentTypeFor(r.rel);
  const gz = /\bgzip\b/.test(hdr(headers, "accept-encoding")) && compressible(type) && e.s >= 1024;
  if (!d.readBlob) return broken("앱 파일 저장소가 연결돼 있지 않습니다.");
  if (isHtmlPath(r.rel)) {
    let scripts: AppScripts;
    try { scripts = await d.scripts(); } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "[app-front] SDK 런타임 준비물 없음");
      return { status: 503, html: appErrorHtml("앱 화면을 준비하지 못했습니다", "게이트웨이에 웹 빌드 산출물이 없습니다. 잠시 뒤 다시 열어 주세요.") };
    }
    const raw = await d.readBlob(c.kind, e.h, Math.min(e.s, BLOB_CACHE_ENTRY_MAX));
    const buf = raw instanceof Readable ? await streamToBuffer(raw) : raw;
    if (!buf) return broken(`파일 '${r.rel}' 을(를) 저장소에서 찾지 못했습니다 — 앱을 다시 저장해 주세요.`);
    const probe = url.search.get("__lively_probe") === "1";
    const out = Buffer.from(buildAppPageHtml(buf.toString("utf8"), { runtime: scripts.runtime, probe: probe ? scripts.probe : null }), "utf8");
    const etag = `"${createHash("sha256").update(out).digest("hex").slice(0, 32)}${gz ? "-gz" : ""}"`;
    const base: Record<string, string> = {
      "Content-Type": type, ETag: etag, "Cache-Control": REVALIDATE, Vary: "Accept-Encoding",
      "Content-Security-Policy": appPageCspMulti({ ...(((c.manifest as { csp?: AppCsp } | null)?.csp ?? {}) as AppCsp), files: await filesCspSource(c.manifest) }),
    };
    if (etagMatches(headers["if-none-match"], etag)) return { status: 304, headers: base };
    return gz ? { status: r.status, headers: { ...base, "Content-Encoding": "gzip" }, body: await gzipCached(etag, out) } : { status: r.status, headers: base, body: out };
  }
  const etag = `"${e.h.slice(0, 32)}${gz ? "-gz" : ""}"`;
  const base: Record<string, string> = { "Content-Type": type, ETag: etag, "Cache-Control": cacheControlFor(r.rel), Vary: "Accept-Encoding", "Accept-Ranges": "none" };
  if (etagMatches(headers["if-none-match"], etag)) return { status: 304, headers: base };
  const data = await d.readBlob(c.kind, e.h, e.s);
  if (!data) return broken(`파일 '${r.rel}' 을(를) 저장소에서 찾지 못했습니다 — 앱을 다시 저장해 주세요.`);
  //  큰 파일은 흘려 보낸다 — 압축·연결은 send() 의 pipeline 이 잇는다(어느 쪽이 끊겨도 나머지를 걷는다 · 오류가 프로세스로 새지 않는다).
  if (data instanceof Readable) {
    return gz ? { status: r.status, headers: { ...base, "Content-Encoding": "gzip" }, stream: data, gzip: true }
      : { status: r.status, headers: { ...base, "Content-Length": String(e.s) }, stream: data };
  }
  return gz ? { status: r.status, headers: { ...base, "Content-Encoding": "gzip" }, body: await gzipCached(etag, data) } : { status: r.status, headers: base, body: data };
}

const gzipAsync = promisify(zlib.gzip);
/** 압축본 캐시 — 지문(ETag)이 키라 무효화가 없다. 같은 화면 파일을 거듭 압축하지 않게(공용 게이트웨이 CPU). */
const gzCache = new Map<string, Buffer>();
let gzBytes = 0;
const GZ_CACHE_MAX = 16 * 1024 * 1024;
async function gzipCached(etag: string, data: Buffer): Promise<Buffer> {
  const hit = gzCache.get(etag);
  if (hit) { gzCache.delete(etag); gzCache.set(etag, hit); return hit; }
  const out = await gzipAsync(data);
  //  같은 파일을 동시에 처음 받은 요청 — 한 벌만 센다(셈이 두 번 늘면 언젠가 넣는 족족 밀려나 캐시가 조용히 꺼진다 · 격리 리뷰 재검토 3).
  const raced = gzCache.get(etag);
  if (raced) return raced;
  gzCache.set(etag, out); gzBytes += out.length;
  while (gzBytes > GZ_CACHE_MAX) {
    const k = gzCache.keys().next();
    if (k.done) break;
    gzBytes -= gzCache.get(k.value)?.length ?? 0;
    gzCache.delete(k.value);
  }
  return out;
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of s) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts);
}

function send(res: express.Response, r: FrontReply): void {
  if (r.server) throw new Error("앱 서버 답(status 0)은 serveAppServer 로 넘겨야 한다 — send 로 보낼 수 없다(#4485)");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  //  #4481 여러 파일 앱 — 파일 바이트 · 흘려 보내기 · 304(본문 없음). 머리(Content-Type · ETag · 캐시)는 r.headers 가 이미 정했다.
  if (r.status === 304) { res.status(304).end(); return; }
  if (r.stream) {
    res.status(r.status);
    //  ★ pipe 가 아니라 pipeline — pipe 는 원본 오류를 넘기지 않아(압축을 끼우면 특히) 처리 안 된 오류가 게이트웨이를 내린다(격리 리뷰 B1).
    //   pipeline 은 어느 쪽이 끊기든(브라우저가 탭을 닫음 · S3 연결이 끊김) 나머지를 destroy 해 S3 연결도 걷는다.
    const done = (err: NodeJS.ErrnoException | null): void => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") logger.warn({ err: err.message }, "[app-front] 앱 파일 흘려 보내기 실패");
    };
    if (r.gzip) pipeline(r.stream, zlib.createGzip(), res, done);
    else pipeline(r.stream, res, done);
    return;
  }
  if (r.body) { res.status(r.status).end(r.body); return; }
  if (r.html !== undefined) { res.status(r.status).type("html").send(r.html); return; }
  res.status(r.status).json(r.json ?? {});
}

/** 본문 읽기(body-parser)의 오류인가 — type 이 붙은 4xx 만. 그 밖의 오류는 감추지 않고 다음(전역 처리 · 로그)으로 넘긴다. */
function isBodyParserError(err: unknown): err is { status: number; type: string } {
  const e = err as { status?: unknown; type?: unknown };
  return typeof e?.type === "string" && typeof e?.status === "number" && e.status >= 400 && e.status < 500;
}

/** web.ts 가 사람 로그인 라우트(세션 교환 등)와 같은 자리 — capability 마운트보다 **먼저** — 에서 부른다. */
export function registerAppFrontRoutes(app: express.Express, deps: () => AppFrontDeps = liveDeps): void {
  const H = (req: express.Request) => req.headers as Record<string, string | string[] | undefined>;
  app.post("/api/app-front/redeem", wrap(async (req, res) => { send(res, await appFrontRedeem(H(req), req.body, deps())); }));
  app.get("/api/app-front/me", wrap(async (req, res) => { send(res, await appFrontMe(H(req), deps())); }));
  app.get("/api/app-front/page", wrap(async (req, res) => {
    const path = (req.query as Record<string, unknown>)?.path;
    const d = deps();
    const r = await appFrontPage(H(req), path, d);
    if (r.server) { await serveAppServer(req, res, r.server, null, path, d.server?.(r.server.tenant.id)); return; }
    send(res, r);
  }));
  //  #4482 같은 주소 API — 본문은 JSON(앱이 Content-Type 을 빠뜨려도 JSON 으로 읽는다 · 쓰기의 출처 검사는 앞단이 이미 했다). 상한은 게이트웨이 REST 와 같다.
  //   전역 express.json(1mb · application/json 만)은 이 라우터보다 먼저 돌아 이미 읽은 본문은 건너뛴다 — 여기 파서는 그 밖의 종류만 읽는다.
  app.all("/api/app-front/lively", express.json({ limit: APP_FRONT_API_BODY_LIMIT, type: () => true }),
    wrap(async (req, res) => { send(res, await appFrontLively(H(req), req.method, (req.query as Record<string, unknown>)?.path, req.body, deps())); }));
  //  본문을 못 읽었다(깨진 JSON · 큼) — 파서의 오류는 wrap 밖이라 Express 기본 HTML 400 이 나갔다(격리 리뷰). 이 길의 답은 늘 JSON 이다.
  //   본문 파서의 오류(type 이 붙은 4xx)만 여기서 답한다 — 그 밖의 오류는 감추지 않고 다음(전역 처리 · 로그)으로 넘긴다.
  app.use("/api/app-front/lively", (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent || !isBodyParserError(err)) { next(err); return; }
    const e = err;
    const big = e.status === 413 || e.type === "entity.too.large";
    send(res, { status: big ? 413 : 400, json: { error: big ? "본문이 너무 큽니다(1MB 까지)" : "본문을 JSON 으로 읽지 못했습니다", code: big ? "body_too_large" : "bad_body" } });
  });
}

/**
 * #4485 앱 서버의 쓰기 요청(POST · PUT · PATCH · DELETE) — 앞단이 본문째(4MB 까지) 넘긴다. 본문을 **날것 그대로** 받아야 해서(앱이 받는 바이트)
 *  전역 express.json() 보다 먼저 마운트한다(index.ts — 서명 주소 · 웹훅과 같은 자리). 문 · 판정은 화면 길(/page)과 같다.
 *  서버를 선언하지 않은 판이면 405 — 화면(정적) 주소에는 쓰기를 받을 곳이 없다.
 */
export async function appFrontServerWrite(req: express.Request, res: express.Response, d: AppFrontDeps = liveDeps()): Promise<void> {
  const path = (req.query as Record<string, unknown>)?.path;
  const f = await frontTarget(req.headers as Record<string, string | string[] | undefined>, d, false);
  if (!f.ok) { send(res, f.reply); return; }
  const t = f.target;
  if (!(await viewDeclaresServer(t.app, t.view === "published", d, t.tenant.id))) {
    res.setHeader("Allow", "GET, HEAD");
    send(res, { status: 405, json: { error: "method_not_allowed", message: "이 앱은 서버가 없어 쓰기 요청을 받지 않습니다 — 화면에서 /_lively/* API 를 쓰세요." } });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  await serveAppServer(req, res, t, body, path, d.server?.(t.tenant.id));
}

/** index.ts 가 전역 JSON 파서보다 먼저 붙인다 — 본문을 날것(Buffer)으로 받는다. */
export function appFrontServerRouter(deps: () => AppFrontDeps = liveDeps): Array<express.RequestHandler | express.ErrorRequestHandler> {
  return [
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      //  쓰기 메서드만 — GET · HEAD 는 화면 길(/page)이 맡는다(앞단도 그렇게 보낸다).
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) { res.status(405).setHeader("Allow", "POST, PUT, PATCH, DELETE"); res.json({ error: "method_not_allowed" }); return; }
      next();
    },
    //  ★ inflate: false — 압축 본문을 풀면 «보낸 바이트 그대로» 가 아니게 되고(풀린 본문 + Content-Encoding: gzip 이 함께 가 앱이 다시 풀다 실패한다 · 격리 리뷰)
    //   압축 본문은 415 로 받지 않는다. 브라우저는 요청 본문을 압축하지 않는다.
    express.raw({ type: () => true, limit: APP_SERVER_BODY_LIMIT, inflate: false }),
    wrap(async (req, res) => { await appFrontServerWrite(req, res, deps()); }),
    //  본문을 못 읽었다(4MB 넘음 · 압축 · 도중에 끊김) — 파서의 오류는 wrap 밖이라 Express 기본 HTML 이 나간다. 이 길의 답도 JSON 이다(/lively 와 같은 규칙).
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent || !isBodyParserError(err)) { next(err); return; }
      if (err.status === 413 || err.type === "entity.too.large") {
        send(res, { status: 413, json: { error: "body_too_large", message: "본문이 너무 큽니다(4MB 까지) — 큰 파일은 파일 저장 API(서명 주소)로 올리세요." } });
      } else if (err.status === 415 || err.type === "encoding.unsupported") {
        send(res, { status: 415, json: { error: "unsupported_encoding", message: "압축한 본문(Content-Encoding)은 받지 않습니다 — 압축하지 않고 보내세요." } });
      } else {
        send(res, { status: 400, json: { error: "bad_body", message: "본문을 읽지 못했습니다" } });
      }
    },
  ];
}

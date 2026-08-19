// 앱 레지스트리 capability (#1780, design D2) — 조회 + 멤버 grant + enabled 토글 + 설치/제거(관리자).
//  설치/제거(org_app_install/remove)는 패키지 소스(git·로컬 경로)를 스테이지 디렉터리로 추출한 뒤
//   loader→installLoadedApp(builtin 시더와 공용 코어)로 저널드 전개한다. 업로드(tar)는 후속(멀티파트 라우트 선행).
//  경로 prefix = /api/ui/apps.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import * as store from "../org/store/apps.js";
import { parseAppManifest } from "../apps/manifest.js";
import { resolveGrant } from "../apps/grant.js";
import { loadAppPackage } from "../apps/loader.js";
import { stageAppSource, parseAppSource } from "../apps/install-source.js";
import { installLoadedApp } from "../apps/install-run.js";
import { makeDeployDeps } from "../apps/deploy.js";

const actorOf = (u: { userId?: string; email?: string } | undefined): string => u?.userId || u?.email || "unknown";
const wctx = (u: { userId?: string; email?: string } | undefined, ctx?: { source?: string }) => ({ actor: actorOf(u), source: ctx?.source ?? "web" });

function appId(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new HttpError(400, "app_id 가 필요합니다");
  return s;
}

// ── 앱 목록(설치된 앱) ──
const appsIndex: Capability = {
  name: "org_apps",
  title: "설치된 앱 목록",
  description: "이 워크스페이스에 설치된 앱 목록(id·제목·버전·상태·활성). 런치패드·앱 관리 화면이 소비.",
  scope: null,
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps"], parse: () => ({}) }],
  },
  handler: async () => ({ apps: await store.listApps() }),
};

// ── 앱 상세(+구성요소) ──
const appGet: Capability = {
  name: "org_app_get",
  title: "앱 상세",
  description: "앱 1건 + 전개된 구성요소(component) 목록. app_id 로 조회.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    return { app, components: await store.listComponents(id) };
  },
};

// ── 앱 활성/비활성 토글(관리자) ──
//  ⚠ 비파괴 토글 — 새 스폰만 막고, 도는 세션·물질화된 자산·살아있는 토큰엔 안 닿는다(design R2-6). 즉시 중단은 별도.
const appSetEnabled: Capability = {
  name: "org_app_set_enabled",
  title: "앱 활성/비활성",
  description: "앱을 켜거나 끈다(비파괴). 끄면 새 앱 세션 스폰만 막힌다 — 이미 도는 세션·설치된 구성요소는 그대로(즉시 중단 아님).",
  scope: "admin",
  input: { app_id: z.string(), enabled: z.boolean() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/enabled"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, enabled: (req.body as Record<string, unknown>)?.enabled !== false }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    if (!(await store.getApp(id))) throw new HttpError(404, `앱 없음: ${id}`);
    await store.setAppEnabled(id, !!input.enabled, wctx(user, ctx));
    return { ok: true, app_id: id, enabled: !!input.enabled };
  },
};

// ── 멤버 grant(동의) — 이 앱을 내 자격으로 쓰겠다 ──
//  scope null(본인). 부여 scope/tool 은 매니페스트 선언의 **부분집합**만(resolveGrant, design D3).
const appGrant: Capability = {
  name: "me_app_grant",
  title: "앱 사용 동의",
  description: "이 앱을 내 자격으로 쓰겠다고 동의한다. 부여되는 권한(scope·도구)은 앱이 선언한 상한의 부분집합만 — scopes/tools 를 주면 그만큼만, 안 주면 앱 선언 전체.",
  scope: null,
  input: { app_id: z.string(), scopes: z.array(z.string()).optional(), tools: z.array(z.string()).optional() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/grant"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { app_id: (req.params as Record<string, string>)?.id, scopes: b.scopes, tools: b.tools };
      } }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    const m = parseAppManifest(app.manifest);
    const requested = (input.scopes !== undefined || input.tools !== undefined)
      ? { scopes: input.scopes as string[] | undefined, tools: input.tools as string[] | undefined }
      : undefined;
    const g = resolveGrant(m, requested);
    const row = await store.upsertGrant(id, actorOf(user), g.scopes, g.tools, wctx(user, ctx));
    return { granted: row };
  },
};

const appRevoke: Capability = {
  name: "me_app_revoke",
  title: "앱 사용 동의 철회",
  description: "이 앱에 준 내 동의를 철회한다. 이후 이 앱으로는 내 자격의 새 세션이 열리지 않는다.",
  scope: null,
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/revoke"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user) => {
    const id = appId(input.app_id);
    await store.revokeGrant(id, actorOf(user));
    return { ok: true, app_id: id };
  },
};

// ── 앱 설치/업데이트(관리자) — 패키지 소스 추출 → 로드 → 저널드 전개(#1780 설치 verb) ──
//  builtin 시더가 쓰는 공용 코어(installLoadedApp)를 그대로 태운다 — git/로컬경로만 다르고 설치 시맨틱은 동일.
//  같은 앱의 동시 설치/제거는 withAppInstallLock 으로 직렬화(반쯤 전개된 조인 덮어쓰기 방지, R2-5).
const appInstall: Capability = {
  name: "org_app_install",
  title: "앱 설치·업데이트",
  description: "패키지 소스에서 앱을 설치(같은 id 면 업데이트)한다. source.kind='git'(https:// url·선택 ref) 또는 'path'(게이트웨이 로컬 경로). 저널드 2-phase — 실패 시 역순 보상. 관리자.",
  scope: "admin",
  input: { source: z.object({ kind: z.enum(["git", "path"]), url: z.string().optional(), ref: z.string().optional(), path: z.string().optional() }) },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/install"], parse: (req) => ({ source: (req.body as Record<string, unknown>)?.source }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const source = parseAppSource(input.source);
    const staged = await stageAppSource(source);
    try {
      const loaded = await loadAppPackage(staged.dir);
      const outcome = await store.withAppInstallLock(loaded.manifest.id, () =>
        installLoadedApp(loaded, staged.meta, wctx(user, ctx)));
      const app = await store.getApp(outcome.id);
      return { app, created: outcome.created, components: outcome.components };
    } finally {
      await staged.cleanup();
    }
  },
};

// ── 앱 제거(관리자) — 전개물 회수 + 레지스트리 삭제 ──
//  전개된 대상(하네스 자산·크론·툴·호스트 병합)은 CASCADE 밖(별도 스토어)이라 **먼저 reclaim** 한 뒤 앱 행을 지운다
//  (조인 component/grant 는 deleteApp 이 CASCADE). builtin 은 제거해도 부팅 시 재시드되므로 막고 enabled 토글로 안내.
const appRemove: Capability = {
  name: "org_app_remove",
  title: "앱 제거",
  description: "앱과 그 전개물(하네스 자산·크론·툴·호스트)을 회수하고 레지스트리에서 삭제한다. builtin(코드 소유) 앱은 제거 대신 org_app_set_enabled 로 끈다(부팅 재시드). 관리자.",
  scope: "admin",
  input: { app_id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/remove"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }],
  },
  handler: async (input: Record<string, unknown>, user, ctx) => {
    const id = appId(input.app_id);
    return store.withAppInstallLock(id, async () => {
      const app = await store.getApp(id);
      if (!app) throw new HttpError(404, `앱 없음: ${id}`);
      const src = (app.source ?? {}) as { kind?: string };
      if (src.kind === "builtin") throw new HttpError(409, `builtin 앱 '${id}' 은 제거 대신 org_app_set_enabled 로 끄세요(부팅 시 재시드됩니다)`);
      const deps = makeDeployDeps(id, wctx(user, ctx));
      const comps = await store.listComponents(id);
      for (const c of comps) {
        try { await deps.reclaim({ kind: c.kind, ref: c.ref, orig_name: c.orig_name ?? undefined }); }
        catch { /* best-effort — 조인은 아래 delete 로 CASCADE, 저널 삭제로 스위퍼도 무관 */ }
      }
      await store.deleteApp(id, wctx(user, ctx));
      return { ok: true, removed: id, components: comps.length };
    });
  },
};

// ── 앱 활동 관측(관리자) — mcp_call_log.app 집계. design D3-5(관측 전용, 권한 판정 불사용) ──
//  앱 세션/UI 가 자기 자격으로 부른 도구를 앱별·도구별로 집계(호출수·성공/실패·최근시각). 인자·actor 는 노출 안 함.
const appActivityCap: Capability = {
  name: "org_app_activity",
  title: "앱 활동 로그",
  description: "설치된 앱들이 자기 자격으로 호출한 도구 활동을 앱별·도구별로 집계한다(호출수·성공/실패·최근시각). app_id 를 주면 그 앱만, days 로 기간(기본 7·최대 365). 관측 전용. 관리자.",
  scope: "admin",
  input: { app_id: z.string().optional(), days: z.number().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/app-activity"], parse: (req) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      return { app_id: q.app_id, days: q.days == null ? undefined : Number(q.days) };
    } }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = input.app_id ? appId(input.app_id) : null;
    const days = input.days != null && Number.isFinite(Number(input.days)) ? Number(input.days) : 7;
    return { activity: await store.appActivity(id, days) };
  },
};

// ── 앱 UI 페이지 서빙(#1780 PR5) — 샌드박스 srcdoc iframe 용 entry HTML ──
//  정적 URL 이 아니라 **인증 API**로 준다: 앱 UI 는 호스트가 fetch → sandbox="allow-scripts" srcdoc 으로 실어
//  오리진 격리(불투명)·네트워크 없음. tools/call 은 postMessage 로 호스트가 앱 grant 로 제약(PR5b). scope null —
//  설치된(active·enabled) 앱의 UI 는 워크스페이스 멤버가 열 수 있다(브리지 없이는 아무 부작용 없는 정적 표시).
const appUi: Capability = {
  name: "org_app_ui",
  title: "앱 UI 페이지",
  description: "설치된 앱의 UI 페이지/위젯 entry HTML 을 준다(샌드박스 iframe srcdoc 용). page 미지정이면 첫 페이지. 앱이 active·enabled 여야 한다.",
  scope: null,
  input: { app_id: z.string(), page: z.string().optional() },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/apps/:id/ui", "/api/ui/apps/:id/ui/:page"],
      parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, page: (req.params as Record<string, string>)?.page }) }],
  },
  handler: async (input: Record<string, unknown>) => {
    const id = appId(input.app_id);
    const app = await store.getApp(id);
    if (!app) throw new HttpError(404, `앱 없음: ${id}`);
    if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${id}' 이 활성 상태가 아닙니다`);
    const pages = await store.listUiAssets(id);
    if (pages.length === 0) throw new HttpError(404, `앱 '${id}' 에 UI 페이지가 없습니다`);
    const key = input.page ? String(input.page) : pages[0].page_key;
    const a = await store.getUiAsset(id, key);
    if (!a) throw new HttpError(404, `UI 페이지 없음: ${key}`);
    return { app_id: id, page_key: a.page_key, kind: a.kind, title: a.title, html: a.html, pages };
  },
};

export const appCapabilities: Capability[] = [appsIndex, appGet, appSetEnabled, appGrant, appRevoke, appInstall, appRemove, appActivityCap, appUi];

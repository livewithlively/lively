// 앱 레지스트리 capability (#1780, design D2) — 조회 + 멤버 grant + enabled 토글.
//  ⚠ 설치/업데이트/제거(org_app_install/update/remove)는 **패키지 소스 추출·harness FS 스캔이 선행**이라
//   별도 트랙(후속 태스크). 여기선 스토어 위에 순수하게 얹히는 조회·grant·enabled 만 노출한다.
//  경로 prefix = /api/ui/apps.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import * as store from "../org/store/apps.js";
import { parseAppManifest } from "../apps/manifest.js";
import { resolveGrant } from "../apps/grant.js";

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

export const appCapabilities: Capability[] = [appsIndex, appGet, appSetEnabled, appGrant, appRevoke];

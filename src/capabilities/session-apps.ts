// 세션에 앱 붙이기·떼기 capability (#4225) — MCP+REST co-exposed(같은 handler).
//
//  사람은 세션 화면에서(곁칸 [앱] 을 누르면 지금 세션 오른쪽에 붙고, 앱 칸의 × 로 뗀다), AI 는 같은 일을 도구로 한다
//  («장표 앱을 붙일까요?» → 사람이 좋다고 하면 session_app_attach). session_id 생략 = 이 요청을 보낸 세션 자신
//  (session_set_project·session_rename 과 같은 규약 — 게이트웨이가 x-lively-session 으로 식별).
//
//  붙이기·떼기는 **세션 주인만**. 붙은 목록은 그 세션에 들어갈 수 있는 사람(주인·초대받은 사람)이 본다.
//  붙이려면 그 사람이 그 앱에 **동의(grant)** 해 두었어야 한다 — 붙이기가 동의를 대신하지 않는다(AI 가 붙여도
//  사람이 동의한 범위를 넘지 못한다). 동의 창은 웹이 붙이기 전에 띄운다(web/v2/app-session.ts ensureAppGrant).
//  판정·저장·알림의 실제는 apps/session-apps.ts — 여기는 입력과 표면만.
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getActiveGrant, type OrgApp } from "../org/store/apps.js";
import { canAttach } from "../terminal/terminal-sessions.js";
import {
  attachAppRow, detachAppRow, listAttachedApps, publishAppEvent, requireSessionOwner, requireUsableApp,
  type SessionAppRow,
} from "../apps/session-apps.js";

const SID = z.string().max(128).optional().describe("대상 세션 id — 보통 생략한다(기본 = 이 요청을 보낸 세션 자신)");
const APP = z.string().min(1).max(128).describe("앱 id(org_apps 의 id)");

const sidOf = (input: { session_id?: string }, ctx?: CapabilityCtx): string => {
  const sid = String(input.session_id ?? "").trim() || String(ctx?.session ?? "").trim();
  if (!sid) throw new HttpError(400, "세션을 특정할 수 없습니다 — 라이블리 세션 안에서 호출하거나 session_id 를 넘기세요");
  return sid;
};
const me = (u: LivelyUser): string => {
  const id = u?.userId || "";
  if (!id) throw new HttpError(401, "인증이 필요합니다");
  return id;
};

interface ManifestView {
  ui?: { pages?: Array<{ key?: string; title?: string }> };
  data?: { tables?: Array<{ name?: string; columns?: unknown[] }> };
  runtime?: unknown;
}

/** 붙은 앱 한 줄 — 화면(앱 칸)이 그리고, AI 가 무엇을 읽고 쓸 수 있는지 아는 재료. */
export function describeAttached(row: SessionAppRow, app: OrgApp | null): Record<string, unknown> {
  const m = (app?.manifest ?? {}) as ManifestView;
  const pages = (m.ui?.pages ?? []).map((p) => ({ key: String(p.key ?? ""), title: String(p.title ?? p.key ?? "") })).filter((p) => p.key);
  const tables = (m.data?.tables ?? []).map((t) => ({ name: String(t.name ?? ""), columns: Array.isArray(t.columns) ? t.columns : [] })).filter((t) => t.name);
  return {
    app_id: row.app_id,
    title: app?.title || row.app_id,
    attached_at: row.attached_at,
    attached_by: row.member_id,
    usable: !!app && app.status === "active" && app.enabled,
    has_ui: pages.length > 0,
    pages,
    tables,
  };
}

async function describeAll(rows: SessionAppRow[]): Promise<Array<Record<string, unknown>>> {
  return Promise.all(rows.map(async (r) => describeAttached(r, await getApp(r.app_id).catch(() => null))));
}

const HINT = "붙어 있는 동안 이 세션에서 store_query·store_insert·store_update·store_delete·store_tables 로 그 앱의 테이블을 읽고 쓸 수 있다"
  + "(붙은 앱이 하나면 app_id 생략 가능). 집계·조인·여러 행 쓰기는 store_sql 로 SQL 한 문장(워크스페이스가 만든 앱에서만). "
  + "사람도 세션 오른쪽에서 같은 앱 화면을 보고 있고, 쓴 내용은 그 화면에 바로 반영된다.";

const sessionApps: Capability = {
  name: "session_apps",
  title: "세션에 붙은 앱",
  description:
    "이 세션에 지금 붙어 있는 앱(세션 오른쪽 앱 칸) 목록 — 각 앱의 제목·화면 유무·데이터 테이블(이름·컬럼). "
    + "붙은 앱의 테이블은 store_* 로 읽고 쓴다(붙은 앱이 하나면 app_id 생략 가능). session_id 생략 = 이 세션 자신.",
  scope: null,
  input: { session_id: SID },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/terminal/sessions/:id/apps"], parse: (req) => ({ session_id: String(req.params?.id ?? "") }) }],
  },
  handler: async (input: { session_id?: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = sidOf(input, ctx);
    if (!(await canAttach(sid, me(user)))) throw new HttpError(403, "이 세션에 들어갈 수 있는 사람만 붙은 앱을 볼 수 있습니다");
    const apps = await describeAll(await listAttachedApps(sid));
    return { session_id: sid, apps, ...(apps.length ? { hint: HINT } : {}) };
  },
};

const sessionAppAttach: Capability = {
  name: "session_app_attach",
  title: "세션에 앱 붙이기",
  description:
    "이 세션 오른쪽에 앱을 붙인다 — 붙어 있는 동안 이 세션의 AI 가 그 앱의 테이블을 store_* 로 읽고 쓰고, 사람은 같은 앱 화면을 본다. "
    + "사람이 붙여 달라고 했거나 제안에 동의했을 때 부른다. 세션 주인만, 그 앱에 사용 동의(grant)가 있어야 한다(없으면 403 — 사람이 앱을 열어 동의). "
    + "이미 붙어 있으면 그대로 둔다(멱등). session_id 생략 = 이 세션 자신.",
  scope: null,
  input: { app_id: APP, session_id: SID },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/sessions/:id/apps/attach"],
      parse: (req) => ({ session_id: String(req.params?.id ?? ""), app_id: String(((req.body ?? {}) as Record<string, unknown>).app_id ?? "") }) }],
  },
  handler: async (input: { app_id: string; session_id?: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = sidOf(input, ctx);
    const member = me(user);
    const appId = String(input.app_id ?? "").trim();
    if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
    await requireSessionOwner(sid, member);
    const app = requireUsableApp(await getApp(appId), appId);
    if (!(await getActiveGrant(appId, member))) {
      throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다 — 사람이 앱을 한 번 열어 동의해야 붙일 수 있습니다`);
    }
    const fresh = await attachAppRow(sid, appId, member);
    if (fresh) publishAppEvent(member, { kind: "attach", app_id: appId, session: sid, source: ctx?.source });
    const row = (await listAttachedApps(sid)).find((r) => r.app_id === appId);
    return { session_id: sid, attached: fresh, app: row ? describeAttached(row, app) : null, hint: HINT };
  },
};

const sessionAppDetach: Capability = {
  name: "session_app_detach",
  title: "세션에서 앱 떼기",
  description:
    "이 세션에서 앱을 뗀다 — 그 순간부터 이 세션은 그 앱의 테이블을 못 쓰고, 세션 오른쪽 앱 칸이 닫힌다. 앱의 데이터는 그대로 남는다. "
    + "세션 주인만. 이미 떼어져 있으면 detached:false. session_id 생략 = 이 세션 자신.",
  scope: null,
  input: { app_id: APP, session_id: SID },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/sessions/:id/apps/detach"],
      parse: (req) => ({ session_id: String(req.params?.id ?? ""), app_id: String(((req.body ?? {}) as Record<string, unknown>).app_id ?? "") }) }],
  },
  handler: async (input: { app_id: string; session_id?: string }, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = sidOf(input, ctx);
    const member = me(user);
    const appId = String(input.app_id ?? "").trim();
    if (!appId) throw new HttpError(400, "app_id 가 필요합니다");
    await requireSessionOwner(sid, member);
    const detached = await detachAppRow(sid, appId);
    if (detached) publishAppEvent(member, { kind: "detach", app_id: appId, session: sid, source: ctx?.source });
    return { session_id: sid, detached };
  },
};

export const sessionAppsCapabilities: Capability[] = [sessionApps, sessionAppAttach, sessionAppDetach];

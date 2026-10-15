// 세션에 앱 붙이기·떼기 capability (#4225) — MCP+REST co-exposed(같은 handler).
//
//  사람은 세션 화면에서(곁칸 [앱] 을 누르면 지금 세션 오른쪽에 붙고, 앱 칸의 × 로 뗀다), AI 는 같은 일을 도구로 한다
//  («장표 앱을 붙일까요?» → 사람이 좋다고 하면 session_app_attach). session_id 생략 = 이 요청을 보낸 세션 자신
//  (session_set_project·session_rename 과 같은 규약 — 게이트웨이가 x-lively-session 으로 식별).
//
//  붙이기·떼기·붙은 목록 보기 모두 그 세션에 **들어갈 수 있는 사람**(연 사람 · 초대받은 사람)이 한다(처음엔 붙이기·떼기가 주인만이었다 — apps/session-apps.ts 머리말).
//  붙이려면 그 사람이 그 앱에 **동의(grant)** 해 두었어야 한다 — 붙이기가 동의를 대신하지 않는다(AI 가 붙여도
//  사람이 동의한 범위를 넘지 못한다). 동의 창은 웹이 붙이기 전에 띄운다(web/v2/app-session.ts ensureAppGrant).
//  판정·저장·알림의 실제는 apps/session-apps.ts — 여기는 입력과 표면만.
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { getApp, getActiveGrant, getAppVersionHead, type OrgApp } from "../org/store/apps.js";
import { canSeeApp, isEmptyDraftApp, type Viewer } from "../apps/visibility.js";
import { viewAppFor } from "../apps/app-view.js";
import { canAttach } from "../terminal/terminal-sessions.js";
import {
  attachAppRow, detachAppRow, listAttachedApps, publishAppEventToSession, requireSessionParticipant, requireUsableApp,
  type SessionAppRow,
} from "../apps/session-apps.js";
import { syncSessionAppFolders, APP_FOLDER_REL, type FolderSync } from "../apps/session-app-folders.js";   // #4684 — 앱 폴더
import { sessionEnsureConfigured } from "../terminal/session-tmux.js";

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
  agent?: { instructions?: unknown; reinject_every?: unknown };
}

/**
 * 붙은 앱 한 줄 — 화면(앱 칸)이 그리고, AI 가 무엇을 읽고 쓸 수 있는지 아는 재료.
 *  #4595 — `instructions`(매니페스트 agent.instructions · 없으면 null)와 `reinject_every` 를 함께 실어, 시드 훅
 *   session-apps-inject 가 테이블 안내 뒤에 **그 앱의 행동 규칙**을 붙이게 한다(종전엔 테이블 이름만 알려 AI 가 앱의
 *   목적을 짐작해야 했다). `version`·`source_kind`·`overrides_builtin` 은 앱 탭이 「N판 · 워크스페이스 판」을 그리는 재료(#4600).
 */
export function describeAttached(row: SessionAppRow, app: OrgApp | null, savedBy: string | null = null, opts: { folders?: boolean } = {}): Record<string, unknown> {
  const m = (app?.manifest ?? {}) as ManifestView;
  const pages = (m.ui?.pages ?? []).map((p) => ({ key: String(p.key ?? ""), title: String(p.title ?? p.key ?? "") })).filter((p) => p.key);
  const tables = (m.data?.tables ?? []).map((t) => ({ name: String(t.name ?? ""), columns: Array.isArray(t.columns) ? t.columns : [] })).filter((t) => t.name);
  const instructions = typeof m.agent?.instructions === "string" && m.agent.instructions.trim() ? m.agent.instructions : null;
  const every = Number(m.agent?.reinject_every);
  const source = (app?.source ?? {}) as { kind?: unknown; overrides_builtin?: unknown };
  return {
    app_id: row.app_id,
    title: app?.title || row.app_id,
    attached_at: row.attached_at,
    attached_by: row.member_id,
    usable: !!app && app.status === "active" && app.enabled,
    has_ui: pages.length > 0,
    pages,
    tables,
    instructions,
    reinject_every: instructions && Number.isInteger(every) && every > 0 ? every : null,
    version: app?.version ?? null,
    source_kind: typeof source.kind === "string" ? source.kind : null,
    overrides_builtin: source.overrides_builtin === true,
    // #4595 신뢰 경계 — 지침이 **누구 글인지** 훅이 말해야 한다. 다른 구성원이 app_save 로 바꾼 지침이 내 AI 에 「앱 지침」이라는
    //  이름으로 들어가는 자리라, 판 번호와 저장한 사람을 함께 실어 훅이 「이 워크스페이스에서 고친 앱(N판 · 저장: 누구)」 로 적는다.
    version_no: app?.current_version_no ?? null,
    saved_by: savedBy,
    //  #4684 — 매니지드 세션에서 이 앱의 폴더가 보이는 자리(작업 폴더 기준). 실제로 붙었는지는 세션 안에서 본다(훅이 있는지 확인하고
    //   알린다 — 이 기능 전에 뜬 세션·작업 폴더에 링크가 있는 세션엔 없다). 셀프호스트엔 없다(null).
    folder: opts.folders ? `${APP_FOLDER_REL}/${row.app_id}` : null,
  };
}

/** 한 줄 + 그 판을 저장한 사람(org_app_version.saved_by). 판 이력이 없는 앱(릴리스 그대로)은 null. 조회 실패도 null — 목록을 막지 않는다.
 *  #4667 — **보는 사람의 판**으로 그린다: 공개 앱에 남의 초안이 있으면 공개 판의 제목·화면·표·지침(훅이 이 세션 AI 에 싣는 글)이다.
 *   못 보게 된 앱(공개를 거둔 남의 앱)은 쓸 수 없는 줄(usable false)로 — 떼기는 그대로 된다. */
async function describeOne(row: SessionAppRow, app: OrgApp | null, who: Viewer): Promise<Record<string, unknown>> {
  if (app && !canSeeApp(app, who)) return { ...describeAttached(row, null), usable: false, hidden: true };
  const shown = app ? (await viewAppFor(app, who)).app : null;
  const no = shown?.current_version_no;
  //  #4481 저장한 사람만 본다 — 판 머리만(파일 내용을 읽지 않는다).
  const ver = shown && no != null ? await getAppVersionHead(shown.id, no).catch(() => null) : null;
  return describeAttached(row, shown, ver?.saved_by ?? null, { folders: sessionEnsureConfigured() });
}

/** 붙이기·떼기 뒤 앱 폴더의 상태(#4684). */
export type FolderState = "attached" | "detached" | "failed" | "after-restart" | "next-start" | "none" | "error";

/** 붙이기·떼기 응답에 싣는 앱 폴더 결과(#4684, 응답의 folder_status) — AI 가 «폴더가 지금 보이나» 를 안다. */
export function folderNote(r: FolderSync, appId: string, attached: boolean): { state: FolderState; path?: string; why?: string; note?: string } {
  const p = `${APP_FOLDER_REL}/${appId}`;
  if (r.applied) {
    //  접점이 없는 컨테이너 — 붙일 수도 뗄 것도 없다. 붙이기면 다시 뜰 때 붙고, 떼기면 원래 안 보였다.
    if (!r.supported) return attached
      ? { state: "after-restart", path: p, note: "이 세션은 앱 폴더 기능 전에 떴거나 작업 폴더에 링크가 있어 지금은 폴더가 안 보인다 — 세션이 다시 뜨면 붙는다" }
      : { state: "detached", path: p };
    const here = r.bound.includes(appId);
    const failed = r.failed.find((f) => f.app === appId);
    if (attached && !here) return { state: "failed", path: p, why: failed?.why ?? "붙일 수 있는 조건이 아니다(앱 상태 · 세션 주인이 볼 수 있는가 · 붙인 사람의 동의)" };
    if (!attached && here) return { state: "failed", path: p, ...(failed ? { why: failed.why } : {}) };
    return { state: attached ? "attached" : "detached", path: p };
  }
  if (r.reason === "not-managed") return { state: "none" };
  if (r.reason === "not-running") return { state: "next-start", note: "세션 컨테이너가 떠 있지 않다 — 다음에 뜰 때 맞춘다" };
  return { state: "error", ...(r.detail ? { why: r.detail } : {}) };
}

async function describeAll(rows: SessionAppRow[], who: Viewer): Promise<Array<Record<string, unknown>>> {
  return Promise.all(rows.map(async (r) => describeOne(r, await getApp(r.app_id).catch(() => null), who)));
}

const viewerOf = (u: LivelyUser): Viewer => ({ userId: me(u), scopes: u?.scopes ?? [] });

const HINT = "붙어 있는 동안 이 세션에서 store_query·store_insert·store_update·store_delete·store_tables 로 그 앱의 테이블을 읽고 쓸 수 있다"
  + "(붙은 앱이 하나면 app_id 생략 가능). 집계·조인·여러 행 쓰기는 store_sql 로 SQL 한 문장(워크스페이스가 만든 앱에서만). "
  + "사람도 세션 오른쪽에서 같은 앱 화면을 보고 있고, 쓴 내용은 그 화면에 바로 반영된다. "
  + "folder 가 있으면 그 앱의 파일 폴더가 작업 폴더 아래 그 자리에 보인다(읽고 쓰기 — 워크스페이스의 그 앱 폴더 원본이고, 이 세션에 들어온 사람 모두가 본다).";

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
    const apps = await describeAll(await listAttachedApps(sid), viewerOf(user));
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
    await requireSessionParticipant(sid, member);
    const who = viewerOf(user);
    //  #4667 — 남이 만들고 있는(나만 보는) 앱은 없는 앱과 같다 · 아직 첫 판이 없는 예약 앱은 붙일 것이 없다.
    const found = await getApp(appId);
    if (found && (!canSeeApp(found, who) || isEmptyDraftApp(found))) throw new HttpError(404, `앱 없음: ${appId}`);
    const app = requireUsableApp(found, appId);
    if (!(await getActiveGrant(appId, member))) {
      throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다 — 사람이 앱을 한 번 열어 동의해야 붙일 수 있습니다`);
    }
    const fresh = await attachAppRow(sid, appId, member);
    if (fresh) publishAppEventToSession(member, sid, { kind: "attach", app_id: appId, session: sid, source: ctx?.source });
    //  #4684 — 앱 폴더를 지금 세션에 붙인다(이미 붙어 있었어도 맞춘다 — 지난번에 못 붙었으면 여기서 낫는다). 실패해도 붙이기는 된 것이다.
    const folder_status = folderNote(await syncSessionAppFolders(sid), appId, true);
    const row = (await listAttachedApps(sid)).find((r) => r.app_id === appId);
    return { session_id: sid, attached: fresh, app: row ? await describeOne(row, app, who) : null, folder_status, hint: HINT };
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
    await requireSessionParticipant(sid, member);
    const detached = await detachAppRow(sid, appId);
    if (detached) publishAppEventToSession(member, sid, { kind: "detach", app_id: appId, session: sid, source: ctx?.source });
    //  #4684 — 앱 폴더도 뗀다(그 순간부터 경로로는 안 보인다).
    const folder_status = folderNote(await syncSessionAppFolders(sid), appId, false);
    return { session_id: sid, detached, folder_status };
  },
};

export const sessionAppsCapabilities: Capability[] = [sessionApps, sessionAppAttach, sessionAppDetach];

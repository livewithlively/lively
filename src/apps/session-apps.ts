// 세션에 붙은 앱 (#4225) — 일반 세션이 앱을 **붙였다 뗀다**. 붙어 있는 동안만 그 세션의 AI 가 그 앱 테이블을 읽고 쓴다.
//
// ── 왜 앱 세션과 따로인가 ─────────────────────────────────────────────────────
//  앱 세션(#1780)은 «앱이 연 세션»이다 — 토큰에 app_id 가 구워져 있고 세션 내내 그 앱의 것이다.
//  9/21 회의의 방향은 반대다: 세션이 먼저 있고, AI 가(같이 일하는 사람이) 필요할 때 앱을 띄워 쓰고 다 쓰면 뗀다
//  («기능에 맥락이 속하는 게 아니라 맥락에 기능이 속한다»). 그래서 토큰을 바꾸지 않고 **세션–앱 연결 기록**을 둔다.
//
// ── 판정 (계획 지식 crm-dogfood-app-builder-plan-4200 §6-4 e) ───────────────────
//  store_* 가 앱 principal 없이 오면 여기서 본다: ① 토큰의 사람이 요청이 말한 세션(x-lively-session)에 **들어갈 수 있는 사람**(연 사람 · 초대받은 사람)인가
//   ② 그 세션에 그 앱이 **지금** 붙어 있나 ③ 그 사람이 그 앱에 동의(grant)했고 그 도구가 동의 범위 안인가.
//  셋 다 **매 호출** 다시 읽는다(캐시 없음) — 떼는 순간부터 막혀야 하기 때문이다. 조회 셋은 전부 PK·부분 인덱스라 싸다.
//  ⚠ x-lively-session 은 형식만 검증된 자기주장이다(CapabilityCtx.session 주석). 그래서 ①이 필요하다 —
//   남의 세션 id 를 말해도 그 세션에 들어갈 수 없는 사람이면 그 세션에 붙은 앱을 못 쓴다.
//  ★ 처음엔 «주인만» 이었다(세션 하나에 사람 하나를 전제로 만들었다). 초대받아 같이 일하는 사람이 앱을 못 붙이고 못 쓰는 것은
//   의도가 아니라 빠진 경우였다(원준 2026-10-11 «초대받은 세션에서 못 하게 할 이유가 뭐임») — 들어갈 수 있는 사람이면 된다.
//   ③(그 사람 자신의 동의)이 사람마다 따로라, 초대받은 사람도 제가 동의한 앱 · 범위까지만 쓴다.
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { itemsPool } from "../db/client.js";
import { getApp, getActiveGrant, type OrgApp, type AppGrantRow } from "../org/store/apps.js";
import { getSessionState } from "../sessions/session-state.js";
import { getOpt } from "../terminal/tmux-exec.js";
import { decideAppTool } from "./principal.js";
import { canSeeApp } from "./visibility.js";
import { publishNotify, type NotifyAppEvent } from "../v6/notify-bus.js";
import { hereSlug } from "../v6/notify-scope.js";

export interface SessionAppRow {
  session_id: string;
  app_id: string;
  member_id: string;
  attached_at: string;
}

function rowOf(r: Record<string, unknown>): SessionAppRow {
  return {
    session_id: String(r.session_id), app_id: String(r.app_id), member_id: String(r.member_id),
    attached_at: r.attached_at instanceof Date ? r.attached_at.toISOString() : String(r.attached_at),
  };
}

// ── 저장 ─────────────────────────────────────────────────────────────────────

/** 지금 붙어 있는 앱들(붙인 순서). */
export async function listAttachedApps(sessionId: string): Promise<SessionAppRow[]> {
  const r = await itemsPool.query(
    `SELECT session_id, app_id, member_id, attached_at FROM org_session_app
      WHERE session_id=$1 AND detached_at IS NULL ORDER BY attached_at, app_id`, [sessionId]);
  return r.rows.map(rowOf);
}

/**
 * 붙인다 — 이미 붙어 있으면 그대로(멱등), 뗐던 것이면 되살린다. 돌려주는 값 = 이번에 새로 붙었나(또는 붙인 사람이 바뀌었나).
 *  #4684 — 붙어 있는 것을 **다른 사람**이 다시 붙이면 붙인 사람을 그 사람으로 바꾼다. 앱 폴더는 붙인 사람의 동의를 근거로 하므로(
 *   session-app-folders.folderAppsFor), 처음 붙인 사람이 동의를 거둔 뒤 다른 참가자가 다시 붙여도 폴더가 안 돌아오던 것을 막는다.
 */
export async function attachAppRow(sessionId: string, appId: string, memberId: string): Promise<boolean> {
  // ON CONFLICT 타깃에 tenant_id — ensureTenantColumn 이 PK 를 (tenant_id, session_id, app_id)로 재작성한다(upsertGrant 와 같은 규약).
  const r = await itemsPool.query(
    `INSERT INTO org_session_app(session_id, app_id, member_id, attached_at, detached_at)
       VALUES($1,$2,$3,now(),NULL)
     ON CONFLICT (tenant_id, session_id, app_id) DO UPDATE SET
       member_id=EXCLUDED.member_id, attached_at=now(), detached_at=NULL
       WHERE org_session_app.detached_at IS NOT NULL OR org_session_app.member_id <> EXCLUDED.member_id
     RETURNING app_id`, [sessionId, appId, memberId]);
  return (r.rowCount ?? 0) > 0;
}

/** 뗀다. 돌려주는 값 = 붙어 있던 것을 이번에 뗐나(이미 떼어져 있었으면 false). */
export async function detachAppRow(sessionId: string, appId: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_session_app SET detached_at=now() WHERE session_id=$1 AND app_id=$2 AND detached_at IS NULL`, [sessionId, appId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 앱 제거 때 — 그 앱의 연결 기록을 전부 지운다(FK 가 없어 CASCADE 대신 명시 회수, schema/apps.ts 주석).
 *  #4684 — 그때 **붙어 있던** 세션 id 를 돌려준다(그 세션들의 앱 폴더를 떼야 한다 — 기록이 지워진 뒤엔 찾을 길이 없다).
 */
export async function pruneSessionApps(appId: string): Promise<string[]> {
  const r = await itemsPool.query(`DELETE FROM org_session_app WHERE app_id=$1 RETURNING session_id, detached_at`, [appId]);
  return [...new Set(r.rows.filter((x) => x.detached_at == null).map((x) => String(x.session_id)))];
}

/**
 * 새 id 복원 때 옛 세션의 **지금 붙은** 앱을 새 세션으로 넘긴다(#4684). 붙인 사람·시각은 그대로 옮긴다(누가 붙였나가 동의 판정의
 *  재료다). 새 세션에 이미 있는 행은 건드리지 않는다. 옛 행은 남긴다 — 승계가 실패해 옛 id 를 다시 복원할 때의 재료다
 *  (routes 복원의 «확인됐을 때만 옛 행을 정리» 와 같은 규율). 돌려주는 값 = 넘긴 행 수.
 */
export async function carrySessionApps(fromId: string, toId: string): Promise<number> {
  if (!fromId || !toId || fromId === toId) return 0;
  // ON CONFLICT 타깃에 tenant_id — attachAppRow 와 같은 규약(ensureTenantColumn 이 PK 를 (tenant_id, session_id, app_id)로 재작성한다).
  const r = await itemsPool.query(
    `INSERT INTO org_session_app(session_id, app_id, member_id, attached_at, detached_at)
       SELECT $2, app_id, member_id, attached_at, NULL FROM org_session_app WHERE session_id=$1 AND detached_at IS NULL
     ON CONFLICT (tenant_id, session_id, app_id) DO NOTHING`, [fromId, toId]);
  return r.rowCount ?? 0;
}

/**
 * 한 번도 뜨지 않은 세션 id 의 붙은 앱 기록을 지운다(#4684 검토) — 새 id 복원이 옛 세션의 붙은 앱을 넘긴 뒤 만들기가 실패했을 때만 부른다.
 *  안 지우면 그 id 가 다시 맞추기 묶음에 계속 끼어든다. 지운 수.
 */
export async function dropSessionApps(sessionId: string): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM org_session_app WHERE session_id=$1`, [sessionId]);
  return r.rowCount ?? 0;
}

/** 이 사람이 붙여 둔(지금 붙은) 세션들(#4684 — 멤버 비활성 때 그 세션들의 앱 폴더를 다시 맞춘다). */
export async function sessionsAttachedBy(memberId: string): Promise<string[]> {
  const r = await itemsPool.query(`SELECT DISTINCT session_id FROM org_session_app WHERE member_id=$1 AND detached_at IS NULL`, [memberId]);
  return r.rows.map((x) => String(x.session_id));
}

/** 이 앱이 지금 붙어 있는 세션들(#4684 — 앱 상태·공개가 바뀌면 그 세션들의 앱 폴더를 다시 맞춘다). */
export async function sessionsWithApp(appId: string, attachedBy?: string): Promise<string[]> {
  const r = attachedBy
    ? await itemsPool.query(`SELECT DISTINCT session_id FROM org_session_app WHERE app_id=$1 AND member_id=$2 AND detached_at IS NULL`, [appId, attachedBy])
    : await itemsPool.query(`SELECT DISTINCT session_id FROM org_session_app WHERE app_id=$1 AND detached_at IS NULL`, [appId]);
  return r.rows.map((x) => String(x.session_id));
}

// ── 세션 주인 ────────────────────────────────────────────────────────────────

/** 세션을 연 사람. desired-state(DB)가 정본이고, 없으면 중앙 tmux 의 @box_owner(자가호스팅 단일 박스). 모르면 null. */
export async function sessionOwnerOf(sessionId: string): Promise<string | null> {
  const st = await getSessionState(sessionId).catch(() => undefined);
  if (st?.owner) return st.owner;
  const o = await getOpt(sessionId, "@box_owner").catch(() => "");
  return String(o || "").trim() || null;
}

/**
 * sessionOwnerOf 와 같되 정본(DB) 조회 오류는 던진다 — «주인이 없다» 와 «못 물었다» 를 가른다(#4684 검토). 앱 폴더 맞추기가 일시
 *  오류를 «주인 없음 → 붙일 것 없음» 으로 읽어 도는 세션의 앱 폴더를 모두 떼지 않게.
 */
export async function sessionOwnerStrict(sessionId: string): Promise<string | null> {
  const st = await getSessionState(sessionId);
  if (st?.owner) return st.owner;
  const o = await getOpt(sessionId, "@box_owner").catch(() => "");
  return String(o || "").trim() || null;
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

export interface AttachDeps {
  sessionOwner: (sessionId: string) => Promise<string | null>;
  /** 그 세션에 들어갈 수 있는 사람인가(초대받은 사람 — 주인은 sessionOwner 로 먼저 통과한다). 없으면 주인만. */
  canEnter?: (sessionId: string, member: string) => Promise<boolean>;
  listAttached: (sessionId: string) => Promise<SessionAppRow[]>;
  getApp: (appId: string) => Promise<OrgApp | null>;
  getGrant: (appId: string, memberId: string) => Promise<AppGrantRow | null>;
}
const liveDeps: AttachDeps = {
  sessionOwner: sessionOwnerOf,
  canEnter: sessionCanEnter,
  listAttached: listAttachedApps,
  getApp: (id) => getApp(id),
  getGrant: getActiveGrant,
};

/** 그 세션에 들어갈 수 있는 사람(연 사람 · 초대받은 사람) — 붙이기·떼기·붙은 앱 쓰기의 공통 첫 관문. */
export async function requireSessionParticipant(sessionId: string, member: string, deps: Pick<AttachDeps, "sessionOwner" | "canEnter"> = liveDeps): Promise<void> {
  const owner = await deps.sessionOwner(sessionId);
  if (!owner) throw new HttpError(404, `세션을 찾을 수 없습니다: ${sessionId}`);
  if (owner === member) return;
  if (deps.canEnter && (await deps.canEnter(sessionId, member).catch(() => false))) return;
  throw new HttpError(403, "이 세션에 들어갈 수 있는 사람(연 사람 · 초대받은 사람)만 앱을 붙이고 떼고, 붙은 앱의 데이터를 쓸 수 있습니다");
}

/** 초대받아 그 세션에 들어갈 수 있는 사람인가 — 세션 화면에 들어가는 판정(canAttach)과 같은 것을 쓴다(숨긴 프로젝트 제약 포함). */
export async function sessionCanEnter(sessionId: string, member: string): Promise<boolean> {
  const { canAttach } = await import("../terminal/sessions.js");
  return canAttach(sessionId, member);
}

/** 그 세션의 사람들(연 사람 + 초대받은 사람) — 앱 알림을 같이 받을 사람. 모르면 빈 배열. */
export async function sessionPeopleOf(sessionId: string): Promise<string[]> {
  const st = await getSessionState(sessionId).catch(() => undefined);
  const out = new Set<string>();
  if (st?.owner) out.add(st.owner);
  for (const m of st?.invites ?? []) if (m) out.add(m);
  if (!out.size) { const o = await sessionOwnerOf(sessionId); if (o) out.add(o); }
  return [...out];
}

/** 앱이 쓸 수 있는 상태인가 — 없음 404 · 꺼짐/설치 중 409. */
export function requireUsableApp(app: OrgApp | null, appId: string): OrgApp {
  if (!app) throw new HttpError(404, `앱 없음: ${appId}`);
  if (app.status !== "active" || !app.enabled) throw new HttpError(409, `앱 '${appId}' 이 활성 상태가 아닙니다(${app.status}${app.enabled ? "" : " · 꺼짐"})`);
  return app;
}

/**
 * 앱 principal 이 없는 store_* 호출 — 이 세션에 붙은 앱으로 들어갈 수 있나. 된다면 그 앱 id 를 돌려준다.
 *  appId 를 안 주면 **붙은 앱이 하나일 때만** 그 앱으로 본다(둘 이상이면 고르라고 400).
 *  ⚠ 캐시하지 않는다 — 떼는 순간 막혀야 한다(머리말).
 */
export async function requireAttachedApp(
  q: { sessionId: string; member: string; appId?: string | null; tool: string; scopes?: readonly string[] },
  deps: AttachDeps = liveDeps,
): Promise<string> {
  await requireSessionParticipant(q.sessionId, q.member, deps);
  const attached = await deps.listAttached(q.sessionId);
  const want = String(q.appId ?? "").trim();
  let appId: string;
  if (want) {
    if (!attached.some((a) => a.app_id === want)) {
      throw new HttpError(403, `이 세션에 앱 '${want}' 이 붙어 있지 않습니다 — 사람이 세션 오른쪽에 붙이거나 session_app_attach 로 붙인 뒤 쓰세요`
        + (attached.length ? ` (지금 붙은 앱: ${attached.map((a) => a.app_id).join(", ")})` : ""));
    }
    appId = want;
  } else if (attached.length === 1) {
    appId = attached[0].app_id;
  } else if (!attached.length) {
    throw new HttpError(403, "이 세션에 붙은 앱이 없습니다 — store_* 는 앱 화면·앱 세션, 또는 앱이 붙은 세션에서만 씁니다. 사람에게 앱을 붙일지 물어보세요");
  } else {
    throw new HttpError(400, `이 세션에 앱이 여럿 붙어 있습니다(${attached.map((a) => a.app_id).join(", ")}) — app_id 를 지정하세요`);
  }
  const app = requireUsableApp(await deps.getApp(appId), appId);
  //  #4667 — 공개를 거둔 남의 앱(나만 보는 앱)은 붙어 있어도 못 쓴다. 판정은 매 호출(머리말) — 거두는 순간부터 막힌다.
  if (!canSeeApp(app, { userId: q.member, scopes: q.scopes })) throw new HttpError(404, `앱 없음: ${appId}`);   // 관리자는 책임자가 떠난 앱도 쓴다(격리 리뷰 NB-5)
  const grant = await deps.getGrant(appId, q.member);
  if (!grant) throw new HttpError(403, `앱 '${appId}' 사용 동의(grant)가 없습니다 — 사람이 앱을 열어 동의해야 합니다`);
  if (!decideAppTool(appId, grant.tools, q.tool)) {
    throw new HttpError(403, `앱 '${appId}' 동의 범위에 '${q.tool}' 이 없습니다 — 앱이 새 도구를 얻었다면 사람이 앱 화면에서 다시 동의하면 됩니다`);
  }
  return appId;
}

// ── 화면에 알리기 ────────────────────────────────────────────────────────────
//  붙이기·떼기·데이터 변경을 그 사람의 스트림(/api/ui/notify/stream)으로 민다 — 세션 오른쪽 앱 칸이 곧바로 따라온다.
//  AI 가 세션에서 쓴 행이 사람이 보는 앱 화면에 반영되는 길이 이것이다(9/21 «AI 와 사람이 같은 화면»).
//  ⚠ 비치명 — 알림이 실패해도 쓰기는 이미 성공했다. 구독자가 없으면 버스가 즉시 돌아온다(핫패스 부담 없음).
let seq = 0;
/** 한 일을 한 사람과, 그 세션에 같이 있는 사람들에게 — 초대받은 사람이 붙이거나 쓴 것이 연 사람의 화면에도(그 반대도) 곧바로 보이게. */
export function publishAppEventToSession(actor: string, sessionId: string | null | undefined, ev: Omit<NotifyAppEvent, "type" | "key" | "ts" | "ws">): void {
  publishAppEvent(actor, ev);
  if (!sessionId) return;
  void sessionPeopleOf(sessionId).then((people) => { for (const m of people) if (m !== actor) publishAppEvent(m, ev); }).catch(() => { /* 비치명 */ });
}
export function publishAppEvent(member: string, ev: Omit<NotifyAppEvent, "type" | "key" | "ts" | "ws">): void {
  try {
    const ts = Date.now();
    publishNotify({ ws: hereSlug(), member }, { type: "app", ...ev, key: `a:${ev.app_id}:${ev.kind}:${ts}:${++seq}`, ts });
  } catch (e) { logger.warn({ err: e, app: ev.app_id }, "앱 알림 전달 실패(비치명)"); }
}

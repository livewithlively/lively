// 세션에 붙인 앱 폴더 (#4684) — 앱이 붙은 세션에서 그 앱의 폴더(워크스페이스 `apps/<앱>/`)를 `<작업 폴더>/.lively/apps/<앱>/` 로 본다.
//
// ── 누가 무엇을 하나 ─────────────────────────────────────────────────────────
//  · 무엇을 붙여 둘지는 **여기서** 정한다 — 붙은 앱 기록(org_session_app) 중 ① 앱이 쓸 수 있는 상태(활성·켜짐) ② **세션 주인**이 그 앱을
//    볼 수 있고(폴더는 그 컨테이너의 모두가 본다 — 남의 «나만» 앱이 주인 세션에 열리지 않게) ③ 붙인 사람이 지금도 그 세션에 들어갈 수
//    있고(주인 · 초대받은 사람) 그 앱을 볼 수 있으며 ④ 붙인 사람의 동의(grant)가 살아 있는 것. 관리자 범위는 쓰지 않는다(폴더는 사람 단위
//    권한이 아니라 컨테이너 단위라, 관리자만 보는 앱을 세션의 모두에게 열지 않는다).
//  · 실제로 붙이고 떼는 것은 노드 브로커다(lvly-cloud `sessionapps.ts`) — 세션 컨테이너 확보 요청에 목록을 실어 보내면 거기에 맞춘다.
//    세션을 만들 때(createSession — 게이트웨이 능력 sessionAppFolders)와 붙이기·떼기·동의/앱 상태가 바뀔 때(여기 syncSessionAppFolders)다.
//  · 셀프호스트·노드 세션엔 브로커가 없다 — 아무것도 안 한다(not-managed).
//
// ── 권한 ────────────────────────────────────────────────────────────────────
//  셸에서 앱 폴더를 보는 것은 그 앱이 붙은 세션뿐이다(붙이기 = 세션에 들어갈 수 있는 사람 + 그 사람의 동의). 그 세션에 초대된 사람도
//   같은 컨테이너를 쓰므로 본다(파일 주소 체계 #4671 결정) — 읽기·쓰기 모두다(동의의 도구 범위와 무관하다). 동의를 거두거나 앱을 끄거나
//   공개를 거두거나 멤버가 비활성되면 그 세션들을 다시 맞춘다(resyncSessionsWithApp) — 그 순간부터 경로로는 안 보인다.
//
// ── 배포 순서 ───────────────────────────────────────────────────────────────
//  «만들지 않는» 확보(noCreate)를 모르는 옛 브로커는 그 표시를 무시하고 컨테이너를 만든다. 그래서 ① 끝났거나 다른 id 로 이어진 세션엔
//   브로커를 부르지 않고 ② 응답이 옛 브로커의 것(새로 만들었다 · apps 를 모른다)이면 다시 맞추기 묶음을 그 자리에서 멈춘다.
//   배포는 브로커(lvly-cloud)가 전 노드에 퍼진 뒤에 이 코어를 롤한다.
import { listAttachedApps, sessionsWithApp, sessionsAttachedBy, sessionOwnerStrict, sessionCanEnter, type SessionAppRow } from "./session-apps.js";
import { getApp, getActiveGrant, type OrgApp, type AppGrantRow } from "../org/store/apps.js";
import { canSeeApp } from "./visibility.js";
import { APP_ID_RE } from "./manifest.js";
import { getSessionState } from "../sessions/session-state.js";
import { sessionOsUser } from "../terminal/profiles.js";
import { tenantSlug } from "../terminal/catalog.js";
import { ensureSessionContainerViaRelay, sessionEnsureArgv, sessionEnsureConfigured, type SessionEnsureRequest } from "../terminal/session-tmux.js";
import { logger } from "../log.js";

/** 세션 안 붙이는 자리(작업 폴더 기준 상대경로) — 브로커 sessionapps.APPS_MOUNT_REL 과 같은 자. */
export const APP_FOLDER_REL = ".lively/apps";
/** 브로커가 «도는 컨테이너가 없다» 고 답할 때의 표식(lvly-cloud sessionapps.NO_SESSION_CONTAINER). */
export const NO_SESSION_CONTAINER = "LVLY_NO_SESSION_CONTAINER";

export interface FolderDeps {
  listAttached: (sessionId: string) => Promise<SessionAppRow[]>;
  getApp: (appId: string) => Promise<OrgApp | null>;
  getGrant: (appId: string, memberId: string) => Promise<AppGrantRow | null>;
  /** 세션을 연 사람(모르면 null — 그러면 아무것도 붙이지 않는다). 조회 오류는 던진다(모름과 못 물음을 가른다). */
  sessionOwner: (sessionId: string) => Promise<string | null>;
  /** 초대받아 그 세션에 들어갈 수 있는 사람인가(주인은 따로 통과). */
  canEnter: (sessionId: string, member: string) => Promise<boolean>;
}
const liveFolderDeps: FolderDeps = {
  listAttached: listAttachedApps, getApp: (id) => getApp(id), getGrant: getActiveGrant,
  sessionOwner: sessionOwnerStrict, canEnter: sessionCanEnter,
};

/**
 * 이 세션에 붙어 있어야 할 앱 폴더(앱 id, 정렬). 붙은 기록마다 «지금도 쓸 수 있나» 를 다시 본다 — 붙인 뒤에 앱이 꺼졌거나
 *  붙인 사람이 동의를 거뒀으면 빠진다. 조회가 실패한 앱은 빠진다(모르면 안 붙인다).
 *  주인을 모르면 [] 이지만 주인 조회 **오류**는 던진다 — 맞추기는 그때 브로커를 부르지 않는다(일시 오류로 «모두 떼기» 를 보내지 않게).
 */
export async function folderAppsFor(sessionId: string, deps: FolderDeps = liveFolderDeps): Promise<string[]> {
  const owner = await deps.sessionOwner(sessionId);
  if (!owner) return [];
  const out = new Set<string>();
  for (const r of await deps.listAttached(sessionId)) {
    if (!APP_ID_RE.test(r.app_id) || out.has(r.app_id)) continue;
    const app = await deps.getApp(r.app_id).catch(() => null);
    if (!app || app.status !== "active" || !app.enabled) continue;
    if (!canSeeApp(app, { userId: owner, scopes: [] })) continue;                     // ② 주인이 못 보는 앱은 그 세션에 열지 않는다
    if (r.member_id !== owner && !(await deps.canEnter(sessionId, r.member_id).catch(() => false))) continue;   // ③ 붙인 사람이 이제 그 세션 밖
    if (!canSeeApp(app, { userId: r.member_id, scopes: [] })) continue;
    if (!(await deps.getGrant(r.app_id, r.member_id).catch(() => null))) continue;     // ④
    out.add(r.app_id);
  }
  return [...out].sort();
}

export type FolderSync =
  | { applied: true; supported: boolean; bound: string[]; failed: Array<{ app: string; why: string }> }
  | { applied: false; reason: "not-managed" | "not-running" | "old-broker" | "error"; detail?: string };

export interface SyncDeps {
  slug: () => string | null;
  managed: () => boolean;
  state: (sessionId: string) => Promise<{ dir?: string | null; node_id?: string | null; exited_at?: string | null; superseded_by?: string | null } | undefined>;
  osUser: (sessionId: string) => Promise<string | null>;
  apps: (sessionId: string) => Promise<string[]>;
  ensure: (argv: readonly string[], req: SessionEnsureRequest) => Promise<Record<string, unknown>>;
}
const liveSyncDeps: SyncDeps = {
  slug: tenantSlug,
  managed: () => sessionEnsureConfigured(),
  state: (id) => getSessionState(id).catch(() => undefined),
  osUser: sessionOsUser,
  apps: (id) => folderAppsFor(id),
  //  붙이기·떼기 응답이 이걸 기다린다 — 길게 잡지 않는다(브로커가 늦어도 맞추기는 그쪽에서 끝까지 간다).
  ensure: (argv, req) => ensureSessionContainerViaRelay(argv, req, { timeoutMs: 8_000 }),
};

//  같은 세션의 맞추기는 한 줄로 — 먼저 계산한 목록이 늦게 도착해 나중 것을 덮지 않게(세션 id → 그 세션의 마지막 맞추기).
const inflight = new Map<string, Promise<unknown>>();

/**
 * 이 세션의 앱 폴더를 지금 붙은 앱에 맞추라고 노드 브로커에 알린다(만들지는 않는다 — noCreate).
 *  세션 컨테이너가 없으면(끝났거나 회수됨) not-running — 다음 확보(복원)가 붙인다. 실패해도 던지지 않는다(부르는 쪽은 붙이기·떼기를
 *  이미 기록했다 — 폴더는 그 결과의 일부일 뿐이다).
 */
export function syncSessionAppFolders(sessionId: string, deps: SyncDeps = liveSyncDeps): Promise<FolderSync> {
  const prev = inflight.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => syncOnce(sessionId, deps));
  const tail = next.catch(() => undefined).finally(() => { if (inflight.get(sessionId) === tail) inflight.delete(sessionId); });
  inflight.set(sessionId, tail);
  return next;
}

async function syncOnce(sessionId: string, deps: SyncDeps): Promise<FolderSync> {
  try {
    const slug = deps.slug();
    if (!slug || !deps.managed()) return { applied: false, reason: "not-managed" };
    const st = await deps.state(sessionId);
    if (st?.node_id) return { applied: false, reason: "not-managed" };   // 노드(멤버 컴퓨터) 세션 — 브로커가 없다
    //  끝났거나(사람이 닫음) 다른 id 로 이어진 세션엔 도는 컨테이너가 없다 — 브로커를 부르지 않는다(옛 브로커가 만들지 않게 · 왕복 0).
    if (st?.superseded_by || st?.exited_at) return { applied: false, reason: "not-running" };
    const osUser = await deps.osUser(sessionId);
    if (!osUser) return { applied: false, reason: "not-running", detail: "세션 주인을 모른다" };
    const apps = await deps.apps(sessionId);
    let r: Record<string, unknown>;
    try {
      r = await deps.ensure(sessionEnsureArgv(slug), {
        sessionId, osUser, cwd: String(st?.dir ?? ""), memMb: 0, memRequestMb: 0, tmux: "inside", apps, noCreate: true,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (msg.includes(NO_SESSION_CONTAINER)) return { applied: false, reason: "not-running" };
      return { applied: false, reason: "error", detail: msg.slice(0, 300) };
    }
    //  옛 브로커 — 앱 폴더를 모르면 응답에 apps 가 없다(새 브로커는 noCreate 에 늘 apps 를 싣는다). 그 브로커는 «만들지 않는다» 도
    //   몰라, 도는 컨테이너가 없었으면 새로 만들었다(created) — 사유에 그 사실을 적는다.
    if (!r.apps || typeof r.apps !== "object") {
      return { applied: false, reason: "old-broker", detail: r.created === true ? "브로커가 noCreate 를 모른다 — 컨테이너를 새로 만들었다" : "브로커가 앱 폴더를 모른다(이 기능 전 판)" };
    }
    const a = r.apps as { supported?: unknown; bound?: unknown; failed?: unknown };
    return {
      applied: true,
      supported: a.supported === true,
      bound: Array.isArray(a.bound) ? a.bound.map(String) : [],
      failed: Array.isArray(a.failed) ? (a.failed as Array<{ app?: unknown; why?: unknown }>).map((f) => ({ app: String(f?.app ?? ""), why: String(f?.why ?? "") })) : [],
    };
  } catch (e) {
    return { applied: false, reason: "error", detail: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/**
 * 여러 세션을 다시 맞춘다 — 앱 상태·공개·동의가 바뀐 뒤(부르는 쪽은 기다리지 않는다). 하나씩(브로커 왕복 하나씩) · 실패는 남기기만.
 */
export async function resyncSessions(sessionIds: readonly string[], why: string, sync: (id: string) => Promise<FolderSync> = syncSessionAppFolders): Promise<void> {
  const ids = [...new Set(sessionIds)];
  for (const [i, id] of ids.entries()) {
    const r: FolderSync = await sync(id).catch((e) => ({ applied: false as const, reason: "error" as const, detail: String((e as Error)?.message ?? e) }));
    //  옛 브로커 — 묶음을 여기서 멈춘다(남은 세션마다 컨테이너를 만들 수 있다). 브로커가 다 퍼지면 다음 맞추기가 이어 간다.
    if (!r.applied && r.reason === "old-broker") { logger.error({ session: id, why, detail: r.detail, skipped: ids.length - i - 1 }, "앱 폴더 다시 맞추기 멈춤 — 옛 브로커(#4684)"); return; }
    if (!r.applied && r.reason === "error") logger.warn({ session: id, why, detail: r.detail }, "앱 폴더 다시 맞추기 실패(#4684)");
    //  브로커가 붙이기·떼기 일부를 못 했다고 답한 것도 남긴다 — 동의 회수 뒤 떼기가 실패하면 폴더가 계속 보인다(재시도는 다음 맞추기).
    else if (r.applied && r.failed.length) logger.warn({ session: id, why, failed: r.failed }, "앱 폴더 다시 맞추기 일부 실패(#4684)");
  }
}

/**
 * 세션을 만든 **직후** — 확보 요청에 실은 목록과 지금 목록이 다르면(만드는 사이 누가 붙이거나 뗐다) 한 번 더 맞춘다(#4684 검토).
 *  그 사이의 붙이기·떼기는 아직 컨테이너가 없어 «not-running» 으로 끝났을 수 있다 — 그 갱신이 새 컨테이너에서 사라지지 않게.
 *  같으면 아무것도 안 한다(브로커 왕복 0). 기다리지 않는다.
 */
export function resyncIfChangedAfterCreate(sessionId: string, sent: readonly string[], deps: { apps: (id: string) => Promise<string[]>; sync: (id: string) => Promise<FolderSync> } = { apps: (id) => folderAppsFor(id), sync: (id) => syncSessionAppFolders(id) }): Promise<void> {
  return deps.apps(sessionId)
    .then(async (now) => {
      if (now.join(",") === [...sent].sort().join(",")) return;
      await resyncSessions([sessionId], "만드는 사이 바뀜", deps.sync);
    })
    .catch((e) => logger.warn({ err: e, session: sessionId }, "앱 폴더 만든 뒤 확인 실패(#4684)"));
}

/** 이 앱이 붙은 세션들을 다시 맞춘다(attachedBy 를 주면 그 사람이 붙인 것만 — 동의를 거둔 경우). 기다리지 않는다. */
export function resyncSessionsWithApp(appId: string, why: string, attachedBy?: string): void {
  void sessionsWithApp(appId, attachedBy)
    .then((ids) => resyncSessions(ids, why))
    .catch((e) => logger.warn({ err: e, app: appId, why }, "앱 폴더 다시 맞추기 대상 조회 실패(#4684)"));
}

/** 이 사람이 붙여 둔 세션들을 다시 맞춘다(멤버 비활성 — 그 사람의 동의가 한꺼번에 사라졌다). 기다리지 않는다. */
export function resyncSessionsAttachedBy(memberId: string, why: string): void {
  void sessionsAttachedBy(memberId)
    .then((ids) => resyncSessions(ids, why))
    .catch((e) => logger.warn({ err: e, member: memberId, why }, "앱 폴더 다시 맞추기 대상 조회 실패(#4684)"));
}

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
import {
  listAttachedApps, sessionsWithApp, sessionsAttachedBy, sessionOwnerStrict, sessionCanEnter, recordAppFolderSync, markAppFolderFixed,
  appFolderSyncTargets, pruneAppFolderSyncRecords, type SessionAppRow, type AppFolderRecord, type AppFolderState,
} from "./session-apps.js";
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
  /** 맞춘 결과를 남긴다(#4786 — 주기 맞추기의 재료). 없으면 안 남긴다. 실패해도 맞추기 결과는 그대로다. */
  record?: (sessionId: string, r: AppFolderNote) => Promise<unknown>;   // 돌려주는 값이 { written, prev } 면 판의 뒷이야기(syncRunInfo)에 싣는다
}
const liveSyncDeps: SyncDeps = {
  slug: tenantSlug,
  managed: () => sessionEnsureConfigured(),
  state: (id) => getSessionState(id).catch(() => undefined),
  osUser: sessionOsUser,
  apps: (id) => folderAppsFor(id),
  //  붙이기·떼기 응답이 이걸 기다린다 — 길게 잡지 않는다(브로커가 늦어도 맞추기는 그쪽에서 끝까지 간다).
  ensure: (argv, req) => ensureSessionContainerViaRelay(argv, req, { timeoutMs: 8_000 }),
  record: recordAppFolderSync,
};

//  같은 세션의 맞추기는 한 줄로 — 먼저 계산한 목록이 늦게 도착해 나중 것을 덮지 않게.
//  #4787 — 줄에는 «도는 것» 하나와 «기다리는 것» 하나만 선다. 기다리는 것이 있으면 새 요청은 그것에 합친다: 기다리는 맞추기는
//   차례가 오면 그때 목록을 계산하므로 뒤에 온 요청의 변경까지 담는다(결과가 같다). 그래서 사건이 몰려도 한 세션의 브로커 왕복은
//   겹친 동안 두 번을 넘지 않는다. 기다리던 것이 시작한 뒤에 온 요청은 한 번 더 선다(그 목록은 이미 계산됐을 수 있다).
//   ⚠ 합쳐진 요청은 먼저 선 요청의 의존(deps)으로 돈다 — 운영에선 늘 liveSyncDeps 하나다.
interface SyncLane { tail: Promise<unknown>; waiting: Promise<FolderSync> | null; causes: Set<SyncCause> }
const lanes = new Map<string, SyncLane>();

/** 맞추기를 부른 까닭 — 사건(붙이기 · 떼기 · 앱 상태 · 만들기)과 주기 판(#4786). 주기 판의 «고친 횟수» 를 가를 때만 쓴다. */
export type SyncCause = "event" | "periodic";
/** 맞추기 한 판의 뒷이야기(#4786 검토) — 합쳐진 까닭들 · 기록을 썼나 · 쓰기 직전의 기록. 결과 객체가 열쇠다(합쳐진 호출은 같은 객체를 받는다). */
export interface SyncRunInfo { causes: SyncCause[]; recorded: boolean; prev: { bound: string[]; state: AppFolderState } | null }
const runInfo = new WeakMap<object, SyncRunInfo>();
export function syncRunInfo(r: FolderSync): SyncRunInfo | undefined { return runInfo.get(r); }

/**
 * 이 세션의 앱 폴더를 지금 붙은 앱에 맞추라고 노드 브로커에 알린다(만들지는 않는다 — noCreate).
 *  세션 컨테이너가 없으면(끝났거나 회수됨) not-running — 다음 확보(복원)가 붙인다. 실패해도 던지지 않는다(부르는 쪽은 붙이기·떼기를
 *  이미 기록했다 — 폴더는 그 결과의 일부일 뿐이다).
 */
export function syncSessionAppFolders(sessionId: string, deps: SyncDeps = liveSyncDeps, cause: SyncCause = "event"): Promise<FolderSync> {
  const lane = lanes.get(sessionId) ?? { tail: Promise.resolve(), waiting: null, causes: new Set<SyncCause>() };
  if (lane.waiting) { lane.causes.add(cause); return lane.waiting; }
  lane.causes = new Set<SyncCause>([cause]);
  const run = lane.tail.then(async () => {
    lane.waiting = null;
    const causes = [...lane.causes];
    const rec: { written?: boolean; prev?: SyncRunInfo["prev"] } = {};
    const r = await syncOnce(sessionId, deps, rec);
    runInfo.set(r, { causes, recorded: rec.written === true, prev: rec.prev ?? null });
    return r;
  });
  lane.waiting = run;
  const tail = run.catch(() => undefined).finally(() => { if (lane.tail === tail && lanes.get(sessionId) === lane) lanes.delete(sessionId); });
  lane.tail = tail;
  lanes.set(sessionId, lane);
  return run;
}

// ── 다시 맞추기 묶음 전체의 동시 수(#4787) ─────────────────────────────────────
//  묶음은 안에서 하나씩 돌지만 묶음끼리는 따로 돈다 — 앱 끄기 · 공개 바꾸기 · 동의 회수가 겹치거나 주기 맞추기가 돌면 묶음이 여럿 선다.
//  맞추기 하나 = 노드 브로커 왕복 하나 = 게이트웨이의 중계 자식 프로세스 하나(ensureSessionContainerViaRelay)라, 묶음 전체에서
//  동시에 도는 수를 센다. 상한은 묶음 쪽에만 건다 — 붙이기 · 떼기 응답(사람이 기다린다)은 묶음 줄 뒤에 서지 않는다.

/** 묶음 전체 동시 맞추기 수의 기본값 · 최댓값. */
export const RESYNC_CONCURRENCY_DEFAULT = 4;
export const RESYNC_CONCURRENCY_MAX = 16;

/** LIVELY_APP_FOLDER_RESYNC_CONCURRENCY — 1 이상의 정수(내림, 최대 16). 없거나 이상하면 기본값. */
export function resyncConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(String(env.LIVELY_APP_FOLDER_RESYNC_CONCURRENCY ?? "").trim() || NaN));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, RESYNC_CONCURRENCY_MAX) : RESYNC_CONCURRENCY_DEFAULT;
}

/** 동시에 max 개까지만 돌리는 자리(먼저 온 차례). 던져도 자리는 풀린다. */
export interface Slots { run<T>(fn: () => Promise<T>): Promise<T>; stats(): { active: number; waiting: number } }
export function createSlots(max: number): Slots {
  const limit = Math.max(1, Math.floor(max) || 1);
  const waiting: Array<() => void> = [];
  let active = 0;
  return {
    async run(fn) {
      if (active < limit) active++;
      else await new Promise<void>((r) => waiting.push(r));   // 풀리는 자리를 그대로 넘겨받는다(active 는 그대로)
      try { return await fn(); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}
const resyncSlots = createSlots(resyncConcurrencyFromEnv());
/** 주기 판(#4786)의 동시 맞추기 수 — 사건 묶음과 자리를 따로 둔다(#4786 검토): 게이트웨이 하나가 모든 워크스페이스를 서비스하므로,
 *  워크스페이스가 많아지면 주기 판들이 사건 묶음(동의 회수 뒤 떼기 같은 일)의 자리를 차지해 늦출 수 있다. */
export const PERIODIC_CONCURRENCY = 2;
const periodicSlots = createSlots(PERIODIC_CONCURRENCY);

/** 진단 · 시험용 — 줄이 선 세션 수 · 묶음 자리. */
export function appFolderSyncStats(): { lanes: number; resync: { active: number; waiting: number }; periodic: { active: number; waiting: number } } {
  return { lanes: lanes.size, resync: resyncSlots.stats(), periodic: periodicSlots.stats() };
}

/** 맞춘 결과 기록 한 줄(#4786) — bound null = 모른다(지난 기록 그대로). */
export interface AppFolderNote { bound: readonly string[] | null; state: AppFolderState; detail?: string | null }

/** 브로커가 답한 앱 폴더 결과를 기록 한 줄로. */
function noteOfApplied(r: { supported: boolean; bound: string[]; failed: Array<{ app: string; why: string }> }): AppFolderNote {
  if (!r.supported) return { bound: [], state: "unsupported", detail: "접점 없는 컨테이너 — 다시 떠야 붙는다" };
  if (r.failed.length) return { bound: r.bound, state: "failed", detail: r.failed.map((f) => `${f.app}: ${f.why}`).join(" · ") };
  return { bound: r.bound, state: "ok" };
}

async function syncOnce(sessionId: string, deps: SyncDeps, rec: { written?: boolean; prev?: SyncRunInfo["prev"] } = {}): Promise<FolderSync> {
  //  브로커에 물었거나(답 · 컨테이너 없음 · 실패) 판정이 실패했을 때만 기록한다 — 매니지드가 아니거나 끝났거나 이어진 세션은 남길 것이 없다.
  const out: { note: AppFolderNote | null } = { note: null };
  const result = await syncDecide(sessionId, deps, out);
  if (out.note && deps.record) {
    //  기다린다 — 같은 세션 줄의 다음 맞추기가 이 기록을 앞지르지 않게(기록 순서 = 맞추기 순서).
    const w = await deps.record(sessionId, out.note).catch((e) => { logger.warn({ err: e, session: sessionId }, "앱 폴더 맞춘 기록 실패(#4786) — 맞추기 결과는 그대로"); return null; });
    if (w && typeof w === "object" && "written" in w) {
      const ww = w as { written?: unknown; prev?: SyncRunInfo["prev"] };
      rec.written = ww.written === true;
      rec.prev = ww.prev ?? null;
    }
  }
  return result;
}

async function syncDecide(sessionId: string, deps: SyncDeps, out: { note: AppFolderNote | null }): Promise<FolderSync> {
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
      if (msg.includes(NO_SESSION_CONTAINER)) { out.note = { bound: [], state: "not-running" }; return { applied: false, reason: "not-running" }; }
      out.note = { bound: null, state: "error", detail: msg.slice(0, 300) };
      return { applied: false, reason: "error", detail: msg.slice(0, 300) };
    }
    //  옛 브로커 — 앱 폴더를 모르면 응답에 apps 가 없다(새 브로커는 noCreate 에 늘 apps 를 싣는다). 그 브로커는 «만들지 않는다» 도
    //   몰라, 도는 컨테이너가 없었으면 새로 만들었다(created) — 사유에 그 사실을 적는다.
    if (!r.apps || typeof r.apps !== "object") {
      const detail = r.created === true ? "브로커가 noCreate 를 모른다 — 컨테이너를 새로 만들었다" : "브로커가 앱 폴더를 모른다(이 기능 전 판)";
      out.note = { bound: null, state: "old-broker", detail };
      return { applied: false, reason: "old-broker", detail };
    }
    const a = r.apps as { supported?: unknown; bound?: unknown; failed?: unknown };
    const applied = {
      applied: true as const,
      supported: a.supported === true,
      bound: Array.isArray(a.bound) ? a.bound.map(String) : [],
      failed: Array.isArray(a.failed) ? (a.failed as Array<{ app?: unknown; why?: unknown }>).map((f) => ({ app: String(f?.app ?? ""), why: String(f?.why ?? "") })) : [],
    };
    out.note = noteOfApplied(applied);
    return applied;
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    out.note = { bound: null, state: "error", detail };   // 목록 · 주인 조회 실패 — 노드는 그대로다(모른다)
    return { applied: false, reason: "error", detail };
  }
}

/**
 * 여러 세션을 다시 맞춘다 — 앱 상태·공개·동의가 바뀐 뒤(부르는 쪽은 기다리지 않는다). 하나씩(브로커 왕복 하나씩) · 실패는 남기기만.
 *  묶음 전체의 동시 수는 slots 가 센다(#4787 — 기본은 게이트웨이 하나에 하나인 resyncSlots).
 */
export async function resyncSessions(sessionIds: readonly string[], why: string, sync: (id: string) => Promise<FolderSync> = syncSessionAppFolders, slots: Slots = resyncSlots): Promise<void> {
  const ids = [...new Set(sessionIds)];
  for (const [i, id] of ids.entries()) {
    const r: FolderSync = await slots.run(() => sync(id)).catch((e) => ({ applied: false as const, reason: "error" as const, detail: String((e as Error)?.message ?? e) }));
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

// ── 세션을 만든 직후의 기록(#4786) ───────────────────────────────────────────
/**
 * 세션 컨테이너를 만든 확보 응답의 앱 폴더 결과를 남기고(주기 맞추기의 출발점), 만드는 사이 붙은 앱이 바뀌었으면 한 번 더 맞춘다.
 *  sent = 확보에 실은 목록(못 읽었으면 undefined) · madeApps = 응답의 apps(없으면 브로커가 앱 폴더를 건드리지 않았다).
 *  기록 → 맞추기 순서다(맞추기의 기록이 만들 때 기록보다 늦게 남아야 최신이 이긴다). 기다리지 않는다 — 던지지 않는다.
 *  ensureStartedAt — 확보를 청한 시각(게이트웨이 시계). 그 뒤에 남은 맞추기 기록(만드는 사이 붙이기 · 떼기)이 있으면 덮지 않는다(#4786 검토 —
 *   이 기록은 세션 줄 밖에서 쓰므로, 덮으면 그사이 실패한 떼기 기록이 사라져 주기 판이 그 세션을 놓친다).
 */
export async function afterSessionCreate(
  sessionId: string, sent: readonly string[] | undefined, madeApps: unknown, ensureStartedAt?: number,
  deps: { record: (id: string, r: AppFolderNote, opts: { ifOlderThan?: number }) => Promise<unknown>; resync: (id: string, sent: readonly string[]) => Promise<void> } = { record: recordAppFolderSync, resync: (id, s) => resyncIfChangedAfterCreate(id, s) },
): Promise<void> {
  const m = madeApps && typeof madeApps === "object" ? madeApps as { supported?: unknown; bound?: unknown; failed?: unknown } : null;
  const reported = m ? noteOfApplied({
    supported: m.supported === true,
    bound: Array.isArray(m.bound) ? m.bound.map(String) : [],
    failed: Array.isArray(m.failed) ? (m.failed as Array<{ app?: unknown; why?: unknown }>).map((f) => ({ app: String(f?.app ?? ""), why: String(f?.why ?? "") })) : [],
  }) : null;
  //  목록을 못 읽었으면 무엇이 붙어야 하는지 모른다 — 다음 주기 맞추기가 보게 실패로 남긴다(새 컨테이너엔 아무것도 안 붙었다).
  const note: AppFolderNote = !sent ? { bound: reported?.bound ?? [], state: "error", detail: "만들 때 붙은 앱 목록을 못 읽었다" }
    : reported ?? (sent.length ? { bound: [], state: "old-broker", detail: "브로커가 앱 폴더를 모른다(이 기능 전 판)" } : { bound: [], state: "ok" });
  await deps.record(sessionId, note, { ifOlderThan: ensureStartedAt }).catch((e) => logger.warn({ err: e, session: sessionId }, "앱 폴더 만든 뒤 기록 실패(#4786)"));
  if (sent) await deps.resync(sessionId, sent).catch(() => undefined);
}

// ── 주기 재조정(#4786) ───────────────────────────────────────────────────────
//  사건(만들기 · 붙이기 · 떼기 · 앱 끄기 · 동의 · 공개 · 제거 · 멤버 비활성)으로 맞추다 실패하면(브로커 무응답 · 8초 시간초과 · 노드
//  재기동 중) 경고만 남고 다음 사건까지 세션 안 폴더가 기록과 어긋난 채였다 — 동의를 거둔 뒤 떼기가 실패하면 그동안 폴더가 계속 보인다.
//  매니지드 정비 표(sessions/outbox-request-sweep.ts SWEEP_JOBS · key app-folders — 요청에 얹어 워크스페이스마다 5분)가 이 판을 부른다.
//  · 대상: 살아 있는 세션 가운데 붙은 앱 기록이 있거나 · 노드에 붙어 있다고 들었거나 · 지난 맞추기가 실패한 것(appFolderSyncTargets).
//  · 맞추기는 사건과 같은 길(syncSessionAppFolders — «만들지 않는» 확보 · 세션 줄 합치기)이고, 묶음 상한(resyncSlots)을 함께 쓴다.
//  · 동시 수: 워크스페이스 안에서는 하나씩 · 게이트웨이 전체로는 묶음 상한(기본 4). 워크스페이스 세션은 그 워크스페이스 노드에 있으므로
//    한 노드가 이 판에서 받는 동시 맞추기는 많아야 묶음 상한이다. 앞 판이 아직 돌면 이번 판은 건너뛴다.
//  · 옛 브로커를 만나면 그 판을 멈추고(resyncSessions 규칙) 그 워크스페이스는 한 시간 쉰다 — 옛 브로커는 «만들지 않는다» 를 몰라
//    컨테이너를 만든다.
//  · 고친 횟수: 지난 기록과 다른 상태로 맞췄거나 지난 맞추기가 실패였는데 이번에 맞췄으면 «사건 경로가 놓친 것» 으로 센다 —
//    행의 fixed_count 를 올리고 판 요약에 담는다(정비 로그에 찍힌다). 지난 기록이 없으면 «처음» 이다(기준이 없다).

/** 한 판에 맞출 세션 수. */
export const PERIODIC_MAX_SESSIONS = 50;
/** 컨테이너 없음 · 접점 없는 옛 컨테이너 · 옛 브로커로 기록한 세션을 다시 보는 간격. */
export const PERIODIC_RECHECK_ABSENT_MS = 30 * 60_000;
/** 옛 브로커를 만난 워크스페이스가 주기 맞추기를 쉬는 시간. */
export const PERIODIC_OLD_BROKER_PAUSE_MS = 60 * 60_000;

export interface PeriodicSummary {
  skipped?: "not-managed" | "running" | "old-broker";
  targets: number; ok: number; fixed: number; first: number; failed: number; gone: number; pruned: number;
  stopped?: boolean;
}

export interface PeriodicDeps {
  slug: () => string | null;
  managed: () => boolean;
  now: () => number;
  prune: () => Promise<number>;
  targets: (limit: number, recheckMs: number) => Promise<Array<{ session_id: string; prev: AppFolderRecord | null }>>;
  sync: (sessionId: string) => Promise<FolderSync>;
  markFixed: (sessionId: string) => Promise<unknown>;
  slots?: Slots;
}
const livePeriodicDeps: PeriodicDeps = {
  slug: tenantSlug,
  managed: () => sessionEnsureConfigured(),
  now: () => Date.now(),
  prune: pruneAppFolderSyncRecords,
  targets: appFolderSyncTargets,
  sync: (id) => syncSessionAppFolders(id, liveSyncDeps, "periodic"),
  markFixed: markAppFolderFixed,
};

/**
 * 한 세션의 주기 맞추기 결과를 지난 기록과 견준다(순수).
 *  info(그 판의 뒷이야기)가 있으면: 사건과 합쳐진 판은 사건이 바꾼 것이라 «고침» 이 아니고(«그대로»), 기준은 판을 고를 때 읽은 값이 아니라
 *  기록을 쓰는 같은 문장이 읽은 직전 값이다 — 판을 고른 뒤 사건 경로가 맞추고 기록한 것을 «고침» 으로 세지 않게(#4786 검토).
 */
export function periodicOutcome(prev: AppFolderRecord | null, r: FolderSync, info?: SyncRunInfo): "ok" | "fixed" | "first" | "failed" | "gone" | "old-broker" {
  if (!r.applied) return r.reason === "old-broker" ? "old-broker" : r.reason === "error" ? "failed" : "gone";
  if (!r.supported) return "gone";            // 접점 없는 옛 컨테이너 — 이 판으로는 못 고친다(다시 떠야 붙는다)
  if (r.failed.length) return "failed";
  if (info?.causes.includes("event")) return "ok";
  if (info?.recorded) prev = info.prev ? { session_id: "", checked_at: "", ...info.prev } : null;
  //  견줄 기준이 없다 — 기록이 없거나, 지난번엔 컨테이너가 없었다 · 옛 컨테이너였다 · 옛 브로커였다.
  if (!prev || prev.state === "not-running" || prev.state === "unsupported" || prev.state === "old-broker") return "first";
  const same = prev.bound.length === r.bound.length && [...prev.bound].sort().join("\n") === [...r.bound].sort().join("\n");
  return prev.state === "ok" && same ? "ok" : "fixed";
}

const sweeping = new Set<string>();
const oldBrokerPause = new Map<string, number>();

/** 이 워크스페이스의 앱 폴더를 한 판 다시 맞춘다 — 요약을 돌려준다(던지지 않는다 · 정비 로그에 찍힌다). */
export async function sweepAppFolders(d: PeriodicDeps = livePeriodicDeps): Promise<PeriodicSummary> {
  const sum: PeriodicSummary = { targets: 0, ok: 0, fixed: 0, first: 0, failed: 0, gone: 0, pruned: 0 };
  const slug = d.slug();
  if (!slug || !d.managed()) return { ...sum, skipped: "not-managed" };
  if (sweeping.has(slug)) return { ...sum, skipped: "running" };
  if ((oldBrokerPause.get(slug) ?? 0) > d.now()) return { ...sum, skipped: "old-broker" };
  sweeping.add(slug);
  try {
    sum.pruned = await d.prune().catch((e) => { logger.warn({ err: e }, "앱 폴더 맞춘 기록 정리 실패(#4786)"); return 0; });
    const targets = await d.targets(PERIODIC_MAX_SESSIONS, PERIODIC_RECHECK_ABSENT_MS);
    sum.targets = targets.length;
    const prev = new Map(targets.map((t) => [t.session_id, t.prev]));
    await resyncSessions(targets.map((t) => t.session_id), "주기", async (id) => {
      const r = await d.sync(id);
      const o = periodicOutcome(prev.get(id) ?? null, r, syncRunInfo(r));
      if (o === "old-broker") { sum.stopped = true; oldBrokerPause.set(slug, d.now() + PERIODIC_OLD_BROKER_PAUSE_MS); }
      else sum[o]++;
      if (o === "fixed") await d.markFixed(id).catch((e) => logger.warn({ err: e, session: id }, "앱 폴더 고친 횟수 기록 실패(#4786)"));
      return r;
    }, d.slots ?? periodicSlots);
    return sum;
  } catch (e) {
    logger.warn({ err: e, tenant: slug }, "앱 폴더 주기 맞추기 실패(#4786) — 다음 판이 다시 본다");
    return sum;
  } finally {
    sweeping.delete(slug);
  }
}

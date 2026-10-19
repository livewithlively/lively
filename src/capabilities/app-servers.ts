// 앱 서버 도구(#4484 앱 v2-5) — 빌드·배포(app_server_deploy) · 상태 · 멈춤 · 다시 켜기 · 상한.
//
//  결정(상민 2026-10-15): ① 빌드는 「이대로 넣기」·「공개하기」 단추와 이 도구에서(저장만으로는 빌드하지 않는다) · 공개는 빌드가 끝난 판만
//   ② 빌드는 그 판을 **저장한 사람**의 세션에서만 — 남이 저장한 판의 설치 스크립트가 공개하는 사람(관리자)의 토큰·구독에 닿지 않게
//   ③ 함수 기본 512MB · 30초 ④ 자동 멈춤 5분 호출 3만 · 실행 3,000초 → 관리자가 다시 켠다.
//  빌드는 수십 초~몇 분 걸린다 — 도구는 wait_s 만큼 기다리고, 그 안에 안 끝나면 «진행 중» 을 돌려준 뒤 뒤에서 이어 간다(같은 앱을 또 부르면 그 일에 붙는다).
//   끝난 일이 실패면, 결과를 직접 못 받은 쪽(화면에서 누름 · 기다림이 끝난 AI)을 위해 빌드한 세션에 실패 기록을 넣는다(설계 «빌드 실패 로그는 그 앱의 만들기 세션으로»).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import * as store from "../org/store/apps.js";
import { canSeeApp, isAdminViewer, isAppOwner, type Viewer } from "../apps/visibility.js";
import { editDenial } from "../apps/member-app.js";
import { parseAppManifest } from "../apps/manifest.js";
import { sessionOwnerOf } from "../apps/session-apps.js";
import { blobTenant } from "../apps/app-blob-store.js";
import { tailText } from "../apps/app-server-config.js";
import {
  APP_SERVER_POLICY_KEYS, APP_SERVER_POLICY_MAX, APP_SERVER_POLICY_MIN, envAppServerPolicy, mbOf, normalizeAppServerPolicy, type AppServerPolicy,
} from "../apps/app-server-policy.js";
import { appServerPolicy, appServerPolicyRow, countServerRows, getServerRow, setAppServerPolicy, sumServerCodeBytes } from "../apps/app-server-store.js";
import { appServerUnavailable, deployInstalled, installedTarget, type DeployOutcome, type InstalledTarget } from "../apps/app-server-deploy.js";
import { resumeServer, serverStatus, stopServer } from "../apps/app-server-lifecycle.js";
import type { BuildSeat } from "../apps/app-server-build.js";
import { logger } from "../log.js";

const actorOf = (u: { userId?: string; email?: string } | undefined): string => u?.userId || u?.email || "unknown";
const viewerOf = (u: LivelyUser | undefined): Viewer => ({ userId: actorOf(u), scopes: u?.scopes ?? [] });
function appIdOf(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) throw new HttpError(400, "app_id 가 필요합니다");
  return s;
}
async function requireVisibleApp(id: string, who: Viewer): Promise<store.OrgApp> {
  const app = await store.getApp(id);
  if (!app || !canSeeApp(app, who)) throw new HttpError(404, `앱 없음: ${id}`);
  return app;
}
const safeManifest = (a: store.OrgApp): ReturnType<typeof parseAppManifest> | null => { try { return parseAppManifest(a.manifest); } catch { return null; } };

/** 빌드할 자리 — 그 판을 저장한 사람이 부를 때만. 요청한 세션(이 사람의 것) > 이 앱의 만들기 세션(이 사람의 것). 없으면 null. */
async function seatFor(t: InstalledTarget, who: Viewer, ctx: { session?: string } | undefined): Promise<BuildSeat | null> {
  if (!t.savedBy || t.savedBy !== who.userId) return null;
  const sid = String(ctx?.session ?? "").trim();
  if (sid && (await sessionOwnerOf(sid).catch(() => null)) === who.userId) return { memberId: who.userId, sessionId: sid };
  const bs = t.app.build_session;
  if (bs && (await sessionOwnerOf(bs).catch(() => null)) === who.userId) return { memberId: who.userId, sessionId: bs };
  return null;
}

/** 실패를 빌드한 세션의 대화에 넣는다 — 그 세션의 AI 가 기록을 보고 고친다. 한 번만 · 길이 제한. */
async function tellSession(seat: BuildSeat, app: { id: string; title: string }, o: DeployOutcome): Promise<void> {
  const { deliverPromptForMember } = await import("../terminal/deliver-prompt.js");
  const log = o.log ? tailText(o.log, 2400) : "";
  const text = `(앱 「${app.title || app.id}」 서버 ${o.stage === "smoke" || o.stage === "deploy" ? "배포" : "빌드"} 실패 — ${o.version_no}판)\n` +
    `단계: ${o.stage ?? "?"}\n${o.error ?? ""}\n` + (log ? `\n기록 끝부분:\n${log}\n` : "") +
    `\n고친 뒤 app_save 로 저장하고 app_server_deploy {app_id:'${app.id}'} 로 다시 올려 주세요. 상태는 app_server_status.`;
  await deliverPromptForMember(seat.sessionId, seat.memberId, text.slice(0, 3800)).catch((err) => logger.warn({ err, app: app.id }, "빌드 실패를 세션에 넣지 못했다(비치명)"));
}

/** 앱마다 하나만 도는 배포 일 — 같은 앱을 또 부르면 그 일에 붙는다(빌드 두 벌 · 별칭 엇갈림을 막는다). 키 = 워크스페이스 · 앱. */
const jobs = new Map<string, Promise<DeployOutcome>>();

const appServerDeploy: Capability = {
  name: "app_server_deploy",
  title: "앱 서버 빌드·배포",
  description: "서버가 있는 앱(매니페스트 web.server)의 **지금 판**을 빌드해 그 앱의 서버 함수(AWS Lambda)에 올린다 — 「이대로 넣기」·「공개하기」 단추가 부르는 것과 같다. " +
    "빌드 = 이 세션 컨테이너의 임시 폴더에 판을 풀어 npm ci(잠금 파일 없으면 npm install) → web.server.build 또는 package.json scripts.build → npm prune --omit=dev → zip. " +
    "시작 명령 = web.server.start 또는 scripts.start(서버는 process.env.PORT 에서 받는다). 같은 코드(매니페스트만 바꾼 판 포함)는 다시 빌드하지 않는다. " +
    "풀린 크기 상한 245MB — 빌드가 자기 완결 출력 폴더를 만들면 web.server.dir 로 그 폴더만 올린다(Next.js: next.config output:'standalone' · " +
    "dir '.next/standalone' · build 'npm run build && cp -r .next/static .next/standalone/.next/static && ln -s /tmp/cache .next/standalone/.next/cache'(public 이 있으면 그것도 standalone 안으로) · " +
    "start 'HOSTNAME=0.0.0.0 node server.js'). 앱 폴더(/var/task)는 읽기 전용이고 /tmp 만 쓸 수 있다 — /tmp 아래를 가리키는 링크는 시작 전에 그 자리를 만든다. " +
    "올린 뒤 GET / 로 한 번 불러 서버가 뜨는지 본다(안 뜨면 기록과 함께 실패 · 앱 주소는 그대로). 그 판을 **저장한 사람**의 세션에서만 빌드한다 — 남이 저장한 판은 이미 빌드됐을 때만 올라간다. " +
    "빌드는 몇 분 걸릴 수 있어 wait_s(기본 50초) 안에 안 끝나면 status 'running' 으로 돌아오고 뒤에서 이어 간다 — app_server_status 로 본다(실패하면 이 세션에 기록이 들어온다). " +
    "공개(app_visibility_set 'all' · publish:true)는 그 판이 빌드된 뒤에만 된다. 앱 주소의 /_lively/* 밖 경로는 이 함수가 답한다(v2-6 — 게이트웨이가 부르고 · 사람 신원은 함수 안 검사 층이 확인해 x-lively-member 로 넘긴다). " +
    "status 'deployed' 여도 warnings 가 있으면 읽는다(예: 로그 그룹을 못 맞춤 — 그 함수 기록이 CloudWatch 에 안 남을 수 있다 · 다시 넣으면 다시 맞춘다).",
  scope: null,
  input: {
    app_id: z.string(),
    wait_s: z.number().int().min(0).max(600).optional().describe("끝나기를 기다릴 최대 초(기본 50 — 도구 호출 시한이 60초인 클라이언트가 있다 · 0 이면 시작만 하고 바로 돌아온다)"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/apps/:id/server/deploy"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return { app_id: (req.params as Record<string, string>)?.id, ...(b.wait_s !== undefined ? { wait_s: Number(b.wait_s) } : {}) };
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const id = appIdOf(input.app_id);
    const who = viewerOf(user);
    const off = appServerUnavailable();
    if (off) throw new HttpError(503, off);
    const app = await requireVisibleApp(id, who);
    const why = editDenial(app, who, safeManifest(app));
    if (why) throw new HttpError(403, why);
    const t = await installedTarget(app);
    if (!t) throw new HttpError(400, `「${app.title || id}」 은(는) 서버를 선언하지 않았습니다 — 매니페스트에 "web": {"server": {}} 를 넣고(시작 명령은 package.json scripts.start) 저장하세요`);
    const policy = await appServerPolicy();
    const jk = `${blobTenant()}:${id}`;
    let job = jobs.get(jk);
    const started = !job;
    const seat = await seatFor(t, who, ctx as { session?: string } | undefined);
    if (!job) {
      if (!seat && t.savedBy === who.userId) {
        //  빌드가 이미 있으면 자리 없이도 올라간다(deployInstalled 가 본다) — 없을 때만 이 안내가 의미 있다.
        const st0 = await serverStatus(app).catch(() => null);
        const built = (st0?.installed as { build?: { status?: string } } | null)?.build?.status === "ok";
        if (!built) throw new HttpError(409, "빌드할 세션이 없습니다 — 이 앱을 만드는 세션의 AI 에게 app_server_deploy 를 부탁하거나, 앱 만들기 화면에서 「이대로 넣기」 를 누르세요(세션이 꺼져 있으면 먼저 여세요)");
      }
      job = deployInstalled(t, seat, policy).finally(() => { jobs.delete(jk); });
      jobs.set(jk, job);
    }
    const waitMs = Math.max(0, Number(input.wait_s ?? 50)) * 1000;
    const done = await Promise.race([job.then((o) => ({ o })), new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
    const direct = !!seat && String((ctx as { session?: string } | undefined)?.session ?? "") === seat.sessionId;
    if (!done) {
      //  결과를 못 받는 쪽을 위해 — 끝나서 실패면 빌드한 세션에 기록을 넣는다(이 호출이 일을 시작한 경우에만 · 붙기만 한 호출은 넣지 않는다).
      if (started && seat) void job.then((o) => { if (!o.ok) void tellSession(seat, app, o); }).catch(() => { /* 일 자체가 던졌다 — 상태에 남는다 */ });
      return { ok: null, status: "running", app_id: id, version_no: t.versionNo, hint: "빌드·배포가 아직 진행 중입니다 — app_server_status 로 보세요(실패하면 빌드한 세션에 기록이 들어옵니다)" };
    }
    const o = done.o;
    //  화면에서 누른 경우(이 세션이 아닌 곳) — 실패를 빌드한 세션에도 남긴다(그 세션의 AI 가 고치게).
    if (!o.ok && started && seat && !direct) void tellSession(seat, app, o);
    return { ...o, status: o.ok ? "deployed" : "failed" };
  },
};

const appServerStatus: Capability = {
  name: "app_server_status",
  title: "앱 서버 상태",
  description: "앱 서버의 상태 — 서버 선언(web.server) · 지금 판의 빌드(빌드 중이면 지금 하는 일 · 실패면 단계와 까닭) · 함수(cur = 고친 사람이 보는 판 · pub = 공개 판이 가리키는 판) · " +
    "멈춤 여부 · code_mb(이 함수의 코드 저장) · retire(지금 판 · 공개 판 둘 다 web.server 를 뺐으면 함수를 걷는 날 retire_at — 서버 판을 다시 올리면 걷힌다) · " +
    "health(하루 한 번 점검 — checked_at · 별칭마다 ok · idle(쉬는 판) · moved(곧 지워질 옛 zip 판 · 원본 잃은 판을 같은 빌드로 옮김) · repaired(멈췄던 판을 다시 올림) · " +
    "unfixed · failed(못 고침 — 서버를 다시 넣으면 다시 빌드) · deferred(이번에 못 본 까닭 · 연속 횟수)) · " +
    "최근 빌드 5개(걸린 시간 · zip 크기 · 세션 안 메모리 최저). 앱을 볼 수 있는 구성원 누구나.",
  scope: null,
  input: { app_id: z.string() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/apps/:id/server"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const app = await requireVisibleApp(appIdOf(input.app_id), viewerOf(user));
    const s = await serverStatus(app);
    return { ...s, deploying: jobs.has(`${blobTenant()}:${app.id}`) };
  },
};

const appServerStop: Capability = {
  name: "app_server_stop",
  title: "앱 서버 멈추기",
  description: "앱 서버 함수를 멈춘다(동시 실행 0 — 부르면 곧바로 거절된다). 앱 화면 · 데이터는 그대로다. 책임자 · 관리자. 이미 멈춘 함수는 그대로 둔다(changed:false — " +
    "멈춘 사람 · 까닭 기록을 바꾸지 않는다). 다시 켜기는 app_server_resume.",
  scope: null,
  input: { app_id: z.string(), reason: z.string().max(500).optional() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/apps/:id/server/stop"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id, reason: (req.body as Record<string, unknown>)?.reason }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const who = viewerOf(user);
    const app = await requireVisibleApp(appIdOf(input.app_id), who);
    if (!isAppOwner(app, who) && !isAdminViewer(who)) throw new HttpError(403, "앱 서버를 멈출 수 있는 사람은 책임자와 관리자입니다");
    const { row, changed } = await stopServer(app.id, who.userId, "manual", String(input.reason ?? "").trim() || "손으로 멈춤");
    return { ok: true, app_id: app.id, changed, stopped: { at: row.stopped_at, by: row.stopped_by, kind: row.stop_kind, reason: row.stop_reason } };
  },
};

const appServerResume: Capability = {
  name: "app_server_resume",
  title: "앱 서버 다시 켜기",
  description: "멈춘 앱 서버를 다시 켠다. 자동 멈춤(호출 · 실행 시간 상한 초과)은 관리자만 · 책임자가 손으로 멈춘 것은 그 책임자도.",
  scope: null,
  input: { app_id: z.string() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/apps/:id/server/resume"], parse: (req) => ({ app_id: (req.params as Record<string, string>)?.id }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => {
    const who = viewerOf(user);
    const app = await requireVisibleApp(appIdOf(input.app_id), who);
    const row = await getServerRow(app.id);
    if (!row) throw new HttpError(404, "이 앱은 서버 함수가 없습니다");
    if (!row.stopped_at) return { ok: true, app_id: app.id, changed: false };
    //  자동 멈춤인지는 감시만 쓰는 칸(stop_kind)으로 가른다 — 사람이 쓰는 까닭 글(stop_reason)로 가르면 그 글을 바꿔 우회한다(격리 리뷰).
    const auto = row.stop_kind === "auto";
    const ownManual = !auto && isAppOwner(app, who) && row.stopped_by === who.userId;
    if (!isAdminViewer(who) && !ownManual) throw new HttpError(403, auto ? "자동으로 멈춘 앱 서버는 관리자가 다시 켭니다" : "멈춘 사람(책임자)이나 관리자가 다시 켭니다");
    await resumeServer(app.id);
    return { ok: true, app_id: app.id, changed: true };
  },
};

async function limitsSnapshot(): Promise<Record<string, unknown>> {
  const [policy, row, functions, code] = await Promise.all([appServerPolicy(), appServerPolicyRow(), countServerRows(), sumServerCodeBytes()]);
  return {
    policy, workspace_setting: row, platform_default: envAppServerPolicy(), min: APP_SERVER_POLICY_MIN, ceiling: APP_SERVER_POLICY_MAX, available: appServerUnavailable(),
    usage: { functions, code_mb: mbOf(code) },
  };
}

const appServerLimits: Capability = {
  name: "app_server_limits",
  title: "앱 서버 상한 보기",
  description: "앱 서버 상한 — policy(지금 값: memory_mb 함수 메모리 · timeout_s 요청 시간 · build_timeout_s 빌드 시간 · build_mem_floor_mb 빌드를 멈추는 세션 남은 메모리 · " +
    "build_heap_mb 빌드 node 힙 · stop_invocations_5m · stop_duration_s_5m 자동 멈춤 기준 · log_retention_days · keep_versions · " +
    "workspace_functions_max 이 워크스페이스의 서버 함수 수(앱마다 하나 · 새 함수만 막는다) · workspace_code_mb 이 워크스페이스 함수들의 코드 저장 합(MiB · AWS 가 세는 판마다의 zip 크기 · " +
    "늘리는 배포만 막는다) · unused_retire_days 지금 판 · 공개 판 둘 다 web.server 가 없는 앱의 함수를 걷기까지의 날수 · " +
    "max_inflight_workspace · max_inflight_app 동시 처리 상한 — 워크스페이스 · 앱마다 지금 처리 중인 요청 수, 넘으면 함수를 부르지 않고 429 · 앱 값은 워크스페이스 값까지만 쓴다) · " +
    "workspace_setting(저장한 값) · platform_default · min · ceiling · usage(functions 지금 함수 수 · code_mb 지금 코드 저장). 구성원 누구나.",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/app-server-limits"], parse: () => ({}) }] },
  handler: async () => limitsSnapshot(),
};

const appServerLimitsSet: Capability = {
  name: "app_server_limits_set",
  title: "앱 서버 상한 고치기",
  description: "이 워크스페이스의 앱 서버 상한을 고친다(배포 없이 · 함수 메모리 · 시간은 다음 배포부터 · 함수 수 · 코드 저장은 다음 배포부터 — 내려도 있는 함수는 그대로 · " +
    "동시 처리 상한은 10초 안에). 준 값만 바뀌고 reset:true 면 플랫폼 기본으로. " +
    `천장: 메모리 ${APP_SERVER_POLICY_MAX.memory_mb}MB · 요청 ${APP_SERVER_POLICY_MAX.timeout_s}초 · 빌드 ${APP_SERVER_POLICY_MAX.build_timeout_s}초 · ` +
    `함수 ${APP_SERVER_POLICY_MAX.workspace_functions_max}개 · 코드 저장 ${APP_SERVER_POLICY_MAX.workspace_code_mb}MB · ` +
    `동시 처리 워크스페이스 ${APP_SERVER_POLICY_MAX.max_inflight_workspace} · 앱 ${APP_SERVER_POLICY_MAX.max_inflight_app}(앱 값은 워크스페이스 값까지만 쓴다). 관리자.`,
  scope: "admin",
  input: {
    ...Object.fromEntries(APP_SERVER_POLICY_KEYS.map((k) => [k, z.number().int().min(APP_SERVER_POLICY_MIN[k]).max(APP_SERVER_POLICY_MAX[k]).optional()])),
    reset: z.boolean().optional().describe("true 면 워크스페이스 값을 지워 플랫폼 기본으로"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-server-limits"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of [...APP_SERVER_POLICY_KEYS, "reset"] as const) if (b[k] !== undefined) out[k] = b[k];
      return out;
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    let next: Record<string, number> = {};
    if (input.reset !== true) {
      const cur = await appServerPolicyRow();
      for (const k of APP_SERVER_POLICY_KEYS) if (typeof cur[k] === "number") next[k] = cur[k] as number;
      for (const k of APP_SERVER_POLICY_KEYS) {
        if (input[k] === undefined) continue;
        const n = Number(input[k]);
        if (!Number.isInteger(n) || n < APP_SERVER_POLICY_MIN[k] || n > APP_SERVER_POLICY_MAX[k]) throw new HttpError(400, `${k} 는 ${APP_SERVER_POLICY_MIN[k]}~${APP_SERVER_POLICY_MAX[k]} 정수여야 합니다`);
        next[k] = n;
      }
      //  저장은 준 값 그대로(칸끼리 맞추지 않는다) — 앱 동시 처리 상한이 워크스페이스 값보다 커도 쓸 때만 깎는다(normalizeAppServerPolicy effective).
      const norm: AppServerPolicy = normalizeAppServerPolicy(next, envAppServerPolicy(), { effective: false });
      next = Object.fromEntries(Object.keys(next).map((k) => [k, norm[k as keyof AppServerPolicy]]));
    }
    await setAppServerPolicy(next, { actor: actorOf(user), source: ctx?.source ?? "web" });
    return { ok: true, ...(await limitsSnapshot()) };
  },
};

export const appServerCapabilities: Capability[] = [appServerDeploy, appServerStatus, appServerStop, appServerResume, appServerLimits, appServerLimitsSet];

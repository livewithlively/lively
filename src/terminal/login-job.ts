// 하네스 로그인을 **CP 판**으로 — 작업 수명 · 판 콜백 · 결과 적용 · 정리 감시 (#4012 T13 · #4067).
//
// ── 무엇 ────────────────────────────────────────────────────────────────────
//  매니지드에서 대화형 로그인(claude·codex·grok)과 헤드리스 발급(claude·codex)을 세션 컨테이너 대신 CP 일시 유닛
//  (lvly-cloud task-op `login` 프로필)에서 돌린다. 판 스크립트는 login-job-script.ts, 행은 login-job-store.ts.
//  화면이 보는 응답 모양(ai-login/state · headless-login/state)은 **종전과 같다** — 화면은 한 줄도 안 바뀐다.
//
// ── 판과 게이트웨이 ──────────────────────────────────────────────────────────
//  판은 게이트웨이 **공인 주소**(gatewayUrl — 맥락 잡 판이 MCP 로 붙는 그 주소)로 `/api/login-jobs/:id/{tick,result,end}` 를
//  부른다. 사용자 인증이 아니라 작업별 일회용 비밀로 자기를 밝힌다(DB 에는 해시만). 콜백은 테넌트 호스트로 오므로
//  앞단이 서명한 테넌트 컨텍스트 안에서 돌고, RLS 가 남의 작업을 가린다.
//
// ── 어느 길로 가나 ────────────────────────────────────────────────────────────
//  · 시작: 판을 쓸 수 있으면(op 소켓 + CP 가 `login` 을 앎 + 그 하네스를 앎) 작업, 아니면 종전 경로(legacy).
//  · 상태·붙여넣기·취소: **DB 가 정한다** — 최근 작업 행이 있으면 작업, 없으면 종전 경로. 캐시로 정하지 않는 이유:
//    청/녹 두 슬롯은 캐시가 따로라, 시작을 받은 슬롯과 조회를 받은 슬롯이 다른 답을 낼 수 있다.
//
// ── 언제 끝나나(상민님 2026-09-17: «끝나거나 오래 진행이 없으면 꺼서 CP 에 남기지 말 것») ──
//  성공 · 실패 · 사람이 취소 · 화면이 UI_IDLE_MS 넘게 안 물음 · 나이 MAX_AGE_MS · 판이 UNIT_DEAD_MS 넘게 무응답.
//  끝난 판은 op stop → reap(작업 폴더 제거)까지 간다. 판 스스로도 같은 경우에 끝난다(이중 안전).
//
// ── 어디서 안 도나 ────────────────────────────────────────────────────────────
//  op 소켓이 없거나(셀프호스트) · CP 가 `login` 을 모르거나 · 그 하네스를 CP 가 모르면(bad_harness) 종전 경로다.
//  Gemini(agy)는 비대화형 로그인이 없고 자격이 키링이라 판으로 옮길 수 없다 — 종전 세션 경로(예외).
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { EXIT_MARK, aiLoginStep, parseAiLogin, isAiLoginHarness, type AiLoginHarness } from "./ai-login-flow.js";
import { headlessStateOf, isHeadlessLoginHarness, type HeadlessLoginHarness } from "./headless-login-flow.js";
import {
  LOGIN_JOB_TIMING, loginJobRunScript, loginJobSpec, redactSecrets,
  type LoginPurpose,
} from "./login-job-script.js";
import type { LoginJobRow, LoginJobStatus } from "./login-job-store.js";
import type { HeadlessAdminBasis } from "../org/credentials/headless-connect.js";
import type { TaskOpPart, TaskOpReply } from "../node/sandbox-task.js";

// ── 시간표 ────────────────────────────────────────────────────────────────────
/** 화면이 이만큼 안 물으면 사람이 떠난 것이다 — 판을 끈다. 화면의 폴링은 2초 간격이고, 뒤로 간 탭도 1분에 한 번은 문다. */
export const UI_IDLE_MS = 3 * 60_000;
/** 작업 나이 상한 — 판의 자체 상한(LOGIN_JOB_TIMING.softMaxMs)보다 길고 op 의 RuntimeMaxSec(1200초)과 같다. */
export const MAX_AGE_MS = 20 * 60_000;
/** 판이 이만큼 안 부르면 죽은 것이다(판은 5초마다 박동한다). 첫 박동 전에는 만든 시각부터 잰다. */
export const UNIT_DEAD_MS = 2 * 60_000;
/** «최근 작업» 의 폭 — 작업의 최대 수명에 여유를 더한 것. 이보다 오래된 행은 지금 시도의 것이 아니다. */
export const RECENT_MS = MAX_AGE_MS + 60_000;
/** 끝난 판의 폴더를 치우기까지 기다리는 시간 — 판이 결과를 넘기고 스스로 나갈 틈. */
export const REAP_DELAY_MS = 8_000;
/** op hello 기억 — 매 요청 소켓을 두드리지 않는다. */
export const PROFILE_CACHE_MS = 60_000;
/** hello 가 **닿지 않았을 때** 다시 묻기까지 — 아는 답이 있으면 그 답을 이만큼 더 믿는다(순간 끊김으로 길을 바꾸지 않게). */
export const PROFILE_RETRY_MS = 10_000;
/** CP 가 모른다고 한 하네스를 다시 묻지 않는 시간 — CP 배포(설치)가 끝나면 풀린다. */
export const UNSUPPORTED_TTL_MS = 10 * 60_000;
/** 화면 저장 상한 — 판의 상한과 같다. */
export const SCREEN_MAX = LOGIN_JOB_TIMING.screenMax;
/** claude 계정 정보(.claude.json oauthAccount) 상한. */
export const ACCOUNT_MAX = 16 * 1024;

export const LOGIN_PROFILE = "login";
/** 붙여넣기 코드 모양 — 종전 러너(ai-login-run · headless-login-run)와 같은 자. */
const PASTE_RE = /^[A-Za-z0-9._~+/=#?&:%-]{4,512}$/;

// ── 의존성 ────────────────────────────────────────────────────────────────────
export interface LoginJobDeps {
  store: {
    createLoginJob(o: { memberId: string; harness: string; purpose: LoginPurpose; secretHash: string; adminBasis: HeadlessAdminBasis }): Promise<LoginJobRow>;
    deleteLoginJob(id: number): Promise<void>;
    getLoginJob(id: number): Promise<LoginJobRow | null>;
    latestLoginJob(memberId: string, purpose: LoginPurpose, harness: string): Promise<LoginJobRow | null>;
    markLoginJobRunning(id: number, unit: string): Promise<LoginJobStatus | null>;
    touchLoginJobUi(id: number): Promise<void>;
    tickLoginJob(id: number, screen: string): Promise<{ paste: string | null } | null>;
    setLoginJobPaste(id: number, encrypted: string): Promise<boolean>;
    finishLoginJob(id: number, status: Exclude<LoginJobStatus, "starting" | "running">,
      o?: { error?: string | null; exitCode?: number | null; screen?: string | null }): Promise<boolean>;
    markLoginJobReaped(id: number): Promise<void>;
    openLoginJobs(limit?: number): Promise<LoginJobRow[]>;
    newJobSecret(): { secret: string; hash: string };
    jobSecretMatches(row: Pick<LoginJobRow, "secret_hash"> | null | undefined, presented: string): boolean;
  };
  op(header: Record<string, unknown>, parts?: { files?: TaskOpPart[]; creds?: TaskOpPart[] }, opts?: { timeoutMs?: number }): Promise<TaskOpReply>;
  sandboxAvailable(): boolean;
  gatewayUrl(): Promise<string | null>;
  tenantSlug(): string | null;
  secretsEnabled(): boolean;
  encrypt(plain: string): string;
  decrypt(enc: string): string | null;
  now(): number;
  nonce(): string;
  /** 헤드리스 자격 저장(실행 멤버 채우기 포함 — 종전 화면 연결과 같은 함수). 관리자 판정은 근거로 그때 잰다. */
  storeHeadless(o: { memberId: string; harness: HeadlessLoginHarness; secret: string; adminBasis: HeadlessAdminBasis }):
    Promise<{ ok: true; runner: string } | { ok: false; error: string }>;
  /** 로그인 자격을 멤버 홈에 둔다(멤버 파일 op). */
  installLogin(o: { memberId: string; harness: AiLoginHarness; files: Array<{ path: string; content: string }>; account: Record<string, unknown> | null }): Promise<void>;
  /** 끝난 판 치우기를 조금 뒤로 미룬다(테넌트 컨텍스트를 이어서). */
  later(fn: () => Promise<unknown>, ms: number): void;
}

const DEP_KEYS: ReadonlyArray<keyof LoginJobDeps> = Object.freeze([
  "store", "op", "sandboxAvailable", "gatewayUrl", "tenantSlug", "secretsEnabled", "encrypt", "decrypt", "now", "nonce",
  "storeHeadless", "installLogin", "later",
]);

async function defaultDeps(): Promise<LoginJobDeps> {
  const store = await import("./login-job-store.js");
  const sb = await import("../node/sandbox-task.js");
  const box = await import("../org/credentials/secret-box.js");
  const { gatewayUrl } = await import("../gateway-url.js");
  const { tenantSlug } = await import("./catalog.js");
  const { randomBytes } = await import("node:crypto");
  return {
    store,
    op: (h, p, o) => sb.callTaskOp(h, p, o),
    sandboxAvailable: () => sb.sandboxAvailable(),
    gatewayUrl: () => gatewayUrl(),
    tenantSlug: () => tenantSlug(),
    secretsEnabled: () => box.secretsEnabled(),
    encrypt: (s) => box.encryptSecret(s),
    decrypt: (s) => box.tryDecryptSecret(s),
    now: () => Date.now(),
    nonce: () => randomBytes(16).toString("hex"),
    storeHeadless: async (o) => {
      const hc = await import("../org/credentials/headless-connect.js");
      //  판의 콜백엔 사용자 토큰이 없다 — 시작 요청이 적어 둔 근거로 **지금** 잰다(headlessAdminBasis 머리말).
      const r = await hc.storeHeadlessCredential({
        memberId: o.memberId, harness: o.harness, secret: o.secret, actor: o.memberId,
        isAdmin: await hc.adminFromBasis(o.adminBasis, o.memberId),
      });
      return r.ok ? { ok: true, runner: r.runner } : { ok: false, error: r.error };
    },
    installLogin: (o) => installLoginCredential(o),
    later: (fn, ms) => {
      void import("../org/tenant-context.js").then(({ currentTenant, withTenant }) => {
        const t = currentTenant();
        const run = (): void => { void Promise.resolve(t ? withTenant(t, fn) : fn()).catch(() => { /* 감시가 다시 거둔다 */ }); };
        setTimeout(run, ms).unref?.();
      });
    },
  };
}
async function depsOf(inject: Partial<LoginJobDeps>): Promise<LoginJobDeps> {
  if (DEP_KEYS.every((k) => k in inject)) return inject as LoginJobDeps;
  return { ...(await defaultDeps()), ...inject };
}

// ── 판을 쓸 수 있나 ───────────────────────────────────────────────────────────
let profileCache: { at: number; ok: boolean } | null = null;
const unsupported = new Map<string, number>();

/** 시험 이음매 — 기억을 지운다. */
export function resetLoginJobCaches(): void { profileCache = null; unsupported.clear(); }

/** 이 시작을 판으로 돌리나(아니면 호출자가 종전 경로를 쓴다). */
async function loginJobsUsable(d: LoginJobDeps, harness: string): Promise<boolean> {
  if (!d.sandboxAvailable()) return false;
  const until = unsupported.get(harness);
  if (until !== undefined && until > d.now()) return false;
  const now = d.now();
  if (!profileCache || now - profileCache.at >= PROFILE_CACHE_MS) {
    const r = await d.op({ op: "hello" }, {}, { timeoutMs: 5_000 })
      .catch((e) => ({ ok: false, code: "op_unreachable", error: String(e) } as TaskOpReply));
    if (r.ok) {
      const list = Array.isArray(r.profiles) ? (r.profiles as unknown[]) : [];
      profileCache = { at: now, ok: list.includes(LOGIN_PROFILE) };
    } else if (String(r.code ?? "").startsWith("op_")) {
      //  닿지 않았다(op 재기동 등) — 아는 답을 잠시 더 믿는다. 모르면 종전 경로(안전한 쪽)로 짧게.
      profileCache = { at: now - PROFILE_CACHE_MS + PROFILE_RETRY_MS, ok: profileCache?.ok ?? false };
    } else {
      profileCache = { at: now, ok: false };
    }
  }
  return profileCache.ok;
}

// ── 작업 수명(화면 쪽) ─────────────────────────────────────────────────────────
const LIVE: ReadonlySet<string> = new Set(["starting", "running"]);
const isLive = (j: LoginJobRow | null | undefined): j is LoginJobRow => !!j && LIVE.has(j.status);
const ms = (v: Date | string | null | undefined): number | null => (v ? new Date(v).getTime() : null);

export type StaleReason = "ui-idle" | "max-age" | "unit-dead";

/** (순수) 살아 있는 작업을 지금 끝내야 하나 — 끝내야 하면 그 이유. 경계값은 끝낸다(`>=`). */
export function staleReason(j: Pick<LoginJobRow, "status" | "created_at" | "ui_seen_at" | "unit_seen_at">, now: number): StaleReason | null {
  if (!LIVE.has(j.status)) return null;
  const created = ms(j.created_at) ?? now;
  if (now - created >= MAX_AGE_MS) return "max-age";
  if (now - (ms(j.ui_seen_at) ?? created) >= UI_IDLE_MS) return "ui-idle";
  if (now - (ms(j.unit_seen_at) ?? created) >= UNIT_DEAD_MS) return "unit-dead";
  return null;
}

export const STALE_MESSAGE: Readonly<Record<StaleReason, string>> = Object.freeze({
  "ui-idle": "화면을 떠나 있어 연결 시도를 멈췄어요. 다시 시작해 주세요.",
  "max-age": "시간이 오래 지나 연결 시도를 멈췄어요. 다시 시작해 주세요.",
  "unit-dead": "연결 시도가 응답하지 않아 멈췄어요. 다시 시작해 주세요.",
});
const FINAL_DEFAULT: Readonly<Record<string, string>> = Object.freeze({
  failed: "연결 시도가 실패했어요. 다시 시도해 주세요.",
  cancelled: "연결 시도를 멈췄어요.",
  expired: "연결 시도가 멈췄어요. 다시 시작해 주세요.",
});

/** 판을 멈추고(있다면) 조금 뒤 폴더를 치운다. 멈추기 실패는 삼킨다 — 감시가 다시 한다. */
async function stopUnit(d: LoginJobDeps, j: Pick<LoginJobRow, "id" | "unit">): Promise<void> {
  if (j.unit) await d.op({ op: "stop", unit: j.unit }).catch(() => undefined);
  d.later(() => reapJob(d, j), REAP_DELAY_MS);
}

/** 판 폴더를 치운다. 치웠거나 치울 것이 없으면 true — 아직 살아 있거나 op 가 못 받았으면 false(다음 차례). */
async function reapJob(d: LoginJobDeps, j: Pick<LoginJobRow, "id" | "unit">): Promise<boolean> {
  //  들고 온 행에 유닛이 없으면 지금 행을 다시 본다 — 판을 띄우는 사이에 끝낸 작업은 유닛 이름이 **나중에** 적힌다.
  const unit = j.unit || (await d.store.getLoginJob(j.id))?.unit || null;
  if (!unit) { await d.store.markLoginJobReaped(j.id); return true; }
  const r = await d.op({ op: "reap", unit }).catch(() => ({ ok: false, code: "op_unreachable" } as TaskOpReply));
  if (!r.ok) {
    //  아직 살아 있으면 멈춤을 다시 건다 — 폴더를 안 치운 채로 «치웠다» 고 적지 않고 다음 차례에 본다.
    if (r.code === "active") await d.op({ op: "stop", unit }).catch(() => undefined);
    //  op 가 만든 유닛이 아니라면(bad_unit) 치울 수단이 없다 — 더 붙들지 않는다. 그 밖(살아 있음·불통)은 다음 차례.
    if (r.code !== "bad_unit") return false;
  }
  await d.store.markLoginJobReaped(j.id);
  return true;
}

async function expire(d: LoginJobDeps, j: LoginJobRow, why: StaleReason): Promise<void> {
  if (await d.store.finishLoginJob(j.id, "expired", { error: STALE_MESSAGE[why] })) {
    logger.info({ job: j.id, member: j.member_id, harness: j.harness, purpose: j.purpose, why }, "login-job: 멈춤");
  }
  await stopUnit(d, j);
}

/**
 * 작업 표가 **아직 없으면** 대신 줄 값 — 그 밖의 오류는 그대로 던진다.
 *  ⚠ 왜(실측 2026-09-17, 첫 롤): 새 게이트웨이가 공용 DB 마이그레이션보다 **먼저** 요청을 받았다 — 2분 남짓
 *   `relation "org_login_job" does not exist`. 그 창의 로그인은 500 이 아니라 종전 경로로 가야 한다.
 *   셀프호스트도 스키마 체인이 listen 뒤에 비동기로 돈다(readyz 머리말) — 같은 창이 있다.
 */
const MISSING = Symbol("login-job-table-missing");
async function orMissing<T, F>(p: Promise<T>, fallback: F): Promise<T | F> {
  try { return await p; }
  catch (e) {
    if ((e as { code?: unknown })?.code === "42P01") return fallback;   // undefined_table
    throw e;
  }
}

/** 이 사람·용도·하네스의 **지금 시도** 작업(최근 RECENT_MS 안) — 없으면 null(종전 경로). */
async function recentJob(d: LoginJobDeps, memberId: string, purpose: LoginPurpose, harness: string): Promise<LoginJobRow | null> {
  //  판이 없는 배포(셀프호스트)는 작업 행을 **읽지도 않는다** — 종전 로그인의 조회마다 DB 를 치지 않게.
  //   판의 유무(op 소켓)는 박스의 성질이라 청/녹 두 슬롯이 같은 답을 본다(«DB 가 정한다» 와 어긋나지 않는다).
  if (!d.sandboxAvailable()) return null;
  const j = await orMissing(d.store.latestLoginJob(memberId, purpose, harness), null);
  if (!j) return null;
  return d.now() - (ms(j.created_at) ?? 0) < RECENT_MS ? j : null;
}

/** 판을 못 띄운 사유 → 사람에게 할 말. */
function launchFailMessage(code: string): string {
  if (code === "busy") return "지금 로그인 자리가 잠시 가득 찼어요. 조금 뒤 다시 시도해 주세요.";
  return `로그인을 시작하지 못했어요(${code || "알 수 없음"}) — 잠시 뒤 다시 시도해 주세요.`;
}

/**
 * 시작 — 판을 띄우거나(`job`), 판으로 못 도니 종전 경로로 가라고 답한다(`legacy`).
 *  restart 가 아니면 살아 있는 작업을 **이어받는다**(받은 주소가 죽지 않게 — 화면을 다시 그리거나 새로고침해도).
 */
export async function startLoginJob(
  o: { memberId: string; purpose: LoginPurpose; harness: string; restart: boolean; adminBasis: HeadlessAdminBasis },
  inject: Partial<LoginJobDeps> = {},
): Promise<{ mode: "job"; jobId: number; resumed: boolean } | { mode: "legacy" }> {
  if (!loginJobSpec(o.purpose, o.harness)) return { mode: "legacy" };
  const d = await depsOf(inject);
  if (!d.sandboxAvailable()) return { mode: "legacy" };
  const prev = await orMissing(d.store.latestLoginJob(o.memberId, o.purpose, o.harness), MISSING);
  if (prev === MISSING) return { mode: "legacy" };
  if (isLive(prev)) {
    const why = staleReason(prev, d.now());
    if (!o.restart && !why) {
      await d.store.touchLoginJobUi(prev.id);
      return { mode: "job", jobId: prev.id, resumed: true };
    }
    if (why) await expire(d, prev, why);
    else if (await d.store.finishLoginJob(prev.id, "cancelled", { error: "새로 시작했어요." })) await stopUnit(d, prev);
  }
  if (!(await loginJobsUsable(d, o.harness))) return { mode: "legacy" };
  //  붙여넣기 코드를 암호화해 둘 키가 없으면 판으로 돌리지 않는다. 헤드리스는 어차피 저장을 못 하니 시작하지 않는다 —
  //   사람이 브라우저에서 허용까지 한 뒤에 막히면 헛수고다(종전 헤드리스 시작과 같은 문장). 대화형은 종전 경로가 받는다.
  if (!d.secretsEnabled()) {
    if (o.purpose === "login") return { mode: "legacy" };
    throw new HttpError(400, "이 서버에는 자격을 암호화해 둘 키가 없어 연결할 수 없습니다 — 관리자에게 CONNECTOR_SECRET_KEY 설정을 요청해 주세요.");
  }
  const gw = String((await d.gatewayUrl().catch(() => null)) ?? "").replace(/\/+$/, "");
  const slug = d.tenantSlug();
  if (!/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/.test(gw) || !slug) {
    throw new HttpError(503, "로그인을 시작할 게이트웨이 주소를 모릅니다 — 관리자에게 워크스페이스 공개 주소 설정을 요청해 주세요.");
  }
  const { secret, hash } = d.store.newJobSecret();
  const job = await d.store.createLoginJob({
    memberId: o.memberId, harness: o.harness, purpose: o.purpose, secretHash: hash, adminBasis: o.adminBasis,
  });
  const r = await d.op({
    op: "launch", slug, task_id: job.id, attempt: 1, profile: LOGIN_PROFILE, harness: o.harness,
    env: {
      LIVELY_GATEWAY_URL: gw, LIVELY_LOGIN_JOB: String(job.id), LIVELY_LOGIN_PURPOSE: o.purpose,
      LIVELY_HARNESS: o.harness, LVLY_TENANT_SLUG: slug,
    },
    nonce: d.nonce(),
    limits: { runtime_sec: Math.round(MAX_AGE_MS / 1000) },
  }, {
    files: [{ name: "run.mjs", data: Buffer.from(loginJobRunScript(), "utf8") }],
    creds: [{ name: "job", data: Buffer.from(secret, "utf8") }],
  }, { timeoutMs: 45_000 }).catch((e) => ({ ok: false, code: "op_error", error: String((e as Error)?.message ?? e) } as TaskOpReply));
  if (r.ok) {
    const unit = String(r.unit ?? "");
    const now = await d.store.markLoginJobRunning(job.id, unit);
    logger.info({ job: job.id, member: o.memberId, harness: o.harness, purpose: o.purpose, unit, status: now }, "login-job: 시작");
    //  띄우는 사이에 다른 요청이 이 작업을 끝냈다(취소·다시 시작) — 그 요청은 유닛 이름을 몰랐으니 여기서 멈춘다.
    if (now !== "running") await stopUnit(d, { id: job.id, unit });
    return { mode: "job", jobId: job.id, resumed: false };
  }
  const code = String(r.code ?? "");
  logger.warn({ job: job.id, harness: o.harness, purpose: o.purpose, code }, "login-job: 판을 못 띄움");
  //  CP 가 이 판(또는 하네스)을 모른다 — 행을 **지우고** 종전 경로로. 남겨 두면 뒤따르는 조회가 이 행을
  //   «지금 시도» 로 읽어 종전 경로의 화면을 가린다(상태·붙여넣기·취소는 최근 행으로 길을 정한다).
  if (code === "bad_profile" || code === "bad_harness") {
    if (code === "bad_profile") profileCache = { at: d.now(), ok: false };
    else unsupported.set(o.harness, d.now() + UNSUPPORTED_TTL_MS);
    await d.store.deleteLoginJob(job.id);
    return { mode: "legacy" };
  }
  //  그 밖(자리 가득·일시 오류)은 종전 경로로 흘리지 않는다 — 그 길(노드의 세션 컨테이너)이 막혀서 여기로 왔다.
  //   행은 실패로 남긴다: 이어지는 조회가 같은 문장을 보여 준다(화면은 시작 실패 뒤에도 조회를 이어 간다).
  //   launch 가 판을 못 세우면 op 가 폴더를 이미 거뒀다(치울 것이 없다). 시간초과로 응답만 못 받은 경우는
  //   판이 섰더라도 다음 박동이 410 을 받고 스스로 끝난다.
  const message = launchFailMessage(code);
  await d.store.finishLoginJob(job.id, "failed", { error: message });
  await d.store.markLoginJobReaped(job.id);
  throw new HttpError(503, message);
}

/** 화면이 물을 작업 — 살아 있으면 박동을 찍고, 이미 죽었으면 그 자리에서 멈춘다(감시를 기다리지 않는다). */
async function jobForUi(d: LoginJobDeps, memberId: string, purpose: LoginPurpose, harness: string): Promise<LoginJobRow | null> {
  const j = await recentJob(d, memberId, purpose, harness);
  if (!isLive(j)) return j;
  //  화면이 지금 묻고 있으니 «화면 무폴링» 은 이유가 아니다 — 판 무응답·나이만 본다.
  const why = staleReason({ ...j, ui_seen_at: new Date(d.now()) }, d.now());
  if (!why) {
    await d.store.touchLoginJobUi(j.id);
    return j;
  }
  await expire(d, j, why);
  return (await d.store.getLoginJob(j.id)) ?? j;
}

/** (순수) 끝난 작업의 화면 오류 — 우리가 끝낸 사유(취소·만료·거절)가 있으면 그것이 이긴다. 없으면 CLI 가 말한 것, 그것도 없으면 기본 문장. */
function finalError(j: LoginJobRow, parsed: string | undefined): string {
  if (j.error) return j.error;
  return parsed || FINAL_DEFAULT[j.status] || FINAL_DEFAULT.failed!;
}

/** 대화형 로그인 화면 상태 — ai-login/state 와 **같은 모양**. 지금 시도 작업이 없으면 null(종전 경로). */
export async function loginJobLoginState(
  o: { memberId: string; harness: AiLoginHarness; loggedIn: () => Promise<boolean | null> },
  inject: Partial<LoginJobDeps> = {},
): Promise<Record<string, unknown> | null> {
  const d = await depsOf(inject);
  const j = await jobForUi(d, o.memberId, "login", o.harness);
  if (!j) return null;
  const final = !LIVE.has(j.status);
  const code = j.exit_code ?? (j.status === "done" ? 0 : 1);
  const st: ReturnType<typeof parseAiLogin> = parseAiLogin(o.harness, `${j.screen}${final ? `\n${EXIT_MARK} ${code}\n` : ""}`);
  if (final && j.status !== "done") st.error = finalError(j, st.error);
  const loggedIn = await o.loggedIn().catch(() => null);
  return { ...st, loggedIn, step: aiLoginStep(st, loggedIn) };
}

/** 헤드리스 발급 화면 상태 — headless-login/state 와 **같은 모양**. 지금 시도 작업이 없으면 null(종전 경로). */
export async function loginJobHeadlessState(
  o: { memberId: string; harness: HeadlessLoginHarness },
  inject: Partial<LoginJobDeps> = {},
): Promise<Record<string, unknown> | null> {
  const d = await depsOf(inject);
  const j = await jobForUi(d, o.memberId, "headless", o.harness);
  if (!j) return null;
  const stored = j.status === "done";
  const final = !LIVE.has(j.status);
  const log = `${j.screen}${final && !stored ? `\n${EXIT_MARK} ${j.exit_code ?? 1}\n` : ""}`;
  const st = headlessStateOf(o.harness, { log, ended: final && !stored, hasCaptured: false }, { stored });
  if (final && !stored) {
    st.error = finalError(j, st.error);
    st.step = "failed";
  }
  return st as unknown as Record<string, unknown>;
}

/** 사람이 받아 온 코드를 판에 넘긴다(다음 박동에 판이 가져간다). 지금 시도 작업이 없으면 false(종전 경로). */
export async function pasteLoginJob(
  o: { memberId: string; purpose: LoginPurpose; harness: string; code: string },
  inject: Partial<LoginJobDeps> = {},
): Promise<boolean> {
  const d = await depsOf(inject);
  const j = await recentJob(d, o.memberId, o.purpose, o.harness);
  if (!j) return false;
  const v = String(o.code ?? "").trim();
  if (!PASTE_RE.test(v)) throw new HttpError(400, "코드 형식이 올바르지 않습니다.");
  if (!isLive(j) || !(await d.store.setLoginJobPaste(j.id, d.encrypt(v)))) {
    throw new HttpError(409, "연결 시도가 이미 끝났어요 — 다시 시작해 주세요.");
  }
  await d.store.touchLoginJobUi(j.id);
  return true;
}

/** 사람이 그만뒀다(또는 화면이 끝을 정리한다). 지금 시도 작업이 없으면 false(종전 경로). 끝난 작업엔 아무것도 안 한다. */
export async function cancelLoginJob(
  o: { memberId: string; purpose: LoginPurpose; harness: string },
  inject: Partial<LoginJobDeps> = {},
): Promise<boolean> {
  const d = await depsOf(inject);
  const j = await recentJob(d, o.memberId, o.purpose, o.harness);
  if (!j) return false;
  if (!isLive(j)) return true;
  if (await d.store.finishLoginJob(j.id, "cancelled", { error: FINAL_DEFAULT.cancelled })) {
    logger.info({ job: j.id, member: o.memberId, harness: o.harness, purpose: o.purpose }, "login-job: 취소");
  }
  await stopUnit(d, j);
  return true;
}

// ── 판 콜백 ────────────────────────────────────────────────────────────────────
/** 판이 보낸 비밀로 작업을 찾는다. 없는 작업 404 · 틀린 비밀 401 · 끝난 작업 410(판은 셋 다 «끝내라» 로 읽는다). */
async function authJob(d: LoginJobDeps, id: number, bearer: string, allowFinal = false): Promise<LoginJobRow> {
  const j = await d.store.getLoginJob(id);
  if (!j) throw new HttpError(404, "없는 로그인 작업입니다");
  if (!d.store.jobSecretMatches(j, bearer)) throw new HttpError(401, "로그인 작업 인증 실패");
  if (!allowFinal && !LIVE.has(j.status)) throw new HttpError(410, "이미 끝난 로그인 작업입니다");
  return j;
}

/** 판의 박동 — 화면을 받고, 멈춤 또는 붙여넣기를 돌려준다. */
export async function onLoginJobTick(id: number, bearer: string, body: unknown, inject: Partial<LoginJobDeps> = {}):
  Promise<{ ok: true; stop?: true; why?: string; paste?: string }> {
  const d = await depsOf(inject);
  const j = await authJob(d, id, bearer);
  //  판이 박동한다 = 살아 있다. 화면 무폴링·나이는 여기서 먼저 본다(멈출 판에 코드를 건네지 않는다).
  const why = staleReason({ ...j, unit_seen_at: new Date(d.now()) }, d.now());
  if (why) {
    await expire(d, j, why);
    return { ok: true, stop: true, why };
  }
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).screen : "";
  const screen = redactSecrets(typeof raw === "string" ? raw : "").slice(-SCREEN_MAX);
  const t = await d.store.tickLoginJob(id, screen);
  if (!t) return { ok: true, stop: true, why: "ended" };   // 그 사이 끝났다(취소 등)
  if (t.paste) {
    const code = d.decrypt(t.paste);
    if (code) return { ok: true, paste: code };
    logger.warn({ job: id }, "login-job: 붙여넣기 코드를 풀지 못함(키 교체?)");
  }
  return { ok: true };
}

/** (순수) 로그인 결과의 모양 검사 — 통과하면 적용할 값. 판이 보낸 값은 믿지 않는다. */
export function checkLoginResult(harness: string, body: unknown):
  { ok: true; files: Array<{ path: string; content: string }>; account: Record<string, unknown> | null } | { ok: false; error: string } {
  const spec = loginJobSpec("login", harness);
  if (!spec) return { ok: false, error: "판으로 로그인하지 않는 하네스입니다" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(b.files)) return { ok: false, error: "자격 파일이 없습니다" };
  const files: Array<{ path: string; content: string }> = [];
  for (const f of b.files as unknown[]) {
    const e = f && typeof f === "object" ? (f as Record<string, unknown>) : {};
    if (typeof e.path !== "string" || typeof e.content !== "string") return { ok: false, error: "자격 파일 모양이 다릅니다" };
    if (!spec.files.includes(e.path)) return { ok: false, error: `허용되지 않는 자리: ${e.path.slice(0, 80)}` };
    if (!e.content || Buffer.byteLength(e.content, "utf8") > LOGIN_JOB_TIMING.fileMax) return { ok: false, error: "자격 파일 크기가 상한 밖입니다" };
    try {
      const v = JSON.parse(e.content) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
    } catch { return { ok: false, error: "자격 파일이 JSON 객체가 아닙니다" }; }
    files.push({ path: e.path, content: e.content });
  }
  //  표의 자리가 **하나씩 빠짐없이** 와야 한다(모자람·겹침 모두 거절).
  if (files.length !== spec.files.length || spec.files.some((want) => !files.some((f) => f.path === want))) {
    return { ok: false, error: "자격 파일이 모자라거나 겹칩니다" };
  }
  let account: Record<string, unknown> | null = null;
  if (b.account !== undefined && b.account !== null) {
    if (harness !== "claude") return { ok: false, error: "계정 정보는 claude 만 받습니다" };
    if (typeof b.account !== "object" || Array.isArray(b.account)) return { ok: false, error: "계정 정보 모양이 다릅니다" };
    if (Buffer.byteLength(JSON.stringify(b.account), "utf8") > ACCOUNT_MAX) return { ok: false, error: "계정 정보가 상한 밖입니다" };
    account = b.account as Record<string, unknown>;
  }
  return { ok: true, files, account };
}

/** 판이 결과(자격)를 넘겼다 — 검사하고 적용한다. 값은 어디에도 남기지 않는다(행·응답·로그). */
export async function onLoginJobResult(id: number, bearer: string, body: unknown, inject: Partial<LoginJobDeps> = {}):
  Promise<{ ok: true }> {
  const d = await depsOf(inject);
  const j = await authJob(d, id, bearer);
  const fail = async (status: number, msg: string): Promise<never> => {
    await d.store.finishLoginJob(j.id, "failed", { error: msg });
    await stopUnit(d, j);
    logger.warn({ job: j.id, member: j.member_id, harness: j.harness, purpose: j.purpose, status }, "login-job: 결과 거절");
    throw new HttpError(status, msg);
  };
  if (j.purpose === "headless") {
    if (!isHeadlessLoginHarness(j.harness)) return fail(400, "판으로 발급하지 않는 하네스입니다");
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>).secret : undefined;
    if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw, "utf8") > LOGIN_JOB_TIMING.fileMax) {
      return fail(400, "받은 자격이 비었거나 상한 밖이에요. 다시 시도해 주세요.");
    }
    const r = await d.storeHeadless({ memberId: j.member_id, harness: j.harness, secret: raw, adminBasis: j.admin_basis });
    if (!r.ok) return fail(422, r.error);
    await d.store.finishLoginJob(j.id, "done", {});
    //  실행 멤버 판정 결과는 응답 밖에서는 안 보인다 — 조용히 빠지면 원인을 못 찾는다(종전 화면 연결과 같은 줄). 비밀은 없다.
    logger.info({ job: j.id, member: j.member_id, harness: j.harness, stored: true, runner: r.runner }, "headless: 화면 연결 저장");
    d.later(() => reapJob(d, j), REAP_DELAY_MS);
    return { ok: true };
  }
  if (!isAiLoginHarness(j.harness)) return fail(400, "판으로 로그인하지 않는 하네스입니다");
  const c = checkLoginResult(j.harness, body);
  if (!c.ok) return fail(400, c.error);
  try {
    await d.installLogin({ memberId: j.member_id, harness: j.harness, files: c.files, account: c.account });
  } catch (e) {
    //  사유는 멤버 파일 op 의 오류 문장이다(경로·코드) — 자격 값은 거기 없다.
    return fail(500, `로그인 자격을 내 홈에 두지 못했어요 — ${redactSecrets(String((e as Error)?.message ?? e)).slice(0, 160)}`);
  }
  await d.store.finishLoginJob(j.id, "done", {});
  logger.info({ job: j.id, member: j.member_id, harness: j.harness, files: c.files.map((f) => f.path) }, "login-job: 로그인 자격 설치");
  d.later(() => reapJob(d, j), REAP_DELAY_MS);
  return { ok: true };
}

/** 판이 끝을 알렸다(CLI 가 자격 없이 끝남 · 자체 상한 · 띄우기 실패). 끝난 작업이면 치우기만 한다. */
export async function onLoginJobEnd(id: number, bearer: string, body: unknown, inject: Partial<LoginJobDeps> = {}): Promise<{ ok: true }> {
  const d = await depsOf(inject);
  const j = await authJob(d, id, bearer, true);
  if (LIVE.has(j.status)) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const reason = String(b.reason ?? "");
    const exitCode = Number.isSafeInteger(b.exit_code) ? Number(b.exit_code) : null;
    //  끝 화면(판이 마지막에 본 꼬리)으로 바꾼다 — 마지막 박동 뒤에 CLI 가 찍은 오류 줄은 거기에만 있다.
    const screen = typeof b.screen === "string" && b.screen ? redactSecrets(b.screen).slice(-SCREEN_MAX) : null;
    const message = typeof b.message === "string" && b.message ? redactSecrets(b.message).slice(0, 200) : null;
    //  사유를 우리가 아는 경우만 적는다. CLI 가 스스로 끝났으면 비워 둔다 — 화면 파서가 CLI 의 오류 줄·종료코드로 말한다.
    //   단 대화형 로그인이 0 으로 끝났는데 자격이 없으면 파서는 «기다리는 중» 에 머문다 — 그 경우는 우리가 말한다.
    const error = message
      ?? (reason === "timeout" ? STALE_MESSAGE["max-age"]
        : reason === "exited" && exitCode === 0 && j.purpose === "login" ? "로그인은 끝났는데 자격 파일이 보이지 않아요. 다시 시도해 주세요."
          : null);
    await d.store.finishLoginJob(j.id, reason === "timeout" ? "expired" : "failed", { error, exitCode, screen });
    logger.info({ job: j.id, member: j.member_id, harness: j.harness, purpose: j.purpose, reason, exitCode }, "login-job: 판이 끝남");
  }
  d.later(() => reapJob(d, j), REAP_DELAY_MS);
  return { ok: true };
}

// ── 정리 감시 ───────────────────────────────────────────────────────────────────
/**
 * 이 테넌트의 열린 작업을 훑는다 — 죽은·버려진 작업을 멈추고, 끝난 작업의 판 폴더를 치운다.
 *  요청에 얹은 정비(SWEEP_JOBS)가 부른다. 판 자신의 박동도 요청이라, 사람이 떠나도 판이 도는 한 이 감시가 돈다.
 */
export async function sweepLoginJobs(inject: Partial<LoginJobDeps> = {}): Promise<{ expired: number; reaped: number }> {
  const d = await depsOf(inject);
  if (!d.sandboxAvailable()) return { expired: 0, reaped: 0 };
  let expired = 0;
  let reaped = 0;
  for (const j of await orMissing(d.store.openLoginJobs(), [])) {
    if (LIVE.has(j.status)) {
      const why = staleReason(j, d.now());
      if (why) { await expire(d, j, why); expired++; }
      continue;
    }
    //  (끝난 행은 안 치운 것만 온다 — openLoginJobs.) 막 끝난 작업은 판이 스스로 나갈 틈을 준다(그 틈은 결과 경로의 지연 치우기가 먼저 쓴다).
    if (d.now() - (ms(j.finished_at) ?? ms(j.updated_at) ?? 0) < REAP_DELAY_MS) continue;
    if (await reapJob(d, j)) reaped++;
  }
  return { expired, reaped };
}

// ── 결과 적용: 멤버 홈에 로그인 자격 ─────────────────────────────────────────────
/**
 * 멤버 파일 op 안에서 도는 고정 스크립트 — 값은 전부 stdin JSON 으로 온다.
 *  · 자격 파일: 폴더 0700 · 임시 파일 0600 → rename(링크를 따라가지 않고 **자리를 바꾼다**).
 *  · 홈이나 자격 폴더가 링크면 거절한다 — 같은 uid 로 도는 다른 자리로 쓰기가 새지 않게.
 *  · 홈이 **아직 없으면** 0700 으로 만든다(부모가 있을 때만 — 경로를 지어내지 않는다). 매니지드의 멤버 홈은 세션 브로커가
 *    첫 세션을 띄울 때 만드는데(lvly-cloud sessionbroker.ensureMemberHome), 새 워크스페이스는 **세션보다 로그인이 먼저**다.
 *    파일 op 는 테넌트 uid 로 돌고 `homes` 가 테넌트 소유라, 여기서 만든 홈은 브로커가 만드는 것과 같은 모양(테넌트 uid·0700)이다.
 *  · claude 는 `.claude.json` 의 oauthAccount 만 바꾼다(격리 멤버는 CLAUDE_CONFIG_DIR 없이 홈의 `.claude.json` 을 쓴다).
 *    그 파일이 링크거나 JSON 객체가 아니면 건드리지 않는다 — 사람의 설정을 망가뜨리느니 계정 표시가 늦는 편이 낫다.
 */
export const INSTALL_LOGIN_JS = [
  `const fs=require("fs"),path=require("path");`,
  `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{`,
  `const i=JSON.parse(s);const home=i.home;`,
  `const noLink=(p)=>{const st=fs.lstatSync(p);if(st.isSymbolicLink())throw new Error("링크 자리라 쓰지 않습니다: "+path.relative(home,p));return st;};`,
  `let hs=null;try{hs=noLink(home);}catch(e){if(!(e&&e.code==="ENOENT"))throw e;}`,
  `if(!hs){noLink(path.dirname(home));fs.mkdirSync(home,{mode:0o700});fs.chmodSync(home,0o700);}else if(!hs.isDirectory())throw new Error("홈이 폴더가 아닙니다");`,
  `for(const f of i.files){`,
  `const abs=path.join(home,f.path);if(!abs.startsWith(home+"/"))throw new Error("홈 밖 자리");`,
  `const dir=path.dirname(abs);`,
  `let st=null;try{st=noLink(dir);}catch(e){if(!(e&&e.code==="ENOENT"))throw e;}`,
  `if(!st)fs.mkdirSync(dir,{mode:0o700});else if(!st.isDirectory())throw new Error("폴더가 아닙니다: "+path.relative(home,dir));`,
  `const tmp=abs+".lvly-"+process.pid;fs.writeFileSync(tmp,f.content,{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,abs);}`,
  `let merged=false;`,
  `if(i.account){const cj=path.join(home,".claude.json");let o={},mode=0o600,ok=true;`,
  `try{const st=fs.lstatSync(cj);if(st.isSymbolicLink()||!st.isFile())ok=false;else{mode=st.mode&0o777;o=JSON.parse(fs.readFileSync(cj,"utf8"));if(!o||typeof o!=="object"||Array.isArray(o))ok=false;}}catch(e){if(!(e&&e.code==="ENOENT"))ok=false;}`,
  `if(ok){o.oauthAccount=i.account;const tmp=cj+".lvly-"+process.pid;fs.writeFileSync(tmp,JSON.stringify(o,null,2),{mode});fs.chmodSync(tmp,mode);fs.renameSync(tmp,cj);merged=true;}}`,
  `process.stdout.write(JSON.stringify({ok:true,merged}));});`,
].join("");

async function installLoginCredential(o: {
  memberId: string; harness: AiLoginHarness; files: Array<{ path: string; content: string }>; account: Record<string, unknown> | null;
}): Promise<void> {
  const { resolveMemberOsUser, memberSlug } = await import("./terminal-isolation.js");
  const { memberNodeJson } = await import("./terminal-member-fs.js");
  const { MEMBER_HOME_BASE } = await import("./terminal-transcript.js");
  //  종전 로그인 자리와 같은 규칙(profiles.userSlug = memberSlug(userId)) — 로그인 확인(aiAccountStatus)이 보는 그 홈이다.
  const osUser = await resolveMemberOsUser(memberSlug(o.memberId));
  if (!osUser) throw new Error("멤버 홈을 찾지 못했습니다");
  const r = await memberNodeJson<{ ok?: boolean; merged?: boolean }>(osUser, INSTALL_LOGIN_JS, {
    home: `${MEMBER_HOME_BASE}/${osUser}`, files: o.files, account: o.account,
  });
  if (!r?.ok) throw new Error("멤버 홈 쓰기가 끝나지 않았습니다");
  if (o.account && !r.merged) logger.warn({ member: o.memberId }, "login-job: .claude.json 에 계정 정보를 합치지 않음(링크·형식)");
}

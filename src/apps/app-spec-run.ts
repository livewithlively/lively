// 앱 「개발 정보」 설명을 쓰는 자리(#4632) — 새 판이 저장되면(app-version-files.insertVersion 한 자리 · 어느 세션이 저장했든) 조용한
//  SPEC_QUIET_MS 뒤 그 앱의 최신 판 설명을 다시 쓴다. 연달아 저장하면 마지막 저장 뒤 한 번만(고치기 왕복마다 돈이 나가지 않게).
//  보는 판의 설명이 없으면 「개발 정보」 를 열 때도 쓴다(capabilities/apps.ts app_spec — 되돌리기 · 옛 판 · 예약을 놓친 게이트웨이).
//  실행 계정은 워크스페이스 API 키 하나(단발 · ai-runs/anthropic.singleShot) — 사람의 구독 · 앱의 AI 하루 상한을 쓰지 않는다. 키가 없으면 쓰지 않는다.
import { logger } from "../log.js";
import { SPEC_SYSTEM, parseSpecOutput, specFacts, specInput, specKeyOf, specPrompt, type SpecFacts, type SpecFile } from "./app-spec.js";

export const SPEC_QUIET_MS = 30_000;
export const SPEC_MODEL_DEFAULT = "claude-sonnet-5-5";
//  돈 상한(격리 리뷰 #4632) — 저장마다 한 번씩 사면 고치기 왕복 · 스크립트가 앱 백 개를 건드리는 일에 끝이 없다.
//   · 한 앱의 저절로 다시 쓰기는 SPEC_MIN_GAP_MS 에 한 번(그 사이 저장은 그 뒤 한 번으로 모인다)
//   · 이 게이트웨이에서 동시에 SPEC_CONCURRENT 개까지(넘으면 저절로 쓰기는 잠시 뒤로 · 열어서 쓰기는 다음 물음에)
//   · 워크스페이스 하루 SPEC_DAILY_MAX 번(LIVELY_APP_SPEC_DAILY_MAX) — 넘으면 화면이 «오늘 몫을 다 썼어요» 라고 말한다
export const SPEC_MIN_GAP_MS = 3 * 60_000;
export const SPEC_CONCURRENT = 3;
export const specDailyMax = (): number => { const n = Number(process.env.LIVELY_APP_SPEC_DAILY_MAX); return Number.isInteger(n) && n >= 0 ? n : 200; };
const SPEC_TIMEOUT_MS = 4 * 60_000;
const SPEC_MAX_TOKENS = 16_000;

/**
 * 앱마다 «마지막 저장 뒤 quietMs» 에 한 번 부르는 예약기. 테넌트(워크스페이스)마다 따로 센다 — 열쇠 = 테넌트 + 앱.
 *  시험이 시계를 바꿔 끼운다.
 */
export function makeSpecScheduler(d: {
  /** 돌린 뒤 숫자를 돌려주면 그만큼 뒤에 다시 돈다(앱의 최소 간격 · 동시 상한) — 그 사이 새 저장이 오면 그 예약으로 모인다. */
  quietMs: number; run: (appId: string) => Promise<number | void | unknown>;
  tenantKey: () => string; wrap: (fn: () => Promise<unknown>) => () => Promise<unknown>;
  setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void;
}): { schedule(appId: string): void; pending(): number } {
  const timers = new Map<string, unknown>();
  const arm = (k: string, appId: string, go: () => Promise<unknown>, ms: number): void => {
    const prev = timers.get(k);
    if (prev !== undefined) d.clearTimer(prev);
    timers.set(k, d.setTimer(() => {
      timers.delete(k);
      void Promise.resolve().then(go)
        .then((again) => { if (typeof again === "number" && again > 0 && !timers.has(k)) arm(k, appId, go, again); })
        .catch((e) => logger.warn({ app: appId, err: (e as Error)?.message ?? String(e) }, "[app-spec] 설명 쓰기 실패"));
    }, ms));
  };
  return {
    schedule(appId: string): void { arm(d.tenantKey() + "\u0000" + appId, appId, d.wrap(() => d.run(appId)), d.quietMs); },
    pending: () => timers.size,
  };
}

let live: ReturnType<typeof makeSpecScheduler> | null = null;
async function liveScheduler(): Promise<ReturnType<typeof makeSpecScheduler>> {
  if (live) return live;
  const { currentTenant, withTenant } = await import("../org/tenant-context.js");
  live = makeSpecScheduler({
    quietMs: SPEC_QUIET_MS,
    run: async (appId) => { const r = await writeAppSpec(appId, null, { force: false }); return typeof r === "object" ? r.later : undefined; },
    tenantKey: () => currentTenant()?.id ?? "",
    //  예약한 요청의 워크스페이스로 돈다 — 타이머 안에서는 요청 컨텍스트가 없다(org/tenant-context 머리말).
    wrap: (fn) => { const t = currentTenant(); return () => (t ? withTenant(t, fn) : fn()); },
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
  });
  return live;
}

/** 새 판이 저장됐다 — 그 앱의 설명을 잠시 뒤 다시 쓰게 예약한다. 던지지 않는다(저장을 막지 않는다). */
export function scheduleAppSpec(appId: string): void {
  void liveScheduler().then((s) => s.schedule(appId)).catch((e) => logger.warn({ app: appId, err: (e as Error)?.message }, "[app-spec] 예약 실패"));
}

/**
 * 코드에서 바로 읽은 사실의 작은 캐시 — 열쇠 = 워크스페이스 + 앱 + 판의 코드 지문(같은 지문이면 같은 코드다). 최근 64개.
 *  「개발 정보」 화면이 설명을 기다리며 6초마다 다시 물어도 판의 파일을 다시 꺼내지 않게.
 */
const FACTS_MAX = 64;
const facts = new Map<string, SpecFacts>();
export async function factsCache(appId: string, key: string, make: () => Promise<SpecFacts>): Promise<SpecFacts> {
  const { currentTenant } = await import("../org/tenant-context.js");
  const k = (currentTenant()?.id ?? "") + "\u0000" + appId + "\u0000" + key;
  const hit = facts.get(k);
  if (hit) { facts.delete(k); facts.set(k, hit); return hit; }
  const v = await make();
  facts.set(k, v);
  while (facts.size > FACTS_MAX) facts.delete(facts.keys().next().value as string);
  return v;
}

/** 오늘 몫이 남았나(워크스페이스 하루 상한). */
export async function specBudgetOk(): Promise<boolean> {
  return (await (await import("./app-spec-store.js")).specsStartedToday()) < specDailyMax();
}
let inflight = 0;

/** 설명을 쓸 수 있나 — 워크스페이스 API 키가 있나. */
export async function specAvailable(): Promise<boolean> {
  const { workspaceApiKey } = await import("../ai-runs/live.js");
  return !!(await workspaceApiKey().catch(() => null));
}

export interface SpecTarget { versionNo: number | null; contentHash: string | null; manifest: unknown; files: SpecFile[] }

/**
 * 설명 하나를 쓴다. target 이 없으면 그 앱의 최신 판. 결과:
 *  'done' 썼다 · 'busy' 이미 있거나 누가 쓰는 중(또는 동시 상한 — 열어서 쓰기는 다음 물음에 다시) · 'unavailable' 키 없음 · 'limit' 오늘 몫을 다 씀 ·
 *  'gone' 앱이나 판이 없다 · 'failed' 못 썼다(행에 까닭) · {later} 저절로 쓰기를 그만큼 뒤로(앱의 최소 간격 · 동시 상한).
 */
export async function writeAppSpec(appId: string, target: SpecTarget | null, opts: { force: boolean }): Promise<"done" | "busy" | "unavailable" | "gone" | "failed" | "limit" | { later: number }> {
  const store = await import("../org/store/apps.js");
  const specStore = await import("./app-spec-store.js");
  const { workspaceApiKey, workspaceAnthropicWorkspaceId } = await import("../ai-runs/live.js");
  const app = await store.getApp(appId);
  if (!app) return "gone";
  let t = target;
  if (!t) {
    const latest = (await store.listAppVersions(appId))[0];
    if (!latest) return "gone";
    const row = await store.getAppVersion(appId, latest.version_no);
    if (!row) return "gone";
    const { versionFiles } = await import("./app-version-files.js");
    t = { versionNo: row.version_no, contentHash: row.content_hash, manifest: row.manifest, files: await versionFiles(row) };
  }
  const apiKey = await workspaceApiKey().catch(() => null);
  if (!apiKey) return "unavailable";
  if (!(await specBudgetOk())) return "limit";
  const scheduled = target === null;
  if (scheduled) {
    const last = await specStore.lastSpecStart(appId);
    const wait = last == null ? 0 : last + SPEC_MIN_GAP_MS - Date.now();
    if (wait > 0) return { later: wait + 1000 };
  }
  if (inflight >= SPEC_CONCURRENT) return scheduled ? { later: SPEC_QUIET_MS } : "busy";
  const key = specKeyOf(t.contentHash, t.versionNo);
  const claim = await specStore.claimAppSpec(appId, key, t.versionNo, opts.force);
  if (!claim) return "busy";
  inflight++;
  const model = (process.env.LIVELY_APP_SPEC_MODEL || "").trim() || SPEC_MODEL_DEFAULT;
  try {
    const facts = specFacts(t.manifest, t.files);
    const input = specInput(t.files);
    const prev = await specStore.prevOkSpec(appId, t.versionNo);
    const prompt = specPrompt({ title: app.title || appId, appId, versionNo: t.versionNo, facts, input, prev });
    const { singleShot } = await import("../ai-runs/anthropic.js");
    const workspaceId = await workspaceAnthropicWorkspaceId().catch(() => null);
    const ask = (messages?: Array<{ role: "user" | "assistant"; content: string }>) =>
      singleShot(apiKey, { model, system: SPEC_SYSTEM, prompt, maxTokens: SPEC_MAX_TOKENS, workspaceId, messages }, AbortSignal.timeout(SPEC_TIMEOUT_MS));
    let out = await ask();
    let used = { i: out.usage.input_tokens, o: out.usage.output_tokens };
    let doc = out.ok ? parseSpecOutput(out.text) : null;
    //  꼴이 틀리면 한 번만 «꼴대로 다시»(ai-runs 의 형식 재시도와 같은 생각).
    if (out.ok && !doc && out.stopReason !== "max_tokens") {
      out = await ask([{ role: "user", content: prompt }, { role: "assistant", content: out.text }, { role: "user", content: "답이 정해진 JSON 꼴이 아니었어. 앞뒤 말 없이 그 꼴의 JSON 하나만 다시 내 줘." }]);
      used = { i: used.i + out.usage.input_tokens, o: used.o + out.usage.output_tokens };
      doc = out.ok ? parseSpecOutput(out.text) : null;
    }
    if (!doc) {
      const why = !out.ok ? "AI 호출이 실패했어요(" + (out.error || "HTTP " + out.status) + ")" : out.stopReason === "max_tokens" ? "설명이 너무 길어 끝맺지 못했어요" : "AI 답을 읽지 못했어요";
      await specStore.finishAppSpec(appId, key, claim, { ok: false, error: why, model: out.model ?? model });
      logger.warn({ app: appId, key, why }, "[app-spec] 설명을 쓰지 못했다");
      return "failed";
    }
    await specStore.finishAppSpec(appId, key, claim, { ok: true, spec: doc, model: out.model ?? model, inputTokens: used.i, outputTokens: used.o });
    logger.info({ app: appId, version: t.versionNo, input_tokens: used.i, output_tokens: used.o }, "[app-spec] 설명을 썼다");
    return "done";
  } catch (e) {
    const msg = (e as Error)?.name === "TimeoutError" ? "시간 안에 끝나지 않았어요" : "설명을 쓰다 멈췄어요(" + ((e as Error)?.message ?? String(e)).slice(0, 200) + ")";
    await specStore.finishAppSpec(appId, key, claim, { ok: false, error: msg, model }).catch(() => {});
    return "failed";
  } finally {
    inflight--;
  }
}

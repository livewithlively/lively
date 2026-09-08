// tmux 그림자 대조 — «옛 경로가 답하고, 코어 경로는 견주기만» (#2600 T2 (d) d3).
//
// ── 무엇을 하나 ───────────────────────────────────────────────────────────────
// `LIVELY_TMUX_ROUTE=shadow` 에서 `tmux()` 는 종전대로 중계(`tmux-relay.cjs` → 브로커 `/lvly/tmux`)의 답을 **바이트 그대로** 돌려준다.
//  그와 동시에(떼어 놓고 — 옛 경로의 지연에 한 ms 도 얹지 않는다) 코어 경로(`GET /lvly/sessions` → `planTmux` → exec 팬아웃 → 병합)를
//  계산해 두 답을 견주고, **다르면 로그만** 남긴다. 성능 기준선(T2 (e))이 없어도 정확성을 게이트하는 자리다(설계 §6).
//
// ── 두 가지 견줌 ──────────────────────────────────────────────────────────────
//  · 읽기 동사(list-*·has-session·show-options·`-p` 붙은 display-message/capture-pane)는 코어 경로를 **실제로 실행**해 병합 산출
//    (code·stdout·stderr·gone)을 견준다.
//  · 쓰기 동사(set-option·kill-session·send-keys·new-session…)는 **계획만** 세워(`planTmux`) «어느 컨테이너로 갔나/갈 곳이 없었나»
//    를 옛 답의 모양(성공/브로커 gone 문구)과 견준다 — 두 번 실행하면 `send-keys` 가 두 번 들어간다(멱등이 아니다).
//
// ── 설명되는 불일치(explained) — 미리 아는 차이 ──────────────────────────────
//  order        브로커 팬아웃은 색인 삽입순(`[...sessionTmux.values()]`), 코어는 sid 순 — 줄 집합이 같고 순서만 다르다.
//  unobserved   목록을 못 본 틱(observed:false·아는 세션 0)에 브로커는 `no server running`, 코어는 «못 봤다»(tmux-route 머리말 — 의도된 차이).
//  old-transport 중계가 답을 못 냈다(`lvly tmux-relay:` · 예산 초과 · spawn 실패). 옛 경로 자신의 장애라 코어 답과 견줄 수 없다.
//  new-transport 코어 경로가 브로커에 못 닿았거나 목록을 못 봤다 — 503 재시도 사다리가 없는 것(d2 §6-1)이 여기 빈도로 드러난다.
//  text         같은 부류(둘 다 gone 등)인데 문구만 다르다.
//  그 밖은 전부 **mismatch** — 설명되지 않는 불일치가 실사용 N시간에 0 이어야 d3 을 넘긴다(설계 §7 중단 기준).
//
// ── 규율 ───────────────────────────────────────────────────────────────────────
//  ⚠ 이 모듈은 절대 `tmux()` 를 실패시키지 않는다 — 판정·리포터의 예외까지 삼킨다. ⚠ 로그에 argv 전문을 싣지 않는다(send-keys 본문·라벨).
//  ⚠ 전송(소켓 경로·허브 비밀)을 로그에 싣지 않는다(d2 §6-4). ⚠ 동시 진행 상한·표본 비율로 브로커 부하를 묶는다(설계 §8).
import type { TmuxOutcome, TmuxPlan, SessionRow } from "./tmux-route.js";
import { planTmux, runPlan, tmuxSessionOf, TMUX_UNOBSERVED } from "./tmux-route.js";
import { logger } from "../log.js";

/** 코어 경로의 두 입구 — tmux-exec 이 broker-client 로 채운다(이 모듈은 전송을 모른다 · 시험은 가짜를 넣는다). */
export interface ShadowEngine {
  /** `GET /lvly/sessions`. 실패는 throw(목록을 못 본 것을 빈 목록으로 접지 않는다). */
  list(): Promise<{ observed: boolean; sessions: SessionRow[] }>;
  /** 컨테이너 안 실행 — 절대 throw 하지 않는다(broker-client 규율). */
  exec(container: string, argv: string[]): Promise<TmuxOutcome>;
}

/** 실행해도 되는(읽기) 동사 — 그 밖은 계획만 견준다. */
export const SHADOW_READ_VERBS: ReadonlySet<string> = new Set([
  "list-sessions", "ls", "list-panes", "lsp", "list-windows", "lsw", "list-clients", "lsc",
  "has-session", "has", "show-options", "show", "show-window-options", "showw", "show-environment", "showenv",
  "display-message", "display", "capture-pane", "capturep",
]);
/** `-p` 가 있어야 읽기다 — 없으면 클라이언트 상태줄에 띄우거나(display-message) 붙여넣기 버퍼에 쓴다(capture-pane). */
const READ_ONLY_WITH_P: ReadonlySet<string> = new Set(["display-message", "display", "capture-pane", "capturep"]);

/** (순수) 이 호출을 그림자에서 **실행**해도 되나 — 읽기 동사만. 아니면 계획 대조. */
export function shadowExecutable(args: readonly string[]): boolean {
  const { verb } = tmuxSessionOf(args);
  if (verb === null || !SHADOW_READ_VERBS.has(verb)) return false;
  if (READ_ONLY_WITH_P.has(verb) && !args.includes("-p")) return false;
  return true;
}

/** 옛 경로의 답 — execFile 결과/오류를 접은 것. `spawnFailed` = 중계가 답을 못 냈다(타임아웃·ENOENT·시그널: 종료코드가 숫자가 아니다). */
export interface OldOutcome extends TmuxOutcome { spawnFailed?: boolean }

/** (순수) execFile 의 거절을 OldOutcome 으로. 종료코드가 숫자면 중계가 답한 것(그 stdout·stderr 그대로), 아니면 spawn/타임아웃 실패. */
export function foldOldError(e: unknown): OldOutcome {
  const err = (e && typeof e === "object" ? e : {}) as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
  const numeric = typeof err.code === "number";
  const stderr = typeof err.stderr === "string" ? err.stderr : "";
  return {
    code: numeric ? (err.code as number) : 1,
    stdout: typeof err.stdout === "string" ? err.stdout : "",
    stderr: numeric ? stderr : `(중계 실패) ${typeof err.message === "string" ? err.message : String(e)}${stderr ? `\n${stderr}` : ""}`,
    ...(numeric ? {} : { spawnFailed: true }),
  };
}

/** 답의 부류 — 두 답을 «같은 뜻인가» 로 견주기 위한 축. */
export type OutcomeClass = "ok" | "gone" | "noserver" | "unobserved" | "fanoutfail" | "transport" | "other";

const GONE_RE = /can't find session: \S+ \(session container .* is gone\)/;          // 브로커·코어가 합성하는 확답(tmux 자신의 can't find 와 다르다)
const NO_SERVER_RE = /^no server running/m;
const FANOUT_FAIL_RE = /세션 컨테이너 tmux 조회 실패/;                                  // 양쪽 병합이 같은 문구로 낸다(«통째로 못 봤다»)
const OLD_TRANSPORT_RE = /^lvly tmux-relay: /m;                                       // 중계의 die() — 브로커에 못 닿음·예산 초과·파싱 실패
const NEW_TRANSPORT_RE = /\(못 봤다\)|^broker exec-(?:create|start|inspect) 실패/m;    // 코어 경로의 fold·broker-client 실패 문구

/** (순수) 답의 부류. `side` 가 갈리는 이유: 전송 실패 문구가 옛 경로(중계)와 코어 경로(broker-client)에서 다르다. */
export function classifyOutcome(o: TmuxOutcome & { spawnFailed?: boolean }, side: "old" | "new"): OutcomeClass {
  if (o.code === 0) return "ok";
  if (side === "old" && (o.spawnFailed || OLD_TRANSPORT_RE.test(o.stderr))) return "transport";
  if (FANOUT_FAIL_RE.test(o.stderr)) return "fanoutfail";
  if (side === "new" && o.stderr === TMUX_UNOBSERVED.stderr) return "unobserved";
  if (side === "new" && NEW_TRANSPORT_RE.test(o.stderr)) return "transport";
  if (GONE_RE.test(o.stderr)) return "gone";
  if (NO_SERVER_RE.test(o.stderr)) return "noserver";
  return "other";
}

export type ExplainedWhy = "order" | "unobserved" | "old-transport" | "new-transport" | "text";
export type MismatchWhy = "stdout" | "code" | "class" | "plan" | "unobserved-vs-ok" | "internal";
export type ShadowVerdict =
  | { kind: "match" }
  | { kind: "explained"; why: ExplainedWhy }
  | { kind: "mismatch"; why: MismatchWhy; detail: string }
  | { kind: "skipped"; why: "inflight" | "sample" };

const head = (s: string, n = 80): string => JSON.stringify(s.trim().split("\n")[0]?.slice(0, n) ?? "");
const lines = (s: string): string[] => s.split("\n").filter(Boolean);

/** (순수) 실행한 두 답을 견준다 — 읽기 동사. */
export function compareExecuted(old: OldOutcome, neu: TmuxOutcome): ShadowVerdict {
  const oc = classifyOutcome(old, "old"), nc = classifyOutcome(neu, "new");
  if (oc === "transport") return { kind: "explained", why: "old-transport" };
  if (oc === "ok" && nc === "ok") {
    if (old.stdout === neu.stdout) return { kind: "match" };
    const a = lines(old.stdout), b = lines(neu.stdout);
    if (a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")) return { kind: "explained", why: "order" };
    const first = a.find((l, i) => l !== b[i]) ?? b.find((l, i) => l !== a[i]) ?? "";
    return { kind: "mismatch", why: "stdout", detail: `old ${a.length}줄 · new ${b.length}줄 · 첫 다른 줄 ${head(first)}` };
  }
  if (nc === "transport") return { kind: "explained", why: "new-transport" };
  if (oc === "ok") {
    if (nc === "unobserved") return { kind: "mismatch", why: "unobserved-vs-ok", detail: `old ok ${lines(old.stdout).length}줄 · new «못 봤다»` };
    return { kind: "mismatch", why: "code", detail: `old ok ${lines(old.stdout).length}줄 · new ${nc}(${neu.code}) ${head(neu.stderr)}` };
  }
  if (nc === "ok") return { kind: "mismatch", why: "code", detail: `old ${oc}(${old.code}) ${head(old.stderr)} · new ok ${lines(neu.stdout).length}줄` };
  if (oc === "noserver" && nc === "unobserved") return { kind: "explained", why: "unobserved" };
  if (oc === nc) return old.stderr.trim() === neu.stderr.trim() ? { kind: "match" } : { kind: "explained", why: "text" };
  return { kind: "mismatch", why: "class", detail: `old ${oc}(${old.code}) ${head(old.stderr)} · new ${nc}(${neu.code}) ${head(neu.stderr)}` };
}

/** (순수) 옛 답의 모양과 코어의 계획을 견준다 — 쓰기 동사(실행하지 않는다). */
export function comparePlanned(old: OldOutcome, plan: TmuxPlan): ShadowVerdict {
  const oc = classifyOutcome(old, "old");
  if (oc === "transport") return { kind: "explained", why: "old-transport" };
  if (plan.kind === "unobserved") return { kind: "explained", why: "unobserved" };
  const reachedOld = oc !== "gone";                               // 성공이든 tmux 자신의 오류든 — 브로커가 컨테이너에 **닿았다**
  const reachedNew = plan.kind === "one" || plan.kind === "fanout";
  if (reachedOld && reachedNew) return { kind: "match" };
  if (!reachedOld && plan.kind === "gone") {
    const c = plan.container ?? "(없음)";
    if (old.stderr.includes(`(session container ${c} is gone)`)) return { kind: "match" };
    return { kind: "mismatch", why: "plan", detail: `둘 다 gone 인데 컨테이너가 다르다 — old ${head(old.stderr)} · new ${c}` };
  }
  if (reachedOld) {
    //  여기서 plan 은 gone 뿐이다(unobserved 는 위에서, one·fanout 은 reachedNew).
    const g = plan as Extract<TmuxPlan, { kind: "gone" }>;
    return { kind: "mismatch", why: "plan", detail: `old ${oc}(${old.code}) 은 컨테이너에 닿았는데 new 계획은 gone(${g.sid ?? "?"} → ${g.container ?? "(없음)"})` };
  }
  const where = plan.kind === "one" ? plan.container : plan.kind === "fanout" ? `${plan.containers.length}개` : "?";
  return { kind: "mismatch", why: "plan", detail: `old 는 gone ${head(old.stderr)} 인데 new 계획은 ${plan.kind}(${where})` };
}

/** 동시에 진행하는 그림자 상한 — 넘으면 이 호출은 건너뛴다(브로커를 두 배 넘게 두드리지 않는다 · d2 §6-2). */
export const SHADOW_MAX_INFLIGHT = 4;
/** 요약 로그 주기(견준 건수) — 무소식이 «안 돌았다» 와 구별되게, 누적 카운터를 이 주기로 남긴다. */
export const SHADOW_SUMMARY_EVERY = 100;

/** (순수) 이 호출을 견줄 것인가 — 표본 비율·동시 상한. */
export function shadowGate(sample: number, inflight: number, rand: () => number = Math.random): ShadowVerdict | null {
  if (inflight >= SHADOW_MAX_INFLIGHT) return { kind: "skipped", why: "inflight" };
  if (sample < 1 && rand() >= sample) return { kind: "skipped", why: "sample" };
  return null;
}

export interface ShadowStats {
  startedAt: number;
  compared: number;      // 실제로 견준 건수(skipped 제외)
  match: number;
  explained: Record<string, number>;
  mismatch: Record<string, number>;
  skipped: Record<string, number>;
}
const fresh = (): ShadowStats => ({ startedAt: Date.now(), compared: 0, match: 0, explained: {}, mismatch: {}, skipped: {} });
let stats: ShadowStats = fresh();
let inflight = 0;
export function shadowStats(): ShadowStats { return { ...stats, explained: { ...stats.explained }, mismatch: { ...stats.mismatch }, skipped: { ...stats.skipped } }; }
export function resetShadowStats(): void { stats = fresh(); }
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

export interface ShadowReport {
  verdict: ShadowVerdict;
  verb: string | null;
  slug: string;
  executed: boolean;
  ms: number;
  stats: ShadowStats;
}
/** 시험·운영이 갈아끼우는 보고 출구. 기본은 로그 — mismatch 는 warn 즉시 · 요약은 SHADOW_SUMMARY_EVERY 마다 info · 첫 건은 «가동» info. */
let reporter: (r: ShadowReport) => void = defaultReporter;
export function installShadowReporter(fn: ((r: ShadowReport) => void) | null): void { reporter = fn ?? defaultReporter; }
function defaultReporter(r: ShadowReport): void {
  const base = { verb: r.verb, slug: r.slug, executed: r.executed, ms: r.ms };
  if (r.verdict.kind === "mismatch") logger.warn({ tmuxShadow: { ...base, why: r.verdict.why, detail: r.verdict.detail } }, "tmux 그림자 대조 불일치");
  else if (r.verdict.kind === "explained") logger.debug({ tmuxShadow: { ...base, why: r.verdict.why } }, "tmux 그림자 대조 — 설명되는 차이");
  if (r.stats.compared === 1) logger.info({ tmuxShadow: base }, "tmux 그림자 대조 가동 — 옛 경로가 답하고 코어 경로는 견주기만 한다");
  if (r.stats.compared > 0 && r.stats.compared % SHADOW_SUMMARY_EVERY === 0 && r.verdict.kind !== "skipped") {
    logger.info({ tmuxShadow: formatShadowSummary(r.stats) }, "tmux 그림자 대조 요약");
  }
}
/** (순수) 요약 한 덩이 — 로그·되읽기용. */
export function formatShadowSummary(s: ShadowStats): { sinceMin: number; compared: number; match: number; explained: Record<string, number>; mismatch: Record<string, number>; mismatchTotal: number; skipped: Record<string, number> } {
  const mismatchTotal = Object.values(s.mismatch).reduce((a, b) => a + b, 0);
  return { sinceMin: Math.round((Date.now() - s.startedAt) / 60_000), compared: s.compared, match: s.match, explained: { ...s.explained }, mismatch: { ...s.mismatch }, mismatchTotal, skipped: { ...s.skipped } };
}

/** 코어 경로 한 번 — 실행(읽기)이면 병합 산출, 계획만(쓰기)이면 plan. 절대 throw 하지 않는다(실패는 fold 문구로 TmuxOutcome). */
async function coreSide(engine: ShadowEngine, slug: string, args: readonly string[], execute: boolean): Promise<{ outcome: TmuxOutcome } | { plan: TmuxPlan } | { failed: TmuxOutcome }> {
  let listed: { observed: boolean; sessions: SessionRow[] };
  try { listed = await engine.list(); }
  catch (e) { return { failed: { code: 1, stdout: "", stderr: `브로커 세션 목록 조회 실패(못 봤다): ${(e as Error)?.message ?? String(e)}` } }; }
  const plan = planTmux(slug, args, listed.sessions, listed.observed);
  if (!execute) return { plan };
  try { return { outcome: await runPlan(plan, slug, args, listed.observed, (c, argv) => engine.exec(c, argv)) }; }
  catch (e) { return { failed: { code: 1, stdout: "", stderr: `코어 직접 경로 실행 오류(못 봤다): ${(e as Error)?.message ?? String(e)}` } }; }
}

/**
 * 그림자 한 건 — 옛 경로의 약속(`old`)과 코어 경로를 나란히 기다려 견주고 보고한다. **절대 거절하지 않는다.**
 *  `engine` 을 만드는 것(broker-client)은 호출자 몫 — 만들다 던지면(https 허브 등) `mismatch:internal` 로 드러낸다(조용히 묻지 않는다).
 */
export async function shadowTmux(
  args: readonly string[], slug: string, sample: number,
  old: Promise<{ stdout: string }>,
  makeEngine: () => ShadowEngine,
): Promise<ShadowVerdict> {
  const t0 = Date.now();
  const verb = tmuxSessionOf(args).verb;
  const executed = shadowExecutable(args);
  let verdict: ShadowVerdict;
  const gate = shadowGate(sample, inflight);
  if (gate) {
    verdict = gate;
  } else {
    inflight++;
    try {
      const oldP: Promise<OldOutcome> = old.then((r) => ({ code: 0, stdout: r.stdout, stderr: "" }), (e) => foldOldError(e));
      let engine: ShadowEngine | null = null, engineErr = "";
      try { engine = makeEngine(); } catch (e) { engineErr = (e as Error)?.message ?? String(e); }
      const [o, n] = await Promise.all([oldP, engine ? coreSide(engine, slug, args, executed) : Promise.resolve(null)]);
      if (!n) verdict = { kind: "mismatch", why: "internal", detail: `코어 경로 설정 오류: ${engineErr}` };
      else if ("failed" in n) verdict = executed ? compareExecuted(o, n.failed) : (classifyOutcome(o, "old") === "transport" ? { kind: "explained", why: "old-transport" } : { kind: "explained", why: "new-transport" });
      else if ("plan" in n) verdict = comparePlanned(o, n.plan);
      else verdict = compareExecuted(o, n.outcome);
    } catch (e) {
      verdict = { kind: "mismatch", why: "internal", detail: `그림자 내부 오류: ${(e as Error)?.message ?? String(e)}` };
    } finally { inflight--; }
  }
  if (verdict.kind === "skipped") bump(stats.skipped, verdict.why);
  else {
    stats.compared++;
    if (verdict.kind === "match") stats.match++;
    else if (verdict.kind === "explained") bump(stats.explained, verdict.why);
    else bump(stats.mismatch, verdict.why);
  }
  try { reporter({ verdict, verb, slug, executed, ms: Date.now() - t0, stats: shadowStats() }); } catch { /* 보고가 tmux() 를 못 건드린다 */ }
  return verdict;
}

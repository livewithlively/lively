// 수집 실행(#4213 T11) — 담당자의 세션 컨테이너에서 `claude -p` 한 판을 띄우고, 끝나면 그 세션을 지운다.
//  파일·셸·해석은 collect-run-script.ts(순수)가 만들고, 여기는 그것을 **어디서 언제** 돌릴지만 정한다.
//
//  ── 흐름 ──
//  ① 멤버 경계(그 사람 uid · 그 사람 홈)에서 실행 폴더에 일감·러너·훅 넷을 쓴다(ai-login-run 의 실행 통로와 같다).
//  ② kind "collect" 세션을 연다 — 판이 러너 하나다. 매니지드면 그 사람 홈이 붙은 **새 세션 컨테이너**(작은 크기)다.
//     그 사람이 띄워 둔 대화 세션 안에서는 돌리지 않는다(메모리 상한을 나눠 써 대화 세션이 죽을 수 있다 — 확정판 §5).
//  ③ 러너가 끝나면 판이 닫히고 브로커가 컨테이너를 거둔다(#4696). 게이트웨이는 폴더를 읽어 끝난 것을 보고
//     세션 행·훅 토큰을 지운다(killSession — 멱등). 시간이 넘도록 끝나지 않으면 «잃음» 으로 적고 같은 정리를 한다.
//  ④ 게이트웨이가 재기동하면 지켜보던 타이머는 사라진다. 그래도 실행은 계속되고, 상태 읽기가 같은 정리를 대신한다.
//  ⑤ 판마다 시작·끝을 collect_run 표에 적는다(org/collect/run-log.ts) — 결과(성공·실패 사유)·최고 메모리·시간·비용.
//     [수집 · 증류 ▸ 수집기 설정 ▸ Claude 커넥터 수집] 의 실패율·메모리 지표가 여기서 나오고, 수집 세션 크기는 그 옆에서 고친다.
//
//  ⚠ 이번 판(B)은 **실행기와 실측**까지다 — 원문을 자료로 넣는 저장 단계(외부 좌표·볼 수 있는 사람)는 다음 판이다.
//   그래서 상태 응답은 원문을 싣지 않고 목록(도구·크기·해시)만 준다. 원문은 그 사람 홈의 실행 폴더에만 있다.
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import { currentTenant, withTenant, type TenantContext } from "../org/tenant-context.js";
import { runAtLoginSeatSh, loginHomeOf, loginShQuote } from "./ai-login-run.js";
import { resolveMemberOsUser } from "./terminal-isolation.js";
import { userSlug } from "./profiles.js";
import { memberAiConnectorsPolicy, recordFromCollectSummary } from "../org/store/member-ai-connectors.js";   // #4427 — 정책 · 커넥터 기록
import { getCollectSessionPolicy } from "../org/store/runtime-config.js";
import { effectiveCollectSessionPolicy } from "../sessions/session-memory-policy.js";
import { endedByOf, gatewayExit } from "../org/collect/run-outcome.js";   // #4213 T11 — 실행 기록의 «누가 끝을 적었나» (순수)
import {
  COLLECT_CAPTURE_JS, COLLECT_GATE_JS, COLLECT_PROBE_PROMPT, COLLECT_RUNNER_JS, COLLECT_RUN_ID_RE, COLLECT_SESSION_LABEL,
  collectJob, collectReadSh, collectRunDir, collectRunStartedAt, collectSessionNoteSh, collectWriteSh, newCollectRunId,
  parseCollectRead, type CollectCapture,
} from "./collect-run-script.js";

/** 지켜보기 간격 — 한 판이 몇 분이라 이 정도면 끝을 늦게 보지 않는다. 읽기 한 번 = 중계 왕복 하나. */
const POLL_MS = 5_000;
/** 러너 시간 상한 뒤 이만큼 더 기다린다(러너가 스스로 끊고 요약을 쓰는 몫). 넘으면 «잃음». */
const GRACE_MS = 180_000;

export interface CollectRunStart {
  /** 지시. 없으면 점검 지시(COLLECT_PROBE_PROMPT). */
  prompt?: string | null;
  /** claude.ai 커넥터 앱 이름(Slack · Notion · Gmail …). 비면 연결된 것 전부. */
  apps?: readonly string[] | null;
  model?: string | null;
  maxTurns?: number | null;
  timeoutSec?: number | null;
}

interface RunRec {
  runId: string;
  owner: string;
  user: LivelyUser;
  osUser: string | null;
  dir: string;
  deadline: number;
  sessionId: string | null;
  done: boolean;
  tenant: TenantContext | null;
  timer?: ReturnType<typeof setInterval>;
  /** 끝 신호 없이 세션이 «없다» 로 확답된 연속 횟수 — 러너가 죽었다(메모리 상한에 걸린 경우 등). */
  goneStrikes: number;
  /** 이 판이 뜬 크기(수집 세션 크기 정책) — 실행 기록의 시작·끝이 같이 싣는다. 읽기 전이면 없다. */
  size?: { capMb: number; requestMb: number };
}

/** 이 게이트웨이가 띄우고 지켜보는 실행. 재기동하면 비지만, 상태 읽기가 폴더에서 다시 판정한다. */
const runs = new Map<string, RunRec>();

const ownerOf = (u: LivelyUser): string => String(u.userId || u.email || "solo");
const inTenant = <T>(t: TenantContext | null, fn: () => Promise<T>): Promise<T> => (t ? withTenant(t, fn) : fn());

/** 실행을 띄운다 — 실행 id 를 바로 돌려주고, 끝은 지켜보기·상태 읽기가 본다. 한 사람에 한 번에 하나. */
export async function startCollectRun(user: LivelyUser, input: CollectRunStart = {}): Promise<{
  runId: string; sessionId: string | null; model: string; apps: string[]; timeoutSec: number;
}> {
  const owner = ownerOf(user);
  //  #4427 — 이 워크스페이스가 구성원 AI 계정(Claude) 커넥터를 막았으면 그 커넥터로 하는 수집도 돌지 않는다(상민 2026-10-16 «실제로 막는다»).
  //   정책을 못 읽었으면 띄우지 않는다(fail-closed) — 끈 워크스페이스에서 DB 가 잠깐 막힌 사이에 수집이 돌지 않게.
  const policy = await memberAiConnectorsPolicy();
  if (policy === "blocked") {
    throw new HttpError(403, "이 워크스페이스는 구성원 Claude 커넥터를 쓰지 않도록 설정돼 있어 수집 실행을 띄우지 않습니다 — 관리자가 [고급 설정 ▸ 구성원 권한 관리 ▸ Claude 커넥터]에서 켤 수 있습니다");
  }
  if (policy !== "allowed") throw new HttpError(503, "구성원 Claude 커넥터 정책을 읽지 못해 수집 실행을 띄우지 않았습니다 — 잠시 뒤 다시 시도해 주세요");
  for (const r of runs.values()) {
    if (r.owner === owner && !r.done) throw new HttpError(409, `이미 도는 수집 실행이 있습니다(${r.runId}) — 끝난 뒤 다시 띄워 주세요`);
  }
  const osUser = await resolveMemberOsUser(userSlug(user));
  const home = loginHomeOf(osUser);
  const runId = newCollectRunId(new Date(), crypto.randomBytes(8).toString("base64url").toLowerCase());
  const dir = collectRunDir(home, runId);
  const job = collectJob({
    runId, home, prompt: input.prompt || COLLECT_PROBE_PROMPT,
    model: input.model, maxTurns: input.maxTurns, timeoutSec: input.timeoutSec, apps: input.apps,
  });
  const wrote = await runAtLoginSeatSh(osUser, collectWriteSh(dir, {
    "job.json": JSON.stringify(job), "run.cjs": COLLECT_RUNNER_JS, "gate.cjs": COLLECT_GATE_JS, "cap.cjs": COLLECT_CAPTURE_JS,
  }));
  if (!/written/.test(wrote)) throw new HttpError(500, `수집 실행 파일을 쓰지 못했습니다 — ${wrote.slice(0, 160)}`);
  const rec: RunRec = {
    runId, owner, user, osUser, dir, deadline: Date.now() + job.timeoutSec * 1000 + GRACE_MS,
    sessionId: null, done: false, tenant: currentTenant(), goneStrikes: 0,
  };
  runs.set(runId, rec);
  try {
    const { createSession } = await import("./sessions.js");
    const s = await createSession(user, {
      kind: "collect", label: COLLECT_SESSION_LABEL, rootKey: "personal", subpath: "",
      harness: "shell", flags: {}, autoApprove: false, collectRun: { dir },
    });
    rec.sessionId = s.id;
  } catch (e) {
    runs.delete(runId);
    throw e;
  }
  //  세션 id 를 폴더에 적는다 — 게이트웨이가 재기동해도 상태 읽기가 그 세션을 찾아 지운다. 못 적어도 실행은 계속된다.
  await runAtLoginSeatSh(osUser, collectSessionNoteSh(dir, rec.sessionId!)).catch((e) =>
    logger.warn({ runId, err: (e as Error)?.message }, "수집 실행 세션 id 기록 실패 — 지켜보기가 대신 지운다"));
  rec.timer = setInterval(() => { void inTenant(rec.tenant, () => pollOnce(rec)); }, POLL_MS);
  rec.timer.unref?.();
  //  시작 기록 — 세션 생성이 쓴 것과 같은 크기 정책(같은 캐시)을 함께 적는다. 지켜보기를 건 **뒤에**, 기다리지 않고 던지지 않는다
  //   (DB 가 막혀도 실행·뒷정리를 붙잡지 않는다 — 기다리는 사이 지켜보기가 없으면 세션이 안 지워지고 그 사람의 다음 실행이 409 로 막힌다).
  //   끝 기록도 같은 크기를 싣는다 — 시작 기록이 늦거나 빠져도 그 판이 어떤 크기로 돌았는지 남게.
  void (async () => {
    const size = await effectiveCollectSessionPolicy(getCollectSessionPolicy);
    rec.size = { capMb: size.max_mb, requestMb: size.request_mb };
    const m = await import("../org/collect/run-log.js");
    await m.recordRunStart({
      runId, member: memberOf(user), apps: job.apps, model: job.model,
      capMb: size.max_mb, requestMb: size.request_mb, startedAt: new Date(collectRunStartedAt(runId) ?? Date.now()),
    });
  })().catch((e) => logger.warn({ runId, err: (e as Error)?.message }, "수집 실행 시작 기록 실패 — 실행은 그대로"));
  return { runId, sessionId: rec.sessionId, model: job.model, apps: job.apps, timeoutSec: job.timeoutSec };
}

async function pollOnce(rec: RunRec): Promise<void> {
  if (rec.done) return;
  try {
    const st = parseCollectRead(await runAtLoginSeatSh(rec.osUser, collectReadSh(rec.dir)));
    if (st.state === "done") { noteOutcome(rec.user, rec.runId, st.exit, st.summary); noteRunEnd(rec.user, rec.runId, st.exit, st.summary, rec.size); }
    //  #4427 — 러너가 시작 때 잰 커넥터 목록을 그 사람 기록에 남긴다(던지지 않는다 — 뒷정리를 막지 않게). 관측 시각 = 실행 id 의 시작 시각.
    if (st.state === "done") await recordFromCollectSummary(rec.owner, st.summary, st.exit, collectRunStartedAt(rec.runId));
    if (st.state === "done" || st.state === "missing") return void (await finalize(rec, null));
    //  끝 신호 없이 판이 사라졌다 = 러너가 죽었다(메모리 상한 OOM · node 가 파일을 못 읽음 등). 상한까지 기다리지 않는다.
    //   러너는 끝 신호를 쓴 **뒤에** 끝나므로, 이 순서(읽기 → 세션 확인)에서 «없음» 이 두 번 연속이면 끝 신호가 올 일은 없다.
    //   «모른다»(중계 불통)는 세지 않는다 — 살아 있는 실행을 잃음으로 적지 않게.
    if (rec.sessionId) {
      const { sessionGoneVerdict } = await import("./tmux-exec.js");
      const gone = await sessionGoneVerdict(rec.sessionId).catch(() => null);
      rec.goneStrikes = gone === true ? rec.goneStrikes + 1 : 0;
      if (rec.goneStrikes >= 2) return void (await finalize(rec, "runner-gone"));
    }
  } catch (e) {
    logger.warn({ runId: rec.runId, err: (e as Error)?.message }, "수집 실행 상태 읽기 실패 — 다음 차례에 다시 본다");
  }
  if (Date.now() > rec.deadline) await finalize(rec, "lost");
}

/** 끝난 실행의 뒷정리 — 세션(판·행·훅 토큰)을 지운다. 잃었으면 폴더에 그 사유를 남긴다(러너가 못 남겼을 때만). */
async function finalize(rec: RunRec, lost: LostReason | null): Promise<void> {
  if (rec.done) return;
  rec.done = true;
  if (rec.timer) clearInterval(rec.timer);
  if (lost) {
    await markLost(rec.osUser, rec.dir, lost).catch(() => undefined);
    //  게이트웨이가 추정한 끝 — 러너 끝 신호가 나중에 읽히면 그쪽이 이 기록을 바로잡는다(run-log recordRunEnd).
    noteRunEnd(rec.user, rec.runId, gatewayExit(lost), null, rec.size);
  }
  if (rec.sessionId) await dropSession(rec.user, rec.sessionId);
  //  끝난 기록은 잠시 남긴다 — 그동안 같은 사람의 새 실행을 막지는 않는다(done=true).
  setTimeout(() => runs.delete(rec.runId), 10 * 60_000).unref?.();
}

async function dropSession(user: LivelyUser, sessionId: string): Promise<void> {
  try {
    const { killSession } = await import("./sessions.js");
    await killSession(user, sessionId, { admin: true });
  } catch (e) {
    logger.warn({ sessionId, err: (e as Error)?.message }, "수집 실행 세션 정리 실패 — 브로커 회수가 컨테이너를 거둔다");
  }
}

/**
 * 끝난 실행의 결과를 수집 단위 표(T10 #4742)에 넘긴다 — 로그인·커넥터가 끊겼으면 그 사람을 담당에서 건너뛰고(다음 후보가 이어받는다)
 *  아무도 못 메우는 단위가 생기면 볼 사람에게 알린다. 정상이면 끊김 기록을 지운다. 실행 한 판에 한 번(같은 판을 다시 읽어도
 *  표가 run id 로 거른다). **기다리지 않고 던지지 않는다** — 실행 정리(세션 지우기)를 늦추지 않는다.
 */
const notedRuns = new Set<string>();
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
function noteOutcome(user: LivelyUser, runId: string, exit: Record<string, unknown> | null, summary: Record<string, unknown> | null): void {
  const member = String(user.userId || "").trim();
  if (!member || !exit || notedRuns.has(runId)) return;
  notedRuns.add(runId);
  if (notedRuns.size > 500) notedRuns.delete(notedRuns.values().next().value as string);
  //  실행 폴더의 JSON 은 그 사람 홈에서 온다 — 판정에 쓰는 칸만 모양을 확인해 넘긴다(모르는 모양은 비운다).
  const res = (summary?.result && typeof summary.result === "object") ? summary.result as Record<string, unknown> : null;
  const sum = summary ? {
    stderrTail: strOrNull(summary.stderrTail), apps: strList(summary.apps),
    allowed: strList(summary.allowed), missing: strList(summary.missing),
    result: res ? { subtype: strOrNull(res.subtype), error: res.error, text: strOrNull(res.text) } : null,
  } : null;
  const at = strOrNull(exit.endedAt) ?? collectRunEndedAtFallback(runId);
  void import("../org/collect/unit-store.js")
    .then((m) => m.recordCollectOutcome({ member, runId, exit: { error: strOrNull(exit.error), code: typeof exit.code === "number" ? exit.code : null }, summary: sum, at }))
    .catch((e) => logger.warn({ runId, err: (e as Error)?.message }, "수집 실행 결과를 단위 표에 넘기지 못했다 — 담당 건강은 그대로"));
}
/** collect_run 의 구성원 칸 — 담당 건강(noteOutcome)과 같은 id. 비면 지켜보기 키와 같은 값으로. */
const memberOf = (u: LivelyUser): string => String(u.userId || "").trim() || ownerOf(u);

/**
 * 끝난 실행을 실행 기록(collect_run)에 넘긴다 — 지표(실패율·최고 메모리) 몫. noteOutcome 과 같은 자리에서 부르되 따로 거른다:
 *  게이트웨이 추정 끝(by gateway) 뒤에 러너 끝이 오면 그것도 넘겨야 하므로 (실행 id, 누가 적었나) 짝으로 한 번씩.
 *  **기다리지 않고 던지지 않는다**(noteOutcome 과 같은 이유).
 */
const endedRuns = new Set<string>();
function noteRunEnd(
  user: LivelyUser, runId: string, exit: Record<string, unknown> | null, summary: Record<string, unknown> | null,
  size?: { capMb: number; requestMb: number },
): void {
  if (!exit) return;
  const by = endedByOf(exit);
  const k = `${runId}\u0000${by}`;
  if (endedRuns.has(k)) return;
  endedRuns.add(k);
  if (endedRuns.size > 1000) endedRuns.delete(endedRuns.values().next().value as string);
  const started = collectRunStartedAt(runId);
  //  못 적었으면(DB 오류) 거름 표식을 지운다 — 다음 읽기(지켜보기·상태 조회)가 다시 적는다.
  void import("../org/collect/run-log.js")
    .then((m) => m.recordRunEnd({ runId, member: memberOf(user), exit, summary, by, startedAt: started ? new Date(started) : null, capMb: size?.capMb ?? null, requestMb: size?.requestMb ?? null }))
    .then((r) => { if (r === "error") endedRuns.delete(k); })
    .catch((e) => { endedRuns.delete(k); logger.warn({ runId, err: (e as Error)?.message }, "수집 실행 끝 기록 실패 — 실행 정리는 그대로"); });
}

/** 끝난 시각을 못 읽으면 시작 시각(실행 id 에 박혀 있다)으로 — 그래야 재기동 뒤 옛 실행이 나중 결과를 덮지 않는다. */
function collectRunEndedAtFallback(runId: string): string | null {
  const started = collectRunStartedAt(runId);
  return started ? new Date(started).toISOString() : null;
}

/** 잃은 사유 — lost: 상한을 넘도록 끝 신호가 없다 · runner-gone: 끝 신호 없이 판이 사라졌다(러너가 죽었다). */
type LostReason = "lost" | "runner-gone";

/** exit.json 이 없을 때만 잃음을 적는다(러너가 늦게라도 쓴 것을 덮지 않는다). */
function markLost(osUser: string | null, dir: string, why: LostReason): Promise<string> {
  const body = JSON.stringify(gatewayExit(why));
  const f = loginShQuote(`${dir}/exit.json`);
  return runAtLoginSeatSh(osUser, `[ -d ${loginShQuote(dir)} ] && [ ! -f ${f} ] && printf '%s' ${loginShQuote(body)} > ${f}; echo ok`);
}

export interface CollectRunView {
  runId: string;
  state: "running" | "done";
  sessionId: string | null;
  startedAt: string | null;
  exit: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  captures: CollectCapture[];
}

/**
 * 실행 상태 — **그 사람 자신의 실행만** 읽는다(폴더를 부르는 사람의 홈에서 찾으므로 남의 실행 id 를 줘도 닿지 않는다).
 *  끝났는데 세션이 남아 있으면(재기동으로 지켜보기가 사라진 경우) 여기서 지운다. 상한을 넘겼는데 안 끝났으면 «잃음».
 */
export async function readCollectRun(user: LivelyUser, runId: string): Promise<CollectRunView> {
  if (!COLLECT_RUN_ID_RE.test(String(runId))) throw new HttpError(400, "수집 실행 id 형식이 올바르지 않습니다");
  const osUser = await resolveMemberOsUser(userSlug(user));
  const dir = collectRunDir(loginHomeOf(osUser), runId);
  const st = parseCollectRead(await runAtLoginSeatSh(osUser, collectReadSh(dir)));
  if (st.state === "missing") throw new HttpError(404, "그 수집 실행을 찾지 못했습니다");
  const rec = runs.get(runId);
  const started = collectRunStartedAt(runId);
  if (st.state === "done") {
    noteOutcome(user, runId, st.exit, st.summary);
    noteRunEnd(user, runId, st.exit, st.summary, rec?.size);
    //  #4427 — 지켜보기가 놓친 끝(게이트웨이 재기동)도 여기서 남긴다. 관측 시각이 실행 id 의 시작 시각이라 몇 번 읽어도 같은 값이고,
    //   그 뒤에 더 새 확인이 있었으면 옛 관측으로 버려진다(잃은 실행 — 요약이 없는 끝 — 은 아예 적지 않는다: collectSummaryScan).
    await recordFromCollectSummary(ownerOf(user), st.summary, st.exit, started);
    if (rec && !rec.done) await finalize(rec, null);
    else if (!rec && st.sessionId) await dropSession(user, st.sessionId);
  } else if (!rec && started && Date.now() > started + 3600_000 + GRACE_MS) {
    //  지켜보던 게이트웨이가 사라졌고, 가장 긴 상한(1시간)보다 오래 끝나지 않았다.
    await markLost(osUser, dir, "lost").catch(() => undefined);
    if (st.sessionId) await dropSession(user, st.sessionId);
    return readCollectRun(user, runId);
  }
  return {
    runId,
    state: st.state === "done" ? "done" : "running",
    sessionId: st.sessionId ?? rec?.sessionId ?? null,
    startedAt: started ? new Date(started).toISOString() : null,
    exit: st.exit,
    summary: st.summary,
    captures: st.captures,
  };
}

/** (시험용) 지켜보던 실행 표를 비운다. */
export function _resetCollectRunsForTest(): void {
  for (const r of runs.values()) if (r.timer) clearInterval(r.timer);
  runs.clear();
}

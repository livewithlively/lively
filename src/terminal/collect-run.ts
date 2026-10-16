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
  return { runId, sessionId: rec.sessionId, model: job.model, apps: job.apps, timeoutSec: job.timeoutSec };
}

async function pollOnce(rec: RunRec): Promise<void> {
  if (rec.done) return;
  try {
    const st = parseCollectRead(await runAtLoginSeatSh(rec.osUser, collectReadSh(rec.dir)));
    if (st.state === "done") noteOutcome(rec.user, rec.runId, st.exit, st.summary);
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
  if (lost) await markLost(rec.osUser, rec.dir, lost).catch(() => undefined);
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
/** 끝난 시각을 못 읽으면 시작 시각(실행 id 에 박혀 있다)으로 — 그래야 재기동 뒤 옛 실행이 나중 결과를 덮지 않는다. */
function collectRunEndedAtFallback(runId: string): string | null {
  const started = collectRunStartedAt(runId);
  return started ? new Date(started).toISOString() : null;
}

/** 잃은 사유 — lost: 상한을 넘도록 끝 신호가 없다 · runner-gone: 끝 신호 없이 판이 사라졌다(러너가 죽었다). */
type LostReason = "lost" | "runner-gone";

/** exit.json 이 없을 때만 잃음을 적는다(러너가 늦게라도 쓴 것을 덮지 않는다). */
function markLost(osUser: string | null, dir: string, why: LostReason): Promise<string> {
  const body = JSON.stringify({ code: null, error: why, endedAt: new Date().toISOString() });
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

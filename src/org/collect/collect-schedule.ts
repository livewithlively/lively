// 지속 수집 트리거(#4213 T12 #4744) — **기본 주기 하나**. 판정은 schedule-plan.ts(순수)가 하고, 여기는 그 판정을 DB 와 수집 실행에 잇는다.
//
//  ── 확정(상민님 2026-10-15 «트리거 최종 확정») ──
//   · 별도 트리거는 기본 주기 하나다. 주기는 그 단위에 글이 올라오는 빈도로만 정한다(워크스페이스 활동은 보지 않는다).
//   · 매번 «새 글 있나?» 를 먼저 가볍게 확인하고 없으면 끝낸다 — 수집 실행은 읽은 위치 **뒤만** 읽으므로 단위마다 첫 호출이 곧 확인이고,
//     새 글이 없으면 그 한 번으로 끝난다(그 판은 표본 «0개» 를 남겨 빈도를 낮춘다 → 주기가 길어진다).
//   · 활동 트리거는 없다(폐기) · 백그라운드 대기열도 없다(검색 실패는 세션 쪽 보조 안내만).
//
//  ── 흐름 ──
//   ① 저장 단계(run-ingest)가 단위마다 noteUnitRead 를 부른다 — 표본을 더하고(다 읽은 판만) · 주기를 빈도로 다시 맞추고(자동일 때) ·
//      다음 확인 시각을 적는다(다 읽고 따라잡음 → 주기 뒤 · 밀림 → 곧바로 · 못 읽음 → 물러서며).
//   ② 스케줄러 틱(scheduler/engine.ts — 워크스페이스 컨텍스트 안. 셀프호스트 30초 · 매니지드 CP 하우스키핑 5분)이 collectScheduleTick 을
//      기다리지 않고 부른다. 안에서 워크스페이스마다 1분에 한 번만 돈다:
//      a. 정책 — 구성원 Claude 커넥터를 막은 워크스페이스는 아무것도 안 띄운다(#4427 — 못 읽으면 막음).
//      b. 훑기 — 끝났는데 저장 단계를 못 탄 실행(게이트웨이 재기동으로 지켜보기가 사라짐 — T11 이 넘긴 몫)을 상태 읽기로 마저 넣는다.
//      c. 띄우기 — 때가 된 단위의 담당자별로, 이미 도는 사람·실패가 이어져 물러선 사람은 빼고, 동시 실행 상한 안에서
//         가장 오래 기다린 사람부터 수집 실행(mode collect · 때가 된 단위 + 곧 때가 될 단위)을 띄운다.
//   ③ 실행이 끝나면 T11 의 지켜보기가 저장 단계를 돌리고(①), 담당 건강을 바꾼다(T10 — 끊긴 사람은 다음 후보가 이어받는다).
//
//  ⚠ 비용은 담당자의 구독에서 나간다 — 그래서 가장 짧은 주기는 30분이고(schedule-plan INTERVAL_TIERS), 실패가 이어지면 물러서며,
//   곧 때가 될 단위를 한 판에 묶는다. 동시 실행 상한(기본 2)은 세션 노드 자리를 사람 세션과 나눠 쓰기 때문이다(예약 640MB 씩).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import type { LivelyUser } from "../../context.js";
import { currentTenant } from "../tenant-context.js";
import { CLAUDE_COLLECT_APPS, validUnitRef } from "./collect-plan.js";
import {
  RUN_ALIVE_SEC, activityOf, addSample, effectiveIntervalSec, memberBackoffUntil, nextCheck, pickMembers, retryDelaySec,
  type ActivitySample, type DueGroup, type MemberRunRow, type NextWhy, type ReadOutcome,
} from "./schedule-plan.js";

/** 틱이 실제로 일하는 간격(워크스페이스마다) — 스케줄러 틱이 30초여도 여기는 1분에 한 번. */
export const SCHEDULE_TICK_MIN_MS = 60_000;
/** 워크스페이스마다 동시에 도는 수집 실행 상한 — env LIVELY_COLLECT_MAX_CONCURRENT 로 바꾼다(1~10). */
export const MAX_CONCURRENT_RUNS_DEFAULT = 2;
/** 한 틱에 훑는 «저장 단계를 못 탄 실행» 상한 — 하나 읽는 데 중계 왕복이 몇 번이라 많이 안 한다. */
export const SWEEP_PER_TICK = 5;
/** 띄우기가 실패한 사람(노드 자리 없음 등)을 다시 띄워 보기까지 — 연달아 실패하면 schedule-plan 물러서기 규칙대로 늘린다. */
const startFails = new Map<string, { k: number; until: number }>();

function maxConcurrent(): number {
  const n = Number(process.env.LIVELY_COLLECT_MAX_CONCURRENT);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : MAX_CONCURRENT_RUNS_DEFAULT;
}

// ── ① 저장 단계 → 다음 확인 시각 ─────────────────────────────────────────────

export interface UnitReadNote {
  outcome: ReadOutcome;
  /** 다 읽었지만 아직 «지금» 까지 못 왔다(collect-plan.behindAfter). */
  behind?: boolean;
  /** 못 다 읽었는데 구간을 더 줄일 수 없다. */
  stuck?: boolean;
  /** 다 읽은 판의 글 빈도 표본(collect-plan UnitHarvest.sample). */
  sample?: ActivitySample | null;
  /** 다음 판에 읽을 일이 이미 쌓였다 — 곧바로. */
  pending?: boolean;
  /** 판정 시각(ms) — 시험이 고정한다. */
  now?: number;
}

/**
 * 한 단위를 이번 판이 어떻게 읽었나를 적는다 — 표본 · 주기(자동일 때) · 다음 확인 시각 · 연속 실패 수 · 활동량(meta.activity — 리브·현황판이 본다).
 *  **던지지 않는다**(저장 단계의 나머지를 막지 않는다 — 못 적으면 그 단위는 다음 틱에 다시 때가 된 것으로 보이고, 구성원 물러서기가 헛돌기를 막는다).
 *  단위 행을 FOR UPDATE 로 잡고 읽어 계산한 뒤 쓴다(같은 단위의 두 판이 겹쳐도 표본이 사라지지 않게).
 */
export async function noteUnitRead(unitId: number, note: UnitReadNote): Promise<{ next_at: string; why: NextWhy; interval_sec: number } | null> {
  const nowMs = note.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT interval_sec, interval_auto, sched FROM collect_unit WHERE id = $1 FOR UPDATE`, [unitId]);
    const row = r.rows[0] as { interval_sec: number | null; interval_auto: boolean; sched: Record<string, unknown> | null } | undefined;
    if (!row) { await client.query("ROLLBACK"); return null; }
    const sched = row.sched && typeof row.sched === "object" && !Array.isArray(row.sched) ? row.sched : {};
    const hist = addSample(sched.hist, note.sample ?? null, nowSec);
    const auto = row.interval_auto !== false;
    const interval = effectiveIntervalSec({ interval_sec: row.interval_sec, interval_auto: auto }, hist, nowSec);
    const verdict = nextCheck({
      nowSec, intervalSec: interval, outcome: note.outcome, behind: note.behind, stuck: note.stuck, pending: note.pending,
      fails: Number.isFinite(Number(sched.fails)) ? Number(sched.fails) : 0,
    });
    const act = activityOf(hist, nowSec);
    const activity = {
      per_day: act.perDay == null ? null : Math.round(act.perDay * 100) / 100,
      observed_days: Math.round((act.observedSec / 86400) * 10) / 10,
      measured_at: new Date(nowMs).toISOString(),
    };
    const nextAt = new Date(verdict.nextSec * 1000).toISOString();
    await client.query(
      `UPDATE collect_unit SET
          next_at = $2::timestamptz,
          sched = $3::jsonb,
          interval_sec = CASE WHEN interval_auto THEN $4::int ELSE interval_sec END,
          meta = meta || jsonb_build_object('activity', $5::jsonb)
        WHERE id = $1`,
      [unitId, nextAt, JSON.stringify({ hist, fails: verdict.fails, why: verdict.why, at: new Date(nowMs).toISOString() }), interval, JSON.stringify(activity)]);
    await client.query("COMMIT");
    return { next_at: nextAt, why: verdict.why, interval_sec: auto ? interval : (row.interval_sec ?? interval) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    logger.warn({ unitId, err: (e as Error)?.message }, "[collect-schedule] 다음 확인 시각을 못 적었다 — 다음 틱에 다시 때가 된 것으로 보인다");
    return null;
  } finally {
    client.release();
  }
}

// ── ② 스케줄러 틱 ───────────────────────────────────────────────────────────

/** 시험·다른 배선이 갈아 끼우는 자리. 기본은 T11 수집 실행(collect-run.ts). */
export interface ScheduleDeps {
  now?: () => number;
  /** 그 구성원의 수집 실행을 띄운다(때가 된 단위 + 곧 때가 될 단위). 던지면 그 사람만 물러선다. */
  start?: (member: string) => Promise<{ runId: string }>;
  /** 끝난 실행 하나를 상태 읽기로 마저 처리한다(저장 단계 · 끝 기록 · 세션 정리). */
  read?: (member: string, runId: string) => Promise<unknown>;
  /** 이 게이트웨이 안에서 지금 도는 수집 실행의 주인들(실행 기록보다 먼저 아는 몫). */
  running?: () => ReadonlySet<string>;
  /** 구성원 Claude 커넥터 정책(#4427). */
  policy?: () => Promise<string>;
  maxConcurrent?: number;
}

export interface ScheduleTickResult {
  skipped?: "throttle" | "busy" | "policy" | "error";
  swept: number;
  due_units: number;
  due_members: number;
  running: number;
  started: Array<{ member: string; run_id: string }>;
  failed: Array<{ member: string; status: number | null; error: string }>;
}

const lastTickAt = new Map<string, number>();
const ticking = new Set<string>();

/** 서버가 그 구성원으로 수집 실행을 띄울 때의 신원 — 세션·토큰은 구성원 id 로 굽는다(리브 2턴 스윕과 같은 모양). */
export const memberUser = (member: string): LivelyUser =>
  ({ userId: member, email: "", scopes: [], projects: [] }) as unknown as LivelyUser;

async function defaultStart(member: string): Promise<{ runId: string }> {
  const { startCollectRun } = await import("../../terminal/collect-run.js");
  const r = await startCollectRun(memberUser(member), { mode: "collect", dueOnly: true, trigger: "schedule" });
  return { runId: r.runId };
}
async function defaultRead(member: string, runId: string): Promise<unknown> {
  const { readCollectRun } = await import("../../terminal/collect-run.js");
  return readCollectRun(memberUser(member), runId);
}
async function defaultRunning(): Promise<ReadonlySet<string>> {
  const { runningCollectOwners } = await import("../../terminal/collect-run.js");
  return runningCollectOwners();
}
async function defaultPolicy(): Promise<string> {
  const { memberAiConnectorsPolicy } = await import("../store/member-ai-connectors.js");
  return memberAiConnectorsPolicy();
}

/**
 * 기본 주기 틱 — 위 머리말 ②. **던지지 않는다**(스케줄러 틱을 막지 않는다). 워크스페이스마다 1분에 한 번(force 면 바로) · 겹치면 뒤 판은 그냥 돌아간다.
 */
export async function collectScheduleTick(opts: { force?: boolean } & ScheduleDeps = {}): Promise<ScheduleTickResult> {
  const res: ScheduleTickResult = { swept: 0, due_units: 0, due_members: 0, running: 0, started: [], failed: [] };
  const now = (opts.now ?? Date.now)();
  const key = currentTenant()?.id ?? "-";
  if (!opts.force && now - (lastTickAt.get(key) ?? 0) < SCHEDULE_TICK_MIN_MS) return { ...res, skipped: "throttle" };
  if (ticking.has(key)) return { ...res, skipped: "busy" };
  ticking.add(key);
  lastTickAt.set(key, now);
  try {
    const policy = await (opts.policy ?? defaultPolicy)();
    if (policy !== "allowed") return { ...res, skipped: "policy" };
    res.swept = await sweepUningested(opts.read ?? defaultRead);
    const { dueAssignments } = await import("./unit-store.js");
    //  수집 실행이 읽을 줄 아는 단위만 센다(collect-plan pickUnitsForRun 과 같은 거름) — 못 읽는 단위로 사람을 띄우면
    //   «맡은 단위 없음»(409)이 틱마다 되풀이된다.
    const due = (await dueAssignments(now)).filter((d) => !!CLAUDE_COLLECT_APPS[d.app] && validUnitRef(d.app, d.ref));
    res.due_units = due.length;
    const groups = new Map<string, DueGroup>();
    for (const d of due) {
      const g = groups.get(d.member) ?? { member: d.member, units: 0, oldestDueMs: Number.POSITIVE_INFINITY };
      g.units++;
      g.oldestDueMs = Math.min(g.oldestDueMs, d.due_since_ms);
      groups.set(d.member, g);
    }
    res.due_members = groups.size;
    if (!groups.size) return res;
    const alive = await runningFromLog(now);
    const local = opts.running ? opts.running() : await defaultRunning();
    const running = new Set<string>([...alive, ...local]);
    res.running = running.size;
    const backoff = await memberBackoffs(now);
    for (const [m, f] of startFails) if (f.until > now) backoff.set(m, Math.max(backoff.get(m) ?? 0, f.until));
    const picks = pickMembers([...groups.values()], {
      running, backoffUntilMs: backoff, nowMs: now, slots: (opts.maxConcurrent ?? maxConcurrent()) - running.size,
    });
    const start = opts.start ?? defaultStart;
    for (const g of picks) {
      try {
        const r = await start(g.member);
        startFails.delete(g.member);
        res.started.push({ member: g.member, run_id: r.runId });
      } catch (e) {
        const status = Number((e as { status?: unknown })?.status);
        const st = Number.isFinite(status) ? status : null;
        //  409 — 그새 실행이 떴거나(다른 게이트웨이·사람) 맡은 단위가 없어졌다(담당이 바뀜). 실패가 아니다.
        if (st === 409) continue;
        //  403·503 — 워크스페이스 정책이 막았다(그새 관리자가 껐다 · 못 읽음). 이번 틱은 여기서 멈춘다.
        if (st === 403 || st === 503) { res.failed.push({ member: g.member, status: st, error: String((e as Error)?.message ?? e).slice(0, 200) }); break; }
        const k = (startFails.get(g.member)?.k ?? 0) + 1;
        startFails.set(g.member, { k, until: now + retryDelaySec(k) * 1000 });
        res.failed.push({ member: g.member, status: st, error: String((e as Error)?.message ?? e).slice(0, 200) });
        logger.warn({ member: g.member, status: st, err: (e as Error)?.message }, "[collect-schedule] 수집 실행을 못 띄웠다 — 물러섰다가 다시 띄운다");
      }
    }
    return res;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[collect-schedule] 기본 주기 틱 실패 — 다음 틱에 다시 본다");
    return { ...res, skipped: "error" };
  } finally {
    ticking.delete(key);
  }
}

/** 실행 기록에서 «아직 도는» 수집 실행의 주인 — 끝 기록이 없고 가장 긴 상한 안에서 시작한 판(다른 게이트웨이가 띄운 것도 보인다). */
async function runningFromLog(now: number): Promise<Set<string>> {
  const r = await itemsPool.query(
    `SELECT DISTINCT member_id FROM collect_run WHERE outcome IS NULL AND started_at > $1::timestamptz`,
    [new Date(now - RUN_ALIVE_SEC * 1000)]);
  return new Set(r.rows.map((x: { member_id: string }) => String(x.member_id)));
}

/** 구성원마다 «언제까지 띄우지 않나» — 최근 하루 수집 실행에서 연달아 실패한 수만큼(schedule-plan.memberBackoffUntil). */
async function memberBackoffs(now: number): Promise<Map<string, number>> {
  const r = await itemsPool.query(
    `SELECT member_id, started_at, ended_at, outcome, ingest->>'state' AS ingest_state
       FROM collect_run WHERE mode = 'collect' AND started_at > $1::timestamptz
      ORDER BY member_id, started_at DESC`, [new Date(now - 86400_000)]);
  const by = new Map<string, MemberRunRow[]>();
  for (const x of r.rows as Array<{ member_id: string; started_at: Date; ended_at: Date | null; outcome: string | null; ingest_state: string | null }>) {
    const rows = by.get(x.member_id) ?? [];
    rows.push({
      started_ms: new Date(x.started_at).getTime(), ended_ms: x.ended_at ? new Date(x.ended_at).getTime() : null,
      outcome: x.outcome, ingest_state: x.ingest_state,
    });
    by.set(x.member_id, rows);
  }
  const out = new Map<string, number>();
  for (const [m, rows] of by) {
    const until = memberBackoffUntil(rows);
    if (until != null) out.set(m, until);
  }
  return out;
}

/**
 * 끝났는데 저장 단계를 못 탄 실행을 마저 처리한다 — T11 의 저장 단계는 지켜보기·상태 읽기에서만 돈다. 게이트웨이가 재기동하면 지켜보기가
 *  사라지고 아무도 상태를 안 읽으면 원문이 자료가 되지 않는다(as-built «남은 것»). 그런 실행을 상태 읽기(readCollectRun)로 다시 밟는다 —
 *  끝을 적고 · 저장 단계를 돌리고(한 실행에 한 번 — collect_run.ingest 차례 잡기) · 남은 세션을 지운다. 이틀 지난 실행은 보지 않는다.
 *  아직 도는 판(끝 기록 없음 · 가장 긴 상한 안)은 건드리지 않는다.
 */
async function sweepUningested(read: (member: string, runId: string) => Promise<unknown>): Promise<number> {
  const r = await itemsPool.query(
    `SELECT run_id, member_id FROM collect_run
      WHERE mode IN ('listing','collect') AND started_at > now() - interval '2 days'
        AND (ingest IS NULL OR (ingest->>'state' = 'running' AND (ingest->>'at')::timestamptz < now() - interval '15 minutes'))
        AND (outcome IS NOT NULL OR started_at < now() - make_interval(secs => $1::int))
      ORDER BY started_at LIMIT $2`, [RUN_ALIVE_SEC, SWEEP_PER_TICK]);
  let n = 0;
  for (const x of r.rows as Array<{ run_id: string; member_id: string }>) {
    const runId = String(x.run_id);
    try {
      await read(String(x.member_id), runId);
      sweepFails.delete(runId);
      n++;
    } catch (e) {
      const status = Number((e as { status?: unknown })?.status);
      const tries = (sweepFails.get(runId) ?? 0) + 1;
      sweepFails.set(runId, tries);
      //  실행 폴더가 없다(사흘 지나 치워졌다 · 그 사람 홈이 없다) — 또는 몇 번을 읽어도 안 된다. 원문을 다시 읽을 길이 없으니
      //   «저장 단계 실패» 로 닫아 다음 틱이 같은 판을 다시 집지 않게 한다(실패율 지표에도 보인다).
      if (status === 404 || tries >= SWEEP_MAX_TRIES) {
        await closeUnreadable(runId, status === 404 ? "실행 폴더가 없어 원문을 읽을 수 없다" : `상태를 ${tries}번 읽지 못했다`);
        sweepFails.delete(runId);
      }
      logger.warn({ runId, status: Number.isFinite(status) ? status : null, tries, err: (e as Error)?.message },
        "[collect-schedule] 끝난 실행을 마저 처리하지 못했다 — 다음 틱에 다시 본다(몇 번 넘으면 닫는다)");
    }
  }
  if (sweepFails.size > 500) sweepFails.delete(sweepFails.keys().next().value as string);
  return n;
}

/** 훑기가 같은 판을 이만큼 못 읽으면 닫는다. 판마다 센 수는 이 게이트웨이 메모리에만 있다(재기동하면 다시 센다 — 이틀 창이 끝을 보장한다). */
const SWEEP_MAX_TRIES = 3;
const sweepFails = new Map<string, number>();

/** 원문을 다시 읽을 길이 없는 실행을 닫는다 — 저장 단계 «실패» · 끝 기록이 없으면 «잃음»(게이트웨이 추정). 던지지 않는다. */
async function closeUnreadable(runId: string, why: string): Promise<void> {
  try {
    await itemsPool.query(
      `UPDATE collect_run SET
          ingest = jsonb_build_object('state', 'failed', 'error', $2::text, 'at', now()),
          outcome = COALESCE(outcome, 'lost'), ended_by = COALESCE(ended_by, 'gateway'), ended_at = COALESCE(ended_at, now()),
          error = COALESCE(error, $2::text), updated_at = now()
        WHERE run_id = $1 AND (ingest IS NULL OR ingest->>'state' = 'running')`, [runId, why]);
  } catch (e) {
    logger.warn({ runId, err: (e as Error)?.message }, "[collect-schedule] 못 읽는 실행을 닫지 못했다");
  }
}

/** (시험용) 틱 간격·띄우기 물러서기·훑기 실패 기억을 지운다. */
export function _resetCollectScheduleForTest(): void { lastTickAt.clear(); ticking.clear(); startFails.clear(); sweepFails.clear(); }

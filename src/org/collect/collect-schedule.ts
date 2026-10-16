// 지속 수집 트리거(#4213 T12 #4744) — **기본 주기 하나**. 판정은 schedule-plan.ts(순수)가 하고, 여기는 그 판정을 DB 와 수집 실행에 잇는다.
//
//  ── 확정(상민님 2026-10-15 «트리거 최종 확정») ──
//   · 별도 트리거는 기본 주기 하나다. 주기는 그 단위에 글이 올라오는 빈도로만 정한다(워크스페이스 활동은 보지 않는다).
//   · 매번 «새 글 있나?» 를 먼저 가볍게 확인하고 없으면 끝낸다 — 수집 실행은 읽은 위치 **뒤만** 읽으므로 단위마다 첫 호출이 곧 확인이고,
//     새 글이 없으면 그 한 번으로 끝난다(그 판은 표본 «0개» 를 남겨 빈도를 낮춘다 → 주기가 길어진다).
//   · 활동 트리거는 없다(폐기) · 백그라운드 대기열도 없다(검색 실패는 세션 쪽 보조 안내만).
//
//  ── 흐름 ──
//   ① 수집 실행이 뜨면 실은 단위를 붙잡고(unit-schedule.leaseUnits), 저장 단계(run-ingest)가 단위마다 noteUnitRead 로 표본·주기·다음 확인을
//      적는다(다 읽고 따라잡음 → 주기 뒤 · 밀림 → 곧바로 · 못 읽음 → 물러서며 · 지금 담당의 판만).
//   ② 스케줄러 틱(scheduler/engine.ts — 워크스페이스 컨텍스트 안. 셀프호스트 30초 · 매니지드 CP 하우스키핑 5분)이 collectScheduleTick 을
//      기다리지 않고 부른다. 안에서 워크스페이스마다 1분에 한 번만 돈다:
//      a. 끄개 — env LIVELY_COLLECT_SCHEDULE=off 면 아무것도 안 한다. 정책 — 구성원 Claude 커넥터를 막은 워크스페이스도(#4427 — 못 읽으면 막음).
//      b. 훑기 — 끝났는데 저장 단계를 못 탄 실행(게이트웨이 재기동으로 지켜보기가 사라짐 — T11 이 넘긴 몫)을 상태 읽기로 마저 넣는다.
//      c. 띄우기 — 때가 된 단위의 담당자별로, 도는 사람(실행 중 · 저장 단계 중)·실패가 이어져 물러선 사람·하루 상한에 닿은 사람은 빼고,
//         동시 실행 상한 안에서 가장 오래 기다린 사람부터 수집 실행(mode collect · 때가 된 단위 + 곧 때가 될 단위)을 띄운다.
//   ③ 실행이 끝나면 T11 의 지켜보기가 저장 단계를 돌리고(①), 담당 건강을 바꾼다(T10 — 끊긴 사람은 다음 후보가 이어받는다).
//
//  ⚠ 비용은 담당자의 구독에서 나간다 — 그래서 가장 짧은 주기는 30분이고(schedule-plan INTERVAL_TIERS), 실패가 이어지면 물러서며, 곧 때가 될
//   단위를 한 판에 묶는다. 구성원마다 하루 주기 판 수에 안전망이 있다(env LIVELY_COLLECT_DAILY_MAX · 기본 288 — 넘으면 멈추지 않고 그 비율로
//   고르게 늦춘다). 동시 실행 상한(기본 2)은 세션 노드 자리를 사람 세션과 나눠 쓰기 때문이다(예약 640MB 씩). 이 루프는 org_cron 브레이커 밖이라
//   끄개(env)를 따로 둔다. 중계 호출 하나가 멈춰도 틱 전체가 서지 않게 호출마다 마감이 있다(CALL_DEADLINE_MS).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import type { LivelyUser } from "../../context.js";
import { currentTenant } from "../tenant-context.js";
import { CLAUDE_COLLECT_APPS, validUnitRef } from "./collect-plan.js";
import { INGEST_STALE_MIN } from "./run-log.js";
import { releaseRunLeases } from "./unit-schedule.js";
import {
  RUN_ALIVE_SEC, memberBackoffUntil, pickMembers, retryDelaySec, type DueGroup, type MemberRunRow,
} from "./schedule-plan.js";

/** 틱이 실제로 일하는 간격(워크스페이스마다) — 스케줄러 틱이 30초여도 여기는 1분에 한 번. */
export const SCHEDULE_TICK_MIN_MS = 60_000;
/** 워크스페이스마다 동시에 도는 수집 실행 상한 — env LIVELY_COLLECT_MAX_CONCURRENT 로 바꾼다(1~10). */
export const MAX_CONCURRENT_RUNS_DEFAULT = 2;
/**
 * 구성원마다 최근 24시간 동안 기본 주기가 띄우는 판 수의 안전망 — env LIVELY_COLLECT_DAILY_MAX(범위 밖이면 1~1000 으로 맞춘다). 바쁜 단위
 *  서른 개(30분 주기 · 한 판 6단위)면 하루 240판이 정상이라 그보다 넉넉히 둔다 — 비용 정책이 아니라 «모르는 헛돌기» 를 자르는 안전망이다.
 *  닿으면 멈추지 않고 «마지막 주기 판 + 24시간/상한» 뒤로 고르게 늦춘다(하루 몇 시간 통째로 쉬지 않게 — 리뷰 2026-10-17). 기본 288 = 5분에 한 판.
 */
export const DAILY_RUNS_DEFAULT = 288;
/** 중계 호출(띄우기 · 상태 읽기) 하나를 기다리는 마감 — 넘기면 그 사람·그 판만 실패로 센다(중계가 멈춰도 틱 전체가 서지 않게). */
export const CALL_DEADLINE_MS = 90_000;
/** 틱이 이보다 오래 «도는 중» 이면 멈춘 것으로 보고 다음 틱이 이어받는다(마감이 있으니 보통은 닿지 않는다). */
export const TICK_STALE_MS = 30 * 60_000;
/** 한 틱에 훑는 «저장 단계를 못 탄 실행» 상한 — 하나 읽는 데 중계 왕복이 몇 번이라 많이 안 한다. */
export const SWEEP_PER_TICK = 5;
/** 훑기가 같은 판을 못 읽은 지 이만큼 지나고 세 번 넘게 실패하면 닫는다(중계가 잠깐 끊긴 것으로 비용 낸 원문을 버리지 않게). */
export const SWEEP_CLOSE_AFTER_MS = 3600_000;
const SWEEP_MIN_TRIES = 3;

/** env 정수 — 없거나 숫자가 아니면 기본값, 범위 밖이면 범위 끝으로 맞춘다(조용히 기본값으로 돌아가지 않게). */
const envInt = (name: string, lo: number, hi: number, dflt: number): number => {
  const raw = String(process.env[name] ?? "").trim();
  const n = Math.floor(Number(raw));
  return raw && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const maxConcurrent = (): number => envInt("LIVELY_COLLECT_MAX_CONCURRENT", 1, 10, MAX_CONCURRENT_RUNS_DEFAULT);
const dailyMax = (): number => envInt("LIVELY_COLLECT_DAILY_MAX", 1, 1000, DAILY_RUNS_DEFAULT);
/** 끄개 — 정책 토글(구성원 Claude 커넥터 전체)을 건드리지 않고 기본 주기만 끈다. */
export const scheduleOff = (): boolean => /^(off|0|false|no)$/i.test(String(process.env.LIVELY_COLLECT_SCHEDULE ?? "").trim());

/** 워크스페이스별 기억의 열쇠 — 중앙 모드는 한 프로세스가 여러 워크스페이스를 돌고, 구성원 id 는 워크스페이스 안에서만 유일하다. */
const tkey = (): string => currentTenant()?.id ?? "-";
const mkey = (member: string): string => `${tkey()}\u0000${member}`;

/** 띄우기가 실패한 사람(노드 자리 없음 등) — 연달아 실패하면 schedule-plan 물러서기 규칙대로 늘린다. 열쇠 = 워크스페이스 + 구성원. */
const startFails = new Map<string, { k: number; until: number }>();
/** 하루 안전망에 닿아 늦추는 중인 사람 — 닿을 때 한 번만 알린다. 열쇠 = 워크스페이스 + 구성원. */
const capped = new Set<string>();

/** p 를 ms 안에서만 기다린다 — 넘기면 상태 없는 오류로 던진다(그 호출은 뒤에서 끝난다). */
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} — ${Math.round(ms / 1000)}초 안에 끝나지 않았다`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// ── 스케줄러 틱 ─────────────────────────────────────────────────────────────

/** 시험·다른 배선이 갈아 끼우는 자리. 기본은 T11 수집 실행(collect-run.ts). */
export interface ScheduleDeps {
  now?: () => number;
  /** 그 구성원의 수집 실행을 띄운다(때가 된 단위 + 곧 때가 될 단위). 던지면 그 사람만 물러선다(정책이 막았으면 틱이 멈춘다). */
  start?: (member: string) => Promise<{ runId: string }>;
  /** 끝난 실행 하나를 상태 읽기로 마저 처리한다(저장 단계 · 끝 기록 · 세션 정리). */
  read?: (member: string, runId: string) => Promise<unknown>;
  /** 이 게이트웨이 안에서 지금 도는 수집 실행의 주인들(실행 기록보다 먼저 아는 몫). */
  running?: () => ReadonlySet<string>;
  /** 구성원 Claude 커넥터 정책(#4427). */
  policy?: () => Promise<string>;
  maxConcurrent?: number;
  dailyMax?: number;
  /** 중계 호출 하나의 마감(시험이 줄인다). */
  callDeadlineMs?: number;
}

export interface ScheduleTickResult {
  skipped?: "throttle" | "busy" | "off" | "policy" | "error";
  swept: number;
  due_units: number;
  due_members: number;
  running: number;
  /** 하루 상한에 닿아 이번엔 안 띄운 사람 수. */
  capped: number;
  started: Array<{ member: string; run_id: string }>;
  failed: Array<{ member: string; status: number | null; error: string }>;
}

const lastTickAt = new Map<string, number>();
/** 지금 도는 틱(워크스페이스 → 시작 시각) — 겹치면 뒤 틱은 돌아간다. TICK_STALE_MS 넘게 남은 표식은 무시한다. */
const ticking = new Map<string, number>();

/** 서버가 그 구성원으로 수집 실행을 띄울 때의 신원 — 세션·토큰은 구성원 id 로 굽는다(리브 2턴 스윕 · profiles 와 같은 모양). */
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
  const res: ScheduleTickResult = { swept: 0, due_units: 0, due_members: 0, running: 0, capped: 0, started: [], failed: [] };
  if (scheduleOff()) return { ...res, skipped: "off" };
  const now = (opts.now ?? Date.now)();
  const key = tkey();
  if (!opts.force && now - (lastTickAt.get(key) ?? 0) < SCHEDULE_TICK_MIN_MS) return { ...res, skipped: "throttle" };
  const busySince = ticking.get(key);
  if (busySince != null && now - busySince < TICK_STALE_MS) return { ...res, skipped: "busy" };
  if (busySince != null) logger.warn({ since: new Date(busySince).toISOString() }, "[collect-schedule] 앞 틱이 끝나지 않은 채 오래됐다 — 이어받는다");
  ticking.set(key, now);
  lastTickAt.set(key, now);
  const deadlineMs = opts.callDeadlineMs ?? CALL_DEADLINE_MS;
  try {
    const readPolicy = opts.policy ?? defaultPolicy;
    if ((await readPolicy()) !== "allowed") return { ...res, skipped: "policy" };
    const read = opts.read ?? defaultRead;
    res.swept = await sweepUningested((m, id) => withDeadline(read(m, id), deadlineMs, "끝난 실행 상태 읽기"), now);
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
    const { backoff, scheduledToday, lastScheduledMs } = await memberHistory(now);
    const prefix = `${key}\u0000`;
    for (const [k, f] of startFails) {
      if (!k.startsWith(prefix)) continue;
      if (f.until > now) { const m = k.slice(prefix.length); backoff.set(m, Math.max(backoff.get(m) ?? 0, f.until)); }
    }
    //  하루 안전망 — 닿은 사람은 «마지막 주기 판 + 24시간/상한» 뒤로 늦춘다(멈추지 않고 그 비율로 고르게). 닿을 때 한 번만 알린다.
    const cap = opts.dailyMax ?? dailyMax();
    for (const m of groups.keys()) {
      const n = scheduledToday.get(m) ?? 0;
      const ck = mkey(m);
      if (n < cap) { capped.delete(ck); continue; }
      const until = (lastScheduledMs.get(m) ?? now) + Math.ceil(86400_000 / cap);
      if (until > now) { backoff.set(m, Math.max(backoff.get(m) ?? 0, until)); res.capped++; }
      if (!capped.has(ck)) {
        capped.add(ck);
        logger.warn({ member: m, runs: n, cap }, "[collect-schedule] 최근 24시간 주기 판 수가 안전망에 닿았다 — 이 사람의 주기 수집을 그 비율로 늦춘다");
      }
    }
    const picks = pickMembers([...groups.values()], {
      running, backoffUntilMs: backoff, nowMs: now, slots: (opts.maxConcurrent ?? maxConcurrent()) - running.size,
    });
    const start = opts.start ?? defaultStart;
    for (const g of picks) {
      try {
        const r = await withDeadline(start(g.member), deadlineMs, "수집 실행 띄우기");
        startFails.delete(mkey(g.member));
        res.started.push({ member: g.member, run_id: r.runId });
      } catch (e) {
        const status = Number((e as { status?: unknown })?.status);
        const st = Number.isFinite(status) ? status : null;
        const error = String((e as Error)?.message ?? e).slice(0, 200);
        //  409 — 그새 실행이 떴거나(다른 게이트웨이·사람) 때가 된 단위가 없어졌다(담당이 바뀜 · 다른 판이 읽음). 실패가 아니다.
        if (st === 409) continue;
        //  403·503 — 정책이 그새 막혔을 수도, 세션 컨테이너가 모자란 것일 수도 있다(503 «세션 컨테이너를 확보하지 못해»). 정책을 다시 읽어
        //   막혔으면 이 틱을 멈추고, 아니면 그 사람만 물러선다 — 한 사람의 실패가 뒤 사람을 영영 막지 않게(리뷰 2026-10-17).
        if ((st === 403 || st === 503) && (await readPolicy().catch(() => "unknown")) !== "allowed") {
          res.failed.push({ member: g.member, status: st, error });
          break;
        }
        const k = (startFails.get(mkey(g.member))?.k ?? 0) + 1;
        startFails.set(mkey(g.member), { k, until: now + retryDelaySec(k) * 1000 });
        res.failed.push({ member: g.member, status: st, error });
        logger.warn({ member: g.member, status: st, err: error }, "[collect-schedule] 수집 실행을 못 띄웠다 — 이 사람만 물러섰다가 다시 띄운다");
      }
    }
    if (startFails.size > 2000) startFails.delete(startFails.keys().next().value as string);
    if (capped.size > 2000) capped.delete(capped.values().next().value as string);
    return res;
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[collect-schedule] 기본 주기 틱 실패 — 다음 틱에 다시 본다");
    return { ...res, skipped: "error" };
  } finally {
    if (ticking.get(key) === now) ticking.delete(key);   // 오래돼 이어받힌 틱이 늦게 끝나도 새 틱의 표식을 지우지 않게
  }
}

/**
 * 실행 기록에서 «아직 도는» 수집 실행의 주인 — 끝 기록이 없고 그 판의 마감이 안 지난 판(다른 게이트웨이가 띄운 것도 보인다 · 마감을 모르는
 *  옛 판은 가장 긴 상한으로), 그리고 끝났지만 저장 단계가 아직이거나 도는 판(끝난 지 INGEST_STALE_MIN 분 안 — 그 판의 단위는 저장이 끝나야
 *  다음 확인 시각이 옮겨진다). 지켜보던 게이트웨이가 재기동해 끝 기록이 안 적힌 판은 마감이 지나면 빠지고 훑기 몫이 된다.
 */
async function runningFromLog(now: number): Promise<Set<string>> {
  const r = await itemsPool.query(
    `SELECT DISTINCT member_id FROM collect_run
      WHERE (outcome IS NULL AND COALESCE(deadline_at, started_at + make_interval(secs => $3::int)) > $1::timestamptz)
         OR (outcome IS NOT NULL AND mode IN ('listing','collect') AND (ingest IS NULL OR ingest->>'state' = 'running')
             AND COALESCE(ended_at, started_at) > $2::timestamptz)`,
    [new Date(now), new Date(now - INGEST_STALE_MIN * 60_000), RUN_ALIVE_SEC]);
  return new Set(r.rows.map((x: { member_id: string }) => String(x.member_id)));
}

/**
 * 구성원마다 «언제까지 띄우지 않나»(최근 하루 수집 실행에서 연달아 실패한 수만큼 — schedule-plan.memberBackoffUntil)와
 *  최근 24시간 기본 주기가 띄운 판 수(하루 상한).
 */
async function memberHistory(now: number): Promise<{ backoff: Map<string, number>; scheduledToday: Map<string, number>; lastScheduledMs: Map<string, number> }> {
  const r = await itemsPool.query(
    `SELECT member_id, started_at, ended_at, outcome, ingest->>'state' AS ingest_state, plan->>'trigger' AS trigger
       FROM collect_run WHERE mode = 'collect' AND started_at > $1::timestamptz
      ORDER BY member_id, started_at DESC`, [new Date(now - 86400_000)]);
  const by = new Map<string, MemberRunRow[]>();
  const scheduledToday = new Map<string, number>();
  const lastScheduledMs = new Map<string, number>();
  for (const x of r.rows as Array<{ member_id: string; started_at: Date; ended_at: Date | null; outcome: string | null; ingest_state: string | null; trigger: string | null }>) {
    const rows = by.get(x.member_id) ?? [];
    rows.push({
      started_ms: new Date(x.started_at).getTime(), ended_ms: x.ended_at ? new Date(x.ended_at).getTime() : null,
      outcome: x.outcome, ingest_state: x.ingest_state,
    });
    by.set(x.member_id, rows);
    if (x.trigger === "schedule") {
      scheduledToday.set(x.member_id, (scheduledToday.get(x.member_id) ?? 0) + 1);
      lastScheduledMs.set(x.member_id, Math.max(lastScheduledMs.get(x.member_id) ?? 0, new Date(x.started_at).getTime()));
    }
  }
  const backoff = new Map<string, number>();
  for (const [m, rows] of by) {
    const until = memberBackoffUntil(rows);
    if (until != null) backoff.set(m, until);
  }
  return { backoff, scheduledToday, lastScheduledMs };
}

/** 훑기가 못 읽은 판 — 처음 못 읽은 시각 · 횟수 · 404 수. 열쇠 = 워크스페이스 + 실행 id. 이 게이트웨이 메모리에만 있다(재기동하면 다시 센다). */
const sweepFails = new Map<string, { first: number; tries: number; notFound: number }>();

/**
 * 끝났는데 저장 단계를 못 탄 실행을 마저 처리한다 — T11 의 저장 단계는 지켜보기·상태 읽기에서만 돈다. 게이트웨이가 재기동하면 지켜보기가
 *  사라지고 아무도 상태를 안 읽으면 원문이 자료가 되지 않는다(as-built «남은 것»). 그런 실행을 상태 읽기(readCollectRun)로 다시 밟는다 —
 *  끝을 적고 · 저장 단계를 돌리고(한 실행에 한 번 — collect_run.ingest 차례 잡기) · 남은 세션을 지운다. 이틀 지난 실행은 보지 않는다.
 *  아직 도는 판(끝 기록 없음 · 그 판의 마감 전)은 건드리지 않는다 — 마감이 지난 판은 지켜보던 게이트웨이가 사라졌다고 보고 읽는다(아직 안
 *  끝났으면 상태 읽기는 아무것도 안 바꾼다). 못 읽는 판은 «폴더 없음(404) 두 번» 이거나 «처음 실패 뒤 한 시간 · 세 번 넘게 실패» 일 때만
 *  닫는다 — 중계가 잠깐 끊긴 것으로 이미 비용을 낸 원문을 버리지 않게(리뷰 2026-10-17). 닫을 때 그 판이 건 단위 임대도 푼다.
 */
async function sweepUningested(read: (member: string, runId: string) => Promise<unknown>, now: number): Promise<number> {
  const r = await itemsPool.query(
    `SELECT run_id, member_id FROM collect_run
      WHERE mode IN ('listing','collect') AND started_at > now() - interval '2 days'
        AND (ingest IS NULL OR (ingest->>'state' = 'running' AND (ingest->>'at')::timestamptz < now() - make_interval(mins => $3::int)))
        AND (outcome IS NOT NULL OR COALESCE(deadline_at, started_at + make_interval(secs => $1::int)) < now())
      ORDER BY started_at LIMIT $2`, [RUN_ALIVE_SEC, SWEEP_PER_TICK, INGEST_STALE_MIN]);
  let n = 0;
  for (const x of r.rows as Array<{ run_id: string; member_id: string }>) {
    const runId = String(x.run_id);
    const k = mkey(runId);
    try {
      await read(String(x.member_id), runId);
      sweepFails.delete(k);
      n++;
    } catch (e) {
      const status = Number((e as { status?: unknown })?.status);
      const f = sweepFails.get(k) ?? { first: now, tries: 0, notFound: 0 };
      f.tries++;
      if (status === 404) f.notFound++;
      sweepFails.set(k, f);
      //  실행 폴더가 없다(사흘 지나 치워졌다 · 그 사람 홈이 없다) — 두 번 확인하면 닫는다. 그 밖의 실패는 한 시간 넘게 · 세 번 넘게.
      //   원문을 다시 읽을 길이 없으니 «저장 단계 실패» 로 닫아 다음 틱이 같은 판을 다시 집지 않게 한다(실패율 지표에도 보인다).
      const close = f.notFound >= 2 ? "실행 폴더가 없어 원문을 읽을 수 없다"
        : f.tries >= SWEEP_MIN_TRIES && now - f.first >= SWEEP_CLOSE_AFTER_MS ? `상태를 ${f.tries}번(${Math.round((now - f.first) / 60_000)}분) 읽지 못했다` : null;
      if (close) {
        await closeUnreadable(runId, close);
        sweepFails.delete(k);
      }
      logger.warn({ runId, status: Number.isFinite(status) ? status : null, tries: f.tries, err: (e as Error)?.message },
        "[collect-schedule] 끝난 실행을 마저 처리하지 못했다 — 다음 틱에 다시 본다(오래 못 읽으면 닫는다)");
    }
  }
  if (sweepFails.size > 500) sweepFails.delete(sweepFails.keys().next().value as string);
  return n;
}

/** 원문을 다시 읽을 길이 없는 실행을 닫는다 — 저장 단계 «실패» · 끝 기록이 없으면 «잃음»(게이트웨이 추정) · 그 판이 건 단위 임대를 푼다. 던지지 않는다. */
async function closeUnreadable(runId: string, why: string): Promise<void> {
  await releaseRunLeases(runId);
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
export function _resetCollectScheduleForTest(): void { lastTickAt.clear(); ticking.clear(); startFails.clear(); sweepFails.clear(); capped.clear(); }

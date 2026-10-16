// 수집 단위의 다음 확인 시각 쓰기(#4213 T12 #4744) — 저장 단계가 단위마다 부르는 noteUnitRead 와, 수집 실행이 실을 단위를 붙잡아 두는 leaseUnits.
//  판정은 schedule-plan.ts(순수). 틱(collect-schedule.ts)과 따로 둔 까닭: 저장 단계(run-ingest)가 틱 모듈에 기대지 않게(리뷰 2026-10-17 —
//  틱은 수집 실행 모듈을 부른다).
//
//  ── 임대(lease) ──
//   수집 실행이 뜨면 그 판에 실은 단위의 다음 확인 시각을 «가장 긴 상한 뒤» 로 붙잡는다(sched.lease = 그 판). 저장 단계가 판정으로 덮어쓰고,
//   저장을 못 탄 판이면 임대가 끝나 저절로 다시 때가 된다. 그래서 직전 판의 저장 단계가 아직 도는 동안 틱이 같은 단위로 판을 또 띄우지 않는다
//   (리뷰 2026-10-17 — 끝난 판은 «도는 중» 에서 빠지는데 단위는 저장이 끝나야 다음 확인 시각이 옮겨진다).
//  ── 지금 담당만 ──
//   다음 확인 시각 · 실패 수 · 주기 · 활동량은 **지금 담당의 판**만 쓴다(T10 «읽은 위치는 지금 담당만» 과 같은 규칙). 담당이 바뀐 뒤 늦게 끝난
//   옛 담당의 판은 아무것도 안 쓰고, 그 판이 건 임대만 풀어 새 담당이 곧바로 이어받게 한다.
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { canAdvanceCursor } from "./unit-plan.js";
import { getUnit, planUnits } from "./unit-store.js";
import {
  RUN_ALIVE_SEC, activityOf, addSample, effectiveIntervalSec, nextCheck, type NextWhy, type ReadNote,
} from "./schedule-plan.js";

export interface UnitReadBy {
  /** 그 판의 주인 — 지금 담당이 아니면 쓰지 않는다. 비우면 확인하지 않는다(시험·내부). */
  member?: string | null;
  /** 그 판의 실행 id — 이 판이 건 임대를 알아본다. */
  runId?: string | null;
}

/**
 * 한 단위를 이번 판이 어떻게 읽었나를 적는다 — 표본 · 주기(자동일 때) · 다음 확인 시각 · 연속 실패 수 · 활동량(meta.activity — 리브·현황판이 본다).
 *  **던지지 않는다**(저장 단계의 나머지를 막지 않는다 — 못 적으면 그 단위는 임대가 끝난 뒤 다시 때가 되고, 구성원 물러서기가 헛돌기를 막는다).
 *  단위 행을 FOR UPDATE 로 잡고, 잡은 뒤의 행으로 담당을 판정해 계산하고 쓴다(같은 단위의 두 판이 겹쳐도 표본이 사라지지 않게).
 */
export async function noteUnitRead(unitId: number, note: ReadNote & { now?: number }, by: UnitReadBy = {}):
  Promise<{ next_at: string; why: NextWhy; interval_sec: number } | null> {
  const nowMs = note.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  let client: pg.PoolClient | null = null;
  try {
    client = await itemsPool.connect();
    await client.query("BEGIN");
    const r = await client.query(`SELECT interval_sec, interval_auto, sched FROM collect_unit WHERE id = $1 FOR UPDATE`, [unitId]);
    const row = r.rows[0] as { interval_sec: number | null; interval_auto: boolean; sched: Record<string, unknown> | null } | undefined;
    if (!row) { await client.query("ROLLBACK"); return null; }
    const sched = row.sched && typeof row.sched === "object" && !Array.isArray(row.sched) ? row.sched : {};
    const lease = sched.lease && typeof sched.lease === "object" ? sched.lease as Record<string, unknown> : null;
    if (by.member) {
      const u = await getUnit(unitId, client);
      const plan = u ? (await planUnits([u], client, nowMs)).plans.get(unitId) : undefined;
      if (!plan || !canAdvanceCursor(plan, { member: by.member })) {
        //  지금 담당이 아니다 — 아무것도 안 쓴다. 이 판이 건 임대만 풀어 새 담당이 곧바로 이어받게 한다.
        if (by.runId && lease?.run === by.runId) {
          await client.query(`UPDATE collect_unit SET next_at = now(), sched = sched - 'lease' WHERE id = $1`, [unitId]);
        }
        await client.query("COMMIT");
        return null;
      }
    }
    const hist = addSample(sched.hist, note.sample ?? null, nowSec);
    const auto = row.interval_auto !== false;
    const interval = effectiveIntervalSec({ interval_sec: row.interval_sec, interval_auto: auto }, hist, nowSec);
    const verdict = nextCheck({
      nowSec, intervalSec: interval, outcome: note.outcome, behind: note.behind, shrunk: note.shrunk, stuck: note.stuck,
      fails: Number.isFinite(Number(sched.fails)) ? Number(sched.fails) : 0,
    });
    const act = activityOf(hist, nowSec);
    const activity = {
      per_day: act.perDay == null ? null : Math.round(act.perDay * 100) / 100,
      observed_days: Math.round((act.observedSec / 86400) * 10) / 10,
      measured_at: new Date(nowMs).toISOString(),
    };
    const nextAt = new Date(verdict.nextSec * 1000).toISOString();
    //  sched 는 통째로 다시 쓴다 — 이 판이 건 임대(lease)는 이 판정이 대신한다.
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
    if (client) await client.query("ROLLBACK").catch(() => {});
    logger.warn({ unitId, err: (e as Error)?.message }, "[collect-schedule] 다음 확인 시각을 못 적었다 — 임대가 끝나면 다시 때가 된다");
    return null;
  } finally {
    client?.release();
  }
}

/**
 * 수집 실행이 실은 단위를 붙잡는다 — 다음 확인 시각을 «지금 + 가장 긴 상한»(이미 더 뒤면 그대로)으로, sched.lease 에 그 판을 적는다.
 *  저장 단계(noteUnitRead)가 판정으로 덮어쓴다. **던지지 않는다**(못 붙잡아도 실행은 그대로 — 틱의 «도는 사람» 판정이 겹 방어다).
 */
export async function leaseUnits(unitIds: readonly number[], runId: string, nowMs = Date.now()): Promise<number> {
  const ids = [...new Set(unitIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !runId) return 0;
  const until = new Date(nowMs + RUN_ALIVE_SEC * 1000).toISOString();
  try {
    const r = await itemsPool.query(
      `UPDATE collect_unit SET
          next_at = GREATEST(COALESCE(next_at, '-infinity'::timestamptz), $3::timestamptz),
          sched = sched || jsonb_build_object('lease', jsonb_build_object('run', $2::text, 'until', $3::text))
        WHERE id = ANY($1::int[])`, [ids, runId, until]);
    return r.rowCount ?? 0;
  } catch (e) {
    logger.warn({ runId, err: (e as Error)?.message }, "[collect-schedule] 수집 실행이 실은 단위를 못 붙잡았다 — 실행은 그대로");
    return 0;
  }
}

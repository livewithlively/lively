// 수집 실행 기록(#4213 T11) — collect_run 표 읽기·쓰기. 분류·지표·통계 셈은 run-outcome.ts(순수)가 한다.
//
//  · 시작(recordRunStart) — 실행을 띄운 직후 한 줄. 그때의 크기(상한·예약)를 같이 적는다(나중에 크기를 바꿔도 그 판이 어떤
//    상한에서 돌았는지 남는다).
//  · 끝(recordRunEnd) — 러너의 끝 신호(exit.json)를 읽었거나, 게이트웨이가 끝을 추정했을 때(끝 신호 없이 판이 사라짐 · 상한 초과).
//    같은 판의 끝은 **처음 것이 남는다**. 단 게이트웨이 추정 뒤에 러너 끝이 오면 러너 것으로 바꾼다(더 정확하다). 그 반대는 없다.
//  · 기록은 실행을 막지 않는다 — 둘 다 **던지지 않는다**(DB 가 죽어도 수집 실행·세션 정리는 그대로 간다).
//  · 원문·결과 문장은 싣지 않는다. 결과 문장은 수집한 내용을 담을 수 있다(그 사람 홈의 실행 폴더에만 있다).
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";
import { currentTenant } from "../tenant-context.js";
import { classifyRunOutcome, runMetricsOf, summarizeRuns, type RunOutcome, type RunStatRow, type RunStats } from "./run-outcome.js";

/** 보관 — 90일 지난 실행은 지운다(지표 화면은 30일까지 본다). */
export const COLLECT_RUN_KEEP_DAYS = 90;
/** 한 번에 통계로 읽는 줄 상한 — 넘으면 최근 것부터 이만큼만 센다(truncated 로 알린다). */
const MAX_STAT_ROWS = 20_000;

const purgedAt = new Map<string, number>();
/** 오래된 행 지우기 — 테넌트마다 한 시간에 한 번만(시작 기록에 얹혀 돈다). */
async function purgeOld(now: number): Promise<void> {
  const k = currentTenant()?.id ?? " solo";
  if (now - (purgedAt.get(k) ?? 0) < 3600_000) return;
  purgedAt.set(k, now);
  await itemsPool.query(`DELETE FROM collect_run WHERE started_at < $1`, [new Date(now - COLLECT_RUN_KEEP_DAYS * 86400_000)]);
}

export async function recordRunStart(input: {
  runId: string; member: string; apps: readonly string[]; model: string | null;
  capMb: number | null; requestMb: number | null; startedAt: Date; now?: number;
}): Promise<void> {
  try {
    await itemsPool.query(
      `INSERT INTO collect_run(run_id, member_id, started_at, apps, model, cap_mb, request_mb)
       VALUES($1,$2,$3,$4::text[],$5,$6,$7)
       ON CONFLICT (tenant_id, run_id) DO NOTHING`,
      [input.runId, input.member, input.startedAt, [...input.apps], input.model, input.capMb, input.requestMb]);
    await purgeOld(input.now ?? Date.now());
  } catch (e) {
    logger.warn({ runId: input.runId, err: (e as Error)?.message }, "[collect-run] 시작 기록 실패 — 실행은 그대로");
  }
}

/**
 * 끝 기록. by = 누가 끝을 적었나 — runner(러너의 exit.json) · gateway(게이트웨이가 추정해 적은 exit: 끝 신호 없음 · 판이 사라짐).
 *  시작 행이 없으면(시작 기록이 실패했거나 기록 전 판) 여기서 만든다 — 시작 시각은 호출부가 실행 id 에서 읽어 준다.
 */
export async function recordRunEnd(input: {
  runId: string; member: string; exit: Record<string, unknown> | null; summary: Record<string, unknown> | null;
  by: "runner" | "gateway"; startedAt: Date | null; now?: number;
}): Promise<{ outcome: RunOutcome } | null> {
  const v = classifyRunOutcome(input.exit, input.summary);
  if (!v) return null;
  try {
    const m = runMetricsOf(input.exit, input.summary);
    const nowMs = input.now ?? Date.now();
    const endRaw = typeof input.exit?.endedAt === "string" ? new Date(input.exit.endedAt) : null;
    const endedAt = endRaw && Number.isFinite(endRaw.getTime()) ? endRaw : new Date(nowMs);
    const apps = Array.isArray(input.summary?.apps) ? (input.summary!.apps as unknown[]).filter((a): a is string => typeof a === "string") : [];
    const r = await itemsPool.query(
      `INSERT INTO collect_run(run_id, member_id, started_at, apps, outcome, error, ended_by, ended_at,
                               mem_limit_mb, mem_start_mb, mem_peak_mb, duration_ms, cost_usd, turns, tool_calls, tool_errors, captures, updated_at)
       VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (tenant_id, run_id) DO UPDATE SET
         outcome=EXCLUDED.outcome, error=EXCLUDED.error, ended_by=EXCLUDED.ended_by, ended_at=EXCLUDED.ended_at,
         mem_limit_mb=EXCLUDED.mem_limit_mb, mem_start_mb=EXCLUDED.mem_start_mb, mem_peak_mb=EXCLUDED.mem_peak_mb,
         duration_ms=EXCLUDED.duration_ms, cost_usd=EXCLUDED.cost_usd, turns=EXCLUDED.turns,
         tool_calls=EXCLUDED.tool_calls, tool_errors=EXCLUDED.tool_errors, captures=EXCLUDED.captures, updated_at=now(),
         apps = CASE WHEN cardinality(collect_run.apps) = 0 THEN EXCLUDED.apps ELSE collect_run.apps END
       WHERE collect_run.outcome IS NULL OR (collect_run.ended_by = 'gateway' AND EXCLUDED.ended_by = 'runner')
       RETURNING outcome`,
      [input.runId, input.member, input.startedAt ?? endedAt, apps, v.outcome, v.error, input.by, endedAt,
       m.mem_limit_mb, m.mem_start_mb, m.mem_peak_mb, m.duration_ms, m.cost_usd, m.turns, m.tool_calls, m.tool_errors, m.captures]);
    return r.rowCount ? { outcome: v.outcome } : null;
  } catch (e) {
    logger.warn({ runId: input.runId, err: (e as Error)?.message }, "[collect-run] 끝 기록 실패 — 실행 정리는 그대로");
    return null;
  }
}

export interface CollectRunListRow {
  run_id: string; member_id: string; member_name: string | null; started_at: string; ended_at: string | null;
  apps: string[]; model: string | null; cap_mb: number | null; request_mb: number | null;
  outcome: RunOutcome | null; error: string | null; ended_by: string | null;
  mem_limit_mb: number | null; mem_start_mb: number | null; mem_peak_mb: number | null;
  duration_ms: number | null; cost_usd: number | null; turns: number | null;
  tool_calls: number | null; tool_errors: number | null; captures: number | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** 기간 안 실행들의 통계 + 최근 실행 목록. 창은 since ~ until(호출부가 31일 안으로 자른다). */
export async function collectRunStats(input: { since: Date; until: Date; tz: string; recent?: number }): Promise<{
  stats: RunStats; recent: CollectRunListRow[]; truncated: boolean;
}> {
  const r = await itemsPool.query(
    `SELECT r.run_id, r.member_id, CASE WHEN m.use_nickname AND COALESCE(m.nickname, '') <> '' THEN m.nickname ELSE m.display_name END AS member_name,
            r.started_at, r.ended_at, r.apps, r.model, r.cap_mb, r.request_mb, r.outcome, r.error, r.ended_by,
            r.mem_limit_mb, r.mem_start_mb, r.mem_peak_mb, r.duration_ms, r.cost_usd, r.turns, r.tool_calls, r.tool_errors, r.captures
       FROM collect_run r LEFT JOIN org_member m ON m.id = r.member_id AND m.tenant_id = r.tenant_id
      WHERE r.started_at >= $1 AND r.started_at < $2
      ORDER BY r.started_at DESC
      LIMIT ${MAX_STAT_ROWS + 1}`, [input.since, input.until]);
  const all = r.rows as Array<Record<string, unknown>>;
  const truncated = all.length > MAX_STAT_ROWS;
  const rows: CollectRunListRow[] = all.slice(0, MAX_STAT_ROWS).map((x) => ({
    run_id: String(x.run_id), member_id: String(x.member_id), member_name: (x.member_name as string | null) ?? null,
    started_at: new Date(x.started_at as string).toISOString(),
    ended_at: x.ended_at ? new Date(x.ended_at as string).toISOString() : null,
    apps: Array.isArray(x.apps) ? (x.apps as string[]) : [], model: (x.model as string | null) ?? null,
    cap_mb: num(x.cap_mb), request_mb: num(x.request_mb),
    outcome: (x.outcome as RunOutcome | null) ?? null, error: (x.error as string | null) ?? null, ended_by: (x.ended_by as string | null) ?? null,
    mem_limit_mb: num(x.mem_limit_mb), mem_start_mb: num(x.mem_start_mb), mem_peak_mb: num(x.mem_peak_mb),
    duration_ms: num(x.duration_ms), cost_usd: num(x.cost_usd), turns: num(x.turns),
    tool_calls: num(x.tool_calls), tool_errors: num(x.tool_errors), captures: num(x.captures),
  }));
  const statRows: RunStatRow[] = rows.map((x) => ({
    started_at: x.started_at, outcome: x.outcome, cap_mb: x.cap_mb, mem_limit_mb: x.mem_limit_mb, mem_peak_mb: x.mem_peak_mb,
    duration_ms: x.duration_ms, cost_usd: x.cost_usd, tool_calls: x.tool_calls, tool_errors: x.tool_errors,
  }));
  return { stats: summarizeRuns(statRows, { tz: input.tz }), recent: rows.slice(0, Math.max(0, input.recent ?? 50)), truncated };
}

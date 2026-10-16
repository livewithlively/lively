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

/** 앱 이름 목록 — 12개 · 64자까지(표면 입력과 같은 상한). 끝 기록의 앱은 그 사람 홈의 요약에서 온다. */
const appsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string").slice(0, 12).map((a) => a.slice(0, 64)) : []);

export async function recordRunStart(input: {
  runId: string; member: string; apps: readonly string[]; model: string | null;
  capMb: number | null; requestMb: number | null; startedAt: Date; now?: number;
  /** 실행 종류와 계획(저장 단계가 다시 읽는다 — 게이트웨이가 재기동해도). */
  mode?: string | null; plan?: unknown;
  /** #4744 이 판의 마감(실행 상한 + 유예) — 지켜보던 게이트웨이가 사라져도 «아직 도나» · «훑을 때가 됐나» 를 이 시각으로 가른다. */
  deadlineAt?: Date | null;
}): Promise<void> {
  try {
    await itemsPool.query(
      //  끝 기록이 먼저 행을 만들었으면(시작 기록이 늦은 판) 비어 있는 칸만 채운다 — 끝이 적은 결과·지표는 건드리지 않는다.
      `INSERT INTO collect_run(run_id, member_id, started_at, apps, model, cap_mb, request_mb, mode, plan, deadline_at)
       VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (tenant_id, run_id) DO UPDATE SET
         model = COALESCE(collect_run.model, EXCLUDED.model),
         cap_mb = COALESCE(collect_run.cap_mb, EXCLUDED.cap_mb), request_mb = COALESCE(collect_run.request_mb, EXCLUDED.request_mb),
         mode = COALESCE(collect_run.mode, EXCLUDED.mode), plan = COALESCE(collect_run.plan, EXCLUDED.plan),
         deadline_at = COALESCE(collect_run.deadline_at, EXCLUDED.deadline_at),
         apps = CASE WHEN cardinality(collect_run.apps) = 0 THEN EXCLUDED.apps ELSE collect_run.apps END`,
      [input.runId, input.member, input.startedAt, appsOf(input.apps), input.model, input.capMb, input.requestMb,
       input.mode ?? null, input.plan == null ? null : JSON.stringify(input.plan), input.deadlineAt ?? null]);
    await purgeOld(input.now ?? Date.now());
  } catch (e) {
    logger.warn({ runId: input.runId, err: (e as Error)?.message }, "[collect-run] 시작 기록 실패 — 실행은 그대로");
  }
}

const END_SQL = `INSERT INTO collect_run(run_id, member_id, started_at, apps, cap_mb, request_mb, mode, plan, outcome, error, ended_by, ended_at,
                               mem_limit_mb, mem_start_mb, mem_peak_mb, duration_ms, cost_usd, turns, tool_calls, tool_errors, captures, attempts, updated_at)
       VALUES($1,$2,$3,$4::text[],$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now())
       ON CONFLICT (tenant_id, run_id) DO UPDATE SET
         outcome=EXCLUDED.outcome, error=EXCLUDED.error, ended_by=EXCLUDED.ended_by, ended_at=EXCLUDED.ended_at,
         mem_limit_mb=EXCLUDED.mem_limit_mb, mem_start_mb=EXCLUDED.mem_start_mb, mem_peak_mb=EXCLUDED.mem_peak_mb,
         duration_ms=EXCLUDED.duration_ms, cost_usd=EXCLUDED.cost_usd, turns=EXCLUDED.turns,
         tool_calls=EXCLUDED.tool_calls, tool_errors=EXCLUDED.tool_errors, captures=EXCLUDED.captures, attempts=EXCLUDED.attempts, updated_at=now(),
         apps = CASE WHEN cardinality(collect_run.apps) = 0 THEN EXCLUDED.apps ELSE collect_run.apps END,
         cap_mb = COALESCE(collect_run.cap_mb, EXCLUDED.cap_mb), request_mb = COALESCE(collect_run.request_mb, EXCLUDED.request_mb),
         mode = COALESCE(collect_run.mode, EXCLUDED.mode), plan = COALESCE(collect_run.plan, EXCLUDED.plan)
       WHERE collect_run.outcome IS NULL OR (collect_run.ended_by = 'gateway' AND EXCLUDED.ended_by = 'runner')
       RETURNING outcome`;

/**
 * 끝 기록. by = 누가 끝을 적었나 — runner(러너의 exit.json) · gateway(게이트웨이가 추정해 적은 exit: 끝 신호 없음 · 판이 사라짐).
 *  시작 행이 없으면(시작 기록이 늦었거나 실패한 판) 여기서 만든다 — 시작 시각은 호출부가 실행 id 에서 읽어 주고, 크기도 같이 싣는다.
 *  돌려주는 값: 적었으면 {outcome} · 이미 끝이 적혀 있어 안 바꿨으면 null · 못 적었으면(DB 오류) "error"(호출부가 다시 시도할 수 있게).
 *  지표 칸 하나가 이상해 쓰기가 실패하면 지표를 비우고 한 번 더 쓴다 — 결과(성공·실패)만이라도 남아야 실패율이 맞는다.
 */
export async function recordRunEnd(input: {
  runId: string; member: string; exit: Record<string, unknown> | null; summary: Record<string, unknown> | null;
  by: "runner" | "gateway"; startedAt: Date | null; capMb?: number | null; requestMb?: number | null; now?: number;
  /** 시작 기록이 빠졌을 때를 위해 끝에도 싣는다(빈 칸만 채운다). */
  mode?: string | null; plan?: unknown;
}): Promise<{ outcome: RunOutcome } | null | "error"> {
  const v = classifyRunOutcome(input.exit, input.summary);
  if (!v) return null;
  const m = runMetricsOf(input.exit, input.summary);
  const nowMs = input.now ?? Date.now();
  const endRaw = typeof input.exit?.endedAt === "string" ? new Date(input.exit.endedAt) : null;
  const endedAt = endRaw && Number.isFinite(endRaw.getTime()) ? endRaw : new Date(nowMs);
  const head = [input.runId, input.member, input.startedAt ?? endedAt, appsOf(input.summary?.apps), input.capMb ?? null, input.requestMb ?? null,
    input.mode ?? null, input.plan == null ? null : JSON.stringify(input.plan),
    v.outcome, v.error == null ? null : v.error.slice(0, 300), input.by, endedAt];
  const metrics = [m.mem_limit_mb, m.mem_start_mb, m.mem_peak_mb, m.duration_ms, m.cost_usd, m.turns, m.tool_calls, m.tool_errors, m.captures, m.attempts];
  try {
    const r = await itemsPool.query(END_SQL, [...head, ...metrics]);
    return r.rowCount ? { outcome: v.outcome } : null;
  } catch (e) {
    logger.warn({ runId: input.runId, err: (e as Error)?.message }, "[collect-run] 끝 기록 실패 — 지표를 비우고 한 번 더");
    try {
      const r = await itemsPool.query(END_SQL, [...head, ...metrics.map(() => null)]);
      return r.rowCount ? { outcome: v.outcome } : null;
    } catch (e2) {
      logger.warn({ runId: input.runId, err: (e2 as Error)?.message }, "[collect-run] 끝 기록 실패 — 실행 정리는 그대로(다음 읽기가 다시 적는다)");
      return "error";
    }
  }
}

export interface CollectRunListRow {
  run_id: string; member_id: string; member_name: string | null; started_at: string; ended_at: string | null;
  apps: string[]; model: string | null; cap_mb: number | null; request_mb: number | null;
  outcome: RunOutcome | null; error: string | null; ended_by: string | null;
  mem_limit_mb: number | null; mem_start_mb: number | null; mem_peak_mb: number | null;
  duration_ms: number | null; cost_usd: number | null; turns: number | null;
  tool_calls: number | null; tool_errors: number | null; captures: number | null;
  mode: string | null; attempts: number | null;
  /** #4744 누가 띄웠나 — schedule = 기본 주기 틱 · null = 사람·리브가 직접. */
  trigger: string | null;
  /** 저장 단계 결과의 요약(목록·수집 실행만) — 화면은 수만 쓴다. */
  ingest: {
    state?: string; stored?: number; inserted?: number; units?: number; listed?: number; created?: number; refused?: number;
    unparsed?: number; failed?: number; incomplete?: number; unread?: number; stuck?: number; partial?: boolean; error?: string;
    proof_pending?: number; proof_passed?: number; proof_failed?: number; proof_held?: number;
  } | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** 구성원 이름 — 화면 규칙과 같다(닉네임을 쓰기로 켠 사람만 닉네임). 같은 id 가 여러 줄이면 첫 줄. 못 읽으면 빈 표(이름 대신 id). */
async function memberNames(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const r = await itemsPool.query(`SELECT id, display_name, nickname, use_nickname FROM org_member WHERE id = ANY($1::text[])`, [[...ids]]);
    for (const x of r.rows as Array<{ id: string; display_name: string | null; nickname: string | null; use_nickname: boolean | null }>) {
      if (out.has(x.id)) continue;
      const nick = String(x.nickname ?? "").trim();
      const name = x.use_nickname && nick ? nick : String(x.display_name ?? "").trim();
      if (name) out.set(x.id, name);
    }
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[collect-run] 구성원 이름을 못 읽었다 — id 로 보인다");
  }
  return out;
}

/**
 * 기간 안 실행들의 통계 + 최근 실행 목록. 창은 since ~ until(호출부가 31일 안으로 자른다).
 *  통계는 collect_run 만으로 센다(이름을 붙이려고 조인하면 한 사람이 여러 줄인 신원 표에서 실행이 겹쳐 셀 수 있다). 이름은 목록 몫만 따로 읽는다.
 */
export async function collectRunStats(input: { since: Date; until: Date; tz: string; recent?: number; now?: number }): Promise<{
  stats: RunStats; recent: CollectRunListRow[]; truncated: boolean;
}> {
  const r = await itemsPool.query(
    `SELECT run_id, member_id, started_at, ended_at, apps, model, cap_mb, request_mb, outcome, error, ended_by,
            mem_limit_mb, mem_start_mb, mem_peak_mb, duration_ms, cost_usd, turns, tool_calls, tool_errors, captures,
            mode, attempts, ingest, plan->>'trigger' AS trigger
       FROM collect_run
      WHERE started_at >= $1 AND started_at < $2
      ORDER BY started_at DESC
      LIMIT ${MAX_STAT_ROWS + 1}`, [input.since, input.until]);
  const all = r.rows as Array<Record<string, unknown>>;
  const truncated = all.length > MAX_STAT_ROWS;
  const rows: CollectRunListRow[] = all.slice(0, MAX_STAT_ROWS).map((x) => ({
    run_id: String(x.run_id), member_id: String(x.member_id), member_name: null,
    started_at: new Date(x.started_at as string).toISOString(),
    ended_at: x.ended_at ? new Date(x.ended_at as string).toISOString() : null,
    apps: Array.isArray(x.apps) ? (x.apps as string[]) : [], model: (x.model as string | null) ?? null,
    cap_mb: num(x.cap_mb), request_mb: num(x.request_mb),
    outcome: (x.outcome as RunOutcome | null) ?? null, error: (x.error as string | null) ?? null, ended_by: (x.ended_by as string | null) ?? null,
    mem_limit_mb: num(x.mem_limit_mb), mem_start_mb: num(x.mem_start_mb), mem_peak_mb: num(x.mem_peak_mb),
    duration_ms: num(x.duration_ms), cost_usd: num(x.cost_usd), turns: num(x.turns),
    tool_calls: num(x.tool_calls), tool_errors: num(x.tool_errors), captures: num(x.captures),
    mode: (x.mode as string | null) ?? null, attempts: num(x.attempts), ingest: ingestBrief(x.ingest),
    trigger: typeof x.trigger === "string" ? x.trigger : null,
  }));
  const statRows: RunStatRow[] = rows.map((x) => ({
    started_at: x.started_at, outcome: x.outcome, cap_mb: x.cap_mb, mem_limit_mb: x.mem_limit_mb, mem_peak_mb: x.mem_peak_mb,
    duration_ms: x.duration_ms, cost_usd: x.cost_usd, tool_calls: x.tool_calls, tool_errors: x.tool_errors, attempts: x.attempts,
  }));
  const recent = rows.slice(0, Math.max(0, input.recent ?? 50));
  const names = await memberNames([...new Set(recent.map((x) => x.member_id))]);
  for (const x of recent) x.member_name = names.get(x.member_id) ?? null;
  return { stats: summarizeRuns(statRows, { tz: input.tz, now: input.now }), recent, truncated };
}

/** 저장 결과 → 목록 한 줄의 요약(수만). */
function ingestBrief(v: unknown): CollectRunListRow["ingest"] {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return {
    state: typeof j.state === "string" ? j.state : undefined,
    stored: n(j.stored), inserted: n(j.inserted), units: n(j.units), listed: n(j.listed), created: n(j.created), refused: n(j.refused),
    unparsed: n(j.unparsed), failed: n(j.failed), incomplete: n(j.incomplete), unread: n(j.unread), stuck: n(j.stuck),
    proof_pending: n(j.proof_pending), proof_passed: n(j.proof_passed), proof_failed: n(j.proof_failed), proof_held: n(j.proof_held),
    partial: j.partial === true ? true : undefined,
    error: typeof j.error === "string" ? j.error.slice(0, 200) : undefined,
  };
}

// ── 저장 단계의 차례(#4213 T11) — 한 실행의 원문은 **한 번만** 자료로 넣는다 ─────────────────────────────

/** 저장 단계가 붙잡고 있다가 죽었으면(게이트웨이 재기동) 이만큼 뒤에 다시 잡을 수 있다. */
export const INGEST_STALE_MIN = 15;   // #4744 지속 수집 틱의 훑기·«도는 사람» 판정도 같은 값을 쓴다(collect-schedule)

/**
 * 이 실행의 저장 차례를 잡는다 — 목록·수집 실행이고 아직 안 했거나(붙잡은 채 오래됐으면) 잡고, 계획을 돌려준다. 이미 했으면 null.
 *  여러 게이트웨이·여러 읽기가 같은 실행을 동시에 봐도 한 곳만 넣는다(UPDATE … WHERE 한 문장).
 */
export async function claimIngest(runId: string, member: string): Promise<{ member: string; mode: string; plan: unknown } | null> {
  //  그 실행의 주인만 잡는다 — 원문은 부르는 사람의 홈에서 읽으므로, 남의 실행 id 로 내 홈의 원문을 그 사람 실행으로 넣지 못하게.
  const r = await itemsPool.query(
    `UPDATE collect_run SET ingest = jsonb_build_object('state','running','at',now()), updated_at = now()
      WHERE run_id = $1 AND member_id = $2 AND mode IN ('listing','collect')
        AND (ingest IS NULL OR (ingest->>'state' = 'running' AND (ingest->>'at')::timestamptz < now() - interval '${INGEST_STALE_MIN} minutes'))
      RETURNING member_id, mode, plan`, [runId, member]);
  const row = r.rows[0] as { member_id: string; mode: string; plan: unknown } | undefined;
  return row ? { member: row.member_id, mode: row.mode, plan: row.plan } : null;
}

/** 저장 결과를 남긴다(state: done · failed). 실패도 남긴다 — 같은 원문을 끝없이 다시 넣지 않게(다시 하려면 다음 판이 읽는다). */
export async function finishIngest(runId: string, result: Record<string, unknown>): Promise<void> {
  await itemsPool.query(
    `UPDATE collect_run SET ingest = $2::jsonb || jsonb_build_object('at', now()), updated_at = now() WHERE run_id = $1`,
    [runId, JSON.stringify(result)]);
}

/** 한 실행의 저장 결과(상태 조회가 싣는다). 없으면 null. */
export async function getRunIngest(runId: string): Promise<Record<string, unknown> | null> {
  const r = await itemsPool.query(`SELECT mode, ingest FROM collect_run WHERE run_id = $1`, [runId]);
  const row = r.rows[0] as { mode: string | null; ingest: Record<string, unknown> | null } | undefined;
  return row ? { mode: row.mode, ...(row.ingest ?? {}) } : null;
}

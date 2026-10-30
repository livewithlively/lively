// 앱 AI 실행 행(org_app_ai_run) · 프록시 계측(org_app_llm_call) · 워크스페이스 설정 칸 — 읽고 쓰기만 한다 (#4488 앱 v2-9).
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다. 상태를 바꾸는 쓰기는 «지금 상태가 이것일 때만» 조건을 단다(청/녹 두 슬롯 · 정비가 겹쳐도 한 번만).
import type pg from "pg";
import { itemsPool, withTx } from "../db/client.js";
import type { AiAccountSettings, AiRunStatus, Executor, ResumeLink, RunKind } from "./plan.js";

export interface AiRunRow {
  id: number;
  status: AiRunStatus;
  app_id: string;
  requester: string;
  requester_kind: "member" | "app_server";
  source: string | null;
  job_name: string | null;
  kind: RunKind;
  account_kind: "api_key" | "subscription";
  account_member: string | null;
  executor: Executor;
  job_id: number | null;
  model: string | null;
  label: string | null;
  prompt: string;
  system_prompt: string | null;
  schema: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  session_note: string | null;
  proxy_token_hash: string | null;
  retries: number;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  updated_at: Date;
}

const COLS = `id, status, app_id, requester, requester_kind, source, job_name, kind, account_kind, account_member, executor, job_id, model, label, prompt,
  system_prompt, schema, result, error, session_note, proxy_token_hash, retries, input_tokens, output_tokens, created_at, started_at, ended_at, updated_at`;

const norm = (r: Record<string, unknown> | undefined): AiRunRow | null =>
  r ? ({ ...r, id: Number(r.id), job_id: r.job_id == null ? null : Number(r.job_id) } as unknown as AiRunRow) : null;

export interface NewAiRun {
  appId: string; requester: string; requesterKind: "member" | "app_server"; source: string | null; jobName: string | null;
  kind: RunKind; accountKind: "api_key" | "subscription"; accountMember: string | null; executor: Executor;
  model: string | null; label: string | null; prompt: string; systemPrompt: string | null; schema: Record<string, unknown> | null;
  /** 프록시 실행은 곧바로 running(기다리는 줄이 없다) · 작업 실행은 queued(작업 행이 자리를 받으면 running). */
  status: "queued" | "running";
  /**
   * #5081 공용 시트로 도는 실행 — 시트 계정(구독 주인)의 «내 실행» 이 아니다(service.isOwnRun). 필수다 — 접수하는 자리가 빠뜨리면 물은 사람의
   *  지시 · 답이 시트 계정에게 보인다. 실행 행에 남긴다(RUN_SHARED_SEAT_COL 머리말 — 작업 행이 없거나 지워져도 그대로 남게).
   */
  sharedSeat: boolean;
  /** #5101 이어받은 실행이면 그 줄(어느 실행 · 처음 실행 · 몇 번째 · 까닭) — 없으면(새 질문) 생략 · null. RUN_RESUME_COLS 머리말(롤 창). */
  resume?: ResumeLink | null;
}

/** 실행 행 하나를 넣는 SQL(insertAiRun · insertResumedAiRun 이 같은 글을 쓴다). */
function insertRunSql(n: NewAiRun): { sql: string; args: unknown[] } {
  //  #5081 shared_seat 칸은 공용 시트 실행일 때만 적는다 — RUN_SHARED_SEAT_COL 머리말(롤 창에서 다른 실행의 접수가 «없는 칸» 으로 깨지지 않게).
  //  #5101 이어받기 칸 넷도 같은 까닭으로 이어받은 실행일 때만 적는다(RUN_RESUME_COLS 머리말).
  const shared = n.sharedSeat === true;
  const rs = n.resume ?? null;
  const extraCols = `${shared ? `, ${RUN_SHARED_SEAT_COL}` : ""}${rs ? `, ${RUN_RESUME_COLS.join(", ")}` : ""}`;
  const extraVals = `${shared ? ", true" : ""}${rs ? ", $16, $17, $18, $19" : ""}`;
  return {
    sql: `INSERT INTO org_app_ai_run(status, app_id, requester, requester_kind, source, job_name, kind, account_kind, account_member, executor, model, label, prompt,
                                system_prompt, schema, started_at${extraCols})
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $1='running' THEN now() ELSE NULL END${extraVals}) RETURNING ${COLS}`,
    args: [n.status, n.appId, n.requester, n.requesterKind, n.source, n.jobName, n.kind, n.accountKind, n.accountMember, n.executor, n.model, n.label, n.prompt,
      n.systemPrompt, n.schema ? JSON.stringify(n.schema) : null, ...(rs ? [rs.of, rs.root, rs.depth, rs.reason] : [])],
  };
}

export async function insertAiRun(n: NewAiRun): Promise<AiRunRow> {
  const { sql, args } = insertRunSql(n);
  const r = await itemsPool.query(sql, args);
  return norm(r.rows[0])!;
}

/**
 * #5101 이어받기 칸(org_app_ai_run.resume_of · resume_root · resume_depth · resume_reason)도 COLS 에 넣지 않고 따로 읽는다 — RUN_SHARED_SEAT_COL 과
 *  같은 까닭(롤 창: 새 게이트웨이가 공용 DB 마이그레이션보다 먼저 받는다). 이어받은 실행을 넣을 때만 적고(insertAiRun), 읽을 때 칸이 아직 없으면(42703)
 *  «이어받은 실행이 아니다» 다 — 칸이 없으면 그 칸을 단 행도 없다. ★ 롤 창에 이어받기를 보내면 «없는 칸» 으로 접수가 실패한다 — 부르는 쪽
 *  (service.submitRun)이 503 으로 다시 보내라고 한다.
 */
export const RUN_RESUME_COLS = ["resume_of", "resume_root", "resume_depth", "resume_reason"] as const;
const isUndefinedColumn = (e: unknown): boolean => (e as { code?: string })?.code === "42703";

/** 이 실행이 이어받은 줄 — 새 질문(처음 실행)이면 null. */
export async function aiRunResumeLink(id: number): Promise<ResumeLink | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  try {
    const r = await itemsPool.query(`SELECT resume_of, resume_root, resume_depth, resume_reason FROM org_app_ai_run WHERE id=$1`, [id]);
    const x = r.rows[0];
    if (!x || x.resume_of == null) return null;
    return { of: Number(x.resume_of), root: Number(x.resume_root ?? x.resume_of), depth: Number(x.resume_depth ?? 1), reason: (x.resume_reason as string | null) ?? null };
  } catch (e) {
    if (isUndefinedColumn(e)) return null;   // 마이그레이션 전(머리말)
    throw e;
  }
}

/**
 * 한 질문(처음 실행)을 이어받은 수를 세는 조건 — 갈래까지 다 센다. 띄우지도 못한 시도(작업 실행인데 작업 행 없이 실패 — 대기열이 참 · 작업 컨테이너가
 *  없는 배포)는 뺀다 — 한 번도 돌지 않은 시도가 앱의 다시 묻기 몫을 깎지 않게(격리 리뷰). 아직 작업을 달기 전인 열린 시도는 센다(동시에 보내도 넘지 않게).
 */
const RESUME_COUNTED = `resume_root=$1 AND NOT (executor='job' AND job_id IS NULL AND status='failed')`;

/** 한 질문(처음 실행 rootId)을 이어받은 수(RESUME_COUNTED) — 접수 전 미리 보기(plan.resumeRefusal). 끝을 막는 것은 insertResumedAiRun 이다. */
export async function resumeCountOfRoot(rootId: number): Promise<number> {
  try {
    const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_app_ai_run WHERE ${RESUME_COUNTED}`, [rootId]);
    return Number(r.rows[0]?.n ?? 0);
  } catch (e) {
    if (isUndefinedColumn(e)) return 0;   // 마이그레이션 전 — 칸이 없으면 이어받은 실행도 없다
    throw e;
  }
}

/**
 * 이어받은 실행을 넣는다 — 그 질문(root)의 잠금 안에서 세고(RESUME_COUNTED) 상한 아래일 때만 넣는다. 같은 질문을 동시에 여럿 이어도 상한을 넘지 않는다
 *  (세고 → 넣기가 따로면 동시에 보낸 만큼 다 받는다 — 격리 리뷰 실측 8/8). 상한에 닿았으면 { limit: 센 수 }.
 *  ⚠ 칸이 아직 없으면(롤 창) 42703 을 그대로 던진다 — 부르는 쪽이 503 으로 바꾼다.
 */
export async function insertResumedAiRun(n: NewAiRun & { resume: ResumeLink }, maxResumes: number): Promise<{ row: AiRunRow } | { limit: number }> {
  return withTx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('lvly-ai-resume:' || $1::text, 0))`, [String(n.resume.root)]);
    const counted = Number((await c.query(`SELECT count(*)::int AS n FROM org_app_ai_run WHERE ${RESUME_COUNTED}`, [n.resume.root])).rows[0]?.n ?? 0);
    if (counted >= maxResumes) return { limit: counted };
    const { sql, args } = insertRunSql(n);
    return { row: norm((await c.query(sql, args)).rows[0])! };
  });
}

export async function getAiRun(id: number): Promise<AiRunRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_ai_run WHERE id=$1`, [id]);
  return norm(r.rows[0]);
}

/**
 * #5081 공용 시트 표시(org_app_ai_run.shared_seat)는 COLS 에 넣지 않고 따로 읽는다(aiRunSharedSeat · listAiRuns).
 *  ★ 매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다(agent-jobs/store.SHARED_SEAT_COL 머리말과 같은 까닭) —
 *   COLS 에 새 칸을 넣으면 그 몇 분 동안 모든 실행 행 읽기 · 쓰기(RETURNING)가 «없는 칸» 으로 깨진다. 칸이 아직 없으면(42703) false 다 —
 *   칸이 없으면 그 칸을 단 행도 있을 수 없으니 그 답이 맞다.
 *  표시를 실행 행에 두는 까닭: 작업 행(org_agent_job.shared_seat)만 보면 작업 행이 없는 실행(접수 중 대기열이 차 실패 · 작업 컨테이너가 없는 배포)과
 *   보존 정리(#4828 — 끝난 작업 행을 90일 뒤 지운다)를 지난 실행에서 표시가 사라져, 시트 계정이 남의 지시 · 답을 다시 본다(격리 리뷰).
 */
export const RUN_SHARED_SEAT_COL = "shared_seat";
export async function aiRunSharedSeat(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1) return false;
  try {
    const r = await itemsPool.query(`SELECT ${RUN_SHARED_SEAT_COL} AS shared FROM org_app_ai_run WHERE id=$1`, [id]);
    return r.rows[0]?.shared === true;
  } catch (e) {
    if ((e as { code?: string })?.code === "42703") return false;   // undefined_column — 마이그레이션 전(머리말)
    throw e;
  }
}

/** 프록시 토큰(sha256) → 열린 실행 행. 끝난 실행의 토큰은 없는 토큰이다. */
export async function getAiRunByToken(tokenHash: string): Promise<AiRunRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_ai_run WHERE proxy_token_hash=$1 AND status IN ('queued','running')`, [tokenHash]);
  return norm(r.rows[0]);
}

/** 작업 행 id → 실행 행(한 작업엔 실행 하나 — 재시도 작업은 job_id 를 갈아 끼운다). */
export async function getAiRunByJob(jobId: number): Promise<AiRunRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_ai_run WHERE job_id=$1 ORDER BY id DESC LIMIT 1`, [jobId]);
  return norm(r.rows[0]);
}

export async function setAiRunJob(id: number, jobId: number): Promise<void> {
  await itemsPool.query(`UPDATE org_app_ai_run SET job_id=$2, updated_at=now() WHERE id=$1`, [id, jobId]);
}

export async function setAiRunProxyToken(id: number, tokenHash: string | null): Promise<void> {
  await itemsPool.query(`UPDATE org_app_ai_run SET proxy_token_hash=$2, updated_at=now() WHERE id=$1`, [id, tokenHash]);
}

/** 작업 행에서 읽은 상태를 반영한다(queued ↔ running 사이만 · 끝난 행은 건드리지 않는다). */
export async function markAiRunRunning(id: number): Promise<void> {
  await itemsPool.query(`UPDATE org_app_ai_run SET status='running', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 AND status='queued'`, [id]);
}

/** «형식에 맞게 다시» — 재시도 작업 행으로 갈아 끼우고 횟수를 센다(열린 실행만). */
export async function retryAiRun(id: number, newJobId: number | null): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_app_ai_run SET job_id=$2, retries=retries+1, updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id`, [id, newJobId]);
  return (r.rowCount ?? 0) > 0;
}

export interface FinishAiRun {
  status: "done" | "failed" | "canceled";
  result: Record<string, unknown> | null;
  error: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** 프록시 실행의 «형식에 맞게 다시» 횟수 — 작업 실행은 retryAiRun 이 센다. */
  retries?: number | null;
}
/** 한 번만 끝난다 — 열린 실행일 때만. 끝낸 행을 돌려준다(이미 끝났으면 null). */
export async function finishAiRun(id: number, f: FinishAiRun): Promise<AiRunRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_ai_run SET status=$2, result=$3::jsonb, error=$4, input_tokens=COALESCE($5, input_tokens), output_tokens=COALESCE($6, output_tokens),
            retries=COALESCE($7, retries), ended_at=now(), updated_at=now()
      WHERE id=$1 AND status IN ('queued','running') RETURNING ${COLS}`,
    [id, f.status, f.result ? JSON.stringify(f.result) : null, f.error, f.inputTokens ?? null, f.outputTokens ?? null, f.retries ?? null]);
  return norm(r.rows[0]);
}

/** 작업 컨테이너에 붙은 열린 실행(정비가 본다). */
export async function openJobRuns(limit = 500): Promise<AiRunRow[]> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_ai_run WHERE status IN ('queued','running') AND executor='job' ORDER BY id LIMIT $1`, [limit]);
  return r.rows.map((x) => norm(x)!);
}

/** 프록시 실행이 오래 열려 있다(게이트웨이가 죽어 끝맺음을 못 한 것) — 정비가 끝낸다. */
export async function staleProxyRuns(olderThanSec: number, limit = 200): Promise<AiRunRow[]> {
  const r = await itemsPool.query(
    `SELECT ${COLS} FROM org_app_ai_run WHERE status IN ('queued','running') AND executor='proxy' AND started_at < now() - make_interval(secs => $1) ORDER BY id LIMIT $2`,
    [olderThanSec, limit]);
  return r.rows.map((x) => norm(x)!);
}

/** 이 사람이 지금 열어 둔 실행 수(사람당 동시 상한). */
export async function openRunCountOf(requester: string): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_app_ai_run WHERE requester=$1 AND status IN ('queued','running')`, [requester]);
  return Number(r.rows[0]?.n ?? 0);
}

export interface AiRunListFilter { appId: string | null; requester: string | null; status: string | null; limit: number }
/** shared_seat = 공용 시트로 돈 실행인가(#5081 — 실행 행의 표시 · RUN_SHARED_SEAT_COL). 내 실행 판정(service.isOwnRun)이 쓴다. */
export type AiRunSummaryRow = Omit<AiRunRow, "prompt" | "result" | "schema" | "system_prompt" | "proxy_token_hash"> & { prompt_preview: string; has_result: boolean; shared_seat: boolean };
/**
 * 실행 목록 — requester 를 주면 «내 실행»(보낸 것 + 내 구독으로 도는 것 · 공용 시트로 돈 실행은 빼고 — service.isOwnRun 과 한 뜻).
 *  #5081 공용 시트 표시는 실행 행의 칸이다(RUN_SHARED_SEAT_COL). 그 칸이 아직 없으면(롤 창) 표시 없이 다시 읽는다 — 칸이 없으면 그 칸을 단 실행도 없다.
 */
export async function listAiRuns(f: AiRunListFilter): Promise<AiRunSummaryRow[]> {
  const sql = (seat: string): string =>
    `SELECT * FROM (
       SELECT r.id, r.status, r.app_id, r.requester, r.requester_kind, r.source, r.job_name, r.kind, r.account_kind, r.account_member, r.executor, r.job_id, r.model,
              r.label, left(regexp_replace(r.prompt, '\\s+', ' ', 'g'), 200) AS prompt_preview, (r.result IS NOT NULL) AS has_result, r.error, r.session_note, r.retries,
              r.input_tokens, r.output_tokens, r.created_at, r.started_at, r.ended_at, r.updated_at, ${seat} AS shared_seat
         FROM org_app_ai_run r
        WHERE ($1::text IS NULL OR r.app_id=$1) AND ($3::text IS NULL OR r.status=$3)
     ) x
      WHERE ($2::text IS NULL OR requester=$2 OR (account_kind='subscription' AND account_member=$2 AND NOT shared_seat))
      ORDER BY id DESC LIMIT $4`;
  const args = [f.appId, f.requester, f.status, f.limit];
  const r = await itemsPool.query(sql(`r.${RUN_SHARED_SEAT_COL}`), args).catch((e) => {
    if ((e as { code?: string })?.code === "42703") return itemsPool.query(sql("false"), args);   // undefined_column — 마이그레이션 전(머리말)
    throw e;
  });
  return r.rows.map((x) => ({ ...x, id: Number(x.id), job_id: x.job_id == null ? null : Number(x.job_id), shared_seat: x.shared_seat === true } as unknown as AiRunSummaryRow));
}

/** 이 앱이 만든 대화(이어받기용) — 끝난 작업 실행 중 대화 id 가 남은 것(작업 행 join). */
export async function appConversations(appId: string, requester: string, limit = 20): Promise<Array<{ run_id: number; job_id: number; conversation_id: string; label: string | null; ended_at: Date | null }>> {
  const r = await itemsPool.query(
    `SELECT r.id AS run_id, j.id AS job_id, j.conversation_id, r.label, r.ended_at
       FROM org_app_ai_run r JOIN org_agent_job j ON j.id = r.job_id
      WHERE r.app_id=$1 AND r.requester=$2 AND r.status='done' AND j.conversation_id IS NOT NULL
      ORDER BY r.id DESC LIMIT $3`, [appId, requester, limit]);
  return r.rows.map((x) => ({ run_id: Number(x.run_id), job_id: Number(x.job_id), conversation_id: String(x.conversation_id), label: (x.label as string | null) ?? null, ended_at: (x.ended_at as Date | null) ?? null }));
}

// ── 프록시 계측 ──
export interface NewLlmCall {
  appId: string; runId: number | null; caller: "run" | "run_token" | "app_server"; member: string | null; model: string | null; path: string; stream: boolean;
  status: number | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; durationMs: number | null; error: string | null;
}
export async function insertLlmCall(c: NewLlmCall): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_app_llm_call(app_id, run_id, caller, member, model, path, stream, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, duration_ms, error)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [c.appId, c.runId, c.caller, c.member, c.model, c.path.slice(0, 200), c.stream, c.status, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens, c.durationMs, c.error ? c.error.slice(0, 600) : null]);
}

/** 오늘(UTC) 이 앱이 프록시로 쓴 토큰(입력 + 출력 + 캐시 읽기·쓰기). */
export async function tokensUsedTodayByApp(appId: string): Promise<number> {
  const r = await itemsPool.query(
    `SELECT COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS n
       FROM org_app_llm_call WHERE app_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [appId]);
  return Number(r.rows[0]?.n ?? 0);
}

// ── 워크스페이스 설정 칸(org_runtime_config.app_ai_policy · app_ai_account) — 관리 도구만 쓴다(agent_job_policy 와 같은 꼴). 읽기 실패는 던진다. ──
export async function aiRunPolicyRow(): Promise<Record<string, unknown>> {
  const r = await itemsPool.query(`SELECT app_ai_policy FROM org_runtime_config WHERE id=1`);
  const row = r.rows[0]?.app_ai_policy;
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
}
export async function writeAiRunPolicyRow(next: Record<string, number>): Promise<void> {
  await itemsPool.query(`UPDATE org_runtime_config SET app_ai_policy=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
}
export async function aiAccountRow(): Promise<unknown> {
  const r = await itemsPool.query(`SELECT app_ai_account FROM org_runtime_config WHERE id=1`);
  return r.rows[0]?.app_ai_account ?? {};
}
/** 시험 준비용 — 칸을 통째로 덮는다. 제품 코드는 updateAiAccountRow 로 고친다(읽고 → 쓰기 사이를 잠근다). */
export async function writeAiAccountRow(next: unknown): Promise<void> {
  await itemsPool.query(`UPDATE org_runtime_config SET app_ai_account=$1::jsonb WHERE id=1`, [JSON.stringify(next ?? {})]);
}
/**
 * 설정 칸을 읽고 고쳐 쓴다 — 한 트랜잭션 · 행 잠금(FOR UPDATE)으로(#5081). 실행 계정 설정과 공용 시트 지정(관리자 승인 · 본인 동의)은 다른 사람이
 *  같은 칸을 거의 같이 고친다 — 읽고 → 쓰기 사이가 열려 있으면 한쪽 동의가 조용히 사라진다.
 *  fn 은 읽은 값과 그 트랜잭션(c — 감사를 audit(…, c) 로 같은 트랜잭션에 넣는다)을 받아 쓸 값을 돌려준다. next 가 null 이면 쓰지 않는다(바뀐 것 없음).
 *  ⚠ next 가 null 도 객체도 아니면(undefined 등) 던진다 — 빈 설정으로 덮으면 기본 실행 계정 · 앱별 설정 · 공용 시트의 두 동의가 한꺼번에 사라진다.
 *  던지면 아무것도 안 쓴다(감사도). 돌려주는 것: fn 이 돌려준 out.
 */
export async function updateAiAccountRow<T>(
  fn: (cur: unknown, c: pg.PoolClient) => { next: AiAccountSettings | null; out: T } | Promise<{ next: AiAccountSettings | null; out: T }>,
): Promise<T> {
  return withTx(async (c) => {
    const r = await c.query(`SELECT app_ai_account FROM org_runtime_config WHERE id=1 FOR UPDATE`);
    const { next, out } = await fn(r.rows[0]?.app_ai_account ?? {}, c);
    if (next === null) return out;
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("updateAiAccountRow: 쓸 설정(next)이 없습니다 — 바꾸지 않으려면 null 을 돌려주세요");
    await c.query(`UPDATE org_runtime_config SET app_ai_account=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
    return out;
  });
}

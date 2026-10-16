// 앱 AI 실행 행(org_app_ai_run) · 프록시 계측(org_app_llm_call) · 워크스페이스 설정 칸 — 읽고 쓰기만 한다 (#4488 앱 v2-9).
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다. 상태를 바꾸는 쓰기는 «지금 상태가 이것일 때만» 조건을 단다(청/녹 두 슬롯 · 정비가 겹쳐도 한 번만).
import { itemsPool } from "../db/client.js";
import type { AiRunStatus, Executor, RunKind } from "./plan.js";

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
}

export async function insertAiRun(n: NewAiRun): Promise<AiRunRow> {
  const r = await itemsPool.query(
    `INSERT INTO org_app_ai_run(status, app_id, requester, requester_kind, source, job_name, kind, account_kind, account_member, executor, model, label, prompt,
                                system_prompt, schema, started_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $1='running' THEN now() ELSE NULL END) RETURNING ${COLS}`,
    [n.status, n.appId, n.requester, n.requesterKind, n.source, n.jobName, n.kind, n.accountKind, n.accountMember, n.executor, n.model, n.label, n.prompt,
      n.systemPrompt, n.schema ? JSON.stringify(n.schema) : null]);
  return norm(r.rows[0])!;
}

export async function getAiRun(id: number): Promise<AiRunRow | null> {
  const r = await itemsPool.query(`SELECT ${COLS} FROM org_app_ai_run WHERE id=$1`, [id]);
  return norm(r.rows[0]);
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
}
/** 한 번만 끝난다 — 열린 실행일 때만. 끝낸 행을 돌려준다(이미 끝났으면 null). */
export async function finishAiRun(id: number, f: FinishAiRun): Promise<AiRunRow | null> {
  const r = await itemsPool.query(
    `UPDATE org_app_ai_run SET status=$2, result=$3::jsonb, error=$4, input_tokens=COALESCE($5, input_tokens), output_tokens=COALESCE($6, output_tokens),
            ended_at=now(), updated_at=now()
      WHERE id=$1 AND status IN ('queued','running') RETURNING ${COLS}`,
    [id, f.status, f.result ? JSON.stringify(f.result) : null, f.error, f.inputTokens ?? null, f.outputTokens ?? null]);
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
export type AiRunSummaryRow = Omit<AiRunRow, "prompt" | "result" | "schema" | "system_prompt" | "proxy_token_hash"> & { prompt_preview: string; has_result: boolean };
export async function listAiRuns(f: AiRunListFilter): Promise<AiRunSummaryRow[]> {
  const r = await itemsPool.query(
    `SELECT id, status, app_id, requester, requester_kind, source, job_name, kind, account_kind, account_member, executor, job_id, model, label,
            left(regexp_replace(prompt, '\\s+', ' ', 'g'), 200) AS prompt_preview, (result IS NOT NULL) AS has_result, error, session_note, retries,
            input_tokens, output_tokens, created_at, started_at, ended_at, updated_at
       FROM org_app_ai_run
      WHERE ($1::text IS NULL OR app_id=$1) AND ($2::text IS NULL OR requester=$2) AND ($3::text IS NULL OR status=$3)
      ORDER BY id DESC LIMIT $4`, [f.appId, f.requester, f.status, f.limit]);
  return r.rows.map((x) => ({ ...x, id: Number(x.id), job_id: x.job_id == null ? null : Number(x.job_id) } as unknown as AiRunSummaryRow));
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
export async function writeAiAccountRow(next: unknown): Promise<void> {
  await itemsPool.query(`UPDATE org_runtime_config SET app_ai_account=$1::jsonb WHERE id=1`, [JSON.stringify(next ?? {})]);
}

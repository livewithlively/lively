// 작업 컨테이너 작업 행(org_agent_job) — 읽고 쓰기만 한다 (#4490 앱 v2-11). 판정은 plan.ts, 흐름은 service.ts.
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다 — 판의 콜백도 그 테넌트의 mcp.sock 으로 오므로 남의 작업 행은 안 보인다.
//  상태를 바꾸는 쓰기는 전부 «지금 상태가 이것일 때만» 조건을 단다 — 청/녹 두 슬롯·감시·판 보고가 겹쳐도 한 번만 넘어간다.
import crypto from "node:crypto";
import { itemsPool, q, withTx } from "../db/client.js";
import { planClaims, type AgentJobStatus } from "./plan.js";
import type { AgentJobPolicy } from "../org/policies/agent-job-policy.js";

export interface AgentJobRow {
  id: number;
  status: AgentJobStatus;
  requester: string;
  account_kind: "subscription" | "api_key";
  account_member: string | null;
  app_id: string | null;
  project_id: number | null;
  cwd: string;
  harness: string;
  model: string | null;
  label: string | null;
  prompt: string;
  resume_conversation: string | null;
  resume_job_id: number | null;
  timeout_sec: number;
  session_id: string | null;
  boot_hash: string | null;
  secret_hash: string | null;
  mcp_token_hash: string | null;
  conversation_id: string | null;
  output_tail: string;
  result: Record<string, unknown> | null;
  exit_code: number | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: Date;
  claimed_at: Date | null;
  started_at: Date | null;
  last_tick_at: Date | null;
  ended_at: Date | null;
  reaped: boolean;
}

const COLS = `id, status, requester, account_kind, account_member, app_id, project_id, cwd, harness, model, label, prompt,
  resume_conversation, resume_job_id, timeout_sec, session_id, boot_hash, secret_hash, mcp_token_hash, conversation_id, output_tail,
  result, exit_code, error, cancel_requested, created_at, claimed_at, started_at, last_tick_at, ended_at, reaped`;

const norm = (r: Record<string, unknown> | undefined): AgentJobRow | null =>
  r ? ({
    ...r,
    id: Number(r.id),
    project_id: r.project_id == null ? null : Number(r.project_id),
    resume_job_id: r.resume_job_id == null ? null : Number(r.resume_job_id),
  } as unknown as AgentJobRow) : null;

// ── 비밀 — 판 첫 말(boot)의 일회용 비밀 · 콜백 비밀. DB 엔 sha256 만 둔다(로그인 판 #4067 과 같은 꼴). ──
export function newJobSecret(): { secret: string; hash: string } {
  const secret = crypto.randomBytes(32).toString("base64url");
  return { secret, hash: hashJobSecret(secret) };
}
export function hashJobSecret(secret: string): string {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}
/** (순수) 비밀 대조 — 상수시간. 해시가 비었거나 모양이 다르면 늘 false(부재를 «통과» 로 접지 않는다). */
export function secretMatches(hash: string | null | undefined, presented: string): boolean {
  const want = String(hash ?? "");
  if (!/^[0-9a-f]{64}$/.test(want) || !presented) return false;
  return crypto.timingSafeEqual(Buffer.from(hashJobSecret(presented), "hex"), Buffer.from(want, "hex"));
}

export interface NewAgentJob {
  requester: string;
  accountKind: "subscription" | "api_key";
  accountMember: string | null;
  appId: string | null;
  projectId: number | null;
  cwd: string;
  harness: string;
  model: string | null;
  label: string | null;
  prompt: string;
  resumeConversation: string | null;
  resumeJobId: number | null;
  timeoutSec: number;
}

/**
 * 접수 — 대기열이 차 있으면 넣지 않는다(null). 셈과 넣기를 같은 트랜잭션·같은 테넌트 잠금 안에서 한다(두 슬롯이 동시에 받아도 상한을 못 넘는다).
 *  max_queued 가 0 이면 «대기열 없음»: 자리가 지금 없으면 넣지 않는다.
 */
export async function insertAgentJob(j: NewAgentJob, p: Pick<AgentJobPolicy, "max_queued" | "max_running">): Promise<{ row: AgentJobRow } | { full: { queued: number; running: number } }> {
  return withTx(async (c) => {
    await lockTenantQueue(c);
    const cnt = await q(c, `SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
                                   count(*) FILTER (WHERE status IN ('starting','running'))::int AS running FROM org_agent_job`);
    const queued = Number(cnt[0]?.queued ?? 0), running = Number(cnt[0]?.running ?? 0);
    const room = p.max_queued > 0 ? queued < p.max_queued : running < p.max_running && queued === 0;
    if (!room) return { full: { queued, running } };
    const rows = await q(c,
      `INSERT INTO org_agent_job(requester, account_kind, account_member, app_id, project_id, cwd, harness, model, label, prompt,
                                 resume_conversation, resume_job_id, timeout_sec)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${COLS}`,
      [j.requester, j.accountKind, j.accountMember, j.appId, j.projectId, j.cwd, j.harness, j.model, j.label, j.prompt,
        j.resumeConversation, j.resumeJobId, j.timeoutSec]);
    return { row: norm(rows[0])! };
  });
}

/** 이 테넌트의 대기열 잠금(트랜잭션 끝에 풀린다) — 셈과 자리 주기를 한 줄로 세운다. 테넌트 GUC 가 없으면(단일 테넌트) 상수 열쇠. */
async function lockTenantQueue(c: Parameters<Parameters<typeof withTx>[0]>[0]): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('lvly-agent-job:' || COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '-'), 0))`);
}

/**
 * 자리 주기 — 지금 도는 것과 기다리는 것을 잠금 안에서 읽고(plan.planClaims), 고른 행을 starting 으로 넘기며 세션 id·부트 비밀을 단다.
 *  돌려주는 것: 넘긴 행과 그 행의 부트 비밀 원문(판을 띄울 때 env 로 한 번 넘긴다 — DB 엔 해시만).
 */
export async function claimAgentJobs(
  p: Pick<AgentJobPolicy, "max_running" | "max_running_per_member">,
  mint: (jobId: number) => { sessionId: string; boot: { secret: string; hash: string } },
): Promise<Array<{ row: AgentJobRow; bootSecret: string }>> {
  return withTx(async (c) => {
    await lockTenantQueue(c);
    const live = await q(c, `SELECT id, account_member FROM org_agent_job WHERE status IN ('starting','running')`);
    const queued = await q(c, `SELECT id, account_member FROM org_agent_job WHERE status='queued' AND NOT cancel_requested ORDER BY id LIMIT 200`);
    const pick = planClaims(
      live.map((r) => ({ id: Number(r.id), account_member: (r.account_member as string | null) ?? null })),
      queued.map((r) => ({ id: Number(r.id), account_member: (r.account_member as string | null) ?? null })),
      p,
    );
    const out: Array<{ row: AgentJobRow; bootSecret: string }> = [];
    for (const id of pick) {
      const m = mint(id);
      const rows = await q(c,
        `UPDATE org_agent_job SET status='starting', claimed_at=now(), session_id=$2, boot_hash=$3, updated_at=now()
          WHERE id=$1 AND status='queued' RETURNING ${COLS}`, [id, m.sessionId, m.boot.hash]);
      const row = norm(rows[0]);
      if (row) out.push({ row, bootSecret: m.boot.secret });
    }
    return out;
  });
}

export async function getAgentJob(id: number): Promise<AgentJobRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return norm((await q(itemsPool, `SELECT ${COLS} FROM org_agent_job WHERE id=$1`, [id]))[0]);
}

/**
 * 판의 첫 말 — 부트 비밀을 **지우며** 콜백 비밀 해시를 단다(한 번만 된다 · starting 일 때만). 지운 뒤의 행을 돌려준다.
 *  ⚠ 대조(secretMatches)는 부르는 쪽이 이 문장 **앞**에서 한다 — 여기선 «아직 starting 이고 부트 비밀이 남아 있나» 만 본다.
 */
export async function bootAgentJob(id: number, bootHash: string, secretHash: string): Promise<AgentJobRow | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET status='running', started_at=now(), last_tick_at=now(), boot_hash=NULL, secret_hash=$3, updated_at=now()
      WHERE id=$1 AND status='starting' AND boot_hash=$2 RETURNING ${COLS}`, [id, bootHash, secretHash]);
  return norm(rows[0]);
}

/** 판에 줄 라이블리 토큰의 해시를 단다(끝날 때 폐기한다). */
export async function setAgentJobMcpToken(id: number, tokenHash: string): Promise<void> {
  await q(itemsPool, `UPDATE org_agent_job SET mcp_token_hash=$2, updated_at=now() WHERE id=$1`, [id, tokenHash]);
}

/** 박동 — 진행 꼬리·대화 id 를 싣는다. 도는 작업에만. 돌려주는 것: 취소 요청 여부(행이 없거나 끝났으면 null). */
export async function tickAgentJob(id: number, o: { tail: string; conversationId: string | null }): Promise<{ cancel: boolean } | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET last_tick_at=now(), output_tail=$2, conversation_id=COALESCE($3, conversation_id), updated_at=now()
      WHERE id=$1 AND status='running' RETURNING cancel_requested`, [id, o.tail, o.conversationId]);
  return rows.length ? { cancel: rows[0].cancel_requested === true } : null;
}

/**
 * 끝내기 — 열린 작업(대기·띄우는 중·도는 중)일 때만 끝 상태로 넘긴다. 이미 끝났으면 false(두 번째 보고·감시가 겹친 것).
 *  결과·대화 id·진행 꼬리는 준 것만 덮는다.
 */
export async function finishAgentJob(id: number, o: {
  status: "done" | "failed" | "timeout" | "canceled";
  error?: string | null;
  result?: Record<string, unknown> | null;
  exitCode?: number | null;
  conversationId?: string | null;
  tail?: string | null;
  from?: readonly AgentJobStatus[];
}): Promise<AgentJobRow | null> {
  const from = (o.from ?? ["queued", "starting", "running"]) as string[];
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET status=$2, error=$3, result=COALESCE($4::jsonb, result), exit_code=COALESCE($5, exit_code),
            conversation_id=COALESCE($6, conversation_id), output_tail=COALESCE($7, output_tail),
            ended_at=now(), boot_hash=NULL, updated_at=now(),
            reaped = (session_id IS NULL AND mcp_token_hash IS NULL)
      WHERE id=$1 AND status = ANY($8::text[]) RETURNING ${COLS}`,
    [id, o.status, o.error ?? null, o.result ? JSON.stringify(o.result) : null, o.exitCode ?? null, o.conversationId ?? null, o.tail ?? null, from]);
  return norm(rows[0]);
}

/** 취소 요청 — 대기 중이면 감시(또는 바로 이어지는 sweep)가 끝내고, 도는 중이면 판의 다음 박동이 받아 하네스를 끊는다. */
export async function requestCancelAgentJob(id: number): Promise<AgentJobRow | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET cancel_requested=true, updated_at=now() WHERE id=$1 AND status IN ('queued','starting','running') RETURNING ${COLS}`, [id]);
  return norm(rows[0]);
}

/** 감시 대상 — 열린 작업과, 끝났지만 아직 걷지 않은 작업. */
export async function openAgentJobs(limit = 200): Promise<AgentJobRow[]> {
  const rows = await q(itemsPool,
    `SELECT ${COLS} FROM org_agent_job WHERE status IN ('queued','starting','running') OR reaped = false ORDER BY id LIMIT $1`, [limit]);
  return rows.map((r) => norm(r)!);
}

/** 걷기를 마쳤다(컨테이너 끄기 신호 · 토큰 폐기). */
export async function markAgentJobReaped(id: number): Promise<void> {
  await q(itemsPool, `UPDATE org_agent_job SET reaped=true, updated_at=now() WHERE id=$1 AND status IN ('done','failed','timeout','canceled')`, [id]);
}

export interface AgentJobListFilter { requester?: string | null; appId?: string | null; status?: string | null; limit: number }
export async function listAgentJobs(f: AgentJobListFilter): Promise<AgentJobRow[]> {
  const where: string[] = []; const args: unknown[] = [];
  if (f.requester) { args.push(f.requester); where.push(`requester=$${args.length}`); }
  if (f.appId) { args.push(f.appId); where.push(`app_id=$${args.length}`); }
  if (f.status) { args.push(f.status); where.push(`status=$${args.length}`); }
  args.push(f.limit);
  const rows = await q(itemsPool,
    `SELECT ${COLS} FROM org_agent_job ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${args.length}`, args);
  return rows.map((r) => norm(r)!);
}

/** 대기열에서 이 작업 앞에 몇 건이 있나(먼저 온 대기 작업 수). */
export async function queuePosition(id: number): Promise<number> {
  const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM org_agent_job WHERE status='queued' AND id < $1`, [id]);
  return Number(rows[0]?.n ?? 0);
}

// ── 워크스페이스 설정 칸(org_runtime_config.agent_job_policy) — 관리자 도구 agent_job_limits_set 만 쓴다(그 칸만 · 앱 판 상한과 같은 꼴). ──
export async function agentJobPolicyRow(): Promise<Record<string, unknown>> {
  const r = await itemsPool.query(`SELECT agent_job_policy FROM org_runtime_config WHERE id=1`).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const row = r.rows[0]?.agent_job_policy;
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
}
export async function writeAgentJobPolicyRow(next: Record<string, number>): Promise<void> {
  await itemsPool.query(`UPDATE org_runtime_config SET agent_job_policy=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
}

// 작업 컨테이너 작업 행(org_agent_job) — 읽고 쓰기만 한다 (#4490 앱 v2-11). 판정은 plan.ts, 흐름은 service.ts.
//  ⚠ 모든 조회는 요청 컨텍스트(RLS)의 테넌트로 좁혀진다 — 판의 콜백도 그 테넌트의 mcp.sock 으로 오므로 남의 작업 행은 안 보인다.
//  상태를 바꾸는 쓰기는 전부 «지금 상태가 이것일 때만» 조건을 단다 — 청/녹 두 슬롯·감시·판 보고가 겹쳐도 한 번만 넘어간다.
import crypto from "node:crypto";
import { itemsPool, q, withTx } from "../db/client.js";
import { planClaims, PRUNE_BATCH, type AgentJobStatus, type ClaimCandidate } from "./plan.js";
import { AGENT_JOB_POLICY_RANGE, type AgentJobPolicy } from "../org/policies/agent-job-policy.js";

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
  /** #4488 단발 실행 — 도구 없이(`--tools ""` · MCP 없음) 글만 받는다. */
  bare: boolean;
  /** #4891 사람 홈 없는 작업 컨테이너에서 도나(앱 서버가 보낸 API 키 에이전트 작업 — 작업 폴더는 앱 폴더뿐). */
  homeless: boolean;
  session_id: string | null;
  boot_hash: string | null;
  /** #4829 시작 실패 보고 비밀의 sha256 — 부트 비밀과 같은 값(자리 줄 때 단다) · 첫 박동이 지운다(그 전까지만 연다). */
  fail_hash: string | null;
  secret_hash: string | null;
  mcp_token_hash: string | null;
  conversation_id: string | null;
  output_tail: string;
  result: Record<string, unknown> | null;
  exit_code: number | null;
  error: string | null;
  cancel_requested: boolean;
  /** 사람이 아닌 쪽이 멈춘 사유(앱 동의를 거둠 등) — 취소로 끝날 때 오류 문장이 된다. */
  cancel_reason: string | null;
  /** 자리를 받은 횟수(띄우기 시도). */
  attempts: number;
  created_at: Date;
  claimed_at: Date | null;
  started_at: Date | null;
  last_tick_at: Date | null;
  ended_at: Date | null;
  reaped: boolean;
}

const COLS = `id, status, requester, account_kind, account_member, app_id, project_id, cwd, harness, model, label, prompt,
  resume_conversation, resume_job_id, timeout_sec, bare, homeless, session_id, boot_hash, fail_hash, secret_hash, mcp_token_hash, conversation_id, output_tail,
  result, exit_code, error, cancel_requested, cancel_reason, attempts, created_at, claimed_at, started_at, last_tick_at, ended_at, reaped`;

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
  /** 단발(도구 없음) — 없으면 false. */
  bare?: boolean;
  /**
   * #4891 사람 홈 없는 작업 컨테이너에서 돌린다 — 앱 서버가 보낸 API 키 에이전트 작업만(ai-runs/service). 작업 폴더는 앱 폴더여야 한다.
   *  필수다 — 접수하는 자리가 빠뜨리면 컴파일이 잡는다(빠지면 사람 홈에서 돈다).
   */
  homeless: boolean;
  /**
   * #5081 공용 시트로 도는 작업 — 자리(홈 · Claude 로그인)는 시트 계정(account_member), 작업 AI 의 라이블리 신원은 보낸 사람(requester).
   *  필수다(homeless 와 같은 까닭 — 빠지면 물은 사람의 작업이 시트 계정의 이름 · 권한으로 돈다).
   */
  sharedSeat: boolean;
  /**
   * #5082 앱 판 지시 — 판이 하네스 시스템 지시로 싣는 글(앱 AI 실행이 접수 때 읽어 준다). 있으면 작업 폴더의 지시 · 설정을 읽지 않는다
   *  (runner.claudeJobArgv). 없으면 null · 생략.
   */
  appInstructions?: string | null;
}

/**
 * 접수 — 대기열이 차 있으면 넣지 않는다(null). 셈과 넣기를 같은 트랜잭션·같은 테넌트 잠금 안에서 한다(두 슬롯이 동시에 받아도 상한을 못 넘는다).
 *  max_queued 가 0 이면 «대기열 없음»: 자리가 지금 없으면 넣지 않는다.
 */
export async function insertAgentJob(j: NewAgentJob, p: Pick<AgentJobPolicy, "max_queued" | "max_running">): Promise<{ row: AgentJobRow } | { full: { queued: number; running: number } }> {
  return withTx(async (c) => {
    await lockTenantQueue(c);
    //  WHERE 로 열린 작업만 센다 — 끝난 작업이 보존 기간(#4828 keep_days)만큼 쌓이므로 접수마다 표 전체를 훑지 않게 열린 작업 인덱스를 탄다.
    const cnt = await q(c, `SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
                                   count(*) FILTER (WHERE status IN ('starting','running'))::int AS running
                              FROM org_agent_job WHERE status IN ('queued','starting','running')`);
    const queued = Number(cnt[0]?.queued ?? 0), running = Number(cnt[0]?.running ?? 0);
    const room = p.max_queued > 0 ? queued < p.max_queued : running < p.max_running && queued === 0;
    if (!room) return { full: { queued, running } };
    //  #5081 shared_seat 칸은 공용 시트 작업일 때만 적는다 — SHARED_SEAT_COL 머리말(롤 창에서 다른 작업의 접수가 «없는 칸» 으로 깨지지 않게).
    //  #5082 app_instructions 칸도 같은 까닭으로 지시가 있을 때만 적는다(APP_INSTRUCTIONS_COL 머리말).
    const shared = j.sharedSeat === true;
    const instr = typeof j.appInstructions === "string" && j.appInstructions !== "" ? j.appInstructions : null;
    const extraCols = `${shared ? `, ${SHARED_SEAT_COL}` : ""}${instr != null ? `, ${APP_INSTRUCTIONS_COL}` : ""}`;
    const extraVals = `${shared ? ", true" : ""}${instr != null ? ", $16" : ""}`;
    const rows = await q(c,
      `INSERT INTO org_agent_job(requester, account_kind, account_member, app_id, project_id, cwd, harness, model, label, prompt,
                                 resume_conversation, resume_job_id, timeout_sec, bare, homeless${extraCols})
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${extraVals}) RETURNING ${COLS}`,
      [j.requester, j.accountKind, j.accountMember, j.appId, j.projectId, j.cwd, j.harness, j.model, j.label, j.prompt,
        j.resumeConversation, j.resumeJobId, j.timeoutSec, j.bare === true, j.homeless === true, ...(instr != null ? [instr] : [])]);
    return { row: norm(rows[0])! };
  });
}

/**
 * #5081 공용 시트 표시(org_agent_job.shared_seat)는 COLS 에 넣지 않고 따로 읽는다(agentJobSharedSeat).
 *  ★ 매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다(roll-order-migrate-after-gw-swap-auth-outage-2026-10-20) —
 *   COLS 에 새 칸을 넣으면 그 몇 분 동안 모든 작업 행 읽기 · 쓰기(RETURNING)가 «없는 칸» 으로 깨진다. 판의 결과 보고는 5초 × 24번(2분)만
 *   다시 보내므로 그 사이 끝난 작업의 답이 사라진다. 그래서 이 칸은 공용 시트 작업을 넣을 때만 적고(insertAgentJob), 읽을 때 칸이 아직
 *   없으면(42703) false 다 — 칸이 없으면 그 칸을 단 행도 있을 수 없으니 그 답이 맞다.
 */
export const SHARED_SEAT_COL = "shared_seat";
export async function agentJobSharedSeat(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1) return false;
  try {
    const r = await q(itemsPool, `SELECT ${SHARED_SEAT_COL} AS shared FROM org_agent_job WHERE id=$1`, [id]);
    return r[0]?.shared === true;
  } catch (e) {
    if ((e as { code?: string })?.code === "42703") return false;   // undefined_column — 마이그레이션 전(머리말)
    throw e;
  }
}

/**
 * #5082 앱 판 지시(org_agent_job.app_instructions)도 COLS 에 넣지 않고 따로 읽는다(agentJobAppInstructions) — SHARED_SEAT_COL 과 같은 까닭(롤 창).
 *  지시가 있는 작업을 넣을 때만 적고(insertAgentJob), 읽을 때 칸이 아직 없으면(42703) null 이다 — 칸이 없으면 그 칸을 단 행도 없다.
 *  ★ 롤 창에 지시를 실은 작업을 넣으려 하면 «없는 칸» 으로 접수가 실패한다 — 부르는 쪽(ai-runs/service.submitRun)이 503 으로 다시 보내라고 한다.
 */
export const APP_INSTRUCTIONS_COL = "app_instructions";
export async function agentJobAppInstructions(id: number): Promise<string | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  try {
    const r = await q(itemsPool, `SELECT ${APP_INSTRUCTIONS_COL} AS t FROM org_agent_job WHERE id=$1`, [id]);
    const t = r[0]?.t;
    return typeof t === "string" && t !== "" ? t : null;
  } catch (e) {
    if ((e as { code?: string })?.code === "42703") return null;   // undefined_column — 마이그레이션 전(머리말)
    throw e;
  }
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
  p: Pick<AgentJobPolicy, "max_running" | "max_running_per_member" | "max_running_per_service_seat">,
  mint: (jobId: number) => { sessionId: string; boot: { secret: string; hash: string } },
  o: { retryGapSec?: number; sharedSeats?: ReadonlySet<string> } = {},
): Promise<Array<{ row: AgentJobRow; bootSecret: string }>> {
  const gap = Math.max(0, Math.floor(o.retryGapSec ?? 0));
  return withTx(async (c) => {
    await lockTenantQueue(c);
    //  사람당 상한의 축은 plan.planClaims 가 정한다(자리의 구성원 · 공용 시트는 보낸 사람 — #5081) — 여기선 그 판정에 드는 칸만 읽는다.
    const CAND = `id, requester, account_kind, account_member`;
    const live = await q(c, `SELECT ${CAND} FROM org_agent_job WHERE status IN ('starting','running')`);
    //  대기열 전부를 본다(상한 = max_queued 의 범위 끝) — 앞줄이 사람당 상한에 걸려 있어도 그 뒤의 남의 작업이 굶지 않게.
    //   일시 실패로 되돌린 작업(attempts > 0)은 되돌린 뒤 gap 초가 지나야 다시 받는다 — 쉬는 동안엔 뒤의 작업이 그 자리를 쓴다.
    const queued = await q(c,
      `SELECT ${CAND} FROM org_agent_job
        WHERE status='queued' AND NOT cancel_requested AND (attempts = 0 OR updated_at < now() - make_interval(secs => $2))
        ORDER BY id LIMIT $1`,
      [QUEUE_SCAN_MAX, gap]);
    const cand = (r: Record<string, unknown>): ClaimCandidate => ({
      id: Number(r.id), requester: String(r.requester ?? ""), account_kind: String(r.account_kind ?? ""), account_member: (r.account_member as string | null) ?? null,
    });
    const pick = planClaims(live.map(cand), queued.map(cand), p, o.sharedSeats);
    const out: Array<{ row: AgentJobRow; bootSecret: string }> = [];
    for (const id of pick) {
      const m = mint(id);
      //  «대기 중이고 취소 요청이 없을 때만» — 고른 뒤 다른 쪽(취소 · 감시 — 잠금 밖)이 끝냈거나 취소를 걸었으면 넘기지 않는다.
      //   지난 띄우기 실패 사유(error)는 비운다(도는 작업에 «다시 기다립니다» 가 남지 않게) · 시도 횟수를 센다.
      const rows = await q(c,
        `UPDATE org_agent_job SET status='starting', claimed_at=now(), session_id=$2, boot_hash=$3, fail_hash=$3, error=NULL, attempts=attempts+1, updated_at=now()
          WHERE id=$1 AND status='queued' AND NOT cancel_requested RETURNING ${COLS}`, [id, m.sessionId, m.boot.hash]);
      const row = norm(rows[0]);
      if (row) out.push({ row, bootSecret: m.boot.secret });
    }
    return out;
  });
}

/** 배차가 한 번에 보는 대기 작업 수 — 대기열 상한(max_queued)이 가질 수 있는 가장 큰 값. */
export const QUEUE_SCAN_MAX = AGENT_JOB_POLICY_RANGE.max_queued[1];

export async function getAgentJob(id: number): Promise<AgentJobRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return norm((await q(itemsPool, `SELECT ${COLS} FROM org_agent_job WHERE id=$1`, [id]))[0]);
}

/** 판 콜백의 대조에 필요한 것만 — 비밀이 맞는지 모르는 요청에 프롬프트·결과(행당 수백 KB)를 읽지 않는다. */
export interface AgentJobAuthRow { id: number; status: AgentJobStatus; boot_hash: string | null; fail_hash: string | null; secret_hash: string | null }
export async function getAgentJobAuth(id: number): Promise<AgentJobAuthRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = (await q(itemsPool, `SELECT id, status, boot_hash, fail_hash, secret_hash FROM org_agent_job WHERE id=$1`, [id]))[0];
  return r ? {
    id: Number(r.id), status: r.status as AgentJobStatus, boot_hash: (r.boot_hash as string | null) ?? null,
    fail_hash: (r.fail_hash as string | null) ?? null, secret_hash: (r.secret_hash as string | null) ?? null,
  } : null;
}

/**
 * 일시 실패(확보 단계 — OS 계정 · 작업 폴더 · 컨테이너 · 홈 준비 · 판 · 판정을 못 함)로 못 띄운 작업을 대기열로 되돌린다. 띄우는 중이고 · 취소 요청이 없고 ·
 *  시도 횟수가 상한 밑일 때만. 세션 id·부트 비밀을 지운다(다음 자리 주기가 새로 단다) · 사유는 error 에 남긴다(대기 상한으로 끝날 때
 *  문장에 붙는다). 돌려주는 것: 되돌렸나(false 면 부르는 쪽이 그 작업을 실패로 끝낸다).
 */
export async function requeueAgentJob(id: number, why: string, maxAttempts: number): Promise<boolean> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET status='queued', session_id=NULL, boot_hash=NULL, fail_hash=NULL, claimed_at=NULL, error=$2, updated_at=now()
      WHERE id=$1 AND status='starting' AND NOT cancel_requested AND attempts < $3 RETURNING id`, [id, why, maxAttempts]);
  return rows.length > 0;
}

/**
 * 이 토큰(해시 앞자리)이 아직 걷지 않은 작업의 작업 AI 토큰인가 — 작업 안에서 작업을 또 보내지 못하게(되부르기 막기).
 *  열린 작업 인덱스의 조건과 같은 꼴로 좁힌다(걷은 작업의 토큰은 이미 폐기돼 인증을 못 지난다).
 */
export async function isAgentJobToken(hashPrefix: string): Promise<boolean> {
  if (!/^[0-9a-f]{12,64}$/.test(hashPrefix)) return false;
  const rows = await q(itemsPool,
    `SELECT 1 FROM org_agent_job WHERE (status IN ('queued','starting','running') OR reaped = false) AND mcp_token_hash LIKE $1 || '%' LIMIT 1`, [hashPrefix]);
  return rows.length > 0;
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

/**
 * 판에 줄 라이블리 토큰의 해시를 단다(끝날 때 폐기한다). 도는 작업에만 — 그 사이 끝났으면 false(부르는 쪽이 그 토큰을 바로 폐기한다).
 */
export async function setAgentJobMcpToken(id: number, tokenHash: string): Promise<boolean> {
  const rows = await q(itemsPool, `UPDATE org_agent_job SET mcp_token_hash=$2, updated_at=now() WHERE id=$1 AND status='running' RETURNING id`, [id, tokenHash]);
  return rows.length > 0;
}

/**
 * 박동 — 진행 꼬리·대화 id 를 싣는다. 도는 작업에만. 돌려주는 것: 취소 요청 여부(행이 없거나 끝났으면 null).
 *  첫 박동이 시작 실패 보고 비밀(fail_hash)을 지운다(#4829) — 박동한 판은 살아 있으니 «시작하지 못했다» 로 끝낼 길을 닫는다.
 */
export async function tickAgentJob(id: number, o: { tail: string; conversationId: string | null }): Promise<{ cancel: boolean } | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET last_tick_at=now(), output_tail=$2, conversation_id=COALESCE($3, conversation_id), fail_hash=NULL, updated_at=now()
      WHERE id=$1 AND status='running' RETURNING cancel_requested`, [id, o.tail, o.conversationId]);
  return rows.length ? { cancel: rows[0].cancel_requested === true } : null;
}

/**
 * 끝내기 — 열린 작업(대기·띄우는 중·도는 중)일 때만 끝 상태로 넘긴다. 이미 끝났으면 null(두 번째 보고·감시가 겹친 것).
 *  결과·대화 id·진행 꼬리는 준 것만 덮는다. 취소로 끝날 때 멈춘 사유(cancel_reason)가 있으면 그것이 오류 문장이다.
 *  silentSec: «판이 이만큼 조용했다» 로 끝낼 때 — 쓰는 순간 DB 시계로 다시 잰다. 감시의 판단은 조금 전에 읽은 행 기준이라, 그 사이 박동이
 *   왔으면(살아 있는 판) 끝내지 않는다.
 */
export async function finishAgentJob(id: number, o: {
  status: "done" | "failed" | "timeout" | "canceled";
  error?: string | null;
  result?: Record<string, unknown> | null;
  exitCode?: number | null;
  conversationId?: string | null;
  tail?: string | null;
  from?: readonly AgentJobStatus[];
  silentSec?: number | null;
}): Promise<AgentJobRow | null> {
  const from = (o.from ?? ["queued", "starting", "running"]) as string[];
  const silent = o.silentSec != null && Number.isFinite(o.silentSec) ? Math.max(0, Math.floor(o.silentSec)) : null;
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET status=$2,
            error = CASE WHEN $2 = 'canceled' AND cancel_reason IS NOT NULL THEN cancel_reason ELSE $3 END,
            result=COALESCE($4::jsonb, result), exit_code=COALESCE($5, exit_code),
            conversation_id=COALESCE($6, conversation_id), output_tail=COALESCE($7, output_tail),
            ended_at=now(), boot_hash=NULL, fail_hash=NULL, updated_at=now(),
            reaped = (session_id IS NULL AND mcp_token_hash IS NULL)
      WHERE id=$1 AND status = ANY($8::text[])
        AND ($9::int IS NULL OR COALESCE(last_tick_at, started_at, claimed_at, created_at) < now() - make_interval(secs => $9::int))
      RETURNING ${COLS}`,
    [id, o.status, o.error ?? null, o.result ? JSON.stringify(o.result) : null, o.exitCode ?? null, o.conversationId ?? null, o.tail ?? null, from, silent]);
  return norm(rows[0]);
}

/**
 * 판의 시작 실패 보고(#4829) — 그 작업을 실패로 끝낸다. 실패 보고 비밀(fail_hash)이 맞을 때만: 띄우는 중(starting)이거나, 도는 중이라도
 *  부트가 시작을 받고 응답을 못 받은 판(아직 박동 전). 비밀은 부트가 지우지 않고 첫 박동 · 되돌리기 · 끝내기가 지운다 — 박동이 온 판(살아 있다)은
 *  비밀이 없어 null 이다. 실패 보고로 도는 작업을 끝낼 수 없다.
 */
export async function failBootAgentJob(id: number, failHash: string, error: string): Promise<AgentJobRow | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET status='failed', error=$3, ended_at=now(), boot_hash=NULL, fail_hash=NULL, updated_at=now(),
            reaped = (session_id IS NULL AND mcp_token_hash IS NULL)
      WHERE id=$1 AND fail_hash=$2 AND status IN ('starting','running')
      RETURNING ${COLS}`, [id, failHash, error]);
  return norm(rows[0]);
}

/**
 * 취소 요청 — 대기 중이면 감시(또는 바로 이어지는 sweep)가 끝내고, 도는 중이면 판의 다음 박동이 받아 하네스를 끊는다.
 *  reason: 사람이 아닌 쪽이 멈출 때의 사유(앱 동의를 거둠 등) — 끝날 때 오류 문장이 된다. 사람이 누른 취소는 비운다.
 */
export async function requestCancelAgentJob(id: number, reason: string | null = null): Promise<AgentJobRow | null> {
  const rows = await q(itemsPool,
    `UPDATE org_agent_job SET cancel_requested=true, cancel_reason=COALESCE($2, cancel_reason), updated_at=now()
      WHERE id=$1 AND status IN ('queued','starting','running') RETURNING ${COLS}`, [id, reason]);
  return norm(rows[0]);
}

/**
 * 감시가 보는 칸 — 판단(시각·상한·취소)과 걷기(세션·토큰)에 필요한 것만. 프롬프트·결과(행당 수백 KB)는 읽지 않는다.
 *  project_id · cwd 는 도는 동안 재판정(#5081 공용 시트 작업의 모양 — plan.sharedSeatJobRefusal)이 본다.
 */
export type AgentJobSweepRow = Pick<AgentJobRow, "id" | "status" | "reaped" | "session_id" | "mcp_token_hash" | "timeout_sec" | "cancel_requested" | "account_kind" | "requester"
  | "created_at" | "claimed_at" | "started_at" | "last_tick_at" | "ended_at" | "error" | "app_id" | "account_member" | "project_id" | "cwd">;
const SWEEP_COLS = `id, status, reaped, session_id, mcp_token_hash, timeout_sec, cancel_requested, account_kind, requester, app_id, account_member, project_id, cwd,
  created_at, claimed_at, started_at, last_tick_at, ended_at, left(error, 600) AS error`;

/** 감시 대상 — 열린 작업과, 끝났지만 아직 걷지 않은 작업(열린 작업 인덱스의 조건과 같은 꼴). */
export async function openAgentJobs(limit = 1000): Promise<AgentJobSweepRow[]> {
  const rows = await q(itemsPool,
    `SELECT ${SWEEP_COLS} FROM org_agent_job WHERE status IN ('queued','starting','running') OR reaped = false ORDER BY id LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id), project_id: r.project_id == null ? null : Number(r.project_id) }) as unknown as AgentJobSweepRow);
}

/**
 * 보존 정리(#4828) — 끝났고 걷기를 마친 작업 가운데 끝난 지 keepDays 일이 지난 행을 지운다(끝난 때가 오래된 것부터 batch 행까지).
 *  keepDays 가 1 일 아래(0 · 음수 · 1 미만 소수 · 숫자 아님)면 무기한이라 아무것도 지우지 않는다 — 버림 뒤 0 일로 돌면 걷은 행을 다 지운다.
 *  걷기 전(reaped=false) 행은 남긴다 — 감시가 컨테이너 · 토큰을 걷는 근거다. 돌려주는 것 = 지운 행 수.
 */
export async function pruneAgentJobs(keepDays: number, batch: number = PRUNE_BATCH): Promise<number> {
  const days = Math.floor(keepDays);
  if (!(days >= 1)) return 0;
  const r = await itemsPool.query(
    `DELETE FROM org_agent_job WHERE id IN (
       SELECT id FROM org_agent_job
        WHERE reaped = true AND status IN ('done','failed','timeout','canceled') AND ended_at < now() - make_interval(days => $1)
        ORDER BY ended_at LIMIT $2)`,
    [days, Math.max(1, Math.floor(batch))]);
  return r.rowCount ?? 0;
}

/** 걷기를 마쳤다 — 종료 신호(kill-session 성공 또는 이미 없다는 확답)를 보냈고 토큰을 폐기했다. 컨테이너 철거 자체는 브로커(#4696) 몫이다. */
export async function markAgentJobReaped(id: number): Promise<void> {
  await q(itemsPool, `UPDATE org_agent_job SET reaped=true, updated_at=now() WHERE id=$1 AND status IN ('done','failed','timeout','canceled')`, [id]);
}

export interface AgentJobListFilter { requester?: string | null; appId?: string | null; status?: string | null; limit: number }
/** 목록 한 줄 — 프롬프트·결과 전문·진행 꼬리·비밀 해시는 싣지 않는다(목록 100건이면 수십 MB 가 된다). 답은 앞머리만. */
export type AgentJobSummaryRow = Omit<AgentJobRow, "prompt" | "output_tail" | "result" | "boot_hash" | "fail_hash" | "secret_hash" | "mcp_token_hash"> & {
  result_preview: string | null;
  has_result: boolean;
};
/** 목록이 싣는 답 앞머리 길이(문자). */
export const RESULT_PREVIEW_MAX = 280;
const SUMMARY_COLS = `id, status, requester, account_kind, account_member, app_id, project_id, cwd, harness, model, label,
  resume_conversation, resume_job_id, timeout_sec, homeless, session_id, conversation_id, exit_code, error, cancel_requested,
  created_at, claimed_at, started_at, last_tick_at, ended_at, reaped,
  left(result->>'text', ${RESULT_PREVIEW_MAX}) AS result_preview, (result IS NOT NULL) AS has_result`;
export async function listAgentJobs(f: AgentJobListFilter): Promise<AgentJobSummaryRow[]> {
  const where: string[] = []; const args: unknown[] = [];
  if (f.requester) { args.push(f.requester); where.push(`requester=$${args.length}`); }
  if (f.appId) { args.push(f.appId); where.push(`app_id=$${args.length}`); }
  if (f.status) { args.push(f.status); where.push(`status=$${args.length}`); }
  args.push(f.limit);
  const rows = await q(itemsPool,
    `SELECT ${SUMMARY_COLS} FROM org_agent_job ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${args.length}`, args);
  return rows.map((r) => ({
    ...(norm(r) as unknown as AgentJobSummaryRow),
    result_preview: (r.result_preview as string | null) ?? null, has_result: r.has_result === true,
  }));
}

/** 대기열에서 이 작업 앞에 몇 건이 있나(먼저 온 대기 작업 수). */
export async function queuePosition(id: number): Promise<number> {
  const rows = await q(itemsPool, `SELECT count(*)::int AS n FROM org_agent_job WHERE status='queued' AND id < $1`, [id]);
  return Number(rows[0]?.n ?? 0);
}

// ── 워크스페이스 설정 칸(org_runtime_config.agent_job_policy) — 관리자 도구 agent_job_limits_set 만 쓴다(그 칸만 · 앱 판 상한과 같은 꼴). ──
//  ⚠ 읽기 실패를 «빈 설정» 으로 접지 않는다(던진다) — 접으면 정책 캐시의 «마지막 값» 폴백이 영영 안 돌고(관리자가 낮춘 상한이 30초 동안
//   풀린다), 고치기(agent_job_limits_set)가 빈 설정에서 시작해 저장된 값 전체를 덮는다. 행이 없는 것(새 워크스페이스)은 빈 설정이 맞다.
export async function agentJobPolicyRow(): Promise<Record<string, unknown>> {
  const r = await itemsPool.query(`SELECT agent_job_policy FROM org_runtime_config WHERE id=1`);
  const row = r.rows[0]?.agent_job_policy;
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
}
export async function writeAgentJobPolicyRow(next: Record<string, number>): Promise<void> {
  await itemsPool.query(`UPDATE org_runtime_config SET agent_job_policy=$1::jsonb WHERE id=1`, [JSON.stringify(next)]);
}

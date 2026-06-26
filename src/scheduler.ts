// 인프로세스 스케줄러 — 게이트웨이 단일 프로세스가 org_cron(웹 관리) 잡을 주기 실행.
//  트리거 표준화(2026-06-26 결정): git push 웹훅 대신 서버사이드 cron 을 베이스라인으로. 게이트웨이가 바깥으로
//  fetch 하므로 inbound 도달성·repo당 등록 불요(직원 0·repo셋업 0). refresh/sync 는 멱등(last_refreshed_sha/커서)이라
//  반복 안전. 도메인 귀속: 스케줄러 엔진=횡단, 액션 refresh→도메인맵(D2)/connector_sync→컨텍스트저장소(D1).
//  단일 프로세스(launchd 상시구동) 전제 → 리더선출 불요(HA 면 advisory lock 추가). 잡당 인메모리 락으로 중첩 방지.
//  보안: action 은 org_cron CHECK allowlist(임의 셸 금지). connector_sync 만 서브프로세스(검증된 run-sync CLI).
//  스케줄 2모드: cron_expr 있으면 절대(벽시계, cron-expr.ts), 없으면 interval_sec 상대(last_run+interval).
import { itemsPool, q } from "./domainmap/db.js";
import { refreshRepoFromGit } from "./domainmap/git-pull.js";
import { parseCron, cronMatches, nextCronTime } from "./cron-expr.js";
import type { Actor } from "./domainmap/core/types.js";
import { logger } from "./log.js";

const TICK_MS = 30_000;             // 폴 주기(잡 due 판정 해상도). interval 잡 최소 60s 앱 강제. cron 은 분당 2틱이라 매치분 안 놓침.
const running = new Set<string>();  // 잡당 인메모리 락 — 느린 잡이 다음 틱과 중첩되지 않게.

interface CronJob {
  id: string;
  action: string;
  params?: Record<string, unknown>;
  interval_sec: number;
  cron_expr?: string | null;
  last_run_at?: string | null;
}

// active 커넥터(data_source.status='active')만 sync 대상.
async function activeConnectorSystems(): Promise<string[]> {
  try { const rows = await q(itemsPool, `SELECT system FROM data_source WHERE status='active'`); return rows.map((r) => r.system); }
  catch { return []; }
}

// 한 잡 실행 — action allowlist 디스패치. 반환 summary 는 org_cron.last_summary 에 기록(관측성).
async function runJob(job: CronJob): Promise<{ status: string; summary: unknown }> {
  const actor: Actor = { type: "agent", id: "cron:" + job.id };
  const params = job.params ?? {};

  if (job.action === "refresh_all") {
    const repos = await q(itemsPool,
      `SELECT name FROM repo WHERE COALESCE(state,'active')='active' AND git_url IS NOT NULL AND git_url <> ''`);
    const results = [];
    for (const r of repos) results.push(await refreshRepoFromGit(r.name, actor));
    return { status: "ok", summary: { repos: results.length, results } };
  }

  if (job.action === "refresh_repo") {
    const name = params.repo;
    if (!name) return { status: "error", summary: { error: "params.repo 필요" } };
    return { status: "ok", summary: await refreshRepoFromGit(String(name), actor) };
  }

  if (job.action === "eval_domain_debt") {
    const { evaluateDomainStructureDebt } = await import("./domainmap/core/domain-debt.js");
    const repos = await q(itemsPool, `SELECT name FROM repo WHERE COALESCE(state,'active')='active'`);
    const out: unknown[] = [];
    for (const r of repos) {
      try { out.push(await evaluateDomainStructureDebt(r.name, actor)); }
      catch (e) { out.push({ repo: r.name, error: String(e) }); }
    }
    return { status: "ok", summary: { repos: out.length } };
  }

  if (job.action === "connector_sync") {
    // 서브프로세스로 격리(검증된 run-sync CLI). params.system 없으면 active 전체. cwd=게이트웨이 루트(launchd 기동 위치).
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const systems = params.system ? [String(params.system)] : await activeConnectorSystems();
    const out: unknown[] = [];
    for (const sys of systems) {
      try {
        const r = await execFileP("node", ["--env-file-if-exists=.env", "dist/connectors/run-sync.js", sys],
          { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
        out.push({ system: sys, ok: true, tail: (r.stdout || "").trim().split("\n").slice(-1)[0] ?? "" });
      } catch (e) { out.push({ system: sys, ok: false, error: (e as Error)?.message ?? String(e) }); }
    }
    return { status: "ok", summary: { systems: out } };
  }

  if (job.action === "connector_push") {
    // 아웃바운드 — external_outbox(우리 편집) 드레인 → 외부 PM 미러. connector_sync 와 대칭(검증된 run-push CLI 서브프로세스).
    //  우리 DB=master 라 push 는 additive(외부 미러 생성/갱신) — 우리 데이터엔 무영향. params.system 없으면 active 전체.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    const systems = params.system ? [String(params.system)] : await activeConnectorSystems();
    const out: unknown[] = [];
    for (const sys of systems) {
      try {
        const r = await execFileP("node", ["--env-file-if-exists=.env", "dist/connectors/run-push.js", sys],
          { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
        out.push({ system: sys, ok: true, tail: (r.stdout || "").trim().split("\n").slice(-1)[0] ?? "" });
      } catch (e) { out.push({ system: sys, ok: false, error: (e as Error)?.message ?? String(e) }); }
    }
    return { status: "ok", summary: { systems: out } };
  }

  if (job.action === "map_unmapped") {
    // LLM 판단주체 — 상시 LLM 세션(팀플랜 시드)에 분류 태스크 주입. 세션 미설정/부재는 error(가시).
    return runMapInject(params);
  }

  if (job.action === "ensure_managed_sessions") {
    // keep-alive — enabled 상시 세션의 tmux 세션 보장(죽었으면 재생성). 등록 0이면 no-op.
    const { ensureAllManagedSessions } = await import("./org/managed-sessions.js");
    return { status: "ok", summary: { sessions: await ensureAllManagedSessions() } };
  }

  return { status: "error", summary: { error: "unknown action: " + job.action } };
}

// LLM 판단주체 — 상시 LLM 세션(라이블리 시드, **팀플랜 과금 내**)에 분류 태스크를 주입한다.
//  headless `claude -p`+토큰 = API 별도 과금이라 폐기. 메커니즘: tmux send-keys 로 타깃 세션 PTY 에 프롬프트+Enter →
//  세션의 claude 가 lively MCP(list_unmapped/category_get/map_code_unit)로 비동기 수행. 인박스 비면 주입 안 함.
//  세션 미설정/부재는 error(가시). fire-and-forget: 주입까지가 잡 책임(매핑은 세션이 수 분에 걸쳐) — 다음 주기에 인박스 0이면 skip.
async function runMapInject(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  const repo = String(params.repo ?? "context-ontology");
  const sessionRef = params.session ? String(params.session) : "";
  if (!sessionRef) return { status: "error", summary: { error: "타깃 상시 세션 미설정 — 관리탭 스케줄러에서 상시 세션을 선택하세요." } };
  const { listUnmappedCodeUnits } = await import("./domainmap/core/mappings.js");
  let inbox: Array<{ path: string }>;
  try { inbox = await listUnmappedCodeUnits(repo); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
  if (!inbox.length) return { status: "ok", summary: { skipped: "인박스 비어있음", unmapped: 0, session: sessionRef } };

  // params.session = 관리세션 id. 현재 살아있는 tmux 세션으로 해소(keep-alive 보장 — 죽었으면 재생성).
  //  managed 조회 실패(=관리세션 아님)면 raw tmux session id 로 폴백(후방호환).
  let tmuxSession = sessionRef;
  try {
    const { getManagedSession, ensureManagedSession } = await import("./org/managed-sessions.js");
    const ms = await getManagedSession(sessionRef);
    if (ms) {
      const ens = await ensureManagedSession(ms);
      if (!ens.session_id) return { status: "error", summary: { error: "관리세션 '" + sessionRef + "' 의 tmux 세션을 띄우지 못함(enabled 확인)", session: sessionRef } };
      tmuxSession = ens.session_id;
    }
  } catch { /* managed 조회 실패 → raw tmux id 로 시도 */ }

  const prompt = (typeof params.prompt === "string" && params.prompt.trim()) ? params.prompt.trim() : buildMapPrompt(repo, inbox.length);
  try { await injectToSession(tmuxSession, prompt); }
  catch (e) { return { status: "error", summary: { error: "세션 주입 실패(" + tmuxSession + "): " + ((e as Error)?.message ?? String(e)), session: sessionRef, tmux: tmuxSession } }; }
  return { status: "ok", summary: { injected: true, managed_session: sessionRef, tmux: tmuxSession, unmapped: inbox.length } };
}

// tmux send-keys 로 세션 PTY 에 텍스트 주입(+Enter). UTF-8 로케일 강제(한글 깨짐 방지 — terminal-sessions 와 동일).
//  text 는 **단일 라인**이어야 한다(개행은 send-keys -l 에서 조기 Enter 가 됨 → buildMapPrompt 는 1라인).
async function injectToSession(sessionId: string, text: string): Promise<void> {
  const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) { env.LANG = "en_US.UTF-8"; env.LC_CTYPE = "en_US.UTF-8"; }
  await execFileP(TMUX_BIN, ["has-session", "-t", sessionId], { timeout: 5000, env });        // 부재면 throw → error.
  await execFileP(TMUX_BIN, ["send-keys", "-t", sessionId, "-l", text], { timeout: 5000, env }); // 텍스트(literal).
  await execFileP(TMUX_BIN, ["send-keys", "-t", sessionId, "Enter"], { timeout: 5000, env });     // 제출.
}

// 가이드 프롬프트 — **단일 라인**(send-keys -l 주입용; 개행 금지). DDD + 라이브 도메인 should fetch 지시(하드코딩 X → 자기갱신) + propose/근거/confidence 규약.
//  params.prompt 로 관리탭에서 덮어쓸 수 있음(웹 편집). count·repo 만 보간.
function buildMapPrompt(repo: string, count: number): string {
  return `미매핑 코드유닛(${count}건)을 제품 도메인에 분류하는 배치 작업이야. ` +
    `① category_list(space=product)+각 category_get으로 도메인 should(정의·범위)를 읽어 분류 기준으로 삼아. ` +
    `② list_unmapped(repo=${repo})로 인박스 가져와. ` +
    `③ 각 유닛 path·label 보고 필요하면 Read/Grep으로 헤더·내용·import 확인해 어떤 비즈니스 능력인지 파악. ` +
    `④ DDD(도메인=비즈니스 능력 경계, 기술레이어 아님)로 map_code_unit 호출: target=경로, category=도메인 key, origin=llm, ` +
    `evidence=근거(should의 어느 부분↔코드의 어느 신호, 필수), 확신이면 status=confirmed(confidence≥0.8) 아니면 proposed, ` +
    `제품 도메인 아닌 것(비즈니스문서·세일즈덱·stale산출물·너무 coarse한 디렉토리유닛)은 status=rejected+evidence에 이유. ` +
    `확신없으면 추측말고 proposed. 끝나면 confirmed/proposed/rejected 카운트 요약.`;
}

// 다음 실행 시각(표시용 next_run_at) — cron 은 다음 매치분, interval 은 now+interval.
function computeNextRun(job: CronJob): string | null {
  if (job.cron_expr) {
    try { const n = nextCronTime(parseCron(job.cron_expr), new Date()); return n ? n.toISOString() : null; }
    catch { return null; }
  }
  return new Date(Date.now() + Math.max(60, Number(job.interval_sec) || 600) * 1000).toISOString();
}

// 한 잡 실행 + org_cron 상태 갱신(틱·즉시실행 공용). 잡당 인메모리 락으로 중첩 방지(이미 실행 중이면 skip).
async function executeAndRecord(job: CronJob): Promise<{ status: string; summary: unknown }> {
  if (running.has(job.id)) return { status: "skipped", summary: { detail: "already running" } };
  running.add(job.id);
  try {
    const startedIso = new Date().toISOString();
    let res: { status: string; summary: unknown };
    try { res = await runJob(job); }
    catch (e) { res = { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
    const nextIso = computeNextRun(job);
    try {
      await itemsPool.query(
        `UPDATE org_cron SET last_run_at=$2, last_status=$3, last_summary=$4, next_run_at=$5, updated_at=now() WHERE id=$1`,
        [job.id, startedIso, res.status, JSON.stringify(res.summary), nextIso]);
    } catch (e) { logger.warn({ err: e, job: job.id }, "org_cron 상태 갱신 실패"); }
    logger.info({ job: job.id, action: job.action, status: res.status }, "cron job done");
    return res;
  } finally { running.delete(job.id); }
}

// 잡이 지금 due 인가 — cron_expr(절대) 또는 interval_sec(상대).
function isDue(job: CronJob, now: number): boolean {
  if (job.cron_expr) {
    // 절대(벽시계): cron 매치 + 같은 '분'에 아직 안 돌았으면 due(30s 틱이 분당 2회라 매치 분을 놓치지 않음).
    try {
      const nowMin = Math.floor(now / 60000);
      const lastMin = job.last_run_at ? Math.floor(new Date(job.last_run_at).getTime() / 60000) : -1;
      return cronMatches(parseCron(job.cron_expr), new Date(now)) && nowMin !== lastMin;
    } catch { return false; } // 잘못된 expr → 미실행(검증은 cron_set). 다음 틱도 동일.
  }
  // 상대(interval): last_run + interval 경과 시.
  const last = job.last_run_at ? new Date(job.last_run_at).getTime() : 0;
  return now - last >= Math.max(60, Number(job.interval_sec) || 600) * 1000;
}

async function tick(): Promise<void> {
  let jobs: CronJob[];
  try { jobs = await q(itemsPool, `SELECT * FROM org_cron WHERE enabled=true`); }
  catch { return; } // 테이블 부재/DB 미연결 → 조용히 패스(다음 틱 재시도).

  const now = Date.now();
  for (const job of jobs) {
    if (running.has(job.id)) continue; // 진행 중 → 중첩 skip.
    if (!isDue(job, now)) continue;
    void executeAndRecord(job); // fire-and-forget — 락이 중첩을 막는다.
  }
}

// 즉시 실행(온디맨드 'refresh now') — cron_run_now capability 가 호출. 스케줄과 무관하게 1회.
export async function runCronById(id: string): Promise<{ status: string; summary: unknown }> {
  const rows = await q(itemsPool, `SELECT * FROM org_cron WHERE id=$1`, [id]);
  if (!rows.length) return { status: "error", summary: { error: "no such cron job: " + id } };
  return executeAndRecord(rows[0]);
}

let timer: NodeJS.Timeout | null = null;

// 부팅 시 1회 호출(index.ts, 스키마 init 직렬 체인 후). 멱등(중복 호출 무시).
export function startScheduler(): void {
  if (timer) return;
  logger.info("scheduler started (in-process, org_cron)");
  timer = setInterval(() => { tick().catch((e) => logger.warn({ err: e }, "scheduler tick failed")); }, TICK_MS);
  if (timer.unref) timer.unref(); // 스케줄러 타이머가 프로세스 정상 종료를 막지 않게.
}

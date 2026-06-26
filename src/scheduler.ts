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

  if (job.action === "map_unmapped") {
    // LLM 판단주체 — 라이블리 시드 에이전트가 도메인 should+DDD 로 미매핑 인박스 분류. 환경 미설정/실패는 error(가시).
    return runMapAgent(params);
  }

  return { status: "error", summary: { error: "unknown action: " + job.action } };
}

// LLM 판단주체 — 라이블리 시드 에이전트(headless claude -p + lively MCP)를 띄워 미매핑 인박스를 도메인 should+DDD 로 분류.
//  환경: 박스에 claude CLI(라이블리 시드 로그인) + gateway lively MCP 토큰(env). 미설정/실패는 error 반환(스케줄러 안 죽음·가시).
//  인박스 비면 에이전트 안 띄움(비용 절약). allowedTools 로 권한 최소화. 결과는 last_summary 에 기록.
async function runMapAgent(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  const repo = String(params.repo ?? "context-ontology");
  const { listUnmappedCodeUnits } = await import("./domainmap/core/mappings.js");
  let inbox: Array<{ path: string }>;
  try { inbox = await listUnmappedCodeUnits(repo); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
  if (!inbox.length) return { status: "ok", summary: { skipped: "인박스 비어있음", unmapped: 0 } };

  const agentCmd = String(params.agent_cmd ?? process.env.MAP_AGENT_CMD ?? "claude");
  const tokenEnv = String(params.token_env ?? process.env.MAP_AGENT_TOKEN_ENV ?? "LIVELY_MAP_AGENT_TOKEN");
  const token = process.env[tokenEnv];
  const gatewayUrl = String(params.gateway_url ?? process.env.MAP_AGENT_GATEWAY_URL ?? "http://localhost:8080/mcp");
  if (!token) {
    return { status: "error", summary: { error: `map agent 미설정: lively MCP 토큰 env '${tokenEnv}' 없음(라이블리 시드 토큰 설정 후 활성화)`, unmapped: inbox.length } };
  }

  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "map-agent-"));
  try {
    const mcpConfig = join(dir, "mcp.json");
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { lively: { type: "http", url: gatewayUrl, headers: { Authorization: "Bearer " + token } } } }));
    const r = await execFileP(agentCmd, [
      "-p", buildMapPrompt(repo, inbox.length),
      "--mcp-config", mcpConfig,
      "--allowedTools", "mcp__lively__list_unmapped,mcp__lively__category_list,mcp__lively__category_get,mcp__lively__map_code_unit,Read,Grep,Glob",
      "--output-format", "json",
    ], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024, cwd: process.cwd() });
    const after = await listUnmappedCodeUnits(repo).catch(() => inbox); // 분류 후 잔여 인박스(검증).
    return { status: "ok", summary: { unmapped_before: inbox.length, unmapped_after: after.length, agent_tail: (r.stdout || "").slice(-1500) } };
  } catch (e) {
    return { status: "error", summary: { error: (e as Error)?.message ?? String(e), unmapped: inbox.length } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 가이드 프롬프트 — DDD 원칙 + 라이브 도메인 should 주입 지시 + propose/근거/confidence 규약.
//  도메인은 하드코딩 안 함: 에이전트가 category_get 으로 라이브 fetch → should 바뀌면 분류도 자동으로 따라감(자기갱신).
function buildMapPrompt(repo: string, count: number): string {
  return [
    `당신은 라이블리 컨텍스트 온톨로지의 **도메인 분류 에이전트**다. repo='${repo}' 의 미매핑 코드유닛(${count}건)을 제품 도메인에 귀속시킨다.`,
    ``,
    `## 원칙 (DDD)`,
    `- 도메인 = 비즈니스 능력 + 유비쿼터스 언어의 경계. 코드의 기술 레이어가 아니라 "어떤 비즈니스 능력을 구현하는가"로 판단한다.`,
    `- 한 유닛은 그 도메인의 should(정의·범위·규칙)를 가장 직접 구현하는 도메인에 속한다.`,
    `- 여러 도메인을 가로지르는 공유 인프라(프레임워크·게이트웨이 골격·유틸)는 cross-cutting — 가장 가까운 도메인에 proposed + evidence 에 명시.`,
    `- 제품 도메인 대상이 아닌 것(비즈니스 문서·세일즈덱·stale 산출물·너무 coarse한 디렉토리 유닛)은 status='rejected' + evidence 에 이유.`,
    `- **확신 없으면 추측 말고 status='proposed'+낮은 confidence**(가짜 확신 금지 — 사람/2차검증이 처리).`,
    ``,
    `## 절차`,
    `1. category_list(space='product') + 각 category_get 으로 **도메인 정의(should/scope)**를 읽어라 — 이게 유일한 분류 기준이다(하드코딩 말고 라이브로).`,
    `2. list_unmapped(repo='${repo}') 로 인박스를 가져와라.`,
    `3. 각 유닛: path·label 을 보고, 필요하면 Read/Grep 으로 파일 헤더·내용·import 를 확인해 무슨 능력인지 파악한다.`,
    `4. 도메인 should 와 대조해 map_code_unit 호출(target=path, category=도메인 key, origin='llm', evidence=근거 필수):`,
    `   - 확신(헤더/이름/내용이 should 와 명백히 일치) → status='confirmed', confidence≥0.8.`,
    `   - 불확실/cross-cutting → status='proposed', confidence<0.8, evidence 에 모호점·후보 도메인.`,
    `   - 제품 도메인 아님 → status='rejected', evidence 에 이유.`,
    `5. evidence(근거)는 항상 "도메인 should 의 어느 부분 ↔ 코드의 어느 신호"로 구체적으로. 근거 없는 매핑 금지(불변식).`,
    `6. 끝나면 {confirmed, proposed, rejected} 카운트 + 한 줄 요약 출력.`,
  ].join("\n");
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

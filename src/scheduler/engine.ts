// 인프로세스 스케줄러 엔진 — 게이트웨이 단일 프로세스가 org_cron(웹 관리) 잡을 주기 실행.
//  트리거 표준화(2026-06-26 결정): git push 웹훅 대신 서버사이드 cron 을 베이스라인으로. 게이트웨이가 바깥으로
//  fetch 하므로 inbound 도달성·repo당 등록 불요(직원 0·repo셋업 0). refresh/sync 는 멱등(last_refreshed_sha/커서)이라
//  반복 안전. 도메인 귀속: 스케줄러 엔진=횡단, 액션 refresh→도메인맵(D2)/connector_sync→컨텍스트저장소(D1).
//  ★ 리더선출이 생겼다(#2664 3단계, scheduler/leader.ts) — 매니지드 무중단 롤이 옛·새 게이트웨이를
//   수십 초 **겹쳐** 띄우기 때문이다. 종전 전제(단일 프로세스 → 리더선출 불요)는 자가호스팅에서만 참이었고,
//   잡당 인메모리 락(`running`)은 자기 프로세스 안에서만 듣는다. 이제 **리더만 틱을 돈다**(tickAllTenants).
//   ⚠ 인메모리 락은 그대로 남는다 — 리더 안에서의 중첩(긴 잡이 다음 틱과 겹침)은 여전히 그게 막는다.
//  보안: action 은 org_cron CHECK allowlist(임의 셸 금지). connector_sync 만 서브프로세스(검증된 run-sync CLI).
//  스케줄 2모드: cron_expr 있으면 절대(벽시계, cron-expr.ts), 없으면 interval_sec 상대(last_run+interval).
//  R16: 액션 구현·프롬프트는 registry.ts(선언+run 합류)·actions/* 로 — 여기는 틱·due 판정·실행 기록만(액션명 분기 없음).
import { itemsPool, q } from "../db/client.js";
import { parseCron, cronMatches, nextCronTime } from "./cron-expr.js";
import { orgTimezone } from "../org/timezone.js"; // #778 cron 벽시계 = 조직 시간대(서버 로컬 TZ 아님)
import { CRON_ACTIONS, type CronJob } from "./registry.js";
import { cronBreakerDecision } from "./cron-breaker.js";
import { sendBoxAlert } from "../ops/alerts.js";
import { logger } from "../log.js";
import { withTenant } from "../org/tenant-context.js";
import { schedulerTargets } from "./tenant-fanout.js";
import { isSchedulerLeader, startSchedulerLeadership } from "./leader.js";

/** 구 DB(컬럼 부재)에서 쓸 기본 임계 — 스키마 마이그레이션 전에도 보호가 걸리게. */
const DEFAULT_MAX_FAIL_STREAK = 5;

/**
 * 브레이커 발동(#1675 ④) — 잡을 끄고 흔적을 남기고 알린다.
 *  **throw 하지 않는다**: 여기서 던지면 정작 크론 실행 기록이 날아간다.
 */
async function tripBreaker(job: CronJob, streak: number): Promise<void> {
  const reason = `연속 실패 ${streak}회 — 자동 정지(마지막 상태: error)`;
  try {
    const r = await itemsPool.query(
      `UPDATE org_cron SET enabled=false, auto_disabled_at=now(), auto_disabled_reason=$2, updated_at=now()
        WHERE id=$1 AND enabled=true`, [job.id, reason]);
    if (!(r.rowCount ?? 0)) return;   // 이미 꺼져 있었다 — 알림도 보내지 않는다(중복 방지)
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, job: job.id }, "크론 자동 정지 실패");
    return;
  }
  logger.warn({ job: job.id, action: job.action, streak }, "크론 연속 실패 — 자동 정지");
  try {
    await sendBoxAlert({
      severity: "warn",
      title: `크론 자동 정지 — ${job.id}`,
      text:
        `'${job.id}'(${job.action}) 가 ${streak}회 연속 실패해 자동으로 멈췄습니다.\n`
        + `조치: 관리탭 ▸ 스케줄에서 마지막 실행 요약(last_summary)으로 원인을 확인하고, 고친 뒤 다시 켜세요.`
        + ` 다시 켜면 실패 카운터도 0 으로 초기화됩니다.`,
      detail: { job: job.id, action: job.action, fail_streak: streak },
    });
  } catch (e) { logger.warn({ err: (e as Error)?.message, job: job.id }, "크론 자동 정지 알림 실패"); }
}

const TICK_MS = 30_000;             // 폴 주기(잡 due 판정 해상도). interval 잡 최소 60s 앱 강제. cron 은 분당 2틱이라 매치분 안 놓침.
const running = new Set<string>();  // 잡당 인메모리 락 — 느린 잡이 다음 틱과 중첩되지 않게.

// 한 잡 실행 — 레지스트리(CRON_ACTIONS) lookup 디스패치(allowlist). 반환 summary 는 org_cron.last_summary 에 기록(관측성).
async function runJob(job: CronJob): Promise<{ status: string; summary: unknown }> {
  const def = CRON_ACTIONS.find((a) => a.key === job.action);
  if (!def) return { status: "error", summary: { error: "unknown action: " + job.action } };
  return def.run(job.params ?? {}, job);
}

// 다음 실행 시각(표시용 next_run_at) — cron 은 다음 매치분, interval 은 now+interval.
//  tz(#778) = 조직 시간대. cron_expr 은 그 벽시계로 해석된다(서버 로컬 TZ 아님 — cron-expr.ts 헤더 참조).
function computeNextRun(job: CronJob, tz: string): string | null {
  if (job.run_once) return null; // 1회성 — 다음 실행 없음
  if (job.cron_expr) {
    try { const n = nextCronTime(parseCron(job.cron_expr), new Date(), tz); return n ? n.toISOString() : null; }
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
    const nextIso = computeNextRun(job, await orgTimezone());
    // #1675 ④ — 연속 실패 서킷 브레이커. 판정은 순수 함수(cron-breaker)가, 기록은 여기가 한다.
    //  임계가 컬럼에 없으면(구 DB) 기본 5 로 본다 — 스키마 마이그레이션 전에도 보호가 걸리게.
    const brk = cronBreakerDecision({
      status: res.status,
      streak: Number(job.fail_streak ?? 0),
      max: job.max_fail_streak == null ? DEFAULT_MAX_FAIL_STREAK : Number(job.max_fail_streak),
    });
    try {
      await itemsPool.query(
        `UPDATE org_cron SET last_run_at=$2, last_status=$3, last_summary=$4, next_run_at=$5, updated_at=now() WHERE id=$1`,
        [job.id, startedIso, res.status, JSON.stringify(res.summary), nextIso]);
      if (job.run_once) await itemsPool.query(`UPDATE org_cron SET enabled=false, updated_at=now() WHERE id=$1`, [job.id]); // 1회성: 실행 후 자동 비활성(반복 방지)
    } catch (e) { logger.warn({ err: e, job: job.id }, "org_cron 상태 갱신 실패"); }
    // ⚠ 서킷 브레이커 카운터는 **따로** 쓴다(#1675 리뷰). 위 UPDATE 에 fail_streak 를 끼워 넣으면 그 컬럼이 없는 DB
    //  (마이그레이션 미실행·롤백)에서 **문 전체가 실패**해 last_run_at 이 안 써지고, 그러면 isDue 가 매 틱 due 로 읽어
    //  잡이 30초마다 돈다 — 고장을 막으려던 장치가 폭주를 만든다. 기록(위)과 보호(아래)는 서로를 깨뜨리면 안 된다.
    try {
      await itemsPool.query(`UPDATE org_cron SET fail_streak=$2 WHERE id=$1`, [job.id, brk.nextStreak]);
    } catch (e) { logger.warn({ err: (e as Error)?.message, job: job.id }, "연속 실패 카운터 갱신 실패(브레이커만 비활성)"); }
    logger.info({ job: job.id, action: job.action, status: res.status, streak: brk.nextStreak }, "cron job done");
    if (brk.disable && !job.run_once) await tripBreaker(job, brk.nextStreak);
    return res;
  } finally { running.delete(job.id); }
}

// 잡이 지금 due 인가 — cron_expr(절대) 또는 interval_sec(상대). tz(#778) = cron 벽시계 기준 = 조직 시간대.
function isDue(job: CronJob, now: number, tz: string): boolean {
  if (job.run_once) return !job.last_run_at; // 1회성 — 아직 안 돌았으면 due(다음 틱 실행), 실행되면 executeAndRecord 가 비활성화
  if (job.cron_expr) {
    // 절대(벽시계): cron 매치 + 같은 '분'에 아직 안 돌았으면 due(30s 틱이 분당 2회라 매치 분을 놓치지 않음).
    try {
      const nowMin = Math.floor(now / 60000);
      const lastMin = job.last_run_at ? Math.floor(new Date(job.last_run_at).getTime() / 60000) : -1;
      return cronMatches(parseCron(job.cron_expr), new Date(now), tz) && nowMin !== lastMin;
    } catch { return false; } // 잘못된 expr → 미실행(검증은 cron_set). 다음 틱도 동일.
  }
  // 상대(interval): last_run + interval 경과 시.
  const last = job.last_run_at ? new Date(job.last_run_at).getTime() : 0;
  return now - last >= Math.max(60, Number(job.interval_sec) || 600) * 1000;
}

/**
 * 틱 1회(#1437 중앙 모드) — **요청 컨텍스트 안에서** 부르면 itemsPool 파사드가 그 테넌트로 바인딩돼
 *  org_cron 조회·실행 전부가 그 테넌트 스코프가 된다. 잡 실행은 fire-and-forget(내부 락이 중첩 방지)
 *  이라 이 함수는 빨리 돌아온다 — HTTP 틱 엔드포인트에 그대로 얹어도 요청이 붙잡히지 않는다.
 */
export async function runSchedulerTickOnce(): Promise<void> { return tick(); }

// 워크스페이스 순회 (#2418) — 판정·대상 조회는 scheduler/tenant-fanout.ts(위탁 큐와 공유).
//  tick() 자체는 그대로다: **테넌트 컨텍스트 안에서 부르면** itemsPool 파사드가 그 테넌트로 바인딩돼
//  org_cron 조회·실행이 전부 그 스코프가 된다. 바뀐 것은 "누가 어떤 컨텍스트로 부르는가" 뿐이다.
async function tickAllTenants(): Promise<void> {
  //  ★ 리더만 돈다 (#2664 3단계). 이 파일 머리말의 「단일 프로세스 전제」가 매니지드에서는
  //   더 이상 참이 아니다 — 무중단 롤이 옛·새 게이트웨이를 수십 초 겹쳐 띄운다. 인메모리 락
  //   (`running`)은 자기 프로세스 안에서만 들으므로, 겹치는 동안 같은 크론이 두 번 발화한다.
  //  ⚠ 조용히 건너뛴다 — 30초마다 «나는 리더가 아니다» 를 로그에 남기면 로그가 그것만 남는다.
  //   자격의 획득·상실은 leader.ts 가 전이 시점에 한 번씩 말한다.
  if (!isSchedulerLeader()) return;
  const targets = await schedulerTargets();
  if (targets === null) return tick();     // 단일 테넌트 배포 — 종전 경로
  for (const t of targets) {
    // 한 워크스페이스의 실패가 나머지를 막지 않는다(잡 단위 격리는 executeAndRecord 가 이미 한다).
    try { await withTenant(t, () => tick()); }
    catch (e) { logger.warn({ err: e, workspace: t.slug }, "scheduler tick failed (workspace)"); }
  }
}

async function tick(): Promise<void> {
  let jobs: CronJob[];
  try { jobs = await q(itemsPool, `SELECT * FROM org_cron WHERE enabled=true`); }
  catch { return; } // 테이블 부재/DB 미연결 → 조용히 패스(다음 틱 재시도).

  const tz = await orgTimezone(); // 틱당 1회(캐시) — cron_expr 벽시계 기준.
  const now = Date.now();
  for (const job of jobs) {
    if (running.has(job.id)) continue; // 진행 중 → 중첩 skip.
    if (!isDue(job, now, tz)) continue;
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
  //  ★ 선출을 **함께** 시작한다 (#2664 3단계). 부트 순서에 기대지 않으려는 것이다 —
  //   스케줄러를 켜는 쪽이 어디든, 켜는 순간 «내가 돌 자격이 있나» 를 묻는 장치도 함께 선다.
  //   멱등이라 위탁 큐가 또 불러도 한 번만 선다.
  startSchedulerLeadership();
  logger.info("scheduler started (in-process, org_cron) — 리더일 때만 틱이 돈다");
  timer = setInterval(() => { tickAllTenants().catch((e) => logger.warn({ err: e }, "scheduler tick failed")); }, TICK_MS);
  if (timer.unref) timer.unref(); // 스케줄러 타이머가 프로세스 정상 종료를 막지 않게.
  // 기존 설치 이행(#586) — notion 활성 커넥터의 일일 full 스윕 잡이 없으면 생성(커넥터 재저장 없이도 적용).
  //  증분이 델타(변경 비례)로 바뀌면서 아카이브·멘션 제목·댓글 단독 변경의 수렴은 이 잡이 담보한다.
  void (async () => {
    try {
      const on = await q(itemsPool, `SELECT 1 FROM org_connector WHERE system='notion' AND enabled=true`);
      if (!on.length) return;
      await q(itemsPool,
        `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled)
           VALUES('sync-notion-full','Notion 일일 전체 스윕(아카이브·완결성)','connector_sync','{"system":"notion","full":true}'::jsonb,86400,true)
         ON CONFLICT (tenant_id, id) DO NOTHING`);
    } catch (e) { logger.warn({ err: (e as Error)?.message }, "notion full 스윕 잡 보장 실패(비치명)"); }
  })();
}

// #1780 v2 §7-1 — 실-DB 스모크(scripts/app-cron-redeploy.itest.mjs)가 "재전개 직후 due 아님" 경계를 재기 위한 노출. 운영 호출 금지.
export const __test_isDue = isDue;

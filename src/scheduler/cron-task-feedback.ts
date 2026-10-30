// 크론이 낸 헤드리스 위탁의 **실제 결과**를 org_cron 에 되먹인다.
//
// 왜 필요한가: 헤드리스 액션(scheduler/actions/_headless.ts)의 책임은 «위탁 접수»까지라, 태스크를 만들어
//  배치하면 그 자리에서 ok 를 반환한다. 그 조기 반환값이 org_cron.last_status 에 박히므로, 그 뒤 태스크가
//  죽어도 크론은 계속 «정상»으로 보인다 — 관리 화면만 보는 사람은 고장을 영영 모른다.
//
// ⚠ **이 되먹임이 고치는 것은 표시·감시 축뿐이다.** 연속 실패 자동 정지(scheduler/cron-breaker.ts)는
//  DB 의 last_status 가 아니라 **그 실행의 인프로세스 반환값**을 센다(engine.ts 의 `cronBreakerDecision({
//  status: res.status … })`). 그 반환값은 헤드리스에선 늘 «접수 성공»이라, 여기서 error 를 적어도
//  fail_streak 는 오르지 않고 다음 주기의 접수 ok 가 카운터를 0 으로 되돌린다. 즉 **헤드리스 잡은 자동
//  정지에 도달하지 않는다** — 그래서 ops/cron-watch.ts 의 알림이 이 축의 유일한 창구다.
//  (여기서 fail_streak 를 같이 올리지 않는 이유: 그 카운터의 리셋이 접수 ok 에 걸려 있어, 한쪽만 고치면
//   «올렸다 지웠다» 가 반복된다. 고치려면 브레이커의 입력 자체를 바꿔야 하고 그건 별개 작업이다.)
//
// 어디서 부르나 — **task-store.markFinished**(org_task 를 종결로 바꾸는 유일한 자리)에서 부른다.
//  종결 경로가 여럿이라(정상 종료·타임아웃·무출력 stall·노드 유실·자격 없음·대기시간 초과) 그 중 하나를
//  고르면 반드시 새는데, 그것들이 공통으로 지나는 병목이 markFinished 다.
//  검증: `grep -rn "UPDATE org_task SET status" src` 가 done/failed 를 쓰는 문장은 markFinished 하나다.
//  (canceled 로 닫는 두 문장은 일부러 뺀다 — 사람이 취소한 것이고, 자격 실패 취소는 그 경로가 크론을
//   이미 멈추고 따로 알린다: node/auth-failure-response.ts.)
import { itemsPool } from "../db/client.js";

/**
 * 위탁의 `requester_session` 에서 크론 잡 id 를 뽑는다(순수). 크론 유래가 아니면 null.
 *
 * 규약의 출처는 `enqueueHeadlessTask` 의 marker: 기본은 `cron:<jobId>`, 한 잡이 배치를 갈라 낼 때는
 *  `cron:<jobId>#<batchKey>`. `#` 뒤는 **배치 구분**이지 잡 id 의 일부가 아니다
 *  (같은 분해를 node/auth-failure-response.cancelQueuedForCron 이 SQL `split_part(…, '#', 1)` 로 한다).
 */
export function cronJobIdOf(requesterSession: string | null | undefined): string | null {
  if (typeof requesterSession !== "string") return null;
  if (!requesterSession.startsWith("cron:")) return null;
  const id = requesterSession.slice("cron:".length).split("#")[0].trim();
  return id || null;
}

/**
 * 위탁 종결 → 크론이 기록할 상태 낱말.
 *
 * `error` 인 이유는 **화면·감시기가 이미 아는 낱말**이기 때문이다(액션들이 실패를 그렇게 반환한다).
 *  자동 정지와는 무관하다 — 그 축이 왜 안 걸리는지는 이 파일 머리말 참조.
 */
export function cronStatusOf(ok: boolean): "ok" | "error" {
  return ok ? "ok" : "error";
}

export interface CronFeedbackUpdate { sql: string; params: unknown[] }

/**
 * 되먹임 UPDATE 조립(순수) — DB 없이 «무엇을 쓰고 무엇을 안 쓰는지»를 테스트가 고정하게 떼어 둔다.
 *
 * ⚠ `last_run_at` 은 **읽지도 쓰지도 않는다.**
 *  · 쓰지 않는 이유: 그 값은 «잡이 언제 돌기 시작했나»이고 due 판정(engine.isDue)이 그것으로 다음 실행을
 *    계산한다. 종료 시각으로 덮으면 잡 주기가 실행시간만큼 밀린다.
 *  · **읽지도** 않는 이유: 그것으로 «더 최근 실행이 있었나»를 재면 정작 고치려던 실패들을 버린다.
 *    헤드리스 중첩 가드는 이전 태스크가 아직 도는 중이어도 status=ok 를 반환하고(_headless.ts 의 skip
 *    분기), 엔진은 그 반환에도 last_run_at 을 새로 쓴다 — 즉 **오래 도는 태스크의 잡은 매 주기
 *    last_run_at 이 앞으로 밀린다.** 그 태스크가 나중에 타임아웃·stall·대기초과로 죽으면 시각 비교가
 *    거짓이 되어 되먹임이 통째로 드롭됐다(= 침묵, 이 기능이 없던 때와 같음). 앱 시계(last_run_at)와
 *    DB now()(created_at)의 도메인이 다른 문제도 같이 따라왔다.
 *
 * 그래서 순서는 **단조 증가하는 task_id** 로 잰다. 요약에 적힌 id 보다 **크지 않은** 태스크만 쓴다:
 *  · 접수·skip 요약 둘 다 `task_id` 를 싣는다(_headless.ts) → 같은 태스크면 통과, 새 실행이 돌았으면
 *    그 id 가 더 커서 차단된다(늦게 끝난 옛 태스크가 새 실행의 상태를 덮지 않는다).
 *  · 최상위 `task_id` 가 없는 요약(배치를 나눠 싣는 증류 잡 등)은 첫 조건으로 통과한다 — 그 잡은
 *    «마지막에 끝난 배치가 잡 상태를 말한다». 더 정교하게 하려면 배치별 상태 모델이 필요하다.
 *
 * `last_summary` 는 통째로 갈지 않고 **덧댄다** — 접수 시점에 적힌 것(task_id·하네스·모델)이 원인 추적에
 *  필요하고, 그걸 잃으면 «무엇으로 돌다 죽었나»를 되짚을 근거가 사라진다.
 */
export function buildCronFeedbackUpdate(o: {
  jobId: string; taskId: number; ok: boolean; error?: string | null;
}): CronFeedbackUpdate {
  const patch = {
    task_id: o.taskId,
    task_status: o.ok ? "done" : "failed",
    task_error: o.error ? String(o.error).slice(0, 500) : null,
  };
  return {
    sql: `UPDATE org_cron
             SET last_status=$2,
                 last_summary=COALESCE(last_summary,'{}'::jsonb) || $3::jsonb,
                 updated_at=now()
           WHERE id=$1
             AND ((last_summary->>'task_id') IS NULL OR (last_summary->>'task_id')::bigint <= $4)`,
    params: [o.jobId, cronStatusOf(o.ok), JSON.stringify(patch), o.taskId],
  };
}

/** 되먹임 1건. **던지지 않는다** — 이 경로가 실패해도 위탁 종결(markFinished)은 이미 끝난 일이다. */
export async function recordCronTaskOutcome(o: {
  jobId: string; taskId: number; ok: boolean; error?: string | null;
}): Promise<void> {
  const { sql, params } = buildCronFeedbackUpdate(o);
  try {
    await itemsPool.query(sql, params);
  } catch { /* 표 부재·권한 등 — 되먹임은 관측일 뿐이라 위탁 종결을 깨뜨리지 않는다 */ }
}

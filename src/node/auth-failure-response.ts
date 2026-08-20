// 자격(인증) 실패 대응(#1675 ②③) — **첫 401 에서 멈추고 알린다.**
//
// 어니스트 2026-08-12 의 24시간은 "아무도 안 멈췄다"가 만든 시간이다. 토큰이 폐기된 뒤에도 증류 크론은
//  10분마다 9건씩 위탁을 계속 냈고, 200건 넘게 연속 실패하는 동안 어떤 제동도 없었으며, 사람은 그 사실을
//  **"DB 연결 불가" 알림**으로 알게 됐다 — 원인에서 다섯 단계 떨어진 증상으로.
//  첫 실패에서 알렸다면 5분짜리 사건이었다.
//
// 여기서 하는 일 세 가지:
//  ① **그 위탁을 낸 크론을 멈춘다** — 이게 곧 후속 접수 차단이다(②). 별도의 '차단 상태'를 만들지 않는 이유는
//     영구 차단 함정 때문이다: requester 단위 게이트를 두면, 노드 로컬 자격으로 도는 위탁처럼
//     member_secret 이 안 바뀌는 경로가 영원히 막힌다. 크론 정지는 **관리탭에서 다시 켜면 풀린다** —
//     해제 경로가 사람 눈에 보이고, 그 행위가 곧 "고쳤다"는 명시적 의사표시다.
//  ② **큐에 남은 같은 크론의 위탁을 정리한다** — 안 그러면 이미 쌓인 것들이 줄줄이 401 로 죽으며
//     실패 세션을 또 만든다.
//  ③ **알린다** — 쿨다운으로 폭탄을 막되(9레인이 동시에 죽는다), 첫 건은 반드시 나간다.
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { sendBoxAlert } from "../ops/alerts.js";
import type { AuthFailure } from "./task-failure.js";

/**
 * 같은 자격에 대한 알림 쿨다운(ms). 증류 크론은 한 주기에 9레인이 **동시에** 죽는다 — 쿨다운이 없으면
 *  알림 9개가 한꺼번에 나가고, 그 다음 주기에 또 9개가 나간다(사고 당시 하루 1,296건 규모).
 *  첫 건만 보내고 나머지는 접는다. 크론은 어차피 ①에서 멈추므로 다음 주기는 오지 않는다.
 */
const ALERT_COOLDOWN_MS = Math.max(60_000, Number(process.env.LIVELY_AUTH_ALERT_COOLDOWN_MS ?? 30 * 60_000));

/** requester → 마지막 알림 시각. 프로세스 메모리(재시작하면 초기화 = 다시 알린다 — 안전한 쪽). */
const lastAlertAt = new Map<string, number>();

/** 테스트·운영 리셋용. */
export function resetAuthAlertCooldown(): void { lastAlertAt.clear(); }

/**
 * 쿨다운 판정(순수) — 지금 알려야 하나.
 * `last` 가 없으면(첫 실패) 무조건 알린다. 이 함수가 참을 돌려주면 호출부가 시각을 갱신한다.
 */
export function shouldAlertNow(last: number | undefined, now: number, cooldownMs = ALERT_COOLDOWN_MS): boolean {
  return last === undefined || now - last >= cooldownMs;
}

export interface AuthFailureContext {
  taskId: number;
  requester: string;
  /** 위탁 마커(`cron:<job>#<lane>`) — 여기서 멈출 크론이 나온다. 사람이 낸 위탁이면 null. */
  cronJobId: string | null;
  auth: AuthFailure;
}

export interface AuthFailureOutcome {
  /** 크론을 실제로 멈췄나(이미 꺼져 있었으면 false). */
  cronStopped: boolean;
  /** 큐에서 걷어낸 후속 위탁 수. */
  queuedCanceled: number;
  /** 알림을 보냈나(쿨다운에 걸렸으면 false). */
  alerted: boolean;
}

/**
 * 크론 정지 — 멱등. 이미 enabled=false 면 아무 일도 안 한다(rowCount 0).
 * ④ 서킷 브레이커와 **같은 컬럼**(auto_disabled_*)에 흔적을 남긴다 — 관리탭이 "왜 꺼졌나"를 한 자리에서 읽고,
 *  사람이 다시 켤 때 cron-store 의 초기화 규칙이 그대로 적용된다.
 * ⚠ last_summary 는 건드리지 않는다 — 거기 마지막 실행의 원인 진단이 들어 있다.
 */
async function stopCron(jobId: string, reason: string): Promise<boolean> {
  const r = await itemsPool.query(
    `UPDATE org_cron SET enabled=false, auto_disabled_at=now(), auto_disabled_reason=$2, updated_at=now()
      WHERE id=$1 AND enabled=true`, [jobId, reason]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 같은 크론이 낸 **대기 중** 위탁을 걷어낸다(②).
 * 실행 중(running)은 건드리지 않는다 — 이미 워커가 붙어 있고, 곧 자기 경로로 종결된다.
 */
async function cancelQueuedForCron(jobId: string): Promise<number> {
  // ⚠ LIKE 패턴이 아니라 **접두 일치**로 판정한다. 잡 id 에는 `_`(refresh_all·map_unmapped …)가 흔한데
  //  LIKE 에서 `_` 는 임의 1글자 와일드카드라, `cron:map_unmapped#…` 패턴이 `cron:mapXunmapped#…` 까지 잡는다
  //  — **남의 크론이 낸 대기 위탁을 취소할 수 있다**(#1675 리뷰). split_part 로 레인을 떼고 정확히 비교한다.
  const r = await itemsPool.query(
    `UPDATE org_task SET status='canceled', finished_at=now(), updated_at=now(),
            error=COALESCE(error,'') || $2
      WHERE status='queued' AND split_part(requester_session, '#', 1) = $1`,
    [`cron:${jobId}`, "자격(인증) 실패로 해당 크론이 정지되어 취소됨(#1675)"]);
  return r.rowCount ?? 0;
}

/**
 * 자격 실패 1건에 대한 대응 일체. **throw 하지 않는다** — 이 경로가 스케줄러 tick 을 깨면 안 된다.
 *
 * `deps` 는 테스트 seam. 실사용은 인자 없이.
 */
export async function handleAuthFailure(
  ctx: AuthFailureContext,
  policy: { stopCron: boolean },
  deps?: {
    stop?: (jobId: string, reason: string) => Promise<boolean>;
    cancelQueued?: (jobId: string) => Promise<number>;
    alert?: typeof sendBoxAlert;
    now?: () => number;
  },
): Promise<AuthFailureOutcome> {
  const now = (deps?.now ?? Date.now)();
  const stop = deps?.stop ?? stopCron;
  const cancelQueued = deps?.cancelQueued ?? cancelQueuedForCron;
  const alert = deps?.alert ?? sendBoxAlert;

  const out: AuthFailureOutcome = { cronStopped: false, queuedCanceled: 0, alerted: false };
  const reason = `위탁 #${ctx.taskId} 자격 실패: ${ctx.auth.label}`;

  if (ctx.cronJobId && policy.stopCron) {
    try { out.cronStopped = await stop(ctx.cronJobId, reason); }
    catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 크론 정지 실패"); }
    try { out.queuedCanceled = await cancelQueued(ctx.cronJobId); }
    catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 대기 위탁 정리 실패"); }
  }

  // 알림은 크론 정지 **뒤에** — 사람이 알림을 읽는 시점에 이미 멈춰 있어야 한다.
  if (shouldAlertNow(lastAlertAt.get(ctx.requester), now)) {
    const what = ctx.cronJobId
      ? (out.cronStopped
        ? `크론 '${ctx.cronJobId}' 를 자동으로 정지했습니다(대기 중이던 위탁 ${out.queuedCanceled}건도 취소).`
        : `크론 '${ctx.cronJobId}' 는 이미 정지 상태이거나 정지에 실패했습니다 — 관리탭에서 확인하세요.`)
      : "사람이 직접 낸 위탁이라 멈출 크론은 없습니다.";
    try {
      const r = await alert({
        severity: "critical",
        title: `헤드리스 자격 실패 — ${ctx.requester}`,
        text:
          `위탁 #${ctx.taskId} 이(가) **${ctx.auth.label}** 로 실패했습니다. ${what}\n`
          + `조치: ${ctx.requester} 계정에서 \`claude setup-token\` 을 다시 발급해 관리 ▸ 내 로그인 ▸ Claude(헤드리스 실행)에 등록한 뒤,`
          + ` 관리탭에서 그 크론을 다시 켜세요. 재발급 전까지는 재시도해도 같은 결과입니다.\n`
          + `판정 근거: ${ctx.auth.evidence}`,
        detail: {
          task_id: ctx.taskId, requester: ctx.requester, cron_job: ctx.cronJobId,
          label: ctx.auth.label, from: ctx.auth.from,
          cron_stopped: out.cronStopped, queued_canceled: out.queuedCanceled,
        },
      });
      out.alerted = r.sent;
      // ⚠ 쿨다운은 **실제로 나갔을 때만** 찍는다(#1675 리뷰). 종전엔 보내기 전에 찍어서, 웹훅 복호화 실패처럼
      //  회복 가능한 사유로 전송이 실패해도 30분간 침묵했다 — 사고의 '아무도 몰랐다' 모드를 그대로 재현한다.
      //  단 '미설정'·'임계 미만'은 재시도해도 결과가 같으므로 찍어서 로그 폭주를 막는다.
      if (r.sent || r.reason === "웹훅 미설정" || r.reason === "임계 미만(min_severity)") lastAlertAt.set(ctx.requester, now);
      if (!r.sent) logger.warn({ reason: r.reason, task: ctx.taskId }, "자격 실패 알림 미발송");
    } catch (e) {
      logger.warn({ err: (e as Error)?.message, task: ctx.taskId }, "자격 실패 알림 실패");
    }
  }

  logger.warn({
    task: ctx.taskId, requester: ctx.requester, job: ctx.cronJobId, label: ctx.auth.label,
    cronStopped: out.cronStopped, queuedCanceled: out.queuedCanceled, alerted: out.alerted,
  }, "위탁 자격(인증) 실패 — 대응 완료");
  return out;
}

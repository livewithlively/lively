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
//     단 **레인마다 실행 계정이 다른 잡**(증류·카테고리 붙이기·관리 — 레인이 자기 «실행 계정» 을 가진다)에서 잡의
//     실행 계정이 아닌 레인 계정이 죽었으면, 크론 대신 **그 계정이 도는 레인만** 끈다. 크론을 멈추면 멀쩡한 계정의
//     레인까지 같이 서기 때문이다(2026-10-02: 한 계정의 OAuth 만료로 다른 계정의 레인 9개가 9일 멈췄다).
//     해제 경로는 같다 — 관리탭에서 그 레인을 다시 켠다.
//  ② **큐에 남은 같은 크론의 위탁을 정리한다** — 안 그러면 이미 쌓인 것들이 줄줄이 401 로 죽으며
//     실패 세션을 또 만든다. 레인만 끊었으면 **그 계정의 위탁만** 걷는다.
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

/**
 * 이 사람의 **마지막 자격 실패**(#1675 ③ — 관리탭 '내 로그인' 표시용).
 *
 * 왜 필요: 헤드리스 토큰이 죽으면 알림이 한 번 가지만, 그 알림을 놓치거나 나중에 들어온 사람은
 *  "내 토큰이 지금 살아 있나"를 알 길이 없었다. 자격 화면이 그 답을 갖고 있어야 한다 —
 *  `last_used_at`(마지막으로 리스된 시각)만으로는 **성공했는지 실패했는지** 구분되지 않는다.
 *
 * 실패 판정 근거는 종결된 위탁의 `result.auth_failure`(finish 가 남긴다). 없으면 null.
 */
export interface LastAuthFailure { at: string | null; label: string; task_id: number }
export async function lastAuthFailureFor(requester: string): Promise<LastAuthFailure | null> {
  try {
    const r = await itemsPool.query(
      `SELECT id, finished_at, result->'auth_failure'->>'label' AS label
         FROM org_task
        WHERE requester = $1 AND result -> 'auth_failure' IS NOT NULL
          -- ⚠ 기간을 자른다(#1675 리뷰). 두 가지를 동시에 막는다:
          --  ① org_task 는 지우는 경로가 없어 계속 자란다 — 이 조회는 '내 로그인' 화면을 열 때마다 돈다.
          --  ② 노드 **로컬** 자격으로 돌던 위탁의 실패도 여기 잡히는데, 그건 member_secret 을 다시 등록해도
          --     안 사라진다(그 자격이 아니므로). 기간이 없으면 그 경고가 영원히 붙는다.
          AND finished_at > now() - interval '30 days'
        ORDER BY finished_at DESC NULLS LAST, id DESC
        LIMIT 1`, [requester]);
    const row = r.rows[0] as { id: number; finished_at: string | null; label: string | null } | undefined;
    if (!row) return null;
    return { at: row.finished_at ?? null, label: row.label || "자격 실패", task_id: row.id };
  } catch {
    return null;   // org_task 부재 등 — 화면이 이것 때문에 죽으면 안 된다
  }
}

export interface AuthFailureContext {
  taskId: number;
  requester: string;
  /** 위탁 마커(`cron:<job>#<lane>`) — 여기서 멈출 크론이 나온다. 사람이 낸 위탁이면 null. */
  cronJobId: string | null;
  /** 같은 마커의 `#` 뒤 레인 키. 레인 없이 낸 위탁이면 null(생략 = null). */
  lane?: string | null;
  auth: AuthFailure;
}

export interface AuthFailureOutcome {
  /** 크론을 실제로 멈췄나(이미 꺼져 있었으면 false). */
  cronStopped: boolean;
  /** 크론 대신 끈 레인 키(레인 격리를 했을 때만 채워진다 — 이미 꺼져 있던 레인은 빠진다). */
  lanesStopped: string[];
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
 * 배치를 낼 때 task_id 와 함께 «판정함» 을 찍는 표 — 증류 레인 · 방치 배치 · 카테고리 붙이기 레인.
 *  실패 종결(task-store.markFinished)이 되돌리는 표와 **같은 집합**이어야 한다(pipeline-honest ⑳-b 가 스키마·markFinished 와 묶는다).
 */
export const TASK_SEEN_TABLES = ["org_distiller_seen", "org_stranded_seen", "org_classifier_seen"] as const;

/**
 * 취소한 위탁의 판정 기록을 되돌린다 — markFinished(실패)와 같은 축.
 *  안 하면 그 배치가 «봤음» 으로 찍어 둔 자료·지식은 크론이나 레인을 다시 켜도 인박스에 돌아오지 않는다 — 인박스는
 *  `seen_at >= updated_at` 으로 거르므로 원본이 바뀔 때까지다(무증상 유실). 레인 격리는 «꺼진 레인의 몫은 다시 켤 때까지
 *  기다린다» 를 약속하므로, 취소분이 빠지면 그 약속이 조용히 깨진다.
 *  표마다 따로 시도한다 — 구 스키마에 없는 표가 있어도 나머지는 되돌린다(실패는 삼키되 한 줄 남긴다).
 */
async function releaseSeen(taskIds: number[]): Promise<void> {
  if (!taskIds.length) return;
  for (const table of TASK_SEEN_TABLES) {
    try { await itemsPool.query(`DELETE FROM ${table} WHERE task_id = ANY($1::bigint[])`, [taskIds]); }
    catch (e) { logger.warn({ err: (e as Error)?.message, table }, "자격 실패 — 취소한 위탁의 판정 기록 해제 실패"); }
  }
}

/**
 * 같은 크론이 낸 **대기 중** 위탁을 걷어낸다(②). 걷은 위탁의 판정 기록도 되돌린다(releaseSeen).
 * 실행 중(running)은 건드리지 않는다 — 이미 워커가 붙어 있고, 곧 자기 경로로 종결된다.
 */
async function cancelQueuedForCron(jobId: string): Promise<number> {
  // ⚠ LIKE 패턴이 아니라 **접두 일치**로 판정한다. 잡 id 에는 `_`(refresh_all·map_unmapped …)가 흔한데
  //  LIKE 에서 `_` 는 임의 1글자 와일드카드라, `cron:map_unmapped#…` 패턴이 `cron:mapXunmapped#…` 까지 잡는다
  //  — **남의 크론이 낸 대기 위탁을 취소할 수 있다**(#1675 리뷰). split_part 로 레인을 떼고 정확히 비교한다.
  const r = await itemsPool.query(
    `UPDATE org_task SET status='canceled', finished_at=now(), updated_at=now(),
            error=COALESCE(error,'') || $2
      WHERE status='queued' AND split_part(requester_session, '#', 1) = $1 RETURNING id`,
    [`cron:${jobId}`, "자격(인증) 실패로 해당 크론이 정지되어 취소됨(#1675)"]);
  await releaseSeen((r.rows as Array<{ id: number | string }>).map((x) => Number(x.id)));
  return r.rowCount ?? 0;
}

/**
 * 끊는 범위(순수) — 크론 전체인가, 그 계정의 레인만인가.
 *
 * 레인만 끊는 건 **세 조건이 다 맞을 때뿐**이다. 하나라도 모르면 종전대로 크론을 멈춘다 — 안 멈춰서 잃는 것
 *  (같은 401 반복)이 더 멈춰서 잃는 것(멀쩡한 레인의 지연)보다 크다.
 *  · 레인 마커가 있다 — 어느 레인이 죽었는지 안다.
 *  · 그 잡이 레인을 끌 수 있다(`laneCapable`) — 레인 스위치가 없는 잡이면 끌 단위가 크론뿐이다.
 *  · 죽은 계정이 **잡의 실행 계정이 아니다** — 잡 계정이 죽었으면 계정을 따로 안 정한 레인이 전부 같이 죽으므로
 *    크론을 멈추는 게 맞고, 관리자가 다시 켤 스위치도 하나로 끝난다.
 */
export function authFailureScope(o: {
  cronJobId: string | null; lane: string | null; requester: string;
  laneCapable: boolean; jobRunner: string | null;
}): "none" | "cron" | "lanes" {
  if (!o.cronJobId) return "none";
  if (o.lane && o.laneCapable && o.jobRunner && o.jobRunner !== o.requester) return "lanes";
  return "cron";
}

/**
 * 레인 격리가 가능한 잡의 액션 → 레인 테이블. 각 행이 레인이고 «실행 계정»(requester) 칸을 가진다.
 *  여기 없는 액션은 크론 정지로 대응한다(덜 멈추지 않는 쪽). 액션을 넣으려면 꺼진 레인의 몫이 다른 레인·전역 폴백으로
 *  새지 않는지(org/distill/lanes.isAutoDisabledLane 을 읽는 자리)를 먼저 갖춰야 한다 — 관리는 끄면 발견이 안 생길 뿐이라 불필요.
 *  ⚠ stopLanes 는 이 값을 SQL 식별자로 그대로 쓴다 — 테이블 이름은 이 맵에서만 나와야 한다(입력에서 오면 SQL 인젝션).
 */
export const LANE_TABLES = {
  distill_sources_headless: "org_distiller",
  classify_knowledge_headless: "org_classifier",
  run_managers: "org_manager",
} as const;
export type LaneTable = typeof LANE_TABLES[keyof typeof LANE_TABLES];

/** 잡 액션의 레인 테이블(순수) — 레인 격리를 못 하는 액션이면 null. 프로토타입 키(`toString` 등)가 테이블로 새지 않게 own 키만 본다. */
export function laneTableFor(action: string | null | undefined): LaneTable | null {
  if (!action || !Object.prototype.hasOwnProperty.call(LANE_TABLES, action)) return null;
  return LANE_TABLES[action as keyof typeof LANE_TABLES];
}

/**
 * 마커의 레인 조각 → 레인 테이블의 key(순수).
 *  관리 잡은 레포별로 마커를 한 번 더 가른다(`cron:<잡>#<관리기 key>@<repo>` — scheduler/actions/manage.ts). 그 `@` 뒤를
 *  떼지 않으면 그런 key 가 없어 stopLanes 가 던지고 크론 전체로 올라간다. 자르는 건 관리 테이블에서만 한다 —
 *  증류기 key 는 정규화하지 않아 `@` 가 들어갈 수 있으므로(store/ingest.upsertDistiller), 마커 파서(task-failure.cronLaneFromMarker)를
 *  일괄로 바꾸면 그런 레인을 엉뚱한 key 로 찾는다.
 */
export function laneKeyFor(table: LaneTable, lane: string): string {
  if (table !== "org_manager") return lane;
  const at = lane.indexOf("@");
  return at < 0 ? lane : lane.slice(0, at);
}

/** 알림 문구의 레인 이름(순수) — 관리탭에서 사람이 찾아갈 화면의 이름과 맞춘다. 테이블을 모르면 일반명. */
export function laneNoun(table: LaneTable | null): string {
  return table === "org_distiller" ? "자료 증류 레인"
    : table === "org_classifier" ? "카테고리 붙이기 레인"
    : table === "org_manager" ? "관리기"
    : "레인";
}

export interface JobRunnerInfo { table: LaneTable | null; runner: string | null }

/** 워크스페이스 실행 멤버(context_job_policy.runner_member) — 못 읽으면 **던진다**(jobRunnerOf 머리주석). */
async function readWorkspaceRunner(): Promise<string | null> {
  const { getRuntimeConfig } = await import("../org/store.js");
  return (await getRuntimeConfig()).context_job_policy?.runner_member ?? null;
}

export interface CronJobRow { action: string; params: Record<string, unknown> | null; created_by: string | null }

/**
 * 잡 행 → 레인 테이블과 잡 실행 계정(레인이 계정을 정하지 않았을 때 쓰는 계정).
 *  분배 경로(scheduler/actions/distill.runDistillHeadless · classify.runClassifyKnowledgeHeadless · manage.runManagers)와
 *  **같은 함수**(resolveJobRunner)로 푼다 — 따로 풀면 잡 계정이 죽었는데도 «레인 계정» 으로 오판해 레인만 하나씩 끄는 일이 생긴다.
 *  ⚠ 단 워크스페이스 실행 멤버는 **여기서 먼저 읽고, 못 읽으면 던진다**(호출부가 크론 정지로 대응한다).
 *   resolveJobRunner 는 설정 조회 실패를 삼키고 created_by 로 내려간다 — 분배 쪽에선 잡을 세우지 않으려는 선택이지만,
 *   판정 쪽에서 그러면 분배 때와 다른 계정을 «잡 계정» 으로 보고 덜 멈추는 쪽(레인 격리)으로 기운다.
 *   잡이 계정을 명시했으면 설정은 안 본다 — 분배와 같은 우선순위라 설정이 답을 바꾸지 않으므로, 못 읽어도 모르는 게 아니다.
 */
export async function jobRunnerOf(
  row: CronJobRow,
  workspaceRunner: () => Promise<string | null> = readWorkspaceRunner,
): Promise<JobRunnerInfo> {
  const { explicitRunner, resolveJobRunner } = await import("../scheduler/actions/_headless.js");
  const explicit = explicitRunner(undefined, row.params?.requester);
  const ws = explicit ? null : await workspaceRunner();
  const runner = await resolveJobRunner(explicit, row.created_by, async () => ws);
  return { table: laneTableFor(row.action), runner: runner || null };
}

/** 잡의 레인 테이블과 실행 계정. 잡이 없으면 null. 실행 멤버 설정을 못 읽으면 던진다(jobRunnerOf). */
async function loadJobRunner(jobId: string): Promise<JobRunnerInfo | null> {
  const r = await itemsPool.query(`SELECT action, params, created_by FROM org_cron WHERE id=$1`, [jobId]);
  const row = r.rows[0] as CronJobRow | undefined;
  return row ? jobRunnerOf(row) : null;
}

/**
 * 죽은 계정이 도는 레인을 끈다 — 실패한 그 레인과, 같은 계정을 «실행 계정» 으로 명시한 다른 레인.
 *  같은 계정의 레인을 함께 끄는 이유: 다음 주기에 하나씩 죽으며 실패 세션과 알림을 또 만든다.
 *  끈 이유는 `last_status`·`last_summary` 에 남긴다(레인 화면이 이미 보여 주는 칸 — 따로 컬럼을 만들지 않는다).
 */
async function stopLanes(table: LaneTable, lane: string, requester: string, reason: string): Promise<string[]> {
  //  테스트 seam·호출부 실수로 맵 밖 문자열이 와도 식별자로 쓰지 않는다.
  if (!(Object.values(LANE_TABLES) as string[]).includes(table)) throw new Error(`레인 테이블이 아님: ${String(table)}`);
  const r = await itemsPool.query(
    //  last_summary 는 **병합**한다 — 마지막 실행의 진단을 지우지 않는다(stopCron 이 last_summary 를 안 건드리는 이유와 같다).
    //  auto_disabled 표식은 이 레인이 꺼져 있어도 자기 몫을 계속 맡게 하고(org/distill/lanes.isAutoDisabledLane),
    //   «자격 실패로 꺼진 레인» 과 «사람이 끈 레인» 을 가를 재료를 남긴다 — 레인 화면은 아직 이 표식을 읽지 않는다(`grep -rn auto_disabled web/`).
    `UPDATE ${table} SET enabled=false, last_status='error',
            last_summary=(CASE WHEN jsonb_typeof(last_summary)='object' THEN last_summary ELSE '{}'::jsonb END) || $3::jsonb,
            updated_at=now()
      WHERE enabled=true AND (key=$1 OR requester=$2) RETURNING key`,
    [lane, requester, JSON.stringify({ error: reason, auto_disabled: true, auto_disabled_reason: reason })]);
  const keys = (r.rows as Array<{ key: string }>).map((x) => x.key);
  //  0건은 «이미 꺼짐» 이어야 한다. 마커의 레인 키가 레인 테이블에 아예 없으면(이름 변경·삭제) 아무것도 못 끈 것이므로
  //   던져서 호출부가 크론 정지로 올리게 한다 — 조용히 넘어가면 다음 주기에 같은 401 이 반복된다.
  if (!keys.length) {
    const e = await itemsPool.query(`SELECT 1 FROM ${table} WHERE key=$1`, [lane]);
    if (!e.rowCount) throw new Error(`레인 '${lane}' 이 ${table} 에 없음`);
  }
  return keys;
}

/** 같은 크론이 낸 대기 위탁 중 **그 계정의 것만** 걷는다(레인 격리판 ②). 걷은 위탁의 판정 기록도 되돌린다(releaseSeen). */
async function cancelQueuedForRequester(jobId: string, requester: string): Promise<number> {
  const r = await itemsPool.query(
    `UPDATE org_task SET status='canceled', finished_at=now(), updated_at=now(),
            error=COALESCE(error,'') || $3
      WHERE status='queued' AND split_part(requester_session, '#', 1) = $1 AND requester = $2 RETURNING id`,
    [`cron:${jobId}`, requester, "자격(인증) 실패로 그 계정의 레인이 정지되어 취소됨"]);
  await releaseSeen((r.rows as Array<{ id: number | string }>).map((x) => Number(x.id)));
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
    jobRunner?: (jobId: string) => Promise<JobRunnerInfo | null>;
    stopLanes?: (table: LaneTable, lane: string, requester: string, reason: string) => Promise<string[]>;
    cancelQueuedFor?: (jobId: string, requester: string) => Promise<number>;
    alert?: typeof sendBoxAlert;
    now?: () => number;
  },
): Promise<AuthFailureOutcome> {
  const now = (deps?.now ?? Date.now)();
  const stop = deps?.stop ?? stopCron;
  const cancelQueued = deps?.cancelQueued ?? cancelQueuedForCron;
  const alert = deps?.alert ?? sendBoxAlert;

  const out: AuthFailureOutcome = { cronStopped: false, lanesStopped: [], queuedCanceled: 0, alerted: false };
  const reason = `위탁 #${ctx.taskId} 자격 실패: ${ctx.auth.label}`;
  const lane = ctx.lane ?? null;

  // 범위 판정 — 잡을 못 읽으면 종전대로 크론을 멈춘다(판정 재료가 없을 때 덜 멈추는 쪽으로 기울지 않는다).
  let scope: "none" | "cron" | "lanes" = ctx.cronJobId ? "cron" : "none";
  let table: LaneTable | null = null;
  if (ctx.cronJobId && lane && policy.stopCron) {
    try {
      const job = await (deps?.jobRunner ?? loadJobRunner)(ctx.cronJobId);
      if (job) {
        table = job.table;
        scope = authFailureScope({ cronJobId: ctx.cronJobId, lane, requester: ctx.requester, laneCapable: !!job.table, jobRunner: job.runner });
      }
    } catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 잡 조회 실패, 크론 정지로 대응"); }
  }

  if (scope === "lanes" && lane && table) {
    //  레인 정지가 실패하면 크론으로 올린다 — 아무것도 안 멈춘 채로 끝나면 다음 주기에 같은 401 이 반복된다.
    try { out.lanesStopped = await (deps?.stopLanes ?? stopLanes)(table, laneKeyFor(table, lane), ctx.requester, reason); }
    catch (e) { logger.warn({ err: (e as Error)?.message, lane }, "자격 실패 — 레인 정지 실패, 크론 정지로 대응"); scope = "cron"; }
  }
  if (scope === "lanes" && ctx.cronJobId) {
    try { out.queuedCanceled = await (deps?.cancelQueuedFor ?? cancelQueuedForRequester)(ctx.cronJobId, ctx.requester); }
    catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 대기 위탁 정리 실패"); }
  } else if (scope === "cron" && ctx.cronJobId && policy.stopCron) {
    try { out.cronStopped = await stop(ctx.cronJobId, reason); }
    catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 크론 정지 실패"); }
    try { out.queuedCanceled = await cancelQueued(ctx.cronJobId); }
    catch (e) { logger.warn({ err: (e as Error)?.message, job: ctx.cronJobId }, "자격 실패 — 대기 위탁 정리 실패"); }
  }

  // 알림은 크론 정지 **뒤에** — 사람이 알림을 읽는 시점에 이미 멈춰 있어야 한다.
  //  레인을 **새로** 껐으면 쿨다운과 무관하게 알린다. 쿨다운은 «이미 꺼진» 레인의 연쇄 실패(같은 주기에 같은 계정 레인
  //   여럿이 죽는다)를 접는 장치다. 그런데 계정 하나가 죽으면 증류·카테고리 붙이기·관리 레인이 테이블마다 따로 꺼지고,
  //   둘째부터 접으면 그 레인들은 아무 말 없이 꺼진 채 몫을 붙잡고 남는다 — 사람은 첫 알림에 적힌 레인만 다시 켠다.
  const freshLanes = out.lanesStopped.length > 0;
  if (freshLanes || shouldAlertNow(lastAlertAt.get(ctx.requester), now)) {
    const noun = laneNoun(table);
    const what = scope === "lanes"
      ? (out.lanesStopped.length
        ? `크론 '${ctx.cronJobId}' 는 계속 돌고, 이 계정이 실행하는 ${noun} ${out.lanesStopped.map((k) => `'${k}'`).join(", ")} 만 껐습니다(대기 중이던 이 계정의 위탁 ${out.queuedCanceled}건도 취소).`
        : `이 계정이 실행하는 ${noun} '${table && lane ? laneKeyFor(table, lane) : lane}' 는 이미 꺼져 있습니다 — 크론 '${ctx.cronJobId}' 의 다른 ${noun}은 계속 돕니다.`)
      : ctx.cronJobId
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
          + `조치: ${ctx.requester} 님이 내 프로필 ▸ AI 계정 연결 ▸ «사람 없이 도는 작업» 에서 [다시 연결]을 누르게 한 뒤`
          + `(화면에서 setup-token 을 새로 발급해 저장한다 — #4051), 관리탭에서 ${scope === "lanes" ? `꺼진 ${noun}` : "그 크론"}을 다시 켜세요.`
          + ` 다시 연결하기 전까지는 재시도해도 같은 결과입니다.\n`
          + `판정 근거: ${ctx.auth.evidence}`,
        detail: {
          task_id: ctx.taskId, requester: ctx.requester, cron_job: ctx.cronJobId, lane,
          label: ctx.auth.label, from: ctx.auth.from,
          cron_stopped: out.cronStopped, lanes_stopped: out.lanesStopped, queued_canceled: out.queuedCanceled,
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
    task: ctx.taskId, requester: ctx.requester, job: ctx.cronJobId, lane, scope, label: ctx.auth.label,
    cronStopped: out.cronStopped, lanesStopped: out.lanesStopped, queuedCanceled: out.queuedCanceled, alerted: out.alerted,
  }, "위탁 자격(인증) 실패 — 대응 완료");
  return out;
}

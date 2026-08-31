// 매니지드에서 하우스키핑 정비를 **요청에 얹어** 돌린다 (#2246) — 그 스텝들이 안 도는 자리의 대체 경로.
//
//  이름이 outbox 로 시작하는 것은 처음 아웃박스 하나만 다뤘기 때문이고, 지금은 **정비 여럿**을 나른다.
import type { RequestHandler } from "express";
import { requestScopedTenancy } from "../boot/housekeeping.js";
import { currentTenant } from "../org/tenant-context.js";
import { logger } from "../log.js";

/** 아웃박스 정비 주기. 종전 하우스키핑 스윕과 **같은 자**(5분)를 쓴다 — 대체지 새 정책이 아니다. */
export const SWEEP_MIN_INTERVAL_MS = 5 * 60_000;

/** 대기 알림 주기. 아웃박스와 **달라야 한다** — 그쪽 주석이 이유를 적어 뒀다:
 *  *"알림은 5분 뒤에 오면 알림이 아니다."* 원래 스윕도 30초였다. */
export const AWAITING_SWEEP_INTERVAL_MS = 30_000;

/** 위탁 배차 주기. 원래 `task-scheduler` 의 `TICK_MS` 와 **같은 값**이다.
 *  ⓘ 요청에 얹으면 **원래보다 잦을 수 없다** — 요청이 와야 돌고 이 값이 상한이다.
 *   그래서 그대로 써도 부하가 종전 설계를 넘지 않는다(새 정책을 만들지 않는다). */
export const TASK_TICK_MS = 5_000;

/**
 * 요청에 얹어 돌릴 정비들.
 *
 *  ⚠ **표로 두는 이유** — `background-sweeps` 는 여덟 가지를 묶은 스텝이고 매니지드에선 통째로 안 돈다.
 *   #2246 이 그중 `resumeOutbox` 하나만 되살렸는데, 나머지를 세어 보니 또 하나가 사람에게 도달하는
 *   회귀였다(아래 awaiting). 앞으로도 더 나온다 — 그때 이 배열에 한 줄 더 넣으면 되게 한다.
 *   미들웨어를 고쳐야 한다면 그건 이 구조가 틀린 것이다.
 *
 *  ⚠ 정비마다 **주기가 다르다.** 하나로 묶으면 둘 중 하나는 반드시 틀린 주기로 돈다.
 */
export interface SweepJob {
  /** 디바운스 키와 로그에 쓰는 이름. */
  readonly key: string;
  /** 이 정비를 다시 돌리기까지의 최소 간격. */
  readonly intervalMs: number;
  /**
   * 이 정비가 **누구의 것인가**. 기본은 `"tenant"` — 요청이 가리킨 그 테넌트만 손보고,
   * 디바운스도 테넌트마다 따로다.
   *
   * `"global"` 은 **테넌트로 쪼갤 수 없는** 정비다(예: 위탁 배차는 노드 용량을 테넌트 가로질러
   * 집계한 뒤 배정하므로, 한 테넌트만 보면 남의 부하를 못 봐 노드를 초과 배정한다).
   * ⚠ 그래서 디바운스가 **테넌트를 안 탄다** — 안 그러면 테넌트 수만큼 같은 전량 작업이 중복된다.
   * ⓘ 그래도 «임의로 한 테넌트를 골라 돌린다»가 아니다: 대상 열거는 그 함수가 자기 안에서
   *  `schedulerTargets()` 로 하고 각각을 `withTenant` 로 감싼다(`scheduler/tenant-fanout.ts`).
   */
  readonly scope?: "tenant" | "global";
  /** 실제 정비. **여기서 새로 정의하지 않고** 원래 함수를 그대로 부른다(복제하면 한쪽만 고쳐진다). */
  readonly run: () => Promise<unknown>;
}

/** 원래 하우스키핑이 쓰던 주기 그대로 — 새 정책을 만들지 않는다(`background-sweeps` 의 setInterval 값). */
export const TEN_MIN_MS = 10 * 60_000;
export const SIX_HOURS_MS = 6 * 60 * 60_000;

export const SWEEP_JOBS: readonly SweepJob[] = [
  // 아웃박스 — 좀비 회수 + 끝난 행 청소 + 대기 세션 재-kick. RLS 가 이 테넌트로 스코프한다.
  { key: "outbox", intervalMs: SWEEP_MIN_INTERVAL_MS,
    run: () => import("./session-outbox.js").then((m) => m.resumeOutbox()) },
  // 대기 알림(#1891) — "하네스가 작업을 마치고 사람의 액션을 필요로 하면 알림".
  //  ⚠ 실측(2026-08-28): 매니지드 컷오버(8/26) 이후 이 알림이 **0건**이다. 그 전 이틀간 92건이 울렸고
  //   지금 세션이 959개다 — "전이가 없었다"로는 설명되지 않는다. **사람에게 도달하는 회귀였다.**
  //  ⓘ 이건 DB 가 아니라 **tmux** 를 읽는다(`listSessionsRaw`). 그래도 스코프는 선다 —
  //   중계 대상이 `tenantSlug()` 이고 그 리졸버가 `currentTenant()?.slug` 다(tenant-binding-boot).
  //  ⓘ 여러 테넌트가 한 프로세스를 공유해도 안전하다 — `pickAwaitingTransitions` 가 관측 안 된 항목을
  //   **지우지 않는다**(`new Map(previous)` + 추가만). 그래서 테넌트끼리 서로의 상태를 밀어내지 않는다.
  { key: "awaiting-notify", intervalMs: AWAITING_SWEEP_INTERVAL_MS,
    run: () => import("./awaiting-notifier.js").then((m) => m.sweepAwaitingNotifications()) },
  // 임베딩 백필(#669) — 실측: 지식 1472건 중 **15건이 미임베딩**이라 의미검색에 안 잡혔다.
  //  provider off 면 설정 조회 후 no-op 이라 켜 두어도 비용이 없다.
  { key: "embedding-backfill", intervalMs: TEN_MIN_MS,
    run: () => import("../v6/embedding-backfill.js").then((m) => m.runAutoBackfillSweep()) },
  // device-auth 리퍼(#880) — 만료 1h 지난 pending 정리(user_code 회수). 실측 2건 잔존.
  { key: "device-auth-reap", intervalMs: TEN_MIN_MS,
    run: () => import("../org/auth/device-auth.js").then((m) => m.reapDeviceAuth()) },
  // OAuth 리퍼(#1473 T2) — 만료된 인가요청·인가코드. 지금은 0건이지만 쌓이는 성질이라 올린다
  //  (리프레시는 회전 사슬이라 더 오래 두는 것이 원래 설계 — 그 판단은 그 함수 안에 있다).
  { key: "oauth-reap", intervalMs: TEN_MIN_MS,
    run: () => import("../org/store/oauth.js").then((m) => m.reapOAuth()) },
  // 세션이력 retention(#905 C1) — 보존기간 지난 로그·청크 정리. `retention_days=0` 이면 그 함수가 no-op.
  //  ⚠ 설정을 못 읽으면 **이 정비만** 실패한다 — 표의 다른 정비를 막지 않는다(각자 catch 된다).
  { key: "session-log-reap", intervalMs: SIX_HOURS_MS,
    run: () => import("../org/store.js")
      .then((c) => c.getRuntimeConfig())
      .then((cfg) => import("../v6/session-log-store.js")
        .then((m) => m.reapSessionLogs(cfg.session_share.retention_days))) },
  // 세션 제목 소급 채움(#905 C1) — 멱등이고 다 채우면 no-op. 원래는 부팅 35초 후 1회였는데,
  //  요청에 얹는 세계에는 '부팅 1회'가 없다 — 긴 주기로 두면 같은 뜻이 된다(다 채우면 아무것도 안 한다).
  { key: "session-title-backfill", intervalMs: SIX_HOURS_MS,
    run: () => import("../v6/session-log-store.js").then((m) => m.backfillSessionTitles()) },
  // desired-state 백필(#1059 F 후속) — 레코드 없는 라이브 세션에 미러를 만든다.
  //  ⚠ 이게 없으면 그 세션들은 **회수 면역이면서 죽으면 복원도 안 된다**(고객사 A 실측: 38건 중 19건).
  { key: "session-state-backfill", intervalMs: SWEEP_MIN_INTERVAL_MS,
    run: () => import("./session-state-backfill.js").then((m) => m.backfillSessionStates()) },
  // 위탁 배차(#869 P2) — **전역**이다. 실측(2026-08-31): `org_task` 3건이 queued·attempt=0·node_id 없이
  //  **3~4일** 방치돼 있었다. 크론은 도는데(CP 가 굴린다) 배차가 한 번도 안 됐다 — 그중 둘이
  //  «미분류 지식 12건 분류»·«자료 증류» 로 **맥락 파이프라인의 본체**다.
  //  ⓘ `tickTasksAllTenants` 는 매니지드에서 돌도록 이미 설계돼 있었다(`scheduler/tenant-fanout.ts` 가
  //   request 모드를 지원한다) — 게이트가 막아 한 번도 안 돈 것뿐이다.
  { key: "task-dispatch", intervalMs: TASK_TICK_MS, scope: "global",
    run: () => import("../node/task-scheduler.js").then((m) => m.tickTasksAllTenants()) },
  //  ⚠ **`reapIdleSessions`(#1059 F)는 일부러 빼 뒀다** — tmux 세션을 **죽인다.** 정책 기본이 0(끔)이라
  //   당장은 no-op 이지만, 파괴적 동작을 이 표에 얹는 것은 #2148(매니지드 유휴 회수)의 판단이다.
  //   그 짝인 위 백필은 올린다 — 원래 주석이 "회수 **전에** 백필한다"고 못 박았고 백필 자체는 안전하다.
];

//  ⚠ 인메모리다. 게이트웨이가 재기동하면 비는데, **그게 맞다**: 재기동이야말로 배달 루프를 죽여
//   좀비를 만드는 사건이므로, 재기동 직후 첫 요청이 곧바로 쓸어야 한다.
//  키는 `<정비>:<테넌트>` — 정비끼리도, 테넌트끼리도 서로의 시계를 건드리지 않는다.
const lastSweep = new Map<string, number>();

/** 테스트용 — 디바운스 상태를 비운다. */
export function resetSweepDebounce(): void { lastSweep.clear(); }

/** 관측용(읽기 전용) — 지금까지 슬롯을 가져간 `<정비>:<테넌트>` 들. "아무도 안 쓸렸다"를 볼 수 있어야
 *  '컨텍스트 없으면 무동작'을 실제로 검증할 수 있다(대상 하나만 보면 늘 참이라 아무것도 못 잡는다). */
export function sweptKeys(): string[] { return [...lastSweep.keys()]; }

/** 관측용(읽기 전용) — 그 슬롯을 **언제** 가져갔나. 키 목록만으로는 "다시 돌았다"를 볼 수 없어,
 *  미들웨어가 정비별 주기를 실제로 쓰는지 검증할 수 없다(실측: 그 구멍이 변이를 통과시켰다). */
export function sweptAt(jobKey: string, tenantId: string, scope: "tenant" | "global" = "tenant"): number | undefined {
  return lastSweep.get(scope === "global" ? `${jobKey}:*` : `${jobKey}:${tenantId}`);
}

/** 이 (정비, 테넌트) 를 지금 돌려야 하나(그렇다면 시각을 찍는다). 순수하지 않지만 판정과 기록이
 *  원자적이어야 동시 요청 둘이 같은 정비를 두 번 돌리지 않는다(node 는 단일 스레드라 안 쪼개진다). */
export function shouldSweep(jobKey: string, tenantId: string, now: number, intervalMs: number,
                            scope: "tenant" | "global" = "tenant"): boolean {
  //  ⚠ 전역 정비는 **테넌트를 안 탄다** — 어느 테넌트의 요청이 깨우든 주기당 한 번만 돌아야 한다.
  //   테넌트를 키에 넣으면 테넌트 수만큼 같은 전량 작업이 중복된다.
  const k = scope === "global" ? `${jobKey}:*` : `${jobKey}:${tenantId}`;
  const prev = lastSweep.get(k);
  if (prev !== undefined && now - prev < intervalMs) return false;
  lastSweep.set(k, now);
  return true;
}

/**
 * 요청에 얹은 테넌트 정비 (#2246).
 *
 *  ── 왜 필요한가 ──
 *  요청별 테넌시(매니지드)에서는 `boot/housekeeping` 이 `gate:"scheduler"` 스텝을 **아예 안 돌린다**.
 *  그 판단은 옳다(요청 밖엔 테넌트 컨텍스트가 없어 `42704` 로 매 tick 실패한다). 그런데 그 스텝들 안에
 *  *누군가는 해야 하는 일*이 들어 있었다 — 아웃박스 회수·청소, 그리고 대기 알림.
 *
 *  ── 왜 이게 "누구의 것인지 모르는 정리"가 아닌가 ──
 *  housekeeping 머리말이 거부한 것은 *요청 서버가 **임의로 한 테넌트를 골라** 돌리는 것*이다.
 *  여기서는 고르지 않는다 — **요청이 어느 테넌트인지 말해준다.** 그리고 컨텍스트 안에서 부르면
 *  DB 는 RLS 가, tmux 는 중계가 그 테넌트로 스코프한다. 그래서 새 함수를 만들지 않고 있던 것을 그대로 부른다.
 *
 *  ⓘ 무인 케이스도 덮인다 — CP 가 60초마다 모든 테넌트를 돌며 게이트웨이를 부른다(`control/idle.ts`).
 *   사람이 아무것도 안 만져도 그 호출이 곧 요청이라 정비가 돈다(실측: 7개 테넌트가 5~6분 간격으로 규칙적).
 */
export function outboxRequestSweepMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (_req, _res, next) => {
    //  ⚠ 요청을 늦추지 않는 방법은 "next() 를 먼저 부르기"가 **아니다** — 그러면 하류가 동기 예외를
    //   던졌을 때 이 아래가 아예 안 돈다(express 함정). 여기 동기 코드는 Map 조회 몇 번뿐이고 실제
    //   작업은 `void ...` 뒤라 어차피 블로킹하지 않는다. 그러니 **판정→발사→next()** 로 둔다.
    try { maybeSweep(env); } catch (err) { logger.warn({ err }, "정비: 스윕 판정 실패(비치명)"); }
    next();
  };
}

/** 판정하고, 돌 차례인 정비를 **기다리지 않고** 던진다. 정비끼리 독립이다 — 하나가 터져도 나머지는 돈다. */
function maybeSweep(env: NodeJS.ProcessEnv): void {
  // ⚠ 이 판정이 거짓이면 하우스키핑이 스스로 돈다 — 여기서 또 돌면 **이중**이다.
  if (!requestScopedTenancy()) return;
  const t = currentTenant();
  if (!t) return; // 컨텍스트 없음(테넌트 무관 경로) — 쓸 대상이 특정되지 않는다.
  const now = Date.now();
  for (const job of SWEEP_JOBS) {
    if (!shouldSweep(job.key, String(t.id), now, jobIntervalMs(job, env), job.scope ?? "tenant")) continue;
    //  컨텍스트 **안**에서 부른다 — 여기서 등록한 then 체인은 AsyncLocalStorage 저장소를 그대로
    //  물려받는다(enqueue→deliverLoop 가 이미 같은 원리로 돈다).
    void job.run()
      //  ⚠ **정비가 돌려준 것을 함께 찍는다.** "돌았다"만 찍으면 «돌았는데 아무것도 안 했다» 와
      //   «돌았지만 볼 게 없었다» 가 로그에서 같아 보인다 — 그 구별이 없어서 이 스윕이 죽어 있던 걸
      //   이틀 몰랐다. 결과가 객체면 그대로 펼쳐 찍고, void 면(예: resumeOutbox) 그냥 돌았다고만 찍는다.
      .then((r) => logger.info(
        { tenant: t.slug, job: job.key, scope: job.scope ?? "tenant", ...(r && typeof r === "object" ? r : {}) },
        "정비: 요청에 얹은 테넌트 스윕"))
      .catch((err) => logger.warn({ err, tenant: t.slug, job: job.key },
        "정비: 테넌트 스윕 실패(비치명 — 다음 요청이 다시 시도)"));
  }
}

/** 주기 오버라이드(운영 중 조정용). 잘못된 값은 조용히 기본값으로 — 정비가 설정 오타로 멈추면 안 된다.
 *  ⚠ `Number("")` 는 **0** 이다(NaN 이 아니다) — 그래서 유한성만 보면 빈 문자열이 "주기 0" 으로 통과한다.
 *   양수 검사가 그 구멍을 막는다. 내보내는 이유는 이 정책을 그 자리에서 검증하기 위해서다.
 *  ⓘ 오버라이드 env 는 정비마다 따로다(`LIVELY_SWEEP_MS_<KEY>`) — 하나로 묶으면 30초와 5분이 같이 움직인다. */
export function jobIntervalMs(job: SweepJob, env: NodeJS.ProcessEnv): number {
  const name = `LIVELY_SWEEP_MS_${job.key.replace(/-/g, "_").toUpperCase()}`;
  const raw = Number((env[name] || "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : job.intervalMs;
}

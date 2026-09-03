// 실패 위탁 세션 회수(#1675 ①) — **보존에 상한을 씌운다.**
//
// 배경: 위탁 워커 세션은 작업이 끝나도 셸로 남는다(`tasks.ts` taskScript 의 `exec $SHELL`). 성공하면
//  스케줄러가 곧바로 정리하지만 **실패는 일부러 남겼다** — 웹터미널로 열어 그 자리에서 재현·검시하라고.
//  의도된 설계이고 실제로 쓰인다(#1101·#1289 진단이 그 경로였다).
//
// 문제: 그 보존에 **상한이 없었다.** 어니스트 2026-08-12, 헤드리스 토큰이 폐기되자 증류 크론의 위탁이
//  10분마다 9건씩 전량 실패했고 24시간 동안 실패 세션 2,300여 개가 쌓였다. 세션 1건 = 프로세스 3개
//  (sudo 2 = box-cgspawn→box-spawn, bash 1) + claude 프로세스라, 프로세스 4,771개·메모리 요구 21GB
//  (물리 15.7GB) → 스왑 8GB 완전 고갈 → Postgres 3초 초과 → "DB 연결 불가" + 간헐 502.
//
// 그래서 **끄는 게 아니라 상한을 씌운다.** 최근 N건(keep_failed_sessions)만, 그것도 TTL 안에서만 남긴다.
//  검시 능력은 사실상 그대로다 — 같은 실패 2,300건을 다 열어보는 사람은 없고, 진단의 원문
//  (stream.jsonl·stderr.log·exit)은 **세션과 무관하게 taskDir 에 그대로 남는다**. 세션이 주는 건
//  "그 자리에서 셸을 잡는 것" 하나뿐이고, 그건 최근 몇 건이면 충분하다.
//
// ⚠ 회수해도 DB 행은 남는다 — 실패 기록·결과 요약·에러는 org_task 에 그대로다. 지우는 건 tmux 세션뿐.
//
// ── #2622: 영구 실패에 종료 조건이 없었다 ───────────────────────────────────────────────────
// 첫 판(#1675)은 kill 이 실패하면 「마킹하지 않고 다음 tick 에 다시 시도」했다. 일시 장애엔 맞지만
//  **영구 실패에 끝이 없었다.** 매니지드 gw-central 실측(2026-09-03): 이틀 전 실패한 위탁 31건에
//  5초 tick 마다 kill RPC 를 다시 쏴 게이트웨이 로그의 88%(1,298줄 중 1,147줄)를 차지했다.
//
// 원인은 «닿지 못함» 이 아니었다 — **그 세션이 이미 없어서** 노드가 거절한 것이다. 노드의 killSession 은
//  assertManage → ownerMeta 를 먼저 보는데, 노드엔 DB 가 없어(loadDesiredOne 이 노드에선 undefined)
//  tmux `@box_owner` 로 떨어지고, 세션이 없으면 그 조회가 빈 문자열이라 **403 「본인 세션이 아닙니다」**가 된다.
//  바로 다음 줄의 tmuxKill 은 「이미 죽은 세션을 다시 죽이는 것은 성공이다」라고 멱등한데, 그 앞의
//  소유 확인이 없는 세션에서 걸려 **멱등성이 발휘될 자리에 닿지도 못했다.**
//
// 그래서 종료 조건을 둘 넣었다.
//  ⓐ **멱등 회수(원인에 맞는 수정)** — kill 이 실패하면 «그 세션이 이미 없나» 를 노드에 **확답으로** 묻고
//    (`gone` op — #835 확답 only), 없다는 확답이면 회수 성공으로 간주해 마킹한다.
//    ⚠ 확답일 때만이다. 「모르겠다」를 성공으로 접으면 #1675 리뷰가 잡은 **거짓 성공**(못 걷은 세션을
//     걷었다고 기록 → 영구 누수)을 다시 만든다.
//  ⓑⓒ **백오프 + 재시도 상한 + 포기 마킹** — ⓐ 로 못 끝난 실패는 지수 백오프로 물러나고, 상한을 넘기면
//    `session_reap_gave_up` 을 찍고 큐에서 뺀다 + 경보. ⓐ 만 고치면 **다음 미지의 영구 실패가 또 이틀을 돈다** —
//    끝을 만드는 건 이쪽이다. 포기 마커는 `session_reaped` 와 **다른 칸**이다(걷었다고 거짓말하지 않는다).
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { sendBoxAlert } from "../ops/alerts.js";

/** 회수 판정에 필요한 최소 정보(순수 함수 입력 — DB·tmux 없이 테스트한다). */
export interface ReapableSession {
  id: number;
  /** 종결 시각(ISO). null 이면 TTL 판정에서 제외하고 개수 상한만 적용한다. */
  finished_at: string | null;
}

export interface FailedReapPlan {
  /** 회수할 태스크 id — 개수 상한 밖이거나 TTL 초과. */
  reap: number[];
  /** 검시용으로 남기는 태스크 id. */
  keep: number[];
}

/**
 * 무엇을 회수할지 정한다(순수).
 *
 * 규칙: **최신순으로 keep 개까지만 남기고, 남긴 것도 ttlMin 을 넘겼으면 회수한다.**
 *  - `keep = 0` → 전부 회수(보존 끔).
 *  - `ttlMin = 0` → TTL 무제한(개수 상한만).
 *  - `finished_at` 이 없으면(구 행·시각 파싱 불가) TTL 로는 안 죽인다 — 모르면 사용자 자산을 안 건드린다.
 *
 * ⚠ 입력 정렬에 의존하지 않는다. 호출부가 정렬해서 주더라도 여기서 다시 최신순으로 세운다 —
 *  '최근 N건'의 정의가 호출부 쿼리의 ORDER BY 에 매달리면, 그 한 줄이 바뀌는 순간 조용히 오래된 것만 남는다.
 */
export function planFailedSessionReap(
  rows: ReapableSession[],
  o: { keep: number; ttlMin: number; now: number },
): FailedReapPlan {
  const ts = (r: ReapableSession): number => {
    const t = r.finished_at ? new Date(r.finished_at).getTime() : NaN;
    return Number.isFinite(t) ? t : -Infinity;   // 시각 불명 = 가장 오래된 것으로 취급(먼저 회수 후보)
  };
  const sorted = [...rows].sort((a, b) => ts(b) - ts(a));    // 최신 우선
  const keepN = Math.max(0, o.keep);
  const cutoff = o.ttlMin > 0 ? o.now - o.ttlMin * 60_000 : -Infinity;

  const reap: number[] = [], keep: number[] = [];
  sorted.forEach((r, i) => {
    const overCount = i >= keepN;
    const t = ts(r);
    // TTL 초과 판정은 시각을 아는 행에만 — -Infinity(시각 불명)는 개수 상한으로만 걸러낸다.
    const overTtl = cutoff > -Infinity && Number.isFinite(t) && t < cutoff;
    if (overCount || overTtl) reap.push(r.id); else keep.push(r.id);
  });
  return { reap, keep };
}

// ── 백오프 사다리(#2622 ⓑ) ────────────────────────────────────────────────────────────────
// n 번째 연속 실패 뒤 다음 시도까지 기다리는 시간. 마지막 값에서 포화한다.
//  5초 tick 기준으로 1회 실패만 해도 다음 시도가 30초 뒤라 **로그가 즉시 희소해진다**(초당 수십 회 → 분당 몇 회).
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000] as const;
/** 이만큼 연속 실패하면 포기한다(마지막 값 포화 포함 ≈ 2시간). 회수는 급한 일이 아니라 넉넉히 준다. */
const GIVE_UP_AFTER = 10;

/** 사다리 끝 = 우리가 만들 수 있는 최대 대기. 이보다 먼 미래는 우리가 쓴 값이 아니다. */
const MAX_BACKOFF_MS = BACKOFF_MS[BACKOFF_MS.length - 1];

/**
 * 지금은 건너뛸 때인가(순수) — `reap_next_at` 이 **읽히고, 미래고, 상한 안**일 때만 true.
 *
 * 세 조건 모두 「모르면 시도한다」 쪽으로 기운다. 회수를 한 번 더 시도하는 비용은 RPC 한 번이지만,
 *  잘못 건너뛰면 그 세션은 아무도 다시 안 본다.
 */
export function isBackedOff(nextAt: string | null | undefined, now: number): boolean {
  if (!nextAt) return false;
  const due = Date.parse(nextAt);
  if (!Number.isFinite(due)) return false;              // 오염 — 백오프 없음으로 본다
  return due > now && due <= now + MAX_BACKOFF_MS;      // 상한 밖 미래는 우리 값이 아니다 → 지금 시도한다
}

/** 실패 n 회 뒤 다음 시도 시각(ms). */
export function reapBackoffMs(fails: number): number {
  if (fails <= 0) return 0;
  return BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1];
}

/**
 * 회수 시도 한 번의 결과.
 *
 * ⚠ `done` 은 «그 세션이 **지금 확실히 없다**» 는 뜻이다(걷었거나, 애초에 이미 없었다는 확답을 받았거나).
 *  «못 걷었지만 아마 없을 것» 을 여기 담으면 #1675 리뷰가 잡은 거짓 성공(영구 누수)이 그대로 재현된다.
 */
export interface ReapAttempt {
  done: boolean;
  /**
   * 노드가 **답을 했나**(닿았나). 포기 카운터를 올릴지 가르는 축이다.
   *
   * ⚠ **못 닿은 것으로는 포기하지 않는다.** 실측(2026-09-04, 셀프호스트 게이트웨이): 이 로그를 채운
   *  상위 넷이 전부 사람 노트북이었다(`haruui-macbookair` 21,414 · `hammurabi` 549 · `honest-ai-pilot` 366 ·
   *  `win-e2e-1541` 183). 노트북은 밤새 잔다 — 2시간 만에 포기하면 그 세션은 노트북이 돌아와도
   *  **아무도 다시 안 걷는다.** 그게 #1675 ★② 가 닫은 영구 누수를 다시 여는 것이다.
   *  못 닿는 동안에도 백오프는 계속 길어지므로(핫루프는 사라진다) 무한 재시도의 비용은 없다.
   *
   * `true` 는 **노드가 실제로 거절했다**는 뜻일 때만이다 — 그때는 스스로 회복될 길이 없으니 끝을 낸다.
   *  오프라인·무응답(타임아웃)은 `false`: 모르면 사용자 자산을 안 건드린다.
   */
  reached?: boolean;
  /** 실패 사유 — **노드가 준 원문**을 넣는다. 종전엔 호출부가 이걸 버리고 「닿지 못함」이라는 합성 문구만
   *  남겨서, 이틀치 로그를 다 읽어도 진짜 이유(403 「본인 세션이 아닙니다」)를 알 수 없었다. */
  why?: string;
}

/**
 * 회수 판정(순수, #2622 ⓐ) — kill 결과와 「그 세션이 이미 없나」 확답을 합쳐 «마킹해도 되는가» 를 정한다.
 *
 * 이 한 줄이 이 프로젝트의 안전선이라 **순수 함수로 떼어 표로 검증한다.** 호출부(스케줄러)에 인라인으로
 *  두면 DB·레지스트리에 묶여 시험할 수 없고, 그러면 아무도 이 규칙을 지키는지 확인하지 못한다.
 *
 * @param killed       kill 이 «확실히 없어졌다» 를 답했나
 * @param confirmedGone 노드의 확답 — `true` 없다 · `false` 살아있다 · `null` **판정 불가**
 *
 * ⚠ `null` 은 성공이 아니다. 「모르겠다」를 회수로 접는 순간 #1675 리뷰가 잡은 거짓 성공(못 걷은 세션을
 *  걷었다고 기록 → 노드가 돌아오면 멀쩡히 살아 있는 영구 누수)이 그대로 재현된다.
 */
export function decideReap(killed: boolean, confirmedGone: boolean | null, why?: string, reached?: boolean): ReapAttempt {
  if (killed) return { done: true };
  if (confirmedGone === true) return { done: true, why: "이미 없는 세션(멱등 회수)" };
  // 「살아있다」는 확답(false)도 **닿았다**는 뜻이다 — 노드가 답을 했으니까.
  return { done: false, reached: reached === true || confirmedGone === false, why };
}

/** 회수 대상 조회 — 실패·취소로 끝났는데 세션이 아직 안 걷힌 위탁. */
export interface FailedTaskRow extends ReapableSession {
  node_id: string | null;
  session_id: string | null;
  requester: string;
  /** 지금까지 연속 실패 횟수(result.session_reap_fails). 없으면 0. */
  reap_fails?: number;
  /** 이 시각 전에는 다시 시도하지 않는다(result.session_reap_next_at, ISO). */
  reap_next_at?: string | null;
}

async function listUnreapedFailed(): Promise<FailedTaskRow[]> {
  // `session_reaped` 마커로 이미 걷은 행을 제외한다 — 안 그러면 매 tick 같은 세션에 kill 을 다시 쏜다
  //  (원격 노드면 그게 매번 RPC 다). 스키마 변경 없이 result JSONB 에 얹는다.
  //  canceled 도 포함: 취소 경로도 실패와 같은 자리에 세션을 남긴다.
  //  `session_reap_gave_up` 은 **걷지 못한 채 포기한** 행이다 — 다시 집어 들면 #2622 의 핫루프가 되살아난다.
  //  ⚠ fails/next_at 은 **텍스트로 꺼내 JS 에서 판다.** SQL 에서 ::int·::timestamptz 로 캐스팅하면 값이
  //   한 번이라도 오염됐을 때 **조회 전체가 죽어** 회수가 통째로 멈춘다(우리가 쓰는 칸이라도 그 위험은 진다).
  const r = await itemsPool.query(
    `SELECT id, node_id, session_id, requester, finished_at,
            result->>'session_reap_fails'   AS reap_fails_txt,
            result->>'session_reap_next_at' AS reap_next_at
       FROM org_task
      WHERE status IN ('failed','canceled') AND session_id IS NOT NULL
        AND (result->>'session_reaped') IS NULL
        AND (result->'session_reap_gave_up') IS NULL
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 5000`);
  // ⚠ 이 LIMIT 은 **tick 당 처리량 상한**이지 '여기까지만 본다'가 아니다. 걷은 행은 session_reaped 로 표시돼
  //  다음 조회에서 빠지므로, 백로그가 이보다 커도 다음 tick 이 그 다음 묶음을 가져가 **수렴한다**(5초 tick).
  //  정렬이 최신순인 건 의도다 — plan 이 '최신 keep 건'을 남겨야 하는데 오래된 것부터 가져오면 그 판정이 깨진다.
  return (r.rows as Array<FailedTaskRow & { reap_fails_txt: string | null }>).map((row) => ({
    ...row, reap_fails: Number(row.reap_fails_txt) || 0,
  }));
}

/** 회수 완료 표시 — 다음 tick 이 같은 세션을 다시 걷지 않게. */
async function markReaped(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await itemsPool.query(
    `UPDATE org_task SET result = COALESCE(result,'{}'::jsonb) || '{"session_reaped":true}'::jsonb, updated_at=now()
      WHERE id = ANY($1::int[])`, [ids]);
}

/**
 * 실패 1회 기록(#2622 ⓑ) — 누적 횟수와 다음 시도 시각을 남긴다.
 *
 * **메모리가 아니라 DB 에 남기는 이유**: 이 게이트웨이는 자주 롤된다(#2570 측정 중에만 3회). 메모리에 두면
 *  롤 때마다 백오프가 0 으로 돌아가 «영구 실패가 영원히 안 끝나는» 원래 상태로 되돌아간다. 백오프 덕에
 *  쓰기 자체가 희소하므로(태스크당 총 10회 남짓) 비용은 무시할 수 있다.
 */
async function markReapAttempt(id: number, fails: number, nextAt: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_task
        SET result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('session_reap_fails', $2::int, 'session_reap_next_at', $3::text),
            updated_at = now()
      WHERE id = $1`, [id, fails, nextAt]);
}

/**
 * 포기 표시(#2622 ⓒ) — **걷었다고 말하지 않는다.** `session_reaped` 와 다른 칸을 쓰는 게 핵심이다:
 *  전자는 「없어졌다」, 이건 「못 걷었고 더는 안 해본다」다. 둘을 한 칸으로 뭉개면 사후에 구분이 불가능하다.
 */
async function markReapGaveUp(id: number, fails: number, why: string): Promise<void> {
  await itemsPool.query(
    `UPDATE org_task
        SET result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('session_reap_gave_up',
              jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'fails', $2::int, 'why', $3::text)),
            updated_at = now()
      WHERE id = $1`, [id, fails, why.slice(0, 500)]);
}

export interface FailedReapResult {
  scanned: number; reaped: number; kept: number; failed: number;
  /** 백오프 중이라 **RPC 를 쏘지 않고** 건너뛴 건수. 이 값이 크다는 건 제동이 걸렸다는 뜻이다. */
  backedOff: number;
  /** 재시도 상한을 넘겨 포기한 건수. */
  gaveUp: number;
}

/**
 * 한 회수 tick. 실패로 끝난 위탁의 세션을 상한 밖부터 걷는다.
 *
 * `killSession` 은 주입받는다 — 중앙(tmux)/원격(노드 RPC) 라우팅은 task-scheduler 가 이미 갖고 있고,
 *  이 모듈이 그걸 다시 알 이유가 없다(순환 import 도 피한다). 그 함수는 «확실히 없어졌나» 를 답해야 한다
 *  (ReapAttempt) — 못 걷은 것을 걷었다고 답하면 회수기가 거짓 성공을 기록한다.
 *
 * ⚠ **tick 비용이 실패 건수에 비례해 늘면 안 된다**(#2622 의 실질 피해). 백오프에 걸린 건은 여기서
 *  `continue` 로 빠지므로 RPC 도 DB 쓰기도 발생하지 않는다 — 영구 실패하는 노드가 있어도 tick 은 안 늘어난다.
 */
export async function reapFailedTaskSessions(
  killSession: (t: FailedTaskRow) => Promise<ReapAttempt>,
  policy: { keep: number; ttlMin: number },
  deps?: {
    list?: () => Promise<FailedTaskRow[]>;
    mark?: (ids: number[]) => Promise<void>;
    markAttempt?: (id: number, fails: number, nextAt: string) => Promise<void>;
    markGaveUp?: (id: number, fails: number, why: string) => Promise<void>;
    alert?: typeof sendBoxAlert;
    now?: () => number;
  },
): Promise<FailedReapResult> {
  const list = deps?.list ?? listUnreapedFailed;
  const mark = deps?.mark ?? markReaped;
  const markAttempt = deps?.markAttempt ?? markReapAttempt;
  const markGaveUp = deps?.markGaveUp ?? markReapGaveUp;
  const alert = deps?.alert ?? sendBoxAlert;
  const now = (deps?.now ?? Date.now)();

  const empty: FailedReapResult = { scanned: 0, reaped: 0, kept: 0, failed: 0, backedOff: 0, gaveUp: 0 };
  let rows: FailedTaskRow[];
  try { rows = await list(); }
  catch (e) {
    // 조회 실패로 스케줄러 tick 을 깨뜨리지 않는다(테이블 부재·DB 순단 등).
    logger.warn({ err: (e as Error)?.message }, "실패 위탁 세션 회수: 대상 조회 실패(다음 tick 재시도)");
    return empty;
  }
  const plan = planFailedSessionReap(rows, { keep: policy.keep, ttlMin: policy.ttlMin, now });
  // ⚠ 백오프 판정은 **plan 뒤**에 건다. 조회에서 미리 빼면 '최신 keep 건' 창이 백오프 중인 행만큼 밀려
  //  검시용으로 남겨야 할 세션이 조용히 회수된다.
  if (!plan.reap.length) return { ...empty, scanned: rows.length, kept: plan.keep.length };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const done: number[] = [];
  const gaveUp: Array<{ id: number; node: string | null; why: string }> = [];
  let failed = 0, backedOff = 0;
  for (const id of plan.reap) {
    const t = byId.get(id);
    if (!t) continue;
    // 시각을 못 읽으면(오염) 백오프가 없는 것으로 본다 — 파싱 실패로 회수가 영영 멈추지 않게.
    //  ⚠ **읽히는 값도 상한을 씌운다.** 우리가 쓰는 최대치는 사다리 끝(now+30분)인데, 그 칸이 어떤 경위로든
    //   먼 미래(예: 3000년)가 되면 그 태스크는 영원히 건너뛰어져 포기에도 안 닿는다 — 이 프로젝트가 없애려는
    //   «종료 조건 없는 상태» 를 수정이 스스로 다시 만드는 꼴이다. 상한 밖이면 지금 시도할 때가 된 것으로 본다.
    if (isBackedOff(t.reap_next_at, now)) { backedOff++; continue; }

    let r: ReapAttempt;
    try { r = await killSession(t); }
    catch (e) { r = { done: false, why: (e as Error)?.message ?? String(e) }; }
    if (r.done) { done.push(id); continue; }

    const fails = (t.reap_fails ?? 0) + 1;
    const why = r.why ?? "(사유 없음)";
    // ⚠ 포기는 **노드가 답을 하고도 안 되는** 경우에만이다(위 ReapAttempt.reached 주석). 못 닿는 노드는
    //  백오프만 계속 길어지고(핫루프 없음) 돌아오면 그때 걷힌다 — 잠든 노트북을 포기하면 그게 영구 누수다.
    if (fails >= GIVE_UP_AFTER && r.reached === true) {
      gaveUp.push({ id, node: t.node_id, why });
      await markGaveUp(id, fails, why).catch((e) =>
        logger.warn({ err: (e as Error)?.message, task: id }, "실패 위탁 세션 회수 포기 표시 실패"));
      continue;
    }
    failed++;
    const nextAt = new Date(now + reapBackoffMs(fails)).toISOString();
    await markAttempt(id, fails, nextAt).catch((e) =>
      logger.warn({ err: (e as Error)?.message, task: id }, "실패 위탁 세션 회수 재시도 예약 실패"));
    // 사유는 **노드가 준 원문**이다(#2622) — 이게 없어서 이틀치 로그가 원인을 못 알려줬다.
    logger.warn({ task: id, node: t.node_id, session: t.session_id, fails, nextAt, why },
      "실패 위탁 세션 회수 실패(백오프 후 재시도)");
  }
  await mark(done).catch((e) => logger.warn({ err: (e as Error)?.message }, "실패 위탁 세션 회수 표시 실패"));
  if (done.length || gaveUp.length) {
    logger.info({ reaped: done.length, kept: plan.keep.length, failed, backedOff, gaveUp: gaveUp.length, keep: policy.keep, ttlMin: policy.ttlMin },
      "실패 위탁 세션 회수");
  }
  if (gaveUp.length) {
    // 포기는 «세션이 남아 있을 수도 있다» 는 뜻이라 사람이 알아야 한다 — #1675 가 없애려던 누수의 씨앗이다.
    //  tick 당 1건으로 묶어 보낸다(31건이 한꺼번에 포기해도 경보는 하나).
    logger.error({ tasks: gaveUp.map((g) => g.id), node: gaveUp[0].node, why: gaveUp[0].why },
      "실패 위탁 세션 회수 포기(재시도 상한 초과) — 세션이 남아 있을 수 있습니다");
    await alert({
      severity: "warn",
      title: `실패 위탁 세션 회수 포기 ${gaveUp.length}건`,
      text:
        `${GIVE_UP_AFTER}회 시도했지만 세션을 걷지 못해 포기했습니다 — 그 세션이 노드에 남아 있을 수 있습니다.\n`
        + `노드: ${gaveUp[0].node ?? "?"} · 태스크: ${gaveUp.map((g) => `#${g.id}`).join(", ").slice(0, 300)}\n`
        + `마지막 사유: ${gaveUp[0].why}`,
      detail: { tasks: gaveUp.map((g) => g.id), node: gaveUp[0].node, why: gaveUp[0].why, give_up_after: GIVE_UP_AFTER },
    }).catch((e) => logger.warn({ err: (e as Error)?.message }, "회수 포기 경보 전송 실패"));
  }
  return { scanned: rows.length, reaped: done.length, kept: plan.keep.length, failed, backedOff, gaveUp: gaveUp.length };
}

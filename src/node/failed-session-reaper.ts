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
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";

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

/** 회수 대상 조회 — 실패·취소로 끝났는데 세션이 아직 안 걷힌 위탁. */
export interface FailedTaskRow extends ReapableSession {
  node_id: string | null;
  session_id: string | null;
  requester: string;
}

async function listUnreapedFailed(): Promise<FailedTaskRow[]> {
  // `session_reaped` 마커로 이미 걷은 행을 제외한다 — 안 그러면 매 tick 같은 세션에 kill 을 다시 쏜다
  //  (원격 노드면 그게 매번 RPC 다). 스키마 변경 없이 result JSONB 에 얹는다.
  //  canceled 도 포함: 취소 경로도 실패와 같은 자리에 세션을 남긴다.
  const r = await itemsPool.query(
    `SELECT id, node_id, session_id, requester, finished_at
       FROM org_task
      WHERE status IN ('failed','canceled') AND session_id IS NOT NULL
        AND (result->>'session_reaped') IS NULL
      ORDER BY finished_at DESC NULLS LAST, id DESC
      LIMIT 5000`);
  // ⚠ 이 LIMIT 은 **tick 당 처리량 상한**이지 '여기까지만 본다'가 아니다. 걷은 행은 session_reaped 로 표시돼
  //  다음 조회에서 빠지므로, 백로그가 이보다 커도 다음 tick 이 그 다음 묶음을 가져가 **수렴한다**(5초 tick).
  //  정렬이 최신순인 건 의도다 — plan 이 '최신 keep 건'을 남겨야 하는데 오래된 것부터 가져오면 그 판정이 깨진다.
  return r.rows as FailedTaskRow[];
}

/** 회수 완료 표시 — 다음 tick 이 같은 세션을 다시 걷지 않게. */
async function markReaped(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await itemsPool.query(
    `UPDATE org_task SET result = COALESCE(result,'{}'::jsonb) || '{"session_reaped":true}'::jsonb, updated_at=now()
      WHERE id = ANY($1::int[])`, [ids]);
}

export interface FailedReapResult { scanned: number; reaped: number; kept: number; failed: number }

/**
 * 한 회수 tick. 실패로 끝난 위탁의 세션을 상한 밖부터 걷는다.
 *
 * `killSession` 은 주입받는다 — 중앙(tmux)/원격(노드 RPC) 라우팅은 task-scheduler 가 이미 갖고 있고,
 *  이 모듈이 그걸 다시 알 이유가 없다(순환 import 도 피한다).
 */
export async function reapFailedTaskSessions(
  killSession: (t: FailedTaskRow) => Promise<void>,
  policy: { keep: number; ttlMin: number },
  deps?: { list?: () => Promise<FailedTaskRow[]>; mark?: (ids: number[]) => Promise<void>; now?: () => number },
): Promise<FailedReapResult> {
  const list = deps?.list ?? listUnreapedFailed;
  const mark = deps?.mark ?? markReaped;
  const now = (deps?.now ?? Date.now)();

  let rows: FailedTaskRow[];
  try { rows = await list(); }
  catch (e) {
    // 조회 실패로 스케줄러 tick 을 깨뜨리지 않는다(테이블 부재·DB 순단 등).
    logger.warn({ err: (e as Error)?.message }, "실패 위탁 세션 회수: 대상 조회 실패(다음 tick 재시도)");
    return { scanned: 0, reaped: 0, kept: 0, failed: 0 };
  }
  const plan = planFailedSessionReap(rows, { keep: policy.keep, ttlMin: policy.ttlMin, now });
  if (!plan.reap.length) return { scanned: rows.length, reaped: 0, kept: plan.keep.length, failed: 0 };

  const byId = new Map(rows.map((r) => [r.id, r]));
  const done: number[] = [];
  let failed = 0;
  for (const id of plan.reap) {
    const t = byId.get(id);
    if (!t) continue;
    try { await killSession(t); done.push(id); }
    catch (e) {
      // 노드 이탈 등으로 못 걷었으면 **마킹하지 않는다** — 다음 tick 에 다시 시도해야 한다.
      failed++;
      logger.warn({ err: (e as Error)?.message, task: id, node: t.node_id }, "실패 위탁 세션 회수 실패(다음 tick 재시도)");
    }
  }
  await mark(done).catch((e) => logger.warn({ err: (e as Error)?.message }, "실패 위탁 세션 회수 표시 실패"));
  if (done.length) {
    logger.info({ reaped: done.length, kept: plan.keep.length, failed, keep: policy.keep, ttlMin: policy.ttlMin },
      "실패 위탁 세션 회수");
  }
  return { scanned: rows.length, reaped: done.length, kept: plan.keep.length, failed };
}

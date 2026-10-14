// 시각형(cron_expr) 크론의 due 판정 — DB·시계 무의존 순수 leaf (#3994 T4).
//
//  ★ 왜 바꿨나 (2026-09-16 실측)
//   종전 판정은 «**지금이 매치 분인가**» 였다: `cronMatches(expr, now, tz) && nowMin !== lastMin`.
//   그 코드는 인프로세스 30초 타이머를 전제로 쓰였다(주석: "30s 틱이 분당 2회라 매치 분을 놓치지 않음").
//   그런데 매니지드에서 크론을 굴리는 것은 그 타이머가 아니라 **CP 가 HTTP 로 부르는 틱**이고
//   (`src/web.ts:115` → runSchedulerTickOnce · 주석 web.ts:136), 실측 격자는 5분이었다
//   (07:13:20 · 07:18:20 · 07:23:20 · 07:28:20 — 초까지 고정).
//   그래서 `30 4 * * *`(매일 4시 30분)은 그 격자에 **영영 걸리지 않는다** — wikilink-sweep 이 10일째
//   미실행이었고, 같은 표의 주기형 잡들은 멀쩡히 돌고 있었다(그쪽은 «경과 시간»만 보니까).
//
//  ⇒ 판정을 «**마지막 실행 이후 첫 매치가 지났는가**» 로 옮긴다. 틱 간격이 얼마든 옳다.
//
//  ★ 밀린 만큼 몰아서 돌지 않는다 — `last_run_at` 은 실행 **시작** 시각이라(engine.ts 의 startedIso)
//   한 번 돌면 last 가 지금으로 찍히고 다음 매치는 자연히 앞으로 전진한다. 10일 밀린 잡도 1회다.
import { parseCron, nextCronTime } from "./cron-expr.js";

export interface CronDueInput {
  /** 5필드 cron 표현식. */
  expr: string;
  /** org_cron.last_run_at 원문(ISO). 없으면 «한 번도 안 돌았다». */
  lastRunAt?: string | null;
  /** 판정 기준 시각(ms). */
  now: number;
  /** 조직 시간대(#778). 없으면 서버 로컬 — cron-expr 의 계약 그대로. */
  tz?: string;
}

/**
 * 이 시각형 잡이 지금 due 인가.
 *
 *  · 잘못된 expr → 아님(검증은 cron_set 이 한다. 종전과 같다).
 *  · 한 번도 안 돌았으면 → **due**. `run_once` 가 이미 같은 규율이다(engine.ts: "아직 안 돌았으면 due").
 *    그래야 새로 만든 시각형 잡의 **첫 실행**도 틱 격자에 기대지 않는다.
 *  · last 가 파싱 불가면 → **아님**. «모름» 을 due 로 접으면 매 틱 실행 폭주가 된다 —
 *    engine.ts 가 정확히 그 사고를 주석으로 기록해 뒀다("last_run_at 이 안 써지면 … 30초마다 돈다").
 *  · last 가 미래(시계 되돌림)면 그 기준의 다음 매치도 미래라 자연히 아님이 된다.
 */
export function cronDue(inp: CronDueInput): boolean {
  let parsed;
  try { parsed = parseCron(inp.expr); } catch { return false; }
  const raw = inp.lastRunAt;
  if (raw == null || String(raw).trim() === "") return true;
  const lastMs = new Date(raw).getTime();
  if (!Number.isFinite(lastMs)) return false;
  const next = nextCronTime(parsed, new Date(lastMs), inp.tz);
  return next !== null && next.getTime() <= inp.now;
}

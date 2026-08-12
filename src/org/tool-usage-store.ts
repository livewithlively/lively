// mcp_call_log 집계 데이터 접근(#1313 R45) — 관리탭 'MCP 호출 통계' 대시보드가 소비하는 6개 집계 쿼리.
//  capabilities/tool-usage.ts 가 직접 itemsPool.query 하던 원문을 그대로 내렸다 — 표면은 '무엇을 필터할지'
//  (기간·하네스·툴·오류만)만 정하고, 그 필터가 어떤 SQL 이 되는지는 여기만 안다.
//  ⚠ 이 필터 의미는 CSV 내보내기(audit-export-routes.ts, kind=tools)가 같은 뜻으로 복제한다 — 화면과 CSV 가
//   다르면 감사 자료로 못 쓴다. 여기를 고치면 거기도 같이 고칠 것.
//  읽기 전용(집계) — 감사 대상 아님. 로그 적재는 org/policies/tool-log.ts, 보관 정책은 call-log-policy.ts.
import { itemsPool } from "../db/client.js";

// 대시보드 필터 — 값 그대로 SQL 파라미터가 된다($1~$6 순서 = baseParams/params).
//  interval=null(전체 기간) · harness=''(전체) · tool=''(전체) · since/until=null(무제한, #1309).
export interface ToolUsageFilter {
  interval: string | null;  // postgres interval 문자열(상대 윈도), null=무제한
  harness: string;          // ''=전체
  errorsOnly: boolean;      // true=실패 호출만
  since: string | null;     // 절대 기간 시작(ISO), null=무제한
  until: string | null;     // 절대 기간 끝(ISO), null=무제한
  tool: string;             // ''=전체
}

// 공통 필터 — $1=interval(null=전체), $2=harness(''=전체), $3=errorsOnly(오류만),
//  $4=since·$5=until(null=무제한, #1309), $6=tool(''=전체). 파라미터화.
//  WHERE_BASE = 기간+하네스+결과(툴 필터 제외) — 툴 드롭다운 옵션(toolOptions)이 선택된 툴 1개로 좁혀지지 않게.
const WHERE_BASE = `WHERE ($1::text IS NULL OR called_at >= now() - $1::interval)
                     AND ($2 = '' OR harness = $2)
                     AND ($3::bool IS NOT TRUE OR NOT ok)
                     AND ($4::timestamptz IS NULL OR called_at >= $4)
                     AND ($5::timestamptz IS NULL OR called_at <= $5)`;
const WHERE = `${WHERE_BASE}
                     AND ($6 = '' OR tool = $6)`;

const baseParams = (f: ToolUsageFilter): unknown[] => [f.interval, f.harness, f.errorsOnly, f.since, f.until];
const params = (f: ToolUsageFilter): unknown[] => [...baseParams(f), f.tool];

export interface ToolUsageSummary {
  total: number; tools: number; harnesses: number; errors: number;
  first_at: string | null; last_at: string | null;
}

// 요약 카드 — 행이 없을 수 있는 집계가 아니라 항상 1행이지만, 호출부의 기본값 폴백을 유지하려 undefined 를 허용한다.
export async function toolUsageSummary(f: ToolUsageFilter): Promise<ToolUsageSummary | undefined> {
  const r = await itemsPool.query(
    `SELECT count(*)::int AS total,
            count(DISTINCT tool)::int AS tools,
            count(DISTINCT harness)::int AS harnesses,
            count(*) FILTER (WHERE NOT ok)::int AS errors,
            min(called_at) AS first_at, max(called_at) AS last_at
       FROM mcp_call_log ${WHERE}`,
    params(f),
  );
  return r.rows[0];
}

export async function toolUsageByTool(f: ToolUsageFilter): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT tool,
            count(*)::int AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS errors,
            round(avg(duration_ms))::int AS avg_ms,
            max(duration_ms)::int AS max_ms,
            -- #1645 p50/p90 — 평균·최대만으론 **꼬리 지연이 안 보인다**. 실측(고객사 40일): knowledge_search 는
            --  중앙 764ms 인데 p90 이 9,632ms(최대 33.7초)였고, 그 사실이 이 화면에 없어 한 달 뒤 CSV 로 발견했다.
            --  성공 호출만 센다 — 실패는 검증에서 즉시 튕겨 빨라서, 섞으면 지연이 실제보다 낫게 보인다.
            percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ok)::int AS p50_ms,
            percentile_disc(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ok)::int AS p90_ms,
            max(called_at) AS last_at
       FROM mcp_call_log ${WHERE}
      GROUP BY tool
      ORDER BY calls DESC, tool
      LIMIT 200`,
    params(f),
  );
  return r.rows;
}

export async function toolUsageByHarness(f: ToolUsageFilter): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT COALESCE(harness, '(미상)') AS harness,
            count(*)::int AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS errors
       FROM mcp_call_log ${WHERE}
      GROUP BY harness
      ORDER BY calls DESC`,
    params(f),
  );
  return r.rows;
}

// 일자 버킷은 **조직 시간대**로 자른다($7, #778) — 예전엔 'Asia/Seoul' 하드코딩이라 다른 시간대 조직에선 하루가 밀렸다.
export async function toolUsageByDay(f: ToolUsageFilter, tz: string): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT to_char((called_at AT TIME ZONE $7)::date, 'YYYY-MM-DD') AS day,
            count(*)::int AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS errors
       FROM mcp_call_log ${WHERE}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 30`,
    [...params(f), tz],
  );
  return r.rows;
}

// 최근 호출(인자 포함) — 페이지네이션.
export async function toolUsageRecent(
  f: ToolUsageFilter, limit: number, offset: number,
): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT id, called_at, tool, harness, actor, ok, error, duration_ms, args
       FROM mcp_call_log ${WHERE}
      ORDER BY called_at DESC
      LIMIT $7 OFFSET $8`,
    [...params(f), limit, offset],
  );
  return r.rows;
}

// 툴 드롭다운 옵션 — 툴 필터를 **뺀** 기간/하네스/결과 조건으로만 센다(선택 즉시 옵션이 1개로 줄지 않게).
export async function toolUsageToolOptions(f: ToolUsageFilter): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT tool, count(*)::int AS calls
       FROM mcp_call_log ${WHERE_BASE}
      GROUP BY tool
      ORDER BY calls DESC, tool
      LIMIT 500`,
    baseParams(f),
  );
  return r.rows;
}

// ── #1645 실패·재시도 낭비 상시 계측 ────────────────────────────────────────────
//  왜 필요했나: 지금까지 이 화면은 호출수·오류수·평균/최대 지연만 보여줬다. 그래서 고객사에서
//  knowledge_save 실패율이 11%→26%로 두 배 넘게 오르는 동안 아무도 몰랐고, CSV 를 받아 스크립트를 돌린
//  **한 달 뒤에야** 발견했다. 절대값보다 **방향이 바뀌는 순간**이 신호다(같은 기간 db_query 는 내려가고
//  knowledge_save 만 올라갔다). 아래 두 집계가 그 신호를 화면에 상주시킨다.

// 실패 사유 분포 — 에러 문구를 정규화해 묶는다.
//  정규화가 없으면 따옴표 안 이름·숫자(id·개수)가 건마다 달라 **전부 1건짜리 고유 사유**가 되어 분포가 안 보인다.
//  치환 순서: 작은따옴표 안 → 큰따옴표 안 → 숫자. (숫자를 먼저 지우면 따옴표 안 숫자까지 뭉개져 사유가 덜 갈린다.)
//  이 방식은 고객사 로그 분석에 실제로 쓴 것과 같다 — 그 분석이 필수필드 누락 224건을 한 덩어리로 드러냈다.
export async function toolUsageFailureReasons(f: ToolUsageFilter, limit = 40): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT tool, reason, count(*)::int AS n, max(called_at) AS last_at
       FROM (
         SELECT tool, called_at,
                left(regexp_replace(
                       regexp_replace(
                         regexp_replace(COALESCE(error, ''), '''[^'']*''', '''X''', 'g'),
                         '"[^"]*"', '"X"', 'g'),
                       '[0-9]+', 'N', 'g'), 160) AS reason
           FROM mcp_call_log ${WHERE} AND NOT ok
       ) t
      WHERE reason <> ''
      GROUP BY tool, reason
      ORDER BY n DESC, tool
      LIMIT $7`,
    [...params(f), limit],
  );
  return r.rows;
}

// 주차별 도구별 실패율 — **절대값보다 방향이 바뀌는 순간이 신호다.**
//  실측(고객사 40일): 전체 실패율은 31%→7.4%로 꾸준히 좋아지는 동안 knowledge_save 만 11%→21%→26%로
//  역주행했다. 그 갈림은 주차로 쪼갠 뒤에야 보였다 — 합계만 보면 개선 추세에 묻힌다.
//  실패가 한 번이라도 난 (주차, 도구)만 남긴다(무실패 행까지 실으면 화면이 0 으로 뒤덮인다).
//  ⚠ 주 경계는 조직 시간대 기준(#778 byDay 와 같은 규약) — UTC 로 자르면 월요일이 일요일 밤부터 시작한다.
export async function toolUsageWeeklyFailure(f: ToolUsageFilter, tz: string): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `SELECT to_char(date_trunc('week', called_at AT TIME ZONE $7), 'YYYY-MM-DD') AS week,
            tool,
            count(*)::int AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS errors
       FROM mcp_call_log ${WHERE}
      GROUP BY 1, 2
     HAVING count(*) FILTER (WHERE NOT ok) > 0
      ORDER BY week DESC, errors DESC
      LIMIT 400`,
    [...params(f), tz],
  );
  return r.rows;
}

// 재시도 판정 창 — 원 분석과 같은 기준(실패 후 이 시간 안의 같은 도구 재호출을 '그 실패가 부른 재시도'로 본다).
//  실측에서 knowledge_save 실패의 83%, db_query 의 74%가 이 창 안에 재시도됐다.
const RETRY_WINDOW = "2 minutes";

// ⚠ 이 집계만은 '오류만'(errorsOnly) 필터를 **의도적으로 무시**한다.
//  실패만 남긴 창에서 LEAD 를 보면 그 다음 성공(=복구)이 애초에 창 밖이라 **복구율이 항상 0%로 나온다**.
//  화면의 '오류만' 토글과 이 카드가 어긋나 보이는 건 그래서다 — 여기서 끄지 않으면 지표가 거짓말을 한다.
//  파티션은 (도구, 행위자, 하네스) — 같은 사람이 같은 도구를 다시 부른 것만 재시도로 본다(남의 호출이 끼면 오염).
const WHERE_RETRY = `WHERE ($1::text IS NULL OR called_at >= now() - $1::interval)
                     AND ($2 = '' OR harness = $2)
                     AND ($3::timestamptz IS NULL OR called_at >= $3)
                     AND ($4::timestamptz IS NULL OR called_at <= $4)
                     AND ($5 = '' OR tool = $5)`;
const retryParams = (f: ToolUsageFilter): unknown[] => [f.interval, f.harness, f.since, f.until, f.tool];

export async function toolUsageRetryWaste(f: ToolUsageFilter): Promise<Record<string, unknown>[]> {
  const r = await itemsPool.query(
    `WITH seq AS (
       SELECT tool, ok, called_at,
              LEAD(ok)        OVER w AS next_ok,
              LEAD(called_at) OVER w AS next_at
         FROM mcp_call_log ${WHERE_RETRY}
       WINDOW w AS (PARTITION BY tool, COALESCE(actor, ''), COALESCE(harness, '') ORDER BY called_at)
     )
     SELECT tool,
            count(*)::int AS calls,
            count(*) FILTER (WHERE NOT ok)::int AS failures,
            count(*) FILTER (WHERE NOT ok AND next_at IS NOT NULL
                             AND next_at - called_at <= interval '${RETRY_WINDOW}')::int AS retried,
            count(*) FILTER (WHERE NOT ok AND next_ok AND next_at IS NOT NULL
                             AND next_at - called_at <= interval '${RETRY_WINDOW}')::int AS recovered
       FROM seq
      GROUP BY tool
     HAVING count(*) FILTER (WHERE NOT ok) > 0
      ORDER BY failures DESC, tool
      LIMIT 200`,
    retryParams(f),
  );
  return r.rows;
}

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

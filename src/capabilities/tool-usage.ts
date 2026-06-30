// MCP 호출 통계 집계 — 프로젝트 #318 대시보드 백엔드. mcp_call_log(전수 호출 로그)를 읽어
//  요약/툴별/하네스별/일별/최근호출로 집계한다. 관리탭 'MCP 호출 통계'(/api/ui/tool-usage)가 소비.
//  scope=admin(게이트웨이 운영 정보 — 모든 구성원 호출·인자 노출). REST 전용(expose.mcp:false) — 하네스가
//  "직접 쿼리"하려면 db_query 로 mcp_call_log 를 SELECT 한다(이 집계는 사람 대시보드용 편의 표면).
import type { Capability } from "./types.js";
import { itemsPool } from "../items/store.js";

// 조회 윈도(상대 기간) — 값=postgres interval 문자열, null=전체(무제한).
const WINDOWS: Record<string, string | null> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: null,
};

function parseWindow(v: unknown): string {
  const k = String(v ?? "7d");
  return Object.prototype.hasOwnProperty.call(WINDOWS, k) ? k : "7d";
}

function parseStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 500);
}

const toolUsage: Capability = {
  name: "tool_usage_stats",
  title: "MCP 호출 통계",
  description:
    "하네스 MCP 툴 호출 로그(mcp_call_log) 집계 — 요약·툴별·하네스별·일별(KST)·최근 호출(인자 포함). 관리탭 'MCP 호출 통계' 대시보드 백엔드.",
  scope: "admin",
  input: {},
  expose: {
    mcp: false,
    rest: [
      {
        method: "GET",
        paths: ["/api/ui/tool-usage"],
        parse: (req) => ({
          window: req.query?.window,
          harness: req.query?.harness,
          tool: req.query?.tool,
          limit: req.query?.limit,
        }),
      },
    ],
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const window = parseWindow(i.window);
    const interval = WINDOWS[window]; // null=전체
    const harness = parseStr(i.harness);
    const tool = parseStr(i.tool);
    const limit = parseLimit(i.limit);

    // 공통 필터 — $1=interval(null=전체), $2=harness(''=전체), $3=tool(''=전체). 파라미터화(SQL 인젝션 차단).
    const where = `WHERE ($1::text IS NULL OR called_at >= now() - $1::interval)
                     AND ($2 = '' OR harness = $2)
                     AND ($3 = '' OR tool = $3)`;
    const p: unknown[] = [interval, harness, tool];

    const [summary, byTool, byHarness, byDay, recent] = await Promise.all([
      itemsPool.query(
        `SELECT count(*)::int AS total,
                count(DISTINCT tool)::int AS tools,
                count(DISTINCT harness)::int AS harnesses,
                count(*) FILTER (WHERE NOT ok)::int AS errors,
                min(called_at) AS first_at, max(called_at) AS last_at
           FROM mcp_call_log ${where}`,
        p,
      ),
      itemsPool.query(
        `SELECT tool,
                count(*)::int AS calls,
                count(*) FILTER (WHERE NOT ok)::int AS errors,
                round(avg(duration_ms))::int AS avg_ms,
                max(duration_ms)::int AS max_ms,
                max(called_at) AS last_at
           FROM mcp_call_log ${where}
          GROUP BY tool
          ORDER BY calls DESC, tool
          LIMIT 200`,
        p,
      ),
      itemsPool.query(
        `SELECT COALESCE(harness, '(미상)') AS harness,
                count(*)::int AS calls,
                count(*) FILTER (WHERE NOT ok)::int AS errors
           FROM mcp_call_log ${where}
          GROUP BY harness
          ORDER BY calls DESC`,
        p,
      ),
      itemsPool.query(
        `SELECT to_char((called_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS day,
                count(*)::int AS calls,
                count(*) FILTER (WHERE NOT ok)::int AS errors
           FROM mcp_call_log ${where}
          GROUP BY 1
          ORDER BY 1 DESC
          LIMIT 30`,
        p,
      ),
      itemsPool.query(
        `SELECT id, called_at, tool, harness, actor, ok, error, duration_ms, args
           FROM mcp_call_log ${where}
          ORDER BY called_at DESC
          LIMIT $4`,
        [...p, limit],
      ),
    ]);

    return {
      window,
      windows: Object.keys(WINDOWS),
      filters: { harness: harness || null, tool: tool || null },
      summary: summary.rows[0] ?? { total: 0, tools: 0, harnesses: 0, errors: 0, first_at: null, last_at: null },
      byTool: byTool.rows,
      byHarness: byHarness.rows,
      byDay: byDay.rows,
      recent: recent.rows,
    };
  },
};

export const toolUsageCapabilities: Capability[] = [toolUsage];

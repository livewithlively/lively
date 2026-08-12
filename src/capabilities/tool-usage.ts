// MCP 호출 통계 집계 — 프로젝트 #318 대시보드 백엔드. mcp_call_log(전수 호출 로그)를 읽어
//  요약/툴별/하네스별/일별/최근호출로 집계한다. 관리탭 'MCP 호출 통계'(/api/ui/tool-usage)가 소비.
//  scope=admin(게이트웨이 운영 정보 — 모든 구성원 호출·인자 노출). REST 전용(expose.mcp:false) — 하네스가
//  "직접 쿼리"하려면 db_query 로 mcp_call_log 를 SELECT 한다(이 집계는 사람 대시보드용 편의 표면).
import { z } from "zod";
import type { Capability } from "./types.js";
import {
  toolUsageSummary, toolUsageByTool, toolUsageByHarness, toolUsageByDay, toolUsageRecent, toolUsageToolOptions,
  toolUsageFailureReasons, toolUsageRetryWaste, toolUsageWeeklyFailure, // #1645 실패 사유·재시도 낭비·주차별 실패율
  type ToolUsageFilter,
} from "../org/tool-usage-store.js";
import { orgTimezone } from "../org/timezone.js"; // #778 일자 버킷 = 조직 시간대
import { getRuntimeConfig, getCallLogPolicySource } from "../org/store.js"; // #1082 감사로그 보관 정책

// 조회 윈도(상대 기간) — 값=postgres interval 문자열, null=전체(무제한).
//  ⚠ CSV 내보내기(audit-export-routes.ts)가 같은 값을 써 화면과 같은 기간을 자른다 — 여기를 고치면 거기도 같이.
export const WINDOWS: Record<string, string | null> = {
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

// 절대 기간(#1309) — 특정 날짜/날짜 범위. 상대 window 드롭다운으로는 "6월 3일 하루"를 볼 수 없었다.
//  잘못된 값은 무시(null)한다 — 이 화면은 대시보드라 400 으로 막기보다 필터 미적용이 낫다.
function parseIso(v: unknown): string | null {
  const t = parseStr(v);
  if (!t) return null;
  return Number.isNaN(Date.parse(t)) ? null : t;
}

function parseLimit(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 500);
}

function parseOffset(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 1_000_000);
}

function parseBool(v: unknown): boolean {
  return v === "1" || v === "true" || v === true;
}

const toolUsage: Capability = {
  name: "tool_usage_stats",
  title: "MCP 호출 통계",
  description:
    "하네스 MCP 툴 호출 로그(mcp_call_log) 집계 — 요약·툴별(실패율·p50/p90 지연)·하네스별·일별(KST)·최근 호출(인자 포함) + 실패 사유 분포·재시도 낭비(#1645). 관리탭 'MCP 호출 통계' 대시보드 백엔드.",
  scope: "admin",
  // mcp:false 여도 parse 산출과 같은 필드를 선언한다(#1403 — types.ts 의 input 규약).
  //  REST 로는 전부 쿼리스트링(문자열)으로 오고 핸들러의 parseWindow/parseIso/parseBool/clamp 가 흡수한다.
  input: {
    window: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
    harness: z.string().optional(), tool: z.string().optional(),
    limit: z.number().int().optional(), offset: z.number().int().optional(), errors: z.boolean().optional(),
  },
  expose: {
    mcp: false,
    rest: [
      {
        method: "GET",
        paths: ["/api/ui/tool-usage"],
        parse: (req) => ({
          window: req.query?.window,
          since: req.query?.since,
          until: req.query?.until,
          harness: req.query?.harness,
          tool: req.query?.tool,
          limit: req.query?.limit,
          offset: req.query?.offset,
          errors: req.query?.errors,
        }),
      },
    ],
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const window = parseWindow(i.window);
    const since = parseIso(i.since);
    const until = parseIso(i.until);
    // 절대 기간(since/until)이 하나라도 오면 상대 window 는 무시한다(#1309) — 두 기간을 AND 로 겹치면
    //  "6월 3일"을 골랐는데 window=7d 가 남아 빈 결과가 나오는 함정이 된다. 명시한 날짜가 이긴다.
    const absolute = since !== null || until !== null;
    const interval = absolute ? null : WINDOWS[window]; // null=전체(무제한)
    const harness = parseStr(i.harness);
    const tool = parseStr(i.tool);
    const limit = parseLimit(i.limit);
    const offset = parseOffset(i.offset);
    const errorsOnly = parseBool(i.errors);

    // 공통 필터 — 값만 여기서 정하고, 이게 어떤 SQL(WHERE·파라미터 순서)이 되는지는 org/tool-usage-store 가 안다.
    //  ⚠ 이 필터는 CSV 내보내기(audit-export-routes.ts, kind=tools)가 같은 의미로 복제한다 — 화면과 CSV 가
    //   다르면 감사 자료로 못 쓴다. 여기를 고치면 거기도 같이 고칠 것.
    const filter: ToolUsageFilter = { interval, harness, errorsOnly, since, until, tool };
    const tz = await orgTimezone(); // #778 일자 버킷 기준. Promise.all **밖**에서 — 안에서 await 하면 뒤 쿼리들이 직렬화된다.
    const cfg = await getRuntimeConfig(); // #1082 보관 정책(보존일수) — 이 화면이 설정 창구라 현재값을 같이 준다.

    const [summary, byTool, byHarness, byDay, recent, toolOptions, failureReasons, retryWaste, weeklyFailure] = await Promise.all([
      toolUsageSummary(filter),
      toolUsageByTool(filter),
      toolUsageByHarness(filter),
      toolUsageByDay(filter, tz),
      toolUsageRecent(filter, limit, offset),
      toolUsageToolOptions(filter),
      // #1645 — 이 둘이 없어서 knowledge_save 실패율이 두 배 오르는 걸 한 달 뒤 CSV 로야 알았다.
      toolUsageFailureReasons(filter),
      toolUsageRetryWaste(filter),
      toolUsageWeeklyFailure(filter, tz),
    ]);

    return {
      // 절대 기간이 걸려 있으면 window 는 적용되지 않았다 — 화면이 드롭다운을 「직접 지정」으로 되살릴 수 있게 그대로 알린다(#1309).
      window: absolute ? "custom" : window,
      windows: Object.keys(WINDOWS),
      since, until,
      filters: { harness: harness || null, tool: tool || null, errorsOnly, since, until },
      limit,
      offset,
      summary: summary ?? { total: 0, tools: 0, harnesses: 0, errors: 0, first_at: null, last_at: null },
      byTool,
      byHarness,
      byDay,
      recent,
      toolOptions,
      // #1645 실패 사유 분포(정규화해 묶은 것) · 재시도 낭비(실패→재시도→복구).
      //  ⚠ retryWaste 는 '오류만' 토글을 무시한다 — 실패만 남기면 그 다음 성공(복구)이 창 밖이라 복구율이
      //   늘 0%가 된다(tool-usage-store.ts 의 WHERE_RETRY 주석). 화면은 이 카드에 그 사실을 함께 표시할 것.
      failureReasons,
      retryWaste,
      weeklyFailure, // 도구별 주차 실패율 — 합계에 묻히는 '한 도구만의 역주행'을 드러낸다.
      // 보관 정책(#1082) — 이 화면이 곧 이 데이터의 설정 창구다. 보존일수·출처를 같이 실어 관리탭이 현재값을 보여준다.
      retention: cfg.call_log_policy,
      retention_source: await getCallLogPolicySource(), // db(관리탭) · env(.env 시드) · default(코드 기본값 90일)
    };
  },
};

export const toolUsageCapabilities: Capability[] = [toolUsage];

// 내 라이블리 사용 내역(#1570) — 대시보드 위젯 '내 라이블리 사용 내역'의 백엔드.
//  scope=null(인증만) · 항상 **호출자 본인**으로 스코핑된다(입력에 member 를 받지 않는다) — 남의 사용 내역은
//  이 표면으로 못 본다. 조직 전체 관점은 관리탭 'MCP 호출 통계'(#318, scope=admin)가 이미 담당한다.
//
//  왜 #318 이 있는데 또 만드는가: 원천은 같지만(mcp_call_log) 질문이 다르다. #318 은 "어떤 툴이 몇 번
//  불렸나"(운영 통계)이고 여기는 "**라이블리 덕에 내 작업에 무엇이 더해졌나**"(개인 서사)다. 같은 데이터로
//  만든 통계 화면이 이미 있는데도 개인이 효용을 못 느낀다는 것이 이 프로젝트의 출발점이라, 집계 단위를
//  사람이 한 줄로 읽는 사건으로 잡는다(store 주석 참조).
//  REST 전용(expose.mcp:false) — 하네스가 직접 캐물으려면 db_query 로 mcp_call_log 를 보면 된다.
import { z } from "zod";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { WINDOWS } from "./tool-usage.js"; // 기간 드롭다운의 단일 진실원천(#318 과 같은 창 정의를 쓴다)
import {
  livelySummary, livelyKnowledgeReads, livelyKnowledgeUsedByOthers,
  livelyHarnesses, livelyDbAccess, livelyBackgroundWork,
  livelyEvents, livelyEventCount, livelyActors,
  type LivelyLogFilter,
} from "../org/lively-log-store.js";
import { getRuntimeConfig } from "../org/store.js"; // #1082 보관 정책 — 창이 보관기간보다 길면 화면이 그 사실을 말해야 한다

function parseWindow(v: unknown): string {
  const k = String(v ?? "7d");
  return Object.prototype.hasOwnProperty.call(WINDOWS, k) ? k : "7d";
}

const livelyLog: Capability = {
  name: "my_lively_log",
  title: "내 라이블리 사용 내역",
  description:
    "호출자 본인의 라이블리 사용 내역 — 근거로 쓴 조직 지식·조직 DB 조회·하네스 넘나듦(세션 안)과 " +
    "수집·증류·자동분류·내 지식의 팀 회수(세션 밖). 대시보드 위젯 '내 라이블리 사용 내역' 백엔드.",
  scope: null,
  input: {
    window: z.string().optional(),
    // scope=all 이면 조직 전체. 본인 기록이 0 인데 화면이 텅 비는 사고를 사람이 스스로 풀 수 있게 하는 선택지다
    //  — actor 는 '세션을 만든 사람'이 아니라 접속 토큰의 신원이라, 공용 박스에선 한 계정으로 몰린다.
    scope: z.string().optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  },
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/me/lively-log"], parse: (req) => ({
      window: req.query?.window, scope: req.query?.scope, limit: req.query?.limit, offset: req.query?.offset,
    }) }],
  },
  handler: async (input, user) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    const window = parseWindow(input?.window);
    const mine = String(input?.scope ?? "me") !== "all";
    const limit = Math.min(Math.max(Number(input?.limit) || 120, 1), 400);
    const offset = Math.max(Number(input?.offset) || 0, 0);
    const f: LivelyLogFilter = { interval: WINDOWS[window], actor: user.userId, mine };

    // 위젯별 독립 실패는 프런트가 감당하지만, 한 섹션의 쿼리 실패가 나머지를 못 죽이게 여기서도 갈라 받는다.
    const [events, eventTotal, actors, summary, reads, usedByOthers, harnesses, dbAccess, background] = await Promise.all([
      livelyEvents(f, limit, offset).catch(() => []),
      livelyEventCount(f).catch(() => 0),
      livelyActors(f).catch(() => []),
      livelySummary(f).catch(() => undefined),
      livelyKnowledgeReads(f).catch(() => []),
      livelyKnowledgeUsedByOthers(f).catch(() => []),
      livelyHarnesses(f).catch(() => []),
      livelyDbAccess(f).catch(() => []),
      livelyBackgroundWork(f).catch(() => null),
    ]);

    const cfg = await getRuntimeConfig().catch(() => null);
    const retentionDays = Number(cfg?.call_log_policy?.retention_days ?? 0) || 0;

    return {
      window,
      windows: Object.keys(WINDOWS),
      actor: user.userId,
      scope: mine ? "me" : "all",
      events,          // ★ 본체 — 시간순 사건. 화면이 사람 말로 번역하고 연속 중복을 접는다.
      event_total: eventTotal,
      event_offset: offset,
      actors,          // 이 기간에 기록이 있는 사람들(내 것이 비었을 때 이유를 알 수 있게)
      summary: summary || {
        calls: 0, tools: 0, knowledge_reads: 0, knowledge_titles: 0,
        knowledge_saved: 0, activities: 0, harnesses: 0, first_at: null, last_at: null,
      },
      reads,
      usedByOthers,
      harnesses,
      dbAccess,
      background,
      // 보관기간(0=무기한). 창이 이보다 길면 "그 이전은 지워져서 안 보인다"를 화면이 말할 수 있다.
      retention_days: retentionDays,
    };
  },
};

export const livelyLogCapabilities: Capability[] = [livelyLog];

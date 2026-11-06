// recall_route — 컨텍스트 라우팅 엔드포인트(#637). 훅 전용(주입은 훅이 포맷) → REST 전용(mcp:false).
//  작업맥락(프롬프트 텍스트 + 최근 Read 파일경로)으로 (a) 도메인 HUB · (b) 파일→leaf 지식 포인터를 반환.
//  로직 전부는 v6/recall-router.ts(게임코드) — 훅은 transcript 파싱 + 이 엔드포인트 호출 + 포맷만(dumb).
//  scope=memory(knowledge-recall 훅이 쓰는 /knowledge/recall 과 동일 — 멤버 토큰이 이미 보유).
//  knowledge_recall(#5204) — 그 훅의 입구. 기준선 · 건수 · 질의는 서버가 정한다(v6/knowledge-chunk-search.ts).
import { z } from "zod";
import type { Capability } from "./types.js";
import { routeRecall } from "../v6/recall-router.js";
import { type RecallDiag, recallKnowledge } from "../v6/knowledge-chunk-search.js";
import { logKnowledgeSearch } from "../v6/knowledge-search-log-store.js";
import { isSessionCall } from "./knowledge/shared.js";

const asStrArr = (v: unknown, cap: number): string[] | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, cap) as string[] : undefined;

const recallRoute: Capability = {
  name: "recall_route",
  mutates: false, // 읽기전용(#1007): POST 지만 순수 읽기(라우팅 계산) — 매 세션 recall 훅이 REST로 호출해 맥락 주입하므로 읽기전용서도 반드시 열려야 함.
  title: "컨텍스트 라우팅(recall)",
  description:
    "작업맥락(text=프롬프트, paths=최근 Read 파일 절대경로)으로 관련 도메인 HUB·leaf 지식을 라우팅해 " +
    "**포인터**(name+title, 본문 아님)로 반환한다. (a) text→도메인 term-index 리터럴 매칭→그 도메인 HUB, " +
    "(b) paths→code_unit 최장-조상-prefix 매칭→그 도메인 leaf. exclude(세션 dedup)·budget(hubs/leaves 캡). 훅 전용.",
  scope: "memory",
  input: {
    text: z.string().max(8000).optional(),
    paths: z.array(z.string().max(1024)).max(50).optional(),
    exclude: z.array(z.string().max(64)).max(500).optional(),
    budget: z.object({
      hubs: z.number().int().min(0).max(5).optional(),
      leaves: z.number().int().min(0).max(10).optional(),
    }).optional(),
    semantic: z.boolean().optional(),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/recall/route"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const budget = (b.budget && typeof b.budget === "object") ? b.budget as Record<string, unknown> : undefined;
        return {
          text: typeof b.text === "string" ? b.text.slice(0, 8000) : undefined,
          paths: asStrArr(b.paths, 50),
          exclude: asStrArr(b.exclude, 500),
          budget: budget ? {
            hubs: typeof budget.hubs === "number" ? budget.hubs : undefined,
            leaves: typeof budget.leaves === "number" ? budget.leaves : undefined,
          } : undefined,
          semantic: b.semantic === true || b.semantic === "true",
        };
      },
    }],
  },
  // 공개범위(#1291) — 훅이 멤버 토큰으로 부르므로 게이트웨이가 신원을 안다. 그 신원으로 소환 결과를 거른다
  //  (여기가 안 막히면 잠긴 지식의 소환키가 남의 세션 첫머리에 그대로 깔린다).
  handler: async (input, _user, ctx) => routeRecall(input, ctx?.viewer ?? null),
};

// 자동 소환(#5204) — 사람 프롬프트에 넣을 지식을 고른다. 훅 전용(주입 형식은 훅이 만든다) → REST 전용. 프롬프트가 쿼리 문자열에 다 안 들어가서 POST 다.
const knowledgeRecall: Capability = {
  name: "knowledge_recall",
  mutates: false, // 읽기전용: POST 지만 순수 읽기 — recall_route 와 같다.
  title: "지식 자동 소환",
  description:
    "사람 프롬프트(text)와 앞 턴 사람 말(prev)로 그 프롬프트에 넣을 지식을 고른다. 기준선 · 건수 · 질의는 서버가 정한다. 조각으로 찾으면 맞은 절의 줄(line) · 경로(section) · 글(snippet)이 실린다. 훅 전용.",
  scope: "memory",
  input: {
    text: z.string().min(1).max(8000),
    prev: z.string().max(2000).optional(),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/knowledge/recall"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { text: typeof b.text === "string" ? b.text.slice(0, 8000) : "", prev: typeof b.prev === "string" ? b.prev.slice(0, 2000) : undefined };
      },
    }],
  },
  handler: async (input, user, ctx) => {
    const t0 = Date.now();
    const { text, prev } = input as { text: string; prev?: string };
    const diag: RecallDiag = {};
    const entries = await recallKnowledge({ text, prev }, ctx?.viewer ?? null, diag);
    //  프롬프트 원문은 남기지 않는다(knowledge-search-log-store 머리말) — 몇 건이 무엇이 나왔는지만 있으면 잴 수 있다.
    if (isSessionCall(user, ctx)) void logKnowledgeSearch({ tool: "recall", member: user.userId, session: ctx?.session, route: diag.route, names: entries.map((e) => e.name), n: entries.length, ms: Date.now() - t0 });
    const { route: _route, ...why } = diag;
    return { entries, ...why };
  },
};

export const recallCapabilities: Capability[] = [recallRoute, knowledgeRecall];

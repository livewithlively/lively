// recall_route — 컨텍스트 라우팅 엔드포인트(#637). 훅 전용(주입은 훅이 포맷) → REST 전용(mcp:false).
//  작업맥락(프롬프트 텍스트 + 최근 Read 파일경로)으로 (a) 도메인 HUB · (b) 파일→leaf 지식 포인터를 반환.
//  로직 전부는 v6/recall-router.ts(게임코드) — 훅은 transcript 파싱 + 이 엔드포인트 호출 + 포맷만(dumb).
//  scope=memory(현 knowledge-recall 훅이 쓰는 /knowledge/similar 와 동일 — 멤버 토큰이 이미 보유).
import { z } from "zod";
import type { Capability } from "./types.js";
import { routeRecall } from "../v6/recall-router.js";

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
  handler: async (input) => routeRecall(input),
};

export const recallCapabilities: Capability[] = [recallRoute];

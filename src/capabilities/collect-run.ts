// 수집 실행 표면(#4213 T11) — 내 Claude 로그인으로 claude.ai 커넥터를 읽는 실행을 한 판 띄우고, 그 상태를 본다.
//
//  · 늘 **부르는 사람 자신**의 실행이다 — 그 사람 홈의 로그인 · 그 사람 구독 · 그 사람 홈의 실행 폴더.
//    남을 대신해 띄우는 길(담당자 배정)은 수집 단위 표(T10)와 함께 서버 안쪽에서 연다. 여기는 그 실행기의 바깥 손잡이다.
//  · 이번 판은 **실행기와 실측**까지다 — 원문은 그 사람 홈에만 남고, 응답에는 목록(도구·크기·해시)만 싣는다.
//  · 지시를 직접 줄 수 있지만 도구는 늘 «허락한 claude.ai 커넥터의 읽기 도구» 뿐이다(문지기 훅 — collect-run-script.ts).
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { readCollectRun, startCollectRun } from "../terminal/collect-run.js";

const startInput = {
  apps: z.array(z.string().max(64)).max(12).optional().describe(
    "읽을 claude.ai 커넥터 앱 이름(«claude.ai » 뒤 이름 — 예 Slack · Notion · Gmail · Google Drive). 생략하면 연결된 것 전부. " +
    "앱이 많을수록 도구 정의가 문맥을 크게 먹는다(맥 실측: 다섯 개 15만 토큰 · 하나 8천 토큰) — 필요한 앱만 준다"),
  prompt: z.string().max(8000).optional().describe("지시. 생략하면 점검 지시(앱마다 읽기 도구를 한 번씩 작게 부르고 성공/실패만 답한다)"),
  model: z.string().max(64).optional().describe("모델(기본 haiku — 도구만 부르는 수집은 작은 모델로 고정)"),
  max_turns: z.number().int().min(1).max(60).optional().describe("최대 턴(기본 12)"),
  timeout_sec: z.number().int().min(60).max(3600).optional().describe("시간 상한(초, 기본 900). 넘으면 러너가 끊는다"),
};
type StartInput = z.infer<z.ZodObject<typeof startInput>>;

const optInt = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, "정수여야 합니다");
  return n;
};

const collectRunStart: Capability = {
  name: "collect_claude_run",
  title: "수집 실행 띄우기(내 Claude 커넥터)",
  description:
    "내 Claude 로그인으로 claude.ai 커넥터(Slack·Notion·Gmail 등)를 읽는 수집 실행을 한 판 띄운다(#4213 T11). " +
    "매니지드에서는 내 홈이 붙은 작은 세션 컨테이너에서 `claude -p` 가 돌고, 끝나면 그 세션이 내려간다. " +
    "도구는 허락한 커넥터의 **읽기 도구만** 부를 수 있고(쓰기·보내기는 훅이 막는다), 결과 원문은 훅이 내 홈의 실행 폴더에 그대로 남긴다. " +
    "바로 run_id 를 돌려준다 — 상태는 collect_claude_run_get. 한 사람에 한 번에 하나. " +
    "REST 등가: POST /api/ui/collect/claude-runs {apps?, prompt?, model?, max_turns?, timeout_sec?}.",
  scope: "memory",
  input: startInput,
  mutates: true,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/collect/claude-runs"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (b.apps != null && !Array.isArray(b.apps)) throw new HttpError(400, "apps 는 앱 이름 배열이어야 합니다");
        return {
          apps: Array.isArray(b.apps) ? b.apps.map((a) => String(a).slice(0, 64)).slice(0, 12) : undefined,
          prompt: b.prompt == null || b.prompt === "" ? undefined : String(b.prompt).slice(0, 8000),
          model: b.model == null || b.model === "" ? undefined : String(b.model).slice(0, 64),
          max_turns: optInt(b.max_turns),
          timeout_sec: optInt(b.timeout_sec),
        };
      } }],
  },
  handler: async (input: StartInput, user: LivelyUser) => {
    const r = await startCollectRun(user, {
      apps: input.apps, prompt: input.prompt, model: input.model, maxTurns: input.max_turns, timeoutSec: input.timeout_sec,
    });
    return { ok: true, run_id: r.runId, session_id: r.sessionId, model: r.model, apps: r.apps, timeout_sec: r.timeoutSec };
  },
};

const getInput = {
  run_id: z.string().max(64).describe("collect_claude_run 이 돌려준 run_id"),
};
type GetInput = z.infer<z.ZodObject<typeof getInput>>;

const collectRunGet: Capability = {
  name: "collect_claude_run_get",
  title: "수집 실행 상태",
  description:
    "내 수집 실행 하나의 상태 — running/done · 끝난 사유(exit) · 요약(claude 버전·뜬 커넥터·허락한 앱·없는 앱·도구 호출·토큰·메모리) · " +
    "훅이 받은 원문 목록(도구·글자 수·sha256 — 원문 자체는 싣지 않는다). 남의 실행은 볼 수 없다. " +
    "REST 등가: GET /api/ui/collect/claude-runs/:id.",
  scope: "memory",
  input: getInput,
  mutates: false,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/collect/claude-runs/:id"],
      parse: (req) => ({ run_id: String(req.params?.id ?? "") }) }],
  },
  handler: async (input: GetInput, user: LivelyUser) => readCollectRun(user, String(input.run_id || "").trim()),
};

export const collectRunCapabilities: Capability[] = [collectRunStart, collectRunGet];

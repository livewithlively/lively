// 앱 백그라운드 작업 도구 (#4486 앱 v2-7) — 시작 · 보기 · 목록 · 취소. 흐름 · 판정은 apps/app-jobs.ts(· app-jobs-plan.ts), 여기는 입력과 표면뿐이다.
//  앱 서버는 능력 REST(POST /api/ui/app-jobs — 앱 서버 토큰 + 사람 신원 · SDK livelyJobs())로, 앱 화면은 앱 주소의 /_lively/jobs(#4482 app-front-api)
//   또는 라이블리 안 다리(lively.jobs.*)로 부른다. 서버를 선언한 앱(web.server)이면 이 도구들을 함의한다(매니페스트 APP_JOB_TOOLS — 동의 창 «백그라운드 작업»).
//  기준(설계 §3-C 실행 3단): ① 요청(몇 초 · 함수 하나 요청은 30초) ② 백그라운드 작업(이것 — 같은 앱 코드 · 15분 · 메모리는 web.server.memory_mb 로 10GB 까지)
//   ③ 에이전트 작업(파일 · 도구를 반복해 쓰는 AI · 15분 넘는 일 — /_lively/ai/runs). ③ 에 가야 할 요청은 여기서 까닭과 갈 곳을 말하고 거부한다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { JOB_LABEL_MAX, JOB_ROUTE_MAX, JOB_WAIT_MAX_SEC } from "../apps/app-jobs-plan.js";

const svc = () => import("../apps/app-jobs.js");
const idOfParam = (req: { params?: unknown }): unknown => Number((req.params as Record<string, string> | undefined)?.id);
const START_KEYS = ["app_id", "route", "body", "label", "timeout_s", "type", "wait"] as const;

const appJobStart: Capability = {
  name: "app_job_start",
  title: "앱 백그라운드 작업 시작",
  description:
    "앱 서버의 라우트 하나를 뒤에서 돌린다(사람을 기다리게 하면 안 되는 일 — 회의 전사 · 큰 파일 처리 · 외부 API 를 여러 번 부르는 요약). " +
    "게이트웨이가 줄을 세우고 자리가 나면 그 앱의 함수를 비동기로 부른다 — 요청 하나(30초)와 달리 15분까지 돈다. 라우트는 POST 로 받고 본문은 body(JSON) 다. " +
    "작업은 시작한 사람으로 돈다(그 사람 ∩ 그 사람의 앱 동의 · 앱 코드엔 검사 코드가 필요 없다 — 함수 안 검사 층이 먼저 확인). 라우트는 일을 다 끝낸 뒤 답한다(답한 뒤의 일은 멈춘다). " +
    "{id,status,…} — 끝나면 status done(라우트가 2xx) · failed · canceled, result 에 라우트 응답의 앞 64KB. wait 초를 주면 끝날 때까지 기다린다(최대 25초). " +
    "15분 넘는 일 · 파일과 도구를 반복해 쓰는 AI 일은 AI 실행 입구(/_lively/ai/runs · app_ai_run)로. 상한은 app_server_limits(jobs_*).",
  scope: null,
  input: {
    app_id: z.string().optional().describe("어느 앱의 작업인가 — 앱 화면 · 앱 서버에서 부르면 생략(그 앱). 사람이 도구로 부르면 필수(그 앱에 동의했어야 한다)"),
    route: z.string().min(1).max(JOB_ROUTE_MAX).describe("돌릴 앱 라우트(경로 + 쿼리 — 예 /api/jobs/transcribe). POST 로 부른다. /_lively/* 는 안 된다"),
    body: z.unknown().optional().describe("라우트에 넘길 JSON(기본 {}) — 큰 자료(파일 · 녹음)는 앱 폴더 · 파일 주소에 두고 경로를 넘긴다(상한 app_server_limits job_body_kb · 기본 256KB)"),
    label: z.string().max(JOB_LABEL_MAX).optional().describe("짧은 이름(목록에 보인다)"),
    timeout_s: z.number().int().positive().optional().describe("이 작업의 시간 상한(초) — 생략하면 함수 시간(기본 900초). 그보다 길게 주면 거부된다(에이전트 작업으로)"),
    type: z.string().optional().describe("\"function\"(기본 — 앱 서버 라우트를 뒤에서). \"agent\" 는 받지 않는다(AI 실행 입구로)"),
    wait: z.number().int().min(0).max(JOB_WAIT_MAX_SEC).optional().describe(`끝날 때까지 기다릴 초(최대 ${JOB_WAIT_MAX_SEC}) — 안 끝나면 지금 상태를 돌려준다(app_job_get 으로 다시)`),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/app-jobs"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of START_KEYS) if (b[k] !== undefined) out[k] = b[k];
      return out;
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => (await svc()).startAppJob(input, user, { source: ctx?.source }),
};

const appJobGet: Capability = {
  name: "app_job_get",
  title: "앱 백그라운드 작업 보기",
  description: "백그라운드 작업 하나의 상태 · 결과 — status(queued · dispatched · running · done · failed · canceled) · result(라우트 응답: status_code · json 또는 text · truncated) · error · started_at · ended_at. " +
    "wait 초를 주면 끝날 때까지 기다린다(최대 25초). 작업을 시작한 사람(앱 화면 · 앱 서버면 그 앱의 그 사람)만 다 보고, 관리자는 남의 작업의 상태 · 오류만.",
  scope: null,
  input: { id: z.number().int().positive(), wait: z.number().int().min(0).max(JOB_WAIT_MAX_SEC).optional() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/app-jobs/:id"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { id: idOfParam(req), ...(q.wait !== undefined && q.wait !== "" ? { wait: Number(q.wait) } : {}) };
  } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).getAppJobFor(Number(input.id), user, input.wait),
};

const appJobs: Capability = {
  name: "app_jobs",
  title: "앱 백그라운드 작업 목록",
  description: "내 백그라운드 작업 목록(최근 것부터). 앱 화면 · 앱 서버에서 부르면 그 앱의 내 작업, 관리자는 워크스페이스 전체(남의 것은 상태 · 오류만). status · app_id 로 좁힌다. " +
    "결과 본문은 싣지 않는다(작업마다 64KB 까지라) — 결과는 app_job_get 으로.",
  scope: null,
  input: {
    app_id: z.string().optional(),
    status: z.string().optional().describe("queued · dispatched · running · done · failed · canceled"),
    limit: z.number().int().min(1).max(100).optional(),
  },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/app-jobs"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { ...(q.app_id ? { app_id: String(q.app_id) } : {}), ...(q.status ? { status: String(q.status) } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}) };
  } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).listAppJobsFor(input, user),
};

const appJobCancel: Capability = {
  name: "app_job_cancel",
  title: "앱 백그라운드 작업 취소",
  description: "백그라운드 작업을 취소한다 — 기다리는 작업은 곧바로 끝내고, 도는 작업은 함수 안 검사 층이 다음 박동(20초 안)에 앱 요청을 끊는다(그동안 그 작업의 라이블리 호출은 막힌다). " +
    "작업을 시작한 사람(앱 화면 · 앱 서버면 그 앱의 그 사람)과 관리자.",
  scope: null,
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/app-jobs/:id/cancel"], parse: (req) => ({ id: idOfParam(req) }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).cancelAppJobFor(Number(input.id), user),
};

export const appJobCapabilities: Capability[] = [appJobStart, appJobGet, appJobs, appJobCancel];

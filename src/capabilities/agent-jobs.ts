// 작업 컨테이너 도구 (#4490 앱 v2-11) — 에이전트 작업을 보내고 · 보고 · 취소하고, 워크스페이스 상한을 보고 고친다.
//  흐름·판정은 agent-jobs/service.ts(살아 있는 의존은 live.ts), 여기는 입력과 표면뿐이다.
//  앱 화면은 다리(/api/ui/apps/:id/tool-call)나 앱 주소의 /_lively/*(#4482)로 부른다 — 매니페스트 permissions.tools 에 선언하고 사람이 동의해야 한다
//  (앱 principal 재판정 · 두 길 다 runAppTool). 앱 서버 · 앱 토큰 · 작업 안에서는 못 보낸다(agent-jobs/service.assertMaySubmit).
//  v2-9 의 `/_lively/ai/runs`(에이전트·구독 갈래)가 이 흐름을 감싼다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { SOFT_CAPS, applySoftCaps, softCapHint } from "./soft-cap.js";
import {
  AGENT_JOB_POLICY_RANGE, DEFAULT_AGENT_JOB_POLICY, agentJobPolicyPatchError, agentJobPolicySource, invalidateAgentJobPolicyCache, resolveAgentJobPolicy,
  type AgentJobPolicy,
} from "../org/policies/agent-job-policy.js";
import { PROMPT_MAX } from "../agent-jobs/plan.js";

const deps = async () => (await import("../agent-jobs/live.js")).liveAgentJobDeps();
const svc = () => import("../agent-jobs/service.js");
const idOfParam = (req: { params?: unknown }): unknown => Number((req.params as Record<string, string> | undefined)?.id);

const agentJobRunInput = {
  prompt: z.string().min(1).max(PROMPT_MAX).describe("작업 지시(전문). 하네스(claude -p)의 첫 말로 들어간다"),
  project_id: z.number().int().positive().optional().describe("이 프로젝트 폴더(/work/shared/project/<id>)에서 돈다 — 앱 작업이면 그 앱 폴더가 <작업 폴더>/.lively/apps/<앱> 에 붙는다"),
  app_id: z.string().optional().describe("이 앱의 폴더(/work/apps/<앱>)에서 돈다(그 앱에 동의했어야 한다). 앱 화면에서 부르면 생략해도 그 앱 폴더다"),
  timeout_min: z.number().int().positive().optional().describe("실행 시간 상한(분) — 생략하면 워크스페이스 기본, 넘으면 최대로 접는다"),
  model: z.string().max(64).optional().describe("하네스 모델(sonnet·opus·haiku 또는 전체 id). 생략하면 그 사람 기본"),
  label: z.string().optional().describe(`짧은 이름(목록에 보인다). ${softCapHint(SOFT_CAPS.agent_job_run!.label!)}`),
  resume_job_id: z.number().int().positive().optional().describe("이 끝난 작업의 대화를 이어받는다(같은 사람·같은 앱 · 작업 폴더도 그 작업 것)"),
};

const agentJobRun: Capability = {
  name: "agent_job_run",
  title: "에이전트 작업 보내기",
  //  ⚠ 설명은 모든 세션의 MCP 맥락에 실린다 — 핵심 세 줄만(격리 리뷰). 누가 보낼 수 있나 · 신뢰의 뜻은 agent-jobs/service.ts 머리말.
  description:
    "에이전트 작업을 별도 작업 컨테이너에서 돌린다(사람 세션이 없어도 돈다) — **보낸 사람 본인으로**(본인 Claude 구독·홈) 돈다. 작업 폴더는 project_id 또는 app_id(앱 화면이면 그 앱 폴더). " +
    "곧바로 {id,status} 를 돌려준다 — 결과는 agent_job_get. 동시 상한을 넘으면 기다리고 대기열이 차면 429. " +
    "앱 서버·앱 토큰·작업 안에서는 보낼 수 없다. 매니지드 전용(501).",
  scope: "context",
  input: agentJobRunInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/agent-jobs"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(agentJobRunInput)) if (b[k] !== undefined) out[k] = b[k];
      return out;
    } }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    //  #1442 짧은 메타 필드 조정 — 큰 프롬프트를 실은 호출이 이름표 길이 하나로 통째로 튕기지 않게. 보고는 응답 capped 로.
    const capped = applySoftCaps("agent_job_run", input, SOFT_CAPS.agent_job_run!);
    //  ctx.source 'app-ui' = 앱 화면 다리(app-tool-call.ts)를 지나 왔다 — 앱 주체는 이 길로만 받는다(service.assertMaySubmit).
    return { ...(await (await svc()).submitAgentJob(input, user, await deps(), { source: ctx?.source })), ...capped };
  },
};

const agentJobGet: Capability = {
  name: "agent_job_get",
  title: "에이전트 작업 보기",
  description: "에이전트 작업 하나의 상태·결과 — status(queued·starting·running·done·failed·timeout·canceled) · result(text·is_error·num_turns·cost_usd·usage) · error · " +
    "output_tail(진행 요지) · conversation_id(이어받기용) · queue_position(대기 중일 때 앞에 몇 건). 보낸 사람 본인(앱 화면이면 그 앱의 작업)만 다 보고, 관리자는 남의 작업의 상태·오류만 본다.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/agent-jobs/:id"], parse: (req) => ({ id: idOfParam(req) }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).getAgentJobFor(Number(input.id), user, await deps()),
};

const agentJobList: Capability = {
  name: "agent_job_list",
  title: "에이전트 작업 목록",
  description: "내 에이전트 작업 목록(최근 것부터) — 한 줄은 요약이다(답은 result_preview 앞머리 · 전문은 agent_job_get). 앱 화면에서 부르면 그 앱의 내 작업만, 관리자는 워크스페이스 전체(남의 작업은 상태·오류만). status·app_id 로 좁힌다.",
  scope: "context",
  input: {
    app_id: z.string().optional(),
    status: z.string().optional().describe("queued · starting · running · done · failed · timeout · canceled"),
    limit: z.number().int().min(1).max(100).optional(),
  },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/agent-jobs"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { ...(q.app_id ? { app_id: String(q.app_id) } : {}), ...(q.status ? { status: String(q.status) } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}) };
  } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).listAgentJobsFor(input, user, await deps()),
};

const agentJobCancel: Capability = {
  name: "agent_job_cancel",
  title: "에이전트 작업 취소",
  description: "에이전트 작업을 취소한다 — 기다리는 중이면 바로 끝나고, 도는 중이면 몇 초 안에 하네스를 끊고 컨테이너를 걷는다. 보낸 사람 본인(앱 화면이면 그 앱의 작업)과 관리자.",
  scope: "context",
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/agent-jobs/:id/cancel"], parse: (req) => ({ id: idOfParam(req) }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).cancelAgentJobFor(Number(input.id), user, await deps()),
};

// ── 워크스페이스 상한 — org_runtime_config.agent_job_policy 한 칸(앱 판 상한 app_bundle_limits 와 같은 꼴) ──
const KEYS = Object.keys(DEFAULT_AGENT_JOB_POLICY) as Array<keyof AgentJobPolicy>;

async function limitsSnapshot(): Promise<Record<string, unknown>> {
  const { agentJobPolicyRow } = await import("../agent-jobs/store.js");
  const row = await agentJobPolicyRow();
  return {
    policy: resolveAgentJobPolicy(row),          // 지금 쓰는 값(DB > env 시드 > 기본값)
    workspace_setting: row,                      // 관리자가 이 워크스페이스에 적은 값
    source: agentJobPolicySource(row),
    defaults: DEFAULT_AGENT_JOB_POLICY,
    range: AGENT_JOB_POLICY_RANGE,
  };
}

const agentJobLimits: Capability = {
  name: "agent_job_limits",
  title: "에이전트 작업 상한 보기",
  description: "작업 컨테이너의 워크스페이스 상한 — max_running(동시) · max_running_per_member(실행 계정당 동시 — 공용 시트 작업은 보낸 사람당) · " +
    "max_running_per_service_seat(공용 시트 하나로 동시 — #5081 · 안 적으면 기본값을 max_running 으로 접는다) · max_queued(대기열) · queue_wait_min(대기 상한) · " +
    "default_timeout_min · max_timeout_min(실행 시간) · silent_sec(판 무응답) · start_timeout_sec(시작 상한) · keep_days(끝난 작업 기록 보존 일수 — 지나면 행째 지움 · 0 = 무기한 · 앱 AI 실행 기록은 따로 남음). " +
    "고치기는 관리자 agent_job_limits_set. 구성원 누구나.",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/agent-job-limits"], parse: () => ({}) }] },
  handler: async () => limitsSnapshot(),
};

const agentJobLimitsSetInput = {
  ...Object.fromEntries(KEYS.map((k) => [k, z.number().int().min(AGENT_JOB_POLICY_RANGE[k][0]).max(AGENT_JOB_POLICY_RANGE[k][1]).optional()])),
  reset: z.boolean().optional().describe("true 면 워크스페이스 값을 지워 기본으로"),
} as Record<string, z.ZodTypeAny>;

const agentJobLimitsSet: Capability = {
  name: "agent_job_limits_set",
  title: "에이전트 작업 상한 고치기",
  description: "이 워크스페이스의 작업 컨테이너 상한을 고친다(배포 없이 바로 먹는다). 준 값만 바뀌고 reset:true 면 기본으로 되돌린다. " +
    "범위: " + KEYS.map((k) => `${k} ${AGENT_JOB_POLICY_RANGE[k][0]}~${AGENT_JOB_POLICY_RANGE[k][1]}`).join(" · ") + ". 관리자.",
  scope: "admin",
  input: agentJobLimitsSetInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/agent-job-limits"], parse: (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of [...KEYS, "reset"]) if (b[k] !== undefined) out[k] = b[k];
    return out;
  } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    const { agentJobPolicyRow, writeAgentJobPolicyRow } = await import("../agent-jobs/store.js");
    const before = await agentJobPolicyRow();
    let next: Record<string, number> = {};
    if (input.reset !== true) {
      for (const k of KEYS) if (typeof before[k] === "number") next[k] = before[k] as number;
      for (const k of KEYS) {
        if (input[k] === undefined) continue;
        const n = Number(input[k]);
        const [lo, hi] = AGENT_JOB_POLICY_RANGE[k];
        if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${k} 는 ${lo}~${hi} 정수여야 합니다`);
        next[k] = n;
      }
      //  축 사이 관계를 어기면 거절한다(조용히 접지 않는다 — agentJobPolicyPatchError 머리말).
      const bad = agentJobPolicyPatchError(next);
      if (bad) throw new HttpError(400, bad);
    }
    await writeAgentJobPolicyRow(next);
    invalidateAgentJobPolicyCache();
    const { audit } = await import("../org/store/audit.js");
    await audit("org_runtime_config", "1", "agent_job_policy", before, next, user?.userId || user?.email || "unknown", ctx?.source ?? "web");
    return { ok: true, ...(await limitsSnapshot()) };
  },
};

export const agentJobCapabilities: Capability[] = [agentJobRun, agentJobGet, agentJobList, agentJobCancel, agentJobLimits, agentJobLimitsSet];

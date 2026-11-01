// org_cron 관리 capability — 서버사이드 스케줄 잡 CRUD + 즉시실행. admin scope(게이트웨이 운영 — 멤버머신 runtime 아님).
//  웹 관리탭(REST /api/ui/cron)·MCP 양쪽 노출. 보안: action 은 allowlist(스키마 CHECK + 여기 zod enum) — 임의 셸 금지.
//  실행 엔진은 scheduler/index.ts(인프로세스). 여기는 정의(org_cron 행)만 관리 + run_now 위임.
import { z } from "zod";
import { HttpError } from "./rest-util.js";
import type { Capability } from "./types.js";
import { listCronJobs, getCronJob, insertCronJob, updateCronJob, deleteCronJob } from "../org/cron-store.js";
import { runCronById, CRON_ACTIONS, CRON_ACTION_KEYS } from "../scheduler/index.js";
import { planDistillRun, DISTILL_ACTIONS } from "../scheduler/actions/distill.js";
import { isValidCron } from "../scheduler/cron-expr.js";
import { orgTimezone } from "../org/timezone.js"; // #778 cron_expr 해석 기준 시간대(폼 힌트용)

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseCronId(v: unknown): string {
  const id = String(v ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "id 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
  return id;
}

const cronList: Capability = {
  name: "cron_list",
  title: "스케줄 잡 목록",
  description: "서버사이드 스케줄 잡(org_cron) 목록 — 액션·주기·enabled·마지막 실행 상태/요약·다음 실행. 트리거 표준화의 관리 표면. " +
    "timezone = cron_expr 을 해석하는 벽시계 기준(조직 시간대).",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/cron"], parse: () => ({}) }],
  },
  // timezone(#778): cron_expr 이 '서버 로컬 TZ' 가 아니라 조직 시간대로 해석된다는 걸 호출자(웹 폼·MCP)가 알아야
  //  '0 9 * * *' 를 UTC 로 오해하지 않는다. 폼이 이 값을 그대로 힌트로 띄운다.
  handler: async () => ({
    jobs: await listCronJobs(),
    actions: CRON_ACTIONS,
    timezone: await orgTimezone(),
  }),
};

const cronSet: Capability = {
  name: "cron_set",
  title: "스케줄 잡 생성/수정",
  description:
    "스케줄 잡을 upsert(id 기준). action 은 등록된 액션 레지스트리(CRON_ACTIONS) 중 하나(임의 셸 불가). " +
    "스케줄 2모드: cron_expr(절대 벽시계 5필드, 예 '0 9 * * 1-5')가 있으면 그게 우선, 없으면 interval_sec(상대, 최소 60s). " +
    "⚠ cron_expr 은 **조직 시간대**(org_profile.timezone, 기본 Asia/Seoul — cron_list 의 timezone)의 벽시계로 해석된다(UTC·서버 로컬 아님). " +
    "cron_expr=\"\"(빈문자열)로 보내면 interval 모드로 되돌림. params=액션 인자(예: refresh_repo→{repo}, connector_sync→{system}). 커스텀 잡은 이걸로 추가.",
  scope: "memory",
  input: {
    id: z.string(),
    action: z.string().optional(),
    label: z.string().max(200).optional(),
    params: z.record(z.unknown()).optional(),
    interval_sec: z.number().int().min(60).optional(),
    cron_expr: z.string().max(120).optional(),
    run_once: z.boolean().optional(), // true = 1회 실행 후 자동 비활성(반복 안 함). interval/cron 무시.
    enabled: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    // #1675 ④ — 이 잡이 연속 몇 번 실패하면 스스로 멈출지. 0=이 잡만 브레이커 끔.
    //  적정값이 잡마다 다르다: 증류처럼 자주 도는 잡은 짧게, 외부 API 커넥터는 일시 장애를 견디게 길게.
    max_fail_streak: z.number().int().min(0).max(100).optional(),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron"], parse: (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return {
        id: b.id, action: b.action, label: b.label, params: b.params,
        interval_sec: b.interval_sec != null ? Number(b.interval_sec) : undefined,
        cron_expr: b.cron_expr != null ? String(b.cron_expr) : undefined,
        run_once: typeof b.run_once === "boolean" ? b.run_once : undefined,
        enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
        note: b.note,
        max_fail_streak: b.max_fail_streak != null ? Number(b.max_fail_streak) : undefined,
      };
    } }],
  },
  handler: async (input: any, user: any, ctx: any) => {
    const id = parseCronId(input.id);
    const actor = ctx?.actor ?? user?.userId ?? null;
    if (input.action && !CRON_ACTION_KEYS.includes(input.action)) {
      throw new HttpError(400, "action 이 allowlist 밖입니다 — 등록된 액션: " + CRON_ACTION_KEYS.join(", "));
    }
    // cron_expr: ""=명시적 비움(interval 모드 복귀), 미제공=유지(수정 시), 값=검증 후 설정.
    if (input.cron_expr != null && input.cron_expr !== "" && !isValidCron(input.cron_expr)) {
      throw new HttpError(400, "cron_expr 가 올바르지 않습니다(5필드: 분 시 일 월 요일, 예: '0 9 * * 1-5' / '*/10 * * * *')");
    }
    const cronProvided = input.cron_expr !== undefined;
    const cronVal: string | null = input.cron_expr === "" ? null : (input.cron_expr ?? null);

    const existing = await getCronJob(id);
    if (!existing) {
      if (!input.action) throw new HttpError(400, "신규 잡은 action 이 필요합니다");
      const job = await insertCronJob({
        id, label: input.label ?? null, action: input.action, params: JSON.stringify(input.params ?? {}),
        interval_sec: input.interval_sec ?? 600, cron_expr: cronVal,
        enabled: input.enabled ?? null, note: input.note ?? null, run_once: input.run_once ?? null,
        max_fail_streak: input.max_fail_streak ?? null, actor,
      });
      return { job };
    }
    const job = await updateCronJob({
      id, label: input.label ?? null, action: input.action ?? null,
      params: input.params != null ? JSON.stringify(input.params) : null,
      interval_sec: input.interval_sec ?? null, cron_provided: cronProvided, cron_expr: cronVal,
      enabled: input.enabled ?? null, note: input.note ?? null, run_once: input.run_once ?? null,
      max_fail_streak: input.max_fail_streak ?? null, actor,
    });
    return { job };
  },
};

const cronDelete: Capability = {
  name: "cron_delete",
  title: "스케줄 잡 삭제",
  description:
    "스케줄 잡을 삭제한다. ⚠ 시드 기본 잡(refresh-all-domainmap)은 삭제해도 재부팅 시 시드(ON CONFLICT DO NOTHING)가 다시 만든다 — 끄려면 cron_set 으로 enabled=false.",
  scope: "memory",
  input: { id: z.string() },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron/:id/delete"], parse: (req) => ({ id: req.params?.id }) }],
  },
  handler: async (input: any) => {
    const id = parseCronId(input.id);
    return { deleted: await deleteCronJob(id), id };
  },
};

/** 증류 잡이 아니면 거절한다 — 모르는 값을 조용히 넘기면 시범 삼아 준 값이 안 듣고 그냥 돈다. */
async function distillJob(id: string): Promise<{ action: string; params: Record<string, unknown> | null }> {
  const job = await getCronJob(id);
  if (!job) throw new HttpError(404, `잡 '${id}' 이(가) 없습니다`);
  if (!DISTILL_ACTIONS.has(job.action)) throw new HttpError(400, `증류 잡에만 쓸 수 있습니다 — '${id}' 의 액션은 ${job.action} 입니다`);
  return job;
}

const cronRunNow: Capability = {
  name: "cron_run_now",
  title: "스케줄 잡 즉시 실행",
  description: "스케줄 잡을 주기와 무관하게 지금 1회 실행(온디맨드 'refresh now'). 결과 요약 반환. 이미 실행 중이면 skip. " +
    "⚠ 증류 잡(distill_sources·distill_sources_headless)을 레인 지정 없이 돌리면 켜진 레인뿐 아니라 **맡은 레인이 없는 자료도 기본 기준으로 함께 나간다**. " +
    "시범 실행이면 먼저 cron_run_plan 으로 무엇이 나가는지 보고, 레인 몫만 돌리려면 lanes_only=true 로 실행한다.",
  scope: "memory",
  input: {
    id: z.string(),
    lanes_only: z.boolean().optional().describe("증류 잡 전용 — 이번 1회는 켜진 레인 몫만 낸다. 맡은 레인이 없는 자료는 빠진다(잡 설정은 안 바뀌고, 켜 둔 자동 실행은 다음 주기에 그 자료를 낸다). 증류가 아닌 잡에 주면 400."),
  },
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/cron/:id/run"], parse: (req) => ({ id: req.params?.id, lanes_only: (req.body as { lanes_only?: unknown } | undefined)?.lanes_only === true }) }],
  },
  handler: async (input: any) => {
    const id = parseCronId(input.id);
    if (input.lanes_only !== true) return runCronById(id);
    await distillJob(id);
    return runCronById(id, { lanes_only: true });
  },
};

//  (#5235) ⚠ 미리보기를 cron_run_now 의 인자로 얹지 **않는다**. 옛 코어는 모르는 인자를 떨구고 그 요청을 실제 실행으로 처리한다 —
//   배포·롤백 중 새 화면이 옛 게이트웨이를 만나면 «무엇이 나가는지 보려던» 호출이 곧 배치 접수가 되고, 확인창 없이 기본 기준 배치가 나간다.
//   안전장치가 그 사고를 일으키는 셈이다. 이름이 다르면 옛 코어는 없는 도구·404 로 멈추고 화면은 실행하지 않는다.
//   다른 동작은 다른 이름으로(delivery/classifiers.ts 머리말 · #4194).
const cronRunPlan: Capability = {
  name: "cron_run_plan",
  title: "증류 잡 실행 계획",
  description: "증류 잡(distill_sources·distill_sources_headless)을 지금 돌리면 무엇이 나갈지만 돌려준다 — 접수하지 않고 AI 도 안 부르며 잡 기록도 안 바뀐다. " +
    "plan.lanes = 레인별 이번 배치 · plan.unassigned = 맡은 레인이 없어 기본 기준으로 나갈 자료(sources 이번 · total 앞으로 나갈 전체, 없으면 null) · plan.notice · plan.skipped(안 도는 이유). " +
    "판정은 실행과 같은 코드다. 증류가 아닌 잡이면 400, 없는 잡이면 404.",
  scope: "memory",
  input: {
    id: z.string(),
    lanes_only: z.boolean().optional().describe("true 면 cron_run_now 를 lanes_only 로 돌렸을 때의 계획을 본다"),
  },
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/cron/:id/run-plan"], parse: (req) => ({ id: req.params?.id, lanes_only: req.query?.lanes_only === "true" }) }],
  },
  handler: async (input: any) => {
    const id = parseCronId(input.id);
    const job = await distillJob(id);
    return { id, action: job.action, plan: await planDistillRun(job.action, { ...(job.params ?? {}), ...(input.lanes_only === true ? { lanes_only: true } : {}) }) };
  },
};

export const cronCapabilities: Capability[] = [cronList, cronSet, cronDelete, cronRunNow, cronRunPlan];

// 앱 AI 실행 도구 (#4488 앱 v2-9) — 입구 하나 `app_ai_run`(= 앱 주소 `/_lively/ai/runs`) + 보기 · 목록 · 취소 · 대상 · 실행 계정 설정 · 상한.
//  흐름·판정은 ai-runs/service.ts(살아 있는 의존은 live.ts), 여기는 입력과 표면뿐이다.
//  앱 화면은 다리(/api/ui/apps/:id/tool-call)나 앱 주소의 /_lively/ai/*(#4482 app-front-api)로 부른다 — 매니페스트 permissions.ai_runs 를 선언하고 사람이 동의해야 한다.
//  앱 서버는 능력 REST(/api/ui/ai-runs · 앱 서버 토큰 + 사람 신원)로 부른다 — 실행 계정이 구독이면 거절된다(구독은 사람이 앱 화면에서 보낸 것만).
//   예외: 공용 시트(#5081 — app_ai_service_seat_set 으로 관리자 승인 + 본인 동의)는 앱 서버가 사람 신원을 실어 보낸 요청도 받는다.
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "./rest-util.js";
import { isAdmin } from "./principal.js";
import { SOFT_CAPS, applySoftCaps, softCapHint } from "./soft-cap.js";
import { AI_RUN_POLICY_RANGE, DEFAULT_AI_RUN_POLICY, aiRunPolicySource, invalidateAiRunPolicyCache, resolveAiRunPolicy, type AiRunPolicy } from "../org/policies/ai-run-policy.js";
import {
  JOB_NAME_RE, MODEL_RE, PROMPT_MAX, WAIT_MAX_SEC, accountSetRefusal, parseAccountSettings, seatShared, seatState, serviceSeatChange,
  serviceSeatConsented, type AiAccount, type AiAccountSettings, type SeatTarget,
} from "../ai-runs/plan.js";
import { APP_ID_RE } from "../agent-jobs/plan.js";

const deps = async () => (await import("../ai-runs/live.js")).liveAiRunDeps();
const svc = () => import("../ai-runs/service.js");
const idOfParam = (req: { params?: unknown }): unknown => Number((req.params as Record<string, string> | undefined)?.id);
const pickBody = (b: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (b[k] !== undefined) out[k] = b[k];
  return out;
};

const aiRunInput = {
  app_id: z.string().optional().describe("어느 앱의 실행인가 — 앱 화면 · 앱 서버에서 부르면 생략(그 앱). 사람이 도구로 부르면 필수(그 앱에 동의했어야 한다)"),
  prompt: z.string().min(1).max(PROMPT_MAX).describe("AI 에게 줄 지시(전문). 단발이면 LLM 한 번, 에이전트 작업이면 하네스(claude -p)의 첫 말"),
  system: z.string().max(20_000).optional().describe("시스템 지시(선택)"),
  schema: z.record(z.unknown()).optional().describe("결과 JSON Schema(선택) — 주면 게이트웨이가 형식 지시를 붙이고 답을 검사한다. 어긋나면 «형식에 맞게 다시» 1회, 그래도 어긋나면 원문을 붙여 실패. 맞으면 result.json"),
  job: z.string().regex(JOB_NAME_RE).optional().describe("작업 이름(매니페스트 ai.jobs 에 선언한 것) — 작업별 실행 계정을 쓴다. 생략하면 앱별 > 워크스페이스 기본값. 그 작업이 ai.instructions 를 선언했으면 부른 사람(앱 주소 · 앱 서버면 그 주소)의 판에서 지시 파일을 접수 때 읽어 시스템 지시로 싣는다 — 에이전트 작업은 그때 작업 폴더의 CLAUDE.md · .claude/(skills · agents · commands · settings)를 읽지 않는다"),
  model: z.string().regex(MODEL_RE).optional().describe("모델(선택). 단발은 워크스페이스 기본 모델, 에이전트 작업은 하네스 기본"),
  label: z.string().optional().describe(`짧은 이름(목록에 보인다). ${softCapHint(SOFT_CAPS.app_ai_run!.label!)}`),
  files: z.array(z.string().max(512)).max(50).optional().describe("관련 파일(작업 폴더 기준) — 주면 **에이전트 작업**(작업 컨테이너 · 파일 · 도구)이 된다"),
  project_id: z.number().int().positive().optional().describe("이 프로젝트 폴더에서 돈다(에이전트 작업 · 앱 폴더는 .lively/apps/<앱> 에 붙는다)"),
  agent: z.boolean().optional().describe("true 면 파일을 안 줘도 에이전트 작업(도구 있음)으로 돈다"),
  timeout_min: z.number().int().positive().optional().describe("에이전트 작업의 실행 시간 상한(분)"),
  wait: z.number().int().min(0).max(WAIT_MAX_SEC).optional().describe(`끝날 때까지 기다릴 초(최대 ${WAIT_MAX_SEC}) — 단발은 보통 몇 초라 한 번에 결과를 받는다. 안 끝나면 지금 상태를 돌려준다(app_ai_run_get 으로 다시)`),
  resume_run_id: z.number().int().positive().optional().describe(
    "이 끝난 실행(done · failed)의 대화를 이어받아 prompt(고칠 점 · 사유)로 다시 시킨다 — 새 실행이 생기고 앞 실행은 그대로 남는다. 같은 앱 · 같은 요청자 · 같은 자리" +
    "(앱 화면에서 시작한 대화는 앱 화면에서, 앱 서버가 시작한 대화는 앱 서버에서)만. 실행 계정 · 작업 종류 · 작업 폴더 · 작업 이름 · system 은 앞 실행 것" +
    "(schema 는 안 주면 앞 실행 것 · model 은 바꿀 수 있다). 한 질문(처음 실행)당 상한 max_resumes(app_ai_limits · 갈래 포함) — 넘으면 409 resume_limit"),
  reason: z.string().optional().describe(`이어받는 까닭 — 실행 기록(resume.reason)에 남는 짧은 이름표(선택 · 안 주면 null — 사유 원문은 그 실행의 prompt). AI 에게는 prompt 가 간다. ${softCapHint(SOFT_CAPS.app_ai_run!.reason!)}`),
};
const AI_RUN_KEYS = Object.keys(aiRunInput);

const appAiRun: Capability = {
  name: "app_ai_run",
  title: "앱 AI 실행",
  description:
    "앱의 AI 작업 입구 하나(/_lively/ai/runs). 프롬프트(+결과 스키마 · 파일 · 작업 이름)를 보내면 게이트웨이가 실행 계정(작업별 > 앱별 > 워크스페이스 기본값 — API 키 또는 본인 구독)과 자리를 고른다: " +
    "단발+API 키는 LLM 프록시(몇 초), 그 밖은 작업 컨테이너. {id,status,result} — 끝나면 result.text(스키마면 result.json). 구독은 그 사람 본인(그 세션의 AI 포함)과 그 사람 세션에 초대받은 사람이 그 세션에서 보낸 요청만 — 앱 서버 · 자동화는 API 키. " +
    "공용 시트(관리자 승인 + 그 계정 본인 동의 — app_ai_service_seat_set)로 지정된 구독은 워크스페이스 구성원 누구의 요청이든 받는다(앱 서버가 사람 신원을 실어 보낸 요청 포함 · 앱 폴더에서만 · 작업 AI 의 라이블리 신원은 물은 사람). " +
    "실행 계정이 없으면 409 account_unavailable. 상한: 앱당 분당 · 사람당 동시 · 앱당 하루 토큰(app_ai_limits). " +
    "이어받기: 앱이 답을 검사하고 어긋나면 resume_run_id + prompt(사유)로 그 대화를 잇는 새 실행을 보낸다(응답 resume{of,root,depth,reason}).",
  scope: null,
  input: aiRunInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/ai-runs"], parse: (req) => pickBody((req.body ?? {}) as Record<string, unknown>, AI_RUN_KEYS) }],
  },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    //  #1442 짧은 메타 필드 조정 — 큰 프롬프트를 실은 호출이 이름표 길이 하나로 통째로 튕기지 않게. 보고는 응답 capped 로.
    const capped = applySoftCaps("app_ai_run", input, SOFT_CAPS.app_ai_run!);
    return { ...(await (await svc()).submitRun(input, user, { source: ctx?.source, session: ctx?.session }, await deps())), ...capped };
  },
};

const appAiRunGet: Capability = {
  name: "app_ai_run_get",
  title: "앱 AI 실행 보기",
  description: "AI 실행 하나의 상태·결과 — status(queued·running·done·failed·canceled) · result(text · json · model · usage · duration_ms · retries) · error · " +
    "resume(이어받은 실행이면 {of: 이어받은 실행 · root: 처음 실행 · depth: 몇 번째 · reason}, 아니면 null). 보낸 사람 본인(앱 화면이면 그 앱의 실행)만 다 보고, 관리자는 남의 실행의 상태·오류만.",
  scope: null,
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/ai-runs/:id"], parse: (req) => ({ id: idOfParam(req) }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).getRunFor(Number(input.id), user, await deps()),
};

const appAiRuns: Capability = {
  name: "app_ai_runs",
  title: "앱 AI 실행 목록",
  description: "내 AI 실행 목록(최근 것부터 · 요약 — 전문은 app_ai_run_get). 앱 화면에서 부르면 그 앱의 내 실행만, 관리자는 워크스페이스 전체(남의 것은 상태·오류만). status · app_id 로 좁힌다.",
  scope: null,
  input: { app_id: z.string().optional(), status: z.string().optional().describe("queued · running · done · failed · canceled"), limit: z.number().int().min(1).max(100).optional() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/ai-runs"], parse: (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { ...(q.app_id ? { app_id: String(q.app_id) } : {}), ...(q.status ? { status: String(q.status) } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}) };
  } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).listRunsFor(input, user, await deps()),
};

const appAiRunCancel: Capability = {
  name: "app_ai_run_cancel",
  title: "앱 AI 실행 취소",
  description: "AI 실행을 취소한다 — 작업 컨테이너 실행은 몇 초 안에 하네스를 끊고, 단발은 결과를 버린다. 보낸 사람 본인(앱 화면이면 그 앱의 실행)과 관리자.",
  scope: null,
  input: { id: z.number().int().positive() },
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/ai-runs/:id/cancel"], parse: (req) => ({ id: idOfParam(req) }) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser) => (await svc()).cancelRunFor(Number(input.id), user, await deps()),
};

const appAiTargets: Capability = {
  name: "app_ai_targets",
  title: "앱 AI 실행 대상",
  description: "이 앱이 지금 고를 수 있는 것 — 실행 계정(워크스페이스가 정한 것 · 쓸 수 있나 · 구독이면 로그인 여부) · 선언한 작업과 그 실행 계정 · 이 앱이 붙은 내 세션(본 대화에 보내기 가능) · 이 앱이 만든 대화(이어받기). 분기(fork)는 아직 없다.",
  scope: null,
  input: { app_id: z.string().optional() },
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/ai-targets"], parse: (req) => { const q = (req.query ?? {}) as Record<string, unknown>; return q.app_id ? { app_id: String(q.app_id) } : {}; } }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => (await svc()).targetsFor(user, input, await deps(), { session: ctx?.session }),
};

// ── 실행 계정 설정 — org_runtime_config.app_ai_account 한 칸 ──
/**
 * 설정 + 공용 시트 한 줄씩의 상태(seats — #5081 · plan.seatState: on · admin_pending · member_pending · elevated · inactive · unknown).
 *  settings.service_seats 는 적힌 그대로(승인 · 동의 시각), seats 는 지금 그 계정의 사실을 더해 읽은 것이다 — 화면은 seats 를 쓴다.
 */
async function accountSnapshot(): Promise<Record<string, unknown>> {
  const d = await deps();
  const [settings, key] = await Promise.all([d.accountSettings(), d.apiKey()]);
  const seats = await Promise.all(Object.entries(settings.service_seats ?? {}).map(async ([member, seat]) => {
    const f = await d.memberFacts(member).catch(() => null);
    const state = seatState(seat, f);
    return { member, on: state === "on", state, admin_approved: seat.admin ?? null, member_consented: seat.member ?? null };
  }));
  return { settings, api_key_registered: !!key, effective_default: settings.default ?? (key ? { kind: "api_key" } : null), seats };
}

const appAiAccount: Capability = {
  name: "app_ai_account",
  title: "앱 AI 실행 계정 보기",
  description: "워크스페이스의 AI 실행 계정 설정 — 기본 실행 계정(API 키 또는 ○○님 구독) · 앱별·작업별 덮어쓰기 · 기본 모델 · API 키 등록 여부 · 공용 시트(seats — 한 줄씩 켜짐 · 승인 대기 · 동의 대기 · 높은 권한 · 비활성). 구성원 누구나.",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/ai-account"], parse: () => ({}) }] },
  handler: async () => accountSnapshot(),
};

const accountInput = {
  kind: z.enum(["api_key", "subscription", "none"]).describe("api_key = 워크스페이스 API 키 · subscription = 구성원 구독(본인만 · 공용 시트로 켜진 구독은 관리자가 건다) · none = 그 자리의 설정을 지운다"),
  member: z.string().optional().describe("subscription 일 때 그 구성원 id — 본인만 가능(공용 시트로 켜진 구독은 관리자가 어느 자리에든 건다)"),
  app_id: z.string().optional().describe("앱별 설정(없으면 워크스페이스 기본값)"),
  job: z.string().regex(JOB_NAME_RE).optional().describe("작업별 설정(app_id 와 함께)"),
  default_model: z.string().regex(MODEL_RE).optional().describe("단발 실행의 기본 모델(워크스페이스 · 관리자)"),
};

const appAiAccountSet: Capability = {
  name: "app_ai_account_set",
  title: "앱 AI 실행 계정 정하기",
  description: "AI 실행 계정을 정한다 — 워크스페이스 기본값(app_id 없음 · 관리자만) · 앱별(app_id) · 작업별(app_id + job — 관리자 또는 그 앱의 책임자 · 책임자는 제 앱을 워크스페이스 API 키로 돌리게도 할 수 있다 — 앱당 하루 토큰 상한이 울타리). 구독은 **그 사람 본인만** 자기 구독을 건다(관리자도 남의 구독을 못 고른다 — #4423). 예외: 공용 시트로 켜진 구독(app_ai_service_seat_set — 관리자 승인 + 본인 동의)은 관리자가 어느 자리에든 건다. 기본 모델은 관리자. 배포 없이 바로 먹는다.",
  scope: null,
  input: accountInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/ai-account"], parse: (req) => pickBody((req.body ?? {}) as Record<string, unknown>, Object.keys(accountInput)) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (user.appId) throw new HttpError(403, "앱에서는 실행 계정 설정을 바꿀 수 없습니다");
    const admin = isAdmin(user);
    const kind = String(input.kind ?? "");
    let next: AiAccount | null = null;
    if (kind === "api_key") next = { kind: "api_key" };
    else if (kind === "subscription") {
      const m = typeof input.member === "string" && input.member.trim() ? input.member.trim() : user.userId;
      next = { kind: "subscription", member: m };
    } else if (kind !== "none") throw new HttpError(400, "kind 는 api_key · subscription · none 중 하나");
    const appId = typeof input.app_id === "string" && input.app_id.trim() ? input.app_id.trim() : null;
    const job = typeof input.job === "string" && input.job.trim() ? input.job.trim() : null;
    if (job && !appId) throw new HttpError(400, "job 은 app_id 와 함께 줍니다");
    //  자리 검증 — 앱은 실제로 있어야 하고(임의 글자가 설정 JSON 에 쌓이지 않게), 책임자 여부는 그 앱 행으로 판정한다.
    let appOwner = false;
    if (appId) {
      if (!APP_ID_RE.test(appId)) throw new HttpError(400, "app_id 형식이 아닙니다");
      const { getApp } = await import("../org/store/apps.js");
      const { canSeeApp, isAppOwner } = await import("../apps/visibility.js");
      const a = await getApp(appId);
      if (!a || !canSeeApp(a, { userId: user.userId, scopes: user.scopes ?? [] })) throw new HttpError(404, `앱 없음: ${appId}`);
      appOwner = isAppOwner(a, { userId: user.userId, scopes: user.scopes ?? [] });
    }
    const store = await import("../ai-runs/store.js");
    //  #5081 — 남의 구독이면 그 구독이 지금 공용 시트로 켜져 있나(두 동의 · 활성 · 기본 권한뿐). 켜져 있으면 관리자가 건다(plan.accountSetRefusal).
    let nextShared = false;
    if (next?.kind === "subscription" && next.member !== user.userId && serviceSeatConsented(parseAccountSettings(await store.aiAccountRow()), next.member)) {
      nextShared = seatShared({ consented: true, ...(await (await deps()).memberFacts(next.member)) });
    }
    const refusal = accountSetRefusal(next, { member: user.userId, admin }, { appId, appOwner }, nextShared);
    if (refusal) throw new HttpError(403, refusal);
    if (input.default_model !== undefined && !admin) throw new HttpError(403, "기본 모델은 관리자만 바꿀 수 있습니다");
    //  읽고 고쳐 쓰기는 한 트랜잭션 · 행 잠금으로 — 같은 칸의 공용 시트 동의가 그 사이 적혀도 덮어 지우지 않게(store.updateAiAccountRow).
    //   «누구의 구독이 어느 자리에 걸렸나» 는 남의 구독을 공용으로 쓰는 길(#5081)이라 감사에 같은 트랜잭션으로 남긴다. 바뀐 것이 없으면 쓰지도 남기지도 않는다.
    const slot = (x: AiAccountSettings): AiAccount | null => (appId ? (job ? x.apps?.[appId]?.jobs?.[job] : x.apps?.[appId]?.default) : x.default) ?? null;
    const model = typeof input.default_model === "string" && input.default_model.trim() ? input.default_model.trim() : null;
    const { audit } = await import("../org/store/audit.js");
    await store.updateAiAccountRow(async (cur, c) => {
      const before = parseAccountSettings(cur);
      //  남의 구독을 공용 시트로 거는 판정(nextShared)은 잠금 밖에서 했다 — 그 사이 지정이 풀렸으면 걸지 않는다(그 구독은 이제 본인 · 초대받은 사람만).
      if (nextShared && next?.kind === "subscription" && !serviceSeatConsented(before, next.member)) {
        throw new HttpError(409, `${next.member} 계정의 공용 시트 지정이 그 사이 풀렸습니다 — 상태를 다시 확인하세요`);
      }
      const s: AiAccountSettings = parseAccountSettings(cur);
      if (appId) {
        s.apps ??= {};
        const entry = s.apps[appId] ?? {};
        if (job) { entry.jobs ??= {}; if (next) entry.jobs[job] = next; else delete entry.jobs[job]; }
        else if (next) entry.default = next; else delete entry.default;
        if (!entry.default && !Object.keys(entry.jobs ?? {}).length) delete s.apps[appId]; else s.apps[appId] = entry;
      } else if (next) s.default = next; else delete s.default;
      if (model) s.default_model = model;
      if (JSON.stringify(slot(before)) === JSON.stringify(slot(s)) && before.default_model === s.default_model) return { next: null, out: null };
      const view = (x: AiAccountSettings) => ({ app_id: appId, job, account: slot(x), default_model: x.default_model ?? null });
      await audit("org_runtime_config", "1", "app_ai_account", view(before), view(s), user.userId, ctx?.source ?? "web", c);
      return { next: s, out: null };
    });
    return accountSnapshot();
  },
};

// ── 공용 시트(#5081) — org_runtime_config.app_ai_account.service_seats ──
const serviceSeatInput = {
  member: z.string().min(1).max(200).describe("공용 시트로 쓸 구성원 id — 기본 권한(items · context · memory)만 가진 전용 계정이어야 한다. 관리자가 부르면 승인을, 그 계정 본인이 부르면 동의를 적는다"),
  on: z.boolean().describe("true = 켜기(관리자 승인 또는 본인 동의 — 둘 다 있어야 켜진다) · false = 끄기(관리자나 본인 누구든 · 두 동의를 다 지운다 · 지워진 구성원의 줄도)"),
};

const appAiServiceSeatSet: Capability = {
  name: "app_ai_service_seat_set",
  title: "앱 AI 공용 시트 지정",
  description:
    "구성원 한 명의 Claude 구독을 공용 시트로 지정한다 — 켜지면 그 구독은 워크스페이스 구성원 누구의 앱 AI 요청이든 받는다(앱 서버가 사람 신원을 실어 보낸 요청 포함). " +
    "관리자 승인과 그 계정 본인의 동의가 **둘 다** 있어야 켜진다 — 관리자가 부르면 승인을, 본인이 부르면 동의를 적는다(순서 무관 · 이미 적힌 것은 다시 불러도 그대로). 끄기(on:false)는 둘 중 누구든 하며 두 동의를 다 지운다. " +
    "그 계정이 비활성 · 삭제되면 지정도 지워진다(다시 활성화해도 켜지지 않는다 — 승인 · 동의를 새로). " +
    "기본 권한(items · context · memory) 밖의 권한(관리자 · 실행 · DB · 코드)이 있는 계정은 지정할 수 없다(공용 시트 실행은 그 계정의 홈에서 돈다). 공용 시트 실행은 앱 폴더에서만 돌고 작업 AI 의 라이블리 신원은 물은 사람이다. " +
    "어느 앱이 쓰는지는 관리자가 app_ai_account_set 으로 정한다. ⚠ 한 구독으로 여러 사람의 요청을 처리하는 것은 Anthropic 약관상 Team·Enterprise 회색 · Pro·Max 금지 쪽이다 — 전용 팀플랜 시트에만 쓴다. 상태는 app_ai_account 의 seats.",
  scope: null,
  input: serviceSeatInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/ai-service-seats"], parse: (req) => pickBody((req.body ?? {}) as Record<string, unknown>, Object.keys(serviceSeatInput)) }] },
  handler: async (input: Record<string, unknown>, user: LivelyUser, ctx) => {
    if (!user?.userId) throw new HttpError(401, "인증이 필요합니다");
    if (user.appId || user.appServer) throw new HttpError(403, "앱에서는 공용 시트 지정을 바꿀 수 없습니다");
    const d = await deps();
    //  작업 AI 자신의 토큰은 거절 — 승인 · 동의는 사람이 직접 한다(지시 한 줄로 작업이 제 실행 계정을 공용으로 열지 않게).
    if (user.tokenHashPrefix && (await d.isJobToken(user.tokenHashPrefix))) throw new HttpError(403, "작업 안에서는 공용 시트 지정을 바꿀 수 없습니다");
    const member = typeof input.member === "string" ? input.member.trim() : "";
    if (!member) throw new HttpError(400, "member 가 필요합니다");
    if (typeof input.on !== "boolean") throw new HttpError(400, "on 은 true · false 중 하나");
    const { getMember } = await import("../org/store/members.js");
    const m = await getMember(member);
    //  사실은 실행 판정과 같은 출처(memberFacts — 비활성 · 사람 아님이면 elevated 를 안 보지만, 그 경우는 serviceSeatChange 가 먼저 409 로 거절한다).
    const f = m ? await d.memberFacts(member) : { active: false, elevated: false };
    const target: SeatTarget = { member, exists: !!m, active: f.active, human: m?.kind === "human", elevated: f.elevated };
    const actor = { member: user.userId, admin: isAdmin(user) };
    const store = await import("../ai-runs/store.js");
    //  승인 · 동의 · 거두기는 «누가 남의 구독을 공용으로 열었나» 를 가리는 기록이라 감사에 남긴다 — 같은 트랜잭션으로(쓰기만 남고 기록이 빠지지 않게).
    //   바뀐 것이 없으면(없는 줄 끄기) 쓰지도 남기지도 않는다.
    const { audit } = await import("../org/store/audit.js");
    await store.updateAiAccountRow(async (cur, c) => {
      const s: AiAccountSettings = parseAccountSettings(cur);
      const before = s.service_seats?.[member] ?? null;
      const r = serviceSeatChange(before ?? undefined, actor, target, input.on === true, new Date().toISOString());
      if ("refusal" in r) throw new HttpError(r.status, r.refusal);
      if (JSON.stringify(before) === JSON.stringify(r.next)) return { next: null, out: null };
      const seats = { ...(s.service_seats ?? {}) };
      if (r.next) seats[member] = r.next; else delete seats[member];
      if (Object.keys(seats).length) s.service_seats = seats; else delete s.service_seats;
      await audit("org_runtime_config", "1", "app_ai_service_seat", { member, seat: before }, { member, seat: r.next }, user.userId, ctx?.source ?? "web", c);
      return { next: s, out: null };
    });
    return accountSnapshot();
  },
};

// ── 상한 — org_runtime_config.app_ai_policy 한 칸(작업 컨테이너 상한과 같은 꼴) ──
const KEYS = Object.keys(DEFAULT_AI_RUN_POLICY) as Array<keyof AiRunPolicy>;
async function limitsSnapshot(): Promise<Record<string, unknown>> {
  const { aiRunPolicyRow } = await import("../ai-runs/store.js");
  const row = await aiRunPolicyRow();
  return { policy: resolveAiRunPolicy(row), workspace_setting: row, source: aiRunPolicySource(row), defaults: DEFAULT_AI_RUN_POLICY, range: AI_RUN_POLICY_RANGE };
}

const appAiLimits: Capability = {
  name: "app_ai_limits",
  title: "앱 AI 실행 상한 보기",
  description: "앱 AI 실행의 워크스페이스 상한 — max_running_per_member(사람당 동시) · app_per_minute(앱당 분당) · max_inflight(워크스페이스 동시 LLM 호출) · single_timeout_sec · max_output_tokens · daily_tokens_per_app(0=끔) · max_resumes(한 질문당 이어받기 횟수 · 0=이어받기 끔). 고치기는 관리자 app_ai_limits_set. 구성원 누구나.",
  scope: null,
  input: {},
  expose: { mcp: true, rest: [{ method: "GET", paths: ["/api/ui/ai-run-limits"], parse: () => ({}) }] },
  handler: async () => limitsSnapshot(),
};

const limitsSetInput = {
  ...Object.fromEntries(KEYS.map((k) => [k, z.number().int().min(AI_RUN_POLICY_RANGE[k][0]).max(AI_RUN_POLICY_RANGE[k][1]).optional()])),
  reset: z.boolean().optional().describe("true 면 워크스페이스 값을 지워 기본으로"),
} as Record<string, z.ZodTypeAny>;

const appAiLimitsSet: Capability = {
  name: "app_ai_limits_set",
  title: "앱 AI 실행 상한 고치기",
  description: "이 워크스페이스의 앱 AI 실행 상한을 고친다(배포 없이 바로 먹는다). 준 값만 바뀌고 reset:true 면 기본으로. 범위: " +
    KEYS.map((k) => `${k} ${AI_RUN_POLICY_RANGE[k][0]}~${AI_RUN_POLICY_RANGE[k][1]}`).join(" · ") + ". 관리자.",
  scope: "admin",
  input: limitsSetInput,
  expose: { mcp: true, rest: [{ method: "POST", paths: ["/api/ui/ai-run-limits"], parse: (req) => pickBody((req.body ?? {}) as Record<string, unknown>, [...KEYS, "reset"]) }] },
  handler: async (input: Record<string, unknown>) => {
    const { aiRunPolicyRow, writeAiRunPolicyRow } = await import("../ai-runs/store.js");
    const before = await aiRunPolicyRow();
    const next: Record<string, number> = {};
    if (input.reset !== true) {
      for (const k of KEYS) if (typeof before[k] === "number") next[k] = before[k] as number;
      for (const k of KEYS) {
        if (input[k] === undefined) continue;
        const n = Number(input[k]);
        const [lo, hi] = AI_RUN_POLICY_RANGE[k];
        if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${k} 는 ${lo}~${hi} 정수여야 합니다`);
        next[k] = n;
      }
    }
    await writeAiRunPolicyRow(next);
    invalidateAiRunPolicyCache();
    return limitsSnapshot();
  },
};

export const aiRunCapabilities: Capability[] = [appAiRun, appAiRunGet, appAiRuns, appAiRunCancel, appAiTargets, appAiAccount, appAiAccountSet, appAiServiceSeatSet, appAiLimits, appAiLimitsSet];

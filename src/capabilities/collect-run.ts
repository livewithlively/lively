// 수집 실행 표면(#4213 T11) — 내 Claude 로그인으로 claude.ai 커넥터를 읽는 실행을 한 판 띄우고, 그 상태를 본다.
//
//  · 늘 **부르는 사람 자신**의 실행이다 — 그 사람 홈의 로그인 · 그 사람 구독 · 그 사람 홈의 실행 폴더.
//    남을 대신해 띄우는 길(담당자 배정)은 수집 단위 표(T10)와 함께 서버 안쪽에서 연다. 여기는 그 실행기의 바깥 손잡이다.
//  · 이번 판은 **실행기와 실측**까지다 — 원문은 그 사람 홈에만 남고, 응답에는 목록(도구·크기·해시)만 싣는다.
//  · 지시를 직접 줄 수 있지만 도구는 늘 «허락한 claude.ai 커넥터의 읽기 도구» 뿐이다(문지기 훅 — collect-run-script.ts).
import { UNITS_PER_RUN } from "../org/collect/collect-plan.js";
import { z } from "zod";
import type { Capability } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { readCollectRun, startCollectRun } from "../terminal/collect-run.js";
import { collectRunStats } from "../org/collect/run-log.js";
import { waitForCollectRun } from "../org/collect/run-wait.js";
import { getCollectSessionPolicyView, setCollectSessionPolicy } from "../org/store/runtime-config.js";
import {
  DEFAULT_COLLECT_SESSION_POLICY, COLLECT_MEM_MAX_MB_MIN, COLLECT_MEM_REQUEST_MB_MIN, COLLECT_MEM_MB_MAX,
  normalizeCollectSessionPolicy, type CollectSessionPolicyPatch,
} from "../sessions/session-memory-policy.js";

const startInput = {
  mode: z.enum(["probe", "listing", "collect"]).optional().describe(
    "실행 종류 — probe(기본, 점검: 앱마다 읽기 도구를 작게 한 번) · listing(그 사람 커넥터로 볼 수 있는 대화·페이지·메일함 목록을 훑어 " +
    "수집 단위 표에 «볼 수 있는 구성원» 으로 올린다 — 새 단위는 후보) · collect(그 사람이 지금 담당인 수집 중 단위를 읽어 자료로 넣고 읽은 위치를 옮긴다). " +
    "listing·collect 는 지시를 서버가 만들고, 끝나면 원문을 서버가 풀어 저장한다(collect_claude_run_get 의 ingest)"),
  app: z.string().max(32).optional().describe("listing 의 앱(slack · gmail · notion — 필수) · collect 에서 주면 그 앱 단위만"),
  due_only: z.boolean().optional().describe(`collect — 주기가 된 단위만(기본 false: 맡은 단위 전부, 오래 안 읽은 것부터 한 판에 최대 ${UNITS_PER_RUN}개)`),
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
    "mode listing(app 필수)은 볼 수 있는 대화·페이지·메일함 목록을 수집 단위 표에 올리고, mode collect 는 지금 담당인 단위를 읽어 자료로 넣는다. " +
    "이미 자료가 모인 비공개 단위(공개범위가 «모두» 가 아닌 단위 · 메일함 제외)는 목록만으로 열리지 않고 «확인 대기» 로 남는다 — 다음 mode collect " +
    "판이 작은 확인 읽기(가장 새로 저장된 글과 같은 글을 내 커넥터로 읽어 오는지)로 확인한다. 맡은 단위가 없어도 확인할 것이 있으면 판을 띄운다. " +
    "REST 등가: POST /api/ui/collect/claude-runs {mode?, app?, due_only?, apps?, prompt?, model?, max_turns?, timeout_sec?}.",
  scope: "memory",
  input: startInput,
  mutates: true,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/collect/claude-runs"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (b.apps != null && !Array.isArray(b.apps)) throw new HttpError(400, "apps 는 앱 이름 배열이어야 합니다");
        if (b.mode != null && !["probe", "listing", "collect"].includes(String(b.mode))) throw new HttpError(400, "mode 는 probe · listing · collect 가운데 하나입니다");
        return {
          mode: b.mode == null || b.mode === "" ? undefined : String(b.mode) as "probe" | "listing" | "collect",
          app: b.app == null || b.app === "" ? undefined : String(b.app).slice(0, 32),
          due_only: b.due_only == null ? undefined : b.due_only === true || b.due_only === "true",
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
      mode: input.mode, app: input.app, dueOnly: input.due_only,
      apps: input.apps, prompt: input.prompt, model: input.model, maxTurns: input.max_turns, timeoutSec: input.timeout_sec,
    });
    return { ok: true, run_id: r.runId, session_id: r.sessionId, mode: r.mode, model: r.model, apps: r.apps, timeout_sec: r.timeoutSec, ...(r.units != null ? { units: r.units } : {}) };
  },
};

/** 끝나기를 기다려 주는 상한(초) — MCP 호출은 하네스에서 인라인으로 막혀 있어 길게 잡으면 전송이 끊겨 답을 잃는다(delegate_run 의 교훈). */
export const COLLECT_RUN_WAIT_MAX_SEC = 25;
/** 기다리는 동안 상태를 다시 읽는 간격(ms) — 읽기 한 번이 그 사람 자리에서 셸 한 번이다. */
const COLLECT_RUN_WAIT_POLL_MS = 3000;

const getInput = {
  run_id: z.string().max(64).describe("collect_claude_run 이 돌려준 run_id"),
  wait_sec: z.number().int().min(0).max(COLLECT_RUN_WAIT_MAX_SEC).optional().describe(
    `실행이 끝나기를 이만큼 기다렸다 답한다(0~${COLLECT_RUN_WAIT_MAX_SEC}초, 기본 0 = 바로). 목록·수집 실행은 저장 단계(ingest)까지 끝나야 «끝» 이다. ` +
    "끝나면 그 자리에서 답한다. 리브처럼 끝나기를 기다리는 쪽이 같은 호출을 빠르게 되풀이하지 않게 쓴다 — " +
    "아직 안 끝났으면(state 가 running 이거나 ingest.state 가 done·failed 가 아니면) 다시 부른다"),
};
type GetInput = z.infer<z.ZodObject<typeof getInput>>;

const collectRunGet: Capability = {
  name: "collect_claude_run_get",
  title: "수집 실행 상태",
  description:
    "내 수집 실행 하나의 상태 — running/done · 끝난 사유(exit) · 요약(claude 버전·뜬 커넥터·허락한 앱·없는 앱·도구 호출·토큰·메모리) · " +
    "훅이 받은 원문 목록(도구·글자 수·sha256 — 원문 자체는 싣지 않는다) · 목록·수집 실행이면 저장 단계 결과(ingest — 올린 단위·넣은 자료·옮긴 위치). 남의 실행은 볼 수 없다. " +
    `wait_sec(최대 ${COLLECT_RUN_WAIT_MAX_SEC}초)를 주면 끝나기(목록·수집 실행은 저장 단계까지)를 그만큼 기다렸다 답한다. ` +
    "REST 등가: GET /api/ui/collect/claude-runs/:id?wait_sec=.",
  scope: "memory",
  input: getInput,
  mutates: false,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/collect/claude-runs/:id"],
      parse: (req) => {
        const q = (req.query ?? {}) as Record<string, unknown>;
        const w = optInt(q.wait_sec);
        if (w != null && (w < 0 || w > COLLECT_RUN_WAIT_MAX_SEC)) throw new HttpError(400, `wait_sec 는 0~${COLLECT_RUN_WAIT_MAX_SEC} 입니다`);
        return { run_id: String(req.params?.id ?? ""), ...(w != null ? { wait_sec: w } : {}) };
      } }],
  },
  handler: async (input: GetInput, user: LivelyUser) => {
    const id = String(input.run_id || "").trim();
    //  #4213 T13 — 리브(처음 연결 대화)가 목록·수집 실행을 기다린다. 같은 호출을 쉬지 않고 되풀이하면 대화창에 도구 줄이 수십 개 쌓이고
    //   그 사람 자리에서 셸이 그만큼 돈다 — 서버가 짧게 기다려 준다. 읽기가 곧 저장 단계를 굴리는 자리라(readCollectRun) 간격마다 다시 읽는다.
    //   «끝» 은 저장 단계까지다(목록·수집 실행 — org/collect/run-wait.ts): 실행만 끝난 값을 주면 리브가 저장 전의 단위 수로 첫 보고를 한다.
    return waitForCollectRun(() => readCollectRun(user, id), input.wait_sec,
      { pollMs: COLLECT_RUN_WAIT_POLL_MS, maxSec: COLLECT_RUN_WAIT_MAX_SEC });
  },
};

/** 날짜 묶기의 시간대 — 보는 사람의 IANA 이름(예 Asia/Seoul). 모르는 값이면 UTC(auto-runs 와 같은 규칙). */
function tzOf(v: unknown): string {
  const t = String(v || "").trim();
  if (!t || t.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(t)) return "UTC";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: t }); return t; } catch { return "UTC"; }
}

const statsInput = {
  days: z.number().int().min(1).max(31).optional().describe("최근 며칠(기본 7, 최대 31)"),
  tz: z.string().max(64).optional().describe("날짜 묶기 시간대(IANA, 예 Asia/Seoul). 기본 UTC"),
  recent: z.number().int().min(0).max(200).optional().describe("최근 실행 목록 길이(기본 50)"),
};
type StatsInput = z.infer<z.ZodObject<typeof statsInput>>;

const collectRunStatsCap: Capability = {
  name: "collect_claude_run_stats",
  title: "수집 실행 지표(실패율·메모리)",
  description:
    "Claude 커넥터 수집 실행(collect_claude_run)의 지표 — 기간 안 실행 수 · 실패율 · 실패 사유별 건수 · 최고 메모리(중앙값·상위 25%·상위 5%·최대) · " +
    "상한의 90% 를 넘은 실행 · 메모리 탓일 수 있는 실패(강제 종료·끝 신호 없이 사라짐) · 걸린 시간 · 비용 · 날짜별 추이 · 최근 실행 목록, " +
    "그리고 지금 수집 세션 크기(상한·예약)와 그 출처 · 표본 10회 이상이면 크기 추천. 크기는 collect_session_policy_set 으로 바꾼다. " +
    "원문·결과 문장은 싣지 않는다. 관리자만. REST 등가: GET /api/ui/collect/claude-run-stats?days=&tz=&recent=.",
  scope: "admin",
  input: statsInput,
  mutates: false,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/collect/claude-run-stats"],
      parse: (req) => {
        const q = (req.query ?? {}) as Record<string, unknown>;
        const days = optInt(q.days), recent = optInt(q.recent);
        if (days != null && (days < 1 || days > 31)) throw new HttpError(400, "days 는 1~31 이어야 합니다");
        if (recent != null && (recent < 0 || recent > 200)) throw new HttpError(400, "recent 는 0~200 이어야 합니다");
        return { days, recent, tz: q.tz == null ? undefined : String(q.tz).slice(0, 64) };
      } }],
  },
  handler: async (input: StatsInput, _user: LivelyUser) => {
    const days = input.days ?? 7;
    const tz = tzOf(input.tz);
    const until = new Date();
    const since = new Date(until.getTime() - days * 86400_000);
    const [{ stats, recent, truncated }, policy] = await Promise.all([
      collectRunStats({ since, until, tz, recent: input.recent ?? 50 }),
      getCollectSessionPolicyView(),
    ]);
    return {
      window: { since: since.toISOString(), until: until.toISOString(), days, tz },
      policy: { ...policy, defaults: DEFAULT_COLLECT_SESSION_POLICY, bounds: POLICY_BOUNDS },
      stats, recent, truncated,
    };
  },
};

const POLICY_BOUNDS = { max_mb_min: COLLECT_MEM_MAX_MB_MIN, request_mb_min: COLLECT_MEM_REQUEST_MB_MIN, max: COLLECT_MEM_MB_MAX };

const policyInput = {
  max_mb: z.number().int().min(COLLECT_MEM_MAX_MB_MIN).max(COLLECT_MEM_MB_MAX).optional().describe("수집 세션 상한(MB) — 넘으면 그 실행이 메모리 초과로 끝난다. 기본 1024"),
  request_mb: z.number().int().min(COLLECT_MEM_REQUEST_MB_MIN).max(COLLECT_MEM_MB_MAX).optional().describe("수집 세션 배치 예약치(MB) — 노드에 앉힐 때 차지하는 것으로 치는 양. 상한 이하. 기본 640"),
  reset: z.boolean().optional().describe("true 면 저장값을 비워 기본값으로 되돌린다(max_mb·request_mb 와 함께 주지 않는다)"),
};
type PolicyInput = z.infer<z.ZodObject<typeof policyInput>>;

/** 크기 칸 하나 — 정수(MB)여야 하고 범위 안이어야 한다. 조용히 접지 않는다(«저장됐는데 다른 값으로 뜬다» 가 가장 나쁘다). */
function policyMb(v: unknown, field: string, min: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : (typeof v === "string" ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < min || n > COLLECT_MEM_MB_MAX) throw new HttpError(400, `${field} 는 ${min}~${COLLECT_MEM_MB_MAX} 정수(MB)여야 합니다`);
  return n;
}

const collectSessionPolicySet: Capability = {
  name: "collect_session_policy_set",
  title: "수집 세션 크기 저장",
  description:
    "Claude 커넥터 수집 실행(collect_claude_run)이 띄우는 작은 세션의 상한·예약(MB)을 저장한다(#4213 T11). 다음 수집 실행부터 쓴다. " +
    "범위: 상한 256~8192 · 예약 128~8192 · 예약 ≤ 상한(어기면 400). 한 칸만 주면 다른 칸은 지금 값을 둔다. reset:true 는 저장값을 비워 기본값(1024/640, " +
    ".env 시드가 있으면 그 값)으로 되돌린다. 일반 세션 메모리 정책과 따로다. 판단 근거는 collect_claude_run_stats(실패율·최고 메모리·추천). 관리자만. " +
    "REST 등가: POST /api/ui/collect/session-policy {max_mb?, request_mb?, reset?}.",
  scope: "admin",
  input: policyInput,
  mutates: true,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/collect/session-policy"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        if (b.reset != null && typeof b.reset !== "boolean") throw new HttpError(400, "reset 은 true/false 여야 합니다");
        return { max_mb: b.max_mb as number | undefined, request_mb: b.request_mb as number | undefined, reset: b.reset as boolean | undefined };
      } }],
  },
  handler: async (input: PolicyInput, user: LivelyUser, ctx?: { source?: string }) => {
    const actor = String(user.userId || user.email || "") || undefined;
    if (input.reset === true) {
      if (input.max_mb != null || input.request_mb != null) throw new HttpError(400, "reset 과 크기 값을 함께 줄 수 없습니다");
      await setCollectSessionPolicy(null, { actor, source: ctx?.source ?? "web" });
      return { ok: true, policy: await getCollectSessionPolicyView() };
    }
    const patch: CollectSessionPolicyPatch = {};
    const maxMb = policyMb(input.max_mb, "max_mb", COLLECT_MEM_MAX_MB_MIN);
    const reqMb = policyMb(input.request_mb, "request_mb", COLLECT_MEM_REQUEST_MB_MIN);
    if (maxMb !== undefined) patch.max_mb = maxMb;
    if (reqMb !== undefined) patch.request_mb = reqMb;
    if (!Object.keys(patch).length) throw new HttpError(400, "max_mb · request_mb 중 하나는 주거나 reset:true 를 주세요");
    //  예약 > 상한 은 사람이 뜻한 값일 리 없다 — 정규화가 조용히 내리기 전에 알린다(세션 메모리 정책과 같은 단방향 검사:
    //   상한만 기존 예약 밑으로 내리면 예약이 같이 내려가는 것은 안전한 쪽이라 그대로 둔다).
    const cur = await getCollectSessionPolicyView();
    const merged = normalizeCollectSessionPolicy({ max_mb: cur.max_mb, request_mb: cur.request_mb, ...patch });
    if (patch.request_mb !== undefined && patch.request_mb > merged.max_mb) {
      throw new HttpError(400, `예약(${patch.request_mb}MB)은 상한(${merged.max_mb}MB) 이하여야 합니다`);
    }
    await setCollectSessionPolicy(patch, { actor, source: ctx?.source ?? "web" });
    return { ok: true, policy: await getCollectSessionPolicyView() };
  },
};

export const collectRunCapabilities: Capability[] = [collectRunStart, collectRunGet, collectRunStatsCap, collectSessionPolicySet];

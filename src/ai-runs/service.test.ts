// 앱 AI 실행 — 흐름 엣지 표 S1~S24(#4488 앱 v2-9 · 사양 spec.md). 가짜 저장소 · 가짜 LLM · 가짜 작업 컨테이너로. 실행: npm run build && node dist/ai-runs/service.test.js
//  이게 틀리면: 구독이 남의 요청으로 돌거나(#4423), 상한이 안 먹어 키의 돈이 새거나, 형식 어긋남을 두 번 넘게 다시 묻거나, 관리자에게 남의 답이 보인다.
import assert from "node:assert/strict";
import { HttpError } from "../http-error.js";
import type { LivelyUser } from "../context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { AgentJobRow } from "../agent-jobs/store.js";
import { RateWindow } from "../apps/app-chat-send.js";
import { DEFAULT_AI_RUN_POLICY, type AiRunPolicy } from "../org/policies/ai-run-policy.js";
import type { AiRunRow, AiRunSummaryRow, NewAiRun, NewLlmCall } from "./store.js";
import type { SingleShotInput, SingleShotOutput } from "./anthropic.js";
import type { AiAccountSettings, ResumeLink } from "./plan.js";
import type { Viewer } from "../apps/visibility.js";
import { CONFIG_DIR_PLACEHOLDER, PROXY_BASE_IN_CONTAINER, agentJobOfRun, bootEnvForJob, cancelRunFor, composeSystem, getRunFor, listRunsFor, submitRun, syncRun, targetsFor, type AiRunDeps, type SubmitJobInput } from "./service.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await tick(); };

interface World {
  sessions: Record<string, { owner: string; members: string[]; human?: boolean }>;
  runs: Map<number, AiRunRow>; calls: NewLlmCall[]; jobs: Map<number, AgentJobRow>; submitted: SubmitJobInput[]; llm: SingleShotInput[]; canceled: number[];
  settings: AiAccountSettings; key: string | null; policy: AiRunPolicy; llmReply: (i: SingleShotInput, n: number) => SingleShotOutput; submitThrows?: HttpError;
  usedToday: number; inflightCount: number;
  /**
   * #5081 구성원 표(가짜) — 없는 이름은 활성 · 기본 권한뿐(앱 서버 id 는 늘 아님). 작업마다 · 실행마다 공용 시트 표시.
   *  실행 표시는 행 모양(COLS)에 없고 따로 읽는다(store.RUN_SHARED_SEAT_COL) — 가짜도 행 밖 지도로 둔다.
   */
  members: Record<string, { active: boolean; elevated: boolean }>; jobShared: Map<number, boolean>; runShared: Map<number, boolean>;
  /**
   * #5101 이어받기 줄(가짜) — 실행 행 밖 지도(store.RUN_RESUME_COLS 도 COLS 밖이다). jobTranscripts = 게이트웨이가 대화 기록을 보관한 작업 id
   *  (API 키 작업의 이어받기 판정 · live.resumeTargetOf 와 같은 뜻). resumeCols42703 = 롤 창(칸이 아직 없다).
   */
  resumeLinks: Map<number, ResumeLink>; jobTranscripts: Set<number>; resumeCols42703?: boolean;
}
const member = (id: string, extra: Partial<LivelyUser> = {}): LivelyUser => ({ userId: id, email: `${id}@x`, scopes: ["context"], projects: ["*"], ...extra });
const appUser = (id: string, app: string): LivelyUser => member(id, { appId: app });
const admin = (id: string): LivelyUser => member(id, { scopes: ["admin"] });
const app = (id: string, manifest: Record<string, unknown> = {}): OrgApp => ({ id, title: id, manifest, status: "active", enabled: true } as unknown as OrgApp);
const okText = (text: string): SingleShotOutput => ({ ok: true, status: 200, text, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }, model: "m", stopReason: "end_turn", error: null });

function world(o: Partial<World> = {}): { w: World; d: AiRunDeps } {
  let seq = 0, jseq = 100;
  const w: World = {
    runs: new Map(), calls: [], jobs: new Map(), submitted: [], llm: [], canceled: [], settings: {}, sessions: {}, key: "sk-ws", policy: { ...DEFAULT_AI_RUN_POLICY },
    llmReply: () => okText("답"), usedToday: 0, inflightCount: 0, members: {}, jobShared: new Map(), runShared: new Map(),
    resumeLinks: new Map(), jobTranscripts: new Set(), ...o,
  };
  const ended = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";
  const countedResumes = (root: number): number => [...w.resumeLinks.entries()].filter(([id, l]) => {
    const r = w.runs.get(id);
    return l.root === root && !(r && r.executor === "job" && r.job_id == null && r.status === "failed");
  }).length;
  const d: AiRunDeps = {
    store: {
      async insertAiRun(n: NewAiRun) {
        if (n.resume && w.resumeCols42703) throw Object.assign(new Error('column "resume_of" of relation "org_app_ai_run" does not exist'), { code: "42703" });
        const id = ++seq;
        if (n.resume) w.resumeLinks.set(id, { ...n.resume });
        const row: AiRunRow = { id, status: n.status, app_id: n.appId, requester: n.requester, requester_kind: n.requesterKind, source: n.source, job_name: n.jobName, kind: n.kind,
          account_kind: n.accountKind, account_member: n.accountMember, executor: n.executor, job_id: null, model: n.model, label: n.label, prompt: n.prompt, system_prompt: n.systemPrompt,
          schema: n.schema, result: null, error: null, session_note: null, proxy_token_hash: null, retries: 0, input_tokens: null, output_tokens: null,
          created_at: new Date(), started_at: n.status === "running" ? new Date() : null, ended_at: null, updated_at: new Date() };
        w.runs.set(id, row); w.runShared.set(id, n.sharedSeat === true); return { ...row };
      },
      async aiRunSharedSeat(id) { return w.runShared.get(id) === true; },
      async aiRunResumeLink(id) { const l = w.resumeLinks.get(id); return l ? { ...l } : null; },
      //  SQL(store.RESUME_COUNTED)과 같은 뜻 — 그 질문의 이어받기 중 띄우지도 못한 시도(작업 실행 · 작업 행 없음 · 실패)는 빼고 센다(실 Postgres 는 store.pg-test T18).
      async resumeCountOfRoot(root) { return countedResumes(root); },
      async insertResumedAiRun(n, max) {
        const counted = countedResumes(n.resume.root);
        if (counted >= max) return { limit: counted };
        return { row: await d.store.insertAiRun(n) };
      },
      async getAiRun(id) { const r = w.runs.get(id); return r ? { ...r } : null; },
      async getAiRunByToken(h) { const r = [...w.runs.values()].find((x) => x.proxy_token_hash === h && !ended(x.status)); return r ? { ...r } : null; },
      async getAiRunByJob(j) { const r = [...w.runs.values()].find((x) => x.job_id === j); return r ? { ...r } : null; },
      async setAiRunJob(id, jobId) { w.runs.get(id)!.job_id = jobId; },
      async setAiRunProxyToken(id, h) { w.runs.get(id)!.proxy_token_hash = h; },
      async markAiRunRunning(id) { const r = w.runs.get(id)!; if (r.status === "queued") { r.status = "running"; r.started_at = new Date(); } },
      async retryAiRun(id, jobId) { const r = w.runs.get(id)!; if (ended(r.status)) return false; r.job_id = jobId; r.retries++; return true; },
      async finishAiRun(id, f) { const r = w.runs.get(id)!; if (ended(r.status)) return null; Object.assign(r, { status: f.status, result: f.result, error: f.error, ended_at: new Date(), input_tokens: f.inputTokens ?? r.input_tokens, output_tokens: f.outputTokens ?? r.output_tokens, retries: f.retries ?? r.retries }); return { ...r }; },
      async openJobRuns() { return [...w.runs.values()].filter((r) => !ended(r.status) && r.executor === "job"); },
      async staleProxyRuns() { return []; },
      async openRunCountOf(req) { return [...w.runs.values()].filter((r) => r.requester === req && !ended(r.status)).length; },
      //  SQL(store.listAiRuns)과 같은 뜻 — 내 실행 = 보낸 것 + 공용 시트가 아닌 내 구독으로 도는 것(#5081 · 실 Postgres 는 store.pg-test T13).
      async listAiRuns(f) {
        const shared = (r: AiRunRow): boolean => w.runShared.get(r.id) === true;
        return [...w.runs.values()].filter((r) => (!f.appId || r.app_id === f.appId) && (!f.requester || r.requester === f.requester || (r.account_kind === "subscription" && r.account_member === f.requester && !shared(r))))
          .map((r) => ({ ...r, prompt_preview: r.prompt.slice(0, 20), has_result: r.result !== null, shared_seat: shared(r) } as unknown as AiRunSummaryRow));
      },
      async appConversations() { return []; },
      async insertLlmCall(c) { w.calls.push(c); },
      async tokensUsedTodayByApp() { return w.usedToday; },
    },
    policy: async () => w.policy,
    accountSettings: async () => w.settings,
    apiKey: async () => w.key,
    getApp: async (id) => app(id, { ai: { jobs: [{ name: "summarize" }] } }),
    assertAppUsable: async () => undefined,
    submitJob: async (j) => { if (w.submitThrows) throw w.submitThrows; w.submitted.push(j); const id = ++jseq; w.jobs.set(id, { id, status: "queued", model: j.model, project_id: j.projectId, timeout_sec: 600, conversation_id: null, result: null, error: null, homeless: j.homeless === true, account_kind: j.accountKind, resume_job_id: j.resumeJobId } as unknown as AgentJobRow); w.jobShared.set(id, j.sharedSeat === true); return { id }; },
    getJob: async (id) => w.jobs.get(id) ?? null,
    //  live.resumeTargetOf 와 같은 뜻 — 대화 id 가 있어야 · API 키 작업이면 게이트웨이가 보관한 기록까지.
    resumeTarget: async (id) => {
      const j = w.jobs.get(id);
      if (!j) return null;
      const base = { projectId: j.project_id, model: j.model, conversation: j.conversation_id };
      if (!j.conversation_id) return { ...base, resumable: false, why: "대화 없음" };
      if ((j as { account_kind?: string }).account_kind === "api_key" && !w.jobTranscripts.has(id)) return { ...base, resumable: false, why: "API 키 작업의 대화 기록이 없습니다" };
      return { ...base, resumable: true, why: null };
    },
    cancelJob: async (id) => { w.canceled.push(id); },
    singleShot: async (_k, i) => { w.llm.push(i); return w.llmReply(i, w.llm.length); },
    newProxyToken: () => ({ token: "lvai_tok", hash: "hash-of-tok" }),
    inflight: { take: (_k, max) => { if (w.inflightCount >= max) return false; w.inflightCount++; return true; }, release: () => { w.inflightCount--; }, count: () => w.inflightCount },
    rate: new RateWindow(w.policy.app_per_minute),
    tenant: () => "t",
    later: (fn) => { void fn().catch(() => undefined); },
    now: () => Date.now(),
    attachedSessions: async () => [],
    subscriptionLoggedIn: async () => true,
    //  세션 tie(가짜): w.sessions[sid] = { owner, members(들어갈 수 있는 사람) } · 모르는 세션은 owner null.
    sessionTie: async (sid, member) => { const s = w.sessions[sid]; return s ? { owner: s.owner, participant: s.owner === member || s.members.includes(member), human: s.human !== false } : { owner: null, participant: false, human: false }; },
    isAdmin: (u) => (u.scopes ?? []).includes("admin"),
    isJobToken: async (prefix) => prefix === "jobtok",
    memberFacts: async (m) => (m.startsWith("app-server:") ? { active: false, elevated: false } : w.members[m] ?? { active: true, elevated: false }),
    //  «MCP 만» 값(필수 의존성) — 기본은 종전 작업. 필요한 시험이 덮어 쓴다(withMcpOnly · withJobMcpOnly).
    mcpOnly: async () => false,
    jobMcpOnly: async () => false,
  };
  return { w, d };
}
const fails = async (p: Promise<unknown>, status: number, re?: RegExp, code?: string): Promise<void> => {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  assert.ok(err instanceof HttpError, `HttpError 를 기대 — ${String(err)}`);
  assert.equal(err.status, status, err.message);
  if (re) assert.match(err.message, re);
  if (code) assert.equal((err.body as { code?: string })?.code, code);
};
const schema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };

// ── S1 단발 + API 키 · 스키마 없음 → 프록시 · 계측 1건 · done ──
{
  const { w, d } = world();
  const r = await submitRun({ prompt: "요약해" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(r.executor, "proxy"); assert.deepEqual(r.account, { kind: "api_key" }); assert.equal(r.kind, "single");
  await settle();
  const row = w.runs.get(1)!;
  assert.equal(row.status, "done"); assert.equal((row.result as { text: string }).text, "답");
  assert.equal(w.calls.length, 1); assert.equal(w.calls[0]!.caller, "run"); assert.equal(w.calls[0]!.runId, 1); assert.equal(w.calls[0]!.inputTokens, 10);
  assert.equal(w.llm[0]!.model, "claude-opus-5-5", "기본 모델"); assert.equal(w.llm[0]!.maxTokens, DEFAULT_AI_RUN_POLICY.max_output_tokens);
  assert.ok(!w.llm[0]!.prompt.includes("JSON Schema"), "스키마 없으면 형식 지시 없음");
  assert.equal(w.submitted.length, 0, "작업 컨테이너 안 씀");
  assert.equal(w.inflightCount, 0, "동시 셈을 되돌린다");
  ok("S1 단발 + API 키 → 프록시 · 계측 · done · 컨테이너 0");
}

// ── S1b 워크스페이스에 묶이지 않은 키 — 자격의 워크스페이스 id 가 단발 호출에 실린다(없으면 null) ──
{
  const { w, d } = world();
  await submitRun({ prompt: "요약해" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  assert.equal(w.llm[0]!.workspaceId ?? null, null, "자격에 id 없음 → null");
  (d as unknown as { apiWorkspaceId: () => Promise<string | null> }).apiWorkspaceId = async () => "wrkspc_ours";
  await submitRun({ prompt: "요약해", schema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  assert.ok(w.llm.length >= 2);
  for (const i of w.llm.slice(1)) assert.equal(i.workspaceId, "wrkspc_ours", "첫 호출 · 형식 재시도 호출 모두 자격의 워크스페이스 id");
  ok("S1b anthropic-workspace-id — 단발 · 재시도 호출에 자격의 id");
}

// ── S2~S3 스키마 — 첫 답 어긋남 → «형식에 맞게 다시» 1회 → 맞으면 done · 또 어긋나면 원문 붙여 실패(정확히 2번) ──
{
  const { w, d } = world({ llmReply: (_i, n) => okText(n === 1 ? "그냥 글" : '{"n": 3}') });
  await submitRun({ prompt: "세어", schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  const row = w.runs.get(1)!;
  assert.equal(row.status, "done"); assert.deepEqual((row.result as { json: unknown }).json, { n: 3 }); assert.equal((row.result as { retries: number }).retries, 1);
  assert.equal(w.llm.length, 2); assert.ok(w.llm[0]!.prompt.includes("JSON Schema"), "형식 지시가 붙는다");
  assert.equal(w.llm[1]!.messages!.length, 3, "재요청은 앞 답을 들려주고 다시 묻는다"); assert.match(w.llm[1]!.messages![2]!.content, /형식에 맞지 않았습니다/);
  assert.equal(w.calls.length, 2);
  ok("S2 스키마 어긋남 → 다시 1회 → done(result.json · retries 1)");

  const bad = world({ llmReply: () => okText("계속 글") });
  await submitRun({ prompt: "세어", schema }, appUser("alice", "crm"), { source: "app-ui" }, bad.d);
  await settle();
  const b = bad.w.runs.get(1)!;
  assert.equal(b.status, "failed"); assert.match(b.error!, /형식에 맞지 않습니다/); assert.equal((b.result as { text: string }).text, "계속 글");
  assert.equal(b.retries, 1, "행의 retries 도 1(끝단 시험 E7 에서 잡힌 것 — result 안에만 적혀 있었다)");
  assert.equal(bad.w.llm.length, 2, "정확히 두 번 — 세 번째는 없다");
  ok("S3 두 번 다 어긋나면 원문 붙여 실패 · LLM 정확히 2번");
}

// ── S4 LLM 오류 → failed · 상태 있음 ──
{
  const { w, d } = world({ llmReply: () => ({ ok: false, status: 401, text: "", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, model: null, stopReason: null, error: "authentication_error: bad key" }) });
  await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  assert.equal(w.runs.get(1)!.status, "failed"); assert.match(w.runs.get(1)!.error!, /authentication_error/); assert.equal(w.calls[0]!.status, 401);
  ok("S4 LLM 오류 → failed · 계측에 상태");
}

// ── S5~S7 실행 계정 거절 — 남의 구독 403 · 계정 없음 409 · 행 안 남음 / 앱 서버 에이전트 작업은 홈 없는 작업 컨테이너(#4891) ──
{
  const sub = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await fails(submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui" }, sub.d), 403, /초대받은 사람/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui", session: "box-alice" }, sub.d), 403, /사람이 보는 세션/, "account_unavailable"); // 아직 모르는 세션 — 막는다
  assert.equal(sub.w.runs.size, 0, "거절은 행을 안 남긴다");
  //  본인은 어느 길이든(상민 2026-10-19) — 세션의 AI(mcp) · 제 토큰(web)도 본인이다. 구독 단발은 작업 컨테이너(bare).
  sub.w.sessions["box-alice"] = { owner: "alice", members: ["bob"] };   // 사람 세션 · alice 주인 · bob 초대
  const viaMcp = await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp", session: "box-alice" }, sub.d);
  assert.equal(viaMcp.executor, "job"); assert.deepEqual(viaMcp.account, { kind: "subscription", member: "alice" });
  const viaWeb = await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "web" }, sub.d);
  assert.equal(viaWeb.executor, "job");
  //  초대받은 사람 — alice 세션(box-alice)에 bob 이 들어갈 수 있으면, 그 세션에 매인 bob 의 요청은 alice 구독으로 돈다(기록: 보낸 사람 bob · 계정 alice · 자리 alice).
  const invited = await submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui", session: "box-alice" }, sub.d);
  assert.equal(invited.requester, "bob"); assert.deepEqual(invited.account, { kind: "subscription", member: "alice" }); assert.equal(invited.executor, "job");
  assert.equal(sub.w.submitted.at(-1)!.accountMember, "alice", "작업은 구독 주인 alice 의 자리·구독으로");
  assert.equal(sub.w.submitted.at(-1)!.requester, "bob");
  await fails(submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui" }, sub.d), 403, /초대받은 사람/, "account_unavailable"); // 같은 bob 이라도 세션에 매이지 않은 요청은 거절
  sub.w.sessions["box-carol"] = { owner: "carol", members: ["bob"] };
  await fails(submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui", session: "box-carol" }, sub.d), 403, /초대받은 사람/, "account_unavailable"); // 남의(carol) 세션은 alice 구독과 무관
  await fails(submitRun({ prompt: "x" }, appUser("dave", "crm"), { source: "app-ui", session: "box-alice" }, sub.d), 403, /초대받은 사람/, "account_unavailable"); // alice 세션이라도 들어갈 수 없는 dave 는 거절
  //  사람 세션이 아닌 곳(위탁·크론 헤드리스 · 상시 세션)에 매인 요청은 본인 토큰이라도 거절 — 격리 리뷰 blocking 1. 모르는 세션(조회 실패)도 거절.
  sub.w.sessions["box-task"] = { owner: "alice", members: [], human: false };
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp", session: "box-task" }, sub.d), 403, /사람이 보는 세션/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp", session: "box-unknown" }, sub.d), 403, /사람이 보는 세션/, "account_unavailable");
  //  구독 주인 alice 는 초대받은 bob 이 보내 제 구독으로 도는 실행을 보고(지시 포함) · 목록에서 보고 · 취소할 수 있다 — 격리 리뷰 non-blocking 3.
  const seenByOwner = await getRunFor(Number(invited.id), member("alice"), sub.d);
  assert.equal(seenByOwner.requester, "bob"); assert.equal(seenByOwner.prompt, "x", "구독 주인에게는 지시도 보인다(제 자리에서 돈 것)");
  const ownerList = await listRunsFor({ app_id: "crm" }, member("alice"), sub.d);
  assert.ok((ownerList.runs as Array<{ id: number }>).some((r) => r.id === invited.id), "목록에도(가짜 저장소는 requester 만 걸러 — SQL 조건은 store.pg-test T8)");
  const cancelledByOwner = await cancelRunFor(Number(invited.id), member("alice"), sub.d);
  assert.ok(sub.w.canceled.includes(Number(invited.job_id)), "구독 주인의 취소가 작업 취소로 간다");
  assert.equal(cancelledByOwner.id, invited.id);
  await fails(getRunFor(Number(invited.id), member("carol"), sub.d), 404, undefined, undefined); // 제3자는 404
  //  targets 도 같은 판정 — bob 이 alice 세션에 매여 물으면 쓸 수 있음, 매임 없이 물으면 못 씀(이유에 초대 문구)
  const tgTied = await targetsFor(appUser("bob", "crm"), {}, sub.d, { session: "box-alice" });
  assert.equal((tgTied.account as { available: boolean }).available, true, "targets — 초대받은 사람 · 그 세션");
  const tgLoose = await targetsFor(appUser("bob", "crm"), {}, sub.d, {});
  assert.equal((tgLoose.account as { available: boolean }).available, false); assert.match(String((tgLoose.account as { reason: string }).reason), /초대받은 사람/);
  const tgTask = await targetsFor(appUser("alice", "crm"), {}, sub.d, { session: "box-task" });
  assert.equal((tgTask.account as { available: boolean }).available, false, "targets — 본인이라도 기계 세션");
  const none = world({ key: null });
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, none.d), 409, /실행 계정이 없습니다/, "account_unavailable");
  const srvUser = { ...appUser("alice", "crm"), appServer: true } as LivelyUser;
  //  #4891 — 앱 서버가 보낸 에이전트 작업(파일 · 도구)은 501 이 아니라 사람 홈 없는 작업 컨테이너로 간다(앱 폴더 · API 키 · 보낸 사람은 그대로).
  const srv = world();
  const agent = await submitRun({ prompt: "x", files: ["a.md"] }, srvUser, { source: "web" }, srv.d);
  assert.equal(agent.executor, "job"); assert.equal(agent.requester_kind, "app_server");
  const sent = srv.w.submitted.at(-1)!;
  assert.equal(sent.homeless, true, "앱 서버의 에이전트 작업은 홈 없는 자리로");
  assert.equal(sent.projectId, null); assert.equal(sent.accountKind, "api_key"); assert.equal(sent.requester, "alice"); assert.equal(sent.appId, "crm");
  //  프로젝트 폴더는 사람 경계(공개범위) — 앱 서버가 보낸 에이전트 작업엔 받지 않는다(400 · 행 안 남음 · 작업도 안 보냄).
  const proj = world();
  await fails(submitRun({ prompt: "x", files: ["a.md"], project_id: 12 }, srvUser, { source: "web" }, proj.d), 400, /앱 폴더에서만/);
  assert.equal(proj.w.runs.size, 0, "거절은 행을 안 남긴다"); assert.equal(proj.w.submitted.length, 0);
  //  사람이 보낸 에이전트 작업은 그 사람의 자리(홈)에서 돈다 — homeless 를 싣지 않는다(무회귀).
  const human = world();
  const mine = await submitRun({ prompt: "x", files: ["a.md"] }, appUser("alice", "crm"), { source: "app-ui" }, human.d);
  assert.equal(mine.executor, "job"); assert.equal(human.w.submitted.at(-1)!.homeless, false);
  const single = world();
  const srvOk = await submitRun({ prompt: "x" }, srvUser, { source: "web" }, single.d);
  assert.equal(srvOk.executor, "proxy"); assert.equal(srvOk.requester_kind, "app_server"); assert.equal(single.w.submitted.length, 0);
  ok("S5~S7 남의 구독 403 · 본인은 mcp·web 도 됨 · 초대받은 사람은 그 세션에서 됨(자리는 구독 주인 · 주인이 보고 취소) · 기계 세션 403 · targets 같은 판정 · 계정 없음 409 · 앱 서버 에이전트 → 홈 없는 작업(프로젝트 400) · 사람 에이전트는 그대로 · 앱 서버 단발은 프록시");
}

// ── S25 작업 AI 자신의 토큰은 거절 — 작업이 작업을 낳지 않는다(#4490 규칙) ──
{
  const { w, d } = world();
  await fails(submitRun({ prompt: "x" }, { ...appUser("alice", "crm"), tokenHashPrefix: "jobtok" }, { source: "mcp" }, d), 403, /작업 안에서는/);
  assert.equal(w.runs.size, 0);
  const r = await submitRun({ prompt: "x" }, { ...appUser("alice", "crm"), tokenHashPrefix: "other" }, { source: "app-ui" }, d);
  assert.equal(r.status, "running");
  ok("S25 작업 토큰은 403 · 다른 토큰은 됨");
}

// ── S8~S11 상한 — 앱 분당 · 사람당 동시 · 하루 토큰(키만) · 워크스페이스 동시 ──
{
  const rate = world({ policy: { ...DEFAULT_AI_RUN_POLICY, app_per_minute: 2 } });
  rate.d.rate = new RateWindow(2);
  await submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, rate.d);
  await submitRun({ prompt: "2" }, appUser("bob", "crm"), { source: "app-ui" }, rate.d);
  await fails(submitRun({ prompt: "3" }, appUser("carol", "crm"), { source: "app-ui" }, rate.d), 429, /너무 자주/);
  ok("S8 앱당 분당 상한 — 사람이 달라도 앱 하나로 센다");

  const per = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_running_per_member: 1, single_timeout_sec: 1 }, llmReply: () => okText("x") });
  per.d.singleShot = () => new Promise(() => undefined);   // 끝나지 않는 실행 하나
  await submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, per.d);
  await fails(submitRun({ prompt: "2" }, appUser("alice", "talk"), { source: "app-ui" }, per.d), 429, /이미 1개/);
  const other = await submitRun({ prompt: "2" }, appUser("bob", "crm"), { source: "app-ui" }, per.d);
  assert.equal(other.requester, "bob", "남은 영향 없음");
  ok("S9 사람당 동시 상한 — 열린 실행이 상한에 닿으면 429 · 다른 사람은 됨");

  const day = world({ usedToday: DEFAULT_AI_RUN_POLICY.daily_tokens_per_app });
  await fails(submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, day.d), 429, /오늘 토큰 상한/);
  const daySub = world({ usedToday: 10 ** 9, settings: { default: { kind: "subscription", member: "alice" } } });
  const r = await submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, daySub.d);
  assert.equal(r.executor, "job", "구독 실행은 하루 토큰을 보지 않는다");
  const off = world({ usedToday: 10 ** 9, policy: { ...DEFAULT_AI_RUN_POLICY, daily_tokens_per_app: 0 } });
  assert.equal((await submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, off.d)).executor, "proxy", "0 = 끔");
  ok("S10 앱당 하루 토큰 — 키만 · 0 은 끔");

  const full = world({ inflightCount: DEFAULT_AI_RUN_POLICY.max_inflight });
  await fails(submitRun({ prompt: "1" }, appUser("alice", "crm"), { source: "app-ui" }, full.d), 429, /동시에/);
  ok("S11 워크스페이스 동시 LLM 호출 가득이면 429");
}

// ── S12~S14 작업 컨테이너로 — 단발+구독(bare) · 에이전트+키 · 접수 실패 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  const r = await submitRun({ prompt: "요약", schema, label: "L" }, appUser("alice", "crm"), { source: "app-front" }, d);
  assert.equal(r.executor, "job"); assert.equal(r.status, "queued"); assert.equal(r.job_id, 101);
  const j = w.submitted[0]!;
  assert.equal(j.bare, true); assert.equal(j.accountKind, "subscription"); assert.equal(j.accountMember, "alice"); assert.equal(j.requester, "alice"); assert.equal(j.appId, "crm");
  assert.ok(j.prompt.includes("JSON Schema"), "형식 지시가 프롬프트에");
  assert.equal(w.llm.length, 0, "프록시 안 씀");
  ok("S12 단발 + 구독 → 작업 컨테이너(bare) · 본인 구독");

  const ag = world();
  const r2 = await submitRun({ prompt: "고쳐", files: ["src/a.ts"], project_id: 7, system: "sys", timeout_min: 3 }, appUser("alice", "crm"), { source: "app-ui" }, ag.d);
  assert.equal(r2.kind, "agent"); assert.deepEqual(r2.account, { kind: "api_key" }); assert.equal(r2.executor, "job");
  const j2 = ag.w.submitted[0]!;
  assert.equal(j2.bare, false); assert.equal(j2.accountKind, "api_key"); assert.equal(j2.accountMember, null); assert.equal(j2.projectId, 7); assert.equal(j2.timeoutMin, 3);
  assert.ok(j2.prompt.includes("[시스템 지시]\nsys") && j2.prompt.includes("- src/a.ts"), j2.prompt);
  ok("S13 에이전트 + API 키 → 작업 컨테이너(도구 있음 · 키 자리 없음 · 사람이 보낸 것)");

  const bad = world({ submitThrows: new HttpError(429, "작업 대기열이 찼습니다") });
  await fails(submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, bad.d), 429, /대기열/);
  assert.equal(bad.w.runs.get(1)!.status, "failed"); assert.match(bad.w.runs.get(1)!.error!, /보내지 못했습니다/);
  ok("S14 작업 접수 실패 → 행 failed · 오류 그대로 전달");
}

// ── S5b 홈 없는 작업의 형식 재시도(#4891) — 재시도 작업도 홈 없는 자리로 간다(격리 리뷰: 둘째 접수 자리가 표시를 빠뜨렸다) ──
{
  const { w, d } = world();
  const srvUser = { ...appUser("alice", "crm"), appServer: true } as LivelyUser;
  await submitRun({ prompt: "요약", files: ["a.md"], schema }, srvUser, { source: "web" }, d);
  assert.equal(w.submitted[0]!.homeless, true);
  const j1 = w.jobs.get(101)!; j1.status = "done"; j1.conversation_id = "conv-1"; j1.result = { text: "형식 밖 글" };
  w.jobTranscripts.add(101);   // #5101 API 키 작업은 게이트웨이가 보관한 대화 기록이 있어야 재시도한다(없으면 R6)
  const mid = (await syncRun(w.runs.get(1)!, d))!;
  assert.equal(mid.retries, 1, "재시도가 나갔다(관측 장치 확인)");
  assert.equal(w.submitted[1]!.homeless, true, "재시도도 홈 없는 자리");
  assert.equal(w.submitted[1]!.resumeJobId, 101);
  ok("S5b 홈 없는 작업의 형식 재시도도 홈 없는 자리");
}

// ── S5c 작업 접수 → 작업 행(#4891) — 홈 없는 표시를 그대로 옮긴다(빠지면 앱 서버의 에이전트 작업이 사람 홈에서 돈다) ──
{
  const base = { requester: "alice", accountKind: "api_key" as const, accountMember: null, appId: "crm", projectId: null, model: "m", label: "l",
    prompt: "p", timeoutMin: 5, bare: false, resumeJobId: 7, appInstructions: null, mcpOnly: false };
  const o = { cwd: "/work/apps/crm", resumeConversation: "conv-1", timeoutSec: 300 };
  const homeless = agentJobOfRun({ ...base, homeless: true, sharedSeat: false }, o);
  assert.deepEqual(homeless, {
    requester: "alice", accountKind: "api_key", accountMember: null, appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: "m", label: "l", prompt: "p", resumeConversation: "conv-1", resumeJobId: 7, timeoutSec: 300, bare: false, homeless: true, sharedSeat: false,
    appInstructions: null, mcpOnly: false,
  });
  //  #5082 — 앱 판 지시도 그대로 옮긴다(빠지면 그 작업은 지시 · 잠금 없이 작업 폴더의 CLAUDE.md 를 읽는다).
  assert.equal(agentJobOfRun({ ...base, homeless: false, sharedSeat: false, appInstructions: "판 지시" }, o).appInstructions, "판 지시");
  assert.equal(agentJobOfRun({ ...base, homeless: false, sharedSeat: false }, o).homeless, false);
  //  #5081 — 공용 시트 표시도 그대로 옮긴다(빠지면 물은 사람의 작업이 시트 계정의 이름으로 돈다).
  assert.equal(agentJobOfRun({ ...base, accountKind: "subscription", accountMember: "seat", homeless: false, sharedSeat: true }, o).sharedSeat, true);
  assert.equal(agentJobOfRun({ ...base, homeless: false, sharedSeat: false }, o).sharedSeat, false);
  ok("S5c 작업 접수 → 작업 행이 홈 없는 표시 · 공용 시트 표시를 그대로 옮긴다");
}

// ── S26 공용 시트(#5081) — 엣지 표 B2~B17(지식 app-service-seat-asbuilt-5081 §9): 켜진 시트는 구성원 누구나 · 앱 서버 사람 대리도 · 시트 홈 · 앱 폴더만 ──
{
  const NOW = "2026-10-28T00:00:00.000Z";
  const seatOn = { default: { kind: "subscription" as const, member: "seat" }, service_seats: { seat: { admin: { by: "root", at: NOW }, member: { at: NOW } } } };
  const srvUser = (id: string): LivelyUser => ({ ...appUser(id, "crm"), appServer: true } as LivelyUser);
  //  B2 활성 구성원 · 세션 없음 → 받는다 · 보낸 사람 = 그 사람 · 계정 = 시트 · 작업은 시트 자리(구독) · 공용 시트 표시
  const on = world({ settings: seatOn, key: null });
  const r2 = await submitRun({ prompt: "정책 질문" }, appUser("alice", "crm"), { source: "app-front" }, on.d);
  assert.equal(r2.requester, "alice"); assert.equal(r2.requester_kind, "member"); assert.deepEqual(r2.account, { kind: "subscription", member: "seat" });
  const j2 = on.w.submitted.at(-1)!;
  assert.equal(j2.accountMember, "seat"); assert.equal(j2.requester, "alice"); assert.equal(j2.sharedSeat, true); assert.equal(j2.homeless, false);
  assert.equal(j2.bare, true, "B13 단발도 작업 컨테이너(bare)");
  //  B4 앱 서버 + 사람 신원 → 받는다 · requester = 그 사람 · 시트 홈(홈 없는 자리 아님) · 에이전트 작업도
  const r4 = await submitRun({ prompt: "변경안을 만들어", files: ["policy.md"] }, srvUser("bob"), { source: "web" }, on.d);
  assert.equal(r4.requester, "bob"); assert.equal(r4.requester_kind, "app_server"); assert.equal(r4.executor, "job");
  const j4 = on.w.submitted.at(-1)!;
  assert.equal(j4.homeless, false, "공용 시트는 앱 서버 요청도 시트 홈에서"); assert.equal(j4.sharedSeat, true); assert.equal(j4.accountKind, "subscription");
  assert.equal(j4.requester, "bob"); assert.equal(j4.projectId, null);
  //  B15 시트 계정 본인 요청 → 받는다 · 표시도 공용 시트(한 규칙)
  await submitRun({ prompt: "x" }, appUser("seat", "crm"), { source: "app-ui" }, on.d);
  assert.equal(on.w.submitted.at(-1)!.sharedSeat, true);
  //  B3 보낸 사람이 활성 구성원이 아님(비활성 · 다른 워크스페이스 — memberFacts 가 같은 «아님») · B5 사람 신원 없는 앱 서버(앱 서버 id)
  const off = world({ settings: seatOn, key: null, members: { carol: { active: false, elevated: false } } });
  await fails(submitRun({ prompt: "x" }, appUser("carol", "crm"), { source: "app-front" }, off.d), 403, /활성 구성원이 보낸 요청에만/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, srvUser("carol"), { source: "web" }, off.d), 403, /활성 구성원이 보낸 요청에만/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, { ...appUser("app-server:t:crm", "crm"), appServer: true } as LivelyUser, { source: "web" }, off.d), 403, /활성 구성원이 보낸 요청에만/, "account_unavailable");
  assert.equal(off.w.runs.size, 0, "거절은 행을 안 남긴다");
  //  B7 기계 세션 · 모르는 세션 → 403
  off.w.sessions["box-task"] = { owner: "alice", members: [], human: false };
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp", session: "box-task" }, off.d), 403, /사람이 보는 세션/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp", session: "box-nope" }, off.d), 403, /사람이 보는 세션/, "account_unavailable");
  //  B8 project_id → 400 · 행 0 · 작업 0
  const proj = world({ settings: seatOn, key: null });
  await fails(submitRun({ prompt: "x", files: ["a.md"], project_id: 12 }, appUser("alice", "crm"), { source: "app-ui" }, proj.d), 400, /앱 폴더에서만/);
  await fails(submitRun({ prompt: "x", files: ["a.md"], project_id: 12 }, srvUser("alice"), { source: "web" }, proj.d), 400, /앱 폴더에서만/);
  assert.equal(proj.w.runs.size, 0); assert.equal(proj.w.submitted.length, 0);
  //  B9 지정됐지만 시트가 높은 권한 → 공용 아님(앱 서버 · 남 모두 403 + 까닭) / B10 시트 비활성 → 공용 아님
  const adm = world({ settings: seatOn, key: null, members: { seat: { active: true, elevated: true } } });
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-front" }, adm.d), 403, /높은 권한\(관리자 · 실행 · DB · 코드\)이 있어 공용으로 쓰지 않습니다/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, srvUser("alice"), { source: "web" }, adm.d), 403, /높은 권한/, "account_unavailable");
  const ina = world({ settings: seatOn, key: null, members: { seat: { active: false, elevated: false } } });
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-front" }, ina.d), 403, /초대받은 사람/, "account_unavailable");
  //  B11 작업 토큰은 공용 시트라도 403(작업이 작업을 낳지 않는다)
  await fails(submitRun({ prompt: "x" }, { ...appUser("alice", "crm"), tokenHashPrefix: "jobtok" }, { source: "mcp" }, on.d), 403, /작업 안에서는/);
  //  B12 API 키 · 앱 서버 에이전트 작업은 종전대로 홈 없는 자리 · 공용 시트 표시 없음
  const keyed = world();
  await submitRun({ prompt: "x", files: ["a.md"] }, srvUser("alice"), { source: "web" }, keyed.d);
  assert.equal(keyed.w.submitted.at(-1)!.homeless, true); assert.equal(keyed.w.submitted.at(-1)!.sharedSeat, false);
  //  B1/B6 지정 없음 — 종전 판정(사람 남 403 · 앱 서버 403) · 구성원 표를 읽지 않는다
  const plain = world({ settings: { default: { kind: "subscription", member: "seat" } }, key: null });
  let looked = 0; const facts = plain.d.memberFacts; plain.d.memberFacts = async (m) => { looked++; return facts(m); };
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-front" }, plain.d), 403, /초대받은 사람/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, srvUser("alice"), { source: "web" }, plain.d), 403, /앱 서버/, "account_unavailable");
  assert.equal(looked, 0, "지정이 없으면 구성원 표를 읽지 않는다");
  //  B14 형식 재시도 — 재시도 작업도 공용 시트 표시 · 시트 홈(원래 작업의 표시를 그대로)
  const re = world({ settings: seatOn, key: null });
  await submitRun({ prompt: "요약", schema }, appUser("alice", "crm"), { source: "app-front" }, re.d);
  const first = re.w.jobs.get(101)!; first.status = "done"; first.conversation_id = "conv-1"; first.result = { text: "형식 밖 글" };
  const mid = (await syncRun(re.w.runs.get(1)!, re.d))!;
  assert.equal(mid.retries, 1, "재시도가 나갔다(관측 장치)");
  assert.equal(re.w.submitted[1]!.sharedSeat, true, "재시도도 공용 시트"); assert.equal(re.w.submitted[1]!.homeless, false); assert.equal(re.w.submitted[1]!.resumeJobId, 101);
  //  B16 targets — 같은 판정 · 공용 시트라고 알려 준다
  const tg = await targetsFor(appUser("alice", "crm"), {}, on.d, {});
  assert.equal((tg.account as { available: boolean }).available, true); assert.equal((tg.account as { shared_seat: boolean }).shared_seat, true);
  const tgOff = await targetsFor(appUser("carol", "crm"), {}, off.d, {});
  assert.equal((tgOff.account as { available: boolean }).available, false); assert.match(String((tgOff.account as { reason: string }).reason), /활성 구성원/);
  //  B17 보기 — 공용 시트로 돈 실행은 시트 계정(구독 주인)의 것이 아니다: 하나 보기 · 목록 · 취소 모두 남(404 · 안 뜸) · 물은 사람은 지시까지 본다.
  //   지정을 거둔 뒤에도 그대로다(표시는 실행마다 — 실행 행의 shared_seat · 지금 지정 상태로 가르지 않는다).
  const view = world({ settings: seatOn, key: null });
  const vr = await submitRun({ prompt: "앨리스의 비밀 질문" }, appUser("alice", "crm"), { source: "app-front" }, view.d);
  await fails(getRunFor(Number(vr.id), member("seat"), view.d), 404);
  await fails(cancelRunFor(Number(vr.id), member("seat"), view.d), 404);
  assert.equal(view.w.canceled.length, 0, "시트 계정의 취소는 작업에 닿지 않는다");
  assert.deepEqual((await listRunsFor({ app_id: "crm" }, member("seat"), view.d)).runs, [], "시트 계정의 «내 실행» 에 남의 공용 시트 실행이 안 뜬다");
  assert.equal((await getRunFor(Number(vr.id), member("alice"), view.d)).prompt, "앨리스의 비밀 질문", "물은 사람은 본다");
  const mineList = (await listRunsFor({ app_id: "crm" }, member("alice"), view.d)).runs as Array<{ prompt_preview: string | null }>;
  assert.equal(mineList.length, 1); assert.equal(mineList[0]!.prompt_preview, "앨리스의 비밀 질문", "물은 사람의 목록엔 지시 앞머리까지");
  view.w.settings = { default: seatOn.default };   // 지정을 거둠
  await fails(getRunFor(Number(vr.id), member("seat"), view.d), 404, undefined, undefined);
  const seatOwn = await submitRun({ prompt: "시트 본인 질문" }, appUser("seat", "crm"), { source: "app-ui" }, view.d);
  assert.equal((await getRunFor(Number(seatOwn.id), member("seat"), view.d)).prompt, "시트 본인 질문", "시트 계정이 보낸 것은 제 것");
  //  시트 계정이 뒤에 관리자가 돼도 — 관리자 목록 · 하나 보기에 남의 공용 시트 실행은 «내 것» 이 아니다(상태만 · 지시 없음).
  const seatAdmin = admin("seat");
  const adminRows = (await listRunsFor({ app_id: "crm" }, seatAdmin, view.d)).runs as Array<{ id: number; prompt_preview: string | null }>;
  assert.equal(adminRows.find((r) => r.id === vr.id)?.prompt_preview, null, "관리자가 된 시트 계정의 목록에 남의 지시 앞머리가 없다");
  assert.equal(adminRows.find((r) => r.id === seatOwn.id)?.prompt_preview, "시트 본인 질문");
  assert.ok(!("prompt" in (await getRunFor(Number(vr.id), seatAdmin, view.d))), "하나 보기도 상태만(관리자 규칙)");
  //  취소는 관리자 규칙(app_ai_run_cancel — 보낸 사람과 관리자)대로 된다 — 공용 시트였던 계정도 관리자가 되면 관리자다(지시 · 답은 여전히 안 보인다).
  await cancelRunFor(Number(vr.id), seatAdmin, view.d);
  assert.ok(view.w.canceled.includes(Number(vr.job_id)), "관리자는 누구의 실행이든 끊는다");
  //  표시는 실행 행에 있다 — 작업 행이 없는 실행(접수 중 대기열이 차 실패)도, 작업 행이 지워진 실행(보존 정리)도 시트 계정의 것이 아니다(격리 리뷰).
  const full = world({ settings: seatOn, key: null, submitThrows: new HttpError(429, "작업 대기열이 찼습니다") });
  await fails(submitRun({ prompt: "앨리스의 질문(대기열 참)" }, appUser("alice", "crm"), { source: "app-front" }, full.d), 429);
  const orphan = [...full.w.runs.values()][0]!;
  assert.equal(orphan.status, "failed"); assert.equal(orphan.job_id, null, "작업 행이 없는 실행(관측 장치)");
  await fails(getRunFor(orphan.id, member("seat"), full.d), 404);
  await fails(cancelRunFor(orphan.id, member("seat"), full.d), 404);
  assert.deepEqual((await listRunsFor({ app_id: "crm" }, member("seat"), full.d)).runs, [], "작업 없는 공용 시트 실행도 시트 계정의 목록에 없다");
  assert.equal((await getRunFor(orphan.id, member("alice"), full.d)).prompt, "앨리스의 질문(대기열 참)", "물은 사람은 본다");
  const pruned = world({ settings: seatOn, key: null });
  const pr = await submitRun({ prompt: "오래된 질문" }, appUser("alice", "crm"), { source: "app-front" }, pruned.d);
  pruned.w.jobs.clear(); pruned.w.jobShared.clear();   // 보존 정리가 작업 행을 지웠다
  await fails(getRunFor(Number(pr.id), member("seat"), pruned.d), 404);
  assert.deepEqual((await listRunsFor({ app_id: "crm" }, member("seat"), pruned.d)).runs, [], "작업 행이 지워진 공용 시트 실행도 시트 계정의 목록에 없다");
  //  지정을 거둔 뒤 시트 계정이 제 구독으로 보낸 실행은 표시가 없다 — 보통 구독 실행이다(초대받은 사람 · 구독 주인 가지는 위 구독 선 시험이 잰다).
  assert.equal(view.w.runShared.get(Number(seatOwn.id)), false, "지정 거둔 뒤 시트 본인 실행은 표시 없음");
  //  롤 창 — 새 게이트웨이가 마이그레이션보다 먼저 받는 몇 분 동안 공용 시트 실행 접수는 «없는 칸»(42703)으로 실패한다 → 503(잠시 뒤 다시).
  const roll = world({ settings: seatOn, key: null });
  const realInsert = roll.d.store.insertAiRun;
  roll.d.store.insertAiRun = async (n) => { if (n.sharedSeat) throw Object.assign(new Error('column "shared_seat" of relation "org_app_ai_run" does not exist'), { code: "42703" }); return realInsert(n); };
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-front" }, roll.d), 503, /잠시 뒤 다시/);
  assert.equal(roll.w.submitted.length, 0, "작업을 보내지 않는다");
  ok("S26 공용 시트 — 구성원 누구나 · 앱 서버 사람 대리 · 시트 자리(홈 없는 자리 아님) · 표시 · 남는 거절(비활성 · 앱 서버 id · 기계 세션 · 작업 토큰) · 앱 폴더만 · 높은 권한/비활성 시트는 공용 아님 · 재시도도 같은 자리 · targets · 시트 계정은 남의 실행을 못 봄");
}

// ── S15~S19 동기화 — 작업 상태를 따라간다 · 형식 판정 · 재시도 1회 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "요약", schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  const job = w.jobs.get(101)!;
  job.status = "running";
  assert.equal((await syncRun(w.runs.get(1)!, d))!.status, "running");
  ok("S15 작업 running → 실행 running");

  job.status = "done"; job.conversation_id = "conv-1"; job.result = { text: '{"n": 7}', usage: { input_tokens: 1, output_tokens: 2 }, cost_usd: 0.01, model: "m" };
  const done = (await syncRun(w.runs.get(1)!, d))!;
  assert.equal(done.status, "done"); assert.deepEqual((done.result as { json: unknown }).json, { n: 7 }); assert.equal((done.result as { conversation_id: string }).conversation_id, "conv-1");
  assert.equal(done.input_tokens, 1);
  ok("S16 작업 done · 스키마 맞음 → done(result.json · conversation_id · 토큰)");

  const re = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "요약", schema }, appUser("alice", "crm"), { source: "app-ui" }, re.d);
  const j1 = re.w.jobs.get(101)!; j1.status = "done"; j1.conversation_id = "conv-1"; j1.result = { text: "글" };
  const mid = (await syncRun(re.w.runs.get(1)!, re.d))!;
  assert.equal(mid.status, "queued", "열린 채로 재시도"); assert.equal(mid.retries, 1); assert.equal(mid.job_id, 102);
  const retry = re.w.submitted[1]!;
  assert.equal(retry.resumeJobId, 101, "그 대화를 이어받는다"); assert.match(retry.prompt, /형식에 맞지 않았습니다/); assert.equal(retry.bare, true);
  ok("S17 어긋남 · 첫 번째 → 대화 이어받는 재시도 작업 · retries 1");

  const j2 = re.w.jobs.get(102)!; j2.status = "done"; j2.conversation_id = "conv-1"; j2.result = { text: "또 글" };
  const fin = (await syncRun((await re.d.store.getAiRun(1))!, re.d))!;
  assert.equal(fin.status, "failed"); assert.equal((fin.result as { text: string }).text, "또 글"); assert.match(fin.error!, /형식에 맞지 않습니다/);
  assert.equal(re.w.submitted.length, 2, "세 번째 작업은 없다");
  ok("S18 두 번째도 어긋나면 원문 붙여 실패");

  const t = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "a" }, appUser("alice", "crm"), { source: "app-ui" }, t.d);
  await submitRun({ prompt: "b" }, appUser("alice", "crm"), { source: "app-ui" }, t.d);
  t.w.jobs.get(101)!.status = "timeout"; t.w.jobs.get(101)!.error = "시간 초과";
  t.w.jobs.get(102)!.status = "canceled"; t.w.jobs.get(102)!.error = "취소했습니다";
  assert.equal((await syncRun(t.w.runs.get(1)!, t.d))!.status, "failed"); assert.equal((await syncRun(t.w.runs.get(1)!, t.d))!.error, "시간 초과");
  assert.equal((await syncRun(t.w.runs.get(2)!, t.d))!.status, "canceled");
  ok("S19 작업 timeout → failed · canceled → canceled · 사유 전달");
}

// ── S20~S21 보기 — 관리자는 상태·오류만 · 앱 화면은 제 앱만 ──
{
  const { w, d } = world();
  await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  const mine = await getRunFor(1, appUser("alice", "crm"), d);
  assert.equal((mine.result as { text: string }).text, "답"); assert.equal(mine.prompt, "x");
  const adm = await getRunFor(1, admin("root"), d);
  assert.equal(adm.status, "done"); assert.equal(adm.result, undefined); assert.equal(adm.has_result, true); assert.equal(adm.prompt, undefined);
  await fails(getRunFor(1, appUser("alice", "talk"), d), 404);
  await fails(getRunFor(1, member("bob"), d), 404);
  await fails(getRunFor(99, admin("root"), d), 404);
  assert.equal(w.runs.size, 1);
  ok("S20~S21 관리자는 상태만 · 남의 앱 · 남은 404");
}

// ── S22 API 키 작업의 판 환경 — 프록시 주소 · 실행 토큰 · 빈 설정 폴더 · 구독은 빈 객체 ──
{
  const { w, d } = world();
  await submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, d);
  const env = await bootEnvForJob({ id: 101, account_kind: "api_key" }, d);
  assert.equal(env.ANTHROPIC_BASE_URL, PROXY_BASE_IN_CONTAINER); assert.equal(env.ANTHROPIC_AUTH_TOKEN, "lvai_tok"); assert.equal(env.CLAUDE_CONFIG_DIR, CONFIG_DIR_PLACEHOLDER);
  assert.equal(env.ANTHROPIC_API_KEY, "", "키 변수는 지우라는 뜻의 빈 값");
  assert.equal(w.runs.get(1)!.proxy_token_hash, "hash-of-tok");
  assert.ok(!Object.values(env).includes("sk-ws"), "워크스페이스 키는 컨테이너에 안 들어간다");
  assert.deepEqual(await bootEnvForJob({ id: 101, account_kind: "subscription" }, d), {});
  await fails(bootEnvForJob({ id: 999, account_kind: "api_key" }, d), 409);
  assert.ok(!("ANTHROPIC_CUSTOM_HEADERS" in env), "G3 자리를 안 주면(매니지드) 머리를 더 싣지 않는다 — 세션 루프백이 테넌트를 싣는다");
  ok("S22 판 환경 — 키 대신 프록시 주소 + 실행 토큰 + 빈 설정 폴더");
}

// ── G2 박스 위 판(#5082) — 프록시는 판이 보는 게이트웨이 아래 · 그 워크스페이스 머리를 Claude Code 가 싣는다 ──
{
  const { d } = world();
  await submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, d);
  const env = await bootEnvForJob({ id: 101, account_kind: "api_key" }, d, { gateway: "http://127.0.0.1:18080", workspace: "acme" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18080/api/llm/anthropic");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-lively-workspace: acme");
  const single = await bootEnvForJob({ id: 101, account_kind: "api_key" }, d, { gateway: "http://127.0.0.1:8080", workspace: null });
  assert.equal(single.ANTHROPIC_BASE_URL, PROXY_BASE_IN_CONTAINER);
  assert.ok(!("ANTHROPIC_CUSTOM_HEADERS" in single), "단일 워크스페이스(primary)면 머리 없음");
  ok("G2 박스 위 판 — 그 게이트웨이 · 그 워크스페이스로");
}

// ── S23 취소 — 작업 실행은 작업을 끊는다 · 프록시는 행만 끝낸다 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await cancelRunFor(1, appUser("alice", "crm"), d);
  assert.deepEqual(w.canceled, [101]);
  const px = world({ policy: { ...DEFAULT_AI_RUN_POLICY, single_timeout_sec: 1 } });
  px.d.singleShot = () => new Promise(() => undefined);
  await submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, px.d);
  const c = await cancelRunFor(1, appUser("alice", "crm"), px.d);
  assert.equal(c.status, "canceled");
  ok("S23 취소 — 작업은 cancelJob · 프록시는 행 canceled");
}

// ── S24 wait — 끝날 때까지 기다렸다 끝난 행을 준다 ──
{
  const { d } = world({ llmReply: () => okText("기다린 답") });
  const r = await submitRun({ prompt: "x", wait: 5 }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(r.status, "done"); assert.equal((r.result as { text: string }).text, "기다린 답");
  ok("S24 wait — 한 번에 결과");
}

// ══ #5101 이어받기(resume_run_id) — 엣지 표 R1~R17 · N1(태스크 #5101 · 지식 app-ai-run-resume-asbuilt-5101) ══
//  이게 틀리면: 남의 대화 · 다른 앱의 실행을 이어받거나, 끝나지 않은 대화에 끼어들거나, 상한 없이 끝없이 다시 묻거나, 이어받은 실행이 다른 실행 계정 ·
//  작업 폴더에서 돌아 앞 대화가 없거나, 앞 대화 없이 사유만 받은 AI 가 엉뚱한 답을 낸다.
const doneJob = (w: World, id: number, conv: string, text = "답"): void => { Object.assign(w.jobs.get(id)!, { status: "done", conversation_id: conv, result: { text } }); };
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222";

// ── R1 단발 이어받기 — 새 실행 · 앞 대화를 엮어 보낸다 · system · schema 는 앞 실행 것 · 앞 실행은 그대로 ──
{
  const { w, d } = world({ llmReply: (_i, n) => okText(n === 1 ? '{"n": 1}' : '{"n": 2}') });
  //  수요의 흐름 그대로 — 앱 서버가 사람(alice) 대리로 묻고, 검사해 어긋나면 같은 자리(앱 서버)에서 잇는다(보낸 자리가 다르면 409 — R15).
  const srv = member("alice", { appId: "crm", appServer: true });
  const first = await submitRun({ prompt: "질문", system: "정책 위키 비서", schema }, srv, { source: "rest" }, d);
  await settle();
  assert.equal(first.resume, null, "새 질문은 resume null");
  assert.equal(w.runs.get(1)!.status, "done");
  const r = await submitRun({ prompt: "근거 id 7 은 조회 결과에 없습니다 — 다시", reason: "인용 불일치" }, srv, { source: "rest" }, d)
    .catch((e) => e);
  assert.ok(!(r instanceof Error), "resume_run_id 없이 보내면 새 질문이다(아래에서 이어받기로 다시)");
  const r2 = await submitRun({ prompt: "근거 id 7 은 조회 결과에 없습니다 — 다시", reason: "인용 불일치", resume_run_id: 1 }, srv, { source: "rest" }, d);
  await settle();
  assert.equal(r2.id, 3, "새 실행 행");
  assert.deepEqual(r2.resume, { of: 1, root: 1, depth: 1, reason: "인용 불일치" });
  const call = w.llm[2]!;
  assert.deepEqual(call.messages?.map((m) => m.role), ["user", "assistant", "user"], "앞 지시 → 앞 답 → 이번 사유");
  assert.ok(call.messages![0]!.content.startsWith("질문") && call.messages![0]!.content.includes("JSON Schema"), "앞 지시(+형식 지시) 그대로");
  assert.equal(call.messages![1]!.content, '{"n": 1}');
  assert.ok(call.messages![2]!.content.startsWith("근거 id 7") && call.messages![2]!.content.includes("JSON Schema"), "이번 사유 + 앞 실행의 schema 형식 지시");
  assert.equal(call.system, "정책 위키 비서", "system 은 앞 실행 것");
  const row = w.runs.get(3)!;
  assert.equal(row.status, "done"); assert.deepEqual((row.result as { json: unknown }).json, { n: 2 });
  assert.deepEqual(row.schema, schema, "schema 를 안 주면 앞 실행 것"); assert.equal(row.system_prompt, "정책 위키 비서");
  assert.equal(row.label, "AI 실행 #1 (이어받기 1)", "앞 실행에 이름표가 없으면 처음 실행 번호로"); assert.equal(row.prompt, "근거 id 7 은 조회 결과에 없습니다 — 다시", "실행 기록의 prompt = 사유 메시지");
  assert.equal(row.requester_kind, "app_server", "이번 요청의 자리");
  assert.equal((w.runs.get(1)!.result as { text: string }).text, '{"n": 1}', "앞 실행은 그대로"); assert.equal(w.runs.get(1)!.status, "done");
  assert.equal(w.resumeLinks.has(2), false, "resume_run_id 가 없던 실행은 새 질문");
  ok("R1 단발 이어받기 — 새 실행 · 앞 대화 + 사유 · system/schema 상속 · 기록(of/root/depth/reason) · 앞 실행 그대로");
}

// ── R2 줄 — 이어받은 실행을 또 이으면 처음부터 다 엮는다(depth 2 · root 1) · 갈래도 된다 · 한 질문당 상한은 갈래까지 센다(경계: 2번 뒤 받음 · 3번 뒤 거절) ──
{
  const { w, d } = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_resumes: 3 }, llmReply: (_i, n) => okText(`답${n}`) });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "고쳐1", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();
  const r3 = await submitRun({ prompt: "고쳐2", resume_run_id: 2 }, u, { source: "app-ui" }, d); await settle();
  assert.deepEqual(r3.resume, { of: 2, root: 1, depth: 2, reason: null }, "까닭을 안 주면 null");
  assert.deepEqual(w.llm[2]!.messages!.map((m) => m.content), ["Q", "답1", "고쳐1", "답2", "고쳐2"], "처음 실행부터 차례로(schema 가 없으면 형식 지시 없음)");
  assert.equal(w.runs.get(3)!.label, "AI 실행 #1 (이어받기 2)", "번호만 바뀐다");
  const r4 = await submitRun({ prompt: "다른 갈래", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();   // 이미 2번 — 상한 3 아래(경계)
  assert.deepEqual(r4.resume, { of: 1, root: 1, depth: 1, reason: null }, "같은 실행에서 다시 갈라 잇는다");
  assert.deepEqual(w.llm[3]!.messages!.map((m) => m.content), ["Q", "답1", "다른 갈래"], "갈래는 그 실행까지의 대화");
  await fails(submitRun({ prompt: "넷째", resume_run_id: 3 }, u, { source: "app-ui" }, d), 409, /이미 3번 이어받았습니다/, "resume_limit");
  assert.equal(w.runs.size, 4, "상한에 걸리면 행을 넣지 않는다"); assert.equal(w.llm.length, 4);
  ok("R2 줄 · 갈래 — 처음부터 엮기 · depth/root · 한 질문당 상한(갈래 포함 · 경계 2 받음 / 3 거절) 409 resume_limit");
}

// ── R3 이어받은 단발의 형식 재시도 — 앞 대화 뒤에 (이번 지시 → 어긋난 답 → 형식 다시) ──
{
  const { w, d } = world({ llmReply: (_i, n) => okText(n === 2 ? "형식 아님" : '{"n": 3}') });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q", schema }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();
  const retry = w.llm[2]!;
  assert.deepEqual(retry.messages!.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(retry.messages![1]!.content, '{"n": 3}', "앞 대화를 잃지 않는다");
  assert.equal(retry.messages![3]!.content, "형식 아님"); assert.match(retry.messages![4]!.content, /형식에 맞지 않았습니다/);
  assert.equal(w.runs.get(2)!.status, "done"); assert.equal(w.runs.get(2)!.retries, 1);
  ok("R3 이어받은 단발의 형식 재시도 — 앞 대화를 잃지 않는다");
}

// ── R4 작업(구독) 이어받기 — 앞 작업의 대화 · 작업 폴더 · 실행 계정 · 모델 · 단발 여부 그대로 · system 은 다시 안 싣는다 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사해", system: "시스템 글", agent: true, project_id: 77, schema }, u, { source: "app-ui" }, d);
  w.jobs.get(101)!.model = "opus";
  doneJob(w, 101, C1, '{"n": 1}');
  assert.equal((await syncRun(w.runs.get(1)!, d))!.status, "done");
  const r = await submitRun({ prompt: "근거가 틀렸습니다", project_id: 77 }, u, { source: "app-ui" }, d);
  assert.equal(r.resume, null, "resume_run_id 가 없으면 새 질문");
  const r2 = await submitRun({ prompt: "근거가 틀렸습니다", resume_run_id: 1, project_id: 77 }, u, { source: "app-ui" }, d);
  assert.deepEqual(r2.resume, { of: 1, root: 1, depth: 1, reason: null });
  const j = w.submitted[2]!;
  assert.equal(j.resumeJobId, 101, "앞 작업의 대화를 잇는다");
  assert.equal(j.projectId, 77, "앞 작업의 작업 폴더"); assert.equal(j.accountKind, "subscription"); assert.equal(j.accountMember, "alice");
  assert.equal(j.model, "opus", "모델을 안 주면 앞 작업 것"); assert.equal(j.bare, false, "에이전트 그대로");
  assert.ok(!j.prompt.includes("[시스템 지시]"), "system 은 앞 대화에 이미 있다"); assert.ok(j.prompt.startsWith("근거가 틀렸습니다") && j.prompt.includes("JSON Schema"), "사유 + 형식 지시");
  assert.equal(w.runs.get(3)!.job_id, 103); assert.equal(w.runs.get(3)!.system_prompt, "시스템 글", "기록엔 대화의 system");
  assert.equal(w.submitted[0]!.resumeJobId, null, "새 질문은 잇지 않는다"); assert.ok(w.submitted[0]!.prompt.includes("[시스템 지시]"), "새 질문은 system 을 싣는다");
  ok("R4 작업(구독) 이어받기 — resumeJobId · 작업 폴더 · 계정 · 모델 · bare · system 안 실음");
}

// ── R5 앞 실행에 형식 재시도가 있었으면 그 재시도 작업(마지막 작업)의 대화를 잇는다 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q", schema }, u, { source: "app-ui" }, d);
  doneJob(w, 101, C1, "형식 아님");
  await syncRun(w.runs.get(1)!, d);   // → 재시도 작업 102
  doneJob(w, 102, C2, '{"n": 5}');
  assert.equal((await syncRun((await d.store.getAiRun(1))!, d))!.status, "done");
  await submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[2]!.resumeJobId, 102, "마지막 작업"); assert.equal(w.submitted[2]!.bare, true, "단발(구독)은 단발 그대로");
  ok("R5 형식 재시도 뒤의 이어받기 — 마지막 작업의 대화");
}

// ── R6 API 키 작업 — 게이트웨이가 보관한 대화 기록이 있어야 잇는다 · 없으면 409(행을 넣지 않는다) · 형식 재시도도 기록이 없으면 원문 붙여 실패 ──
{
  const { w, d } = world();
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사", agent: true, schema }, u, { source: "app-ui" }, d);
  doneJob(w, 101, C1, "형식 아님");
  const fin = (await syncRun(w.runs.get(1)!, d))!;
  assert.equal(fin.status, "failed", "기록이 없으면 형식 재시도를 띄우지 않는다"); assert.match(fin.error!, /형식에 맞지 않습니다/);
  assert.equal(w.submitted.length, 1);
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d), 409, /API 키 작업의 대화 기록이 없습니다/, "resume_not_resumable");
  assert.equal(w.runs.size, 1);
  w.jobTranscripts.add(101);
  const r = await submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(r.executor, "job"); assert.equal(w.submitted[1]!.resumeJobId, 101); assert.equal(w.submitted[1]!.accountKind, "api_key");

  const f2 = world();
  await submitRun({ prompt: "조사", agent: true, schema }, u, { source: "app-ui" }, f2.d);
  doneJob(f2.w, 101, C1, "형식 아님");
  f2.w.jobTranscripts.add(101);
  const mid = (await syncRun(f2.w.runs.get(1)!, f2.d))!;
  assert.equal(mid.retries, 1, "기록이 있으면 형식 재시도를 띄운다"); assert.equal(f2.w.submitted[1]!.resumeJobId, 101);
  ok("R6 API 키 작업 — 대화 기록 없으면 이어받기 409 · 형식 재시도 생략 / 있으면 둘 다 돈다");
}

// ── R6b(#5082) 구독 작업도 형식 재시도 전에 이을 판정(resumeTarget)을 묻는다 — 도커 실행면은 대화가 홈에 남지 않아 «기록 없음» 이면 띄우지 않는다 ──
{
  const u = appUser("alice", "crm");
  for (const resumable of [false, true]) {
    const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
    if (!resumable) d.resumeTarget = async (id) => ({ projectId: null, model: null, conversation: w.jobs.get(id)?.conversation_id ?? null, resumable: false, why: "작업의 대화 기록이 없습니다" });
    await submitRun({ prompt: "조사", agent: true, schema }, u, { source: "app-ui" }, d);
    doneJob(w, 101, C1, "형식 아님");
    const fin = (await syncRun(w.runs.get(1)!, d))!;
    if (resumable) { assert.equal(fin.retries, 1, "이을 수 있으면 구독 작업도 형식 재시도를 띄운다"); assert.equal(w.submitted[1]!.resumeJobId, 101); }
    else { assert.equal(fin.status, "failed", "이을 기록이 없으면 띄우지 않는다"); assert.match(fin.error!, /형식에 맞지 않습니다/); assert.equal(w.submitted.length, 1); }
  }
  ok("R6b 구독 작업 — 형식 재시도도 이을 판정을 따른다(도커 실행면 · 기록 없음이면 생략)");
}

// ── R7 거절 — 남의 실행 · 다른 앱 · 관리자 · 구독 주인(보낸 사람 아님) · 없는 id = 404 / 형식 400 / 안 끝남 · 취소 · 답 없음 · 꺼짐 = 409 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null, sessions: { s1: { owner: "alice", members: ["bob"] } } });
  await submitRun({ prompt: "Q" }, member("bob", { appId: "crm" }), { source: "app-ui", session: "s1" }, d);   // bob 이 alice 구독으로(초대) — 실행 1 · 작업 101
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, appUser("carol", "crm"), { source: "app-ui" }, d), 404, /이어받을 실행이 없습니다/, "resume_not_found");
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, appUser("bob", "talk"), { source: "app-ui", session: "s1" }, d), 404, undefined, "resume_not_found");
  await fails(submitRun({ prompt: "x", resume_run_id: 1, app_id: "crm" }, admin("root"), { source: "mcp" }, d), 404, undefined, "resume_not_found");
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, appUser("alice", "crm"), { source: "app-ui" }, d), 404, undefined, "resume_not_found");
  await fails(submitRun({ prompt: "x", resume_run_id: 999 }, appUser("bob", "crm"), { source: "app-ui", session: "s1" }, d), 404);
  await fails(submitRun({ prompt: "x", resume_run_id: 0 }, appUser("bob", "crm"), { source: "app-ui", session: "s1" }, d), 400, /resume_run_id 형식/);
  await fails(submitRun({ prompt: "x", resume_run_id: "abc" }, appUser("bob", "crm"), { source: "app-ui", session: "s1" }, d), 400, /resume_run_id 형식/);
  assert.equal(w.runs.size, 1, "거절은 행을 넣지 않는다"); assert.equal(w.submitted.length, 1, "작업도 안 띄운다");
  const mine = await submitRun({ prompt: "x", resume_run_id: 1 }, appUser("bob", "crm"), { source: "app-ui", session: "s1" }, d);
  assert.equal((mine.resume as { of: number }).of, 1, "보낸 사람 본인은 잇는다(같은 세션 tie)");

  const o = world({ llmReply: () => ({ ...okText(""), ok: false, status: 529, error: "overloaded" }) });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "a" }, u, { source: "app-ui" }, o.d); await settle();                       // 1 failed · 답 없음
  o.d.singleShot = () => new Promise(() => undefined);
  await submitRun({ prompt: "b" }, u, { source: "app-ui" }, o.d);                                       // 2 running
  await fails(submitRun({ prompt: "x", resume_run_id: 2 }, u, { source: "app-ui" }, o.d), 409, /아직 끝나지 않은 실행/, "resume_not_ended");
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, u, { source: "app-ui" }, o.d), 409, /이어받을 대화가 남아 있지 않습니다/, "resume_not_resumable");
  await cancelRunFor(2, u, o.d);
  await fails(submitRun({ prompt: "x", resume_run_id: 2 }, u, { source: "app-ui" }, o.d), 409, /취소된 실행/, "resume_not_resumable");
  Object.assign(o.w.runs.get(1)!, { result: { text: "형식이 어긋난 원문" } });   // 실패(failed) 그대로 · 원문만 있다
  assert.equal(o.w.runs.get(1)!.status, "failed");
  o.w.policy = { ...o.w.policy, max_resumes: 0 };
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, u, { source: "app-ui" }, o.d), 409, /이어받기를 껐습니다/, "resume_disabled");
  o.w.policy = { ...o.w.policy, max_resumes: 1 };
  const okNow = await submitRun({ prompt: "x", resume_run_id: 1 }, u, { source: "app-ui" }, o.d);
  assert.equal((okNow.resume as { of: number }).of, 1, "답이 있는 실패 실행은 잇는다");
  assert.equal(o.w.runs.size, 3);
  ok("R7 거절 — 404(남 · 다른 앱 · 관리자 · 구독 주인 · 없는 id) · 400 · 409(안 끝남 · 취소 · 답 없음 · 꺼짐) · 실패라도 답이 있으면 잇는다");
}

// ── R8 어긋난 입력 400 — 작업 이름 · system · 단발을 에이전트로 · 작업 폴더 / 같은 값은 받는다 ──
{
  const { w, d } = world({ llmReply: () => okText("답") });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q", system: "S", job: "summarize" }, u, { source: "app-ui" }, d); await settle();
  await fails(submitRun({ prompt: "x", resume_run_id: 1, job: "other" }, u, { source: "app-ui" }, d), 400, /job 은 이어받는 실행과 같아야/);
  await fails(submitRun({ prompt: "x", resume_run_id: 1, system: "다른 S" }, u, { source: "app-ui" }, d), 400, /system 은 바꿀 수 없습니다/);
  await fails(submitRun({ prompt: "x", resume_run_id: 1, files: ["a.txt"] }, u, { source: "app-ui" }, d), 400, /단발 실행은 에이전트 작업으로/);
  await fails(submitRun({ prompt: "x", resume_run_id: 1, agent: true }, u, { source: "app-ui" }, d), 400, /단발 실행은 에이전트 작업으로/);
  await fails(submitRun({ prompt: "x", resume_run_id: 1, project_id: 5 }, u, { source: "app-ui" }, d), 400, /단발 실행은 에이전트 작업으로/);
  const same = await submitRun({ prompt: "x", resume_run_id: 1, job: "summarize", system: "S" }, u, { source: "app-ui" }, d);
  assert.equal((same.resume as { of: number }).of, 1, "같은 값을 다시 보내면 받는다"); assert.equal(same.job, "summarize");

  const a = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "Q", agent: true, project_id: 77 }, u, { source: "app-ui" }, a.d);
  doneJob(a.w, 101, C1);
  await syncRun(a.w.runs.get(1)!, a.d);
  await fails(submitRun({ prompt: "x", resume_run_id: 1, project_id: 78 }, u, { source: "app-ui" }, a.d), 400, /앞 실행의 작업 폴더/);
  await submitRun({ prompt: "x", resume_run_id: 1, files: ["more.txt"] }, u, { source: "app-ui" }, a.d);
  assert.match(a.w.submitted[1]!.prompt, /more\.txt/, "에이전트 대화엔 파일을 더 알려 줄 수 있다");
  assert.equal(w.runs.size, 2); assert.equal(a.w.runs.size, 2);
  ok("R8 어긋난 입력 400 — job · system · 종류 · 작업 폴더 / 같은 값 · 에이전트에 파일 더하기는 통과");
}

// ── R9 실행 계정은 앞 실행 것 · 판정은 지금 다시 — 앱 설정이 바뀌어도 그 대화의 계정 · 앱 서버는 구독 대화를 못 잇는다 · 공용 시트를 거두면 못 잇는다 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: "sk" });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d);
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  w.settings = {};   // 이제 앱의 실행 계정은 API 키(키가 있으니)
  const r = await submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.deepEqual(r.account, { kind: "subscription", member: "alice" }, "대화가 있는 계정 그대로"); assert.equal(r.executor, "job");
  //  앱 서버는 앱 화면에서 시작한 구독 대화를 못 잇는다 — 보낸 자리가 다르면 계정 판정 전에 409(종전 403 «구독은 사람이 보낸 요청에만» 보다 앞 · R15).
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, member("alice", { appId: "crm", appServer: true }), { source: "rest" }, d), 409, /앱 화면에서 시작한 대화는 앱 화면에서/, "resume_not_resumable");

  const seat = { admin: { by: "root", at: "t" }, member: { at: "t" } };
  const s = world({ settings: { default: { kind: "subscription", member: "seat1" }, service_seats: { seat1: seat } }, key: null });
  const srvBob = member("bob", { appId: "crm", appServer: true });
  await submitRun({ prompt: "Q" }, srvBob, { source: "rest" }, s.d);
  doneJob(s.w, 101, C1);
  await syncRun(s.w.runs.get(1)!, s.d);
  const ok1 = await submitRun({ prompt: "고쳐", resume_run_id: 1 }, srvBob, { source: "rest" }, s.d);
  assert.equal(s.w.submitted[1]!.sharedSeat, true, "공용 시트 대화는 공용 시트로"); assert.equal(s.w.submitted[1]!.homeless, false);
  assert.equal((ok1.resume as { of: number }).of, 1);
  s.w.settings = { default: { kind: "subscription", member: "seat1" } };   // 지정을 거뒀다
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, srvBob, { source: "rest" }, s.d), 403, undefined, "account_unavailable");

  const k = world();
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, k.d); await settle();
  k.w.key = null;
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, u, { source: "app-ui" }, k.d), 409, /API 키인데 등록된 키가 없습니다/, "account_unavailable");
  ok("R9 계정 — 앞 실행 것 · 판정은 지금(앱 서버 → 앱 화면 구독 대화 409 · 시트 거둠 403 · 키 없음 409) · 시트 대화는 시트 자리");
}

// ── R10 홈 없는 작업(앱 서버 · API 키 에이전트)의 이어받기 — 다시 홈 없는 자리 · 사람이 프로젝트 폴더에서 돌린 대화는 앱 서버가 못 잇는다 ──
{
  const { w, d } = world();
  const srv = member("alice", { appId: "crm", appServer: true });
  await submitRun({ prompt: "Q", agent: true }, srv, { source: "rest" }, d);
  assert.equal(w.submitted[0]!.homeless, true);
  doneJob(w, 101, C1); w.jobTranscripts.add(101);
  await syncRun(w.runs.get(1)!, d);
  await submitRun({ prompt: "고쳐", resume_run_id: 1 }, srv, { source: "rest" }, d);
  assert.equal(w.submitted[1]!.homeless, true, "홈 없는 자리 그대로"); assert.equal(w.submitted[1]!.projectId, null);
  assert.equal(w.submitted[1]!.model, null, "앞 작업에 모델이 없으면 없다(하네스 기본)");

  //  사람이 앱 화면에서 프로젝트 폴더로 돌린 대화는 앱 서버가 못 잇는다 — 보낸 자리가 달라 409(R15) 가 먼저다.
  const p = world();
  await submitRun({ prompt: "Q", agent: true, project_id: 77 }, appUser("alice", "crm"), { source: "app-ui" }, p.d);
  doneJob(p.w, 101, C1); p.w.jobTranscripts.add(101);
  await syncRun(p.w.runs.get(1)!, p.d);
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, srv, { source: "rest" }, p.d), 409, /앱 화면에서 시작한 대화는 앱 화면에서/, "resume_not_resumable");
  assert.equal(p.w.runs.size, 1);
  //  같은 자리(앱 서버)여도 앞 작업이 프로젝트 폴더에서 돌았다면(지금 접수로는 생기지 않는 행 — 막이 하나 더) 홈 없는 자리로 잇지 않는다(400).
  const q = world();
  await submitRun({ prompt: "Q", agent: true }, srv, { source: "rest" }, q.d);
  doneJob(q.w, 101, C1); q.w.jobTranscripts.add(101); q.w.jobs.get(101)!.project_id = 77;
  await syncRun(q.w.runs.get(1)!, q.d);
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, srv, { source: "rest" }, q.d), 400, /프로젝트 폴더에서 돌았습니다/);
  assert.equal(q.w.runs.size, 1); assert.equal(q.w.submitted.length, 1);
  ok("R10 홈 없는 작업 이어받기 — 홈 없는 자리 그대로 · 사람의 프로젝트 폴더 대화는 앱 서버가 못 잇는다(409 자리 · 400 폴더)");
}

// ── R11 모델을 바꿔 다시 시키기 · 이름표 · 까닭(NUL 뺌 · 300자) ──
{
  const { w, d } = world();
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q", label: "정책 질문" }, u, { source: "app-ui" }, d); await settle();
  const r = await submitRun({ prompt: "고쳐", resume_run_id: 1, model: "claude-sonnet-5-5", reason: `a\u0000${"가".repeat(400)}` }, u, { source: "app-ui" }, d); await settle();
  assert.equal(w.llm[1]!.model, "claude-sonnet-5-5"); assert.equal(w.runs.get(2)!.model, "claude-sonnet-5-5");
  assert.equal(w.runs.get(2)!.label, "정책 질문 (이어받기 1)");
  const reason = (r.resume as { reason: string }).reason;
  assert.equal(reason.length, 300); assert.ok(!reason.includes("\u0000"));
  await submitRun({ prompt: "또", resume_run_id: 2 }, u, { source: "app-ui" }, d); await settle();
  assert.equal(w.runs.get(3)!.label, "정책 질문 (이어받기 2)", "앞 이름표의 번호는 떼고 새 번호"); assert.equal(w.runs.get(3)!.model, "claude-sonnet-5-5", "안 주면 앞 실행 모델");
  ok("R11 모델 바꿔 다시 · 이름표 · 까닭 다듬기");
}

// ── R12 하나 보기 — 이어받은 실행은 resume 줄(까닭은 보낸 사람만) · 새 질문은 null ──
{
  const { d } = world();
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "고쳐", resume_run_id: 1, reason: "숫자 불일치" }, u, { source: "app-ui" }, d); await settle();
  assert.deepEqual((await getRunFor(2, u, d)).resume, { of: 1, root: 1, depth: 1, reason: "숫자 불일치" });
  assert.equal((await getRunFor(1, u, d)).resume, null);
  assert.deepEqual((await getRunFor(2, admin("root"), d)).resume, { of: 1, root: 1, depth: 1 }, "관리자는 까닭을 못 본다");
  ok("R12 하나 보기 — resume 줄 · 까닭은 보낸 사람만");
}

// ── R13 롤 창 — 이어받기 칸이 아직 없으면 503(다시 보내라) · 작업을 띄우지 않는다 · 새 질문은 그대로 돈다 ──
{
  const { w, d } = world({ resumeCols42703: true });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d), 503, /이어받기를 받을 준비가 아직 안 됐습니다/);
  assert.equal(w.runs.size, 1); assert.equal(w.llm.length, 1);
  await submitRun({ prompt: "새 질문" }, u, { source: "app-ui" }, d); await settle();
  assert.equal(w.runs.size, 2, "새 질문은 칸 없이 된다");
  ok("R13 롤 창 — 이어받기만 503 · 새 질문은 그대로");
}

// ── R14 상한은 이어받기에도 — 사람당 동시 ──
{
  const { w, d } = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_running_per_member: 1 } });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  d.singleShot = () => new Promise(() => undefined);
  await submitRun({ prompt: "딴 일" }, u, { source: "app-ui" }, d);
  await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d), 429, /이미 1개 돌고 있습니다/);
  assert.equal(w.runs.size, 2);
  ok("R14 이어받기도 상한(사람당 동시 429)");
}

// ── R15 다른 자리 — 앱 화면에서 시작한 대화를 앱 서버가 · 앱 서버가 시작한 대화를 앱 화면이 이으면 409(대화가 돈 자리 · 홈이 달라진다) ──
{
  const { w, d } = world();
  const ui = appUser("alice", "crm"), srv = member("alice", { appId: "crm", appServer: true });
  await submitRun({ prompt: "화면 질문" }, ui, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "서버 질문", agent: true }, srv, { source: "rest" }, d);
  doneJob(w, 101, C1); w.jobTranscripts.add(101);
  await syncRun(w.runs.get(2)!, d);
  await fails(submitRun({ prompt: "x", resume_run_id: 1 }, srv, { source: "rest" }, d), 409, /앱 화면에서 시작한 대화는 앱 화면에서/, "resume_not_resumable");
  await fails(submitRun({ prompt: "x", resume_run_id: 2 }, ui, { source: "app-ui" }, d), 409, /앱 서버가 시작한 대화는 앱 서버에서만/, "resume_not_resumable");
  assert.equal(w.runs.size, 2); assert.equal(w.submitted.length, 1, "홈 없는 대화를 사람 홈에서 띄우지 않는다");
  const same = await submitRun({ prompt: "x", resume_run_id: 2 }, srv, { source: "rest" }, d);
  assert.equal(w.submitted[1]!.homeless, true, "같은 자리면 그 자리 그대로"); assert.equal((same.resume as { of: number }).of, 2);
  ok("R15 다른 자리 409 — 화면 ↔ 서버 · 같은 자리는 받는다");
}

// ── R16 띄우지도 못한 시도는 한 질문당 몫을 깎지 않는다 — 대기열이 차 세 번 429 뒤에도(상한 3) 이어받는다 ──
{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null, policy: { ...DEFAULT_AI_RUN_POLICY, max_resumes: 3 } });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d);
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  w.submitThrows = new HttpError(429, "작업 대기열이 찼습니다");
  for (let i = 0; i < 3; i++) await fails(submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d), 429, /대기열이 찼습니다/);
  assert.equal(w.runs.size, 4, "실패한 시도도 기록은 남는다(failed)"); assert.ok([2, 3, 4].every((id) => w.runs.get(id)!.status === "failed"));
  w.submitThrows = undefined;
  const r = await submitRun({ prompt: "고쳐", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal((r.resume as { of: number }).of, 1, "상한(3)에 걸리지 않고 받는다 — 앞 세 시도는 돌지 않았다");
  ok("R16 띄우지 못한 시도(작업 행 없이 실패)는 세지 않는다 — 429 세 번 뒤에도 상한 안");
}

// ── R17 끝은 넣는 순간에 막는다 — 미리 보기 셈이 낡아도(동시에 보낸 다른 시도가 그 사이 들어감) 상한을 넘지 않는다 ──
{
  const { w, d } = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_resumes: 1 } });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "첫 이어받기", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();
  d.store.resumeCountOfRoot = async () => 0;   // 미리 보기가 낡았다(그 사이 다른 요청이 넣음)
  await fails(submitRun({ prompt: "둘째", resume_run_id: 1 }, u, { source: "app-ui" }, d), 409, /이미 1번 이어받았습니다/, "resume_limit");
  assert.equal(w.runs.size, 2, "넣지 않는다");
  ok("R17 넣는 순간의 셈이 끝을 막는다(미리 보기가 낡아도)");
}

// ── R18 상한에 닿은 질문은 다른 거절보다 먼저 resume_limit — 이어받은 실행(2)을 또 이어도 그 질문(1)으로 센다 · 키가 빠진 뒤에도 같은 까닭 ──
//  앱이 «다시 묻기를 그만» 을 늘 같은 코드로 알아본다(그 사이 키 · 설정이 바뀌어 다른 409 로 갈리지 않게).
{
  const { w, d } = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_resumes: 1 } });
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "Q" }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "첫 이어받기", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();
  w.key = null;
  await fails(submitRun({ prompt: "둘째", resume_run_id: 2 }, u, { source: "app-ui" }, d), 409, /이미 1번 이어받았습니다/, "resume_limit");
  assert.equal(w.runs.size, 2); assert.equal(w.llm.length, 2);
  ok("R18 상한은 다른 거절보다 먼저 — 이어받은 실행을 또 이어도 처음 질문으로 센다(키가 빠져도 resume_limit)");
}

// ── #5082 앱 판 지시(ai.instructions) — 엣지 표 G · S1~S8 ──
//  가짜 지시 읽기: 작업 이름 summarize 만 지시를 선언(«판 지시»). missing 이면 409(그 판에 파일 없음)를 던진다. 부른 것(앱 · 판을 고르는 사람 · 작업)을 적는다.
type Asked = { app: string; who: Viewer; job: string };
function withInstructions(d: AiRunDeps, o: { missing?: boolean } = {}): Asked[] {
  const asked: Asked[] = [];
  d.instructions = async (app, who, job) => {
    asked.push({ app: app.id, who, job });
    if (job !== "summarize") return null;
    if (o.missing) throw new HttpError(409, "작업 'summarize' 의 앱 지시 파일(ai/s.md)을 그 판에서 찾지 못했습니다");
    return "판 지시";
  };
  return asked;
}

{
  assert.equal(composeSystem(null, null), null);
  assert.equal(composeSystem(null, "판 지시"), "판 지시");
  assert.equal(composeSystem("앱 system", null), "앱 system");
  assert.equal(composeSystem("앱 system", "판 지시"), "앱 system\n\n판 지시", "부른 쪽 system 이 앞 · 앱 판 지시가 뒤(나중 글)");
  assert.equal(composeSystem("앱 system", "  "), "앱 system", "빈 지시는 싣지 않는다");
  ok("G 단발 시스템 지시 합치기 — 부른 쪽 system(앞) + 앱 판 지시(뒤)");
}

{
  const { w, d } = world();
  const asked = withInstructions(d);
  await submitRun({ prompt: "요약해", job: "summarize", system: "앱 system" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  assert.equal(w.runs.get(1)!.status, "done");
  assert.equal(w.llm[0]!.system, "앱 system\n\n판 지시", "단발 호출의 system 에 앱 판 지시가 실린다(뒤)");
  assert.equal(w.runs.get(1)!.system_prompt, "앱 system", "행에는 부른 쪽 system 만");
  assert.equal(asked.length, 1, "접수 때 한 번만 읽는다(돌 때 다시 고르지 않는다)");
  assert.deepEqual(asked[0], { app: "crm", who: { userId: "alice", scopes: ["context"] }, job: "summarize" }, "부른 사람의 판(주소 없음 · 그 토큰의 권한)");
  ok("S2 단발 — 접수 때 읽은 앱 판 지시를 시스템 지시로(부른 쪽 system 은 앞)");
}

{
  const { w, d } = world();
  const asked = withInstructions(d);
  await submitRun({ prompt: "요약해", system: "앱 system" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, d);
  await settle();
  assert.equal(w.llm[0]!.system, "앱 system", "작업 이름이 없으면 종전 그대로");
  assert.equal(w.submitted[0]!.appInstructions, null, "작업 이름 없는 에이전트 작업도 지시 없음");
  assert.equal(asked.length, 0, "작업 이름 없는 실행은 판을 읽지 않는다");
  ok("S2b 작업 이름이 없는 실행 — 앱 판 지시 없음 · 읽지도 않음(종전 그대로)");
}

{
  const { w, d } = world();
  withInstructions(d, { missing: true });
  await fails(submitRun({ prompt: "요약해", job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d), 409, /앱 지시 파일/);
  assert.equal(w.runs.size, 0, "행을 만들지 않는다");
  assert.equal(w.llm.length + w.submitted.length, 0, "LLM · 작업 컨테이너 모두 부르지 않는다");
  ok("S1 접수 — 선언한 지시 파일을 그 판에서 못 읽으면 409 · 행 없음");
}

{
  const { w, d } = world({ policy: { ...DEFAULT_AI_RUN_POLICY, max_running_per_member: 0 } });
  const asked = withInstructions(d, { missing: true });
  await fails(submitRun({ prompt: "요약해", job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d), 429, /돌고 있습니다/);
  assert.equal(asked.length, 0, "한도로 돌려보낼 요청은 판을 읽지 않는다(409 보다 429 가 먼저)");
  assert.equal(w.runs.size, 0);
  ok("S3 한도(429)를 먼저 본다 — 돌려보낼 요청은 판 행을 읽지 않는다");
}

{
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  withInstructions(d);
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(w.submitted.length, 1, "작업 컨테이너로 보냈다");
  assert.equal(w.submitted[0]!.appInstructions, "판 지시", "작업 행에 앱 판 지시를 함께 적는다(판이 뜰 때 실행 행을 찾지 않는다)");
  assert.ok(!w.submitted[0]!.prompt.includes("판 지시"), "앱 판 지시는 사용자 말(프롬프트)에 섞지 않는다");
  ok("S4 에이전트 작업 — 접수 때 읽은 앱 판 지시를 작업 행에 싣는다");
}

{
  //  B1 — 앱 주소 · 앱 서버로 들어온 호출은 그 주소의 판(표 · 도구와 같은 viewerOf). 초안을 고친 사람도 공개 주소면 공개 판의 지시.
  const { d } = world();
  const asked = withInstructions(d);
  await submitRun({ prompt: "x", job: "summarize" }, { ...appUser("alice", "crm"), appAddress: "pub" } as LivelyUser, { source: "app-front" }, d);
  await submitRun({ prompt: "x", job: "summarize" }, { ...appUser("alice", "crm"), appServer: true, appAddress: "draft" } as LivelyUser, { source: "app-server" }, d);
  await settle();
  assert.deepEqual(asked.map((a) => a.who), [{ userId: "alice", scopes: ["context"], address: "pub" }, { userId: "alice", scopes: ["context"], address: "draft" }]);
  ok("S5 앱 주소 · 앱 서버 — 그 주소의 판으로 고른다(격리 리뷰 B1)");
}

{
  //  N7 — 형식 재시도는 원래 작업 행에 실린 지시를 그대로 싣는다(지금 판으로 다시 고르지 않는다).
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  const asked = withInstructions(d);
  const fromJob: number[] = [];
  d.jobInstructions = async (id) => { fromJob.push(id); return id === 101 ? "원래 작업의 판 지시" : null; };
  await submitRun({ prompt: "요약", job: "summarize", agent: true, schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  const j1 = w.jobs.get(101)!; j1.status = "done"; j1.conversation_id = "conv-1"; j1.result = { text: "형식 밖 글" };
  const mid = (await syncRun(w.runs.get(1)!, d))!;
  assert.equal(mid.retries, 1, "재시도가 나갔다(관측 장치 확인)");
  assert.deepEqual(fromJob, [101], "원래 작업 행에서 읽었다");
  assert.equal(w.submitted[1]!.appInstructions, "원래 작업의 판 지시");
  assert.equal(asked.length, 1, "재시도는 판을 다시 고르지 않는다");
  ok("S6 형식 재시도 — 원래 작업 행의 앱 판 지시를 그대로");
}

{
  //  롤 창 — 작업 행에 지시 칸이 아직 없으면(42703) 503(다시 보내라) · 실행은 실패로 끝낸다. 지시 없는 실행은 그대로 받는다.
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  withInstructions(d);
  w.submitThrows = Object.assign(new HttpError(500, "column \"app_instructions\" does not exist"), { code: "42703" });
  await fails(submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d), 503, /배포 중/);
  assert.equal(w.runs.get(1)!.status, "failed");
  assert.match(w.runs.get(1)!.error ?? "", /배포 중/, "실행 행에도 그 까닭(DB 원문이 아니라)");
  assert.ok(!/does not exist/.test(w.runs.get(1)!.error ?? ""), w.runs.get(1)!.error ?? "");
  await fails(submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, d), 500, /does not exist/);
  ok("S7 롤 창 — 지시를 실은 작업만 503(다시 보내라) · 지시 없는 실행의 다른 실패는 그대로");
}

{
  //  지시 읽기를 배선하지 않은 배포(시험 · 옛 배선)는 앱 판 지시를 쓰지 않는다.
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.appInstructions, null);
  ok("S8 지시 읽기가 없으면 지시 없음");
}

// ── R19 · R20 이어받기 × 앱 판 지시(#5101 × #5082) ──
//  이게 틀리면: 이어받은 작업이 앱 지시 없이 돌거나(--resume 은 시스템 지시를 대화에서 되살리지 않는다 — 판이 매번 싣는다), 같은 대화가 중간에 다른 판의 지시로 바뀐다.
{
  //  R19 이어받는 작업 — 앞 작업 행에 실린 지시 그대로(형식 재시도 S6 과 같다) · 지금 판은 다시 읽지 않는다.
  const { w, d } = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  const asked = withInstructions(d);
  const fromJob: number[] = [];
  d.jobInstructions = async (id) => { fromJob.push(id); return id === 101 ? "앞 작업의 판 지시" : null; };
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "요약", job: "summarize", agent: true }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.appInstructions, "판 지시", "새 질문은 지금 판에서 읽는다");
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  await submitRun({ prompt: "근거가 틀렸다 — 다시", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[1]!.resumeJobId, 101, "앞 작업의 대화를 잇는다(관측 장치 확인)");
  assert.equal(w.submitted[1]!.appInstructions, "앞 작업의 판 지시", "앞 작업 행의 글 그대로");
  assert.deepEqual(fromJob, [101]);
  assert.equal(asked.length, 1, "이어받는 작업은 판을 다시 읽지 않는다");
  ok("R19 이어받는 작업 — 앞 작업에 실린 앱 판 지시 그대로(지금 판을 다시 읽지 않음)");
}
{
  //  R20 이어받는 단발 — 앞 실행은 지시를 남기지 않는다 → 지금 판에서 다시 읽는다(작업 이름은 앞 실행 것) · system = 앞 실행 system + 판 지시.
  const { w, d } = world({ llmReply: (_i, n) => okText(`답${n}`) });
  const asked = withInstructions(d);
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "요약해", job: "summarize", system: "앱 system" }, u, { source: "app-ui" }, d); await settle();
  await submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, d); await settle();
  assert.equal(w.runs.get(2)!.status, "done");
  assert.equal(w.llm[1]!.system, "앱 system\n\n판 지시", "앞 실행의 system 뒤에 지금 판의 지시");
  assert.deepEqual(w.llm[1]!.messages!.map((m) => m.content), ["요약해", "답1", "다시"], "앞 대화를 엮은 채로");
  assert.equal(asked.length, 2); assert.equal(asked[1]!.job, "summarize", "작업 이름은 앞 실행 것");
  ok("R20 이어받는 단발 — 지금 판의 앱 판 지시를 다시 읽어 앞 system 뒤에(작업 이름은 앞 실행 것)");
}

// ══ 앱 AI 작업의 «라이블리 MCP 만»(매니페스트 ai.mcp_only) — 접수(사양 S4 · S6 · S9~S16 · S12b · S13b) ══
//  가짜 판 읽기: on 에 든 작업 이름만 «MCP 만» — on 을 바꾸면 «그 사이 판이 바뀜». 부른 것(앱 · 판을 고르는 사람 · 작업)을 적는다.
//  가짜 작업 행 읽기: 접수된 차례(101, 102 …)대로 그 작업에 실린 값.
//  이게 틀리면: 선언한 작업이 내장 도구를 연 채 돌거나, 이어받기가 «MCP 만» 대화를 연 도구로 잇거나, 값을 모른 채 작업을 넣는다.
type McpAsked = { app: string; who: Viewer; job: string };
function withMcpOnly(d: AiRunDeps, names: string[] = ["summarize"]): { asked: McpAsked[]; on: Set<string> } {
  const asked: McpAsked[] = [];
  const on = new Set(names);
  d.mcpOnly = async (a, who, job) => { asked.push({ app: a.id, who, job }); return on.has(job); };
  return { asked, on };
}
function withJobMcpOnly(w: World, d: AiRunDeps): number[] {
  const read: number[] = [];
  d.jobMcpOnly = async (id) => { read.push(id); return w.submitted[id - 101]?.mcpOnly === true; };
  return read;
}
//  한 사람이 여러 실행을 열어 둔다(기본 동시 상한 2).
const ROOMY = (): Partial<World> => ({ policy: { ...DEFAULT_AI_RUN_POLICY, max_running_per_member: 20 } });
const SUB = (): Partial<World> => ({ ...ROOMY(), settings: { default: { kind: "subscription", member: "alice" } }, key: null });

{
  const { w, d } = world(ROOMY());
  const m = withMcpOnly(d);
  const u = appUser("alice", "crm");
  const r = await submitRun({ prompt: "조사해", agent: true, job: "summarize" }, u, { source: "app-ui" }, d);
  assert.equal(r.executor, "job");
  assert.equal(w.submitted[0]!.mcpOnly, true, "부른 사람의 판에서 그 작업이 «MCP 만»");
  assert.deepEqual(m.asked.map((a) => [a.app, a.job, a.who.userId]), [["crm", "summarize", "alice"]]);
  m.on.clear();
  await submitRun({ prompt: "조사해", agent: true, job: "summarize" }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[1]!.mcpOnly, false, "그 판의 목록에 없으면 false");
  m.on.add("summarize");
  await submitRun({ prompt: "조사해", agent: true }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[2]!.mcpOnly, false, "작업 이름이 없으면 false");
  assert.equal(m.asked.length, 2, "작업 이름이 없는 실행은 판을 읽지 않는다");
  ok("mcp_only S10 에이전트 실행 — 작업 이름이 부른 사람의 판에서 ai.mcp_only 에 있으면 «MCP 만» = true · 없으면 false · 작업 이름이 없으면 false(판을 읽지 않음)");
}

{
  //  앱 주소 · 앱 서버로 들어온 호출은 그 주소의 판 — 앱 판 지시와 같은 사람 · 같은 주소로 고른다.
  const { w, d } = world(ROOMY());
  const m = withMcpOnly(d);
  const instr = withInstructions(d);
  const alice = appUser("alice", "crm");
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, alice, { source: "app-ui" }, d);
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, { ...alice, appAddress: "pub" } as LivelyUser, { source: "app-front" }, d);
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, { ...alice, appServer: true, appAddress: "draft" } as LivelyUser, { source: "app-server" }, d);
  assert.deepEqual(m.asked.map((a) => [a.app, a.who.userId, a.who.address ?? null]), [["crm", "alice", null], ["crm", "alice", "pub"], ["crm", "alice", "draft"]]);
  const viewer = (v: Viewer) => [v.userId, [...(v.scopes ?? [])], v.address ?? null];
  assert.deepEqual(m.asked.map((a) => viewer(a.who)), instr.map((a) => viewer(a.who)), "앱 판 지시와 같은 판을 고른다");
  assert.deepEqual(w.submitted.map((j) => j.mcpOnly), [true, true, true]);
  ok("mcp_only S4 부른 사람의 판 — 앱 판 지시와 같은 사람 · 같은 주소(주소 없음 · 공개 주소 · 앱 서버의 초안 주소)로 고른다");
}

{
  const { w, d } = world(SUB());
  d.mcpOnly = async () => { throw new HttpError(404, "앱을 찾을 수 없습니다"); };
  await fails(submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d), 404);
  assert.equal(w.submitted.length, 0, "값을 모른 채 작업을 보내지 않는다");
  ok("mcp_only S6 부른 사람이 앱을 볼 수 없으면(판 읽기 404) 접수하지 않는다");
}

{
  const { w, d } = world(SUB());
  const m = withMcpOnly(d);
  await submitRun({ prompt: "조사해", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  w.jobs.get(101)!.status = "running";
  assert.equal((await syncRun(w.runs.get(1)!, d))!.status, "running");
  doneJob(w, 101, C1);
  assert.equal((await syncRun((await d.store.getAiRun(1))!, d))!.status, "done");
  assert.equal(w.submitted[0]!.mcpOnly, true);
  assert.equal(m.asked.length, 1, "도는 동안 · 끝날 때 다시 고르지 않는다");
  ok("mcp_only S11 값은 접수 때 한 번 읽는다");
}

{
  const { w, d } = world(SUB());
  withMcpOnly(d);
  withJobMcpOnly(w, d);
  await submitRun({ prompt: "요약", job: "summarize", schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.bare, true, "단발 + 구독 → 작업 컨테이너(관측 장치)");
  assert.equal(w.submitted[0]!.mcpOnly, false, "단발은 원래 도구가 없다");
  doneJob(w, 101, C1, "형식 밖 글");
  assert.equal((await syncRun(w.runs.get(1)!, d))!.retries, 1, "형식 재시도가 나갔다(관측 장치)");
  assert.equal(w.submitted[1]!.bare, true);
  assert.equal(w.submitted[1]!.mcpOnly, false, "단발의 형식 재시도도");
  ok("mcp_only S9 단발 실행은 작업 이름이 «MCP 만» 이어도 작업 접수 값 false(형식 재시도도)");
}

{
  //  (가) 앞 작업이 «MCP 만» — 그 사이 판이 목록에서 뺐어도 true(같은 대화를 연 도구로 잇지 않는다).
  const { w, d } = world(SUB());
  const m = withMcpOnly(d);
  const read = withJobMcpOnly(w, d);
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사해", job: "summarize", agent: true }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.mcpOnly, true);
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  m.on.clear();
  await submitRun({ prompt: "근거가 틀렸다 — 다시", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[1]!.resumeJobId, 101, "앞 작업의 대화를 잇는다(관측 장치)");
  assert.equal(w.submitted[1]!.mcpOnly, true, `앞 작업 값이 true 면 true — 읽은 작업: ${JSON.stringify(read)}`);
  ok("mcp_only S12(가) 이어받는 에이전트 작업 — 앞 작업이 «MCP 만» 이면 지금 판이 뺐어도 «MCP 만»");
}

{
  //  (나) 앞 작업은 «MCP 만» 이 아니었는데 그 사이 앱이 선언했다 — 앞 실행의 작업 이름이 지금 부른 사람의 판의 목록에 있으면 true.
  const { w, d } = world(SUB());
  const m = withMcpOnly(d, []);
  withJobMcpOnly(w, d);
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사해", job: "summarize", agent: true }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.mcpOnly, false);
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  m.on.add("summarize");
  await submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[1]!.resumeJobId, 101, "앞 작업의 대화를 잇는다(관측 장치)");
  assert.equal(w.submitted[1]!.mcpOnly, true, "앱이 나중에 선언했어도 열린 채 잇지 않는다");
  const last = m.asked.at(-1)!;
  assert.deepEqual([last.app, last.job, last.who.userId], ["crm", "summarize", "alice"], "앞 실행의 작업 이름을 지금 부른 사람의 판에서 본다");
  //  둘 다 아니면 false — 앞 작업 false · 지금 판에도 없다.
  const n = world(SUB());
  withMcpOnly(n.d, []);
  withJobMcpOnly(n.w, n.d);
  await submitRun({ prompt: "조사해", job: "summarize", agent: true }, u, { source: "app-ui" }, n.d);
  doneJob(n.w, 101, C1);
  await syncRun(n.w.runs.get(1)!, n.d);
  await submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, n.d);
  assert.equal(n.w.submitted[1]!.resumeJobId, 101);
  assert.equal(n.w.submitted[1]!.mcpOnly, false, "둘 다 아니면 false");
  ok("mcp_only S12(나) 이어받는 에이전트 작업 — 앞 작업이 아니어도 앞 실행의 작업 이름이 지금 판의 목록에 있으면 «MCP 만» · 둘 다 아니면 false");
}

{
  //  앞 실행에 작업 이름이 없으면 (나)는 없다 — 무엇을 물어도 «MCP 만» 인 판이어도 false.
  const { w, d } = world(SUB());
  let asked = 0;
  d.mcpOnly = async () => { asked++; return true; };
  withJobMcpOnly(w, d);
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사해", agent: true }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[0]!.mcpOnly, false, "작업 이름이 없는 실행(관측 장치)");
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  await submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, d);
  assert.equal(w.submitted[1]!.resumeJobId, 101);
  assert.equal(w.submitted[1]!.mcpOnly, false);
  assert.equal(asked, 0, "S10 작업 이름이 없는 실행은 판을 읽지 않는다");
  ok("mcp_only S12 앞 실행에 작업 이름이 없으면 (나)는 없다 — 앞 작업 값(false) 그대로 · 판을 읽지 않음");
}

{
  //  앞 작업의 값을 못 읽으면 값을 모른 채 넣지 않는다. 지금 판은 목록에서 뺐다 — 앞 작업 값을 읽어야만 정해지는 자리.
  const { w, d } = world(SUB());
  const m = withMcpOnly(d);
  const u = appUser("alice", "crm");
  await submitRun({ prompt: "조사해", job: "summarize", agent: true }, u, { source: "app-ui" }, d);
  doneJob(w, 101, C1);
  await syncRun(w.runs.get(1)!, d);
  m.on.clear();
  d.jobMcpOnly = async () => { throw new Error("작업 행의 «MCP 만» 칸을 읽지 못했습니다(가짜)"); };
  await assert.rejects(submitRun({ prompt: "다시", resume_run_id: 1 }, u, { source: "app-ui" }, d));
  assert.equal(w.runs.size, 1, "실행 행을 만들지 않는다");
  assert.equal(w.submitted.length, 1, "작업을 보내지 않는다");
  ok("mcp_only S12b 이어받기에서 앞 작업의 값을 못 읽으면 접수 실패 — 실행 행 · 작업 없음");
}

{
  //  원래 작업 true · 그 사이 판이 뺐다 → 재시도도 true.
  const { w, d } = world(SUB());
  const m = withMcpOnly(d);
  const read = withJobMcpOnly(w, d);
  await submitRun({ prompt: "요약", job: "summarize", agent: true, schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  m.on.clear();
  doneJob(w, 101, C1, "형식 밖 글");
  assert.equal((await syncRun(w.runs.get(1)!, d))!.retries, 1, "형식 재시도가 나갔다(관측 장치)");
  assert.equal(w.submitted[1]!.resumeJobId, 101);
  assert.equal(w.submitted[1]!.mcpOnly, true, `원래 작업에 실린 값 그대로 — 읽은 작업: ${JSON.stringify(read)}`);
  //  원래 작업 false · 그 사이 판이 선언했다 → 재시도도 false(재시도는 원래 작업 값 그대로).
  const r = world(SUB());
  const rm = withMcpOnly(r.d, []);
  withJobMcpOnly(r.w, r.d);
  await submitRun({ prompt: "요약", job: "summarize", agent: true, schema }, appUser("alice", "crm"), { source: "app-ui" }, r.d);
  rm.on.add("summarize");
  doneJob(r.w, 101, C1, "형식 밖 글");
  await syncRun(r.w.runs.get(1)!, r.d);
  assert.equal(r.w.submitted.length, 2, "형식 재시도가 나갔다(관측 장치)");
  assert.equal(r.w.submitted[1]!.mcpOnly, false, "지금 판이 «MCP 만» 이어도 원래 작업 값");
  ok("mcp_only S13 형식 재시도 — 원래 작업에 실린 «MCP 만» 값 그대로(양방향)");
}

{
  const { w, d } = world(SUB());
  withMcpOnly(d);
  await submitRun({ prompt: "요약", job: "summarize", agent: true, schema }, appUser("alice", "crm"), { source: "app-ui" }, d);
  d.jobMcpOnly = async () => { throw new Error("작업 행의 «MCP 만» 칸을 읽지 못했습니다(가짜)"); };
  doneJob(w, 101, C1, "형식 밖 글");
  await syncRun(w.runs.get(1)!, d).catch(() => undefined);   // 끝 상태만 본다(동기화가 알리는 길은 사양 밖)
  const row = (await d.store.getAiRun(1))!;
  assert.equal(w.submitted.length, 1, "재시도 작업을 보내지 않는다");
  assert.equal(row.status, "failed", "재시도 없이 실패로 끝난다");
  assert.equal((row.result as { text?: string } | null)?.text, "형식 밖 글", "원문은 결과에 남는다");
  ok("mcp_only S13b 형식 재시도 때 원래 작업의 값을 못 읽으면 재시도를 보내지 않고 실패(원문은 결과에)");
}

{
  //  롤 창 — 새 게이트웨이가 마이그레이션보다 먼저 받는 동안 작업 행에 칸이 아직 없다(42703). 까닭 글은 무엇이 실려 기다려야 하는지 밝힌다.
  const caught = async (p: Promise<unknown>): Promise<HttpError> => {
    try { await p; } catch (e) { assert.ok(e instanceof HttpError, `HttpError 를 기대 — ${String(e)}`); return e; }
    return assert.fail("거절되지 않았다");
  };
  const roll = (): HttpError => Object.assign(new HttpError(500, 'column "mcp_only" of relation "agent_job" does not exist'), { code: "42703" });
  const cases: Array<{ what: string; mcp: boolean; instr: boolean; has: RegExp[]; not: RegExp[] }> = [
    { what: "«MCP 만» 만", mcp: true, instr: false, has: [/도구 제한/], not: [/앱 지시/] },
    { what: "앱 판 지시만", mcp: false, instr: true, has: [/앱 지시/], not: [/도구 제한/] },
    { what: "둘 다", mcp: true, instr: true, has: [/도구 제한/, /앱 지시/], not: [] },
  ];
  for (const c of cases) {
    const { w, d } = world(SUB());
    withMcpOnly(d, c.mcp ? ["summarize"] : []);
    if (c.instr) withInstructions(d);
    w.submitThrows = roll();
    const err = await caught(submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d));
    assert.equal(err.status, 503, `${c.what}: ${err.message}`);
    const row = w.runs.get(1)!;
    assert.equal(row.status, "failed", c.what);
    assert.match(row.error ?? "", /배포 중/, `${c.what} — 실행 행에는 DB 원문 대신 «배포 중» 까닭`);
    assert.doesNotMatch(row.error ?? "", /does not exist/, c.what);
    for (const re of c.has) {
      assert.match(err.message, re, `${c.what} — 503 이 무엇이 실렸는지 밝힌다`);
      assert.match(row.error ?? "", re, `${c.what} — 실행 행이 무엇이 실렸는지 밝힌다`);
    }
    for (const re of c.not) {
      assert.doesNotMatch(err.message, re, `${c.what} — 싣지 않은 것은 말하지 않는다(503)`);
      assert.doesNotMatch(row.error ?? "", re, `${c.what} — 싣지 않은 것은 말하지 않는다(실행 행)`);
    }
  }
  //  «MCP 만» 도 지시도 없는 작업 — 같은 실패라도 원래 오류 그대로 · «MCP 만» 작업이라도 없는 칸(42703)이 아닌 실패는 그대로.
  const { w, d } = world(SUB());
  const m = withMcpOnly(d, []);
  const u = appUser("alice", "crm");
  w.submitThrows = roll();
  await fails(submitRun({ prompt: "x", agent: true }, u, { source: "app-ui" }, d), 500, /does not exist/);
  await fails(submitRun({ prompt: "x", agent: true, job: "summarize" }, u, { source: "app-ui" }, d), 500, /does not exist/);
  m.on.add("summarize");
  w.submitThrows = new HttpError(429, "작업 대기열이 찼습니다");
  await fails(submitRun({ prompt: "x", agent: true, job: "summarize" }, u, { source: "app-ui" }, d), 429, /대기열/);
  ok("mcp_only S14 롤 창 — 실린 것이 있는 작업만 503 · 까닭 글이 «도구 제한» / «앱 지시» / 둘 다를 밝힌다 · 실행 행은 실패(배포 중) · 둘 다 없는 작업 · 다른 실패는 원래 오류");
}

{
  const base = { requester: "alice", accountKind: "api_key" as const, accountMember: null, appId: "crm", projectId: null, model: "m", label: "l",
    prompt: "p", timeoutMin: 5, bare: false, resumeJobId: 7, appInstructions: null, homeless: false, sharedSeat: false };
  const o = { cwd: "/work/apps/crm", resumeConversation: "conv-1", timeoutSec: 300 };
  assert.equal(agentJobOfRun({ ...base, mcpOnly: true }, o).mcpOnly, true, "빠지면 «MCP 만» 작업이 내장 도구를 연 채 돈다");
  assert.equal(agentJobOfRun({ ...base, mcpOnly: false }, o).mcpOnly, false);
  ok("mcp_only S15 작업 접수 → 작업 행이 «MCP 만» 값을 그대로 옮긴다");
}

{
  //  값을 읽는 자리 · 접수 입력의 «MCP 만» 값은 필수 — 배선이 빠진 고정값은 타입 검사가 막는다(빠진 배선이 조용히 «도구 열림» 이 되지 않게).
  const { w, d } = world(SUB());
  const needsDeps = (_: AiRunDeps): void => undefined;
  needsDeps(d);
  // @ts-expect-error 판 읽기(mcpOnly)가 빠졌다
  needsDeps({ ...d, mcpOnly: undefined });
  // @ts-expect-error 작업 행 읽기(jobMcpOnly)가 빠졌다
  needsDeps({ ...d, jobMcpOnly: undefined });
  //  고정값의 기본(false 를 돌려주는 자리) — 설치된 매니페스트가 선언했어도 값은 판 읽기가 정한다.
  d.getApp = async (id) => app(id, { ai: { jobs: [{ name: "summarize" }], mcp_only: ["summarize"] } });
  await submitRun({ prompt: "x", agent: true, job: "summarize" }, appUser("alice", "crm"), { source: "app-ui" }, d);
  assert.equal(w.submitted.length, 1, "작업을 보냈다(관측 장치)");
  assert.equal(w.submitted[0]!.mcpOnly, false);
  const needsJob = (_: SubmitJobInput): void => undefined;
  needsJob(w.submitted[0]!);
  // @ts-expect-error 접수 입력의 «MCP 만» 값도 필수다
  needsJob({ ...w.submitted[0]!, mcpOnly: undefined });
  ok("mcp_only S16 값을 읽는 자리 · 접수 입력의 «MCP 만» 값은 필수(빠지면 타입 검사) · false 를 돌려주는 자리면 false");
}

console.log(`ai-runs service.test: ${pass} passed`);

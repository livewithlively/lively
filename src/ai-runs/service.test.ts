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
import type { AiAccountSettings } from "./plan.js";
import { CONFIG_DIR_PLACEHOLDER, PROXY_BASE_IN_CONTAINER, agentJobOfRun, bootEnvForJob, cancelRunFor, getRunFor, listRunsFor, onForkTurn, submitRun, syncRun, targetsFor, type AiRunDeps, type ForkSessionFacts, type SubmitForkJobInput, type SubmitJobInput } from "./service.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await tick(); };

interface World {
  sessions: Record<string, { owner: string; members: string[]; human?: boolean }>;
  runs: Map<number, AiRunRow>; calls: NewLlmCall[]; jobs: Map<number, AgentJobRow>; submitted: SubmitJobInput[]; llm: SingleShotInput[]; canceled: number[];
  settings: AiAccountSettings; key: string | null; policy: AiRunPolicy; llmReply: (i: SingleShotInput, n: number) => SingleShotOutput; submitThrows?: HttpError;
  usedToday: number; inflightCount: number; notices: Array<{ sessionId: string; appId: string | null; runId: number | null; requester: string | null; text: string }>;
  forks: Record<string, Omit<ForkSessionFacts, "participant"> & { members?: string[] }>; forkConsent: "ok" | "undeclared" | "no_grant" | "regrant";
  /** 사람마다 다른 동의(없으면 forkConsent). */
  forkConsents: Record<string, "ok" | "undeclared" | "no_grant" | "regrant">; forkManaged: boolean; forkJobs: SubmitForkJobInput[];
  forkFactsCalls: Array<{ sid: string; transcript: boolean | undefined }>;
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
    llmReply: () => okText("답"), usedToday: 0, inflightCount: 0, notices: [], forks: {}, forkConsent: "ok", forkConsents: {}, forkManaged: true, forkJobs: [], forkFactsCalls: [], ...o,
  };
  const ended = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";
  const d: AiRunDeps = {
    store: {
      async insertAiRun(n: NewAiRun) {
        const id = ++seq;
        const row: AiRunRow = { id, status: n.status, app_id: n.appId, requester: n.requester, requester_kind: n.requesterKind, source: n.source, job_name: n.jobName, kind: n.kind,
          account_kind: n.accountKind, account_member: n.accountMember, executor: n.executor, job_id: null, model: n.model, label: n.label, prompt: n.prompt, system_prompt: n.systemPrompt,
          schema: n.schema, result: null, error: null, session_note: null, fork_session: n.forkSession ?? null, proxy_token_hash: null, retries: 0, input_tokens: null, output_tokens: null,
          created_at: new Date(), started_at: n.status === "running" ? new Date() : null, ended_at: null, updated_at: new Date() };
        w.runs.set(id, row); return { ...row };
      },
      async getAiRun(id) { const r = w.runs.get(id); return r ? { ...r } : null; },
      async getAiRunByToken(h) { const r = [...w.runs.values()].find((x) => x.proxy_token_hash === h && !ended(x.status)); return r ? { ...r } : null; },
      async getAiRunByJob(j) { const r = [...w.runs.values()].find((x) => x.job_id === j); return r ? { ...r } : null; },
      async setAiRunJob(id, jobId) { w.runs.get(id)!.job_id = jobId; },
      async setAiRunProxyToken(id, h) { w.runs.get(id)!.proxy_token_hash = h; },
      async markAiRunRunning(id) { const r = w.runs.get(id)!; if (r.status === "queued") { r.status = "running"; r.started_at = new Date(); } },
      async markAiRunRetried(id) { const r = w.runs.get(id)!; if (ended(r.status) || r.retries > 0) return false; r.retries++; return true; },
      async retryAiRun(id, jobId) { const r = w.runs.get(id)!; if (ended(r.status)) return false; r.job_id = jobId; r.retries++; return true; },
      async finishAiRun(id, f) {
        const r = w.runs.get(id)!; if (ended(r.status)) return null;
        Object.assign(r, { status: f.status, result: f.result, error: f.error, ended_at: new Date(), input_tokens: f.inputTokens ?? r.input_tokens, output_tokens: f.outputTokens ?? r.output_tokens, retries: f.retries ?? r.retries, session_note: f.sessionNote ?? r.session_note });
        //  끝맺기가 된 때만 알림(같은 문장 — store.finishAiRun 의 CTE 흉내)
        if (f.notice) w.notices.push({ sessionId: f.notice.sessionId, appId: f.notice.appId, runId: id, requester: f.notice.requester, text: f.notice.text });
        return { ...r };
      },
      async openJobRuns() { return [...w.runs.values()].filter((r) => !ended(r.status) && r.executor === "job"); },
      async staleProxyRuns() { return []; },
      async openRunCountOf(req) { return [...w.runs.values()].filter((r) => r.requester === req && !ended(r.status)).length; },
      async listAiRuns(f) { return [...w.runs.values()].filter((r) => (!f.appId || r.app_id === f.appId) && (!f.forkSession || r.fork_session === f.forkSession) && (!f.requester || r.requester === f.requester || (r.account_kind === "subscription" && r.account_member === f.requester))).map((r) => ({ ...r, prompt_preview: r.prompt.slice(0, 20), has_result: r.result !== null } as unknown as AiRunSummaryRow)); },
      async appConversations() { return []; },
      async insertLlmCall(c) { w.calls.push(c); },
      async tokensUsedTodayByApp() { return w.usedToday; },
    },
    policy: async () => w.policy,
    accountSettings: async () => w.settings,
    apiKey: async () => w.key,
    getApp: async (id) => app(id, { ai: { jobs: [{ name: "summarize" }] } }),
    assertAppUsable: async () => undefined,
    submitJob: async (j) => { if (w.submitThrows) throw w.submitThrows; w.submitted.push(j); const id = ++jseq; w.jobs.set(id, { id, status: "queued", model: j.model, project_id: j.projectId, timeout_sec: 600, conversation_id: null, result: null, error: null, homeless: j.homeless === true } as unknown as AgentJobRow); return { id }; },
    getJob: async (id) => w.jobs.get(id) ?? null,
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
    //  #4489 분기(가짜): w.forks[sid] = 세션 사실(없으면 «세션 없음») · 동의 w.forkConsent · 접수한 분기 작업은 w.forkJobs 에.
    forkSession: async (sid, member, _app, opts) => {
      w.forkFactsCalls.push({ sid, transcript: opts?.transcript });
      const f = w.forks[sid];
      if (!f) return { exists: false, owner: null, kind: null, harness: null, dir: null, nodeId: null, appAttached: false, participant: false, conversation: null, projectId: null, flags: {}, incognito: false };
      return { ...f, participant: f.owner === member || (f.members ?? []).includes(member) };
    },
    forkConsent: async (who) => w.forkConsents[who] ?? w.forkConsent,
    forkManaged: async () => w.forkManaged,
    blockConnectors: async () => false,
    submitForkJob: async (j) => { if (w.submitThrows) throw w.submitThrows; w.forkJobs.push(j); const id = ++jseq; w.jobs.set(id, { id, status: "queued", model: null, project_id: j.projectId, timeout_sec: 600, conversation_id: null, result: null, error: null, fork: j.spec } as unknown as AgentJobRow); return { id }; },
    isAdmin: (u) => (u.scopes ?? []).includes("admin"),
    isJobToken: async (prefix) => prefix === "jobtok",
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
  const mid = (await syncRun(w.runs.get(1)!, d))!;
  assert.equal(mid.retries, 1, "재시도가 나갔다(관측 장치 확인)");
  assert.equal(w.submitted[1]!.homeless, true, "재시도도 홈 없는 자리");
  assert.equal(w.submitted[1]!.resumeJobId, 101);
  ok("S5b 홈 없는 작업의 형식 재시도도 홈 없는 자리");
}

// ── S5c 작업 접수 → 작업 행(#4891) — 홈 없는 표시를 그대로 옮긴다(빠지면 앱 서버의 에이전트 작업이 사람 홈에서 돈다) ──
{
  const base = { requester: "alice", accountKind: "api_key" as const, accountMember: null, appId: "crm", projectId: null, model: "m", label: "l",
    prompt: "p", timeoutMin: 5, bare: false, resumeJobId: 7 };
  const o = { cwd: "/work/apps/crm", resumeConversation: "conv-1", timeoutSec: 300 };
  const homeless = agentJobOfRun({ ...base, homeless: true }, o);
  assert.deepEqual(homeless, {
    requester: "alice", accountKind: "api_key", accountMember: null, appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: "m", label: "l", prompt: "p", resumeConversation: "conv-1", resumeJobId: 7, timeoutSec: 300, bare: false, homeless: true,
  });
  assert.equal(agentJobOfRun({ ...base, homeless: false }, o).homeless, false);
  ok("S5c 작업 접수 → 작업 행이 홈 없는 표시를 그대로 옮긴다");
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
  ok("S22 판 환경 — 키 대신 프록시 주소 + 실행 토큰 + 빈 설정 폴더");
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

// ── F1~F15 #4489 붙은 세션 분기 — 접수 · 거절 · 끝맺기(결과 + 그 세션 알림) · 같은 프로세스 재요청 · 대상 ──
{
  const CONV = "11111111-2222-3333-4444-555555555555";
  type Fork = World["forks"][string];
  const sess = (o: Partial<Fork> = {}): Fork => ({
    exists: true, owner: "alice", kind: "human", harness: "claude", dir: "/work/proj", nodeId: null, appAttached: true, conversation: CONV, incognito: false,
    projectId: 7, flags: { "--model": "opus", "--effort": "high" }, members: ["bob"], ...o,
  });
  const forkWorld = (o: Partial<World> = {}) => world({ forks: { "box-alice": sess() }, ...o });
  const fork = { fork: "box-alice" };
  const inSess = { source: "app-ui", session: "box-alice" };

  //  F1 주인 — 워크스페이스 기본값이 API 키여도 분기는 그 세션 주인의 구독 · 그 세션 작업 폴더 · 본 세션 실행 설정 그대로
  {
    const { w, d } = forkWorld();
    const r = await submitRun({ prompt: "표를 읽고 답해", target: fork, label: "질문" }, appUser("alice", "crm"), inSess, d);
    assert.equal(r.status, "queued"); assert.equal(r.kind, "agent"); assert.equal(r.executor, "job"); assert.equal(r.fork_session, "box-alice");
    assert.deepEqual(r.account, { kind: "subscription", member: "alice" });
    assert.equal(w.forkJobs.length, 1); assert.equal(w.submitted.length, 0, "새 대화 작업은 없다");
    const j = w.forkJobs[0]!;
    assert.deepEqual({ owner: j.owner, requester: j.requester, appId: j.appId, cwd: j.cwd, projectId: j.projectId, label: j.label }, { owner: "alice", requester: "alice", appId: "crm", cwd: "/work/proj", projectId: 7, label: "질문" });
    assert.deepEqual(j.spec, { session: "box-alice", conversation: CONV, harness: "claude", model: "opus", effort: "high", block_connectors: false, app_folder: ".lively/apps/crm" });
    assert.equal(w.runs.get(1)!.source, "app-ui", "요청이 온 길을 실행 행에 남긴다(감사)");
    assert.match(j.prompt, /^\[라이블리 — 앱 분기 실행\]/); assert.ok(j.prompt.includes("[앱 요청]\n표를 읽고 답해"), j.prompt);
    assert.equal(w.runs.get(1)!.job_id, 101); assert.equal(w.runs.get(1)!.account_member, "alice");
    ok("F1 주인 → 그 세션 주인 구독 · 그 세션 폴더 · 본 세션 설정 그대로의 분기 작업");
  }
  //  F2 초대받은 bob — 보낸 사람 bob · 실행 계정과 자리는 주인 alice
  {
    const { w, d } = forkWorld();
    const r = await submitRun({ prompt: "x", target: fork }, appUser("bob", "crm"), inSess, d);
    assert.equal(r.requester, "bob"); assert.deepEqual(r.account, { kind: "subscription", member: "alice" });
    assert.equal(w.forkJobs[0]!.owner, "alice"); assert.equal(w.forkJobs[0]!.requester, "bob");
    assert.match(w.forkJobs[0]!.prompt, /bob님\(이 세션에 초대받은 사람\)/);
    ok("F2 초대받은 사람 → 보낸 사람 bob · 계정 · 자리는 주인");
    //  F2b — 주인이 이 앱의 «붙은 세션에서 실행» 에 동의하지 않았으면 bob 의 분기는 거절(주인 몰래 대화를 읽지 않는다) · 주인 자신은 제 동의만 본다
    const nc = forkWorld({ forkConsents: { alice: "no_grant", bob: "ok" } });
    await fails(submitRun({ prompt: "x", target: fork }, appUser("bob", "crm"), inSess, nc.d), 403, /세션 주인/, "consent_required");
    assert.equal(nc.w.runs.size, 0);
    const own = forkWorld({ forkConsents: { alice: "ok", bob: "no_grant" } });
    assert.equal((await submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, own.d)).status, "queued");
    ok("F2b 세션 주인의 동의가 없으면 초대받은 사람의 분기는 거절 · 주인은 제 동의로");
  }
  //  F3~F6 거절 — 행도 작업도 남지 않는다
  {
    const { w, d } = forkWorld({ forkConsent: "regrant" });
    await fails(submitRun({ prompt: "x", target: fork }, appUser("eve", "crm"), inSess, forkWorld().d), 403, /주인이나 그 세션에 초대받은/, "fork_unavailable");
    await fails(submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, d), 403, /다시 동의/, "consent_required");
    await fails(submitRun({ prompt: "x", target: fork }, { ...appUser("alice", "crm"), appServer: true }, { source: "web" }, forkWorld().d), 403, /사람이 보낸 요청/, "fork_unavailable");
    await fails(submitRun({ prompt: "x", target: { fork: "box-nope" } }, appUser("alice", "crm"), inSess, forkWorld().d), 404, /분기할 세션이 없습니다/);
    await fails(submitRun({ prompt: "x", target: fork, project_id: 3 }, appUser("alice", "crm"), inSess, forkWorld().d), 400, /project_id/);
    await fails(submitRun({ prompt: "x", target: fork, cwd: "/etc" }, appUser("alice", "crm"), inSess, forkWorld().d), 400, /cwd/);
    await fails(submitRun({ prompt: "x", target: { fork: "../x" } }, appUser("alice", "crm"), inSess, forkWorld().d), 400, /세션 id/);
    await fails(submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, forkWorld({ forks: { "box-alice": sess({ incognito: true }) } }).d), 409, /비공개/);
    assert.equal(w.runs.size, 0); assert.equal(w.forkJobs.length, 0);
    ok("F3~F6 남 · 옛 동의 · 앱 서버 · 없는 세션 · 폴더 지정 · 꼴 밖 대상 · 비공개 세션 → 거절(행 · 작업 0)");
  }
  //  F7 요청이 매인 세션 — 대상과 다르면 그 세션도 사람이 보는 세션이어야 한다(위탁 세션의 AI · 모르는 세션은 거절)
  {
    const sessions = { "box-task": { owner: "alice", members: [], human: false }, "box-alice2": { owner: "alice", members: [] } };
    const t = forkWorld({ sessions });
    await fails(submitRun({ prompt: "x", target: fork, app_id: "crm" }, member("alice"), { source: "mcp", session: "box-task" }, t.d), 403, /사람이 보는 세션이 아닙니다/, "account_unavailable");
    await fails(submitRun({ prompt: "x", target: fork, app_id: "crm" }, member("alice"), { source: "mcp", session: "box-unknown" }, t.d), 403, /확인할 수 없거나/);
    assert.equal(t.w.runs.size, 0);
    const okHuman = await submitRun({ prompt: "x", target: fork, app_id: "crm" }, member("alice"), { source: "mcp", session: "box-alice2" }, t.d);
    assert.equal(okHuman.status, "queued");
    const okNoSess = await submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), { source: "app-front" }, t.d);
    assert.equal(okNoSess.status, "queued");
    ok("F7 다른 세션에 매인 요청 — 위탁 · 모르는 세션은 거절 · 사람 세션 · 매임 없음은 받는다");
  }
  //  F8 상한 — 사람당 동시 실행에 분기도 센다 · F9 접수 실패 → 행 failed
  {
    const { w, d } = forkWorld({ policy: { ...DEFAULT_AI_RUN_POLICY, max_running_per_member: 1 } });
    await submitRun({ prompt: "a", target: fork }, appUser("alice", "crm"), inSess, d);
    await fails(submitRun({ prompt: "b", target: fork }, appUser("alice", "crm"), inSess, d), 429, /이미 1개/);
    assert.equal(w.forkJobs.length, 1);
    ok("F8 사람당 동시 상한에 분기도 센다");
    const bad = forkWorld({ submitThrows: new HttpError(429, "작업 대기열이 찼습니다") });
    await fails(submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, bad.d), 429, /대기열/);
    assert.equal(bad.w.runs.get(1)!.status, "failed"); assert.match(bad.w.runs.get(1)!.error!, /분기 작업을 보내지 못했습니다/);
    assert.equal(bad.w.notices.length, 0, "접수 실패는 세션 알림이 아니다(앱이 곧바로 오류를 받는다)");
    ok("F9 분기 작업 접수 실패 → 행 failed · 오류 그대로 · 알림 없음");
  }
  //  F10~F13 끝맺기 — 결과는 앱에 · 요지는 그 세션 알림에(한 번만) · 취소는 알리지 않는다
  {
    const { w, d } = forkWorld();
    await submitRun({ prompt: "3쪽 요약해 줘", target: fork }, appUser("bob", "crm"), inSess, d);
    const job = w.jobs.get(101)!;
    job.status = "done"; job.conversation_id = "fork-conv-x";
    job.result = { text: JSON.stringify({ result: "세 줄 요약", session_note: "bob 이 3쪽 요약을 물어 세 줄로 답함" }), usage: { input_tokens: 9, output_tokens: 3 }, turns: 1 };
    const stale = { ...w.runs.get(1)! };   // 정비와 걷기가 같은 열린 행을 읽고 겹쳐 끝맺는 경합 — 아래에서 이 낡은 행으로 한 번 더
    const done = (await syncRun(w.runs.get(1)!, d))!;
    assert.equal(done.status, "done"); assert.equal(done.session_note, "bob 이 3쪽 요약을 물어 세 줄로 답함");
    const res = done.result as Record<string, unknown>;
    assert.equal(res.text, "세 줄 요약"); assert.equal(res.conversation_id, null, "분기 대화는 저장되지 않는다 — 이어받기 id 를 주지 않는다"); assert.equal(res.turns, 1); assert.equal("json" in res, false);
    assert.equal(done.input_tokens, 9);
    assert.equal(w.notices.length, 1);
    assert.deepEqual({ ...w.notices[0], text: undefined }, { sessionId: "box-alice", appId: "crm", runId: 1, requester: "bob", text: undefined });
    assert.match(w.notices[0]!.text, /^앱 「crm」 요청\(실행 #1 · bob님이 보냄\) — 3쪽 요약해 줘 → bob 이 3쪽 요약을 물어 세 줄로 답함$/);
    assert.equal(stale.status, "queued");
    await syncRun(stale, d);
    assert.equal(w.notices.length, 1, "겹쳐 끝맺어도 알림은 한 줄(끝맺는 쓰기가 성공한 쪽만)");
    ok("F10 끝남 · 맞는 모양 → done(결과 · 메모) · 그 세션 알림 1줄 · 다시 맞춰도 1줄");

    const sch = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
    const s2 = forkWorld();
    await submitRun({ prompt: "n?", target: fork, schema: sch }, appUser("alice", "crm"), inSess, s2.d);
    const j2 = s2.w.jobs.get(101)!; j2.status = "done"; j2.result = { text: JSON.stringify({ result: { n: 3 }, session_note: "n 은 3" }) };
    const d2 = (await syncRun(s2.w.runs.get(1)!, s2.d))!;
    assert.deepEqual((d2.result as { json: unknown }).json, { n: 3 }); assert.equal((d2.result as { text: string }).text, '{"n":3}');
    ok("F10b 앱 스키마 → result.json · text 는 그 JSON");

    const s3 = forkWorld();
    await submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, s3.d);
    const j3 = s3.w.jobs.get(101)!; j3.status = "done"; j3.result = { text: "그냥 글", turns: 2 };
    const f3 = (await syncRun(s3.w.runs.get(1)!, s3.d))!;
    assert.equal(f3.status, "failed"); assert.match(f3.error!, /형식에 맞지 않습니다/); assert.equal((f3.result as { text: string }).text, "그냥 글");
    assert.equal(s3.w.forkJobs.length, 1, "새 작업으로 다시 하지 않는다(분기 대화는 이어받을 수 없다)"); assert.equal(s3.w.submitted.length, 0);
    assert.equal(s3.w.notices.length, 1); assert.match(s3.w.notices[0]!.text, /실패했습니다/);
    ok("F11 끝까지 모양이 틀림 → failed(원문) · 새 작업 없음 · 실패 알림");

    const s4 = forkWorld();
    await submitRun({ prompt: "a", target: fork }, appUser("alice", "crm"), inSess, s4.d);
    await submitRun({ prompt: "b", target: fork }, appUser("alice", "crm"), inSess, s4.d);
    s4.w.jobs.get(101)!.status = "timeout"; s4.w.jobs.get(101)!.error = "시간 초과";
    s4.w.jobs.get(102)!.status = "canceled"; s4.w.jobs.get(102)!.error = "취소했습니다";
    assert.equal((await syncRun(s4.w.runs.get(1)!, s4.d))!.status, "failed");
    assert.equal((await syncRun(s4.w.runs.get(2)!, s4.d))!.status, "canceled");
    assert.equal(s4.w.notices.length, 1, "취소는 알리지 않는다"); assert.match(s4.w.notices[0]!.text, /실패했습니다\(실행 #1\) — a: 시간 초과$/);
    ok("F12~F13 시간 초과 → failed + 실패 알림 · 취소 → canceled · 알림 없음");
  }
  //  F14 같은 프로세스 재요청 — 첫 턴이 틀리면 «형식에 맞게 다시» 한 번 · 맞으면 · 이미 썼으면 · 오류 턴이면 · 분기가 아니면 null
  {
    const { w, d } = forkWorld();
    await submitRun({ prompt: "x", target: fork }, appUser("alice", "crm"), inSess, d);
    assert.equal(await onForkTurn({ id: 101 }, { text: JSON.stringify({ result: "r", session_note: "n" }), is_error: false }, d), null);
    assert.equal(await onForkTurn({ id: 101 }, { text: "모양 틀린 답", is_error: true }, d), null);
    assert.equal(w.runs.get(1)!.retries, 0, "맞는 답 · 오류 턴은 재요청을 쓰지 않는다");
    const next = await onForkTurn({ id: 101 }, { text: "모양 틀린 답", is_error: false }, d);
    assert.ok(next && /형식/.test(next) && /session_note/.test(next), `재요청 글: ${next}`);
    assert.equal(w.runs.get(1)!.retries, 1);
    assert.equal(await onForkTurn({ id: 101 }, { text: "또 틀림", is_error: false }, d), null, "재요청은 한 번뿐");
    const plain = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
    await submitRun({ prompt: "x", agent: true }, appUser("alice", "crm"), { source: "app-ui" }, plain.d);
    assert.equal(await onForkTurn({ id: 101 }, { text: "틀림", is_error: false }, plain.d), null, "분기가 아닌 작업");
    assert.equal(await onForkTurn({ id: 999 }, { text: "틀림", is_error: false }, d), null, "모르는 작업");
    ok("F14 같은 프로세스 재요청 — 틀린 첫 턴만 한 번");
  }
  //  F15 대상 — 붙은 세션마다 분기 가부 · 배포 · 동의 · 목록 거르기
  {
    const { w, d } = forkWorld({ forks: { "box-alice": sess(), "box-codex": sess({ harness: "codex" }), "box-carol": sess({ owner: "carol", members: ["alice"] }) }, forkConsents: { carol: "no_grant" } });
    d.attachedSessions = async () => [{ session_id: "box-alice", title: "A", owner_is_you: true }, { session_id: "box-codex", title: "C", owner_is_you: true }, { session_id: "box-carol", title: "R", owner_is_you: false }];
    const t = await targetsFor(appUser("alice", "crm"), {}, d);
    const att = t.attached as Array<{ session_id: string; can_fork: boolean; fork_reason: string | null }>;
    assert.deepEqual(att.map((a) => [a.session_id, a.can_fork]), [["box-alice", true], ["box-codex", false], ["box-carol", false]]);
    assert.match(att[1]!.fork_reason!, /#4920/); assert.match(att[2]!.fork_reason!, /세션 주인/); assert.equal(t.fork, true);
    assert.ok(w.forkFactsCalls.length === 3 && w.forkFactsCalls.every((c) => c.transcript === false), "대상 목록은 대화 파일 확인(원격 stat)을 하지 않는다");
    w.forkManaged = false;
    assert.equal((await targetsFor(appUser("alice", "crm"), {}, d)).fork, false);
    ok("F15 대상 — 세션별 can_fork · 안 되는 까닭 · 배포가 안 되면 fork false");

    w.forkManaged = true;
    await submitRun({ prompt: "f", target: fork }, appUser("alice", "crm"), inSess, d);
    w.settings = { default: { kind: "subscription", member: "alice" } }; w.key = null;
    await submitRun({ prompt: "n" }, appUser("alice", "crm"), { source: "app-ui" }, d);
    const only = (await listRunsFor({ fork_session: "box-alice" }, appUser("alice", "crm"), d)).runs as Array<{ id: number; fork_session: string | null }>;
    assert.deepEqual(only.map((r) => [r.id, r.fork_session]), [[1, "box-alice"]]);
    await fails(listRunsFor({ fork_session: "../x" }, appUser("alice", "crm"), d), 400, /fork_session/);
    ok("F15b 목록 — fork_session 으로 그 세션 분기만 · 꼴이 틀리면 «전부» 가 아니라 400");
  }
}

console.log(`ai-runs service.test: ${pass} passed`);

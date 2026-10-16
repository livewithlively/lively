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
import { CONFIG_DIR_PLACEHOLDER, PROXY_BASE_IN_CONTAINER, bootEnvForJob, cancelRunFor, getRunFor, submitRun, syncRun, type AiRunDeps, type SubmitJobInput } from "./service.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await tick(); };

interface World {
  runs: Map<number, AiRunRow>; calls: NewLlmCall[]; jobs: Map<number, AgentJobRow>; submitted: SubmitJobInput[]; llm: SingleShotInput[]; canceled: number[];
  settings: AiAccountSettings; key: string | null; policy: AiRunPolicy; llmReply: (i: SingleShotInput, n: number) => SingleShotOutput; submitThrows?: HttpError;
  usedToday: number; inflightCount: number;
}
const member = (id: string, extra: Partial<LivelyUser> = {}): LivelyUser => ({ userId: id, email: `${id}@x`, scopes: ["context"], projects: ["*"], ...extra });
const appUser = (id: string, app: string): LivelyUser => member(id, { appId: app });
const admin = (id: string): LivelyUser => member(id, { scopes: ["admin"] });
const app = (id: string, manifest: Record<string, unknown> = {}): OrgApp => ({ id, title: id, manifest, status: "active", enabled: true } as unknown as OrgApp);
const okText = (text: string): SingleShotOutput => ({ ok: true, status: 200, text, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 }, model: "m", stopReason: "end_turn", error: null });

function world(o: Partial<World> = {}): { w: World; d: AiRunDeps } {
  let seq = 0, jseq = 100;
  const w: World = {
    runs: new Map(), calls: [], jobs: new Map(), submitted: [], llm: [], canceled: [], settings: {}, key: "sk-ws", policy: { ...DEFAULT_AI_RUN_POLICY },
    llmReply: () => okText("답"), usedToday: 0, inflightCount: 0, ...o,
  };
  const ended = (s: string): boolean => s === "done" || s === "failed" || s === "canceled";
  const d: AiRunDeps = {
    store: {
      async insertAiRun(n: NewAiRun) {
        const id = ++seq;
        const row: AiRunRow = { id, status: n.status, app_id: n.appId, requester: n.requester, requester_kind: n.requesterKind, source: n.source, job_name: n.jobName, kind: n.kind,
          account_kind: n.accountKind, account_member: n.accountMember, executor: n.executor, job_id: null, model: n.model, label: n.label, prompt: n.prompt, system_prompt: n.systemPrompt,
          schema: n.schema, result: null, error: null, session_note: null, proxy_token_hash: null, retries: 0, input_tokens: null, output_tokens: null,
          created_at: new Date(), started_at: n.status === "running" ? new Date() : null, ended_at: null, updated_at: new Date() };
        w.runs.set(id, row); return { ...row };
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
      async listAiRuns(f) { return [...w.runs.values()].filter((r) => (!f.appId || r.app_id === f.appId) && (!f.requester || r.requester === f.requester)).map((r) => ({ ...r, prompt_preview: r.prompt.slice(0, 20), has_result: r.result !== null } as unknown as AiRunSummaryRow)); },
      async appConversations() { return []; },
      async insertLlmCall(c) { w.calls.push(c); },
      async tokensUsedTodayByApp() { return w.usedToday; },
    },
    policy: async () => w.policy,
    accountSettings: async () => w.settings,
    apiKey: async () => w.key,
    getApp: async (id) => app(id, { ai: { jobs: [{ name: "summarize" }] } }),
    assertAppUsable: async () => undefined,
    submitJob: async (j) => { if (w.submitThrows) throw w.submitThrows; w.submitted.push(j); const id = ++jseq; w.jobs.set(id, { id, status: "queued", model: j.model, project_id: j.projectId, timeout_sec: 600, conversation_id: null, result: null, error: null } as unknown as AgentJobRow); return { id }; },
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

// ── S5~S7 실행 계정 거절 — 남의 구독 403 · 계정 없음 409 · 앱 서버 에이전트 501 · 행 안 남음 ──
{
  const sub = world({ settings: { default: { kind: "subscription", member: "alice" } }, key: null });
  await fails(submitRun({ prompt: "x" }, appUser("bob", "crm"), { source: "app-ui" }, sub.d), 403, /본인이 보낸/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "mcp" }, sub.d), 403, /앱 화면/, "account_unavailable");
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm", ), { source: "web" }, sub.d), 403);
  assert.equal(sub.w.runs.size, 0, "거절은 행을 안 남긴다");
  const none = world({ key: null });
  await fails(submitRun({ prompt: "x" }, appUser("alice", "crm"), { source: "app-ui" }, none.d), 409, /실행 계정이 없습니다/, "account_unavailable");
  const srv = world();
  await fails(submitRun({ prompt: "x", files: ["a.md"] }, appUser("alice", "crm", ) && { ...appUser("alice", "crm"), appServer: true }, { source: "web" }, srv.d), 501, /앱 서버/);
  assert.equal(srv.w.runs.size, 0);
  const srvOk = await submitRun({ prompt: "x" }, { ...appUser("alice", "crm"), appServer: true }, { source: "web" }, srv.d);
  assert.equal(srvOk.executor, "proxy"); assert.equal(srvOk.requester_kind, "app_server");
  ok("S5~S7 남의 구독 403 · 도구 직접 호출 403 · 계정 없음 409 · 앱 서버 에이전트 501 · 앱 서버 단발은 됨");
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

console.log(`ai-runs service.test: ${pass} passed`);

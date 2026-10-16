// 작업 컨테이너 흐름 — 가짜 저장소(메모리) · 가짜 브로커(띄우기·걷기 기록) · 가짜 토큰 · 가짜 시계로 **부작용**을 본다 (#4490).
//  (행의 상태 · 띄우기/걷기에 나간 호출 · 토큰 발급/폐기 · 뒤로 미룬 일). 행 번호(V·B·X)는 spec-4490-core.md 의 엣지 표다.
//  실 SQL(테넌트 잠금 안의 셈·청구)은 같은 판정(plan.planClaims)을 쓰므로 여기선 판정과 흐름의 배선을 본다.
import assert from "node:assert/strict";
import { HttpError } from "../http-error.js";
import type { LivelyUser } from "../context.js";
import {
  submitAgentJob, onBoot, onTick, onResult, sweepAgentJobs, cancelAgentJobFor, getAgentJobFor, listAgentJobsFor, canSeeJob,
  REAP_DELAY_MS, type AgentJobDeps,
} from "./service.js";
import { planClaims } from "./plan.js";
import { MCP_CONFIG_PLACEHOLDER, RUNNER_SOURCE } from "./runner.js";
import { hashJobSecret, secretMatches, type AgentJobRow, type NewAgentJob } from "./store.js";
import { DEFAULT_AGENT_JOB_POLICY, type AgentJobPolicy } from "../org/policies/agent-job-policy.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};
const httpErr = (status: number, re?: RegExp) => (e: unknown): boolean => {
  assert.ok(e instanceof HttpError, `HttpError 가 아니다: ${String(e)}`);
  assert.equal(e.status, status, `상태 ${e.status} ≠ ${status}: ${e.message}`);
  if (re) assert.match(e.message, re);
  return true;
};

// ── 가짜 세계 ─────────────────────────────────────────────────────────────────
interface World {
  deps: AgentJobDeps;
  rows: Map<number, AgentJobRow>;
  launched: Array<{ id: number; boot: string }>;
  killed: string[];
  minted: number[];
  revoked: string[];
  later: Array<{ fn: () => Promise<unknown>; ms: number }>;
  setNow(ms: number): void;
  failLaunch: boolean;
  available: boolean;
  policy: AgentJobPolicy;
  usable: Set<string>;     // `${member}:${app}` — 그 앱을 쓸 수 있다
  projects: Set<string>;   // `${member}:${project}` — 그 프로젝트 폴더에서 셸을 띄울 수 있다
  drain(maxMs?: number): Promise<void>;
}

function world(): World {
  const rows = new Map<number, AgentJobRow>();
  let seq = 0, now = 1_000_000_000_000, hex = 0;
  const w = {} as World;
  const ended = (s: string): boolean => ["done", "failed", "timeout", "canceled"].includes(s);
  const store: AgentJobDeps["store"] = {
    async insertAgentJob(j: NewAgentJob, p) {
      const queued = [...rows.values()].filter((r) => r.status === "queued").length;
      const running = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running").length;
      const room = p.max_queued > 0 ? queued < p.max_queued : running < p.max_running && queued === 0;
      if (!room) return { full: { queued, running } };
      const id = ++seq;
      const row: AgentJobRow = {
        id, status: "queued", requester: j.requester, account_kind: j.accountKind, account_member: j.accountMember, app_id: j.appId,
        project_id: j.projectId, cwd: j.cwd, harness: j.harness, model: j.model, label: j.label, prompt: j.prompt,
        resume_conversation: j.resumeConversation, resume_job_id: j.resumeJobId, timeout_sec: j.timeoutSec, session_id: null,
        boot_hash: null, secret_hash: null, mcp_token_hash: null, conversation_id: null, output_tail: "", result: null, exit_code: null,
        error: null, cancel_requested: false, created_at: new Date(now), claimed_at: null, started_at: null, last_tick_at: null,
        ended_at: null, reaped: false,
      };
      rows.set(id, row);
      return { row: { ...row } };
    },
    async claimAgentJobs(p, mint) {
      const live = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running");
      const queued = [...rows.values()].filter((r) => r.status === "queued" && !r.cancel_requested).sort((a, b) => a.id - b.id);
      const pick = planClaims(live, queued, p);
      return pick.map((id) => {
        const m = mint(id);
        const r = rows.get(id)!;
        Object.assign(r, { status: "starting", claimed_at: new Date(now), session_id: m.sessionId, boot_hash: m.boot.hash });
        return { row: { ...r }, bootSecret: m.boot.secret };
      });
    },
    async getAgentJob(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async bootAgentJob(id, bootHash, secretHash) {
      const r = rows.get(id);
      if (!r || r.status !== "starting" || r.boot_hash !== bootHash) return null;
      Object.assign(r, { status: "running", started_at: new Date(now), last_tick_at: new Date(now), boot_hash: null, secret_hash: secretHash });
      return { ...r };
    },
    async setAgentJobMcpToken(id, h) { rows.get(id)!.mcp_token_hash = h; },
    async tickAgentJob(id, o) {
      const r = rows.get(id);
      if (!r || r.status !== "running") return null;
      Object.assign(r, { last_tick_at: new Date(now), output_tail: o.tail, conversation_id: o.conversationId ?? r.conversation_id });
      return { cancel: r.cancel_requested };
    },
    async finishAgentJob(id, o) {
      const r = rows.get(id);
      const from = (o.from ?? ["queued", "starting", "running"]) as string[];
      if (!r || !from.includes(r.status)) return null;
      Object.assign(r, {
        status: o.status, error: o.error ?? null, result: o.result ?? r.result, exit_code: o.exitCode ?? r.exit_code,
        conversation_id: o.conversationId ?? r.conversation_id, output_tail: o.tail ?? r.output_tail, ended_at: new Date(now), boot_hash: null,
        reaped: r.session_id === null && r.mcp_token_hash === null,
      });
      return { ...r };
    },
    async requestCancelAgentJob(id) {
      const r = rows.get(id);
      if (!r || ended(r.status)) return null;
      r.cancel_requested = true;
      return { ...r };
    },
    async openAgentJobs() { return [...rows.values()].filter((r) => !ended(r.status) || !r.reaped).map((r) => ({ ...r })); },
    async markAgentJobReaped(id) { const r = rows.get(id); if (r && ended(r.status)) r.reaped = true; },
    async listAgentJobs(f) {
      return [...rows.values()].filter((r) => (!f.requester || r.requester === f.requester) && (!f.appId || r.app_id === f.appId) && (!f.status || r.status === f.status))
        .sort((a, b) => b.id - a.id).slice(0, f.limit).map((r) => ({ ...r }));
    },
    async queuePosition(id) { return [...rows.values()].filter((r) => r.status === "queued" && r.id < id).length; },
    newJobSecret: () => { const secret = `s${++hex}`; return { secret, hash: hashJobSecret(secret) }; },
    secretMatches,
  };
  Object.assign(w, {
    rows, launched: [], killed: [], minted: [], revoked: [], later: [], failLaunch: false, available: true,
    policy: { ...DEFAULT_AGENT_JOB_POLICY }, usable: new Set<string>(), projects: new Set<string>(),
    setNow: (ms: number) => { now = ms; },
  });
  w.deps = {
    store,
    policy: async () => w.policy,
    available: async () => w.available,
    launch: async (job, boot) => { w.launched.push({ id: job.id, boot }); if (w.failLaunch) throw new Error("확보 실패(가짜)"); },
    kill: async (sid) => { w.killed.push(sid); },
    mintMcpToken: async (job) => { w.minted.push(job.id); return { token: `tok-${job.id}`, tokenHash: `hash-${job.id}` }; },
    revokeToken: async (h) => { w.revoked.push(h); },
    assertProjectCwd: async (u, pid) => { if (!w.projects.has(`${u.userId}:${pid}`)) throw new HttpError(404, "경로를 찾을 수 없습니다"); },
    assertAppUsable: async (u, app) => { if (!w.usable.has(`${u.userId}:${app}`)) throw new HttpError(403, `앱 '${app}' 사용 동의(grant)가 없습니다`); },
    later: (fn, ms) => { w.later.push({ fn, ms }); },
    workspaceSlug: () => "acme-1234",
    hex8: () => (++hex).toString(16).padStart(8, "0"),
    now: () => now,
  };
  //  뒤로 미룬 일을 다 돌린다(그 일이 또 미룬 것까지). maxMs 이하 지연만.
  w.drain = async (maxMs = Number.MAX_SAFE_INTEGER) => {
    for (let guard = 0; guard < 100; guard++) {
      const i = w.later.findIndex((x) => x.ms <= maxMs);
      if (i < 0) return;
      const [x] = w.later.splice(i, 1);
      await x!.fn();
    }
    throw new Error("뒤로 미룬 일이 끝나지 않는다");
  };
  return w;
}

const human = (id: string, scopes: string[] = ["context"]): LivelyUser => ({ userId: id, scopes } as LivelyUser);
const appUser = (id: string, app: string): LivelyUser => ({ userId: id, scopes: ["context"], appId: app } as LivelyUser);

// ── 접수 ──────────────────────────────────────────────────────────────────────
await t("V1 접수 검증 — 빈 프롬프트 · 너무 김 · 폴더 없음 · 앱이 남의 앱 폴더 · 모델 이름", async () => {
  const w = world();
  w.usable.add("alice:memo");
  await assert.rejects(submitAgentJob({ prompt: "  " }, human("alice"), w.deps), httpErr(400, /비었/));
  await assert.rejects(submitAgentJob({ prompt: "x".repeat(100_001), app_id: "memo" }, human("alice"), w.deps), httpErr(400, /너무 깁/));
  await assert.rejects(submitAgentJob({ prompt: "일" }, human("alice"), w.deps), httpErr(400, /작업 폴더/));
  await assert.rejects(submitAgentJob({ prompt: "일", app_id: "crm" }, appUser("alice", "memo"), w.deps), httpErr(403, /제 앱 폴더/));
  await assert.rejects(submitAgentJob({ prompt: "일", app_id: "../x" }, human("alice"), w.deps), httpErr(400));
  await assert.rejects(submitAgentJob({ prompt: "일", app_id: "memo", model: "--evil" }, human("alice"), w.deps), httpErr(400, /model/));
  assert.equal(w.rows.size, 0, "거절된 요청이 행을 남겼다");
});

await t("V1 폴더 판정 — 앱을 못 쓰는 사람(동의 없음) · 프로젝트 폴더를 못 여는 사람은 거절", async () => {
  const w = world();
  await assert.rejects(submitAgentJob({ prompt: "일", app_id: "memo" }, human("bob"), w.deps), httpErr(403, /동의/));
  await assert.rejects(submitAgentJob({ prompt: "일", project_id: 7 }, human("bob"), w.deps), httpErr(404));
  assert.equal(w.rows.size, 0);
});

await t("V1 접수 성공 — 앱 화면이면 그 앱 폴더 · 본인 구독 · 실행 시간 접기 · 곧바로 배차를 미룬다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  const out = await submitAgentJob({ prompt: " 요약해 ", timeout_min: 999, label: "요약" }, appUser("alice", "memo"), w.deps);
  const row = w.rows.get(out.id as number)!;
  assert.equal(row.cwd, "/work/apps/memo");
  assert.equal(row.app_id, "memo");
  assert.equal(row.project_id, null);
  assert.equal(row.requester, "alice");
  assert.equal(row.account_kind, "subscription");
  assert.equal(row.account_member, "alice");
  assert.equal(row.prompt, "요약해");
  assert.equal(row.timeout_sec, DEFAULT_AGENT_JOB_POLICY.max_timeout_min * 60);
  assert.equal(out.status, "queued");
  assert.equal(out.queue_position, 0);
  assert.ok(!("prompt" in out), "접수 응답에 프롬프트를 되싣지 않는다");
  assert.equal(w.later.length, 1);
  assert.equal(w.later[0]!.ms, 0);
});

await t("V1 앱 화면 + project_id — 프로젝트 폴더에서 돌고 앱은 그 안에 붙는다(앱 id 유지)", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.projects.add("alice:42");
  const out = await submitAgentJob({ prompt: "일", project_id: 42 }, appUser("alice", "memo"), w.deps);
  const row = w.rows.get(out.id as number)!;
  assert.equal(row.cwd, "/work/shared/project/42");
  assert.equal(row.app_id, "memo");
  assert.equal(row.project_id, 42);
});

await t("V1 이어받기 — 같은 사람·같은 앱의 끝난 작업만 · 대화 id 필요 · 폴더는 그 작업 것", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.usable.add("bob:memo");
  const a = await submitAgentJob({ prompt: "처음" }, appUser("alice", "memo"), w.deps);
  const id = a.id as number;
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps), httpErr(409));   // 아직 안 끝남
  Object.assign(w.rows.get(id)!, { status: "done", conversation_id: "0a1b2c3d-0000-4000-8000-000000000009" });
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("bob", "memo"), w.deps), httpErr(404));    // 남의 작업
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "crm"), w.deps), httpErr(404));   // 다른 앱
  const b = await submitAgentJob({ prompt: "이어서", resume_job_id: id, app_id: "zzz" }, appUser("alice", "memo"), w.deps);
  const row = w.rows.get(b.id as number)!;
  assert.equal(row.resume_conversation, "0a1b2c3d-0000-4000-8000-000000000009");
  assert.equal(row.resume_job_id, id);
  assert.equal(row.cwd, "/work/apps/memo");
});

await t("V2 대기열이 차면 429 — 행을 남기지 않는다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.policy = { ...w.policy, max_queued: 2 };
  await submitAgentJob({ prompt: "1" }, appUser("alice", "memo"), w.deps);
  await submitAgentJob({ prompt: "2" }, appUser("alice", "memo"), w.deps);
  await assert.rejects(submitAgentJob({ prompt: "3" }, appUser("alice", "memo"), w.deps), httpErr(429, /대기열/));
  assert.equal(w.rows.size, 2);
});

await t("V3 매니지드가 아니면 501", async () => {
  const w = world();
  w.available = false; w.usable.add("alice:memo");
  await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps), httpErr(501));
});

// ── 배차 · 부트 · 박동 · 결과 ────────────────────────────────────────────────
async function startedJob(w: World, who = "alice", app = "memo"): Promise<{ id: number; boot: string; sid: string }> {
  w.usable.add(`${who}:${app}`);
  const out = await submitAgentJob({ prompt: "일" }, appUser(who, app), w.deps);
  await w.drain(0);
  const id = out.id as number;
  const l = w.launched.find((x) => x.id === id)!;
  return { id, boot: l.boot, sid: w.rows.get(id)!.session_id! };
}

await t("X0 배차 — 워크스페이스 상한만큼 띄우고(세션 id job-…) 나머지는 기다린다", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.usable.add("bob:memo"); w.usable.add("carol:memo");
  for (const who of ["alice", "bob", "carol"]) await submitAgentJob({ prompt: "일" }, appUser(who, "memo"), w.deps);
  await w.drain(0);
  assert.deepEqual(w.launched.map((x) => x.id), [1, 2]);
  assert.match(w.rows.get(1)!.session_id!, /^job-1-[0-9a-f]{8}$/);
  assert.equal(w.rows.get(3)!.status, "queued");
});

await t("B1 부트 — 비밀 틀림 401 · 두 번째 부트 409 · 끝난 작업 410", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await assert.rejects(onBoot(id, "wrong", w.deps), httpErr(401));
  await onBoot(id, boot, w.deps);
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(401));       // 부트 비밀은 지워졌다(다시 못 쓴다)
  const j2 = await startedJob(w, "bob");
  await w.deps.store.finishAgentJob(j2.id, { status: "canceled", error: "x" });
  await assert.rejects(onBoot(j2.id, j2.boot, w.deps), httpErr(410));
  await assert.rejects(onBoot(999, "x", w.deps), httpErr(404));
});

await t("B2 부트 성공 — 콜백 비밀 · 판 본체 · 하네스 인자(훅 끔·strict MCP·자리표) · 작업용 토큰 발급·해시 저장 · running", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  const row = w.rows.get(id)!;
  assert.equal(row.status, "running");
  assert.ok(row.boot_hash === null, "부트 비밀 해시를 지워야 한다");
  assert.ok(secretMatches(row.secret_hash, job.secret), "콜백 비밀이 저장된 해시와 맞아야 한다");
  assert.notEqual(job.secret, boot);
  assert.equal(job.code, RUNNER_SOURCE);
  assert.equal(job.prompt, "일");
  assert.equal(job.cwd, "/work/apps/memo");
  assert.deepEqual(w.minted, [id]);
  assert.equal(row.mcp_token_hash, `hash-${id}`);
  assert.equal(job.argv[job.argv.indexOf("--settings") + 1], JSON.stringify({ disableAllHooks: true }));
  assert.ok(job.argv.includes("--strict-mcp-config"));
  assert.equal(job.argv[job.argv.indexOf("--mcp-config") + 1], MCP_CONFIG_PLACEHOLDER);
  const lv = (job.mcp as any).mcpServers.lively;
  assert.equal(lv.url, "http://127.0.0.1:8080/mcp");
  assert.equal(lv.headers.Authorization, `Bearer tok-${id}`);
  assert.equal(lv.headers["x-lively-workspace"], "acme-1234");
  assert.equal(job.timeoutMs, row.timeout_sec * 1000);
});

await t("박동 — 비밀이 맞을 때만 · 진행 꼬리·대화 id 를 싣고 취소 요청을 돌려준다", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await assert.rejects(onTick(id, boot, {}, w.deps), httpErr(401));
  assert.deepEqual(await onTick(id, job.secret, { tail: "진행", conversation_id: "0A1B2C3D-0000-4000-8000-000000000001" }, w.deps), { cancel: false });
  assert.equal(w.rows.get(id)!.output_tail, "진행");
  assert.equal(w.rows.get(id)!.conversation_id, "0a1b2c3d-0000-4000-8000-000000000001");
  await w.deps.store.requestCancelAgentJob(id);
  assert.deepEqual(await onTick(id, job.secret, {}, w.deps), { cancel: true });
});

await t("X2 결과 — 끝 상태와 답을 적고, 걷기는 조금 뒤(kill · 토큰 폐기), 다음 대기 작업을 띄운다", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const { id, boot, sid } = await startedJob(w);
  const second = await submitAgentJob({ prompt: "둘째" }, appUser("alice", "memo"), w.deps);
  await w.drain(0);
  assert.equal(w.rows.get(second.id as number)!.status, "queued", "상한 1 이라 기다린다");
  const job = await onBoot(id, boot, w.deps);
  const out = await onResult(id, job.secret, {
    exit_code: 0, stopped: null, conversation_id: "0a1b2c3d-0000-4000-8000-000000000002", model: "m",
    result: { text: "답", is_error: false, subtype: "success", num_turns: 1, duration_ms: 5, cost_usd: 0.01, usage: { input_tokens: 9 } },
    stderr_tail: "", tail: "꼬리",
  }, w.deps);
  assert.deepEqual(out, { ok: true, status: "done" });
  const row = w.rows.get(id)!;
  assert.equal(row.status, "done");
  assert.equal((row.result as any).text, "답");
  assert.equal(row.conversation_id, "0a1b2c3d-0000-4000-8000-000000000002");
  assert.equal(row.reaped, false);
  assert.deepEqual(w.killed, [], "걷기는 곧바로가 아니라 판이 빠질 틈 뒤다");
  assert.ok(w.later.some((x) => x.ms === REAP_DELAY_MS));
  await w.drain();
  assert.deepEqual(w.killed, [sid]);
  assert.deepEqual(w.revoked, [`hash-${id}`]);
  assert.equal(w.rows.get(id)!.reaped, true);
  assert.equal(w.rows.get(second.id as number)!.status, "starting", "자리가 나서 다음 작업이 떴다");
  await assert.rejects(onResult(id, job.secret, {}, w.deps), httpErr(410));   // 두 번째 보고는 끝난 작업
});

await t("X2 결과 — 판이 끊은 보고는 그 사유로(timeout · canceled), 자격 문제는 «AI 연결 필요»", async () => {
  for (const [body, want, re] of [
    [{ stopped: "timeout", exit_code: null, signal: "SIGTERM" }, "timeout", /시간/],
    [{ stopped: "canceled" }, "canceled", /취소/],
    [{ exit_code: 1, stderr_tail: "Not logged in · Please run /login" }, "failed", /AI 연결 필요/],
  ] as const) {
    const w = world();
    const { id, boot } = await startedJob(w);
    const job = await onBoot(id, boot, w.deps);
    const out = await onResult(id, job.secret, body, w.deps);
    assert.equal(out.status, want);
    assert.match(w.rows.get(id)!.error ?? "", re);
  }
});

await t("X1 띄우기 실패 — 그 작업은 failed, 걷기(kill), 다음 배차를 미룬다", async () => {
  const w = world();
  w.failLaunch = true;
  w.usable.add("alice:memo");
  const out = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps);
  await w.drain(0);
  const row = w.rows.get(out.id as number)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /확보 실패/);
  assert.deepEqual(w.killed, [row.session_id]);
  assert.equal(row.reaped, true);
});

// ── 취소 · 감시 ────────────────────────────────────────────────────────────────
await t("X3 취소 — 대기 중이면 바로 canceled(걷을 것 없음) · 도는 중이면 표시만(판이 받아 끊는다)", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const { id: runningId, boot } = await startedJob(w);
  await onBoot(runningId, boot, w.deps);
  const q = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps);
  await w.drain(0);
  const qOut = await cancelAgentJobFor(q.id as number, appUser("alice", "memo"), w.deps);
  assert.equal(qOut.status, "canceled");
  assert.equal(w.rows.get(q.id as number)!.reaped, true);
  const rOut = await cancelAgentJobFor(runningId, appUser("alice", "memo"), w.deps);
  assert.equal(rOut.status, "running");
  assert.equal(rOut.cancel_requested, true);
  assert.deepEqual(w.killed, []);
  await assert.rejects(cancelAgentJobFor(runningId, appUser("bob", "memo"), w.deps), httpErr(404));
});

await t("감시 — 대기 초과 failed · 판 무응답 failed + 걷기 · 끝났는데 안 걷은 작업 걷기 · 그 뒤 배차", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const t0 = 1_000_000_000_000;
  const { id, boot, sid } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const q = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps);
  await w.drain(0);
  w.setNow(t0 + (w.policy.silent_sec + 1) * 1000);
  const r1 = await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.status, "failed");
  assert.match(w.rows.get(id)!.error ?? "", /응답하지 않/);
  assert.deepEqual(w.killed, [sid]);
  assert.deepEqual(w.revoked, [`hash-${id}`]);
  assert.equal(r1.ended, 1);
  assert.equal(w.rows.get(q.id as number)!.status, "starting", "자리가 나면 같은 판에서 다음 작업을 띄운다");
});

await t("감시 — 대기 상한을 넘긴 작업은 failed, 살아 있는 도는 작업은 그대로", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const t0 = 1_000_000_000_000;
  const a = await startedJob(w);
  await onBoot(a.id, a.boot, w.deps);
  const waiting = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps);
  await w.drain(0);
  const later = t0 + (w.policy.queue_wait_min * 60 + 1) * 1000;
  w.setNow(later);
  //  도는 작업은 방금 박동했고 상한 안이다(살아 있다).
  Object.assign(w.rows.get(a.id)!, { started_at: new Date(later - 60_000), last_tick_at: new Date(later - 1000) });
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(waiting.id as number)!.status, "failed");
  assert.match(w.rows.get(waiting.id as number)!.error ?? "", /자리가/);
  assert.equal(w.rows.get(a.id)!.status, "running");
  assert.deepEqual(w.killed, [], "살아 있는 작업을 걷지 않는다");
});

// ── 보기 ─────────────────────────────────────────────────────────────────────
await t("X4 보기 — 본인 · 앱 화면은 그 앱의 제 작업만 · 관리자는 다(앱 화면 밖) · 프롬프트는 본인에게만", async () => {
  const w = world();
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "비밀 지시" }, appUser("alice", "memo"), w.deps);
  const id = a.id as number;
  const mine = await getAgentJobFor(id, human("alice"), w.deps);
  assert.equal(mine.prompt, "비밀 지시");
  await assert.rejects(getAgentJobFor(id, human("bob"), w.deps), httpErr(404));
  await assert.rejects(getAgentJobFor(id, appUser("alice", "crm"), w.deps), httpErr(404));
  const admin = await getAgentJobFor(id, human("root", ["context", "admin"]), w.deps);
  assert.ok(!("prompt" in admin), "관리자에게도 남의 프롬프트 원문은 안 준다");
  assert.equal(canSeeJob(w.rows.get(id)!, { userId: "root", scopes: ["admin"], appId: "memo" } as LivelyUser), false, "앱 화면 안의 관리자는 관리자로 안 본다");
  const list = await listAgentJobsFor({}, human("bob"), w.deps);
  assert.deepEqual(list.jobs, []);
  const listAdmin = await listAgentJobsFor({}, human("root", ["admin"]), w.deps);
  assert.equal((listAdmin.jobs as unknown[]).length, 1);
});

console.log(`# ${pass} pass`);

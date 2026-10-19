// 작업 컨테이너 흐름 — 가짜 저장소(메모리) · 가짜 브로커(띄우기·걷기 기록) · 가짜 토큰 · 가짜 시계로 **부작용**을 본다 (#4490).
//  (행의 상태 · 띄우기/걷기에 나간 호출 · 토큰 발급/폐기 · 뒤로 미룬 일). 행 번호(V·B·X·R·S·P)는 지식 agent-job-container-research-4490 의 엣지 표다.
//  ⚠ 가짜 저장소는 SQL 조건을 흉내 낼 뿐이다 — 조건 자체(테넌트 잠금 안의 셈 · «이 상태일 때만» 쓰기 · 침묵 재확인)는
//   store.pg-test.mjs 가 실제 Postgres 에서 잰다. 여기선 흐름이 그 조건을 **부르는가**(배선)를 본다.
import assert from "node:assert/strict";
import { HttpError } from "../http-error.js";
import type { LivelyUser } from "../context.js";
import {
  submitAgentJob, onBoot, onTick, onResult, sweepAgentJobs, cancelAgentJobFor, getAgentJobFor, listAgentJobsFor, canSeeJob, reapJob,
  REAP_DELAY_MS, REAP_GIVE_UP_MS, MAX_LAUNCH_ATTEMPTS, LAUNCH_RETRY_GAP_SEC, stoppedReason, type AgentJobDeps,
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
  launched: Array<{ id: number; boot: string; sid: string | null }>;
  killed: string[];
  minted: number[];
  revoked: string[];
  later: Array<{ fn: () => Promise<unknown>; ms: number }>;
  setNow(ms: number): void;
  /** 띄우기 실패 흉내 — 'permanent'(그 작업 탓) · 'transient'(컨테이너 확보가 막힘). */
  failLaunch: false | "permanent" | "transient";
  /** 걷기(kill)가 확답 아닌 실패로 던지나. */
  killError: boolean;
  /** 토큰 폐기가 던지나. */
  revokeError: boolean;
  /** 작업 토큰 발급이 던지나(동의 철회 등). */
  mintError: string | null;
  /** 토큰 발급 중에 일어날 일(그 사이 취소 흉내). */
  onMint: ((id: number) => void) | null;
  /** 끝내기 직전에 일어날 일(감시가 읽은 뒤 박동이 오는 흉내). */
  beforeFinish: ((id: number) => void) | null;
  claims: number;
  listening: number;
  /** 다음 부트를 «다른 판이 먼저 물었다» 로 만든다(한 번). */
  bootRace: boolean;
  available: boolean;
  policy: AgentJobPolicy;
  usable: Set<string>;     // `${member}:${app}` — 그 앱을 쓸 수 있다
  inactive: Set<string>;   // 비활성이 된 실행 계정
  projects: Set<string>;   // `${member}:${project}` — 그 프로젝트 폴더에서 셸을 띄울 수 있다
  drain(maxMs?: number): Promise<void>;
}
/** 가짜 작업 토큰 해시 — 진짜처럼 64자 16진(작업 토큰 판별이 앞자리로 대조한다). */
const tokHash = (id: number): string => hashJobSecret(`tok-${id}`);

function world(): World {
  const rows = new Map<number, AgentJobRow>();
  const requeuedAt = new Map<number, number>();   // 되돌린 시각(SQL 의 updated_at 자리)
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
        resume_conversation: j.resumeConversation, resume_job_id: j.resumeJobId, timeout_sec: j.timeoutSec, bare: j.bare === true, session_id: null,
        boot_hash: null, secret_hash: null, mcp_token_hash: null, conversation_id: null, output_tail: "", result: null, exit_code: null,
        error: null, cancel_requested: false, cancel_reason: null, attempts: 0, created_at: new Date(now), claimed_at: null, started_at: null,
        last_tick_at: null, ended_at: null, reaped: false,
      };
      rows.set(id, row);
      return { row: { ...row } };
    },
    async claimAgentJobs(p, mint, o = {}) {
      w.claims++;
      const gapMs = (o.retryGapSec ?? 0) * 1000;
      const live = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running");
      const queued = [...rows.values()]
        .filter((r) => r.status === "queued" && !r.cancel_requested && (r.attempts === 0 || now - (requeuedAt.get(r.id) ?? 0) >= gapMs))
        .sort((a, b) => a.id - b.id);
      const pick = planClaims(live, queued, p);
      return pick.map((id) => {
        const m = mint(id);
        const r = rows.get(id)!;
        Object.assign(r, { status: "starting", claimed_at: new Date(now), session_id: m.sessionId, boot_hash: m.boot.hash, error: null, attempts: r.attempts + 1 });
        return { row: { ...r }, bootSecret: m.boot.secret };
      });
    },
    async getAgentJob(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async getAgentJobAuth(id) { const r = rows.get(id); return r ? { id: r.id, status: r.status, boot_hash: r.boot_hash, secret_hash: r.secret_hash } : null; },
    async requeueAgentJob(id, why, maxAttempts) {
      const r = rows.get(id);
      if (!r || r.status !== "starting" || r.cancel_requested || r.attempts >= maxAttempts) return false;
      Object.assign(r, { status: "queued", session_id: null, boot_hash: null, claimed_at: null, error: why });
      requeuedAt.set(id, now);
      return true;
    },
    async isAgentJobToken(prefix) {
      return [...rows.values()].some((r) => (!ended(r.status) || !r.reaped) && !!r.mcp_token_hash && r.mcp_token_hash.startsWith(prefix));
    },
    async bootAgentJob(id, bootHash, secretHash) {
      if (w.bootRace) { w.bootRace = false; return null; }   // 다른 판이 먼저 물었다(같은 비밀로 겹친 부트)
      const r = rows.get(id);
      if (!r || r.status !== "starting" || r.boot_hash !== bootHash) return null;
      Object.assign(r, { status: "running", started_at: new Date(now), last_tick_at: new Date(now), boot_hash: null, secret_hash: secretHash });
      return { ...r };
    },
    async setAgentJobMcpToken(id, h) {
      const r = rows.get(id);
      if (!r || r.status !== "running") return false;
      r.mcp_token_hash = h;
      return true;
    },
    async tickAgentJob(id, o) {
      const r = rows.get(id);
      if (!r || r.status !== "running") return null;
      Object.assign(r, { last_tick_at: new Date(now), output_tail: o.tail, conversation_id: o.conversationId ?? r.conversation_id });
      return { cancel: r.cancel_requested };
    },
    async finishAgentJob(id, o) {
      w.beforeFinish?.(id);
      const r = rows.get(id);
      const from = (o.from ?? ["queued", "starting", "running"]) as string[];
      if (!r || !from.includes(r.status)) return null;
      if (o.silentSec != null) {
        const heard = +(r.last_tick_at ?? r.started_at ?? r.claimed_at ?? r.created_at);
        if (!(heard < now - o.silentSec * 1000)) return null;
      }
      Object.assign(r, {
        status: o.status, error: o.status === "canceled" && r.cancel_reason ? r.cancel_reason : (o.error ?? null),
        result: o.result ?? r.result, exit_code: o.exitCode ?? r.exit_code,
        conversation_id: o.conversationId ?? r.conversation_id, output_tail: o.tail ?? r.output_tail, ended_at: new Date(now), boot_hash: null,
        reaped: r.session_id === null && r.mcp_token_hash === null,
      });
      return { ...r };
    },
    async requestCancelAgentJob(id, reason = null) {
      const r = rows.get(id);
      if (!r || ended(r.status)) return null;
      r.cancel_requested = true;
      r.cancel_reason = reason ?? r.cancel_reason;
      return { ...r };
    },
    async openAgentJobs() { return [...rows.values()].filter((r) => !ended(r.status) || !r.reaped).sort((a, b) => a.id - b.id).map((r) => ({ ...r })); },
    async markAgentJobReaped(id) { const r = rows.get(id); if (r && ended(r.status)) r.reaped = true; },
    async listAgentJobs(f) {
      return [...rows.values()].filter((r) => (!f.requester || r.requester === f.requester) && (!f.appId || r.app_id === f.appId) && (!f.status || r.status === f.status))
        .sort((a, b) => b.id - a.id).slice(0, f.limit).map((r) => {
          const { prompt: _p, output_tail: _o, result, boot_hash: _b, secret_hash: _s, mcp_token_hash: _m, ...rest } = r;
          const text = result && typeof (result as { text?: unknown }).text === "string" ? (result as { text: string }).text : null;
          return { ...rest, result_preview: text ? text.slice(0, 280) : null, has_result: result !== null };
        });
    },
    async queuePosition(id) { return [...rows.values()].filter((r) => r.status === "queued" && r.id < id).length; },
    newJobSecret: () => { const secret = `s${++hex}`; return { secret, hash: hashJobSecret(secret) }; },
    secretMatches,
  };
  Object.assign(w, {
    rows, launched: [], killed: [], minted: [], revoked: [], later: [], failLaunch: false, killError: false, revokeError: false,
    mintError: null, onMint: null, beforeFinish: null, claims: 0, listening: 0, bootRace: false, available: true,
    policy: { ...DEFAULT_AGENT_JOB_POLICY }, usable: new Set<string>(), inactive: new Set<string>(), projects: new Set<string>(),
    setNow: (ms: number) => { now = ms; },
  });
  w.deps = {
    store,
    policy: async () => w.policy,
    available: async () => w.available,
    launch: async (job, boot) => {
      w.launched.push({ id: job.id, boot, sid: job.session_id });
      if (w.failLaunch === "permanent") throw new Error("작업 폴더를 만들지 못했습니다(가짜)");
      if (w.failLaunch === "transient") throw Object.assign(new Error("작업 컨테이너를 확보하지 못했습니다(가짜 — 노드 자리 없음)"), { transient: true });
    },
    kill: async (sid) => { w.killed.push(sid); if (w.killError) throw new Error("중계 시간 초과(가짜)"); },
    assertJobAllowed: async (job) => {
      if (w.inactive.has(String(job.account_member))) throw new HttpError(409, `실행 계정(${job.account_member})이 활성 구성원이 아닙니다`);
      if (job.app_id && !w.usable.has(`${job.account_member}:${job.app_id}`)) throw new HttpError(403, `앱 '${job.app_id}' 사용 동의(grant)가 없습니다`);
    },
    listeningSince: () => w.listening,
    mintMcpToken: async (job) => {
      w.minted.push(job.id);
      w.onMint?.(job.id);
      if (w.mintError) throw new HttpError(403, w.mintError);
      return { token: `tok-${job.id}`, tokenHash: tokHash(job.id) };
    },
    revokeToken: async (h) => { w.revoked.push(h); if (w.revokeError) throw new Error("폐기 실패(가짜)"); },
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
/** 앱 화면 다리(app-tool-call.ts)를 지나 온 호출의 표식. */
const UI = { source: "app-ui" };

// ── 접수 ──────────────────────────────────────────────────────────────────────
await t("V1 접수 검증 — 빈 프롬프트 · 너무 김 · 폴더 없음 · 앱이 남의 앱 폴더 · 모델 이름", async () => {
  const w = world();
  w.usable.add("alice:memo");
  await assert.rejects(submitAgentJob({ prompt: "  " }, human("alice"), w.deps), httpErr(400, /비었/));
  await assert.rejects(submitAgentJob({ prompt: "x".repeat(100_001), app_id: "memo" }, human("alice"), w.deps), httpErr(400, /너무 깁/));
  await assert.rejects(submitAgentJob({ prompt: "일" }, human("alice"), w.deps), httpErr(400, /작업 폴더/));
  await assert.rejects(submitAgentJob({ prompt: "일", app_id: "crm" }, appUser("alice", "memo"), w.deps, UI), httpErr(403, /제 앱 폴더/));
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
  const out = await submitAgentJob({ prompt: " 요약해 ", timeout_min: 999, label: "요약" }, appUser("alice", "memo"), w.deps, UI);
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
  const out = await submitAgentJob({ prompt: "일", project_id: 42 }, appUser("alice", "memo"), w.deps, UI);
  const row = w.rows.get(out.id as number)!;
  assert.equal(row.cwd, "/work/shared/project/42");
  assert.equal(row.app_id, "memo");
  assert.equal(row.project_id, 42);
});

await t("V1 이어받기 — 같은 사람·같은 앱의 끝난 작업만 · 대화 id 필요 · 폴더는 그 작업 것", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.usable.add("bob:memo");
  const a = await submitAgentJob({ prompt: "처음" }, appUser("alice", "memo"), w.deps, UI);
  const id = a.id as number;
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI), httpErr(409));   // 아직 안 끝남
  Object.assign(w.rows.get(id)!, { status: "done", conversation_id: "0a1b2c3d-0000-4000-8000-000000000009" });
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("bob", "memo"), w.deps, UI), httpErr(404));    // 남의 작업
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "crm"), w.deps, UI), httpErr(404));   // 다른 앱
  const b = await submitAgentJob({ prompt: "이어서", resume_job_id: id, app_id: "zzz" }, appUser("alice", "memo"), w.deps, UI);
  const row = w.rows.get(b.id as number)!;
  assert.equal(row.resume_conversation, "0a1b2c3d-0000-4000-8000-000000000009");
  assert.equal(row.resume_job_id, id);
  assert.equal(row.cwd, "/work/apps/memo");
});

await t("V2 대기열이 차면 429 — 행을 남기지 않는다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.policy = { ...w.policy, max_queued: 2 };
  await submitAgentJob({ prompt: "1" }, appUser("alice", "memo"), w.deps, UI);
  await submitAgentJob({ prompt: "2" }, appUser("alice", "memo"), w.deps, UI);
  await assert.rejects(submitAgentJob({ prompt: "3" }, appUser("alice", "memo"), w.deps, UI), httpErr(429, /대기열/));
  assert.equal(w.rows.size, 2);
});

await t("V3 매니지드가 아니면 501", async () => {
  const w = world();
  w.available = false; w.usable.add("alice:memo");
  await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI), httpErr(501));
});

// ── 배차 · 부트 · 박동 · 결과 ────────────────────────────────────────────────
async function startedJob(w: World, who = "alice", app = "memo"): Promise<{ id: number; boot: string; sid: string }> {
  w.usable.add(`${who}:${app}`);
  const out = await submitAgentJob({ prompt: "일" }, appUser(who, app), w.deps, UI);
  await w.drain(0);
  const id = out.id as number;
  const l = w.launched.find((x) => x.id === id)!;
  return { id, boot: l.boot, sid: w.rows.get(id)!.session_id! };
}

await t("X0 배차 — 워크스페이스 상한만큼 띄우고(세션 id job-…) 나머지는 기다린다", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.usable.add("bob:memo"); w.usable.add("carol:memo");
  for (const who of ["alice", "bob", "carol"]) await submitAgentJob({ prompt: "일" }, appUser(who, "memo"), w.deps, UI);
  await w.drain(0);
  assert.deepEqual(w.launched.map((x) => x.id), [1, 2]);
  assert.match(w.rows.get(1)!.session_id!, /^job-1-[0-9a-f]{8}$/);
  assert.equal(w.rows.get(3)!.status, "queued");
});

await t("B1 부트 — 비밀 틀림 401 · 두 번째 부트 401(부트 비밀은 쓰면 지운다) · 끝난 작업의 부트 401 · 없는 작업 401", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await assert.rejects(onBoot(id, "wrong", w.deps), httpErr(401));
  await onBoot(id, boot, w.deps);
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(401));       // 부트 비밀은 지워졌다(다시 못 쓴다)
  const j2 = await startedJob(w, "bob");
  await w.deps.store.finishAgentJob(j2.id, { status: "canceled", error: "x" });
  await assert.rejects(onBoot(j2.id, j2.boot, w.deps), httpErr(401)); // 끝내기도 부트 비밀을 지운다
  await assert.rejects(onBoot(999, "x", w.deps), httpErr(401));       // 없는 작업도 401(있나 없나를 엿볼 수 없게)
});

await t("B1b 콜백 인증 — 틀린 비밀은 끝난 작업이어도 401(상태를 흘리지 않는다) · 맞는 비밀 + 끝난 작업은 410", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await w.deps.store.finishAgentJob(id, { status: "canceled", error: "x" });
  await assert.rejects(onTick(id, "wrong", {}, w.deps), httpErr(401));
  await assert.rejects(onResult(id, "wrong", {}, w.deps), httpErr(401));
  await assert.rejects(onTick(id, job.secret, {}, w.deps), httpErr(410));
  await assert.rejects(onResult(id, job.secret, {}, w.deps), httpErr(410));
  await assert.rejects(onTick(424242, job.secret, {}, w.deps), httpErr(401));
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
  assert.equal(row.mcp_token_hash, tokHash(id));
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
  const second = await submitAgentJob({ prompt: "둘째" }, appUser("alice", "memo"), w.deps, UI);
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
  assert.deepEqual(w.revoked, [tokHash(id)]);
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

await t("X1 띄우기 실패(그 작업 탓) — 그 작업은 failed, 걷기(kill), 다음 작업을 띄운다", async () => {
  const w = world();
  w.failLaunch = "permanent";
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  w.usable.add("alice:memo");
  const out = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  const next = await submitAgentJob({ prompt: "다음" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  const row = w.rows.get(out.id as number)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /폴더/);
  assert.ok(w.killed.includes(row.session_id!));
  assert.equal(row.reaped, true);
  assert.ok(w.launched.some((x) => x.id === next.id), "자리가 나서 다음 작업을 띄우러 갔다");
});

await t("X1b 띄우기 일시 실패(컨테이너 확보가 막힘) — 대기열로 되돌리고 이번 배차는 멈춘다 · 다음 감시가 새 세션 id 로 다시 띄운다", async () => {
  const w = world();
  w.failLaunch = "transient";
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  const b = await submitAgentJob({ prompt: "다음" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  const row = w.rows.get(a.id as number)!;
  assert.equal(row.status, "queued", "실패로 끝내지 않는다");
  assert.equal(row.session_id, null);
  assert.match(row.error ?? "", /다시 기다립니다/);
  assert.equal(w.rows.get(b.id as number)!.status, "queued", "뒤 작업까지 줄줄이 실패시키지 않는다");
  assert.deepEqual(w.launched.map((x) => x.id), [a.id], "이번 배차는 멈췄다(같은 판에서 다시 띄우지 않는다)");
  assert.equal(w.killed.length, 1, "반쯤 만든 자리를 걷으러 간다");
  w.failLaunch = false;
  w.setNow(1_000_000_000_000 + (LAUNCH_RETRY_GAP_SEC + 1) * 1000);   // 되돌린 뒤 쉬는 시간이 지났다
  await sweepAgentJobs(w.deps);
  await w.drain(0);
  const again = w.launched.filter((x) => x.id === a.id);
  assert.equal(again.length, 2, "다음 감시가 같은 작업을 다시 띄운다(먼저 온 순서)");
  assert.notEqual(again[1]!.sid, again[0]!.sid, "새 세션 id 로");
  assert.equal(w.rows.get(a.id as number)!.status, "starting");
});

await t("X1c 동의 철회 — 대기 중에 앱 동의를 거두면 띄우지 않고 failed(그 앱 폴더에서 돌지 않는다)", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  w.usable.add("alice:memo"); w.usable.add("bob:memo");
  const first = await startedJob(w, "bob");
  const waiting = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  w.usable.delete("alice:memo");                      // 기다리는 사이 동의를 거뒀다
  await w.deps.store.finishAgentJob(first.id, { status: "done" });
  await sweepAgentJobs(w.deps);
  await w.drain(0);
  const row = w.rows.get(waiting.id as number)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /동의/);
  assert.ok(!w.launched.some((x) => x.id === waiting.id), "띄우러 가지 않았다");
});

// ── 취소 · 감시 ────────────────────────────────────────────────────────────────
await t("X3 취소 — 대기 중이면 바로 canceled(걷을 것 없음) · 도는 중이면 표시만(판이 받아 끊는다)", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const { id: runningId, boot } = await startedJob(w);
  await onBoot(runningId, boot, w.deps);
  const q = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps, UI);
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
  const q = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  w.setNow(t0 + (w.policy.silent_sec + 1) * 1000);
  const r1 = await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.status, "failed");
  assert.match(w.rows.get(id)!.error ?? "", /응답하지 않/);
  assert.deepEqual(w.killed, [sid]);
  assert.deepEqual(w.revoked, [tokHash(id)]);
  assert.equal(r1.ended, 1);
  assert.equal(w.rows.get(q.id as number)!.status, "starting", "자리가 나면 같은 판에서 다음 작업을 띄운다");
});

await t("감시 — 대기 상한을 넘긴 작업은 failed, 살아 있는 도는 작업은 그대로", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const t0 = 1_000_000_000_000;
  const a = await startedJob(w);
  await onBoot(a.id, a.boot, w.deps);
  const waiting = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps, UI);
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

await t("B3 작업 AI 의 신원(토큰)을 못 만들면 돌리지 않는다 — failed · 걷기 · 판에 410", async () => {
  const w = world();
  const { id, boot, sid } = await startedJob(w);
  w.mintError = "앱 'memo' 사용 동의(grant)가 없습니다";
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(410));
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /신원.*동의/);
  await w.drain(0);
  assert.deepEqual(w.killed, [sid]);
  assert.equal(w.rows.get(id)!.reaped, true);
});

await t("B4 토큰을 다는 사이 작업이 끝났으면 — 방금 만든 토큰을 바로 폐기하고 410", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  w.onMint = (jid) => { void w.deps.store.finishAgentJob(jid, { status: "canceled", error: "취소" }); };
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(410));
  assert.ok(w.revoked.includes(tokHash(id)), "걷기가 모르는 토큰이 남지 않는다");
});

await t("P1 누가 보낼 수 있나 — 앱 서버 대리 403 · 앱 토큰 직접(다리 아님) 403 · 작업 AI 의 토큰 403 · 사람 본인·앱 화면은 받는다", async () => {
  const w = world();
  w.usable.add("alice:memo"); w.projects.add("alice:42");
  const server = { ...appUser("alice", "memo"), appServer: true } as LivelyUser;
  await assert.rejects(submitAgentJob({ prompt: "일" }, server, w.deps, UI), httpErr(403, /앱 서버/));
  await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps), httpErr(403, /앱 토큰/));
  await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, { source: "mcp" }), httpErr(403, /앱 토큰/));
  assert.equal(w.rows.size, 0, "거절된 요청이 행을 남겼다");
  const j = await startedJob(w);
  await onBoot(j.id, j.boot, w.deps);
  const jobTok = { ...human("alice"), tokenHashPrefix: tokHash(j.id).slice(0, 12) } as LivelyUser;
  await assert.rejects(submitAgentJob({ prompt: "또", project_id: 42 }, jobTok, w.deps), httpErr(403, /작업 안/));
  const before = w.rows.size;
  const ok = await submitAgentJob({ prompt: "사람", project_id: 42 }, { ...human("alice"), tokenHashPrefix: "f".repeat(12) } as LivelyUser, w.deps);
  assert.equal(ok.status, "queued");
  assert.equal(w.rows.size, before + 1);
});

await t("X3b 취소 — 띄우는 중(starting)이면 바로 canceled · 컨테이너를 걷고 · 다음 작업을 띄운다 · 늦은 부트는 401", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const { id, boot, sid } = await startedJob(w);
  const next = await submitAgentJob({ prompt: "다음" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  assert.equal(w.rows.get(id)!.status, "starting");
  const out = await cancelAgentJobFor(id, appUser("alice", "memo"), w.deps);
  assert.equal(out.status, "canceled");
  assert.deepEqual(w.killed, [sid]);
  assert.equal(w.rows.get(id)!.reaped, true);
  await w.drain(0);
  assert.equal(w.rows.get(next.id as number)!.status, "starting", "자리가 나서 다음 작업이 떴다");
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(401));
});

await t("S4 감시 — 띄우는 중 상한을 넘기면 failed + 걷기 + 같은 판에서 다음 작업", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const t0 = 1_000_000_000_000;
  const { id, sid } = await startedJob(w);
  const next = await submitAgentJob({ prompt: "다음" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  w.setNow(t0 + (w.policy.start_timeout_sec + 1) * 1000);
  const r = await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.status, "failed");
  assert.match(w.rows.get(id)!.error ?? "", /시작하지 않았/);
  assert.deepEqual(w.killed, [sid]);
  assert.equal(r.launched, 1);
  assert.equal(w.rows.get(next.id as number)!.status, "starting");
});

await t("S5 무응답 판정은 쓰는 순간 다시 잰다 — 감시가 읽은 뒤 박동이 왔으면 끝내지 않는다", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const later = t0 + (w.policy.silent_sec + 5) * 1000;
  w.setNow(later);
  w.beforeFinish = (jid) => { if (jid === id) { w.rows.get(id)!.last_tick_at = new Date(later); w.beforeFinish = null; } };
  const r = await sweepAgentJobs(w.deps);
  assert.equal(r.ended, 0);
  assert.equal(w.rows.get(id)!.status, "running");
  assert.deepEqual(w.killed, []);
});

await t("S6 재기동 직후 — 게이트웨이가 못 들은 시간은 침묵으로 세지 않는다(살아 있는 판을 한꺼번에 끊지 않는다)", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const restart = t0 + 300_000;                        // 5분 동안 게이트웨이가 내려가 있었다
  w.listening = restart;
  w.setNow(restart + 10_000);
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.status, "running", "듣기 시작한 지 10초 — 판정 보류");
  w.setNow(restart + (w.policy.silent_sec + 1) * 1000);
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.status, "failed", "듣기 시작한 뒤에도 silent_sec 동안 말이 없으면 끊긴 것");
});

await t("S7 기다리는 작업이 없으면 감시가 자리 주기(잠금 트랜잭션)를 돌지 않는다", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const before = w.claims;
  const r = await sweepAgentJobs(w.deps);
  assert.equal(r.launched, 0);
  assert.equal(w.claims, before);
  const empty = world();
  await sweepAgentJobs(empty.deps);
  assert.equal(empty.claims, 0, "작업이 없는 워크스페이스");
});

await t("S8 대기 상한 — 일시 실패로 되돌린 작업이면 마지막 띄우기 실패 사유를 붙인다", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  w.failLaunch = "transient";
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  w.setNow(t0 + (w.policy.queue_wait_min * 60 + 1) * 1000);
  await sweepAgentJobs(w.deps);
  const row = w.rows.get(a.id as number)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /자리가 .*마지막 띄우기 실패: .*확보하지 못했/);
});

await t("R1 걷기 실패(확답 아님) — «걷음» 으로 적지 않는다 · 토큰은 바로 폐기 · 다음 감시가 다시 걷는다", async () => {
  const w = world();
  const { id, boot, sid } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onResult(id, job.secret, { exit_code: 0, result: { text: "답", is_error: false } }, w.deps);
  w.killError = true;
  await w.drain();
  assert.equal(w.rows.get(id)!.reaped, false, "못 걷은 것을 걷었다고 적지 않는다");
  assert.ok(w.revoked.includes(tokHash(id)), "kill 이 막혀도 작업 토큰은 끊는다");
  w.killError = false;
  const r = await sweepAgentJobs(w.deps);
  assert.equal(r.reaped, 1);
  assert.equal(w.rows.get(id)!.reaped, true);
  assert.deepEqual(w.killed, [sid, sid], "두 번 걷으러 갔다");
});

await t("R2 걷기를 10분 동안 못 하면 놓는다 — 영구 실패가 감시 목록을 막지 않게(토큰은 폐기)", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onResult(id, job.secret, { exit_code: 0, result: { text: "답", is_error: false } }, w.deps);
  w.killError = true;
  await w.drain();
  w.setNow(t0 + REAP_GIVE_UP_MS - 1000);
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.reaped, false, "10분 전에는 계속 다시 걷는다");
  w.setNow(t0 + REAP_GIVE_UP_MS + 1000);
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.reaped, true, "10분이 지나면 놓는다");
  assert.ok(w.revoked.includes(tokHash(id)));
});

await t("R3 사람 세션(`box-`) id 가 실린 끝난 행 — kill 을 보내지 않는다(토큰은 폐기하고 걷음으로 적는다)", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const ended = (await w.deps.store.finishAgentJob(id, { status: "failed", error: "x" }))!;
  assert.equal(await reapJob({ ...ended, session_id: "box-alice-1" }, w.deps), true);
  assert.deepEqual(w.killed, [], "사람 세션을 끄는 길이 열리면 안 된다");
  assert.ok(w.revoked.includes(tokHash(id)));
});

await t("R4 토큰 폐기 실패 — 걷음으로 적지 않는다(다음 감시가 다시 폐기한다)", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);
  const ended = (await w.deps.store.finishAgentJob(id, { status: "failed", error: "x" }))!;
  w.revokeError = true;
  assert.equal(await reapJob(ended, w.deps), false);
  assert.equal(w.rows.get(id)!.reaped, false);
});

await t("T1 박동의 진행 꼬리에서 NUL 을 뺀다(Postgres text 가 받지 않는다)", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onTick(id, job.secret, { tail: "a\u0000b" }, w.deps);
  assert.equal(w.rows.get(id)!.output_tail, "ab");
});

await t("L1 목록은 요약만 — 프롬프트·결과 전문·진행 꼬리·비밀 해시 없음 · 답 앞머리(result_preview) · 전문은 하나 보기로", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onResult(id, job.secret, { exit_code: 0, result: { text: "가".repeat(1000), is_error: false }, tail: "꼬리" }, w.deps);
  const list = await listAgentJobsFor({}, human("alice"), w.deps);
  const row = (list.jobs as Array<Record<string, unknown>>)[0]!;
  for (const k of ["prompt", "result", "output_tail", "boot_hash", "secret_hash", "mcp_token_hash"]) assert.ok(!(k in row), `${k} 를 싣지 않는다`);
  assert.equal((row.result_preview as string).length, 280);
  assert.equal(row.has_result, true);
  //  관리자 목록 — 남의 작업은 답이 있어도 앞머리를 싣지 않는다(있다는 것만).
  const asAdmin = (await listAgentJobsFor({}, human("root", ["context", "admin"]), w.deps)).jobs as Array<Record<string, unknown>>;
  assert.equal(asAdmin[0]!.result_preview, null);
  assert.equal(asAdmin[0]!.has_result, true);
  const one = await getAgentJobFor(id, human("alice"), w.deps);
  assert.equal(((one.result as { text: string }).text).length, 1000, "전문은 하나 보기로");
});

await t("V4 접수 — 지시에 NUL 이 있으면 400(고쳐 담지 않는다) · 라벨의 NUL 은 뺀다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  await assert.rejects(submitAgentJob({ prompt: "a\u0000b" }, appUser("alice", "memo"), w.deps, UI), httpErr(400, /NUL/));
  assert.equal(w.rows.size, 0);
  const out = await submitAgentJob({ prompt: "일", label: "이\u0000름" }, appUser("alice", "memo"), w.deps, UI);
  assert.equal(w.rows.get(out.id as number)!.label, "이름");
});

await t("P2 앱 주소의 `/_lively/*`(app-front)도 사람의 앱 화면이다 — 받는다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  const out = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, { source: "app-front" });
  assert.equal(out.status, "queued");
  assert.equal(w.rows.get(out.id as number)!.cwd, "/work/apps/memo");
});

await t("X5 띄우기 일시 실패가 상한(MAX_LAUNCH_ATTEMPTS)까지 이어지면 «N번 시도» 로 실패한다 — 앞줄을 오래 막지 않게", async () => {
  const w = world();
  w.failLaunch = "transient";
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  for (let i = 1; i < MAX_LAUNCH_ATTEMPTS; i++) {
    assert.equal(w.rows.get(a.id as number)!.status, "queued", `${i}번째 실패 뒤엔 다시 기다린다`);
    w.setNow(1_000_000_000_000 + i * (LAUNCH_RETRY_GAP_SEC + 1) * 1000);
    await sweepAgentJobs(w.deps);
    await w.drain(0);
  }
  const row = w.rows.get(a.id as number)!;
  assert.equal(row.attempts, MAX_LAUNCH_ATTEMPTS);
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", new RegExp(`${MAX_LAUNCH_ATTEMPTS}번 시도`));
  assert.equal(w.launched.filter((x) => x.id === a.id).length, MAX_LAUNCH_ATTEMPTS);
});

await t("X1d 일시 실패인데 그 사이 취소가 걸렸으면 되돌리지 않고 끝낸다", async () => {
  const w = world();
  w.failLaunch = "transient";
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  //  자리를 받은 뒤 · 띄우기가 실패하기 전에 취소 요청이 걸린 경합을 흉내 낸다.
  const launch = w.deps.launch;
  w.deps.launch = async (job, boot) => { w.rows.get(job.id)!.cancel_requested = true; return launch(job, boot); };
  await w.drain(0);
  const row = w.rows.get(a.id as number)!;
  assert.equal(row.status, "failed", "취소가 걸린 작업을 대기열로 되돌리지 않는다");
  assert.match(row.error ?? "", /확보하지 못했/);
  assert.equal(row.reaped, true, "끝냈으면 걷는다");
});

await t("R5 도는 앱 작업 — 동의를 거두면 감시가 멈춘다(사유는 «앱을 더 쓸 수 없게 돼») · 띄우는 중이면 바로 끝내고 걷는다", async () => {
  const w = world();
  const run = await startedJob(w, "alice");
  const job = await onBoot(run.id, run.boot, w.deps);
  const st = await startedJob(w, "bob");          // 띄우는 중(부트 전)
  w.usable.delete("alice:memo"); w.usable.delete("bob:memo");
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(run.id)!.cancel_requested, true, "도는 작업엔 취소를 건다(판의 다음 박동이 받는다)");
  assert.equal(w.rows.get(st.id)!.status, "canceled");
  assert.match(w.rows.get(st.id)!.error ?? "", /^더 돌릴 수 없게 돼 멈췄습니다 — .*동의/);
  assert.ok(w.killed.includes(st.sid));
  assert.deepEqual(await onTick(run.id, job.secret, {}, w.deps), { cancel: true });
  await onResult(run.id, job.secret, { stopped: "canceled" }, w.deps);
  assert.equal(w.rows.get(run.id)!.status, "canceled");
  assert.equal(w.rows.get(run.id)!.error, stoppedReason(`앱 'memo' 사용 동의(grant)가 없습니다`), "사람이 누른 취소처럼 보이지 않게 사유를 남긴다");
});

await t("R6 앱 판정이 «못 쓴다» 가 아니라 실패(DB 가 잠깐 막힘)면 멈추지 않는다", async () => {
  const w = world();
  const run = await startedJob(w, "alice");
  await onBoot(run.id, run.boot, w.deps);
  w.deps.assertJobAllowed = async () => { throw new Error("connection terminated"); };
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(run.id)!.cancel_requested, false);
  assert.equal(w.rows.get(run.id)!.status, "running");
});

await t("V5 이어받기 — 끝났어도 done 이 아니면(failed) 409", async () => {
  const w = world();
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "처음" }, appUser("alice", "memo"), w.deps, UI);
  Object.assign(w.rows.get(a.id as number)!, { status: "failed", conversation_id: "0a1b2c3d-0000-4000-8000-000000000009" });
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: a.id }, appUser("alice", "memo"), w.deps, UI), httpErr(409));
});

await t("S9 감시의 끝내기는 «읽은 상태일 때만» — 읽은 뒤 자리를 받은 작업을 대기 상한으로 끝내지 않는다", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  const first = await startedJob(w, "alice");
  await onBoot(first.id, first.boot, w.deps);
  const q = await submitAgentJob({ prompt: "대기" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  w.setNow(t0 + (w.policy.queue_wait_min * 60 + 1) * 1000);
  Object.assign(w.rows.get(first.id)!, { started_at: new Date(t0 + 1), last_tick_at: new Date(t0 + (w.policy.queue_wait_min * 60) * 1000) });
  w.beforeFinish = (jid) => { if (jid === q.id) { w.rows.get(jid)!.status = "starting"; w.beforeFinish = null; } };
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(q.id as number)!.status, "starting", "대기 상한 판정이 띄우는 중인 작업을 끝내면 안 된다");
});

await t("B5 같은 비밀로 두 판이 겹쳐 물면 늦은 쪽은 409", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  w.bootRace = true;
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(409));
});

await t("R7 동의를 거둔 뒤 판이 죽었으면 — 취소만 걸린 채 남지 않고 무응답 판정으로 끝난다(자리가 새지 않게)", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  const run = await startedJob(w, "alice");
  await onBoot(run.id, run.boot, w.deps);
  w.usable.delete("alice:memo");
  await sweepAgentJobs(w.deps);                                    // 취소를 건다 — 판은 이미 죽어 박동이 없다
  assert.equal(w.rows.get(run.id)!.cancel_requested, true);
  w.setNow(t0 + (w.policy.silent_sec + 1) * 1000);
  await sweepAgentJobs(w.deps);
  const row = w.rows.get(run.id)!;
  assert.equal(row.status, "failed", "취소가 걸린 작업도 무응답 판정은 탄다");
  assert.ok(w.killed.includes(run.sid));
});

await t("R8 실행 계정이 비활성이 되면 프로젝트 작업도 멈춘다(앱 작업만이 아니다)", async () => {
  const w = world();
  w.projects.add("alice:42");
  const out = await submitAgentJob({ prompt: "일", project_id: 42 }, human("alice"), w.deps);
  await w.drain(0);
  const id = out.id as number;
  const boot = w.launched.find((x) => x.id === id)!.boot;
  await onBoot(id, boot, w.deps);
  w.inactive.add("alice");
  await sweepAgentJobs(w.deps);
  assert.equal(w.rows.get(id)!.cancel_requested, true);
  assert.match(w.rows.get(id)!.cancel_reason ?? "", /활성 구성원이 아닙니다/);
});

await t("X1e 배차 직전 판정을 못 했으면(DB 가 잠깐 막힘) 끝내지 않고 일시로 되돌린다", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.deps.assertJobAllowed = async () => { throw new Error("connection terminated unexpectedly"); };
  const a = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  const row = w.rows.get(a.id as number)!;
  assert.equal(row.status, "queued");
  assert.match(row.error ?? "", /판정하지 못했습니다/);
  assert.equal(w.launched.length, 0, "판정 못 한 채 띄우지 않는다");
});

await t("X1f 되돌린 작업은 쉬는 동안 다시 받지 않는다 — 접수·결과 같은 다른 배차에도 · 그 자리는 뒤 작업이 쓴다", async () => {
  const w = world();
  const t0 = 1_000_000_000_000;
  w.policy = { ...w.policy, max_running: 1, max_running_per_member: 1 };
  w.usable.add("alice:memo"); w.usable.add("bob:memo");
  w.failLaunch = "transient";
  const a = await submitAgentJob({ prompt: "앞" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  assert.equal(w.rows.get(a.id as number)!.status, "queued");
  w.failLaunch = false;
  w.setNow(t0 + (LAUNCH_RETRY_GAP_SEC - 1) * 1000);
  const b = await submitAgentJob({ prompt: "뒤" }, appUser("bob", "memo"), w.deps, UI);   // 접수가 배차를 부른다
  await w.drain(0);
  assert.equal(w.rows.get(a.id as number)!.attempts, 1, "쉬는 동안엔 다시 받지 않는다");
  assert.equal(w.rows.get(b.id as number)!.status, "starting", "그 자리는 뒤 작업이 쓴다");
});

await t("P3 앱 주체의 REST(`web`) · MCP(`mcp`) 호출은 앱 화면이 아니다 — 403", async () => {
  const w = world();
  w.usable.add("alice:memo");
  for (const source of ["web", "mcp", ""]) {
    await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, { source }), httpErr(403, /앱 토큰/), source);
  }
});

await t("X6 취소 응답 — 본인에게도 지시를 되싣지 않고 · 관리자에게는 남의 답·진행 꼬리도 없다", async () => {
  const w = world();
  const own = await startedJob(w, "alice");
  const job = await onBoot(own.id, own.boot, w.deps);
  await onTick(own.id, job.secret, { tail: "남의 진행" }, w.deps);
  const mine = await cancelAgentJobFor(own.id, appUser("alice", "memo"), w.deps);
  assert.ok(!("prompt" in mine), "취소 응답엔 지시를 싣지 않는다");
  assert.equal(mine.output_tail, "남의 진행", "본인은 진행 꼬리를 본다");
  const other = await startedJob(w, "bob");
  const ojob = await onBoot(other.id, other.boot, w.deps);
  await onTick(other.id, ojob.secret, { tail: "밥의 진행" }, w.deps);
  const byAdmin = await cancelAgentJobFor(other.id, human("root", ["context", "admin"]), w.deps);
  for (const k of ["prompt", "result", "output_tail"]) assert.ok(!(k in byAdmin), `관리자 취소 응답에 ${k} 가 없다`);
  assert.equal(byAdmin.cancel_requested, true);
});

// ── 보기 ─────────────────────────────────────────────────────────────────────
await t("X4 보기 — 본인 · 앱 화면은 그 앱의 제 작업만 · 관리자는 다(앱 화면 밖) · 프롬프트는 본인에게만", async () => {
  const w = world();
  w.usable.add("alice:memo");
  const a = await submitAgentJob({ prompt: "비밀 지시" }, appUser("alice", "memo"), w.deps, UI);
  const id = a.id as number;
  const mine = await getAgentJobFor(id, human("alice"), w.deps);
  assert.equal(mine.prompt, "비밀 지시");
  await assert.rejects(getAgentJobFor(id, human("bob"), w.deps), httpErr(404));
  await assert.rejects(getAgentJobFor(id, appUser("alice", "crm"), w.deps), httpErr(404));
  const admin = await getAgentJobFor(id, human("root", ["context", "admin"]), w.deps);
  assert.ok(!("prompt" in admin), "관리자에게도 남의 프롬프트 원문은 안 준다");
  assert.ok(!("result" in admin) && !("output_tail" in admin), "관리자에게도 남의 답·진행 꼬리는 안 준다(상태·오류만)");
  assert.equal(canSeeJob(w.rows.get(id)!, { userId: "root", scopes: ["admin"], appId: "memo" } as LivelyUser), false, "앱 화면 안의 관리자는 관리자로 안 본다");
  //  #4488 — 초대받은 사람이 보내 내 구독·내 자리로 도는 작업은 그 구독의 주인도 본다(취소도 같은 판정). API 키 작업은 보낸 사람만.
  const invitedJob = { ...w.rows.get(id)!, requester: "bob", account_kind: "subscription", account_member: "alice" } as AgentJobRow;
  assert.equal(canSeeJob(invitedJob, { userId: "alice", scopes: ["context"] } as LivelyUser), true, "구독 주인은 본다");
  assert.equal(canSeeJob(invitedJob, { userId: "carol", scopes: ["context"] } as LivelyUser), false);
  assert.equal(canSeeJob({ ...invitedJob, account_kind: "api_key", account_member: null } as AgentJobRow, { userId: "alice", scopes: ["context"] } as LivelyUser), false, "API 키 작업은 보낸 사람만");
  const list = await listAgentJobsFor({}, human("bob"), w.deps);
  assert.deepEqual(list.jobs, []);
  const listAdmin = await listAgentJobsFor({}, human("root", ["admin"]), w.deps);
  assert.equal((listAdmin.jobs as unknown[]).length, 1);
  assert.equal((listAdmin.jobs as Array<Record<string, unknown>>)[0]!.result_preview, null, "관리자 목록엔 남의 답 앞머리가 없다");
  const adminInApp = await listAgentJobsFor({}, { userId: "root", scopes: ["admin"], appId: "memo" } as LivelyUser, w.deps);
  assert.deepEqual(adminInApp.jobs, [], "앱 화면 안의 관리자는 관리자로 안 본다 — 남의 작업이 목록에 안 뜬다");
});

console.log(`# ${pass} pass`);

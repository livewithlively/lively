// 작업 컨테이너 흐름 — 가짜 저장소(메모리) · 가짜 브로커(띄우기·걷기 기록) · 가짜 토큰 · 가짜 시계로 **부작용**을 본다 (#4490).
//  (행의 상태 · 띄우기/걷기에 나간 호출 · 토큰 발급/폐기 · 뒤로 미룬 일). 행 번호(V·B·X·R·S·P)는 지식 agent-job-container-research-4490 의 엣지 표다.
//  ⚠ 가짜 저장소는 SQL 조건을 흉내 낼 뿐이다 — 조건 자체(테넌트 잠금 안의 셈 · «이 상태일 때만» 쓰기 · 침묵 재확인)는
//   store.pg-test.mjs 가 실제 Postgres 에서 잰다. 여기선 흐름이 그 조건을 **부르는가**(배선)를 본다.
import assert from "node:assert/strict";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";
import type { LivelyUser } from "../context.js";
import zlibSync from "node:zlib";
import {
  submitAgentJob, onBoot, onBootFailed, onTick, onResult, onTranscript, transcriptGate, sweepAgentJobs, cancelAgentJobFor, getAgentJobFor, listAgentJobsFor, canSeeJob, reapJob, pruneAgentJobRecords,
  assertSharedSeatJob,
  enqueueAgentJob, publicJob,
  REAP_DELAY_MS, REAP_GIVE_UP_MS, MAX_LAUNCH_ATTEMPTS, LAUNCH_RETRY_GAP_SEC, stoppedReason, type AgentJobDeps,
} from "./service.js";
import { planClaims, TRANSCRIPT_GZ_MAX, TRANSCRIPT_RAW_MAX } from "./plan.js";
import { MCP_CONFIG_PLACEHOLDER, RUNNER_SOURCE, SYSTEM_PROMPT_PLACEHOLDER } from "./runner.js";
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
  /** 시작 실패로 끝내기 직전에 일어날 일(비밀 대조 뒤 첫 박동이 끼어드는 흉내 · #4829). */
  beforeFailBoot: ((id: number) => void) | null;
  /** 보존 기간 설정을 읽는 것이 던지나(#4828 — DB 가 잠깐 막힘). */
  policyRowError: boolean;
  claims: number;
  /** #5081 배차가 자리 주기에 넘긴 공용 시트 묶음(부를 때마다) · 공용 시트 목록 읽기가 던지나. */
  claimSeats: Array<ReadonlySet<string> | undefined>;
  /** 저장소에 넣으려던 접수(#5081 — 공용 시트 표시를 본다). */
  inserted: NewAgentJob[];
  sharedSeats: Set<string> | "error";
  listening: number;
  /** 다음 부트를 «다른 판이 먼저 물었다» 로 만든다(한 번). */
  bootRace: boolean;
  available: boolean;
  policy: AgentJobPolicy;
  usable: Set<string>;     // `${member}:${app}` — 그 앱을 쓸 수 있다
  inactive: Set<string>;   // 비활성이 된 실행 계정
  projects: Set<string>;   // `${member}:${project}` — 그 프로젝트 폴더에서 셸을 띄울 수 있다
  /** 보존 정리(#4828)가 저장소에 넘긴 보존 일수들. */
  prunedWith: number[];
  /** #5101 API 키 작업의 대화 기록(COLS 밖 칸 — 행 모양에 없다) · 기록 정리가 넘긴 보존 일수들. */
  transcripts: Map<number, { conv: string; gz: Buffer; raw: number }>;
  prunedTranscriptsWith: number[];
  drain(maxMs?: number): Promise<void>;
}
/** 가짜 작업 토큰 해시 — 진짜처럼 64자 16진(작업 토큰 판별이 앞자리로 대조한다). */
const tokHash = (id: number): string => hashJobSecret(`tok-${id}`);

function world(): World {
  const rows = new Map<number, AgentJobRow>();
  const sharedIds = new Set<number>();            // shared_seat 표시(#5081 — COLS 밖 칸이라 행 모양에 없다)
  const requeuedAt = new Map<number, number>();   // 되돌린 시각(SQL 의 updated_at 자리)
  let seq = 0, now = 1_000_000_000_000, hex = 0;
  const w = {} as World;
  const ended = (s: string): boolean => ["done", "failed", "timeout", "canceled"].includes(s);
  const store: AgentJobDeps["store"] = {
    async insertAgentJob(j: NewAgentJob, p) {
      w.inserted.push(j);
      const queued = [...rows.values()].filter((r) => r.status === "queued").length;
      const running = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running").length;
      const room = p.max_queued > 0 ? queued < p.max_queued : running < p.max_running && queued === 0;
      if (!room) return { full: { queued, running } };
      const id = ++seq;
      const row: AgentJobRow = {
        id, status: "queued", requester: j.requester, account_kind: j.accountKind, account_member: j.accountMember, app_id: j.appId,
        project_id: j.projectId, cwd: j.cwd, harness: j.harness, model: j.model, label: j.label, prompt: j.prompt,
        resume_conversation: j.resumeConversation, resume_job_id: j.resumeJobId, timeout_sec: j.timeoutSec, bare: j.bare === true, homeless: j.homeless === true, session_id: null,
        boot_hash: null, fail_hash: null, secret_hash: null, mcp_token_hash: null, conversation_id: null, output_tail: "", result: null, exit_code: null,
        error: null, cancel_requested: false, cancel_reason: null, attempts: 0, created_at: new Date(now), claimed_at: null, started_at: null,
        last_tick_at: null, ended_at: null, reaped: false,
      };
      rows.set(id, row);
      if (j.sharedSeat === true) sharedIds.add(id);
      return { row: { ...row } };
    },
    async agentJobSharedSeat(id) { return sharedIds.has(id); },
    async claimAgentJobs(p, mint, o = {}) {
      w.claims++;
      const gapMs = (o.retryGapSec ?? 0) * 1000;
      const live = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running");
      const queued = [...rows.values()]
        .filter((r) => r.status === "queued" && !r.cancel_requested && (r.attempts === 0 || now - (requeuedAt.get(r.id) ?? 0) >= gapMs))
        .sort((a, b) => a.id - b.id);
      w.claimSeats.push(o.sharedSeats);
      const pick = planClaims(live, queued, p, o.sharedSeats);
      return pick.map((id) => {
        const m = mint(id);
        const r = rows.get(id)!;
        Object.assign(r, { status: "starting", claimed_at: new Date(now), session_id: m.sessionId, boot_hash: m.boot.hash, fail_hash: m.boot.hash, error: null, attempts: r.attempts + 1 });
        return { row: { ...r }, bootSecret: m.boot.secret };
      });
    },
    async getAgentJob(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async getAgentJobAuth(id) { const r = rows.get(id); return r ? { id: r.id, status: r.status, boot_hash: r.boot_hash, fail_hash: r.fail_hash, secret_hash: r.secret_hash, account_kind: r.account_kind } : null; },
    async requeueAgentJob(id, why, maxAttempts) {
      const r = rows.get(id);
      if (!r || r.status !== "starting" || r.cancel_requested || r.attempts >= maxAttempts) return false;
      Object.assign(r, { status: "queued", session_id: null, boot_hash: null, fail_hash: null, claimed_at: null, error: why });
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
      Object.assign(r, { last_tick_at: new Date(now), output_tail: o.tail, conversation_id: o.conversationId ?? r.conversation_id, fail_hash: null });
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
        conversation_id: o.conversationId ?? r.conversation_id, output_tail: o.tail ?? r.output_tail, ended_at: new Date(now), boot_hash: null, fail_hash: null,
        reaped: r.session_id === null && r.mcp_token_hash === null,
      });
      return { ...r };
    },
    //  실 SQL(store.failBootAgentJob)의 조건을 흉내 낸다 — 비밀이 맞고 열린(띄우는 중 · 도는 중) 작업만. 첫 박동이 비밀을 지운다(조건 자체는 store.pg-test 블록 BF).
    async failBootAgentJob(id, failHash, error) {
      w.beforeFailBoot?.(id);
      const r = rows.get(id);
      if (!r || r.fail_hash !== failHash || !(r.status === "starting" || r.status === "running")) return null;
      Object.assign(r, { status: "failed", error, ended_at: new Date(now), boot_hash: null, fail_hash: null, reaped: r.session_id === null && r.mcp_token_hash === null });
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
          const { prompt: _p, output_tail: _o, result, boot_hash: _b, fail_hash: _f, secret_hash: _s, mcp_token_hash: _m, ...rest } = r;
          const text = result && typeof (result as { text?: unknown }).text === "string" ? (result as { text: string }).text : null;
          return { ...rest, result_preview: text ? text.slice(0, 280) : null, has_result: result !== null };
        });
    },
    async queuePosition(id) { return [...rows.values()].filter((r) => r.status === "queued" && r.id < id).length; },
    newJobSecret: () => { const secret = `s${++hex}`; return { secret, hash: hashJobSecret(secret) }; },
    secretMatches,
    //  실 SQL(store.pruneAgentJobs)의 조건을 흉내만 낸다 — 조건 자체는 store.pg-test(블록 P)가 잰다. 여기선 정비가 무엇을 넘기나를 본다.
    async pruneAgentJobs(keepDays, batch = 1000) {
      w.prunedWith.push(keepDays);
      const old = [...rows.values()]
        .filter((r) => ended(r.status) && r.reaped && r.ended_at && now - +r.ended_at > keepDays * 86_400_000)
        .sort((a, b) => +a.ended_at! - +b.ended_at!).slice(0, batch);
      for (const r of old) rows.delete(r.id);
      return old.length;
    },
    async agentJobPolicyRow() {
      if (w.policyRowError) throw new Error("db 가 잠깐 막혔다");
      return { ...w.policy };
    },
    //  #5101 실 SQL(store.setAgentJobTranscript)의 조건을 흉내 낸다 — 도는 API 키 작업만(#5082 o.subscription 이면 구독 작업도) · 한 번만(조건 자체는 store.pg-test 블록 TR).
    async setAgentJobTranscript(id, conv, gz, raw, o) {
      const r = rows.get(id);
      if (!r || r.status !== "running" || (r.account_kind !== "api_key" && o?.subscription !== true) || w.transcripts.has(id)) return false;
      w.transcripts.set(id, { conv, gz, raw });
      return true;
    },
    async agentJobTranscript(id) { const x = w.transcripts.get(id); return x ? { conv: x.conv, gz: x.gz } : null; },
    async agentJobTranscriptConv(id) { return w.transcripts.get(id)?.conv ?? null; },
    async pruneAgentJobTranscripts(days, batch = 1000) {
      w.prunedTranscriptsWith.push(days);
      if (!(days >= 0)) return 0;
      const old = [...rows.values()].filter((r) => w.transcripts.has(r.id) && ended(r.status) && r.ended_at && now - +r.ended_at >= days * 86_400_000).slice(0, batch);
      for (const r of old) w.transcripts.delete(r.id);
      return old.length;
    },
  };
  Object.assign(w, {
    rows, launched: [], killed: [], minted: [], revoked: [], later: [], failLaunch: false, killError: false, revokeError: false,
    mintError: null, onMint: null, beforeFinish: null, beforeFailBoot: null, policyRowError: false, claims: 0, claimSeats: [], inserted: [], sharedSeats: new Set<string>(), listening: 0, bootRace: false, available: true,
    policy: { ...DEFAULT_AGENT_JOB_POLICY }, usable: new Set<string>(), inactive: new Set<string>(), projects: new Set<string>(), prunedWith: [],
    transcripts: new Map(), prunedTranscriptsWith: [],
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
    sharedSeats: async () => { if (w.sharedSeats === "error") throw new Error("설정을 못 읽었다(가짜)"); return w.sharedSeats; },
    jobMcpOnly: async () => false,   // 작업 행의 «MCP 만» 값(필수 의존성) — 기본은 종전 작업. 필요한 시험이 덮어 쓴다.
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

await t("V3b 못 띄우는 배포의 501 은 실행면이 준 문장(무엇을 켜면 되는지)을 그대로 싣는다 · 행을 만들지 않는다(#5082 B7)", async () => {
  const w = world();
  w.available = false; w.usable.add("alice:memo");
  w.deps.unavailableMessage = () => "관리자가 LIVELY_AGENT_JOBS=host 를 켜면 됩니다(가짜)";
  await assert.rejects(submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI), httpErr(501, /LIVELY_AGENT_JOBS=host/));
  assert.equal(w.rows.size, 0);
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

await t("B2h·G1 판이 받는 자리는 실행면이 준다(#5082 D) — 박스 위 판의 작업 폴더(박스 위 경로) · MCP = 그 게이트웨이 /mcp · 판 env 도 같은 게이트웨이 · 워크스페이스 · 행의 작업 폴더는 그대로", async () => {
  const w = world();
  const seenRows: number[] = [];
  const envAt: Array<{ gateway: string; workspace: string | null }> = [];
  w.deps.paneView = async (job) => { seenRows.push(job.id); return { cwd: "/srv/lively/apps/memo", gateway: "http://127.0.0.1:18080", workspace: "acme-1234" }; };
  w.deps.jobEnv = async (_job, at) => { envAt.push(at); return { ANTHROPIC_BASE_URL: `${at.gateway}/api/llm/anthropic` }; };
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  assert.deepEqual(seenRows, [id], "그 작업으로 한 번 묻는다");
  assert.equal(job.cwd, "/srv/lively/apps/memo");
  assert.equal((job.mcp as any).mcpServers.lively.url, "http://127.0.0.1:18080/mcp");
  assert.equal((job.mcp as any).mcpServers.lively.headers["x-lively-workspace"], "acme-1234", "워크스페이스 머리는 그대로");
  assert.deepEqual(envAt, [{ gateway: "http://127.0.0.1:18080", workspace: "acme-1234" }], "판 env 는 판이 보는 게이트웨이 · 워크스페이스로 만든다");
  assert.equal(job.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18080/api/llm/anthropic");
  assert.equal(w.rows.get(id)!.cwd, "/work/apps/memo", "행에는 컨테이너 경로가 남는다(이어받기 · 홈 없는 작업 판정이 그 꼴을 본다)");
});

await t("G1b 실행면이 자리를 안 주면(매니지드 기본) — 판 env 는 종전 루프백 게이트웨이 · 워크스페이스 없이", async () => {
  const w = world();
  const envAt: Array<{ gateway: string; workspace: string | null }> = [];
  w.deps.jobEnv = async (_job, at) => { envAt.push(at); return {}; };
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  assert.deepEqual(envAt, [{ gateway: "http://127.0.0.1:8080", workspace: null }]);
  assert.equal((job.mcp as any).mcpServers.lively.url, "http://127.0.0.1:8080/mcp");
});

await t("J1 #5082 앱 판 지시가 있으면 — 판이 받는 job 에 system · 하네스 인자에 지시 파일 자리표와 작업 폴더 설정 끔(--setting-sources user)", async () => {
  const w = world();
  const asked: number[] = [];
  w.deps.jobSystem = async (job) => { asked.push(job.id); return "정책 표를 조회해 답하라"; };
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  assert.deepEqual(asked, [id], "그 작업으로 한 번 묻는다");
  assert.equal(job.system, "정책 표를 조회해 답하라");
  const at = job.argv.indexOf("--append-system-prompt-file");
  assert.ok(at > 0, JSON.stringify(job.argv));
  assert.equal(job.argv[at + 1], SYSTEM_PROMPT_PLACEHOLDER, "글은 명령줄에 싣지 않고 판이 쓴 파일 경로 자리표만");
  assert.equal(job.argv[job.argv.indexOf("--setting-sources") + 1], "user", "작업 폴더의 CLAUDE.md · .claude/skills · 설정을 읽지 않는다");
  assert.ok(!job.argv.includes("정책 표를 조회해 답하라"));
});

await t("J2 앱 판 지시가 없으면(null · 묻는 자리 없음) — system 칸 · 지시 인자 · 설정 끔 모두 없다(매니지드 · 종전 작업 무회귀)", async () => {
  for (const sys of [undefined, async () => null]) {
    const w = world();
    if (sys) w.deps.jobSystem = sys;
    const { id, boot } = await startedJob(w);
    const job = await onBoot(id, boot, w.deps);
    assert.ok(!("system" in job), "system 칸이 없다");
    assert.ok(!job.argv.includes("--append-system-prompt-file") && !job.argv.includes("--setting-sources"), JSON.stringify(job.argv));
  }
});

await t("J3 앱 판 지시를 못 구하면(던짐) 그 작업은 돌지 않는다 — 실패(사유) · 방금 만든 토큰 폐기 · 410", async () => {
  const w = world();
  w.deps.jobSystem = async () => { throw new Error("작업 'answer' 의 앱 지시 파일(ai/answer.md)을 그 판에서 찾지 못했습니다(가짜)"); };
  const { id, boot } = await startedJob(w);
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(410));
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /실행 환경을 만들지 못했습니다: 작업 'answer' 의 앱 지시 파일/);
  assert.deepEqual(w.revoked, [tokHash(id)], "판에 안 간 토큰은 바로 버린다");
});

await t("B2i 판이 볼 자리를 못 구하면(실행면이 던짐) 그 작업은 돌지 않는다 — 실패(사유) · 방금 만든 토큰 폐기 · 410", async () => {
  const w = world();
  w.deps.paneView = async () => { throw new Error("작업 폴더를 박스 위 자리로 옮길 수 없습니다(가짜)"); };
  const { id, boot } = await startedJob(w);
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(410));
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /실행 환경을 만들지 못했습니다: 작업 폴더를 박스 위 자리로/);
  assert.deepEqual(w.revoked, [tokHash(id)], "판에 안 간 토큰은 바로 버린다");
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

await t("X1b(#5101) 결과 보고의 대화 기록 까닭(transcript_note) — 작업 번호와 함께 경고 로그 · 작업은 그대로 done · 오류 글에 섞이지 않는다", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  const warned: unknown[][] = [];
  const orig = logger.warn;
  (logger as unknown as { warn: (...a: unknown[]) => void }).warn = (...a: unknown[]) => { warned.push(a); };
  try {
    const out = await onResult(id, job.secret, {
      exit_code: 0, conversation_id: "0a1b2c3d-0000-4000-8000-000000000003", result: { text: "답", is_error: false },
      stderr_tail: "", tail: "", transcript_note: "transcript skipped: 압축 9437184 > 8388608\n",
    }, w.deps);
    assert.equal(out.status, "done");
  } finally { (logger as unknown as { warn: typeof orig }).warn = orig; }
  const hit = warned.find((a) => /대화 기록/.test(String(a[1])));
  assert.ok(hit, "경고 로그가 남는다(관측 장치 확인)");
  assert.deepEqual(hit![0], { job: id, note: "transcript skipped: 압축 9437184 > 8388608\n" }, "작업 번호와 그 까닭");
  assert.equal(w.rows.get(id)!.error, null, "끝난 작업의 오류 칸은 그대로 비어 있다");
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
  assert.match(w.rows.get(id)!.error ?? "", /180초 안에 시작하지 못했습니다/);
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
  w.setNow(+w.rows.get(id)!.ended_at! + REAP_DELAY_MS);   // 미룬 걷기는 결과 뒤 REAP_DELAY 에 돈다 — 그 뒤의 감시
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
  assert.equal(canSeeJob(w.rows.get(id)!, { userId: "root", scopes: ["admin"], appId: "memo" } as LivelyUser, false), false, "앱 화면 안의 관리자는 관리자로 안 본다");
  //  #4488 — 초대받은 사람이 보내 내 구독·내 자리로 도는 작업은 그 구독의 주인도 본다(취소도 같은 판정). API 키 작업은 보낸 사람만.
  const invitedJob = { ...w.rows.get(id)!, requester: "bob", account_kind: "subscription", account_member: "alice" } as AgentJobRow;
  assert.equal(canSeeJob(invitedJob, { userId: "alice", scopes: ["context"] } as LivelyUser, false), true, "구독 주인은 본다");
  assert.equal(canSeeJob(invitedJob, { userId: "carol", scopes: ["context"] } as LivelyUser, false), false);
  assert.equal(canSeeJob({ ...invitedJob, account_kind: "api_key", account_member: null } as AgentJobRow, { userId: "alice", scopes: ["context"] } as LivelyUser, false), false, "API 키 작업은 보낸 사람만");
  const list = await listAgentJobsFor({}, human("bob"), w.deps);
  assert.deepEqual(list.jobs, []);
  const listAdmin = await listAgentJobsFor({}, human("root", ["admin"]), w.deps);
  assert.equal((listAdmin.jobs as unknown[]).length, 1);
  assert.equal((listAdmin.jobs as Array<Record<string, unknown>>)[0]!.result_preview, null, "관리자 목록엔 남의 답 앞머리가 없다");
  const adminInApp = await listAgentJobsFor({}, { userId: "root", scopes: ["admin"], appId: "memo" } as LivelyUser, w.deps);
  assert.deepEqual(adminInApp.jobs, [], "앱 화면 안의 관리자는 관리자로 안 본다 — 남의 작업이 목록에 안 뜬다");
});

/** 끝났고 걷은 작업 하나(#4828 보존 정리 시험) — 끝난 때를 지금(가짜 시계 = 접수 시각)에서 며칠 전으로 둔다. */
async function endedJob(w: World, prompt: string, endedAgoDays: number): Promise<number> {
  const r = await w.deps.store.insertAgentJob({
    requester: "alice", accountKind: "subscription", accountMember: "alice", appId: null, projectId: 1, cwd: "/work/shared/project/1",
    harness: "claude", model: null, label: null, prompt, resumeConversation: null, resumeJobId: null, timeoutSec: 900, homeless: false, sharedSeat: false, mcpOnly: false,
  }, { ...w.policy, max_queued: 500 });
  assert.ok("row" in r);
  const row = w.rows.get(r.row.id)!;
  Object.assign(row, { status: "done", reaped: true, ended_at: new Date(+row.created_at - endedAgoDays * 86_400_000) });
  return r.row.id;
}

await t("Z1 보존 정리(#4828) — 정책 보존 일수(기본 90일)를 저장소에 넘겨 지난 기록만 지우고 · 0(무기한)이면 저장소를 부르지도 않는다", async () => {
  const w = world();
  const old = await endedJob(w, "91일 전에 끝남", 91);
  const fresh = await endedJob(w, "10일 전에 끝남", 10);
  assert.deepEqual(await pruneAgentJobRecords(w.deps), { deleted: 1, keep_days: 90, transcripts: 0, transcript_keep_days: 14 });
  assert.deepEqual(w.prunedWith, [90], "기본 보존 일수는 90일(상민 2026-10-19)");
  assert.ok(!w.rows.has(old) && w.rows.has(fresh), "보존 기간이 지난 것만 지운다");
  w.policy = { ...w.policy, keep_days: 0 };
  assert.deepEqual(await pruneAgentJobRecords(w.deps), { deleted: 0, keep_days: 0, transcripts: 0, transcript_keep_days: 14 });
  assert.deepEqual(w.prunedWith, [90], "0(무기한)이면 저장소를 부르지 않는다");
});

await t("Z2 보존 기간 설정을 못 읽으면 지우지 않고 던진다 — 기본값(90일)으로 지우지 않게(0 = 무기한을 지킨다 · 격리 리뷰)", async () => {
  const w = world();
  w.policy = { ...w.policy, keep_days: 0 };
  const old = await endedJob(w, "400일 전에 끝남", 400);
  w.policyRowError = true;
  await assert.rejects(pruneAgentJobRecords(w.deps), /막혔다/);
  assert.deepEqual(w.prunedWith, [], "저장소의 지우기를 부르지 않는다");
  assert.ok(w.rows.has(old));
  w.policyRowError = false;
  assert.deepEqual(await pruneAgentJobRecords(w.deps), { deleted: 0, keep_days: 0, transcripts: 0, transcript_keep_days: 14 }, "읽히면 저장된 0(무기한)을 따른다");
  assert.ok(w.rows.has(old));
});

await t("Z3 꽉 찬 판이 이어지면 한 번의 정비에서 여러 판을 돈다(상한까지) — 밀린 기록을 몇 주에 걸쳐 지우지 않게", async () => {
  const w = world();
  for (let i = 0; i < 7; i++) await endedJob(w, `밀린 ${i}`, 100 + i);
  const fresh = await endedJob(w, "어제 끝남", 1);
  assert.deepEqual(await pruneAgentJobRecords(w.deps, { batch: 2, maxRounds: 3 }), { deleted: 6, keep_days: 90, transcripts: 0, transcript_keep_days: 14 });
  assert.equal(w.prunedWith.length, 3, "꽉 찬 판 셋 — 상한에서 멈춘다");
  assert.deepEqual(await pruneAgentJobRecords(w.deps, { batch: 2, maxRounds: 3 }), { deleted: 1, keep_days: 90, transcripts: 0, transcript_keep_days: 14 });
  assert.equal(w.prunedWith.length, 4, "덜 찬 판이 나오면 멈춘다");
  assert.ok(w.rows.has(fresh), "보존 기간 안의 것은 남는다");
});

await t("F1 시작 실패 보고(#4829) — 띄우는 중인 작업은 그 사유로 곧바로 실패 · 컨테이너를 걷고 다음 작업을 띄운다", async () => {
  const w = world();
  const { id, boot, sid } = await startedJob(w);
  assert.deepEqual(await onBootFailed(id, boot, { stage: "boot", status: 503, message: "게이트웨이 바쁨\n둘째 줄" }, w.deps), { ok: true });
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "작업 컨테이너가 게이트웨이에서 시작 응답을 받지 못했습니다(503): 게이트웨이 바쁨 둘째 줄");
  assert.equal(row.fail_hash, null, "한 번 쓰면 닫힌다");
  await w.drain(0);
  assert.deepEqual(w.killed, [sid], "컨테이너를 곧바로 걷는다");
  await assert.rejects(onBootFailed(id, boot, { stage: "boot", status: 503 }, w.deps), httpErr(401), "끝난 작업엔 다시 못 쓴다(비밀이 지워졌다)");
});

await t("F2 시작을 받고 응답을 못 받은 판(도는 중 · 박동 전)의 401 보고 — «응답이 컨테이너에 닿지 않았다» 로 끝내고 작업 토큰도 걷는다", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  await onBoot(id, boot, w.deps);                       // 게이트웨이는 시작을 받았다(부트 비밀은 지워졌다)
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(401), "응답을 못 받은 판이 다시 물으면 401");
  await onBootFailed(id, boot, { stage: "boot", status: 401, message: "작업 비밀이 맞지 않습니다" }, w.deps);
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /시작 응답을 받지 못했습니다\(게이트웨이는 시작을 받았지만 응답이 컨테이너에 닿지 않았습니다\)/);
  await w.drain(0);
  assert.ok(w.revoked.length >= 1, "도는 중에 만든 작업 AI 토큰을 걷는다");
});

await t("F3 박동이 온 판(살아 있다)은 시작 실패로 못 끝낸다 — 첫 박동이 비밀을 지운다(401) · 대조 뒤 박동이 끼면 409 · 틀린 비밀 · 없는 작업 401", async () => {
  const w = world();
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onTick(id, job.secret, { tail: "도는 중" }, w.deps);
  assert.equal(w.rows.get(id)!.fail_hash, null, "첫 박동이 실패 보고 비밀을 지운다");
  await assert.rejects(onBootFailed(id, boot, { stage: "runner", message: "x" }, w.deps), httpErr(401));
  assert.equal(w.rows.get(id)!.status, "running", "도는 작업은 그대로");
  w.usable.add("bob:memo");
  const other = await startedJob(w, "bob");
  await onBoot(other.id, other.boot, w.deps);
  w.beforeFailBoot = (jid) => { w.rows.get(jid)!.fail_hash = null; w.beforeFailBoot = null; };   // 비밀 대조와 끝내기 사이에 첫 박동이 왔다
  await assert.rejects(onBootFailed(other.id, other.boot, { stage: "boot", status: 401 }, w.deps), httpErr(409));
  assert.equal(w.rows.get(other.id)!.status, "running", "경합에서도 도는 작업은 그대로");
  await assert.rejects(onBootFailed(id, "wrong", {}, w.deps), httpErr(401));
  await assert.rejects(onBootFailed(424242, boot, {}, w.deps), httpErr(401));
  await assert.rejects(onBootFailed(id, job.secret, {}, w.deps), httpErr(401), "콜백 비밀로는 열리지 않는다");
});

await t("F4 일시 실패로 대기열에 되돌린 작업 — 앞 컨테이너의 비밀로는 실패를 알릴 수 없다(다음 자리가 새 비밀을 단다)", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.failLaunch = "transient";
  const out = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  await w.drain(0);
  const id = out.id as number;
  const first = w.launched.find((x) => x.id === id)!.boot;
  assert.equal(w.rows.get(id)!.status, "queued", "일시 실패는 되돌린다");
  await assert.rejects(onBootFailed(id, first, { stage: "boot", status: 0, message: "ECONNREFUSED" }, w.deps), httpErr(401));
  assert.equal(w.rows.get(id)!.status, "queued", "되돌린 작업은 그대로 기다린다");
});

await t("F5 감시는 결과를 받은 지 REAP_DELAY 가 안 된 작업을 걷지 않는다(판이 스스로 빠질 틈) · 지나면 걷는다(#4834 곁가지)", async () => {
  const w = world();
  const { id, boot, sid } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  await onResult(id, job.secret, { exit_code: 0, result: { text: "답", is_error: false } }, w.deps);
  w.later.length = 0;                                   // 결과 보고가 미룬 걷기를 잃었다고 치자(게이트웨이가 내려갔다)
  const t0 = +w.rows.get(id)!.ended_at!;
  w.setNow(t0 + 500);
  await sweepAgentJobs(w.deps);
  assert.deepEqual(w.killed, [], "0.5초 뒤의 감시는 걷지 않는다");
  w.setNow(t0 + REAP_DELAY_MS + 1);
  await sweepAgentJobs(w.deps);
  assert.deepEqual(w.killed, [sid], "틈이 지난 다음 감시가 걷는다");
  assert.equal(w.rows.get(id)!.reaped, true);
});

await t("HL3 홈 없는 작업(#4891) — 접수 표시가 행 · 보기 응답(homeless)에 실린다 · 사람 도구로 보낸 작업은 false", async () => {
  const w = world();
  const row = await enqueueAgentJob({
    requester: "alice", accountKind: "api_key", accountMember: null, appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: null, label: null, prompt: "앱 서버가 보낸 일", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: true, sharedSeat: false, mcpOnly: false,
  }, w.policy, w.deps);
  assert.equal(row.homeless, true);
  assert.equal(publicJob(row, { own: true }).homeless, true);
  w.usable.add("alice:memo");
  const mine = await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), w.deps, UI);
  assert.equal(mine.homeless, false, "사람이 보낸 작업은 사람 자리");
  assert.equal(w.rows.get(mine.id as number)!.homeless, false);
});

await t("SS1 공용 시트(#5081) — 배차가 시트 묶음을 자리 주기에 넘긴다(보낸 사람당 + 시트 전체) · 못 읽으면 빈 묶음 · 사람 도구 접수는 표시 false", async () => {
  const shared = (requester: string): NewAgentJob => ({
    requester, accountKind: "subscription", accountMember: "seat", appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: null, label: null, prompt: `${requester} 의 질문`, resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: true, mcpOnly: false,
  });
  const w = world();
  w.policy = { ...w.policy, max_running: 4, max_running_per_member: 1, max_running_per_service_seat: 2 };
  w.sharedSeats = new Set(["seat"]);
  w.usable.add("seat:crm");   // 가짜 판정은 자리의 구성원으로 본다(진짜 판정 — 보낸 사람의 동의 — 은 service.assertSharedSeatJob · SS3)
  for (const who of ["alice", "bob", "carol"]) await enqueueAgentJob(shared(who), w.policy, w.deps);
  await w.drain(0);
  assert.ok(w.claimSeats.length > 0 && w.claimSeats.every((s) => s?.has("seat")), "배차가 시트 묶음을 넘겼다(관측 장치)");
  assert.deepEqual(w.launched.map((l) => w.rows.get(l.id)!.requester), ["alice", "bob"], "보낸 사람당 1 · 시트 전체 2 — 셋째는 기다린다");
  assert.equal(w.inserted.every((j) => j.sharedSeat === true), true);
  //  공용 시트 목록을 못 읽으면 빈 묶음으로 — 시트 계정 하나로 세는 종전 셈(더 좁다)으로 하나만 띄운다.
  const e = world();
  e.policy = { ...e.policy, max_running: 4, max_running_per_member: 1, max_running_per_service_seat: 2 };
  e.sharedSeats = "error";
  e.usable.add("seat:crm");
  for (const who of ["alice", "bob"]) await enqueueAgentJob(shared(who), e.policy, e.deps);
  await e.drain(0);
  assert.ok(e.claimSeats.length > 0 && e.claimSeats.every((s) => s !== undefined && s.size === 0), "읽기 실패 → 빈 묶음");
  assert.equal(e.launched.length, 1, "시트 계정 하나로 센다");
  //  사람 도구(agent_job_run)로 보낸 작업은 공용 시트 표시를 달지 않는다(본인 구독뿐).
  const h = world();
  h.usable.add("alice:memo");
  await submitAgentJob({ prompt: "일" }, appUser("alice", "memo"), h.deps, UI);
  assert.equal(h.inserted.at(-1)!.sharedSeat, false);
});

await t("SS2 공용 시트(#5081) 작업 보기 — 시트 계정(구독 주인)은 남의 작업을 못 보고 못 끊는다 · 보낸 사람은 본다 · 공용 시트가 아닌 구독 주인은 종전대로", async () => {
  const w = world();
  const r = await w.deps.store.insertAgentJob({
    requester: "alice", accountKind: "subscription", accountMember: "seat", appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: null, label: null, prompt: "앨리스의 질문", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: true, mcpOnly: false,
  }, w.policy);
  assert.ok("row" in r);
  const id = r.row.id;
  await assert.rejects(getAgentJobFor(id, human("seat"), w.deps), httpErr(404), "시트 계정은 공용 시트 작업을 못 본다");
  await assert.rejects(cancelAgentJobFor(id, human("seat"), w.deps), httpErr(404), "시트 계정은 공용 시트 작업을 못 끊는다");
  assert.equal(w.rows.get(id)!.cancel_requested, false);
  assert.equal((await getAgentJobFor(id, human("alice"), w.deps)).prompt, "앨리스의 질문", "보낸 사람은 본다");
  const admin = await getAgentJobFor(id, human("root", ["context", "admin"]), w.deps);
  assert.ok(!("prompt" in admin), "관리자는 상태 · 오류만(종전)");
  assert.equal(canSeeJob(w.rows.get(id)!, human("seat"), true), false);
  assert.equal(canSeeJob(w.rows.get(id)!, human("seat"), false), true, "표시가 없으면 구독 주인 가지(종전 #4488)");
  //  공용 시트가 아닌 구독(초대받은 사람이 주인 세션에서 보냄)은 주인이 여전히 보고 끊는다.
  const inv = await w.deps.store.insertAgentJob({
    requester: "bob", accountKind: "subscription", accountMember: "seat", appId: "crm", projectId: null, cwd: "/work/apps/crm", harness: "claude",
    model: null, label: null, prompt: "밥의 일", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: false, mcpOnly: false,
  }, { ...w.policy, max_queued: 50 });
  assert.ok("row" in inv);
  assert.equal((await getAgentJobFor(inv.row.id, human("seat"), w.deps)).status, "queued", "공용 시트가 아닌 구독 주인은 본다");
  await cancelAgentJobFor(inv.row.id, human("seat"), w.deps);
  assert.equal(w.rows.get(inv.row.id)!.status, "canceled", "공용 시트가 아닌 구독 주인은 끊는다");
});

await t("SS3 공용 시트 재판정(#5081 assertSharedSeatJob) — 시트의 사실은 시트 계정으로 · 보낸 사람의 사실은 보낸 사람으로 · 앱 동의는 보낸 사람의 것", async () => {
  const job = { account_kind: "subscription", account_member: "seat", requester: "alice", app_id: "crm", project_id: null, cwd: "/work/apps/crm" } as const;
  type F = { active: boolean; elevated: boolean };
  const loaders = (o: { consented?: boolean; seat?: F; alice?: F; appOk?: Set<string> } = {}) => {
    const seen = { consented: [] as string[], facts: [] as string[], app: [] as string[] };
    return {
      seen,
      l: {
        seatConsented: async (m: string) => { seen.consented.push(m); return o.consented ?? true; },
        memberFacts: async (m: string) => { seen.facts.push(m); return (m === "seat" ? o.seat : m === "alice" ? o.alice : undefined) ?? { active: true, elevated: false }; },
        assertAppUsable: async (m: string, app: string) => { seen.app.push(`${m}:${app}`); if (o.appOk && !o.appOk.has(m)) throw new HttpError(403, `앱 '${app}' 사용 동의(grant)가 없습니다`); },
      },
    };
  };
  const ok1 = loaders({ appOk: new Set(["alice"]) });
  await assertSharedSeatJob(job, ok1.l);
  assert.deepEqual(ok1.seen.consented, ["seat"], "지정은 시트 계정으로 본다");
  assert.deepEqual(ok1.seen.facts.sort(), ["alice", "seat"]);
  assert.deepEqual(ok1.seen.app, ["alice:crm"], "앱 동의는 보낸 사람의 것(시트 계정의 동의가 아니다)");
  //  시트만 높은 권한 · 보낸 사람은 기본 권한 → 거절(사실을 바꿔 읽으면 통과해 버린다)
  await assert.rejects(assertSharedSeatJob(job, loaders({ seat: { active: true, elevated: true } }).l), httpErr(409, /높은 권한/));
  //  보낸 사람만 비활성 · 시트는 활성 → 거절
  await assert.rejects(assertSharedSeatJob(job, loaders({ alice: { active: false, elevated: false } }).l), httpErr(409, /보낸 사람\(alice\)/));
  //  시트만 비활성 → 거절
  await assert.rejects(assertSharedSeatJob(job, loaders({ seat: { active: false, elevated: false } }).l), httpErr(409, /공용 시트 계정\(seat\)이 활성/));
  //  보낸 사람이 높은 권한이어도 시트가 기본 권한이면 통과(보낸 사람의 권한은 작업 토큰이 따로 좁힌다 — 앱 동의 ∩ 그 사람)
  await assertSharedSeatJob(job, loaders({ alice: { active: true, elevated: true } }).l);
  //  지정이 풀림 → 거절 · 보낸 사람의 앱 동의 없음 → 403 · 그때 시트 계정에 동의가 있어도 소용없다
  await assert.rejects(assertSharedSeatJob(job, loaders({ consented: false }).l), httpErr(409, /지정이 풀렸습니다/));
  await assert.rejects(assertSharedSeatJob(job, loaders({ appOk: new Set(["seat"]) }).l), httpErr(403, /동의/));
  //  모양이 틀리면(프로젝트 폴더) 사실과 무관하게 거절하고 앱 판정까지 가지 않는다
  const shape = loaders();
  await assert.rejects(assertSharedSeatJob({ ...job, project_id: 3, cwd: "/work/shared/project/3" }, shape.l), httpErr(409, /프로젝트 폴더/));
  assert.deepEqual(shape.seen.app, []);
});

// ══ #5101 API 키 작업의 대화 기록 — 첫 말이 돌려준다(B1~B3) · 받기 전 문(G1) · 판이 올린다(T5~T8) · 정리(P1) — 태스크 #5101 · 지식 app-ai-run-resume-asbuilt-5101 ══
//  이게 틀리면: API 키 작업의 이어받기 · 형식 재시도가 «대화 없음» 으로 죽거나, 남의 대화가 되살아나거나, 구독 작업의 기록이 게이트웨이에 쌓이거나,
//  아무나 큰 본문 · 압축 폭탄으로 게이트웨이를 붙잡는다.
const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CONV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** 프로젝트 폴더의 API 키(또는 구독) 작업 하나를 넣고 띄운다 — 앞 작업(resumeJobId)과 그 대화를 이어받을 수도 있다. */
async function keyJob(w: World, o: { account?: "api_key" | "subscription"; resumeJobId?: number | null; resumeConv?: string | null } = {}): Promise<{ id: number; boot: string }> {
  const account = o.account ?? "api_key";
  const row = await enqueueAgentJob({
    requester: "alice", accountKind: account, accountMember: account === "subscription" ? "alice" : null, appId: null, projectId: 1, cwd: "/work/shared/project/1",
    harness: "claude", model: null, label: null, prompt: "일", resumeConversation: o.resumeConv ?? null, resumeJobId: o.resumeJobId ?? null, timeoutSec: 900,
    homeless: false, sharedSeat: false, mcpOnly: false,
  }, w.policy, w.deps);
  await w.drain(0);
  return { id: row.id, boot: w.launched.find((x) => x.id === row.id)!.boot };
}
const gz = (s: string): Buffer => zlibSync.gzipSync(Buffer.from(s, "utf8"));

await t("B1(#5101) 이어받는 API 키 작업 — 첫 말에 앞 작업의 대화 기록(같은 대화) · 올리기 켜짐(상한) · --resume <대화> --fork-session", async () => {
  const w = world();
  const first = await keyJob(w);
  const fj = await onBoot(first.id, first.boot, w.deps);
  assert.equal(fj.transcriptMax, TRANSCRIPT_GZ_MAX, "API 키 작업은 끝에 대화 기록을 올린다");
  assert.equal(fj.transcript, undefined, "새 대화는 되돌릴 기록이 없다");
  assert.ok(!fj.argv.includes("--resume") && !fj.argv.includes("--fork-session"));
  w.transcripts.set(first.id, { conv: CONV_A, gz: gz('{"type":"user"}\n'), raw: 16 });
  await w.deps.store.finishAgentJob(first.id, { status: "done", error: null, conversationId: CONV_A });
  const next = await keyJob(w, { resumeJobId: first.id, resumeConv: CONV_A });
  const nj = await onBoot(next.id, next.boot, w.deps);
  assert.equal(nj.transcript?.conv, CONV_A);
  assert.equal(zlibSync.gunzipSync(Buffer.from(nj.transcript!.gz, "base64")).toString("utf8"), '{"type":"user"}\n', "보관한 그대로");
  assert.equal(nj.transcriptRawMax, TRANSCRIPT_RAW_MAX);
  const i = nj.argv.indexOf("--resume");
  assert.ok(i > 0 && nj.argv[i + 1] === CONV_A && nj.argv[i + 2] === "--fork-session", "앞 대화를 갈라서 잇는다");
  assert.equal(w.rows.get(next.id)!.status, "running");
});

await t("B2(#5101) 이어받는 API 키 작업 — 기록이 없거나 다른 대화의 기록이면 돌리지 않는다(실패로 끝남 · 토큰 회수 · 걷기)", async () => {
  for (const kind of ["없음", "다른 대화"] as const) {
    const w = world();
    const first = await keyJob(w);
    await onBoot(first.id, first.boot, w.deps);
    if (kind === "다른 대화") w.transcripts.set(first.id, { conv: CONV_B, gz: gz("x"), raw: 1 });
    await w.deps.store.finishAgentJob(first.id, { status: "done", error: null, conversationId: CONV_A });
    const next = await keyJob(w, { resumeJobId: first.id, resumeConv: CONV_A });
    await assert.rejects(onBoot(next.id, next.boot, w.deps), httpErr(410), kind);
    const row = w.rows.get(next.id)!;
    assert.equal(row.status, "failed", kind); assert.match(row.error!, /이어받을 대화 기록이 없습니다/, kind);
    assert.ok(w.revoked.includes(tokHash(next.id)), `${kind} — 방금 만든 작업 토큰은 버린다`);
    await w.drain(0);
    assert.ok(w.killed.includes(row.session_id!), `${kind} — 걷는다`);
  }
});

await t("B3(#5101) 구독 작업 — 대화는 그 사람의 홈에 남는다: 올리기 꺼짐 · 되돌리기 없음 · 이어받기는 --fork-session", async () => {
  const w = world();
  const first = await keyJob(w, { account: "subscription" });
  const fj = await onBoot(first.id, first.boot, w.deps);
  assert.equal(fj.transcriptMax, undefined); assert.equal(fj.transcript, undefined);
  await w.deps.store.finishAgentJob(first.id, { status: "done", error: null, conversationId: CONV_A });
  const next = await keyJob(w, { account: "subscription", resumeJobId: first.id, resumeConv: CONV_A });
  const nj = await onBoot(next.id, next.boot, w.deps);
  assert.equal(nj.transcript, undefined, "게이트웨이 기록을 찾지 않는다");
  assert.ok(nj.argv.includes("--fork-session"));
  assert.equal(w.rows.get(next.id)!.status, "running");
});

await t("T5~T8(#5101) 판의 대화 기록 보고 — 비밀 틀림 401 · gzip 아님/대화 id 없음/풀면 상한 초과 400 · 끝난 작업 410 · 구독 작업은 안 적음 · 정상은 적는다(풀린 크기)", async () => {
  const w = world();
  const job = await keyJob(w);
  const b = await onBoot(job.id, job.boot, w.deps);
  const body = gz('{"a":1}\n{"b":2}\n');
  await assert.rejects(onTranscript(job.id, "wrong", body, CONV_A, w.deps), httpErr(401));
  await assert.rejects(onTranscript(job.id, b.secret, Buffer.from("not gzip"), CONV_A, w.deps), httpErr(400, /gzip/));
  await assert.rejects(onTranscript(job.id, b.secret, { a: 1 }, CONV_A, w.deps), httpErr(400, /gzip/), "JSON 으로 읽힌 본문");
  await assert.rejects(onTranscript(job.id, b.secret, body, undefined, w.deps), httpErr(400, /대화 id/));
  await assert.rejects(onTranscript(job.id, b.secret, body, "../../etc/passwd", w.deps), httpErr(400, /대화 id/));
  const bomb = zlibSync.gzipSync(Buffer.alloc(TRANSCRIPT_RAW_MAX + 1, 0x61));
  assert.ok(bomb.length < TRANSCRIPT_GZ_MAX, "압축하면 작다(폭탄)");
  await assert.rejects(onTranscript(job.id, b.secret, bomb, CONV_A, w.deps), httpErr(400, /풀 수 없습니다/));
  await assert.rejects(onTranscript(job.id, b.secret, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(TRANSCRIPT_GZ_MAX)]), CONV_A, w.deps), httpErr(413));
  assert.equal(w.transcripts.size, 0, "거절은 적지 않는다");
  assert.deepEqual(await onTranscript(job.id, b.secret, body, [CONV_A.toUpperCase()], w.deps), { ok: true, stored: true });
  assert.deepEqual(w.transcripts.get(job.id), { conv: CONV_A, gz: body, raw: 16 }, "대화 id(소문자) · 본문 그대로 · 풀린 크기");
  assert.deepEqual(await onTranscript(job.id, b.secret, gz("다른 것"), CONV_A, w.deps), { ok: true, stored: false }, "한 번만 받는다(되풀이해 큰 본문을 다시 쓰게 하지 않는다)");
  assert.deepEqual(w.transcripts.get(job.id)!.gz, body, "처음 것 그대로");
  const sub = await keyJob(w, { account: "subscription" });
  const sb = await onBoot(sub.id, sub.boot, w.deps);
  assert.deepEqual(await onTranscript(sub.id, sb.secret, body, CONV_A, w.deps), { ok: true, stored: false }, "구독 작업은 게이트웨이에 안 둔다");
  await w.deps.store.finishAgentJob(job.id, { status: "done", error: null });
  await assert.rejects(onTranscript(job.id, b.secret, body, CONV_A, w.deps), httpErr(410));
});

await t("B4(#5082) 도커 실행면의 구독 작업 — projects/ 를 작업마다 덮어 대화가 홈에 남지 않는다: 올리기 켜짐 · 이어받으면 보관한 기록을 돌려준다 · 없으면 돌리지 않는다 · 받는 문은 구독 작업도 받는다", async () => {
  const w = world();
  w.deps.subscriptionTranscripts = true;
  const first = await keyJob(w, { account: "subscription" });
  const fj = await onBoot(first.id, first.boot, w.deps);
  assert.equal(fj.transcriptMax, TRANSCRIPT_GZ_MAX, "구독 작업도 끝에 대화 기록을 올린다");
  assert.equal(fj.transcriptRawMax, TRANSCRIPT_RAW_MAX);
  assert.equal(fj.transcript, undefined, "새 대화는 되돌릴 기록이 없다");
  assert.deepEqual(await transcriptGate(first.id, fj.secret, w.deps), { take: true }, "받는 문이 구독 작업도 받는다");
  assert.deepEqual(await onTranscript(first.id, fj.secret, gz('{"type":"user"}\n'), CONV_A, w.deps), { ok: true, stored: true });
  await w.deps.store.finishAgentJob(first.id, { status: "done", error: null, conversationId: CONV_A });
  const next = await keyJob(w, { account: "subscription", resumeJobId: first.id, resumeConv: CONV_A });
  const nj = await onBoot(next.id, next.boot, w.deps);
  assert.equal(nj.transcript?.conv, CONV_A, "형식 재시도 · 앱의 이어받기는 보관한 그 대화를 되돌려 잇는다");
  assert.equal(zlibSync.gunzipSync(Buffer.from(nj.transcript!.gz, "base64")).toString("utf8"), '{"type":"user"}\n');
  const i = nj.argv.indexOf("--resume");
  assert.ok(i > 0 && nj.argv[i + 1] === CONV_A && nj.argv[i + 2] === "--fork-session");
  //  기록이 없으면 — 홈에도 없으니 돌리지 않는다(하네스가 «대화 없음» 으로 죽기 전에 까닭을 남긴다).
  const lone = await keyJob(w, { account: "subscription" });
  await onBoot(lone.id, lone.boot, w.deps);
  await w.deps.store.finishAgentJob(lone.id, { status: "done", error: null, conversationId: CONV_B });
  const orphan = await keyJob(w, { account: "subscription", resumeJobId: lone.id, resumeConv: CONV_B });
  await assert.rejects(onBoot(orphan.id, orphan.boot, w.deps), httpErr(410));
  assert.match(w.rows.get(orphan.id)!.error!, /이어받을 대화 기록이 없습니다/);
  //  끄면 종전 그대로(B3 와 같다) — 받는 문도 구독 작업은 안 받는다.
  w.deps.subscriptionTranscripts = false;
  const off = await keyJob(w, { account: "subscription" });
  const ob = await onBoot(off.id, off.boot, w.deps);
  assert.equal(ob.transcriptMax, undefined);
  assert.deepEqual(await transcriptGate(off.id, ob.secret, w.deps), { take: false });
  assert.deepEqual(await onTranscript(off.id, ob.secret, gz("x"), CONV_A, w.deps), { ok: true, stored: false });
});

await t("V1b(#5082) 사람 도구의 이어받기 — 구독 작업의 기록 자리를 덮는 실행면(도커)이면 게이트웨이가 보관한 그 대화 기록이 있어야 접수한다(없거나 다른 대화면 409 — 띄운 뒤 부트에서야 실패하지 않게) · 끄면 종전대로(대화가 홈에 남는다)", async () => {
  const w = world();
  w.usable.add("alice:memo");
  w.policy = { ...w.policy, max_running: 5, max_running_per_member: 5 };
  w.deps.subscriptionTranscripts = true;
  const a = await submitAgentJob({ prompt: "처음" }, appUser("alice", "memo"), w.deps, UI);
  const id = a.id as number;
  Object.assign(w.rows.get(id)!, { status: "done", conversation_id: CONV_A });
  const before = w.rows.size;
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI), httpErr(409, /이어받을 대화 기록이 없습니다.*transcript_keep_days/));
  w.transcripts.set(id, { conv: CONV_B, gz: gz("x"), raw: 1 });
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI), httpErr(409, /이어받을 대화 기록이 없습니다/));
  assert.equal(w.rows.size, before, "접수하지 않았다(행 없음)");
  w.transcripts.set(id, { conv: CONV_A, gz: gz("x"), raw: 1 });
  const b = await submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI);
  assert.equal(w.rows.get(b.id as number)!.resume_job_id, id);
  w.deps.subscriptionTranscripts = false;
  w.transcripts.delete(id);
  const c = await submitAgentJob({ prompt: "또", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI);
  assert.equal(w.rows.get(c.id as number)!.resume_conversation, CONV_A, "끄면 기록 없이 접수(종전)");
});

await t("P1(#5101) 대화 기록 정리 — transcript_keep_days(기본 14)로 기록만 비운다 · keep_days 0(행 무기한)이어도 돈다 · 0(보관 안 함)이면 끝난 작업의 기록을 다 비운다", async () => {
  const w = world();
  const old = await endedJob(w, "20일 전", 20);
  const fresh = await endedJob(w, "3일 전", 3);
  w.transcripts.set(old, { conv: CONV_A, gz: gz("x"), raw: 1 }); w.transcripts.set(fresh, { conv: CONV_B, gz: gz("y"), raw: 1 });
  w.policy = { ...w.policy, keep_days: 0 };
  assert.deepEqual(await pruneAgentJobRecords(w.deps), { deleted: 0, keep_days: 0, transcripts: 1, transcript_keep_days: 14 });
  assert.deepEqual(w.prunedTranscriptsWith, [14]);
  assert.ok(!w.transcripts.has(old) && w.transcripts.has(fresh), "지난 기록만");
  assert.ok(w.rows.has(old), "행은 남는다");
  w.policy = { ...w.policy, transcript_keep_days: 0 };
  assert.deepEqual(await pruneAgentJobRecords(w.deps), { deleted: 0, keep_days: 0, transcripts: 1, transcript_keep_days: 0 });
  assert.deepEqual(w.prunedTranscriptsWith, [14, 0], "0 은 «보관 안 함» — 남은 기록을 비운다");
  assert.ok(!w.transcripts.has(fresh) && w.rows.has(fresh), "3일 된 기록도 비우고 행은 남긴다");
});

await t("G1(#5101) 대화 기록 받기 전 문 — 비밀 틀림 401 · 끝난 작업 410 · 구독 작업 · 이미 받음 · 보관 꺼짐(0)이면 받지 않음(풀지도 않음) · 첫 말도 올리기를 끈다", async () => {
  const w = world();
  w.policy = { ...w.policy, max_running: 5, max_running_per_member: 5 };   // 한 사람의 작업 셋이 함께 돈다(기본 상한 2)
  const job = await keyJob(w);
  const b = await onBoot(job.id, job.boot, w.deps);
  await assert.rejects(transcriptGate(job.id, "wrong", w.deps), httpErr(401));
  assert.deepEqual(await transcriptGate(job.id, b.secret, w.deps), { take: true });
  const sub = await keyJob(w, { account: "subscription" });
  const sb = await onBoot(sub.id, sub.boot, w.deps);
  assert.deepEqual(await transcriptGate(sub.id, sb.secret, w.deps), { take: false }, "구독 작업");
  w.policy = { ...w.policy, transcript_keep_days: 0 };
  assert.deepEqual(await transcriptGate(job.id, b.secret, w.deps), { take: false }, "보관 꺼짐");
  assert.deepEqual(await onTranscript(job.id, b.secret, gz("x"), CONV_A, w.deps), { ok: true, stored: false });
  assert.equal(w.transcripts.size, 0);
  const off = await keyJob(w);
  assert.equal((await onBoot(off.id, off.boot, w.deps)).transcriptMax, undefined, "보관이 꺼지면 판이 올리지 않는다");
  w.policy = { ...w.policy, transcript_keep_days: 14 };
  await onTranscript(job.id, b.secret, gz("x"), CONV_A, w.deps);
  assert.deepEqual(await transcriptGate(job.id, b.secret, w.deps), { take: false }, "이미 받음");
  await w.deps.store.finishAgentJob(job.id, { status: "done", error: null });
  await assert.rejects(transcriptGate(job.id, b.secret, w.deps), httpErr(410));
});

// ══ 앱 AI 작업의 «라이블리 MCP 만»(매니페스트 ai.mcp_only) — 판이 뜰 때 하네스 인자(사양 S17 · S18 · S20~S23) · 사람이 보내는 작업의 이어받기(S24) ══
//  값은 접수 때 작업 행에 실렸다 — 판이 뜰 때는 그 행의 값(jobMcpOnly)만 읽는다.
//  이게 틀리면: «MCP 만» 작업이 셸 · 파일 · 웹을 연 채 돌거나(값을 못 읽고도 띄움 · 작업 폴더 설정의 명령), 선언하지 않은 작업이 도구를 잃는다.
/** 그 깃발들과 각각 바로 뒤 인자를 뺀 나머지 — «그것 말고는 같다» 를 대조한다. */
const without = (a: string[], ...flags: string[]): string[] =>
  flags.reduce((acc, f) => { const i = acc.indexOf(f); return i < 0 ? acc : [...acc.slice(0, i), ...acc.slice(i + 2)]; }, a);
const count = (a: string[], flag: string): number => a.filter((x) => x === flag).length;

await t("mcp_only S17·S22 «MCP 만» 작업(값 true) — `--tools` 바로 뒤 빈 문자열 · 라이블리 MCP(자리표 · 작업 토큰) 그대로 · 그 밖의 인자는 값 false 인 같은 작업과 같다(S23 설정 출처 말고)", async () => {
  const boot = async (mcpOnly: boolean) => {
    const w = world();
    const asked: number[] = [];
    w.deps.jobMcpOnly = async (job) => { asked.push(job.id); return mcpOnly; };
    const s = await startedJob(w);
    return { w, id: s.id, asked, job: await onBoot(s.id, s.boot, w.deps) };
  };
  const on = await boot(true), off = await boot(false);
  assert.ok(on.asked.length >= 1 && on.asked.every((x) => x === on.id), `그 작업의 값을 읽는다: ${JSON.stringify(on.asked)}`);
  const a = on.job.argv;
  const at = a.indexOf("--tools");
  assert.ok(at > 0, JSON.stringify(a));
  assert.equal(a[at + 1], "", "빈 문자열 인자 하나로 내장 도구를 모두 끈다");
  assert.equal(count(a, "--tools"), 1);
  assert.equal(a[a.indexOf("--mcp-config") + 1], MCP_CONFIG_PLACEHOLDER);
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--settings") + 1], JSON.stringify({ disableAllHooks: true }));
  const lv = (on.job.mcp as any).mcpServers.lively;
  assert.equal(lv.headers.Authorization, `Bearer tok-${on.id}`, "작업 토큰으로 붙는 라이블리 MCP 는 그대로");
  assert.equal(on.w.rows.get(on.id)!.status, "running");
  assert.ok(!off.job.argv.includes("--tools"), `S19 «MCP 만» 이 아니면 없다: ${JSON.stringify(off.job.argv)}`);
  assert.deepEqual(without(a, "--tools", "--setting-sources"), off.job.argv);
});

await t("mcp_only S22 판이 뜰 때 값이 false 면 종전 인자 — `--tools` · `--setting-sources` 없음 · 라이블리 MCP 그대로", async () => {
  const w = world();
  w.deps.jobMcpOnly = async () => false;
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  assert.ok(!job.argv.includes("--tools"), JSON.stringify(job.argv));
  assert.ok(!job.argv.includes("--setting-sources"), `S23 앱 판 지시도 없으면 없다: ${JSON.stringify(job.argv)}`);
  assert.equal(job.argv[job.argv.indexOf("--mcp-config") + 1], MCP_CONFIG_PLACEHOLDER);
  assert.equal(w.rows.get(id)!.status, "running");
});

await t("mcp_only S22·S16 값을 읽는 자리(jobMcpOnly) · 접수 입력의 «MCP 만» 값은 필수 — 빠지면 타입 검사가 잡는다(빠진 배선이 조용히 «도구 열림» 이 되지 않게)", () => {
  const w = world();
  const needsDeps = (_: AgentJobDeps): void => undefined;
  needsDeps(w.deps);
  // @ts-expect-error 작업 행 읽기가 빠졌다
  needsDeps({ ...w.deps, jobMcpOnly: undefined });
  const needsJob = (_: NewAgentJob): void => undefined;
  const job: NewAgentJob = {
    requester: "alice", accountKind: "subscription", accountMember: "alice", appId: "memo", projectId: null, cwd: "/work/apps/memo", harness: "claude",
    model: null, label: null, prompt: "일", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: false, mcpOnly: false,
  };
  needsJob(job);
  // @ts-expect-error 접수 입력에 «MCP 만» 값이 없다
  needsJob({ ...job, mcpOnly: undefined });
});

await t("mcp_only S20 앱 판 지시와 함께 — system · 지시 파일 자리표 · 설정 출처 user(한 번) · `--tools \"\"` · 라이블리 MCP 가 모두 실린다", async () => {
  const w = world();
  w.deps.jobSystem = async () => "정책 표를 조회해 답하라";
  w.deps.jobMcpOnly = async () => true;
  const { id, boot } = await startedJob(w);
  const job = await onBoot(id, boot, w.deps);
  assert.equal(job.system, "정책 표를 조회해 답하라");
  assert.equal(job.argv[job.argv.indexOf("--append-system-prompt-file") + 1], SYSTEM_PROMPT_PLACEHOLDER);
  assert.equal(count(job.argv, "--setting-sources"), 1, JSON.stringify(job.argv));
  assert.equal(job.argv[job.argv.indexOf("--setting-sources") + 1], "user");
  assert.equal(count(job.argv, "--tools"), 1, JSON.stringify(job.argv));
  assert.equal(job.argv[job.argv.indexOf("--tools") + 1], "");
  assert.equal(job.argv[job.argv.indexOf("--mcp-config") + 1], MCP_CONFIG_PLACEHOLDER);
});

await t("mcp_only S23 «MCP 만» 작업은 앱 판 지시가 없어도 `--setting-sources user`(작업 폴더 설정이 명령을 못 돌리게) · 둘 다면 한 번 · 지시만이면 종전대로 · 둘 다 없으면 없다", async () => {
  const argvOf = async (mcpOnly: boolean, system: string | null): Promise<string[]> => {
    const w = world();
    w.deps.jobMcpOnly = async () => mcpOnly;
    if (system !== null) w.deps.jobSystem = async () => system;
    const s = await startedJob(w);
    return (await onBoot(s.id, s.boot, w.deps)).argv;
  };
  for (const [mcpOnly, system, want] of [[true, null, 1], [true, "판 지시", 1], [false, "판 지시", 1], [false, null, 0]] as const) {
    const a = await argvOf(mcpOnly, system);
    const what = `MCP 만 ${mcpOnly} · 지시 ${system !== null}: ${JSON.stringify(a)}`;
    assert.equal(count(a, "--setting-sources"), want, what);
    if (want) assert.equal(a[a.indexOf("--setting-sources") + 1], "user", what);
  }
});

await t("mcp_only S18 단발(bare) 작업 — «MCP 만» 이어도 `--tools` 는 한 번 · MCP 없음 · 그 밖의 인자는 종전 단발과 같다(S23 설정 출처 말고)", async () => {
  const bootArgv = async (mcpOnly: boolean): Promise<string[]> => {
    const w = world();
    w.usable.add("alice:memo");
    w.deps.jobMcpOnly = async () => mcpOnly;
    const row = await enqueueAgentJob({
      requester: "alice", accountKind: "subscription", accountMember: "alice", appId: "memo", projectId: null, cwd: "/work/apps/memo", harness: "claude",
      model: null, label: null, prompt: "요약", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: false, bare: true, mcpOnly,
    }, w.policy, w.deps);
    await w.drain(0);
    return (await onBoot(row.id, w.launched.find((x) => x.id === row.id)!.boot, w.deps)).argv;
  };
  const both = await bootArgv(true), bare = await bootArgv(false);
  assert.equal(count(both, "--tools"), 1, JSON.stringify(both));
  assert.equal(both[both.indexOf("--tools") + 1], "");
  assert.ok(!both.includes("--mcp-config"), "단발은 MCP 없음");
  assert.ok(count(both, "--setting-sources") <= 1, JSON.stringify(both));
  assert.deepEqual(without(both, "--setting-sources"), without(bare, "--setting-sources"));
});

await t("mcp_only S21 판이 뜰 때 «MCP 만» 값을 못 읽으면(던짐) 그 작업은 돌지 않는다 — 실패(사유) · 만든 토큰 폐기 · 410", async () => {
  const w = world();
  w.deps.jobMcpOnly = async () => { throw new Error("작업 행의 «MCP 만» 칸을 읽지 못했습니다(가짜)"); };
  const { id, boot } = await startedJob(w);
  await assert.rejects(onBoot(id, boot, w.deps), httpErr(410));
  const row = w.rows.get(id)!;
  assert.equal(row.status, "failed");
  assert.ok((row.error ?? "").trim().length > 0, "사유가 남는다");
  assert.deepEqual(w.minted.filter((m) => !w.revoked.includes(tokHash(m))), [], "판에 안 간 토큰을 남기지 않는다");
});

// ── S24 사람이 보내는 작업의 이어받기 — 앱 AI 실행이 «MCP 만» 으로 시작한 대화를 이 길로 이어도 도구를 열지 않는다 ──
/** 앱 AI 실행이 넣은 것과 같은 끝난 작업(alice · memo 앱 · 구독) 하나 — 그 행에 «MCP 만» 값을 싣는다. */
async function priorJob(w: World, mcpOnly: boolean): Promise<number> {
  w.usable.add("alice:memo");
  const row = await enqueueAgentJob({
    requester: "alice", accountKind: "subscription", accountMember: "alice", appId: "memo", projectId: null, cwd: "/work/apps/memo", harness: "claude",
    model: null, label: null, prompt: "앱 AI 실행의 질문", resumeConversation: null, resumeJobId: null, timeoutSec: 600, homeless: false, sharedSeat: false, mcpOnly,
  }, w.policy, w.deps);
  Object.assign(w.rows.get(row.id)!, { status: "done", conversation_id: "0a1b2c3d-0000-4000-8000-00000000000a" });
  return row.id;
}
/** 작업 행에 실린 값(가짜) — 넣은 차례가 곧 작업 번호다. 읽은 작업 번호를 적는다. */
function rowMcpOnly(w: World): number[] {
  const read: number[] = [];
  w.deps.jobMcpOnly = async (job) => { read.push(job.id); return w.inserted[job.id - 1]?.mcpOnly === true; };
  return read;
}

await t("mcp_only S24 사람이 보내는 작업의 이어받기 — 앞 작업이 «MCP 만» 이면 새 작업도 · 아니면 false · 이어받기가 아닌 새 작업은 false", async () => {
  for (const prev of [true, false]) {
    const w = world();
    const read = rowMcpOnly(w);
    const id = await priorJob(w, prev);
    const out = await submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI);
    assert.equal(w.rows.get(out.id as number)!.resume_job_id, id, "앞 작업을 잇는다(관측 장치)");
    assert.equal(w.inserted.at(-1)!.mcpOnly, prev, `앞 작업 «MCP 만» ${prev} — 읽은 작업: ${JSON.stringify(read)}`);
  }
  const w = world();
  w.usable.add("alice:memo");
  w.deps.jobMcpOnly = async () => true;   // 무엇을 읽든 «MCP 만» — 그래도 이어받기가 아니면 false
  await submitAgentJob({ prompt: "새 일" }, appUser("alice", "memo"), w.deps, UI);
  assert.equal(w.inserted.at(-1)!.mcpOnly, false, "이어받기가 아닌 새 작업(작업 이름을 다는 앱 AI 실행만 ai.mcp_only 를 쓴다)");
});

await t("mcp_only S24b 사람이 보내는 작업의 이어받기 — 앞 작업의 값을 못 읽으면(던짐) 접수 실패 · 작업을 만들지 않는다", async () => {
  const w = world();
  const id = await priorJob(w, true);
  const rows = w.rows.size;
  w.deps.jobMcpOnly = async () => { throw new Error("작업 행의 «MCP 만» 칸을 읽지 못했습니다(가짜)"); };
  await assert.rejects(submitAgentJob({ prompt: "이어서", resume_job_id: id }, appUser("alice", "memo"), w.deps, UI));
  assert.equal(w.rows.size, rows, "작업 행을 만들지 않았다");
});

console.log(`# ${pass} pass`);

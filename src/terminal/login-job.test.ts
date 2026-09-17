// 로그인 판 작업 수명 (#4067) — 가짜 저장소 · 가짜 op · 가짜 시계로 **부작용**을 본다.
//  (행의 상태 · op 에 나간 요청 · 뒤로 미룬 치우기 · 저장·설치 호출). 문구는 사람이 읽는 것만 본다.
//  행 번호(K…)는 스크래치패드 spec-4067-core.md 의 엣지 표다. 실 SQL 의 같은 규칙은 scripts/login-job-store.itest.mjs 가 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  startLoginJob, loginJobLoginState, loginJobHeadlessState, pasteLoginJob, cancelLoginJob,
  onLoginJobTick, onLoginJobResult, onLoginJobEnd, sweepLoginJobs, staleReason, checkLoginResult, resetLoginJobCaches,
  UI_IDLE_MS, MAX_AGE_MS, UNIT_DEAD_MS, RECENT_MS, REAP_DELAY_MS, PROFILE_CACHE_MS, PROFILE_RETRY_MS, UNSUPPORTED_TTL_MS,
  SCREEN_MAX, STALE_MESSAGE, LOGIN_PROFILE, type LoginJobDeps,
} from "./login-job.js";
import { hashJobSecret, jobSecretMatches, type LoginJobRow } from "./login-job-store.js";
import { loginJobRunScript, REDACTED, LOGIN_JOB_TIMING } from "./login-job-script.js";
import type { TaskOpPart, TaskOpReply } from "../node/sandbox-task.js";
import { HttpError } from "../http-error.js";
import { logger } from "../log.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  resetLoginJobCaches();
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

const T0 = Date.parse("2026-09-17T03:00:00Z");
const ME = "mem-sangmin";
const TOKEN = "sk-ant-oat01-" + "Ab9_-".repeat(20);

type Reply = TaskOpReply | ((h: Record<string, unknown>) => TaskOpReply);
interface World {
  d: LoginJobDeps;
  clock: { t: number };
  rows: Map<number, LoginJobRow>;
  ops: Array<Record<string, unknown>>;
  launches: Array<{ header: Record<string, unknown>; files: TaskOpPart[]; creds: TaskOpPart[] }>;
  later: Array<{ fn: () => Promise<unknown>; ms: number }>;
  stored: Array<Record<string, unknown>>;
  installed: Array<Record<string, unknown>>;
  replies: Record<string, Reply>;
  env: { sandbox: boolean; gw: string | null; slug: string | null; secrets: boolean; installError: string | null;
    storeReply: { ok: true; runner: string } | { ok: false; error: string } };
  /** 그 작업의 판이 받은 일회용 비밀. */
  secretOf(id: number): string;
  /** 미룬 치우기를 지금 돌린다. */
  flush(): Promise<void>;
  opsOf(op: string): Array<Record<string, unknown>>;
  advance(ms: number): void;
}

function world(): World {
  const clock = { t: T0 };
  const rows = new Map<number, LoginJobRow>();
  const ops: World["ops"] = [];
  const launches: World["launches"] = [];
  const later: World["later"] = [];
  const stored: World["stored"] = [];
  const installed: World["installed"] = [];
  let seq = 40;
  let secretSeq = 0;
  const live = (r: LoginJobRow): boolean => r.status === "starting" || r.status === "running";
  const now = (): Date => new Date(clock.t);
  const replies: Record<string, Reply> = {
    hello: { ok: true, v: 1, profiles: ["context", "gateway-job", "login"], max_active: 10 },
    launch: (h) => ({ ok: true, unit: `lvly-task-${String(h.slug)}-${String(h.task_id)}-l1`, state: "active" }),
    stop: { ok: true },
    reap: { ok: true, removed_dir: true },
  };
  const env: World["env"] = {
    sandbox: true, gw: "https://acme-1a2b.app.lvly.io", slug: "acme-1a2b", secrets: true, installError: null,
    storeReply: { ok: true, runner: "filled" },
  };
  const w: World = {
    clock, rows, ops, launches, later, stored, installed, replies, env,
    secretOf: (id) => {
      const l = launches.find((x) => x.header.task_id === id);
      assert.ok(l, `작업 ${id} 의 launch 가 없다`);
      return l.creds.find((c) => c.name === "job")!.data.toString("utf8");
    },
    flush: async () => { for (const x of later.splice(0)) await x.fn(); },
    opsOf: (op) => ops.filter((o) => o.op === op),
    advance: (ms) => { clock.t += ms; },
    d: {
      store: {
        async createLoginJob(o) {
          const id = ++seq;
          const r: LoginJobRow = {
            id, member_id: o.memberId, harness: o.harness, purpose: o.purpose, status: "starting", secret_hash: o.secretHash,
            admin_basis: o.adminBasis, screen: "", exit_code: null, paste: null, error: null, unit: null, reaped: false,
            created_at: now(), updated_at: now(), ui_seen_at: now(), unit_seen_at: null, finished_at: null,
          };
          rows.set(id, r);
          return { ...r };
        },
        async deleteLoginJob(id) { if (rows.get(id)?.status === "starting") rows.delete(id); },
        async getLoginJob(id) { const r = rows.get(id); return r ? { ...r } : null; },
        async latestLoginJob(m, p, h) {
          const r = [...rows.values()].filter((x) => x.member_id === m && x.purpose === p && x.harness === h).sort((a, b) => b.id - a.id)[0];
          return r ? { ...r } : null;
        },
        async markLoginJobRunning(id, unit) {
          //  SQL 과 같은 규칙 — 유닛은 한 번만 적고, starting 이면 running, 이미 끝났으면 «안 치움» 으로 되돌린다.
          const r = rows.get(id);
          if (!r || r.unit) return null;
          Object.assign(r, { unit, updated_at: now() });
          if (r.status === "starting") r.status = "running";
          else if (!live(r)) r.reaped = false;
          return r.status;
        },
        async touchLoginJobUi(id) { const r = rows.get(id); if (r) r.ui_seen_at = now(); },
        async tickLoginJob(id, screen) {
          const r = rows.get(id);
          if (!r || !live(r)) return null;
          const paste = r.paste;
          Object.assign(r, { screen, unit_seen_at: now(), updated_at: now(), paste: null });
          return { paste };
        },
        async setLoginJobPaste(id, enc) {
          const r = rows.get(id);
          if (!r || !live(r)) return false;
          r.paste = enc;
          return true;
        },
        async finishLoginJob(id, status, o = {}) {
          const r = rows.get(id);
          if (!r || !live(r)) return false;
          Object.assign(r, {
            status, error: o.error ?? r.error, exit_code: o.exitCode ?? r.exit_code, screen: o.screen ?? r.screen,
            paste: null, finished_at: now(), updated_at: now(),
          });
          return true;
        },
        async markLoginJobReaped(id) { const r = rows.get(id); if (r) r.reaped = true; },
        async openLoginJobs() { return [...rows.values()].filter((r) => live(r) || !r.reaped).sort((a, b) => a.id - b.id).map((r) => ({ ...r })); },
        newJobSecret: () => { const secret = `job-${++secretSeq}-${"s".repeat(40)}`; return { secret, hash: hashJobSecret(secret) }; },
        jobSecretMatches,
      },
      async op(header, parts) {
        ops.push(header);
        if (header.op === "launch") launches.push({ header, files: parts?.files ?? [], creds: parts?.creds ?? [] });
        const r = replies[String(header.op)];
        if (!r) return { ok: false, code: "bad_op" };
        return typeof r === "function" ? r(header) : r;
      },
      sandboxAvailable: () => env.sandbox,
      gatewayUrl: async () => env.gw,
      tenantSlug: () => env.slug,
      secretsEnabled: () => env.secrets,
      encrypt: (s) => `enc:${Buffer.from(s).toString("base64")}`,
      decrypt: (s) => (s.startsWith("enc:") ? Buffer.from(s.slice(4), "base64").toString("utf8") : null),
      now: () => clock.t,
      nonce: () => "n0nce".repeat(6),
      storeHeadless: async (o) => { stored.push({ ...o }); return env.storeReply; },
      installLogin: async (o) => {
        if (env.installError) throw new Error(env.installError);
        installed.push({ ...o });
      },
      later: (fn, ms) => { later.push({ fn, ms }); },
    },
  };
  return w;
}

const start = (w: World, o: Partial<{ purpose: "login" | "headless"; harness: string; restart: boolean; adminBasis: "none" | "token" | "member" }> = {}) =>
  startLoginJob({ memberId: ME, purpose: o.purpose ?? "login", harness: o.harness ?? "codex", restart: o.restart ?? false, adminBasis: o.adminBasis ?? "none" }, w.d);
const onlyRow = (w: World): LoginJobRow => { assert.equal(w.rows.size, 1, `행이 하나가 아니다: ${w.rows.size}`); return [...w.rows.values()][0]!; };
const loginState = (w: World, h: "codex" | "claude" | "grok" = "codex", loggedIn: boolean | null = false) =>
  loginJobLoginState({ memberId: ME, harness: h, loggedIn: async () => loggedIn }, w.d);
/** 로그 줄을 잡는다 — 자격 값이 로그로 새지 않았나 보려고. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ out: T | undefined; err: unknown; lines: string }> {
  const lines: string[] = [];
  const keep = { info: logger.info, warn: logger.warn, error: logger.error };
  const grab = (...a: unknown[]): void => { lines.push(JSON.stringify(a)); };
  Object.assign(logger, { info: grab, warn: grab, error: grab });
  try {
    try { return { out: await fn(), err: null, lines: lines.join("\n") }; }
    catch (e) { return { out: undefined, err: e, lines: lines.join("\n") }; }
  } finally { Object.assign(logger, keep); }
}

// ── 시작 ─────────────────────────────────────────────────────────────────────

await t("★ K1 시작 — 작업 행 + op launch(login 프로필 · 하네스 · env · run.mjs · 일회용 비밀)", async () => {
  const w = world();
  const r = await start(w, { harness: "codex" });
  assert.equal(r.mode, "job");
  const row = onlyRow(w);
  assert.equal(row.status, "running");
  assert.equal(row.unit, `lvly-task-acme-1a2b-${row.id}-l1`);
  assert.equal(w.launches.length, 1);
  const { header, files, creds } = w.launches[0]!;
  assert.equal(header.profile, LOGIN_PROFILE);
  assert.equal(header.harness, "codex");
  assert.equal(header.slug, "acme-1a2b");
  assert.equal(header.task_id, row.id);
  assert.equal(header.attempt, 1);
  assert.deepEqual(header.limits, { runtime_sec: 1200 });
  assert.deepEqual(header.env, {
    LIVELY_GATEWAY_URL: "https://acme-1a2b.app.lvly.io", LIVELY_LOGIN_JOB: String(row.id), LIVELY_LOGIN_PURPOSE: "login",
    LIVELY_HARNESS: "codex", LVLY_TENANT_SLUG: "acme-1a2b",
  });
  assert.deepEqual(files.map((f) => f.name), ["run.mjs"]);
  assert.equal(files[0]!.data.toString("utf8"), loginJobRunScript(), "판 스크립트는 운영 시간표 그대로");
  assert.deepEqual(creds.map((c) => c.name), ["job"]);
  const secret = creds[0]!.data.toString("utf8");
  assert.ok(secret.length >= 32);
  assert.ok(jobSecretMatches(row, secret), "판의 비밀과 행의 해시가 짝이다");
  assert.notEqual(row.secret_hash, secret, "행에는 원문이 없다");
  assert.ok(!JSON.stringify(header).includes(secret), "비밀은 머리말(env)에 없다 — 자격 본문으로만 간다");
  assert.deepEqual(w.ops.map((o) => o.op), ["hello", "launch"], "세션 자리·그 밖의 op 는 없다");
});

await t("K2 CP 가 login 판을 모른다(hello 에 없음) → 종전 경로 · 행·launch 0", async () => {
  const w = world();
  w.replies.hello = { ok: true, profiles: ["context", "gateway-job"] };
  assert.deepEqual(await start(w), { mode: "legacy" });
  assert.equal(w.rows.size, 0);
  assert.equal(w.opsOf("launch").length, 0);
});

await t("K3 op 소켓이 없다(셀프호스트) → 종전 경로 · op 를 한 번도 안 부른다", async () => {
  const w = world();
  w.env.sandbox = false;
  assert.deepEqual(await start(w), { mode: "legacy" });
  assert.equal(w.ops.length, 0);
  assert.equal(w.rows.size, 0);
});

await t("K3b 판이 모르는 조합(agy · 헤드리스 grok) → 종전 경로 · op 0", async () => {
  const w = world();
  assert.deepEqual(await start(w, { harness: "antigravity" }), { mode: "legacy" });
  assert.deepEqual(await start(w, { purpose: "headless", harness: "grok" }), { mode: "legacy" });
  assert.equal(w.ops.length, 0);
});

await t("★ K4·K35 launch → bad_harness: 행을 지우고 종전 경로 · 그 하네스는 잠시 다시 안 묻는다 · 조회도 종전 경로", async () => {
  const w = world();
  w.replies.launch = { ok: false, code: "bad_harness", error: "x" };
  assert.deepEqual(await start(w, { harness: "grok" }), { mode: "legacy" });
  assert.equal(w.rows.size, 0, "돌지 않은 행은 지운다");
  assert.equal(await loginState(w, "grok"), null, "조회가 종전 화면을 가리지 않는다");
  assert.equal(await pasteLoginJob({ memberId: ME, purpose: "login", harness: "grok", code: "abcd" }, w.d), false);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "grok" }, w.d), false);
  w.replies.launch = (h) => ({ ok: true, unit: `lvly-task-x-${String(h.task_id)}-l1` });
  w.advance(UNSUPPORTED_TTL_MS - 1);
  assert.deepEqual(await start(w, { harness: "grok" }), { mode: "legacy" }, "기억하는 동안은 launch 하지 않는다");
  assert.equal(w.opsOf("launch").length, 1);
  assert.equal((await start(w, { harness: "codex" })).mode, "job", "다른 하네스는 막지 않는다");
  w.advance(1);
  assert.equal((await start(w, { harness: "grok" })).mode, "job", "기억이 풀리면 다시 묻는다");
});

await t("K4b launch → bad_profile: 행을 지우고 종전 경로 · hello 기억을 «모름» 으로", async () => {
  const w = world();
  w.replies.launch = { ok: false, code: "bad_profile" };
  assert.deepEqual(await start(w), { mode: "legacy" });
  assert.equal(w.rows.size, 0);
  assert.deepEqual(await start(w, { harness: "claude" }), { mode: "legacy" });
  assert.equal(w.opsOf("launch").length, 1, "기억하는 동안 다른 하네스도 launch 하지 않는다");
});

await t("★ K5 launch → busy: 사람에게 한 줄(503) · 종전 경로로 안 샌다 · 행은 실패로 남고 조회가 같은 말을 한다", async () => {
  const w = world();
  w.replies.launch = { ok: false, code: "busy", error: "판 10개" };
  await assert.rejects(start(w), httpErr(503, /가득/));
  const row = onlyRow(w);
  assert.equal(row.status, "failed");
  assert.equal(row.reaped, true, "선 적 없는 판은 치울 것이 없다");
  assert.match(row.error ?? "", /가득/);
  const st = await loginState(w);
  assert.equal(st?.step, "failed");
  assert.equal(st?.error, row.error);
});

await t("K5b launch → 시간초과 등: 503(사유 코드) · 종전 경로로 안 샌다", async () => {
  const w = world();
  w.replies.launch = { ok: false, code: "op_timeout" };
  await assert.rejects(start(w), httpErr(503, /op_timeout/));
  assert.equal(onlyRow(w).status, "failed");
});

await t("★ K6 restart 없이 다시 시작 · 살아 있는 작업 → 이어받기(launch 0 · 화면 박동)", async () => {
  const w = world();
  const a = await start(w);
  w.advance(30_000);
  await onLoginJobTick((a as { jobId: number }).jobId, w.secretOf((a as { jobId: number }).jobId), { screen: "x" }, w.d);
  w.advance(10_000);
  const b = await start(w);
  assert.deepEqual(b, { mode: "job", jobId: (a as { jobId: number }).jobId, resumed: true });
  assert.equal(w.opsOf("launch").length, 1);
  assert.equal(onlyRow(w).ui_seen_at.getTime(), w.clock.t, "이어받기도 화면 박동이다");
});

await t("★ K7 restart → 앞 작업 cancelled + op stop + 치우기 예약 · 새 작업 launch", async () => {
  const w = world();
  const a = (await start(w)) as { jobId: number };
  const unitA = w.rows.get(a.jobId)!.unit;
  const b = (await start(w, { restart: true })) as { jobId: number; resumed: boolean };
  assert.notEqual(b.jobId, a.jobId);
  assert.equal(b.resumed, false);
  assert.equal(w.rows.get(a.jobId)!.status, "cancelled");
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [unitA]);
  assert.equal(w.later.length, 1);
  assert.equal(w.later[0]!.ms, REAP_DELAY_MS);
  await w.flush();
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [unitA]);
  assert.equal(w.rows.get(a.jobId)!.reaped, true);
  assert.equal(w.rows.get(b.jobId)!.status, "running");
});

await t("K7b 앞 작업이 이미 죽었다(판 무응답) → 이어받지 않고 expired 로 끝낸 뒤 새로", async () => {
  const w = world();
  const a = (await start(w)) as { jobId: number };
  w.advance(UNIT_DEAD_MS);
  const b = (await start(w)) as { jobId: number; resumed: boolean };
  assert.equal(b.resumed, false);
  assert.equal(w.rows.get(a.jobId)!.status, "expired");
  assert.equal(w.rows.get(a.jobId)!.error, STALE_MESSAGE["unit-dead"]);
  assert.equal(w.opsOf("launch").length, 2);
});

await t("★ K28 hello 불통 — 아는 답은 잠시 더 믿고, 모르면 종전 경로 · PROFILE_RETRY_MS 뒤 다시 묻는다", async () => {
  const w = world();
  assert.equal((await start(w, { harness: "codex" })).mode, "job");
  w.advance(PROFILE_CACHE_MS);
  w.replies.hello = { ok: false, code: "op_unreachable", error: "ECONNREFUSED" };
  assert.equal((await start(w, { harness: "claude" })).mode, "job", "순간 끊김으로 길을 바꾸지 않는다");
  const hellos = w.opsOf("hello").length;
  w.advance(PROFILE_RETRY_MS - 1);
  await start(w, { harness: "grok" });
  assert.equal(w.opsOf("hello").length, hellos, "재시도 간격 전엔 다시 안 묻는다");
  w.advance(1);
  await start(w, { harness: "grok", restart: true });
  assert.equal(w.opsOf("hello").length, hellos + 1);

  resetLoginJobCaches();   // 새 프로세스(아는 답 없음)
  const cold = world();
  cold.replies.hello = { ok: false, code: "op_timeout" };
  assert.deepEqual(await start(cold), { mode: "legacy" }, "아는 답이 없으면 안전한 쪽(종전)");
  assert.equal(cold.rows.size, 0);
  cold.replies.hello = { ok: true, profiles: ["login"] };
  cold.advance(PROFILE_RETRY_MS);
  assert.equal((await start(cold)).mode, "job", "짧게만 기억한다");
});

await t("K28b hello 가 op 오류로 거절(bad_version 등) → 종전 경로 · 한동안 기억", async () => {
  const w = world();
  w.replies.hello = { ok: false, code: "bad_version" };
  assert.deepEqual(await start(w), { mode: "legacy" });
  w.replies.hello = { ok: true, profiles: ["login"] };
  w.advance(PROFILE_CACHE_MS - 1);
  assert.deepEqual(await start(w), { mode: "legacy" });
  w.advance(1);
  assert.equal((await start(w)).mode, "job");
});

await t("★ K30 암호화 키 없음 — 대화형은 종전 경로 · 헤드리스는 400 · 둘 다 행·launch 0", async () => {
  const w = world();
  w.env.secrets = false;
  assert.deepEqual(await start(w, { purpose: "login" }), { mode: "legacy" });
  await assert.rejects(start(w, { purpose: "headless", harness: "claude" }), httpErr(400, /CONNECTOR_SECRET_KEY/));
  assert.equal(w.rows.size, 0);
  assert.equal(w.opsOf("launch").length, 0);
});

await t("★ K31 공개 주소 없음·경로 붙음·슬러그 없음 → 503 · 행·launch 0", async () => {
  for (const [gw, slug] of [[null, "acme"], ["", "acme"], ["https://acme.app.lvly.io/mcp", "acme"], ["ftp://acme", "acme"],
    ["https://acme.app.lvly.io", null]] as Array<[string | null, string | null]>) {
    const w = world();
    w.env.gw = gw;
    w.env.slug = slug;
    await assert.rejects(start(w), httpErr(503), `${gw} · ${slug}`);
    assert.equal(w.rows.size, 0);
    assert.equal(w.opsOf("launch").length, 0);
  }
  const ok = world();
  ok.env.gw = "http://127.0.0.1:8080/";
  assert.equal((await start(ok)).mode, "job", "끝 슬래시·포트는 받는다");
  assert.equal((ok.launches[0]!.header.env as Record<string, string>).LIVELY_GATEWAY_URL, "http://127.0.0.1:8080");
});

await t("K29a 시작이 적은 관리자 근거가 행에 남는다(헤드리스 결과가 쓴다)", async () => {
  const w = world();
  await start(w, { purpose: "headless", harness: "claude", adminBasis: "member" });
  assert.equal(onlyRow(w).admin_basis, "member");
});

// ── 판 콜백 ──────────────────────────────────────────────────────────────────

await t("★ K8·K24 박동 — 틀린 비밀 401 · 없는 작업 404 · 끝난 작업 410 · 빈 해시는 늘 거절 · 행 불변", async () => {
  const w = world();
  const { jobId } = (await start(w)) as { jobId: number };
  const secret = w.secretOf(jobId);
  const before = JSON.stringify(w.rows.get(jobId));
  await assert.rejects(onLoginJobTick(jobId, "nope", { screen: "a" }, w.d), httpErr(401));
  await assert.rejects(onLoginJobTick(jobId, "", { screen: "a" }, w.d), httpErr(401));
  await assert.rejects(onLoginJobTick(jobId + 99, secret, { screen: "a" }, w.d), httpErr(404));
  assert.equal(JSON.stringify(w.rows.get(jobId)), before, "거절은 아무것도 안 바꾼다");
  w.rows.get(jobId)!.secret_hash = "";
  await assert.rejects(onLoginJobTick(jobId, secret, { screen: "a" }, w.d), httpErr(401), "해시 부재를 통과로 접지 않는다");
  w.rows.get(jobId)!.secret_hash = "zz";
  await assert.rejects(onLoginJobTick(jobId, "", {}, w.d), httpErr(401));
  w.rows.get(jobId)!.secret_hash = hashJobSecret(secret);
  await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d);
  await assert.rejects(onLoginJobTick(jobId, secret, { screen: "a" }, w.d), httpErr(410), "K26 — 취소 뒤 판은 410 을 받고 스스로 끝난다");
});

await t("★ K9 박동 — 화면은 가려서(자격 모양) 상한 꼬리만 · 판 박동 시각 · 붙여넣기는 한 번만", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "claude" })) as { jobId: number };
  const secret = w.secretOf(jobId);
  const jwt = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiIxMjM0NTYifQ", "c2lnbmF0dXJlc2lnbmF0dXJl"].join(".");   // 가짜 — 조각으로(비밀 검사기)
  const screen = "x".repeat(SCREEN_MAX) + `\ntoken ${TOKEN} and ${jwt} "refresh_token": "r-123"\nPaste code here if prompted >`;
  w.advance(1_000);
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen }, w.d), { ok: true });
  const row = w.rows.get(jobId)!;
  assert.equal(row.screen.length, SCREEN_MAX);
  assert.ok(!row.screen.includes("sk-ant-") && !row.screen.includes(jwt) && !row.screen.includes("r-123"), "자격 모양은 저장 전에 가린다");
  assert.ok(row.screen.includes(REDACTED));
  assert.ok(row.screen.endsWith("Paste code here if prompted >"), "꼬리를 남긴다");
  assert.equal(row.unit_seen_at?.getTime(), w.clock.t);
  await pasteLoginJob({ memberId: ME, purpose: "login", harness: "claude", code: "  code#state-123  " }, w.d);
  assert.equal(w.rows.get(jobId)!.paste, `enc:${Buffer.from("code#state-123").toString("base64")}`, "코드는 암호문으로만 둔다");
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: "y" }, w.d), { ok: true, paste: "code#state-123" });
  assert.equal(w.rows.get(jobId)!.paste, null, "건네면 지운다");
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: "y" }, w.d), { ok: true }, "두 번 주지 않는다");
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: 42 }, w.d), { ok: true }, "모양 밖 화면은 빈 화면");
  assert.equal(w.rows.get(jobId)!.screen, "");
});

await t("★ K9b·K16 박동 — 화면이 떠났으면(정확히 3분) 멈춤 신호 + expired · 2:59 는 계속", async () => {
  const w = world();
  const { jobId } = (await start(w)) as { jobId: number };
  const secret = w.secretOf(jobId);
  w.advance(UI_IDLE_MS - 1);
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: "a" }, w.d), { ok: true });
  w.advance(1);
  assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: "b" }, w.d), { ok: true, stop: true, why: "ui-idle" });
  const row = w.rows.get(jobId)!;
  assert.equal(row.status, "expired");
  assert.equal(row.error, STALE_MESSAGE["ui-idle"]);
  assert.equal(row.screen, "a", "멈출 판의 화면은 받지 않는다");
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [row.unit]);
});

await t("K9c 박동 — 나이 20분이면 화면·판이 다 살아 있어도 멈춘다 · 멈출 판에 코드를 건네지 않는다", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "claude" })) as { jobId: number };
  const secret = w.secretOf(jobId);
  for (let i = 0; i < 19; i++) {
    w.advance(60_000);
    assert.deepEqual(await onLoginJobTick(jobId, secret, { screen: "s" }, w.d), { ok: true });
    await loginState(w, "claude");   // 화면이 계속 묻는다
  }
  w.advance(60_000 - 1);
  await loginState(w, "claude");
  assert.equal(w.rows.get(jobId)!.status, "running");
  w.advance(1);
  const st = await loginState(w, "claude");
  assert.equal(w.rows.get(jobId)!.status, "expired", "화면 조회가 나이로 끝냈다");
  assert.equal(st?.error, STALE_MESSAGE["max-age"]);
  const w2 = world();
  const j2 = ((await start(w2, { harness: "claude" })) as { jobId: number }).jobId;
  w2.advance(MAX_AGE_MS - 1);
  await pasteLoginJob({ memberId: ME, purpose: "login", harness: "claude", code: "abcd" }, w2.d);
  w2.advance(1);
  const r = await onLoginJobTick(j2, w2.secretOf(j2), { screen: "s" }, w2.d);
  assert.deepEqual(r, { ok: true, stop: true, why: "max-age" });
  assert.equal(w2.rows.get(j2)!.paste, null, "끝나며 코드도 지운다");
});

await t("K36 박동 — 붙여넣기를 못 풀면(키 교체) 코드 없이 ok · 판은 계속", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "claude" })) as { jobId: number };
  w.rows.get(jobId)!.paste = "garbage";
  const { out } = await captureLogs(() => onLoginJobTick(jobId, w.secretOf(jobId), { screen: "s" }, w.d));
  assert.deepEqual(out, { ok: true });
  assert.equal(w.rows.get(jobId)!.status, "running");
});

await t("★ K12 결과(헤드리스 claude) — 그 값 그대로 저장 · 근거 전달 · done · 값은 행·응답·로그 어디에도 없다", async () => {
  const w = world();
  const { jobId } = (await start(w, { purpose: "headless", harness: "claude", adminBasis: "member" })) as { jobId: number };
  const { out, err, lines } = await captureLogs(() => onLoginJobResult(jobId, w.secretOf(jobId), { secret: TOKEN }, w.d));
  assert.equal(err, null);
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(w.stored, [{ memberId: ME, harness: "claude", secret: TOKEN, adminBasis: "member" }], "시작이 적은 근거 그대로");
  const row = w.rows.get(jobId)!;
  assert.equal(row.status, "done");
  assert.ok(!JSON.stringify(row).includes(TOKEN));
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.ok(lines.length > 0, "배선 — 로그를 실제로 잡았다");
  assert.ok(!lines.includes(TOKEN), "로그에 자격이 없다");
  assert.match(lines, /filled/, "실행 멤버 판정은 로그로 남긴다(진단)");
  assert.deepEqual(w.opsOf("reap"), []);
  await w.flush();
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [row.unit], "끝난 판은 조금 뒤 치운다");
  assert.equal(w.rows.get(jobId)!.reaped, true);
  const st = await loginJobHeadlessState({ memberId: ME, harness: "claude" }, w.d);
  assert.equal(st?.stored, true);
  assert.equal(st?.step, "done");
  await assert.rejects(onLoginJobResult(jobId, w.secretOf(jobId), { secret: TOKEN }, w.d), httpErr(410), "K15 — 두 번 받지 않는다");
  assert.equal(w.stored.length, 1);
});

await t("★ K13 결과(대화형 claude) — 허용 자리 파일 + 계정 정보를 멤버 홈에 · done", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "claude" })) as { jobId: number };
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b" } });
  const account = { emailAddress: "s@example.com", organizationUuid: "o-1" };
  const { out, lines } = await captureLogs(() => onLoginJobResult(jobId, w.secretOf(jobId),
    { files: [{ path: ".claude/.credentials.json", content: creds }], account }, w.d));
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(w.installed, [{ memberId: ME, harness: "claude", files: [{ path: ".claude/.credentials.json", content: creds }], account }]);
  assert.equal(w.rows.get(jobId)!.status, "done");
  assert.ok(!lines.includes("accessToken") && !lines.includes('"a"'), "로그에 자격 내용이 없다");
  const st = await loginState(w, "claude", true);
  assert.equal(st?.exited, true);
  assert.equal(st?.exitCode, 0);
  assert.equal(st?.step, "done");
  assert.equal(st?.error, undefined);
});

await t("★ K14 결과 거부 — 400/422 · 아무것도 안 쓴다 · 행은 실패 + 판 멈춤", async () => {
  const cases: Array<[string, "login" | "headless", string, unknown, number, RegExp?]> = [
    ["허용 밖 자리", "login", "codex", { files: [{ path: ".ssh/authorized_keys", content: "{}" }] }, 400, /허용되지 않는 자리: \.ssh\/authorized_keys/],
    ["자리 거슬러 오르기", "login", "codex", { files: [{ path: ".codex/../.bashrc", content: "{}" }] }, 400, /허용되지 않는 자리/],
    ["JSON 아님", "login", "codex", { files: [{ path: ".codex/auth.json", content: "not json" }] }, 400],
    ["JSON 배열", "login", "codex", { files: [{ path: ".codex/auth.json", content: "[1]" }] }, 400],
    ["상한 초과", "login", "codex", { files: [{ path: ".codex/auth.json", content: JSON.stringify({ a: "x".repeat(LOGIN_JOB_TIMING.fileMax) }) }] }, 400],
    ["파일 없음", "login", "grok", { files: [] }, 400],
    ["files 가 배열 아님", "login", "grok", { files: "x" }, 400],
    ["같은 자리 두 번", "login", "codex", { files: [{ path: ".codex/auth.json", content: "{}" }, { path: ".codex/auth.json", content: "{}" }] }, 400],
    ["같은 자리 두 번(그중 하나는 다른 내용)", "login", "grok", { files: [{ path: ".grok/auth.json", content: "{}" }, { path: ".grok/auth.json", content: "{\"x\":1}" }] }, 400],
    ["codex 에 계정 정보", "login", "codex", { files: [{ path: ".codex/auth.json", content: "{}" }], account: { a: 1 } }, 400],
    ["헤드리스 빈 값", "headless", "codex", { secret: "  " }, 400],
    ["헤드리스 값 없음", "headless", "claude", { files: [] }, 400],
    ["헤드리스 상한 초과", "headless", "codex", { secret: "x".repeat(LOGIN_JOB_TIMING.fileMax + 1) }, 400],
  ];
  for (const [name, purpose, harness, body, status, re] of cases) {
    const w = world();
    const { jobId } = (await start(w, { purpose, harness })) as { jobId: number };
    await assert.rejects(onLoginJobResult(jobId, w.secretOf(jobId), body, w.d), httpErr(status, re), name);
    assert.deepEqual(w.installed, [], name);
    assert.deepEqual(w.stored, [], name);
    const row = w.rows.get(jobId)!;
    assert.equal(row.status, "failed", name);
    assert.ok(row.error, name);
    assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [row.unit], name);
  }
  const w = world();
  w.env.storeReply = { ok: false, error: "Claude 장기 토큰 모양이 아니에요." };
  const { jobId } = (await start(w, { purpose: "headless", harness: "claude" })) as { jobId: number };
  await assert.rejects(onLoginJobResult(jobId, w.secretOf(jobId), { secret: "sk-ant-api03-zzz" }, w.d), httpErr(422, /모양이 아니에요/));
  const st = await loginJobHeadlessState({ memberId: ME, harness: "claude" }, w.d);
  assert.equal(st?.step, "failed");
  assert.equal(st?.error, "Claude 장기 토큰 모양이 아니에요.", "저장 거절 사유가 화면까지 간다");
  const w2 = world();
  w2.env.installError = "EACCES /home/box_x/.claude";
  const j2 = ((await start(w2, { harness: "codex" })) as { jobId: number }).jobId;
  await assert.rejects(onLoginJobResult(j2, w2.secretOf(j2), { files: [{ path: ".codex/auth.json", content: "{}" }] }, w2.d), httpErr(500, /EACCES/));
  assert.equal(w2.rows.get(j2)!.status, "failed");
});

await t("checkLoginResult — 하네스별 허용 자리 표", () => {
  assert.equal(checkLoginResult("antigravity", { files: [] }).ok, false);
  const ok = checkLoginResult("grok", { files: [{ path: ".grok/auth.json", content: "{\"k\":1}" }] });
  assert.equal(ok.ok, true);
  assert.equal(checkLoginResult("grok", { files: [{ path: ".codex/auth.json", content: "{}" }] }).ok, false);
  assert.equal(checkLoginResult("claude", { files: [{ path: ".claude/.credentials.json", content: "{}" }], account: [1] }).ok, false);
  assert.equal(checkLoginResult("claude", { files: [{ path: ".claude/.credentials.json", content: "{}" }], account: { x: "y".repeat(17_000) } }).ok, false);
  const acc = checkLoginResult("claude", { files: [{ path: ".claude/.credentials.json", content: "{}" }], account: null });
  assert.deepEqual(acc, { ok: true, files: [{ path: ".claude/.credentials.json", content: "{}" }], account: null });
  assert.equal(checkLoginResult("codex", null).ok, false);
});

await t("★ K19 끝 알림 — CLI 비정상 종료: failed · 사유는 CLI 화면이 말한다 · 가려서 저장", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "codex" })) as { jobId: number };
  const secret = w.secretOf(jobId);
  await onLoginJobTick(jobId, secret, { screen: "Open https://auth.openai.com/codex/device\nABCD-1234\n" }, w.d);
  await onLoginJobEnd(jobId, secret, { reason: "exited", exit_code: 1, screen: `Error: device code expired ${TOKEN}` }, w.d);
  const row = w.rows.get(jobId)!;
  assert.equal(row.status, "failed");
  assert.equal(row.exit_code, 1);
  assert.equal(row.error, null, "CLI 가 끝낸 것은 파서가 말한다");
  assert.ok(!row.screen.includes(TOKEN));
  const st = await loginState(w, "codex");
  assert.equal(st?.step, "failed");
  assert.match(String(st?.error), /^Error: device code expired/);
  assert.equal(st?.exited, true);
  assert.equal(st?.exitCode, 1);
  await w.flush();
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [row.unit]);
});

await t("K19b 끝 알림 — 0 으로 끝났는데 자격 없음(대화형): 우리가 말한다 · 사유 없는 비정상 종료는 기본 문장", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "grok" })) as { jobId: number };
  await onLoginJobTick(jobId, w.secretOf(jobId), { screen: "https://accounts.x.ai/oauth2/device?user_code=CWWP-W2NG\nCWWP-W2NG\n" }, w.d);
  await onLoginJobEnd(jobId, w.secretOf(jobId), { reason: "exited", exit_code: 0 }, w.d);
  const st = await loginState(w, "grok", false);
  assert.equal(st?.step, "failed", "«기다리는 중» 에 두지 않는다");
  assert.match(String(st?.error), /자격 파일이 보이지 않아요/);
  const w2 = world();
  const j2 = ((await start(w2, { harness: "codex" })) as { jobId: number }).jobId;
  await onLoginJobTick(j2, w2.secretOf(j2), { screen: "https://auth.openai.com/codex/device\nABCD-1234\n" }, w2.d);
  await onLoginJobEnd(j2, w2.secretOf(j2), { reason: "exited", exit_code: 2 }, w2.d);
  const st2 = await loginState(w2, "codex");
  assert.equal(st2?.step, "failed");
  assert.equal(st2?.error, "연결 시도가 실패했어요. 다시 시도해 주세요.");
});

await t("K19c 끝 알림 — 판 자체 상한(timeout)은 expired · 띄우기 실패 메시지는 가려서 · 끝난 작업엔 치우기만", async () => {
  const w = world();
  const { jobId } = (await start(w, { purpose: "headless", harness: "codex" })) as { jobId: number };
  await onLoginJobEnd(jobId, w.secretOf(jobId), { reason: "timeout" }, w.d);
  assert.equal(w.rows.get(jobId)!.status, "expired");
  const st = await loginJobHeadlessState({ memberId: ME, harness: "codex" }, w.d);
  assert.equal(st?.step, "failed");
  assert.equal(st?.error, STALE_MESSAGE["max-age"]);
  assert.equal(st?.url, undefined, "끝난 시도의 주소는 안 보인다");
  await onLoginJobEnd(jobId, w.secretOf(jobId), { reason: "exited", exit_code: 3 }, w.d);
  assert.equal(w.rows.get(jobId)!.status, "expired", "먼저 온 끝이 이긴다");
  assert.equal(w.later.length, 2, "그래도 치우기는 예약한다");
  const w2 = world();
  const j2 = ((await start(w2, { harness: "claude", purpose: "headless" })) as { jobId: number }).jobId;
  await onLoginJobEnd(j2, w2.secretOf(j2), { reason: "spawn", message: `로그인 명령을 띄우지 못했습니다 ${TOKEN}` }, w2.d);
  assert.equal(w2.rows.get(j2)!.status, "failed");
  assert.ok(!String(w2.rows.get(j2)!.error).includes(TOKEN));
  await assert.rejects(onLoginJobEnd(j2, "bad", {}, w2.d), httpErr(401));
});

// ── 화면 상태 ─────────────────────────────────────────────────────────────────

await t("★ K10 대화형 상태 — 종전과 같은 모양(주소·코드·붙여넣기·단계) · loggedIn 은 자격 판정이 준다", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "codex" })) as { jobId: number };
  const empty = await loginState(w, "codex", false);
  assert.deepEqual(empty, { loggedIn: false, step: "starting" });
  await onLoginJobTick(jobId, w.secretOf(jobId), { screen: "1. Open https://auth.openai.com/codex/device\n  GTMY-691A5\n" }, w.d);
  assert.deepEqual(await loginState(w, "codex", false),
    { url: "https://auth.openai.com/codex/device", code: "GTMY-691A5", loggedIn: false, step: "open-url" });
  const wc = world();
  const jc = ((await start(wc, { harness: "claude" })) as { jobId: number }).jobId;
  await onLoginJobTick(jc, wc.secretOf(jc), { screen: "visit: https://claude.com/cai/oauth/authorize?x=1\nPaste code here if prompted >" }, wc.d);
  const sc = await loginState(wc, "claude", null);
  assert.equal(sc?.step, "paste-code");
  assert.equal(sc?.needsPaste, true);
  assert.equal(sc?.loggedIn, null, "모름은 모름으로");
  const throwing = await loginJobLoginState({ memberId: ME, harness: "claude", loggedIn: async () => { throw new Error("relay"); } }, wc.d);
  assert.equal(throwing?.loggedIn, null, "자격 판정 실패는 모름");
});

await t("★ K10b 대화형 상태 — 취소·만료는 우리 사유가 이긴다(화면에 주소가 있어도 «기다리는 중» 이 아니다)", async () => {
  const w = world();
  const { jobId } = (await start(w, { harness: "codex" })) as { jobId: number };
  await onLoginJobTick(jobId, w.secretOf(jobId), { screen: "https://auth.openai.com/codex/device\nABCD-EFGH\n" }, w.d);
  await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d);
  const st = await loginState(w, "codex");
  assert.equal(st?.step, "failed");
  assert.equal(st?.error, "연결 시도를 멈췄어요.");
  const w3 = world();
  const j3 = ((await start(w3, { harness: "codex" })) as { jobId: number }).jobId;
  await onLoginJobTick(j3, w3.secretOf(j3), { screen: "https://auth.openai.com/codex/device\nError: rate limited, retrying\n" }, w3.d);
  await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w3.d);
  assert.equal((await loginState(w3, "codex"))?.error, "연결 시도를 멈췄어요.", "화면에 CLI 오류 줄이 있어도 우리가 끝낸 사유가 이긴다");
  const w2 = world();
  await start(w2, { harness: "codex" });
  w2.advance(UNIT_DEAD_MS);
  const st2 = await loginState(w2, "codex");
  assert.equal(st2?.step, "failed", "조회가 죽은 판을 그 자리에서 끝낸다");
  assert.equal(st2?.error, STALE_MESSAGE["unit-dead"]);
  assert.equal(onlyRow(w2).status, "expired");
});

await t("★ K11 헤드리스 상태 — 도는 중은 주소·코드 · done 이면 stored · 화면 조회는 박동이다", async () => {
  const w = world();
  const { jobId } = (await start(w, { purpose: "headless", harness: "codex" })) as { jobId: number };
  await onLoginJobTick(jobId, w.secretOf(jobId), { screen: "https://auth.openai.com/codex/device\nQWER-TYUI\n" }, w.d);
  w.advance(5_000);
  const st = await loginJobHeadlessState({ memberId: ME, harness: "codex" }, w.d);
  assert.equal(st?.url, "https://auth.openai.com/codex/device");
  assert.equal(st?.code, "QWER-TYUI");
  assert.equal(st?.step, "open-url");
  assert.equal(st?.stored, undefined);
  assert.equal(w.rows.get(jobId)!.ui_seen_at.getTime(), w.clock.t);
  assert.equal(await loginJobHeadlessState({ memberId: ME, harness: "claude" }, w.d), null, "다른 하네스는 제 행만 본다");
  assert.equal(await loginState(w, "codex"), null, "대화형과 헤드리스는 다른 시도다");
});

await t("★ K27 최근 작업 없음 → 상태·붙여넣기·취소는 종전 경로 · 경계(정확히 RECENT_MS 전)도 종전", async () => {
  const w = world();
  assert.equal(await loginState(w), null);
  assert.equal(await loginJobHeadlessState({ memberId: ME, harness: "claude" }, w.d), null);
  assert.equal(await pasteLoginJob({ memberId: ME, purpose: "login", harness: "codex", code: "abcd" }, w.d), false);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d), false);
  await start(w);
  await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d);
  w.advance(RECENT_MS - 1);
  assert.notEqual(await loginState(w), null);
  w.advance(1);
  assert.equal(await loginState(w), null);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d), false);
  assert.equal(await loginJobLoginState({ memberId: "someone-else", harness: "codex", loggedIn: async () => false }, w.d), null, "남의 행은 안 본다");
});

// ── 붙여넣기 · 취소 ──────────────────────────────────────────────────────────

await t("★ K25 붙여넣기 — 형식 밖 400 · 끝난 작업 409 · 행 불변 · 성공은 화면 박동", async () => {
  const w = world();
  await start(w, { harness: "claude" });
  const row = onlyRow(w);
  for (const bad of ["", "ab", "has space", "x".repeat(513), "semi;colon", "quote'"]) {
    await assert.rejects(pasteLoginJob({ memberId: ME, purpose: "login", harness: "claude", code: bad }, w.d), httpErr(400), bad);
  }
  assert.equal(row.paste, null);
  w.advance(3_000);
  assert.equal(await pasteLoginJob({ memberId: ME, purpose: "login", harness: "claude", code: "abcd" }, w.d), true);
  assert.equal(row.ui_seen_at.getTime(), w.clock.t);
  await cancelLoginJob({ memberId: ME, purpose: "login", harness: "claude" }, w.d);
  await assert.rejects(pasteLoginJob({ memberId: ME, purpose: "login", harness: "claude", code: "efgh" }, w.d), httpErr(409));
  assert.equal(row.paste, null, "끝난 작업엔 코드를 두지 않는다");
});

await t("★ K26 취소 — cancelled + op stop + 치우기 · 끝난 작업의 취소는 무동작(화면의 끝 정리)", async () => {
  const w = world();
  const { jobId } = (await start(w, { purpose: "headless", harness: "claude" })) as { jobId: number };
  const unit = w.rows.get(jobId)!.unit;
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "headless", harness: "claude" }, w.d), true);
  assert.equal(w.rows.get(jobId)!.status, "cancelled");
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [unit]);
  await w.flush();
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [unit]);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "headless", harness: "claude" }, w.d), true, "종전 경로로 새지 않는다");
  assert.equal(w.opsOf("stop").length, 1, "끝난 작업을 다시 멈추지 않는다");
  const w2 = world();
  const j2 = ((await start(w2, { purpose: "headless", harness: "claude" })) as { jobId: number }).jobId;
  await onLoginJobResult(j2, w2.secretOf(j2), { secret: TOKEN }, w2.d);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "headless", harness: "claude" }, w2.d), true);
  assert.equal(w2.rows.get(j2)!.status, "done", "저장 뒤 화면의 정리 호출이 결과를 뒤집지 않는다");
});

// ── 정리 감시 ────────────────────────────────────────────────────────────────

await t("★ K16·K17 감시 — 화면 무폴링 3분(2:59 유지) · 나이 20분 · 판 무응답 2분 → expired + stop + 치우기", async () => {
  const w = world();
  const a = ((await start(w, { harness: "codex" })) as { jobId: number }).jobId;
  const b = ((await start(w, { harness: "claude" })) as { jobId: number }).jobId;
  const c = ((await start(w, { harness: "grok" })) as { jobId: number }).jobId;
  //  2:59 — 세 판 모두 박동한다. 아무도 멈추지 않는다.
  w.advance(UI_IDLE_MS - 1);
  for (const id of [a, b, c]) await onLoginJobTick(id, w.secretOf(id), { screen: "s" }, w.d);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 0 });
  //  3:00 — a 는 화면이 3분째 안 물었다(판은 살아 있어도). b·c 는 화면이 보고 있다.
  w.advance(1);
  await loginState(w, "claude");
  await loginState(w, "grok");
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 1, reaped: 0 });
  assert.equal(w.rows.get(a)!.status, "expired");
  assert.equal(w.rows.get(a)!.error, STALE_MESSAGE["ui-idle"]);
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [w.rows.get(a)!.unit]);
  //  5:00 — c 의 판은 2:59 뒤로 박동이 없다(화면은 3:00 에 봤다 = 아직 화면 무폴링 아님). b 는 박동한다.
  w.advance(UNIT_DEAD_MS);
  await onLoginJobTick(b, w.secretOf(b), { screen: "s" }, w.d);
  await loginState(w, "claude");
  w.later.length = 0;   // 미룬 치우기를 버린다(재기동) — 감시가 받는지 본다
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 1, reaped: 1 }, "c 는 멈추고, 3:00 에 끝난 a 는 이제 치운다");
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [w.rows.get(a)!.unit]);
  assert.equal(w.rows.get(c)!.status, "expired");
  assert.equal(w.rows.get(c)!.error, STALE_MESSAGE["unit-dead"]);
  assert.equal(w.rows.get(b)!.status, "running");
  //  20:00 — b 는 끝까지 화면·판이 살아 있어도 나이로 멈춘다.
  while (w.clock.t < T0 + MAX_AGE_MS) {
    w.advance(Math.min(60_000, T0 + MAX_AGE_MS - w.clock.t));
    const r = await onLoginJobTick(b, w.secretOf(b), { screen: "s" }, w.d);
    if (w.clock.t < T0 + MAX_AGE_MS) {
      assert.deepEqual(r, { ok: true });
      await loginState(w, "claude");
    } else {
      assert.deepEqual(r, { ok: true, stop: true, why: "max-age" });
    }
  }
  assert.equal(w.rows.get(b)!.status, "expired");
  assert.equal(w.rows.get(b)!.error, STALE_MESSAGE["max-age"]);
  w.later.length = 0;
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 1 }, "5:00 에 끝난 c 는 치우고, 방금 끝난 b 는 기다린다");
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [w.rows.get(a)!.unit, w.rows.get(c)!.unit], "치운 a 는 다시 안 본다");
});

await t("★ K18·K33 감시 — 끝났는데 안 치운 판은 한 번 치운다 · 막 끝난 판은 기다린다 · reap 응답별 표시", async () => {
  const w = world();
  const ids: number[] = [];
  for (const h of ["codex", "claude", "grok"]) ids.push(((await start(w, { harness: h })) as { jobId: number }).jobId);
  const hd = ((await start(w, { purpose: "headless", harness: "codex" })) as { jobId: number }).jobId;
  ids.push(hd);
  for (const id of ids) await onLoginJobEnd(id, w.secretOf(id), { reason: "exited", exit_code: 1 }, w.d);
  w.later.length = 0;                  // 미룬 치우기가 사라졌다(재기동) — 감시가 받아야 한다
  const byUnit = new Map(ids.map((id) => [w.rows.get(id)!.unit!, id]));
  const [u1, u2, u3, u4] = ids.map((id) => w.rows.get(id)!.unit!);
  w.replies.reap = (h) => {
    if (h.unit === u1) return { ok: true, removed_dir: true };
    if (h.unit === u2) return { ok: false, code: "active", state: "deactivating" };
    if (h.unit === u3) return { ok: false, code: "bad_unit" };
    return { ok: false, code: "op_unreachable" };
  };
  w.advance(REAP_DELAY_MS - 1);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 0 }, "막 끝난 판은 스스로 나갈 틈을 준다");
  assert.equal(w.opsOf("reap").length, 0);
  w.advance(1);
  const r = await sweepLoginJobs(w.d);
  assert.deepEqual(r, { expired: 0, reaped: 2 });
  assert.equal(w.rows.get(byUnit.get(u1)!)!.reaped, true, "성공 → 표시");
  assert.equal(w.rows.get(byUnit.get(u2)!)!.reaped, false, "아직 살아 있음 → 표시하지 않는다");
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [u2], "살아 있으면 멈춤을 다시 건다");
  assert.equal(w.rows.get(byUnit.get(u3)!)!.reaped, true, "op 가 모르는 유닛 → 더 붙들지 않는다");
  assert.equal(w.rows.get(byUnit.get(u4)!)!.reaped, false, "불통 → 다음 차례");
  const before = w.opsOf("reap").length;
  w.replies.reap = { ok: true };
  await sweepLoginJobs(w.d);
  assert.deepEqual(w.opsOf("reap").slice(before).map((o) => o.unit).sort(), [u2, u4].sort(), "치운 것은 다시 안 본다");
  await sweepLoginJobs(w.d);
  assert.equal(w.opsOf("reap").length, before + 2, "다 치웠으면 더 부르지 않는다");
});

await t("K18b 감시 — 판 없는 배포에선 아무것도 안 한다 · 유닛 없는 끝난 행은 치울 것 없이 표시", async () => {
  const w = world();
  const { jobId } = (await start(w)) as { jobId: number };
  w.env.sandbox = false;
  w.advance(MAX_AGE_MS);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 0 });
  assert.equal(w.rows.get(jobId)!.status, "running");
  w.env.sandbox = true;
  w.rows.get(jobId)!.unit = null;
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 1, reaped: 0 });
  w.advance(REAP_DELAY_MS);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 1 });
  assert.equal(w.opsOf("reap").length, 0);
});

// ── 시작 도중 끝남 (리뷰 #4067) ─────────────────────────────────────────────────

/** launch 응답을 손으로 풀어 주는 자리 — 판을 띄우는 사이에 다른 요청이 끼어드는 경합을 재현한다. */
function holdLaunch(w: World): { release: () => void; started: Promise<void> } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { markStarted = r; });
  const plain = w.replies.launch as (h: Record<string, unknown>) => TaskOpReply;
  let held = false;
  w.replies.launch = ((h: Record<string, unknown>) => {
    if (held) return plain(h);
    held = true;
    markStarted();
    return gate.then(() => plain(h));
  }) as unknown as Reply;
  return { release, started };
}

await t("★ K37 판을 띄우는 사이 사람이 취소 — 늦게 받은 유닛도 적고 곧바로 멈춘다 · 치우기는 그 유닛으로", async () => {
  const w = world();
  const h = holdLaunch(w);
  const p = start(w, { harness: "codex" });
  await h.started;
  const row = onlyRow(w);
  assert.equal(row.status, "starting");
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d), true);
  assert.equal(row.status, "cancelled");
  assert.deepEqual(w.opsOf("stop"), [], "유닛 이름을 아직 모른다");
  h.release();
  const r = (await p) as { jobId: number };
  assert.equal(r.jobId, row.id);
  const unit = `lvly-task-acme-1a2b-${row.id}-l1`;
  assert.equal(row.unit, unit, "끝난 행에도 유닛 이름을 남긴다");
  assert.equal(row.status, "cancelled", "끝난 상태는 그대로");
  assert.equal(row.reaped, false, "정리 감시가 다시 보게 «안 치움»");
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [unit], "시작한 요청이 곧바로 멈춘다");
  await w.flush();
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [unit, unit], "취소 쪽 치우기도 행을 다시 읽어 그 유닛을 치운다");
  assert.equal(row.reaped, true);
});

await t("★ K37b 판을 띄우는 사이 다시 시작 — 앞 판은 멈추고 새 판은 돈다 · 감시만 남아도 앞 판을 치운다", async () => {
  const w = world();
  const h = holdLaunch(w);
  const pa = start(w, { harness: "claude" });
  await h.started;
  const a = onlyRow(w);
  const b = (await start(w, { harness: "claude", restart: true })) as { jobId: number; resumed: boolean };
  assert.notEqual(b.jobId, a.id);
  assert.equal(a.status, "cancelled");
  h.release();
  await pa;
  const unitA = `lvly-task-acme-1a2b-${a.id}-l1`;
  assert.equal(a.unit, unitA);
  assert.deepEqual(w.opsOf("stop").map((o) => o.unit), [unitA]);
  assert.equal(w.rows.get(b.jobId)!.status, "running");
  w.later.length = 0;   // 미룬 치우기가 사라졌다(재기동) — 감시가 받아야 한다
  w.advance(REAP_DELAY_MS);
  await onLoginJobTick(b.jobId, w.secretOf(b.jobId), { screen: "s" }, w.d);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 1 });
  assert.deepEqual(w.opsOf("reap").map((o) => o.unit), [unitA]);
  assert.equal(a.reaped, true);
});

await t("K37c 유닛 이름은 한 번만 적힌다 — 두 번째 표시는 아무것도 안 바꾸고 멈추지도 않는다", async () => {
  const w = world();
  const { jobId } = (await start(w)) as { jobId: number };
  const unit = w.rows.get(jobId)!.unit;
  assert.equal(await w.d.store.markLoginJobRunning(jobId, "lvly-task-x-9-l1"), null);
  assert.equal(w.rows.get(jobId)!.unit, unit);
  assert.deepEqual(w.opsOf("stop"), []);
});

// ── 판이 없는 배포 · 표가 아직 없는 창 (운영 실측 2026-09-17) ─────────────────────────

/** 저장소 호출을 센다 — «DB 를 안 건드렸나» 를 보려고. */
function countStore(w: World): { calls: string[] } {
  const calls: string[] = [];
  const s = w.d.store as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    const f = s[k];
    if (typeof f !== "function" || k === "newJobSecret" || k === "jobSecretMatches") continue;
    s[k] = (...a: unknown[]) => { calls.push(k); return (f as (...x: unknown[]) => unknown)(...a); };
  }
  return { calls };
}

await t("★ K39 판이 없는 배포(셀프호스트) — 시작·상태·붙여넣기·취소·감시가 작업 행을 **읽지도 않는다**", async () => {
  const w = world();
  w.env.sandbox = false;
  const c = countStore(w);
  assert.deepEqual(await start(w), { mode: "legacy" });
  assert.equal(await loginState(w), null);
  assert.equal(await loginJobHeadlessState({ memberId: ME, harness: "claude" }, w.d), null);
  assert.equal(await pasteLoginJob({ memberId: ME, purpose: "login", harness: "codex", code: "abcd" }, w.d), false);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d), false);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 0 });
  assert.deepEqual(c.calls, [], "종전 로그인의 조회마다 DB 를 치지 않는다");
  assert.equal(w.ops.length, 0);
});

await t("★ K40 작업 표가 아직 없는 창(마이그레이션 전) — 500 이 아니라 종전 경로 · 그 밖의 DB 오류는 그대로 드러난다", async () => {
  const w = world();
  const missing = Object.assign(new Error('relation "org_login_job" does not exist'), { code: "42P01" });
  const st = w.d.store as unknown as Record<string, unknown>;
  for (const k of ["latestLoginJob", "openLoginJobs"]) st[k] = async () => { throw missing; };
  assert.deepEqual(await start(w), { mode: "legacy" });
  assert.equal(w.opsOf("launch").length, 0, "표가 없으면 판을 띄우지 않는다");
  assert.equal(await loginState(w), null);
  assert.equal(await loginJobHeadlessState({ memberId: ME, harness: "codex" }, w.d), null);
  assert.equal(await pasteLoginJob({ memberId: ME, purpose: "login", harness: "codex", code: "abcd" }, w.d), false);
  assert.equal(await cancelLoginJob({ memberId: ME, purpose: "login", harness: "codex" }, w.d), false);
  assert.deepEqual(await sweepLoginJobs(w.d), { expired: 0, reaped: 0 });
  const down = Object.assign(new Error("terminating connection"), { code: "57P01" });
  for (const k of ["latestLoginJob", "openLoginJobs"]) st[k] = async () => { throw down; };
  await assert.rejects(start(w), /terminating connection/, "표가 있는데 DB 가 아픈 것은 숨기지 않는다");
  await assert.rejects(loginState(w), /terminating connection/);
  await assert.rejects(sweepLoginJobs(w.d), /terminating connection/);
});

// ── 순수 판정 ─────────────────────────────────────────────────────────────────

await t("staleReason — 경계는 끝낸다(>=) · 끝난 행은 이유 없음 · 첫 박동 전엔 만든 시각부터", () => {
  const base = { status: "running" as const, created_at: new Date(T0), ui_seen_at: new Date(T0), unit_seen_at: new Date(T0) };
  assert.equal(staleReason(base, T0), null);
  assert.equal(staleReason(base, T0 + UNIT_DEAD_MS - 1), null);
  assert.equal(staleReason(base, T0 + UNIT_DEAD_MS), "unit-dead");
  assert.equal(staleReason({ ...base, unit_seen_at: new Date(T0 + UI_IDLE_MS) }, T0 + UI_IDLE_MS), "ui-idle");
  assert.equal(staleReason({ ...base, ui_seen_at: new Date(T0 + MAX_AGE_MS), unit_seen_at: new Date(T0 + MAX_AGE_MS) }, T0 + MAX_AGE_MS), "max-age");
  assert.equal(staleReason({ ...base, unit_seen_at: null }, T0 + UNIT_DEAD_MS - 1), null);
  assert.equal(staleReason({ ...base, unit_seen_at: null }, T0 + UNIT_DEAD_MS), "unit-dead");
  assert.equal(staleReason({ ...base, status: "starting" }, T0 + MAX_AGE_MS), "max-age");
  for (const s of ["done", "failed", "cancelled", "expired"] as const) assert.equal(staleReason({ ...base, status: s }, T0 + MAX_AGE_MS * 2), null);
  assert.ok(UI_IDLE_MS < MAX_AGE_MS && UNIT_DEAD_MS < UI_IDLE_MS, "판 무응답이 가장 먼저 잡힌다");
  assert.ok(LOGIN_JOB_TIMING.softMaxMs < MAX_AGE_MS, "판이 게이트웨이보다 먼저 스스로 끝난다(끝 알림을 남길 틈)");
  assert.ok(MAX_AGE_MS / 1000 <= 1200, "op 의 RuntimeMaxSec 기본(1200)을 넘지 않는다");
  assert.ok(LOGIN_JOB_TIMING.gatewayDeadMs < UNIT_DEAD_MS, "판이 먼저 포기한다");
});

// ── 배선(소스) — 이 경로의 고장은 오류를 내지 않는다(종전 경로로 조용히 간다) ──────────────────────
await t("★ 배선 — 네 화면 경로 × 두 용도가 판을 **먼저** 묻고, 판이 받으면 세션 자리를 안 만든다", () => {
  const ROUTES = readFileSync(new URL("./routes.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  const handler = (method: string, path: string): string => {
    const at = ROUTES.indexOf(`app.${method}("${path}"`);
    assert.ok(at > 0, `${path} 를 못 찾았다`);
    const next = ROUTES.indexOf("\n  app.", at + 10);
    //  주석은 뺀다 — 설명에 함수 이름이 나오는 것은 호출이 아니다.
    return ROUTES.slice(at, next > 0 ? next : undefined).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  };
  const legacyCalls = /loginSeat\(|startAiLogin|startHeadlessLogin|readAiLogin|readHeadlessLogin|pasteAiLogin|pasteHeadlessLogin|cancelAiLogin|cancelHeadlessLogin|dropLoginSession|touchHarnessSeat|aiLoginCheck/;
  const cases: Array<[string, string, RegExp]> = [
    ["post", "/api/ui/me/ai-login/start", /await loginJobStart\(req, "login", h\)/],
    ["get", "/api/ui/me/ai-login/state", /loginJobLoginState\(/],
    ["post", "/api/ui/me/ai-login/paste", /await loginJobPaste\(req, "login", h, code\)/],
    ["post", "/api/ui/me/ai-login/cancel", /await loginJobCancel\(req, "login", h\)/],
    ["post", "/api/ui/me/headless-login/start", /await loginJobStart\(req, "headless", h\)/],
    ["get", "/api/ui/me/headless-login/state", /loginJobHeadlessState\(/],
    ["post", "/api/ui/me/headless-login/paste", /await loginJobPaste\(req, "headless", h, code\)/],
    ["post", "/api/ui/me/headless-login/cancel", /await loginJobCancel\(req, "headless", h\)/],
  ];
  for (const [m, p, job] of cases) {
    const body = handler(m, p);
    const jobAt = body.search(job);
    assert.ok(jobAt > 0, `${p}: 판을 묻지 않는다`);
    const legacyAt = body.search(legacyCalls);
    assert.ok(legacyAt > jobAt, `${p}: 종전 경로(세션 자리)가 판보다 먼저다`);
    assert.match(body.slice(jobAt, legacyAt), /return;/, `${p}: 판이 받으면 거기서 끝나야 한다`);
  }
  //  판 쪽 조회의 loggedIn 은 파일 판정 — aiLoginCheck(설치 확인)는 배포에 따라 자리를 띄운다.
  const st = handler("get", "/api/ui/me/ai-login/state");
  const jobPart = st.slice(0, st.search(/loginSeat\(/));
  assert.match(jobPart, /aiAccountStatus\(/);
  assert.doesNotMatch(jobPart, /aiLoginCheck/);
  //  콜백 셋은 사용자 인증 없이 열리고(판은 사용자 토큰이 없다), 일회용 비밀을 넘긴다.
  for (const k of ["tick", "result", "end"]) {
    const re = new RegExp(`app\\.post\\("/api/login-jobs/:id/${k}", wrap\\(`);
    assert.match(ROUTES, re, `${k} 콜백이 없거나 사용자 인증이 붙었다`);
  }
  assert.match(ROUTES, /loginJobBearer\(req\)/);
  const SWEEP = readFileSync(new URL("../sessions/outbox-request-sweep.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(SWEEP, /key: "login-job-reap"[^}]*sweepLoginJobs\(\)/s, "정리 감시가 요청 정비표에 없다");
});

console.log(`\n${pass} passed`);
